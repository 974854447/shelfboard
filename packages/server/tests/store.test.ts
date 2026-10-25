import Database from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { AppLogEntry, LogLevel, LogSource } from '@pm-studio/shared';

import { createLogger } from '../src/logging/logger';
import { createLogStore, type LogStore } from '../src/logging/store';

let db: Database.Database | undefined;
let store: LogStore | undefined;

function makeStore(opts: Partial<Parameters<typeof createLogStore>[0]> = {}): {
  db: Database.Database;
  store: LogStore;
} {
  db = new Database(':memory:');
  store = createLogStore({ db, ...opts });
  return { db, store };
}

afterEach(() => {
  store?.close();
  db?.close();
  store = undefined;
  db = undefined;
  vi.useRealTimers();
});

let seq = 0;
function entry(partial: Partial<AppLogEntry> = {}): AppLogEntry {
  seq += 1;
  return {
    id: `lg_test_${seq}`,
    ts: 1_700_000_000_000 + seq,
    level: 'info' as LogLevel,
    source: 'api' as LogSource,
    scope: 'projects',
    message: `消息 ${seq}`,
    detail: null,
    traceId: null,
    jobId: null,
    requestId: null,
    redacted: true,
    ...partial,
  };
}

describe('createLogStore — 建表', () => {
  it('自动建 app_logs 表与索引', () => {
    const { db: d } = makeStore();
    const tables = d
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='app_logs'")
      .all();
    expect(tables).toHaveLength(1);
    const indexes = d
      .prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='app_logs'")
      .all() as { name: string }[];
    expect(indexes.map((i) => i.name)).toContain('idx_app_logs_trace');
  });

  it('重复 ensureTable 不报错（幂等）', () => {
    const { store: s } = makeStore();
    expect(() => {
      s.ensureTable();
      s.ensureTable();
    }).not.toThrow();
  });
});

describe('createLogStore — 批量写入', () => {
  it('flushNow 之前不落库，之后可查到', () => {
    const { store: s } = makeStore();
    s.write(entry({ message: '待落库' }));
    expect(s.pendingCount()).toBe(1);
    expect(s.query({}).total).toBe(0);

    s.flushNow();

    expect(s.pendingCount()).toBe(0);
    expect(s.query({}).total).toBe(1);
    expect(s.query({}).items[0]?.message).toBe('待落库');
  });

  it('累计到 flushBatch 自动落库', () => {
    const { store: s } = makeStore({ flushBatch: 5 });
    for (let i = 0; i < 5; i += 1) s.write(entry());
    expect(s.insertedCount()).toBe(5);
    expect(s.pendingCount()).toBe(0);
  });

  it('定时器到期自动落库', () => {
    vi.useFakeTimers();
    const { store: s } = makeStore({ flushIntervalMs: 500, flushBatch: 1000 });
    s.write(entry());
    expect(s.query({}).total).toBe(0);

    vi.advanceTimersByTime(600);

    expect(s.insertedCount()).toBe(1);
    expect(s.query({}).total).toBe(1);
  });

  it('缓冲超上限时丢最旧的并计数（库被占用时不撑爆内存）', () => {
    const { store: s } = makeStore({ maxBuffer: 3, flushBatch: 10_000 });
    for (let i = 1; i <= 6; i += 1) s.write(entry({ message: `m${i}` }));

    expect(s.pendingCount()).toBe(3);
    expect(s.droppedCount()).toBe(3);

    s.flushNow();
    // 留下的是最后 3 条
    expect(s.query({}).items.map((e) => e.message).sort()).toEqual(['m4', 'm5', 'm6']);
  });

  it('close() 会先刷干净', () => {
    const { db: d } = makeStore();
    const s = store!;
    s.write(entry({ message: '关前写的' }));
    s.close();

    const rows = d.prepare('SELECT message FROM app_logs').all() as { message: string }[];
    expect(rows.map((r) => r.message)).toEqual(['关前写的']);
  });

  it('字段完整往返（含 null 与布尔）', () => {
    const { store: s } = makeStore();
    s.write(
      entry({
        scope: null,
        detail: 'stack...',
        traceId: 'tr_abc_0123456789',
        jobId: '01JOB',
        requestId: 'tr_req_0123456789',
        redacted: true,
      }),
    );
    s.flushNow();

    const got = s.query({}).items[0]!;
    expect(got.scope).toBeNull();
    expect(got.detail).toBe('stack...');
    expect(got.traceId).toBe('tr_abc_0123456789');
    expect(got.jobId).toBe('01JOB');
    expect(got.requestId).toBe('tr_req_0123456789');
    expect(got.redacted).toBe(true);
  });
});

describe('createLogStore — 查询', () => {
  function seed(): LogStore {
    const { store: s } = makeStore();
    s.write(entry({ level: 'error', source: 'api', message: '数据库连接失败', ts: 1000 }));
    s.write(entry({ level: 'warn', source: 'job', message: '磁盘空间偏低', ts: 2000 }));
    s.write(entry({ level: 'info', source: 'main', message: '应用启动', ts: 3000 }));
    s.write(entry({ level: 'debug', source: 'renderer', message: '组件挂载', ts: 4000 }));
    s.write(
      entry({
        level: 'error',
        source: 'job',
        message: '安装依赖失败',
        ts: 5000,
        traceId: 'tr_zzz_0123456789',
        jobId: '01JOB',
        scope: 'scaffold',
        detail: 'npm ERR! code EPERM',
      }),
    );
    s.flushNow();
    return s;
  }

  it('按 level 精确过滤', () => {
    expect(seed().query({ level: 'error' }).total).toBe(2);
  });

  it('按 minLevel 过滤（含更高级别）', () => {
    // seed 共 5 条：error / warn / info / debug / error
    expect(seed().query({ minLevel: 'warn' }).total).toBe(3);
    expect(seed().query({ minLevel: 'info' }).total).toBe(4);
    expect(seed().query({ minLevel: 'debug' }).total).toBe(5);
  });

  it('按 source 过滤', () => {
    expect(seed().query({ source: 'job' }).total).toBe(2);
  });

  it('按 scope 过滤', () => {
    expect(seed().query({ scope: 'scaffold' }).total).toBe(1);
  });

  it('按时间范围过滤', () => {
    expect(seed().query({ from: 2000, to: 4000 }).total).toBe(3);
  });

  it('按 traceId / jobId 过滤（这就是「一键跳到现场」的实现）', () => {
    const s = seed();
    expect(s.query({ traceId: 'tr_zzz_0123456789' }).total).toBe(1);
    expect(s.query({ jobId: '01JOB' }).total).toBe(1);
  });

  it('关键词搜 message 与 detail', () => {
    const s = seed();
    expect(s.query({ q: '启动' }).total).toBe(1);
    expect(s.query({ q: 'EPERM' }).total).toBe(1);
  });

  it('关键词里的 LIKE 通配符被转义，不会匹配一切', () => {
    const s = seed();
    // 未转义时 '%' 会命中所有记录
    expect(s.query({ q: '%' }).total).toBe(0);
    expect(s.query({ q: '_' }).total).toBe(0);
  });

  it('按时间倒序返回并支持分页', () => {
    const s = seed();
    const page1 = s.query({ page: 1, pageSize: 2 });
    expect(page1.total).toBe(5);
    expect(page1.items).toHaveLength(2);
    expect(page1.items[0]?.ts).toBe(5000);
    expect(page1.items[1]?.ts).toBe(4000);

    const page3 = s.query({ page: 3, pageSize: 2 });
    expect(page3.items).toHaveLength(1);
    expect(page3.items[0]?.ts).toBe(1000);
  });

  it('pageSize 被限制在合理区间', () => {
    const s = seed();
    expect(s.query({ pageSize: 99999 }).items.length).toBeLessThanOrEqual(1000);
    expect(s.query({ pageSize: -5 }).items.length).toBeGreaterThan(0);
  });
});

describe('createLogStore — 清理', () => {
  it('prune 删除保留期之前的日志', () => {
    const { store: s } = makeStore();
    const day = 24 * 60 * 60 * 1000;
    const now = 1_700_000_000_000;
    s.write(entry({ ts: now - 40 * day, message: '太旧了' }));
    s.write(entry({ ts: now - 10 * day, message: '还在保留期内' }));
    s.flushNow();

    const removed = s.prune(30, now);

    expect(removed).toBe(1);
    expect(s.query({}).items.map((e) => e.message)).toEqual(['还在保留期内']);
  });
});

describe('日志全链路（logger → store → 查询）', () => {
  it('脱敏在落库前生效，且能按 traceId 找回完整现场', () => {
    const { store: s } = makeStore();
    const log = createLogger({
      source: 'job',
      scope: 'scaffold',
      sinks: [s],
      now: () => 1_700_000_000_000,
      idFactory: (() => {
        let n = 0;
        return () => `lg_chain_${(n += 1)}`;
      })(),
    });
    const traceId = 'tr_chain_0123456789';

    log.info('开始安装依赖', { packageManager: 'pnpm' }, { traceId, jobId: '01JOB' });
    log.error(
      '安装失败',
      { authorization: 'Bearer abc123def456', exitCode: 1 },
      { traceId, jobId: '01JOB' },
    );
    s.flushNow();

    const found = s.query({ traceId });
    expect(found.total).toBe(2);

    const errorRow = found.items[0]!;
    expect(errorRow.level).toBe('error');
    expect(errorRow.detail).not.toContain('abc123def456');
    expect(errorRow.detail).toContain('exitCode');
    expect(errorRow.redacted).toBe(true);
  });
});
