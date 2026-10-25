/**
 * id 生成：traceId / requestId / logId。
 *
 * 存在的意义：让「用户看到的错误提示」和「日志里的一堆行」能对得上号。
 * 没有它，日志查看器就只是把文件搬到界面上（见 technical-design §5.10）。
 *
 * 刻意不依赖 ulid/nanoid 等第三方包 —— 这个模块被日志管道的最底层引用，
 * 依赖越少越好，`node:crypto` 足够。
 *
 * 所有 id 都是「前缀 + base36 时间戳 + 随机 hex」，因此天然按时间聚集，
 * 用于 SQLite 主键时索引局部性也好。
 */

import { randomBytes } from 'node:crypto';

export const TRACE_ID_PREFIX = 'tr_';
export const LOG_ID_PREFIX = 'lg_';

const TRACE_ID_PATTERN = /^tr_[0-9a-z]+_[0-9a-f]{10}$/;

/** 时间戳转 base36；非有限值（NaN / ±Infinity）会让 toString(36) 产出
 *  "NaN"、"Infinity" 这类**大写**字符串，生成出通不过校验的畸形 id，
 *  所以一律退回当前时间。 */
function timePart(now: number): string {
  const base = Number.isFinite(now) ? Math.floor(now) : Date.now();
  return Math.max(0, base).toString(36);
}

function buildId(prefix: string, now: number): string {
  return `${prefix}${timePart(now)}_${randomBytes(5).toString('hex')}`;
}

/**
 * 生成 traceId：`tr_<base36 时间戳>_<10 位随机 hex>`
 *
 * 带时间戳前缀是有意为之：日志按 traceId 排序时天然按时间聚集，
 * 排查时肉眼就能看出先后顺序。
 */
export function newTraceId(now: number = Date.now()): string {
  return buildId(TRACE_ID_PREFIX, now);
}

export function isTraceId(value: unknown): value is string {
  return typeof value === 'string' && TRACE_ID_PATTERN.test(value);
}

/** 请求级 id，与 traceId 同构，便于统一处理 */
export function newRequestId(now: number = Date.now()): string {
  return buildId(TRACE_ID_PREFIX, now);
}

/**
 * 日志条目主键（app_logs.id）。
 *
 * 用时间有序 id 而非 UUIDv4：日志表是纯写入型的，时间有序主键能让
 * B-tree 索引只在一端增长，避免随机写入导致的页分裂。
 */
export function newLogId(now: number = Date.now()): string {
  return buildId(LOG_ID_PREFIX, now);
}

/**
 * 从入站请求头里取 traceId。
 *
 * 只接受格式合法的值：外部传入的任意字符串如果被直接写进日志，
 * 会变成注入点（例如塞进换行符伪造日志行）。取不到就返回 undefined，
 * 由调用方生成新的。
 */
export function normalizeTraceId(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined;
  const trimmed = raw.trim();
  if (trimmed.length > 64) return undefined;
  return isTraceId(trimmed) ? trimmed : undefined;
}
