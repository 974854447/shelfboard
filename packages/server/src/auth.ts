/**
 * 访问令牌校验。
 *
 * 两个细节值得说明：
 *
 * 1. **用 `timingSafeEqual` 而不是 `===`**。字符串比较会在第一个不同字符处
 *    提前返回，攻击者可以通过响应时间逐字节猜出令牌。本地场景下这看似
 *    多余，但机器上任何进程都能反复请求，成本极低而收益明确。
 * 2. **长度不同也要做一次比较**。直接 `return false` 会让"长度对不对"
 *    从耗时上暴露出来。
 */

import { timingSafeEqual } from 'node:crypto';

/** 从 `Authorization: Bearer xxx` 中取出令牌 */
export function extractBearerToken(header: unknown): string | undefined {
  if (typeof header !== 'string') return undefined;
  const matched = /^Bearer\s+(.+)$/i.exec(header.trim());
  const token = matched?.[1]?.trim();
  return token && token.length > 0 ? token : undefined;
}

/** 定长比较，避免时序侧信道 */
export function safeCompare(provided: string, expected: string): boolean {
  const a = Buffer.from(provided, 'utf8');
  const b = Buffer.from(expected, 'utf8');

  if (a.length !== b.length) {
    // 仍然走一次比较，把"长度不等"这件事从耗时上抹平
    timingSafeEqual(a, a);
    return false;
  }
  return timingSafeEqual(a, b);
}

/** 该请求是否需要鉴权：API 前缀之下的一切请求都需要 */
export function requiresAuth(url: string, apiPrefix: string): boolean {
  const path = url.split('?')[0] ?? url;
  return path.startsWith(apiPrefix);
}

/**
 * 从查询串里取令牌。
 *
 * 为什么需要这条路：浏览器的 `EventSource` **不支持自定义请求头**，
 * 因此 SSE 无法用 `Authorization` 带令牌。服务端在这里开一个查询参数口子，
 * 前端默认仍走 `fetch` 流式读取（令牌留在头里），只有在用 `EventSource`
 * 时才退化为查询参数。
 *
 * 安全性说明：查询参数会进入 URL，而 URL 会进入访问日志 ——
 * 但日志管道的脱敏规则本来就会把 `token=<值>` 替换为 `***`，
 * 所以不会因此泄露。这一点有对应的单元测试覆盖。
 */
export function extractTokenFromUrl(url: string, paramName = 'token'): string | undefined {
  const queryIndex = url.indexOf('?');
  if (queryIndex < 0) return undefined;
  const params = new URLSearchParams(url.slice(queryIndex + 1));
  const value = params.get(paramName);
  return value && value.length > 0 ? value : undefined;
}
