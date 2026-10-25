/**
 * 版本选择：把"用户选的那一版"**真的写进生成出来的依赖清单**。
 *
 * ## 为什么不交给官方脚手架
 *
 * 官方脚手架永远给"它模板里那一版"（通常是 latest）：
 * `create-vue` 最多支持 `--vue-rc`，`create-vite` 连这个都没有。
 * 想锁「React 18.3」「Django 4.2 LTS」这类版本，**只有我们自己改生成出来的清单**才做得到。
 *
 * ## 两条路径共用这一段代码
 *
 * 官方脚手架与内置回退骨架生成完之后都跑一次这里，于是：
 * - "选了 18 却拿到 19"这种不一致不会出现（不一致是那种最难查的问题：日志说成功、代码不对）；
 * - 依赖清单里**没有**这个包时，我们**如实说"跳过"**，而不是偷偷加一条（加一条等于替用户改依赖树）。
 *
 * ## 只动两个文件
 *
 * `package.json`（Node 栈）与 `requirements.txt`（Python 栈）。不认识的清单格式一律不碰 ——
 * 这个模块是"改版本号"，不是"生成项目"。
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export interface ApplyVersionsOptions {
  /** 包名 → 版本描述（Node：`^19.0.0`；Python：`>=4.2,<5`、`==0.141.*`） */
  pins: Record<string, string>;
  /** 写进 `package.json` 的 `engines.node`（Node 栈才有） */
  enginesNode?: string;
  installKind: 'node' | 'python' | 'none';
}

export interface ApplyVersionsResult {
  /** 真的改掉的条目（`包名 旧 → 新` 或 `engines.node`），写进作业日志当证据 */
  changed: string[];
  /** 想改但没找到的（如实说出来，不静默） */
  skipped: string[];
}

type PackageJson = {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  engines?: Record<string, string>;
  [key: string]: unknown;
};

/** 包名→版本描述：把 npm 上常见的"scope/名字"写法统一成小写比较（`@NestJS/Core` 也认） */
function samePackage(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

/**
 * 改 Node 的 `package.json`。
 *
 * 只覆盖**已经存在**的那条依赖所在的段（dependencies 或 devDependencies）：
 * 把 `vite` 从 devDependencies 挪到 dependencies 是"改依赖树"，不是"改版本"，不该由这里做。
 */
function applyNodePins(dir: string, options: ApplyVersionsOptions): ApplyVersionsResult {
  const file = join(dir, 'package.json');
  const changed: string[] = [];
  const skipped: string[] = [];

  if (!existsSync(file)) {
    return {
      changed,
      skipped: [
        ...Object.keys(options.pins).map((name) => `${name}（没有 package.json，无法写入版本）`),
        ...(options.enginesNode ? ['engines.node（没有 package.json）'] : []),
      ],
    };
  }

  let manifest: PackageJson;
  const original = readFileSync(file, 'utf8');
  try {
    manifest = JSON.parse(original) as PackageJson;
  } catch {
    /*
     * 清单坏了就**不动它**：这时候最该做的是让用户看到问题，
     * 而不是把一个解析不了的 package.json 换成我们"顺手生成"的一份。
     */
    return {
      changed,
      skipped: [`package.json 解析失败（${file}），没有写入任何版本`],
    };
  }

  for (const [name, spec] of Object.entries(options.pins)) {
    let found = false;
    for (const section of ['dependencies', 'devDependencies'] as const) {
      const block = manifest[section];
      if (!block) continue;
      const key = Object.keys(block).find((item) => samePackage(item, name));
      if (!key) continue;
      if (block[key] !== spec) {
        changed.push(`${key} ${block[key]} → ${spec}`);
        block[key] = spec;
      }
      found = true;
      break;
    }
    if (!found) skipped.push(`${name}（package.json 里没有这条依赖）`);
  }

  if (options.enginesNode) {
    const engines = manifest.engines ?? {};
    const current = engines.node;
    if (current === undefined) {
      changed.push(`engines.node (未设置) → ${options.enginesNode}`);
      engines.node = options.enginesNode;
      manifest.engines = engines;
    } else if (current !== options.enginesNode) {
      /*
       * 清单里**已经有**引擎要求时不动它，只如实说明。
       *
       * 原因很具体：`create-vue` 会写 `^22.18.0 || >=24.12.0`（它自己那套工具链的要求），
       * 而我们声明的是 `^20.19.0 || >=22.12.0` —— 照我们的写就等于**把要求放宽**，
       * 于是 Node 20 的机器也能装上一个跑不起来的项目。官方比我们更清楚自己需要什么，
       * 所以这一条只对"没有声明过"的项目（内置回退骨架）生效。
       */
      skipped.push(`engines.node（清单里已有 ${current}，不覆盖）`);
    }
  }

  if (changed.length > 0) {
    // 保持 2 空格缩进与结尾换行（跟官方脚手架生成的样子一致，diff 才干净）
    writeFileSync(file, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  }
  return { changed, skipped };
}

/**
 * 改 Python 的 `requirements.txt`。
 *
 * 只替换**版本描述那一段**，保留包名写法（含 extras，例 `uvicorn[standard]`）与注释：
 * 我们改的是版本，不是依赖列表。
 */
function applyPythonPins(dir: string, options: ApplyVersionsOptions): ApplyVersionsResult {
  const file = join(dir, 'requirements.txt');
  const changed: string[] = [];
  const skipped: string[] = [];

  if (!existsSync(file)) {
    return {
      changed,
      skipped: Object.keys(options.pins).map((name) => `${name}（没有 requirements.txt，无法写入版本）`),
    };
  }

  const lines = readFileSync(file, 'utf8').split('\n');
  const lines2 = lines.map((line) => {
    const trimmed = line.trim();
    if (trimmed.length === 0 || trimmed.startsWith('#')) return line;

    // 包名后面可以跟 extras 与版本描述：`uvicorn[standard]>=0.32`
    const match = /^([A-Za-z0-9._-]+)(\[[^\]]*\])?\s*(.*)$/.exec(trimmed);
    if (!match) return line;
    const [, name, extras = '', current = ''] = match;

    const pinned = Object.entries(options.pins).find(([key]) => samePackage(key, name ?? ''));
    if (!pinned) return line;
    if (current === pinned[1]) return line;

    changed.push(`${name}${extras} ${current || '(未锁版本)'} → ${pinned[1]}`);
    return `${name}${extras}${pinned[1]}`;
  });

  for (const name of Object.keys(options.pins)) {
    if (!lines2.some((line) => samePackage(line.replace(/^([A-Za-z0-9._-]+).*$/, '$1'), name))) {
      skipped.push(`${name}（requirements.txt 里没有这条依赖）`);
    }
  }

  if (changed.length > 0) writeFileSync(file, lines2.join('\n'), 'utf8');
  return { changed, skipped };
}

/** 按用户的选择改依赖清单里的版本；返回改了哪些（给日志当证据） */
export function applyVersionPins(dir: string, options: ApplyVersionsOptions): ApplyVersionsResult {
  if (options.installKind === 'python') return applyPythonPins(dir, options);
  if (options.installKind === 'node') return applyNodePins(dir, options);
  return { changed: [], skipped: [] };
}
