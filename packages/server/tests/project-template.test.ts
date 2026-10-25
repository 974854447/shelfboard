import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { DbConnection } from '../src/db/connection';
import { createLogger } from '../src/logging/logger';
import { createServiceContext, type ServiceContext } from '../src/services/context';
import {
  applyManagementTemplate,
  describeTemplateResult,
  findManagementTemplate,
  resolveProjectKind,
} from '../src/services/project-template';
import * as projectService from '../src/services/projects';
import * as taskService from '../src/services/tasks';
import { listMilestones } from '../src/services/milestones';
import { listStatuses } from '../src/services/workflow-statuses';

/**
 * 管理侧模板（技术设计 §46）：**新建即非空**。
 *
 * 这里盯三件事：
 * 1. 四套模板各自"铺出来是什么样"（状态名/任务层级/里程碑/文档）；
 * 2. **幂等**：重复调用不会得到第二份任务清单（向导失败重试是常规操作）；
 * 3. 不越界：没有工作区目录时如实报"没写文档"，而不是假装写了。
 */

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()?.();
});

function makeWorkspace(): { ctx: ServiceContext; dir: string } {
  const conn = new DbConnection();
  conn.open(':memory:');
  const dir = mkdtempSync(join(tmpdir(), 'template-ws-'));
  const ctx = createServiceContext({
    conn,
    logger: createLogger({ source: 'api', minLevel: 'error' }),
    workspaceRoot: dir,
  });
  cleanups.push(() => conn.close());
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return { ctx, dir };
}

function makeCtxWithoutWorkspace(): ServiceContext {
  const conn = new DbConnection();
  conn.open(':memory:');
  const ctx = createServiceContext({
    conn,
    logger: createLogger({ source: 'api', minLevel: 'error' }),
  });
  cleanups.push(() => conn.close());
  return ctx;
}

describe('模板本体', () => {
  it('四套模板都存在，且各自带着任务、里程碑、文档', () => {
    for (const kind of ['managed', 'frontend', 'backend', 'fullstack'] as const) {
      const template = findManagementTemplate(kind);
      expect(template.tasks.length, kind).toBeGreaterThanOrEqual(4);
      expect(template.milestones.length, kind).toBeGreaterThanOrEqual(1);
      expect(template.docs.length, kind).toBeGreaterThanOrEqual(3);
    }
  });

  it('工作流不再由模板定义（六态统一由建项目时的默认模板铺）', () => {
    for (const kind of ['managed', 'frontend', 'backend', 'fullstack'] as const) {
      const template = findManagementTemplate(kind) as unknown as Record<string, unknown>;
      expect('statuses' in template, kind).toBe(false);
    }
  });

  it('任务清单里的层级是有意义的（父任务带子任务，都有标题）', () => {
    for (const kind of ['managed', 'frontend', 'backend', 'fullstack'] as const) {
      const template = findManagementTemplate(kind);
      const withChildren = template.tasks.filter((item) => (item.children ?? []).length > 0);
      expect(withChildren.length, `${kind} 至少有带子任务的父任务`).toBeGreaterThan(0);
      for (const parent of template.tasks) {
        for (const child of parent.children ?? []) {
          expect(child.title.length, kind).toBeGreaterThan(0);
        }
        // 模板不给任务指定状态：一律落到项目的默认状态（待完成）——
        // 状态名从此只有一处定义（`DEFAULT_WORKFLOW_TEMPLATE`）
        expect(Object.keys(parent), kind).not.toContain('status');
      }
    }
  });

  it('文档模板不写"示例正文"，只写该填什么', () => {
    const docs = findManagementTemplate('frontend').docs;
    for (const doc of docs) {
      expect(doc.path.startsWith('docs/'), doc.path).toBe(true);
      expect(doc.path.endsWith('.md'), doc.path).toBe(true);
      // 提示行用 "> " 开头，方便用户填完就删
      expect(doc.content.includes('\n> '), doc.path).toBe(true);
    }
    // ADR 要标注来源与许可（需求 §5.9 的要求）
    const adr = docs.find((doc) => doc.path.includes('架构决策记录'));
    expect(adr?.content).toContain('MADR');
  });
});

describe('铺到一个项目上', () => {
  it('前端项目：任务带层级 + 里程碑有截止日 + 文档落到 docs/（工作流保持不变）', () => {
    const { ctx, dir } = makeWorkspace();
    const project = projectService.createProject(ctx, { name: '前端项目', codeKind: 'frontend' });

    const result = applyManagementTemplate(ctx, project.id);

    expect(result.kind).toBe('frontend');

    /*
     * 工作流是建项目时铺的六态，模板**不碰它** ——
     * 用户 2026-10-02 定的流程是全局统一的，各技术栈不再有自己的一套状态名。
     */
    const statuses = listStatuses(ctx, project.id);
    expect(statuses.map((s) => s.name)).toEqual([
      '待完成',
      '正在修改',
      '待审查',
      '审查中',
      '回退修改',
      '已完成',
    ]);
    expect(statuses.filter((s) => s.isDefault)).toHaveLength(1);
    expect(statuses.find((s) => s.isDefault)?.name).toBe('待完成');

    const tasks = taskService.listTasks(ctx, project.id, { pageSize: 100 }).items;
    const roots = tasks.filter((task) => task.parentId === null);
    expect(roots.length).toBeGreaterThanOrEqual(4);
    expect(tasks.length).toBeGreaterThan(roots.length);
    // 模板不指定状态：所有新任务都落在默认状态上
    const requirement = tasks.find((task) => task.title === '需求与会话');
    expect(requirement?.statusId).toBe(statuses.find((s) => s.isDefault)?.id);

    const milestones = listMilestones(ctx, project.id);
    expect(milestones.length).toBe(3);
    expect(milestones[0]?.dueDate).not.toBeNull();
    expect(milestones.every((m) => m.reachedAt === null)).toBe(true);

    const folder = join(dir, project.folder as string);
    for (const doc of result.created.docs) {
      expect(existsSync(join(folder, ...doc.split('/'))), doc).toBe(true);
    }
    expect(readFileSync(join(folder, 'docs', '需求文档.md'), 'utf8')).toContain('# 需求文档');
    // 项目自带的目录不能被弄没
    expect(existsSync(join(folder, 'attachments'))).toBe(true);
  });

  it('**幂等**：再铺一次不会得到第二份任务/文档，而是如实报"跳过"', () => {
    const { ctx } = makeWorkspace();
    const project = projectService.createProject(ctx, { name: '后端项目', codeKind: 'backend' });

    const first = applyManagementTemplate(ctx, project.id);
    const tasksAfterFirst = taskService.listTasks(ctx, project.id, { pageSize: 100 }).items.length;
    const statusesAfterFirst = listStatuses(ctx, project.id).length;
    const second = applyManagementTemplate(ctx, project.id);
    const tasksAfterSecond = taskService.listTasks(ctx, project.id, { pageSize: 100 }).items.length;

    expect(first.created.tasks.length).toBeGreaterThan(0);
    expect(second.created.tasks).toEqual([]);
    expect(second.created.docs).toEqual([]);
    expect(second.skipped.tasks.length).toBe(first.created.tasks.length);
    expect(tasksAfterFirst).toBe(tasksAfterSecond);
    // 工作流本来就不归模板管，两次调用之后状态数必须一模一样
    expect(listStatuses(ctx, project.id)).toHaveLength(statusesAfterFirst);
  });

  it('用户改过工作流之后再铺：**不补也不换**，工作流原样保留', () => {
    const { ctx } = makeWorkspace();
    const project = projectService.createProject(ctx, { name: '前端项目', codeKind: 'frontend' });

    // 用户把「审查中」改名成「验收」
    const statuses = listStatuses(ctx, project.id);
    const testing = statuses.find((s) => s.name === '审查中')!;
    ctx.sqlite.prepare('UPDATE workflow_statuses SET name = ? WHERE id = ?').run('验收', testing.id);

    const again = applyManagementTemplate(ctx, project.id, { tasks: false, milestones: false, docs: false });

    const names = listStatuses(ctx, project.id).map((s) => s.name);
    expect(names).toContain('验收');
    /*
     * 关键取舍：**模板永远不动工作流**。
     * 曾经的实现会在"状态一个都不在"时整套换掉，"补缺"听起来贴心，
     * 实际是"我刚删掉/改名的东西又冒出来了" —— 现在干脆不碰。
     */
    expect(names).not.toContain('审查中');
    expect(names).toContain('待完成');
    expect(again.created).not.toHaveProperty('statuses');
  });

  it('已存在的文档**不覆盖**（用户可能已经写了内容）', () => {
    const { ctx, dir } = makeWorkspace();
    const project = projectService.createProject(ctx, { name: '前端项目', codeKind: 'frontend' });
    const folder = join(dir, project.folder as string);
    mkdirSync(join(folder, 'docs'), { recursive: true });
    writeFileSync(join(folder, 'docs', '需求文档.md'), '# 我自己写的\n', 'utf8');

    const result = applyManagementTemplate(ctx, project.id);

    expect(readFileSync(join(folder, 'docs', '需求文档.md'), 'utf8')).toBe('# 我自己写的\n');
    expect(result.skipped.docs).toContain('docs/需求文档.md');
    expect(result.created.docs).not.toContain('docs/需求文档.md');
  });

  it('每一步都能单独关掉（向导里的勾选项）', () => {
    const { ctx } = makeWorkspace();
    // 纯管理项目的 codeKind 是 null（CODE_KINDS 里只有前端/后端/全栈）
    const project = projectService.createProject(ctx, { name: '只要任务' });

    const result = applyManagementTemplate(ctx, project.id, {
      milestones: false,
      docs: false,
    });

    expect(result.created.tasks.length).toBeGreaterThan(0);
    expect(result.created.milestones).toEqual([]);
    expect(result.created.docs).toEqual([]);
    // 工作流与模板无关：永远是建项目时铺的那六个状态
    expect(listStatuses(ctx, project.id).map((s) => s.name)).toEqual([
      '待完成',
      '正在修改',
      '待审查',
      '审查中',
      '回退修改',
      '已完成',
    ]);
    expect(listMilestones(ctx, project.id)).toEqual([]);
  });

  it('没有工作区目录时**如实报**没写文档（不假装写了）', () => {
    const ctx = makeCtxWithoutWorkspace();
    const project = projectService.createProject(ctx, { name: '没有工作区' });

    const result = applyManagementTemplate(ctx, project.id);

    expect(result.created.docs).toEqual([]);
    expect(result.skipped.docs.join()).toContain('没有工作区目录');
    // 其它三块照铺：文档写不了不影响任务与工作流
    expect(result.created.tasks.length).toBeGreaterThan(0);
  });

  it('按项目记录的代码形态选模板；显式指定优先', () => {
    const { ctx } = makeWorkspace();
    const managed = projectService.createProject(ctx, { name: '纯管理' });
    const full = projectService.createProject(ctx, { name: '全栈', codeKind: 'fullstack' });

    expect(resolveProjectKind(ctx, managed.id)).toBe('managed');
    expect(resolveProjectKind(ctx, full.id)).toBe('fullstack');
    expect(resolveProjectKind(ctx, full.id, 'backend')).toBe('backend');
  });

  it('小结里写清铺了什么、跳过了多少（给界面与日志用）', () => {
    const { ctx } = makeWorkspace();
    const project = projectService.createProject(ctx, { name: '前端项目', codeKind: 'frontend' });

    const first = applyManagementTemplate(ctx, project.id);
    const summary = describeTemplateResult(first);
    expect(summary).toContain(`已铺 ${first.created.tasks.length} 个任务`);
    // 工作流不归模板管，小结里不该再出现"0 个工作流状态"这种废话
    expect(summary).not.toContain('工作流状态');
    expect(summary).not.toContain('跳过');

    const second = applyManagementTemplate(ctx, project.id);
    expect(describeTemplateResult(second)).toContain('跳过已存在的');
  });
});
