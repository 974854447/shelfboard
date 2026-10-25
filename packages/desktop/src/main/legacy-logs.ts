/**
 * 老工作区的一次性整理：把 0.1.0 及更早写在**业务库**里的应用日志导出到工作区之外。
 *
 * ## 为什么需要它
 *
 * 0.1.1 把应用日志搬到了 AppData 的独立库，并新增迁移删除工作区库里的 `app_logs` 表。
 * 但迁移拿不到"工作区之外的路径"，搬不动数据；如果直接删表，
 * 老工作区里那几百条日志就**静默消失**了 —— 用户什么都没看到，数据就没了。
 *
 * 所以顺序必须是：
 *
 * ```
 * open(autoMigrate: false)  →  导出旧日志到文件  →  migrate()（内含删表）
 * ```
 *
 * 反过来的话，`migrate()` 已经把表删了，再导出只能得到空文件。
 *
 * ## 为什么只导出成文件、不写进新的日志库
 *
 * 新日志库由日志存储层自己建表（`APP_LOGS_DDL`），字段口径与它一致才安全。
 * 从"旧库原样搬列"到"新库按存储层的口径写入"这一步，交给日志存储层做才不容易出错；
 * 而这一份导出的价值主要是"数据没丢，能查"，JSONL 已经够用，也便于直接 grep。
 */

import { appendFileSync, writeFileSync } from 'node:fs';

import type { DbConnection, Logger } from '@pm-studio/server';

export interface LegacyAppLogExportResult {
  /** 旧工作区库里是否存在 app_logs 表 */
  hadTable: boolean;
  /** 实际导出到文件的条数 */
  exported: number;
  /** 导出失败时的原因（失败不阻断启动，只记日志） */
  error?: string;
}

/** `app_logs` 是否还在这张工作区库里 */
function hasLegacyTable(conn: DbConnection): boolean {
  const row = conn.sqlite
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'app_logs'")
    .get();
  return row !== undefined;
}

/**
 * 导出旧工作区里的应用日志到 `targetFile`（JSONL）。
 *
 * 幂等且安全：
 * - 表不存在（新工作区、或已经整理过）→ 什么都不做；
 * - 表存在但没有数据 → 也不建文件，避免留下一个空文件让人误会"日志丢了"；
 * - 失败**不抛异常**：这是启动路径上的清理动作，不该因为它让应用起不来。
 */
export function exportLegacyAppLogs(
  conn: DbConnection,
  targetFile: string,
  logger: Logger,
): LegacyAppLogExportResult {
  if (!hasLegacyTable(conn)) return { hadTable: false, exported: 0 };

  try {
    const rows = conn.sqlite.prepare('SELECT * FROM app_logs ORDER BY ts').all();
    if (rows.length === 0) {
      logger.info('老工作区里的应用日志表是空的，无需导出', { table: 'app_logs' });
      return { hadTable: true, exported: 0 };
    }

    // 先清空再写：这个文件只服务于这一次整理，保留上次的残留会让人以为"又导出了一遍"
    writeFileSync(targetFile, '');
    appendFileSync(targetFile, `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`);

    logger.warn('检测到 0.1.0 的老工作区：应用日志已从工作区导出，随后该表会被删除', {
      rows: rows.length,
      exportedTo: targetFile,
    });

    return { hadTable: true, exported: rows.length };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.warn('导出老工作区的应用日志失败，将继续启动（旧表随后由迁移删除）', {
      error: message,
      targetFile,
    });
    return { hadTable: true, exported: 0, error: message };
  }
}
