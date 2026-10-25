/**
 * 作业路由（M4）。
 *
 * 界面（作业中心）需要四件事：列表、单条详情、日志（先补拉再用 SSE 追）、取消/重试。
 * SSE 只推**一个作业**的事件 —— 作业中心里同时看两条作业的实时输出没有意义，
 * 而"一条长作业"恰恰是这里的主要场景（装依赖能跑几分钟）。
 *
 * 事件的形状与日志页保持一致（帧格式相同），前端两条流的处理代码可以一样。
 */

import { idSchema, ok } from '@pm-studio/shared';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';

import type { ServiceContext } from '../services/context.js';
import type { JobEvent, JobRunner } from '../services/job-runner.js';
import { isJobFinished, listJobLogs, listJobs, getJobOrThrow } from '../services/jobs.js';
import { listScaffoldTemplates } from '../services/job-scaffold.js';

/**
 * 作业事件的 SSE 帧。
 *
 * 与日志页的 `formatSseEvent` 分开写：那个是给 `AppLogEntry` 用的（固定 `event: log`），
 * 作业流里有两种事件（作业状态、日志批次），需要一个能带事件名的格式化函数。
 * 帧格式（`id` / `event` / `data` + 空行）与日志页保持一致，前端两条流的代码可以一样。
 */
function formatJobSseEvent(event: { kind: string; [key: string]: unknown }): string {
  return `event: ${event.kind}\ndata: ${JSON.stringify(event)}\n\n`;
}

const jobParamSchema = z.object({ id: idSchema });

const listQuerySchema = z.object({
  status: z
    .enum(['queued', 'running', 'succeeded', 'failed', 'canceled', 'interrupted'])
    .optional(),
  type: z.string().max(60).optional(),
  limit: z.coerce.number().int().positive().max(500).optional(),
});

const logsQuerySchema = z.object({
  afterTs: z.coerce.number().int().nonnegative().optional(),
  limit: z.coerce.number().int().positive().max(5000).optional(),
});

const enqueueBodySchema = z.object({
  type: z.string().min(1).max(60),
  payload: z.record(z.string(), z.unknown()).optional(),
});

export interface JobRoutesDeps {
  ctx: ServiceContext;
  runner: JobRunner;
  /** 订阅作业事件（SSE 用）。返回取消订阅函数 */
  subscribe?: (listener: (event: JobEvent) => void) => () => void;
  /** 单条流最多挂多久（毫秒），到点主动断开，避免长连接泄漏 */
  streamTimeoutMs?: number;
}

export function createJobRoutes(deps: JobRoutesDeps): FastifyPluginAsyncZod {
  const { ctx, runner } = deps;

  return async (app) => {
    app.get(
      '/jobs',
      { schema: { querystring: listQuerySchema } },
      async (request) =>
        ok({
          items: listJobs(ctx, {
            ...(request.query.status !== undefined ? { status: request.query.status } : {}),
            ...(request.query.type !== undefined ? { type: request.query.type } : {}),
            ...(request.query.limit !== undefined ? { limit: request.query.limit } : {}),
          }),
          stats: runner.stats(),
          /** 这一版能做哪些作业（界面据此决定显示哪些按钮） */
          handlerTypes: runner.handlerTypes(),
          /**
           * 可选的技术栈（作业中心要显示"生成哪个栈"的选项）。
           *
           * 放在这里而不是单独一个接口：它只有作业中心用，而作业中心每次都要拉这个列表，
           * 多一个请求换来的只是"分层更漂亮"。
           */
          scaffoldTemplates: listScaffoldTemplates(),
        }),
    );

    app.get('/jobs/:id', { schema: { params: jobParamSchema } }, async (request) =>
      ok(getJobOrThrow(ctx, request.params.id)),
    );

    app.get(
      '/jobs/:id/logs',
      { schema: { params: jobParamSchema, querystring: logsQuerySchema } },
      async (request) =>
        ok({
          items: listJobLogs(ctx, request.params.id, {
            ...(request.query.afterTs !== undefined ? { afterTs: request.query.afterTs } : {}),
            ...(request.query.limit !== undefined ? { limit: request.query.limit } : {}),
          }),
        }),
    );

    app.post(
      '/jobs',
      { schema: { body: enqueueBodySchema } },
      async (request, reply) => {
        const job = runner.enqueue({
          type: request.body.type,
          ...(request.body.payload !== undefined ? { payload: request.body.payload } : {}),
        });
        void reply.code(201);
        return ok(job);
      },
    );

    app.post('/jobs/:id/cancel', { schema: { params: jobParamSchema } }, async (request) =>
      ok(runner.cancel(request.params.id)),
    );

    app.post('/jobs/:id/retry', { schema: { params: jobParamSchema } }, async (request) => {
      const job = runner.retry(request.params.id);
      return ok(job);
    });

    /**
     * 单条作业的事件流。
     *
     * 先 `GET /jobs/:id/logs` 补历史，再用这条流追新的（前端用 `afterTs` 去重）。
     * 到时间或作业结束就主动收尾 —— 长连接挂在那里没人关，是这类接口最常见的泄漏。
     */
    app.get('/jobs/:id/stream', { schema: { params: jobParamSchema } }, async (request, reply) => {
      const jobId = request.params.id;
      getJobOrThrow(ctx, jobId);

      const timeoutMs = deps.streamTimeoutMs ?? 10 * 60 * 1000;

      reply.raw.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      });
      reply.raw.write(formatJobSseEvent({ kind: 'hello', jobId }));

      const unsubscribe =
        deps.subscribe?.((event) => {
          if (event.kind === 'logs') {
            if (event.jobId !== jobId) return;
            reply.raw.write(formatJobSseEvent({ kind: 'logs', entries: event.entries }));
            return;
          }
          if (event.job.id !== jobId) return;
          reply.raw.write(formatJobSseEvent({ kind: 'job', job: event.job }));
        }) ?? (() => {});

      let closed = false;
      const close = (): void => {
        if (closed) return;
        closed = true;
        unsubscribe();
        clearTimeout(timer);
        clearInterval(poll);
        try {
          reply.raw.end();
        } catch {
          // 客户端可能已经断开，收尾失败无须上报
        }
      };

      const timer = setTimeout(close, timeoutMs);
      timer.unref?.();

      // 作业结束时主动断开：界面不需要一直挂着一个永远不会有新事件的流
      const poll = setInterval(() => {
        try {
          if (isJobFinished(getJobOrThrow(ctx, jobId).status)) close();
        } catch {
          close();
        }
      }, 1000);
      poll.unref?.();

      request.raw.on('close', close);
      return reply;
    });
  };
}
