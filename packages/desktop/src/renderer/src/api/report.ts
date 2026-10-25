/**
 * 渲染进程异常上报。
 *
 * 前端既不能写文件也不能写数据库，异常只能经 API 转交给服务端日志管道
 * （服务端会把 source 记为 `renderer`）。
 *
 * 两条纪律：
 * 1. **尽力而为，绝不再抛**。上报失败若继续抛出，会触发新的异常处理，
 *    形成无限递归 —— 那比丢掉一条日志严重得多。
 * 2. **启动未完成时不报**。客户端还没建好就上报，只会得到一连串
 *    无意义的网络错误，把真正的问题淹没。
 */

import type { App } from 'vue';

import { isReady } from './bootstrap';
import { logs } from './endpoints';

export function reportRendererLog(
  level: 'error' | 'warn' | 'info' | 'debug',
  message: string,
  detail?: string,
  scope?: string,
): void {
  if (!isReady()) return;

  void logs
    .reportClientLog({
      level,
      message: message.slice(0, 2000),
      ...(detail ? { detail: detail.slice(0, 20_000) } : {}),
      ...(scope ? { scope } : {}),
    })
    .catch(() => {
      // 上报失败就此打住，绝不再抛
    });
}

function describe(error: unknown): string {
  if (error instanceof Error) return error.stack ?? `${error.name}: ${error.message}`;
  if (typeof error === 'string') return error;
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

/**
 * 挂上三类全局异常钩子。
 *
 * 覆盖 Vue 组件内异常、普通未捕获错误、以及未处理的 Promise 拒绝 ——
 * 这三类如果不接，界面只会"没反应"，而控制台里的东西用户看不到。
 */
/**
 * 浏览器自身会发的一些告警，不该当成应用错误。
 *
 * 目前只有一条：`ResizeObserver loop completed with undelivered notifications`。
 * 它由浏览器的观察器机制产生（回调里改了布局导致同一帧内又有通知），
 * **不代表任何东西坏了** —— 但有两条真实后果：用户会在日志页看到一条 ERROR，
 * 错误横幅也可能被点亮，于是真问题被这类噪音淹没。
 *
 * 只过滤这一条明确无意义的；其余一律照常上报（宁可多报，不可漏报）。
 */
const BENIGN_ERROR_PATTERNS = [/ResizeObserver loop/i];

/**
 * 这条消息是不是"浏览器自己的无害告警"。
 *
 * **导出给日志页用**：过滤只能挡住"以后"不再上报，**挡不住表里已经存在的历史记录** ——
 * 用户升级之后打开日志页，那几条红色的 ResizeObserver 仍然躺在那儿，看起来问题还在
 * （实测正式库里就有 8 条这种历史噪音）。日志页据此把它们显示成灰色的「提示」，
 * 而不是继续当错误吓人。一份模式表、两处使用，避免两边判断不一致。
 */
export function isBenignMessage(message: string): boolean {
  return BENIGN_ERROR_PATTERNS.some((pattern) => pattern.test(message));
}

export function installGlobalErrorReporting(app: App): void {
  app.config.errorHandler = (error, _instance, info) => {
    const message = error instanceof Error ? error.message : String(error);
    reportRendererLog('error', `Vue 组件异常：${message}`, `${describe(error)}\n\n${info}`, 'vue');
    // eslint-disable-next-line no-console -- 开发时仍需在控制台可见
    console.error('[renderer] Vue 组件异常', error, info);
  };

  window.addEventListener('error', (event) => {
    const message = event.message ?? '';
    if (isBenignMessage(message)) {
      // eslint-disable-next-line no-console -- 控制台里留个痕，方便排查观察器问题时看到
      console.warn('[renderer] 忽略浏览器告警', message);
      return;
    }
    reportRendererLog(
      'error',
      `未捕获错误：${message}`,
      event.error ? describe(event.error) : `${event.filename}:${event.lineno}:${event.colno}`,
      'window',
    );
    // eslint-disable-next-line no-console
    console.error('[renderer] 未捕获错误', event.error ?? event.message);
  });

  window.addEventListener('unhandledrejection', (event) => {
    reportRendererLog('error', '未处理的 Promise 拒绝', describe(event.reason), 'promise');
    // eslint-disable-next-line no-console
    console.error('[renderer] 未处理的 Promise 拒绝', event.reason);
  });
}
