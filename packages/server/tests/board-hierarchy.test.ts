import { afterEach, describe, expect, it } from 'vitest';

import { DbConnection } from '../src/db/connection';
import { createLogger } from '../src/logging/logger';
import { createServiceContext } from '../src/services/context';
import * as projectService from '../src/services/projects';
import * as taskService from '../src/services/tasks';
import * as workflow from '../src/services/workflow-statuses';

/**
 * 看板列内排序（子任务吸附到父任务下方）。
 *
 * 为什么值得单独测：这份顺序**同时决定拖拽落点** ——
 * 如果只是"渲染时看起来分了组"，拖拽时前后邻居算的是另一套顺序，
 * 落点就会和看到的位置对不上，而且这种错很难复现、更难定位。
 */

const cleanups: Array<() => void> = [];

afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()?.();
});

let clock = 1_700_000_000_000;

function setup() {
  const conn = new DbConnection();
  conn.open(':memory:');
  const ctx = createServiceContext({
    conn,
    logger: createLogger({ source: 'api', minLevel: 'error' }),
    now: () => (clock += 1000),
  });
  cleanups.push(() => conn.close());

  const project = projectService.createProject(ctx, { name: '看板层级' });
  const list = workflow.listStatuses(ctx, project.id);
  const statuses = {
    todo: list.find((s) => s.category === 'todo')!.id,
    doing: list.find((s) => s.category === 'doing')!.id,
    done: list.find((s) => s.category === 'done')!.id,
  };
  return { ctx, projectId: project.id, statuses };
}

const titles = (column: { tasks: Array<{ title: string }> }) => column.tasks.map((t) => t.title);

describe('看板列内排序', () => {
  it('子任务被吸附到父任务下方（哪怕它们原本不相邻）', () => {
    const f = setup();
    const parent = taskService.createTask(f.ctx, {
      projectId: f.projectId,
      title: '主任务',
      statusId: f.statuses.todo,
    });
    // 中间夹一个无关任务，制造"原本不相邻"
    taskService.createTask(f.ctx, {
      projectId: f.projectId,
      title: '无关任务',
      statusId: f.statuses.todo,
    });
    taskService.createTask(f.ctx, {
      projectId: f.projectId,
      title: '子任务',
      parentId: parent.id,
      statusId: f.statuses.todo,
    });

    const board = taskService.getBoard(f.ctx, f.projectId);
    const column = board.columns.find((c) => c.statusId === f.statuses.todo)!;

    expect(titles(column)).toEqual(['主任务', '子任务', '无关任务']);
  });

  it('多层：同级在前、层级递增，整枝连续', () => {
    const f = setup();
    const root = taskService.createTask(f.ctx, {
      projectId: f.projectId,
      title: '一层',
      statusId: f.statuses.todo,
    });
    const mid = taskService.createTask(f.ctx, {
      projectId: f.projectId,
      title: '二层',
      parentId: root.id,
      statusId: f.statuses.todo,
    });
    taskService.createTask(f.ctx, {
      projectId: f.projectId,
      title: '三层',
      parentId: mid.id,
      statusId: f.statuses.todo,
    });
    taskService.createTask(f.ctx, {
      projectId: f.projectId,
      title: '另一枝',
      statusId: f.statuses.todo,
    });

    const board = taskService.getBoard(f.ctx, f.projectId);
    const column = board.columns.find((c) => c.statusId === f.statuses.todo)!;

    expect(titles(column)).toEqual(['一层', '二层', '三层', '另一枝']);
  });

  it('组间保持用户拖出来的相对次序（枝根的位置决定整枝的位置）', () => {
    const f = setup();
    const first = taskService.createTask(f.ctx, {
      projectId: f.projectId,
      title: 'A',
      statusId: f.statuses.todo,
    });
    const second = taskService.createTask(f.ctx, {
      projectId: f.projectId,
      title: 'B',
      statusId: f.statuses.todo,
    });
    taskService.createTask(f.ctx, {
      projectId: f.projectId,
      title: 'A-子',
      parentId: first.id,
      statusId: f.statuses.todo,
    });

    // 把 B 拖到 A 前面
    taskService.moveTask(f.ctx, second.id, {
      statusId: f.statuses.todo,
      beforeTaskId: first.id,
    });

    const board = taskService.getBoard(f.ctx, f.projectId);
    const column = board.columns.find((c) => c.statusId === f.statuses.todo)!;

    // B 在前（它是被拖到最前的枝根），A 与它的子任务仍然连续
    expect(titles(column)).toEqual(['B', 'A', 'A-子']);
  });

  it('跨列的子任务不会被拉到自己列的最前面（父任务不在本列，就没有"上方"可吸附）', () => {
    const f = setup();
    const parent = taskService.createTask(f.ctx, {
      projectId: f.projectId,
      title: '父在别的列',
      statusId: f.statuses.doing,
    });
    taskService.createTask(f.ctx, {
      projectId: f.projectId,
      title: '本列第一个',
      statusId: f.statuses.todo,
    });
    taskService.createTask(f.ctx, {
      projectId: f.projectId,
      title: '跨列的子任务',
      parentId: parent.id,
      statusId: f.statuses.todo,
    });

    const board = taskService.getBoard(f.ctx, f.projectId);
    const column = board.columns.find((c) => c.statusId === f.statuses.todo)!;

    expect(titles(column)).toEqual(['本列第一个', '跨列的子任务']);
  });

  it('列内没有父子关系时，顺序原样不动', () => {
    const f = setup();
    taskService.createTask(f.ctx, { projectId: f.projectId, title: '甲', statusId: f.statuses.todo });
    taskService.createTask(f.ctx, { projectId: f.projectId, title: '乙', statusId: f.statuses.todo });
    taskService.createTask(f.ctx, { projectId: f.projectId, title: '丙', statusId: f.statuses.todo });

    const board = taskService.getBoard(f.ctx, f.projectId);
    const column = board.columns.find((c) => c.statusId === f.statuses.todo)!;

    expect(titles(column)).toEqual(['甲', '乙', '丙']);
  });
});

describe('board 契约', () => {
  it('taskCount 与实际卡片数一致（排序不该改变计数）', () => {
    const f = setup();
    const parent = taskService.createTask(f.ctx, {
      projectId: f.projectId,
      title: '主',
      statusId: f.statuses.todo,
    });
    taskService.createTask(f.ctx, {
      projectId: f.projectId,
      title: '子一',
      parentId: parent.id,
      statusId: f.statuses.todo,
    });
    taskService.createTask(f.ctx, {
      projectId: f.projectId,
      title: '子二',
      parentId: parent.id,
      statusId: f.statuses.todo,
    });

    const board = taskService.getBoard(f.ctx, f.projectId);
    const column = board.columns.find((c) => c.statusId === f.statuses.todo)!;

    expect(column.taskCount).toBe(3);
    expect(column.tasks).toHaveLength(3);
    expect(board.total).toBe(3);
  });
});
