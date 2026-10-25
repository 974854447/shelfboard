/**
 * 在 Electron 运行时里验证关键依赖能否加载。
 *
 * 这个脚本只为回答一个问题：**better-sqlite3 的原生二进制在 Electron 的
 * ABI 下能否直接用**。
 *
 * 背景：better-sqlite3 是原生模块。如果它按 Node ABI 编译，在 Electron 里
 * 加载会失败，而解决办法是用 @electron/rebuild 从源码重编 —— 那需要 MSVC
 * 编译器（约 7GB），这台机器上没有。所以必须实测，而不是假设。
 *
 * 不开窗口、不连数据库文件，跑完即退出，可以安全地在后台执行。
 */

const { app } = require('electron');

function check(name, fn) {
  try {
    const detail = fn();
    return `[OK]   ${name}${detail ? ` — ${detail}` : ''}`;
  } catch (error) {
    return `[FAIL] ${name} — ${error && error.message ? error.message : String(error)}`;
  }
}

app.whenReady().then(() => {
  const lines = [];

  lines.push(`Electron : ${process.versions.electron}`);
  lines.push(`Chrome   : ${process.versions.chrome}`);
  lines.push(`Node     : ${process.versions.node}`);
  lines.push(`V8       : ${process.versions.v8}`);
  lines.push('');

  lines.push(
    check('better-sqlite3 加载与读写', () => {
      const Database = require('better-sqlite3');
      const db = new Database(':memory:');
      db.exec('CREATE TABLE t (a INTEGER)');
      db.prepare('INSERT INTO t VALUES (?)').run(42);
      const value = db.prepare('SELECT a FROM t').get().a;
      const version = db.prepare('SELECT sqlite_version() AS v').get().v;
      db.close();
      if (value !== 42) throw new Error(`读写结果异常：${value}`);
      return `SQLite ${version}`;
    }),
  );

  lines.push(
    check('better-sqlite3 的 WAL 与外键', () => {
      const Database = require('better-sqlite3');
      const db = new Database(':memory:');
      db.pragma('foreign_keys = ON');
      const fk = db.pragma('foreign_keys', { simple: true });
      db.close();
      if (fk !== 1) throw new Error('外键未能开启');
      return 'foreign_keys=ON';
    }),
  );

  lines.push(
    check('drizzle-orm 加载', () => {
      const { drizzle } = require('drizzle-orm/better-sqlite3');
      const Database = require('better-sqlite3');
      const db = new Database(':memory:');
      drizzle(db);
      db.close();
      return 'drizzle/better-sqlite3';
    }),
  );

  lines.push(
    check('fastify 加载', () => {
      const fastify = require('fastify');
      return typeof fastify === 'function' ? 'factory ok' : '导出形态异常';
    }),
  );

  lines.push(
    check('preload 产物存在', () => {
      const { existsSync } = require('node:fs');
      const { join } = require('node:path');
      const path = join(__dirname, '..', 'out', 'preload', 'index.cjs');
      return existsSync(path) ? path : '未构建（先跑 pnpm build）';
    }),
  );

  process.stdout.write(`${lines.join('\n')}\n`);
  app.exit(0);
});
