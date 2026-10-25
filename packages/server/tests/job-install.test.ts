import { describe, expect, it } from 'vitest';

import {
  parseInstallPayload,
  pickPackageManager,
  planInstall,
  venvPythonPath,
} from '../src/services/job-install';
import { resolveOnPath } from '../src/services/which';

/**
 * 装依赖（M4）。
 *
 * 这里测"计划与选择"这类**可预期**的部分：装到哪个目录、用哪个包管理器、
 * venv 里的 python 在哪。真正的安装要联网，所以不在单测里跑
 * （命令形状由 commands.test.ts 钉住）。
 */

describe('安装计划：装到哪个目录', () => {
  it('单栈装到项目文件夹根目录', () => {
    const plan = planInstall({ targets: [{ templateId: 'fastapi' }] });
    expect(plan.problems).toEqual([]);
    expect(plan.items[0]).toMatchObject({ subdir: '', kind: 'python', needsInstall: true });
  });

  it('前后端分到 frontend / backend（与脚手架的目录规则一致）', () => {
    const plan = planInstall({ targets: [{ templateId: 'vue3' }, { templateId: 'fastapi' }] });
    expect(plan.items.map((item) => item.subdir)).toEqual(['frontend', 'backend']);
    expect(plan.items.map((item) => item.kind)).toEqual(['node', 'python']);
  });

  it('不认识的模板要报问题', () => {
    expect(planInstall({ targets: [{ templateId: 'svelte' }] }).problems.join()).toContain('不认识');
  });

  it('空目标要报问题', () => {
    expect(planInstall({ targets: [] }).problems.join()).toContain('至少要选一个技术栈');
  });
});

describe('包管理器怎么选', () => {
  const existsOf = (names: string[]) => (path: string) =>
    names.some((name) => path.toLowerCase().endsWith(`\\${name}.cmd`) || path.toLowerCase().endsWith(`\\${name}.exe`));

  it('用户指定了就用指定的', () => {
    const chosen = pickPackageManager('npm', { PATH: 'C:\\bin', PATHEXT: '.CMD' }, existsOf(['npm']));
    expect(chosen.pm).toBe('npm');
    expect(chosen.path?.toLowerCase()).toContain('npm');
  });

  it('没指定就按 pnpm → npm → yarn 的顺序挑第一个装了的', () => {
    expect(
      pickPackageManager(undefined, { PATH: 'C:\\bin', PATHEXT: '.CMD' }, existsOf(['pnpm', 'npm'])).pm,
    ).toBe('pnpm');
    expect(
      pickPackageManager(undefined, { PATH: 'C:\\bin', PATHEXT: '.CMD' }, existsOf(['npm', 'yarn'])).pm,
    ).toBe('npm');
    expect(
      pickPackageManager(undefined, { PATH: 'C:\\bin', PATHEXT: '.CMD' }, existsOf(['yarn'])).pm,
    ).toBe('yarn');
  });

  it('一个都没有时如实返回 null（调用方据此报"先装一个包管理器"）', () => {
    const chosen = pickPackageManager(undefined, { PATH: 'C:\\bin', PATHEXT: '.CMD' }, () => false);
    expect(chosen.path).toBeNull();
  });
});

describe('venv 里的 python 在哪', () => {
  it('Windows 与 POSIX 的目录结构不一样', () => {
    expect(venvPythonPath('.venv', 'win32')).toBe('.venv\\Scripts\\python.exe');
    expect(venvPythonPath('.venv', 'linux')).toBe('.venv/bin/python');
  });
});

describe('payload 校验', () => {
  it('缺 projectId / 没有 targets 都要报错', () => {
    expect(() => parseInstallPayload({})).toThrow(/缺少 projectId/);
    expect(() => parseInstallPayload({ projectId: 'p' })).toThrow(/至少要选一个技术栈/);
  });

  it('包管理器只认白名单里的三个（乱传就当没传）', () => {
    expect(parseInstallPayload({ projectId: 'p', targets: [{ templateId: 'fastapi' }] }).packageManager).toBeUndefined();
    expect(
      parseInstallPayload({ projectId: 'p', targets: [{ templateId: 'fastapi' }], packageManager: 'bun' })
        .packageManager,
    ).toBeUndefined();
    expect(
      parseInstallPayload({ projectId: 'p', targets: [{ templateId: 'fastapi' }], packageManager: 'pnpm' })
        .packageManager,
    ).toBe('pnpm');
  });
});

describe('PATH 解析（判断 .cmd 壳要用）', () => {
  it('按 PATHEXT 逐个扩展名找', () => {
    const found = resolveOnPath(
      'npm',
      { PATH: 'C:\\a;C:\\b', PATHEXT: '.EXE;.CMD' },
      (path) => path.toLowerCase() === 'c:\\b\\npm.cmd',
    );
    // 返回的是"按 PATHEXT 拼出来的候选路径"，扩展名大小写跟随 PATHEXT
    // （Windows 路径不分大小写，所以 npm.CMD 与 npm.cmd 是同一个文件）
    expect(found?.toLowerCase()).toBe('c:\\b\\npm.cmd');
  });

  it('带扩展名的命令按原名找', () => {
    const found = resolveOnPath(
      'python.exe',
      { PATH: 'C:\\py', PATHEXT: '.EXE' },
      (path) => path === 'C:\\py\\python.exe',
    );
    expect(found).toBe('C:\\py\\python.exe');
  });

  it('找不到就返回 null（而不是抛错）', () => {
    expect(resolveOnPath('nope', { PATH: 'C:\\a', PATHEXT: '.EXE' }, () => false)).toBeNull();
    expect(resolveOnPath('nope', { PATH: '', PATHEXT: '.EXE' }, () => true)).toBeNull();
  });
});
