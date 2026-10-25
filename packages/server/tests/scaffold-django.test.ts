import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { venvBinPath, venvPythonPath } from '../src/services/job-install';
import type { JobContext } from '../src/services/job-runner';
import { bootstrapDjangoScaffold } from '../src/services/scaffold-official';

/**
 * Django 官方路径的**前置**（M4 第十刀）。
 *
 * 这一段的特殊性：官方脚手架是 `django-admin startproject`，而 `django-admin`
 * **不是自带**的 —— 得先建 venv、装 Django。所以这里测的是"前置做对了没有"：
 * 顺序、复用它、失败时如实报原因（让上层能回退内置骨架）。
 */

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()?.();
});

function makeDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'django-boot-'));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

interface Call {
  specId: string;
  values: Record<string, string>;
  cwd: string | undefined;
}

/**
 * 假的作业上下文：记下每条命令（spec 与值位），并按脚本返回结果。
 *
 * 不真跑 python / pip —— 那是"看机器脸色"的测试。真正的联网验证在
 * `scripts/e2e/scenarios/network-official.cjs`（要 `--network` 才跑）。
 */
function fakeJob(
  dir: string,
  responses: Record<string, { code?: number; stdout?: string; stderr?: string }> = {},
  onCreate?: (call: Call) => void,
): { job: JobContext; calls: Call[]; logs: string[] } {
  const calls: Call[] = [];
  const logs: string[] = [];
  const job = {
    jobId: 'job-1',
    ctx: {} as never,
    signal: new AbortController().signal,
    log: (message: string) => void logs.push(message),
    progress: () => undefined,
    throwIfCanceled: () => undefined,
    runCommand: async (
      specId: string,
      values: Record<string, string> = {},
      options: { cwd?: string } = {},
    ) => {
      const call: Call = { specId, values, cwd: options.cwd };
      calls.push(call);
      onCreate?.(call);
      const scripted = responses[specId] ?? {};
      const code = scripted.code ?? 0;
      return {
        specId,
        bin: specId,
        args: [] as string[],
        code,
        ok: code === 0,
        timedOut: false,
        canceled: false,
        stdout: scripted.stdout ?? (specId === 'probe-django-help' ? 'startproject [options]' : ''),
        stderr: scripted.stderr ?? '',
        durationMs: 1,
      };
    },
  } as unknown as JobContext;
  void dir;
  return { job, calls, logs };
}

describe('venv 里的可执行文件位置', () => {
  it('Windows 与 POSIX 的目录名不一样（写死一个平台另一个就找不到文件）', () => {
    expect(venvPythonPath('.venv', 'win32')).toBe('.venv\\Scripts\\python.exe');
    expect(venvPythonPath('.venv', 'linux')).toBe('.venv/bin/python');
    expect(venvBinPath('.venv', 'django-admin', 'win32')).toBe('.venv\\Scripts\\django-admin.exe');
    expect(venvBinPath('.venv', 'django-admin', 'darwin')).toBe('.venv/bin/django-admin');
  });
});

describe('前置：建 venv → 装 Django → 确认它认 startproject', () => {
  it('顺序与值位都对，并且写出 requirements.txt（官方 startproject 不会生成它）', async () => {
    const dir = makeDir();
    const { job, calls, logs } = fakeJob(dir, {}, (call) => {
      // 模拟 pip 装完之后 venv 里真的出现了 django-admin（**文件**，不只是目录）
      if (call.specId === 'python-pip-install') {
        mkdirSync(join(dir, '.venv', 'Scripts'), { recursive: true });
        writeFileSync(join(dir, '.venv', 'Scripts', 'django-admin.exe'), '', 'utf8');
      }
    });

    const result = await bootstrapDjangoScaffold(job, {
      targetDir: dir,
      djangoSpec: '>=6.0',
      pythonPath: 'C:\\Python\\python.exe',
    });

    expect(result.ok).toBe(true);
    expect(calls.map((call) => call.specId)).toEqual([
      'python-venv',
      'python-pip-install',
      'probe-django-help',
    ]);
    // venv 建在**项目文件夹**里，与"装依赖"那一步共用一个环境
    expect(calls[0]?.values).toEqual({ name: '.venv' });
    expect(calls[0]?.cwd).toBe(dir);
    // pip 从清单装（走白名单里已有的命令，而不是拼一个包名）
    expect(calls[1]?.values).toEqual({
      python: '.venv\\Scripts\\python.exe',
      requirements: 'requirements.txt',
    });
    // 探测用的是 venv 里的 django-admin（项目内相对路径）
    expect(calls[2]?.values.django).toBe('.venv\\Scripts\\django-admin.exe');

    const requirements = readFileSync(join(dir, 'requirements.txt'), 'utf8');
    expect(requirements).toContain('Django>=6.0');
    expect(logs.join('\n')).toContain('这一步要联网');
    if (result.ok) {
      expect(result.djangoAdmin).toBe('.venv\\Scripts\\django-admin.exe');
      expect(result.notes.length).toBeGreaterThan(0);
    }
  });

  it('已经有 venv 就**复用**（不重复建；重复建会多出一份几百 MB 的环境）', async () => {
    const dir = makeDir();
    mkdirSync(join(dir, '.venv', 'Scripts'), { recursive: true });
    writeFileSync(join(dir, '.venv', 'Scripts', 'django-admin.exe'), '', 'utf8');
    const { job, calls, logs } = fakeJob(dir);

    const result = await bootstrapDjangoScaffold(job, {
      targetDir: dir,
      pythonPath: 'python',
    });

    expect(result.ok).toBe(true);
    expect(calls.map((call) => call.specId)).toEqual(['python-pip-install', 'probe-django-help']);
    expect(logs.join('\n')).toContain('复用已有的虚拟环境');
  });

  it('已存在的 requirements.txt 不覆盖（用户可能已经改过）', async () => {
    const dir = makeDir();
    mkdirSync(join(dir, '.venv', 'Scripts'), { recursive: true });
    const before = '# 我自己写的\nDjango>=4.2,<5\n';
    // 直接写文件，模拟用户已经改过清单
    writeFileSync(join(dir, 'requirements.txt'), before, 'utf8');
    const { job } = fakeJob(dir);

    await bootstrapDjangoScaffold(job, { targetDir: dir, pythonPath: 'python', djangoSpec: '>=6.0' });

    expect(readFileSync(join(dir, 'requirements.txt'), 'utf8')).toBe(before);
  });

  it('PATH 里没有 python → 如实报（上层据此回退内置骨架）', async () => {
    const dir = makeDir();
    const { job, calls } = fakeJob(dir);

    const result = await bootstrapDjangoScaffold(job, { targetDir: dir, pythonPath: null });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain('PATH 里没有 python');
    expect(calls).toEqual([]);
  });

  it('pip 装不上（断网）→ 报原因里带上"网络/PyPI"，并说明没装成', async () => {
    const dir = makeDir();
    const { job } = fakeJob(dir, { 'python-pip-install': { code: 1, stderr: 'proxy error' } });

    const result = await bootstrapDjangoScaffold(job, {
      targetDir: dir,
      pythonPath: 'python',
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain('pip 装 Django 失败');
      expect(result.reason).toContain('网络');
    }
  });

  it('装完了但没生成 django-admin 入口 → 报出来（而不是接着跑一条不存在的命令）', async () => {
    const dir = makeDir();
    const { job, calls } = fakeJob(dir);

    const result = await bootstrapDjangoScaffold(job, {
      targetDir: dir,
      pythonPath: 'python',
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain('没找到');
    // 探测那一步不该跑：没有可执行文件时探测只会得到"命令不存在"
    expect(calls.map((call) => call.specId)).not.toContain('probe-django-help');
  });

  it('django-admin 的帮助里没有 startproject → 算走不通（参数表可能变了）', async () => {
    const dir = makeDir();
    const { job } = fakeJob(
      dir,
      { 'probe-django-help': { code: 0, stdout: 'usage: django-admin [options]' } },
      (call) => {
        if (call.specId === 'python-pip-install') {
          mkdirSync(join(dir, '.venv', 'Scripts'), { recursive: true });
          writeFileSync(join(dir, '.venv', 'Scripts', 'django-admin.exe'), '', 'utf8');
        }
      },
    );

    const result = await bootstrapDjangoScaffold(job, { targetDir: dir, pythonPath: 'python' });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain('startproject');
  });

  it('真装成之后，项目里确实多出 .venv（这条是"文件真的落地了"）', async () => {
    const dir = makeDir();
    const { job } = fakeJob(dir, {}, (call) => {
      if (call.specId === 'python-venv') {
        mkdirSync(join(dir, '.venv', 'Scripts'), { recursive: true });
      }
      if (call.specId === 'python-pip-install') {
        mkdirSync(join(dir, '.venv', 'Scripts'), { recursive: true });
        writeFileSync(join(dir, '.venv', 'Scripts', 'django-admin.exe'), '', 'utf8');
      }
    });

    const result = await bootstrapDjangoScaffold(job, { targetDir: dir, pythonPath: 'python' });

    expect(result.ok).toBe(true);
    expect(existsSync(join(dir, '.venv', 'Scripts'))).toBe(true);
    expect(existsSync(join(dir, 'requirements.txt'))).toBe(true);
  });
});
