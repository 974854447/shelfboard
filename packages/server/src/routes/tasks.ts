/**
 * 任务路由。
 *
 * `POST /tasks/:id/move` 是看板拖拽的唯一入口。前端**不应该**直接 PATCH
 * `sortOrder` —— 让客户端算排序必然在并发、重试、乐观更新回滚时错乱。
 */

import {
  batchTaskInputSchema,
  booleanQuerySchema,
  createDependencyInputSchema,
  createTaskInputSchema,
  dependencyParamSchema,
  idSchema,
  moveTaskInputSchema,
  ok,
  taskIdParamSchema,
  taskListQuerySchema,
  timestampSchema,
  updateTaskInputSchema,
} from '@pm-studio/shared';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';

import type { ServiceContext } from '../services/context.js';
import * as projectService from '../services/projects.js';
import * as dependencyService from '../services/task-dependencies.js';
import { queryTasksAcrossProjects } from '../services/task-query.js';
import * as taskService from '../services/tasks.js';

const projectParamSchema = z.object({ projectId: idSchema });

/**
 * 跨项目查询的入参。
 *
 * `projectIds` 用逗号分隔的字符串而不是数组：查询串里的数组要写成 `a=1&a=2`，
 * 各客户端拼法不一致；逗号分隔最不容易出错。
 */
const crossProjectTaskQuerySchema = z.object({
  /*
   * 查询串里的时间戳必须用 `z.coerce.number()`：
   * URL 里的参数**永远是字符串**，而共享的 `timestampSchema` 是严格 number，
   * 直接用它会把每个请求都判成 400（实测踩到：日历页四个请求全 400，界面一片空）。
   */
  dueFrom: z.coerce.number().int().nonnegative().optional(),
  dueTo: z.coerce.number().int().nonnegative().optional(),
  withoutDue: booleanQuerySchema.optional(),
  onlyOpen: booleanQuerySchema.optional(),
  projectIds: z.string().max(2000).optional(),
  limit: z.coerce.number().int().positive().max(2000).optional(),
});

const deleteQuerySchema = z.object({
  /** true 表示连子任务一起删除；默认只删本任务，子任务上提一级 */
  cascade: booleanQuerySchema.optional(),
});

const upcomingQuerySchema = z.object({
  dueBefore: timestampSchema,
});

export function createTaskRoutes(ctx: ServiceContext): FastifyPluginAsyncZod {
  return async (app) => {
    /* ---------------- 跨项目（M2：日历 / 我的待办） ---------------- */

    /**
     * 跨项目查任务。
     *
     * 时间边界由前端按**本地时区**算好传进来（见 services/task-query.ts 的口径说明），
     * 服务端只做"落在区间里没有"的判断。
     */
    app.get(
      '/tasks',
      { schema: { querystring: crossProjectTaskQuerySchema } },
      async (request) => {
        const q = request.query;
        return ok(
          queryTasksAcrossProjects(ctx, {
            ...(q.dueFrom !== undefined ? { dueFrom: q.dueFrom } : {}),
            ...(q.dueTo !== undefined ? { dueTo: q.dueTo } : {}),
            ...(q.withoutDue !== undefined ? { withoutDue: q.withoutDue } : {}),
            ...(q.onlyOpen !== undefined ? { onlyOpen: q.onlyOpen } : {}),
            ...(q.projectIds ? { projectIds: q.projectIds.split(',').filter(Boolean) } : {}),
            ...(q.limit !== undefined ? { limit: q.limit } : {}),
          }),
        );
      },
    );

    /* ---------------- 项目维度 ---------------- */

    app.get(
      '/projects/:projectId/tasks',
      { schema: { params: projectParamSchema, querystring: taskListQuerySchema } },
      async (request) => {
        projectService.getProjectOrThrow(ctx, request.params.projectId);
        return ok(taskService.listTasks(ctx, request.params.projectId, request.query));
      },
    );

    app.get(
      '/projects/:projectId/tasks/tree',
      { schema: { params: projectParamSchema, querystring: taskListQuerySchema } },
      async (request) => {
        projectService.getProjectOrThrow(ctx, request.params.projectId);
        return ok(taskService.getTaskTree(ctx, request.params.projectId, request.query));
      },
    );

    app.get(
      '/projects/:projectId/tasks/deleted',
      { schema: { params: projectParamSchema } },
      async (request) => {
        projectService.getProjectOrThrow(ctx, request.params.projectId);
        return ok(taskService.listDeletedTasks(ctx, request.params.projectId));
      },
    );

    app.get(
      '/projects/:projectId/board',
      { schema: { params: projectParamSchema } },
      async (request) => {
        projectService.getProjectOrThrow(ctx, request.params.projectId);
        return ok(taskService.getBoard(ctx, request.params.projectId));
      },
    );

    app.get(
      '/projects/:projectId/dependencies',
      { schema: { params: projectParamSchema } },
      async (request) => {
        projectService.getProjectOrThrow(ctx, request.params.projectId);
        return ok(dependencyService.listProjectDependencies(ctx, request.params.projectId));
      },
    );

    /* ---------------- 任务本身 ---------------- */

    app.post('/tasks', { schema: { body: createTaskInputSchema } }, async (request, reply) => {
      const task = taskService.createTask(ctx, request.body);
      void reply.code(201);
      return ok(task);
    });

    app.get(
      '/tasks/:id',
      { schema: { params: taskIdParamSchema } },
      async (request) => ok(taskService.getTaskDetail(ctx, request.params.id)),
    );

    app.patch(
      '/tasks/:id',
      { schema: { params: taskIdParamSchema, body: updateTaskInputSchema } },
      async (request) => ok(taskService.updateTask(ctx, request.params.id, request.body)),
    );

    app.post(
      '/tasks/:id/move',
      { schema: { params: taskIdParamSchema, body: moveTaskInputSchema } },
      async (request) => ok(taskService.moveTask(ctx, request.params.id, request.body)),
    );

    /**
     * 提交审核：把任务推进到「待审查」。
     *
     * 单列一个接口而不是让界面查状态再 PATCH：落在哪个状态是流程约定（见服务层注释），
     * 界面不该知道"审核状态叫什么名字"。
     */
    app.post(
      '/tasks/:id/submit-review',
      { schema: { params: taskIdParamSchema } },
      async (request) => ok(taskService.submitForReview(ctx, request.params.id)),
    );

    app.delete(
      '/tasks/:id',
      { schema: { params: taskIdParamSchema, querystring: deleteQuerySchema } },
      async (request) =>
        ok(taskService.softDeleteTask(ctx, request.params.id, { cascade: request.query.cascade })),
    );

    app.post(
      '/tasks/:id/restore',
      { schema: { params: taskIdParamSchema } },
      async (request) => ok(taskService.restoreTask(ctx, request.params.id)),
    );

    app.post(
      '/tasks/batch',
      { schema: { body: batchTaskInputSchema } },
      async (request) => ok(taskService.batchTasks(ctx, request.body)),
    );

    /* ---------------- 依赖 ---------------- */

    app.post(
      '/tasks/:id/dependencies',
      {
        schema: {
          params: taskIdParamSchema,
          // 前置任务由请求体给出，`:id` 固定作为后继，避免出现"谁是前置"的歧义
          body: createDependencyInputSchema.omit({ successorId: true }),
        },
      },
      async (request, reply) => {
        const dependency = dependencyService.addDependency(ctx, {
          ...request.body,
          successorId: request.params.id,
        });
        void reply.code(201);
        return ok(dependency);
      },
    );

    app.get(
      '/tasks/:id/dependencies',
      { schema: { params: taskIdParamSchema } },
      async (request) =>
        ok(dependencyService.listDependenciesForTask(ctx, request.params.id)),
    );

    app.delete(
      '/tasks/:id/dependencies/:depId',
      { schema: { params: dependencyParamSchema } },
      async (request) => {
        dependencyService.removeDependency(ctx, request.params.depId);
        return ok({ deleted: true });
      },
    );

    /* ---------------- 工作台 ---------------- */

    app.get(
      '/tasks/upcoming',
      { schema: { querystring: upcomingQuerySchema } },
      async (request) =>
        ok(taskService.listUpcomingTasks(ctx, { dueBefore: request.query.dueBefore })),
    );
  };
}
