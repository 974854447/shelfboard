# pm-studio 数据模型与 API 清单 v1.1

> 配套文档：[`technical-design.md`](./technical-design.md)
> v1.1 新增：`app_logs` 表与 `/logs` 系列接口（日志与诊断）

---

## 1. 通用约定

| 项 | 约定 |
|---|---|
| 主键 | `TEXT`，ULID（时间有序，利于分页与索引） |
| 时间 | `INTEGER`（Unix 毫秒）；对外 API 用 ISO 8601 字符串 |
| 软删除 | `deleted_at INTEGER NULL`；默认查询过滤 `deleted_at IS NULL` |
| 多用户预留 | 所有业务表带 `owner_id TEXT`，本地固定 `'local-user'` |
| 审计 | `created_at` / `updated_at` 由服务层统一维护 |
| 外键 | 全部显式声明，连接开启 `PRAGMA foreign_keys = ON` |
| 命名 | 表名与列名用 `snake_case`；TS 侧由 Drizzle 映射为 camelCase |
| 排序 | `sort_order INTEGER`，新增时取 `MAX+1000`，便于中间插入 |

---

## 2. 工作区数据库表结构

### 2.1 项目与配置

```sql
CREATE TABLE projects (
  id            TEXT PRIMARY KEY,
  owner_id      TEXT NOT NULL DEFAULT 'local-user',
  name          TEXT NOT NULL,
  description   TEXT,
  color         TEXT NOT NULL DEFAULT '#2080f0',
  icon          TEXT,
  code_path     TEXT,                      -- 绑定的本地代码目录（绝对路径，可为空）
  code_kind     TEXT,                      -- 'frontend' | 'backend' | 'fullstack' | NULL
  stack_json    TEXT,                      -- 生成时使用的技术栈与参数快照
  status        TEXT NOT NULL DEFAULT 'active',  -- active | archived
  sort_order    INTEGER NOT NULL DEFAULT 0,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL,
  deleted_at    INTEGER
);
CREATE INDEX idx_projects_status ON projects(status, deleted_at);

CREATE TABLE workflow_statuses (
  id            TEXT PRIMARY KEY,
  project_id    TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name          TEXT NOT NULL,
  color         TEXT NOT NULL DEFAULT '#8a8a8a',
  category      TEXT NOT NULL DEFAULT 'doing',  -- todo | doing | done（用于进度统计）
  sort_order    INTEGER NOT NULL DEFAULT 0,
  is_default    INTEGER NOT NULL DEFAULT 0,     -- 新建任务的默认状态
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);
CREATE INDEX idx_wf_status_project ON workflow_statuses(project_id, sort_order);

CREATE TABLE tags (
  id            TEXT PRIMARY KEY,
  project_id    TEXT REFERENCES projects(id) ON DELETE CASCADE,  -- NULL = 全局标签
  name          TEXT NOT NULL,
  color         TEXT NOT NULL DEFAULT '#8a8a8a',
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);
CREATE UNIQUE INDEX uq_tags_scope_name ON tags(IFNULL(project_id,''), name);
```

### 2.2 任务

```sql
CREATE TABLE tasks (
  id            TEXT PRIMARY KEY,
  owner_id      TEXT NOT NULL DEFAULT 'local-user',
  project_id    TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  parent_id     TEXT REFERENCES tasks(id) ON DELETE CASCADE,   -- 多层子任务
  ticket_id     TEXT REFERENCES tickets(id) ON DELETE SET NULL,
  title         TEXT NOT NULL,
  description   TEXT,                                          -- Markdown
  status_id     TEXT REFERENCES workflow_statuses(id) ON DELETE SET NULL,
  priority      TEXT NOT NULL DEFAULT 'medium',                -- low | medium | high | urgent
  assignee_id   TEXT,                                          -- 预留
  start_date    INTEGER,
  due_date      INTEGER,
  completed_at  INTEGER,
  progress      INTEGER NOT NULL DEFAULT 0,                    -- 0-100
  sort_order    INTEGER NOT NULL DEFAULT 0,                    -- 同一状态列内排序
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL,
  deleted_at    INTEGER
);
CREATE INDEX idx_tasks_project_status ON tasks(project_id, status_id, sort_order);
CREATE INDEX idx_tasks_parent ON tasks(parent_id);
CREATE INDEX idx_tasks_due ON tasks(due_date) WHERE deleted_at IS NULL;
CREATE INDEX idx_tasks_ticket ON tasks(ticket_id);

CREATE TABLE task_dependencies (
  id             TEXT PRIMARY KEY,
  predecessor_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  successor_id   TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  type           TEXT NOT NULL DEFAULT 'FS',  -- FS | SS | FF | SF
  lag_days       INTEGER NOT NULL DEFAULT 0,
  created_at     INTEGER NOT NULL
);
CREATE UNIQUE INDEX uq_dep ON task_dependencies(predecessor_id, successor_id);
-- 服务层校验：禁止自环与成环（DFS 检测）

CREATE TABLE task_tags (
  task_id  TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  tag_id   TEXT NOT NULL REFERENCES tags(id)   ON DELETE CASCADE,
  PRIMARY KEY (task_id, tag_id)
);

CREATE TABLE milestones (
  id          TEXT PRIMARY KEY,
  project_id  TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  description TEXT,
  due_date    INTEGER,
  reached_at  INTEGER,
  sort_order  INTEGER NOT NULL DEFAULT 0,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);
```

### 2.3 工单

```sql
CREATE TABLE ticket_types (
  id          TEXT PRIMARY KEY,
  project_id  TEXT REFERENCES projects(id) ON DELETE CASCADE,  -- NULL = 全局
  name        TEXT NOT NULL,          -- 需求 / 缺陷
  prefix      TEXT NOT NULL,          -- REQ / BUG
  icon        TEXT,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);

CREATE TABLE tickets (
  id            TEXT PRIMARY KEY,
  owner_id      TEXT NOT NULL DEFAULT 'local-user',
  project_id    TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  type_id       TEXT REFERENCES ticket_types(id) ON DELETE SET NULL,
  seq           INTEGER NOT NULL,                 -- 项目内自增序号
  code          TEXT NOT NULL,                    -- 展示编号：REQ-12
  title         TEXT NOT NULL,
  description   TEXT,                             -- Markdown
  status_id     TEXT REFERENCES workflow_statuses(id) ON DELETE SET NULL,
  priority      TEXT NOT NULL DEFAULT 'medium',
  assignee_id   TEXT,
  reporter_id   TEXT,
  due_date      INTEGER,
  resolved_at   INTEGER,
  sort_order    INTEGER NOT NULL DEFAULT 0,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL,
  deleted_at    INTEGER
);
CREATE UNIQUE INDEX uq_ticket_code ON tickets(project_id, code);
CREATE INDEX idx_tickets_status ON tickets(project_id, status_id, sort_order);
```

### 2.4 文档与附件

```sql
CREATE TABLE doc_folders (
  id          TEXT PRIMARY KEY,
  project_id  TEXT REFERENCES projects(id) ON DELETE CASCADE,  -- NULL = 独立知识库
  parent_id   TEXT REFERENCES doc_folders(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  sort_order  INTEGER NOT NULL DEFAULT 0,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);

CREATE TABLE documents (
  id          TEXT PRIMARY KEY,
  owner_id    TEXT NOT NULL DEFAULT 'local-user',
  project_id  TEXT REFERENCES projects(id) ON DELETE CASCADE,  -- NULL = 独立知识库
  folder_id   TEXT REFERENCES doc_folders(id) ON DELETE SET NULL,
  title       TEXT NOT NULL,
  content_md  TEXT NOT NULL DEFAULT '',
  is_template INTEGER NOT NULL DEFAULT 0,
  sort_order  INTEGER NOT NULL DEFAULT 0,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL,
  deleted_at  INTEGER
);
CREATE INDEX idx_docs_folder ON documents(folder_id, sort_order);

CREATE TABLE document_versions (
  id          TEXT PRIMARY KEY,
  document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  content_md  TEXT NOT NULL,
  title       TEXT NOT NULL,
  note        TEXT,
  created_at  INTEGER NOT NULL
);
CREATE INDEX idx_doc_versions ON document_versions(document_id, created_at DESC);

CREATE TABLE attachments (
  id          TEXT PRIMARY KEY,
  owner_type  TEXT NOT NULL,     -- document | task | ticket | project
  owner_id    TEXT NOT NULL,
  file_name   TEXT NOT NULL,     -- 原始文件名
  rel_path    TEXT NOT NULL,     -- 相对工作区根的路径（迁移时无需改写）
  mime        TEXT,
  size        INTEGER NOT NULL,
  sha256      TEXT,
  created_at  INTEGER NOT NULL
);
CREATE INDEX idx_attachments_owner ON attachments(owner_type, owner_id);
```

### 2.5 模板

```sql
CREATE TABLE templates (
  id            TEXT PRIMARY KEY,
  kind          TEXT NOT NULL,     -- workflow | tasklist | docs | code
  name          TEXT NOT NULL,
  description   TEXT,
  stack         TEXT,              -- code 模板：vue3-ts / nestjs / fastapi / django
  payload_json  TEXT NOT NULL,     -- 结构随 kind 不同
  is_builtin    INTEGER NOT NULL DEFAULT 0,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);
```

- `workflow` payload：`[{ name, color, category, sortOrder }]`
- `tasklist` payload：`[{ title, priority, children: [...], milestoneRef? }]`（支持多层，支持相对天数 `dueOffsetDays`）
- `docs` payload：`[{ folder, title, contentTemplate }]`

### 2.6 作业与审计

```sql
CREATE TABLE jobs (
  id            TEXT PRIMARY KEY,
  type          TEXT NOT NULL,     -- scaffold | install | workspace-migrate | export | export-diagnostics | backup
  title         TEXT NOT NULL,
  status        TEXT NOT NULL,     -- queued | running | succeeded | failed | canceled | interrupted
  phase         TEXT,
  percent       INTEGER NOT NULL DEFAULT 0,
  payload_json  TEXT,
  result_json   TEXT,
  error_code    TEXT,
  error_message TEXT,
  log_file      TEXT,
  created_at    INTEGER NOT NULL,
  started_at    INTEGER,
  finished_at   INTEGER
);
CREATE INDEX idx_jobs_status ON jobs(status, created_at DESC);

CREATE TABLE job_logs (
  id        TEXT PRIMARY KEY,
  job_id    TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  ts        INTEGER NOT NULL,
  level     TEXT NOT NULL DEFAULT 'info',   -- info | warn | error
  message   TEXT NOT NULL
);
CREATE INDEX idx_job_logs ON job_logs(job_id, ts);

-- v1.1 新增：应用级日志（日志与诊断模块），与 job_logs 分开：
-- job_logs 是「某个作业的输出流」，app_logs 是「整个应用的错误与事件」，
-- 通过 trace_id / job_id 互相跳转。
CREATE TABLE app_logs (
  id          TEXT PRIMARY KEY,
  ts          INTEGER NOT NULL,
  level       TEXT NOT NULL,        -- error | warn | info | debug
  source      TEXT NOT NULL,        -- main | api | job | renderer
  scope       TEXT,                 -- 模块名：scaffold / workspace.migrate / http ...
  message     TEXT NOT NULL,
  detail      TEXT,                 -- 堆栈或上下文 JSON（写入前已过脱敏管道）
  trace_id    TEXT,                 -- 关联一次 API 请求或一个作业
  job_id      TEXT REFERENCES jobs(id) ON DELETE SET NULL,
  request_id  TEXT,
  redacted    INTEGER NOT NULL DEFAULT 1,   -- 是否已脱敏
  created_at  INTEGER NOT NULL
);
CREATE INDEX idx_app_logs_ts    ON app_logs(ts DESC);
CREATE INDEX idx_app_logs_level ON app_logs(level, ts DESC);
CREATE INDEX idx_app_logs_src   ON app_logs(source, ts DESC);
CREATE INDEX idx_app_logs_trace ON app_logs(trace_id);
CREATE INDEX idx_app_logs_job   ON app_logs(job_id, ts);

CREATE TABLE activity_logs (
  id           TEXT PRIMARY KEY,
  entity_type  TEXT NOT NULL,     -- task | ticket | document | project | ...
  entity_id    TEXT NOT NULL,
  project_id   TEXT,
  action       TEXT NOT NULL,     -- create | update | delete | restore | move
  changes_json TEXT,              -- { field: [old, new] }
  actor_id     TEXT NOT NULL DEFAULT 'local-user',
  created_at   INTEGER NOT NULL
);
CREATE INDEX idx_activity_entity ON activity_logs(entity_type, entity_id, created_at DESC);

CREATE TABLE env_snapshots (
  id          TEXT PRIMARY KEY,
  created_at  INTEGER NOT NULL,
  tool        TEXT NOT NULL,      -- node | npm | pnpm | yarn | python | pip | git
  found       INTEGER NOT NULL,
  version     TEXT,
  exec_path   TEXT,
  in_path     INTEGER NOT NULL DEFAULT 0,
  raw_output  TEXT
);
CREATE INDEX idx_env_snapshots ON env_snapshots(tool, created_at DESC);

CREATE TABLE env_var_backups (
  id             TEXT PRIMARY KEY,
  kind           TEXT NOT NULL,   -- user_path | npmrc | pipini
  target         TEXT NOT NULL,   -- 注册表项名或文件绝对路径
  existed        INTEGER NOT NULL,-- 修改前是否存在
  old_value      TEXT,            -- 修改前完整内容/原值（NULL 表示原本不存在）
  new_value      TEXT NOT NULL,
  applied_at     INTEGER NOT NULL,
  rolled_back_at INTEGER
);

CREATE TABLE workspace_meta (
  key   TEXT PRIMARY KEY,         -- schema_version, created_at, last_migrated_from ...
  value TEXT NOT NULL
);
```

### 2.7 全文搜索（FTS5）

```sql
CREATE VIRTUAL TABLE search_index USING fts5(
  entity_type UNINDEXED,
  entity_id   UNINDEXED,
  project_id  UNINDEXED,
  title,
  body,
  tokenize = 'unicode61'
);
```

- 写入前对中文做**字符级切分预处理**（每个汉字独立 token，英文按词）。
- `tasks` / `tickets` / `documents` 各建 `AFTER INSERT / UPDATE / DELETE` 触发器同步。
- 查询用 `MATCH` + `bm25()` 排序，`snippet()` 生成高亮片段；类型过滤用 `entity_type` 列。

### 2.8 预留表（M6，先建表不写业务）

`git_links`、`sprints`、`okrs`、`users`、`project_members`。

---

## 3. 全局配置（AppData，非 SQLite）

`%APPDATA%/pm-studio/config.json`，**原子写**（写临时文件 → `fs.rename`）：

```jsonc
{
  "version": 1,
  "activeWorkspaceId": "01J...",
  "workspaces": [
    {
      "id": "01J...",
      "name": "我的工作区",
      "path": "D:\\pm-workspace",
      "lastOpenedAt": 1758500000000,
      "createdAt": 1758000000000
    }
  ],
  "preferences": {
    "theme": "dark",
    "defaultProjectRoot": "D:\\pm-workspace\\projects",
    "editorCommand": "code",
    "autoBackup": { "enabled": true, "intervalMinutes": 30, "keepCount": 10 },
    "logging": {
      "level": "info",
      "retentionDays": 30,
      "fileMaxMB": 5,
      "fileKeepCount": 5,
      "redactUserName": true
    },
    "jobLogRetentionDays": 30
  }
}
```

> 工作区数据库**从不**存放在 AppData；AppData 只保存这份小配置，丢失可从工作区目录手动重建。

---

## 4. API 清单

**约定**：前缀 `/api/v1`；统一响应包 `{ ok, data }` / `{ ok, error }`；维护模式下所有写操作返回 `423 Locked`。

### 4.1 工作区

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/workspaces` | 工作区清单（含磁盘可用性检测） |
| POST | `/workspaces` | 创建工作区（`{ name, path }`） |
| POST | `/workspaces/:id/activate` | 切换激活工作区 |
| PATCH | `/workspaces/:id` | 重命名 |
| DELETE | `/workspaces/:id` | 从清单移除（可选是否删磁盘数据） |
| POST | `/workspaces/:id/migrate` | **迁移工作区**（创建 job，返回 `jobId`） |
| POST | `/workspaces/:id/migrate/precheck` | 迁移预检（不执行，返回可行性报告） |
| GET | `/workspaces/status` | 当前工作区、维护模式、磁盘占用 |

### 4.2 项目

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/projects` | 列表（`?status=&includeArchived=&all=`） |
| POST | `/projects` | 新建（**纯管理项目**路径） |
| GET | `/projects/:id` | 详情 |
| PATCH | `/projects/:id` | 修改 |
| DELETE | `/projects/:id` | 软删除 / 永久删除（`?hard=true`） |
| POST | `/projects/:id/restore` | 从回收站还原 |
| POST | `/projects/:id/archive` `…/unarchive` | 归档切换 |
| POST | `/projects/:id/open-code-path` | 在资源管理器中打开代码目录 |
| POST | `/projects/:id/open-in-editor` | 用配置的 IDE 打开 |

### 4.3 工作流状态

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/projects/:id/workflow-statuses` | 列表（按 `sort_order`） |
| POST | `/projects/:id/workflow-statuses` | 新增状态 |
| PATCH | `/workflow-statuses/:id` | 重命名 / 改色 / 改 `category` |
| DELETE | `/workflow-statuses/:id` | 删除（需指定迁移目标状态，或确认任务回到默认状态） |
| POST | `/projects/:id/workflow-statuses/reorder` | 批量排序 |
| POST | `/projects/:id/workflow-statuses/apply-template` | 套用状态模板 |

### 4.4 任务

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/projects/:id/tasks` | 列表 / 任务树（`?view=tree\|flat&statusId=&tagIds=&assigneeId=&q=&dueBefore=`） |
| GET | `/projects/:id/board` | 看板数据（按状态分列，含子任务计数） |
| POST | `/tasks` | 新建（`{ projectId, parentId?, ... }`） |
| GET | `/tasks/:id` | 详情（含依赖、标签、附件、活动） |
| PATCH | `/tasks/:id` | 修改 |
| DELETE | `/tasks/:id` | 软删除（级联子任务需 `?cascade=true`） |
| POST | `/tasks/:id/restore` | 还原 |
| POST | `/tasks/:id/move` | **拖拽专用**：`{ statusId, beforeTaskId?, afterTaskId? }` 一次性完成改状态与重排序 |
| POST | `/tasks/batch` | 批量修改 / 批量删除 / 批量加标签 |
| POST | `/tasks/:id/dependencies` | 新增依赖（服务层做**成环检测**） |
| DELETE | `/tasks/:id/dependencies/:depId` | 删除依赖 |

> `POST /tasks/:id/move` 是看板拖拽的唯一入口：服务端在一个事务内完成状态变更 + `sort_order` 重排，避免前端算序导致的不一致。

### 4.5 标签与里程碑

| 方法 | 路径 |
|---|---|
| GET/POST | `/projects/:id/tags` |
| PATCH/DELETE | `/tags/:id` |
| GET/POST | `/projects/:id/milestones` |
| PATCH/DELETE | `/milestones/:id` |

### 4.6 工单

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/projects/:id/tickets` | 筛选：类型、状态、优先级、关键词 |
| POST | `/tickets` | 新建（服务端分配 `seq` 与 `code`） |
| GET/PATCH/DELETE | `/tickets/:id` | 详情 / 修改 / 软删除 |
| POST | `/tickets/:id/move` | 拖拽改状态 |
| GET/POST | `/projects/:id/ticket-types` | 工单类型 |
| PATCH/DELETE | `/ticket-types/:id` | |
| POST | `/tickets/:id/link-task` `…/unlink-task` | 与任务关联 |

### 4.7 文档与附件

| 方法 | 路径 | 说明 |
|---|---|---|
| GET/POST | `/doc-folders` | 文档树（`?projectId=`，空为独立知识库） |
| PATCH/DELETE | `/doc-folders/:id` | |
| GET | `/documents` | 列表（`?projectId=&folderId=&isTemplate=`） |
| POST | `/documents` | 新建（可用文档模板） |
| GET/PATCH/DELETE | `/documents/:id` | 详情 / 保存 / 删除 |
| GET | `/documents/:id/versions` | 历史版本列表 |
| POST | `/documents/:id/versions/:versionId/restore` | 回滚到指定版本 |
| POST | `/attachments` | 上传（multipart，写入工作区 `attachments/`） |
| GET | `/attachments/:id/download` | 下载 / 预览 |
| DELETE | `/attachments/:id` | 删除（同时删磁盘文件） |

### 4.8 搜索

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/search` | `?q=&types=task,ticket,document&projectId=&limit=` 返回分组结果 + 高亮片段 |

### 4.9 环境检测与配置

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/env/detect` | 执行检测（可 `?force=true` 忽略缓存），返回各工具状态 |
| GET | `/env/status` | 读取缓存结果与「是否首次」标记 |
| GET | `/env/plan` | 预览将要执行的改动（PATH 追加项、`.npmrc` / `pip.ini` 变更），**不落盘** |
| POST | `/env/apply` | 应用选中的配置项（`{ items: ['user_path','npmrc','pipini'] }`），自动备份原值 |
| POST | `/env/rollback` | 回滚（`{ backupIds: [] }` 或 `?all=true`） |
| GET | `/env/backups` | 备份历史列表 |

### 4.10 模板与脚手架

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/templates` | 模板列表（`?kind=&stack=`） |
| POST | `/templates` | 从现有项目「另存为模板」（预留） |
| DELETE | `/templates/:id` | 仅允许删除非内置模板 |
| GET | `/scaffold/options` | 可用技术栈、探测到的官方脚手架能力、包管理器候选 |
| POST | `/scaffold/plan` | 提交向导表单，返回**执行计划预览**（将生成的文件树、将执行的命令） |
| POST | `/scaffold/execute` | 执行（创建 job，返回 `jobId`） |

### 4.11 作业

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/jobs` | 作业列表（`?status=&type=`） |
| GET | `/jobs/:id` | 详情（含阶段、进度、结果、错误） |
| GET | `/jobs/:id/events` | **SSE**：实时日志与进度（支持 `Last-Event-ID` 续传） |
| POST | `/jobs/:id/cancel` | 取消（杀进程树 + 清理临时产物） |
| POST | `/jobs/:id/retry` | 重试（仅网络类失败） |
| GET | `/jobs/:id/logs` | 分页拉取历史日志 |

### 4.12 备份、导出与设置

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/backups` | 备份列表 |
| POST | `/backups` | 手动备份（job） |
| POST | `/backups/:id/restore` | 从备份还原（高危，二次确认 + 自动先备份当前库） |
| POST | `/export` | 导出 JSON / Markdown（job，`{ targetDir, format }`） |
| POST | `/import` | 从 JSON 导入（预留，M6） |
| GET/PATCH | `/settings` | 工作区级设置 |
| GET/PATCH | `/app/preferences` | 全局偏好（主题、默认根目录、IDE 命令、备份策略） |

### 4.13 系统事件（SSE）

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/events` | 全局事件流：`workspace.changed`、`maintenance.on/off`、`job.updated`、`sync.required`、`log.appended` |

### 4.14 日志与诊断（v1.1 新增）

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/logs` | 日志查询：`?level=&source=&scope=&from=&to=&q=&traceId=&jobId=&page=&pageSize=` |
| GET | `/logs/:id` | 单条详情（完整堆栈与上下文 JSON） |
| GET | `/logs/stream` | **SSE**：实时日志流，可按 `level` / `source` 过滤 |
| GET | `/logs/context/:traceId` | **一键定位现场**：该请求 / 作业的全部日志 + 作业信息 + 错误码与堆栈 |
| GET | `/logs/files` | 文本日志文件列表（文件名、大小、修改时间、是否已轮转） |
| GET | `/logs/files/:name` | 读取指定文本日志（支持 `?tail=N`） |
| POST | `/logs/export` | 导出诊断包（创建 job，返回 `jobId`；产物为脱敏 ZIP） |
| DELETE | `/logs` | 清理日志：`?before=<ts>` 或 `?level=debug` |
| GET/PATCH | `/settings/logging` | 日志级别、保留天数、单文件大小上限、用户名脱敏开关 |

> 前端所有错误提示统一携带 **错误码 + `traceId`**，点击「查看日志」即请求 `/logs/context/:traceId` —— 这是"能查日志"与"只是把文件搬到界面上"的分界线。

---

## 5. 错误码

| code | HTTP | 含义 |
|---|---|---|
| `VALIDATION_FAILED` | 400 | Zod 校验失败（`details` 带字段级信息） |
| `NOT_FOUND` | 404 | 资源不存在 |
| `CONFLICT` | 409 | 唯一约束冲突（如标签重名、项目 code 冲突） |
| `DEPENDENCY_CYCLE` | 409 | 任务依赖成环 |
| `MAINTENANCE_MODE` | 423 | 维护模式（迁移中），写操作被拒 |
| `WORKSPACE_UNAVAILABLE` | 409 | 工作区路径失效（盘符不存在 / 被移动） |
| `DISK_SPACE_INSUFFICIENT` | 507 | 磁盘空间不足（迁移预检） |
| `FILE_LOCKED` | 409 | 目标文件被占用（迁移预检） |
| `ENV_TOOL_MISSING` | 424 | 环境检测未通过，缺少必需工具 |
| `JOB_ALREADY_RUNNING` | 409 | 同类独占作业正在运行 |
| `JOB_CANCELED` | 499 | 作业被取消 |
| `COMMAND_NOT_ALLOWED` | 403 | 命令不在白名单内 |
| `PATH_OUT_OF_SCOPE` | 403 | 路径越界 |
| `INTERNAL_ERROR` | 500 | 未预期错误（`details.traceId` 对应日志） |
