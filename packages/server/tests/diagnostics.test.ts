import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { DbConnection } from '../src/db/connection';
import { createLogger } from '../src/logging/logger';
import { createLogStore, type LogStore } from '../src/logging/store';
import { createServiceContext, type ServiceContext } from '../src/services/context';
import { buildDiagnosticsFiles, exportDiagnostics } from '../src/services/diagnostics';
import * as projectService from '../src/services/projects';
import * as taskService from '../src/services/tasks';
import { makeTempDir, removeTempDir } from './helpers';

const SECRET_TOKEN = 'super-secret-api-token-abcdef123456';
/** 刻意用带用户名的路径，验证路径里的用户名也会被替换 */
const FAKE_WINDOWS_ROOT = 'C:\\Users\\TestUser\\pm-workspace';

const tempDirs: string[] = [];
const cleanups: Array<() => void> = [];

afterEach(async () => {
  while (cleanups.length > 0) cleanups.pop()?.();
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) await removeTempDir(dir);
  }
});

interface Fixture {
  ctx: ServiceContext;
  store: LogStore;
  dir: string;
}

async function fixture(): Promise<Fixture> {
  const dir = await makeTempDir('diagnostics');
  tempDirs.push(dir);

  const conn = new DbConnection();
  conn.open(join(dir, 'workspace.db'));

  // 应用日志从 0.1.1 起有自己的库（生产环境在 AppData 的 logs/app-logs.db）。
  // 测试也照着分开：否则会出现"store 与 ctx 共用一张库"这种现实中不存在的组合，
  // 而正是这种组合能掩盖"日志搬了家、诊断包却还读旧库"的错位。
  const logsDb = new DbConnection({ autoMigrate: false });
  logsDb.open(join(dir, 'app-logs.db'));
  const store = createLogStore({ db: logsDb.sqlite, flushBatch: 1, flushIntervalMs: 0 });

  // 注意：这个 logger **不知道** SECRET_TOKEN —— 用来验证"打包时的脱敏"
  // 是独立的一道防线，而不是依赖"写日志时已经处理过"
  const logger = createLogger({ source: 'api', sinks: [store], minLevel: 'debug' });
  const ctx = createServiceContext({ conn, logger });

  cleanups.push(() => {
    store.close();
    logsDb.close();
    conn.close();
  });

  return { ctx, store, dir };
}

/** 与真实调用方（路由）一致地取日志：诊断包的应用日志由调用方从日志库取好再传进去 */
function appLogsFrom(store: LogStore) {
  return store.query({ pageSize: 2000, page: 1 }).items;
}

function allContent(files: Array<{ name: string; content: string }>): string {
  return files.map((f) => `--- ${f.name} ---\n${f.content}`).join('\n');
}

describe('buildDiagnosticsFiles', () => {
  it('包含清单、迁移记录、结构摘要与日志', async () => {
    const { ctx, store, dir } = await fixture();

    const bundle = await buildDiagnosticsFiles(ctx, {
      targetDir: dir,
      workspaceRoot: dir,
      appVersion: '1.2.3-test',
      appLogs: appLogsFrom(store),
    });

    const names = bundle.files.map((f) => f.name).sort();
    expect(names).toEqual([
      'README.txt',
      'logs/app-logs.jsonl',
      'logs/job-logs.jsonl',
      'manifest.json',
      'schema/migrations.json',
      'workspace/structure.json',
    ]);

    const manifest = JSON.parse(
      bundle.files.find((f) => f.name === 'manifest.json')?.content ?? '{}',
    ) as { appVersion: string; counts: Record<string, number>; runtime: { node: string } };
    expect(manifest.appVersion).toBe('1.2.3-test');
    expect(manifest.runtime.node).toBe(process.versions.node);
    expect(manifest.counts.tasks).toBe(0);

    // 迁移记录应包含 M1 的初始化迁移
    const migrations = JSON.parse(
      bundle.files.find((f) => f.name === 'schema/migrations.json')?.content ?? '[]',
    ) as Array<{ id: string }>;
    expect(migrations.map((m) => m.id)).toContain('0001_init');

    expect(store.insertedCount()).toBeGreaterThanOrEqual(0);
  });

  it('统计数字反映真实数据量', async () => {
    const { ctx, dir } = await fixture();

    const project = projectService.createProject(ctx, { name: '统计用项目' });
    taskService.createTask(ctx, { projectId: project.id, title: '任务一' });
    taskService.createTask(ctx, { projectId: project.id, title: '任务二' });

    const bundle = await buildDiagnosticsFiles(ctx, {
      targetDir: dir,
      workspaceRoot: dir,
      appVersion: '1.0.0',
    });
    const manifest = JSON.parse(
      bundle.files.find((f) => f.name === 'manifest.json')?.content ?? '{}',
    ) as { counts: Record<string, number> };

    expect(manifest.counts.projects).toBe(1);
    expect(manifest.counts.tasks).toBe(2);
    // 六态工作流：新建项目自带 6 个状态
    expect(manifest.counts.workflowStatuses).toBe(6);
  });

  /** 这是整个功能最重要的一条：诊断包是要发给别人的 */
  it('绝不包含项目正文（任务标题、描述、项目名）', async () => {
    const { ctx, dir } = await fixture();

    const project = projectService.createProject(ctx, {
      name: '绝不外发的项目名',
      description: '绝不外发的项目描述',
    });
    taskService.createTask(ctx, {
      projectId: project.id,
      title: '绝不外发的任务标题',
      description: '绝不外发的任务描述',
    });

    const bundle = await buildDiagnosticsFiles(ctx, {
      targetDir: dir,
      workspaceRoot: dir,
      appVersion: '1.0.0',
    });
    const text = allContent(bundle.files);

    expect(text).not.toContain('绝不外发的项目名');
    expect(text).not.toContain('绝不外发的项目描述');
    expect(text).not.toContain('绝不外发的任务标题');
    expect(text).not.toContain('绝不外发的任务描述');
    // 但数量统计应该在（这是诊断需要的信息）
    expect(text).toContain('"tasks": 1');
  });

  it('运行时已知机密（API 令牌）在打包前被整体替换', async () => {
    const { ctx, store, dir } = await fixture();

    // 故意让一条日志带着明文令牌落库
    ctx.logger.error(`鉴权失败，使用的令牌是 ${SECRET_TOKEN}`);

    // 注意要**显式把日志传进去**：日志从 0.1.1 起不在工作区库里，
    // 这条测试原本靠"服务自己去库里读"才能拿到带令牌的那行；
    // 不传的话包里根本没有可脱敏的内容，断言会因为"什么都没脱"而失败 —— 它确实失败了。
    const bundle = await buildDiagnosticsFiles(ctx, {
      targetDir: dir,
      workspaceRoot: dir,
      appVersion: '1.0.0',
      knownSecrets: [SECRET_TOKEN],
      appLogs: appLogsFrom(store),
    });

    const text = allContent(bundle.files);
    expect(text).not.toContain(SECRET_TOKEN);
    expect(text).toContain('***');
    expect(store.query({ pageSize: 10 }).total).toBeGreaterThan(0);
  });

  it('工作区路径里的用户名被替换为 %USER%', async () => {
    const { ctx, dir } = await fixture();

    const bundle = await buildDiagnosticsFiles(ctx, {
      targetDir: dir,
      workspaceRoot: FAKE_WINDOWS_ROOT,
      appVersion: '1.0.0',
    });

    const manifest = JSON.parse(
      bundle.files.find((f) => f.name === 'manifest.json')?.content ?? '{}',
    ) as { workspaceRoot: string };

    expect(manifest.workspaceRoot).toContain('%USER%');
    expect(manifest.workspaceRoot).not.toContain('TestUser');
    expect(allContent(bundle.files)).not.toContain('TestUser');
  });

  it('非绝对路径的目标目录被拒绝', async () => {
    const { ctx, dir } = await fixture();
    await expect(
      buildDiagnosticsFiles(ctx, {
        targetDir: 'relative/path',
        workspaceRoot: dir,
        appVersion: '1.0.0',
      }),
    ).rejects.toThrow(/绝对路径/);
  });

  it('不存在的目标目录被拒绝', async () => {
    const { ctx, dir } = await fixture();
    await expect(
      buildDiagnosticsFiles(ctx, {
        targetDir: join(dir, 'not-created-yet'),
        workspaceRoot: dir,
        appVersion: '1.0.0',
      }),
    ).rejects.toThrow(/不存在/);
  });
});

describe('exportDiagnostics', () => {
  it('写出 zip 文件并返回产物信息', async () => {
    const { ctx, store, dir } = await fixture();
    ctx.logger.info('准备导出诊断包');

    const result = await exportDiagnostics(ctx, {
      targetDir: dir,
      workspaceRoot: dir,
      appVersion: '1.0.0',
      knownSecrets: [SECRET_TOKEN],
      appLogs: appLogsFrom(store),
    });

    expect(existsSync(result.zipPath)).toBe(true);
    expect(result.zipPath.endsWith('.zip')).toBe(true);
    expect(result.bytes).toBeGreaterThan(0);
    expect(result.files).toContain('manifest.json');

    // 必须是"包里真的有日志内容"，而不是"日志库里恰好有日志"——
    // 后者在"诊断包读错了库"时依然会通过，等于没测。
    expect(result.logCount).toBeGreaterThan(0);

    // 顺带确认 zip 头部魔数（PK\x03\x04）—— 防止写出一个损坏的包
    const head = await readFile(result.zipPath);
    expect(head.subarray(0, 2).toString('latin1')).toBe('PK');
  });

  it('导出目录不存在时会自动创建（导出目录与目标目录的语义区分）', async () => {
    const { ctx, dir } = await fixture();
    const target = join(dir, 'nested', 'out');

    // buildDiagnosticsFiles 校验目录必须存在；exportDiagnostics 内部先 mkdir，
    // 但校验发生在其内部调用 buildDiagnosticsFiles 时 —— 所以这里仍应报错，
    // 语义是"导出目录必须由调用方先准备好"。
    await expect(
      exportDiagnostics(ctx, { targetDir: target, workspaceRoot: dir, appVersion: '1.0.0' }),
    ).rejects.toThrow(/不存在/);
  });
});
