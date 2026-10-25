/**
 * 品牌标记的几何定义与栅格化。
 *
 * ## 为什么只有一份
 *
 * 这个标记会出现在四个地方：托盘图标、窗口/任务栏图标、界面左上角的品牌块、
 * 以及打包时嵌进 exe 的 `build/icon.ico`。如果每处各画一遍，
 * 迟早会出现"托盘上是一个样子、装完之后是另一个样子"。
 * 所以几何只在这里定义，其它地方一律取这里的输出。
 *
 * ## 两种精度
 *
 * 图案本身是"三条记录，每条前面一个标记"（对应源图标：三张卡片 + 卡内标记，
 * 第三张的标记是长条而不是圆点）：
 *
 * - `detailed`：带描边的三张卡片 + 卡内标记 —— 给应用图标用（≥48px 看得清描边）
 * - 简化版：三行"标记 + 实心长条" —— 给托盘用（16px 下 1px 的描边会糊成一团）
 *
 * 简化版不是偷懒：16×16 的托盘图标上，描边卡片的内腔只有不到 1px，
 * 画出来是灰糊的一团。真实的图标设计就是在小尺寸下换更粗的骨架。
 *
 * ## 不依赖 electron
 *
 * 这里刻意不 import electron：绘制能在普通 Node 与单测里跑，
 * 图标生成脚本（打包用）也能直接复用同一份几何。
 */

export interface Bitmap {
  /** RGBA 或 BGRA，取决于调用方；长度恒为 width * height * 4 */
  buffer: Buffer;
  width: number;
  height: number;
}

/**
 * 品牌主色。
 *
 * 与界面里的 `--pm-accent` 是同一个值（tokens.ts 里的 `#4c9aff`）。
 * 刻意**用纯色而不是渐变**：界面里的品牌块就是这个纯色，
 * 图标跟着走才能"是同一个东西"；顺便也让托盘图标的断言能卡死"只有两种颜色"。
 */
const ACCENT = { r: 0x4c, g: 0x9a, b: 0xff };

const GLYPH = { r: 0xff, g: 0xff, b: 0xff };

/** 圆角方块的形状：内缩 5.5%、圆角半径 23.5%（接近 Windows 11 图标的比例） */
const TILE_INSET = 0.055;
const TILE_RADIUS = 0.235;

/** 三行的纵向中心（归一化）。两种精度共用同一组，各尺寸的三行才对得齐 */
const ROW_CENTERS = [0.244, 0.5, 0.756];

/**
 * 详细版：三张带描边的卡片，卡内一个标记。
 *
 * 比例是**照着源图量的**：源图里卡片很高（约卡片宽的 1/4）、描边很粗（约卡片高的 1/5）、
 * 卡间距约卡片高的 1/3。第一版我按"精致细线"的路子画（描边只有卡片高的 1/5 都不到），
 * 结果放大看跟源图完全不是一回事 —— 源图的辨识度恰恰来自那几根粗描边。
 */
const DETAILED = {
  cardHeight: 0.188,
  cardLeft: 0.155,
  cardRight: 0.845,
  cardRadius: 0.047,
  stroke: 0.0376,
  /** 圆点标记（前两行） */
  dotRadius: 0.032,
  dotCenterX: 0.275,
  /** 长条标记（第三行，对应源图里那根被拉长的标记） */
  pillLeft: 0.215,
  pillRight: 0.375,
  pillRadius: 0.032,
};

/**
 * 简化版：三行"标记 + 实心长条"，行 3 的标记拉长。
 *
 * 用来回答一个具体问题：16×16 上，0.0376 的描边只有 0.6px ——
 * 描边卡片会糊成一片灰，而"标记 + 长条"还认得出是三行东西。
 */
const SIMPLE = {
  barHeight: 0.105,
  markLeft: 0.185,
  markRight: 0.31,
  longMarkRight: 0.44,
  barLeft: 0.385,
  barRight: 0.845,
  longBarLeft: 0.515,
};

/**
 * 小尺寸下把骨架加粗。
 *
 * 16×16 时 0.105 的条高只有 1.68px，抗锯齿之后几乎没有"纯白"像素 ——
 * 实测只剩 12 个，肉眼是一团灰。真实图标设计里这一步叫 hinting：
 * 小尺寸换更粗的骨架，而不是把大图等比缩小。
 */
function strokeWeight(size: number): number {
  if (size <= 20) return 1.25;
  if (size <= 32) return 1.1;
  return 1;
}

/** 点 (px, py) 是否落在圆角矩形内（归一化坐标） */
function insideRoundRect(
  px: number,
  py: number,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  radius: number,
): boolean {
  const cx = Math.min(Math.max(px, x0 + radius), x1 - radius);
  const cy = Math.min(Math.max(py, y0 + radius), y1 - radius);
  const dx = px - cx;
  const dy = py - cy;
  return dx * dx + dy * dy <= radius * radius;
}

/** 详细版的图案：卡片描边环 + 卡内标记 */
function insideDetailedGlyph(px: number, py: number): boolean {
  const { cardHeight, cardLeft, cardRight, cardRadius, stroke } = DETAILED;
  const { dotCenterX, dotRadius, pillLeft, pillRight, pillRadius } = DETAILED;

  for (let i = 0; i < ROW_CENTERS.length; i += 1) {
    const centerY = ROW_CENTERS[i] as number;
    const top = centerY - cardHeight / 2;
    const bottom = centerY + cardHeight / 2;

    // 描边环 = 在外框内、但不在内框里
    const inOuter = insideRoundRect(px, py, cardLeft, top, cardRight, bottom, cardRadius);
    if (inOuter) {
      const innerRadius = Math.max(cardRadius - stroke, 0.001);
      const inInner = insideRoundRect(
        px,
        py,
        cardLeft + stroke,
        top + stroke,
        cardRight - stroke,
        bottom - stroke,
        innerRadius,
      );
      if (!inInner) return true;
    }

    // 卡内标记：前两行是圆点，第三行是长条
    const isLast = i === ROW_CENTERS.length - 1;
    const markTop = centerY - pillRadius;
    const markBottom = centerY + pillRadius;
    if (isLast) {
      if (insideRoundRect(px, py, pillLeft, markTop, pillRight, markBottom, pillRadius)) return true;
    } else {
      if (
        insideRoundRect(
          px,
          py,
          dotCenterX - dotRadius,
          centerY - dotRadius,
          dotCenterX + dotRadius,
          centerY + dotRadius,
          dotRadius,
        )
      ) {
        return true;
      }
    }
  }

  return false;
}

/** 简化版的图案：标记 + 长条 */
function insideSimpleGlyph(px: number, py: number, weight: number): boolean {
  const { markLeft, markRight, longMarkRight, barLeft, barRight, longBarLeft } = SIMPLE;
  const barHeight = SIMPLE.barHeight * weight;
  const half = barHeight / 2;
  const radius = half;

  for (let i = 0; i < ROW_CENTERS.length; i += 1) {
    const centerY = ROW_CENTERS[i] as number;
    const top = centerY - half;
    const bottom = centerY + half;
    const isLast = i === ROW_CENTERS.length - 1;

    const markEnd = isLast ? longMarkRight : markRight;
    if (insideRoundRect(px, py, markLeft, top, markEnd, bottom, radius)) return true;

    const barStart = isLast ? longBarLeft : barLeft;
    if (insideRoundRect(px, py, barStart, top, barRight, bottom, radius)) return true;
  }

  return false;
}

export interface RenderOptions {
  /** 详细版（应用图标）还是简化版（托盘）。默认详细版 */
  detailed?: boolean;
  /**
   * 每边的超采样倍数：1 = 不抗锯齿。
   *
   * 托盘图标**故意用 1**：不抗锯齿时整张图只有两种颜色，
   * 断言就能直接卡死"只有强调蓝和白"，通道顺序写反立刻暴露。
   */
  samples?: number;
}

interface Rgba {
  r: number;
  g: number;
  b: number;
  a: number;
}

const TRANSPARENT: Rgba = { r: 0, g: 0, b: 0, a: 0 };

/** 取一个样本点的颜色（预览用，坐标是归一化的 0..1） */
function sample(px: number, py: number, detailed: boolean, weight: number): Rgba {
  const insideTile = insideRoundRect(
    px,
    py,
    TILE_INSET,
    TILE_INSET,
    1 - TILE_INSET,
    1 - TILE_INSET,
    TILE_RADIUS,
  );
  if (!insideTile) return TRANSPARENT;

  const inGlyph = detailed ? insideDetailedGlyph(px, py) : insideSimpleGlyph(px, py, weight);
  const color = inGlyph ? GLYPH : ACCENT;
  return { r: color.r, g: color.g, b: color.b, a: 255 };
}

/**
 * 渲染成 RGBA 位图。
 *
 * 超采样时按**预乘 alpha** 平均，再还原 —— 直接平均非预乘的颜色，
 * 边缘会混进透明像素里那圈黑色的 RGB，图标边上会出现一圈脏边。
 */
export function renderBrandRgba(size: number, options: RenderOptions = {}): Bitmap {
  const { detailed = true, samples = 1 } = options;
  const steps = Math.max(1, Math.floor(samples));
  const perPixel = steps * steps;
  const buffer = Buffer.alloc(size * size * 4);
  const weight = strokeWeight(size);

  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      let sumR = 0;
      let sumG = 0;
      let sumB = 0;
      let sumA = 0;

      for (let sy = 0; sy < steps; sy += 1) {
        for (let sx = 0; sx < steps; sx += 1) {
          const px = (x + (sx + 0.5) / steps) / size;
          const py = (y + (sy + 0.5) / steps) / size;
          const c = sample(px, py, detailed, weight);
          const alpha = c.a / 255;
          sumR += c.r * alpha;
          sumG += c.g * alpha;
          sumB += c.b * alpha;
          sumA += alpha;
        }
      }

      const alpha = sumA / perPixel;
      const offset = (y * size + x) * 4;
      if (alpha > 0) {
        buffer[offset] = Math.round(sumR / perPixel / alpha);
        buffer[offset + 1] = Math.round(sumG / perPixel / alpha);
        buffer[offset + 2] = Math.round(sumB / perPixel / alpha);
        buffer[offset + 3] = Math.round(alpha * 255);
      }
    }
  }

  return { buffer, width: size, height: size };
}

/**
 * 渲染成 BGRA 位图。
 *
 * `nativeImage.createFromBitmap` 在 Windows 上要求 **BGRA** 而不是 RGBA ——
 * 写反了颜色会整体偏蓝或偏红，而且**不会报任何错**，只能靠断言像素发现。
 */
export function renderBrandBgra(size: number, options: RenderOptions = {}): Bitmap {
  const { buffer, width, height } = renderBrandRgba(size, options);
  const swapped = Buffer.alloc(buffer.length);
  for (let i = 0; i < buffer.length; i += 4) {
    swapped[i] = buffer[i + 2] as number;
    swapped[i + 1] = buffer[i + 1] as number;
    swapped[i + 2] = buffer[i] as number;
    swapped[i + 3] = buffer[i + 3] as number;
  }
  return { buffer: swapped, width, height };
}

/** 统计完全不透明的像素数，供自检与测试使用 */
export function countOpaquePixels(bitmap: Bitmap): number {
  let count = 0;
  for (let i = 3; i < bitmap.buffer.length; i += 4) {
    if (bitmap.buffer[i] === 255) count += 1;
  }
  return count;
}

/** 品牌主色的十六进制写法，供界面与文档引用，避免各处硬编码 */
export const BRAND_ACCENT = '#4c9aff';
