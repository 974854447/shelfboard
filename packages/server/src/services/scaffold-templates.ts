/**
 * 内置模板（M4 脚手架的回退路径）。
 *
 * ## 模板内容放在代码里，不放目录
 *
 * 技术设计 §5.5 原来写的是"模板目录 + `asarUnpack`"。落地时改成**把模板写成代码里的字符串**，
 * 理由有三条：
 *
 * 1. **不必再管打包路径**：目录形式的模板在 asar 里可能读不到，要么 `asarUnpack`、
 *    要么运行时把资源拷出来 —— 都是"打包后才发现"的坑，而字符串不存在这个问题；
 * 2. **可审计**：模板内容进代码仓库、能 review、能 diff（用户选"开发期固化模板"要的就是这个）；
 * 3. **点文件不再需要改名技巧**：目录里放 `.gitignore` 常被工具吞掉，所以原设计要在
 *    渲染时把 `_gitignore` 改回 `.gitignore`；直接写字符串就不需要这套映射。
 *
 * ## 来源与许可
 *
 * - `fastapi`：按 FastAPI 官方文档「Bigger Applications」推荐的目录结构**手写**的最小骨架。
 *   刻意没有整份搬 `fastapi/full-stack-fastapi-template` —— 那个模板带 Docker / Postgres /
 *   JWT / Alembic，对一个本地项目管理工具来说是把用户拖进一堆用不上的东西。
 * - `vue3-ts`：官方 `create-vue` 的**回退**。正常情况下应该走官方脚手架（`npm create vue@latest`），
 *   只有在官方调用失败（断网 / 参数变动）时才用它 —— 所以它只要"能跑起来的最小骨架"，
 *   不是 create-vue 的完整复刻。
 *
 * 模板里**不允许出现可执行脚本**（`postinstall` 之类一律禁止）：模板是数据，不是代码。
 */

import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

export interface TemplateFile {
  /** 相对目标目录的路径（用 `/` 分隔，写入时按平台转换）。可含 `__EXT__`（ts/js） */
  path: string;
  content: string;
  /**
   * 只在满足条件时才写这个文件（例：`tsconfig.json` 只在 TypeScript 模式下写）。
   *
   * 有了它，TypeScript / JavaScript 两种模式可以**共用同一份文件清单**，
   * 不必维护两套几乎相同的模板 —— 两套的下场一定是"改了一边忘了另一边"。
   */
  when?: (vars: TemplateVars) => boolean;
}

export interface TemplateVars {
  projectName: string;
  /** 包名/目录名（ASCII 安全名，用作 npm 包名） */
  packageName: string;
  /**
   * Python 的模块名（**不能带横杠**：`my-app` 不是合法标识符，
   * 而 Django 的 settings 模块名必须能用 import 写出来）。
   */
  moduleName: string;
  port: number;
  /** 前端语言（内置回退骨架跟着用户选的语言走，不能"选了 JS 却给一份 TS"） */
  language: 'ts' | 'js';
  /** 语言对应的扩展名，模板路径与少数内容里用 `__EXT__` 占位 */
  ext: 'ts' | 'js';
}

/**
 * 「维度」：一个技术栈还能再分开选的那些东西。
 *
 * 为什么把它做成**声明式数据**（而不是在界面上写死几个控件）：
 * 界面要按"这个栈到底支持什么"来渲染 —— `create-vue` 支持 Router / Pinia / Prettier，
 * `create-vite` 只支持 ESLint 与模板名，内置的 FastAPI / Django 骨架什么都没有。
 * 写死控件的下场是：某个栈下面挂着一个"点了也没用"的开关，
 * 而用户会以为自己选错了什么（这种情况比没有这个开关更糟）。
 */
export interface DimensionChoice {
  id: string;
  label: string;
  /** 灰字说明：对着官方脚手架的真实参数说，不写广告词 */
  hint?: string;
  /** 选中后追加到官方命令行的参数（例 `['--router']`、`['--template','react-ts']`） */
  args: string[];
  /**
   * 版本类选项：把生成出来的依赖清单改成这些版本。
   *
   * 为什么不靠官方脚手架自己写：官方永远给"它模板里的那一版"（通常是 latest），
   * 用户想锁 4.2 LTS 之类的时候，**只有我们自己改生成出来的清单**才做得到。
   * 官方路径与内置回退路径都走同一段代码（`applyVersionPins`），
   * 于是"选了 18 却拿到 19"这种不一致不会出现。
   */
  pins?: Record<string, string>;
}

export interface TemplateDimension {
  id: 'language' | 'addons' | 'version';
  label: string;
  /** `choice` = 单选（下拉/分段）；`multi` = 多选（一组开关） */
  kind: 'choice' | 'multi';
  defaultValue: string | string[];
  choices: DimensionChoice[];
}

export interface TemplateDescriptor {
  id: string;
  /** 显示名 = 框架名（`Vue 3` / `React`），语言与附加项由 dimensions 决定 */
  name: string;
  kind: 'frontend' | 'backend';
  /** 官方有脚手架吗？没有就只能用内置模板 */
  source: 'official' | 'builtin';
  /** 走官方脚手架时用哪条命令 spec */
  officialSpec?: 'scaffold-npm-create' | 'scaffold-nest-new' | 'scaffold-django';
  /** 官方脚手架对应的包（`npm create <pkg>`） */
  officialPackage?: string;
  /** 这个模板装依赖要用什么 */
  installKind: 'node' | 'python' | 'none';
  /** 官方脚手架失败时回退到哪个内置模板（不填就是没有回退） */
  fallbackTemplateId?: string;
  /**
   * 这个栈默认跑在哪个端口。
   *
   * 每个栈的惯例不一样（Vite 5173、NestJS 3000、uvicorn/runserver 8000），
   * 所以不能用一个全局默认值 —— 那样生成出来的项目第一个命令就会撞端口。
   * 向导会用它作为输入框的初值，用户可改。**前后端各一个**（双栈时共用一个必然撞号）。
   */
  defaultPort: number;
  /** 语言标签：没有"语言"这个维度时用它静态显示（Python / TypeScript） */
  languageLabel: string;
  /**
   * 这个栈对 Node 的要求（写进生成出来的 `package.json` 的 `engines.node`）。
   *
   * 数字来自工具链自己的声明（例：Vite 8 要求 `^20.19.0 || >=22.12.0`），
   * 不是我们拍脑袋定的 —— 写错的引擎要求比不写更糟（用户会照着升/降 Node）。
   */
  enginesNode?: string;
  /** 可选维度；空数组 = 这个栈没有可选项（界面上就不出现任何控件） */
  dimensions: TemplateDimension[];
}

/**
 * 这一版支持的五个技术栈。
 *
 * 顺序就是向导里的显示顺序：Vue 3 → React → NestJS → FastAPI → Django。
 *
 * ## 为什么把「语言」「附加项」拆成维度
 *
 * 原来一个栈就是一个写死的名字（`Vue 3 + TS + Vite`），等于**替用户把细节全定了**：
 * 想要 JavaScript、不想要 Prettier 都无从表达。现在每条栈声明自己支持哪些维度，
 * 向导照着渲染、服务端照着拼官方参数 —— 参数表是**探测出来的**（`--help`），
 * 声明只是"我们要什么"，两者对上才真的调用。
 */
export const TEMPLATES: readonly TemplateDescriptor[] = [
  {
    id: 'vue3',
    name: 'Vue 3',
    kind: 'frontend',
    source: 'official',
    officialSpec: 'scaffold-npm-create',
    officialPackage: 'vue@latest',
    installKind: 'node',
    fallbackTemplateId: 'vue3',
    defaultPort: 5173,
    languageLabel: 'TypeScript / JavaScript',
    /*
     * 引擎要求取自工具链自己的声明（当前 Vite 8 要求 ^20.19.0 || >=22.12.0）。
     * 内置回退骨架里的 Vite 版本更保守（^6），但**声明更严的那个**是安全的：
     * 满足它的机器两条路都能跑，反过来就不一定。
     */
    enginesNode: '^20.19.0 || >=22.12.0',
    dimensions: [
      {
        id: 'language',
        label: '语言',
        kind: 'choice',
        defaultValue: 'ts',
        choices: [
          { id: 'ts', label: 'TypeScript', hint: 'create-vue --ts', args: ['--ts'] },
          {
            id: 'js',
            label: 'JavaScript',
            hint: '不带 --ts；没有任何附加项时会改用 Vite 官方模板',
            args: [],
          },
        ],
      },
      {
        /*
         * 版本：stable 就是官方 latest（当前 3.5.x），rc 走 create-vue 的 `--vue-rc`。
         * 版本号写进生成出来的 `package.json`（两条路径都改），
         * 所以"选了 RC 却拿到 3.5"这种不一致不会发生。
         */
        id: 'version',
        label: '版本',
        kind: 'choice',
        defaultValue: 'stable',
        choices: [
          {
            id: 'stable',
            label: 'Vue 3.5（当前稳定）',
            hint: '官方 latest（不额外锁版本）',
            args: [],
          },
          {
            id: 'rc',
            label: 'Vue 3.6 RC',
            hint: 'create-vue --vue-rc；候选版本，可能有破坏性改动',
            args: ['--vue-rc'],
            /*
             * 官方给的是 dist-tag `rc`（外加一串 overrides 把子包也锁到 rc）。
             * 我们跟着写 `rc` 而不是写死版本号：官方路径下等于没改，
             * 内置回退路径下也能装到 RC —— 两条路写法一致，才不会"选了 RC 却拿到 3.5"。
             */
            pins: { vue: 'rc' },
          },
        ],
      },
      {
        id: 'addons',
        label: '附加项',
        kind: 'multi',
        defaultValue: ['router', 'pinia', 'eslint', 'prettier'],
        choices: [
          { id: 'router', label: 'Router', hint: 'Vue Router', args: ['--router'] },
          { id: 'pinia', label: 'Pinia', hint: '状态管理', args: ['--pinia'] },
          { id: 'eslint', label: 'ESLint', hint: '代码检查', args: ['--eslint'] },
          { id: 'prettier', label: 'Prettier', hint: '代码格式化', args: ['--prettier'] },
          { id: 'vitest', label: 'Vitest', hint: '单元测试', args: ['--vitest'] },
          { id: 'jsx', label: 'JSX', hint: '在 Vue 里写 JSX', args: ['--jsx'] },
        ],
      },
    ],
  },
  {
    id: 'react',
    name: 'React',
    kind: 'frontend',
    source: 'official',
    officialSpec: 'scaffold-npm-create',
    /*
     * React 走的是 Vite 官方脚手架（`create-vite`）—— 这是 React 官方文档推荐的起步方式，
     * 也就是"官方"的那条路。它的可选维度比 create-vue 少：模板名决定 TS/JS，
     * 另外只有一个 ESLint / Oxlint 的开关 —— 我们就只暴露这些，不硬造选项。
     */
    officialPackage: 'vite@latest',
    installKind: 'node',
    fallbackTemplateId: 'react',
    defaultPort: 5173,
    languageLabel: 'TypeScript / JavaScript',
    /* 与 Vue 同源：都是 Vite 的工具链，所以引擎要求一样 */
    enginesNode: '^20.19.0 || >=22.12.0',
    dimensions: [
      {
        id: 'language',
        label: '语言',
        kind: 'choice',
        defaultValue: 'ts',
        choices: [
          { id: 'ts', label: 'TypeScript', hint: 'create-vite --template react-ts', args: ['--template', 'react-ts'] },
          { id: 'js', label: 'JavaScript', hint: 'create-vite --template react', args: ['--template', 'react'] },
        ],
      },
      {
        id: 'version',
        label: '版本',
        kind: 'choice',
        defaultValue: '19',
        choices: [
          {
            id: '19',
            label: 'React 19（当前主线）',
            hint: '官方 latest（不额外锁版本）',
            args: [],
          },
          {
            id: '18',
            label: 'React 18.3（上一个主线）',
            hint: '生态里还有不少库只支持到 18',
            args: [],
            pins: { react: '^18.3.1', 'react-dom': '^18.3.1' },
          },
        ],
      },
      {
        id: 'addons',
        label: '附加项',
        kind: 'multi',
        defaultValue: [],
        choices: [
          {
            id: 'eslint',
            label: 'ESLint',
            hint: '不勾选用官方默认的 Oxlint',
            args: ['--eslint'],
          },
        ],
      },
    ],
  },
  {
    id: 'nestjs',
    name: 'NestJS',
    kind: 'backend',
    source: 'official',
    officialSpec: 'scaffold-nest-new',
    installKind: 'node',
    defaultPort: 3000,
    languageLabel: 'TypeScript',
    /* @nestjs/core 自己声明的：>= 20 */
    enginesNode: '>=20',
    dimensions: [
      {
        id: 'version',
        label: '版本',
        kind: 'choice',
        defaultValue: '12',
        choices: [
          {
            id: '12',
            label: 'NestJS 12（当前主线）',
            hint: '官方 latest（不额外锁版本）',
            args: [],
          },
          {
            id: '11',
            label: 'NestJS 11（上一个主线）',
            hint: '生态里还没跟上的库多半停在 11',
            args: [],
            pins: {
              '@nestjs/common': '^11.0.0',
              '@nestjs/core': '^11.0.0',
              '@nestjs/platform-express': '^11.0.0',
            },
          },
        ],
      },
      {
        id: 'addons',
        label: '附加项',
        kind: 'multi',
        defaultValue: ['strict'],
        choices: [
          { id: 'strict', label: '严格模式', hint: 'nest new --strict（更严的 TS 检查）', args: ['--strict'] },
        ],
      },
    ],
    /*
     * 官方调用失败时回退到内置最小骨架。
     *
     * 第一版这里**没有**回退（理由是"手写一份既不像官方又会过期"），但实际用起来
     * "断网就完全用不了"更糟：内置骨架的价值不是"像官方"，而是**让项目能开始**。
     * 日志里会写明这次走的是回退路径、少了哪些东西。
     */
    fallbackTemplateId: 'nestjs',
  },
  {
    id: 'fastapi',
    name: 'FastAPI',
    kind: 'backend',
    source: 'builtin',
    installKind: 'python',
    defaultPort: 8000,
    languageLabel: 'Python',
    dimensions: [
      {
        id: 'version',
        label: '版本',
        kind: 'choice',
        defaultValue: 'range',
        choices: [
          {
            id: 'range',
            label: '跟随最新（>=0.115）',
            hint: 'requirements.txt 写范围，装的时候取当时的最新版',
            args: [],
          },
          {
            id: 'lock',
            label: '锁 0.141 这一线',
            hint: 'requirements.txt 写 ==0.141.*，团队里每个人装到同一版',
            args: [],
            pins: { fastapi: '==0.141.*' },
          },
        ],
      },
    ],
  },
  {
    id: 'django',
    name: 'Django',
    kind: 'backend',
    /*
     * 官方路径（M4 第十刀接上）：`django-admin startproject <name> .`。
     *
     * 它与其他栈的区别是**官方工具不自带** —— `django-admin` 得先装 Django 才有。
     * 所以这条路前面多一段"前置"：建 venv → 用它装 Django → 确认它认 startproject，
     * 见 `bootstrapDjangoScaffold`。前置失败（常见是断网 / PyPI 不通）就**如实回退**
     * 到下面这份内置骨架，而不是让用户连一个能跑的项目都拿不到。
     */
    source: 'official',
    officialSpec: 'scaffold-django',
    installKind: 'python',
    fallbackTemplateId: 'django',
    defaultPort: 8000,
    languageLabel: 'Python',
    dimensions: [
      {
        id: 'version',
        label: '版本',
        kind: 'choice',
        defaultValue: '6',
        choices: [
          {
            id: '6',
            label: 'Django 6.x（当前主线）',
            hint: '官方 latest',
            args: [],
            pins: { django: '>=6.0' },
          },
          {
            id: '4-2-lts',
            label: 'Django 4.2 LTS',
            hint: '长期支持版：升级周期长、生态最稳',
            args: [],
            pins: { django: '>=4.2,<5' },
          },
        ],
      },
    ],
  },
];

export function findTemplate(id: string): TemplateDescriptor | undefined {
  return TEMPLATES.find((template) => template.id === id);
}

/* ------------------------------------------------------------------ */
/* 模板内容                                                            */
/* ------------------------------------------------------------------ */

const FASTAPI_FILES: readonly TemplateFile[] = [
  {
    path: 'app/__init__.py',
    content: '',
  },
  {
    path: 'app/main.py',
    content: `"""__PROJECT_NAME__ 的后端服务（FastAPI）。

启动：uvicorn app.main:app --reload --port __PORT__
接口文档：http://127.0.0.1:__PORT__/docs
"""

from fastapi import FastAPI

app = FastAPI(title="__PROJECT_NAME__")


@app.get("/health")
def health() -> dict[str, str]:
    """健康检查：部署脚本与前端联调都用它确认服务活着。"""
    return {"status": "ok", "service": "__PACKAGE_NAME__"}


@app.get("/api/hello")
def hello(name: str = "world") -> dict[str, str]:
    return {"message": f"hello, {name}"}
`,
  },
  {
    path: 'requirements.txt',
    content: `# 直接依赖（版本按当时的稳定版写，安装时想升级就改这里）
fastapi>=0.115
uvicorn[standard]>=0.32
`,
  },
  {
    path: '.gitignore',
    content: `# Python
__pycache__/
*.py[cod]
.venv/
venv/
.env

# 项目管理工具自己的目录（附件与作业日志，不属于代码）
attachments/
logs/
`,
  },
  {
    path: '.env.example',
    content: `# 复制成 .env 再改；.env 不进版本库
APP_NAME=__PROJECT_NAME__
PORT=__PORT__
`,
  },
  {
    path: 'README.md',
    content: `# __PROJECT_NAME__

由项目管理系统的「内置 FastAPI 模板」生成的最小骨架。

## 跑起来

\`\`\`bash
python -m venv .venv
.venv/Scripts/python -m pip install -r requirements.txt   # Windows
# source .venv/bin/activate && pip install -r requirements.txt   # macOS / Linux
.venv/Scripts/python -m uvicorn app.main:app --reload --port __PORT__
\`\`\`

- 健康检查：\`GET /health\`
- 示例接口：\`GET /api/hello?name=你的名字\`
- 接口文档：\`/docs\`

## 目录

\`\`\`
app/
  __init__.py
  main.py         # FastAPI 实例与路由
requirements.txt  # 直接依赖
.env.example      # 环境变量样例
\`\`\`
`,
  },
];

const VUE3_FILES: readonly TemplateFile[] = [
  {
    path: 'package.json',
    content: `{
  "name": "__PACKAGE_NAME__",
  "private": true,
  "version": "0.0.0",
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "__VUE_BUILD__",
    "preview": "vite preview"
  },
  "dependencies": {
    "vue": "^3.5.0"
  },
  "devDependencies": {
    "@vitejs/plugin-vue": "^6.0.0"__VUE_TSDEV__,
    "vite": "^6.0.0"
  }
}
`,
  },
  {
    path: 'index.html',
    content: `<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>__PROJECT_NAME__</title>
  </head>
  <body>
    <div id="app"></div>
    <script type="module" src="/src/main.__EXT__"></script>
  </body>
</html>
`,
  },
  {
    path: 'vite.config.__EXT__',
    content: `import vue from '@vitejs/plugin-vue';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [vue()],
  server: {
    port: __PORT__,
  },
});
`,
  },
  {
    path: 'tsconfig.json',
    /* 只在 TypeScript 模式下写：JavaScript 项目里塞一份 tsconfig 只会让人困惑 */
    when: (vars) => vars.ext === 'ts',
    content: `{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "strict": true,
    "jsx": "preserve",
    "lib": ["ES2022", "DOM"],
    "skipLibCheck": true,
    "noEmit": true,
    "types": ["vite/client"]
  },
  "include": ["src/**/*.ts", "src/**/*.vue"]
}
`,
  },
  {
    path: 'jsconfig.json',
    when: (vars) => vars.ext === 'js',
    content: `{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "checkJs": false,
    "jsx": "preserve",
    "lib": ["ES2022", "DOM"]
  },
  "include": ["src/**/*.js", "src/**/*.vue"]
}
`,
  },
  {
    path: 'src/main.__EXT__',
    content: `import { createApp } from 'vue';

import App from './App.vue';

createApp(App).mount('#app');
`,
  },
  {
    path: 'src/App.vue',
    content: `<script setup__SCRIPT_LANG__>
import { ref } from 'vue';

const count = ref(0);
</script>

<template>
  <main>
    <h1>__PROJECT_NAME__</h1>
    <p>由项目管理系统的内置回退模板生成的最小骨架。</p>
    <button type="button" @click="count += 1">点了 {{ count }} 次</button>
  </main>
</template>
`,
  },
  {
    path: 'src/env.d.ts',
    when: (vars) => vars.ext === 'ts',
    content: `/// <reference types="vite/client" />
`,
  },
  {
    path: '.gitignore',
    content: `node_modules/
dist/
*.local

# 项目管理工具自己的目录（附件与作业日志，不属于代码）
attachments/
logs/
`,
  },
  {
    path: 'README.md',
    content: `# __PROJECT_NAME__

由项目管理系统的**内置回退模板**生成（正常情况下应该走官方的 \`npm create vue@latest\`；
这里是在官方脚手架调用失败时用的最小骨架）。

\`\`\`bash
pnpm install   # 或 npm install
pnpm dev
\`\`\`

开发地址：http://127.0.0.1:__PORT__/
`,
  },
];

/**
 * React 的内置回退骨架（`create-vite` 走不通时用）。
 *
 * 与 Vue 那份同样的规矩：**能跑起来的最小骨架**，不是 create-vite 的完整复刻。
 * 组件文件用 `__JSXEXT__`（tsx / jsx），配置文件用 `__EXT__`（ts / js）——
 * 这两个扩展名不是一回事，写混了 Vite 会直接报"找不到入口"。
 */
const REACT_FILES: readonly TemplateFile[] = [
  {
    path: 'package.json',
    content: `{
  "name": "__PACKAGE_NAME__",
  "private": true,
  "version": "0.0.0",
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "__REACT_BUILD__",
    "preview": "vite preview"
  },
  "dependencies": {
    "react": "^19.0.0",
    "react-dom": "^19.0.0"
  },
  "devDependencies": {
    "@vitejs/plugin-react": "^5.0.0"__REACT_TSDEV__,
    "vite": "^6.0.0"
  }
}
`,
  },
  {
    path: 'index.html',
    content: `<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>__PROJECT_NAME__</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.__JSXEXT__"></script>
  </body>
</html>
`,
  },
  {
    path: 'vite.config.__EXT__',
    content: `import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react()],
  server: {
    port: __PORT__,
  },
});
`,
  },
  {
    path: 'tsconfig.json',
    when: (vars) => vars.ext === 'ts',
    content: `{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "jsx": "react-jsx",
    "strict": true,
    "lib": ["ES2022", "DOM"],
    "skipLibCheck": true,
    "noEmit": true,
    "types": ["vite/client"]
  },
  "include": ["src"]
}
`,
  },
  {
    path: 'jsconfig.json',
    when: (vars) => vars.ext === 'js',
    content: `{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "jsx": "react-jsx",
    "checkJs": false,
    "lib": ["ES2022", "DOM"]
  },
  "include": ["src"]
}
`,
  },
  {
    /*
     * 入口写两份：`document.getElementById('root')!` 的 `!` 是 TypeScript 专有语法，
     * 放进 JavaScript 文件里就是**语法错误**（不是类型错误，Vite 直接起不来）。
     * 差异只有这一个字符，但共用一份的下场是"选了 JS 得到一个起不来的项目"。
     */
    path: 'src/main.__JSXEXT__',
    when: (vars) => vars.ext === 'ts',
    content: `import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import App from './App.__JSXEXT__';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
`,
  },
  {
    path: 'src/main.__JSXEXT__',
    when: (vars) => vars.ext === 'js',
    content: `import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import App from './App.__JSXEXT__';

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
`,
  },
  {
    path: 'src/App.__JSXEXT__',
    content: `import { useState } from 'react';

export default function App() {
  const [count, setCount] = useState(0);

  return (
    <main>
      <h1>__PROJECT_NAME__</h1>
      <p>由项目管理系统的内置回退模板生成的最小骨架。</p>
      <button type="button" onClick={() => setCount(count + 1)}>点了 {count} 次</button>
    </main>
  );
}
`,
  },
  {
    path: 'src/vite-env.d.ts',
    when: (vars) => vars.ext === 'ts',
    content: `/// <reference types="vite/client" />
`,
  },
  {
    path: '.gitignore',
    content: `node_modules/
dist/
*.local

# 项目管理工具自己的目录（附件与作业日志，不属于代码）
attachments/
logs/
`,
  },
  {
    path: 'README.md',
    content: `# __PROJECT_NAME__

由项目管理系统的**内置回退模板**生成（正常情况下应该走官方的 \`npm create vite@latest\`；
这里是在官方脚手架调用失败时用的最小骨架）。

\`\`\`bash
pnpm install   # 或 npm install
pnpm dev
\`\`\`

开发地址：http://127.0.0.1:__PORT__/
`,
  },
];

const NESTJS_FILES: readonly TemplateFile[] = [
  {
    path: 'package.json',
    content: `{
  "name": "__PACKAGE_NAME__",
  "version": "0.0.1",
  "private": true,
  "scripts": {
    "build": "nest build",
    "start": "nest start",
    "start:dev": "nest start --watch"
  },
  "dependencies": {
    "@nestjs/common": "^11.0.0",
    "@nestjs/core": "^11.0.0",
    "@nestjs/platform-express": "^11.0.0",
    "reflect-metadata": "^0.2.2",
    "rxjs": "^7.8.1"
  },
  "devDependencies": {
    "@nestjs/cli": "^11.0.0",
    "@types/node": "^22.0.0",
    "typescript": "^5.6.0"
  }
}
`,
  },
  {
    path: 'tsconfig.json',
    content: `{
  "compilerOptions": {
    "module": "commonjs",
    "declaration": true,
    "emitDecoratorMetadata": true,
    "experimentalDecorators": true,
    "target": "ES2022",
    "sourceMap": true,
    "outDir": "./dist",
    "baseUrl": "./",
    "incremental": true,
    "skipLibCheck": true,
    "strict": true
  },
  "include": ["src/**/*"]
}
`,
  },
  {
    path: 'nest-cli.json',
    content: `{
  "$schema": "https://json.schemastore.org/nest-cli",
  "collection": "@nestjs/schematics",
  "sourceRoot": "src"
}
`,
  },
  {
    path: 'src/main.__EXT__',
    content: `import { NestFactory } from '@nestjs/core';

import { AppModule } from './app.module';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule);
  await app.listen(__PORT__);
  console.log('__PROJECT_NAME__ 已启动：http://127.0.0.1:__PORT__/');
}

void bootstrap();
`,
  },
  {
    path: 'src/app.module.ts',
    content: `import { Module } from '@nestjs/common';

import { AppController } from './app.controller';
import { AppService } from './app.service';

@Module({
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
`,
  },
  {
    path: 'src/app.controller.ts',
    content: `import { Controller, Get, Query } from '@nestjs/common';

import { AppService } from './app.service';

@Controller()
export class AppController {
  constructor(private readonly appService: AppService) {}

  @Get('health')
  health(): { status: string } {
    return { status: 'ok' };
  }

  @Get('api/hello')
  hello(@Query('name') name = 'world'): { message: string } {
    return { message: this.appService.greet(name) };
  }
}
`,
  },
  {
    path: 'src/app.service.ts',
    content: `import { Injectable } from '@nestjs/common';

@Injectable()
export class AppService {
  greet(name: string): string {
    return \`hello, \${name}\`;
  }
}
`,
  },
  {
    path: '.gitignore',
    content: `node_modules/
dist/
*.local

# 项目管理工具自己的目录（附件与作业日志，不属于代码）
attachments/
logs/
`,
  },
  {
    path: 'README.md',
    content: `# __PROJECT_NAME__

由项目管理系统的内置 NestJS 骨架生成（官方脚手架没走通时的回退路径）。

\`\`\`bash
pnpm install   # 或 npm install
pnpm start:dev
\`\`\`

- 健康检查：\`GET /health\`
- 示例接口：\`GET /api/hello?name=你的名字\`
`,
  },
];

const DJANGO_FILES: readonly TemplateFile[] = [
  {
    path: 'manage.py',
    content: `#!/usr/bin/env python
"""Django 管理入口：runserver / migrate / createsuperuser 都从这里进。"""

import os
import sys


def main() -> None:
    os.environ.setdefault("DJANGO_SETTINGS_MODULE", "__MODULE_NAME__.settings")
    try:
        from django.core.management import execute_from_command_line
    except ImportError as exc:
        raise ImportError(
            "没找到 Django。先建虚拟环境并安装依赖："
            "python -m venv .venv && .venv/Scripts/python -m pip install -r requirements.txt"
        ) from exc
    execute_from_command_line(sys.argv)


if __name__ == "__main__":
    main()
`,
  },
  {
    path: '__MODULE_NAME__/__init__.py',
    content: '',
  },
  {
    path: '__MODULE_NAME__/settings.py',
    content: `"""__PROJECT_NAME__ 的 Django 配置（最小可用版）。"""

from pathlib import Path

BASE_DIR = Path(__file__).resolve().parent.parent

# 开发用：正式部署时必须换成环境变量里的随机串
SECRET_KEY = "django-insecure-change-me"
DEBUG = True
ALLOWED_HOSTS = ["127.0.0.1", "localhost"]

INSTALLED_APPS = [
    "django.contrib.contenttypes",
    "django.contrib.staticfiles",
]

MIDDLEWARE = [
    "django.middleware.common.CommonMiddleware",
]

ROOT_URLCONF = "__MODULE_NAME__.urls"
WSGI_APPLICATION = "__MODULE_NAME__.wsgi"

TEMPLATES = [
    {
        "BACKEND": "django.template.backends.django.DjangoTemplates",
        "DIRS": [],
        "APP_DIRS": True,
        "OPTIONS": {"context_processors": []},
    }
]

LANGUAGE_CODE = "zh-hans"
TIME_ZONE = "Asia/Shanghai"
USE_I18N = True
USE_TZ = True

STATIC_URL = "static/"
DEFAULT_AUTO_FIELD = "django.db.models.BigAutoField"
`,
  },
  {
    path: '__MODULE_NAME__/urls.py',
    content: `"""路由表：目前只有健康检查，业务路由自己往上加。"""

from django.http import JsonResponse
from django.urls import path


def health(_request) -> JsonResponse:
    return JsonResponse({"status": "ok", "service": "__PACKAGE_NAME__"})


urlpatterns = [
    path("health", health),
]
`,
  },
  {
    path: '__MODULE_NAME__/wsgi.py',
    content: `import os

from django.core.wsgi import get_wsgi_application

os.environ.setdefault("DJANGO_SETTINGS_MODULE", "__MODULE_NAME__.settings")

application = get_wsgi_application()
`,
  },
  {
    path: '__MODULE_NAME__/asgi.py',
    content: `import os

from django.core.asgi import get_asgi_application

os.environ.setdefault("DJANGO_SETTINGS_MODULE", "__MODULE_NAME__.settings")

application = get_asgi_application()
`,
  },
  {
    path: 'requirements.txt',
    content: `# 直接依赖（装完就能 runserver）
Django>=5.0
`,
  },
  {
    path: '.gitignore',
    content: `# Python
__pycache__/
*.py[cod]
.venv/
venv/
db.sqlite3
.env

# 项目管理工具自己的目录（附件与作业日志，不属于代码）
attachments/
logs/
`,
  },
  {
    path: 'README.md',
    content: `# __PROJECT_NAME__

由项目管理系统的内置 Django 骨架生成。

\`\`\`bash
python -m venv .venv
.venv/Scripts/python -m pip install -r requirements.txt   # Windows
# source .venv/bin/activate && pip install -r requirements.txt   # macOS / Linux
.venv/Scripts/python manage.py migrate
.venv/Scripts/python manage.py runserver __PORT__
\`\`\`

- 健康检查：\`GET /health\`

> 这份骨架刻意**不含** admin / auth / 数据库应用：先把项目跑起来，需要什么再加。
`,
  },
];

export const TEMPLATE_FILES: Readonly<Record<string, readonly TemplateFile[]>> = {
  fastapi: FASTAPI_FILES,
  vue3: VUE3_FILES,
  react: REACT_FILES,
  nestjs: NESTJS_FILES,
  django: DJANGO_FILES,
};

/* ------------------------------------------------------------------ */
/* 渲染                                                                */
/* ------------------------------------------------------------------ */

/**
 * 把 `__VAR__` 换成实际值。变量表里没有的占位符**原样留下**（宁可见到 `__X__`，也不要静默变成空）。
 *
 * 语言相关的四个占位符在这里统一展开，模板本身只有一份：
 * - `__EXT__`：配置文件与普通脚本的扩展名（`ts` / `js`）
 * - `__JSXEXT__`：React 组件与入口的扩展名（`tsx` / `jsx`）
 * - `__SCRIPT_LANG__`：`<script lang="ts">` 里那一段（JS 模式下是空字符串）
 * - `__VUE_BUILD__` / `__VUE_TSDEV__`（Vue）与 `__REACT_BUILD__` / `__REACT_TSDEV__`（React）：`package.json` 里与 TypeScript 有关的两处（Vue 用 `vue-tsc`、React 用 `tsc`，不能混）
 */
export function renderText(content: string, vars: TemplateVars): string {
  const ts = vars.ext === 'ts';
  return content
    .replace(/__PROJECT_NAME__/g, vars.projectName)
    .replace(/__PACKAGE_NAME__/g, vars.packageName)
    .replace(/__MODULE_NAME__/g, vars.moduleName)
    .replace(/__PORT__/g, String(vars.port))
    .replace(/__EXT__/g, vars.ext)
    .replace(/__JSXEXT__/g, vars.language === 'ts' ? 'tsx' : 'jsx')
    .replace(/__SCRIPT_LANG__/g, ts ? ' lang="ts"' : '')
    .replace(/__VUE_BUILD__/g, ts ? 'vue-tsc --noEmit && vite build' : 'vite build')
    .replace(/__VUE_TSDEV__/g, ts ? ',\n    "typescript": "^5.6.0",\n    "vue-tsc": "^2.1.0"' : '')
    .replace(/__REACT_BUILD__/g, ts ? 'tsc -b && vite build' : 'vite build')
    .replace(
      /__REACT_TSDEV__/g,
      ts ? ',\n    "typescript": "^5.6.0",\n    "@types/react": "^19.0.0",\n    "@types/react-dom": "^19.0.0"' : '',
    );
}

export function renderTemplate(templateId: string, vars: TemplateVars): TemplateFile[] {
  const files = TEMPLATE_FILES[templateId];
  if (!files) throw new Error(`没有内置模板「${templateId}」`);
  return files
    .filter((file) => file.when === undefined || file.when(vars))
    .map((file) => ({ path: renderText(file.path, vars), content: renderText(file.content, vars) }));
}

/**
 * 路径安全：模板写出来的路径必须是**相对路径**，且不能借 `..` 跑出目标目录。
 *
 * 模板是我们自己写的，但这条校验不能省：模板内容会被人改，
 * 而"模板里一行 `../..` 就能写到工作区外面"是那种出事才发现的问题。
 */
export function assertSafeTemplatePath(path: string): string {
  const normalized = path.replace(/\\/g, '/');
  if (normalized.startsWith('/') || /^[A-Za-z]:/.test(normalized)) {
    throw new Error(`模板路径「${path}」不能是绝对路径`);
  }
  const segments = normalized.split('/');
  if (segments.some((segment) => segment === '..' || segment === '')) {
    throw new Error(`模板路径「${path}」不合法（不允许 .. 或空段）`);
  }
  return normalized;
}

/* ------------------------------------------------------------------ */
/* 写盘                                                                */
/* ------------------------------------------------------------------ */

export interface WriteTemplateResult {
  /** 实际写出的文件（相对目标目录） */
  written: string[];
  /** 目标目录里本来就存在、被我们**跳过**的文件（不覆盖用户已有的东西） */
  skipped: string[];
}

/**
 * 把（已渲染的）模板文件写到目标目录。
 *
 * 两条规矩：
 * 1. **不覆盖已存在的文件**：生成骨架时目标目录里可能有用户自己放的东西
 *    （项目文件夹在创建时就带了 `attachments/`、`logs/`），覆盖是不可逆的损失；
 * 2. 每一层目录按需创建（`mkdirSync(recursive)`），并且**写之前先校验路径**
 *    （见 `assertSafeTemplatePath`）。
 */
export function writeTemplateFiles(rootDir: string, files: readonly TemplateFile[]): WriteTemplateResult {
  const written: string[] = [];
  const skipped: string[] = [];

  for (const file of files) {
    const relative = assertSafeTemplatePath(file.path);
    const absolute = join(rootDir, ...relative.split('/'));

    // 双保险：拼完之后必须仍在目标目录内（防的是拼接逻辑本身出错）
    const resolvedRoot = resolve(rootDir);
    if (!resolve(absolute).startsWith(resolvedRoot)) {
      throw new Error(`模板路径「${file.path}」解析后跑出了目标目录`);
    }

    if (existsSync(absolute)) {
      skipped.push(relative);
      continue;
    }

    mkdirSync(dirname(absolute), { recursive: true });
    writeFileSync(absolute, file.content, 'utf8');
    written.push(relative);
  }

  return { written, skipped };
}
