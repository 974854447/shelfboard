<script setup lang="ts">
/**
 * 工作大纲的一个节点（**自递归**组件：子节点就是它自己）。
 *
 * 视觉走的是用户选定的第 4 种样式：**自上而下的树**，父子之间用正交直线 +
 * 圆角拐弯连接（组织架构图那种）。连接线全部由 CSS 伪元素画在 `li` 上，
 * 不手工算坐标 —— 手工算坐标的做法在节点宽度不一（标题长短不同）时必然错位，
 * 而 CSS 的百分比定位天然跟着盒子走。
 *
 * 节点自己**不请求数据、也不写数据**：所有动作都 emit 给 OutlineView，
 * 由它统一调 store / 接口再刷新整棵树。这样"改了之后树是不是最新的"只有一处要保证。
 */

import { NDropdown } from 'naive-ui';
import { computed, nextTick, ref, watch } from 'vue';

import AppIcon from './AppIcon.vue';
import type { TaskDto, WorkflowStatusDto } from '../api/endpoints';

/** 树节点：任务 + 它的子节点 + 它在树里的深度（根层的任务是 1） */
export interface OutlineItem {
  task: TaskDto;
  children: OutlineItem[];
  depth: number;
}

const props = defineProps<{
  item: OutlineItem;
  /** 当前项目的状态表（节点上的状态标签用） */
  statuses: WorkflowStatusDto[];
  /** 已折叠的节点 id 集合 */
  collapsed: Set<string>;
  /** 正在重命名的节点 id 与草稿 */
  editingId: string | null;
  editingDraft: string;
  /** 正在其下新增子任务的节点 id（`null` 表示没有） */
  addingParentId: string | null;
  addingDraft: string;
  /** 写入中（改名/换状态/删除）：期间按钮不可点 */
  mutating: boolean;
}>();

const emit = defineEmits<{
  toggle: [id: string];
  status: [id: string, statusId: string];
  renameStart: [id: string, title: string];
  renameCommit: [id: string, title: string];
  renameCancel: [];
  addStart: [id: string];
  addCommit: [id: string, title: string];
  addCancel: [];
  remove: [id: string];
  open: [id: string];
  editingInput: [value: string];
  addingInput: [value: string];
}>();

const PRIORITY_TEXT: Record<string, string> = {
  urgent: '紧急',
  high: '高',
  medium: '中',
  low: '低',
};

const hasChildren = computed(() => props.item.children.length > 0);
const isCollapsed = computed(() => props.collapsed.has(props.item.task.id));
const isEditing = computed(() => props.editingId === props.item.task.id);

const status = computed(
  () => props.statuses.find((entry) => entry.id === props.item.task.statusId) ?? null,
);
const statusOptions = computed(() =>
  props.statuses.map((entry) => ({ label: entry.name, key: entry.id })),
);
const priorityText = computed(() => PRIORITY_TEXT[props.item.task.priority] ?? props.item.task.priority);
const isDone = computed(() => status.value?.category === 'done');

/*
 * 输入框自动聚焦。
 *
 * 不用 HTML 的 `autofocus`：它只在**首次解析文档**时可靠，而这两个输入框是
 * 点按钮之后才插进 DOM 的 —— 在那种场景下 Chrome 多数时候不聚焦，
 * 结果就是"点了重命名却要再点一次输入框"。这里显式在渲染完成后 focus。
 */
const renameInput = ref<HTMLInputElement | null>(null);
const addInput = ref<HTMLInputElement | null>(null);

watch(
  () => props.editingId === props.item.task.id,
  (isEditingNow) => {
    if (isEditingNow) void nextTick(() => renameInput.value?.focus());
  },
);

watch(
  () => props.addingParentId === props.item.task.id,
  (isAddingHere) => {
    if (isAddingHere) void nextTick(() => addInput.value?.focus());
  },
);
</script>

<template>
  <li class="on-node" :data-task-id="item.task.id" :data-depth="item.depth">
    <!--
      连接线的两个半段（见文件头注释）：
      `::before` 画左半段横线（最后一个子节点额外借此画向下的竖线，带圆角），
      `::after` 画右半段横线（非最后一个节点借此画向下的竖线）。
      首个/末个节点分别去掉多余的那一段，否则树的两端会多出两截悬空的线。
    -->
    <!--
      整张卡片可点：**点它就是打开任务详情**（用户 2026-10-02）。
      所以卡片上的「详情」图标按钮删掉了 —— 同一件事不需要两个入口。

      卡片内的**交互元素必须自己 `.stop`**，否则点它们会顺带开详情：
      折叠箭头、状态标签、悬停操作按钮、新增子任务的输入框、就地重命名的输入框。
      这条在 e2e 里有一条断言盯着（点折叠箭头之后不能弹出详情抽屉）。

      键盘那条用的是 `.self` 而不是 `.stop`：卡片里的输入框按下回车时，键事件**会冒泡**
      到卡片上（`.prevent` 只挡默认行为，不挡冒泡）—— 于是"在输入框里敲回车新建子任务"
      会顺带弹出详情抽屉。`.self` 要求事件目标就是卡片本身，输入框里的回车就不会误触发。
      这条是 e2e 实跑出来的：新建子任务之后点重命名没反应，只因为详情抽屉已经挡在上面了。
    -->
    <div
      class="on-card"
      :class="{ 'is-done': isDone, 'is-collapsed': isCollapsed }"
      role="button"
      tabindex="0"
      data-field="outline-card"
      :title="`打开「${item.task.title}」的详情`"
      @click="emit('open', item.task.id)"
      @keydown.enter.self.prevent="emit('open', item.task.id)"
    >
      <div class="on-top">
        <button
          v-if="hasChildren"
          class="on-caret"
          type="button"
          :title="isCollapsed ? `展开 ${item.children.length} 个子任务` : '折叠子任务'"
          :aria-expanded="!isCollapsed"
          :data-field="`outline-caret-${item.task.id}`"
          @click.stop="emit('toggle', item.task.id)"
        >
          <AppIcon :name="isCollapsed ? 'chevronRight' : 'chevronDown'" :size="13" />
        </button>
        <!--
          没有子任务时这里**什么都不放**（用户 2026-09-30：「还是直接去掉这块空白吧，当没有子任务时」）。
          曾经放了一个和折叠箭头等宽的占位，好让所有标题左缘对齐 ——
          但为了对齐留下 17px 空白，换来的是叶子标题被顶到右边、可用宽度还少一截，
          不划算：叶子节点的标题直接顶到卡片左内边距更清爽，也少一次折行风险。
        -->

        <!--
          这里原来还有一个状态点。去掉了（用户 2026-09-30：「直接去掉前面的点」）：
          它占掉 13px 把标题挤到换行，而状态在下面那行本来就有带底色的标签，属于重复表达。
        -->

        <!-- 就地重命名：双击标题或点铅笔按钮都进这个输入框 -->
        <input
          v-if="isEditing"
          ref="renameInput"
          class="on-input"
          :value="editingDraft"
          data-field="outline-rename-input"
          @click.stop
          @input="emit('editingInput', ($event.target as HTMLInputElement).value)"
          @keydown.enter.prevent="emit('renameCommit', item.task.id, editingDraft)"
          @keydown.esc.prevent="emit('renameCancel')"
          @blur="emit('renameCommit', item.task.id, editingDraft)"
        />
        <span
          v-else
          class="on-title"
          :title="item.task.title"
          data-field="outline-title"
          @dblclick.stop="emit('renameStart', item.task.id, item.task.title)"
        >
          {{ item.task.title }}
        </span>

        <span
          v-if="item.task.blockedByCount > 0 && !isDone"
          class="on-blocked"
          :title="`有 ${item.task.blockedByCount} 个前置任务尚未完成`"
        >
          <AppIcon name="alert" :size="11" />
          {{ item.task.blockedByCount }}
        </span>
      </div>

      <div class="on-meta">
        <NDropdown
          trigger="click"
          :options="statusOptions"
          :disabled="mutating || statusOptions.length === 0"
          @select="(key: string | number) => emit('status', item.task.id, String(key))"
        >
          <button
            class="on-status"
            type="button"
            title="点击切换状态"
            data-field="outline-status"
            :style="{
              color: status?.color ?? 'var(--pm-text-faint)',
              background: `color-mix(in srgb, ${status?.color ?? 'var(--pm-text-faint)'} 15%, transparent)`,
            }"
            @click.stop
          >
            {{ status?.name ?? '未设置状态' }}
          </button>
        </NDropdown>

        <span class="on-priority" :data-level="item.task.priority">{{ priorityText }}</span>

        <span v-if="item.task.childCount > 0" class="on-count faint">
          {{ item.task.doneChildCount }}/{{ item.task.childCount }} 子任务
        </span>
        <span v-else class="on-count faint">无子任务</span>

        <!--
          悬停操作：加子任务 / 重命名 / 删除。
          **绝对定位压在 meta 行的右端**，不参与布局 —— 这是量出来的教训：
          它们原来在第一行占着 83px（哪怕 opacity: 0），把标题挤到只剩 25px，
          表现就是用户看到的「确认 / 接…」。悬停时它们顶掉"无子任务"那几个字
          （那行文字此时不重要），卡片高度与标题宽度都不变。

          「详情」按钮已去掉（用户 2026-10-02）：**点整张卡片就是打开详情**，
          再多一个图标按钮是同一件事的两个入口。
        -->
        <span class="on-actions">
          <button
            type="button"
            class="on-act"
            title="在这个节点下添加子任务"
            data-field="outline-add-child"
            @click.stop="emit('addStart', item.task.id)"
          >
            <AppIcon name="plus" :size="13" />
          </button>
          <button
            type="button"
            class="on-act"
            title="重命名（也可以双击标题）"
            data-field="outline-rename"
            @click.stop="emit('renameStart', item.task.id, item.task.title)"
          >
            <AppIcon name="list" :size="13" />
          </button>
          <button
            type="button"
            class="on-act"
            title="删除这个任务"
            data-field="outline-remove"
            @click.stop="emit('remove', item.task.id)"
          >
            <AppIcon name="trash" :size="13" />
          </button>
        </span>
      </div>

      <!-- 新增子任务的输入行：直接长在父节点下面（比弹窗更贴近"在这里插一个"） -->
      <div v-if="addingParentId === item.task.id" class="on-add" data-field="outline-add-row">
        <input
          ref="addInput"
          class="on-input"
          :value="addingDraft"
          placeholder="子任务标题，回车创建"
          data-field="outline-add-input"
          @click.stop
          @input="emit('addingInput', ($event.target as HTMLInputElement).value)"
          @keydown.enter.prevent="emit('addCommit', item.task.id, addingDraft)"
          @keydown.esc.prevent="emit('addCancel')"
        />
        <button
          type="button"
          class="on-act"
          title="创建"
          data-field="outline-add-commit"
          @click.stop="emit('addCommit', item.task.id, addingDraft)"
        >
          <AppIcon name="check" :size="13" />
        </button>
      </div>
    </div>

    <!-- 折叠时整棵子树不渲染：几千个节点的项目里这是"能不能用"的区别 -->
    <ul v-if="hasChildren && !isCollapsed" class="on-children">
      <OutlineNode
        v-for="child in item.children"
        :key="child.task.id"
        :item="child"
        :statuses="statuses"
        :collapsed="collapsed"
        :editing-id="editingId"
        :editing-draft="editingDraft"
        :adding-parent-id="addingParentId"
        :adding-draft="addingDraft"
        :mutating="mutating"
        @toggle="(id: string) => emit('toggle', id)"
        @status="(id: string, statusId: string) => emit('status', id, statusId)"
        @rename-start="(id: string, title: string) => emit('renameStart', id, title)"
        @rename-commit="(id: string, title: string) => emit('renameCommit', id, title)"
        @rename-cancel="() => emit('renameCancel')"
        @add-start="(id: string) => emit('addStart', id)"
        @add-commit="(id: string, title: string) => emit('addCommit', id, title)"
        @add-cancel="() => emit('addCancel')"
        @remove="(id: string) => emit('remove', id)"
        @open="(id: string) => emit('open', id)"
        @editing-input="(value: string) => emit('editingInput', value)"
        @adding-input="(value: string) => emit('addingInput', value)"
      />
    </ul>
    <span v-else-if="hasChildren && isCollapsed" class="on-hidden faint">
      已折叠 {{ item.children.length }} 个子任务
    </span>
  </li>
</template>

<style scoped>
/*
 * 连接线画法（正交 + 圆角，用户选定的第 4 种样式）：
 * 每个子节点自己画出"从横杆通到自己"的那一段，于是整条横杆由所有子节点拼成，
 * 不需要知道兄弟们的宽度。两端（首/末）各去掉半段，避免悬空的线头。
 */
.on-node {
  position: relative;
  display: flex;
  flex-direction: column;
  align-items: center;
  padding: 18px 7px 0;
  list-style: none;
  /*
   * **不参与收缩**（`flex: none`）。
   *
   * 这是标题换行问题的真正根因：一层有十几个节点时，整行比视口宽，
   * flex 会把每个节点压到它的 min-content 宽度 —— 卡片被压到 `min-width`，
   * 标题于是折行（用户两次都报"名称被挤压 / 标题换行"）。
   * 现在改为"谁也別压谁"：树该多宽就多宽，超出部分由 `.tree-scroll` 横向滚动
   * （那本来就是为了宽树准备的）。
   */
  flex: none;
}

/* 从父节点下来的竖线 + 左半段横杆；最后一个子节点额外用右边框画向下的圆角竖线 */
.on-node::before,
.on-node::after {
  content: '';
  position: absolute;
  top: 0;
  right: 50%;
  width: 50%;
  height: 18px;
  border-top: 1px solid var(--pm-border);
}

.on-node::after {
  right: auto;
  left: 50%;
  border-left: 1px solid var(--pm-border);
}

/* 独生子：没有横杆，只留一段向下的竖线（否则父子之间会断线） */
.on-node:only-child::before {
  display: none;
}

.on-node:only-child::after {
  left: 50%;
  right: auto;
  width: 1px;
  border-top: 0 none;
}

.on-node:first-child::before,
.on-node:last-child::after {
  border: 0 none;
}

.on-node:last-child::before {
  border-right: 1px solid var(--pm-border);
  border-radius: 0 7px 0 0;
}

.on-node:first-child::after {
  border-radius: 7px 0 0 0;
}

/* 子节点横排；放不下就横向滚动（见 OutlineView 的 .tree-scroll） */
.on-children {
  position: relative;
  display: flex;
  align-items: flex-start;
  justify-content: center;
  /* 与父卡片之间的间隙：留给下面那条 12px 的竖向连接线 */
  margin: 12px 0 0;
  padding: 0;
  list-style: none;
}

/* 父卡片底部 → 横杆的那一小段竖线（正好补满上面留的 12px 间隙） */
.on-children::before {
  content: '';
  position: absolute;
  top: -12px;
  left: 50%;
  width: 1px;
  height: 12px;
  background: var(--pm-border);
}

/* ---------------- 节点卡片 ---------------- */

.on-card {
  position: relative;
  display: flex;
  flex-direction: column;
  gap: 5px;
  /* 整卡可点开详情：光标必须是手型，否则用户不会想到卡片本身能点 */
  cursor: pointer;
  /*
   * 宽度由**内容**决定（列方向 + `align-items: center` 时就是 fit-content）：
   * 短标题的卡片不会虚胖，长标题的卡片自己变宽到 260px 才折行。
   *
   * 168px 是最小宽度 —— 减去左右内边距 18、折叠位 17 + 间距 5（状态点已经去掉），
   * 标题至少能拿到 128px（十来个汉字一行放得下）。
   */
  min-width: 168px;
  max-width: 260px;
  padding: 8px 9px;
  border: 1px solid var(--pm-border);
  border-radius: 10px;
  background: var(--pm-surface);
  transition:
    border-color 0.15s ease,
    box-shadow 0.15s ease;
}

.on-card:hover {
  border-color: var(--pm-accent);
  box-shadow: 0 3px 10px rgb(0 0 0 / 12%);
}

.on-card.is-done .on-title {
  text-decoration: line-through;
  opacity: 0.7;
}

.on-top {
  display: flex;
  align-items: center;
  gap: 5px;
  min-width: 0;
}

.on-caret {
  flex: none;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 17px;
  height: 17px;
  padding: 0;
  border: none;
  border-radius: 4px;
  background: none;
  color: var(--pm-text-faint);
  cursor: pointer;
}

.on-caret:hover {
  color: var(--pm-text);
  background: color-mix(in srgb, var(--pm-text) 10%, transparent);
}

.on-title {
  flex: 1;
  min-width: 0;
  font-size: 12.5px;
  line-height: 1.35;
  /* 标题最多两行：一行放不下就换行，但不会把卡片撑成一条 */
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
  word-break: break-word;
  cursor: text;
}

.on-input {
  flex: 1;
  min-width: 0;
  /* 内边距给足：文字贴着自己的边框、再加上聚焦描边时会显得很挤（用户报过"间距"） */
  padding: 3px 8px;
  border: 1px solid var(--pm-accent);
  border-radius: 5px;
  background: var(--pm-bg, transparent);
  color: var(--pm-text);
  font-family: inherit;
  font-size: 12.5px;
}

.on-blocked {
  flex: none;
  display: inline-flex;
  align-items: center;
  gap: 2px;
  font-size: 10.5px;
  color: var(--pm-warning, #e6a23c);
}

/* 悬停才出现的操作按钮：**绝对定位**，不占布局宽度（见模板里的注释） */
.on-actions {
  position: absolute;
  right: -3px;
  bottom: -3px;
  display: flex;
  align-items: center;
  gap: 1px;
  opacity: 0;
  transition: opacity 0.15s ease;
}

.on-card:hover .on-actions,
.on-card:focus-within .on-actions {
  opacity: 1;
}

/* 操作按钮出现时把"子任务数"那句话让出来（同一块地方，不产生布局跳动） */
.on-card:hover .on-count,
.on-card:focus-within .on-count {
  opacity: 0;
}

.on-act {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 20px;
  height: 20px;
  padding: 0;
  border: none;
  border-radius: 4px;
  background: var(--pm-surface);
  color: var(--pm-text-faint);
  cursor: pointer;
}

.on-act:hover {
  color: var(--pm-accent);
  background: color-mix(in srgb, var(--pm-accent) 14%, var(--pm-surface));
}

.on-meta {
  position: relative;
  display: flex;
  align-items: center;
  gap: 5px;
  flex-wrap: wrap;
  min-width: 0;
}

.on-status {
  flex: none;
  padding: 0 6px;
  border: none;
  border-radius: 4px;
  font-family: inherit;
  font-size: 10.5px;
  line-height: 16px;
  white-space: nowrap;
  cursor: pointer;
}

.on-status:hover {
  filter: brightness(1.12);
}

.on-priority {
  flex: none;
  font-size: 10.5px;
  color: var(--pm-text-faint);
}

/* 优先级靠颜色区分：紧急是警告色，其余保持安静 */
.on-priority[data-level='urgent'] {
  color: var(--pm-danger, #d03050);
}

.on-priority[data-level='high'] {
  color: var(--pm-warning, #e6a23c);
}

.on-count {
  font-size: 10.5px;
  white-space: nowrap;
  /* 推到 meta 行右端：悬停时操作按钮正是在这一块地方出现 */
  margin-left: auto;
  transition: opacity 0.15s ease;
}

/*
 * 新增子任务那一行：输入框 + 一个确认按钮。
 *
 * 间距是量出来的：原来 `gap: 4px`、输入框内边距只有 `2px 5px`、确认按钮 20px
 * （比输入框矮 2px 且没有垂直居中），三件事叠在一起的观感就是"挤"。
 * 现在：与上一行留 7px（卡片自身 5px + 这里 2px）、按钮与输入框同高同中线、间距 8px。
 */
.on-add {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 2px;
}

/* 确认按钮做成"输入框的搭档"：同高、同边框色，而不是悬停工具栏里那种无边图标 */
.on-add .on-act {
  flex: none;
  width: 22px;
  height: 22px;
  border: 1px solid var(--pm-accent);
  background: none;
  color: var(--pm-accent);
}

.on-add .on-act:hover {
  color: var(--pm-accent);
  background: color-mix(in srgb, var(--pm-accent) 16%, transparent);
}

.on-hidden {
  font-size: 10.5px;
  padding: 3px 0;
}

@media (prefers-reduced-motion: reduce) {
  .on-card,
  .on-actions {
    transition: none;
  }
}
</style>
