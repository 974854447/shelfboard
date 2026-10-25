/**
 * 工作流状态服务。
 *
 * 这个模块要处理的都是"状态被用户自由改名/调序/删除"带来的连带问题：
 *
 * - **状态名可以随便改**，但 `category`（todo/doing/done）固定不变，
 *   进度统计与看板完成判定依赖它，不会被改名破坏。
 * - **删除状态前必须安置任务**。否则那些任务的 `status_id` 会指向不存在的行
 *   （外键是 SET NULL，会变成"没有状态"，在按状态分列的看板上直接消失）。
 * - **不能删掉最后一个状态**。项目至少要有一个可用列，否则新建任务无处可放。
 * - **有且仅有一个默认状态**。它是新建任务的落点；重名默认会导致行为不确定。
 */

import type {
  CreateWorkflowStatusInput,
  StatusCategory,
  UpdateWorkflowStatusInput,
} from '@pm-studio/shared';
import { AppError, DEFAULT_WORKFLOW_TEMPLATE, SORT_GAP } from '@pm-studio/shared';
import { and, asc, eq, isNull, ne, sql } from 'drizzle-orm';

import { tasks, workflowStatuses } from '../db/schema.js';
import { diffChanges, recordActivity } from './activity.js';
import { inTransaction, type ServiceContext } from './context.js';
import { rebalancedOrders } from '../util/sort.js';

export interface WorkflowStatusDto {
  id: string;
  projectId: string;
  name: string;
  color: string;
  category: StatusCategory;
  sortOrder: number;
  isDefault: boolean;
  createdAt: number;
  updatedAt: number;
}

type StatusRow = typeof workflowStatuses.$inferSelect;

function toDto(row: StatusRow): WorkflowStatusDto {
  return {
    id: row.id,
    projectId: row.projectId,
    name: row.name,
    color: row.color,
    category: row.category as StatusCategory,
    sortOrder: row.sortOrder,
    // 库里是 0/1，对外一律布尔，避免前端各处写 `=== 1`
    isDefault: row.isDefault === 1,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

const UPDATABLE_FIELDS = ['name', 'color', 'category', 'isDefault'] as const;

export function listStatuses(ctx: ServiceContext, projectId: string): WorkflowStatusDto[] {
  return ctx.db
    .select()
    .from(workflowStatuses)
    .where(eq(workflowStatuses.projectId, projectId))
    .orderBy(asc(workflowStatuses.sortOrder), asc(workflowStatuses.createdAt))
    .all()
    .map(toDto);
}

export function findStatus(ctx: ServiceContext, id: string): StatusRow | undefined {
  return ctx.db.select().from(workflowStatuses).where(eq(workflowStatuses.id, id)).get();
}

export function getStatusOrThrow(ctx: ServiceContext, id: string): StatusRow {
  const row = findStatus(ctx, id);
  if (!row) throw new AppError('NOT_FOUND', '工作流状态不存在', { details: { id } });
  return row;
}

/** 项目的默认状态（新建任务的落点）。理论上恒存在。 */
export function getDefaultStatus(
  ctx: ServiceContext,
  projectId: string,
): WorkflowStatusDto | undefined {
  const row = ctx.db
    .select()
    .from(workflowStatuses)
    .where(and(eq(workflowStatuses.projectId, projectId), eq(workflowStatuses.isDefault, 1)))
    .orderBy(asc(workflowStatuses.sortOrder))
    .get();
  if (row) return toDto(row);

  // 兜底：数据异常时退回第一个状态，而不是让新建任务失败
  const first = ctx.db
    .select()
    .from(workflowStatuses)
    .where(eq(workflowStatuses.projectId, projectId))
    .orderBy(asc(workflowStatuses.sortOrder))
    .get();
  return first ? toDto(first) : undefined;
}

/** 保证项目下有且仅有一个默认状态 */
function ensureSingleDefault(ctx: ServiceContext, projectId: string, preferredId: string): void {
  const now = ctx.now();
  ctx.db
    .update(workflowStatuses)
    .set({ isDefault: 0, updatedAt: now })
    .where(and(eq(workflowStatuses.projectId, projectId), ne(workflowStatuses.id, preferredId)))
    .run();

  ctx.db
    .update(workflowStatuses)
    .set({ isDefault: 1, updatedAt: now })
    .where(eq(workflowStatuses.id, preferredId))
    .run();
}

export function createStatus(
  ctx: ServiceContext,
  projectId: string,
  input: CreateWorkflowStatusInput,
): WorkflowStatusDto {
  return inTransaction(ctx, () => {
    const now = ctx.now();
    const maxRow = ctx.db
      .select({ max: sql<number | null>`MAX(${workflowStatuses.sortOrder})` })
      .from(workflowStatuses)
      .where(eq(workflowStatuses.projectId, projectId))
      .get();

    const id = ctx.newId();
    ctx.db
      .insert(workflowStatuses)
      .values({
        id,
        projectId,
        name: input.name,
        color: input.color ?? '#8a8a8a',
        category: input.category ?? 'doing',
        sortOrder: (maxRow?.max ?? 0) + SORT_GAP,
        // 新增状态默认不是默认状态，除非显式指定
        isDefault: 0,
        createdAt: now,
        updatedAt: now,
      })
      .run();

    if (input.isDefault) ensureSingleDefault(ctx, projectId, id);

    recordActivity(ctx, {
      entityType: 'workflow_status',
      entityId: id,
      action: 'create',
      projectId,
    });

    return toDto(getStatusOrThrow(ctx, id));
  });
}

export function updateStatus(
  ctx: ServiceContext,
  id: string,
  patch: UpdateWorkflowStatusInput,
): WorkflowStatusDto {
  const before = getStatusOrThrow(ctx, id);

  const changes = diffChanges(
    { ...before, isDefault: before.isDefault === 1 } as unknown as Record<string, unknown>,
    patch as Record<string, unknown>,
    UPDATABLE_FIELDS,
  );
  if (!changes) return toDto(before);

  return inTransaction(ctx, () => {
    const now = ctx.now();
    ctx.db
      .update(workflowStatuses)
      .set({
        ...(patch.name !== undefined ? { name: patch.name } : {}),
        ...(patch.color !== undefined ? { color: patch.color } : {}),
        ...(patch.category !== undefined ? { category: patch.category } : {}),
        ...(patch.isDefault !== undefined ? { isDefault: patch.isDefault ? 1 : 0 } : {}),
        updatedAt: now,
      })
      .where(eq(workflowStatuses.id, id))
      .run();

    if (patch.isDefault === true) ensureSingleDefault(ctx, before.projectId, id);
    else if (patch.isDefault === false && before.isDefault === 1) {
      // 不允许把唯一的默认状态取消掉，否则新建任务会没有落点
      const other = ctx.db
        .select()
        .from(workflowStatuses)
        .where(
          and(eq(workflowStatuses.projectId, before.projectId), ne(workflowStatuses.id, id)),
        )
        .orderBy(asc(workflowStatuses.sortOrder))
        .get();
      if (other) ensureSingleDefault(ctx, before.projectId, other.id);
      else {
        ctx.db
          .update(workflowStatuses)
          .set({ isDefault: 1 })
          .where(eq(workflowStatuses.id, id))
          .run();
      }
    }

    recordActivity(ctx, {
      entityType: 'workflow_status',
      entityId: id,
      action: 'update',
      projectId: before.projectId,
      changes,
    });

    return toDto(getStatusOrThrow(ctx, id));
  });
}

export interface DeleteStatusResult {
  movedTasks: number;
  movedTo: string;
}

/**
 * 删除状态。
 *
 * 顺序很重要：**先把任务迁走，再删状态**。反过来会因为外键 SET NULL
 * 让任务变成"无状态"，在看板上直接消失（而不是报错），属于最难发现的一类数据损坏。
 */
export function deleteStatus(
  ctx: ServiceContext,
  id: string,
  options: { moveTasksTo?: string } = {},
): DeleteStatusResult {
  const status = getStatusOrThrow(ctx, id);

  return inTransaction(ctx, () => {
    const siblings = listStatuses(ctx, status.projectId);
    if (siblings.length <= 1) {
      throw new AppError('CONFLICT', '至少要保留一个工作流状态，否则新建任务无处安放', {
        details: { projectId: status.projectId },
      });
    }

    // 迁移目标：显式指定 → 同分类的其他状态 → 默认状态 → 第一个其他状态
    const others = siblings.filter((s) => s.id !== id);
    const target =
      (options.moveTasksTo ? others.find((s) => s.id === options.moveTasksTo) : undefined) ??
      others.find((s) => s.category === status.category) ??
      others.find((s) => s.isDefault) ??
      others[0];

    if (!target) {
      throw new AppError('CONFLICT', '找不到可迁移的目标状态', { details: { id } });
    }

    if (options.moveTasksTo && target.id !== options.moveTasksTo) {
      throw new AppError('VALIDATION_FAILED', '指定的迁移目标状态不属于该项目', {
        details: { moveTasksTo: options.moveTasksTo },
      });
    }

    const now = ctx.now();
    const result = ctx.db
      .update(tasks)
      .set({ statusId: target.id, updatedAt: now })
      .where(and(eq(tasks.projectId, status.projectId), eq(tasks.statusId, id)))
      .run();

    ctx.db.delete(workflowStatuses).where(eq(workflowStatuses.id, id)).run();

    // 删掉的如果是默认状态，把默认标记交给迁移目标
    if (status.isDefault === 1) ensureSingleDefault(ctx, status.projectId, target.id);

    recordActivity(ctx, {
      entityType: 'workflow_status',
      entityId: id,
      action: 'delete',
      projectId: status.projectId,
      changes: { movedTasksTo: [id, target.id] },
    });

    return { movedTasks: Number(result.changes ?? 0), movedTo: target.id };
  });
}

/**
 * 重排状态。
 *
 * 要求传入**该项目的全部状态 id**：只传子集时"其余状态该排在哪"是歧义的，
 * 与其猜一个规则，不如让契约明确 —— 前端本来就持有完整列表。
 */
export function reorderStatuses(
  ctx: ServiceContext,
  projectId: string,
  ids: string[],
): WorkflowStatusDto[] {
  const existing = listStatuses(ctx, projectId);
  const existingIds = new Set(existing.map((s) => s.id));
  const providedIds = new Set(ids);

  if (providedIds.size !== ids.length) {
    throw new AppError('VALIDATION_FAILED', '排序列表中存在重复 id');
  }
  if (
    existingIds.size !== providedIds.size ||
    ![...existingIds].every((id) => providedIds.has(id))
  ) {
    throw new AppError('VALIDATION_FAILED', '排序列表必须包含该项目的全部工作流状态', {
      details: { expected: [...existingIds], received: ids },
    });
  }

  return inTransaction(ctx, () => {
    const now = ctx.now();
    const orders = rebalancedOrders(ids.length);

    ids.forEach((id, index) => {
      ctx.db
        .update(workflowStatuses)
        .set({ sortOrder: orders[index] as number, updatedAt: now })
        .where(eq(workflowStatuses.id, id))
        .run();
    });

    recordActivity(ctx, {
      entityType: 'workflow_status',
      entityId: projectId,
      action: 'move',
      projectId,
      changes: { order: [null, ids] },
    });

    return listStatuses(ctx, projectId);
  });
}

/**
 * 套用默认工作流模板（待处理 / 进行中 / 已完成）。
 *
 * 具体实现见 `applyWorkflowTemplate` —— 这里只是"用默认那一套调它"。
 */
export function applyDefaultWorkflowTemplate(
  ctx: ServiceContext,
  projectId: string,
): WorkflowStatusDto[] {
  return applyWorkflowTemplate(ctx, projectId, DEFAULT_WORKFLOW_TEMPLATE);
}

/** 一条模板状态的形状（与 `DEFAULT_WORKFLOW_TEMPLATE` 的条目一致） */
export interface WorkflowStatusTemplateItem {
  name: string;
  color: string;
  category: StatusCategory;
}

/**
 * 套用**任意**一套工作流模板。
 *
 * 按 **category 映射**迁移任务，而不是把所有任务一股脑倒进第一个状态：
 * "已完成的任务"套模板后仍然应该落在已完成列，否则用户会以为数据丢了。
 *
 * 抽成"接受模板参数"是为了管理侧模板（技术设计 §46）：不同技术栈的流程不一样
 * （前端要「需求评审 → 开发 → 联调 → 测试 → 上线」，后端还多一步「接口设计」），
 * 但"换工作流"这件事的规矩只有一套，不该写第二遍。
 */
export function applyWorkflowTemplate(
  ctx: ServiceContext,
  projectId: string,
  template: readonly WorkflowStatusTemplateItem[],
): WorkflowStatusDto[] {
  return inTransaction(ctx, () => {
    const existing = listStatuses(ctx, projectId);
    const now = ctx.now();

    // 1) 先建新状态（此时新旧并存，任务的旧状态仍然有效）
    const created: WorkflowStatusDto[] = [];
    template.forEach((item, index) => {
      const id = ctx.newId();
      ctx.db
        .insert(workflowStatuses)
        .values({
          id,
          projectId,
          name: item.name,
          color: item.color,
          category: item.category,
          sortOrder: (index + 1) * SORT_GAP,
          isDefault: 0,
          createdAt: now,
          updatedAt: now,
        })
        .run();
      created.push({
        id,
        projectId,
        name: item.name,
        color: item.color,
        category: item.category,
        sortOrder: (index + 1) * SORT_GAP,
        isDefault: false,
        createdAt: now,
        updatedAt: now,
      });
    });

    const fallback = created[0] as WorkflowStatusDto;

    // 2) 按分类把任务迁到对应的新状态
    for (const old of existing) {
      const target = created.find((s) => s.category === old.category) ?? fallback;
      ctx.db
        .update(tasks)
        .set({ statusId: target.id, updatedAt: now })
        .where(and(eq(tasks.projectId, projectId), eq(tasks.statusId, old.id)))
        .run();
    }

    // 3) 删除旧状态
    for (const old of existing) {
      ctx.db.delete(workflowStatuses).where(eq(workflowStatuses.id, old.id)).run();
    }

    ensureSingleDefault(ctx, projectId, fallback.id);

    recordActivity(ctx, {
      entityType: 'workflow_status',
      entityId: projectId,
      action: 'update',
      projectId,
      changes: { template: [existing.length, created.length] },
    });

    return listStatuses(ctx, projectId);
  });
}

/** 项目下未删除的任务数量（看板列头用） */
export function countActiveStatuses(ctx: ServiceContext, projectId: string): number {
  const row = ctx.db
    .select({ count: sql<number>`COUNT(*)` })
    .from(workflowStatuses)
    .where(eq(workflowStatuses.projectId, projectId))
    .get();
  return Number(row?.count ?? 0);
}

/** 未被使用的状态（提示用户"这个状态可以安全删除"） */
export function countTasksInStatus(ctx: ServiceContext, statusId: string): number {
  const row = ctx.db
    .select({ count: sql<number>`COUNT(*)` })
    .from(tasks)
    .where(and(eq(tasks.statusId, statusId), isNull(tasks.deletedAt)))
    .get();
  return Number(row?.count ?? 0);
}
