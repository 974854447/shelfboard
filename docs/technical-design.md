# pm-studio 技术设计文档 v1.0

> 对应需求：[`requirements.md`](./requirements.md)（v1.1）
> 数据模型与 API 清单：[`data-model-and-api.md`](./data-model-and-api.md)

---

## 1. 关键架构决策（先看这一节）

| # | 决策 | 结论 | 理由 |
|---|---|---|---|
| A1 | 内嵌服务跑在哪 | **跑在 Electron 主进程内的模块**，不 fork 独立 Node 进程 | 重活（脚手架、装依赖、迁移）本质是**外部子进程**，主进程只做 I/O 编排，不会被 CPU 阻塞；省掉 `ELECTRON_RUN_AS_NODE` 打包复杂度与进程间通信 |
| A2 | 生产环境窗口加载方式 | **由 Fastify 提供渲染层静态资源**，窗口加载 `http://127.0.0.1:<port>` | 与 API **同源**，免 CORS、CSP 简单；开发环境走 Vite dev server 并仅对 dev origin 开 CORS |
| A3 | ORM 选型 | **Drizzle ORM + better-sqlite3** | Prisma 的 query engine 二进制在 Electron 打包里是经典坑；Drizzle 纯 TS、无二进制、同步 API 适配 SQLite |
| A4 | 数据库连接与工作区 | **单连接单例**，切换工作区时关闭旧连接、打开新库 | SQLite 单写者模型；切换必须显式 `close()` 否则 WAL 文件残留 |
| A5 | 附件路径存储 | **一律存相对于工作区根的相对路径** | 迁移工作区时无需改写附件引用，大幅降低迁移风险 |
| A6 | 本地 API 鉴权 | 绑定 `127.0.0.1` + **每次启动生成的一次性 Bearer Token** | 本机任何进程都能访问 127.0.0.1，只绑本地不足以防御 |
| A7 | 作业日志推送 | **SSE**（`text/event-stream`） | 单向流、比 WebSocket 简单、断线可自动重连（`Last-Event-ID`） |
| A8 | 子进程调用 | **execa + 参数数组，永不用 `shell: true`** | 杜绝命令注入；自带超时、取消、进程树 kill |
| A9 | 模板变量占位符 | `__VAR__` 双下划线风格，**不用 `{{ }}`** | Vue 模板文件里 `{{ }}` 是语法本身，用它做占位符必然冲突 |
| A10 | 官方脚手架健壮性 | 调用前**先执行 `--help` 做运行时能力探测**，再按探测结果组装命令 | 官方版本会变，硬编码参数迟早崩；探测失败即回退内置模板 |
| A11 | 生成落盘策略 | 先在工作区 `projects/.tmp/<jobId>` 生成，**校验通过后整体移动**到 `projects/<slug>`，再写库 | 失败时删临时目录即可，绝不留下半成品项目 |
| A12 | 环境变量读写方式 | 统一走 **PowerShell 的 `[Environment]::GetEnvironmentVariable(...,'User')` / `SetEnvironmentVariable(...,'User')`** | `reg query` 会**展开** `REG_EXPAND_SZ`，直接读写会把 `%USERPROFILE%` 这种变量写死成绝对路径；.NET API 保留原样，且写入会自动广播 `WM_SETTINGCHANGE` |
| A13 | 迁移复制实现 | **robocopy**（`/E /R:1 /W:1`），解析 stdout 出进度 | Windows 原生、大目录可靠、内建重试；`fs.cp` 无重试且无进度 |
| A14 | 迁移期间的一致性 | 迁移全程进入**维护模式**，所有写请求返回 `423 Locked` | 否则搬迁过程中新写入的数据会丢在旧库 |
| A15 | 崩溃恢复 | 启动时把 `running` / `queued` 作业标记为 `interrupted` 并提示 | 断电或强杀后作业状态不能悬空 |
| A16 | 日志与诊断 | 结构化日志落库 `app_logs` **+** 文本文件双写；**traceId 贯通 API 请求与作业**；SSE 实时推送；写入前**强制脱敏** | 只有把错误与它的现场（traceId、作业、堆栈、上下文）绑在一起，"查看日志"才有意义；文本文件保证崩溃后日志仍能整包取出 |
| A17 | 白屏兜底 | 渲染层启动失败时由 Fastify 返回一张**降级静态页**（内含错误信息与日志入口） | 前端崩在最前面时，用户看到的不该是一片空白，而应是可操作的诊断入口 |
| A18 | 迁移方式 | **手写 SQL 迁移 + 校验和校验**，不使用 drizzle-kit 生成 | drizzle-kit 是 CLI 代码生成器（内部派生子进程），在受限环境下 spawn EPERM 不可用，且会引入只在开发期存在的构建产物。手写迁移可版本化、可测试、随包分发。**Drizzle 只负责类型化查询，DDL（索引 / 外键 / 唯一约束）以迁移为唯一来源**，两份定义是否脱节由 `tests/db.test.ts` 的**双向漂移测试**兜底 |
| A19 | 工单与作业表提前建 | 工单（`tickets` / `ticket_types`）与作业（`jobs` / `job_logs`）的表在 M1 迁移里就建好，功能仍按里程碑实现 | SQLite **无法用 ALTER TABLE 添加外键**；而 `tasks.ticket_id`、`app_logs.job_id` 需要指向它们。先建表代价为零，后补约束则必须重建整张表并搬数据 |
| A20 | 渲染进程日志上报 | 渲染进程经 `POST /logs/client` 上报，服务端**覆盖 source 为 `renderer`** | 处理该请求的 logger 的 source 是 `api`，不覆盖的话前端错误会被记成后端错误，按来源分区排查时就会翻错地方。为此在 `LogContext` 上开了一个受控的 `source` 覆盖（唯一允许的例外场景） |
| A21 | 诊断包导出在 M1 为同步接口 | `POST /logs/export` 直接返回结果，M4 接入作业系统后再改为异步作业 | M1 还没有作业执行器。为了等作业系统而把功能挂空，不如先让功能可用；接口形态变更时前端只需换调用方式 |
| A22 | 静态资源的 SPA 回落必须排除 API 前缀 | 只对**非 API 路径**回落 `index.html` | 否则前端请求一个不存在的接口会拿到一份 HTML，所有"接口 404 处理"都会退化成 JSON 解析错误 —— 属于越修越乱的一类故障。已有回归测试锁定 |
| A23 | 创建任务必须走显式对话框，**回车不创建** | 统一 `TaskCreateDialog`，看板列脚 / 列表工具栏 / 抽屉共用；回车只换行、不提交 | 原来的"列底输入框回车即建"有两个问题：一是用户说不清自己到底建了什么（状态、优先级、截止日全靠默认值），二是**无法看到子任务归属**。把创建变成一次"确认动作"，校验与归属才有地方展示。为此显式写了一条提示"回车不会直接创建"，而不是指望用户猜 |
| A24 | 子任务在列表里以**树**呈现，分页按主任务计 | `NDataTable` 的 `children` 折叠行；`children` 为空数组时必须删掉该字段，否则会画出空箭头 | 子任务的独立性是假的：脱离父任务看"补上重定向规则"根本不知道它是谁的一部分。分页若按行计，一个 3 层子任务会把主任务挤到下一页，层级直接被撕开。空数组的空箭头是 `NDataTable` 的已知行为，属于"看起来有东西、点开是空的"的误导 |

---

## 2. 技术栈与依赖清单

### 运行时依赖

| 包 | 用途 |
|---|---|
| `electron` | 桌面外壳 |
| `fastify` + `fastify-type-provider-zod` | 内嵌 API 服务 + Zod 校验打通 |
| `drizzle-orm` + `better-sqlite3` | ORM 与 SQLite 驱动（WAL、FTS5） |
| `zod` | 入参 / 出参 / 模板表单 Schema |
| `execa` | 子进程调用（超时、取消、进程树 kill） |
| `electron-log` | 主进程与作业日志落盘 |
| `ulid` | 主键（时间有序，利于 SQLite 索引与分页） |
| `dayjs` | 日期处理 |
| `markdown-it` + `dompurify` | Markdown 渲染与 **XSS 净化（必须）** |
| `vue` + `vue-router` + `pinia` + `naive-ui` | 前端框架与组件库 |
| `md-editor-v3` | Markdown 编辑器（预览、代码块、表格、粘贴图片） |
| `vue-draggable-plus` | 看板卡片拖拽、表格行排序 |

### 开发依赖

`electron-vite`、`electron-builder`、`@electron/rebuild`、`vitest`、`@vitest/coverage-v8`、`typescript`、`eslint`、`prettier`、`tsx`

> **不使用 `drizzle-kit`**（它原本在计划里）：理由见 A18。迁移 SQL 手写在 `db/migrations.ts` 里。

---

## 3. 进程模型与启动时序

```
┌─────────────────── Electron 主进程 ───────────────────┐
│  AppConfig（AppData/config.json，原子写）              │
│  WorkspaceManager ──▶ DbConnection（单例，可切换）      │
│  Fastify Server（127.0.0.1:0 动态端口 + Bearer Token） │
│  JobRunner（队列 / 状态机 / SSE 广播）                  │
│      └─▶ execa 子进程：脚手架、包管理器、robocopy…      │
│  TrayController（托盘、最小化、退出确认）               │
└───────────────────────┬───────────────────────────────┘
                        │ BrowserWindow（contextIsolation）
┌───────────────────────▼───────────────────────────────┐
│  preload（contextBridge 白名单，仅暴露必要能力）         │
│  Vue3 渲染进程 ──HTTP/SSE──▶ 127.0.0.1:<port>          │
└───────────────────────────────────────────────────────┘
```

### 启动时序

1. `app.requestSingleInstanceLock()` —— 拿不到锁则激活已有窗口并退出本进程。
2. 初始化 `electron-log`，读取 AppData 配置；读取失败则重建默认配置。
3. **无工作区** → 打开「首次设置」窗口，引导创建或选择工作区。
4. 打开工作区数据库：`better-sqlite3` + `PRAGMA journal_mode=WAL`、`foreign_keys=ON`（并校验生效），执行 SQL 迁移。
5. **崩溃恢复**：`UPDATE jobs SET status='interrupted' WHERE status IN ('queued','running')`，并在作业中心提示。
6. 启动 Fastify：`listen({ host: '127.0.0.1', port: 0 })` 取系统分配端口；生成一次性 Token。
7. 生产环境注册渲染层静态资源路由；创建 `BrowserWindow`，加载 `http://127.0.0.1:<port>`。
8. 创建托盘图标；注册 `close` → `hide()`，托盘右键「退出」才真正退出。
9. `before-quit`：存在 `running` 作业时弹出二次确认。

### 工作区切换时序

关闭窗口交互 → 前端请求 `POST /workspaces/:id/activate` → 维护模式短暂上锁 → 关闭旧 DB 连接（先 `PRAGMA wal_checkpoint(TRUNCATE)`）→ 打开新 DB + 迁移 → 更新 `config.json` 的 `activeWorkspaceId` → 广播 `workspace.changed` 事件 → 前端清空 store 并重新拉取。

---

## 4. 仓库与目录结构

采用 pnpm workspace 单仓多包，但**只做必要拆分**（避免过度工程）：

```
pm-studio/
├── docs/
│   ├── requirements.md
│   ├── technical-design.md
│   └── data-model-and-api.md
├── packages/
│   ├── shared/                  # 前后端共享：类型、Zod Schema、常量、错误码
│   │   └── src/{types,schemas,constants,errors}.ts
│   ├── server/                  # Fastify 应用（本身不监听进程，由 main 启动）
│   │   └── src/
│   │       ├── app.ts           # 组装 Fastify 实例
│   │       ├── db/{schema.ts,migrations.ts,migrate.ts,connection.ts,index.ts}  # fts.ts 待 M2
│   │       ├── routes/          # 每个资源一个路由文件
│   │       ├── services/        # 业务逻辑（纯函数优先，便于单测）
│   │       ├── logging/{logger.ts,redact.ts,trace.ts,store.ts,rotate.ts}
│   │       ├── jobs/{runner.ts,whitelist.ts,types.ts,recovery.ts}
│   │       ├── scaffold/{official.ts,builtin.ts,detect.ts,render.ts}
│   │       ├── env/{detect.ts,apply.ts,rollback.ts,powershell.ts}
│   │       ├── workspace/{manager.ts,migrate.ts,precheck.ts,verify.ts}
│   │       └── templates/       # 内置模板（随包分发）
│   └── desktop/                 # Electron 主进程 + 渲染进程
│       └── src/
│           ├── main/            # 启动、托盘、单实例、窗口
│           ├── preload/
│           └── renderer/        # Vue3 应用
│               └── src/{views,components,stores,api,router,composables}
├── package.json
└── pnpm-workspace.yaml
```

**运行期数据（不随代码走）**

```
%APPDATA%/pm-studio/
├── config.json          # 全局配置：工作区清单、激活工作区、偏好
├── logs/                # 应用日志
│   ├── main.log         # 主进程（按大小轮转 main.1.log / main.2.log…）
│   └── renderer.log     # 渲染进程上报
└── crash/               # 崩溃转储与最近一次异常快照

<工作区>/
├── workspace.db         # (+ -wal / -shm)
├── projects/            # 各项目代码目录；.tmp/ 用于生成中转
├── attachments/
├── backups/
└── logs/jobs/<jobId>.log  # 作业日志（作业属于工作区，故放工作区内）
```

---

## 5. 后端模块设计

### 5.1 API 层约定

- 前缀 `/api/v1`；REST 风格。
- 统一响应包：成功 `{ ok: true, data }`；失败 `{ ok: false, error: { code, message, details? } }`。
- 错误码统一在 `packages/shared/errors.ts` 定义，前端按码做提示与分支。
- 分页：`?page=1&pageSize=50`，返回 `{ items, total, page, pageSize }`；看板等全量场景用 `?all=true`。
- 所有入参由 Zod Schema 校验（`fastify-type-provider-zod`），Schema 与前端共享。
- 写操作统一在服务层写 `activity_logs`。

### 5.2 数据库与连接管理

- 单例 `DbConnection`，暴露 `getDb()` / `switchWorkspace(path)` / `close()`。
- 迁移：**手写 SQL 迁移**（`db/migrations.ts` 是 DDL 的唯一来源）随包分发，启动时自动执行；已应用的迁移带校验和，被改写则**拒绝启动**（防止不同机器的库结构分叉）；迁移前自动备份 `workspace.db`。不使用 drizzle-kit，理由见 A18。
- 连接：`DbConnection` 单例；打开时强制 `journal_mode=WAL`、`foreign_keys=ON`，并**校验外键确实生效**（不生效就拒绝继续，避免产生孤儿数据）；关闭前做 `wal_checkpoint(TRUNCATE)`，保证只复制 `.db` 文件也能拿到完整数据 —— 这是后续「工作区迁移」的前提。
- 两份定义（Drizzle schema 与迁移 SQL）是否脱节，由 `tests/db.test.ts` 的**双向漂移测试**保证：每张表的列集合必须完全相等。
- FTS5：`search_index` 虚拟表（`content=''` 外部内容模式）+ `tasks` / `tickets` / `documents` 的 `INSERT/UPDATE/DELETE` 触发器同步；中文分词用 `unicode61` + 按字符切分的前置处理（避免引入分词扩展）。
- 软删除：`deleted_at IS NULL` 过滤；回收站视图查询 `deleted_at IS NOT NULL`。

### 5.3 作业执行器（JobRunner）

**状态机**

```
queued ──▶ running ──▶ succeeded
   │          │
   │          ├──▶ failed
   │          └──▶ canceled
   └──▶ interrupted（启动时对残留状态做恢复）
```

**关键设计**

- **队列与并发**：内存队列；`install` 类作业并发上限 1；`scaffold`/`export` 上限 2；**`workspace-migrate` 全局独占**且期间进入维护模式。
- **日志**：子进程 stdout/stderr 逐行 → 写入 `logs/jobs/<jobId>.log` + 批量落库 `job_logs`（每 500ms 或 50 行刷一次）+ 通过 SSE 推送。
- **进度**：`{ phase, percent, message }`。外部命令无进度时按**阶段权重表**估算（例：生成 30% / 安装依赖 60% / 收尾 10%）。
- **取消**：`AbortController` → `execa` 的 `cancelSignal`；Windows 上用 `taskkill /PID <pid> /T /F` 杀进程树（`npm` 会派生孙进程，只杀父进程会留孤儿）。
- **失败清理**：`scaffold` 失败删除 `.tmp/<jobId>`；`migrate` 失败保留源目录并回滚维护模式；`install` 失败保留已生成代码但标记为「依赖未安装」。
- **重试**：仅对外部网络类失败（包管理器安装）提供**手动重试**按钮，不自动重试。

### 5.4 命令白名单

所有外部命令必须来自结构化白名单，**不接受任何自由拼接的字符串**：

```ts
type CommandSpec = {
  id: string;                 // 如 'npm-install'
  bin: string;                // 允许的可执行文件名
  baseArgs: string[];         // 固定参数
  allowedFlags?: Record<string, string | string[]>; // 白名单化可选参数
  timeoutMs: number;
  cwdRule: 'workspace' | 'project' | 'tmp';
};
```

- 调用时只允许 `bin` + `baseArgs` + 白名单内的 flag；用户输入（项目名等）只能进入**位置参数或白名单 flag 的值位**，且经过 `^[A-Za-z0-9._-]+$` 强校验。
- 内置模板**不允许携带任何可执行脚本**（`postinstall` 之类一律禁止）。

### 5.5 脚手架模块

**模板描述符**

```ts
type TemplateDescriptor = {
  id: 'vue3-ts' | 'nestjs' | 'fastapi' | 'django';
  name: string;
  kind: 'frontend' | 'backend';
  source: 'official' | 'builtin';
  command?: CommandSpecId;          // official 时使用
  formSchema: ZodSchema;            // 向导第 5 步动态表单
  probe?: string[];                 // 能力探测用的 --help 参数
};
```

**官方脚手架调用**

| 模板 | 命令骨架 | 备注 |
|---|---|---|
| Vue3 + TS + Vite | `npm create vue@latest <name> -- <探测到的 flags>` | 先 `--help` 探测 `--ts/--router/--pinia/--eslint` |
| Vite（纯模板） | `npm create vite@latest <name> -- --template vue-ts` | 备选路径 |
| NestJS | `npx @nestjs/cli new <name> --package-manager <pm> --strict --skip-git` | `--skip-git` 因为 M6 才做 Git |
| Django | `django-admin startproject <name> .`（在 venv 中） | 官方 |
| FastAPI | — | **官方无脚手架 → 内置模板** |

**内置模板机制**

- 目录：`packages/server/src/templates/<templateId>/`，随包分发（`asarUnpack` 保证可读）。
- 变量：`__PROJECT_NAME__`、`__PACKAGE_NAME__`、`__PORT__`、`__PYTHON_VERSION__` 等，文本替换。
- 文件名占位：文件名中的 `__VAR__` 同样参与替换。
- 点文件映射：模板里以 `_` 开头的文件在渲染后去掉下划线（如 `_gitignore` → `.gitignore`、`_env.example` → `.env.example`），避免打包工具吞掉点文件。

**模板内容从哪来**（2026-09-26 用户：「M4 的生成模板可以在网上找相关的脚手架」）：

**开发期从网上取现成模板，固化进应用；运行期不下载模板。** 分两层：

| 层 | 做法 | 理由 |
|---|---|---|
| 官方脚手架（Vue / Vite / NestJS / Django） | 运行时**联网调用官方 CLI**（先 `--help` 探测能力） | 官方维护，参数会变，探测 + 回退能兜住 |
| 内置模板（FastAPI 等） | **开发期**从官方模板仓库取现成产物（如 `fastapi/full-stack-fastapi-template`、`vitejs/vite` 的 `template-vue-ts`、`nestjs/typescript-starter`），去掉不需要的部分后**固化进仓库** | 回退的意义就是"**官方调用失败（网络异常）时也能生成**"——如果内置模板本身还要联网下载，这条回退就是假的；固化还带来两个好处：**可复现**（模板版本固定，不会因为官方改参数就崩）与**可审计**（模板内容进仓库，能 review、能 diff） |

两条配套要求：

1. **来源与许可证必须标注**：固化第三方模板时保留其 LICENSE 与来源链接（Vite/NestJS 是 MIT，FastAPI 模板是 MIT），
   写在模板目录的 `SOURCE.md` 里 —— 别人的模板进了我们的仓库，出处不能丢。
2. **模板里不允许出现可执行脚本**（`postinstall` 之类一律禁止），与 §5.4 命令白名单的安全约束一致：
   模板是数据，不是代码。

**生成流程**

1. 在 `projects/.tmp/<jobId>/` 下生成。
2. **结构校验**：必需文件存在、可解析（`package.json` / `pyproject.toml` 能被 JSON/TOML 解析）。
3. 整体移动到 `projects/<slug>`（同名自动 `slug-2`）。
4. 写数据库（项目 + 工作流状态 + 任务清单 + 文档模板），**事务内完成**。
5. 触发依赖安装作业（可跳过）。

### 5.6 环境检测与自动配置

**检测**

- 用 `where.exe <tool>` 判定可执行文件位置，`<tool> --version` 取版本；每项 5s 超时；全部并行。
- 结果写 `env_snapshots`，并记录 `app_started_at`：若用户修改过环境变量，提示「**需重启本应用才能生效**」（Windows 下已运行进程不会收到新环境）。

**自动配置**

| 项 | 目标位置 | 合并策略 |
|---|---|---|
| 用户级 PATH | `HKCU\Environment` → `Path`（经 PowerShell .NET API） | **只追加不覆盖**；已存在的路径不重复添加；大小写与尾斜杠归一化后比较 |
| npm 镜像 | `%USERPROFILE%\.npmrc` | 逐行读取，**只增改 `registry=` 行**，保留其余内容与注释 |
| pip 镜像 | `%APPDATA%\pip\pip.ini` | 只增改 `[global] index-url`，保留其余配置 |

- 每次写入前把**原值完整快照**存入 `env_var_backups`（含「文件不存在」这一状态）。
- 回滚 = 用快照还原原值或删除新建文件。
- 三项**独立勾选、独立回滚**；**绝不写系统级变量**。

### 5.7 工作区迁移

**进入维护模式** → 拒绝所有写请求（`423 Locked`）。

```
1. 预检  目标可写 / 磁盘剩余 ≥ 源大小×2（fs.statfs）/ 目标不与源互为父子 / 路径长度
2. 冻结  迁移作业开启 → PRAGMA wal_checkpoint(TRUNCATE) → 关闭 DB 连接
3. 复制  robocopy <src> <dst> /E /R:1 /W:1 /NFL /NDL  → 解析进度
4. 校验  文件相对路径集合一致 + 逐文件 size 比对 + workspace.db 的 sha256 比对
5. 改写  项目 code_path：位于旧根内 → 改写到新根；位于工作区外 → 保持不变并列入报告
        （附件为相对路径，无需改写）
6. 切换  打开新库 → 试查询（SELECT 校验）→ 更新 config.json
7. 清理  仅在校验 + 试查询均通过后删除旧目录；删前在 backups/ 留一份 workspace.db 快照
8. 报告  同名冲突重命名清单（xxx_copy / xxx_copy2）、外部路径项目清单、耗时与文件数
```

**失败恢复点**：任一阶段失败 → 恢复维护模式前的状态、保留源目录完整、清理未完成的目标目录、前端给出可复制的手动命令。

### 5.8 搜索

- FTS5 外部内容表，索引 `tasks.title/description`、`tickets.title/description`、`documents.title/content_md`。
- 查询：`MATCH` + `bm25()` 排序，支持前缀匹配（`token*`）。
- 中文：写入前做**字符级切分预处理**（每个汉字作为独立 token），`unicode61` 分词器即可工作，不引入额外扩展。
- 结果按类型分组返回，附带高亮片段（`snippet()`）。

### 5.9 备份与导出

- 触发：应用启动时 + 每 30 分钟 + 迁移前，保留最近 **10** 份（`backups/`，命名含时间戳）。
- 备份实现：SQLite Online Backup API（`better-sqlite3` 的 `backup()`），而不是复制文件 —— 保证 WAL 下的一致性。
- 导出：`JSON`（全量结构化）+ `Markdown`（按项目生成目录树，文档为 `.md`，任务为 `.md` 表格）。
- 导出走作业系统（可能耗时），产物放用户选择的目录。

### 5.10 日志与诊断（v1.1 新增）

**日志管道**

```
写入方（统一 Logger）        脱敏管道              三路输出
  main   ─┐                                   ┌─ SQLite app_logs（结构化，供界面筛选）
  api    ─┤                redact()           ├─ 文本文件（轮转，崩溃后仍可整包取出）
  job    ─┼──▶ log(...) ──▶（强制，不可绕过）──┤
  renderer─┘                                   └─ 内存环形缓冲 ──▶ SSE 实时推送
```

**关键设计**

- **统一入口**：`logging/logger.ts` 暴露 `log(level, source, scope, message, detail?, ctx?)`，四个来源共用一条管道。**禁止任何模块直接 `console.log`**，用 ESLint 规则拦截 —— 否则日志必然散落各处、脱敏也必然被绕过。
- **traceId 贯通**：Fastify `onRequest` 为每个请求生成 `traceId`（注入 `request.id`）；作业创建时生成 `traceId` 并写入 `jobs`。二者透传到所有日志与错误响应的 `details.traceId`。前端拿到「错误码 + traceId」后请求 `/logs/context/:traceId`，**一步跳到现场**。
- **脱敏管道（强制、不可绕过）**：`logging/redact.ts` 在**落库与落盘之前**统一执行：`Authorization` / `Bearer xxx` / `token=` / `password=` / `Cookie:`、GitLab PAT（`glpat-`）、GitHub PAT（`ghp_`/`github_pat_`）→ `***`；工作区外路径中的用户名 → `%USER%`（可配置）。
  - 该函数**必须有单测覆盖**，另加一条集成断言：**任何写入路径都不允许绕过脱敏**。
- **双写与轮转**：`app_logs` 按天清理（默认 30 天）；文本文件按大小轮转（单文件 5 MB、保留 5 份）；`logging/rotate.ts` 在启动时与每 6 小时执行。
- **批量落库**：内存缓冲每 500ms 或累计 200 条 flush 一次，避免高频日志把 SQLite 写爆。崩溃时缓冲丢失可接受 —— 文本文件已同步落盘。
- **不建 FTS**：`app_logs` **不接 FTS5**。日志量大而查询模式固定（级别 + 来源 + 时间窗 + 关键词），用 `LIKE` 加 `(level, ts)` / `(source, ts)` 索引足够；建全文索引只会让写入变慢、库变大。

**前端与主进程接入**

- Vue `app.config.errorHandler`、`window.onerror`、`unhandledrejection` → 上报为 `source='renderer'`。
- `webContents.on('render-process-gone')`、`'unresponsive'`、主进程 `uncaughtException` / `unhandledRejection` → 记为 `source='main'`，并提示用户 + 提供导出入口。
- **白屏兜底**：由 Fastify 提供一张降级静态页（含错误摘要与「导出诊断包」按钮），前端资源加载或启动失败时展示。
- 错误 Toast / 错误页统一带「查看日志」按钮，跳转时自动带上 `traceId`。

**诊断包导出**

走作业系统（`export-diagnostics`）：打包**已脱敏**日志 + `env_snapshots` + 应用版本 + schema 版本 + 工作区结构摘要（仅相对路径）为 ZIP。**绝不打包项目正文、文档内容与附件**，可直接发给他人求助。

---

## 6. 前端设计

### 6.1 路由

| 路由 | 视图 | 里程碑 |
|---|---|---|
| `/setup` | 首次设置（创建 / 选择工作区） | M1 |
| `/` | 我的工作台（跨项目待办、逾期） | M2 |
| `/projects` | 项目列表 | M1 |
| `/projects/new` | **新建项目向导** | M4 |
| `/projects/:id/board` | 看板 | M1 |
| `/projects/:id/list` | 列表 / 表格 | M1 |
| `/projects/:id/calendar` | 日历 | M2 |
| `/projects/:id/tickets` | 工单 | M3 |
| `/projects/:id/docs` | 项目文档 | M3 |
| `/projects/:id/milestones` | 里程碑 | M1 |
| `/projects/:id/settings` | 项目设置（工作流、标签、模板、代码目录、Git〔M6〕） | M1 |
| `/docs` | 独立知识库 | M3 |
| `/search` | 全局搜索 | M2 |
| `/jobs` | ~~作业中心（进度、日志、取消、重试）~~ **已下线**：用户要求「不单独做一个模块」，能力并入「新建项目」向导（见 §41）。**接口保留**（`/jobs` 仍可用），只是没有页面 | M4 |
| `/logs` | **日志与诊断**（筛选、SSE 实时流、traceId 现场、诊断包导出） | M1 |
| `/settings` | 应用设置（工作区管理、环境、备份、日志、主题） | M1 |
| `/gantt` | 甘特图（项目内切换视图） | M6 |

### 6.2 状态管理（Pinia）

| Store | 职责 |
|---|---|
| `useAppStore` | 工作区、主题、全局偏好、维护模式状态 |
| `useProjectStore` | 项目列表与当前项目 |
| `useTaskStore` | 任务树、看板列、筛选、乐观更新与回滚 |
| `useTicketStore` | 工单、工作流状态 |
| `useDocStore` | 文档树与内容、自动保存 |
| `useJobStore` | 作业列表、SSE 订阅、日志缓冲 |
| `useEnvStore` | 环境检测结果、配置项与回滚 |

**乐观更新**：看板拖拽先改本地再发请求，失败回滚并 Toast 提示（拖拽体验的关键）。

### 6.3 关键组件

`KanbanBoard`、`KanbanCard`、`TaskTable`、`TaskTree`、`CalendarView`、`MarkdownEditor`、`DocTree`、`WizardSteps`（含 `EnvCheckPanel`、`StackForm`、`TemplatePicker`）、`JobCenter`、`JobLogViewer`、`WorkspaceSwitcher`、`MigrateWorkspaceDialog`。

### 6.4 API Client

- 统一封装 `fetch`：自动附加 Token、解析统一响应包、错误码 → 用户提示映射。
- SSE 封装为 `useJobStream(jobId)`：自动重连、按 `Last-Event-ID` 续传。

---

## 7. 安全设计

| 面 | 措施 |
|---|---|
| 服务暴露面 | 仅绑定 `127.0.0.1`；一次性 Token（每次启动重新生成）；校验 `Origin` |
| 渲染进程 | `contextIsolation: true`、`nodeIntegration: false`、`sandbox: true`；preload 只暴露白名单方法 |
| CSP | `default-src 'self'; script-src 'self'; connect-src 'self'`；**禁止加载远程代码** |
| XSS | Markdown 渲染结果经 DOMPurify 净化；文档中的原始 HTML 默认禁用 |
| 命令注入 | 白名单 + 参数数组 + 用户输入正则校验 + 永不 `shell: true` |
| 路径穿越 | 所有文件操作校验规范化后的路径必须位于允许根目录内 |
| 模板供应链 | 内置模板不使用 `postinstall` 等钩子；官方脚手架走官方源 |
| 环境变量 | 只写用户级；写前备份；可一键回滚 |
| 日志脱敏 | 落库与落盘**之前**统一过 `redact()`，不可绕过；Token / PAT / 密码 / Cookie 一律 `***`；诊断包导出前**二次校验** |

---

## 8. 测试策略

| 层 | 范围 | 工具 |
|---|---|---|
| 单元测试 | 模板渲染（占位符 / 文件名校验）、命令组装与白名单、PATH 合并算法、`.npmrc` / `pip.ini` 合并、迁移校验算法、作业状态机、FTS 查询构造、**日志脱敏正则（各类 PAT、边界与误伤用例）**、**traceId 生成与透传** | Vitest |
| 集成测试 | Fastify `inject()` + 临时 SQLite 文件，覆盖各资源 CRUD、分页、错误码、维护模式拦截 | Vitest |
| 文件系统测试 | 在 `os.tmpdir()` 下构造真实目录，验证生成落盘、迁移复制/校验/冲突重命名 | Vitest |
| E2E | 真实 Electron 界面流程（M6 起，非第一版范围） | Playwright |

**覆盖率目标**：`packages/server/src/services` 与 `jobs`、`scaffold`、`env`、`workspace` 目录 ≥ 80%；路由层以集成测试覆盖为主。

---

## 9. 构建与打包

- 构建工具：**electron-vite**（三个入口：`main` / `preload` / `renderer`）。
- `packages/server` 编译进 `main` 产物；`templates/` 通过 `asarUnpack` 解包保证运行时可读。
- **原生模块**：`better-sqlite3` 需按 Electron ABI 重建（`@electron/rebuild` / electron-builder 的 `install-app-deps`），并配置 `asarUnpack: '**/node_modules/better-sqlite3/**'`。
- NSIS 配置：`oneClick: false`、`allowToChangeInstallationDirectory: true`、创建桌面与开始菜单快捷方式、`perMachine: false`（避免需要管理员权限）。
- 用户数据目录：`%APPDATA%/pm-studio`。
- 环境要求：Windows 10 1809+（Node 20+ 运行时随 Electron 打包）。

---

## 10. M1 任务拆解

**基础设施**
- [ ] pnpm workspace 骨架、TS 配置、ESLint/Prettier、Vitest 配置
- [ ] electron-vite 三入口打通，开发环境热更新
- [ ] 单实例锁、窗口创建、托盘与最小化到托盘、退出确认
- [ ] AppData `config.json` 读写（原子写）
- [ ] preload contextBridge 白名单 + Token 注入

**日志与诊断（M1 必做，先于其余业务模块落地）**
- [ ] `logging/logger.ts` 统一入口 + `logging/redact.ts` 脱敏管道（**先写单测**）
- [ ] `logging/trace.ts`：请求与作业的 traceId 生成与透传
- [ ] `logging/store.ts`：内存缓冲 + 批量落库 `app_logs`
- [ ] `logging/rotate.ts`：文本文件按大小轮转 + 按天清理
- [ ] 主进程与渲染进程异常钩子接入（`uncaughtException` / `render-process-gone` / `window.onerror` / Vue `errorHandler`）
- [ ] 统一错误中间件写入 `source='api'` 日志并在响应里带 `traceId`
- [ ] ESLint 规则：禁止 `console.log` 直连
- [ ] `/logs` 系列接口 + `/logs/stream` SSE
- [ ] 前端日志页（筛选、实时流、详情、traceId 现场跳转）
- [ ] 错误 Toast / 错误页的「查看日志」按钮
- [ ] 白屏降级静态页
- [ ] 诊断包导出作业（`export-diagnostics`）

**服务端**
- [ ] Fastify 实例组装、统一响应包、错误处理、Zod 校验接入
- [ ] Drizzle Schema（M1 相关表）+ 迁移执行 + 启动自动备份
- [ ] DbConnection 单例与工作区切换
- [ ] 项目 / 任务 / 任务依赖 / 标签 / 里程碑 / 工作流状态 的 service 与 routes
- [ ] 看板排序（`sort_order` 重整）、批量操作
- [ ] 活动日志写入
- [ ] API 集成测试（临时 SQLite）

**前端**
- [ ] Vue3 + Router + Pinia + Naive UI 布局骨架（侧边栏、项目切换）
- [ ] API Client + 错误提示统一处理（自动附带 traceId + 查看日志入口）
- [ ] 项目列表与项目设置（工作流状态管理、标签管理）
- [ ] 看板视图（拖拽改状态与排序、卡片显示优先级与标签）
- [ ] 列表/表格视图（排序、筛选、批量编辑）
- [ ] 任务详情抽屉（子任务、依赖、描述 Markdown）
- [ ] 里程碑视图

**验收标准**
1. 从零启动 → 创建首工作区 → 新建项目 → 建多层子任务并设依赖 → 看板拖拽改状态 → 重启应用数据完整。
2. 关闭窗口不退出进程，托盘右键可退出；重复双击图标不会起第二个进程。
3. 单项目 5000 任务的看板拖拽与列表滚动流畅。
4. `services` 与 API 层测试通过，路由集成测试覆盖全部 M1 接口。
5. **日志验收**：任意界面触发一个错误 → Toast 显示错误码与 traceId → 点「查看日志」一步跳到该错误的完整现场（含堆栈与上下文）。
6. **脱敏验收**：单元测试断言 Token / PAT / 密码 / Cookie 在任何写入路径下都不落库、不落盘。

---

## 11. 实现细节中我直接定的值（可改）

| 项 | 取值 |
|---|---|
| 自动备份 | 启动时 + 每 30 分钟，保留最近 10 份 |
| 文档历史版本 | 保留最近 20 版（每 5 分钟或内容变化超过 500 字存一版） |
| 日期格式 | `YYYY-MM-DD`，本地时区（dayjs），截止日按本地 23:59:59 判定 |
| 日志保留 | `app_logs` 与 `job_logs` 均保留 30 天；文本日志单文件 5 MB、保留 5 份 |
| 日志默认级别 | `info`；设置里可切 `debug`，**切换即时生效、不需重启** |
| 白屏降级页 | 由 Fastify 内联 HTML 提供，**不依赖前端产物**，确保前端崩了也能显示 |
| 看板列排序 | `sort_order` 为千位间隔整数，重整阈值触发批量重排 |
| 回收站保留 | 30 天后可一键清理（不自动删除） |

---

## 12. M1 实现状态（2026-09-22）

### 已交付并验证

| 能力 | 验证方式 | 结果 |
|---|---|---|
| Electron + 内嵌 Fastify + Vue3 骨架 | 真机启动；日志显示界面与资源全部 200，前端成功调用接口 | ✅ |
| 单实例锁 | 连续启动两次：**第二个实例自行退出**，第一个收到 `second-instance` 并记日志 | ✅ |
| 关窗进托盘 | 向主窗口发 `WM_CLOSE`（等价于点 X）后**进程仍存活**，日志记录「已隐藏到托盘」 | ✅ |
| 托盘图标 | 6 条单测：非空（约 82% 不透明）、BGRA 通道顺序、圆角、三根竖条 | ✅ |
| 托盘右键菜单（唤回窗口 / 打开工作区 / 退出） | **用户实机确认**（2026-09-22）；这是唯一无法自动化的交互 | ✅ |
| SQLite 数据层与迁移 | 21 条单测 + 验收测试（WAL、外键、迁移幂等、级联删除） | ✅ |
| 项目 / 任务 / 标签 / 里程碑 / 工作流 API | 50 + 28 条单测 | ✅ |
| 看板 + 列表视图 | 真机加载；拖拽走单事务重排接口，乐观更新 + 失败回滚 | ✅ |
| 日志：统一入口 / traceId / 强制脱敏 / SSE / 诊断包 | 38 + 34 + 9 条测试 | ✅ |
| 5000 任务看板性能 | 实测 **56–62 ms**（阈值 1500 ms） | ✅ |

**测试总量 285 条 / 15 个文件；`tsc --noEmit`、`eslint .`、`electron-vite build` 退出码均为 0。**

### M1 期间发现并修复的缺陷

| 缺陷 | 影响 | 发现方式 |
|---|---|---|
| **脱敏对 JSON 转义路径失效** | 日志 `detail` 是最常见载体，而 JSON 把反斜杠转义成两个；只匹配单反斜杠的规则完全漏掉 → **用户名明文落库** | 给诊断包补「路径已脱敏」断言时暴露 |
| `Authorization: Token abc` 只抹掉方案名 | 真正的凭证完整留在日志里 | 写脱敏测试时发现 |
| **渲染层静态资源未注册** | 应用能启动但界面是 404；单测、集成测试、类型检查**全都看不见** | **真正启动应用**时发现 |
| `pendingMigrations` 在全新库上抛错 | 新建工作区的启动检查直接崩 | 数据层测试 |
| 子 logger 不共享级别与 sink | 运行时切 `debug` 只对部分日志生效，排查时严重误导 | 日志模块测试 |
| `z.coerce.boolean()` 把 `"false"` 转成 `true` | `?includeArchived=false` 反向生效（不报错、结果相反） | 写接口前自查 |
| 删除工作流状态前未迁移任务 | 任务 `status_id` 被外键置空 → 在按状态分列的看板上**静默消失** | 设计阶段识别，加了"先迁移再删除"的顺序约束 |

> 这张表本身就是一条结论：其中**两条只有"真的把应用跑起来"或"给已有功能补一个断言"才会暴露**，
> 代码审查与类型检查都抓不到。测试全绿不等于功能可用。

---

## 13. 任务创建流程与层级列表（2026-09-22 第二轮）

### 已交付并验证（全部为**真实渲染截图**，非 DOM 推断）

| 能力 | 验证方式 | 结果 |
|---|---|---|
| 显式创建对话框（7 个字段：标题 / 描述 / 状态 / 优先级 / 截止日 / 进度 / 上级任务） | CDP 截图 `create-task-dialog.png`，探针 `7 个字段 / 4 个输入框` | ✅ |
| 从抽屉创建子任务时的**归属可见** | 截图 `create-subtask-dialog.png`；探针读到归属条文本「这是 梳理现有页面与路由 的子任务 / 改为顶层任务」，`上级任务` 已预填 | ✅ |
| 列表三层子任务树 + 父行徽标 | 截图 `list-dark.png`；父行显示「1/2 子任务」，三层递进缩进，左侧箭头可展开/收起 | ✅ |
| 展开/收起全部、分页按主任务计 | 截图 `list-dark.png` 底部「共 10 个任务（7 个主任务）」 | ✅ |
| 新建项目类型选择弹窗（4 张类型卡片，取色器不再溢出） | 截图 `create-dialog.png`；探针 `4 个类型卡片 / 有取色器` | ✅ |

### 本轮发现并修复的缺陷

| 缺陷 | 影响 | 发现方式 |
|---|---|---|
| **截图脚本会"静默截到上一页"** | `location.hash = '#/projects'` 赋值后页面其实没切过去，脚本照样截图并打印"成功"。于是一张「列表页」被当成「项目弹窗」的验证证据 —— **假证据比没有证据更危险**，它会让人以为已核对过 | 用肉眼比对截图内容与探针输出，发现探针里出现的是列表页的按钮 |
| 探针选择器写错导致"0 个字段" | `.n-card__content .field` 里的 `.n-card__content` 并不存在（弹窗内容是 `NCard` 但字段不在 `n-card__content` 里），字段数恒为 0，看着像"弹窗是空的" | 同上 |
| 抽屉残留挡住后续截图 | 弹窗截图里混进上一屏的抽屉，无法判断画面主体 | 看截图时发现 |
| **断言因运算符优先级恒为真** | 探针写成 `A + B + (x ? "命中" : "未命中")` 时括号漏掉一处，`+` 比 `?:` 优先级高 → 整个拼接串成了条件（非空即真），**断言永远通过**。屏幕上"新子任务已挂在父任务下"照常打印，实际上没验证任何东西 | 比对日志时发现中间那两段探测结果（弹窗数、子任务数）没打印出来，顺藤摸瓜找到原因 |
| `Page.captureScreenshot` 偶发超时（20s） | 一次环境抖动就让整轮 12 张截图白跑，且容易被误读成"界面有问题" | 本轮实跑复现一次 |

**加固措施**（都在 `scripts/ui-shot.cjs`）：

1. `goto()`：导航后**回读 `location.hash` 并断言**，不一致就直接抛错终止，不允许产生无法定位到页面的截图；
2. `CLOSE_OVERLAYS`：每次导航前关闭抽屉/弹窗（`NCard` 默认没有关闭按钮，所以要补点"取消"、并派发 `Escape`）；
3. 依赖区探针改用栏目标题判断：`ul.deps` 在没有前置任务时**本来就不渲染**，用 `.deps` 会误报成"没有依赖区"；
4. **断言必须可证伪**：创建子任务那条检查在同一个探针里顺手查一个不存在的标题，日志会打印"（反例未命中，检查有效）"—— 恒真断言再也无法伪装成通过；
5. `screenshot()` 带 3 次重试 + `Page.bringToFront`：把环境抖动与真实缺陷区分开（CDP 响应按 id 匹配，迟到的响应会被丢弃，所以重试不会串帧）。

### 创建流程的端到端验证（不是只看弹窗）

只截到弹窗不能说明"创建真的能用、子任务真的关联上了"，因此脚本把整条流程跑完：

```
输入=[冒烟：补一条回归用例] → 已提交
→ 0 个残留弹窗 / 3 个子任务 / 新子任务已挂在父任务下（反例未命中，检查有效）
```

配套截图 `create-subtask-done.png` 显示：Toast「已创建子任务「冒烟：补一条回归用例」」、
抽屉「子任务 (3)」新增该条、看板卡片徽标从 `子 1/2` 变为 `子 1/3`、侧栏任务数 10 → 11。

> 与上一轮同一条结论：这些坑**任何单测、类型检查、代码审查都抓不到**，只有在"把界面截出来看"这一步才会暴露。
> 而本轮更进一步：**连"验证工具本身"也会撒谎** —— 截图脚本既可能截错页面，也可能写出一条永远为真的断言。
> 所以验证代码和产品代码一样需要被怀疑和自证。

---

## 14. 列表层级缩进与行点击冒泡（2026-09-22 第三轮）

用户实测反馈两条：**子任务标题与主任务平齐**、**点展开箭头/勾选框会弹出任务详情**。

### 根因（两条都不是"样式没调好"，而是依赖了不可靠的东西）

| 现象 | 根因 | 为什么以前没发现 |
|---|---|---|
| 三级标题完全同列 | 表格的树缩进由组件自己插入 `div.n-data-table-indent` 完成，渲染条件绑在 `childTriggerColIndex` / `hasChildren` 这些**内部判定**上；自定义 `render` 出来的标题单元格拿不到这段缩进。实测三级标题左边缘**全是 303px** | 之前只核对了"有没有展开箭头、有没有徽标"，没有量过标题的横向位置。肉眼看两张截图很容易觉得"缩进好像有一点" |
| 点箭头/勾选框弹出详情 | 行点击挂在 `<tr>` 上：`onClick: () => (openTaskId = row.id)`。展开箭头、勾选框、状态下拉、删除按钮的点击**全部冒泡到 `<tr>`**，于是"想展开子任务"顺手弹出了详情 | 之前的"点击测试"只测了"点一行能不能打开详情"，没测"点箭头时**不该**发生什么"。只验证正向路径，就必然漏掉误触 |

### 修法

1. 缩进改为**自己算**：`buildTree()` 里标出 `depth`（层级）与 `isLastChild`（是否同级最后），标题单元格用 inline `padding-left = depth * 24px`。
   同时把表格 `:indent="0"`，避免组件那套缩进与自己的叠加成"两级缩进看起来像四级"。
2. 层级用**连接线**画出来（竖线 + 拐角）：`isLastChild` 决定竖线画到一半还是画到底，否则最后一个子任务下面会拖出一截"其实没有后续"的线。
   线的容器用负外边距盖过单元格内边距，否则竖线会被内边距切成虚线。
3. 行点击改为**显式排除**行内交互元素：
   `.n-data-table-expand-trigger, .n-data-table-td--selection, .n-checkbox, .n-select, button, input, select, textarea, a`
   —— 用 `closest()` 判断，而不是去给每个子元素加 `stopPropagation`（新增一个控件就会再漏一次）。
4. `.title-cell` 用 `inline-flex` 而不是 `flex`：单元格是 flex 容器时 flex 项会被块级化（等价），是行内流时 `inline-flex` 仍与展开箭头同一行 —— 两种布局都不会突然换行。

**顺带排查同类结构**：看板卡片内没有可交互控件（"新建任务"按钮在卡片外），日志行没有行级 `onClick`（只有按钮各自的事件），
所以这两页不存在同一缺陷。这类问题应当按"可点击容器里有没有交互子元素"这个模式全库排查，而不是只修被报的那一处。

### 验证：先证明检查抓得住，再证明修复有效

这轮的操作顺序是刻意的 —— **先在未重建的旧构建上跑检查**，确认它真的会失败：

```
缩进：主任务 left=303 / 子任务 left=303 / 孙任务 left=303
点箭头：已点击箭头（10 行 → 7 行 / 抽屉 1 个 / 子任务行已收起）
点勾选：已点击勾选框（已勾选 1 个 / 抽屉 1 个）
点标题：已点击标题（抽屉 1 个 / 内容是点的那条）
→ 列表交互检查未通过：
    - 子任务标题没有和主任务拉开距离：主=303 子=303
    - 第二层子任务没有继续缩进：子=303 孙=303
    - 点展开箭头弹出了任务详情：抽屉 1 个
    - 点勾选框弹出了任务详情：抽屉 1 个
```

其中"点标题打开详情"这条在旧构建上**是通过**的 —— 说明它不是恒真断言。修复后：

```
缩进：主任务 left=327 / 子任务 left=373 / 孙任务 left=397   （每级 +24，子任务另加连接线 22px）
点箭头：已点击箭头（10 行 → 7 行 / 抽屉 0 个 / 子任务行已收起）
点勾选：已点击勾选框（已勾选 1 个 / 抽屉 0 个）
点标题：已点击标题（抽屉 1 个 / 内容是点的那条）
```

两个细节值得记下来：

- **检查要一次跑完再统一报错**。第一版是"一失败就抛异常"，结果缩进那条先炸，后面三条根本没被执行过 ——
  而**从没失败过的检查，和恒为真的断言没有区别**。改成收集全部问题再一起报，一次运行就拿到了四条检查都有区分能力的证据（见上面旧构建的输出）。
- **探针量错了对象**。缩进是用容器上的 `padding-left` 实现的，而 `padding` 在盒子**内部**，
  量容器的 `getBoundingClientRect().left` 永远是同一个值 —— 修好之后探针仍报"303 没有缩进"。
  改成量**标题文字本身**才量到真实位移。这是第二次栽在"探针写错但看起来在验证"上（第一次是 `+`/`?:` 优先级），
  所以这条经验固化成规则：**断言必须能量到一个会随修复而改变的具体数值**。

---

## 15. 任务删除规则：有子任务不允许删除（2026-09-22 第四轮）

规则：**主任务存在子任务时不能删除**；点删除时弹出警告，说明存在子任务、无法删除。

### 规则放在哪一层（三层都要，职责不同）

| 层 | 做什么 | 为什么不能只在别处做 |
|---|---|---|
| `softDeleteTask`（服务端唯一汇聚点） | 有未删除的直接子任务 → 抛 `CONFLICT`，错误里带 `childCount` | **界面拦截是可以绕过的**：批量接口、旧版界面、脚本调用都能直连服务 |
| 列表行 / 抽屉的删除按钮 | 点击时弹**警告**（单按钮），根本不发请求 | 服务端只会给错误码，说不出"你该先做什么" |
| 批量删除 | 先剔除有子任务的项；服务端再兜底跳过并回报 `skipped` | 批量里混进 1 个主任务，不该把另外 19 个也一起废掉；但**静默跳过等于假装删成功**，所以必须回报 |

### 被替换掉的旧行为

原来是"删主任务时把子任务**上提一级**"（返回值里的 `promoted`）。这个设计看着保守，实际是在一次删除里
**悄悄改写了层级**：用户以为自己只删掉一个任务，回头却看到几个子任务散落在顶层，而且没有任何提示说过这件事。
现在改为直接拒绝，把"先怎么处理子任务"的决定权交回用户。

- `promoted` 字段保留、恒为 0：不改动接口返回结构（没有消费者，但保持契约稳定）。
- `cascade: true`（显式整枝删除）**保持不变** —— 它的语义本来就是"我要删掉这一整枝"，按用户要求不动它。
- 项目删除不受影响：软删除项目不碰任务（另有显式的 `hardDeleteProject` 走外键级联）。

### 为什么警告用"单按钮弹窗"而不是确认框

`confirm()` 摆出两个按钮（取消 / 确定），语义是"你可以继续"。而"有子任务不能删"**没有第二个选择**，
所以新增了 `feedback.alert()`：只给一个「知道了」。验证时也因此用**按钮个数**判定（1 = 警告，2 = 可确认）——
只看文案是分不清的，文案完全可能写着"无法删除"却仍带着一个"确定"。

### 验证：依旧先证明检查抓得住

对**未重建**的旧构建跑，9 条删除规则检查全部失败，日志里能看到旧行为原样：

```
抽屉删除：按钮提示=[] → 弹窗按钮 2 个 / 删除任务「梳理现有页面与路由」有 2 个子任务。删除后子任务会**上提一级**保留下来…
列表删除主任务：按钮=没找到 → 弹窗按钮 0 个 / null
列表删除子任务：按钮提示=[null] → 弹窗按钮 0 个 / null
删除尝试后行数：10 → 10（不该变少）
→ 删除规则检查未通过：（9 条）
```

这份输出顺带暴露一个**既有瑕疵**：弹窗文案里的 `**上提一级**` 会原样显示成普通文字 ——
Naive 的弹窗内容不支持 Markdown。星号一直在界面上，只是没人盯过。新文案已去掉星号，
并加了一条断言专门盯它（`弹窗文案里出现了 Markdown 星号`）。

修复后：

```
抽屉删除：按钮提示=[有 2 个子任务，无法删除] → 弹窗按钮 1 个 / …还有 2 个子任务，无法删除。请先删除或移走这些子任务，再删除它。知道了
列表删除主任务：按钮=已变淡且有提示 → 弹窗按钮 1 个 / 同上
列表删除子任务：按钮=按提示定位 提示=[删除] → 弹窗按钮 2 个 / 确定删除「补一份发布说明」？…取消删除
删除尝试后行数：10 → 10（不该变少）
```

最后一条是防"边检查边改数据"：**被拒绝的删除必须什么都没发生**。只验证"弹了警告"是不够的 ——
弹警告的同时把数据删掉，是最糟的一种"通过"。

### 测试

新增 7 条，共 **292 条 / 16 个文件**：

- `tasks.test.ts`（服务层）：拒绝时不删任何东西、错误里带 `childCount`、子任务删完后父任务可删（避免死锁）、
  cascade 行为不变、批量跳过并上报。
- `routes-tasks.test.ts`（新文件，HTTP 层）：409 + `CONFLICT` + 文案含子任务数量、无子任务可正常删、
  cascade 仍整枝删、批量返回 `skipped`。

分层测的理由：真正拦住用户的是"路由有没有把异常转成 409、有没有把子任务数量放进响应"，
只在 service 层测，测不到界面拿到的是不是一句能看懂的话；而批量走的是另一个入口，必须单独覆盖。

### 两个自查

1. 检查脚本原先用 `forEach` 点掉弹窗里**所有**按钮来关弹窗 —— 在旧构建上那等于真的点了"删除"，
   会边检查边改数据、后面的结论全部作废。改成只点「取消 / 知道了 / 关闭」，
   并在每次关闭后**断言弹窗真的关掉了**（残留弹窗会让后面每条检查读到上一个弹窗的内容，又是一次假通过）。
2. 新增检查里有一条（"没有子任务的任务还能删"）原先按 `title` 定位按钮，导致它在旧构建上
   因为"工具提示还没实现"而失败 —— **失败理由不对，就等于没测到那个问题**。加了回退（按行内末位按钮定位）后，
   它测的才是"没子任务的任务能否正常删"这个真问题。

---

## 16. 品牌图标与打包（2026-09-22 第五轮）

需求：把用户给的图标（三条记录、每条前面一个标记、第三条标记被拉长）作为新的品牌标记，
生成符合项目风格的图标，然后打出安装包。

### 图标：一份几何，四处使用

标记要出现在**托盘、窗口/任务栏、界面左上角、exe 内嵌**四个地方。每处各画一遍，
迟早出现"托盘是一个样、装完是另一个样"。所以几何只在 `src/main/brand-mark.ts` 定义一次：

```
brand-mark.ts（几何 + 栅格化，不 import electron）
   ├── tray-icon.ts     → renderTrayBitmap / renderAppIconBitmap（BGRA，给 Electron）
   ├── window.ts        → 窗口与任务栏图标
   └── scripts/make-icons.ts → build/icon.ico + build/icon.png（打包用）
界面左上角用等价的内联 SVG（22px，与"小尺寸简化版"同一套比例）
```

主色用界面里的 `--pm-accent`（`#4c9aff`）纯色，不用渐变：界面里的品牌块就是这个纯色，
图标跟着走才"是同一个东西"；顺带也让托盘图标的断言能卡死"只有两种颜色"，通道顺序写反立刻暴露。

### 两种精度不是偷懒，是必须的

16×16 下 0.0376 的描边只有 0.6px，描边卡片会糊成一团灰。所以：

- **≥48px**：详细版 —— 三张描边卡片 + 卡内标记（与源图一致，256 上几乎一模一样）
- **<48px**：简化版 —— 三行"标记 + 实心长条"

比例是**照着源图量的**：源图的辨识度来自"卡片很高（约卡片宽的 1/4）、描边很粗（约卡片高的 1/5）"。
第一版我按"精致细线"画（描边不到卡片高的 1/5），放大一看跟源图完全不是一回事。

小尺寸还要**加粗骨架**（hinting）：16px 时 0.105 的条高只有 1.68px，抗锯齿后几乎没有纯白像素 ——
实测只剩 **12 个**，肉眼是一团灰。加上 `strokeWeight()` 后变成 **56 个**。这个数字是自检报出来的：

```
- 16×16 几乎没有白色前景（12px）—— 图案没画上去？      ← 第一版
  16×16  DIB  1128 B  简化版  不透明 71.9%  前景 56px  ← 加粗后
```

### 图标生成器：不引入依赖

`scripts/make-icons.ts`（`pnpm icons`）自己编码 PNG 与 ICO：

- PNG = `zlib.deflate` + 几个块（IHDR/IDAT/IEND）+ CRC32；
- ICO = 6 字节文件头 + 每项 16 字节目录 + 数据。**≤128 用 DIB，256 用 PNG** ——
  这是图标工具的通行做法，老工具链（rcedit 等）对 PNG 条目支持不一。
- DIB 的三个坑：像素**自下而上**、必须是 **BGRA**、信息头高度要写**两倍**（含 AND 掩码），
  掩码可以全 0 但**必须存在**（少了它行数就少一半）。

自检（不通过就非零退出）：每个尺寸都断言"不透明像素占比合理"且"**确实有前景**"——
一张全透明或纯色的图，Electron 不报错、打包也不报错，用户只看到一个空白方块。
另外输出 `icon-preview.png`：小尺寸放大 5 倍、两种精度并排 ——
**"小尺寸到底该用哪种精度"是靠眼睛定下来的，不是靠推理**。

### 打包

`packages/desktop/package.json` 的 `build` 段（`pnpm pack:dir` 出解包目录，`pnpm dist` 出安装包）：

| 配置 | 取值 | 为什么 |
|---|---|---|
| `npmRebuild` | `false` | better-sqlite3 已是 Electron ABI 的预编译产物；让 electron-builder 重建会去找 node-gyp/MSVC |
| `asarUnpack` | `**/*.node` | 原生模块不能从 asar 里 dlopen |
| `files` | 排除 `@pm-studio/**` | 两个 workspace 包被 electron-vite **打进主进程产物**了，不需要再发一遍源码 |
| `files` | 排除 better-sqlite3 的 darwin/linux/win32-arm64 预编译 | 目标只有 win-x64，实测省下约 **24MB**（8 个平台各 1.9–2.3MB） |
| `win.target` | `nsis` + `portable` | 安装版与免安装版 |
| `requestedExecutionLevel` | `asInvoker` | 不需要管理员权限 |

**依赖重新分类（有证据的）**：`electron` 被 electron-builder 硬性要求放在 `devDependencies`
（"only allowed in devDependencies"，直接报错）。顺着这条线索我核对了主进程产物里**真正被 require 的包**，
发现只有 4 个：`better-sqlite3`、`drizzle-orm`、`fastify`、`zod`。
`execa` / `electron-log` / `naive-ui` / `vue` / `pinia` / `vue-router` / `vue-draggable-plus`
在产物里**一次都没出现**（既无静态 require 也无动态 import）—— 渲染层那些已经被 Vite 打进 `out/renderer`。
所以把它们全部移到 `devDependencies`，`dependencies` 只留真正运行期需要的。
移动后重新构建，产物里的 require 目标**完全没变**，确认这次分类不是想当然。

### 踩到的三个坑

| 坑 | 现象 | 教训 |
|---|---|---|
| **`pack` 是 pnpm 的内置命令** | `"pack": "electron-builder --win --dir"` 被内置的 `pnpm pack` 吃掉，实际执行的是"打成 tgz"，仓库根多出一个 tarball 而没有任何报错 | 脚本名不能与包管理器内置命令重名。改成 `pack:dir` |
| **`files` 里的 `/**` 语义** | 排除非 win 平台预编译时写成 `darwin-*/**`，实际那些是 `prebuilds/` 下的**文件**而非目录，`/**` 要求后面还有一层，于是**静默没生效**（`win32-arm64.node` 那条因为写的是完整文件名，反而生效了） | 排除规则写完必须**回看产出目录**核对，不能只看命令退出码 |
| GitHub 下载抖动 | `nsis-resources` 下载 `ETIMEDOUT`，同时留下一个过期的解压状态 | 重试即可，electron-builder 会自行清理损坏缓存。另外：**未提权时探测网络会误判**（我的连通性探测跑在受限沙箱里，与打包进程的网络权限不同） |

### 验证：打包产物要真的跑起来

打包最容易"构建成功、运行时缺文件"。所以 `ui-shot.cjs` 支持直接指向打包后的 exe
（`isPackaged` 时不再传"应用目录"参数），拿它当打包验证工具用。
在 **`win-unpacked` 与免安装版**上各跑一遍完整检查，全部通过：

- 内嵌服务在 asar 里成功发出静态资源（界面渲染出来了，不是 404 白屏）
- better-sqlite3 从 `app.asar.unpacked` 正常加载（能建库、能灌数据）
- 缩进 / 点箭头 / 勾选 / 点标题 / 删除规则 / 创建流程 / 亮暗主题 全部一致

另外从产物里**提取内嵌图标**核对（`ExtractAssociatedIcon` → PNG → 肉眼看）：
`pm-studio.exe`、安装包、免安装版三个 exe 的图标都是新图案。

### 产物

| 文件 | 大小 | 说明 |
|---|---|---|
| `release/pm-studio-0.1.0-setup.exe` | 112 MB | NSIS 安装程序（可改安装目录、建快捷方式、按用户安装） |
| `release/pm-studio-0.1.0-portable.exe` | 112 MB | 免安装版，双击即用 |
| `release/win-unpacked/` | — | 解包目录（验证用） |

> **没有替你实际安装**：静默安装会在系统里留下程序目录、开始菜单与桌面快捷方式，
> 这属于改动你的机器，需要你同意。安装包本身的结构、图标、版本信息都已核对。

---

## 17. 待办（下一版本）：工作区边界收敛 —— 实施清单

> **状态：已在 0.1.1 执行完毕**（2026-09-23），实施与验证记录见 §18。
> 下面保留原始清单（含"改哪里"的定位），便于回溯当时的判断。

需求与理由见 `requirements.md` §13.1。**本版不动代码**，这里只把"改哪里"钉死，
免得下一版本开工时又要重新摸一遍。核对日期 2026-09-22。

### 核心问题一句话

**应用自身的运行日志，现在写在用户的业务数据库里。** `LogStore` 拿到的 `db` 就是工作区库的连接，
它在里面建 `app_logs` 表并持续写入（实测 452 行）。工作区本该是"用户数据的独立区间"，
所以这份日志要搬到 AppData。

### 改动点清单

| # | 位置 | 改什么 |
|---|---|---|
| 1 | `packages/desktop/src/main/index.ts:278` | `createLogStore({ db })` 现在传的是**工作区库连接** → 换成 AppData 下的独立库（或文件 sink）。这是唯一的"接线点" |
| 2 | `packages/server/src/logging/store.ts:136` | `APP_LOGS_DDL` + `ensureTable()`。已有 `ensureTable: false`（"由迁移负责"）的开关 —— **建表归属必须二选一**：要么迁移建、要么存储层自建，不能两处都建 |
| 3 | `packages/server/src/db/migrations.ts:234` 附近 | 工作区库的迁移里不再建 `app_logs` / `job_logs`（含 `workspace_meta` 的取舍，见 §13.1 审计表） |
| 4 | `packages/server/src/db/schema.ts:224` / `:277` | `appLogs` 表定义与 `schema` 映射：从"工作区库 schema"移到"日志库 schema"，或标为不属于工作区库 |
| 5 | `packages/server/src/services/diagnostics.ts:116` | 诊断包读取 `app_logs` / `job_logs` → 改成从新位置读。**这是最容易漏的一处**：日志搬走了、诊断包还在读旧库，导出会静默变空 |
| 6 | `packages/desktop/src/main/app-config.ts:288` / `:299` | `workspacePaths()` 去掉 `backups` / `jobLogs`；`ensureWorkspaceLayout()` 不再创建这两个目录 |
| 7 | `packages/server/tests/db.test.ts` | 双向 schema 漂移测试（定义 ↔ 迁移）：表搬走后要明确"哪张表归哪个库"，否则这条测试会因为两边对不上而误报 |
| 8 | `packages/server/tests/store.test.ts` | `createLogStore — 建表` 那组用例要跟着新的建表归属调整 |
| 9 | `db/migrations.ts`（tags）、`services/tags.ts`、`routes/tags.ts` | **收掉"全局标签"**：`project_id` 改 NOT NULL；删掉 `/tags` 全局管理接口与 `listTags` 的 `globalOnly` 分支；`or(eq(projectId), isNull(projectId))` 的查询条件改回纯 `eq`；`(IFNULL(project_id,''), name)` 的唯一索引改成 `(project_id, name)`。**2026-09-26 用户已定：移除这个设定**（决策记录 #27），与下一条的工单类型一起放在 **M3 的第一版迁移**里做（两份库都是 0 行，无数据迁移） |
| 10 | `db/migrations.ts`（ticket_types） | `ticket_types.project_id` 改 NOT NULL。**趁 M3 未落地改**，现在没有数据也没有界面，成本最低。**2026-09-26 已定**，与上一条同版迁移 |
| 11 | `db/schema.ts:187`（jobs）、作业列表接口 | 给 `jobs` 加 `project_id`（**可空**：`workspace-migrate` / `backup` 这类工作区级作业留空），作业列表默认按当前项目过滤 |
| 12 | `app-config.ts:299`（`ensureWorkspaceLayout`） | 附件目录落成 `attachments/<projectId>/`，从第一天就按项目隔离，别等 M3 写完再改布局 |

### ⚠️ 一个必须提前知道的迁移约束

**不能修改已经发布过的迁移文件**：`migrations.ts` 里的迁移带校验和，改一个字符，
已经跑过它的工作区（你机器上那个 `schema_migrations` 记了 1 条）就会校验失败。
所以上面第 9～11 条涉及表结构的改动，**一律新增一个迁移**（如 `0002_project_scoped_tags.sql`），
不要回头改初版迁移。同理，`logging/store.ts` 与 `db/migrations.ts` 里那两份 **必须保持一致的
`app_logs` DDL**，搬库时要一起改，否则新库与老库的表结构会悄悄分叉。


### 两个必须一起想清楚的点

1. **老工作区兼容**：这是破坏性布局变更。老库里会留下一张不再被写入的 `app_logs`（以及空目录
   `backups/`、`logs/jobs/`）。需要一个整理动作或明确提示 —— 与 **M5 工作区迁移**一起做，不要单独改。
2. **`attachments/` 与 `projects/` 留在工作区内**：它们属于用户数据，也是"便携包"的必要组成。
   一旦把代码目录挪到工作区外，"整个文件夹拷走即迁移"这句话就不再成立 —— 先把"便携"的边界定清楚。

---

## 18. 0.1.1 已实施：工作区只服务项目（2026-09-23）

用户要求（`requirements.md` §13.1）：**工作区是独立的区间，配置项不要放在工作区里**。
这一步把它落地。版本号：0.1.0 → **0.1.1**（四个 package.json 一起改）。

### 改了什么

| 位置 | 改动 |
|---|---|
| `app-config.ts` | `workspacePaths()` 只剩 `workspace.db + projects/ + attachments/`；`ensureWorkspaceLayout()` 不再建 `backups/`、`logs/`；新增 `appDataPaths()` 把应用自身的路径集中定义 |
| `app-config.ts` | 新增 `removeObsoleteWorkspaceDirs()`：清掉 0.1.0 留下的空目录 |
| `migrations.ts` | 新增 `0002_workspace_only_projects`：`DROP TABLE IF EXISTS app_logs` |
| `schema.ts` | 删除 `appLogs` 定义、`AppLogRow` 与 schema 映射条目 —— 这份 schema 描述的是**工作区库**，而工作区里不该有它 |
| `diagnostics.ts` | 应用日志改为**由调用方注入**（`options.appLogs`），不再从工作区库读 |
| `routes/logs.ts` | 导出诊断包时从日志库取日志；新增 `maxLogsFor()` 让取数与内部口径一致 |
| `connection.ts` | 新增 `migrate()`，配合 `open({ autoMigrate: false })`，把"整理 → 迁移"的顺序显式化 |
| `main/index.ts` | 日志库落在 `<userData>/logs/app-logs.db`（独立连接、不走工作区迁移）；启动时先整理再迁移；退出时一并关闭 |
| `legacy-logs.ts`（新） | 一次性把老工作区里的应用日志导出成 `<userData>/logs/legacy-app-logs.jsonl` |

### 三个刻意为之的决定

1. **先导出、再删表**。迁移只拿得到工作区库的句柄、够不到工作区之外的路径，所以搬运不能写在迁移里。
   桌面端启动顺序因此显式拆成 `open(autoMigrate:false) → 导出 → migrate()`。
   **顺序反了就是静默丢数据**：应用照常启动、日志页照常打开，只是老日志没了。
2. **不改 `0001_init`**：已应用的迁移带校验和，改一个字符老库就校验失败。所以是"0001 建、0002 删"，
   新库会白建一次再删，换来的是新老工作区最终状态一致（漂移测试也就不需要特殊分支）。
3. **清旧目录只用非递归删除**。`rmdir` 在目录非空时失败 —— 这个"失败"正是保护：
   0.1.0 从没往 `backups/`、`logs/` 写过文件，所以里面只要有内容，那一定是用户自己放的，
   宁可留着并告警，也不能递归删掉别人的数据。

### 验证（在**副本**上跑，不动正在使用的数据）

发现用户当时正开着打包好的 0.1.0（免安装版，4 个进程）。所以先把工作区用
`VACUUM INTO` 做一致性快照，再把 `config.json + workspace` 整体拷到 `.tmp` 下、
**把副本里的绝对路径改指向副本**，然后让 0.1.1 在这个副本上跑真实迁移。实测结果：

| 检查项 | 结果 |
|---|---|
| 老日志导出 | `logs/legacy-app-logs.jsonl` **596 行**（原库 `app_logs` 596 行，一条不差） |
| 工作区目录 | 迁移后只剩 `attachments/`、`projects/`、`workspace.db`；`backups/`、`logs/` **已消失** |
| 工作区库表 | 15 → **14 张，`app_logs` 已移除**；`job_logs`、`jobs` 保留 |
| 业务数据 | projects 8 → 9、tasks 17 → 27（多出来的是截图脚本灌的示例项目）—— **原有数据全在** |
| 迁移记录 | `schema_migrations` = **2**（两条迁移都已应用） |
| 新日志库 | `logs/app-logs.db` 已建并写入；日志页读到 **42 行**（走的是新库） |

自动化测试：**311 条 / 18 个文件**全绿（新增 `legacy-logs.test.ts` 7 条、`workspace-layout.test.ts` 7 条，
`db.test.ts` 把"app_logs 索引已建立"改成**反向断言**"工作区里不该有 app_logs"）。
界面回归：完整交互检查（缩进 / 箭头 / 勾选 / 删除规则 / 创建流程 / 亮暗主题）全部通过。

### 这次踩到/发现的两个真问题

1. **`config.json` 里存的是绝对路径**。把 userData 拷成副本后，副本的 config 仍指向**原始工作区** ——
   直接跑就等于拿用户的实时数据做迁移实验。必须改副本里的路径。（差点踩到，靠"先看清再执行"拦下。）
2. **打包版的 userData 目录名是 `@pm-studio/desktop`**，不是 `pm-studio`：
   Electron 读 package.json 的**顶层** `productName`，而我们的 `productName` 写在 `build` 段里，
   于是回落到 `name`。表现是安装包/快捷方式叫 `pm-studio`、数据目录却叫 `@pm-studio\desktop`。
   **本次刻意不动它** —— 一旦改 `app.getName()`，`%APPDATA%` 下的数据目录就换了，
   用户会看到"我的数据不见了"。要改就得配套一次数据目录迁移，另开一条。

### 还没做（下一步）

`requirements.md` §13.2 的项目间共享口子（全局标签、全局工单类型、`jobs` 缺项目字段、附件目录布局），
以及备份路径的实际接线（`appDataPaths().backups` 已定好位置，但自动备份功能本身还没实现）。

---

## 19. 0.1.2 已实施：一个项目一个文件夹，数据库移出工作区（2026-09-23）

用户要求：**"我需要的是这个文件夹只装项目"** + **"创建项目时在工作区里新建一个文件夹，
项目就在里面工作，文件夹内有一套项目需要的东西（模板、报错日志等）"**。

### 最终形态

```
%APPDATA%\@pm-studio\desktop\
├─ config.json  logs\  Cache\ …        ← 应用自己的
├─ data\
│  └─ workspace.db                     ← 管理数据（登记、任务、看板、标签）
└─ workspace\                          ← 工作区：打开只看到项目
   ├─ 我的项目A\                       ← 代码在这一层（模板生成是 M4）
   │  ├─ attachments\
   │  └─ logs\                         ← 该项目的作业输出与相关错误
   └─ 我的项目B\
```

### 设计决定（都写在代码注释里了，这里列结论）

| 决定 | 理由 |
|---|---|
| 管理数据放 `data/workspace.db`，**不在工作区里** | 用户打开工作区目录时只应看到自己的项目；顺带也让"工作区"变成一个纯粹的、可以整体拷走的项目目录 |
| 文件夹名由项目名清洗而来，**建好后不再改** | 用户是在资源管理器里认文件夹的；项目改名去搬动磁盘目录是"数据不见了"那一类事故 |
| **删除项目不删文件夹** | 里面可能已经有用户自己写的代码或附件，递归删目录不可逆 |
| 附件与日志的子目录**从第一天就建好** | 否则以后又要为"日志到底放哪"再做一次迁移 |
| 项目文件夹**不认领**已存在的同名目录 | 那个目录可能是用户自己建的；冲突时退到 `<名字>-2` |
| 老项目在启动时补建文件夹，**还原项目时也补** | 只建"还活着（含归档）且没有文件夹"的；已删除的不碰 |
| 打开文件夹的 IPC **只接受项目 id** | 路径由主进程查库拼出并再校验一次"落在工作区内"，渲染进程递来的路径一概不采信 |

### 两个必须按顺序做的迁移

1. **数据库搬家**（`storage-move.ts`）：`<工作区>/workspace.db` → `<userData>/data/workspace.db`。
   关键是**先做 WAL 检查点再改名** —— 否则还在 `-wal` 里、尚未合并的写入会留在孤儿文件里，
   表现为"搬完之后最近几条数据不见了"，而且 `-wal` 还杵在工作区里，两件事都没做成。
   搬不动（文件被占用等）时**继续用老路径并记警告**，不让启动失败。
2. **补建项目文件夹**（`ensureProjectFolders`）：在服务就绪后、监听之前跑，失败也不阻断启动。

迁移 `0003_project_folder` 给 `projects` 加 `folder` 列。注意 SQLite 的
`ALTER TABLE ADD COLUMN` **没有 `IF NOT EXISTS`**，靠"每条迁移只执行一次"保证不重复加列。

### 验证

- **338 条测试 / 20 个文件**全绿：新增 `project-folders.test.ts`（23 条，含名字清洗、去重、补建、
  删除保留、还原补建）、`storage-move.test.ts`（6 条，含**"数据只在 WAL 里"**这条关键场景 ——
  造法是：保持连接打开时把 .db/-wal/-shm 整体拷走，让副本的主库停在插入之前，数据只存在于它的 `-wal` 里）。
- **隔离目录实跑**：脚本新建项目后，工作区里出现 `前端重构\{attachments,logs}`，
  管理数据落在 `data\workspace.db`，界面项目卡片上多出一行「📁 前端重构/」与"打开项目文件夹"按钮。
- **真机迁移**：用户的工作区里数据库已搬到 `data/`，三条迁移全部应用；
  8 个项目**全在回收站**，所以按设计没给它们建文件夹（只处理还活着的项目）。

### 一个需要你知道的后果

数据库移出后，**"整个工作区拷走 = 迁移"这条不再成立**：要同时拷 `workspace\` 与 `data\workspace.db`。
用户当时在 A/B/C 三个方案里选了 A（同级 `data\` 文件夹），代价就是这一点。
如果以后要"一键迁移"，得另做一个"导出工作区"的打包功能（把两者打成一个文件）。

## 20. 0.1.3 已实施：视图结构改为「总览 + 工作台」（2026-09-24）

### 用户要求（原话）

> 「容器卡加子任务环绕这个想法可以保留，但他只用作展示任务与任务之间的关系……
> 这个需要新的页面，可以设计一个页面总览，在页面中可以看见当前项目的总任务数量，
> 主任务数量、主任务数量完成量、子任务数量、子任务数量完成量等数据。
> 这个环绕效果我想做出 3D 效果（如果实现困难就暂时不考虑 3d 效果）。
> 看板样式继续重构，看板也需要改一个合适的名称，这里做任务的增删改查的功能」

第二轮又追加：

> 「改总览的数据图，我想要的确实是六边形，但我希望任务与任务之间是有用线链接，
> 而且样式做的太丑；改任务台为工作台，这里的主任务与子任务不要用线链接了，
> 且不要分四个大类，任务状态之间在任务卡片中用标签展示，或者其他形式，
> 任务点开详情时需要做点击空白位置也能关闭详情」

### 最终形态：两页

| 页面 | 职责 | 关键实现 |
|---|---|---|
| **总览** | 项目现在什么情况 | 4 张统计卡 + **六边形关系数据图** + 右侧四个面板（状态分布 / 完成度 / 里程碑 / 被前置卡住） |
| **工作台** | 任务的增删改查 | **单一任务树**（缩进表达层级）、状态用**卡片上的标签**并可点击切换、虚拟滚动、搜索、只看主任务、删除规则 |

「看板（按状态分列）」和「列表」两页被**删除**（`BoardView.vue`、`ListView.vue`、
`TaskItem.vue`、`FolderIcon.vue`）。`#/board`、`#/list` 两条老路由重定向到工作台 ——
日志里的深链、书签、以及别人写好的自动化脚本都会落到新页面上，而不是 404 退到项目页。

### 设计决定（都写在代码注释里了，这里列结论）

| 决定 | 理由 |
|---|---|
| 状态**不做成分列**，改成卡片上的标签 | 状态是每个项目自定义的工作流（可以 6~8 个），分列会把一屏切成很多窄条；更糟的是子任务会因状态不同被拆到不同列里，**父子关系随之散掉**。标签化之后同一棵子树始终待在一起（详见 requirements §5.5） |
| 工作台里父子**只用缩进**，一根线都不画 | 用户明确要求。探针里因此有一条**几何断言**：工作台内不存在"绝对定位、宽 ≤2px、高 >12px"的竖向元素，也没有 `cord/connector/guide/rel-` 类名 |
| 关系线只出现在总览的图里 | 两页分工：工作台管"量与改"，总览管"关系" |
| 总览的地图六边形**画在格子之上** | 蜂窝是紧贴铺满的，线画在下层时整段压在六边形底下 —— 元素在、长度也不为 0，但**看不见**。第一版就是这样，探针量到连线长度只有 69px 才发现 |
| 依赖弧**弓到格子外面**、端点退到格子边缘 | 相邻格子的中心距 < 六边形宽度，直线整段被盖住；弓高取"格子外接半径"量级，弧顶才跑到格子外面，箭头也才落在目标格子的边上 |
| 六边形半径按**面板实际尺寸**反算 | 原先写死"整张图 350 设计像素"，结果 7 个主任务的图只占面板三分之一、旁边一大片空白。改成按容器尺寸算（纵向要按 `1/cos(倾角)` 放大，因为盘面是斜的），并保留下限 4px 防止超大项目重新线性膨胀 |
| 3D 用两个 CSS 变量驱动整盘 | `--ov-spin` / `--ov-tilt` 由盘面读来做 `rotateX/rotateZ`，六边形卡片读**同一个变量**做反向补偿保持正立 —— 旋转时零 JS 逐元素更新。`preserve-3d` 逐层都要写：漏一层卡片会被压两次 `cos·cos` |
| 依赖边一次拿全项目 | `GET /projects/:id/dependencies`（新增了 `tasks.projectDependencies` 包装）。逐个任务调是 N+1：几百个任务的图上首屏几百次往返 |
| 详情抽屉的三个关闭入口全部显式声明 | 遮罩点击 / Esc / × 都写出来，不依赖 Naive 的默认值（`mask-closable`、`close-on-esc`）。用户明确要求"点空白位置也能关闭"，而这类默认值变更过一次 |

### 实现过程中发现并修掉的真问题

1. **折叠不生效**（工作台）：`rows` 末尾有一段兜底 —— "父任务不在列表里的行按顶层补上"，判据是 `!seen.has(id)`。而折叠剪枝是**先 return、子孙没被标记为已访问**，于是兜底把它们当成孤儿又以顶层身份塞了回来：点"收起"子任务还在。修法是折叠时用 `markSeenDeep` 把整棵子树标记为已访问。
2. **`tasksApi` 用了却没 import**（总览）：`endpoints.ts` 没有依赖接口的包装，子代理为了不越界在页面里直连了 `getApiClient()`；我把它挪进 `endpoints.ts` 的 `tasks.projectDependencies` 时删掉了那个 import，却没补上 `tasks as tasksApi`。
3. **`dx/dy` 被删掉却还在用**（总览）：同一处改动里我自己犯的、和上一条同类的错误。
4. 上面 2、3 两条**都不是 tsc/eslint 能发现的**：仓库里没有 `vue-tsc`，也没有 `eslint-plugin-vue`，`.vue` 文件既不被类型检查也不被 lint。所以 UI 探针里加了一个**页面错误陷阱**（`window.onerror` + `unhandledrejection` + 包装 `console.error`）—— Vue 的事件处理器抛异常时只打一条 `console.error`，页面上表现为"点了没反应"，没有这个陷阱就只能看到"状态没变"，看不到为什么。
5. 探针里两条**写死数据的断言**改成从界面读数：`还有 2 个子任务` 在第二次运行时假失败（测试目录会累积数据，而且"从抽屉新建子任务"那一节是真的建了一条）。改成从卡片上的「子任务 N」读出真实值再比对，顺便验证了警告里的数字是对的。

### 验证

- `tsc --noEmit`（仓库根，覆盖 shared/server/tests）**0 error**；`tsc -p packages/desktop/tsconfig.json --noEmit`（渲染层）**0 error**；`eslint .` **0 问题**。
  ⚠️ **根 tsconfig 的 `exclude` 里有 `packages/desktop`** —— 只跑根那一条等于不检查渲染层。渲染层要单独跑上面第二条（但 `.vue` 仍然查不到，见第 4 条）。
- **373 个测试 / 23 个文件全过**（`vitest run`）。
- **UI 探针 `scripts/ui-shot.cjs` 全绿（exit 0）**，且这次新增的断言逐条对应上面的要求：
  - 总览：4 张统计卡；六边形格子数 > 0；**依赖连线数 > 0 且最长 > 20px**（元素在但长度为 0 同样算没画出来）；图表区域里存在 `m22 < 0.95` 的元素（3D 倾斜**确实生效**）；点六边形下钻后出现 >1 张六边形卡片且**父子连线 > 0**；Esc 返回地图。
  - 工作台：行数 > 0；**状态标签数 == 卡片数**（状态确实在卡片上）；**没有分列容器**；**没有竖向连线元素**（几何 + 类名两条判据）；三层缩进 284 / 302 / 320；点展开横条 12 行 → 7 行且**不弹详情**；点卡片弹出详情且**内容就是点的那条**；**点空白处关掉详情**；删除规则（主任务 → 单按钮警告且数量与界面一致；叶子 → 两按钮确认；操作后行数不变）。
  - 其余原有检查（项目卡片、新建项目/任务弹窗、抽屉真实数据、从抽屉新建子任务、创建流程、亮色主题）全部保留并通过。

### 已知缺口（登记，不假装有）

1. **"挡着几个后续"的徽标没做**：`TaskDto` 只有 `blockedByCount`（未完成的前置数），没有反向计数；后续数只在 `TaskDetail.successors` 里，逐行拉详情不可行。要补得在服务端 `TaskDto` 上加 `blockingCount`（和 `blockedByCount` 同一处 SQL 就能出）。
2. **里程碑进度算不出来**：`TaskDto` 没有里程碑字段，schema 里也没有任务↔里程碑的关联表，`MilestoneDto` 自身也没有任务计数。总览那一栏因此只显示里程碑自身的状态（名称、截止、是否达成）与「已达成 N/M」，并在界面上如实写明"任务还没有和里程碑建立关联"。**没有摆一根假进度条。** 要做真进度需要加字段或关联表。
3. **拖拽**（改状态 / 改归属 / 排序）按之前的分期留到第二期。
4. **回收站 UI** 仍未做（删除是从看板移除，`restore` 接口在但没界面）。
5. 工作台的卡片标题**强制一行**（超长省略，全文在 `title` 属性与详情里）：行高因此只有 `leaf`/`parent` 两个变体，虚拟滚动的偏移才能按变体缓存。要让主任务标题折两行的话，变体变成 4 种，缓存与二分仍成立，但要相应放宽 `HEIGHT_ESTIMATE`。

## 21. 0.1.4 已实施：工作台改成分层空间（2026-09-24）

### 用户要求（原话 + 标注图）

> 「主任务框，点击后进入新页面」／「鼠标悬停时出现，通过动画从右往左滑出的效果」
> ／「点击按钮弹出主任务详情框」／「子任务框，在点击这个子任务的主任务框后出现」
> ／「黑色箭头表示子任务卡片的移动轨迹，当点击主任务后，主任务自动到新页面的左上角，
> 然后子任务卡片从主任务的位置一个个移动到他们的位置」
> ／「绿色框表示有两种状态，当在主任务外层时，点击则是展示子任务，若在主任务内层，则点击会返回上一层」

### 最终形态

| 位置 | 行为 |
|---|---|
| **外层（第 0 层）** | 只列**主任务**，网格卡片；工具条是「搜索 + 面包屑 + ＋新建任务」 |
| **悬停一张卡** | 卡片右侧**滑出一个「详情」按钮**（`translateX(100%)`→`0` + 淡入，绝对定位不占布局）；点它打开详情抽屉 |
| **点卡片本体** | **进入它的下一层**（不再是开详情） |
| **层内** | 被点的卡成为**左上角的"锚卡"**（`.wb-card.pinned`，强调色边框 + 淡强调底色 + 「点它返回上一层」提示），**只占一个普通格位**，它的子任务在右边与下面接着铺 |

> 锚卡一开始做的是"占满第一行"（更醒目、标题更完整），但用户的标注图画的是
> **主任务在左上角、子任务在它右边和下面**，于是改成一个普通格位。
> 顺带解决一个更实际的问题：**空层**（点没有子任务的卡）时页面上只有一条横条，
> 看着像排版坏了。
| **返回上一层** | 点锚卡，或点面包屑里任意一段 |
| **可一直下钻** | 主 → 子 → 孙 …；**没有子任务的卡点击也进层**（空层，只有锚卡） |
| **搜索** | 非空时列扁平结果（带"属于「X」"），点一条**跳到它所在的那一层并闪一下**，同时清空搜索框 |

### 动画（这次的重点）

用 **Web Animations API**，不用 CSS 类切换：要按元素实测位置算位移、还要按索引错峰，`element.animate` 最直接。三条规矩：

1. **换层的执行顺序不能变**：① 换层**之前**量要移动那张卡的矩形（换层后就找不到了）→ ② 改 `path` 并 `await nextTick()` → ③ 量所有要动的元素的**最终位置** → ④ 才开始播动画。先播再量会量到动画中途的位置。
2. **`fill: 'backwards'` 是必须的**：错峰期间元素要先停在第一帧（透明、缩小），否则它会先以最终样子闪一下再开始飞。
3. **位移按中心点差算**，不按左上角差：锚卡通常比被点的卡更宽，按中心对齐才像"同一张卡移动 + 缩放"。

进层 = 锚卡从被点位置飞过去（320ms）＋ 子任务从**锚卡的最终位置**错峰飞出（每张 +55~70ms）。退层/跳层没有"同一张卡跨层移动"的完整位置关系，所以整组淡入（允许简化，但**不允许"卡片凭空消失又出现"**）。测不到起点时（从搜索结果跳层）用轻微放大淡入兜底。`prefers-reduced-motion: reduce` 下所有动画时长归零。

### 去掉的东西（分层之后没有意义了）

虚拟滚动、全部展开/折叠、只看主任务。**扛量问题由分层本身解决**：外层最多是"主任务数"（通常几十），每层最多是"一个任务的直接子任务数"，不再需要一屏渲染几百行；工具条读数如实显示 `本层 N 张 · 项目共 M 个任务 · DOM 里 K 张卡片`。

### 追加调整（0.1.5 ~ 0.1.7，都在同一次改造里）

**① 第一格不再是"那张任务卡"，而是一张纯「返回上一级」卡**（0.1.7）

用户原话：「主任务点开后，第一格直接变成返回上一级的卡片，其他都不要显示在卡片上」。

改法是把它做成**独立元素**（`.wb-back-card`，不是任务卡）：没有状态点、没有标题、没有进度、没有标签、没有状态标签，只有图标 + 一行字，虚线边框暗示"这是导航不是任务"。
**"什么都不显示"靠结构保证，而不是靠条件隐藏字段** —— 探针因此能断言"这张卡里的任务信息元素个数为 0"，这条断言不会因为以后有人给任务卡加字段而失效。

跨层动画的起终点跟着换了：进层时移动的是**这张返回卡**（从被点的卡片位置飞过去），退层时反过来（从返回卡飞回那个任务在上一层网格里的位置）。`navigate()` 的参数因此从 `movingId` 改成 `{ from, find }` —— 因为**换层前后不是同一个 DOM 节点**了，起点必须在换层前量、终点在换层后量。

**② 「详情」入口改成纯图标**（0.1.6）

用户给了图案（三行"实心圆点 + 圆角横条"）并要求"不需要按钮的样式"。做法是**手绘成矢量**加进 `AppIcon`（名字 `detail`），不是塞位图：位图不跟主题色、不能随字号缩放，而项目里所有图标都是 `currentColor` + 自绘 path。
注意它**混用填色与描边**：圆点是 `fill="currentColor" stroke="none"`，横条是描边 —— 根节点上是 `fill="none"`，只写 path 的话圆点会变成空心的圈。
按钮本身去掉了边框/底色/文字（探针断言 `text === '' && !hasBorder && !hasBg`），点击区域靠透明 padding 撑出来。

**③ 两条工程教训（都不是应用缺陷，但都会浪费一轮）**

- **硬杀应用会留下单实例僵尸锁**：`Stop-Process -Force`（TerminateProcess）之后，`<userData>\lockfile` 会留在原地，之后每次启动都被判成"第二个实例"并**直接以退出码 0 退出**（界面上看起来就是"程序起不来"）。日志里只有一行 `检测到第二个实例启动，已唤回已有窗口`，而进程列表里什么都没有 —— 非常容易误判成启动崩溃。**清掉那个 lockfile 即可恢复**。以后重启应用优先走托盘菜单退出，别硬杀。
- **打包不要依赖网络下 Electron**：`electron-builder` 自己的缓存里没有 Electron 时会去下载（约 110MB），网络一抖就是 `read ECONNRESET` 打包失败。加 `"electronDist": "node_modules/electron/dist"` 用装好的那份，顺带保证"打包用的运行时 = 本地验证过的运行时"。

### 打包：改用本地 Electron 运行时（不再依赖网络）

原来的打包每次都会去下载 Electron 的 zip（`node_modules/.pnpm` 里那份是给开发/测试用的，electron-builder 用自己的缓存）。这次正好卡在下载上：`read ECONNRESET`，打包失败 —— 而 NSIS 那些工具早就在缓存里了。

修法是在 `build` 里加一行：

```json
"electronDist": "node_modules/electron/dist"
```

让它直接用**包管理器装好的那份解包 Electron**（也是开发与测试跑的那一份）。好处有两个：打包不再依赖网络，且**打出来的运行时与本地验证过的是同一份**。（注意这个路径走的是 pnpm 在包内建的软链，不要写成 `.pnpm/electron@…_supports-color@…` 那种带 peer 后缀的真实路径 —— 装一次依赖就变了。）

### 发现并修掉的问题

1. **`ResizeObserver loop completed with undelivered notifications` 被当成应用错误上报**。根因在总览页的观察器：它每次回调都 `chartSize.value = { w, h }` —— **尺寸没变也新建对象赋值**，于是触发重渲染、改布局、再次触发观察器。用户会在日志页看到一条 ERROR，错误横幅也可能被点亮，真问题被噪音淹没。修法是**先比再赋值**，并把观察器回调推迟一帧；同时 `api/report.ts` 里加了一条**窄过滤**（只滤这一条明确无意义的浏览器告警，其余一律照常上报）。UI 探针也做了同样的区分：无害告警记到 `__warns`（打印但不判失败），真错误进 `__errs`。
2. **探针自己制造过两次假失败**，都记进注释了：① 用 `dispatchEvent(new MouseEvent('mouseenter'))` 测悬停 —— 合成事件不走浏览器命中测试，**永远触发不了 CSS `:hover`**，必须用 CDP `Input.dispatchMouseEvent` 真实移动鼠标；② 锚卡点击那次"没反应"其实是前一步状态不对导致的连锁假失败，现在探针会在点击无效时**再试一次键盘回车**（同一个入口），把"事件没进来"和"处理逻辑没生效"分开。

### 验证

- 根 `tsc --noEmit`、渲染层 `tsc -p packages/desktop/tsconfig.json --noEmit`、`eslint .` 全部 **0 问题**；`vitest run` **373 个测试全过**。
- **UI 探针 `scripts/ui-shot.cjs` 全绿（exit 0）**，新增断言逐条对应上面的要求：
  外层只出主任务、每张卡有状态标签、面包屑存在、外层无锚卡；悬停时「详情」按钮 `opacity 0 → 1`、**在卡片右半边且不越出卡片**（并且断言"未悬停时是隐藏的"，证明这条检查有区分能力）；点它打开的抽屉内容是那张卡；点空白处能关掉；进层后**锚卡就是被点的那张且贴在网格左上角**、层内出现子任务卡、面包屑变长；**再钻一层**（验证多层）后逐层退回：点锚卡 3 段→2 段、点面包屑回外层；搜索有结果；**全程页面无 JS 报错**。

---

## 22. 0.1.8 已实施：叶子任务不进层 + 折叠侧栏色块错位（2026-09-24）

### ① 没有子任务的卡片不再"点得进去"

用户原话：「在工作台中，判断任务下方是否存在子任务，如果不存在则不用点进去」。

- **判断依据是接口给的 `childCount`**（`hasChildren()`），不是"本层网格里有没有它的子卡"。进不进层是任务自己的属性，跟当前在第几层、有没有在搜索都无关；只有一处真相，卡片底部"没有子任务"的文案、进度条、能不能进层全看同一个字段。
- **拦两道**：`drillIn()` 开头直接 `return`（不管谁调都拦住），`onCardActivate()` 里叶子卡改走 `flashCard()`。**点一下要闪一下** —— 完全没动静会让人以为界面卡了，然后反复点。
- **样式**：`.wb-card.is-leaf { cursor: default }`，悬停提示改成「没有子任务，不进层；点右下角图标看详情」。悬停时的边框/底色反馈**保留**：它现在的含义是"你在看这张卡"（「详情」图标正是靠悬停滑出来的），换成"不可交互"的灰扑扑样式反而把唯一的入口也一起弱化了。
- **代价（明说）**：叶子卡本体不再有任何进入动作，唯一去处是悬停出现的「详情」入口。
- **连带作废一条旧设计**：0.1.4 里"没有子任务的卡点进去是空层（只有返回卡）"—— 现在不存在空层了。

### ② 折叠侧栏的色块错位（用户报"折叠后色块显示 bug"）

现象：折叠后选中项那个圆角色块还在侧栏中间，图标却骑在色块**右边缘**上、半个身子探到色块外面。

用 CDP 读 DOM 矩形量出来的数字（临时诊断脚本，不是靠看截图猜）：

| 元素 | 改前 | 改后 |
|---|---|---|
| 菜单盒 | x=12，宽 40 | x=0，宽 64 |
| 选中色块（`::before`） | 中心 x=32，宽 24 | 中心 x=32，宽 48 |
| 菜单图标 | 中心 **x=44**，右沿 54 | 中心 **x=32**，右沿 42 |

**根因**：Naive 的折叠菜单是拿 `collapsed-width`（64）算图标居中的 —— 它**假设菜单自己就占满整条侧栏**（`padding-left = (64-20)/2 = 22`）。而 `.sider` 有 `padding: 14px 12px 12px`，菜单实际只有 40px 宽、起点在 x=12；色块（`::before` 的 `left/right: 8px`）跟着 40px 的盒子走，中心还是 32；图标却按 64 算，中心落到 12+22+10=44。两者对"侧栏有多宽"的假设不一致，图标就骑到色块边上去了。

**修法**：折叠时把 `.sider` 的左右内边距清零（新增 `.sider.compact`）。菜单重新占满 64px，两边假设一致：色块 8..56、图标 22..42，中心都在 32。品牌标记（`.brand.compact` 居中）与底部按钮本来就按整宽居中，中心仍是 32，**视觉不变**（已逐像素核对过底部那一颗按钮：图标 x 25..38，中心 31.5）。
另一条路是给 Naive 传 `collapsed-width: 40` 或覆写它的 `padding-left`，但那样要么改侧栏实际宽度、要么跟库的内部算法对着干；**让自己的盒子去适配库的假设**更稳。

### ③ 教训：模板里的行内注释不能带 ASCII 双引号

在 `:class="[…]"` 数组里插了一行注释 `/* … "不可进" … */`，构建直接失败：

```
[plugin vite:vue] WorkbenchView.vue (810:17): Error parsing JavaScript expression: Unterminated comment.
```

因为那段表达式本身住在**双引号属性**里，注释中的 `"` 把属性值提前截断了，`/*` 再也没闭合。
**`tsc` 与 `eslint` 都查不出这个错**（本仓库的 `.vue` 既不参与类型检查也不参与 lint），只有构建会报 —— 又一次印证"改完必须构建"。写模板内注释一律用「」。

### 验证

- 根 `tsc`、渲染层 `tsc`、`eslint .`、`electron-vite build` 全部 0 问题。
- 隔离 userData 下的 CDP 诊断（脚本放在仓库 `.tmp/`，不进版本库）：**叶子卡**点击后面包屑 1→1 段、无返回卡、本层卡片数不变，光标 `default`、悬停提示含"没有子任务"；**对照**的有子任务卡片照旧进层（1→2 段、出现返回卡）并能点返回卡退回；**折叠态**色块中心 x=32、四个菜单图标中心全为 x=32、图标右沿 42 ≤ 侧栏右沿 64。
  （这一轮**没有跑完整的 `ui-shot.cjs`** —— 用户要求"这次跳过脚本测试，我自己测试"。探针里已补上叶子卡那条断言，下次打包前会整跑一遍。）

---

## 23. 0.1.8 已实施：控件尺寸整体上调（2026-09-24）

用户原话：「将整个项目中的所有输入框，下拉框的样式做一些调整，让他尺寸更合理，更匹配项目，现在感觉太小」。

### 先量，再改

"太小"是感受，得先变成数字。用 CDP 读 DOM 矩形 + 计算后的字号，逐页量了一遍（脚本仍是 `.tmp` 下的临时诊断，不进版本库）：

| 场景 | 控件 | 改前 |
|---|---|---|
| 工作台工具条 | 搜索框 | **28px / 12.5px** |
| 任务详情抽屉 | 状态 / 优先级 / 标签（下拉）、截止日（日期）、进度（数字框） | **28px**（下拉 12.5px） |
| 日志页 | 筛选下拉 ×2、搜索框 | **28px / 12.5px** |
| 侧栏 | 当前项目下拉 | **28px / 12.5px** |
| 新建任务弹窗 | 同一批字段（未写 `size`，走 Naive 的 medium） | 34px / 13px |
| 下拉弹层 | 选项行高 | 28px（跟着 small 档） |

**结论**：凡是显式写了 `size="small"` 的地方都是 28px（Naive 的 small），只有没写 size 的弹窗是 34px（medium）—— 用户平时摸得最多的（搜索、抽屉、侧栏）恰好全是最小的那一档。这也解释了为什么"感觉太小"：不是某一个控件的毛病，是**整档偏小**。

### 为什么改一处就够

Naive 的这套组件高度**不是各自写死的**，而是从主题的 `common.height*` 取：`Input` 直接解构 `heightTiny/Small/Medium/Large`，`Select` 用的 `InternalSelection` 也是（连下拉弹层的**选项行高** `optionHeight*` 都来自同一组值）。所以只在 `theme/tokens.ts` 的 `naiveThemeOverrides` 里改这一组数，全项目的输入框、下拉框、数字框、日期框、按钮、下拉选项行**一起变** —— 不需要去每个页面调 `size`，也就不会出现"某个页面漏改"。

顺带一条：输入框的上下内边距是 `calc((height - 1.5 × fontSize) / 2)` 算出来的，所以抬高高度就自动获得了更松的呼吸感，不用另外补 padding。

### 新尺寸（按密度分档）

| 档位 | tiny | small | medium | large | 控件字号（small/medium） |
|---|---|---|---|---|---|
| 舒适 comfortable | 26px | **36px** | 36px | 44px | 13.5px |
| 紧凑 compact | 24px | **34px** | 34px | 40px | 13px |
| （改前实际值） | 22px | 28px | 34px | 40px | 12.5px / 13px |

- 取 **34px** 作为下限是有依据的：它就是 Naive 自己的 medium 高度，也是桌面端表单控件的常规高度（Ant Design / Element 默认 32px 上下）。
- **"紧凑"不再等于"比库默认还小"**：紧凑档的控件高度也从 28 → 34，收紧的是文字与行距。密度是本来就在头部工具条里的开关（`ui.setDensity`），以前它只改 `--pm-row-height/--pm-font-size` 这几个自定义变量，现在把控件尺度也纳入进来，这个开关才算真正管用。
- **按钮一起变大是故意的**：工具条上"搜索框 + 新建按钮"、日志页"两个下拉 + 搜索框 + 搜索按钮"都在同一行里。只放大输入框的话，这些行会一高一矮 —— 那比一律偏小更显眼。所以按钮、下拉弹层选项行都跟着走同一档。
- **没有跟着变的**：卡片上那些自绘的小元素（状态标签 `.wb-status`、状态点、`详情` 图标、日志级别的 `info` 小圆标）是自定义 CSS，尺寸由卡片自己的排版决定，这一轮刻意不动 —— 它们属于"卡片里的装饰"，不是表单控件。顺手加了两个变量 `--pm-control-height` / `--pm-control-height-sm`，以后自绘控件要跟 Naive 对齐时有处可取。

### 验证

- 根 `tsc`、渲染层 `tsc`、`eslint .`、`electron-vite build` 全部 0 问题。
- CDP 实测（隔离 userData，两档密度各跑一遍）：**抽屉**里 4 个下拉 + 日期 + 数字框 + 输入框全部 28 → 34px（舒适 36px），下拉弹层选项行同样是 34 / 36px；**日志页**两个筛选下拉 + 搜索框 + 同行按钮全部 34px；**工作台**工具条搜索框与"新建任务"按钮等高；**项目页**卡片上的小图标按钮 22 → 24px（舒适 26px）。逐页截图人工核对过：没有挤位、没有截断。
- 用户当时跑的是**紧凑**档，所以看到的是 34px 那一档；头部密度按钮切到"舒适"是 36px。

---

## 24. M2（视图与检索）开工前的地基实测：FTS5 与中文分词（2026-09-24）

M2 的三件事是**日历视图 / 我的待办（跨项目聚合）/ 全局搜索**（需求文档 §7、§5.5）。其中只有"全局搜索"有会翻车的技术前提，所以在打包 0.1.8 的同一轮把它先测了，免得等动手时才发现方案不成立。

**测法**：直接拿应用里那份 `better-sqlite3` 建内存库，分别用两种分词器建 FTS5 表，灌三条中文任务再逐词 `match`（脚本是一次性的，跑完即弃）。

| 检查 | 结果 |
|---|---|
| SQLite 版本 | **3.53.4**（`better-sqlite3@13`） |
| FTS5 是否编译进来 | ✅ 有（`pragma_compile_options` 里能查到 FTS5） |
| ICU | ❌ 没有 |

**关键结论：默认分词器对中文是"整串一个 token"，直接上 FTS5 等于搜不到。**

| 查询词 | `unicode61`（默认） | `trigram` | `LIKE '%词%'` |
|---|---|---|---|
| `接入登录态`（整串） | ✅ 1 | ✅ 1 | ✅ 1 |
| `登录态`（3 字） | ❌ 0 | ✅ 1 | ✅ 1 |
| `出诊断`（3 字，非词首） | ❌ 0 | ✅ 1 | ✅ 1 |
| `登录`（2 字） | ❌ 0 | ❌ 0（trigram 最少 3 字） | ✅ 1 |
| `导出`（2 字） | ❌ 0 | ❌ 0 | ✅ 2 |
| `zip`（英文） | ✅ 1 | ✅ 1 | ✅ 1 |

也就是说：`match('接入登录态')` 能命中，但用户真正会输入的"登录"两个字**一条都搜不出来** —— 这不是配置问题，是 unicode61 把连续汉字当成一个词。

**M2 的搜索方案（据此定）**：

1. 索引用 **`tokenize='trigram'`**，不要用默认的 unicode61；trigram 对中文是"任意 3 字子串"匹配，正好符合"搜片段"的直觉，英文单词也照常命中。
2. 查询词**少于 3 个字符时回落到 `LIKE '%kw%'`**（trigram 有硬性下限），两条路的排序策略不同，结果里要标明最终走的是哪条，避免"同一个词有时命中有时不命中"的困惑。
3. 纯英文/数字查询可以只走 FTS5；**中英混排**的查询按"中文字符数"决定走哪条。
4. 建索引时把 `tickets` 一起纳入（表已存在、M3 才落界面）—— 现在建，M3 就不用再补一次迁移；**文档要等 M3**（表都还没有）。
5. 还需要一个**跨项目的搜索接口**：现有查询全挂在 `/api/v1/projects/:id/...` 下，而全局搜索结果必须跨项目，并且每条结果要标出所属项目（工作台搜索结果里"属于「X」"那套可以直接复用）。

顺带记下 M2 另外两件事的前置：

- **日历视图**：`tasks` 的 `start_date / due_date / completed_at` 都在，字段不缺；但**"今天/逾期"的判定口径要先定**（需求 §12 开放问题 #3：时区与日期格式）—— 库里存的是整数时间戳，天边界按本地时区算，跨时区显示不能跳天。另外现在没有"按时间范围查任务"的接口（只有分页列表与 board），日历要用得新加。
- **我的待办（跨项目聚合）**：同样卡在"查询都按项目走"上，需要按 `dueDate + 状态类别` 跨项目过滤的接口；逾期提醒的出口可以直接用现有的通知 Provider + 托盘菜单。

---

## 25. 0.1.9 已实施：测试环境与正式环境的数据隔离（2026-09-25）

### 问题

用户原话：「项目是访问的本地数据库，但本机在开发，所以导致测试数据与正式数据会冲突，我希望做一下测试环境和正式环境，每次打包的时候更换到正式环境」。

根因很直接：`electron-vite dev` / `preview` 跑的是**未打包**的应用，打包后的 exe 跑的是**打包**的应用，但两者 `app.getPath('userData')` 是**同一个目录**（`%APPDATA%\@pm-studio\desktop`）。而数据库、工作区目录、config.json、日志**全都在 userData 下面**（0.1.2 起数据库在 `<userData>/data/workspace.db`）—— 所以开发时灌进去的测试项目与任务，直接落进了正式数据里。

### 方案：按环境换 userData 根目录

只做一件事：**判断环境，然后 `app.setPath('userData', ...)`**。因为应用状态全在 userData 下，换根目录就等于换了一整套（库、工作区、配置、日志），不需要逐个路径去改 —— 漏改一个就又是一次污染。

| 优先级 | 条件 | 环境 | 实际数据目录 |
|---|---|---|---|
| 1 | 命令行有 `--user-data-dir=`（或 `--user-data-dir <路径>`） | custom | 参数指定的目录 |
| 2 | 环境变量 `PM_STUDIO_ENV=test` / `production` | 按变量 | 见下 |
| 3 | `app.isPackaged` | 打包 = production，未打包 = test | 见下 |

- **正式生产 `production`**：`%APPDATA%\@pm-studio\desktop` —— **刻意不自己拼路径、不调 setPath**，用的就是 Electron 的默认目录，也就是用户既有数据所在的那一个。这样"正式环境"不需要任何搬迁动作，也不存在"我拼错一个字符导致正式数据不见了"的风险。（迁移/整理用户数据是 M5 的事。）
- **测试 `test`**：`<默认 userData>-test`，即 `%APPDATA%\@pm-studio\desktop-test`。
- **自定义 `custom`**：给测试脚本用。UI 探针与冒烟脚本靠 `--user-data-dir` 把数据关进 `.tmp` 沙箱，**必须让它优先于环境判断**，否则探针会跑去写正式数据 —— 那是最坏的结果，所以这条优先级排第一。

**两个容易踩的点**：

1. **必须在 `requestSingleInstanceLock()` 之前调用**。单实例锁是按 userData 目录分的，先拿锁再换目录的话锁会落在旧目录上，开发版与正式版又会互相唤醒。（顺带一个好处：隔离之后开发版和打包版**可以同时开着**，以前启动 dev 只会唤醒打包版窗口。）
2. **显式写了 `PM_STUDIO_ENV` 但值不认识时，不能静默按正式处理**：用户以为切到测试了、实际在写正式库，是最糟的错觉。这种情况回落到默认判断，并在 `reason` 里写明"已忽略"。

### 界面上必须能看出来

数据分成两套之后，最大的风险变成"我不知道眼前这份是哪套"。所以三处都标了环境：

- **窗口标题**：非正式环境加后缀 → `项目管理系统（测试环境）`。走渲染层改 `document.title`（Electron 默认会用页面标题覆盖 `BrowserWindow.title`，直接传 title 会被冲掉）。标题在任务栏、Alt+Tab、截图里都能看到，侧栏折叠时也不丢。
- **侧栏版本号旁边的标签**：正式 = 灰底低调（它是常态），测试 = 警示色（里面的改动都不是真实数据），鼠标悬停显示**实际生效的数据目录**。
- **托盘提示**：`项目管理系统 0.1.9（正式环境）` —— 应用躲在托盘里时，那是唯一能看到的说明。

日志里也把判断依据一起记下来（`environment` + `environmentReason`），以后"数据怎么不对"翻一眼启动日志就有答案。

### 验证（三条路径都实测过）

- 单元测试：`packages/desktop/tests/environment.test.ts` 锁死优先级（含"显式 `--user-data-dir` 压过打包状态"、"写错的值不当成正式"），全套 **383 个测试通过**。
- **测试环境**（`electron-vite preview`，未打包）：日志 `environment=test`、目录 `…\desktop-test`；首次启动自动建好 config.json / `data/workspace.db`（迁移 0001~0003 全过）/ `workspace/` / `logs/`；窗口标题 `项目管理系统（测试环境）`、侧栏显示「测试环境」。**同时确认正式库的 mtime 没有被碰过**（09/23 14:03:58 前后一致）。
- **正式环境**（打包 exe）：日志 `packaged=true, environment=production`、目录 `…\desktop`；窗口标题无后缀、侧栏「正式环境」、8 个项目/18 个任务都在（直接用 better-sqlite3 只读核对过：8 projects / 18 tasks）。
- **自定义**（打包 exe + `--user-data-dir=D:\…\.tmp\env-check-userdata`）：日志 `environment=custom`，日志文件生成在那个自定义目录里 —— 探针沙箱仍然有效。

### 怎么用

| 想做的事 | 怎么做 |
|---|---|
| 日常开发调试 | `pnpm --filter @pm-studio/desktop dev` / `preview` → **自动进测试环境**，随便折腾 |
| 打包发布 | `pnpm --filter @pm-studio/desktop dist` → 产物运行起来**自动是正式环境**，无需任何手工切换 |
| 临时用开发版看正式数据 | PowerShell：`$env:PM_STUDIO_ENV='production'; pnpm --filter @pm-studio/desktop preview` |
| 临时用打包版看测试数据 | 给 exe 加 `--user-data-dir`，或设 `PM_STUDIO_ENV=test` |

> 「每次打包的时候更换到正式环境」这件事**不需要额外动作**：打包产物天然满足 `app.isPackaged = true`，环境判断自动落在正式环境上。反过来说，**开发版永远碰不到正式数据**，除非显式设了 `PM_STUDIO_ENV=production`。

---

## 26. 0.2.0：界面测试脚本推倒重做（2026-09-25）

用户原话：「在 M2 的更新中，不用再用之前的老版本脚本测试了，删除重新设计测试脚本」。

旧的 `scripts/ui-shot.cjs`（1437 行单体脚本）**已删除**，替换为 `scripts/e2e/`：
`harness/`（工具：沙箱、CDP、页面原语、造数据、断言、诊断）+ `scenarios/`（一个场景一个文件）。
新增两个入口：`pnpm --filter @pm-studio/desktop e2e` 与 `e2e:packaged`。

### 为什么必须重做

不是"旧脚本能跑、只是丑"，而是**它把失败指向了错误的方向**。这一轮我在它身上花了大量时间，
每次都要另写一个诊断脚本才能知道发生了什么：

| 旧脚本的问题 | 具体后果 | 新做法 |
|---|---|---|
| 固定 `sleep(6000)` 等界面 | 同一份产物时绿时红（机器一忙就假失败）。我实测过打包版连续三次不同结果：全绿 / 路由内容空白 / 截图拿不到帧 | 全部改成**条件等待**，超时信息里带着判据本身 |
| 用"元素数 0"表达失败 | 外壳渲染了、路由内容没挂上时，它报"0 张卡片"——指向被测页面，实际是启动/挂载问题 | 每条路由断言 `[data-view=…]` 挂载 + 内容节点数 + 页面标志元素 |
| 失败只给一句话 | 得另写脚本抓 console / 网络 / 资源时序 / 主进程日志 | 失败**自动**收集这五样 + 截图，落成 JSON 并打印摘要 |
| 断言写成 `check(ok, '失败文案')` | 成功时也打印那句失败文案，日志自相矛盾（印着"没找到卡片"其实通过了） | `assert` 第二个参数永远是"期望成立的说法"，失败才附实际值 |
| 用合成 `el.click()` / `dispatchEvent` 点元素 | **绕过命中测试，掩盖真实交互缺陷**（见下） | 点击/悬停默认走 **CDP 真实鼠标** |
| 每跑一次往沙箱塞一份同名数据 | 上一轮残留会干扰下一轮 | 每次运行造带随机后缀的项目，跑完即删 |
| 1437 行、造数据与断言混在一起 | 改一处要读全篇 | 场景是独立文件；M2 的三项已以 `pending` 占位 |

### 它在第一轮就抓到一个真实缺陷

**总览的六边形点不动**：`onPointerDown` 在**每次左键按下**就 `setPointerCapture`，
指针捕获把后续 `pointerup`（以及由它派生的 `click`）**全部重定向到容器**，
于是六边形上的 `@click="drill(cell.id)"` 永远收不到事件 —— 真实鼠标点六边形不下钻。

旧脚本查不出来，因为它用合成事件直接打在元素上，**恰好绕过了这个问题**。
这正说明"用合成事件点元素"的代价：它让真实交互缺陷在测试里变得不可见。

修法是**真要拖了才捕获**：按下时只记起点，第一次移动超过 3px 才 `setPointerCapture` 并进入拖动状态。
"点一下"仍是干净的点击，"按住拖"仍是完整的旋转。新场景用真实鼠标点击验证这条。

### 新脚本的约定（M2 加页面时照着做）

1. **页面根节点挂 `data-view="<name>"`**，多分支模板（总览的四种状态）**每个分支都要挂** ——
   这是"路由内容真的挂载了"的唯一可靠判据。
2. **不写 `sleep`**；要等什么就等什么（元素出现用 `waitFor`，动画用 `animationsSettled`）。
3. **造数据走接口，验证走界面**：造数据失败与功能失败必须能区分。
4. **中文功能必须用中文用例**（搜索、日历）—— 默认分词器对中英文的处理完全不同。
5. 沙箱闸门（必须 `.tmp`、绝不在 `%APPDATA%` 下）**不要为了图方便去掉**。
   详见 `packages/desktop/scripts/e2e/README.md`。

### 验证

一次运行跑完 7 个场景（含 3 个 M2 占位），**80 条断言全通过、退出码 0**：
`shell` 16 条、`workbench` 29 条、`overview` 9 条、`logs` 9 条、`settings` 17 条；
`calendar` / `my-tasks` / `search` 显示"未实现（跳过）"。

---

## 27. 0.2.0：设置页（2026-09-25）

M2 开工的第一件事是用户新加的需求：「添加一个设置页」。

### 内容与生效时机

| 分区 | 内容 | 生效 |
|---|---|---|
| 外观 | 主题（原表里的界面密度与侧边栏折叠已按反馈移除，顶栏/侧栏本就有开关） | 立即 |
| 编辑器 | **默认编辑器**：自动识别本机装了哪些编辑器，从识别到的里面选 | 立即 |
| 日志与诊断 | 级别、保留天数、文件上限、保留份数、隐藏用户名 | 级别立即，其余下次启动 |
| 备份 | 立即备份一次（可用）+ 开关、间隔、保留份数（定时自动备份未实现，界面标注） | 见说明 |
| GitHub 绑定 | **预留接口**：绑定状态 + 绑定入口（OAuth 未实现，点了明确告知） | 见说明 |
| 数据与环境 | 当前环境、数据目录、**工作区目录（可更改）**、版本 | 见说明 |

### 三个值得记的点

**① "立即生效 / 下次启动生效"必须在界面上写明。** 混在一起显示，用户会以为设置没保存
（明明存了、行为却没变）。日志级别能做到立即生效是因为主进程里有 `setMinLevel`；
文件轮转参数与脱敏要重建日志写入器，只能等下次启动。所以 `preferences:patch`
在保存后顺手调了一次 `logger.setMinLevel(next.logging.level)`。

**② `preferences:patch` 是浅合并，嵌套字段必须整块回写。**
`{...current.preferences, ...patch}` —— 只传 `{ logging: { level } }` 会把 `logging` 里
其它字段抹成 undefined（脱敏、轮转参数全丢）。设置页因此每次都传完整的
`logging` / `autoBackup` 对象，并且 e2e 里专门断言了"改级别之后 `retentionDays`
与 `redactUserName` 仍在"。这条在两端都写了注释。

**③ 没实现的功能如实标注，而不是只放一个开关。** 自动备份目前**只有配置项、没有后台任务**，
勾上它并不会真的备份。界面直接写明"尚未实现"，并指路手动复制数据目录 ——
一个写着"自动备份：开"却没有备份的界面，比没有这个开关危险得多。
e2e 里有一条断言专门守这句话（`「备份」分区如实标注自动备份尚未实现`）。

### 顺带补的两件事

- 设置页是**第一个显示"当前环境 + 数据目录"的界面**：用户在设置里就能看清自己正在动哪一份数据
  （正式 / 测试 / 自定义，见 §25）。新增 IPC `app:reveal-userdata` 用于打开数据目录。
- 编辑器白名单（`ALLOWED_EDITOR_COMMANDS`）通过 bootstrap 下发到渲染层，
  **不在前端重复写一遍** —— 将来加编辑器不会两边不同步。

### 验证

`tsc`（根 + desktop）、`eslint .` 全 0；e2e `settings` 场景 **17 条断言通过**：
五个分区都在、环境标签与运行环境一致、数据目录指向沙箱、备份分区如实标注未实现、
改密度后 `html[data-density]` 立即变化**且已落盘**、改日志级别后落盘为 `debug`
且 `logging` 其它字段没被浅合并抹掉、编辑器下拉有值。

### 追加（同日，按用户反馈）

用户贴了一张设置页截图，圈出两处：

1. **「保留份数」看不懂** —— 原话「我没有理解保留份数的意思」。
   这是文案问题：只写"保留份数"三个字，谁也不知道它跟什么有关。
   改法是把**行为**写出来：「备份文件堆着不动会一直占地方：留够 N 份之后，再备份就自动删掉
   最旧的那一份。比如填 10，就是「最近 10 次备份留着，更早的自动删掉」」。
2. **工作区目录要能改** —— 原话「这里需要可以修改工作区目录，即使是放在后面也需要留出该功能」。
   这一版就把它做成真的能用（见下），而不是先放一个点不动的按钮。

顺带修掉截图里暴露的一个显示缺陷：工作区路径被显示成 `_s\ZhuanZ\AppData\...`。
原因是我为了让省略号出现在**开头**（路径结尾信息量更大）用了 `direction: rtl`，
结果反斜杠被当成双向文本分隔符，路径被重排得面目全非 —— **看起来像程序出错**。
改成允许换行、不做省略：路径是给人核对用的，宁可多占一行也不能显示错。

**「更改工作区目录」的实现要点**

- 工作区目录**只放项目文件夹**（数据库在 `data/` 下、与它平级），所以"换目录"不搬数据库，
  只搬项目文件夹 —— 这也让整个操作可回退：搬的是文件夹，失败就地报错，**什么都不删**。
- 校验：不能等于当前目录；不能落在 `data/`、`logs/` 里（否则项目会和数据库混在一起）。
- **搬旧项目是可选动作**：用户可以选择"只切换、旧的自己处理"。搬家用 `renameSync`
  （同盘瞬时）；**跨盘会失败**，那时如实报错让用户手动拷 —— 不做"复制 + 删除"，
  那才是真会丢数据的操作，留给 M5 的工作区迁移。
- 目标已存在同名文件夹 → **跳过并告警，绝不覆盖**。
- 只有一个工作区条目，**原地改它的 `path`**（不新建条目）：`activeWorkspaceId` 不变，
  重启后还是同一个工作区。
- 切换后提示**重启应用**：内嵌服务在启动时就拿了 `workspaceRoot`（新建项目时建文件夹、
  导出诊断包都用它），不重建服务的话它会一直用旧路径。与其偷偷留下不一致状态，
  不如给一个「立即重启」按钮（`app.relaunch()`）。

**这里踩到一个"设计味道"问题，值得记**：第一版我把"刷新界面"写在设置页按钮的处理函数里，
于是只要**换一个调用方**（自动化脚本直接调这个接口）界面就停在旧路径上 ——
"谁改谁负责刷新"这种约定迟早会漏。改成**主进程改完就广播** `workspace:changed`，
由外壳统一刷新启动信息与项目列表。E2E 正好用"绕过界面直接调接口"的方式验证了这条路
（`设置页显示的是新目录`、`侧栏底部的工作区名也跟着更新了` 两条断言）。

**「立即备份一次」也是这一轮补的**：原来备份分区只有三个存配置的输入框，整片是死的。
现在有一个真能用的按钮：用 SQLite 的 backup API 把数据库完整快照到 `<userData>/backups/`
（**不是拷文件** —— WAL 模式下最新写入可能还在 `-wal` 里，单拷 `.db` 会得到缺数据的库）。
定时自动备份仍未实现，界面上照旧写明。

e2e 场景随之扩到 **31 条断言**，并在**磁盘上核对**搬家结果：
切换前项目文件夹在旧目录、切换后在新目录且旧目录里没有了；备份文件确实生成了 `.db`。

### 再追加（同日，第二轮反馈：密度无效 + 编辑器要识别本机）

用户又贴了一张截图，圈了两处：

1. **「这两个不要」** —— 设置页里的「界面密度」与「侧边栏」两行去掉（顶栏有密度按钮、
   侧栏有折叠把手，同一个开关出现在两处只会让人怀疑"我是不是改错了地方"）。
2. **「界面密度的功能无效，包括页面上方的按钮也同样无效」** —— 这条是**真的**，
   查下来有两个原因，都很典型：
   - **两档只差 2 像素**：上一版是 34px 对 36px、字号 13 对 13.5。用户按了按钮却看不出变化，
     这不是"用户没注意"，是可用性问题。现在紧凑 34px / 13px、舒适 42px / 14.5px。
   - **正文字号根本没跟着变**：`common.fontSize` 被写死成 `'13px'`，而 Naive 的全局样式
     会用它覆盖 `body` 的字号 —— 于是 `styles.css` 里那句
     `font-size: var(--pm-font-size, 13px)` 永远轮不上。实测证据：切密度时 CSS 变量
     确实是 `14px → 13px`，但 `body` 的计算字号一直是 13px。改成 `fontSize: tokens.fontSize` 后才真正生效。
3. **「改为选择默认编辑器，可以执行识别电脑上存在什么编辑器」** —— 原来是固定列出白名单 8 个命令
   （webstorm / idea / subl…），用户面对一堆自己没装的名字无从下手。现在新增
   `editor:detect` 接口：复用"用编辑器打开"那条路径上的解析逻辑（PATH → 反推 exe → 常见安装位置）
   逐个探测，**只把解析得到的列进下拉**；当前配置的那个若没检测到（换了机器）仍保留并标注
   「未检测到」—— 否则下拉会显示成空白，看起来像设置丢了。

**测试上的一条教训（又是"断言骗过我"）**：密度这条断言最初写的是"`html[data-density]` 变了没有"——
它一路通过，而用户看到的是"没反应"。改成**量控件的真实高度差**：

```js
assert.atLeast(Math.abs(after.controlHeight - before.controlHeight), 6,
  '切换密度后控件高度差要 ≥ 6px 才看得出来');
```

现在这条断言会在"只差 2 像素"的版本上失败 —— 断言要盯着**用户能感知的东西**，
而不是"我自己改的那个变量变了没有"。

另外修掉了新脚本自己的两处 flakiness（不是被测代码的问题，但会误导人）：
点击 Naive 的 Select 要点**内部真正的可点区域**（`.n-base-selection`），点外层根节点会偶发点不开；
查下拉选项要**只看当前可见的菜单**（关掉的菜单仍在 DOM 里，不过滤会把另一组选项混进来，
上一版就"看着通过、其实校验的是另一个菜单"）。

---

## 28. 0.2.0：GitHub 绑定的预留接口（2026-09-25）

用户原话：「设置里预留绑定 github 的接口」。Git 集成在需求里整体排在 M6，
所以这一版要做的不是功能，而是**把契约立住**。

### 立住了什么

| 层 | 内容 |
|---|---|
| 配置 | `preferences.github = { connected, login, hasToken, connectedAt }`，带逐字段校验 |
| 主进程 | `github:status` / `github:connect` / `github:disconnect`（实现在新模块 `main/github.ts`） |
| 桥 | preload 暴露同名三个方法（仍然只暴露白名单方法，不给 ipcRenderer） |
| 界面 | 「GitHub 绑定」分区：状态标签 + 「绑定 GitHub」按钮 + 未实现说明 |

**校验写得严**：`connected` 只有在"同时有 login 且有令牌"时才认。否则一份手改坏的配置会
呈现出"已绑定、但不知道绑的是谁"的怪状态 —— 界面既显示不出账号，也拉不到任何东西。

### 三个刻意的决定

1. **令牌不进 `config.json`**。那是明文 JSON：会被备份、会被打进诊断包、也可能被用户随手转发。
   配置里只有"绑没绑、绑的是谁"；令牌将来用 `safeStorage.encryptString()` 加密后单独存
   `<userData>/github.credential`，**并且不经过渲染层**（所以状态对象里连"令牌"这个字段都没有，
   只有一个 `hasToken` 布尔）。
2. **不假装成功**。点「绑定 GitHub」会明确弹出"尚未实现（排在 M6）"。
   一个点了没反应、或者返回假状态的按钮，比一个明确说"还没做"的按钮糟糕得多 ——
   用户会以为绑好了，然后等着一堆不存在的功能。「解除绑定」则是**现在就完整的**
   （清本地状态 + 删令牌文件），因为它不依赖 OAuth。
3. **`available` 由主进程给**，界面据此决定按钮行为。实现 OAuth 之后，
   改的是主进程里那一个布尔与 `beginGithubConnect` 的实现，界面代码不用动。

### 实现计划（先写下来，免得到时候重新踩）

- 走 **OAuth Device Flow**：桌面应用内嵌 client secret 一定保不住；设备码流程只需要一个公开
  client id，也不用起本地回调端口（少一个端口、少一类安全问题）。
- 作用域最小化：私有仓库才要 `repo`，公开只读用 `public_repo`。
- 主进程自带 `fetch`（Electron 44 / Node 22），**不需要引入新依赖**。

### 验证

e2e `settings` 场景扩到 **55 条断言**，其中 11 条专门守这个预留接口：
状态标签显示"未绑定"、分区里如实写着"还没做"、状态对象六个字段齐全、
**状态对象里没有令牌字段**、点绑定后弹出的说明里含"尚未实现"、点过之后状态仍是未绑定
（没有假装成功）、配置里 `github` 段就是约定的四个字段、
**配置里没有任何长字符串**（这条是真正在守令牌不下沉到配置：令牌必然是长串）。

> 这条断言第一版写成"grep 一下 key 里有没有 token"，结果被自己的 `hasToken` 字段绊倒 ——
> 而 `hasToken` 恰恰是安全的那一个（只回答"有没有"）。断言要盯的是**值的形状**，不是字段名。

---

## 29. 0.2.0：任务详情的进度条，与"保存时抢焦点"的根因（2026-09-25）

用户截图 + 两句话：「当我输入时就会失去焦点，这里改成进度条，点一次 + 值就变大 10」。

### 焦点为什么会掉（值得单独记）

那个数字输入框是这么写的：

```html
<NInputNumber :value="detail.progress" :disabled="saving"
  @update:value="(v) => patch({ progress: v ?? 0 })" />
```

而 `patch()` 会 `saving.value = true`。于是每敲一个数字就是：
**输入 → 发保存请求 → 输入框被 `disabled` → 组件重新渲染 → 焦点掉了**。
不是输入框的毛病，是"边输入边保存、保存时把自己禁用"这个组合的必然结果 ——
只要保留这个组合，"换个控件"也一样会掉。

所以换成进度条时，**同时把这条链路拆掉**：新控件（`components/ProgressField.vue`）没有
需要保持焦点的输入态，保存期间只用 `busy` 挡住新的操作，不禁用外观、更不重建元素。

### 顺手修掉的第二个问题（同一个根因）

`patch()` 原来每次成功都 `await load(d.id)` —— **整块重载任务详情**。重载会把
`draft`（标题/描述草稿）按服务端值重新赋值，于是：

> 在描述里写了一半 → 顺手把优先级从"中"改成"高" → 刚写的内容被服务端的旧值覆盖没了。

现在 `board.updateTask()` **返回服务端返回的那条任务**（失败返回 `null`），
抽屉里就地合并：`detail.value = { ...d, ...updated }`。不重载、不动草稿，
顺带少一次请求。改返回值是安全的：唯一另一个调用方是 `if (!ok) return;`，
`null` 依然表示失败。

### 进度条的行为

| 动作 | 结果 |
|---|---|
| 点进度条 | 跳到点击位置（按 5 对齐） |
| 按住拖动 | 连续跟手，**松手才提交一次**（拖动中不发请求） |
| 「−10」「+10」 | 一次 10（用户要求的步长），到 0/100 自动置灰 |
| 键盘 | 方向键 ±10、Home/End 到 0/100（`role="slider"` + `tabindex`） |

用自绘的条而不是 `<input type="range">`：原生 range 在各浏览器里的外观与刻度差异大，
而这里要的是"看得懂进度"的条 + 确定的步进按钮。也没用 Naive 的 `NSlider` ——
它的 `update:value` 在拖动时连续触发，很容易变成"一秒几十个保存请求"。

### 验证

新增 e2e 场景 `drawer`（**12 条断言**），三条主线各自对应一个真实问题：
进度条可用（点 +10 显示 10%、连点四次服务端存 40、方向键到 30%）；
**打字时焦点不被抢**（聚焦描述 → 输入 → 焦点仍在 TEXTAREA、内容还在）；
**改其它字段不冲掉未保存文本**（输入描述 → 改状态 → 描述仍在）。
其中"连点四次服务端存 40"是直接查接口核对的，不是只看界面数字。

---

## 30. 0.2.0：日志页的历史噪音（"日志问题"的答复与处理）（2026-09-25）

用户问「日志问题有解决吗」。先把两个环境的日志表翻出来看，再回答 —— 不猜。

### 查出来的事实

| 环境 | info | error / warn |
|---|---|---|
| **正式**（用户在用的 0.1.8 打包版） | 1088 | **12 条 error** |
| **测试**（开发版 0.2.0） | 119 | **0** |

正式库那 12 条 error 分两类，**全部是历史**（09-23 ~ 09-24，来自更早的版本）：

1. **8 条 `ResizeObserver loop completed with undelivered notifications`** ——
   浏览器自身的无害告警，当前版本已经不再上报（`api/report.ts` 里做了窄过滤）。
2. **4 条 `Vue 组件异常：Cannot read properties of undefined (reading 'filter' / 'length' / 'has')`** ——
   09-23 早上（0.1.1 / 0.1.2 时期），那时还有**已经被删掉的「看板 / 列表」两个页面**；
   异常来自那些现在不存在的代码，之后没有再出现过。

### 但暴露出一个真问题：日志只增不减，历史错误永远在

过滤只能挡住"以后不再上报"，**挡不住表里已经存在的记录**。用户升级之后打开日志页，
那几条红色 ERROR 仍然躺在那儿 —— 于是每次都要重新怀疑"是不是又坏了"。
（用户这次问的"日志问题"，很可能就是这个观感。）

所以补两件事：

1. **历史噪音降级显示**：日志页把匹配这张模式表的 error 显示成灰色「提示」而不是红色错误，
   整行压暗，页面顶部加一句说明「这是浏览器自身的无害告警，不是应用错误；当前版本已不再上报」。
   判断规则与"不再上报"**共用同一份**（`isBenignMessage` 从 `api/report.ts` 导出），
   避免两处判断不一致。
2. **加「清空」按钮**（带确认弹窗）：给用户一个"把历史清掉、从干净状态看"的手段。
   服务端新增 `LogStore.clear()` + `DELETE /api/v1/logs`；**清空之前先 flush** ——
   日志是先攒内存缓冲再批量写库的，直接 DELETE 会让缓冲区里的行在下一次 flush 时"复活"，
   用户点了清空、过两秒又看到旧日志，会以为按钮没生效。清空动作本身**补记一条**记录，
   否则"日志怎么突然空了"会变成新的谜团。

### 验证

`logs` 场景扩到 **14 条断言**，新增的三条正对上面这件事：
造一条同类告警后，它显示成「提示」而不是 error、整行被压暗、页面上有说明；
清空之后历史告警消失、且**清空动作在日志里留了痕**（这条直接查接口，
因为场景前面把界面筛选设成了 warn，而那条记录是 info —— 从界面上根本看不到它）。

### 顺带修掉两处**测试脚本自己**的坑（都是"报错方向错误"那一类）

1. **点击前只在必要时滚动**：一上来就无条件 `scrollIntoView`，对**浮层里的元素**会让
   Naive 认为"用户滚走了"从而关掉浮层 —— 标记好的下拉选项瞬间不可见，
   报出来却是"元素不存在或不可见"。
2. **点击前等目标"停下来"**：悬停会触发过渡（卡片右侧「详情」入口是 `opacity 0→1` +
   `translateX(100%)→0`），过渡没播完就量坐标会量到滑动途中的位置，
   于是点在了底下的卡片本体上（现象：想开详情、结果进了下一层）。
   现在先移入 → 等过渡 → **连续两次采样包围盒不再变化**才按下。
   这条修完，全量场景连跑两次都是 6 通过 / 0 失败。
3. **选下拉选项要"量完立刻点"**：通用 `click()` 为了等动画、查视口、确认停稳要来回好几趟
   （每趟上百毫秒），对"随时可能被关掉的浮层选项"就是隐患（偶发"选项不存在或不可见"）。
   `pickOption()` 改成一次求值拿坐标、紧接着派发鼠标事件。

---

## 31. 0.2.0：日志页分页栏的位置（2026-09-25）

用户截图指出：日志为空时，「上一页 / 下一页」浮到了工具栏下面，而它应该在页面底部 ——
原话「当数据没有的时候我也希望他在这里」（箭头指向页面底部）。

**根因是布局**：`.page` 是 flex 列，有数据时 `.log-list` 用 `flex: 1` 吃掉剩余高度、
把分页栏顶到底部；**空态那个 `NEmpty` 没有撑开高度**，于是分页栏就直接跟在它后面，
落到了上面。修法是让空态与骨架也 `flex: 1`（占住剩余高度），并给 `.pager` 加
`margin-top: auto` 兜底 —— 将来再有别的数据状态没撑开高度，它也不会浮上去。

e2e 里加的不是"分页栏存在"，而是**它的位置**：量分页栏底边到内容区底边的距离，
要求有数据 / 无数据两种状态下都 ≤ 40px 且两者相差 ≤ 12px。

> 写这条断言时又踩了一次"测试自己造成的假失败"：场景前面把级别筛选设成了 warn 及以上，
> 而测试环境的日志几乎全是 info —— 列表**一直是空的**，于是"清空搜索后列表恢复"永远超时，
> 报出来像是搜索坏了。修法是让场景**先离开页面再回来**（筛选是组件内状态，重挂载即复位），
> 把"复位筛选"这件事显式做掉，而不是靠运气。

---

## 32. 0.2.0：M2 三项功能（日历 / 我的待办 / 全局搜索）（2026-09-25）

用户要求一次性做完 M2 剩下的三件事。三项各自的界面、接口、e2e 场景与单元测试都到位，
全量场景 **9 个全过、0 跳过**（此前三项是 pending）。

### 32.1 一个共同的前提：跨项目查询

M1 的所有任务查询都挂在**某个项目**下面（`/projects/:id/tasks`），而这三件事全都要"跨项目"。
新增 `GET /api/v1/tasks`（`services/task-query.ts`）：

- 过滤条件：`dueFrom` / `dueTo` / `withoutDue` / `onlyOpen` / `projectIds` / `limit`；
- 每条结果都带 `projectName` —— 跨项目列表里两个同名任务，靠它才分得清；
- **归档项目与已删除任务一律排除**（"搜到一条打不开的结果"最让人困惑）。

**时区口径**：服务端**不猜时区**。"今天 / 本周 / 逾期"全部由**渲染层按本地时区**算好边界
（`utils/date.ts`）再作为 `dueFrom` / `dueTo` 传进来；服务端只判断"时间戳落没落在区间里"。
这样同一份数据在不同时区看到的"今天"各自正确，也不用往服务端塞时区配置。
需求的开放问题 §12-3（时区与日期显示格式）据此**按本地日历天**落定。

### 32.2 日历视图

- 月历 6 行 × 7 列**固定 42 格**（翻月时高度不跳），周一为周首（国内习惯）；
- 每格最多显示 3 条任务，多出来的显示 `+N`；
- 右侧**常年显示「逾期」面板** —— 日历最容易漏掉的就是过期的东西，而它最该被看见；
- 顶部三个计数（逾期 / 今天 / 本周）与面板口径一致；
- 点任务开详情（日历只是入口，改还是在详情里改）；
- 范围可切「当前项目 / 全部项目」。

### 32.3 我的待办（跨项目聚合）

- 分组按"我现在该干什么"排：**逾期 → 今天 → 本周 → 以后 → 没有截止日**；
- **每行都带所属项目标签**（需求里明确要求过："每条要能看出它属于哪个主任务"）；
- **已完成的不进前三组**（`onlyOpen`）—— e2e 里真的把一条逾期任务标成完成，
  再断言它从「逾期」里消失，而不是只看代码；
- 可筛单个项目；点一行开详情。

### 32.4 全局搜索（中文分词是核心）

实测结论先行（§24）：默认分词器把一连串中文当**一个词**，用户输"登录"两个字一条都搜不到。
所以：

| 查询词 | 走哪条路 | 结果 |
|---|---|---|
| 3 个字符以上（"子任务二"） | FTS5 `MATCH`（trigram） | 片段命中，含**非词首**片段（"任务二"→"…·子任务二"） |
| 少于 3 个字符（"任务"） | `LIKE '%…%'` 回落 | 命中；界面如实显示"已自动改用模糊匹配" |

- 索引是**迁移建的 FTS5 表 + 触发器同步**（任务与工单各三个触发器）。
  用触发器而不是业务代码双写：任务的写入路径有六七条（新建/更新/移动/批量/恢复/软删除），
  任何一条漏写索引，搜索就会**静默少结果**——那是最难发现的一类错误。
- 结果**再次关联任务/项目表**过滤已删除与已归档（索引里允许留着已删文档）。
- 工单表**一起纳入了索引**（表已存在，M3 才落界面），M3 不用再补一次迁移。
- 响应带 `mode`，界面据此如实说明走的是全文索引还是模糊匹配 ——
  不说明的话，用户会以为"全文搜索时好时坏"。
- 入口：侧栏「搜索」+ **Ctrl+K**（输入框里不拦，否则 K 打不进去）。

### 32.5 验证

- **单元测试**：`packages/server/tests/task-query.test.ts`（13 条，含两个汉字短词、
  软删除后搜不到、改标题后旧词搜不到）、`packages/desktop/tests/date-buckets.test.ts`
  （14 条：本地日边界、周一为周首、跨月、跨零点、网格 42 格与闰年二月）。总计 **410** 条全过。
- **e2e**：`calendar` 12 条、`my-tasks` 14 条、`search` 12 条；全量 **9 个场景全过、0 跳过**。
- `tsc`（根 + desktop）、`eslint .` 全 0。

### 32.6 踩到的两个坑

1. **查询串里的时间戳必须 `z.coerce.number()`**：共享的 `timestampSchema` 是严格 number，
   而 URL 参数永远是字符串 —— 直接用它会让每个请求都 400。
   实测表现是"日历页四个请求全 400、界面一片空"，而页面本身没有任何报错，
   只有从网络时序里才看得出来。
2. **测试里取 `h1` 会抓到外壳的标题**（顶栏那个 `h1` 在 DOM 里更靠前），
   于是"月份标题"断言读到的是「日历」。改成 `[data-view="calendar"] h1` 才是视图自己的标题。
3. 另外把 `drawer` 场景的入口从"工作台卡片右侧悬停滑出的「详情」"改成"我的待办的普通行"：
   前者是**滑入动画中的按钮**，在过渡结束前量到的坐标可能落在卡片外的空隙上
   （全量跑时偶发"点了没反应"，截图里能看到按钮还贴在卡片右缘外侧）。
   那条悬停链路已由 `workbench` 场景用真实鼠标覆盖，场景各测各的，更稳也更快。

---

## 33. 布局约定：优先弹性盒子（2026-09-25）

用户看过「我的待办」之后要求：「这里重新排版，这样不好看，**你在后续样式中多用弹性盒子**」。
这条当成后续写界面的默认约定。

### 为什么那一版不好看

四个分组里有三个是空的，而我给空分组用的是**带图标的空状态块**（`NEmpty`）——
每个空块撑成一百多像素高、图标居中，于是整页又空又长，真正有内容的那一组反而被埋了。
修法：**空就是空，一行淡字说清**（`<p class="empty faint">没有</p>`），
五个分组现在一屏看完。

### 约定

- **一维排布一律用 flex**：页面竖排、工具条横排、列表行、分组……
  写"标题占满剩余、右边的元素各自固定"用 `flex: 1; min-width: 0` + `flex: none`，
  比 `grid-template-columns` 更不容易在增删列时错位（内容宽度不同也不会对不齐）。
- **只有真正的二维网格才用 grid**：月历就是典型（7 列 × 6 行），
  用 flex 得自己算宽度和换行 —— 那是 grid 的活。**不是"禁用 grid"，是别拿它排一维的东西。**
- 列表行的典型写法：

```css
.row { display: flex; align-items: center; gap: 10px; }
.title { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.due { flex: none; text-align: right; }
```

（`min-width: 0` 不能省：flex 子项默认最小宽度是内容宽度，不加它长标题不会省略号。）

这一轮顺手把 M2 三个新页面的样式过了一遍：`我的待办`、`搜索`、`日历` 的外层与行内
全部改成 flex，只有月历本身保留 grid。

### 追加（同日，第二轮反馈：分组要排成一排）

用户看着「我的待办」说：「这里不能排一排吗，排一列是怎么展示」。
原来五个分组各自占满一行、竖着往下堆 —— 空分组也占一条完整横条，一屏里大半是空白。
改成**横向并排的列**：

- `.groups` 横排 flex，五个分组等宽（`flex: 1 1 0`）；
- 每列**内部自己滚动**，某一组几百条也不会把别的组挤下去；
- 空分组只剩一行「没有」，占一窄条。

**第一版列宽给了 `min-width: 210px`，五列要 1100px，窗口里只放得下四列半** ——
最后一列被挤出屏幕、底部冒出横向滚动条（截图里很明显）。改成 `min-width: 140px`
之后五列在常见窗口宽度下都能进来，更窄才退回横向滚动。

e2e 里加了三条几何断言守住这个版式：五个分组**顶边在同一水平线上**、左边依次递增、
**最后一列的右边界不超出内容区**（最后这条就是"被挤出屏幕"的直接判据）。
`my-tasks` 场景现在 17 条断言。

## 34. 0.2.0：卡片与空状态统一、日历的农历与节假日（2026-09-25）

这一轮是用户看完 M2 三个页面之后的一次集中反馈，一共六件事，逐条记下"为什么这么做"。

### 34.1 任务卡只能有一份样式（`TaskCard` + 全局 `task-card.css`）

用户要求：「任务卡片与工作台中的任务卡片**一致，且功能也是一致**」。

做法不是"照着工作台再抄一遍样式"，而是**把工作台那张卡抽成组件**：

- `components/TaskCard.vue`：卡片本体 + 全部行为（状态点、两行标题封顶、阻塞提示、
  子任务进度、标签、可点状态标签换状态、悬停滑出的「详情」、`Delete` 键删除）；
- `components/task-card.css`：卡片的**全部样式**，`main.ts` 里全局引入。

为什么样式必须是全局的：`scoped` 样式只作用于自己组件的模板，**组件之间没法共用同一段 CSS**。
把样式留在组件里，四个使用方就必然各存一份拷贝 —— 迟早漂移（改了一处忘了另一处，
界面上"看着差不多但总有点不对"），而这种漂移没人会主动去查。
所以 `.wb-*` 是**项目内的保留类名前缀**，只给这张卡用；工作台自己的网格、面包屑、
返回卡仍然写在 `WorkbenchView` 的 scoped 样式里。

四个使用方各自决定"点卡片做什么"：

| 页面 | 点卡片 | 卡片内容差异 |
| --- | --- | --- |
| 工作台 | 进入下一层（叶子卡不进层、光标是箭头） | 子任务进度条、搜索结果多一行"属于「X」" |
| 我的待办 | 打开详情 | 显示"属于「项目名」"（跨项目必须标出） |
| 全局搜索 | 打开详情 | 同上；没有子任务/标签的字段为空 |
| 日历右侧「选中某天」 | 打开详情（并选中那天） | 同上 |

"功能一致"还包括**换状态**：三个跨项目页面上的状态标签都能点，点了就地改。

### 34.2 跨项目列表里的状态名必须跟着数据一起回来

改动过程中发现一个真问题：`SearchView` 用 `board.statuses`（**当前项目**的状态表）
去查搜索结果的状态名 —— 而搜索是跨项目的，别的项目的状态 id 在里面查不到，
于是所有结果的状态都显示成"未知状态"。

修法是改**接口口径**，而不是在渲染层打补丁：

- `GET /tasks`（跨项目列表）与 `GET /search` 的响应里加 `statuses`：
  结果里出现过的每个项目各自**完整的状态表**（`id/projectId/name/color/category/sortOrder`）；
- 每条任务/搜索命中直接带 `statusName` / `statusColor`（跨项目查询本来就 join 了
  `workflow_statuses`，多取两列是免费的）；跨项目任务的标签也直接带 `tagNames`；
- 渲染层统一走 `composables/useCardStatus.ts`：状态名/颜色优先用行上的字段，
  查不到才回退状态表；**状态下拉按 `projectId` 过滤**（状态是项目级数据，不能跨项目改）。

### 34.3 空状态：统一的"开启的箱子"图标，居中

用户给了一张「开启的箱子」的图，要求空状态用它、并且居中。

- 图标是**手绘矢量加进 `AppIcon`**（`openBox`），不是塞位图：位图不跟主题色、
  不随字号缩放，而这个项目里所有图标都是 `currentColor` + 自绘 path；
- `components/EmptyState.vue`：图标 + 一行说明 +（可选的）一句更淡的提示 +（可选的）行动按钮；
  `compact` 变体给面板里的小空位（不撑高度）；
- 铺开到全部主要页面：工作台（没选项目 / 没任务 / 搜不到）、项目页、总览（没任务 /
  没有里程碑 / 没有被前置卡住）、我的待办每个空分组、搜索、日历（选中某天没任务 /
  没有逾期 / 本月没任务 / 未来没有假期）、日志页。

**这里推翻了 §33 的一条结论**，如实记下来：§33 说"空就是空，一行淡字说清"，
因为当时四个分组里三个是空的、每个 `NEmpty` 都撑成一百多像素的居中图标区，
整页又空又长。那两个抱怨指向的是**同一件事的两面**：不要**大块**空态。
所以现在的口径是：**空位说明要有图标（用户要的），但必须紧凑**——
分栏里的空分组用 `compact`（64px 出头），整页级的空用标准版（92px 起）。
不是把图标又加回"一百多像素的大块"。

### 34.4 日历：农历、二十四节气、法定节假日

用户要求：日历要有**农历、24 节气、当前年法定节假日（含调休）**，日期要做标记。

- **农历与节气用 `lunar-typescript`（6tail，MIT，无第三方依赖）**，不自己写那张
  "农历十六进制表"：1900–2100 的农历数据是压缩过的常量表，抄错一项会在某个闰月前后
  整体错一天，而且**很难发现**（只有那一天的人会对不上）。
  交叉验证：2026-02-17 = 正月初一、2026-09-25 = 八月十五，与《国务院办公厅关于 2026 年
  部分节假日安排的通知》里的日期一致。
  代价：这个库打包后约 400KB，落在**按需加载**的日历 chunk 里（不进首屏）。
- **放假安排是一张手写的数据表**（`data/holidays.ts`），因为它是国务院每年发通知定的：
  既不等于"周末必休"，也不等于"传统节日当天休"，没有任何算式能推出来。
  维护方式写在文件头上（每年通知发布后加一条 `{ year, source, holidays, workdays }`，
  日期一律 `'YYYY-MM-DD'` 字符串按**本地时区**解析，避免 UTC 差 8 小时把日期挪一天）。
  **没内置数据的年份不假装**：格子上不标节假日，面板里直说"X 年还没有内置的放假日程"。
- **格子上那一行小字**的优先级：法定节假日 > 节气 > 农历传统节日 > 农历日。
- **底色分四档，每档都配一个不靠颜色的线索**（用户 2026-09-25 追加反馈：
  「你为不同的天数做了颜色差异化，我想你把这个差异调得更明显一些，现在太淡了」）：
  第一版只有 7%~9% 的极淡底色，一屏扫过去分不出哪格是休息日。现在拉开档次 ——
  普通工作日无底色、周末 16%、调休上班 20%（蓝）、法定节假日 24%（红），
  并且周末/调休/放假的**日期数字也跟着变色**、表头里周六周日同样带灰底
  （竖着的"周末带"比只在格子里涂色更容易一眼扫到）；
  「休」「班」角标保留，所以分不清红蓝时靠角标与数字颜色照样能认。
  上下月补位仍是压暗（`opacity: 0.55`）—— 它是"别的月份"，不该比本月还抢眼。
  今天与选中那天用描边（今天 1px、选中 2px），和底色互不干扰。
- **日期数字 15px**（用户 2026-09-25：「日历中的数字字体调大一些」）：它是整格里最该
  "一眼看清"的东西，而原来 12.5px 和旁边 10.5px 的农历小字挤在一起，扫日期反而要凑近看。
  现在日期 15px / 农历 10.5px，**日期是主体、农历是注解**的层次立住了；
  「近 14 天」柱状图上的日期与数量（原来 9.5px）一并抬到 11px，
  「休 / 班」角标从 9.5px 抬到 10.5px —— 不然它们比数字小一圈，像两个时代的排版。
- **刻意不用库里的"公历节日表"**：那张表里混着一堆主题日（全国科普日、全民国防教育日…
  教师节、记者节都算），它们不放假、也不影响任何安排，却会占掉格子上唯一那行位置。
  放假的日子**只有 `data/holidays.ts` 一个来源**，准确度也更高
  （第一版把两者混在一起，9 月 19 日那格显示的就是"全国科普日"）。
- **假期的说法要分清三种情形**（第一版在这里错了）：还没开始 → "还有 N 天"；
  当天开始 → "今天开始"；**已经在假期中间 → "假期中 · 还剩 N 天"**。
  第一版只算了开始日期，于是 9 月 26 日（中秋假期第 2 天）显示成
  "距离「中秋节」还有 **-1** 天"。`nextHoliday` 现在同时返回
  `daysUntil / totalDays / daysLeft`，e2e 里有一条"倒计时不出现负数"的断言守着。

### 34.5 日历右侧面板：五个面板，一次请求

用户要求右侧显示：选中某天的任务、本周小结、近 14 天柱状图、项目分布、下一个节日倒计时
（**里程碑放最后做**，本轮不做）。

- 面板里的任务用**同一个 `TaskCard`**（格子里只有 100 多像素，塞不下卡片，
  所以卡片放在右侧面板里）。
- **一次请求取并集**：可见的 42 格 + 本周 + 近 14 天窗口的日期区间取 min/max 当查询范围，
  回来之后在前端分片。三个面板各发一个请求既慢，又容易出现"不同面板口径不一致"。
  "逾期"是唯一另发的（它的下界是无穷远的过去）。
- "本周小结"额外发一个**不带 `onlyOpen`** 的请求：小结要显示"这周做完了几条"，
  只看未完成的话那个数字永远是 0，等于没做这个面板。

**测试**：`packages/desktop/tests/holidays-lunar.test.ts`（18 条）钉住能和官方通知对上的日期
（春节 2/15–2/23、国庆 10/1–10/7、9/20 与 10/10 上班、正月初一、八月十五、秋分、闰六月）；
`scripts/e2e/scenarios/calendar.cjs` 从 12 条加到 22 条：42 格都有农历行、五个面板都接上了数据、
点某天右侧跟着换、倒计时不是负数。

### 34.6 下线界面密度切换；「功能介绍」做成一页

- 用户：「删除系统的密度切换功能，这个看着很鸡肋」。删掉切换按钮与相关样式，
  `ui.density` 固定 `comfortable`（控件 42px、正文 14px）；存储里的旧字段保留但不再读，
  免得老配置升级时报错。
- 「功能介绍」先是做成弹窗，用户改成**一页**：版本列表 → 点某个版本 → 详情页
  （路由 `/whats-new` 与 `/whats-new/:version`，共用一个视图）。
  数据在 `data/whats-new.ts`，**以后每次发版在最前面加一条**。

### 34.7 测试脚本跟着改（`scripts/e2e`）

卡片一换，选择器就得跟着走，这一轮改动：

- 我的待办：`[data-field="mytasks-project-tag"]`（旧的行内标签）→ 卡片上的
  `[data-field="card-belongs"]`；点开详情改成点 **`.wb-title`**——
  点卡片正中在不同卡片高度下可能落到右下角的状态标签上（那会打开状态下拉而不是详情）。
- 搜索：`[data-field="search-hit-project"]` → `[data-field="search-hit"] [data-field="card-belongs"]`；
  空态判定从 `.n-empty`（Naive 组件类名）换成 `[data-field="empty-state"]`（自己的组件）。
- 我的待办的分栏宽度：`min-width` 从 140px 提到 176px（卡片要放得下），
  并给卡片列加 `min-width: 0` —— 卡片的最小内容宽度（右下角"N 个子任务"与状态标签都是
  `nowrap`）比 176px 还大，flex 项默认按内容撑开，五列加起来会超出内容区、
  底部冒横向滚动条。**这个 bug 是 e2e 的几何断言抓出来的**
  （"最后列右边界 1294 > 内容区 1264"）。

## 35. 0.2.0：日历标记（2026-09-25）

用户看了一圈日历之后说：「**日历添加标记功能没做**」。

这句话点出一个理解偏差：§34.4 里我把「日期做标记」做成了**只读的标记**（农历、节气、
节假日、"今天"、"逾期点"都是系统算出来的），而用户要的是**自己能往某一天加一条东西** ——
休假、发版日、生日、出差这种"这天有件事"的提示。两者不是一回事：前者是"这天是什么日子"，
后者是"我这天要干什么"。

### 35.1 不是任务，所以单独一张表

最省事的做法是往 `tasks` 里塞一个"特殊类型"，但那样要背上任务的**全部**后果：
状态、进度、父子、依赖、统计口径、回收站、看板与工作台里的位置……
而标记本质上只是一行字 + 一个颜色。所以单开一张 `calendar_marks`（迁移 `0005`）：

| 列 | 说明 |
|---|---|
| `id` | 主键 |
| `date` | **某一天本地零点的毫秒时间戳**，由渲染层算好传进来 |
| `title` | 标记内容（≤ 40 字，日历格子里只有一行） |
| `color` | `#rrggbb`，界面上是 5 个预设色块 |
| `note` | 可选备注（≤ 200 字，悬停格子时显示） |
| `created_at` / `updated_at` | 时间戳 |

**时区口径与任务一致**：服务端不猜时区，"哪天"由渲染层按本地日历天算好
（`queryRange` 的边界直接复用），服务端只判"落没落在区间里"。
这样"9 月 26 日的标记"在任何时区都落在 9 月 26 日那一格。

### 35.2 标记是**工作区级**的（一处刻意的例外）

表里**没有 `project_id`**：日历标记是"我的时间安排"，不是项目数据。
挂到项目上会出现"切到另一个项目，这件全公司都知道的事就从日历上消失了"——
而且日历页顶部的「当前项目 / 全部项目」开关管的是**任务**，标记始终都在，
同一个开关同时管两种东西会更难解释。

这是继"全局标签"之后对"项目之间互不共享"的**第二处刻意例外**，记在这里以便将来收口：
真要项目级，加一列可空的 `project_id` 即可，数据不用搬。

### 35.3 界面：格子上一行药丸 + 面板里就地增删

- **格子**：标记显示在日期下面、任务条**上面**，一条彩色药丸（`color-mix` 20% 底色 +
  同色文字），最多 2 条，再多显示"还有 N 个标记"。放在任务条之上是因为它是**日期本身**的
  信息，和"这天要交什么"是两层。
- **增删在「标记」面板里**（用户看完第一版后要求「单独做一个框展示，间距放大一点」）：
  第一版把它混在「选中某天」面板里、输入框紧贴在任务列表上方，看着像是列表的一部分、
  点起来也挤。现在它是**独立一块框**（`data-field="cal-mark-panel"`），
  内部按"已有标记 / 输入框 + 添加 / 颜色"分三行、间距 10~12px，
  标题右边跟着"哪一天"（`8月31日 周一`），层次一眼看得清。
  输入框 + 「添加」按钮 + 5 个颜色点（18px，够大），已存在的标记是药丸 + 行内 `×`。
- **加完只重查标记**（`loadMarks`），不重查任务：加一条"休假"不该让整月的任务列表重拉一遍。
- 删除是**硬删除**，不进回收站：任务是"删错代价很大"才需要回收站，
  一条标记就是一行字，多一个没人看的入口只会更乱。界面上的 `×` 点完立刻从格子里消失。

### 35.4 顺带修掉的导航 bug

用户报：「设置 → 功能介绍 → 点某一个版本 → 返回列表 → 返回，结果退到了刚才那个版本里」。

原因：列表页的「返回」用的是 `router.back()`（退一步历史记录），
而"返回列表"本身就是一次 `push` —— 于是列表的上一条历史正是那个版本详情，`back()` 自然退到它。
**返回目标是确定的**（这一页只从设置页进来），就不要交给历史栈去猜：
改成 `router.push({ name: 'settings' })`。

### 35.5 测试

- `packages/server/tests/calendar-marks.test.ts`（12 条）：闭区间查询、同一天多条、
  校验（标题长度 / 颜色格式 / 日期）、硬删除、工作区级（没有项目也能建）。
- e2e `calendar` 场景 22 → **28 条**：走真实交互加一条标记 → 格子上出现、面板里出现、
  输入框清空 → **刷新页面后仍在**（证明落盘，而不是只在内存里）→ 点回那天 → 点 `×` 删掉。
  这一条同时守住"点某一天，面板里显示的就是那天的标记"。

## 36. M2 收尾：打包与发版流程（2026-09-25）

M2 做完之后要出安装包，这一轮把打包这件事本身的几个坑一起收拾了。

### 36.1 `dist` 必须先构建再打包

`packages/desktop/package.json` 原来是：

```json
"dist": "electron-builder --win"
```

它**不会**先跑 `electron-vite build`，于是"改了代码 → 直接 dist"打出来的包里
是**上一次构建的渲染层**——装上去表现是"我改的东西没生效"，而且极难往打包上想
（本地跑 dev 一切正常）。现在两个脚本都串上构建：

```json
"pack:dir": "electron-vite build && electron-builder --win --dir",
"dist": "electron-vite build && electron-builder --win"
```

### 36.2 打包版必须单独跑一遍 e2e

开发运行时与打包产物**不是一回事**：asar 打包、`better-sqlite3` 的 `.node`
被 unpack 到 asar 之外、首帧更慢、环境判定从"测试"变成"正式"。
所以发版流程里 **`e2e:packaged` 是最后一道闸门**（`run.cjs --packaged`
直接跑 `release/win-unpacked/项目管理系统.exe`，仍然用 `--user-data-dir`
指向 `.tmp` 沙箱，绝不碰正式数据）。

这一轮它就抓到了一个真问题和一个测试问题：

- **真问题**：没有（打包版功能与开发版一致，209 条断言全过）。
- **测试问题**：`calendar` 场景读详情抽屉时"刚看到 `.n-drawer` 就读文本"，
  打包版冷启动慢，读到的是还没加载内容的抽屉（只有标题"任务详情"）——
  典型的**假失败**，会让人以为打包版坏了。改成等"抽屉里出现这条任务的内容"再断言。

### 36.3 发版清单

写在 `docs/release-notes.md` 末尾（改四处版本号 → 加一条 `whats-new` 与一节说明 →
tsc / eslint / vitest / e2e（**先关掉手动开着的应用**，否则两个实例抢单例锁，
会出现"所有路由都挂不上"的假失败）→ `dist` → `e2e:packaged`）。

### 36.4 0.2.0 的产物

| 文件 | 大小 |
|---|---|
| `release/项目管理系统-0.2.0-setup.exe` | 112.3 MB（NSIS，可选目录、建快捷方式） |
| `release/项目管理系统-0.2.0-portable.exe` | 112.1 MB（免安装） |
| `release/项目管理系统-0.2.0-setup.exe.blockmap` | 0.1 MB（增量更新用） |

**升级说明**：直接覆盖安装 0.1.9 即可，业务数据在 `%APPDATA%\@pm-studio\desktop`，
不受影响；首次启动会自动跑迁移 `0005_calendar_marks`（新表，不动老数据）。

## 37. 0.2.0：移除全局标签（迁移 0006 与"改老表"的能力）（2026-09-26）

用户决定「那就不要全局标签这个设定」（决策记录 #27），顺带把同一个口子的
`ticket_types.project_id` 一起收掉。看着像"删几行代码"，实际上是**整个项目里第一次改老表结构**，
所以这一节把坑记全。

### 37.1 为什么"改一列的 NOT NULL"这么麻烦

三件事叠在一起，缺一不可：

| 事实 | 位置 |
|---|---|
| 连接**强制开外键**（开不了就拒绝启动） | `db/connection.ts` |
| **每条迁移被包在一个事务里** | `db/migrate.ts` |
| SQLite 的 `PRAGMA foreign_keys` **在事务内是空操作** | SQLite 行为 |
| SQLite **不支持**把已有列改成 NOT NULL（只能重建表） | SQLite 行为 |
| `task_tags.tag_id` 有 `REFERENCES tags(id) ON DELETE CASCADE` | 建表 SQL |

于是"重建表"这一步里 `DROP TABLE tags` 会**隐式执行一次 DELETE**，把 `task_tags` 的关联行
级联删掉 —— 那是静默的数据丢失（今天 `task_tags` 是 0 行，但这是运气，不是设计）。

### 37.2 做法：迁移自己声明"需要临时关外键"

`Migration` 多了一个可选开关 `foreignKeysOff?: boolean`，执行器按它分两条路走：

```ts
if (migration.foreignKeysOff === true) {
  applyWithForeignKeysOff(db, migration, recordRun);   // 事务外关外键 → 事务内跑 DDL + 校验
} else {
  db.transaction(() => { db.exec(migration.up); recordRun(); })();   // 原路径，不动
}
```

`applyWithForeignKeysOff` 的顺序不能变，每一步都有理由：

1. `PRAGMA foreign_keys = OFF` **在事务外**执行 —— 在事务内它是空操作，静默失效就等于没关；
2. 事务内跑 DDL，并**在事务内**做 `PRAGMA foreign_key_check`：有违规就抛错，
   整个事务回滚（放到提交之后检查就晚了，那时已经无法回滚）；
3. `finally` 里无论如何把外键恢复成 ON —— "连接上外键必须开着"是全局不变量，失败路径也不能例外。

### 37.3 迁移 0006 自己做了什么

顺序是"先留证、再重建"：

1. 建一张**留证表** `removed_projectless_rows`，把 `project_id IS NULL` 的行整行存成 JSON
   （`json_object(...)`）再继续 —— 这些行本来就没地方可去（不属于任何项目），
   但直接删掉是不负责任的。两张表都是 0 行时，这张留证表也是 0 行，等于不存在。
2. 重建 `tags`：`project_id TEXT NOT NULL`，数据 `INSERT ... SELECT ... WHERE project_id IS NOT NULL`，
   `DROP TABLE tags` → `ALTER TABLE tags_new RENAME TO tags`。
3. 重建 `ticket_types`：同上。
4. 唯一索引从 `(IFNULL(project_id,''), name)` 换成 `(project_id, name)`
   —— IFNULL 那套就是为了兼容 NULL 作用域，现在不需要了。

> 为什么不在迁移里"导出成 JSON 文件"：迁移是纯 SQL，做不了文件 IO。
> 0.1.1 那次导出 `app_logs` 是**代码在跑迁移之前**做的（见 `legacy-logs.ts`），
> 这次没有等价的启动前钩子，所以改成"库里留证"，同样做到"不静默丢数据"。

### 37.4 服务与接口跟着收口

- `services/tags.ts`：`listTags` 去掉 `globalOnly` 与 `isNull/or` 分支（回到纯 `eq`）；
  **`createTag` 的 `projectId` 变成必填的位置参数** —— "建一个不属于任何项目的标签"
  在类型上就写不出来，而不是等数据库的 NOT NULL 去拦；`findTagByName` 同理。
- `routes/tags.ts`：删掉 `GET /tags` 与 `POST /tags`（全局标签的列表与创建）。
  按 id 的 `/tags/:id` 查改删保留（id 全局唯一，没必要再套一层项目路径）。
  前端不用改 —— 它从来没调过那两个接口。

### 37.5 测试：改语义 + 证明"数据一条不少"

| 测试 | 变化 |
|---|---|
| `services.test.ts`「项目标签与全局标签可以同名」「全局标签之间也受唯一约束（IFNULL 归一化）」 | **改写**成「不同项目的标签互不影响」与「标签不可能不属于任何项目」——语义变了就得改测试，不能留一条已经不成立的绿 |
| `routes-projects.test.ts`「全局标签与删除」 | **改写**成「标签只能建在项目下，按 id 查与删照旧」，并明确断言老的 `POST /tags` 现在返回 **404** |
| `db.test.ts` | 新增：两列确实是 NOT NULL（**原来的双向漂移测试只比对列名，抓不到可空性脱节**）、唯一索引回到 `(project_id, name)` |
| `db.test.ts` | 新增**老库升级**用例：先只跑到 `0005`、塞进项目标签 + 全局标签 + 全局工单类型，再跑完整迁移，断言"该留的都在、被移除的能在留证表里查到、外键仍然开着且 `foreign_key_check` 为空" |

另外用**真实库的副本**做了一次验证（临时脚本，跑完即删）：把两份库（正式 9 项目 / 29 任务、
测试 1 项目 / 1 任务）拷到 `.tmp` 下，走 `DbConnection.open()` 的真实启动路径，
结果迁移记录 5 → 6 条、项目与任务数不变、索引已换成 `(project_id, name)`、无外键违规。
**全程没有打开用户那份原始数据库**。

## 38. M4 第一步：外部命令白名单 + 开发环境检测（2026-09-26）

用户点选的第一刀：「命令白名单 + 环境检测」（只读、不改机器；改机器的"自动配置"放 M4 最后）。

### 38.1 命令白名单（`server/services/commands.ts`）

跑外部命令是这个应用里**唯一能碰到用户机器**的地方，所以纪律先立：

- **结构化白名单**：调用方给的是"哪条 spec + 那几个值"，可执行文件名与参数都由 spec 决定；
  用户输入只能进**声明过的值位**（slot），能写枚举就写枚举（比正则严格），
  写不了才用正则（默认 `^[A-Za-z0-9._-]+$`）。
- **传了没声明的参数要报错**，不能静默忽略 —— 静默忽略最危险：调用方以为传进去了，
  实际执行的是另一条命令。
- **可执行文件名只允许"裸名字"**（纵深防御第二道）：允许出现路径分隔符，
  就等于允许执行任意位置的程序，白名单也就没意义了。
- **超时写死在 spec 里**，调用方改不了；输出截断到 4KB（命令跑飞了不能把内存塞满）。
- **执行函数是注入的**（`CommandExec`）：单测里换成假的，既不必派生真实进程，
  也不依赖这台机器装了什么 —— 顺带绕开了"受限环境里捕获子进程输出可能被挡"这条限制。

### 38.2 一个 Windows 上的真坑：`.cmd` 批处理壳没法直接 spawn

第一版跑完，截图里 `npm` / `pnpm` 都显示**「版本未知」**。原因：Windows 上它们是
**批处理壳（`.cmd`）**，而 `execFile('npm.cmd')` 配 `shell: false` **根本起不来** ——
同一个坑在 `main/editor.ts` 里已经记过一次（那边的办法是"反推真实 exe"，
但 npm 这类没有 exe 可反推）。

修法：**按探测到的路径后缀分流** —— `.exe`（node / python / git）继续走不带 shell 的
`tool-version`；`.cmd` / `.bat` 走新增的 `tool-version-cmd`（`cmd.exe /d /c <tool> --version`）。
这不是"退回拼字符串"：可执行文件固定是 `cmd.exe`、参数固定、`<tool>` 来自枚举白名单
且不能含空格与分隔符，Node 这边仍然是 `shell: false`。

### 38.3 三条"不许骗人"的细节

1. **命令失败时不解析版本号**。`parseVersion` 的兜底是"匹配不上就原样显示第一行"，
   而失败时的第一行往往是错误信息（`'node' 不是内部或外部命令`）——把它当版本号显示，
   就成了"编一个版本号"。失败就说失败，并把退出码与输出片段写进 note。
2. **note 必须显示在界面上**，不能只藏在 tooltip：第一版把说明挂在路径单元格的
   `title` 里，于是"版本未知"看起来像软件坏了。
3. **能力探测不该显示"版本未知"**：`venv` 是"有没有这个能力"，界面上显示
   **可用 / 不可用**（工具定义里用 `kind: 'version' | 'capability'` 区分）。

### 38.4 "在哪"用文件系统、"版本"才派生进程

查找复用 `editor.ts` 的 PATH 遍历（`createPathEditorProbe`）：不派生进程、可直接单测、
也避开了"捕获子进程输出"这类在受限环境里可能被挡的操作。只有版本号必须真的跑一下工具。

### 38.5 结果缓存在 AppData，不进工作区数据库

`<userData>/environment.json`。理由：
1. 它描述的是**这台机器**，不是用户的项目数据（工作区边界见需求 §13.1）；
2. 换工作区（M5）之后同一个结果继续有效，不必重测。

界面上的两个入口刻意分开：进设置页读**缓存**（每次重测要派生 7~8 个子进程，没必要），
点「重新检测环境」才强制重测 —— 需求 §5.7 明确"不允许一次检测做死"。

另外缓存里存了检测时 **PATH 指纹**（短哈希，不存明文）。不一致说明用户在这次启动之后
改过环境变量，界面会提示"需要重启本应用"（Windows 下已运行的进程读不到新 PATH）——
没有这条提示，用户装完 node 再点重测还是"没找到"，会以为软件坏了。

### 38.6 测试

| 测试 | 覆盖 |
|---|---|
| `packages/server/tests/commands.test.ts`（17 条） | 白名单**能不能被绕过**：枚举外取值、注入尝试（分号/管道/路径分隔符/空格）、未声明参数、缺参数、bin 带路径；执行侧用注入的 exec 验超时/退出码/输出截断，并确认"非法取值在执行之前就被拦下" |
| `packages/desktop/tests/env-detect.test.ts`（18 条） | 8 个工具逐个报路径与版本、没装就如实说明、venv 能力探测、超时、读不出版本、必需工具缺失、PATH 指纹、重启提示、缓存读写与损坏兜底、`.cmd` 分流 |
| e2e `settings` 场景（67 → **73 条**） | 点「重新检测环境」后**八行都在、没有空行**、Node 那一行有版本号、摘要如实说明必需工具齐不齐 |

**测试与截图各抓到一个真 bug**：PATH 指纹没抹掉"项尾多余的反斜杠"（`D:\b` 与 `D:\b\`
被当成两次不同的 PATH，会误报"环境变量改过了"）；以及 38.2 的 `.cmd` 壳问题。
两个都是"看着能用、其实在骗人"的类型。

## 39. M4 第二刀：作业执行器与作业中心（2026-09-26）

用户点选的顺序里，第二刀是「作业执行器 + 作业中心页」。做法是先让**一个真作业**跑通
（不是拿假数据演示），再接脚手架那些重活。

### 39.1 分层：谁负责什么

| 层 | 文件 | 职责 |
|---|---|---|
| 数据 | `server/services/jobs.ts` | 建行、改状态、批量记日志、查列表、**崩溃恢复** |
| 编排 | `server/services/job-runner.ts` | 排队、并发上限、取消、进度、日志刷库与落文件、事件广播 |
| 接口 | `server/routes/jobs.ts` | 列表 / 详情 / 日志 / 新建 / 取消 / 重试 / **单条 SSE** |
| 界面 | `renderer/views/JobsView.vue` | 左列表 + 右实时输出，取消 / 重试 |
| 具体作业 | `desktop/src/main/job-handlers.ts` | 第一个真作业「环境自检」（**由主进程注入**） |

**handler 为什么由主进程注入**：环境自检要用 `env-detect.ts` 那套 PATH 探测与工具清单，
而那套东西属于主进程（碰文件系统、知道 userData 在哪）。服务端只管"怎么排、怎么跑、
怎么推事件" —— 这样 `@pm-studio/server` 不必反向依赖桌面端。以后脚手架/装依赖也照这个方式注册。

### 39.2 几条不肯让步的设计

1. **状态机只有一个写入口，且一定落终态**。所有变化都经 runner；结束时一定是
   `succeeded` / `failed` / `canceled` 三者之一，没有"跑着跑着没人管了"的中间态。
2. **排队是异步启动的**（`schedulePump` 推到下一个事件循环）。第一版 `enqueue` 同步就把
   handler 的头几行跑完（建日志文件、写状态、发事件），结果接口返回的作业已经是"进行中"，
   HTTP 请求也被顺带拖住。测试直接把这条钉住：`enqueue` 返回的必须是 `queued`。
3. **日志批量落库**（每 500ms 或 50 行），实时性靠内存缓冲 + SSE。逐行写库在几万行输出的
   脚手架面前会把 SQLite 写爆；而文件那份（`logs/jobs/<id>.log`）是给"进程被强杀后整包取出"用的。
4. **取消是真的杀掉**：`AbortController` → `runCommand` → `execFile({ signal })`。
   `canceled` 与 `failed` **必须分开** —— 用户自己按的取消不是错误。
   （整棵进程树的清理留给脚手架那一步：只有 `npm`/`pnpm` 那种会派生孙进程的命令才需要 `taskkill /T`。）
5. **崩溃恢复**：启动时把残留的 `queued` / `running` 标成 `interrupted`，并写明"应用在这次作业
   跑完之前退出了"。不做这件事，界面会永远显示一个不动的"进行中"。
6. **退出时收尾写库不能抛异常**：应用退出后数据库可能已关闭，而作业的收尾代码还在跑。
   抛出去就是 unhandled rejection（单测里先撞上了这个），所以收尾统一走 `safeUpdateJob`。
7. **能力探测加 `quiet`**：`python -m venv --help` 会打印一大篇用法，逐行记进日志只会淹掉
   有用的几行。命令本身照旧记一行（跑了什么、成功失败），所以日志不会变得不可信。

### 39.3 日志文件放 AppData（与需求 §4.3 的一处偏差，记下来）

需求 §4.3 写的是"项目文件夹里的 `logs/` = 该项目的作业输出"。这一版实际落在
**`<userData>/logs/jobs/<作业id>.log`**，理由：

- 作业有**工作区级**的（备份、工作区迁移），它们没有"所属项目"；
- 需求 §13.1 的原则是"工作区只放用户数据，运行期产物移出去"，作业日志是运行期产物；
- 数据库那份（`job_logs`）才是界面与诊断包读的东西，文件只是"崩溃后能整包取出"的兜底。

项目级的作业输出将来真要落到项目文件夹里，是再加一处写入、不是重做。

### 39.4 第一个真作业：环境自检

为什么是它打头：作业执行器需要**一个真作业**才能证明整条路是通的，而环境自检刚好合适 ——
真的在跑外部命令（走命令白名单）、**只读**（不装东西、不建目录、不改环境）、
输出用户看得懂。界面上点一下就有一条作业，作业中心第一次打开就有东西可看。

几个刻意的行为：

- **进度是可解释的**：`已完成工具数 / 工具总数`。外部命令没有进度条，
  给一个"看得懂的分母"比编一个平滑动画诚实。
- **必需工具缺失 → 作业失败**（而不是"成功但有警告"）：状态要能让人一眼判断"能不能往下走"，
  含糊的成功会让人以为可以生成项目了。
- 每条失败都写清原因（`✗ yarn：PATH 里没有 yarn（Node 依赖安装（备选））`）。

### 39.5 测试

| 测试 | 覆盖 |
|---|---|
| `packages/server/tests/job-runner.test.ts`（14 条） | 排队→运行→完成、进度与结果落库、日志批量刷且一条不少、事件流含 job/logs 两类、**并发上限**、没注册 handler 不能建、失败原因、**取消运行中/排队中**、已结束再取消不改状态、重试新建一条且老记录保留、跑着不能重试、**退出时取消在跑的**、崩溃恢复只改残留状态 |
| e2e `jobs` 场景（14 条） | 空状态与按钮 → 点「环境自检」→ 状态走到「已完成」→ **输出里有 `✓ Node.js: 24.20.0` 与 `$ node --version`** → 列表状态跟着变 → 重试后两条都在且老记录没被覆盖 |

**测试又抓到一个真问题**：第一版 `enqueue` 返回的是"进行中"的作业（见 39.2 第 2 条）。
这条如果不上测试，只会在"点一下按钮却看不到排队状态"时被当成玄学。

## 40. M4 第三刀：脚手架——先把「内置模板」这条路径做通（2026-09-27）

用户点选的顺序里第三刀是脚手架。这一刀**只把内置模板那条路径做成端到端可用**
（离线、可验证），官方 CLI 已进白名单但**没接线**，原因与现状在 §40.4 说清楚。

### 40.1 模板写在代码里，不写目录（对 §5.5 的修正）

原设计是"模板目录 + `asarUnpack`"。落地改成**把模板写成代码里的字符串**：

1. 目录形式的模板在 asar 里可能读不到，要么 `asarUnpack`、要么运行时把资源拷出来 ——
   都是"打包后才发现"的坑；字符串没有这个问题；
2. **可审计**：模板内容进代码仓库，能 review、能 diff（用户选"开发期固化模板"要的就是这个）；
3. **点文件不再需要改名技巧**：目录里的 `.gitignore` 常被工具吞掉，所以原设计要在渲染时把
   `_gitignore` 改回 `.gitignore`；字符串直接写真名，映射表可以不要了。

### 40.2 两条不肯让步的写盘规矩

- **不覆盖已存在的文件**：项目文件夹在创建时就带了 `attachments/` 与 `logs/`，
  用户也可能自己往里放过东西。生成骨架是"补东西"，不是"重置目录"。
  跳过时要**记进作业日志**（"跳过已存在的文件 N 个"）—— 沉默地跳过等于让人以为写成功。
- **路径必须先校验再拼**：模板是我们写的，但模板内容会被人改，
  而"模板里一行 `../..` 就能写到工作区外面"属于出事才发现的问题。
  `assertSafeTemplatePath` 挡绝对路径与 `..`，拼完再用 `resolve` 做一次"仍在目标目录内"的双保险。

### 40.3 官方优先，但"没接线"必须说出来

| 情况 | 这一版的行为 |
|---|---|
| FastAPI（官方无脚手架） | 走内置模板，**离线可用** |
| Vue3（官方 `npm create vue@latest`） | 官方**尚未接入** → 用内置最小骨架，并在作业日志里说明"与官方相比少了示例代码与配置项" |
| NestJS（官方 `npx @nestjs/cli new`） | 没有内置回退 → **直接失败**，提示"这一版可以先选 FastAPI" |
| Django（官方 `django-admin startproject`） | 同 Vue：有路可走的先走，没走的如实说 |

**为什么不一并接官方 CLI**：官方脚手架要联网（`npm create` / `npx` 会去拉包），
接上它就没法在端到端里验证（把测试绑在网络与 npm 上），而且"探测 `--help` → 组装参数 → 失败回退"
这套逻辑值得单独一刀做完（命令白名单里的 spec 已经备好，见 §40.4）。

### 40.4 已经备好、但还没接的东西（不许含糊）

命令白名单里已经写好了这些 spec（有单测覆盖参数校验与注入防护）：
`probe-help`（能力探测）、`scaffold-npm-create`、`scaffold-nest-new`、`scaffold-django`、
`install-node`、`python-venv`、`python-pip-install`。
**它们目前没有 handler 调用** —— 也就是说界面上的"生成"只走内置模板，装依赖也还没接。
下一刀要做的是：能力探测 + 官方调用 + 失败回退 + 装依赖（Node 侧 pnpm/npm、Python 侧 venv + pip）。

顺带在这一刀修好一个通用机制：**`.cmd` 批处理壳的判断从"每条命令各写两遍 spec"改成了通用能力**
（`buildCommand` 的 `executePath`）。Windows 上 npm / pnpm / npx 都是 `.cmd`，
`execFile` 配 `shell: false` 起不来，只能借 `cmd.exe /d /c`；现在由白名单统一判断，
不许冒充"裸名字"的 spec 自己分流。同时把值的校验补成三种：
`SAFE_VALUE_PATTERN`（裸名字）、`SAFE_FLAGS_PATTERN`（一组参数，允许单空格分隔但挡 shell 元字符）、
`RELATIVE_BIN_PATTERN`（**项目目录内**的相对路径，用于 venv 里的 python —— 不允许 `..` 与绝对路径）。

### 40.5 界面入口

作业中心右上角多了「**生成项目骨架**」：选技术栈（多选）→ 建作业 → 进度与输出就在这一页看。
入口放在作业中心而不是项目页，是因为它本质是"起一个作业"；等向导做出来，
向导会成为主入口，这个按钮留作"补生成"。

### 40.6 测试

| 测试 | 覆盖 |
|---|---|
| `scaffold-templates.test.ts`（12 条） | 模板表自洽（official 必有 spec、builtin 必有内容）、**模板里禁止可执行脚本**、变量替换、未知占位符保留、路径安全（绝对路径与 `..`）、写盘、**不覆盖已有文件** |
| `job-scaffold.test.ts`（16 条） | 单栈落根目录 / 双栈分 `frontend`+`backend`、同类栈撞目录要报问题、包名转 ASCII、payload 校验、项目不存在 / 没工作区目录要报错、**官方未接入时明说用的是内置模板**、**NestJS 无回退时直接失败**、FastAPI 真的落盘且不动 `attachments/`、再生成一次不覆盖 |
| e2e `scaffold`（19 条） | 通过接口建脚手架作业 → 等它成功 → **断言文件真的在项目文件夹里**（`app/main.py`、`requirements.txt`、`.gitignore`）、端口被替换、无残留占位符、`attachments/` 没被动、作业日志列出了写出的文件、作业中心里能看到它 |

### 40.7 一个流程上的坑：源码比 `out/` 新

这一刀撞了一次：改了 `app.ts`（注册脚手架 handler）之后**没重新构建就跑了 e2e**，
用的是 `out/` 里的**上一版代码**，报错是"没有注册「scaffold」这类作业的执行器" ——
方向完全指错（像是注册写错了，其实是根本没重新构建）。

修法：`scripts/e2e/run.cjs` 启动前比较 `src/` 与 `out/` 的最新修改时间，
源码更新就打一条**显眼的警告**（只警告不自动构建：自动构建会拖慢每次 e2e，
还掩盖了"你忘了构建"这件事）。

## 41. M4 第四刀：作业不再是"一个模块"，而是创建项目的一个动作（2026-09-27）

用户看完作业中心之后直接否掉了它的形态：

> 「我不想把这个单独做一个模块，我希望的是**在创建项目的时候**就执行环境检测，
> 并下载相关依赖与脚手架」

也就是说：**能力要留着，页面要去掉**。作业执行器解决的是真问题（长任务、进度、取消、
崩溃恢复），但它不该是用户需要主动去的一个地方 —— 它应该是"创建项目"这个动作的一部分。

### 41.1 改了什么

| 改前 | 改后 |
|---|---|
| 侧栏有「作业」页；用户自己点「环境自检」「生成项目骨架」 | **侧栏里没有作业**；一切都发生在「新建项目」向导里 |
| 创建项目 = 填个名字建个空壳 | 创建项目 = **① 检测环境 → ② 生成代码骨架 → ③ 安装依赖**，进度与日志就在向导窗口里 |
| 装了 M4 之前那些"等 M4 上线后可执行生成"的提示 | 这些提示删掉了：**现在真的会生成** |

保留下来的（它们是好东西，只是不该露在外面）：
`jobs` / `job_logs` 两张表、`JobRunner`、`/jobs` 接口（列表/详情/日志/新建/取消/重试/SSE）、
`JobsView` 之外的**所有**能力。删掉的只有 `views/JobsView.vue`、`/jobs` 路由、侧栏入口。

### 41.2 向导的四个步骤与"停在哪一步"

`components/ProjectWizard.vue` 一次把四件事串起来，每一步都有明确的状态
（等待 / 进行中 / 已完成 / 失败 / 已跳过），失败就**停在那一步**并给出可操作的原因：

1. **检测环境**：只用必需工具（node / npm）齐不齐做判断；不齐就停下并列出缺什么。
   纯管理项目**跳过**这一步（不需要生成代码）。
2. **创建项目与文件夹**：走原来的 `POST /projects`（含文件夹分配与状态初始化）。
3. **生成代码骨架**：`enqueue('scaffold', …)`，向导窗口里跟着看进度与日志。
4. **安装依赖**：`enqueue('install', …)`，**可以取消勾选**（断网/代理不通的人需要这条路，
   而且端到端里也不该联网）。跳过时作业是"成功"并在日志里写明依赖没装，而不是假装装好了。

已经完成的步骤在重试时**不重做**（重试只从失败那一步继续）：否则用户每失败一次就要
重新生成一遍骨架，还可能覆盖上一轮已经写好的文件。

### 41.3 装依赖的两个关键选择

- **包管理器按机器上有什么挑**：pnpm → npm → yarn，都没有就明确报"先装一个包管理器"。
  挑中的那个要**解析出真实路径**（`services/which.ts`）—— Windows 上 pnpm / npm 都是
  `.cmd` 批处理壳，不解析就只能失败（见 §38.2、§40.4）。
- **Python 必须先建 venv 再装**：绝不用全局 Python 装依赖（污染用户机器、不同项目互相打架）。
  venv 里的解释器用**项目目录内的相对路径**（`.venv\Scripts\python.exe` / `.venv/bin/python`），
  由白名单的 `RELATIVE_BIN_PATTERN` 校验 —— 它跑不出项目目录。

### 41.4 一个跨场景的坑：场景之间会互相污染

`create-project` 场景在沙箱里**新建了一个项目**，而同一个沙箱后面还有别的场景：
- `workbench` 场景原来是"点第一张项目卡片"——于是它点到了这个新建的空项目，
  后面所有卡片断言全落空（外层卡片数 0）；
- `settings` 场景原来断言"进页面时工具清单是 0 行"——而向导的第一步已经做过检测并落了缓存。

两处都改成了**与执行顺序无关**的写法：
- `workbench` 按**项目名**定位卡片（而不是"第一张"）；
- `settings` 改成"要么 0 行、要么完整的 8 行"，并且等摘要出现结论再断言
  （只等行数会撞上"8 行已在、摘要还写着正在检测"）；
- `create-project` 场景**跑完把自己建的项目删掉**，不给后面的场景留垃圾。

这三条改的都是**测试自身的假设**，而不是产品行为 —— 但它们很有价值：
在此之前，"单独跑某个场景通过、全量跑却红"的假失败会浪费大量时间。

### 41.5 测试

| 测试 | 覆盖 |
|---|---|
| `job-install.test.ts`（13 条） | 单栈/双栈的安装目录、包管理器选择顺序（pnpm→npm→yarn）、venv python 的平台差异、payload 校验、PATH 解析（PATHEXT 扩展名、带扩展名、找不到返回 null） |
| e2e `create-project`（15 条） | 打开向导 → 选"仅后端 + FastAPI" → 取消勾选装依赖 → **窗口里逐步看到三步完成**（其中"检测环境"那步写明 Node 版本）→ 日志里有写出的文件 → **文件真的落在项目文件夹里** → 没装依赖（目录里没有 `node_modules`/`.venv`）→「进入工作台」→ 收尾删掉这个项目 |
| e2e `scaffold`（18 条） | 原来的接口级断言保留（离线生成、落盘、不覆盖、变量替换） |
| e2e 全量 | **11 场景 / 248 断言全过**（新增 `create-project`，删掉测作业中心的 `jobs`） |

## 42. M4 第五刀：官方脚手架接线（2026-09-27）

上一刀只把内置模板做通了；这一刀把**官方脚手架**接上：探测 → 调用 → 失败回退。

### 42.1 三段式：探测、暂存生成、搬运

```
probeOfficialScaffold(job, descriptor, {npm, npx})
  ↓ 认得（--help 里有我们要的参数）
runOfficialScaffold(job, {...})
  ├─ 在 <目标目录>/.scaffold-staging 里生成（cwd = 暂存目录）
  ├─ 成功后才 adoptStagedDirectory()：逐条 rename 进目标目录（不覆盖已存在）
  └─ finally 里 removeStagingDirectory()（成功失败都收）
  ↓ 官方失败 / 没生成任何文件
decideAfterOfficialFailure({ fallbackTemplateId, reason })
  ├─ 有内置骨架 → 回退，并在日志里说明"这是最小骨架、比官方少什么"
  └─ 没有 → 抛错，把原因（网络 / 参数不被接受）写在错误里
```

**为什么必须在暂存目录里生成**：官方脚手架不接受"生成到非空目录"——
单栈项目的目标就是项目文件夹根目录，而它从创建起就带着 `attachments/`、`logs/`；
`create-vue` 见到非空目录会**交互式提问**，非交互调用会直接失败。
暂存目录放在目标目录**内部**（同盘），`rename` 才能瞬间完成。

**为什么"先全部生成完再搬"**：失败时目标目录必须保持原样。半成品目录比失败本身更难收拾 ——
用户既不知道删哪些，也不知道重试会不会覆盖。

### 42.2 真跑一次才发现的 bug：参数被当成一个字符串

第一版把探测到的参数拼成**一个字符串** `'--ts --router --pinia --eslint --prettier --force'`，
作为单个 argv 传给 `npm create`。真跑的结果是：

```
TypeError [ERR_PARSE_ARGS_UNKNOWN_OPTION]:
  Unknown option '--ts --router --pinia --eslint --prettier --force'
```

原因是引号在 `cmd.exe` → npm → 脚手架之间过了三层转义，**空格全被内容化**，
脚手架收到的是"一个"不认识的参数。修法是在命令白名单里引入**列表型值位**
（`CommandSlot.list`）：`args` 里独占一格的 `{slot}` 会**展开成多个 argv 条目**，
每一层都不需要转义，每个 token 还能**单独**过校验（比校验一整串更严）。

> 这条如果只靠单测和"看着挺对"的代码，是发现不了的 —— 所以这一刀专门跑了一次
> **真实联网**验证（临时场景，跑完即删）：`npm create vue@latest` 真的生成出 17 个条目
> （含 `.vscode`、`public`、`eslint.config.ts`），搬进项目文件夹、暂存目录被收掉。
> 顺带发现我那条临时断言写得太松（"日志里提到官方脚手架"在**回退**路径上也成立），
> 改成必须出现"官方脚手架生成完成"且**不能**出现"改用内置骨架"。

其余三条配套改动：

- **探测失败也要算失败**：`--help` 有输出但一个已知参数都没认出来，说明参数名变了 ——
  这时不该硬着头皮调，直接回退。
- **退出码 0 但什么都没生成**同样算失败：官方脚手架可能因为参数不被接受而"安静地什么都没做"，
  当成成功的话用户会得到一个空项目外加一句"生成完成"。
- **每个走官方的栈都要有内置回退**：NestJS 原来没有（理由是"手写的不像官方"），
  但实际用起来"断网就完全用不了"更糟 —— 内置骨架的价值不是"像官方"，而是**让项目能开始**。
  这一刀补了 **NestJS** 与 **Django** 两份内置骨架，四种技术栈现在都能离线起步。
  Django 的官方路径（`django-admin startproject`，要先建 venv 装 Django）留到"生成 + 装依赖一条龙"再说，
  所以它这一版的 `source` 是 `builtin`。

### 42.3 测试

| 测试 | 覆盖 |
|---|---|
| `commands.test.ts`（24 条） | 新增：**参数列表展开成多个 argv**、逐个 token 校验（含 `\n` 注入）、探测类命令与作业类命令的超时规则分开 |
| `job-scaffold.test.ts`（16 条） | 新增：探测失败 → 回退内置骨架**且真的落盘**；`decideAfterOfficialFailure` 的分支（有回退→回退、没回退→报错） |
| `scaffold-templates.test.ts`（12 条） | 模板表自洽现在覆盖四份骨架（含 NestJS / Django），仍然禁止 `postinstall` |
| **真实联网验证**（临时场景，跑完即删） | 真的跑通 `npm create vue@latest`，断言"官方脚手架生成完成"、没走回退、暂存目录被收掉 |

## 43. M4 第六刀：向导把「栈与栈的差别」讲清楚（端口 / 包管理器 / 联网）（2026-09-27）

前两刀把四种技术栈都跑通了，但向导里**只有栈的名字**：用户看不到"这个栈要不要联网""它会跑在哪个端口"。
这一刀补的是**决策需要的信息**——都是界面上的东西，服务端只多给一份"栈的能力表"。

### 43.1 端口：默认值按栈的惯例，且能被用户改掉

原来向导没有端口输入框，端口是模板里的死值。现在：

```
listScaffoldTemplates()  ← 每个栈自带 defaultPort（Vite 5173 / NestJS 3000 / Python 8000）
        ↓
向导：换栈 → 端口跟着栈的惯例走（用户自己改过就不动）
        ↓
createScaffoldJob payload 里带 port
        ↓
validatePort()：**服务端**只接受 1~65535 的整数，否则直接抛错
        ↓
模板渲染 __PORT__（.env.example / vite.config.ts / main.py 的启动说明 / app.listen）
```

三个刻意的选择：

- **端口惯例由服务端给**（跟 `needsNetwork` / `installKind` 一起放在栈描述里），不在前端写死第二份。
  前端只负责显示，改惯例只改一处。
- **服务端必须再校验一次**：端口会被写进生成出来的代码（`uvicorn --port`、`vite server.port`），
  界面上的 `min/max` 只是便利，绕过去就是一个"跑到一半才报错"的项目。
  `validatePort` 的报错信息里带上原始值，方便定位是哪个环节塞进来的。
- **用户改过就不跟着栈走**：`portTouched` 标记。先选 FastAPI 把端口改成 9000、再换成 NestJS —— 
  无脑跟栈会把 9000 覆盖成 3000，而用户是在"确定要 9000"之后才去挑栈的。

### 43.2 只在有意义的时候出现

界面上的"少即是多"这一刀体现在两处：

- **包管理器只在选了 Node 栈时出现**。给 FastAPI 项目选 pnpm 是没有意义的选项 —— 
  这种"点了也没用"的控件比没有更糟，用户会以为自己选错了什么。
- **每条选中的栈都如实标注现状**：官方脚手架（第一次要联网，失败回退内置骨架）
  vs 内置模板（离线可用）。不标的话，断网时用户会以为软件坏了，而其实几秒内就能给他一份内置骨架。

### 43.3 e2e 抓到的第一个 bug 是**测试自己的**（记一笔）

给端口加上断言后，`create-project` 场景红了：`向导里填的端口（8123）真的写进了生成的代码` 失败。
查下去发现**产品是对的，测试写错了**：`page.type()` 内部先点一下再插文本，
点击只**定位光标不选中**，于是 `8123` 拼在旧的 `8000` 后面变成 `80008123` ——
超范围的值被 `validatePort` 拒掉、退回默认值，看上去就像"填了 8123 却生成 8000"。

修法用"原生 setter + `input` 事件"（`HTMLInputElement.prototype` 上的 setter 绕开 Vue 对 DOM 的接管，
再派发 `input` 让 Naive 的 `NInputNumber` 更新 `v-model`），并且**改完立刻回读 DOM** 确认值真的进去了。
另一条同源的经验：断言要**分层**——现在既查作业载荷里的 `port`，也查生成文件里的端口，
否则"向导没传值"和"模板渲染把端口丢了"这两种完全不同的毛病会报成同一句话。

> 这条值得单独写出来：**红了的测试先怀疑测试**。如果当时直接去改产品代码"让它变绿"，
> 就会把一个正确实现改成错误的。

### 43.4 测试

| 测试 | 覆盖 |
|---|---|
| `job-scaffold.test.ts`（19 条） | 新增：`validatePort` 的边界（`0` / `65536` / `1.5` / 字符串数字 / 空值当未填）与 `listScaffoldTemplates` 返回的 `defaultPort` / `installKind` 自洽 |
| `create-project`（e2e，25 条） | 新增：FastAPI 的端口默认值**是 8000 而不是 5173**、改值能被接受、Python 栈**不出现**包管理器、**换成 NestJS 端口不被打回 3000**（用户改过的值优先）、换回 FastAPI 仍然是 8123、作业载荷与生成文件里的端口都是 8123 |

顺带记一条**跑测试的教训**：这一轮为了省时间，把 34 个 worker 的单测和端到端**同时**跑，
结果 `logs` / `my-tasks` / `overview` 三个场景一起红（下拉展不开、路由挂载超时），
单独重跑全绿。端到端是在**真窗口**上操作、靠"元素出现 / 坐标稳定"判定的，
机器一忙就超时 —— 红的是环境，不是产品。这条已经写进 `scripts/e2e/run.cjs` 的文件头，
免得下次再把"自己把机器占满"当成回归。

## 44. M4 第七刀：技术栈拆成「维度」，每个栈各自的端口（2026-09-28）

用户看完向导截图后提了两件事：**「提示改的官方一些」**（文案改成公文体，已在同一轮改完）
与**「技术栈能分开选吗」**。第二句在动手前先确认了含义（选项式提问），得到两条：
「再拆一级：框架 / 语言 / 附加项分开选」+「每个栈各自一行、各自一个端口」。

### 44.1 先说这一刀顺手查出来的真 bug

想在向导里"让每个栈分开配"，就得先看清端口现在是怎么走的。结果是：**整个作业只有一个 `port`**，
前后端两块共用。于是选「前后端项目」时，前端 `vite.config.ts` 的 `server.port`
与后端 `app.listen()` 会被写进**同一个端口号**（不填的话两块都拿第一个目标的 5173）——
生成出来的代码本身是坏的，起服务必撞号。

这不是显示问题，所以修法是结构性的：**端口属于"栈"，不属于"这次作业"**。

```
targets: [{ templateId, port, selections }]      ← 每个目标自己带
端口三级回落：目标自己的 → （旧载荷）作业级 port → 那个模板的惯例值
```

保留作业级 `port` 是因为**已落库的作业会重试**（重试就是拿原载荷再跑一遍），
删掉字段会让老作业直接报"不认识 port"。新调用方一律走 `targets[].port`，
端到端里也钉了一条"载荷里不该再出现作业级 port"。

### 44.2 维度是数据，拼参数是逻辑

「把技术栈拆开选」最省事的做法是在界面上写死几个控件。那会立刻制造用户最反感的东西：
**某个栈下面挂着一个点了也没用的开关**（给 FastAPI 选 pnpm、给内置模板选"要不要 Router"）。
所以拆成两层：

| 层 | 位置 | 职责 |
|---|---|---|
| **声明** | `scaffold-templates.ts` 的 `dimensions` | 这个栈能选什么（语言 / 附加项），每个选项对应哪些官方参数 |
| **逻辑** | `scaffold-options.ts` | 把选择拼成"要跑什么"，并处理官方做不到的组合 |
| **界面** | `ProjectWizard.vue` | **照声明渲染**：前端一行、后端一行；没有的维度不出现 |

几条落到实处的规矩：

- **只有一个候选的维度不做成控件**。NestJS 的语言是 TypeScript（唯一的），
  所以界面上是静态文字「语言：TypeScript」——一个只有一项的下拉是在骗用户"这里能选"。
- **内置模板没有任何维度**，所以 FastAPI / Django 那个卡片上不会出现附加项那一行。
- **默认值来自服务端声明**（`defaultSelections`），前端不写死第二份；e2e 里专门断言
  "NestJS 的严格模式默认是勾上的"。
- 换框架时维度选择重置为新框架的默认值，**端口只在用户没动过时才跟着惯例走**
  （改过就不动 —— 先定端口再挑框架是真实顺序）。

### 44.3 官方做不到的组合：换一条官方路，并说清楚

真查了 `create-vue --help` 才发现一条硬约束：

> Runs in interactive mode if started without feature flags, or if DIRECTORY is missing…

也就是说 **「JavaScript + 一个附加项都不要」这个完全合理的组合，create-vue 走不通**
（它会转成交互式提问，而我们的执行环境没有 TTY；也没有 `--no-ts` 这种反向参数，
真跑验证过：`--no-ts` 直接报错）。三条出路里选了第三条：

1. 偷偷替用户勾一个附加项 → 生成的代码与用户选的不一致（不可接受）；
2. 直接失败 → 明明有能用的官方模板（不可接受）；
3. **改用 Vite 官方的 Vue 模板**（`create-vite --template vue`）——并在作业日志里写明原因。

第三种做法的代价是"两个栈可能用两条不同的官方命令"，所以日志里那一行必须存在：
用户看到的是"为什么这次不是 create-vue"，而不是一个需要猜的结果。

另外 React 的 linter 也是显式的：`create-vite` 默认给 Oxlint，勾了 ESLint 才给 ESLint，
所以命令行里**总是**出现 `--eslint` 或 `--no-eslint` —— 用户勾了 ESLint 却拿到 Oxlint
是那种"看着成功了、其实不是你要的"的坏结果。

### 44.4 参数怎么过白名单（顺带修的一条）

`--template react-ts` 这种"参数 + 值"由 `CommandSlot.list` 展开成两个 argv 条目，
每个 token 单独过白名单正则（`--template` 与 `react-ts` 都合法）。
NestJS 那边原来是**写死** `--strict` 的，现在也走同一格（`{flags}`），
于是 `--skip-git` 固定带、`--strict` 跟着用户勾选走。

`buildCommand` 里补了一条：**可选的列表值位没给值时整格消失**。
不补的话，"用户什么都没选"会变成"参数 用到了未赋值的 {flags}"这类报错 —— 方向完全错了。
（非列表的可选值位仍然抛错：少一个值就是拼错了命令。）

### 44.5 内置回退骨架也要跟着语言走

选了 JavaScript 却在断网时收到一份 TypeScript 骨架，是那种"能跑但不对"的结果。
所以内置模板改成**一份文件清单 + 条件**（`when`）与路径占位符（`__EXT__` / `__JSXEXT__`）：

| 语言 | Vue 回退 | React 回退 |
|---|---|---|
| TypeScript | `tsconfig.json`、`src/main.ts`、`vite.config.ts`、`src/env.d.ts`、`<script setup lang="ts">` | `tsconfig.json`、`src/main.tsx`、`src/App.tsx`、`document.getElementById('root')!` |
| JavaScript | `jsconfig.json`、`src/main.js`、`vite.config.js`、`<script setup>` | `jsconfig.json`、`src/main.jsx`、`src/App.jsx`、无 `!` |

React 的入口刻意写了**两份**：`document.getElementById('root')!` 里的 `!` 是 TypeScript 专有语法，
出现在 `.jsx` 里是**语法错误**（不是类型错误，Vite 直接起不来）。差异只有一个字符，
但共用一份的下场是"选了 JS 得到一个起不来的项目"。

同时新增**一份 React 内置骨架**（`create-vite` 断网时的回退）——理由与上一刀补
NestJS / Django 一样：内置骨架的价值不是"像官方"，而是**让项目能开始**。

### 44.6 测试与真跑验证

| 测试 | 覆盖 |
|---|---|
| `scaffold-options.test.ts`（14 条，新） | 默认选择只看声明；选择校验（不认识的维度/取值必须报错）；**JS + 无附加项要换 create-vite 并写进 notes**；React 的 linter 必须显式；NestJS 固定带 `--skip-git`；内置栈硬调要抛错 |
| `scaffold-templates.test.ts`（16 条） | 新增"维度声明自洽"（默认值必须在候选里）、"渲染完不能剩下**大写**占位符"（`__VUE_TSDEVS__` 这种拼错会被静默写进生成的项目）、TS/JS 两套产物的文件清单、React 的 `tsx/jsx` 与 `!` 差异 |
| `job-scaffold.test.ts`（23 条） | 新增：**双栈两个目标各用自己的端口**（5174 / 8010）、没填的那一方回落到**那个栈自己**的惯例端口、选了 JS 落盘就是 `jsconfig.json`、payload 里的维度选择会被校验 |
| `commands.test.ts`（25 条） | 新增：可选参数列表没给值时整格消失；NestJS 的 `--skip-git` + 用户选项同格展开 |
| `create-project`（e2e，35 条） | 新增：只生成后端时**只有后端一行**、FastAPI 不出现语言下拉与任何附加项（"没有死控件"的端到端证明）、换 NestJS 后出现附加项且默认勾选、换回来控件收掉、**载荷里端口在 `targets[].port` 上且没有作业级 port** |
| `network-official`（e2e，16 条，**默认不跑**） | 真调 `npm create`：React+TS+ESLint 生成 `src/App.tsx` 与 `eslint.config.js`；Vue+JS+无附加项走 `--template vue` 且日志说明原因；Vue+TS+Router/Pinia 真的产出 `src/router` 与 `src/stores` |

> `network-official` 用 `requiresNetwork: true` 声明，**默认不跑**（要 `--network` 或显式点名）。
> 这是刻意的取舍：其余场景都不碰网络（"测试绑在网络与包源上迟早会红"），
> 但"能不能真的调得动官方脚手架"只靠单测证明不了 —— 上一版就是在这里栽的
> （参数被当成一个字符串）。所以留一个**显式点名才跑**的场景，而不是删掉它或者让它拖累日常回归。
### 44.7 拆完之后长出来的东西：向导比一屏还高（功能全绿、界面不能用）

技术栈拆成"前端一行 + 后端一行 + 附加项"之后，向导从"一屏放得下"变成"放不下"。
**功能断言当时是全绿的** —— 流程本身没有任何问题。拍图时量了一下才发现真数字：

| 形态 | 窗口高 | 向导高 | 「创建」按钮位置 |
|---|---|---|---|
| 仅后端（FastAPI） | 821px | 820px | y=808 ✅ |
| **前后端都要（Vue + NestJS）** | 821px | **1130px** | **y=1118 ❌ 看不见也够不着** |

也就是说**"前后端项目"这个组合根本建不出来**（按钮在视口外，而且没有滚动条 ——
内容区当时是 `overflow: visible`）。修法不是"把字号改小"，而是让它**结构性成立**：

```
.wizard { display: flex; flex-direction: column; max-height: calc(100vh - 40px); }
.wizard :deep(.n-card-content) { flex: 1 1 auto; min-height: 0; overflow-y: auto; }
.wizard :deep(.n-card-header), .wizard :deep(.n-card__footer) { flex: none; }
```

用弹性盒子表达"头尾固定、中间滚动"，而不是写死一个高度（写死的高度在小窗口上会把内容压扁）。

> 这里还有一条**踩坑记录**：第一版把选择器写成了 `.n-card__content`（凭记忆写的），
> 而 Naive 2.45 的实际类名是 `.n-card-content`（只有 footer 是 `__footer`）。
> 规则**静默失效**，CSS 不报错、断言也不关心 —— 唯一的证据就是量出来的 y=1118。
> 所以"改样式必须回读数字"这条留在了 `wizard-layout` 场景里。

### 44.8 端到端脚本自己的一个缺陷（顺手修掉）

上面那个布局问题还连出一个**测试工具的假象**：向导内容区开始滚动之后，
某个复选框"窗口坐标在视口内、实际被内容区裁掉"，`page.click()` 照着坐标点下去
**静默点空**（不报错、事件没触发），报出来的症状却是"安装没有按预期跳过"——
离现场非常远。

根因是脚本对"可见"的定义不完整：`getBoundingClientRect()` 与窗口比一次，
**没有考虑可滚动祖先的裁剪**。所以给它补了一条：元素被祖先裁掉时，先 `scrollIntoView`
再点（与"在视口外"走同一条路）。补完之后那条断言立刻恢复正常，
`create-project` 也顺便加了"内容最多的形态下按钮点得到"这条永久的断言。

新增 `wizard-layout` 场景专门盯布局不变量：四种项目类型 × 各框架各量一次
（不超视口 + 按钮可见），并留图供人工看 —— 功能断言过了不代表界面能用，
这次就是最好的例子。

## 45. M4 第八刀：版本选择（选的那一版真的写进依赖清单）（2026-09-28）

用户要的第四件事里的"版本选择"：**前端/后端各自选框架版本**，并真的落到生成出来的清单里。

### 45.1 为什么不能只靠官方脚手架

先查了官方脚手架到底能做什么：

| 脚手架 | 能不能挑版本 | 实测 |
|---|---|---|
| `create-vue` | 只能挑「3.5 稳定 / 3.6 RC」（`--vue-rc`） | RC 路径生成的 `package.json` 里是 `"vue": "rc"` + 一串 `overrides` |
| `create-vite`（React） | **不能** | 永远写它模板里那一版（实测当前 `^19.2.8`） |
| `nest new` | 不能 | 实测当前 `^12.x` |
| 内置 FastAPI / Django | 模板里写死 | `fastapi>=0.115`、`Django>=5.0` |

也就是说：**"锁 React 18.3""Django 4.2 LTS"这类需求，官方根本给不了**。
所以这一刀的能力点是"我们自己改生成出来的清单"，而不是"给官方多加一个参数"。

### 45.2 两条路径共用一段代码

```
选择（维度 version）→ pinsFor() 收集"包名 → 版本描述"
        ↓
官方脚手架成功（搬进目标目录之后）┐
                              ├→ applyVersionPins() → 改 package.json / requirements.txt
内置回退骨架写盘之后            ┘
```

放在两处调用是**故意的**：只做一处的话，会出现"联网时选了 18 是 18、断网回退时是 19"
—— 那种"只在断网时才暴露"的不一致最难查。抽成 `applySelectedVersions()` 之后两处做同一件事。

### 45.3 几条不肯让步的规矩

- **默认项不覆盖**。`create-vue` 写 `^3.5.42`，我们默认项写 `^3.5.0` —— 如果照我们的写，
  等于把范围**写松**了。所以"当前稳定"这个默认选项**不带 pins**，让官方原样留着。
- **只改已经存在的依赖**。清单里没有 `@nestjs/core` 时**如实报跳过**，绝不偷偷加一条 ——
  加一条是"替用户改依赖树"，不是"改版本号"。这条直接写进了单测。
- **引擎要求不覆盖已有的**。`create-vue` 会写 `^22.18.0 || >=24.12.0`（比我们声明的严），
  照我们写就是**放宽**，于是 Node 20 的机器也能装上一个跑不起来的项目。
  所以只对"没有声明过 engines 的"项目（内置回退骨架、`create-vite` 的产物）补上。
- **清单解析不了就一个字都不改**。宁可让用户看到问题，也不要把他那份 `package.json` 换掉。
- **Python 只替换版本那一段**，保留 extras 与注释（`uvicorn[standard]>=0.54`、`# 直接依赖`）。

### 45.4 Node 要求是静态文字，不是开关

`engines.node` 来自工具链自己的声明（Vite 8：`^20.19.0 || >=22.12.0`；`@nestjs/core`：`>=20`），
在向导里**只显示**（「需要 Node ^20.19.0 || >=22.12.0（写进 package.json 的 engines）」），
Python 栈不显示。做成下拉就是"点了也没用"的控件：这个数字不是用户能决定的。

### 45.5 测试

| 测试 | 覆盖 |
|---|---|
| `scaffold-versions.test.ts`（10 条，新） | Node：改已存在的依赖且不挪段；**没有的包如实跳过**；engines 只在未声明时写（已有 `^22.18.0…` 时不覆盖）；清单坏了不改；值相同不写盘。Python：保留 extras/注释、包名大小写不敏感、没找到会说 |
| `scaffold-options.test.ts`（16 条） | 默认选择含"版本"维度；版本取值校验（不在候选里要报错） |
| `job-scaffold.test.ts`（23 条） | 清单带上 `enginesNode`；Python 栈的维度只有"版本" |
| `create-project`（e2e，40 条） | 向导里真的能选版本，**生成的 `requirements.txt` 里是 `fastapi==0.141.*`**（不是模板里的 `>=0.115`），日志里写了改了哪一条 |
| `wizard-layout`（e2e，16 条） | 每个栈各有版本下拉；Node 栈显示 Node 要求、Python 栈不显示 |
| `network-official`（e2e，+4 条，默认不跑） | **官方路径的版本改写**：`create-vite` 生成 `react ^19.2.8`，我们按选择改成 `^18.3.1`（`react` 与 `react-dom` 一起），并补上 engines |

> 又一条测试顺序的教训：版本选择这一步我一开始写在"切框架"之前，
> 结果被切框架时的"重置为新框架默认值"覆盖掉了（**这是产品正确行为**：
> Vue 的版本和 React 的版本不是一回事），报出来却是"requirements.txt 没改"，
> 看着像版本功能失效。e2e 里把这一步挪到最后，并在注释里写明"必须先挑框架、再选版本"。

## 46. M4 第九刀：管理侧模板（新建即非空）（2026-09-28）

前八刀把"代码怎么生成"做透了，但**管理侧还是空的**：骨架生成完、依赖装好，
打开工作台仍然是"0 个任务"。用户要的原话是「新建即非空项目」——所以这一刀补的是：
一个刚建出来的项目，工作流、任务清单、里程碑、文档模板**都已经在位**。

### 46.1 四块内容，四套模板

按项目形态分四套（与向导的四张类型卡一一对应）：

| 形态 | 工作流 | 任务清单 | 里程碑 |
|---|---|---|---|
| 纯管理 | 待处理 → 进行中 → 已完成 | 立项 / 计划 / 执行 / 验收（各带子任务） | 范围冻结、完成验收 |
| 仅前端 | 需求评审 → 开发中 → 联调中 → 测试中 → 已上线 | 需求与会话 / 工程准备 / 页面开发 / 联调自测 / 上线 | 交互与接口确认、功能冻结、上线 |
| 仅后端 | 需求评审 → 接口设计 → 开发中 → 联调中 → 已上线 | 需求与接口 / 数据模型 / 接口实现 / 联调自测 / 上线 | 接口与数据模型冻结、主流程完成、上线 |
| 前后端 | 需求评审 → 接口约定 → 开发中 → 联调中 → 已上线 | 需求与接口约定 / 前端 / 后端 / 联调自测 / 上线 | 接口约定冻结、两端完成、上线 |

几条刻意的取舍：

- **任务只列"每个项目都躲不开的事"**（十来条、带层级）。塞四十条"用户故事"看着更专业，
  实际是让用户先删一半 —— 那比空着更糟。
- **工作流状态必须落在 `todo / doing / done` 三个分类里**（应用的自动完成、看板分组都依赖它），
  所以「联调中」是 `doing` 而不是自成一类。中间状态可以有很多，但语义只有三种。
- **状态与任务都带层级关系**：任务清单是父子结构（工作台是分层空间，父子关系能显示进度）；
  子任务**不单独指定状态**（跟着父任务所在列走，单独指定只会让人困惑）。

### 46.2 文档模板：写进 `<项目文件夹>/docs/`

M3（文档模块）还没做，所以这一版按需求 §5.9 的降级方案：**直接往项目文件夹里写 `.md`**，
应用里暂时看不到它们（这一点在需求里写明了，不是假装）。

四份：需求文档 / 技术方案 / 会议纪要 / 架构决策记录。来源与许可（需求要求标注）：

- **ADR 的结构取自 MADR**（Markdown ADR，MIT 许可），模板里写明出处与链接；
- 其余三份是通用结构（"背景-目标-方案-风险"、"时间-参与人-结论-待办"），
  **没有可声称的单一出处，因此不标来源** —— 编一个来源比不标更坏。

模板里**不写示例正文**：塞满"这里是你的需求描述"这种占位句，只会被用户原样留着。
写的是**该填什么**（每节一句话说明 + 常见小节），并且每份都以 `> ` 提示行说明"填完删掉提示"。

### 46.3 幂等，以及"不替用户加东西"

向导失败重试是常规操作，所以这一步必须幂等。规矩是**按名字查重**，重复时**如实报跳过**：

| 情况 | 行为 |
|---|---|
| 全新项目（模板的状态名都不在） | 整套换上工作流 + 建任务 + 建里程碑 + 写文档 |
| 重复调用（状态名都在） | 全部跳过，小结里写"跳过已存在的 N 项" |
| 用户改过或删过状态（部分在） | **也整套跳过**，只报出来 |

第三种是刻意的：按"补缺"的思路把缺的状态加回去，听起来贴心，实际是"我刚删掉的又冒出来了"。
宁可少铺一次，也不要在用户已经动过的项目里自己加东西。（第一版就是"补缺"，被单测当场纠正。）

文档走的是与代码模板同一条规矩：**已存在的文件不覆盖**（用户可能已经写了内容）。

### 46.4 这一刀顺手修的三处

**（1）纯管理项目：说了却没做。**
`run()` 里原来有一句"不需要生成代码就直接跳到完成"，于是**最该"新建即非空"的那一类项目**
（纯管理项目）只拿到一个空项目，而结束语照样写着"工作流与任务清单已铺好"。
这是端到端量出"0 个任务"才发现的 —— 注释里那句"纯管理项目不需要生成代码"看着很合理，
但它顺手把"管理侧"也一起跳过了。

**（2）里程碑只有接口，界面上只能看。**
里程碑的增删改在服务端一直都有（总览页右侧也一直在显示），但界面上没有任何操作入口 ——
典型的"功能只有 API 能碰"。以前没人注意，是因为**里程碑一直是空的**；这一刀开始自动铺里程碑，
面板立刻就"有东西但动不了"了。所以补上了就地操作：达成 / 取消达成 / 删除 / 新增。

**（3）`<NInput>` 渲染成了一个没解析的标签。**
里程碑面板用的是原生控件，我却在里面写了 `<NInput>`（Naive 组件）——而那个视图**没有引入任何
Naive 组件**。Vue 把它当成未知元素渲染成 `<ninput>`，端到端报的是"输入框不存在"。
最后是把元素的 `outerHTML` 打出来才看明白：`<ninput size="small" …>`。
这条记在注释里了：**同一个视图里不要混着两种控件体系**。

### 46.5 测试

| 测试 | 覆盖 |
|---|---|
| `project-template.test.ts`（11 条，新） | 四套模板自洽（分类从 todo 到 done、状态名不重复、层级有意义）；**幂等**（第二次全跳过、任务数不变）；用户改过状态名后**不补也不换**；已存在的文档不覆盖；每一步能单独关；没有工作区目录时如实报"没写文档"；小结措辞 |
| `managed-project`（e2e，26 条，新） | 纯管理项目：步骤是 env/创建/模板；工作流=待处理/进行中/已完成；任务 ≥10 且带层级；里程碑带截止日；`docs/` 里四份文档；**工作台立刻有卡片**；里程碑的达成/取消/新增/删除都能用（并且落库）；取消勾选后**真的是空项目**且向导如实说明 |
| `create-project`（e2e，50 条） | 后端项目：工作流换成后端流程（含「接口设计」）、默认三状态被替换而非并存、任务带层级、里程碑 ≥3、`docs/` 四份、ADR 标注 MADR |

## 47. M4 第十刀：Django 的官方路径（先装工具，再调官方）（2026-09-28）

前几刀里 Django 一直是**唯一只用内置模板**的栈，理由是"`django-admin startproject` 要先有 Django，
那属于装依赖"。这一刀把它接上，接的过程撞到两个**只有真跑才会出现**的问题。

### 47.1 Django 与其它栈的根本区别：官方工具不自带

| 栈 | 官方命令 | 工具从哪来 |
|---|---|---|
| Vue / React | `npm create vue@latest` / `vite@latest` | npx 自己把包拉下来 |
| NestJS | `npx @nestjs/cli new` | 同上 |
| **Django** | `django-admin startproject` | **得先 `pip install django`** |

所以这条路前面多一段**前置**（`bootstrapDjangoScaffold`）：

```
1) 没有 .venv → 用全局 python 建一个（有就复用，不重复建）
2) 写 requirements.txt（Django + 用户选的版本）—— 官方 startproject **不会**生成它
3) venv 里 pip install -r requirements.txt（这一步要联网）
4) 确认 venv 里真的有 django-admin，并且它的命令表里有 startproject
5) 之后才走"暂存目录里生成 → 成功后搬进项目文件夹"那条所有栈共用的路
```

前置失败（断网、PyPI 不通、venv 建不起来）→ **回退内置骨架**，与 Vue / React 同一条规矩。
理由和之前一样：不能让用户连一个能跑的项目都拿不到。

三个刻意的选择：**venv 建在项目文件夹里**（与"装依赖"那一步**共用**一个环境，否则用户会得到两份几百 MB 的
环境且不知道哪个是真的）、**先写 `requirements.txt` 再 pip**（走白名单里已有的命令，顺便给项目一份
正确的依赖清单）、**版本从清单走而不是命令行**（`django-admin` 不认版本参数）。

### 47.2 真跑一次才发现的：相对路径 vs cwd

第一版按 `django-admin startproject <name> .` 写，把 cwd 设成暂存目录 —— 结果：

```
$ .venv\Scripts\django-admin.exe startproject probe_django . → 失败（退出码 ENOENT）
```

`django-admin` 是 pip 装进 **venv** 的，不在 PATH 上，所以命令白名单里它是**项目内相对路径**
（这是对的：全局装了 Django 也不该用那一个）。但相对路径是**相对 cwd** 解析的 ——
cwd 一旦是暂存目录（`.scaffold-staging`），它就会去暂存目录里找 `.venv\Scripts\django-admin.exe`。
报出来是"命令找不到"，看着像"Django 没装上"，方向完全错了。

修法不是"改成绝对路径"（那会破坏白名单纪律：`RELATIVE_BIN_PATTERN` 不允许绝对路径与 `..`），
而是**让 cwd 留在项目文件夹**、把暂存目录当作 Django 的**目的地参数**传进去：
`django-admin startproject <name> <destination>`。于是命令白名单里多了一格 `destination`：

- 只允许**单段**相对目录名（例 `.scaffold-staging`），不允许分隔符；
- 而且**不允许 `.` 与 `..`** —— 单测当场抓到第一版正则 `^[A-Za-z0-9._-]+$` 放过了 `..`，
  那会让 Django 把项目生成到项目文件夹**外面**。

> 这条与 §44.3 是同一类教训：**"看起来像外部工具坏了"的报错，先怀疑我们传的东西**。

### 47.3 顺带记一条：`cwdRule` 目前只是声明

`commands.ts` 里每条 spec 都写了 `cwdRule: 'workspace' | 'project' | 'tmp'`，但**运行时并没有用它校验** ——
真正保证"命令只在我们给的项目目录里跑"的是**调用方传的 `cwd`**（作业层一律传目标目录）。
这一刀没有顺手加校验（改动面会波及所有命令与测试），但把它记在这里，避免以后误以为它已经生效。
新增的 Django 前置里，所有 `cwd` 都是项目目标目录或其内部的暂存目录。

### 47.4 测试

| 测试 | 覆盖 |
|---|---|
| `scaffold-django.test.ts`（9 条，新） | 前置的顺序与值位（venv → pip → 探测）、**已有 venv 就复用**、已有 `requirements.txt` 不覆盖、没 python / pip 失败 / 没生成入口 / 帮助里没有 startproject 各自的**如实报因**、`venvBinPath` 的 Windows 与 POSIX 差异 |
| `job-scaffold.test.ts`（24 条） | 新增：**Django 前置失败 → 回退内置骨架且真的落盘**（"断网也能用"的保证） |
| `commands.test.ts`（25 条） | Django 的 `django-admin` 与 `destination` 都过白名单；`..`、分隔符、绝对路径、`1site`、`my-site` 一律拒绝 |
| `scaffold-options.test.ts`（17 条） | Django 的官方调用是 `scaffold-django`，版本**不走命令行**，且**必须**有内置回退 |
| `network-official`（e2e，+8 条，默认不跑） | **真跑**：建 venv → pip 装 **4.2 LTS**（用户选的版本）→ 探测 → `startproject` 生成 `manage.py` + 项目包 → 搬进项目文件夹；断言"走了官方"且"**没有**回退"，`requirements.txt` 里是 `>=4.2,<5`，`.venv` 留在项目里 |

## 48. M4 第十一刀：项目间关系链（纯展示，但必须能用）（2026-09-28）

需求 §5.2.1 早就写下了这条，但一直**待排期**，因为它当时留了四个问题要定：
端点、关系名称、方向、显示在哪。这一刀把四个问题都定了并落地。

### 48.1 四个问题怎么定的

| 问题 | 决定 | 理由 |
|---|---|---|
| 端点 | 两个项目（有向的 from → to） | 需求里的例子本身就是有向的：「前端项目 → 调用 → 后端项目」 |
| 关系名称 | **自由文本**（40 字上限） | 用户给的例子是「调用」「同属一个系统」——枚举立刻不够用；做成配置表又是把"展示用的一句话"当配置管 |
| 方向 | 有向，界面上画箭头 | 无向的话"谁调用谁"就说不清了 |
| 显示在哪 | **项目卡片**（关系名小标记）+ **总览**（能增能删的面板） | 卡片是"扫一眼"的地方，不该放两个下拉加按钮；真正的操作放在项目自己的页面上 |

### 48.2 这个模块刻意"少做"什么

需求里那句话是硬要求：「两个项目的数据**互不可见、互不影响**」。
所以这一刀不只是"没写联动代码"，而是**从数据形状上就不给联动的口子**：

```
project_relations: id, from_project_id, to_project_id, label, note, created_at, updated_at
```

- **没有** kind 枚举、没有权重、没有联动开关 —— 表里没有任何一个字段会被后人误用成"规则"；
- **没有**环检测：关系只用来画一条线，成环不影响任何计算。真做了环检测，用户想标
  "A 调用 B、B 回调 A"时会莫名其妙被拒（单测里专门钉了"反向同名关系允许"）；
- 单测里还有一条**反过来**的断言：标完关系之后，另一侧项目的任务数、状态数、`docs/` 目录
  **必须一字不变** —— 这条比"我们没写联动"有力得多。

校验只有四条（服务端不做只靠界面）：两端项目存在且未删除、不能连自己、同一对端点同名不重复、
名称与备注有长度上限。

### 48.3 顺手处理掉的三个细节

1. **两个方向都要能查到**。只查出向的话，后端项目自己那一页看不到「前端项目 → 调用 → 我」——
   而那恰恰是它最该知道的事。所以接口返回 `direction: 'outgoing' | 'incoming'`，
   界面按方向画箭头，入向那一侧写「本项目」。
2. **软删除保留、物理删除清理**。项目进回收站（软删除）时关系**留着**（恢复项目后关系还在，
   面板上给归档/缺失的项目标出来）；物理删除时关系跟着消失（数据库上是 `ON DELETE CASCADE`），
   并且**显式删一遍**以留下活动记录 —— 否则回看历史会发现"某条关系凭空消失"。
3. **卡片小结走一个独立路径** `/projects/relation-summary`（不是 `/projects/:id/...`）。
   用路径参数的话，`relation-summary` 会被当成一个项目 id，命中哪条路由取决于注册顺序 ——
   这种"顺序对了才对"的接口不该存在。

### 48.4 测试

| 测试 | 覆盖 |
|---|---|
| `project-relations.test.ts`（13 条，新） | 自由填的关系名与方向；两个方向都查得到；不能连自己；同名重复被挡但**反向同名允许**（不做环检测）；名称长度上限与去空格；软删除项目不能当端点；**软删除后关系保留、恢复后还在**；物理删除后关系被清且留下活动记录；**关系表里没有"会联动"的字段**（PRAGMA 断言列名）；标关系后另一侧的任务/状态**一字不变** |
| `relations`（e2e，18 条，新） | 面板上写明"只做展示"；下拉里能看到另一个项目；自由填「调用」并真的入库；两个方向都对；项目卡片上出现关系名；**标关系后对端项目的状态/任务/磁盘文件都没变**；重复与自连被服务端挡住；删除真的删掉 |

## 49. M4 第十二刀：项目的启动 / 停止（2026-09-28）

用户要求：「先完成项目的启动停止功能，且只有前端、后端、前后端项目有启动停止按钮」。

### 49.1 顺手把一个占位变成了真的

项目卡片上一直有个「运行中」标签 + 蓝色光晕 + 一个恒为空的 `runningProjectIds`。
代码注释写得很坦白："先把可视反馈的位置占住，等作业接进来只需要往这个集合里塞 id"。
也就是说 —— 那是**一个从来没亮过的状态**。这一刀让它变成真的：数据源是服务端的
开发服务器状态，点启动/停止之后刷新。

### 49.2 为什么它不能走作业执行器

作业的语义是"跑完拿结果"：有超时、有进度、跑完返回退出码与输出。
开发服务器**永远不结束**，而且输出要**边跑边看**（端口号就在启动横幅里）。
所以：

- `commands.ts` 里新增了 `longRunning: true` 这一档（`timeoutMs: 0` 是**声明**，不是漏写）；
- `runCommand` 会**拒绝执行**长驻命令并指出正确用法 —— 否则"点了启动，界面永远空白"，
  因为 `runCommand` 会把输出缓存到进程结束再返回；
- 长驻命令走 `dev-servers.ts` 里的**流式**执行器（`spawn` + 按行收集输出）。

### 49.3 停止必须杀**整棵进程树**

`npm run dev` 在 Windows 上是 `cmd.exe /d /c npm run dev` → `npm` → `node`。
只杀最外层（`child.kill()`）留下的是**真正在监听端口的孙进程**：端口还占着，
用户点过"停止"却起不来第二次，现象是"端口被占用"。所以停止走白名单里的
`taskkill /PID <pid> /T /F`（`kill-process-tree`）：pid 只收数字，且只传我们自己 spawn 出来的那个。

**等它有上限**：`taskkill` 自己卡住时不能让停止请求永远挂着（界面上就是"点了一直转圈"）。
超时（5 秒）就**如实报**"进程可能还在运行，端口可能还被占着"，而不是照旧记成"已停止"——
后者会把"端口被占"变成一个查不出来的怪现象。

### 49.4 "跑什么"是**探测**出来的，不是记下来的

项目是可以在应用外面被改的（用户自己换了 vite 端口、加了 npm script）。
记在数据库里的话，代码改了、应用里还按老配置起 —— 那是最难查的一类问题。所以每次启动前
读项目文件夹：

| 目录特征 | 认成 | 启动命令（全部来自命令白名单） |
|---|---|---|
| `package.json` 有 `scripts.dev` | Vite 前端 | `<pm> run dev` |
| `package.json` 有 `scripts.start:dev` | NestJS 后端 | `<pm> run start:dev` |
| `manage.py` | Django | `.venv/Scripts/python manage.py runserver <port>` |
| `app/main.py` + `requirements.txt` | FastAPI | `.venv/Scripts/python -m uvicorn app.main:app --reload --port <port>` |

端口从生成出来的 `vite.config.*` / `.env` 里读，读不到再用各栈的默认值（5173 / 3000 / 8000）。
脚本名是**白名单枚举**（`dev` / `start` / `start:dev`）：用户能决定"哪个项目、哪个角色、哪个端口"，
不能决定"跑什么脚本"。包管理器复用"装依赖"那一步的挑选逻辑（`pnpm → npm → yarn`），
免得出现"依赖是 pnpm 装的、启动却用 npm run"。

认不出来就**如实报**（"在项目根目录里没找到认得的入口"），不猜一条命令去跑。
**纯管理项目**（`codeKind === null`）连"能不能启动"都是 false —— 界面据此不显示按钮，
而不是界面自己按 codeKind 猜（猜的规则迟早跟服务端分叉）。

### 49.5 依赖没装好就别启动

Node 项目没有 `node_modules`、Python 项目没有 `.venv` 时，启动会被挡下并给出**可操作的原因**
（"还没装依赖 —— 先跑一次「安装依赖」"），而不是让用户看一堆 `command not found`。
端到端里专门有一条：点启动之后**不能**出现「运行中」（不谎报）。

### 49.6 状态只放在内存里

开发服务器是"这次运行期间的进程"：应用重启后它就不存在了。把状态写进数据库会留下
"界面上显示运行中、实际没有进程"的假状态 —— 所以这一版**不落库**。
应用退出时 `onClose` 里全部停掉（不留孤儿进程占端口）。

### 49.7 一处接口语义的修正（端到端抓到的）

第一版"已经在运行了"抛的是普通 `Error` → 接口层映射成 **500「服务器内部错误，请点击查看日志」**。
连点两次启动是**正常操作**，报 500 等于把用户的操作问题说成我们的故障。改成：
重复启动 `409 CONFLICT`、没有可启动目标/依赖没装好 `400 VALIDATION_FAILED`、
没有工作区目录 `409 WORKSPACE_UNAVAILABLE`。

### 49.8 测试

| 测试 | 覆盖 |
|---|---|
| `commands.test.ts`（27 条） | 新增：启动命令走白名单（脚本名是枚举，`postinstall`/`deploy` 进不来）、Python 侧端口只收数字、`kill-process-tree` 只收数字 pid；**长驻命令不许走 `runCommand`**；长驻 spec 的 `timeoutMs: 0` 是显式声明 |
| `project-run.test.ts`（11 条，新） | 纯管理项目不给目标；Vite/NestJS/Django/FastAPI 四类各自的命令与端口（含从 `vite.config.ts`、`.env` 读端口）；没装依赖 → 不可启动并说明原因；前后端项目两个子目录各一个目标且**值位里不含绝对路径**；认不出来时给出"在哪个目录里没找到什么" |
| `dev-servers.test.ts`（10 条，新） | 用白名单命令启动、cwd 是项目文件夹；输出**边跑边收**；依赖没装好 → 报原因且**不派生进程**；重复启动被挡；端口可临时改；停止**杀整棵进程树**（断言 `taskkill /PID 4242 /T /F`）；进程自己退出算失败并留下原因；停止后能再启动；应用退出时全部停掉 |
| `run-project`（e2e，17 条，新） | **真的起一个进程再停掉**：卡片上有启动按钮（前端项目）／**没有**（纯管理项目）；点启动 → 出现「运行中」且写出端口、端口**真的在监听**、输出被收进日志；重复启动被挡且是 **409 而不是 500**；点停止 → 端口**真的释放**；缺依赖的项目点启动不谎报 |

### 49.9 用户指出的两处：位置错了，而且是**我漏看了一个假占位**

用户看完第一版后圈了图：真正的「启动」是他圈出来的那个 ▶ 按钮，我新加的带文字「启动」被划掉了。

原因很直接 —— **项目卡片的操作区里早就有一个 ▶ 按钮，是个禁用占位**：

```vue
<!-- 「启动 / 停止」先占位：真正的启停要走作业系统（M4）… -->
<NButton size="tiny" quaternary disabled>▶</NButton>
  启动 / 停止：等作业系统（M4）接入后可用
```

它出现在**每一张**卡片上（连纯管理项目也有），而且是 disabled 的。我上一刀做启停功能时读了
这个文件（为了找 `.ops` 的位置），却**没有把这段占位和我要做的事联系起来** ——
结果在最左边加了一个带文字的按钮，既不符合"这一排都是纯图标"的既有风格，
又让那个假占位继续留在原地。用户一眼就看出来了。

修正：

1. **删掉假占位**（连同它那句"等作业系统（M4）接入后可用"）； 端到端里加了一条断言
   **页面上不能再出现这句话** —— 假占位这种东西，光删代码不够，要有一条测试盯着它不回来。
2. **真的启动 / 停止按钮就放到那个位置**（用编辑器打开 → **启动/停止** → 归档 → 删除），
   形式与同排其它按钮一致（纯图标 + 悬停提示）。
3. 只有**前端 / 后端 / 前后端**项目有这一格（判据是服务端的 `runnable`）；纯管理项目那一格
   直接不存在，而不是"存在但禁用"—— 后者就是原来那个假占位的老毛病。

### 49.10 「让项目程序运行」，而不是只变个状态

用户这句话点得对：状态变了不等于用户**看见了**程序在跑。所以再加一个入口：

- 运行中时，卡片上多一个按钮「**在浏览器里打开 http://127.0.0.1:<port>**」；
- 它不是装饰 —— 点开能看到页面，就是"真的跑起来了"的最直接证据；
- 停止之后这个入口立刻收起来（不给一个打不开的入口）；
- 实现上走渲染进程的 `window.open`，主进程的 `setWindowOpenHandler` 会把它交给系统浏览器
  （应用内不开新窗口），不需要新增 IPC 与白名单。

> 这一条也解释了为什么"状态标记 + 端口"还不够：**用户要的是能验证的结果**，
> 不是我们声称的结果。这与整个项目里反复出现的同一条纪律是一回事。

### 49.11 「没有正常启动」的真正原因：我把地址拼错了

用户实测后反馈「没有正常启动」。查日志 + 查现场，得到的事实是：

| 时间 | 事实 |
|---|---|
| 14:34:57 | 用户点启动 → `cmd /d /c pnpm run dev` → `pnpm` → `cmd /d /s /c vite` → **vite 真的起来了** |
| 当时 | vite 在监听 **`::1:5173`**（IPv6 回环），`127.0.0.1:5173` 上**什么都没有** |
| 14:36:25 | 用户点停止 → 整棵树被杀掉 |

根因：`dev-servers` 给界面的"在浏览器里打开"是**我们自己拼的** `http://127.0.0.1:<port>`。
而 Vite 默认绑 `localhost`，在这台机器上解析成 `::1` —— 于是用户点开是"无法连接"，
现象就是"没启动"，而我们这边状态显示得好好的。

**为什么不能怪"用户的机器特殊"**：绑 `localhost` 是 Vite 的默认行为，我们**本来就无权假设**它绑在
哪个回环上（IPv4 / IPv6 都可能）。正确做法是**不去猜**：

1. **从进程输出里学地址**（`parseDevServerUrl`）：Vite 打印 `➜ Local: http://localhost:5173/`、
   uvicorn 打印 `Uvicorn running on http://127.0.0.1:8000`、Django 打印
   `Starting development server at http://…`。顺便解决了"端口被自动换掉"（5173 被占 → 5174）——
   只有读它自己的输出才知道真话。`0.0.0.0` 归一成 `localhost`（那不是能给用户点的地址）。
2. **探测它是否真的连得上**：启动后每 500ms 试一次（`localhost` / `127.0.0.1` / `[::1]` 都试，最多 60 秒），
   通了才把 `reachable` 标成 true。**连不上就不给"打开"入口** —— 宁可没有，也不给一个打不开的链接；
   等待期间显示"服务已启动，但地址还没通（第一次启动要预构建依赖）"。
3. **界面持续轮询**（有东西在跑时每 2 秒刷新一次，没有就停）：这是我漏的第二件事 ——
   原来只在点按钮时拉一次状态，于是"地址通了"这个变化界面永远看不到，
   用户会一直停在"运行中却没有打开入口"的状态，感受还是"没启动"。
4. **运行面板**：点卡片上的「运行中」标记打开，里面是每个目标的**状态 / 命令 / 真实地址 /
   是否连通 / 启动输出**，并且能就地停止。这是"没启动"时唯一能查的地方 ——
   以前输出只存在内存里、界面上一个字符都看不到。

> 测试数据也必须真实。第一版端到端里我让种子服务 `listen(port, '127.0.0.1')` ——
> 于是"应用拼的 127.0.0.1"看起来是对的，**恰好把用户遇到的坑绕过去了**。
> 现在种子服务改成 `listen(port, 'localhost')`（照着真实 Vite 的行为），并且断言
> **"应用给出的地址真的能返回 200"**（HTTP 请求，不是只测 TCP）。这条断言就是这次的回归测试。

另一条顺手记下的运维事实：**应用被强杀时开发服务器会变成孤儿进程**（正常退出会在 `onClose` 里全停）。
实测中被中断的端到端就留下了一棵树占着端口，导致下一次运行"端口不是空的"。
这不是产品缺陷（状态只放内存、进程不该被别的进程随意杀），但要写下来：
遇到"端口被占用"时，先确认是不是上次没有正常退出留下的。

### 49.12 又三件：端口写进配置、装依赖入口、输出自动跟随（以及一个我自己制造的连环 bug）

用户选了这三件一起做。前两件是补"说了却没做"的口子，第三件是让输出真的能跟着走。

**（1）端口对官方脚手架是白填的（`scaffold-port.ts`）。**
向导里有端口输入框，但只有**内置模板**会把端口写进生成的文件；官方脚手架不会 ——
`create-vue` / `create-vite` 的 `vite.config.ts` 里根本没有 `port`，`nest new` 的 `main.ts` 里是
`process.env.PORT ?? 3000`。于是走官方路径时用户填的端口被**默默忽略**（项目实际跑 5173 / 3000）。
现在官方脚手架生成完之后我们自己补：`vite.config.*` 有 `server.port` 就改数字、有 `server` 就插一行、
都没有就在 `defineConfig({` 后插一整块；NestJS 改 `app.listen(...)` 里的默认端口。
认不出技术栈、或找不到 `defineConfig` 就**什么都不改并说明**（绝不半改）。
端到端在官方 Vue 路径上直接断言生成的 `vite.config.ts` 里有 `server: { port: 5302 }`。

**（2）"先跑一次安装依赖"原来指不到任何操作（运营死胡同）。**
启动被依赖检查挡下时提示写着"先跑一次安装依赖"，但界面上**没有任何地方能装**。
现在：卡片上**只在缺依赖时**出现一个「装依赖」按钮（依赖齐了就没有这一格，不摆常驻按钮），
点了就在运行面板里跑安装作业，**进度条与安装输出都在面板里**，装完 `ready` 变了按钮自己收起来。
模板 id 用**服务端探测出来的那个**（`target.templateId`）：装依赖是按模板 id 决定"装什么、装到哪"的，
让界面按 kind 猜的后果很具体（给 Vue 项目装 FastAPI 的依赖）。

**（3）运行面板打开时自动跟随输出**（1.2 秒一次），并按终端习惯滚到底。
用户要的是"像终端一样往下走"，而不是手动点刷新。

### 49.13 这一轮踩的坑，一半是我自己制造的（记下来）

**坑一：我用"整段替换"改代码，把相邻的两个函数一起删了。**
`openRunPanel` 与 `refreshRunOverview` 正好落在我替换的区间里，被静默删掉。
现象是"点了没反应"，而我当时**误判成"Naive 的 NTag 不触发 @click"**，还把这个错误结论写进了注释。
正确的做法是改完立刻验证（哪怕只 grep 一下函数还在不在）。

**坑二：`.vue` 文件根本不在 `tsc` 的检查范围里。**
`packages/desktop/tsconfig.json` 的 `include` 里写着 `src/**/*.vue`，但普通 `tsc` 不解析 `.vue` ——
所以"在 `.vue` 里引用了没引入的标识符"这种错**编译期查不出来**。实测：
`jobsApi is not defined`（写装依赖时忘了 import），被 `catch` 吞成一条提示，
表现是"点了装依赖什么都不发生"。
两处补救：
- 端到端加了一条**永久守卫**：点击之后界面上**不许出现** `is not defined` / `ReferenceError` /
  `Cannot read propert` 这类文本（专门盯"被吞掉的 JS 报错"）；
- 结论写进这里：**这类错要靠端到端兜**，除非引入 `vue-tsc`（见"还没做"）。

**坑三：面板里的安装进度块我放在了目标循环里面。**
它是**项目级**的东西，放在 `v-for` 里会每个目标渲染一遍；而且条件写的是
`installState?.projectId === runPanelProject.id` —— 面板关闭的一瞬间 `runPanelProject` 是 null，
于是每 1.2 秒的轮询把它刷成一屏 `Cannot read properties of undefined (reading 'id')`。
现在它挪到循环外面，条件用 `runPanelProject?.id`（可选链），并且 `tsc` 又一次没能拦住它。

**坑四（不是产品的错，但要记）：端到端沙箱在本仓库里面。**
仓库根有 `pnpm-workspace.yaml`，于是夹具项目里跑 `pnpm install` 会往上找到仓库的 workspace，
"Scope: all 4 workspace projects"、把依赖装到仓库根去 —— 项目自己没有 `node_modules`，
现象是"安装成功"但启动仍报"还没装依赖"。
夹具改成给测试项目一个自带的 `pnpm-workspace.yaml`（自成一个 workspace 根）。
顺带给**产品**加了一条如实的提醒：Node 侧装完之后如果 `node_modules` 仍然不存在，
就在作业日志里 **warn** 说清"项目可能位于别的 pnpm workspace 里面，可以放一个空的
pnpm-workspace.yaml 或改用 npm"——否则用户会反复点安装却永远装不上。

### 49.14 测试

| 测试 | 覆盖 |
|---|---|
| `scaffold-port.test.ts`（11 条，新） | 用**官方脚手架真实生成的形状**做夹具：没有 `server` 时插一整块、已有 `server.port` 只换数字、有 `server` 没 port 时补一行、认不出 `defineConfig` 就什么都不改、`.js` 配置也认、NestJS 的 `app.listen(process.env.PORT ?? 3000)` 与 `app.listen(3000)` 都改；Python 项目不碰；非法端口不写 |
| `dev-servers.test.ts`（15 条） | 新增：`parseDevServerUrl` 认 Vite / uvicorn / Django 三种写法、端口被自动换掉时以输出为准、`0.0.0.0` 归一成 localhost、认不出返回 null |
| `run-project`（e2e，36 条） | 新增：缺依赖时出现「装依赖」、依赖齐了**没有**这一格、点它打开面板并看到**进度与安装输出**、装完 `ready` 与按钮收起、**面板打开不会把页面带走**、以及那条永久守卫（界面不许出现 JS 报错） |
| `network-official`（e2e，+2 条） | 官方 Vue 路径：生成的 `vite.config.ts` 里真的有 `server: { port: 5302 }` |

---

## 50. 0.2.1：工作大纲、今日待办、打卡与工作日志（2026-09-30）

用户的原话：「我现在想给工作台和我的代办进行完全重构一下，工作台的内容我希望改成工作大纲，
作用是对整个项目创建一个工作大纲，我的待办主要显示我今日的代办事项，展示我当日的工作时间，
且在我的代办中需要新增一个功能，生成工作日志，需要展示我当日的工作内容」。

四个问题都问过用户，答案决定了这一版的形状：

| 问 | 用户的选择 |
|---|---|
| 工作大纲用什么版式 | 思维导图形态，**选第 4 种**（自上而下的树、正交圆角连线） |
| 今日待办的来源 | **四个都要**：今天到期+逾期未完成 / 今天开始 / 今天动过 / 手动标记 |
| 手动标记怎么做 | 「只需要一个图标按钮，且鼠标悬浮提示添加今日待办」 |
| 当日工作时间怎么算 | 「类似打卡…从每天第一次打开软件开始计时，到最后一次关闭软件结束，HH:MM:SS，跟着时间跳动」 |
| 工作日志 | 「单独生成 word 文档，单独保存到电脑的文件中，设置里可以改保存地点，需要一定格式，不能直接列出当日所做的工作，名称以当日为名」 |

### 50.1 打卡：计时口径是"应用开着的时间"，所以只能由主进程做

会话表 `work_sessions`（迁移 `0008`）一行就是一段"开着的时间"。三条刻意的设计：

1. **心跳（`last_seen_at`）是为"没关干净"准备的**。断电、任务管理器强杀时 `ended_at` 永远是
   NULL。这时**不能**把这段算到"下次打开"为止（那会把关机的一整夜算成工时），
   启动时 `recoverStaleSessions` 把它收到**最后一次心跳**为止，并标记 `close_reason='recovered'`。
   宁可少算几十秒，不能凭空多算几小时。
2. **跨午夜的会话不拆行**，按天统计时算**交叠**（凌晨两点的会话对昨天与今天各贡献一段）。
   拆行会让"昨天开了几次"这种问题变得没法回答。
3. **不做去抖、不设最短会话**。开了 3 秒就是 3 秒 —— 把短会话藏起来会让界面上的数字
   和数据库里的记录对不上，而用户问"今天到底开了多久"时唯一诚实的答案就是记录本身。

为什么放在主进程（`main/index.ts`）：渲染层刷新、切页面、窗口隐藏到托盘，**都不代表应用关了**。
三个钩子分别是启动（`beginWorkSession`：先补收、再开新会话，顺序反了今天的工时永远是 0）、
30 秒心跳、退出时 `endWorkSessions('app_quit')`。退出那一步写在 `shutdown()` 的
**第一个 await 之前**——`will-quit` 里是 `void shutdown()`，晚一步就可能来不及写。

### 50.2 今日待办：分组是标签，不是分区

四个来源判定见 `services/today.ts`。两条必须写下来的口径：

- **一条任务可以同时属于几组**（昨天建的、今天到期、还被标了"今天做"）。所以
  `counts` 是各组的独立计数，四组相加**不等于**列表长度；界面上的「全部」用的是
  去重后的并集 `total`。第一版界面拿 `counts` 相加，会出现"写着 4 条、列表只有 2 行"。
- **已完成的不进列表**。这是"今天要做的事"，不是"今天做过的流水账" ——
  已完成属于工作日志。所以四组判定里，到期类理由对已完成任务直接不成立。

**手动标记存的是日期键**（`tasks.today_mark_date`，本地 `YYYY-MM-DD`）而不是布尔值：
明天打开时它自己就失效了，不需要任何定时清理。取消标记写回 NULL（让"没标记"只有一种表示）。

**「为什么在今天」的标签长在卡片自己身上**（用户 2026-09-30 看图后提的要求）。
第一版把这些标签做成了页面底部的一份"命中原因"清单，逐条列 `任务 → 命中了哪几组`；
问题是用户盯着某张卡片时的疑问就在那一行上，答案却在屏幕另一端，要来回对。
现在 `TaskCard` 多了个 `badges` 属性（`{label, tone, hint}` 数组，默认空 ——
其它页面不受影响），标签落在卡片已有的元信息行里（`属于「项目」`、`#标签` 旁边）：

| 分组 | 颜色 | 理由 |
|---|---|---|
| 今天到期 / 逾期（**已过期**） | 红 | 这是"欠着的"，最该先做 |
| 今天到期（今天） | 暖色 | 今天要做 |
| 我标了今天做 | 暖色 | 是我自己说的"今天做" |
| 今天动过 | 灰 | 只是说明"它今天被改过"，不该抢注意力 —— 每一格都醒目等于每一格都不醒目 |

筛选某一组时，卡片上只显示**那一枚**标签（否则"今天动过"会跟着出现在每个筛选结果里，
把用户正在看的那一组埋掉）。

**这一页只看当前项目**（用户 2026-09-30：「今日待办只展示当前项目的任务内容」）。
过滤做在**服务端**（`?projectId=`，SQL 里加 `t.project_id IN (…)`），不是"前端拿全量再筛"：
别的项目的任务不该被传到界面上再丢掉。响应里如实带回 `projectId`，副标题也写明是哪个项目的今天
（"只有 3 条"时用户得知道这是"当前项目的今天"，不是"全库的今天"）。
连带的两处：侧栏这一项改成 `needsProject: true`（没选项目时给的是"先选一个项目"，
而不是发一个不带 projectId 的请求、让页面短暂显示别的项目的任务）；
**工作日志仍是全天、全部项目**的总结 —— 与列表口径不同，所以预览条上写明了
「（全天 · 全部项目）」，免得用户拿两边数字对比后以为漏了东西。

#### 口径切换：今日待办 / 全部任务（用户 2026-10-02）

用户的反馈很具体：「这里我需要展示当前项目的所有任务」——他的项目有 11 个任务，
而这一页因为"今天没有待办"显示成空的。空态本身没错，但**没有出口**：想看项目全貌只能换页。

所以工具栏最左边加了一组切换（与筛选按钮同一套外观，用一条细分隔线分开，
因为它们是两个层级：左边决定"看哪一批"，右边决定"在这批里筛哪一组"）：

| 口径 | 数据来源 | 内容 |
|---|---|---|
| 今日待办（默认） | `/today?projectId=` | 四组判定：今天到期+逾期 / 今天开始 / 今天动过 / 手动标记 |
| 全部任务 | `/tasks?projectIds=[当前项目]` | **当前项目的全部任务，含已完成**（所以"所有任务"是真的所有） |

两条实现上的取舍：

- **不给 `/today` 加一个"全量模式"**：那个接口的语义是"今天该做什么"，
  让它按需变成"项目全量"会让它两边都不像；直接复用既有的跨项目任务查询（传一个 projectId）更清楚。
- 切到「全部任务」时**收起四个来源筛选**（四组判定在这一口径下没有意义），
  副标题改写为 `「项目」全部任务 · 共 N 条（含已完成 M 条）`。

e2e 的判据挑的是**两种口径真正互斥的那一点**：**已完成的任务只可能出现在「全部任务」里**
（今日待办明确排除已完成）。所以先完成一条，再断言它只在一侧出现 ——
这比"两边条数不同"硬得多（条数差异可能来自任何过滤条件的意外变化）。

### 50.3 工作日志：真 Word 文档，四段结构

用 `docx@9.8.1` 生成真 `.docx`（不是改后缀的 HTML/RTF），四段：
概要（表格 + 一句话概述）/ 工作时段（每段的起止与时长 + 该时段内动过的任务）/
分项目进展（已完成 / 推进中 / 本日新增）/ 说明（数字是怎么来的）。

`Packer.toBuffer()` 出来的字节流**验证过**：22 个 zip 条目、`word/document.xml` 能被
XML 解析器读通、文本顺序与代码里的顺序一致（第一版把标题和内容分两个数组攒、最后拼接，
结果四段标题全挤在开头 —— 所以排版代码里刻意用**一个有序数组**装所有块）。

文件名 `2026-09-30 工作日志.docx`（日期在前，按天排序天然可用）。
同名覆盖前先问一次"是否存在"，并把 `overwritten` 如实返回给界面 ——
用户可能在 Word 里改过那个文件，这件事必须说出来。

### 50.4 保存位置：设置项 + 三个 IPC

偏好新增 `workLogSaveDir`（`null` = 用默认的 `<文档>\项目管理系统\工作日志`）。
存 `null` 而不是把默认路径写进配置：用户的"文档"目录可能被改到别的盘。
放在**顶层**而不是嵌一层对象：偏好补丁是浅合并（`{...current, ...patch}`），
嵌套对象会被整块替换掉，将来加第二个日志设置项时会静默丢同层的值。

**踩到的真坑**：生成时我一开始读的是 `window.pmStudio.initialPreferences`，
那是 preload 在启动时同步抓的快照 —— 用户在设置里改完保存位置，它还是旧值，
表现是"改了设置但文档还是存到老地方"，而且没有任何报错。改成每次现读
`getPreferences()`，并把目录随请求发给服务端（服务端优先用请求里的值）。

### 50.5 工作大纲：CSS 伪元素画正交连线，不手算坐标

版式是用户选的自上而下树。连线全部由 `li::before / li::after` 画：
每个子节点自己画出"从横杆通到自己"的那一段（最后一个用 `border-right` + 圆角，
其余用 `border-left`），整条横杆由所有子节点拼成 —— 不需要知道兄弟的宽度。
手工算坐标的做法在标题长短不一时必然错位。

几个具体决定：

- **根节点是项目本身**（"整个项目的工作大纲"的字面含义），第二层才是没有父任务的任务。
- **折叠状态只在内存里**，不进数据库：它是"我现在怎么看"，不是任务数据。
  换成字段就要回答"换台电脑打开还是折叠的"这种问题，而它没有正确答案。
- **拖拽换层级/排序没做**，界面上如实写明，并用每个节点上的「＋」作为替代路径。
  这条缺口有一条**回归断言**（e2e 里断言界面上写着"尚未实现"），真做了拖拽之后它会失败，
  提醒去改文案与文档。
- 树从 `board.taskList` 现场构建（`parentId` 就是层级）。用的是"先按 parentId 分桶、
  再从根往下接"，**不递归查库**：父子关系万一成环（手工改过库、导入数据有问题），
  递归遍历会直接爆栈把页面搞白；分桶法遇到环只是那条链上的节点不出现，页面还能用。

**悬停控件绝不能占布局宽度**（用户 2026-09-30 连着报了两轮"名称被挤压 / 标题换行"，
两轮都附了截图）。最后查出来是**两个独立的原因**叠在一起，数字很直白：

| | 最初 | 第一轮修完 | 第二轮修完 |
|---|---|---|---|
| 卡片宽 | 168px（被压到 `min-width`） | 168px | 168 → 180px（跟着内容变宽） |
| **标题可用宽** | **25px** | **113px** | **126px** |
| 「确认接口清单与字段」 | 折两行、第二行只剩省略号 | 一行 | 一行 |
| 仍会换行的节点 | 大多数 | 「确认错误码与鉴权方式」等 | **0 个** |

**原因一：悬停操作按钮虽然看不见，却仍然占着 83px。**
「加子任务 / 重命名 / 删除 / 详情」原来放在标题那一行、靠 `opacity: 0` 隐藏。
修法是把它们**绝对定位**到卡片底部那一行的右端（`right: -3px; bottom: -3px`），
悬停时顶掉同一位置的"无子任务 / N 个子任务"那句文字（`opacity` 互换，
实测悬停前后卡片都是 168×57，不产生任何布局跳动）。
这与 `TaskCard` 里那个滑出的「详情」按钮是同一条经验：**悬停控件要脱离布局**。

**原因二：整行比视口宽时，flex 会把每个节点压到 min-content。**
第一轮修完只解决了"控件偷宽度"，节点多的一层仍然被压、标题仍然折行。
根因是 `.on-node` 是 flex 项、默认 `flex-shrink: 1`：一层十几个节点时整行超宽，
浏览器就把每个节点压到最小 —— 卡片贴着 `min-width`，标题只能折行。
修法：`.on-node { flex: none }`，**谁也别压谁**，超出的部分交给 `.tree-scroll`
横向滚动（那本来就是为宽树准备的）。顺带：

- 去掉标题前面那个**状态点**（用户要求「直接去掉前面的点」）：它占 13px，
  而状态在下面那行本来就有带底色的标签，属于重复表达；
- 卡片宽度改为**跟内容走**（`min-width: 168px; max-width: 260px`）：
  短标题不虚胖，长标题自己变宽到 260px 才折行（实测「补齐参数校验与错误处理」
  自动变成 180px、单行显示）。

**叶子节点前面不留空白**（用户连着两次要求，最后一句是「还是直接去掉这块空白吧，当没有子任务时」）。

那块空白是折叠箭头的**占位**，本意是让所有标题左缘对齐。它惹了两个麻烦：
先是复用了折叠箭头的类（`.on-caret.is-placeholder`），而那个类带 `:hover` 高亮 ——
于是"没有子任务"的节点前面会亮起一块点了没反应的灰块；改成不带交互样式的占位之后，
用户仍然不满意：为了对齐留 17px 空白，换来的是叶子标题被顶到右边、可用宽度还少一截。

最终**直接不渲染**：叶子节点的标题顶到卡片左内边距上。

| | 有子任务的节点 | 叶子节点 |
|---|---|---|
| 标题左边距 | 32px（折叠箭头之后） | **10px**（只有内边距） |
| 标题可用宽 | 126px | **148px** |

代价是两类节点的标题左缘不再对齐 —— 这是用户明确选的那一边（"宁可不对称，也不要那块空白"），
换来的是叶子标题宽 17% 的提升和更小的折行风险。
**「新增子任务」那一行的间距**（用户 2026-09-30 第三次提这件事：「这里再调整一下间距」）。

把截图放大三倍看，挤是**三处叠出来的**，单看每一处都不明显：

| | 改之前 | 改之后 |
|---|---|---|
| 输入框内边距 | `2px 5px`（文字贴着自己的边框，再叠上聚焦描边就很挤） | `3px 8px` |
| 与上一行（meta 行）的间距 | 5px（聚焦描边几乎贴到状态标签上） | 7px（卡片 5 + 行内 2） |
| 确认按钮 | 20×20，比输入框矮 2px、**没有垂直居中**（那个小对勾看着是偏上的） | 22×22，与输入框同一中线，带同色边框（读起来是"输入框的搭档"） |
| 输入框与按钮间距 | 4px | 8px |

e2e 守卫用的是几何而不是"看着还行"：按钮与输入框中线差 ≤ 1px、两者间距 ≥ 6px、
输入框内边距 ≥ 3px、按钮点击区 ≥ 20px。
（写这条断言时我自己先踩了一次：最初断言"两者等高"，而输入框外高含上下各 1px 边框、
天生比按钮高 2px —— 视觉上真正要对齐的是**中线**。）

e2e 里用几何钉住：叶子卡片里 `标题.left - 卡片.left ≤ 12px`、标题宽度 ≥ 130px，
并且断言页面上**不存在**任何 `.on-caret-space` 之类的占位元素。

### 50.6 删除：界面说的必须和服务端做的是同一件事

第一版我在确认框里写「删除后这些子任务会上提一级」。**这是错的** ——
服务端的非级联删除遇到子任务会直接返回 409（"还有 N 个子任务，无法删除"）。
是 e2e 拿真实请求打出来的 409 才发现的：界面上的谎话比报错难查得多。

现在与 `TaskDrawer` 的既有规则一致：有子任务 → 只给一个「知道了」的警告框
（**不摆"取消"按钮**，否则会让人以为"再点一次就能删"）；没有子任务 → 确认框，
文案写明"可在回收站还原"。删除后查的是**回收站接口**（`GET /tasks/:id` 对已删除任务
返回 404，拿它当判据会得到"删除功能坏了"的错觉）。

### 50.7 这一轮踩的坑（含一次我自己造成的事故）

**事故：我用 PowerShell 的 `Get-Content`/`Set-Content` 改 `main/index.ts`，把文件编码写坏了。**
这台机器上跑的是 Windows PowerShell 5.1，`Set-Content` 默认按 ANSI(GBK) 写盘，
一个 UTF-8 文件被读坏又写坏：**339 个中文字符丢失、8 处换行被吞**，`read` 工具直接报
"invalid UTF-8"。仓库没有 git，磁盘上也没有第二份副本。修复过程：

1. 先把残缺内容按 UTF-8 规范写回，损坏点用 `U+FFFD` 标出，导出逐行损坏清单；
2. 编译产物 `out/main/index.js` 保留了**所有字符串字面量**（注释被剥离），用它核对了
   35 条中文字符串，全部一致；
3. 逐处人工补回丢失的字符（多为句号、逗号、破折号、引号，以及"区/录/个"这类字），
   修 152 行后行数 898 → 1020；
4. `tsc`（根 + desktop）0 错误、`eslint` 干净、694 个单测全绿。

**结论（写给以后的自己）**：这台机器上**不要用 PowerShell 读写源码文件**，
`.NET` 的静态调用还要用绝对路径（相对路径解析到的是 shell 的启动目录，不是 `cd` 之后的位置 ——
这个坑这轮同样踩到过，表现为 `.Replace()` 静默什么都没改）。

**坑二：`.n-dialog` 的按钮要点真实鼠标，并且点之前要等动画落定。**
对话框是放大淡入的，过渡期间算出来的中心点落在最终位置之外 —— 那一下就点到遮罩上，
而遮罩的默认行为是"取消"，表现是"对话框关了、什么都没发生"。用合成 `el.click()`
同样会绕开命中测试。两个都不行，必须：等 `animationsSettled()` → 真实鼠标点按钮。

**坑三：`NSelect` 与 `NDropdown` 的选项类名不同。**
前者 `.n-base-select-option`，后者 `.n-dropdown-option`。拿错选择器的报错是
"选项里没有第 N 个"，看着像菜单没打开，实际是找错了元素。harness 里现在有了
`page.pickMenuOption(index)`。

**坑四：`assert.equal` 比的是引用。**
`assert.equal(depths, [1,2,3])` 会失败，而消息里两边打印出来一模一样。数组断言要用
`assert.check(JSON.stringify(a) === JSON.stringify(b), …)`。

**坑五：重命名这种"框里已经有内容"的输入不能用 `page.type`。**
`Input.insertText` 是"在光标处插入"，会变成追加（之前端口号上就出过 `80008123`）。
harness 补了 `page.fill()`：走原生 setter + 派发 `input` 事件（直接赋 `el.value`
Vue 的 `v-model` 收不到）。

**坑六：测试自己选错了对象，看起来却像功能坏了。**
删除那一段我拿"刚才被加过子任务的叶子"去测删除，于是它当然进了"无法删除"分支 ——
断言一直在测另一条路径。失败信息说的是"节点没有消失"，方向完全指错。

### 50.8 测试与验证

| 测试 | 覆盖 |
|---|---|
| `work-time.test.ts`（14 条，新） | 日期键与区间边界（零点归属）、心跳、幂等开/关、跨午夜按天交叠、**强杀后按最后一次心跳补收**、补收后能正常开新会话 |
| `today.test.ts`（12 条，新） | 分类纯函数的边界（逾期/今天零点/已完成不再逾期）、四组聚合、**计数不受筛选影响**、`total` 是去重并集、日期键自然过期、标记不存在/已删除任务时报错 |
| `work-log.test.ts`（13 条，新） | 三类取数（完成/推进/新建）与"昨天动过的不出现"、工时按天、时段归属、**产出真的是 zip 容器且含 `word/document.xml`**、文件名非法字符清理、同名覆盖如实报告、没有目录时明确报错 |
| `date-buckets.test.ts`（+4 条） | `formatHms`（不取模 24）、`formatDateKey`、`formatFullDate`、`formatClock` —— 与服务端口径逐条对齐 |
| `outline`（e2e，26 条，新） | 根节点是项目、**用几何验证层级**（子节点在父节点下方、深度是 1→2→3）、**标题行数必须全是 1**（换行就说明又被谁挤了）、叶子前面的占位是 `span` + 普通光标 + 透明底色、折叠真的摘掉子树、就地新增/改名/换状态都落库、**带子任务时明确"无法删除"且服务端不会收到注定失败的请求**、叶子可删且进回收站、界面上如实标注拖拽未实现 |
| `today`（e2e，38 条，新） | 打卡格式 + **隔 2.6 秒再读一次确认数字在涨**、**只看当前项目**（造一个别的项目、里面一条今天到期的任务，断言它不出现）、四个筛选按钮各自计数与筛选、"添加今日待办"的悬浮提示、标记落库为日期键、**生成工作日志并在文件系统里核对**（存在、>5KB、zip 签名、文件名含当日日期、没写到用户"文档"里） |
| `settings`（e2e，+6 条） | 工作日志分区：显示当前生效位置、默认位置、改完立刻生效、「恢复默认」只在指定过目录时出现 |

一次全量：**15 个场景 382 项断言全通过**（`node scripts/e2e/run.cjs`），
单测 **694 条 / 45 个文件全通过**，`tsc` 与 `eslint` 干净。

### 50.10 运行面板调窄：一条"永远不会命中"的 CSS 规则（2026-10-01）

用户反馈「这里太宽了，调窄一点」（运行状态面板）。表面上只是改个数字，实际挖出一个陷阱：

原来那条规则是写在 `ProjectsView.vue` 的 `<style scoped>` 里的：

```css
.run-panel { width: min(760px, calc(100vw - 60px)); }
```

编译产物里**能看到**这条规则（`.run-panel[data-v-7ed4e365] { … }`），但实测面板根本不受它影响。
原因：`preset="card"` 的 `NModal` 自己生成 `.n-card` 节点，`class="run-panel"` 是**属性透传**贴上去的，
而这个节点**没有 `data-v-*` 属性**（实测 `hasAttribute('data-v-…') === false`）——
于是选择器永远不匹配。面板宽度一直由 Naive 的默认样式决定（实测约 700px，窗口越大越显宽）。

**结论**：给 `NModal`（以及任何把内容 teleport 到 body 的浮层组件）设尺寸，
要么用 `:style`（内联优先级最高、一定生效），要么把卡片换成我们自己模板里的 `<NCard>`
（项目里另外两个弹窗就是这么写的：`<NModal><NCard class="wizard">` —— 它们的 scoped 规则是有效的）。

现在宽度是 `<NModal :style="{ width: 'min(600px, calc(100vw - 60px))' }">`，并把原因写在常量旁边，
免得下一个人又去改那条"看起来没生效"的 CSS。600px 的依据：面板里唯一想要宽度的是启动输出，
而它是 `pre-wrap + break-all`（长路径会折行，有 e2e 断言盯着不横向溢出），不需要靠宽度容纳。

**顺带记一条量测教训**：加了宽度断言之后第一次跑仍然是红的 —— 量到了 332px。
不是规则没生效（`getComputedStyle().width` 明明是 `600px`），而是**量在了弹窗"放大 + 淡入"的过渡中间**，
`getBoundingClientRect()` 拿到的是被 `scale()` 缩过的盒子。量之前先 `animationsSettled()`。
这个坑在 harness 里已经写过一次（悬停控件的滑入动画），这次是在**弹窗**上又踩了一遍。

### 50.11 回收站与「运行中不许删」（2026-10-01）

用户的两条要求：
「在项目运行时执行删除操作时弹出提示，项目正在运行，请停止后再删除」
「新增回收站，且回收站中删除则完全删除项目」。

#### 运行中不许删：两处各挡一次

- **界面**：点删除时先**现拉一次运行状态**再判断（不是用界面上那份轮询来的集合 ——
  用户刚点过"启动"就立刻来删，界面上的集合还是旧的，提示就漏了），
  命中就弹一个**只有一个按钮**的提示框（摆"取消"按钮会让人以为"再点一次就能删"）。
- **服务端**：`routes/projects.ts` 里的 `assertProjectNotRunning` 是**权威判断**，
  绕过界面直接调接口同样 409。`starting` 也算在跑（已经 spawn 出进程了，这时候删会留下
  没人管的端口占用）。
  这条判断放在**路由层**而不是 `projects` 服务里：服务层不该知道"开发服务器"
  （它在内存里、由进程句柄组成，跟数据库无关）。为此 `createDevServers` 的创建被提到
  项目路由注册**之前** —— 放在后面的话那个检查只能靠一个"稍后才赋值"的变量，
  那是一个请求先到就炸的坑。

#### 回收站

界面：项目页工具栏一个「回收站」入口 → 面板里列出已软删除的项目（名字、移入时间、
文件夹名 + "保留"字样），每项两个动作：**还原** / **彻底删除**。

两条口径必须写下来：

1. **"彻底删除"只清应用里的数据**（项目、任务、工作流、标签、里程碑、关系，走外键级联），
   **磁盘上的项目文件夹保留**。理由与服务层既有约定一致：里面是用户自己写的代码与附件，
   递归删目录不可逆。所以确认框里把"文件夹会保留"这句话和路径一起显示出来 ——
   用户知道去哪儿自己清理。e2e 有一条断言专门盯着这条边界（删完之后文件夹仍在）。
2. **e2e 的判据按项目 id，不按"回收站里有几项"**：沙箱是所有场景共用的，
   前面场景收尾时删掉的项目就躺在回收站里。第一版写成"恰好 1 项"，
   单独跑能过、全量跑必挂 —— 那种断言比没有断言更浪费时间。

#### 这一轮又抓到一个真 bug：回收站里"彻底删除"永远是 404

`hardDeleteProject` 原来第一行是 `getProjectOrThrow(ctx, id)`，而那条守卫把
**已软删除**的项目当成不存在（`deletedAt !== null` → 抛 404「项目不存在」）——
于是"从回收站里彻底删除"要删的正是那个已被软删除的项目，点下去永远是 404，
功能根本走不通。是 e2e 拿真实请求打出来的：`DELETE /projects/<id>?hard=true 404`。

修法：`hardDeleteProject` 只要求"记录存在"，改用 `findProject` 自己判空。
补了两条单测钉住：**先进回收站、再彻底删除**必须成功；而彻底删除一个**不存在**的项目
仍然是 404（放宽守卫不等于静默成功）。

#### 一键清空（用户 2026-10-01：「回收站新增一键删除」）

面板页脚一个「清空回收站」（危险色、空的时候禁用），点一次把里面所有项目彻底删掉。

- **做成服务端一个接口**（`POST /projects/trash/purge`）而不是前端循环调 `remove(id, true)`：
  前端循环在半途失败会留下"删了一半"的中间状态，而"清空"用户期待的是要么都清、要么都不清；
  服务端一个事务能保证这一点，顺带只发一个请求。
- **只动 `deletedAt` 不为空的行** —— 判据写在 SQL 的 `where` 里，不是"前端传哪些 id"。
  一个叫"清空回收站"的按钮碰到还活着的项目就是事故，所以单测与 e2e 的**重点都不是
  "能删掉"，而是"不能多删"**：造一个活着的项目 + 两个已删的，清空之后断言
  "那两条真没了、活着的那条一根汗毛没少"。
- 确认框把三件事说全：**有哪几个项目**（名字列出来）、**不能撤销**、**磁盘上的文件夹都会保留**。
- 路径 `/projects/trash/purge` 里的 `trash` 是静态段，Fastify 的路由器静态段优先于 `:id`，
  所以不会跟 `/projects/:id/...` 撞上。

### 50.12 界面上的变化（原来的东西去哪了）

| 原来 | 现在 |
|---|---|
| 工作台（分层卡片空间：进层/退层、面包屑、搜索） | **工作大纲**（一棵树；搜索仍在，进层/退层的交互被树本身取代） |
| 我的待办（逾期/今天/本周/以后/没有截止日 五组横向列） | **今日待办**（只显示今天，四个来源做筛选） |
| — | 今日待办顶部：**当日工作时间**计时器；底部区块：**生成工作日志** |
| 向导完成按钮「进入工作台」 | 「进入工作大纲」 |
| — | 设置页新增「工作日志」分区（保存位置） |

`WorkbenchView.vue` 与 `MyTasksView.vue` 已删除（路由 `/workbench`、`/my-tasks` 保留，
后者加了别名 `/today`，老书签与深链不会断）。**拖拽调整大纲层级与顺序尚未实现。**

## 51. 0.2.2：六态状态流、取消进度条、总览改今日工作内容（2026-10-02）

用户的原话（一次给完的一串要求）：

> 「我需要修改一些需求，所有任务的进度条都取消，改成状态待完成，正在修改，待审查，审查中，
> 回退修改，已完成，不再需要进度条，以此逻辑修改任务的完成状态显示，在总览中关系数据图改为
> 今日工作内容，显示列表哪些内容今天有改动，在工作大纲中，修改一个逻辑问题，点击整个标签就
> 弹出任务详情，任务详情的按钮可以去掉，注意折叠子任务的按钮冒泡，在任务详情中去掉删除任务的
> 按钮，将重新加载按钮移动到原先删除任务按钮的位置，再在右侧新加一个提交审核的按钮」

同一轮还有三条文案层面的要求：提示语改成书面语（「过于白话」）、正式环境不显示「正式环境」徽标、
设置里删掉「默认位置」那一行。下面按"为什么这么做"记，不逐行念代码。

### 51.1 六态为什么仍然只有三个分类

状态变成六个（待完成 / 正在修改 / 待审查 / 审查中 / 回退修改 / 已完成），但
`workflow_statuses.category` **仍然只有 `todo` / `doing` / `done`**，并且**只有「已完成」是 `done`**。
这一条是整个改动能低成本落地的关键：全项目所有"算不算做完"的判断看的都是分类，不是状态名 ——
今日待办的"已完成不进列表"、工作日志的"今天完成了 N 项"、父任务的 `doneChildCount`、
自动完成的级联，全部不需要改一行。如果给六个状态各配一个分类（比如「待审查」也算 `done`），
那些地方会一起松动，而且"提交审核"会顺带把任务标成完成 —— 那正是用户不想要的。

**分类缺失时的兜底**仍是 `completedAt !== null`（老数据/脏数据不会变成"永远做不完"）。

### 51.2 老项目怎么升级：0009 与 0010 两条迁移

新建项目走的是 `DEFAULT_WORKFLOW_TEMPLATE`（shared 常量），但**已经建好的项目**还停在旧状态上。
迁移 `0009_six_state_statuses` 干三件事：

1. 给每个项目**补齐**六态（`INSERT … WHERE NOT EXISTS`，按名字判重）；
2. 旧状态上的任务**按分类**收敛：`done → 已完成`、`doing → 正在修改`、其余 `→ 待完成`；
3. 删掉不在六态里的旧状态，并保证每个项目仍有**一个默认状态**（落在「待完成」，新建任务要有落点）。

**为什么按分类而不是按名字猜**：「测试中」该归"审查中"还是"正在修改"只有用户自己知道，
硬猜等于替用户编造工作流。按分类收敛的是"语义上确定成立"的那一部分，剩下的细分让用户自己调。
旧的 `tasks.progress` 列**保留但不读不写**：SQLite 删列要重建表，为一个已经没人读的 INTEGER
去动表结构不划算（真要腾空间时再单独做一条迁移）。

`0010_six_state_order` 是它的小尾巴，值得单独记一笔：0009 是"缺什么补什么"，所以老项目里
**已经有的**「已完成」保留它原来的 `sort_order`（比如 4000），而新补进来的「待审查 / 审查中 /
回退修改」拿的是 3000/4000/5000 —— **序号会撞**，看板列序变成"按插入顺序随机"。
修法是把六态序号按规范顺序重写一遍。为什么不直接改 0009：**迁移执行器会校验校验和**，
用户机器上 0009 可能已经跑过了，改内容会让应用直接起不来 —— 已应用的迁移只能新增、不能改写，
这正是那条校验存在的意义。

### 51.3 管理侧模板不再自带一套工作流

这一轮之前，"六态"这套定义在**五个地方**各写了一份：shared 常量、0009 的 SQL、四套管理侧模板。
改一处漏三处只是时间问题。所以模板侧的 `statuses` 整体删掉，连带删掉：

- `applyManagementTemplate` 里的「先换工作流」那一步（以及 `workflow` 开关、
  `ApplyTemplateResult.created/skipped.statuses`、`applyProjectTemplateInputSchema.workflow`、
  向导里那句"工作流与任务清单已铺好"）；
- `TaskTemplateItem.status`（模板任务不再指定状态，一律落到项目默认状态）。

行为上的变化要如实承认：**铺模板不会再改动用户已经调过的工作流**。原先"一个状态都不在时整套换上"
的路径也一并去掉了 —— 那个"补缺"听起来贴心，实际是"我刚删掉/改名的状态又冒出来了"。
单测跟着改成"铺两次、状态数一模一样"。

### 51.4 总览：六边形关系数据图下线，主体换成「今日工作内容」

用户要的是「显示列表哪些内容今天有改动」。所以这一块**直接复用工作日志的取数**
（服务端 `collectWorkLogData`，接口 `GET /work-log/preview`），而不是另写一套"今天动过什么"的查询：

- 两边口径**天生一致** —— 总览上看到的，就是当天导出的 Word 日志里会写进去的；
- 三组（**已完成 / 推进中 / 今日新建**）与日志文档的分节完全对应，不需要在两处各自维护排序与判定；
- 副标题写成「日期 · 各组条数」，只列有内容的组（"推进中 0"这种零值是噪音）。

六边形那张图连同它的几何代码、CSS、悬停浮卡、拖拽旋转、下钻一并**删除**（`OverviewView.vue`
少了 ~750 行脚本 + ~300 行样式）。右侧的小面板（状态分布 / 完成度 / 里程碑 / 被前置卡住 /
关系链）原样保留 —— 这一版只换了主体。

顺手清掉的死代码：`colorOf` / `labelOf` / `tagNameById` / `successorIdsOf` / 子树规模
（`size` / `doneSize` / `roots`）与文件头那段"为什么是六边形"的说明。
留着它们会让下一个人以为图还在。

### 51.5 工作大纲：点整张卡片开详情

「点击整个标签就弹出任务详情，任务详情的按钮可以去掉」——所以卡片上的「详情」图标按钮删了，
卡片本体变成 `role="button"` + `tabindex="0"` + `@click`。

两个细节是**实跑才发现的**，记在这里：

1. **点卡片里面的按钮不能顺带开详情**。折叠箭头、状态标签、三个悬停操作按钮、新增与改名的
   输入框都显式 `.stop`。少一个就会出现"点一下折叠、抽屉也弹出来"。
2. **键盘那条必须用 `.self` 而不是 `.stop`**。卡片的 `@keydown.enter` 一开始写成
   `@keydown.enter.prevent`：`.prevent` 只挡默认行为、**不挡冒泡**，于是在"就地输入的子任务标题"
   里敲回车会连卡片一起响应 —— 新建完子任务，详情抽屉已经在背后开着了。
   表现是"下一步点重命名没反应"（点击落在抽屉上），离真正的原因隔了三步。
   `.self` 要求事件目标就是卡片本身，输入框里的回车就不会误触发。

### 51.6 任务详情底部：删除下线、重新加载左移、新增提交审核

| 原来 | 现在 |
|---|---|
| 底部居中一个「删除任务」 | 左「重新加载」（原删除按钮的位置）· 右「提交审核」 |
| 删除入口 | 只留在大纲节点悬停出来的垃圾桶上（详情页不再重复提供） |

「提交审核」不是界面自己找状态再 patch，而是服务端一个语义接口 `POST /tasks/:id/submit-review`
（`tasks.submitForReview`）：

- **落到哪个状态由服务端按名字找**（`REVIEW_STATUS_NAME`，shared 常量）。界面不知道审核状态叫什么，
  项目把「待审查」改名之后按钮也不会悄悄失效 —— 只是服务端找不到时会给出**可操作**的报错
  （"这个项目的工作流里没有「待审查」状态，请先补上"）；
- **幂等**：已经在该状态时直接返回详情，不重复写库、不刷新 `updatedAt`；
- 带子任务的任务上按钮**禁用**（`childCount > 0 && statusCategory !== 'done'`）：
  子任务还没做完就替父任务提交审核，那是假的状态推进。

### 51.7 这一轮 e2e 抓到的三个真问题

改界面顺手改测试，测试又把三件事顶了出来 —— 都不是"测试写错了"，而是产品/测试各有真问题：

1. **焦点断言曾经是"假通过"**。旧脚本用同一个临时标记 `data-e2e-pick="1"` 去点两样东西
   （大纲卡片、下拉选项），`querySelector` 按文档序先命中还留在 DOM 里的大纲卡片 ——
   于是"选了状态"其实点在抽屉背后，状态没变、焦点恰好还在抽屉里，断言就绿了。
   标记去重之后露出真相：Naive 的 `NSelect` 选项 teleport 在 body 上，鼠标选完焦点落在 `BODY`。
   现在的断言是"焦点**没有跑到页面上某个具体控件**"（在抽屉里或在 BODY 上都算正常），
   这才是这条断言真正要守的不变量。
2. **`.n-drawer` 出现不等于内部渲染完**。抽屉有进场动画，进去就量底部按钮会拿到 null，
   报出来是"按钮不存在"，方向完全错。改成先等 `[data-field="drawer-reload"]` 就位再量。
3. **总览面板一开始是空的**：模板换好了、数据接口也 200，但 `onMounted` 里只调了
   `loadMeta` / `loadBoard`，忘了调新加的 `loadTodayWork`。e2e 的"副标题不为空"这条当场抓住。

另外全量跑时出现过 `today` / `wizard-layout` 两条**互相牵连的**超时（单独跑都通过）：
所有场景跑在**同一个应用实例**里，前一个场景（`settings`）把工作区搬到了别处、后一个场景的
路由切换就会莫名卡住。这属于测试编排的已知脆弱点，不是这一版引入的，重跑即恢复；
真正要解决得让场景各自起应用，代价是整轮时间翻倍，先记在这里。
