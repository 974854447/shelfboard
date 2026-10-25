import { describe, expect, it } from 'vitest';

import {
  ALLOWED_EDITOR_COMMANDS,
  createPathEditorProbe,
  expandEnvVars,
  resolveEditorExecutable,
  type EditorProbe,
} from '../src/main/editor';

/**
 * 「用编辑器打开」的解析逻辑测试。
 *
 * 这段逻辑是应用里少见的"执行外部程序"的口子，所以两条必须锁死：
 * 1. 不在白名单里的命令**绝不能**被解析成可执行文件；
 * 2. 最终结果必须是 **.exe**（`shell: false` 只能启动 exe，批处理壳要经 shell，等于开了注入口子）。
 */

function probeWith(files: string[]): EditorProbe {
  const set = new Set(files.map((f) => f.toLowerCase()));
  return {
    which: (command) => {
      const hit = files.find((f) => {
        const base = f.split(/[\\/]/).pop() ?? '';
        return base.toLowerCase() === command.toLowerCase();
      });
      return hit ?? null;
    },
    exists: (path) => set.has(path.toLowerCase()),
  };
}

const VSCODE = 'D:\\Microsoft VS Code\\bin\\code.cmd';
const VSCODE_EXE = 'D:\\Microsoft VS Code\\Code.exe';

describe('resolveEditorExecutable', () => {
  it('PATH 上直接有 exe 时用它', () => {
    const result = resolveEditorExecutable('code', probeWith(['C:\\tools\\Code.exe']));

    expect(result).toEqual({ ok: true, command: 'code', exe: 'C:\\tools\\Code.exe' });
  });

  it('PATH 上只有 .cmd 壳时，能反推出真实 exe（VS Code 的实际布局）', () => {
    const probe = probeWith([VSCODE, VSCODE_EXE]);

    const result = resolveEditorExecutable('code', probe);

    expect(result.ok).toBe(true);
    if (result.ok) {
      // 关键：拿到的是 exe 而不是 .cmd —— 否则就得开 shell
      expect(result.exe).toBe(VSCODE_EXE);
      expect(result.exe.toLowerCase().endsWith('.exe')).toBe(true);
    }
  });

  it('拒绝白名单外的命令（这是执行外部程序的口子）', () => {
    for (const evil of ['cmd', 'powershell', 'calc', 'C:\\Windows\\System32\\cmd.exe', 'code & calc']) {
      const result = resolveEditorExecutable(evil, probeWith([VSCODE, VSCODE_EXE]));
      expect(result.ok, `${evil} 不该被接受`).toBe(false);
    }
  });

  it('什么都没装时给出可读的原因，而不是抛异常', () => {
    const result = resolveEditorExecutable('code', probeWith([]));

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain('没找到');
  });

  it('偏好为空时退回默认的 code', () => {
    const result = resolveEditorExecutable(undefined, probeWith(['C:\\tools\\Code.exe']));
    expect(result.command).toBe('code');
    expect(result.ok).toBe(true);
  });

  it('白名单里的每个命令都能被接受（不会因为白名单写错而全灭）', () => {
    for (const command of ALLOWED_EDITOR_COMMANDS) {
      const result = resolveEditorExecutable(command, probeWith([`C:\\tools\\${command}.exe`]));
      expect(result.ok, `${command} 应当被接受`).toBe(true);
    }
  });

  it('常见安装位置作为兜底（PATH 上什么都没有时）', () => {
    const exe = 'C:\\Users\\me\\AppData\\Local\\Programs\\Microsoft VS Code\\Code.exe';
    const result = resolveEditorExecutable(
      'code',
      { which: () => null, exists: (p) => p.toLowerCase() === exe.toLowerCase() },
      { expand: (t) => expandEnvVars(t, { LOCALAPPDATA: 'C:\\Users\\me\\AppData\\Local' }) },
    );

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.exe).toBe(exe);
  });
});

describe('createPathEditorProbe', () => {
  it('按 PATH 与 PATHEXT 查找（自己遍历，不派生 where.exe）', () => {
    const existing = new Set(['d:\\tools\\code.cmd', 'd:\\tools\\code.exe']);
    const probe = createPathEditorProbe(
      { PATH: 'C:\\nope;D:\\tools', PATHEXT: '.COM;.EXE;.CMD' },
      (path) => existing.has(path.toLowerCase()),
    );

    expect(probe.which('code')?.toLowerCase()).toBe('d:\\tools\\code.exe');
    expect(probe.which('missing')).toBeNull();
  });

  it('带扩展名的查找直接命中（不重复拼 PATHEXT）', () => {
    const probe = createPathEditorProbe(
      { PATH: 'D:\\tools', PATHEXT: '.EXE' },
      (path) => path.toLowerCase() === 'd:\\tools\\code.exe',
    );

    expect(probe.which('code.exe')?.toLowerCase()).toBe('d:\\tools\\code.exe');
  });

  it('PATH 末尾带反斜杠也不会拼出双斜杠', () => {
    const seen: string[] = [];
    const probe = createPathEditorProbe({ PATH: 'D:\\tools\\', PATHEXT: '.EXE' }, (path) => {
      seen.push(path);
      return false;
    });

    probe.which('code');
    expect(seen[0]).toBe('D:\\tools\\code.EXE'.replace('.EXE', '.exe'));
  });
});

describe('expandEnvVars', () => {
  it('展开 %NAME% 形式，未知的保持原样', () => {
    expect(expandEnvVars('%LOCALAPPDATA%\\x', { LOCALAPPDATA: 'C:\\L' })).toBe('C:\\L\\x');
    expect(expandEnvVars('%NOPE%\\x', {})).toBe('%NOPE%\\x');
  });
});
