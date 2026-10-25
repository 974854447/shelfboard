/**
 * 请求 / 响应 Schema。
 *
 * 放在 shared 里是刻意的：前端用同一份 Schema 做表单校验与类型推导，
 * 不会出现"后端加了必填字段、前端还在按旧规则提交"这类错位。
 *
 * 命名约定：`xxxInputSchema` 用于写入，`xxxQuerySchema` 用于查询条件。
 */

import { z } from 'zod';

import {
  CODE_KINDS,
  DEPENDENCY_TYPES,
  LOG_LEVELS,
  PRIORITIES,
  PROJECT_STATUSES,
  STATUS_CATEGORIES,
} from './constants.js';

/* ------------------------------------------------------------------ *
 * 基础片段
 * ------------------------------------------------------------------ */

export const idSchema = z.string().min(1).max(64);

/** 十六进制颜色，前端取色器与后端校验共用 */
export const colorSchema = z
  .string()
  .regex(/^#[0-9a-fA-F]{6}$/, '颜色必须是 #RRGGBB 格式');

export const paginationSchema = {
  page: z.coerce.number().int().positive().optional(),
  pageSize: z.coerce.number().int().positive().max(1000).optional(),
};

/** Unix 毫秒时间戳 */
export const timestampSchema = z.number().int().nonnegative();

/** 允许显式传 null 来清空可选字段（例如清掉截止日） */
export const nullableTimestampSchema = timestampSchema.nullable();

/**
 * 查询串里的布尔值。
 *
 * **不要用 `z.coerce.boolean()`**：`Boolean('false')` 是 `true`，
 * 于是 `?includeArchived=false` 会变成"包含归档"——一个安静的反向 bug。
 * 这里只接受明确写出的几种写法。
 */
export const booleanQuerySchema = z.union([
  z.boolean(),
  z.enum(['true', 'false', '1', '0']).transform((v) => v === 'true' || v === '1'),
]);

const trimmedName = (max: number) => z.string().trim().min(1, '不能为空').max(max);

/* ------------------------------------------------------------------ *
 * 项目
 * ------------------------------------------------------------------ */

export const createProjectInputSchema = z.object({
  name: trimmedName(200),
  description: z.string().max(20_000).nullish(),
  color: colorSchema.optional(),
  icon: z.string().max(64).nullish(),
  codePath: z.string().max(1000).nullish(),
  codeKind: z.enum(CODE_KINDS).nullish(),
});

export const updateProjectInputSchema = z.object({
  name: trimmedName(200).optional(),
  description: z.string().max(20_000).nullish(),
  color: colorSchema.optional(),
  icon: z.string().max(64).nullish(),
  codePath: z.string().max(1000).nullish(),
  codeKind: z.enum(CODE_KINDS).nullish(),
  status: z.enum(PROJECT_STATUSES).optional(),
  sortOrder: z.number().int().optional(),
});

/**
 * 项目启动 / 停止（开发服务器）。
 *
 * `role` 可选：不传就是"这个项目的全部目标"（前后端项目会起两个进程）。
 * `port` 只影响**这一次启动**（探测到的端口是默认值，用户可以在启动前改）。
 */
export const runStartInputSchema = z.object({
  role: z.enum(['frontend', 'backend']).optional(),
  port: z.number().int().min(1).max(65535).optional(),
});

export const runStopInputSchema = z.object({
  role: z.enum(['frontend', 'backend']).optional(),
});

/**
 * 项目间关系链（需求 §5.2.1，**纯展示**）。
 *
 * 只有两个端点 + 一句自由填的名称：没有 kind 枚举（用户给的例子「调用」「同属一个系统」
 * 说明它说不完），也没有任何"联动"字段 —— 这个功能不做联动，字段上就不该留出暗示。
 */
export const createProjectRelationInputSchema = z.object({
  /** 终点项目（起点是路径里的那个项目） */
  toProjectId: idSchema,
  label: trimmedName(40),
  note: z.string().max(200).nullish(),
});

export const updateProjectRelationInputSchema = z.object({
  label: trimmedName(40).optional(),
  note: z.string().max(200).nullish(),
});

/**
 * 管理侧模板（技术设计 §46）：把一个项目"铺成非空"。
 *
 * 三块可以分别关掉（向导里对应勾选项）。**不给默认值**：不传就是"这一块不铺"，
 * 由调用方明确说要哪几块 —— 这样"忘了传"不会变成"悄悄替他铺了一堆任务"。
 *
 * 工作流**不在这里**：六个状态是建项目时就铺好的（四个栈共用一套），
 * 所以没有 `workflow` 开关 —— 留一个永远生效不了的开关键，比没有更糟。
 */
export const applyProjectTemplateInputSchema = z.object({
  kind: z.enum(['managed', ...CODE_KINDS]).optional(),
  tasks: z.boolean().optional(),
  milestones: z.boolean().optional(),
  docs: z.boolean().optional(),
});

export const projectListQuerySchema = z.object({
  includeArchived: booleanQuerySchema.optional(),
  includeDeleted: booleanQuerySchema.optional(),
  ...paginationSchema,
});

export const projectIdParamSchema = z.object({ id: idSchema });

/* ------------------------------------------------------------------ *
 * 工作流状态
 * ------------------------------------------------------------------ */

export const createWorkflowStatusInputSchema = z.object({
  name: trimmedName(100),
  color: colorSchema.optional(),
  category: z.enum(STATUS_CATEGORIES).optional(),
  isDefault: z.boolean().optional(),
});

export const updateWorkflowStatusInputSchema = z.object({
  name: trimmedName(100).optional(),
  color: colorSchema.optional(),
  category: z.enum(STATUS_CATEGORIES).optional(),
  isDefault: z.boolean().optional(),
});

export const reorderInputSchema = z.object({
  /** 完整的顺序列表；服务端据此重算 sort_order */
  ids: z.array(idSchema).min(1).max(500),
});

export const deleteWorkflowStatusQuerySchema = z.object({
  /** 删除前把该状态下的任务迁移到哪个状态；不传则迁到默认状态 */
  moveTasksTo: idSchema.optional(),
});

export const applyWorkflowTemplateInputSchema = z.object({
  template: z.enum(['default']).optional(),
});

/* ------------------------------------------------------------------ *
 * 标签
 * ------------------------------------------------------------------ */

export const createTagInputSchema = z.object({
  name: trimmedName(100),
  color: colorSchema.optional(),
});

export const updateTagInputSchema = z.object({
  name: trimmedName(100).optional(),
  color: colorSchema.optional(),
});

/* ------------------------------------------------------------------ *
 * 里程碑
 * ------------------------------------------------------------------ */

export const createMilestoneInputSchema = z.object({
  name: trimmedName(200),
  description: z.string().max(20_000).nullish(),
  dueDate: nullableTimestampSchema.optional(),
});

export const updateMilestoneInputSchema = z.object({
  name: trimmedName(200).optional(),
  description: z.string().max(20_000).nullish(),
  dueDate: nullableTimestampSchema.optional(),
  reachedAt: nullableTimestampSchema.optional(),
  sortOrder: z.number().int().optional(),
});

/* ------------------------------------------------------------------ *
 * 任务
 * ------------------------------------------------------------------ */

export const taskListQuerySchema = z.object({
  view: z.enum(['flat', 'tree']).optional(),
  statusId: idSchema.optional(),
  parentId: idSchema.optional(),
  priority: z.enum(PRIORITIES).optional(),
  /**
   * 既接受 `?tagIds=a,b` 也接受重复参数形式。
   *
   * 刻意**不在这里用 `.transform()`**：zod 的 ZodEffects 不会被识别为
   * optional，加 transform 会让该字段在推导类型里变成**必填**，
   * 于是所有调用点都得写 `tagIds: undefined`。归一化放到服务层做。
   */
  tagIds: z.union([z.string(), z.array(z.string())]).optional(),
  q: z.string().max(200).optional(),
  dueBefore: timestampSchema.optional(),
  includeDeleted: booleanQuerySchema.optional(),
  ...paginationSchema,
});

export const createTaskInputSchema = z.object({
  projectId: idSchema,
  parentId: idSchema.nullish(),
  ticketId: idSchema.nullish(),
  title: trimmedName(500),
  description: z.string().max(100_000).nullish(),
  statusId: idSchema.nullish(),
  priority: z.enum(PRIORITIES).optional(),
  assigneeId: idSchema.nullish(),
  startDate: nullableTimestampSchema.optional(),
  dueDate: nullableTimestampSchema.optional(),
  tagIds: z.array(idSchema).max(50).optional(),
});

export const updateTaskInputSchema = z.object({
  parentId: idSchema.nullish(),
  ticketId: idSchema.nullish(),
  title: trimmedName(500).optional(),
  description: z.string().max(100_000).nullish(),
  statusId: idSchema.nullish(),
  priority: z.enum(PRIORITIES).optional(),
  assigneeId: idSchema.nullish(),
  startDate: nullableTimestampSchema.optional(),
  dueDate: nullableTimestampSchema.optional(),
  tagIds: z.array(idSchema).max(50).optional(),
});

/**
 * 看板拖拽的唯一入口。
 *
 * 前端只描述"移到哪个状态、插到谁前面"，排序由服务端在**一个事务内**完成。
 * 让前端算 sort_order 必然出现顺序错乱（并发、重试、乐观更新回滚都会踩）。
 */
export const moveTaskInputSchema = z.object({
  statusId: idSchema,
  beforeTaskId: idSchema.nullish(),
  afterTaskId: idSchema.nullish(),
});

export const batchTaskInputSchema = z.object({
  ids: z.array(idSchema).min(1).max(500),
  action: z.enum(['update', 'delete', 'restore', 'addTags', 'removeTags']),
  patch: updateTaskInputSchema.optional(),
  tagIds: z.array(idSchema).max(50).optional(),
});

export const createDependencyInputSchema = z.object({
  predecessorId: idSchema,
  successorId: idSchema,
  type: z.enum(DEPENDENCY_TYPES).optional(),
  lagDays: z.number().int().min(-3650).max(3650).optional(),
});

export const taskIdParamSchema = z.object({ id: idSchema });
export const dependencyParamSchema = z.object({ id: idSchema, depId: idSchema });

/* ------------------------------------------------------------------ *
 * 客户端日志上报
 * ------------------------------------------------------------------ */

/**
 * 渲染进程上报的日志。
 *
 * 只允许有限的级别与长度：这是**未受信任的输入**（虽然来自我们自己的
 * 渲染进程，但它运行着可能出错的第三方代码）。脱敏仍由服务端日志管道负责，
 * 所以这里不需要（也不应该）让调用方自己处理敏感信息。
 */
export const clientLogInputSchema = z.object({
  level: z.enum([...LOG_LEVELS] as [(typeof LOG_LEVELS)[number], ...(typeof LOG_LEVELS)[number][]]),
  message: z.string().min(1).max(2000),
  detail: z.string().max(20_000).nullish(),
  scope: z.string().max(200).nullish(),
  traceId: z.string().max(64).nullish(),
});

export type ClientLogInput = z.infer<typeof clientLogInputSchema>;

/* ------------------------------------------------------------------ *
 * 推导类型
 * ------------------------------------------------------------------ */

export type CreateProjectInput = z.infer<typeof createProjectInputSchema>;
export type CreateProjectRelationInput = z.infer<typeof createProjectRelationInputSchema>;
export type UpdateProjectRelationInput = z.infer<typeof updateProjectRelationInputSchema>;
export type UpdateProjectInput = z.infer<typeof updateProjectInputSchema>;
export type CreateWorkflowStatusInput = z.infer<typeof createWorkflowStatusInputSchema>;
export type UpdateWorkflowStatusInput = z.infer<typeof updateWorkflowStatusInputSchema>;
export type CreateTagInput = z.infer<typeof createTagInputSchema>;
export type UpdateTagInput = z.infer<typeof updateTagInputSchema>;
export type CreateMilestoneInput = z.infer<typeof createMilestoneInputSchema>;
export type UpdateMilestoneInput = z.infer<typeof updateMilestoneInputSchema>;
export type CreateTaskInput = z.infer<typeof createTaskInputSchema>;
export type UpdateTaskInput = z.infer<typeof updateTaskInputSchema>;
export type MoveTaskInput = z.infer<typeof moveTaskInputSchema>;
export type BatchTaskInput = z.infer<typeof batchTaskInputSchema>;
export type CreateDependencyInput = z.infer<typeof createDependencyInputSchema>;
export type TaskListQuery = z.infer<typeof taskListQuerySchema>;
