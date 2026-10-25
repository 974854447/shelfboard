/**
 * 场景：全局搜索（M2）。
 *
 * **中文分词是这个场景的核心**（实测结论见 docs/technical-design.md §24）：
 * 默认分词器会把一整串中文当成一个词，于是"整串能搜到、片段搜不到" ——
 * 而用户永远只会输入片段。所以这里必须真的用中文片段去搜：
 *   1. **两个汉字**（"任务"）也要有结果 → 走的是少于 3 字的模糊匹配回落；
 *   2. **三个以上汉字**（"子任务二"）走全文索引；
 *   3. **非词首片段**（"务二"不行，用"子任务"这种中间片段不行；
 *      用标题中段"任务二"三个字）也要命中 —— 这是 trigram 相对默认分词器的关键好处；
 *   4. 结果跨项目并标出所属项目；点结果能打开详情；
 *   5. **Ctrl+K** 能随时跳到搜索页（快捷键是这次交付的一部分）。
 */

module.exports = {
  name: 'search',
  title: '全局搜索：中文片段 + 跨项目',
  needsProject: true,

  async run({ page, assert, data }) {
    await page.goto('#/search', 'search');

    const searchFor = async (keyword) => {
      await page.type('[data-field="search-input"] input', '');
      await page.evaluate(
        `(() => { const input = document.querySelector('[data-field="search-input"] input');
          if (!input) return 1;
          input.value = '';
          input.dispatchEvent(new Event('input', { bubbles: true }));
          return 1; })()`,
      );
      await page.type('[data-field="search-input"] input', keyword);
      await page.click('[data-field="search-run"]');
      await page.waitFor(
        "Boolean(document.querySelector('[data-field=\"search-mode\"]')) || Boolean(document.querySelector('[data-field=\"empty-state\"]'))",
        { label: `搜索「${keyword}」有结果或空态` },
      );
      return page.json(
        `(() => JSON.stringify({
          mode: (document.querySelector('[data-field="search-mode"]')?.textContent || '').trim(),
          hits: [...document.querySelectorAll('[data-field="search-hit"]')].map((el) => (el.textContent || '').replace(/\\s+/g, ' ').trim()),
          projects: [...document.querySelectorAll('[data-field="search-hit"] [data-field="card-belongs"]')].map((el) => (el.textContent || '').trim()),
          empty: Boolean(document.querySelector('[data-field="empty-state"]')),
        }))()`,
      );
    };

    /* ---------- 三个汉字：走全文索引 ---------- */
    const fts = await searchFor('子任务二');
    assert.atLeast(fts.hits.length, 1, '搜「子任务二」（3 字以上，走全文索引）能命中');
    assert.check(fts.mode.includes('全文索引'), '界面说明走的是全文索引', fts.mode);
    assert.check(
      fts.hits.some((text) => text.includes('子任务二')),
      '结果里有那条任务',
      fts.hits.slice(0, 3),
    );

    /* ---------- 非词首片段也要命中（trigram 的价值所在） ---------- */
    const middle = await searchFor('任务二');
    assert.atLeast(middle.hits.length, 1, '搜标题中段「任务二」也能命中（中文片段检索）');

    /* ---------- 两个汉字：回落到模糊匹配 ---------- */
    const short = await searchFor('任务');
    assert.atLeast(short.hits.length, 1, '搜「任务」（只有 2 个字）也能命中');
    assert.check(short.mode.includes('模糊匹配'), '界面如实说明这次走的是模糊匹配', short.mode);

    /* ---------- 跨项目 + 标出所属项目 ---------- */
    assert.check(
      short.projects.some((text) => text.includes(data.project.name)),
      `结果里标出了所属项目（${data.project.name}）`,
      [...new Set(short.projects)],
    );
    assert.check(
      short.projects.every((name) => name.length > 0),
      '每条结果都带项目名',
      short.projects.slice(0, 3),
    );

    /* ---------- 点结果 → 详情 ---------- */
    // 点**标题**而不是卡片正中：卡片右下角是状态标签，点正中在不同高度下可能落在它上面
    await page.click('[data-field="search-hit"] .wb-title');
    await page.waitFor("Boolean(document.querySelector('.n-drawer'))", { label: '点搜索结果打开详情' });
    assert.check(true, '点搜索结果能打开任务详情');
    await page.click('.n-drawer-mask', { via: 'dom' });
    await page.waitFor("!document.querySelector('.n-drawer')", { label: '关掉详情' });

    /* ---------- 搜不到时给出空态 ---------- */
    const none = await searchFor('zzz绝对不存在的关键词zzz');
    assert.equal(none.hits.length, 0, '搜不到时结果为空');
    assert.check(none.empty, '搜不到时显示空态而不是空白页');

    /* ---------- Ctrl+K 从别处跳到搜索页 ---------- */
    await page.goto('#/workbench', 'outline');
    await page.evaluate(
      "(() => { document.body.focus(); document.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', ctrlKey: true, bubbles: true })); return 1; })()",
    );
    await page.waitFor("location.hash === '#/search'", { label: 'Ctrl+K 跳到搜索页' });
    assert.check(true, 'Ctrl+K 能跳到搜索页');
  },
};
