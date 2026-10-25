/**
 * 里程碑服务。
 *
 * 里程碑是"项目的关键节点"，与任务的差别在于它不需要状态流转，
 * 只需要一个「是否达成」的时间点（`reached_at`）。
 * 达成后不删除，保留 `reached_at` 以便回看历史节奏。
 */

import type { CreateMilestoneInput, UpdateMilestoneInput } from '@pm-studio/shared';
import { AppError } from '@pm-studio/shared';
import { asc, eq, sql } from 'drizzle-orm';

import { milestones } from '../db/schema.js';
import { diffChanges, recordActivity } from './activity.js';
import { inTransaction, type ServiceContext } from './context.js';
import { nextSortOrder } from '../util/sort.js';

export interface MilestoneDto {
  id: string;
  projectId: string;
  name: string;
  description: string | null;
  dueDate: number | null;
  reachedAt: number | null;
  sortOrder: number;
  createdAt: number;
  updatedAt: number;
}

type MilestoneRow = typeof milestones.$inferSelect;

function toDto(row: MilestoneRow): MilestoneDto {
  return {
    id: row.id,
    projectId: row.projectId,
    name: row.name,
    description: row.description,
    dueDate: row.dueDate,
    reachedAt: row.reachedAt,
    sortOrder: row.sortOrder,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

const UPDATABLE_FIELDS = ['name', 'description', 'dueDate', 'reachedAt', 'sortOrder'] as const;

export function listMilestones(ctx: ServiceContext, projectId: string): MilestoneDto[] {
  return ctx.db
    .select()
    .from(milestones)
    .where(eq(milestones.projectId, projectId))
    .orderBy(asc(milestones.sortOrder), asc(milestones.createdAt))
    .all()
    .map(toDto);
}

export function findMilestone(ctx: ServiceContext, id: string): MilestoneRow | undefined {
  return ctx.db.select().from(milestones).where(eq(milestones.id, id)).get();
}

export function getMilestoneOrThrow(ctx: ServiceContext, id: string): MilestoneRow {
  const row = findMilestone(ctx, id);
  if (!row) throw new AppError('NOT_FOUND', '里程碑不存在', { details: { id } });
  return row;
}

export function createMilestone(
  ctx: ServiceContext,
  projectId: string,
  input: CreateMilestoneInput,
): MilestoneDto {
  return inTransaction(ctx, () => {
    const now = ctx.now();
    const maxRow = ctx.db
      .select({ max: sql<number | null>`MAX(${milestones.sortOrder})` })
      .from(milestones)
      .where(eq(milestones.projectId, projectId))
      .get();

    const id = ctx.newId();
    // 里程碑一律追加到末尾。刻意**不**用 dueDate 参与排序：
    // 那会让"改截止日"意外改变排列顺序，也会与已有顺序值撞车。
    // 想按时间看，前端按 dueDate 排序即可。
    const sortOrder = nextSortOrder(maxRow?.max ?? null);

    ctx.db
      .insert(milestones)
      .values({
        id,
        projectId,
        name: input.name,
        description: input.description ?? null,
        dueDate: input.dueDate ?? null,
        reachedAt: null,
        sortOrder,
        createdAt: now,
        updatedAt: now,
      })
      .run();

    recordActivity(ctx, {
      entityType: 'milestone',
      entityId: id,
      action: 'create',
      projectId,
    });

    return toDto(getMilestoneOrThrow(ctx, id));
  });
}

export function updateMilestone(
  ctx: ServiceContext,
  id: string,
  patch: UpdateMilestoneInput,
): MilestoneDto {
  const before = getMilestoneOrThrow(ctx, id);

  const changes = diffChanges(
    before as unknown as Record<string, unknown>,
    patch as Record<string, unknown>,
    UPDATABLE_FIELDS,
  );
  if (!changes) return toDto(before);

  return inTransaction(ctx, () => {
    ctx.db
      .update(milestones)
      .set({
        ...(patch.name !== undefined ? { name: patch.name } : {}),
        ...(patch.description !== undefined ? { description: patch.description ?? null } : {}),
        ...(patch.dueDate !== undefined ? { dueDate: patch.dueDate ?? null } : {}),
        ...(patch.reachedAt !== undefined ? { reachedAt: patch.reachedAt ?? null } : {}),
        ...(patch.sortOrder !== undefined ? { sortOrder: patch.sortOrder } : {}),
        updatedAt: ctx.now(),
      })
      .where(eq(milestones.id, id))
      .run();

    recordActivity(ctx, {
      entityType: 'milestone',
      entityId: id,
      action: 'update',
      projectId: before.projectId,
      changes,
    });

    return toDto(getMilestoneOrThrow(ctx, id));
  });
}

/** 标记达成（不传时间则用当前时间）；传 null 可撤销 */
export function setMilestoneReached(
  ctx: ServiceContext,
  id: string,
  reachedAt: number | null,
): MilestoneDto {
  return updateMilestone(ctx, id, { reachedAt });
}

export function deleteMilestone(ctx: ServiceContext, id: string): void {
  const milestone = getMilestoneOrThrow(ctx, id);
  inTransaction(ctx, () => {
    ctx.db.delete(milestones).where(eq(milestones.id, id)).run();
    recordActivity(ctx, {
      entityType: 'milestone',
      entityId: id,
      action: 'delete',
      projectId: milestone.projectId,
    });
  });
}

/** 已逾期且未达成的里程碑（工作台提醒用） */
export function listOverdueMilestones(
  ctx: ServiceContext,
  projectId: string,
  at: number,
): MilestoneDto[] {
  return listMilestones(ctx, projectId).filter(
    (m) => m.reachedAt === null && m.dueDate !== null && m.dueDate < at,
  );
}
