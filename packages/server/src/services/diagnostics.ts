/**
 * 诊断包导出。
 *
 * 目的是"能把现场发给别人看"，因此有两条硬纪律：
 *
 * 1. **绝不包含项目正文**。只打包日志、版本、环境信息、结构摘要
 *    （目录名与数量），不打包任何任务/文档/附件的内容。
 * 2. **所有文本一律过脱敏管道**。工作区路径里就含用户名，日志里可能
 *    残留令牌 —— 这个包是要发出去的，脱敏不能只在"写日志时"做一次。
 *
 * 另外刻意**不在这里探测工具链版本**（node/npm/python…）：那需要派生进程，
 * 而派生在受限环境下可能失败，导致"导出诊断包"这个用来排查问题的功能
 * 自己先失败。M4 的环境检测会把结果写进 `env_snapshots`，届时直接读表即可。
 */

import { createWriteStream } from 'node:fs';
import { mkdir, readdir, stat } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { pipeline } from 'node:stream/promises';

import { AppError, type AppLogEntry } from '@pm-studio/shared';
import { desc } from 'drizzle-orm';
import yazl from 'yazl';

import { jobLogs as jobLogsTable } from '../db/schema.js';
import { redactText, type RedactOptions } from '../logging/redact.js';
import type { ServiceContext } from './context.js';

export const DIAGNOSTICS_FORMAT_VERSION = 1;

/** 默认最多打包多少条应用日志 */
export const DEFAULT_MAX_LOGS = 2000;

export interface DiagnosticsOptions {
  /** 导出目录（必须是已存在的绝对路径） */
  targetDir: string;
  /** 工作区根目录，用于生成结构摘要 */
  workspaceRoot: string;
  appVersion: string;
  /**
   * 应用日志。**由调用方从日志库取好再传进来**。
   *
   * 0.1.1 起应用日志不在工作区库里（见 technical-design §17）：这个服务拿到的
   * `ctx` 指向工作区库，读不到日志。所以改成注入 ——
   * 也顺带避免了"日志搬了家、诊断包还读旧库、导出悄悄变空"这类静默错位。
   */
  appLogs?: readonly AppLogEntry[];
  /** 最多打包多少条应用日志，默认 2000（调用方取日志时请用同一口径） */
  maxLogs?: number;
  /** 运行时已知机密（例如本地 API 令牌），会在打包前整体替换 */
  knownSecrets?: readonly string[];
  now?: () => number;
}

export interface DiagnosticsResult {
  zipPath: string;
  bytes: number;
  logCount: number;
  files: string[];
}

interface CountRow {
  c: number;
}

function countOf(ctx: ServiceContext, sql: string, ...params: unknown[]): number {
  const row = ctx.sqlite.prepare(sql).get(...params) as CountRow | undefined;
  return Number(row?.c ?? 0);
}

/** 读工作区顶层目录名（只要名字，不要内容） */
async function workspaceStructure(root: string): Promise<Record<string, string[]>> {
  try {
    const entries = await readdir(root, { withFileTypes: true });
    const dirs = entries.filter((e) => e.isDirectory()).map((e) => e.name).sort();
    const files = entries.filter((e) => e.isFile()).map((e) => e.name).sort();
    return { directories: dirs, files };
  } catch {
    return { directories: [], files: [] };
  }
}

export interface DiagnosticsBundle {
  manifest: Record<string, unknown>;
  /** 已脱敏的文件清单 */
  files: Array<{ name: string; content: string }>;
  logCount: number;
  createdAt: number;
}

/**
 * 组装诊断包内容（不落盘）。
 *
 * 与打包拆开是为了**可测试**：测试可以直接检查"包里到底有没有项目正文、
 * 有没有令牌"，而不必先解一个 zip。
 */
export async function buildDiagnosticsFiles(
  ctx: ServiceContext,
  options: DiagnosticsOptions,
): Promise<DiagnosticsBundle> {
  const now = options.now ?? (() => Date.now());
  const createdAt = now();
  const maxLogs = Math.min(Math.max(options.maxLogs ?? DEFAULT_MAX_LOGS, 1), 20_000);

  if (!isAbsolute(options.targetDir)) {
    throw new AppError('VALIDATION_FAILED', '导出目录必须是绝对路径', {
      details: { targetDir: options.targetDir },
    });
  }

  const targetInfo = await stat(options.targetDir).catch(() => null);
  if (!targetInfo || !targetInfo.isDirectory()) {
    throw new AppError('VALIDATION_FAILED', '导出目录不存在或不是目录', {
      details: { targetDir: options.targetDir },
    });
  }

  const redactOptions: RedactOptions = {
    redactUserName: true,
    ...(options.knownSecrets && options.knownSecrets.length > 0
      ? { knownSecrets: options.knownSecrets }
      : {}),
  };

  /* ---------------- 收集 ---------------- */

  // 应用日志由调用方从日志库注入（工作区库里已经没有这张表了）
  const appLogs = options.appLogs ?? [];

  const jobLogs = ctx.db
    .select()
    .from(jobLogsTable)
    .orderBy(desc(jobLogsTable.ts))
    .limit(maxLogs)
    .all();

  const migrations = ctx.sqlite
    .prepare('SELECT id, applied_at FROM schema_migrations ORDER BY applied_at')
    .all() as Array<{ id: string; applied_at: number }>;

  const structure = await workspaceStructure(options.workspaceRoot);

  const counts = {
    projects: countOf(ctx, 'SELECT COUNT(*) AS c FROM projects WHERE deleted_at IS NULL'),
    projectsArchived: countOf(
      ctx,
      "SELECT COUNT(*) AS c FROM projects WHERE deleted_at IS NULL AND status = 'archived'",
    ),
    workflowStatuses: countOf(ctx, 'SELECT COUNT(*) AS c FROM workflow_statuses'),
    tasks: countOf(ctx, 'SELECT COUNT(*) AS c FROM tasks WHERE deleted_at IS NULL'),
    tasksDeleted: countOf(ctx, 'SELECT COUNT(*) AS c FROM tasks WHERE deleted_at IS NOT NULL'),
    taskDependencies: countOf(ctx, 'SELECT COUNT(*) AS c FROM task_dependencies'),
    tags: countOf(ctx, 'SELECT COUNT(*) AS c FROM tags'),
    milestones: countOf(ctx, 'SELECT COUNT(*) AS c FROM milestones'),
    jobs: countOf(ctx, 'SELECT COUNT(*) AS c FROM jobs'),
  };

  /* ---------------- 组装（全部先脱敏） ---------------- */

  const manifest = {
    formatVersion: DIAGNOSTICS_FORMAT_VERSION,
    createdAt,
    createdAtIso: new Date(createdAt).toISOString(),
    appVersion: options.appVersion,
    workspaceRoot: options.workspaceRoot,
    runtime: {
      node: process.versions.node,
      // 在 Electron 里跑时才有这两项；纯 Node 下为 undefined，用 ?? 兜住
      electron: process.versions.electron ?? null,
      chrome: process.versions.chrome ?? null,
      platform: process.platform,
      arch: process.arch,
    },
    counts,
    note: '本诊断包仅含日志、版本与环境信息，不含任何项目正文、文档内容或附件。',
  };

  const files: Array<{ name: string; content: string }> = [
    {
      name: 'manifest.json',
      content: JSON.stringify(manifest, null, 2),
    },
    {
      name: 'schema/migrations.json',
      content: JSON.stringify(
        migrations.map((m) => ({ id: m.id, appliedAt: m.applied_at })),
        null,
        2,
      ),
    },
    {
      name: 'workspace/structure.json',
      content: JSON.stringify(structure, null, 2),
    },
    {
      // JSONL：一行一条，便于 grep 也便于程序读取
      name: 'logs/app-logs.jsonl',
      content: appLogs.map((row) => JSON.stringify(row)).join('\n'),
    },
    {
      name: 'logs/job-logs.jsonl',
      content: jobLogs.map((row) => JSON.stringify(row)).join('\n'),
    },
    {
      name: 'README.txt',
      content: [
        '项目管理系统 诊断包',
        '',
        `导出时间：${new Date(createdAt).toISOString()}`,
        `应用版本：${options.appVersion}`,
        '',
        '包含内容：',
        '  manifest.json          版本、运行时、各类数据量统计',
        '  schema/migrations.json 数据库迁移记录',
        '  workspace/structure.json 工作区顶层目录与文件名（仅名称）',
        '  logs/app-logs.jsonl    应用日志（已脱敏，最多 ' + maxLogs + ' 条）',
        '  logs/job-logs.jsonl    作业日志（已脱敏，最多 ' + maxLogs + ' 条）',
        '',
        '不包含：项目正文、任务描述、文档内容、附件文件、任何令牌。',
        '若发现仍有敏感信息，请勿直接外发，先联系开发者。',
      ].join('\n'),
    },
  ];

  // 统一过脱敏：把这个包当成"要发出去的东西"来对待，而不是"内部文件"。
  // 注意这一步在**打包之前**，而不是依赖"写日志时已经脱敏过"。
  const safeFiles = files.map((file) => ({
    name: file.name,
    content: redactText(file.content, redactOptions),
  }));

  return { manifest, files: safeFiles, logCount: appLogs.length, createdAt };
}

/** 组装并打包成 zip，返回产物信息 */
export async function exportDiagnostics(
  ctx: ServiceContext,
  options: DiagnosticsOptions,
): Promise<DiagnosticsResult> {
  const bundle = await buildDiagnosticsFiles(ctx, options);

  await mkdir(options.targetDir, { recursive: true });
  const stamp = new Date(bundle.createdAt).toISOString().replace(/[:.]/g, '-');
  const zipPath = join(options.targetDir, `项目管理系统-诊断包-${stamp}.zip`);

  const zip = new yazl.ZipFile();
  for (const file of bundle.files) {
    zip.addBuffer(Buffer.from(file.content, 'utf8'), file.name);
  }
  zip.end();

  await pipeline(zip.outputStream, createWriteStream(zipPath));
  const zipInfo = await stat(zipPath);

  ctx.logger.info('诊断包已导出', {
    zipPath,
    files: bundle.files.map((f) => f.name),
    logCount: bundle.logCount,
    bytes: zipInfo.size,
  });

  return {
    zipPath,
    bytes: zipInfo.size,
    logCount: bundle.logCount,
    files: bundle.files.map((f) => f.name),
  };
}
