/**
 * 把本地 HTML 渲染成 PNG（只用于生成设计样式参考图）。
 *
 * 为什么用 Electron 自己当渲染器：它就在仓库里（app 的运行时），
 * 不需要装 puppeteer / playwright，也不需要额外下载浏览器；
 * 而且截图结果是**我能自己看**的 PNG（不然只能把 HTML 丢给用户，我自己不知道渲染成什么样）。
 *
 * 用法：electron scripts/mockup-shot.cjs <input.html> <output.png> [宽 高]
 */

const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');

const [, , input, output, widthArg, heightArg, onlyArg, heroArg] = process.argv;
const width = Number(widthArg ?? 1400);
const height = Number(heightArg ?? 1200);

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width,
    height,
    show: false,
    webPreferences: { offscreen: true },
  });

  const query = {};
  if (onlyArg && onlyArg !== '-') query.only = onlyArg;
  if (heroArg === '0') query.hero = '0';
  await win.loadFile(path.resolve(input), { query });
  // 等字体与布局稳定（本地文件没有网络资源，几百毫秒足够）
  await new Promise((resolve) => setTimeout(resolve, 900));

  const image = await win.webContents.capturePage();
  fs.writeFileSync(path.resolve(output), image.toPNG());
  process.stdout.write(`已生成 ${output}\n`);
  app.quit();
});
