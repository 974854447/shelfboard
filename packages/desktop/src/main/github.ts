/**
 * GitHub 绑定的**预留接口**。
 *
 * 需求背景：用户 2026-09-25 要求「设置里预留绑定 github 的接口」。
 * Git 集成在需求文档里整体排在 **M6**（见 requirements §7），所以这一版**不做 OAuth 流程**，
 * 但把接口的形状、状态的存放位置、以及"令牌怎么存才安全"先定下来 ——
 * 这样以后再动手时，改的是实现，不是契约。
 *
 * ## 现在能用的部分
 *
 * - `getGithubStatus()`：读绑定状态（界面靠它显示"已绑定 / 未绑定"）
 * - `disconnectGithub()`：解除绑定（清掉状态与令牌文件）—— 这个是真的能用
 * - `beginGithubConnect()`：**如实返回"尚未实现"**，并带上计划中的做法
 *
 * 刻意不做的事：**不假装成功**。一个点了没反应、或者返回假状态的按钮，
 * 比一个明确说"还没做"的按钮糟糕得多（用户会以为绑好了，然后等着一堆不存在的功能）。
 *
 * ## 实现时要注意的三件事（先写在这里，免得到时候重新踩）
 *
 * 1. **令牌绝不写进 `config.json`**。那是明文 JSON：会被备份、会被打进诊断包、
 *    也可能被用户随手发给别人。要用 Electron 的 `safeStorage.encryptString()` 加密后
 *    单独存一个文件（例如 `<userData>/github.credential`），并且**任何日志都不打印它**。
 * 2. **走 OAuth Device Flow**，不要内嵌 client secret。桌面应用里的 secret 一定保不住；
 *    Device Flow 只需要一个公开的 client id，用户在浏览器里输一次验证码即可 ——
 *    也不需要起本地回调服务器（少一个端口、少一类安全问题）。
 * 3. **作用域要最小**：只申请实际用到的（私有仓库 `repo`，公开只读 `public_repo`）。
 *    申请一堆用不上的权限，用户点"绑定"时会看到一长串吓人的授权项。
 *
 * 另外：主进程里可以直接用 `fetch`（Electron 44 / Node 22 自带），
 * 所以实现 Device Flow **不需要引入任何新的依赖**。
 */

import { existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';

import type { AppPreferences } from './app-config';

/** 令牌文件的存放位置（加密后的内容；实现 Device Flow 时用它） */
export function githubCredentialPath(userDataDir: string): string {
  return join(userDataDir, 'github.credential');
}

/** 界面需要的绑定状态：**只回答"绑没绑、绑的是谁"，不包含任何令牌信息** */
export interface GithubStatus {
  connected: boolean;
  login: string | null;
  hasToken: boolean;
  connectedAt: number | null;
  /**
   * 这一版是否支持"绑定"这个动作。
   *
   * 界面据此决定按钮是"可点但会说明未实现"还是"正常绑定" ——
   * 把这个开关放在接口里而不是写死在界面上，实现之后只要改这一处。
   */
  available: boolean;
  /** 未实现时的说明（直接给用户看的人话） */
  unavailableReason: string | null;
}

export function getGithubStatus(
  preferences: AppPreferences,
  userDataDir: string,
): GithubStatus {
  const state = preferences.github;
  const credentialFile = githubCredentialPath(userDataDir);

  return {
    connected: state.connected,
    login: state.login,
    // 以**文件是否存在**为准：配置里写着 hasToken、文件却被删了（或反过来），
    // 都说明状态不一致，界面宁可显示"未绑定"也不要骗人
    hasToken: state.hasToken && existsSync(credentialFile),
    connectedAt: state.connectedAt,
    available: false,
    unavailableReason:
      'GitHub 绑定尚未实现（Git 集成排在 M6）。这里先把入口和状态留出来：' +
      '实现后会走 OAuth 设备码授权，令牌用系统加密后单独保存，不会写进配置文件。',
  };
}

/**
 * 开始绑定。
 *
 * **这一版如实返回"尚未实现"**，不抛异常：调用方（界面）需要区分
 * "功能没做"与"操作失败"，抛异常会让两件事在日志里长得一样。
 */
export function beginGithubConnect(): { ok: false; reason: string } {
  return {
    ok: false,
    reason:
      '尚未实现：GitHub 绑定排在 M6（Git 集成）。届时用 OAuth 设备码授权，' +
      '不需要你在这里填令牌。',
  };
}

/**
 * 解除绑定：清掉本地状态与令牌文件。
 *
 * 这个动作**现在就是完整的**（不依赖 OAuth）：不管当初怎么绑上的，
 * "解绑"要保证本地不再留任何凭据。返回是否真的删掉了令牌文件。
 */
export function disconnectGithub(userDataDir: string): { removedCredential: boolean } {
  const file = githubCredentialPath(userDataDir);
  const existed = existsSync(file);
  if (existed) rmSync(file, { force: true });
  return { removedCredential: existed };
}
