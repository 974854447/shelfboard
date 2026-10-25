import { afterEach, describe, expect, it } from 'vitest';

import { DbConnection } from '../src/db/connection';
import { createLogger } from '../src/logging/logger';
import { createServiceContext, type ServiceContext } from '../src/services/context';
import * as markService from '../src/services/calendar-marks';

/**
 * 日历标记（M2）。
 *
 * 三条最要紧的规矩，都是"错了以后很难发现"的那类：
 * 1. **区间是闭区间且按本地日算**：翻月时"这一格里的标记"必须跟格子对上；
 * 2. **标记是工作区级的**：换个项目它还在（这是刻意的，理由见迁移 0005）；
 * 3. **校验在服务层也要有**：界面上的输入框只是提示，接口不能只信界面。
 */

const cleanups: Array<() => void> = [];

afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()?.();
});

let clock = 1_700_000_000_000;

function makeCtx(): ServiceContext {
  const conn = new DbConnection();
  conn.open(':memory:');
  const ctx = createServiceContext({
    conn,
    logger: createLogger({ source: 'api', minLevel: 'error' }),
    now: () => (clock += 1000),
  });
  cleanups.push(() => conn.close());
  return ctx;
}

/** 某一天本地零点的时间戳（测试里就用本地时间构造，不引入时区假设） */
const day = (y: number, m: number, d: number) => new Date(y, m - 1, d).getTime();

describe('创建与查询', () => {
  it('建一条标记，字段原样回来', () => {
    const ctx = makeCtx();
    const created = markService.createCalendarMark(ctx, {
      date: day(2026, 9, 26),
      title: '发版 v0.2.0',
      color: '#22C55E',
      note: '记得先跑一遍 e2e',
    });

    expect(created.title).toBe('发版 v0.2.0');
    expect(created.color).toBe('#22c55e'); // 统一成小写，方便比较与去重
    expect(created.note).toBe('记得先跑一遍 e2e');
    expect(created.date).toBe(day(2026, 9, 26));
  });

  it('不传颜色时用默认色，不传备注就是 null', () => {
    const ctx = makeCtx();
    const created = markService.createCalendarMark(ctx, { date: day(2026, 9, 1), title: '休假' });
    expect(created.color).toBe('#3b82f6');
    expect(created.note).toBeNull();
  });

  it('标题与备注两头的空格会被去掉；只有空格的标题被拒', () => {
    const ctx = makeCtx();
    const created = markService.createCalendarMark(ctx, {
      date: day(2026, 9, 1),
      title: '  生日  ',
      note: '   ',
    });
    expect(created.title).toBe('生日');
    expect(created.note).toBeNull();
    expect(() =>
      markService.createCalendarMark(ctx, { date: day(2026, 9, 1), title: '   ' }),
    ).toThrow(/不能为空/);
  });

  it('按区间取：闭区间，且同一天的多条都在', () => {
    const ctx = makeCtx();
    markService.createCalendarMark(ctx, { date: day(2026, 9, 25), title: '中秋' });
    markService.createCalendarMark(ctx, { date: day(2026, 9, 26), title: '发版' });
    markService.createCalendarMark(ctx, { date: day(2026, 9, 26), title: '聚餐' });
    markService.createCalendarMark(ctx, { date: day(2026, 10, 1), title: '国庆值班' });

    const sept = markService.listCalendarMarks(ctx, {
      from: day(2026, 9, 1),
      to: day(2026, 9, 30),
    });
    expect(sept.map((mark) => mark.title)).toEqual(['中秋', '发版', '聚餐']);

    // 边界：区间两端都算在内
    const edge = markService.listCalendarMarks(ctx, { from: day(2026, 9, 26), to: day(2026, 9, 26) });
    expect(edge.map((mark) => mark.title)).toEqual(['发版', '聚餐']);

    expect(markService.listCalendarMarks(ctx)).toHaveLength(4);
  });

  it('标记不挂在项目上：没有项目时也能建、也能查（工作区级）', () => {
    const ctx = makeCtx();
    markService.createCalendarMark(ctx, { date: day(2026, 9, 26), title: '休假' });
    expect(markService.countCalendarMarks(ctx)).toBe(1);
    expect(markService.listCalendarMarks(ctx)[0]?.title).toBe('休假');
  });
});

describe('修改与删除', () => {
  it('改标题/颜色/日期，updated_at 会变', () => {
    const ctx = makeCtx();
    const created = markService.createCalendarMark(ctx, { date: day(2026, 9, 26), title: '发版' });
    const updated = markService.updateCalendarMark(ctx, created.id, {
      title: '发版（顺延）',
      date: day(2026, 9, 27),
      color: '#ef4444',
    });
    expect(updated.title).toBe('发版（顺延）');
    expect(updated.date).toBe(day(2026, 9, 27));
    expect(updated.color).toBe('#ef4444');
    expect(updated.updatedAt).toBeGreaterThan(created.updatedAt);
  });

  it('备注可以显式清空（传 null）', () => {
    const ctx = makeCtx();
    const created = markService.createCalendarMark(ctx, {
      date: day(2026, 9, 26),
      title: '发版',
      note: '先跑 e2e',
    });
    expect(markService.updateCalendarMark(ctx, created.id, { note: null }).note).toBeNull();
  });

  it('删除是硬删除，删掉就查不到了', () => {
    const ctx = makeCtx();
    const created = markService.createCalendarMark(ctx, { date: day(2026, 9, 26), title: '发版' });
    markService.deleteCalendarMark(ctx, created.id);
    expect(markService.listCalendarMarks(ctx)).toHaveLength(0);
    expect(() => markService.deleteCalendarMark(ctx, created.id)).toThrow(/不存在/);
  });

  it('不存在的 id 会报"不存在"，而不是静默成功', () => {
    const ctx = makeCtx();
    expect(() => markService.updateCalendarMark(ctx, 'nope', { title: 'x' })).toThrow(/不存在/);
  });
});

describe('校验（接口不能只信界面）', () => {
  it('颜色只接受 #RRGGBB', () => {
    const ctx = makeCtx();
    expect(() =>
      markService.createCalendarMark(ctx, { date: day(2026, 9, 26), title: 'x', color: 'red' }),
    ).toThrow(/#RRGGBB/);
  });

  it('标题有长度上限', () => {
    const ctx = makeCtx();
    const tooLong = '长'.repeat(markService.MARK_TITLE_MAX + 1);
    expect(() =>
      markService.createCalendarMark(ctx, { date: day(2026, 9, 26), title: tooLong }),
    ).toThrow(/最多/);
  });

  it('日期必须是正数时间戳', () => {
    const ctx = makeCtx();
    expect(() =>
      markService.createCalendarMark(ctx, { date: 0, title: 'x' }),
    ).toThrow(/日期不合法/);
    expect(() =>
      markService.createCalendarMark(ctx, { date: Number.NaN, title: 'x' }),
    ).toThrow(/日期不合法/);
  });
});
