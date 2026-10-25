/**
 * 统一错误码。
 *
 * 前端按 `code` 做提示与分支，不解析 message —— 这样改文案不会破坏逻辑。
 * HTTP 状态码与数据模型文档 §5 保持一致。
 */

export const ERROR_STATUS = {
  VALIDATION_FAILED: 400,
  /** 本地嵌服务的一次性 Bearer Token 校验失败 */
  UNAUTHORIZED: 401,
  /** 有身份但无权做这件事（远程模式的 RBAC 会用到） */
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  CONFLICT: 409,
  DEPENDENCY_CYCLE: 409,
  MAINTENANCE_MODE: 423,
  WORKSPACE_UNAVAILABLE: 409,
  DISK_SPACE_INSUFFICIENT: 507,
  FILE_LOCKED: 409,
  ENV_TOOL_MISSING: 424,
  JOB_ALREADY_RUNNING: 409,
  JOB_CANCELED: 499,
  COMMAND_NOT_ALLOWED: 403,
  PATH_OUT_OF_SCOPE: 403,
  INTERNAL_ERROR: 500,
} as const;

export type ErrorCode = keyof typeof ERROR_STATUS;

export function isErrorCode(value: unknown): value is ErrorCode {
  return typeof value === 'string' && value in ERROR_STATUS;
}

export interface AppErrorOptions {
  /** 结构化细节会原样返回给前端，**不得放入机密** */
  details?: unknown;
  cause?: unknown;
  traceId?: string;
}

/**
 * 业务错误。所有可预期的失败都应抛这个，而不是裸 Error ——
 * 统一错误中间件靠它决定 HTTP 状态码、错误码与是否记 error 级日志。
 */
export class AppError extends Error {
  readonly code: ErrorCode;
  readonly httpStatus: number;
  readonly details: unknown;
  traceId: string | undefined;

  constructor(code: ErrorCode, message: string, options: AppErrorOptions = {}) {
    super(message, options.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = 'AppError';
    this.code = code;
    this.httpStatus = ERROR_STATUS[code];
    this.details = options.details;
    this.traceId = options.traceId;
  }

  static notFound(message = '资源不存在', options?: AppErrorOptions): AppError {
    return new AppError('NOT_FOUND', message, options);
  }

  static validation(message = '参数校验失败', options?: AppErrorOptions): AppError {
    return new AppError('VALIDATION_FAILED', message, options);
  }

  static conflict(message = '资源冲突', options?: AppErrorOptions): AppError {
    return new AppError('CONFLICT', message, options);
  }
}

export function isAppError(value: unknown): value is AppError {
  return value instanceof AppError;
}
