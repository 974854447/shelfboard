/**
 * 设计令牌。
 *
 * 调色板**只在这里定义一份**，然后同时用于两件事：
 * 1. 设置 CSS 变量（供布局与自己写的样式使用）
 * 2. 生成 Naive UI 的 themeOverrides（供组件使用）
 *
 * 分开写两套的话，"改了个颜色但只改了一边"是迟早的事，而且这种不一致
 * 在亮色主题下会格外刺眼（比如按钮是新的、边框还是旧的）。
 */

import type { GlobalThemeOverrides } from 'naive-ui';

export type ThemeMode = 'light' | 'dark' | 'system';
export type ResolvedTheme = 'light' | 'dark';
export type Density = 'comfortable' | 'compact';

export interface Palette {
  /** 应用底色 */
  bg: string;
  /** 卡片 / 面板 */
  surface: string;
  /** 浮起层（下拉、弹层、悬停态） */
  raised: string;
  /** 按下 / 选中的填充 */
  sunken: string;
  border: string;
  borderStrong: string;
  text: string;
  textMuted: string;
  textFaint: string;
  accent: string;
  accentHover: string;
  accentPressed: string;
  accentSoft: string;
  danger: string;
  warn: string;
  ok: string;
  shadow: string;
  shadowStrong: string;
}

const DARK: Palette = {
  bg: '#16161a',
  surface: '#1d1d22',
  raised: '#242429',
  sunken: '#2b2b31',
  border: '#2e2e36',
  borderStrong: '#3d3d47',
  text: '#e6e6ea',
  textMuted: '#9a9aa5',
  textFaint: '#6e6e78',
  // 比原来的 #2080f0 稍柔和：长时间盯着看更舒服
  accent: '#4c9aff',
  accentHover: '#6badff',
  accentPressed: '#3b87e6',
  accentSoft: 'rgba(76, 154, 255, 0.14)',
  danger: '#f0756f',
  warn: '#e8b96a',
  ok: '#3fbf7f',
  shadow: '0 1px 2px rgba(0, 0, 0, 0.28)',
  shadowStrong: '0 12px 32px rgba(0, 0, 0, 0.45)',
};

const LIGHT: Palette = {
  bg: '#f6f7f9',
  surface: '#ffffff',
  raised: '#ffffff',
  sunken: '#eef0f4',
  border: '#e3e6ec',
  borderStrong: '#cfd4dd',
  text: '#1f2329',
  textMuted: '#646c7a',
  textFaint: '#9aa1ad',
  accent: '#2b6cd4',
  accentHover: '#3d7ee6',
  accentPressed: '#235cb4',
  accentSoft: 'rgba(43, 108, 212, 0.10)',
  danger: '#d94b41',
  warn: '#b5772a',
  ok: '#1f9254',
  shadow: '0 1px 2px rgba(16, 24, 40, 0.06)',
  shadowStrong: '0 12px 32px rgba(16, 24, 40, 0.16)',
};

export const PALETTES: Record<ResolvedTheme, Palette> = { dark: DARK, light: LIGHT };

/** 密度影响行高与内边距；桌面工具里"紧凑"往往更好用 */
export interface DensityTokens {
  rowHeight: string;
  cardPadding: string;
  gap: string;
  fontSize: string;
  /** 控件高度：输入框 / 下拉框 / 数字框 / 日期框 / 按钮共用同一档 */
  controlHeight: ControlScale;
  /** 控件里的字号：跟着高度一起变，否则大框里挤着小字 */
  controlFontSize: ControlScale;
}

/** 四档控件尺寸，对应 Naive 的 tiny / small / medium / large */
export interface ControlScale {
  tiny: string;
  small: string;
  medium: string;
  large: string;
}

/**
 * 两档密度。
 *
 * **控件尺寸必须成档地一起改**：Naive 的输入框、下拉框、按钮、下拉弹层里的选项行
 * 全都从同一组 `common.height*` 取高度。只把输入框调大，同一行的搜索框和"新建"按钮
 * 就会一高一矮 —— 那种"只改了一半"的界面比一律偏小更显眼。
 *
 * **两档必须差得看得见**（用户 2026-09-25 反馈「界面密度的功能无效」）：
 * 上一版是 34px 对 36px、字号 13 对 13.5 —— 差 2 像素，肉眼根本看不出来，
 * 用户按了按钮却觉得没反应，这是实打实的可用性问题，不是"用户没注意"。
 * 现在紧凑 34px / 13px，舒适 42px / 14.5px，差 8 像素 + 1.5px 字号，一眼可辨。
 *
 * 紧凑档的数值**保持不变**（34px / 13px）：它是用户日常在用的那一档，
 * 上一轮刚按"输入框太小"的反馈调到这儿，不能因为这次改动又把它调小。
 */
export const DENSITIES: Record<Density, DensityTokens> = {
  comfortable: {
    rowHeight: '38px',
    cardPadding: '16px',
    gap: '14px',
    fontSize: '14px',
    controlHeight: { tiny: '30px', small: '42px', medium: '42px', large: '48px' },
    controlFontSize: { tiny: '13.5px', small: '14.5px', medium: '14.5px', large: '15.5px' },
  },
  compact: {
    rowHeight: '28px',
    cardPadding: '10px',
    gap: '8px',
    fontSize: '13px',
    controlHeight: { tiny: '24px', small: '34px', medium: '34px', large: '40px' },
    controlFontSize: { tiny: '12px', small: '13px', medium: '13px', large: '14px' },
  },
};

/** 把调色板写进 CSS 变量，供布局与自定义样式使用 */
export function paletteToCssVariables(palette: Palette): Record<string, string> {
  return {
    '--pm-bg': palette.bg,
    '--pm-surface': palette.surface,
    '--pm-raised': palette.raised,
    '--pm-sunken': palette.sunken,
    '--pm-border': palette.border,
    '--pm-border-strong': palette.borderStrong,
    '--pm-text': palette.text,
    '--pm-text-muted': palette.textMuted,
    '--pm-text-faint': palette.textFaint,
    '--pm-accent': palette.accent,
    '--pm-accent-hover': palette.accentHover,
    '--pm-accent-pressed': palette.accentPressed,
    '--pm-accent-soft': palette.accentSoft,
    '--pm-danger': palette.danger,
    '--pm-warn': palette.warn,
    '--pm-ok': palette.ok,
    '--pm-shadow': palette.shadow,
    '--pm-shadow-strong': palette.shadowStrong,
  };
}

export function densityToCssVariables(density: Density): Record<string, string> {
  const tokens = DENSITIES[density];
  return {
    '--pm-row-height': tokens.rowHeight,
    '--pm-card-padding': tokens.cardPadding,
    '--pm-gap': tokens.gap,
    '--pm-font-size': tokens.fontSize,
    // 自定义控件（卡片上的状态标签之类）要跟 Naive 的输入框对齐时用这两个
    '--pm-control-height': tokens.controlHeight.medium,
    '--pm-control-height-sm': tokens.controlHeight.small,
  };
}

/**
 * Naive UI 的主题覆盖。
 *
 * 只覆盖必要项，其余交给 Naive 自己的亮/暗基色 ——
 * 全量覆盖等于自己实现一套主题，既费事又会随着组件库升级而错位。
 *
 * **控件尺寸在这里统一**：Naive 的输入框、下拉框（InternalSelection）、数字框、日期框、
 * 按钮、以及下拉弹层里的选项行，高度与字号都从 `common.height*` / `common.fontSize*` 里取，
 * 所以只改这一处就能让整个项目里的控件一起变成同一档 —— 不需要去每个页面调 `size` 属性，
 * 也不会出现"某个页面漏改"的情况。密度（舒适 / 紧凑）跟着一起切。
 */
export function naiveThemeOverrides(
  palette: Palette,
  fontFamily: string,
  density: Density,
): GlobalThemeOverrides {
  const tokens = DENSITIES[density];
  return {
    common: {
      fontFamily,
      /*
       * 基础字号跟着密度走。
       *
       * 这里原先是写死的 `'13px'`，结果密度切换只有控件高度变、**正文文字始终 13px** ——
       * Naive 的全局样式会用它覆盖 `body` 的 font-size，所以 styles.css 里那句
       * `font-size: var(--pm-font-size, 13px)` 根本轮不上（实测：CSS 变量确实是 14px，
       * 但 body 的计算字号还是 13）。用户说的「界面密度的功能无效」有一半是这个原因。
       */
      fontSize: tokens.fontSize,
      fontSizeTiny: tokens.controlFontSize.tiny,
      fontSizeSmall: tokens.controlFontSize.small,
      fontSizeMedium: tokens.controlFontSize.medium,
      fontSizeLarge: tokens.controlFontSize.large,

      heightTiny: tokens.controlHeight.tiny,
      heightSmall: tokens.controlHeight.small,
      heightMedium: tokens.controlHeight.medium,
      heightLarge: tokens.controlHeight.large,

      borderRadius: '8px',
      borderRadiusSmall: '6px',

      primaryColor: palette.accent,
      primaryColorHover: palette.accentHover,
      primaryColorPressed: palette.accentPressed,
      primaryColorSuppl: palette.accentHover,

      errorColor: palette.danger,
      warningColor: palette.warn,
      successColor: palette.ok,
      infoColor: palette.accent,

      textColorBase: palette.text,
      textColor1: palette.text,
      textColor2: palette.text,
      textColor3: palette.textMuted,
      borderColor: palette.border,
      dividerColor: palette.border,
      hoverColor: palette.accentSoft,
      modalColor: palette.surface,
      popoverColor: palette.raised,
      cardColor: palette.surface,
      bodyColor: palette.bg,
      tableColor: palette.surface,
      inputColor: palette.raised,
      codeColor: palette.sunken,
      boxShadow1: palette.shadow,
      boxShadow2: palette.shadowStrong,
      boxShadow3: palette.shadowStrong,
    },
    Card: {
      paddingMedium: '16px 18px',
      color: palette.surface,
      borderColor: palette.border,
    },
    Dialog: { color: palette.surface },
    Drawer: { color: palette.surface },
    DataTable: {
      thColor: palette.sunken,
      thTextColor: palette.textMuted,
      tdColorHover: palette.accentSoft,
      borderColor: palette.border,
      thPaddingMedium: '8px 10px',
      tdPaddingMedium: '7px 10px',
    },
    Button: {
      textColorGhost: palette.text,
      colorGhost: 'transparent',
    },
    Tag: { borderRadius: '6px' },
    Input: { color: palette.raised, colorFocus: palette.raised },
    Select: { peers: { InternalSelection: { color: palette.raised, colorActive: palette.raised } } },
    Layout: {
      color: palette.bg,
      siderColor: palette.surface,
      headerColor: palette.surface,
      siderBorderColor: palette.border,
      headerBorderColor: palette.border,
    },
    Menu: {
      color: 'transparent',
      itemColorHover: palette.accentSoft,
      itemColorActive: palette.accentSoft,
      itemColorActiveHover: palette.accentSoft,
      itemTextColor: palette.textMuted,
      itemTextColorHover: palette.text,
      itemTextColorActive: palette.accent,
      itemTextColorActiveHover: palette.accent,
      itemIconColor: palette.textFaint,
      itemIconColorHover: palette.text,
      itemIconColorActive: palette.accent,
      borderRadius: '8px',
    },
  };
}

/** 界面字体栈：优先中文字形覆盖较好的字体，避免"微软雅黑 + 等宽"混排突兀 */
export const FONT_FAMILY =
  '-apple-system, BlinkMacSystemFont, "Segoe UI", "Microsoft YaHei UI", "Microsoft YaHei", system-ui, sans-serif';

export const MONO_FONT_FAMILY = '"Cascadia Mono", "JetBrains Mono", Consolas, "Courier New", monospace';
