/**
 * 「用编辑器打开项目」：把偏好里的编辑器命令解析成一个**可以直接 spawn 的可执行文件**。
 *
 * ## 为什么不能直接 spawn 用户给的命令
 *
 * 这是应用里少见的"执行外部程序"的口子，两条纪律：
 *
 * 1. **白名单**。偏好里的字符串不会被当成命令执行，只会在白名单里查表 ——
 *    否则用户（或任何能改配置的东西）就能让应用跑任意程序。
 * 2. **解析成 .exe 绝对路径，并且 `shell: false`**。绝不把命令拼成字符串交给 shell：
 *    项目文件夹名里带个 `&` 或空格，拼字符串就会变成"执行另一条命令"。
 *
 * ## 为什么不能直接用 PATH 上的 `code`
 *
 * Windows 上 `code` 是 `code.cmd`（批处理壳）。批处理**没法用 `shell: false` 启动**，
 * 而为了它打开 shell 就等于把上面第 2 条作废。所以这里从 `.cmd` 的位置反推真实 exe
 * （VS Code 的布局是 `bin\code.cmd` 与 `Code.exe` 同级/上一级），只 spawn `.exe`。
 */

import { existsSync } from 'node:fs';

export interface EditorProbe {
  /** 在 PATH 上查找命令，返回绝对路径；找不到返回 null */
  which(command: string): string | null;
  /** 路径是否存在 */
  exists(path: string): boolean;
}
export type EditorResolution =
  | { ok: true; command: string; exe: string }
  | { ok: false; command: string; reason: string };

/** 允许被启动的编辑器命令（小写比较）。想加新编辑器就加在这里。 */
export const ALLOWED_EDITOR_COMMANDS = [
  'code',
  'code-insiders',
  'cursor',
  'windsurf',
  'webstorm',
  'idea',
  'subl',
  'notepad++',
] as const;

/** 命令名 → 常见的 exe 文件名（用于从 .cmd 反推真实 exe） */
const EXE_NAME_BY_COMMAND: Record<string, string> = {
  code: 'Code.exe',
  'code-insiders': 'Code - Insiders.exe',
  cursor: 'Cursor.exe',
  windsurf: 'Windsurf.exe',
  subl: 'sublime_text.exe',
  'notepad++': 'notepad++.exe',
};

/** 命令名 → Windows 上的常见安装位置（%LOCALAPPDATA% / %ProgramFiles% 前缀由调用方展开） */
const WELL_KNOWN_SUFFIXES: Record<string, string[]> = {
  code: ['Programs\\Microsoft VS Code\\Code.exe'],
  'code-insiders': ['Programs\\Microsoft VS Code Insiders\\Code - Insiders.exe'],
  cursor: ['Programs\\cursor\\Cursor.exe'],
  windsurf: ['Programs\\windsurf\\Windsurf.exe'],
};

export interface ResolveOptions {
  /** 展开 %LOCALAPPDATA% / %ProgramFiles% 等前缀，便于测试注入 */
  expand?: (path: string) => string;
}

/**
 * 在 PATH 上找命令。
 *
 * **自己遍历 PATH 而不是调 `where`**：一是少一次派生进程（受限环境里"捕获子进程输出"
 * 恰恰是最容易被挡住的），二是纯文件系统逻辑可以直接单测。Windows 的 PATH 是
 * 分号分隔、扩展名由 PATHEXT 决定，两条都照着来。
 */
export function createPathEditorProbe(
  env: NodeJS.ProcessEnv = process.env,
  exists: (path: string) => boolean = existsSync,
): EditorProbe {
  const dirs = (env.PATH ?? '').split(';').filter((d) => d.length > 0);
  const extensions = (env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD')
    .split(';')
    .filter((e) => e.length > 0)
    .map((e) => e.toLowerCase());

  return {
    which(command: string): string | null {
      const hasExtension = /\.[a-z0-9]+$/i.test(command);
      for (const dir of dirs) {
        if (hasExtension) {
          const candidate = `${dir.replace(/[\\/]$/, '')}\\${command}`;
          if (exists(candidate)) return candidate;
          continue;
        }
        for (const extension of extensions) {
          const candidate = `${dir.replace(/[\\/]$/, '')}\\${command}${extension}`;
          if (exists(candidate)) return candidate;
        }
      }
      return null;
    },
    exists,
  };
}

/** 展开 `%NAME%` 形式的环境变量（只用给定的 env，便于测试） */
export function expandEnvVars(
  template: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  return template.replace(/%([^%]+)%/g, (whole, name: string) => env[name] ?? whole);
}

/**
 * 把偏好里的命令解析成可执行文件。
 *
 * 依次尝试：PATH 上的 `<cmd>.exe` → PATH 上 `<cmd>`（是 .exe 就用；是 .cmd/.bat 则由它反推
 * 同目录/上一级的 `<Name>.exe`）→ 几个常见安装位置。
 */
export function resolveEditorExecutable(
  preference: string | undefined,
  probe: EditorProbe,
  options: ResolveOptions = {},
): EditorResolution {
  const command = (preference ?? '').trim() || 'code';
  const key = command.toLowerCase();

  if (!(ALLOWED_EDITOR_COMMANDS as readonly string[]).includes(key)) {
    return {
      ok: false,
      command,
      reason: `「${command}」不在允许的编辑器列表内（可用：${ALLOWED_EDITOR_COMMANDS.join(' / ')}）`,
    };
  }

  // 1) PATH 上直接有 exe
  const direct = probe.which(`${command}.exe`) ?? probe.which(`${command}.EXE`);
  if (direct && probe.exists(direct)) return { ok: true, command, exe: direct };

  // 2) PATH 上有同名命令：可能是 .cmd 壳，从它反推真实 exe
  const onPath = probe.which(command);
  if (onPath) {
    if (/\.(exe|com)$/i.test(onPath) && probe.exists(onPath)) {
      return { ok: true, command, exe: onPath };
    }
    const dir = onPath.replace(/[\\/][^\\/]*$/, '');
    const parent = dir.replace(/[\\/][^\\/]*$/, '');
    const exeName = EXE_NAME_BY_COMMAND[key];
    const guessed = [
      ...(exeName ? [`${parent}\\${exeName}`, `${dir}\\${exeName}`] : []),
      // 退一步：同级目录里唯一那个 .exe 也认（避免为了一个名字差异就用不了）
      `${parent}\\${exeName ?? ''}`,
    ].filter((p) => p.length > 0 && probe.exists(p));
    if (guessed[0]) return { ok: true, command, exe: guessed[0] };
  }

  // 3) 常见安装位置
  const expand = options.expand ?? ((p: string) => p);
  for (const suffix of WELL_KNOWN_SUFFIXES[key] ?? []) {
    for (const root of ['%LOCALAPPDATA%', '%ProgramFiles%', '%ProgramFiles(x86)%']) {
      const candidate = expand(`${root}\\${suffix}`);
      if (probe.exists(candidate)) return { ok: true, command, exe: candidate };
    }
  }

  return {
    ok: false,
    command,
    reason: `没找到编辑器的可执行文件（命令：${command}）。确认它装在默认位置，或把偏好里的编辑器命令改成已安装的那个`,
  };
}
