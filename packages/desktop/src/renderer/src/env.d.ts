/**
 * 资源模块与桥接的**环境声明**。
 *
 * 这个文件**绝不能出现顶层 import / export**：
 * 一旦有了，它就从"全局脚本"变成"模块"，而模块里的
 * `declare module '*.vue'` 会被 TS 当成**模块增强**而不是环境声明，
 * 通配声明随之失效 —— 症状就是 `import App from './App.vue'` 报
 * "找不到模块"，且看不出任何与声明文件有关的线索。
 * 需要对外暴露类型时，用全局 `interface`，不要用 `export interface`。
 *
 * 同样刻意不依赖 `vite/client` 类型：`vite` 不是本包的直接依赖，
 * pnpm 严格 node_modules 布局下解析不到，引用它会连带失败。
 */

declare module '*.vue' {
  import type { DefineComponent } from 'vue';

  const component: DefineComponent<Record<string, never>, Record<string, never>, unknown>;
  export default component;
}

declare module '*.css';
declare module '*.svg' {
  const source: string;
  export default source;
}
declare module '*.png' {
  const source: string;
  export default source;
}

interface BootstrapInfoPayload {
  baseUrl: string;
  token: string;
  platform: string;
  version: string;
  workspaceRoot: string;
  theme: string;
  /**
   * 运行环境：测试与正式用的是**两套分开的数据目录**（见 main/environment.ts），
   * 界面上要显示出来，否则用户分不清眼前这份数据是哪一套。
   */
  environment: 'test' | 'production' | 'custom';
  environmentLabel: string;
  /** 实际生效的数据目录 */
  userDataDir: string;
  /** 「用编辑器打开」允许的命令白名单（设置页下拉用） */
  editorCommands: string[];
}

type ThemeMode = 'light' | 'dark' | 'system';
type UiDensity = 'comfortable' | 'compact';
type LogLevelName = 'error' | 'warn' | 'info' | 'debug';

interface PreferencesPayload {
  theme: ThemeMode;
  sidebarCollapsed: boolean;
  density: UiDensity;
  /** 上次打开的项目 id；存在主进程配置里（localStorage 在此应用不可用） */
  lastProjectId: string | null;
  defaultProjectRoot: string | null;
  editorCommand: string;
  /** ⚠️ 自动备份策略只有配置，功能本身尚未实现（设置页会如实标注） */
  autoBackup: { enabled: boolean; intervalMinutes: number; keepCount: number };
  logging: {
    level: LogLevelName;
    retentionDays: number;
    fileMaxMB: number;
    fileKeepCount: number;
    redactUserName: boolean;
  };
  /** 工作日志（Word）保存目录；null = 用默认目录（`<文档>\项目管理系统\工作日志`） */
  workLogSaveDir: string | null;
  [key: string]: unknown;
}

interface WorkspaceSwitchReport {
  /** 切换后的工作区根目录 */
  workspaceRoot: string;
  moved: string[];
  skipped: string[];
  failed: { name: string; reason: string }[];
}

interface GithubStatusPayload {
  connected: boolean;
  login: string | null;
  hasToken: boolean;
  connectedAt: number | null;
  /** 这一版是否支持"绑定"这个动作（预留接口：现在是 false） */
  available: boolean;
  /** 未实现时给用户看的说明 */
  unavailableReason: string | null;
}

/** 开发环境检测里的单个工具（M4） */
interface DetectedToolPayload {
  id: string;
  label: string;
  found: boolean;
  /** 可执行文件绝对路径；没找到就是 null */
  path: string | null;
  version: string | null;
  /** 缺了它，哪些功能用不了 */
  neededFor: string;
  /** 没找到 / 超时 / 读不出版本时的说明 */
  note: string | null;
}

/** 开发环境检测结果（M4） */
interface EnvironmentSnapshotPayload {
  checkedAt: number;
  appStartedAt: number;
  pathFingerprint: string;
  tools: DetectedToolPayload[];
  /** 必需工具（node / npm）是否齐备 */
  ready: boolean;
  missingRequired: string[];
  warnings: string[];
  /** 环境变量在这次启动之后被改过时的提醒（否则 null） */
  restartHint: string | null;
}

interface PmStudioBridge {
  /** 同步可得的偏好：用于在首帧之前定好主题，避免闪一下错误颜色 */
  initialPreferences: PreferencesPayload | null;
  getBootstrap(): Promise<BootstrapInfoPayload>;
  getPreferences(): Promise<PreferencesPayload | null>;
  patchPreferences(patch: Partial<PreferencesPayload>): Promise<PreferencesPayload | null>;
  hideToTray(): Promise<void>;
  revealWorkspace(): Promise<void>;
  /** 打开应用数据目录（数据库、配置、日志都在里面） */
  revealUserDataDir(): Promise<void>;
  /** 检测本机装了哪些编辑器 */
  detectEditors(): Promise<{ command: string; exe: string }[]>;
  /** 开发环境检测：读上次的结果（从没检测过就是 null，不自动跑） */
  environmentStatus(): Promise<EnvironmentSnapshotPayload | null>;
  /** 开发环境检测：强制重测一遍 */
  detectEnvironment(): Promise<EnvironmentSnapshotPayload>;
  /** 弹出系统目录选择框；null = 用户取消 */
  chooseWorkspaceDir(): Promise<string | null>;
  /** 弹出目录选择框，指定工作日志（Word）的保存位置；null = 取消 */
  chooseWorkLogDir(): Promise<string | null>;
  /** 在资源管理器里选中某个文件（生成完工作日志后用） */
  showItemInFolder(path: string): Promise<boolean>;
  /** 用系统默认程序打开某个文件（生成完工作日志后直接用 Word 打开） */
  openPath(path: string): Promise<boolean>;
  /** 切换工作区目录（可选搬走现有项目文件夹） */
  setWorkspaceRoot(path: string, options?: { moveProjects?: boolean }): Promise<WorkspaceSwitchReport>;
  /** 立即备份一次数据库 */
  runBackup(): Promise<{ file: string; pages: number }>;
  /** 打开备份目录 */
  revealBackups(): Promise<void>;
  /** 重启应用 */
  relaunch(): Promise<void>;
  /** 订阅"工作区目录变了"；返回取消订阅函数 */
  onWorkspaceChanged(handler: (payload: { workspaceRoot: string }) => void): () => void;
  /** GitHub 绑定（预留接口；connect 现在会返回"尚未实现"） */
  githubStatus(): Promise<GithubStatusPayload>;
  connectGithub(): Promise<{ ok: false; reason: string }>;
  disconnectGithub(): Promise<GithubStatusPayload>;
  /** 打开某个项目自己的文件夹 */
  revealProjectFolder(projectId: string): Promise<void>;
  /** 用编辑器打开项目 */
  openProjectInEditor(projectId: string): Promise<void>;
  quit(): Promise<void>;
}

interface Window {
  /** 由 preload 通过 contextBridge 注入；非 Electron 环境下可能不存在 */
  pmStudio?: PmStudioBridge;
}
