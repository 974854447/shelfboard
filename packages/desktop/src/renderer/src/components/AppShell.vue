<script setup lang="ts">
/**
 * 布局外壳：侧边栏 + 顶栏 + 内容区。
 *
 * 两个细节值得说明：
 *
 * 1. **启动逻辑放在这里而不是 main.ts**：需要 Pinia 已装好，而且失败时
 *    要能在界面上显示原因 —— 用 console 报错用户是看不到的。
 * 2. **主题的"跟随系统"要监听系统变化**：用户切了系统主题却要重启应用才生效，
 *    是很明显的体验缺陷。监听器在卸载时解除。
 */

import {
  NButton,
  NLayout,
  NLayoutContent,
  NLayoutHeader,
  NLayoutSider,
  NMenu,
  NResult,
  NSelect,
  NSpin,
  NTooltip,
  type MenuOption,
} from 'naive-ui';
import { computed, h, onMounted, onUnmounted, type Component } from 'vue';
import { RouterLink, RouterView, useRoute, useRouter } from 'vue-router';

import AppIcon, { type IconName } from './AppIcon.vue';
import ErrorBanner from './ErrorBanner.vue';
import { useAppStore } from '../stores/app';
import { useBoardStore } from '../stores/board';
import { useUiStore } from '../stores/ui';

const app = useAppStore();
const board = useBoardStore();
const ui = useUiStore();
const route = useRoute();
const router = useRouter();

let stopSystemWatch: (() => void) | null = null;
/** 取消订阅"工作区目录变了"（切换目录后要刷新启动信息与项目列表） */
let stopWorkspaceWatch: (() => void) | null = null;

/* ---------------- 导航 ---------------- */

interface NavEntry {
  name: string;
  label: string;
  icon: IconName;
  needsProject: boolean;
}

/*
 * 导航顺序：项目 → 工作台 → 总览 → 日志。
 *
 * 工作台排在总览前面是用户定的：点开一个项目先落在工作台（干活），
 * 想看项目整体情况再往右点「总览」—— 菜单顺序与"打开项目落在哪一页"保持一致，
 * 否则第一项和实际落点不同，会让人以为点错了。
 */
const NAV: NavEntry[] = [
  { name: 'projects', label: '项目', icon: 'folder', needsProject: false },
  // 0.2.x 改名：工作台 → 工作大纲（这一页现在是项目的自上而下树）、我的待办 → 今日待办
  { name: 'workbench', label: '工作大纲', icon: 'list', needsProject: true },
  { name: 'overview', label: '总览', icon: 'hex', needsProject: true },
  // M2 的三页：日历与今日待办都要项目上下文（**今日待办只看当前项目** —— 用户 2026-09-30 定的）
  { name: 'calendar', label: '日历', icon: 'calendar', needsProject: true },
  { name: 'my-tasks', label: '今日待办', icon: 'inbox', needsProject: true },
  { name: 'search', label: '搜索', icon: 'search', needsProject: false },

  { name: 'logs', label: '日志', icon: 'terminal', needsProject: false },
  // 设置放在最后：前面是"干活"，它是"配置"
  { name: 'settings', label: '设置', icon: 'settings', needsProject: false },
];

/** 日志现场深链也算在"日志"这一项上高亮 */
const activeNav = computed(() => {
  const name = String(route.name ?? '');
  return name === 'log-context' ? 'logs' : name;
});

const pageTitle = computed(() => {
  if (route.name === 'log-context') return '日志现场';
  return (route.meta.title as string | undefined) ?? '项目管理系统';
});

function renderIcon(name: IconName): () => Component {
  return () => h(AppIcon, { name, size: 17 });
}

/**
 * 交给选择框的值。
 *
 * **只在当前项目确实还在列表里时才传 id**：如果它被归档/删除而从列表消失，
 * Naive 找不到对应选项会把原始 value 当标签直接显示出来 ——
 * 界面上就会出现一串项目 id（用户看到的"乱码"）。传 null 则显示占位文字。
 *
 * 调用方（归档/删除）已经会主动清掉当前项目；这里是兜底，
 * 免得以后又冒出一条"让当前项目悄悄消失"的路径。
 */
const selectedProjectId = computed(() =>
  board.currentProject ? board.currentProjectId : null,
);

const menuOptions = computed<MenuOption[]>(() =>
  NAV.map((entry) => {
    // 用 currentProject 而不是 currentProjectId：项目被归档/删除后它就不在列表里了，
    // 那时看板/列表没有可用的项目，菜单项该跟着变灰（否则点进去是一片空）
    const disabled = entry.needsProject && !board.currentProject;
    return {
      key: entry.name,
      disabled,
      icon: renderIcon(entry.icon),
      label: disabled
        ? () => h('span', { class: 'nav-disabled', title: '请先选择一个项目' }, entry.label)
        : () => h(RouterLink, { to: { name: entry.name } }, { default: () => entry.label }),
    };
  }),
);

function onMenuSelect(key: string): void {
  void router.push({ name: key });
}

/* ---------------- 顶栏动作 ---------------- */

const themeIcon = computed<IconName>(() =>
  ui.mode === 'system' ? 'monitor' : ui.isDark ? 'moon' : 'sun',
);

const themeLabel = computed(() =>
  ui.mode === 'system' ? '跟随系统' : ui.isDark ? '暗色' : '亮色',
);

/** 循环切换：亮 → 暗 → 跟随系统 → 亮 */
function cycleTheme(): void {
  const order = ['light', 'dark', 'system'] as const;
  const index = order.indexOf(ui.mode);
  ui.setMode(order[(index + 1) % order.length] as (typeof order)[number]);
}

async function refresh(): Promise<void> {
  if (board.currentProjectId) await board.loadBoard();
  else await board.loadProjects();
}

async function revealWorkspace(): Promise<void> {
  await window.pmStudio?.revealWorkspace();
}

/* ---------------- 生命周期 ---------------- */

onMounted(async () => {
  await app.boot();
  if (app.ready) await board.restoreLastProject();
  stopSystemWatch = ui.watchSystemTheme();
  syncWindowTitle();

  // 工作区目录可能被改（设置页，或将来的别的入口）—— 由主进程广播，这里跟着刷新。
  // 把刷新挂在"事件"上而不是"按钮"上，任何调用方改了目录界面都不会停在旧路径。
  stopWorkspaceWatch =
    window.pmStudio?.onWorkspaceChanged(() => {
      void app.refreshInfo();
      void board.loadProjects();
    }) ?? null;

  // Ctrl+K / Cmd+K：随手跳到全局搜索（搜索页自己在挂载时聚焦输入框）
  window.addEventListener('keydown', onShortcut);
});

/**
 * 全局快捷键。
 *
 * 只拦 Ctrl/Cmd+K：这是"搜索"在编辑器类工具里的通用约定，用户不用学。
 * 刻意**不在输入框里生效**（那样会把 K 打不进去）—— 判断事件源是不是输入类元素。
 */
function onShortcut(event: KeyboardEvent): void {
  if (!(event.ctrlKey || event.metaKey) || event.key.toLowerCase() !== 'k') return;
  const target = event.target as HTMLElement | null;
  const tag = target?.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || target?.isContentEditable) return;
  event.preventDefault();
  void router.push({ name: 'search' });
}

onUnmounted(() => {
  stopSystemWatch?.();
  stopWorkspaceWatch?.();
  window.removeEventListener('keydown', onShortcut);
});

/**
 * 是否跑在正式环境（打包后的版本）。
 *
 * 用来决定"要不要显示环境标签"：正式环境是常态，不挂角标；测试环境必须显示
 * （两套数据完全分开，认错环境会对着测试数据找正式数据）。
 */
const isProductionEnv = computed(() => app.info?.environment === 'production');

/**
 * 窗口标题带上环境（非正式环境才加后缀）。
 *
 * 走**渲染层改 `document.title`** 而不是给 BrowserWindow 传 title：Electron 默认会用
 * 页面标题覆盖窗口标题（`page-title-updated`），传给 BrowserWindow 的那个会被冲掉。
 * 标题是最省事的"我现在在哪个环境"提示 —— 任务栏、Alt+Tab、截图里都能看到，
 * 侧栏折叠时也不会丢（那时环境标签是看不见的）。
 */
function syncWindowTitle(): void {
  const info = app.info;
  document.title =
    !info || info.environment === 'production'
      ? '项目管理系统'
      : `项目管理系统（${info.environmentLabel}）`;
}

onUnmounted(() => {
  stopSystemWatch?.();
});
</script>

<template>
  <NLayout has-sider class="root">
    <NLayoutSider
      bordered
      collapse-mode="width"
      :width="236"
      :collapsed-width="64"
      :collapsed="ui.sidebarCollapsed"
      show-trigger="arrow-circle"
      @collapse="ui.toggleSidebar()"
      @expand="ui.toggleSidebar()"
    >
      <div class="sider" :class="{ compact: ui.sidebarCollapsed }">
        <div class="brand" :class="{ compact: ui.sidebarCollapsed }">
          <!--
            品牌标记：与托盘图标、exe 图标同一套图案（三条记录，每条前面一个标记，
            第三条的标记被拉长）。这里是"小尺寸简化版"的等价物 ——
            22px 下描边卡片同样会糊，所以画的是实心块。
          -->
          <span class="brand-mark">
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <rect x="4.4" y="5.2" width="3" height="2.6" rx="1.3" />
              <rect x="9.2" y="5.2" width="11" height="2.6" rx="1.3" />
              <rect x="4.4" y="10.7" width="3" height="2.6" rx="1.3" />
              <rect x="9.2" y="10.7" width="11" height="2.6" rx="1.3" />
              <rect x="4.4" y="16.2" width="6.2" height="2.6" rx="1.3" />
              <rect x="12.4" y="16.2" width="7.8" height="2.6" rx="1.3" />
            </svg>
          </span>
          <div v-if="!ui.sidebarCollapsed" class="brand-text">
            <div class="brand-name">项目管理系统</div>
            <!--
              版本 + 环境标签。
              **正式环境不显示这个标签**（用户 2026-10-01）：正式环境是常态，
              给它挂一个"正式环境"的角标只会占地方；而测试环境必须显示 ——
              两者用的是两套完全分开的数据（不同 userData 目录），看不出在哪个环境，
              就会对着测试数据找正式数据。鼠标悬停给出实际生效的数据目录。
            -->
            <div class="brand-version faint">
              <span>v{{ app.info?.version ?? '…' }}</span>
              <span
                v-if="app.info && !isProductionEnv"
                class="env-badge"
                :class="`is-${app.info.environment}`"
                :title="`${app.info.environmentLabel} · 数据目录：${app.info.userDataDir}`"
              >
                {{ app.info.environmentLabel }}
              </span>
            </div>
          </div>
        </div>

        <div v-if="!ui.sidebarCollapsed" class="picker">
          <div class="picker-label faint">当前项目</div>
          <NSelect
            size="small"
            :value="selectedProjectId"
            :options="board.projects.map((p) => ({ label: p.name, value: p.id }))"
            :placeholder="board.projects.length ? '选择一个项目' : '还没有项目'"
            :disabled="board.projects.length === 0"
            @update:value="(v: string | null) => board.selectProject(v)"
          />
          <div v-if="board.currentProject" class="picker-meta faint">
            {{ board.totalTasks }} 个任务
          </div>
        </div>

        <NMenu
          class="nav"
          :value="activeNav"
          :options="menuOptions"
          :collapsed="ui.sidebarCollapsed"
          :collapsed-width="64"
          :collapsed-icon-size="18"
          :indent="18"
          @update:value="onMenuSelect"
        />

        <div class="sider-foot">
          <NTooltip v-if="ui.sidebarCollapsed" trigger="hover" placement="right">
            <template #trigger>
              <NButton quaternary size="tiny" @click="revealWorkspace">
                <template #icon><AppIcon name="external" /></template>
              </NButton>
            </template>
            {{ app.info?.workspaceRoot }}
          </NTooltip>
          <template v-else>
            <div class="foot-row">
              <span class="faint">工作区</span>
              <NButton quaternary size="tiny" @click="revealWorkspace">
                <template #icon><AppIcon name="external" :size="13" /></template>
                打开
              </NButton>
            </div>
            <div class="workspace mono" :title="app.info?.workspaceRoot">
              {{ app.workspaceName || '…' }}
            </div>
            <div class="faint tip">关闭窗口会最小化到托盘</div>
          </template>
        </div>
      </div>
    </NLayoutSider>

    <NLayout>
      <NLayoutHeader bordered class="header">
        <div class="header-left">
          <h1 class="page-title">{{ pageTitle }}</h1>
          <span v-if="board.currentProject" class="faint project-name">
            · {{ board.currentProject.name }}
          </span>
        </div>

        <div class="header-actions">
          <NTooltip trigger="hover">
            <template #trigger>
              <NButton quaternary size="small" :disabled="board.loading" @click="refresh">
                <template #icon><AppIcon name="refresh" /></template>
              </NButton>
            </template>
            刷新（{{ board.loading ? '正在加载' : 'Ctrl+R' }}）
          </NTooltip>

          <NTooltip trigger="hover">
            <template #trigger>
              <NButton quaternary size="small" data-field="theme-toggle" @click="cycleTheme">
                <template #icon><AppIcon :name="themeIcon" /></template>
              </NButton>
            </template>
            主题：{{ themeLabel }}（点击切换）
          </NTooltip>
        </div>
      </NLayoutHeader>

      <NLayoutContent class="content">
        <div v-if="app.booting" class="booting">
          <NSpin size="medium" />
          <div class="faint">正在启动…</div>
        </div>

        <NResult
          v-else-if="!app.ready"
          status="error"
          title="启动失败"
          :description="app.bootError?.message ?? '无法连接内嵌服务'"
        >
          <template #footer>
            <div class="boot-actions">
              <NButton type="primary" @click="app.boot()">重试</NButton>
              <span v-if="app.bootError?.traceId" class="mono faint">
                traceId: {{ app.bootError.traceId }}
              </span>
            </div>
          </template>
        </NResult>

        <RouterView v-else v-slot="{ Component: PageComponent }">
          <Transition name="page" mode="out-in">
            <component :is="PageComponent" />
          </Transition>
        </RouterView>
      </NLayoutContent>
    </NLayout>
  </NLayout>

  <ErrorBanner />
</template>

<style scoped>
.root {
  height: 100vh;
}

/*
 * 折叠触发钮：默认的样式是一个纯色小圆，贴在侧栏边缘时对比过强。
 * 改成"低调的描边 + 悬停才变实心"，既不抢视线又保持可发现。
 */
.root :deep(.n-layout-toggle-button) {
  background: var(--pm-surface);
  color: var(--pm-text-muted);
  border: 1px solid var(--pm-border);
  box-shadow: var(--pm-shadow);
  transition: color 0.15s ease, border-color 0.15s ease;
}

.root :deep(.n-layout-toggle-button:hover) {
  background: var(--pm-accent-soft);
  color: var(--pm-accent);
  border-color: var(--pm-accent);
}

.sider {
  display: flex;
  flex-direction: column;
  height: 100%;
  padding: 14px 12px 12px;
  gap: 14px;
}

.brand {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 2px 4px 0;
}

/*
 * 折叠态：去掉左右内边距。
 *
 * Naive 的折叠菜单是拿 `collapsed-width`（64）算图标居中的 —— 它假设菜单自己
 * 就占满整条侧栏。而 .sider 有 12px 内边距时菜单实际只有 40px 宽、起点在 x=12，
 * Naive 却仍按 "12 + (64-20)/2 = 34" 摆图标：图标中心落到 44，选中项色块的
 * 中心还在 32 —— 图标正好骑在色块右边缘、半个身子探到色块外面，
 * 就是用户看到的「折叠后色块显示 bug」。
 *
 * 折叠时把内边距清零，菜单重新占满 64px，两边对"侧栏有多宽"的假设就一致了：
 * 色块 8..56、图标 22..42，中心都在 32。品牌标记（.brand.compact 居中）与
 * 底部按钮本来就是按整宽居中的，中心仍是 32，视觉不变。
 */
.sider.compact {
  padding-right: 0;
  padding-left: 0;
}

.brand.compact {
  justify-content: center;
}

.brand-mark {
  width: 22px;
  height: 22px;
  border-radius: 7px;
  background: var(--pm-accent);
  flex-shrink: 0;
  /* 一点内高光，让纯色块不至于太平 */
  box-shadow: inset 0 1px 0 rgb(255 255 255 / 22%);
  display: grid;
  place-items: center;
}

.brand-mark svg {
  width: 22px;
  height: 22px;
  fill: #fff;
}

.brand-name {
  font-weight: 600;
  letter-spacing: 0.01em;
}

.brand-version {
  font-size: 11px;
  display: flex;
  align-items: center;
  gap: 6px;
}

/*
 * 环境标签：正式 = 低调的灰底（它就是常态，不该抢视线）；
 * 测试 = 警示色（在测试环境里做的任何改动都不是真实数据，需要一眼可辨）。
 */
.env-badge {
  padding: 0 5px;
  border: 1px solid transparent;
  border-radius: 5px;
  font-size: 10.5px;
  line-height: 15px;
  white-space: nowrap;
}

.env-badge.is-production {
  color: var(--pm-text-faint);
  background: var(--pm-sunken);
}

.env-badge.is-test {
  color: var(--pm-warn);
  background: color-mix(in srgb, var(--pm-warn) 14%, transparent);
  border-color: color-mix(in srgb, var(--pm-warn) 38%, transparent);
}

.env-badge.is-custom {
  color: var(--pm-accent);
  background: var(--pm-accent-soft);
  border-color: color-mix(in srgb, var(--pm-accent) 34%, transparent);
}

.picker {
  display: grid;
  gap: 6px;
}

.picker-label {
  font-size: 11px;
  padding-left: 2px;
}

.picker-meta {
  font-size: 11px;
  padding-left: 2px;
}

.nav {
  flex-shrink: 0;
}

:deep(.nav-disabled) {
  opacity: 0.45;
  cursor: not-allowed;
}

.sider-foot {
  margin-top: auto;
  display: grid;
  gap: 4px;
  padding: 8px 2px 0;
  border-top: 1px solid var(--pm-border);
  font-size: 11.5px;
}

.foot-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.workspace {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.tip {
  font-size: 11px;
}

.header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  height: 52px;
  padding: 0 18px;
  gap: 16px;
}

.header-left {
  display: flex;
  align-items: baseline;
  gap: 8px;
  min-width: 0;
}

.page-title {
  font-size: 15px;
  font-weight: 600;
  margin: 0;
  white-space: nowrap;
}

.project-name {
  font-size: 12.5px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.header-actions {
  display: flex;
  align-items: center;
  gap: 2px;
  flex-shrink: 0;
}

.content {
  height: calc(100vh - 52px);
  overflow: auto;
}

.booting {
  display: grid;
  place-items: center;
  gap: 14px;
  height: 60vh;
}

.boot-actions {
  display: grid;
  justify-items: center;
  gap: 10px;
}

.faint {
  color: var(--pm-text-faint);
}

.mono {
  font-family: 'Cascadia Mono', Consolas, monospace;
}
</style>
