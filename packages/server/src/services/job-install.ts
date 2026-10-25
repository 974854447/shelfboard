/**
 * 装依赖作业（M4）。
 *
 * 这是创建项目流程的第三步：骨架生成完之后，把依赖真的装上 ——
 * Node 侧 `<pnpm|npm> install`，Python 侧**先建 venv 再在 venv 里 pip install**
 * （绝不用全局 Python 装：那会污染用户机器，而且不同项目互相打架）。
 *
 * 几条取舍：
 *
 * 1. **包管理器按"这台机器上有什么"选**：优先 pnpm（更快、磁盘占用小），
 *    没有就 npm；用户也能在向导里显式指定。选的时候要**解析出真实路径**，
 *    因为 Windows 上 pnpm / npm 都是 `.cmd` 批处理壳（见 commands.ts）。
 * 2. **安装是可以跳过的**：断网、公司代理、只想先要个目录结构的人都有；
 *    跳过时作业**成功**并在日志里写明"依赖没装"，而不是伪装成装好了。
 * 3. **失败要带着输出**：`npm install` 的报错信息（代理、私有源、Node 版本不匹配）
 *    都在 stdout/stderr 里，作业日志会逐行记下来。
 */

import { existsSync } from 'node:fs';
import { join } from 'node:path';

import type { JobContext } from './job-runner.js';
import { getProjectOrThrow } from './projects.js';
import { findTemplate } from './scaffold-templates.js';
import { resolveOnPath } from './which.js';

export type PackageManager = 'pnpm' | 'npm' | 'yarn';

export interface InstallRequest {
  projectId: string;
  targets: Array<{ templateId: string }>;
  /** 不传就按机器上装了什么来选 */
  packageManager?: PackageManager;
  /** 虚拟环境目录名（默认 .venv） */
  venvDir?: string;
}

export interface InstallPlanItem {
  templateId: string;
  templateName: string;
  kind: 'node' | 'python' | 'none';
  /** 相对项目文件夹的目录（'' = 根目录） */
  subdir: string;
  /** 有依赖要装吗（`none` 或没有依赖清单就跳过） */
  needsInstall: boolean;
}

export interface InstallPlan {
  items: InstallPlanItem[];
  problems: string[];
}

/** 双栈时前端/后端分开目录，与脚手架的规则保持一致 */
export function planInstall(input: {
  targets: Array<{ templateId: string }>;
}): InstallPlan {
  const problems: string[] = [];
  const multiple = input.targets.length > 1;
  const seen = new Set<string>();

  const items = input.targets.map((target): InstallPlanItem => {
    const template = findTemplate(target.templateId);
    if (!template) {
      problems.push(`不认识的模板「${target.templateId}」`);
      return {
        templateId: target.templateId,
        templateName: target.templateId,
        kind: 'none',
        subdir: '',
        needsInstall: false,
      };
    }

    const subdir = multiple ? (template.kind === 'frontend' ? 'frontend' : 'backend') : '';
    if (seen.has(subdir)) problems.push(`两个目标都要装到「${subdir || '根目录'}」，会互相干扰`);
    seen.add(subdir);

    return {
      templateId: template.id,
      templateName: template.name,
      kind: template.installKind,
      subdir,
      needsInstall: template.installKind !== 'none',
    };
  });

  if (items.length === 0) problems.push('至少要选一个技术栈');
  return { items, problems };
}

/** 虚拟环境里 python 可执行文件的位置（Windows 与 POSIX 不一样） */
export function venvPythonPath(venvDir: string, platform: NodeJS.Platform = process.platform): string {
  return platform === 'win32' ? `${venvDir}\\Scripts\\python.exe` : `${venvDir}/bin/python`;
}

/**
 * 虚拟环境里某个**命令行入口**的位置（例：pip 装出来的 `django-admin`）。
 *
 * 与 `venvPythonPath` 放一起是有原因的：这两个路径**都只能按相对路径算**，
 * 而 Windows 的目录名是 `Scripts`、POSIX 是 `bin` —— 写死一个平台，另一个平台就找不到文件，
 * 而"找不到文件"报出来是"命令不存在"，方向完全错了。
 */
export function venvBinPath(
  venvDir: string,
  name: string,
  platform: NodeJS.Platform = process.platform,
): string {
  return platform === 'win32' ? `${venvDir}\\Scripts\\${name}.exe` : `${venvDir}/bin/${name}`;
}

export function parseInstallPayload(payload: Record<string, unknown>): InstallRequest {
  const projectId = typeof payload.projectId === 'string' ? payload.projectId : '';
  if (projectId.length === 0) throw new Error('缺少 projectId');

  const raw = Array.isArray(payload.targets) ? payload.targets : [];
  const targets = raw
    .map((target) => (target as { templateId?: unknown }).templateId)
    .filter((id): id is string => typeof id === 'string' && id.length > 0)
    .map((templateId) => ({ templateId }));
  if (targets.length === 0) throw new Error('至少要选一个技术栈');

  const pm = payload.packageManager;
  const packageManager =
    pm === 'pnpm' || pm === 'npm' || pm === 'yarn' ? (pm as PackageManager) : undefined;
  const venvDir = typeof payload.venvDir === 'string' && payload.venvDir.length > 0 ? payload.venvDir : undefined;

  return {
    projectId,
    targets,
    ...(packageManager !== undefined ? { packageManager } : {}),
    ...(venvDir !== undefined ? { venvDir } : {}),
  };
}

/** 按机器上装了什么挑包管理器：pnpm → npm → yarn，都没有就报错 */
export function pickPackageManager(
  requested: PackageManager | undefined,
  env: NodeJS.ProcessEnv = process.env,
  exists?: (path: string) => boolean,
): { pm: PackageManager; path: string | null } {
  const probe = (name: PackageManager): string | null =>
    exists ? resolveOnPath(name, env, exists) : resolveOnPath(name, env);

  if (requested) return { pm: requested, path: probe(requested) };
  for (const candidate of ['pnpm', 'npm', 'yarn'] as const) {
    const path = probe(candidate);
    if (path) return { pm: candidate, path };
  }
  return { pm: 'npm', path: null };
}

export async function runInstallJob(
  job: JobContext,
  request: InstallRequest,
): Promise<Record<string, unknown>> {
  const ctx = job.ctx;
  const project = getProjectOrThrow(ctx, request.projectId);
  if (project.folder === null) {
    throw new Error(`项目「${project.name}」还没有文件夹，无法安装依赖`);
  }

  const root = ctx.workspaceRoot;
  if (!root) throw new Error('当前没有工作区目录，无法安装依赖');
  const projectDir = join(root, project.folder);

  const plan = planInstall({ targets: request.targets });
  if (plan.problems.length > 0) throw new Error(`安装计划不成立：${plan.problems.join('；')}`);

  const toInstall = plan.items.filter((item) => item.needsInstall);
  if (toInstall.length === 0) {
    job.log('所选技术栈不需要安装依赖（纯管理项目 / 没有依赖清单）');
    return { installed: [], skipped: plan.items.map((item) => item.templateId) };
  }

  const results: Array<{ templateId: string; kind: string; ok: boolean; note?: string }> = [];
  const installed: string[] = [];

  for (const [index, item] of toInstall.entries()) {
    job.throwIfCanceled();
    const dir = item.subdir.length > 0 ? join(projectDir, item.subdir) : projectDir;
    const base = Math.round((index / toInstall.length) * 100);
    job.progress(base, `安装 ${item.templateName} 的依赖`);
    job.log(`── ${item.templateName}：在 ${dir} 安装依赖`);

    if (item.kind === 'node') {
      const chosen = pickPackageManager(request.packageManager);
      if (!chosen.path) {
        throw new Error(
          `没有找到 ${chosen.pm}（PATH 里没有）—— 先装一个 Node 包管理器，或在创建项目时先跳过安装`,
        );
      }
      job.log(`包管理器：${chosen.pm}（${chosen.path}）`);
      const result = await job.runCommand('install-node', { pm: chosen.pm }, {
        cwd: dir,
        executePath: chosen.path,
      });
      if (!result.ok) {
        results.push({ templateId: item.templateId, kind: 'node', ok: false, note: '安装失败' });
        throw new Error(
          `${item.templateName} 的依赖没装上（${chosen.pm} install ${result.timedOut ? '超时' : `退出码 ${result.code ?? '—'}`}）。` +
            '常见原因：网络/代理不通、私有源需要登录。装好后可以重新走一次安装',
        );
      }
      installed.push(item.templateId);
      results.push({ templateId: item.templateId, kind: 'node', ok: true });
      continue;
    }

    // Python：先建 venv，再在 venv 里装
    const venvDir = request.venvDir ?? '.venv';
    const pythonPath = resolveOnPath('python');
    if (!pythonPath) {
      throw new Error('PATH 里没有 python —— 先装 Python，或在创建项目时先跳过安装');
    }

    job.log(`建虚拟环境：${venvDir}（用全局 ${pythonPath} 建，之后只用 venv 里的解释器）`);
    const venvResult = await job.runCommand('python-venv', { name: venvDir }, {
      cwd: dir,
      executePath: pythonPath,
    });
    if (!venvResult.ok) {
      throw new Error(
        `建虚拟环境失败（退出码 ${venvResult.code ?? '—'}）。可能是这个 Python 缺 venv 模块`,
      );
    }

    const relativePython = venvPythonPath(venvDir);
    job.log(`在虚拟环境里装依赖：${relativePython} -m pip install -r requirements.txt`);
    const pipResult = await job.runCommand(
      'python-pip-install',
      { python: relativePython, requirements: 'requirements.txt' },
      { cwd: dir },
    );
    if (!pipResult.ok) {
      throw new Error(
        `${item.templateName} 的 Python 依赖没装上（退出码 ${pipResult.code ?? '—'}）。` +
          '常见原因：网络/PyPI 镜像不通。装好后可以重新走一次安装',
      );
    }
    installed.push(item.templateId);
    results.push({ templateId: item.templateId, kind: 'python', ok: true });
  }

  /*
   * Node 侧装完之后**看一眼 node_modules 是否真的出现了**。
   *
   * 实测踩到的场景：项目文件夹位于**别的 pnpm workspace 里面**时，
   * `pnpm install` 会往上找到那个 workspace 的根、把依赖装到根目录去，
   * 项目自己这里不生成 node_modules —— 命令"成功"了，但项目还是跑不起来。
   * 这种情况必须**说出来并给出可操作的做法**，否则用户会看到"安装成功"却仍然"还没装依赖"，
   * 反复点安装也没有用（最难查的一类）。
   */
  for (const item of plan.items) {
    if (item.kind !== 'node' || !item.needsInstall) continue;
    const dir = item.subdir.length > 0 ? join(projectDir, item.subdir) : projectDir;
    if (!existsSync(join(dir, 'node_modules'))) {
      job.log(
        `注意：${item.templateName} 装完了，但这个目录里**没有** node_modules。` +
          '如果项目文件夹位于别的 pnpm workspace 里面，pnpm 会把依赖装到那个 workspace 的根目录；' +
          '可以在项目里放一个空的 pnpm-workspace.yaml，或改用 npm 再装一次',
        'warn',
      );
    }
  }

  job.progress(100, '已完成');
  job.log(`依赖安装完成：${installed.join('、')}`);
  return { installed, results };
}

export function installTitle(payload: Record<string, unknown>): string {
  const count = Array.isArray(payload.targets) ? payload.targets.length : 0;
  return count > 1 ? '安装前后端依赖' : '安装依赖';
}
