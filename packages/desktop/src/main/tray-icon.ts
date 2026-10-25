/**
 * 托盘图标的位图绘制。
 *
 * 几何与栅格化在 `brand-mark.ts`（品牌标记只有一份定义，
 * 托盘 / 窗口图标 / 打包用的 .ico 都从那里取）。
 * 这里只做两件事：
 *
 * 1. 选定**托盘**用的精度（简化版 + 不抗锯齿）；
 * 2. 保持 BGRA 通道顺序 —— `createFromBitmap` 在 Windows 上要求 BGRA，
 *    写反了颜色会整体偏蓝偏红，而且不会报错。
 *
 * 托盘为什么用简化版：16×16 下详细版的卡片描边内腔不到 1px，会糊成一团。
 * 为什么不抗锯齿：不抗锯齿时整张图只有两种颜色，断言就能直接卡死
 * "只有强调蓝和白"，通道顺序写反立刻暴露。
 */

import { countOpaquePixels, renderBrandBgra, type Bitmap } from './brand-mark';

export type TrayBitmap = Bitmap;

export { countOpaquePixels };

/** 画出托盘图标的 BGRA 像素缓冲 */
export function renderTrayBitmap(size = 32): TrayBitmap {
  return renderBrandBgra(size, { detailed: false, samples: 1 });
}

/**
 * 画出应用图标（窗口 / 任务栏）的 BGRA 像素缓冲。
 *
 * 用详细版并做超采样：这个尺寸下描边看得清，抗锯齿也才有意义。
 * 打包后任务栏与资源管理器用的是 exe 内嵌的 `build/icon.ico`（同一份几何生成），
 * 这里负责的是**开发运行时**的窗口图标 —— 不设它，开发时任务栏会是一个默认的 Electron 图标。
 */
export function renderAppIconBitmap(size = 256): TrayBitmap {
  return renderBrandBgra(size, { detailed: true, samples: 3 });
}
