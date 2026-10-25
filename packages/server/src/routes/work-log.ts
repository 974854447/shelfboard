/**
 * 工作日志（Word）路由。
 */

import { AppError, ok } from '@pm-studio/shared';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';

import type { ServiceContext } from '../services/context.js';
import * as workLogService from '../services/work-log.js';
import { isValidDateKey, localDateKey } from '../services/work-time.js';

const dateKeySchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, '日期必须是 YYYY-MM-DD');

const previewQuerySchema = z.object({ date: dateKeySchema.optional() });

const generateBodySchema = z.object({
  date: dateKeySchema.optional(),
  /** 保存目录；不传则用主进程注入的默认目录（设置里可改） */
  dir: z.string().min(1).max(1000).optional(),
  /** 文件名（不含扩展名）；默认「YYYY-MM-DD 工作日志」 */
  fileName: z.string().min(1).max(120).optional(),
});

export function createWorkLogRoutes(ctx: ServiceContext): FastifyPluginAsyncZod {
  return async (app) => {
    /**
     * 当前生效的默认保存目录。
     *
     * 设置页要显示"不填的话会存到哪儿"，而那个默认值是主进程解析出来的
     * （`<文档>\项目管理系统\工作日志`），渲染层自己拼不出来。
     */
    app.get('/work-log/config', async () =>
      ok({ defaultDir: ctx.workLogDir ?? null, today: localDateKey(ctx.now()) }),
    );

    /** 生成之前先看内容：让用户在点"生成"之前就知道文档里会有什么 */
    app.get('/work-log/preview', { schema: { querystring: previewQuerySchema } }, async (request) => {
      const dateKey = request.query.date ?? localDateKey(ctx.now());
      if (!isValidDateKey(dateKey)) {
        throw new AppError('VALIDATION_FAILED', `日期不合法：${dateKey}`);
      }
      return ok(workLogService.collectWorkLogData(ctx, dateKey));
    });

    /** 生成并保存 Word 文档（真的要写文件，返回真实路径） */
    app.post(
      '/work-log/generate',
      { schema: { body: generateBodySchema.optional() } },
      async (request) => {
        const body = request.body ?? {};
        if (body.date !== undefined && !isValidDateKey(body.date)) {
          throw new AppError('VALIDATION_FAILED', `日期不合法：${body.date}`);
        }
        const result = await workLogService.saveWorkLog(ctx, {
          ...(body.date !== undefined ? { dateKey: body.date } : {}),
          ...(body.dir !== undefined ? { dir: body.dir } : {}),
          ...(body.fileName !== undefined ? { fileName: body.fileName } : {}),
        });
        return ok({
          path: result.path,
          dir: result.dir,
          bytes: result.bytes,
          overwritten: result.overwritten,
          dateKey: result.data.dateKey,
        });
      },
    );
  };
}
