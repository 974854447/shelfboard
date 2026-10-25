/**
 * 今日待办测试。
 *
 * 重点在两处最容易出错、又最难在用界面上发现的地方：
 * 1. **分组是标签不是分区** —— 一条任务可以同时"今天到期"+"我标了今天做"，
 *    所以四组各自计数之和会大于列表长度，这是对的，不是 bug。
 * 2. **已完成的不进列表** —— 它属于工作日志。混进来的话"今天要做的事"会越看越多。
 */

import { afterEach, describe, expect, it } from 'vitest';

import { DbConnection } from '../src/db/connection';
import { createLogger } from '../src/logging/logger';
import { createServiceContext, type ServiceContext } from '../src/services/context';
import * as projectService from '../src/services/projects';
import * as taskService from '../src/services/tasks';
import * as todayService from '../src/services/today';
import * as workTime from '../src/services/work-time';
import * as workflow from '../src/services/workflow-statuses';

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()?.();
});

let nowMs = 0;

function at(hour: number, minute = 0, day = 29): number {
  return new Date(2026, 8, day, hour, minute, 0, 0).getTime();
}

/** "现在"= 2026-09-29 12:00（本地） */
const TODAY_NOON = at(12);

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

interface Fixture {
  ctx: ServiceContext;
  projectId: string;
  statuses: { todo: string; doing: string; done: string };
}

function fixture(): Fixture {
  // 项目本身也在"今天"建：项目创建时间不影响任务判定
  nowMs = at(8);
  const ctx = makeCtx();
  const project = projectService.createProject(ctx, { name: 'P' });
  const list = workflow.listStatuses(ctx, project.id);
  const byCategory = (category: string) => list.find((s) => s.category === category)!.id;
  return {
    ctx,
    projectId: project.id,
    statuses: { todo: byCategory('todo'), doing: byCategory('doing'), done: byCategory('done') },
  };
}

describe('分类判定（纯函数）', () => {
  const bounds = workTime.localDayBounds('2026-09-29');
  type ClassifyInput = Parameters<typeof todayService.classifyTask>[0];
  const base: ClassifyInput = {
    dueDate: null,
    startDate: null,
    updatedAt: 0,
    todayMarkDate: null,
    done: false,
  };
  const classify = (patch: Partial<ClassifyInput>) =>
    todayService.classifyTask({ ...base, ...patch }, bounds, '2026-09-29');

  it('截止时间在昨天 = 逾期；正好是今天零点 = 今天到期', () => {
    expect(classify({ dueDate: bounds.start - 1 })).toContain('overdue');
    expect(classify({ dueDate: bounds.start })).toContain('due_today');
    expect(classify({ dueDate: bounds.end - 1 })).toContain('due_today');
    // 明天零点以后不算今天的事
    expect(classify({ dueDate: bounds.end })).toEqual([]);
  });

  it('已完成的任务不再报"逾期"', () => {
    const reasons = classify({ dueDate: bounds.start - 86_400_000, done: true });
    expect(reasons).not.toContain('overdue');
    expect(reasons).not.toContain('due_today');
  });

  it('今天开始 / 今天动过 / 今天标记', () => {
    expect(classify({ startDate: bounds.start })).toContain('starting_today');
    expect(classify({ startDate: bounds.start - 1 })).not.toContain('starting_today');
    expect(classify({ updatedAt: bounds.start })).toContain('touched_today');
    expect(classify({ updatedAt: bounds.start - 1 })).not.toContain('touched_today');
    expect(classify({ todayMarkDate: '2026-09-29' })).toContain('marked_today');
    // 昨天标的今天不算（日期键自然过期）
    expect(classify({ todayMarkDate: '2026-09-28' })).not.toContain('marked_today');
  });

  it('一条任务可以同时命中多个理由', () => {
    const reasons = classify({
      dueDate: bounds.start - 3600_000,
      startDate: bounds.start + 1000,
      updatedAt: bounds.start + 2000,
      todayMarkDate: '2026-09-29',
    });
    expect(reasons.sort()).toEqual([
      'marked_today',
      'overdue',
      'starting_today',
      'touched_today',
    ]);
  });
});

describe('今日待办聚合', () => {
  it('四个来源都能进来，且各分组自己是自己的计数', () => {
    const { ctx, projectId, statuses } = fixture();

    // 昨天建、昨天动过的一条普通任务：今天不该出现
    nowMs = at(10, 0, 28);
    const quiet = taskService.createTask(ctx, { projectId, title: '老任务' });

    nowMs = at(9);
    const dueToday = taskService.createTask(ctx, { projectId, title: '今天到期', dueDate: at(18) });
    const overdue = taskService.createTask(ctx, { projectId, title: '逾期了', dueDate: at(9, 0, 28) });
    const starting = taskService.createTask(ctx, {
      projectId,
      title: '今天开始',
      startDate: at(8),
    });
    const marked = taskService.createTask(ctx, { projectId, title: '我标了今天做' });
    const finished = taskService.createTask(ctx, { projectId, title: '今天做完了', dueDate: at(9, 0, 28) });

    nowMs = at(10);
    todayService.setTodayMark(ctx, marked.id, true);
    // 今天做完的一条：逾期 + 今天动过，两条理由都成立，但它不该出现在"要做的事"里
    taskService.updateTask(ctx, finished.id, { statusId: statuses.done });

    const board = todayService.getTodayBoard(ctx, { at: TODAY_NOON });
    const titles = board.items.map((task) => task.title).sort();

    expect(board.dateKey).toBe('2026-09-29');
    expect(titles).toEqual(['今天到期', '今天开始', '我标了今天做', '逾期了']);
    expect(titles).not.toContain('老任务');
    expect(titles).not.toContain('今天做完了');
    expect(board.items.find((t) => t.id === quiet.id)).toBeUndefined();
    expect(dueToday.id).toBeTruthy();
    expect(overdue.id).toBeTruthy();
    expect(starting.id).toBeTruthy();
  });

  it('逾期排在最前，然后才是今天到期 / 标记 / 开始', () => {
    const { ctx, projectId } = fixture();
    nowMs = at(9);
    const marked = taskService.createTask(ctx, { projectId, title: '标记' });
    const due = taskService.createTask(ctx, { projectId, title: '到期', dueDate: at(20) });
    const late = taskService.createTask(ctx, { projectId, title: '逾期', dueDate: at(9, 0, 20) });
    nowMs = at(10);
    todayService.setTodayMark(ctx, marked.id, true);

    const board = todayService.getTodayBoard(ctx, { at: TODAY_NOON });
    expect(board.items.map((t) => t.title)).toEqual(['逾期', '到期', '标记']);
    expect(board.items[0]?.id).toBe(late.id);
    expect(board.items[1]?.id).toBe(due.id);
  });

  it('分组计数不受当前筛选影响（否则按钮上的数字会自己变小）', () => {
    const { ctx, projectId } = fixture();
    nowMs = at(9);
    const due = taskService.createTask(ctx, { projectId, title: '到期', dueDate: at(20) });
    const marked = taskService.createTask(ctx, { projectId, title: '标记' });
    nowMs = at(10);
    todayService.setTodayMark(ctx, marked.id, true);

    const filtered = todayService.getTodayBoard(ctx, { at: TODAY_NOON, groups: ['marked'] });
    expect(filtered.items.map((t) => t.title)).toEqual(['标记']);
    // 计数仍然是全部四组各自的数，而不是"筛完之后剩下的"：
    // 到期 1（只有「到期」真有截止日），标记 1，今天动过 2
    expect(filtered.counts.due).toBe(1);
    expect(filtered.counts.marked).toBe(1);
    expect(filtered.counts.touched).toBe(2);
    /*
     * `total` 是**去重后的并集**（2 条），不是四组相加（4）：
     * 界面上「全部」按钮用前者，否则会出现"写着 4 条、列表只有 2 行"的假象。
     */
    expect(filtered.total).toBe(2);
    expect(due.id).toBeTruthy();

    const all = todayService.getTodayBoard(ctx, { at: TODAY_NOON });
    expect(all.counts).toEqual(filtered.counts);
    expect(all.total).toBe(2);
    expect(all.items).toHaveLength(2);
  });

  it('带上项目的状态表（跨项目列表里的状态下拉要用）', () => {
    const { ctx, projectId } = fixture();
    nowMs = at(9);
    taskService.createTask(ctx, { projectId, title: '到期', dueDate: at(20) });
    const board = todayService.getTodayBoard(ctx, { at: TODAY_NOON });
    expect(board.statuses.length).toBeGreaterThan(0);
    expect(board.statuses.every((status) => status.projectId === projectId)).toBe(true);
  });

  it('可以只看某一个项目（今日待办按当前项目过滤）', () => {
    const { ctx, projectId } = fixture();
    nowMs = at(9);
    const mine = taskService.createTask(ctx, { projectId, title: '我这个项目的' });

    const other = projectService.createProject(ctx, { name: '别的项目' });
    const foreign = taskService.createTask(ctx, {
      projectId: other.id,
      title: '别的项目的',
      dueDate: at(10),
    });

    // 不带项目 = 所有项目都能看到；带上 = 只剩那一个项目的
    const all = todayService.getTodayBoard(ctx, { at: TODAY_NOON });
    expect(all.items.map((task) => task.id).sort()).toEqual([mine.id, foreign.id].sort());
    expect(all.projectId).toBeNull();

    const onlyMine = todayService.getTodayBoard(ctx, { at: TODAY_NOON, projectIds: [projectId] });
    expect(onlyMine.items.map((task) => task.title)).toEqual(['我这个项目的']);
    expect(onlyMine.projectId).toBe(projectId);
    // 计数也跟着收窄 —— 否则界面上会出现"写着 2 条、只显示 1 行"
    expect(onlyMine.total).toBe(1);
    expect(onlyMine.counts.touched).toBe(1);

    const onlyOther = todayService.getTodayBoard(ctx, { at: TODAY_NOON, projectIds: [other.id] });
    expect(onlyOther.items.map((task) => task.title)).toEqual(['别的项目的']);
  });
});

describe('「今天做」标记', () => {
  it('标记写日期键、取消写回 null', () => {
    const { ctx, projectId } = fixture();
    nowMs = at(9);
    const task = taskService.createTask(ctx, { projectId, title: '打地基' });

    nowMs = at(10);
    expect(todayService.setTodayMark(ctx, task.id, true)).toBe('2026-09-29');
    expect(taskService.getTaskDetail(ctx, task.id).todayMarkDate).toBe('2026-09-29');

    expect(todayService.setTodayMark(ctx, task.id, false)).toBeNull();
    expect(taskService.getTaskDetail(ctx, task.id).todayMarkDate).toBeNull();
  });

  it('昨天标的今天不算数', () => {
    const { ctx, projectId } = fixture();
    nowMs = at(10, 0, 28);
    const task = taskService.createTask(ctx, { projectId, title: '昨天标的' });
    todayService.setTodayMark(ctx, task.id, true);
    expect(taskService.getTaskDetail(ctx, task.id).todayMarkDate).toBe('2026-09-28');

    // 今天看：因为没有别的理由（创建时间也在昨天），它不该出现在今日待办里
    const board = todayService.getTodayBoard(ctx, { at: TODAY_NOON });
    expect(board.items.find((t) => t.id === task.id)).toBeUndefined();
  });

  it('任务不存在时抛 NOT_FOUND，不静默成功', () => {
    const { ctx } = fixture();
    nowMs = at(10);
    expect(() => todayService.setTodayMark(ctx, 'nope', true)).toThrow(/任务不存在/);
  });

  it('已删除的任务不接受标记', () => {
    const { ctx, projectId } = fixture();
    nowMs = at(9);
    const task = taskService.createTask(ctx, { projectId, title: '待删' });
    taskService.softDeleteTask(ctx, task.id);
    nowMs = at(10);
    expect(() => todayService.setTodayMark(ctx, task.id, true)).toThrow(/任务不存在/);
  });
});
