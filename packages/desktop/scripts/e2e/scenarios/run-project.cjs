/**
 * 场景：项目的启动 / 停止（M4）。
 *
 * 用户明确要求：**只有前端、后端、前后端项目有启动停止按钮**（纯管理项目没有）。
 *
 * 这一条**真的起一个进程再停掉** —— 不是 mock：
 * 项目文件夹里放一个最小 `package.json`（`dev` 脚本 = `node server.js`）+ 一个
 * 起 HTTP 监听的 `server.js`，这样不需要 `npm install` 也能跑（端到端不碰网络）。
 * 验的是四件事：
 *   1. 卡片上**有**启动按钮（前端项目）／**没有**（纯管理项目）；
 *   2. 点启动 → 状态变成「运行中」、卡片上写出端口、进程真的在监听；
 *   3. 点停止 → 状态回到可启动、**端口真的释放**（这条最重要：只杀外层会留下占着端口的孙进程）；
 *   4. 依赖没装好的项目：点启动会**如实报原因**，而不是显示成"已启动"。
 */

const path = require('node:path');

/*
 * 文件系统夹具与端口探测都在 harness 里（`recycle-bin` 场景也要一个"能真的起来"的项目，
 * 两处各写一份迟早会分叉 —— 那种分叉的表现是"一个场景过、另一个场景莫名失败"）。
 */
const { seedRunnableProject, seedBrokenProject, portInUse } = require('../harness/fixtures.cjs');

/** 真的发一个 HTTP 请求（用应用记录的地址），证明"点开能看到页面" */
function httpGetOk(url) {
  return new Promise((resolve) => {
    const req = require('node:http').get(url, (res) => {
      res.resume();
      resolve(res.statusCode === 200);
    });
    req.on('error', () => resolve(false));
    req.setTimeout(2500, () => {
      req.destroy();
      resolve(false);
    });
  });
}

async function waitPort(port, expected, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if ((await portInUse(port)) === expected) return true;
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  return false;
}

module.exports = {
  name: 'run-project',
  title: '项目的启动 / 停止：只有有代码的项目才有按钮，且真的能起能停',
  needsProject: true,

  async run({ page, assert, api, cdp, sandbox }) {
    const info = await cdp.json('(async () => JSON.stringify(await window.pmStudio.getBootstrap()))()', {
      awaitPromise: true,
    });
    const stamp = Date.now().toString().slice(-6);
    const runnableName = `e2e 可启动前端 ${stamp}`;
    const managedName = `e2e 纯管理 ${stamp}`;
    const brokenName = `e2e 缺依赖前端 ${stamp}`;
    const port = 5199;

    const runnable = await api.post('/api/v1/projects', {
      name: runnableName,
      codeKind: 'frontend',
    });
    const managed = await api.post('/api/v1/projects', { name: managedName });
    const broken = await api.post('/api/v1/projects', { name: brokenName, codeKind: 'frontend' });

    const workspaceRoot = info.workspaceRoot;
    seedRunnableProject(path.join(workspaceRoot, runnable.folder), port);
    seedBrokenProject(path.join(workspaceRoot, broken.folder), 5198);

    try {
      /* ---------- 1) 接口层：能不能启动，服务端说了算 ---------- */
      const runnableOverview = await api.get(`/api/v1/projects/${runnable.id}/run`);
      assert.check(runnableOverview.runnable, '前端项目：服务端认为它可以启动');
      assert.equal(runnableOverview.targets[0]?.kindLabel, 'Vite', '认出来是 Vite 前端');

      const managedOverview = await api.get(`/api/v1/projects/${managed.id}/run`);
      assert.check(!managedOverview.runnable, '纯管理项目：服务端认为它不能启动');
      assert.check(
        managedOverview.problems.join().includes('纯管理项目'),
        '并且说清了原因（纯管理项目不生成代码）',
        managedOverview.problems,
      );

      /* ---------- 2) 界面：按钮的"有"与"没有" ---------- */
      await page.reload();
      await page.waitFor('Boolean(document.querySelector(".n-layout"))', {
        label: '重载后应用外壳挂上',
        timeoutMs: 30000,
      });
      await page.goto('#/projects', 'projects');
      await page.waitFor(`Boolean(document.querySelector('[data-run-start="${runnable.id}"]'))`, {
        label: '有代码的项目卡片上出现「启动」按钮',
        timeoutMs: 20000,
      });
      assert.check(
        (await page.count(`[data-run-start="${managed.id}"]`)) === 0,
        '纯管理项目的卡片上**没有**启动按钮（用户明确要求）',
      );
      /*
       * 那个"等作业系统（M4）接入后可用"的**禁用占位**必须彻底消失。
       * 它以前在每张卡片上都有一份（连纯管理项目也有），现在那个位置就是真的启动按钮。
       */
      assert.check(
        !(await page.text('body')).includes('等作业系统'),
        '页面上不再有"启动 / 停止：等作业系统（M4）接入后可用"这种占位提示',
      );
      assert.check(
        !(await page.exists(`[data-running="${managed.id}"]`)),
        '纯管理项目也不会出现「运行中」标记',
      );

      // 留一张图：按钮现在长在"操作按钮那一排"里（原来这个位置是个禁用占位）
      await page.screenshot(path.join(sandbox.artifactsDir, 'run-buttons.png')).catch(() => undefined);

      /* ---------- 3) 启动：真的起进程、真的在监听 ---------- */
      assert.check(!(await portInUse(port)), `启动前 ${port} 端口是空的（避免"其实上次还开着"）`);

      await page.click(`[data-run-start="${runnable.id}"]`);
      await page.waitFor(`Boolean(document.querySelector('[data-running="${runnable.id}"]'))`, {
        label: '卡片上出现「运行中」',
        timeoutMs: 20000,
      });
      const runningTag = await page.text(`[data-running="${runnable.id}"]`);
      assert.check(
        runningTag.includes(`:${port}`),
        '「运行中」标记上写明了端口（用户不用去猜）',
        runningTag,
      );
      assert.check(
        await waitPort(port, true),
        `进程真的在监听 ${port}（不是只改了个状态）`,
      );
      /*
       * "能让项目程序运行"的可见证据：运行中出现「在浏览器里打开 http://127.0.0.1:<port>」。
       * 这条不是装饰 —— 它就是给用户的"真的跑起来了"的入口。
       */
      const openButton = `[data-run-open="${runnable.id}"]`;
      await page.waitFor(`Boolean(document.querySelector('${openButton}'))`, {
        label: '运行中出现「在浏览器里打开」入口',
        timeoutMs: 20000,
      });

      /*
       * **这一条是"没有正常启动"的回归测试**。
       *
       * 用户看到的：点了启动、界面显示运行中，但浏览器打不开（地址是我们自己拼的
       * `http://127.0.0.1:<port>`，而 Vite 绑的是 `localhost` = `::1`，IPv4 上什么都没有）。
       * 所以这里做两件事：
       *   1. 应用记录的地址必须**真的能返回 200**（用 HTTP 请求验，不是只测 TCP）；
       *   2. 那个地址不能是"我们自己拼的 127.0.0.1"，而应该是从进程输出里学到的。
       */
      const runState = await api.get(`/api/v1/projects/${runnable.id}/run`);
      const frontState = runState.targets[0]?.state;
      assert.check(frontState?.reachable === true, '服务端确认地址已经连通', frontState);
      assert.check(
        typeof frontState?.url === 'string' && frontState.url.startsWith('http://'),
        '服务端记下了可打开的地址',
        frontState?.url,
      );
      assert.check(
        await httpGetOk(frontState.url),
        `应用给出的地址真的能打开（${frontState.url}）`,
      );
      assert.check(
        frontState.url.includes('localhost') || frontState.url.includes('[::1]'),
        '地址用的是开发服务器自己打印的那个（Vite 是 localhost / ::1），不是我们拼的 127.0.0.1',
        frontState.url,
      );

      const state = await api.get(`/api/v1/projects/${runnable.id}/run`);
      assert.check(
        state.runningProjectIds.includes(runnable.id),
        '服务端把项目列进了"正在运行"',
        state.runningProjectIds,
      );
      /*
       * 输出要能看到 —— 而且**那行输出里就写着地址**（真实 Vite 会打印 `Local: http://…`）。
       * 这条曾经验的是 "listening on"（第一版种子脚本自己打印的），改成 Vite 的写法之后
       * 断言也得跟着改：它现在同时验"输出被收下来了"与"地址是从输出里学来的"。
       */
      const runLogLines = (state.targets[0]?.state?.log ?? []).map((line) => line.text);
      assert.check(
        runLogLines.some((text) => text.includes('Local:')),
        '启动输出被收进了日志（到底跑起来没有，看得到）',
        runLogLines,
      );

      /* ---------- 3.5) 运行面板：点「运行中」标记能打开，并且看得到输出与地址 ---------- */
      /*
       * 用户这次遇到的问题是"启动之后什么都看不到" —— 所以面板本身就是这次修复的一部分：
       * 里面要有**真实地址**、**是否连通**、**启动输出**，以及就地停止。
       *
       * 用**明确的按钮**打开面板：
       * 第一版把点击挂在「运行中」那个 NTag 上 —— 实测 Naive 的 NTag 不触发我们的 @click，
       * 而点击冒泡到卡片上直接跳到了工作台（用户以为在看输出，实际换了页面）。
       * 所以状态标记只做显示，入口是操作区里一个真按钮（`data-run-panel`）。
       */
      await page.click(`[data-run-panel="${runnable.id}"]`);
      await page.waitFor(
        `Boolean(document.querySelector('[data-run-target="${runnable.id}:frontend"]'))`,
        { label: '运行面板打开了', timeoutMs: 10000 },
      );
      assert.check(
        await page.json(`(() => JSON.stringify(location.hash))()`) === '#/projects',
        '打开面板**不会**把页面带走（点状态标记那次就跳到工作台了）',
      );
      const panelText = await page.text(`[data-run-target="${runnable.id}:frontend"]`);
      assert.check(
        panelText.includes('前端'),
        '面板里按"前端 / 后端"分别列出目标',
        panelText.slice(0, 80),
      );
      assert.check(
        panelText.includes(`localhost:${port}`) ||
          panelText.includes(`127.0.0.1:${port}`) ||
          panelText.includes(`[::1]:${port}`),
        '面板里写出了可以打开的地址',
        panelText.slice(0, 200),
      );
      assert.check(
        panelText.includes('地址已连通'),
        '面板里如实标注"地址已连通"',
        panelText.slice(0, 200),
      );
      const panelLog = await page.text(`[data-run-log="frontend"]`);
      assert.check(
        panelLog.includes('Local:'),
        '面板里能看到启动输出（不用去猜程序有没有跑起来）',
        panelLog.slice(0, 200),
      );

      /*
       * 面板宽度：用户 2026-10-01 反馈「这里太宽了，调窄一点」（原来由 Naive 的默认值决定，约 700px）。
       * 现在钉在 600px 上下 —— 判据同时给上下界：太宽会重新变成"一屏摊开"，
       * 太窄则地址与按钮会挤成两行。
       *
       * **量之前必须等动画落定**：弹窗是"放大 + 淡入"进场的，过渡期间量到的是被 scale 过的
       * 包围盒（实测 600px 的卡片量出 332px，看着像"宽度没生效"，其实规则早就生效了）。
       */
      await page.animationsSettled({ timeoutMs: 4000 }).catch(() => undefined);
      const panelBox = await page.json(
        `(() => { const card = document.querySelector('.run-panel .n-card') ?? document.querySelector('.run-panel');
          const r = card.getBoundingClientRect();
          const pre = document.querySelector('.run-log');
          return JSON.stringify({
            width: Math.round(r.width),
            cssWidth: getComputedStyle(card).width,
            viewport: window.innerWidth,
            logOverflowsX: pre ? pre.scrollWidth > pre.clientWidth + 2 : null,
          }); })()`,
      );
      assert.check(
        panelBox.width <= 620 && panelBox.width >= 480,
        '运行面板宽度在 480~620px 之间（调窄过，但也没窄到挤成两行）',
        panelBox,
      );
      assert.check(
        panelBox.logOverflowsX === false,
        '长路径的输出是折行而不是横向溢出（所以调窄是安全的）',
        panelBox,
      );
      // 关掉面板（点「关闭」）
      await page.evaluate(
        `(() => { const buttons = [...document.querySelectorAll('button')];
          const close = buttons.find((el) => (el.textContent || '').trim() === '关闭');
          if (close) close.click();
          return 1; })()`,
      );

      /* ---------- 4) 再点一次启动要被挡住（否则第二份会因端口占用失败） ---------- */
      let doubleStart = '';
      try {
        await api.post(`/api/v1/projects/${runnable.id}/run/start`, {});
      } catch (error) {
        doubleStart = String(error);
      }
      assert.check(doubleStart.includes('已经在运行'), '重复启动被挡住并说明原因', doubleStart);
      /*
       * 而且要是**可读的拒绝**，不是"服务器内部错误"。
       * 连点两次启动是正常操作，用 500 等于把用户的操作问题说成我们的故障。
       */
      assert.check(
        !doubleStart.includes('服务器内部错误') && doubleStart.includes('409'),
        '拒绝的原因是"已经在运行"（409），不是 500',
        doubleStart,
      );

      /* ---------- 5) 停止：端口必须真的释放 ---------- */
      await page.click(`[data-run-stop="${runnable.id}"]`);
      await page.waitFor(`Boolean(document.querySelector('[data-run-start="${runnable.id}"]'))`, {
        label: '停止后按钮变回「启动」',
        timeoutMs: 20000,
      });
      assert.check(
        await waitPort(port, false),
        `停止之后 ${port} 真的释放了（只杀外层会留下占着端口的孙进程）`,
      );
      assert.check(
        (await page.count(`[data-run-open="${runnable.id}"]`)) === 0,
        '停止之后「在浏览器里打开」入口也收起来了（不给一个打不开的入口）',
      );
      const afterStop = await api.get(`/api/v1/projects/${runnable.id}/run`);
      assert.check(
        afterStop.runningProjectIds.length === 0,
        '服务端也不再认为它在运行',
        afterStop.runningProjectIds,
      );

      /* ---------- 6) 依赖没装好：如实报原因，不许显示成"已启动" ---------- */
      await page.click(`[data-run-start="${broken.id}"]`);
      await page.waitFor(
        `!document.querySelector('[data-running="${broken.id}"]')`,
        { label: '缺依赖的项目没有变成「运行中」', timeoutMs: 8000 },
      );
      assert.check(
        !(await page.exists(`[data-running="${broken.id}"]`)),
        '缺依赖的项目点启动之后**没有**出现「运行中」（不谎报）',
      );
      const brokenOverview = await api.get(`/api/v1/projects/${broken.id}/run`);
      assert.check(
        brokenOverview.targets[0]?.problem?.includes('还没装依赖'),
        '服务端给出的原因是「还没装依赖」',
        brokenOverview.targets[0]?.problem,
      );
      assert.check(
        brokenOverview.targets[0]?.templateId === 'vue3',
        '服务端认出了模板 id（装依赖按它决定装什么、装到哪）',
        brokenOverview.targets[0]?.templateId,
      );

      /* ---------- 7) 「装依赖」入口：把那条死胡同打通 ---------- */
      /*
       * 原来启动被挡下说"先跑一次安装依赖"，而界面上**没有任何地方能装** —— 提示指不到操作上。
       * 这一条验的是：缺依赖时卡片上出现「装依赖」，点了真的跑安装作业，进度与输出就在面板里，
       * 装完之后启动按钮变成可用。
       *
       * 这个种子项目的 `package.json` **没有任何依赖**，所以 `pnpm install` 不需要联网
       * （它只会建出 node_modules 与 lockfile）—— 端到端仍然不依赖网络。
       */
      assert.check(
        await page.exists(`[data-run-install="${broken.id}"]`),
        '缺依赖的项目卡片上出现「装依赖」入口',
      );
      assert.check(
        (await page.count(`[data-run-install="${runnable.id}"]`)) === 0,
        '依赖齐了的项目**没有**这一格（不摆常驻按钮）',
      );

      /*
       * 永久守卫：**界面上不许出现 `is not defined` 这类 JS 报错**。
       *
       * 为什么会在这里加：`.vue` 文件不在 `tsc` 的检查范围里（普通 tsc 不解析 .vue），
       * 所以"在 .vue 里引用了一个没引入的标识符"这种错编译期是查不出来的。
       * 实测就踩到了：`jobsApi is not defined` 被 catch 成一条提示，
       * 表现是"点了装依赖什么都不发生"。这条断言专门盯这类"被吞掉的 ReferenceError"。
       */
      await page.click(`[data-run-install="${broken.id}"]`);
      await new Promise((resolve) => setTimeout(resolve, 800));
      const texts = await page.json(
        `(() => JSON.stringify([...document.querySelectorAll('.n-message__content, .n-notification__content')]
          .map((el) => el.textContent.trim())))()`,
      );
      assert.check(
        !texts.some((text) => /is not defined|ReferenceError|Cannot read propert/.test(text)),
        '点击之后没有出现 JS 报错（.vue 不在 tsc 检查范围，这条是兜底）',
        texts,
      );

      await page.waitFor(
        `Boolean(document.querySelector('[data-run-install-for="${broken.id}"]'))`,
        { label: '运行面板里出现安装进度', timeoutMs: 20000 },
      );
      assert.check(true, '点「装依赖」打开运行面板并显示安装进度');

      await page.waitFor(
        `(() => { const el = document.querySelector('[data-run-install-log="all"]');
          return Boolean(el) && (el.textContent || '').length > 5; })()`,
        { label: '安装输出出现在面板里', timeoutMs: 60000 },
      );
      assert.check(true, '安装的输出就在面板里（不用另开窗口找）');

      // 等安装作业结束（成功或失败都要能看到结论）
      let installDone = false;
      for (let attempt = 0; attempt < 60; attempt += 1) {
        const overview = await api.get(`/api/v1/projects/${broken.id}/run`);
        if (overview.targets[0]?.ready === true) {
          installDone = true;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
      assert.check(installDone, '装完之后服务端认为这个目标可以启动了（ready）');
      // 界面是 1.2 秒一轮刷新的，所以这里**等它收起来**而不是立刻断言（否则是测试自己在抖）
      await page.waitFor(`!document.querySelector('[data-run-install="${broken.id}"]')`, {
        label: '装好之后卡片上的「装依赖」入口收起来',
        timeoutMs: 15000,
      });
      assert.check(true, '装好之后卡片上的「装依赖」入口自己收起来（不留在那儿当摆设）');
    } finally {
      // 收尾：把三个项目都删掉（不留污染给后面的场景）
      for (const project of [runnable, managed, broken]) {
        await api.del(`/api/v1/projects/${project.id}`).catch(() => undefined);
      }
    }
  },
};
