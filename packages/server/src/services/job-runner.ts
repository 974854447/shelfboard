/**
 * 作业执行器（JobRunner，M4）。
 *
 * 负责"怎么排、怎么并发、怎么取消、怎么把日志与进度送到界面"，
 * 具体干什么由**注册进来的 handler** 决定（本包不内置任何 handler：
 * 环境自检由桌面端注册，脚手架/装依赖以后加在各自合适的地方）。
 *
 * ## 几条不肯让步的设计
 *
 * 1. **状态机只有一个写入口**。所有状态变化都经过这里，并且**结束时一定落一个终态**
 *    （`succeeded` / `failed` / `canceled`）—— 没有"跑着跑着就没人管了"的中间态。
 * 2. **日志批量落库**（每 500ms 或 50 行刷一次）。逐行写库在几万行输出的脚手架面前
 *    会把 SQLite 写爆，而"实时看到输出"靠的是内存缓冲 + SSE，不依赖落库速度。
 *    数据库这份是给**界面查询与诊断包**用的，文件那份（`logs/jobs/<id>.log`）是给
 *    "进程被强杀后整包取出"用的。
 * 3. **取消是真的杀掉**：`AbortController` 一路传到 `runCommand` → `execFile({ signal })`，
 *    子进程会被结束，而不是等它自己跑完（孙进程的清理见 commands.ts 的说明，留给脚手架那一步）。
 * 4. **崩溃恢复**：启动时把残留的 `queued` / `running` 标成 `interrupted`（见 jobs.ts），
 *    否则界面上会有一条永远不动的作业。
 * 5. **失败要说清是什么失败**：错误码 + 一句话。`canceled` 不是 `failed` ——
 *    用户自己按的取消，不该报成错误。
 */

import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import type { Logger } from '../logging/logger';
import type { CommandRunResult, RunCommandOptions } from './commands.js';
import { runCommand } from './commands.js';
import type { ServiceContext } from './context.js';
import {
  appendJobLogs,
  createJob,
  getJobOrThrow,
  isJobFinished,
  updateJob,
  type JobDto,
  type JobLogDto,
} from './jobs.js';

/* ------------------------------------------------------------------ */
/* handler 契约                                                        */
/* ------------------------------------------------------------------ */

export interface JobProgress {
  percent: number;
  phase?: string;
}

/** handler 拿到的"作业上下文"：它只能通过这里影响外界（日志、进度、子进程、取消） */
export interface JobContext {
  jobId: string;
  /**
   * 服务上下文（数据库、工作区根目录）。
   *
   * 作业可以**读**工作区数据（比如脚手架要拿到项目的文件夹名），
   * 但改业务数据仍然走各自的服务层 —— 作业不该绕过服务层直接改表。
   */
  ctx: ServiceContext;
  /** 取消信号：长时间循环里要**自己检查** `signal.aborted` */
  signal: AbortSignal;
  log(message: string, level?: JobLogDto['level']): void;
  progress(percent: number, phase?: string): void;
  /** 跑一条白名单命令（自动带上取消信号，并把命令与结果记进日志） */
  runCommand(
    specId: string,
    values?: Readonly<Record<string, string>>,
    options?: Omit<RunCommandOptions, 'exec'> & {
      /**
       * 不把 stdout/stderr 逐行写进日志。
       *
       * 用在"能力探测"这类命令上：`python -m venv --help` 会打印一大篇用法，
       * 记进日志只会把真正有用的几行淹掉。命令本身**照旧记一行**
       * （跑了什么、成功还是失败），所以日志不会变得不可信。
       */
      quiet?: boolean;
    },
  ): Promise<CommandRunResult>;
  /** 被取消时抛这个（runner 会落 `canceled` 而不是 `failed`） */
  throwIfCanceled(): void;
}

export class JobCanceledError extends Error {
  constructor(message = '作业已被取消') {
    super(message);
    this.name = 'JobCanceledError';
  }
}

export interface JobHandlerSpec {
  type: string;
  /** 标题由 payload 生成（例："环境自检" / "生成项目「我的站」"） */
  title: (payload: Record<string, unknown>) => string;
  /** 同一类型同时最多跑几个（install=1、scaffold/export=2，见技术设计 §5.3） */
  concurrency: number;
  /** 进度未知时按阶段权重估算的兜底上限，仅用于文档化；具体由 handler 自己报 */
  handler: (ctx: JobContext, payload: Record<string, unknown>) => Promise<Record<string, unknown> | void>;
  /**
   * 失败的作业能不能手动重试。默认能；"失败会留下半个目录"这类作业自己决定。
   */
  retryable?: boolean;
}

/* ------------------------------------------------------------------ */
/* 事件（给 SSE 用）                                                   */
/* ------------------------------------------------------------------ */

export type JobEvent =
  | { kind: 'job'; job: JobDto }
  | { kind: 'logs'; jobId: string; entries: JobLogDto[] };

/**
 * 作业事件的中转站（SSE 挂在它上面）。
 *
 * 刻意**不做节流**：日志批次已经是 runner 那边按 500ms / 50 行合并好的，
 * 这里再攒一层只会让"实时输出"变得不实时（日志页的广播器需要节流，是因为那边
 * 是逐条日志直推）。
 *
 * 订阅者上限：每个订阅者占一个长连接，不能无限增长。
 */
export interface JobEventHub {
  emit(event: JobEvent): void;
  subscribe(listener: (event: JobEvent) => void): () => void;
  subscriberCount(): number;
  close(): void;
}

export function createJobEventHub(maxSubscribers = 16): JobEventHub {
  const listeners = new Set<(event: JobEvent) => void>();

  return {
    emit(event): void {
      for (const listener of [...listeners]) {
        try {
          listener(event);
        } catch {
          // 订阅者坏掉（连接断了）→ 摘除，别拖累其他订阅者
          listeners.delete(listener);
        }
      }
    },
    subscribe(listener): () => void {
      if (listeners.size >= maxSubscribers) return () => {};
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    subscriberCount: () => listeners.size,
    close(): void {
      listeners.clear();
    },
  };
}

export interface JobRunnerOptions {
  ctx: ServiceContext;
  logger: Logger;
  /** 作业日志文件目录（`<id>.log`）。不传就不写文件（单测里省掉磁盘） */
  logDir?: string;
  handlers: readonly JobHandlerSpec[];
  /** 事件回调（SSE 广播挂在这上面） */
  onEvent?: (event: JobEvent) => void;
  /** 日志刷库的时间窗与行数阈值（测试里可以调小） */
  flushIntervalMs?: number;
  flushLines?: number;
  now?: () => number;
}

export interface JobRunner {
  /** 建作业并排队（立刻返回，不等它跑完） */
  enqueue(input: { type: string; payload?: Record<string, unknown> }): JobDto;
  /** 取消：运行中的真杀掉，排队中的直接从队列里拿走 */
  cancel(jobId: string): JobDto;
  /** 重试：把失败的作业**建成一条新作业**（不覆盖历史，便于对照两次输出） */
  retry(jobId: string): JobDto;
  /** 当前队列长度与运行中的数量（测试与界面读数用） */
  stats(): { queued: number; running: number };
  /** 等到队列跑空（测试用） */
  drain(): Promise<void>;
  /** 停止执行器：不再开新作业，并取消正在跑的（应用退出时用） */
  shutdown(): void;
  /** 注册表（界面展示"能做哪些作业"用） */
  handlerTypes(): Array<{ type: string; concurrency: number; retryable: boolean }>;
}

const DEFAULT_FLUSH_INTERVAL_MS = 500;
const DEFAULT_FLUSH_LINES = 50;

export function createJobRunner(options: JobRunnerOptions): JobRunner {
  const { ctx, logger } = options;
  const now = options.now ?? (() => ctx.now());
  const flushIntervalMs = options.flushIntervalMs ?? DEFAULT_FLUSH_INTERVAL_MS;
  const flushLines = options.flushLines ?? DEFAULT_FLUSH_LINES;

  const handlerByType = new Map(options.handlers.map((handler) => [handler.type, handler]));

  /** 排队中的作业 id（先进先出） */
  const queue: string[] = [];
  /** 正在跑的作业：id → 状态 */
  const running = new Map<string, { type: string; controller: AbortController }>();
  const waiters: Array<() => void> = [];
  let shuttingDown = false;

  const emit = (event: JobEvent): void => {
    try {
      options.onEvent?.(event);
    } catch (error) {
      // 广播坏了不能影响作业本身
      logger.warn('作业事件广播失败', { error });
    }
  };

  const resolveWaiters = (): void => {
    while (waiters.length > 0) waiters.shift()?.();
  };

  /* ---------------- 日志：内存缓冲 + 定期刷库 + 落文件 ---------------- */

  interface JobLogger {
    push(level: JobLogDto['level'], message: string): void;
    flush(): void;
  }

  function createJobLogger(jobId: string, logFile: string | null): JobLogger {
    let buffer: Array<{ level: JobLogDto['level']; message: string; ts: number }> = [];
    let timer: ReturnType<typeof setTimeout> | undefined;

    const flush = (): void => {
      if (timer) {
        clearTimeout(timer);
        timer = undefined;
      }
      if (buffer.length === 0) return;
      const batch = buffer;
      buffer = [];

      let created: JobLogDto[] = [];
      try {
        created = appendJobLogs(ctx, jobId, batch);
      } catch (error) {
        logger.warn('作业日志落库失败（作业继续跑）', { jobId, error });
      }

      if (logFile) {
        try {
          appendFileSync(logFile, `${batch.map((entry) => `[${new Date(entry.ts).toISOString()}] ${entry.level} ${entry.message}`).join('\n')}\n`, 'utf8');
        } catch (error) {
          logger.warn('作业日志写文件失败（作业继续跑）', { jobId, logFile, error });
        }
      }

      emit({ kind: 'logs', jobId, entries: created.length > 0 ? created : batch.map((entry, index) => ({ id: `${jobId}-${entry.ts}-${index}`, jobId, ts: entry.ts, level: entry.level, message: entry.message })) });
    };

    return {
      push(level, message): void {
        buffer.push({ level, message, ts: now() });
        if (buffer.length >= flushLines) {
          flush();
          return;
        }
        if (!timer) {
          timer = setTimeout(flush, flushIntervalMs);
          timer.unref?.();
        }
      },
      flush,
    };
  }

  /* ---------------- 执行一个作业 ---------------- */

  /**
   * 收尾写库时**不能把异常抛出去**：应用退出（或测试拆掉连接）之后数据库可能已经关了，
   * 而那时作业的收尾代码还在跑 —— 抛出去会变成 unhandled rejection，把进程搞脏。
   * 记一条警告足够了：作业本身的结果已经写进日志文件，界面上也会看到"已中断"。
   */
  function safeUpdateJob(jobId: string, patch: Parameters<typeof updateJob>[2]): JobDto | null {
    try {
      return updateJob(ctx, jobId, patch);
    } catch (error) {
      logger.warn('作业写库失败（数据库可能已经关闭）', { jobId, error });
      return null;
    }
  }

  /** 读一眼当前状态并广播（读不到就算了：退出过程中不值得再报一次错） */
  function emitCurrent(jobId: string): void {
    try {
      emit({ kind: 'job', job: getJobOrThrow(ctx, jobId) });
    } catch (error) {
      logger.warn('广播作业状态失败', { jobId, error });
    }
  }

  async function runJob(jobId: string): Promise<void> {
    // 可能在排队期间就被取消了
    const queued = getJobOrThrow(ctx, jobId);
    if (queued.status === 'canceled') return;

    const handler = handlerByType.get(queued.type);
    if (!handler) {
      safeUpdateJob(jobId, {
        status: 'failed',
        errorCode: 'NO_HANDLER',
        errorMessage: `没有注册「${queued.type}」这类作业的执行器`,
        finishedAt: now(),
      });
      emitCurrent(jobId);
      return;
    }

    const logFile = queued.logFile;
    if (logFile) {
      try {
        mkdirSync(dirname(logFile), { recursive: true });
        writeFileSync(logFile, '', 'utf8');
      } catch (error) {
        logger.warn('作业日志文件建不出来（作业继续跑）', { jobId, logFile, error });
      }
    }

    const jobLogger = createJobLogger(jobId, logFile);
    const controller = new AbortController();
    running.set(jobId, { type: queued.type, controller });

    const started = safeUpdateJob(jobId, {
      status: 'running',
      startedAt: now(),
      phase: '开始',
      percent: 0,
    });
    if (started) emit({ kind: 'job', job: started });

    const jobCtx: JobContext = {
      jobId,
      ctx,
      signal: controller.signal,
      log: (message, level = 'info') => jobLogger.push(level, message),
      progress: (percent, phase) => {
        const updated = safeUpdateJob(jobId, {
          percent,
          ...(phase !== undefined ? { phase } : {}),
        });
        if (updated) emit({ kind: 'job', job: updated });
      },
      runCommand: async (specId, values = {}, commandOptions = {}) => {
        const { quiet, ...execOptions } = commandOptions;
        const result = await runCommand(specId, values, {
          ...execOptions,
          signal: controller.signal,
        });
        jobLogger.push(
          result.ok ? 'info' : result.canceled ? 'warn' : 'error',
          `$ ${result.bin} ${result.args.join(' ')} → ${result.ok ? 'ok' : result.canceled ? '已取消' : `失败（退出码 ${result.code ?? '—'}）`}`,
        );
        if (quiet !== true) {
          for (const line of `${result.stdout}\n${result.stderr}`.split('\n')) {
            const trimmed = line.trim();
            if (trimmed.length > 0) jobLogger.push(result.ok ? 'info' : 'error', `  ${trimmed}`);
          }
        }
        return result;
      },
      throwIfCanceled: () => {
        if (controller.signal.aborted) throw new JobCanceledError();
      },
    };

    try {
      const payload = queued.payload ?? {};
      const result = (await handler.handler(jobCtx, payload)) ?? undefined;
      jobLogger.flush();

      if (controller.signal.aborted) {
        // handler 正常返回了，但期间用户按了取消 → 以"已取消"收尾
        safeUpdateJob(jobId, { status: 'canceled', phase: '已取消', finishedAt: now() });
        emitCurrent(jobId);
        return;
      }

      safeUpdateJob(jobId, {
        status: 'succeeded',
        percent: 100,
        phase: '已完成',
        finishedAt: now(),
        ...(result !== undefined ? { result } : {}),
      });
      emitCurrent(jobId);
    } catch (error) {
      jobLogger.flush();
      const canceled = error instanceof JobCanceledError || controller.signal.aborted;
      const message = error instanceof Error ? error.message : String(error);

      safeUpdateJob(jobId, {
        status: canceled ? 'canceled' : 'failed',
        phase: canceled ? '已取消' : '失败',
        finishedAt: now(),
        errorCode: canceled ? 'CANCELED' : 'JOB_FAILED',
        errorMessage: message,
      });
      jobLogger.push(canceled ? 'warn' : 'error', canceled ? `作业已取消：${message}` : `作业失败：${message}`);
      jobLogger.flush();
      emitCurrent(jobId);

      if (!canceled) logger.warn('作业失败', { jobId, type: queued.type, error: message });
    } finally {
      running.delete(jobId);
      resolveWaiters();
      schedulePump();
    }
  }

  /* ---------------- 排队与并发 ---------------- */

  function canStart(type: string): boolean {
    const spec = handlerByType.get(type);
    const limit = Math.max(1, spec?.concurrency ?? 1);
    let active = 0;
    for (const item of running.values()) {
      if (item.type === type) active += 1;
    }
    return active < limit;
  }

  function pump(): void {
    if (shuttingDown) return;

    let index = 0;
    while (index < queue.length) {
      const jobId = queue[index];
      if (jobId === undefined) break;

      const row = getJobOrThrow(ctx, jobId);
      if (isJobFinished(row.status)) {
        queue.splice(index, 1);
        continue;
      }
      if (!canStart(row.type)) {
        index += 1;
        continue;
      }

      queue.splice(index, 1);
      void runJob(jobId);
    }
  }

  /**
   * 把 `pump` 推到下一个事件循环再跑。
   *
   * 为什么不直接调用：`enqueue` 要立刻把"**排队中**的作业"还给调用方（HTTP 路由把它
   * 返回给界面），而 `runJob` 在第一个 await 之前是同步的（建日志文件、写状态、发事件）——
   * 同步启动会让 `enqueue` 返回一个已经"进行中"的作业，请求线程也被顺带占住。
   */
  function schedulePump(): void {
    const timer = setTimeout(() => pump(), 0);
    timer.unref?.();
  }

  /* ---------------- 对外 API ---------------- */

  function enqueue(input: { type: string; payload?: Record<string, unknown> }): JobDto {
    const spec = handlerByType.get(input.type);
    if (!spec) {
      throw new Error(`没有注册「${input.type}」这类作业的执行器`);
    }
    if (shuttingDown) {
      throw new Error('应用正在退出，暂时不能新建作业');
    }

    const payload = input.payload ?? {};
    // 先自己生成 id：日志文件名要用它，而"先建行、再改名"会多一次写库
    const id = ctx.newId();
    const job = createJob(ctx, {
      id,
      type: input.type,
      title: spec.title(payload),
      payload,
      ...(options.logDir !== undefined ? { logFile: join(options.logDir, `${id}.log`) } : {}),
    });

    queue.push(job.id);
    emit({ kind: 'job', job });
    schedulePump();
    return getJobOrThrow(ctx, job.id);
  }

  function cancel(jobId: string): JobDto {
    const row = getJobOrThrow(ctx, jobId);
    if (isJobFinished(row.status)) return row;

    const active = running.get(jobId);
    if (active) {
      active.controller.abort();
      // 状态由 runJob 的收尾逻辑落（它会落 canceled），这里只记一条日志
      logger.info('用户取消了作业', { jobId, type: row.type });
      return getJobOrThrow(ctx, jobId);
    }

    const index = queue.indexOf(jobId);
    if (index >= 0) queue.splice(index, 1);
    const canceled = safeUpdateJob(jobId, {
      status: 'canceled',
      phase: '已取消',
      errorCode: 'CANCELED',
      errorMessage: '在开始之前被取消',
      finishedAt: now(),
    });
    emitCurrent(jobId);
    return canceled ?? row;
  }

  function retry(jobId: string): JobDto {
    const row = getJobOrThrow(ctx, jobId);
    if (!isJobFinished(row.status)) {
      throw new Error('这个作业还在跑，不能重试');
    }
    const spec = handlerByType.get(row.type);
    if (spec?.retryable === false) {
      throw new Error(`「${row.title}」不支持重试`);
    }
    return enqueue({
      type: row.type,
      payload: { ...(row.payload ?? {}), retryOf: row.id },
    });
  }

  function stats(): { queued: number; running: number } {
    return { queued: queue.length, running: running.size };
  }

  /**
   * 等队列跑空。
   *
   * 两种唤醒都要有：正常的收尾会 `resolveWaiters()`；50ms 的轮询是兜底，
   * 免得某次唤醒漏了（例如 handler 自己吞掉了异常）把调用方永远挂住。
   * 超时上限是为了让"作业卡死"表现为一条明确的测试失败，而不是测试进程挂着不动。
   */
  async function drain(timeoutMs = 30_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (queue.length > 0 || running.size > 0) {
      if (Date.now() > deadline) {
        throw new Error(`等待作业跑空超时（还有 ${queue.length} 个排队 / ${running.size} 个在跑）`);
      }
      await new Promise<void>((resolve) => {
        waiters.push(resolve);
        const timer = setTimeout(resolve, 50);
        timer.unref?.();
      });
    }
  }

  function shutdown(): void {
    shuttingDown = true;
    for (const [jobId, active] of [...running]) {
      active.controller.abort();
      logger.info('应用退出，取消作业', { jobId });
    }
    queue.length = 0;
    resolveWaiters();
  }

  return {
    enqueue,
    cancel,
    retry,
    stats,
    drain,
    shutdown,
    handlerTypes: () =>
      options.handlers.map((handler) => ({
        type: handler.type,
        concurrency: handler.concurrency,
        retryable: handler.retryable !== false,
      })),
  };
}
