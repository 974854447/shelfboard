import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  detectEnvironment,
  fingerprintPath,
  parseVersion,
  readEnvironmentCache,
  REQUIRED_TOOLS,
  restartHint,
  TOOL_DEFINITIONS,
  writeEnvironmentCache,
  type EnvironmentSnapshot,
} from '../src/main/env-detect';
import type { CommandExec } from '@pm-studio/server';

/**
 * 开发环境检测（M4 第一步）。
 *
 * 这里**不派生任何真实进程**：查找走注入的"文件是否存在"，取版本走注入的执行器。
 * 好处有两个 —— 测试不依赖这台机器装了什么；以及能在**任何**环境下跑
 * （捕获子进程输出在受限环境里可能被挡，那属于"测试环境的限制"，不该变成假失败）。
 */

const PATH_DIR = 'C:\\fake\\bin';

interface FakeOptions {
  /** 假装装了哪些工具（可执行文件的裸名字） */
  installed?: string[];
  /** 执行命令时的返回，按可执行文件名给 */
  outputs?: Record<
    string,
    { code?: number | null; stdout?: string; stderr?: string; timedOut?: boolean }
  >;
}

function setup(options: FakeOptions = {}) {
  const installed = new Set((options.installed ?? ['node', 'npm', 'pnpm', 'python', 'pip', 'git']).map((n) => n.toLowerCase()));
  const calls: Array<{ bin: string; args: string[] }> = [];

  const exec: CommandExec = async (bin, args) => {
    calls.push({ bin, args });
    const canned = options.outputs?.[bin] ?? { code: 0, stdout: `${bin} 1.2.3\n` };
    return {
      code: canned.code ?? 0,
      stdout: canned.stdout ?? '',
      stderr: canned.stderr ?? '',
      timedOut: canned.timedOut ?? false,
    };
  };

  const env: NodeJS.ProcessEnv = { PATH: PATH_DIR, PATHEXT: '.EXE;.CMD' };
  const exists = (path: string): boolean => {
    const match = /[\\/]([^\\/]+)\.(exe|cmd)$/i.exec(path);
    if (!match) return false;
    const name = (match[1] ?? '').toLowerCase();
    return installed.has(name) || (name === 'yarn' && installed.has('yarn'));
  };

  return { exec, env, exists, calls };
}

const run = (options: FakeOptions = {}) => {
  const fake = setup(options);
  return detectEnvironment({
    exec: fake.exec,
    env: fake.env,
    exists: fake.exists,
    cwd: 'C:\\tmp',
    appStartedAt: 1_000,
    now: () => 2_000,
  }).then((snapshot) => ({ snapshot, ...fake }));
};

describe('版本号解析', () => {
  it('认得各家格式（v 前缀 / Python / git 那种多段版本）', () => {
    expect(parseVersion('v24.20.0\n', /v?\d+\.\d+\.\d+/)).toBe('24.20.0');
    expect(parseVersion('Python 3.12.1\n', /\d+\.\d+\.\d+/)).toBe('3.12.1');
    expect(parseVersion('pip 24.0 from ...', /\d+\.\d+(\.\d+)?/)).toBe('24.0');
    expect(parseVersion('git version 2.43.0.windows.1', /\d+\.\d+\.\d+/)).toBe('2.43.0');
  });

  it('匹配不上就退回第一行原样显示，**不编版本号**', () => {
    expect(parseVersion('奇怪的输出', /v?\d+\.\d+\.\d+/)).toBe('奇怪的输出');
    expect(parseVersion('   ', /v?\d+\.\d+\.\d+/)).toBeNull();
  });
});

describe('PATH 指纹', () => {
  it('大小写与斜杠差异算同一个 PATH（Windows 上这是同一个 PATH）', () => {
    expect(fingerprintPath('C:\\A\\bin;D:\\b')).toBe(fingerprintPath('c:/a/bin;d:\\b\\'));
  });

  it('真的换了目录就不同', () => {
    expect(fingerprintPath('C:\\A')).not.toBe(fingerprintPath('C:\\A;C:\\B'));
  });
});

describe('detectEnvironment', () => {
  it('逐个工具报出路径与版本，并标出检测时间', async () => {
    const { snapshot, calls } = await run({
      outputs: {
        node: { stdout: 'v24.20.0' },
        npm: { stdout: '10.5.0' },
        python: { stdout: 'Python 3.12.1' },
      },
    });

    expect(snapshot.tools).toHaveLength(TOOL_DEFINITIONS.length);
    expect(snapshot.checkedAt).toBe(2_000);
    expect(snapshot.appStartedAt).toBe(1_000);

    const node = snapshot.tools.find((tool) => tool.id === 'node');
    expect(node).toMatchObject({ found: true, version: '24.20.0' });
    expect(node?.path?.toLowerCase()).toBe('c:\\fake\\bin\\node.exe');

    const python = snapshot.tools.find((tool) => tool.id === 'python');
    expect(python?.version).toBe('3.12.1');

    // 未安装的 yarn 不该被探测（不派生进程）
    expect(calls.some((call) => call.bin === 'yarn')).toBe(false);
  });

  it('没装就是没装，而且给出"缺了它会影响什么"', async () => {
    const { snapshot } = await run({ installed: ['node', 'npm'] });

    const pnpm = snapshot.tools.find((tool) => tool.id === 'pnpm');
    expect(pnpm).toMatchObject({ found: false, path: null, version: null });
    expect(pnpm?.note).toContain('PATH 里没有 pnpm');
    expect(pnpm?.neededFor).toContain('依赖安装');
  });

  it('venv 走的是能力探测（python -m venv --help），没装 python 时如实说明', async () => {
    const withPython = await run({ installed: ['node', 'npm', 'python'] });
    const venv = withPython.snapshot.tools.find((tool) => tool.id === 'venv');
    expect(venv?.found).toBe(true);
    expect(withPython.calls).toContainEqual({
      bin: 'python',
      args: ['-m', 'venv', '--help'],
    });

    const withoutPython = await run({ installed: ['node', 'npm'] });
    const missing = withoutPython.snapshot.tools.find((tool) => tool.id === 'venv');
    expect(missing?.found).toBe(false);
    expect(missing?.note).toContain('没找到 python');
    expect(withoutPython.calls.some((call) => call.bin === 'python')).toBe(false);
  });

  it('python 没有 venv 模块时，报"不可用"而不是假装成功', async () => {
    const { snapshot } = await run({
      installed: ['node', 'npm', 'python'],
      outputs: { python: { code: 1, stderr: 'No module named venv' } },
    });
    const venv = snapshot.tools.find((tool) => tool.id === 'venv');
    expect(venv?.found).toBe(false);
    expect(venv?.note).toContain('没有 venv 模块');
  });

  it('命令超时会说明"这个命令可能卡住了"', async () => {
    const { snapshot } = await run({
      outputs: { node: { code: null, timedOut: true } },
    });
    const node = snapshot.tools.find((tool) => tool.id === 'node');
    expect(node?.found).toBe(true);
    expect(node?.version).toBeNull();
    expect(node?.note).toContain('执行超时');
  });

  it('读不出版本号时说明原因，而不是留空', async () => {
    const { snapshot } = await run({ outputs: { node: { code: 0, stdout: '' } } });
    expect(snapshot.tools.find((tool) => tool.id === 'node')?.note).toContain('没读出版本号');
  });

  it('Windows 上的 .cmd 批处理壳交给命令白名单去借 cmd.exe（探测本身不再自己分流）', async () => {
    const { snapshot, calls } = await run({
      installed: ['node', 'npm'],
      outputs: { 'cmd.exe': { code: 0, stdout: '10.5.0' } },
    });

    const npm = snapshot.tools.find((tool) => tool.id === 'npm');
    expect(npm?.found).toBe(true);

    const nodeCall = calls.find((call) => call.bin === 'node');
    expect(nodeCall?.args).toEqual(['--version']);

    // 探测到 .cmd 壳时，实际执行的是 cmd.exe（参数形状由 commands.ts 保证）
    if ((npm?.path ?? '').toLowerCase().endsWith('.cmd')) {
      const cmdCall = calls.find((call) => call.bin === 'cmd.exe');
      expect(cmdCall?.args).toEqual(['/d', '/c', 'npm', '--version']);
    }
  });

  it('取版本失败时把原因写进 note（界面要显示出来，不能只藏在 tooltip 里）', async () => {
    const { snapshot } = await run({
      installed: ['node', 'npm'],
      outputs: { node: { code: 1, stderr: 'boom' } },
    });
    const node = snapshot.tools.find((tool) => tool.id === 'node');
    expect(node?.note).toContain('取版本号失败');
    expect(node?.note).toContain('boom');
  });

  it('venv 是"能力探测"：界面上显示可用/不可用，而不是一个假的版本号', async () => {
    const { snapshot } = await run({ installed: ['node', 'npm', 'python'] });
    const venv = snapshot.tools.find((tool) => tool.id === 'venv');
    expect(venv?.kind).toBe('capability');
    expect(venv?.found).toBe(true);
    expect(venv?.version).toBeNull();

    const node = snapshot.tools.find((tool) => tool.id === 'node');
    expect(node?.kind).toBe('version');
  });

  it('必需工具缺失时 ready=false，并列出缺了谁', async () => {
    const missing = await run({ installed: ['pnpm'] });
    expect(missing.snapshot.ready).toBe(false);
    expect(missing.snapshot.missingRequired).toEqual([...REQUIRED_TOOLS]);
    expect(missing.snapshot.warnings.join()).toContain('缺少必需工具');

    const ok = await run({ installed: ['node', 'npm'] });
    expect(ok.snapshot.ready).toBe(true);
    expect(ok.snapshot.missingRequired).toEqual([]);
  });
});

describe('重启提示', () => {
  it('PATH 没变就不提示', async () => {
    const { snapshot } = await run();
    expect(restartHint(snapshot, 'C:\\fake\\bin')).toBeNull();
  });

  it('PATH 变了就提示"需要重启应用"（已运行的进程读不到新 PATH）', async () => {
    const { snapshot } = await run();
    const hint = restartHint(snapshot, 'C:\\fake\\bin;C:\\nodejs');
    expect(hint).toContain('重启本应用');
  });
});

describe('缓存（放在 AppData，不进工作区数据库）', () => {
  it('写进去能读回来', () => {
    const dir = mkdtempSync(join(tmpdir(), 'env-cache-'));
    const file = join(dir, 'nested', 'environment.json');
    const snapshot: EnvironmentSnapshot = {
      checkedAt: 1,
      appStartedAt: 1,
      pathFingerprint: 'abc-3',
      tools: [],
      ready: true,
      missingRequired: [],
      warnings: [],
    };

    try {
      expect(readEnvironmentCache(file)).toBeNull();
      writeEnvironmentCache(file, snapshot);
      expect(readEnvironmentCache(file)).toEqual(snapshot);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('缓存坏了当作"没检测过"，而不是让设置页报错', () => {
    const dir = mkdtempSync(join(tmpdir(), 'env-cache-bad-'));
    const file = join(dir, 'environment.json');
    try {
      writeFileSync(file, '{ 这不是 JSON');
      expect(readEnvironmentCache(file)).toBeNull();

      writeFileSync(file, JSON.stringify({ version: 99, snapshot: { tools: [] } }));
      expect(readEnvironmentCache(file)).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
