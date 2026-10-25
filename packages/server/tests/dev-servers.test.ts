import { EventEmitter } from 'node:events';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { DbConnection } from '../src/db/connection';
import { createLogger } from '../src/logging/logger';
import { createServiceContext, type ServiceContext } from '../src/services/context';
import { createDevServers, parseDevServerUrl } from '../src/services/dev-servers';
import * as projectService from '../src/services/projects';
import { ensureProjectFolder } from '../src/services/project-folders';

/**
 * 开发服务器的启动 / 停止（M4）。
 *
 * **不真的派生进程**：注入一个假的 `spawn`，于是可以在毫秒级里验证
 * "命令对不对、状态机对不对、停止有没有杀整棵树" —— 真跑一次留给端到端
 * （`scripts/e2e/scenarios/run-project.cjs`，那里真的起一个 node 服务再停掉）。
 */

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()?.();
  vi.restoreAllMocks();
});

function makeWorkspace(): { ctx: ServiceContext; root: string } {
  const conn = new DbConnection();
  conn.open(':memory:');
  const root = mkdtempSync(join(tmpdir(), 'dev-servers-'));
  const ctx = createServiceContext({
    conn,
    logger: createLogger({ source: 'api', minLevel: 'error' }),
    workspaceRoot: root,
  });
  cleanups.push(() => conn.close());
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  return { ctx, root };
}

/** 假的子进程：能 emit 输出与退出，并且记录 kill 调用 */
class FakeChild extends EventEmitter {
  pid = 4242;
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  kill = vi.fn(() => true);
  emitOutput(text: string, stream: 'stdout' | 'stderr' = 'stdout'): void {
    (stream === 'stdout' ? this.stdout : this.stderr).emit('data', Buffer.from(text, 'utf8'));
  }
}

function makeFakeSpawn(): { spawnFn: never; children: FakeChild[]; calls: Array<{ bin: string; args: string[]; cwd?: string }> } {
  const children: FakeChild[] = [];
  const calls: Array<{ bin: string; args: string[]; cwd?: string }> = [];
  const spawnFn = (bin: string, args: string[], options: { cwd?: string } = {}) => {
    calls.push({ bin, args, ...(options.cwd !== undefined ? { cwd: options.cwd } : {}) });
    const child = new FakeChild();
    children.push(child);
    /*
     * `taskkill` 这种"跑完就结束"的命令，假的也要**真的结束**：
     * 否则测到的是我们自己的超时分支（"停止超时：进程可能还在跑"），
     * 而不是"停止成功"。真进程会 emit 一次 exit，这里就用 setImmediate 模拟。
     */
    if (bin === 'taskkill') setImmediate(() => child.emit('exit', 0, null));
    return child;
  };
  return { spawnFn: spawnFn as never, children, calls };
}

/** 造一个"装了依赖的 Vite 项目" */
function seedNodeProject(ctx: ServiceContext, name: string, port = 5173): string {
  const project = projectService.createProject(ctx, { name, codeKind: 'frontend' });
  const folder = join(ctx.workspaceRoot as string, project.folder as string);
  ensureProjectFolder(ctx.workspaceRoot as string, project.folder as string);
  writeFileSync(
    join(folder, 'package.json'),
    JSON.stringify({ name: 'demo', scripts: { dev: 'vite' } }, null, 2),
    'utf8',
  );
  writeFileSync(join(folder, 'vite.config.ts'), `export default { server: { port: ${port} } }`, 'utf8');
  mkdirSync(join(folder, 'node_modules'), { recursive: true });
  return project.id;
}

describe('从进程输出里认地址（这次"打不开"的根因就在这儿）', () => {
  it('Vite / uvicorn / Django 三种写法都认', () => {
    expect(parseDevServerUrl('  ➜  Local:   http://localhost:5173/')).toEqual({
      url: 'http://localhost:5173/',
      port: 5173,
    });
    expect(parseDevServerUrl('Uvicorn running on http://127.0.0.1:8000 (Press CTRL+C to quit)')).toEqual(
      { url: 'http://127.0.0.1:8000/', port: 8000 },
    );
    expect(parseDevServerUrl('Starting development server at http://127.0.0.1:8000/')).toEqual({
      url: 'http://127.0.0.1:8000/',
      port: 8000,
    });
  });

  it('端口被自动换掉时以它打印的为准（5173 被占 → Vite 退到 5174）', () => {
    expect(parseDevServerUrl('  ➜  Local:   http://localhost:5174/')?.port).toBe(5174);
  });

  it('`0.0.0.0` 归一成 localhost（那不是能给用户点的地址）', () => {
    expect(parseDevServerUrl('Listening on http://0.0.0.0:9000/')?.url).toBe('http://localhost:9000/');
  });

  it('认不出来就返回 null（不猜）', () => {
    expect(parseDevServerUrl('Watching for file changes…')).toBeNull();
    expect(parseDevServerUrl('http://localhost/')).toBeNull();
  });
});

describe('启动', () => {
  it('用白名单命令启动，cwd 是项目文件夹，端口取自生成的配置', async () => {
    const { ctx } = makeWorkspace();
    const projectId = seedNodeProject(ctx, '前端项目', 5174);
    const fake = makeFakeSpawn();
    const servers = createDevServers(ctx, { spawnFn: fake.spawnFn });

    const [state] = await servers.start(projectId);

    /*
     * 断言的是"命令的尾巴"而不是完整 argv：Windows 上 npm / pnpm 是 `.cmd` 批处理壳，
     * `buildCommand` 会把命令包成 `cmd.exe /d /c pnpm run dev`（那是必须的，
     * 否则 `shell: false` 起不来）。用 `run dev` 结尾就说明脚本与参数都对。
     */
    expect(fake.calls[0]?.args.slice(-2)).toEqual(['run', 'dev']);
    expect(fake.calls[0]?.args.join(' ')).toMatch(/pnpm|npm|yarn/);
    expect(fake.calls[0]?.cwd).toBe(join(ctx.workspaceRoot as string, '前端项目'));
    expect(state?.status).toBe('running');
    expect(state?.port).toBe(5174);
    expect(state?.pid).toBe(4242);
    // 命令本身要显示给用户看（"到底跑了什么"不能靠猜）
    expect(state?.command).toContain('run dev');
  });

  it('输出里带着地址 → 记下来；服务真的通了 → 标成可达（界面据此才给"打开"入口）', async () => {
    const { ctx } = makeWorkspace();
    const projectId = seedNodeProject(ctx, '前端项目', 5199);
    const fake = makeFakeSpawn();
    const servers = createDevServers(ctx, { spawnFn: fake.spawnFn });

    await servers.start(projectId);
    fake.children[0]?.emitOutput('  ➜  Local:   http://localhost:5199/\n');

    // 这个假进程后面没有真的服务，所以探测不会通过 —— 但地址要被学下来
    const [state] = servers.states(projectId);
    expect(state?.url).toBe('http://localhost:5199/');
    expect(state?.port).toBe(5199);
  });

  it('输出**边跑边收**（这是它不能走作业执行器的原因）', async () => {
    const { ctx } = makeWorkspace();
    const projectId = seedNodeProject(ctx, '前端项目');
    const fake = makeFakeSpawn();
    const servers = createDevServers(ctx, { spawnFn: fake.spawnFn });

    await servers.start(projectId);
    fake.children[0]?.emitOutput('VITE v8.3.1  ready in 320 ms\n');
    fake.children[0]?.emitOutput('  ➜  Local:   http://localhost:5173/\n');

    const [state] = servers.states(projectId);
    expect(state?.log.map((line) => line.text).join('\n')).toContain('ready in 320 ms');
    expect(state?.log.map((line) => line.text).join('\n')).toContain('localhost:5173');
    // 界面上也要能拿到（overview 里带状态）
    expect(servers.overview(projectId).targets[0]?.state?.log.length).toBeGreaterThan(2);
  });

  it('依赖没装好 → 明确报"先装依赖"，不去派生进程', async () => {
    const { ctx } = makeWorkspace();
    const project = projectService.createProject(ctx, { name: '空前端', codeKind: 'frontend' });
    const folder = join(ctx.workspaceRoot as string, project.folder as string);
    writeFileSync(join(folder, 'package.json'), JSON.stringify({ scripts: { dev: 'vite' } }), 'utf8');
    const fake = makeFakeSpawn();
    const servers = createDevServers(ctx, { spawnFn: fake.spawnFn });

    await expect(servers.start(project.id)).rejects.toThrow(/还没装依赖/);
    expect(fake.calls).toEqual([]);
  });

  it('已经在跑就不要再起一个（否则第二个会因为端口被占而失败）', async () => {
    const { ctx } = makeWorkspace();
    const projectId = seedNodeProject(ctx, '前端项目');
    const fake = makeFakeSpawn();
    const servers = createDevServers(ctx, { spawnFn: fake.spawnFn });

    await servers.start(projectId);
    await expect(servers.start(projectId)).rejects.toThrow(/已经在运行/);
    expect(fake.children).toHaveLength(1);
  });

  it('纯管理项目不能启动（界面上本来也不会有按钮）', async () => {
    const { ctx } = makeWorkspace();
    const project = projectService.createProject(ctx, { name: '纯管理' });
    const fake = makeFakeSpawn();
    const servers = createDevServers(ctx, { spawnFn: fake.spawnFn });

    expect(servers.overview(project.id).runnable).toBe(false);
    await expect(servers.start(project.id)).rejects.toThrow(/纯管理项目不生成代码/);
  });

  it('端口可以在启动前改（只影响这一次）', async () => {
    const { ctx } = makeWorkspace();
    const projectId = seedNodeProject(ctx, '前端项目', 5173);
    const fake = makeFakeSpawn();
    const servers = createDevServers(ctx, { spawnFn: fake.spawnFn });

    const [state] = await servers.start(projectId, { port: 4321 });
    expect(state?.port).toBe(4321);
  });
});

describe('停止', () => {
  it('杀的是**整棵进程树**（否则孙进程还占着端口）', async () => {
    const { ctx } = makeWorkspace();
    const projectId = seedNodeProject(ctx, '前端项目');
    const fake = makeFakeSpawn();
    const servers = createDevServers(ctx, { spawnFn: fake.spawnFn });

    await servers.start(projectId);
    const [stopped] = await servers.stop(projectId);

    expect(stopped?.status).toBe('stopped');
    // 第二次 spawn 是 taskkill：/PID 4242 /T /F
    expect(fake.calls[1]?.bin).toBe('taskkill');
    expect(fake.calls[1]?.args).toEqual(['/PID', '4242', '/T', '/F']);
    expect(servers.runningProjectIds()).toEqual([]);
  });

  it('进程**自己退出**（没点过停止）算失败，并把原因留在输出里', async () => {
    const { ctx } = makeWorkspace();
    const projectId = seedNodeProject(ctx, '前端项目');
    const fake = makeFakeSpawn();
    const servers = createDevServers(ctx, { spawnFn: fake.spawnFn });

    await servers.start(projectId);
    fake.children[0]?.emitOutput('Error: listen EADDRINUSE: address already in use :::5173', 'stderr');
    fake.children[0]?.emit('exit', 1, null);

    const [state] = servers.states(projectId);
    expect(state?.status).toBe('failed');
    expect(state?.error).toContain('进程退出');
    expect(state?.log.map((line) => line.text).join('\n')).toContain('EADDRINUSE');
    // 失败的进程不该继续算"运行中"
    expect(servers.runningProjectIds()).toEqual([]);
  });

  it('停止之后再启动：状态回到运行中（不是"停一次就再也起不来"）', async () => {
    const { ctx } = makeWorkspace();
    const projectId = seedNodeProject(ctx, '前端项目');
    const fake = makeFakeSpawn();
    const servers = createDevServers(ctx, { spawnFn: fake.spawnFn });

    await servers.start(projectId);
    await servers.stop(projectId);
    const [again] = await servers.start(projectId);
    expect(again?.status).toBe('running');
  });

  it('应用退出时全部停掉（不留孤儿进程占端口）', async () => {
    const { ctx } = makeWorkspace();
    const projectId = seedNodeProject(ctx, '前端项目');
    const fake = makeFakeSpawn();
    const servers = createDevServers(ctx, { spawnFn: fake.spawnFn });

    await servers.start(projectId);
    servers.shutdown();

    expect(fake.calls.some((call) => call.bin === 'taskkill')).toBe(true);
    expect(servers.runningProjectIds()).toEqual([]);
  });
});
