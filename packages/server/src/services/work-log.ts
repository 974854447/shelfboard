/**
 * 工作日志（生成 Word 文档）。
 *
 * 用户的要求：
 * 「单独生成 word 文档，且单独保存到电脑的文件中，且在设置中可以修改日志保存地点，
 *   需要使用一定格式，不能直接列出当日所做的工作，且保存文档名称以当日为名，
 *   工作日志需要罗列我当日所做的工作内容」。
 *
 * 拆成两件事，刻意分开：
 *
 * 1. `collectWorkLogData` —— **取数**：这一天发生了什么（工时、完成、推进、新建）。
 *    它是纯查询，可以单独测、也可以在界面上先预览。
 * 2. `buildWorkLogDocument` —— **排版**：把数据排成一份能直接交出去的文档。
 *
 * 为什么不用"把当天的操作流水贴进一个 bullet 列表"：那种文档对读的人没有信息量。
 * 这份文档的结构是固定的四段（概要 / 按时段 / 分项目 / 当日新建），
 * 每段回答一个具体问题：今天投入了多少、几点在做什么、每个项目推进到哪、今天开了哪些新头。
 *
 * 文档里的数字**全部来自数据库**，没有一处是编的：某个项目今天没动过，它就不出现在
 * "分项目进展"里；当天没有会话，工时就是 00:00:00 而不是"约 8 小时"。
 */

import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { AppError, type Priority } from '@pm-studio/shared';
import {
  AlignmentType,
  BorderStyle,
  Document,
  HeadingLevel,
  Packer,
  Paragraph,
  Table,
  TableCell,
  TableRow,
  TextRun,
  WidthType,
} from 'docx';

import type { ServiceContext } from './context.js';
import { getDaySummary, localDateKey, localDayBounds } from './work-time.js';

/** 一天里的一条工作痕迹 */
export interface WorkLogEntry {
  taskId: string;
  title: string;
  projectName: string;
  statusName: string | null;
  priority: Priority;
  /** 已完成为 true */
  done: boolean;
  /** 完成时刻（仅"今日完成"有） */
  completedAt: number | null;
  /** 最后变更时刻 */
  updatedAt: number;
  /** 创建时刻 */
  createdAt: number;
  dueDate: number | null;
}

export interface WorkLogSession {
  startedAt: number;
  endedAt: number | null;
  /** 这条会话当天的有效毫秒数 */
  spanMs: number;
}

export interface WorkLogProjectGroup {
  projectId: string;
  projectName: string;
  /** 当天完成的任务 */
  completed: WorkLogEntry[];
  /** 当天动过但没完成的任务 */
  progressed: WorkLogEntry[];
  /** 当天新建的任务 */
  created: WorkLogEntry[];
}

export interface WorkLogData {
  dateKey: string;
  /** 形如「2026年9月29日 星期二」 */
  dateLabel: string;
  weekdayLabel: string;
  /** 当日工作时间（毫秒） */
  totalMs: number;
  /** 形如 03:25:10 */
  totalLabel: string;
  sessions: WorkLogSession[];
  /** 今日完成的任务（全部项目） */
  completed: WorkLogEntry[];
  /** 今日推进（动过但未完成） */
  progressed: WorkLogEntry[];
  /** 今日新建 */
  created: WorkLogEntry[];
  /** 按项目分组（只含当天有动静的项目） */
  projects: WorkLogProjectGroup[];
  generatedAt: number;
}

const WEEKDAYS = ['星期日', '星期一', '星期二', '星期三', '星期四', '星期五', '星期六'];

/** 毫秒 → HH:MM:SS */
export function formatDuration(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}

/** 时间戳 → 本地 HH:MM */
export function formatClock(timestamp: number): string {
  const d = new Date(timestamp);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/** 时间戳 → 本地 YYYY-MM-DD */
export function formatDate(timestamp: number): string {
  return localDateKey(timestamp);
}

const PRIORITY_LABELS: Record<Priority, string> = {
  urgent: '紧急',
  high: '高',
  medium: '中',
  low: '低',
};

interface RawRow {
  id: string;
  title: string;
  project_id: string;
  project_name: string;
  status_name: string | null;
  category: string | null;
  priority: string;
  completed_at: number | null;
  created_at: number;
  updated_at: number;
  due_date: number | null;
}

/**
 * 取某一天的工作数据。
 *
 * 一个查询取齐三类任务（完成 / 推进 / 新建）的**并集**，在 JS 里分类：
 * 一条任务完全可能既"今天新建"又"今天完成"（小事当天做完），
 * 分成三个查询再合并反而要处理"同一 id 出现在多处"的去重问题。
 */
export function collectWorkLogData(
  ctx: ServiceContext,
  dateKey: string = localDateKey(ctx.now()),
): WorkLogData {
  const at = ctx.now();
  const bounds = localDayBounds(dateKey);

  const rows = ctx.sqlite
    .prepare(
      `SELECT t.id, t.title, t.project_id, p.name AS project_name,
              ws.name AS status_name, ws.category,
              t.priority, t.completed_at, t.created_at, t.updated_at, t.due_date
         FROM tasks t
         JOIN projects p ON p.id = t.project_id
         LEFT JOIN workflow_statuses ws ON ws.id = t.status_id
        WHERE t.deleted_at IS NULL
          AND p.deleted_at IS NULL
          AND (
            (t.updated_at >= ? AND t.updated_at < ?)
            OR (t.created_at >= ? AND t.created_at < ?)
            OR (t.completed_at IS NOT NULL AND t.completed_at >= ? AND t.completed_at < ?)
          )
        ORDER BY t.updated_at ASC`,
    )
    .all(bounds.start, bounds.end, bounds.start, bounds.end, bounds.start, bounds.end) as unknown as RawRow[];

  const toEntry = (row: RawRow): WorkLogEntry => ({
    taskId: row.id,
    title: row.title,
    projectName: row.project_name,
    statusName: row.status_name,
    priority: row.priority as Priority,
    done: row.category === 'done',
    completedAt: row.completed_at,
    updatedAt: row.updated_at,
    createdAt: row.created_at,
    dueDate: row.due_date,
  });

  const inDay = (value: number | null): boolean =>
    value !== null && value >= bounds.start && value < bounds.end;

  const completed = rows.filter((row) => inDay(row.completed_at)).map(toEntry);
  const progressed = rows
    .filter((row) => row.category !== 'done' && inDay(row.updated_at))
    .map(toEntry);
  const created = rows.filter((row) => inDay(row.created_at)).map(toEntry);

  // 分项目：只要当天有动静就进来。项目名排序保证同一个项目每次生成的位置一致。
  const byProject = new Map<string, WorkLogProjectGroup>();
  const groupOf = (entry: WorkLogEntry, projectId: string, projectName: string) => {
    const existing = byProject.get(projectId);
    if (existing) return existing;
    const group: WorkLogProjectGroup = {
      projectId,
      projectName,
      completed: [],
      progressed: [],
      created: [],
    };
    byProject.set(projectId, group);
    return group;
  };
  for (const row of rows) {
    groupOf(toEntry(row), row.project_id, row.project_name);
  }
  for (const row of rows) {
    const group = groupOf(toEntry(row), row.project_id, row.project_name);
    const entry = toEntry(row);
    if (inDay(row.completed_at)) group.completed.push(entry);
    else if (row.category !== 'done' && inDay(row.updated_at)) group.progressed.push(entry);
    if (inDay(row.created_at)) group.created.push(entry);
  }

  const summary = getDaySummary(ctx, dateKey);
  const weekdayIndex = new Date(bounds.start).getDay();
  const date = new Date(bounds.start);

  return {
    dateKey,
    dateLabel: `${date.getFullYear()}年${date.getMonth() + 1}月${date.getDate()}日`,
    weekdayLabel: WEEKDAYS[weekdayIndex] ?? '',
    totalMs: summary.totalMs,
    totalLabel: formatDuration(summary.totalMs),
    sessions: summary.sessions.map((session) => ({
      startedAt: session.startedAt,
      endedAt: session.endedAt,
      spanMs: session.spanMs,
    })),
    completed,
    progressed,
    created,
    projects: [...byProject.values()].sort((a, b) => a.projectName.localeCompare(b.projectName, 'zh')),
    generatedAt: at,
  };
}

/* ------------------------------------------------------------------ */
/* 排版                                                                */
/* ------------------------------------------------------------------ */

const ACCENT = '2F5D8C';
const MUTED = '7A7A7A';

function title(text: string): Paragraph {
  return new Paragraph({
    alignment: AlignmentType.CENTER,
    spacing: { after: 80 },
    children: [new TextRun({ text, bold: true, size: 44, color: ACCENT })],
  });
}

function subtitle(text: string): Paragraph {
  return new Paragraph({
    alignment: AlignmentType.CENTER,
    spacing: { after: 240 },
    children: [new TextRun({ text, size: 22, color: MUTED })],
  });
}

function sectionHeading(text: string): Paragraph {
  return new Paragraph({
    heading: HeadingLevel.HEADING_1,
    spacing: { before: 320, after: 140 },
    children: [new TextRun({ text, bold: true, size: 28, color: ACCENT })],
  });
}

function subHeading(text: string): Paragraph {
  return new Paragraph({
    heading: HeadingLevel.HEADING_2,
    spacing: { before: 200, after: 100 },
    children: [new TextRun({ text, bold: true, size: 24 })],
  });
}

function body(text: string, options: { italic?: boolean; muted?: boolean } = {}): Paragraph {
  return new Paragraph({
    spacing: { after: 100 },
    children: [
      new TextRun({
        text,
        size: 22,
        ...(options.italic ? { italics: true } : {}),
        ...(options.muted ? { color: MUTED } : {}),
      }),
    ],
  });
}

/** 一条任务一行：`• 标题（状态 · 优先级 · 进度 40% · 截止 2026-10-01）` */
function bullet(text: string, note: string): Paragraph {
  return new Paragraph({
    bullet: { level: 0 },
    spacing: { after: 60 },
    children: [
      new TextRun({ text, size: 22, bold: true }),
      ...(note ? [new TextRun({ text: `（${note}）`, size: 20, color: MUTED })] : []),
    ],
  });
}

function entryNote(entry: WorkLogEntry): string {
  const parts: string[] = [];
  if (entry.statusName) parts.push(entry.statusName);
  parts.push(`优先级 ${PRIORITY_LABELS[entry.priority] ?? entry.priority}`);
  if (entry.dueDate !== null) parts.push(`截止 ${formatDate(entry.dueDate)}`);
  return parts.join(' · ');
}

function cell(text: string, options: { bold?: boolean; width?: number } = {}): TableCell {
  return new TableCell({
    ...(options.width !== undefined ? { width: { size: options.width, type: WidthType.PERCENTAGE } } : {}),
    margins: { top: 60, bottom: 60, left: 100, right: 100 },
    children: [
      new Paragraph({
        children: [new TextRun({ text, size: 21, bold: options.bold === true })],
      }),
    ],
  });
}

function infoTable(pairs: Array<[string, string]>): Table {
  return new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    borders: {
      top: { style: BorderStyle.SINGLE, size: 4, color: 'D8DEE6' },
      bottom: { style: BorderStyle.SINGLE, size: 4, color: 'D8DEE6' },
      left: { style: BorderStyle.SINGLE, size: 4, color: 'D8DEE6' },
      right: { style: BorderStyle.SINGLE, size: 4, color: 'D8DEE6' },
      insideHorizontal: { style: BorderStyle.SINGLE, size: 2, color: 'EDF1F5' },
      insideVertical: { style: BorderStyle.SINGLE, size: 2, color: 'EDF1F5' },
    },
    rows: pairs.map(
      ([label, value]) =>
        new TableRow({
          children: [cell(label, { bold: true, width: 22 }), cell(value, { width: 78 })],
        }),
    ),
  });
}

/**
 * 把一天的数据排成一份文档。
 *
 * 四段结构（每段回答一个具体问题）：
 * 1. 今日概要 —— 投入了多少、做了几件事（一张表 + 一段概述）
 * 2. 工作时段 —— 几点到几点在用（表格），以及每个时段里动过的任务
 * 3. 分项目进展 —— 每个项目：已完成 / 推进中 / 新建
 * 4. 说明 —— 数字是怎么来的（工时口径、生成时间、来源）
 *
 * 实现上刻意用**一个有序数组**装所有块（`blocks`）：第一版把标题和内容分两个数组攒、
 * 最后拼起来，结果四段标题全挤在开头、内容全堆在后面 —— Word 里一看就是错的。
 */
export function buildWorkLogDocument(data: WorkLogData): Document {
  const blocks: Array<Paragraph | Table> = [];

  blocks.push(title(`工作日志 · ${data.dateKey}`));
  blocks.push(subtitle(`${data.dateLabel} ${data.weekdayLabel}`));

  /* 一、今日概要 */
  blocks.push(sectionHeading('一、今日概要'));
  blocks.push(
    infoTable([
      ['日期', `${data.dateLabel} ${data.weekdayLabel}`],
      ['当日工作时间', `${data.totalLabel}（共 ${data.sessions.length} 段）`],
      ['完成任务', `${data.completed.length} 项`],
      ['推进中的任务', `${data.progressed.length} 项`],
      ['新建任务', `${data.created.length} 项`],
      [
        '涉及项目',
        data.projects.length > 0
          ? data.projects.map((project) => project.projectName).join('、')
          : '（今天没有项目有动静）',
      ],
    ]),
  );
  blocks.push(body(summarySentence(data), { muted: true }));

  /* 二、工作时段 */
  blocks.push(sectionHeading('二、工作时段'));
  if (data.sessions.length === 0) {
    blocks.push(body('这一天没有记录到使用时段（应用当天没有开过，或不在此工作区的记录里）。', { muted: true }));
  } else {
    blocks.push(sessionTable(data));
    for (const segment of segmentsOf(data)) {
      const range = `${formatClock(segment.startedAt)} — ${
        segment.endedAt === null ? '计时中' : formatClock(segment.endedAt)
      }`;
      blocks.push(subHeading(`${range}（${formatDuration(segment.spanMs)}）`));
      if (segment.entries.length === 0) {
        blocks.push(body('这段时间没有任务变更记录。', { muted: true }));
      } else {
        for (const entry of segment.entries) {
          blocks.push(bullet(entry.title, `[${entry.projectName}] ${entryNote(entry)}`));
        }
      }
    }
  }

  /* 三、分项目进展 */
  blocks.push(sectionHeading('三、分项目进展'));
  if (data.projects.length === 0) {
    blocks.push(body('这一天没有任何项目的任务发生变更。', { muted: true }));
  }
  for (const project of data.projects) {
    blocks.push(subHeading(project.projectName));
    if (project.completed.length > 0) {
      blocks.push(body('已完成：'));
      for (const entry of project.completed) blocks.push(bullet(entry.title, entryNote(entry)));
    }
    if (project.progressed.length > 0) {
      blocks.push(body('推进中：'));
      for (const entry of project.progressed) blocks.push(bullet(entry.title, entryNote(entry)));
    }
    if (project.created.length > 0) {
      blocks.push(body('本日新增：'));
      for (const entry of project.created) blocks.push(bullet(entry.title, entryNote(entry)));
    }
  }

  /* 四、说明 */
  blocks.push(sectionHeading('四、说明'));
  blocks.push(
    body(
      `本文件由项目管理系统于 ${formatDate(data.generatedAt)} ${formatClock(data.generatedAt)} 自动生成。`,
      { muted: true },
    ),
  );
  blocks.push(
    body(
      '当日工作时间按「应用当天第一次打开到最后一次关闭」统计：一天里多次开关会分成多段，' +
        '合计即上表中的总时长；应用被强制结束（断电、结束进程）时，那一段只计到最后一次心跳为止。',
      { muted: true },
    ),
  );
  blocks.push(
    body('任务条目全部取自本地数据库的当日变更（完成 / 状态或字段变更 / 新建），没有人工补写的内容。', {
      muted: true,
    }),
  );

  return new Document({
    creator: '项目管理系统',
    title: `工作日志 ${data.dateKey}`,
    description: `${data.dateLabel} 工作日志`,
    sections: [{ children: blocks }],
  });
}

function summarySentence(data: WorkLogData): string {
  const parts: string[] = [`当日累计投入 ${data.totalLabel}。`];
  if (data.completed.length > 0) parts.push(`完成 ${data.completed.length} 项任务。`);
  if (data.progressed.length > 0) parts.push(`推进 ${data.progressed.length} 项未完成任务。`);
  if (data.created.length > 0) parts.push(`新建 ${data.created.length} 项任务。`);
  if (data.projects.length > 0) parts.push(`共涉及 ${data.projects.length} 个项目。`);
  if (data.completed.length + data.progressed.length + data.created.length === 0) {
    parts.push('这一天没有任务变更记录。');
  }
  return parts.join('');
}

function sessionTable(data: WorkLogData): Table {
  return new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    borders: {
      top: { style: BorderStyle.SINGLE, size: 4, color: 'D8DEE6' },
      bottom: { style: BorderStyle.SINGLE, size: 4, color: 'D8DEE6' },
      left: { style: BorderStyle.SINGLE, size: 4, color: 'D8DEE6' },
      right: { style: BorderStyle.SINGLE, size: 4, color: 'D8DEE6' },
      insideHorizontal: { style: BorderStyle.SINGLE, size: 2, color: 'EDF1F5' },
      insideVertical: { style: BorderStyle.SINGLE, size: 2, color: 'EDF1F5' },
    },
    rows: [
      new TableRow({
        children: [
          cell('开始', { bold: true, width: 25 }),
          cell('结束', { bold: true, width: 25 }),
          cell('时长', { bold: true, width: 25 }),
          cell('变动任务数', { bold: true, width: 25 }),
        ],
      }),
      ...segmentsOf(data).map(
        (segment) =>
          new TableRow({
            children: [
              cell(formatClock(segment.startedAt)),
              cell(segment.endedAt === null ? '计时中' : formatClock(segment.endedAt)),
              cell(formatDuration(segment.spanMs)),
              cell(String(segment.entries.length)),
            ],
          }),
      ),
    ],
  });
}

interface Segment {
  startedAt: number;
  endedAt: number | null;
  spanMs: number;
  entries: WorkLogEntry[];
}

/**
 * 把任务变更分配到时间段的规则：**按变更时刻归到第一条覆盖它的会话**，
 * 落在所有会话之外的（比如会话之间的空档里改的）归到最近的前一段。
 *
 * 这么分而不是"按项目硬排"，是因为文档的第二段要回答的是"我那段时间在干什么"，
 * 时间对不上就没有意义了。
 */
export function segmentsOf(data: WorkLogData): Segment[] {
  const entries = dedupeEntries([...data.completed, ...data.progressed, ...data.created]);
  const segments: Segment[] = data.sessions
    .slice()
    .sort((a, b) => a.startedAt - b.startedAt)
    .map((session) => ({ ...session, entries: [] }));

  if (segments.length === 0) {
    return [{ startedAt: data.generatedAt, endedAt: null, spanMs: 0, entries }];
  }

  for (const entry of entries) {
    const stamp = entry.completedAt ?? entry.updatedAt;
    let target = segments.find(
      (segment) =>
        stamp >= segment.startedAt && (segment.endedAt === null || stamp < segment.endedAt),
    );
    if (!target) {
      // 落在会话之外：取开始时间在它之前的最后一段
      const before = segments.filter((segment) => segment.startedAt <= stamp);
      target = before.length > 0 ? before[before.length - 1] : segments[0];
    }
    target?.entries.push(entry);
  }

  for (const segment of segments) {
    segment.entries.sort((a, b) => (a.completedAt ?? a.updatedAt) - (b.completedAt ?? b.updatedAt));
  }
  return segments;
}

/** 同一条任务可能既是"今天完成"又是"今天新建"，在按时段罗列时只出现一次 */
function dedupeEntries(entries: readonly WorkLogEntry[]): WorkLogEntry[] {
  const seen = new Set<string>();
  const result: WorkLogEntry[] = [];
  for (const entry of entries) {
    if (seen.has(entry.taskId)) continue;
    seen.add(entry.taskId);
    result.push(entry);
  }
  return result;
}

/* ------------------------------------------------------------------ */
/* 落盘                                                                */
/* ------------------------------------------------------------------ */

export interface SaveWorkLogResult {
  /** 生成的文件绝对路径 */
  path: string;
  /** 所在目录 */
  dir: string;
  /** 文件字节数 */
  bytes: number;
  /** 是否覆盖了同名文件 */
  overwritten: boolean;
  data: WorkLogData;
}

export interface SaveWorkLogOptions {
  /** 日期键；默认今天 */
  dateKey?: string;
  /**
   * 保存目录。不传则用主进程配置的默认目录。
   *
   * 允许调用方指定：设置里改了目录之后应当**立刻**生效，
   * 而默认目录是在应用启动时注入到服务上下文里的（改设置不该要求重启）。
   */
  dir?: string;
  /** 文件名（不含扩展名）；默认用机器可读的日期 */
  fileName?: string;
}

/**
 * 文件名里不能出现的字符（Windows 比 POSIX 严：还禁 `:` 与结尾的点/空格）。
 *
 * 除了替换，还顺手**合并连续的连字符并去掉首尾的连字符**：
 * 名字 `09:30 工作日志?` 替换完是 `09-30 工作日志-`，那个尾巴上的短横纯属噪音
 * （用户看到的是一个莫名其妙的文件名）。
 */
function sanitizeFileName(name: string): string {
  return name
    // 控制字符（0x00–0x1F）与 Windows 禁用字符一并换成短横。
    // eslint-disable-next-line no-control-regex -- 这里**就是要**匹配控制字符：文件名里带上它们会让写入直接失败
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^[-. ]+/, '')
    .replace(/[-. ]+$/, '')
    .trim();
}

export function resolveWorkLogDir(ctx: ServiceContext, requested?: string): string {
  const dir = requested?.trim() || ctx.workLogDir;
  if (!dir) {
    throw new AppError(
      'VALIDATION_FAILED',
      '没有可用的工作日志保存目录：请在「设置」里指定一个目录',
    );
  }
  return dir;
}

/** 生成并保存工作日志（Word）。返回真实路径 —— 界面上要把它显示给用户，而不是只说"成功" */
export async function saveWorkLog(
  ctx: ServiceContext,
  options: SaveWorkLogOptions = {},
): Promise<SaveWorkLogResult> {
  const dateKey = options.dateKey ?? localDateKey(ctx.now());
  const dir = resolveWorkLogDir(ctx, options.dir);
  const data = collectWorkLogData(ctx, dateKey);
  const stem = sanitizeFileName(options.fileName ?? `${dateKey} 工作日志`);
  const target = join(dir, `${stem}.docx`);

  mkdirSync(dir, { recursive: true });
  /*
   * 是否"覆盖了同名文件"要在写之前问，写完再问永远是 true。
   * 这件事必须如实告诉用户：他在 Word 里改过的同名文件会被覆盖掉。
   */
  const overwritten = existsSync(target);
  const buffer = await Packer.toBuffer(buildWorkLogDocument(data));
  writeFileSync(target, buffer);

  ctx.logger.info('已生成工作日志', { path: target, dateKey, bytes: buffer.byteLength, overwritten });
  return { path: target, dir, bytes: buffer.byteLength, overwritten, data };
}
