/**
 * 把向导里选的端口**真的写进生成出来的配置**（M4）。
 *
 * ## 为什么需要它
 *
 * 向导里有一个端口输入框，用户以为它生效了。但：
 * - **内置模板**会把端口写进生成的文件（`server: { port: __PORT__ }`、`await app.listen(__PORT__)`）；
 * - **官方脚手架**不会 —— `create-vue` / `create-vite` 生成的 `vite.config.ts` 里**没有** port，
 *   `nest new` 生成的 `main.ts` 里是 `process.env.PORT ?? 3000`。
 *
 * 于是走官方路径时用户填的端口被**默默忽略**（项目实际跑在 5173 / 3000）。
 * 这属于"界面说了却没做"，必须补上：**官方脚手架生成完之后，我们自己把端口写进去**。
 *
 * ## 只碰三个位置，而且都是保守替换
 *
 * | 文件 | 怎么改 |
 * |---|---|
 * | `vite.config.*` | 有 `server.port` → 改数字；有 `server` → 插 `port`；都没有 → 在 `defineConfig({` 后插一整块 `server: { port }` |
 * | `src/main.ts`（NestJS） | `app.listen(process.env.PORT ?? 3000)` 或 `app.listen(3000)` → 把数字换成用户选的 |
 *
 * 刻意**不做**"重新格式化整个文件"：那是把用户（和我们）生成出来的代码交给正则重写。
 * 改不动就**如实报**（`skipped`），绝不半改。
 */

import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export interface ApplyPortOptions {
  /** 项目（或某个栈的子目录）的绝对路径 */
  dir: string;
  /** 用户选的端口 */
  port: number;
}

export interface ApplyPortResult {
  /** 改了什么（写进作业日志当证据） */
  changed: string[];
  /** 没改成的原因（认不出技术栈 / 找不到那个文件） */
  skipped: string[];
}

/** 认一下这个目录是哪种配置：Vite 还是 NestJS（都不是就什么都不做） */
function findViteConfig(dir: string): string | null {
  const candidates = readdirSync(dir).filter((name) => /^vite\.config\.[cm]?[jt]s$/.test(name));
  return candidates[0] ?? null;
}

function applyVitePort(dir: string, file: string, port: number): ApplyPortResult {
  const path = join(dir, file);
  const before = readFileSync(path, 'utf8');
  let after: string;
  let how: string;

  /*
   * 1) 已经有 `server: { … port: N … }` —— 只换数字。
   *    注意要**限定在 server 块内**，否则会把 `preview: { port }` 之类的也改掉。
   */
  const serverBlock = /server\s*:\s*\{([\s\S]*?)\}/.exec(before);
  if (serverBlock && /port\s*:\s*\d+/.test(serverBlock[1] ?? '')) {
    const replaced = before.replace(
      /(server\s*:\s*\{[\s\S]*?port\s*:\s*)\d+/,
      (_whole, head: string) => `${head}${port}`,
    );
    after = replaced;
    how = 'server.port 改成用户选的端口';
  } else if (serverBlock) {
    // 2) 有 server 块但没有 port —— 往块里插一行
    after = before.replace(/(server\s*:\s*\{)/, (_whole, head: string) => `${head}\n    port: ${port},`);
    how = 'server 块里补上 port';
  } else {
    // 3) 完全没有 server —— 在 `defineConfig({` 之后插一整块
    const anchor = /defineConfig\s*\(\s*\{/.exec(before);
    if (!anchor) {
      return { changed: [], skipped: [`${file}：没找到 defineConfig({ … })，没有写入端口`] };
    }
    after = before.replace(
      /(defineConfig\s*\(\s*\{)/,
      (_whole, head: string) => `${head}\n  server: { port: ${port} },`,
    );
    how = '插入 server: { port }';
  }

  if (after === before) return { changed: [], skipped: [`${file}：端口已经是 ${port}，没有改动`] };
  writeFileSync(path, after, 'utf8');
  return { changed: [`${file}：${how} → ${port}`], skipped: [] };
}

function applyNestPort(dir: string, port: number): ApplyPortResult {
  const path = join(dir, 'src', 'main.ts');
  if (!existsSync(path)) {
    return { changed: [], skipped: ['src/main.ts 不存在，没有写入端口'] };
  }
  const before = readFileSync(path, 'utf8');

  // `app.listen(process.env.PORT ?? 3000)` / `app.listen(3000)` —— 只换里面的数字
  const listen = /app\.listen\(([^)]*)\)/.exec(before);
  if (!listen) {
    return { changed: [], skipped: ['src/main.ts 里没找到 app.listen(...)，没有写入端口'] };
  }
  const args = listen[1] ?? '';
  if (!/\d+/.test(args)) {
    return { changed: [], skipped: ['app.listen(...) 里没有默认端口，没有写入端口'] };
  }

  const after = before.replace(/(app\.listen\([^)]*?)(\d+)/, (_whole, head: string) => `${head}${port}`);
  if (after === before) return { changed: [], skipped: [`src/main.ts：端口已经是 ${port}`] };
  writeFileSync(path, after, 'utf8');
  return { changed: [`src/main.ts：app.listen 的默认端口 → ${port}`], skipped: [] };
}

/**
 * 把端口写进这个目录里的开发配置。
 *
 * 认不出技术栈就**什么也不做**并说明原因 —— 宁可"什么都不改 + 说清楚"，
 * 也不要在一个不认识的项目里乱改文件。
 */
export function applyPortToConfig(options: ApplyPortOptions): ApplyPortResult {
  const { dir, port } = options;
  if (!existsSync(dir)) return { changed: [], skipped: [`目录不存在：${dir}`] };
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    return { changed: [], skipped: [`端口不合法（${port}），没有写入`] };
  }

  const viteConfig = findViteConfig(dir);
  if (viteConfig) return applyVitePort(dir, viteConfig, port);

  const hasNest =
    existsSync(join(dir, 'nest-cli.json')) || existsSync(join(dir, 'src', 'main.ts'));
  if (hasNest) return applyNestPort(dir, port);

  return {
    changed: [],
    skipped: ['这里不是 Vite / NestJS 项目（Python 侧的端口由启动命令传，不需要写进配置）'],
  };
}
