/**
 * E2E 入口。
 *
 *   pnpm --filter @pm-studio/desktop e2e                 # 开发运行时，跑全部场景
 *   pnpm --filter @pm-studio/desktop e2e outline         # 只跑某个场景
 *   pnpm --filter @pm-studio/desktop e2e --packaged      # 打好的 exe（发布前必跑）
 *   ... e2e --shots --keep                               # 每步留截图、保留现场目录
 *   ... e2e --network                                   # 连需要联网的场景（真的调 npm create）一起跑
 *
 * 设计取舍（相对上一代 1400 行的单体脚本）：
 *
 * 1. **一次启动跑完所有场景**：启动一次要几秒（打包版更久），每个场景各起一次纯属浪费。
 *    场景之间靠"各自造一个带随机后缀的项目"互相隔离，跑完就删。
 * 2. **场景是独立文件**：加一个页面就加一个文件，不用读懂整篇脚本。
 *    M2 的日历/我的待办/全局搜索已经以 `pending` 形式占位。
 * 3. **失败必留现场**：断言失败自动收集页面异常、失败请求、资源时序、主进程日志尾部与截图
 *    （见 harness/diagnose.cjs）。
 * 4. **退出码只有 0/1**：跳过（pending）不算失败，但有失败就非 0，能直接进 CI。
 * 5. **跑的时候别再压机器**：端到端是在**真窗口**上操作的，判定靠"元素出现 / 坐标稳定"，
 *    机器一忙就超时。实测教训：跟 34 个 worker 的单测**并行**跑，`logs`、`today`、
 *    `overview` 三个场景一起红（下拉展不开、路由挂载超时），单独重跑全绿 ——
 *    那不是产品的问题，是"我一边测一边把机器占满了"。要并行就并行不占 CPU 的活。
 *
 * 数据安全：永远显式 `--user-data-dir` 指向 `.tmp` 下的隔离目录，
 * 并且 harness/sandbox.cjs 会拒绝对 `%APPDATA%` 下的正式数据运行。
 */

const fs = require('node:fs');
const path = require('node:path');

const { createSandbox } = require('./harness/sandbox.cjs');
const { createRecorder } = require('./harness/assert.cjs');
const { createPage } = require('./harness/page.cjs');
const { createApi } = require('./harness/api.cjs');
const { collectDiagnostics } = require('./harness/diagnose.cjs');
const {
  launchApp, connectToApp, stopApp, resolveTarget, readLogTail,
} = require('./harness/app.cjs');
const { sleep } = require('./harness/cdp.cjs');

/* ------------------------------------------------------------------ */
/* 命令行                                                              */
/* ------------------------------------------------------------------ */

function parseArgs(argv) {
  const options = { only: [], shots: false, keep: false, packaged: false, network: false, exe: null, out: null, port: 9420 };
  for (const arg of argv) {
    if (arg === '--shots') options.shots = true;
    else if (arg === '--keep') options.keep = true;
    else if (arg === '--packaged') options.packaged = true;
    else if (arg === '--network') options.network = true;
    else if (arg.startsWith('--exe=')) options.exe = arg.slice('--exe='.length);
    else if (arg.startsWith('--out=')) options.out = arg.slice('--out='.length);
    else if (arg.startsWith('--port=')) options.port = Number(arg.slice('--port='.length));
    else if (arg.startsWith('--')) throw new Error(`未知参数：${arg}`);
    else options.only.push(arg);
  }
  return options;
}

/**
 * 源码比构建产物新时给出警告。
 *
 * 开发运行时加载的是 `out/`（electron-vite 的构建产物），所以"改了 src 没重新构建"
 * 会让 e2e 跑在**上一版代码**上 —— 症状是"我明明改了，测试却说没改"，
 * 而且失败信息指向完全错误的方向（实测撞过一次：新注册的作业类型"没有注册"）。
 * 只警告、不自动构建：自动构建会把每次 e2e 都拖长，而且掩盖了"你忘了构建"这件事。
 */
function warnIfBuildStale(appDir) {
  const outDir = path.join(appDir, 'out');
  const srcDir = path.join(appDir, 'src');
  if (!fs.existsSync(outDir) || !fs.existsSync(srcDir)) return;

  const newest = (dir) => {
    let latest = 0;
    const walk = (current) => {
      for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
        const full = path.join(current, entry.name);
        if (entry.isDirectory()) walk(full);
        else latest = Math.max(latest, fs.statSync(full).mtimeMs);
      }
    };
    walk(dir);
    return latest;
  };

  const outTime = newest(outDir);
  const srcTime = newest(srcDir);
  if (srcTime > outTime + 1000) {
    process.stdout.write(
      '⚠ 源码比构建产物新：开发运行时加载的是 out/，请先 `pnpm --filter @pm-studio/desktop build`\n' +
        '  （否则测的是上一版代码，失败信息会指向错误的方向）\n\n',
    );
  }
}

function loadScenarios() {  const dir = path.join(__dirname, 'scenarios');
  return fs
    .readdirSync(dir)
    .filter((name) => name.endsWith('.cjs'))
    .sort()
    .map((name) => require(path.join(dir, name)));
}

/* ------------------------------------------------------------------ */
/* 主流程                                                              */
/* ------------------------------------------------------------------ */

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const runId = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);

  const target = options.exe
    ? { exe: path.resolve(options.exe), appDir: path.dirname(path.resolve(options.exe)), packaged: true }
    : resolveTarget(options.packaged ? 'packaged' : 'dev');

  const sandbox = createSandbox({ root: options.out, runId });
  const all = loadScenarios().filter(
    (scenario) => options.only.length === 0 || options.only.includes(scenario.name),
  );
  /*
   * 需要联网的场景**默认不跑**（`requiresNetwork: true`）。
   *
   * 原因是"测试不该绑在网络与包源上"（改这条的场景是 `network-official`：它真的调
   * `npm create vue/vite`）。明确点名时照跑 —— 显式点名意味着"我知道它要联网"。
   */
  const scenarios = all.filter(
    (scenario) => !scenario.requiresNetwork || options.network || options.only.includes(scenario.name),
  );
  const networkSkipped = all.filter((scenario) => !scenarios.includes(scenario));
  if (scenarios.length === 0) throw new Error(`没有匹配的场景：${options.only.join(', ') || '(空)'}`);

  process.stdout.write(`E2E 运行 ${runId}\n`);
  process.stdout.write(`  目标：${target.exe}${target.packaged ? '（打包产物）' : '（开发运行时）'}\n`);
  process.stdout.write(`  数据：${sandbox.userDataDir}\n`);
  process.stdout.write(`  现场：${sandbox.artifactsDir}\n\n`);
  if (networkSkipped.length > 0) {
    process.stdout.write(
      `  跳过需要联网的场景 ${networkSkipped.length} 个：${networkSkipped
        .map((scenario) => scenario.name)
        .join(', ')}（加 --network 才跑）\n\n`,
    );
  }

  // 开发运行时跑的是构建产物 `out/`：源码比它新就说明"测的是上一版代码"。
  // 这种假失败（改了代码却测到旧行为）非常费时间，所以直接喊出来。
  if (!target.packaged) warnIfBuildStale(target.appDir);

  const child = launchApp({ target, userDataDir: sandbox.userDataDir, port: options.port });
  const summary = [];

  try {
    const cdp = await connectToApp({ port: options.port, userDataDir: sandbox.userDataDir });
    const page = createPage(cdp);
    const api = createApi(cdp);

    for (const scenario of scenarios) {
      process.stdout.write(`▶ ${scenario.title}（${scenario.name}）\n`);

      if (scenario.pending) {
        process.stdout.write(`  ⏭ 跳过：${scenario.pending}\n\n`);
        summary.push({ name: scenario.name, status: 'pending', passed: 0, failed: 0 });
        continue;
      }

      const assert = createRecorder();
      cdp.clearEvents();

      let data = null;
      const projectName = `e2e-${scenario.name}-${runId.slice(-8)}`;
      try {
        if (scenario.needsProject !== false) {
          data = await api.seedProjectTree(projectName);
          // 让应用在这个项目上打开：写偏好再重载，比在界面上找下拉框点选确定得多
          await api.selectProject(data.project.id, projectName);
        }

        await scenario.run({
          cdp, page, api, assert, data, projectName, sandbox, shots: options.shots,
          // 给场景用的临时目录（例如"把工作区换到这个目录"）：放在本次运行的现场目录下，
          // 跑完随沙箱一起删，不会在磁盘上留垃圾
          newWorkspaceRoot: path.join(sandbox.runDir, 'workspace-moved'),
        });

        if (options.shots) {
          await page.screenshot(path.join(sandbox.artifactsDir, `${scenario.name}.png`));
        }
      } catch (error) {
        assert.check(false, '场景执行过程中没有抛异常', error.message);
      } finally {
        if (data?.project) await api.dropProject(data.project.id);
      }

      const failures = assert.failures;
      if (failures.length > 0) {
        await collectDiagnostics({
          cdp,
          page,
          artifactsDir: sandbox.artifactsDir,
          label: scenario.name,
          logTail: () => readLogTail(sandbox.userDataDir, 60),
        });
      }

      summary.push({
        name: scenario.name,
        status: failures.length === 0 ? 'pass' : 'fail',
        passed: assert.passed,
        failed: failures.length,
        failures,
      });
      process.stdout.write(`  ${failures.length === 0 ? '✔ 通过' : `✘ 失败 ${failures.length} 项`}\n\n`);

      // 让应用喘口气：连续造/删项目之间不抢 SQLite（WAL 下基本不会有事，但便宜）
      await sleep(300);
    }
  } finally {
    stopApp(child);
    if (!options.keep) {
      // 等进程真正退出再删目录，否则 Windows 上会因占用删不掉
      await sleep(1200);
      try {
        sandbox.cleanup();
      } catch {
        // 删不掉就留着，不影响结论
      }
    } else {
      process.stdout.write(`现场已保留：${sandbox.runDir}\n`);
    }
  }

  /* ---------------- 汇总 ---------------- */
  process.stdout.write('──────── 汇总 ────────\n');
  for (const item of summary) {
    const mark = item.status === 'pass' ? '✔' : item.status === 'pending' ? '⏭' : '✘';
    const detail =
      item.status === 'pass' ? `通过 ${item.passed} 项`
        : item.status === 'pending' ? '未实现（跳过）'
          : `失败 ${item.failed} 项 / 通过 ${item.passed} 项`;
    process.stdout.write(`  ${mark} ${item.name.padEnd(12)} ${detail}\n`);
    for (const failure of item.failures ?? []) {
      process.stdout.write(`      · ${failure.expected} · 实际：${JSON.stringify(failure.actual)}\n`);
    }
  }

  const failed = summary.filter((item) => item.status === 'fail').length;
  const pending = summary.filter((item) => item.status === 'pending').length;
  process.stdout.write(`\n结果：${summary.length - failed - pending} 通过 / ${failed} 失败 / ${pending} 跳过\n`);
  return failed === 0 ? 0 : 1;
}

main().then(
  (code) => process.exit(code),
  (error) => {
    console.error(`E2E 运行失败：${error.message}`);
    process.exit(1);
  },
);
