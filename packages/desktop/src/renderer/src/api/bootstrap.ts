/**
 * 启动信息与 API 客户端的单例装配。
 *
 * 渲染进程拿不到文件系统，访问内嵌服务所需的 **地址与令牌只能来自 preload**。
 * 这里把它们读一次、建好客户端，后续所有请求复用同一个实例。
 */

import { createApiClient, type ApiClient } from './client';

export interface BootstrapInfo {
  baseUrl: string;
  token: string;
  platform: string;
  version: string;
  workspaceRoot: string;
  theme: string;
  /** 运行环境：测试与正式是两套分开的数据，界面上要显示（见 main/environment.ts） */
  environment: 'test' | 'production' | 'custom';
  environmentLabel: string;
  /** 实际生效的数据目录 */
  userDataDir: string;
}

let client: ApiClient | null = null;
let info: BootstrapInfo | null = null;

export class BootstrapError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BootstrapError';
  }
}

/**
 * 建立客户端。
 *
 * 找不到 preload 桥时给出明确的排查方向，而不是抛一个 TypeError ——
 * 这种情况最可能的原因是窗口没带 preload 启动，或者 preload 构建失败。
 */
export async function ensureApiClient(): Promise<{ client: ApiClient; info: BootstrapInfo }> {
  if (client && info) return { client, info };

  const bridge = window.pmStudio;
  if (!bridge) {
    throw new BootstrapError(
      '未检测到 preload 桥（window.pmStudio）。请确认窗口以 preload 启动，且 preload 产物存在。',
    );
  }

  const payload = await bridge.getBootstrap();
  if (!payload.baseUrl || !payload.token) {
    throw new BootstrapError('启动信息不完整：缺少内嵌服务地址或访问令牌');
  }

  client = createApiClient({ baseUrl: payload.baseUrl, token: payload.token });
  info = payload;
  return { client, info };
}

export function getApiClient(): ApiClient {
  if (!client) throw new BootstrapError('API 客户端尚未初始化');
  return client;
}

export function getBootstrapInfo(): BootstrapInfo {
  if (!info) throw new BootstrapError('启动信息尚未就绪');
  return info;
}

export function isReady(): boolean {
  return client !== null && info !== null;
}

/**
 * 重新拉一次启动信息。
 *
 * 启动信息里带着工作区根目录、数据目录、版本 —— 这些平时不变，但**切换工作区目录**会变，
 * 而 `ensureApiClient()` 是带缓存的单例（它同时管着客户端与信息）。不额外给一个刷新入口，
 * 界面就会一直显示旧路径：用户刚把工作区换到 D 盘，侧栏底部却还写着旧的文件夹名。
 */
export async function refreshBootstrap(): Promise<BootstrapInfo | null> {
  const bridge = window.pmStudio;
  if (!bridge || !client) return null;
  const payload = await bridge.getBootstrap();
  info = payload;
  return payload;
}
