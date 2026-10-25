/**
 * 标签服务。
 *
 * 标签**一律属于某个项目**（`project_id` 非空）。
 *
 * 0.2.0 之前这里还支持"全局标签"（`project_id` 为 NULL，会出现在每个项目的标签列表里），
 * 那是"项目之间互不共享"的例外口子：A 项目建的标签会出现在 B 项目的下拉里。
 * 用户 2026-09-26 决定去掉这个设定（决策记录 #27），迁移 `0006` 把列改成了 NOT NULL，
 * 服务层这一版也跟着收口：不再有"全局"这个分支。
 */

import type { CreateTagInput, UpdateTagInput } from '@pm-studio/shared';
import { AppError } from '@pm-studio/shared';
import { and, asc, eq, sql, type SQL } from 'drizzle-orm';

import { tags } from '../db/schema.js';
import { diffChanges, recordActivity } from './activity.js';
import { inTransaction, type ServiceContext } from './context.js';
import { isUniqueViolation } from '../util/sqlite.js';

export interface TagDto {
  id: string;
  projectId: string;
  name: string;
  color: string;
  createdAt: number;
  updatedAt: number;
}

type TagRow = typeof tags.$inferSelect;

function toDto(row: TagRow): TagDto {
  return {
    id: row.id,
    projectId: row.projectId,
    name: row.name,
    color: row.color,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

const UPDATABLE_FIELDS = ['name', 'color'] as const;

export interface ListTagsOptions {
  /** 只返回这个项目的标签；不传就返回全部项目的 */
  projectId?: string;
}

export function listTags(ctx: ServiceContext, options: ListTagsOptions = {}): TagDto[] {
  const conditions: SQL[] = [];
  if (options.projectId) {
    conditions.push(eq(tags.projectId, options.projectId));
  }

  return ctx.db
    .select()
    .from(tags)
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .orderBy(asc(tags.name))
    .all()
    .map(toDto);
}

export function findTag(ctx: ServiceContext, id: string): TagRow | undefined {
  return ctx.db.select().from(tags).where(eq(tags.id, id)).get();
}

export function getTagOrThrow(ctx: ServiceContext, id: string): TagRow {
  const row = findTag(ctx, id);
  if (!row) throw new AppError('NOT_FOUND', '标签不存在', { details: { id } });
  return row;
}

/**
 * 建标签。**`projectId` 是必填的位置参数**（不再是可空的选项）——
 * 这样"建一个不属于任何项目的标签"在类型上就写不出来，
 * 而不是等数据库的 NOT NULL 去拦。
 */
export function createTag(
  ctx: ServiceContext,
  input: CreateTagInput,
  projectId: string,
): TagDto {
  return inTransaction(ctx, () => {
    const now = ctx.now();
    const id = ctx.newId();

    try {
      ctx.db
        .insert(tags)
        .values({
          id,
          projectId,
          name: input.name,
          color: input.color ?? '#8a8a8a',
          createdAt: now,
          updatedAt: now,
        })
        .run();
    } catch (error) {
      // 唯一约束冲突翻译成业务语义，而不是把 SQLITE_CONSTRAINT 抛给用户
      if (isUniqueViolation(error)) {
        throw new AppError('CONFLICT', `标签「${input.name}」已存在`, {
          details: { name: input.name, projectId },
        });
      }
      throw error;
    }

    recordActivity(ctx, {
      entityType: 'tag',
      entityId: id,
      action: 'create',
      projectId,
    });

    return toDto(getTagOrThrow(ctx, id));
  });
}

export function updateTag(ctx: ServiceContext, id: string, patch: UpdateTagInput): TagDto {
  const before = getTagOrThrow(ctx, id);
  const changes = diffChanges(
    before as unknown as Record<string, unknown>,
    patch as Record<string, unknown>,
    UPDATABLE_FIELDS,
  );
  if (!changes) return toDto(before);

  return inTransaction(ctx, () => {
    try {
      ctx.db
        .update(tags)
        .set({
          ...(patch.name !== undefined ? { name: patch.name } : {}),
          ...(patch.color !== undefined ? { color: patch.color } : {}),
          updatedAt: ctx.now(),
        })
        .where(eq(tags.id, id))
        .run();
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new AppError('CONFLICT', `标签「${patch.name ?? before.name}」已存在`);
      }
      throw error;
    }

    recordActivity(ctx, {
      entityType: 'tag',
      entityId: id,
      action: 'update',
      projectId: before.projectId,
      changes,
    });

    return toDto(getTagOrThrow(ctx, id));
  });
}

/** 删除标签；task_tags 会随外键级联清理，任务本身不受影响 */
export function deleteTag(ctx: ServiceContext, id: string): void {
  const tag = getTagOrThrow(ctx, id);
  inTransaction(ctx, () => {
    ctx.db.delete(tags).where(eq(tags.id, id)).run();
    recordActivity(ctx, {
      entityType: 'tag',
      entityId: id,
      action: 'delete',
      projectId: tag.projectId,
    });
  });
}

/** 统计标签被多少任务使用（删除前提示用） */
export function countTagUsage(ctx: ServiceContext, id: string): number {
  const row = ctx.sqlite
    .prepare('SELECT COUNT(*) AS c FROM task_tags WHERE tag_id = ?')
    .get(id) as { c: number } | undefined;
  return Number(row?.c ?? 0);
}

/** 供测试与内部使用：按名字在某个项目里找标签 */
export function findTagByName(
  ctx: ServiceContext,
  name: string,
  projectId: string,
): TagDto | undefined {
  const row = ctx.db
    .select()
    .from(tags)
    .where(and(eq(tags.name, name), eq(tags.projectId, projectId)))
    .get();
  return row ? toDto(row) : undefined;
}

/** 标签总数（诊断包与统计用） */
export function countTags(ctx: ServiceContext): number {
  const row = ctx.db.select({ count: sql<number>`COUNT(*)` }).from(tags).get();
  return Number(row?.count ?? 0);
}
