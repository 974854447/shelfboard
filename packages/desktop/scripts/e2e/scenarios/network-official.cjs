/**
 * 场景：**真的联网**验证官方脚手架接线（`requiresNetwork: true`，默认不跑）。
 *
 * 为什么它不在默认那一批里：其余场景**刻意不碰网络**（"测试绑在网络与包源上迟早会红"）。
 * 但这个功能本身的价值就在"调得动官方脚手架"，只靠单测只能证明"我们拼了什么参数"，
 * 证明不了"官方收得下" —— 而上一版恰恰在这里栽过：参数被当成一个字符串，
 * 经 `cmd.exe` → npm → 脚手架三层转义后变成 `Unknown option '…'`。
 * 所以留一个**显式点名才跑**的场景：`node scripts/e2e/run.cjs --network`。
 *
 * 三条要验的（都是这一版新接的线）：
 *   1. React + TypeScript + ESLint → `npm create vite@latest app -- --template react-ts --eslint --no-interactive`
 *   2. Vue + JavaScript + 无附加项 → 换走 `--template vue`
 *      （create-vue 没有任何 feature flag 时会转成交互式提问，非交互环境走不通）
 *   3. Vue + TypeScript + Router/Pinia → `--router --pinia` 真的生效（产物里有 src/router、src/stores）
 */

const path = require('node:path');
const fs = require('node:fs');

async function waitJob(api, jobId, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    last = await api.get(`/api/v1/jobs/${jobId}`);
    if (['succeeded', 'failed', 'canceled', 'interrupted'].includes(last.status)) return last;
    await new Promise((resolve) => setTimeout(resolve, 700));
  }
  return last;
}

module.exports = {
  name: 'network-official',
  title: '官方脚手架（需要联网）：React / Vue-JS / Vue-TS 真的调 npm create',
  needsProject: false,
  /** 真的会调 `npm create …`：默认不跑，`--network` 或显式点名时才跑 */
  requiresNetwork: true,

  async run({ assert, api, cdp }) {
    const info = await cdp.json('(async () => JSON.stringify(await window.pmStudio.getBootstrap()))()', {
      awaitPromise: true,
    });

    async function createProject(name) {
      const created = await api.post('/api/v1/projects', { name });
      const projects = await api.get('/api/v1/projects');
      const project = (projects.items ?? projects).find((item) => item.id === created.id);
      return { project, dir: path.join(info.workspaceRoot, project.folder) };
    }

    async function logsOf(jobId) {
      const logs = await api.get(`/api/v1/jobs/${jobId}/logs?limit=500`);
      return logs.items.map((entry) => entry.message).join('\n');
    }

    /* ---------- 1) React + TypeScript + ESLint ---------- */
    {
      const { project, dir } = await createProject('probe-react-官方');
      const job = await api.post('/api/v1/jobs', {
        type: 'scaffold',
        payload: {
          projectId: project.id,
          targets: [
            {
              templateId: 'react',
              port: 5300,
              selections: { language: 'ts', addons: ['eslint'] },
            },
          ],
        },
      });
      const finished = await waitJob(api, job.id, 6 * 60 * 1000);
      const text = await logsOf(job.id);
      assert.equal(finished.status, 'succeeded', text.slice(-600));
      assert.check(text.includes('官方脚手架生成完成'), 'React 走的是官方脚手架，不是回退');
      assert.check(!text.includes('改用内置骨架'), 'React 没有走回退路径');
      assert.check(fs.existsSync(path.join(dir, 'package.json')), 'React：package.json 生成出来了');
      assert.check(fs.existsSync(path.join(dir, 'src', 'App.tsx')), 'React：src/App.tsx 是 TSX（--template react-ts 生效）');
      assert.check(fs.existsSync(path.join(dir, 'eslint.config.js')), 'React：--eslint 生效（出现 eslint.config.js）');
      assert.check(
        fs.readFileSync(path.join(dir, 'vite.config.ts'), 'utf8').includes('vite'),
        'React：vite.config.ts 在',
      );
      await api.del(`/api/v1/projects/${project.id}`);
    }

    /* ---------- 2) Vue + JavaScript + 无附加项 ---------- */
    {
      const { project, dir } = await createProject('probe-vue-js');
      const job = await api.post('/api/v1/jobs', {
        type: 'scaffold',
        payload: {
          projectId: project.id,
          targets: [
            { templateId: 'vue3', port: 5301, selections: { language: 'js', addons: [] } },
          ],
        },
      });
      const finished = await waitJob(api, job.id, 6 * 60 * 1000);
      const text = await logsOf(job.id);
      assert.equal(finished.status, 'succeeded', text.slice(-600));
      assert.check(text.includes('交互式提问'), '日志里说明了为什么改用 Vite 官方模板');
      assert.check(text.includes('官方脚手架生成完成'), 'Vue JS 走的也是官方脚手架');
      assert.check(fs.existsSync(path.join(dir, 'vite.config.js')), 'Vue JS：vite.config.js（不是 .ts）');
      assert.check(!fs.existsSync(path.join(dir, 'tsconfig.json')), 'Vue JS：没有 tsconfig.json');
      await api.del(`/api/v1/projects/${project.id}`);
    }

    /* ---------- 3) Vue + TypeScript + Router/Pinia ---------- */
    {
      const { project, dir } = await createProject('probe-vue-ts');
      const job = await api.post('/api/v1/jobs', {
        type: 'scaffold',
        payload: {
          projectId: project.id,
          targets: [
            {
              templateId: 'vue3',
              port: 5302,
              selections: { language: 'ts', addons: ['router', 'pinia'] },
            },
          ],
        },
      });
      const finished = await waitJob(api, job.id, 6 * 60 * 1000);
      const text = await logsOf(job.id);
      assert.equal(finished.status, 'succeeded', text.slice(-600));
      assert.check(fs.existsSync(path.join(dir, 'src', 'router')), 'Vue TS：--router 生效（出现 src/router）');
      assert.check(fs.existsSync(path.join(dir, 'src', 'stores')), 'Vue TS：--pinia 生效（出现 src/stores）');
      assert.check(fs.existsSync(path.join(dir, 'tsconfig.json')), 'Vue TS：tsconfig.json 在');

      /*
       * **端口也要真的写进配置**（这一刀补的）：
       * `create-vue` 生成的 vite.config.ts 里**没有** port，不补这一步，
       * 用户在向导里填的端口在官方路径上就是白填（项目照样跑在 5173）。
       */
      const viteConfig = fs.readFileSync(path.join(dir, 'vite.config.ts'), 'utf8');
      assert.check(
        /server:\s*\{\s*port:\s*5302/.test(viteConfig),
        '官方脚手架生成的 vite.config.ts 里被写进了用户选的端口（5302）',
        viteConfig.slice(-200),
      );
      assert.check(
        fs.readdirSync(dir).every((name) => !/^vite\.config\.\d+\.ts$/.test(name)),
        '没有留下临时/备份文件',
      );
      await api.del(`/api/v1/projects/${project.id}`);
    }

    /* ---------- 4) React + 版本 18：官方写 19，我们要的是 18 ---------- */
    {
      const { project, dir } = await createProject('probe-react-18');
      const job = await api.post('/api/v1/jobs', {
        type: 'scaffold',
        payload: {
          projectId: project.id,
          targets: [
            {
              templateId: 'react',
              port: 5303,
              selections: { language: 'ts', version: '18', addons: [] },
            },
          ],
        },
      });
      const finished = await waitJob(api, job.id, 6 * 60 * 1000);
      const text = await logsOf(job.id);
      assert.equal(finished.status, 'succeeded', text.slice(-600));

      /*
       * 这条是整个"版本选择"的关键证明：`create-vite` 生成的 package.json 里
       * react 是它模板里那一版（当前 ^19.2.8）—— 用户选的是 18，
       * 所以要**我们自己改**。测的正是"改了没有"，而不是"官方给没给"。
       */
      const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
      assert.check(
        String(manifest.dependencies.react).startsWith('^18.'),
        'React 版本被改成了 18（官方模板给的是 19）',
        `${manifest.dependencies.react} / ${manifest.dependencies['react-dom']}`,
      );
      assert.check(
        String(manifest.dependencies['react-dom']).startsWith('^18.'),
        'react-dom 跟着一起改（只改一个会版本错配）',
      );
      assert.check(
        manifest.engines?.node === '^20.19.0 || >=22.12.0',
        '官方没写 engines 时，我们补上 Node 要求',
        manifest.engines,
      );
      assert.check(text.includes('版本：'), '作业日志里写了改了哪个版本');
      await api.del(`/api/v1/projects/${project.id}`);
    }

    /* ---------- 5) Django：先建 venv 装 Django，再 django-admin startproject ---------- */
    {
      const { project, dir } = await createProject('probe-django');
      const job = await api.post('/api/v1/jobs', {
        type: 'scaffold',
        payload: {
          projectId: project.id,
          targets: [{ templateId: 'django', port: 5304, selections: { version: '4-2-lts' } }],
        },
      });
      // 这条路要建 venv + pip 装 Django，比 npm 那几条慢
      const finished = await waitJob(api, job.id, 12 * 60 * 1000);
      const text = await logsOf(job.id);
      assert.equal(finished.status, 'succeeded', text.slice(-800));

      /*
       * 关键：**真的走了官方那条路**（而不是悄悄回退到内置骨架）。
       * 回退路径也会"成功"，所以必须两侧都断言：有"官方脚手架生成完成"、
       * 且**没有**"改用内置骨架" —— 这条纪律上一刀就吃过一次亏。
       */
      assert.check(text.includes('官方脚手架生成完成'), 'Django 走的是官方 django-admin');
      assert.check(!text.includes('改用内置骨架'), 'Django 没有回退到内置骨架');
      assert.check(text.includes('建虚拟环境') || text.includes('复用已有'), '日志里能看到 venv 那一步');
      assert.check(text.includes('装 Django'), '日志里说明这一步要联网装 Django');

      assert.check(fs.existsSync(path.join(dir, 'manage.py')), 'django-admin 生成了 manage.py');
      /*
       * 找"哪个目录里有 settings.py"，而不是取 `readdirSync()[0]`：
       * 项目文件夹里本来就有 `attachments/`、`logs/`（建项目时铺的）以及 `.venv`，
       * 按下标取会取到它们 —— 第一版就是这么写的，报出来是"没有 settings.py"，
       * 看着像 startproject 没生成成功，其实只是取错了目录。
       */
      const packageDir = fs
        .readdirSync(dir)
        .find((name) => fs.existsSync(path.join(dir, name, 'settings.py')));
      assert.check(
        typeof packageDir === 'string',
        'startproject 生成了项目包（里面有 settings.py）',
        fs.readdirSync(dir),
      );
      assert.check(
        fs.existsSync(path.join(dir, 'manage.py')) && Boolean(packageDir),
        '是一个能跑的 Django 项目（manage.py + 包目录）',
      );
      // 版本：用户选的是 4.2 LTS，requirements.txt 里就得是它
      const requirements = fs.readFileSync(path.join(dir, 'requirements.txt'), 'utf8');
      assert.check(
        requirements.includes('>=4.2,<5'),
        'requirements.txt 写的是用户选的版本（4.2 LTS）',
        requirements,
      );
      assert.check(
        fs.existsSync(path.join(dir, '.venv')),
        'venv 建在项目文件夹里（后面的"装依赖"会复用它）',
      );
      await api.del(`/api/v1/projects/${project.id}`);
    }
  },
};
