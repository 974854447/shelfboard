/**
 * 场景：应用外壳与四个页面都能真正挂载。
 *
 * 这条是**所有其他场景的前提**，也是替代老脚本里"点开看一眼"的那部分。
 * 它专门盯一种最难查的表象：**外壳（侧栏、顶栏）渲染出来了，路由内容却是空的**。
 * 老脚本遇到这种情况会把每个页面的元素数报成 0（"0 张卡片"），
 * 指向完全错误的方向；这里的判据是"`[data-view=…]` 出现且有尺寸 + 内容区有实质节点"，
 * 失败信息直接说清是"路由内容没挂上"，并自动带上现场（见 diagnose.cjs）。
 */

module.exports = {
  name: 'shell',
  title: '外壳与四个页面挂载',
  needsProject: false,

  async run({ page, cdp, assert }) {
    assert.check(await page.exists('.sider'), '侧栏渲染出来了');
    assert.check(await page.exists('.page-title'), '顶栏标题渲染出来了');

    /*
     * 环境标签：E2E 一律走 `--user-data-dir`，所以环境必然是"自定义目录"。
     * 这条断言同时守住两件事：环境标签确实显示，且**测试没有跑在正式数据上**。
     */
    const badge = await page.text('.env-badge');
    assert.equal(badge, '自定义目录', '侧栏环境标签');

    const routes = [
      ['#/projects', 'projects', '.page-head'],
      // 0.2.x：工作台 → 工作大纲（自上而下的树）、我的待办 → 今日待办
      ['#/workbench', 'outline', '.tree, .placeholder'],
      ['#/overview', 'overview', '.stat, .blank'],
      ['#/logs', 'logs', '.toolbar'],
    ];

    for (const [hash, view, anchor] of routes) {
      // goto 内部会等 [data-view=<view>] 出现且有尺寸 —— 失败信息里带着判据本身
      await page.goto(hash, view);

      const info = await page.json(
        `(() => { const root = document.querySelector('[data-view="${view}"]');
          return JSON.stringify({
            hash: location.hash,
            nodes: root ? root.querySelectorAll('*').length : -1,
            anchor: Boolean(document.querySelector(${JSON.stringify(anchor)})),
          }); })()`,
      );
      assert.equal(info.hash, hash, `${hash} 的路由`);
      assert.atLeast(info.nodes, 5, `${hash} 的内容节点数`);
      assert.check(info.anchor, `${hash} 出现了页面自身的标志性元素（${anchor}）`);
    }

    const errors = cdp
      .eventsOf('Runtime.exceptionThrown')
      .map((event) => String(event.params.exceptionDetails?.exception?.description ?? '').split('\n')[0]);
    assert.check(errors.length === 0, '全程没有页面 JS 异常', errors);

    assert.note(`窗口标题：${await page.evaluate('document.title')}`);
  },
};
