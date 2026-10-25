import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';

import { createApp } from '../src/app';
import { defaultServerConfig } from '../src/config';
import { DbConnection } from '../src/db/connection';
import { createLogger } from '../src/logging/logger';
import { createLogStore, type LogStore } from '../src/logging/store';
import { assertProjectNotRunning } from '../src/routes/projects';
import { createServiceContext } from '../src/services/context';

const TOKEN = 'routes-test-token-123456';
const AUTH = { authorization: `Bearer ${TOKEN}` };
const API = '/api/v1';

interface Harness {
  app: FastifyInstance;
  conn: DbConnection;
  store: LogStore;
}

const harnesses: Harness[] = [];

async function setup(): Promise<Harness> {
  const conn = new DbConnection();
  conn.open(':memory:');

  const store = createLogStore({ db: conn.sqlite, flushBatch: 1, flushIntervalMs: 0 });
  const logger = createLogger({ source: 'api', sinks: [store], minLevel: 'debug' });
  const services = createServiceContext({ conn, logger });

  const app = await createApp({
    config: defaultServerConfig({ authToken: TOKEN }),
    logger,
    logStore: store,
    services,
    version: '0.1.0-test',
  });

  const harness: Harness = { app, conn, store };
  harnesses.push(harness);
  return harness;
}

afterEach(async () => {
  while (harnesses.length > 0) {
    const h = harnesses.pop();
    if (!h) continue;
    await h.app.close();
    h.store.close();
    h.conn.close();
  }
});

interface Envelope<T> {
  ok: boolean;
  data: T;
  error?: { code: string; message: string; details?: unknown; traceId?: string };
}

async function createProject(h: Harness, name = '测试项目'): Promise<{ id: string; name: string }> {
  const res = await h.app.inject({
    method: 'POST',
    url: `${API}/projects`,
    headers: AUTH,
    payload: { name },
  });
  return (res.json() as Envelope<{ id: string; name: string }>).data;
}

describe('项目路由', () => {
  it('创建项目返回 201 与完整对象', async () => {
    const h = await setup();
    const res = await h.app.inject({
      method: 'POST',
      url: `${API}/projects`,
      headers: AUTH,
      payload: { name: '前端重构', color: '#ff0000' },
    });

    expect(res.statusCode).toBe(201);
    const body = res.json() as Envelope<{ id: string; name: string; color: string; status: string }>;
    expect(body.ok).toBe(true);
    expect(body.data.name).toBe('前端重构');
    expect(body.data.color).toBe('#ff0000');
    expect(body.data.status).toBe('active');
  });

  it('创建后工作流状态已就绪（看板可以直接用）', async () => {
    const h = await setup();
    const project = await createProject(h);

    const res = await h.app.inject({
      method: 'GET',
      url: `${API}/projects/${project.id}/workflow-statuses`,
      headers: AUTH,
    });

    const body = res.json() as Envelope<{ items: Array<{ name: string }>; counts: unknown[] }>;
    expect(body.data.items.map((s) => s.name)).toEqual([
      '待完成',
      '正在修改',
      '待审查',
      '审查中',
      '回退修改',
      '已完成',
    ]);
    expect(body.data.counts).toHaveLength(6);
  });

  it('名称为空时返回 400 与字段级 details', async () => {
    const h = await setup();
    const res = await h.app.inject({
      method: 'POST',
      url: `${API}/projects`,
      headers: AUTH,
      payload: { name: '   ' },
    });

    expect(res.statusCode).toBe(400);
    const body = res.json() as Envelope<unknown>;
    expect(body.error?.code).toBe('VALIDATION_FAILED');
    expect(Array.isArray(body.error?.details)).toBe(true);
  });

  it('颜色格式非法被拒绝', async () => {
    const h = await setup();
    const res = await h.app.inject({
      method: 'POST',
      url: `${API}/projects`,
      headers: AUTH,
      payload: { name: 'P', color: 'red' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('查询不存在的项目返回 404 且带 traceId', async () => {
    const h = await setup();
    const res = await h.app.inject({
      method: 'GET',
      url: `${API}/projects/does-not-exist`,
      headers: AUTH,
    });

    expect(res.statusCode).toBe(404);
    const body = res.json() as Envelope<unknown>;
    expect(body.error?.code).toBe('NOT_FOUND');
    expect(body.error?.traceId).toBe(res.headers['x-trace-id']);
  });

  /**
   * 回归测试：`z.coerce.boolean()` 会把字符串 "false" 强制成 true，
   * 于是 ?includeArchived=false 反而变成"包含归档"。
   * 这条断言专门锁住这个反向行为。
   */
  it('includeArchived=false 不会包含归档项目（旧实现会反向出错）', async () => {
    const h = await setup();
    const keep = await createProject(h, '活跃');
    const archived = await createProject(h, '归档');

    await h.app.inject({
      method: 'POST',
      url: `${API}/projects/${archived.id}/archive`,
      headers: AUTH,
    });

    const excluded = await h.app.inject({
      method: 'GET',
      url: `${API}/projects?includeArchived=false`,
      headers: AUTH,
    });
    const excludedBody = excluded.json() as Envelope<Array<{ id: string }>>;
    expect(excludedBody.data.map((p) => p.id)).toEqual([keep.id]);

    const included = await h.app.inject({
      method: 'GET',
      url: `${API}/projects?includeArchived=true`,
      headers: AUTH,
    });
    expect((included.json() as Envelope<unknown[]>).data).toHaveLength(2);
  });

  it('修改项目并只回传最新状态', async () => {
    const h = await setup();
    const project = await createProject(h);

    const res = await h.app.inject({
      method: 'PATCH',
      url: `${API}/projects/${project.id}`,
      headers: AUTH,
      payload: { name: '改名了', description: '描述' },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json() as Envelope<{ name: string; description: string }>;
    expect(body.data.name).toBe('改名了');
    expect(body.data.description).toBe('描述');
  });

  it('软删除后列表看不到、还原后回来', async () => {
    const h = await setup();
    const project = await createProject(h);

    await h.app.inject({ method: 'DELETE', url: `${API}/projects/${project.id}`, headers: AUTH });

    const afterDelete = await h.app.inject({ method: 'GET', url: `${API}/projects`, headers: AUTH });
    expect((afterDelete.json() as Envelope<unknown[]>).data).toHaveLength(0);

    await h.app.inject({
      method: 'POST',
      url: `${API}/projects/${project.id}/restore`,
      headers: AUTH,
    });

    const afterRestore = await h.app.inject({ method: 'GET', url: `${API}/projects`, headers: AUTH });
    expect((afterRestore.json() as Envelope<unknown[]>).data).toHaveLength(1);
  });

  it('hard=true 走物理删除', async () => {
    const h = await setup();
    const project = await createProject(h);

    const res = await h.app.inject({
      method: 'DELETE',
      url: `${API}/projects/${project.id}?hard=true`,
      headers: AUTH,
    });

    expect((res.json() as Envelope<{ hard: boolean }>).data.hard).toBe(true);
    expect(h.conn.sqlite.prepare('SELECT COUNT(*) AS c FROM projects').get()).toEqual({ c: 0 });
  });

  /**
   * 回收站的"彻底删除"（用户 2026-10-01 的要求：回收站里删除则完全删除项目）。
   *
   * 这条单测是为一个**真被 e2e 抓到的 bug** 补的：`hardDeleteProject` 原来复用
   * `getProjectOrThrow`，而那条守卫把"已软删除"的项目当成不存在（404）——
   * 于是"回收站里点彻底删除"永远是 404，功能根本走不通。
   * 判据要顺着真实流程走：**先进回收站，再彻底删除**。
   */
  it('回收站里的项目可以被彻底删除（先进回收站，再物理删）', async () => {
    const h = await setup();
    const project = await createProject(h);

    // 第一步：进回收站（软删除）
    const soft = await h.app.inject({
      method: 'DELETE',
      url: `${API}/projects/${project.id}`,
      headers: AUTH,
    });
    expect((soft.json() as Envelope<{ hard: boolean }>).data.hard).toBe(false);

    // 第二步：彻底删除 —— 这一步在修 bug 之前会 404
    const hard = await h.app.inject({
      method: 'DELETE',
      url: `${API}/projects/${project.id}?hard=true`,
      headers: AUTH,
    });
    expect(hard.statusCode).toBe(200);
    expect((hard.json() as Envelope<{ hard: boolean }>).data.hard).toBe(true);
    expect(h.conn.sqlite.prepare('SELECT COUNT(*) AS c FROM projects').get()).toEqual({ c: 0 });
  });

  it('彻底删除不存在的项目仍然是 404（不能因为放宽了守卫就静默成功）', async () => {
    const h = await setup();
    const res = await h.app.inject({
      method: 'DELETE',
      url: `${API}/projects/does-not-exist?hard=true`,
      headers: AUTH,
    });
    expect(res.statusCode).toBe(404);
  });

  /**
   * 清空回收站（用户 2026-10-01：「回收站新增一键删除」）。
   *
   * 这条测试的重点**不是"能删掉"**，而是**"不能多删"**：
   * 一个叫"清空回收站"的按钮碰到还活着的项目就是事故，
   * 所以判据必须落在"活着的项目一个都没少"上。
   */
  describe('清空回收站', () => {
    it('一次删光回收站里的项目，但**不碰还活着的项目**', async () => {
      const h = await setup();
      const alive = await createProject(h, '还活着的项目');
      const trashedA = await createProject(h, '要删的 A');
      const trashedB = await createProject(h, '要删的 B');

      // 两条进回收站，一条留在外面
      for (const project of [trashedA, trashedB]) {
        await h.app.inject({
          method: 'DELETE',
          url: `${API}/projects/${project.id}`,
          headers: AUTH,
        });
      }

      const res = await h.app.inject({
        method: 'POST',
        url: `${API}/projects/trash/purge`,
        headers: AUTH,
      });
      expect(res.statusCode).toBe(200);
      const payload = (res.json() as Envelope<{ deleted: number; names: string[] }>).data;
      expect(payload.deleted).toBe(2);
      expect(payload.names.sort()).toEqual(['要删的 A', '要删的 B']);

      // 数据库里只剩那一条活着的
      const rows = h.conn.sqlite.prepare('SELECT id FROM projects').all() as unknown as Array<{
        id: string;
      }>;
      expect(rows.map((row) => row.id)).toEqual([alive.id]);

      // 而且它还能正常读出来（没被顺手改坏）
      const after = await h.app.inject({
        method: 'GET',
        url: `${API}/projects/${alive.id}`,
        headers: AUTH,
      });
      expect(after.statusCode).toBe(200);
    });

    it('回收站本来就空时返回 0，不报错', async () => {
      const h = await setup();
      await createProject(h, '活着的项目');
      const res = await h.app.inject({
        method: 'POST',
        url: `${API}/projects/trash/purge`,
        headers: AUTH,
      });
      expect(res.statusCode).toBe(200);
      expect((res.json() as Envelope<{ deleted: number }>).data.deleted).toBe(0);
      expect(h.conn.sqlite.prepare('SELECT COUNT(*) AS c FROM projects').get()).toEqual({ c: 1 });
    });
  });

  /**
   * 「项目正在运行时不许删除」（用户 2026-10-01 的要求）。
   *
   * 这里直接测那条规则函数，而不是起一个真开发服务器：后者要派生进程、占端口，
   * 单测里既慢又会互相干扰。用桩对象把四种边界一次钉死。
   */
  describe('运行中的项目不许删', () => {
    const state = (status: string) => ({
      projectId: 'p1',
      role: 'frontend' as const,
      kindLabel: 'Vite',
      command: 'pnpm run dev',
      dir: 'D:/tmp',
      port: 5173,
      status: status as never,
      pid: 1,
      startedAt: 1,
      endedAt: null,
      error: null,
      url: null,
      reachable: false,
      log: [],
    });
    const servers = (states: unknown[]) =>
      ({ states: () => states }) as unknown as Parameters<typeof assertProjectNotRunning>[0];

    it('running 时抛 CONFLICT，并且话是给用户看的那句', () => {
      expect(() => assertProjectNotRunning(servers([state('running')]), 'p1')).toThrow(
        /正在运行，请先停止开发服务器再删除/,
      );
    });

    it('starting 也算在跑（已经 spawn 出进程了，删掉会留下没人管的端口占用）', () => {
      expect(() => assertProjectNotRunning(servers([state('starting')]), 'p1')).toThrow(/正在运行/);
    });

    it('stopped / failed 不拦（用户的机器上确实没有运行中的进程）', () => {
      expect(() => assertProjectNotRunning(servers([state('stopped')]), 'p1')).not.toThrow();
      expect(() => assertProjectNotRunning(servers([state('failed')]), 'p1')).not.toThrow();
    });

    it('没有开发服务器实例时不拦（单测/降级场景）', () => {
      expect(() => assertProjectNotRunning(undefined, 'p1')).not.toThrow();
      expect(() => assertProjectNotRunning(servers([]), 'p1')).not.toThrow();
    });
  });

  it('活动流能查到创建记录', async () => {
    const h = await setup();
    const project = await createProject(h);

    const res = await h.app.inject({
      method: 'GET',
      url: `${API}/projects/${project.id}/activity`,
      headers: AUTH,
    });

    const body = res.json() as Envelope<Array<{ action: string; entityType: string }>>;
    expect(body.data[0]?.action).toBe('create');
    expect(body.data[0]?.entityType).toBe('project');
  });
});

describe('工作流状态路由', () => {
  it('新增、改名、改色', async () => {
    const h = await setup();
    const project = await createProject(h);

    const created = await h.app.inject({
      method: 'POST',
      url: `${API}/projects/${project.id}/workflow-statuses`,
      headers: AUTH,
      payload: { name: '待验收', category: 'doing', color: '#123456' },
    });
    expect(created.statusCode).toBe(201);
    const status = (created.json() as Envelope<{ id: string; isDefault: boolean }>).data;
    expect(status.isDefault).toBe(false);

    const updated = await h.app.inject({
      method: 'PATCH',
      url: `${API}/workflow-statuses/${status.id}`,
      headers: AUTH,
      payload: { name: '联调中', isDefault: true },
    });
    const body = updated.json() as Envelope<{ name: string; isDefault: boolean }>;
    expect(body.data.name).toBe('联调中');
    expect(body.data.isDefault).toBe(true);
  });

  it('重排返回新顺序', async () => {
    const h = await setup();
    const project = await createProject(h);
    const listRes = await h.app.inject({
      method: 'GET',
      url: `${API}/projects/${project.id}/workflow-statuses`,
      headers: AUTH,
    });
    const ids = (listRes.json() as Envelope<{ items: Array<{ id: string }> }>).data.items.map(
      (s) => s.id,
    );

    // 把最后一个（已完成）挪到最前面，其余保持相对顺序
    const wanted = [ids.at(-1)!, ...ids.slice(0, -1)];
    const res = await h.app.inject({
      method: 'POST',
      url: `${API}/projects/${project.id}/workflow-statuses/reorder`,
      headers: AUTH,
      payload: { ids: wanted },
    });

    const body = res.json() as Envelope<Array<{ name: string; sortOrder: number }>>;
    expect(body.data.map((s) => s.name)).toEqual([
      '已完成',
      '待完成',
      '正在修改',
      '待审查',
      '审查中',
      '回退修改',
    ]);
    expect(body.data.map((s) => s.sortOrder)).toEqual(wanted.map((_, i) => (i + 1) * 1000));
  });

  it('重排缺少 id 时返回 400（契约明确，不猜）', async () => {
    const h = await setup();
    const project = await createProject(h);
    const listRes = await h.app.inject({
      method: 'GET',
      url: `${API}/projects/${project.id}/workflow-statuses`,
      headers: AUTH,
    });
    const ids = (listRes.json() as Envelope<{ items: Array<{ id: string }> }>).data.items.map(
      (s) => s.id,
    );

    const res = await h.app.inject({
      method: 'POST',
      url: `${API}/projects/${project.id}/workflow-statuses/reorder`,
      headers: AUTH,
      payload: { ids: [ids[0]] },
    });

    expect(res.statusCode).toBe(400);
  });

  it('套用模板回到六个默认状态（自定义的那个被清掉）', async () => {
    const h = await setup();
    const project = await createProject(h);
    await h.app.inject({
      method: 'POST',
      url: `${API}/projects/${project.id}/workflow-statuses`,
      headers: AUTH,
      payload: { name: '多余的状态' },
    });

    const res = await h.app.inject({
      method: 'POST',
      url: `${API}/projects/${project.id}/workflow-statuses/apply-template`,
      headers: AUTH,
      payload: {},
    });

    const body = res.json() as Envelope<Array<{ name: string }>>;
    expect(body.data.map((s) => s.name)).toEqual([
      '待完成',
      '正在修改',
      '待审查',
      '审查中',
      '回退修改',
      '已完成',
    ]);
  });

  it('删除最后一个状态返回 409（不是 500）', async () => {
    const h = await setup();
    const project = await createProject(h);
    const listRes = await h.app.inject({
      method: 'GET',
      url: `${API}/projects/${project.id}/workflow-statuses`,
      headers: AUTH,
    });
    const ids = (listRes.json() as Envelope<{ items: Array<{ id: string }> }>).data.items.map(
      (s) => s.id,
    );

    // 六态流程下要删到只剩一个才触发这条规则（原来三态时删两个就够了）
    for (const id of ids.slice(1)) {
      await h.app.inject({ method: 'DELETE', url: `${API}/workflow-statuses/${id}`, headers: AUTH });
    }
    const last = await h.app.inject({
      method: 'DELETE',
      url: `${API}/workflow-statuses/${ids[0]}`,
      headers: AUTH,
    });

    expect(last.statusCode).toBe(409);
    expect((last.json() as Envelope<unknown>).error?.code).toBe('CONFLICT');
  });
});

describe('标签与里程碑路由', () => {
  it('项目标签：创建、列表、重名冲突', async () => {
    const h = await setup();
    const project = await createProject(h);

    const created = await h.app.inject({
      method: 'POST',
      url: `${API}/projects/${project.id}/tags`,
      headers: AUTH,
      payload: { name: '前端' },
    });
    expect(created.statusCode).toBe(201);

    const dup = await h.app.inject({
      method: 'POST',
      url: `${API}/projects/${project.id}/tags`,
      headers: AUTH,
      payload: { name: '前端' },
    });
    expect(dup.statusCode).toBe(409);
    expect((dup.json() as Envelope<unknown>).error?.code).toBe('CONFLICT');

    const list = await h.app.inject({
      method: 'GET',
      url: `${API}/projects/${project.id}/tags`,
      headers: AUTH,
    });
    expect((list.json() as Envelope<unknown[]>).data).toHaveLength(1);
  });

  /**
   * 0.2.0：`POST /tags`（建"全局标签"）这个入口已经删掉（迁移 0006 + 决策记录 #27）。
   *
   * 这条**替代**了原来的「全局标签与删除」——那条依赖 `POST /tags` 与
   * `projectId === null` 这两个概念，而它们都不存在了。现在要证的是**反过来的事**：
   * 标签必须挂在项目下、按 id 的查/删仍然可用。
   */
  it('标签只能建在项目下，按 id 查与删照旧', async () => {
    const h = await setup();
    const project = await createProject(h);

    // 老的全局入口必须已经不存在（404 而不是"还能建全局标签"）
    const gone = await h.app.inject({
      method: 'POST',
      url: `${API}/tags`,
      headers: AUTH,
      payload: { name: '全局标签' },
    });
    expect(gone.statusCode).toBe(404);

    const created = await h.app.inject({
      method: 'POST',
      url: `${API}/projects/${project.id}/tags`,
      headers: AUTH,
      payload: { name: '项目标签' },
    });
    const tag = (created.json() as Envelope<{ id: string; projectId: string }>).data;
    expect(tag.projectId).toBe(project.id);

    const detail = await h.app.inject({ method: 'GET', url: `${API}/tags/${tag.id}`, headers: AUTH });
    expect((detail.json() as Envelope<{ usageCount: number }>).data.usageCount).toBe(0);

    const del = await h.app.inject({ method: 'DELETE', url: `${API}/tags/${tag.id}`, headers: AUTH });
    expect(del.statusCode).toBe(200);
  });

  it('里程碑：创建、达成、撤销、删除', async () => {
    const h = await setup();
    const project = await createProject(h);

    const created = await h.app.inject({
      method: 'POST',
      url: `${API}/projects/${project.id}/milestones`,
      headers: AUTH,
      payload: { name: 'v1.0 发布', dueDate: 1_800_000_000_000 },
    });
    const milestone = (created.json() as Envelope<{ id: string }>).data;

    const reached = await h.app.inject({
      method: 'POST',
      url: `${API}/milestones/${milestone.id}/reach`,
      headers: AUTH,
      payload: {},
    });
    expect(
      (reached.json() as Envelope<{ reachedAt: number | null }>).data.reachedAt,
    ).toBeGreaterThan(0);

    const undone = await h.app.inject({
      method: 'POST',
      url: `${API}/milestones/${milestone.id}/reach`,
      headers: AUTH,
      payload: { reachedAt: null },
    });
    expect((undone.json() as Envelope<{ reachedAt: number | null }>).data.reachedAt).toBeNull();

    const list = await h.app.inject({
      method: 'GET',
      url: `${API}/projects/${project.id}/milestones`,
      headers: AUTH,
    });
    expect((list.json() as Envelope<unknown[]>).data).toHaveLength(1);

    const del = await h.app.inject({
      method: 'DELETE',
      url: `${API}/milestones/${milestone.id}`,
      headers: AUTH,
    });
    expect(del.statusCode).toBe(200);
  });
});

describe('业务路由的鉴权与可观测性', () => {
  it('业务接口同样要求令牌', async () => {
    const h = await setup();
    const res = await h.app.inject({ method: 'GET', url: `${API}/projects` });
    expect(res.statusCode).toBe(401);
  });

  it('业务错误也带 traceId，且能按该 traceId 查到日志现场', async () => {
    const h = await setup();
    const res = await h.app.inject({
      method: 'GET',
      url: `${API}/projects/missing-id`,
      headers: AUTH,
    });

    const traceId = String(res.headers['x-trace-id']);
    const body = res.json() as Envelope<unknown>;
    expect(body.error?.traceId).toBe(traceId);

    const contextRes = await h.app.inject({
      method: 'GET',
      url: `${API}/logs/context/${traceId}`,
      headers: AUTH,
    });
    expect(contextRes.statusCode).toBe(200);
    const context = contextRes.json() as Envelope<{ total: number }>;
    expect(context.data.total).toBeGreaterThan(0);
  });
});
