/**
 * 全局配置（`<userData>/config.json`）。
 *
 * 刻意**不 import electron**：把 `userDataDir` 作为参数传入，
 * 这样这个模块可以在普通 Node 环境下单测 —— 而配置读写恰恰是最需要
 * 测试的一环（原子写、损坏恢复、字段合并）。
 *
 * 三条设计要点：
 *
 * 1. **原子写**。先写临时文件再 rename。直接覆盖写的话，写到一半断电
 *    就会留下一个半截的 JSON，下次启动直接读不出来。
 * 2. **损坏可恢复**。JSON 解析失败时把坏文件改名备份，然后返回默认配置 ——
 *    宁可丢偏好设置，也不能让应用起不来。
 * 3. **与默认值深合并**。升级后新增的字段自动补上，老配置文件不会被判为非法。
 */

import { existsSync, mkdirSync, readFileSync, renameSync, rmdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import type { LogLevel } from '@pm-studio/shared';

export const CONFIG_VERSION = 1;

export interface WorkspaceRegistryEntry {
  id: string;
  name: string;
  /** 工作区根目录（数据库、代码目录、附件都在其下） */
  path: string;
  createdAt: number;
  lastOpenedAt: number;
}

export interface AppPreferences {
  theme: 'light' | 'dark' | 'system';
  /** 侧边栏是否折叠 */
  sidebarCollapsed: boolean;
  /** 界面密度：影响行高与内边距 */
  density: 'comfortable' | 'compact';
  /**
   * 上次打开的项目 id。
   *
   * 存在这里而不是 localStorage：窗口加载的是 `http://127.0.0.1:<动态端口>`，
   * 而 origin 包含端口 —— 端口每次启动都不同，localStorage 每次都是空的。
   */
  lastProjectId: string | null;
  /** 新建项目时默认落点；null 表示用工作区默认值 */
  defaultProjectRoot: string | null;
  /** 用哪个命令打开 IDE */
  editorCommand: string;
  /**
   * GitHub 绑定状态（**接口已预留，OAuth 流程尚未实现**）。
   *
   * 这里**只放"绑定到谁"这样的非敏感信息**。访问令牌绝不能进 config.json ——
   * 它是明文 JSON，备份、诊断包、误发给别人都会连带泄漏。令牌的存放方案见
   * `main/github.ts`（Electron `safeStorage` 加密后单独存一个文件），
   * 所以这个对象里连"令牌"两个字都不出现，只有一个 `hasToken` 布尔。
   */
  github: {
    /** 是否已绑定 */
    connected: boolean;
    /** 绑定的 GitHub 登录名；未绑定时为 null */
    login: string | null;
    /** 是否已经存了访问令牌（只回答"有没有"，不回答"是什么"） */
    hasToken: boolean;
    /** 绑定时间（毫秒）；未绑定为 null */
    connectedAt: number | null;
  };
  autoBackup: {
    enabled: boolean;
    intervalMinutes: number;
    keepCount: number;
  };
  logging: {
    level: LogLevel;
    retentionDays: number;
    fileMaxMB: number;
    fileKeepCount: number;
    /** 是否把路径中的用户名替换为 %USER% */
    redactUserName: boolean;
  };
  /**
   * 生成的工作日志（Word）存到哪个目录。
   *
   * `null` = 用默认目录（`<文档>\项目管理系统\工作日志`）。存 null 而不是把默认路径
   * 直接写进配置：用户的"文档"目录可能被改到别的盘，写死一个路径之后改了盘符就失效；
   * 存 null 让默认值每次启动重新解析。
   *
   * 刻意放在顶层而不是嵌一层 `workLog: {...}`：偏好补丁走的是**浅合并**
   * （见 `preferences:patch`），嵌套对象会被整块替换掉，将来加第二个日志设置项时
   * 就会静默丢掉同层的其他值。
   */
  workLogSaveDir: string | null;
}

export interface AppConfig {
  version: number;
  activeWorkspaceId: string | null;
  workspaces: WorkspaceRegistryEntry[];
  preferences: AppPreferences;
  /** 上次成功启动的时间，用于诊断 */
  lastStartedAt: number | null;
}

export function defaultAppConfig(): AppConfig {
  return {
    version: CONFIG_VERSION,
    activeWorkspaceId: null,
    workspaces: [],
    preferences: {
      theme: 'dark',
      sidebarCollapsed: false,
      density: 'comfortable',
      lastProjectId: null,
      defaultProjectRoot: null,
      editorCommand: 'code',
      github: { connected: false, login: null, hasToken: false, connectedAt: null },
      autoBackup: { enabled: true, intervalMinutes: 30, keepCount: 10 },
      logging: {
        level: 'info',
        retentionDays: 30,
        fileMaxMB: 5,
        fileKeepCount: 5,
        redactUserName: true,
      },
      workLogSaveDir: null,
    },
    lastStartedAt: null,
  };
}

export function configPathFor(userDataDir: string): string {
  return join(userDataDir, 'config.json');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** 逐字段校验并回落到默认值：任何一个字段写坏都不该让整份配置失效 */
function normalize(raw: unknown): AppConfig {
  const defaults = defaultAppConfig();
  if (!isRecord(raw)) return defaults;

  const preferences = isRecord(raw.preferences) ? raw.preferences : {};
  const autoBackup = isRecord(preferences.autoBackup) ? preferences.autoBackup : {};
  const logging = isRecord(preferences.logging) ? preferences.logging : {};
  const github = isRecord(preferences.github) ? preferences.github : {};

  const workspaces = Array.isArray(raw.workspaces)
    ? raw.workspaces
        .filter(isRecord)
        .filter((w) => typeof w.id === 'string' && typeof w.path === 'string')
        .map((w) => ({
          id: w.id as string,
          name: typeof w.name === 'string' ? w.name : '工作区',
          path: w.path as string,
          createdAt: typeof w.createdAt === 'number' ? w.createdAt : 0,
          lastOpenedAt: typeof w.lastOpenedAt === 'number' ? w.lastOpenedAt : 0,
        }))
    : [];

  const theme = preferences.theme;
  const level = logging.level;

  return {
    version: typeof raw.version === 'number' ? raw.version : CONFIG_VERSION,
    activeWorkspaceId:
      typeof raw.activeWorkspaceId === 'string' ? raw.activeWorkspaceId : null,
    workspaces,
    preferences: {
      theme: theme === 'light' || theme === 'dark' || theme === 'system' ? theme : defaults.preferences.theme,
      sidebarCollapsed:
        typeof preferences.sidebarCollapsed === 'boolean'
          ? preferences.sidebarCollapsed
          : defaults.preferences.sidebarCollapsed,
      density:
        preferences.density === 'comfortable' || preferences.density === 'compact'
          ? preferences.density
          : defaults.preferences.density,
      lastProjectId:
        typeof preferences.lastProjectId === 'string' ? preferences.lastProjectId : null,
      defaultProjectRoot:
        typeof preferences.defaultProjectRoot === 'string' ? preferences.defaultProjectRoot : null,
      editorCommand:
        typeof preferences.editorCommand === 'string'
          ? preferences.editorCommand
          : defaults.preferences.editorCommand,
      github: {
        /*
         * 校验得严一点：`connected` 只有在**同时有 login 且有令牌**时才认。
         * 否则一份手改坏的配置会呈现出"已绑定、但没有账号"的怪状态，
         * 界面上既不能显示是谁，也不能真正拉取任何东西。
         */
        connected:
          github.connected === true &&
          typeof github.login === 'string' &&
          github.login.length > 0 &&
          github.hasToken === true,
        login: typeof github.login === 'string' && github.login.length > 0 ? github.login : null,
        hasToken: github.hasToken === true,
        connectedAt: typeof github.connectedAt === 'number' ? github.connectedAt : null,
      },
      autoBackup: {
        enabled:
          typeof autoBackup.enabled === 'boolean'
            ? autoBackup.enabled
            : defaults.preferences.autoBackup.enabled,
        intervalMinutes:
          typeof autoBackup.intervalMinutes === 'number' && autoBackup.intervalMinutes > 0
            ? autoBackup.intervalMinutes
            : defaults.preferences.autoBackup.intervalMinutes,
        keepCount:
          typeof autoBackup.keepCount === 'number' && autoBackup.keepCount > 0
            ? autoBackup.keepCount
            : defaults.preferences.autoBackup.keepCount,
      },
      logging: {
        level:
          level === 'error' || level === 'warn' || level === 'info' || level === 'debug'
            ? level
            : defaults.preferences.logging.level,
        retentionDays:
          typeof logging.retentionDays === 'number' && logging.retentionDays > 0
            ? logging.retentionDays
            : defaults.preferences.logging.retentionDays,
        fileMaxMB:
          typeof logging.fileMaxMB === 'number' && logging.fileMaxMB > 0
            ? logging.fileMaxMB
            : defaults.preferences.logging.fileMaxMB,
        fileKeepCount:
          typeof logging.fileKeepCount === 'number' && logging.fileKeepCount > 0
            ? logging.fileKeepCount
            : defaults.preferences.logging.fileKeepCount,
        redactUserName:
          typeof logging.redactUserName === 'boolean'
            ? logging.redactUserName
            : defaults.preferences.logging.redactUserName,
      },
      // 空串按"没设置"处理：用户清空输入框时不该得到一个写不进去的目录
      workLogSaveDir:
        typeof preferences.workLogSaveDir === 'string' &&
        preferences.workLogSaveDir.trim().length > 0
          ? preferences.workLogSaveDir
          : null,
    },
    lastStartedAt: typeof raw.lastStartedAt === 'number' ? raw.lastStartedAt : null,
  };
}

export interface ReadConfigResult {
  config: AppConfig;
  /** 读取过程中发生的问题，交给日志而不是抛异常 */
  warnings: string[];
  /** 损坏文件的备份路径（若发生了备份） */
  backupPath?: string;
}

export function readAppConfig(userDataDir: string, now: () => number = Date.now): ReadConfigResult {
  const path = configPathFor(userDataDir);
  const warnings: string[] = [];

  if (!existsSync(path)) {
    return { config: defaultAppConfig(), warnings };
  }

  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (error) {
    warnings.push(`读取配置失败，使用默认配置：${String(error)}`);
    return { config: defaultAppConfig(), warnings };
  }

  try {
    const parsed: unknown = JSON.parse(text);
    return { config: normalize(parsed), warnings };
  } catch {
    // 损坏 → 备份后回落默认值。宁可丢偏好，也不能让应用起不来。
    const backupPath = `${path}.corrupt-${now()}.json`;
    try {
      renameSync(path, backupPath);
      warnings.push(`配置文件损坏，已备份到 ${backupPath} 并重建默认配置`);
      return { config: defaultAppConfig(), warnings, backupPath };
    } catch (error) {
      warnings.push(`配置文件损坏且备份失败：${String(error)}`);
      return { config: defaultAppConfig(), warnings };
    }
  }
}

/**
 * 原子写：先写 `.tmp` 再 rename。
 *
 * rename 在同一文件系统内是原子操作，所以任何时刻磁盘上的 config.json
 * 要么是旧内容、要么是新内容，不存在"半截文件"。
 */
export function writeAppConfig(userDataDir: string, config: AppConfig): void {
  const path = configPathFor(userDataDir);
  mkdirSync(dirname(path), { recursive: true });

  const tmp = `${path}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
  renameSync(tmp, path);
}

/** 读 → 改 → 写（原子） */
export function updateAppConfig(
  userDataDir: string,
  mutate: (config: AppConfig) => AppConfig,
  now: () => number = Date.now,
): { config: AppConfig; warnings: string[] } {
  const { config, warnings } = readAppConfig(userDataDir, now);
  const next = mutate(config);
  writeAppConfig(userDataDir, next);
  return { config: next, warnings };
}

/* ------------------------------------------------------------------ */
/* 工作区注册表操作                                                    */
/* ------------------------------------------------------------------ */

export function upsertWorkspace(
  config: AppConfig,
  entry: WorkspaceRegistryEntry,
): AppConfig {
  const others = config.workspaces.filter((w) => w.id !== entry.id);
  return {
    ...config,
    workspaces: [...others, entry].sort((a, b) => a.createdAt - b.createdAt),
  };
}

export function findActiveWorkspace(config: AppConfig): WorkspaceRegistryEntry | undefined {
  if (!config.activeWorkspaceId) {
    // 没指定就退回最近打开的那个，避免"配置里明明有工作区却启动到空白状态"
    return [...config.workspaces].sort((a, b) => b.lastOpenedAt - a.lastOpenedAt)[0];
  }
  return config.workspaces.find((w) => w.id === config.activeWorkspaceId);
}

/**
 * 工作区布局。
 *
 * **工作区文件夹里只有项目**（0.1.2 起）：每个项目是根目录下的一个文件夹，
 * 里面放代码、`attachments/`、`logs/`。
 *
 * 工作区的**管理数据**（项目登记、任务、看板、标签）不在这个目录里 ——
 * 它在 `<userData>/data/workspace.db`（见 `appDataPaths()`）。
 * 这么分的理由：用户打开工作区目录时，看到的应当**只有自己的项目**，
 * 而不是一个躺在项目旁边的数据库文件。
 */
export function ensureWorkspaceLayout(root: string): void {
  mkdirSync(root, { recursive: true });
}

/**
 * 清掉旧版本遗留在工作区里的目录：
 * `backups/`、`logs/`（0.1.0 的）、`projects/`（0.1.1 的容器层）、`attachments/`（0.1.1 的工作区级附件）。
 *
 * 关键点是**只用非递归删除**：目录非空时 `rmdir` 会失败，于是它对"里面有东西"天然免疫。
 * - `backups/`、`logs/`、`attachments/` 旧版从没写入过，里面有内容就一定是用户自己放的；
 * - `projects/` 更危险：它当年是"放代码的地方"，用户完全可能把代码放在里面 ——
 *   所以非空时**必须保留**，只提示。
 *
 * 顺序上先子后父：`logs/jobs` 空了之后 `logs` 才可能空。
 */
export function removeObsoleteWorkspaceDirs(root: string): {
  removed: string[];
  kept: string[];
} {
  const removed: string[] = [];
  const kept: string[] = [];

  for (const relative of [join('logs', 'jobs'), 'logs', 'backups', 'projects', 'attachments']) {
    const target = join(root, relative);
    try {
      rmdirSync(target);
      removed.push(relative);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      // 不存在 = 已经干净了，不算问题
      if (code === 'ENOENT') continue;
      // 非空 = 里面有内容，保留（调用方会告警）
      kept.push(relative);
    }
  }

  return { removed, kept };
}

/**
 * 应用自身的数据目录（全部在 userData 下，**都不在工作区里**）。
 *
 * 把它们集中在一处，是为了避免"又有一个新文件被顺手写进了工作区"——
 * 这类问题出现时往往已经打包发出去，用户的迁移包里就多了一个不该有的东西。
 */
export function appDataPaths(userDataDir: string) {
  return {
    /** 文本日志（轮转）与结构化日志库都放这里 */
    logsDir: join(userDataDir, 'logs'),
    fileLog: join(userDataDir, 'logs', 'main.log'),
    /** 应用日志的结构化库：日志页 / SSE / 诊断包都读它 */
    appLogsDatabase: join(userDataDir, 'logs', 'app-logs.db'),
    /** 0.1.0 及更早把应用日志写在业务库里，整理时先导出到这份文件再删表 */
    legacyAppLogs: join(userDataDir, 'logs', 'legacy-app-logs.jsonl'),
    /**
     * 工作区管理数据（项目登记、任务、看板、标签）的存放目录。
     *
     * 刻意**放在工作区之外**：工作区文件夹里只放用户的项目，打开时一眼就能看到自己的项目，
     * 而不是一个躺在项目旁边的数据库文件。
     *
     * 命名约定：`data/workspace.db`。将来支持多工作区（M5）时，数据库路径要随工作区走
     * （写进 `config.json` 的工作区登记项），那时这里会变成"默认位置"。
     */
    dataDir: join(userDataDir, 'data'),
    database: join(userDataDir, 'data', 'workspace.db'),
    /** 备份目录（自动备份功能尚未实现，先把位置定死在工作区之外） */
    backups: join(userDataDir, 'backups'),
    /**
     * 开发环境检测结果的缓存（M4）。
     *
     * 放在 AppData 而不是工作区数据库里：它描述的是**这台机器**装了什么工具，
     * 不是用户的项目数据（工作区边界见需求 §13.1）。顺带的好处是换工作区（M5）
     * 之后同一个结果继续有效，不用重测。
     */
    environment: join(userDataDir, 'environment.json'),
  };
}
