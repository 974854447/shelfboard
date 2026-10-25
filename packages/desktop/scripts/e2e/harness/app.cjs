/**
 * 应用的启动与收尾。
 *
 * 两个目标可以跑：
 * - **开发运行时**（`node_modules/electron/dist/electron.exe` + 应用目录）——
 *   快，日常用这个；
 * - **打包后的 exe** —— 慢一些，但它才是用户拿到的那个东西，
 *   能顺带验证 asar、解包的原生模块、内嵌服务（打包前必跑一次）。
 *
 * 不管跑哪个，**一律显式传 `--user-data-dir`**：这是数据沙箱的入口，
 * 也让它优先于应用自己的环境判断（见 main/environment.ts 的优先级表）。
 *
 * 关掉后台节流那几个开关是必须的：窗口不在前台时 Chromium 会降频，
 * 表现是"路由已经切了、界面还没画"，截图与断言都会读到陈旧状态 ——
 * 这种假失败最耗时间，因为看起来像被测代码的问题。
 */

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const { Cdp, findPageTarget, sleep } = require('./cdp.cjs');

const DESKTOP_DIR = path.join(__dirname, '..', '..', '..');

/** 开发运行时的 electron.exe（pnpm 布局下的真实路径） */
function resolveDevElectron() {
  const candidates = [
    path.join(DESKTOP_DIR, '..', '..', 'node_modules', '.pnpm'),
    path.join(DESKTOP_DIR, 'node_modules', '.pnpm'),
  ];
  for (const base of candidates) {
    if (!fs.existsSync(base)) continue;
    const dir = fs
      .readdirSync(base)
      .filter((name) => name.startsWith('electron@'))
      .sort()
      .at(-1);
    if (!dir) continue;
    const exe = path.join(base, dir, 'node_modules', 'electron', 'dist', 'electron.exe');
    if (fs.existsSync(exe)) return exe;
  }
  const fallback = path.join(DESKTOP_DIR, 'node_modules', 'electron', 'dist', 'electron.exe');
  if (fs.existsSync(fallback)) return fallback;
  throw new Error('找不到开发用的 electron.exe，请先 pnpm install');
}

/** 打包产物：优先 release/win-unpacked 里的 exe */
function resolvePackagedExe() {
  const dir = path.join(DESKTOP_DIR, '..', '..', 'release', 'win-unpacked');
  if (!fs.existsSync(dir)) return null;
  const exe = fs.readdirSync(dir).find((name) => name.endsWith('.exe') && !/^elevate/i.test(name));
  return exe ? path.join(dir, exe) : null;
}

function resolveTarget(kind) {
  if (kind === 'packaged') {
    const exe = resolvePackagedExe();
    if (!exe) throw new Error('找不到打包产物（先跑 pnpm --filter @pm-studio/desktop pack:dir）');
    return { exe, appDir: path.dirname(exe), packaged: true };
  }
  return { exe: resolveDevElectron(), appDir: DESKTOP_DIR, packaged: false };
}

function launchApp({ target, userDataDir, port }) {
  const args = [
    `--user-data-dir=${userDataDir}`,
    `--remote-debugging-port=${port}`,
    // 关掉一切会让渲染降频的开关，否则断言会读到陈旧状态
    '--disable-backgrounding-occluded-windows',
    '--disable-renderer-backgrounding',
    '--disable-background-timer-throttling',
    '--disable-gpu',
  ];
  // 未打包运行时要把"应用目录"作为参数传给 electron.exe；打包的 exe 自带应用
  if (!target.packaged) args.push('.');

  // stdio: 'ignore' —— 不通过管道捕获输出（本机沙箱下管道捕获有额外限制，且我们从日志文件读）
  return spawn(target.exe, args, { cwd: target.appDir, stdio: 'ignore' });
}

/**
 * 连上调试端口并等应用真正可用。
 *
 * 判据是"外壳挂上了"（`.n-layout`）—— 数据库迁移、内嵌服务启动都在这之前完成，
 * 所以看到外壳基本就代表可以开始操作了。
 */
async function connectToApp({ port, userDataDir }) {
  const page = await findPageTarget(port);
  const cdp = await Cdp.connect(page.webSocketDebuggerUrl);
  await Promise.all([
    cdp.send('Runtime.enable').catch(() => undefined),
    cdp.send('Network.enable').catch(() => undefined),
    cdp.send('Log.enable').catch(() => undefined),
    cdp.send('Page.enable').catch(() => undefined),
  ]);

  const deadline = Date.now() + 45000;
  while (Date.now() < deadline) {
    const ready = await cdp
      .evaluate('Boolean(window.pmStudio) && Boolean(document.querySelector(".n-layout"))')
      .catch(() => false);
    if (ready) return cdp;
    await sleep(250);
  }
  throw new Error(`应用没有在预期时间内就绪（userData=${userDataDir}）`);
}

function stopApp(child) {
  if (!child || child.killed) return;
  try {
    child.kill();
  } catch {
    // 忽略
  }
}

/** 读应用自己的文件日志尾部：断言失败时最有用的一份现场 */
function readLogTail(userDataDir, lines = 40) {
  const file = path.join(userDataDir, 'logs', 'main.log');
  if (!fs.existsSync(file)) return null;
  const content = fs.readFileSync(file, 'utf8').trimEnd().split('\n');
  return content.slice(-lines).join('\n');
}

module.exports = {
  DESKTOP_DIR,
  resolveTarget,
  resolveDevElectron,
  resolvePackagedExe,
  launchApp,
  connectToApp,
  stopApp,
  readLogTail,
};
