/**
 * 跨项目查询与全局搜索（M2）。
 *
 * 为什么单独一个文件：M1 的所有任务查询都挂在**某个项目**下面
 * （`/projects/:id/tasks`），而 M2 的「日历」「我的待办」「全局搜索」三件事
 * 共同需要的是"跨项目"的一层 —— 放在一起，口径就只有一处。
 *
 * **时区口径**：服务端**不猜时区**。凡是"今天/本周"这类按日历天划分的边界，
 * 都由渲染层按**本地时区**算好再传进来（`dueFrom` / `dueTo`）。
 * 服务端只管"这个时间戳落在区间里没有"。这样同一份数据在不同时区看到的
 * "今天"各自正确，也不需要往服务端塞时区配置。
 */

import type { Priority, StatusCategory } from '@pm-studio/shared';

import type { ServiceContext } from './context.js';

export interface TaskWithProject {
  id: string;
  projectId: string;
  projectName: string;
  parentId: string | null;
  title: string;
  statusId: string | null;
  statusCategory: StatusCategory | null;
  /** 状态名与颜色**跟着行一起带回来**：跨项目列表里的任务分属不同项目，
   *  渲染层手里只有"当前项目"的状态表，靠它查名字/颜色会查错或者查不到 */
  statusName: string | null;
  statusColor: string | null;
  /** 已解析好的标签名（卡片直接显示，不用再查标签表） */
  tagNames: string[];
  priority: Priority;
  startDate: number | null;
  dueDate: number | null;
  childCount: number;
  doneChildCount: number;
  blockedByCount: number;
  updatedAt: number;
  /**
   * 「今天做」的手动标记：日期键（本地 YYYY-MM-DD），没标记就是 null。
   *
   * 带着它回来的原因：跨项目列表、今日待办、项目看板都可能在同一天展示同一条任务，
   * 让每处各自去查一次标记既浪费又容易查出不一致的结论。
   * 渲染层只要比较它和"今天的日期键"是否相等就知道要不要点亮那颗按钮。
   */
  todayMarkDate: string | null;
}

/** 跨项目列表附带的状态定义：按项目分组，用于卡片上的状态下拉 */
export interface ProjectStatus {
  id: string;
  projectId: string;
  name: string;
  color: string;
  category: StatusCategory;
  sortOrder: number;
}

export interface CrossProjectResult {
  items: TaskWithProject[];
  total: number;
  /** 结果里出现的每个项目的状态表（去重后的并集） */
  statuses: ProjectStatus[];
}

export interface TaskQueryFilter {
  /** 截止时间下限（含）。由调用方按本地时区算好 */
  dueFrom?: number | undefined;
  /** 截止时间上限（含） */
  dueTo?: number | undefined;
  /** true = 只要没有截止日的（"以后再说"那一组要用） */
  withoutDue?: boolean | undefined;
  /** 只看未完成的（逾期/今天/本周都该排除已完成的） */
  onlyOpen?: boolean | undefined;
  projectIds?: string[] | undefined;
  limit?: number | undefined;
}

export interface TaskRow {
  id: string;
  project_id: string;
  project_name: string;
  parent_id: string | null;
  title: string;
  status_id: string | null;
  status_name: string | null;
  status_color: string | null;
  category: string | null;
  tag_names: string | null;
  priority: string;
  start_date: number | null;
  due_date: number | null;
  child_count: number;
  done_child_count: number;
  blocked_count: number;
  updated_at: number;
  today_mark_date: string | null;
}

export function toTaskWithProject(row: TaskRow): TaskWithProject {
  return {
    id: row.id,
    projectId: row.project_id,
    projectName: row.project_name,
    parentId: row.parent_id,
    title: row.title,
    statusId: row.status_id,
    statusCategory: (row.category as StatusCategory | null) ?? null,
    statusName: row.status_name,
    statusColor: row.status_color,
    tagNames: row.tag_names ? row.tag_names.split('\u001f').filter(Boolean) : [],
    priority: row.priority as Priority,
    startDate: row.start_date,
    dueDate: row.due_date,
    childCount: Number(row.child_count ?? 0),
    doneChildCount: Number(row.done_child_count ?? 0),
    blockedByCount: Number(row.blocked_count ?? 0),
    updatedAt: row.updated_at,
    todayMarkDate: row.today_mark_date ?? null,
  };
}

/**
 * 一条 SQL 把显示需要的字段一次取齐。
 *
 * 子查询算子任务数/被阻塞数：单机单用户、几百到几千条任务的量级下完全够用，
 * 而写成多个 join + group by 会让"没有子任务的任务"因为 join 丢失 —— 那类
 * 静默少行的问题比慢一点难查得多。
 */
export const TASK_WITH_PROJECT_SELECT = `
  SELECT t.id, t.project_id, p.name AS project_name, t.parent_id, t.title,
         t.status_id, ws.category, ws.name AS status_name, ws.color AS status_color,
         t.priority, t.start_date, t.due_date,
         t.updated_at, t.today_mark_date,
         (SELECT GROUP_CONCAT(tg.name, CHAR(31)) FROM task_tags tt
            JOIN tags tg ON tg.id = tt.tag_id
           WHERE tt.task_id = t.id) AS tag_names,
         (SELECT COUNT(*) FROM tasks c WHERE c.parent_id = t.id AND c.deleted_at IS NULL) AS child_count,
         (SELECT COUNT(*) FROM tasks c
            LEFT JOIN workflow_statuses cw ON cw.id = c.status_id
           WHERE c.parent_id = t.id AND c.deleted_at IS NULL AND cw.category = 'done') AS done_child_count,
         (SELECT COUNT(*) FROM task_dependencies d
            JOIN tasks pre ON pre.id = d.predecessor_id
            LEFT JOIN workflow_statuses pw ON pw.id = pre.status_id
           WHERE d.successor_id = t.id AND pre.deleted_at IS NULL
             AND (pw.category IS NULL OR pw.category <> 'done')) AS blocked_count
    FROM tasks t
    JOIN projects p ON p.id = t.project_id
    LEFT JOIN workflow_statuses ws ON ws.id = t.status_id
   WHERE t.deleted_at IS NULL
     AND p.deleted_at IS NULL
     AND p.status <> 'archived'
`;

export function queryTasksAcrossProjects(
  ctx: ServiceContext,
  filter: TaskQueryFilter = {},
): CrossProjectResult {
  const where: string[] = [];
  const params: unknown[] = [];

  if (filter.withoutDue === true) {
    where.push('t.due_date IS NULL');
  } else {
    if (filter.dueFrom !== undefined) {
      where.push('t.due_date IS NOT NULL AND t.due_date >= ?');
      params.push(filter.dueFrom);
    }
    if (filter.dueTo !== undefined) {
      where.push('t.due_date IS NOT NULL AND t.due_date <= ?');
      params.push(filter.dueTo);
    }
  }
  if (filter.onlyOpen === true) {
    where.push("(ws.category IS NULL OR ws.category <> 'done')");
  }
  if (filter.projectIds && filter.projectIds.length > 0) {
    where.push(`t.project_id IN (${filter.projectIds.map(() => '?').join(', ')})`);
    params.push(...filter.projectIds);
  }

  const clause = where.length > 0 ? ` AND ${where.join(' AND ')}` : '';
  const limit = Math.min(Math.max(filter.limit ?? 500, 1), 2000);

  // 排序：有截止日的在前、按截止日升序；同一天的按优先级（urgent 在前）再按更新时间
  const order = `
    ORDER BY (t.due_date IS NULL), t.due_date ASC,
             CASE t.priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END,
             t.updated_at DESC
  `;

  const rows = ctx.sqlite
    .prepare(`${TASK_WITH_PROJECT_SELECT}${clause}${order} LIMIT ?`)
    .all(...params, limit) as unknown as TaskRow[];

  const total = Number(
    (
      ctx.sqlite
        .prepare(
          `SELECT COUNT(*) AS n FROM tasks t
             JOIN projects p ON p.id = t.project_id
             LEFT JOIN workflow_statuses ws ON ws.id = t.status_id
            WHERE t.deleted_at IS NULL AND p.deleted_at IS NULL AND p.status <> 'archived'${clause}`,
        )
        .get(...params) as { n: number } | undefined
    )?.n ?? 0,
  );

  return { items: rows.map(toTaskWithProject), total, statuses: statusesOfProjects(ctx, rows.map((row) => row.project_id)) };
}

/**
 * 若干项目各自的**完整状态表**（去重后的并集）。
 *
 * 为什么要带上：跨项目列表把不同项目的任务混在一屏，而"状态是每个项目自己定的"
 * （名字、颜色、可选项都不同）。渲染层如果拿当前项目的状态表去查别的项目，
 * 卡片上就会显示错的状态名 —— 宁可在响应里多几百字节，也不要一个会骗人的界面。
 */
export function statusesOfProjects(ctx: ServiceContext, projectIds: string[]): ProjectStatus[] {
  const ids = [...new Set(projectIds)];
  if (ids.length === 0) return [];

  const placeholders = ids.map(() => '?').join(', ');
  const statusRows = ctx.sqlite
    .prepare(
      `SELECT id, project_id, name, color, category, sort_order
         FROM workflow_statuses
        WHERE project_id IN (${placeholders})
        ORDER BY project_id, sort_order, name`,
    )
    .all(...ids) as unknown as Array<{
    id: string;
    project_id: string;
    name: string;
    color: string;
    category: string;
    sort_order: number;
  }>;

  return statusRows.map((row) => ({
    id: row.id,
    projectId: row.project_id,
    name: row.name,
    color: row.color,
    category: row.category as StatusCategory,
    sortOrder: Number(row.sort_order ?? 0),
  }));
}

/* ------------------------------------------------------------------ */
/* 全局搜索                                                            */
/* ------------------------------------------------------------------ */

export interface SearchHit {
  type: 'task' | 'ticket';
  id: string;
  projectId: string;
  projectName: string;
  title: string;
  /** 命中的上下文片段（正文里含关键词时才有） */
  snippet: string | null;
  statusId: string | null;
  statusCategory: StatusCategory | null;
  /** 状态名与颜色跟着结果一起回来（搜索结果同样是跨项目的） */
  statusName: string | null;
  statusColor: string | null;
  dueDate: number | null;
  updatedAt: number;
}

export interface SearchResult {
  items: SearchHit[];
  total: number;
  /** 实际走的检索方式：`fts` = 全文索引；`like` = 模糊匹配（查询词少于 3 个字符时） */
  mode: 'fts' | 'like';
  /** 结果里出现的每个项目的状态表（卡片上显示状态名、换状态都要用） */
  statuses: ProjectStatus[];
}

/** trigram 索引最少 3 个字符，短词只能靠 LIKE —— 中文里"登录"这种两字词极常见 */
export const FTS_MIN_LENGTH = 3;

function escapeLike(keyword: string): string {
  return keyword.replace(/[\\%_]/g, (char) => `\\${char}`);
}

function snippetOf(title: string, body: string | null, keyword: string): string | null {
  const text = (body ?? '').trim();
  if (text.length === 0) return null;
  const at = text.toLowerCase().indexOf(keyword.toLowerCase());
  if (at < 0) return null;
  const from = Math.max(0, at - 20);
  return `${from > 0 ? '…' : ''}${text.slice(from, at + keyword.length + 30)}…`;
}

interface SearchRow {
  doc_type: string;
  doc_id: string;
  project_id: string;
  project_name: string;
  title: string;
  body: string | null;
  status_id: string | null;
  status_name: string | null;
  status_color: string | null;
  category: string | null;
  due_date: number | null;
  updated_at: number;
  deleted_at: number | null;
}

export function searchAll(
  ctx: ServiceContext,
  input: { q: string; limit?: number },
): SearchResult {
  const keyword = input.q.trim();
  const limit = Math.min(Math.max(input.limit ?? 30, 1), 200);
  if (keyword.length === 0) return { items: [], total: 0, mode: 'like', statuses: [] };

  const useFts = keyword.length >= FTS_MIN_LENGTH;

  /*
   * 两种检索共用一个"取显示字段"的查询壳：
   * 结果必须**再次关联 tasks/tickets 与 projects** —— 索引里可能残留已软删除的文档，
   * 而"搜到一条打不开的结果"是最让人困惑的表现。项目被归档的也一并排除。
   */
  const shell = (sourceJoin: string, matchClause: string, orderClause: string) => `
    SELECT s.doc_type, s.doc_id, s.project_id, p.name AS project_name,
           s.title, s.body,
           COALESCE(t.status_id, tk.status_id) AS status_id,
           COALESCE(ws.name, tws.name) AS status_name,
           COALESCE(ws.color, tws.color) AS status_color,
           COALESCE(ws.category, tws.category) AS category,
           COALESCE(t.due_date, tk.due_date) AS due_date,
           COALESCE(t.updated_at, tk.updated_at) AS updated_at,
           COALESCE(t.deleted_at, tk.deleted_at) AS deleted_at
      FROM ${sourceJoin}
      JOIN projects p ON p.id = s.project_id
      LEFT JOIN tasks t ON s.doc_type = 'task' AND t.id = s.doc_id
      LEFT JOIN workflow_statuses ws ON ws.id = t.status_id
      LEFT JOIN tickets tk ON s.doc_type = 'ticket' AND tk.id = s.doc_id
      LEFT JOIN workflow_statuses tws ON tws.id = tk.status_id
     WHERE ${matchClause}
       AND p.deleted_at IS NULL AND p.status <> 'archived'
       AND COALESCE(t.deleted_at, tk.deleted_at) IS NULL
     ${orderClause}
     LIMIT ?
  `;

  let rows: SearchRow[];
  if (useFts) {
    // 短语查询：把关键词整体当一个片段（trigram 的语义就是"包含这个片段"）
    const phrase = `"${keyword.replace(/"/g, '""')}"`;
    rows = ctx.sqlite
      .prepare(
        shell(
          'search_index s',
          'search_index MATCH ?',
          'ORDER BY bm25(search_index), updated_at DESC',
        ),
      )
      .all(phrase, limit) as unknown as SearchRow[];

    // 极端情况下（例如索引还没建好/刚清过）FTS 可能空手而归，此时用 LIKE 兜底，
    // 宁可慢一点也不要"明明有却搜不到"
    if (rows.length === 0) {
      const like = `%${escapeLike(keyword)}%`;
      rows = ctx.sqlite
        .prepare(
          shell(
            'search_index s',
            "(s.title LIKE ? ESCAPE '\\' OR IFNULL(s.body, '') LIKE ? ESCAPE '\\')",
            'ORDER BY updated_at DESC',
          ),
        )
        .all(like, like, limit) as unknown as SearchRow[];
      if (rows.length > 0) {
        return {
          items: rows.map(toHit),
          total: rows.length,
          mode: 'like',
          statuses: statusesOfProjects(ctx, rows.map((row) => row.project_id)),
        };
      }
      return { items: [], total: 0, mode: 'fts', statuses: [] };
    }
  } else {
    const like = `%${escapeLike(keyword)}%`;
    rows = ctx.sqlite
      .prepare(
        shell(
          'search_index s',
          "(s.title LIKE ? ESCAPE '\\' OR IFNULL(s.body, '') LIKE ? ESCAPE '\\')",
          'ORDER BY updated_at DESC',
        ),
      )
      .all(like, like, limit) as unknown as SearchRow[];
  }

  return {
    items: rows.map(toHit),
    total: rows.length,
    mode: useFts ? 'fts' : 'like',
    statuses: statusesOfProjects(ctx, rows.map((row) => row.project_id)),
  };

  function toHit(row: SearchRow): SearchHit {
    return {
      type: row.doc_type === 'ticket' ? 'ticket' : 'task',
      id: row.doc_id,
      projectId: row.project_id,
      projectName: row.project_name,
      title: row.title,
      snippet: snippetOf(row.title, row.body, keyword),
      statusId: row.status_id,
      statusCategory: (row.category as StatusCategory | null) ?? null,
      statusName: row.status_name,
      statusColor: row.status_color,
      dueDate: row.due_date,
      updatedAt: row.updated_at,
    };
  }
}
