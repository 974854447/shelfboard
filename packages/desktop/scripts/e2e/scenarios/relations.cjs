/**
 * 场景：项目间关系链（需求 §5.2.1）—— **纯展示**，但必须是"能用的界面"。
 *
 * 这一条要证明三件事：
 * 1. **能标**：在总览里选另一个项目 + 自由填关系名（用户给的例子是「调用」），真的入库；
 * 2. **能看**：关系在两个项目页都能看到（出向 / 入向），项目卡片上也有标记；
 * 3. **不联动**：标了关系之后，另一侧项目的任务、状态、文档一点没变 ——
 *    这是需求里的硬要求（"两个项目的数据互不可见、互不影响"），
 *    所以它必须被**测**出来，而不是靠"我们没写联动代码"。
 */

const path = require('node:path');
const fs = require('node:fs');

module.exports = {
  name: 'relations',
  title: '项目间关系链：能标、能看、不联动',
  needsProject: true,

  async run({ page, assert, api, cdp, data, sandbox }) {
    /* ---------- 准备：再建一个"对方"项目 ---------- */
    const otherName = `e2e 关系对端 ${Date.now().toString().slice(-6)}`;
    const other = await api.post('/api/v1/projects', { name: otherName, codeKind: 'backend' });
    assert.check(Boolean(other.id), '建了一个用来连关系的项目');

    /*
     * 这个项目是**用接口**建的，界面里的项目列表还是旧的 —— 必须重载一次，
     * 否则"关系端点"的下拉里根本看不到它（第一版就栽在这里：下拉里只有占位项，
     * 报出来像是"下拉没实现"，其实是界面还没拿到那个项目）。
     * 真人走的是"新建项目向导"，那条路会自己刷新列表，所以这是测试侧的补课。
     */
    await page.reload();
    await page.waitFor('Boolean(document.querySelector(".n-layout"))', {
      label: '重载后应用外壳重新挂上',
      timeoutMs: 30000,
    });

    const before = {
      tasks: (await api.get(`/api/v1/projects/${other.id}/tasks?pageSize=200`)).items?.length ?? 0,
      statuses: ((await api.get(`/api/v1/projects/${other.id}/workflow-statuses`)).items ?? []).length,
    };

    try {
      /* ---------- 1) 在总览里建立一条关系 ---------- */
      await page.goto('#/overview', 'overview');
      await page.waitFor("Boolean(document.querySelector('[data-field=\"relations-card\"]'))", {
        label: '总览里有「关系链」面板',
        timeoutMs: 20000,
      });
      assert.check(
        (await page.text('[data-field="relations-card"]')).includes('仅用于展示'),
        '面板上写明了"关系链仅用于展示"（不共享任务/标签/文档）',
      );

      // 下拉里应该能看到刚建的那个项目
      const candidates = await page.json(
        `(() => { const select = document.querySelector('[data-field="relation-target"]');
          return JSON.stringify(select ? [...select.options].map((o) => o.textContent.trim()) : []); })()`,
      );
      assert.check(
        candidates.some((text) => text.includes(otherName)),
        '关系端点的下拉里有另一个项目（不是只有"选另一个项目…"）',
        candidates,
      );

      await page.evaluate(
        `(() => { const select = document.querySelector('[data-field="relation-target"]');
          const option = [...select.options].find((o) => o.textContent.includes(${JSON.stringify(otherName)}));
          select.value = option.value;
          select.dispatchEvent(new Event('change', { bubbles: true }));
          return 1; })()`,
      );
      // 关系名**自由填**：这里就用需求里的例子「调用」
      await page.type('[data-field="relation-label"]', '调用');
      await page.click('[data-field="relation-add"]');

      await page.waitFor('document.querySelectorAll(".rellist li").length >= 1', {
        label: '关系出现在面板里',
        timeoutMs: 10000,
      });
      const lineText = await page.text('.rellist li');
      assert.check(lineText.includes('调用'), '关系名就是我们填的那个（自由文本）', lineText);
      assert.check(
        lineText.includes(otherName),
        '线上写明了另一端是哪个项目',
        lineText,
      );
      assert.check(
        lineText.includes('本项目'),
        '这一侧显示成"本项目"（方向看得出来：出向）',
        lineText,
      );

      /* ---------- 2) 落库了，而且两个方向都查得到 ---------- */
      const mine = await api.get(`/api/v1/projects/${data.project.id}/relations`);
      assert.equal(mine.length, 1, '本项目的接口返回这条关系');
      assert.equal(mine[0]?.direction, 'outgoing', '从本项目看是出向');
      assert.equal(mine[0]?.label, '调用', '关系名原样存下来');

      const theirs = await api.get(`/api/v1/projects/${other.id}/relations`);
      assert.equal(theirs.length, 1, '对端项目也查得到同一条关系');
      assert.equal(theirs[0]?.direction, 'incoming', '在对端看是入向（"谁在调我"）');

      /* ---------- 3) 项目卡片上有标记 ---------- */
      await page.goto('#/projects', 'projects');
      await page.waitFor(
        `Boolean(document.querySelector('[data-relations-for="${other.id}"]'))`,
        { label: '对端项目的卡片上出现关系标记', timeoutMs: 15000 },
      );
      const badge = await page.text(`[data-relations-for="${other.id}"]`);
      assert.check(badge.includes('调用'), '卡片上显示关系名', badge);

      /* ---------- 4) **不联动**：对端项目的数据一点没变 ---------- */
      const afterTasks =
        (await api.get(`/api/v1/projects/${other.id}/tasks?pageSize=200`)).items?.length ?? 0;
      const afterStatuses = ((await api.get(`/api/v1/projects/${other.id}/workflow-statuses`)).items ?? [])
        .length;
      assert.equal(afterStatuses, before.statuses, '标关系**没有**影响对端项目的工作流状态');
      assert.check(
        afterTasks === before.tasks,
        '标关系**没有**给对端项目加任何任务（不共享任务）',
        `${before.tasks} → ${afterTasks}`,
      );

      const info = await cdp.json('(async () => JSON.stringify(await window.pmStudio.getBootstrap()))()', {
        awaitPromise: true,
      });
      const projectDir = path.join(info.workspaceRoot, other.folder);
      const docsDir = path.join(projectDir, 'docs');
      assert.check(
        !fs.existsSync(docsDir),
        '标关系**没有**在对端项目里写任何文件（不共享文档）',
      );

      /* ---------- 5) 重复的关系要被挡住，自连也要被挡住 ---------- */
      let duplicateRejected = false;
      try {
        await api.post(`/api/v1/projects/${data.project.id}/relations`, {
          toProjectId: other.id,
          label: '调用',
        });
      } catch {
        duplicateRejected = true;
      }
      assert.check(duplicateRejected, '同一条关系不能重复标（服务端挡住，不只是界面）');

      let selfRejected = false;
      try {
        await api.post(`/api/v1/projects/${data.project.id}/relations`, {
          toProjectId: data.project.id,
          label: '调用',
        });
      } catch {
        selfRejected = true;
      }
      assert.check(selfRejected, '不能把项目连到它自己');

      /* ---------- 6) 能删（关系不是"只能加不能改"） ---------- */
      await page.goto('#/overview', 'overview');
      await page.waitFor('document.querySelectorAll(".rellist li").length >= 1', {
        label: '回到总览仍有这条关系',
        timeoutMs: 15000,
      });
      await page.click('.rellist li .rel-act');
      await page.waitFor('document.querySelectorAll(".rellist li").length === 0', {
        label: '删除后列表空了',
        timeoutMs: 10000,
      });
      const afterDelete = await api.get(`/api/v1/projects/${data.project.id}/relations`);
      assert.equal(afterDelete.length, 0, '删除是真的删了（库里没有残留）');

      await page.screenshot(path.join(sandbox.artifactsDir, 'relations.png')).catch(() => undefined);
    } finally {
      // 收尾：把对端项目删掉，别留给后面的场景
      await api.del(`/api/v1/projects/${other.id}`);
    }
  },
};
