/**
 * 渲染进程的 API 客户端。
 *
 * 三条职责，缺一不可：
 *
 * 1. **自动附加令牌**。内嵌服务要求 Bearer 鉴权，每个请求都要带。
 * 2. **拆统一响应包**。后端的成功/失败都是一个外层信封，这里拆成
 *    "返回数据"或"抛 ApiError"，让业务代码不必到处判 `ok`。
 * 3. **保住 traceId**。这是"点一下跳到日志现场"的渲染侧那一半 ——
 *    ApiError 上带着 traceId，界面上的错误提示就能直接给出跳转入口。
 */

export interface ApiErrorShape {
  code: string;
  message: string;
  details?: unknown;
  traceId?: string;
}

export class ApiError extends Error {
  readonly code: string;
  readonly status: number;
  readonly traceId: string | undefined;
  readonly details: unknown;

  constructor(status: number, shape: ApiErrorShape) {
    super(shape.message);
    this.name = 'ApiError';
    this.status = status;
    this.code = shape.code;
    this.traceId = shape.traceId;
    this.details = shape.details;
  }

  /** 供界面直接展示的一句话，包含可复制的 traceId */
  describe(): string {
    const base = `[${this.code}] ${this.message}`;
    return this.traceId ? `${base}（traceId: ${this.traceId}）` : base;
  }
}

export type HttpMethod = 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';

export interface RequestOptions {
  method?: HttpMethod;
  /**
   * 查询参数。
   *
   * 类型刻意用 `object` 而不是精确的 `Record<string, ...>`：调用方传的是
   * 各接口自己的参数接口（如 `TaskListQueryParams`），这些接口**没有索引签名**，
   * 无法赋给 `Record`。真正的类型约束在上层的接口函数签名里，
   * 这里只负责"把能变成字符串的值拼进 URL"。
   */
  query?: object;
  body?: unknown;
  signal?: AbortSignal;
}

export interface ApiClient {
  readonly baseUrl: string;
  request<T>(path: string, options?: RequestOptions): Promise<T>;
  get<T>(path: string, query?: object): Promise<T>;
  post<T>(path: string, body?: unknown, query?: object): Promise<T>;
  patch<T>(path: string, body?: unknown): Promise<T>;
  del<T>(path: string, query?: object): Promise<T>;
  /**
   * 建立 SSE 连接。
   *
   * 用 fetch + ReadableStream 而不是原生 EventSource：**EventSource 不支持
   * 自定义请求头**，那样令牌只能走查询参数（会留在 URL 里）。fetch 流式读取
   * 可以把令牌留在 Authorization 头里。
   */
  stream(path: string, query: object | undefined, signal: AbortSignal): Promise<Response>;
}

/**
 * 拼查询串。
 *
 * 只接受字符串 / 数字 / 布尔与它们的数组；其他类型（对象、函数…）
 * **跳过而不是塞进 URL** —— 否则会拼出 `?x=%5Bobject%20Object%5D` 这种
 * 服务端看不懂、排查时又很难定位的参数。
 */
function buildQuery(query?: object): string {
  if (!query) return '';
  const params = new URLSearchParams();

  for (const [key, raw] of Object.entries(query)) {
    if (raw === undefined || raw === null) continue;

    if (Array.isArray(raw)) {
      for (const item of raw) {
        if (item === undefined || item === null) continue;
        params.append(key, String(item));
      }
      continue;
    }

    const kind = typeof raw;
    if (kind === 'string' || kind === 'number' || kind === 'boolean') {
      params.append(key, String(raw));
    }
  }

  const text = params.toString();
  return text ? `?${text}` : '';
}

export function createApiClient(options: { baseUrl: string; token: string }): ApiClient {
  const request = async <T>(path: string, opts: RequestOptions = {}): Promise<T> => {
    const url = `${options.baseUrl}${path}${buildQuery(opts.query)}`;

    let response: Response;
    try {
      response = await fetch(url, {
        method: opts.method ?? 'GET',
        headers: {
          authorization: `Bearer ${options.token}`,
          ...(opts.body !== undefined ? { 'content-type': 'application/json' } : {}),
        },
        ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
        ...(opts.signal ? { signal: opts.signal } : {}),
      });
    } catch (error) {
      // 网络层失败没有 traceId，给一个明确的错误码，避免界面显示 undefined
      throw new ApiError(0, {
        code: 'NETWORK_UNREACHABLE',
        message: `无法连接内嵌服务：${error instanceof Error ? error.message : String(error)}`,
      });
    }

    const headerTraceId = response.headers.get('x-trace-id') ?? undefined;

    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      throw new ApiError(response.status, {
        code: 'INVALID_RESPONSE',
        message: '服务返回了非 JSON 响应',
        traceId: headerTraceId,
      });
    }

    if (typeof payload === 'object' && payload !== null && 'ok' in payload) {
      const envelope = payload as { ok: boolean; data?: T; error?: ApiErrorShape };
      if (envelope.ok) return envelope.data as T;
      throw new ApiError(response.status, {
        code: envelope.error?.code ?? 'UNKNOWN',
        message: envelope.error?.message ?? '请求失败',
        ...(envelope.error?.details !== undefined ? { details: envelope.error.details } : {}),
        // 响应体里的 traceId 优先（它就是给用户看的那个），退回响应头
        traceId: envelope.error?.traceId ?? headerTraceId,
      });
    }

    throw new ApiError(response.status, {
      code: 'INVALID_RESPONSE',
      message: '响应不符合统一信封格式',
      traceId: headerTraceId,
    });
  };

  return {
    baseUrl: options.baseUrl,
    request,
    get: (path, query) => request(path, { method: 'GET', ...(query ? { query } : {}) }),
    post: (path, body, query) => request(path, { method: 'POST', body, ...(query ? { query } : {}) }),
    patch: (path, body) => request(path, { method: 'PATCH', body }),
    del: (path, query) => request(path, { method: 'DELETE', ...(query ? { query } : {}) }),

    stream: async (path, query, signal) => {
      const url = `${options.baseUrl}${path}${buildQuery(query)}`;
      const response = await fetch(url, {
        headers: { authorization: `Bearer ${options.token}`, accept: 'text/event-stream' },
        signal,
      });
      if (!response.ok) {
        throw new ApiError(response.status, {
          code: 'STREAM_FAILED',
          message: `日志流建立失败（HTTP ${response.status}）`,
          traceId: response.headers.get('x-trace-id') ?? undefined,
        });
      }
      return response;
    },
  };
}
