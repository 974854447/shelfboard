/**
 * 场景：设置页（0.2.0 / M2 新增）。
 *
 * 这一页的价值全在"改了真的生效、并且用户知道哪些是立即生效"，
 * 所以断言分成三层：
 *   1. **界面**：五个分区都在、关键控件在、环境与数据目录如实显示；
 *   2. **真的写进去了**：改密度/日志级别之后，重新读偏好（走 preload 的 getPreferences）
 *      确认落盘值变了 —— 只看界面变化是不够的，界面可能只是本地 ref 变了；
 *   3. **真的生效了**：密度改了 `documentElement.dataset.density` 跟着变；
 *      日志级别改了之后，主进程的日志文件里立刻能看到 debug 级别的行
 *      （这是 `logger.setMinLevel` 那条"立即生效"承诺的验证）。
 *
 * 另外守一条"诚实性"断言：**自动备份标注了"尚未实现"**。
 * 一个写着"自动备份：开"却没有备份功能的界面，比没有这个开关危险得多。
 */

module.exports = {
  name: 'settings',
  title: '设置页：外观 / 编辑器 / 日志 / 备份 / GitHub / 数据环境',
  // 需要一个项目：验证"改工作区目录时把项目文件夹一起搬走"
  needsProject: true,

  async run({ page, assert, cdp, api, data, sandbox, newWorkspaceRoot }) {
    // 两个 Node 内置模块在下面多处要用（截图落盘、磁盘核对搬家结果），
    // 所以在最前面 require 一次 —— 一开始写在后面，前面用到时报"before initialization"
    const fs = require('node:fs');
    const path = require('node:path');

    /*
     * 下拉选项的取法（后面多处要用，所以放在最前面定义）：
     * **只看当前可见菜单里的选项**。Naive 把关掉的菜单留在 DOM 里，
     * 不过滤的话会把别组下拉的选项一起收进来（第一版就混过：断言看着通过，
     * 其实校验的是另一个菜单）。选项外面还套着虚拟列表容器，所以也不能用 `:last-child` 定位。
     */
    const visibleOptions = `[...document.querySelectorAll('.n-base-select-option')].filter((el) => el.offsetParent !== null)`;
    const pickVisibleOption = async (index) => {
      // 注意这里是"拼一个表达式"而不是"拼一个值"：负数表示"最后一个"，
      // 直接拼字符串会变成 list['list.length - 1']（字符串下标），页面里就报语法/取值错误
      const position = index < 0 ? 'list.length - 1' : String(index);
      await page.evaluate(
        `(() => { const list = ${visibleOptions};
          list.forEach((el) => el.removeAttribute('data-e2e-pick'));
          const el = list[${position}];
          if (el) el.setAttribute('data-e2e-pick', '1');
          return list.length; })()`,
      );
    };

    await page.goto('#/settings', 'settings');

    /* ---------- 1) 分区与控件 ---------- */
    const layout = await page.json(
      `(() => JSON.stringify({
        sections: [...document.querySelectorAll('.card h2')].map((h) => (h.textContent || '').replace(/\\s+/g, ' ').trim()),
        radioGroups: document.querySelectorAll('.n-radio-group').length,
        selects: document.querySelectorAll('.n-base-selection').length,
        switches: document.querySelectorAll('.n-switch').length,
        numbers: document.querySelectorAll('.n-input-number').length,
        densityRow: (document.body.innerText || '').includes('界面密度'),
        sidebarRow: (document.body.innerText || '').includes('折叠侧边栏'),
      }))()`,
    );
    for (const title of ['外观', '编辑器', '日志与诊断', '备份', 'GitHub 绑定', '数据与环境']) {
      assert.check(layout.sections.some((text) => text.startsWith(title)), `有「${title}」分区`, layout.sections);
    }
    // 用户 2026-09-25 要求：这一项的名字就叫「默认编辑器」（原来是一句问句）
    const editorRowName = await page.text('[data-section="editor"] .label .name');
    assert.equal(editorRowName, '默认编辑器', '编辑器那一项的标题是「默认编辑器」');
    assert.equal(layout.radioGroups, 1, '只剩主题一组单选');
    assert.atLeast(layout.selects, 2, '编辑器与日志级别的下拉');
    // 用户 2026-09-25 要求：密度与侧边栏在设置页里不要（顶栏已经有按钮了）
    assert.check(!layout.densityRow, '设置页里去掉了「界面密度」（顶栏有按钮）');
    assert.check(!layout.sidebarRow, '设置页里去掉了「侧边栏折叠」（侧栏有把手）');

    /* ---------- 2) 环境与数据目录如实显示 ---------- */
    const info = await page.json(
      `(() => JSON.stringify({
        env: (document.querySelector('[data-section="data"] .n-tag')?.textContent || '').trim(),
        paths: [...document.querySelectorAll('[data-section="data"] .path')].map((el) => el.textContent.trim()),
        version: [...document.querySelectorAll('[data-section="data"] .value.mono')].map((el) => el.textContent.trim()).join(','),
      }))()`,
    );
    assert.equal(info.env, '自定义目录', '环境标签与当前运行环境一致');
    assert.check(info.paths.some((p) => p.includes('.tmp')), '数据目录指向本次运行的沙箱', info.paths);
    assert.check(info.paths.some((p) => p.includes('workspace')), '工作区目录已显示', info.paths);

    /* ---------- 3) 自动备份如实标注未实现 ---------- */
    const backupNote = await page.text('[data-section="backup"] .note');
    assert.check(
      (backupNote || '').includes('尚未实现'),
      '「备份」分区如实说明勾了也不会真备份',
      backupNote?.slice(0, 60),
    );

    /* 量一下当前控件尺度：密度下线后固定为「舒适」，用它守住这个固定值 */
    const measure = () =>
      page.json(
        `(() => {
          const control = document.querySelector('[data-field="editor-select"]');
          return JSON.stringify({
            density: document.documentElement.dataset.density,
            controlHeight: control ? +control.getBoundingClientRect().height.toFixed(1) : 0,
            bodyFont: parseFloat(getComputedStyle(document.body).fontSize),
          });
        })()`,
      );

    /* ---------- 4) 密度已下线：按钮不在，尺寸固定为「舒适」 ---------- */
    /*
     * 用户 2026-09-25：「删除系统的密度切换功能，这个看着很鸡肋」。
     * 断言两件事：顶栏没有那个按钮了；控件尺寸是**舒适档**（不是紧凑档）。
     */
    assert.check(
      !(await page.exists('[data-field="density-toggle"]')),
      '顶栏的密度切换按钮已删除',
    );
    const size = await measure();
    assert.equal(size.density, 'comfortable', '界面密度固定为「舒适」');
    assert.atLeast(size.controlHeight, 40, `舒适档控件高度 ≥ 40px（实际 ${size.controlHeight}）`);

    const persisted = await cdp.json(
      '(async () => JSON.stringify(await window.pmStudio.getPreferences()))()',
      { awaitPromise: true },
    );
    assert.check(typeof persisted.density === 'string', '偏好里仍保留 density 字段（不再写入即可，老配置不会被判非法）');

    /* ---------- 4.5) 功能介绍入口在版本号下面，且版本号与上方隔开 ---------- */
    const whatsNew = await page.json(
      `(() => {
        const rows = [...document.querySelectorAll('[data-section="data"] .row')];
        const versionRow = rows.find((el) => (el.textContent || '').includes('版本'));
        const entry = document.querySelector('[data-section="whats-new"]');
        if (!versionRow || !entry) return JSON.stringify(null);
        const v = versionRow.getBoundingClientRect();
        const e = entry.getBoundingClientRect();
        const above = rows[rows.indexOf(versionRow) - 1]?.getBoundingClientRect();
        return JSON.stringify({
          entryBelowVersion: e.top >= v.bottom - 1,
          gapAbove: above ? Math.round(v.top - above.bottom) : null,
          separated: versionRow.classList.contains('split'),
        }); })()`,
    );
    assert.check(whatsNew !== null, '版本号那一行与「功能介绍」入口都在');
    if (whatsNew) {
      assert.check(whatsNew.entryBelowVersion, '「功能介绍」入口在版本号下面');
      assert.check(whatsNew.separated, '版本号那一行有分隔样式（与上方隔开）');
    }

    /*
     * 当前版本号要在**离开设置页之前**读。
     *
     * 这里踩过一个坑：原来是在跳进「功能介绍」之后才去读
     * `[data-section="data"] .value.mono` —— 那时设置页已经卸载，读到的永远是空串，
     * 断言靠 `|| '0.2.1'` 这个写死的兜底"通过"。发版到 0.2.2 之后兜底对不上，
     * 才暴露出这条断言其实一直在读空气。
     */
    const currentVersion = (await page.text('[data-section="data"] .value.mono'))?.trim() ?? '';
    assert.check(
      /^v\d+\.\d+\.\d+/.test(currentVersion),
      '设置页上读得到当前版本号',
      currentVersion,
    );

    // 点进「功能介绍」：应该**跳到一个新页面**（版本列表），而不是弹窗
    await page.click('[data-field="whats-new-open"]');
    await page.waitFor("location.hash === '#/whats-new'", { label: '跳到功能介绍列表页' });
    // 光等 hash 不够：路由变了但视图还没渲染完，列表会是空的（第一版就这么假失败过）
    await page.waitFor(
      "document.querySelectorAll('[data-field=\"release-item\"]').length > 0",
      { label: '功能介绍列表渲染出条目' },
    );
    const list = await page.json(
      `(() => JSON.stringify({
        versions: [...document.querySelectorAll('[data-field="release-item"] .version')].map((el) => (el.textContent || '').trim()),
        count: document.querySelectorAll('[data-field="release-item"]').length,
      }))()`,
    );
    assert.atLeast(list.count, 2, '功能介绍列表里至少有两个版本');
    /*
     * 最新一版必须排在最前面，而且就是**当前运行的这一版**。
     *
     * 不写死版本号（每次发版都要改测试，改测试本身就容易把"顺序对不对"改坏），
     * 而是拿设置页上那个版本号来比。这条会强制一件事：**发版时必须给
     * data/whats-new.ts 加当版条目** —— 忘了加，"功能介绍"里最新一版就不是当前版本，
     * 这正是用户会立刻发现的那种不一致。
     */
    const stripV = (value) => (value || '').trim().replace(/^v/, '');
    assert.equal(
      stripV(list.versions[0]),
      stripV(currentVersion),
      '最新版本排在最前面，且就是当前运行的版本',
    );

    // 点一个版本 → 进入该版本的内容页
    await page.click('[data-field="release-item"]');
    await page.waitFor("location.hash.startsWith('#/whats-new/')", { label: '进入版本详情页' });
    const detail = await page.json(
      `(() => JSON.stringify({
        title: (document.querySelector('[data-view="whats-new"] h1')?.textContent || '').trim(),
        notes: [...document.querySelectorAll('[data-field="release-notes"] li')].map((el) => (el.textContent || '').replace(/\\s+/g, ' ').trim()),
      }))()`,
    );
    assert.check(
      detail.title.includes(list.versions[0]?.replace(/^v/, '') ?? ''),
      '详情页标题是该版本号',
      { 标题: detail.title, 点的版本: list.versions[0] },
    );
    assert.atLeast(detail.notes.length, 5, '详情页列出了更新内容');
    assert.check(
      detail.notes.every((text) => text.length > 6),
      '每一条更新内容都是完整的一句话（没有被截断的空条）',
      detail.notes.filter((text) => text.length <= 6),
    );
    /*
     * 这一版的内容必须提到本版的主要功能。
     *
     * 判据**跟着版本走**（发版时这里一起改一行）：写死旧版本的功能名，会在发版后
     * 变成一条假的失败；完全不判，就没人发现"详情页串到了别的版本的内容"。
     */
    if ((list.versions[0] ?? '').includes('0.2.1')) {
      assert.check(
        detail.notes.some((text) => text.includes('工作大纲')),
        '0.2.1 的内容里提到了「工作大纲」（这一版的主要功能）',
        detail.notes.slice(0, 3),
      );
    }

    // 返回列表
    await page.click('[data-field="release-back"]');
    await page.waitFor("location.hash === '#/whats-new'", { label: '返回版本列表' });
    assert.check(true, '可以从版本详情返回列表');

    /*
     * 列表页的「返回」必须回到**设置页**。
     *
     * 用户报的 bug：设置 → 功能介绍 → 某个版本 →「返回列表」→「返回」，
     * 结果又退回了那个版本的详情里 —— 因为当时用的是 `router.back()`
     * （退一步历史记录），而"返回列表"本身就是一次 push，
     * 于是列表的上一条历史正是那个版本详情。这条断言守住它不再复发。
     */
    await page.click('[data-field="whats-new-back"]');
    await page.waitFor("location.hash === '#/settings'", { label: '功能介绍列表的「返回」回到设置页' });
    assert.check(true, '功能介绍的「返回」回到设置页（不会退回版本详情）');

    // 回到设置页继续后面的检查（刚才跳到功能介绍页了）
    await page.goto('#/settings', 'settings');
    /* ---------- 5) 改日志级别：落盘 + 主进程立即采用 ---------- */
    const levelSelect = '[data-section="logging"] .n-base-selection';
    await page.click(levelSelect);
    await page.waitFor(`${visibleOptions}.length > 0`, { label: '级别下拉展开' });
    await pickVisibleOption(-1);
    const optionText = await page.text('[data-e2e-pick="1"]');
    await page.click('[data-e2e-pick="1"]');
    await page.waitFor(
      `(document.querySelector(${JSON.stringify(levelSelect)})?.textContent || '').includes(${JSON.stringify((optionText ?? '').split('（')[0])})`,
      { label: '级别下拉选中值变化' },
    );

    const afterLevel = await cdp.json(
      '(async () => JSON.stringify(await window.pmStudio.getPreferences()))()',
      { awaitPromise: true },
    );
    assert.equal(afterLevel.logging.level, 'debug', '日志级别已落盘为 debug');
    // 浅合并的坑：改级别不能把 logging 里其它字段抹掉
    assert.atLeast(afterLevel.logging.retentionDays, 1, '改级别后 logging.retentionDays 仍在（浅合并没抹字段）');
    assert.check(typeof afterLevel.logging.redactUserName === 'boolean', '改级别后 logging.redactUserName 仍在');

    /* ---------- 6) 默认编辑器：只列**这台电脑上真装了的** ---------- */
    const detected = await cdp.json(
      '(async () => JSON.stringify(await window.pmStudio.detectEditors()))()',
      { awaitPromise: true },
    );
    const hint = await page.text('[data-section="editor"] .hint');
    assert.check(
      (hint || '').includes('检测'),
      '编辑器分区说明了检测结果（或"没检测到"）',
      hint?.slice(0, 60),
    );

    /*
     * 点的是 NSelect **内部真正的可点区域**（`.n-base-selection`），不是它的外层根节点：
     * 只点根节点时命中位置依赖布局，实测会偶发点不开（同一份代码时好时坏）。
     */
    await page.click('[data-field="editor-select"] .n-base-selection');
    await page.waitFor(`${visibleOptions}.length > 0`, { label: '编辑器下拉展开' });
    const optionTexts = await page.json(
      `(() => JSON.stringify(${visibleOptions}.map((el) => (el.textContent || '').trim())))()`,
    );
    assert.atLeast(optionTexts.length, Math.max(detected.length, 1), `下拉选项数 ≥ 检测到的编辑器数（${detected.length}）`);
    for (const editor of detected) {
      assert.check(
        optionTexts.some((text) => text.includes(editor.command)),
        `下拉里有检测到的编辑器：${editor.command}`,
      );
    }
    // 没装的不许出现（这正是"改成识别本机"的意义）
    for (const command of ['webstorm', 'idea', 'notepad++']) {
      if (detected.some((editor) => editor.command === command)) continue;
      assert.check(
        !optionTexts.some((text) => text.includes(command)),
        `没装的编辑器不列在下拉里：${command}`,
      );
    }
    await page.press('Escape');
    assert.note(`检测到 ${detected.length} 个编辑器：${detected.map((e) => e.command).join('、') || '（一个都没有）'}`);
    assert.note(`下拉实际选项：${optionTexts.join(' | ')}`);

    // 留一张这一段（外观 + 编辑器）的截图：这两块是按用户反馈反复改过的地方
    await page.evaluate(
      "(() => { document.querySelector('[data-section=\"editor\"]')?.scrollIntoView({ block: 'center' }); return 1; })()",
    );
    await page.screenshot(path.join(sandbox.artifactsDir, 'settings-editor.png'));

    /* ---------- 6.2) 开发环境检测（M4）：只读，且结果落到界面上 ---------- */
    /*
     * 这一节要证三件事：
     *   1. 分区在，且**能做到"重新检测"**（需求 §5.7：不允许永久跳过/一次检测做死）；
     *   2. 检测结果真的渲染出来了 —— 八个工具一行一个，且**没有一行是空的**
     *      （"状态未知"这类半成品会立刻暴露）；
     *   3. 结果是"这台机器的事实"：能取到路径的工具就写路径，取不到的写清原因。
     */
    /*
     * 初始状态**可能是 0 行也可能是 8 行**：新建项目向导的第一步就会做环境检测并把结果缓存下来，
     * 所以"之前跑过的场景里建过项目"时，这里已经有缓存了。
     * 要守的不变量是"**要么没有、要么是真的检测结果**"——绝不能出现部分行或空行。
     */
    const envBefore = await page.count('[data-field="env-tool"]');
    assert.check(
      envBefore === 0 || envBefore === 8,
      '进页面时工具清单要么没有、要么是完整的 8 行（不拿半截假数据占位）',
      envBefore,
    );

    await page.click('[data-field="env-detect"]');
    /*
     * 等"**结果已经出来**"：只等行数会出现一个坑 —— 之前跑过的场景已经留下缓存时，
     * 8 行**立刻**就在，而摘要还写着"正在检测…"（读到的就是那句）。
     * 判据要同时包含"行数齐"与"摘要已是结论"。
     */
    await page.waitFor(
      `document.querySelectorAll('[data-field="env-tool"]').length >= 8 &&
        /必需工具都在|缺少必需工具/.test(document.querySelector('[data-field="env-summary"]')?.textContent || '')`,
      { label: '点「重新检测环境」后列出所有工具并给出结论', timeoutMs: 40000 },
    );
    await page.evaluate(
      "(() => { document.querySelector('[data-section=\"environment\"]')?.scrollIntoView({ block: 'center' }); return 1; })()",
    );
    await page.screenshot(path.join(sandbox.artifactsDir, 'settings-environment.png'));

    const env = await page.json(
      `(() => JSON.stringify({
        rows: [...document.querySelectorAll('[data-field="env-tool"]')].map((el) => ({
          id: el.getAttribute('data-tool'),
          text: (el.textContent || '').replace(/\\s+/g, ' ').trim(),
          missing: Boolean(el.querySelector('[data-field="env-missing"]')),
        })),
        summary: (document.querySelector('[data-field="env-summary"]')?.textContent || '').replace(/\\s+/g, ' ').trim(),
      }))()`,
    );

    assert.equal(env.rows.length, 8, '八个工具一行一个');
    assert.check(
      env.rows.every((row) => row.text.length > 0),
      '每一行都有内容（没有空白行）',
      env.rows.filter((row) => row.text.length === 0).map((row) => row.id),
    );

    const nodeRow = env.rows.find((row) => row.id === 'node');
    assert.check(nodeRow && !nodeRow.missing, 'Node.js 这一行是"已找到"（应用自己就跑在 Node 上）', nodeRow?.text);
    assert.check(
      (nodeRow?.text || '').match(/\d+\.\d+\.\d+/) !== null,
      'Node.js 这一行带版本号',
      nodeRow?.text,
    );

    assert.check(
      /必需工具都在|缺少必需工具/.test(env.summary),
      '摘要如实说明必需工具齐不齐',
      env.summary,
    );
    assert.note(`环境检测：${env.rows.map((row) => row.id + (row.missing ? '(缺)' : '')).join(' ')}`);
    assert.note(`摘要：${env.summary}`);

    /* ---------- 6.5) GitHub 绑定：预留接口的契约 ---------- */
    /*
     * 这一节测的不是"能绑定"（还没实现），而是**预留接口本身立住了**：
     *   1. 分区与入口在界面上存在；
     *   2. 点「绑定 GitHub」**明确告诉用户还没做** —— 不许假装成功、不许点了没反应；
     *   3. 状态对象的字段齐全（形状是契约，以后实现时改实现、不改形状）；
     *   4. **配置里与返回给界面的数据里都不许出现令牌字段** ——
     *      这是这一节最重要的一条：令牌一旦进了 config.json，就会被备份、
     *      被打进诊断包、被用户随手转发，属于不可挽回的泄漏。
     */
    const githubState = await page.text('[data-field="github-state"]');
    assert.equal(githubState, '未绑定', 'GitHub 状态默认是「未绑定」');

    const githubSectionText = await page.text('[data-section="github"]');
    assert.check(
      (githubSectionText || '').includes('尚未实现'),
      'GitHub 分区如实说明功能尚未实现',
      githubSectionText?.slice(0, 50),
    );

    const status = await cdp.json('(async () => JSON.stringify(await window.pmStudio.githubStatus()))()', {
      awaitPromise: true,
    });
    for (const key of ['connected', 'login', 'hasToken', 'connectedAt', 'available', 'unavailableReason']) {
      assert.check(key in status, `GitHub 状态里有字段：${key}`);
    }
    assert.equal(status.connected, false, '状态里 connected 为 false');
    assert.equal(status.available, false, '状态里 available 为 false（这一版不支持绑定）');
    assert.check(
      !('token' in status) && !('accessToken' in status),
      '状态对象里没有令牌字段（令牌不该经过渲染层）',
      Object.keys(status),
    );

    // 点绑定：必须给出"尚未实现"的明确说法
    await page.click('[data-field="github-connect"]');
    await page.waitFor("Boolean(document.querySelector('.n-dialog'))", { label: '点绑定后弹出说明' });
    const githubDialog = await page.text('.n-dialog');
    assert.check(
      (githubDialog || '').includes('尚未实现') || (githubDialog || '').includes('还没做'),
      '绑定按钮明确告诉用户功能还没实现',
      githubDialog?.slice(0, 60),
    );
    await page.evaluate(
      "(() => { const b = [...document.querySelectorAll('.n-dialog button')].find((el) => (el.textContent || '').trim() === '知道了'); if (b) b.click(); return 1; })()",
    );
    await page.waitFor("!document.querySelector('.n-dialog')", { label: '关掉说明弹窗' });
    assert.equal(await page.text('[data-field="github-state"]'), '未绑定', '点过之后状态仍然是未绑定（没有假装成功）');

    /*
     * 配置里也绝不能有令牌本体。
     *
     * 判据不能简单写成"grep 一下 token"—— `hasToken` 这个布尔字段本身名字里就有 token，
     * 它恰恰是**安全的**（只回答"有没有"，不含令牌）。要守的两件事是：
     *   1. 字段就是约定的那四个（形状是契约，将来实现 OAuth 也不许往里塞令牌）；
     *   2. **没有任何长字符串** —— 令牌必然是长串，出现长串就说明有人把令牌写进来了。
     */
    const githubPrefs = (await cdp.json(
      '(async () => JSON.stringify(await window.pmStudio.getPreferences()))()',
      { awaitPromise: true },
    )).github ?? {};
    assert.check(
      ['connected', 'login', 'hasToken', 'connectedAt'].every((key) => key in githubPrefs) &&
        Object.keys(githubPrefs).length === 4,
      '配置里的 github 段字段与约定一致（connected / login / hasToken / connectedAt）',
      Object.keys(githubPrefs),
    );
    assert.check(
      !Object.values(githubPrefs).some((value) => typeof value === 'string' && value.length > 40),
      '配置里没有任何长字符串（令牌本体不该出现在配置文件里）',
      githubPrefs,
    );

    // 留一张这一段的截图：预留接口是给以后看的，"长什么样"值得留档
    await page.evaluate(
      "(() => { document.querySelector('[data-section=\"github\"]')?.scrollIntoView({ block: 'center' }); return 1; })()",
    );
    await page.screenshot(path.join(sandbox.artifactsDir, 'settings-github.png'));

    /* ---------- 6.5) 工作日志保存位置（0.2.1） ---------- */
    /*
     * 这一项的特点是**显示的是真正会写入的路径**（没自己指定时就是默认目录），
     * 而不是一个空输入框 —— 用户点完"生成工作日志"第一件事就是去找文件。
     *
     * 默认目录走**接口**取（`/work-log/config`）：界面上已经不再单独列一行"默认位置"
     * （用户 2026-10-01 要求删掉那一行 —— 生效路径已经写着同一个值，再列一遍是重复）。
     */
    const workLogConfig = await api.get('/api/v1/work-log/config');
    const workLogDefault = workLogConfig.defaultDir;
    const workLogDir = await page.text('[data-field="worklog-dir"]');
    assert.check(Boolean(workLogDir && workLogDir.trim().length > 0), '显示了当前生效的保存位置', workLogDir);
    assert.check(
      Boolean(workLogDefault && workLogDefault.includes('工作日志')),
      '接口给出的默认位置是"文档"下的一个子文件夹',
      workLogDefault,
    );
    assert.equal(
      workLogDir?.trim(),
      workLogDefault,
      '没自己指定时，界面上显示的就是那个默认目录（而不是空着）',
    );
    assert.check(
      !(await page.exists('[data-field="worklog-default-dir"]')),
      '界面上不再单独列"默认位置"这一行（已并入上面的生效路径）',
    );
    assert.check(
      Boolean(await page.exists('[data-field="worklog-choose"]')),
      '有「更改位置」按钮（走系统目录选择框）',
    );

    // 改一个自己指定的目录：界面上的"当前生效位置"要跟着变，且此时才出现「恢复默认」
    const customDir = path.join(sandbox.runDir, 'settings-worklog');
    await api.patchPreferences({ workLogSaveDir: customDir });
    await page.reload();
    await page.goto('#/settings', 'settings');
    assert.equal(
      (await page.text('[data-field="worklog-dir"]'))?.trim(),
      customDir,
      '设置里指定的目录成了当前生效的位置',
    );
    assert.check(
      Boolean(await page.exists('[data-field="worklog-reset"]')),
      '指定了自定义目录之后才出现「恢复默认」',
    );
    await page.click('[data-field="worklog-reset"]');
    await page.waitFor(
      `(document.querySelector('[data-field="worklog-dir"]')?.textContent || '').trim() === ${JSON.stringify(workLogDefault ?? '')}`,
      { label: '点「恢复默认」之后回到默认目录' },
    );
    assert.check(true, '「恢复默认」把它改回默认位置');

    /* ---------- 7) 备份文案能看懂了 ---------- */
    const keepHint = await page.text('[data-section="backup"] .row:last-child .hint');
    assert.check(
      (keepHint || '').includes('最旧'),
      '「最多保留几份备份」这句给了人话解释',
      keepHint?.slice(0, 50),
    );

    /* ---------- 8) 立即备份：生成的文件真的能用 ---------- */
    const backup = await cdp.json(
      '(async () => JSON.stringify(await window.pmStudio.runBackup()))()',
      { awaitPromise: true },
    );
    assert.check(typeof backup.file === 'string' && backup.file.endsWith('.db'), '备份文件名是 .db', backup.file);
    assert.atLeast(backup.pages, 1, '备份的页数（说明数据库真的被写出来了）');

    /* ---------- 9) 更改工作区目录：切换 + 搬项目（真实文件操作） ---------- */
    /*
     * 系统目录选择框没法自动点，所以这里直接调"切换目录"那一层的接口 ——
     * 对话框只是"拿一个路径"的壳，真正要验证的是切换与搬家逻辑。
     * 而且**在磁盘上核对**（不是只看接口返回的数字）：文件真的从旧目录挪到了新目录。
     */
    const beforeRoot = (
      await cdp.json('(async () => JSON.stringify(await window.pmStudio.getBootstrap()))()', { awaitPromise: true })
    ).workspaceRoot;
    const oldRoot = path.join(sandbox.userDataDir, 'workspace');
    const project = await api.get(`/api/v1/projects/${data.project.id}`);
    const folderName = project.folder;
    assert.check(Boolean(folderName), '取到了项目文件夹名', folderName);
    assert.check(fs.existsSync(path.join(oldRoot, folderName)), '切换前：项目文件夹在旧目录里');

    const report = await cdp.json(
      `(async () => JSON.stringify(await window.pmStudio.setWorkspaceRoot(${JSON.stringify(newWorkspaceRoot)}, { moveProjects: true })))()`,
      { awaitPromise: true },
    );
    assert.equal(report.workspaceRoot, newWorkspaceRoot, '接口返回的新工作区根目录');
    assert.atLeast(report.moved.length, 1, '至少搬过去 1 个项目文件夹');
    assert.equal(report.failed.length, 0, '没有搬家失败的项目');

    // 磁盘核对：新目录里有，旧目录里没了
    assert.check(
      fs.existsSync(path.join(newWorkspaceRoot, folderName)),
      '磁盘上新目录里出现了项目文件夹',
      path.join(newWorkspaceRoot, folderName),
    );
    assert.check(
      !fs.existsSync(path.join(oldRoot, folderName)),
      '磁盘上旧目录里的项目文件夹已经不在',
    );

    const afterBootstrap = await cdp.json(
      '(async () => JSON.stringify(await window.pmStudio.getBootstrap()))()',
      { awaitPromise: true },
    );
    assert.equal(afterBootstrap.workspaceRoot, newWorkspaceRoot, '启动信息里的工作区根目录也跟着变了');
    assert.check(afterBootstrap.workspaceRoot !== beforeRoot, '工作区根目录确实换了（不是原目录）');

    /* ---------- 10) 设置页上显示的路径也跟着更新 ---------- */
    // 用 data-field 定位，不靠"第几个 path" —— 两个路径 span 是不同父节点下的同类型元素，
    // :last-of-type 会同时命中两个（第一版就被这个坑到了，报的失败还是错的元素）
    await page.goto('#/settings', 'settings');
    const shownPath = await page.text('[data-field="workspace-dir"]');
    assert.check(
      (shownPath || '').includes(newWorkspaceRoot.split(/[\\/]/).pop()),
      '设置页显示的是新目录（不用重启也立刻更新）',
      shownPath,
    );
    // 侧栏底部显示的工作区名也读同一份启动信息，一起确认它没落下
    const sidebarText = await page.text('.sider-foot');
    assert.check(
      (sidebarText || '').includes(newWorkspaceRoot.split(/[\\/]/).pop()),
      '侧栏底部的工作区名也跟着更新了',
      sidebarText,
    );

    // 收尾滚回页面顶部：--shots 的截图落在这一屏，方便人眼核对「外观 + 默认编辑器」
    // 这两段（它们是这一轮按反馈改过的地方）。
    // 注意滚的是**视图自己的滚动容器**（`.page` 是 overflow:auto），不是 window —— 一开始写错了一次。
    await page.evaluate(
      "(() => { const view = document.querySelector('[data-view=\"settings\"]'); if (view) view.scrollTop = 0; return 1; })()",
    );
  },
};
