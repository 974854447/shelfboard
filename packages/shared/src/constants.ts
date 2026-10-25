/**
 * 跨包共享常量。
 *
 * 日志级别与来源分区一旦确定，前端筛选器、数据库取值、SSE 事件都依赖它，
 * 因此集中定义在此，避免前后端各写一份字符串常量。
 */

export const LOG_LEVELS = ['error', 'warn', 'info', 'debug'] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

export const LOG_SOURCES = ['main', 'api', 'job', 'renderer'] as const;
export type LogSource = (typeof LOG_SOURCES)[number];

/** 数值越大越严重，用于「级别 >= warn」这类筛选 */
export const LOG_LEVEL_WEIGHT: Record<LogLevel, number> = {
  error: 40,
  warn: 30,
  info: 20,
  debug: 10,
};

export function isLogLevel(value: unknown): value is LogLevel {
  return typeof value === 'string' && (LOG_LEVELS as readonly string[]).includes(value);
}

export function isLogSource(value: unknown): value is LogSource {
  return typeof value === 'string' && (LOG_SOURCES as readonly string[]).includes(value);
}

/** 日志默认值（技术设计 §11 已记录，可由设置覆盖） */
export const DEFAULT_LOG_RETENTION_DAYS = 30;
export const DEFAULT_LOG_FILE_MAX_MB = 5;
export const DEFAULT_LOG_FILE_KEEP = 5;
/** 内存缓冲：每 500ms 或累计 200 条刷一次，避免高频日志把 SQLite 写爆 */
export const DEFAULT_LOG_FLUSH_INTERVAL_MS = 500;
export const DEFAULT_LOG_FLUSH_BATCH = 200;

/* ------------------------------------------------------------------ *
 * 领域枚举
 *
 * 全部用 `as const` 数组 + 派生联合类型：zod 校验、数据库取值、
 * 前端下拉选项三处共用一份定义，不会出现"后端加了新优先级、前端不认识"。
 * ------------------------------------------------------------------ */

/** 任务与工单共用的优先级 */
export const PRIORITIES = ['low', 'medium', 'high', 'urgent'] as const;
export type Priority = (typeof PRIORITIES)[number];

/**
 * 工作流状态的分类。
 *
 * 与"状态名可自由增删改"解耦：用户可以把状态改名成任何样子，
 * 但分类固定，进度统计、看板完成判定才不会被改名破坏。
 */
export const STATUS_CATEGORIES = ['todo', 'doing', 'done'] as const;
export type StatusCategory = (typeof STATUS_CATEGORIES)[number];

export const PROJECT_STATUSES = ['active', 'archived'] as const;
export type ProjectStatus = (typeof PROJECT_STATUSES)[number];

/** 任务依赖类型：完成-开始 / 开始-开始 / 完成-完成 / 开始-完成 */
export const DEPENDENCY_TYPES = ['FS', 'SS', 'FF', 'SF'] as const;
export type DependencyType = (typeof DEPENDENCY_TYPES)[number];

/** 项目代码形态 */
export const CODE_KINDS = ['frontend', 'backend', 'fullstack'] as const;
export type CodeKind = (typeof CODE_KINDS)[number];

/**
 * 默认工作流：新建项目时自动套用，保证看板一建好就能用。
 *
 * 用户 2026-10-02 定的六态流程（**取代原来"待处理 / 进行中 / 已完成"三态 + 进度条**）：
 *   待完成 → 正在修改 → 待审查 → 审查中 → 回退修改 → 已完成
 *
 * 三条口径：
 * 1. **分类仍是三档**（todo / doing / done）。六态是"名字与颜色的细分"，
 *    而"算不算做完"必须只有一个判断依据 —— 只有 `已完成` 是 done。
 *    这样"今日待办排除已完成""工作日志统计完成数"这些逻辑一条都不用改。
 * 2. `回退修改` 归 doing：审查没过要回去改，它仍然是"没做完"。
 * 3. 顺序即看板列顺序（`sortOrder` 按数组顺序生成），颜色按"越靠后越接近完成"递进。
 */
export const DEFAULT_WORKFLOW_TEMPLATE: ReadonlyArray<{
  name: string;
  color: string;
  category: StatusCategory;
}> = [
  { name: '待完成', color: '#8a8a8a', category: 'todo' },
  { name: '正在修改', color: '#2080f0', category: 'doing' },
  { name: '待审查', color: '#f0a020', category: 'doing' },
  { name: '审查中', color: '#7b61ff', category: 'doing' },
  { name: '回退修改', color: '#d03050', category: 'doing' },
  { name: '已完成', color: '#18a058', category: 'done' },
];

/**
 * 「提交审核」目标状态的名称。
 *
 * 单独导出而不是在界面里写字符串：它是**流程约定**（按钮点了要落到哪个状态），
 * 一旦改名必须只有一处要改；服务端据此在项目的工作流里查状态。
 */
export const REVIEW_STATUS_NAME = '待审查';

/** 「已完成」状态的名称（同理：判定"做完"时用的显示名，与分类 done 一致） */
export const DONE_STATUS_NAME = '已完成';

/** 排序间隔：新增取 MAX+1000，便于在任意两条之间插入而不必重排 */
export const SORT_GAP = 1000;

export function isPriority(value: unknown): value is Priority {
  return typeof value === 'string' && (PRIORITIES as readonly string[]).includes(value);
}

export function isStatusCategory(value: unknown): value is StatusCategory {
  return typeof value === 'string' && (STATUS_CATEGORIES as readonly string[]).includes(value);
}
