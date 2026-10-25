/**
 * 项目服务。
 *
 * 一个刻意的设计：**创建项目会自动铺好默认工作流状态**。
 * 否则新建出来的项目看板是空的 —— 用户得先手工建三个状态才能开始用，
 * 这是把设计成本转嫁给用户。同时项目、状态、审计记录在**同一事务**内写入，
 * 不会出现"项目建好了但状态没建"的半成品。
 */

import type { CreateProjectInput, ProjectStatus, UpdateProjectInput } from '@pm-studio/shared';
import { AppError, DEFAULT_WORKFLOW_TEMPLATE, SORT_GAP } from '@pm-studio/shared';
import { and, asc, eq, isNotNull, isNull, or, sql, type SQL } from 'drizzle-orm';

import { projectRelations, projects, workflowStatuses, type Project } from '../db/schema.js';
import { diffChanges, recordActivity } from './activity.js';
import { inTransaction, type ServiceContext } from './context.js';
import { discardNewFolder, prepareProjectFolder } from './project-folders.js';
import { nextSortOrder } from '../util/sort.js';

/** 可被 PATCH 修改的字段，用于只记录真正变化的字段 */
const UPDATABLE_FIELDS = [
  'name',
  'description',
  'color',
  'icon',
  'codePath',
  'codeKind',
  'status',
  'sortOrder',
] as const;

export interface ListProjectsOptions {
  includeArchived?: boolean;
  includeDeleted?: boolean;
}

export function listProjects(ctx: ServiceContext, options: ListProjectsOptions = {}): Project[] {
  const conditions: SQL[] = [];
  if (!options.includeDeleted) conditions.push(isNull(projects.deletedAt));
  if (!options.includeArchived) conditions.push(eq(projects.status, 'active'));

  return ctx.db
    .select()
    .from(projects)
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .orderBy(asc(projects.sortOrder), asc(projects.createdAt))
    .all();
}

export function findProject(ctx: ServiceContext, id: string): Project | undefined {
  return ctx.db.select().from(projects).where(eq(projects.id, id)).get();
}

export function getProjectOrThrow(ctx: ServiceContext, id: string): Project {
  const project = findProject(ctx, id);
  if (!project || project.deletedAt !== null) {
    throw new AppError('NOT_FOUND', '项目不存在', { details: { id } });
  }
  return project;
}

export function createProject(ctx: ServiceContext, input: CreateProjectInput): Project {
  // 先在工作区里准备好这个项目的文件夹（0.1.2 起：一个项目 = 一个文件夹）。
  // 放在事务**之前**做，是因为建目录不是可回滚的操作：
  // 先落库再建目录，万一建目录失败就得回滚数据库并收拾残局；
  // 先建目录再落库，失败时只需删掉刚建的空目录。
  const prepared = prepareProjectFolder(ctx, input.name);

  try {
    return inTransaction(ctx, () => {
      const now = ctx.now();
      const maxRow = ctx.db
        .select({ max: sql<number | null>`MAX(${projects.sortOrder})` })
        .from(projects)
        .get();

      const project: Project = {
        id: ctx.newId(),
        ownerId: ctx.actorId,
        name: input.name,
        description: input.description ?? null,
        color: input.color ?? '#2080f0',
        icon: input.icon ?? null,
        folder: prepared?.folder ?? null,
        codePath: input.codePath ?? null,
        codeKind: input.codeKind ?? null,
        stackJson: null,
        status: 'active',
        sortOrder: nextSortOrder(maxRow?.max ?? null),
        createdAt: now,
        updatedAt: now,
        deletedAt: null,
      };

      ctx.db.insert(projects).values(project).run();
      seedDefaultWorkflow(ctx, project.id);

      recordActivity(ctx, {
        entityType: 'project',
        entityId: project.id,
        action: 'create',
        projectId: project.id,
        ...(prepared ? { changes: { folder: [null, prepared.folder] } } : {}),
      });

      return project;
    });
  } catch (error) {
    // 落库失败就把刚建出来的空目录收掉，不留一个"没有主人的项目文件夹"
    discardNewFolder(prepared?.path);
    throw error;
  }
}

/** 铺默认工作流：待处理 / 进行中 / 已完成 */
export function seedDefaultWorkflow(ctx: ServiceContext, projectId: string): void {
  const now = ctx.now();

  DEFAULT_WORKFLOW_TEMPLATE.forEach((template, index) => {
    ctx.db
      .insert(workflowStatuses)
      .values({
        id: ctx.newId(),
        projectId,
        name: template.name,
        color: template.color,
        category: template.category,
        sortOrder: (index + 1) * SORT_GAP,
        // 第一个状态是新建任务的默认落点，通常是"待处理"
        isDefault: index === 0 ? 1 : 0,
        createdAt: now,
        updatedAt: now,
      })
      .run();
  });
}

export function updateProject(
  ctx: ServiceContext,
  id: string,
  patch: UpdateProjectInput,
): Project {
  const before = getProjectOrThrow(ctx, id);

  const changes = diffChanges(
    before as unknown as Record<string, unknown>,
    patch as Record<string, unknown>,
    UPDATABLE_FIELDS,
  );

  // 没有任何实际变化时直接返回，不写库也不记日志 ——
  // 否则会产生一堆"内容没变但 updated_at 变了"的无意义记录
  if (!changes) return before;

  const now = ctx.now();
  return inTransaction(ctx, () => {
    ctx.db
      .update(projects)
      .set({
        ...(patch.name !== undefined ? { name: patch.name } : {}),
        ...(patch.description !== undefined ? { description: patch.description ?? null } : {}),
        ...(patch.color !== undefined ? { color: patch.color } : {}),
        ...(patch.icon !== undefined ? { icon: patch.icon ?? null } : {}),
        ...(patch.codePath !== undefined ? { codePath: patch.codePath ?? null } : {}),
        ...(patch.codeKind !== undefined ? { codeKind: patch.codeKind ?? null } : {}),
        ...(patch.status !== undefined ? { status: patch.status } : {}),
        ...(patch.sortOrder !== undefined ? { sortOrder: patch.sortOrder } : {}),
        updatedAt: now,
      })
      .where(eq(projects.id, id))
      .run();

    recordActivity(ctx, {
      entityType: 'project',
      entityId: id,
      action: 'update',
      projectId: id,
      changes,
    });

    return getProjectOrThrow(ctx, id);
  });
}

export function setProjectStatus(
  ctx: ServiceContext,
  id: string,
  status: ProjectStatus,
): Project {
  return updateProject(ctx, id, { status });
}

/**
 * 软删除项目（进回收站）。
 *
 * 刻意**不级联软删除任务**：项目本身已被过滤掉，其任务不可能被单独查询到；
 * 而保持任务原样可以让"还原项目"真正还原出完整内容。
 * 需要彻底清除时用 `hardDeleteProject`（外键级联会物理删除）。
 *
 * 也**绝不删除项目文件夹**：里面可能已经有用户自己写的代码或附件，
 * 递归删目录不可逆。要清理请由用户在资源管理器里自己动手。
 */
export function softDeleteProject(ctx: ServiceContext, id: string): Project {
  const before = getProjectOrThrow(ctx, id);
  if (before.deletedAt !== null) return before;

  const now = ctx.now();
  return inTransaction(ctx, () => {
    ctx.db
      .update(projects)
      .set({ deletedAt: now, updatedAt: now })
      .where(eq(projects.id, id))
      .run();

    recordActivity(ctx, {
      entityType: 'project',
      entityId: id,
      action: 'delete',
      projectId: id,
      changes: { deletedAt: [null, now] },
    });

    return findProject(ctx, id) as Project;
  });
}

export function restoreProject(ctx: ServiceContext, id: string): Project {
  const project = findProject(ctx, id);
  if (!project) throw new AppError('NOT_FOUND', '项目不存在', { details: { id } });
  if (project.deletedAt === null) return project;

  // 还原时要顺手把文件夹补上：文件可能是在"项目还没有文件夹"的旧版本里被删的，
  // 而用户点"还原"的预期是"它回来了"。只在缺失时建，已有文件夹的项目不碰。
  const prepared = project.folder === null ? prepareProjectFolder(ctx, project.name) : null;

  const now = ctx.now();
  return inTransaction(ctx, () => {
    ctx.db
      .update(projects)
      .set({
        deletedAt: null,
        updatedAt: now,
        ...(prepared ? { folder: prepared.folder } : {}),
      })
      .where(eq(projects.id, id))
      .run();

    recordActivity(ctx, {
      entityType: 'project',
      entityId: id,
      action: 'restore',
      projectId: id,
      changes: { deletedAt: [project.deletedAt, null] },
    });

    return findProject(ctx, id) as Project;
  });
}

/**
 * 清空回收站：把**已软删除**的项目一次性物理删除。
 *
 * 与"一个一个彻底删"的差别只有"一次请求、一个事务"，语义完全一样：
 * 只清应用里的数据（外键级联），**绝不删磁盘上的项目文件夹**。
 *
 * **只动 `deletedAt` 不为空的行** —— 这条是安全底线：一个"清空回收站"的按钮
 * 绝不能碰到任何还活着的项目。所以判据写在 SQL 的 where 里，而不是"前端传哪些 id"。
 *
 * 返回删掉的名字：界面要如实报告"删了几个、都是谁"，而不是只说一句成功。
 */
export function purgeTrash(ctx: ServiceContext): { deleted: number; names: string[] } {
  const doomed = ctx.db.select().from(projects).where(isNotNull(projects.deletedAt)).all();
  if (doomed.length === 0) return { deleted: 0, names: [] };

  inTransaction(ctx, () => {
    for (const project of doomed) hardDeleteProject(ctx, project.id);
  });

  ctx.logger.info('已清空回收站', { count: doomed.length, names: doomed.map((p) => p.name) });
  return { deleted: doomed.length, names: doomed.map((p) => p.name) };
}

/**
 * 物理删除项目。
 *
 * 依赖数据库的 `ON DELETE CASCADE` 一并清掉工作流状态、标签、任务、
 * 依赖、里程碑 —— 因此**必须先确认外键是打开的**（DbConnection 打开时
 * 已经强制校验过）。
 *
 * **刻意不走 `getProjectOrThrow`**：那条守卫把"已软删除"的项目当成不存在（抛 404），
 * 而"从回收站里彻底删除"要删的**正是**一个已软删除的项目 —— 用它会得到
 * "回收站里点彻底删除永远是 404"（这是 e2e 拿真实请求打出来的）。
 * 这里只要求"记录存在"，不要求"没被删过"。
 */
export function hardDeleteProject(ctx: ServiceContext, id: string): void {
  const project = findProject(ctx, id);
  if (!project) throw new AppError('NOT_FOUND', '项目不存在', { details: { id } });
  inTransaction(ctx, () => {
    /*
     * 关系链要先显式删并留痕。
     *
     * 数据库上两个端点都是 `ON DELETE CASCADE`，所以"删干净"这条**不靠这里**；
     * 这里是为了**活动记录**：项目被物理删除时，牵连的关系也该在活动流里留一笔
     * （否则回看历史会发现"某条关系凭空消失了"）。
     */
    const related = ctx.db
      .select()
      .from(projectRelations)
      .where(
        or(
          eq(projectRelations.fromProjectId, id),
          eq(projectRelations.toProjectId, id),
        ),
      )
      .all();
    for (const relation of related) {
      ctx.db.delete(projectRelations).where(eq(projectRelations.id, relation.id)).run();
      recordActivity(ctx, {
        entityType: 'project_relation',
        entityId: relation.id,
        action: 'delete',
        // 关联的项目马上没了，所以活动记录挂在**对方**项目上（它是还活着的那一端）
        projectId: relation.fromProjectId === id ? relation.toProjectId : relation.fromProjectId,
        changes: { label: [relation.label, null], reason: ['project', 'hard_delete'] },
      });
    }

    ctx.db.delete(projects).where(eq(projects.id, id)).run();
  });
}
