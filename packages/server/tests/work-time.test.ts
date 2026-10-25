/**
 * 当日工作时间（打卡）测试。
 *
 * 这里挑的都是"跑起来看不出错"的地方：
 * - 零点边界（昨天 23:59:59.999 该算昨天）
 * - 跨午夜会话按交叠算（多算一小时少算一小时界面上都看不出来）
 * - 强杀后的补收（收错会让工时凭空多出几小时）
 * - 幂等（连点 / 退出流程被触发两次不该把工时切碎）
 */

import { afterEach, describe, expect, it } from 'vitest';

import { DbConnection } from '../src/db/connection';
import { createLogger } from '../src/logging/logger';
import { createServiceContext, type ServiceContext } from '../src/services/context';
import * as workTime from '../src/services/work-time';

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()?.();
});

/** 可控时钟：打卡逻辑全靠时间，用递增的假时钟测不出来，必须能显式拨表 */
let nowMs = new Date(2026, 8, 29, 9, 0, 0, 0).getTime();

function setNow(date: Date): void {
  nowMs = date.getTime();
}

function at(hour: number, minute = 0, day = 29): number {
  return new Date(2026, 8, day, hour, minute, 0, 0).getTime();
}

function makeCtx(): ServiceContext {
  const conn = new DbConnection();
  conn.open(':memory:');
  const ctx = createServiceContext({
    conn,
    logger: createLogger({ source: 'api', minLevel: 'error' }),
    now: () => nowMs,
  });
  cleanups.push(() => conn.close());
  return ctx;
}

describe('日期键与区间', () => {
  it('本地日期键按本地时区算', () => {
    expect(workTime.localDateKey(at(0))).toBe('2026-09-29');
    expect(workTime.localDateKey(at(23, 59))).toBe('2026-09-29');
    expect(workTime.localDateKey(at(0, 0, 30))).toBe('2026-09-30');
  });

  it('当天区间是 [本地零点, 次日零点)', () => {
    const bounds = workTime.localDayBounds('2026-09-29');
    expect(bounds.start).toBe(new Date(2026, 8, 29, 0, 0, 0, 0).getTime());
    expect(bounds.end).toBe(new Date(2026, 8, 30, 0, 0, 0, 0).getTime());
    // 边界归属：零点属于当天，次日零点属于次日
    expect(workTime.localDayBounds('2026-09-30').start).toBe(bounds.end);
  });

  it('日期键校验：不存在的日子不算合法', () => {
    expect(workTime.isValidDateKey('2026-09-29')).toBe(true);
    expect(workTime.isValidDateKey('2026-02-30')).toBe(false);
    expect(workTime.isValidDateKey('2026-13-01')).toBe(false);
    expect(workTime.isValidDateKey('2026-9-29')).toBe(false);
    expect(workTime.isValidDateKey('')).toBe(false);
  });

  it('交叠长度：不重叠为 0', () => {
    expect(workTime.overlapMs(0, 10, 5, 20)).toBe(5);
    expect(workTime.overlapMs(0, 10, 20, 30)).toBe(0);
    expect(workTime.overlapMs(0, 10, -5, 3)).toBe(3);
  });
});

describe('计时会话', () => {
  it('开一次会话，心跳跟上，结束时间就是结束那一刻', () => {
    const ctx = makeCtx();
    setNow(new Date(at(9)));
    const session = workTime.startSession(ctx);
    expect(session.endedAt).toBeNull();

    setNow(new Date(at(9, 10)));
    expect(workTime.heartbeat(ctx, session.id)).toBe(1);

    setNow(new Date(at(9, 30)));
    expect(workTime.endOpenSessions(ctx, 'app_quit')).toBe(1);

    setNow(new Date(at(10)));
    const summary = workTime.getDaySummary(ctx);
    expect(summary.dateKey).toBe('2026-09-29');
    expect(summary.totalMs).toBe(30 * 60 * 1000);
    expect(summary.closedMs).toBe(30 * 60 * 1000);
    expect(summary.open).toBeNull();
    expect(summary.sessions).toHaveLength(1);
    expect(summary.sessions[0]?.closeReason).toBe('app_quit');
  });

  it('重复"打开软件"不会切碎工时（幂等）', () => {
    const ctx = makeCtx();
    setNow(new Date(at(9)));
    const first = workTime.startSession(ctx);
    setNow(new Date(at(9, 5)));
    const second = workTime.startSession(ctx);
    expect(second.id).toBe(first.id);

    setNow(new Date(at(9, 10)));
    workTime.endOpenSessions(ctx, 'app_quit');
    expect(workTime.getDaySummary(ctx).sessions).toHaveLength(1);
  });

  it('一天开关多次 = 多条会话，当日工时是它们的合计', () => {
    const ctx = makeCtx();
    setNow(new Date(at(9)));
    workTime.startSession(ctx);
    setNow(new Date(at(10)));
    workTime.endOpenSessions(ctx, 'app_quit');

    setNow(new Date(at(14)));
    workTime.startSession(ctx);
    setNow(new Date(at(14, 30)));
    workTime.endOpenSessions(ctx, 'app_quit');

    const summary = workTime.getDaySummary(ctx);
    expect(summary.sessions).toHaveLength(2);
    expect(summary.totalMs).toBe(90 * 60 * 1000);
    expect(summary.firstStartedAt).toBe(at(9));
  });

  it('正在进行的会话算到此刻为止（closedMs 不含它）', () => {
    const ctx = makeCtx();
    setNow(new Date(at(9)));
    workTime.startSession(ctx);
    setNow(new Date(at(9, 30)));
    const summary = workTime.getDaySummary(ctx);
    expect(summary.open).not.toBeNull();
    expect(summary.closedMs).toBe(0);
    expect(summary.totalMs).toBe(30 * 60 * 1000);
  });

  it('重复结束不会改动已结束的记录', () => {
    const ctx = makeCtx();
    setNow(new Date(at(9)));
    workTime.startSession(ctx);
    setNow(new Date(at(10)));
    expect(workTime.endOpenSessions(ctx, 'app_quit')).toBe(1);
    setNow(new Date(at(11)));
    expect(workTime.endOpenSessions(ctx, 'app_quit')).toBe(0);
    expect(workTime.getDaySummary(ctx).totalMs).toBe(60 * 60 * 1000);
  });

  it('跨午夜的会话按天拆开算交叠，不凭空多算', () => {
    const ctx = makeCtx();
    setNow(new Date(at(23)));
    workTime.startSession(ctx);
    setNow(new Date(at(1, 0, 30)));
    workTime.endOpenSessions(ctx, 'app_quit');

    expect(workTime.getDaySummary(ctx, '2026-09-29').totalMs).toBe(60 * 60 * 1000);
    expect(workTime.getDaySummary(ctx, '2026-09-30').totalMs).toBe(60 * 60 * 1000);
    // 一条会话仍然是一条（不拆行），只是它在两天里各有贡献
    expect(workTime.getDaySummary(ctx, '2026-09-29').sessions).toHaveLength(1);
    expect(workTime.getDaySummary(ctx, '2026-09-28').totalMs).toBe(0);
  });
});

describe('没关干净的会话（强杀 / 断电）', () => {
  it('启动时收到的最后一次心跳为止，并标记 recovered', () => {
    const ctx = makeCtx();
    setNow(new Date(at(9)));
    workTime.startSession(ctx);
    setNow(new Date(at(9, 1)));
    workTime.heartbeat(ctx);

    // 模拟断电：应用再没跑过，两小时后"重新打开"
    setNow(new Date(at(11)));
    const result = workTime.recoverStaleSessions(ctx);
    expect(result.recovered).toBe(1);

    const summary = workTime.getDaySummary(ctx);
    // 只算到 09:01（最后一次心跳），不是算到 11:00
    expect(summary.totalMs).toBe(60 * 1000);
    expect(summary.sessions[0]?.closeReason).toBe('recovered');
    expect(summary.sessions[0]?.endedAt).toBe(at(9, 1));
  });

  it('刚开出来的会话不会被当成陈旧会话', () => {
    const ctx = makeCtx();
    setNow(new Date(at(9)));
    workTime.startSession(ctx);
    // 30 秒后（心跳还没到点）：这条会话是本次启动刚开的，不能被当成上次的残留
    setNow(new Date(2026, 8, 29, 9, 0, 30));
    expect(workTime.recoverStaleSessions(ctx).recovered).toBe(0);
    // 心跳还在，计时继续
    setNow(new Date(at(9, 30)));
    expect(workTime.getDaySummary(ctx).totalMs).toBe(30 * 60 * 1000);
  });

  it('补收之后可以正常开新会话', () => {
    const ctx = makeCtx();
    setNow(new Date(at(9)));
    workTime.startSession(ctx);
    setNow(new Date(at(12)));
    workTime.recoverStaleSessions(ctx);
    const fresh = workTime.startSession(ctx);
    expect(fresh.endedAt).toBeNull();
    expect(workTime.getDaySummary(ctx).open?.id).toBe(fresh.id);
  });
});

describe('多天合计（工作日志取数用）', () => {
  it('按日期键逐天给合计', () => {
    const ctx = makeCtx();
    setNow(new Date(at(9)));
    workTime.startSession(ctx);
    setNow(new Date(at(10)));
    workTime.endOpenSessions(ctx, 'app_quit');

    setNow(new Date(at(9, 0, 30)));
    workTime.startSession(ctx);
    setNow(new Date(at(9, 30, 30)));
    workTime.endOpenSessions(ctx, 'app_quit');

    const totals = workTime.getRangeTotals(ctx, ['2026-09-29', '2026-09-30', '2026-09-28']);
    expect(totals['2026-09-29']).toBe(60 * 60 * 1000);
    expect(totals['2026-09-30']).toBe(30 * 60 * 1000);
    expect(totals['2026-09-28']).toBe(0);
  });
});
