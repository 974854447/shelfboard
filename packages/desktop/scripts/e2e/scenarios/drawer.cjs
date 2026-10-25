/**
 * 场景：任务详情抽屉。
 *
 * 用户 2026-10-02 对底部按钮的三条要求（这一版的核心改动）：
 *   1. 「任务详情的按钮可以去掉」→ 那个「详情」入口按钮已整体删除（见 outline 场景）；
 *   2. 「在任务详情中去掉删除任务的按钮」→ 抽屉里不再提供删除，删除收在大纲节点的垃圾桶上；
 *   3. 「将重新加载按钮移动到原先删除任务按钮的位置，再在右侧新加一个提交审核的按钮」
 *      → 左「重新加载」、右「提交审核」。
 *
 * 另外这个场景从 0.2.0 起就一直守着两件事（**进度条已经被删掉了**，那部分断言随之移除）：
 *   A. **正在打字时界面不会来抢**：在描述里输入过程中不丢焦点
 *      （根因是"边输入边保存、保存时把自己禁用"导致焦点被重置）；
 *   B. **改其它字段不会把没保存的文本冲掉**（原来每次 patch 都整块重载详情）。
 *
 * 进度条那条旧断言的教训保留在这里：**只断言"新东西在"是不够的，必须同时断言
 * "旧东西没了"** —— 否则一次没删干净的改动照样能全绿。
 */

module.exports = {
  name: 'drawer',
  title: '任务详情：底部按钮 + 不抢焦点',
  needsProject: true,

  async run({ page, assert, api, data, sandbox }) {
    const path = require('node:path');

    /*
     * 从「今日待办」进详情，而不是在大纲节点上点卡片。
     *
     * 理由：大纲卡片点击开详情这条链路**已经由 outline 场景覆盖**，
     * 这个场景要测的是抽屉**里面**的东西（按钮、焦点、草稿），
     * 走一个不依赖坐标的普通入口更稳、也更快。
     *
     * 注意：今日待办只显示"今天该做的事"，播种的「主任务」到期日是 5 天后，
     * 正常情况下不会出现 —— 但它在**今天被创建**，所以会命中「今天动过」这一组。
     */
    await page.goto('#/my-tasks', 'today');
    await page.waitFor(
      `[...document.querySelectorAll('[data-field="today-row"]')].some((el) => (el.textContent || '').includes('主任务'))`,
      { label: '今日待办里出现播种的主任务（今天动过）' },
    );
    await page.evaluate(
      `(() => { const rows = [...document.querySelectorAll('[data-field="today-row"]')];
        const row = rows.find((el) => (el.textContent || '').includes('主任务'));
        if (row) row.setAttribute('data-e2e-pick', '1');
        return row ? 1 : 0; })()`,
    );
    await page.click('[data-e2e-pick="1"]');
    await page.waitFor("Boolean(document.querySelector('.n-drawer'))", { label: '详情抽屉打开' });
    /*
     * 等底部按钮就位再量：`.n-drawer` 出现不等于内部渲染完成（Naive 有进场动画），
     * 量早了会拿到 null —— 报出来是"按钮不存在"，方向就错了。
     */
    await page.waitFor(
      `Boolean(document.querySelector('[data-field="drawer-reload"]'))
        && Boolean(document.querySelector('[data-field="drawer-submit-review"]'))`,
      { label: '详情底部按钮就位' },
    );

    /* ---------- A. 底部按钮：删掉的删掉、该在的在 ---------- */
    const footer = await page.json(
      `(() => {
        const buttons = [...document.querySelectorAll('.n-drawer button')];
        const texts = buttons.map((el) => (el.textContent || '').replace(/\\s+/g, ' ').trim());
        const reload = document.querySelector('[data-field="drawer-reload"]');
        const submit = document.querySelector('[data-field="drawer-submit-review"]');
        const box = (el) => { if (!el) return null; const r = el.getBoundingClientRect();
          return { left: Math.round(r.left), right: Math.round(r.right), top: Math.round(r.top), w: Math.round(r.width) }; };
        return JSON.stringify({
          texts,
          reload: box(reload),
          submit: box(submit),
          submitDisabled: submit ? submit.disabled === true || submit.classList.contains('n-button--disabled') : null,
          hasProgressBar: Boolean(document.querySelector('[data-field="progress-bar"]')),
          progressInputs: document.querySelectorAll('.n-drawer .n-input-number').length,
        }); })()`,
    );

    assert.check(
      !footer.texts.some((t) => t === '删除' || t.includes('删除任务')),
      '抽屉里已经没有任何"删除任务"按钮',
      footer.texts,
    );
    assert.check(Boolean(footer.reload), '「重新加载」按钮在（原来删除按钮的位置）');
    assert.check(Boolean(footer.submit), '「提交审核」按钮在（右侧新增）');

    /*
     * 位置关系用几何断言，不用顺序断言：「重新加载」在左、「提交审核」在右，
     * 而且要求真的贴在两端 —— 两个按钮挤在一起也能满足"左在右左"。
     */
    assert.check(
      footer.reload.right <= footer.submit.left,
      '「重新加载」在「提交审核」左侧',
      { reload: footer.reload, submit: footer.submit },
    );
    assert.check(
      footer.submit.right - footer.reload.left > 260,
      '两个按钮分居底部两端（中间确实被撑开了）',
      { reload: footer.reload, submit: footer.submit },
    );

    // 进度控件必须**彻底消失**（用户要求取消所有任务的进度条）
    assert.check(!footer.hasProgressBar, '抽屉里没有进度条了');
    assert.equal(footer.progressInputs, 0, '抽屉里也没有进度数字输入框');

    /*
     * 主任务有两个子任务 —— 「提交审核」对它应当是禁用的：
     * 子任务还没做完就替父任务提交审核，是"假的状态推进"。
     * 这条断言同时也说明了**按钮不是坏的，是规则在拦**。
     */
    assert.check(footer.submitDisabled === true, '带子任务的主任务上「提交审核」是禁用的');

    /* ---------- B. 提交审核：换个没子任务的任务真的能提交 ---------- */
    /*
     * 用播种的「叶子任务」（没有子任务）。走大纲卡片点击进详情 —— 顺便覆盖
     * "点卡片开详情、点卡片里的按钮不开详情"这两个新行为。
     */
    await page.click('.n-drawer-mask', { via: 'dom' });
    await page.waitFor("!document.querySelector('.n-drawer')", { label: '先关掉抽屉' });

    await page.goto('#/workbench', 'outline');
    const leafTitle = `${data.project.name}·叶子任务`;
    await page.waitFor(
      `[...document.querySelectorAll('[data-field="outline-title"]')].some((el) => (el.textContent || '').trim() === ${JSON.stringify(leafTitle)})`,
      { label: '大纲里出现叶子任务' },
    );
    await page.evaluate(
      `(() => { const el = [...document.querySelectorAll('[data-field="outline-title"]')]
        .find((node) => (node.textContent || '').trim() === ${JSON.stringify(leafTitle)});
        el.setAttribute('data-e2e-card', '1'); return 1; })()`,
    );
    await page.click('[data-e2e-card="1"]');
    await page.waitFor("Boolean(document.querySelector('.n-drawer'))", { label: '点卡片打开了详情' });

    await page.waitFor(
      `Boolean(document.querySelector('[data-field="drawer-submit-review"]'))`,
      { label: '「提交审核」按钮出现' },
    );
    const leafSubmitDisabled = await page.evaluate(
      `(() => { const el = document.querySelector('[data-field="drawer-submit-review"]');
        return el ? el.disabled === true || el.classList.contains('n-button--disabled') : null; })()`,
    );
    assert.check(leafSubmitDisabled === false, '没有子任务的任务上「提交审核」可点');

    await page.click('[data-field="drawer-submit-review"]');
    /*
     * 判据落在**服务端**：提交审核最终要落到项目的「待审查」状态，
     * 界面上的标签变了不算数（可能是本地乐观更新）。
     *
     * 注意 `TaskDto` 上没有 `statusName`（状态名要跟项目状态表走），
     * 所以这里比对的是**状态 id**：先查出「待审查」的 id，再看任务是否指向它。
     */
    const statuses = await api.get(`/api/v1/projects/${data.project.id}/workflow-statuses`);
    const reviewStatus = (Array.isArray(statuses) ? statuses : (statuses.items ?? [])).find(
      (item) => item.name === '待审查',
    );
    assert.check(Boolean(reviewStatus), '项目工作流里有「待审查」状态');

    const deadline = Date.now() + 10000;
    let submitted = null;
    while (Date.now() < deadline) {
      submitted = await api.get(`/api/v1/tasks/${encodeURIComponent(data.leaf.id)}`);
      if (submitted?.statusId === reviewStatus?.id) break;
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    assert.equal(
      submitted?.statusId,
      reviewStatus?.id,
      '提交审核之后，服务端上这条任务落在「待审查」状态',
    );
    // 状态分类必须是 doing：六态里只有「已完成」算做完，提交审核不该把人任务标成完成
    assert.equal(submitted?.statusCategory, 'doing', '「待审查」的分类是 doing（不是已完成）');

    const drawerStatus = await page.text('[data-field="drawer-status"]');
    assert.check(
      (drawerStatus || '').includes('待审查'),
      '抽屉里的状态选择器同步显示「待审查」',
      drawerStatus,
    );

    if (sandbox) {
      await page.screenshot(path.join(sandbox.artifactsDir, 'drawer-footer.png'));
    }

    /* ---------- C. 重新加载：丢弃草稿、回到服务端的值 ---------- */
    const descriptionField = '.n-drawer textarea';
    await page.click(descriptionField);
    await page.type(descriptionField, '草稿：正在输入的内容');
    const focusedAfterTyping = await page.evaluate('document.activeElement?.tagName ?? null');
    assert.equal(focusedAfterTyping, 'TEXTAREA', '在描述里输入时焦点仍在描述框里');

    const draftBefore = await page.evaluate(
      "(() => document.querySelector('.n-drawer textarea')?.value ?? '')()",
    );
    assert.check(
      (draftBefore || '').includes('草稿：正在输入的内容'),
      '刚输入的内容留在框里',
      draftBefore?.slice(0, 40),
    );

    /* ---------- D. 改别的字段不会冲掉未保存的文本 ---------- */
    // 改状态（会立刻保存）——原来这一步之后未保存的描述会被服务端值覆盖
    await page.click('.n-drawer .field:has(.n-base-selection) .n-base-selection');
    await page.waitFor(
      "[...document.querySelectorAll('.n-base-select-option')].some((el) => el.offsetParent !== null)",
      { label: '状态下拉展开' },
    );
    await page.evaluate(
      `(() => { const list = [...document.querySelectorAll('.n-base-select-option')].filter((el) => el.offsetParent !== null);
        if (list[0]) list[0].setAttribute('data-e2e-opt', '1'); return list.length; })()`,
    );
    await page.click('[data-e2e-opt="1"]');
    await page.waitFor(
      "!document.querySelector('[data-e2e-opt=\"1\"]') || document.querySelector('[data-e2e-opt=\"1\"]').offsetParent === null",
      { label: '状态下拉收起' },
    ).catch(() => undefined);

    const draftAfterPatch = await page.evaluate(
      "(() => document.querySelector('.n-drawer textarea')?.value ?? '')()",
    );
    assert.check(
      (draftAfterPatch || '').includes('草稿：正在输入的内容'),
      '改了状态之后，未保存的描述仍然在（不再被整块重载冲掉）',
      draftAfterPatch?.slice(0, 40),
    );
    /*
     * 焦点要守的是"**没有被扔到页面别处**"，而不是"必须在抽屉里"。
     *
     * 实测（探针跑出来的）：Naive 的 `NSelect` 选项 teleport 在 body 上，
     * 鼠标选完之后焦点落在 `BODY` —— 组件库的正常行为，不是缺陷。
     * 真正要防的是焦点跳到页面上某个具体控件（抽屉背后的按钮/输入框）：
     * 那时继续打字会落到一个用户看不见的地方。
     *
     * 顺带记一笔：这条断言以前"通过"过，其实是假通过 —— 当时脚本用同一个临时标记
     * 去点选项，结果点在了抽屉背后的卡片上，焦点恰好还留在抽屉内的下拉里。
     * 标记去重之后才露出真实现象。
     */
    const focusAfterPatch = await page.json(
      `(() => { const el = document.activeElement;
        const drawer = document.querySelector('.n-drawer');
        return JSON.stringify({
          tag: el ? el.tagName : null,
          inDrawer: Boolean(drawer && el && drawer.contains(el)),
          drawerOpen: Boolean(drawer),
        }); })()`,
    );
    assert.check(focusAfterPatch.drawerOpen, '改完状态之后详情抽屉仍然开着');
    assert.check(
      focusAfterPatch.inDrawer || focusAfterPatch.tag === 'BODY',
      '焦点没有跑到页面别处（要么还在抽屉里，要么在 BODY 上）',
      focusAfterPatch,
    );

    /*
     * 「重新加载」= 丢弃草稿、重新读服务端。这条断言顺带证明它真的**干了活**，
     * 而不只是个摆在那里好看的按钮。
     */
    await page.click('[data-field="drawer-reload"]');
    await page.waitFor(
      "Boolean(document.querySelector('.n-drawer'))",
      { label: '重新加载之后抽屉还在' },
    );
    const deadlineReload = Date.now() + 5000;
    let afterReload = '';
    while (Date.now() < deadlineReload) {
      afterReload = await page.evaluate(
        "(() => document.querySelector('.n-drawer textarea')?.value ?? '')()",
      );
      if (!(afterReload || '').includes('草稿：正在输入的内容')) break;
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
    assert.check(
      !(afterReload || '').includes('草稿：正在输入的内容'),
      '「重新加载」把未保存的草稿丢弃了（回到服务端的值）',
      (afterReload || '').slice(0, 40),
    );

    /* ---------- 收尾：点空白处能关掉（用户早先的要求，这里一并守住） ---------- */
    await page.click('.n-drawer-mask', { via: 'dom' });
    await page.waitFor("!document.querySelector('.n-drawer')", { label: '点空白处关掉抽屉' });
    assert.check(true, '点空白处关掉了详情');
  },
};
