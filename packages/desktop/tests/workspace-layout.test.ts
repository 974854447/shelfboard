import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  appDataPaths,
  ensureWorkspaceLayout,
  removeObsoleteWorkspaceDirs,
} from '../src/main/app-config';

/**
 * 路径布局的测试（0.1.2：工作区里只放项目）。
 *
 * 这类"少建一个目录""多留一个目录"的差异，跑起来完全看不出来 ——
 * 应用照常启动，只是用户打开工作区时多看到一个不该在那儿的文件。
 * 所以用断言把布局钉死。
 */

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'pm-ws-'));
  tempDirs.push(dir);
  return dir;
}

describe('ensureWorkspaceLayout', () => {
  it('只建工作区目录本身，不在里面造任何东西', () => {
    const root = join(tempDir(), 'workspace');

    ensureWorkspaceLayout(root);

    expect(existsSync(root)).toBe(true);
    // 工作区里只放项目：老的容器层与工作区级附件目录都不该再出现
    expect(existsSync(join(root, 'projects'))).toBe(false);
    expect(existsSync(join(root, 'attachments'))).toBe(false);
    expect(existsSync(join(root, 'backups'))).toBe(false);
    expect(existsSync(join(root, 'logs'))).toBe(false);
  });
});

describe('removeObsoleteWorkspaceDirs', () => {
  it('删掉旧版本留下的空目录（含 logs/jobs 这样的嵌套）', () => {
    const root = tempDir();
    mkdirSync(join(root, 'logs', 'jobs'), { recursive: true });
    mkdirSync(join(root, 'backups'), { recursive: true });
    mkdirSync(join(root, 'projects'), { recursive: true });
    mkdirSync(join(root, 'attachments'), { recursive: true });
    // 项目文件夹必须毫发无伤
    mkdirSync(join(root, '我的项目', 'logs'), { recursive: true });

    const result = removeObsoleteWorkspaceDirs(root);

    expect(result.removed.sort()).toEqual(
      ['attachments', 'backups', 'projects', 'logs', join('logs', 'jobs')].sort(),
    );
    expect(existsSync(join(root, '我的项目', 'logs'))).toBe(true);
  });

  it('目录里有东西就保留（宁可留着也不能递归删掉用户的数据）', () => {
    const root = tempDir();
    mkdirSync(join(root, 'backups'), { recursive: true });
    writeFileSync(join(root, 'backups', 'manual-backup.db'), 'x');
    // projects/ 当年是"放代码的地方"，用户完全可能真把代码放在里面
    mkdirSync(join(root, 'projects', 'my-app'), { recursive: true });
    writeFileSync(join(root, 'projects', 'my-app', 'index.js'), 'x');

    const result = removeObsoleteWorkspaceDirs(root);

    expect(result.removed).toEqual([]);
    expect(result.kept.sort()).toEqual(['backups', 'projects'].sort());
    expect(existsSync(join(root, 'projects', 'my-app', 'index.js'))).toBe(true);
    expect(existsSync(join(root, 'backups', 'manual-backup.db'))).toBe(true);
  });

  it('没有这些目录时是空操作，且可反复执行', () => {
    const root = tempDir();

    expect(removeObsoleteWorkspaceDirs(root)).toEqual({ removed: [], kept: [] });

    mkdirSync(join(root, 'logs', 'jobs'), { recursive: true });
    expect(removeObsoleteWorkspaceDirs(root).removed.length).toBeGreaterThan(0);
    expect(removeObsoleteWorkspaceDirs(root)).toEqual({ removed: [], kept: [] });
  });
});

describe('appDataPaths', () => {
  it('数据库在 data\\ 下，与工作区目录平级', () => {
    const paths = appDataPaths('C:\\userdata');

    expect(paths.dataDir).toBe(join('C:\\userdata', 'data'));
    expect(paths.database).toBe(join('C:\\userdata', 'data', 'workspace.db'));
  });

  it('应用自身的东西一个都不落在工作区目录里', () => {
    const paths = appDataPaths('C:\\userdata');
    const workspaceRoot = join('C:\\userdata', 'workspace');

    for (const value of Object.values(paths)) {
      expect(value.startsWith(workspaceRoot)).toBe(false);
    }
    // 数据库也不能在工作区里 —— 这正是本次调整的目的
    expect(paths.database.startsWith(workspaceRoot)).toBe(false);
  });
});
