/**
 * 原型自检器：用 CDP 连上无头 Chrome，把页面里算好的排版报告取回来。
 *
 * 为什么不用 `chrome --dump-dom`：这个 Chrome 版本在新无头模式下不输出 DOM，
 * 而"卡片有没有互相压边"这种事靠看截图判断非常不可靠（缩放后 13px 的字根本看不清）。
 *
 * 用法：node docs/mock/check-mock.cjs ["expand=A,A2&focus=A2b"]
 */
'use strict';

const { spawn } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');

const CHROME_CANDIDATES = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
];

const PORT = 9333;

/**
 * 第一个参数支持两种写法：
 *   "expand=A,A2"                          → 用默认的 board-container-card.html
 *   "overview.html#check=1&drill=M0"       → 指定页面（原型多了之后要能选页面）
 */
const RAW_ARG = process.argv[2] ?? 'expand=A,A2';
const [PAGE_FILE, HASH_ARG] = RAW_ARG.includes('.html')
  ? RAW_ARG.split('#')
  : ['board-container-card.html', RAW_ARG];

const MOCK = path.join(__dirname, PAGE_FILE);
const USER_DATA = path.resolve(__dirname, '..', '..', '.tmp', 'chrome-mock-cdp');

function findChrome() {
  for (const p of CHROME_CANDIDATES) if (fs.existsSync(p)) return p;
  throw new Error('找不到 Chrome / Edge');
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitForDevtools(retries = 60) {
  for (let i = 0; i < retries; i += 1) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/json/list`);
      const list = await res.json();
      const page = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
      if (page) return page;
    } catch {
      /* 还没起来 */
    }
    await sleep(250);
  }
  throw new Error('调试端口一直没就绪');
}

/** 极简 CDP 客户端：够用就行（一条 Runtime.evaluate） */
function evaluate(wsUrl, expression) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    const timer = setTimeout(() => {
      ws.close();
      reject(new Error('evaluate 超时'));
    }, 30000);

    ws.addEventListener('open', () => {
      ws.send(JSON.stringify({
        id: 1,
        method: 'Runtime.evaluate',
        params: { expression, awaitPromise: true, returnByValue: true },
      }));
    });

    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(typeof ev.data === 'string' ? ev.data : String(ev.data));
      if (msg.id !== 1) return;
      clearTimeout(timer);
      ws.close();
      if (msg.result?.exceptionDetails) {
        reject(new Error(msg.result.exceptionDetails.text + ' :: ' + (msg.result.exceptionDetails.exception?.description ?? '')));
        return;
      }
      resolve(msg.result?.result?.value);
    });

    ws.addEventListener('error', () => {
      clearTimeout(timer);
      reject(new Error('WebSocket 出错'));
    });
  });
}

(async () => {
  const hash = HASH_ARG ?? '';
  const chrome = findChrome();
  fs.mkdirSync(USER_DATA, { recursive: true });

  const url = `file:///${MOCK.replace(/\\/g, '/')}#${hash}`;

  const child = spawn(chrome, [
    '--headless=new',
    '--disable-gpu',
    '--hide-scrollbars',
    '--no-first-run',
    '--no-default-browser-check',
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${USER_DATA}`,
    '--window-size=1600,1000',
    url,
  ], { stdio: 'ignore', detached: false });

  try {
    const page = await waitForDevtools();

    // 第二种用法：第三个参数是一段表达式，直接在页面里求值（用来模拟真实点击等交互）
    if (process.argv[3]) {
      await sleep(2000); // 等页面初始化完成
      const value = await evaluate(page.webSocketDebuggerUrl, process.argv[3]);
      console.log('HASH  ' + hash);
      console.log('EVAL  ' + String(value));
      return;
    }

    // 等页面把自检跑完（check=1 时页面自己在 2.6s 后写入 #selfcheck）
    const report = await evaluate(page.webSocketDebuggerUrl, `
      new Promise((resolve) => {
        const started = Date.now();
        const poll = () => {
          const el = document.getElementById('selfcheck');
          if (el) { resolve(el.textContent); return; }
          if (Date.now() - started > 12000) { resolve('NO-REPORT'); return; }
          setTimeout(poll, 200);
        };
        poll();
      })
    `);

    console.log('HASH  ' + hash);
    console.log(String(report).replace(/^SELFCHECK\s*/, 'REPORT '));
  } finally {
    child.kill();
    await sleep(300);
  }
})().catch((err) => {
  console.error('自检失败：' + err.message);
  process.exitCode = 1;
});
