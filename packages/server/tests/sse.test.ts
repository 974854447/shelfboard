import { afterEach, describe, expect, it, vi } from 'vitest';

import type { AppLogEntry } from '@pm-studio/shared';

import { createLogBroadcaster } from '../src/logging/sse';
import { makeLogEntry } from './helpers';

afterEach(() => {
  vi.useRealTimers();
});

describe('createLogBroadcaster', () => {
  it('在时间窗内合并成一批推送（不是每条一推）', () => {
    vi.useFakeTimers();
    const batches: AppLogEntry[][] = [];
    const b = createLogBroadcaster({ windowMs: 200 });
    b.subscribe((batch) => batches.push(batch));

    b.write(makeLogEntry({ message: 'a' }));
    b.write(makeLogEntry({ message: 'b' }));
    b.write(makeLogEntry({ message: 'c' }));

    expect(batches).toHaveLength(0);
    vi.advanceTimersByTime(250);

    expect(batches).toHaveLength(1);
    expect(batches[0]?.map((e) => e.message)).toEqual(['a', 'b', 'c']);
  });

  it('没有订阅者时不缓冲（避免无人看时白占内存）', () => {
    vi.useFakeTimers();
    const b = createLogBroadcaster({ windowMs: 200 });
    b.write(makeLogEntry());
    vi.advanceTimersByTime(250);
    expect(b.subscriberCount()).toBe(0);
  });

  it('取消订阅后不再收到', () => {
    vi.useFakeTimers();
    const batches: AppLogEntry[][] = [];
    const b = createLogBroadcaster({ windowMs: 10 });
    const off = b.subscribe((batch) => batches.push(batch));

    b.write(makeLogEntry());
    vi.advanceTimersByTime(20);
    expect(batches).toHaveLength(1);

    off();
    b.write(makeLogEntry());
    vi.advanceTimersByTime(20);
    expect(batches).toHaveLength(1);
    expect(b.subscriberCount()).toBe(0);
  });

  it('取消订阅是幂等的', () => {
    const b = createLogBroadcaster();
    const off = b.subscribe(() => {});
    off();
    expect(() => off()).not.toThrow();
    expect(b.subscriberCount()).toBe(0);
  });

  it('多个订阅者各自收到同一批', () => {
    vi.useFakeTimers();
    const first: AppLogEntry[][] = [];
    const second: AppLogEntry[][] = [];
    const b = createLogBroadcaster({ windowMs: 10 });
    b.subscribe((x) => first.push(x));
    b.subscribe((x) => second.push(x));

    b.write(makeLogEntry());
    vi.advanceTimersByTime(20);

    expect(first).toHaveLength(1);
    expect(second).toHaveLength(1);
  });

  it('订阅者数达上限时拒绝新连接（每个订阅占一个长连接）', () => {
    const b = createLogBroadcaster({ maxSubscribers: 2 });
    b.subscribe(() => {});
    b.subscribe(() => {});
    const off = b.subscribe(() => {});

    expect(b.subscriberCount()).toBe(2);
    expect(b.stats().rejected).toBe(1);
    // 被拒绝时返回的取消函数必须是安全的空操作
    expect(() => off()).not.toThrow();
  });

  it('监听器抛异常时被摘除，不影响其他订阅者', () => {
    vi.useFakeTimers();
    const good: AppLogEntry[][] = [];
    const b = createLogBroadcaster({ windowMs: 10 });
    b.subscribe(() => {
      throw new Error('连接已断');
    });
    b.subscribe((batch) => good.push(batch));

    b.write(makeLogEntry());
    vi.advanceTimersByTime(20);

    expect(good).toHaveLength(1);
    expect(b.subscriberCount()).toBe(1);
    expect(b.stats().droppedListeners).toBe(1);
  });

  it('单个订阅者积压超上限时丢最旧的（慢客户端不拖垮进程）', () => {
    vi.useFakeTimers();
    const batches: AppLogEntry[][] = [];
    const b = createLogBroadcaster({ windowMs: 1000, maxBuffered: 3 });
    b.subscribe((batch) => batches.push(batch));

    // 窗口未到期 → 全部积压在订阅者缓冲里，超过 maxBuffered=3 后丢最旧的
    for (let i = 1; i <= 5; i += 1) b.write(makeLogEntry({ message: `m${i}` }));
    vi.advanceTimersByTime(1100);

    expect(batches).toHaveLength(1);
    expect(batches[0]?.map((e) => e.message)).toEqual(['m3', 'm4', 'm5']);
  });

  it('flushNow / close 会立刻推送并清空订阅', () => {
    const batches: AppLogEntry[][] = [];
    const b = createLogBroadcaster({ windowMs: 10_000 });
    b.subscribe((batch) => batches.push(batch));

    b.write(makeLogEntry({ message: 'before flush' }));
    b.flushNow();
    expect(batches.flat().map((e) => e.message)).toEqual(['before flush']);

    b.close();
    expect(b.subscriberCount()).toBe(0);
  });

  it('作为 LogSink 可以挂到 logger 上（接口形状正确）', () => {
    const b = createLogBroadcaster();
    expect(typeof b.write).toBe('function');
    expect(typeof b.flush).toBe('function');
    expect(typeof b.close).toBe('function');
  });
});
