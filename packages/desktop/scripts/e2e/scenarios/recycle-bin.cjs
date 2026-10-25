/**
 * 场景：回收站 + 「运行中不许删」（0.2.1）。
 *
 * 用户的两条要求：
 *   1. 「在项目运行时执行删除操作时弹出提示，项目正在运行，请停止后再删除」；
 *   2. 「新增回收站，且回收站中删除则完全删除项目」。
 *
 * 要把三件事钉死：
 *   - 运行中的项目：**界面上先弹提示**（不是点了才报错），并且**接口也拒绝**（那条才是权威判断）；
 *   - 移入回收站之后：项目列表里没有它、回收站里能看到、**数据库里那条记录还在**（可还原）；
 *   - 回收站里彻底删除：**数据库里真没了**（不是又一次软删除），而**磁盘上的文件夹保留**
 *     —— 这条边界是刻意定的（删用户代码不可逆），所以要有断言盯着，免得哪天被"顺手"改掉。
 */

const fs = require('node:fs');
const path = require('node:path');

const { seedRunnableProject } = require('../harness/fixtures.cjs');

module.exports = {
  name: 'recycle-bin',
  title: '回收站与「运行中不许删」',
  needsProject: true,

  async run({ page, assert, api, cdp, data, sandbox }) {
    void sandbox;

    /* ---------------- 1) 回收站入口 ---------------- */
    await page.goto('#/projects', 'projects');
    assert.check(await page.exists('[data-field="trash-open"]'), '项目页有「回收站」入口');
    await page.click('[data-field="trash-open"]');
    await page.waitFor("Boolean(document.querySelector('[data-field=\"trash-panel\"]'))", {
      label: '回收站面板打开',
    });
    /*
     * 判据一律**按本场景的项目 id**，不用"回收站里有几项"：
     * 沙箱是所有场景共用的，前面的场景（create-project / run-project 等）收尾时删掉的项目
     * 就躺在回收站里 —— 拿全局数量当判据会变成一条只在"单独跑"时才过的假断言。
     */
    assert.check(
      !(await page.exists(`[data-field="trash-item"][data-project-id="${data.project.id}"]`)),
      '这个项目还没被删，所以不在回收站里',
    );
    await page.click('[data-field="trash-close"]');
    await page.waitFor("!document.querySelector('[data-field=\"trash-panel\"]')", {
      label: '回收站面板关闭',
    });

    /* ---------------- 2) 移入回收站 ---------------- */
    await page.click(`[data-project-card="${data.project.id}"] [data-field="project-remove"]`);
    await page.waitFor("Boolean(document.querySelector('.n-dialog'))", { label: '出现删除确认框' });
    const deleteText = (await page.text('.n-dialog')) ?? '';
    assert.check(
      deleteText.includes('回收站') && deleteText.includes('保留'),
      '确认框写明"移入回收站"并且文件夹会保留',
      deleteText.replace(/\s+/g, ' ').slice(0, 100),
    );
    await page.animationsSettled({ timeoutMs: 4000 }).catch(() => undefined);
    await page.click('.n-dialog__action button:last-child');
    await page.waitFor(
      `![...document.querySelectorAll('[data-project-card]')].some((el) => el.getAttribute('data-project-card') === ${JSON.stringify(data.project.id)})`,
      { label: '项目从列表里消失' },
    );
    assert.check(true, '删除后项目不再出现在项目列表里');

    // 数据库里那条记录还在（软删除 = 可还原），并且带上了删除时间
    const hidden = await api.get('/api/v1/projects?includeDeleted=true&includeArchived=true');
    const hiddenItem = (hidden.items ?? hidden).find((item) => item.id === data.project.id);
    assert.check(Boolean(hiddenItem), '回收站里能找到这条项目记录');
    assert.check(
      typeof hiddenItem?.deletedAt === 'number',
      '记录上带着"删除时间"（而不是被真删了）',
      hiddenItem?.deletedAt,
    );

    /* ---------------- 3) 回收站面板：列出 + 还原 ---------------- */
    const itemSelector = `[data-field="trash-item"][data-project-id="${data.project.id}"]`;
    await page.click('[data-field="trash-open"]');
    await page.waitFor(`Boolean(document.querySelector('${itemSelector}'))`, {
      label: '回收站里出现被删的那个项目',
    });
    const trashName = await page.text(`${itemSelector} [data-field="trash-name"]`);
    assert.check(
      (trashName || '').includes(data.project.name),
      '回收站里显示的是被删的那个项目',
      trashName,
    );
    assert.check(
      await page.exists(`${itemSelector} [data-field="trash-restore"]`),
      '每一项都有「还原」按钮',
    );
    assert.check(
      await page.exists(`${itemSelector} [data-field="trash-purge"]`),
      '每一项都有「彻底删除」按钮',
    );

    await page.click(`${itemSelector} [data-field="trash-restore"]`);
    await page.waitFor(`!document.querySelector('${itemSelector}')`, {
      label: '还原之后它从回收站里消失',
    });
    const restored = await api.get(`/api/v1/projects/${encodeURIComponent(data.project.id)}`);
    assert.equal(restored.deletedAt, null, '还原之后数据库里的删除标记被清掉');
    await page.click('[data-field="trash-close"]');
    await page.waitFor(
      `[...document.querySelectorAll('[data-project-card]')].some((el) => el.getAttribute('data-project-card') === ${JSON.stringify(data.project.id)})`,
      { label: '还原之后项目回到列表' },
    );
    assert.check(true, '还原之后项目回到项目列表里');

    /* ---------------- 4) 运行中不许删（界面提示 + 接口拒绝） ---------------- */
    /*
     * 自己造一个**真的能起来**的项目（夹具里有 package.json / vite.config / server.js / node_modules），
     * 启动它再试删除：界面必须先弹提示，接口也必须拒绝。
     */
    const info = await cdp.json('(async () => JSON.stringify(await window.pmStudio.getBootstrap()))()', {
      awaitPromise: true,
    });
    const stamp = Date.now().toString().slice(-6);
    const running = await api.post('/api/v1/projects', {
      name: `e2e 运行中删除 ${stamp}`,
      codeKind: 'frontend',
    });
    const port = 5197;
    seedRunnableProject(path.join(info.workspaceRoot, running.folder), port);

    try {
      const started = await api.post(`/api/v1/projects/${encodeURIComponent(running.id)}/run/start`, {});
      assert.check(
        Array.isArray(started?.states) && started.states.length > 0,
        '种子项目启动成功（拿到目标列表）',
        started,
      );
      assert.equal(started.states[0]?.status, 'running', '启动后状态是 running');

      await page.reload();
      await page.goto('#/projects', 'projects');
      // 等界面自己把"运行中"读回来（轮询 2 秒一轮）
      await page.waitFor(
        `Boolean(document.querySelector('[data-project-card="${running.id}"].is-running'))`,
        { label: '卡片上出现"运行中"状态', timeoutMs: 25000 },
      );

      await page.click(`[data-project-card="${running.id}"] [data-field="project-remove"]`);
      await page.waitFor("Boolean(document.querySelector('.n-dialog'))", { label: '出现提示框' });
      const runningText = (await page.text('.n-dialog')) ?? '';
      assert.check(
        runningText.includes('正在运行') && runningText.includes('停止'),
        '运行中删除时：提示"正在运行，请先停止再删除"',
        runningText.replace(/\s+/g, ' ').slice(0, 120),
      );
      const runningButtons = await page.json(
        `(() => JSON.stringify([...document.querySelectorAll('.n-dialog__action button')].map((el) => (el.textContent || '').trim())))()`,
      );
      assert.check(
        runningButtons.length === 1,
        '提示框只有一个按钮（不给"再点一次就能删"的错觉）',
        runningButtons,
      );
      await page.animationsSettled({ timeoutMs: 3000 }).catch(() => undefined);
      await page.click('.n-dialog__action button:last-child');
      await page.waitFor("!document.querySelector('.n-dialog')", { label: '关掉提示框' });

      const stillThere = await api.get(`/api/v1/projects/${encodeURIComponent(running.id)}`);
      assert.equal(stillThere.deletedAt, null, '项目没有被删掉（界面在点下去之前就拦住了）');

      // 接口层也要拒绝：绕过界面直接调同样不行
      let rejected = null;
      try {
        await api.del(`/api/v1/projects/${encodeURIComponent(running.id)}`);
      } catch (error) {
        rejected = error.message;
      }
      assert.check(
        Boolean(rejected) && rejected.includes('409'),
        '直接调接口删也被拒（409），不是只有界面在挡',
        rejected,
      );
      assert.check(
        Boolean(rejected) && rejected.includes('正在运行'),
        '接口给的原因是"正在运行，请先停止"',
        rejected,
      );

      /* ---------------- 5) 彻底删除：数据真没了，文件夹保留 ---------------- */
      // 先停掉它（也顺带验证"停了之后可以删"）
      await api.post(`/api/v1/projects/${encodeURIComponent(running.id)}/run/stop`, {});

      const folderPath = path.join(info.workspaceRoot, running.folder);
      assert.check(fs.existsSync(folderPath), '删除前项目文件夹确实在磁盘上', folderPath);

      await api.del(`/api/v1/projects/${encodeURIComponent(running.id)}`);
      await page.reload();
      await page.goto('#/projects', 'projects');
      await page.click('[data-field="trash-open"]');
      const runningItem = `[data-field="trash-item"][data-project-id="${running.id}"]`;
      await page.waitFor(`Boolean(document.querySelector('${runningItem}'))`, {
        label: '项目进了回收站',
      });

      await page.click(`${runningItem} [data-field="trash-purge"]`);
      await page.waitFor("Boolean(document.querySelector('.n-dialog'))", { label: '出现彻底删除确认框' });
      const purgeText = (await page.text('.n-dialog')) ?? '';
      assert.check(
        purgeText.includes('不可撤销') && purgeText.includes('保留'),
        '确认框说清两件事：应用里的数据不可恢复、磁盘上的文件夹保留',
        purgeText.replace(/\s+/g, ' ').slice(0, 140),
      );
      await page.animationsSettled({ timeoutMs: 3000 }).catch(() => undefined);
      await page.click('.n-dialog__action button:last-child');
      await page.waitFor(`!document.querySelector('${runningItem}')`, {
        label: '彻底删除后它从回收站里消失',
      });

      const gone = await api.get('/api/v1/projects?includeDeleted=true&includeArchived=true');
      assert.check(
        !(gone.items ?? gone).some((item) => item.id === running.id),
        '数据库里彻底没有了（连软删除的记录也没有）',
      );
      assert.check(
        fs.existsSync(folderPath),
        '磁盘上的项目文件夹**保留**（删用户代码不可逆，这条边界不能被顺手改掉）',
        folderPath,
      );

      /* ---------------- 6) 一键清空回收站 ---------------- */
      /*
       * 用户 2026-10-01：「回收站新增一键删除」。
       *
       * 这条的重点是**"不能多删"**：造两个项目丢进回收站，再点一次「清空回收站」，
       * 断言回收站清空、那两条真没了，而**场景里那个活着的项目一根汗毛都没少**。
       */
      const trashA = await api.post('/api/v1/projects', { name: `e2e 清空 A ${stamp}` });
      const trashB = await api.post('/api/v1/projects', { name: `e2e 清空 B ${stamp}` });
      await api.del(`/api/v1/projects/${encodeURIComponent(trashA.id)}`);
      await api.del(`/api/v1/projects/${encodeURIComponent(trashB.id)}`);

      await page.reload();
      await page.goto('#/projects', 'projects');
      await page.click('[data-field="trash-open"]');
      await page.waitFor(
        `Boolean(document.querySelector('[data-field="trash-item"][data-project-id="${trashA.id}"]'))
          && Boolean(document.querySelector('[data-field="trash-item"][data-project-id="${trashB.id}"]'))`,
        { label: '两条都进了回收站' },
      );
      assert.check(
        await page.exists('[data-field="trash-purge-all"]'),
        '回收站里有「清空回收站」（一键删除）入口',
      );

      await page.click('[data-field="trash-purge-all"]');
      await page.waitFor("Boolean(document.querySelector('.n-dialog'))", { label: '出现清空确认框' });
      const purgeAllText = (await page.text('.n-dialog')) ?? '';
      assert.check(
        purgeAllText.includes('不可撤销') && purgeAllText.includes('保留'),
        '一键清空的确认框同样说清"不可撤销 + 文件夹保留"',
        purgeAllText.replace(/\s+/g, ' ').slice(0, 140),
      );
      assert.check(
        purgeAllText.includes('2'),
        '确认框里写明了要删几个项目',
        purgeAllText.replace(/\s+/g, ' ').slice(0, 80),
      );
      await page.animationsSettled({ timeoutMs: 3000 }).catch(() => undefined);
      await page.click('.n-dialog__action button:last-child');
      await page.waitFor(
        `!document.querySelector('[data-field="trash-item"][data-project-id="${trashA.id}"]')
          && !document.querySelector('[data-field="trash-item"][data-project-id="${trashB.id}"]')`,
        { label: '两条都从回收站里消失' },
      );

      const afterPurge = await api.get('/api/v1/projects?includeDeleted=true&includeArchived=true');
      const remaining = (afterPurge.items ?? afterPurge).map((item) => item.id);
      assert.check(
        !remaining.includes(trashA.id) && !remaining.includes(trashB.id),
        '一键清空的两个项目在数据库里都真没了',
        remaining,
      );
      /*
       * **最重要的一条**：还活着的项目必须一根汗毛都没少。
       * 一个叫"清空回收站"的按钮碰到活着的项目就是事故。
       */
      const alive = await api.get(`/api/v1/projects/${encodeURIComponent(data.project.id)}`);
      assert.equal(alive.deletedAt, null, '场景里那个活着的项目没有被一键清空误删');
      assert.check(
        remaining.includes(data.project.id),
        '它仍然在项目列表里',
        remaining,
      );
    } finally {
      // 收尾：无论成败都别把跑着的开发服务器留给后面的场景
      await api.post(`/api/v1/projects/${encodeURIComponent(running.id)}/run/stop`, {}).catch(() => undefined);
      await api.del(`/api/v1/projects/${encodeURIComponent(running.id)}?hard=true`).catch(() => undefined);
    }
  },
};
