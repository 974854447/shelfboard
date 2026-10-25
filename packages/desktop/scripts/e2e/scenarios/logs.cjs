/**
 * 场景：日志与诊断页（M1 的可观测性要求）。
 *
 * 这一页的价值全在"出问题时真的能查到东西"，所以断言的也是这条：
 * 有日志行、有级别筛选、有搜索、有分页，并且**实时流开关存在**。
 * 应用自己启动时就会写日志，所以这里不造数据，直接读真实内容。
 */

module.exports = {
  name: 'logs',
  title: '日志页：筛选、搜索、实时流',
  needsProject: false,

  async run({ page, assert, api }) {
    await page.goto('#/logs', 'logs');

    const rows = await page.count('.log-row');
    assert.atLeast(rows, 1, '日志行数（应用启动本身就会写日志）');

    const toolbar = await page.json(
      `(() => JSON.stringify({
        selects: document.querySelectorAll('.toolbar .n-base-selection').length,
        search: Boolean(document.querySelector('.toolbar input')),
        live: [...document.querySelectorAll('.toolbar button')].some((b) => (b.textContent || '').includes('实时流')),
        hasLevelTag: Boolean(document.querySelector('.log-row .n-tag')),
      }))()`,
    );
    assert.atLeast(toolbar.selects, 2, '筛选下拉数量（级别 + 来源）');
    assert.check(toolbar.search, '有搜索输入框');
    assert.check(toolbar.live, '有「开启实时流」开关');
    assert.check(toolbar.hasLevelTag, '每行日志带级别标签');

    /* ---------- 按级别筛选后仍能出结果，且行数不增加 ---------- */
    const before = await page.text('.toolbar .n-base-selection');
    await page.click('.toolbar .n-base-selection');
    await page.waitFor("document.querySelectorAll('.n-base-select-option').length > 0", { label: '级别下拉展开' });
    const optionList = await page.options();
    assert.atLeast(optionList.length, 3, '级别下拉里的选项数');

    /*
     * 选一个**与当前值不同**的选项，然后等"选中值真的变了"。
     *
     * 两个踩过的坑都写在这里：
     * 1. 等"浮层从 DOM 里消失"是错的 —— Naive 关掉菜单后节点还留着（只是隐藏），
     *    这条判据永远不成立，会把正常功能判成超时；
     * 2. 用 `:nth-child(2)` 定位选项也不行 —— 选项外面套着虚拟列表容器，
     *    选择器未必命中，报出来却是"元素不存在"。
     */
    const optionText = await page.pickOption(1);
    await page.waitFor(
      `(document.querySelector('.toolbar .n-base-selection')?.textContent || '').includes(${JSON.stringify((optionText ?? '').split('（')[0])})`,
      { label: `下拉选中值变成「${optionText}」` },
    );
    assert.check(before !== optionText, '筛选值确实变了（不是又选了原来那个）', { 之前: before, 之后: optionText });

    const filtered = await page.count('.log-row');
    assert.check(filtered <= rows, '筛选后日志行数不超过筛选前', { 筛选前: rows, 筛选后: filtered });

    /*
     * 把筛选条件复位：**离开这个页面再回来**。
     *
     * 筛选是组件内的状态，重挂载即回到默认（全部级别）。这一步是必须的 ——
     * 上面刚把级别设成了 warn 及以上，而测试环境里的日志几乎全是 info，
     * 于是列表会**一直是空的**，后面"有数据时的分页栏位置"就没法量了
     * （第一版就栽在这：报出来是"清空搜索后列表恢复超时"，看着像搜索坏了）。
     */
    await page.goto('#/projects', 'projects');
    await page.goto('#/logs', 'logs');
    await page.waitFor("document.querySelectorAll('.log-row').length > 0", { label: '回到默认筛选后列表有数据' });

    /* ---------- 分页栏始终在底部（无论有没有数据） ---------- */
    /*
     * 用户指出：没有日志时那个「上一页 / 下一页」会浮到工具栏下面，看着像排版坏了；
     * 他希望"没数据的时候它也在（页面底部的）那个位置"。
     * 所以这里量的不是"分页栏存在"，而是**它的位置**：底边要贴着内容区底部，
     * 且在有数据 / 无数据两种状态下位置一致。
     */
    const pagerBottom = async () =>
      page.json(
        `(() => {
          const pager = document.querySelector('.pager');
          const view = document.querySelector('[data-view="logs"]');
          const rows = document.querySelectorAll('.log-row').length;
          if (!pager || !view) return JSON.stringify(null);
          const p = pager.getBoundingClientRect();
          const v = view.getBoundingClientRect();
          return JSON.stringify({ rows, gapToBottom: Math.round(v.bottom - p.bottom) });
        })()`,
      );

    const withRows = await pagerBottom();
    assert.check(withRows !== null, '分页栏存在');
    assert.check(
      withRows && withRows.gapToBottom <= 40,
      '有数据时分页栏贴着内容区底部',
      withRows,
    );

    // 造一个"没有数据"的状态：搜索一个不可能命中的关键词
    await page.type('.toolbar input', 'zzz-绝对搜不到的关键词-zzz');
    await page.waitFor("document.querySelectorAll('.log-row').length === 0", {
      label: '筛选到没有数据（空态）',
      timeoutMs: 8000,
    });
    const empty = await pagerBottom();
    assert.check(empty !== null, '空态下分页栏仍然存在（用户要求：没数据时也要在这个位置）');
    if (empty && withRows) {
      assert.check(
        empty.gapToBottom <= 40,
        '空态下分页栏同样贴着底部（不再浮到工具栏下面）',
        empty,
      );
      assert.check(
        Math.abs(empty.gapToBottom - withRows.gapToBottom) <= 12,
        '有数据与无数据时分页栏位置一致',
        { 有数据: withRows, 空态: empty },
      );
    }

    // 把搜索框清掉，恢复列表（后面的步骤要基于完整列表）
    await page.evaluate(
      "(() => { const input = document.querySelector('.toolbar input'); if (input) { input.value = ''; input.dispatchEvent(new Event('input', { bubbles: true })); } return 1; })()",
    );
    await page.waitFor("document.querySelectorAll('.log-row').length > 0", { label: '清空搜索后列表恢复' });

    /* ---------- 历史噪音：无害告警显示成灰色「提示」，不是红色错误 ---------- */
    /*
     * 场景：升级修掉一个 bug 之后，旧的红字仍留在日志表里，用户每次打开日志页都以为问题还在
     * （实测正式库里有 12 条这种历史：8 条浏览器 ResizeObserver 告警 + 4 条早已删除的旧视图的异常）。
     * 做法是：过滤只管"以后不再上报"，**表里已有的按展示降级**。
     * 为了不依赖真实历史数据，这里先造一条同类日志（走渲染进程上报那条接口，形状与真实上报一致）。
     */
    // 先把搜索框清空，否则刚造的日志会被关键词筛掉
    await page.evaluate(
      "(() => { const input = document.querySelector('.toolbar input'); if (input) { input.value = ''; input.dispatchEvent(new Event('input', { bubbles: true })); } return 1; })()",
    );
    await api.post('/api/v1/logs/client', {
      level: 'error',
      message: '未捕获错误：ResizeObserver loop completed with undelivered notifications.',
      scope: 'window',
    });
    await page.click('[data-field="logs-refresh"]');
    await page.waitFor(
      "[...document.querySelectorAll('.log-row')].some((el) => (el.textContent || '').includes('ResizeObserver'))",
      { label: '重新加载后能看到那条浏览器告警' },
    );

    const benignRow = await page.json(
      `(() => {
        const row = [...document.querySelectorAll('.log-row')].find((el) => (el.textContent || '').includes('ResizeObserver'));
        if (!row) return JSON.stringify(null);
        return JSON.stringify({
          levelText: (row.querySelector('.n-tag')?.textContent || '').trim(),
          dimmed: row.classList.contains('lv-benign'),
        }); })()`,
    );
    assert.check(benignRow !== null, '日志里能找到那条浏览器告警');
    if (benignRow) {
      assert.equal(benignRow.levelText, '提示', '浏览器无害告警显示成「提示」而不是 error');
      assert.check(benignRow.dimmed, '这一行被压暗（视觉上退到后面）');
    }
    const note = await page.text('.benign-note');
    assert.check((note || '').includes('无害'), '页面上有一句说明，告诉用户这类不是应用错误', note?.slice(0, 50));

    /* ---------- 清空日志：把历史噪音清掉 ---------- */
    const beforeClear = await page.evaluate('document.querySelectorAll(".log-row").length');
    await page.click('[data-field="logs-clear"]');
    await page.waitFor("Boolean(document.querySelector('.n-dialog'))", { label: '清空确认弹窗出现' });
    await page.evaluate(
      "(() => { const b = [...document.querySelectorAll('.n-dialog button')].find((el) => (el.textContent || '').trim() === '清空'); if (b) b.click(); return 1; })()",
    );
    await page.waitFor("!document.querySelector('.n-dialog')", { label: '清空弹窗关掉' });
    await page.waitFor(
      "![...document.querySelectorAll('.log-row')].some((el) => (el.textContent || '').includes('ResizeObserver'))",
      { label: '清空之后历史告警消失' },
    );
    const afterClear = await page.evaluate('document.querySelectorAll(".log-row").length');
    assert.check(afterClear < beforeClear, '清空之后本页日志行数变少', { 之前: beforeClear, 之后: afterClear });

    /*
     * 「清空」自己那条记录要等一拍才看得到，而且**不能从界面上数**：
     * 1. 日志是**先攒在内存缓冲、定时批量写库**的（flush 间隔 500ms），清空那一刻它还在缓冲里；
     * 2. 这个场景前面把界面筛选设成了 warn 及以上，而这条记录是 info —— 界面上根本不会显示它。
     * 所以直接查接口（"动作有没有留痕"本来就是服务端事实），有界轮询而不是盲等。
     */
    let sawClearRecord = false;
    for (let attempt = 0; attempt < 12 && !sawClearRecord; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 300));
      const page1 = await api.get('/api/v1/logs?page=1&pageSize=10');
      sawClearRecord = page1.items.some((entry) => entry.message.includes('已清空'));
    }
    assert.check(sawClearRecord, '清空动作本身在日志里留了一条记录（"日志怎么突然空了"有答案）');
  },
};
