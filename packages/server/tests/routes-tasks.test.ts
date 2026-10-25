/**
 * 任务删除规则在 **HTTP 层** 的测试。
 *
 * 为什么单测不够：服务端的拒绝逻辑写在 `softDeleteTask` 里，但真正拦住用户的是
 * "路由有没有把异常转成 409、有没有把子任务数量放进响应"。只在 service 层测，
 * 是测不到"界面拿到的是不是一句能看懂的话"的。批量那条同理 ——
 * 它走的是 `batchTasks`，跟单条删除不是同一个入口。
 */

import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';

import { createApp } from '../src/app';
import { defaultServerConfig } from '../src/config';
import { DbConnection } from '../src/db/connection';
import { createLogger } from '../src/logging/logger';
import { createLogStore, type LogStore } from '../src/logging/store';
import { createServiceContext } from '../src/services/context';

const TOKEN = 'routes-tasks-token-123456';
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

async function createProject(h: Harness): Promise<string> {
  const res = await h.app.inject({
    method: 'POST',
    url: `${API}/projects`,
    headers: AUTH,
    payload: { name: '任务路由测试' },
  });
  return (res.json() as Envelope<{ id: string }>).data.id;
}

async function createTask(
  h: Harness,
  projectId: string,
  title: string,
  parentId?: string,
): Promise<string> {
  const res = await h.app.inject({
    method: 'POST',
    url: `${API}/tasks`,
    headers: AUTH,
    payload: { projectId, title, ...(parentId ? { parentId } : {}) },
  });
  expect(res.statusCode).toBe(201);
  return (res.json() as Envelope<{ id: string }>).data.id;
}

async function taskTotal(h: Harness, projectId: string): Promise<number> {
  const res = await h.app.inject({
    method: 'GET',
    url: `${API}/projects/${projectId}/tasks`,
    headers: AUTH,
  });
  return (res.json() as Envelope<{ total: number }>).data.total;
}

function deleteTask(h: Harness, id: string, cascade = false) {
  return h.app.inject({
    method: 'DELETE',
    url: `${API}/tasks/${encodeURIComponent(id)}${cascade ? '?cascade=true' : ''}`,
    headers: AUTH,
  });
}

describe('任务删除路由', () => {
  it('有子任务的主任务返回 409，并把子任务数量带回去', async () => {
    const h = await setup();
    const projectId = await createProject(h);
    const parent = await createTask(h, projectId, '主任务');
    await createTask(h, projectId, '子任务 A', parent);
    await createTask(h, projectId, '子任务 B', parent);

    const res = await deleteTask(h, parent);
    const body = res.json() as Envelope<null>;

    expect(res.statusCode).toBe(409);
    expect(body.ok).toBe(false);
    expect(body.error?.code).toBe('CONFLICT');
    // 这句话是给用户看的，所以要断言它真的说了"有几个子任务"
    expect(body.error?.message).toContain('还有 2 个子任务');
    expect(body.error?.message).toContain('无法删除');
    expect((body.error?.details as { childCount?: number })?.childCount).toBe(2);
    // 报错就该什么都没发生
    expect(await taskTotal(h, projectId)).toBe(3);
  });

  it('没有子任务的任务删除成功', async () => {
    const h = await setup();
    const projectId = await createProject(h);
    const lone = await createTask(h, projectId, '独立任务');

    const res = await deleteTask(h, lone);

    expect(res.statusCode).toBe(200);
    expect((res.json() as Envelope<{ deleted: number }>).data.deleted).toBe(1);
    expect(await taskTotal(h, projectId)).toBe(0);
  });

  it('cascade=true 仍然整枝删除（这条能力刻意保留不变）', async () => {
    const h = await setup();
    const projectId = await createProject(h);
    const root = await createTask(h, projectId, '一级');
    const mid = await createTask(h, projectId, '二级', root);
    await createTask(h, projectId, '三级', mid);

    const res = await deleteTask(h, root, true);

    expect(res.statusCode).toBe(200);
    expect((res.json() as Envelope<{ deleted: number }>).data.deleted).toBe(3);
    expect(await taskTotal(h, projectId)).toBe(0);
  });

  it('批量删除跳过主任务，并在响应里上报被跳过的项', async () => {
    const h = await setup();
    const projectId = await createProject(h);
    const parent = await createTask(h, projectId, '主任务');
    await createTask(h, projectId, '子任务', parent);
    const lone = await createTask(h, projectId, '独立任务');

    const res = await h.app.inject({
      method: 'POST',
      url: `${API}/tasks/batch`,
      headers: AUTH,
      payload: { ids: [parent, lone], action: 'delete' },
    });
    const body = res.json() as Envelope<{
      affected: number;
      skipped: Array<{ id: string; title: string; reason: string; childCount: number }>;
    }>;

    expect(res.statusCode).toBe(200);
    expect(body.data.affected).toBe(1);
    expect(body.data.skipped).toHaveLength(1);
    expect(body.data.skipped[0]).toMatchObject({
      id: parent,
      title: '主任务',
      reason: 'has_children',
      childCount: 1,
    });
    // 主任务与子任务都还在
    expect(await taskTotal(h, projectId)).toBe(2);
  });
});

/**
 * 提交审核路由（用户 2026-10-02：任务详情右下角那个按钮）。
 *
 * 为什么要在 HTTP 层测："落到哪个状态"是服务端按**名字**找出来的，
 * 界面完全不知道那个状态叫什么。这条链路一旦断了，界面上表现为
 * "点了没反应"，而不是某个明显的报错 —— 所以断言落在响应的状态名上。
 */
describe('提交审核路由', () => {
  it('把任务推进到「待审查」，响应里带回新状态', async () => {
    const h = await setup();
    const projectId = await createProject(h);
    const taskId = await createTask(h, projectId, '等评审的任务');

    const res = await h.app.inject({
      method: 'POST',
      url: `${API}/tasks/${encodeURIComponent(taskId)}/submit-review`,
      headers: AUTH,
      payload: {},
    });
    const body = res.json() as Envelope<{ statusId: string; statusCategory: string }>;

    expect(res.statusCode).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.data.statusCategory).toBe('doing');

    const statusRes = await h.app.inject({
      method: 'GET',
      url: `${API}/projects/${projectId}/workflow-statuses`,
      headers: AUTH,
    });
    const statuses = (statusRes.json() as Envelope<{ items: Array<{ id: string; name: string }> }>)
      .data.items;
    const review = statuses.find((status) => status.name === '待审查');
    expect(review, '六态里应当有「待审查」').toBeTruthy();
    expect(body.data.statusId).toBe(review?.id);
  });

  it('工作流里没有「待审查」时返回可读的 400（不是 500）', async () => {
    const h = await setup();
    const projectId = await createProject(h);
    const taskId = await createTask(h, projectId, '没有审核状态的任务');

    const statusRes = await h.app.inject({
      method: 'GET',
      url: `${API}/projects/${projectId}/workflow-statuses`,
      headers: AUTH,
    });
    const review = (
      statusRes.json() as Envelope<{ items: Array<{ id: string; name: string }> }>
    ).data.items.find((status) => status.name === '待审查')!;
    await h.app.inject({
      method: 'DELETE',
      url: `${API}/workflow-statuses/${review.id}`,
      headers: AUTH,
    });

    const res = await h.app.inject({
      method: 'POST',
      url: `${API}/tasks/${encodeURIComponent(taskId)}/submit-review`,
      headers: AUTH,
      payload: {},
    });
    const body = res.json() as Envelope<null>;

    expect(res.statusCode).toBe(400);
    expect(body.error?.code).toBe('VALIDATION_FAILED');
    expect(body.error?.message).toContain('待审查');
  });
});
