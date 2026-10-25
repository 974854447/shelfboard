import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { detectRunTargets } from '../src/services/project-run';

/**
 * "这个项目怎么跑起来"（M4 项目启动 / 停止）。
 *
 * 探测而不是记配置，是为了"项目在应用外面被改过"也能跑对 —— 所以这里的用例
 * 覆盖的正是"我们生成的骨架"与"被改过的项目"两类：
 * 认得出就给出确切命令，认不出就**如实报**（不能猜一条命令去跑）。
 */

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()?.();
});

function makeDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'run-detect-'));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function writeJson(file: string, value: unknown): void {
  mkdirSync(join(file, '..'), { recursive: true });
  writeFileSync(file, JSON.stringify(value, null, 2), 'utf8');
}

function write(file: string, content: string): void {
  mkdirSync(join(file, '..'), { recursive: true });
  writeFileSync(file, content, 'utf8');
}

describe('纯管理项目', () => {
  it('没有代码 → 一个目标都不给（界面据此不显示启动按钮）', () => {
    const dir = makeDir();
    const result = detectRunTargets(dir, null);
    expect(result.targets).toEqual([]);
    expect(result.problems.join()).toContain('纯管理项目');
  });
});

describe('Node 栈', () => {
  it('Vite 前端：`npm run dev` + 从 vite.config 读端口', () => {
    const dir = makeDir();
    writeJson(join(dir, 'package.json'), { scripts: { dev: 'vite' } });
    write(join(dir, 'vite.config.ts'), 'export default { server: { port: 5174 } }');
    mkdirSync(join(dir, 'node_modules'), { recursive: true });

    const [target] = detectRunTargets(dir, 'frontend').targets;
    expect(target?.kind).toBe('vite');
    expect(target?.specId).toBe('run-node-dev');
    expect(target?.values.script).toBe('dev');
    expect(target?.port).toBe(5174);
    expect(target?.ready).toBe(true);
  });

  it('NestJS 后端：认 `start:dev`，默认端口 3000', () => {
    const dir = makeDir();
    writeJson(join(dir, 'package.json'), { scripts: { 'start:dev': 'nest start --watch' } });
    write(join(dir, 'nest-cli.json'), '{}');
    mkdirSync(join(dir, 'node_modules'), { recursive: true });

    const [target] = detectRunTargets(dir, 'backend').targets;
    expect(target?.kind).toBe('nest');
    expect(target?.values.script).toBe('start:dev');
    expect(target?.port).toBe(3000);
  });

  it('没装依赖 → 不许启动，并且说清"先装依赖"', () => {
    const dir = makeDir();
    writeJson(join(dir, 'package.json'), { scripts: { dev: 'vite' } });

    const [target] = detectRunTargets(dir, 'frontend').targets;
    expect(target?.ready).toBe(false);
    expect(target?.problem).toContain('还没装依赖');
  });

  it('package.json 里没有可跑的脚本 → 如实报，而不是猜一个命令', () => {
    const dir = makeDir();
    writeJson(join(dir, 'package.json'), { scripts: { test: 'vitest' } });
    mkdirSync(join(dir, 'node_modules'), { recursive: true });

    const [target] = detectRunTargets(dir, 'frontend').targets;
    expect(target?.ready).toBe(false);
    expect(target?.problem).toContain('没有 dev / start / start:dev');
  });

  it('package.json 坏了（JSON 解析失败）也算认不出来', () => {
    const dir = makeDir();
    write(join(dir, 'package.json'), '{ 这不是 JSON');
    const result = detectRunTargets(dir, 'frontend');
    expect(result.targets).toEqual([]);
    expect(result.problems.join()).toContain('没找到认得的入口');
  });
});

describe('Python 栈', () => {
  it('FastAPI：uvicorn + 从 .env.example 读端口 + venv 里的 python', () => {
    const dir = makeDir();
    write(join(dir, 'app', 'main.py'), 'from fastapi import FastAPI');
    write(join(dir, 'requirements.txt'), 'fastapi>=0.115\n');
    write(join(dir, '.env.example'), 'APP_NAME=x\nPORT=8123\n');
    mkdirSync(join(dir, '.venv', 'Scripts'), { recursive: true });
    write(join(dir, '.venv', 'Scripts', 'python.exe'), '');

    const [target] = detectRunTargets(dir, 'backend').targets;
    expect(target?.kind).toBe('fastapi');
    expect(target?.specId).toBe('run-python-uvicorn');
    expect(target?.port).toBe(8123);
    expect(target?.values.python).toBe('.venv\\Scripts\\python.exe');
    expect(target?.ready).toBe(true);
  });

  it('Django：manage.py + runserver，没建 venv 就不许启动', () => {
    const dir = makeDir();
    write(join(dir, 'manage.py'), '#!/usr/bin/env python');

    const [target] = detectRunTargets(dir, 'backend').targets;
    expect(target?.kind).toBe('django');
    expect(target?.specId).toBe('run-django-runserver');
    expect(target?.port).toBe(8000);
    expect(target?.ready).toBe(false);
    expect(target?.problem).toContain('.venv');
  });
});

describe('前后端项目', () => {
  it('两个子目录各认一个目标，值位里的路径都是**相对**项目文件夹的', () => {
    const root = makeDir();
    writeJson(join(root, 'frontend', 'package.json'), { scripts: { dev: 'vite' } });
    writeJson(join(root, 'backend', 'package.json'), { scripts: { 'start:dev': 'nest start' } });
    mkdirSync(join(root, 'frontend', 'node_modules'), { recursive: true });
    mkdirSync(join(root, 'backend', 'node_modules'), { recursive: true });

    const result = detectRunTargets(root, 'fullstack');
    expect(result.targets.map((target) => target.role)).toEqual(['frontend', 'backend']);
    expect(result.targets.map((target) => target.subdir)).toEqual(['frontend', 'backend']);
    // 命令的 cwd 是项目文件夹，所以子目录只出现在 subdir 里，不进值位
    expect(result.targets.every((target) => !JSON.stringify(target.values).includes(root))).toBe(true);
  });

  it('子目录缺了要说清是哪一个（而不是笼统的"启动失败"）', () => {
    const root = makeDir();
    writeJson(join(root, 'frontend', 'package.json'), { scripts: { dev: 'vite' } });
    const result = detectRunTargets(root, 'fullstack');
    expect(result.problems.join()).toContain('backend/');
  });

  it('认不出来时给出"在哪个目录里没找到什么"', () => {
    const root = makeDir();
    const result = detectRunTargets(root, 'frontend');
    expect(result.targets).toEqual([]);
    expect(result.problems.join()).toContain('package.json');
  });
});
