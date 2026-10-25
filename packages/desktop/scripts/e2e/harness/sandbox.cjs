/**
 * E2E 数据沙箱：**绝不允许对着正式数据跑**。
 *
 * 这是整套测试脚本里最不能省的一段。脚本会灌项目、建任务、删东西、改主题，
 * 一旦 userData 指到真实用户目录，就是在用户的正式数据上做实验 ——
 * 而正式数据是唯一一份，没有"重跑一次"这种退路。
 *
 * 所以闸门放在最前面，硬性两条：
 *   1. 路径里必须有一段 `.tmp`（所有测试目录都在仓库/工作区的 `.tmp/` 下）；
 *   2. 路径绝不能在 `%APPDATA%` 之下（正式数据就在那里，见 main/environment.ts）。
 *
 * 顺带一提：应用自己也会按环境切目录（打包=正式、未打包=测试）。但**测试脚本不依赖那个判断** ——
 * 它永远显式传 `--user-data-dir`（优先级最高），这样"测试跑在哪份数据上"是脚本自己说了算，
 * 不会因为将来有人改了环境规则而悄悄变味。
 */

const fs = require('node:fs');
const path = require('node:path');

function assertSandboxedDir(dir, label) {
  const resolved = path.resolve(dir);
  const appData = process.env.APPDATA ? path.resolve(process.env.APPDATA) : null;

  if (appData && `${resolved.toLowerCase()}${path.sep}`.startsWith(`${appData.toLowerCase()}${path.sep}`)) {
    throw new Error(
      `拒绝运行：${label} 指向 %APPDATA% 下的正式数据（${resolved}）。` +
        'E2E 必须用隔离目录，正式数据只有一份。',
    );
  }
  if (!/(^|[\\/])\.tmp([\\/]|$)/.test(resolved)) {
    throw new Error(`拒绝运行：${label} 必须在含 .tmp 的目录下，收到 ${resolved}`);
  }
  return resolved;
}

/**
 * 申请本次运行的沙箱。
 *
 * 每跑一次用一个**新的 runId 目录**，好处有两个：
 * - 上一次跑剩下的脏数据不会影响这一次（E2E 最怕"上次的残留导致这次通过/失败"）；
 * - 失败时那个目录可以整个留着当现场，不用挑文件。
 */
function createSandbox({ root, runId }) {
  // 默认放在 `packages/desktop/.tmp/e2e/<runId>`：与包同级、路径里带 `.tmp`（闸门要求），
  // 而且离被测代码近，`--keep` 之后找现场不用跳目录
  const base = path.resolve(root ?? path.join(__dirname, '..', '..', '..', '.tmp', 'e2e'));
  const runDir = path.join(base, runId);
  const userDataDir = assertSandboxedDir(path.join(runDir, 'userdata'), 'userDataDir');
  const artifactsDir = assertSandboxedDir(path.join(runDir, 'artifacts'), 'artifactsDir');

  fs.mkdirSync(userDataDir, { recursive: true });
  fs.mkdirSync(artifactsDir, { recursive: true });

  /*
   * 上一次被强杀会留下单实例锁：不清掉的话新进程会"唤回已有窗口"然后自己退出
   * （表现为脚本连得上 CDP、界面却是空的 —— 很像被测代码坏了，其实只是锁没清）。
   */
  for (const name of ['lockfile', 'SingletonLock']) {
    try {
      fs.rmSync(path.join(userDataDir, name), { force: true });
    } catch {
      // 清不掉也无所谓，后面连不上会报出来
    }
  }

  return {
    runDir,
    userDataDir,
    artifactsDir,
    /** 现场保留/清理都由 run.cjs 决定，这里只提供路径 */
    cleanup() {
      fs.rmSync(runDir, { recursive: true, force: true });
    },
  };
}

module.exports = { assertSandboxedDir, createSandbox };
