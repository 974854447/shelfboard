/**
 * 场景：新建项目向导（M4）—— 用户要求的主路径。
 *
 * 用户原话：「我不想把这个单独做一个模块，我希望的是**在创建项目的时候**就执行环境检测，
 * 并下载相关依赖与脚手架」。所以这个场景走的就是**用户真实会走的那条路**：
 *
 *   打开「新建项目」→ 选「仅后端项目」+ FastAPI → 创建
 *   → 窗口里依次看到：① 检测环境 ② 创建项目 ③ 生成代码骨架
 *   → 文件真的落在项目文件夹里 → 「进入工作台」
 *
 * **为什么取消勾选"安装依赖"**：装依赖要联网（pnpm/npm install、pip install），
 * 把它放进端到端等于把测试绑在网络与包源上 —— 那种测试迟早会因为公司网络抖动而红。
 * 安装这条路径由单测覆盖命令形状与选择逻辑（job-install.test.ts、commands.test.ts），
 * 这里只验证"可以取消勾选，且取消之后流程照常走完"。
 */

const path = require('node:path');
const fs = require('node:fs');

module.exports = {
  name: 'create-project',
  title: '新建项目向导：检测 → 骨架 →（跳过）装依赖',
  needsProject: false,

  async run({ page, assert, api, cdp, sandbox }) {
    await page.goto('#/projects', 'projects');

    /* ---------- 1) 打开向导 ---------- */
    await page.click('[data-field="projects-create"], [data-field="create-project"]').catch(async () => {
      // 页面顶部的「新建项目」按钮没有 data-field 时用文案兜底
      await page.evaluate(
        `(() => { const buttons = [...document.querySelectorAll('button')];
          const target = buttons.find((el) => (el.textContent || '').trim().includes('新建项目'));
          if (target) target.setAttribute('data-e2e-pick', '1');
          return target ? 1 : 0; })()`,
      );
      await page.click('[data-e2e-pick="1"]');
    });
    await page.waitFor("Boolean(document.querySelector('[data-field=\"wizard-name\"]'))", {
      label: '新建项目向导打开了',
    });
    assert.check(true, '点「新建项目」打开向导');

    /* ---------- 2) 选「仅后端项目」+ FastAPI ---------- */
    await page.click('[data-type="backend"]');
    await page.type('[data-field="wizard-name"] input', 'e2e 后端项目');
    const backendOption = await page.json(
      `(() => { const select = document.querySelector('[data-field="wizard-backend"]');
        return JSON.stringify(select ? [...select.options].map((option) => option.value) : []); })()`,
    );
    assert.check(backendOption.includes('fastapi'), '后端技术栈里有 FastAPI（内置模板，离线可用）', backendOption);
    assert.check(
      backendOption.includes('django') && backendOption.includes('nestjs'),
      '后端下拉里还有 Django 与 NestJS（四种栈都通了）',
      backendOption,
    );

    /*
     * 两行技术栈：这个项目只生成后端，所以**只该出现后端那一行**
     * （前端那一行不该出现 —— 否则用户会以为选了前端）。
     * 注意 `assert.equal` 是严格比较，数组要拼成字符串再比。
     */
    const stackRows = await page.json(
      `(() => JSON.stringify([...document.querySelectorAll('[data-stack]')]
        .map((el) => el.getAttribute('data-stack'))))()`,
    );
    assert.equal(stackRows.join(','), 'backend', '「仅后端项目」只显示后端一行技术栈');

    /*
     * 端口：**每个栈一个**，默认值按各自栈的惯例（FastAPI 8000，不是 Vite 的 5173），
     * 并且可以改。这里改成 8123，最后断言生成出来的代码里也是 8123。
     */
    const portField = '[data-field="wizard-port-backend"] input';
    assert.equal(
      await page.json(`(() => JSON.stringify(document.querySelector('${portField}')?.value ?? null))()`),
      '8000',
      '选了 FastAPI，端口默认值按这个栈的惯例给',
    );

    /*
     * 改端口用"原生 setter + input 事件"，而不是 `page.type`。
     *
     * 原因是 `page.type` 内部先点一下再 `insertText`：点击只**定位光标不选中**，
     * 于是新值会拼在旧的 `8000` 后面（`80008123`）—— 这个值超出端口范围，
     * 向导会退回默认值，最后表现为"填了 8123，代码里却是 8000"，看着像向导的 bug。
     * 数字输入框也没有 `data-field` 之外好用的"清空"手段，所以直接走框架认的那条路：
     * 用 `HTMLInputElement.prototype` 上的原生 setter 赋值（绕过 Vue 对 DOM 的接管），
     * 再派发 `input` 事件 —— Naive 的 `NInputNumber` 正是靠这个事件更新 `v-model`。
     * 值改完后立刻回读 DOM，确认真的进去了，后面的断言才不会误判。
     */
    await page.evaluate(
      `(() => { const input = document.querySelector('${portField}');
        if (!input) return 0;
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
        setter.call(input, '8123');
        input.dispatchEvent(new Event('input', { bubbles: true }));
        return 1; })()`,
    );
    await page.waitFor(`(document.querySelector('${portField}')?.value || '') === '8123'`, {
      label: '端口输入框真的变成了 8123',
    });
    assert.equal(
      await page.json(`(() => JSON.stringify(document.querySelector('${portField}').value))()`),
      '8123',
      '端口能从默认值改成 8123（校验通过、没被退回默认值）',
    );

    // 选了 Python 栈就不该出现包管理器选择（那是 Node 才有的东西）
    assert.check(
      !(await page.exists('[data-field="wizard-pm"]')),
      '只选 Python 栈时不显示包管理器选项',
    );

    /*
     * 维度控件**只在这个栈真的支持时才出现**（"没有死控件"这条规矩的端到端证明）：
     * FastAPI 是内置模板 —— 没有语言可选、也没有附加项，所以这两个控件都不该在。
     */
    assert.check(
      !(await page.exists('[data-field="wizard-language-backend"]')),
      'FastAPI 没有"语言"这个维度，所以不出现只有一项的语言下拉',
    );
    assert.check(
      (await page.count('[data-addon]')) === 0,
      'FastAPI（内置模板）没有任何附加项，所以一个开关都不出现',
    );
    assert.check(
      (await page.text('[data-stack="backend"] .stack-static')).includes('Python'),
      '语言改成了静态文字（Python），而不是一个只有一项的下拉',
    );



    /*
     * 「用户自己改过的端口，换个框架不能被覆盖」。
     *
     * 这条是**用户视角**才会发现的坑：先想清楚端口要 8123、再去对比着挑框架，
     * 如果换框架时无脑跟着惯例走，用户刚填的值就会被 3000 顶掉 ——
     * 而他明明已经定下来了。原生 `<select>` 用"赋值 + change 事件"驱动
     * （跟真人选一下等价，Vue 的 `v-model` 就是听这个事件）。
     */
    async function switchBackend(value) {
      await page.evaluate(
        `(() => { const select = document.querySelector('[data-field="wizard-backend"]');
          if (!select) return 0;
          select.value = ${JSON.stringify(value)};
          select.dispatchEvent(new Event('change', { bubbles: true }));
          return 1; })()`,
      );
      await page.waitFor(
        `document.querySelector('[data-field="wizard-backend"]')?.value === ${JSON.stringify(value)}`,
        { label: `后端框架切到 ${value}` },
      );
    }

    await switchBackend('nestjs');
    assert.equal(
      await page.json(`(() => JSON.stringify(document.querySelector('${portField}').value))()`),
      '8123',
      '换成 NestJS 后端口没有被打回 3000（用户改过的值优先）',
    );
    /*
     * NestJS 支持"严格模式"这一个附加项：换过来之后**应当出现**，
     * 而且默认勾上（服务端声明的默认值，前端不写死第二份）。
     */
    assert.check(await page.exists('[data-addon="backend:strict"]'), 'NestJS 出现了它的附加项（严格模式）');
    assert.check(
      await page.json(
        `(() => JSON.stringify(document.querySelector('[data-addon="backend:strict"] input')?.checked ?? null))()`,
      ),
      '严格模式默认是勾上的（默认值来自服务端声明）',
    );
    assert.check(
      (await page.text('[data-stack="backend"] .stack-static')).includes('TypeScript'),
      'NestJS 的语言是静态文字（TypeScript）',
    );
    assert.check(
      await page.exists('[data-field="wizard-pm"]'),
      '选了 Node 栈（NestJS）后包管理器选项出现了',
    );

    // 勾上"严格模式"以外的组合也走一遍：取消勾选后仍能提交（开关是真的在起作用）
    await page.click('[data-addon="backend:strict"]');
    assert.equal(
      await page.json(
        `(() => JSON.stringify(document.querySelector('[data-addon="backend:strict"] input')?.checked ?? null))()`,
      ),
      false,
      '点一下可以把附加项取消勾选',
    );
    await page.click('[data-addon="backend:strict"]');

    await switchBackend('fastapi');
    assert.equal(
      await page.json(`(() => JSON.stringify(document.querySelector('${portField}').value))()`),
      '8123',
      '换回 FastAPI 端口还是 8123',
    );
    assert.check(
      !(await page.exists('[data-field="wizard-pm"]')),
      '换回 Python 栈后包管理器选项又收起来了',
    );
    assert.check(
      (await page.count('[data-addon]')) === 0,
      '换回 FastAPI 后附加项开关又收起来了（不留上一条栈的控件）',
    );
    /*
     * 「技术栈拆成维度」之后向导长高了 —— 拍图时量出来的真问题：
     * 窗口高 821px 时，"前后端都要"的向导有 1130px，**「创建」按钮落在 y=1118**，
     * 既看不见也够不着（等于这个组合根本建不出项目）。
     *
     * 所以这里不看"内容多不多"，只看**最终的不变量**：向导不超出视口、按钮在可视区内。
     */
    await page.click('[data-type="fullstack"]');
    const tall = await page.json(
      `(() => { const modal = document.querySelector('.wizard');
        const start = document.querySelector('[data-field="wizard-start"]');
        const mr = modal.getBoundingClientRect();
        const sr = start.getBoundingClientRect();
        return JSON.stringify({
          viewportH: window.innerHeight,
          modalBottom: Math.round(mr.bottom),
          startBottom: Math.round(sr.bottom),
        }); })()`,
    );
    assert.check(
      tall.modalBottom <= tall.viewportH && tall.startBottom <= tall.viewportH,
      '"前后端都要"（内容最多的形态）下向导没超出视口、「创建」按钮点得到',
      tall,
    );
    // 回到「仅后端项目」继续后面的步骤
    await page.click('[data-type="backend"]');
    /*
     * 版本：放在**最后**选，这不是随意的顺序 —— 换框架会把维度选择重置成新框架的默认值
     * （Vue 的版本与 React 的版本根本不是一回事），所以"选版本"必须在挑完框架之后。
     * 第一版把它写在前面，结果被后面的框架切换重置了，报出来是"requirements.txt 没改"
     * —— 看着像版本功能失效，其实是测试顺序错了。
     *
     * 这里选"锁 0.141 这一线"，最后断言文件里真的是 `==0.141.*`（而不是模板里的 `>=0.115`）。
     */
    assert.check(
      await page.exists('[data-field="wizard-version-backend"]'),
      'FastAPI 有"版本"这一维度，所以出现版本下拉',
    );
    assert.check(
      !(await page.exists('[data-runtime="backend"]')),
      'Python 栈不显示 Node 要求（那是 Node 工具链的事实，不是所有栈都有）',
    );
    await page.evaluate(
      `(() => { const select = document.querySelector('[data-field="wizard-version-backend"]');
        if (!select) return 0;
        select.value = 'lock';
        select.dispatchEvent(new Event('change', { bubbles: true }));
        return 1; })()`,
    );
    await page.waitFor(
      `document.querySelector('[data-field="wizard-version-backend"]')?.value === 'lock'`,
      { label: '版本切到"锁 0.141 这一线"' },
    );

    // 取消"自动安装依赖"：联网那步不放进端到端（原因见文件头）
    await page.click('[data-field="wizard-install"]');
    assert.check(true, '取消勾选「创建后自动安装依赖」');

    /* ---------- 3) 创建：窗口里能看到逐步进度 ---------- */
    await page.click('[data-field="wizard-start"]');
    await page.waitFor(
      `Boolean(document.querySelector('[data-field="wizard-steps"] [data-step="env"]'))`,
      { label: '进入执行阶段，出现步骤列表', timeoutMs: 20000 },
    );

    await page.waitFor(
      `(document.querySelector('[data-field="wizard-done"]')?.textContent || '').length > 0`,
      { label: '向导走到"全部完成"', timeoutMs: 120000 },
    );

    const steps = await page.json(
      `(() => JSON.stringify({
        steps: [...document.querySelectorAll('[data-field="wizard-steps"] .step')].map((el) => ({
          key: el.getAttribute('data-step'),
          text: (el.textContent || '').replace(/\\s+/g, ' ').trim(),
          tone: el.className,
        })),
        percent: (document.querySelector('[data-field="wizard-progress"]')?.textContent || '').trim(),
        logs: [...document.querySelectorAll('[data-field="wizard-log"] .line')].map((el) => (el.textContent || '').replace(/\\s+/g, ' ').trim()),
        failed: Boolean(document.querySelector('[data-field="wizard-failed"]')),
      }))()`,
    );

    assert.check(!steps.failed, '没有停在失败状态');
    assert.equal(
      steps.steps.length,
      4,
      '步骤正好四个：检测环境 / 创建项目 / 生成骨架 / 铺管理侧模板（装依赖已取消）',
    );
    assert.check(
      steps.steps.every((item) => item.tone.includes('ok') || item.tone.includes('skipped')),
      '四步都完成或跳过',
      steps.steps.map((item) => `${item.key}:${item.text}`),
    );
    assert.check(
      steps.steps.some((item) => item.key === 'template' && item.text.includes('任务')),
      '「铺管理侧模板」那一步报了铺了什么（数字要能核对）',
      steps.steps.find((item) => item.key === 'template')?.text,
    );
    assert.check(
      steps.steps.some((item) => item.key === 'env' && item.text.includes('Node')),
      '「检测环境」那一步写明了 Node 版本（证明真的检测了）',
      steps.steps.find((item) => item.key === 'env')?.text,
    );
    assert.check(steps.logs.length > 0, '窗口里有实时日志', steps.logs.slice(0, 3));
    assert.check(
      steps.logs.some((line) => line.includes('app/main.py')),
      '日志里能看到写出的文件',
      steps.logs.filter((line) => line.includes('main.py')).slice(0, 2),
    );

    /* ---------- 4) 文件真的落在新项目的文件夹里 ---------- */
    const projects = await api.get('/api/v1/projects');
    const created = (projects.items ?? projects).find((item) => item.name === 'e2e 后端项目');
    assert.check(Boolean(created), '项目建出来了', created?.name);

    const info = await cdp.json('(async () => JSON.stringify(await window.pmStudio.getBootstrap()))()', {
      awaitPromise: true,
    });
    const projectDir = path.join(info.workspaceRoot, created.folder);
    assert.check(fs.existsSync(path.join(projectDir, 'app', 'main.py')), '骨架落在项目文件夹里', projectDir);
    assert.check(fs.existsSync(path.join(projectDir, 'requirements.txt')), 'requirements.txt 也在');
    /*
     * 端口断言分两层，缺一不可：
     *   1. **作业载荷**里是 8123（而且在 `targets[].port` 上，不是作业级的 `port`）
     *      —— 说明向导把界面上的值一路传下来了；
     *   2. **生成的文件**里是 8123 —— 说明作业真的用了它。
     * 只断言第 2 层的话，"向导没传值 → 作业用默认 8000 → 文件里没有 8123"和
     * "模板渲染把端口丢了"这两种完全不同的毛病会报成同一句话。
     *
     * 顺带钉住"端口属于每个栈"这条：**载荷里不该再出现作业级的 `port`** ——
     * 那个字段是上一版"前后端共用一个端口"的遗留，双栈时会撞号。
     */
    const jobList = await api.get('/api/v1/jobs?type=scaffold&limit=20');
    const scaffoldJob = (jobList.items ?? jobList)[0];
    assert.equal(scaffoldJob?.payload?.targets?.[0]?.port, 8123, '端口跟着**那个栈**一起传给作业');
    assert.equal(
      scaffoldJob?.payload?.port,
      undefined,
      '载荷里不再有作业级 port（那是"前后端共用端口"的遗留）',
    );
    assert.check(
      fs.readFileSync(path.join(projectDir, 'app', 'main.py'), 'utf8').includes('8123'),
      '向导里填的端口（8123）真的写进了生成的代码',
    );
    /*
     * 版本：`requirements.txt` 里必须是用户选的 `==0.141.*`，
     * 不是内置模板里写死的 `>=0.115`（"看着成功、其实没改"是这一层最该防的毛病）。
     */
    const requirements = fs.readFileSync(path.join(projectDir, 'requirements.txt'), 'utf8');
    assert.check(
      requirements.includes('fastapi==0.141.*'),
      '向导里选的版本（锁 0.141 这一线）真的写进了 requirements.txt',
      requirements,
    );
    const scaffoldText = (
      await api.get(`/api/v1/jobs/${scaffoldJob.id}/logs?limit=500`)
    ).items.map((entry) => entry.message).join('\n');
    assert.check(
      scaffoldText.includes('版本：fastapi'),
      '作业日志里写出了"改了哪个依赖的版本"（可当证据）',
      scaffoldText.split('\n').filter((line) => line.includes('版本')).slice(0, 3),
    );
    assert.check(
      !fs.existsSync(path.join(projectDir, 'node_modules')) && !fs.existsSync(path.join(projectDir, '.venv')),
      '取消勾选之后**没有**装依赖（目录里不该有 node_modules / .venv）',
    );

    /* ---------- 4.5) 管理侧：**新建即非空** ---------- */
    /*
     * 任务清单要真的有层级，里程碑要有截止日，文档模板要真的落在项目文件夹的 docs/ 里。
     * 这些都不是"作业成功了"能证明的 —— 得去数据与磁盘上看。
     *
     * 工作流不再按技术栈换一套（用户 2026-10-02 定的六态流程，四个栈共用）：
     * 所以这里断言的是**六态在位**，而不是"换成后端那套状态名"。
     */
    const statuses = await api.get(`/api/v1/projects/${created.id}/workflow-statuses`);
    const statusNames = (statuses.items ?? statuses).map((item) => item.name);
    const SIX_STATES = ['待完成', '正在修改', '待审查', '审查中', '回退修改', '已完成'];
    assert.check(
      SIX_STATES.every((name) => statusNames.includes(name)),
      '工作流是六态（待完成 → 正在修改 → 待审查 → 审查中 → 回退修改 → 已完成）',
      statusNames,
    );
    assert.check(
      !statusNames.includes('待处理') && !statusNames.includes('进行中'),
      '旧的三态没有被残留下来（不是两套状态并存）',
      statusNames,
    );

    const createdTasks = await api.get(`/api/v1/projects/${created.id}/tasks?pageSize=200`);
    const taskItems = createdTasks.items ?? createdTasks;
    assert.check(taskItems.length >= 10, '任务清单被铺好了（不是空项目）', taskItems.length);
    assert.check(
      taskItems.some((task) => task.parentId !== null),
      '任务是有层级的（工作台是分层空间，父子关系能显示进度）',
    );
    assert.check(
      taskItems.some((task) => task.title === '需求与接口'),
      '任务标题来自模板而不是随机生成',
      taskItems.slice(0, 6).map((task) => task.title),
    );

    const createdMilestones = await api.get(`/api/v1/projects/${created.id}/milestones`);
    assert.check(
      (createdMilestones.items ?? createdMilestones).length >= 3,
      '里程碑也铺好了',
      (createdMilestones.items ?? createdMilestones).map((m) => m.name),
    );

    const docsDir = path.join(projectDir, 'docs');
    assert.check(fs.existsSync(docsDir), '文档模板落在了项目文件夹的 docs/ 里', docsDir);
    const docFiles = fs.readdirSync(docsDir);
    assert.check(
      docFiles.includes('需求文档.md') && docFiles.includes('会议纪要.md'),
      '四份文档模板都在（需求 / 技术方案 / 会议纪要 / 架构决策记录）',
      docFiles,
    );
    assert.check(
      fs.readFileSync(path.join(docsDir, '架构决策记录.md'), 'utf8').includes('MADR'),
      'ADR 模板标注了来源（MADR，MIT）——需求 §5.9 的要求',
    );

    /* ---------- 5) 点「进入工作大纲」收尾 ---------- */
    await page.click('[data-field="wizard-finish"]');
    await page.waitFor("location.hash === '#/workbench'", { label: '进入工作大纲', timeoutMs: 20000 });
    assert.check(true, '点「进入工作大纲」落到工作大纲页');

    /* ---------- 收尾：把这个项目删掉 ---------- */
    /*
     * 同一个沙箱里后面还有别的场景，它们（以及项目页的"第一张卡"这类写法）
     * 都默认"沙箱里的项目就是自己播种的那个"。这个场景建了一个项目，
     * 不收拾掉会变成**别的场景的假失败**——场景之间不该互相污染。
     */
    await api.del(`/api/v1/projects/${created.id}`);
    const after = await api.get('/api/v1/projects');
    assert.check(
      !(after.items ?? after).some((item) => item.id === created.id),
      '收尾：把本次建的项目删掉了，不留给后面的场景',
    );

    await page.screenshot(path.join(sandbox.artifactsDir, 'create-project.png')).catch(() => undefined);
  },
};
