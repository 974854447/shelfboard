import { describe, expect, it, vi } from 'vitest';

import {
  assertSafeBin,
  buildCommand,
  commandPreview,
  getCommandSpec,
  listCommandSpecs,
  runCommand,
  SAFE_VALUE_PATTERN,
  validateSlotValue,
  type CommandExec,
} from '../src/services/commands';

/**
 * 外部命令白名单（M4）。
 *
 * 这是全项目**唯一能碰到用户机器**的地方，所以测试的重点不是"功能对不对"，
 * 而是"**能不能被绕过**"：枚举外的取值、没声明的参数、带路径分隔符的可执行文件名，
 * 每一个都必须被拦下。凡是"拦不住也不报错"的情况，都等于白名单不存在。
 */

describe('白名单表本身', () => {
  it('每条 spec 都声明了超时与工作目录规则', () => {
    const specs = listCommandSpecs();
    expect(specs.length).toBeGreaterThan(0);
    for (const spec of specs) {
      /*
       * 长驻命令（开发服务器）是**唯一**允许 `timeoutMs: 0` 的一类：
       * 它按定义不会自己结束，靠用户点"停止"或应用退出时杀进程树。
       * 这类 spec 必须显式写 `longRunning: true`（不是漏写超时），
       * 而且 `runCommand` 会拒绝执行它（见下面的用例）。
       */
      if (spec.longRunning === true) {
        expect(spec.timeoutMs, `${spec.id} 是长驻命令，超时应为 0`).toBe(0);
      } else {
        expect(spec.timeoutMs, `${spec.id} 缺少超时`).toBeGreaterThan(0);
        // 上半限：作业最长也不能挂半小时以上（装依赖慢是事实，但不能无限等）
        expect(spec.timeoutMs, `${spec.id} 的超时上限应在 30 分钟内`).toBeLessThanOrEqual(30 * 60 * 1000);
      }
      expect(['workspace', 'project', 'tmp'], `${spec.id} 的 cwdRule 不合法`).toContain(spec.cwdRule);
      expect(spec.bin.length, `${spec.id} 没有可执行文件名`).toBeGreaterThan(0);
    }
  });

  it('启动/停止项目的命令走白名单：脚本名是枚举，杀进程只收数字 PID', () => {
    // 脚本名只能是我们认的三个：`postinstall` / `deploy` 之类进不来
    expect(buildCommand('run-node-dev', { pm: 'npm', script: 'dev' }).args).toEqual(['run', 'dev']);
    expect(buildCommand('run-node-dev', { pm: 'pnpm', script: 'start:dev' }).args).toEqual([
      'run',
      'start:dev',
    ]);
    for (const bad of ['postinstall', 'deploy', 'dev && calc', '../evil']) {
      expect(() => buildCommand('run-node-dev', { pm: 'npm', script: bad }), bad).toThrow(/只能是/);
    }

    // Python 侧：venv 里的解释器是项目内相对路径，端口只允许数字
    const uvicorn = buildCommand('run-python-uvicorn', {
      python: '.venv\\Scripts\\python.exe',
      port: '8123',
    });
    expect(uvicorn.args).toEqual(['-m', 'uvicorn', 'app.main:app', '--reload', '--port', '8123']);
    expect(() =>
      buildCommand('run-python-uvicorn', { python: '.venv\\Scripts\\python.exe', port: '80; calc' }),
    ).toThrow(/不安全/);
    expect(
      buildCommand('run-django-runserver', { python: '.venv\\Scripts\\python.exe', port: '8000' }).args,
    ).toEqual(['manage.py', 'runserver', '8000']);

    // 杀进程树：只收数字 pid
    expect(buildCommand('kill-process-tree', { pid: '12345' }).args).toEqual([
      '/PID',
      '12345',
      '/T',
      '/F',
    ]);
    expect(() => buildCommand('kill-process-tree', { pid: '123 & calc' })).toThrow(/不安全/);
  });

  it('长驻命令不许走 runCommand（否则"点了启动，界面永远空白"）', async () => {
    await expect(
      runCommand('run-node-dev', { pm: 'npm', script: 'dev' }, {
        exec: async () => ({ code: 0, stdout: '', stderr: '', timedOut: false, canceled: false }),
      }),
    ).rejects.toThrow(/长驻命令/);
  });
  it('探测类命令必须是"短命令"（几秒内），长超时只留给真正的作业', () => {
    /*
     * 这条规则是踩出来的：探测（取版本、`--help`）在界面线程上跑，
     * 给它几分钟超时等于"点了按钮界面卡住几分钟"。
     * 只有脚手架/装依赖这类**跑在作业里**的命令才允许分钟级超时。
     */
    /*
     * `probe-npm-create` / `probe-nest-help` 不在这张表里：它们第一次要**联网下载**脚手架包，
     * 给两分钟是合理的。但它们同样只出现在**作业内部**，不会在界面上直接跑 ——
     * 那条纪律（界面上点的按钮不能卡几分钟）由"探测类命令"与"作业类命令"两张表分别守住。
     */
    const PROBE_SPECS = ['tool-version', 'venv-probe'];
    for (const id of PROBE_SPECS) {
      expect(getCommandSpec(id).timeoutMs, `${id} 是探测命令，超时应在 60 秒内`).toBeLessThanOrEqual(60_000);
    }
  });

  it('未知 spec 直接拒绝（不能凭 id 拼出任意命令）', () => {
    expect(() => getCommandSpec('rm-rf')).toThrow(/未知的命令 spec/);
    expect(() => buildCommand('powershell')).toThrow(/未知的命令 spec/);
  });
});

describe('组装命令时的校验', () => {
  it('按 spec 拼出 bin 与参数', () => {
    expect(buildCommand('tool-version', { tool: 'node' })).toMatchObject({
      bin: 'node',
      args: ['--version'],
    });
    expect(buildCommand('venv-probe', { tool: 'python' })).toMatchObject({
      bin: 'python',
      args: ['-m', 'venv', '--help'],
    });
  });

  it('枚举外的取值被拒（这是白名单的主防线）', () => {
    expect(() => buildCommand('tool-version', { tool: 'curl' })).toThrow(/只能是/);
    expect(() => buildCommand('venv-probe', { tool: 'node' })).toThrow(/只能是/);
  });

  it('注入尝试被拒：分号、空格、管道、路径分隔符一概不行', () => {
    for (const evil of [
      'node; rm -rf /',
      'node && curl http://x',
      'node | whoami',
      '..\\..\\windows\\system32\\cmd',
      '/bin/sh',
      'node.exe -e evil',
    ]) {
      expect(() => buildCommand('tool-version', { tool: evil }), evil).toThrow(/只能是|不安全/);
    }
  });

  it('传了没声明的参数会报错，而不是被静默忽略', () => {
    // 静默忽略最危险：调用方以为传进去了，实际执行的是另一条命令
    expect(() => buildCommand('tool-version', { tool: 'node', extra: 'x' })).toThrow(
      /没有声明参数/,
    );
  });

  it('缺少必填参数会报错', () => {
    expect(() => buildCommand('tool-version')).toThrow(/缺少参数 tool/);
  });

  it('可执行文件名不允许带路径分隔符或空格', () => {
    expect(assertSafeBin('tool-version', 'node')).toBe('node');
    for (const bad of ['C:\\windows\\system32\\cmd.exe', '..\\node', './node', 'node exe']) {
      expect(() => assertSafeBin('tool-version', bad), bad).toThrow(/不合法/);
    }
  });

  it('值位的默认规则就是"裸名字"', () => {
    const slot = { description: '测试用' };
    expect(validateSlotValue('x', 'name', slot, 'my-project_1.2')).toBe('my-project_1.2');
    for (const bad of ['a b', 'a/b', 'a\\b', 'a;b', 'a&b', '"q"', '中文']) {
      expect(() => validateSlotValue('x', 'name', slot, bad), bad).toThrow(/不安全/);
    }
    expect(() => validateSlotValue('x', 'name', slot, '   ')).toThrow(/不能为空/);
  });

  it('自定义正则可以更宽（例如允许中文的项目名）', () => {
    const slot = { description: '项目名', pattern: /^[\w\u4e00-\u9fa5-]{1,40}$/ };
    expect(validateSlotValue('x', 'name', slot, '我的项目')).toBe('我的项目');
    expect(() => validateSlotValue('x', 'name', slot, '我的项目; rm -rf /')).toThrow(/不安全/);
  });

  it('默认安全正则本身是"白名单字符"语义', () => {
    expect(SAFE_VALUE_PATTERN.test('node')).toBe(true);
    expect(SAFE_VALUE_PATTERN.test('node.exe')).toBe(true);
    expect(SAFE_VALUE_PATTERN.test('node exe')).toBe(false);
  });

  it('预览串只用于显示，且会转义带空格的参数', () => {
    expect(commandPreview(buildCommand('tool-version', { tool: 'node' }))).toBe('node --version');
  });

  /*
   * Windows 上的批处理壳（M4 脚手架要跑 npm / pnpm / npx）。
   *
   * `execFile('npm.cmd')` 配 `shell: false` 直接起不来，所以必须改走 `cmd.exe /d /c`。
   * 这条路径的安全性依赖两件事，测试都要钉住：
   *   1. `cmd.exe` 与 `/d /c` 是**固定的**，里面那一段来自白名单 spec；
   *   2. 只有值位声明过的取值才进得去（枚举或严格正则）。
   */
  it('executePath 是 .cmd / .bat 时改走 cmd.exe，参数与顺序不变', () => {
    const shimmed = buildCommand('tool-version', { tool: 'npm' }, { executePath: 'C:\\n\\npm.cmd' });
    expect(shimmed.shimmed).toBe(true);
    expect(shimmed.bin).toBe('cmd.exe');
    expect(shimmed.args).toEqual(['/d', '/c', 'npm', '--version']);
  });

  it('真正的 .exe 不走 shell', () => {
    const direct = buildCommand('tool-version', { tool: 'node' }, { executePath: 'C:\\n\\node.exe' });
    expect(direct.shimmed).toBe(false);
    expect(direct.bin).toBe('node');
  });

  it('装了 .cmd 壳也挡得住注入：取值必须先在白名单里过一遍', () => {
    expect(() =>
      buildCommand('tool-version', { tool: 'npm & calc' }, { executePath: 'C:\\n\\npm.cmd' }),
    ).toThrow(/只能是/);
  });

  it('脚手架 spec：名字与包都来自白名单/严格正则，注入进不来', () => {
    const create = buildCommand('scaffold-npm-create', {
      pkg: 'vue@latest',
      name: 'app',
      flags: '--ts --router',
    });
    expect(create.bin).toBe('npm');
    /*
     * **参数列表要展开成多个 argv 条目**，不能是一个带空格的字符串。
     *
     * 这是真跑一次官方脚手架才发现的：`npm create … -- '--ts --router'` 经过
     * cmd.exe → npm → 脚手架三层引号转义，脚手架收到的是**一个**不认识的参数，
     * 直接报 `Unknown option '--ts --router'`。
     */
    expect(create.args).toEqual(['create', 'vue@latest', 'app', '--', '--ts', '--router']);

    expect(() => buildCommand('scaffold-npm-create', { pkg: 'evil', name: 'app' })).toThrow(/只能是/);
    expect(() => buildCommand('scaffold-npm-create', { pkg: 'vue@latest', name: 'a b' })).toThrow(/不安全/);
    // flags 是我们自己拼出来的，但仍然只允许白名单字符（`&` / `|` / 引号一律不行）
    for (const evil of ['--ts & calc', '--ts | whoami', '--ts "x"', '--ts > out.txt']) {
      expect(
        () => buildCommand('scaffold-npm-create', { pkg: 'vue@latest', name: 'app', flags: evil }),
        evil,
      ).toThrow(/不安全/);
    }
  });

  it('Django：包名按 Python 标识符校验，django-admin 走**项目内相对路径**', () => {
    const built = buildCommand('scaffold-django', {
      django: '.venv\\Scripts\\django-admin.exe',
      name: 'my_site',
      destination: '.scaffold-staging',
    });
    /*
     * 目的地是**单独一格**（不是 `.`）：cwd 必须留在项目文件夹，
     * 因为 django-admin 是 venv 里的**相对路径**（见 spec 注释与 §47）。
     */
    expect(built.args).toEqual(['startproject', 'my_site', '.scaffold-staging']);
    // 不在 PATH 上，是 pip 装进项目自己那个 venv 里的入口
    expect(built.bin).toContain('django-admin');

    for (const bad of ['1site', 'my-site', 'my site', 'my;site']) {
      expect(
        () =>
          buildCommand('scaffold-django', {
            django: '.venv\\Scripts\\django-admin.exe',
            name: bad,
            destination: '.scaffold-staging',
          }),
        bad,
      ).toThrow(/不安全/);
    }
    // 相对路径这一格也要过白名单：绝对路径与 .. 一律拒绝
    for (const bad of ['C:\\Python\\Scripts\\django-admin.exe', '..\\django-admin.exe']) {
      expect(
        () => buildCommand('scaffold-django', { django: bad, name: 'my_site', destination: '.s' }),
        bad,
      ).toThrow(
        /不安全/,
      );
    }
    // 少了某一格要说清是缺哪个参数
    expect(() =>
      buildCommand('scaffold-django', { name: 'my_site', destination: '.s' }),
    ).toThrow(/缺少参数 django/);
    // 目的地只允许**单段**目录名：带分隔符或 .. 一律拒绝
    for (const bad of ['a/b', '..', '..\\x', 'C:\\tmp']) {
      expect(
        () =>
          buildCommand('scaffold-django', {
            django: '.venv\\Scripts\\django-admin.exe',
            name: 'my_site',
            destination: bad,
          }),
        bad,
      ).toThrow(/不安全/);
    }
  });

  /**
   * 可选的**列表**值位不给值时，那一格要**整个消失**。
   *
   * 这条是"用户选项"逼出来的：`--strict` 这类参数由界面勾选，不勾的时候就一个都不传。
   * 若按普通值位处理会抛"用到了未赋值的 {flags}" —— 于是"用户什么都没选"变成"命令报错"。
   * 注意非列表的可选值位仍然抛错（少一个值就是拼错了命令，不该静默继续）。
   */
  it('可选的参数列表没给值时整格消失（不是留一个空参数）', () => {
    const withoutFlags = buildCommand('scaffold-npm-create', { pkg: 'vite@latest', name: 'app' });
    expect(withoutFlags.args).toEqual(['create', 'vite@latest', 'app', '--']);

    const withFlags = buildCommand('scaffold-npm-create', {
      pkg: 'vite@latest',
      name: 'app',
      flags: '--template react-ts',
    });
    expect(withFlags.args).toEqual(['create', 'vite@latest', 'app', '--', '--template', 'react-ts']);

    // NestJS 的参数也走同一格：--skip-git 是我们固定带的，选项跟在后面
    expect(
      buildCommand('scaffold-nest-new', { name: 'app', pm: 'pnpm', flags: '--skip-git --strict' }).args,
    ).toEqual(['--yes', '@nestjs/cli', 'new', 'app', '--package-manager', 'pnpm', '--skip-git', '--strict']);
  });

  it('装依赖与建 venv 的命令形状固定（不带任何自由参数）', () => {
    expect(buildCommand('install-node', { pm: 'pnpm' })).toMatchObject({ bin: 'pnpm', args: ['install'] });
    expect(buildCommand('python-venv', { name: '.venv' })).toMatchObject({
      bin: 'python',
      args: ['-m', 'venv', '.venv'],
    });
    expect(
      buildCommand('python-pip-install', {
        python: '.venv\\Scripts\\python.exe',
        requirements: 'requirements.txt',
      }).args,
    ).toEqual(['-m', 'pip', 'install', '-r', 'requirements.txt']);
    // venv 目录名是枚举，不接受任意路径
    expect(() => buildCommand('python-venv', { name: '..\\..\\windows' })).toThrow(/只能是/);
  });
});

describe('执行', () => {
  /** 假的执行器：单测里**绝不派生真实进程**（也不必依赖机器上装了什么） */
  function fakeExec(
    handler: (bin: string, args: string[]) => { code: number | null; stdout?: string; stderr?: string; timedOut?: boolean },
  ): { exec: CommandExec; calls: Array<{ bin: string; args: string[]; timeoutMs: number; cwd?: string }> } {
    const calls: Array<{ bin: string; args: string[]; timeoutMs: number; cwd?: string }> = [];
    const exec: CommandExec = async (bin, args, options) => {
      calls.push({
        bin,
        args,
        timeoutMs: options.timeoutMs,
        ...(options.cwd !== undefined ? { cwd: options.cwd } : {}),
      });
      const result = handler(bin, args);
      return {
        code: result.code,
        stdout: result.stdout ?? '',
        stderr: result.stderr ?? '',
        timedOut: result.timedOut ?? false,
      };
    };
    return { exec, calls };
  }

  it('成功时带回版本号，并把 spec 的超时传下去', async () => {
    const { exec, calls } = fakeExec(() => ({ code: 0, stdout: 'v24.20.0\n' }));

    const result = await runCommand('tool-version', { tool: 'node' }, { exec, cwd: 'C:\\tmp' });

    expect(result.ok).toBe(true);
    expect(result.stdout).toBe('v24.20.0');
    expect(result.bin).toBe('node');
    expect(calls[0]).toMatchObject({ bin: 'node', args: ['--version'], timeoutMs: 5000, cwd: 'C:\\tmp' });
  });

  it('超时不算成功，并标记 timedOut（调用方据此提示"命令卡住了"）', async () => {
    const { exec } = fakeExec(() => ({ code: null, timedOut: true }));
    const result = await runCommand('tool-version', { tool: 'node' }, { exec });
    expect(result.ok).toBe(false);
    expect(result.timedOut).toBe(true);
  });

  it('退出码非 0 不算成功，但**不抛异常**（工具没装是常态）', async () => {
    const { exec } = fakeExec(() => ({ code: 1, stderr: 'not found' }));
    const result = await runCommand('tool-version', { tool: 'python' }, { exec });
    expect(result.ok).toBe(false);
    expect(result.code).toBe(1);
    expect(result.stderr).toBe('not found');
  });

  it('输出过长会被截断（命令跑飞了不能把内存塞满）', async () => {
    const { exec } = fakeExec(() => ({ code: 0, stdout: 'x'.repeat(10_000) }));
    const result = await runCommand('tool-version', { tool: 'node' }, { exec });
    expect(result.stdout.length).toBeLessThan(5_000);
    expect(result.stdout).toContain('输出已截断');
  });

  it('非法取值在**执行之前**就被拦下（不会走到 exec）', async () => {
    const exec = vi.fn<CommandExec>();
    await expect(runCommand('tool-version', { tool: 'rm' }, { exec })).rejects.toThrow(/只能是/);
    expect(exec).not.toHaveBeenCalled();
  });
});
