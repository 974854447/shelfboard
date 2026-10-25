/**
 * 项目路由。
 *
 * 约定：路由只做三件事 —— 校验入参、调用服务、包统一响应。
 * 任何业务判断都不写在这里，否则"同一个规则在 HTTP 层和作业层各写一遍"
 * 迟早会出现不一致。
 */

import {
  applyProjectTemplateInputSchema,
  booleanQuerySchema,
  createProjectInputSchema,
  createProjectRelationInputSchema,
  idSchema,
  ok,
  projectIdParamSchema,
  projectListQuerySchema,
  updateProjectInputSchema,
  updateProjectRelationInputSchema,
} from '@pm-studio/shared';
import { AppError } from '@pm-studio/shared';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';

import type { ServiceContext } from '../services/context.js';
import { listActivity } from '../services/activity.js';
import type { DevServers } from '../services/dev-servers.js';
import * as projectService from '../services/projects.js';
import * as projectRelationService from '../services/project-relations.js';
import * as projectTemplateService from '../services/project-template.js';

const relationParamSchema = z.object({ id: idSchema });

const deleteQuerySchema = z.object({
  /** true 表示物理删除（级联清空任务等），默认只进回收站 */
  hard: booleanQuerySchema.optional(),
});

const activityQuerySchema = z.object({
  limit: z.coerce.number().int().positive().max(500).optional(),
});

export interface ProjectRoutesDeps {
  /**
   * 开发服务器（用来拦住"项目正在运行还想删"）。
   *
   * 为什么这条判断放在**路由层**而不是 projects 服务里：服务层不该知道
   * "开发服务器"这种东西（它在内存里、由进程句柄组成，跟数据库无关）。
   * 路由层拿到实例做一次只读判断，是这两层之间最薄的一层耦合。
   */
  servers?: DevServers;
}

/**
 * 项目的开发服务器是否正在跑（含"正在启动"）。
 *
 * 三种状态里 `running` 与 `starting` 都算"在跑"：`starting` 也已经 spawn 出进程了，
 * 这时候把项目删掉会留下一个没人管的进程占着端口 —— 正是这条守卫要避免的。
 *
 * 导出成独立函数是为了能**直接单测这条规则**：真跑一个开发服务器需要派生进程，
 * 在单测里既慢又不稳；用桩对象喂三种状态就能把边界（含"没有服务器实例"时不拦）钉死。
 */
export function assertProjectNotRunning(
  servers: DevServers | undefined,
  projectId: string,
): void {
  if (!servers) return;
  const busy = servers
    .states(projectId)
    .find((state) => state.status === 'running' || state.status === 'starting');
  if (busy) {
    throw new AppError('CONFLICT', '这个项目正在运行，请先停止开发服务器再删除。', {
      details: { projectId, status: busy.status, role: busy.role },
    });
  }
}

export function createProjectRoutes(
  ctx: ServiceContext,
  deps: ProjectRoutesDeps = {},
): FastifyPluginAsyncZod {
  return async (app) => {
    app.get(
      '/projects',
      { schema: { querystring: projectListQuerySchema } },
      async (request) => ok(projectService.listProjects(ctx, request.query)),
    );

    app.post(
      '/projects',
      { schema: { body: createProjectInputSchema } },
      async (request, reply) => {
        const project = projectService.createProject(ctx, request.body);
        // 201：前端据此判断"创建成功"而不是"查到了"
        void reply.code(201);
        return ok(project);
      },
    );

    app.get(
      '/projects/:id',
      { schema: { params: projectIdParamSchema } },
      async (request) => ok(projectService.getProjectOrThrow(ctx, request.params.id)),
    );

    app.patch(
      '/projects/:id',
      { schema: { params: projectIdParamSchema, body: updateProjectInputSchema } },
      async (request) =>
        ok(projectService.updateProject(ctx, request.params.id, request.body)),
    );

    app.delete(
      '/projects/:id',
      { schema: { params: projectIdParamSchema, querystring: deleteQuerySchema } },
      async (request) => {
        /*
         * **正在运行的项目不许删**（用户 2026-10-01 的要求）。
         *
         * 界面在点删除时会先提示一次，但那条提示只对本进程的界面有效；
         * 这里是权威判断 —— 直接调接口同样会被挡住。
         * 进回收站（软删除）也一并拦住：项目的开发服务器还在跑，
         * 进回收站之后界面上连"停止"的入口都没有了，等于把那台服务器放生。
         */
        assertProjectNotRunning(deps.servers, request.params.id);

        const hard = request.query.hard === true;
        if (hard) projectService.hardDeleteProject(ctx, request.params.id);
        else projectService.softDeleteProject(ctx, request.params.id);
        return ok({ deleted: true, hard });
      },
    );

    app.post(
      '/projects/:id/restore',
      { schema: { params: projectIdParamSchema } },
      async (request) => ok(projectService.restoreProject(ctx, request.params.id)),
    );

    /**
     * 清空回收站（用户 2026-10-01：「回收站新增一键删除」）。
     *
     * 一次请求、一个事务把所有**已软删除**的项目物理删掉。做成服务端接口而不是
     * 前端循环发 N 个删除请求：那样在半途失败时会留下"删了一半"的中间状态，
     * 而"清空"这件事用户期待的是要么都清、要么都不清。
     *
     * 路径放在 `/projects/trash/purge`：静态段 `trash` 优先于 `:id`，
     * 所以不会跟 `/projects/:id/...` 撞上（Fastify 的路由器按静态段优先匹配）。
     */
    app.post('/projects/trash/purge', async () => {
      /*
       * 防御性检查：正常情况下回收站里**不该**有正在运行的项目
       * （软删除那一步就被拦住了），但如果真出现了（状态错乱、手工改过库），
       * 宁可整件事失败并报出是哪一个，也不要删掉一个还在跑的项目的记录。
       */
      const trashed = projectService
        .listProjects(ctx, { includeDeleted: true, includeArchived: true })
        .filter((project) => project.deletedAt !== null);
      for (const project of trashed) assertProjectNotRunning(deps.servers, project.id);

      return ok(projectService.purgeTrash(ctx));
    });

    app.post(
      '/projects/:id/archive',
      { schema: { params: projectIdParamSchema } },
      async (request) =>
        ok(projectService.setProjectStatus(ctx, request.params.id, 'archived')),
    );

    /*
     * 管理侧模板：把项目"铺成非空"（任务清单 / 里程碑 / 文档模板）。
     *
     * 逻辑全在服务里（`applyManagementTemplate`）：路由只校验入参与包响应，
     * 这样"哪些块可以关"这类规则不会在 HTTP 层与作业层各写一份。
     */
    app.post(
      '/projects/:id/apply-template',
      { schema: { params: projectIdParamSchema, body: applyProjectTemplateInputSchema } },
      async (request) => {
        const result = projectTemplateService.applyManagementTemplate(
          ctx,
          request.params.id,
          request.body,
        );
        /*
         * 顺手给一句**人话小结**（"已铺 15 个任务、3 个里程碑、…"）：
         * 这句话界面与日志都要用，放在服务端算一次，免得两边各写一套措辞后对不上。
         */
        return ok({ ...result, description: projectTemplateService.describeTemplateResult(result) });
      },
    );

    app.post(
      '/projects/:id/unarchive',
      { schema: { params: projectIdParamSchema } },
      async (request) =>
        ok(projectService.setProjectStatus(ctx, request.params.id, 'active')),
    );

    /*
     * 关系链（需求 §5.2.1）：**纯展示**。
     *
     * 三条接口都只是"标一条关系 / 改一句话 / 删掉"，服务层不做任何联动 ——
     * 这一版刻意不加"关系会影响什么"的行为，字段上也没留出这种口子。
     */
    /*
     * 卡片小结放在 `/projects/relation-summary`（**不是** `/projects/:id/...`）：
     * 路径参数会把 "relation-summary" 当成一个项目 id，路由注册顺序稍有不慎
     * 就会先命中 `/projects/:id` 那条。放成独立路径，顺序问题根本不存在。
     */
    app.get('/projects/relation-summary', async () =>
      ok(projectRelationService.summarizeRelations(ctx)),
    );

    app.get(
      '/projects/:id/relations',
      { schema: { params: projectIdParamSchema } },
      async (request) => {
        projectService.getProjectOrThrow(ctx, request.params.id);
        return ok(projectRelationService.listRelationsForProject(ctx, request.params.id));
      },
    );

    app.post(
      '/projects/:id/relations',
      { schema: { params: projectIdParamSchema, body: createProjectRelationInputSchema } },
      async (request, reply) => {
        const relation = projectRelationService.createRelation(
          ctx,
          request.params.id,
          request.body,
        );
        void reply.code(201);
        return ok(relation);
      },
    );

    app.patch(
      '/project-relations/:id',
      { schema: { params: relationParamSchema, body: updateProjectRelationInputSchema } },
      async (request) =>
        ok(projectRelationService.updateRelation(ctx, request.params.id, request.body)),
    );

    app.delete(
      '/project-relations/:id',
      { schema: { params: relationParamSchema } },
      async (request) => ok(projectRelationService.deleteRelation(ctx, request.params.id)),
    );

    // 活动流：回答"这个项目最近被改了什么"
    app.get(
      '/projects/:id/activity',
      { schema: { params: projectIdParamSchema, querystring: activityQuerySchema } },
      async (request) => {
        projectService.getProjectOrThrow(ctx, request.params.id);
        return ok(
          listActivity(ctx, { projectId: request.params.id, limit: request.query.limit }),
        );
      },
    );

    // 供前端做路径/项目校验的小接口：不抛 404，只回是否存在
    app.get(
      '/projects/:id/exists',
      { schema: { params: z.object({ id: idSchema }) } },
      async (request) => {
        const all = projectService.listProjects(ctx, { includeArchived: true });
        return ok({ exists: all.some((p) => p.id === request.params.id) });
      },
    );
  };
}
