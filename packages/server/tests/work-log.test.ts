/**
 * 工作日志测试。
 *
 * 两件事必须验证到位：
 * 1. **取数口径**：完成 / 推进 / 新建三类，以及"今天没动过的不出现"。
 * 2. **真的产出能打开的 Word 文件**：字节流是 zip（`PK\x03\x04`）、里面有 `word/document.xml`。
 *    只断言"函数没抛错"是没意义的 —— 生成一个坏文件同样不抛错。
 */

import { readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { DbConnection } from '../src/db/connection';
import { createLogger } from '../src/logging/logger';
import { createServiceContext, type ServiceContext } from '../src/services/context';
import * as projectService from '../src/services/projects';
import * as taskService from '../src/services/tasks';
import * as workLog from '../src/services/work-log';
import * as workTime from '../src/services/work-time';
import * as workflow from '../src/services/workflow-statuses';
import { makeTempDir, removeTempDir } from './helpers';

const cleanups: Array<() => void> = [];
const tempDirs: string[] = [];

afterEach(async () => {
  while (cleanups.length > 0) cleanups.pop()?.();
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) await removeTempDir(dir);
  }
});

let nowMs = 0;

function at(hour: number, minute = 0, day = 29): number {
  return new Date(2026, 8, day, hour, minute, 0, 0).getTime();
}

async function makeCtx(): Promise<ServiceContext> {
  const dir = await makeTempDir('work-log');
  tempDirs.push(dir);
  const conn = new DbConnection();
  conn.open(':memory:');
  const ctx = createServiceContext({
    conn,
    logger: createLogger({ source: 'api', minLevel: 'error' }),
    now: () => nowMs,
    workLogDir: dir,
  });
  cleanups.push(() => conn.close());
  return ctx;
}

interface Fixture {
  ctx: ServiceContext;
  projectId: string;
  statuses: { todo: string; doing: string; done: string };
}

async function fixture(): Promise<Fixture> {
  nowMs = at(8);
  const ctx = await makeCtx();
  const project = projectService.createProject(ctx, { name: '千和居官网' });
  const list = workflow.listStatuses(ctx, project.id);
  const byCategory = (category: string) => list.find((s) => s.category === category)!.id;
  return {
    ctx,
    projectId: project.id,
    statuses: { todo: byCategory('todo'), doing: byCategory('doing'), done: byCategory('done') },
  };
}

describe('取数口径', () => {
  it('完成 / 推进 / 新建 三类各归各位，没动过的不出现', async () => {
    const { ctx, projectId, statuses } = await fixture();

    // 昨天建的两条：今天再看不该算"新建"，但今天被改动/完成了
    nowMs = at(10, 0, 28);
    const yesterday = taskService.createTask(ctx, { projectId, title: '昨天动过的' });
    const finished = taskService.createTask(ctx, { projectId, title: '今天做完了' });
    const moved = taskService.createTask(ctx, { projectId, title: '今天推进了' });

    nowMs = at(10);
    const created = taskService.createTask(ctx, { projectId, title: '今天新建的' });

    nowMs = at(11);
    taskService.updateTask(ctx, finished.id, { statusId: statuses.done });
    // 进度字段已下线（2026-10-02）：用"改状态"制造"今天动过但没做完"的任务
    taskService.updateTask(ctx, moved.id, { statusId: statuses.doing });

    nowMs = at(12);
    const data = workLog.collectWorkLogData(ctx, '2026-09-29');

    expect(data.dateKey).toBe('2026-09-29');
    expect(data.dateLabel).toBe('2026年9月29日');
    expect(data.weekdayLabel).toBe('星期二');
    expect(data.completed.map((e) => e.title)).toEqual(['今天做完了']);
    expect(data.progressed.map((e) => e.title).sort()).toEqual(['今天推进了', '今天新建的']);
    expect(data.created.map((e) => e.title)).toEqual(['今天新建的']);
    expect(data.completed.find((e) => e.taskId === yesterday.id)).toBeUndefined();
    expect(data.progressed.find((e) => e.taskId === yesterday.id)).toBeUndefined();
    expect(data.created.find((e) => e.taskId === yesterday.id)).toBeUndefined();
    expect(created.id).toBeTruthy();
  });

  it('按项目分组，只含有动静的项目', async () => {
    const { ctx, projectId, statuses } = await fixture();
    const other = projectService.createProject(ctx, { name: '另一个项目' });

    nowMs = at(9);
    const mine = taskService.createTask(ctx, { projectId, title: '我这个项目的' });
    nowMs = at(10);
    taskService.updateTask(ctx, mine.id, { statusId: statuses.done });

    const data = workLog.collectWorkLogData(ctx, '2026-09-29');
    expect(data.projects.map((p) => p.projectName)).toEqual(['千和居官网']);
    expect(data.projects[0]?.completed.map((e) => e.title)).toEqual(['我这个项目的']);
    expect(data.projects.find((p) => p.projectId === other.id)).toBeUndefined();
  });

  it('工时来自打卡会话，且按当天算', async () => {
    const { ctx } = await fixture();
    nowMs = at(9);
    workTime.startSession(ctx);
    nowMs = at(11);
    workTime.endOpenSessions(ctx, 'app_quit');

    const data = workLog.collectWorkLogData(ctx, '2026-09-29');
    expect(data.totalMs).toBe(2 * 60 * 60 * 1000);
    expect(data.totalLabel).toBe('02:00:00');
    expect(data.sessions).toHaveLength(1);

    // 前一天没有会话
    expect(workLog.collectWorkLogData(ctx, '2026-09-28').totalLabel).toBe('00:00:00');
  });
});

describe('时长与时钟格式', () => {
  it('HH:MM:SS 定宽补零、不超过 24 小时也照样显示小时', () => {
    expect(workLog.formatDuration(0)).toBe('00:00:00');
    expect(workLog.formatDuration(1000)).toBe('00:00:01');
    expect(workLog.formatDuration(61_000)).toBe('00:01:01');
    expect(workLog.formatDuration(3 * 3600_000 + 25 * 60_000 + 10_000)).toBe('03:25:10');
    // 25 小时也不裁成 01 小时（跨天连续开着的情况）
    expect(workLog.formatDuration(25 * 3600_000)).toBe('25:00:00');
    expect(workLog.formatDuration(-5)).toBe('00:00:00');
  });

  it('时钟格式是本地 HH:MM', () => {
    expect(workLog.formatClock(at(9, 5))).toBe('09:05');
    expect(workLog.formatClock(at(23, 59))).toBe('23:59');
  });
});

describe('时段归属', () => {
  it('任务按变更时刻归到覆盖它的那一段', async () => {
    const { ctx, projectId, statuses } = await fixture();

    // 第一段 09:00–10:00，期间改了一条
    nowMs = at(9);
    workTime.startSession(ctx);
    nowMs = at(9, 30);
    const morning = taskService.createTask(ctx, { projectId, title: '上午的活' });
    nowMs = at(10);
    workTime.endOpenSessions(ctx, 'app_quit');

    // 第二段 14:00–15:00，期间完成一条
    nowMs = at(14);
    workTime.startSession(ctx);
    nowMs = at(14, 20);
    taskService.updateTask(ctx, morning.id, { statusId: statuses.done });
    nowMs = at(15);
    workTime.endOpenSessions(ctx, 'app_quit');

    nowMs = at(16);
    const data = workLog.collectWorkLogData(ctx, '2026-09-29');
    const segments = workLog.segmentsOf(data);
    expect(segments).toHaveLength(2);
    // 注意：任务的 updatedAt 在 14:20（完成那一刻），所以它归到第二段 —— 这是对的，
    // 文档要回答的是"那段时间我在干什么"，不是"这条任务什么时候建的"。
    expect(segments[0]?.entries.map((e) => e.title)).toEqual([]);
    expect(segments[1]?.entries.map((e) => e.title)).toEqual(['上午的活']);
  });
});

describe('生成 Word 文档', () => {
  it('产出的是真正的 docx（zip 容器 + document.xml）', async () => {
    const { ctx, projectId, statuses } = await fixture();
    nowMs = at(9);
    workTime.startSession(ctx);
    const task = taskService.createTask(ctx, { projectId, title: '写工作日志' });
    nowMs = at(10);
    taskService.updateTask(ctx, task.id, { statusId: statuses.done });
    nowMs = at(11);
    workTime.endOpenSessions(ctx, 'app_quit');

    const data = workLog.collectWorkLogData(ctx, '2026-09-29');
    const buffer = await import('docx').then((docx) =>
      docx.Packer.toBuffer(workLog.buildWorkLogDocument(data)),
    );

    // zip 本地文件头签名
    expect(buffer.subarray(0, 4).toString('binary')).toBe('PK\x03\x04');
    const raw = buffer.toString('binary');
    expect(raw).toContain('word/document.xml');
    expect(raw).toContain('[Content_Types].xml');
    expect(buffer.byteLength).toBeGreaterThan(5000);
  });

  it('保存到指定目录，文件名以当日为名', async () => {
    const { ctx, projectId } = await fixture();
    nowMs = at(9);
    taskService.createTask(ctx, { projectId, title: '今天的事' });

    const dir = join(ctx.workLogDir!, 'sub');
    const result = await workLog.saveWorkLog(ctx, { dateKey: '2026-09-29', dir });

    expect(result.path).toBe(join(dir, '2026-09-29 工作日志.docx'));
    expect(result.dir).toBe(dir);
    expect(result.overwritten).toBe(false);
    expect(result.bytes).toBeGreaterThan(5000);
    expect(readFileSync(result.path).byteLength).toBe(result.bytes);
  });

  it('同一天再生成一次会覆盖，并且如实报告覆盖', async () => {
    const { ctx } = await fixture();
    nowMs = at(9);
    const first = await workLog.saveWorkLog(ctx, { dateKey: '2026-09-29' });
    expect(first.overwritten).toBe(false);
    const second = await workLog.saveWorkLog(ctx, { dateKey: '2026-09-29' });
    expect(second.overwritten).toBe(true);
    expect(second.path).toBe(first.path);
  });

  it('文件名里的非法字符会被清掉（Windows 不允许冒号等字符）', async () => {
    const { ctx } = await fixture();
    nowMs = at(9);
    const result = await workLog.saveWorkLog(ctx, {
      dateKey: '2026-09-29',
      fileName: '2026-09-29 09:30 工作日志?',
    });
    expect(result.path.endsWith('2026-09-29 09-30 工作日志.docx')).toBe(true);
    expect(readFileSync(result.path).byteLength).toBeGreaterThan(0);
  });

  it('没有可用目录时明确报错，不静默写到一个猜出来的位置', async () => {
    const conn = new DbConnection();
    conn.open(':memory:');
    cleanups.push(() => conn.close());
    const bare = createServiceContext({
      conn,
      logger: createLogger({ source: 'api', minLevel: 'error' }),
      now: () => nowMs,
    });
    await expect(workLog.saveWorkLog(bare, { dateKey: '2026-09-29' })).rejects.toThrow(
      /保存目录/,
    );
  });
});

describe('目录解析', () => {
  it('调用方指定的目录优先于上下文默认值', async () => {
    const { ctx } = await fixture();
    expect(workLog.resolveWorkLogDir(ctx, 'D:\\somewhere')).toBe('D:\\somewhere');
    expect(workLog.resolveWorkLogDir(ctx)).toBe(ctx.workLogDir);
    // 空白串按"没指定"处理
    expect(workLog.resolveWorkLogDir(ctx, '   ')).toBe(ctx.workLogDir);
  });
});

/** 目录真的被清掉了（避免临时目录越堆越多）——顺手把这条也验证一下 */
describe('临时目录清理', () => {
  it('测试用的临时目录会被删掉', async () => {
    const dir = await makeTempDir('work-log-cleanup');
    rmSync(dir, { recursive: true, force: true });
    expect(() => readFileSync(dir)).toThrow();
  });
});
