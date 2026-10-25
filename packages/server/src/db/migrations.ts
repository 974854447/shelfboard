/**
 * 数据库迁移。
 *
 * 这里是 DDL 的**唯一来源**：索引、外键、唯一约束、部分索引都写在这。
 * `schema.ts` 只负责查询用的列定义（理由见 schema.ts 顶部说明）。
 *
 * 约定：
 * - 已应用的迁移**不得修改**。需要变更就加一条新迁移 ——
 *   执行器会校验校验和，改过的迁移会被拒绝（否则不同机器的库会悄悄分叉）。
 * - 全部使用 `IF NOT EXISTS`：`app_logs` 可能已被日志模块自建过
 *   （那是为了在主迁移失败时仍能记下错误），两者汇合不能报错。
 * - SQLite 无法用 ALTER TABLE 添加外键。因此**工单与作业的相关表在 M1 就建好**，
 *   让 `tasks.ticket_id`、`app_logs.job_id` 从一开始就带上正确的外键，
 *   避免日后为了补一个约束而重建整张表。表先建、功能后做，代价是零。
 */

export interface Migration {
  /** 递增编号，如 '0001_init' */
  id: string;
  description: string;
  up: string;
  /**
   * 这一版需要在**临时关闭外键约束**的情况下执行（默认 false）。
   *
   * 什么时候需要：SQLite **不支持**把已有列改成 NOT NULL / 改类型，
   * 官方推荐的做法是"建新表 → 拷数据 → 删旧表 → 改名"。而删旧表时，
   * 只要外键约束是开着的，SQLite 会**隐式执行一次 DELETE**，
   * 于是所有指向它的子表行会被 ON DELETE CASCADE 一起删掉
   * （例如 `task_tags.tag_id → tags.id`）。那是静默的数据丢失。
   *
   * 而执行器默认把每条迁移包在事务里、连接又强制开着外键，
   * `PRAGMA foreign_keys` 在事务内是**空操作** —— 所以只能由执行器在事务外切换。
   * 声明了这个开关的迁移，执行器会在事务外先关外键、跑完后做一次
   * `PRAGMA foreign_key_check`（在事务内做，违规就整体回滚），最后把外键恢复。
   */
  foreignKeysOff?: boolean;
}

const INIT_SQL = `
-- ============ 项目 ============
CREATE TABLE IF NOT EXISTS projects (
  id            TEXT PRIMARY KEY,
  owner_id      TEXT NOT NULL DEFAULT 'local-user',
  name          TEXT NOT NULL,
  description   TEXT,
  color         TEXT NOT NULL DEFAULT '#2080f0',
  icon          TEXT,
  code_path     TEXT,
  code_kind     TEXT,
  stack_json    TEXT,
  status        TEXT NOT NULL DEFAULT 'active',
  sort_order    INTEGER NOT NULL DEFAULT 0,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL,
  deleted_at    INTEGER
);
CREATE INDEX IF NOT EXISTS idx_projects_status ON projects(status, deleted_at);

-- ============ 工作流状态 ============
CREATE TABLE IF NOT EXISTS workflow_statuses (
  id            TEXT PRIMARY KEY,
  project_id    TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name          TEXT NOT NULL,
  color         TEXT NOT NULL DEFAULT '#8a8a8a',
  category      TEXT NOT NULL DEFAULT 'doing',
  sort_order    INTEGER NOT NULL DEFAULT 0,
  is_default    INTEGER NOT NULL DEFAULT 0,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_wf_status_project ON workflow_statuses(project_id, sort_order);

-- ============ 标签 ============
CREATE TABLE IF NOT EXISTS tags (
  id            TEXT PRIMARY KEY,
  project_id    TEXT REFERENCES projects(id) ON DELETE CASCADE,
  name          TEXT NOT NULL,
  color         TEXT NOT NULL DEFAULT '#8a8a8a',
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);
-- 同一作用域内标签不重名；project_id 为 NULL 的全局标签也要受约束，
-- 所以用 IFNULL 把 NULL 归一成空串参与唯一索引。
CREATE UNIQUE INDEX IF NOT EXISTS uq_tags_scope_name ON tags(IFNULL(project_id, ''), name);

-- ============ 工单类型 ============
CREATE TABLE IF NOT EXISTS ticket_types (
  id            TEXT PRIMARY KEY,
  project_id    TEXT REFERENCES projects(id) ON DELETE CASCADE,
  name          TEXT NOT NULL,
  prefix        TEXT NOT NULL,
  icon          TEXT,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);

-- ============ 工单 ============
CREATE TABLE IF NOT EXISTS tickets (
  id            TEXT PRIMARY KEY,
  owner_id      TEXT NOT NULL DEFAULT 'local-user',
  project_id    TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  type_id       TEXT REFERENCES ticket_types(id) ON DELETE SET NULL,
  seq           INTEGER NOT NULL,
  code          TEXT NOT NULL,
  title         TEXT NOT NULL,
  description   TEXT,
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
CREATE UNIQUE INDEX IF NOT EXISTS uq_ticket_code ON tickets(project_id, code);
CREATE INDEX IF NOT EXISTS idx_tickets_status ON tickets(project_id, status_id, sort_order);

-- ============ 任务 ============
CREATE TABLE IF NOT EXISTS tasks (
  id            TEXT PRIMARY KEY,
  owner_id      TEXT NOT NULL DEFAULT 'local-user',
  project_id    TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  parent_id     TEXT REFERENCES tasks(id) ON DELETE CASCADE,
  ticket_id     TEXT REFERENCES tickets(id) ON DELETE SET NULL,
  title         TEXT NOT NULL,
  description   TEXT,
  status_id     TEXT REFERENCES workflow_statuses(id) ON DELETE SET NULL,
  priority      TEXT NOT NULL DEFAULT 'medium',
  assignee_id   TEXT,
  start_date    INTEGER,
  due_date      INTEGER,
  completed_at  INTEGER,
  progress      INTEGER NOT NULL DEFAULT 0,
  sort_order    INTEGER NOT NULL DEFAULT 0,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL,
  deleted_at    INTEGER
);
CREATE INDEX IF NOT EXISTS idx_tasks_project_status ON tasks(project_id, status_id, sort_order);
CREATE INDEX IF NOT EXISTS idx_tasks_parent ON tasks(parent_id);
-- 部分索引：只索引未删除的行，回收站里的任务不占用截止日索引
CREATE INDEX IF NOT EXISTS idx_tasks_due ON tasks(due_date) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_tasks_ticket ON tasks(ticket_id);

-- ============ 任务依赖 ============
CREATE TABLE IF NOT EXISTS task_dependencies (
  id             TEXT PRIMARY KEY,
  predecessor_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  successor_id   TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  type           TEXT NOT NULL DEFAULT 'FS',
  lag_days       INTEGER NOT NULL DEFAULT 0,
  created_at     INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_dep ON task_dependencies(predecessor_id, successor_id);
-- 反向索引：查"某任务的前置任务"和"某任务的后继任务"都会用到
CREATE INDEX IF NOT EXISTS idx_dep_successor ON task_dependencies(successor_id);

-- ============ 任务标签 ============
CREATE TABLE IF NOT EXISTS task_tags (
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  tag_id  TEXT NOT NULL REFERENCES tags(id)  ON DELETE CASCADE,
  PRIMARY KEY (task_id, tag_id)
);
CREATE INDEX IF NOT EXISTS idx_task_tags_tag ON task_tags(tag_id);

-- ============ 里程碑 ============
CREATE TABLE IF NOT EXISTS milestones (
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
CREATE INDEX IF NOT EXISTS idx_milestones_project ON milestones(project_id, sort_order);

-- ============ 审计 ============
CREATE TABLE IF NOT EXISTS activity_logs (
  id           TEXT PRIMARY KEY,
  entity_type  TEXT NOT NULL,
  entity_id    TEXT NOT NULL,
  project_id   TEXT,
  action       TEXT NOT NULL,
  changes_json TEXT,
  actor_id     TEXT NOT NULL DEFAULT 'local-user',
  created_at   INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_activity_entity
  ON activity_logs(entity_type, entity_id, created_at DESC);

-- ============ 作业 ============
CREATE TABLE IF NOT EXISTS jobs (
  id            TEXT PRIMARY KEY,
  type          TEXT NOT NULL,
  title         TEXT NOT NULL,
  status        TEXT NOT NULL,
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
CREATE INDEX IF NOT EXISTS idx_jobs_status ON jobs(status, created_at DESC);

CREATE TABLE IF NOT EXISTS job_logs (
  id      TEXT PRIMARY KEY,
  job_id  TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  ts      INTEGER NOT NULL,
  level   TEXT NOT NULL DEFAULT 'info',
  message TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_job_logs ON job_logs(job_id, ts);

-- ============ 应用日志 ============
-- 可能已被 logging/store.ts 以 IF NOT EXISTS 建过；那种情况下本语句是空操作，
-- 外键由先建的那一份决定（见 store.ts 里的说明）。
CREATE TABLE IF NOT EXISTS app_logs (
  id          TEXT PRIMARY KEY,
  ts          INTEGER NOT NULL,
  level       TEXT NOT NULL,
  source      TEXT NOT NULL,
  scope       TEXT,
  message     TEXT NOT NULL,
  detail      TEXT,
  trace_id    TEXT,
  job_id      TEXT REFERENCES jobs(id) ON DELETE SET NULL,
  request_id  TEXT,
  redacted    INTEGER NOT NULL DEFAULT 1,
  created_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_app_logs_ts    ON app_logs(ts DESC);
CREATE INDEX IF NOT EXISTS idx_app_logs_level ON app_logs(level, ts DESC);
CREATE INDEX IF NOT EXISTS idx_app_logs_src   ON app_logs(source, ts DESC);
CREATE INDEX IF NOT EXISTS idx_app_logs_trace ON app_logs(trace_id);
CREATE INDEX IF NOT EXISTS idx_app_logs_job   ON app_logs(job_id, ts);

-- ============ 工作区元信息 ============
CREATE TABLE IF NOT EXISTS workspace_meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`;

/**
 * 0.1.1：工作区只服务项目 —— 应用日志搬出工作区库。
 *
 * 日志从这一版起写在 **AppData 下的独立库**（`<userData>/logs/app-logs.db`），
 * 工作区里不再保留任何"应用自身的运行期数据"。
 *
 * 两点必须说明白：
 *
 * 1. **旧数据由应用先导出再删表**。迁移只拿得到工作区库的句柄，够不到工作区之外的路径，
 *    所以搬运不能写在这里；桌面端会在启动时先把旧表导出成
 *    `<userData>/logs/legacy-app-logs.jsonl`，**然后**才执行到这条迁移。
 *    顺序反了就是静默丢数据。
 * 2. **不能回头改 `0001_init`**（已应用的迁移带校验和，改一个字符老库就校验失败），
 *    所以这里是在 0001 建过表之后再删掉它。新库会白建一次再删，代价可忽略，
 *    换来的是"老库与新库最终状态一致"。
 */
const REMOVE_WORKSPACE_APP_LOGS_SQL = `
-- 应用日志不再属于工作区：索引随表一起删除
DROP TABLE IF EXISTS app_logs;
`;

/**
 * 0.1.2：一个项目 = 工作区里的一个文件夹。
 *
 * 只加一列：项目文件夹名（相对于工作区根目录）。文件夹里放这个项目的实体东西
 * （代码、附件、日志），而任务/看板这些**管理数据**仍然在 workspace.db 里。
 *
 * 注意 SQLite 的 `ALTER TABLE ADD COLUMN` **没有 IF NOT EXISTS** ——
 * 这里靠"每条迁移只执行一次"来保证不重复加列（迁移执行器会记录已应用的 id）。
 */
const PROJECT_FOLDER_SQL = `
ALTER TABLE projects ADD COLUMN folder TEXT;
`;

/**
 * 0.2.0（M2）：全局搜索的全文索引。
 *
 * 三条设计决定：
 *
 * 1. **`tokenize = 'trigram'`，不用默认的 unicode61。**
 *    实测（见 docs/technical-design.md §24）：unicode61 会把一连串中文当成**一个词**，
 *    于是 `match('接入登录态')` 命中、而用户真正会输入的 `match('登录')` 一条都搜不到。
 *    trigram 按 3 字片段切，中文片段搜索才成立。代价是**最少 3 个字符**，
 *    少于 3 字时服务端回落到 LIKE（见 services/task-query.ts）。
 *
 * 2. **用触发器同步，而不是在业务代码里双写。**
 *    任务的写入路径有好几条（新建/更新/移动/批量/恢复/软删除），
 *    在任何一条上漏写索引，搜索就会静默少结果 —— 那是很难发现的一类错误。
 *    触发器跟着表走，谁也绕不过去。
 *
 * 3. **工单表一起纳入**（表已存在，M3 才落界面）。现在建好，M3 就不用再补一次迁移。
 *    软删除（`deleted_at`）在查询时过滤，所以索引里留着已删除的文档没问题。
 */
const SEARCH_INDEX_SQL = `
CREATE VIRTUAL TABLE IF NOT EXISTS search_index USING fts5(
  doc_type UNINDEXED,
  doc_id UNINDEXED,
  project_id UNINDEXED,
  title,
  body,
  tokenize = 'trigram'
);

INSERT INTO search_index (doc_type, doc_id, project_id, title, body)
SELECT 'task', id, project_id, title, COALESCE(description, '')
FROM tasks WHERE deleted_at IS NULL;

INSERT INTO search_index (doc_type, doc_id, project_id, title, body)
SELECT 'ticket', id, project_id, title, COALESCE(description, '')
FROM tickets WHERE deleted_at IS NULL;

CREATE TRIGGER IF NOT EXISTS search_index_task_insert AFTER INSERT ON tasks BEGIN
  INSERT INTO search_index (doc_type, doc_id, project_id, title, body)
  VALUES ('task', new.id, new.project_id, new.title, COALESCE(new.description, ''));
END;

CREATE TRIGGER IF NOT EXISTS search_index_task_update AFTER UPDATE ON tasks BEGIN
  DELETE FROM search_index WHERE doc_type = 'task' AND doc_id = old.id;
  INSERT INTO search_index (doc_type, doc_id, project_id, title, body)
  VALUES ('task', new.id, new.project_id, new.title, COALESCE(new.description, ''));
END;

CREATE TRIGGER IF NOT EXISTS search_index_task_delete AFTER DELETE ON tasks BEGIN
  DELETE FROM search_index WHERE doc_type = 'task' AND doc_id = old.id;
END;

CREATE TRIGGER IF NOT EXISTS search_index_ticket_insert AFTER INSERT ON tickets BEGIN
  INSERT INTO search_index (doc_type, doc_id, project_id, title, body)
  VALUES ('ticket', new.id, new.project_id, new.title, COALESCE(new.description, ''));
END;

CREATE TRIGGER IF NOT EXISTS search_index_ticket_update AFTER UPDATE ON tickets BEGIN
  DELETE FROM search_index WHERE doc_type = 'ticket' AND doc_id = old.id;
  INSERT INTO search_index (doc_type, doc_id, project_id, title, body)
  VALUES ('ticket', new.id, new.project_id, new.title, COALESCE(new.description, ''));
END;

CREATE TRIGGER IF NOT EXISTS search_index_ticket_delete AFTER DELETE ON tickets BEGIN
  DELETE FROM search_index WHERE doc_type = 'ticket' AND doc_id = old.id;
END;
`;

/**
 * 0005：日历标记（M2）。
 *
 * **为什么没有 `project_id`**：日历标记是"我的时间安排"（休假、发版日、生日、
 * 出差…），不是项目数据。挂到项目上会出现"切到另一个项目，这件全公司都知道的事
 * 就从日历上消失了"，反而更难用；而它的显示范围由日历页自己的
 * 「当前项目 / 全部项目」开关管的是**任务**，标记始终都在。
 * 这是对"项目之间互不共享"的一处**刻意例外**（与全局标签同理），记在技术设计 §35。
 * 将来真要项目级，加一列 `project_id`（可空）即可，数据不用搬。
 *
 * `date` 存的是**某一天本地零点的毫秒时间戳**，由渲染层按本地时区算好传进来 ——
 * 与服务端"不猜时区"的口径一致（见 services/task-query.ts 的说明）。
 */
const CALENDAR_MARKS_SQL = `
CREATE TABLE IF NOT EXISTS calendar_marks (
  id TEXT PRIMARY KEY,
  date INTEGER NOT NULL,
  title TEXT NOT NULL,
  color TEXT NOT NULL DEFAULT '#3b82f6',
  note TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_calendar_marks_date ON calendar_marks(date);
`;

/**
 * 0006：把"项目级数据"这条线焊死 —— 移除全局标签、去掉全局工单类型。
 *
 * 用户 2026-09-26 的决定（决策记录 #27、#28、#33）：**项目之间完全独立**，
 * 跨项目只允许一样东西——"项目间关系链"，而且纯展示。于是数据库层面也不该再留着
 * `project_id` 可空这张口子：
 *
 * - `tags.project_id`：可空时那个值代表"全局标签"，会出现在**每个项目**的标签列表里
 *   （`or(eq(projectId), isNull(projectId))`），正是"隔壁项目的标签出现在我这儿"的来源。
 * - `ticket_types.project_id`：同样的口子，工单功能一直没落地，所以从来没有数据。
 *
 * 三条实现要点：
 *
 * 1. **必须重建表**：SQLite 改不了已有列的 NOT NULL，只能"建新表 → 拷数据 → 删旧表 → 改名"。
 *    而删旧表时 `task_tags.tag_id` 的外键会级联删掉关联行，所以这一版声明了
 *    `foreignKeysOff`（见 Migration 接口的说明），由执行器在事务外临时关外键。
 * 2. **不静默丢数据**：`project_id IS NULL` 的行本来就没地方可去（它们不属于任何项目），
 *    但直接删掉是不负责任的。先把它们整行留证到 `removed_projectless_rows`，
 *    再重建表 —— 两张表 0 行时这张留证表也是 0 行，等于不存在。
 * 3. **唯一索引换掉**：`(IFNULL(project_id,''), name)` 里的 IFNULL 就是为了兼容 NULL 作用域，
 *    现在 `project_id` 非空，索引回到最朴素的 `(project_id, name)`。
 */
const PROJECT_SCOPED_SHARED_DATA_SQL = `
-- 留证表：只有"确实存在不属于任何项目的行"时才会有内容
CREATE TABLE IF NOT EXISTS removed_projectless_rows (
  id           TEXT PRIMARY KEY,
  source_table TEXT NOT NULL,
  payload      TEXT NOT NULL,
  removed_at   INTEGER NOT NULL
);

INSERT OR IGNORE INTO removed_projectless_rows (id, source_table, payload, removed_at)
SELECT 'tags:' || id, 'tags',
       json_object('id', id, 'name', name, 'color', color,
                   'created_at', created_at, 'updated_at', updated_at),
       CAST(strftime('%s', 'now') AS INTEGER) * 1000
  FROM tags WHERE project_id IS NULL;

INSERT OR IGNORE INTO removed_projectless_rows (id, source_table, payload, removed_at)
SELECT 'ticket_types:' || id, 'ticket_types',
       json_object('id', id, 'name', name, 'prefix', prefix, 'icon', icon,
                   'created_at', created_at, 'updated_at', updated_at),
       CAST(strftime('%s', 'now') AS INTEGER) * 1000
  FROM ticket_types WHERE project_id IS NULL;

-- ============ 标签：project_id 改 NOT NULL ============
CREATE TABLE tags_new (
  id            TEXT PRIMARY KEY,
  project_id    TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name          TEXT NOT NULL,
  color         TEXT NOT NULL DEFAULT '#8a8a8a',
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);

INSERT INTO tags_new (id, project_id, name, color, created_at, updated_at)
SELECT id, project_id, name, color, created_at, updated_at
  FROM tags WHERE project_id IS NOT NULL;

DROP TABLE tags;
ALTER TABLE tags_new RENAME TO tags;
CREATE UNIQUE INDEX IF NOT EXISTS uq_tags_scope_name ON tags(project_id, name);

-- ============ 工单类型：project_id 改 NOT NULL ============
CREATE TABLE ticket_types_new (
  id            TEXT PRIMARY KEY,
  project_id    TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name          TEXT NOT NULL,
  prefix        TEXT NOT NULL,
  icon          TEXT,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);

INSERT INTO ticket_types_new (id, project_id, name, prefix, icon, created_at, updated_at)
SELECT id, project_id, name, prefix, icon, created_at, updated_at
  FROM ticket_types WHERE project_id IS NOT NULL;

DROP TABLE ticket_types;
ALTER TABLE ticket_types_new RENAME TO ticket_types;
`;

/**
 * 0007：项目间关系链（需求 §5.2.1，**纯展示**）。
 *
 * 只加一张表，不动任何老表 —— 这是最省事也最安全的一类迁移：
 * 关系链是**新功能**，老数据里没有它的概念（用户当年只说了"要能标一条关系"）。
 *
 * 两个端点都用 `ON DELETE CASCADE`：项目被**物理删除**时，指向它的关系行跟着消失
 * （否则会留下指向不存在项目的关系，界面上只能显示成"未知项目"）。
 * 项目正常删除走的是软删除（进回收站），关系行保留 —— 恢复项目时关系还在。
 */
const PROJECT_RELATIONS_SQL = `
CREATE TABLE project_relations (
  id              TEXT PRIMARY KEY,
  from_project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  to_project_id   TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  label           TEXT NOT NULL,
  note            TEXT,
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL
);

CREATE UNIQUE INDEX idx_project_relations_pair
  ON project_relations (from_project_id, to_project_id, label);

CREATE INDEX idx_project_relations_from ON project_relations (from_project_id);
CREATE INDEX idx_project_relations_to ON project_relations (to_project_id);
`;

/**
 * 当日工作时间（打卡）+「今天做」标记。
 *
 * 两部分放在同一个迁移里，因为它们服务同一个界面（我的待办）：上面是工时，下面是今天要做的事。
 *
 * 1) `work_sessions`：每天第一次打开软件开始计时、最后一次关闭结束。
 *    - `last_seen_at` 是心跳。应用被**强杀**时 `ended_at` 会一直是 NULL，
 *      下次启动靠心跳把会话收到最后一次心跳为止（宁可少算，不可多算）。
 *    - 心跳列建索引：启动时要按"还没结束的会话"找出来补收，这是唯一的查询条件。
 * 2) `tasks.today_mark_date`：手动"今天做"标记，存**本地日期键**（YYYY-MM-DD）。
 *    存日期而不是布尔，是为了让它自然过期 —— 明天打开时它自己就不算今日待办了，
 *    不需要任何定时任务去清理。
 *
 * 为什么用 ALTER TABLE 加列而不是重建 tasks：这一列是可空的、没有默认值、没有约束，
 * 加列不会影响任何既有行与查询，没有理由去动那张表（重建要关外键、重写索引，风险大得多）。
 */
const WORK_TIME_AND_TODAY_MARKS_SQL = `
CREATE TABLE work_sessions (
  id            TEXT PRIMARY KEY,
  started_at    INTEGER NOT NULL,
  last_seen_at  INTEGER NOT NULL,
  ended_at      INTEGER,
  close_reason  TEXT,
  created_at    INTEGER NOT NULL
);

CREATE INDEX idx_work_sessions_started ON work_sessions (started_at);
CREATE INDEX idx_work_sessions_open ON work_sessions (ended_at);

ALTER TABLE tasks ADD COLUMN today_mark_date TEXT;
`;

/**
 * 六态状态流 + 取消进度（用户 2026-10-02）。
 *
 * 用户的要求：「所有任务的进度条都取消，改成状态待完成、正在修改、待审查、审查中、
 * 回退修改、已完成，不再需要进度条，以此逻辑修改任务的完成状态显示」。
 *
 * 这件事有三块，这里只做**数据侧**的规范化（界面上不再显示进度条、DTO 里不再有 progress
 * 都在代码里完成）：
 *
 * 1. **给每个已有项目补齐六态**（按名字判重，已有同名的不重复插）。
 *    新建项目的模板已经换成六态了（`DEFAULT_WORKFLOW_TEMPLATE`），
 *    但**已经建好的项目**还停在旧的三态/五态上 —— 不补的话，用户打开自己的老项目
 *    仍然只有"待处理 / 进行中 / 已完成"。
 * 2. **按分类把旧状态上的任务收敛到六态**：`done → 已完成`、`doing → 正在修改`、
 *    其余 → `待完成`。刻意按**分类**而不是按名字猜：`测试中`该归"审查中"还是"正在修改"
 *    只有用户自己知道，硬猜会把语义改错；按分类收敛是"语义上确定成立"的那一部分，
 *    剩下的细分请用户自己用状态标签调整。
 * 3. **删掉旧状态**，并把每个项目的默认状态落到「待完成」上（新建任务要有落点）。
 *
 * 为什么用纯 SQL（`up` 只接受字符串）：迁移是 DDL 的唯一来源，也是"换台机器也一样"的保证 ——
 * 能写成 SQL 就别写成本地脚本。
 *
 * `tasks.progress` 这一列**保留但不读不写**：SQLite 删列要重建表，而这个字段已经没有任何
 * 语义，为一个 INTEGER 去动表结构不划算（删列这件事留到将来真的需要腾空间时再做）。
 */
const SIX_STATE_STATUSES_SQL = `
-- 1) 每个项目补齐六态（已有同名状态的项目不受影响）
INSERT INTO workflow_statuses
  (id, project_id, name, color, category, sort_order, is_default, created_at, updated_at)
SELECT
  lower(hex(randomblob(12))),
  p.id,
  v.name,
  v.color,
  v.category,
  v.ord * 1000,
  0,
  CAST(strftime('%s','now') AS INTEGER) * 1000,
  CAST(strftime('%s','now') AS INTEGER) * 1000
FROM projects p
CROSS JOIN (
  SELECT '待完成' AS name, '#8a8a8a' AS color, 'todo' AS category, 1 AS ord
  UNION ALL SELECT '正在修改', '#2080f0', 'doing', 2
  UNION ALL SELECT '待审查', '#f0a020', 'doing', 3
  UNION ALL SELECT '审查中', '#7b61ff', 'doing', 4
  UNION ALL SELECT '回退修改', '#d03050', 'doing', 5
  UNION ALL SELECT '已完成', '#18a058', 'done', 6
) v
WHERE NOT EXISTS (
  SELECT 1 FROM workflow_statuses w WHERE w.project_id = p.id AND w.name = v.name
);

-- 2) 旧状态上的任务按分类收敛到六态
UPDATE tasks
SET status_id = (
  SELECT n.id FROM workflow_statuses n
  WHERE n.project_id = tasks.project_id
    AND n.name = CASE (
      SELECT o.category FROM workflow_statuses o WHERE o.id = tasks.status_id
    )
      WHEN 'done' THEN '已完成'
      WHEN 'doing' THEN '正在修改'
      ELSE '待完成'
    END
  LIMIT 1
)
WHERE tasks.status_id IS NOT NULL
  AND (
    SELECT o.name FROM workflow_statuses o WHERE o.id = tasks.status_id
  ) NOT IN ('待完成', '正在修改', '待审查', '审查中', '回退修改', '已完成');

-- 3) 删掉不在六态里的旧状态（此时已经没有任务指向它们了）
DELETE FROM workflow_statuses
WHERE name NOT IN ('待完成', '正在修改', '待审查', '审查中', '回退修改', '已完成');

-- 4) 每个项目必须有一个默认状态：没有的话落到「待完成」
UPDATE workflow_statuses
SET is_default = 1
WHERE name = '待完成'
  AND is_default = 0
  AND NOT EXISTS (
    SELECT 1 FROM workflow_statuses w
    WHERE w.project_id = workflow_statuses.project_id AND w.is_default = 1
  );
`;

/**
 * 六态顺序归一（用户 2026-10-02）。
 *
 * 0009 是"缺什么补什么"：老项目里已经有的「已完成」保留它原本的 `sort_order`
 * （例如 4000），而新补进来的「待审查 / 审查中 / 回退修改」是模板给的 3000/4000/5000 ——
 * 于是**序号会撞**，看板列的顺序变成"按插入顺序随机"。
 *
 * 所以单独一条迁移，把六态的序号统一按规范顺序写一遍：
 * 待完成 → 正在修改 → 待审查 → 审查中 → 回退修改 → 已完成。
 *
 * 为什么不直接在 0009 里改：用户机器上 0009 可能**已经跑过了**（迁移执行器会校验校验和，
 * 改内容会让应用直接起不来）。已应用的迁移只能新增、不能改写 —— 这是那个设计的意义所在。
 */
const SIX_STATE_ORDER_SQL = `
UPDATE workflow_statuses
SET sort_order = (
  SELECT v.ord * 1000 FROM (
    SELECT '待完成' AS name, 1 AS ord
    UNION ALL SELECT '正在修改', 2
    UNION ALL SELECT '待审查', 3
    UNION ALL SELECT '审查中', 4
    UNION ALL SELECT '回退修改', 5
    UNION ALL SELECT '已完成', 6
  ) v
  WHERE v.name = workflow_statuses.name
)
WHERE name IN ('待完成', '正在修改', '待审查', '审查中', '回退修改', '已完成');
`;

export const MIGRATIONS: readonly Migration[] = [  {
    id: '0001_init',
    description: 'M1 核心表：项目 / 工作流状态 / 标签 / 任务 / 依赖 / 里程碑 / 工单 / 作业 / 日志',
    up: INIT_SQL,
  },
  {
    id: '0002_workspace_only_projects',
    description: '工作区只服务项目：应用日志搬出工作区库（改存 AppData 的独立库）',
    up: REMOVE_WORKSPACE_APP_LOGS_SQL,
  },
  {
    id: '0003_project_folder',
    description: '一个项目一个文件夹：projects 增加 folder 列',
    up: PROJECT_FOLDER_SQL,
  },
  {
    id: '0004_search_index',
    description: 'M2 全局搜索：search_index（FTS5 / trigram）+ 任务与工单的同步触发器',
    up: SEARCH_INDEX_SQL,
  },
  {
    id: '0005_calendar_marks',
    description: 'M2 日历标记：calendar_marks（某一天的自定义标记，工作区级）',
    up: CALENDAR_MARKS_SQL,
  },

  {
    id: '0006_project_scoped_shared_data',
    description:
      '项目级数据收口：移除全局标签与全局工单类型（tags / ticket_types 的 project_id 改 NOT NULL，需临时关外键重建表）',
    up: PROJECT_SCOPED_SHARED_DATA_SQL,
    foreignKeysOff: true,
  },
  {
    id: '0007_project_relations',
    description: '项目间关系链（需求 §5.2.1）：project_relations（两个端点 + 自由填的关系名，纯展示）',
    up: PROJECT_RELATIONS_SQL,
  },
  {
    id: '0008_work_time_and_today_marks',
    description: '当日工作时间与今日待办：work_sessions（打卡会话）+ tasks.today_mark_date（手动「今天做」标记）',
    up: WORK_TIME_AND_TODAY_MARKS_SQL,
  },
  {
    id: '0009_six_state_statuses',
    description:
      '六态状态流（待完成/正在修改/待审查/审查中/回退修改/已完成）：给已有项目补齐六态、旧状态上的任务按分类收敛、删掉旧状态',
    up: SIX_STATE_STATUSES_SQL,
  },
  {
    id: '0010_six_state_order',
    description: '六态顺序归一：老项目里已有的同名状态各自带着旧序号，与新补进来的会撞号（看板列顺序随机）',
    up: SIX_STATE_ORDER_SQL,
  },
];
