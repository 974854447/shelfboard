import { afterEach, describe, expect, it } from 'vitest';

import { DbConnection } from '../src/db/connection';
import { createLogger } from '../src/logging/logger';
import { createServiceContext, type ServiceContext } from '../src/services/context';
import * as relationService from '../src/services/project-relations';
import * as projectService from '../src/services/projects';
import { listActivity } from '../src/services/activity';

/**
 * 项目间关系链（需求 §5.2.1，**纯展示**）。
 *
 * 这里要盯住两件事：
 * 1. **能做**：标一条关系、两个方向都查得到、改名称、删掉、项目硬删除时跟着清掉；
 * 2. **不做**：不做任何联动 —— 这条不是靠"没写代码"来保证的，
 *    而是靠"表里没有可联动的字段 + 服务里没有任何跨项目写入"来保证，
 *    所以用例里顺带断言"标了关系之后，另一个项目的任务/状态/标签一点没变"。
 */

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()?.();
});

function makeCtx(): ServiceContext {
  const conn = new DbConnection();
  conn.open(':memory:');
  const ctx = createServiceContext({
    conn,
    logger: createLogger({ source: 'api', minLevel: 'error' }),
  });
  cleanups.push(() => conn.close());
  return ctx;
}

function twoProjects(ctx: ServiceContext): { front: string; back: string } {
  const front = projectService.createProject(ctx, { name: '前端项目', codeKind: 'frontend' });
  const back = projectService.createProject(ctx, { name: '后端项目', codeKind: 'backend' });
  return { front: front.id, back: back.id };
}

describe('标一条关系', () => {
  it('关系名是**自由填**的，方向是两个端点（前端 → 调用 → 后端）', () => {
    const ctx = makeCtx();
    const { front, back } = twoProjects(ctx);

    const relation = relationService.createRelation(ctx, front, {
      toProjectId: back,
      label: '调用',
      note: '前端通过 /api 调后端',
    });

    expect(relation.label).toBe('调用');
    expect(relation.from.name).toBe('前端项目');
    expect(relation.to.name).toBe('后端项目');
    expect(relation.direction).toBe('outgoing');
    expect(relation.note).toBe('前端通过 /api 调后端');
  });

  it('两个方向都查得到（否则后端项目那一页看不到"谁在调我"）', () => {
    const ctx = makeCtx();
    const { front, back } = twoProjects(ctx);
    relationService.createRelation(ctx, front, { toProjectId: back, label: '调用' });

    const fromFront = relationService.listRelationsForProject(ctx, front);
    const fromBack = relationService.listRelationsForProject(ctx, back);

    expect(fromFront).toHaveLength(1);
    expect(fromBack).toHaveLength(1);
    expect(fromFront[0]?.direction).toBe('outgoing');
    expect(fromBack[0]?.direction).toBe('incoming');
    // 同一个项目页上"别人指向我"也要能显示出对方是谁
    expect(fromBack[0]?.from.name).toBe('前端项目');
  });

  it('不能连到自己', () => {
    const ctx = makeCtx();
    const { front } = twoProjects(ctx);
    expect(() =>
      relationService.createRelation(ctx, front, { toProjectId: front, label: '调用' }),
    ).toThrow(/不能把项目连到它自己/);
  });

  it('同一条关系不能重复（同端点 + 同名），但换个名字可以', () => {
    const ctx = makeCtx();
    const { front, back } = twoProjects(ctx);
    relationService.createRelation(ctx, front, { toProjectId: back, label: '调用' });

    expect(() =>
      relationService.createRelation(ctx, front, { toProjectId: back, label: '调用' }),
    ).toThrow(/已经有一条/);

    // 反向、以及同名反向都是**允许**的：关系只用来画线，不做环检测
    relationService.createRelation(ctx, front, { toProjectId: back, label: '同属一个系统' });
    relationService.createRelation(ctx, back, { toProjectId: front, label: '调用' });
    expect(relationService.listRelationsForProject(ctx, front)).toHaveLength(3);
  });

  it('名称与备注有上限，去空格；不存在的项目要被挡住', () => {
    const ctx = makeCtx();
    const { front, back } = twoProjects(ctx);

    const trimmed = relationService.createRelation(ctx, front, {
      toProjectId: back,
      label: '  调用  ',
    });
    expect(trimmed.label).toBe('调用');

    expect(() =>
      relationService.createRelation(ctx, front, { toProjectId: back, label: 'x'.repeat(41) }),
    ).toThrow(/不能超过/);
    expect(() =>
      relationService.createRelation(ctx, front, {
        toProjectId: back,
        label: '调用',
        note: 'y'.repeat(201),
      }),
    ).toThrow(/备注不能超过/);
    expect(() =>
      relationService.createRelation(ctx, front, { toProjectId: 'nope', label: '调用' }),
    ).toThrow(/不存在或已删除/);
  });

  it('被软删除（进回收站）的项目不能作为端点', () => {
    const ctx = makeCtx();
    const { front, back } = twoProjects(ctx);
    projectService.softDeleteProject(ctx, back);

    expect(() =>
      relationService.createRelation(ctx, front, { toProjectId: back, label: '调用' }),
    ).toThrow(/不存在或已删除/);
  });

  it('卡片小结：每个项目几条关系、叫什么名字（两个端都算）', () => {
    const ctx = makeCtx();
    const { front, back } = twoProjects(ctx);
    const third = projectService.createProject(ctx, { name: '管理端' });

    relationService.createRelation(ctx, front, { toProjectId: back, label: '调用' });
    relationService.createRelation(ctx, third.id, { toProjectId: back, label: '调用' });

    const summary = relationService.summarizeRelations(ctx);
    expect(summary[back]).toEqual({ count: 2, labels: ['调用'] });
    expect(summary[front]).toEqual({ count: 1, labels: ['调用'] });
    expect(summary[third.id]).toEqual({ count: 1, labels: ['调用'] });
    // 没有关系的项目不该出现在小结里（界面据此判断"要不要显示这个标记"）
    expect(summary['不存在的项目']).toBeUndefined();
  });
});

describe('改与删', () => {
  it('改名称与备注，并留下活动记录', () => {
    const ctx = makeCtx();
    const { front, back } = twoProjects(ctx);
    const relation = relationService.createRelation(ctx, front, { toProjectId: back, label: '调用' });

    const updated = relationService.updateRelation(ctx, relation.id, { label: '依赖' });
    expect(updated.label).toBe('依赖');

    const activity = listActivity(ctx, { projectId: front, limit: 20 });
    expect(activity.some((entry) => entry.entityType === 'project_relation')).toBe(true);
  });

  it('删掉之后就查不到了', () => {
    const ctx = makeCtx();
    const { front, back } = twoProjects(ctx);
    const relation = relationService.createRelation(ctx, front, { toProjectId: back, label: '调用' });

    expect(relationService.deleteRelation(ctx, relation.id)).toEqual({ deleted: true });
    expect(relationService.listRelationsForProject(ctx, front)).toEqual([]);
    expect(() => relationService.deleteRelation(ctx, relation.id)).toThrow(/不存在/);
  });

  it('软删除项目时关系**保留**（恢复项目之后关系还在）', () => {
    const ctx = makeCtx();
    const { front, back } = twoProjects(ctx);
    relationService.createRelation(ctx, front, { toProjectId: back, label: '调用' });

    projectService.softDeleteProject(ctx, back);
    // 前端那一页仍然看得到这条关系（对方在回收站里，界面上会标出来）
    const relations = relationService.listRelationsForProject(ctx, front);
    expect(relations).toHaveLength(1);

    projectService.restoreProject(ctx, back);
    expect(relationService.listRelationsForProject(ctx, back)).toHaveLength(1);
  });

  it('**物理删除**项目时关系跟着清掉，并在对方项目上留一笔活动', () => {
    const ctx = makeCtx();
    const { front, back } = twoProjects(ctx);
    relationService.createRelation(ctx, front, { toProjectId: back, label: '调用' });

    projectService.hardDeleteProject(ctx, back);

    // 关系没了（否则会留下一条指向不存在项目的线）
    expect(relationService.listRelationsForProject(ctx, front)).toEqual([]);
    // 活着的那一端留下了痕迹
    const activity = listActivity(ctx, { projectId: front, limit: 50 });
    expect(
      activity.some(
        (entry) => entry.entityType === 'project_relation' && entry.action === 'delete',
      ),
    ).toBe(true);
  });
});

describe('**不做联动**（需求 §5.2.1 的硬要求）', () => {
  it('标了关系之后，两个项目的任务/状态/标签一点没变', () => {
    const ctx = makeCtx();
    const { front, back } = twoProjects(ctx);

    const before = {
      frontStatuses: ctx.sqlite
        .prepare('SELECT COUNT(*) AS n FROM workflow_statuses WHERE project_id = ?')
        .get(front),
      backStatuses: ctx.sqlite
        .prepare('SELECT COUNT(*) AS n FROM workflow_statuses WHERE project_id = ?')
        .get(back),
      backTasks: ctx.sqlite
        .prepare('SELECT COUNT(*) AS n FROM tasks WHERE project_id = ?')
        .get(back),
    };

    relationService.createRelation(ctx, front, { toProjectId: back, label: '调用' });

    expect(
      ctx.sqlite
        .prepare('SELECT COUNT(*) AS n FROM workflow_statuses WHERE project_id = ?')
        .get(front),
    ).toEqual(before.frontStatuses);
    expect(
      ctx.sqlite
        .prepare('SELECT COUNT(*) AS n FROM workflow_statuses WHERE project_id = ?')
        .get(back),
    ).toEqual(before.backStatuses);
    expect(
      ctx.sqlite.prepare('SELECT COUNT(*) AS n FROM tasks WHERE project_id = ?').get(back),
    ).toEqual(before.backTasks);
  });

  it('关系表里没有"会联动"的字段（只有两个端点 + 一句说明）', () => {
    const ctx = makeCtx();
    const columns = ctx.sqlite
      .prepare(`PRAGMA table_info('project_relations')`)
      .all()
      .map((row) => (row as { name: string }).name)
      .sort();

    expect(columns).toEqual([
      'created_at',
      'from_project_id',
      'id',
      'label',
      'note',
      'to_project_id',
      'updated_at',
    ]);
  });
});
