/**
 * 场景：总览的「今日工作内容」。
 *
 * 这一块取代了原来的六边形关系数据图（用户 2026-10-02 的要求）。所以这里两边都断言：
 * 1. **旧图确实没了** —— 用"格子/盘面/浮卡的数量为 0"来钉住，而不是只测新面板存在；
 *    只测新的，等于允许两张图叠在一起也照样通过。
 * 2. **新面板真的列出今天动过的任务** —— 而且列的是**我们这个项目**的任务
 *    （夹具里那五个任务都是刚建的，必然落在"今日新建"一组），
 *    这样"面板是空的但占位符画得挺好"这种情况骗不过去。
 */

module.exports = {
  name: 'overview',
  title: '总览：今日工作内容',
  needsProject: true,

  async run({ page, assert, projectName }) {
    await page.goto('#/overview', 'overview');

    /* ---------- 1) 旧的关系数据图必须已经不在了 ---------- */
    const legacy = await page.json(
      `(() => JSON.stringify({
        cells: document.querySelectorAll('.ov-cell').length,
        disk: document.querySelectorAll('.disk').length,
        tipcard: document.querySelectorAll('.tipcard').length,
      }))()`,
    );
    assert.equal(legacy.cells, 0, '六边形格子数（关系数据图应该已整体移除）');
    assert.equal(legacy.disk, 0, '3D 盘面元素数');
    assert.equal(legacy.tipcard, 0, '悬停浮卡元素数');

    /* ---------- 2) 顶部统计卡没受影响 ---------- */
    assert.equal(await page.count('.stat'), 4, '顶部统计卡数量');

    /* ---------- 3) 今日工作内容面板的结构 ---------- */
    assert.check(
      await page.exists('[data-field="today-work-panel"]'),
      '总览里有「今日工作内容」面板',
    );
    assert.check(
      (await page.text('[data-field="today-work-panel"] h2')).includes('今日工作内容'),
      '面板标题是「今日工作内容」',
    );

    /*
     * 副标题是「日期 · 各组条数」。夹具刚建了五个任务，所以"今日新建"这一组一定非空，
     * 副标题里一定带它的条数 —— 拿这个当"数据真的取到了"的证据。
     */
    const sub = await page.text('[data-field="today-work-sub"]');
    assert.check(sub.length > 0, `面板副标题不为空（实际：「${sub}」）`);
    assert.check(/新建|完成|推进/.test(sub), '副标题里列出了有内容的分组');

    const groupCount = await page.count('[data-today-group]');
    assert.atLeast(groupCount, 1, '渲染出来的分组数');
    assert.check(
      await page.exists('[data-today-group="created"]'),
      '「今日新建」分组存在（夹具任务是刚建的）',
    );

    /* ---------- 4) 列出来的就是今天动过的任务 ---------- */
    const items = await page.json(
      `(() => JSON.stringify([...document.querySelectorAll('[data-field="today-work-item"]')]
        .map((el) => (el.textContent || '').replace(/\\s+/g, ' ').trim())))()`,
    );
    assert.atLeast(items.length, 5, '今日工作内容里的条目数');
    assert.check(
      items.some((line) => line.includes(`${projectName}·主任务`)),
      '列表里能看见本项目的「主任务」（说明取的是真实数据，不是占位）',
    );
    assert.check(
      items.some((line) => line.includes(projectName) && line.includes('待完成')),
      '条目里带项目名与状态名',
    );

    /* ---------- 5) 刷新按钮真的走一次接口 ---------- */
    await page.click('[data-field="today-work-refresh"]');
    await page.waitFor(
      `Boolean(document.querySelector('[data-field="today-work-panel"]'))`,
      { label: '刷新之后面板仍在' },
    );
    assert.atLeast(
      await page.count('[data-field="today-work-item"]'),
      5,
      '刷新之后条目数不变（说明刷新没有把面板弄空）',
    );
  },
};
