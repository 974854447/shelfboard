import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { DbConnection } from '../src/db/connection';
import { createLogger } from '../src/logging/logger';
import { createServiceContext, type ServiceContext } from '../src/services/context';
import type { JobContext } from '../src/services/job-runner';
import {
  decideAfterOfficialFailure,
  listScaffoldTemplates,
  parseScaffoldPayload,
  planScaffold,
  runScaffoldJob,
  scaffoldTitle,
  toPackageName,
  validatePort,
} from '../src/services/job-scaffold';
import { findTemplate } from '../src/services/scaffold-templates';
import * as projectService from '../src/services/projects';

/**
 * 脚手架作业（M4）。
 *
 * 这里测的是**计划与执行的可预期部分**：单栈落根目录 / 双栈分 frontend+backend、
 * 包名要 ASCII 安全、payload 要能挡住乱传、官方未接入时必须**明说**而不是假装成功。
 *
 * 注意：`planScaffold` 是纯函数，所以绝大多数断言不需要磁盘；真正落盘的 e2e 在
 * `scripts/e2e/scenarios/scaffold.cjs`。
 */

const cleanups: Array<() => void> = [];

afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()?.();
});

function makeCtx(): ServiceContext {
  const conn = new DbConnection();
  conn.open(':memory:');
  const ctx = createServiceContext({
    conn,
    logger: createLogger({ source: 'api', minLevel: 'error' }),
  });
  cleanups.push(() => conn.close());
  return ctx;
}

describe('计划：单栈与双栈落在哪', () => {
  it('只选一个栈 → 生成到项目文件夹根目录（0.1.2：代码就在这一层）', () => {
    const plan = planScaffold({
      projectId: 'p1',
      projectFolder: 'my-app',
      targets: [{ templateId: 'fastapi' }],
    });
    expect(plan.problems).toEqual([]);
    expect(plan.items).toHaveLength(1);
    expect(plan.items[0]?.subdir).toBe('');
    expect(plan.items[0]?.strategy).toBe('builtin');
  });

  it('前后端都要 → frontend / backend 两个子目录（否则两边会互相覆盖）', () => {
    const plan = planScaffold({
      projectId: 'p1',
      projectFolder: 'my-app',
      targets: [{ templateId: 'vue3' }, { templateId: 'fastapi' }],
    });
    expect(plan.problems).toEqual([]);
    expect(plan.items.map((item) => item.subdir)).toEqual(['frontend', 'backend']);
  });

  it('两个同类的栈会撞在同一个目录上 → 明确报问题，而不是默默覆盖', () => {
    const plan = planScaffold({
      projectId: 'p1',
      projectFolder: 'my-app',
      targets: [{ templateId: 'vue3' }, { templateId: 'vue3' }],
    });
    expect(plan.problems.join()).toContain('互相覆盖');
  });

  it('不认识的模板名要报出来', () => {
    const plan = planScaffold({
      projectId: 'p1',
      projectFolder: 'my-app',
      targets: [{ templateId: 'svelte' }],
    });
    expect(plan.problems.join()).toContain('不认识的模板');
  });

  it('官方优先：Vue / Django 标成 official，FastAPI 是 builtin', () => {
    const plan = planScaffold({
      projectId: 'p1',
      projectFolder: 'x',
      targets: [{ templateId: 'vue3' }, { templateId: 'fastapi' }],
    });
    expect(plan.items[0]?.strategy).toBe('official');
    expect(plan.items[0]?.fallbackTemplateId).toBe('vue3');
    expect(plan.items[1]?.strategy).toBe('builtin');
  });
});

describe('包名', () => {
  it('中文/空格项目名要转成 ASCII 安全名（npm 与 Python 包名都只认这套）', () => {
    expect(toPackageName('我的后端', '')).toBe('app');
    expect(toPackageName('My Cool App', '')).toBe('my-cool-app');
    expect(toPackageName('项目', 'frontend')).toBe('frontend');
  });

  it('转不出可用名字时有兜底，不会是空字符串', () => {
    expect(toPackageName('中文项目名', '')).not.toBe('');
    expect(toPackageName('---', '')).toBe('app');
  });
});

describe('payload 校验（服务端不能只信界面）', () => {
  it('缺 projectId 或没有 targets 都要报错', () => {
    expect(() => parseScaffoldPayload({})).toThrow(/缺少 projectId/);
    expect(() => parseScaffoldPayload({ projectId: 'p1' })).toThrow(/至少要选一个技术栈/);
    expect(() => parseScaffoldPayload({ projectId: 'p1', targets: [{ templateId: 42 }] })).toThrow(
      /至少要选一个技术栈/,
    );
  });

  it('正常的 payload 解析成结构化请求，端口可以省略', () => {
    expect(parseScaffoldPayload({ projectId: 'p1', targets: [{ templateId: 'fastapi' }] })).toEqual({
      projectId: 'p1',
      targets: [{ templateId: 'fastapi', subdir: '' }],
    });
    expect(
      parseScaffoldPayload({ projectId: 'p1', targets: [{ templateId: 'fastapi' }], port: 8000 }).port,
    ).toBe(8000);
  });
});

describe('执行（走到"计划不成立"就停，不去碰磁盘）', () => {
  function fakeJob(
    ctx: ServiceContext,
    commandResult?: { code?: number | null; stdout?: string; stderr?: string },
  ): { job: JobContext; logs: string[]; progress: number[] } {
    const logs: string[] = [];
    const progress: number[] = [];
    const job: JobContext = {
      jobId: 'job-1',
      ctx,
      signal: new AbortController().signal,
      log: (message) => void logs.push(message),
      progress: (percent) => void progress.push(percent),
      runCommand: async () => {
        if (!commandResult) throw new Error('这个用例不该跑外部命令');
        return {
          specId: 'probe-npm-create',
          bin: 'npm',
          args: [],
          code: commandResult.code ?? 0,
          ok: (commandResult.code ?? 0) === 0,
          timedOut: false,
          canceled: false,
          stdout: commandResult.stdout ?? '',
          stderr: commandResult.stderr ?? '',
          durationMs: 1,
        };
      },
      throwIfCanceled: () => undefined,
    };
    return { job, logs, progress };
  }

  it('项目不存在 → 报"这个项目不存在"，而不是生成到一个意外的目录', async () => {
    const ctx = makeCtx();
    const { job } = fakeJob(ctx);
    await expect(
      runScaffoldJob(job, { projectId: 'nope', targets: [{ templateId: 'fastapi', subdir: '' }] }),
    ).rejects.toThrow(/不存在/);
  });

  it('没有工作区目录 → 明确报错（不能生成到"当前目录"）', async () => {
    const ctx = makeCtx();
    const project = projectService.createProject(ctx, { name: 'P' });
    const { job } = fakeJob(ctx);

    // createProject 在没有 workspaceRoot 时不会分配文件夹，所以这里先手动补一个
    ctx.sqlite.prepare('UPDATE projects SET folder = ? WHERE id = ?').run('p-folder', project.id);

    await expect(
      runScaffoldJob(job, {
        projectId: project.id,
        targets: [{ templateId: 'fastapi', subdir: '' }],
      }),
    ).rejects.toThrow(/没有工作区目录/);
  });

  it('官方脚手架探测失败时，回退内置骨架并**如实说明**走的是回退路径', async () => {
    const ctx = makeCtx();
    const dir = mkdtemp();
    const withRoot = createServiceContext({
      conn: ctx.conn,
      logger: ctx.logger,
      workspaceRoot: dir,
    });
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));

    const project = projectService.createProject(withRoot, { name: 'My App' });
    // 探测失败（模拟断网）：探测命令返回非 0
    const { job, logs, progress } = fakeJob(withRoot, { code: 1, stderr: 'network unreachable' });

    const result = await runScaffoldJob(job, {
      projectId: project.id,
      targets: [{ templateId: 'vue3', subdir: '' }],
    });

    expect(logs.join('\n')).toContain('改用内置骨架');
    expect(logs.join('\n')).toContain('最小骨架');
    expect(result.targets).toHaveLength(1);
    expect(progress.at(-1)).toBe(100);
    // 回退也要真的落盘
    expect(existsSync(join(dir, project.folder as string, 'package.json'))).toBe(true);
  });

  /**
   * Django 的官方路径有个**前置**（先建 venv 装 Django），前置失败必须能回退。
   *
   * 这条是"断网能不能用"的保证：官方那条要联网，而内置骨架离线可用 ——
   * 只做官方就等于"断网时 Django 项目完全建不出来"。
   */
  it('Django：官方前置失败（例如断网装不上）→ 回退内置骨架，且真的落盘', async () => {
    const ctx = makeCtx();
    const dir = mkdtemp();
    const withRoot = createServiceContext({
      conn: ctx.conn,
      logger: ctx.logger,
      workspaceRoot: dir,
    });
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));

    const project = projectService.createProject(withRoot, { name: 'Django App' });
    // 第一条命令（建 venv）就失败 = 模拟"这台机器上装不成"
    const { job, logs } = fakeJob(withRoot, { code: 1, stderr: 'venv not available' });

    const result = await runScaffoldJob(job, {
      projectId: project.id,
      targets: [{ templateId: 'django', subdir: '' }],
    });

    const text = logs.join('\n');
    expect(text).toContain('改用内置骨架');
    expect(result.targets).toHaveLength(1);
    // 回退也要真的落盘：manage.py 与包目录都在
    const projectDir = result.projectDir as string;
    expect(existsSync(join(projectDir, 'manage.py'))).toBe(true);
    expect(existsSync(join(projectDir, 'requirements.txt'))).toBe(true);
  });

  it('官方走不通且**没有内置骨架**时直接失败（不静默糊过去）', () => {
    // 目前所有走官方的技术栈都有回退，这条规则由纯函数守住；
    // 将来加"只能走官方"的栈时（例如 create-vite 的其它模板），它会立刻生效
    expect(decideAfterOfficialFailure({ fallbackTemplateId: 'vue3', reason: '断网' })).toEqual({
      kind: 'fallback',
      reason: '断网',
    });
    expect(decideAfterOfficialFailure({ fallbackTemplateId: undefined, reason: '断网' })).toEqual({
      kind: 'error',
      reason: '断网',
    });
  });

  it('FastAPI（内置模板）真的把文件写到项目文件夹根目录', async () => {
    const ctx = makeCtx();
    const dir = mkdtemp();
    const withRoot = createServiceContext({
      conn: ctx.conn,
      logger: ctx.logger,
      workspaceRoot: dir,
    });
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));

    const project = projectService.createProject(withRoot, { name: 'Backend' });
    const { job, logs } = fakeJob(withRoot);

    const result = await runScaffoldJob(job, {
      projectId: project.id,
      targets: [{ templateId: 'fastapi', subdir: '' }],
      port: 8000,
    });

    const projectDir = result.projectDir as string;
    expect(existsSync(join(projectDir, 'app', 'main.py'))).toBe(true);
    expect(existsSync(join(projectDir, 'requirements.txt'))).toBe(true);
    // 项目文件夹自带的 attachments/ 不能被骨架生成动到
    expect(existsSync(join(projectDir, 'attachments'))).toBe(true);
    expect(readFileSync(join(projectDir, 'app', 'main.py'), 'utf8')).toContain('8000');
    expect(logs.join('\n')).toContain('写入');
  });

  it('不传端口时用**那个栈的惯例端口**（Python 8000，而不是 Vite 的 5173）', async () => {
    const ctx = makeCtx();
    const dir = mkdtemp();
    const withRoot = createServiceContext({
      conn: ctx.conn,
      logger: ctx.logger,
      workspaceRoot: dir,
    });
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));

    const project = projectService.createProject(withRoot, { name: 'Backend' });
    const { job } = fakeJob(withRoot);

    const result = await runScaffoldJob(job, {
      projectId: project.id,
      targets: [{ templateId: 'fastapi', subdir: '' }],
    });

    const main = readFileSync(join(result.projectDir as string, 'app', 'main.py'), 'utf8');
    expect(main).toContain('8000');
    expect(main).not.toContain('5173');
  });

  it('端口校验：越界、小数、乱字符串都要拒绝（服务端不能只信界面）', () => {
    expect(validatePort(8000)).toBe(8000);
    expect(validatePort('8000')).toBe(8000);
    expect(validatePort(undefined)).toBeUndefined();
    for (const bad of [0, 65536, 80.5, 'abc', -1, Number.NaN]) {
      expect(() => validatePort(bad), String(bad)).toThrow(/端口不合法/);
    }
  });

  it('技术栈清单带上"是否需要联网"与默认端口（界面据此如实标注）', () => {
    const list = listScaffoldTemplates();
    const vue = list.find((item) => item.id === 'vue3');
    const react = list.find((item) => item.id === 'react');
    const fastapi = list.find((item) => item.id === 'fastapi');
    const nestjs = list.find((item) => item.id === 'nestjs');
    expect(vue).toMatchObject({ needsNetwork: true, defaultPort: 5173, installKind: 'node' });
    expect(react).toMatchObject({ needsNetwork: true, defaultPort: 5173, installKind: 'node' });
    expect(fastapi).toMatchObject({ needsNetwork: false, defaultPort: 8000, installKind: 'python' });
    // 每个栈都要有默认端口，否则向导的端口输入框会拿到 undefined
    expect(list.every((item) => Number.isInteger(item.defaultPort))).toBe(true);
    // 维度要跟着清单一起给界面（界面照它渲染，服务端不再另写一份）
    expect(vue?.dimensions.map((item) => item.id).sort()).toEqual(['addons', 'language', 'version']);
    expect(vue?.languageLabel).toBe('TypeScript / JavaScript');
    // 内置的 Python 栈**只有版本**这一个维度：语言是静态文字，附加项一个都没有
    expect(fastapi?.dimensions.map((item) => item.id)).toEqual(['version']);
    expect(fastapi?.languageLabel).toBe('Python');
    // Node 栈要带上引擎要求（写进生成出来的 package.json）
    expect(vue?.enginesNode).toContain('20.19');
    expect(nestjs?.enginesNode).toBe('>=20');
    expect(fastapi?.enginesNode).toBeUndefined();
  });

  /**
   * **每个栈各自的端口**（0.2.x 修的真 bug）。
   *
   * 上一版整个作业只有一个 `port`，前后端两块共用 —— 双栈项目生成出来
   * `vite.config.ts` 与 `app.listen()` 是**同一个端口**，起服务必撞号。
   * 这两条盯的就是"两个目标各自拿到自己的端口"。
   */
  it('双栈时两个目标各用**自己的**端口（不再共用同一个号）', async () => {
    const ctx = makeCtx();
    const dir = mkdtemp();
    const withRoot = createServiceContext({
      conn: ctx.conn,
      logger: ctx.logger,
      workspaceRoot: dir,
    });
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));

    const project = projectService.createProject(withRoot, { name: 'Full App' });
    /*
     * 前端是 Vue（官方脚手架），这里让探测命令返回非 0 = 模拟断网，
     * 于是它走**内置回退骨架**落盘 —— 端口逻辑两条路都适用，而回退路径不依赖网络。
     */
    const { job, logs } = fakeJob(withRoot, { code: 1, stderr: 'network unreachable' });

    const result = await runScaffoldJob(job, {
      projectId: project.id,
      targets: [
        { templateId: 'vue3', subdir: '', port: 5174 },
        { templateId: 'fastapi', subdir: '', port: 8010 },
      ],
    });

    const projectDir = result.projectDir as string;
    expect(readFileSync(join(projectDir, 'frontend', 'vite.config.ts'), 'utf8')).toContain('5174');
    expect(readFileSync(join(projectDir, 'backend', 'app', 'main.py'), 'utf8')).toContain('8010');
    // 日志里也要能看出每个目标的端口（出问题时能当证据）
    expect(logs.join('\n')).toContain('端口 5174');
    expect(logs.join('\n')).toContain('端口 8010');
  });

  it('哪个目标没给端口，就用**那个栈自己的**惯例端口', async () => {
    const ctx = makeCtx();
    const dir = mkdtemp();
    const withRoot = createServiceContext({
      conn: ctx.conn,
      logger: ctx.logger,
      workspaceRoot: dir,
    });
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));

    const project = projectService.createProject(withRoot, { name: 'Half App' });
    const { job } = fakeJob(withRoot, { code: 1, stderr: 'network unreachable' });

    // 只给前端端口，后端不填 → 后端要用 fastapi 的 8000，而不是跟着前端走
    const result = await runScaffoldJob(job, {
      projectId: project.id,
      targets: [
        { templateId: 'vue3', subdir: '', port: 5199 },
        { templateId: 'fastapi', subdir: '' },
      ],
    });

    const projectDir = result.projectDir as string;
    expect(readFileSync(join(projectDir, 'frontend', 'vite.config.ts'), 'utf8')).toContain('5199');
    const backendMain = readFileSync(join(projectDir, 'backend', 'app', 'main.py'), 'utf8');
    expect(backendMain).toContain('8000');
    expect(backendMain).not.toContain('5199');
  });

  /**
   * 维度选择要真的影响落盘结果：走内置回退（探测失败）时也要按选的语言生成。
   * 上面 `fakeJob(withRoot, { code: 1 })` 就是"断网"的模拟。
   */
  it('维度选择落到文件里：选了 JavaScript 就没有 tsconfig，而是 jsconfig', async () => {
    const ctx = makeCtx();
    const dir = mkdtemp();
    const withRoot = createServiceContext({
      conn: ctx.conn,
      logger: ctx.logger,
      workspaceRoot: dir,
    });
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));

    const project = projectService.createProject(withRoot, { name: 'Js App' });
    const failedProbe = fakeJob(withRoot, { code: 1, stderr: 'network unreachable' });

    const result = await runScaffoldJob(failedProbe.job, {
      projectId: project.id,
      targets: [{ templateId: 'vue3', subdir: '', selections: { language: 'js', addons: [] } }],
    });

    const projectDir = result.projectDir as string;
    expect(existsSync(join(projectDir, 'jsconfig.json'))).toBe(true);
    expect(existsSync(join(projectDir, 'tsconfig.json'))).toBe(false);
    expect(existsSync(join(projectDir, 'src', 'main.js'))).toBe(true);
    // 日志里要写清"用户选的是什么"（出了分歧能当证据）
    expect(failedProbe.logs.join('\n')).toContain('JavaScript');
  });

  it('payload 里的维度选择会被校验（不认识的维度/取值直接拒绝）', () => {
    const parsed = parseScaffoldPayload({
      projectId: 'p1',
      targets: [
        { templateId: 'vue3', selections: { language: 'js', version: 'rc', addons: ['pinia'] } },
      ],
    });
    expect(parsed.targets[0]?.selections).toEqual({ language: 'js', version: 'rc', addons: ['pinia'] });
    // 没传 selections 时用描述的默认值（旧界面/旧载荷照样能跑）
    expect(
      parseScaffoldPayload({ projectId: 'p1', targets: [{ templateId: 'vue3' }] }).targets[0]?.selections,
    ).toBeUndefined();

    expect(() =>
      parseScaffoldPayload({
        projectId: 'p1',
        targets: [{ templateId: 'vue3', selections: { language: 'kotlin' } }],
      }),
    ).toThrow(/只能是/);
    expect(() =>
      parseScaffoldPayload({
        projectId: 'p1',
        targets: [{ templateId: 'vue3', selections: { theme: 'dark' } }],
      }),
    ).toThrow(/没有「theme」这个选项/);
    // 内置栈没有可选维度：塞一个进来必须报错，而不是静默忽略
    expect(() =>
      parseScaffoldPayload({
        projectId: 'p1',
        targets: [{ templateId: 'fastapi', selections: { language: 'js' } }],
      }),
    ).toThrow(/没有「language」这个选项/);
  });
  it('再生成一次不会覆盖已有文件（幂等，且把跳过的事说清楚）', async () => {
    const ctx = makeCtx();
    const dir = mkdtemp();
    const withRoot = createServiceContext({
      conn: ctx.conn,
      logger: ctx.logger,
      workspaceRoot: dir,
    });
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));

    const project = projectService.createProject(withRoot, { name: 'Backend' });
    const first = fakeJob(withRoot);
    await runScaffoldJob(first.job, {
      projectId: project.id,
      targets: [{ templateId: 'fastapi', subdir: '' }],
    });

    writeFileSync(join(dir, (project.folder as string), 'README.md'), '我自己写的\n', 'utf8');

    const second = fakeJob(withRoot);
    await runScaffoldJob(second.job, {
      projectId: project.id,
      targets: [{ templateId: 'fastapi', subdir: '' }],
    });

    expect(readFileSync(join(dir, project.folder as string, 'README.md'), 'utf8')).toBe('我自己写的\n');
    expect(second.logs.join('\n')).toContain('跳过已存在的文件');
  });
});

describe('作业标题', () => {
  it('标题里带上技术栈名（作业中心一眼看出在给谁生成）', () => {
    expect(scaffoldTitle({ targets: [{ templateId: 'fastapi' }] })).toContain('FastAPI');
    expect(scaffoldTitle({ targets: [{ templateId: 'vue3' }, { templateId: 'fastapi' }] })).toContain(
      '前后端',
    );
    expect(findTemplate('fastapi')?.name).toBe('FastAPI');
  });
});

/* ------------------------------------------------------------------ */

function mkdtemp(): string {
  return mkdtempSync(join(tmpdir(), 'scaffold-'));
}
