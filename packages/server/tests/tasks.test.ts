import { afterEach, describe, expect, it } from 'vitest';

import type { AppError } from '@pm-studio/shared';

import { DbConnection } from '../src/db/connection';
import { createLogger } from '../src/logging/logger';
import { createServiceContext, type ServiceContext } from '../src/services/context';
import * as projectService from '../src/services/projects';
import * as depService from '../src/services/task-dependencies';
import * as taskService from '../src/services/tasks';
import * as workflow from '../src/services/workflow-statuses';

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

interface Fixture {
  ctx: ServiceContext;
  projectId: string;
  statuses: {
    todo: string;
    doing: string;
    done: string;
    /** 项目里全部状态（按 sortOrder），看板断列顺序用 */
    all: Array<{ id: string; name: string; category: string }>;
  };
}

function fixture(): Fixture {
  const ctx = makeCtx();
  const project = projectService.createProject(ctx, { name: 'P' });
  const list = workflow.listStatuses(ctx, project.id);
  const byCategory = (category: string) => list.find((s) => s.category === category)!.id;
  return {
    ctx,
    projectId: project.id,
    statuses: {
      todo: byCategory('todo'),
      doing: byCategory('doing'),
      done: byCategory('done'),
      all: list.map((s) => ({ id: s.id, name: s.name, category: s.category })),
    },
  };
}

function columnOrder(ctx: ServiceContext, projectId: string, statusId: string): string[] {
  const board = taskService.getBoard(ctx, projectId);
  return board.columns.find((c) => c.statusId === statusId)?.tasks.map((t) => t.title) ?? [];
}

describe('任务创建', () => {
  it('默认落到项目的默认状态（待完成）', () => {
    const { ctx, projectId, statuses } = fixture();
    const task = taskService.createTask(ctx, { projectId, title: '写需求' });
    expect(task.statusId).toBe(statuses.todo);
    expect(task.priority).toBe('medium');
    // 进度字段已下线（用户 2026-10-02）：完成情况由状态表达，DTO 里不再有 progress
    expect('progress' in task).toBe(false);
  });

  it('项目不存在时抛 NOT_FOUND（不会静默建出孤儿任务）', () => {
    const { ctx } = fixture();
    expect(() => taskService.createTask(ctx, { projectId: 'nope', title: 'x' })).toThrow(
      /项目不存在/,
    );
  });

  it('父任务必须属于同一项目', () => {
    const { ctx, projectId } = fixture();
    const other = projectService.createProject(ctx, { name: '别的项目' });
    const foreign = taskService.createTask(ctx, { projectId: other.id, title: '外部任务' });

    expect(() =>
      taskService.createTask(ctx, { projectId, parentId: foreign.id, title: '子任务' }),
    ).toThrow(/同一项目/);
  });

  it('同一列内新任务追加到末尾', () => {
    const { ctx, projectId, statuses } = fixture();
    taskService.createTask(ctx, { projectId, title: 'A' });
    taskService.createTask(ctx, { projectId, title: 'B' });

    expect(columnOrder(ctx, projectId, statuses.todo)).toEqual(['A', 'B']);
  });
});

describe('多层子任务与任务树', () => {
  it('支持三层嵌套并能正确构树', () => {
    const { ctx, projectId } = fixture();
    const root = taskService.createTask(ctx, { projectId, title: '一级' });
    const child = taskService.createTask(ctx, { projectId, title: '二级', parentId: root.id });
    taskService.createTask(ctx, { projectId, title: '三级', parentId: child.id });

    const tree = taskService.getTaskTree(ctx, projectId);
    expect(tree).toHaveLength(1);
    expect(tree[0]?.title).toBe('一级');
    expect(tree[0]?.children[0]?.title).toBe('二级');
    expect(tree[0]?.children[0]?.children[0]?.title).toBe('三级');
  });

  it('父任务的 childCount / doneChildCount 反映子任务完成情况', () => {
    const { ctx, projectId, statuses } = fixture();
    const root = taskService.createTask(ctx, { projectId, title: '父' });
    const a = taskService.createTask(ctx, { projectId, title: 'a', parentId: root.id });
    taskService.createTask(ctx, { projectId, title: 'b', parentId: root.id });

    const before = taskService.getTaskDetail(ctx, root.id);
    expect(before.childCount).toBe(2);
    expect(before.doneChildCount).toBe(0);

    taskService.updateTask(ctx, a.id, { statusId: statuses.done });

    const after = taskService.getTaskDetail(ctx, root.id);
    expect(after.doneChildCount).toBe(1);
  });

  it('父任务被筛掉时子任务按根节点展示（而不是消失）', () => {
    const { ctx, projectId } = fixture();
    const root = taskService.createTask(ctx, { projectId, title: '父', priority: 'high' });
    taskService.createTask(ctx, { projectId, title: '子', parentId: root.id, priority: 'low' });

    const tree = taskService.getTaskTree(ctx, projectId, { priority: 'low' });

    expect(tree.map((t) => t.title)).toEqual(['子']);
  });

  it('阻止把任务移动到自己或自己的子孙下面', () => {
    const { ctx, projectId } = fixture();
    const root = taskService.createTask(ctx, { projectId, title: '父' });
    const child = taskService.createTask(ctx, { projectId, title: '子', parentId: root.id });

    expect(() => taskService.updateTask(ctx, root.id, { parentId: root.id })).toThrow(
      /不能把自己设为父任务/,
    );
    expect(() => taskService.updateTask(ctx, root.id, { parentId: child.id })).toThrow(
      /自己的子任务下面/,
    );
  });
});

describe('看板拖拽（moveTask）', () => {
  it('拖到另一列末尾', () => {
    const { ctx, projectId, statuses } = fixture();
    taskService.createTask(ctx, { projectId, title: 'A' });
    const moving = taskService.createTask(ctx, { projectId, title: 'B' });
    taskService.createTask(ctx, { projectId, title: 'C', statusId: statuses.doing });

    taskService.moveTask(ctx, moving.id, { statusId: statuses.doing });

    expect(columnOrder(ctx, projectId, statuses.todo)).toEqual(['A']);
    expect(columnOrder(ctx, projectId, statuses.doing)).toEqual(['C', 'B']);
  });

  it('插到指定任务之前，取中点序号（只更新一行）', () => {
    const { ctx, projectId, statuses } = fixture();
    const a = taskService.createTask(ctx, { projectId, title: 'A' });
    const b = taskService.createTask(ctx, { projectId, title: 'B' });
    const c = taskService.createTask(ctx, { projectId, title: 'C' });
    const x = taskService.createTask(ctx, { projectId, title: 'X' });

    expect(a.sortOrder).toBe(1000);
    expect(b.sortOrder).toBe(2000);
    expect(c.sortOrder).toBe(3000);

    const moved = taskService.moveTask(ctx, x.id, {
      statusId: statuses.todo,
      beforeTaskId: c.id,
    });

    expect(moved.sortOrder).toBe(2500);
    expect(columnOrder(ctx, projectId, statuses.todo)).toEqual(['A', 'B', 'X', 'C']);
  });

  it('间隙耗尽时重排整列（而不是产生重复序号）', () => {
    const { ctx, projectId, statuses } = fixture();
    const a = taskService.createTask(ctx, { projectId, title: 'A' });
    const b = taskService.createTask(ctx, { projectId, title: 'B' });
    const c = taskService.createTask(ctx, { projectId, title: 'C' });
    const x = taskService.createTask(ctx, { projectId, title: 'X' });

    // 人为把 A、B 的序号挤到一起，制造"没有中点可用"的局面
    ctx.sqlite.prepare('UPDATE tasks SET sort_order = 1000 WHERE id = ?').run(a.id);
    ctx.sqlite.prepare('UPDATE tasks SET sort_order = 1001 WHERE id = ?').run(b.id);

    taskService.moveTask(ctx, x.id, { statusId: statuses.todo, beforeTaskId: b.id });

    const board = taskService.getBoard(ctx, projectId);
    const column = board.columns.find((col) => col.statusId === statuses.todo)!;
    expect(column.tasks.map((t) => t.title)).toEqual(['A', 'X', 'B', 'C']);
    // 重排后恢复间隔
    expect(column.tasks.map((t) => t.sortOrder)).toEqual([1000, 2000, 3000, 4000]);
    expect(c.id).toBeTruthy();
  });

  it('参照任务不在目标列时明确报错（而不是静默乱序）', () => {
    const { ctx, projectId, statuses } = fixture();
    const target = taskService.createTask(ctx, { projectId, title: 'T' });
    const outsider = taskService.createTask(ctx, {
      projectId,
      title: 'O',
      statusId: statuses.doing,
    });

    expect(() =>
      taskService.moveTask(ctx, target.id, {
        statusId: statuses.todo,
        beforeTaskId: outsider.id,
      }),
    ).toThrow(/不在目标状态列/);
  });

  it('拖进"已完成"列会记完成时间，拖出来会清空', () => {
    const { ctx, projectId, statuses } = fixture();
    const task = taskService.createTask(ctx, { projectId, title: 'T' });
    expect(task.completedAt).toBeNull();

    const done = taskService.moveTask(ctx, task.id, { statusId: statuses.done });
    expect(done.completedAt).not.toBeNull();

    const back = taskService.moveTask(ctx, task.id, { statusId: statuses.todo });
    expect(back.completedAt).toBeNull();
  });

  it('目标状态不属于该项目时拒绝', () => {
    const { ctx, projectId } = fixture();
    const other = projectService.createProject(ctx, { name: '别的' });
    const foreignStatus = workflow.listStatuses(ctx, other.id)[0]!;
    const task = taskService.createTask(ctx, { projectId, title: 'T' });

    expect(() => taskService.moveTask(ctx, task.id, { statusId: foreignStatus.id })).toThrow(
      /不属于该项目/,
    );
  });
});

describe('任务依赖与成环检测', () => {
  it('建立依赖并双向可见', () => {
    const { ctx, projectId } = fixture();
    const a = taskService.createTask(ctx, { projectId, title: 'A' });
    const b = taskService.createTask(ctx, { projectId, title: 'B' });

    depService.addDependency(ctx, { predecessorId: a.id, successorId: b.id });

    expect(depService.listDependenciesForTask(ctx, b.id).predecessors).toHaveLength(1);
    expect(depService.listDependenciesForTask(ctx, a.id).successors).toHaveLength(1);
  });

  it('拒绝自依赖', () => {
    const { ctx, projectId } = fixture();
    const a = taskService.createTask(ctx, { projectId, title: 'A' });

    try {
      depService.addDependency(ctx, { predecessorId: a.id, successorId: a.id });
      throw new Error('本应抛错');
    } catch (error) {
      expect((error as AppError).code).toBe('DEPENDENCY_CYCLE');
    }
  });

  it('拒绝直接成环（A→B 后再建 B→A）', () => {
    const { ctx, projectId } = fixture();
    const a = taskService.createTask(ctx, { projectId, title: 'A' });
    const b = taskService.createTask(ctx, { projectId, title: 'B' });
    depService.addDependency(ctx, { predecessorId: a.id, successorId: b.id });

    expect(() =>
      depService.addDependency(ctx, { predecessorId: b.id, successorId: a.id }),
    ).toThrow(/形成环/);
  });

  it('拒绝传递成环（A→B→C 后再建 C→A）', () => {
    const { ctx, projectId } = fixture();
    const a = taskService.createTask(ctx, { projectId, title: 'A' });
    const b = taskService.createTask(ctx, { projectId, title: 'B' });
    const c = taskService.createTask(ctx, { projectId, title: 'C' });
    depService.addDependency(ctx, { predecessorId: a.id, successorId: b.id });
    depService.addDependency(ctx, { predecessorId: b.id, successorId: c.id });

    expect(() =>
      depService.addDependency(ctx, { predecessorId: c.id, successorId: a.id }),
    ).toThrow(/形成环/);
    expect(depService.hasCycle(ctx, projectId)).toBe(false);
  });

  it('重复建立同一条依赖会被拒绝', () => {
    const { ctx, projectId } = fixture();
    const a = taskService.createTask(ctx, { projectId, title: 'A' });
    const b = taskService.createTask(ctx, { projectId, title: 'B' });
    depService.addDependency(ctx, { predecessorId: a.id, successorId: b.id });

    expect(() =>
      depService.addDependency(ctx, { predecessorId: a.id, successorId: b.id }),
    ).toThrow(/已存在依赖/);
  });

  it('拒绝跨项目依赖', () => {
    const { ctx, projectId } = fixture();
    const other = projectService.createProject(ctx, { name: '别的' });
    const a = taskService.createTask(ctx, { projectId, title: 'A' });
    const foreign = taskService.createTask(ctx, { projectId: other.id, title: 'F' });

    expect(() =>
      depService.addDependency(ctx, { predecessorId: foreign.id, successorId: a.id }),
    ).toThrow(/跨项目/);
  });

  it('未完成的前置任务会让后继"被阻塞"，完成后解除', () => {
    const { ctx, projectId, statuses } = fixture();
    const a = taskService.createTask(ctx, { projectId, title: 'A' });
    const b = taskService.createTask(ctx, { projectId, title: 'B' });
    depService.addDependency(ctx, { predecessorId: a.id, successorId: b.id });

    expect(taskService.getTaskDetail(ctx, b.id).blockedByCount).toBe(1);

    taskService.updateTask(ctx, a.id, { statusId: statuses.done });

    expect(taskService.getTaskDetail(ctx, b.id).blockedByCount).toBe(0);
  });

  it('删除依赖关系后阻塞解除', () => {
    const { ctx, projectId } = fixture();
    const a = taskService.createTask(ctx, { projectId, title: 'A' });
    const b = taskService.createTask(ctx, { projectId, title: 'B' });
    const dep = depService.addDependency(ctx, { predecessorId: a.id, successorId: b.id });

    depService.removeDependency(ctx, dep.id);

    expect(taskService.getTaskDetail(ctx, b.id).blockedByCount).toBe(0);
  });
});

describe('任务删除与还原', () => {
  it('有子任务的主任务不允许删除（这是规则，不是"再确认一次就能删"）', () => {
    const { ctx, projectId } = fixture();
    const root = taskService.createTask(ctx, { projectId, title: '一级' });
    const mid = taskService.createTask(ctx, { projectId, title: '二级', parentId: root.id });
    taskService.createTask(ctx, { projectId, title: '三级', parentId: mid.id });

    // 一级、二级都有子任务 → 都删不掉
    expect(() => taskService.softDeleteTask(ctx, root.id)).toThrowError(/还有 1 个子任务/);
    expect(() => taskService.softDeleteTask(ctx, mid.id)).toThrowError(/还有 1 个子任务/);

    // 拒绝必须是"什么都没发生"，而不是删了一半
    expect(taskService.listTasks(ctx, projectId).total).toBe(3);
    expect(taskService.getTaskDetail(ctx, mid.id).parent?.id).toBe(root.id);
  });

  it('拒绝时的错误里带着子任务数量，界面才能把话说明白', () => {
    const { ctx, projectId } = fixture();
    const root = taskService.createTask(ctx, { projectId, title: '一级' });
    taskService.createTask(ctx, { projectId, title: '子 A', parentId: root.id });
    taskService.createTask(ctx, { projectId, title: '子 B', parentId: root.id });

    try {
      taskService.softDeleteTask(ctx, root.id);
      throw new Error('本该被拒绝');
    } catch (error) {
      expect((error as { code?: string }).code).toBe('CONFLICT');
      expect((error as { details?: { childCount?: number } }).details?.childCount).toBe(2);
    }
  });

  it('没有子任务的任务可以正常删除；子任务删完后父任务也就可删了', () => {
    const { ctx, projectId } = fixture();
    const root = taskService.createTask(ctx, { projectId, title: '一级' });
    const child = taskService.createTask(ctx, { projectId, title: '二级', parentId: root.id });

    // 先删子任务（它自己没有子任务）
    expect(taskService.softDeleteTask(ctx, child.id).deleted).toBe(1);
    // 子任务进回收站后不再构成阻挡 —— 否则会出现"父任务永远删不掉"的死锁
    expect(taskService.softDeleteTask(ctx, root.id).deleted).toBe(1);
    expect(taskService.listTasks(ctx, projectId).total).toBe(0);
  });

  it('显式 cascade 会整枝删除（语义就是"我要删掉这一整枝"，不受上面那条规则限制）', () => {
    const { ctx, projectId } = fixture();
    const root = taskService.createTask(ctx, { projectId, title: '一级' });
    const mid = taskService.createTask(ctx, { projectId, title: '二级', parentId: root.id });
    taskService.createTask(ctx, { projectId, title: '三级', parentId: mid.id });

    const result = taskService.softDeleteTask(ctx, root.id, { cascade: true });

    expect(result.deleted).toBe(3);
    expect(taskService.listDeletedTasks(ctx, projectId)).toHaveLength(3);
  });

  it('还原级联删除的任务会带回整枝（用 deletedAt 相同来识别）', () => {
    const { ctx, projectId } = fixture();
    const root = taskService.createTask(ctx, { projectId, title: '一级' });
    const mid = taskService.createTask(ctx, { projectId, title: '二级', parentId: root.id });
    taskService.createTask(ctx, { projectId, title: '三级', parentId: mid.id });

    taskService.softDeleteTask(ctx, root.id, { cascade: true });
    expect(taskService.listDeletedTasks(ctx, projectId)).toHaveLength(3);

    taskService.restoreTask(ctx, root.id);

    expect(taskService.listDeletedTasks(ctx, projectId)).toHaveLength(0);
    expect(taskService.getTaskTree(ctx, projectId)).toHaveLength(1);
    expect(taskService.getTaskTree(ctx, projectId)[0]?.children[0]?.title).toBe('二级');
  });
});

describe('批量操作', () => {
  it('批量加标签与批量删除', () => {
    const ctx = makeCtx();
    const project = projectService.createProject(ctx, { name: 'P' });
    const a = taskService.createTask(ctx, { projectId: project.id, title: 'A' });
    const b = taskService.createTask(ctx, { projectId: project.id, title: 'B' });

    const tag = ctx.newId();
    ctx.sqlite
      .prepare(
        `INSERT INTO tags (id, project_id, name, color, created_at, updated_at)
         VALUES (?, ?, '标签', '#fff', 1, 1)`,
      )
      .run(tag, project.id);

    taskService.batchTasks(ctx, { ids: [a.id, b.id], action: 'addTags', tagIds: [tag] });
    expect(taskService.getTaskDetail(ctx, a.id).tagIds).toEqual([tag]);

    const result = taskService.batchTasks(ctx, { ids: [a.id, b.id], action: 'delete' });
    expect(result.affected).toBe(2);
    expect(result.skipped).toEqual([]);
    expect(taskService.listTasks(ctx, project.id).total).toBe(0);

    // 批量移除标签不应误删其他标签
    taskService.restoreTask(ctx, a.id);
    taskService.batchTasks(ctx, { ids: [a.id], action: 'removeTags', tagIds: [tag] });
    expect(taskService.getTaskDetail(ctx, a.id).tagIds).toEqual([]);
  });

  it('批量删除跳过有子任务的主任务：能删的照删，删不掉的如实上报', () => {
    const { ctx, projectId } = fixture();
    const parent = taskService.createTask(ctx, { projectId, title: '主任务' });
    taskService.createTask(ctx, { projectId, title: '子任务', parentId: parent.id });
    const lone = taskService.createTask(ctx, { projectId, title: '独立任务' });

    const result = taskService.batchTasks(ctx, {
      ids: [parent.id, lone.id],
      action: 'delete',
    });

    // 关键是"不整批失败"：20 个里混进 1 个主任务，不该把另外 19 个也一起废掉。
    // 但也不能静默跳过 —— 那就成了"假装删成功"。
    expect(result.affected).toBe(1);
    expect(result.skipped).toEqual([
      { id: parent.id, title: '主任务', reason: 'has_children', childCount: 1 },
    ]);
    // 主任务与它的子任务都还在
    expect(taskService.listTasks(ctx, projectId).total).toBe(2);
  });
});

describe('看板', () => {
  it('按状态分列，列内按序号排列，并给出计数', () => {
    const { ctx, projectId, statuses } = fixture();
    taskService.createTask(ctx, { projectId, title: 'A' });
    taskService.createTask(ctx, { projectId, title: 'B' });
    taskService.createTask(ctx, { projectId, title: 'C', statusId: statuses.doing });

    const board = taskService.getBoard(ctx, projectId);

    /*
     * 六态流程：待完成 / 正在修改 / 待审查 / 审查中 / 回退修改 / 已完成。
     * A、B 落在默认状态（待完成），C 被显式放进"正在修改"所在的列 ——
     * 断言的是**列的顺序与计数**，所以按现状取名字，不写死中文字面量。
     */
    expect(board.columns.map((c) => c.name)).toEqual(
      statuses.all.map((status) => status.name),
    );
    expect(board.columns.map((c) => c.taskCount)).toEqual([2, 1, 0, 0, 0, 0]);
    expect(board.columns[0]?.tasks.map((t) => t.title)).toEqual(['A', 'B']);
    expect(board.total).toBe(3);
  });

  it('已删除的任务不出现在看板上', () => {
    const { ctx, projectId } = fixture();
    const task = taskService.createTask(ctx, { projectId, title: 'A' });
    taskService.softDeleteTask(ctx, task.id);

    expect(taskService.getBoard(ctx, projectId).total).toBe(0);
  });
});

/**
 * 提交审核（用户 2026-10-02）：任务详情的「提交审核」按钮走的就是这一条。
 *
 * 三条要守住的东西：
 * 1. 真的落到「待审查」——而且那个状态 id 是**服务端按名字找出来的**，
 *    不是界面猜的（界面根本不知道这个状态叫什么）；
 * 2. 幂等：已经在那儿了再点一次不会报错、也不会刷新 `updatedAt`；
 * 3. 项目没有「待审查」时给出**可操作**的报错，而不是静默不改或 500。
 */
describe('提交审核', () => {
  it('把任务推进到「待审查」并记下这次变更', () => {
    const { ctx, projectId, statuses } = fixture();
    const task = taskService.createTask(ctx, { projectId, title: '等评审的活' });
    expect(task.statusId).toBe(statuses.todo);

    const submitted = taskService.submitForReview(ctx, task.id);

    const review = statuses.all.find((status) => status.name === '待审查');
    expect(review, '六态里应当有「待审查」').toBeTruthy();
    expect(submitted.statusId).toBe(review?.id);
    expect(submitted.statusCategory).toBe('doing');
    // 从「待完成」出发不是完成动作，所以不该有完成时间
    expect(submitted.completedAt).toBeNull();
  });

  it('已经处于「待审查」时是幂等的（不报错、不刷新更新时间）', () => {
    const { ctx, projectId } = fixture();
    const task = taskService.createTask(ctx, { projectId, title: '重复提交' });

    const first = taskService.submitForReview(ctx, task.id);
    const second = taskService.submitForReview(ctx, task.id);

    expect(second.statusId).toBe(first.statusId);
    expect(second.updatedAt).toBe(first.updatedAt);
  });

  it('项目里没有「待审查」时给出可操作的报错', () => {
    const { ctx, projectId } = fixture();
    const task = taskService.createTask(ctx, { projectId, title: '没有审核状态' });

    // 用户把「待审查」删掉（或改名）之后，这个按钮必须"说人话"
    const review = workflow
      .listStatuses(ctx, projectId)
      .find((status) => status.name === '待审查')!;
    workflow.deleteStatus(ctx, review.id);

    expect(() => taskService.submitForReview(ctx, task.id)).toThrow(/没有「待审查」状态/);
  });
});
