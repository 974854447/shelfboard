/**
 * 场景：日历视图（M2）。
 *
 * 重点不是"能显示一个月"，而是四件容易出错的事：
 *   1. **本地日历天**：昨天到期的任务必须落在"逾期"里、今天到期的必须落在今天那一格
 *      （时区口径错了会整体偏一天，而这在界面上很难一眼看出来）；
 *   2. **逾期面板**：日历最容易漏掉的就是过期的东西，它必须常在；
 *   3. **农历 / 节气 / 节假日标记**与右侧五个面板（选中某天、本周小结、近 14 天、
 *      项目分布、下一个假期）都真的接上了数据；
 *   4. **点任务能开详情**（日历只是入口，改还是在详情里改）。
 */

const path = require('node:path');

module.exports = {
  name: 'calendar',
  title: '日历视图：按截止日排期',
  needsProject: true,

  async run({ page, assert, data, sandbox, shots }) {
    await page.goto('#/calendar', 'calendar');

    // 标题要取**视图自己的** h1 —— 外壳顶栏也有一个 h1（写的是「日历」），
    // 用 `document.querySelector('h1')` 会抓到外壳那个（第一版就抓错了）
    const viewTitle = () => page.text('[data-view="calendar"] h1');

    /* ---------- 月份网格 ---------- */
    const grid = await page.json(
      `(() => {
        const cells = document.querySelectorAll('[data-field="cal-cell"]');
        const today = [...cells].filter((el) => el.classList.contains('today'));
        return JSON.stringify({
          cells: cells.length,
          todayMarked: today.length,
          weekdays: document.querySelectorAll('.weekdays span').length,
          title: (document.querySelector('[data-view="calendar"] h1')?.textContent || '').trim(),
        }); })()`,
    );
    // 固定 6 行 × 7 列：翻月时高度不跳
    assert.equal(grid.cells, 42, '日历格数（6 行 × 7 列）');
    assert.equal(grid.weekdays, 7, '星期表头 7 列');
    assert.equal(grid.todayMarked, 1, '今天那一格有标记');
    assert.check(/年/.test(grid.title) && /月/.test(grid.title), '标题显示年月', grid.title);

    /* ---------- 逾期 / 今天 的归档正确 ---------- */
    const stats = await page.json(
      `(() => JSON.stringify({
        overdue: (document.querySelector('[data-field="cal-stat-overdue"]')?.textContent || '').trim(),
        today: (document.querySelector('[data-field="cal-stat-today"]')?.textContent || '').trim(),
        overduePanel: (document.querySelector('[data-field="cal-overdue-panel"]')?.textContent || '').replace(/\\s+/g, ' ').trim(),
      }))()`,
    );
    assert.check(/逾期\s*[1-9]/.test(stats.overdue), '逾期计数 > 0（播种里有一条昨天到期的任务）', stats.overdue);
    assert.check(/今天\s*[1-9]/.test(stats.today), '今天计数 > 0（播种里有一条今天到期的任务）', stats.today);
    assert.check(
      stats.overduePanel.includes('子任务二'),
      '逾期面板里列出了那条逾期任务',
      stats.overduePanel.slice(0, 80),
    );

    /* ---------- 今天那一格里能看到今天的任务 ---------- */
    const todayCell = await page.json(
      `(() => {
        const cell = document.querySelector('[data-field="cal-cell"].today');
        return JSON.stringify({ text: (cell?.textContent || '').replace(/\\s+/g, ' ').trim() }); })()`,
    );
    assert.check(todayCell.text.includes('子任务一'), '今天那一格里有今天到期的任务', todayCell.text.slice(0, 60));

    /* ---------- 农历 / 节气 / 节假日标记 ---------- */
    /*
     * 每个格子上都要有一行小字（农历日、节气或节日）。
     * 内容随日期变，所以只断言"42 格都有、且都不是空的"，
     * 具体某天是什么由单元测试钉住（tests/holidays-lunar.test.ts 对着官方通知核过）。
     */
    const lunar = await page.json(
      `(() => {
        const cells = [...document.querySelectorAll('[data-field="cal-lunar"]')];
        return JSON.stringify({
          count: cells.length,
          empty: cells.filter((el) => (el.textContent || '').trim().length === 0).length,
          sample: cells.slice(0, 6).map((el) => (el.textContent || '').trim()),
          badges: [...document.querySelectorAll('[data-field="cal-cell"] .badge')].length,
        }); })()`,
    );
    assert.equal(lunar.count, 42, '每个格子都有一行农历/节气/节日');
    assert.equal(lunar.empty, 0, '没有空的农历行', lunar.sample);

    /* ---------- 右侧五个面板 ---------- */
    const panels = await page.json(
      `(() => {
        const text = (sel) => (document.querySelector(sel)?.textContent || '').replace(/\\s+/g, ' ').trim();
        return JSON.stringify({
          day: text('[data-field="cal-day-panel"]'),
          week: text('[data-field="cal-week-panel"]'),
          bars: document.querySelectorAll('[data-field="cal-bars"] .bar-col').length,
          projects: document.querySelectorAll('[data-field="cal-project-row"]').length,
          holiday: text('[data-field="cal-holiday-panel"]'),
        }); })()`,
    );
    assert.check(
      panels.day.includes('周') && panels.day.includes('·'),
      '「选中某天」面板的标题写着星期与农历',
      panels.day.slice(0, 40),
    );
    assert.check(panels.week.includes('本周到期'), '「本周小结」列出了本周到期数', panels.week.slice(0, 40));
    assert.equal(panels.bars, 14, '「近 14 天」柱状图有 14 根柱');
    assert.atLeast(panels.projects, 1, '「项目分布」列出了项目（本月有播种的任务）');
    assert.check(
      panels.holiday.includes('假期') || panels.holiday.includes('内置'),
      '「下一个假期」面板有内容（假期倒计时，或如实说明没有内置数据）',
      panels.holiday.slice(0, 40),
    );

    /*
     * 倒计时**不能是负数**。
     *
     * 第一版就是这么错的：假期中间打开日历显示"距离「中秋节」还有 -1 天" ——
     * 因为"下一个假期"只算了开始日期，没考虑"今天正在假期里"。
     * 这种文案错误不会报错、也不会有人主动去查，所以留一条断言守住。
     */
    const countdown = await page.text('[data-field="cal-countdown-inline"]');
    assert.check(
      countdown === null || !/-\s*\d/.test(countdown),
      '假期倒计时不会出现负数',
      countdown,
    );

    // 留一张图：日历与右侧五个面板（`--shots` 时才存）
    if (shots) await page.screenshot(path.join(sandbox.artifactsDir, 'calendar-panels.png'));

    /* ---------- 点某一天：右侧跟着换 ---------- */
    /*
     * 点**不是今天**的那一格：选中态要换过去，右侧标题也要跟着变。
     * 这条正是用户要的"点日期看那天的任务"，光看代码看不出有没有接上。
     */
    const dayPanelBefore = panels.day;
    await page.evaluate(
      `(() => {
        const cells = [...document.querySelectorAll('[data-field="cal-cell"]')];
        const other = cells.find((el) => !el.classList.contains('today'));
        if (other) other.setAttribute('data-e2e-pick', '1');
        return other ? 1 : 0; })()`,
    );
    await page.click('[data-e2e-pick="1"]');
    await page.waitFor(
      `(document.querySelector('[data-field="cal-day-panel"]')?.textContent || '').replace(/\\s+/g, ' ').trim() !== ${JSON.stringify(dayPanelBefore)}`,
      { label: '点另一天后选中面板跟着换' },
    );
    const picked = await page.json(
      `(() => JSON.stringify({
        selected: document.querySelectorAll('[data-field="cal-cell"].selected').length,
        panel: (document.querySelector('[data-field="cal-day-panel"]')?.textContent || '').replace(/\\s+/g, ' ').trim(),
      }))()`,
    );
    assert.equal(picked.selected, 1, '任何时刻只有一格是"选中"');
    assert.check(picked.panel.length > 0, '选中那天有面板标题', picked.panel.slice(0, 40));

    /* ---------- 给这一天加标记 → 格子上和面板里都要出现 ---------- */
    /*
     * 用户要求「日历添加标记功能」：日历上能自己往某一天加一条东西。
     * 这里走**真实交互**（输入框 + 添加按钮），而不是直接调接口 ——
     * 接口测试在 packages/server/tests/calendar-marks.test.ts 里，
     * 这一条要证的是"点了真的有反应、而且格子立刻显示出来"。
     */
    const markTitle = 'e2e 标记';
    await page.type('[data-field="cal-mark-input"] input', markTitle);
    await page.click('[data-field="cal-mark-add"]');
    await page.waitFor(
      `[...document.querySelectorAll('[data-field="cal-mark"]')].some((el) => (el.textContent || '').includes(${JSON.stringify(markTitle)}))`,
      { label: '格子上出现刚加的标记' },
    );

    const withMark = await page.json(
      `(() => JSON.stringify({
        cells: [...document.querySelectorAll('[data-field="cal-mark"]')].map((el) => (el.textContent || '').trim()),
        chips: [...document.querySelectorAll('[data-field="cal-mark-item"]')].map((el) => (el.textContent || '').replace(/\\s+/g, ' ').trim()),
        input: document.querySelector('[data-field="cal-mark-input"] input')?.value ?? null,
      }))()`,
    );
    assert.check(
      withMark.cells.some((text) => text.includes(markTitle)),
      '格子上显示了这个标记',
      withMark.cells.slice(0, 4),
    );
    assert.check(
      withMark.chips.some((text) => text.includes(markTitle)),
      '右侧「选中某天」面板里也列出了这个标记',
      withMark.chips,
    );
    assert.equal(withMark.input, '', '添加成功之后输入框被清空（不然会以为没成功）');

    // 留一张图：格子上与面板里的标记（`--shots` 时才存）
    if (shots) await page.screenshot(path.join(sandbox.artifactsDir, 'calendar-marks.png'));

    // 刷新一次页面，确认标记是**存下来**的（不是只在内存里）
    await page.reload();
    await page.waitFor(
      `(() => { const el = document.querySelector('[data-view="calendar"]');
        if (!el) return false; const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; })()`,
      { label: '重载后日历重新挂上' },
    );
    await page.waitFor(
      `[...document.querySelectorAll('[data-field="cal-mark"]')].some((el) => (el.textContent || '').includes(${JSON.stringify(markTitle)}))`,
      { label: '重载后标记仍在（已落盘）' },
    );
    assert.check(true, '标记存在工作区库里，刷新后还在');

    /* ---------- 删掉这个标记 ---------- */
    /*
     * 重载之后"选中某天"回到今天（页面状态不持久化），所以先点回**带标记的那一格**，
     * 面板里才会出现那个标记的 × —— 这也顺带验证了"点了某天，面板显示的就是那天的标记"。
     */
    await page.evaluate(
      `(() => {
        const cells = [...document.querySelectorAll('[data-field="cal-cell"]')];
        const cell = cells.find((el) => (el.querySelector('[data-field="cal-mark"]')?.textContent || '').includes(${JSON.stringify(markTitle)}));
        if (cell) cell.setAttribute('data-e2e-pick', '1');
        return cell ? 1 : 0; })()`,
    );
    await page.click('[data-e2e-pick="1"] .num');
    await page.waitFor(
      `[...document.querySelectorAll('[data-field="cal-mark-item"]')].some((el) => (el.textContent || '').includes(${JSON.stringify(markTitle)}))`,
      { label: '点回那一天后面板里出现该标记' },
    );
    assert.check(true, '点某一天，面板里显示的就是那天的标记');

    await page.click('[data-field="cal-mark-remove"]');
    await page.waitFor(
      `![...document.querySelectorAll('[data-field="cal-mark"]')].some((el) => (el.textContent || '').includes(${JSON.stringify(markTitle)}))`,
      { label: '删除后格子上不再有这个标记' },
    );
    assert.check(true, '点标记上的 × 能删掉它（格子与面板同时消失）');

    /* ---------- 翻月与回到今天 ---------- */
    const before = await viewTitle();
    await page.click('[data-field="cal-next"]');
    await page.waitFor(
      `(document.querySelector('[data-view="calendar"] h1')?.textContent || '') !== ${JSON.stringify(before)}`,
      { label: '点下一月后标题变化' },
    );
    assert.check(true, `翻到下一月：${await viewTitle()}`);
    await page.click('[data-field="cal-today"]');
    await page.waitFor(
      `(document.querySelector('[data-view="calendar"] h1')?.textContent || '') === ${JSON.stringify(before)}`,
      { label: '点「今天」回到本月' },
    );
    assert.check(true, '点「今天」回到当月');

    /* ---------- 点任务 → 打开详情 ---------- */
    await page.click('.chip');
    await page.waitFor("Boolean(document.querySelector('.n-drawer'))", { label: '点日历里的任务打开详情' });
    /*
     * 抽屉的**外壳**先出现、内容随后才加载（详情是一次请求）。
     * 这里必须等"抽屉里真的有这条任务的内容"，不能刚看到 `.n-drawer` 就读文本 ——
     * 打包版冷启动慢一点，第一版就是这么假失败的（读到的只有标题"任务详情"）。
     */
    await page.waitFor(
      `(() => { const d = document.querySelector('.n-drawer');
        return Boolean(d && (d.textContent || '').includes(${JSON.stringify(data.project.name)})); })()`,
      { label: '抽屉里出现这条任务的详情内容' },
    );
    const drawer = await page.text('.n-drawer');
    assert.check(
      (drawer || '').includes(data.project.name),
      '打开的详情是这条任务（抽屉里有任务标题）',
      drawer?.slice(0, 60),
    );
    assert.check(true, '日历里点任务能打开详情抽屉');
  },
};
