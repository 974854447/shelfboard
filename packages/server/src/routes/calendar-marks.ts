/**
 * 日历标记路由（M2）。
 *
 * 与任务无关：标记不是任务，没有状态/进度，也不参与统计，
 * 所以走自己的 `/calendar-marks`，而不是往 `/tasks` 上挂一个特殊类型。
 * 业务规则与校验在 `services/calendar-marks.ts`（含"为什么没有 project_id"的说明）。
 */

import { idSchema, ok } from '@pm-studio/shared';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';

import type { ServiceContext } from '../services/context.js';
import * as markService from '../services/calendar-marks.js';

const markParamSchema = z.object({ id: idSchema });

/** `date` 是本地零点的时间戳，由渲染层算好；这里只做范围与整数校验 */
const dateSchema = z.coerce.number().int().positive();

const listQuerySchema = z.object({
  from: dateSchema.optional(),
  to: dateSchema.optional(),
});

const createBodySchema = z.object({
  date: dateSchema,
  title: z.string().min(1).max(markService.MARK_TITLE_MAX),
  color: z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/)
    .optional(),
  note: z.string().max(markService.MARK_NOTE_MAX).nullish(),
});

const updateBodySchema = z.object({
  date: dateSchema.optional(),
  title: z.string().min(1).max(markService.MARK_TITLE_MAX).optional(),
  color: z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/)
    .optional(),
  note: z.string().max(markService.MARK_NOTE_MAX).nullish(),
});

export function createCalendarMarkRoutes(ctx: ServiceContext): FastifyPluginAsyncZod {
  return async (app) => {
    app.get(
      '/calendar-marks',
      { schema: { querystring: listQuerySchema } },
      async (request) =>
        ok({
          items: markService.listCalendarMarks(ctx, {
            ...(request.query.from !== undefined ? { from: request.query.from } : {}),
            ...(request.query.to !== undefined ? { to: request.query.to } : {}),
          }),
        }),
    );

    app.post(
      '/calendar-marks',
      { schema: { body: createBodySchema } },
      async (request, reply) => {
        const created = markService.createCalendarMark(ctx, request.body);
        void reply.code(201);
        return ok(created);
      },
    );

    app.patch(
      '/calendar-marks/:id',
      { schema: { params: markParamSchema, body: updateBodySchema } },
      async (request) => ok(markService.updateCalendarMark(ctx, request.params.id, request.body)),
    );

    app.delete(
      '/calendar-marks/:id',
      { schema: { params: markParamSchema } },
      async (request) => {
        markService.deleteCalendarMark(ctx, request.params.id);
        return ok({ deleted: true });
      },
    );
  };
}
