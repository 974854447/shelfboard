import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createLogger, DbConnection } from '@pm-studio/server';
import { afterEach, describe, expect, it } from 'vitest';

import { resolveWorkspaceDatabase } from '../src/main/storage-move';

/**
 * 数据库搬家（0.1.1 → 0.1.2）的测试。
 *
 * 最要命的一种错法：只把 `workspace.db` 改名、没先做 WAL 检查点 ——
 * 那时还在 `-wal` 里的最新写入会留在孤儿文件里，表现是"搬完之后最近几条数据不见了"，
 * 而且原来的 `-wal` 还杵在工作区里，等于两件事都没做成。
 *
 * 所以这里**特意制造一个"数据只在 WAL 里"的库**来验：
 * 开着连接写入（数据落在 -wal），把三个文件整体拷走，再对副本做搬家。
 */

const cleanups: Array<() => void> = [];
const tempDirs: string[] = [];

afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()?.();
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

const silentLogger = createLogger({ source: 'main', sinks: [], minLevel: 'error' });

interface Place {
  root: string;
  dataDir: string;
}

function place(): Place {
  const base = mkdtempSync(join(tmpdir(), 'pm-move-'));
  tempDirs.push(base);
  const root = join(base, 'workspace');
  mkdirSync(root, { recursive: true });
  return { root, dataDir: join(base, 'data') };
}

/** 在工作区里造一个老式数据库（`projects` 表 + 几行数据），并做好检查点 */
function makeLegacyDb(root: string, names: string[]): string {
  const path = join(root, 'workspace.db');
  const conn = new DbConnection({ autoMigrate: false });
  conn.open(path);
  conn.sqlite.exec('CREATE TABLE IF NOT EXISTS projects (id TEXT PRIMARY KEY, name TEXT NOT NULL)');
  for (const name of names) {
    conn.sqlite.prepare('INSERT OR REPLACE INTO projects (id, name) VALUES (?, ?)').run(`id-${name}`, name);
  }
  conn.close();
  return path;
}

/**
 * 造一个"最新写入只在 -wal 里"的库。
 *
 * 做法：保持连接打开 → 拷走 .db/-wal/-shm → 关掉原连接。
 * 拷出来的那份里，主库文件是**插入之前**的状态，数据只在它的 `-wal` 里 ——
 * 这正是"被强杀过的数据库"的样子，也是只改 .db 名字会丢数据的场景。
 */
function makeDirtyWalDb(root: string, before: string[], after: string[]): string {
  const sourceDir = join(root, '..', 'src-db');
  mkdirSync(sourceDir, { recursive: true });
  const sourcePath = join(sourceDir, 'workspace.db');

  const conn = new DbConnection({ autoMigrate: false });
  conn.open(sourcePath);
  conn.sqlite.exec('CREATE TABLE IF NOT EXISTS projects (id TEXT PRIMARY KEY, name TEXT NOT NULL)');
  const insert = conn.sqlite.prepare('INSERT OR REPLACE INTO projects (id, name) VALUES (?, ?)');
  for (const name of before) insert.run(`id-${name}`, name);
  // 先做一次检查点：让"插入之前"的状态真正落到主库文件里
  conn.sqlite.pragma('wal_checkpoint(TRUNCATE)');

  const target = join(root, 'workspace.db');
  copyFileSync(sourcePath, target);
  // 再写第二批，这些只会落在 -wal 里
  for (const name of after) insert.run(`id-${name}`, name);

  for (const suffix of ['-wal', '-shm']) {
    if (existsSync(`${sourcePath}${suffix}`)) copyFileSync(`${sourcePath}${suffix}`, `${target}${suffix}`);
  }

  conn.close();
  rmSync(sourceDir, { recursive: true, force: true });
  return target;
}

function projectNames(path: string): string[] {
  const conn = new DbConnection({ autoMigrate: false });
  conn.open(path);
  try {
    return (conn.sqlite.prepare('SELECT name FROM projects ORDER BY name').all() as { name: string }[])
      .map((r) => r.name);
  } finally {
    conn.close();
  }
}

describe('resolveWorkspaceDatabase', () => {
  it('全新工作区：直接用新位置，不搬任何东西', () => {
    const { root, dataDir } = place();

    const result = resolveWorkspaceDatabase(root, dataDir, silentLogger);

    expect(result.moved).toBe(false);
    expect(result.path).toBe(join(dataDir, 'workspace.db'));
    expect(existsSync(dataDir)).toBe(true);
  });

  it('老数据库在工作区里：搬到 data\\ 下，数据完整，工作区里不留东西', () => {
    const { root, dataDir } = place();
    makeLegacyDb(root, ['项目A', '项目B']);

    const result = resolveWorkspaceDatabase(root, dataDir, silentLogger);

    expect(result.moved).toBe(true);
    expect(result.path).toBe(join(dataDir, 'workspace.db'));
    expect(projectNames(result.path)).toEqual(['项目A', '项目B']);
    // 工作区目录必须彻底干净（搬迁后只剩别人放的东西；这里本来就没别的）
    expect(readdirSync(root)).toEqual([]);
  });

  it('数据只在 WAL 里时也不会丢（先检查点再搬）', () => {
    const { root, dataDir } = place();
    makeDirtyWalDb(root, ['主库里的项目'], ['只在WAL里的项目']);

    const result = resolveWorkspaceDatabase(root, dataDir, silentLogger);

    expect(result.moved).toBe(true);
    // 两批数据都要在：只改 .db 文件名的话，第二批就没了
    expect(projectNames(result.path)).toEqual(['主库里的项目', '只在WAL里的项目']);
    // 遗留的 -wal / -shm 也必须清掉，否则工作区里还杵着两个文件
    expect(readdirSync(root)).toEqual([]);
  });

  it('已经搬过（新位置有库）时不重复搬，也不覆盖', () => {
    const { root, dataDir } = place();
    makeLegacyDb(root, ['老数据']);
    resolveWorkspaceDatabase(root, dataDir, silentLogger);

    const second = resolveWorkspaceDatabase(root, dataDir, silentLogger);

    expect(second.moved).toBe(false);
    expect(projectNames(second.path)).toEqual(['老数据']);
  });

  it('新位置与工作区里同时有库时：用新位置，并报告遗留文件（不静默删数据库）', () => {
    const { root, dataDir } = place();
    makeLegacyDb(root, ['老数据']);
    resolveWorkspaceDatabase(root, dataDir, silentLogger);
    // 模拟"用户又往工作区里放了一个库"（或上次搬迁留下的残骸）
    makeLegacyDb(root, ['另一个库']);

    const result = resolveWorkspaceDatabase(root, dataDir, silentLogger);

    expect(result.path).toBe(join(dataDir, 'workspace.db'));
    expect(result.leftover).toBe(join(root, 'workspace.db'));
    expect(projectNames(result.path)).toEqual(['老数据']);
    // 不去动那个文件：删数据库这种事不能替用户做主
    expect(existsSync(join(root, 'workspace.db'))).toBe(true);
  });

  it('搬不动时继续用老位置（不阻断启动）', () => {
    const { root } = place();
    const legacy = makeLegacyDb(root, ['数据']);
    // 用一个"父路径是文件"的 dataDir 让 mkdir 必然失败
    const blockedDataDir = join(legacy, 'nested');

    const result = resolveWorkspaceDatabase(root, blockedDataDir, silentLogger);

    expect(result.moved).toBe(false);
    expect(result.blocked).toBeTruthy();
    expect(result.path).toBe(legacy);
    expect(projectNames(result.path)).toEqual(['数据']);
  });
});
