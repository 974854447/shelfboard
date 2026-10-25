/**
 * 场景：向导的**布局**（不是功能）。
 *
 * 为什么单独一个场景：功能断言过了不代表界面能用。这一刀真踩到过：
 * 技术栈拆成"前端一行 + 后端一行 + 附加项"之后向导长到 **1130px**，
 * 而窗口只有 821px —— **「创建」按钮落在 y=1118**，既看不见也够不着，
 * 也就是"前后端项目根本建不出来"。功能断言全绿，因为流程本身没问题。
 *
 * 所以这里只盯两条**不变量**（与"内容多不多"无关）：
 *   1. 向导不超出视口；
 *   2. 「创建」按钮落在可视区内。
 * 四种项目类型 × 各个框架都量一遍，并把每种形态留一张图给人工看。
 */

const path = require('node:path');

module.exports = {
  name: 'wizard-layout',
  title: '新建项目向导：布局不变量（不超视口、按钮点得到）',
  needsProject: false,

  async run({ page, assert, sandbox }) {
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
    await page.type('[data-field="wizard-name"] input', '看布局');

    /** 量一次布局，并留一张图 */
    async function checkType(kind, { backend, frontend, shot }) {
      await page.click(`[data-type="${kind}"]`);
      if (frontend) await setSelect(page, 'wizard-frontend', frontend);
      if (backend) await setSelect(page, 'wizard-backend', backend);

      const metrics = await page.json(
        `(() => { const modal = document.querySelector('.wizard');
          const start = document.querySelector('[data-field="wizard-start"]');
          const content = modal.querySelector('.n-card-content');
          const mr = modal.getBoundingClientRect();
          const sr = start.getBoundingClientRect();
          return JSON.stringify({
            viewportH: window.innerHeight,
            modalH: Math.round(mr.height),
            modalBottom: Math.round(mr.bottom),
            startBottom: Math.round(sr.bottom),
            contentScrollable: content ? content.scrollHeight > content.clientHeight + 1 : null,
            stacks: [...document.querySelectorAll('[data-stack]')].map((el) => el.getAttribute('data-stack')),
            addons: document.querySelectorAll('[data-addon]').length,
            versions: document.querySelectorAll('[data-field^="wizard-version-"]').length,
            runtimes: [...document.querySelectorAll('[data-runtime]')].map((el) => el.textContent.trim()),
          }); })()`,
      );

      const label = `${kind}${backend ? `/${backend}` : ''}${frontend ? `/${frontend}` : ''}`;
      assert.check(
        metrics.modalBottom <= metrics.viewportH && metrics.startBottom <= metrics.viewportH,
        `${label}：向导没超出视口、「创建」按钮点得到`,
        metrics,
      );

      if (shot) {
        const box = await page.box('.wizard');
        await page.screenshot(path.join(sandbox.artifactsDir, `wizard-${shot}.png`), {
          x: Math.max(0, box.x - 6),
          y: Math.max(0, box.y - 6),
          width: box.width + 12,
          height: box.height + 12,
          scale: 1,
        });
      }
      return metrics;
    }

    // 内容最多的形态：前后端都要 + Vue（六个附加项 + 版本）+ NestJS（严格模式 + 版本）
    const full = await checkType('fullstack', { frontend: 'vue3', backend: 'nestjs', shot: 'fullstack' });
    assert.equal(full.stacks.join(','), 'frontend,backend', '前后端项目有两行技术栈');
    assert.check(full.addons >= 7, '两行的附加项都出现了（Vue 六个 + NestJS 一个）', full.addons);
    assert.equal(full.versions, 2, '两行各有一个版本下拉');
    assert.equal(full.runtimes.length, 2, '两个 Node 栈都静态显示了 Node 要求');
    assert.check(full.runtimes[0].includes('Node'), 'Node 要求不是开关，是静态文字', full.runtimes);

    // React：维度比 Vue 少（只有 ESLint），版本仍要有
    const react = await checkType('frontend', { frontend: 'react', shot: 'react' });
    assert.equal(react.stacks.join(','), 'frontend', '仅前端项目只有前端一行');
    assert.equal(react.addons, 1, 'React 只有 ESLint 这一个附加项（不硬造选项）');
    assert.equal(react.versions, 1, 'React 有版本下拉');

    // Python 栈：没有附加项、没有 Node 要求，但有版本（requirements.txt 的写法由它决定）
    const python = await checkType('backend', { backend: 'django', shot: 'django' });
    assert.equal(python.addons, 0, 'Django（内置模板）没有任何附加项控件');
    assert.equal(python.versions, 1, 'Django 有版本下拉（6.x / 4.2 LTS）');
    assert.equal(python.runtimes.length, 0, 'Python 栈不显示 Node 要求');

    // 纯管理项目：不生成代码，技术栈那一段整个不出现
    const managed = await checkType('managed', {});
    assert.equal(managed.stacks.length, 0, '纯管理项目不出现技术栈（不生成代码）');
  },
};

/** 原生 `<select>`：赋值 + change 事件（跟真人选一下等价） */
async function setSelect(page, field, value) {
  await page.evaluate(
    `(() => { const select = document.querySelector('[data-field="${field}"]');
      if (!select) return 0;
      select.value = ${JSON.stringify(value)};
      select.dispatchEvent(new Event('change', { bubbles: true }));
      return 1; })()`,
  );
  await page.waitFor(`document.querySelector('[data-field="${field}"]')?.value === ${JSON.stringify(value)}`, {
    label: `${field} 切到 ${value}`,
  });
}
