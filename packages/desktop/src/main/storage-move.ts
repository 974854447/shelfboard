/**
 * 工作区数据库的位置迁移（0.1.1 → 0.1.2）。
 *
 * 老结构：`<工作区>/workspace.db`（数据库躺在项目旁边）
 * 新结构：`<userData>/data/workspace.db`（工作区里只放项目）
 *
 * ## 为什么不能直接 rename
 *
 * SQLite 开了 WAL，最新的写入可能还只在 `workspace.db-wal` 里。
 * 只改名 `.db` 文件，那些写入就留在了**孤儿 WAL** 里 —— 表现是"迁移之后最近建的几个任务没了"，
 * 而且原来的 `-wal` 还在工作区里（既丢了数据，又没达到"工作区只放项目"的目的）。
 *
 * 所以顺序是：**先 checkpoint 把 WAL 合并回主库 → 再改名 → 最后清掉遗留的 -wal/-shm**。
 *
 * ## 失败不阻断启动
 *
 * 改名可能因为文件被占用而失败（例如用户自己开着别的工具）。这时**继续用老路径**并把原因记进日志，
 * 而不是让应用起不来 —— 启动阶段的一次性整理，不该比"应用能用"更重要。
 */

import { existsSync, mkdirSync, renameSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { DbConnection, type Logger } from '@pm-studio/server';

export interface DatabaseLocation {
  /** 本次启动实际使用的数据库路径 */
  path: string;
  /** 这次是否真的搬动了文件 */
  moved: boolean;
  /** 没能搬动时的原因（已记日志，这里返回出来是为了可测） */
  blocked?: string;
  /** 工作区里是否还残留着一个不再使用的老数据库文件 */
  leftover?: string;
}

/**
 * 把 WAL 里的内容合并回主库文件。
 *
 * 用 `DbConnection` 而不是直接开 better-sqlite3：它的 `close()` 本来就会做
 * `wal_checkpoint(TRUNCATE)`（这是"工作区能被安全复制"的前提之一），
 * 正好就是这里需要的那一步。返回 false 表示打不开（例如被别的程序占用），不抛。
 */
function checkpointIntoMainFile(path: string): boolean {
  const conn = new DbConnection({ autoMigrate: false });
  try {
    conn.open(path);
    conn.close();
    return true;
  } catch {
    return false;
  }
}

/**
 * 决定本次启动该用哪个数据库文件，必要时把老的搬过去。
 *
 * 四种情况：
 * 1. 老文件不在、新位置也没有         → 全新工作区，直接用新位置；
 * 2. 老文件在、新位置为空             → 搬（checkpoint → rename → 清理 -wal/-shm）；
 * 3. 新位置已有文件                   → 说明已经搬过，用新位置；老文件若还在就**保留并告警**
 *                                       （不静默删数据库文件，让用户自己确认后处理）；
 * 4. 老文件在但搬不动（被占用等）     → 本次继续用老路径，记警告。
 */
export function resolveWorkspaceDatabase(
  workspaceRoot: string,
  dataDir: string,
  logger: Logger,
): DatabaseLocation {
  const legacy = join(workspaceRoot, 'workspace.db');
  const target = join(dataDir, 'workspace.db');

  const legacyExists = existsSync(legacy);
  const targetExists = existsSync(target);

  if (targetExists) {
    if (legacyExists) {
      logger.warn(
        '新位置的数据库已存在，工作区里还留着一个老的 workspace.db（已不再使用）——请确认后自行删除',
        { leftover: legacy, inUse: target },
      );
      return { path: target, moved: false, leftover: legacy };
    }
    return { path: target, moved: false };
  }

  if (!legacyExists) {
    // 全新工作区：确保目录存在即可
    mkdirSync(dataDir, { recursive: true });
    return { path: target, moved: false };
  }

  try {
    mkdirSync(dataDir, { recursive: true });

    // 关键一步：不先 checkpoint 就改名会丢掉还在 -wal 里的写入
    const checkpointed = checkpointIntoMainFile(legacy);
    if (!checkpointed) {
      throw new Error('无法打开老数据库做 WAL 检查点（可能被其他程序占用）');
    }

    renameSync(legacy, target);

    // 主库已经合并完成，这两个文件没有意义了；留着反而会被 SQLite 当成新库的日志
    for (const suffix of ['-wal', '-shm']) {
      rmSync(`${legacy}${suffix}`, { force: true });
    }

    logger.info('工作区数据库已搬出工作区（工作区里只保留项目）', {
      from: resolve(legacy),
      to: resolve(target),
    });

    return { path: target, moved: true };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    logger.warn('工作区数据库搬迁失败，本次继续使用原位置（不影响使用，日志里有原因）', {
      from: legacy,
      to: target,
      reason,
    });
    return { path: legacy, moved: false, blocked: reason };
  }
}
