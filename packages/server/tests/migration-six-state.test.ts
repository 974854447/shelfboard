/**
 * 迁移 0009（六态状态流）的行为测试。
 *
 * 为什么这条迁移值得单测：它**改的是用户已有的数据** —— 老项目里那些
 * "待处理 / 进行中 / 测试中"的任务全被重新指到新状态上，旧状态还会被删掉。
 * 这种迁移写错一次的代价是"用户的任务全堆进一列"，而不是界面上的小毛病。
 *
 * 做法：先把库迁到 0008（也就是 0009 之前的状态），手工造一个"三态老项目"，
 * 再单独跑 0009，然后检查三条不变量：
 *   1. 每个项目都有完整的六态；
 *   2. 老任务**按分类**收敛（done→已完成、doing→正在修改、其余→待完成）；
 *   3. 旧状态被清掉，且每个项目仍然只有一个默认状态（新建任务要有落点）。
 */

import { afterEach, describe, expect, it } from 'vitest';

import { DbConnection } from '../src/db/connection';
import { runMigrations } from '../src/db/migrate';
import { MIGRATIONS } from '../src/db/migrations';

const SIX = ['待完成', '正在修改', '待审查', '审查中', '回退修改', '已完成'];
/** 0009（补齐六态 + 按分类收敛）与 0010（把顺序归一）是一组，必须一起跑 */
const SIX_STATE_MIGRATIONS = MIGRATIONS.filter((m) => m.id >= '0009_six_state_statuses');
const BEFORE = MIGRATIONS.filter((m) => m.id < '0009_six_state_statuses');

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()?.();
});

function openLegacyDb() {
  /*
   * `autoMigrate: false` 必须写在**构造参数**里（`open()` 只接受路径）：
   * 否则 open 会一路迁到最新，六态早就铺好了，后面的"老数据"就白造了 ——
   * 第一版就是把开关传给了 `open()`，测试照样跑，只是什么都没验证到。
   */
  const conn = new DbConnection({ autoMigrate: false });
  conn.open(':memory:');
  cleanups.push(() => conn.close());
  const raw = conn.sqlite;
  // 先只迁到 0008：库里于是是"老结构 + 老数据"，0009 之后由用例自己跑
  runMigrations(raw, { migrations: BEFORE });

  const now = 1_700_000_000_000;
  raw
    .prepare(
      `INSERT INTO projects (id, name, created_at, updated_at, status)
       VALUES ('p_legacy', '老项目', ?, ?, 'active')`,
    )
    .run(now, now);

  const insertStatus = raw.prepare(
    `INSERT INTO workflow_statuses
       (id, project_id, name, color, category, sort_order, is_default, created_at, updated_at)
     VALUES (?, 'p_legacy', ?, '#8a8a8a', ?, ?, ?, ?, ?)`,
  );
  insertStatus.run('s_todo', '待处理', 'todo', 1000, 1, now, now);
  insertStatus.run('s_doing', '进行中', 'doing', 2000, 0, now, now);
  insertStatus.run('s_testing', '测试中', 'doing', 3000, 0, now, now);
  insertStatus.run('s_done', '已完成', 'done', 4000, 0, now, now);

  const insertTask = raw.prepare(
    `INSERT INTO tasks (id, project_id, title, status_id, priority, sort_order, created_at, updated_at)
     VALUES (?, 'p_legacy', ?, ?, 'medium', 1000, ?, ?)`,
  );
  insertTask.run('t_todo', '待处理的任务', 's_todo', now, now);
  insertTask.run('t_doing', '进行中的任务', 's_doing', now, now);
  insertTask.run('t_testing', '测试中的任务', 's_testing', now, now);
  insertTask.run('t_done', '已经做完的任务', 's_done', now, now);

  return raw;
}

describe('迁移 0009 / 0010：六态状态流', () => {
  it('两条迁移都在，且都只做数据规范化（不改表结构）', () => {
    expect(SIX_STATE_MIGRATIONS.map((m) => m.id)).toEqual([
      '0009_six_state_statuses',
      '0010_six_state_order',
    ]);
    // 它们只 INSERT/UPDATE/DELETE 数据，所以不需要关外键
    for (const migration of SIX_STATE_MIGRATIONS) {
      expect(migration.foreignKeysOff, migration.id).toBeUndefined();
    }
  });

  it('给老项目补齐六态、按分类迁移任务、清掉旧状态', () => {
    const raw = openLegacyDb();

    runMigrations(raw, { migrations: SIX_STATE_MIGRATIONS });

    const statuses = raw
      .prepare(
        `SELECT id, name, category, is_default FROM workflow_statuses
         WHERE project_id = 'p_legacy' ORDER BY sort_order`,
      )
      .all() as Array<{ id: string; name: string; category: string; is_default: number }>;

    expect(statuses.map((s) => s.name)).toEqual(SIX);
    // 旧状态必须消失（否则看板上会多出几列空列）
    expect(statuses.map((s) => s.name)).not.toContain('待处理');
    expect(statuses.map((s) => s.name)).not.toContain('进行中');
    expect(statuses.map((s) => s.name)).not.toContain('测试中');
    // 有且只有一个默认状态，且落在「待完成」
    expect(statuses.filter((s) => s.is_default === 1)).toHaveLength(1);
    expect(statuses.find((s) => s.is_default === 1)?.name).toBe('待完成');

    const nameOfTask = (id: string): string | undefined => {
      const row = raw
        .prepare(
          `SELECT w.name AS name FROM tasks t
           JOIN workflow_statuses w ON w.id = t.status_id
           WHERE t.id = ?`,
        )
        .get(id) as { name: string } | undefined;
      return row?.name;
    };

    // 按分类收敛：todo→待完成、doing→正在修改、done→已完成
    expect(nameOfTask('t_todo')).toBe('待完成');
    expect(nameOfTask('t_doing')).toBe('正在修改');
    expect(nameOfTask('t_testing')).toBe('正在修改');
    expect(nameOfTask('t_done')).toBe('已完成');

    // 任务本身一个都不能丢
    const total = raw.prepare("SELECT count(*) AS n FROM tasks WHERE project_id = 'p_legacy'").get() as {
      n: number;
    };
    expect(Number(total.n)).toBe(4);
  });

  it('幂等：再跑一次不会多出一套状态', () => {
    const raw = openLegacyDb();

    runMigrations(raw, { migrations: SIX_STATE_MIGRATIONS });
    // 直接再执行一遍这两段 SQL（模拟"迁移被重复跑到"的最坏情况）
    for (const migration of SIX_STATE_MIGRATIONS) raw.exec(migration.up);

    const statuses = raw
      .prepare("SELECT name FROM workflow_statuses WHERE project_id = 'p_legacy' ORDER BY sort_order")
      .all() as Array<{ name: string }>;
    expect(statuses.map((s) => s.name)).toEqual(SIX);
  });
});
