/**
 * 日志落库层（app_logs）。
 *
 * 关键设计：
 *
 * 1. **批量写入**。内存缓冲每 500ms 或累计 200 条刷一次。高频日志逐条
 *    写 SQLite 会把库写爆、把主流程拖慢，而日志不值得这个代价。
 * 2. **缓冲有上限**。数据库被占用（例如工作区迁移中）时不能无限吃内存，
 *    超出上限就丢最旧的并计数 —— 丢日志可以，把进程撑爆不行。
 * 3. **表由本模块自建**（`CREATE TABLE IF NOT EXISTS`）。这样即使主迁移集
 *    尚未执行、或迁移本身失败，启动阶段的错误依然记得下来。
 *    注意：DDL 必须与 data-model-and-api.md §2.6 的定义保持一致。
 * 4. **落库前不再脱敏**。条目在 logger 里已经脱敏，这里是纯存储层；
 *    二次脱敏会破坏幂等假设，也让"是否脱敏过"这件事变得不可断言。
 */

import type BetterSqlite3 from 'better-sqlite3';
import type { AppLogEntry, LogLevel, LogQuery, LogSource } from '@pm-studio/shared';
import { LOG_LEVELS, LOG_LEVEL_WEIGHT } from '@pm-studio/shared';

import type { LogSink } from './logger';

type SqliteDb = BetterSqlite3.Database;

export const DEFAULT_FLUSH_INTERVAL_MS = 500;
export const DEFAULT_FLUSH_BATCH = 200;
export const DEFAULT_MAX_BUFFER = 10_000;

/**
 * 与 data-model-and-api.md §2.6 保持一致。
 * 此处不带 `job_id` 外键：独立使用时 jobs 表可能尚不存在。
 */
export const APP_LOGS_DDL = `
CREATE TABLE IF NOT EXISTS app_logs (
  id          TEXT PRIMARY KEY,
  ts          INTEGER NOT NULL,
  level       TEXT NOT NULL,
  source      TEXT NOT NULL,
  scope       TEXT,
  message     TEXT NOT NULL,
  detail      TEXT,
  trace_id    TEXT,
  job_id      TEXT,
  request_id  TEXT,
  redacted    INTEGER NOT NULL DEFAULT 1,
  created_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_app_logs_ts    ON app_logs(ts DESC);
CREATE INDEX IF NOT EXISTS idx_app_logs_level ON app_logs(level, ts DESC);
CREATE INDEX IF NOT EXISTS idx_app_logs_src   ON app_logs(source, ts DESC);
CREATE INDEX IF NOT EXISTS idx_app_logs_trace ON app_logs(trace_id);
CREATE INDEX IF NOT EXISTS idx_app_logs_job   ON app_logs(job_id, ts);
`;

interface AppLogRow {
  id: string;
  ts: number;
  level: string;
  source: string;
  scope: string | null;
  message: string;
  detail: string | null;
  trace_id: string | null;
  job_id: string | null;
  request_id: string | null;
  redacted: number;
}

function rowToEntry(row: AppLogRow): AppLogEntry {
  return {
    id: row.id,
    ts: row.ts,
    level: row.level as LogLevel,
    source: row.source as LogSource,
    scope: row.scope,
    message: row.message,
    detail: row.detail,
    traceId: row.trace_id,
    jobId: row.job_id,
    requestId: row.request_id,
    redacted: row.redacted === 1,
  };
}

/** LIKE 通配符转义，避免用户输入的 % 变成"匹配一切" */
function escapeLike(input: string): string {
  return input.replace(/[\\%_]/g, (m) => `\\${m}`);
}

/** minLevel 转成等价的级别集合（表里没有 weight 列，用 IN 表达） */
function levelsAtLeast(min: LogLevel): LogLevel[] {
  return LOG_LEVELS.filter((l) => LOG_LEVEL_WEIGHT[l] >= LOG_LEVEL_WEIGHT[min]);
}

export interface LogStoreOptions {
  db: SqliteDb;
  flushIntervalMs?: number;
  flushBatch?: number;
  maxBuffer?: number;
  now?: () => number;
  /** 传 false 则不自动建表（由迁移负责），默认 true */
  ensureTable?: boolean;
}

export interface LogStoreResult {
  items: AppLogEntry[];
  total: number;
}

export interface LogStore extends LogSink {
  ensureTable(): void;
  flushNow(): void;
  pendingCount(): number;
  insertedCount(): number;
  droppedCount(): number;
  query(q: LogQuery): LogStoreResult;
  /** 按主键取单条。SSE 断线续传要靠它把 Last-Event-ID 解析成时间点 */
  getById(id: string): AppLogEntry | undefined;
  prune(retentionDays: number, at?: number): number;
  /**
   * 清空日志表，返回删掉的条数。
   *
   * 存在的理由：**日志页会长期留着历史错误**。升级修掉一个 bug 之后，那几条红色 ERROR
   * 仍然躺在表里，用户每次打开日志页都以为问题还在（这一版就遇到过：表里 12 条错误
   * 全是两三天前旧版本留下的）。所以必须给用户一个"清掉历史、从干净状态看"的手段。
   */
  clear(): number;
  close(): void;
}

export function createLogStore(options: LogStoreOptions): LogStore {
  const { db } = options;
  const flushIntervalMs = options.flushIntervalMs ?? DEFAULT_FLUSH_INTERVAL_MS;
  const flushBatch = options.flushBatch ?? DEFAULT_FLUSH_BATCH;
  const maxBuffer = options.maxBuffer ?? DEFAULT_MAX_BUFFER;
  const now = options.now ?? (() => Date.now());

  let buffer: AppLogEntry[] = [];
  let inserted = 0;
  let dropped = 0;
  let timer: ReturnType<typeof setInterval> | undefined;
  let closed = false;

  const ensureTable = (): void => {
    db.exec(APP_LOGS_DDL);
  };

  if (options.ensureTable !== false) ensureTable();

  const insertStmt = db.prepare(`
    INSERT INTO app_logs
      (id, ts, level, source, scope, message, detail, trace_id, job_id, request_id, redacted, created_at)
    VALUES
      (@id, @ts, @level, @source, @scope, @message, @detail, @traceId, @jobId, @requestId, @redacted, @createdAt)
  `);

  const flushNow = (): void => {
    if (buffer.length === 0) return;
    const batch = buffer;
    buffer = [];

    const writeAll = db.transaction((rows: AppLogEntry[]) => {
      for (const entry of rows) {
        insertStmt.run({
          id: entry.id,
          ts: entry.ts,
          level: entry.level,
          source: entry.source,
          scope: entry.scope,
          message: entry.message,
          detail: entry.detail,
          traceId: entry.traceId,
          jobId: entry.jobId,
          requestId: entry.requestId,
          redacted: entry.redacted ? 1 : 0,
          createdAt: now(),
        });
      }
    });

    try {
      writeAll(batch);
      inserted += batch.length;
    } catch {
      // 落库失败（库被占用 / 迁移中）→ 计入丢弃，绝不冒泡
      dropped += batch.length;
    }
  };

  const ensureTimer = (): void => {
    if (timer || closed || flushIntervalMs <= 0) return;
    timer = setInterval(flushNow, flushIntervalMs);
    // 不要因为一个日志定时器把进程吊住不退出
    timer.unref?.();
  };

  return {
    write(entry: AppLogEntry): void {
      if (closed) return;
      buffer.push(entry);

      if (buffer.length > maxBuffer) {
        const overflow = buffer.length - maxBuffer;
        buffer.splice(0, overflow);
        dropped += overflow;
      }

      if (buffer.length >= flushBatch) {
        flushNow();
        return;
      }
      ensureTimer();
    },

    ensureTable,

    flushNow,

    pendingCount: () => buffer.length,
    insertedCount: () => inserted,
    droppedCount: () => dropped,

    query(q: LogQuery): LogStoreResult {
      const where: string[] = [];
      const params: Record<string, unknown> = {};

      if (q.level) {
        where.push('level = @level');
        params.level = q.level;
      } else if (q.minLevel) {
        const levels = levelsAtLeast(q.minLevel);
        const names = levels.map((l, i) => {
          params[`lv${i}`] = l;
          return `@lv${i}`;
        });
        where.push(`level IN (${names.join(', ')})`);
      }
      if (q.source) {
        where.push('source = @source');
        params.source = q.source;
      }
      if (q.scope) {
        where.push('scope = @scope');
        params.scope = q.scope;
      }
      if (typeof q.from === 'number') {
        where.push('ts >= @from');
        params.from = q.from;
      }
      if (typeof q.to === 'number') {
        where.push('ts <= @to');
        params.to = q.to;
      }
      if (q.traceId) {
        where.push('trace_id = @traceId');
        params.traceId = q.traceId;
      }
      if (q.jobId) {
        where.push('job_id = @jobId');
        params.jobId = q.jobId;
      }
      if (q.q && q.q.trim().length > 0) {
        where.push(
          "(message LIKE @like ESCAPE '\\' OR IFNULL(detail,'') LIKE @like ESCAPE '\\' OR IFNULL(scope,'') LIKE @like ESCAPE '\\')",
        );
        params.like = `%${escapeLike(q.q.trim())}%`;
      }

      const whereSql = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';

      const total =
        (db.prepare(`SELECT COUNT(*) AS c FROM app_logs ${whereSql}`).get(params) as { c: number })
          ?.c ?? 0;

      const page = Math.max(1, q.page ?? 1);
      const pageSize = Math.min(1000, Math.max(1, q.pageSize ?? 50));
      const rows = db
        .prepare(
          `SELECT * FROM app_logs ${whereSql} ORDER BY ts DESC, id DESC LIMIT @limit OFFSET @offset`,
        )
        .all({ ...params, limit: pageSize, offset: (page - 1) * pageSize }) as AppLogRow[];

      return { items: rows.map(rowToEntry), total };
    },

    getById(id: string): AppLogEntry | undefined {
      const row = db.prepare('SELECT * FROM app_logs WHERE id = ?').get(id) as
        | AppLogRow
        | undefined;
      return row ? rowToEntry(row) : undefined;
    },

    prune(retentionDays: number, at?: number): number {
      const cutoff = (at ?? now()) - retentionDays * 24 * 60 * 60 * 1000;
      const result = db.prepare('DELETE FROM app_logs WHERE ts < ?').run(cutoff);
      return Number(result.changes ?? 0);
    },

    clear(): number {
      /*
       * **先落盘再删**。日志是先攒在内存缓冲里、定时批量写库的，
       * 直接 DELETE 的话缓冲区里那些还没写的行会在下一次 flush 时"复活" ——
       * 用户点了清空、过两秒又看到一堆旧日志，会以为按钮没生效。
       */
      flushNow();
      const result = db.prepare('DELETE FROM app_logs').run();
      return Number(result.changes ?? 0);
    },

    close(): void {
      if (closed) return;
      flushNow();
      if (timer) {
        clearInterval(timer);
        timer = undefined;
      }
      closed = true;
    },
  };
}
