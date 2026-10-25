/**
 * preload：渲染进程与主进程之间唯一的通道。
 *
 * 安全纪律（对应 technical-design §7）：
 * - 只通过 `contextBridge` 暴露**明确列举**的能力，绝不暴露 `ipcRenderer` 本身。
 * - 不暴露任何文件系统、子进程能力。
 *
 * 关于 `initialPreferences`：它用 `sendSync` **同步**取回，这是刻意的 ——
 * 渲染层必须在首帧之前就知道该用亮色还是暗色主题，否则会先闪一下错误颜色。
 * 只在启动时取一次，主进程立即返回。
 */

import { contextBridge, ipcRenderer } from 'electron';

export interface BootstrapInfo {
  /** 内嵌服务的基地址，如 http://127.0.0.1:51234 */
  baseUrl: string;
  /** 一次性访问令牌；渲染进程每次请求都要带上 */
  token: string;
  platform: string;
  version: string;
  /** 当前工作区根目录（用于界面展示） */
  workspaceRoot: string;
  theme: string;
  /**
   * 运行环境。测试 / 正式用的**是两套完全分开的数据**（不同 userData 目录），
   * 所以界面上必须显示出来，否则用户分不清眼前这份数据是哪一套。
   */
  environment: 'test' | 'production' | 'custom';
  /** 环境的中文标签，直接用于界面显示 */
  environmentLabel: string;
  /** 实际生效的数据目录（排查"数据去哪了"时最有用的一条信息） */
  userDataDir: string;
  /** 「用编辑器打开」允许的命令白名单（设置页的下拉用；白名单只在主进程定义一份） */
  editorCommands: string[];
}

/**
 * GitHub 绑定状态（**预留接口**）。
 *
 * 注意这里**没有任何令牌字段** —— 令牌将来用系统加密单独存文件，
 * 连"是什么"都不经过渲染层，这里只回答"绑没绑、绑的是谁、有没有令牌"。
 */
export interface GithubStatusPayload {
  connected: boolean;
  login: string | null;
  hasToken: boolean;
  connectedAt: number | null;
  /** 这一版是否支持"绑定"这个动作；实现之后由主进程改成 true，界面不用动 */
  available: boolean;
  /** 未实现时给用户看的说明 */
  unavailableReason: string | null;
}

export interface WorkspaceSwitchReport {
  /** 切换后的工作区根目录 */
  workspaceRoot: string;
  /** 成功搬过去的项目文件夹名 */
  moved: string[];
  /** 目标位置已有同名文件夹、为避免覆盖而跳过的 */
  skipped: string[];
  /** 搬家失败的（例如跨盘），逐条带原因 */
  failed: { name: string; reason: string }[];
}

export interface PreferencesPayload {
  theme: 'light' | 'dark' | 'system';
  sidebarCollapsed: boolean;
  density: 'comfortable' | 'compact';
  /** 上次打开的项目 id；存在主进程配置里（localStorage 在此应用不可用） */
  lastProjectId: string | null;
  /** 新建项目的默认落点；null = 用工作区默认值 */
  defaultProjectRoot: string | null;
  /** 用哪个命令打开 IDE（取值受主进程白名单约束） */
  editorCommand: string;
  /**
   * 自动备份策略。
   *
   * ⚠️ **自动备份本身还没实现**（只有配置项）。设置页会如实标注这一点，
   * 不让用户以为"勾上就真的在备份"。
   */
  autoBackup: { enabled: boolean; intervalMinutes: number; keepCount: number };
  logging: {
    level: 'error' | 'warn' | 'info' | 'debug';
    retentionDays: number;
    fileMaxMB: number;
    fileKeepCount: number;
    /** 是否把日志里的用户名路径替换成 %USER% */
    redactUserName: boolean;
  };
  /** 工作日志（Word）的保存目录；null = 默认（`<文档>\项目管理系统\工作日志`） */
  workLogSaveDir: string | null;
  [key: string]: unknown;
}

/**
 * 同步取回偏好。
 *
 * 用 try/catch 包住：极端情况下（例如主进程尚未注册处理器）sendSync 会抛错，
 * 而"拿不到偏好"应当退化为"用默认主题"，绝不能让 preload 直接崩掉 ——
 * preload 崩了渲染层就连 API 都调不到，界面会彻底空白。
 */
function readInitialPreferences(): PreferencesPayload | null {
  try {
    const value: unknown = ipcRenderer.sendSync('preferences:get-sync');
    if (typeof value === 'object' && value !== null) return value as PreferencesPayload;
    return null;
  } catch {
    return null;
  }
}

const api = {
  /**
   * 启动时即可用的偏好（同步）。
   *
   * **不要用 localStorage 存偏好**：窗口加载的是
   * `http://127.0.0.1:<动态端口>`，而 origin 包含端口 ——
   * 端口每次启动都不同，localStorage 每次都是空的。
   */
  initialPreferences: readInitialPreferences(),

  /** 渲染进程启动时拉取一次；令牌不是敏感持久信息，不落盘 */
  getBootstrap: (): Promise<BootstrapInfo> => ipcRenderer.invoke('app:bootstrap'),

  getPreferences: (): Promise<PreferencesPayload | null> => ipcRenderer.invoke('preferences:get'),

  /** 局部更新偏好并落盘到 AppData 的 config.json */
  patchPreferences: (patch: Partial<PreferencesPayload>): Promise<PreferencesPayload | null> =>
    ipcRenderer.invoke('preferences:patch', patch),

  /** 隐藏到托盘（界面上的"最小化到托盘"按钮） */
  hideToTray: (): Promise<void> => ipcRenderer.invoke('window:hide'),

  /** 在系统文件管理器中打开工作区目录 */
  revealWorkspace: (): Promise<void> => ipcRenderer.invoke('workspace:reveal'),

  /** 检测本机装了哪些编辑器（设置页的下拉只列真正检测到的） */
  detectEditors: (): Promise<{ command: string; exe: string }[]> => ipcRenderer.invoke('editor:detect'),

  /** 开发环境检测：读缓存（没有就返回 null） */
  environmentStatus: (): Promise<unknown> => ipcRenderer.invoke('environment:status'),

  /** 开发环境检测：强制重测一遍（会派生 7~8 个子进程，用来取版本号） */
  detectEnvironment: (): Promise<unknown> => ipcRenderer.invoke('environment:detect'),

  /**
   * GitHub 绑定（**预留接口**，见 main/github.ts）。
   * 现在 `connectGithub` 会返回 `{ ok: false, reason: '尚未实现…' }` ——
   * 界面上因此能明确说"还没做"，而不是给一个点了没反应的按钮。
   */
  githubStatus: (): Promise<GithubStatusPayload> => ipcRenderer.invoke('github:status'),
  connectGithub: (): Promise<{ ok: false; reason: string }> => ipcRenderer.invoke('github:connect'),
  disconnectGithub: (): Promise<GithubStatusPayload> => ipcRenderer.invoke('github:disconnect'),

  /** 在系统文件管理器中打开应用数据目录（数据库、配置、日志都在里面） */
  revealUserDataDir: (): Promise<void> => ipcRenderer.invoke('app:reveal-userdata'),

  /** 弹出系统目录选择框；返回 null 表示用户取消 */
  chooseWorkspaceDir: (): Promise<string | null> => ipcRenderer.invoke('workspace:choose-dir'),

  /** 弹出目录选择框，用来指定工作日志（Word）的保存位置；null 表示取消 */
  chooseWorkLogDir: (): Promise<string | null> => ipcRenderer.invoke('worklog:choose-dir'),

  /** 在资源管理器里选中一个文件 */
  showItemInFolder: (path: string): Promise<boolean> => ipcRenderer.invoke('shell:show-item', path),

  /** 用系统默认程序打开一个文件（生成完工作日志后直接打开 Word） */
  openPath: (path: string): Promise<boolean> => ipcRenderer.invoke('shell:open-path', path),

  /** 切换工作区目录（可选把现有项目文件夹一起搬过去） */
  setWorkspaceRoot: (
    path: string,
    options?: { moveProjects?: boolean },
  ): Promise<WorkspaceSwitchReport> => ipcRenderer.invoke('workspace:set-root', path, options ?? {}),

  /** 立即备份一次数据库；返回生成的备份文件 */
  runBackup: (): Promise<{ file: string; pages: number }> => ipcRenderer.invoke('backup:run'),

  /** 打开备份目录 */
  revealBackups: (): Promise<void> => ipcRenderer.invoke('backup:reveal'),

  /** 重启应用（切换工作区目录后建议做一次，让所有组件读同一份配置） */
  relaunch: (): Promise<void> => ipcRenderer.invoke('app:relaunch'),

  /**
   * 订阅"工作区目录变了"。
   *
   * 只把**这一个事件**暴露出去，而不是把 ipcRenderer 交给渲染层 ——
   * 白名单式的桥是这套 preload 的纪律（见文件头）。返回取消订阅函数。
   */
  onWorkspaceChanged: (handler: (payload: { workspaceRoot: string }) => void): (() => void) => {
    const listener = (_event: unknown, payload: { workspaceRoot: string }): void => handler(payload);
    ipcRenderer.on('workspace:changed', listener);
    return () => ipcRenderer.removeListener('workspace:changed', listener);
  },

  /** 打开某个项目自己的文件夹（只传 id，路径由主进程查库拼出） */
  revealProjectFolder: (projectId: string): Promise<void> =>
    ipcRenderer.invoke('project:reveal', projectId),

  /** 用编辑器打开项目（编辑器由主进程按白名单解析，不经 shell） */
  openProjectInEditor: (projectId: string): Promise<void> =>
    ipcRenderer.invoke('project:editor', projectId),

  /** 主动退出（等同托盘菜单的"退出"） */
  quit: (): Promise<void> => ipcRenderer.invoke('app:quit'),
} as const;

export type PmStudioApi = typeof api;

contextBridge.exposeInMainWorld('pmStudio', api);
