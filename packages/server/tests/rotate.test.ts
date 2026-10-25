import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import type { AppLogEntry } from '@pm-studio/shared';

import {
  formatLine,
  planRotation,
  rotatedPath,
  RotatingFileWriter,
} from '../src/logging/rotate';
import { makeTempDir, removeTempDir } from './helpers';

const dirs: string[] = [];

async function tempBase(name = 'main.log'): Promise<string> {
  const dir = await makeTempDir('rotate');
  dirs.push(dir);
  return join(dir, name);
}

afterEach(async () => {
  while (dirs.length > 0) {
    const d = dirs.pop();
    if (d) await removeTempDir(d);
  }
});

function entry(message: string, ts = 1_700_000_000_000): AppLogEntry {
  return {
    id: `lg_${message}`,
    ts,
    level: 'info',
    source: 'main',
    scope: 'test',
    message,
    detail: null,
    traceId: null,
    jobId: null,
    requestId: null,
    redacted: true,
  };
}

describe('rotatedPath', () => {
  it('在扩展名前插入序号', () => {
    expect(rotatedPath('C:\\logs\\main.log', 1)).toBe('C:\\logs\\main.1.log');
    expect(rotatedPath('/var/log/app.log', 3)).toBe('/var/log/app.3.log');
  });

  it('没有扩展名时直接追加', () => {
    expect(rotatedPath('/var/log/app', 2)).toBe('/var/log/app.2');
  });
});

describe('planRotation', () => {
  it('未超上限时不轮转', () => {
    expect(planRotation(100, 50, 1000)).toBe(false);
  });

  it('超出上限时轮转', () => {
    expect(planRotation(980, 50, 1000)).toBe(true);
  });

  it('当前文件为空时不轮转（否则会陷入永远写不进去的死循环）', () => {
    expect(planRotation(0, 5000, 1000)).toBe(false);
  });

  it('maxBytes<=0 视为不限制', () => {
    expect(planRotation(10_000, 10_000, 0)).toBe(false);
  });
});

describe('formatLine', () => {
  it('包含 ISO 时间、级别、来源与作用域', () => {
    const line = formatLine(entry('启动完成'));
    expect(line).toContain('2023-11-14T22:13:20.000Z');
    expect(line).toContain('INFO');
    expect(line).toContain('main:test');
    expect(line).toContain('启动完成');
    expect(line.endsWith('\n')).toBe(true);
  });

  it('带 traceId / jobId 时以 {..} 形式附在行尾', () => {
    const e: AppLogEntry = { ...entry('失败'), traceId: 'tr_abc_0123456789', jobId: '01JOB' };
    const line = formatLine(e);
    expect(line).toContain('trace=tr_abc_0123456789');
    expect(line).toContain('job=01JOB');
  });

  it('多行 detail 整体缩进，便于 grep 时看清边界', () => {
    const e: AppLogEntry = { ...entry('抛错了'), detail: 'line1\nline2' };
    const line = formatLine(e);
    expect(line).toContain('\n    line1\n    line2');
  });
});

describe('RotatingFileWriter', () => {
  it('写入的行会落盘', async () => {
    const base = await tempBase();
    const w = new RotatingFileWriter({ basePath: base });
    await w.open();
    w.write(entry('hello'));
    await w.flush();
    await w.close();

    expect(await readFile(base, 'utf8')).toContain('hello');
  });

  it('open() 自动创建父目录', async () => {
    const dir = await makeTempDir('rotate-mk');
    dirs.push(dir);
    const base = join(dir, 'nested', 'deep', 'main.log');
    const w = new RotatingFileWriter({ basePath: base });
    await w.open();
    w.write(entry('x'));
    await w.flush();
    expect(existsSync(base)).toBe(true);
  });

  it('超过上限时轮转，且只保留 keepCount 份', async () => {
    const base = await tempBase();
    const w = new RotatingFileWriter({ basePath: base, maxBytes: 120, keepCount: 2 });
    await w.open();

    for (let i = 0; i < 30; i += 1) {
      w.write(entry(`第 ${i} 行，故意写长一点让轮转更容易发生`));
      await w.flush();
    }
    await w.close();

    expect(existsSync(base)).toBe(true);
    expect(existsSync(rotatedPath(base, 1))).toBe(true);
    expect(existsSync(rotatedPath(base, 2))).toBe(true);
    // 第 3 份应已被删除 —— keepCount=2
    expect(existsSync(rotatedPath(base, 3))).toBe(false);
  });

  it('未超上限时不轮转', async () => {
    const base = await tempBase();
    const w = new RotatingFileWriter({ basePath: base, maxBytes: 1024 * 1024, keepCount: 3 });
    await w.open();
    for (let i = 0; i < 10; i += 1) w.write(entry(`line ${i}`));
    await w.flush();
    await w.close();

    expect(existsSync(rotatedPath(base, 1))).toBe(false);
  });

  it('单条超过上限时仍然写入（不会无限轮转）', async () => {
    const base = await tempBase();
    const w = new RotatingFileWriter({ basePath: base, maxBytes: 10, keepCount: 1 });
    await w.open();
    w.write(entry('这一行远远超过 10 字节的上限'));
    await w.flush();
    await w.close();

    expect(await readFile(base, 'utf8')).toContain('远远超过');
  });

  it('进程重启后接着算已有文件大小（否则永远不轮转）', async () => {
    const base = await tempBase();
    const first = new RotatingFileWriter({ basePath: base, maxBytes: 200, keepCount: 2 });
    await first.open();
    for (let i = 0; i < 5; i += 1) {
      first.write(entry(`第一批第 ${i} 行内容要够长`));
      await first.flush();
    }
    await first.close();

    const second = new RotatingFileWriter({ basePath: base, maxBytes: 200, keepCount: 2 });
    await second.open();
    expect(second.currentSize()).toBeGreaterThan(0);
    second.write(entry('第二批内容'));
    await second.flush();
    await second.close();

    expect(existsSync(rotatedPath(base, 1))).toBe(true);
  });

  it('close() 会把缓冲刷干净', async () => {
    const base = await tempBase();
    const w = new RotatingFileWriter({ basePath: base });
    await w.open();
    w.write(entry('未显式 flush 的内容'));
    expect(w.pendingBytes()).toBeGreaterThan(0);
    await w.close();

    expect(await readFile(base, 'utf8')).toContain('未显式 flush 的内容');
    expect(w.pendingBytes()).toBe(0);
  });

  it('close() 之后写入被忽略', async () => {
    const base = await tempBase();
    const w = new RotatingFileWriter({ basePath: base });
    await w.open();
    await w.close();
    w.write(entry('关掉之后写的'));
    await w.flush();
    expect(await RotatingFileWriter.sizeOf(base)).toBe(0);
  });

  it('缓冲达到阈值会主动落盘', async () => {
    const base = await tempBase();
    const w = new RotatingFileWriter({ basePath: base, flushThresholdBytes: 100 });
    await w.open();
    w.write(entry('a'.repeat(200)));
    // flush 是异步触发的，等一拍
    await new Promise((r) => setTimeout(r, 50));
    expect(await RotatingFileWriter.sizeOf(base)).toBeGreaterThan(0);
    await w.close();
  });
});
