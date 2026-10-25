<script setup lang="ts">
/**
 * 「功能介绍」：版本更新介绍。
 *
 * 两个状态共用这一个视图（用户 2026-09-25 要求做成页面、并且"点进去看某个版本"）：
 * - `#/whats-new` → **版本列表**（每次更新一条）；
 * - `#/whats-new/:version` → 该版本的内容，带「返回列表」。
 *
 * 数据放在 `data/whats-new.ts`，以后每次更新只在数组最前面加一条，这一页不需要改。
 */

import { NButton, NTag } from 'naive-ui';
import { computed } from 'vue';
import { useRoute, useRouter } from 'vue-router';

import AppIcon from '../components/AppIcon.vue';
import { RELEASES } from '../data/whats-new';

const route = useRoute();
const router = useRouter();

const versionParam = computed(() =>
  typeof route.params.version === 'string' && route.params.version.length > 0
    ? route.params.version
    : null,
);

const current = computed(() => RELEASES.find((release) => release.version === versionParam.value) ?? null);

function openVersion(version: string): void {
  void router.push({ name: 'whats-new-detail', params: { version } });
}

function backToList(): void {
  void router.push({ name: 'whats-new' });
}

/**
 * 列表页的「返回」**明确回设置页**，不用 `router.back()`。
 *
 * 用户 2026-09-25 报的 bug：设置 → 功能介绍 → 某个版本 →「返回列表」→「返回」，
 * 结果又回到了刚才那个版本的详情里。
 * 原因是 `router.back()` 是"退一步历史记录"，而"返回列表"本身就是一次 push ——
 * 于是列表的上一条历史正是那个版本详情，`back()` 自然退到了它。
 * 返回目标是确定的（这一页只从设置页进来），就不要交给历史栈去猜。
 */
function backToSettings(): void {
  void router.push({ name: 'settings' });
}
</script>

<template>
  <!-- `data-view` 是给 E2E 的语义标记：判断"路由内容真的挂载了"（约定见 docs/technical-design.md 的 E2E 一节） -->
  <div class="page" data-view="whats-new">
    <!-- ---------------- 版本列表 ---------------- -->
    <template v-if="!versionParam">
      <header class="head">
        <div>
          <h1>功能介绍</h1>
          <p class="faint sub">每个版本一条记录，点击查看该版本的变更内容</p>
        </div>
        <NButton size="small" data-field="whats-new-back" @click="backToSettings">
          <template #icon><AppIcon name="chevronLeft" :size="14" /></template>
          返回
        </NButton>
      </header>

      <ul class="list" data-field="release-list">
        <li v-for="release in RELEASES" :key="release.version">
          <button class="item" data-field="release-item" @click="openVersion(release.version)">
            <span class="version">v{{ release.version }}</span>
            <NTag v-if="release.version === RELEASES[0]?.version" size="tiny" type="primary" :bordered="false">
              最新
            </NTag>
            <span class="faint date">{{ release.date }}</span>
            <span class="faint count">{{ release.items.length }} 项</span>
            <AppIcon name="chevronRight" :size="14" class="faint" />
          </button>
        </li>
      </ul>
    </template>

    <!-- ---------------- 某个版本的内容 ---------------- -->
    <template v-else-if="current">
      <header class="head">
        <div>
          <h1>v{{ current.version }} 更新内容</h1>
          <p class="faint sub">{{ current.date }} 发布</p>
        </div>
        <NButton size="small" data-field="release-back" @click="backToList">
          <template #icon><AppIcon name="chevronLeft" :size="14" /></template>
          返回列表
        </NButton>
      </header>

      <ul class="notes" data-field="release-notes">
        <li v-for="item in current.items" :key="item" :class="{ fix: item.startsWith('fix:') }">
          <NTag v-if="item.startsWith('fix:')" size="tiny" :bordered="false">修复</NTag>
          <span>{{ item.replace(/^fix:\s*/, '') }}</span>
        </li>
      </ul>
    </template>

    <!-- ---------------- 版本号不存在 ---------------- -->
    <template v-else>
      <header class="head">
        <div>
          <h1>没有这个版本</h1>
          <p class="faint sub">版本号 {{ versionParam }} 不在更新记录里</p>
        </div>
        <NButton size="small" @click="backToList">返回列表</NButton>
      </header>
    </template>
  </div>
</template>

<style scoped>
/* 一维排布用弹性盒子（见技术设计 §33 的约定） */
.page {
  display: flex;
  flex-direction: column;
  height: 100%;
  padding: 16px 18px;
  gap: 12px;
  overflow: hidden;
}

.head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
  flex: none;
}

.head h1 {
  margin: 0;
  font-size: 17px;
  font-weight: 600;
}

.sub {
  margin: 4px 0 0;
  font-size: 12.5px;
}

.list,
.notes {
  flex: 1;
  min-height: 0;
  overflow: auto;
  margin: 0;
  padding: 0;
  list-style: none;
  border: 1px solid var(--pm-border);
  border-radius: 10px;
  background: var(--pm-surface);
}

.list li + li,
.notes li + li {
  border-top: 1px solid var(--pm-border);
}

.item {
  display: flex;
  align-items: center;
  gap: 10px;
  width: 100%;
  border: none;
  background: none;
  padding: 12px 14px;
  font: inherit;
  text-align: left;
  cursor: pointer;
}

.item:hover {
  background: var(--pm-accent-soft);
}

.version {
  font-size: 13.5px;
  font-weight: 600;
}

/* 日期与条数靠右对齐：`margin-left: auto` 把后面几项一起推过去 */
.date {
  margin-left: auto;
  font-size: 12px;
}

.count {
  font-size: 12px;
  min-width: 46px;
  text-align: right;
}

.notes li {
  display: flex;
  align-items: baseline;
  gap: 8px;
  padding: 10px 14px;
  font-size: 13px;
  line-height: 1.7;
}

.notes li.fix {
  color: var(--pm-text-muted);
}

.faint {
  color: var(--pm-text-faint);
}
</style>
