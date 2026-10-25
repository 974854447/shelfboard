/**
 * 工作流状态路由。
 *
 * 注意路径顺序：`reorder` 与 `apply-template` 是静态段，
 * Fastify 的路由器（find-my-way）会优先匹配静态段，
 * 因此不会和将来的 `/workflow-statuses/:statusId` 冲突。
 */

import {
  applyWorkflowTemplateInputSchema,
  createWorkflowStatusInputSchema,
  deleteWorkflowStatusQuerySchema,
  idSchema,
  ok,
  reorderInputSchema,
  updateWorkflowStatusInputSchema,
} from '@pm-studio/shared';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';

import type { ServiceContext } from '../services/context.js';
import * as projectService from '../services/projects.js';
import * as workflow from '../services/workflow-statuses.js';

const projectParamSchema = z.object({ projectId: idSchema });
const statusParamSchema = z.object({ id: idSchema });

export function createWorkflowRoutes(ctx: ServiceContext): FastifyPluginAsyncZod {
  return async (app) => {
    app.get(
      '/projects/:projectId/workflow-statuses',
      { schema: { params: projectParamSchema } },
      async (request) => {
        projectService.getProjectOrThrow(ctx, request.params.projectId);
        const statuses = workflow.listStatuses(ctx, request.params.projectId);
        // 顺带回传"每个状态里有多少未删除任务"，看板列头直接用，
        // 省掉前端再为每列发一次请求
        const counts = statuses.map((s) => ({
          statusId: s.id,
          taskCount: workflow.countTasksInStatus(ctx, s.id),
        }));
        return ok({ items: statuses, counts });
      },
    );

    app.post(
      '/projects/:projectId/workflow-statuses',
      { schema: { params: projectParamSchema, body: createWorkflowStatusInputSchema } },
      async (request, reply) => {
        projectService.getProjectOrThrow(ctx, request.params.projectId);
        const status = workflow.createStatus(ctx, request.params.projectId, request.body);
        void reply.code(201);
        return ok(status);
      },
    );

    app.post(
      '/projects/:projectId/workflow-statuses/reorder',
      { schema: { params: projectParamSchema, body: reorderInputSchema } },
      async (request) => {
        projectService.getProjectOrThrow(ctx, request.params.projectId);
        return ok(workflow.reorderStatuses(ctx, request.params.projectId, request.body.ids));
      },
    );

    app.post(
      '/projects/:projectId/workflow-statuses/apply-template',
      { schema: { params: projectParamSchema, body: applyWorkflowTemplateInputSchema.optional() } },
      async (request) => {
        projectService.getProjectOrThrow(ctx, request.params.projectId);
        return ok(workflow.applyDefaultWorkflowTemplate(ctx, request.params.projectId));
      },
    );

    app.patch(
      '/workflow-statuses/:id',
      { schema: { params: statusParamSchema, body: updateWorkflowStatusInputSchema } },
      async (request) => ok(workflow.updateStatus(ctx, request.params.id, request.body)),
    );

    app.delete(
      '/workflow-statuses/:id',
      { schema: { params: statusParamSchema, querystring: deleteWorkflowStatusQuerySchema } },
      async (request) =>
        ok(workflow.deleteStatus(ctx, request.params.id, { moveTasksTo: request.query.moveTasksTo })),
    );
  };
}
