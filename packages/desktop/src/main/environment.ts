/**
 * 环境判定：这个应用现在跑的是**测试环境**还是**正式环境**，数据放哪。
 *
 * 起因是一个真实的风险：开发调试时用的数据与正式数据混在一起，
 * 「一边开发一边试功能，测试项目就灌进了正式数据里」。
 *
 * 所以规则很简单 —— **整个 `userData` 根目录按环境切换**：
 * - 打包后的应用 → 正式环境，用 Electron 默认目录（`%APPDATA%\@pm-studio\desktop`）；
 * - 未打包（dev / preview）→ 测试环境，用同级目录 `${defaultUserDataDir}-test`；
 * - 命令行显式给了 `--user-data-dir` → **优先级最高**，数据目录交给参数决定
 *   （UI 探针与 e2e 全靠它把数据关进 `.tmp` 沙箱，绝不能覆盖）；
 * - `PM_STUDIO_ENV` 可以显式指定，但优先级**低于** `--user-data-dir`。
 *
 * 这段逻辑只有一个职责，却判错后果很重：一旦该进测试环境的场景被判成正式环境，
 * 用户的真实数据就会被测试数据污染 —— 所以优先级逐条锁死，并且每条都有单测
 * （见 `tests/environment.test.ts`）。
 *
 * 注意：这个模块**只做判定**。它不读配置、不建目录，也不碰数据库 ——
 * 调用方（`main/index.ts`）拿到结果后再决定 `app.setPath('userData', …)`。
 */

import { app } from 'electron';

export type EnvironmentKind = 'production' | 'test' | 'custom';

export interface ResolveEnvironmentInput {
  /** `app.isPackaged`：打包后为 true */
  isPackaged: boolean;
  /** `process.argv` */
  argv: readonly string[];
  /** `process.env.PM_STUDIO_ENV`（可显式指定环境） */
  requested: string | undefined;
  /** Electron 的默认 userData 目录（`app.getPath('userData')`） */
  defaultUserDataDir: string;
}

export interface EnvironmentInfo {
  env: EnvironmentKind;
  /**
   * 要切换到的 userData 目录。
   * `null` 表示"**不动**，用 Electron 默认目录"（正式环境与自定义目录都是这个含义）。
   */
  userDataDir: string | null;
  /** 为什么这样判定（写进启动日志，排查"数据怎么跑这儿来了"时很有用） */
  reason: string;
}

/** 界面上显示的环境名（侧栏标签、窗口标题、托盘提示都用它） */
export const ENVIRONMENT_LABEL: Record<EnvironmentKind, string> = {
  production: '正式环境',
  test: '测试环境',
  custom: '自定义目录',
};

export function hasExplicitUserDataDir(argv: readonly string[]): boolean {
  return argv.some(
    (arg, index) =>
      arg.startsWith('--user-data-dir=') || (arg === '--user-data-dir' && index < argv.length - 1),
  );
}

function normalizeRequested(value: string | undefined): 'test' | 'production' | 'unknown' | null {
  if (value === undefined) return null;
  const trimmed = value.trim().toLowerCase();
  if (trimmed === '') return null;
  if (trimmed === 'test' || trimmed === 'production') return trimmed;
  return 'unknown';
}

export function resolveEnvironment(input: ResolveEnvironmentInput): EnvironmentInfo {
  const testDir = `${input.defaultUserDataDir}-test`;

  // 1) 命令行显式指定：最高优先级（测试脚本的沙箱靠它）
  if (hasExplicitUserDataDir(input.argv)) {
    return {
      env: 'custom',
      userDataDir: null,
      reason: '命令行指定了 --user-data-dir，数据目录由参数决定（测试脚本的沙箱）',
    };
  }

  const requested = normalizeRequested(input.requested);

  // 2) 写了个看不懂的 PM_STUDIO_ENV：忽略它，但如实说明（别让用户以为生效了）
  if (requested === 'unknown') {
    return {
      env: input.isPackaged ? 'production' : 'test',
      userDataDir: input.isPackaged ? null : testDir,
      reason: `PM_STUDIO_ENV=${input.requested} 无法识别（只认 test / production），已忽略`,
    };
  }

  if (requested === 'test') {
    return { env: 'test', userDataDir: testDir, reason: 'PM_STUDIO_ENV=test' };
  }
  if (requested === 'production') {
    return { env: 'production', userDataDir: null, reason: 'PM_STUDIO_ENV=production' };
  }

  // 3) 默认：打包走正式，未打包走测试
  return input.isPackaged
    ? { env: 'production', userDataDir: null, reason: '打包后的应用默认走正式环境' }
    : { env: 'test', userDataDir: testDir, reason: '未打包（dev / preview）默认走测试环境' };
}

/**
 * 按判定结果切换 `userData` 目录（只在测试环境需要切），并回带**切换后**的最终目录。
 *
 * 单独一层的原因：`app.setPath` 是副作用，判定本身要保持纯函数（好测）。
 */
export function applyEnvironment(): EnvironmentInfo & { effectiveUserDataDir: string } {
  const info = resolveEnvironment({
    isPackaged: app.isPackaged,
    argv: process.argv,
    requested: process.env.PM_STUDIO_ENV,
    defaultUserDataDir: app.getPath('userData'),
  });

  if (info.env === 'test' && info.userDataDir) {
    app.setPath('userData', info.userDataDir);
  }

  return { ...info, effectiveUserDataDir: app.getPath('userData') };
}
