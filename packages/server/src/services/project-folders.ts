/**
 * 项目文件夹：一个项目 = 工作区里的一个文件夹。
 *
 * 模型（0.1.2 起）：
 *
 * ```
 * 工作区/
 * ├─ workspace.db          ← 管理数据（项目登记、任务、看板、标签…）
 * └─ 我的项目/              ← 项目在这里"工作"
 *    ├─ （代码就在这一层，可直接用编辑器打开；模板生成是 M4 的事）
 *    ├─ attachments/        ← 该项目的附件
 *    └─ logs/               ← 该项目的作业输出与相关错误
 * ```
 *
 * 三条设计约束：
 *
 * 1. **文件夹名来自项目名**，因为用户是在资源管理器里认文件夹的；但必须清洗
 *    （Windows 非法字符、保留名、结尾的点与空格）并去重。
 * 2. **文件夹一旦建好就不再改**。项目改名不会搬动文件夹 —— 静默移动用户磁盘上的
 *    目录是"数据不见了"那一类事故，宁可让名字与文件夹不完全一致。
 * 3. **删除项目不删文件夹**。里面可能已经有用户自己写的代码，删了不可逆。
 */

import { existsSync, mkdirSync, rmdirSync } from 'node:fs';
import { join } from 'node:path';

import { and, eq, isNull, sql } from 'drizzle-orm';

import { projects } from '../db/schema.js';
import { inTransaction, type ServiceContext } from './context.js';

/**
 * Windows 不允许出现在文件名里的字符。
 *
 * 控制字符（U+0000–U+001F）也一并去掉：项目名是从界面输入来的，
 * 粘贴进来的文本里带一个不可见的控制字符，会在磁盘上变成一个打不开的目录名。
 * 这里用 `\p{Cc}`（Unicode 控制类）而不是 `\x00-\x1f` 字面量 —— 后者会被
 * `no-control-regex` 规则拦下，而且前者语义更准确。
 */
const ILLEGAL_CHARS = /[<>:"/\\|?*\p{Cc}]/gu;

/** Windows 保留设备名（不区分大小写，且带扩展名也算） */
const RESERVED_NAMES = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

/** 文件夹名的长度上限：给路径留余量，也避免长名字在资源管理器里被截断 */
const MAX_FOLDER_NAME_LENGTH = 60;

/**
 * 项目名 → 安全的文件夹名。
 *
 * 返回空串表示这个名字没法用（调用方需要兜底），而不是抛错 ——
 * "名字里全是非法字符"是用户输入问题，不该让创建项目失败。
 */
export function sanitizeFolderName(name: string): string {
  let cleaned = name
    .replace(ILLEGAL_CHARS, ' ')
    // 连续空白折成一个空格：避免出现 "a    b" 这种在资源管理器里很难看的名字
    .replace(/\s+/g, ' ')
    .trim();

  // 结尾的点和空格在 Windows 上会被静默丢掉，导致"我们以为的名字"和"实际的名字"不一致
  cleaned = cleaned.replace(/[. ]+$/g, '').trim();

  // 按码点截断：直接 slice 可能把 emoji 的代理对切成半个字符
  const points = Array.from(cleaned);
  if (points.length > MAX_FOLDER_NAME_LENGTH) {
    cleaned = points.slice(0, MAX_FOLDER_NAME_LENGTH).join('').trim();
  }

  if (cleaned.length === 0) return '';
  if (RESERVED_NAMES.test(cleaned)) return `${cleaned}_`;
  return cleaned;
}

/** 该文件夹名是否已被**其他项目**登记（同一工作区内不允许两个项目共用一个文件夹） */
function folderTaken(ctx: ServiceContext, folder: string, exceptProjectId?: string): boolean {
  const rows = ctx.db
    .select({ id: projects.id })
    .from(projects)
    .where(
      exceptProjectId
        ? and(eq(projects.folder, folder), sql`${projects.id} <> ${exceptProjectId}`)
        : eq(projects.folder, folder),
    )
    .all();
  return rows.length > 0;
}

/**
 * 在工作区里为项目分配一个不冲突的文件夹名。
 *
 * 同时避开**磁盘上已存在**的目录：那个目录可能是用户自己建的（或上一个被删掉的项目留下的），
 * 直接拿来用会把两件事混在一起。
 */
export function allocateFolderName(
  ctx: ServiceContext,
  workspaceRoot: string,
  projectName: string,
): string {
  const base = sanitizeFolderName(projectName) || `project-${ctx.newId().slice(-6)}`;

  for (let index = 1; index < 1000; index += 1) {
    const candidate = index === 1 ? base : `${base}-${index}`;
    const taken =
      folderTaken(ctx, candidate) || existsSync(join(workspaceRoot, candidate));
    if (!taken) return candidate;
  }

  // 实在找不到（几千个同名项目）就用 id 保证唯一，而不是抛错
  return `${base}-${ctx.newId()}`;
}

export interface ProjectFolderResult {
  /** 绝对路径 */
  path: string;
  /** 这次是否真的创建了目录 */
  created: boolean;
  /** 是否创建了项目自己的子目录（attachments / logs） */
  subdirs: string[];
}

/**
 * 建出项目文件夹及其子目录（幂等）。
 *
 * 子目录的意义：attachments 是 M3 的事、logs 现在就有写入者，
 * 先把位置定死，免得以后又要为"日志到底放哪"再做一次迁移。
 */
export function ensureProjectFolder(workspaceRoot: string, folder: string): ProjectFolderResult {
  const path = join(workspaceRoot, folder);
  const created = !existsSync(path);
  mkdirSync(path, { recursive: true });

  const subdirs = ['attachments', 'logs'];
  for (const sub of subdirs) {
    mkdirSync(join(path, sub), { recursive: true });
  }

  return { path, created, subdirs };
}

/** 尽力删掉一个（刚建出来的）空目录，用于创建项目失败后的回滚 */
function removeIfEmpty(path: string): void {
  try {
    rmdirSync(join(path, 'attachments'));
    rmdirSync(join(path, 'logs'));
    rmdirSync(path);
  } catch {
    // 非空或已被删掉：留着就好，不要为了清理再抛一个错出来
  }
}

export interface CreateFolderOutcome {
  folder: string;
  path: string;
}

/**
 * 给一个**新建**的项目准备文件夹。
 *
 * 顺序是"先分配名字 → 建目录 → 返回"，由调用方在事务里落库；
 * 建目录失败时调用方会回滚，并通过 `discardNewFolder` 收尾。
 */
export function prepareProjectFolder(
  ctx: ServiceContext,
  projectName: string,
): CreateFolderOutcome | null {
  const root = ctx.workspaceRoot;
  if (!root) return null;

  const folder = allocateFolderName(ctx, root, projectName);
  const result = ensureProjectFolder(root, folder);
  return { folder, path: result.path };
}

/** 创建项目失败时把刚建出来的空目录收掉（不递归，非空就留着） */
export function discardNewFolder(path: string | null | undefined): void {
  if (path) removeIfEmpty(path);
}

export interface BackfillResult {
  created: { id: string; name: string; folder: string }[];
}

/**
 * 给**已有**项目补建文件夹（幂等）。
 *
 * 0.1.1 及更早的项目只有数据库记录、没有文件夹，所以升级后要补一次。
 * 只处理"还活着且没有文件夹"的项目：
 * - 已删除/归档的不碰（归档的也算还在用，会补）；
 * - 已经有 `folder` 的跳过（哪怕目录被用户在资源管理器里删了也不会重建 ——
 *   重建一个空目录只会让人以为"我的代码回来了"，反而更混乱）。
 */
export function ensureProjectFolders(ctx: ServiceContext): BackfillResult {
  const root = ctx.workspaceRoot;
  if (!root) return { created: [] };

  const pending = ctx.db
    .select({ id: projects.id, name: projects.name })
    .from(projects)
    .where(and(isNull(projects.folder), isNull(projects.deletedAt)))
    .all();

  const created: BackfillResult['created'] = [];

  for (const row of pending) {
    const allocated = inTransaction(ctx, () => {
      const folder = allocateFolderName(ctx, root, row.name);
      ensureProjectFolder(root, folder);
      ctx.db
        .update(projects)
        .set({ folder, updatedAt: ctx.now() })
        .where(eq(projects.id, row.id))
        .run();
      return folder;
    });
    created.push({ id: row.id, name: row.name, folder: allocated });
  }

  return { created };
}
