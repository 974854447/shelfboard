/**
 * Fastify 实例组装。
 *
 * 这个文件是整个服务的安全边界所在，集中了四件事：
 *
 * 1. **鉴权**：API 前缀之下的一切请求都要求一次性 Bearer Token。
 * 2. **traceId 贯通**：每个请求生成（或沿用合法的）traceId，注入 logger、
 *    回写响应头、并写进错误响应体 —— 这是"点一下跳到日志现场"的前提。
 * 3. **统一错误处理**：任何异常都变成 `{ ok:false, error }`，且**默认不回传堆栈**。
 * 4. **CORS**：只对显式允许的来源开放（开发期的 Vite dev server）。
 *
 * 另外提供 `GET /__degraded`：前端资源加载或启动失败时的降级页。
 * 由服务端内联 HTML 渲染，**不依赖任何前端产物** —— 否则前端崩了连
 * 日志入口也一起没了（technical-design A17）。
 */

import { AppError } from '@pm-studio/shared';
import fastifyStatic from '@fastify/static';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import {
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from 'fastify-type-provider-zod';

import { extractBearerToken, extractTokenFromUrl, requiresAuth, safeCompare } from './auth';
import type { ServerConfig } from './config';
import { mapError } from './errors';
import type { Logger } from './logging/logger';
import type { LogBroadcaster } from './logging/sse';
import type { LogStore } from './logging/store';
import { newTraceId, normalizeTraceId } from './logging/trace';
import { createHealthRoutes } from './routes/health';
import { createCalendarMarkRoutes } from './routes/calendar-marks';
import { createJobRoutes } from './routes/jobs';
import { createLogRoutes } from './routes/logs';
import { createMilestoneRoutes } from './routes/milestones';
import { createProjectRoutes } from './routes/projects';
import { createSearchRoutes } from './routes/search';
import { createTagRoutes } from './routes/tags';
import { createTaskRoutes } from './routes/tasks';
import { createWorkTimeRoutes } from './routes/work-time';
import { createWorkLogRoutes } from './routes/work-log';
import { createWorkflowRoutes } from './routes/workflow';
import type { ServiceContext } from './services/context';
import { createBuiltinJobHandlers } from './services/job-handlers';
import {
  createJobEventHub,
  createJobRunner,
  type JobHandlerSpec,
  type JobRunner,
} from './services/job-runner';
import { recoverInterruptedJobs } from './services/jobs';
import { createDevServers, type DevServers } from './services/dev-servers';
import { createDevServerRoutes } from './routes/dev-servers';

declare module 'fastify' {
  interface FastifyInstance {
    /** 开发服务器管理器（项目启动 / 停止）；没有业务服务时不存在 */
    devServers: DevServers;
  }

  interface FastifyRequest {
    /**
     * 绑定到本次请求的 logger（已带 traceId）。
     *
     * 类型里保留 `| null` 是刻意的：`decorateRequest` 只能给一个占位值，
     * 而"某个钩子提前失败导致它还没被赋值"是真实存在的状态。
     * 调用方一律用 `?.` 访问。
     */
    appLog: Logger | null;
  }

  interface FastifyInstance {
    /**
     * 作业执行器（M4）。`deps.services` 存在时才有。
     *
     * 挂在实例上是为了让**主进程能在退出时调 `shutdown()`** ——
     * 应用退出时正在跑的作业要被取消，否则子进程会变成孤儿（装依赖那类尤其明显）。
     */
    jobRunner?: JobRunner;
  }
}

export interface AppDeps {
  config: ServerConfig;
  /** source='api' 的 logger */
  logger: Logger;
  logStore?: LogStore;
  logBroadcaster?: LogBroadcaster;
  /**
   * 业务服务上下文。不传时只挂健康检查与日志接口 ——
   * 这样"数据库还没打开"的早期启动阶段也能起服务（用户看到降级页而不是白屏）。
   */
  services?: ServiceContext;
  /**
   * 渲染层静态资源目录（生产环境）。
   *
   * 由主进程传入 `out/renderer`。开发环境不传 —— 那时渲染层由 Vite dev server
   * 提供（为了热更新），窗口直接加载 dev server 地址。
   */
  rendererRoot?: string;
  /**
   * 工作区根目录。提供后才会启用「诊断包导出」——
   * 该功能需要知道要摘要哪个目录。
   */
  workspaceRoot?: string;
  /**
   * 作业执行器要注册的 handler（M4）。
   *
   * **由调用方注入**：本包不内置任何 handler —— 第一个真作业"环境自检"要用桌面端
   * 那套 PATH 探测与工具清单，脚手架/装依赖以后也各自在自己的位置注册。
   * 不传就不建执行器（作业接口返回空列表，界面显示"这一版还没有可跑的作业"）。
   */
  jobHandlers?: readonly JobHandlerSpec[];
  /** 作业日志文件目录（`<id>.log`）。不传只落库、不落文件 */
  jobLogDir?: string;
  version?: string;
  now?: () => number;
}

/** 降级页：不依赖前端产物，确保最坏情况下仍有诊断入口 */
export function buildDegradedHtml(traceId: string, version: string): string {
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<title>项目管理系统 界面加载失败</title>
<style>
  body { font-family: system-ui, "Microsoft YaHei", sans-serif; margin: 0; padding: 48px;
         background: #18181c; color: #e5e5e8; }
  .card { max-width: 720px; margin: 0 auto; background: #232329; border: 1px solid #34343c;
          border-radius: 12px; padding: 32px; }
  h1 { font-size: 20px; margin: 0 0 16px; }
  code { background: #2d2d35; padding: 2px 6px; border-radius: 4px; }
  ol { line-height: 1.9; }
  .muted { color: #9a9aa5; font-size: 13px; margin-top: 24px; }
</style>
</head>
<body>
  <div class="card">
    <h1>界面加载失败，但服务是活的</h1>
    <p>前端资源没能启动。日志系统仍然可用，按下面顺序排查：</p>
    <ol>
      <li>打开日志查询：<code>/api/v1/logs?minLevel=warn&amp;pageSize=100</code></li>
      <li>用下面的 traceId 定位本次失败的完整现场：
          <code>/api/v1/logs/context/${traceId}</code></li>
      <li>需要求助时导出诊断包（已脱敏，不含项目正文）</li>
    </ol>
    <p>本次 traceId：<code>${traceId}</code>（调用接口时需要携带访问令牌）</p>
    <p class="muted">项目管理系统 ${version} · 此页面由服务端直接渲染，不依赖前端资源</p>
  </div>
</body>
</html>`;
}

function applyCors(request: FastifyRequest, reply: FastifyReply, config: ServerConfig): void {
  const origin = request.headers.origin;
  if (typeof origin !== 'string' || origin.length === 0) return;
  // 白名单之外的来源不返回任何 CORS 头，让浏览器自己拦下
  if (!config.allowedOrigins.includes(origin)) return;

  reply.header('access-control-allow-origin', origin);
  reply.header('vary', 'Origin');
  reply.header('access-control-allow-methods', 'GET,POST,PATCH,PUT,DELETE,OPTIONS');
  reply.header(
    'access-control-allow-headers',
    'authorization,content-type,x-trace-id,last-event-id',
  );
  reply.header('access-control-expose-headers', 'x-trace-id');
  reply.header('access-control-max-age', '600');
}

export async function createApp(deps: AppDeps): Promise<FastifyInstance> {
  const { config, logger } = deps;
  const version = deps.version ?? '0.1.0';
  const now = deps.now ?? Date.now;
  const startedAt = now();

  const app = Fastify({
    // 不用 pino：日志统一走我们自己的管道（分级、脱敏、落库、SSE）。
    // 注意：logger:false 之后 Fastify 自身就不再记请求日志了，
    // 因此不需要（也不该）再传已弃用的 disableRequestLogging —— 它在 Fastify 6 被移除。
    logger: false,
    // 只接受格式合法的入站 traceId；否则一律新生成，避免被注入伪造值
    genReqId: (req) => normalizeTraceId(req.headers['x-trace-id']) ?? newTraceId(),
  }).withTypeProvider<ZodTypeProvider>();

  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  app.decorateRequest('appLog', null);

  app.addHook('onRequest', async (request, reply) => {
    // 先绑 logger，保证后续任何失败都能带着 traceId 落日志
    request.appLog = logger.child('http', { traceId: request.id });
    reply.header('x-trace-id', request.id);

    applyCors(request, reply, config);

    if (request.method === 'OPTIONS') {
      reply.code(204).send();
      return;
    }

    if (!requiresAuth(request.url, config.apiPrefix)) return;

    // 头部优先；查询参数只作为 EventSource 无法带请求头时的退路
    const provided =
      extractBearerToken(request.headers.authorization) ?? extractTokenFromUrl(request.url);

    if (!provided || !safeCompare(provided, config.authToken)) {
      throw new AppError('UNAUTHORIZED', '访问令牌无效或缺失');
    }
  });

  app.addHook('onResponse', async (request, reply) => {
    if (!config.logRequests) return;

    const ms = Math.round(reply.elapsedTime);
    const status = reply.statusCode;
    const slow = ms >= config.slowRequestMs;
    const message = `${request.method} ${request.url} ${status} ${ms}ms`;
    const detail = slow ? { slow: true, thresholdMs: config.slowRequestMs } : undefined;

    // 5xx 是服务端故障 → error；4xx 与慢请求 → warn；其余 → info
    if (status >= 500) request.appLog?.error(message, detail);
    else if (status >= 400 || slow) request.appLog?.warn(message, detail);
    else request.appLog?.info(message);
  });

  app.setErrorHandler((error, request, reply) => {
    const mapped = mapError(error, request.id, { exposeStack: config.exposeErrorStack });

    const summary =
      mapped.body.ok === false ? `${mapped.body.error.code}: ${mapped.body.error.message}` : '错误';
    // detail 一定包含原始堆栈；它只进日志，不进响应
    request.appLog?.[mapped.logLevel](summary, mapped.detail);

    void reply.code(mapped.status).send(mapped.body);
  });

  app.setNotFoundHandler((request, reply) => {
    const isApiRequest = requiresAuth(request.url, config.apiPrefix);

    /**
     * 非 API 路径 → 回落到 SPA 入口。
     *
     * 用 hash 路由时只有 `/` 会走到这里，但保留回落逻辑更稳：
     * 将来若改成 history 路由，刷新深链不会变成 404。
     *
     * **必须排除 API 前缀**：否则前端请求一个不存在的接口会拿到一份 HTML，
     * 于是所有的"接口 404 处理"都会变成 JSON 解析错误，难以排查。
     */
    if (!isApiRequest && deps.rendererRoot && request.method === 'GET') {
      void reply.sendFile('index.html');
      return;
    }

    const mapped = mapError(
      new AppError('NOT_FOUND', `找不到路由 ${request.method} ${request.url}`),
      request.id,
    );
    request.appLog?.warn(mapped.body.ok === false ? mapped.body.error.message : '未找到');
    void reply.code(mapped.status).send(mapped.body);
  });

  app.get('/__degraded', async (request, reply) => {
    request.appLog?.warn('渲染层降级页被访问', { hint: '前端资源加载或启动失败' });
    void reply
      .code(200)
      .type('text/html; charset=utf-8')
      .send(buildDegradedHtml(request.id, version));
  });

  await app.register(createHealthRoutes({ version, startedAt }));

  if (deps.rendererRoot) {
    await app.register(fastifyStatic, {
      root: deps.rendererRoot,
      index: ['index.html'],
      // 刻意**不注册通配路由**：注册了的话，未知的 API 路径也会命中静态处理器，
      // 返回一份 HTML 而不是 JSON 错误，前端的错误处理会全部失灵。
      // 由上面的 notFoundHandler 决定何时回落到 index.html。
      wildcard: false,
      cacheControl: true,
      maxAge: '1h',
    });
  }

  if (deps.logStore) {
    await app.register(
      createLogRoutes({
        store: deps.logStore,
        logger,
        ...(deps.logBroadcaster ? { broadcaster: deps.logBroadcaster } : {}),
        ...(deps.services && deps.workspaceRoot
          ? {
              diagnostics: {
                services: deps.services,
                workspaceRoot: deps.workspaceRoot,
                appVersion: version,
                authToken: config.authToken,
              },
            }
          : {}),
      }),
      { prefix: `${config.apiPrefix}/logs` },
    );
  }

  if (deps.services) {
    const services = deps.services;

    /*
     * 开发服务器（项目的启动 / 停止）。
     *
     * 与作业执行器并列而不是塞进它：作业是"跑完拿结果"，开发服务器是长驻进程，
     * 输出要边跑边看、停止要杀整棵进程树（理由写在 dev-servers.ts 的文件头）。
     * `onClose` 里全部停掉 —— 应用退出时不留孤儿进程占着端口。
     *
     * **创建得比项目路由早**：项目路由的删除动作要问它"这个项目是不是正在跑"
     * （正在运行的项目不允许删除，见 routes/projects.ts）。放在后面的话，
     * 那个检查拿不到实例，只能靠一个"稍后才赋值"的变量 —— 那是一个请求先到就炸的坑。
     */
    const devServers = createDevServers(services);
    app.decorate('devServers', devServers);
    app.addHook('onClose', async () => {
      devServers.shutdown();
    });

    // 四组都注册在 API 前缀下：它们共享 `/projects/:projectId/...` 这类路径段，
    // 由 Fastify 的路由器负责区分（静态段优先于参数段）
    await app.register(createProjectRoutes(services, { servers: devServers }), {
      prefix: config.apiPrefix,
    });
    await app.register(createWorkflowRoutes(services), { prefix: config.apiPrefix });
    await app.register(createTagRoutes(services), { prefix: config.apiPrefix });
    await app.register(createMilestoneRoutes(services), { prefix: config.apiPrefix });
    await app.register(createTaskRoutes(services), { prefix: config.apiPrefix });
    await app.register(createSearchRoutes(services), { prefix: config.apiPrefix });
    await app.register(createCalendarMarkRoutes(services), { prefix: config.apiPrefix });
    // 当日工时（打卡）与今日待办：同一个日期键，同一次注册
    await app.register(createWorkTimeRoutes(services), { prefix: config.apiPrefix });
    // 工作日志（Word 文档）
    await app.register(createWorkLogRoutes(services), { prefix: config.apiPrefix });

    /*
     * 作业执行器（M4）。
     *
     * 顺序很重要：**先把崩溃恢复做完再挂路由** —— 恢复会把上次残留的
     * `queued` / `running` 标成 `interrupted`；如果路由先挂上，用户在那一瞬间
     * 刷新列表还会看到"永远在排队"的假象。
     */
    const interrupted = recoverInterruptedJobs(services);
    if (interrupted > 0) {
      deps.logger.warn('发现上次没跑完的作业，已标记为「已中断」', { count: interrupted });
    }

    const jobHub = createJobEventHub();
    const jobRunner = createJobRunner({
      ctx: services,
      logger: deps.logger.child('jobs'),
      /*
       * 服务端自带的 handler（脚手架）+ 调用方注入的（环境自检在主进程那边）。
       * 两边合并的理由：分界线是"这件事需要谁的数据"，而不是"属于哪个里程碑"。
       */
      handlers: [...createBuiltinJobHandlers(), ...(deps.jobHandlers ?? [])],
      onEvent: (event) => jobHub.emit(event),
      ...(deps.jobLogDir !== undefined ? { logDir: deps.jobLogDir } : {}),
    });

    app.decorate('jobRunner', jobRunner);
    app.addHook('onClose', async () => {
      jobRunner.shutdown();
      jobHub.close();
    });

    /*
     * 开发服务器的实例在上面已经建好并装饰好了（它要比项目路由先存在）。
     * 这里只挂路由。
     */
    await app.register(
      createDevServerRoutes({ ctx: services, servers: devServers }),
      { prefix: config.apiPrefix },
    );

    await app.register(
      createJobRoutes({
        ctx: services,
        runner: jobRunner,
        subscribe: (listener) => jobHub.subscribe(listener),
      }),
      { prefix: config.apiPrefix },
    );
  }

  return app;
}
