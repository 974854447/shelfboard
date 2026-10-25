import type { LogLevel, LogSource } from './constants.js';

/** 一条应用日志（对应 app_logs 表的一行） */
export interface AppLogEntry {
  id: string;
  /** Unix 毫秒 */
  ts: number;
  level: LogLevel;
  source: LogSource;
  /** 模块名，如 'scaffold' / 'workspace.migrate' */
  scope: string | null;
  message: string;
  /** 堆栈或上下文 JSON —— **写入前必已过脱敏管道** */
  detail: string | null;
  traceId: string | null;
  jobId: string | null;
  requestId: string | null;
  /** 恒为 true：留这个字段是为了让"未脱敏"在数据层面可被断言发现 */
  redacted: boolean;
}

/** 写日志时由调用方提供的关联信息 */
export interface LogContext {
  traceId?: string;
  jobId?: string;
  requestId?: string;
  scope?: string;
  /**
   * 覆盖日志来源。
   *
   * 存在的理由只有一个：**渲染进程的异常是通过 API 上报的**，
   * 而处理该请求的 logger 的 source 是 `api`。若不覆盖，前端错误会被
   * 记成后端错误，日志按来源分区就失去意义（排查时会去翻错的那一堆）。
   *
   * 这是唯一的例外场景，其余地方都应让 source 保持由 logger 决定。
   */
  source?: LogSource;
}

/** 日志查询条件（对应 GET /logs） */
export interface LogQuery {
  level?: LogLevel;
  /** 只要该级别及以上 */
  minLevel?: LogLevel;
  source?: LogSource;
  scope?: string;
  from?: number;
  to?: number;
  q?: string;
  traceId?: string;
  jobId?: string;
  page?: number;
  pageSize?: number;
}

/** 统一响应包 */
export type ApiSuccess<T> = { ok: true; data: T };
export type ApiFailure = {
  ok: false;
  error: { code: string; message: string; details?: unknown; traceId?: string };
};
export type ApiResponse<T> = ApiSuccess<T> | ApiFailure;
