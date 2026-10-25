import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { applyVersionPins } from '../src/services/scaffold-versions';

/**
 * 版本选择（M4 第八刀）：把用户选的那一版**真的写进依赖清单**。
 *
 * 这一层最容易出的毛病是"看着成功、其实没改"（清单里根本没有那个包、
 * 或者我们偷偷加了一条依赖）。所以用例里既查"改对了"，也查"没找到时如实说"。
 */

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()?.();
});

function makeDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'versions-'));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function pkg(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify(
    {
      name: 'demo',
      version: '0.0.0',
      dependencies: { react: '^19.2.8', 'react-dom': '^19.2.8' },
      devDependencies: { vite: '^8.2.2' },
      ...overrides,
    },
    null,
    2,
  );
}

describe('Node：package.json', () => {
  it('把已存在的依赖改成用户选的版本（并保留它原来所在的段）', () => {
    const dir = makeDir();
    writeFileSync(join(dir, 'package.json'), pkg(), 'utf8');

    const result = applyVersionPins(dir, {
      pins: { react: '^18.3.1', 'react-dom': '^18.3.1' },
      installKind: 'node',
    });

    const after = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as {
      dependencies: Record<string, string>;
      devDependencies: Record<string, string>;
    };
    expect(after.dependencies.react).toBe('^18.3.1');
    expect(after.dependencies['react-dom']).toBe('^18.3.1');
    // vite 在 devDependencies 里，不该被挪走
    expect(after.devDependencies.vite).toBe('^8.2.2');
    expect(result.changed.join()).toContain('react ^19.2.8 → ^18.3.1');
  });

  it('清单里没有的包**如实报跳过**，绝不偷偷加一条依赖', () => {
    const dir = makeDir();
    writeFileSync(join(dir, 'package.json'), pkg(), 'utf8');

    const result = applyVersionPins(dir, {
      pins: { '@nestjs/core': '^11.0.0' },
      installKind: 'node',
    });

    const after = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as {
      dependencies: Record<string, string>;
      devDependencies: Record<string, string>;
    };
    expect(after.dependencies['@nestjs/core']).toBeUndefined();
    expect(result.changed).toEqual([]);
    expect(result.skipped.join()).toContain('@nestjs/core');
    expect(result.skipped.join()).toContain('没有这条依赖');
  });

  it('引擎要求只在清单**没有声明过**时才写（不许把官方的要求放宽）', () => {
    const dir = makeDir();
    writeFileSync(join(dir, 'package.json'), pkg(), 'utf8');

    const first = applyVersionPins(dir, { pins: {}, enginesNode: '^20.19.0 || >=22.12.0', installKind: 'node' });
    expect(first.changed.join()).toContain('engines.node');
    const written = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as {
      engines: Record<string, string>;
    };
    expect(written.engines.node).toBe('^20.19.0 || >=22.12.0');

    /*
     * 官方脚手架会写自己那套（create-vue 写 `^22.18.0 || >=24.12.0`）——
     * 比我们严，照我们的写就等于放宽，所以这种情况必须**不动**并说明。
     */
    const strictDir = makeDir();
    writeFileSync(
      join(strictDir, 'package.json'),
      pkg({ engines: { node: '^22.18.0 || >=24.12.0' } }),
      'utf8',
    );
    const second = applyVersionPins(strictDir, {
      pins: {},
      enginesNode: '^20.19.0 || >=22.12.0',
      installKind: 'node',
    });
    expect(second.changed).toEqual([]);
    expect(second.skipped.join()).toContain('不覆盖');
    expect(
      (JSON.parse(readFileSync(join(strictDir, 'package.json'), 'utf8')) as {
        engines: Record<string, string>;
      }).engines.node,
    ).toBe('^22.18.0 || >=24.12.0');
  });

  it('清单坏了就一个字都不改（宁可让用户看到问题）', () => {
    const dir = makeDir();
    writeFileSync(join(dir, 'package.json'), '{ 这不是 JSON', 'utf8');

    const result = applyVersionPins(dir, { pins: { react: '^18.3.1' }, installKind: 'node' });

    expect(result.changed).toEqual([]);
    expect(result.skipped.join()).toContain('解析失败');
    expect(readFileSync(join(dir, 'package.json'), 'utf8')).toBe('{ 这不是 JSON');
  });

  it('没有 package.json 时如实说明，而不是创建一份', () => {
    const dir = makeDir();
    const result = applyVersionPins(dir, { pins: { react: '^18.3.1' }, installKind: 'node' });
    expect(result.changed).toEqual([]);
    expect(result.skipped.join()).toContain('没有 package.json');
  });

  it('值本来就一样时不写盘（避免无意义的重写）', () => {
    const dir = makeDir();
    const original = pkg();
    writeFileSync(join(dir, 'package.json'), original, 'utf8');

    const result = applyVersionPins(dir, { pins: { react: '^19.2.8' }, installKind: 'node' });

    expect(result.changed).toEqual([]);
    expect(result.skipped).toEqual([]);
    expect(readFileSync(join(dir, 'package.json'), 'utf8')).toBe(original);
  });
});

describe('Python：requirements.txt', () => {
  const requirements = `# 直接依赖
fastapi>=0.115
uvicorn[standard]>=0.32

# 工具
pytest>=8
`;

  it('改版本时保留 extras 与注释（我们改的是版本，不是依赖列表）', () => {
    const dir = makeDir();
    writeFileSync(join(dir, 'requirements.txt'), requirements, 'utf8');

    const result = applyVersionPins(dir, {
      pins: { fastapi: '==0.141.*', uvicorn: '>=0.54' },
      installKind: 'python',
    });

    const after = readFileSync(join(dir, 'requirements.txt'), 'utf8');
    expect(after).toContain('fastapi==0.141.*');
    expect(after).toContain('uvicorn[standard]>=0.54');
    expect(after).toContain('# 直接依赖');
    expect(after).toContain('pytest>=8');
    expect(result.changed.join()).toContain('fastapi >=0.115 → ==0.141.*');
  });

  it('包名大小写不敏感（Django / django 都认），且没找到会说', () => {
    const dir = makeDir();
    writeFileSync(join(dir, 'requirements.txt'), 'Django>=5.0\n', 'utf8');

    const result = applyVersionPins(dir, {
      pins: { django: '>=4.2,<5', flask: '>=3' },
      installKind: 'python',
    });

    expect(readFileSync(join(dir, 'requirements.txt'), 'utf8')).toBe('Django>=4.2,<5\n');
    expect(result.skipped.join()).toContain('flask');
  });

  it('没有 requirements.txt 时不创建（Python 栈也可能是别的清单格式）', () => {
    const dir = makeDir();
    const result = applyVersionPins(dir, { pins: { django: '>=4.2,<5' }, installKind: 'python' });
    expect(result.changed).toEqual([]);
    expect(result.skipped.join()).toContain('没有 requirements.txt');
  });
});

describe('其它', () => {
  it('纯管理项目（installKind=none）什么都不做', () => {
    const dir = makeDir();
    const result = applyVersionPins(dir, { pins: { react: '^18.3.1' }, installKind: 'none' });
    expect(result).toEqual({ changed: [], skipped: [] });
  });
});
