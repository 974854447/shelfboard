<script setup lang="ts">
/**
 * 任务创建弹窗。
 *
 * 取代了原来"在列底部输入标题 + 回车"的快建方式。三个理由：
 *
 * 1. **回车即建太容易误触**，而且建出来的任务除了标题什么都没有，
 *    状态/优先级/截止日都得再点开一次才能补。
 * 2. **子任务需要显式关联父任务**。快建方式下只能靠在某张卡片上右键之类的
 *    隐式动作来创建子任务，用户根本不知道有这回事。这里把"上级任务"
 *    明确列成一个字段。
 * 3. 三处入口（看板列、列表工具栏、任务抽屉）共用同一个弹窗，
 *    交互一致，也不会出现"某个入口少填了几个字段"。
 *
 * 刻意**不绑定回车提交**：用户明确要求创建要有"明确的步骤"，
 * 敲完标题顺手一回车就把任务建出来，正是他想去掉的行为。
 */

import {
  NButton,
  NCard,
  NDatePicker,
  NInput,
  NModal,
  NSelect,
  NTag,
} from 'naive-ui';
import { computed, ref, watch } from 'vue';

import type { Priority } from '@pm-studio/shared';
import type { TaskDto } from '@pm-studio/server';

import AppIcon from './AppIcon.vue';
import { tasks as tasksApi } from '../api/endpoints';
import { useFeedback } from '../composables/useFeedback';
import { useBoardStore } from '../stores/board';

export interface TaskCreateDefaults {
  /** 预选状态（看板列会传当前列） */
  statusId?: string | null;
  /** 预选父任务（创建子任务时传） */
  parentId?: string | null;
  parentTitle?: string | null;
}

const props = defineProps<{
  show: boolean;
  defaults?: TaskCreateDefaults;
}>();

const emit = defineEmits<{
  (e: 'update:show', value: boolean): void;
  (e: 'created', task: TaskDto): void;
}>();

const board = useBoardStore();
const feedback = useFeedback();

const creating = ref(false);
const candidates = ref<TaskDto[]>([]);
const loadingCandidates = ref(false);

const form = ref({
  title: '',
  description: '',
  statusId: null as string | null,
  priority: 'medium' as Priority,
  dueDate: null as number | null,
  tagIds: [] as string[],
  parentId: null as string | null,
});

const PRIORITIES: Array<{ label: string; value: Priority }> = [
  { label: '低', value: 'low' },
  { label: '中', value: 'medium' },
  { label: '高', value: 'high' },
  { label: '紧急', value: 'urgent' },
];

const canSubmit = computed(() => form.value.title.trim().length > 0 && !creating.value);

const statusOptions = computed(() =>
  board.statuses.map((s) => ({ label: s.name, value: s.id })),
);

const tagOptions = computed(() => board.tags.map((t) => ({ label: t.name, value: t.id })));

/**
 * 可作为上级的任务。
 *
 * 排除掉正在创建的子任务自己当然不可能（还没 id），但要排除**已有的子孙**：
 * 这里只做一层，不做深层校验 —— 深层成环由服务端拒绝（它会返回明确的
 * VALIDATION_FAILED），前端不必重复实现一套图算法。
 */
const parentOptions = computed(() =>
  candidates.value.map((t) => ({ label: t.title, value: t.id })),
);

const parentTitle = computed(() => {
  const parentId = form.value.parentId;
  if (!parentId) return null;
  return (
    props.defaults?.parentTitle ??
    candidates.value.find((t) => t.id === parentId)?.title ??
    parentId
  );
});

function reset(): void {
  form.value = {
    title: '',
    description: '',
    statusId: props.defaults?.statusId ?? board.defaultStatusId ?? null,
    priority: 'medium',
    dueDate: null,
    tagIds: [],
    parentId: props.defaults?.parentId ?? null,
  };
}

async function loadCandidates(): Promise<void> {
  const projectId = board.currentProjectId;
  if (!projectId) return;

  loadingCandidates.value = true;
  try {
    const result = await tasksApi.list(projectId, { pageSize: 500 });
    candidates.value = result.items;
  } catch (error) {
    // 候选列表加载失败不该挡住创建主流程：此时仍可创建顶层任务
    feedback.failure(error, '加载可选上级任务失败');
    candidates.value = [];
  } finally {
    loadingCandidates.value = false;
  }
}

watch(
  () => props.show,
  (show) => {
    if (!show) return;
    reset();
    void loadCandidates();
  },
);

async function submit(): Promise<void> {
  const projectId = board.currentProjectId;
  if (!projectId || !canSubmit.value) return;

  creating.value = true;
  try {
    const created = await tasksApi.create({
      projectId,
      title: form.value.title.trim(),
      ...(form.value.description.trim() ? { description: form.value.description.trim() } : {}),
      ...(form.value.statusId ? { statusId: form.value.statusId } : {}),
      priority: form.value.priority,
      ...(form.value.dueDate !== null ? { dueDate: form.value.dueDate } : {}),
      ...(form.value.parentId ? { parentId: form.value.parentId } : {}),
      ...(form.value.tagIds.length > 0 ? { tagIds: form.value.tagIds } : {}),
    });

    emit('update:show', false);
    emit('created', created);
    feedback.success(
      form.value.parentId ? `已创建子任务「${created.title}」` : `已创建任务「${created.title}」`,
    );
  } catch (error) {
    feedback.failure(error, '创建任务失败');
  } finally {
    creating.value = false;
  }
}

function close(): void {
  emit('update:show', false);
}
</script>

<template>
  <NModal :show="props.show" :mask-closable="!creating" @update:show="emit('update:show', $event)">
    <NCard class="create-dialog" title="新建任务" :bordered="false" size="small">
      <div class="body">
        <!-- 子任务时把归属摆在最上面：这是它和普通任务最大的区别 -->
        <div v-if="form.parentId" class="parent-banner">
          <AppIcon name="link" :size="14" />
          <span>这是 <strong>{{ parentTitle }}</strong> 的子任务</span>
          <NButton size="tiny" quaternary @click="form.parentId = null">改为顶层任务</NButton>
        </div>

        <label class="field">
          <span class="field-label">标题 <em>*</em></span>
          <NInput
            v-model:value="form.title"
            placeholder="要做什么？例如：接入登录态"
            :maxlength="500"
            autofocus
          />
        </label>

        <label class="field">
          <span class="field-label">描述</span>
          <NInput
            v-model:value="form.description"
            type="textarea"
            :autosize="{ minRows: 2, maxRows: 5 }"
            placeholder="补充说明、验收标准（支持 Markdown，可选）"
          />
        </label>

        <div class="row">
          <label class="field">
            <span class="field-label">状态</span>
            <NSelect v-model:value="form.statusId" :options="statusOptions" placeholder="选择状态" />
          </label>
          <label class="field">
            <span class="field-label">优先级</span>
            <NSelect v-model:value="form.priority" :options="PRIORITIES" />
          </label>
        </div>

        <div class="row">
          <label class="field">
            <span class="field-label">截止日</span>
            <NDatePicker v-model:value="form.dueDate" type="date" clearable class="full" />
          </label>
          <!-- 进度已下线（用户 2026-10-02）：完成情况由状态表达，新建时一律落到「待完成」 -->
        </div>

        <label class="field">
          <span class="field-label">上级任务</span>
          <NSelect
            v-model:value="form.parentId"
            :options="parentOptions"
            :loading="loadingCandidates"
            filterable
            clearable
            placeholder="留空则创建顶层任务；选择父任务后创建其子任务"
          />
          <span class="faint hint">创建后作为子任务挂在父任务下，可在列表中折叠</span>
        </label>

        <label v-if="tagOptions.length > 0" class="field">
          <span class="field-label">标签</span>
          <NSelect
            v-model:value="form.tagIds"
            multiple
            :options="tagOptions"
            placeholder="选择标签（可选）"
          />
        </label>

        <p v-else class="faint hint">
          当前项目暂无标签。可在项目设置中添加，或先创建任务、稍后补充。
        </p>
      </div>

      <template #footer>
        <div class="footer">
          <span class="faint tiny">
            <NTag size="tiny" :bordered="false">提示</NTag>
            回车不会直接创建，请点击右侧按钮确认
          </span>
          <div class="buttons">
            <NButton :disabled="creating" @click="close">取消</NButton>
            <NButton type="primary" :disabled="!canSubmit" :loading="creating" @click="submit">
              创建任务
            </NButton>
          </div>
        </div>
      </template>
    </NCard>
  </NModal>
</template>

<style scoped>
.create-dialog {
  width: min(600px, calc(100vw - 60px));
}

.body {
  display: grid;
  gap: 12px;
}

.parent-banner {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 10px;
  border-radius: 8px;
  background: var(--pm-accent-soft);
  color: var(--pm-text);
  font-size: 12.5px;
}

.parent-banner strong {
  font-weight: 600;
}

.parent-banner .n-button {
  margin-left: auto;
}

.field {
  display: grid;
  gap: 5px;
}

.field-label {
  font-size: 12px;
  color: var(--pm-text-muted);
}

.field-label em {
  color: var(--pm-danger);
  font-style: normal;
}

.row {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 10px;
}

.full {
  width: 100%;
}

.hint {
  font-size: 11.5px;
  line-height: 1.5;
  margin: 0;
}

.footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}

.footer .tiny {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 11px;
}

.buttons {
  display: flex;
  gap: 8px;
  flex-shrink: 0;
}

.faint {
  color: var(--pm-text-faint);
}
</style>
