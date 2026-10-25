<script setup lang="ts">
/**
 * 日志与诊断页。
 *
 * 两个模式共用一个视图：
 * - **浏览模式**：按级别 / 来源 / 关键词筛选，可分页。
 * - **现场模式**（路由带 `:traceId`）：只显示该 traceId 关联的全部日志，
 *   按时间**正序**排列 —— 这样读起来才是"发生了什么"的叙事顺序。
 *   错误横幅上的「查看日志」跳的就是这里。
 *
 * 实时流用 SSE，但**不自动开启**：一直挂着一条长连接会让日志列表不停跳动，
 * 反而看不清。想看实时输出时手动打开。
 *
 * 日志详情用等宽字体 + 保留缩进展示：栈信息一旦被折叠成一行就很难读了。
 */

import { NButton, NEmpty, NInput, NInputGroup, NSelect, NSkeleton, NTag, NTooltip, useDialog } from 'naive-ui';
import { computed, onUnmounted, reactive, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';

import type { AppLogEntry, LogLevel, LogSource } from '@pm-studio/shared';

import AppIcon from '../components/AppIcon.vue';
import { logs as logsApi, type LogQueryParams } from '../api/endpoints';
import { isBenignMessage } from '../api/report';
import { consumeSse } from '../api/sse';
import { useFeedback } from '../composables/useFeedback';

const feedback = useFeedback();
const route = useRoute();
const router = useRouter();

const entries = ref<AppLogEntry[]>([]);
const total = ref(0);
const loading = ref(false);
const expanded = ref<Set<string>>(new Set());

const contextTraceId = computed(() =>
  typeof route.params.traceId === 'string' && route.params.traceId.length > 0
    ? route.params.traceId
    : null,
);
const contextEntries = ref<AppLogEntry[]>([]);

const filters = reactive({
  minLevel: null as LogLevel | null,
  source: null as LogSource | null,
  q: '',
});

const page = ref(1);
const pageSize = ref(50);
const totalPages = computed(() => Math.max(1, Math.ceil(total.value / pageSize.value)));

const live = ref(false);
const liveEntries = ref<AppLogEntry[]>([]);
let controller: AbortController | null = null;

const LEVEL_OPTIONS = (['error', 'warn', 'info', 'debug'] as LogLevel[]).map((l) => ({
  label: `${l} 及以上`,
  value: l,
}));

const SOURCE_OPTIONS = (['main', 'api', 'job', 'renderer'] as LogSource[]).map((s) => ({
  label: s,
  value: s,
}));

const LEVEL_TAG_TYPE: Record<LogLevel, 'error' | 'warning' | 'info' | 'default'> = {
  error: 'error',
  warn: 'warning',
  info: 'info',
  debug: 'default',
};

const displayed = computed(() => (live.value ? liveEntries.value : entries.value));

function buildQuery(): LogQueryParams {
  return {
    page: page.value,
    pageSize: pageSize.value,
    ...(filters.minLevel ? { minLevel: filters.minLevel } : {}),
    ...(filters.source ? { source: filters.source } : {}),
    ...(filters.q.trim() ? { q: filters.q.trim() } : {}),
  };
}

async function load(): Promise<void> {
  loading.value = true;
  try {
    const result = await logsApi.query(buildQuery());
    entries.value = result.items;
    total.value = result.total;
  } catch (error) {
    feedback.failure(error, '加载日志失败');
  } finally {
    loading.value = false;
  }
}

async function loadContext(traceId: string): Promise<void> {
  loading.value = true;
  try {
    const result = await logsApi.context(traceId);
    contextEntries.value = result.items;
  } catch (error) {
    contextEntries.value = [];
    feedback.failure(error, '该 traceId 没有关联日志');
  } finally {
    loading.value = false;
  }
}

function leaveContext(): void {
  void router.push({ name: 'logs' });
}

async function toggleLive(): Promise<void> {
  if (live.value) {
    controller?.abort();
    controller = null;
    live.value = false;
    return;
  }

  controller = new AbortController();
  liveEntries.value = [];
  live.value = true;

  try {
    const response = await logsApi.stream(
      {
        ...(filters.minLevel ? { level: filters.minLevel } : {}),
        ...(filters.source ? { source: filters.source } : {}),
        replay: 20,
      },
      controller.signal,
    );

    await consumeSse(response, {
      signal: controller.signal,
      onEvent: (event) => {
        if (event.event !== 'log') return;
        try {
          const entry = JSON.parse(event.data) as AppLogEntry;
          // 最新的放最上面，并限制总量避免长时间挂着把内存吃满
          liveEntries.value = [entry, ...liveEntries.value].slice(0, 500);
        } catch {
          // 单条解析失败不该中断整条流
        }
      },
    });
  } catch (error) {
    if (!controller?.signal.aborted) feedback.failure(error, '日志实时流中断');
  } finally {
    live.value = false;
    controller = null;
  }
}

function toggleDetail(id: string): void {
  const next = new Set(expanded.value);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  expanded.value = next;
}

function openContext(traceId: string): void {
  void router.push({ name: 'log-context', params: { traceId } });
}

async function copyTraceId(traceId: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(traceId);
    feedback.success('traceId 已复制');
  } catch {
    // 剪贴板不可用就算了，traceId 本来就显示在界面上
  }
}

function formatTime(ts: number): string {
  const d = new Date(ts);
  const time = d.toLocaleTimeString('zh-CN', { hour12: false });
  return `${time}.${String(d.getMilliseconds()).padStart(3, '0')}`;
}

/**
 * 这一条是不是"浏览器自己的无害告警"。
 *
 * 用 `report.ts` 里那张模式表（同一份判断，避免两处不一致）：
 * 过滤只能挡住以后不再上报，**表里已经存在的历史记录要靠这里降级显示**。
 */
function isBenign(entry: AppLogEntry): boolean {
  return entry.level === 'error' && isBenignMessage(entry.message);
}

/** 本页有多少条是这种历史噪音（用来给用户一句解释，而不是让人对着红字猜） */
const benignCount = computed(() => displayed.value.filter(isBenign).length);

const clearDialog = useDialog();

/** 清空日志：给用户一个"把历史噪音清掉、从干净状态看"的手段 */
function clearLogs(): void {
  clearDialog.warning({
    title: '清空应用日志？',
    content:
      '将删除日志表中的全部记录（含历史错误）。清空动作本身会记录一条日志，' +
      '方便以后知道"日志为什么变空了"。这个操作不影响项目数据。',
    positiveText: '清空',
    negativeText: '取消',
    onPositiveClick: async () => {
      try {
        const result = await logsApi.clear();
        expanded.value = new Set();
        liveEntries.value = [];
        page.value = 1;
        await load();
        feedback.success(`已清空 ${result.removed} 条日志`);
      } catch (error) {
        feedback.failure(error, '清空日志失败');
      }
    },
  });
}

let filterTimer: ReturnType<typeof setTimeout> | undefined;
watch(
  () => [filters.minLevel, filters.source, filters.q],
  () => {
    if (filterTimer) clearTimeout(filterTimer);
    filterTimer = setTimeout(() => {
      page.value = 1;
      void load();
    }, 250);
  },
);

watch(page, load);

watch(
  contextTraceId,
  (traceId) => {
    if (traceId) void loadContext(traceId);
    else void load();
  },
  { immediate: true },
);

onUnmounted(() => {
  controller?.abort();
});
</script>

<template>
  <!-- `data-view` 是给 E2E 的语义标记：判断"路由内容真的挂载了"（约定见 docs/technical-design.md 的 E2E 一节） -->
  <div class="page" data-view="logs">
    <div class="toolbar">
      <template v-if="contextTraceId">
        <NTag type="info" :bordered="false" size="small" class="mono">{{ contextTraceId }}</NTag>
        <span class="faint">该 traceId 共 {{ contextEntries.length }} 条，按时间正序</span>
        <span class="spacer" />
        <NButton size="small" @click="leaveContext">返回全部日志</NButton>
        <NButton size="small" quaternary :loading="loading" @click="loadContext(contextTraceId)">
          刷新
        </NButton>
      </template>

      <template v-else>
        <NSelect
          v-model:value="filters.minLevel"
          size="small"
          clearable
          placeholder="全部级别"
          :options="LEVEL_OPTIONS"
          style="width: 148px"
        />
        <NSelect
          v-model:value="filters.source"
          size="small"
          clearable
          placeholder="全部来源"
          :options="SOURCE_OPTIONS"
          style="width: 132px"
        />
        <NInputGroup style="width: 260px">
          <NInput v-model:value="filters.q" size="small" clearable placeholder="搜索消息或详情" />
          <NButton size="small">
            <template #icon><AppIcon name="search" :size="14" /></template>
          </NButton>
        </NInputGroup>

        <span class="spacer" />
        <span class="faint">共 {{ total }} 条{{ live ? '（实时流中）' : '' }}</span>

        <NTooltip trigger="hover">
          <template #trigger>
            <NButton
              size="small"
              :type="live ? 'success' : 'default'"
              :ghost="live"
              @click="toggleLive"
            >
              <template #icon><AppIcon name="terminal" :size="14" /></template>
              {{ live ? '停止实时流' : '开启实时流' }}
            </NButton>
          </template>
          实时流会持续推送新日志；一直挂着会让列表不停跳动，不需要时请关掉
        </NTooltip>

        <NButton size="small" quaternary data-field="logs-refresh" :loading="loading" :disabled="live" @click="load">
          <template #icon><AppIcon name="refresh" :size="14" /></template>
        </NButton>

        <NTooltip trigger="hover">
          <template #trigger>
            <NButton size="small" quaternary data-field="logs-clear" @click="clearLogs">
              <template #icon><AppIcon name="trash" :size="14" /></template>
              清空
            </NButton>
          </template>
          把日志表清空。修掉的问题留下的历史红字会一直躺在这里，
          清掉之后从干净状态重新看（清空动作本身会留一条记录）
        </NTooltip>
      </template>
    </div>

    <!--
      历史噪音提示。
      过滤只能挡住"以后"不再上报，挡不住**表里已经存在的**记录：升级之后那几条
      浏览器无害告警仍然躺在日志里，用户会以为问题还在（实测正式库里有 8 条这种历史）。
      所以这里把本页的这类条目如实标出来，并把它们显示成灰色的「提示」而不是红色错误。
    -->
    <div v-if="benignCount > 0" class="benign-note">
      本页有 {{ benignCount }} 条为浏览器自身的无害告警（ResizeObserver 循环通知），
      已按灰色「提示」显示，不属于应用错误。当前版本已不再上报此类消息；
      如有历史噪音，可点击右上角「清空」。
    </div>

    <!-- 加载骨架 -->
    <div v-if="loading && displayed.length === 0" class="skeleton">
      <NSkeleton v-for="i in 8" :key="i" height="20px" style="margin-bottom: 6px" />
    </div>

    <NEmpty
      v-else-if="displayed.length === 0"
      class="placeholder"
      :description="contextTraceId ? '该 traceId 没有关联日志' : '没有符合条件的日志'"
    />

    <div v-else class="log-list">
      <article
        v-for="entry in displayed"
        :key="entry.id"
        class="log-row"
        :class="isBenign(entry) ? 'lv-benign' : `lv-${entry.level}`"
      >
        <span class="time mono">{{ formatTime(entry.ts) }}</span>
        <!--
          无害的浏览器告警显示成灰色「提示」而不是红色 error：
          它既不是应用错误，也不代表任何东西坏了，用红字只会让人去找一个不存在的问题。
        -->
        <NTag
          size="tiny"
          :type="isBenign(entry) ? 'default' : LEVEL_TAG_TYPE[entry.level]"
          :bordered="false"
          class="level"
          :title="isBenign(entry) ? '浏览器自身的无害告警，不属于应用错误' : ''"
        >
          {{ isBenign(entry) ? '提示' : entry.level }}
        </NTag>
        <span class="source mono" :title="entry.scope ?? ''">
          {{ entry.source }}{{ entry.scope ? `:${entry.scope}` : '' }}
        </span>

        <div class="message">
          <span data-selectable>{{ entry.message }}</span>

          <button
            v-if="entry.traceId"
            class="link mono"
            title="按该 traceId 查看完整现场（点击查看，Alt+点击复制）"
            @click="(event: MouseEvent) => (event.altKey ? copyTraceId(entry.traceId!) : openContext(entry.traceId!))"
          >
            {{ entry.traceId }}
          </button>

          <button v-if="entry.detail" class="link" @click="toggleDetail(entry.id)">
            {{ expanded.has(entry.id) ? '收起详情' : '详情' }}
          </button>

          <pre v-if="entry.detail && expanded.has(entry.id)" class="detail mono" data-selectable>{{
            entry.detail
          }}</pre>
        </div>
      </article>
    </div>

    <div v-if="!contextTraceId && !live" class="pager">
      <NButton size="small" :disabled="page <= 1" @click="page -= 1">上一页</NButton>
      <span class="faint">{{ page }} / {{ totalPages }}</span>
      <NButton size="small" :disabled="page >= totalPages" @click="page += 1">下一页</NButton>
    </div>
  </div>
</template>

<style scoped>
.page {
  padding: 16px 18px 30px;
  display: flex;
  flex-direction: column;
  height: 100%;
  overflow: hidden;
}

.toolbar {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 12px;
  flex-wrap: wrap;
}

.spacer {
  flex: 1;
}

.skeleton {
  padding: 8px 4px;
}

/*
 * 空态与骨架也**撑满剩余高度**。
 *
 * 用户指出：没有日志时，底部分页栏会"跑到上面去"（紧跟工具栏），而它应该在页面底部 ——
 * 也就是不管有没有数据，分页栏都在同一个位置。根因就是这里：有数据时 `.log-list`
 * 吃掉剩余高度、把分页栏顶到底部；空态时没有元素撑开，分页栏就浮上来了。
 * 让空态也 flex:1，位置就一致了。
 */
.placeholder,
.skeleton {
  flex: 1;
  min-height: 0;
  overflow: auto;
}

.placeholder {
  margin-top: 60px;
}

.log-list {
  flex: 1;
  min-height: 0;
  overflow: auto;
  border: 1px solid var(--pm-border);
  border-radius: 8px;
  background: var(--pm-surface);
}

.log-row {
  display: grid;
  grid-template-columns: 96px 56px 148px 1fr;
  gap: 10px;
  padding: 5px 12px;
  border-bottom: 1px solid var(--pm-border);
  align-items: baseline;
  font-size: 12px;
}

.log-row:last-child {
  border-bottom: none;
}

.log-row:hover {
  background: var(--pm-accent-soft);
}

/*
 * 无害的浏览器告警：整行压暗，视觉上退到后面 ——
 * 它不该和真正的错误抢注意力（用户会以为出了问题去找一个不存在的原因）。
 */
.log-row.lv-benign .message {
  color: var(--pm-text-muted);
}

.benign-note {
  margin: 10px 0 0;
  padding: 8px 12px;
  border: 1px solid var(--pm-border);
  border-radius: 8px;
  background: var(--pm-sunken);
  color: var(--pm-text-muted);
  font-size: 12px;
  line-height: 1.7;
}

.time {
  color: var(--pm-text-faint);
}

.level {
  justify-self: start;
}

.source {
  color: var(--pm-text-muted);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.message {
  word-break: break-word;
  min-width: 0;
}

.link {
  margin-left: 8px;
  border: none;
  background: none;
  padding: 0;
  font: inherit;
  font-size: 11px;
  color: var(--pm-accent);
  cursor: pointer;
  text-decoration: underline;
  text-decoration-style: dotted;
}

.link:hover {
  text-decoration-style: solid;
}

.detail {
  margin: 6px 0 2px;
  padding: 9px 10px;
  background: var(--pm-sunken);
  border-radius: 6px;
  white-space: pre-wrap;
  word-break: break-all;
  color: var(--pm-text-muted);
  font-size: 11.5px;
  line-height: 1.5;
  max-height: 320px;
  overflow: auto;
}

/*
 * 分页栏：始终贴在内容区底部。
 * `margin-top: auto` 是兜底 —— 万一将来某个数据状态又没有元素撑开剩余高度，
 * 它仍然会被推到最下面，而不是浮到工具栏下面。
 */
.pager {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-top: auto;
  padding-top: 12px;
}

.faint {
  color: var(--pm-text-faint);
  font-size: 12px;
}

.mono {
  font-family: 'Cascadia Mono', Consolas, monospace;
}
</style>
