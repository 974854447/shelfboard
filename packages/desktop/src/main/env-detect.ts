/**
 * 开发环境检测（M4 第一步，**只读**）。
 *
 * 新建项目之前必须先知道"这台机器有什么"：`node / npm / pnpm / yarn / python / pip / git`
 * 各在不在、什么版本，以及 `python` 带不带 `venv`。检测结果决定向导能不能往下走，
 * 也决定脚手架该用 pnpm 还是 npm。
 *
 * ## 与 `environment.ts` 的区别（别搞混）
 *
 * - `environment.ts`：判定应用跑的是**测试环境还是正式环境**（决定数据放哪个目录）。
 * - `env-detect.ts`（本文件）：检测**这台电脑装了哪些开发工具**。
 *
 * 两者都叫"环境"，但一个是"应用自己的环境"，一个是"机器的工具链"，所以分两个文件。
 *
 * ## 三条设计决定
 *
 * 1. **"在哪"用纯文件系统逻辑，"版本"才派生进程**。查找复用 `editor.ts` 里那套 PATH 遍历
 *    （`createPathEditorProbe`）—— 不派生进程、可直接单测，也避开了"捕获子进程输出"
 *    这类在受限环境里容易被挡的操作。只有"版本号"必须真的跑一下工具，
 *    那一步走服务端的命令白名单（`runCommand`）。
 * 2. **结果缓存进 AppData**（`<userData>/environment.json`），**不进工作区数据库**：
 *    它描述的是"这台机器"，不是用户的项目数据（工作区边界见需求 §13.1）；
 *    而且换工作区（M5）时同一个结果继续有效，不必重测。
 * 3. **如实报告**：找不到就是找不到，并写明"缺了它会影响什么"；超时/报错不假装成功。
 *    另外缓存里记下启动时的 PATH 指纹 —— 改了环境变量之后已运行的进程读不到新 PATH，
 *    不一致就提示"需要重启应用才生效"，否则用户装了 node、重测还是"没找到"，会以为软件坏了。
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

import { runCommand, type CommandExec, type DetectableTool } from '@pm-studio/server';

import { createPathEditorProbe } from './editor';

/* ------------------------------------------------------------------ */
/* 要检测什么                                                          */
/* ------------------------------------------------------------------ */

export interface ToolDefinition {
  id: DetectableTool | 'venv';
  /** 界面上显示的名字 */
  label: string;
  /** 缺了它，哪些功能用不了 */
  neededFor: string;
  /**
   * `version`：跑 `<tool> --version` 取版本号。
   * `capability`：探测"有没有这个能力"（venv 就是这样，它没有版本号，
   * 界面上该显示「可用 / 不可用」而不是「版本未知」）。
   */
  kind: 'version' | 'capability';
  /** 从命令输出里挑版本号用的正则（挑不到就退回"第一行原样显示"） */
  versionPattern: RegExp;
}

/**
 * 工具清单。顺序就是界面上的显示顺序。
 *
 * `venv` 不是独立可执行文件，而是 python 的一个模块，所以单独探
 * （`python -m venv --help`）；没装 python 时它自然是"不可用"，
 * 而不是"没找到 venv.exe"。
 */
export const TOOL_DEFINITIONS: readonly ToolDefinition[] = [
  { id: 'node', label: 'Node.js', neededFor: '前端项目生成与依赖安装', kind: 'version', versionPattern: /v?\d+\.\d+\.\d+/ },
  { id: 'npm', label: 'npm', neededFor: 'Node 依赖安装（官方脚手架也靠它调起）', kind: 'version', versionPattern: /\d+\.\d+\.\d+/ },
  { id: 'pnpm', label: 'pnpm', neededFor: 'Node 依赖安装（检测到就优先用它）', kind: 'version', versionPattern: /\d+\.\d+\.\d+/ },
  { id: 'yarn', label: 'yarn', neededFor: 'Node 依赖安装（备选）', kind: 'version', versionPattern: /\d+\.\d+\.\d+/ },
  { id: 'python', label: 'Python', neededFor: 'FastAPI / Django 项目生成与依赖安装', kind: 'version', versionPattern: /\d+\.\d+\.\d+/ },
  { id: 'pip', label: 'pip', neededFor: 'Python 依赖安装（在虚拟环境里用）', kind: 'version', versionPattern: /\d+\.\d+(\.\d+)?/ },
  { id: 'git', label: 'Git', neededFor: 'M6 的 Git 集成（现在不影响生成项目）', kind: 'version', versionPattern: /\d+\.\d+\.\d+/ },
  { id: 'venv', label: 'Python venv 模块', neededFor: '给 Python 项目建独立虚拟环境', kind: 'capability', versionPattern: /\d+\.\d+\.\d+/ },
];

/** "必需"的工具：缺了它们，连"只生成一个 Node 项目"都做不到 */
export const REQUIRED_TOOLS: readonly string[] = ['node', 'npm'];

export interface DetectedTool {
  id: string;
  label: string;
  kind: 'version' | 'capability';
  found: boolean;
  /** 可执行文件绝对路径（没找到就是 null） */
  path: string | null;
  version: string | null;
  neededFor: string;
  /** 没找到 / 超时 / 读不出版本时的说明（界面上要显示出来，不能只藏在 tooltip 里） */
  note: string | null;
}

export interface EnvironmentSnapshot {
  checkedAt: number;
  /** 应用启动时间（用于判断"环境变量是不是这次启动之后才改的"） */
  appStartedAt: number;
  /** 检测时 PATH 的指纹（只存短哈希，不存整条 PATH） */
  pathFingerprint: string;
  tools: DetectedTool[];
  /** 必需工具是否齐备 */
  ready: boolean;
  missingRequired: string[];
  warnings: string[];
}

/* ------------------------------------------------------------------ */
/* 小工具                                                              */
/* ------------------------------------------------------------------ */

/**
 * 从命令输出里挑版本号。
 *
 * 各家格式不一样（`v24.20.0` / `Python 3.12.1` / `git version 2.43.0.windows.1`），
 * 所以先按工具自己的正则找，找不到就退回"第一行原样显示" ——
 * **宁可显示得难看，也不要显示一个编出来的版本号**。
 */
export function parseVersion(output: string, pattern: RegExp): string | null {
  const text = output.trim();
  if (text.length === 0) return null;
  const matched = pattern.exec(text);
  if (matched) return matched[0].replace(/^v/, '');
  const firstLine = text.split('\n')[0]?.trim();
  return firstLine && firstLine.length > 0 ? firstLine.slice(0, 60) : null;
}

/**
 * PATH 指纹：只用于"变没变"的比较，所以一个短哈希就够，不存明文。
 *
 * 归一化要抹掉**不影响含义**的差异，否则会误报"环境变量改过了"：
 * 大小写（Windows 路径不分大小写）、斜杠方向、每一项结尾多余的反斜杠、空项。
 * 单测就是这么抓出来的 —— 第一版没去掉结尾的 `\`，
 * 于是 `D:\b` 和 `D:\b\` 被当成两次不同的 PATH。
 */
export function fingerprintPath(pathValue: string): string {
  const normalized = pathValue
    .split(';')
    .map((part) => part.trim().toLowerCase().replace(/[\\/]+/g, '\\').replace(/\\+$/, ''))
    .filter((part) => part.length > 0)
    .join(';');

  let hash = 0;
  for (let i = 0; i < normalized.length; i += 1) {
    hash = (hash * 31 + normalized.charCodeAt(i)) | 0;
  }
  return `${(hash >>> 0).toString(16)}-${normalized.length}`;
}

/* ------------------------------------------------------------------ */
/* 检测                                                                */
/* ------------------------------------------------------------------ */

export interface DetectOptions {
  /** 注入执行器（单测用）：不传就是真实 `execFile` */
  exec?: CommandExec;
  /** 注入环境变量（单测用） */
  env?: NodeJS.ProcessEnv;
  /** 注入"文件是否存在"（单测用） */
  exists?: (path: string) => boolean;
  /** 探测命令的工作目录（给一个确定的地方，别在"碰巧在哪"里跑） */
  cwd?: string;
  now?: () => number;
  appStartedAt: number;
}

export async function detectEnvironment(options: DetectOptions): Promise<EnvironmentSnapshot> {
  const env = options.env ?? process.env;
  const exists = options.exists ?? existsSync;
  const now = options.now ?? Date.now;
  const probe = createPathEditorProbe(env, exists);

  /*
   * **全部并行**：8 个工具、每个 5 秒超时，串行最坏要 40 秒，
   * 用户看到的就是"点了没反应"。并行之后最坏 5 秒出结果。
   */
  const tools = await Promise.all(
    TOOL_DEFINITIONS.map(async (definition): Promise<DetectedTool> => {
      const isVenv = definition.id === 'venv';
      const binName = isVenv ? 'python' : definition.id;
      const path = probe.which(binName);
      const base = {
        id: definition.id,
        label: definition.label,
        kind: definition.kind,
        neededFor: definition.neededFor,
      };

      if (!path) {
        return {
          ...base,
          found: false,
          path: null,
          version: null,
          note: isVenv
            ? '没找到 python，venv 自然也谈不上（Python 项目会跳过建虚拟环境）'
            : `PATH 里没有 ${binName}`,
        };
      }

      /*
       * `executePath` 把"这是不是一个 Windows 批处理壳"交给命令白名单判断：
       * npm / pnpm / yarn 在 Windows 上是 `.cmd`，没法直接 spawn，会自动改走 cmd.exe
       * （见 commands.ts 的 BuildCommandOptions）。真正的 `.exe` 走不带 shell 的那条。
       */
      const result = await runCommand(
        isVenv ? 'venv-probe' : 'tool-version',
        { tool: binName as DetectableTool },
        {
          executePath: path,
          ...(options.exec !== undefined ? { exec: options.exec } : {}),
          ...(options.cwd !== undefined ? { cwd: options.cwd } : {}),
          env,
        },
      );

      if (result.timedOut) {
        return {
          ...base,
          found: true,
          path,
          version: null,
          note: `执行超时（${result.durationMs}ms 没返回），这个命令可能卡住了`,
        };
      }

      if (definition.kind === 'capability') {
        // `python -m venv --help` 会打印用法并返回 0；非 0 就是没有 venv 模块
        return {
          ...base,
          found: result.ok,
          path,
          version: null,
          note: result.ok ? null : '这个 Python 没有 venv 模块（可能是精简版安装）',
        };
      }

      /*
       * 命令失败时**不解析版本号**：`parseVersion` 的兜底是"匹配不上就原样显示第一行"，
       * 而失败时的第一行往往是错误信息（`'node' 不是内部或外部命令`）——
       * 把它当版本号显示出去，就成了"编一个版本号"。失败就说失败。
       */
      if (!result.ok) {
        return {
          ...base,
          found: true,
          path,
          version: null,
          note: `取版本号失败（退出码 ${result.code ?? '—'}）：${(result.stderr || result.stdout || '没有任何输出').slice(0, 80)}`,
        };
      }

      const version = parseVersion(result.stdout || result.stderr, definition.versionPattern);
      return {
        ...base,
        found: true,
        path,
        version,
        note: version === null ? '命令有返回，但没读出版本号' : null,
      };
    }),
  );

  const missingRequired = REQUIRED_TOOLS.filter(
    (id) => tools.find((tool) => tool.id === id)?.found !== true,
  );

  const warnings: string[] = [];
  if (missingRequired.length > 0) {
    warnings.push(`缺少必需工具：${missingRequired.join('、')} —— 装好之后点「重新检测环境」`);
  }

  return {
    checkedAt: now(),
    appStartedAt: options.appStartedAt,
    pathFingerprint: fingerprintPath(env.PATH ?? ''),
    tools,
    ready: missingRequired.length === 0,
    missingRequired,
    warnings,
  };
}

/**
 * 缓存里的 PATH 指纹与"当前进程看到的 PATH"不一致，说明用户在这次启动之后改过环境变量 ——
 * Windows 下已运行的进程收不到新 PATH，必须重启才生效。这条提醒必须给。
 */
export function restartHint(snapshot: EnvironmentSnapshot, currentPath: string): string | null {
  if (fingerprintPath(currentPath) === snapshot.pathFingerprint) return null;
  return '环境变量在这次启动之后被改过：新装的工具要**重启本应用**才能检测到（Windows 下已运行的进程读不到新的 PATH）';
}

/* ------------------------------------------------------------------ */
/* 缓存（AppData，不进工作区数据库）                                   */
/* ------------------------------------------------------------------ */

export interface EnvironmentCache {
  version: 1;
  snapshot: EnvironmentSnapshot;
}

export function readEnvironmentCache(file: string): EnvironmentSnapshot | null {
  try {
    if (!existsSync(file)) return null;
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as EnvironmentCache;
    if (parsed.version !== 1 || !Array.isArray(parsed.snapshot?.tools)) return null;
    return parsed.snapshot;
  } catch {
    // 缓存坏了不是错误：当作"还没检测过"，下次检测会覆盖它
    return null;
  }
}

export function writeEnvironmentCache(file: string, snapshot: EnvironmentSnapshot): void {
  mkdirSync(dirname(file), { recursive: true });
  const payload: EnvironmentCache = { version: 1, snapshot };
  writeFileSync(file, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
}
