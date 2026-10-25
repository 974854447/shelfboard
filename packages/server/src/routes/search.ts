/**
 * 全局搜索路由（M2）。
 *
 * 检索实现与中文分词的口径在 `services/task-query.ts`，这里只做参数校验与转发。
 * 响应里带上 `mode`（`fts` / `like`），**界面据此如实告诉用户走的是哪种检索** ——
 * 少于 3 个字符时用的是模糊匹配（trigram 索引有 3 字下限），
 * 不说明的话，用户会以为"全文搜索时好时坏"。
 */

import { ok } from '@pm-studio/shared';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';

import type { ServiceContext } from '../services/context.js';
import { searchAll } from '../services/task-query.js';

const searchQuerySchema = z.object({
  q: z.string().min(1).max(200),
  limit: z.coerce.number().int().positive().max(200).optional(),
});

export function createSearchRoutes(ctx: ServiceContext): FastifyPluginAsyncZod {
  return async (app) => {
    app.get('/search', { schema: { querystring: searchQuerySchema } }, async (request) =>
      ok(
        searchAll(ctx, {
          q: request.query.q,
          ...(request.query.limit !== undefined ? { limit: request.query.limit } : {}),
        }),
      ),
    );
  };
}
