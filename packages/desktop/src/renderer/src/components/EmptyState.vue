<script setup lang="ts">
/**
 * 空状态（共用）。
 *
 * 用户 2026-09-25 给了一张「开启的箱子」图，要求空状态用这个图标、并且**居中**。
 * 图标手绘成矢量加进 `AppIcon`（名字 `openBox`），不是塞位图 ——
 * 位图不跟主题色、不能随字号缩放，而项目里所有图标都是 `currentColor` + 自绘 path。
 *
 * 三个可选的自由度都保留成 props：一行说明、一句更小的提示、一个可选的行动按钮。
 * 用法上刻意**不做成"大块插图"**：它是列表/面板里的空位说明，不是落地页。
 */

import { NButton } from 'naive-ui';

import AppIcon from './AppIcon.vue';

withDefaults(
  defineProps<{
    /** 主文案（一句话说明这里为什么是空的） */
    text: string;
    /** 次要提示（可选，更淡的一行） */
    hint?: string;
    /** 行动按钮的文案（可选；不传就没有按钮） */
    action?: string;
    /** 图标尺寸 */
    size?: number;
    /** 紧凑模式：面板里的小空位用它，不撑大高度 */
    compact?: boolean;
  }>(),
  { hint: '', action: '', size: 46, compact: false },
);

const emit = defineEmits<{ action: [] }>();
</script>

<template>
  <div class="empty-state" :class="{ compact }" data-field="empty-state">
    <AppIcon name="openBox" :size="size" class="icon" />
    <p class="text">{{ text }}</p>
    <p v-if="hint" class="hint">{{ hint }}</p>
    <NButton v-if="action" size="small" quaternary data-field="empty-action" @click="emit('action')">
      {{ action }}
    </NButton>
  </div>
</template>

<style scoped>
/* 居中：弹性盒子 + 双向居中，容器多高都稳（不用算 margin） */
.empty-state {
  flex: 1;
  min-height: 92px;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 6px;
  padding: 14px;
  text-align: center;
}

.empty-state.compact {
  min-height: 64px;
  padding: 8px;
  gap: 4px;
}

/* 图标压成"陪衬"的色调：空状态是说明，不该比内容还抢眼 */
.icon {
  color: var(--pm-text-faint);
  opacity: 0.75;
}

.text {
  margin: 0;
  font-size: 12.5px;
  color: var(--pm-text-muted);
}

.hint {
  margin: 0;
  font-size: 11.5px;
  color: var(--pm-text-faint);
  max-width: 320px;
  line-height: 1.6;
}
</style>
