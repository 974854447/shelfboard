/**
 * 项目启动 / 停止的路由（M4）。
 *
 * 三条接口，语义都很直白：
 *   GET  /projects/:id/run          现在能不能启动、启动了没有、最近输出
 *   POST /projects/:id/run/start    启动（不传 role 就把该项目所有目标都起来）
 *   POST /projects/:id/run/stop     停止（同样支持只停一侧）
 *
 * 没有"重启"：重启=停止+启动，两步各自都能失败，合成一个接口只会让失败原因变模糊。
 */

import { ok, projectIdParamSchema, runStartInputSchema, runStopInputSchema } from '@pm-studio/shared';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';

import type { ServiceContext } from '../services/context.js';
import type { DevServers } from '../services/dev-servers.js';
import { getProjectOrThrow } from '../services/projects.js';

export interface DevServerRoutesDeps {
  ctx: ServiceContext;
  servers: DevServers;
}

export function createDevServerRoutes(deps: DevServerRoutesDeps): FastifyPluginAsyncZod {
  const { ctx, servers } = deps;

  return async (app) => {
    app.get(
      '/projects/:id/run',
      { schema: { params: projectIdParamSchema } },
      async (request) => {
        // 项目不存在要报 404，而不是回一份空状态（空状态看起来像"能启动"）
        getProjectOrThrow(ctx, request.params.id);
        return ok({
          ...servers.overview(request.params.id),
          /** 哪些项目正在跑（程序页上的"运行中"标记也用这个接口） */
          runningProjectIds: servers.runningProjectIds(),
        });
      },
    );

    app.post(
      '/projects/:id/run/start',
      { schema: { params: projectIdParamSchema, body: runStartInputSchema } },
      async (request) => {
        const states = await servers.start(request.params.id, {
          ...(request.body.role !== undefined ? { role: request.body.role } : {}),
          ...(request.body.port !== undefined ? { port: request.body.port } : {}),
        });
        return ok({ states });
      },
    );

    app.post(
      '/projects/:id/run/stop',
      { schema: { params: projectIdParamSchema, body: runStopInputSchema } },
      async (request) => {
        const states = await servers.stop(request.params.id, {
          ...(request.body.role !== undefined ? { role: request.body.role } : {}),
        });
        return ok({ states });
      },
    );
  };
}
