/**
 * 标签路由。
 *
 * 标签**一律挂在项目下**（0.2.0 起移除"全局标签"，见迁移 0006 与需求 §13.2），
 * 所以这里只有一个入口：`/projects/:projectId/tags`。
 * 按 id 的改/删仍然放在 `/tags/:id`（id 是全局唯一的，没必要再套一层项目路径）。
 *
 * 曾经存在过的 `/tags`（全局标签的列表与创建）已经删掉 ——
 * 它从来没有界面调用过，留着只会给人"标签可以不属于项目"的错觉。
 */

import {
  createTagInputSchema,
  idSchema,
  ok,
  updateTagInputSchema,
} from '@pm-studio/shared';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';

import type { ServiceContext } from '../services/context.js';
import * as projectService from '../services/projects.js';
import * as tagService from '../services/tags.js';

const projectParamSchema = z.object({ projectId: idSchema });
const tagParamSchema = z.object({ id: idSchema });

export function createTagRoutes(ctx: ServiceContext): FastifyPluginAsyncZod {
  return async (app) => {
    app.get(
      '/projects/:projectId/tags',
      { schema: { params: projectParamSchema } },
      async (request) => {
        projectService.getProjectOrThrow(ctx, request.params.projectId);
        return ok(tagService.listTags(ctx, { projectId: request.params.projectId }));
      },
    );

    app.post(
      '/projects/:projectId/tags',
      { schema: { params: projectParamSchema, body: createTagInputSchema } },
      async (request, reply) => {
        projectService.getProjectOrThrow(ctx, request.params.projectId);
        const tag = tagService.createTag(ctx, request.body, request.params.projectId);
        void reply.code(201);
        return ok(tag);
      },
    );

    app.get(
      '/tags/:id',
      { schema: { params: tagParamSchema } },
      async (request) => {
        const tag = tagService.getTagOrThrow(ctx, request.params.id);
        return ok({ ...tag, usageCount: tagService.countTagUsage(ctx, tag.id) });
      },
    );

    app.patch(
      '/tags/:id',
      { schema: { params: tagParamSchema, body: updateTagInputSchema } },
      async (request) => ok(tagService.updateTag(ctx, request.params.id, request.body)),
    );

    app.delete(
      '/tags/:id',
      { schema: { params: tagParamSchema } },
      async (request) => {
        tagService.deleteTag(ctx, request.params.id);
        return ok({ deleted: true });
      },
    );
  };
}
