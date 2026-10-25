/**
 * 活动日志（activity_logs）。
 *
 * 定位：**系统自动记录关键变更**，不是评论功能（评论已明确不做）。
 * 用途是回答"这条任务的状态什么时候被谁改的"。
 *
 * 两条纪律：
 * 1. 只记录**发生变化**的字段。把没变的字段也写进去，日志会迅速膨胀成
 *    无用的噪音，最后没人看。
 * 2. 活动日志写失败**不影响主流程**。它是审计信息，不是业务约束；
 *    为了记日志而让用户的编辑失败是本末倒置。
 */

import { and, desc, eq, type SQL } from 'drizzle-orm';

import { activityLogs, type ActivityLog } from '../db/schema.js';
import { newEntityId } from '../util/id.js';
import type { ServiceContext } from './context.js';

export type ActivityAction = 'create' | 'update' | 'delete' | 'restore' | 'move';

export interface ActivityInput {
  entityType: string;
  entityId: string;
  action: ActivityAction;
  projectId?: string | null;
  /** `{ 字段名: [旧值, 新值] }` */
  changes?: Record<string, [unknown, unknown]> | null;
}

export function recordActivity(ctx: ServiceContext, input: ActivityInput): void {
  try {
    ctx.db
      .insert(activityLogs)
      .values({
        id: ctx.newId(),
        entityType: input.entityType,
        entityId: input.entityId,
        projectId: input.projectId ?? null,
        action: input.action,
        changesJson: input.changes ? JSON.stringify(input.changes) : null,
        actorId: ctx.actorId,
        createdAt: ctx.now(),
      })
      .run();
  } catch (error) {
    // 审计写入失败不应中断业务操作
    ctx.logger.warn('写入活动日志失败', { entityType: input.entityType, error });
  }
}

/**
 * 对比变更前后，只挑出真正变化的字段。
 *
 * 返回 `null` 表示"没有任何字段变化" —— 调用方据此可以跳过写库与写日志，
 * 避免产生一堆"内容没变但更新时间变了"的无意义记录。
 */
export function diffChanges<T extends Record<string, unknown>>(
  before: T,
  patch: Partial<T>,
  fields: ReadonlyArray<keyof T>,
): Record<string, [unknown, unknown]> | null {
  const changes: Record<string, [unknown, unknown]> = {};

  for (const field of fields) {
    if (!(field in patch)) continue;
    const next = patch[field];
    const previous = before[field];
    if (next === undefined) continue;
    if (Object.is(previous, next)) continue;
    changes[String(field)] = [previous ?? null, next ?? null];
  }

  return Object.keys(changes).length > 0 ? changes : null;
}

export interface ListActivityOptions {
  entityType?: string;
  entityId?: string;
  projectId?: string;
  limit?: number;
}

export function listActivity(ctx: ServiceContext, options: ListActivityOptions = {}): ActivityLog[] {
  const conditions: SQL[] = [];
  if (options.entityType) conditions.push(eq(activityLogs.entityType, options.entityType));
  if (options.entityId) conditions.push(eq(activityLogs.entityId, options.entityId));
  if (options.projectId) conditions.push(eq(activityLogs.projectId, options.projectId));

  const limit = Math.min(Math.max(options.limit ?? 100, 1), 1000);

  return ctx.db
    .select()
    .from(activityLogs)
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .orderBy(desc(activityLogs.createdAt))
    .limit(limit)
    .all();
}

/** 供"某实体最近发生了什么"用：附带生成一条可读描述 */
export function describeActivity(log: ActivityLog): string {
  const verb: Record<string, string> = {
    create: '创建',
    update: '修改',
    delete: '删除',
    restore: '还原',
    move: '移动',
  };
  const base = `${verb[log.action] ?? log.action}了 ${log.entityType}`;
  if (!log.changesJson) return base;

  try {
    const changes = JSON.parse(log.changesJson) as Record<string, [unknown, unknown]>;
    const fields = Object.keys(changes);
    return fields.length > 0 ? `${base}（${fields.join('、')}）` : base;
  } catch {
    return base;
  }
}

/** 仅供测试与内部使用：快速造一个 id */
export function newActivityId(now?: number): string {
  return newEntityId(now);
}
