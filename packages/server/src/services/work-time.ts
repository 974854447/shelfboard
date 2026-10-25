/**
 * 当日工作时间（打卡）。
 *
 * 用户的原话：「实现一种类似打卡的功能，但打卡从每天第一次打开软件开始计时，
 * 到最后一次关闭软件结束，且显示计时时间，HH：MM：SS 的格式，需要跟着时间跳动」。
 *
 * 所以计时口径**不是**"用户点了开始"、**不是**"有操作才算"，而是**应用开着的时间**：
 *   一天里第一次打开 → 开一条会话；关闭 → 结束这条会话；再打开 → 又开一条。
 *   当日工时 = 当天所有会话的合计。
 *
 * 三条刻意的设计：
 *
 * 1. **不做去抖 / 不做最小会话时长**。开了 3 秒就关，那就是 3 秒。把短会话藏起来
 *    会让界面上的数字和数据库里的记录对不上，而用户问"今天到底开了多久"时，
 *    我们能给的唯一诚实答案是记录本身。
 *
 * 2. **心跳（`last_seen_at`）是为了"没关干净"的那次**。断电、任务管理器强杀、
 *    崩溃时 `ended_at` 永远是 NULL。这时**不能**把会话算到"下次打开"为止
 *    （那会把关机的一整夜算成工时）。启动时 `recoverStaleSessions` 把它收到
 *    **最后一次心跳**为止，并标记 `close_reason = 'recovered'` —— 宁可少算几十秒，
 *    也不能凭空多算几小时。
 *
 * 3. **跨午夜的会话不拆行**，按天统计时算**交叠**。凌晨两点还在用，那条会话
 *    对"昨天"和"今天"各贡献一段（各算到零点为止）。拆行会让"昨天开了几次"
 *    这种问题变得没法回答。
 *
 * 时区：日期键一律按**本地时区**算（`YYYY-MM-DD`）。"今天"是用户所在地方的今天。
 */

import { and, asc, eq, gte, isNull, lt, or, sql, type SQL } from 'drizzle-orm';

import { workSessions } from '../db/schema.js';
import { inTransaction, type ServiceContext } from './context.js';

/** 会话是怎么结束的 */
export type WorkSessionCloseReason = 'app_quit' | 'recovered' | 'manual';

/** 心跳间隔（毫秒）。桌面端主进程按这个节奏调 `heartbeat`。 */
export const HEARTBEAT_INTERVAL_MS = 30_000;

/**
 * 启动时判定"陈旧会话"的宽容度：最后一次心跳距今超过这么久，就认为那次进程
 * 已经死了（正常心跳间隔 30 秒，留 3 个周期余量，避免把慢一拍的正常退出误判）。
 */
export const STALE_SESSION_GRACE_MS = 90_000;

export interface WorkSessionDto {
  id: string;
  startedAt: number;
  lastSeenAt: number;
  /** null = 还在进行 */
  endedAt: number | null;
  closeReason: WorkSessionCloseReason | null;
  /** 这条会话落在查询区间内的毫秒数 */
  spanMs: number;
}

export interface TodayWorkTimeDto {
  /** 本地日期键，YYYY-MM-DD */
  dateKey: string;
  /** 这一天已结束会话的合计毫秒（不含进行中的那段） */
  closedMs: number;
  /** 正在进行中的会话；渲染层用它做"跟着时间跳动"的显示 */
  open: { id: string; startedAt: number; lastSeenAt: number } | null;
  /** 合计毫秒（含进行中会话算到此刻的那部分） */
  totalMs: number;
  /** 这一天的会话（含进行中的），按开始时间升序 */
  sessions: WorkSessionDto[];
  /** 这一天第一次开始计时的时间；没有会话则为 null */
  firstStartedAt: number | null;
  /** 服务端算出这份数据的时刻（渲染层据此推算"已经跳了多久"） */
  generatedAt: number;
}

/** 本地日期键：YYYY-MM-DD */
export function localDateKey(timestamp: number): string {
  const d = new Date(timestamp);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/** 日期键是否合法（只认 YYYY-MM-DD，并且真的存在这一天） */
export function isValidDateKey(key: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(key);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const probe = new Date(year, month - 1, day);
  return (
    probe.getFullYear() === year && probe.getMonth() === month - 1 && probe.getDate() === day
  );
}

/** 本地日期键对应的当天区间 [零点, 次日零点) */
export function localDayBounds(dateKey: string): { start: number; end: number } {
  const [y, m, d] = dateKey.split('-').map((part) => Number(part));
  const start = new Date(y ?? 1970, (m ?? 1) - 1, d ?? 1, 0, 0, 0, 0).getTime();
  const end = new Date(y ?? 1970, (m ?? 1) - 1, (d ?? 1) + 1, 0, 0, 0, 0).getTime();
  return { start, end };
}

/** 两个区间的交叠长度（毫秒），不重叠为 0 */
export function overlapMs(
  aStart: number,
  aEnd: number,
  bStart: number,
  bEnd: number,
): number {
  return Math.max(0, Math.min(aEnd, bEnd) - Math.max(aStart, bStart));
}

type SessionRow = typeof workSessions.$inferSelect;

function toDto(row: SessionRow, rangeStart: number, rangeEnd: number, now: number): WorkSessionDto {
  const effectiveEnd = row.endedAt ?? now;
  return {
    id: row.id,
    startedAt: row.startedAt,
    lastSeenAt: row.lastSeenAt,
    endedAt: row.endedAt,
    closeReason: (row.closeReason as WorkSessionCloseReason | null) ?? null,
    spanMs: overlapMs(row.startedAt, effectiveEnd, rangeStart, rangeEnd),
  };
}

/**
 * 开一条会话。
 *
 * **幂等**：已经有一条未结束的会话时直接返回它，不再开新的。
 * 这样"应用启动"这个动作被重复触发（开发时热重启、用户连点）也不会把工时切成两半。
 */
export function startSession(ctx: ServiceContext): WorkSessionDto {
  const now = ctx.now();
  const existing = ctx.db
    .select()
    .from(workSessions)
    .where(isNull(workSessions.endedAt))
    .orderBy(sql`${workSessions.startedAt} DESC`)
    .limit(1)
    .all()[0];

  if (existing) {
    const { start, end } = localDayBounds(localDateKey(now));
    return toDto(existing, start, end, now);
  }

  const id = ctx.newId();
  ctx.db
    .insert(workSessions)
    .values({ id, startedAt: now, lastSeenAt: now, createdAt: now })
    .run();
  ctx.logger.debug('work-time: 开始计时', { id, startedAt: now });

  const { start, end } = localDayBounds(localDateKey(now));
  const row = ctx.db.select().from(workSessions).where(eq(workSessions.id, id)).all()[0]!;
  return toDto(row, start, end, now);
}

/** 心跳：把未结束会话的 `lastSeenAt` 推到此刻 */
export function heartbeat(ctx: ServiceContext, sessionId?: string): number {
  const now = ctx.now();
  const where: SQL | undefined = sessionId
    ? and(isNull(workSessions.endedAt), eq(workSessions.id, sessionId))
    : isNull(workSessions.endedAt);
  const result = ctx.db
    .update(workSessions)
    .set({ lastSeenAt: now })
    .where(where)
    .run();
  return Number(result.changes ?? 0);
}

/**
 * 结束会话（正常退出 / 用户手动结束）。
 *
 * 只结束**未结束**的会话 —— 重复调用（退出流程被触发多次）不会改动已结束的记录。
 */
export function endOpenSessions(
  ctx: ServiceContext,
  reason: WorkSessionCloseReason,
): number {
  const now = ctx.now();
  const result = ctx.db
    .update(workSessions)
    .set({ endedAt: now, lastSeenAt: now, closeReason: reason })
    .where(isNull(workSessions.endedAt))
    .run();
  const changed = Number(result.changes ?? 0);
  if (changed > 0) {
    ctx.logger.info('work-time: 结束计时', { reason, endedAt: now, sessions: changed });
  }
  return changed;
}

export interface RecoverResult {
  /** 被补收的会话数 */
  recovered: number;
  ids: string[];
}

/**
 * 启动时补收"没关干净"的会话。
 *
 * 判定条件：`ended_at IS NULL`（上次没走正常退出流程）**且**最后一次心跳已经
 * 超过 `STALE_SESSION_GRACE_MS`（说明那个进程确实死了，不是本次启动刚开的会话）。
 *
 * 结束时间取 `last_seen_at`：那是那个进程最后一次"我还活着"的证据。
 */
export function recoverStaleSessions(
  ctx: ServiceContext,
  options: { graceMs?: number } = {},
): RecoverResult {
  const now = ctx.now();
  const grace = options.graceMs ?? STALE_SESSION_GRACE_MS;
  const cutoff = now - grace;

  const stale = ctx.db
    .select()
    .from(workSessions)
    .where(and(isNull(workSessions.endedAt), lt(workSessions.lastSeenAt, cutoff)))
    .all();

  if (stale.length === 0) return { recovered: 0, ids: [] };

  inTransaction(ctx, () => {
    for (const row of stale) {
      ctx.db
        .update(workSessions)
        .set({
          endedAt: row.lastSeenAt,
          closeReason: 'recovered',
        })
        .where(eq(workSessions.id, row.id))
        .run();
    }
  });

  ctx.logger.warn('work-time: 补收了上次没正常结束的计时会话', {
    count: stale.length,
    ids: stale.map((row) => row.id),
  });
  return { recovered: stale.length, ids: stale.map((row) => row.id) };
}

/** 某一天的工时汇总 */
export function getDaySummary(
  ctx: ServiceContext,
  dateKey: string = localDateKey(ctx.now()),
): TodayWorkTimeDto {
  const now = ctx.now();
  const { start, end } = localDayBounds(dateKey);
  // 与这一天有交叠的会话：started_at < end 且 (ended_at IS NULL 或 ended_at > start)
  const rows = ctx.db
    .select()
    .from(workSessions)
    .where(
      and(
        lt(workSessions.startedAt, end),
        or(isNull(workSessions.endedAt), gte(workSessions.endedAt, start)),
      ),
    )
    .orderBy(asc(workSessions.startedAt))
    .all();

  const sessions = rows.map((row) => toDto(row, start, end, now));
  const openRow = rows.find((row) => row.endedAt === null) ?? null;
  const closedMs = sessions
    .filter((session) => session.endedAt !== null)
    .reduce((sum, session) => sum + session.spanMs, 0);
  const openSpanMs = openRow
    ? overlapMs(openRow.startedAt, now, start, end)
    : 0;

  return {
    dateKey,
    closedMs,
    open: openRow
      ? { id: openRow.id, startedAt: openRow.startedAt, lastSeenAt: openRow.lastSeenAt }
      : null,
    totalMs: closedMs + openSpanMs,
    sessions,
    firstStartedAt: sessions.length > 0 ? (sessions[0]?.startedAt ?? null) : null,
    generatedAt: now,
  };
}

/** 多天的工时合计（工作日志用）：{ 日期键 → 毫秒 } */
export function getRangeTotals(
  ctx: ServiceContext,
  dateKeys: readonly string[],
): Record<string, number> {
  const totals: Record<string, number> = {};
  for (const key of dateKeys) totals[key] = getDaySummary(ctx, key).totalMs;
  return totals;
}

/** 列出某一天的会话（界面用：今天开了几次、每次多久） */
export function listDaySessions(
  ctx: ServiceContext,
  dateKey: string = localDateKey(ctx.now()),
): WorkSessionDto[] {
  return getDaySummary(ctx, dateKey).sessions;
}
