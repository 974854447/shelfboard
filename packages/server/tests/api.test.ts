import Database from 'better-sqlite3';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';

import { createApp } from '../src/app';
import { defaultServerConfig } from '../src/config';
import type { Logger } from '../src/logging/logger';
import { createLogger } from '../src/logging/logger';
import { createLogBroadcaster, type LogBroadcaster } from '../src/logging/sse';
import { createLogStore, type LogStore } from '../src/logging/store';
import { makeLogEntry, withTimeout } from './helpers';

const TOKEN = 'test-token-abcdefghijklmnop';
const AUTH = { authorization: `Bearer ${TOKEN}` };

interface Harness {
  app: FastifyInstance;
  store: LogStore;
  broadcaster: LogBroadcaster;
  logger: Logger;
  db: Database.Database;
}

const harnesses: Harness[] = [];

async function setup(options: { allowedOrigins?: string[] } = {}): Promise<Harness> {
  const db = new Database(':memory:');
  const broadcaster = createLogBroadcaster({ windowMs: 5 });
  // flushBatch=1 → 每条立即落库，便于用接口断言访问日志
  const store = createLogStore({ db, flushBatch: 1, flushIntervalMs: 0 });
  const logger = createLogger({ source: 'api', sinks: [store, broadcaster], minLevel: 'debug' });

  const app = await createApp({
    config: defaultServerConfig({
      authToken: TOKEN,
      allowedOrigins: options.allowedOrigins ?? [],
      slowRequestMs: 10_000,
    }),
    logger,
    logStore: store,
    logBroadcaster: broadcaster,
    version: '0.1.0-test',
  });

  const harness: Harness = { app, store, broadcaster, logger, db };
  harnesses.push(harness);
  return harness;
}

afterEach(async () => {
  while (harnesses.length > 0) {
    const h = harnesses.pop();
    if (!h) continue;
    await h.app.close();
    h.store.close();
    h.db.close();
  }
});

describe('健康检查', () => {
  it('无需令牌即可访问，且回写 x-trace-id', async () => {
    const h = await setup();
    const res = await h.app.inject({ method: 'GET', url: '/health' });

    expect(res.statusCode).toBe(200);
    const body = res.json() as { ok: boolean; data: { status: string; version: string } };
    expect(body.ok).toBe(true);
    expect(body.data.status).toBe('ok');
    expect(body.data.version).toBe('0.1.0-test');
    expect(res.headers['x-trace-id']).toBeTruthy();
  });
});

describe('鉴权', () => {
  it('缺少令牌 → 401，且响应体是统一错误包并带 traceId', async () => {
    const h = await setup();
    const res = await h.app.inject({ method: 'GET', url: '/api/v1/logs' });

    expect(res.statusCode).toBe(401);
    const body = res.json() as { ok: boolean; error: { code: string; traceId: string } };
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe('UNAUTHORIZED');
    expect(body.error.traceId).toBe(res.headers['x-trace-id']);
  });

  it('令牌错误 → 401', async () => {
    const h = await setup();
    const res = await h.app.inject({
      method: 'GET',
      url: '/api/v1/logs',
      headers: { authorization: 'Bearer wrong-token-here' },
    });
    expect(res.statusCode).toBe(401);
  });

  it('非 Bearer 方案不被接受', async () => {
    const h = await setup();
    const res = await h.app.inject({
      method: 'GET',
      url: '/api/v1/logs',
      headers: { authorization: `Basic ${Buffer.from(TOKEN).toString('base64')}` },
    });
    expect(res.statusCode).toBe(401);
  });

  it('正确令牌 → 200', async () => {
    const h = await setup();
    const res = await h.app.inject({ method: 'GET', url: '/api/v1/logs', headers: AUTH });
    expect(res.statusCode).toBe(200);
  });

  it('查询参数令牌可用（EventSource 无法带请求头的退路）', async () => {
    const h = await setup();
    const res = await h.app.inject({ method: 'GET', url: `/api/v1/logs?token=${TOKEN}` });
    expect(res.statusCode).toBe(200);
  });

  it('鉴权失败会被记进日志，且能用响应里的 traceId 查到现场', async () => {
    const h = await setup();
    const res = await h.app.inject({ method: 'GET', url: '/api/v1/logs' });
    const traceId = String(res.headers['x-trace-id']);

    const found = h.store.query({ traceId });
    expect(found.total).toBeGreaterThan(0);
    expect(found.items.every((e) => e.traceId === traceId)).toBe(true);
    expect(found.items.some((e) => e.level === 'warn')).toBe(true);
  });

  it('查询参数里的令牌不会以明文进入日志（脱敏管道的实际验证）', async () => {
    const h = await setup();
    await h.app.inject({ method: 'GET', url: `/api/v1/logs?token=${TOKEN}` });

    const all = h.store.query({ pageSize: 200 });
    const leaked = all.items.filter(
      (e) => e.message.includes(TOKEN) || (e.detail ?? '').includes(TOKEN),
    );
    expect(leaked).toEqual([]);
  });
});

describe('traceId 贯通', () => {
  it('合法的入站 traceId 被沿用', async () => {
    const h = await setup();
    const traceId = 'tr_inbound_0123456789';
    const res = await h.app.inject({
      method: 'GET',
      url: '/api/v1/logs',
      headers: { ...AUTH, 'x-trace-id': traceId },
    });

    expect(res.headers['x-trace-id']).toBe(traceId);
    expect(h.store.query({ traceId }).total).toBeGreaterThan(0);
  });

  it('非法的入站 traceId 被丢弃并重新生成（防伪造与注入）', async () => {
    const h = await setup();
    const bogus = 'tr_bogus\n[error] 伪造的日志行';
    const res = await h.app.inject({
      method: 'GET',
      url: '/api/v1/logs',
      headers: { ...AUTH, 'x-trace-id': bogus },
    });

    const used = String(res.headers['x-trace-id']);
    expect(used).not.toBe(bogus);
    expect(used).toMatch(/^tr_[0-9a-z]+_[0-9a-f]{10}$/);
  });

  it('每个请求的 traceId 互不相同', async () => {
    const h = await setup();
    const a = await h.app.inject({ method: 'GET', url: '/health' });
    const b = await h.app.inject({ method: 'GET', url: '/health' });
    expect(a.headers['x-trace-id']).not.toBe(b.headers['x-trace-id']);
  });
});

describe('统一响应包与错误处理', () => {
  it('未知路由 → 404 且是统一错误包', async () => {
    const h = await setup();
    const res = await h.app.inject({ method: 'GET', url: '/api/v1/nope', headers: AUTH });

    expect(res.statusCode).toBe(404);
    const body = res.json() as { ok: boolean; error: { code: string } };
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe('NOT_FOUND');
  });

  it('参数校验失败 → 400 VALIDATION_FAILED 且带字段级 details', async () => {
    const h = await setup();
    const res = await h.app.inject({
      method: 'GET',
      url: '/api/v1/logs?pageSize=abc',
      headers: AUTH,
    });

    expect(res.statusCode).toBe(400);
    const body = res.json() as {
      ok: boolean;
      error: { code: string; details: Array<{ path: string; message: string }> };
    };
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe('VALIDATION_FAILED');
    expect(Array.isArray(body.error.details)).toBe(true);
    expect(body.error.details.length).toBeGreaterThan(0);
  });

  it('默认不回传堆栈（但内部仍有 detail 落日志）', async () => {
    const h = await setup();
    // 触发一个 4xx：超范围的分页参数
    const res = await h.app.inject({
      method: 'GET',
      url: '/api/v1/logs?pageSize=99999',
      headers: AUTH,
    });
    const raw = res.body;
    expect(raw).not.toContain('at Object.');
    expect(raw).not.toContain('node_modules');
  });
});

describe('CORS', () => {
  it('允许的来源会拿到 CORS 头', async () => {
    const h = await setup({ allowedOrigins: ['http://localhost:5173'] });
    const res = await h.app.inject({
      method: 'GET',
      url: '/health',
      headers: { origin: 'http://localhost:5173' },
    });

    expect(res.headers['access-control-allow-origin']).toBe('http://localhost:5173');
    expect(String(res.headers['access-control-allow-headers'])).toContain('authorization');
  });

  it('白名单之外的来源拿不到 CORS 头（由浏览器拦截）', async () => {
    const h = await setup({ allowedOrigins: ['http://localhost:5173'] });
    const res = await h.app.inject({
      method: 'GET',
      url: '/health',
      headers: { origin: 'http://evil.example.com' },
    });

    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('预检请求返回 204 且不要求令牌', async () => {
    const h = await setup({ allowedOrigins: ['http://localhost:5173'] });
    const res = await h.app.inject({
      method: 'OPTIONS',
      url: '/api/v1/logs',
      headers: { origin: 'http://localhost:5173' },
    });

    expect(res.statusCode).toBe(204);
  });
});

describe('日志接口', () => {
  function seed(h: Harness): void {
    h.store.write(
      makeLogEntry({ level: 'error', source: 'job', message: '安装依赖失败', ts: 5000, traceId: 'tr_a_0123456789', jobId: '01JOB' }),
    );
    h.store.write(makeLogEntry({ level: 'info', source: 'main', message: '应用启动', ts: 3000 }));
    h.store.write(makeLogEntry({ level: 'warn', source: 'api', message: '慢请求', ts: 4000 }));
  }

  it('查询返回统一包与分页信息', async () => {
    const h = await setup();
    seed(h);
    const res = await h.app.inject({ method: 'GET', url: '/api/v1/logs?pageSize=2', headers: AUTH });

    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      ok: boolean;
      data: { items: unknown[]; total: number; page: number; pageSize: number };
    };
    expect(body.data.total).toBe(3);
    expect(body.data.items).toHaveLength(2);
    expect(body.data.pageSize).toBe(2);
  });

  it('按级别过滤', async () => {
    const h = await setup();
    seed(h);
    const res = await h.app.inject({ method: 'GET', url: '/api/v1/logs?level=error', headers: AUTH });
    const body = res.json() as { data: { total: number; items: Array<{ level: string }> } };
    expect(body.data.total).toBe(1);
    expect(body.data.items[0]?.level).toBe('error');
  });

  it('context 接口按时间正序返回完整现场，并带出关联 jobId', async () => {
    const h = await setup();
    seed(h);
    const res = await h.app.inject({
      method: 'GET',
      url: '/api/v1/logs/context/tr_a_0123456789',
      headers: AUTH,
    });

    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      data: { traceId: string; total: number; jobIds: string[]; items: Array<{ ts: number }> };
    };
    expect(body.data.traceId).toBe('tr_a_0123456789');
    expect(body.data.jobIds).toEqual(['01JOB']);
    // 现场要按时间正序读，符合"发生了什么"的叙事顺序
    expect(body.data.items[0]!.ts).toBeLessThanOrEqual(body.data.items.at(-1)!.ts);
  });

  it('context 查不到时返回 404（而不是空数组，避免前端误判为"没有问题"）', async () => {
    const h = await setup();
    const res = await h.app.inject({
      method: 'GET',
      url: '/api/v1/logs/context/tr_none_0123456789',
      headers: AUTH,
    });
    expect(res.statusCode).toBe(404);
  });

  it('按 id 取单条；不存在的 id 返回 404', async () => {
    const h = await setup();
    const entry = makeLogEntry({ message: '唯一一条' });
    h.store.write(entry);

    const okRes = await h.app.inject({ method: 'GET', url: `/api/v1/logs/${entry.id}`, headers: AUTH });
    expect(okRes.statusCode).toBe(200);
    expect((okRes.json() as { data: { message: string } }).data.message).toBe('唯一一条');

    const missing = await h.app.inject({ method: 'GET', url: '/api/v1/logs/lg_missing', headers: AUTH });
    expect(missing.statusCode).toBe(404);
  });

  it('关键词搜索可用', async () => {
    const h = await setup();
    seed(h);
    const res = await h.app.inject({ method: 'GET', url: '/api/v1/logs?q=安装', headers: AUTH });
    expect((res.json() as { data: { total: number } }).data.total).toBe(1);
  });
});

describe('访问日志', () => {
  it('成功请求被记录为 info，并且带 source=api 与 traceId', async () => {
    const h = await setup();
    const res = await h.app.inject({ method: 'GET', url: '/api/v1/logs', headers: AUTH });
    const traceId = String(res.headers['x-trace-id']);

    const found = h.store.query({ traceId, source: 'api' });
    // 断言"恰好一条"：将来若有人给 Fastify 挂上自己的 logger，
    // 会变成重复记录请求，这里能立刻发现。
    const access = found.items.filter((e) => e.message.includes('GET /api/v1/logs'));
    expect(access).toHaveLength(1);
    expect(access[0]?.level).toBe('info');
    expect(access[0]?.scope).toBe('http');
  });

  it('4xx 记为 warn，不污染 error 级别（否则真实故障会被淹没）', async () => {
    const h = await setup();
    const res = await h.app.inject({ method: 'GET', url: '/api/v1/nope', headers: AUTH });
    const traceId = String(res.headers['x-trace-id']);

    const found = h.store.query({ traceId });
    expect(found.items.some((e) => e.level === 'warn')).toBe(true);
    expect(found.items.some((e) => e.level === 'error')).toBe(false);
  });
});

describe('降级页（A17 白屏兜底）', () => {
  it('无需令牌、返回 HTML、且带上 traceId 作为排查线索', async () => {
    const h = await setup();
    const res = await h.app.inject({ method: 'GET', url: '/__degraded' });

    expect(res.statusCode).toBe(200);
    expect(String(res.headers['content-type'])).toContain('text/html');
    const traceId = String(res.headers['x-trace-id']);
    expect(res.body).toContain(traceId);
    // 不依赖任何前端产物
    expect(res.body).not.toContain('<script');
  });
});

describe('渲染进程日志上报（source=renderer）', () => {
  it('上报的日志记为 renderer，而不是 api', async () => {
    const h = await setup();
    const res = await h.app.inject({
      method: 'POST',
      url: '/api/v1/logs/client',
      headers: AUTH,
      payload: {
        level: 'error',
        message: '组件渲染失败',
        detail: 'at BoardView.vue:42',
        scope: 'BoardView',
      },
    });

    expect(res.statusCode).toBe(200);
    expect((res.json() as { data: { accepted: boolean } }).data.accepted).toBe(true);

    const found = h.store.query({ source: 'renderer' });
    expect(found.total).toBe(1);
    expect(found.items[0]?.message).toBe('组件渲染失败');
    expect(found.items[0]?.scope).toBe('BoardView');
    // 关键点：处理这个请求的 logger 的 source 是 api，
    // 若不覆盖来源，前端错误会被记成后端错误
    expect(found.items[0]?.source).toBe('renderer');
  });

  it('上报内容同样经过脱敏管道', async () => {
    const h = await setup();
    await h.app.inject({
      method: 'POST',
      url: '/api/v1/logs/client',
      headers: AUTH,
      payload: {
        level: 'error',
        message: '请求失败 Authorization: Bearer abc123def456',
        detail: 'token=glpat-ABCDEFGHIJKLMNOPQRST',
      },
    });

    const rows = h.store.query({ source: 'renderer' });
    const joined = rows.items.map((e) => `${e.message}\n${e.detail ?? ''}`).join('\n');
    expect(joined).not.toContain('abc123def456');
    expect(joined).not.toContain('ABCDEFGHIJKLMNOPQRST');
    expect(joined).toContain('***');
  });

  it('非法级别被拒绝（未受信任输入必须校验）', async () => {
    const h = await setup();
    const res = await h.app.inject({
      method: 'POST',
      url: '/api/v1/logs/client',
      headers: AUTH,
      payload: { level: 'fatal', message: 'x' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('空消息被拒绝', async () => {
    const h = await setup();
    const res = await h.app.inject({
      method: 'POST',
      url: '/api/v1/logs/client',
      headers: AUTH,
      payload: { level: 'error', message: '' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('上报接口同样要求鉴权', async () => {
    const h = await setup();
    const res = await h.app.inject({
      method: 'POST',
      url: '/api/v1/logs/client',
      payload: { level: 'error', message: 'x' },
    });
    expect(res.statusCode).toBe(401);
  });
});

describe('SSE 实时日志流', () => {
  async function readUntil(
    reader: ReadableStreamDefaultReader<Uint8Array>,
    predicate: (text: string) => boolean,
    ms = 4000,
  ): Promise<string> {
    let collected = '';
    const deadline = Date.now() + ms;
    while (Date.now() < deadline && !predicate(collected)) {
      const chunk = await withTimeout(reader.read(), ms, 'SSE 数据');
      if (chunk.done) break;
      collected += new TextDecoder().decode(chunk.value);
    }
    return collected;
  }

  it('能建立连接、收到实时日志，并把 traceId 带在事件里', async () => {
    const h = await setup();
    const address = await h.app.listen({ host: '127.0.0.1', port: 0 });
    const controller = new AbortController();

    try {
      const res = await withTimeout(
        fetch(`${address}/api/v1/logs/stream?replay=0`, {
          headers: AUTH,
          signal: controller.signal,
        }),
        5000,
        'SSE 建连',
      );

      expect(res.status).toBe(200);
      expect(String(res.headers.get('content-type'))).toContain('text/event-stream');

      const reader = res.body!.getReader();
      h.logger.info('实时日志一条', undefined, { traceId: 'tr_live_0123456789' });

      const text = await readUntil(reader, (t) => t.includes('event: log'));
      expect(text).toContain('event: log');
      expect(text).toContain('tr_live_0123456789');
      expect(text).toContain('实时日志一条');
    } finally {
      controller.abort();
    }
  });

  it('连接时按 replay 参数回放历史日志', async () => {
    const h = await setup();
    h.store.write(makeLogEntry({ message: '历史日志一', ts: 1000 }));
    h.store.write(makeLogEntry({ message: '历史日志二', ts: 2000 }));

    const address = await h.app.listen({ host: '127.0.0.1', port: 0 });
    const controller = new AbortController();

    try {
      const res = await withTimeout(
        fetch(`${address}/api/v1/logs/stream?replay=10`, {
          headers: AUTH,
          signal: controller.signal,
        }),
        5000,
        'SSE 建连',
      );
      const reader = res.body!.getReader();
      const text = await readUntil(reader, (t) => t.includes('replay-end'));

      expect(text).toContain('历史日志一');
      expect(text).toContain('历史日志二');
      expect(text).toContain('event: replay-end');
    } finally {
      controller.abort();
    }
  });

  it('SSE 流同样要求鉴权', async () => {
    const h = await setup();
    const address = await h.app.listen({ host: '127.0.0.1', port: 0 });
    const res = await withTimeout(
      fetch(`${address}/api/v1/logs/stream`),
      5000,
      'SSE 未授权请求',
    );
    expect(res.status).toBe(401);
    await res.body?.cancel();
  });
});
