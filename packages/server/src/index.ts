export { createApp, buildDegradedHtml, type AppDeps } from './app.js';
export {
  extractBearerToken,
  extractTokenFromUrl,
  requiresAuth,
  safeCompare,
} from './auth.js';
export {
  DEFAULT_API_PREFIX,
  defaultServerConfig,
  type ServerConfig,
  type ServerConfigInput,
} from './config.js';
export { asAppError, mapError, type ErrorLogLevel, type MappedError } from './errors.js';
export * from './db/index.js';
export * from './logging/index.js';
export { createHealthRoutes, type HealthDeps } from './routes/health.js';
export { createLogRoutes, formatSseEvent, type LogRoutesDeps } from './routes/logs.js';
export { createMilestoneRoutes } from './routes/milestones.js';
export { createProjectRoutes } from './routes/projects.js';
export { createTagRoutes } from './routes/tags.js';
export { createWorkflowRoutes } from './routes/workflow.js';
export {
  createServiceContext,
  inTransaction,
  type ServiceContext,
  type ServiceContextOptions,
} from './services/context.js';

/**
 * DTO 类型导出。
 *
 * 供**渲染进程用 `import type` 引用** —— 类型导入在编译期被完全擦除，
 * 因此前端既能复用同一份 DTO 定义（不会和接口脱节），
 * 又不会把服务端代码打进渲染产物。
 * 这里只导出类型，不导出任何值，避免误用。
 */
export type {
  BoardColumn,
  BoardResult,
  BatchResult,
  ListTasksResult,
  TaskDetail,
  TaskDto,
  TaskTreeNode,
} from './services/tasks.js';
export type { DependencyDto, TaskDependencyView } from './services/task-dependencies.js';
export type { MilestoneDto } from './services/milestones.js';
export type { TagDto } from './services/tags.js';
export type { WorkflowStatusDto } from './services/workflow-statuses.js';
export type { ListProjectsOptions } from './services/projects.js';
export {
  allocateFolderName,
  ensureProjectFolder,
  ensureProjectFolders,
  sanitizeFolderName,
  type BackfillResult,
  type ProjectFolderResult,
} from './services/project-folders.js';
export {
  buildDiagnosticsFiles,
  DIAGNOSTICS_FORMAT_VERSION,
  exportDiagnostics,
  type DiagnosticsBundle,
  type DiagnosticsOptions,
  type DiagnosticsResult,
} from './services/diagnostics.js';
export {
  isEntityId,
  newEntityId,
} from './util/id.js';
export {
  assertSafeBin,
  buildCommand,
  commandPreview,
  createExecFileRunner,
  DETECTABLE_TOOLS,
  getCommandSpec,
  listCommandSpecs,
  runCommand,
  SAFE_VALUE_PATTERN,
  validateSlotValue,
  type BuiltCommand,
  type CommandExec,
  type CommandRunResult,
  type CommandSlot,
  type CommandSpec,
  type DetectableTool,
  type RunCommandOptions,
} from './services/commands.js';
export { nextSortOrder, orderBetween, rebalancedOrders } from './util/sort.js';
export {
  createJobEventHub,
  createJobRunner,
  JobCanceledError,
  type JobContext,
  type JobEvent,
  type JobEventHub,
  type JobHandlerSpec,
  type JobProgress,
  type JobRunner,
  type JobRunnerOptions,
} from './services/job-runner.js';
export {
  appendJobLogs,
  countJobs,
  createJob,
  getJobOrThrow,
  isJobFinished,
  listJobLogs,
  listJobs,
  recoverInterruptedJobs,
  TERMINAL_JOB_STATUSES,
  updateJob,
  type CreateJobInput,
  type JobDto,
  type JobLogDto,
  type JobStatus,
  type ListJobsOptions,
  type UpdateJobPatch,
} from './services/jobs.js';
export { createJobRoutes, type JobRoutesDeps } from './routes/jobs.js';
export {
  createBuiltinJobHandlers,
  createInstallHandler,
  createScaffoldHandler,
} from './services/job-handlers.js';
export {
  installTitle,
  parseInstallPayload,
  pickPackageManager,
  planInstall,
  runInstallJob,
  venvPythonPath,
  type InstallPlan,
  type InstallRequest,
  type PackageManager,
} from './services/job-install.js';
export { resolveOnPath } from './services/which.js';
export {
  listScaffoldTemplates,
  looksScaffolded,
  parseScaffoldPayload,
  decideAfterOfficialFailure,
  planScaffold,
  runScaffoldJob,
  scaffoldTitle,
  toPackageName,
  validatePort,
  type ScaffoldPlan,
  type ScaffoldRequest,
} from './services/job-scaffold.js';
export {
  adoptStagedDirectory,
  parseHelpFlags,
  probeOfficialScaffold,
  removeStagingDirectory,
  runOfficialScaffold,
  SCAFFOLD_APP_NAME,
  STAGING_DIR_NAME,
  type OfficialRunOutcome,
  type ProbeResult,
} from './services/scaffold-official.js';
export {
  buildOfficialInvocation,
  defaultSelections,
  describeSelections,
  validateSelections,
  type OfficialInvocation,
  type Selections,
} from './services/scaffold-options.js';
export {
  assertSafeTemplatePath,
  findTemplate,
  renderTemplate,
  renderText,
  TEMPLATE_FILES,
  TEMPLATES,
  writeTemplateFiles,
  type DimensionChoice,
  type TemplateDescriptor,
  type TemplateDimension,
  type TemplateFile,
  type TemplateVars,
} from './services/scaffold-templates.js';
export {
  applyVersionPins,
  type ApplyVersionsOptions,
  type ApplyVersionsResult,
} from './services/scaffold-versions.js';
export {
  applyManagementTemplate,
  describeTemplateResult,
  findManagementTemplate,
  resolveProjectKind,
  type ApplyTemplateOptions,
  type ApplyTemplateResult,
  type ManagementTemplate,
  type ProjectKind,
} from './services/project-template.js';
export {
  applyWorkflowTemplate,
  type WorkflowStatusTemplateItem,
} from './services/workflow-statuses.js';
export {
  summarizeRelations,
  createRelation,
  deleteRelation,
  listRelationsForProject,
  updateRelation,
  RELATION_LABEL_MAX,
  RELATION_NOTE_MAX,
  type ProjectRelationDto,
  type ProjectRelationEndpoint,
} from './services/project-relations.js';
export {
  createDevServers,
  type DevServerLogLine,
  type DevServerState,
  type DevServerStatus,
  type DevServers,
  type RunOverview,
} from './services/dev-servers.js';
export { detectRunTargets, type DetectRunResult, type RunTarget } from './services/project-run.js';

/**
 * 当日工作时间（打卡）。
 *
 * 这四个函数是给**桌面端主进程**用的：计时口径是"应用开着的时间"，
 * 而"应用开着"只有主进程知道（渲染层刷新、切页、窗口隐藏都不代表应用关了）。
 * 导出时改了个明确一点的名字 —— `startSession` / `heartbeat` 这种名字
 * 放在包级导出里太容易和别的东西混淆。
 */
export {
  startSession as startWorkSession,
  heartbeat as touchWorkSession,
  endOpenSessions as endWorkSessions,
  recoverStaleSessions,
  getDaySummary as getWorkTimeDaySummary,
  localDateKey,
  localDayBounds,
  HEARTBEAT_INTERVAL_MS as WORK_SESSION_HEARTBEAT_MS,
  type RecoverResult as WorkSessionRecoverResult,
  type TodayWorkTimeDto,
  type WorkSessionCloseReason,
  type WorkSessionDto,
} from './services/work-time.js';

export {
  getTodayBoard,
  setTodayMark,
  classifyTask,
  GROUP_LABELS as TODAY_GROUP_LABELS,
  GROUP_REASONS as TODAY_GROUP_REASONS,
  TODAY_GROUPS,
  type TodayBoard,
  type TodayGroup,
  type TodayReason,
  type TodayTask,
} from './services/today.js';

export {
  collectWorkLogData,
  buildWorkLogDocument,
  saveWorkLog,
  formatDuration as formatWorkDuration,
  type WorkLogData,
  type WorkLogEntry,
  type WorkLogProjectGroup,
  type WorkLogSession,
  type SaveWorkLogResult,
} from './services/work-log.js';
