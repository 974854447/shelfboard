/**
 * 实体主键生成。
 *
 * 形态：`<base36 时间戳（定宽 9）><16 位随机 hex>`
 *
 * 为什么不用 UUIDv4：主键是 SQLite 的 B-tree 键。随机主键会让插入落在
 * 索引的任意位置，长期造成页分裂与写放大；时间有序主键只在一端增长。
 * 定宽补零是为了让**字典序等同于时间序**，否则 "z" > "10" 这种长度差
 * 会让排序错乱。
 *
 * 为什么不用 `ulid` 包：这个函数处于几乎每个服务的最底层，
 * 依赖越少越好，`node:crypto` 完全够用。
 */

import { randomBytes } from 'node:crypto';

/** base36 下 9 位可表示到约 1.0e14 毫秒（公元 5138 年），足够 */
const TIME_WIDTH = 9;
const RANDOM_BYTES = 8;

function timePart(now: number): string {
  // 非有限值（NaN / ±Infinity）会让 toString(36) 产出 "NaN"、"Infinity"
  // 这类大写字符串，破坏"字典序即时间序"的前提
  const base = Number.isFinite(now) ? Math.floor(now) : Date.now();
  return Math.max(0, base).toString(36).padStart(TIME_WIDTH, '0');
}

export function newEntityId(now: number = Date.now()): string {
  return `${timePart(now)}${randomBytes(RANDOM_BYTES).toString('hex')}`;
}

/** 校验一个字符串是否是本方案生成的主键 */
export function isEntityId(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    new RegExp(`^[0-9a-z]{${TIME_WIDTH}}[0-9a-f]{${RANDOM_BYTES * 2}}$`).test(value)
  );
}
