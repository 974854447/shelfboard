/**
 * 日志实时广播（供 SSE 使用）。
 *
 * 为什么要有节流：日志可能以每秒上千条的速度产生。如果每条都立刻推给
 * 浏览器，前端渲染会被打爆、连接也会被写阻塞，最终**看不到最新的日志**
 * —— 恰恰与"实时流"的目的相反。因此按时间窗合并批量推送。
 *
 * 同时限制订阅者数量：每个订阅者都占一个长连接，不能无限增长。
 */

import type { AppLogEntry } from '@pm-studio/shared';

import type { LogSink } from './logger';

export const DEFAULT_BROADCAST_WINDOW_MS = 200;
export const DEFAULT_MAX_SUBSCRIBERS = 32;
export const DEFAULT_MAX_BUFFERED = 2000;

export interface LogBroadcasterOptions {
  /** 合并推送的时间窗，默认 200ms */
  windowMs?: number;
  maxSubscribers?: number;
  /** 单个订阅者最多积压多少条，超出丢弃最旧的 */
  maxBuffered?: number;
}

export interface LogBroadcaster extends LogSink {
  /** 订阅日志批次。返回取消订阅的函数（幂等） */
  subscribe(listener: (entries: AppLogEntry[]) => void): () => void;
  subscriberCount(): number;
  /** 广播被拒绝的订阅数，以及因监听器异常被摘除的次数 */
  stats(): { rejected: number; droppedListeners: number };
  /** 立即把缓冲推给订阅者（测试与关闭时用） */
  flushNow(): void;
  // LogSink 里这两个是可选的，但广播器一定实现了它们。
  // 重新声明为必需，免得调用方到处写 `?.` 掩盖真实契约。
  flush(): void;
  close(): void;
}

interface Subscription {
  listener: (entries: AppLogEntry[]) => void;
  buffer: AppLogEntry[];
  dropped: number;
}

export function createLogBroadcaster(options: LogBroadcasterOptions = {}): LogBroadcaster {
  const windowMs = options.windowMs ?? DEFAULT_BROADCAST_WINDOW_MS;
  const maxSubscribers = options.maxSubscribers ?? DEFAULT_MAX_SUBSCRIBERS;
  const maxBuffered = options.maxBuffered ?? DEFAULT_MAX_BUFFERED;

  const subscriptions = new Set<Subscription>();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let rejected = 0;
  let droppedListeners = 0;

  const schedule = (): void => {
    if (timer || windowMs <= 0) return;
    timer = setTimeout(() => {
      timer = undefined;
      flushNow();
    }, windowMs);
    timer.unref?.();
  };

  const flushNow = (): void => {
    if (timer) {
      clearTimeout(timer);
      timer = undefined;
    }

    for (const sub of [...subscriptions]) {
      if (sub.buffer.length === 0) continue;
      const batch = sub.buffer;
      sub.buffer = [];
      try {
        sub.listener(batch);
      } catch {
        // 监听器坏掉（例如连接已断）→ 摘除，避免持续拖累其他订阅者
        subscriptions.delete(sub);
        droppedListeners += 1;
      }
    }
  };

  return {
    write(entry: AppLogEntry): void {
      if (subscriptions.size === 0) return;

      for (const sub of subscriptions) {
        sub.buffer.push(entry);
        if (sub.buffer.length > maxBuffered) {
          sub.buffer.splice(0, sub.buffer.length - maxBuffered);
          sub.dropped += 1;
        }
      }
      if (windowMs <= 0) flushNow();
      else schedule();
    },

    subscribe(listener: (entries: AppLogEntry[]) => void): () => void {
      if (subscriptions.size >= maxSubscribers) {
        rejected += 1;
        return () => {};
      }
      const sub: Subscription = { listener, buffer: [], dropped: 0 };
      subscriptions.add(sub);

      let active = true;
      return () => {
        if (!active) return;
        active = false;
        subscriptions.delete(sub);
      };
    },

    subscriberCount: () => subscriptions.size,
    stats: () => ({ rejected, droppedListeners }),
    flushNow,

    flush(): void {
      flushNow();
    },

    close(): void {
      flushNow();
      subscriptions.clear();
    },
  };
}
