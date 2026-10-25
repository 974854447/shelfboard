/**
 * 日志与诊断接口。
 *
 * 核心是 `/context/:traceId` —— 前端所有错误提示都带 traceId，点「查看日志」
 * 就请求这个接口。没有它，"查看日志"只是把文件搬到界面上（见 technical-design §5.10）。
 *
 * SSE 流的三个实现要点：
 * 1. 按订阅者的筛选条件过滤，而不是把全量日志推给每个连接。
 * 2. 支持 `Last-Event-ID` 续传：断线重连后从断点接着推，而不是从头刷一遍。
 * 3. 定期发心跳注释行，避免中间层把空闲连接掐掉。
 */

import { AppError, LOG_LEVELS, LOG_SOURCES, clientLogInputSchema, ok, type AppLogEntry, type LogQuery } from '@pm-studio/shared';
import type { LogLevel, LogSource } from '@pm-studio/shared';
import type { FastifyReply } from 'fastify';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';

import type { Logger } from '../logging/logger.js';
import type { LogBroadcaster } from '../logging/sse';
import type { LogStore } from '../logging/store';
import type { ServiceContext } from '../services/context.js';
import { exportDiagnostics, DEFAULT_MAX_LOGS } from '../services/diagnostics.js';

const logLevelSchema = z.enum([...LOG_LEVELS] as [LogLevel, ...LogLevel[]]);
const logSourceSchema = z.enum([...LOG_SOURCES] as [LogSource, ...LogSource[]]);

const querySchema = z.object({
  level: logLevelSchema.optional(),
  minLevel: logLevelSchema.optional(),
  source: logSourceSchema.optional(),
  scope: z.string().min(1).max(200).optional(),
  from: z.coerce.number().int().nonnegative().optional(),
  to: z.coerce.number().int().nonnegative().optional(),
  q: z.string().max(500).optional(),
  traceId: z.string().max(64).optional(),
  jobId: z.string().max(64).optional(),
  page: z.coerce.number().int().positive().optional(),
  pageSize: z.coerce.number().int().positive().max(1000).optional(),
});

const streamQuerySchema = z.object({
  level: logLevelSchema.optional(),
  minLevel: logLevelSchema.optional(),
  source: logSourceSchema.optional(),
  scope: z.string().min(1).max(200).optional(),
  /** 连接时先回放最近多少条，默认 20，最大 200；传 0 表示不回放 */
  replay: z.coerce.number().int().min(0).max(200).optional(),
});

const traceIdParamSchema = z.object({ traceId: z.string().min(1).max(64) });
const idParamSchema = z.object({ id: z.string().min(1).max(64) });

const exportDiagnosticsInputSchema = z.object({
  /** 导出目录：必须是绝对路径，服务端会校验它存在且是目录 */
  targetDir: z.string().min(1).max(1000),
  maxLogs: z.coerce.number().int().positive().max(20_000).optional(),
});

const HEARTBEAT_MS = 15_000;

/**
 * 导出诊断包时"取多少条日志"的口径，必须与 `diagnostics.ts` 内部一致。
 *
 * 两处不一致会表现成"导出的包里日志比日志页少"，很容易被当成服务端在丢日志 ——
 * 排查方向完全跑偏。所以把这个换算收在一个函数里。
 */
function maxLogsFor(requested: number | undefined): number {
  return Math.min(Math.max(requested ?? DEFAULT_MAX_LOGS, 1), 20_000);
}
const DEFAULT_REPLAY = 20;

export interface LogRoutesDeps {
  store: LogStore;
  broadcaster?: LogBroadcaster;
  /** 用于写入渲染进程上报的日志（会覆盖 source 为 renderer） */
  logger: Logger;
  /**
   * 诊断包导出所需的上下文。
   *
   * 不提供时该接口会返回明确错误，而不是静默失败 ——
   * "导出按钮点了没反应"是最难排查的一类问题。
   */
  diagnostics?: {
    services: ServiceContext;
    workspaceRoot: string;
    appVersion: string;
    /** 本地 API 令牌：打包前会整体替换，绝不允许进包 */
    authToken: string;
  };
}

function toLogQuery(input: z.infer<typeof querySchema>): LogQuery {
  const query: LogQuery = {};
  if (input.level) query.level = input.level;
  if (input.minLevel) query.minLevel = input.minLevel;
  if (input.source) query.source = input.source;
  if (input.scope) query.scope = input.scope;
  if (input.from !== undefined) query.from = input.from;
  if (input.to !== undefined) query.to = input.to;
  if (input.q) query.q = input.q;
  if (input.traceId) query.traceId = input.traceId;
  if (input.jobId) query.jobId = input.jobId;
  if (input.page !== undefined) query.page = input.page;
  if (input.pageSize !== undefined) query.pageSize = input.pageSize;
  return query;
}

/** 订阅者自己的筛选条件（在服务端过滤，避免把全量日志推给每个连接） */
function makeFilter(input: z.infer<typeof streamQuerySchema>): (entry: AppLogEntry) => boolean {
  const minRank = input.minLevel ? LOG_LEVELS.indexOf(input.minLevel) : undefined;
  return (entry) => {
    if (input.level && entry.level !== input.level) return false;
    if (minRank !== undefined && LOG_LEVELS.indexOf(entry.level) > minRank) return false;
    if (input.source && entry.source !== input.source) return false;
    if (input.scope && entry.scope !== input.scope) return false;
    return true;
  };
}

/** 每个事件：id 用于断线续传，data 是整条日志的 JSON（换行已被 JSON 转义） */
export function formatSseEvent(entry: AppLogEntry): string {
  return `id: ${entry.id}\nevent: log\ndata: ${JSON.stringify(entry)}\n\n`;
}

export function createLogRoutes(deps: LogRoutesDeps): FastifyPluginAsyncZod {
  return async (app) => {
    app.get('/', { schema: { querystring: querySchema } }, async (request) => {
      const query = toLogQuery(request.query);
      const result = deps.store.query(query);
      return ok({
        items: result.items,
        total: result.total,
        page: query.page ?? 1,
        pageSize: query.pageSize ?? 50,
      });
    });

    // 注意：必须能查到"这个 traceId 到底发生了什么"，所以顺带回传关联的 jobId，
    // 便于前端一键跳到作业日志。
    app.get(
      '/context/:traceId',
      { schema: { params: traceIdParamSchema } },
      async (request) => {
        const { traceId } = request.params;
        const result = deps.store.query({ traceId, pageSize: 500 });
        if (result.total === 0) {
          throw new AppError('NOT_FOUND', `没有找到 traceId 为 ${traceId} 的日志`, {
            details: { traceId },
          });
        }
        const jobIds = [
          ...new Set(result.items.map((e) => e.jobId).filter((v): v is string => Boolean(v))),
        ];
        return ok({
          traceId,
          total: result.total,
          jobIds,
          // 现场要按时间正序读，才符合"发生了什么"的叙事顺序
          items: [...result.items].sort((a, b) => a.ts - b.ts),
        });
      },
    );

    app.get('/stream', { schema: { querystring: streamQuerySchema } }, async (request, reply) => {
      const broadcaster = deps.broadcaster;
      if (!broadcaster) {
        throw new AppError('INTERNAL_ERROR', '日志实时流不可用（未启用广播器）');
      }

      const query = request.query;
      const filter = makeFilter(query);
      const replayCount = query.replay ?? DEFAULT_REPLAY;

      // 续传：客户端重连时会带上 Last-Event-ID，用它定位断点时间
      const lastEventId = request.headers['last-event-id'];
      const replayFromId = typeof lastEventId === 'string' ? lastEventId : undefined;

      reply.hijack();
      startSse(reply);

      if (replayCount > 0 || replayFromId) {
        const replay = collectReplay(deps.store, replayFromId, replayCount, filter);
        for (const entry of replay) reply.raw.write(formatSseEvent(entry));
        if (replay.length > 0) {
          // 回放结束打一个标记，前端可以据此区分"历史"与"实时"
          reply.raw.write('event: replay-end\ndata: {}\n\n');
        }
      }

      const unsubscribe = broadcaster.subscribe((batch) => {
        for (const entry of batch) {
          if (filter(entry)) reply.raw.write(formatSseEvent(entry));
        }
      });

      const heartbeat = setInterval(() => {
        // 注释行：SSE 规范里客户端会忽略，但能让中间层看到连接还活着
        reply.raw.write(': keep-alive\n\n');
      }, HEARTBEAT_MS);
      heartbeat.unref?.();

      const cleanup = (): void => {
        clearInterval(heartbeat);
        unsubscribe();
      };
      request.raw.on('close', cleanup);
      request.raw.on('error', cleanup);
    });

    /**
     * 渲染进程日志上报。
     *
     * 前端既不能写文件也不能写数据库，只能经 API 转交。这里**把 source 覆盖为
     * `renderer`** —— 否则前端异常会被记成后端错误（处理这个请求的 logger 的
     * source 是 `api`），按来源分区查看日志时就会找错地方。
     *
     * 落库前的脱敏仍由日志管道完成，前端不需要（也不应该）自己处理敏感信息。
     */
    app.post('/client', { schema: { body: clientLogInputSchema } }, async (request) => {
      const body = request.body;
      const entry = deps.logger.log(body.level, body.message, body.detail ?? undefined, {
        source: 'renderer',
        scope: body.scope ?? 'renderer',
        ...(body.traceId ? { traceId: body.traceId } : {}),
      });

      // entry 为 undefined 说明该级别被 minLevel 过滤掉了 —— 如实告知前端，
      // 免得它以为"上报成功"而实际上什么都没留下
      return ok({ accepted: entry !== undefined });
    });

    /**
     * 清空应用日志。
     *
     * 给用户一个"把历史错误清掉、从干净状态看"的手段：升级修掉 bug 之后，
     * 旧的红字仍留在表里，每次打开日志页都像问题还在。
     *
     * 清空之后会**补记一条**"已清空应用日志" —— 这个动作本身也该留痕，
     * 否则"日志怎么突然空了"会变成新的谜团。
     */
    app.delete('/', async () => {
      const removed = deps.store.clear();
      deps.logger.info('已清空应用日志', { removed });
      return ok({ removed });
    });

    /**
     * 导出诊断包。
     *
     * 同步执行（M1 尚无作业执行器，导出会走作业系统是 M4 的事）。
     * 包内只含日志、版本与环境摘要，**不含任何项目正文**。
     */
    app.post('/export', { schema: { body: exportDiagnosticsInputSchema } }, async (request) => {
      const diag = deps.diagnostics;
      if (!diag) {
        throw new AppError('INTERNAL_ERROR', '诊断包导出不可用：服务未提供工作区信息');
      }

      const result = await exportDiagnostics(diag.services, {
        targetDir: request.body.targetDir,
        workspaceRoot: diag.workspaceRoot,
        appVersion: diag.appVersion,
        // 本地 API 令牌必须在打包前整体替换，绝不允许进包
        knownSecrets: [diag.authToken],
        // 应用日志从日志库取（工作区库里已经没有这张表了）。
        // 取数与 maxLogs 用同一口径，否则"包里只有 200 条"会被误当成"服务端日志很少"。
        appLogs: deps.store.query({ pageSize: maxLogsFor(request.body.maxLogs), page: 1 }).items,
        ...(request.body.maxLogs !== undefined ? { maxLogs: request.body.maxLogs } : {}),
      });

      return ok(result);
    });

    app.get('/:id', { schema: { params: idParamSchema } }, async (request) => {
      const found = deps.store.getById(request.params.id);
      if (!found) {
        throw new AppError('NOT_FOUND', '日志不存在', { details: { id: request.params.id } });
      }
      return ok(found);
    });
  };
}

function startSse(reply: FastifyReply): void {
  reply.raw.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
    // 关闭 nginx 之类中间层的缓冲，否则"实时流"会变成"批量延迟流"
    'x-accel-buffering': 'no',
  });
  // 告诉客户端断线后 3 秒重连
  reply.raw.write('retry: 3000\n\n');
}

/**
 * 收集需要回放的历史日志。
 *
 * 有 Last-Event-ID 时以它为断点（取该条的时间戳，回放其后的记录）；
 * 否则回放最近 N 条。始终按时间正序输出。
 */
function collectReplay(
  store: LogStore,
  lastEventId: string | undefined,
  count: number,
  filter: (entry: AppLogEntry) => boolean,
): AppLogEntry[] {
  const limit = Math.max(count, 1);

  if (lastEventId) {
    const found = store.getById(lastEventId);
    if (found) {
      const after = store.query({ from: found.ts + 1, pageSize: 200, page: 1 });
      return after.items.filter(filter).sort((a, b) => a.ts - b.ts);
    }
    // 找不到断点（日志已轮转清理）→ 退化为回放最近 N 条
  }

  const recent = store.query({ pageSize: limit, page: 1 });
  return recent.items.filter(filter).sort((a, b) => a.ts - b.ts);
}
