import { afterEach, describe, expect, it } from 'vitest';

import { DbConnection } from '../src/db/connection';
import { createLogger } from '../src/logging/logger';
import { createServiceContext, type ServiceContext } from '../src/services/context';
import {
  createJobEventHub,
  createJobRunner,
  JobCanceledError,
  type JobContext,
  type JobEvent,
  type JobHandlerSpec,
  type JobRunner,
} from '../src/services/job-runner';
import { getJobOrThrow, listJobLogs, listJobs, recoverInterruptedJobs } from '../src/services/jobs';

/**
 * 作业执行器（M4）。
 *
 * 这里测的是**编排**，不是"能不能跑外部命令"（那是 commands.test.ts 的事）：
 * 排队与并发上限、进度落库、日志批量刷、取消到底是哪种状态、失败要说清原因、
 * 崩溃后残留的作业不能永远"进行中"。
 *
 * 全部用注入的假 handler，不派生任何真实进程；日志刷库的时间窗也调小，
 * 免得测试为了等一个 500ms 的定时器而变慢。
 */

const cleanups: Array<() => void> = [];

afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()?.();
});

let clock = 1_700_000_000_000;

function makeCtx(): ServiceContext {
  const conn = new DbConnection();
  conn.open(':memory:');
  const ctx = createServiceContext({
    conn,
    logger: createLogger({ source: 'api', minLevel: 'error' }),
    now: () => (clock += 1000),
  });
  cleanups.push(() => conn.close());
  return ctx;
}

interface Harness {
  ctx: ServiceContext;
  runner: JobRunner;
  events: JobEvent[];
}

function setup(handlers: readonly JobHandlerSpec[]): Harness {
  const ctx = makeCtx();
  const events: JobEvent[] = [];
  const hub = createJobEventHub();
  hub.subscribe((event) => events.push(event));
  cleanups.push(() => hub.close());

  const runner = createJobRunner({
    ctx,
    logger: createLogger({ source: 'job', minLevel: 'error' }),
    handlers,
    onEvent: (event) => hub.emit(event),
    flushIntervalMs: 5,
    flushLines: 1000,
  });
  cleanups.push(() => runner.shutdown());

  return { ctx, runner, events };
}

/** 一个可控的 handler：测试决定它什么时候结束 */
function controllable(behaviour: {
  type?: string;
  concurrency?: number;
  run: (ctx: JobContext) => Promise<Record<string, unknown> | void>;
}): { spec: JobHandlerSpec; started: string[]; finished: string[] } {
  const started: string[] = [];
  const finished: string[] = [];
  const spec: JobHandlerSpec = {
    type: behaviour.type ?? 'demo',
    title: (payload) => `演示作业 ${String(payload.name ?? '')}`.trim(),
    concurrency: behaviour.concurrency ?? 2,
    handler: async (jobCtx, payload) => {
      started.push(jobCtx.jobId);
      try {
        return await behaviour.run(jobCtx);
      } finally {
        finished.push(jobCtx.jobId);
        void payload;
      }
    },
  };
  return { spec, started, finished };
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

describe('排队与执行', () => {
  it('建作业后排队跑完：状态、进度、结果都落库', async () => {
    const demo = controllable({
      run: async (job) => {
        job.log('第一步');
        job.progress(50, '中途');
        await sleep(5);
        job.log('第二步');
        return { ok: true };
      },
    });
    const { ctx, runner } = setup([demo.spec]);

    const created = runner.enqueue({ type: 'demo', payload: { name: 'A' } });
    // 排队是**异步**启动的：`enqueue` 必须立刻把"排队中"还给调用方，
    // 而不是同步把 handler 的头几行跑完（那样 HTTP 请求也会被顺带拖住）
    expect(created.status).toBe('queued');
    expect(created.title).toContain('A');

    await runner.drain();

    const finished = getJobOrThrow(ctx, created.id);
    expect(finished.status).toBe('succeeded');
    expect(finished.percent).toBe(100);
    expect(finished.phase).toBe('已完成');
    expect(finished.result).toEqual({ ok: true });
    expect(finished.startedAt).not.toBeNull();
    expect(finished.finishedAt).not.toBeNull();
  });

  it('日志先落内存再批量刷库，最后一条都不少', async () => {
    const demo = controllable({
      run: async (job) => {
        for (let i = 1; i <= 5; i += 1) job.log(`第 ${i} 行`);
      },
    });
    const { ctx, runner } = setup([demo.spec]);
    const job = runner.enqueue({ type: 'demo' });

    await runner.drain();
    // 给最后一次刷新一点时间（时间窗是 5ms）
    await sleep(20);

    const logs = listJobLogs(ctx, job.id);
    expect(logs.map((entry) => entry.message)).toEqual([
      '第 1 行',
      '第 2 行',
      '第 3 行',
      '第 4 行',
      '第 5 行',
    ]);
  });

  it('事件流里有 job 与 logs 两类事件（SSE 就靠它）', async () => {
    const demo = controllable({ run: async (job) => job.log('hello') });
    const { runner, events } = setup([demo.spec]);

    runner.enqueue({ type: 'demo' });
    await runner.drain();
    await sleep(20);

    expect(events.some((event) => event.kind === 'job' && event.job.status === 'running')).toBe(true);
    expect(events.some((event) => event.kind === 'job' && event.job.status === 'succeeded')).toBe(true);
    expect(
      events.some(
        (event) => event.kind === 'logs' && event.entries.some((entry) => entry.message === 'hello'),
      ),
    ).toBe(true);
  });

  it('同一类型的并发上限被遵守（install 类必须是 1）', async () => {
    let active = 0;
    let peak = 0;
    const demo = controllable({
      concurrency: 1,
      run: async () => {
        active += 1;
        peak = Math.max(peak, active);
        await sleep(20);
        active -= 1;
      },
    });
    const { runner } = setup([demo.spec]);

    runner.enqueue({ type: 'demo' });
    runner.enqueue({ type: 'demo' });
    runner.enqueue({ type: 'demo' });
    await runner.drain();

    expect(peak).toBe(1);
    expect(demo.started).toHaveLength(3);
  });

  it('没有注册 handler 的类型：建不出来，也不该静默排队', () => {
    const { runner } = setup([]);
    expect(() => runner.enqueue({ type: 'scaffold' })).toThrow(/没有注册/);
  });
});

describe('失败与取消', () => {
  it('handler 抛错 → failed，并把原因写进去', async () => {
    const demo = controllable({
      run: async () => {
        throw new Error('依赖装不上：网络不通');
      },
    });
    const { ctx, runner } = setup([demo.spec]);
    const job = runner.enqueue({ type: 'demo' });

    await runner.drain();

    const finished = getJobOrThrow(ctx, job.id);
    expect(finished.status).toBe('failed');
    expect(finished.errorCode).toBe('JOB_FAILED');
    expect(finished.errorMessage).toContain('网络不通');
  });

  it('取消正在跑的作业 → canceled（不是 failed：用户自己按的不算错误）', async () => {
    const demo = controllable({
      run: async (job) => {
        // 长循环里必须自己检查取消信号 —— 这是 handler 的责任
        for (let i = 0; i < 100; i += 1) {
          job.throwIfCanceled();
          await sleep(5);
        }
      },
    });
    const { ctx, runner } = setup([demo.spec]);
    const job = runner.enqueue({ type: 'demo' });
    await sleep(20);

    runner.cancel(job.id);
    await runner.drain();

    const finished = getJobOrThrow(ctx, job.id);
    expect(finished.status).toBe('canceled');
    expect(finished.errorCode).toBe('CANCELED');
  });

  it('handler 用 JobCanceledError 主动退出，也落 canceled', async () => {
    const demo = controllable({
      run: async (job) => {
        job.throwIfCanceled();
        throw new JobCanceledError('自己判断该停了');
      },
    });
    const { ctx, runner } = setup([demo.spec]);
    const job = runner.enqueue({ type: 'demo' });
    await runner.drain();
    expect(getJobOrThrow(ctx, job.id).status).toBe('canceled');
  });

  it('取消还在排队的作业：直接从队列里拿走，不会跑', async () => {
    const demo = controllable({
      concurrency: 1,
      run: async (job) => {
        for (let i = 0; i < 40; i += 1) {
          job.throwIfCanceled();
          await sleep(5);
        }
      },
    });
    const { ctx, runner } = setup([demo.spec]);

    const first = runner.enqueue({ type: 'demo' });
    await sleep(10);
    const second = runner.enqueue({ type: 'demo' });

    runner.cancel(second.id);
    await sleep(20);
    expect(getJobOrThrow(ctx, second.id).status).toBe('canceled');
    expect(demo.started).not.toContain(second.id);

    runner.cancel(first.id);
    await runner.drain();
    expect(getJobOrThrow(ctx, first.id).status).toBe('canceled');
  });

  it('已经结束的作业再取消：原样返回，不报错也不改状态', async () => {
    const demo = controllable({ run: async () => undefined });
    const { ctx, runner } = setup([demo.spec]);
    const job = runner.enqueue({ type: 'demo' });
    await runner.drain();

    const again = runner.cancel(job.id);
    expect(again.status).toBe('succeeded');
    expect(getJobOrThrow(ctx, job.id).status).toBe('succeeded');
  });

  it('重试会**新建一条作业**，原来的记录保留（便于对照两次输出）', async () => {
    let attempt = 0;
    const demo = controllable({
      run: async () => {
        attempt += 1;
        if (attempt === 1) throw new Error('第一次失败');
      },
    });
    const { ctx, runner } = setup([demo.spec]);
    const first = runner.enqueue({ type: 'demo' });
    await runner.drain();
    expect(getJobOrThrow(ctx, first.id).status).toBe('failed');

    const second = runner.retry(first.id);
    expect(second.id).not.toBe(first.id);
    expect(second.payload?.retryOf).toBe(first.id);

    await runner.drain();
    expect(getJobOrThrow(ctx, second.id).status).toBe('succeeded');
    // 老那条还在，状态没被改写
    expect(getJobOrThrow(ctx, first.id).status).toBe('failed');
    expect(listJobs(ctx)).toHaveLength(2);
  });

  it('还在跑的时候不能重试', async () => {
    const demo = controllable({ run: async (job) => { await sleep(30); void job; } });
    const { runner } = setup([demo.spec]);
    const job = runner.enqueue({ type: 'demo' });

    expect(() => runner.retry(job.id)).toThrow(/还在跑/);
    await runner.drain();
  });

  it('应用退出时把在跑的作业取消掉（不留孤儿进程）', async () => {
    const demo = controllable({
      run: async (job) => {
        for (let i = 0; i < 100; i += 1) {
          job.throwIfCanceled();
          await sleep(5);
        }
      },
    });
    const { ctx, runner } = setup([demo.spec]);
    const job = runner.enqueue({ type: 'demo' });
    await sleep(15);

    runner.shutdown();
    await sleep(30);

    expect(getJobOrThrow(ctx, job.id).status).toBe('canceled');
  });
});

describe('崩溃恢复', () => {
  it('启动时把残留的 queued / running 标成 interrupted（否则界面上一片"在跑"）', () => {
    const ctx = makeCtx();
    const now = ctx.now();
    ctx.sqlite
      .prepare(
        "INSERT INTO jobs (id, type, title, status, percent, created_at) VALUES ('j1', 'scaffold', '生成项目', 'running', 40, ?)",
      )
      .run(now);
    ctx.sqlite
      .prepare(
        "INSERT INTO jobs (id, type, title, status, percent, created_at) VALUES ('j2', 'install', '装依赖', 'queued', 0, ?)",
      )
      .run(now);
    ctx.sqlite
      .prepare(
        "INSERT INTO jobs (id, type, title, status, percent, created_at) VALUES ('j3', 'install', '装依赖', 'succeeded', 100, ?)",
      )
      .run(now);

    const recovered = recoverInterruptedJobs(ctx);

    expect(recovered).toBe(2);
    expect(getJobOrThrow(ctx, 'j1').status).toBe('interrupted');
    expect(getJobOrThrow(ctx, 'j1').errorMessage).toContain('没有完成');
    expect(getJobOrThrow(ctx, 'j2').status).toBe('interrupted');
    // 已经结束的作业不能被改写
    expect(getJobOrThrow(ctx, 'j3').status).toBe('succeeded');
  });
});
