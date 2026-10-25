/**
 * 内嵌服务的运行时配置。
 *
 * 所有会影响安全边界的值（令牌、允许来源、是否回传堆栈）都集中在这里，
 * 便于审计：想知道"服务对外的口子有多大"，看这一个接口就够了。
 */

export interface ServerConfig {
  /**
   * 一次性访问令牌，**每次启动重新生成**。
   *
   * 为什么必须要有：服务虽然只绑 127.0.0.1，但本机上**任何进程**都能访问
   * 这个端口。没有令牌，等于把工作区数据库连同里面的全部项目数据
   * 开放给机器上任何一个程序。
   */
  authToken: string;

  /** API 前缀。该前缀之下的一切请求都要求鉴权 */
  apiPrefix: string;

  /**
   * 允许的跨源来源。仅开发环境需要（Vite dev server 与 API 不同源）；
   * 生产环境渲染层由本服务提供静态资源，天然同源，留空即可。
   */
  allowedOrigins: readonly string[];

  /** 是否记录每条请求的访问日志 */
  logRequests: boolean;

  /** 超过该耗时（毫秒）的请求记为 warn，用于发现性能劣化 */
  slowRequestMs: number;

  /**
   * 是否把错误堆栈回传前端。默认关闭 —— 堆栈可能包含工作区外的绝对路径、
   * 依赖内部结构等信息。本地开发可临时打开。
   * 注意：**无论开关如何，堆栈始终写入日志**，排查不受影响。
   */
  exposeErrorStack: boolean;
}

export interface ServerConfigInput {
  authToken: string;
  apiPrefix?: string;
  allowedOrigins?: readonly string[];
  logRequests?: boolean;
  slowRequestMs?: number;
  exposeErrorStack?: boolean;
}

export const DEFAULT_API_PREFIX = '/api/v1';

export function defaultServerConfig(input: ServerConfigInput): ServerConfig {
  return {
    authToken: input.authToken,
    apiPrefix: input.apiPrefix ?? DEFAULT_API_PREFIX,
    allowedOrigins: input.allowedOrigins ?? [],
    logRequests: input.logRequests ?? true,
    slowRequestMs: input.slowRequestMs ?? 1000,
    exposeErrorStack: input.exposeErrorStack ?? false,
  };
}
