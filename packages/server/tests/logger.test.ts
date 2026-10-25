import { describe, expect, it, vi } from 'vitest';

import type { AppLogEntry } from '@pm-studio/shared';

import { createLogger, type LogSink } from '../src/logging/logger';

/** 收集型 sink：把条目攒在内存里供断言 */
function collectingSink(): LogSink & { entries: AppLogEntry[] } {
  const entries: AppLogEntry[] = [];
  return {
    entries,
    write: (e) => {
      entries.push(e);
    },
  };
}

describe('createLogger — 级别过滤', () => {
  it('默认 minLevel=info，debug 被丢弃', () => {
    const sink = collectingSink();
    const log = createLogger({ source: 'api', sinks: [sink] });

    log.debug('debug 不该出现');
    log.info('info 应出现');
    log.warn('warn 应出现');
    log.error('error 应出现');

    expect(sink.entries.map((e) => e.level)).toEqual(['info', 'warn', 'error']);
  });

  it('被过滤掉的日志 return undefined，不构造条目', () => {
    const sink = collectingSink();
    const log = createLogger({ source: 'api', sinks: [sink], minLevel: 'warn' });
    expect(log.info('x')).toBeUndefined();
    expect(log.warn('x')).toBeDefined();
  });

  it('setMinLevel 运行时生效（排查时切 debug 不必重启）', () => {
    const sink = collectingSink();
    const log = createLogger({ source: 'api', sinks: [sink], minLevel: 'error' });
    log.debug('a');
    log.setMinLevel('debug');
    log.debug('b');
    expect(sink.entries).toHaveLength(1);
    expect(sink.entries[0]?.message).toBe('b');
  });
});

describe('createLogger — 上下文与作用域', () => {
  it('条目带 source / scope / traceId', () => {
    const sink = collectingSink();
    const log = createLogger({
      source: 'api',
      scope: 'projects',
      context: { traceId: 'tr_abc_0123456789', requestId: 'tr_req_0123456789' },
      sinks: [sink],
    });

    log.info('列表查询');

    const e = sink.entries[0]!;
    expect(e.source).toBe('api');
    expect(e.scope).toBe('projects');
    expect(e.traceId).toBe('tr_abc_0123456789');
    expect(e.requestId).toBe('tr_req_0123456789');
    expect(e.redacted).toBe(true);
  });

  it('单条日志的 ctx 覆盖默认上下文', () => {
    const sink = collectingSink();
    const log = createLogger({
      source: 'job',
      context: { traceId: 'tr_default_0123456789' },
      sinks: [sink],
    });

    log.info('别的作业', undefined, { traceId: 'tr_other_0123456789', jobId: '01JOB' });

    expect(sink.entries[0]?.traceId).toBe('tr_other_0123456789');
    expect(sink.entries[0]?.jobId).toBe('01JOB');
  });

  it('child() 带上子作用域并继承上下文', () => {
    const sink = collectingSink();
    const parent = createLogger({
      source: 'job',
      scope: 'scaffold',
      context: { jobId: '01JOB' },
      sinks: [sink],
    });

    const child = parent.child('scaffold.npm');
    child.info('安装依赖');

    expect(parent.scope).toBe('scaffold');
    expect(child.scope).toBe('scaffold.npm');
    expect(sink.entries[0]?.scope).toBe('scaffold.npm');
    expect(sink.entries[0]?.jobId).toBe('01JOB');
  });

  it('child() 与父 logger 共享 sink（后加的也在）', () => {
    const first = collectingSink();
    const second = collectingSink();
    const parent = createLogger({ source: 'api', sinks: [first] });
    const child = parent.child('nested');

    parent.addSink(second);
    child.info('走两个 sink');

    expect(first.entries).toHaveLength(1);
    expect(second.entries).toHaveLength(1);
  });

  it('父 logger 调 setMinLevel，已存在的子 logger 同步生效', () => {
    // 回归用例：曾经 child() 各存一份 minLevel，导致运行时切到 debug
    // 只对父 logger 生效、子 logger 仍按旧级别过滤 —— 排查时会严重误导。
    const sink = collectingSink();
    const parent = createLogger({ source: 'api', sinks: [sink], minLevel: 'error' });
    const child = parent.child('nested');

    child.debug('改级别之前');
    parent.setMinLevel('debug');
    child.debug('改级别之后');

    expect(sink.entries.map((e) => e.message)).toEqual(['改级别之后']);
    expect(child.minLevel).toBe('debug');
  });

  it('scope 缺省时为 null（而不是 undefined），便于入库', () => {
    const sink = collectingSink();
    createLogger({ source: 'main', sinks: [sink] }).info('启动');
    expect(sink.entries[0]?.scope).toBeNull();
  });
});

describe('createLogger — 脱敏自动生效', () => {
  it('message 被脱敏', () => {
    const sink = collectingSink();
    const log = createLogger({ source: 'api', sinks: [sink] });
    log.error('请求失败 Authorization: Bearer abc123def456');

    expect(sink.entries[0]?.message).not.toContain('abc123def456');
    expect(sink.entries[0]?.message).toContain('***');
  });

  it('detail 被脱敏（含结构化对象）', () => {
    const sink = collectingSink();
    const log = createLogger({ source: 'api', sinks: [sink] });
    log.error('失败', { headers: { authorization: 'Bearer abc123def456' }, url: '/api' });

    const detail = sink.entries[0]?.detail ?? '';
    expect(detail).not.toContain('abc123def456');
    expect(detail).toContain('/api');
  });

  it('调用方无法绕过脱敏（没有开关）', () => {
    const sink = collectingSink();
    const log = createLogger({ source: 'main', sinks: [sink] });
    log.error('glpat-ABCDEFGHIJKLMNOPQRST');
    expect(sink.entries[0]?.message).not.toContain('ABCDEFGHIJKLMNOPQRST');
  });

  it('已知机密（本地 API Token）被整体替换', () => {
    const sink = collectingSink();
    const token = 'ffeeddccbbaa99887766554433';
    const log = createLogger({ source: 'main', sinks: [sink], redact: { knownSecrets: [token] } });
    log.info(`本地服务已启动，token=${token}`);
    expect(sink.entries[0]?.message).not.toContain(token);
  });
});

describe('createLogger — 健壮性', () => {
  it('sink 抛异常时不影响调用方，并计入 sinkErrorCount', () => {
    const bad: LogSink = {
      write() {
        throw new Error('sink 炸了');
      },
    };
    const good = collectingSink();
    const log = createLogger({ source: 'api', sinks: [bad, good] });

    expect(() => log.error('业务出错')).not.toThrow();
    // 坏 sink 之后的 sink 仍要收到日志
    expect(good.entries).toHaveLength(1);
    expect(log.sinkErrorCount()).toBe(1);
  });

  it('id 与时间可注入，便于测试与回放', () => {
    const sink = collectingSink();
    let n = 0;
    const log = createLogger({
      source: 'api',
      sinks: [sink],
      now: () => 1_700_000_000_000,
      idFactory: () => `lg_fixed_${(n += 1)}`,
    });

    log.info('a');
    log.info('b');

    expect(sink.entries.map((e) => e.id)).toEqual(['lg_fixed_1', 'lg_fixed_2']);
    expect(sink.entries.every((e) => e.ts === 1_700_000_000_000)).toBe(true);
  });

  it('message 传入非字符串也能处理', () => {
    const sink = collectingSink();
    const log = createLogger({ source: 'main', sinks: [sink] });
    // @ts-expect-error 故意传错类型
    log.info({ a: 1 });
    expect(typeof sink.entries[0]?.message).toBe('string');
  });

  it('flush / close 会下发到 sink', async () => {
    const flush = vi.fn();
    const close = vi.fn();
    const sink: LogSink = { write: () => {}, flush, close };
    const log = createLogger({ source: 'main', sinks: [sink] });

    await log.flush();
    await log.close();

    expect(flush).toHaveBeenCalledTimes(1);
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('sink 的 flush 抛异常不会冒泡', async () => {
    const sink: LogSink = {
      write: () => {},
      flush() {
        throw new Error('flush 炸了');
      },
    };
    const log = createLogger({ source: 'main', sinks: [sink] });
    await expect(log.flush()).resolves.toBeUndefined();
    expect(log.sinkErrorCount()).toBe(1);
  });
});
