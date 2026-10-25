/**
 * 任务服务。
 *
 * 这是 M1 里逻辑最密的一块，三个地方值得单独说明：
 *
 * 1. **拖拽（`moveTask`）在一个事务里完成"改状态 + 重排序"**。
 *    让前端算 `sort_order` 必然出现顺序错乱 —— 并发拖拽、请求重试、
 *    乐观更新回滚都会踩。所以接口只接受"移到哪个状态、插到谁前面"。
 *
 * 2. **排序用中点插入，间隙耗尽才重排整列**。绝大多数拖拽只更新一行；
 *    只有相邻序号差 ≤ 1 时才把整列重排。对比"每次拖拽重写整列"，
 *    这是数量级的差别，也大幅降低了并发下的冲突面。
 *
 * 3. **删除默认不级联**。删一个父任务时，子任务**上提一级**而不是被一起删掉：
 *    数据丢失不可逆，而"误删了整枝子任务"是那种事后才发现的事故。
 *    确需整枝删除时显式传 `cascade: true`。
 */

import type {
  BatchTaskInput,
  CreateTaskInput,
  MoveTaskInput,
  Priority,
  StatusCategory,
  TaskListQuery,
  UpdateTaskInput,
} from '@pm-studio/shared';
import { AppError, REVIEW_STATUS_NAME } from '@pm-studio/shared';
import { and, asc, eq, inArray, isNull, like, or, sql, type SQL } from 'drizzle-orm';

import { taskTags, tasks, workflowStatuses, type Task } from '../db/schema.js';
import { diffChanges, recordActivity } from './activity.js';
import { inTransaction, type ServiceContext } from './context.js';
import { nextSortOrder, orderBetween, rebalancedOrders } from '../util/sort.js';
import { getDefaultStatus } from './workflow-statuses.js';
import { getProjectOrThrow } from './projects.js';

/* ------------------------------------------------------------------ */
/* 类型                                                                */
/* ------------------------------------------------------------------ */

export interface TaskDto {
  id: string;
  projectId: string;
  parentId: string | null;
  ticketId: string | null;
  title: string;
  description: string | null;
  statusId: string | null;
  statusCategory: StatusCategory | null;
  priority: Priority;
  assigneeId: string | null;
  startDate: number | null;
  dueDate: number | null;
  completedAt: number | null;
  sortOrder: number;
  tagIds: string[];
  /** 未删除的直接子任务数 */
  childCount: number;
  /** 其中已完成的数量（用于父任务进度展示） */
  doneChildCount: number;
  /** 未完成的前置任务数；> 0 表示被阻塞 */
  blockedByCount: number;
  createdAt: number;
  updatedAt: number;
  deletedAt: number | null;
  /**
   * 「今天做」的手动标记：日期键（本地 YYYY-MM-DD），没标记就是 null。
   *
   * 和 services/task-query.ts 的 `TaskWithProject` 是同一个语义 —— 两处都带上，
   * 免得界面在"项目内的任务"和"跨项目列表里的任务"上对同一条任务给出不同结论。
   */
  todayMarkDate: string | null;
}

export interface TaskTreeNode extends TaskDto {
  children: TaskTreeNode[];
}

interface Decoration {
  tagIds: string[];
  childCount: number;
  doneChildCount: number;
  blockedByCount: number;
}

const EMPTY_DECORATION: Decoration = {
  tagIds: [],
  childCount: 0,
  doneChildCount: 0,
  blockedByCount: 0,
};

const UPDATABLE_FIELDS = [
  'parentId',
  'ticketId',
  'title',
  'description',
  'statusId',
  'priority',
  'assigneeId',
  'startDate',
  'dueDate',
] as const;

/* ------------------------------------------------------------------ */
/* 装饰数据（标签、子任务计数、阻塞计数）                                */
/* ------------------------------------------------------------------ */

/**
 * 按**项目**批量加载装饰数据。
 *
 * 刻意按 project_id 关联而不是用 `IN (大量 id)`：一个项目可能有几千个任务，
 * 拼出几千个占位符会撞上 SQLite 的参数数量上限。项目维度天然避开了这个问题。
 * 计数也不受列表筛选影响 —— 子任务数应该反映项目全貌，而不是当前筛选结果。
 */
function loadProjectDecorations(
  ctx: ServiceContext,
  projectId: string,
): Map<string, Decoration> {
  const map = new Map<string, Decoration>();

  const tagRows = ctx.sqlite
    .prepare(
      `SELECT tt.task_id AS tid, tt.tag_id AS tag
       FROM task_tags tt
       JOIN tasks t ON t.id = tt.task_id
       WHERE t.project_id = ?`,
    )
    .all(projectId) as Array<{ tid: string; tag: string }>;

  for (const row of tagRows) {
    const d = map.get(row.tid) ?? { ...EMPTY_DECORATION, tagIds: [] };
    d.tagIds.push(row.tag);
    map.set(row.tid, d);
  }

  const childRows = ctx.sqlite
    .prepare(
      `SELECT t.parent_id AS pid,
              COUNT(*) AS total,
              SUM(CASE WHEN ws.category = 'done' THEN 1 ELSE 0 END) AS done
       FROM tasks t
       LEFT JOIN workflow_statuses ws ON ws.id = t.status_id
       WHERE t.project_id = ? AND t.parent_id IS NOT NULL AND t.deleted_at IS NULL
       GROUP BY t.parent_id`,
    )
    .all(projectId) as Array<{ pid: string; total: number; done: number | null }>;

  for (const row of childRows) {
    const d = map.get(row.pid) ?? { ...EMPTY_DECORATION, tagIds: [] };
    d.childCount = Number(row.total);
    d.doneChildCount = Number(row.done ?? 0);
    map.set(row.pid, d);
  }

  // 「被阻塞」= 存在未完成的前置任务。完成判定看 category 而不是状态名，
  // 这样用户把"已完成"改名成"上线"也不会破坏这个判断。
  const blockedRows = ctx.sqlite
    .prepare(
      `SELECT d.successor_id AS sid, COUNT(*) AS n
       FROM task_dependencies d
       JOIN tasks p ON p.id = d.predecessor_id
       LEFT JOIN workflow_statuses ws ON ws.id = p.status_id
       WHERE p.project_id = ?
         AND p.deleted_at IS NULL
         AND (ws.category IS NULL OR ws.category <> 'done')
       GROUP BY d.successor_id`,
    )
    .all(projectId) as Array<{ sid: string; n: number }>;

  for (const row of blockedRows) {
    const d = map.get(row.sid) ?? { ...EMPTY_DECORATION, tagIds: [] };
    d.blockedByCount = Number(row.n);
    map.set(row.sid, d);
  }

  return map;
}

function toDto(
  row: Task,
  decoration: Decoration | undefined,
  statusCategory: StatusCategory | null,
): TaskDto {
  const d = decoration ?? EMPTY_DECORATION;
  return {
    id: row.id,
    projectId: row.projectId,
    parentId: row.parentId,
    ticketId: row.ticketId,
    title: row.title,
    description: row.description,
    statusId: row.statusId,
    statusCategory,
    priority: row.priority as Priority,
    assigneeId: row.assigneeId,
    startDate: row.startDate,
    dueDate: row.dueDate,
    completedAt: row.completedAt,
    sortOrder: row.sortOrder,
    tagIds: d.tagIds,
    childCount: d.childCount,
    doneChildCount: d.doneChildCount,
    blockedByCount: d.blockedByCount,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    deletedAt: row.deletedAt,
    todayMarkDate: row.todayMarkDate,
  };
}

function loadStatusCategories(ctx: ServiceContext, projectId: string): Map<string, StatusCategory> {
  const rows = ctx.db
    .select({ id: workflowStatuses.id, category: workflowStatuses.category })
    .from(workflowStatuses)
    .where(eq(workflowStatuses.projectId, projectId))
    .all();
  return new Map(rows.map((r) => [r.id, r.category as StatusCategory]));
}

/** 项目里"已完成"分类的状态（按排序取第一个），没有就返回 null */
function pickDoneStatusId(ctx: ServiceContext, projectId: string): string | null {
  const row = ctx.db
    .select({ id: workflowStatuses.id })
    .from(workflowStatuses)
    .where(and(eq(workflowStatuses.projectId, projectId), eq(workflowStatuses.category, 'done')))
    .orderBy(asc(workflowStatuses.sortOrder))
    .get();
  return row?.id ?? null;
}

/** 某个任务的**未删除**直接子任务，是否全部处于"已完成"分类 */
function allChildrenDone(
  ctx: ServiceContext,
  parentId: string,
  categories: Map<string, StatusCategory>,
): boolean {
  const children = ctx.db
    .select({ statusId: tasks.statusId })
    .from(tasks)
    .where(and(eq(tasks.parentId, parentId), isNull(tasks.deletedAt)))
    .all();

  if (children.length === 0) return false;
  return children.every((c) => c.statusId !== null && categories.get(c.statusId) === 'done');
}

/**
 * 子任务全部完成 → 把父任务也标为已完成，并**继续向上递归**。
 *
 * 调用时机是刻意收窄的：**只在"某个任务刚刚变成已完成"之后调用**。
 * 反例（都不该触发）：删掉最后一个未完成子任务、把子任务移走、父任务本来就已完成 ——
 * 那些情况下父任务"自己完成"会让用户怀疑数据被改。
 *
 * 三条约定的理由：
 * 1. 父任务已完成就停：不然每完成一个子任务都会重写一遍父任务的完成时间。
 * 2. 用项目里 `done` 分类的第一个状态，而不是写死某个 id：状态是用户可以改名/增删的。
 * 3. 递归向上：祖父任务可能因此也满足条件（"一枝做完了"）。
 *
 * 返回被顺带改动的祖先 id（由内到外），供调用方记日志与前端做提示。
 */
export function autoCompleteAncestors(
  ctx: ServiceContext,
  taskId: string,
  now: number = ctx.now(),
): string[] {
  const completed: string[] = [];
  let currentId = taskId;

  // 深度上限纯属防御：数据正常时树深有限，真出现环也不会把服务卡死
  for (let depth = 0; depth < 50; depth += 1) {
    const current = findTask(ctx, currentId);
    if (!current || current.parentId === null) break;

    const parent = findTask(ctx, current.parentId);
    if (!parent || parent.deletedAt !== null) break;

    const categories = loadStatusCategories(ctx, parent.projectId);
    if (parent.statusId !== null && categories.get(parent.statusId) === 'done') break;
    if (!allChildrenDone(ctx, parent.id, categories)) break;

    const doneStatusId = pickDoneStatusId(ctx, parent.projectId);
    if (doneStatusId === null) break;

    ctx.db
      .update(tasks)
      .set({
        statusId: doneStatusId,
        completedAt: resolveCompletedAt('done', parent.completedAt, now),
        updatedAt: now,
      })
      .where(eq(tasks.id, parent.id))
      .run();

    recordActivity(ctx, {
      entityType: 'task',
      entityId: parent.id,
      action: 'update',
      projectId: parent.projectId,
      changes: { statusId: [parent.statusId, doneStatusId], autoCompletedByChildren: [null, true] },
    });

    completed.push(parent.id);
    currentId = parent.id;
  }

  return completed;
}

/* ------------------------------------------------------------------ */
/* 查询                                                                */
/* ------------------------------------------------------------------ */

export function findTask(ctx: ServiceContext, id: string): Task | undefined {
  return ctx.db.select().from(tasks).where(eq(tasks.id, id)).get();
}

export function getTaskOrThrow(ctx: ServiceContext, id: string): Task {
  const row = findTask(ctx, id);
  if (!row || row.deletedAt !== null) {
    throw new AppError('NOT_FOUND', '任务不存在', { details: { id } });
  }
  return row;
}

export interface ListTasksResult {
  items: TaskDto[];
  total: number;
  page: number;
  pageSize: number;
}

/** `?tagIds=a,b` 与重复参数两种写法都归一成数组 */
function normalizeTagIds(raw: string | string[] | undefined): string[] {
  if (!raw) return [];
  const list = Array.isArray(raw) ? raw : raw.split(',');
  return list.map((v) => v.trim()).filter(Boolean);
}

export function listTasks(
  ctx: ServiceContext,
  projectId: string,
  query: TaskListQuery = {},
): ListTasksResult {
  const conditions: SQL[] = [eq(tasks.projectId, projectId)];
  if (query.includeDeleted !== true) conditions.push(isNull(tasks.deletedAt));
  if (query.statusId) conditions.push(eq(tasks.statusId, query.statusId));
  if (query.parentId) conditions.push(eq(tasks.parentId, query.parentId));
  if (query.priority) conditions.push(eq(tasks.priority, query.priority));
  if (query.dueBefore !== undefined) {
    conditions.push(sql`${tasks.dueDate} IS NOT NULL AND ${tasks.dueDate} <= ${query.dueBefore}`);
  }
  if (query.q) {
    const pattern = `%${query.q}%`;
    conditions.push(
      or(like(tasks.title, pattern), like(tasks.description, pattern)) as SQL,
    );
  }

  const where = and(...conditions);

  let rows = ctx.db
    .select()
    .from(tasks)
    .where(where)
    .orderBy(asc(tasks.sortOrder), asc(tasks.createdAt))
    .all();

  // 标签筛选在内存里做：SQLite 的参数上限比"几千个 id 拼 IN"更早出问题，
  // 而这个过滤是集合交集，内存里做既简单又不会错
  const tagIds = normalizeTagIds(query.tagIds);
  if (tagIds.length > 0) {
    const wanted = new Set(tagIds);
    const links = ctx.sqlite
      .prepare(
        `SELECT task_id AS tid, tag_id AS tag FROM task_tags WHERE task_id IN (
           SELECT id FROM tasks WHERE project_id = ?
         )`,
      )
      .all(projectId) as Array<{ tid: string; tag: string }>;

    const byTask = new Map<string, Set<string>>();
    for (const link of links) {
      const set = byTask.get(link.tid) ?? new Set<string>();
      set.add(link.tag);
      byTask.set(link.tid, set);
    }

    rows = rows.filter((row) => {
      const tags = byTask.get(row.id);
      if (!tags) return false;
      for (const tag of wanted) if (tags.has(tag)) return true;
      return false;
    });
  }

  const total = rows.length;
  const page = query.page ?? 1;
  const pageSize = query.pageSize ?? (query.view === 'tree' ? 5000 : 200);
  const start = (page - 1) * pageSize;
  const paged = query.view === 'tree' ? rows : rows.slice(start, start + pageSize);

  const categories = loadStatusCategories(ctx, projectId);
  const decorations = loadProjectDecorations(ctx, projectId);

  return {
    items: paged.map((row) => toDto(row, decorations.get(row.id), categories.get(row.statusId ?? '') ?? null)),
    total,
    page,
    pageSize,
  };
}

export interface TaskDetail extends TaskDto {
  predecessors: Array<{ id: string; taskId: string; title: string; done: boolean }>;
  successors: Array<{ id: string; taskId: string; title: string; done: boolean }>;
  children: TaskDto[];
  parent: { id: string; title: string } | null;
}

export function getTaskDetail(ctx: ServiceContext, id: string): TaskDetail {
  const row = getTaskOrThrow(ctx, id);
  const categories = loadStatusCategories(ctx, row.projectId);
  const decorations = loadProjectDecorations(ctx, row.projectId);

  const depRows = ctx.sqlite
    .prepare(
      `SELECT d.id, d.predecessor_id, d.successor_id, d.type,
              p.title AS predecessor_title, ws.category AS predecessor_category,
              s.title AS successor_title, ws2.category AS successor_category
       FROM task_dependencies d
       JOIN tasks p ON p.id = d.predecessor_id
       JOIN tasks s ON s.id = d.successor_id
       LEFT JOIN workflow_statuses ws ON ws.id = p.status_id
       LEFT JOIN workflow_statuses ws2 ON ws2.id = s.status_id
       WHERE d.predecessor_id = ? OR d.successor_id = ?`,
    )
    .all(id, id) as Array<{
    id: string;
    predecessor_id: string;
    successor_id: string;
    predecessor_title: string;
    predecessor_category: string | null;
    successor_title: string;
    successor_category: string | null;
  }>;

  const children = ctx.db
    .select()
    .from(tasks)
    .where(and(eq(tasks.parentId, id), isNull(tasks.deletedAt)))
    .orderBy(asc(tasks.sortOrder))
    .all();

  const parent = row.parentId
    ? ctx.db
        .select({ id: tasks.id, title: tasks.title })
        .from(tasks)
        .where(eq(tasks.id, row.parentId))
        .get()
    : null;

  return {
    ...toDto(row, decorations.get(row.id), categories.get(row.statusId ?? '') ?? null),
    predecessors: depRows
      .filter((d) => d.successor_id === id)
      .map((d) => ({
        id: d.id,
        taskId: d.predecessor_id,
        title: d.predecessor_title,
        done: d.predecessor_category === 'done',
      })),
    successors: depRows
      .filter((d) => d.predecessor_id === id)
      .map((d) => ({
        id: d.id,
        taskId: d.successor_id,
        title: d.successor_title,
        done: d.successor_category === 'done',
      })),
    children: children.map((c) =>
      toDto(c, decorations.get(c.id), categories.get(c.statusId ?? '') ?? null),
    ),
    parent: parent ?? null,
  };
}

/**
 * 把扁平任务列表拼成树。
 *
 * 父任务不在当前集合里的（被筛选掉了）按根节点处理，而不是丢弃 ——
 * 否则筛选一下任务就"消失"了，用户会以为数据没了。
 */
export function buildTaskTree(items: TaskDto[]): TaskTreeNode[] {
  const nodes = new Map<string, TaskTreeNode>();
  for (const item of items) nodes.set(item.id, { ...item, children: [] });

  const roots: TaskTreeNode[] = [];
  for (const item of items) {
    const node = nodes.get(item.id) as TaskTreeNode;
    const parent = item.parentId ? nodes.get(item.parentId) : undefined;
    if (parent) parent.children.push(node);
    else roots.push(node);
  }

  return roots;
}

export function getTaskTree(
  ctx: ServiceContext,
  projectId: string,
  query: TaskListQuery = {},
): TaskTreeNode[] {
  const result = listTasks(ctx, projectId, { ...query, view: 'tree' });
  return buildTaskTree(result.items);
}

/* ------------------------------------------------------------------ */
/* 看板                                                                */
/* ------------------------------------------------------------------ */

export interface BoardColumn {
  statusId: string;
  name: string;
  color: string;
  category: StatusCategory;
  sortOrder: number;
  isDefault: boolean;
  taskCount: number;
  tasks: TaskDto[];
}

export interface BoardResult {
  projectId: string;
  columns: BoardColumn[];
  /** status_id 为空的任务（数据异常兜底，不应出现但必须有地方可放） */
  unassigned: TaskDto[];
  total: number;
}

/**
 * 反方向：**给"已完成"的主任务新增一个没做完的子任务时，把父任务重新打开**。
 *
 * 为什么必须有这一条：只有"全完成 → 父完成"的话，
 * 一旦主任务被自动完成，之后再加一个未完成子任务，父任务会一直停在"已完成"——
 * 看板就在说谎（已完成的任务底下挂着没做完的子任务）。
 *
 * 打开到哪：项目的**默认状态**（通常是"待处理"），而不是某个写死的 id。
 * 递归向上：祖父任务可能也是因为"这一枝做完了"才完成的，现在这一枝又有活了。
 */
export function reopenAncestorsForNewChild(
  ctx: ServiceContext,
  parentId: string,
  now: number = ctx.now(),
): string[] {
  const reopened: string[] = [];
  let currentId: string | null = parentId;

  for (let depth = 0; depth < 50 && currentId; depth += 1) {
    const current: Task | undefined = findTask(ctx, currentId);
    if (!current || current.deletedAt !== null) break;

    const categories = loadStatusCategories(ctx, current.projectId);
    // 还没完成就不用管
    if (current.statusId === null || categories.get(current.statusId) !== 'done') break;

    const fallbackId = ctx.db
      .select({ id: workflowStatuses.id })
      .from(workflowStatuses)
      .where(and(eq(workflowStatuses.projectId, current.projectId), eq(workflowStatuses.isDefault, 1)))
      .get()?.id;
    if (!fallbackId) break;

    ctx.db
      .update(tasks)
      .set({
        statusId: fallbackId,
        // 重新打开了，完成时间要清掉（否则"已完成时间"比状态还新，看着矛盾）
        completedAt: null,
        updatedAt: now,
      })
      .where(eq(tasks.id, current.id))
      .run();

    recordActivity(ctx, {
      entityType: 'task',
      entityId: current.id,
      action: 'update',
      projectId: current.projectId,
      changes: { statusId: [current.statusId, fallbackId], reopenedByNewChild: [null, true] },
    });

    reopened.push(current.id);
    currentId = current.parentId;
  }

  return reopened;
}

/**
 * 列内排序：把同一列里的子任务**吸附到它的父任务下方**。
 *
 * 看板的"主次"只能在同一列里用位置表达 —— 父任务在「待处理」、子任务在「进行中」时，
 * 它们根本不在同一列，谁也贴不到谁下面（那种情况由界面用「↳ 父任务名」的引用表达）。
 * 所以这里只处理"同一列内的祖孙"：
 *
 * 1. 以**本列里最靠上的那个祖先**为一组（组内是完整的一枝）；
 * 2. 组间按"枝根在本列原本的位置"排 —— 用户拖出来的相对次序不会被这一步打乱；
 * 3. 组内按层级、再按原本的次序排。
 *
 * 排序在服务端做而不是渲染层做，是因为**拖拽用的就是这份顺序**：
 * 如果只是"渲染时看起来分了组"，拖拽时前后邻居算的是另一套顺序，
 * 落点就会与看到的位置不一致。
 */
export function groupColumnTasks(tasksInColumn: TaskDto[]): TaskDto[] {
  const byId = new Map(tasksInColumn.map((task) => [task.id, task]));
  const originalIndex = new Map(tasksInColumn.map((task, index) => [task.id, index]));

  /** 本列里最靠上的祖先（不在本列的父任务不算） */
  const columnRootOf = (task: TaskDto): string => {
    let current = task;
    for (let guard = 0; guard < 50 && current.parentId && byId.has(current.parentId); guard += 1) {
      current = byId.get(current.parentId) as TaskDto;
    }
    return current.id;
  };

  /** 同列层级：0 = 这一枝在本列里的最高点 */
  const depthOf = (task: TaskDto): number => {
    let depth = 0;
    let current = task;
    for (let guard = 0; guard < 50 && current.parentId && byId.has(current.parentId); guard += 1) {
      current = byId.get(current.parentId) as TaskDto;
      depth += 1;
    }
    return depth;
  };

  return [...tasksInColumn].sort((a, b) => {
    const rootA = columnRootOf(a);
    const rootB = columnRootOf(b);
    if (rootA !== rootB) {
      return (originalIndex.get(rootA) ?? 0) - (originalIndex.get(rootB) ?? 0);
    }
    const depthA = depthOf(a);
    const depthB = depthOf(b);
    if (depthA !== depthB) return depthA - depthB;
    return (originalIndex.get(a.id) ?? 0) - (originalIndex.get(b.id) ?? 0);
  });
}

export function getBoard(ctx: ServiceContext, projectId: string): BoardResult {
  const statuses = ctx.db
    .select()
    .from(workflowStatuses)
    .where(eq(workflowStatuses.projectId, projectId))
    .orderBy(asc(workflowStatuses.sortOrder))
    .all();

  const rows = ctx.db
    .select()
    .from(tasks)
    .where(and(eq(tasks.projectId, projectId), isNull(tasks.deletedAt)))
    .orderBy(asc(tasks.sortOrder), asc(tasks.createdAt))
    .all();

  const categories = loadStatusCategories(ctx, projectId);
  const decorations = loadProjectDecorations(ctx, projectId);

  const byStatus = new Map<string, TaskDto[]>();
  const unassigned: TaskDto[] = [];

  for (const row of rows) {
    const dto = toDto(row, decorations.get(row.id), categories.get(row.statusId ?? '') ?? null);
    if (row.statusId === null) unassigned.push(dto);
    else {
      const list = byStatus.get(row.statusId) ?? [];
      list.push(dto);
      byStatus.set(row.statusId, list);
    }
  }

  return {
    projectId,
    columns: statuses.map((s) => {
      // 列内把子任务吸附到父任务下方（同一列里才谈得上"上下"）
      const columnTasks = groupColumnTasks(byStatus.get(s.id) ?? []);
      return {
        statusId: s.id,
        name: s.name,
        color: s.color,
        category: s.category as StatusCategory,
        sortOrder: s.sortOrder,
        isDefault: s.isDefault === 1,
        taskCount: columnTasks.length,
        tasks: columnTasks,
      };
    }),
    unassigned,
    total: rows.length,
  };
}

/* ------------------------------------------------------------------ */
/* 子树工具                                                            */
/* ------------------------------------------------------------------ */

/** 收集以 rootId 为根的整棵子树（含自身），迭代式 BFS */
export function collectSubtreeIds(ctx: ServiceContext, rootId: string): string[] {
  const result: string[] = [rootId];
  const queue: string[] = [rootId];
  const childStmt = ctx.sqlite.prepare('SELECT id FROM tasks WHERE parent_id = ?');

  while (queue.length > 0) {
    const current = queue.shift() as string;
    const children = childStmt.all(current) as Array<{ id: string }>;
    for (const child of children) {
      if (result.includes(child.id)) continue;
      result.push(child.id);
      queue.push(child.id);
    }
  }

  return result;
}

/** candidate 是否是 ancestor 的后代（用于阻止把任务挂到自己的子孙下面） */
export function isDescendant(
  ctx: ServiceContext,
  ancestorId: string,
  candidateId: string,
): boolean {
  if (ancestorId === candidateId) return true;
  return collectSubtreeIds(ctx, ancestorId).includes(candidateId);
}

/* ------------------------------------------------------------------ */
/* 写入                                                                */
/* ------------------------------------------------------------------ */

/** 状态变化时维护 completed_at：进入 done 记时间，离开则清空 */
function resolveCompletedAt(
  category: StatusCategory | null,
  previous: number | null,
  now: number,
): number | null {
  if (category === 'done') return previous ?? now;
  return null;
}

function nextOrderInColumn(
  ctx: ServiceContext,
  projectId: string,
  statusId: string | null,
): number {
  const row = ctx.sqlite
    .prepare(
      `SELECT MAX(sort_order) AS max FROM tasks
       WHERE project_id = ? AND deleted_at IS NULL
         AND ${statusId === null ? 'status_id IS NULL' : 'status_id = ?'}`,
    )
    .get(...(statusId === null ? [projectId] : [projectId, statusId])) as
    | { max: number | null }
    | undefined;
  return nextSortOrder(row?.max ?? null);
}

function setTaskTags(ctx: ServiceContext, taskId: string, tagIds: string[]): void {
  ctx.db.delete(taskTags).where(eq(taskTags.taskId, taskId)).run();
  const unique = [...new Set(tagIds)];
  for (const tagId of unique) {
    ctx.db.insert(taskTags).values({ taskId, tagId }).run();
  }
}

export function createTask(ctx: ServiceContext, input: CreateTaskInput): TaskDto {
  return inTransaction(ctx, () => {
    // 复用项目服务的存在性校验：它会一并排除已删除的项目
    getProjectOrThrow(ctx, input.projectId);

    const defaultStatus = getDefaultStatus(ctx, input.projectId);
    if (!defaultStatus && !input.statusId) {
      throw new AppError('CONFLICT', '该项目还没有工作流状态，无法新建任务', {
        details: { projectId: input.projectId },
      });
    }

    const statusId = input.statusId ?? defaultStatus?.id ?? null;

    if (input.parentId) {
      const parent = getTaskOrThrow(ctx, input.parentId);
      if (parent.projectId !== input.projectId) {
        throw new AppError('VALIDATION_FAILED', '父任务与子任务必须属于同一项目');
      }
    }

    const now = ctx.now();
    const id = ctx.newId();

    ctx.db
      .insert(tasks)
      .values({
        id,
        ownerId: ctx.actorId,
        projectId: input.projectId,
        parentId: input.parentId ?? null,
        ticketId: input.ticketId ?? null,
        title: input.title,
        description: input.description ?? null,
        statusId,
        priority: input.priority ?? 'medium',
        assigneeId: input.assigneeId ?? null,
        startDate: input.startDate ?? null,
        dueDate: input.dueDate ?? null,
        completedAt: null,
            sortOrder: nextOrderInColumn(ctx, input.projectId, statusId),
        createdAt: now,
        updatedAt: now,
        deletedAt: null,
      })
      .run();

    if (input.tagIds && input.tagIds.length > 0) setTaskTags(ctx, id, input.tagIds);

    recordActivity(ctx, {
      entityType: 'task',
      entityId: id,
      action: 'create',
      projectId: input.projectId,
    });

    // 新建的就是"已完成"的子任务（少见但合法）→ 父任务可能因此也完成了
    const createdCategory = statusId ? loadStatusCategories(ctx, input.projectId).get(statusId) : null;
    if (createdCategory === 'done') {
      autoCompleteAncestors(ctx, id, now);
    } else if (input.parentId) {
      // 反方向：给已完成的主任务加了个没做完的子任务 → 把父任务重新打开
      reopenAncestorsForNewChild(ctx, input.parentId, now);
    }

    return getTaskDetail(ctx, id);
  });
}

export function updateTask(ctx: ServiceContext, id: string, patch: UpdateTaskInput): TaskDto {
  const before = getTaskOrThrow(ctx, id);

  return inTransaction(ctx, () => {
    const now = ctx.now();
    const categories = loadStatusCategories(ctx, before.projectId);

    if (patch.parentId !== undefined && patch.parentId !== null) {
      if (patch.parentId === id) {
        throw new AppError('VALIDATION_FAILED', '任务不能把自己设为父任务');
      }
      const parent = getTaskOrThrow(ctx, patch.parentId);
      if (parent.projectId !== before.projectId) {
        throw new AppError('VALIDATION_FAILED', '父任务必须属于同一项目');
      }
      // 把任务挂到自己的子孙下面会切断这棵子树，形成"悬空环"
      if (isDescendant(ctx, id, patch.parentId)) {
        throw new AppError('VALIDATION_FAILED', '不能把任务移动到它自己的子任务下面');
      }
    }

    if (patch.statusId !== undefined && patch.statusId !== null) {
      const status = ctx.db
        .select()
        .from(workflowStatuses)
        .where(eq(workflowStatuses.id, patch.statusId))
        .get();
      if (!status || status.projectId !== before.projectId) {
        throw new AppError('VALIDATION_FAILED', '状态不属于该项目', {
          details: { statusId: patch.statusId },
        });
      }
    }

    const nextStatusId = patch.statusId === undefined ? before.statusId : patch.statusId;
    const nextCategory = nextStatusId ? (categories.get(nextStatusId) ?? null) : null;

    const changes = diffChanges(
      before as unknown as Record<string, unknown>,
      patch as Record<string, unknown>,
      UPDATABLE_FIELDS,
    );

    const tagChangeRequested = patch.tagIds !== undefined;
    if (!changes && !tagChangeRequested) return getTaskDetail(ctx, id);

    ctx.db
      .update(tasks)
      .set({
        ...(patch.parentId !== undefined ? { parentId: patch.parentId ?? null } : {}),
        ...(patch.ticketId !== undefined ? { ticketId: patch.ticketId ?? null } : {}),
        ...(patch.title !== undefined ? { title: patch.title } : {}),
        ...(patch.description !== undefined ? { description: patch.description ?? null } : {}),
        ...(patch.statusId !== undefined ? { statusId: patch.statusId ?? null } : {}),
        ...(patch.priority !== undefined ? { priority: patch.priority } : {}),
        ...(patch.assigneeId !== undefined ? { assigneeId: patch.assigneeId ?? null } : {}),
        ...(patch.startDate !== undefined ? { startDate: patch.startDate ?? null } : {}),
        ...(patch.dueDate !== undefined ? { dueDate: patch.dueDate ?? null } : {}),
          completedAt: resolveCompletedAt(nextCategory, before.completedAt, now),
        updatedAt: now,
      })
      .where(eq(tasks.id, id))
      .run();

    if (tagChangeRequested) setTaskTags(ctx, id, patch.tagIds ?? []);

    recordActivity(ctx, {
      entityType: 'task',
      entityId: id,
      action: 'update',
      projectId: before.projectId,
      // 只改标签时字段级 diff 为空，用标签变更作为记录内容
      changes: changes ?? { tagIds: [null, patch.tagIds ?? null] },
    });

    // 刚刚变成"已完成" → 顺手检查父任务是否也该完成
    if (nextCategory === 'done') autoCompleteAncestors(ctx, id, now);

    return getTaskDetail(ctx, id);
  });
}

/**
 * 看板拖拽的唯一入口。
 *
 * 只接受"移到哪个状态、插到谁前面/后面"，排序由服务端在**一个事务内**完成。
 * 间隙不足时重排整列 —— 这时才写多行，平时只更新被拖的那一行。
 */
export function moveTask(ctx: ServiceContext, id: string, input: MoveTaskInput): TaskDto {
  const task = getTaskOrThrow(ctx, id);

  return inTransaction(ctx, () => {
    const target = ctx.db
      .select()
      .from(workflowStatuses)
      .where(eq(workflowStatuses.id, input.statusId))
      .get();

    if (!target || target.projectId !== task.projectId) {
      throw new AppError('VALIDATION_FAILED', '目标状态不属于该项目', {
        details: { statusId: input.statusId },
      });
    }

    // 目标列中除自己以外的任务，已按 sort_order 排好
    const column = ctx.db
      .select()
      .from(tasks)
      .where(
        and(
          eq(tasks.projectId, task.projectId),
          eq(tasks.statusId, input.statusId),
          isNull(tasks.deletedAt),
          sql`${tasks.id} <> ${id}`,
        ),
      )
      .orderBy(asc(tasks.sortOrder), asc(tasks.createdAt))
      .all();

    const indexOf = (taskId: string | null | undefined): number => {
      if (!taskId) return -1;
      const index = column.findIndex((t) => t.id === taskId);
      if (index < 0) {
        throw new AppError('VALIDATION_FAILED', '参照任务不在目标状态列中', {
          details: { taskId },
        });
      }
      return index;
    };

    let insertIndex: number;
    if (input.beforeTaskId) insertIndex = indexOf(input.beforeTaskId);
    else if (input.afterTaskId) insertIndex = indexOf(input.afterTaskId) + 1;
    else insertIndex = column.length; // 拖到空白处 = 追加到末尾

    const prev = insertIndex > 0 ? column[insertIndex - 1]?.sortOrder : undefined;
    const next = insertIndex < column.length ? column[insertIndex]?.sortOrder : undefined;

    const now = ctx.now();
    const categories = loadStatusCategories(ctx, task.projectId);
    const completedAt = resolveCompletedAt(
      categories.get(input.statusId) ?? null,
      task.completedAt,
      now,
    );

    const computed = orderBetween(prev, next);

    if (computed === null) {
      // 间隙耗尽 → 重排整列。把被拖的任务插入到目标位置后统一重新编号。
      const orderedIds = [
        ...column.slice(0, insertIndex).map((t) => t.id),
        id,
        ...column.slice(insertIndex).map((t) => t.id),
      ];
      const orders = rebalancedOrders(orderedIds.length);

      orderedIds.forEach((taskId, index) => {
        ctx.db
          .update(tasks)
          .set({ sortOrder: orders[index] as number, updatedAt: now })
          .where(eq(tasks.id, taskId))
          .run();
      });

      ctx.db
        .update(tasks)
        .set({ statusId: input.statusId, completedAt, updatedAt: now })
        .where(eq(tasks.id, id))
        .run();
    } else {
      ctx.db
        .update(tasks)
        .set({ statusId: input.statusId, sortOrder: computed, completedAt, updatedAt: now })
        .where(eq(tasks.id, id))
        .run();
    }

    recordActivity(ctx, {
      entityType: 'task',
      entityId: id,
      action: 'move',
      projectId: task.projectId,
      changes: {
        statusId: [task.statusId, input.statusId],
        rebalanced: [null, computed === null],
      },
    });

    // 拖到"已完成"列时，同样检查父任务（拖拽是最常用的完成方式，别漏了这条路径）
    if (categories.get(input.statusId) === 'done') autoCompleteAncestors(ctx, id, now);

    return getTaskDetail(ctx, id);
  });
}

/**
 * 直接子任务的数量（只算未删除的）。
 *
 * 判定"能不能删除"用的就是它：子任务进了回收站就不再构成阻挡，
 * 否则会出现"子任务永远删不掉、主任务因此永远删不掉"的死锁。
 */
export function countActiveChildren(ctx: ServiceContext, id: string): number {
  const row = ctx.db
    .select({ total: sql<number>`count(*)` })
    .from(tasks)
    .where(and(eq(tasks.parentId, id), isNull(tasks.deletedAt)))
    .get();

  return Number(row?.total ?? 0);
}

/**
 * 提交审核：把任务推进到项目工作流里的「待审查」状态（用户 2026-10-02）。
 *
 * 为什么做成服务而不是让界面自己找状态再 patch：
 * "提交审核该落到哪个状态"是**流程约定**，不是界面的自由选择。放在这里，
 * 状态找不到时能给出可操作的报错（"这个项目没有「待审查」状态"），
 * 而不是界面传一个猜出来的 statusId 让服务端 404。
 *
 * 幂等：已经在该状态时直接返回详情，不重复写库（也不会莫名刷新 updatedAt）。
 */
export function submitForReview(ctx: ServiceContext, id: string): TaskDto {
  const task = getTaskOrThrow(ctx, id);

  const target = ctx.db
    .select()
    .from(workflowStatuses)
    .where(
      and(
        eq(workflowStatuses.projectId, task.projectId),
        eq(workflowStatuses.name, REVIEW_STATUS_NAME),
      ),
    )
    .get();

  if (!target) {
    throw new AppError(
      'VALIDATION_FAILED',
      `这个项目的工作流里没有「${REVIEW_STATUS_NAME}」状态，无法提交审核。请先在项目的工作流里补上该状态。`,
      { details: { projectId: task.projectId, expectedStatus: REVIEW_STATUS_NAME } },
    );
  }
  if (task.statusId === target.id) return getTaskDetail(ctx, id);

  ctx.logger.info('任务已提交审核', { taskId: id, statusId: target.id });
  return updateTask(ctx, id, { statusId: target.id });
}

/**
 * 删除任务（软删除）。
 *
 * **有子任务就不允许删除**（默认路径）：以前这里是把子任务"上提一级"，
 * 但那样用户看到的结果仍是"主任务没了、子任务散落到顶层" —— 层级关系在一次删除里
 * 被悄悄改写了，而用户以为自己只是删了一个任务。现在改为直接拒绝，并把子任务数量
 * 告诉用户，让删除者先自己处理子任务。
 *
 * **拒绝必须放在服务端**：界面上的拦截只是为了"把话说清楚"，
 * 真正拦住的是这里 —— 否则批量接口、旧版界面、脚本调用都能绕过去。
 *
 * `cascade: true` 是显式的整枝删除（连同子孙一起删），语义上就是"我要删掉这一整枝"，
 * 因此不受这条规则限制。
 */
export function softDeleteTask(
  ctx: ServiceContext,
  id: string,
  options: { cascade?: boolean } = {},
): { deleted: number; promoted: number } {
  const task = getTaskOrThrow(ctx, id);

  // 放在事务之前：这是纯读取，没必要为一个注定失败的请求开事务
  if (!options.cascade) {
    const childCount = countActiveChildren(ctx, id);
    if (childCount > 0) {
      throw new AppError(
        'CONFLICT',
        `「${task.title}」还有 ${childCount} 个子任务，无法删除。请先删除或移走这些子任务。`,
        { details: { id, childCount } },
      );
    }
  }

  return inTransaction(ctx, () => {
    const now = ctx.now();

    if (options.cascade) {
      const ids = collectSubtreeIds(ctx, id);
      for (const taskId of ids) {
        ctx.db
          .update(tasks)
          .set({ deletedAt: now, updatedAt: now })
          .where(and(eq(tasks.id, taskId), isNull(tasks.deletedAt)))
          .run();
      }
      recordActivity(ctx, {
        entityType: 'task',
        entityId: id,
        action: 'delete',
        projectId: task.projectId,
        changes: { cascade: [null, ids.length] },
      });
      return { deleted: ids.length, promoted: 0 };
    }

    ctx.db
      .update(tasks)
      .set({ deletedAt: now, updatedAt: now })
      .where(eq(tasks.id, id))
      .run();

    recordActivity(ctx, {
      entityType: 'task',
      entityId: id,
      action: 'delete',
      projectId: task.projectId,
      changes: { deletedAt: [null, now] },
    });

    // `promoted` 恒为 0：非级联路径已经不允许删有子任务的主任务，没有子任务可上提。
    // 保留这个字段是为了不改动接口返回结构。
    return { deleted: 1, promoted: 0 };
  });
}

/**
 * 还原任务。
 *
 * 顺带还原**同一次级联删除里被一起删掉**的子孙 —— 用"deletedAt 相同"
 * 识别它们。否则级联删了 20 个子任务，还原时只回来一个，用户会以为丢了数据。
 */
export function restoreTask(ctx: ServiceContext, id: string): TaskDto {
  const row = findTask(ctx, id);
  if (!row) throw new AppError('NOT_FOUND', '任务不存在', { details: { id } });
  if (row.deletedAt === null) return getTaskDetail(ctx, id);

  return inTransaction(ctx, () => {
    const now = ctx.now();
    const stamp = row.deletedAt;

    ctx.db
      .update(tasks)
      .set({ deletedAt: null, updatedAt: now })
      .where(eq(tasks.id, id))
      .run();

    if (stamp !== null) {
      const subtree = collectSubtreeIds(ctx, id);
      for (const taskId of subtree) {
        if (taskId === id) continue;
        ctx.db
          .update(tasks)
          .set({ deletedAt: null, updatedAt: now })
          .where(and(eq(tasks.id, taskId), eq(tasks.deletedAt, stamp)))
          .run();
      }
    }

    recordActivity(ctx, {
      entityType: 'task',
      entityId: id,
      action: 'restore',
      projectId: row.projectId,
    });

    return getTaskDetail(ctx, id);
  });
}

/** 批量里被跳过的项：目前只有"有子任务所以不能删"这一种原因 */
export interface BatchSkipped {
  id: string;
  title: string;
  reason: 'has_children';
  childCount: number;
}

export interface BatchResult {
  affected: number;
  /**
   * 被跳过的项。
   *
   * 这里刻意**跳过并上报**而不是整批失败：批量删 20 个里有 1 个是主任务，
   * 直接抛异常会把另外 19 个本该删掉的也一起废掉，用户只会看到"批量删除失败"。
   * 但也不能静默跳过 —— 那用户会以为全删成功了。所以跳过 + 如实回报数量。
   */
  skipped: BatchSkipped[];
}

export function batchTasks(ctx: ServiceContext, input: BatchTaskInput): BatchResult {
  return inTransaction(ctx, () => {
    let affected = 0;
    const skipped: BatchSkipped[] = [];

    for (const id of input.ids) {
      const row = findTask(ctx, id);
      if (!row || row.deletedAt !== null) continue;

      switch (input.action) {
        case 'update': {
          if (input.patch) updateTask(ctx, id, input.patch);
          affected += 1;
          break;
        }
        case 'delete': {
          const childCount = countActiveChildren(ctx, id);
          if (childCount > 0) {
            skipped.push({ id, title: row.title, reason: 'has_children', childCount });
            break;
          }
          softDeleteTask(ctx, id);
          affected += 1;
          break;
        }
        case 'restore': {
          if (row.deletedAt !== null) {
            restoreTask(ctx, id);
            affected += 1;
          }
          break;
        }
        case 'addTags': {
          const existing = ctx.db
            .select({ tagId: taskTags.tagId })
            .from(taskTags)
            .where(eq(taskTags.taskId, id))
            .all()
            .map((r) => r.tagId);
          setTaskTags(ctx, id, [...existing, ...(input.tagIds ?? [])]);
          affected += 1;
          break;
        }
        case 'removeTags': {
          const remove = new Set(input.tagIds ?? []);
          const existing = ctx.db
            .select({ tagId: taskTags.tagId })
            .from(taskTags)
            .where(eq(taskTags.taskId, id))
            .all()
            .map((r) => r.tagId)
            .filter((tagId) => !remove.has(tagId));
          setTaskTags(ctx, id, existing);
          affected += 1;
          break;
        }
      }
    }

    return { affected, skipped };
  });
}

/** 回收站列表 */
export function listDeletedTasks(ctx: ServiceContext, projectId: string): TaskDto[] {
  const rows = ctx.db
    .select()
    .from(tasks)
    .where(and(eq(tasks.projectId, projectId), sql`${tasks.deletedAt} IS NOT NULL`))
    .orderBy(asc(tasks.deletedAt))
    .all();

  const categories = loadStatusCategories(ctx, projectId);
  const decorations = loadProjectDecorations(ctx, projectId);

  return rows.map((row) =>
    toDto(row, decorations.get(row.id), categories.get(row.statusId ?? '') ?? null),
  );
}

/** 供工作台用：跨项目筛出未完成、且截止日临近或已逾期的任务 */
export function listUpcomingTasks(
  ctx: ServiceContext,
  options: { dueBefore: number; projectIds?: string[] },
): TaskDto[] {
  const conditions: SQL[] = [
    isNull(tasks.deletedAt),
    sql`${tasks.dueDate} IS NOT NULL AND ${tasks.dueDate} <= ${options.dueBefore}`,
    sql`(${tasks.completedAt} IS NULL)`,
  ];
  if (options.projectIds && options.projectIds.length > 0) {
    conditions.push(inArray(tasks.projectId, options.projectIds));
  }

  const rows = ctx.db
    .select()
    .from(tasks)
    .where(and(...conditions))
    .orderBy(asc(tasks.dueDate))
    .limit(200)
    .all();

  const byProject = new Map<string, Map<string, StatusCategory>>();
  const result: TaskDto[] = [];

  for (const row of rows) {
    let categories = byProject.get(row.projectId);
    if (!categories) {
      categories = loadStatusCategories(ctx, row.projectId);
      byProject.set(row.projectId, categories);
    }
    result.push(toDto(row, undefined, categories.get(row.statusId ?? '') ?? null));
  }

  return result;
}
