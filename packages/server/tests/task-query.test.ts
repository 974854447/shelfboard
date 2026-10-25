import { afterEach, describe, expect, it } from 'vitest';

import { DbConnection } from '../src/db/connection';
import { createLogger } from '../src/logging/logger';
import { createServiceContext, type ServiceContext } from '../src/services/context';
import * as projectService from '../src/services/projects';
import { FTS_MIN_LENGTH, queryTasksAcrossProjects, searchAll } from '../src/services/task-query';
import * as taskService from '../src/services/tasks';
import * as workflow from '../src/services/workflow-statuses';

/**
 * M2：跨项目查询 + 全局搜索。
 *
 * 这一组测试里有两条是**针对实测发现的具体坑**写的，不是泛泛而谈：
 * 1. **中文短词**（"登录"两个汉字）必须能搜到 —— 默认分词器下它一条都搜不出来，
 *    所以实现里必须有少于 3 字回落 LIKE 的那条路径；
 * 2. **软删除的任务不能出现在结果里** —— 索引是触发器同步的，
 *    软删除走的是 UPDATE，索引里会留着那条文档，必须在查询时按 deleted_at 过滤掉。
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

const DAY = 24 * 60 * 60 * 1000;

interface Fixture {
  ctx: ServiceContext;
  projectA: string;
  projectB: string;
  statuses: { todo: string; doing: string; done: string };
}

function fixture(): Fixture {
  const ctx = makeCtx();
  const a = projectService.createProject(ctx, { name: '甲项目' });
  const b = projectService.createProject(ctx, { name: '乙项目' });
  const list = workflow.listStatuses(ctx, a.id);
  const byCategory = (category: string) => list.find((s) => s.category === category)!.id;
  return {
    ctx,
    projectA: a.id,
    projectB: b.id,
    statuses: { todo: byCategory('todo'), doing: byCategory('doing'), done: byCategory('done') },
  };
}

describe('queryTasksAcrossProjects', () => {
  it('把两个项目的任务一起取出来，并带上所属项目名', () => {
    const { ctx, projectA, projectB, statuses } = fixture();
    taskService.createTask(ctx, { projectId: projectA, title: 'A 的活', statusId: statuses.todo });
    taskService.createTask(ctx, { projectId: projectB, title: 'B 的活', statusId: statuses.todo });

    const result = queryTasksAcrossProjects(ctx, {});

    expect(result.items.map((item) => item.title).sort()).toEqual(['A 的活', 'B 的活']);
    // 跨项目列表必须能看出"这条属于哪个项目"，否则同名任务分不清
    expect(result.items.every((item) => item.projectName.length > 0)).toBe(true);
    expect(new Set(result.items.map((item) => item.projectName))).toEqual(new Set(['甲项目', '乙项目']));
  });

  it('按截止时间区间筛选，并支持"只看未完成"', () => {
    const { ctx, projectA, statuses } = fixture();
    const now = ctx.now();
    taskService.createTask(ctx, {
      projectId: projectA,
      title: '逾期',
      statusId: statuses.todo,
      dueDate: now - 2 * DAY,
    });
    taskService.createTask(ctx, {
      projectId: projectA,
      title: '今天',
      statusId: statuses.todo,
      dueDate: now,
    });
    taskService.createTask(ctx, {
      projectId: projectA,
      title: '已完成但今天到期',
      statusId: statuses.done,
      dueDate: now,
    });

    const overdue = queryTasksAcrossProjects(ctx, { dueTo: now - DAY, onlyOpen: true });
    expect(overdue.items.map((item) => item.title)).toEqual(['逾期']);

    const today = queryTasksAcrossProjects(ctx, { dueFrom: now - DAY, dueTo: now + DAY, onlyOpen: true });
    expect(today.items.map((item) => item.title)).toEqual(['今天']);
    // 只看未完成：已完成的即使到期也不该出现
    expect(today.items.some((item) => item.title === '已完成但今天到期')).toBe(false);

    const withDone = queryTasksAcrossProjects(ctx, { dueFrom: now - DAY, dueTo: now + DAY });
    expect(withDone.items.length).toBe(2);
  });

  it('没有截止日的任务用 withoutDue 单独取', () => {
    const { ctx, projectA, statuses } = fixture();
    taskService.createTask(ctx, { projectId: projectA, title: '没日期', statusId: statuses.todo });
    taskService.createTask(ctx, {
      projectId: projectA,
      title: '有日期',
      statusId: statuses.todo,
      dueDate: ctx.now(),
    });

    const result = queryTasksAcrossProjects(ctx, { withoutDue: true });
    expect(result.items.map((item) => item.title)).toEqual(['没日期']);
  });

  it('可以只查指定项目', () => {
    const { ctx, projectA, projectB, statuses } = fixture();
    taskService.createTask(ctx, { projectId: projectA, title: 'A 的活', statusId: statuses.todo });
    taskService.createTask(ctx, { projectId: projectB, title: 'B 的活', statusId: statuses.todo });

    const onlyA = queryTasksAcrossProjects(ctx, { projectIds: [projectA] });
    expect(onlyA.items.map((item) => item.title)).toEqual(['A 的活']);
  });

  it('归档项目与已删除任务都不出现', () => {
    const { ctx, projectA, projectB, statuses } = fixture();
    const task = taskService.createTask(ctx, {
      projectId: projectA,
      title: '会被删掉的',
      statusId: statuses.todo,
    });
    taskService.createTask(ctx, { projectId: projectB, title: '留着的', statusId: statuses.todo });
    taskService.softDeleteTask(ctx, task.id);
    projectService.setProjectStatus(ctx, projectB, 'archived');

    const result = queryTasksAcrossProjects(ctx, {});
    expect(result.items).toHaveLength(0);
  });
});

describe('searchAll', () => {
  it('三个汉字以上的片段能搜到（走全文索引）', () => {
    const { ctx, projectA, statuses } = fixture();
    taskService.createTask(ctx, { projectId: projectA, title: '接入登录态', statusId: statuses.todo });
    taskService.createTask(ctx, { projectId: projectA, title: '导出诊断包', statusId: statuses.todo });

    const hit = searchAll(ctx, { q: '登录态' });
    expect(hit.mode).toBe('fts');
    expect(hit.items.map((item) => item.title)).toEqual(['接入登录态']);

    // 非词首的片段也要能命中（这是 trigram 相对 unicode61 的关键好处）
    const middle = searchAll(ctx, { q: '出诊断' });
    expect(middle.items.map((item) => item.title)).toEqual(['导出诊断包']);
  });

  it('**两个汉字的短词也能搜到**（少于 3 字回落模糊匹配）', () => {
    const { ctx, projectA, statuses } = fixture();
    taskService.createTask(ctx, { projectId: projectA, title: '接入登录态', statusId: statuses.todo });
    taskService.createTask(ctx, { projectId: projectA, title: '导出诊断包', statusId: statuses.todo });

    expect('登录'.length).toBeLessThan(FTS_MIN_LENGTH);
    const hit = searchAll(ctx, { q: '登录' });
    expect(hit.mode).toBe('like');
    expect(hit.items.map((item) => item.title)).toEqual(['接入登录态']);
  });

  it('正文命中会给出片段（标题没命中也能搜到）', () => {
    const { ctx, projectA, statuses } = fixture();
    taskService.createTask(ctx, {
      projectId: projectA,
      title: '随手记',
      description: '把登录态接到路由守卫里',
      statusId: statuses.todo,
    });

    const hit = searchAll(ctx, { q: '路由守卫' });
    expect(hit.items).toHaveLength(1);
    expect(hit.items[0]?.title).toBe('随手记');
    expect(hit.items[0]?.snippet).toContain('路由守卫');
  });

  it('英文关键词能命中，结果带项目名', () => {
    const { ctx, projectA, statuses } = fixture();
    taskService.createTask(ctx, { projectId: projectA, title: 'fix login bug', statusId: statuses.todo });

    const hit = searchAll(ctx, { q: 'login' });
    expect(hit.items).toHaveLength(1);
    expect(hit.items[0]?.projectName).toBe('甲项目');
  });

  it('结果跨项目', () => {
    const { ctx, projectA, projectB, statuses } = fixture();
    taskService.createTask(ctx, { projectId: projectA, title: '导出一份报表', statusId: statuses.todo });
    taskService.createTask(ctx, { projectId: projectB, title: '导出另一个报表', statusId: statuses.todo });

    const hit = searchAll(ctx, { q: '导出' });
    expect(hit.items).toHaveLength(2);
    expect(new Set(hit.items.map((item) => item.projectName))).toEqual(new Set(['甲项目', '乙项目']));
  });

  it('**软删除的任务不出现在结果里**（索引里留着文档，靠查询过滤）', () => {
    const { ctx, projectA, statuses } = fixture();
    const task = taskService.createTask(ctx, {
      projectId: projectA,
      title: '接入登录态',
      statusId: statuses.todo,
    });
    expect(searchAll(ctx, { q: '登录态' }).items).toHaveLength(1);

    taskService.softDeleteTask(ctx, task.id);
    expect(searchAll(ctx, { q: '登录态' }).items).toHaveLength(0);

    // 恢复之后要能重新搜到（触发器负责把索引补回来）
    taskService.restoreTask(ctx, task.id);
    expect(searchAll(ctx, { q: '登录态' }).items).toHaveLength(1);
  });

  it('改标题之后搜新标题命中、旧标题不命中（触发器同步）', () => {
    const { ctx, projectA, statuses } = fixture();
    const task = taskService.createTask(ctx, {
      projectId: projectA,
      title: '旧的标题内容',
      statusId: statuses.todo,
    });

    taskService.updateTask(ctx, task.id, { title: '新的标题内容' });

    expect(searchAll(ctx, { q: '新的标题' }).items).toHaveLength(1);
    expect(searchAll(ctx, { q: '旧的标题' }).items).toHaveLength(0);
  });

  it('空查询返回空结果，不报错', () => {
    const { ctx } = fixture();
    const result = searchAll(ctx, { q: '   ' });
    expect(result.items).toHaveLength(0);
    expect(result.total).toBe(0);
  });
});
