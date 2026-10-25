import { describe, expect, it } from 'vitest';

import { countOpaquePixels, renderAppIconBitmap, renderTrayBitmap } from '../src/main/tray-icon';

/**
 * 托盘图标的绘制测试。
 *
 * 为什么值得单独测：图标是**代码生成**的，如果生成出一张全透明的图，
 * `new Tray()` 不会报错、应用照常启动，但用户在托盘区什么都看不到 ——
 * 这类问题在代码审查里几乎不可能发现。
 *
 * 图案本身（源图）是"三条记录，每条前面一个标记，第三条的标记被拉长"，
 * 所以除了"画了东西"，还要断言**结构**：三行、每行都有标记、第三行的标记更长。
 */

/** 第 y 行里，从 x=0 开始的第一段连续白色像素的长度（没有则 0） */
function firstWhiteRun(bitmap: ReturnType<typeof renderTrayBitmap>, y: number): number {
  let run = 0;
  for (let x = 0; x < bitmap.width; x += 1) {
    const offset = (y * bitmap.width + x) * 4;
    const isWhite =
      bitmap.buffer[offset] === 255 &&
      bitmap.buffer[offset + 1] === 255 &&
      bitmap.buffer[offset + 2] === 255;
    if (isWhite) run += 1;
    else if (run > 0) break;
  }
  return run;
}

/** 每一行是否含有白色像素 */
function whiteRows(bitmap: ReturnType<typeof renderTrayBitmap>): boolean[] {
  const rows: boolean[] = [];
  for (let y = 0; y < bitmap.height; y += 1) {
    let has = false;
    for (let x = 0; x < bitmap.width; x += 1) {
      const offset = (y * bitmap.width + x) * 4;
      if (
        bitmap.buffer[offset] === 255 &&
        bitmap.buffer[offset + 1] === 255 &&
        bitmap.buffer[offset + 2] === 255
      ) {
        has = true;
        break;
      }
    }
    rows.push(has);
  }
  return rows;
}

/** 把连续为 true 的行归成一段，返回每段的中点行号 */
function bands(rows: boolean[]): number[] {
  const result: number[] = [];
  let start = -1;
  for (let i = 0; i <= rows.length; i += 1) {
    const current = rows[i] === true;
    if (current && start < 0) start = i;
    if (!current && start >= 0) {
      result.push(Math.floor((start + i - 1) / 2));
      start = -1;
    }
  }
  return result;
}

describe('renderTrayBitmap', () => {
  it('尺寸与缓冲长度一致（32 位 BGRA）', () => {
    const bitmap = renderTrayBitmap(32);
    expect(bitmap.width).toBe(32);
    expect(bitmap.height).toBe(32);
    expect(bitmap.buffer.length).toBe(32 * 32 * 4);
  });

  it('不是一张空图 —— 大部分像素应当不透明', () => {
    const bitmap = renderTrayBitmap(32);
    const opaque = countOpaquePixels(bitmap);
    const total = 32 * 32;

    expect(opaque).toBeGreaterThan(0);
    // 实测约 73%：圆角半径 23.5% 会削掉四角，加上 5.5% 的内缩。
    // 阈值取 0.6 是为了拦住"整张图变透明"这类退化，而不是卡死在某个精确比例上。
    expect(opaque / total).toBeGreaterThan(0.6);
  });

  it('四角透明（圆角效果确实生效）', () => {
    const bitmap = renderTrayBitmap(32);
    const alphaAt = (x: number, y: number): number => bitmap.buffer[(y * 32 + x) * 4 + 3] ?? -1;

    expect(alphaAt(0, 0)).toBe(0);
    expect(alphaAt(31, 0)).toBe(0);
    expect(alphaAt(0, 31)).toBe(0);
    expect(alphaAt(31, 31)).toBe(0);
    // 中心区域必须是不透明的
    expect(alphaAt(16, 16)).toBe(255);
  });

  it('通道顺序是 BGRA 而不是 RGBA', () => {
    const bitmap = renderTrayBitmap(32);
    const colors = new Set<string>();

    for (let i = 0; i < bitmap.buffer.length; i += 4) {
      if (bitmap.buffer[i + 3] !== 255) continue;
      colors.add(`${bitmap.buffer[i]},${bitmap.buffer[i + 1]},${bitmap.buffer[i + 2]}`);
    }

    // 托盘刻意不做抗锯齿，所以只应出现两种颜色：品牌蓝（背景）与白（图案）
    expect(colors.size).toBe(2);
    // 背景 #4c9aff 的 BGRA 顺序：B=0xff G=0x9a R=0x4c。
    // 若误写成 RGBA，这里会看到 255,154,76 的反序，从而被断言拦下。
    expect(colors.has('255,154,76')).toBe(true);
    expect(colors.has('255,255,255')).toBe(true);
  });

  it('结构是三行：行与行之间有透明间隙', () => {
    const bitmap = renderTrayBitmap(32);
    const found = bands(whiteRows(bitmap));

    expect(found.length).toBe(3);
    // 三行应当是等距的（源图就是等距三条记录）
    const gaps = [found[1]! - found[0]!, found[2]! - found[1]!];
    expect(Math.abs(gaps[0]! - gaps[1]!)).toBeLessThanOrEqual(1);
  });

  it('第三行的标记比前两行长（源图的辨识特征）', () => {
    const bitmap = renderTrayBitmap(32);
    const rows = bands(whiteRows(bitmap));
    expect(rows.length).toBe(3);

    const first = firstWhiteRun(bitmap, rows[0]!);
    const second = firstWhiteRun(bitmap, rows[1]!);
    const third = firstWhiteRun(bitmap, rows[2]!);

    // 前两行是"圆点标记"，第三行是"拉长的标记"，长度差至少要看得出来
    expect(first).toBeGreaterThan(0);
    expect(first).toBe(second);
    expect(third).toBeGreaterThan(first + 1);
  });

  it('不同尺寸都能正常绘制（HiDPI 会用更大的图）', () => {
    for (const size of [16, 24, 32, 48]) {
      const bitmap = renderTrayBitmap(size);
      expect(bitmap.buffer.length).toBe(size * size * 4);
      expect(countOpaquePixels(bitmap)).toBeGreaterThan(0);
    }
  });

  it('16×16 下图案依然有足够像素（小尺寸会加粗骨架）', () => {
    const bitmap = renderTrayBitmap(16);
    let white = 0;
    for (let i = 0; i < bitmap.buffer.length; i += 4) {
      if (bitmap.buffer[i] === 255 && bitmap.buffer[i + 1] === 255 && bitmap.buffer[i + 2] === 255) {
        white += 1;
      }
    }

    // 实测 56px。这个下限是防"16px 下细成一根发丝、托盘上看起来像个空方块"——
    // 第一版没在小尺寸加粗时只有 12px，就是这么被查出来的。
    expect(white).toBeGreaterThan(30);
  });
});

describe('renderAppIconBitmap', () => {
  it('是抗锯齿的（出现中间色，而不是只有两种纯色）', () => {
    const bitmap = renderAppIconBitmap(64);
    const colors = new Set<string>();

    for (let i = 0; i < bitmap.buffer.length; i += 4) {
      if (bitmap.buffer[i + 3] === 0) continue;
      colors.add(`${bitmap.buffer[i]},${bitmap.buffer[i + 1]},${bitmap.buffer[i + 2]}`);
    }

    // 窗口图标用详细版 + 超采样：边缘应当是渐变的。
    // 若这里只有两种颜色，说明超采样没生效（图标边缘会是一圈硬锯齿）。
    expect(colors.size).toBeGreaterThan(2);
    // 但主体仍然是品牌蓝与白
    expect(colors.has('255,154,76')).toBe(true);
    expect(colors.has('255,255,255')).toBe(true);
  });

  it('尺寸与缓冲长度一致', () => {
    const bitmap = renderAppIconBitmap(128);
    expect(bitmap.width).toBe(128);
    expect(bitmap.height).toBe(128);
    expect(bitmap.buffer.length).toBe(128 * 128 * 4);
  });
});
