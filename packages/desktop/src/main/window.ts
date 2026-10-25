/**
 * 主窗口。
 *
 * 安全基线（对应 technical-design §7）：`contextIsolation` 开、
 * `nodeIntegration` 关、`sandbox` 开，且只通过 preload 的白名单通信。
 *
 * 窗口关闭行为：**关闭 = 隐藏到托盘**，不退出应用。
 * 真正退出只能从托盘菜单走 —— 这是产品明确要求的行为（见需求 §4.4）。
 */

import { BrowserWindow, nativeImage, shell } from 'electron';

import { renderAppIconBitmap } from './tray-icon';

export interface MainWindowOptions {
  preloadPath: string;
  /** 内嵌服务地址（生产环境与开发环境都加载它，保证与 API 同源） */
  baseUrl: string;
  /** 开发环境下 Vite dev server 的地址；提供时优先加载它以获得热更新 */
  devServerUrl?: string | undefined;
  /** 是否处于"正在退出"状态；为 true 时关闭不再拦截 */
  isQuitting: () => boolean;
  onClosed: () => void;
  /** 窗口被关到托盘时回调（用于记日志） */
  onHiddenToTray?: () => void;
}

/**
 * 窗口/任务栏图标。
 *
 * 打包后任务栏与资源管理器读的是 exe 内嵌的 `build/icon.ico`；
 * 但**开发运行时没有 exe 内嵌图标**，不显式给窗口设一个，任务栏上就是默认的 Electron 图标。
 * 两者由同一份几何生成（`brand-mark.ts`），所以不会出现"开发时一个样、装完另一个样"。
 */
function windowIcon(): Electron.NativeImage {
  const bitmap = renderAppIconBitmap(256);
  return nativeImage.createFromBitmap(bitmap.buffer, {
    width: bitmap.width,
    height: bitmap.height,
  });
}

export function createMainWindow(options: MainWindowOptions): BrowserWindow {
  const window = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 960,
    minHeight: 640,
    show: false, // 等 ready-to-show，避免白屏闪一下
    autoHideMenuBar: true,
    backgroundColor: '#18181c',
    icon: windowIcon(),
    webPreferences: {
      preload: options.preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      spellcheck: false,
    },
  });

  window.once('ready-to-show', () => {
    window.show();
  });

  window.on('close', (event) => {
    if (options.isQuitting()) return;
    // 关闭按钮 → 最小化到托盘。托盘菜单里的"退出"才是真的退出。
    event.preventDefault();
    window.hide();
    options.onHiddenToTray?.();
  });

  window.on('closed', options.onClosed);

  // 渲染进程崩溃时不要让窗口变成一片空白：给一条可排查的提示
  window.webContents.on('render-process-gone', (_event, details) => {
    void window.webContents
      .loadURL(`${options.baseUrl}/__degraded`)
      .catch(() => undefined);
    void details;
  });

  // 外部链接交给系统浏览器，不在应用内开新窗口
  window.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: 'deny' };
  });

  const target = options.devServerUrl ?? options.baseUrl;
  void window.loadURL(target);

  return window;
}

/** 安全地唤回窗口：已销毁或最小化时都能恢复 */
export function focusWindow(window: BrowserWindow | null): void {
  if (!window || window.isDestroyed()) return;
  if (window.isMinimized()) window.restore();
  if (!window.isVisible()) window.show();
  window.focus();
}
