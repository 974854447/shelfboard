/**
 * Electron 主进程入口。
 *
 * 启动顺序（每一步的顺序都有理由，不要随意调换）：
 *
 * 1. **单实例锁**。拿不到锁就直接退出并唤回已有窗口。否则用户双击两次图标，
 *    会起两个进程抢同一个 SQLite 文件，症状是随机的 `SQLITE_BUSY`。
 * 2. **先建文件日志**，再开数据库。因为数据库打开或迁移失败时，
 *    恰恰最需要日志 —— 而此时数据库正好是不可用的。
 * 3. 解析工作区 → 建目录 → 打开数据库 → **整理老工作区** → 迁移 → **崩溃恢复**。
 *    注意“整理”必须夹在打开与迁移之间：0.1.0 把应用日志写在业务库里，
 *    → 0.1.1 的迁移要删掉那张表，先导出再删才不丢数据。
 * 4. **日志落库与广播**：日志库在 AppData（**不在工作区**），数据库就绪后才把这两个
 *    sink 挂到 logger 上。logger 的 sink 列表是共享状态，所以之前创建的 child logger 也会一并生效。
 * 5. 启动内嵌服务 → 建窗口 → 建托盘。
 *
 * 退出行为：关窗 = 隐藏到托盘；真正退出只有托盘菜单或 IPC 一条路。 */

import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, renameSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';

import { app, dialog, ipcMain, shell, type BrowserWindow } from 'electron';
import {
  createLogBroadcaster,
  createLogStore,
  createLogger,
  DbConnection,
  endWorkSessions,
  newEntityId,
  recoverStaleSessions,
  RotatingFileWriter,
  startWorkSession,
  touchWorkSession,
  WORK_SESSION_HEARTBEAT_MS,
  type LogBroadcaster,
  type LogStore,
  type Logger,
  type ServiceContext,
} from '@pm-studio/server';

import {
  appDataPaths,
  ensureWorkspaceLayout,
  findActiveWorkspace,
  readAppConfig,
  removeObsoleteWorkspaceDirs,
  updateAppConfig,
  upsertWorkspace,
  type AppConfig,
  type WorkspaceRegistryEntry,
} from './app-config';
import { exportLegacyAppLogs } from './legacy-logs';
import { applyEnvironment, ENVIRONMENT_LABEL } from './environment';
import {
  detectEnvironment,
  readEnvironmentCache,
  restartHint,
  writeEnvironmentCache,
} from './env-detect';
import { JOB_HANDLERS } from './job-handlers';
import { beginGithubConnect, disconnectGithub, getGithubStatus } from './github';
import { ALLOWED_EDITOR_COMMANDS, createPathEditorProbe, expandEnvVars, resolveEditorExecutable } from './editor';
import { startEmbeddedServer, type EmbeddedServer } from './server-host';
import { resolveWorkspaceDatabase } from './storage-move';
import { createTrayController, trayTooltip, type TrayController } from './tray';
import { createMainWindow, focusWindow } from './window';

/** 开发环境下由 electron-vite 注入 Vite dev server 地址，用于热更新 */
const DEVELOPMENT_RENDERER_URL = process.env.ELECTRON_RENDERER_URL;
/** 文本日志的定时落盘间隔：低流量时不让日志长时间停留在内存里 */
const FILE_FLUSH_INTERVAL_MS = 2000;

/**
 * 运行环境在**模块加载阶段**就定下来了。
 *
 * 位置很关键，有两个不能挪的理由：
 * 1. 必须在 `requestSingleInstanceLock()`（本文件最后一段）之前 —— 单实例锁按 userData
 *    目录分，先拿锁再换目录的话，锁会落在旧目录上，开发版与正式版又会互相唤醒。
 * 2. 必须在任何 `app.getPath('userData')` 的读取之前（bootstrap 里第一件事就是读它）。 */
const environment = applyEnvironment();

/**
 * 应用启动时刻。
 *
 * 环境检测要它来判断“用户是不是在这次启动之后改过环境变量” ——
 * Windows 下已运行的进程读不到新的 PATH，那种情况下“重新检测”必然失败。
 * 必须提示重启，否则用户会以为软件坏了。 */
const appStartedAt = Date.now();

interface Runtime {
  config: AppConfig;
  workspace: WorkspaceRegistryEntry;
  logger: Logger;
  conn: DbConnection;
  /** 应用日志库（在 AppData，不在工作区）；退出时要关，否则会留下 -wal */
  appLogsDb: DbConnection;
  logStore: LogStore;
  broadcaster: LogBroadcaster;
  fileSink: RotatingFileWriter;
  server: EmbeddedServer;
  window: BrowserWindow | null;
  tray: TrayController | null;
  timers: NodeJS.Timeout[];
  /** 是否已进入退出流程；为 true 时窗口关闭不再被拦截 */
  quitting: boolean;
}

let runtime: Runtime | null = null;

/* ------------------------------------------------------------------ */
/* 工作区                                                             */
/* ------------------------------------------------------------------ */

/**
 * 首次运行时创建默认工作区。
 *
 * M1 的取舍：不做“首次设置向导”，直接在工作区目录下建一个默认工作区。
 * 让应用零配置即可跑通完整流程。完整的创建工作区切换/迁移属于 M5。 */
function createDefaultWorkspace(userDataDir: string, logger: Logger): WorkspaceRegistryEntry {
  const root = join(userDataDir, 'workspace');
  const now = Date.now();
  const entry: WorkspaceRegistryEntry = {
    id: newEntityId(now),
    name: '默认工作区',
    path: root,
    createdAt: now,
    lastOpenedAt: now,
  };
  logger.info('未发现已注册的工作区，已创建默认工作区', { path: root });
  return entry;
}

function touchWorkspace(userDataDir: string, workspace: WorkspaceRegistryEntry): AppConfig {
  const entry: WorkspaceRegistryEntry = { ...workspace, lastOpenedAt: Date.now() };
  const { config } = updateAppConfig(userDataDir, (current) =>
    upsertWorkspace({ ...current, activeWorkspaceId: entry.id }, entry),
  );
  return config;
}

/* ------------------------------------------------------------------ */
/* 崩溃恢复                                                            */
/* ------------------------------------------------------------------ */

/**
 * 把上次残留的 `queued` / `running` 作业标记为 `interrupted`。
 *
 * 断电或强杀之后，作业状态会停在“运行中”，界面上会一直转圈。
 * 启动时统一收尾，用户才知道“那次没跑完”。 */
function recoverInterruptedJobs(conn: DbConnection, logger: Logger): number {
  const result = conn.sqlite
    .prepare(
      `UPDATE jobs SET status = 'interrupted', finished_at = ?
       WHERE status IN ('queued', 'running')`,
    )
    .run(Date.now());

  const count = Number(result.changes ?? 0);
  if (count > 0) {
    logger.warn('检测到上次未正常结束的作业，已标记为 interrupted', { count });
  }
  return count;
}

function countRunningJobs(conn: DbConnection): number {
  const row = conn.sqlite
    .prepare(`SELECT COUNT(*) AS c FROM jobs WHERE status = 'running'`)
    .get() as { c: number } | undefined;
  return Number(row?.c ?? 0);
}

/* ------------------------------------------------------------------ */
/* IPC                                                                 */
/* ------------------------------------------------------------------ */

function registerIpcHandlers(): void {
  ipcMain.handle('app:bootstrap', () => {
    const rt = runtime;
    if (!rt) throw new Error('应用尚未就绪');
    return {
      baseUrl: rt.server.baseUrl,
      token: rt.server.token,
      platform: process.platform,
      version: app.getVersion(),
      workspaceRoot: rt.workspace.path,
      theme: rt.config.preferences.theme,
      // 界面上要显示当前在哪个环境，否则“我看到的是哪份数据”全靠记忆
      environment: environment.env,
      environmentLabel: ENVIRONMENT_LABEL[environment.env],
      userDataDir: environment.effectiveUserDataDir,
      // 设置页的“编辑器”下拉要用：白名单只在主进程定义一份（editor.ts），
      // 渲染层不重复写一遍，将来加编辑器不会两边不同步。
      editorCommands: [...ALLOWED_EDITOR_COMMANDS],
    };
  });

  ipcMain.handle('window:hide', () => {
    runtime?.window?.hide();
  });

  ipcMain.handle('workspace:reveal', async () => {
    const rt = runtime;
    if (!rt) return;
    await shell.openPath(rt.workspace.path);
  });

  /**
   * 打开应用数据目录（`<userData>`）。
   *
   * 设置页要显示“数据在哪”，顺带就得能打开它 —— 用户想备份、想看看测试环境与正式环境
   * 到底差在哪，都得自己去翻目录。路径由主进程给（渲染层不拼路径），
   * 而且它就是 `app.getPath('userData')`，不存在越界问题。
   */
  ipcMain.handle('app:reveal-userdata', async () => {
    await shell.openPath(app.getPath('userData'));
  });

  /**
   * 打开某个**项目自己的文件夹**。
   *
   * 只接受项目 id，路径由主进程从数据库里查 `folder` 再拼出来 ——
   * 渲染进程递过来的路径一概不采信（否则就是一个“任意目录打开”的口子）。
   * 拼完还会再确认结果落在工作区内（纵深防御：万一将来 folder 字段被污染）。
   */
  ipcMain.handle('project:reveal', async (_event, projectId: unknown) => {
    const rt = runtime;
    if (!rt) throw new Error('应用尚未就绪');
    if (typeof projectId !== 'string' || projectId.length === 0) {
      throw new Error('项目 id 不合法');
    }

    const row = rt.conn.sqlite
      .prepare('SELECT folder FROM projects WHERE id = ?')
      .get(projectId) as { folder: string | null } | undefined;

    if (!row?.folder) {
      throw new Error('这个项目还没有文件夹（可能是 0.1.1 之前建的，重启应用会补建）');
    }

    const root = resolve(rt.workspace.path);
    const target = resolve(join(root, row.folder));
    if (target !== root && !target.startsWith(root + sep)) {
      throw new Error('项目文件夹不在工作区内，已拒绝打开');
    }

    const failure = await shell.openPath(target);
    if (failure) throw new Error(`打开文件夹失败：${failure}`);
  });

  /**
   * 用编辑器打开项目。
   *
   * 目录同样由主进程查库决定：优先 `code_path`（用户自己指定的代码目录，可以不在工作区内），
   * 否则用工作区里的项目文件夹。编辑器命令走白名单解析出 .exe 绝对路径。
   * `shell: false` 启动 —— 不拼字符串、不走 shell。
   */
  ipcMain.handle('project:editor', async (_event, projectId: unknown) => {
    const rt = runtime;
    if (!rt) throw new Error('应用尚未就绪');
    if (typeof projectId !== 'string' || projectId.length === 0) {
      throw new Error('项目 id 不合法');
    }

    const row = rt.conn.sqlite
      .prepare('SELECT folder, code_path FROM projects WHERE id = ?')
      .get(projectId) as { folder: string | null; code_path: string | null } | undefined;
    if (!row) throw new Error('项目不存在');

    const target = row.code_path ?? (row.folder ? join(rt.workspace.path, row.folder) : null);
    if (!target) throw new Error('这个项目还没有文件夹，重启应用会自动补建');

    const resolution = resolveEditorExecutable(
      rt.config.preferences.editorCommand,
      createPathEditorProbe(),
      { expand: (template) => expandEnvVars(template) },
    );
    if (!resolution.ok) throw new Error(resolution.reason);

    const child = spawn(resolution.exe, [target], {
      // shell: false（默认）—— 参数以数组形式传给可执行文件，不经过命令行解析
      detached: true,
      stdio: 'ignore',
      windowsHide: false,
    });
    child.unref();

    rt.logger.info('已在编辑器中打开项目', {
      projectId,
      editor: resolution.exe,
      target,
    });
  });

  /**
   * 让用户挑一个目录（设置页「更改工作区目录」用）。
   *
   * 选目录必须走系统对话框：渲染层没有文件系统权限，也不该拿一个手输的路径去建目录。
   * 返回 null 表示用户取消 —— 调用方要区分“取消”和“失败”。
   */
  ipcMain.handle('workspace:choose-dir', async () => {
    const rt = runtime;
    if (!rt) throw new Error('应用尚未就绪');

    const options: Electron.OpenDialogOptions = {
      title: '选择工作区目录',
      // createDirectory：允许在对话框里直接新建一个文件夹（用户常常想“新建一个放项目”）
      properties: ['openDirectory', 'createDirectory'],
      defaultPath: rt.workspace.path,
      buttonLabel: '用这个目录',
    };
    // 有窗口时挂成模态，避免对话框跑到窗口后面（Windows 上很常见）
    const result = rt.window
      ? await dialog.showOpenDialog(rt.window, options)
      : await dialog.showOpenDialog(options);
    if (result.canceled || result.filePaths.length === 0) return null;
    return result.filePaths[0];
  });

  /**
   * 选工作日志（Word）的保存目录。
   *
   * 与“切换工作区”完全不同的一件事：这里**不搬任何文件**，只是记下以后往哪儿写。
   * 所以选一个还不存在的目录也完全可以 —— 生成时会自动建出来。
   */
  ipcMain.handle('worklog:choose-dir', async () => {
    const rt = runtime;
    if (!rt) throw new Error('应用尚未就绪');

    const current = resolveWorkLogDir(rt.config, app.getPath('documents'));
    const options: Electron.OpenDialogOptions = {
      title: '选择工作日志保存位置',
      properties: ['openDirectory', 'createDirectory'],
      defaultPath: existsSync(current) ? current : dirname(current),
      buttonLabel: '用这个目录',
    };
    const result = rt.window
      ? await dialog.showOpenDialog(rt.window, options)
      : await dialog.showOpenDialog(options);
    if (result.canceled || result.filePaths.length === 0) return null;
    return result.filePaths[0];
  });

  /** 在资源管理器里定位一个文件（生成完工作日志之后“打开文档所在文件夹”用） */
  ipcMain.handle('shell:show-item', (_event, rawPath: unknown) => {
    if (typeof rawPath !== 'string' || rawPath.trim() === '') throw new Error('路径不合法');
    shell.showItemInFolder(resolve(rawPath.trim()));
    return true;
  });

  /** 用系统默认程序打开一个文件（生成完工作日志之后“直接用 Word 打开”用） */
  ipcMain.handle('shell:open-path', async (_event, rawPath: unknown) => {
    if (typeof rawPath !== 'string' || rawPath.trim() === '') throw new Error('路径不合法');
    const message = await shell.openPath(resolve(rawPath.trim()));
    // shell.openPath 用**返回字符串**表示失败（空串才是成功），不抛异常
    if (message !== '') throw new Error(message);
    return true;
  });

  /**
   * 切换工作区目录。
   *
   * 工作区目录**只放项目文件夹**（数据库在 data 下、与它平级，见 app-config.ts），
   * 所以“换目录”这件事本身不搬数据库，只搬项目文件夹 —— 这也让整个操作可回退：
   * 搬过去的是文件夹，失败了就地报错，什么都不删。
   *
   * 刻意做的几件事：
   * 1. **校验**：不能等于当前目录；不能落在 data/logs 里（那会把项目跟数据库混在一起）。
   * 2. **搬旧项目是可选动作**（`moveProjects`）：用户可以选择“先切过去、旧的自己处理”。
   *    搬家走 `rename`（同盘是瞬时的），**跨盘会失败** —— 那时如实报错并让用户手动拷，
   *    不做“复制 + 删除”的两步操作（那才是真正可能丢数据的操作，留给 M5 的迁移功能）。
   * 3. **目标已存在同名文件夹就跳过并告警**，绝不覆盖用户已有的东西。
   * 4. 只有一个工作区条目，**原地改它的 path**（而不是新建一条）：这样 activeWorkspaceId
   *    不变，应用重启后还是同一个工作区。
   */
  ipcMain.handle('workspace:set-root', async (_event, rawPath: unknown, options: unknown) => {
    const rt = runtime;
    if (!rt) throw new Error('应用尚未就绪');
    if (typeof rawPath !== 'string' || rawPath.trim() === '') throw new Error('目录路径不合法');

    const target = resolve(rawPath.trim());
    const current = resolve(rt.workspace.path);
    if (target === current) throw new Error('新目录与当前工作区目录相同');

    const appPaths = appDataPaths(app.getPath('userData'));
    for (const [label, dir] of [
      ['数据目录', appPaths.dataDir],
      ['日志目录', appPaths.logsDir],
    ] as const) {
      const base = resolve(dir);
      if (target === base || target.startsWith(base + sep)) {
        throw new Error(`不能把工作区放在${label}里：${base}`);
      }
    }

    // 建目录 + 建结构（attachments 之类的收尾在 ensureWorkspaceLayout 里）
    mkdirSync(target, { recursive: true });
    ensureWorkspaceLayout(target);

    const moveProjects = Boolean((options as { moveProjects?: unknown } | null)?.moveProjects);
    const moved: string[] = [];
    const skipped: string[] = [];
    const failed: { name: string; reason: string }[] = [];

    if (moveProjects && existsSync(current)) {
      for (const entry of readdirSync(current, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const from = join(current, entry.name);
        const to = join(target, entry.name);
        if (existsSync(to)) {
          skipped.push(entry.name);
          continue;
        }
        try {
          renameSync(from, to);
          moved.push(entry.name);
        } catch (error) {
          failed.push({
            name: entry.name,
            reason: error instanceof Error ? error.message : String(error),
          });
        }
      }
    }

    const entry: WorkspaceRegistryEntry = { ...rt.workspace, path: target };
    const { config } = updateAppConfig(app.getPath('userData'), (currentConfig) =>
      upsertWorkspace({ ...currentConfig, activeWorkspaceId: entry.id }, entry),
    );

    rt.config = config;
    rt.workspace = entry;
    rt.logger.info('工作区目录已切换', {
      from: current,
      to: target,
      moved: moved.length,
      skipped: skipped.length,
      failed: failed.length,
    });

    /*
     * 主动通知渲染层。
     *
     * 一开始我把“刷新界面”写在设置页的按钮处理函数里，结果只要换一个调用方
     * （别的地方调、或者自动化脚本直接调这个接口）界面就停在旧路径上 ——
     * 这种“谁改谁负责刷新”的约定迟早会漏。改成**主进程改完就广播**：
     * 不管谁触发的切换，界面都会跟着更新。
     */
    rt.window?.webContents.send('workspace:changed', { workspaceRoot: target });

    /*
     * 注意：内嵌服务在启动时拿到 workspaceRoot（导出诊断包要用它）。
     * 这里不会重建服务 —— 也就是说**诊断包导出仍指向旧目录，重启后才会更新**。
     * 这条要如实告诉用户（见设置页的提示），而不是假装完全生效了。
     */
    return { workspaceRoot: target, moved, skipped, failed };
  });

  /**
   * 立即备份一次数据库。
   *
   * 用 SQLite 自己的 backup API，**不是直接拷文件**：库跑在 WAL 模式下，
   * 最新写入可能还在 `-wal` 里，单拷一个 `.db` 会得到一份缺数据的库。
   * 备份落在 `<userData>/backups/`（应用自己的区域，不随工作区走，见需求 §13.1）。
   */
  ipcMain.handle('backup:run', async () => {
    const rt = runtime;
    if (!rt) throw new Error('应用尚未就绪');

    const appPaths = appDataPaths(app.getPath('userData'));
    mkdirSync(appPaths.backups, { recursive: true });

    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const file = join(appPaths.backups, `workspace-${stamp}.db`);

    const result = await rt.conn.sqlite.backup(file);

    rt.logger.info('已手动备份数据库', { file, pages: result.totalPages });
    return { file, pages: result.totalPages };
  });

  /** 打开备份目录（备份落在 AppData，用户得能找到它） */
  ipcMain.handle('backup:reveal', async () => {
    const appPaths = appDataPaths(app.getPath('userData'));
    mkdirSync(appPaths.backups, { recursive: true });
    await shell.openPath(appPaths.backups);
  });

  /**
   * 重启应用。
   *
   * 存在的理由：切换工作区目录之后，内嵌服务**还拿着启动时的旧路径**，
   * （新建项目时建文件夹用它、导出诊断包也用它）。与其偷偷改一个不一致的状态，
   * 不如给用户一个按钮：重启一次，所有组件都读同一份新配置。
   */
  ipcMain.handle('app:relaunch', () => {
    runtime?.logger.info('用户要求重启应用');
    app.relaunch();
    app.exit(0);
  });

  /**
   * 检测这台电脑上装了哪些编辑器。
   *
   * 原来设置页是一个固定下拉：把白名单里 8 个命令全列出来，用户面对一堆
   * 自己没装的名字（webstorm / idea / subl…）无从下手。改成**先探测再让人选**：
   * 复用“用编辑器打开”那条路径上的解析逻辑（PATH → 反推 exe → 常见安装位置），
   * 能解析出来的才算“装了”。
   *
   * 探测结果是“这台机器的事”，不落盘；用户选中的命令才进偏好。
   */
  ipcMain.handle('editor:detect', () => {
    const probe = createPathEditorProbe();
    const expand = (template: string): string => expandEnvVars(template);

    const found: { command: string; exe: string }[] = [];
    for (const command of ALLOWED_EDITOR_COMMANDS) {
      const result = resolveEditorExecutable(command, probe, { expand });
      if (result.ok) found.push({ command, exe: result.exe });
    }
    runtime?.logger.info('已检测本机编辑器', { found: found.map((item) => item.command) });
    return found;
  });

  /**
   * 开发环境检测（M4 第一步，只读）。
   *
   * `environment:status` 先给缓存的（首次为空），`environment:detect` 强制重测。
   * 结果缓存在 `<userData>/environment.json` —— 界面上每次进设置页都重测没有意义
   * （探测要派生 7~8 个子进程），但用户装了新工具之后必须能手动刷新，
   * 所以“缓存 + 重新检测按钮”这一对是必须的（需求 §5.7）。
   */
  ipcMain.handle('environment:status', () => {
    const snapshot = readEnvironmentCache(appDataPaths(app.getPath('userData')).environment);
    if (!snapshot) return null;
    return { ...snapshot, restartHint: restartHint(snapshot, process.env.PATH ?? '') };
  });

  ipcMain.handle('environment:detect', async () => {
    const paths = appDataPaths(app.getPath('userData'));
    const snapshot = await detectEnvironment({
      appStartedAt,
      // 探测命令在一个确定的空目录里跑，而不是碰巧的工作目录
      cwd: app.getPath('userData'),
    });

    writeEnvironmentCache(paths.environment, snapshot);
    runtime?.logger.info('已检测开发环境', {
      ready: snapshot.ready,
      missingRequired: snapshot.missingRequired,
      tools: snapshot.tools
        .filter((tool) => tool.found)
        .map((tool) => `${tool.id}@${tool.version ?? '?'}`),
    });

    return { ...snapshot, restartHint: restartHint(snapshot, process.env.PATH ?? '') };
  });

  /**
   * GitHub 绑定的预留接口（见 main/github.ts）。
   *
   * 三个动作一起立出来，是为了“契约”完整：界面、preload、主进程三层的形状现在就定死。
   * 以后实现 Device Flow 时只换 `beginGithubConnect` 的实现，不动调用方。
   * **状态**存在 config.json 的 `preferences.github` 里（只有“绑没绑、绑的是谁”），
   * **令牌**将来加密存到 `<userData>/github.credential`，绝不进配置文件。
   */
  ipcMain.handle('github:status', () => {
    const rt = runtime;
    if (!rt) throw new Error('应用尚未就绪');
    return getGithubStatus(rt.config.preferences, app.getPath('userData'));
  });

  ipcMain.handle('github:connect', () => {
    if (!runtime) throw new Error('应用尚未就绪');
    // 如实返回“尚未实现”，不抛异常：界面要能区分“功能没做”和“操作失败”
    return beginGithubConnect();
  });

  ipcMain.handle('github:disconnect', () => {
    const rt = runtime;
    if (!rt) throw new Error('应用尚未就绪');

    const result = disconnectGithub(app.getPath('userData'));
    const { config } = updateAppConfig(app.getPath('userData'), (current) => ({
      ...current,
      preferences: {
        ...current.preferences,
        github: { connected: false, login: null, hasToken: false, connectedAt: null },
      },
    }));
    rt.config = config;
    rt.logger.info('GitHub 绑定已解除', { removedCredential: result.removedCredential });
    return getGithubStatus(config.preferences, app.getPath('userData'));
  });

  ipcMain.handle('app:quit', () => {
    requestQuit();
  });

  ipcMain.handle('preferences:get', () => runtime?.config.preferences ?? null);

  /**
   * 更新偏好并落盘。
   *
   * 这里不做字段白名单：写进去的值在下次读取时会由 `normalize()` 逐字段校验，
   * 并回落到默认值，所以即使渲染进程传了非法值也不会让配置变得不可用。
   *
   * **但合并是浅合并**（`{...current.preferences, ...patch}`）：调用方改嵌套字段时，
   * 必须把整个嵌套对象传全（例如 `logging: { level, retentionDays, ... }`），
   * 只传 `{logging: {level}}` 会把 logging 里其它字段抹成 undefined。
   * 设置页据此统一传完整对象 —— 这条很容易踩，所以在两端都写了注释。
   */
  ipcMain.handle('preferences:patch', (_event, patch: unknown) => {
    const rt = runtime;
    if (!rt) throw new Error('应用尚未就绪');
    if (typeof patch !== 'object' || patch === null) throw new Error('偏好设置格式不正确');

    const { config } = updateAppConfig(app.getPath('userData'), (current) => ({
      ...current,
      preferences: { ...current.preferences, ...(patch as Record<string, unknown>) },
    }));
    rt.config = config;

    /*
     * 让“日志级别”当场生效。
     *
     * 其余偏好（脱敏、文件轮转参数、备份策略）要重建 logger / 文件写入器才生效，
     * 所以设置页对它们标注“下次启动生效”。日志级别不一样：logger 本来就提供了
     * `setMinLevel`，不改的话用户会以为设置没保存（明明存了，却还在刷屏）。
     */
    rt.logger.setMinLevel(config.preferences.logging.level);

    return config.preferences;
  });

  /**
   * 同步读取偏好。
   *
   * preload 必须**在首帧之前**拿到主题，否则会先渲染出错误颜色再跳成正确的
   * （暗色用户会看到刺眼的白闪）。异步 IPC 做不到这件事，所以用 sendSync ——
   * 只在启动时调一次，主进程立即返回，代价可以忽略。
   */
  ipcMain.on('preferences:get-sync', (event) => {
    event.returnValue = runtime?.config.preferences ?? null;
  });
}

/**
 * 退出前确认。
 *
 * 有作业在跑（例如装依赖）时直接退出会留下半成品目录，
 * 所以给用户一个明确的二选一，而不是默默地杀掉。 */
function requestQuit(): void {
  const rt = runtime;
  if (!rt) {
    app.quit();
    return;
  }

  const running = countRunningJobs(rt.conn);
  if (running > 0) {
    const choice = dialog.showMessageBoxSync({
      type: 'warning',
      buttons: ['等待完成（取消退出）', '强制退出'],
      defaultId: 0,
      cancelId: 0,
      title: '仍有作业在执行',
      message: `还有 ${running} 个作业正在运行。`,
      detail: '强制退出会中断作业，可能留下未完成的目录或半装好的依赖。',
    });
    if (choice !== 1) return;
    rt.logger.warn('用户选择强制退出，仍有作业在运行', { running });
  }

  rt.quitting = true;
  app.quit();
}

/* ------------------------------------------------------------------ */
/* 启动                                                                */
/* ------------------------------------------------------------------ */

async function bootstrap(): Promise<void> {
  app.setAppUserModelId('com.pmstudio.desktop');

  const userDataDir = app.getPath('userData');
  const version = app.getVersion();
  // 应用自身的路径（日志、备份）与工作区路径分开。
  // 工作区只服务项目，这些都不进工作区（见 app-config.ts）。
  const appPaths = appDataPaths(userDataDir);

  /* --- 1) 配置 --- */
  const read = readAppConfig(userDataDir);

  /* --- 2) 文件日志（必须先于数据库）--- */
  const fileSink = new RotatingFileWriter({
    basePath: appPaths.fileLog,
    maxBytes: read.config.preferences.logging.fileMaxMB * 1024 * 1024,
    keepCount: read.config.preferences.logging.fileKeepCount,
  });
  await fileSink.open();

  const logger = createLogger({
    source: 'main',
    sinks: [fileSink],
    minLevel: read.config.preferences.logging.level,
    redact: { redactUserName: read.config.preferences.logging.redactUserName },
  });

  logger.info('项目管理系统启动中', {
    version,
    userDataDir,
    packaged: app.isPackaged,
    // 环境“为什么是这个目录”一起记：以后看到数据不对，翻日志就能定位
    environment: environment.env,
    environmentReason: environment.reason,
  });
  for (const warning of read.warnings) logger.warn(warning);

  /* --- 3) 工作区 --- */
  let config = read.config;
  const existing = findActiveWorkspace(config);
  const workspace = existing ?? createDefaultWorkspace(userDataDir, logger);
  config = touchWorkspace(userDataDir, workspace);

  ensureWorkspaceLayout(workspace.path);
  // 旧版本遗留在工作区里的目录（`backups/`、`logs/`、`projects/`、`attachments/`）逐个清掉。
  // 只删空的：里面有东西就保留并告警（见 removeObsoleteWorkspaceDirs 的说明）。
  const tidied = removeObsoleteWorkspaceDirs(workspace.path);
  if (tidied.removed.length > 0) {
    logger.info('已清掉工作区里不再使用的旧目录', { removed: tidied.removed });
  }
  for (const dir of tidied.kept) {
    logger.warn('工作区里这个目录已不再使用，但里面还有内容，保留不动', { dir });
  }

  /* --- 4) 数据库 --- */

  // 0.1.2 起数据库不在工作区里（工作区只放项目）。这一步负责把老位置的文件搬过来，
  // 并且**先做 WAL 检查点再搬**，否则还在 -wal 里的最新写入会丢。
  const location = resolveWorkspaceDatabase(workspace.path, appPaths.dataDir, logger);

  // 工作区库：**先不自动迁移**。0.1.0 及更早把应用日志写在这张库里；
  // 而 0.1.1 的迁移会删掉那张表 —— 必须先把旧日志导出到工作区之外，再迁移。
  // 顺序反了就是静默丢数据，所以这里显式分成两步。
  const conn = new DbConnection({ logger: logger.child('db'), autoMigrate: false });
  conn.open(location.path);
  exportLegacyAppLogs(conn, appPaths.legacyAppLogs, logger);
  conn.migrate();
  recoverInterruptedJobs(conn, logger);

  /* --- 5) 日志落库 + 实时广播 --- */
  // 日志库在 AppData（**不在工作区里**）：工作区只服务项目，
  // 应用自身的运行期数据（日志、备份）不该跟着工作区被拷来拷去。
  mkdirSync(appPaths.logsDir, { recursive: true });
  const appLogsDb = new DbConnection({
    logger: logger.child('app-logs'),
    // 这张库只装应用日志，表由日志存储层自己建（APP_LOGS_DDL），
    // 不走工作区那套迁移 —— 它不属于工作区。
    autoMigrate: false,
  });
  appLogsDb.open(appPaths.appLogsDatabase);

  const logStore = createLogStore({
    db: appLogsDb.sqlite,
    flushIntervalMs: 500,
    flushBatch: 200,
  });
  const broadcaster = createLogBroadcaster();
  logger.addSink(logStore);
  logger.addSink(broadcaster);

  /* --- 6) 内嵌服务 --- */

  /*
   * 工作日志（Word）的落点。
   *
   * 默认放“文档”目录下的一个子文件夹：用户生成完日志的第一反应是去文档里找，
   * 而不是去 AppData（那里翻了也看不懂）。设置里可以改成别的目录，
   * 改了之后立刻生效 —— 渲染层每次生成都会把当前设置的值一起发过来，
   * 服务端优先用它，所以不需要重启应用。
   */
  const workLogDir = resolveWorkLogDir(config, app.getPath('documents'));

  const server = await startEmbeddedServer({
    conn,
    logger,
    logStore,
    logBroadcaster: broadcaster,
    // 每次启动重新生成：令牌不落盘，重启即失效
    token: randomUUID(),
    version,
    allowedOrigins: DEVELOPMENT_RENDERER_URL
      ? [new URL(DEVELOPMENT_RENDERER_URL).origin]
      : [],
    // 生产环境由内嵌服务提供渲染层，窗口与 API 同源；开发环境用 Vite dev server
    ...(DEVELOPMENT_RENDERER_URL ? {} : { rendererRoot: join(__dirname, '../renderer') }),
    // 诊断包导出需要知道要摘要哪个工作区
    workspaceRoot: workspace.path,
    // M4 作业执行器：第一个真作业是「环境自检」（只读，走命令白名单真跑外部命令）
    jobHandlers: JOB_HANDLERS,
    // 作业日志文件与文本日志放一起（都在 AppData，不随工作区走）
    jobLogDir: join(appDataPaths(app.getPath('userData')).logsDir, 'jobs'),
    // 工作日志（Word）的默认落点
    workLogDir,
  });
  logger.info('内嵌服务已就绪', { baseUrl: server.baseUrl });

  /* --- 6.5) 当日工作时间（打卡）--- */

  /*
   * 计时口径是“应用开着的时间”（用户的要求：每天第一次打开软件开始计时，
   * 最后一次关闭结束）。所以这件事只能由**主进程**做：
   * 渲染层刷新、切页面、窗口隐藏到托盘，都不代表应用关了。
   *
   * 顺序：先把上次没关干净的会话收到“最后一次心跳”为止，再开今天这一条 ——
   * 反过来的话刚开的新会话会被当成残留会话一起收掉，今天的工时就永远是 0。
   */
  beginWorkSession(server.services, logger);

  /* --- 7) 运行时状态与 IPC --- */

  // 先把 runtime 建好并注册 IPC，**再**创建窗口。
  // 反过来的话，窗口一加载 preload 就会发 IPC，而此时还没有处理器 ——
  // 表现为应用偶发卡在启动阶段（时序竞态，不是每次都复现，很难查）。
  runtime = {
    config,
    workspace,
    logger,
    conn,
    appLogsDb,
    logStore,
    broadcaster,
    fileSink,
    server,
    window: null,
    tray: null,
    timers: [],
    quitting: false,
  };
  const rt = runtime;

  registerIpcHandlers();

  /* --- 8) 窗口与托盘 --- */

  rt.window = createMainWindow({
    preloadPath: join(__dirname, '../preload/index.cjs'),
    baseUrl: server.baseUrl,
    devServerUrl: DEVELOPMENT_RENDERER_URL,
    isQuitting: () => rt.quitting,
    onClosed: () => {
      rt.window = null;
    },
    // 记一条：用户点 X 之后应用仍在后台，这条日志能直接回答“它怎么还在跑”
    onHiddenToTray: () => {
      logger.info('窗口已隐藏到托盘，应用继续在后台运行（退出请用托盘菜单）');
    },
  });

  rt.tray = createTrayController({
    // 正式环境不挂环境标签（用户 2026-10-01）：传空串表示不显示
    tooltip: trayTooltip(version, workspace.path, environment.env === 'production' ? '' : ENVIRONMENT_LABEL[environment.env]),
    onShowWindow: () => focusWindow(rt.window),
    onOpenWorkspace: () => {
      void shell.openPath(workspace.path);
    },
    onQuit: () => requestQuit(),
  });

  rt.timers.push(
    // 定时把文本日志落盘：低流量时不能让它一直停在内存里
    setInterval(() => {
      void fileSink.flush();
    }, FILE_FLUSH_INTERVAL_MS),
    // 打卡心跳：让“应用还活着”这件事每隔 30 秒留个痕。断电、强杀时，
    // 下次启动就靠最后一个痕迹把会话收到那一刻为止（而不是算到下次打开为止）。
    setInterval(() => {
      try {
        touchWorkSession(server.services);
      } catch (error) {
        // 心跳失败不该弄崩应用：最坏的结果是下次启动少算 30 秒
        logger.warn('打卡心跳写入失败', { error });
      }
    }, WORK_SESSION_HEARTBEAT_MS),
  );

  logger.info('项目管理系统已就绪', { port: server.port });
}

/**
 * 工作日志的默认保存目录。
 *
 * 抽成纯函数（不碰 electron）：`app.getPath('documents')` 由调用方传进来，
 * 这样“设置里填了就用设置的、没填就用文档目录下的子文件夹”这条规则可以单测 ——
 * 它错了的表现是“文件生成成功但找不到”，比报错难查得多。 */
export function resolveWorkLogDir(config: AppConfig, documentsDir: string): string {
  const configured = config.preferences.workLogSaveDir?.trim();
  if (configured && configured.length > 0) return expandEnvVars(configured);
  return join(documentsDir, '项目管理系统', '工作日志');
}

/**
 * 启动时接上打卡：补收残留会话 → 开出今天的这一条。
 *
 * 抽成函数是为了让这两步**绑在一起**：只补收不开新会话，界面上的计时器会停在 00:00:00
 * 直到用户重启；只开新会话不补收，断电那次会被算到“下次打开”为止（凭空多出几小时）。 */
function beginWorkSession(services: ServiceContext, logger: Logger): void {
  try {
    const recovered = recoverStaleSessions(services);
    if (recovered.recovered > 0) {
      logger.info('上次没有正常退出，计时已收到最后一次心跳为止', {
        sessions: recovered.recovered,
      });
    }
    const session = startWorkSession(services);
    logger.info('开始记录今日工作时间', { sessionId: session.id, startedAt: session.startedAt });
  } catch (error) {
    // 打卡失败不能拦住应用启动：核心功能（项目/任务）比工时统计重要得多
    logger.error('初始化当日工作时间失败，本次启动不计时', error);
  }
}

/** 收尾：顺序与启动相反，且每一步都不能因为失败而阻断后续清理 */
async function shutdown(): Promise<void> {
  const rt = runtime;
  if (!rt) return;
  runtime = null;

  for (const timer of rt.timers) clearInterval(timer);

  /*
   * 结束计时放在**最前面、且在第一个 await 之前**：
   * - 最前面：后面会关服务、关日志库、关工作区库，晚一步就没有库可写了。
   * - await 之前：`will-quit` 里是 `void shutdown()`，主进程可能在第一个 await
   *   之后就直接退出了。同步写完这一条，退出流程才不会被“来不及”吃掉。
   */
  try {
    const ended = endWorkSessions(rt.server.services, 'app_quit');
    if (ended > 0) rt.logger.info('本次使用时长已记录', { sessions: ended });
  } catch (error) {
    rt.logger.warn('结束计时失败（下次启动会按最后一次心跳补收）', { error });
  }

  try {
    await rt.server.close();
  } catch (error) {
    rt.logger.warn('关闭内嵌服务时出错', { error });
  }
  try {
    rt.logStore.close();
  } catch (error) {
    rt.logger.warn('关闭日志存储时出错', { error });
  }
  try {
    rt.appLogsDb.close();
  } catch (error) {
    rt.logger.warn('关闭应用日志库时出错', { error });
  }
  try {
    await rt.fileSink.close();
  } catch {
    // 已经尽力了
  }
  try {
    rt.tray?.destroy();
  } catch {
    // 忽略
  }
  rt.conn.close();
}

/* ------------------------------------------------------------------ */
/* 应用生命周期                                                        */
/* ------------------------------------------------------------------ */

// 单实例锁：拿不到就唤醒已有窗口并退出本次启动
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    // 记一条日志：用户双击两次图标时，能从这里看出“第二次被合并了”
    runtime?.logger.info('检测到第二个实例启动，已唤回已有窗口');
    focusWindow(runtime?.window ?? null);
  });

  app.on('before-quit', () => {
    if (runtime) runtime.quitting = true;
  });

  // 关掉所有窗口**不退出**：应用常驻托盘，退出只能走托盘菜单
  app.on('window-all-closed', () => {
    // 故意留空
  });

  app.on('will-quit', () => {
    void shutdown();
  });

  process.on('uncaughtException', (error) => {
    runtime?.logger.error('主进程未捕获异常', error);
  });

  process.on('unhandledRejection', (reason) => {
    runtime?.logger.error('主进程存在未处理的 Promise 拒绝', reason);
  });

  void bootstrap().catch((error: unknown) => {
    // 启动阶段就失败时，日志可能还没落库；此时至少写到文件与标准错误
    runtime?.logger.error('启动失败', error);
    // eslint-disable-next-line no-console -- 启动失败的最后一道可见性
    console.error('[项目管理系统] 启动失败：', error);
    dialog.showErrorBox(
      '项目管理系统启动失败',
      `应用无法启动。\n\n${String(error instanceof Error ? error.stack ?? error.message : error)}`,
    );
    app.exit(1);
  });
}
