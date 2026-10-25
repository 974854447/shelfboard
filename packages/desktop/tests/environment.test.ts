import { describe, expect, it } from 'vitest';

import { resolveEnvironment } from '../src/main/environment';

/**
 * 环境隔离的判定测试。
 *
 * 这段逻辑只有一个职责，但**判错的后果很重**：一旦该进测试环境的场景被判成正式环境，
 * 用户的真实数据就会被测试数据污染 —— 而这个改动本身就是为了解决那个问题。
 * 所以把优先级逐条锁死，尤其是"命令行显式指定 user-data-dir 必须最高优先"这条：
 * UI 探针与冒烟脚本全靠它把数据关进 `.tmp` 沙箱。
 */

const DEFAULT_DIR = 'C:\\Users\\someone\\AppData\\Roaming\\@pm-studio\\desktop';
const TEST_DIR = `${DEFAULT_DIR}-test`;

function resolve(overrides: Partial<Parameters<typeof resolveEnvironment>[0]> = {}) {
  return resolveEnvironment({
    isPackaged: false,
    argv: ['electron.exe', '.'],
    requested: undefined,
    defaultUserDataDir: DEFAULT_DIR,
    ...overrides,
  });
}

describe('resolveEnvironment', () => {
  it('打包后的应用走正式环境，并且不动数据目录', () => {
    const info = resolve({ isPackaged: true, argv: ['项目管理系统.exe'] });

    expect(info.env).toBe('production');
    // null = "用 Electron 默认目录"，也就是用户既有数据所在的那一个
    expect(info.userDataDir).toBeNull();
  });

  it('未打包（dev / preview）走测试环境，数据目录是同级目录', () => {
    const info = resolve({ isPackaged: false });

    expect(info.env).toBe('test');
    expect(info.userDataDir).toBe(TEST_DIR);
  });

  it('显式 --user-data-dir 优先于打包状态，绝不覆盖', () => {
    for (const isPackaged of [true, false]) {
      const info = resolve({
        isPackaged,
        argv: ['electron.exe', `--user-data-dir=D:\\tmp\\ui-shots-userdata`],
      });

      expect(info.env).toBe('custom');
      expect(info.userDataDir).toBeNull();
    }
  });

  it('--user-data-dir 也优先于 PM_STUDIO_ENV', () => {
    const info = resolve({
      isPackaged: false,
      argv: ['electron.exe', '--user-data-dir=D:\\tmp\\x'],
      requested: 'production',
    });

    expect(info.env).toBe('custom');
    expect(info.userDataDir).toBeNull();
  });

  it('支持 --user-data-dir 与路径分开写的形式', () => {
    const info = resolve({ argv: ['electron.exe', '--user-data-dir', 'D:\\tmp\\x'] });

    expect(info.env).toBe('custom');
  });

  it('PM_STUDIO_ENV 可以覆盖默认判断（两个方向都行）', () => {
    expect(resolve({ isPackaged: false, requested: 'production' })).toMatchObject({
      env: 'production',
      userDataDir: null,
    });
    expect(resolve({ isPackaged: true, requested: 'test' })).toMatchObject({
      env: 'test',
      userDataDir: TEST_DIR,
    });
  });

  it('大小写与空格不影响识别', () => {
    expect(resolve({ requested: ' TEST ' }).env).toBe('test');
    expect(resolve({ requested: 'Production' }).env).toBe('production');
  });

  it('写错的值不当成正式环境，而是在 reason 里说明被忽略', () => {
    // 静默按正式处理是最危险的：用户以为切到测试了，实际在写正式库
    const info = resolve({ isPackaged: false, requested: 'staging' });

    expect(info.env).toBe('test');
    expect(info.userDataDir).toBe(TEST_DIR);
    expect(info.reason).toContain('无法识别');
    expect(info.reason).toContain('staging');
  });

  it('空字符串视同没设置', () => {
    expect(resolve({ requested: '   ' }).env).toBe('test');
  });

  it('每个判断都给出可读的依据', () => {
    for (const info of [
      resolve({ isPackaged: true }),
      resolve({ isPackaged: false }),
      resolve({ argv: ['electron.exe', '--user-data-dir=D:\\x'] }),
      resolve({ requested: 'test' }),
    ]) {
      expect(info.reason.length).toBeGreaterThan(0);
    }
  });
});
