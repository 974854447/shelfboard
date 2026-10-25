<script setup lang="ts">
/**
 * 工作大纲。
 *
 * 用户的原话：「工作台的内容我希望改成工作大纲，作用是对整个项目创建一个工作大纲」，
 * 版式选的是第 4 种：**自上而下的树**（组织架构式，正交圆角连线，见 docs/mockups/style-D.png）。
 *
 * 四件事说清楚：
 *
 * 1. **根节点是项目**：树的第一层是项目名（这是"整个项目的大纲"的字面含义），
 *    第二层才是任务的顶层（没有父任务的那些）。子任务依次往下长。
 * 2. **树从 `board.taskList` 现场构建**，不额外请求一次树接口：那是项目里**全部任务**
 *    的扁平列表（含子任务），而"层级"在数据里就是 `parentId`。
 *    用同一份数据的好处是——在这里新建/改名/换状态之后，卡片与列表页看到的是同一份事实。
 * 3. **折叠状态只存在内存里**（不进数据库）：它是"我现在怎么看"，不是任务数据。
 *    换成数据库字段就要回答"换台电脑打开还是折叠的吗"，而这个问题没有正确答案。
 * 4. **拖拽还没做**：工具栏上如实标出来，并用每个节点上的「＋」作为替代路径 ——
 *    不做一个"能拖但结果不对"的半成品。
 */

import { NButton, NInput, NSpin, NTooltip } from 'naive-ui';
import { computed, nextTick, ref, watch } from 'vue';

import AppIcon from '../components/AppIcon.vue';
import EmptyState from '../components/EmptyState.vue';
import OutlineNode, { type OutlineItem } from '../components/OutlineNode.vue';
import TaskDrawer from '../components/TaskDrawer.vue';
import { tasks as tasksApi, type TaskDto } from '../api/endpoints';
import { useFeedback } from '../composables/useFeedback';
import { useBoardStore } from '../stores/board';

const board = useBoardStore();
const feedback = useFeedback();

const query = ref('');
const collapsed = ref<Set<string>>(new Set());
const editingId = ref<string | null>(null);
const editingDraft = ref('');
const addingParentId = ref<string | null>(null);
/** `null` 且 `addingRoot` 为 true 时表示"在根层新建一个顶层任务" */
const addingRoot = ref(false);
const addingDraft = ref('');
const drawerTaskId = ref<string | null>(null);
const busy = ref(false);
/** 根层新建的输入框：点完按钮要自动聚焦（否则用户还得再点一下输入框） */
const rootAddInput = ref<HTMLInputElement | null>(null);

watch(addingRoot, (open) => {
  if (open) void nextTick(() => rootAddInput.value?.focus());
});

/* ---------------- 构树 ---------------- */

interface RawItem {
  task: TaskDto;
  children: RawItem[];
}

/**
 * 把扁平任务列表构建成树。
 *
 * 用的是"先按 parentId 分桶、再从根往下接"的写法，**不递归查库**：
 * 任务的父子关系可能因为数据异常形成环（历史上手工改过库、或导入的数据有问题），
 * 递归遍历会直接爆栈把整个页面搞白；分桶法遇到环只是那条链上的节点不出现 ——
 * 页面还能用，用户看得见"少了几条"，也好排查。
 */
function buildTree(list: readonly TaskDto[]): RawItem[] {
  const byParent = new Map<string | null, TaskDto[]>();
  const present = new Set(list.map((task) => task.id));
  for (const task of list) {
    // 父任务不在列表里（被过滤掉/已删除）时按顶层处理，否则它会出现不了
    const key = task.parentId !== null && present.has(task.parentId) ? task.parentId : null;
    const bucket = byParent.get(key);
    if (bucket) bucket.push(task);
    else byParent.set(key, [task]);
  }

  const seen = new Set<string>();
  const assemble = (parentId: string | null, depth: number): RawItem[] => {
    const items = byParent.get(parentId) ?? [];
    const result: RawItem[] = [];
    for (const task of items) {
      if (seen.has(task.id)) continue;
      seen.add(task.id);
      result.push({ task, children: assemble(task.id, depth + 1) });
    }
    return result;
  };

  return assemble(null, 0);
}

function toItem(raw: RawItem, depth: number): OutlineItem {
  return {
    task: raw.task,
    depth,
    children: raw.children.map((child) => toItem(child, depth + 1)),
  };
}

/** 搜索：命中标题的节点保留，并保留它的祖先链（否则命中的子任务会变成孤儿看不到） */
function filterItems(items: OutlineItem[], needle: string): OutlineItem[] {
  if (needle === '') return items;
  const keep = (item: OutlineItem): OutlineItem | null => {
    const children = item.children.map(keep).filter((child): child is OutlineItem => child !== null);
    const hit = item.task.title.toLowerCase().includes(needle);
    if (!hit && children.length === 0) return null;
    return { ...item, children };
  };
  return items.map(keep).filter((item): item is OutlineItem => item !== null);
}

const rawTree = computed(() => buildTree(board.taskList));
const fullTree = computed(() => rawTree.value.map((raw) => toItem(raw, 1)));
/** 全树里的任务总数（含折叠起来的）—— 工具栏读数用它，不能拿"看得见的"冒充总数 */
const totalCount = computed(() => countNodes(fullTree.value));
const hitCount = computed(() => countNodes(filteredTree.value));

function countNodes(items: readonly OutlineItem[]): number {
  return items.reduce((sum, item) => sum + 1 + countNodes(item.children), 0);
}

const filteredTree = computed(() => filterItems(fullTree.value, query.value.trim().toLowerCase()));
/** 搜索时不做折叠：用户明确在找东西，把结果藏起来是反效果的 */
const visibleTree = computed(() => (query.value.trim() === '' ? fullTree.value : filteredTree.value));

/* ---------------- 读屏/交互 ---------------- */

const readout = computed(() => {
  if (!board.currentProjectId) return '';
  const collapsedCount = collapsed.value.size;
  const base = `共 ${totalCount.value} 个节点`;
  if (query.value.trim() !== '') return `${base} · 匹配 ${hitCount.value} 个`;
  return collapsedCount > 0 ? `${base} · 折叠了 ${collapsedCount} 个` : base;
});

function toggle(id: string): void {
  const next = new Set(collapsed.value);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  collapsed.value = next;
}

function collapseAll(): void {
  // 只折叠"有子节点"的，叶子节点折叠没有意义（会往 Set 里塞一堆无用的 id）
  const ids = new Set<string>();
  const walk = (items: readonly OutlineItem[]) => {
    for (const item of items) {
      if (item.children.length > 0) ids.add(item.task.id);
      walk(item.children);
    }
  };
  walk(fullTree.value);
  collapsed.value = ids;
}

function expandAll(): void {
  collapsed.value = new Set();
}

/* ---------------- 写操作 ---------------- */

async function renameStart(id: string, title: string): Promise<void> {
  editingId.value = id;
  editingDraft.value = title;
}

function renameCancel(): void {
  editingId.value = null;
  editingDraft.value = '';
}

async function renameCommit(id: string, title: string): Promise<void> {
  const next = title.trim();
  const current = board.taskList.find((task) => task.id === id);
  editingId.value = null;
  editingDraft.value = '';
  if (next === '' || !current || next === current.title) return;

  busy.value = true;
  try {
    const updated = await board.updateTask(id, { title: next });
    if (updated) feedback.success(`已改名为「${next}」`);
  } finally {
    busy.value = false;
  }
}

function addStart(parentId: string): void {
  addingRoot.value = false;
  addingParentId.value = parentId;
  addingDraft.value = '';
}

function addCancel(): void {
  addingParentId.value = null;
  addingRoot.value = false;
  addingDraft.value = '';
}

function addRootStart(): void {
  addingParentId.value = null;
  addingRoot.value = true;
  addingDraft.value = '';
}

async function addCommit(parentId: string | null, title: string): Promise<void> {
  const next = title.trim();
  if (next === '') {
    addCancel();
    return;
  }
  if (!board.currentProjectId) return;

  busy.value = true;
  try {
    await tasksApi.create({
      projectId: board.currentProjectId,
      title: next,
      ...(parentId !== null ? { parentId } : {}),
    });
    feedback.success(parentId === null ? `已新建顶层任务「${next}」` : `已新建子任务「${next}」`);
    // 新建的节点默认展开父级，否则"刚建的东西看不见"会让人以为没成功
    if (parentId !== null && collapsed.value.has(parentId)) toggle(parentId);
    // 输入框留着继续加：连续录入子任务是最常见的用法
    addingDraft.value = '';
    await board.loadBoard();
  } catch (error) {
    feedback.failure(error, '新建任务失败');
  } finally {
    busy.value = false;
  }
}

async function changeStatus(id: string, statusId: string): Promise<void> {
  const task = board.taskList.find((entry) => entry.id === id);
  if (!task || task.statusId === statusId) return;
  busy.value = true;
  try {
    await board.updateTask(id, { statusId });
  } finally {
    busy.value = false;
  }
}

async function removeOne(id: string): Promise<void> {
  const task = board.taskList.find((entry) => entry.id === id);
  if (!task) return;

  const childCount = board.taskList.filter((entry) => entry.parentId === id).length;

  /*
   * 有子任务时**不允许删除** —— 这是项目既有的规则（见 TaskDrawer 的 remove()），
   * 也是服务端的规则（非级联删除遇到子任务会直接返回 409）。
   *
   * 这里刻意用"只有一个按钮"的 alert 而不是带"取消"的 confirm：
   * 摆出一个"取消"按钮会让人以为"再点一次就能删"。第一版我在确认框里写的是
   * "子任务会上提一级"，而服务端其实**是拒绝删除** —— 是 e2e 拿真实请求打出来的 409
   * 才发现的（界面上的谎话比报错难查得多）。
   */
  if (childCount > 0) {
    await feedback.alert({
      title: '无法删除',
      content: `「${task.title}」还有 ${childCount} 个子任务，无法删除。请先删除或移走这些子任务，再删除它。`,
    });
    return;
  }

  const confirmed = await feedback.confirm({
    title: '删除任务',
    content: `确定删除「${task.title}」？删除后可在回收站还原。`,
    positiveText: '删除',
    danger: true,
  });
  if (!confirmed) return;

  busy.value = true;
  try {
    const ok = await board.deleteTask(id);
    if (ok) feedback.success('已移入回收站');
  } finally {
    busy.value = false;
  }
}

/* ---------------- 生命周期 ---------------- */

// 换项目：清掉"正在输入"的状态与折叠记忆（折叠记忆是按 id 存的，换项目后 id 全对不上）
watch(
  () => board.currentProjectId,
  () => {
    query.value = '';
    collapsed.value = new Set();
    editingId.value = null;
    addingParentId.value = null;
    addingRoot.value = false;
  },
);

const projectName = computed(() => board.currentProject?.name ?? '未选择项目');
</script>

<template>
  <section class="outline" data-view="outline">
    <!-- ============ 工具条 ============ -->
    <header class="bar">
      <div class="bar-search">
        <NInput v-model:value="query" size="small" clearable placeholder="在当前项目的大纲里找任务…">
          <template #prefix><AppIcon name="search" :size="14" /></template>
        </NInput>
      </div>

      <div class="bar-actions">
        <NTooltip trigger="hover">
          <template #trigger>
            <NButton size="small" quaternary data-field="outline-expand" @click="expandAll">
              全部展开
            </NButton>
          </template>
          展开所有子任务
        </NTooltip>
        <NTooltip trigger="hover">
          <template #trigger>
            <NButton size="small" quaternary data-field="outline-collapse" @click="collapseAll">
              全部折叠
            </NButton>
          </template>
          只留第一层：先看整体结构
        </NTooltip>

        <span class="faint readout" data-field="outline-readout">{{ readout }}</span>

        <NButton
          size="small"
          type="primary"
          :disabled="!board.currentProjectId"
          data-field="outline-add-root"
          @click="addRootStart"
        >
          <template #icon><AppIcon name="plus" :size="14" /></template>
          新建顶层任务
        </NButton>
      </div>
    </header>

    <!--
      诚实的缺口说明：拖拽换层级/排序还没做。
      写成"即将上线"没有信息量，写清"现在怎么替代"才有用。
    -->
    <p class="note faint" data-field="outline-note">
      点击节点即打开该任务的详情。悬停节点还可执行以下操作：<b>＋</b> 添加子任务、
      <b>铅笔</b> 重命名、<b>垃圾桶</b> 删除。<b>拖拽调整层级与顺序尚未实现</b>；
      如需变更父级，可在目标父节点上通过「＋」新建，或在详情中改挂到别的任务下。
    </p>

    <!-- ============ 树 ============ -->
    <EmptyState
      v-if="!board.currentProjectId"
      class="placeholder"
      text="还没有选项目"
      hint="请先在「项目」中选择一个项目，此处将显示其工作大纲"
    />

    <div v-else-if="board.loading && board.taskList.length === 0" class="placeholder">
      <NSpin size="small" />
    </div>

    <EmptyState
      v-else-if="fullTree.length === 0"
      class="placeholder"
      text="这个项目还没有任务"
      hint="工作大纲的第一层为顶层任务，其下为子任务"
      action="新建第一个顶层任务"
      @action="addRootStart"
    />

    <EmptyState
      v-else-if="visibleTree.length === 0"
      class="placeholder"
      :text="`没有匹配「${query.trim()}」的任务`"
      hint="大纲搜索仅覆盖当前项目；跨项目检索请使用「搜索」页（Ctrl+K）"
    />

    <div v-else class="tree-scroll">
      <ul class="tree" data-field="outline-tree">
        <!-- 根节点：项目本身（"整个项目的工作大纲"从项目名开始） -->
        <li class="root">
          <div class="root-card" data-field="outline-root">
            <AppIcon name="folder" :size="14" />
            <span class="root-name">{{ projectName }}</span>
            <span class="faint root-count">{{ totalCount }} 个节点</span>
          </div>

          <!-- 顶层新建：输入行挂在根节点下面，和子任务的交互一致 -->
          <div v-if="addingRoot" class="root-add" data-field="outline-add-root-row">
            <input
              ref="rootAddInput"
              class="add-input"
              :value="addingDraft"
              placeholder="顶层任务标题，回车创建"
              data-field="outline-add-root-input"
              @input="addingDraft = ($event.target as HTMLInputElement).value"
              @keydown.enter.prevent="addCommit(null, addingDraft)"
              @keydown.esc.prevent="addCancel"
            />
            <button class="add-btn" type="button" title="创建" @click="addCommit(null, addingDraft)">
              <AppIcon name="check" :size="13" />
            </button>
          </div>

          <ul class="root-children">
            <OutlineNode
              v-for="item in visibleTree"
              :key="item.task.id"
              :item="item"
              :statuses="board.statuses"
              :collapsed="collapsed"
              :editing-id="editingId"
              :editing-draft="editingDraft"
              :adding-parent-id="addingParentId"
              :adding-draft="addingDraft"
              :mutating="busy || board.mutating"
              @toggle="toggle"
              @status="changeStatus"
              @rename-start="renameStart"
              @rename-commit="renameCommit"
              @rename-cancel="renameCancel"
              @add-start="addStart"
              @add-commit="addCommit"
              @add-cancel="addCancel"
              @remove="removeOne"
              @open="(id: string) => (drawerTaskId = id)"
              @editing-input="(value: string) => (editingDraft = value)"
              @adding-input="(value: string) => (addingDraft = value)"
            />
          </ul>
        </li>
      </ul>
    </div>

    <TaskDrawer v-model:task-id="drawerTaskId" @changed="board.loadBoard()" />
  </section>
</template>

<style scoped>
/*
 * 纵向三段（工具条 / 说明 / 树），一维排布 → flex。
 */
.outline {
  display: flex;
  flex-direction: column;
  height: 100%;
  padding: 12px 16px 14px;
  gap: 9px;
  overflow: hidden;
}

.bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  flex: none;
  flex-wrap: wrap;
}

.bar-search {
  flex: 0 1 300px;
  min-width: 180px;
}

.bar-actions {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
}

.readout {
  font-size: 12px;
  white-space: nowrap;
}

.note {
  flex: none;
  margin: 0;
  font-size: 11.5px;
  line-height: 1.5;
}

.placeholder {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  min-height: 0;
}

/*
 * 树画布：两个方向都要能滚。
 * 用 auto 而不是 hidden：宽树（一层十几个节点）在窄窗口里必须能横向看到，
 * 否则右边的节点永远够不着。
 */
.tree-scroll {
  flex: 1;
  min-height: 0;
  overflow: auto;
  padding: 6px 12px 16px;
  border: 1px solid var(--pm-border);
  border-radius: 10px;
  background:
    radial-gradient(circle at 1px 1px, color-mix(in srgb, var(--pm-text) 9%, transparent) 1px, transparent 0)
      0 0 / 22px 22px;
}

.tree {
  display: flex;
  flex-direction: column;
  align-items: center;
  margin: 0;
  padding: 0;
  list-style: none;
  min-width: min-content;
}

.root {
  display: flex;
  flex-direction: column;
  align-items: center;
}

/* 项目根卡片：比任务节点更"重"，一眼看出这是整棵树的主人 */
.root-card {
  display: flex;
  align-items: center;
  gap: 7px;
  padding: 8px 14px;
  border: 1px solid var(--pm-accent);
  border-radius: 10px;
  background: color-mix(in srgb, var(--pm-accent) 14%, var(--pm-surface));
  color: var(--pm-text);
}

.root-name {
  font-size: 13.5px;
  font-weight: 600;
}

.root-count {
  font-size: 11px;
}

.root-add {
  display: flex;
  align-items: center;
  gap: 5px;
  margin-top: 8px;
}

.add-input {
  min-width: 200px;
  padding: 3px 7px;
  border: 1px solid var(--pm-accent);
  border-radius: 6px;
  background: var(--pm-bg, transparent);
  color: var(--pm-text);
  font-family: inherit;
  font-size: 12.5px;
}

.add-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 22px;
  height: 22px;
  padding: 0;
  border: 1px solid var(--pm-accent);
  border-radius: 6px;
  background: none;
  color: var(--pm-accent);
  cursor: pointer;
}

/*
 * 根节点到第一层的连接：竖线 + 横杆由 OutlineNode 负责，
 * 这里只补根卡片到横杆之间的那一小段（与组件里 12px 的间隙对齐）。
 */
.root-children {
  position: relative;
  display: flex;
  align-items: flex-start;
  justify-content: center;
  margin: 12px 0 0;
  padding: 0;
  list-style: none;
}

.root-children::before {
  content: '';
  position: absolute;
  top: -12px;
  left: 50%;
  width: 1px;
  height: 12px;
  background: var(--pm-border);
}

.faint {
  color: var(--pm-text-faint);
}
</style>
