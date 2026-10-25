<script setup lang="ts">
/**
 * 今日待办。
 *
 * 用户的原话：「我的待办主要显示我今日的代办事项，展示我当日的工作时间，且在我的代办中
 * 需要新增一个功能，生成工作日志，需要展示我当日的工作内容」。所以这一页有三块：
 *
 * 1. **打卡计时**（顶部）：`HH:MM:SS` 跟着时间跳。秒钟**不靠轮询服务端** ——
 *    响应里带"这段已算进去多少毫秒（`totalMs`）"和"服务端算出的时刻（`generatedAt`）"，
 *    渲染层自己按 `totalMs + (现在 - generatedAt)` 往前推即可。
 *    后台每 60 秒对一次表（应用被挂起、跨零点、开关会话都能在 1 分钟内纠正过来）。
 *
 * 2. **四组筛选**：今天到期/逾期、今天开始、今天动过、我标了今天做。
 *    **分组是标签不是分区** —— 一条任务可以同时属于几组，所以四组计数之和会大于列表条数，
 *    卡片上也会把命中的分组都标出来（否则用户会以为"这条怎么在两处都出现"）。
 *
 * 3. **生成工作日志**：生成前先取一次"文档里会有什么"，生成后把**真实路径**显示出来，
 *    并提供"打开文档 / 打开所在文件夹"。覆盖同名文件时如实说明（用户在 Word 里改过的
 *    同名文件会被覆盖掉，这必须提前告知）。
 */

import { NButton, NSkeleton, NTag, NTooltip } from 'naive-ui';
import { computed, onMounted, onUnmounted, ref, watch } from 'vue';

import AppIcon from '../components/AppIcon.vue';
import EmptyState from '../components/EmptyState.vue';
import TaskCard from '../components/TaskCard.vue';
import TaskDrawer from '../components/TaskDrawer.vue';
import {
  tasks as tasksApi,
  today as todayApi,
  workLog as workLogApi,
  workTime as workTimeApi,
  type TaskWithProjectDto,
  type TodayGroupDto,
  type TodayTaskDto,
  type TodayWorkTimeDto,
  type WorkLogDataDto,
} from '../api/endpoints';
import { useCardStatus } from '../composables/useCardStatus';
import { useFeedback } from '../composables/useFeedback';
import { useBoardStore } from '../stores/board';
import { formatClock, formatFullDate, formatHms } from '../utils/date';

const feedback = useFeedback();
const board = useBoardStore();
const cardStatus = useCardStatus();

/** 四个筛选分组（顺序固定：越"该先做"的越靠左） */
const GROUP_ORDER: TodayGroupDto[] = ['due', 'starting', 'touched', 'marked'];
const GROUP_TEXT: Record<TodayGroupDto, { label: string; hint: string }> = {
  due: { label: '今天到期 / 逾期', hint: '未完成，且截止时间为今日（含已逾期）' },
  starting: { label: '今天开始', hint: '开始时间落在今天' },
  touched: { label: '今天动过', hint: '今日修改过标题、状态、进度或其它字段' },
  marked: { label: '我标了今天做', hint: '手动添加星标的任务（每日零点自动失效）' },
};

/**
 * 分组 → 卡片上那个小标签的轻重。
 *
 * 「今天到期 / 逾期」再细分一层：真的过期了用红（这是"欠着的"），
 * 今天到期用暖色（今天要做）；"今天动过"只是说明，保持安静 ——
 * 每一格都醒目等于每一格都不醒目。
 */
function badgeTone(task: TodayTaskDto, group: TodayGroupDto): 'default' | 'warning' | 'danger' {
  if (group === 'due') return task.reasons.includes('overdue') ? 'danger' : 'warning';
  if (group === 'marked') return 'warning';
  return 'default';
}

/** 当前选中分组时只显示那一枚标签；"全部"时把命中的都显示出来 */
function badgesFor(task: TodayTaskDto): Array<{ label: string; tone: 'default' | 'warning' | 'danger'; hint: string }> {
  const groups = activeGroups.value.length > 0
    ? task.groups.filter((group) => activeGroups.value.includes(group))
    : task.groups;
  return groups.map((group) => ({
    label: GROUP_TEXT[group].label,
    tone: badgeTone(task, group),
    hint: GROUP_TEXT[group].hint,
  }));
}

const loading = ref(false);
const markingId = ref<string | null>(null);
const drawerTaskId = ref<string | null>(null);

/**
 * 列表口径：`today` = 今天要做的事（四个来源），`all` = 当前项目的全部任务。
 *
 * 用户 2026-10-02 的要求：「这里我需要展示当前项目的所有任务」——
 * 有些项目当天没有待办（于是这一页是空的），但用户仍然想在这一页看到项目的全貌。
 * 所以给它一个显式的切换，而不是把两种口径混在一张列表里。
 */
type ViewMode = 'today' | 'all';
const mode = ref<ViewMode>('today');

const tasks = ref<TodayTaskDto[]>([]);
/** 「全部任务」口径下的完整列表（含已完成）；切到该口径时用 */
const allTasks = ref<TaskWithProjectDto[]>([]);
/** 四组并集的条数（去重后）—— 「全部」按钮与"共 N 条"都用它，不能用 counts 相加 */
const unionTotal = ref(0);
const counts = ref<Record<TodayGroupDto, number>>({
  due: 0,
  starting: 0,
  touched: 0,
  marked: 0,
});
/** 当前选中的筛选；空数组 = 全部（四组并集） */
const activeGroups = ref<TodayGroupDto[]>([]);

/** 当日工时 */
const workTime = ref<TodayWorkTimeDto | null>(null);
/** 每秒推进的"现在"（只用于把计时器往前推，不参与任何数据请求） */
const tickNow = ref(Date.now());

/** 工作日志的预览与生成结果 */
const logPreview = ref<WorkLogDataDto | null>(null);
const generating = ref(false);
const lastSaved = ref<{ path: string; dir: string; overwritten: boolean; bytes: number } | null>(null);

/** 计时器：今天已经计入的毫秒数（进行中会话按秒往前推） */
const elapsedMs = computed(() => {
  const data = workTime.value;
  if (!data) return 0;
  if (!data.open) return data.totalMs;
  // 生成这份数据之后又过去了多久，就该再加多久（跨零点由每分钟的对表纠正）
  return data.totalMs + Math.max(0, tickNow.value - data.generatedAt);
});

const elapsedLabel = computed(() => formatHms(elapsedMs.value));

/** 今天的日期文案：以服务端给的日期键为准（"今天"是用户所在地方的今天） */
const todayLabel = computed(() => {
  const key = workTime.value?.dateKey;
  if (!key) return formatFullDate(Date.now());
  const [year, month, day] = key.split('-').map((part) => Number(part));
  return formatFullDate(new Date(year ?? 1970, (month ?? 1) - 1, day ?? 1).getTime());
});

const segments = computed(() => workTime.value?.sessions ?? []);
const isAll = computed(() => activeGroups.value.length === 0);
/** 当前列表里的条数（筛选后） */
const shownCount = computed(() => tasks.value.length);
/** 「全部任务」口径下的条数（含已完成） */
const allCount = computed(() => allTasks.value.length);
const doneCount = computed(
  () => allTasks.value.filter((task) => task.statusCategory === 'done').length,
);
/** 当前口径下要渲染的列表 */
const visibleTasks = computed(() => (mode.value === 'today' ? tasks.value : allTasks.value));

/** 当前项目名（副标题里写明"这是哪个项目的今天"） */
const projectName = computed(() => board.currentProject?.name ?? null);

/** 副标题：写明范围（当前项目与你正在看的口径） */
const subtitle = computed(() => {
  const scope = projectName.value ? `「${projectName.value}」` : '当前项目';
  if (mode.value === 'all') {
    return `${scope}全部任务 · 共 ${allCount.value} 条（含已完成 ${doneCount.value} 条）`;
  }
  if (isAll.value) {
    return `${scope}今天到期/逾期、今天开始、今天动过，以及我手动标了「今天做」的任务 · 共 ${unionTotal.value} 条`;
  }
  return `${scope}筛选出 ${shownCount.value} 条 · 今天一共有 ${unionTotal.value} 条`;
});

function switchMode(next: ViewMode): void {
  if (mode.value === next) return;
  mode.value = next;
  void loadTasks();
}

function toggleGroup(group: TodayGroupDto): void {
  const next = activeGroups.value.includes(group)
    ? activeGroups.value.filter((item) => item !== group)
    : [...activeGroups.value, group];
  activeGroups.value = next;
  void loadTasks();
}

async function loadTasks(): Promise<void> {
  /*
   * **只看当前项目**（用户 2026-09-30：「今日待办只展示当前项目的任务内容」）。
   *
   * 没有选项目时不发请求：跨项目的"今天"在这个页面上已经不是一个概念了，
   * 发一个不带 projectId 的请求会让界面短暂显示别的项目的任务（看起来像串项目）。
   */
  const projectId = board.currentProjectId;
  if (!projectId) {
    tasks.value = [];
    allTasks.value = [];
    counts.value = { due: 0, starting: 0, touched: 0, marked: 0 };
    unionTotal.value = 0;
    return;
  }

  /*
   * 两种口径取不同接口：
   * - `today`：`/today`（四组判定 + 分组计数，服务端算）
   * - `all`：跨项目任务查询加 `projectIds: [当前项目]`（**不过滤已完成**，所以"所有任务"是真的所有）
   *
   * 复用现成的接口而不是给 `/today` 再塞一个"全量模式"：那个接口的语义是"今天该做什么"，
   * 让它按需变成"项目全量"会让它两边都不像。
   */
  if (mode.value === 'all') {
    const result = await tasksApi.acrossProjects({ projectIds: [projectId], limit: 2000 });
    allTasks.value = result.items;
    cardStatus.mergeStatuses(result.statuses);
    return;
  }

  const groups = activeGroups.value.length > 0 ? { groups: activeGroups.value } : {};
  const result = await todayApi.board({ ...groups, projectId });
  tasks.value = result.items;
  counts.value = result.counts;
  unionTotal.value = result.total;
  cardStatus.mergeStatuses(result.statuses);
}

async function loadWorkTime(): Promise<void> {
  workTime.value = await workTimeApi.today();
  tickNow.value = Date.now();
}

async function loadPreview(): Promise<void> {
  logPreview.value = await workLogApi.preview();
}

async function load(): Promise<void> {
  loading.value = true;
  try {
    await Promise.all([loadTasks(), loadWorkTime()]);
    // 预览失败不影响主体：它只是"生成前先看看"，不该把待办列表一起拖成错误
    await loadPreview().catch(() => undefined);
  } catch (error) {
    feedback.failure(error, '加载今日待办失败');
  } finally {
    loading.value = false;
  }
}

/* ---------------- 计时器与对表 ---------------- */

let tickTimer: number | undefined;
let syncTimer: number | undefined;

onMounted(async () => {
  await load();
  // 每秒推进显示；每分钟与服务端对一次表（跨零点、开关会话、系统休眠后都要纠回来）
  tickTimer = window.setInterval(() => {
    tickNow.value = Date.now();
  }, 1000);
  syncTimer = window.setInterval(() => {
    void loadWorkTime().catch(() => undefined);
  }, 60_000);
});

onUnmounted(() => {
  if (tickTimer !== undefined) window.clearInterval(tickTimer);
  if (syncTimer !== undefined) window.clearInterval(syncTimer);
});

// 换项目：重新取这个项目今天的待办（筛选状态保留，它是"我怎么看"，与项目无关）
watch(
  () => board.currentProjectId,
  () => void loadTasks(),
);

/* ---------------- 卡片交互 ---------------- */

async function changeStatus(task: TodayTaskDto, statusId: string): Promise<void> {
  if (task.statusId === statusId) return;
  const updated = await board.updateTask(task.id, { statusId });
  if (!updated) return;
  feedback.success(`「${task.title}」已改为「${cardStatus.nameById(statusId)}」`);
  // 改成已完成它就该从"今天要做的事"里消失，所以重新取一次口径
  await load();
}

async function toggleToday(task: TodayTaskDto, marked: boolean): Promise<void> {
  if (markingId.value !== null) return;
  markingId.value = task.id;
  try {
    await todayApi.mark(task.id, marked);
    feedback.success(
      marked ? `「${task.title}」已加入今日待办` : `「${task.title}」已取消今日标记`,
    );
    await loadTasks();
  } catch (error) {
    feedback.failure(error, marked ? '添加今日待办失败' : '取消今日标记失败');
  } finally {
    markingId.value = null;
  }
}

function isMarked(task: TodayTaskDto): boolean {
  return task.todayMarkDate !== null && task.todayMarkDate === workTime.value?.dateKey;
}

/* ---------------- 生成工作日志 ---------------- */

async function generateLog(): Promise<void> {
  if (generating.value) return;
  generating.value = true;
  try {
    /*
     * 保存目录**现读现用**（`getPreferences()`），不读 `initialPreferences`。
     *
     * 后者是 preload 在启动那一刻同步抓的快照，用户在「设置」里改完保存位置之后
     * 它还是旧值 —— 表现就是"改了设置但文档还是存到老地方"，而且没有任何报错。
     * 服务端优先用请求里的目录，所以这里传过去就能立刻生效（不必重启应用）。
     */
    const prefs = await window.pmStudio?.getPreferences();
    const dir = prefs?.workLogSaveDir ?? null;
    const result = await workLogApi.generate(dir ? { dir } : {});
    lastSaved.value = result;
    feedback.success(
      result.overwritten
        ? `工作日志已保存（覆盖了同名文件）：${result.path}`
        : `工作日志已保存：${result.path}`,
    );
    await loadPreview().catch(() => undefined);
  } catch (error) {
    feedback.failure(error, '生成工作日志失败');
  } finally {
    generating.value = false;
  }
}

async function openDoc(): Promise<void> {
  const path = lastSaved.value?.path;
  if (!path) return;
  try {
    await window.pmStudio?.openPath(path);
  } catch (error) {
    feedback.failure(error, '打开文档失败（文件可能已被移动或删除）');
  }
}

async function revealDoc(): Promise<void> {
  const path = lastSaved.value?.path;
  if (!path) return;
  try {
    await window.pmStudio?.showItemInFolder(path);
  } catch (error) {
    feedback.failure(error, '定位文件失败');
  }
}
</script>

<template>
  <div class="page" data-view="today">
    <!-- ============ 顶部：日期 + 打卡计时 ============ -->
    <header class="head">
      <div class="head-main">
        <div class="title-row">
          <h1>今日待办</h1>
          <span class="date faint" data-field="today-date">{{ todayLabel }}</span>
        </div>
        <p class="sub faint" data-field="today-subtitle">{{ subtitle }}</p>
      </div>

      <!--
        打卡：显示"今天开了多久"。计时口径是"应用开着的时间"，
        开关由主进程负责（打开软件开始、关闭结束），这里只显示。
      -->
      <div class="clock-card" data-field="work-clock" :data-running="workTime?.open ? '1' : '0'">
        <div class="clock-label faint">
          <AppIcon name="clock" :size="13" />
          <span>今日工作时间</span>
        </div>
        <div class="clock-value mono" data-field="work-clock-value">{{ elapsedLabel }}</div>
        <div class="clock-meta faint">
          <span v-if="workTime?.open" data-field="work-clock-state">
            <i class="live-dot" />计时中 · 本段始于
            {{ workTime.open.startedAt ? formatClock(workTime.open.startedAt) : '—' }}
          </span>
          <span v-else data-field="work-clock-state">未在计时</span>
          <span v-if="segments.length > 0">· 共 {{ segments.length }} 段</span>
        </div>
      </div>
    </header>

    <!-- ============ 口径切换 + 筛选 + 生成工作日志 ============ -->
    <div class="toolbar">
      <!--
        口径切换（用户 2026-10-02：「这里我需要展示当前项目的所有任务」）。
        项目当天没有待办时，这一页本来是空的；给一个显式切换之后，
        既能看"今天该做什么"，也能看"这个项目一共有哪些任务"。
      -->
      <div class="modes" role="group" aria-label="列表口径">
        <button
          type="button"
          class="chip"
          :class="{ 'is-on': mode === 'today' }"
          data-field="today-mode"
          data-mode="today"
          title="今天到期/逾期、今天开始、今天动过，以及手动标了「今天做」的任务"
          @click="switchMode('today')"
        >
          今日待办
        </button>
        <button
          type="button"
          class="chip"
          :class="{ 'is-on': mode === 'all' }"
          data-field="today-mode"
          data-mode="all"
          title="当前项目的全部任务（含已完成）"
          @click="switchMode('all')"
        >
          全部任务
          <span v-if="mode === 'all'" class="chip-count" data-field="count-project-all">
            {{ allCount }}
          </span>
        </button>
      </div>

      <div v-if="mode === 'today'" class="filters" role="group" aria-label="今日待办筛选">
        <button
          type="button"
          class="chip"
          :class="{ 'is-on': isAll }"
          data-field="today-filter"
          data-group="all"
          title="显示四组的并集（同一任务仅出现一次）"
          @click="
            () => {
              activeGroups = [];
              void loadTasks();
            }
          "
        >
          全部
          <span class="chip-count" data-field="count-all">{{ unionTotal }}</span>
        </button>
        <NTooltip v-for="group in GROUP_ORDER" :key="group" trigger="hover">
          <template #trigger>
            <button
              type="button"
              class="chip"
              :class="{ 'is-on': activeGroups.includes(group) }"
              data-field="today-filter"
              :data-group="group"
              @click="toggleGroup(group)"
            >
              {{ GROUP_TEXT[group].label }}
              <span class="chip-count" :data-field="`count-${group}`">{{ counts[group] }}</span>
            </button>
          </template>
          {{ GROUP_TEXT[group].hint }}
        </NTooltip>
      </div>

      <div class="toolbar-right">
        <NButton size="small" quaternary :loading="loading" data-field="today-refresh" @click="load">
          <template #icon><AppIcon name="refresh" :size="14" /></template>
        </NButton>
        <NButton
          size="small"
          type="primary"
          :loading="generating"
          data-field="today-gen-log"
          title="生成当日工作日志（Word 文档，保存至设置中指定的目录）"
          @click="generateLog"
        >
          <template #icon><AppIcon name="download" :size="14" /></template>
          生成工作日志
        </NButton>
      </div>
    </div>

    <!--
      工作日志：生成前先说清"里面有什么"，生成后给出真实路径。
      不给路径只说"成功"的提示等于没说 —— 用户下一步就是去找这个文件。
    -->
    <section class="log-bar" data-field="today-log-bar">
      <div class="log-summary">
        <template v-if="logPreview">
          <!--
            工作日志是**全天、全部项目**的工作总结（不是"当前项目的今天"），
            所以这里必须写明范围：不然用户会拿它跟上面那份"只有当前项目"的列表对数字，
            对不上就会以为哪里漏了。
          -->
          <span class="faint">工作日志将包含（全天 · 全部项目）：</span>
          <span class="chip-static">完成 {{ logPreview.completed.length }} 项</span>
          <span class="chip-static">推进 {{ logPreview.progressed.length }} 项</span>
          <span class="chip-static">新建 {{ logPreview.created.length }} 项</span>
          <span class="chip-static">工时 {{ logPreview.totalLabel }}</span>
          <span class="faint">· 涉及 {{ logPreview.projects.length }} 个项目</span>
        </template>
        <NSkeleton v-else text style="width: 320px" />
      </div>

      <div v-if="lastSaved" class="log-saved" data-field="today-log-saved">
        <NTag size="small" :type="lastSaved.overwritten ? 'warning' : 'success'" :bordered="false">
          {{ lastSaved.overwritten ? '已覆盖同名文件' : '已保存' }}
        </NTag>
        <span class="mono path" :title="lastSaved.path" data-field="today-log-path">
          {{ lastSaved.path }}
        </span>
        <NButton size="tiny" quaternary data-field="today-log-open" @click="openDoc">
          打开文档
        </NButton>
        <NButton size="tiny" quaternary data-field="today-log-reveal" @click="revealDoc">
          打开所在文件夹
        </NButton>
      </div>
    </section>

    <!-- ============ 列表 ============ -->
    <EmptyState
      v-if="!board.currentProjectId"
      class="placeholder"
      text="还没有选项目"
      hint="今日待办仅显示当前项目：请先在左上角选择项目"
    />

    <div v-else-if="loading && tasks.length === 0" class="placeholder">
      <NSkeleton v-for="n in 3" :key="n" text style="width: 100%; margin-bottom: 10px" />
    </div>

    <div v-else-if="visibleTasks.length === 0" class="placeholder">
      <EmptyState
        :text="
          mode === 'all'
            ? `「${projectName ?? '当前项目'}」还没有任务`
            : isAll
              ? `「${projectName ?? '当前项目'}」今日无待办事项：可为任务添加「今天做」星标，或将其排期至今日`
              : '当前筛选下无任务'
        "
        :hint="mode === 'all' ? '在「工作大纲」里可以新建任务与子任务' : ''"
      />
    </div>

    <div v-else class="list">
      <TaskCard
        v-for="task in visibleTasks"
        :key="task.id"
        data-field="today-row"
        :task="task"
        :status-name="cardStatus.nameOf(task)"
        :status-color="cardStatus.colorOf(task)"
        :status-style="cardStatus.styleOf(task)"
        :status-options="cardStatus.optionsFor(task)"
        :tags="task.tagNames"
        :badges="mode === 'today' ? badgesFor(task as TodayTaskDto) : []"
        :belongs-to="task.projectName"
        :done="task.statusCategory === 'done'"
        :mutating="board.mutating"
        :today-mark="isMarked(task)"
        :today-busy="markingId !== null"
        :hint="`打开「${task.title}」的详情（属于 ${task.projectName}）`"
        @activate="drawerTaskId = task.id"
        @detail="drawerTaskId = task.id"
        @status="(key: string) => changeStatus(task, key)"
        @toggle-today="(marked: boolean) => toggleToday(task, marked)"
        @remove="() => undefined"
      />
    </div>

    <TaskDrawer v-model:task-id="drawerTaskId" @changed="load" />
  </div>
</template>

<style scoped>
/*
 * 整页是**一维**排布（纵向：头部 → 工具条 → 日志条 → 列表），所以一律用 flex
 * （见技术设计 §33 的约定：一维用 flex，二维网格才用 grid）。
 */
.page {
  display: flex;
  flex-direction: column;
  height: 100%;
  padding: 14px 18px 16px;
  gap: 12px;
  overflow: hidden;
}

/* ---------------- 头部 ---------------- */

.head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
  flex: none;
}

.head-main {
  display: flex;
  flex-direction: column;
  min-width: 0;
}

.title-row {
  display: flex;
  align-items: baseline;
  gap: 10px;
  flex-wrap: wrap;
}

.title-row h1 {
  margin: 0;
  font-size: 17px;
  font-weight: 600;
}

.date {
  font-size: 12.5px;
}

.sub {
  margin: 4px 0 0;
  font-size: 12.5px;
}

/* 打卡卡片：数字是主角，所以它比其它文字大得多，并且用等宽字体（跳动时宽度不抖） */
.clock-card {
  flex: none;
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  gap: 2px;
  padding: 8px 12px;
  border: 1px solid var(--pm-border);
  border-radius: 10px;
  background: var(--pm-surface);
}

.clock-label {
  display: flex;
  align-items: center;
  gap: 5px;
  font-size: 11.5px;
}

.clock-value {
  font-size: 26px;
  font-weight: 600;
  line-height: 1.15;
  font-variant-numeric: tabular-nums;
  letter-spacing: 0.5px;
}

.clock-meta {
  display: flex;
  align-items: center;
  gap: 5px;
  font-size: 11px;
}

/* 计时中的小圆点：只有真的在计时才亮，否则用户会以为一直在打卡 */
.live-dot {
  display: inline-block;
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--pm-success, #18a058);
  margin-right: 2px;
  animation: live-pulse 1.6s ease-in-out infinite;
}

@keyframes live-pulse {
  0%,
  100% {
    opacity: 1;
  }

  50% {
    opacity: 0.35;
  }
}

@media (prefers-reduced-motion: reduce) {
  .live-dot {
    animation: none;
  }
}

/* ---------------- 工具条 ---------------- */

.toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  flex: none;
  flex-wrap: wrap;
}

.filters {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
}

/*
 * 口径切换（今日待办 / 全部任务）：与筛选按钮同一套外观（都是 chip），
 * 但用一条细分隔线与右边的筛选区分开 —— 它们是两个层级的东西：
 * 左边决定"看哪一批"，右边决定"在这批里筛哪一组"。
 */
.modes {
  display: flex;
  align-items: center;
  gap: 6px;
  flex: none;
  padding-right: 10px;
  margin-right: 4px;
  border-right: 1px solid var(--pm-border);
}

.chip {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 4px 10px;
  border: 1px solid var(--pm-border);
  border-radius: 999px;
  background: transparent;
  color: var(--pm-text);
  font-family: inherit;
  font-size: 12px;
  cursor: pointer;
  transition:
    border-color 0.15s ease,
    background 0.15s ease,
    color 0.15s ease;
}

.chip:hover {
  border-color: var(--pm-accent);
}

.chip.is-on {
  border-color: var(--pm-accent);
  background: color-mix(in srgb, var(--pm-accent) 16%, transparent);
  color: var(--pm-accent);
}

.chip-count {
  font-size: 11px;
  font-variant-numeric: tabular-nums;
  opacity: 0.85;
}

.toolbar-right {
  display: flex;
  align-items: center;
  gap: 6px;
}

/* ---------------- 工作日志条 ---------------- */

.log-bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  flex: none;
  flex-wrap: wrap;
  padding: 7px 10px;
  border: 1px solid var(--pm-border);
  border-radius: 8px;
  background: var(--pm-surface);
}

.log-summary {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  font-size: 12px;
  min-width: 0;
}

.chip-static {
  padding: 2px 8px;
  border-radius: 999px;
  background: color-mix(in srgb, var(--pm-text) 8%, transparent);
  font-size: 11.5px;
  white-space: nowrap;
}

.log-saved {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}

.log-saved .path {
  font-size: 11.5px;
  max-width: 420px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  direction: rtl;
  text-align: left;
}

/* ---------------- 列表 ---------------- */

.placeholder {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  min-height: 0;
}

.list {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding-right: 4px;
}

.mono {
  font-family: var(--pm-font-mono, ui-monospace, SFMono-Regular, Menlo, monospace);
}

.faint {
  color: var(--pm-text-faint);
}
</style>
