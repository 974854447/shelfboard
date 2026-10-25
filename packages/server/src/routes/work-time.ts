/**
 * 当日工作时间（打卡）+ 今日待办 路由。
 *
 * 为什么这两块放一个文件：它们服务同一个界面（我的待办），而且"今天"是同一个日期键 ——
 * 分成两个文件后，两处各自算日期键，迟早会出现一个按昨天一个按今天算的错位。
 */

import { AppError, idSchema, ok } from '@pm-studio/shared';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';

import type { ServiceContext } from '../services/context.js';
import * as projectService from '../services/projects.js';
import * as todayService from '../services/today.js';
import * as workTimeService from '../services/work-time.js';

const dateKeySchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, '日期键必须是 YYYY-MM-DD');

const dayQuerySchema = z.object({ date: dateKeySchema.optional() });

const todayQuerySchema = z.object({
  /** 逗号分隔的分组；不传 = 全部四组 */
  groups: z.string().optional(),
  /**
   * 只看这个项目的任务（今日待办按当前项目过滤用）。
   *
   * 只收**单个** projectId，不收逗号分隔的列表：界面上的口径就是"当前项目"，
   * 开放成多项目等于给一个没人用的口子，而它会让"projectId 是哪一个"变得含糊。
   */
  projectId: idSchema.optional(),
  at: z.coerce.number().int().optional(),
});

const taskParamSchema = z.object({ id: idSchema });

const markBodySchema = z.object({ marked: z.boolean() });

export function createWorkTimeRoutes(ctx: ServiceContext): FastifyPluginAsyncZod {
  return async (app) => {
    // 今天的工时（渲染层用 open + generatedAt 自己把秒数往上跳，不必每秒问服务端）
    app.get('/work-time/today', async () => ok(workTimeService.getDaySummary(ctx)));

    // 任意一天的工时（点日历回看、工作日志取数都用它）
    app.get(
      '/work-time/day',
      { schema: { querystring: dayQuerySchema } },
      async (request) => {
        const dateKey = request.query.date ?? workTimeService.localDateKey(ctx.now());
        if (!workTimeService.isValidDateKey(dateKey)) {
          // 不合法就明确报错，不要"返回空数据装作这天没工时" —— 那会让界面显示一个假的 0。
          throw new AppError('VALIDATION_FAILED', `日期不合法：${dateKey}`);
        }
        return ok(workTimeService.getDaySummary(ctx, dateKey));
      },
    );

    // 手动结束当前计时（用户按了"结束计时"）。正常退出走主进程，不经过这里。
    app.post('/work-time/stop', async () => {
      const changed = workTimeService.endOpenSessions(ctx, 'manual');
      return ok({ stopped: changed > 0, session: workTimeService.getDaySummary(ctx) });
    });

    // 今日待办（默认按当前项目过滤，见 TodayOptions.projectIds 的说明）
    app.get('/today', { schema: { querystring: todayQuerySchema } }, async (request) => {
      const groups = parseGroups(request.query.groups);
      const projectId = request.query.projectId;
      if (projectId !== undefined) {
        // 项目不存在就明确报错，而不是"过滤掉所有任务"装成"今天没事做"
        projectService.getProjectOrThrow(ctx, projectId);
      }
      return ok(
        todayService.getTodayBoard(ctx, {
          ...(groups ? { groups } : {}),
          ...(projectId !== undefined ? { projectIds: [projectId] } : {}),
          ...(request.query.at !== undefined ? { at: request.query.at } : {}),
        }),
      );
    });

    // 标记 / 取消「今天做」
    app.post(
      '/tasks/:id/today-mark',
      { schema: { params: taskParamSchema, body: markBodySchema } },
      async (request) =>
        ok({ todayMarkDate: todayService.setTodayMark(ctx, request.params.id, request.body.marked) }),
    );
  };
}

/** 解析 `?groups=due,marked`；无法识别的分组直接忽略（不静默当成"全部"） */
function parseGroups(raw: string | undefined): todayService.TodayGroup[] | null {
  if (raw === undefined) return null;
  const wanted = raw
    .split(',')
    .map((part) => part.trim())
    .filter((part): part is todayService.TodayGroup =>
      (todayService.TODAY_GROUPS as readonly string[]).includes(part),
    );
  return wanted.length > 0 ? wanted : null;
}
