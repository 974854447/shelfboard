import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createLogger, DbConnection } from '@pm-studio/server';
import { afterEach, describe, expect, it } from 'vitest';

import { exportLegacyAppLogs } from '../src/main/legacy-logs';

/**
 * 老工作区整理（0.1.0 → 0.1.1）的测试。
 *
 * 为什么值得单独测：这一步的顺序是 `导出 → 迁移（删表）`，反了就是**静默丢数据** ——
 * 应用照常启动、日志页照常打开，只是老日志没了。这类错不会在类型检查或代码审查里露头，
 * 所以这里既测"导出成功"，也测"导出之后表才消失、而内容确实留在了文件里"。
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

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'pm-legacy-'));
  tempDirs.push(dir);
  return dir;
}

const silentLogger = createLogger({ source: 'main', sinks: [], minLevel: 'error' });

/** 造出 0.1.0 的工作区样子：`app_logs` 就建在业务库里 */
function legacyWorkspace(populate: boolean): { conn: DbConnection; logFile: string } {
  const dir = tempDir();
  const conn = new DbConnection({ autoMigrate: false });
  conn.open(join(dir, 'workspace.db'));
  cleanups.push(() => conn.close());

  if (populate) {
    // 还原 0.1.0 的形态：日志存储层以 CREATE TABLE IF NOT EXISTS 自建的 app_logs
    conn.sqlite.exec(`
      CREATE TABLE IF NOT EXISTS app_logs (
        id TEXT PRIMARY KEY, ts INTEGER NOT NULL, level TEXT NOT NULL, source TEXT NOT NULL,
        scope TEXT, message TEXT NOT NULL, detail TEXT, trace_id TEXT, job_id TEXT,
        request_id TEXT, redacted INTEGER NOT NULL DEFAULT 1, created_at INTEGER NOT NULL
      );
    `);
    const insert = conn.sqlite.prepare(
      `INSERT INTO app_logs (id, ts, level, source, message, redacted, created_at)
       VALUES (?, ?, 'info', 'api', ?, 1, ?)`,
    );
    insert.run('log-1', 1_700_000_000_000, '第一条老日志', 1_700_000_000_000);
    insert.run('log-2', 1_700_000_001_000, '第二条老日志', 1_700_000_001_000);
  }

  return { conn, logFile: join(dir, 'logs', 'legacy-app-logs.jsonl') };
}

describe('exportLegacyAppLogs', () => {
  it('把老工作区里的应用日志导出成 JSONL', () => {
    const { conn, logFile } = legacyWorkspace(true);
    // 目标目录要先存在（真实调用方用的是已经建好的 <userData>/logs）
    mkdirSync(join(logFile, '..'), { recursive: true });

    const result = exportLegacyAppLogs(conn, logFile, silentLogger);

    expect(result.hadTable).toBe(true);
    expect(result.exported).toBe(2);
    expect(existsSync(logFile)).toBe(true);

    const lines = readFileSync(logFile, 'utf8').trim().split('\n');
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0] as string).message).toBe('第一条老日志');
    expect(JSON.parse(lines[1] as string).message).toBe('第二条老日志');
  });

  it('新工作区（没有 app_logs 表）什么都不做，也不留下空文件', () => {
    const { conn, logFile } = legacyWorkspace(false);

    const result = exportLegacyAppLogs(conn, logFile, silentLogger);

    expect(result).toEqual({ hadTable: false, exported: 0 });
    expect(existsSync(logFile)).toBe(false);
  });

  it('表存在但没有数据时不建文件（免得留下一个让人误会"日志丢了"的空文件）', () => {
    const { conn, logFile } = legacyWorkspace(true);
    conn.sqlite.exec('DELETE FROM app_logs');

    const result = exportLegacyAppLogs(conn, logFile, silentLogger);

    expect(result.hadTable).toBe(true);
    expect(result.exported).toBe(0);
  });

  it('导出失败不抛异常（启动路径上的清理动作不该让应用起不来）', () => {
    const { conn } = legacyWorkspace(true);
    // 目标目录不存在 → 写入必然失败
    const badPath = join(tempDir(), 'no-such-dir', 'nested', 'legacy.jsonl');

    const result = exportLegacyAppLogs(conn, badPath, silentLogger);

    expect(result.hadTable).toBe(true);
    expect(result.exported).toBe(0);
    expect(result.error).toBeTruthy();
  });

  it('顺序契约：先导出、后迁移删表，且内容确实留在文件里', () => {
    const dir = tempDir();
    const conn = new DbConnection({ autoMigrate: false });
    conn.open(join(dir, 'workspace.db'));
    cleanups.push(() => conn.close());

    // 0.1.0 的样子：既有一个项目表，也有写在业务库里的应用日志
    conn.sqlite.exec(`
      CREATE TABLE IF NOT EXISTS app_logs (
        id TEXT PRIMARY KEY, ts INTEGER NOT NULL, level TEXT NOT NULL, source TEXT NOT NULL,
        scope TEXT, message TEXT NOT NULL, detail TEXT, trace_id TEXT, job_id TEXT,
        request_id TEXT, redacted INTEGER NOT NULL DEFAULT 1, created_at INTEGER NOT NULL
      );
      INSERT INTO app_logs (id, ts, level, source, message, redacted, created_at)
      VALUES ('log-1', 1, 'info', 'api', '整理前写入的老日志', 1, 1);
    `);
    const logFile = join(dir, 'legacy-app-logs.jsonl');

    // 真实启动顺序：open(autoMigrate:false) → 导出 → migrate()
    const exported = exportLegacyAppLogs(conn, logFile, silentLogger);
    expect(exported.exported).toBe(1);

    conn.migrate();

    // 表被迁移删掉（工作区只服务项目），但内容已经在文件里 —— 没有静默丢数据
    const stillThere = conn.sqlite
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='app_logs'")
      .get();
    expect(stillThere).toBeUndefined();
    expect(readFileSync(logFile, 'utf8')).toContain('整理前写入的老日志');
  });

  it('幂等：整理过的库上再跑一次，不改动已有文件', () => {
    const { conn, logFile } = legacyWorkspace(true);
    mkdirSync(join(logFile, '..'), { recursive: true });

    exportLegacyAppLogs(conn, logFile, silentLogger);
    const content = readFileSync(logFile, 'utf8');
    conn.migrate();

    const second = exportLegacyAppLogs(conn, logFile, silentLogger);

    expect(second).toEqual({ hadTable: false, exported: 0 });
    expect(readFileSync(logFile, 'utf8')).toBe(content);
  });

  it('重跑时不会保留上一次的残留（文件是"这一次导出"的结果）', () => {
    const { conn, logFile } = legacyWorkspace(true);
    mkdirSync(join(logFile, '..'), { recursive: true });
    writeFileSync(logFile, '{"message":"上一次的残留"}\n');

    exportLegacyAppLogs(conn, logFile, silentLogger);

    const content = readFileSync(logFile, 'utf8');
    expect(content).not.toContain('上一次的残留');
    expect(content).toContain('第一条老日志');
  });
});
