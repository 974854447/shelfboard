/**
 * 场景共用的**文件系统夹具**。
 *
 * 这些函数造的是"项目文件夹里应该有什么"（package.json / vite.config / server.js /
 * node_modules），因为服务端的启动探测就是读这些文件来判断"这是什么项目、跑什么命令"。
 * 放在 harness 里而不是各场景各写一份：两个场景（`run-project`、`recycle-bin`）
 * 都要一个"能真的起来"的项目，两处各写一份迟早会分叉 ——
 * 而分叉后的表现是"一个场景过、另一个场景莫名失败"。
 */

const fs = require('node:fs');
const path = require('node:path');

/** 造一个"不需要装依赖就能跑"的最小 Node 项目 */
function seedRunnableProject(folder, port) {
  fs.mkdirSync(folder, { recursive: true });
  fs.writeFileSync(
    path.join(folder, 'package.json'),
    JSON.stringify({ name: 'e2e-runnable', private: true, scripts: { dev: 'node server.js' } }, null, 2),
    'utf8',
  );
  /*
   * 端口配置要写上：应用是**从 vite.config 里读端口**的（正常项目都有一份）。
   * 不写的话应用只能显示 vite 的默认值 5173，而进程实际监听 5199 ——
   * 那是测试数据不真实，不是产品的问题。
   */
  fs.writeFileSync(
    path.join(folder, 'vite.config.ts'),
    `export default { server: { port: ${port} } };\n`,
    'utf8',
  );
  fs.writeFileSync(
    path.join(folder, 'server.js'),
    [
      "const http = require('node:http');",
      `const server = http.createServer((_req, res) => res.end('ok'));`,
      /*
       * **绑 localhost**，不是 127.0.0.1 —— 这是照着真实 Vite 的行为写的：
       * Vite 默认绑 `localhost`，在这台机器上解析成 `::1`（IPv6 回环），
       * 于是 IPv4 的 127.0.0.1 上什么都没有。
       * 早期把种子服务绑在 127.0.0.1 上，于是"应用拼的 127.0.0.1 地址"看起来是对的，
       * 漏掉了用户真实遇到的"打不开"。
       */
      `server.listen(${port}, 'localhost', () => {`,
      `  console.log('  ➜  Local:   http://localhost:' + ${port} + '/');`,
      `});`,
      '',
    ].join('\n'),
    'utf8',
  );
  // 依赖检查看的是 node_modules 是否存在（这个项目本来就不需要依赖，直接建出来让它能立刻启动）
  fs.mkdirSync(path.join(folder, 'node_modules'), { recursive: true });
}

/** 缺依赖的项目：同样的文件，但**不建 node_modules**（这样"装依赖"才有活干） */
function seedBrokenProject(folder, port) {
  fs.mkdirSync(folder, { recursive: true });
  fs.writeFileSync(
    path.join(folder, 'package.json'),
    JSON.stringify({ name: 'e2e-needs-install', private: true, scripts: { dev: 'node server.js' } }, null, 2),
    'utf8',
  );
  fs.writeFileSync(
    path.join(folder, 'vite.config.ts'),
    `export default { server: { port: ${port} } };\n`,
    'utf8',
  );
  fs.writeFileSync(
    path.join(folder, 'server.js'),
    "const http = require('node:http');\nhttp.createServer((_req, res) => res.end('ok')).listen(0);\n",
    'utf8',
  );
  /*
   * 让这个测试项目**自成一个 pnpm workspace 根**。
   *
   * 端到端沙箱本身就在本仓库里面，而仓库根有 pnpm-workspace.yaml：
   * 不写这个文件的话，`pnpm install` 会往上找到仓库的 workspace、把依赖装到仓库根去，
   * 项目自己这里不会生成 node_modules —— 现象是"安装成功"但启动仍报"还没装依赖"
   * （实测就是这样，排查了好一阵）。真实用户的项目一般不在别的 workspace 里，
   * 所以这只是让夹具更贴近真实环境。
   */
  fs.writeFileSync(path.join(folder, 'pnpm-workspace.yaml'), 'packages: []\n', 'utf8');
}

/**
 * 端口上有没有人在监听（真实探测，不看应用的记录）。
 *
 * **两个回环都要试**：真实 Vite 只绑 `localhost`（这台机器上是 `::1`），
 * 只看 127.0.0.1 会得出"没在监听"的错误结论 —— 这正是早期漏掉的那个坑。
 */
function portInUse(port) {
  const probe = (host) =>
    new Promise((resolve) => {
      const socket = require('node:net').connect({ port, host });
      socket.on('connect', () => {
        socket.destroy();
        resolve(true);
      });
      socket.on('error', () => resolve(false));
      socket.setTimeout(800, () => {
        socket.destroy();
        resolve(false);
      });
    });
  return Promise.all([probe('127.0.0.1'), probe('::1')]).then((results) => results.some(Boolean));
}

module.exports = { seedRunnableProject, seedBrokenProject, portInUse };
