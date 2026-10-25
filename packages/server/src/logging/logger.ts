/**
 * 统一日志入口。
 *
 * 设计要点（见 technical-design §5.10）：
 *
 * 1. **唯一入口**。四个来源（main / api / job / renderer）共用这一条管道。
 *    禁止任何模块直接 `console.log` —— 否则日志必然散落各处，
 *    而**脱敏也必然被绕过**。ESLint 规则负责拦截。
 * 2. **脱敏在管道内自动发生**，调用方无需（也无法）自己决定要不要脱敏。
 * 3. **绝不抛异常**。日志系统自己崩掉是最糟的失败模式：任何 sink 出错
 *    都被吞掉并计数，绝不影响业务流程。
 * 4. **sink 可插拔**：文本文件、SQLite、SSE 广播、控制台各是一个 sink，
 *    logger 只负责构造条目与派发。
 * 5. **派生 logger 共享同一份可变状态**。`child()` 出来的 logger 必须与父
 *    logger 看到同一个 sink 列表和同一个级别 —— 否则运行时把级别切到 debug
 *    只会对一部分日志生效，排查时会被严重误导。
 */

import type { AppLogEntry, LogContext, LogLevel, LogSource } from '@pm-studio/shared';
import { LOG_LEVEL_WEIGHT } from '@pm-studio/shared';

import { redactDetail, redactText, type RedactOptions } from './redact';
import { newLogId } from './trace';

export interface LogSink {
  /** 必须同步返回；内部要缓冲就自己缓冲，不要在这里 await */
  write(entry: AppLogEntry): void;
  flush?(): Promise<void> | void;
  close?(): Promise<void> | void;
}

export interface LoggerOptions {
  source: LogSource;
  /** 低于该级别的日志直接丢弃，默认 info */
  minLevel?: LogLevel;
  /** 模块名，如 'scaffold' / 'workspace.migrate' */
  scope?: string;
  /** 默认上下文，会被单条日志的 ctx 覆盖 */
  context?: LogContext;
  sinks?: readonly LogSink[];
  redact?: RedactOptions;
  /** 注入时间与 id 生成，便于测试 */
  now?: () => number;
  idFactory?: () => string;
}

export interface Logger {
  readonly source: LogSource;
  readonly scope: string | undefined;
  readonly minLevel: LogLevel;

  log(level: LogLevel, message: string, detail?: unknown, ctx?: LogContext): AppLogEntry | undefined;
  error(message: string, detail?: unknown, ctx?: LogContext): AppLogEntry | undefined;
  warn(message: string, detail?: unknown, ctx?: LogContext): AppLogEntry | undefined;
  info(message: string, detail?: unknown, ctx?: LogContext): AppLogEntry | undefined;
  debug(message: string, detail?: unknown, ctx?: LogContext): AppLogEntry | undefined;

  /** 派生一个带作用域的子 logger，共享 sink、级别与错误计数 */
  child(scope: string, ctx?: LogContext): Logger;
  setMinLevel(level: LogLevel): void;
  addSink(sink: LogSink): void;

  flush(): Promise<void>;
  close(): Promise<void>;
  /** sink 抛异常的累计次数 —— 正常应恒为 0，用于自检 */
  sinkErrorCount(): number;
}

/**
 * 派生 logger 之间共享的可变状态。
 *
 * 这个对象**不是**公开 API 的一部分（不出现在 LoggerOptions 里），
 * 只由 `createLogger` 建立、由 `child()` 原样传递。
 */
interface SharedState {
  sinks: LogSink[];
  minLevel: LogLevel;
  sinkErrors: number;
}

export function createLogger(options: LoggerOptions): Logger {
  return buildLogger(options, {
    sinks: [...(options.sinks ?? [])],
    minLevel: options.minLevel ?? 'info',
    sinkErrors: 0,
  });
}

function buildLogger(options: LoggerOptions, state: SharedState): Logger {
  const now = options.now ?? (() => Date.now());
  const idFactory = options.idFactory ?? (() => newLogId(now()));
  const scope = options.scope;
  const baseContext: LogContext = { ...options.context };

  const isEnabled = (level: LogLevel): boolean =>
    LOG_LEVEL_WEIGHT[level] >= LOG_LEVEL_WEIGHT[state.minLevel];

  const log = (
    level: LogLevel,
    message: string,
    detail?: unknown,
    ctx?: LogContext,
  ): AppLogEntry | undefined => {
    if (!isEnabled(level)) return undefined;

    const merged: LogContext = { ...baseContext, ...ctx };

    // 构造条目这一步也在 try 内：脱敏函数本身已经做了兜底，
    // 但这里再包一层，确保「日志系统自身出错」永远不会冒泡到业务代码。
    let entry: AppLogEntry;
    try {
      entry = {
        id: idFactory(),
        ts: now(),
        level,
        // 允许调用方覆盖来源（目前唯一用途：渲染进程异常经 API 上报）
        source: merged.source ?? options.source,
        scope: merged.scope ?? scope ?? null,
        message: redactText(String(message), options.redact),
        detail: redactDetail(detail, options.redact),
        traceId: merged.traceId ?? null,
        jobId: merged.jobId ?? null,
        requestId: merged.requestId ?? null,
        redacted: true,
      };
    } catch {
      return undefined;
    }

    for (const sink of state.sinks) {
      try {
        sink.write(entry);
      } catch {
        state.sinkErrors += 1;
      }
    }

    return entry;
  };

  return {
    source: options.source,
    scope,
    get minLevel(): LogLevel {
      return state.minLevel;
    },

    log,
    error: (message, detail, ctx) => log('error', message, detail, ctx),
    warn: (message, detail, ctx) => log('warn', message, detail, ctx),
    info: (message, detail, ctx) => log('info', message, detail, ctx),
    debug: (message, detail, ctx) => log('debug', message, detail, ctx),

    child(childScope: string, ctx?: LogContext): Logger {
      // 关键：把 state 原样传下去，而不是重新建一份。
      return buildLogger(
        { ...options, scope: childScope, context: { ...baseContext, ...ctx } },
        state,
      );
    },

    setMinLevel(level: LogLevel): void {
      state.minLevel = level;
    },

    addSink(sink: LogSink): void {
      state.sinks.push(sink);
    },

    async flush(): Promise<void> {
      for (const sink of state.sinks) {
        try {
          await sink.flush?.();
        } catch {
          state.sinkErrors += 1;
        }
      }
    },

    async close(): Promise<void> {
      for (const sink of state.sinks) {
        try {
          await sink.close?.();
        } catch {
          state.sinkErrors += 1;
        }
      }
    },

    sinkErrorCount: () => state.sinkErrors,
  };
}

/** 开发期用的控制台 sink；生产环境不挂（日志落文件与库即可） */
export function createConsoleSink(): LogSink {
  return {
    write(entry: AppLogEntry): void {
      const time = new Date(entry.ts).toISOString();
      const tag = `[${time}] ${entry.level.toUpperCase()} ${entry.source}${entry.scope ? `:${entry.scope}` : ''}`;
      const line = `${tag} ${entry.message}${entry.traceId ? ` (trace ${entry.traceId})` : ''}`;
      // 用 console 而非 stdout.write：这是唯一允许出现 console 的地方
      if (entry.level === 'error') console.error(line, entry.detail ?? '');
      else if (entry.level === 'warn') console.warn(line, entry.detail ?? '');
      else console.log(line, entry.detail ?? '');
    },
  };
}
