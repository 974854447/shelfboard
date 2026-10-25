/**
 * 开发服务器的启动 / 停止（M4：只有前端 / 后端 / 前后端项目有）。
 *
 * ## 为什么单独一套，而不是塞进作业执行器
 *
 * 作业是"跑完拿结果"（有超时、有进度、有退出码）；开发服务器是**长驻**的：
 * 它永远不结束，输出要边跑边看（端口号就在启动横幅里），停止要**整棵进程树**一起停。
 * 两套语义混在一起，作业那一套会立刻变得难读（而且 `runCommand` 会把输出缓存到进程结束，
 * 对长驻进程就是"点了启动界面永远空白" —— 所以 `commands.ts` 里直接拦下了这种用法）。
 *
 * ## 纪律没变
 *
 * 命令仍然**只来自命令白名单**（`buildCommand`），`shell: false`，
 * cwd 一定是项目文件夹（或其 frontend/ · backend/ 子目录）。
 * 用户能决定的只有"哪个项目、哪个角色、哪个端口"，不能决定"跑什么命令"。
 *
 * ## 进程树：这里是这一版最容易出错的地方
 *
 * `npm run dev` 在 Windows 上是 `cmd.exe /d /c npm run dev` → `npm` → `node`。
 * 只杀最外层（`child.kill()`）留下的是**真正在监听端口的孙进程**：端口还被占着，
 * 用户点了"停止"却起不来第二次，现象是"端口被占用"。所以停止走
 * `taskkill /PID <pid> /T /F`（白名单 spec `kill-process-tree`），杀整棵树。
 */

import { type ChildProcess, spawn } from 'node:child_process';
import { get as httpGet, type IncomingMessage } from 'node:http';

import { AppError } from '@pm-studio/shared';

import type { ServiceContext } from './context.js';
import { buildCommand } from './commands.js';
import { detectRunTargets, type RunTarget } from './project-run.js';
import { getProjectOrThrow } from './projects.js';
import { ensureProjectFolder } from './project-folders.js';
import { pickPackageManager } from './job-install.js';
import { join } from 'node:path';

export type DevServerStatus = 'starting' | 'running' | 'stopped' | 'failed';

export interface DevServerLogLine {
  ts: number;
  stream: 'stdout' | 'stderr' | 'system';
  text: string;
}

export interface DevServerState {
  projectId: string;
  role: 'frontend' | 'backend';
  /** 这次跑的是什么（界面上要显示，别让用户猜） */
  kindLabel: string;
  /** 实际执行的命令（**只用于显示**，从不拿来执行） */
  command: string;
  dir: string;
  port: number;
  status: DevServerStatus;
  pid: number | null;
  startedAt: number | null;
  /** 结束时间（停止或失败） */
  endedAt: number | null;
  /** 失败原因（`status: 'failed'` 时一定有） */
  error: string | null;
  /**
   * 真正可以打开的地址。
   *
   * **不能自己拼 `http://127.0.0.1:<port>`**：开发服务器绑哪个地址是它自己决定的 ——
   * Vite 默认绑 `localhost`，在这台机器上解析成 `::1`（IPv6 回环），
   * 于是 `127.0.0.1:<port>` 是**连接被拒**（用户看到的就是"打不开、没启动"）。
   * 所以这里存的是"从输出里读到的、并且真的能连上的"那个地址。
   */
  url: string | null;
  /** 这个地址现在是否真的能连上（连不上就别给用户一个打不开的入口） */
  reachable: boolean;
  /** 退出码（被停止时是 null） */
  exitCode: number | null;
  /** 最近若干行输出（环形缓冲，新的在最后） */
  log: DevServerLogLine[];
}

export interface RunOverview {
  /** 这个项目能不能启动（纯管理项目不能 —— 界面上据此决定要不要显示按钮） */
  runnable: boolean;
  /** 认出来的目标（含"准备好了没有"） */
  targets: Array<Omit<RunTarget, 'values' | 'specId'> & { state: DevServerState | null }>;
  problems: string[];
}

/** 等 `taskkill` 的上限：超时就如实报「可能还在跑」，而不是一直转圈 */
const KILL_TIMEOUT_MS = 5000;

/** 输出保留多少行（够看清启动横幅与报错，又不至于把内存堆满） */
const MAX_LOG_LINES = 200;

interface RunningEntry {
  state: DevServerState;
  child: ChildProcess | null;
  /** 停止请求是否已经发出（避免"停止中"又被当成"运行中"） */
  stopping: boolean;
  /** 这次启动用的目标（停止后清理用） */
  target: RunTarget;
}

export interface DevServersOptions {
  /** 注入用：默认用 Node 的 `spawn`；单测里换成假的，就不必真的派生进程 */
  spawnFn?: typeof spawn;
}

export interface DevServers {
  /** 认出来的目标 + 当前状态（界面上按钮与状态都靠它） */
  overview(projectId: string): RunOverview;
  /** 启动（不传 role 就启动全部目标） */
  start(projectId: string, options?: { role?: 'frontend' | 'backend'; port?: number }): Promise<DevServerState[]>;
  /** 停止（不传 role 就停止全部） */
  stop(projectId: string, options?: { role?: 'frontend' | 'backend' }): Promise<DevServerState[]>;
  /** 某个项目当前的所有状态 */
  states(projectId: string): DevServerState[];
  /** 所有在跑的项目 id（项目卡片上的"运行中"标记用） */
  runningProjectIds(): string[];
  /** 应用退出时全部停掉（不留孤儿进程） */
  shutdown(): void;
  /** 供路由订阅输出/状态变化（界面轮询之外，日志页也能看到） */
  onEvent(listener: (event: { projectId: string; state: DevServerState }) => void): () => void;
}

/**
 * 从一行输出里认出开发服务器的地址（**纯函数**，单独导出是为了能单测）。
 *
 * 三个开发服务器的写法：
 * - Vite：`➜  Local:   http://localhost:5173/`
 * - uvicorn：`Uvicorn running on http://127.0.0.1:8000 (Press CTRL+C to quit)`
 * - Django：`Starting development server at http://127.0.0.1:8000/`
 *
 * 为什么必须从输出里读、不能自己拼：**端口可能被自动换掉**
 * （5173 被占时 Vite 会退到 5174），而且**绑哪个地址是它自己决定的**
 * （Vite 默认绑 `localhost`，在这台机器上解析成 `::1`，于是 127.0.0.1 连不上）。
 * `0.0.0.0` 归一成 `localhost` —— 那不是能给用户点的地址。
 */
export function parseDevServerUrl(line: string): { url: string; port: number } | null {
  const match = /https?:\/\/(\[[0-9a-f:]+\]|localhost|127\.0\.0\.1|0\.0\.0\.0)(?::(\d{2,5}))?/i.exec(
    line,
  );
  if (!match?.[1]) return null;
  const host = match[1].toLowerCase();
  const port = match[2] ? Number(match[2]) : null;
  if (port === null || Number.isNaN(port)) return null;
  const normalizedHost = host === '0.0.0.0' ? 'localhost' : host;
  return { url: `http://${normalizedHost}:${port}/`, port };
}

/**
 * 建一个开发服务器管理器。
 *
 * 状态**只放在内存里**：开发服务器是"这次运行期间的进程"，应用重启后它就不存在了
 * （把状态写进数据库反而会留下"界面上显示运行中、实际没有进程"的假状态）。
 */
export function createDevServers(ctx: ServiceContext, options: DevServersOptions = {}): DevServers {
  const spawnFn = options.spawnFn ?? spawn;
  const entries = new Map<string, RunningEntry>();
  const listeners = new Set<(event: { projectId: string; state: DevServerState }) => void>();

  const keyOf = (projectId: string, role: string): string => `${projectId}:${role}`;

  function emit(state: DevServerState): void {
    for (const listener of listeners) {
      try {
        listener({ projectId: state.projectId, state });
      } catch {
        // 订阅者出错不该影响进程管理
      }
    }
  }

  function resolveFolder(projectId: string, templateId: string): { dir: string; folder: string } {
    const project = getProjectOrThrow(ctx, projectId);
    const root = ctx.workspaceRoot;
    if (!root || !project.folder) {
      // 如实报，别猜路径
      throw new AppError('WORKSPACE_UNAVAILABLE', '这个项目还没有文件夹（没有工作区目录），无法启动', {
        details: { projectId },
      });
    }
    const folder = ensureProjectFolder(root, project.folder).path;
    void templateId;
    return { dir: folder, folder };
  }

  function targetsOf(projectId: string): { folder: string; targets: RunTarget[]; problems: string[] } {
    const project = getProjectOrThrow(ctx, projectId);
    const { folder } = resolveFolder(projectId, project.id);
    const detected = detectRunTargets(folder, project.codeKind);
    return { folder, targets: detected.targets, problems: detected.problems };
  }

  /**
   * 从输出里认出"它到底跑在哪个地址"。
   *
   * 三个开发服务器都会把地址打印出来，格式略有不同：
   * - Vite：`➜  Local:   http://localhost:5173/`
   * - uvicorn：`Uvicorn running on http://127.0.0.1:8000 (Press CTRL+C to quit)`
   * - Django：`Starting development server at http://127.0.0.1:8000/`
   *
   * 认出来就更新 `port` / `url`：**端口可能被自动换掉**（5173 被占时 Vite 会退到 5174），
   * 只有读它自己的输出才知道真话。`0.0.0.0` 换成 `localhost`（0.0.0.0 不是能给用户点的地址）。
   */
  function learnAddressFromLine(state: DevServerState, line: string): void {
    const parsed = parseDevServerUrl(line);
    if (!parsed) return;
    const portChanged = parsed.port !== state.port;
    state.port = parsed.port;
    state.url = parsed.url;
    if (portChanged) {
      pushLogRaw(state, 'system', `实际端口是 ${parsed.port}（配置里写的是别的值，界面按实际显示）`);
    }
  }

  /** 只写日志、不递归（learnAddressFromLine 会回调它） */
  function pushLogRaw(state: DevServerState, stream: DevServerLogLine['stream'], line: string): void {
    state.log.push({ ts: ctx.now(), stream, text: line });
    if (state.log.length > MAX_LOG_LINES) state.log.splice(0, state.log.length - MAX_LOG_LINES);
  }

  function pushLog(state: DevServerState, stream: DevServerLogLine['stream'], text: string): void {
    for (const raw of text.split(/\r?\n/)) {
      const line = raw.trimEnd();
      if (line.length === 0) continue;
      pushLogRaw(state, stream, line);
      // 输出里带着"它跑在哪个地址"——这是唯一可信的来源（端口可能被自动换掉）
      learnAddressFromLine(state, line);
    }
    emit(state);
  }

  /**
   * 探一次"这个地址真的能连上吗"。
   *
   * 连不上就不该给用户一个"在浏览器里打开"的入口 —— 那正是这次踩的坑：
   * 地址拼错了，用户点开是个错误页，现象是"没启动"，而我们这边显示得好好的。
   * 用 `node:http` 直接发一个 GET（不走外部命令、不走系统代理）。
   */
  function probeOnce(url: string, timeoutMs = 1500): Promise<boolean> {
    return new Promise((resolve) => {
      let settled = false;
      const done = (ok: boolean): void => {
        if (settled) return;
        settled = true;
        resolve(ok);
      };
      try {
        const request = httpGet(url, (response: IncomingMessage) => {
          response.resume();
          done(true);
        });
        request.on('error', () => done(false));
        request.setTimeout(timeoutMs, () => {
          request.destroy();
          done(false);
        });
      } catch {
        done(false);
      }
    });
  }

  /** 启动后持续探测（最多 60 秒），一旦通了就停 */
  async function watchReachability(state: DevServerState): Promise<void> {
    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline) {
      if (state.status !== 'running') return;
      // 每次都以"最新学到的地址"为准；还没学到就按端口试两种回环写法
      const candidates = [
        ...(state.url ? [state.url] : []),
        `http://localhost:${state.port}/`,
        `http://127.0.0.1:${state.port}/`,
        `http://[::1]:${state.port}/`,
      ];
      for (const candidate of candidates) {
        if (await probeOnce(candidate)) {
          state.url = candidate;
          state.reachable = true;
          pushLogRaw(state, 'system', `已确认可以访问：${candidate}`);
          emit(state);
          return;
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }

  function overview(projectId: string): RunOverview {
    const project = getProjectOrThrow(ctx, projectId);
    let detected: { folder: string; targets: RunTarget[]; problems: string[] };
    try {
      detected = targetsOf(projectId);
    } catch (error) {
      return {
        runnable: false,
        targets: [],
        problems: [error instanceof Error ? error.message : String(error)],
      };
    }

    return {
      // 纯管理项目没有代码：连"能不能启动"都是 false，界面据此不显示按钮
      runnable: project.codeKind !== null && detected.targets.length > 0,
      targets: detected.targets.map((target) => {
        // 值位（含包管理器路径等内部信息）不往界面送；templateId 要留着（"装依赖"按它决定装什么）
        const { values: _values, specId: _specId, ...rest } = target;
        void _values;
        void _specId;
        const entry = entries.get(keyOf(projectId, target.role));
        return { ...rest, state: entry ? { ...entry.state, log: [...entry.state.log] } : null };
      }),
      problems: detected.problems,
    };
  }

  async function start(
    projectId: string,
    options2: { role?: 'frontend' | 'backend'; port?: number } = {},
  ): Promise<DevServerState[]> {
    const { folder, targets } = targetsOf(projectId);
    const project = getProjectOrThrow(ctx, projectId);

    if (targets.length === 0) {
      throw new AppError(
        'VALIDATION_FAILED',
        `这个项目没有可启动的目标：${project.codeKind === null ? '纯管理项目不生成代码' : '没找到认得的入口'}`,
        { details: { projectId } },
      );
    }

    const selected = options2.role ? targets.filter((item) => item.role === options2.role) : targets;
    if (selected.length === 0) {
      throw new AppError('VALIDATION_FAILED', `这个项目没有「${options2.role}」这一侧`, {
        details: { projectId },
      });
    }

    const started: DevServerState[] = [];
    for (const target of selected) {
      const key = keyOf(projectId, target.role);
      const existing = entries.get(key);
      if (existing && existing.state.status !== 'stopped' && existing.state.status !== 'failed') {
        /*
         * 409 而不是 500：连点两次启动是**正常操作**，报"服务器内部错误，请点击查看日志"
         * 等于把用户的操作问题说成我们的故障（端到端里就是这么被抓住的）。
         */
        throw new AppError(
          'CONFLICT',
          `${target.role === 'frontend' ? '前端' : '后端'}已经在运行了（端口 ${existing.state.port}）`,
          { details: { projectId, role: target.role, port: existing.state.port } },
        );
      }

      // 依赖没装好就别启动 —— 报清楚原因，而不是让用户看一堆 "command not found"
      if (!target.ready) {
        throw new AppError('VALIDATION_FAILED', target.problem ?? '这个目标还不具备启动条件', {
          details: { projectId, role: target.role },
        });
      }

      const port = options2.port ?? target.port;
      const values = { ...target.values };
      if (target.specId === 'run-python-uvicorn' || target.specId === 'run-django-runserver') {
        values.port = String(port);
      }

      /*
       * Node 侧还要决定"用哪个包管理器"。
       *
       * 与"装依赖"那一步用**同一个**挑选逻辑（`pnpm → npm → yarn`，看机器上装了哪个）：
       * 两处各自挑一个的话，会出现"依赖是 pnpm 装的、启动却用 npm run"这种别扭组合。
       * 顺便拿到真实路径 —— Windows 上 pnpm/npm 都是 `.cmd` 批处理壳，
       * 不传它 `buildCommand` 就不知道该借 `cmd.exe` 执行（那是踩过的坑）。
       */
      let executePath: string | undefined;
      if (target.specId === 'run-node-dev') {
        // 第一个参数是「用户指定」：这里没有 → 传 undefined，让它按机器上装了什么挑
        const picked = pickPackageManager(undefined);
        values.pm = picked.pm;
        if (picked.path !== null) executePath = picked.path;
      }

      const built = buildCommand(target.specId, values, {
        ...(executePath !== undefined ? { executePath } : {}),
      });

      const state: DevServerState = {
        projectId,
        role: target.role,
        kindLabel: target.kindLabel,
        command: [built.bin, ...built.args].join(' '),
        dir: target.subdir.length > 0 ? join(folder, target.subdir) : folder,
        port,
        status: 'starting',
        pid: null,
        startedAt: ctx.now(),
        endedAt: null,
        error: null,
        exitCode: null,
        url: null,
        reachable: false,
        log: [],
      };
      const entry: RunningEntry = { state, child: null, stopping: false, target };
      entries.set(key, entry);
      emit(state);

      const cwd = state.dir;
      let child: ChildProcess;
      try {
        child = spawnFn(built.bin, built.args, {
          cwd,
          shell: false,
          windowsHide: true,
          // 输出按行读（开发服务器的启动横幅就是几行文本）
          stdio: ['ignore', 'pipe', 'pipe'],
        });
      } catch (error) {
        state.status = 'failed';
        state.error = error instanceof Error ? error.message : String(error);
        state.endedAt = ctx.now();
        emit(state);
        // 把原始错误挂上（`cause`）：排查时要看的是底层那句，不是我们包的一层
        throw new Error(`启动失败：${state.error}`, { cause: error });
      }

      entry.child = child;
      state.pid = child.pid ?? null;
      pushLog(state, 'system', `$ ${state.command}`);
      pushLog(state, 'system', `在 ${state.dir} 里启动（端口 ${port}）`);

      child.stdout?.on('data', (chunk: Buffer) => pushLog(state, 'stdout', chunk.toString('utf8')));
      child.stderr?.on('data', (chunk: Buffer) => pushLog(state, 'stderr', chunk.toString('utf8')));

      child.on('error', (error) => {
        state.status = 'failed';
        state.error = error.message;
        state.endedAt = ctx.now();
        pushLog(state, 'system', `进程出错：${error.message}`);
      });

      child.on('exit', (code, signal) => {
        state.exitCode = code;
        state.endedAt = ctx.now();
        state.pid = null;
        entry.child = null;
        if (entry.stopping) {
          state.status = 'stopped';
          pushLog(state, 'system', '已停止');
          return;
        }
        /*
         * 没点过停止却退出了 = 启动失败。
         * 开发服务器正常是**不会自己退出**的，所以这里一律按失败报，
         * 并把最后几行输出留着（原因通常就在里面：端口被占、语法错误、依赖缺失）。
         */
        state.status = 'failed';
        state.error =
          code === 0
            ? '进程自己退出了（开发服务器不该自己结束）—— 看下面的输出'
            : `进程退出，代码 ${code ?? '—'}${signal ? `（信号 ${signal}）` : ''}`;
        pushLog(state, 'system', state.error);
      });

      // 启动后一小段时间没有立刻退出，就认为"起来了"（成功与否以能不能跑住为准）
      state.status = 'running';
      emit(state);
      /*
       * 同时开始探测"这个地址真的能连上吗"。
       * 不 await：探测要几十秒（Vite 第一次要预构建依赖），不能把启动请求挂住。
       */
      void watchReachability(state).catch(() => undefined);
      ctx.logger.info(
        `开发服务器已启动：${target.kindLabel}（${target.role === 'frontend' ? '前端' : '后端'}）端口 ${port}`,
        { projectId, role: target.role, pid: state.pid, port, kind: target.kind },
      );
      started.push({ ...state, log: [...state.log] });
    }

    void project;
    return started;
  }

  async function stop(
    projectId: string,
    options2: { role?: 'frontend' | 'backend' } = {},
  ): Promise<DevServerState[]> {
    const result: DevServerState[] = [];
    for (const [key, entry] of entries) {
      if (entry.state.projectId !== projectId) continue;
      if (options2.role && entry.state.role !== options2.role) continue;
      if (entry.state.status === 'stopped') {
        result.push({ ...entry.state, log: [...entry.state.log] });
        continue;
      }

      entry.stopping = true;
      const pid = entry.state.pid;
      pushLog(entry.state, 'system', '正在停止…');

      if (pid !== null) {
        /*
         * 杀**整棵树**：`npm run dev` 真正在监听的是孙进程（node），
         * 只杀外层会留下占用端口的孤儿 —— 用户点过"停止"却起不来第二次。
         */
        const killCmd = buildCommand('kill-process-tree', { pid: String(pid) });
        /*
         * 等它有上限：`taskkill` 自己卡住时**不能**让停止请求永远挂着
         * （界面上就是"点了一直转圈"）。超时了就**如实报**"进程可能还在跑"，
         * 而不是照旧记成"已停止"—— 那会把"端口还被占着"变成一个查不出来的怪现象。
         */
        const killed = await new Promise<boolean>((resolve) => {
          let settled = false;
          const done = (ok: boolean): void => {
            if (settled) return;
            settled = true;
            resolve(ok);
          };
          const timer = setTimeout(() => done(false), KILL_TIMEOUT_MS);
          timer.unref?.();
          const killer = spawnFn(killCmd.bin, killCmd.args, { shell: false, windowsHide: true });
          killer.on('exit', () => {
            clearTimeout(timer);
            done(true);
          });
          killer.on('error', () => {
            clearTimeout(timer);
            done(true);
          });
        });

        if (!killed) {
          entry.state.status = 'failed';
          entry.state.error = `停止超时（${KILL_TIMEOUT_MS / 1000} 秒）：进程可能还在运行，端口可能还被占着`;
          entry.state.endedAt = ctx.now();
          pushLog(entry.state, 'system', entry.state.error);
          ctx.logger.warn('停止开发服务器超时', {
            projectId,
            role: entry.state.role,
            pid,
          });
          result.push({ ...entry.state, log: [...entry.state.log] });
          // 留在表里：状态是"可能还在跑"，用户还能再点一次停止
          continue;
        }
      } else {
        entry.child?.kill();
      }

      entry.state.status = 'stopped';
      entry.state.endedAt = ctx.now();
      entry.state.pid = null;
      entries.delete(key);
      ctx.logger.info('开发服务器已停止', { projectId, role: entry.state.role, pid });
      emit(entry.state);
      result.push({ ...entry.state, log: [...entry.state.log] });
    }
    return result;
  }

  function states(projectId: string): DevServerState[] {
    return [...entries.values()]
      .filter((entry) => entry.state.projectId === projectId)
      .map((entry) => ({ ...entry.state, log: [...entry.state.log] }));
  }

  function runningProjectIds(): string[] {
    const ids = new Set<string>();
    for (const entry of entries.values()) {
      if (entry.state.status === 'running' || entry.state.status === 'starting') {
        ids.add(entry.state.projectId);
      }
    }
    return [...ids];
  }

  function shutdown(): void {
    for (const [key, entry] of entries) {
      const pid = entry.state.pid;
      if (pid !== null) {
        // 同步杀：退出流程里没有时间等异步回调
        try {
          const killCmd = buildCommand('kill-process-tree', { pid: String(pid) });
          spawnFn(killCmd.bin, killCmd.args, { shell: false, windowsHide: true, detached: true }).unref();
        } catch {
          // 尽力而为：杀不掉也不该阻止应用退出
        }
      }
      entries.delete(key);
    }
  }

  return {
    overview,
    start,
    stop,
    states,
    runningProjectIds,
    shutdown,
    onEvent: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
