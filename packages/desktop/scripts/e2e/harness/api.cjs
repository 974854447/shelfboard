/**
 * 通过内嵌服务的 HTTP 接口造数据 / 清数据。
 *
 * 为什么不用界面点击来造数据：界面点击既慢又脆（一次跑要几十次交互），
 * 而且**会把"造数据失败"和"被测功能失败"混在一起** —— 测试自己挂掉时，
 * 报告里看不出是被测代码的问题还是点错了地方。
 * 造数据走接口、验证走界面，两边职责分开。
 *
 * 数据全部**带本次运行的随机后缀**，并且在场景结束时删掉，理由：
 * - 名字唯一，断言就不会被上一轮遗留的同名数据干扰；
 * - 跑完即清，重复跑不会累积垃圾（老脚本每跑一次就往沙箱里塞一个"前端重构"）。
 */

function createApi(cdp) {
  let bootstrap = null;

  async function ensureBootstrap() {
    if (bootstrap) return bootstrap;
    bootstrap = await cdp.json(
      '(async () => JSON.stringify(await window.pmStudio.getBootstrap()))()',
      { awaitPromise: true },
    );
    return bootstrap;
  }

  async function request(method, url, body) {
    const info = await ensureBootstrap();
    /*
     * 没有 body 时**不能带 content-type**：Fastify 默认解析器看到
     * `content-type: application/json` 却拿到空 body，会直接 400
     * （`Body cannot be empty when content-type is set to 'application/json'`）。
     * 这条在清理项目（DELETE）时踩到过 —— 表现为"清理失败"，虽然不影响结论，
     * 但会在日志里留一串假 WARN，后来人看到会以为接口有问题。
     */
    const response = await fetch(`${info.baseUrl}${url}`, {
      method,
      ...(body === undefined
        ? {}
        : { headers: { authorization: `Bearer ${info.token}`, 'content-type': 'application/json' }, body: JSON.stringify(body) }),
      ...(body === undefined ? { headers: { authorization: `Bearer ${info.token}` } } : {}),
    });
    const payload = await response.json().catch(() => null);
    if (!payload || payload.ok !== true) {
      throw new Error(`${method} ${url} 失败：HTTP ${response.status} ${JSON.stringify(payload?.error ?? null)}`);
    }
    return payload.data;
  }

  const api = {
    get: (url) => request('GET', url),
    post: (url, body) => request('POST', url, body ?? {}),
    patch: (url, body) => request('PATCH', url, body ?? {}),
    del: (url) => request('DELETE', url),
    async info() {
      return ensureBootstrap();
    },

    /**
     * 造一棵可验证的树：主任务 A（2 个子任务，其中一个再挂 1 个）+ 叶子任务 B。
     * 覆盖"有子任务/没子任务""多层"这三件后续断言都要用到的事。
     */
    async seedProjectTree(name) {
      const project = await api.post('/api/v1/projects', { name });
      // 状态接口返回的是 `{ items: [...] }`（不是裸数组）—— 这一点踩过一次
      const statusPayload = await api.get(`/api/v1/projects/${project.id}/workflow-statuses`);
      const statuses = Array.isArray(statusPayload) ? statusPayload : (statusPayload.items ?? []);
      const doneStatusId = statuses.find((s) => s.category === 'done')?.id;

      /*
       * 截止日按**本地日历天**铺开（M2 的日历/我的待办要用）：
       *   子任务二 = 昨天（逾期一组）、子任务一 = 今天、主任务 = 5 天后（本周或以后）、
       *   孙任务与叶子任务没有截止日（"没有截止日"那一组）。
       * 这样三页都有可断言的数据，且不依赖跑测试的时间点。
       */
      const dayStart = (offset) => {
        const d = new Date();
        d.setHours(9, 0, 0, 0);
        d.setDate(d.getDate() + offset);
        return d.getTime();
      };

      const parent = await api.post('/api/v1/tasks', {
        projectId: project.id,
        title: `${name}·主任务`,
        statusId: statuses[0]?.id,
        dueDate: dayStart(5),
      });
      const child = await api.post('/api/v1/tasks', {
        projectId: project.id,
        parentId: parent.id,
        title: `${name}·子任务一`,
        dueDate: dayStart(0),
      });
      const overdue = await api.post('/api/v1/tasks', {
        projectId: project.id,
        parentId: parent.id,
        title: `${name}·子任务二`,
        dueDate: dayStart(-1),
      });
      await api.post('/api/v1/tasks', {
        projectId: project.id,
        parentId: child.id,
        title: `${name}·孙任务`,
      });
      const leaf = await api.post('/api/v1/tasks', {
        projectId: project.id,
        title: `${name}·叶子任务`,
      });
      // 一条依赖：把"被前置卡住"的面板喂上数据（总览右侧那一栏要能列出阻塞来源）
      await api.post(`/api/v1/tasks/${encodeURIComponent(leaf.id)}/dependencies`, {
        predecessorId: parent.id,
      });

      return { project, statuses, doneStatusId, parent, child, overdue, leaf };
    },

    /**
     * 让应用打开某个项目。
     *
     * 走"写偏好 + 重载"而不是在界面上点下拉框：下拉是 Naive 的浮层组件，
     * 点开、选中、等关闭三步都可能因为动画时序失败，而这条路径是应用自己的机制
     * （`restoreLastProject` 读的就是这个偏好），一次重载就到位。
     */
    async selectProject(projectId, projectName) {
      await cdp.evaluate(
        `(async () => { await window.pmStudio.patchPreferences({ lastProjectId: ${JSON.stringify(projectId)} }); return 1; })()`,
        { awaitPromise: true },
      );
      await cdp.evaluate('location.reload()');

      const deadline = Date.now() + 30000;
      while (Date.now() < deadline) {
        const ready = await cdp
          .evaluate(
            `(() => Boolean(window.pmStudio) && Boolean(document.querySelector('.n-layout'))
              && (document.querySelector('.sider')?.textContent || '').includes(${JSON.stringify(projectName)}))()`,
          )
          .catch(() => false);
        if (ready) return;
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
      throw new Error(`选中项目失败：界面里没有出现「${projectName}」`);
    },

    /**
     * 改偏好设置（走应用自己的 IPC，与设置页面的按钮同一条路径）。
     *
     * 场景需要它来把"输出目录"之类的设置指到沙箱里 —— E2E 绝不能在用户的
     * 真实目录（文档、AppData）里留文件。
     */
    async patchPreferences(patch) {
      await cdp.evaluate(
        `(async () => { await window.pmStudio.patchPreferences(${JSON.stringify(patch)}); return 1; })()`,
        { awaitPromise: true },
      );
    },

    /** 清掉整个项目（连同任务）。清理失败只告警，不改变测试结论 */
    async dropProject(projectId) {
      try {
        await api.del(`/api/v1/projects/${encodeURIComponent(projectId)}?hard=true`);
      } catch (error) {
        process.stdout.write(`  · 清理项目失败（不影响结论）：${error.message}\n`);
      }
    },
  };

  return api;
}

module.exports = { createApi };
