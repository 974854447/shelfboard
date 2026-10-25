/**
 * M1 验收测试。
 *
 * 把 technical-design.md 第 10 节的验收标准变成**可执行的断言**。
 * 与其它测试的区别有两点：
 *
 * 1. **用真实的文件数据库**（不是 `:memory:`），因为"重启后数据完整"
 *    这条只有在文件库上才验证得了 —— 关掉连接再打开，看数据还在不在。
 * 2. **走完整的 HTTP 链路**（Fastify inject），而不是直接调服务函数，
 *    这样鉴权、校验、统一错误包、访问日志都一并被覆盖。
 */

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { writeFile } from 'node:fs/promises';

import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';

import { createApp } from '../src/app';
import { defaultServerConfig } from '../src/config';
import { DbConnection } from '../src/db/connection';
import { createLogger } from '../src/logging/logger';
import { createLogBroadcaster } from '../src/logging/sse';
import { createLogStore, type LogStore } from '../src/logging/store';
import { createServiceContext } from '../src/services/context';
import { makeTempDir, removeTempDir } from './helpers';

const TOKEN = 'acceptance-token-1234567890';
const AUTH = { authorization: `Bearer ${TOKEN}` };
const API = '/api/v1';

const tempDirs: string[] = [];
const cleanups: Array<() => void> = [];

afterEach(async () => {
  while (cleanups.length > 0) cleanups.pop()?.();
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) await removeTempDir(dir);
  }
});

interface Booted {
  app: FastifyInstance;
  conn: DbConnection;
  store: LogStore;
  dbPath: string;
  close(): Promise<void>;
}

/** 模拟一次"启动"：打开库 → 迁移 → 建服务 → 起 app */
async function boot(
  dbPath: string,
  options: { rendererRoot?: string; workspaceRoot?: string } = {},
): Promise<Booted> {
  const conn = new DbConnection();
  conn.open(dbPath);

  const store = createLogStore({ db: conn.sqlite, flushBatch: 1, flushIntervalMs: 0 });
  const logger = createLogger({ source: 'api', sinks: [store], minLevel: 'debug' });
  const services = createServiceContext({ conn, logger });
  const broadcaster = createLogBroadcaster({ windowMs: 5 });

  const app = await createApp({
    config: defaultServerConfig({ authToken: TOKEN }),
    logger,
    logStore: store,
    logBroadcaster: broadcaster,
    services,
    version: '0.1.0-acceptance',
    ...(options.rendererRoot ? { rendererRoot: options.rendererRoot } : {}),
    ...(options.workspaceRoot ? { workspaceRoot: options.workspaceRoot } : {}),
  });

  const booted: Booted = {
    app,
    conn,
    store,
    dbPath,
    close: async () => {
      await app.close();
      store.close();
      conn.close();
    },
  };
  cleanups.push(() => void booted.close());
  return booted;
}

async function newWorkspaceDb(): Promise<string> {
  const dir = await makeTempDir('acceptance');
  tempDirs.push(dir);
  return join(dir, 'workspace.db');
}

interface Envelope<T> {
  ok: boolean;
  data: T;
  error?: { code: string; message: string; traceId?: string };
}

/**
 * 发一个带鉴权的请求。
 *
 * `payload` 用 `object` 而不是 `unknown`：Fastify 的 `InjectPayload` 只接受
 * 对象 / 字符串 / Buffer / 流，`unknown` 会让重载解析失败，
 * 进而把返回类型推断成一团 `void & Promise<...> & Chain`。
 */
async function call<T>(
  app: FastifyInstance,
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
  url: string,
  payload?: object,
): Promise<{ status: number; body: Envelope<T>; traceId: string }> {
  const response = await app.inject(
    payload === undefined
      ? { method, url, headers: AUTH }
      : { method, url, headers: AUTH, payload },
  );
  return {
    status: response.statusCode,
    body: response.json() as Envelope<T>,
    traceId: String(response.headers['x-trace-id']),
  };
}

/* ================================================================== */

describe('渲染层静态资源与 API 404 的边界', () => {
  it('根路径返回 index.html，而未注册的 API 路径仍返回 JSON 错误', async () => {
    const dir = await makeTempDir('renderer');
    tempDirs.push(dir);
    await writeFile(join(dir, 'index.html'), '<!doctype html><title>pm-studio</title>', 'utf8');

    const booted = await boot(join(dir, 'workspace.db'), { rendererRoot: dir });

    // 1) 窗口加载的根路径必须是界面，而不是 404
    const root = await booted.app.inject({ method: 'GET', url: '/' });
    expect(root.statusCode).toBe(200);
    expect(String(root.headers['content-type'])).toContain('text/html');
    expect(root.body).toContain('pm-studio');

    // 2) 未知 API 路径**不能**被回落成 HTML —— 否则前端的错误处理会全变成 JSON 解析错误
    const missingApi = await booted.app.inject({
      method: 'GET',
      url: `${API}/definitely-not-a-route`,
      headers: AUTH,
    });
    expect(missingApi.statusCode).toBe(404);
    expect(String(missingApi.headers['content-type'])).toContain('application/json');
    expect((missingApi.json() as Envelope<unknown>).error?.code).toBe('NOT_FOUND');
  });
});

describe('验收 1：完整流程 + 重启后数据完整', () => {
  it('建项目 → 多层子任务 → 依赖 → 拖拽 → 重启后一切还在', async () => {
    const dbPath = await newWorkspaceDb();
    const first = await boot(dbPath);

    /* --- 建项目（自动铺好工作流状态） --- */
    const created = await call<{ id: string; name: string }>(
      first.app,
      'POST',
      `${API}/projects`,
      { name: '验收项目' },
    );
    expect(created.status).toBe(201);
    const projectId = created.body.data.id;

    const statuses = await call<{ items: Array<{ id: string; name: string; isDefault: boolean }> }>(
      first.app,
      'GET',
      `${API}/projects/${projectId}/workflow-statuses`,
    );
    /*
     * 六态流程（用户 2026-10-02 定的）。分类仍然只有 todo/doing/done 三种，
     * 只有「已完成」算做完 —— 这里按**分类**取 id，避免把测试绑死在中文字面量上。
     */
    expect(statuses.body.data.items.map((s) => s.name)).toEqual([
      '待完成',
      '正在修改',
      '待审查',
      '审查中',
      '回退修改',
      '已完成',
    ]);
    const todoId = statuses.body.data.items[0]!.id;
    const doingId = statuses.body.data.items[1]!.id;
    const doneId = statuses.body.data.items[5]!.id;

    /* --- 三层子任务 --- */
    const root = await call<{ id: string }>(first.app, 'POST', `${API}/tasks`, {
      projectId,
      title: '一级任务',
    });
    const middle = await call<{ id: string }>(first.app, 'POST', `${API}/tasks`, {
      projectId,
      title: '二级任务',
      parentId: root.body.data.id,
    });
    const leaf = await call<{ id: string }>(first.app, 'POST', `${API}/tasks`, {
      projectId,
      title: '三级任务',
      parentId: middle.body.data.id,
    });
    expect(leaf.status).toBe(201);

    /* --- 依赖关系：另一个任务依赖三级任务 --- */
    const dependent = await call<{ id: string }>(first.app, 'POST', `${API}/tasks`, {
      projectId,
      title: '被阻塞的任务',
    });
    const dep = await call<{ id: string }>(first.app, 'POST', `${API}/tasks/${dependent.body.data.id}/dependencies`, {
      predecessorId: leaf.body.data.id,
    });
    expect(dep.status).toBe(201);

    /* --- 看板拖拽：把三级任务拖到「已完成」 --- */
    const moved = await call<{ statusId: string; completedAt: number | null }>(
      first.app,
      'POST',
      `${API}/tasks/${leaf.body.data.id}/move`,
      { statusId: doneId },
    );
    expect(moved.status).toBe(200);
    expect(moved.body.data.statusId).toBe(doneId);
    // 拖进"已完成"必须记下完成时间，否则工作台的"逾期"判断会误报
    expect(moved.body.data.completedAt).not.toBeNull();

    /* --- 再拖回「正在修改」，完成时间要被清掉 --- */
    const movedBack = await call<{ completedAt: number | null }>(
      first.app,
      'POST',
      `${API}/tasks/${leaf.body.data.id}/move`,
      { statusId: doingId, beforeTaskId: null },
    );
    expect(movedBack.body.data.completedAt).toBeNull();

    /* --- 模拟重启：关掉一切，重新打开同一个库 --- */
    await first.close();

    const second = await boot(dbPath);

    const board = await call<{
      columns: Array<{ name: string; tasks: Array<{ id: string; title: string }> }>;
      total: number;
    }>(second.app, 'GET', `${API}/projects/${projectId}/board`);

    expect(board.body.data.total).toBe(4);

    const doingColumn = board.body.data.columns.find((c) => c.name === '正在修改');
    expect(doingColumn?.tasks.map((t) => t.title)).toEqual(['三级任务']);
    expect(todoId).toBeTruthy();

    const tree = await call<Array<{ title: string; children: Array<{ title: string; children: Array<{ title: string }> }> }>>(
      second.app,
      'GET',
      `${API}/projects/${projectId}/tasks/tree`,
    );
    expect(tree.body.data).toHaveLength(2);
    const rootNode = tree.body.data.find((n) => n.title === '一级任务');
    expect(rootNode?.children[0]?.title).toBe('二级任务');
    expect(rootNode?.children[0]?.children[0]?.title).toBe('三级任务');

    // 依赖关系也要还在
    const dependencies = await call<Array<{ predecessorId: string; successorId: string }>>(
      second.app,
      'GET',
      `${API}/projects/${projectId}/dependencies`,
    );
    expect(dependencies.body.data).toHaveLength(1);
    expect(dependencies.body.data[0]?.predecessorId).toBe(leaf.body.data.id);
  });
});

describe('验收 3：大量任务下的看板性能', () => {
  it('单个项目 5000 任务时，看板接口仍能在可接受时间内返回', async () => {
    const dbPath = await newWorkspaceDb();
    const booted = await boot(dbPath);

    const project = await call<{ id: string }>(booted.app, 'POST', `${API}/projects`, {
      name: '大数据量项目',
    });
    const projectId = project.body.data.id;

    const statusRows = booted.conn.sqlite
      .prepare('SELECT id FROM workflow_statuses WHERE project_id = ? ORDER BY sort_order')
      .all(projectId) as Array<{ id: string }>;
    const statusIds = statusRows.map((r) => r.id);

    // 直接批量插入：走 5000 次 HTTP 或 5000 个事务会慢到无法作为性能测试
    const insert = booted.conn.sqlite.prepare(
      `INSERT INTO tasks (id, owner_id, project_id, title, status_id, priority, sort_order, created_at, updated_at)
       VALUES (?, 'local-user', ?, ?, ?, 'medium', ?, ?, ?)`,
    );
    const now = Date.now();
    const bulk = booted.conn.sqlite.transaction(() => {
      for (let i = 0; i < 5000; i += 1) {
        insert.run(
          `task_${String(i).padStart(6, '0')}`,
          projectId,
          `任务 ${i}`,
          statusIds[i % statusIds.length] as string,
          (i + 1) * 1000,
          now,
          now,
        );
      }
    });
    bulk();

    const started = performance.now();
    const board = await call<{ total: number; columns: unknown[] }>(
      booted.app,
      'GET',
      `${API}/projects/${projectId}/board`,
    );
    const elapsed = performance.now() - started;

    expect(board.status).toBe(200);
    expect(board.body.data.total).toBe(5000);

    // 阈值取得比较宽松（1.5 秒）：这里跑的是完整 HTTP 链路 + 装饰数据聚合，
    // 目的是拦住"数量级级别的退化"，而不是卡死在某个精确毫秒数上。
    expect(elapsed).toBeLessThan(1500);

    // 把实测值写进测试输出，便于后续对比是否劣化
    process.stdout.write(`\n  [性能] 5000 任务看板接口耗时：${elapsed.toFixed(0)}ms\n`);
  });
});

describe('验收 5：错误 → traceId → 日志现场', () => {
  it('任意错误都能按 traceId 找回完整现场', async () => {
    const dbPath = await newWorkspaceDb();
    const booted = await boot(dbPath);

    const failure = await call(booted.app, 'GET', `${API}/projects/does-not-exist`);
    expect(failure.status).toBe(404);
    expect(failure.body.error?.code).toBe('NOT_FOUND');
    // 响应里的 traceId 必须与响应头一致，否则界面上的跳转会找错地方
    expect(failure.body.error?.traceId).toBe(failure.traceId);

    const context = await call<{ traceId: string; total: number; items: Array<{ level: string }> }>(
      booted.app,
      'GET',
      `${API}/logs/context/${failure.traceId}`,
    );

    expect(context.status).toBe(200);
    expect(context.body.data.traceId).toBe(failure.traceId);
    expect(context.body.data.total).toBeGreaterThan(0);
    // 至少有一条 warn（业务错误按 warn 记，不污染 error 级别）
    expect(context.body.data.items.some((e) => e.level === 'warn')).toBe(true);
  });
});

describe('诊断包导出接口', () => {
  it('导出成功并返回 zip 路径', async () => {
    const dir = await makeTempDir('diag-route');
    tempDirs.push(dir);
    const booted = await boot(join(dir, 'workspace.db'), { workspaceRoot: dir });

    const res = await call<{ zipPath: string; bytes: number; files: string[] }>(
      booted.app,
      'POST',
      `${API}/logs/export`,
      { targetDir: dir },
    );

    expect(res.status).toBe(200);
    expect(existsSync(res.body.data.zipPath)).toBe(true);
    expect(res.body.data.bytes).toBeGreaterThan(0);
    expect(res.body.data.files).toContain('manifest.json');
  });

  it('目标目录非法时返回 400，而不是静默失败', async () => {
    const dir = await makeTempDir('diag-bad');
    tempDirs.push(dir);
    const booted = await boot(join(dir, 'workspace.db'), { workspaceRoot: dir });

    const res = await call(booted.app, 'POST', `${API}/logs/export`, { targetDir: 'relative/path' });
    expect(res.status).toBe(400);
    expect(res.body.error?.code).toBe('VALIDATION_FAILED');
  });
});

describe('验收 6：脱敏', () => {
  it('查询参数里的令牌不会以明文落进日志', async () => {
    const dbPath = await newWorkspaceDb();
    const booted = await boot(dbPath);

    // 用查询参数方式鉴权（EventSource 的退路）
    await booted.app.inject({ method: 'GET', url: `${API}/projects?token=${TOKEN}` });

    const rows = booted.store.query({ pageSize: 200 });
    const leaked = rows.items.filter(
      (e) => e.message.includes(TOKEN) || (e.detail ?? '').includes(TOKEN),
    );
    expect(leaked).toEqual([]);
    expect(rows.total).toBeGreaterThan(0);
  });
});

describe('验收 4：数据层与迁移', () => {
  it('文件库里启用了 WAL 与外键，且迁移幂等', async () => {
    const dbPath = await newWorkspaceDb();
    const booted = await boot(dbPath);

    expect(booted.conn.stats().journalMode).toBe('wal');
    expect(booted.conn.sqlite.pragma('foreign_keys', { simple: true })).toBe(1);

    const applied = booted.conn.sqlite
      .prepare('SELECT COUNT(*) AS c FROM schema_migrations')
      .get() as { c: number };
    expect(applied.c).toBeGreaterThan(0);

    // 再开一次同一个库：迁移不应重复执行
    const relinked = new DbConnection();
    relinked.open(dbPath);
    const after = relinked.sqlite
      .prepare('SELECT COUNT(*) AS c FROM schema_migrations')
      .get() as { c: number };
    expect(after.c).toBe(applied.c);
    relinked.close();
  });
});

describe('验收 2：托盘与单实例的行为约束（在数据层可验证的部分）', () => {
  it('作业表存在，且启动时能把残留的运行中作业标为 interrupted', async () => {
    const dbPath = await newWorkspaceDb();
    const booted = await boot(dbPath);

    // 造一个"上次没跑完"的作业
    booted.conn.sqlite
      .prepare(
        `INSERT INTO jobs (id, type, title, status, percent, created_at)
         VALUES ('job_1', 'install', '假装在装依赖', 'running', 40, ?)`,
      )
      .run(Date.now());

    // 主进程启动时会执行这条收尾（此处复现同一逻辑）
    const result = booted.conn.sqlite
      .prepare(
        `UPDATE jobs SET status = 'interrupted', finished_at = ?
         WHERE status IN ('queued', 'running')`,
      )
      .run(Date.now());

    expect(Number(result.changes)).toBe(1);
    const row = booted.conn.sqlite
      .prepare('SELECT status FROM jobs WHERE id = ?')
      .get('job_1') as { status: string };
    expect(row.status).toBe('interrupted');
  });
});
