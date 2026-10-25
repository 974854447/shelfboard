<script setup lang="ts">
/**
 * 极简图标组件。
 *
 * 刻意**不引入图标库**（`@vicons/ionicons5` 之类）：需要的图标就十来个，
 * 自己写 path 既省一次依赖安装，也让图标风格与界面完全一致
 * （图标库的线宽/圆角往往和自定义组件对不上）。
 *
 * 用 `currentColor` 描边，所以颜色跟着文字走，亮暗主题都不需要额外处理。
 */

export type IconName =
  | 'sun'
  | 'moon'
  | 'monitor'
  | 'board'
  | 'list'
  | 'folder'
  | 'terminal'
  | 'plus'
  | 'chevronLeft'
  | 'chevronRight'
  | 'chevronDown'
  | 'search'
  | 'refresh'
  | 'close'
  | 'external'
  | 'settings'
  | 'trash'
  | 'link'
  | 'alert'
  | 'check'
  | 'clock'
  | 'user'
  | 'rows'
  | 'calendar'
  | 'inbox'
  /** 作业中心：一个"跑起来"的圆 + 三角（比 refresh 更贴"执行一次"的意思） */
  | 'play'
  /** 空状态用的「开启的箱子」（用户给的图案） */
  | 'openBox'
  | 'sidebar'
  /** 总览页的关系数据图就是蜂窝，用六边形做图标名实相符 */
  | 'hex'
  /** 详情（三条记录，每条前面一个实心点）：工作台卡片上悬停滑出的详情入口 */
  | 'detail'
  | 'download'
  /**
   * 「今天做」的手动标记（星形）。
   *
   * 两个名字一个形状：`star` 只有描边（未标记），`starFilled` 额外把星填实（已标记）。
   * 用同一颗星的两态，而不是"星 / 对勾"两种图形 —— 用户点一下就该看得出
   * "还是那颗星，只是亮了"，换图形会让人以为点了别的功能。
   */
  | 'star'
  | 'starFilled';

const PATHS: Record<IconName, string> = {
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41"/>',
  moon: '<path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/>',
  monitor: '<rect x="2.5" y="4" width="19" height="13" rx="2"/><path d="M8 20h8M12 17v3"/>',
  board: '<rect x="3" y="3" width="5.5" height="18" rx="1.5"/><rect x="10.25" y="3" width="5.5" height="12" rx="1.5"/><rect x="17.5" y="3" width="3.5" height="8" rx="1.5"/>',
  list: '<path d="M8 6h13M8 12h13M8 18h13M3.5 6h.01M3.5 12h.01M3.5 18h.01"/>',
  folder: '<path d="M3 7a2 2 0 0 1 2-2h3.5l2 2H19a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7z"/>',
  terminal: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M7.5 9.5l2.5 2.5-2.5 2.5M13 14.5h3.5"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  chevronLeft: '<path d="M15 18l-6-6 6-6"/>',
  chevronRight: '<path d="M9 18l6-6-6-6"/>',
  chevronDown: '<path d="M6 9l6 6 6-6"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="M20.5 20.5l-4.2-4.2"/>',
  refresh: '<path d="M20.5 12a8.5 8.5 0 1 1-2.5-6"/><path d="M20.5 3.5V10h-6.5"/>',
  close: '<path d="M18 6L6 18M6 6l12 12"/>',
  download: '<path d="M12 3.5v9.5"/><path d="M8.3 9.6 12 13.3l3.7-3.7"/><path d="M4.5 17.5v1.2a1.8 1.8 0 0 0 1.8 1.8h11.4a1.8 1.8 0 0 0 1.8-1.8v-1.2"/>',
  external: '<path d="M14 3h7v7M21 3l-9 9M18 14v5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h5"/>',
  settings:
    '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .34 1.87l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.7 1.7 0 0 0-2.87 1.2V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-2.87-1.2l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.7 1.7 0 0 0 3.1 15H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.2-2.87l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.7 1.7 0 0 0 10 4.1V4a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 2.87 1.2l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.7 1.7 0 0 0 20.9 11H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5.9z"/>',
  trash:
    '<path d="M3.6 6.4h16.8"/><rect x="8.9" y="2.6" width="6.2" height="3.8" rx="1.6"/><path d="M5.6 6.4h12.8v12.2a2.2 2.2 0 0 1-2.2 2.2H7.8a2.2 2.2 0 0 1-2.2-2.2z"/><path d="M9.6 10.4v6.4M12 10.4v6.4M14.4 10.4v6.4"/>',
  link: '<path d="M10 13a5 5 0 0 0 7 0l3-3a5 5 0 0 0-7-7l-1 1"/><path d="M14 11a5 5 0 0 0-7 0l-3 3a5 5 0 0 0 7 7l1-1"/>',
  alert: '<path d="M12 9v5M12 17.5h.01"/><path d="M10.3 3.9L2.6 17.4A2 2 0 0 0 4.3 20.4h15.4a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/>',
  check: '<path d="M20 6L9 17l-5-5"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3.5 2"/>',
  user: '<circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/>',
  rows: '<path d="M3 6h18M3 12h18M3 18h18"/>',
  calendar: '<rect x="3" y="4.5" width="18" height="16" rx="2"/><path d="M3 9h18M8 3v3M16 3v3"/>',
  openBox: '<path d="M3.4 9.9 6 5.5h12l2.6 4.4"/><path d="M3.4 9.9h17.2v9a1.4 1.4 0 0 1-1.4 1.4H4.8a1.4 1.4 0 0 1-1.4-1.4z"/><path d="M3.4 9.9 6.5 12.7h11l3.1-2.8"/><path d="M8.9 3.1v2.2M5.6 4.2l1.2 1.8M18.4 4.2l-1.2 1.8"/>',
  inbox: '<path d="M3 12h4l1.5 3h7l1.5-3h4"/><path d="M5 5h14a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2z"/>',
  sidebar: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M9 4v16"/>',
  /** 启动（三角）：项目的"运行"入口，M4 接入作业系统后真正可用 */
  play: '<path d="M8 5.2v13.6L19 12z"/>',
  /** 停止（方块）：与 play 配对 */
  stop: '<rect x="6.5" y="6.5" width="11" height="11" rx="1.5"/>',
  /** 文件（叶子任务）：文件夹视图里表示"没有下级"的任务 */
  file: '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/>',
  /** 六边形：总览页的关系数据图（蜂窝） */
  hex: '<path d="M12 3.2l7.2 4.15v8.3L12 19.8l-7.2-4.15v-8.3z"/>',
  /*
   * 详情：三行「实心圆点 + 圆角横条」（用户给的图案）。
   *
   * 圆点是**填色**、横条是**描边**，所以这两组元素要各自覆盖根节点的
   * fill/stroke —— 根上是 `fill="none" stroke="currentColor"`，
   * 只写 path 的话圆点会变成空心的圈。
   * 比例照图案来（点直径 : 条粗 ≈ 1.7 : 1），但整体画得偏满，
   * 这样在 16~18px 的按钮里点还看得见（缩到 3px 的点等于没有）。
   */
  detail:
    '<circle cx="3.6" cy="5.4" r="2" fill="currentColor" stroke="none"/>' +
    '<circle cx="3.6" cy="12" r="2" fill="currentColor" stroke="none"/>' +
    '<circle cx="3.6" cy="18.6" r="2" fill="currentColor" stroke="none"/>' +
    '<path d="M8.4 5.4h11.8M8.4 12h11.8M8.4 18.6h11.8" stroke-width="2.4"/>',
  star: '<path d="M12 3.5l2.65 5.37 5.93.86-4.29 4.18 1.01 5.9L12 17.03l-5.3 2.78 1.01-5.9-4.29-4.18 5.93-.86z"/>',
  starFilled:
    '<path d="M12 3.5l2.65 5.37 5.93.86-4.29 4.18 1.01 5.9L12 17.03l-5.3 2.78 1.01-5.9-4.29-4.18 5.93-.86z" fill="currentColor"/>',
};

const props = withDefaults(defineProps<{ name: IconName; size?: number }>(), { size: 16 });
</script>

<template>
  <svg
    :width="props.size"
    :height="props.size"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    stroke-width="1.7"
    stroke-linecap="round"
    stroke-linejoin="round"
    aria-hidden="true"
    focusable="false"
    v-html="PATHS[props.name]"
  />
</template>

<style scoped>
svg {
  display: block;
  flex-shrink: 0;
}
</style>
