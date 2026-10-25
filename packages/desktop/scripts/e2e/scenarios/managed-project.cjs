/**
 * 场景：**新建即非空**（管理侧模板）——用户最在意的结果。
 *
 * 这一条测的是"纯管理项目"（不生成代码）这条最短路径：
 * 建一个项目 → 打开工作台，**不该是 0 个任务**。
 *
 * 为什么单独一个场景（`create-project` 已经覆盖了带代码的那条）：
 * 1. 纯管理项目的步骤不一样（没有骨架、没有装依赖），是最容易"少铺一步"的路径；
 * 2. 「新建即非空」这句话要用**用户看得见的东西**证明：工作台卡片数、工作流状态名、磁盘上的 docs/；
 * 3. 顺便盯住"取消勾选之后真的是空项目"—— 否则那个勾选框就成了假开关。
 */

const path = require('node:path');
const fs = require('node:fs');

/** 打开向导（按钮没有 data-field 时用文案兜底，与 create-project 同一套做法） */
async function openWizard(page) {
  await page.goto('#/projects', 'projects');
  await page.click('[data-field="projects-create"], [data-field="create-project"]').catch(async () => {
    await page.evaluate(
      `(() => { const buttons = [...document.querySelectorAll('button')];
        const target = buttons.find((el) => (el.textContent || '').trim().includes('新建项目'));
        if (target) target.setAttribute('data-e2e-pick', '1');
        return target ? 1 : 0; })()`,
    );
    await page.click('[data-e2e-pick="1"]');
  });
  await page.waitFor("Boolean(document.querySelector('[data-field=\"wizard-name\"]'))", {
    label: '向导打开了',
  });
}

module.exports = {
  name: 'managed-project',
  title: '纯管理项目：新建即非空（工作流 + 任务 + 里程碑 + 文档）',
  needsProject: true,

  async run({ page, assert, api, cdp, sandbox }) {
    const info = await cdp.json('(async () => JSON.stringify(await window.pmStudio.getBootstrap()))()', {
      awaitPromise: true,
    });
    const projectName = `e2e 管理项目 ${Date.now().toString().slice(-6)}`;

    /* ---------- 1) 建一个纯管理项目，管理侧模板保持勾选 ---------- */
    await openWizard(page);
    await page.click('[data-type="managed"]');
    await page.type('[data-field="wizard-name"] input', projectName);
    assert.check(
      await page.exists('[data-field="wizard-template"]'),
      '向导里有「铺管理侧模板」的勾选项（默认勾上 = 新建即非空）',
    );

    await page.click('[data-field="wizard-start"]');
    await page.waitFor(
      `(document.querySelector('[data-field="wizard-done"]')?.textContent || '').length > 0`,
      { label: '向导走完', timeoutMs: 60000 },
    );

    const steps = await page.json(
      `(() => JSON.stringify([...document.querySelectorAll('[data-field="wizard-steps"] .step')]
        .map((el) => ({ key: el.getAttribute('data-step'), text: (el.textContent || '').replace(/\\s+/g, ' ').trim() }))))()`,
    );
    assert.equal(
      steps.map((item) => item.key).join(','),
      'env,create,template',
      '纯管理项目的步骤是：环境检测（跳过）/ 创建项目 / 铺管理侧模板',
    );
    assert.check(
      steps.find((item) => item.key === 'env')?.text.includes('无需') ||
        steps.find((item) => item.key === 'env')?.text.includes('跳过'),
      '不生成代码时环境检测如实标成"跳过"（不是假装检测过）',
      steps.find((item) => item.key === 'env')?.text,
    );
    assert.check(
      (await page.text('[data-field="wizard-done"]')).includes('任务清单'),
      '结束语说清了铺了什么（不生成代码的项目不该提"代码已生成"）',
      await page.text('[data-field="wizard-done"]'),
    );

    const projects = await api.get('/api/v1/projects');
    const created = (projects.items ?? projects).find((item) => item.name === projectName);
    assert.check(Boolean(created), '项目建出来了', created?.name);

    /* ---------- 2) 数据层：工作流 / 任务 / 里程碑 ---------- */
    const statuses = (await api.get(`/api/v1/projects/${created.id}/workflow-statuses`)).items ?? [];
    assert.equal(
      statuses.map((item) => item.name).join(','),
      '待完成,正在修改,待审查,审查中,回退修改,已完成',
      '纯管理项目也是同一套六态工作流（四个技术栈共用一套）',
    );

    const tasks = (await api.get(`/api/v1/projects/${created.id}/tasks?pageSize=200`)).items ?? [];
    assert.atLeast(tasks.length, 10, '任务清单被铺好了');
    assert.check(
      tasks.filter((task) => task.parentId === null).length >= 4,
      '顶层任务至少四个（立项/计划/执行/验收）',
      tasks.filter((task) => task.parentId === null).map((task) => task.title),
    );
    /*
     * 注意这个接口回的是**裸数组**（`ok(listMilestones(...))`），不是 `{items}` ——
     * 第一版按 `{items}` 取，拿到 undefined 之后被我自己的 `?? []` 兜成了空数组，
     * 于是断言报的是"里程碑 0 个"，看着像模板没铺，其实是取错了字段。
     */
    const milestonesRaw = await api.get(`/api/v1/projects/${created.id}/milestones`);
    const milestones = Array.isArray(milestonesRaw) ? milestonesRaw : (milestonesRaw.items ?? []);
    assert.equal(milestones.length, 2, '通用模板铺两个里程碑', milestones.map((item) => item.name));
    assert.check(
      milestones.length > 0 && milestones.every((item) => item.dueDate !== null),
      '里程碑都带截止日（"定里程碑与截止日"这条任务才不是空话）',
      milestones.map((item) => `${item.name}:${item.dueDate}`),
    );

    /* ---------- 3) 磁盘：文档模板落在项目文件夹的 docs/ 里 ---------- */
    const projectDir = path.join(info.workspaceRoot, created.folder);
    const docsDir = path.join(projectDir, 'docs');
    assert.check(fs.existsSync(docsDir), 'docs/ 建出来了', docsDir);
    const docs = fs.readdirSync(docsDir);
    assert.equal(docs.length, 4, '四份文档模板都在', docs);
    assert.check(
      fs.readFileSync(path.join(docsDir, '需求文档.md'), 'utf8').includes('## 验收标准'),
      '需求文档里有可填的结构（不是空文件）',
    );

    /* ---------- 4) 用户看得见的那一面：工作大纲不是空的 ---------- */
    await page.click('[data-field="wizard-finish"]');
    await page.waitFor("location.hash === '#/workbench'", { label: '进入工作大纲', timeoutMs: 20000 });
    await page.waitFor('document.querySelectorAll("[data-field=\\"outline-title\\"]").length > 0', {
      label: '工作大纲出现节点',
      timeoutMs: 15000,
    });
    const cardCount = await page.count('[data-field="outline-title"]');
    assert.atLeast(cardCount, 4, '工作大纲里立刻有节点（这就是"新建即非空"）');
    assert.check(
      (await page.text('[data-field="outline-status"]')).length > 0,
      '节点上带状态标签（状态来自刚铺的工作流）',
      await page.text('[data-field="outline-status"]'),
    );

    await page.screenshot(path.join(sandbox.artifactsDir, 'managed-project.png')).catch(() => undefined);

    /* ---------- 4.5) 总览里的里程碑**能操作**（不是只能看） ---------- */
    /*
     * 管理侧模板会自动铺里程碑，所以这个面板不再是空的 —— 用户马上会想标记达成/删除。
     * 以前里程碑只有接口、界面只能看（典型的"功能只有 API 能碰"），这一刀补上了。
     */
    await page.goto('#/overview', 'overview');
    await page.waitFor('document.querySelectorAll(".mslist .ms").length >= 2', {
      label: '总览右侧出现里程碑',
      timeoutMs: 15000,
    });
    assert.check(
      (await page.json(
        `(() => { const h = [...document.querySelectorAll('section.card h3')]
          .find((el) => (el.textContent || '').includes('里程碑'));
          return JSON.stringify(h ? h.textContent.replace(/\\s+/g, ' ').trim() : null); })()`,
      )) !== null,
      '总览里有里程碑面板（自动铺出来的那些看得见）',
    );
    const beforeReach = await page.text('.mslist .ms .n');
    assert.check(beforeReach.length > 0, '未达成的里程碑显示截止日或"未排期"', beforeReach);

    // 标记达成：标题上的"已达成 x/2"要跟着变
    const headerBefore = await page.json(
      `(() => { const h = [...document.querySelectorAll('section.card h3')]
        .find((el) => (el.textContent || '').includes('里程碑'));
        return JSON.stringify((h?.textContent || '').replace(/\\s+/g, ' ').trim()); })()`,
    );
    await page.click('.mslist .ms:first-child .ms-act');
    await page.waitFor(
      `(() => { const h = [...document.querySelectorAll('section.card h3')]
        .find((el) => (el.textContent || '').includes('里程碑'));
        return (h?.textContent || '').includes('已达成 1/'); })()`,
      { label: '点「达成」之后计数变成 1/2' },
    );
    assert.check(
      headerBefore.includes('已达成 0/'),
      '点之前计数是 0/2（说明状态真的来自数据，不是写死的）',
      headerBefore,
    );

    // 取消达成：回到 0/2
    await page.click('.mslist .ms:first-child .ms-act');
    await page.waitFor(
      `(() => { const h = [...document.querySelectorAll('section.card h3')]
        .find((el) => (el.textContent || '').includes('里程碑'));
        return (h?.textContent || '').includes('已达成 0/'); })()`,
      { label: '再点一次可以取消达成' },
    );
    assert.check(true, '「达成 / 取消达成」是双向的（不是一次性开关）');


    // 新增 + 删除
    // 这里是**原生 input**（不是 Naive 的 NInput），所以元素本身就带 data-field
    await page.type('[data-field="milestone-new"]', 'e2e 自建里程碑');
    await page.click('[data-field="milestone-add"]');
    await page.waitFor('document.querySelectorAll(".mslist .ms").length >= 3', {
      label: '新增的里程碑出现在列表里',
    });
    const afterAdd = await api.get(`/api/v1/projects/${created.id}/milestones`);
    assert.check(
      (Array.isArray(afterAdd) ? afterAdd : (afterAdd.items ?? [])).some(
        (item) => item.name === 'e2e 自建里程碑',
      ),
      '新增的里程碑落库了（不是只加在界面上）',
    );

    await page.click('.mslist .ms:last-child .ms-act.danger');
    await page.waitFor('document.querySelectorAll(".mslist .ms").length === 2', {
      label: '删除后剩两条',
    });
    const afterRemove = await api.get(`/api/v1/projects/${created.id}/milestones`);
    const remaining = Array.isArray(afterRemove) ? afterRemove : (afterRemove.items ?? []);
    assert.check(
      !remaining.some((item) => item.name === 'e2e 自建里程碑'),
      '删除也是真的删了（库里没有残留）',
      remaining.map((item) => item.name),
    );

    /* ---------- 5) 反例：取消勾选之后**真的是空项目** ---------- */
    await api.del(`/api/v1/projects/${created.id}`);

    const emptyName = `e2e 空项目 ${Date.now().toString().slice(-6)}`;
    await openWizard(page);
    await page.click('[data-type="managed"]');
    await page.type('[data-field="wizard-name"] input', emptyName);
    // 取消勾选管理侧模板
    await page.click('[data-field="wizard-template"]');
    assert.check(
      (await page.text('.footer .faint')).includes('空项目'),
      '取消勾选后向导如实说明"会是一个空项目"（不是含糊其辞）',
      await page.text('.footer .faint'),
    );
    await page.click('[data-field="wizard-start"]');
    await page.waitFor(
      `(document.querySelector('[data-field="wizard-done"]')?.textContent || '').length > 0`,
      { label: '第二次创建走完', timeoutMs: 60000 },
    );

    const projects2 = await api.get('/api/v1/projects');
    const empty = (projects2.items ?? projects2).find((item) => item.name === emptyName);
    const emptyTasks =
      (await api.get(`/api/v1/projects/${empty.id}/tasks?pageSize=200`)).items ?? [];
    const emptyStatuses =
      (await api.get(`/api/v1/projects/${empty.id}/workflow-statuses`)).items ?? [];
    assert.equal(emptyTasks.length, 0, '取消勾选之后**没有**任务（勾选框不是假的）');
    assert.equal(
      emptyStatuses.map((item) => item.name).join(','),
      '待完成,正在修改,待审查,审查中,回退修改,已完成',
      '不铺管理侧模板时仍然是项目创建自带的六个默认状态（工作流不会缺失）',
    );
    assert.check(
      !fs.existsSync(path.join(info.workspaceRoot, empty.folder, 'docs')),
      '取消勾选之后没有写 docs/',
    );

    /* ---------- 收尾：把两个项目都清掉 ---------- */
    await api.del(`/api/v1/projects/${empty.id}`);
    assert.check(true, '收尾：把本次建的两个项目都删掉了');
  },
};
