/**
 * 交互反馈的统一入口。
 *
 * 集中在这里的原因有两条：
 *
 * 1. **危险操作必须走确认**。之前删除项目是立即执行的 —— 这类入口一旦散落
 *    在各视图里，就总会有人忘了加确认。统一走 `confirm()`，至少让"忘记"
 *    变成一件需要刻意为之的事。
 * 2. **错误提示必须带 traceId**。Toast 只有几秒，所以要同时把错误交给
 *    `ErrorBanner`（它在屏幕上停留，并提供"查看日志"跳转）。
 *
 * 注意：`useDialog` / `useMessage` 只能在 Provider 内部调用，
 * 因此这个组合式函数也只能在 `AppShell` 之下的组件里用。
 */

import { useDialog, useMessage } from 'naive-ui';
import { h } from 'vue';

import { ApiError } from '../api/client';
import { useAppStore } from '../stores/app';

export interface ConfirmOptions {
  title: string;
  content: string;
  positiveText?: string;
  negativeText?: string;
  /** 危险操作：用红色按钮并回车默认取消 */
  danger?: boolean;
}

export interface AlertOptions {
  title: string;
  content: string;
  positiveText?: string;
}

export interface Feedback {
  confirm(options: ConfirmOptions): Promise<boolean>;
  /**
   * 只告知、**不可继续**的警告弹窗（只有一个按钮）。
   *
   * 和 `confirm()` 的区别是"有没有第二个选择"：删除有子任务的主任务这种事
   * 用 confirm 表达是错的 —— 摆出一个"取消"按钮会让人以为"再点一次就能删"。
   */
  alert(options: AlertOptions): Promise<void>;
  success(text: string): void;
  info(text: string): void;
  warning(text: string): void;
  /** 把任意异常转成提示；同时把错误登记到全局横幅（带 traceId 与日志跳转） */
  failure(error: unknown, fallback?: string): void;
}

/** 从异常里取一句适合展示的话，并带上 traceId（如果服务端给了） */
export function describeError(error: unknown): { text: string; traceId: string | null } {
  if (error instanceof ApiError) {
    return {
      text: `[${error.code}] ${error.message}`,
      traceId: error.traceId ?? null,
    };
  }
  if (error instanceof Error) return { text: error.message, traceId: null };
  return { text: String(error), traceId: null };
}

export function useFeedback(): Feedback {
  const dialog = useDialog();
  const message = useMessage();
  const app = useAppStore();

  function confirm(options: ConfirmOptions): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      // 用一个标志保证只结算一次：Naive 在确认时会同时触发 onPositiveClick
      // 与 onClose，不防重的话 Promise 会被重复 resolve（虽然无害，
      // 但"看起来只调了一次"的语义更容易推理）
      let settled = false;
      const finish = (value: boolean): void => {
        if (settled) return;
        settled = true;
        resolve(value);
      };

      const instance = options.danger ? dialog.error : dialog.warning;
      instance({
        title: options.title,
        content: options.content,
        positiveText: options.positiveText ?? '确定',
        negativeText: options.negativeText ?? '取消',
        // 危险操作把焦点默认放在"取消"上，回车不会误删
        autoFocus: !options.danger,
        onPositiveClick: () => finish(true),
        onNegativeClick: () => finish(false),
        onClose: () => finish(false),
        onMaskClick: () => finish(false),
      });
    });
  }

  function alert(options: AlertOptions): Promise<void> {
    return new Promise<void>((resolve) => {
      let settled = false;
      const finish = (): void => {
        if (settled) return;
        settled = true;
        resolve();
      };

      dialog.warning({
        title: options.title,
        content: options.content,
        positiveText: options.positiveText ?? '知道了',
        // 刻意不传 negativeText：Naive 只在 negativeText 有值时才渲染取消按钮，
        // 于是这里只剩一个"知道了" —— 界面本身就表达了"这件事没得商量"
        onPositiveClick: () => finish(),
        onClose: () => finish(),
        onMaskClick: () => finish(),
      });
    });
  }

  function failure(error: unknown, fallback = '操作失败'): void {
    // 登记到全局横幅：它带 traceId 且提供「查看日志」，且不会自动消失
    app.reportError(error);

    const { text, traceId } = describeError(error);
    message.error(
      () =>
        h('div', { style: 'display:grid;gap:2px;max-width:380px' }, [
          h('div', text === fallback ? fallback : text),
          traceId
            ? h(
                'div',
                { style: 'font-size:11px;opacity:.7;font-family:Consolas,monospace' },
                `traceId: ${traceId}`,
              )
            : null,
        ]),
      { duration: 5000 },
    );
  }

  return {
    confirm,
    alert,
    failure,
    success: (text) => message.success(text),
    info: (text) => message.info(text),
    warning: (text) => message.warning(text),
  };
}
