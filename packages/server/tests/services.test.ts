import { afterEach, describe, expect, it } from 'vitest';

import { AppError } from '@pm-studio/shared';

import { DbConnection } from '../src/db/connection';
import { tasks } from '../src/db/schema';
import { createLogger } from '../src/logging/logger';
import { listActivity } from '../src/services/activity';
import { createServiceContext, type ServiceContext } from '../src/services/context';
import * as milestoneService from '../src/services/milestones';
import * as projectService from '../src/services/projects';
import * as tagService from '../src/services/tags';
import * as workflow from '../src/services/workflow-statuses';

const cleanups: Array<() => void> = [];

afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()?.();
});

let clock = 1_700_000_000_000;

function makeCtx(): ServiceContext {
  const conn = new DbConnection();
  conn.open(':memory:');
  const logger = createLogger({ source: 'api', minLevel: 'error' });
  // 注入单调递增的时钟：让 id 与时间戳可预测，断言才稳定
  const ctx = createServiceContext({ conn, logger, now: () => (clock += 1000) });
  cleanups.push(() => conn.close());
  return ctx;
}

/** 直接插一条任务（任务服务在下一轮，这里只需要数据在场） */
function insertTask(ctx: ServiceContext, projectId: string, statusId: string | null, title: string): string {
  const id = ctx.newId();
  ctx.db
    .insert(tasks)
    .values({
      id,
      projectId,
      statusId,
      title,
      createdAt: ctx.now(),
      updatedAt: ctx.now(),
    })
    .run();
  return id;
}

describe('项目服务', () => {
  it('创建项目会自动铺好默认工作流（否则看板建出来是空的）', () => {
    const ctx = makeCtx();
    const project = projectService.createProject(ctx, { name: '前端重构' });

    const statuses = workflow.listStatuses(ctx, project.id);
    /*
     * 用户 2026-10-02 定的六态流程（取代原来的"待处理/进行中/已完成"三态 + 进度条）。
     * 分类仍然只有三种：只有分类为 done 的那一个算"做完了"，
     * 其余四态都是"在做"，这样所有按分类判断的逻辑（今日待办、工作日志）不用改。
     */
    expect(statuses.map((s) => s.name)).toEqual([
      '待完成',
      '正在修改',
      '待审查',
      '审查中',
      '回退修改',
      '已完成',
    ]);
    expect(statuses.map((s) => s.category)).toEqual(['todo', 'doing', 'doing', 'doing', 'doing', 'done']);
    expect(statuses.filter((s) => s.isDefault)).toHaveLength(1);
    expect(statuses[0]?.isDefault).toBe(true);
  });

  it('排序号留有间隔，便于日后中间插入', () => {
    const ctx = makeCtx();
    const project = projectService.createProject(ctx, { name: 'P' });
    const orders = workflow.listStatuses(ctx, project.id).map((s) => s.sortOrder);
    expect(orders).toEqual([1000, 2000, 3000, 4000, 5000, 6000]);
  });

  it('多个项目的排序号递增', () => {
    const ctx = makeCtx();
    const a = projectService.createProject(ctx, { name: 'A' });
    const b = projectService.createProject(ctx, { name: 'B' });
    expect(b.sortOrder).toBeGreaterThan(a.sortOrder);
  });

  it('列表默认隐藏归档与已删除项目', () => {
    const ctx = makeCtx();
    const active = projectService.createProject(ctx, { name: '活跃' });
    const archived = projectService.createProject(ctx, { name: '归档' });
    const removed = projectService.createProject(ctx, { name: '已删' });

    projectService.setProjectStatus(ctx, archived.id, 'archived');
    projectService.softDeleteProject(ctx, removed.id);

    expect(projectService.listProjects(ctx).map((p) => p.name)).toEqual(['活跃']);
    expect(
      projectService.listProjects(ctx, { includeArchived: true }).map((p) => p.name),
    ).toEqual(['活跃', '归档']);
    expect(
      projectService.listProjects(ctx, { includeArchived: true, includeDeleted: true }),
    ).toHaveLength(3);
    expect(active.id).toBeTruthy();
  });

  it('软删除后进回收站，还原可以完整恢复', () => {
    const ctx = makeCtx();
    const project = projectService.createProject(ctx, { name: 'P' });
    insertTask(ctx, project.id, workflow.getDefaultStatus(ctx, project.id)!.id, '任务一');

    projectService.softDeleteProject(ctx, project.id);
    expect(() => projectService.getProjectOrThrow(ctx, project.id)).toThrow(AppError);

    projectService.restoreProject(ctx, project.id);
    expect(projectService.getProjectOrThrow(ctx, project.id).deletedAt).toBeNull();
    // 任务没有被级联软删，还原项目后依然在
    expect(ctx.sqlite.prepare('SELECT COUNT(*) AS c FROM tasks').get()).toEqual({ c: 1 });
  });

  it('物理删除会级联清掉状态、标签与任务', () => {
    const ctx = makeCtx();
    const project = projectService.createProject(ctx, { name: 'P' });
    const status = workflow.getDefaultStatus(ctx, project.id)!;
    insertTask(ctx, project.id, status.id, '任务一');
    tagService.createTag(ctx, { name: '紧急' }, project.id);

    projectService.hardDeleteProject(ctx, project.id);

    expect(ctx.sqlite.prepare('SELECT COUNT(*) AS c FROM projects').get()).toEqual({ c: 0 });
    expect(ctx.sqlite.prepare('SELECT COUNT(*) AS c FROM workflow_statuses').get()).toEqual({
      c: 0,
    });
    expect(ctx.sqlite.prepare('SELECT COUNT(*) AS c FROM tasks').get()).toEqual({ c: 0 });
    expect(ctx.sqlite.prepare('SELECT COUNT(*) AS c FROM tags').get()).toEqual({ c: 0 });
  });

  it('修改项目只记录真正变化的字段', () => {
    const ctx = makeCtx();
    const project = projectService.createProject(ctx, { name: 'P', color: '#ffffff' });

    projectService.updateProject(ctx, project.id, { name: 'P2', color: '#ffffff' });

    const activity = listActivity(ctx, { entityId: project.id, entityType: 'project' });
    const update = activity.find((a) => a.action === 'update')!;
    const changes = JSON.parse(update.changesJson ?? '{}') as Record<string, unknown>;
    // color 传了但没变 → 不应出现
    expect(Object.keys(changes)).toEqual(['name']);
  });

  it('没有任何实际变化时不写库也不记日志（避免无意义的 updated_at 变动）', () => {
    const ctx = makeCtx();
    const project = projectService.createProject(ctx, { name: 'P' });
    const before = listActivity(ctx, { entityId: project.id }).length;

    const after = projectService.updateProject(ctx, project.id, { name: 'P' });

    expect(after.updatedAt).toBe(project.updatedAt);
    expect(listActivity(ctx, { entityId: project.id })).toHaveLength(before);
  });

  it('不存在的项目抛 NOT_FOUND 而不是返回空对象', () => {
    const ctx = makeCtx();
    expect(() => projectService.getProjectOrThrow(ctx, 'nope')).toThrow(AppError);
    try {
      projectService.getProjectOrThrow(ctx, 'nope');
    } catch (error) {
      expect((error as AppError).code).toBe('NOT_FOUND');
    }
  });
});

describe('工作流状态服务', () => {
  it('新增状态追加到末尾', () => {
    const ctx = makeCtx();
    const project = projectService.createProject(ctx, { name: 'P' });
    const created = workflow.createStatus(ctx, project.id, { name: '待验收', category: 'doing' });

    const statuses = workflow.listStatuses(ctx, project.id);
    expect(statuses.map((s) => s.name)).toEqual([
      '待完成',
      '正在修改',
      '待审查',
      '审查中',
      '回退修改',
      '已完成',
      '待验收',
    ]);
    expect(created.sortOrder).toBe(7000);
  });

  it('把某个状态设为默认时，其余状态的默认标记被清除（有且仅有一个）', () => {
    const ctx = makeCtx();
    const project = projectService.createProject(ctx, { name: 'P' });
    const doing = workflow.listStatuses(ctx, project.id).find((s) => s.category === 'doing')!;

    workflow.updateStatus(ctx, doing.id, { isDefault: true });

    const statuses = workflow.listStatuses(ctx, project.id);
    expect(statuses.filter((s) => s.isDefault)).toHaveLength(1);
    expect(workflow.getDefaultStatus(ctx, project.id)?.id).toBe(doing.id);
  });

  it('不能把唯一的默认状态取消掉（否则新建任务没有落点）', () => {
    const ctx = makeCtx();
    const project = projectService.createProject(ctx, { name: 'P' });
    const todo = workflow.getDefaultStatus(ctx, project.id)!;

    workflow.updateStatus(ctx, todo.id, { isDefault: false });

    expect(workflow.listStatuses(ctx, project.id).filter((s) => s.isDefault)).toHaveLength(1);
  });

  it('删除状态前会把任务迁到同分类的状态（而不是让任务失去状态）', () => {
    const ctx = makeCtx();
    const project = projectService.createProject(ctx, { name: 'P' });
    const doing = workflow.listStatuses(ctx, project.id).find((s) => s.category === 'doing')!;
    const extraTodo = workflow.createStatus(ctx, project.id, { name: '待办二', category: 'todo' });

    const taskId = insertTask(ctx, project.id, extraTodo.id, '任务');

    const result = workflow.deleteStatus(ctx, extraTodo.id);

    expect(result.movedTasks).toBe(1);
    const row = ctx.sqlite.prepare('SELECT status_id FROM tasks WHERE id = ?').get(taskId) as {
      status_id: string;
    };
    // 迁到了同分类（todo）的"待处理"
    const target = workflow.findStatus(ctx, row.status_id)!;
    expect(target.category).toBe('todo');
    expect(target.id).not.toBe(extraTodo.id);
    expect(doing.id).toBeTruthy();
  });

  it('可以显式指定迁移目标，且会校验它属于同一项目', () => {
    const ctx = makeCtx();
    const projectA = projectService.createProject(ctx, { name: 'A' });
    const projectB = projectService.createProject(ctx, { name: 'B' });

    const extra = workflow.createStatus(ctx, projectA.id, { name: '临时', category: 'doing' });
    const taskId = insertTask(ctx, projectA.id, extra.id, '任务');
    const foreign = workflow.listStatuses(ctx, projectB.id)[0]!;

    expect(() => workflow.deleteStatus(ctx, extra.id, { moveTasksTo: foreign.id })).toThrow(
      /不属于该项目/,
    );

    const own = workflow.listStatuses(ctx, projectA.id).find((s) => s.id !== extra.id)!;
    workflow.deleteStatus(ctx, extra.id, { moveTasksTo: own.id });
    const row = ctx.sqlite.prepare('SELECT status_id FROM tasks WHERE id = ?').get(taskId) as {
      status_id: string;
    };
    expect(row.status_id).toBe(own.id);
  });

  it('拒绝删除最后一个状态', () => {
    const ctx = makeCtx();
    const project = projectService.createProject(ctx, { name: 'P' });
    const statuses = workflow.listStatuses(ctx, project.id);
    // 六态流程下要删到只剩一个才触发这条规则（原来三态时删两个就够了）
    for (const status of statuses.slice(1)) workflow.deleteStatus(ctx, status.id);

    expect(() => workflow.deleteStatus(ctx, statuses[0]!.id)).toThrow(/至少要保留一个/);
  });

  it('删除默认状态后，默认标记会交给迁移目标', () => {
    const ctx = makeCtx();
    const project = projectService.createProject(ctx, { name: 'P' });
    const todo = workflow.getDefaultStatus(ctx, project.id)!;

    workflow.deleteStatus(ctx, todo.id);

    const remaining = workflow.listStatuses(ctx, project.id);
    expect(remaining.filter((s) => s.isDefault)).toHaveLength(1);
  });

  it('重排要求传入全部状态（只传子集是歧义的）', () => {
    const ctx = makeCtx();
    const project = projectService.createProject(ctx, { name: 'P' });
    const statuses = workflow.listStatuses(ctx, project.id);

    expect(() => workflow.reorderStatuses(ctx, project.id, [statuses[0]!.id])).toThrow(
      /必须包含该项目的全部/,
    );
  });

  it('重排会重算间隔并落库', () => {
    const ctx = makeCtx();
    const project = projectService.createProject(ctx, { name: 'P' });
    const before = workflow.listStatuses(ctx, project.id);
    // 把最后一个（已完成）挪到最前面，其余保持相对顺序
    const wanted = [before.at(-1)!, ...before.slice(0, -1)];

    const reordered = workflow.reorderStatuses(ctx, project.id, wanted.map((s) => s.id));

    expect(reordered.map((s) => s.name)).toEqual(wanted.map((s) => s.name));
    expect(reordered.map((s) => s.sortOrder)).toEqual(wanted.map((_, index) => (index + 1) * 1000));
  });

  it('重排拒绝重复 id', () => {
    const ctx = makeCtx();
    const project = projectService.createProject(ctx, { name: 'P' });
    const statuses = workflow.listStatuses(ctx, project.id);
    expect(() =>
      workflow.reorderStatuses(ctx, project.id, [statuses[0]!.id, statuses[0]!.id, statuses[1]!.id]),
    ).toThrow(/重复/);
  });

  it('套用模板时按分类迁移任务（已完成的任务仍落在已完成列）', () => {
    const ctx = makeCtx();
    const project = projectService.createProject(ctx, { name: 'P' });
    const oldDone = workflow.listStatuses(ctx, project.id).find((s) => s.category === 'done')!;
    const doneTask = insertTask(ctx, project.id, oldDone.id, '已经做完的任务');
    const doingTask = insertTask(
      ctx,
      project.id,
      workflow.listStatuses(ctx, project.id).find((s) => s.category === 'doing')!.id,
      '正在做的任务',
    );

    const applied = workflow.applyDefaultWorkflowTemplate(ctx, project.id);

    expect(applied.map((s) => s.name)).toEqual([
      '待完成',
      '正在修改',
      '待审查',
      '审查中',
      '回退修改',
      '已完成',
    ]);
    const doneRow = ctx.sqlite.prepare('SELECT status_id FROM tasks WHERE id = ?').get(doneTask) as {
      status_id: string;
    };
    const doingRow = ctx.sqlite
      .prepare('SELECT status_id FROM tasks WHERE id = ?')
      .get(doingTask) as { status_id: string };

    const doneStatus = applied.find((s) => s.category === 'done')!;
    const doingStatus = applied.find((s) => s.category === 'doing')!;
    expect(doneRow.status_id).toBe(doneStatus.id);
    expect(doingRow.status_id).toBe(doingStatus.id);
  });

  it('统计某状态下的未删除任务数', () => {
    const ctx = makeCtx();
    const project = projectService.createProject(ctx, { name: 'P' });
    const status = workflow.getDefaultStatus(ctx, project.id)!;
    insertTask(ctx, project.id, status.id, 'a');
    insertTask(ctx, project.id, status.id, 'b');

    expect(workflow.countTasksInStatus(ctx, status.id)).toBe(2);
  });
});

describe('标签服务', () => {
  it('同一个项目内标签不能重名', () => {
    const ctx = makeCtx();
    const project = projectService.createProject(ctx, { name: 'P' });

    tagService.createTag(ctx, { name: '紧急' }, project.id);
    expect(() => tagService.createTag(ctx, { name: '紧急' }, project.id)).toThrow(/已存在/);
  });

  /**
   * 0.2.0：移除"全局标签"（决策记录 #27）。
   *
   * 这条**替代**了原来的两条用例（"项目标签与全局标签可以同名"、
   * "全局标签之间也受唯一约束，靠 IFNULL 归一化"）——那两条描述的是
   * `project_id` 可空时的行为，而那个口子已经被迁移 0006 关掉了。
   * 语义变了，测试必须跟着改，不能留着一条已经不成立的绿。
   */
  it('不同项目的标签互不影响：可以同名，也互相看不到', () => {
    const ctx = makeCtx();
    const a = projectService.createProject(ctx, { name: 'A' });
    const b = projectService.createProject(ctx, { name: 'B' });

    tagService.createTag(ctx, { name: '紧急' }, a.id);
    expect(() => tagService.createTag(ctx, { name: '紧急' }, b.id)).not.toThrow();

    expect(tagService.listTags(ctx, { projectId: a.id }).map((t) => t.name)).toEqual(['紧急']);
    expect(tagService.listTags(ctx, { projectId: b.id })).toHaveLength(1);
    // 不传项目就是全部项目的标签（内部/诊断用），但绝不可能是"全局标签"
    expect(tagService.listTags(ctx)).toHaveLength(2);
  });

  it('标签不可能不属于任何项目（类型上就写不出来）', () => {
    const ctx = makeCtx();
    const project = projectService.createProject(ctx, { name: 'P' });
    const tag = tagService.createTag(ctx, { name: '重要' }, project.id);
    expect(tag.projectId).toBe(project.id);
    // 数据库层面也拦得住：NULL 会被 NOT NULL 拒绝
    expect(() =>
      ctx.sqlite
        .prepare(
          'INSERT INTO tags (id, project_id, name, color, created_at, updated_at) VALUES (?, NULL, ?, ?, ?, ?)',
        )
        .run('bad', '野标签', '#f00', 1, 1),
    ).toThrow();
  });

  it('改名冲突同样被翻译成业务语义的错误', () => {
    const ctx = makeCtx();
    const project = projectService.createProject(ctx, { name: 'P' });
    tagService.createTag(ctx, { name: 'A' }, project.id);
    const b = tagService.createTag(ctx, { name: 'B' }, project.id);

    expect(() => tagService.updateTag(ctx, b.id, { name: 'A' })).toThrow(/已存在/);
  });

  it('删除标签不会影响任务本身', () => {
    const ctx = makeCtx();
    const project = projectService.createProject(ctx, { name: 'P' });
    const tag = tagService.createTag(ctx, { name: '临时' }, project.id);
    insertTask(ctx, project.id, workflow.getDefaultStatus(ctx, project.id)!.id, '任务');

    tagService.deleteTag(ctx, tag.id);

    expect(ctx.sqlite.prepare('SELECT COUNT(*) AS c FROM tasks').get()).toEqual({ c: 1 });
    expect(tagService.listTags(ctx, { projectId: project.id })).toHaveLength(0);
  });
});

describe('里程碑服务', () => {
  it('创建并列出（按 sort_order）', () => {
    const ctx = makeCtx();
    const project = projectService.createProject(ctx, { name: 'P' });
    milestoneService.createMilestone(ctx, project.id, { name: 'M1' });
    milestoneService.createMilestone(ctx, project.id, { name: 'M2' });

    expect(milestoneService.listMilestones(ctx, project.id).map((m) => m.name)).toEqual([
      'M1',
      'M2',
    ]);
  });

  it('改变截止日不会打乱排列顺序', () => {
    const ctx = makeCtx();
    const project = projectService.createProject(ctx, { name: 'P' });
    const a = milestoneService.createMilestone(ctx, project.id, { name: 'A' });
    milestoneService.createMilestone(ctx, project.id, { name: 'B' });

    milestoneService.updateMilestone(ctx, a.id, { dueDate: 999 });

    expect(milestoneService.listMilestones(ctx, project.id).map((m) => m.name)).toEqual(['A', 'B']);
  });

  it('标记达成与撤销', () => {
    const ctx = makeCtx();
    const project = projectService.createProject(ctx, { name: 'P' });
    const m = milestoneService.createMilestone(ctx, project.id, { name: 'M' });

    const reached = milestoneService.setMilestoneReached(ctx, m.id, 1_800_000_000_000);
    expect(reached.reachedAt).toBe(1_800_000_000_000);

    const undone = milestoneService.setMilestoneReached(ctx, m.id, null);
    expect(undone.reachedAt).toBeNull();
  });

  it('能筛出逾期未达成的里程碑', () => {
    const ctx = makeCtx();
    const project = projectService.createProject(ctx, { name: 'P' });
    milestoneService.createMilestone(ctx, project.id, { name: '逾期', dueDate: 1000 });
    milestoneService.createMilestone(ctx, project.id, { name: '未来', dueDate: 9_999_999_999_999 });
    const done = milestoneService.createMilestone(ctx, project.id, { name: '已达成', dueDate: 1000 });
    milestoneService.setMilestoneReached(ctx, done.id, 2000);

    const overdue = milestoneService.listOverdueMilestones(ctx, project.id, 5000);
    expect(overdue.map((m) => m.name)).toEqual(['逾期']);
  });
});
