/**
 * 应用级状态：启动信息与全局错误。
 *
 * 全局错误的形态是刻意设计的：**必须携带 traceId**。
 * 界面上任何一处出错，用户都能看到「错误码 + traceId」并一键跳到日志现场 ——
 * 这是验收标准里那条可观测性要求的渲染侧落点。
 */

import { defineStore } from 'pinia';
import { computed, ref } from 'vue';

import { ApiError } from '../api/client';
import { ensureApiClient, refreshBootstrap, type BootstrapInfo } from '../api/bootstrap';

export interface UiError {
  message: string;
  code: string;
  traceId: string | null;
  /** 出错时间，用于界面显示"刚刚/几分钟前" */
  at: number;
}

/** 把任意异常统一成界面可直接展示的形态 */
export function toUiError(error: unknown): UiError {
  if (error instanceof ApiError) {
    return {
      message: error.message,
      code: error.code,
      traceId: error.traceId ?? null,
      at: Date.now(),
    };
  }
  if (error instanceof Error) {
    return { message: error.message, code: 'CLIENT_ERROR', traceId: null, at: Date.now() };
  }
  return { message: String(error), code: 'CLIENT_ERROR', traceId: null, at: Date.now() };
}

export const useAppStore = defineStore('app', () => {
  const booting = ref(true);
  const ready = ref(false);
  const info = ref<BootstrapInfo | null>(null);
  const bootError = ref<UiError | null>(null);

  const lastError = ref<UiError | null>(null);

  const workspaceName = computed(() => {
    const root = info.value?.workspaceRoot ?? '';
    const parts = root.split(/[\\/]/).filter(Boolean);
    return parts.at(-1) ?? root;
  });

  async function boot(): Promise<void> {
    booting.value = true;
    bootError.value = null;
    try {
      const { info: payload } = await ensureApiClient();
      info.value = payload;
      ready.value = true;
    } catch (error) {
      bootError.value = toUiError(error);
      ready.value = false;
    } finally {
      booting.value = false;
    }
  }

  /**
   * 重新拉启动信息。
   *
   * 切换工作区目录之后必须调一次：启动信息里的 `workspaceRoot` 变了，
   * 而启动信息是带缓存的（见 api/bootstrap.ts），不刷新的话界面会一直显示旧路径。
   */
  async function refreshInfo(): Promise<void> {
    const payload = await refreshBootstrap();
    if (payload) info.value = payload;
  }

  /** 记录一次错误并返回它，便于调用方 `throw reportError(e)` 之后仍能拿到结果 */
  function reportError(error: unknown): UiError {
    const ui = toUiError(error);
    lastError.value = ui;
    return ui;
  }

  function clearError(): void {
    lastError.value = null;
  }

  return {
    booting,
    ready,
    info,
    bootError,
    lastError,
    workspaceName,
    boot,
    refreshInfo,
    reportError,
    clearError,
  };
});
