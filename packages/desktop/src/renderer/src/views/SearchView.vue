<script setup lang="ts">
/**
 * 全局搜索（M2）：任务与工单的全文检索，跨项目。
 *
 * **中文分词是这个页面的核心**（实测见 docs/technical-design.md §24）：
 * 索引用的是 trigram（按 3 字片段切），所以
 * - 3 个字符以上的查询走全文索引，片段命中（"出诊断"也能命中"导出诊断包"）；
 * - **少于 3 个字符时回落到模糊匹配** —— "登录"这种两字词在中文里太常见，
 *   不做回落的话用户搜两个字会一条都搜不到。
 *
 * 服务端在响应里告诉我们实际走了哪条路（`mode`），界面**如实显示**：
 * 不说明的话，用户会以为"全文搜索时好时坏"。
 */

import { NButton, NInput, NSpin } from 'naive-ui';
import { computed, onMounted, ref } from 'vue';

import AppIcon from '../components/AppIcon.vue';
import EmptyState from '../components/EmptyState.vue';
import TaskCard from '../components/TaskCard.vue';
import TaskDrawer from '../components/TaskDrawer.vue';
import { search as searchApi, type SearchHitDto } from '../api/endpoints';
import { useCardStatus } from '../composables/useCardStatus';
import { useFeedback } from '../composables/useFeedback';
import { useBoardStore } from '../stores/board';
import { formatDayDate } from '../utils/date';

const feedback = useFeedback();
const board = useBoardStore();
// 结果是**跨项目**的：状态名/颜色/可选项都跟着搜索结果一起回来（见 useCardStatus.ts）
const cardStatus = useCardStatus();

const keyword = ref('');
const hits = ref<SearchHitDto[]>([]);
const mode = ref<'fts' | 'like'>('fts');
const searched = ref(false);
const loading = ref(false);
const drawerTaskId = ref<string | null>(null);
const inputRef = ref<InstanceType<typeof NInput> | null>(null);

const modeHint = computed(() =>
  mode.value === 'fts'
    ? '走全文索引（按 3 字片段匹配）'
    : '查询词少于 3 个字符，已自动改用模糊匹配',
);

async function run(): Promise<void> {
  const q = keyword.value.trim();
  if (q.length === 0) {
    hits.value = [];
    searched.value = false;
    return;
  }

  loading.value = true;
  try {
    const result = await searchApi.query(q, 50);
    hits.value = result.items;
    mode.value = result.mode;
    searched.value = true;
    cardStatus.mergeStatuses(result.statuses);
  } catch (error) {
    feedback.failure(error, '搜索失败');
  } finally {
    loading.value = false;
  }
}

function openHit(hit: SearchHitDto): void {
  // 工单界面在 M3，这里如实说明而不是给一个点了没反应的入口
  if (hit.type === 'ticket') {
    feedback.info('工单详情将在 M3 提供，当前仅支持检索');
    return;
  }
  drawerTaskId.value = hit.id;
}

/* ---------------- 卡片需要的东西：状态名/色/下拉项 ---------------- */

/** 搜索结果里没有子任务/标签的详情，用最小字段喂给卡片（卡片只读它需要的） */
function toCardTask(hit: SearchHitDto) {
  return {
    id: hit.id,
    title: hit.title,
    statusId: hit.statusId,
    childCount: 0,
    doneChildCount: 0,
    blockedByCount: 0,
    tagIds: [] as string[],
  };
}

async function changeStatus(hit: SearchHitDto, statusId: string): Promise<void> {
  if (hit.statusId === statusId) return;
  const updated = await board.updateTask(hit.id, { statusId });
  if (!updated) return;
  feedback.success(`「${hit.title}」已改为「${cardStatus.nameById(statusId)}」`);
  await run();
}

onMounted(() => {
  // Ctrl+K 从别处跳进来时，光标直接落在输入框里
  inputRef.value?.focus();
});
</script>

<template>
  <!-- `data-view` 是给 E2E 的语义标记：判断"路由内容真的挂载了"（约定见 docs/technical-design.md 的 E2E 一节） -->
  <div class="page" data-view="search">
    <header class="head">
      <h1>全局搜索</h1>
      <div class="box">
        <NInput
          ref="inputRef"
          v-model:value="keyword"
          size="large"
          clearable
          placeholder="搜索任务标题与描述（支持中文片段；Ctrl+K 返回此处）"
          data-field="search-input"
          @keydown.enter="run"
          @update:value="(value: string) => (value.trim().length === 0 ? (searched = false, hits = []) : undefined)"
        >
          <template #prefix><AppIcon name="search" :size="15" /></template>
        </NInput>
        <NButton type="primary" data-field="search-run" :loading="loading" @click="run">搜索</NButton>
      </div>
    </header>

    <p v-if="searched" class="faint hint" data-field="search-mode">
      {{ hits.length }} 条结果 · {{ modeHint }}
    </p>

    <div v-if="loading && hits.length === 0" class="placeholder"><NSpin size="medium" /></div>

    <!-- 空状态：开启的箱子 + 居中（用户要求） -->
    <EmptyState
      v-else-if="searched && hits.length === 0"
      class="placeholder"
      text="没有搜到匹配的任务"
      hint="可更换关键词：中文按片段匹配，三个字以上更准确"
    />

    <EmptyState
      v-else-if="!searched"
      class="placeholder"
      text="输入关键词开始搜索"
      hint="搜索任务标题与描述，覆盖全部项目；Ctrl+K 返回此处"
    />

    <!--
      结果用**与工作台一样的任务卡**铺开，排布让它自适应（`flex-wrap`）：
      卡片是行内块级别的单元，一行放几张由宽度决定，不占一整行。
      外面刻意**不加背景框** —— 用户要求「不需要背景框」。
    -->
    <div v-else class="cards" data-field="search-results">
      <TaskCard
        v-for="hit in hits"
        :key="`${hit.type}-${hit.id}`"
        class="search-card"
        data-field="search-hit"
        :task="toCardTask(hit)"
        :status-name="cardStatus.nameOf(hit)"
        :status-color="cardStatus.colorOf(hit)"
        :status-style="cardStatus.styleOf(hit)"
        :status-options="cardStatus.optionsFor(hit)"
        :belongs-to="hit.projectName"
        :done="hit.statusCategory === 'done'"
        :mutating="board.mutating"
        :hint="`打开「${hit.title}」的详情（属于 ${hit.projectName}）`"
        @activate="openHit(hit)"
        @detail="openHit(hit)"
        @status="(key: string) => changeStatus(hit, key)"
        @remove="() => undefined"
      />
    </div>

    <TaskDrawer v-model:task-id="drawerTaskId" @changed="run" />
  </div>
</template>

<style scoped>
.page {
  display: flex;
  flex-direction: column;
  height: 100%;
  padding: 16px 18px 16px;
  gap: 12px;
  overflow: hidden;
}

.head h1 {
  margin: 0 0 10px;
  font-size: 17px;
  font-weight: 600;
}

.box {
  display: flex;
  gap: 8px;
  max-width: 720px;
}

.hint {
  font-size: 12px;
}

.placeholder {
  flex: 1;
  margin-top: 40px;
}

/* 结果区：**不加外层背景框**，卡片自己按宽度自适应换行（一行放几张由宽度决定） */
.cards {
  flex: 1;
  min-height: 0;
  overflow: auto;
  display: flex;
  flex-wrap: wrap;
  align-content: flex-start;
  gap: 10px;
  padding: 2px 2px 12px;
}

.search-card {
  flex: 0 1 220px;
  min-width: 200px;
}

.faint {
  color: var(--pm-text-faint);
}
</style>
