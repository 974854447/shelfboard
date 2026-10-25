/**
 * 失败现场收集。
 *
 * 上一代脚本失败时只给一句话（比如"没找到卡片"），然后人得自己另写脚本去查为什么 ——
 * 我这一轮为了查"打包版路由内容空白"就多写了两个诊断脚本。这一步应该由框架自动做掉。
 *
 * 收集的东西都是"下次能直接定位问题"的：
 *   - 页面异常 / console 错误（Runtime.exceptionThrown、consoleAPICalled）
 *   - 失败请求与 4xx/5xx（Network.loadingFailed、responseReceived）
 *   - 路由与视图锚点的实际状态（hash、每个 data-view 在不在、内容区长度）
 *   - 页面实际发出的资源请求（Resource Timing）—— 用来回答"chunk 到底请求了没有"
 *   - 应用自己的文件日志尾部（main.log）—— 主进程侧发生了什么
 *   - 一张截图
 *
 * 统一落到 `<artifactsDir>/<场景>-诊断.json` + `.png`，并在控制台打印摘要。
 */

const fs = require('node:fs');
const path = require('node:path');

async function collectDiagnostics({ cdp, artifactsDir, label, page, logTail }) {
  const result = {
    label,
    at: new Date().toISOString(),
    route: null,
    pageErrors: [],
    consoleErrors: [],
    networkFailures: [],
    httpErrors: [],
    resources: [],
    logTail: null,
    screenshot: null,
  };

  try {
    result.route = await cdp.json(
      `(() => JSON.stringify({
        hash: location.hash,
        title: document.title,
        views: [...document.querySelectorAll('[data-view]')].map((el) => el.getAttribute('data-view')),
        contentLength: (document.querySelector('.n-layout-content')?.innerHTML || '').length,
        bodyText: (document.body.innerText || '').replace(/\\s+/g, ' ').slice(0, 300),
        resources: performance.getEntriesByType('resource')
          .map((entry) => (entry.name.split('/').pop() || '') + '=' + (entry.responseStatus ?? '?') + '/' + Math.round(entry.duration) + 'ms')
          .slice(-15),
      }))()`,
    );
    result.resources = result.route.resources;
  } catch (error) {
    result.route = { error: error.message };
  }

  for (const event of cdp.eventsOf('Runtime.exceptionThrown')) {
    result.pageErrors.push(String(event.params.exceptionDetails?.exception?.description ?? event.params.exceptionDetails?.text).slice(0, 400));
  }
  for (const event of cdp.eventsOf('Runtime.consoleAPICalled')) {
    if (event.params.type !== 'error') continue;
    result.consoleErrors.push((event.params.args ?? []).map((arg) => arg.value ?? arg.description ?? '').join(' ').slice(0, 400));
  }
  for (const event of cdp.eventsOf('Log.entryAdded')) {
    if (event.params.entry.level !== 'error') continue;
    result.consoleErrors.push(`[log] ${event.params.entry.text}`.slice(0, 400));
  }
  for (const event of cdp.eventsOf('Network.loadingFailed')) {
    result.networkFailures.push(`${event.params.errorText} type=${event.params.type}`);
  }
  for (const event of cdp.eventsOf('Network.responseReceived')) {
    if (event.params.response.status < 400) continue;
    result.httpErrors.push(`HTTP ${event.params.response.status} ${event.params.response.url}`);
  }

  if (logTail) result.logTail = logTail();
  if (page) {
    const file = path.join(artifactsDir, `${sanitize(label)}-诊断.png`);
    try {
      result.screenshot = await page.screenshot(file);
    } catch (error) {
      result.screenshot = `截图失败：${error.message}`;
    }
  }

  const file = path.join(artifactsDir, `${sanitize(label)}-诊断.json`);
  fs.writeFileSync(file, JSON.stringify(result, null, 2), 'utf8');

  /* --- 控制台摘要：只印"有内容"的那几段，避免刷屏 --- */
  process.stdout.write(`\n  ── 失败现场 ──\n`);
  if (result.route && !result.route.error) {
    process.stdout.write(`  路由：${result.route.hash}｜视图锚点=[${(result.route.views ?? []).join(', ')}]｜内容区长度=${result.route.contentLength}\n`);
    if (result.route.bodyText) process.stdout.write(`  可见文字：${result.route.bodyText.slice(0, 160)}\n`);
    if (result.resources?.length) process.stdout.write(`  最近的资源：${result.resources.join(' | ')}\n`);
  }
  if (result.pageErrors.length) process.stdout.write(`  页面异常：\n    - ${result.pageErrors.join('\n    - ')}\n`);
  if (result.consoleErrors.length) process.stdout.write(`  console 错误：\n    - ${[...new Set(result.consoleErrors)].slice(0, 5).join('\n    - ')}\n`);
  if (result.networkFailures.length) process.stdout.write(`  失败请求：\n    - ${[...new Set(result.networkFailures)].join('\n    - ')}\n`);
  if (result.httpErrors.length) process.stdout.write(`  HTTP 错误：\n    - ${[...new Set(result.httpErrors)].join('\n    - ')}\n`);
  if (result.logTail) {
    const tail = result.logTail.split('\n').filter((line) => /ERROR|WARN|失败|error/i.test(line)).slice(-5);
    process.stdout.write(`  主进程日志（错误/告警）：\n    - ${(tail.length ? tail : ['（无错误行）']).join('\n    - ')}\n`);
  }
  process.stdout.write(`  完整现场：${file}\n\n`);

  return result;
}

function sanitize(label) {
  return String(label).replace(/[^\w\u4e00-\u9fa5-]+/g, '_');
}

module.exports = { collectDiagnostics };
