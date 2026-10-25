/**
 * 场景：工作大纲（0.2.x 把「工作台」改成的自上而下树）。
 *
 * 用户的要求是「对整个项目创建一个工作大纲」，版式选的是第 4 种：
 * 自上而下的树、正交圆角连线（见 docs/mockups/style-D.png）。
 *
 * 这条场景盯的是**只在真实布局里才会暴露的问题**：
 *   1. 根节点是项目、层级真的分层（用几何量：子节点卡片必须在父节点卡片**下方**）；
 *   2. 折叠真的把子树摘掉（不是用 CSS 藏起来 —— 藏起来的话树高不变，一屏还是那么长）；
 *   3. 增 / 改 / 删三种写入都落到数据库（改完用接口复核，不只看界面）；
 *   4. 删除走的是应用自己的确认框（Naive dialog），**不是 `window.confirm`** ——
 *      后者是原生模态框，脚本点不到，这条断言能在有人改回去时立刻失败。
 */

module.exports = {
  name: 'outline',
  title: '工作大纲：层级树与增删改',
  needsProject: true,

  async run({ page, assert, api, data }) {
    await page.goto('#/workbench', 'outline');

    /* ---------------- 1) 根节点与层级 ---------------- */
    const root = await page.text('[data-field="outline-root"]');
    assert.check(
      (root || '').includes(data.project.name),
      '根节点是当前项目',
      root,
    );

    const shape = await page.json(
      `(() => {
        const nodes = [...document.querySelectorAll('[data-field="outline-title"]')].map((el) => ({
          title: (el.textContent || '').trim(),
          depth: Number(el.closest('[data-task-id]')?.getAttribute('data-depth') ?? 0),
          top: Math.round(el.closest('.on-card').getBoundingClientRect().top),
          centerX: Math.round(el.closest('.on-card').getBoundingClientRect().left + el.closest('.on-card').getBoundingClientRect().width / 2),
          parentId: el.closest('[data-task-id]')?.getAttribute('data-task-id'),
        }));
        const rootBox = document.querySelector('[data-field="outline-root"]').getBoundingClientRect();
        const tree = document.querySelector('[data-field="outline-tree"]').getBoundingClientRect();
        return JSON.stringify({
          nodes,
          rootBottom: Math.round(rootBox.bottom),
          rootCenterX: Math.round(rootBox.left + rootBox.width / 2),
          treeLeft: Math.round(tree.left),
          treeRight: Math.round(tree.right),
          readout: (document.querySelector('[data-field="outline-readout"]')?.textContent || '').trim(),
        }); })()`,
    );

    assert.equal(shape.nodes.length, 5, '播种的 5 个任务都出现在大纲里');
    assert.check(
      shape.nodes.some((node) => node.title.endsWith('主任务')),
      '顶层有「主任务」',
      shape.nodes.map((n) => n.title),
    );

    /*
     * 层级用**几何**验证：所有节点的顶边必须在根节点卡片下方。
     * 只断言节点数量是没用的 —— 五个节点平铺在一行里也能凑够五条。
     */
    assert.check(
      shape.nodes.every((node) => node.top > shape.rootBottom),
      '所有任务节点都在根节点下方（自上而下）',
      { 根节点底边: shape.rootBottom, 节点顶边: shape.nodes.map((n) => n.top) },
    );

    const depths = [...new Set(shape.nodes.map((node) => node.depth))].sort((a, b) => a - b);
    // 数组断言用 JSON 比较：assert.equal 比的是引用，两个内容相同的数组也会判失败
    assert.check(
      JSON.stringify(depths) === '[1,2,3]',
      '树的层级是 1→2→3（主任务 → 子任务 → 孙任务）',
      depths,
    );
    assert.check(
      shape.readout.includes('5'),
      '读数里写明了节点总数',
      shape.readout,
    );

    /*
     * **标题不许被挤到换行**（用户报过两次，这里是回归守卫）。
     *
     * 两次的根因都不是"卡片太小"，而是别的东西在偷宽度：第一次是悬停操作按钮占着 83px
     * （看不见但占位），第二次是整行比视口宽时 flex 把节点压到 min-content。
     * 判据是"标题高度 ≈ 一行"，用量出来的数字而不是肉眼看截图。
     */
    const titleLines = await page.json(
      `(() => JSON.stringify([...document.querySelectorAll('[data-field="outline-title"]')].map((el) => {
        const cs = getComputedStyle(el);
        const lineHeight = parseFloat(cs.lineHeight) || 17;
        return { text: (el.textContent || '').trim(), lines: Math.round(el.getBoundingClientRect().height / lineHeight) };
      })))()`,
    );
    const wrapped = titleLines.filter((row) => row.lines > 1);
    assert.check(
      wrapped.length === 0,
      '所有节点标题都是单行（播种的标题都不长，换行就说明又被谁挤了）',
      wrapped,
    );

    /*
     * 叶子节点前面**不留空白**（用户 2026-09-30：「还是直接去掉这块空白吧，当没有子任务时」）。
     *
     * 曾经放了个和折叠箭头等宽的占位来对齐标题左缘，代价是叶子标题被顶到右边、可用宽度还少 17px。
     * 现在判据是几何：叶子卡片里标题的左缘应当只差一个卡片内边距（9px），
     * 而不是"内边距 + 折叠位"（约 31px）。
     */
    const leafLayout = await page.json(
      `(() => { const li = [...document.querySelectorAll('li.on-node')].find((el) => !el.querySelector('button.on-caret'));
        if (!li) return JSON.stringify(null);
        const card = li.querySelector('.on-card');
        const title = li.querySelector('.on-title');
        const cardR = card.getBoundingClientRect();
        const titleR = title.getBoundingClientRect();
        return JSON.stringify({
          text: (title.textContent || '').trim(),
          hasSpacer: Boolean(li.querySelector('.on-caret-space')),
          gap: Math.round(titleR.left - cardR.left),
          titleW: Math.round(titleR.width),
        }); })()`,
    );
    assert.check(Boolean(leafLayout), '树上至少有一个节点可以量');
    assert.check(!leafLayout?.hasSpacer, '没有任何"占位空位"元素了');
    assert.check(
      leafLayout.gap <= 12,
      '叶子节点的标题紧贴卡片左边（只差一个内边距，没有那块空白）',
      leafLayout,
    );
    assert.check(
      leafLayout.titleW >= 130,
      '叶子节点的标题可用宽度变大了（原来被占位挤掉 17px）',
      leafLayout.titleW,
    );

    /* ---------------- 2) 点整张卡片开详情（用户 2026-10-02 的要求）---------------- */
    /*
     * 用户原话：「点击整个标签就弹出任务详情，任务详情的按钮可以去掉，
     * 注意折叠子任务的按钮冒泡」。
     *
     * 所以这里同时守住两件事：
     *   a. 卡片上那个「详情」按钮确实没了，但**点卡片本体**照样能弹出详情；
     *   b. 卡片里的折叠按钮点完之后**不能**顺带把详情也弹出来（那是冒泡，
     *      一旦漏了 `.stop`，用户每折一次就弹一次抽屉）。
     */
    assert.equal(
      await page.count('[data-field="outline-detail"]'),
      0,
      '卡片上的「详情」按钮已经去掉',
    );

    const leafCard = await page.json(
      `(() => { const el = [...document.querySelectorAll('[data-field="outline-title"]')]
        .find((node) => (node.textContent || '').trim().endsWith('叶子任务'));
        if (!el) return JSON.stringify(null);
        const li = el.closest('[data-task-id]');
        return JSON.stringify({ title: (el.textContent || '').trim(), id: li.getAttribute('data-task-id') }); })()`,
    );
    assert.check(Boolean(leafCard), '大纲里能找到叶子任务的卡片（用来点卡片本体）');
    await page.click(`[data-task-id="${leafCard?.id}"] [data-field="outline-title"]`);
    await page.waitFor("Boolean(document.querySelector('.n-drawer'))", {
      label: '点卡片本体弹出了任务详情',
    });
    /*
     * 判据落在**详情里的内容**，不是抽屉头上那行固定文案「任务详情」——
     * 断言后者的话，点开任何一个任务都能通过。
     * 也不依赖 Naive 输入框的内部 DOM（结构会随版本变）：
     * 直接看整张抽屉里有没有出现被点那个任务的标题。
     */
    await page.waitFor(
      `((document.querySelector('.n-drawer')?.textContent) || '').includes('叶子任务')`,
      { label: '详情里显示的是被点击那个任务的标题' },
    );
    assert.check(true, '弹出的正是被点击那个任务的详情（抽屉里出现了它的标题）');
    await page.click('.n-drawer-mask', { via: 'dom' });
    await page.waitFor("!document.querySelector('.n-drawer')", { label: '关掉详情' });
    assert.check(true, '点卡片开详情、点空白关详情');

    /* ---------------- 3) 折叠真的摘掉子树 ---------------- */
    const beforeCollapse = await page.count('[data-field="outline-title"]');
    const parentNode = await page.json(
      `(() => { const el = [...document.querySelectorAll('[data-field="outline-title"]')]
        .find((node) => (node.textContent || '').trim().endsWith('主任务'));
        return JSON.stringify({ id: el.closest('[data-task-id]').getAttribute('data-task-id') }); })()`,
    );
    await page.click(`[data-field="outline-caret-${parentNode.id}"]`);
    await page.waitFor(
      `document.querySelectorAll('[data-field="outline-title"]').length < ${beforeCollapse}`,
      { label: '折叠后节点数变少' },
    );
    /*
     * 冒泡守卫（用户特意提醒过）：折叠按钮点完**不该**顺带弹出详情。
     * 判据是"抽屉不存在"，而不是"折叠生效了" —— 两件事可以同时发生。
     */
    assert.check(
      !(await page.exists('.n-drawer')),
      '点折叠按钮只折叠，没有冒泡到卡片去弹详情',
    );
    const afterCollapse = await page.count('[data-field="outline-title"]');
    assert.equal(afterCollapse, 2, '折叠主任务后只剩它自己和叶子任务（子树被摘掉）');
    assert.check(
      await page.exists('.on-hidden'),
      '折叠的节点上标明了被藏起来的子任务数',
    );

    await page.click(`[data-field="outline-caret-${parentNode.id}"]`);
    await page.waitFor(
      `document.querySelectorAll('[data-field="outline-title"]').length === ${beforeCollapse}`,
      { label: '再点一次展开回来' },
    );
    assert.check(true, '折叠 / 展开可来回切换');

    /* ---------------- 4) 在节点下新增子任务（就地输入） ---------------- */
    const childNode = await page.json(
      `(() => { const el = [...document.querySelectorAll('[data-field="outline-title"]')]
        .find((node) => (node.textContent || '').trim().endsWith('叶子任务'));
        return JSON.stringify({ id: el.closest('[data-task-id]').getAttribute('data-task-id') }); })()`,
    );
    await page.click(`[data-task-id="${childNode.id}"] [data-field="outline-add-child"]`);
    await page.waitFor("Boolean(document.querySelector('[data-field=\"outline-add-input\"]'))", {
      label: '出现子任务输入框',
    });

    /*
     * 这一行的间距要有守卫（用户 2026-09-30：「这里再调整一下间距」）。
     * 之前挤在三处：输入框内边距只有 `2px 5px`（文字贴着边框）、
     * 确认按钮比输入框矮 2px 且没对齐中线、与上一行只隔 5px（聚焦描边几乎贴上去）。
     * 判据用几何：按钮与输入框中线一致（±1px）、两者间距 ≥ 6px、输入框内边距 ≥ 3px。
     */
    const addRow = await page.json(
      `(() => { const input = document.querySelector('[data-field="outline-add-input"]');
        const btn = document.querySelector('[data-field="outline-add-commit"]');
        const ir = input.getBoundingClientRect();
        const br = btn.getBoundingClientRect();
        const cs = getComputedStyle(input);
        return JSON.stringify({
          inputH: Math.round(ir.height),
          btnH: Math.round(br.height),
          centerDelta: Math.abs((ir.top + ir.height / 2) - (br.top + br.height / 2)),
          gap: Math.round(br.left - ir.right),
          padLeft: parseFloat(cs.paddingLeft),
        }); })()`,
    );
    assert.check(addRow.centerDelta <= 1, '确认按钮与输入框在同一中线上', addRow);
    assert.check(addRow.gap >= 6, '确认按钮与输入框之间有间距', addRow.gap);
    assert.check(addRow.padLeft >= 3, '输入框内边距够（文字不贴边框）', addRow.padLeft);
    /*
     * 按钮与输入框高度接近即可（差 ≤ 2px）：输入框的外高含上下各 1px 边框，
     * 所以两者天生差 2px —— 视觉上的判据是上面那条"中线一致"。
     */
    assert.check(
      Math.abs(addRow.inputH - addRow.btnH) <= 2 && addRow.btnH >= 20,
      '确认按钮和输入框差不多高，且点击区不小于 20px',
      addRow,
    );

    const newTitle = `${data.project.name}·大纲新增`;
    await page.fill('[data-field="outline-add-input"]', newTitle);
    await page.press('Enter');
    await page.waitFor(
      `[...document.querySelectorAll('[data-field="outline-title"]')].some((el) => (el.textContent || '').trim() === ${JSON.stringify(newTitle)})`,
      { label: '新子任务出现在大纲里' },
    );

    // 落到数据库了吗？（界面显示 ≠ 存下来了）
    const tree = await api.get(`/api/v1/projects/${data.project.id}/tasks/tree`);
    const flat = [];
    const walk = (items) => {
      for (const item of items) {
        flat.push(item);
        walk(item.children ?? []);
      }
    };
    walk(Array.isArray(tree) ? tree : (tree.items ?? []));
    const created = flat.find((task) => task.title === newTitle);
    assert.check(Boolean(created), '新子任务真的写进了数据库', flat.map((t) => t.title));
    assert.equal(created?.parentId, childNode.id, '新子任务的父节点是那个叶子任务');

    /* ---------------- 5) 就地重命名 ---------------- */
    await page.click(`[data-task-id="${childNode.id}"] [data-field="outline-rename"]`);
    await page.waitFor("Boolean(document.querySelector('[data-field=\"outline-rename-input\"]'))", {
      label: '出现重命名输入框',
    });
    const renamed = `${data.project.name}·叶子改名`;
    // 重命名框里已经有原标题，所以要用**覆盖式**填入（`fill`），不能用会追加的 `type`
    await page.fill('[data-field="outline-rename-input"]', renamed);
    await page.press('Enter');
    await page.waitFor(
      `[...document.querySelectorAll('[data-field="outline-title"]')].some((el) => (el.textContent || '').trim() === ${JSON.stringify(renamed)})`,
      { label: '界面上的标题变了' },
    );
    const afterRename = await api.get(`/api/v1/tasks/${encodeURIComponent(childNode.id)}`);
    assert.equal(afterRename.title, renamed, '改名落到了数据库');

    /* ---------------- 6) 换状态（节点上的状态标签） ---------------- */
    await page.click(`[data-task-id="${childNode.id}"] [data-field="outline-status"]`);
    // 节点的状态标签是 Naive 的 `NDropdown`（不是 NSelect），选项类名不一样
    const optionText = await page.pickMenuOption(2);
    await page.waitFor(
      `(() => { const el = document.querySelector('[data-task-id="${childNode.id}"] [data-field="outline-status"]');
        return Boolean(el) && (el.textContent || '').trim() === ${JSON.stringify(optionText.trim())}; })()`,
      { label: `状态标签变成「${optionText.trim()}」` },
    );
    const afterStatus = await api.get(`/api/v1/tasks/${encodeURIComponent(childNode.id)}`);
    assert.check(
      afterStatus.statusId !== data.statuses[0]?.id,
      '换状态落到了数据库',
      { 现在: afterStatus.statusId, 原状态: data.statuses[0]?.id },
    );

    /* ---------------- 7) 删除：有子任务时拒绝，叶子节点可删 ---------------- */
    /*
     * 先试**有子任务**的节点（主任务有两个子任务）。
     *
     * 这里要守住的是"界面说的和服务端做的必须是同一件事"：服务端对非级联删除
     * 遇到子任务会直接 409 拒绝，所以界面**不能**摆出一个"删除"按钮让人点完才报错，
     * 更不能在确认框里写"子任务会上提一级"（第一版就是这么写的，是 e2e 拿真实请求
     * 打出来的 409 才发现的）。
     */
    const parentId = await page.json(
      `(() => { const el = [...document.querySelectorAll('[data-field="outline-title"]')]
        .find((node) => (node.textContent || '').trim().endsWith('主任务'));
        return JSON.stringify(el.closest('[data-task-id]').getAttribute('data-task-id')); })()`,
    );
    await page.click(`[data-task-id="${parentId}"] [data-field="outline-remove"]`);
    await page.waitFor("Boolean(document.querySelector('.n-dialog'))", { label: '出现提示框' });
    const refuseText = (await page.text('.n-dialog')) ?? '';
    assert.check(
      refuseText.includes('无法删除'),
      '对带子任务的节点：明确说"无法删除"，而不是删了才报错',
      refuseText.replace(/\s+/g, ' ').slice(0, 80),
    );
    /*
     * 这条提示框**只有一个按钮**（"知道了"），刻意没有"取消" ——
     * 摆出一个"取消"按钮会让人以为"再点一次就能删"。
     */
    const actionButtons = await page.json(
      `(() => JSON.stringify([...document.querySelectorAll('.n-dialog__action button')].map((el) => (el.textContent || '').trim())))()`,
    );
    assert.check(
      actionButtons.length === 1 && actionButtons[0] === '知道了',
      '这条提示只有一个"知道了"，不给"再试一次"的错觉',
      actionButtons,
    );
    await page.animationsSettled({ timeoutMs: 4000 }).catch(() => undefined);
    await page.click('.n-dialog__action button:last-child');
    await page.waitFor("!document.querySelector('.n-dialog')", { label: '关掉提示框' });

    const stillThere = await api.get(`/api/v1/tasks/${encodeURIComponent(parentId)}`);
    assert.equal(stillThere.deletedAt, null, '带子任务的节点没有被删掉');
    assert.check(
      await page.exists(`[data-task-id="${parentId}"] [data-field="outline-title"]`),
      '节点仍然在大纲里',
    );

    /*
     * 再删**没有子任务**的节点：这次要真的删掉。
     *
     * 用它而不是刚才那个被改名的叶子 —— 叶子在第 3 步被挂上了一个新子任务，
     * 于是它自己也成了"有子任务"的节点（第一版就是这么写的，结果这条断言一直在测
     * "拒绝删除"这条路径，看起来像"删除功能坏了"，其实是测试自己选错了对象）。
     */
    await page.click(`[data-task-id="${created.id}"] [data-field="outline-remove"]`);
    await page.waitFor("Boolean(document.querySelector('.n-dialog'))", { label: '出现删除确认框' });
    const dialogText = await page.text('.n-dialog');
    assert.check(
      dialogText.includes(newTitle) && dialogText.includes('回收站'),
      '确认框里写明要删的是哪一个任务，以及"可以还原"',
      dialogText.replace(/\s+/g, ' ').slice(0, 80),
    );

    /*
     * 点确认按钮用**真实鼠标**（`page.click` + 选择器），不用合成 `el.click()`：
     * 合成点击会绕开命中测试。对话框是放大淡入的，过渡期间算出来的中心点会落在
     * 它最终位置之外（点到遮罩上，而遮罩的默认行为是"取消"，表现同样是"对话框关了、
     * 什么都没发生"），所以点之前先等动画落定。
     */
    await page.animationsSettled({ timeoutMs: 4000 }).catch(() => undefined);
    await page.click('.n-dialog__action button:last-child');
    await page.waitFor("!document.querySelector('.n-dialog')", { label: '确认框关掉（证明点击生效了）' });
    await page.waitFor(
      `![...document.querySelectorAll('[data-field="outline-title"]')].some((el) => (el.textContent || '').trim() === ${JSON.stringify(newTitle)})`,
      { label: '被删的节点从大纲里消失' },
    );
    assert.equal(await page.count('[data-field="outline-title"]'), 5, '删掉新加的那个之后剩 5 个节点');
    /*
     * 删除必须落到数据库。这里查**回收站**而不是 `GET /tasks/:id`：
     * 后者对已软删除的任务返回 404（"任务不存在"）—— 拿它当判据会得到
     * "删除功能坏了"的错觉，实际是接口本来就不返回已删除的任务。
     */
    const recycle = await api.get(`/api/v1/projects/${data.project.id}/tasks/deleted`);
    const inRecycle = (recycle.items ?? recycle).some((task) => task.id === created.id);
    assert.check(inRecycle, '删除落到了数据库（在回收站里能找到它，可还原）');

    /*
     * 唯一一条"缺口"断言：拖拽还没实现。
     * 这条不是自嘲，是**回归保护** —— 将来真做了拖拽之后，这条会失败并提醒改文档与提示文案。
     */
    const note = await page.text('[data-field="outline-note"]');
    assert.check(
      (note || '').includes('尚未实现'),
      '界面上如实标注了「拖拽尚未实现」',
      (note || '').slice(0, 60),
    );
  },
};
