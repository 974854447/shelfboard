/**
 * 脚手架作业（M4）。
 *
 * ## 目标目录怎么定
 *
 * 0.1.2 起"一个项目 = 工作区里的一个文件夹，代码就在这一层"，所以：
 * - **单栈**（只前端或只后端）→ 生成到**项目文件夹根目录**；
 * - **前后端都要** → 生成到 `frontend/` 与 `backend/` 两个子目录。
 *
 * 项目文件夹在创建时就带了 `attachments/` 与 `logs/`，所以模板写入**不覆盖已存在的文件**
 * （见 `writeTemplateFiles`）—— 生成骨架不该动用户已有的东西。
 *
 * ## 两条路径，官方优先
 *
 * | 情况 | 走哪条 |
 * |---|---|
 * | 官方有脚手架（Vue / NestJS / Django） | 先 `--help` 探测参数是否还认，认就走官方 CLI；
 *   探测失败或调用失败 → **回退内置模板**（有的话），没有回退就如实失败 |
 * | 官方没有脚手架（FastAPI） | 直接用内置模板 |
 *
 * 这一版**先把内置模板这条路径做通**（它是离线可验证、也是 FastAPI 的唯一路径）；
 * 官方 CLI 的 spec 与探测命令已经在命令白名单里备好了，接上属于下一刀 ——
 * 文档里明确标着"未接"，不会让界面看起来像已经支持了。
 */

import { existsSync } from 'node:fs';
import { join } from 'node:path';

import type { JobContext } from './job-runner.js';
import { ensureProjectFolder } from './project-folders.js';
import { getProjectOrThrow } from './projects.js';
import {
  bootstrapDjangoScaffold,
  probeOfficialScaffold,
  runOfficialScaffold,
  type ProbeResult,
} from './scaffold-official.js';
import {
  buildOfficialInvocation,
  defaultSelections,
  describeSelections,
  pinsFor,
  validateSelections,
  type Selections,
} from './scaffold-options.js';
import {
  findTemplate,
  renderTemplate,
  TEMPLATES,
  writeTemplateFiles,
  type TemplateDescriptor,
  type TemplateDimension,
  type TemplateVars,
} from './scaffold-templates.js';
import { applyPortToConfig } from './scaffold-port.js';
import { applyVersionPins } from './scaffold-versions.js';
import { resolveOnPath } from './which.js';

export interface ScaffoldTargetRequest {
  /** 技术栈 id（见 TEMPLATES） */
  templateId: string;
  /** 目标子目录；空字符串表示项目文件夹根目录 */
  subdir: string;
  /**
   * **这个栈自己的**端口。
   *
   * 上一版是整个作业一个 `port`，前后端两个栈共用 —— 结果是双栈项目里
   * `vite.config.ts` 与 `app.listen()` 被写进**同一个端口号**，起服务必撞号。
   * 每个栈的端口惯例本来就不同（5173 / 3000 / 8000），所以端口属于栈，不属于作业。
   */
  port?: number;
  /** 维度选择（语言 / 附加项），见 scaffold-options.ts */
  selections?: Selections;
}

export interface ScaffoldRequest {
  projectId: string;
  targets: ScaffoldTargetRequest[];
  /**
   * 兼容旧载荷：把所有目标的端口都设成这个值。
   *
   * 保留它是因为**已经落库的作业记录会重试**（重试要用原来的载荷再跑一遍），
   * 删掉字段会让老作业直接报"不认识 port"。新的调用方一律用 `targets[].port`。
   */
  port?: number;
  /** 走官方 NestJS 脚手架时用哪个包管理器 */
  packageManager?: 'pnpm' | 'npm' | 'yarn';
}

/**
 * 计划：把"要生成什么"算清楚（**纯函数**，不碰磁盘也不跑命令）。
 *
 * 单独抽出来的理由：这是唯一需要动脑的部分（单栈还是双栈、根目录还是子目录、
 * 走官方还是内置），做成纯函数就能单测；跑起来的部分只负责执行。
 */
export interface ScaffoldPlanItem {
  templateId: string;
  templateName: string;
  /** 相对项目文件夹的路径（'' = 根目录） */
  subdir: string;
  /** 打算怎么生成 */
  strategy: 'builtin' | 'official';
  /** 官方失败时回退到哪个内置模板（undefined = 没有回退） */
  fallbackTemplateId: string | undefined;
  packageName: string;
  /** 这个栈自己的端口（没给就是模板的惯例值） */
  port: number | undefined;
  /** 这个栈的维度选择（已校验） */
  selections: Selections;
}

export interface ScaffoldPlan {
  items: ScaffoldPlanItem[];
  /** 校验失败的原因（非空就说明这份计划不可执行） */
  problems: string[];
}

/** 把目录名转成"包名安全"的 ASCII 名（npm 包名与 Python 包名都只认这套） */
export function toPackageName(projectFolder: string, subdir: string): string {
  const source = subdir.length > 0 ? subdir : projectFolder;
  const ascii = source
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^[-._]+|[-._]+$/g, '');
  return ascii.length > 0 ? ascii.slice(0, 60) : 'app';
}

/**
 * 双栈时用 `frontend` / `backend`，单栈时用项目根目录。
 *
 * 判据是"有几个目标"，而不是"用户勾了哪几个栈"：两个目标就必须分开目录，
 * 否则 Vue 与 FastAPI 会互相覆盖（两边都有 `README.md`、两边都可能建 `src/`）。
 */
export function planScaffold(input: {
  projectId: string;
  projectFolder: string;
  targets: Array<{ templateId: string; port?: number; selections?: Selections }>;
  /** 旧载荷的作业级端口（所有目标共用） */
  port?: number;
}): ScaffoldPlan {
  const problems: string[] = [];
  const multiple = input.targets.length > 1;
  const seen = new Set<string>();

  const items: ScaffoldPlanItem[] = input.targets.map((target) => {
    const template = findTemplate(target.templateId);
    if (!template) {
      problems.push(`不认识的模板「${target.templateId}」`);
      return {
        templateId: target.templateId,
        templateName: target.templateId,
        subdir: '',
        strategy: 'builtin',
        fallbackTemplateId: undefined,
        packageName: 'app',
        port: undefined,
        selections: {},
      };
    }

    const subdir = multiple ? (template.kind === 'frontend' ? 'frontend' : 'backend') : '';
    if (seen.has(subdir)) problems.push(`两个目标都要生成到「${subdir || '根目录'}」，会互相覆盖`);
    seen.add(subdir);

    /*
     * 端口三级回落：**这个栈自己的** → 旧载荷的作业级端口 → 模板惯例值。
     * 前面两级是显式选择，最后一级是"用户没填"时的合理默认（5173 / 3000 / 8000）。
     */
    const port = target.port ?? input.port;

    return {
      templateId: template.id,
      templateName: template.name,
      subdir,
      strategy: template.source === 'builtin' ? 'builtin' : 'official',
      fallbackTemplateId: template.fallbackTemplateId,
      packageName: toPackageName(input.projectFolder, subdir),
      port,
      selections: target.selections ?? defaultSelections(template),
    };
  });

  if (items.length === 0) problems.push('至少要选一个技术栈');
  return { items, problems };
}

/**
 * 官方脚手架走不通之后怎么办。
 *
 * 抽成纯函数是为了**能单独测**："有内置骨架就回退、没有就如实报错"这条规则
 * 决定了"用户拿到的是一份骨架还是一句错误"，不该埋在一大段流程代码里。
 */
export type OfficialFailureDecision =
  | { kind: 'fallback'; reason: string }
  | { kind: 'error'; reason: string };

export function decideAfterOfficialFailure(input: {
  fallbackTemplateId: string | undefined;
  reason: string;
}): OfficialFailureDecision {
  return input.fallbackTemplateId
    ? { kind: 'fallback', reason: input.reason }
    : { kind: 'error', reason: input.reason };
}

export interface ScaffoldOutcome {
  /** 每个目标生成了什么 */
  results: Array<{
    templateId: string;
    subdir: string;
    strategy: 'builtin' | 'official';
    usedFallback: boolean;
    dir: string;
    written: string[];
    skipped: string[];
  }>;
  /** 生成到哪个目录（项目文件夹绝对路径） */
  projectDir: string;
}

/** 跑一次脚手架作业 */
export async function runScaffoldJob(
  job: JobContext,
  request: ScaffoldRequest,
): Promise<Record<string, unknown>> {
  const ctx = job.ctx;
  const project = getProjectOrThrow(ctx, request.projectId);

  if (project.folder === null) {
    throw new Error(
      `项目「${project.name}」还没有文件夹（0.1.1 之前建的项目）—— 先在项目页点一次「同步文件夹」，或新建一个项目`,
    );
  }

  const root = ctx.workspaceRoot;
  if (!root) {
    // 没有工作区目录就没地方放代码。这里必须报错，而不是生成到某个"当前目录"里
    throw new Error('当前没有工作区目录，无法生成代码骨架（先在设置页选一个工作区目录）');
  }
  const projectDir = join(root, project.folder);
  // 目录可能被用户手动删了：这里补建（幂等），生成才能继续
  ensureProjectFolder(root, project.folder);

  const plan = planScaffold({
    projectId: project.id,
    projectFolder: project.folder,
    targets: request.targets.map((target) => ({
      templateId: target.templateId,
      ...(target.port !== undefined ? { port: target.port } : {}),
      ...(target.selections !== undefined ? { selections: target.selections } : {}),
    })),
    ...(request.port !== undefined ? { port: request.port } : {}),
  });
  if (plan.problems.length > 0) {
    throw new Error(`生成计划不成立：${plan.problems.join('；')}`);
  }

  job.log(`项目「${project.name}」→ ${projectDir}`);
  job.log(`计划：${plan.items.map((item) => `${item.templateName}→${item.subdir || '根目录'}`).join('，')}`);
  job.progress(5, '校验');

  const results: ScaffoldOutcome['results'] = [];

  for (const [index, item] of plan.items.entries()) {
    job.throwIfCanceled();
    const base = Math.round((index / plan.items.length) * 90) + 5;
    const targetDir = item.subdir.length > 0 ? join(projectDir, item.subdir) : projectDir;
    const descriptor = findTemplate(item.templateId);
    /*
     * 端口逐栈算：这个栈自己的 → 模板惯例值。
     * 不再"取第一个目标的端口给所有人用" —— 那正是前后端撞号的来源。
     */
    const port = item.port ?? descriptor?.defaultPort ?? 5173;
    const vars: TemplateVars = {
      projectName: project.name,
      packageName: item.packageName,
      // Python 包名不能带横杠：`my-app` 不是合法标识符，Django 的 settings 模块名要用它
      moduleName: item.packageName.replace(/-/g, '_'),
      port,
      language: item.selections.language === 'js' ? 'js' : 'ts',
      ext: item.selections.language === 'js' ? 'js' : 'ts',
    };

    job.progress(base, `生成 ${item.templateName}`);
    job.log(
      `「${item.templateName}」：${describeSelections(descriptor ?? ({} as TemplateDescriptor), item.selections)}｜端口 ${port}｜目标 ${item.subdir || '根目录'}`,
    );

    /*
     * 官方优先：先探测（`--help`）→ 认得了就调官方 → 官方走不通再回退内置模板。
     * 每一步都在日志里说清走的哪条路（用户要求过"不许假装成功"）。
     */
    let strategy: 'builtin' | 'official' = item.strategy;
    let usedFallback = false;

    if (strategy === 'official') {
      if (!descriptor) throw new Error(`不认识的模板「${item.templateId}」`);

      const invocation = buildOfficialInvocation(descriptor, item.selections);
      for (const note of invocation.notes) job.log(`说明：${note}`);

      const npmPath = resolveOnPath('npm');
      const npxPath = resolveOnPath('npx');
      /*
       * "为什么官方没走通"：上面每一条失败路径都会给它赋值。
       *
       * 用 `undefined` 初值 + 下面那句兜底，而不是给一个含糊的默认字符串：
       * 真的走到"没记录原因"时，报出来的是"这是个 bug"，而不是一条像是真原因的假话。
       */
      let officialProblem: string | undefined;
      /** Django 用：venv 里 django-admin 的相对路径（前置步骤给的） */
      let djangoAdmin: string | undefined;

      /*
       * 第一步：拿到"这次能不能跑"的结论（`probe`）。
       *
       * 三条路，但**只有一处**执行与记录（下面那一段）：
       * - Django：官方工具不自带，前置先建 venv 装 Django，装完才谈得上探测；
       * - npm 系（Vue / React / NestJS）：没有 npm/npx 直接算走不通；
       * - 其余：按老规矩先跑一次 `--help` 探测。
       * 第一版把 Django 的"成功处理"也抄了一遍，两处各写一遍的代码迟早会分叉。
       */
      let probe: ProbeResult | undefined;
      if (invocation.spec === 'scaffold-django') {
        const bootstrap = await bootstrapDjangoScaffold(job, {
          targetDir,
          djangoSpec: pinsFor(descriptor, item.selections).django,
        });
        if (bootstrap.ok) {
          for (const note of bootstrap.notes) job.log(`  ${note}`);
          job.log(`✓ ${bootstrap.probe.note}`);
          djangoAdmin = bootstrap.djangoAdmin;
          probe = bootstrap.probe;
        } else {
          job.log(`✗ ${bootstrap.reason}`, 'warn');
          officialProblem = bootstrap.reason;
        }
      } else if (!npmPath && !npxPath) {
        officialProblem = 'PATH 里没有 npm / npx，调不了官方脚手架';
      } else {
        job.log(`探测「${item.templateName}」的官方脚手架能力（跑一次 --help）…`);
        const probed = await probeOfficialScaffold(job, descriptor, invocation, {
          npm: npmPath,
          npx: npxPath,
        });
        job.log(probed.ok ? `✓ ${probed.note}` : `✗ ${probed.note}`, probed.ok ? 'info' : 'warn');
        if (probed.ok) probe = probed;
        else officialProblem = probed.note;
      }

      // 第二步：真的跑一次（所有栈共用这一段）
      if (probe) {
        const outcome = await runOfficialScaffold(job, {
          descriptor,
          invocation,
          targetDir,
          npmPath,
          npxPath,
          probe,
          packageManager: request.packageManager,
          ...(djangoAdmin !== undefined ? { djangoAdmin } : {}),
          ...(invocation.spec === 'scaffold-django' ? { pythonProjectName: vars.moduleName } : {}),
        });
        if (outcome.ok) {
          job.log(`✓ ${item.templateName}：官方脚手架生成完成，搬入 ${outcome.moved.length} 个条目`);
          for (const name of outcome.moved.slice(0, 12)) job.log(`    ${name}`);
          if (outcome.moved.length > 12) job.log(`    …还有 ${outcome.moved.length - 12} 个`);
          if (outcome.skipped.length > 0) {
            job.log(
              `  跳过已存在的条目 ${outcome.skipped.length} 个（不覆盖）：${outcome.skipped.join(', ')}`,
              'warn',
            );
          }
          /*
           * 版本：官方只会写"它模板里那一版"，用户选的版本要我们自己改一遍清单。
           * 放在这里（官方成功、搬进目标目录之后）与内置回退之后各调一次，
           * 两条路径才能给出**一致**的结果。
           */
          applySelectedVersions(job, targetDir, descriptor, item.selections, port);

          results.push({
            templateId: item.templateId,
            subdir: item.subdir,
            strategy: 'official',
            usedFallback: false,
            dir: targetDir,
            written: outcome.moved,
            skipped: outcome.skipped,
          });
          continue;
        }
        officialProblem = outcome.reason;
      }
      const decision = decideAfterOfficialFailure({
        fallbackTemplateId: item.fallbackTemplateId,
        reason: officialProblem ?? '官方脚手架没走通，但没记录到原因（这是应用的 bug，请报出来）',
      });
      if (decision.kind === 'error') {
        throw new Error(
          `「${item.templateName}」只能走官方脚手架，而这次没走通：${decision.reason}。` +
            '可以检查网络（官方脚手架第一次要联网下载），或改选有内置模板的技术栈',
        );
      }
      job.log(
        `官方脚手架没走通（${decision.reason}）：改用内置骨架。` +
          '生成的是**最小骨架**，与官方相比少了示例代码与配置项',
        'warn',
      );
      strategy = 'builtin';
      usedFallback = true;
    }

    const templateId = usedFallback ? item.fallbackTemplateId! : item.templateId;
    const files = renderTemplate(templateId, vars);
    const writeResult = writeTemplateFiles(targetDir, files);

    job.log(`✓ ${item.templateName}：写入 ${writeResult.written.length} 个文件到 ${targetDir}`);
    for (const path of writeResult.written.slice(0, 12)) job.log(`    ${path}`);
    if (writeResult.written.length > 12) {
      job.log(`    …还有 ${writeResult.written.length - 12} 个`);
    }
    if (writeResult.skipped.length > 0) {
      // 跳过是有意义的事实：说明这里原本有东西，我们没动它
      job.log(`  跳过已存在的文件 ${writeResult.skipped.length} 个（不覆盖）：${writeResult.skipped.join(', ')}`, 'warn');
    }

    /* 内置回退路径：同样把用户选的版本写进清单（与官方路径共用一段代码） */
    applySelectedVersions(job, targetDir, descriptor, item.selections, port);

    results.push({
      templateId,
      subdir: item.subdir,
      strategy,
      usedFallback,
      dir: targetDir,
      written: writeResult.written,
      skipped: writeResult.skipped,
    });
  }

  job.progress(100, '已完成');
  const totalFiles = results.reduce((sum, item) => sum + item.written.length, 0);
  job.log(`全部完成：${results.length} 个目标，共 ${totalFiles} 个文件`);

  return {
    projectDir,
    targets: results.map((item) => ({
      templateId: item.templateId,
      subdir: item.subdir,
      dir: item.dir,
      files: item.written.length,
    })),
  };
}

/**
 * 把用户选的版本写进依赖清单（官方脚手架与内置回退**共用**这一段）。
 *
 * 抽成函数是因为它有**两个调用点**（官方成功后、内置写盘后），
 * 而两处必须做同一件事：否则会出现"走官方时选了 18 是 19、走回退时才对"这种
 * 只在断网时才暴露的不一致。
 */
function applySelectedVersions(
  job: JobContext,
  targetDir: string,
  descriptor: TemplateDescriptor | undefined,
  selections: Selections,
  port: number | undefined,
): void {
  if (!descriptor) return;
  const pins = pinsFor(descriptor, selections);
  if (Object.keys(pins).length === 0 && descriptor.enginesNode === undefined) return;

  const applied = applyVersionPins(targetDir, {
    pins,
    ...(descriptor.enginesNode !== undefined ? { enginesNode: descriptor.enginesNode } : {}),
    installKind: descriptor.installKind,
  });
  for (const entry of applied.changed) job.log(`✓ 版本：${entry}`);
  // 没改成的要明说（例：官方清单里本来就没有这个包）—— 静默跳过等于骗人
  for (const entry of applied.skipped) job.log(`  版本未改动：${entry}`, 'warn');

  /*
   * 端口也要真的写进配置。
   *
   * 内置模板本来就会写（`server: { port: __PORT__ }`），但**官方脚手架不会** ——
   * `create-vue` / `create-vite` 生成的 `vite.config.ts` 里没有 port，
   * `nest new` 的 `main.ts` 里是 `process.env.PORT ?? 3000`。
   * 不补这一步，向导里填的端口在官方路径上就是**白填**（用户以为生效了）。
   */
  if (port !== undefined) {
    const portResult = applyPortToConfig({ dir: targetDir, port });
    for (const entry of portResult.changed) job.log(`✓ 端口：${entry}`);
    for (const entry of portResult.skipped) job.log(`  端口未写入：${entry}`, 'warn');
  }
}

/** 作业标题：带上项目名，作业中心一眼能看出在给谁生成 */
export function scaffoldTitle(payload: Record<string, unknown>): string {
  const count = Array.isArray(payload.targets) ? payload.targets.length : 0;
  const stacks = Array.isArray(payload.targets)
    ? payload.targets
        .map((target) => {
          const id = (target as { templateId?: string }).templateId ?? '';
          return findTemplate(id)?.name ?? id;
        })
        .join(' + ')
    : '';
  return `生成项目骨架${stacks ? `（${stacks}）` : ''}${count > 1 ? ' · 前后端' : ''}`;
}

/** 校验 payload（界面上可能传来乱七八糟的东西，服务端得自己确认一遍） */
export function parseScaffoldPayload(payload: Record<string, unknown>): ScaffoldRequest {
  const projectId = typeof payload.projectId === 'string' ? payload.projectId : '';
  if (projectId.length === 0) throw new Error('缺少 projectId');

  const rawTargets = Array.isArray(payload.targets) ? payload.targets : [];
  const targets: ScaffoldTargetRequest[] = [];

  for (const raw of rawTargets) {
    const record = (raw ?? {}) as Record<string, unknown>;
    const templateId = typeof record.templateId === 'string' ? record.templateId : '';
    if (templateId.length === 0) continue;

    const descriptor = findTemplate(templateId);
    if (!descriptor) throw new Error(`不认识的技术栈「${templateId}」`);

    const port = validatePort(record.port);
    /*
     * 维度选择也要过服务端的校验：界面是我们写的，但接口是公开的，
     * 而且"多传一个没声明过的维度"如果不报错，就会静默变成"用户以为选了、其实没选"。
     */
    const { values, problems } = validateSelections(descriptor, record.selections);
    if (problems.length > 0) throw new Error(problems.join('；'));

    targets.push({
      templateId,
      subdir: '',
      ...(port !== undefined ? { port } : {}),
      ...(record.selections !== undefined ? { selections: values } : {}),
    });
  }

  if (targets.length === 0) throw new Error('至少要选一个技术栈');

  const port = validatePort(payload.port);
  const pm = payload.packageManager;
  const packageManager = pm === 'pnpm' || pm === 'npm' || pm === 'yarn' ? pm : undefined;
  return {
    projectId,
    targets,
    ...(port !== undefined ? { port } : {}),
    ...(packageManager !== undefined ? { packageManager } : {}),
  };
}

/**
 * 端口校验：只接受 1~65535 的整数。
 *
 * 服务端不能只信界面：端口会被写进生成出来的模板（`uvicorn --port` / `vite server.port`），
 * 一个越界或带小数的值会生成出**跑到一半才报错**的项目。
 */
export function validatePort(value: unknown): number | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  const port = typeof value === 'string' ? Number(value) : value;
  if (typeof port !== 'number' || !Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`端口不合法（${String(value)}）：要是 1~65535 之间的整数`);
  }
  return port;
}

/** 供作业中心/诊断用：这一版有哪些模板可用 */
export function listScaffoldTemplates(): Array<{
  id: string;
  name: string;
  kind: string;
  source: string;
  /** 官方脚手架要联网；内置模板离线可用 —— 界面据此如实标注 */
  needsNetwork: boolean;
  defaultPort: number;
  installKind: 'node' | 'python' | 'none';
  /** 语言标签（没有"语言"维度时静态显示：Python / TypeScript） */
  languageLabel: string;
  /** 这个栈对 Node 的要求（界面静态显示，不许做开关：它是工具链的事实） */
  enginesNode: string | undefined;
  /** 可选的维度（界面照这个渲染，不做死控件） */
  dimensions: readonly TemplateDimension[];
}> {
  return TEMPLATES.map((template) => ({
    id: template.id,
    name: template.name,
    kind: template.kind,
    source: template.source,
    needsNetwork: template.source === 'official',
    defaultPort: template.defaultPort,
    installKind: template.installKind,
    languageLabel: template.languageLabel,
    enginesNode: template.enginesNode,
    dimensions: template.dimensions,
  }));
}

/** 目录里已经像不像一个生成过的项目（给界面判断"要不要再生成一次"） */
export function looksScaffolded(dir: string): boolean {
  return (
    existsSync(join(dir, 'package.json')) ||
    existsSync(join(dir, 'requirements.txt')) ||
    existsSync(join(dir, 'manage.py'))
  );
}
