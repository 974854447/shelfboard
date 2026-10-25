/**
 * 工作区数据库连接管理。
 *
 * 三条硬约束，都是为了后面「工作区迁移」能不丢数据：
 *
 * 1. **单连接单例**。SQLite 是单写者模型，一处多开连接最容易出现的症状是
 *    `SQLITE_BUSY` 随机出现。切换工作区时**必须先 `close()` 旧连接**，
 *    否则旧库的 `-wal` / `-shm` 文件会残留，复制工作区时必然出错。
 * 2. **外键必须开启**。SQLite 默认不开外键，`ON DELETE CASCADE` 会静默失效 ——
 *    删了项目但任务还在，是那种"过很久才发现的脏数据"。
 * 3. **关库前做 WAL 全量检查点**。WAL 模式下数据可能只在 `-wal` 里，
 *    只复制 `.db` 会拿到旧快照；先 checkpoint 把内容合并回主库文件。
 */

import Database from 'better-sqlite3';
import type BetterSqlite3 from 'better-sqlite3';
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';

import type { Logger } from '../logging/logger.js';
import { runMigrations, type MigrationResult } from './migrate.js';
import * as schema from './schema.js';

type SqliteDb = BetterSqlite3.Database;

export type WorkspaceDb = BetterSQLite3Database<typeof schema>;

export const IN_MEMORY_PATH = ':memory:';

export interface DbConnectionOptions {
  logger?: Logger;
  now?: () => number;
  /** 打开时自动执行迁移，默认 true */
  autoMigrate?: boolean;
  /** busy 时的等待毫秒数，默认 5000 */
  busyTimeoutMs?: number;
}

export class DbConnection {
  private raw: SqliteDb | undefined;
  private orm: WorkspaceDb | undefined;
  private currentPath: string | undefined;
  private migration: MigrationResult | undefined;

  private readonly options: DbConnectionOptions;

  constructor(options: DbConnectionOptions = {}) {
    this.options = options;
  }

  /** 当前是否已打开 */
  isOpen(): boolean {
    return this.raw !== undefined;
  }

  /** 当前库路径；未打开时抛错（比返回 undefined 更早暴露误用） */
  get path(): string {
    if (this.currentPath === undefined) throw new Error('数据库尚未打开');
    return this.currentPath;
  }

  /** Drizzle 实例（业务代码用的就是这个） */
  get db(): WorkspaceDb {
    if (!this.orm) throw new Error('数据库尚未打开');
    return this.orm;
  }

  /** 原生 better-sqlite3 实例（执行 PRAGMA、原生 SQL 时用） */
  get sqlite(): SqliteDb {
    if (!this.raw) throw new Error('数据库尚未打开');
    return this.raw;
  }

  /** 最近一次打开时执行的迁移结果 */
  get lastMigration(): MigrationResult | undefined {
    return this.migration;
  }

  /**
   * 打开数据库并（默认）执行迁移。
   *
   * 已打开时**抛错而不是静默重开**：静默重开会让前一个连接的 WAL 文件残留，
   * 而这种问题往往在研究"迁移工作区为什么丢数据"时才被发现。
   * 需要换库请用 `switchTo()` 或先 `close()`。
   */
  open(path: string): void {
    if (this.isOpen()) {
      throw new Error(
        `数据库已打开（${this.currentPath}）。切换工作区请用 switchTo()，或先 close()。`,
      );
    }

    const raw = new Database(path);
    this.raw = raw;

    try {
      this.applyPragmas();
      this.orm = drizzle(raw, { schema });
      this.currentPath = path;

      if (this.options.autoMigrate !== false) {
        this.migration = runMigrations(raw, { now: this.options.now });
        this.options.logger?.info('工作区数据库已就绪', {
          path,
          applied: this.migration.applied,
          alreadyApplied: this.migration.alreadyApplied.length,
        });
      } else {
        // 显式跳过：调用方会在这之后自己调 migrate()（中间可能要先做一次性整理）
        this.options.logger?.debug('已跳过自动迁移，等待调用方显式迁移', { path });
      }
    } catch (error) {
      // 打开/迁移失败必须回滚到"未打开"状态，否则会留下一个半残的连接
      this.raw = undefined;
      this.orm = undefined;
      this.currentPath = undefined;
      try {
        raw.close();
      } catch {
        // 关不上就算了，别掩盖原始错误
      }
      throw error;
    }
  }

  /** 切换工作区：先安全关旧库，再开新库 */
  switchTo(path: string): void {
    if (this.isOpen()) this.close();
    this.open(path);
  }

  /**
   * 手动执行迁移。
   *
   * 用法：`open(path)` 时传 `autoMigrate: false`，在"open 之后、migrate 之前"
   * 插一段必须先行的一次性整理（例如 0.1.1 要把老工作区里的应用日志先导出到工作区之外，
   * 再由迁移删表）。**顺序反了就是静默丢数据**，所以宁可把这一步显式化，
   * 也不要在 open 里顺手跑完迁移。
   */
  migrate(): MigrationResult {
    if (!this.raw) throw new Error('数据库尚未打开');
    this.migration = runMigrations(this.raw, { now: this.options.now });
    this.options.logger?.info('工作区数据库迁移已执行', {
      path: this.currentPath,
      applied: this.migration.applied,
      alreadyApplied: this.migration.alreadyApplied.length,
    });
    return this.migration;
  }

  /** WAL 全量检查点：把 `-wal` 里的内容合并回主库文件 */
  checkpoint(): void {
    if (!this.raw) return;
    try {
      this.raw.pragma('wal_checkpoint(TRUNCATE)');
    } catch (error) {
      // 内存库没有 WAL；被占用时也可能失败。都不该阻断关库流程。
      this.options.logger?.debug('WAL 检查点未完成', { path: this.currentPath, error });
    }
  }

  /** 关闭连接（幂等） */
  close(): void {
    if (!this.raw) return;
    const path = this.currentPath;

    this.checkpoint();
    try {
      this.raw.close();
    } finally {
      this.raw = undefined;
      this.orm = undefined;
      this.currentPath = undefined;
      this.options.logger?.info('工作区数据库已关闭', { path });
    }
  }

  private applyPragmas(): void {
    const raw = this.raw;
    if (!raw) return;

    // WAL：读不阻塞写。内存库会返回 'memory'，不是错误。
    raw.pragma('journal_mode = WAL');
    // 外键默认是关的，不显式打开 ON DELETE CASCADE 会静默失效
    raw.pragma('foreign_keys = ON');
    raw.pragma(`busy_timeout = ${this.options.busyTimeoutMs ?? 5000}`);
    // NORMAL + WAL 是桌面应用的合理取舍：崩溃不丢数据，性能远好于 FULL
    raw.pragma('synchronous = NORMAL');

    const fk = raw.pragma('foreign_keys', { simple: true });
    if (fk !== 1) {
      throw new Error('无法开启外键约束（PRAGMA foreign_keys 未生效），拒绝继续以免产生脏数据');
    }
  }

  /** 供诊断包使用：库文件与 WAL 的现状 */
  stats(): { path: string | undefined; journalMode: string; pageCount: number; pageSize: number } {
    if (!this.raw) {
      return { path: undefined, journalMode: 'closed', pageCount: 0, pageSize: 0 };
    }
    return {
      path: this.currentPath,
      journalMode: String(this.raw.pragma('journal_mode', { simple: true })),
      pageCount: Number(this.raw.pragma('page_count', { simple: true }) ?? 0),
      pageSize: Number(this.raw.pragma('page_size', { simple: true }) ?? 0),
    };
  }
}
