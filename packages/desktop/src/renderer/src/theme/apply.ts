/**
 * 主题的 DOM 应用。
 *
 * 独立成一个不依赖 Pinia 的模块，因为**首帧之前就要用**：
 * main.ts 在 `createApp` 之前调一次，把主题定下来，避免先渲染出错误颜色
 * 再跳成正确的（暗色用户会看到刺眼的白闪）。
 */

import {
  DENSITIES,
  PALETTES,
  densityToCssVariables,
  paletteToCssVariables,
  type Density,
  type ResolvedTheme,
  type ThemeMode,
} from './tokens';

export interface InitialUiPreferences {
  theme: ThemeMode;
  density: Density;
  sidebarCollapsed: boolean;
}

const FALLBACK: InitialUiPreferences = {
  theme: 'dark',
  density: 'comfortable',
  sidebarCollapsed: false,
};

function isThemeMode(value: unknown): value is ThemeMode {
  return value === 'light' || value === 'dark' || value === 'system';
}

function isDensity(value: unknown): value is Density {
  return value === 'comfortable' || value === 'compact';
}

/**
 * 从 preload 同步取回初始 UI 偏好。
 *
 * **不要用 localStorage**：窗口加载的是 `http://127.0.0.1:<动态端口>`，
 * 而 origin 包含端口 —— 端口每次启动都不同，localStorage 每次都是空的。
 */
export function readInitialUiPreferences(): InitialUiPreferences {
  const raw = window.pmStudio?.initialPreferences;
  if (!raw) return FALLBACK;

  return {
    theme: isThemeMode(raw.theme) ? raw.theme : FALLBACK.theme,
    density: isDensity(raw.density) ? raw.density : FALLBACK.density,
    sidebarCollapsed:
      typeof raw.sidebarCollapsed === 'boolean' ? raw.sidebarCollapsed : FALLBACK.sidebarCollapsed,
  };
}

/** 系统是否偏好暗色 */
export function systemPrefersDark(): boolean {
  return window.matchMedia?.('(prefers-color-scheme: dark)').matches ?? true;
}

export function resolveTheme(mode: ThemeMode): ResolvedTheme {
  if (mode === 'system') return systemPrefersDark() ? 'dark' : 'light';
  return mode;
}

/** 把主题与密度写进 `<html>`：CSS 变量 + data-theme 标记 */
export function applyPalette(resolved: ResolvedTheme, density: Density): void {
  const root = document.documentElement;
  const palette = PALETTES[resolved];

  for (const [key, value] of Object.entries(paletteToCssVariables(palette))) {
    root.style.setProperty(key, value);
  }
  for (const [key, value] of Object.entries(densityToCssVariables(density))) {
    root.style.setProperty(key, value);
  }

  // data-theme 供 CSS 里做少数无法用变量表达的分支（如滚动条配色）
  root.dataset.theme = resolved;
  root.dataset.density = density;
  root.style.colorScheme = resolved;

  // 直接给根元素上底色：首帧时 Vue 可能还没挂载，这一层能兜住白闪
  root.style.backgroundColor = palette.bg;
}

/** 供 main.ts 在挂载前调用 */
export function applyInitialTheme(): InitialUiPreferences {
  const prefs = readInitialUiPreferences();
  applyPalette(resolveTheme(prefs.theme), prefs.density);
  return prefs;
}

export { DENSITIES };
