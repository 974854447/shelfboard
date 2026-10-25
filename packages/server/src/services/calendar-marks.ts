/**
 * 日历标记（M2）：某一天的自定义标记。
 *
 * 用户的原始要求是「日历添加标记功能」—— 日历上能自己往某一天加一条东西
 * （休假、发版日、生日、出差），它**不是任务**：没有状态、没有进度、不参与统计，
 * 只是"这天有件事"的提示，所以单独一张表，不硬塞进 tasks。
 *
 * 两条口径：
 * 1. **时区**：`date` 是某一天**本地零点**的毫秒时间戳，由渲染层算好传进来，
 *    服务端只做"落在区间里没有"的判断（与 services/task-query.ts 一致）。
 *    这样"9 月 26 日的标记"在任何时区都落在 9 月 26 日那一格。
 * 2. **归属**：标记是**工作区级**的，没有 `project_id` —— 理由见迁移
 *    `0005_calendar_marks` 的注释（它是我个人的时间安排，不该跟着项目切换而消失）。
 */

import { AppError } from '@pm-studio/shared';
import { and, asc, eq, gte, lte, type SQL } from 'drizzle-orm';

import { calendarMarks } from '../db/schema.js';
import { inTransaction, type ServiceContext } from './context.js';

export interface CalendarMarkDto {
  id: string;
  /** 这一天本地零点的毫秒时间戳 */
  date: number;
  title: string;
  color: string;
  note: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface CreateCalendarMarkInput {
  date: number;
  title: string;
  color?: string;
  note?: string | null;
}

export interface UpdateCalendarMarkInput {
  date?: number;
  title?: string;
  color?: string;
  note?: string | null;
}

export interface ListCalendarMarksOptions {
  /** 区间下限（含），一般是可见月历第一格的本地零点 */
  from?: number;
  /** 区间上限（含） */
  to?: number;
}

/** 标题长度上限：日历格子里只有一行，太长的标记会互相挤掉 */
export const MARK_TITLE_MAX = 40;
export const MARK_NOTE_MAX = 200;

type MarkRow = typeof calendarMarks.$inferSelect;

function toDto(row: MarkRow): CalendarMarkDto {
  return {
    id: row.id,
    date: row.date,
    title: row.title,
    color: row.color,
    note: row.note,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/** 颜色只接受 `#rrggbb`：界面上是几个预设色块，但接口不能只信界面 */
const COLOR_PATTERN = /^#[0-9a-fA-F]{6}$/;

function normalizeTitle(title: string): string {
  const trimmed = title.trim();
  if (trimmed.length === 0) throw new AppError('VALIDATION_FAILED', '标记内容不能为空');
  if (trimmed.length > MARK_TITLE_MAX) {
    throw new AppError('VALIDATION_FAILED', `标记内容最多 ${MARK_TITLE_MAX} 个字`);
  }
  return trimmed;
}

function normalizeDate(date: number): number {
  if (!Number.isFinite(date) || date <= 0) {
    throw new AppError('VALIDATION_FAILED', '标记的日期不合法');
  }
  return Math.trunc(date);
}

function normalizeColor(color: string | undefined): string {
  if (color === undefined) return '#3b82f6';
  if (!COLOR_PATTERN.test(color)) throw new AppError('VALIDATION_FAILED', '标记颜色要是 #RRGGBB');
  return color.toLowerCase();
}

function normalizeNote(note: string | null | undefined): string | null {
  if (note === undefined || note === null) return null;
  const trimmed = note.trim();
  if (trimmed.length === 0) return null;
  if (trimmed.length > MARK_NOTE_MAX) {
    throw new AppError('VALIDATION_FAILED', `标记备注最多 ${MARK_NOTE_MAX} 个字`);
  }
  return trimmed;
}

/** 按日期区间取标记（不传区间就是全部）；同一天内按创建时间排 */
export function listCalendarMarks(
  ctx: ServiceContext,
  options: ListCalendarMarksOptions = {},
): CalendarMarkDto[] {
  const conditions: SQL[] = [];
  if (options.from !== undefined) conditions.push(gte(calendarMarks.date, options.from));
  if (options.to !== undefined) conditions.push(lte(calendarMarks.date, options.to));

  return ctx.db
    .select()
    .from(calendarMarks)
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .orderBy(asc(calendarMarks.date), asc(calendarMarks.createdAt))
    .all()
    .map(toDto);
}

export function getCalendarMarkOrThrow(ctx: ServiceContext, id: string): MarkRow {
  const row = ctx.db.select().from(calendarMarks).where(eq(calendarMarks.id, id)).get();
  if (!row) throw new AppError('NOT_FOUND', '这个标记不存在', { details: { id } });
  return row;
}

export function createCalendarMark(
  ctx: ServiceContext,
  input: CreateCalendarMarkInput,
): CalendarMarkDto {
  const now = ctx.now();
  const id = ctx.newId();
  ctx.db
    .insert(calendarMarks)
    .values({
      id,
      date: normalizeDate(input.date),
      title: normalizeTitle(input.title),
      color: normalizeColor(input.color),
      note: normalizeNote(input.note),
      createdAt: now,
      updatedAt: now,
    })
    .run();
  return toDto(getCalendarMarkOrThrow(ctx, id));
}

export function updateCalendarMark(
  ctx: ServiceContext,
  id: string,
  patch: UpdateCalendarMarkInput,
): CalendarMarkDto {
  getCalendarMarkOrThrow(ctx, id);
  ctx.db
    .update(calendarMarks)
    .set({
      ...(patch.date !== undefined ? { date: normalizeDate(patch.date) } : {}),
      ...(patch.title !== undefined ? { title: normalizeTitle(patch.title) } : {}),
      ...(patch.color !== undefined ? { color: normalizeColor(patch.color) } : {}),
      ...(patch.note !== undefined ? { note: normalizeNote(patch.note) } : {}),
      updatedAt: ctx.now(),
    })
    .where(eq(calendarMarks.id, id))
    .run();
  return toDto(getCalendarMarkOrThrow(ctx, id));
}

/**
 * 删除标记：**直接删**，不进回收站。
 *
 * 任务走软删除是因为它带着子任务、依赖、工时这些"删错代价很大"的东西；
 * 一条日历标记就是一行字，留回收站只会多一个没人看的入口。
 * 界面上删除按钮是行内的小 ×，且会立即从格子里消失，所见即所得。
 */
export function deleteCalendarMark(ctx: ServiceContext, id: string): void {
  getCalendarMarkOrThrow(ctx, id);
  inTransaction(ctx, () => {
    ctx.db.delete(calendarMarks).where(eq(calendarMarks.id, id)).run();
  });
}

/** 标记总数（诊断包与统计用） */
export function countCalendarMarks(ctx: ServiceContext): number {
  const rows = ctx.sqlite.prepare('SELECT COUNT(*) AS n FROM calendar_marks').get() as
    | { n: number }
    | undefined;
  return Number(rows?.n ?? 0);
}
