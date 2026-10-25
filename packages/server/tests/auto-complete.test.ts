import { afterEach, describe, expect, it } from 'vitest';

import { DbConnection } from '../src/db/connection';
import { createLogger } from '../src/logging/logger';
import { createServiceContext, type ServiceContext } from '../src/services/context';
import * as projectService from '../src/services/projects';
import { autoCompleteAncestors } from '../src/services/tasks';
import * as taskService from '../src/services/tasks';
import * as workflow from '../src/services/workflow-statuses';

/**
 * 「子任务全完成 → 父任务自动完成」（用户明确要的行为）。
 *
 * 这个行为最容易出问题的不是"该完成的没完成"，而是**不该完成的被完成了**：
 * 删掉最后一个未完成子任务、把子任务移走、父任务早就完成了 ——
 * 那些情况下父任务"自己动了"，用户会怀疑数据被改。所以反例写得比正例还多。
 */

const cleanups: Array<() => void> = [];

afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()?.();
});

let clock = 1_700_000_000_000;

interface Fixture {
  ctx: ServiceContext;
  projectId: string;
  statuses: { todo: string; doing: string; done: string };
}

function fixture(): Fixture {
  const conn = new DbConnection();
  conn.open(':memory:');
  const ctx = createServiceContext({
    conn,
    logger: createLogger({ source: 'api', minLevel: 'error' }),
    now: () => (clock += 1000),
  });
  cleanups.push(() => conn.close());

  const project = projectService.createProject(ctx, { name: '自动完成' });
  const list = workflow.listStatuses(ctx, project.id);
  const byCategory = (category: string) => list.find((s) => s.category === category)!.id;

  return {
    ctx,
    projectId: project.id,
    statuses: { todo: byCategory('todo'), doing: byCategory('doing'), done: byCategory('done') },
  };
}

/** 建一棵「主任务 → 两个子任务」的树 */
function tree(f: Fixture) {
  const parent = taskService.createTask(f.ctx, {
    projectId: f.projectId,
    title: '主任务',
    statusId: f.statuses.todo,
  });
  const a = taskService.createTask(f.ctx, {
    projectId: f.projectId,
    title: '子任务A',
    parentId: parent.id,
    statusId: f.statuses.todo,
  });
  const b = taskService.createTask(f.ctx, {
    projectId: f.projectId,
    title: '子任务B',
    parentId: parent.id,
    statusId: f.statuses.todo,
  });
  return { parent, a, b };
}

const statusOf = (f: Fixture, id: string): string | null =>
  taskService.getTaskDetail(f.ctx, id).statusId;

describe('子任务全完成 → 父任务自动完成', () => {
  it('最后一个子任务完成时，父任务也变成已完成', () => {
    const f = fixture();
    const { parent, a, b } = tree(f);

    // 只完成一个：父任务不该动
    taskService.updateTask(f.ctx, a.id, { statusId: f.statuses.done });
    expect(statusOf(f, parent.id)).toBe(f.statuses.todo);

    // 两个都完成 → 父任务自动完成
    taskService.updateTask(f.ctx, b.id, { statusId: f.statuses.done });
    expect(statusOf(f, parent.id)).toBe(f.statuses.done);
  });

  it('拖拽到"已完成"列同样会触发（拖拽是最常用的完成方式）', () => {
    const f = fixture();
    const { parent, a, b } = tree(f);

    taskService.moveTask(f.ctx, a.id, { statusId: f.statuses.done });
    taskService.moveTask(f.ctx, b.id, { statusId: f.statuses.done });

    expect(statusOf(f, parent.id)).toBe(f.statuses.done);
  });

  it('递归向上：子任务完成带动父任务，父任务完成再带动祖父任务', () => {
    const f = fixture();
    const root = taskService.createTask(f.ctx, {
      projectId: f.projectId,
      title: '祖父',
      statusId: f.statuses.todo,
    });
    const mid = taskService.createTask(f.ctx, {
      projectId: f.projectId,
      title: '父',
      parentId: root.id,
      statusId: f.statuses.todo,
    });
    const leaf = taskService.createTask(f.ctx, {
      projectId: f.projectId,
      title: '子',
      parentId: mid.id,
      statusId: f.statuses.todo,
    });

    taskService.updateTask(f.ctx, leaf.id, { statusId: f.statuses.done });

    expect(statusOf(f, mid.id)).toBe(f.statuses.done);
    expect(statusOf(f, root.id)).toBe(f.statuses.done);
  });

  it('父任务自己的完成时间被写上（不是留空）', () => {
    const f = fixture();
    const { parent, a, b } = tree(f);

    taskService.updateTask(f.ctx, a.id, { statusId: f.statuses.done });
    taskService.updateTask(f.ctx, b.id, { statusId: f.statuses.done });

    expect(taskService.getTaskDetail(f.ctx, parent.id).completedAt).not.toBeNull();
  });

  it('只在全部子任务都完成时才触发：还有一个没完成就不动', () => {
    const f = fixture();
    const { parent, a, b } = tree(f);

    taskService.updateTask(f.ctx, a.id, { statusId: f.statuses.done });
    taskService.updateTask(f.ctx, a.id, { statusId: f.statuses.doing }); // 又退回进行中
    taskService.updateTask(f.ctx, b.id, { statusId: f.statuses.done });

    expect(statusOf(f, parent.id)).toBe(f.statuses.todo);
  });

  it('并行的两条枝互不影响：另一枝没做完就不动', () => {
    const f = fixture();
    const { parent, a, b } = tree(f);
    const sibling = taskService.createTask(f.ctx, {
      projectId: f.projectId,
      title: '兄弟任务',
      statusId: f.statuses.todo,
    });

    taskService.updateTask(f.ctx, a.id, { statusId: f.statuses.done });
    taskService.updateTask(f.ctx, b.id, { statusId: f.statuses.done });

    // 父任务完成了，但它是顶层任务，没有更高的祖先要处理
    expect(statusOf(f, parent.id)).toBe(f.statuses.done);
    expect(statusOf(f, sibling.id)).toBe(f.statuses.todo);
  });

  it('反例：删掉最后一个未完成的子任务，父任务**不该**因此完成', () => {
    const f = fixture();
    const { parent, a, b } = tree(f);
    taskService.updateTask(f.ctx, a.id, { statusId: f.statuses.done });

    taskService.softDeleteTask(f.ctx, b.id); // 未完成的那个被删掉

    expect(statusOf(f, parent.id)).toBe(f.statuses.todo);
  });

  it('反例：把未完成的子任务移走（改挂到别的主任务下），父任务不该完成', () => {
    const f = fixture();
    const { parent, a, b } = tree(f);
    const other = taskService.createTask(f.ctx, {
      projectId: f.projectId,
      title: '另一个主任务',
      statusId: f.statuses.todo,
    });
    taskService.updateTask(f.ctx, a.id, { statusId: f.statuses.done });

    taskService.updateTask(f.ctx, b.id, { parentId: other.id });

    expect(statusOf(f, parent.id)).toBe(f.statuses.todo);
  });

  it('反例：父任务早就完成了，不会被反复改写完成时间', () => {
    const f = fixture();
    const { parent, a, b } = tree(f);
    taskService.updateTask(f.ctx, parent.id, { statusId: f.statuses.done });
    const completedAt = taskService.getTaskDetail(f.ctx, parent.id).completedAt;

    taskService.updateTask(f.ctx, a.id, { statusId: f.statuses.done });
    taskService.updateTask(f.ctx, b.id, { statusId: f.statuses.done });

    expect(taskService.getTaskDetail(f.ctx, parent.id).completedAt).toBe(completedAt);
  });

  it('反例：顶层任务（没有父任务）不受影响', () => {
    const f = fixture();
    const solo = taskService.createTask(f.ctx, {
      projectId: f.projectId,
      title: '独立任务',
      statusId: f.statuses.todo,
    });

    expect(autoCompleteAncestors(f.ctx, solo.id)).toEqual([]);
    expect(statusOf(f, solo.id)).toBe(f.statuses.todo);
  });

  it('会自动完成的时间与"谁改的"记进审计', () => {
    const f = fixture();
    const { parent, a, b } = tree(f);
    taskService.updateTask(f.ctx, a.id, { statusId: f.statuses.done });
    taskService.updateTask(f.ctx, b.id, { statusId: f.statuses.done });

    const rows = f.ctx.sqlite
      .prepare(
        "SELECT changes_json FROM activity_logs WHERE entity_id = ? AND action = 'update' ORDER BY created_at DESC",
      )
      .all(parent.id) as Array<{ changes_json: string }>;

    expect(rows.length).toBeGreaterThan(0);
    expect(rows[0]?.changes_json ?? '').toContain('autoCompletedByChildren');
  });

  it('新建时就标记为已完成的子任务，也会带动父任务', () => {
    const f = fixture();
    const parent = taskService.createTask(f.ctx, {
      projectId: f.projectId,
      title: '主任务',
      statusId: f.statuses.todo,
    });
    taskService.createTask(f.ctx, {
      projectId: f.projectId,
      title: '子任务A',
      parentId: parent.id,
      statusId: f.statuses.done,
    });
    taskService.createTask(f.ctx, {
      projectId: f.projectId,
      title: '子任务B',
      parentId: parent.id,
      statusId: f.statuses.done,
    });

    expect(statusOf(f, parent.id)).toBe(f.statuses.done);
  });
});

/**
 * 反方向：给已完成的主任务再加一个没做完的子任务。
 *
 * 没有这条的话，主任务会一直停在"已完成"，而底下挂着没做完的子任务 ——
 * 看板就在说谎。两者必须成对，否则"自动完成"会造出一个稳定但错误的状态。
 */
describe('新增未完成子任务 → 已完成的主任务重新打开', () => {
  it('父任务自动完成后，再加一个未完成子任务会把它打开', () => {
    const f = fixture();
    const parent = taskService.createTask(f.ctx, {
      projectId: f.projectId,
      title: '主任务',
      statusId: f.statuses.todo,
    });
    taskService.createTask(f.ctx, {
      projectId: f.projectId,
      title: '子任务A',
      parentId: parent.id,
      statusId: f.statuses.done,
    });
    expect(statusOf(f, parent.id)).toBe(f.statuses.done); // 唯一的子任务完成了

    taskService.createTask(f.ctx, {
      projectId: f.projectId,
      title: '新加的后续工作',
      parentId: parent.id,
      statusId: f.statuses.todo,
    });

    expect(statusOf(f, parent.id)).toBe(f.statuses.todo);
  });

  it('重新打开时完成时间被清掉（否则"完成时间"比状态还新，看着矛盾）', () => {
    const f = fixture();
    const parent = taskService.createTask(f.ctx, {
      projectId: f.projectId,
      title: '主任务',
      statusId: f.statuses.todo,
    });
    taskService.createTask(f.ctx, {
      projectId: f.projectId,
      title: '子任务A',
      parentId: parent.id,
      statusId: f.statuses.done,
    });
    expect(taskService.getTaskDetail(f.ctx, parent.id).completedAt).not.toBeNull();

    taskService.createTask(f.ctx, {
      projectId: f.projectId,
      title: '新加的后续工作',
      parentId: parent.id,
      statusId: f.statuses.todo,
    });

    expect(taskService.getTaskDetail(f.ctx, parent.id).completedAt).toBeNull();
  });

  it('递归向上：祖父任务也一起被打开', () => {
    const f = fixture();
    const root = taskService.createTask(f.ctx, {
      projectId: f.projectId,
      title: '祖父',
      statusId: f.statuses.todo,
    });
    const mid = taskService.createTask(f.ctx, {
      projectId: f.projectId,
      title: '父',
      parentId: root.id,
      statusId: f.statuses.todo,
    });
    taskService.createTask(f.ctx, {
      projectId: f.projectId,
      title: '子',
      parentId: mid.id,
      statusId: f.statuses.done,
    });
    expect(statusOf(f, mid.id)).toBe(f.statuses.done);
    expect(statusOf(f, root.id)).toBe(f.statuses.done);

    taskService.createTask(f.ctx, {
      projectId: f.projectId,
      title: '新活',
      parentId: mid.id,
      statusId: f.statuses.todo,
    });

    expect(statusOf(f, mid.id)).toBe(f.statuses.todo);
    expect(statusOf(f, root.id)).toBe(f.statuses.todo);
  });

  it('反例：主任务本来就没完成，新增子任务不会动它的状态', () => {
    const f = fixture();
    const parent = taskService.createTask(f.ctx, {
      projectId: f.projectId,
      title: '进行中的主任务',
      statusId: f.statuses.doing,
    });

    taskService.createTask(f.ctx, {
      projectId: f.projectId,
      title: '子任务',
      parentId: parent.id,
      statusId: f.statuses.todo,
    });

    expect(statusOf(f, parent.id)).toBe(f.statuses.doing);
  });

  it('反例：新增的子任务本身就是"已完成"，不该把父任务打开', () => {
    const f = fixture();
    const parent = taskService.createTask(f.ctx, {
      projectId: f.projectId,
      title: '主任务',
      statusId: f.statuses.todo,
    });
    taskService.createTask(f.ctx, {
      projectId: f.projectId,
      title: '子任务A',
      parentId: parent.id,
      statusId: f.statuses.done,
    });
    expect(statusOf(f, parent.id)).toBe(f.statuses.done);

    taskService.createTask(f.ctx, {
      projectId: f.projectId,
      title: '子任务B',
      parentId: parent.id,
      statusId: f.statuses.done,
    });

    // 仍然是已完成，且不该被"打开又关上"
    expect(statusOf(f, parent.id)).toBe(f.statuses.done);
  });
});
