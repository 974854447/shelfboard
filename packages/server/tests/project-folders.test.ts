import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { DbConnection } from '../src/db/connection';
import { createLogger } from '../src/logging/logger';
import { createServiceContext, type ServiceContext } from '../src/services/context';
import {
  allocateFolderName,
  ensureProjectFolder,
  ensureProjectFolders,
  sanitizeFolderName,
} from '../src/services/project-folders';
import * as projectService from '../src/services/projects';
import { makeTempDir, removeTempDir } from './helpers';

/**
 * 项目文件夹（0.1.2）：一个项目 = 工作区里的一个文件夹。
 *
 * 这里测的三件事都属于"跑起来看不出错"的类型：
 * 名字清洗（错了用户会看到非法字符的目录名）、去重（错了两个项目共用一个文件夹）、
 * 补建（错了老项目就永远没有文件夹）。
 */

const cleanups: Array<() => void> = [];
const tempDirs: string[] = [];

afterEach(async () => {
  while (cleanups.length > 0) cleanups.pop()?.();
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) await removeTempDir(dir);
  }
});

let clock = 1_700_000_000_000;

async function makeCtx(workspaceRoot?: string): Promise<ServiceContext> {
  const conn = new DbConnection();
  conn.open(':memory:');
  const logger = createLogger({ source: 'api', minLevel: 'error' });
  const ctx = createServiceContext({
    conn,
    logger,
    now: () => (clock += 1000),
    ...(workspaceRoot ? { workspaceRoot } : {}),
  });
  cleanups.push(() => conn.close());
  return ctx;
}

async function workspaceDir(): Promise<string> {
  const dir = await makeTempDir('project-folders');
  tempDirs.push(dir);
  return dir;
}

describe('sanitizeFolderName', () => {
  it('去掉 Windows 非法字符', () => {
    expect(sanitizeFolderName('前端/重构: v2?')).toBe('前端 重构 v2');
    expect(sanitizeFolderName('a<b>c|d*e"f')).toBe('a b c d e f');
  });

  it('去掉结尾的点与空格（Windows 会静默丢掉它们，导致名字对不上）', () => {
    expect(sanitizeFolderName('项目 ')).toBe('项目');
    expect(sanitizeFolderName('项目...')).toBe('项目');
    expect(sanitizeFolderName('  项目. . ')).toBe('项目');
  });

  it('中文与 emoji 原样保留', () => {
    expect(sanitizeFolderName('我的项目 A')).toBe('我的项目 A');
    expect(sanitizeFolderName('🚀 火箭计划')).toBe('🚀 火箭计划');
  });

  it('连续空白折成一个空格', () => {
    expect(sanitizeFolderName('a    b')).toBe('a b');
  });

  it('Windows 保留名加下划线避开', () => {
    expect(sanitizeFolderName('CON')).toBe('CON_');
    expect(sanitizeFolderName('nul')).toBe('nul_');
    expect(sanitizeFolderName('COM1')).toBe('COM1_');
  });

  it('全是非法字符时返回空串（由调用方兜底，而不是抛错）', () => {
    expect(sanitizeFolderName('///')).toBe('');
    expect(sanitizeFolderName('   ')).toBe('');
  });

  it('过长时按码点截断，不切坏 emoji', () => {
    const long = '项'.repeat(80);
    expect(Array.from(sanitizeFolderName(long)).length).toBe(60);

    const emoji = '🚀'.repeat(80);
    const cut = sanitizeFolderName(emoji);
    // 切坏的话会出现只有半个代理对的字符（长度不对或出现 U+FFFD）
    expect(Array.from(cut).length).toBe(60);
    expect(cut).not.toContain('\uFFFD');
  });
});

describe('allocateFolderName', () => {
  it('重名时依次加后缀', async () => {
    const root = await workspaceDir();
    const ctx = await makeCtx(root);

    projectService.createProject(ctx, { name: '同名项目' });
    const second = allocateFolderName(ctx, root, '同名项目');
    projectService.createProject(ctx, { name: '同名项目' });

    expect(second).toBe('同名项目-2');
  });

  it('避开磁盘上已存在的目录（可能是用户自己建的）', async () => {
    const root = await workspaceDir();
    const ctx = await makeCtx(root);
    mkdirSync(join(root, '未登记'), { recursive: true });

    expect(allocateFolderName(ctx, root, '未登记')).toBe('未登记-2');
  });

  it('名字没法用时用 id 兜底，保证一定能建出来', async () => {
    const root = await workspaceDir();
    const ctx = await makeCtx(root);

    const folder = allocateFolderName(ctx, root, '///');

    expect(folder.startsWith('project-')).toBe(true);
    expect(sanitizeFolderName(folder)).toBe(folder);
  });
});

describe('ensureProjectFolder', () => {
  it('建出项目文件夹与它的子目录', async () => {
    const root = await workspaceDir();

    const result = ensureProjectFolder(root, '我的项目');

    expect(result.created).toBe(true);
    expect(existsSync(join(root, '我的项目'))).toBe(true);
    // 附件与日志的位置从第一天就定死，免得以后再为"日志放哪"做一次迁移
    expect(existsSync(join(root, '我的项目', 'attachments'))).toBe(true);
    expect(existsSync(join(root, '我的项目', 'logs'))).toBe(true);
  });

  it('幂等：已存在时不报错，且不覆盖里面已有的东西', async () => {
    const root = await workspaceDir();
    ensureProjectFolder(root, '我的项目');
    writeFileSync(join(root, '我的项目', 'index.js'), 'x');

    const second = ensureProjectFolder(root, '我的项目');

    expect(second.created).toBe(false);
    expect(existsSync(join(root, '我的项目', 'index.js'))).toBe(true);
  });
});

describe('创建项目时建文件夹', () => {
  it('项目落库的同时，工作区里出现同名文件夹，并把名字记进数据库', async () => {
    const root = await workspaceDir();
    const ctx = await makeCtx(root);

    const project = projectService.createProject(ctx, { name: '前端重构' });

    expect(project.folder).toBe('前端重构');
    expect(existsSync(join(root, '前端重构'))).toBe(true);
    expect(existsSync(join(root, '前端重构', 'logs'))).toBe(true);
  });

  it('项目名里有非法字符时，文件夹名是被清洗过的', async () => {
    const root = await workspaceDir();
    const ctx = await makeCtx(root);

    const project = projectService.createProject(ctx, { name: 'a/b:c' });

    expect(project.folder).toBe('a b c');
    expect(existsSync(join(root, 'a b c'))).toBe(true);
  });

  it('没有工作区根目录（测试/内存库场景）时不建文件夹，但项目照常建出来', async () => {
    const ctx = await makeCtx();

    const project = projectService.createProject(ctx, { name: '无根目录项目' });

    expect(project.folder).toBeNull();
    expect(projectService.getProjectOrThrow(ctx, project.id).name).toBe('无根目录项目');
  });

  it('删除项目**不会**删掉文件夹（里面可能有用户自己写的代码）', async () => {
    const root = await workspaceDir();
    const ctx = await makeCtx(root);
    const project = projectService.createProject(ctx, { name: '要删的项目' });
    writeFileSync(join(root, '要删的项目', 'my-code.js'), 'x');

    projectService.softDeleteProject(ctx, project.id);

    expect(existsSync(join(root, '要删的项目', 'my-code.js'))).toBe(true);
  });
});

describe('给老项目补建文件夹', () => {
  it('只补"还活着且没有文件夹"的项目', async () => {
    const root = await workspaceDir();
    const ctx = await makeCtx(root);

    // 造出 0.1.1 的样子：项目有记录、没有 folder，**磁盘上也没有对应目录**
    const alive = projectService.createProject(ctx, { name: '老项目甲' });
    const archived = projectService.createProject(ctx, { name: '老项目乙' });
    const deleted = projectService.createProject(ctx, { name: '老项目丙' });
    ctx.sqlite.exec('UPDATE projects SET folder = NULL');
    for (const name of ['老项目甲', '老项目乙', '老项目丙']) {
      rmSync(join(root, name), { recursive: true, force: true });
    }
    projectService.setProjectStatus(ctx, archived.id, 'archived');
    projectService.softDeleteProject(ctx, deleted.id);

    const result = ensureProjectFolders(ctx);

    // 归档的也算还在用（会补）；已删除的不碰
    expect(result.created.map((c) => c.folder).sort()).toEqual(['老项目乙', '老项目甲'].sort());
    expect(existsSync(join(root, '老项目甲'))).toBe(true);
    expect(existsSync(join(root, '老项目乙'))).toBe(true);
    expect(existsSync(join(root, '老项目丙'))).toBe(false);
    expect(projectService.getProjectOrThrow(ctx, alive.id).folder).toBe('老项目甲');
  });

  it('补建时不会"认领"磁盘上已存在的同名目录（那可能是用户自己建的）', async () => {
    const root = await workspaceDir();
    const ctx = await makeCtx(root);
    const project = projectService.createProject(ctx, { name: '撞名' });
    ctx.sqlite.exec('UPDATE projects SET folder = NULL');
    // 磁盘上留着一个同名目录（模拟用户自己建的、或上一次留下的）
    writeFileSync(join(root, '撞名', 'user-file.txt'), 'x');

    const result = ensureProjectFolders(ctx);

    expect(result.created[0]?.folder).toBe('撞名-2');
    // 用户的东西原封不动
    expect(existsSync(join(root, '撞名', 'user-file.txt'))).toBe(true);
    expect(projectService.getProjectOrThrow(ctx, project.id).folder).toBe('撞名-2');
  });

  it('幂等：跑第二遍不会再动', async () => {
    const root = await workspaceDir();
    const ctx = await makeCtx(root);
    projectService.createProject(ctx, { name: '项目甲' });
    ctx.sqlite.exec('UPDATE projects SET folder = NULL');
    ensureProjectFolders(ctx);

    const second = ensureProjectFolders(ctx);

    expect(second.created).toEqual([]);
  });

  it('没有工作区根目录时是空操作', async () => {
    const ctx = await makeCtx();
    projectService.createProject(ctx, { name: '项目甲' });
    ctx.sqlite.exec('UPDATE projects SET folder = NULL');

    expect(ensureProjectFolders(ctx).created).toEqual([]);
  });
});

describe('文件夹与删除的边界', () => {
  it('文件夹与删除的边界', async () => {
    const root = await workspaceDir();
    const ctx = await makeCtx(root);
    const project = projectService.createProject(ctx, { name: '待回收项目' });

    projectService.softDeleteProject(ctx, project.id);
    // 还原之后文件夹仍在（因为从来没被动过）
    projectService.restoreProject(ctx, project.id);

    expect(existsSync(join(root, '待回收项目'))).toBe(true);
  });

  it('从回收站还原"没有文件夹"的老项目时会补建', async () => {
    const root = await workspaceDir();
    const ctx = await makeCtx(root);
    const project = projectService.createProject(ctx, { name: '老项目' });
    projectService.softDeleteProject(ctx, project.id);
    // 模拟"在还没有文件夹的版本里被删掉的项目"：记录还在，folder 为空，磁盘上也没有
    ctx.sqlite.exec('UPDATE projects SET folder = NULL');
    rmSync(join(root, '老项目'), { recursive: true, force: true });

    const restored = projectService.restoreProject(ctx, project.id);

    expect(restored.folder).toBe('老项目');
    expect(existsSync(join(root, '老项目', 'logs'))).toBe(true);
  });

  it('工作区里已有的同名目录不会被覆盖或吞掉', async () => {
    const root = await workspaceDir();
    const ctx = await makeCtx(root);
    mkdirSync(join(root, '撞名'), { recursive: true });
    writeFileSync(join(root, '撞名', 'mine.txt'), 'x');

    const project = projectService.createProject(ctx, { name: '撞名' });

    expect(project.folder).toBe('撞名-2');
    expect(existsSync(join(root, '撞名', 'mine.txt'))).toBe(true);
    expect(existsSync(join(root, '撞名-2'))).toBe(true);
  });
});
