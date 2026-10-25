/**
 * 托盘图标与菜单。
 *
 * 图标**用代码生成**而不是引入图片资源：Tray 需要一个非空图像，
 * 而仓库里维护一份二进制图标既不利于审查、也容易在打包时漏掉。
 *
 * 绘制逻辑在 `tray-icon.ts`（不依赖 electron，可单测）；
 * 这里只负责把它交给 Electron。
 */

import { app, Menu, nativeImage, Tray, type NativeImage } from 'electron';

import { renderTrayBitmap } from './tray-icon';

export function createTrayIcon(size = 32): NativeImage {
  const bitmap = renderTrayBitmap(size);
  // 注意：createFromBitmap 在 Windows 上要求 BGRA 顺序，由 renderTrayBitmap 保证
  return nativeImage.createFromBitmap(bitmap.buffer, {
    width: bitmap.width,
    height: bitmap.height,
  });
}

export interface TrayControllerOptions {
  onShowWindow: () => void;
  onOpenWorkspace: () => void;
  onQuit: () => void;
  tooltip: string;
}

export interface TrayController {
  tray: Tray;
  destroy(): void;
}

export function createTrayController(options: TrayControllerOptions): TrayController {
  const tray = new Tray(createTrayIcon());

  const menu = Menu.buildFromTemplate([
    { label: '显示主窗口', click: options.onShowWindow },
    { label: '打开工作区目录', click: options.onOpenWorkspace },
    { type: 'separator' },
    // 这是**唯一**真正退出的入口：点窗口关闭按钮只会最小化到这里
    { label: '退出 项目管理系统', click: options.onQuit },
  ]);

  tray.setToolTip(options.tooltip);
  tray.setContextMenu(menu);
  // 左键单击也唤回窗口：多数用户的第一反应是单击而不是右键
  tray.on('click', options.onShowWindow);

  return {
    tray,
    destroy: () => {
      tray.destroy();
    },
  };
}

/**
 * 托盘提示里带上版本与环境，方便用户报问题时一眼看到。
 *
 * 环境**只在非正式环境**写进来（用户 2026-10-01：正式环境不必再挂这个标签）：
 * 测试环境与正式环境的数据是两套 —— 看不出在哪个环境，就会对着测试数据找正式数据；
 * 而正式环境是常态，标出来只是噪音。传空串即表示"不显示环境"。
 */
export function trayTooltip(version: string, workspacePath: string, environmentLabel: string): string {
  const suffix = environmentLabel === '' ? '' : `（${environmentLabel}）`;
  return `项目管理系统 ${version}${suffix}\n工作区：${workspacePath}\n右键打开菜单，退出需从菜单选择`;
}

export function appDisplayName(): string {
  return app.getName();
}
