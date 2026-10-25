/**
 * 场景：脚手架（M4）—— **离线可用**的那条路径。
 *
 * 这一版真正接上的是「内置模板」：FastAPI 官方没有脚手架，所以它本来就只能靠内置模板；
 * 而 Vue / NestJS / Django 的官方 CLI 要联网（`npm create…` / `npx @nestjs/cli`），
 * 在端到端里跑它等于把测试绑在网络和 npm 上 —— 所以这里只测内置模板这条，
 * 它同时也验证了整条链路：**建作业 → 执行 → 写盘 → 状态回传**（界面那条由 create-project 场景覆盖）。
 *
 * 断言里最重要的一条是"文件真的到了项目文件夹里"，而不是"作业成功了"：
 * 前者才是用户要的结果。
 */

const path = require('node:path');
const fs = require('node:fs');

module.exports = {
  name: 'scaffold',
  title: '脚手架：内置 FastAPI 模板生成到项目文件夹',
  needsProject: true,

  async run({ assert, api, data, cdp }) {
    /* ---------- 准备：项目文件夹 + 工作区根目录 ---------- */
    const projects = await api.get('/api/v1/projects');
    const project = (projects.items ?? projects).find((item) => item.id === data.project.id);
    assert.check(Boolean(project?.folder), '播种的项目有文件夹（0.1.2 起一个项目一个文件夹）', project?.folder);

    const info = await cdp.json('(async () => JSON.stringify(await window.pmStudio.getBootstrap()))()', {
      awaitPromise: true,
    });
    const projectDir = path.join(info.workspaceRoot, project.folder);
    assert.check(fs.existsSync(projectDir), '项目文件夹在工作区里真实存在');

    // 项目文件夹里本来就有 attachments / logs：生成骨架不能把它们弄没
    assert.check(fs.existsSync(path.join(projectDir, 'attachments')), '生成前：项目自带 attachments/');

    const mainPy = path.join(projectDir, 'app', 'main.py');
    assert.check(!fs.existsSync(mainPy), '生成前：还没有 app/main.py（避免"其实上次生成过"）');

    /* ---------- 1) 建一个脚手架作业 ---------- */
    const job = await api.post('/api/v1/jobs', {
      type: 'scaffold',
      payload: { projectId: data.project.id, targets: [{ templateId: 'fastapi' }], port: 8100 },
    });
    assert.check(Boolean(job.id), '作业建出来了');
    assert.check(
      (job.title || '').includes('FastAPI'),
      '作业标题里带技术栈（作业中心一眼看出在生成什么）',
      job.title,
    );

    /* ---------- 2) 等它跑完 ---------- */
    let finished = null;
    for (let attempt = 0; attempt < 60; attempt += 1) {
      const current = await api.get(`/api/v1/jobs/${job.id}`);
      if (['succeeded', 'failed', 'canceled', 'interrupted'].includes(current.status)) {
        finished = current;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    assert.check(finished !== null, '作业在 30 秒内结束');
    assert.equal(finished.status, 'succeeded', finished.errorMessage ?? '');
    assert.equal(finished.percent, 100, '进度到 100%');

    /* ---------- 3) 文件真的落到了项目文件夹里 ---------- */
    assert.check(fs.existsSync(mainPy), 'app/main.py 生成出来了', mainPy);
    assert.check(fs.existsSync(path.join(projectDir, 'requirements.txt')), 'requirements.txt 生成出来了');
    assert.check(fs.existsSync(path.join(projectDir, '.gitignore')), '.gitignore 生成出来了');
    assert.check(
      fs.existsSync(path.join(projectDir, 'attachments')),
      '项目自带的 attachments/ 没被生成过程动到',
    );

    const main = fs.readFileSync(mainPy, 'utf8');
    assert.check(main.includes('8100'), '模板里的端口被替换成了我们传的值', main.slice(0, 60));
    assert.check(!main.includes('__PROJECT_NAME__'), '模板变量都被替换了（没有残留占位符）');
    assert.check(
      fs.readFileSync(path.join(projectDir, '.gitignore'), 'utf8').includes('attachments/'),
      '生成的 .gitignore 挡掉了附件与日志目录（它们在代码目录里）',
    );

    /* ---------- 4) 日志里能看到它做了什么 ---------- */
    const logs = await api.get(`/api/v1/jobs/${job.id}/logs`);
    const text = logs.items.map((entry) => entry.message).join('\n');
    assert.check(text.includes('写入'), '作业日志写了"写入了多少文件"', text.slice(0, 80));
    assert.check(text.includes('app/main.py'), '作业日志逐个列出了写出的文件');

  },
};
