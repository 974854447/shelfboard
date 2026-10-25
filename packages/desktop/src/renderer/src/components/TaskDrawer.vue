<script setup lang="ts">
/**
 * 任务详情抽屉。
 *
 * 这是看板/列表里"点开一个任务"的落点，承担了之前完全缺失的一块：
 * 查看与编辑字段、管理子任务、管理依赖关系、挂标签。
 *
 * 三条交互约定：
 * 1. **文本类字段（标题、描述）本地编辑 + 显式保存**，避免每敲一个字打一次接口；
 * 2. **下拉类字段（状态、优先级、截止日、标签）立即保存**，因为它们本来就是
 *    "选择即生效"的语义，再加一步保存反而别扭；
 * 3. **有子任务的任务不允许删除**。删除按钮照常可点，但点下去得到的是
 *    "为什么不能删"的警告（单个按钮），而不是一个可以继续下去的确认框 ——
 *    摆出"确定要删吗"会让用户以为再点一次就能删。
 *
 * 关闭方式刻意做了三种，因为抽屉是"看一眼就走"的高频浮层，
 * 只给一个右上角的 × 会让人总要往角落找：
 * 点遮罩空白处、按 Esc、点 ×，任一都关。
 */

import {
  NButton,
  NDatePicker,
  NDivider,
  NDrawer,
  NDrawerContent,
  NEmpty,
  NInput,
  NSelect,
  NSpin,
  NTag,
  NTooltip,
} from 'naive-ui';
import { computed, ref, watch } from 'vue';

import type { Priority } from '@pm-studio/shared';
import type { TaskDetail } from '@pm-studio/server';

import AppIcon from './AppIcon.vue';
import TaskCreateDialog from './TaskCreateDialog.vue';
import { tasks as tasksApi, type TaskDto } from '../api/endpoints';
import { useFeedback } from '../composables/useFeedback';
import { useBoardStore } from '../stores/board';

const props = defineProps<{ taskId: string | null }>();
const emit = defineEmits<{
  (e: 'update:taskId', value: string | null): void;
  (e: 'changed'): void;
}>();

const board = useBoardStore();
const feedback = useFeedback();

const detail = ref<TaskDetail | null>(null);
const loading = ref(false);
const saving = ref(false);

/** 可编辑的文本草稿（标题、描述） */
const draft = ref({ title: '', description: '' });

/** 依赖候选（用于"添加前置任务"的下拉） */
const candidates = ref<TaskDto[]>([]);
const addingPredecessor = ref<string | null>(null);
/** 新建子任务的弹窗（复用统一的创建弹窗，父任务已预置） */
const subtaskShow = ref(false);

const PRIORITIES: Array<{ label: string; value: Priority }> = [
  { label: '低', value: 'low' },
  { label: '中', value: 'medium' },
  { label: '高', value: 'high' },
  { label: '紧急', value: 'urgent' },
];

const show = computed(() => props.taskId !== null);

const dirty = computed(() => {
  const d = detail.value;
  if (!d) return false;
  return draft.value.title !== d.title || (draft.value.description ?? '') !== (d.description ?? '');
});

const statusOptions = computed(() =>
  board.statuses.map((s) => ({ label: s.name, value: s.id, color: s.color })),
);

const tagOptions = computed(() => board.tags.map((t) => ({ label: t.name, value: t.id })));

/** 候选前置任务：排除自己、排除已建立依赖的、排除已完成没什么意义的（仍允许） */
const predecessorOptions = computed(() => {
  const d = detail.value;
  if (!d) return [];
  const linked = new Set(d.predecessors.map((p) => p.taskId));
  return candidates.value
    .filter((t) => t.id !== d.id && !linked.has(t.id))
    .map((t) => ({ label: t.title, value: t.id }));
});

async function load(taskId: string): Promise<void> {
  loading.value = true;
  try {
    const result = await tasksApi.detail(taskId);
    detail.value = result;
    draft.value = { title: result.title, description: result.description ?? '' };

    if (board.currentProjectId) {
      const list = await tasksApi.list(board.currentProjectId, { pageSize: 500 });
      candidates.value = list.items;
    }
  } catch (error) {
    feedback.failure(error, '加载任务详情失败');
    emit('update:taskId', null);
  } finally {
    loading.value = false;
  }
}

watch(
  () => props.taskId,
  (taskId) => {
    if (taskId) void load(taskId);
    else {
      detail.value = null;
      draft.value = { title: '', description: '' };
    }
  },
  { immediate: true },
);

/** 保存文本字段 */
async function saveText(): Promise<void> {
  const d = detail.value;
  if (!d || !dirty.value || !draft.value.title.trim()) return;

  saving.value = true;
  try {
    await board.updateTask(d.id, {
      title: draft.value.title.trim(),
      description: draft.value.description,
    });
    await load(d.id);
    emit('changed');
    feedback.success('已保存');
  } catch (error) {
    feedback.failure(error, '保存失败');
  } finally {
    saving.value = false;
  }
}

/**
 * 立即保存的字段（选择即生效）。
 *
 * **成功后不整块 `load()`，而是把服务端返回的那条就地合并进 `detail`**。
 * 原来每次改一个字段都重载详情，有两个实际后果：
 * 1. 重载会把 `draft`（标题/描述草稿）按服务端值重置 —— 你在描述里写了一半，
 *    顺手改一下优先级，写的内容就没了；
 * 2. 保存期间字段被禁用（`:disabled="saving"`），正在输入的控件会因此**掉焦点**
 *    （用户报的"进度输入时失去焦点"就是这个）。
 */
async function patch(patchBody: Record<string, unknown>, successText?: string): Promise<void> {
  const d = detail.value;
  if (!d) return;

  saving.value = true;
  try {
    const updated = await board.updateTask(d.id, patchBody);
    if (!updated) {
      // updateTask 内部已经 reportError 了，这里只把结果说清楚
      feedback.failure(new Error('保存失败'), '保存失败');
      return;
    }
    detail.value = { ...d, ...updated };
    emit('changed');
    if (successText) feedback.success(successText);
  } catch (error) {
    feedback.failure(error, '保存失败');
  } finally {
    saving.value = false;
  }
}

/**
 * 新建子任务。
 *
 * 走统一的创建弹窗而不是内联输入框：子任务**必须显式带上父任务**，
 * 而内联输入框没有任何地方体现"它挂在哪"，用户容易误以为建的是顶层任务。
 */
async function onSubtaskCreated(): Promise<void> {
  const d = detail.value;
  if (!d) return;
  await load(d.id);
  emit('changed');
}

async function addPredecessor(): Promise<void> {
  const d = detail.value;
  const predecessorId = addingPredecessor.value;
  if (!d || !predecessorId) return;

  try {
    await tasksApi.addDependency(d.id, predecessorId);
    addingPredecessor.value = null;
    await load(d.id);
    emit('changed');
    feedback.success('已建立依赖');
  } catch (error) {
    // 成环会被服务端以 DEPENDENCY_CYCLE 拒绝，这里如实展示原因
    feedback.failure(error, '建立依赖失败');
  }
}

async function removePredecessor(depId: string): Promise<void> {
  const d = detail.value;
  if (!d) return;
  try {
    await tasksApi.removeDependency(d.id, depId);
    await load(d.id);
    emit('changed');
  } catch (error) {
    feedback.failure(error, '移除依赖失败');
  }
}

/**
 * 提交审核：把任务推进到项目的「待审查」状态。
 *
 * 具体落到哪个状态由**服务端**决定（`POST /tasks/:id/submit-review`）——
 * 界面不该知道"审核状态叫什么名字"，否则改名之后按钮就悄悄失效了。
 * 服务端找不到该状态时会给出可操作的报错（"这个项目的工作流里没有「待审查」状态"）。
 */
const submitting = ref(false);

async function submitReview(): Promise<void> {
  const d = detail.value;
  if (!d) return;

  submitting.value = true;
  try {
    const updated = await tasksApi.submitReview(d.id);
    detail.value = { ...d, ...updated };
    emit('changed');
    feedback.success(`「${d.title}」已提交审核`);
  } catch (error) {
    feedback.failure(error, '提交审核失败');
  } finally {
    submitting.value = false;
  }
}

function close(): void {
  emit('update:taskId', null);
}

function formatTime(ts: number | null): string {
  if (!ts) return '—';
  return new Date(ts).toLocaleString('zh-CN', { hour12: false });
}
</script>

<template>
  <!--
    三个关闭入口全部显式写出来（遮罩点击 / Esc / 关闭按钮），不依赖组件库默认值：
    Naive 的默认值变更过一次，而"点空白关不掉"这类问题一旦回归，
    用户会以为是卡住了，而不是去查 changelog。
  -->
  <NDrawer
    :show="show"
    :width="560"
    placement="right"
    mask-closable
    close-on-esc
    @update:show="(v: boolean) => !v && close()"
  >
    <NDrawerContent closable @close="close">
      <template #header>
        <span class="drawer-title">任务详情</span>
      </template>

      <div v-if="loading && !detail" class="center">
        <NSpin size="small" />
      </div>

      <NEmpty v-else-if="!detail" description="没有选中的任务" />

      <div v-else class="body">
        <!-- 标题：本地编辑 + 显式保存 -->
        <!--
          标题用无边框输入框：加边框会让它看起来像一个普通表单项，
          而这里是整个抽屉的主标题。无边框 + 悬停/聚焦背景既保持可编辑性，
          又不会喧宾夺主。
        -->
        <NInput
          v-model:value="draft.title"
          type="textarea"
          :autosize="{ minRows: 1, maxRows: 3 }"
          :bordered="false"
          placeholder="任务标题"
          class="title-input"
          @keydown.enter.exact.prevent="saveText"
        />

        <div class="save-row">
          <NButton
            v-if="dirty"
            type="primary"
            size="small"
            :loading="saving"
            @click="saveText"
          >
            保存标题与描述
          </NButton>
          <span v-if="dirty" class="faint">有未保存的修改</span>
        </div>

        <!-- 选择即生效的字段 -->
        <div class="grid">
          <label class="field">
            <span class="field-label">状态</span>
            <NSelect
              size="small"
              data-field="drawer-status"
              :value="detail.statusId"
              :options="statusOptions"
              :disabled="saving"
              @update:value="(v: string) => patch({ statusId: v })"
            />
          </label>

          <label class="field">
            <span class="field-label">优先级</span>
            <NSelect
              size="small"
              :value="detail.priority"
              :options="PRIORITIES"
              :disabled="saving"
              @update:value="(v: Priority) => patch({ priority: v })"
            />
          </label>

          <label class="field">
            <span class="field-label">截止日</span>
            <NDatePicker
              size="small"
              type="date"
              clearable
              :value="detail.dueDate"
              :disabled="saving"
              @update:value="(v: number | null) => patch({ dueDate: v })"
            />
          </label>

          <!--
            「进度」那一格已下线（用户 2026-10-02：进度条取消，改用六态状态表达完成情况）。
            现在"做到哪一步"由状态回答（待完成 / 正在修改 / 待审查 / 审查中 / 回退修改 / 已完成），
            "算不算做完"只看分类为 done 的那一个状态。
          -->
        </div>

        <div class="grid">
          <label class="field wide">
            <span class="field-label">标签</span>
            <NSelect
              size="small"
              multiple
              :value="detail.tagIds"
              :options="tagOptions"
              :placeholder="tagOptions.length ? '选择标签' : '该项目还没有标签'"
              :disabled="saving || tagOptions.length === 0"
              @update:value="(v: string[]) => patch({ tagIds: v })"
            />
          </label>
        </div>

        <NDivider title-placement="left" class="divider">描述（Markdown）</NDivider>
        <NInput
          v-model:value="draft.description"
          type="textarea"
          :autosize="{ minRows: 4, maxRows: 14 }"
          placeholder="补充说明、验收标准、参考链接…"
        />

        <!-- 子任务 -->
        <NDivider title-placement="left" class="divider">
          子任务（{{ detail.childCount }}）
        </NDivider>

        <div v-if="detail.parent" class="parent-hint">
          <span class="faint">上级：</span>
          <NButton text size="tiny" @click="emit('update:taskId', detail.parent!.id)">
            {{ detail.parent.title }}
          </NButton>
        </div>

        <ul v-if="detail.children.length > 0" class="children">
          <li v-for="child in detail.children" :key="child.id">
            <span
              class="dot"
              :style="{
                background:
                  board.statuses.find((s) => s.id === child.statusId)?.color ?? 'var(--pm-text-faint)',
              }"
            />
            <button class="child-title" @click="emit('update:taskId', child.id)">
              {{ child.title }}
            </button>
            <span v-if="child.childCount > 0" class="faint tiny">
              {{ child.doneChildCount }}/{{ child.childCount }}
            </span>
          </li>
        </ul>
        <p v-else class="faint small">还没有子任务</p>

        <div class="add-row">
          <NButton size="small" block @click="subtaskShow = true">
            <template #icon><AppIcon name="plus" :size="14" /></template>
            新建子任务
          </NButton>
        </div>

        <!-- 依赖 -->
        <NDivider title-placement="left" class="divider">依赖关系</NDivider>

        <div class="dep-block">
          <div class="dep-head">
            <span class="field-label">前置任务（必须先完成）</span>
            <NTag v-if="detail.blockedByCount > 0" size="tiny" type="warning" :bordered="false">
              当前被阻塞
            </NTag>
          </div>

          <ul v-if="detail.predecessors.length > 0" class="deps">
            <li v-for="dep in detail.predecessors" :key="dep.id">
              <span class="dep-state" :class="{ done: dep.done }">
                <AppIcon :name="dep.done ? 'check' : 'clock'" :size="13" />
              </span>
              <button class="child-title" @click="emit('update:taskId', dep.taskId)">
                {{ dep.title }}
              </button>
              <NButton text size="tiny" @click="removePredecessor(dep.id)">
                <template #icon><AppIcon name="close" :size="13" /></template>
              </NButton>
            </li>
          </ul>
          <p v-else class="faint small">没有前置任务</p>

          <div class="add-row">
            <NSelect
              v-model:value="addingPredecessor"
              size="small"
              filterable
              clearable
              :options="predecessorOptions"
              placeholder="选择要依赖的任务"
            />
            <NButton size="small" :disabled="!addingPredecessor" @click="addPredecessor">
              添加
            </NButton>
          </div>
        </div>

        <div v-if="detail.successors.length > 0" class="dep-block">
          <span class="field-label">后继任务（依赖本任务）</span>
          <ul class="deps">
            <li v-for="dep in detail.successors" :key="dep.id">
              <span class="dep-state" :class="{ done: dep.done }">
                <AppIcon :name="dep.done ? 'check' : 'clock'" :size="13" />
              </span>
              <button class="child-title" @click="emit('update:taskId', dep.taskId)">
                {{ dep.title }}
              </button>
            </li>
          </ul>
        </div>

        <NDivider class="divider" />

        <div class="meta">
          <span class="faint tiny">创建 {{ formatTime(detail.createdAt) }}</span>
          <span class="faint tiny">更新 {{ formatTime(detail.updatedAt) }}</span>
          <span v-if="detail.completedAt" class="faint tiny">
            完成 {{ formatTime(detail.completedAt) }}
          </span>
        </div>

        <!--
          底部按钮（用户 2026-10-02 的要求）：
          - 「删除任务」**去掉**（删除入口收在大纲节点的垃圾桶上，详情页不再重复提供）；
          - 「重新加载」放到原来删除按钮的位置（左侧）；
          - 右侧新增「提交审核」——把任务推进到项目的「待审查」状态。
        -->
        <div class="footer">
          <NTooltip trigger="hover">
            <template #trigger>
              <NButton size="small" quaternary data-field="drawer-reload" @click="load(detail.id)">
                重新加载
              </NButton>
            </template>
            丢弃未保存的修改，重新读取服务端数据
          </NTooltip>

          <span class="foot-spacer" />

          <NButton
            size="small"
            type="primary"
            :loading="submitting"
            :disabled="detail.childCount > 0 && detail.statusCategory !== 'done'"
            data-field="drawer-submit-review"
            title="把任务推进到「待审查」状态"
            @click="submitReview"
          >
            <template #icon><AppIcon name="check" :size="14" /></template>
            提交审核
          </NButton>
        </div>
      </div>

      <!-- 统一的创建弹窗：父任务与状态都已预置 -->
      <TaskCreateDialog
        v-model:show="subtaskShow"
        :defaults="{
          parentId: detail?.id ?? null,
          parentTitle: detail?.title ?? null,
          statusId: detail?.statusId ?? null,
        }"
        @created="onSubtaskCreated"
      />
    </NDrawerContent>
  </NDrawer>
</template>

<style scoped>
.drawer-title {
  font-size: 13px;
  font-weight: 600;
}

.body {
  display: grid;
  gap: 10px;
  padding-bottom: 16px;
}

.center {
  display: grid;
  place-items: center;
  padding: 60px 0;
}

.title-input :deep(.n-input__textarea-el) {
  font-size: 16px;
  font-weight: 600;
  line-height: 1.5;
  padding: 6px 8px;
  border-radius: 6px;
  transition: background-color 0.15s ease;
}

.title-input :deep(.n-input__textarea-el:hover) {
  background: var(--pm-sunken);
}

.title-input :deep(.n-input__textarea-el:focus) {
  background: var(--pm-sunken);
}

.save-row {
  display: flex;
  align-items: center;
  gap: 10px;
  min-height: 24px;
}

.grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 10px;
}

.field {
  display: grid;
  gap: 4px;
}

.field.wide {
  grid-column: 1 / -1;
}

.field-label {
  font-size: 11.5px;
  color: var(--pm-text-muted);
}

.divider {
  margin: 14px 0 10px;
}

.divider :deep(.n-divider__title) {
  font-size: 12px;
  color: var(--pm-text-muted);
}

.children,
.deps {
  list-style: none;
  margin: 0 0 8px;
  padding: 0;
  display: grid;
  gap: 2px;
}

.children li,
.deps li {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 5px 8px;
  border-radius: 6px;
}

.children li:hover,
.deps li:hover {
  background: var(--pm-accent-soft);
}

.dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  flex-shrink: 0;
}

.dep-state {
  color: var(--pm-warn);
  display: flex;
}

.dep-state.done {
  color: var(--pm-ok);
}

.child-title {
  flex: 1;
  text-align: left;
  border: none;
  background: none;
  color: var(--pm-text);
  font: inherit;
  font-size: 12.5px;
  cursor: pointer;
  padding: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.child-title:hover {
  color: var(--pm-accent);
}

.parent-hint {
  display: flex;
  align-items: center;
  gap: 4px;
  font-size: 12px;
}

.add-row {
  display: flex;
  gap: 6px;
  align-items: center;
}

.add-row :deep(.n-select),
.add-row :deep(.n-input) {
  flex: 1;
}

.dep-block {
  display: grid;
  gap: 6px;
  margin-bottom: 10px;
}

.dep-head {
  display: flex;
  align-items: center;
  gap: 8px;
}

.meta {
  display: flex;
  gap: 14px;
  flex-wrap: wrap;
}

.footer {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-top: 6px;
}

/*
 * 把「提交审核」推到右端。
 * 用 flex 的 spacer 而不是 `justify-content: space-between`：
 * 将来左边再加按钮时，spacer 能保证"左侧一组、右侧一组"的分组关系不变。
 */
.foot-spacer {
  flex: 1;
  min-width: 0;
}

.faint {
  color: var(--pm-text-faint);
}

.small {
  font-size: 12px;
  margin: 0;
}

.tiny {
  font-size: 11px;
}
</style>
