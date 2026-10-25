/**
 * 内嵌 Fastify 服务的托管。
 *
 * 刻意的顺序：**先打开工作区数据库，再启动服务**。
 * 因为 `createApp` 需要业务服务上下文，而上下文又依赖已打开的数据库连接。
 * 反过来（先起服务后注入数据库）需要可变注入，会让"服务已就绪但数据库没有"
 * 这种中间态泄漏到接口层，得不偿失。
 */

import type { FastifyInstance } from 'fastify';
import {
  createApp,
  createServiceContext,
  ensureProjectFolders,
  type DbConnection,
  type JobHandlerSpec,
  type LogBroadcaster,
  type LogStore,
  type Logger,
  type ServerConfig,
  type ServiceContext,
} from '@pm-studio/server';

export interface EmbeddedServerOptions {
  conn: DbConnection;
  logger: Logger;
  logStore: LogStore;
  logBroadcaster: LogBroadcaster;
  /** 每次启动重新生成的一次性访问令牌 */
  token: string;
  version: string;
  /** 开发期允许 Vite dev server 跨源访问；生产环境同源，留空 */
  allowedOrigins?: readonly string[];
  /** 渲染层静态资源目录（生产环境），由本服务提供以获得同源 */
  rendererRoot?: string;
  /** 工作区根目录，启用「诊断包导出」时需要 */
  workspaceRoot?: string;
  /**
   * 作业执行器要注册的 handler（M4）。
   *
   * 由主进程注入的理由：第一个真作业「环境自检」要用 `env-detect.ts` 那套
   * PATH 探测与工具清单，而那套东西属于主进程（要碰文件系统与 userData 路径）。
   * 服务端只负责"怎么排、怎么跑、怎么推事件"。
   */
  jobHandlers?: readonly JobHandlerSpec[];
  /** 作业日志文件目录（`<id>.log`） */
  jobLogDir?: string;
  /**
   * 工作日志（Word）的默认保存目录。
   *
   * 由主进程解析（默认 `<文档>\项目管理系统\工作日志`，或设置里指定的目录）后注入：
   * "文档目录在哪"是 Electron 才知道的事，服务端不该自己猜。
   */
  workLogDir?: string;
}

export interface EmbeddedServer {
  app: FastifyInstance;
  services: ServiceContext;
  port: number;
  baseUrl: string;
  token: string;
  close(): Promise<void>;
}

/**
 * 启动内嵌服务。
 *
 * 端口用 `0` 让操作系统分配**随机空闲端口** —— 写死端口会与用户机器上
 * 其他程序撞车，而这类冲突的报错（EADDRINUSE）对普通用户毫无意义。
 */
export async function startEmbeddedServer(
  options: EmbeddedServerOptions,
): Promise<EmbeddedServer> {
  const services = createServiceContext({
    conn: options.conn,
    logger: options.logger.child('service'),
    // 服务层要按工作区根目录创建/检查"项目文件夹"，所以根目录必须传进来
    ...(options.workspaceRoot ? { workspaceRoot: options.workspaceRoot } : {}),
    // 工作日志的默认落点（服务端只负责往里写，不负责猜"文档目录在哪"）
    ...(options.workLogDir ? { workLogDir: options.workLogDir } : {}),
  });

  // 0.1.1 及更早的项目只有数据库记录、没有文件夹，这里补一次（幂等）。
  // 放在服务就绪之后、监听之前：补建失败也不该让应用起不来。
  if (options.workspaceRoot) {
    try {
      const backfilled = ensureProjectFolders(services);
      if (backfilled.created.length > 0) {
        options.logger.info('已为老项目补建文件夹', {
          count: backfilled.created.length,
          folders: backfilled.created.map((c) => c.folder),
        });
      }
    } catch (error) {
      options.logger.warn('给老项目补建文件夹失败，不影响启动', { error });
    }
  }

  const config: ServerConfig = {
    authToken: options.token,
    apiPrefix: '/api/v1',
    allowedOrigins: options.allowedOrigins ?? [],
    logRequests: true,
    slowRequestMs: 1000,
    exposeErrorStack: false,
  };

  const app = await createApp({
    config,
    logger: options.logger.child('http'),
    logStore: options.logStore,
    logBroadcaster: options.logBroadcaster,
    services,
    version: options.version,
    ...(options.rendererRoot ? { rendererRoot: options.rendererRoot } : {}),
    ...(options.workspaceRoot ? { workspaceRoot: options.workspaceRoot } : {}),
    ...(options.jobHandlers ? { jobHandlers: options.jobHandlers } : {}),
    ...(options.jobLogDir ? { jobLogDir: options.jobLogDir } : {}),
  });

  await app.listen({ host: '127.0.0.1', port: 0 });

  const address = app.server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;

  if (port === 0) {
    await app.close();
    throw new Error('内嵌服务未能取得监听端口');
  }

  return {
    app,
    services,
    port,
    baseUrl: `http://127.0.0.1:${port}`,
    token: options.token,
    close: async () => {
      await app.close();
    },
  };
}
