import { describe, expect, it } from 'vitest';

import {
  isTraceId,
  newRequestId,
  newTraceId,
  normalizeTraceId,
  TRACE_ID_PREFIX,
} from '../src/logging/trace';

describe('newTraceId', () => {
  it('生成的 id 通过格式校验且带前缀', () => {
    const id = newTraceId();
    expect(id.startsWith(TRACE_ID_PREFIX)).toBe(true);
    expect(isTraceId(id)).toBe(true);
  });

  it('长度稳定，适合直接显示在错误提示上', () => {
    const id = newTraceId();
    // tr_ + base36 时间戳(8位上下) + _ + 10 位 hex
    expect(id.length).toBeGreaterThanOrEqual(20);
    expect(id.length).toBeLessThanOrEqual(32);
  });

  it('时间戳前缀让 id 大致按时间有序', () => {
    const early = newTraceId(1_700_000_000_000);
    const later = newTraceId(1_800_000_000_000);
    expect(early < later).toBe(true);
  });

  it('大量生成不重复', () => {
    const set = new Set<string>();
    for (let i = 0; i < 5000; i += 1) set.add(newTraceId());
    expect(set.size).toBe(5000);
  });

  it('负数与非法时间戳不会产生畸形 id', () => {
    expect(isTraceId(newTraceId(-1))).toBe(true);
    expect(isTraceId(newTraceId(Number.NaN))).toBe(true);
  });

  it('newRequestId 与 traceId 同构', () => {
    expect(isTraceId(newRequestId())).toBe(true);
  });
});

describe('normalizeTraceId', () => {
  it('接受合法 id（含首尾空白）', () => {
    const id = newTraceId();
    expect(normalizeTraceId(id)).toBe(id);
    expect(normalizeTraceId(`  ${id}  `)).toBe(id);
  });

  it('拒绝非字符串与空值', () => {
    expect(normalizeTraceId(undefined)).toBeUndefined();
    expect(normalizeTraceId(null)).toBeUndefined();
    expect(normalizeTraceId(123)).toBeUndefined();
    expect(normalizeTraceId('')).toBeUndefined();
  });

  it('拒绝伪造值 —— 外部输入直接进日志会成为注入点', () => {
    // 换行符可以伪造出假的日志行，必须挡在门外
    expect(normalizeTraceId('tr_abc_0123456789\n[error] 伪造的日志行')).toBeUndefined();
    expect(normalizeTraceId('随便什么字符串')).toBeUndefined();
    expect(normalizeTraceId('tr_ABC_0123456789')).toBeUndefined(); // 大写不合规
    expect(normalizeTraceId(`tr_abc_${'a'.repeat(80)}`)).toBeUndefined();
  });

  it('拒绝超长输入', () => {
    expect(normalizeTraceId('tr_' + 'a'.repeat(100) + '_0123456789')).toBeUndefined();
  });
});
