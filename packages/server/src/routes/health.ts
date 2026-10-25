/**
 * 健康检查。
 *
 * 刻意放在 API 前缀**之外**、且不要求鉴权：它是"服务到底起来了没有"
 * 的唯一外部探针，如果需要令牌才能问，那在排查启动失败时就没用了。
 */

import { ok } from '@pm-studio/shared';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';

export interface HealthDeps {
  version: string;
  startedAt: number;
}

export function createHealthRoutes(deps: HealthDeps): FastifyPluginAsyncZod {
  return async (app) => {
    app.get('/health', async () =>
      ok({
        status: 'ok' as const,
        version: deps.version,
        uptimeMs: Date.now() - deps.startedAt,
      }),
    );
  };
}
