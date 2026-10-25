/**
 * 里程碑路由。
 */

import {
  booleanQuerySchema,
  createMilestoneInputSchema,
  idSchema,
  ok,
  timestampSchema,
  updateMilestoneInputSchema,
} from '@pm-studio/shared';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';

import type { ServiceContext } from '../services/context.js';
import * as milestoneService from '../services/milestones.js';
import * as projectService from '../services/projects.js';

const projectParamSchema = z.object({ projectId: idSchema });
const milestoneParamSchema = z.object({ id: idSchema });

const reachBodySchema = z.object({
  /** 不传则用当前时间；传 null 表示撤销达成 */
  reachedAt: timestampSchema.nullable().optional(),
  undoTokens: booleanQuerySchema.optional(),
});

export function createMilestoneRoutes(ctx: ServiceContext): FastifyPluginAsyncZod {
  return async (app) => {
    app.get(
      '/projects/:projectId/milestones',
      { schema: { params: projectParamSchema } },
      async (request) => {
        projectService.getProjectOrThrow(ctx, request.params.projectId);
        return ok(milestoneService.listMilestones(ctx, request.params.projectId));
      },
    );

    app.post(
      '/projects/:projectId/milestones',
      { schema: { params: projectParamSchema, body: createMilestoneInputSchema } },
      async (request, reply) => {
        projectService.getProjectOrThrow(ctx, request.params.projectId);
        const milestone = milestoneService.createMilestone(
          ctx,
          request.params.projectId,
          request.body,
        );
        void reply.code(201);
        return ok(milestone);
      },
    );

    app.patch(
      '/milestones/:id',
      { schema: { params: milestoneParamSchema, body: updateMilestoneInputSchema } },
      async (request) =>
        ok(milestoneService.updateMilestone(ctx, request.params.id, request.body)),
    );

    app.post(
      '/milestones/:id/reach',
      { schema: { params: milestoneParamSchema, body: reachBodySchema.optional() } },
      async (request) => {
        const body = request.body ?? {};
        // 三种语义：显式时间 / 现在 / 撤销（null）
        const reachedAt =
          body.reachedAt !== undefined
            ? body.reachedAt
            : body.undoTokens
              ? null
              : ctx.now();
        return ok(milestoneService.setMilestoneReached(ctx, request.params.id, reachedAt));
      },
    );

    app.delete(
      '/milestones/:id',
      { schema: { params: milestoneParamSchema } },
      async (request) => {
        milestoneService.deleteMilestone(ctx, request.params.id);
        return ok({ deleted: true });
      },
    );
  };
}
