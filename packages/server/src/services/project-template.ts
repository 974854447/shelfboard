/**
 * 管理侧模板：**新建即非空**（技术设计 §46、需求 §5.9）。
 *
 * 用户的原话是"新建即非空项目"：代码骨架生成完了、依赖装好了，但打开工作台
 * 还是"0 个任务"——那等于把"该怎么开始"这件事全丢给用户自己。这一刀补的是管理侧：
 *
 *   1. **标准任务清单**：带层级的任务（工作台是分层空间，父子关系天生能显示进度）
 *   2. **里程碑**：项目的关键节点（总览页右侧面板看得到）
 *   3. **文档模板**：往 `<项目文件夹>/docs/` 写 `.md`（M3 之前应用里看不到它们，见需求 §5.9）
 *
 * ## 工作流不在这一层
 *
 * 用户 2026-10-02 定了统一的六态流程，四个技术栈共用一套（`DEFAULT_WORKFLOW_TEMPLATE`），
 * 建项目时就铺好了。模板要是再各带一份状态定义，同一个东西就有了五个出处，
 * 迟早改一处漏三处 —— 所以这里只管任务、里程碑与文档。
 *
 * ## 幂等：这一步会被重试
 *
 * 向导失败后重试不该得到第二份一模一样的任务清单。所以每一步都按名字查重：
 * **已存在的跳过并如实报出来**，而不是"再建一遍"或者"静默什么都不做"。
 * 文档走的是与代码模板同一条规矩：**已存在的文件不覆盖**。
 */

import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

import { and, asc, eq, isNull } from 'drizzle-orm';

import { milestones, tasks as tasksTable } from '../db/schema.js';
import type { ServiceContext } from './context.js';
import { listStatuses } from './workflow-statuses.js';
import { getProjectOrThrow } from './projects.js';
import { ensureProjectFolder } from './project-folders.js';

/** 项目形态：决定套哪一套模板（与向导里的四张类型卡一一对应） */
export type ProjectKind = 'managed' | 'frontend' | 'backend' | 'fullstack';

export interface TaskTemplateItem {
  title: string;
  description?: string;
  priority?: 'low' | 'medium' | 'high' | 'urgent';
  children?: TaskTemplateItem[];
}

export interface DocTemplateItem {
  /** 相对**项目文件夹**的路径（一律放在 docs/ 下） */
  path: string;
  content: string;
}

export interface ManagementTemplate {
  kind: ProjectKind;
  /** 一句话说明这套模板是什么（向导与日志都用它） */
  summary: string;
  /**
   * 任务模板（**不含工作流状态**）。
   *
   * 工作流四个栈共用同一套六态（见 `@pm-studio/shared` 的 `DEFAULT_WORKFLOW_TEMPLATE`），
   * 建项目时就已经铺好，模板里再写一份只会导致"改一处漏三处"。
   */
  tasks: readonly TaskTemplateItem[];
  milestones: ReadonlyArray<{ name: string; description?: string; dueInDays?: number }>;
  docs: readonly DocTemplateItem[];
}

/* ------------------------------------------------------------------ */
/* 文档模板内容                                                        */
/* ------------------------------------------------------------------ */

/**
 * 文档模板的来源与许可（需求 §5.9 要求"标注来源与许可证"）：
 * - 架构决策记录：结构取自 **MADR**（Markdown ADR，MIT 许可），这里只保留标题骨架；
 * - 技术方案 / 会议纪要 / 需求文档：通用结构（业界通行的"背景-目标-方案-风险"，
 *   会议纪要为"时间-参与人-结论-待办"），没有可声称的单一出处，因此**不标来源**。
 *
 * 刻意**不写示例正文**：模板里塞满"这里是你的需求描述"这种占位句只会被原样留着。
 * 写的是**该填什么**的提示，以及"填完删掉这些提示"的提醒。
 */
const DOC_REQUIREMENTS = `# 需求文档

> 这份文件是模板：把每一节填成这个项目真实的内容，然后把带「>」的提示行删掉。

## 背景
> 为什么要做这件事？现在的问题是什么？

## 目标与非目标
- 目标：
- **非目标**（明确不做什么，避免范围蔓延）：

## 使用场景
> 谁在什么情况下用它？一段一个场景。

## 功能清单
| 功能 | 说明 | 优先级 |
|---|---|---|
|  |  |  |

## 验收标准
> 写成"能验证的句子"：例如"新建项目后工作台立刻有任务，而不是空白页"。

## 未决问题
> 还没定下来的事写在这里，别留在脑子里。
`;

const DOC_DESIGN = `# 技术方案

> 这份文件是模板：先写结论，再写理由。填完删掉带「>」的提示行。

## 结论
> 两三句话说完"打算怎么做"。

## 现状
> 现在的代码/数据/部署是什么样，与这次的改动有什么关系。

## 方案对比
| 方案 | 优点 | 缺点 | 结论 |
|---|---|---|---|
| A |  |  | 采用 / 放弃 |

## 数据与接口
> 改动涉及的表、字段、接口。数据库改动要写清"老数据怎么办"。

## 风险与回滚
- 风险：
- 回滚方式：

## 排期
> 拆到能"一天内做完"的粒度。
`;

const DOC_MEETING = `# 会议纪要

> 一次会议一份（复制这个文件，命名成 \`会议纪要-2026-01-01.md\`）。填完删掉带「>」的提示行。

- 时间：
- 参与人：
- 议题：

## 结论
> 只写**定了的**事；没定的放"待办"。

## 待办
| 事项 | 负责人 | 期限 |
|---|---|---|
|  |  |  |

## 下次
> 下次要讨论什么、什么时候。
`;

const DOC_ADR = `# 架构决策记录（ADR）

> 结构取自 **MADR**（Markdown ADR，MIT 许可）：<https://github.com/adr/madr>。
> 一次决策一份（复制这个文件，命名成 \`ADR-0001-选某某方案.md\`）。填完删掉带「>」的提示行。

## 状态
> 提议 / 已采纳 / 已废弃 / 被 ADR-XXXX 取代

## 背景与问题
> 是什么迫使我们必须做这个决定？

## 决策
> 我们决定做什么。（用主动语态："我们采用……"）

## 后果
- 好处：
- 代价：
- 以后要注意：
`;

const DOCS_COMMON: readonly DocTemplateItem[] = [
  { path: 'docs/需求文档.md', content: DOC_REQUIREMENTS },
  { path: 'docs/技术方案.md', content: DOC_DESIGN },
  { path: 'docs/会议纪要.md', content: DOC_MEETING },
  { path: 'docs/架构决策记录.md', content: DOC_ADR },
];

/* ------------------------------------------------------------------ */
/* 模板本体                                                            */
/* ------------------------------------------------------------------ */

/**
 * 四套模板。
 *
 * 任务清单的取舍：**只列"每个项目都躲不开"的事**（十来条，带层级）。
 * 塞四十条"用户故事"看起来更专业，实际是让用户先删一半 —— 那比空着更糟。
 */
const TEMPLATES: Readonly<Record<ProjectKind, ManagementTemplate>> = {
  managed: {
    kind: 'managed',
    summary: '通用项目管理：待完成 → 正在修改 → 待审查 → 审查中 → 已完成',
    tasks: [
      {
        title: '立项与范围',
        priority: 'high',
        children: [
          { title: '写清目标与非目标' },
          { title: '列出干系人与交付物' },
        ],
      },
      {
        title: '计划',
        children: [
          { title: '拆出可执行的任务清单' },
          { title: '定里程碑与截止日' },
        ],
      },
      {
        title: '执行与跟踪',
        children: [
          { title: '每周更新任务状态' },
          { title: '记录风险与变更' },
        ],
      },
      {
        title: '验收与收尾',
        children: [
          { title: '对照验收标准逐条确认' },
          { title: '整理结论与遗留问题' },
        ],
      },
    ],
    milestones: [
      { name: '范围冻结', description: '需求与非目标确认，不再随意加范围', dueInDays: 7 },
      { name: '完成验收', dueInDays: 30 },
    ],
    docs: DOCS_COMMON,
  },

  frontend: {
    kind: 'frontend',
    summary: '前端流程：待完成 → 正在修改 → 待审查 → 审查中 → 回退修改 → 已完成',
    tasks: [
      {
        title: '需求与会话',
        priority: 'high',
        children: [
          { title: '确认页面清单与交互稿' },
          { title: '确认接口字段（与后端对齐）' },
        ],
      },
      {
        title: '工程准备',
        priority: 'high',
        children: [
          { title: '确认构建与本地开发命令' },
          { title: '约定代码风格与提交规范' },
        ],
      },
      {
        title: '页面开发',
        children: [
          { title: '搭出页面骨架与路由' },
          { title: '对接接口并处理空态/错误态' },
        ],
      },
      {
        title: '联调与自测',
        children: [
          { title: '与后端联调全部接口' },
          { title: '过一遍自测清单（大小屏、慢网）' },
        ],
      },
      {
        title: '上线',
        priority: 'high',
        children: [
          { title: '构建产物验证' },
          { title: '上线后回归主要路径' },
        ],
      },
    ],
    milestones: [
      { name: '交互与接口确认', description: '页面清单与接口字段都定下来', dueInDays: 5 },
      { name: '开发完成（功能冻结）', dueInDays: 20 },
      { name: '上线', dueInDays: 30 },
    ],
    docs: DOCS_COMMON,
  },

  backend: {
    kind: 'backend',
    summary: '后端流程：待完成 → 正在修改 → 待审查 → 审查中 → 回退修改 → 已完成',
    tasks: [
      {
        title: '需求与接口',
        priority: 'high',
        children: [
          { title: '确认接口清单与字段' },
          { title: '确认错误码与鉴权方式' },
        ],
      },
      {
        title: '数据模型',
        priority: 'high',
        children: [
          { title: '设计表结构与索引' },
          { title: '写清老数据怎么迁移' },
        ],
      },
      {
        title: '接口实现',
        children: [
          { title: '实现主流程接口' },
          { title: '补齐参数校验与错误处理' },
        ],
      },
      {
        title: '联调与自测',
        children: [
          { title: '与前端联调全部接口' },
          { title: '关键路径写测试' },
        ],
      },
      {
        title: '上线',
        priority: 'high',
        children: [
          { title: '准备部署与回滚步骤' },
          { title: '上线后看一轮日志与错误' },
        ],
      },
    ],
    milestones: [
      { name: '接口与数据模型冻结', description: '接口清单、字段、表结构定下来', dueInDays: 5 },
      { name: '主流程接口开发完成', dueInDays: 20 },
      { name: '上线', dueInDays: 30 },
    ],
    docs: DOCS_COMMON,
  },

  fullstack: {
    kind: 'fullstack',
    summary: '前后端流程：待完成 → 正在修改 → 待审查 → 审查中 → 回退修改 → 已完成',
    tasks: [
      {
        title: '需求与接口约定',
        priority: 'high',
        children: [
          { title: '确认页面清单与接口清单' },
          { title: '约定字段、错误码与鉴权' },
        ],
      },
      {
        title: '前端开发',
        children: [
          { title: '页面骨架与路由' },
          { title: '对接接口（含空态/错误态）' },
        ],
      },
      {
        title: '后端开发',
        children: [
          { title: '数据表与接口实现' },
          { title: '参数校验与错误处理' },
        ],
      },
      {
        title: '联调与自测',
        children: [
          { title: '前后端联调全部接口' },
          { title: '过一遍自测清单' },
        ],
      },
      {
        title: '上线',
        priority: 'high',
        children: [
          { title: '两端构建与部署验证' },
          { title: '上线后回归主要路径' },
        ],
      },
    ],
    milestones: [
      { name: '接口约定冻结', description: '字段与错误码定下来，两端各自开工', dueInDays: 5 },
      { name: '两端开发完成', dueInDays: 20 },
      { name: '上线', dueInDays: 30 },
    ],
    docs: DOCS_COMMON,
  },
};

export function findManagementTemplate(kind: ProjectKind): ManagementTemplate {
  return TEMPLATES[kind];
}

/** 服务端"这个项目该套哪套模板"：优先用调用方给的，否则按项目记录的代码形态 */
export function resolveProjectKind(
  ctx: ServiceContext,
  projectId: string,
  requested?: ProjectKind,
): ProjectKind {
  if (requested) return requested;
  const project = getProjectOrThrow(ctx, projectId);
  const codeKind = project.codeKind;
  if (codeKind === 'frontend' || codeKind === 'backend' || codeKind === 'fullstack') return codeKind;
  return 'managed';
}

/* ------------------------------------------------------------------ */
/* 落地                                                                */
/* ------------------------------------------------------------------ */

export interface ApplyTemplateOptions {
  kind?: ProjectKind;
  /** 每一步都可以单独关掉（向导里的勾选项），默认全开 */
  tasks?: boolean;
  milestones?: boolean;
  docs?: boolean;
  /** 文档模板的时间基准（测试里注入固定时间） */
  now?: number;
}

export interface ApplyTemplateResult {
  kind: ProjectKind;
  summary: string;
  /** 真的建出来的（标题/名字/路径），用于日志与界面回显 */
  created: { tasks: string[]; milestones: string[]; docs: string[] };
  /** 已经存在、**跳过**的（幂等：重试不会得到第二份） */
  skipped: { tasks: string[]; milestones: string[]; docs: string[] };
}

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * 把管理侧模板铺到一个项目上。
 *
 * **不碰工作流**：六个状态在建项目时已由默认模板铺好（四个栈共用同一套），
 * 模板只负责任务清单、里程碑与文档骨架。这样一来"状态"只有一处定义，
 * 也不会出现"用户已经调过工作流，铺模板又给换回去"这种事。
 */
export function applyManagementTemplate(
  ctx: ServiceContext,
  projectId: string,
  options: ApplyTemplateOptions = {},
): ApplyTemplateResult {
  getProjectOrThrow(ctx, projectId);
  const kind = resolveProjectKind(ctx, projectId, options.kind);
  const template = findManagementTemplate(kind);
  const now = options.now ?? ctx.now();

  const result: ApplyTemplateResult = {
    kind,
    summary: template.summary,
    created: { tasks: [], milestones: [], docs: [] },
    skipped: { tasks: [], milestones: [], docs: [] },
  };

  /* ---- 任务清单 ---- */
  if (options.tasks !== false) {
    const statuses = listStatuses(ctx, projectId);
    const fallbackStatus = statuses.find((status) => status.isDefault) ?? statuses[0];
    const existingTitles = new Set(
      ctx.db
        .select({ title: tasksTable.title })
        .from(tasksTable)
        .where(and(eq(tasksTable.projectId, projectId), isNull(tasksTable.deletedAt)))
        .all()
        .map((row) => row.title),
    );

    const insertTask = (
      item: TaskTemplateItem,
      parentId: string | null,
      sortOrder: number,
    ): void => {
      if (existingTitles.has(item.title)) {
        /*
         * 已存在时不再往下建子任务（父任务可能是用户自己建的，层级未必一致），
         * 但**子任务也要记进"跳过"**：否则小结会给出"建了 15 个、跳过 5 个"这种对不上的
         * 数字 —— 实际是"这一整棵子树都跳过了"。
         */
        const markSkipped = (node: TaskTemplateItem): void => {
          result.skipped.tasks.push(node.title);
          (node.children ?? []).forEach(markSkipped);
        };
        markSkipped(item);
        return;
      }
      const id = ctx.newId();
      ctx.db
        .insert(tasksTable)
        .values({
          id,
          projectId,
          parentId,
          title: item.title,
          description: item.description ?? null,
          statusId: fallbackStatus?.id ?? null,
          priority: item.priority ?? 'medium',
          sortOrder,
          createdAt: now,
          updatedAt: now,
          deletedAt: null,
        })
        .run();
      existingTitles.add(item.title);
      result.created.tasks.push(item.title);

      (item.children ?? []).forEach((child, index) => {
        insertTask(child, id, (index + 1) * 1000);
      });
    };

    template.tasks.forEach((item, index) => {
      insertTask(item, null, (index + 1) * 1000);
    });
  }

  /* ---- 里程碑 ---- */
  if (options.milestones !== false) {
    const existingNames = new Set(
      ctx.db
        .select({ name: milestones.name })
        .from(milestones)
        .where(eq(milestones.projectId, projectId))
        .orderBy(asc(milestones.sortOrder))
        .all()
        .map((row) => row.name),
    );

    template.milestones.forEach((item, index) => {
      if (existingNames.has(item.name)) {
        result.skipped.milestones.push(item.name);
        return;
      }
      ctx.db
        .insert(milestones)
        .values({
          id: ctx.newId(),
          projectId,
          name: item.name,
          description: item.description ?? null,
          dueDate: item.dueInDays === undefined ? null : now + item.dueInDays * DAY_MS,
          reachedAt: null,
          sortOrder: (index + 1) * 1000,
          createdAt: now,
          updatedAt: now,
        })
        .run();
      result.created.milestones.push(item.name);
    });
  }

  /* ---- 4) 文档模板（写到项目文件夹里，已存在的不覆盖） ---- */
  if (options.docs !== false) {
    const project = getProjectOrThrow(ctx, projectId);
    const root = ctx.workspaceRoot;
    const folder = root && project.folder ? ensureProjectFolder(root, project.folder).path : null;
    if (!folder) {
      // 如实报出来：没有工作区目录就没法写文件，不能假装写了
      result.skipped.docs.push(...template.docs.map((doc) => `${doc.path}（没有工作区目录）`));
    } else {
      for (const doc of template.docs) {
        const absolute = resolve(join(folder, ...doc.path.split('/')));
        if (!absolute.startsWith(resolve(folder))) {
          result.skipped.docs.push(`${doc.path}（路径不合法）`);
          continue;
        }
        if (existsSync(absolute)) {
          result.skipped.docs.push(doc.path);
          continue;
        }
        mkdirSync(dirname(absolute), { recursive: true });
        writeFileSync(absolute, doc.content, 'utf8');
        result.created.docs.push(doc.path);
      }
    }
  }

  return result;
}

/** 给界面用的一句话小结（"铺了 5 个状态、12 个任务、3 个里程碑、4 份文档"） */
export function describeTemplateResult(result: ApplyTemplateResult): string {
  const parts = [
    `${result.created.tasks.length} 个任务`,
    `${result.created.milestones.length} 个里程碑`,
    `${result.created.docs.length} 份文档模板`,
  ];
  const skipped =
    result.skipped.tasks.length +
    result.skipped.milestones.length +
    result.skipped.docs.length;
  return skipped > 0 ? `已铺 ${parts.join('、')}（跳过已存在的 ${skipped} 项）` : `已铺 ${parts.join('、')}`;
}
