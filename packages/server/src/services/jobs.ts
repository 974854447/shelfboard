/**
 * 作业（jobs）数据层。
 *
 * 作业是"会跑一会儿、可能失败、要能看到进度与日志"的事情：装依赖、跑脚手架、
 * 导出诊断包、迁移工作区。它们在 M1 就把表建好了（`jobs` / `job_logs`），
 * 功能到 M4 才落地 —— 表先建的原因是 SQLite 没法给已有表补外键，见技术设计 §5.1。
 *
 * 这一层只做**数据**：建行、改状态、记日志、查列表。
 * "怎么排、怎么并发、怎么取消"在 `job-runner.ts`，"怎么暴露给界面"在 `routes/jobs.ts`。
 *
 * 日志双写：数据库 `job_logs` 供界面查询与诊断包，`logs/jobs/<id>.log` 供"崩溃后整包取出"
 * （进程被强杀时数据库可能还没写入最后几行）。
 */

import { AppError } from '@pm-studio/shared';
import { and, asc, desc, eq, gt, sql, type SQL } from 'drizzle-orm';

import { jobLogs, jobs } from '../db/schema.js';
import type { ServiceContext } from './context.js';

/**
 * 作业状态机（与技术设计 §5.3 一致）：
 *
 * ```
 * queued ──▶ running ──▶ succeeded
 *    │          │
 *    │          ├──▶ failed
 *    │          └──▶ canceled
 *    └──▶ interrupted（启动时对残留状态做恢复）
 * ```
 */
export type JobStatus =
  | 'queued'
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'canceled'
  | 'interrupted';

/** 已经结束、不会再变的状态 */
export const TERMINAL_JOB_STATUSES: readonly JobStatus[] = [
  'succeeded',
  'failed',
  'canceled',
  'interrupted',
];

export function isJobFinished(status: JobStatus): boolean {
  return TERMINAL_JOB_STATUSES.includes(status);
}

export interface JobDto {
  id: string;
  type: string;
  title: string;
  status: JobStatus;
  /** 当前阶段的人话描述（例："正在装依赖"） */
  phase: string | null;
  /** 0~100 */
  percent: number;
  payload: Record<string, unknown> | null;
  result: Record<string, unknown> | null;
  errorCode: string | null;
  errorMessage: string | null;
  logFile: string | null;
  createdAt: number;
  startedAt: number | null;
  finishedAt: number | null;
}

export interface JobLogDto {
  id: string;
  jobId: string;
  ts: number;
  level: 'info' | 'warn' | 'error';
  message: string;
}

type JobRow = typeof jobs.$inferSelect;
type JobLogRow = typeof jobLogs.$inferSelect;

function parseJson(text: string | null): Record<string, unknown> | null {
  if (!text) return null;
  try {
    const parsed = JSON.parse(text) as unknown;
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null;
  } catch {
    // 老行或手工改坏的 JSON：当作没有，而不是让整个列表接口挂掉
    return null;
  }
}

function toJobDto(row: JobRow): JobDto {
  return {
    id: row.id,
    type: row.type,
    title: row.title,
    status: row.status as JobStatus,
    phase: row.phase,
    percent: Number(row.percent ?? 0),
    payload: parseJson(row.payloadJson),
    result: parseJson(row.resultJson),
    errorCode: row.errorCode,
    errorMessage: row.errorMessage,
    logFile: row.logFile,
    createdAt: row.createdAt,
    startedAt: row.startedAt,
    finishedAt: row.finishedAt,
  };
}

function toLogDto(row: JobLogRow): JobLogDto {
  return {
    id: row.id,
    jobId: row.jobId,
    ts: row.ts,
    level: (row.level as JobLogDto['level']) ?? 'info',
    message: row.message,
  };
}

/* ------------------------------------------------------------------ */

export interface CreateJobInput {
  /** 一般不用传（内部生成）；runner 需要"先有 id 才能定日志文件名"时才传 */
  id?: string;
  type: string;
  title: string;
  payload?: Record<string, unknown>;
  logFile?: string;
}

/** 建一个 queued 状态的作业。**只建行**，不负责排进队列（那是 runner 的事） */
export function createJob(ctx: ServiceContext, input: CreateJobInput): JobDto {
  const id = input.id ?? ctx.newId();
  ctx.db
    .insert(jobs)
    .values({
      id,
      type: input.type,
      title: input.title,
      status: 'queued',
      percent: 0,
      payloadJson: input.payload ? JSON.stringify(input.payload) : null,
      logFile: input.logFile ?? null,
      createdAt: ctx.now(),
    })
    .run();
  return getJobOrThrow(ctx, id);
}

export function findJob(ctx: ServiceContext, id: string): JobRow | undefined {
  return ctx.db.select().from(jobs).where(eq(jobs.id, id)).get();
}

export function getJobOrThrow(ctx: ServiceContext, id: string): JobDto {
  const row = findJob(ctx, id);
  if (!row) throw new AppError('NOT_FOUND', '这个作业不存在', { details: { id } });
  return toJobDto(row);
}

export interface UpdateJobPatch {
  status?: JobStatus;
  phase?: string | null;
  percent?: number;
  result?: Record<string, unknown> | null;
  errorCode?: string | null;
  errorMessage?: string | null;
  startedAt?: number | null;
  finishedAt?: number | null;
}

/** 改一行作业。`percent` 会被夹在 0~100：界面上的进度条不接受越界值 */
export function updateJob(ctx: ServiceContext, id: string, patch: UpdateJobPatch): JobDto {
  const values: Partial<typeof jobs.$inferInsert> = {};
  if (patch.status !== undefined) values.status = patch.status;
  if (patch.phase !== undefined) values.phase = patch.phase;
  if (patch.percent !== undefined) values.percent = Math.max(0, Math.min(100, Math.round(patch.percent)));
  if (patch.result !== undefined) {
    values.resultJson = patch.result === null ? null : JSON.stringify(patch.result);
  }
  if (patch.errorCode !== undefined) values.errorCode = patch.errorCode;
  if (patch.errorMessage !== undefined) values.errorMessage = patch.errorMessage;
  if (patch.startedAt !== undefined) values.startedAt = patch.startedAt;
  if (patch.finishedAt !== undefined) values.finishedAt = patch.finishedAt;

  if (Object.keys(values).length > 0) {
    ctx.db.update(jobs).set(values).where(eq(jobs.id, id)).run();
  }
  return getJobOrThrow(ctx, id);
}

/** 批量写日志（runner 每 500ms 或 50 行刷一次，不逐行写库） */
export function appendJobLogs(
  ctx: ServiceContext,
  jobId: string,
  entries: ReadonlyArray<{ level?: JobLogDto['level']; message: string; ts?: number }>,
): JobLogDto[] {
  if (entries.length === 0) return [];
  const created: JobLogDto[] = [];
  const insert = ctx.db.insert(jobLogs);
  for (const entry of entries) {
    const row = {
      id: ctx.newId(),
      jobId,
      ts: entry.ts ?? ctx.now(),
      level: entry.level ?? 'info',
      message: entry.message,
    };
    insert.values(row).run();
    created.push({
      id: row.id,
      jobId,
      ts: row.ts,
      level: row.level,
      message: row.message,
    });
  }
  return created;
}

export interface ListJobsOptions {
  status?: JobStatus;
  type?: string;
  limit?: number;
}

export function listJobs(ctx: ServiceContext, options: ListJobsOptions = {}): JobDto[] {
  const conditions: SQL[] = [];
  if (options.status) conditions.push(eq(jobs.status, options.status));
  if (options.type) conditions.push(eq(jobs.type, options.type));

  return ctx.db
    .select()
    .from(jobs)
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .orderBy(desc(jobs.createdAt))
    .limit(Math.min(Math.max(options.limit ?? 50, 1), 500))
    .all()
    .map(toJobDto);
}

/** 取某个作业的日志；`afterTs` 用于 SSE 重连后补拉（避免重复推送） */
export function listJobLogs(
  ctx: ServiceContext,
  jobId: string,
  options: { afterTs?: number; limit?: number } = {},
): JobLogDto[] {
  getJobOrThrow(ctx, jobId);
  const conditions: SQL[] = [eq(jobLogs.jobId, jobId)];
  if (options.afterTs !== undefined) conditions.push(gt(jobLogs.ts, options.afterTs));

  return ctx.db
    .select()
    .from(jobLogs)
    .where(and(...conditions))
    .orderBy(asc(jobLogs.ts))
    .limit(Math.min(Math.max(options.limit ?? 2000, 1), 5000))
    .all()
    .map(toLogDto);
}

export function countJobs(ctx: ServiceContext, status?: JobStatus): number {
  const row = ctx.db
    .select({ count: sql<number>`COUNT(*)` })
    .from(jobs)
    .where(status ? eq(jobs.status, status) : undefined)
    .get();
  return Number(row?.count ?? 0);
}

/**
 * 启动时的崩溃恢复：把残留的 `queued` / `running` 标成 `interrupted`。
 *
 * **必须做**：进程被强杀（断电、任务管理器结束）之后，那两行会永远停在"排队中/进行中"，
 * 而队列是内存里的、早没了 —— 界面上就会出现一个永远不动的作业，用户只能干等。
 * 标记为"已中断"并说明原因，比假装它还在跑诚实得多（技术设计 §5.3）。
 */
export function recoverInterruptedJobs(ctx: ServiceContext): number {
  const stale = ctx.sqlite
    .prepare("SELECT id FROM jobs WHERE status IN ('queued', 'running')")
    .all() as Array<{ id: string }>;
  if (stale.length === 0) return 0;

  const now = ctx.now();
  for (const row of stale) {
    ctx.db
      .update(jobs)
      .set({
        status: 'interrupted',
        errorCode: 'INTERRUPTED',
        errorMessage: '应用在这次作业跑完之前退出了（或被杀掉），作业没有完成',
        finishedAt: now,
      })
      .where(eq(jobs.id, row.id))
      .run();
  }
  return stale.length;
}
