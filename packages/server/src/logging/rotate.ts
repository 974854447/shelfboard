/**
 * 日志文本文件写入与轮转。
 *
 * 为什么除了数据库还要写文件：数据库可能损坏、可能被迁移操作占用、
 * 甚至可能在启动早期还没打开 —— 而**崩溃现场的日志恰恰是那个时候最需要**。
 * 文本文件是同步追加的、独立于数据库的最后一道保险，
 * 也是"导出诊断包"能整包取走的来源。
 *
 * 轮转规则：`main.log` 是当前文件，`main.1.log` 最新、`main.N.log` 最旧。
 * 超出 `keepCount` 份时删除最旧的。
 */

import { appendFile, mkdir, rename, rm, stat } from 'node:fs/promises';
import { dirname, extname, join } from 'node:path';

import type { AppLogEntry } from '@pm-studio/shared';

import type { LogSink } from './logger';

export const DEFAULT_FILE_MAX_BYTES = 5 * 1024 * 1024; // 5 MB
export const DEFAULT_FILE_KEEP_COUNT = 5;
/** 缓冲到这么多字节就主动落盘，避免日志长时间停留在内存里 */
const DEFAULT_FLUSH_THRESHOLD_BYTES = 64 * 1024;

/** `logs/main.log` + 1 → `logs/main.1.log` */
export function rotatedPath(basePath: string, index: number): string {
  const ext = extname(basePath);
  const stem = basePath.slice(0, basePath.length - ext.length);
  return `${stem}.${index}${ext}`;
}

/** 是否需要在写入前先轮转 */
export function planRotation(
  currentBytes: number,
  incomingBytes: number,
  maxBytes: number,
): boolean {
  if (maxBytes <= 0) return false;
  // 单条就超过上限时也允许写入（否则会陷入无限轮转且永远写不进去）
  if (currentBytes === 0) return false;
  return currentBytes + incomingBytes > maxBytes;
}

/** 一行文本日志的格式（纯函数，便于测试与人工阅读） */
export function formatLine(entry: AppLogEntry): string {
  const time = new Date(entry.ts).toISOString();
  const where = entry.scope ? `${entry.source}:${entry.scope}` : entry.source;
  const refs: string[] = [];
  if (entry.traceId) refs.push(`trace=${entry.traceId}`);
  if (entry.jobId) refs.push(`job=${entry.jobId}`);
  if (entry.requestId) refs.push(`req=${entry.requestId}`);
  const suffix = refs.length > 0 ? ` {${refs.join(' ')}}` : '';

  let line = `[${time}] ${entry.level.toUpperCase().padEnd(5)} ${where} ${entry.message}${suffix}`;
  if (entry.detail) {
    // 缩进跟随，便于 grep 单条日志时一眼看出边界
    const indented = entry.detail.split('\n').join('\n    ');
    line += `\n    ${indented}`;
  }
  return `${line}\n`;
}

export interface RotatingFileWriterOptions {
  basePath: string;
  maxBytes?: number;
  keepCount?: number;
  flushThresholdBytes?: number;
}

/**
 * 缓冲式追加写入器。
 *
 * `write()` 是同步的（LogSink 的约定），只把行推进内存缓冲；
 * 真正的落盘发生在 `flush()`，由 logger 或定时器触发。
 * 这样做是为了不阻塞事件循环 —— 日志不该成为业务的性能瓶颈。
 */
export class RotatingFileWriter implements LogSink {
  readonly basePath: string;
  readonly maxBytes: number;
  readonly keepCount: number;

  private readonly flushThresholdBytes: number;
  private buffer: string[] = [];
  private bufferedBytes = 0;
  private currentBytes = 0;
  private opened = false;
  private closed = false;
  private rotating = false;
  private errorCount = 0;

  constructor(options: RotatingFileWriterOptions) {
    this.basePath = options.basePath;
    this.maxBytes = options.maxBytes ?? DEFAULT_FILE_MAX_BYTES;
    this.keepCount = options.keepCount ?? DEFAULT_FILE_KEEP_COUNT;
    this.flushThresholdBytes = options.flushThresholdBytes ?? DEFAULT_FLUSH_THRESHOLD_BYTES;
  }

  /** 建立目录并读取现有文件大小（进程重启后要接着算，否则永远不轮转） */
  async open(): Promise<void> {
    if (this.opened) return;
    await mkdir(dirname(this.basePath), { recursive: true });
    try {
      const info = await stat(this.basePath);
      this.currentBytes = info.size;
    } catch {
      this.currentBytes = 0;
    }
    this.opened = true;
  }

  write(entry: AppLogEntry): void {
    if (this.closed) return;
    const line = formatLine(entry);
    this.buffer.push(line);
    this.bufferedBytes += Buffer.byteLength(line);

    if (this.bufferedBytes >= this.flushThresholdBytes) {
      void this.flush();
    }
  }

  async flush(): Promise<void> {
    if (this.closed || this.buffer.length === 0 || this.rotating) return;

    const lines = this.buffer;
    const bytes = this.bufferedBytes;
    this.buffer = [];
    this.bufferedBytes = 0;

    try {
      await this.open();
      if (planRotation(this.currentBytes, bytes, this.maxBytes)) {
        await this.rotate();
      }
      const payload = lines.join('');
      await appendFile(this.basePath, payload, 'utf8');
      this.currentBytes += Buffer.byteLength(payload);
    } catch {
      // 落盘失败不能影响业务；但要把行放回缓冲，等下次再试
      this.errorCount += 1;
      this.buffer = [...lines, ...this.buffer];
      this.bufferedBytes += bytes;
    }
  }

  /** 轮转：删最旧、整体后移、当前文件变成 .1 */
  private async rotate(): Promise<void> {
    this.rotating = true;
    try {
      await rm(rotatedPath(this.basePath, this.keepCount), { force: true });
      for (let i = this.keepCount - 1; i >= 1; i -= 1) {
        try {
          await rename(rotatedPath(this.basePath, i), rotatedPath(this.basePath, i + 1));
        } catch {
          // 该序号的文件不存在，跳过
        }
      }
      try {
        await rename(this.basePath, rotatedPath(this.basePath, 1));
      } catch {
        // 当前文件不存在（首次写入前），跳过
      }
      this.currentBytes = 0;
    } finally {
      this.rotating = false;
    }
  }

  async close(): Promise<void> {
    if (this.closed) return;
    await this.flush();
    this.closed = true;
  }

  currentSize(): number {
    return this.currentBytes;
  }

  pendingBytes(): number {
    return this.bufferedBytes;
  }

  writeErrorCount(): number {
    return this.errorCount;
  }

  /** 便于测试：直接查磁盘上的实际大小 */
  static async sizeOf(path: string): Promise<number> {
    try {
      return (await stat(path)).size;
    } catch {
      return 0;
    }
  }

  static joinFor(baseDir: string, name: string): string {
    return join(baseDir, name);
  }
}
