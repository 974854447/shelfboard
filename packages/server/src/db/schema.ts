/**
 * Drizzle 表定义。
 *
 * ## 职责划分（重要）
 *
 * - **本文件**：表名与列定义，供 Drizzle 做类型化查询与写入。
 * - **`migrations.ts`**：真正的 DDL —— 索引、外键、唯一约束都在那里。
 *
 * 为什么不把索引/外键也写在 Drizzle 里：那会让同一份约束存在两处定义，
 * 迟早出现"改了这边忘了那边"。而且本项目不使用 drizzle-kit 生成迁移
 * （它是 CLI 代码生成器，内部派生子进程，在受限环境下 spawn EPERM 不可用），
 * 所以 Drizzle 侧不需要维护完整的 DDL 元数据。
 *
 * 两份定义是否脱节，由 `tests/db.test.ts` 里的**漂移测试**兜底：
 * 它断言迁移建出的真实表结构覆盖 Drizzle 声明的每一张表与每一列。
 *
 * ## 时间约定
 *
 * 所有时间戳一律为 **Unix 毫秒整数**（不用 Drizzle 的 timestamp 模式），
 * 转成 ISO 字符串只在 API 边界做。这样库里存的就是接口里传的，
 * 少一层隐式转换就少一类时区 bug。
 */

import { index, integer, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';

/* ------------------------------------------------------------------ */
/* 项目与配置                                                          */
/* ------------------------------------------------------------------ */

export const projects = sqliteTable('projects', {
  id: text('id').primaryKey(),
  ownerId: text('owner_id').notNull().default('local-user'),
  name: text('name').notNull(),
  description: text('description'),
  color: text('color').notNull().default('#2080f0'),
  icon: text('icon'),
  /**
   * 项目文件夹名（相对工作区根目录，可为空）。
   *
   * 一个项目 = 工作区里的一个文件夹：代码、attachments/、logs/ 都在里面。
   * 与 `codePath` 的区别：`folder` 是"项目自己的地盘"（一定在工作区内），
   * `codePath` 是"代码实际在哪"（可以指到工作区之外）。
   */
  folder: text('folder'),
  /** 绑定的本地代码目录（绝对路径，可为空）。为空时视为代码就在项目文件夹里 */
  codePath: text('code_path'),
  /** frontend | backend | fullstack | null */
  codeKind: text('code_kind'),
  /** 生成时使用的技术栈与参数快照（JSON） */
  stackJson: text('stack_json'),
  /** active | archived */
  status: text('status').notNull().default('active'),
  sortOrder: integer('sort_order').notNull().default(0),
  createdAt: integer('created_at').notNull(),
  updatedAt: integer('updated_at').notNull(),
  deletedAt: integer('deleted_at'),
});

export const workflowStatuses = sqliteTable('workflow_statuses', {
  id: text('id').primaryKey(),
  projectId: text('project_id').notNull(),
  name: text('name').notNull(),
  color: text('color').notNull().default('#8a8a8a'),
  /** todo | doing | done —— 用于进度统计，与"状态名可自由改"解耦 */
  category: text('category').notNull().default('doing'),
  sortOrder: integer('sort_order').notNull().default(0),
  /** 新建任务的默认落点 */
  isDefault: integer('is_default').notNull().default(0),
  createdAt: integer('created_at').notNull(),
  updatedAt: integer('updated_at').notNull(),
});

export const tags = sqliteTable('tags', {
  id: text('id').primaryKey(),
  /** 标签一律属于某个项目（0.2.0 起移除"全局标签"，见迁移 0006 与需求 §13.2） */
  projectId: text('project_id').notNull(),
  name: text('name').notNull(),
  color: text('color').notNull().default('#8a8a8a'),
  createdAt: integer('created_at').notNull(),
  updatedAt: integer('updated_at').notNull(),
});

/* ------------------------------------------------------------------ */
/* 工单（表在 M1 就建好，功能在 M3 落地）                                */
/* ------------------------------------------------------------------ */

export const ticketTypes = sqliteTable('ticket_types', {
  id: text('id').primaryKey(),
  /** 工单类型同样一律属于某个项目（迁移 0006 把这一列改成 NOT NULL） */
  projectId: text('project_id').notNull(),
  name: text('name').notNull(),
  /** REQ / BUG */
  prefix: text('prefix').notNull(),
  icon: text('icon'),
  createdAt: integer('created_at').notNull(),
  updatedAt: integer('updated_at').notNull(),
});

export const tickets = sqliteTable('tickets', {
  id: text('id').primaryKey(),
  ownerId: text('owner_id').notNull().default('local-user'),
  projectId: text('project_id').notNull(),
  typeId: text('type_id'),
  /** 项目内自增序号 */
  seq: integer('seq').notNull(),
  /** 展示编号：REQ-12 */
  code: text('code').notNull(),
  title: text('title').notNull(),
  description: text('description'),
  statusId: text('status_id'),
  priority: text('priority').notNull().default('medium'),
  assigneeId: text('assignee_id'),
  reporterId: text('reporter_id'),
  dueDate: integer('due_date'),
  resolvedAt: integer('resolved_at'),
  sortOrder: integer('sort_order').notNull().default(0),
  createdAt: integer('created_at').notNull(),
  updatedAt: integer('updated_at').notNull(),
  deletedAt: integer('deleted_at'),
});

/* ------------------------------------------------------------------ */
/* 任务                                                                */
/* ------------------------------------------------------------------ */

export const tasks = sqliteTable('tasks', {
  id: text('id').primaryKey(),
  ownerId: text('owner_id').notNull().default('local-user'),
  projectId: text('project_id').notNull(),
  /** 多层子任务 */
  parentId: text('parent_id'),
  ticketId: text('ticket_id'),
  title: text('title').notNull(),
  /** Markdown */
  description: text('description'),
  statusId: text('status_id'),
  /** low | medium | high | urgent */
  priority: text('priority').notNull().default('medium'),
  assigneeId: text('assignee_id'),
  startDate: integer('start_date'),
  dueDate: integer('due_date'),
  completedAt: integer('completed_at'),
  /** 0-100 */
  progress: integer('progress').notNull().default(0),
  /** 同一状态列内的排序 */
  sortOrder: integer('sort_order').notNull().default(0),
  createdAt: integer('created_at').notNull(),
  updatedAt: integer('updated_at').notNull(),
  deletedAt: integer('deleted_at'),
  /**
   * 「今天做」的手动标记：存的是**日期键**（本地时区的 YYYY-MM-DD）。
   *
   * 为什么不存布尔值：那样第二天还得有人去清掉它。存日期键就自然过期 ——
   * 今天标记的只在今天算"今日待办"，明天打开它就是一条普通任务了（不需要定时任务去清）。
   */
  todayMarkDate: text('today_mark_date'),
});

export const taskDependencies = sqliteTable('task_dependencies', {
  id: text('id').primaryKey(),
  predecessorId: text('predecessor_id').notNull(),
  successorId: text('successor_id').notNull(),
  /** FS | SS | FF | SF */
  type: text('type').notNull().default('FS'),
  lagDays: integer('lag_days').notNull().default(0),
  createdAt: integer('created_at').notNull(),
});

export const taskTags = sqliteTable('task_tags', {
  taskId: text('task_id').notNull(),
  tagId: text('tag_id').notNull(),
});

/**
 * 打卡会话（当日工作时间）。
 *
 * 语义按用户的要求定：**每天第一次打开软件开始计时、最后一次关闭软件结束**，
 * 一天里多次开关就是多条会话，当日工时 = 这些会话的合计。
 *
 * 几个刻意的字段选择：
 * - `lastSeenAt`：心跳（每 30 秒一次）。应用被**强杀**（断电、任务管理器结束）时
 *   `endedAt` 永远是 null，下次启动靠这个字段把会话**收到最后一次心跳**为止 ——
 *   这样"没关干净"的那段时间不会被算成工时（宁可少算，不可多算）。
 * - `closeReason`：会话是怎么结束的（`app_quit` 正常退出 / `recovered` 启动时补收 /
 *   `manual` 用户在界面上手动结束）。**如实记下来**，日志里能看出数字是怎么来的。
 * - 跨午夜的会话**不拆行**：一条会话就是一条，按天统计时算它与当天的交叠部分
 *   （拆行会让"今天开了多久"变得难以追溯）。
 */
export const workSessions = sqliteTable(
  'work_sessions',
  {
    id: text('id').primaryKey(),
    /** 会话开始时间（Unix 毫秒） */
    startedAt: integer('started_at').notNull(),
    /** 最后一次心跳（用于强杀后把会话收到这里为止） */
    lastSeenAt: integer('last_seen_at').notNull(),
    /** 结束时间；null = 还在进行 */
    endedAt: integer('ended_at'),
    /** app_quit | recovered | manual */
    closeReason: text('close_reason'),
    createdAt: integer('created_at').notNull(),
  },
  (table) => ({
    startedIndex: index('idx_work_sessions_started').on(table.startedAt),
  }),
);

/**
 * 项目间关系链（需求 §5.2.1，**纯展示**）。
 *
 * 这是整个系统里**唯一跨项目**的东西：只标一条"谁和谁有什么关系"，
 * 不共享任务 / 标签 / 状态 / 文档，也不做跨项目汇总 —— 所以这张表刻意只有
 * "两个端点 + 一句自由填的说明"，没有任何会被人误用成"联动规则"的字段
 * （没有 kind 枚举、没有权重、没有联动开关）。
 *
 * `label` 是**自由文本**（用户原话的例子是「调用」「同属一个系统」）：
 * 把它做成枚举会立刻不够用，而做成外键表则是把"展示用的一句话"当配置管，都不合适。
 *
 * 方向是**有向**的：需求里的例子就是「前端项目 → 调用 → 后端项目」。
 */
export const projectRelations = sqliteTable(
  'project_relations',
  {
    id: text('id').primaryKey(),
    /** 起点项目（"谁"） */
    fromProjectId: text('from_project_id').notNull(),
    /** 终点项目（"对谁"） */
    toProjectId: text('to_project_id').notNull(),
    /** 关系名称，自由填：调用 / 同属一个系统 / 替代 … */
    label: text('label').notNull(),
    note: text('note'),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
  },
  (table) => ({
    // 同一条关系不重复记（端点相同 + 名称相同就算重复）
    uniquePair: uniqueIndex('idx_project_relations_pair').on(
      table.fromProjectId,
      table.toProjectId,
      table.label,
    ),
  }),
);

export const milestones = sqliteTable('milestones', {
  id: text('id').primaryKey(),
  projectId: text('project_id').notNull(),
  name: text('name').notNull(),
  description: text('description'),
  dueDate: integer('due_date'),
  reachedAt: integer('reached_at'),
  sortOrder: integer('sort_order').notNull().default(0),
  createdAt: integer('created_at').notNull(),
  updatedAt: integer('updated_at').notNull(),
});

/* ------------------------------------------------------------------ */
/* 审计与作业                                                          */
/* ------------------------------------------------------------------ */

export const activityLogs = sqliteTable('activity_logs', {
  id: text('id').primaryKey(),
  entityType: text('entity_type').notNull(),
  entityId: text('entity_id').notNull(),
  projectId: text('project_id'),
  /** create | update | delete | restore | move */
  action: text('action').notNull(),
  /** { field: [old, new] } */
  changesJson: text('changes_json'),
  actorId: text('actor_id').notNull().default('local-user'),
  createdAt: integer('created_at').notNull(),
});

export const jobs = sqliteTable('jobs', {
  id: text('id').primaryKey(),
  /** scaffold | install | workspace-migrate | export | export-diagnostics | backup */
  type: text('type').notNull(),
  title: text('title').notNull(),
  /** queued | running | succeeded | failed | canceled | interrupted */
  status: text('status').notNull(),
  phase: text('phase'),
  percent: integer('percent').notNull().default(0),
  payloadJson: text('payload_json'),
  resultJson: text('result_json'),
  errorCode: text('error_code'),
  errorMessage: text('error_message'),
  logFile: text('log_file'),
  createdAt: integer('created_at').notNull(),
  startedAt: integer('started_at'),
  finishedAt: integer('finished_at'),
});

export const jobLogs = sqliteTable('job_logs', {
  id: text('id').primaryKey(),
  jobId: text('job_id').notNull(),
  ts: integer('ts').notNull(),
  level: text('level').notNull().default('info'),
  message: text('message').notNull(),
});

/**
 * 日历标记（M2）：某一天的自定义标记（休假、发版日、生日…）。
 *
 * `date` 是**某一天本地零点的毫秒时间戳**，由渲染层按本地时区算好传进来
 * （服务端不猜时区，见 services/task-query.ts）。没有 `project_id` 是刻意的，
 * 理由与取舍写在迁移 `0005_calendar_marks` 的注释与技术设计 §35 里。
 */
export const calendarMarks = sqliteTable('calendar_marks', {
  id: text('id').primaryKey(),
  date: integer('date').notNull(),
  title: text('title').notNull(),
  color: text('color').notNull().default('#3b82f6'),
  note: text('note'),
  createdAt: integer('created_at').notNull(),
  updatedAt: integer('updated_at').notNull(),
});

/**
 * 应用日志（`app_logs`）**不在这里**。
 *
 * 0.1.1 起它属于"应用自身的运行期数据"，写在 `<userData>/logs/app-logs.db`，
 * 不属于工作区。表结构由 `logging/store.ts` 自己的 `APP_LOGS_DDL` 拥有 ——
 * 这也是为什么它没有出现在本文件的 schema 映射里：
 * 这份 schema 描述的是**工作区库**，而工作区里不该有它。
 * （迁移 `0002_workspace_only_projects` 会把老工作区里的这张表删掉。）
 */

/* ------------------------------------------------------------------ */
/* 类型导出                                                            */
/* ------------------------------------------------------------------ */

export type Project = typeof projects.$inferSelect;
export type NewProject = typeof projects.$inferInsert;
export type WorkflowStatus = typeof workflowStatuses.$inferSelect;
export type NewWorkflowStatus = typeof workflowStatuses.$inferInsert;
export type Tag = typeof tags.$inferSelect;
export type NewTag = typeof tags.$inferInsert;
export type Ticket = typeof tickets.$inferSelect;
export type TicketType = typeof ticketTypes.$inferSelect;
export type Task = typeof tasks.$inferSelect;
export type NewTask = typeof tasks.$inferInsert;
export type TaskDependency = typeof taskDependencies.$inferSelect;
export type Milestone = typeof milestones.$inferSelect;
export type NewMilestone = typeof milestones.$inferInsert;
export type ActivityLog = typeof activityLogs.$inferSelect;
export type NewActivityLog = typeof activityLogs.$inferInsert;
export type Job = typeof jobs.$inferSelect;
export type JobLog = typeof jobLogs.$inferSelect;
export type CalendarMark = typeof calendarMarks.$inferSelect;
export type NewCalendarMark = typeof calendarMarks.$inferInsert;

/** 供漂移测试使用：表名 → 表定义（只列**工作区库**里的表） */
export const SCHEMA_TABLES = {
  projects,
  workflow_statuses: workflowStatuses,
  tags,
  ticket_types: ticketTypes,
  tickets,
  tasks,
  task_dependencies: taskDependencies,
  task_tags: taskTags,
  project_relations: projectRelations,
  work_sessions: workSessions,
  milestones,
  activity_logs: activityLogs,
  jobs,
  job_logs: jobLogs,
  calendar_marks: calendarMarks,
} as const;
