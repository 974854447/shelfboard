<script setup lang="ts">
/**
 * 日历视图（M2）：按截止日期排期。
 *
 * 设计取舍：
 * 1. **时区口径只在一处**：所有"今天/本周/逾期"都用 `utils/date.ts` 的本地日历天函数算，
 *    服务端只负责"时间戳落没落在区间里"（见该文件的说明）。
 * 2. **一次请求取整屏**：可见的 42 格 + 本周 + 近 14 天柱状图需要的日期区间**取并集**，
 *    一次查回来再在前端分片 —— 三个面板各发一个请求既慢又容易出现口径不一致。
 *    "逾期"是唯一另发的（它的下界是无穷远的过去）。
 * 3. **农历 / 二十四节气 / 法定节假日**：日历上没有农历就不像中国日历（用户要求）。
 *    节假日是**写死的数据表**（`data/holidays.ts`），因为放假安排是国务院每年发通知定的，
 *    算不出来；没内置数据的年份界面上如实说明，不假装。
 * 4. 格子里的任务只放得下"小条"，所以**卡片式的任务卡放在右侧"选中某天"面板里** ——
 *    和工作台、我的待办、搜索是同一个 `TaskCard`（样式与功能一致）。
 */

import { NButton, NInput, NSelect, NSpin, NTag } from 'naive-ui';
import { computed, onMounted, ref, watch } from 'vue';

import AppIcon from '../components/AppIcon.vue';
import EmptyState from '../components/EmptyState.vue';
import TaskCard from '../components/TaskCard.vue';
import TaskDrawer from '../components/TaskDrawer.vue';
import {
  marks as marksApi,
  tasks as tasksApi,
  type CalendarMarkDto,
  type TaskWithProjectDto,
} from '../api/endpoints';
import { useCardStatus } from '../composables/useCardStatus';
import { useFeedback } from '../composables/useFeedback';
import { useBoardStore } from '../stores/board';
import { hasHolidayData, holidayMark, holidayYears, nextHoliday } from '../data/holidays';
import {
  addDays,
  buildMonthGrid,
  describeDue,
  endOfLocalDay,
  formatDayDate,
  formatMonthTitle,
  startOfLocalDay,
  startOfLocalWeek,
  shiftMonth,
} from '../utils/date';
import { lunarDay } from '../utils/lunar';

const board = useBoardStore();
const feedback = useFeedback();
const cardStatus = useCardStatus();

/** 近 14 天柱状图：今天往前 7 天 + 今天往后 6 天 */
const LOAD_BACK_DAYS = 7;
const LOAD_FORWARD_DAYS = 6;

/**
 * 标记的预设颜色。
 *
 * 用几个固定色块而不是取色器：标记是"一眼区分类型"用的（休假蓝、发版绿、生日红…），
 * 让用户从色轮里挑一个往往挑出两种几乎一样的颜色，反而看不清。
 */
const MARK_COLORS = [
  { label: '蓝', value: '#3b82f6' },
  { label: '绿', value: '#22c55e' },
  { label: '橙', value: '#f59e0b' },
  { label: '红', value: '#ef4444' },
  { label: '紫', value: '#a855f7' },
] as const;

const monthAnchor = ref(startOfLocalDay(Date.now()));
const scope = ref<'current' | 'all'>('current');
const loading = ref(false);
/** 可见 42 格 + 近 14 天窗口里的未完成任务 */
const windowTasks = ref<TaskWithProjectDto[]>([]);
const overdueTasks = ref<TaskWithProjectDto[]>([]);
/** 本周的任务（**含已完成**：小结要数"这周做完了几条"） */
const weekTasks = ref<TaskWithProjectDto[]>([]);
const selectedDay = ref(startOfLocalDay(Date.now()));
const drawerTaskId = ref<string | null>(null);

/** 可见区间里的日历标记（自己加的：休假、发版日、生日…） */
const dayMarks = ref<CalendarMarkDto[]>([]);
const markTitle = ref('');
const markColor = ref(MARK_COLORS[0]!.value);
const markBusy = ref(false);

/** 一次渲染固定一个"现在"，避免同一次渲染里跨零点导致"今天"跳变 */
const now = ref(Date.now());

const grid = computed(() => buildMonthGrid(monthAnchor.value));
const today = computed(() => startOfLocalDay(now.value));
const weekStart = computed(() => startOfLocalWeek(now.value));
const weekEnd = computed(() => addDays(weekStart.value, 7) - 1);

/** 要查询的日期区间：三处需求的并集（见文件头第 2 条） */
const queryRange = computed(() => {
  const cells = buildMonthGrid(monthAnchor.value);
  const gridStart = cells[0]!.ts;
  const gridEnd = addDays(cells[cells.length - 1]!.ts, 1) - 1;
  const backStart = addDays(today.value, -LOAD_BACK_DAYS);
  const forwardEnd = addDays(today.value, LOAD_FORWARD_DAYS);
  return {
    dueFrom: startOfLocalDay(Math.min(gridStart, backStart, weekStart.value)),
    dueTo: endOfLocalDay(Math.max(gridEnd, forwardEnd, weekEnd.value)),
  };
});

async function load(): Promise<void> {
  loading.value = true;
  now.value = Date.now();
  try {
    const common = {
      onlyOpen: true,
      ...(scope.value === 'current' && board.currentProjectId
        ? { projectIds: board.currentProjectId }
        : {}),
    };
    const [windowResult, overdue, week] = await Promise.all([
      tasksApi.acrossProjects({ ...common, ...queryRange.value, limit: 1000 }),
      tasksApi.acrossProjects({ ...common, dueTo: startOfLocalDay(Date.now()) - 1, limit: 200 }),
      /*
       * 本周**不带 onlyOpen**：小结要显示"这周做完了几条"，
       * 只看未完成的话那个数字永远是 0，等于没做这个面板。
       */
      tasksApi.acrossProjects({
        ...(common.projectIds ? { projectIds: common.projectIds } : {}),
        dueFrom: weekStart.value,
        dueTo: weekEnd.value,
        limit: 500,
      }),
    ]);
    windowTasks.value = windowResult.items;
    overdueTasks.value = overdue.items;
    weekTasks.value = week.items;
    cardStatus.mergeStatuses([...windowResult.statuses, ...overdue.statuses, ...week.statuses]);
    await loadMarks();
  } catch (error) {
    feedback.failure(error, '加载日历失败');
  } finally {
    loading.value = false;
  }
}

/**
 * 取可见区间的日历标记。
 *
 * 和任务一起查：标记是**按天**的，和 42 格用同一个区间，
 * 所以翻月一次请求就能把格子和标记一起换掉。
 * 增删标记之后**只重查标记**（`loadMarks`），不重查任务 ——
 * 加一条"休假"不该让整月的任务列表重新拉一遍。
 */
async function loadMarks(): Promise<void> {
  try {
    /*
     * 参数名是 `from` / `to`（标记存的是"某天本地零点"），
     * 与任务的 `dueFrom` / `dueTo`（存的是时刻）分开命名。
     * 区间直接复用 `queryRange` 的边界：标记的零点必然落在
     * `[startOfLocalDay(…), endOfLocalDay(…)]` 里，闭区间两边都含。
     */
    const result = await marksApi.list({
      from: queryRange.value.dueFrom,
      to: queryRange.value.dueTo,
    });
    dayMarks.value = result.items;
  } catch (error) {
    feedback.failure(error, '加载标记失败');
  }
}

/** 本月任务按"本地日"分组，日历格子直接查表 */
const byDay = computed(() => {
  const map = new Map<number, TaskWithProjectDto[]>();
  for (const task of windowTasks.value) {
    if (task.dueDate === null) continue;
    const key = startOfLocalDay(task.dueDate);
    const bucket = map.get(key);
    if (bucket) bucket.push(task);
    else map.set(key, [task]);
  }
  return map;
});

const stats = computed(() => ({
  overdue: overdueTasks.value.length,
  today: (byDay.value.get(today.value) ?? []).length,
  week: weekTasks.value.filter(
    (task) => task.dueDate !== null && task.dueDate >= weekStart.value && task.dueDate <= weekEnd.value,
  ).length,
}));

function tasksOfDay(ts: number): TaskWithProjectDto[] {
  return byDay.value.get(ts) ?? [];
}

/* ------------------------------------------------------------------ */
/* 日历标记：自己加的那些"这天有件事"                                  */
/* ------------------------------------------------------------------ */

/** 标记按"本地日"分组，格子直接查表（与任务同一套口径，见 utils/date.ts） */
const marksByDay = computed(() => {
  const map = new Map<number, CalendarMarkDto[]>();
  for (const mark of dayMarks.value) {
    const key = startOfLocalDay(mark.date);
    const bucket = map.get(key);
    if (bucket) bucket.push(mark);
    else map.set(key, [mark]);
  }
  return map;
});

function marksOfDay(ts: number): CalendarMarkDto[] {
  return marksByDay.value.get(ts) ?? [];
}

/** 格子里最多显示 2 条，再多就说"+N"——格子只有 100 多像素高 */
const MARKS_PER_CELL = 2;

const selectedMarks = computed(() => marksOfDay(selectedDay.value));

function markStyle(mark: CalendarMarkDto): Record<string, string> {
  return {
    color: mark.color,
    background: `color-mix(in srgb, ${mark.color} 18%, transparent)`,
  };
}

async function addMark(): Promise<void> {
  const title = markTitle.value.trim();
  if (title.length === 0) return;

  markBusy.value = true;
  try {
    await marksApi.create({ date: selectedDay.value, title, color: markColor.value });
    markTitle.value = '';
    await loadMarks();
    feedback.success(`已给 ${formatDayDate(selectedDay.value)} 加上「${title}」`);
  } catch (error) {
    feedback.failure(error, '添加标记失败');
  } finally {
    markBusy.value = false;
  }
}

async function removeMark(mark: CalendarMarkDto): Promise<void> {
  markBusy.value = true;
  try {
    await marksApi.remove(mark.id);
    await loadMarks();
    feedback.success(`已删除标记「${mark.title}」`);
  } catch (error) {
    feedback.failure(error, '删除标记失败');
  } finally {
    markBusy.value = false;
  }
}

/** 这一天有几条**已经逾期**的未完成任务（格子上点红点用） */
function overdueOfDay(ts: number): number {
  if (ts >= today.value) return 0;
  return tasksOfDay(ts).length;
}

/* ------------------------------------------------------------------ */
/* 农历 / 节气 / 法定节假日                                            */
/* ------------------------------------------------------------------ */

const WEEKDAY_CN = ['日', '一', '二', '三', '四', '五', '六'];

function weekdayOf(ts: number): string {
  return `周${WEEKDAY_CN[new Date(ts).getDay()]}`;
}

function isWeekend(ts: number): boolean {
  const day = new Date(ts).getDay();
  return day === 0 || day === 6;
}

/**
 * 格子上那一行小字：**法定节假日 > 节气 > 农历节日 > 农历日**
 * （农历那一层在 utils/lunar.ts 里定死，这里只把放假安排插到最前面）。
 */
function dayLabel(ts: number): { text: string; tone: 'holiday' | 'festival' | 'normal' } {
  const mark = holidayMark(ts);
  if (mark?.kind === 'holiday') return { text: mark.name, tone: 'holiday' };
  const lunar = lunarDay(ts);
  if (lunar.festival) return { text: lunar.label, tone: 'festival' };
  return { text: lunar.label, tone: 'normal' };
}

function isHoliday(ts: number): boolean {
  return holidayMark(ts)?.kind === 'holiday';
}

function isMakeupWorkday(ts: number): boolean {
  return holidayMark(ts)?.kind === 'workday';
}

/** 选中那天面板的标题：9月26日 周六 · 八月十六（放假时补上"假期第 N 天"） */
const selectedTitle = computed(() => dayTitle(selectedDay.value));

/** 任意一天的完整说明（格子悬停提示，也用作标题） */
function dayTitle(ts: number): string {
  const lunar = lunarDay(ts);
  const mark = holidayMark(ts);
  const base = `${formatDayDate(ts)} ${weekdayOf(ts)} · ${lunar.lunarMonth}${lunar.lunarDay}`;
  if (mark?.kind === 'holiday') return `${base} · ${mark.name}假期第 ${mark.index}/${mark.total} 天`;
  if (mark?.kind === 'workday') return `${base} · 调休上班`;
  return base;
}

const selectedTasks = computed(() => tasksOfDay(selectedDay.value));

/* ------------------------------------------------------------------ */
/* 本周小结 / 近 14 天 / 项目分布 / 下一个节日                          */
/* ------------------------------------------------------------------ */

const weekSummary = computed(() => {
  const tasks = weekTasks.value.filter(
    (task) => task.dueDate !== null && task.dueDate >= weekStart.value && task.dueDate <= weekEnd.value,
  );
  const done = tasks.filter((task) => task.statusCategory === 'done');
  const open = tasks.filter((task) => task.statusCategory !== 'done');
  const late = open.filter((task) => task.dueDate !== null && task.dueDate < today.value);
  return {
    total: tasks.length,
    done: done.length,
    open: open.length,
    late: late.length,
    percent: tasks.length === 0 ? 0 : Math.round((done.length / tasks.length) * 100),
    range: `${formatDayDate(weekStart.value)} – ${formatDayDate(weekEnd.value)}`,
  };
});

/** 近 14 天：每天到期的未完成任务数（柱状图） */
const load14 = computed(() => {
  const days: Array<{ ts: number; count: number; holiday: string | null }> = [];
  for (let offset = -LOAD_BACK_DAYS; offset <= LOAD_FORWARD_DAYS; offset += 1) {
    const ts = addDays(today.value, offset);
    const mark = holidayMark(ts);
    days.push({
      ts,
      count: tasksOfDay(ts).length,
      holiday: mark?.kind === 'holiday' ? mark.name : null,
    });
  }
  const max = Math.max(1, ...days.map((day) => day.count));
  return { days, max };
});

/** 项目分布：**当月**的任务按项目点数（格子里显示的是这个月，面板跟着它走） */
const projectBreakdown = computed(() => {
  const anchor = new Date(monthAnchor.value);
  const anchorKey = `${anchor.getFullYear()}-${anchor.getMonth()}`;
  const counts = new Map<string, { name: string; count: number }>();
  for (const task of windowTasks.value) {
    if (task.dueDate === null) continue;
    const due = new Date(task.dueDate);
    // 比"年-月"而不是只比月：跨年的那个月（1 月/12 月）光比月会把去年的算进来
    if (`${due.getFullYear()}-${due.getMonth()}` !== anchorKey) continue;
    const entry = counts.get(task.projectId);
    if (entry) entry.count += 1;
    else counts.set(task.projectId, { name: task.projectName, count: 1 });
  }
  const list = [...counts.values()].sort((a, b) => b.count - a.count);
  const max = Math.max(1, ...list.map((item) => item.count));
  return { list, max, total: list.reduce((sum, item) => sum + item.count, 0) };
});

/** 下一个假期（含"今天正在假期里"） */
const upcoming = computed(() => nextHoliday(today.value));

/**
 * 假期的说法。**正在放假时说"还在放假"**，而不是"还有 -1 天"——
 * 9 月 26 日问"下一个假期"，答案是"你正在过中秋节（还剩 2 天）"。
 */
const holidayPhrase = computed(() => {
  const item = upcoming.value;
  if (!item) return '';
  if (item.daysUntil > 0) return `距离「${item.name}」还有 ${item.daysUntil} 天`;
  if (item.daysUntil === 0) return `「${item.name}」今天开始，共 ${item.totalDays} 天`;
  return `「${item.name}」假期中 · 还剩 ${item.daysLeft} 天`;
});

const holidayDataHint = computed(() => {
  const year = new Date(monthAnchor.value).getFullYear();
  if (hasHolidayData(year)) return null;
  return `${year} 年还没有内置的放假日程（内置：${holidayYears().join('、')} 年）`;
});

/* ------------------------------------------------------------------ */

function selectDay(ts: number): void {
  selectedDay.value = startOfLocalDay(ts);
}

function goToday(): void {
  monthAnchor.value = startOfLocalDay(Date.now());
  selectDay(Date.now());
}

async function changeStatus(task: TaskWithProjectDto, statusId: string): Promise<void> {
  if (task.statusId === statusId) return;
  const updated = await board.updateTask(task.id, { statusId });
  if (!updated) return;
  feedback.success(`「${task.title}」已改为「${cardStatus.nameById(statusId)}」`);
  await load();
}

function openTask(task: TaskWithProjectDto): void {
  selectDay(task.dueDate ?? Date.now());
  drawerTaskId.value = task.id;
}

watch([monthAnchor, scope], () => void load());
onMounted(load);
</script>

<template>
  <!-- `data-view` 是给 E2E 的语义标记：判断"路由内容真的挂载了"（约定见 docs/technical-design.md 的 E2E 一节） -->
  <div class="page" data-view="calendar">
    <header class="head">
      <div class="left">
        <h1>{{ formatMonthTitle(monthAnchor) }}</h1>
        <NButton size="small" quaternary data-field="cal-prev" @click="monthAnchor = shiftMonth(monthAnchor, -1)">
          <template #icon><AppIcon name="chevronLeft" :size="14" /></template>
        </NButton>
        <NButton size="small" quaternary data-field="cal-next" @click="monthAnchor = shiftMonth(monthAnchor, 1)">
          <template #icon><AppIcon name="chevronRight" :size="14" /></template>
        </NButton>
        <NButton size="small" data-field="cal-today" @click="goToday">今天</NButton>
        <span v-if="upcoming" class="countdown" data-field="cal-countdown-inline">
          {{ holidayPhrase }}
        </span>
      </div>

      <div class="right">
        <NTag size="small" :bordered="false" type="error" data-field="cal-stat-overdue">
          逾期 {{ stats.overdue }}
        </NTag>
        <NTag size="small" :bordered="false" type="warning" data-field="cal-stat-today">
          今天 {{ stats.today }}
        </NTag>
        <NTag size="small" :bordered="false" data-field="cal-stat-week">本周 {{ stats.week }}</NTag>
        <NSelect
          v-model:value="scope"
          size="small"
          style="width: 150px"
          data-field="cal-scope"
          :options="[
            { label: '当前项目', value: 'current' },
            { label: '全部项目', value: 'all' },
          ]"
        />
      </div>
    </header>

    <div class="body">
      <section class="calendar" :class="{ loading }">
        <div class="weekdays">
          <span v-for="label in ['一', '二', '三', '四', '五', '六', '日']" :key="label">{{ label }}</span>
        </div>

        <div class="grid">
          <div
            v-for="cell in grid"
            :key="cell.ts"
            class="day"
            :class="{
              dim: !cell.inMonth,
              today: cell.ts === today,
              selected: cell.ts === selectedDay,
              weekend: isWeekend(cell.ts),
              holiday: isHoliday(cell.ts),
              workday: isMakeupWorkday(cell.ts),
            }"
            data-field="cal-cell"
            :title="`${dayTitle(cell.ts)}${tasksOfDay(cell.ts).length > 0 ? ` · ${tasksOfDay(cell.ts).length} 条到期` : ''}`"
            @click="selectDay(cell.ts)"
          >
            <div class="day-head">
              <span class="num">{{ new Date(cell.ts).getDate() }}</span>
              <!-- 农历 / 节气 / 节日：一行小字，放不下就省略 -->
              <span class="lunar" :class="dayLabel(cell.ts).tone" data-field="cal-lunar">
                {{ dayLabel(cell.ts).text }}
              </span>
              <span v-if="isMakeupWorkday(cell.ts)" class="badge work">班</span>
              <span v-else-if="isHoliday(cell.ts)" class="badge rest">休</span>
              <span v-if="overdueOfDay(cell.ts) > 0" class="late-dot" title="这一天有逾期的任务" />
            </div>

            <!--
              自己加的标记：放在任务条**上面**。它是"这天有件事"的提示，
              和"这天要交什么"是两回事，所以视觉上也分开（圆角药丸 + 自己的颜色）。
            -->
            <span
              v-for="mark in marksOfDay(cell.ts).slice(0, MARKS_PER_CELL)"
              :key="mark.id"
              class="mark"
              data-field="cal-mark"
              :style="markStyle(mark)"
              :title="mark.note ? `${mark.title} · ${mark.note}` : mark.title"
            >
              {{ mark.title }}
            </span>
            <span v-if="marksOfDay(cell.ts).length > MARKS_PER_CELL" class="more">
              还有 {{ marksOfDay(cell.ts).length - MARKS_PER_CELL }} 个标记
            </span>

            <button
              v-for="task in tasksOfDay(cell.ts).slice(0, 3)"
              :key="task.id"
              class="chip"
              :title="`${task.title}（${task.projectName}）· ${describeDue(task.dueDate!, now)}`"
              @click.stop="openTask(task)"
            >
              <i :style="{ background: cardStatus.colorOf(task) }" />
              <span class="chip-title">{{ task.title }}</span>
            </button>

            <span v-if="tasksOfDay(cell.ts).length > 3" class="more" data-field="cal-more">
              还有 {{ tasksOfDay(cell.ts).length - 3 }} 条
            </span>
          </div>
        </div>

        <div v-if="loading" class="spin"><NSpin size="small" /></div>
      </section>

      <!--
        右侧面板：一维竖排（弹性盒子），每个面板自己是一块卡片。
        面板顺序按"我现在要看什么"排：刚点的那天 → 逾期 → 本周 → 近 14 天 → 项目分布 → 假期。
      -->
      <aside class="side">
        <section class="panel" data-field="cal-day-panel">
          <h2>
            <span class="panel-title">{{ selectedTitle }}</span>
            <span class="faint">{{ selectedTasks.length }} 条</span>
          </h2>
          <EmptyState
            v-if="selectedTasks.length === 0"
            compact
            :size="30"
            text="这一天没有到期的任务"
            hint="请选择其他日期，或点击「今天」返回当日"
          />
          <div v-else class="panel-cards">
            <TaskCard
              v-for="task in selectedTasks"
              :key="task.id"
              data-field="cal-day-task"
              :task="task"
              :status-name="cardStatus.nameOf(task)"
              :status-color="cardStatus.colorOf(task)"
              :status-style="cardStatus.styleOf(task)"
              :status-options="cardStatus.optionsFor(task)"
              :tags="task.tagNames"
              :belongs-to="task.projectName"
              :done="task.statusCategory === 'done'"
              :mutating="board.mutating"
              :hint="`打开「${task.title}」的详情（属于 ${task.projectName}）`"
              @activate="openTask(task)"
              @detail="openTask(task)"
              @status="(key: string) => changeStatus(task, key)"
              @remove="() => undefined"
            />
          </div>
        </section>

        <!--
          标记**单独一块面板**（用户 2026-09-25：「把这个单独做一个框展示，间距放大一点」）。
          第一版把它混在「选中某天」里，输入框紧贴在任务列表上方：
          它既不像任务、也不像提示，看着像是列表的一部分，点起来也挤。
          单独成框之后层次清楚了：这块框回答的是"这一天除了任务，还有什么"。
        -->
        <section class="panel mark-panel" data-field="cal-mark-panel">
          <h2>
            <span class="panel-title">标记</span>
            <span class="faint">{{ formatDayDate(selectedDay) }} {{ weekdayOf(selectedDay) }}</span>
          </h2>

          <div class="marks" data-field="cal-day-marks">
            <span
              v-for="mark in selectedMarks"
              :key="mark.id"
              class="mark-chip"
              data-field="cal-mark-item"
              :style="markStyle(mark)"
            >
              {{ mark.title }}
              <button
                type="button"
                class="mark-x"
                data-field="cal-mark-remove"
                :title="`删除标记「${mark.title}」`"
                @click="removeMark(mark)"
              >
                ×
              </button>
            </span>
            <span v-if="selectedMarks.length === 0" class="faint">这天还没有标记</span>
          </div>

          <div class="mark-add">
            <NInput
              v-model:value="markTitle"
              size="small"
              :maxlength="40"
              placeholder="发版、休假、生日…"
              data-field="cal-mark-input"
              @keydown.enter="addMark"
            />
            <NButton
              size="small"
              type="primary"
              :disabled="markTitle.trim().length === 0"
              :loading="markBusy"
              data-field="cal-mark-add"
              @click="addMark"
            >
              添加
            </NButton>
          </div>

          <div class="swatches" data-field="cal-mark-colors">
            <span class="faint swatch-label">颜色</span>
            <button
              v-for="option in MARK_COLORS"
              :key="option.value"
              type="button"
              class="swatch"
              :class="{ on: markColor === option.value }"
              :style="{ background: option.value }"
              :title="`${option.label}色标记`"
              :aria-label="`${option.label}色标记`"
              @click="markColor = option.value"
            />
          </div>
        </section>

        <section class="panel" data-field="cal-overdue-panel">
          <h2>
            <span class="panel-title">逾期</span>
            <span class="faint">{{ overdueTasks.length }} 条</span>
          </h2>
          <EmptyState v-if="overdueTasks.length === 0" compact :size="30" text="没有逾期的任务" />
          <div v-else class="panel-cards">
            <TaskCard
              v-for="task in overdueTasks.slice(0, 8)"
              :key="task.id"
              data-field="cal-overdue-task"
              :task="task"
              :status-name="cardStatus.nameOf(task)"
              :status-color="cardStatus.colorOf(task)"
              :status-style="cardStatus.styleOf(task)"
              :status-options="cardStatus.optionsFor(task)"
              :tags="task.tagNames"
              :belongs-to="task.projectName"
              :mutating="board.mutating"
              :hint="`打开「${task.title}」的详情（属于 ${task.projectName}）`"
              @activate="openTask(task)"
              @detail="openTask(task)"
              @status="(key: string) => changeStatus(task, key)"
              @remove="() => undefined"
            />
          </div>
        </section>

        <section class="panel" data-field="cal-week-panel">
          <h2>
            <span class="panel-title">本周小结</span>
            <span class="faint">{{ weekSummary.range }}</span>
          </h2>
          <div class="rows">
            <div class="row"><span>本周到期</span><b>{{ weekSummary.total }}</b></div>
            <div class="row"><span>已完成</span><b class="ok">{{ weekSummary.done }}</b></div>
            <div class="row"><span>未完成</span><b>{{ weekSummary.open }}</b></div>
            <div class="row"><span>其中已逾期</span><b :class="{ danger: weekSummary.late > 0 }">{{ weekSummary.late }}</b></div>
          </div>
          <div class="track" :title="`完成度 ${weekSummary.percent}%`">
            <i :style="{ width: `${weekSummary.percent}%` }" />
          </div>
          <p class="faint note">完成度 {{ weekSummary.percent }}%（按本周到期任务统计）</p>
        </section>

        <section class="panel" data-field="cal-load-panel">
          <h2>
            <span class="panel-title">近 14 天</span>
            <span class="faint">到期任务数</span>
          </h2>
          <div class="bars" data-field="cal-bars">
            <div
              v-for="day in load14.days"
              :key="day.ts"
              class="bar-col"
              :class="{ today: day.ts === today, holiday: day.holiday !== null }"
              :title="`${formatDayDate(day.ts)}${day.holiday ? ` · ${day.holiday}` : ''} · ${day.count} 条到期`"
            >
              <span class="bar-count">{{ day.count > 0 ? day.count : '' }}</span>
              <span class="bar" :style="{ height: `${Math.round((day.count / load14.max) * 100)}%` }" />
              <span class="bar-label">{{ new Date(day.ts).getDate() }}</span>
            </div>
          </div>
        </section>

        <section class="panel" data-field="cal-project-panel">
          <h2>
            <span class="panel-title">项目分布</span>
            <span class="faint">本月 {{ projectBreakdown.total }} 条</span>
          </h2>
          <EmptyState v-if="projectBreakdown.list.length === 0" compact :size="30" text="本月没有任务" />
          <div v-else class="rows">
            <div v-for="item in projectBreakdown.list" :key="item.name" class="dist" data-field="cal-project-row">
              <div class="dist-head">
                <span class="dist-name" :title="item.name">{{ item.name }}</span>
                <span class="faint">{{ item.count }}</span>
              </div>
              <div class="track"><i :style="{ width: `${Math.round((item.count / projectBreakdown.max) * 100)}%` }" /></div>
            </div>
          </div>
        </section>

        <section class="panel" data-field="cal-holiday-panel">
          <h2>
            <span class="panel-title">下一个假期</span>
            <span class="faint">{{ new Date(today).getFullYear() }} 年</span>
          </h2>
          <template v-if="upcoming">
            <p class="holiday-name">
              {{ upcoming.name }}
              <span v-if="upcoming.daysUntil > 0" class="count">还有 {{ upcoming.daysUntil }} 天</span>
              <span v-else-if="upcoming.daysUntil === 0" class="count">今天开始 · 共 {{ upcoming.totalDays }} 天</span>
              <span v-else class="count">假期中 · 还剩 {{ upcoming.daysLeft }} 天</span>
            </p>
            <p class="faint note">
              {{ formatDayDate(upcoming.from) }} – {{ formatDayDate(upcoming.to) }}
              （共 {{ upcoming.totalDays }} 天）
            </p>
          </template>
          <EmptyState v-else compact :size="30" text="内置的放假日程里没有未来了" />
          <p v-if="holidayDataHint" class="faint note" data-field="cal-holiday-hint">{{ holidayDataHint }}</p>
        </section>
      </aside>
    </div>

    <TaskDrawer v-model:task-id="drawerTaskId" @changed="load" />
  </div>
</template>

<style scoped>
.page {
  display: flex;
  flex-direction: column;
  height: 100%;
  padding: 14px 18px 16px;
  gap: 12px;
  overflow: hidden;
}

.head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  flex-wrap: wrap;
}

.head h1 {
  margin: 0;
  font-size: 16px;
  font-weight: 600;
}

.left,
.right {
  display: flex;
  align-items: center;
  gap: 8px;
}

.countdown {
  font-size: 12px;
  color: var(--pm-text-muted);
}

/*
 * 布局以**弹性盒子**为主（用户要求：「后续样式中多用弹性盒子」）：
 * 页面 = 竖排 flex（标题栏 + 内容），内容 = 横排 flex（日历占满剩余 + 右侧固定宽面板）。
 * 只有**月历本身**用 grid —— 它是真正的二维排布（7 列 × 6 行），
 * 用 flex 反而要自己算宽度与换行，那是 grid 的活。
 */
.body {
  flex: 1;
  min-height: 0;
  display: flex;
  gap: 12px;
}

.calendar {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  min-height: 0;
  border: 1px solid var(--pm-border);
  border-radius: 10px;
  background: var(--pm-surface);
  overflow: hidden;
  position: relative;
}

.weekdays {
  display: grid;
  grid-template-columns: repeat(7, minmax(0, 1fr));
  border-bottom: 1px solid var(--pm-border);
}

.weekdays span {
  padding: 7px 8px;
  font-size: 11.5px;
  color: var(--pm-text-muted);
  text-align: center;
}

/*
 * 表头里周六、周日跟着底色走（单元格用的是同一档灰）：
 * 一条竖着的"周末带"比只在格子里涂色更容易一眼扫到 ——
 * 用户要的就是"一眼看出来哪天不一样"。
 */
.weekdays span:nth-child(6),
.weekdays span:nth-child(7) {
  background: color-mix(in srgb, var(--pm-text-muted) 16%, transparent);
  color: var(--pm-text);
}

.grid {
  flex: 1;
  min-height: 0;
  display: grid;
  grid-template-columns: repeat(7, minmax(0, 1fr));
  grid-auto-rows: minmax(0, 1fr);
  overflow: auto;
}

.day {
  border-right: 1px solid var(--pm-border);
  border-bottom: 1px solid var(--pm-border);
  padding: 4px 5px;
  display: flex;
  flex-direction: column;
  gap: 3px;
  min-height: 0;
  overflow: hidden;
  cursor: pointer;
}

.day:nth-child(7n) {
  border-right: none;
}

/*
 * 日期底色的四档差异。
 *
 * 用户 2026-09-25 反馈：「你为不同的天数做了颜色差异化，我想你把这个差异调得更明显一些，
 * 现在太淡了」—— 第一版只有 7%~9% 的极淡底色，一屏扫过去几乎分不出哪格是休息日。
 * 现在做两件事：
 * 1. **拉开底色档次**（普通工作日无底色 / 周末 16% / 调休 20% / 放假 24%）；
 * 2. **每一档再配一个不依赖颜色的线索**（日期数字的颜色与字重、右上角「休」「班」角标），
 *    这样即使分不清红蓝，靠数字颜色和角标也能认出来。
 */
.day.dim {
  background: var(--pm-sunken);
  opacity: 0.55;
}

/* 周末：中性灰底 + 日期数字转淡 */
.day.weekend:not(.holiday):not(.workday) {
  background: color-mix(in srgb, var(--pm-text-muted) 16%, transparent);
}

.day.weekend:not(.holiday):not(.workday) .num {
  color: var(--pm-text-muted);
}

/* 法定节假日：暖红底 + 红色日期数字 + 「休」角标 */
.day.holiday {
  background: color-mix(in srgb, var(--pm-danger) 24%, transparent);
}

.day.holiday .num {
  color: var(--pm-danger);
}

/* 调休上班的周末：蓝底 + 蓝色日期数字 + 「班」角标（它**不是**休息日） */
.day.workday {
  background: color-mix(in srgb, var(--pm-accent) 20%, transparent);
}

.day.workday .num {
  color: var(--pm-accent);
}

.day.today {
  box-shadow: inset 0 0 0 1px var(--pm-accent);
}

/* 选中的那天：整格描边加重（右侧面板显示的就是它） */
.day.selected {
  box-shadow: inset 0 0 0 2px var(--pm-accent);
}

.day-head {
  display: flex;
  align-items: center;
  gap: 4px;
  font-size: 11.5px;
  color: var(--pm-text-muted);
  min-width: 0;
}

/*
 * 日期数字：整格里最需要"一眼看清"的东西，所以给到 15px（用户 2026-09-25：
 * 「日历中的数字字体调大一些」）。原来 12.5px 和旁边那行农历小字挤在一起，
 * 扫日期时反而要凑近看。农历那行保持 10.5px —— 两者拉开差距，
 * **日期是主体、农历是注解**的层次才立得住。
 */
.day-head .num {
  font-size: 15px;
  font-weight: 600;
  line-height: 1.15;
  color: var(--pm-text);
  flex: none;
}

.day.today .day-head .num {
  color: var(--pm-accent);
}

/* 农历 / 节气 / 节日：一行，放不下就省略号（小格子没办法） */
.lunar {
  min-width: 0;
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 10.5px;
  color: var(--pm-text-faint);
}

.lunar.festival {
  color: var(--pm-text-muted);
}

.lunar.holiday {
  color: var(--pm-danger);
  font-weight: 600;
}

/* 与放大的日期数字一起抬一档：不然「休」「班」会比数字小一圈，像两个时代的排版 */
.badge {
  flex: none;
  padding: 0 4px;
  border-radius: 3px;
  font-size: 10.5px;
  line-height: 15px;
}

.badge.rest {
  background: color-mix(in srgb, var(--pm-danger) 18%, transparent);
  color: var(--pm-danger);
}

.badge.work {
  background: color-mix(in srgb, var(--pm-accent) 18%, transparent);
  color: var(--pm-accent);
}

/* 逾期标记：日期行右端一个红点（格子里已经有任务条了，再加一条会更挤） */
.late-dot {
  flex: none;
  width: 5px;
  height: 5px;
  border-radius: 50%;
  background: var(--pm-danger);
}

.chip {
  display: flex;
  align-items: center;
  gap: 5px;
  width: 100%;
  border: none;
  background: var(--pm-accent-soft);
  border-radius: 5px;
  padding: 2px 5px;
  font: inherit;
  font-size: 11.5px;
  color: var(--pm-text);
  cursor: pointer;
  text-align: left;
  overflow: hidden;
}

.chip:hover {
  background: color-mix(in srgb, var(--pm-accent) 26%, transparent);
}

.chip i {
  flex: none;
  width: 5px;
  height: 5px;
  border-radius: 50%;
}

.chip-title {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.more {
  font-size: 11px;
  color: var(--pm-text-muted);
}

/* ---------------- 日历标记 ---------------- */

/*
 * 格子里的标记：一条药丸，颜色是用户自己选的那一档。
 * 底色用 `color-mix` 20% 而不是实色：同一个颜色在亮/暗主题下都压得住，
 * 也不会比"任务条"更抢眼 —— 任务才是这格里最主要的信息。
 */
.mark {
  display: block;
  width: 100%;
  padding: 0 5px;
  border-radius: 4px;
  font-size: 10.5px;
  line-height: 15px;
  font-weight: 600;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/*
 * 标记面板：**单独一块框**，内部的间距比别的面板大一号
 * （用户：「把这个单独做一个框展示，间距放大一点」）。
 * 输入框、颜色、已有标记分成三行，彼此留 10px —— 原来挤成一块，
 * 看着像是任务列表的一部分。
 */
.mark-panel {
  gap: 10px;
  padding: 12px;
}

.mark-panel h2 {
  padding-bottom: 2px;
}

/* 已有的标记：药丸 + 行内删除，一行放不下就换行 */
.marks {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  align-items: center;
  min-height: 26px;
}

.mark-chip {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 3px 6px 3px 10px;
  border-radius: 12px;
  font-size: 12.5px;
  font-weight: 600;
}

.mark-x {
  border: none;
  background: none;
  padding: 0 3px;
  color: inherit;
  font: inherit;
  font-size: 14px;
  line-height: 1;
  cursor: pointer;
  opacity: 0.6;
}

.mark-x:hover {
  opacity: 1;
}

.mark-add {
  display: flex;
  align-items: center;
  gap: 10px;
}

.swatches {
  display: flex;
  align-items: center;
  gap: 12px;
}

.swatch-label {
  margin-right: 2px;
}

/* 颜色点：选中的那个套一圈描边（不靠颜色本身表达"选中"），点起来也够大 */
.swatch {
  width: 18px;
  height: 18px;
  padding: 0;
  border: none;
  border-radius: 50%;
  cursor: pointer;
  box-shadow: 0 0 0 1px var(--pm-border);
}

.swatch:hover {
  box-shadow: 0 0 0 2px var(--pm-border-strong);
}

.swatch.on {
  box-shadow:
    0 0 0 2px var(--pm-surface),
    0 0 0 4px var(--pm-accent);
}

.spin {
  position: absolute;
  right: 10px;
  bottom: 8px;
}

/* ---------------- 右侧面板 ---------------- */

.side {
  flex: none;
  width: 300px;
  display: flex;
  flex-direction: column;
  gap: 10px;
  overflow-y: auto;
  padding-right: 2px;
}

.panel {
  display: flex;
  flex-direction: column;
  gap: 6px;
  border: 1px solid var(--pm-border);
  border-radius: 10px;
  background: var(--pm-surface);
  padding: 10px;
}

.panel h2 {
  margin: 0;
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 8px;
  font-size: 13px;
  font-weight: 600;
}

.panel-title {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* 面板里的卡片列表自己滚动：一天十几条也不会把整个右栏顶下去 */
.panel-cards {
  display: flex;
  flex-direction: column;
  gap: 8px;
  max-height: 320px;
  overflow-y: auto;
}

.rows {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.row,
.dist-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  font-size: 12px;
}

.row b {
  font-weight: 600;
}

.row b.ok {
  color: var(--pm-ok);
}

.row b.danger {
  color: var(--pm-danger);
}

.dist {
  display: flex;
  flex-direction: column;
  gap: 3px;
}

.dist-name {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.track {
  height: 4px;
  border-radius: 3px;
  background: var(--pm-sunken);
  overflow: hidden;
}

.track > i {
  display: block;
  height: 100%;
  border-radius: 3px;
  background: var(--pm-accent);
  transition: width 0.3s ease;
}

/* 近 14 天柱状图：横排 flex，高度按最大值归一 */
.bars {
  display: flex;
  align-items: flex-end;
  gap: 3px;
  height: 84px;
}

.bar-col {
  flex: 1;
  min-width: 0;
  height: 100%;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: flex-end;
  gap: 2px;
}

/* 「近 14 天」柱状图上的数字也一起放大：9.5px 在 125% 缩放下基本看不清了 */
.bar-count {
  font-size: 11px;
  color: var(--pm-text-muted);
  line-height: 12px;
}

.bar {
  width: 100%;
  min-height: 2px;
  border-radius: 3px 3px 0 0;
  background: color-mix(in srgb, var(--pm-accent) 45%, transparent);
}

.bar-col.today .bar {
  background: var(--pm-accent);
}

.bar-col.holiday .bar {
  background: color-mix(in srgb, var(--pm-danger) 55%, transparent);
}

.bar-col.today .bar-label {
  color: var(--pm-accent);
  font-weight: 600;
}

.bar-label {
  font-size: 11px;
  color: var(--pm-text-muted);
  line-height: 13px;
}

.holiday-name {
  margin: 0;
  display: flex;
  align-items: baseline;
  gap: 8px;
  font-size: 14px;
  font-weight: 600;
}

.holiday-name .count {
  font-size: 12px;
  font-weight: 400;
  color: var(--pm-accent);
}

.note {
  margin: 0;
  font-size: 11px;
}

.faint {
  color: var(--pm-text-faint);
  font-size: 11.5px;
}
</style>
