/**
 * 看板与任务状态。
 *
 * 拖拽的处理方式是这里最重要的部分：
 *
 * - **乐观更新**：拖拽是高频、低延迟预期的操作，等一个来回再动会明显发涩。
 *   所以先把本地状态改掉，再发请求。
 * - **失败必回滚**：请求失败时重新拉取看板（而不是试图"撤销"本地改动）——
 *   服务端才是排序的权威，重拉一次最省心也最不容易错。
 * - **成功不整表重载**：把返回的单个任务本地打补丁即可。几千个任务的看板上
 *   每拖一次就全量重载，会明显卡顿。
 */

import { defineStore } from 'pinia';
import { computed, ref } from 'vue';

import type { MoveTaskInput, UpdateTaskInput } from '@pm-studio/shared';
import type { BoardResult, TagDto, TaskDto, WorkflowStatusDto } from '@pm-studio/server';

import { projects as projectsApi, tags as tagsApi, tasks as tasksApi, workflow as workflowApi, type ProjectDto } from '../api/endpoints';
import { useAppStore } from './app';

/** 一次拉多少（与列表页一致：先要一页，再按总数补齐） */
const FETCH_PAGE_SIZE = 1000;

export const useBoardStore = defineStore('board', () => {
  const app = useAppStore();

  const projects = ref<ProjectDto[]>([]);
  const currentProjectId = ref<string | null>(null);
  const statuses = ref<WorkflowStatusDto[]>([]);
  const board = ref<BoardResult | null>(null);
  /**
   * 项目的**全部任务**（扁平，含子任务）。
   *
   * 文件夹视图（0.1.3 起）自己在客户端构树，不需要"按状态分列"的数据 ——
   * 状态改由卡片上的标签表达。这份列表与列表页同口径（分页拉全）。
   */
  const taskList = ref<TaskDto[]>([]);
  const tags = ref<TagDto[]>([]);
  const loading = ref(false);
  /** 正在拖拽/写入期间置为 true，避免重复操作 */
  const mutating = ref(false);

  const currentProject = computed(
    () => projects.value.find((p) => p.id === currentProjectId.value) ?? null,
  );

  const defaultStatusId = computed(
    () => statuses.value.find((s) => s.isDefault)?.id ?? statuses.value[0]?.id ?? null,
  );

  const totalTasks = computed(() => board.value?.total ?? 0);

  async function loadProjects(): Promise<void> {
    try {
      projects.value = await projectsApi.list({ includeArchived: false });
    } catch (error) {
      app.reportError(error);
    }
  }

  async function selectProject(projectId: string | null): Promise<void> {
    currentProjectId.value = projectId;
    /*
     * 记住上次打开的项目。
     *
     * 走主进程而不是 localStorage：窗口从 `http://127.0.0.1:<动态端口>` 加载，
     * 而 origin 包含端口 —— 端口每次启动都不同，localStorage 每次都是空的，
     * 也就是说"记住上次的项目"用 localStorage 实现等于没实现。
     */
    void window.pmStudio?.patchPreferences({ lastProjectId: projectId });
    board.value = null;
    statuses.value = [];
    tags.value = [];
    if (projectId) await loadBoard();
  }

  /** 恢复上次打开的项目；已不存在则退回第一个 */
  async function restoreLastProject(): Promise<void> {
    await loadProjects();

    const remembered = window.pmStudio?.initialPreferences?.lastProjectId ?? null;
    const candidate =
      (typeof remembered === 'string' ? projects.value.find((p) => p.id === remembered) : undefined) ??
      projects.value[0] ??
      null;

    if (candidate) await selectProject(candidate.id);
  }

  async function loadBoard(): Promise<void> {
    const projectId = currentProjectId.value;
    if (!projectId) {
      taskList.value = [];
      return;
    }

    loading.value = true;
    try {
      const [statusList, boardData, tagList, firstPage] = await Promise.all([
        workflowApi.list(projectId),
        tasksApi.board(projectId),
        tagsApi.list(projectId),
        tasksApi.list(projectId, { pageSize: FETCH_PAGE_SIZE, page: 1 }),
      ]);
      statuses.value = statusList.items;
      board.value = boardData;
      tags.value = tagList;

      // 分页拉全：文件夹视图需要完整的树，缺了子任务就会出现"文件夹里是空的"
      const items = [...firstPage.items];
      const pages = Math.ceil(firstPage.total / FETCH_PAGE_SIZE);
      for (let page = 2; page <= pages; page += 1) {
        const next = await tasksApi.list(projectId, { pageSize: FETCH_PAGE_SIZE, page });
        items.push(...next.items);
      }
      taskList.value = items;
    } catch (error) {
      app.reportError(error);
    } finally {
      loading.value = false;
    }
  }

  /** 本地把任务挪到目标列的目标位置，返回是否找到了它 */
  function patchLocalMove(task: TaskDto, statusId: string, beforeTaskId?: string | null): void {
    const current = board.value;
    if (!current) return;

    for (const column of current.columns) {
      const index = column.tasks.findIndex((t) => t.id === task.id);
      if (index >= 0) {
        column.tasks.splice(index, 1);
        column.taskCount = column.tasks.length;
      }
    }

    const target = current.columns.find((c) => c.statusId === statusId);
    if (!target) return;

    const moved: TaskDto = { ...task, statusId };
    const insertAt = beforeTaskId
      ? target.tasks.findIndex((t) => t.id === beforeTaskId)
      : -1;

    if (insertAt >= 0) target.tasks.splice(insertAt, 0, moved);
    else target.tasks.push(moved);

    target.taskCount = target.tasks.length;
  }

  /**
   * 拖拽落点：先本地生效，再请求服务端；失败则重拉看板回滚。
   *
   * 注意 `beforeTaskId` 的语义是"插到这个任务前面"，null 表示追加到末尾 ——
   * 这正是服务端 `POST /tasks/:id/move` 接受的契约。
   */
  async function moveTask(
    task: TaskDto,
    statusId: string,
    beforeTaskId: string | null,
  ): Promise<void> {
    if (mutating.value) return;
    const previousStatusId = task.statusId;

    patchLocalMove(task, statusId, beforeTaskId);

    mutating.value = true;
    try {
      const input: MoveTaskInput = { statusId, beforeTaskId };
      const updated = await tasksApi.move(task.id, input);

      // 用服务端返回的真实值覆盖本地推断（尤其是排序号与完成时间）
      const current = board.value;
      if (current) {
        for (const column of current.columns) {
          const index = column.tasks.findIndex((t) => t.id === updated.id);
          if (index >= 0) column.tasks[index] = updated;
        }
      }
    } catch (error) {
      app.reportError(error);
      // 服务端才是排序权威：直接重拉，而不是尝试撤销本地改动
      await loadBoard();
      void previousStatusId;
    } finally {
      mutating.value = false;
    }
  }

  /**
   * 拖拽落点提交。
   *
   * 与 `moveTask` 的关键区别：**拖拽库已经改过本地数组了**，这里不能再本地移动一次
   * （那会把任务挪两次）。所以只负责提交服务端 + 按返回值校准本地对象。
   * 失败时重拉看板回滚 —— 服务端才是排序的权威。
   */
  async function commitDrag(
    taskId: string,
    statusId: string,
    beforeTaskId: string | null,
  ): Promise<void> {
    if (mutating.value) return;
    mutating.value = true;
    try {
      const updated = await tasksApi.move(taskId, { statusId, beforeTaskId });
      const current = board.value;
      if (current) {
        for (const column of current.columns) {
          const index = column.tasks.findIndex((t) => t.id === taskId);
          if (index >= 0) {
            // 用服务端返回的真实值覆盖：排序号与完成时间可能已被服务端改写
            column.tasks[index] = updated;
            column.taskCount = column.tasks.length;
          }
        }
      }
    } catch (error) {
      app.reportError(error);
      await loadBoard();
    } finally {
      mutating.value = false;
    }
  }

  /**
   * 改一个任务。
   *
   * **返回服务端返回的那条任务**（失败返回 null）：调用方常常需要"就地把详情更新掉"，
   * 而不是再整块 `load()` 一次 —— 详情抽屉里每改一个字段就重载，会把用户正在写的
   * 标题/描述一起重置（草稿是从服务端重新赋值的），代价也更大。
   * 返回值是可判空的，所以 `if (!result) return;` 这种写法照旧表示"失败"。
   */
  async function updateTask(id: string, patch: UpdateTaskInput): Promise<TaskDto | null> {
    mutating.value = true;
    try {
      const updated = await tasksApi.update(id, patch);
      const current = board.value;
      if (current) {
        for (const column of current.columns) {
          const index = column.tasks.findIndex((t) => t.id === id);
          if (index >= 0) column.tasks[index] = updated;
        }
      }

      /*
       * 扁平列表也要一起补上。
       *
       * 工作台（0.1.3 起取代看板/列表）渲染的是 `taskList`，不是 `board.columns` ——
       * 只补后者的话，"在详情里改了状态，回到列表还是旧状态"，看起来像没保存。
       * 而为了这一次改动去 `loadBoard()`（3 个请求 + 全量分页）又与上面
       * "成功不整表重载"的原则相悖，所以就地打补丁。
       */
      const listed = taskList.value.findIndex((t) => t.id === id);
      if (listed >= 0) taskList.value[listed] = { ...taskList.value[listed], ...updated };

      return updated;
    } catch (error) {
      app.reportError(error);
      return null;
    } finally {
      mutating.value = false;
    }
  }

  async function deleteTask(id: string, cascade = false): Promise<boolean> {
    mutating.value = true;
    try {
      await tasksApi.remove(id, cascade);
      await loadBoard();
      return true;
    } catch (error) {
      app.reportError(error);
      return false;
    } finally {
      mutating.value = false;
    }
  }

  async function createProject(input: { name: string; description?: string; color?: string }): Promise<string | null> {
    try {
      const created = await projectsApi.create(input);
      await loadProjects();
      await selectProject(created.id);
      return created.id;
    } catch (error) {
      app.reportError(error);
      return null;
    }
  }

  return {
    projects,
    currentProjectId,
    currentProject,
    statuses,
    board,
    taskList,
    tags,
    loading,
    mutating,
    defaultStatusId,
    totalTasks,
    loadProjects,
    selectProject,
    restoreLastProject,
    loadBoard,
    moveTask,
    commitDrag,
    updateTask,
    deleteTask,
    createProject,
  };
});
