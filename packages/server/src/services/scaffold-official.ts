/**
 * 官方脚手架（M4）：能力探测 + 调用 + 失败回退。
 *
 * ## 为什么要"先探测"
 *
 * 官方脚手架的参数会随版本变（技术设计 §5.1 A10）。硬编码参数的结局是：
 * 某天官方改了参数，用户看到的是"生成失败"，而真正的原因是"参数变了"。
 * 所以调用前先跑一次 `--help`，把它**认得的**参数挑出来再组装命令；
 * 探测本身失败（断网、包拉不下来）就**回退内置模板**（有的话）。
 *
 * ## 为什么在暂存目录里生成，再搬过去
 *
 * 官方脚手架不接受"生成到一个非空目录"：
 * - 单栈项目的目标目录是**项目文件夹根目录**，而它从创建起就带着 `attachments/`、`logs/`；
 * - `create-vue` 见到非空目录会**交互式提问**（"目录不是空的，要清掉吗"），
 *   而非交互调用在那种情况下会直接失败。
 *
 * 所以流程是：在目标目录里开一个临时子目录 → 在里面生成 → **成功之后**再把内容搬进目标目录。
 * 用"先全部生成完再搬"而不是"边生成边搬"，是因为失败时**目标目录必须保持原样** ——
 * 半成品目录比失败本身更难收拾。
 */

import { existsSync, mkdirSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { venvBinPath, venvPythonPath } from './job-install.js';
import type { JobContext } from './job-runner.js';
import type { OfficialInvocation } from './scaffold-options.js';
import type { TemplateDescriptor } from './scaffold-templates.js';
import { resolveOnPath } from './which.js';

/** 官方脚手架生成的目录名：固定用安全名，不用项目名（项目名可能有空格/中文，会进 cmd.exe） */
export const SCAFFOLD_APP_NAME = 'app';
/** 暂存目录名（放在目标目录内，保证与目标同盘，`rename` 才能瞬间完成） */
export const STAGING_DIR_NAME = '.scaffold-staging';

export interface ProbeResult {
  ok: boolean;
  /** 确认可用、准备真的传给官方脚手架的参数 */
  args: string[];
  /** 给日志用的一句话 */
  note: string;
}

/**
 * 从 `--help` 输出里挑出它认得的参数。
 *
 * 只做一件事：把所有 `--xxx` 形式的 token 收集起来（去重、保序）。
 * **不做模糊匹配、不猜**：认不出来就当它不支持，走回退 —— 猜错的代价是
 * 一条失败的命令，而失败的命令会被当成"官方脚手架坏了"。
 */
export function parseHelpFlags(helpText: string): string[] {
  const flags: string[] = [];
  for (const match of helpText.matchAll(/--[a-z][a-z0-9-]*/g)) {
    const flag = match[0];
    if (!flags.includes(flag)) flags.push(flag);
  }
  return flags;
}

/** 探测某个官方脚手架认不认这次要用的参数 */
export async function probeOfficialScaffold(
  job: JobContext,
  template: TemplateDescriptor,
  invocation: OfficialInvocation,
  executePath: { npm: string | null; npx: string | null },
): Promise<ProbeResult> {
  if (invocation.spec === 'scaffold-npm-create') {
    const pkg = invocation.package ?? template.officialPackage;
    if (!pkg) return { ok: false, args: [], note: '这个模板没有声明官方包名' };

    const result = await job.runCommand('probe-npm-create', { pkg }, {
      ...(executePath.npm ? { executePath: executePath.npm } : {}),
    });
    if (!result.ok) {
      return {
        ok: false,
        args: [],
        note: result.timedOut
          ? '探测超时（第一次要下载脚手架包，网络慢时会这样）'
          : `探测失败（退出码 ${result.code ?? '—'}）：${(result.stderr || result.stdout).slice(0, 120)}`,
      };
    }

    const helpText = `${result.stdout}\n${result.stderr}`;
    const available = parseHelpFlags(helpText);
    // 一个参数都没读出来 = 探测其实没成功（输出格式变了），这时不该硬着头皮调
    if (available.length === 0) {
      return { ok: false, args: [], note: '`--help` 有输出，但没认出任何已知参数（官方可能改了参数名）' };
    }

    /*
     * 逐个确认**这次要用的**参数。两类别查法：
     * - `--xxx` 形式：必须在 `--help` 的旗标列表里；
     * - 其它（模板名这类"参数的值"，例 `react-ts`）：必须在帮助文本里出现。
     * 查不出来的就不跑 —— 报"官方不认 --router"比报"生成失败"有用得多。
     */
    const unknown = invocation.args.filter((arg) =>
      arg.startsWith('--') ? !available.includes(arg) : !helpText.includes(arg),
    );
    if (unknown.length > 0) {
      return {
        ok: false,
        args: [],
        note: `这个版本的官方脚手架不认：${unknown.join('、')}（参数表可能变了）`,
      };
    }

    return {
      ok: true,
      args: [...invocation.args],
      note:
        invocation.args.length > 0
          ? `官方脚手架确认可用：${invocation.args.join(' ')}`
          : '官方脚手架确认可用（这次没有额外参数）',
    };
  }

  if (invocation.spec === 'scaffold-nest-new') {
    const result = await job.runCommand('probe-nest-help', {}, {
      ...(executePath.npx ? { executePath: executePath.npx } : {}),
    });
    if (!result.ok) {
      return {
        ok: false,
        args: [],
        note: `探测失败（退出码 ${result.code ?? '—'}）：${(result.stderr || result.stdout).slice(0, 120)}`,
      };
    }
    const available = parseHelpFlags(`${result.stdout}\n${result.stderr}`);
    for (const needed of ['--package-manager', '--skip-git', ...invocation.args]) {
      if (!available.includes(needed)) {
        return { ok: false, args: [], note: `这个版本的 @nestjs/cli 不认 ${needed}` };
      }
    }
    return {
      ok: true,
      args: [...invocation.args],
      note: `NestJS 官方参数齐全${invocation.args.length > 0 ? `（${invocation.args.join(' ')}）` : ''}`,
    };
  }

  return { ok: false, args: [], note: `「${template.name}」没有登记官方脚手架` };
}

/* ------------------------------------------------------------------ */
/* Python 脚手架的前置：先有 Django 才有 django-admin                  */
/* ------------------------------------------------------------------ */

export interface DjangoBootstrapOptions {
  /** 项目文件夹（venv 与 requirements.txt 都放在这里，后面的"装依赖"会复用） */
  targetDir: string;
  /** `requirements.txt` 里写的 Django 版本描述（来自用户的版本选择） */
  djangoSpec?: string;
  /** 虚拟环境目录名（默认 `.venv`，与装依赖那一步一致） */
  venvDir?: string;
  /**
   * 全局 python 的路径。不传就自己从 PATH 上找。
   *
   * 留这个口子是为了**能测**：单测里不该依赖"跑测试的这台机器上有没有 python"
   * （CI 上没有的话，用例会变成"看机器脸色"）。
   */
  pythonPath?: string | null;
}

export type DjangoBootstrapOutcome =
  | {
      ok: true;
      /** venv 里 `django-admin` 的**项目内相对路径**（给命令白名单用） */
      djangoAdmin: string;
      probe: ProbeResult;
      /** 这一步做了什么（写进日志当证据） */
      notes: string[];
    }
  | { ok: false; reason: string };

/**
 * 让 `django-admin` 可用：建 venv → 装 Django → 确认它认 `startproject`。
 *
 * ## 为什么这段必须存在（而不是"留到装依赖那一步"）
 *
 * `django-admin startproject` 是官方命令，但它**不是自带**的 —— 得先有 Django。
 * 不装就调，报出来是"命令不存在"，看起来像"脚手架坏了"，实际是"还没装"。
 * 其他栈的官方脚手架都是 `npm create …`（npx 会自己把包拉下来），只有 Python 这条
 * 需要我们自己把"前置工具"准备好。
 *
 * ## 三个刻意的选择
 *
 * 1. **venv 建在项目文件夹里**（`.venv`），与"装依赖"那一步**共用**一个虚拟环境 ——
 *    两处各建一个的话，用户会得到两份几百 MB 的环境，而且不知道哪个是"真的"。
 * 2. **`requirements.txt` 先写出来**：pip 从清单装（走白名单里已有的命令），
 *    顺便让项目有个正确的依赖清单（官方 `startproject` **不会**生成它）。
 *    写的是用户选的版本（`>=6.0` / `>=4.2,<5`）。
 * 3. **这一步要联网**，失败了就**如实回退内置骨架**（与 Vue / React 同一条规矩）——
 *    不能因为"装不上 Django"就让用户连一个能跑的项目都拿不到。
 */
export async function bootstrapDjangoScaffold(
  job: JobContext,
  options: DjangoBootstrapOptions,
): Promise<DjangoBootstrapOutcome> {
  const venvDir = options.venvDir ?? '.venv';
  const notes: string[] = [];

  /*
   * 注意这里**不能用 `??`**：`pythonPath: null` 的意思是"我知道这台机器上没有 python"，
   * 用 `??` 会把它当成"没传"、又回落到 PATH 上找一个真的 python —— 于是调用方
   * 明确告诉我们的"没有"被悄悄推翻。（单测当场抓到了这一条。）
   */
  const pythonPath = options.pythonPath === undefined ? resolveOnPath('python') : options.pythonPath;
  if (!pythonPath) {
    return { ok: false, reason: 'PATH 里没有 python —— 装好 Python 再走官方脚手架' };
  }

  const venvRoot = join(options.targetDir, venvDir);
  if (!existsSync(join(venvRoot, 'Scripts')) && !existsSync(join(venvRoot, 'bin'))) {
    job.log(`官方脚手架要先有 Django：先用全局 python 建虚拟环境 ${venvDir}（只建一次）`);
    const venv = await job.runCommand('python-venv', { name: venvDir }, {
      cwd: options.targetDir,
      executePath: pythonPath,
    });
    if (!venv.ok) {
      return {
        ok: false,
        reason: `建虚拟环境失败（退出码 ${venv.code ?? '—'}）：这个 Python 可能缺 venv 模块`,
      };
    }
    notes.push(`建了虚拟环境 ${venvDir}`);
  } else {
    job.log(`复用已有的虚拟环境 ${venvDir}（不重复建）`);
  }

  /*
   * 官方 `startproject` 不生成 requirements.txt，而下一步 pip 要从清单装 ——
   * 所以这里先把清单写出来。它同时也是这个项目**真正需要的**依赖清单。
   * 已存在时**不覆盖**（用户可能已经改过），只补一条 Django。
   */
  const requirementsPath = join(options.targetDir, 'requirements.txt');
  const djangoSpec = options.djangoSpec ?? '>=5.0';
  if (!existsSync(requirementsPath)) {
    writeFileSync(requirementsPath, `# Django 项目依赖\nDjango${djangoSpec}\n`, 'utf8');
    notes.push(`写了 requirements.txt（Django${djangoSpec}）`);
  } else {
    job.log('requirements.txt 已存在：不改它，直接用它装 Django');
  }

  const relativePython = venvPythonPath(venvDir);
  job.log(`在虚拟环境里装 Django（这一步要联网）：${relativePython} -m pip install -r requirements.txt`);
  const pip = await job.runCommand(
    'python-pip-install',
    { python: relativePython, requirements: 'requirements.txt' },
    { cwd: options.targetDir },
  );
  if (!pip.ok) {
    return {
      ok: false,
      reason: pip.timedOut
        ? 'pip 装 Django 超时（第一次要下 PyPI 的包）'
        : `pip 装 Django 失败（退出码 ${pip.code ?? '—'}）：常见原因是网络或 PyPI 镜像不通`,
    };
  }
  notes.push('在 venv 里装好了 Django');

  const djangoAdmin = venvBinPath(venvDir, 'django-admin');
  if (!existsSync(join(options.targetDir, ...djangoAdmin.split('\\')))) {
    return {
      ok: false,
      reason: `装完之后没找到 ${djangoAdmin}（pip 可能没生成命令行入口）`,
    };
  }

  // 探测：这个版本的 django-admin 认不认 startproject（参数表也可能变）
  const probe = await job.runCommand('probe-django-help', { django: djangoAdmin }, {
    cwd: options.targetDir,
  });
  const helpText = `${probe.stdout}\n${probe.stderr}`;
  if (!probe.ok) {
    return { ok: false, reason: `django-admin 探测失败（退出码 ${probe.code ?? '—'}）` };
  }
  if (!helpText.includes('startproject')) {
    return { ok: false, reason: '这个版本的 django-admin 帮助里没有 startproject（参数表可能变了）' };
  }

  return {
    ok: true,
    djangoAdmin,
    probe: { ok: true, args: [], note: 'django-admin 确认可用（startproject 在它的命令表里）' },
    notes,
  };
}

/* ------------------------------------------------------------------ */
/* 暂存 + 搬运                                                         */
/* ------------------------------------------------------------------ */

export interface AdoptResult {
  /** 搬过去的条目（顶层名字） */
  moved: string[];
  /** 目标目录里已经存在、被跳过的条目 */
  skipped: string[];
}

/**
 * 把暂存目录里生成好的内容搬进目标目录。
 *
 * **不覆盖**已存在的条目（与内置模板的规矩一致）：目标目录里的 `attachments/`、`logs/`
 * 或者用户自己放的东西，都比一份新生成的骨架更重要。跳过时要报出来。
 */
export function adoptStagedDirectory(stagingDir: string, targetDir: string): AdoptResult {
  const subdir = join(stagingDir, SCAFFOLD_APP_NAME);
  const source = existsSync(subdir) ? subdir : stagingDir;

  const moved: string[] = [];
  const skipped: string[] = [];
  mkdirSync(targetDir, { recursive: true });

  for (const entry of readdirSync(source, { withFileTypes: true })) {
    const from = join(source, entry.name);
    const to = join(targetDir, entry.name);
    if (existsSync(to)) {
      skipped.push(entry.name);
      continue;
    }
    renameSync(from, to);
    moved.push(entry.name);
  }

  return { moved, skipped };
}

/** 收掉暂存目录（成功或失败都要收，别在项目里留一个 `.scaffold-staging`） */
export function removeStagingDirectory(stagingDir: string): void {
  rmSync(stagingDir, { recursive: true, force: true });
}

/* ------------------------------------------------------------------ */
/* 调用官方脚手架                                                      */
/* ------------------------------------------------------------------ */

export interface OfficialRunOptions {
  descriptor: TemplateDescriptor;
  /** 探测确认过的调用（含包名与参数） */
  invocation: OfficialInvocation;
  /** 最终目标目录（项目文件夹，或双栈时的 frontend/ · backend/） */
  targetDir: string;
  npmPath: string | null;
  npxPath: string | null;
  probe: ProbeResult;
  /** NestJS 要指定包管理器 */
  packageManager?: 'pnpm' | 'npm' | 'yarn';
  /** Django：venv 里 `django-admin` 的项目内相对路径（前置安装给的） */
  djangoAdmin?: string;
  /** Django：`startproject <name>` 的包名（Python 标识符） */
  pythonProjectName?: string;
}

export type OfficialRunOutcome =
  | { ok: true; moved: string[]; skipped: string[] }
  | { ok: false; reason: string };

/**
 * 在暂存目录里跑官方脚手架，成功后把内容搬进目标目录。
 *
 * 失败时**目标目录必须保持原样**（所以是"先全生成完再搬"）：
 * 半成品目录比失败本身更难收拾 —— 用户既不知道删哪些，也不知道重试会不会覆盖。
 */
export async function runOfficialScaffold(
  job: JobContext,
  options: OfficialRunOptions,
): Promise<OfficialRunOutcome> {
  const stagingDir = join(options.targetDir, STAGING_DIR_NAME);
  removeStagingDirectory(stagingDir);
  mkdirSync(stagingDir, { recursive: true });

  try {
    if (options.invocation.spec === 'scaffold-npm-create') {
      const pkg = options.invocation.package ?? options.descriptor.officialPackage;
      if (!pkg) return { ok: false, reason: '这个模板没有声明官方包名' };
      if (!options.npmPath) return { ok: false, reason: 'PATH 里没有 npm' };

      const result = await job.runCommand(
        'scaffold-npm-create',
        {
          pkg,
          name: SCAFFOLD_APP_NAME,
          ...(options.probe.args.length > 0 ? { flags: options.probe.args.join(' ') } : {}),
        },
        { cwd: stagingDir, executePath: options.npmPath },
      );
      if (!result.ok) {
        return {
          ok: false,
          reason: result.timedOut
            ? '官方脚手架超时（下载或生成太久）'
            : `官方脚手架失败（退出码 ${result.code ?? '—'}）`,
        };
      }
    } else if (options.invocation.spec === 'scaffold-nest-new') {
      if (!options.npxPath) return { ok: false, reason: 'PATH 里没有 npx' };
      const result = await job.runCommand(
        'scaffold-nest-new',
        {
          name: SCAFFOLD_APP_NAME,
          pm: options.packageManager ?? 'pnpm',
          ...(options.probe.args.length > 0 ? { flags: options.probe.args.join(' ') } : {}),
        },
        { cwd: stagingDir, executePath: options.npxPath },
      );
      if (!result.ok) {
        return {
          ok: false,
          reason: result.timedOut
            ? 'NestJS 脚手架超时（下载或生成太久）'
            : `NestJS 脚手架失败（退出码 ${result.code ?? '—'}）`,
        };
      }
    } else if (options.invocation.spec === 'scaffold-django') {
      /*
       * Django：`django-admin` 在**项目自己的 venv** 里（`bootstrapDjangoScaffold` 刚装好的），
       * 所以可执行文件是项目内相对路径 —— cwd 必须留在**项目文件夹**，
       * 否则那个相对路径会相对暂存目录去找，直接报 ENOENT
       * （第一版就是这么栽的，现象是"django-admin startproject 失败（退出码 ENOENT）"，
       *  看着像"Django 没装上"，其实是"路径相对谁"的问题）。
       *
       * 于是"生成到暂存目录"改用 Django 自己的目的地参数：
       * `django-admin startproject <name> <destination>`，destination 传暂存目录名。
       */
      const djangoAdmin = options.djangoAdmin;
      if (!djangoAdmin) return { ok: false, reason: '没有可用的 django-admin（前置安装没做成）' };
      const scriptName = options.pythonProjectName;
      if (!scriptName) return { ok: false, reason: '没给出 Django 的项目包名' };

      const result = await job.runCommand(
        'scaffold-django',
        { django: djangoAdmin, name: scriptName, destination: STAGING_DIR_NAME },
        { cwd: options.targetDir },
      );
      if (!result.ok) {
        return {
          ok: false,
          reason: result.timedOut
            ? 'django-admin startproject 超时'
            : `django-admin startproject 失败（退出码 ${result.code ?? '—'}）`,
        };
      }
    } else {
      return { ok: false, reason: `「${options.descriptor.name}」的官方调用尚未实现` };
    }

    const adopted = adoptStagedDirectory(stagingDir, options.targetDir);

    /*
     * 退出码是 0，但什么都没生成 —— 这是**必须当成失败**的一种情况：
     * 官方脚手架可能因为参数不认、或者交互被拒而"安静地什么都没做"。
     * 当成成功的话，用户会得到一个空项目外加一句"生成完成"。
     */
    if (adopted.moved.length === 0 && adopted.skipped.length === 0) {
      return { ok: false, reason: '官方脚手架跑完了，但没生成任何文件（参数可能不被这个版本接受）' };
    }

    return { ok: true, moved: adopted.moved, skipped: adopted.skipped };
  } finally {
    // 成功与失败都要收：留着它会让下一次生成看到"目录里有东西"
    removeStagingDirectory(stagingDir);
  }
}
