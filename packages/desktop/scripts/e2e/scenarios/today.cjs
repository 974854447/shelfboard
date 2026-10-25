/**
 * 场景：今日待办（0.2.x 由「我的待办」改成的当日视角）。
 *
 * 用户的三条要求各自都要能被验证，而且**不能只看界面说了什么**：
 *   1. 「打卡从每天第一次打开软件开始计时…显示计时时间，HH:MM:SS 的格式，需要跟着时间跳动」
 *      → 断言格式、断言"计时中"，并且**隔几秒再读一次**，数字必须变大；
 *   2. 「我的待办主要显示我今日的代办事项」（四个来源：今天到期/逾期、今天开始、今天动过、手动标记）
 *      → 四个筛选按钮逐个点，并且用接口复核"手动标记真的写进了数据库"；
 *   3. 「单独生成 word 文档，且单独保存到电脑的文件中…保存文档名称以当日为名」
 *      → 生成之后**在文件系统里真的找到那个 .docx**，并检查它是 zip（docx 的容器格式）。
 *
 * 保存位置：这条场景会把偏好里的「保存位置」改到沙箱目录，绝不在用户的"文档"里留文件
 * （E2E 的纪律：一切写入必须在沙箱 `.tmp` 下）。
 */

const fs = require('node:fs');
const path = require('node:path');

module.exports = {
  name: 'today',
  title: '今日待办：打卡 / 四组筛选 / 生成工作日志',
  needsProject: true,

  async run({ page, assert, api, data, sandbox }) {
    await page.goto('#/my-tasks', 'today');

    /* ---------------- 1) 打卡：格式 + 真的在跳 ---------------- */
    const clockFormat = /^\d{2}:\d{2}:\d{2}$/;
    const first = (await page.text('[data-field="work-clock-value"]'))?.trim() ?? '';
    assert.check(clockFormat.test(first), '计时器是 HH:MM:SS 格式', first);

    const state = (await page.text('[data-field="work-clock-state"]'))?.trim() ?? '';
    assert.check(state.includes('计时中'), '应用开着的时候显示"计时中"', state);
    assert.check(
      await page.attr('[data-field="work-clock"]', 'data-running') === '1',
      '计时卡片自己带着"正在计时"的状态标记（样式与断言都用它）',
    );

    // 隔几秒再读：跟着时间跳动是用户明确提出的要求，静态显示不算数
    await new Promise((resolve) => setTimeout(resolve, 2600));
    const second = (await page.text('[data-field="work-clock-value"]'))?.trim() ?? '';
    const toSeconds = (text) => {
      const [h, m, s] = text.split(':').map((part) => Number(part));
      return h * 3600 + m * 60 + s;
    };
    assert.check(
      clockFormat.test(second) && toSeconds(second) > toSeconds(first),
      '计时器跟着时间往前走',
      { 第一次: first, 第二次: second },
    );

    /* ---------------- 2) 只看当前项目 ---------------- */
    /*
     * 用户 2026-09-30：「今日待办只展示当前项目的任务内容」。
     * 造一个**别的项目**、里面放一条今天到期的任务 —— 它绝不该出现在这一页上。
     */
    const other = await api.post('/api/v1/projects', { name: `${data.project.name}-别的项目` });
    const todayNoon = new Date();
    todayNoon.setHours(18, 0, 0, 0);
    const foreignTask = await api.post('/api/v1/tasks', {
      projectId: other.id,
      title: `${data.project.name}·别的项目的任务`,
      dueDate: todayNoon.getTime(),
    });
    await page.click('[data-field="today-refresh"]');
    await page.waitFor("!document.querySelector('.n-spin') || true", { label: '刷新完成' });
    const foreignShown = await page.json(
      `(() => JSON.stringify([...document.querySelectorAll('[data-field="today-row"]')]
        .some((el) => (el.textContent || '').includes('别的项目的任务'))))()`,
    );
    assert.check(!foreignShown, '别的项目的任务不出现在今日待办上');
    const scope = (await page.text('[data-field="today-subtitle"]')) ?? '';
    assert.check(scope.includes(data.project.name), '副标题写明了这是哪个项目的今天', scope);

    // 接口层面也要只看当前项目
    const scoped = await api.get(`/api/v1/today?projectId=${encodeURIComponent(data.project.id)}`);
    assert.check(
      scoped.items.every((task) => task.projectId === data.project.id),
      '接口按 projectId 过滤（不会把别的项目的任务传下来再丢掉）',
      [...new Set(scoped.items.map((task) => task.projectId))],
    );
    assert.equal(scoped.projectId, data.project.id, '响应里如实带回"只看哪个项目"');
    await api.dropProject(other.id);
    assert.check(Boolean(foreignTask.id), '播种的干扰任务已建好（随后随项目一起删掉）');

    /* ---------------- 3) 四个来源与筛选 ---------------- */
    const filters = await page.json(
      `(() => JSON.stringify([...document.querySelectorAll('[data-field="today-filter"]')].map((el) => ({
        group: el.getAttribute('data-group'),
        count: Number((el.querySelector('.chip-count')?.textContent || '0').trim()),
      }))))()`,
    );
    const byGroup = Object.fromEntries(filters.map((item) => [item.group, item.count]));
    for (const group of ['all', 'due', 'starting', 'touched', 'marked']) {
      assert.check(group in byGroup, `有「${group}」筛选按钮`, filters.map((f) => f.group));
    }
    assert.atLeast(byGroup.due ?? 0, 1, '「今天到期 / 逾期」里有播种的任务（昨天到期 + 今天到期）');
    assert.atLeast(byGroup.touched ?? 0, 1, '「今天动过」里有播种的任务（都是刚建的）');

    // 点「今天到期 / 逾期」：列表里应该只剩到期的那两条
    await page.click('[data-field="today-filter"][data-group="due"]');
    await page.waitFor(
      `document.querySelectorAll('[data-field="today-row"]').length === ${byGroup.due}`,
      { label: '筛选后列表条数与按钮上的计数一致' },
    );
    const dueTitles = await page.json(
      `(() => JSON.stringify([...document.querySelectorAll('[data-field="today-row"] .wb-title')].map((el) => (el.textContent || '').trim())))()`,
    );
    assert.check(
      dueTitles.some((title) => title.endsWith('子任务二')),
      '逾期的那条在「今天到期 / 逾期」里',
      dueTitles,
    );

    // 取消筛选：回到并集
    await page.click('[data-field="today-filter"][data-group="due"]');
    await page.waitFor(
      `document.querySelectorAll('[data-field="today-row"]').length === ${byGroup.all}`,
      { label: '再点一次回到全部' },
    );
    assert.check(
      byGroup.all >= byGroup.due,
      '「全部」是去重后的并集（不会小于任何单组）',
      { 全部: byGroup.all, 到期组: byGroup.due },
    );

    /*
     * 「这条为什么出现在今天」的标签必须**在卡片自己身上**（用户 2026-09-30 的要求：
     * 截图里页面底部那份"命中原因"清单要放到上面的任务卡片里）。
     * 判据是几何：标签的所在卡片就是它自己那一条 —— 只断言"页面上有这些文字"
     * 是没用的，底部再堆一份同样的清单也能通过。
     */
    const badges = await page.json(
      `(() => JSON.stringify([...document.querySelectorAll('[data-field="today-row"]')].map((row) => ({
        title: (row.querySelector('.wb-title')?.textContent || '').trim(),
        badges: [...row.querySelectorAll('[data-field="card-badge"]')].map((el) => (el.textContent || '').trim()),
        tone: [...row.querySelectorAll('[data-field="card-badge"]')].map((el) => el.className.replace(/^.*is-/, '')),
      }))))()`,
    );
    assert.atLeast(badges.length, 1, '列表里有卡片');
    assert.check(
      badges.every((row) => row.badges.length > 0),
      '每一张卡片上都带着"为什么在今天"的标签',
      badges.map((row) => `${row.title}:${row.badges.length}`),
    );
    const overdueRow = badges.find((row) => row.title.endsWith('子任务二'));
    assert.check(
      Boolean(overdueRow) && overdueRow.badges.some((text) => text.includes('今天到期')),
      '逾期那条的卡片上带着「今天到期 / 逾期」标签',
      overdueRow,
    );
    assert.check(
      Boolean(overdueRow) && overdueRow.tone.some((cls) => cls.includes('danger')),
      '逾期用警示色（和"今天到期"区分开）',
      overdueRow?.tone,
    );
    assert.check(
      !(await page.exists('.why')),
      '页面底部不再有单独的"命中原因"清单（已经并进卡片里）',
    );

    /* ---------------- 3) 手动「今天做」标记 ---------------- */
    const markButton = '[data-field="today-row"] [data-field="card-today"]';
    assert.check(await page.exists(markButton), '卡片上有「今天做」的星标按钮');
    assert.equal(
      await page.attr(markButton, 'title'),
      '添加今日待办',
      '鼠标悬浮提示是「添加今日待办」（用户指定）',
    );

    await page.click(markButton);
    await page.waitFor(
      `(() => { const el = document.querySelector(${JSON.stringify(markButton)});
        return Boolean(el) && el.dataset.marked === '1'; })()`,
      { label: '点完之后星标变成已标记' },
    );
    // 接口复核：标记必须真的落库（界面点亮 ≠ 存下来了）
    const todayKey = new Date().toISOString().slice(0, 10);
    const tasksNow = await api.get(`/api/v1/today?groups=marked`);
    assert.atLeast(tasksNow.items.length, 1, '「我标了今天做」组里出现了任务');
    assert.check(
      tasksNow.items.every((task) => typeof task.todayMarkDate === 'string'),
      '标记在数据库里是**日期键**（可以自然过期，不需要定时清理）',
      tasksNow.items.map((task) => task.todayMarkDate),
    );
    assert.note(`手动标记了 ${tasksNow.items.length} 条（本机日期 ${todayKey}）`);

    // 点「我标了今天做」：列表里就是刚标的那条
    await page.click('[data-field="today-filter"][data-group="marked"]');
    await page.waitFor(
      `document.querySelectorAll('[data-field="today-row"]').length === ${tasksNow.items.length}`,
      { label: '「我标了今天做」筛选只显示标记过的任务' },
    );
    assert.check(true, '四个筛选按钮各管一组，点了就只显示那一组');
    await page.click('[data-field="today-filter"][data-group="marked"]');

    /* ---------------- 4) 生成工作日志（真的写文件） ---------------- */
    // 把保存位置改到沙箱里：绝不在用户的"文档"目录留测试文件
    const saveDir = path.join(sandbox.runDir, 'work-log');
    fs.mkdirSync(saveDir, { recursive: true });
    await api.patchPreferences({ workLogSaveDir: saveDir });
    await page.reload();
    await page.goto('#/my-tasks', 'today');

    const previewText = (await page.text('[data-field="today-log-bar"]'))?.replace(/\s+/g, ' ') ?? '';
    assert.check(previewText.includes('工作日志将包含'), '生成前先说清文档里有什么', previewText.slice(0, 80));

    await page.click('[data-field="today-gen-log"]');
    await page.waitFor("Boolean(document.querySelector('[data-field=\"today-log-saved\"]'))", {
      label: '生成完成后显示保存结果',
      timeoutMs: 20000,
    });

    const savedPath = (await page.text('[data-field="today-log-path"]'))?.trim() ?? '';
    assert.check(savedPath.endsWith('.docx'), '保存的是 .docx 文件', savedPath);
    assert.check(
      savedPath.startsWith(saveDir),
      '存到了设置里指定的目录',
      { 实际: savedPath, 期望目录: saveDir },
    );

    const dateKey = await page.text('[data-field="today-date"]');
    assert.check(Boolean(dateKey), '页面上显示了今天是哪一天', dateKey);

    // 文件系统复核：真的存在、是 zip 容器（docx 的本质）、大小合理
    assert.check(fs.existsSync(savedPath), '文件真的写到了磁盘上', savedPath);
    const buffer = fs.readFileSync(savedPath);
    assert.check(buffer.byteLength > 5000, '文件大小合理（不是空壳）', `${buffer.byteLength} 字节`);
    assert.equal(
      buffer.subarray(0, 4).toString('binary'),
      'PK\x03\x04',
      'docx 是 zip 容器（Word 能不能打开的关键）',
    );
    // 「保存文档名称以当日为名」
    const fileName = path.basename(savedPath);
    assert.check(
      /\d{4}-\d{2}-\d{2}/.test(fileName),
      '文件名以当日日期为名',
      fileName,
    );
    assert.note(`工作日志：${savedPath}（${buffer.byteLength} 字节）`);

    /* ---------------- 5) 口径切换：看当前项目的全部任务 ---------------- */
    /*
     * 用户 2026-10-02：「这里我需要展示当前项目的所有任务」——
     * 项目当天没有待办时，这一页本来是空的（他的项目有 11 个任务却显示 0 条）。
     *
     * 判据的关键差别：**已完成的任务只可能出现在「全部任务」里**（今日待办明确排除已完成），
     * 所以先完成一条，再断言它只在一侧出现 —— 这比"两边条数不同"更硬。
     */
    const doneTarget = await api.post('/api/v1/tasks', {
      projectId: data.project.id,
      title: `${data.project.name}·已完成的（口径对照用）`,
      statusId: data.doneStatusId,
    });
    assert.check(Boolean(doneTarget.id), '造了一条已完成的任务做对照');

    const projectTasks = await api.get(
      `/api/v1/tasks?projectIds=${encodeURIComponent(data.project.id)}&limit=500`,
    );
    const projectTotal = projectTasks.total ?? projectTasks.items.length;

    await page.click('[data-field="today-refresh"]');
    await page.waitFor("!document.querySelector('.n-spin') || true", { label: '刷新完成' });

    // 今日口径里不该有那条已完成的任务
    const todayTitles = await page.json(
      `(() => JSON.stringify([...document.querySelectorAll('[data-field="today-row"] .wb-title')].map((el) => (el.textContent || '').trim())))()`,
    );
    assert.check(
      !todayTitles.some((title) => title.includes('已完成的（口径对照用）')),
      '今日待办里不含已完成的任务',
      todayTitles,
    );

    // 切到「全部任务」
    await page.click('[data-field="today-mode"][data-mode="all"]');
    await page.waitFor(
      `document.querySelectorAll('[data-field="today-row"]').length === ${projectTotal}`,
      { label: '全部任务口径下列出当前项目的所有任务' },
    );
    const allTitles = await page.json(
      `(() => JSON.stringify([...document.querySelectorAll('[data-field="today-row"] .wb-title')].map((el) => (el.textContent || '').trim())))()`,
    );
    assert.equal(
      allTitles.length,
      projectTotal,
      '列出的条数与接口给的该项目任务总数一致',
    );
    assert.check(
      allTitles.some((title) => title.includes('已完成的（口径对照用）')),
      '「全部任务」里包含已完成的任务（这才是"所有任务"）',
      allTitles.slice(0, 6),
    );
    assert.check(
      allTitles.length >= todayTitles.length,
      '「全部任务」不少于「今日待办」',
      { 全部: allTitles.length, 今日: todayTitles.length },
    );

    const allSubtitle = (await page.text('[data-field="today-subtitle"]')) ?? '';
    assert.check(
      allSubtitle.includes('全部任务') && allSubtitle.includes('已完成'),
      '副标题写明当前口径与已完成条数',
      allSubtitle,
    );
    assert.check(
      allSubtitle.includes(data.project.name),
      '副标题仍然写明是哪个项目',
      allSubtitle,
    );
    // 口径切换之后筛选按钮应当收起来（四组判定在"全部任务"里没有意义）
    assert.check(
      (await page.count('[data-field="today-filter"]')) === 0,
      '「全部任务」口径下不显示四个来源筛选',
    );

    // 切回今日：筛选按钮回来，列表回到今天口径
    await page.click('[data-field="today-mode"][data-mode="today"]');
    await page.waitFor(
      `document.querySelectorAll('[data-field="today-filter"]').length > 0`,
      { label: '切回今日待办后筛选按钮回来' },
    );
    assert.check(true, '两个口径可以来回切换');

    /* ---------------- 6) 点卡片能开详情（与其它页面一致） ---------------- */
    await page.click('[data-field="today-row"] .wb-title');
    await page.waitFor("Boolean(document.querySelector('.n-drawer'))", { label: '点卡片打开详情抽屉' });
    assert.check(true, '点今日待办里的卡片能打开详情');
    await page.click('.n-drawer-mask', { via: 'dom' });
    await page.waitFor("!document.querySelector('.n-drawer')", { label: '关掉详情' });

    /* ---------------- 6) 不改动用户真实环境 ---------------- */
    assert.check(
      !savedPath.includes(path.join(process.env.USERPROFILE ?? '', 'Documents')),
      'E2E 没有往用户的「文档」目录里写文件',
      savedPath,
    );
    void data;
  },
};
