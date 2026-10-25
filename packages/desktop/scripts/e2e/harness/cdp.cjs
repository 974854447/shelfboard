/**
 * 极简 CDP 客户端。
 *
 * 为什么自己写而不用 puppeteer/playwright：这个项目的 E2E 只需要"连上已经在跑的 Electron、
 * 求值、点一下、截个图"，引一个带浏览器下载的框架不值得（而且 Electron 的启动方式、
 * 用户数据目录、原生模块都跟框架的假设不一样，接起来比自己写还长）。
 *
 * 三条纪律（都是踩过坑换来的）：
 *   1. **每个请求都带超时**。没等到响应就报错，绝不挂死 —— 一次挂死会让整轮测试白跑，
 *      而且分不清是"被测界面卡了"还是"脚本卡了"。
 *   2. **事件也收集**。断言失败时最需要知道的是"页面报了什么错、哪个请求失败了"，
 *      这些只能从事件里拿（见 diagnose.cjs）。
 *   3. `Runtime.evaluate` 的异常要**抛出来**，不要静默返回 undefined ——
 *      否则选择器写错会表现成"元素不存在"，把人往错误方向带。
 */

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.nextId = 0;
    this.pending = new Map();
    this.events = [];
  }

  static async connect(url, timeoutMs = 10000) {
    const ws = new WebSocket(url);
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('WebSocket 连接超时')), timeoutMs);
      ws.addEventListener('open', () => { clearTimeout(timer); resolve(); }, { once: true });
      ws.addEventListener('error', () => { clearTimeout(timer); reject(new Error('WebSocket 连接失败')); }, { once: true });
    });

    const cdp = new Cdp(ws);
    ws.addEventListener('message', (event) => {
      let message;
      try {
        message = JSON.parse(event.data);
      } catch {
        return; // 非 JSON，忽略
      }
      if (!message.id) {
        cdp.events.push(message);
        // 事件只留最近 500 条：一轮跑下来请求事件很多，留着全量没意义还占内存
        if (cdp.events.length > 500) cdp.events.shift();
        return;
      }
      const entry = cdp.pending.get(message.id);
      if (!entry) return;
      cdp.pending.delete(message.id);
      clearTimeout(entry.timer);
      if (message.error) entry.reject(new Error(`CDP ${entry.method}：${message.error.message}`));
      else entry.resolve(message.result);
    });
    return cdp;
  }

  send(method, params = {}, timeoutMs = 15000) {
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP ${method} 超时（${timeoutMs}ms）`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer, method });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  /** 求值；页面里抛异常时把异常抛给调用方（不要静默变成 undefined） */
  async evaluate(expression, { awaitPromise = false, timeoutMs = 15000 } = {}) {
    const result = await this.send(
      'Runtime.evaluate',
      { expression, returnByValue: true, awaitPromise },
      timeoutMs,
    );
    if (result.exceptionDetails) {
      const detail = result.exceptionDetails.exception?.description ?? result.exceptionDetails.text;
      throw new Error(`页面求值出错：${String(detail).split('\n')[0]}`);
    }
    return result.result?.value;
  }

  /** 求值并解析 JSON：页面上统一用 JSON.stringify 返回结构化数据，少一层转义麻烦 */
  async json(expression, options) {
    const raw = await this.evaluate(expression, options);
    if (typeof raw !== 'string') throw new Error(`期望页面返回 JSON 字符串，实际是 ${typeof raw}`);
    return JSON.parse(raw);
  }

  async screenshot(file, clip) {
    const result = await this.send(
      'Page.captureScreenshot',
      { format: 'png', fromSurface: true, ...(clip ? { clip } : {}) },
      // 截图给足时间：机器忙的时候 20s 也可能不够，而这一条失败会掩盖真正的断言结果
      30000,
    );
    const { writeFileSync, mkdirSync } = require('node:fs');
    const { dirname } = require('node:path');
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, Buffer.from(result.data, 'base64'));
    return file;
  }

  /** 取某类事件（诊断用）：`eventsOf('Runtime.consoleAPICalled')` */
  eventsOf(method) {
    return this.events.filter((event) => event.method === method);
  }

  clearEvents() {
    this.events = [];
  }

  close() {
    try {
      this.ws.close();
    } catch {
      // 忽略
    }
  }
}

/** 等 Electron 的调试目标出现；应用启动慢（打包版要解 asar、跑迁移）所以给足超时 */
async function findPageTarget(port, timeoutMs = 60000) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json`, { signal: AbortSignal.timeout(2000) });
      const page = (await response.json()).find((target) => target.type === 'page');
      if (page) return page;
    } catch (error) {
      lastError = error;
    }
    await sleep(300);
  }
  throw new Error(`等待 CDP 目标超时（端口 ${port}）${lastError ? `，最后一次错误：${lastError.message}` : ''}`);
}

module.exports = { Cdp, findPageTarget, sleep };
