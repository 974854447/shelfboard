/**
 * 测试用临时目录与数据工厂。
 *
 * 临时目录刻意放在**工作区内**的 `.tmp/tests/`，而不是 `os.tmpdir()`：
 * 部分受限环境下系统临时目录不可写，会让测试出现与代码无关的失败。
 */

import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { AppLogEntry, LogLevel, LogSource } from '@pm-studio/shared';

const root = fileURLToPath(new URL('../../../.tmp/tests/', import.meta.url));

export async function makeTempDir(prefix: string): Promise<string> {
  await mkdir(root, { recursive: true });
  return mkdtemp(join(root, `${prefix}-`));
}

export async function removeTempDir(dir: string): Promise<void> {
  await rm(dir, { recursive: true, force: true });
}

let logSeq = 0;

/** 构造一条日志；默认值可被 partial 覆盖 */
export function makeLogEntry(partial: Partial<AppLogEntry> = {}): AppLogEntry {
  logSeq += 1;
  return {
    id: `lg_test_${logSeq}`,
    ts: 1_700_000_000_000 + logSeq,
    level: 'info' as LogLevel,
    source: 'api' as LogSource,
    scope: 'test',
    message: `消息 ${logSeq}`,
    detail: null,
    traceId: null,
    jobId: null,
    requestId: null,
    redacted: true,
    ...partial,
  };
}

/** 带超时的等待，避免 SSE 之类的测试把整个套件挂住 */
export async function withTimeout<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`等待超时（${ms}ms）：${what}`)), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
