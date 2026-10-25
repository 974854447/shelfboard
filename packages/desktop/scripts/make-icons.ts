/**
 * 生成打包用的图标文件：`build/icon.ico` 与 `build/icon.png`。
 *
 * 用法（在仓库根目录）：
 *   pnpm exec tsx packages/desktop/scripts/make-icons.ts
 *
 * ## 为什么自己编码 PNG/ICO
 *
 * 这类活儿通常靠 `sharp` / `png-to-ico` 之类的依赖，但为了两个图标文件
 * 往仓库里加一条图像处理依赖链（还要带原生二进制）不划算：
 * PNG 就是 `zlib.deflate` 加几个块，ICO 就是一个小目录表，
 * 用 Node 内置能力几十行就能写对，而且**离线可复现**。
 *
 * ## 为什么不直接手放一张现成的 png
 *
 * 图标和托盘用的是同一份几何（`src/main/brand-mark.ts`）。
 * 生成而不是手放，才能保证"换一次几何，托盘和 exe 一起变"，
 * 不会出现托盘变了、安装完的图标还是旧的这种错位。
 *
 * ## 自检
 *
 * 生成的图如果是一张全透明或全纯色的图，Electron 不报错、打包也不报错，
 * 但用户看到的是一个空白方块。所以这里对每个尺寸都断言：
 * 不透明像素占比合理、且**确实画出了白色前景**。不满足就直接非零退出。
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateSync } from 'node:zlib';

import { renderBrandRgba, type Bitmap } from '../src/main/brand-mark';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = join(HERE, '..', 'build');

/* ------------------------------------------------------------------ */
/* PNG 编码                                                            */
/* ------------------------------------------------------------------ */

let crcTable: number[] | null = null;

function crc32(buffer: Buffer): number {
  if (crcTable === null) {
    crcTable = [];
    for (let n = 0; n < 256; n += 1) {
      let c = n;
      for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c >>> 0;
    }
  }

  let crc = 0xffffffff;
  for (const byte of buffer) crc = (crcTable[(crc ^ byte) & 0xff] as number) ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const typeBuffer = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuffer, data])), 0);
  return Buffer.concat([length, typeBuffer, data, crc]);
}

/** RGBA 位图 → PNG 文件内容 */
function encodePng(bitmap: Bitmap): Buffer {
  const { buffer, width, height } = bitmap;

  // 每行前面加一个 filter 字节（0 = None）。
  // 图标是大片纯色，用 None 反而比用 Sub/Up 更容易被 zlib 压好。
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y += 1) {
    raw[y * (stride + 1)] = 0;
    buffer.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // 位深
  ihdr[9] = 6; // 颜色类型：真彩 + alpha
  ihdr[10] = 0; // 压缩方式
  ihdr[11] = 0; // 滤波方式
  ihdr[12] = 0; // 隔行扫描：无

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', deflateSync(raw, { level: 9 })),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

/* ------------------------------------------------------------------ */
/* ICO 编码                                                            */
/* ------------------------------------------------------------------ */

/**
 * RGBA 位图 → ICO 里的 DIB（BMP）条目。
 *
 * 32 位 DIB 的像素是**自下而上**、且必须是 BGRA；
 * 位图信息头里的高度要写**两倍**（下半部分是 AND 掩码）。
 * 掩码在 32 位图标里可以全 0（透明度走 alpha 通道），但**必须存在** ——
 * 少了这段，图标的行数就少一半，很多解析器会直接报错或画出半张图。
 */
function encodeDib(bitmap: Bitmap): Buffer {
  const { buffer, width, height } = bitmap;

  const header = Buffer.alloc(40);
  header.writeUInt32LE(40, 0); // biSize
  header.writeInt32LE(width, 4);
  header.writeInt32LE(height * 2, 8); // 高度翻倍：含 AND 掩码
  header.writeUInt16LE(1, 12); // biPlanes
  header.writeUInt16LE(32, 14); // biBitCount
  header.writeUInt32LE(0, 16); // biCompression = BI_RGB
  header.writeUInt32LE(width * height * 4, 20); // biSizeImage

  const pixels = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    const src = (height - 1 - y) * width * 4; // 自下而上
    const dst = y * width * 4;
    for (let x = 0; x < width; x += 1) {
      const s = src + x * 4;
      const d = dst + x * 4;
      pixels[d] = buffer[s + 2] as number; // B
      pixels[d + 1] = buffer[s + 1] as number; // G
      pixels[d + 2] = buffer[s] as number; // R
      pixels[d + 3] = buffer[s + 3] as number; // A
    }
  }

  // AND 掩码：每行按 4 字节对齐
  const maskStride = Math.ceil(width / 32) * 4;
  const mask = Buffer.alloc(maskStride * height);

  return Buffer.concat([header, pixels, mask]);
}

export interface IcoEntry {
  size: number;
  payload: Buffer;
}

/** 组装 ICO：6 字节文件头 + 每项 16 字节目录 + 各项数据 */
function encodeIco(entries: IcoEntry[]): Buffer {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // 保留
  header.writeUInt16LE(1, 2); // 类型：1 = 图标
  header.writeUInt16LE(entries.length, 4);

  const directory = Buffer.alloc(16 * entries.length);
  let offset = 6 + 16 * entries.length;

  entries.forEach((entry, index) => {
    const base = index * 16;
    // 256 在这里要写 0（一个字节放不下 256）—— 写 256 会被截成 0，
    // 所以"等于 0 表示 256"是这个格式的约定，不是巧合。
    directory[base] = entry.size >= 256 ? 0 : entry.size;
    directory[base + 1] = entry.size >= 256 ? 0 : entry.size;
    directory[base + 2] = 0; // 调色板数
    directory[base + 3] = 0; // 保留
    directory.writeUInt16LE(1, base + 4); // 颜色平面
    directory.writeUInt16LE(32, base + 6); // 位深
    directory.writeUInt32LE(entry.payload.length, base + 8);
    directory.writeUInt32LE(offset, base + 12);
    offset += entry.payload.length;
  });

  return Buffer.concat([header, directory, ...entries.map((e) => e.payload)]);
}

/* ------------------------------------------------------------------ */
/* 生成                                                                */
/* ------------------------------------------------------------------ */

/** 每个尺寸的超采样倍数：越大越平滑，代价是平方级的采样量 */
function samplesFor(size: number): number {
  if (size <= 64) return 4;
  if (size <= 128) return 3;
  return 2;
}

function analyse(bitmap: Bitmap): { opaqueRatio: number; glyph: number } {
  let opaque = 0;
  let glyph = 0;
  for (let i = 0; i < bitmap.buffer.length; i += 4) {
    if ((bitmap.buffer[i + 3] as number) < 128) continue;
    opaque += 1;
    const r = bitmap.buffer[i] as number;
    const g = bitmap.buffer[i + 1] as number;
    const b = bitmap.buffer[i + 2] as number;
    // 用**亮度**判定前景，而不是"是否纯白"：抗锯齿会把条的边缘拉成浅蓝，
    // 死抠 255 会让 16px 这种小图误判成"没画图案"。
    // 品牌蓝 #4c9aff 的亮度约 142，白色 255，取 190 正好落在两者之间。
    const luminance = 0.299 * r + 0.587 * g + 0.114 * b;
    if (luminance > 190) glyph += 1;
  }
  return { opaqueRatio: opaque / (bitmap.width * bitmap.height), glyph };
}

/* ------------------------------------------------------------------ */
/* 放大预览图（用来肉眼核对小尺寸是否还认得出来）                        */
/* ------------------------------------------------------------------ */

function magnify(source: Bitmap, factor: number): Bitmap {
  const size = source.width * factor;
  const buffer = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const sx = Math.floor(x / factor);
      const sy = Math.floor(y / factor);
      const from = (sy * source.width + sx) * 4;
      const to = (y * size + x) * 4;
      buffer[to] = source.buffer[from] as number;
      buffer[to + 1] = source.buffer[from + 1] as number;
      buffer[to + 2] = source.buffer[from + 2] as number;
      buffer[to + 3] = source.buffer[from + 3] as number;
    }
  }
  return { buffer, width: size, height: size };
}

/** 把 src 以 alpha 混合贴到 dst 的 (x, y) 处 */
function paste(dst: Bitmap, src: Bitmap, x: number, y: number): void {
  for (let sy = 0; sy < src.height; sy += 1) {
    for (let sx = 0; sx < src.width; sx += 1) {
      const dx = x + sx;
      const dy = y + sy;
      if (dx < 0 || dy < 0 || dx >= dst.width || dy >= dst.height) continue;
      const from = (sy * src.width + sx) * 4;
      const to = (dy * dst.width + dx) * 4;
      const alpha = (src.buffer[from + 3] as number) / 255;
      for (let c = 0; c < 3; c += 1) {
        const over = (src.buffer[from + c] as number) * alpha;
        const under = (dst.buffer[to + c] as number) * (1 - alpha);
        dst.buffer[to + c] = Math.round(over + under);
      }
      dst.buffer[to + 3] = 255;
    }
  }
}

/**
 * 拼一张预览图：小尺寸按整数倍放大后横排（上下两行分别是详细版与简化版），下面放 256 原图。
 *
 * 存在的理由：16px 的图标只有 256 个像素，直接看是看不清的，
 * 而"小尺寸下糊成一团"恰恰是图标最典型的失败方式 —— 必须放大到能看清才能判断。
 * 两种精度并排画，是为了用眼睛决定小尺寸该用哪一种，而不是靠推理。
 */
function buildPreview(rendered: Map<number, Bitmap>, simple: Map<number, Bitmap>): Bitmap {
  const gap = 16;
  const smallSizes = [16, 24, 32, 48, 64];
  const factor = 5;
  const bandHeight = Math.max(...smallSizes) * factor;

  let bandWidth = gap;
  for (const size of smallSizes) bandWidth += size * factor + gap;

  const width = Math.max(bandWidth, 256 + gap * 2);
  const height = bandHeight * 2 + gap * 4 + 256;

  const canvas: Bitmap = {
    buffer: Buffer.alloc(width * height * 4),
    width,
    height,
  };
  // 中灰底：纯白与品牌蓝在中灰上都看得清
  for (let i = 0; i < canvas.buffer.length; i += 4) {
    canvas.buffer[i] = 0x38;
    canvas.buffer[i + 1] = 0x38;
    canvas.buffer[i + 2] = 0x3c;
    canvas.buffer[i + 3] = 255;
  }

  const strip = (source: Map<number, Bitmap>, top: number, sizes: number[]): void => {
    let x = gap;
    for (const size of sizes) {
      const bitmap = source.get(size);
      if (!bitmap) continue;
      const scaled = magnify(bitmap, factor);
      paste(canvas, scaled, x, top + (bandHeight - scaled.height));
      x += scaled.width + gap;
    }
  };

  strip(rendered, gap, smallSizes);
  strip(simple, bandHeight + gap * 2, smallSizes);

  const big = rendered.get(256);
  if (big) paste(canvas, big, Math.round((width - 256) / 2), bandHeight * 2 + gap * 3);

  return canvas;
}


function main(): void {
  mkdirSync(OUT_DIR, { recursive: true });

  const icoSizes = [16, 24, 32, 48, 64, 128, 256];
  const entries: IcoEntry[] = [];
  const rendered = new Map<number, Bitmap>();
  const simplified = new Map<number, Bitmap>();
  const failures: string[] = [];

  console.log('生成图标（几何来自 src/main/brand-mark.ts）：');

  for (const size of icoSizes) {
    // 小尺寸用简化版：0.0376 的描边在 16px 上只有 0.6px，描边卡片会糊成一片灰。
    // 但预览里**两种精度都渲染**，好让"小尺寸到底该用哪种"是靠眼睛定下来的。
    const useDetailed = size >= 48;
    const detailedBitmap = renderBrandRgba(size, { detailed: true, samples: samplesFor(size) });
    const simpleBitmap = renderBrandRgba(size, { detailed: false, samples: samplesFor(size) });
    const bitmap = useDetailed ? detailedBitmap : simpleBitmap;

    const { opaqueRatio, glyph } = analyse(bitmap);
    rendered.set(size, detailedBitmap);
    simplified.set(size, simpleBitmap);

    // 256 用 PNG 压缩（这是 ICO 里唯一被广泛支持的 PNG 尺寸），
    // 更小的尺寸用 DIB：老工具链（rcedit 等）对 PNG 条目支持不一。
    const payload = size >= 256 ? encodePng(bitmap) : encodeDib(bitmap);
    entries.push({ size, payload });

    console.log(
      `  ${size}×${size}  ${size >= 256 ? 'PNG' : 'DIB'}  ${String(payload.length).padStart(6)} B  ${useDetailed ? '详细版' : '简化版'}  不透明 ${(opaqueRatio * 100).toFixed(1)}%  前景 ${String(glyph).padStart(5)}px`,
    );

    if (opaqueRatio < 0.6) {
      failures.push(`${size}×${size} 不透明像素过少（${(opaqueRatio * 100).toFixed(1)}%）—— 圆角画歪了？`);
    }
    // 前景下限随尺寸放大：小图本来就没几个像素，但"一个都没有"必须拦住
    if (glyph < size * 1.5) {
      failures.push(`${size}×${size} 前景像素过少（${glyph}px）—— 图案没画上去，或者小尺寸下太细了？`);
    }
  }

  const iconPath = join(OUT_DIR, 'icon.ico');
  const ico = encodeIco(entries);
  writeFileSync(iconPath, ico);

  // 512 的 PNG 作为通用图标（非 Windows 平台与文档用）
  const big = renderBrandRgba(512, { detailed: true, samples: 2 });
  const pngPath = join(OUT_DIR, 'icon.png');
  writeFileSync(pngPath, encodePng(big));
  const bigStats = analyse(big);
  console.log(
    `  512×512  PNG                   详细版  不透明 ${(bigStats.opaqueRatio * 100).toFixed(1)}%  前景 ${bigStats.glyph}px`,
  );
  if (bigStats.glyph < 512) failures.push(`512×512 几乎没有前景（${bigStats.glyph}px）`);

  // 预览图：上排详细版、下排简化版，方便肉眼核对小尺寸
  const previewPath = join(OUT_DIR, 'icon-preview.png');
  writeFileSync(previewPath, encodePng(buildPreview(rendered, simplified)));

  console.log(
    `\n已写出：\n  ${iconPath}（${ico.length} B，含 ${icoSizes.join('/')}）\n  ${pngPath}\n  ${previewPath}（上排=详细版，下排=简化版，均放大 5 倍 + 256 原图）`,
  );

  if (failures.length > 0) {
    console.error(`\n自检未通过：\n  - ${failures.join('\n  - ')}`);
    process.exit(1);
  }
}

main();
