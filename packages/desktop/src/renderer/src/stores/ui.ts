/**
 * 界面偏好：主题、密度、侧边栏状态。
 *
 * 持久化走主进程（AppData 的 config.json），因为**渲染层的 localStorage
 * 在这个应用里不可用** —— 窗口从 `http://127.0.0.1:<动态端口>` 加载，
 * origin 包含端口，端口每次启动都变，localStorage 每次都是空的。
 */

import { darkTheme, type GlobalTheme } from 'naive-ui';
import { defineStore } from 'pinia';
import { computed, ref } from 'vue';

import {
  applyPalette,
  readInitialUiPreferences,
  resolveTheme,
  systemPrefersDark,
} from '../theme/apply';
import {
  FONT_FAMILY,
  naiveThemeOverrides,
  PALETTES,
  type Density,
  type ResolvedTheme,
  type ThemeMode,
} from '../theme/tokens';

export const useUiStore = defineStore('ui', () => {
  // 启动时同步读一次；main.ts 已经用它定好了首帧主题，这里只是接续状态
  const initial = readInitialUiPreferences();

  const mode = ref<ThemeMode>(initial.theme);
  /*
   * 密度**已下线**（用户 2026-09-25：「删除系统的密度切换功能，这个看着很鸡肋」）。
   *
   * 固定用「舒适」这一档。配置里可能还留着旧的 `density: 'compact'`，
   * 这里**刻意不读它** —— 这样界面尺度只有一处真相，不会出现"配置文件里是个值、
   * 界面显示是另一个"的鬼状态。字段本身留着（不再写入），免得老配置被判非法。
   */
  const density = ref<Density>('comfortable');
  const sidebarCollapsed = ref(initial.sidebarCollapsed);
  const systemDark = ref(systemPrefersDark());

  const resolved = computed<ResolvedTheme>(() =>
    mode.value === 'system' ? (systemDark.value ? 'dark' : 'light') : mode.value,
  );

  const palette = computed(() => PALETTES[resolved.value]);

  /** Naive UI 的主题对象：暗色用内置 darkTheme，亮色用默认（null） */
  const naiveTheme = computed<GlobalTheme | null>(() =>
    resolved.value === 'dark' ? darkTheme : null,
  );

  const naiveOverrides = computed(() =>
    // 密度要传进去：控件高度与字号是密度的一部分（见 theme/tokens.ts 的 DENSITIES）
    naiveThemeOverrides(palette.value, FONT_FAMILY, density.value),
  );

  const isDark = computed(() => resolved.value === 'dark');

  async function persist(patch: Record<string, unknown>): Promise<void> {
    try {
      await window.pmStudio?.patchPreferences(patch);
    } catch (error) {
      // 偏好持久化失败不该阻断界面：本次会话内仍按用户的选择显示
      // eslint-disable-next-line no-console
      console.warn('[ui] 偏好写入失败', error);
    }
  }

  function setMode(next: ThemeMode): void {
    mode.value = next;
    applyPalette(resolveTheme(next), density.value);
    void persist({ theme: next });
  }

  /** 在亮/暗之间直接切换（"跟随系统"下切到与当前相反的那个） */
  function toggleTheme(): void {
    setMode(resolved.value === 'dark' ? 'light' : 'dark');
  }

  function setDensity(next: Density): void {
    density.value = next;
    applyPalette(resolved.value, next);
    void persist({ density: next });
  }

  function toggleSidebar(): void {
    sidebarCollapsed.value = !sidebarCollapsed.value;
    void persist({ sidebarCollapsed: sidebarCollapsed.value });
  }

  /**
   * 系统主题变化时同步（仅"跟随系统"模式需要响应）。
   * 返回取消订阅函数，由调用方在卸载时调用。
   */
  function watchSystemTheme(): () => void {
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    const handler = (event: MediaQueryListEvent): void => {
      systemDark.value = event.matches;
      if (mode.value === 'system') {
        applyPalette(event.matches ? 'dark' : 'light', density.value);
      }
    };
    media.addEventListener('change', handler);
    return () => media.removeEventListener('change', handler);
  }

  return {
    mode,
    density,
    sidebarCollapsed,
    resolved,
    isDark,
    palette,
    naiveTheme,
    naiveOverrides,
    setMode,
    toggleTheme,
    setDensity,
    toggleSidebar,
    watchSystemTheme,
  };
});
