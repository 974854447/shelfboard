/**
 * 在 PATH 上找一个可执行文件（服务端版本）。
 *
 * 为什么服务端也需要它：跑外部命令时要判断"这是不是一个 Windows 批处理壳"
 * （`.cmd` / `.bat` 没法直接 spawn，得借 `cmd.exe`，见 commands.ts）。
 * 装依赖这一步要选 pnpm 还是 npm、Python 在不在，都要先解析出真实路径。
 *
 * **自己遍历 PATH 而不是调 `where`**：少派生一次进程，而且是纯文件系统逻辑、可直接单测。
 * 桌面端 `main/editor.ts` 里有一份同源的探测（那份还多做了"从 .cmd 反推真实 exe"，
 * 因为编辑器必须拿到 .exe）。两处暂时并存：等哪天要动它们时再合一，
 * 现在合并要连带改编辑器的探测与它的测试，收益不抵风险。
 */

import { existsSync } from 'node:fs';

const DEFAULT_EXTENSIONS = ['.COM', '.EXE', '.BAT', '.CMD'];

export function resolveOnPath(
  command: string,
  env: NodeJS.ProcessEnv = process.env,
  exists: (path: string) => boolean = existsSync,
): string | null {
  const dirs = (env.PATH ?? '').split(';').filter((dir) => dir.length > 0);
  const extensions = (env.PATHEXT ?? DEFAULT_EXTENSIONS.join(';'))
    .split(';')
    .filter((ext) => ext.length > 0);

  const hasExtension = /\.[a-z0-9]+$/i.test(command);
  for (const dir of dirs) {
    const base = dir.replace(/[\\/]+$/, '');
    if (hasExtension) {
      const candidate = `${base}\\${command}`;
      if (exists(candidate)) return candidate;
      continue;
    }
    for (const extension of extensions) {
      const candidate = `${base}\\${command}${extension}`;
      if (exists(candidate)) return candidate;
    }
  }
  return null;
}
