import { join } from 'node:path';

import Database from 'better-sqlite3';
import { eq, getTableColumns } from 'drizzle-orm';
import { afterEach, describe, expect, it } from 'vitest';

import { DbConnection } from '../src/db/connection';
import { appliedMigrations, checksumOf, pendingMigrations, runMigrations } from '../src/db/migrate';
import { MIGRATIONS } from '../src/db/migrations';
import * as schema from '../src/db/schema';
import { SCHEMA_TABLES } from '../src/db/schema';
import { makeTempDir, removeTempDir } from './helpers';

const cleanups: Array<() => void> = [];
const tempDirs: string[] = [];

afterEach(async () => {
  while (cleanups.length > 0) cleanups.pop()?.();
  while (tempDirs.length > 0) {
    const d = tempDirs.pop();
    if (d) await removeTempDir(d);
  }
});

function memoryDb(): Database.Database {
  const db = new Database(':memory:');
  cleanups.push(() => db.close());
  return db;
}

async function filePath(name = 'workspace.db'): Promise<string> {
  const dir = await makeTempDir('db');
  tempDirs.push(dir);
  return join(dir, name);
}

describe('迁移执行器', () => {
  it('首次执行会应用全部迁移并记录', () => {
    const db = memoryDb();
    const result = runMigrations(db);

    expect(result.applied).toEqual(MIGRATIONS.map((m) => m.id));
    expect(result.alreadyApplied).toEqual([]);
    expect(appliedMigrations(db)).toEqual(MIGRATIONS.map((m) => m.id));
  });

  it('重复执行是幂等的（不会重复建表或重复记录）', () => {
    const db = memoryDb();
    runMigrations(db);
    const second = runMigrations(db);

    expect(second.applied).toEqual([]);
    expect(second.alreadyApplied).toEqual(MIGRATIONS.map((m) => m.id));

    const count = db.prepare('SELECT COUNT(*) AS c FROM schema_migrations').get() as { c: number };
    expect(count.c).toBe(MIGRATIONS.length);
  });

  it('已应用的迁移被改写时拒绝启动（防止不同机器的库结构分叉）', () => {
    const db = memoryDb();
    runMigrations(db, {
      migrations: [{ id: '0001_x', description: '原始', up: 'CREATE TABLE t1 (a TEXT);' }],
    });

    expect(() =>
      runMigrations(db, {
        migrations: [{ id: '0001_x', description: '原始', up: 'CREATE TABLE t1 (a TEXT, b TEXT);' }],
      }),
    ).toThrow(/已被修改/);
  });

  it('检测到分叉时不做任何写入（宁可什么都不做）', () => {
    const db = memoryDb();
    runMigrations(db, {
      migrations: [{ id: '0001_x', description: '原始', up: 'CREATE TABLE t1 (a TEXT);' }],
    });

    const before = db.prepare('SELECT COUNT(*) AS c FROM schema_migrations').get() as { c: number };

    expect(() =>
      runMigrations(db, {
        migrations: [
          { id: '0001_x', description: '原始', up: 'CREATE TABLE t1 (a TEXT, b TEXT);' },
          { id: '0002_y', description: '新增', up: 'CREATE TABLE t2 (a TEXT);' },
        ],
      }),
    ).toThrow();

    const after = db.prepare('SELECT COUNT(*) AS c FROM schema_migrations').get() as { c: number };
    expect(after.c).toBe(before.c);
    // 0002 也不该被执行
    const t2 = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='t2'")
      .all();
    expect(t2).toHaveLength(0);
  });

  it('checksumOf 对 CRLF/LF 差异不敏感', () => {
    expect(checksumOf('SELECT 1;\nSELECT 2;')).toBe(checksumOf('SELECT 1;\r\nSELECT 2;'));
  });

  it('pendingMigrations 反映未应用的迁移', () => {
    const db = memoryDb();
    expect(pendingMigrations(db)).toEqual(MIGRATIONS.map((m) => m.id));
    runMigrations(db);
    expect(pendingMigrations(db)).toEqual([]);
  });
});

describe('schema 漂移测试（Drizzle 定义 vs 迁移建出的真实结构）', () => {
  it('每一张声明的表都真实存在', () => {
    const db = memoryDb();
    runMigrations(db);

    const tables = (
      db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{
        name: string;
      }>
    ).map((r) => r.name);

    for (const tableName of Object.keys(SCHEMA_TABLES)) {
      expect(tables, `缺少表 ${tableName}`).toContain(tableName);
    }
  });

  it('每张表的列与 Drizzle 声明完全一致（双向比对）', () => {
    const db = memoryDb();
    runMigrations(db);

    for (const [tableName, table] of Object.entries(SCHEMA_TABLES)) {
      const declared = Object.values(getTableColumns(table))
        .map((c) => c.name)
        .sort();
      const actual = (
        db.prepare(`PRAGMA table_info(${tableName})`).all() as Array<{ name: string }>
      )
        .map((r) => r.name)
        .sort();

      // 用集合相等而非"包含"：多出来的列同样意味着两份定义脱节，
      // 而且那种情况更隐蔽（迁移里加了列，代码里没人知道）
      expect(actual, `表 ${tableName} 的列与 schema.ts 不一致`).toEqual(declared);
    }
  });

  it('关键索引已建立（含部分索引）', () => {
    const db = memoryDb();
    runMigrations(db);

    const indexes = (
      db.prepare("SELECT name FROM sqlite_master WHERE type='index'").all() as Array<{
        name: string;
      }>
    ).map((r) => r.name);

    for (const name of [
      'idx_projects_status',
      'idx_tasks_project_status',
      'idx_tasks_parent',
      'idx_tasks_due',
      'uq_tags_scope_name',
      'uq_dep',
      'uq_ticket_code',
      'idx_dep_successor',
    ]) {
      expect(indexes, `缺少索引 ${name}`).toContain(name);
    }
  });

  /**
   * 0.1.1：工作区只服务项目 —— 应用日志搬到了 AppData 的独立库。
   *
   * 这条断言替代了原先"app_logs 索引已建立"的检查。方向反过来是刻意的：
   * 原来那条只能证明"表建出来了"，而这条证明的是"工作区里**不该有**这张表"——
   * 后者才是这次变更的目的。哪天有人把日志又写回工作区库，这里会立刻红。
   */
  it('工作区库里不再有应用日志表（应用日志属于 AppData，不属于工作区）', () => {
    const db = memoryDb();
    runMigrations(db);

    const tables = (
      db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{
        name: string;
      }>
    ).map((r) => r.name);

    expect(tables).not.toContain('app_logs');

    // 它的索引也必须一起消失，否则会留下指向空表的索引
    const indexes = (
      db.prepare("SELECT name FROM sqlite_master WHERE type='index'").all() as Array<{
        name: string;
      }>
    ).map((r) => r.name);
    expect(indexes).not.toContain('idx_app_logs_trace');
    expect(indexes).not.toContain('idx_app_logs_level');

    // 作业日志是"项目上的操作"的记录，**留在工作区**：别误删
    expect(tables).toContain('job_logs');
    expect(tables).toContain('jobs');
  });

  /**
   * 0.2.0：移除"全局标签"（决策记录 #27）。
   *
   * 这条**替代**了原来的"标签唯一索引对 NULL 作用域同样生效（IFNULL 归一化）"——
   * 那条测的是 `project_id` 可空时的行为，而迁移 0006 已经把这一列改成 NOT NULL，
   * 语义变了就得改测试，不能留一条已经不成立的绿。
   *
   * 这里顺带补上"列的可空性"检查：原来的双向漂移测试只比对**列名**，
   * 所以"迁移里是 NOT NULL、schema.ts 里写成可空"这类脱节它抓不到。
   */
  it('标签与工单类型的 project_id 都是 NOT NULL（列结构 + 实际写入都要拦）', () => {
    const db = memoryDb();
    runMigrations(db);
    const now = 1_700_000_000_000;

    for (const table of ['tags', 'ticket_types']) {
      const columns = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{
        name: string;
        notnull: number;
      }>;
      const projectId = columns.find((c) => c.name === 'project_id');
      expect(projectId, `${table} 缺少 project_id 列`).toBeDefined();
      expect(projectId?.notnull, `${table}.project_id 必须是 NOT NULL`).toBe(1);
    }

    // 真的写一条 NULL 进去：必须被拒
    expect(() =>
      db
        .prepare(
          'INSERT INTO tags (id, project_id, name, color, created_at, updated_at) VALUES (?, NULL, ?, ?, ?, ?)',
        )
        .run('t1', '重要', '#f00', now, now),
    ).toThrow();
  });

  it('同一项目内标签不能重名，不同项目可以同名（唯一索引回到 (project_id, name)）', () => {
    const db = memoryDb();
    runMigrations(db);
    const now = 1_700_000_000_000;

    db.prepare(
      "INSERT INTO projects (id, name, status, sort_order, created_at, updated_at) VALUES ('p1', 'P1', 'active', 0, ?, ?)",
    ).run(now, now);
    db.prepare(
      "INSERT INTO projects (id, name, status, sort_order, created_at, updated_at) VALUES ('p2', 'P2', 'active', 0, ?, ?)",
    ).run(now, now);

    const insert = db.prepare(
      'INSERT INTO tags (id, project_id, name, color, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
    );
    insert.run('t1', 'p1', '紧急', '#f00', now, now);
    expect(() => insert.run('t2', 'p1', '紧急', '#f00', now, now)).toThrow();
    expect(() => insert.run('t3', 'p2', '紧急', '#f00', now, now)).not.toThrow();
  });

  /**
   * 老库升级：这条是最要紧的一条 —— 迁移 0006 会**重建两张表**，
   * 重建意味着"有数据丢失的可能"，所以必须证明"该留的都留了"。
   *
   * 做法：先只跑到 0005（模拟用户手上那份老库），塞进项目标签、全局标签、
   * 全局工单类型，再跑完整迁移，然后逐条核对。
   */
  it('从 0005 升级到 0006：项目标签与工单类型都保住，全局行只被"留证"不静默消失', () => {
    const db = memoryDb();
    const upTo0005 = MIGRATIONS.filter((m) => m.id <= '0005_calendar_marks');
    runMigrations(db, { migrations: upTo0005 });

    const now = 1_700_000_000_000;
    db.prepare(
      "INSERT INTO projects (id, name, status, sort_order, created_at, updated_at) VALUES ('p1', 'P1', 'active', 0, ?, ?)",
    ).run(now, now);
    const insertTag = db.prepare(
      'INSERT INTO tags (id, project_id, name, color, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
    );
    insertTag.run('keep', 'p1', '项目标签', '#0f0', now, now);
    insertTag.run('global', null, '全局标签', '#00f', now, now);
    db.prepare(
      "INSERT INTO ticket_types (id, project_id, name, prefix, icon, created_at, updated_at) VALUES ('tt-keep', 'p1', '需求', 'REQ', NULL, ?, ?)",
    ).run(now, now);
    db.prepare(
      "INSERT INTO ticket_types (id, project_id, name, prefix, icon, created_at, updated_at) VALUES ('tt-global', NULL, '全局需求', 'GREQ', NULL, ?, ?)",
    ).run(now, now);

    const result = runMigrations(db);

    expect(result.applied).toContain('0006_project_scoped_shared_data');

    const tagIds = (db.prepare('SELECT id FROM tags ORDER BY id').all() as Array<{ id: string }>).map(
      (r) => r.id,
    );
    expect(tagIds).toEqual(['keep']);

    const typeIds = (
      db.prepare('SELECT id FROM ticket_types ORDER BY id').all() as Array<{ id: string }>
    ).map((r) => r.id);
    expect(typeIds).toEqual(['tt-keep']);

    // 被移除的行留在留证表里（能查到内容，不是"静默消失"）
    const removed = db
      .prepare('SELECT id, source_table, payload FROM removed_projectless_rows ORDER BY id')
      .all() as Array<{ id: string; source_table: string; payload: string }>;
    expect(removed.map((r) => r.id)).toEqual(['tags:global', 'ticket_types:tt-global']);
    expect(removed[0]?.payload).toContain('全局标签');
    expect(removed[1]?.payload).toContain('全局需求');

    // 外键仍然完好：迁移跑完后连接上的不变量是"外键开着"
    expect(db.pragma('foreign_keys', { simple: true })).toBe(1);
    expect(db.pragma('foreign_key_check')).toEqual([]);
  });
});

describe('连接管理', () => {
  it('文件库启用 WAL 与外键', async () => {
    const conn = new DbConnection();
    cleanups.push(() => conn.close());
    conn.open(await filePath());

    const stats = conn.stats();
    expect(stats.journalMode).toBe('wal');
    expect(conn.sqlite.pragma('foreign_keys', { simple: true })).toBe(1);
  });

  it('内存库不报错（WAL 不适用）', () => {
    const conn = new DbConnection();
    cleanups.push(() => conn.close());
    conn.open(':memory:');
    expect(conn.stats().journalMode).toBe('memory');
  });

  it('打开时自动执行迁移，并记录结果', () => {
    const conn = new DbConnection();
    cleanups.push(() => conn.close());
    conn.open(':memory:');

    expect(conn.lastMigration?.applied).toEqual(MIGRATIONS.map((m) => m.id));
  });

  it('可以关闭自动迁移（由调用方控制时机）', () => {
    const conn = new DbConnection({ autoMigrate: false });
    cleanups.push(() => conn.close());
    conn.open(':memory:');

    expect(conn.lastMigration).toBeUndefined();
    expect(pendingMigrations(conn.sqlite)).toEqual(MIGRATIONS.map((m) => m.id));
  });

  it('重复 open 抛错而不是静默重开（避免 WAL 文件残留）', async () => {
    const conn = new DbConnection();
    cleanups.push(() => conn.close());
    const first = await filePath('a.db');
    const second = await filePath('b.db');

    conn.open(first);
    expect(() => conn.open(second)).toThrow(/已打开/);
  });

  it('switchTo 会关闭旧库并打开新库', async () => {
    const conn = new DbConnection();
    cleanups.push(() => conn.close());
    const first = await filePath('first.db');
    const second = await filePath('second.db');

    conn.open(first);
    expect(conn.path).toBe(first);
    expect(conn.stats().journalMode).toBe('wal');

    conn.switchTo(second);
    expect(conn.path).toBe(second);
    expect(conn.isOpen()).toBe(true);
    // 新库同样完成了迁移
    expect(appliedMigrations(conn.sqlite)).toEqual(MIGRATIONS.map((m) => m.id));
  });

  it('close 之后访问 db/sqlite/path 都会抛错（而不是拿到 undefined）', () => {
    const conn = new DbConnection();
    conn.open(':memory:');
    conn.close();

    expect(conn.isOpen()).toBe(false);
    expect(() => conn.db).toThrow(/尚未打开/);
    expect(() => conn.sqlite).toThrow(/尚未打开/);
    expect(() => conn.path).toThrow(/尚未打开/);
    // close 幂等
    expect(() => conn.close()).not.toThrow();
  });

  it('打开失败时回滚为未打开状态（不留半残连接）', () => {
    const conn = new DbConnection();
    expect(() => conn.open('Z:\\definitely-missing-dir\\x.db')).toThrow();
    expect(conn.isOpen()).toBe(false);
  });
});

describe('外键约束真实生效', () => {
  function openConn(): DbConnection {
    const conn = new DbConnection();
    cleanups.push(() => conn.close());
    conn.open(':memory:');
    return conn;
  }

  it('删除项目会级联删除任务（不产生孤儿数据）', () => {
    const conn = openConn();
    const now = 1_700_000_000_000;

    conn.db
      .insert(schema.projects)
      .values({ id: 'p1', name: '测试项目', createdAt: now, updatedAt: now })
      .run();
    conn.db
      .insert(schema.tasks)
      .values({ id: 't1', projectId: 'p1', title: '任务一', createdAt: now, updatedAt: now })
      .run();

    expect(conn.sqlite.prepare('SELECT COUNT(*) AS c FROM tasks').get()).toEqual({ c: 1 });

    conn.db.delete(schema.projects).where(eq(schema.projects.id, 'p1')).run();

    expect(conn.sqlite.prepare('SELECT COUNT(*) AS c FROM tasks').get()).toEqual({ c: 0 });
  });

  it('插入指向不存在项目的任务会被拒绝', () => {
    const conn = openConn();
    const now = 1_700_000_000_000;

    expect(() =>
      conn.db
        .insert(schema.tasks)
        .values({ id: 't1', projectId: '不存在', title: '孤儿任务', createdAt: now, updatedAt: now })
        .run(),
    ).toThrow();
  });

  it('删除任务会级联删除它的依赖关系', () => {
    const conn = openConn();
    const now = 1_700_000_000_000;

    conn.db
      .insert(schema.projects)
      .values({ id: 'p1', name: 'P', createdAt: now, updatedAt: now })
      .run();
    for (const id of ['a', 'b']) {
      conn.db
        .insert(schema.tasks)
        .values({ id, projectId: 'p1', title: id, createdAt: now, updatedAt: now })
        .run();
    }
    conn.db
      .insert(schema.taskDependencies)
      .values({ id: 'd1', predecessorId: 'a', successorId: 'b', createdAt: now })
      .run();

    conn.db.delete(schema.tasks).where(eq(schema.tasks.id, 'a')).run();

    expect(conn.sqlite.prepare('SELECT COUNT(*) AS c FROM task_dependencies').get()).toEqual({
      c: 0,
    });
  });
});
