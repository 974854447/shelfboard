/**
 * "这个项目怎么跑起来"（M4：项目启动 / 停止）。
 *
 * ## 为什么是**探测**而不是"记下来"
 *
 * 向导在生成骨架时知道端口与脚本名，但**项目是可以在应用外面被改的**
 * （用户自己换了 vite 端口、加了 npm script、换成 `manage.py` 之外的东西）。
 * 记在数据库里的话，代码改了、应用里还按老配置起 —— 那是最难查的一类问题。
 * 所以每次启动前**从项目文件夹里读**：读到什么就是什么，读不到就如实报"认不出来"。
 *
 * ## 认什么
 *
 * | 目录特征 | 认成 | 启动命令（走命令白名单） |
 * |---|---|---|
 * | `package.json` 有 `scripts.dev` | Vite 前端 | `<pm> run dev` |
 * | `package.json` 有 `scripts.start:dev` | NestJS 后端 | `<pm> run start:dev` |
 * | `manage.py` 且 `.venv` 在 | Django | `.venv/Scripts/python manage.py runserver <port>` |
 * | `app/main.py` + `requirements.txt` | FastAPI | `.venv/Scripts/python -m uvicorn app.main:app --reload --port <port>` |
 *
 * 前后端项目看 `frontend/` 与 `backend/` 两个子目录；单栈项目看项目文件夹根目录。
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

/** 一个可运行的"目标"：一个目标 = 一个进程 */
export interface RunTarget {
  /** 前端 / 后端（单栈项目也只有一条，角色由 codeKind 决定） */
  role: 'frontend' | 'backend';
  /** 相对项目文件夹的目录（'' = 根目录） */
  subdir: string;
  /** 认出来的技术栈（给界面显示与日志用） */
  kind: 'vite' | 'nest' | 'django' | 'fastapi';
  kindLabel: string;
  /**
   * 对应的**模板 id**（`vue3` / `react` / `nestjs` / `fastapi` / `django`）。
   *
   * "装依赖"那个作业是按模板 id 决定"装到哪个子目录、用 Node 还是 Python"的，
   * 所以这件事必须由**服务端探测**给出，不能让界面按 kind 猜
   * （猜错的结果是"给 Vue 项目装了 FastAPI 的依赖"）。
   */
  templateId: 'vue3' | 'react' | 'nestjs' | 'fastapi' | 'django';
  /** 用哪条命令白名单 spec 启动 */
  specId: 'run-node-dev' | 'run-python-uvicorn' | 'run-django-runserver';
  /** 命令的值位（包管理器 / 脚本名 / 端口 …） */
  values: Record<string, string>;
  /** 默认端口（界面显示，用户可以在启动前改） */
  port: number;
  /** 依赖装好没有（没装就别启动，报清楚原因） */
  ready: boolean;
  /** 没准备好的原因（`ready: false` 时一定有） */
  problem?: string;
}

export interface DetectRunResult {
  targets: RunTarget[];
  /** 整体认不出来的原因（例：纯管理项目、目录里没有可运行入口） */
  problems: string[];
}

const NODE_PORT_DEFAULT = { vite: 5173, nest: 3000 } as const;

/** 从 `vite.config.*` 里读 `server.port`（我们生成的骨架与官方脚手架都写这一行） */
function readVitePort(dir: string): number | null {
  const candidates = readdirSync(dir).filter((name) => /^vite\.config\.[cm]?[jt]s$/.test(name));
  for (const name of candidates) {
    const text = readFileSync(join(dir, name), 'utf8');
    // `server: { port: 5173 }` / `port: 8123,` —— 只认 `port:` 后面那个数字
    const match = /(?:^|[\s{,])port\s*:\s*(\d{2,5})/m.exec(text);
    if (match?.[1]) return Number(match[1]);
  }
  return null;
}

/** 从 `.env` / `.env.example` 里读 `PORT=`（我们生成的 Python 骨架会写） */
function readEnvPort(dir: string): number | null {
  for (const name of ['.env', '.env.example']) {
    const file = join(dir, name);
    if (!existsSync(file)) continue;
    const match = /^\s*PORT\s*=\s*(\d{2,5})\s*$/m.exec(readFileSync(file, 'utf8'));
    if (match?.[1]) return Number(match[1]);
  }
  return null;
}

function readPackageJson(
  dir: string,
): { scripts: Record<string, string>; deps: Record<string, string> } | null {
  const file = join(dir, 'package.json');
  if (!existsSync(file)) return null;
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as {
      scripts?: Record<string, string>;
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    return {
      scripts: parsed.scripts ?? {},
      deps: { ...(parsed.dependencies ?? {}), ...(parsed.devDependencies ?? {}) },
    };
  } catch {
    // package.json 坏了 = 认不出来（而不是"跑一个猜的命令"）
    return null;
  }
}

/** 虚拟环境里的 python（Windows 与 POSIX 两套目录名） */
function venvPython(dir: string): string | null {
  const win = '.venv\\Scripts\\python.exe';
  const posix = '.venv/bin/python';
  if (existsSync(join(dir, '.venv', 'Scripts', 'python.exe'))) return win;
  if (existsSync(join(dir, '.venv', 'bin', 'python'))) return posix;
  return null;
}

function detectNodeTarget(dir: string, role: 'frontend' | 'backend'): RunTarget | null {
  const pkg = readPackageJson(dir);
  if (!pkg) return null;

  const isNest = existsSync(join(dir, 'nest-cli.json')) || pkg.scripts['start:dev'] !== undefined;
  /*
   * Vue 还是 React：看依赖里有没有 react。认错的后果很具体 ——
   * "装依赖"是按模板 id 决定装到哪个子目录的，认错就会给 Vue 项目装 FastAPI 的依赖。
   */
  const isReact = Object.keys(pkg.deps).some((name) => name === 'react' || name === 'react-dom');
  const templateId = isNest ? 'nestjs' : isReact ? 'react' : 'vue3';
  const script = isNest
    ? pkg.scripts['start:dev'] !== undefined
      ? 'start:dev'
      : 'start'
    : pkg.scripts.dev !== undefined
      ? 'dev'
      : pkg.scripts.start !== undefined
        ? 'start'
        : null;

  const kind = isNest ? 'nest' : 'vite';
  const port = (isNest ? null : readVitePort(dir)) ?? NODE_PORT_DEFAULT[kind];
  const hasModules = existsSync(join(dir, 'node_modules'));

  if (script === null) {
    return {
      role,
      subdir: dir,
      kind,
      kindLabel: isNest ? 'NestJS' : 'Node',
      templateId,
      specId: 'run-node-dev',
      values: {},
      port,
      ready: false,
      problem: 'package.json 里没有 dev / start / start:dev 脚本，不知道该怎么启动',
    };
  }

  return {
    role,
    subdir: dir,
    kind,
    kindLabel: isNest ? 'NestJS' : isReact ? 'React' : 'Vite',
    templateId,
    specId: 'run-node-dev',
    values: { script },
    port,
    ready: hasModules,
    ...(hasModules ? {} : { problem: '还没装依赖（没有 node_modules）—— 先跑一次「安装依赖」' }),
  };
}

function detectPythonTarget(dir: string, role: 'frontend' | 'backend'): RunTarget | null {
  const python = venvPython(dir);
  const hasVenv = python !== null;

  if (existsSync(join(dir, 'manage.py'))) {
    return {
      role,
      subdir: dir,
      kind: 'django',
      kindLabel: 'Django',
      templateId: 'django',
      specId: 'run-django-runserver',
      values: { port: String(readEnvPort(dir) ?? 8000) },
      port: readEnvPort(dir) ?? 8000,
      ready: hasVenv,
      ...(hasVenv ? {} : { problem: '还没建虚拟环境（没有 .venv）—— 先跑一次「安装依赖」' }),
    };
  }

  if (existsSync(join(dir, 'app', 'main.py')) && existsSync(join(dir, 'requirements.txt'))) {
    const port = readEnvPort(dir) ?? 8000;
    return {
      role,
      subdir: dir,
      kind: 'fastapi',
      kindLabel: 'FastAPI',
      templateId: 'fastapi',
      specId: 'run-python-uvicorn',
      values: { port: String(port) },
      port,
      ready: hasVenv,
      ...(hasVenv ? {} : { problem: '还没建虚拟环境（没有 .venv）—— 先跑一次「安装依赖」' }),
    };
  }

  return null;
}

/**
 * 探测一个项目该怎么启动。
 *
 * `codeKind` 决定这次探测**该不该做**：纯管理项目（`codeKind === null`）没有代码，
 * 永远不返回目标 —— 界面上也就不会出现启动按钮（用户明确要求"只有前端/后端/前后端有"）。
 */
export function detectRunTargets(
  projectFolder: string,
  codeKind: string | null,
): DetectRunResult {
  if (codeKind === null || codeKind === '') {
    return { targets: [], problems: ['纯管理项目没有代码，不需要启动'] };
  }

  const problems: string[] = [];
  const targets: RunTarget[] = [];

  const roles: Array<'frontend' | 'backend'> =
    codeKind === 'fullstack' ? ['frontend', 'backend'] : codeKind === 'frontend' ? ['frontend'] : ['backend'];

  for (const role of roles) {
    // 双栈看子目录，单栈看项目根目录（与脚手架落盘规则一致）
    const dir =
      codeKind === 'fullstack' ? join(projectFolder, role === 'frontend' ? 'frontend' : 'backend') : projectFolder;

    if (!existsSync(dir)) {
      problems.push(
        codeKind === 'fullstack'
          ? `没找到 ${role === 'frontend' ? 'frontend/' : 'backend/'} 目录`
          : '项目文件夹不存在',
      );
      continue;
    }

    const target = detectNodeTarget(dir, role) ?? detectPythonTarget(dir, role);
    if (target === null) {
      problems.push(
        `在 ${codeKind === 'fullstack' ? (role === 'frontend' ? 'frontend/' : 'backend/') : '项目根目录'} 里` +
          '没找到认得的入口（package.json / manage.py / app/main.py）',
      );
      continue;
    }
    // 相对路径：命令的 cwd 是项目文件夹，值位里不能出现绝对路径
    targets.push({
      ...target,
      subdir: codeKind === 'fullstack' ? (role === 'frontend' ? 'frontend' : 'backend') : '',
      values: {
        ...target.values,
        ...(target.specId === 'run-python-uvicorn' || target.specId === 'run-django-runserver'
          ? { python: venvPython(dir) ?? '.venv\\Scripts\\python.exe' }
          : {}),
      },
    });
  }

  if (targets.length === 0 && problems.length === 0) problems.push('没有认出可启动的目标');
  return { targets, problems };
}
