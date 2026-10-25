/**
 * 错误 → HTTP 响应 的统一映射。
 *
 * 三条原则：
 *
 * 1. **响应里永远带 traceId**。用户看到"出错了"却能一键跳到日志现场，
 *    靠的就是这个字段（见 technical-design §5.10）。
 * 2. **默认不回传堆栈**。堆栈里可能带工作区外的绝对路径与依赖内部结构；
 *    但堆栈**始终写入日志**，排查能力不受影响。
 * 3. **5xx 记 error、4xx 记 warn**。客户端参数写错不该被当成服务端故障，
 *    否则错误日志会被自己的校验失败刷满，真正的故障反而被淹没。
 */

import type { ApiFailure } from '@pm-studio/shared';
import { AppError, fail, isAppError } from '@pm-studio/shared';

export type ErrorLogLevel = 'warn' | 'error';

export interface MappedError {
  status: number;
  body: ApiFailure;
  logLevel: ErrorLogLevel;
  /** 供日志使用：完整信息（含堆栈），不会回传前端 */
  detail: string;
}

interface ValidationItem {
  instancePath?: string;
  path?: string;
  message?: string;
}

interface FastifyLikeError {
  statusCode?: number;
  code?: string;
  message?: string;
  stack?: string;
  validation?: ValidationItem[];
}

function asFastifyError(err: unknown): FastifyLikeError {
  if (typeof err === 'object' && err !== null) return err as FastifyLikeError;
  return { message: String(err) };
}

/** 状态码 → 错误码。没有对应项的一律按 500 处理，避免把未知错误说成"客户端问题" */
function codeForStatus(status: number): string {
  switch (status) {
    case 400:
      return 'VALIDATION_FAILED';
    case 401:
      return 'UNAUTHORIZED';
    case 403:
      return 'FORBIDDEN';
    case 404:
      return 'NOT_FOUND';
    case 409:
      return 'CONFLICT';
    case 413:
      return 'VALIDATION_FAILED';
    case 415:
      return 'VALIDATION_FAILED';
    case 423:
      return 'MAINTENANCE_MODE';
    default:
      return 'INTERNAL_ERROR';
  }
}

export function mapError(
  err: unknown,
  traceId: string,
  options: { exposeStack?: boolean } = {},
): MappedError {
  const raw = asFastifyError(err);
  const detail = raw.stack ?? raw.message ?? String(err);

  // 1) 业务错误：码与状态码由它自己决定
  if (isAppError(err)) {
    return {
      status: err.httpStatus,
      body: fail(err.code, err.message, { details: err.details, traceId }),
      logLevel: err.httpStatus >= 500 ? 'error' : 'warn',
      detail,
    };
  }

  // 2) 入参校验失败（Fastify + Zod 的固定形状）
  if (Array.isArray(raw.validation) && raw.validation.length > 0) {
    const details = raw.validation.map((item) => ({
      path: item.instancePath ?? item.path ?? '',
      message: item.message ?? '不符合要求',
    }));
    return {
      status: 400,
      body: fail('VALIDATION_FAILED', '参数校验失败', { details, traceId }),
      logLevel: 'warn',
      detail: `${raw.message ?? '参数校验失败'} :: ${JSON.stringify(details)}`,
    };
  }

  // 3) 某些校验集成会直接抛 ZodError，而不是包装成 Fastify 的 validation 形状。
  //    不认这一种，本该校验失败的请求就会被误报成 500。
  const issues = (err as { issues?: Array<{ path?: Array<string | number>; message?: string }> })
    .issues;
  if (Array.isArray(issues) && issues.length > 0) {
    const details = issues.map((issue) => ({
      path: (issue.path ?? []).join('.'),
      message: issue.message ?? '不符合要求',
    }));
    return {
      status: 400,
      body: fail('VALIDATION_FAILED', '参数校验失败', { details, traceId }),
      logLevel: 'warn',
      detail: `${raw.message ?? 'Zod 校验失败'} :: ${JSON.stringify(details)}`,
    };
  }

  // 4) Fastify 自己抛的 4xx（如 404、不支持的方法）
  const status = typeof raw.statusCode === 'number' ? raw.statusCode : 500;
  if (status >= 400 && status < 500) {
    return {
      status,
      body: fail(codeForStatus(status), raw.message ?? '请求无法处理', { traceId }),
      logLevel: 'warn',
      detail,
    };
  }

  // 5) 兜底：未预期错误。对外只说"内部错误"，细节留在日志里
  return {
    status: 500,
    body: fail('INTERNAL_ERROR', '服务器内部错误，请点击「查看日志」查看详情', {
      details: options.exposeStack ? { stack: raw.stack } : undefined,
      traceId,
    }),
    logLevel: 'error',
    detail,
  };
}

/** 便于测试与路由层复用：把任意异常包成 AppError 语义 */
export function asAppError(err: unknown, fallbackMessage = '未预期错误'): AppError {
  if (isAppError(err)) return err;
  const raw = asFastifyError(err);
  return new AppError('INTERNAL_ERROR', raw.message ?? fallbackMessage, { cause: err });
}
