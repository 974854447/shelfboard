<script setup lang="ts">
/**
 * 任务卡（共用组件）。
 *
 * **样式与行为和工作台里的卡片完全一致**（用户 2026-09-25 要求：
 * 「任务卡片与工作台中的任务卡片一致，且功能也是一致」）：
 * 状态点、两行标题封顶、阻塞提示、子任务进度条、标签、可点击换状态的状态标签、
 * 悬停从右滑出的「详情」入口，以及 Delete 键删除。
 *
 * 三个使用方各自决定"点卡片做什么"：
 * - 工作台：进入它的下一层（叶子卡不进层，所以 `enterable` 为 false 时光标是箭头）；
 * - 我的待办 / 搜索：打开详情（这些页面没有"层"的概念）。
 *
 * 状态名、状态色、状态下拉项都由使用方传进来：**状态是每个项目自定义的**，
 * 组件自己不去查全局状态表（那是项目上下文的事）。
 */

import { NDropdown } from 'naive-ui';
import { computed } from 'vue';

import AppIcon from './AppIcon.vue';

/** 卡片需要的任务字段（TaskDto / TaskWithProjectDto 都满足） */
export interface TaskCardTask {
  id: string;
  title: string;
  statusId: string | null;
  childCount: number;
  doneChildCount: number;
  blockedByCount: number;
  /** 标签 id（卡片本身用不上，只是让"任务 DTO"这一族类型都能直接传进来；
   *  要显示的名字走 `tags` 属性，因为跨项目列表里名字已经跟着数据回来了） */
  tagIds?: string[];
}

const props = withDefaults(
  defineProps<{
    task: TaskCardTask;
    /** 状态名与颜色：由使用方按当前项目解析好 */
    statusName: string;
    statusColor: string;
    statusStyle: Record<string, string>;
    statusOptions: Array<{ label: string; key: string }>;
    /** 已解析成名字的标签 */
    tags?: string[];
    /** 搜索结果专用：它属于哪个主任务 */
    belongsTo?: string | null;
    /** 点卡片是否"能进去"（叶子卡为 false：光标变箭头，且不会白点一趟） */
    enterable?: boolean;
    /** 是否已完成（标题加删除线） */
    done?: boolean;
    /** 保存中：状态标签不可点 */
    mutating?: boolean;
    /** 悬停提示 */
    hint?: string;
    /**
     * 「今天做」标记的状态。
     *
     * 三态而不是两态：`null` = **这张卡片上不出现这个按钮**。
     * 理由是这个标记只在"今日待办"里有意义（看板、搜索结果里显示一颗星
     * 只会让人问"这星是干嘛的"），所以由使用方决定要不要显示，组件不自己猜。
     */
    todayMark?: boolean | null;
    /** 标记按钮是否正在提交（防连点） */
    todayBusy?: boolean;
    /**
     * 卡片上的**小标签**（今日待办用它表示"这条为什么出现在今天"）。
     *
     * 由使用方传进来而不是组件自己算：这几个标签的含义是页面级的
     * （"今天到期""我标了今天做"只在今日待办里成立），组件不该知道这些规矩。
     * `tone` 用来区分轻重：逾期用警示色、其余保持安静。
     */
    badges?: Array<{ label: string; tone?: 'default' | 'warning' | 'danger'; hint?: string }>;
  }>(),
  {
    tags: () => [],
    belongsTo: null,
    enterable: true,
    done: false,
    mutating: false,
    hint: '',
    todayMark: null,
    todayBusy: false,
    badges: () => [],
  },
);

const emit = defineEmits<{
  /** 点卡片本体（工作台=进层；其它页面=开详情） */
  activate: [];
  /** 点悬停滑出的「详情」 */
  detail: [];
  /** 选了一个新状态 */
  status: [key: string];
  /** 按了 Delete */
  remove: [];
  /** 点「今天做」星标（参数是"点完之后应该是标记还是取消"） */
  toggleToday: [marked: boolean];
}>();

const progress = computed(() => {
  if (props.task.childCount <= 0) return 0;
  return Math.round((props.task.doneChildCount / props.task.childCount) * 100);
});

const shownTags = computed(() => props.tags.slice(0, 3));
</script>

<template>
  <article
    class="wb-card"
    :class="{ 'is-leaf': !enterable, 'is-done': done }"
    :title="hint"
    tabindex="0"
    @click="emit('activate')"
    @keydown.enter.prevent="emit('activate')"
    @keydown.delete.prevent="emit('remove')"
  >
    <div class="wb-card-top">
      <i class="wb-dot" :style="{ background: statusColor }" />
      <span class="wb-title" :title="task.title">{{ task.title }}</span>
      <span
        v-if="task.blockedByCount > 0 && !done"
        class="wb-blocked"
        :title="`有 ${task.blockedByCount} 个前置任务尚未完成`"
      >
        <AppIcon name="alert" :size="11" />
        {{ task.blockedByCount }}
      </span>
    </div>

    <div class="wb-card-meta">
      <span v-if="belongsTo" class="wb-belong" data-field="card-belongs">属于「{{ belongsTo }}」</span>
      <span v-else-if="task.childCount > 0" class="wb-progress">
        <span class="wb-track"><i :style="{ width: `${progress}%` }" /></span>
        {{ task.doneChildCount }}/{{ task.childCount }}
      </span>
      <!--
        「为什么出现在今天」的小标签：放在卡片自己身上，而不是页面底部另起一段清单 ——
        用户看到某条任务时的疑问就在这一行上，答案不该跑到屏幕另一端去对。
      -->
      <span
        v-for="badge in badges"
        :key="badge.label"
        class="wb-badge"
        :class="`is-${badge.tone ?? 'default'}`"
        :title="badge.hint ?? badge.label"
        data-field="card-badge"
        :data-badge="badge.label"
      >
        {{ badge.label }}
      </span>
      <span v-for="name in shownTags" :key="name" class="wb-tag">#{{ name }}</span>
    </div>

    <div class="wb-card-bottom">
      <span class="wb-counts faint">
        {{ task.childCount > 0 ? `${task.childCount} 个子任务` : '没有子任务' }}
      </span>
      <span class="wb-spacer" />

      <!--
        「今天做」星标：用户要求「只需要一个图标按钮，且鼠标悬浮提示添加今日待办」。
        所以只有一个星形按钮，状态靠**实心/空心**区分，提示靠原生 title
        （悬浮即可看到，不需要额外的气泡组件）。
      -->
      <button
        v-if="todayMark !== null"
        class="wb-today"
        :class="{ 'is-on': todayMark }"
        type="button"
        :disabled="todayBusy"
        :aria-pressed="todayMark"
        :title="todayMark ? '取消今日待办' : '添加今日待办'"
        data-field="card-today"
        :data-marked="todayMark ? '1' : '0'"
        @click.stop="emit('toggleToday', !todayMark)"
      >
        <AppIcon :name="todayMark ? 'starFilled' : 'star'" :size="15" />
      </button>

      <NDropdown
        trigger="click"
        :options="statusOptions"
        :disabled="mutating || statusOptions.length === 0"
        @select="(key: string | number) => emit('status', String(key))"
      >
        <button
          class="wb-status"
          type="button"
          title="点击切换状态"
          :style="statusStyle"
          @click.stop
        >
          {{ statusName }}
        </button>
      </NDropdown>
    </div>

    <button
      class="wb-detail-btn"
      type="button"
      title="打开任务详情"
      aria-label="打开任务详情"
      @click.stop="emit('detail')"
    >
      <AppIcon name="detail" :size="19" />
    </button>
  </article>
</template>
