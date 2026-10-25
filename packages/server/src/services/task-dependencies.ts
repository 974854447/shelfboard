/**
 * 任务依赖关系。
 *
 * 核心是**成环检测**：任务依赖构成有向图，"A 依赖 B、B 依赖 C、C 依赖 A"
 * 这种环一旦写进库，任何按依赖做拓扑排序的地方（M6 的甘特图关键路径、
 * 递归展开前置任务）都会死循环或栈溢出。所以在**写入时**就拦下。
 *
 * 判断方法：新增边 `P → S`（S 依赖 P）会成环，当且仅当
 * **S 已经能沿后继边到达 P**（或 P === S）。用迭代式 DFS 做可达性判断，
 * 不用递归——依赖链可能很长，递归有爆栈风险。
 */

import type { CreateDependencyInput, DependencyType } from '@pm-studio/shared';
import { AppError } from '@pm-studio/shared';
import { and, eq, or } from 'drizzle-orm';

import { taskDependencies, tasks } from '../db/schema.js';
import { recordActivity } from './activity.js';
import { inTransaction, type ServiceContext } from './context.js';

export interface DependencyDto {
  id: string;
  predecessorId: string;
  successorId: string;
  type: DependencyType;
  lagDays: number;
  createdAt: number;
}

type DependencyRow = typeof taskDependencies.$inferSelect;

function toDto(row: DependencyRow): DependencyDto {
  return {
    id: row.id,
    predecessorId: row.predecessorId,
    successorId: row.successorId,
    type: row.type as DependencyType,
    lagDays: row.lagDays,
    createdAt: row.createdAt,
  };
}

/** 迭代式可达性判断：from 是否能沿后继边到达 target */
export function reaches(ctx: ServiceContext, from: string, target: string): boolean {
  const seen = new Set<string>();
  const stack: string[] = [from];
  const nextStmt = ctx.sqlite.prepare(
    'SELECT successor_id FROM task_dependencies WHERE predecessor_id = ?',
  );

  while (stack.length > 0) {
    const current = stack.pop() as string;
    if (current === target) return true;
    if (seen.has(current)) continue;
    seen.add(current);

    const rows = nextStmt.all(current) as Array<{ successor_id: string }>;
    for (const row of rows) {
      if (!seen.has(row.successor_id)) stack.push(row.successor_id);
    }
  }

  return false;
}

/**
 * 新增边 `predecessor → successor` 是否会成环。
 *
 * 自环（自己依赖自己）也算环 —— 它同样会让拓扑排序卡住。
 */
export function wouldCreateCycle(
  ctx: ServiceContext,
  predecessorId: string,
  successorId: string,
): boolean {
  if (predecessorId === successorId) return true;
  return reaches(ctx, successorId, predecessorId);
}

function getTaskOrThrow(ctx: ServiceContext, id: string) {
  const task = ctx.db.select().from(tasks).where(eq(tasks.id, id)).get();
  if (!task) throw new AppError('NOT_FOUND', '任务不存在', { details: { id } });
  return task;
}

export function addDependency(
  ctx: ServiceContext,
  input: CreateDependencyInput,
): DependencyDto {
  return inTransaction(ctx, () => {
    const predecessor = getTaskOrThrow(ctx, input.predecessorId);
    const successor = getTaskOrThrow(ctx, input.successorId);

    if (predecessor.projectId !== successor.projectId) {
      throw new AppError('VALIDATION_FAILED', '不能跨项目建立任务依赖', {
        details: { predecessorProject: predecessor.projectId, successorProject: successor.projectId },
      });
    }

    if (wouldCreateCycle(ctx, input.predecessorId, input.successorId)) {
      throw new AppError(
        'DEPENDENCY_CYCLE',
        input.predecessorId === input.successorId
          ? '任务不能依赖自己'
          : '该依赖会形成环，任务依赖必须是无环图',
        { details: { predecessorId: input.predecessorId, successorId: input.successorId } },
      );
    }

    const existing = ctx.db
      .select()
      .from(taskDependencies)
      .where(
        and(
          eq(taskDependencies.predecessorId, input.predecessorId),
          eq(taskDependencies.successorId, input.successorId),
        ),
      )
      .get();

    if (existing) {
      throw new AppError('CONFLICT', '这两个任务之间已存在依赖关系', {
        details: { id: existing.id },
      });
    }

    const id = ctx.newId();
    ctx.db
      .insert(taskDependencies)
      .values({
        id,
        predecessorId: input.predecessorId,
        successorId: input.successorId,
        type: input.type ?? 'FS',
        lagDays: input.lagDays ?? 0,
        createdAt: ctx.now(),
      })
      .run();

    recordActivity(ctx, {
      entityType: 'task_dependency',
      entityId: id,
      action: 'create',
      projectId: predecessor.projectId,
      changes: { edge: [null, `${input.predecessorId} -> ${input.successorId}`] },
    });

    return toDto(
      ctx.db.select().from(taskDependencies).where(eq(taskDependencies.id, id)).get() as DependencyRow,
    );
  });
}

export function removeDependency(ctx: ServiceContext, id: string): void {
  inTransaction(ctx, () => {
    const row = ctx.db.select().from(taskDependencies).where(eq(taskDependencies.id, id)).get();
    if (!row) throw new AppError('NOT_FOUND', '依赖关系不存在', { details: { id } });

    ctx.db.delete(taskDependencies).where(eq(taskDependencies.id, id)).run();

    recordActivity(ctx, {
      entityType: 'task_dependency',
      entityId: id,
      action: 'delete',
      changes: { edge: [`${row.predecessorId} -> ${row.successorId}`, null] },
    });
  });
}

export interface TaskDependencyView {
  /** 该任务依赖的任务（前置） */
  predecessors: DependencyDto[];
  /** 依赖该任务的任务（后继） */
  successors: DependencyDto[];
}

export function listDependenciesForTask(
  ctx: ServiceContext,
  taskId: string,
): TaskDependencyView {
  const rows = ctx.db
    .select()
    .from(taskDependencies)
    .where(
      or(eq(taskDependencies.predecessorId, taskId), eq(taskDependencies.successorId, taskId)),
    )
    .all()
    .map(toDto);

  return {
    predecessors: rows.filter((d) => d.successorId === taskId),
    successors: rows.filter((d) => d.predecessorId === taskId),
  };
}

export function listProjectDependencies(ctx: ServiceContext, projectId: string): DependencyDto[] {
  return ctx.sqlite
    .prepare(
      `SELECT d.* FROM task_dependencies d
       JOIN tasks t ON t.id = d.successor_id
       WHERE t.project_id = ?`,
    )
    .all(projectId)
    .map((row) => {
      const r = row as {
        id: string;
        predecessor_id: string;
        successor_id: string;
        type: string;
        lag_days: number;
        created_at: number;
      };
      return {
        id: r.id,
        predecessorId: r.predecessor_id,
        successorId: r.successor_id,
        type: r.type as DependencyType,
        lagDays: r.lag_days,
        createdAt: r.created_at,
      };
    });
}

/** 供测试与诊断用：整张依赖图是否存在环 */
export function hasCycle(ctx: ServiceContext, projectId: string): boolean {
  const edges = listProjectDependencies(ctx, projectId);
  const adjacency = new Map<string, string[]>();
  for (const edge of edges) {
    const list = adjacency.get(edge.predecessorId) ?? [];
    list.push(edge.successorId);
    adjacency.set(edge.predecessorId, list);
  }

  const state = new Map<string, 'visiting' | 'done'>();

  for (const node of adjacency.keys()) {
    if (state.get(node) === 'done') continue;

    const stack: Array<{ id: string; index: number }> = [{ id: node, index: 0 }];
    state.set(node, 'visiting');

    while (stack.length > 0) {
      const frame = stack[stack.length - 1] as { id: string; index: number };
      const neighbours = adjacency.get(frame.id) ?? [];

      if (frame.index >= neighbours.length) {
        state.set(frame.id, 'done');
        stack.pop();
        continue;
      }

      const next = neighbours[frame.index] as string;
      frame.index += 1;

      const nextState = state.get(next);
      if (nextState === 'visiting') return true;
      if (nextState === 'done') continue;

      state.set(next, 'visiting');
      stack.push({ id: next, index: 0 });
    }
  }

  return false;
}
