/**
 * 今日待办。
 *
 * 用户的原话：「我的待办主要显示我今日的代办事项」。四个来源他都勾了，所以判定口径是：
 *
 * | 分组 | 含义 | 判定 |
 * | --- | --- | --- |
 * | `due` | 今天到期 + 逾期未完成 | 未完成，且 `due_date < 次日零点`（含昨天以前的） |
 * | `starting` | 今天开始 | `start_date` 落在今天 |
 * | `touched` | 今天动过 | `updated_at` 落在今天（改标题、调状态、推进度都算） |
 * | `marked` | 手动标记「今天做」 | `today_mark_date = 今天的日期键` |
 *
 * 一条任务可以同时命中多个分组（比如昨天建的、今天到期、还被我标了"今天做"），
 * 所以**分组是标签不是分区**：默认视图是四组的并集、按 id 去重，
 * 每条任务带上 `groups` 说明它为什么在这儿。
 *
 * 两条口径：
 * 1. **已完成的不进这个列表**。这是"今天要做的事"，不是"今天做过的流水账" ——
 *    已完成的任务属于工作日志（services/work-log.ts），两处各看各的，不混在一起。
 * 2. **日期一律按本地时区**（与 services/calendar-marks.ts 同一口径）：
 *    "今天"是用户所在地方的今天。
 */

import { and, eq, isNull } from 'drizzle-orm';

import { AppError } from '@pm-studio/shared';
import { tasks } from '../db/schema.js';
import type { ServiceContext } from './context.js';
import {
  TASK_WITH_PROJECT_SELECT,
  statusesOfProjects,
  toTaskWithProject,
  type ProjectStatus,
  type TaskRow,
  type TaskWithProject,
} from './task-query.js';
import { findTask } from './tasks.js';
import { localDateKey, localDayBounds } from './work-time.js';

/** 任务为什么出现在今日待办里 */
export type TodayReason =
  | 'overdue'
  | 'due_today'
  | 'starting_today'
  | 'touched_today'
  | 'marked_today';

/** 界面上的四个筛选分组 */
export type TodayGroup = 'due' | 'starting' | 'touched' | 'marked';

export const TODAY_GROUPS: readonly TodayGroup[] = ['due', 'starting', 'touched', 'marked'];

/** 分组 → 它包含的判定理由 */
export const GROUP_REASONS: Record<TodayGroup, readonly TodayReason[]> = {
  due: ['overdue', 'due_today'],
  starting: ['starting_today'],
  touched: ['touched_today'],
  marked: ['marked_today'],
};

export const GROUP_LABELS: Record<TodayGroup, string> = {
  due: '今天到期 / 逾期',
  starting: '今天开始',
  touched: '今天动过',
  marked: '我标了今天做',
};

export interface TodayTask extends TaskWithProject {
  /** 命中的判定理由（至少一条） */
  reasons: TodayReason[];
  /** 命中的筛选分组（至少一个） */
  groups: TodayGroup[];
}

export interface TodayBoard {
  /** 本地日期键 */
  dateKey: string;
  /**
   * 这份列表**只看哪个项目**（`null` = 所有项目）。
   *
   * 如实带回来是为了让界面能说清口径：用户看到"只有 3 条"时，
   * 得知道这是"当前项目的今天"，而不是"全库的今天"。
   */
  projectId: string | null;
  /** 未筛选时展示的任务（四组并集，按"越紧急越靠前"排序） */
  items: TodayTask[];
  /**
   * 四组并集的任务条数（**去重后**）。
   *
   * 界面上的「全部」必须用它，不能拿 `counts` 相加：一条任务可以同时"今天到期"和
   * "我标了今天做"，相加出来的数字会比列表里真实的行数大 —— 那种"说 3 条只显示 2 行"
   * 的界面会让人以为有东西没加载出来。
   */
  total: number;
  /** 各分组各自的任务数 —— **不受当前筛选影响**，筛选按钮上的数字才不会自己变小 */
  counts: Record<TodayGroup, number>;
  /** 结果里出现的项目的状态表（去重并集，卡片上的状态下拉要用） */
  statuses: ProjectStatus[];
  generatedAt: number;
}

interface TodayOptions {
  /** 只要这些分组；不传 = 全部 */
  groups?: readonly TodayGroup[];
  /**
   * 只看这些项目。不传 = 所有项目。
   *
   * 用户 2026-09-30 定：「今日待办只展示当前项目的任务内容」。
   * 放在服务端过滤而不是"前端拿全量再筛"：跨项目列表里别人项目的数据不该被
   * 传到界面上再丢掉（也少一次全量查询）。
   */
  projectIds?: readonly string[];
  /** 现在的时刻（测试用） */
  at?: number;
  /** 除「我标了今天做」之外，是否还要算**已手动标记但已完成/已归档**的任务？默认不算 */
  limit?: number;
}

/**
 * 判定一条任务命中哪些理由。
 *
 * 抽成纯函数是为了能**单独测**：这类"今天/逾期"的边界（零点整、昨天 23:59:59.999）
 * 是最容易写错又最难在用界面上发现的地方。
 */
export function classifyTask(
  row: { dueDate: number | null; startDate: number | null; updatedAt: number; todayMarkDate: string | null; done: boolean },
  bounds: { start: number; end: number },
  dateKey: string,
): TodayReason[] {
  const reasons: TodayReason[] = [];
  if (row.todayMarkDate === dateKey) reasons.push('marked_today');
  if (row.startDate !== null && row.startDate >= bounds.start && row.startDate < bounds.end) {
    reasons.push('starting_today');
  }
  if (row.updatedAt >= bounds.start && row.updatedAt < bounds.end) reasons.push('touched_today');
  if (!row.done && row.dueDate !== null) {
    if (row.dueDate < bounds.start) reasons.push('overdue');
    else if (row.dueDate < bounds.end) reasons.push('due_today');
  }
  return reasons;
}

function reasonsToGroups(reasons: readonly TodayReason[]): TodayGroup[] {
  const set = new Set<TodayGroup>();
  for (const reason of reasons) {
    for (const group of TODAY_GROUPS) {
      if (GROUP_REASONS[group].includes(reason)) set.add(group);
    }
  }
  return TODAY_GROUPS.filter((group) => set.has(group));
}

/**
 * 排序权重：越"该先做"越靠前。
 *
 * 逾期最前（而且逾期越久越前），然后今天到期、今天开始、手动标记、最后是今天动过的。
 * 同组内按优先级，再按截止时间/更新时间。
 */
function sortWeight(task: TodayTask): number {
  if (task.reasons.includes('overdue')) return 0;
  if (task.groups.includes('due')) return 1;
  if (task.groups.includes('marked')) return 2;
  if (task.groups.includes('starting')) return 3;
  return 4;
}

const PRIORITY_WEIGHT: Record<string, number> = { urgent: 0, high: 1, medium: 2, low: 3 };

export function getTodayBoard(ctx: ServiceContext, options: TodayOptions = {}): TodayBoard {
  const at = options.at ?? ctx.now();
  const dateKey = localDateKey(at);
  const bounds = localDayBounds(dateKey);

  // 一条 SQL 只把**可能**相关的行捞出来，具体理由在 JS 里判：SQL 里写五个 CASE
  // 既难读又难测，而候选集本来就不大（单机单用户）。
  const projectFilter =
    options.projectIds && options.projectIds.length > 0
      ? ` AND t.project_id IN (${options.projectIds.map(() => '?').join(', ')})`
      : '';

  const rows = ctx.sqlite
    .prepare(
      `${TASK_WITH_PROJECT_SELECT}
         AND (
           t.today_mark_date = ?
           OR (t.start_date IS NOT NULL AND t.start_date >= ? AND t.start_date < ?)
           OR (t.updated_at >= ? AND t.updated_at < ?)
           OR (
             t.due_date IS NOT NULL AND t.due_date < ?
             AND (ws.category IS NULL OR ws.category <> 'done')
           )
         )${projectFilter}
        ORDER BY t.updated_at DESC
        LIMIT ?`,
    )
    .all(
      dateKey,
      bounds.start,
      bounds.end,
      bounds.start,
      bounds.end,
      bounds.end,
      ...(options.projectIds ?? []),
      Math.min(Math.max(options.limit ?? 1000, 1), 5000),
    ) as unknown as TaskRow[];

  const items: TodayTask[] = [];
  for (const row of rows) {
    const done = row.category === 'done';
    const base = toTaskWithProject(row);
    const reasons = classifyTask(
      {
        dueDate: base.dueDate,
        startDate: base.startDate,
        updatedAt: base.updatedAt,
        todayMarkDate: base.todayMarkDate,
        done,
      },
      bounds,
      dateKey,
    );
    if (reasons.length === 0) continue;
    // 已完成的不进"今天要做的事"：它只可能因为"今天动过"或"今天标过"被选中，
    // 但这两条都不该让一条已经做完的任务回到待办列表里（见文件头注释）。
    if (done) continue;
    items.push({ ...base, reasons, groups: reasonsToGroups(reasons) });
  }

  const counts = TODAY_GROUPS.reduce(
    (acc, group) => {
      acc[group] = items.filter((task) => task.groups.includes(group)).length;
      return acc;
    },
    {} as Record<TodayGroup, number>,
  );

  const wanted = options.groups && options.groups.length > 0 ? options.groups : TODAY_GROUPS;
  const filtered =
    wanted === TODAY_GROUPS ? items : items.filter((task) => task.groups.some((g) => wanted.includes(g)));

  filtered.sort((a, b) => {
    const weight = sortWeight(a) - sortWeight(b);
    if (weight !== 0) return weight;
    if (a.reasons.includes('overdue') && b.reasons.includes('overdue')) {
      const due = (a.dueDate ?? 0) - (b.dueDate ?? 0);
      if (due !== 0) return due;
    }
    const priority =
      (PRIORITY_WEIGHT[a.priority] ?? 9) - (PRIORITY_WEIGHT[b.priority] ?? 9);
    if (priority !== 0) return priority;
    return b.updatedAt - a.updatedAt;
  });

  return {
    dateKey,
    projectId: options.projectIds && options.projectIds.length === 1 ? (options.projectIds[0] ?? null) : null,
    items: filtered,
    total: items.length,
    counts,
    statuses: statusesOfProjects(
      ctx,
      filtered.map((task) => task.projectId),
    ),
    generatedAt: at,
  };
}

/**
 * 标记 / 取消「今天做」。
 *
 * 存日期键而不是布尔值：明天打开时它自己就失效了，不需要任何定时清理（见迁移 0008 注释）。
 * `marked = false` 时写回 NULL 而不是"昨天的日期键" —— 让"没标记"只有一种表示。
 */
export function setTodayMark(ctx: ServiceContext, taskId: string, marked: boolean): string | null {
  const task = findTask(ctx, taskId);
  if (!task || task.deletedAt !== null) {
    throw new AppError('NOT_FOUND', `任务不存在：${taskId}`);
  }
  const dateKey = marked ? localDateKey(ctx.now()) : null;
  ctx.db
    .update(tasks)
    .set({ todayMarkDate: dateKey, updatedAt: ctx.now() })
    .where(and(eq(tasks.id, taskId), isNull(tasks.deletedAt)))
    .run();
  ctx.logger.info('今日待办：标记变更', { taskId, marked, dateKey });
  return dateKey;
}
