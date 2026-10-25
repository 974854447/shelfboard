/**
 * 项目间关系链（需求 §5.2.1，**纯展示**）。
 *
 * ## 这个模块刻意"少做"什么
 *
 * 用户原话：项目之间都是单独存在的，管理系统中只有一条关系链；
 * 「前端项目 → 调用 → 后端项目」这层关系**在系统里只做展示**。
 * 所以这里：
 *
 * - **没有**任何联动逻辑（不共享任务/标签/状态/文档、不做跨项目汇总、不做"A 改影响 B"）；
 * - **没有**关系类型枚举 —— `label` 是自由文本（"调用""同属一个系统"…），
 *   用户给的例子本身就说明它说不完；
 * - **没有**环检测：关系只用来画一条线，成环既不影响任何计算，也不该被拦下
 *   （真做了环检测，用户想标"A 调用 B、B 回调 A"时会莫名其妙被拒）。
 *
 * ## 校验（服务端不能只信界面）
 *
 * 1. 两端项目都必须**存在且未删除**；
 * 2. 不能指向自己（自环在界面上画不出来，只会变成一个让人困惑的箭头）；
 * 3. 同一条关系（同端点 + 同名）不能重复 —— 数据库上也有唯一索引兜底；
 * 4. 名称与备注有长度上限（名称 40、备注 200）。
 */

import type { CreateProjectRelationInput, UpdateProjectRelationInput } from '@pm-studio/shared';
import { AppError } from '@pm-studio/shared';
import { and, asc, eq, inArray, or } from 'drizzle-orm';

import { projectRelations, projects } from '../db/schema.js';
import { recordActivity } from './activity.js';
import { inTransaction, type ServiceContext } from './context.js';

/** 关系名上限（自由填，但别把一句话塞进标签里） */
export const RELATION_LABEL_MAX = 40;
export const RELATION_NOTE_MAX = 200;

export interface ProjectRelationEndpoint {
  id: string;
  name: string;
  color: string;
  /** 归档的项目在界面上要标出来（关系还在，但项目已经不活跃了） */
  archived: boolean;
}

export interface ProjectRelationDto {
  id: string;
  fromProjectId: string;
  toProjectId: string;
  label: string;
  note: string | null;
  createdAt: number;
  updatedAt: number;
  /** 起点项目（界面直接拿名字与颜色画，不用再查一次） */
  from: ProjectRelationEndpoint;
  /** 终点项目 */
  to: ProjectRelationEndpoint;
  /** 这条关系相对"当前项目"的方向：出向（我指向别人）/ 入向（别人指向我） */
  direction: 'outgoing' | 'incoming';
}

type RelationRow = typeof projectRelations.$inferSelect;
type ProjectRow = typeof projects.$inferSelect;

function endpointOf(row: ProjectRow | undefined, id: string): ProjectRelationEndpoint {
  return {
    id,
    name: row?.name ?? '（已删除的项目）',
    color: row?.color ?? '#8a8a8a',
    archived: row?.status === 'archived',
  };
}

function toDto(
  row: RelationRow,
  projectId: string,
  projectRows: Map<string, ProjectRow>,
): ProjectRelationDto {
  return {
    id: row.id,
    fromProjectId: row.fromProjectId,
    toProjectId: row.toProjectId,
    label: row.label,
    note: row.note,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    from: endpointOf(projectRows.get(row.fromProjectId), row.fromProjectId),
    to: endpointOf(projectRows.get(row.toProjectId), row.toProjectId),
    direction: row.toProjectId === projectId ? 'incoming' : 'outgoing',
  };
}

/** 把涉及到的项目一次性取出来（避免每条关系各查一次库） */
function loadEndpointProjects(ctx: ServiceContext, ids: string[]): Map<string, ProjectRow> {
  const unique = [...new Set(ids)];
  if (unique.length === 0) return new Map();
  const rows = ctx.db.select().from(projects).where(inArray(projects.id, unique)).all();
  return new Map(rows.map((row) => [row.id, row]));
}

/**
 * 某个项目的全部关系（**两个方向都算**）。
 *
 * 界面上"我的关系链"显然包括"别人指向我"的 —— 只查出向的话，
 * 后端项目自己那一页会看不到"前端项目 → 调用 → 我"这条线。
 */
export function listRelationsForProject(ctx: ServiceContext, projectId: string): ProjectRelationDto[] {
  const rows = ctx.db
    .select()
    .from(projectRelations)
    .where(or(eq(projectRelations.fromProjectId, projectId), eq(projectRelations.toProjectId, projectId)))
    .orderBy(asc(projectRelations.createdAt))
    .all();

  const projectRows = loadEndpointProjects(
    ctx,
    rows.flatMap((row) => [row.fromProjectId, row.toProjectId]),
  );
  return rows.map((row) => toDto(row, projectId, projectRows));
}

/**
 * 项目卡片用的小结：每个项目有几条关系、分别是些什么名字。
 *
 * 一次查完（不是"按项目循环查库"）：项目页一次要显示所有卡片，
 * 按项目查会变成 N 次查询，几十个项目就能看出卡顿。
 */
export function summarizeRelations(ctx: ServiceContext): Record<
  string,
  { count: number; labels: string[] }
> {
  const summary: Record<string, { count: number; labels: string[] }> = {};
  const bump = (projectId: string, label: string): void => {
    const entry = (summary[projectId] ??= { count: 0, labels: [] });
    entry.count += 1;
    if (!entry.labels.includes(label)) entry.labels.push(label);
  };
  for (const row of ctx.db.select().from(projectRelations).all()) {
    bump(row.fromProjectId, row.label);
    bump(row.toProjectId, row.label);
  }
  return summary;
}

function assertProjectExists(ctx: ServiceContext, projectId: string, what: string): void {
  const row = ctx.db.select().from(projects).where(eq(projects.id, projectId)).get();
  if (!row || row.deletedAt !== null) {
    throw new AppError('NOT_FOUND', `${what}不存在或已删除`, { details: { projectId } });
  }
}

export function createRelation(
  ctx: ServiceContext,
  fromProjectId: string,
  input: CreateProjectRelationInput,
): ProjectRelationDto {
  const label = input.label.trim();
  if (label.length === 0) throw new AppError('VALIDATION_FAILED', '关系名称不能为空');
  if (label.length > RELATION_LABEL_MAX) {
    throw new AppError('VALIDATION_FAILED', `关系名称不能超过 ${RELATION_LABEL_MAX} 个字`);
  }
  const note = input.note?.trim() ?? '';
  if (note.length > RELATION_NOTE_MAX) {
    throw new AppError('VALIDATION_FAILED', `备注不能超过 ${RELATION_NOTE_MAX} 个字`);
  }
  if (fromProjectId === input.toProjectId) {
    throw new AppError('VALIDATION_FAILED', '不能把项目连到它自己');
  }

  return inTransaction(ctx, () => {
    assertProjectExists(ctx, fromProjectId, '起点项目');
    assertProjectExists(ctx, input.toProjectId, '终点项目');

    const duplicated = ctx.db
      .select()
      .from(projectRelations)
      .where(
        and(
          eq(projectRelations.fromProjectId, fromProjectId),
          eq(projectRelations.toProjectId, input.toProjectId),
          eq(projectRelations.label, label),
        ),
      )
      .get();
    if (duplicated) {
      throw new AppError('CONFLICT', `这两个项目之间已经有一条「${label}」了`, {
        details: { relationId: duplicated.id },
      });
    }

    const now = ctx.now();
    const id = ctx.newId();
    ctx.db
      .insert(projectRelations)
      .values({
        id,
        fromProjectId,
        toProjectId: input.toProjectId,
        label,
        note: note.length > 0 ? note : null,
        createdAt: now,
        updatedAt: now,
      })
      .run();

    recordActivity(ctx, {
      entityType: 'project_relation',
      entityId: id,
      action: 'create',
      projectId: fromProjectId,
      changes: { label: [null, label], to: [null, input.toProjectId] },
    });

    const row = ctx.db.select().from(projectRelations).where(eq(projectRelations.id, id)).get()!;
    const projectRows = loadEndpointProjects(ctx, [fromProjectId, input.toProjectId]);
    return toDto(row, fromProjectId, projectRows);
  });
}

export function updateRelation(
  ctx: ServiceContext,
  id: string,
  patch: UpdateProjectRelationInput,
): ProjectRelationDto {
  const row = ctx.db.select().from(projectRelations).where(eq(projectRelations.id, id)).get();
  if (!row) throw new AppError('NOT_FOUND', '这条关系不存在', { details: { id } });

  const label = patch.label === undefined ? row.label : patch.label.trim();
  if (label.length === 0) throw new AppError('VALIDATION_FAILED', '关系名称不能为空');
  if (label.length > RELATION_LABEL_MAX) {
    throw new AppError('VALIDATION_FAILED', `关系名称不能超过 ${RELATION_LABEL_MAX} 个字`);
  }
  const note = patch.note === undefined ? row.note : (patch.note?.trim() ?? null);
  if (note !== null && note.length > RELATION_NOTE_MAX) {
    throw new AppError('VALIDATION_FAILED', `备注不能超过 ${RELATION_NOTE_MAX} 个字`);
  }

  return inTransaction(ctx, () => {
    ctx.db
      .update(projectRelations)
      .set({ label, note, updatedAt: ctx.now() })
      .where(eq(projectRelations.id, id))
      .run();

    recordActivity(ctx, {
      entityType: 'project_relation',
      entityId: id,
      action: 'update',
      projectId: row.fromProjectId,
      ...(label !== row.label ? { changes: { label: [row.label, label] } } : {}),
    });

    const next = ctx.db.select().from(projectRelations).where(eq(projectRelations.id, id)).get()!;
    const projectRows = loadEndpointProjects(ctx, [next.fromProjectId, next.toProjectId]);
    return toDto(next, next.fromProjectId, projectRows);
  });
}

export function deleteRelation(ctx: ServiceContext, id: string): { deleted: boolean } {
  const row = ctx.db.select().from(projectRelations).where(eq(projectRelations.id, id)).get();
  if (!row) throw new AppError('NOT_FOUND', '这条关系不存在', { details: { id } });

  return inTransaction(ctx, () => {
    ctx.db.delete(projectRelations).where(eq(projectRelations.id, id)).run();
    recordActivity(ctx, {
      entityType: 'project_relation',
      entityId: id,
      action: 'delete',
      projectId: row.fromProjectId,
      changes: { label: [row.label, null] },
    });
    return { deleted: true };
  });
}
