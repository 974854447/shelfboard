/**
 * 迁移执行器。
 *
 * 设计取舍：
 *
 * 1. **校验和校验**。已应用的迁移如果内容变了，直接拒绝启动而不是默默放过 ——
 *    否则两台机器上的库结构会分叉，而分叉带来的问题（"我这儿是好的"）
 *    极难排查。开发期需要改迁移时，重建开发库即可。
 * 2. **每条迁移一个事务**。中途失败不会留下"执行了一半"的库。
 * 3. **不依赖 drizzle-kit**。它是 CLI 代码生成器（内部派生子进程），
 *    在受限环境下不可用，而且会引入一个只在开发期存在的构建产物。
 * 4. **外键默认开着，需要关的迁移自己声明**（`Migration.foreignKeysOff`）：
 *    SQLite 改不了已有列的 NOT NULL，重建表时若外键开着，
 *    `DROP TABLE` 会隐式级联删除子表行。而 `PRAGMA foreign_keys` 在事务内是空操作，
 *    所以这件事只能由执行器在事务外做（见 `applyWithForeignKeysOff`）。
 */

import { createHash } from 'node:crypto';

import type BetterSqlite3 from 'better-sqlite3';

import { MIGRATIONS, type Migration } from './migrations.js';

type SqliteDb = BetterSqlite3.Database;

export const MIGRATIONS_TABLE_DDL = `
CREATE TABLE IF NOT EXISTS schema_migrations (
  id          TEXT PRIMARY KEY,
  description TEXT NOT NULL,
  checksum    TEXT NOT NULL,
  applied_at  INTEGER NOT NULL
);
`;

export interface MigrationResult {
  /** 本次实际执行的迁移 id */
  applied: string[];
  /** 之前已执行、本次跳过的迁移 id */
  alreadyApplied: string[];
}

export interface RunMigrationsOptions {
  migrations?: readonly Migration[];
  now?: () => number;
}

export function checksumOf(sql: string): string {
  // 归一化换行，避免 CRLF/LF 差异导致校验和误报
  return createHash('sha256').update(sql.replace(/\r\n/g, '\n')).digest('hex').slice(0, 16);
}

interface AppliedRow {
  id: string;
  checksum: string;
}

export function runMigrations(
  db: SqliteDb,
  options: RunMigrationsOptions = {},
): MigrationResult {
  const migrations = options.migrations ?? MIGRATIONS;
  const now = options.now ?? Date.now;

  db.exec(MIGRATIONS_TABLE_DDL);

  const appliedRows = db
    .prepare('SELECT id, checksum FROM schema_migrations')
    .all() as AppliedRow[];
  const appliedMap = new Map(appliedRows.map((r) => [r.id, r.checksum]));

  // 先做全量校验，再执行任何迁移：宁可什么都不做，也不要在检测到分叉后
  // 又往库里写了一半东西
  for (const migration of migrations) {
    const previous = appliedMap.get(migration.id);
    if (previous === undefined) continue;
    const current = checksumOf(migration.up);
    if (previous !== current) {
      throw new Error(
        `迁移 ${migration.id} 的内容已被修改（校验和 ${previous} → ${current}）。` +
          '已应用的迁移不允许改写：请新增一条迁移来变更结构。' +
          '若这是开发库且你确认要改写，删除工作区数据库后重新启动即可。',
      );
    }
  }

  const result: MigrationResult = { applied: [], alreadyApplied: [] };

  const record = db.prepare(
    'INSERT INTO schema_migrations (id, description, checksum, applied_at) VALUES (?, ?, ?, ?)',
  );

  for (const migration of migrations) {
    if (appliedMap.has(migration.id)) {
      result.alreadyApplied.push(migration.id);
      continue;
    }

    const recordRun = (): void => {
      record.run(migration.id, migration.description, checksumOf(migration.up), now());
    };

    if (migration.foreignKeysOff === true) {
      applyWithForeignKeysOff(db, migration, recordRun);
    } else {
      const apply = db.transaction(() => {
        db.exec(migration.up);
        recordRun();
      });
      apply();
    }

    result.applied.push(migration.id);
  }

  return result;
}

/**
 * 在**关闭外键约束**的前提下执行一条迁移（见 `Migration.foreignKeysOff` 的说明）。
 *
 * 顺序不能变：
 * 1. `PRAGMA foreign_keys = OFF` 必须在**事务外**执行 —— 这个 pragma 在事务内是空操作，
 *    静默失效的话重建表时 `DROP TABLE` 会级联把子表行删掉（正是要避免的那件事）；
 * 2. 事务内跑 DDL + **在事务内**做 `PRAGMA foreign_key_check`：有违规就抛错，
 *    整个事务回滚（放到提交之后检查就晚了，那时已经无法回滚）；
 * 3. `finally` 里无论如何把外键恢复回去 —— 连接上"外键必须开着"是全局不变量
 *    （connection.ts 打开时就断言过），跑完迁移必须还原，失败路径也不能例外。
 */
function applyWithForeignKeysOff(
  db: SqliteDb,
  migration: Migration,
  recordRun: () => void,
): void {
  db.pragma('foreign_keys = OFF');
  try {
    const apply = db.transaction(() => {
      db.exec(migration.up);

      const violations = db.pragma('foreign_key_check') as unknown[];
      if (violations.length > 0) {
        throw new Error(
          `迁移 ${migration.id} 执行后存在 ${violations.length} 条外键违规，已整体回滚：` +
            JSON.stringify(violations.slice(0, 5)),
        );
      }

      recordRun();
    });

    apply();
  } finally {
    db.pragma('foreign_keys = ON');
  }
}

/** 迁移记录表是否已存在。全新库里它还不存在，此时"已应用"应为空集而不是报错。 */
function hasMigrationsTable(db: SqliteDb): boolean {
  const row = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='schema_migrations'")
    .get();
  return row !== undefined;
}

/**
 * 当前库的迁移版本（已应用的迁移 id 列表，按执行顺序）。
 *
 * 全新库返回空数组 —— 这是刻意的：调用方（例如"新建工作区"的启动检查）
 * 会先问"有哪些迁移待应用"，此时表都还没建，不该抛异常。
 */
export function appliedMigrations(db: SqliteDb): string[] {
  if (!hasMigrationsTable(db)) return [];
  const rows = db
    .prepare('SELECT id FROM schema_migrations ORDER BY applied_at, id')
    .all() as Array<{ id: string }>;
  return rows.map((r) => r.id);
}

/** 是否还有未应用的迁移 */
export function pendingMigrations(
  db: SqliteDb,
  migrations: readonly Migration[] = MIGRATIONS,
): string[] {
  const applied = new Set(appliedMigrations(db));
  return migrations.filter((m) => !applied.has(m.id)).map((m) => m.id);
}
