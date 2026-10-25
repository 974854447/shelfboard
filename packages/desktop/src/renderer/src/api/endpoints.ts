/**
 * 类型化的接口层。
 *
 * 视图**只通过这里**访问后端，不自己拼 URL。好处有两点：
 * 1. DTO 类型来自 `@pm-studio/server` 的 `import type`，**接口形状改了前端立刻编译报错**，
 *    而不是等到运行时报 undefined。
 * 2. 查询参数的拼装、路径转义集中在一处，不会出现某个页面忘了编码 id 这种问题。
 */

import type {
  AppLogEntry,
  ClientLogInput,
  CreateMilestoneInput,
  CreateProjectInput,
  CreateTaskInput,
  CreateTagInput,
  CreateWorkflowStatusInput,
  MoveTaskInput,
  Priority,
  UpdateMilestoneInput,
  UpdateProjectInput,
  UpdateTaskInput,
  UpdateWorkflowStatusInput,
} from '@pm-studio/shared';
import type {
  BoardResult,
  DependencyDto,
  ListTasksResult,
  MilestoneDto,
  ProjectRelationDto,
  TagDto,
  TaskDetail,
  TaskDto,
  TaskTreeNode,
  TodayBoard,
  TodayGroup,
  TodayTask,
  TodayWorkTimeDto,
  WorkflowStatusDto,
  WorkLogData,
} from '@pm-studio/server';

import { getApiClient } from './bootstrap';

const API = '/api/v1';

/* ------------------------------------------------------------------ */
/* 项目                                                                */
/* ------------------------------------------------------------------ */

export interface ProjectDto {
  id: string;
  name: string;
  description: string | null;
  color: string;
  icon: string | null;
  /** 项目文件夹名（相对工作区根目录）；0.1.2 起一个项目 = 一个文件夹 */
  folder: string | null;
  /** 代码实际所在目录；为空表示代码就在项目文件夹里 */
  codePath: string | null;
  codeKind: string | null;
  status: string;
  sortOrder: number;
  createdAt: number;
  updatedAt: number;
  deletedAt: number | null;
}

export const projects = {
  list: (options: { includeArchived?: boolean; includeDeleted?: boolean } = {}) =>
    getApiClient().get<ProjectDto[]>(`${API}/projects`, options),

  create: (input: CreateProjectInput) => getApiClient().post<ProjectDto>(`${API}/projects`, input),

  get: (id: string) => getApiClient().get<ProjectDto>(`${API}/projects/${encodeURIComponent(id)}`),

  update: (id: string, patch: UpdateProjectInput) =>
    getApiClient().patch<ProjectDto>(`${API}/projects/${encodeURIComponent(id)}`, patch),

  /** 默认进回收站；hard=true 才是物理删除 */
  remove: (id: string, hard = false) =>
    getApiClient().del<{ deleted: boolean; hard: boolean }>(
      `${API}/projects/${encodeURIComponent(id)}`,
      { hard },
    ),

  restore: (id: string) =>
    getApiClient().post<ProjectDto>(`${API}/projects/${encodeURIComponent(id)}/restore`),

  /**
   * 清空回收站：把里面**所有**已删项目一次性彻底删除。
   *
   * 做成一个接口而不是在前端循环调 `remove(id, true)`：前端循环在半途失败会留下
   * "删了一半"的状态，而"清空"用户期待的是要么都清、要么都不清（服务端一个事务）。
   * 返回删掉的名字，界面要如实报出删了几个、都是谁。
   */
  purgeTrash: () =>
    getApiClient().post<{ deleted: number; names: string[] }>(`${API}/projects/trash/purge`),

  archive: (id: string) =>
    getApiClient().post<ProjectDto>(`${API}/projects/${encodeURIComponent(id)}/archive`),

  unarchive: (id: string) =>
    getApiClient().post<ProjectDto>(`${API}/projects/${encodeURIComponent(id)}/unarchive`),

  /**
   * 铺管理侧模板（工作流 / 任务清单 / 里程碑 / 文档模板）——「新建即非空」那一步。
   *
   * 四块要不要铺由调用方明确给出（服务端不给默认值）：漏传一块就是"不铺那一块"，
   * 不会变成"悄悄替他铺了一堆任务"。
   */
  /**
   * 项目间关系链（需求 §5.2.1）：**只标一条关系、只做展示**。
   *
   * 每个项目页都能查到"我指向谁"与"谁指向我"（服务端两个方向都返回）。
   */
  relations: (id: string) =>
    getApiClient().get<ProjectRelationDto[]>(`${API}/projects/${encodeURIComponent(id)}/relations`),

  createRelation: (
    id: string,
    input: { toProjectId: string; label: string; note?: string | null },
  ) =>
    getApiClient().post<ProjectRelationDto>(
      `${API}/projects/${encodeURIComponent(id)}/relations`,
      input,
    ),

  /** 每个项目有几条关系（项目卡片上那个小标记用；一次查完，不是按项目循环） */
  relationSummary: () =>
    getApiClient().get<Record<string, { count: number; labels: string[] }>>(
      `${API}/projects/relation-summary`,
    ),

  /**
   * 项目的启动 / 停止（开发服务器）。
   *
   * `runnable` 是服务端算的"这个项目能不能启动"（纯管理项目是 false）——
   * 界面据此决定要不要显示按钮，**不自己按 codeKind 猜**（猜的规则迟早跟服务端分叉）。
   */
  run: (id: string) =>
    getApiClient().get<{
      runnable: boolean;
      runningProjectIds: string[];
      targets: Array<{
        role: 'frontend' | 'backend';
        subdir: string;
        kind: string;
        kindLabel: string;
        /** 服务端探测出的模板 id（"装依赖"按它决定装什么、装到哪） */
        templateId: 'vue3' | 'react' | 'nestjs' | 'fastapi' | 'django';
        port: number;
        ready: boolean;
        problem?: string;
        state: {
          status: 'starting' | 'running' | 'stopped' | 'failed';
          pid: number | null;
          port: number;
          /** 真正能打开的地址（从进程输出里学到的）；没学到就是 null */
          url: string | null;
          /** 这个地址现在真的能连上吗（连不上不给"打开"入口） */
          reachable: boolean;
          command: string;
          startedAt: number | null;
          endedAt: number | null;
          error: string | null;
          exitCode: number | null;
          log: Array<{ ts: number; stream: 'stdout' | 'stderr' | 'system'; text: string }>;
        } | null;
      }>;
      problems: string[];
    }>(`${API}/projects/${encodeURIComponent(id)}/run`),

  startRun: (id: string, input: { role?: 'frontend' | 'backend'; port?: number } = {}) =>
    getApiClient().post<{ states: unknown[] }>(
      `${API}/projects/${encodeURIComponent(id)}/run/start`,
      input,
    ),

  stopRun: (id: string, input: { role?: 'frontend' | 'backend' } = {}) =>
    getApiClient().post<{ states: unknown[] }>(
      `${API}/projects/${encodeURIComponent(id)}/run/stop`,
      input,
    ),

  applyTemplate: (
    id: string,
    input: {
      kind?: 'managed' | 'frontend' | 'backend' | 'fullstack';
      tasks?: boolean;
      milestones?: boolean;
      docs?: boolean;
    },
  ) =>
    getApiClient().post<{
      kind: string;
      summary: string;
      /** 服务端算好的一句话小结（界面与日志共用同一套措辞） */
      description: string;
      created: { tasks: string[]; milestones: string[]; docs: string[] };
      skipped: { tasks: string[]; milestones: string[]; docs: string[] };
    }>(`${API}/projects/${encodeURIComponent(id)}/apply-template`, input),
};

/* ------------------------------------------------------------------ */
/* 工作流状态                                                          */
/* ------------------------------------------------------------------ */

export interface WorkflowStatusCount {
  statusId: string;
  taskCount: number;
}

export const workflow = {
  list: (projectId: string) =>
    getApiClient().get<{ items: WorkflowStatusDto[]; counts: WorkflowStatusCount[] }>(
      `${API}/projects/${encodeURIComponent(projectId)}/workflow-statuses`,
    ),

  create: (projectId: string, input: CreateWorkflowStatusInput) =>
    getApiClient().post<WorkflowStatusDto>(
      `${API}/projects/${encodeURIComponent(projectId)}/workflow-statuses`,
      input,
    ),

  update: (id: string, patch: UpdateWorkflowStatusInput) =>
    getApiClient().patch<WorkflowStatusDto>(
      `${API}/workflow-statuses/${encodeURIComponent(id)}`,
      patch,
    ),

  remove: (id: string, moveTasksTo?: string) =>
    getApiClient().del<{ movedTasks: number; movedTo: string }>(
      `${API}/workflow-statuses/${encodeURIComponent(id)}`,
      moveTasksTo ? { moveTasksTo } : {},
    ),

  reorder: (projectId: string, ids: string[]) =>
    getApiClient().post<WorkflowStatusDto[]>(
      `${API}/projects/${encodeURIComponent(projectId)}/workflow-statuses/reorder`,
      { ids },
    ),

  /**
   * 项目间关系链（需求 §5.2.1）：**只标一条关系、只做展示**。
   *
   * 每个项目页都能查到"我指向谁"与"谁指向我"（服务端两个方向都返回）。
   */
  relations: (id: string) =>
    getApiClient().get<ProjectRelationDto[]>(`${API}/projects/${encodeURIComponent(id)}/relations`),

  createRelation: (
    id: string,
    input: { toProjectId: string; label: string; note?: string | null },
  ) =>
    getApiClient().post<ProjectRelationDto>(
      `${API}/projects/${encodeURIComponent(id)}/relations`,
      input,
    ),

  /** 每个项目有几条关系（项目卡片上那个小标记用；一次查完，不是按项目循环） */
  relationSummary: () =>
    getApiClient().get<Record<string, { count: number; labels: string[] }>>(
      `${API}/projects/relation-summary`,
    ),

  /**
   * 项目的启动 / 停止（开发服务器）。
   *
   * `runnable` 是服务端算的"这个项目能不能启动"（纯管理项目是 false）——
   * 界面据此决定要不要显示按钮，**不自己按 codeKind 猜**（猜的规则迟早跟服务端分叉）。
   */
  run: (id: string) =>
    getApiClient().get<{
      runnable: boolean;
      runningProjectIds: string[];
      targets: Array<{
        role: 'frontend' | 'backend';
        subdir: string;
        kind: string;
        kindLabel: string;
        /** 服务端探测出的模板 id（"装依赖"按它决定装什么、装到哪） */
        templateId: 'vue3' | 'react' | 'nestjs' | 'fastapi' | 'django';
        port: number;
        ready: boolean;
        problem?: string;
        state: {
          status: 'starting' | 'running' | 'stopped' | 'failed';
          pid: number | null;
          port: number;
          /** 真正能打开的地址（从进程输出里学到的）；没学到就是 null */
          url: string | null;
          /** 这个地址现在真的能连上吗（连不上不给"打开"入口） */
          reachable: boolean;
          command: string;
          startedAt: number | null;
          endedAt: number | null;
          error: string | null;
          exitCode: number | null;
          log: Array<{ ts: number; stream: 'stdout' | 'stderr' | 'system'; text: string }>;
        } | null;
      }>;
      problems: string[];
    }>(`${API}/projects/${encodeURIComponent(id)}/run`),

  startRun: (id: string, input: { role?: 'frontend' | 'backend'; port?: number } = {}) =>
    getApiClient().post<{ states: unknown[] }>(
      `${API}/projects/${encodeURIComponent(id)}/run/start`,
      input,
    ),

  stopRun: (id: string, input: { role?: 'frontend' | 'backend' } = {}) =>
    getApiClient().post<{ states: unknown[] }>(
      `${API}/projects/${encodeURIComponent(id)}/run/stop`,
      input,
    ),

  applyTemplate: (projectId: string) =>
    getApiClient().post<WorkflowStatusDto[]>(
      `${API}/projects/${encodeURIComponent(projectId)}/workflow-statuses/apply-template`,
      {},
    ),
};

/* ------------------------------------------------------------------ */
/* 任务与看板                                                          */
/* ------------------------------------------------------------------ */

export interface TaskListQueryParams {
  statusId?: string;
  parentId?: string;
  priority?: Priority;
  q?: string;
  page?: number;
  pageSize?: number;
}

export const tasks = {
  /**
   * 跨项目查任务（M2：日历 / 我的待办）。
   *
   * 时间边界由**前端按本地时区**算好再传（`dueFrom` / `dueTo`），
   * 服务端不猜时区 —— 这样同一份数据在不同时区看到的"今天"各自正确。
   */
  acrossProjects: (params: CrossProjectTaskQuery = {}) =>
    getApiClient().get<CrossProjectTasksResult>(`${API}/tasks`, params),

  list: (projectId: string, query: TaskListQueryParams = {}) =>
    getApiClient().get<ListTasksResult>(
      `${API}/projects/${encodeURIComponent(projectId)}/tasks`,
      query,
    ),

  tree: (projectId: string, query: TaskListQueryParams = {}) =>
    getApiClient().get<TaskTreeNode[]>(
      `${API}/projects/${encodeURIComponent(projectId)}/tasks/tree`,
      query,
    ),

  board: (projectId: string) =>
    getApiClient().get<BoardResult>(`${API}/projects/${encodeURIComponent(projectId)}/board`),

  detail: (id: string) => getApiClient().get<TaskDetail>(`${API}/tasks/${encodeURIComponent(id)}`),

  create: (input: CreateTaskInput) => getApiClient().post<TaskDetail>(`${API}/tasks`, input),

  update: (id: string, patch: UpdateTaskInput) =>
    getApiClient().patch<TaskDetail>(`${API}/tasks/${encodeURIComponent(id)}`, patch),

  /** 看板拖拽的唯一入口：只描述"移到哪个状态、插到谁前面" */
  move: (id: string, input: MoveTaskInput) =>
    getApiClient().post<TaskDetail>(`${API}/tasks/${encodeURIComponent(id)}/move`, input),

  remove: (id: string, cascade = false) =>
    getApiClient().del<{ deleted: number; promoted: number }>(
      `${API}/tasks/${encodeURIComponent(id)}`,
      { cascade },
    ),

  restore: (id: string) =>
    getApiClient().post<TaskDetail>(`${API}/tasks/${encodeURIComponent(id)}/restore`),

  /**
   * 提交审核：把任务推进到项目的「待审查」状态。
   *
   * 落到哪个状态由**服务端**决定（流程约定），界面不传 statusId ——
   * 这样"审核状态叫什么名字"只有一处定义，改名之后按钮不会悄悄失效。
   */
  submitReview: (id: string) =>
    getApiClient().post<TaskDetail>(`${API}/tasks/${encodeURIComponent(id)}/submit-review`),

  addDependency: (successorId: string, predecessorId: string) =>
    getApiClient().post<DependencyDto>(`${API}/tasks/${encodeURIComponent(successorId)}/dependencies`, {
      predecessorId,
    }),

  dependencies: (taskId: string) =>
    getApiClient().get<{
      predecessors: DependencyDto[];
      successors: DependencyDto[];
    }>(`${API}/tasks/${encodeURIComponent(taskId)}/dependencies`),

  /**
   * 整个项目的依赖边（一次拿全）。
   *
   * 总览的关系数据图要给几百个任务画连线，逐个任务调 `dependencies(id)`
   * 就是 N+1 —— 首屏几百次往返。服务端本来就有这个批量接口，这里只是补上包装。
   */
  projectDependencies: (projectId: string) =>
    getApiClient().get<DependencyDto[]>(
      `${API}/projects/${encodeURIComponent(projectId)}/dependencies`,
    ),

  removeDependency: (taskId: string, depId: string) =>
    getApiClient().del<{ deleted: boolean }>(
      `${API}/tasks/${encodeURIComponent(taskId)}/dependencies/${encodeURIComponent(depId)}`,
    ),

  /** 批量操作：一次请求处理多个任务，避免 N 次往返 */
  batch: (input: {
    ids: string[];
    action: 'update' | 'delete' | 'restore' | 'addTags' | 'removeTags';
    patch?: UpdateTaskInput;
    tagIds?: string[];
  }) =>
    getApiClient().post<{
      affected: number;
      /** 被跳过的项（"有子任务所以不能删"）—— 界面必须如实转达，不能只报 affected */
      skipped: Array<{ id: string; title: string; reason: 'has_children'; childCount: number }>;
    }>(`${API}/tasks/batch`, input),
};

/* ------------------------------------------------------------------ */
/* 标签与里程碑                                                        */
/* ------------------------------------------------------------------ */

export const tags = {
  list: (projectId: string) =>
    getApiClient().get<TagDto[]>(`${API}/projects/${encodeURIComponent(projectId)}/tags`),

  create: (projectId: string, input: CreateTagInput) =>
    getApiClient().post<TagDto>(`${API}/projects/${encodeURIComponent(projectId)}/tags`, input),

  remove: (id: string) =>
    getApiClient().del<{ deleted: boolean }>(`${API}/tags/${encodeURIComponent(id)}`),
};

/** 关系链的改与删（挂在关系自己的 id 上，不挂在项目路径下） */
export const projectRelations = {
  update: (id: string, patch: { label?: string; note?: string | null }) =>
    getApiClient().patch<ProjectRelationDto>(
      `${API}/project-relations/${encodeURIComponent(id)}`,
      patch,
    ),

  remove: (id: string) =>
    getApiClient().del<{ deleted: boolean }>(`${API}/project-relations/${encodeURIComponent(id)}`),
};

export const milestones = {
  list: (projectId: string) =>
    getApiClient().get<MilestoneDto[]>(
      `${API}/projects/${encodeURIComponent(projectId)}/milestones`,
    ),

  create: (projectId: string, input: CreateMilestoneInput) =>
    getApiClient().post<MilestoneDto>(
      `${API}/projects/${encodeURIComponent(projectId)}/milestones`,
      input,
    ),

  update: (id: string, patch: UpdateMilestoneInput) =>
    getApiClient().patch<MilestoneDto>(`${API}/milestones/${encodeURIComponent(id)}`, patch),

  reach: (id: string, reachedAt: number | null = null) =>
    getApiClient().post<MilestoneDto>(`${API}/milestones/${encodeURIComponent(id)}/reach`, {
      reachedAt,
    }),

  remove: (id: string) =>
    getApiClient().del<{ deleted: boolean }>(`${API}/milestones/${encodeURIComponent(id)}`),
};

/* ------------------------------------------------------------------ */
/* 日志与诊断                                                          */
/* ------------------------------------------------------------------ */

/* ------------------------------------------------------------------ */
/* M2：跨项目查询与全局搜索                                             */
/* ------------------------------------------------------------------ */

/** 跨项目列表里的一条任务：比 TaskDto 多一个"属于哪个项目" */
export interface TaskWithProjectDto {
  id: string;
  projectId: string;
  projectName: string;
  parentId: string | null;
  title: string;
  statusId: string | null;
  statusCategory: string | null;
  /** 状态名与颜色跟行一起回来（跨项目时**不能**用当前项目的状态表去查） */
  statusName: string | null;
  statusColor: string | null;
  /** 已解析好的标签名 */
  tagNames: string[];
  priority: string;
  startDate: number | null;
  dueDate: number | null;
  childCount: number;
  doneChildCount: number;
  blockedByCount: number;
  updatedAt: number;
}

/** 跨项目列表附带的状态定义（每个项目一套） */
export interface ProjectStatusDto {
  id: string;
  projectId: string;
  name: string;
  color: string;
  category: 'todo' | 'doing' | 'done';
  sortOrder: number;
}

export interface CrossProjectTasksResult {
  items: TaskWithProjectDto[];
  total: number;
  statuses: ProjectStatusDto[];
}

export interface CrossProjectTaskQuery {
  dueFrom?: number;
  dueTo?: number;
  withoutDue?: boolean;
  onlyOpen?: boolean;
  projectIds?: string;
  limit?: number;
}

export interface SearchHitDto {
  type: 'task' | 'ticket';
  id: string;
  projectId: string;
  projectName: string;
  title: string;
  snippet: string | null;
  statusId: string | null;
  statusCategory: string | null;
  /** 状态名与颜色跟着结果一起回来（搜索结果同样跨项目，不能查"当前项目"的状态表） */
  statusName: string | null;
  statusColor: string | null;
  dueDate: number | null;
  updatedAt: number;
}

export interface SearchResultDto {
  items: SearchHitDto[];
  total: number;
  mode: 'fts' | 'like';
  statuses: ProjectStatusDto[];
}

export const search = {
  /**
   * 全局搜索。
   *
   * 响应里的 `mode` 说明实际走了哪条检索路径：`fts` = 全文索引（查询词 ≥ 3 字符），
   * `like` = 模糊匹配（少于 3 字符时回落，见 services/task-query.ts）。
   * **界面上要如实显示**，否则用户会以为"全文搜索时好时坏"。
   */
  query: (q: string, limit?: number) =>
    getApiClient().get<SearchResultDto>(`${API}/search`, {
      q,
      ...(limit !== undefined ? { limit } : {}),
    }),
};

/* ------------------------------------------------------------------ */
/* 日历标记（M2）                                                      */
/* ------------------------------------------------------------------ */

export interface CalendarMarkDto {
  id: string;
  /** 这一天**本地零点**的毫秒时间戳（由渲染层算好传上去，服务端不猜时区） */
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

export const marks = {
  /** 按日期区间取标记（传的是本地的日边界，见 utils/date.ts） */
  list: (params: { from?: number; to?: number } = {}) =>
    getApiClient().get<{ items: CalendarMarkDto[] }>(`${API}/calendar-marks`, params),

  create: (input: CreateCalendarMarkInput) =>
    getApiClient().post<CalendarMarkDto>(`${API}/calendar-marks`, input),

  update: (id: string, patch: Partial<CreateCalendarMarkInput>) =>
    getApiClient().patch<CalendarMarkDto>(`${API}/calendar-marks/${encodeURIComponent(id)}`, patch),

  remove: (id: string) =>
    getApiClient().del<{ deleted: boolean }>(`${API}/calendar-marks/${encodeURIComponent(id)}`),
};

/* ------------------------------------------------------------------ */
/* 作业中心（M4）                                                      */
/* ------------------------------------------------------------------ */

export type JobStatusDto =
  | 'queued'
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'canceled'
  | 'interrupted';

export interface JobDtoPayload {
  id: string;
  type: string;
  title: string;
  status: JobStatusDto;
  phase: string | null;
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

export interface JobLogDtoPayload {
  id: string;
  jobId: string;
  ts: number;
  level: 'info' | 'warn' | 'error';
  message: string;
}

export interface JobListResult {
  items: JobDtoPayload[];
  stats: { queued: number; running: number };
  /** 这一版能做哪些作业（界面据此决定显示哪些按钮） */
  handlerTypes: Array<{ type: string; concurrency: number; retryable: boolean }>;
  /** 生成代码骨架时可选的技术栈 */
  scaffoldTemplates: Array<{
    id: string;
    name: string;
    kind: string;
    source: string;
    /** 官方脚手架要联网（界面要如实标注"首次需要联网"） */
    needsNetwork: boolean;
    defaultPort: number;
    installKind: 'node' | 'python' | 'none';
    /** 语言标签（没有"语言"这个维度时静态显示：Python / TypeScript） */
    languageLabel: string;
    /**
     * 这个栈还能再分开选什么（语言 / 附加项）。
     *
     * 界面**照这份声明渲染**，不写死控件：某个栈不支持的东西就不会出现，
     * 于是不会出现"点了也没用"的开关。
     */
    dimensions: Array<{
      id: string;
      label: string;
      kind: 'choice' | 'multi';
      defaultValue: string | string[];
      choices: Array<{ id: string; label: string; hint?: string; args: string[] }>;
    }>;
  }>;
}

export const jobs = {
  list: (params: { status?: JobStatusDto; type?: string; limit?: number } = {}) =>
    getApiClient().get<JobListResult>(`${API}/jobs`, params),

  get: (id: string) => getApiClient().get<JobDtoPayload>(`${API}/jobs/${encodeURIComponent(id)}`),

  logs: (id: string, params: { afterTs?: number; limit?: number } = {}) =>
    getApiClient().get<{ items: JobLogDtoPayload[] }>(
      `${API}/jobs/${encodeURIComponent(id)}/logs`,
      params,
    ),

  /** 建一个作业（立刻返回，不等它跑完） */
  enqueue: (type: string, payload?: Record<string, unknown>) =>
    getApiClient().post<JobDtoPayload>(`${API}/jobs`, {
      type,
      ...(payload !== undefined ? { payload } : {}),
    }),

  cancel: (id: string) =>
    getApiClient().post<JobDtoPayload>(`${API}/jobs/${encodeURIComponent(id)}/cancel`, {}),

  /** 重试会**新建一条作业**（不覆盖历史，便于对照两次输出） */
  retry: (id: string) =>
    getApiClient().post<JobDtoPayload>(`${API}/jobs/${encodeURIComponent(id)}/retry`, {}),

  /** 单条作业的事件流（SSE）：先补拉 logs，再用它追新的 */
  stream: (id: string, signal: AbortSignal) =>
    getApiClient().stream(`${API}/jobs/${encodeURIComponent(id)}/stream`, undefined, signal),
};

export interface LogQueryParams {  level?: 'error' | 'warn' | 'info' | 'debug';
  minLevel?: 'error' | 'warn' | 'info' | 'debug';
  source?: 'main' | 'api' | 'job' | 'renderer';
  scope?: string;
  from?: number;
  to?: number;
  q?: string;
  traceId?: string;
  jobId?: string;
  page?: number;
  pageSize?: number;
}

export interface LogPage {
  items: AppLogEntry[];
  total: number;
  page: number;
  pageSize: number;
}

export const logs = {
  query: (params: LogQueryParams = {}) => getApiClient().get<LogPage>(`${API}/logs`, params),

  /**
   * 清空应用日志。
   *
   * 用途是"把历史错误清掉、从干净状态看"：修掉一个 bug 之后，旧的红字仍然躺在表里，
   * 每次打开日志页都像问题还在。清空之后服务端会补记一条"已清空应用日志"。
   */
  clear: () => getApiClient().del<{ removed: number }>(`${API}/logs`),

  /**
   * 上报渲染进程自身的异常。
   *
   * 未受信任输入：服务端会校验级别与长度，并在落库前走脱敏管道。
   * `accepted` 为 false 表示该级别被服务端的 minLevel 过滤掉了。
   */
  reportClientLog: (input: ClientLogInput) =>
    getApiClient().post<{ accepted: boolean }>(`${API}/logs/client`, input),

  /** 一键定位现场：某个 traceId 关联的全部日志，按时间正序 */
  context: (traceId: string) =>
    getApiClient().get<{
      traceId: string;
      total: number;
      jobIds: string[];
      items: AppLogEntry[];
    }>(`${API}/logs/context/${encodeURIComponent(traceId)}`),

  /** 建立 SSE 流（用 fetch 流式读取，令牌留在请求头里） */
  stream: (params: { level?: string; source?: string; replay?: number }, signal: AbortSignal) =>
    getApiClient().stream(`${API}/logs/stream`, params, signal),
};

/**
 * 当日工作时间（打卡）。
 *
 * 计时口径是"应用开着的时间"，会话由**主进程**开关（开软件、关软件），
 * 渲染层只读：`/today` 拿合计，`/day` 回看某一天。
 *
 * 「跟着时间跳动」不需要每秒问服务端：响应里带 `open.startedAt` 与 `generatedAt`，
 * 渲染层自己往前推秒数即可（见 TodayView 的计时器），只在跨零点/开关会话后重新取一次。
 */
export const workTime = {
  today: () => getApiClient().get<TodayWorkTimeDto>(`${API}/work-time/today`),

  day: (dateKey: string) =>
    getApiClient().get<TodayWorkTimeDto>(`${API}/work-time/day`, { date: dateKey }),

  /** 手动结束当前计时（正常退出由主进程负责，这是给"我今天就到这儿"用的） */
  stop: () =>
    getApiClient().post<{ stopped: boolean; session: TodayWorkTimeDto }>(`${API}/work-time/stop`, {}),
};

/**
 * 今日待办。
 *
 * `groups` 是**筛选**，不是分区：一条任务可以同时属于"今天到期"和"我标了今天做"，
 * 所以四条计数之和会大于列表长度 —— 这是对的。
 * 不传 `groups` 就是四组并集（默认视图）。
 *
 * `projectId` = 只看这个项目（用户 2026-09-30 定：「今日待办只展示当前项目的任务内容」）；
 * 不传才是跨项目 —— 那个口子留给了"以后可能要做的工作台聚合"，
 * 界面上不再有跨项目的今日待办。
 */
export const today = {
  board: (options: { groups?: TodayGroup[]; projectId?: string; at?: number } = {}) =>
    getApiClient().get<TodayBoard>(`${API}/today`, {
      ...(options.groups && options.groups.length > 0 ? { groups: options.groups.join(',') } : {}),
      ...(options.projectId ? { projectId: options.projectId } : {}),
      ...(options.at !== undefined ? { at: options.at } : {}),
    }),

  /** 标记 / 取消「今天做」（日期键由服务端按本地时区写，前端不自己造日期） */
  mark: (taskId: string, marked: boolean) =>
    getApiClient().post<{ todayMarkDate: string | null }>(
      `${API}/tasks/${encodeURIComponent(taskId)}/today-mark`,
      { marked },
    ),
};

/**
 * 工作日志（Word 文档）。
 *
 * `preview` 与 `generate` 走的是**同一套取数逻辑**（服务端 `collectWorkLogData`），
 * 所以"预览里看到的条数"与"文档里写进去的条数"必然一致 —— 预览不是另算一遍的估计值。
 */
export const workLog = {
  /** 生成前先看内容；也顺便告诉用户"今天一共干了些什么" */
  preview: (dateKey?: string) =>
    getApiClient().get<WorkLogData>(`${API}/work-log/preview`, dateKey ? { date: dateKey } : {}),

  /** 真正生成并写盘；返回**真实路径**（界面上要显示出来） */
  generate: (options: { date?: string; dir?: string; fileName?: string } = {}) =>
    getApiClient().post<{
      path: string;
      dir: string;
      bytes: number;
      overwritten: boolean;
      dateKey: string;
    }>(`${API}/work-log/generate`, options),

  /** 当前生效的默认保存目录（设置页显示用） */
  config: () => getApiClient().get<{ defaultDir: string | null; today: string }>(`${API}/work-log/config`),
};

/** 供 UI 复用的任务类型别名，避免各视图重复 import */
export type {
  TaskDto,
  TaskTreeNode,
  TaskDetail,
  WorkflowStatusDto,
  TagDto,
  MilestoneDto,
  TodayBoard as TodayBoardDto,
  TodayGroup as TodayGroupDto,
  TodayTask as TodayTaskDto,
  TodayWorkTimeDto,
  WorkLogData as WorkLogDataDto,
};
