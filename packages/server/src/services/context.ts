/**
 * 服务层上下文。
 *
 * 关键点：`db` 与 `sqlite` 都是 **getter，委托给连接对象**，而不是在构造时
 * 抓取一次。这样即使之后切换了工作区（切换会关闭旧连接、打开新库），
 * 同一个上下文对象依然指向正确的库 —— 否则会出现"切了工作区但服务还在
 * 往旧库里写"这种极其难查的问题。
 */

import type BetterSqlite3 from 'better-sqlite3';

import type { DbConnection, WorkspaceDb } from '../db/connection.js';
import type { Logger } from '../logging/logger.js';
import { newEntityId } from '../util/id.js';

type SqliteDb = BetterSqlite3.Database;

export interface ServiceContext {
  readonly conn: DbConnection;
  readonly logger: Logger;
  /** 本地模式固定为 'local-user'，远程模式替换为登录用户 */
  readonly actorId: string;
  /**
   * 工作区根目录。
   *
   * 服务层需要它来操作"项目文件夹"（0.1.2 起：一个项目 = 工作区里的一个文件夹）。
   * 可选是因为测试里的内存库没有真实目录；**真实运行时由桌面端注入**。
   */
  readonly workspaceRoot?: string;
  /**
   * 工作日志（Word）的默认保存目录。
   *
   * 由桌面端在启动时注入（默认是 `<文档>\项目管理系统\工作日志`，可在设置里改）。
   * 可选是因为测试里的内存库没有真实目录；真正要写文件时若既没注入、
   * 调用方也没指定目录，服务会明确报错而不是写到一个猜出来的位置
   * （见 services/work-log.ts 的 `resolveWorkLogDir`）。
   */
  readonly workLogDir?: string;
  readonly db: WorkspaceDb;
  readonly sqlite: SqliteDb;
  now(): number;
  newId(): string;
}

export interface ServiceContextOptions {
  conn: DbConnection;
  logger: Logger;
  actorId?: string;
  workspaceRoot?: string;
  workLogDir?: string;
  now?: () => number;
  newId?: () => string;
}

export function createServiceContext(options: ServiceContextOptions): ServiceContext {
  const now = options.now ?? (() => Date.now());
  const newId = options.newId ?? (() => newEntityId(now()));

  return {
    conn: options.conn,
    logger: options.logger,
    actorId: options.actorId ?? 'local-user',
    ...(options.workspaceRoot ? { workspaceRoot: options.workspaceRoot } : {}),
    ...(options.workLogDir ? { workLogDir: options.workLogDir } : {}),
    get db(): WorkspaceDb {
      return options.conn.db;
    },
    get sqlite(): SqliteDb {
      return options.conn.sqlite;
    },
    now,
    newId,
  };
}

/**
 * 在事务里执行一段操作。
 *
 * 刻意用 better-sqlite3 的原生事务而不是 Drizzle 的事务 API：
 * 两者底层是同一个同步连接，所以事务体内的 Drizzle 查询天然落在事务里。
 * 这样既拿到了原子性，又不用和 Drizzle 的事务类型参数较劲。
 *
 * better-sqlite3 对嵌套事务会自动使用 SAVEPOINT，因此服务之间互相调用
 * （外层已开事务、内层再开）是安全的。
 */
export function inTransaction<T>(ctx: ServiceContext, fn: () => T): T {
  return ctx.sqlite.transaction(fn)();
}
