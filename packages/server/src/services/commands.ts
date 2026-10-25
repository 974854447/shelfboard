/**
 * 外部命令白名单（M4 的第一块地基）。
 *
 * 这个应用迟早要跑外部命令（脚手架、包管理器、robocopy…），而"跑外部命令"是本项目里
 * **唯一能碰到用户机器**的地方，所以纪律必须一开始就立好（技术设计 §5.4）：
 *
 * 1. **命令来自结构化白名单，不接受任何自由拼接的字符串**。调用方给的是"哪条 spec + 几个值"，
 *    可执行文件名与参数都由 spec 决定；用户输入只能进**声明过的值位**（slot），
 *    并且逐项强校验（能写枚举就写枚举，写不了才用正则，默认 `^[A-Za-z0-9._-]+$`）。
 * 2. **`shell: false`**。绝不把命令拼成字符串交给 shell —— 项目文件夹名里带个 `&`
 *    或空格，拼字符串就会变成"执行另一条命令"（同一套纪律见 `main/editor.ts`）。
 * 3. **超时写死在 spec 里**，调用方不能改。外部命令卡住时必须自己结束，而不是把界面挂住。
 *
 * 这一版只有两条 spec：探测工具的版本、探测 python 的 venv 能力（环境检测要用）。
 * 作业执行器（脚手架 / 装依赖）落地时往这张表里加，不另起一套。
 */

import { execFile } from 'node:child_process';

/* ------------------------------------------------------------------ */
/* 允许被执行的工具                                                    */
/* ------------------------------------------------------------------ */

/**
 * 允许探测的"开发工具"名单。
 *
 * 这是一份**白名单**，不是"系统里有什么就查什么"：想支持新工具就往这里加一行，
 * 加之前要能说清"为什么需要它"。（`venv` 不是独立可执行文件，它是 python 的一个模块，
 * 单独用 `venv-probe` 探。）
 */
export const DETECTABLE_TOOLS = [
  'node',
  'npm',
  'pnpm',
  'yarn',
  'python',
  'pip',
  'git',
] as const;

export type DetectableTool = (typeof DETECTABLE_TOOLS)[number];

/** 值位的默认校验：只允许字母数字点下划线连字符（项目名、工具名、包名都够用） */
export const SAFE_VALUE_PATTERN = /^[A-Za-z0-9._-]+$/;

/**
 * 一组参数的校验：`--ts --router` 这种。
 *
 * 允许**单个空格**分隔（空格只是分子进程的参数边界，不是 shell 语法），
 * 但每个 token 内部只允许字母数字与 `._@=-` —— 于是 `&` `|` `<` `>` `^` `%` `"` `'`
 * 这些能被 cmd.exe 当成语法的一片都进不来；也不允许开头/结尾/连续空格
 * （那会造出一个空参数，命令行为变得不可预期）。
 */
export const SAFE_FLAGS_PATTERN = /^[A-Za-z0-9._@=-]+( [A-Za-z0-9._@=-]+)*$/;

/**
 * `bin` 允许写成**项目目录内的相对路径**（例：`.venv\Scripts\python.exe`）。
 *
 * 为什么需要：虚拟环境里的 python 只能按路径找，PATH 上没有它。
 * 为什么这样仍然是安全的：不允许 `..`、不允许绝对路径与盘符（字符集里没有冒号与斜杠开头），
 * 而且运行时的 `cwd` 一定是那个项目文件夹 —— 也就是说它只能指向
 * **我们已经建出来的那个目录里面**，跑不出工作区。
 */
export const RELATIVE_BIN_PATTERN = /^(?!.*\.\.)[A-Za-z0-9._-]+(?:[\\/][A-Za-z0-9._-]+)*$/;

export interface CommandSlot {
  description: string;
  /** 允许的取值。**能写枚举就写枚举** —— 比正则严格得多 */
  allowed?: readonly string[];
  /** 没有枚举时用这个正则（默认 SAFE_VALUE_PATTERN） */
  pattern?: RegExp;
  /** 不传就是必填 */
  optional?: boolean;
  /**
   * 这是一个**参数列表**：按空白拆开后**展开成多个 argv 条目**，而不是一个字符串。
   *
   * 为什么必须这样（真跑一次才发现的）：把 `'--ts --router'` 当成一个参数传给
   * `npm create … -- '--ts --router'`，经过 `cmd.exe` → npm → 脚手架三层引号转义之后，
   * 脚手架收到的是**一个**不认识的参数，直接报 `Unknown option '--ts --router'`。
   * 展开成多个条目之后，每一层都不需要转义，也不会被合并。
   *
   * 附带的好处：每个 token 单独过校验（正则/枚举），比校验一整串更严。
   */
  list?: boolean;
}

export interface CommandSpec {
  id: string;
  description: string;
  /** 可执行文件名模板，`{slot}` 会被替换成校验过的值；**不允许出现路径分隔符** */
  bin: string;
  /** 参数模板，同样支持 `{slot}` */
  args: readonly string[];
  slots?: Readonly<Record<string, CommandSlot>>;
  /** 超时（毫秒）。写在 spec 里，调用方改不了 */
  timeoutMs: number;
  /**
   * **长驻进程**（开发服务器）：没有超时，靠调用方在停止时结束它。
   *
   * 与作业型命令的区别不只是"跑得久"：它的输出要**边跑边看**（启动横幅里就有端口号），
   * 所以它不走 `runCommand`（那是"跑完拿结果"），而走 dev-servers 里的流式执行器。
   * 这个标记的用处是**把意图写在 spec 上**：看到 `longRunning: true` 就知道
   * `timeoutMs: 0` 不是漏写。
   */
  longRunning?: boolean;
  /**
   * `bin` 是**项目目录内的相对路径**（例：`.venv\Scripts\python.exe`），
   * 用 RELATIVE_BIN_PATTERN 校验而不是"裸名字"。默认 false。
   */
  relativeBin?: boolean;
  /**
   * 工作目录规则：外部命令永远在**明确的**目录里跑，不在"当前碰巧在哪"。
   * `tmp` 用于探测类命令（不需要上下文），另外两个留给脚手架/安装。
   */
  cwdRule: 'workspace' | 'project' | 'tmp';
}

/**
 * 白名单本体：**一行一条，想加命令就加一行**。
 *
 * 刻意做成显式的表而不是"按需拼一个"：审阅时能一眼看完所有能被执行的东西。
 */
const COMMAND_SPECS: readonly CommandSpec[] = [
  {
    id: 'tool-version',
    description: '取一个开发工具的版本号（如 `node --version`）',
    bin: '{tool}',
    args: ['--version'],
    slots: {
      tool: { description: '开发工具名', allowed: DETECTABLE_TOOLS },
    },
    timeoutMs: 5000,
    cwdRule: 'tmp',
  },
  {
    id: 'venv-probe',
    description: '探测 python 是否带 venv 模块（`python -m venv --help`）',
    bin: '{tool}',
    args: ['-m', 'venv', '--help'],
    slots: {
      tool: { description: '要探测的解释器', allowed: ['python'] },
    },
    timeoutMs: 5000,
    cwdRule: 'tmp',
  },

  /* ---------------- 脚手架（M4）：官方 CLI ---------------- */

  {
    id: 'probe-npm-create',
    description: '能力探测：`npm create <pkg> -- --help`（看这个版本的脚手架认哪些参数）',
    /*
     * 为什么探测（技术设计 §5.1 A10）：官方脚手架的参数随版本变，
     * 硬编码参数迟早崩 —— 崩的时候用户看到的是"生成失败"，而不是"参数变了"。
     * 先跑一次 `--help`，把它认得的参数挑出来，再组装正式命令。
     *
     * 超时给到 2 分钟：第一次要**下载**脚手架包。这不是"探测很慢"，是"第一次要联网"。
     */
    bin: 'npm',
    args: ['create', '{pkg}', '--', '--help'],
    slots: {
      pkg: { description: '脚手架包', allowed: ['vue@latest', 'vite@latest'] },
    },
    timeoutMs: 120_000,
    cwdRule: 'tmp',
  },
  {
    id: 'probe-nest-help',
    description: '能力探测：`npx @nestjs/cli new --help`',
    bin: 'npx',
    args: ['--yes', '@nestjs/cli', 'new', '--help'],
    timeoutMs: 120_000,
    cwdRule: 'tmp',
  },
  {
    id: 'scaffold-npm-create',
    description: '用 npm 调官方脚手架：`npm create <pkg> <name> -- <flags…>`',
    bin: 'npm',
    args: ['create', '{pkg}', '{name}', '--', '{flags}'],
    slots: {
      pkg: { description: '脚手架包', allowed: ['vue@latest', 'vite@latest'] },
      name: { description: '目录名（固定用安全名，不用项目名）' },
      /**
       * 参数串由**我们**根据 `--help` 探测结果拼好（不是用户输入），
       * 但仍然只允许白名单字符（见 SAFE_FLAGS_PATTERN）：官方脚手架"认哪些参数"
       * 是外部事实，不该因为它是外部事实就绕过校验。
       */
      flags: {
        description: '已确认可用的参数',
        pattern: SAFE_FLAGS_PATTERN,
        optional: true,
        // 展开成多个 argv 条目（见 CommandSlot.list 的说明）
        list: true,
      },
    },
    timeoutMs: 5 * 60 * 1000,
    cwdRule: 'project',
  },
  {
    id: 'scaffold-nest-new',
    description: '官方 NestJS 脚手架：`npx @nestjs/cli new <name> --package-manager <pm> <flags…>`',
    bin: 'npx',
    args: ['--yes', '@nestjs/cli', 'new', '{name}', '--package-manager', '{pm}', '{flags}'],
    slots: {
      name: { description: '目录名（固定用安全名）' },
      pm: { description: '包管理器', allowed: ['pnpm', 'npm', 'yarn'] },
      /**
       * `--skip-git` 是我们固定要的（版本管理由应用自己的 Git 模块负责，见技术设计 §5.10），
       * `--strict` 之类的**用户选项**也走这一格 —— 与 `scaffold-npm-create` 同一套值校验。
       */
      flags: {
        description: '已确认可用的参数',
        pattern: SAFE_FLAGS_PATTERN,
        optional: true,
        list: true,
      },
    },
    timeoutMs: 10 * 60 * 1000,
    cwdRule: 'project',
  },
  {
    id: 'scaffold-django',
    description:
      '官方 Django 脚手架：`<venv>/Scripts/django-admin startproject <name> <destination>`（在 venv 里跑）',
    /*
     * `bin` 写成**项目目录内的相对路径**：`django-admin` 是 pip 装进 venv 的，
     * 它不在 PATH 上（全局装了 Django 也不该用那一个 —— 版本可能与项目要求不符）。
     * 校验用 RELATIVE_BIN_PATTERN：不允许 `..`、不允许绝对路径，
     * 而运行时的 cwd 一定是那个项目文件夹，所以它只能指向我们刚建出来的 venv 里。
     *
     * **目标目录为什么要单独一格**（真跑一次才发现的）：`django-admin startproject name .`
     * 里的 `.` 要求 cwd 是目标目录，而这个可执行文件是**相对路径** ——
     * cwd 一旦是暂存目录，`.venv\Scripts\django-admin.exe` 就找不到了（报 ENOENT，
     * 看起来像"Django 没装上"，其实是路径相对谁的问题）。
     * 所以改成"cwd 留在项目文件夹（venv 在那儿），把暂存目录当**目的地**传进去"：
     * Django 支持 `startproject <name> <directory>`。
     */
    bin: '{django}',
    relativeBin: true,
    args: ['startproject', '{name}', '{destination}'],
    slots: {
      django: {
        description: '虚拟环境里的 django-admin（项目目录内的相对路径）',
        pattern: RELATIVE_BIN_PATTERN,
      },
      name: { description: '项目包名（Python 标识符）', pattern: /^[A-Za-z_][A-Za-z0-9_]{0,40}$/ },
      /**
       * 目的地：**单段**相对目录名（例 `.scaffold-staging`）。
       *
       * 不允许分隔符，也不允许 `.` / `..` —— 后者会让 Django 把项目生成到项目文件夹**外面**，
       * 而这一格是"我们自己给的值"，仍然要按纪律校验（单测里就抓到了 `..` 能通过第一版正则）。
       */
      destination: {
        description: '生成到哪个子目录（项目内单段目录名，不允许 . 与 ..）',
        pattern: /^(?!\.{1,2}$)[A-Za-z0-9._-]+$/,
      },
    },
    timeoutMs: 5 * 60 * 1000,
    cwdRule: 'project',
  },
  {
    id: 'probe-django-help',
    description: '能力探测：`<venv>/Scripts/django-admin --help`（确认它认 startproject）',
    bin: '{django}',
    relativeBin: true,
    args: ['--help'],
    slots: {
      django: {
        description: '虚拟环境里的 django-admin（项目目录内的相对路径）',
        pattern: RELATIVE_BIN_PATTERN,
      },
    },
    timeoutMs: 60_000,
    cwdRule: 'project',
  },

  /* ---------------- 依赖安装（M4） ---------------- */

  {
    id: 'install-node',
    description: '装 Node 依赖：`<pm> install`',
    bin: '{pm}',
    args: ['install'],
    slots: {
      pm: { description: '包管理器', allowed: ['pnpm', 'npm', 'yarn'] },
    },
    timeoutMs: 20 * 60 * 1000,
    cwdRule: 'project',
  },
  /* ---------------- 把项目跑起来（M4，长驻进程） ---------------- */

  {
    id: 'run-node-dev',
    description: '启动 Node 项目的开发服务器：`<pm> run <script>`（Vite / NestJS 都是这条）',
    /*
     * 脚本名走**白名单枚举**，不是自由文本：`dev` / `start` / `start:dev` 是我们认的三个，
     * 别的名字（`postinstall`、`deploy`…）一律进不来。用户输入只能决定"用哪个包管理器"，
     * 不能决定"跑哪个脚本"。
     */
    bin: '{pm}',
    args: ['run', '{script}'],
    slots: {
      pm: { description: '包管理器', allowed: ['pnpm', 'npm', 'yarn'] },
      script: { description: '要跑的脚本', allowed: ['dev', 'start', 'start:dev'] },
    },
    timeoutMs: 0,
    longRunning: true,
    cwdRule: 'project',
  },
  {
    id: 'run-python-uvicorn',
    description: '启动 FastAPI 开发服务器：`<venv>/Scripts/python -m uvicorn app.main:app --reload --port <port>`',
    bin: '{python}',
    relativeBin: true,
    args: ['-m', 'uvicorn', 'app.main:app', '--reload', '--port', '{port}'],
    slots: {
      python: {
        description: '虚拟环境里的 python（项目目录内的相对路径）',
        pattern: RELATIVE_BIN_PATTERN,
      },
      port: { description: '端口', pattern: /^\d{2,5}$/ },
    },
    timeoutMs: 0,
    longRunning: true,
    cwdRule: 'project',
  },
  {
    id: 'run-django-runserver',
    description: '启动 Django 开发服务器：`<venv>/Scripts/python manage.py runserver <port>`',
    bin: '{python}',
    relativeBin: true,
    args: ['manage.py', 'runserver', '{port}'],
    slots: {
      python: {
        description: '虚拟环境里的 python（项目目录内的相对路径）',
        pattern: RELATIVE_BIN_PATTERN,
      },
      port: { description: '端口', pattern: /^\d{2,5}$/ },
    },
    timeoutMs: 0,
    longRunning: true,
    cwdRule: 'project',
  },
  {
    id: 'kill-process-tree',
    description: '结束一棵进程树：`taskkill /PID <pid> /T /F`（只用于我们自己启动的开发服务器）',
    /*
     * 为什么必须有这一条：`npm run dev` 会派生出 `cmd.exe` → `npm` → `node` 三层，
     * 只杀最外层（Node 的 `child.kill()`）**留下的是真正在监听的孙进程** ——
     * 端口还占着，下一次启动就报"端口被占用"，而用户明明点过"停止"。
     *
     * PID 只允许数字，且调用方只传**我们自己 spawn 出来的**那个 pid（不是用户输入）。
     */
    bin: 'taskkill',
    args: ['/PID', '{pid}', '/T', '/F'],
    slots: {
      pid: { description: '进程号（我们自己启动的那个）', pattern: /^\d{1,10}$/ },
    },
    timeoutMs: 30_000,
    cwdRule: 'tmp',
  },

  {
    id: 'python-venv',
    description: '给 Python 项目建虚拟环境：`python -m venv .venv`',
    bin: 'python',
    args: ['-m', 'venv', '{name}'],
    slots: {
      name: { description: '虚拟环境目录名', allowed: ['.venv', 'venv'] },
    },
    timeoutMs: 3 * 60 * 1000,
    cwdRule: 'project',
  },
  {
    id: 'python-pip-install',
    description: '在虚拟环境里装依赖：`<venv>/Scripts/python -m pip install -r requirements.txt`',
    /*
     * 用 `python -m pip` 而不是 `<venv>\Scripts\pip.exe`：后者是个 exe 包着 pip 的入口，
     * 前者少一层、也不怕 Scripts 目录里 exe 名不一致（Windows/Linux 的目录名还不同）。
     */
    bin: '{python}',
    relativeBin: true,
    args: ['-m', 'pip', 'install', '-r', '{requirements}'],
    slots: {
      python: {
        description: '虚拟环境里的 python（**项目目录内的相对路径**，cwd 由 runner 保证）',
        pattern: RELATIVE_BIN_PATTERN,
      },
      requirements: { description: '依赖清单文件', allowed: ['requirements.txt', 'pyproject.toml'] },
    },
    timeoutMs: 20 * 60 * 1000,
    cwdRule: 'project',
  },
];

export function listCommandSpecs(): readonly CommandSpec[] {
  return COMMAND_SPECS;
}

export function getCommandSpec(id: string): CommandSpec {
  const spec = COMMAND_SPECS.find((item) => item.id === id);
  if (!spec) {
    throw new Error(
      `未知的命令 spec「${id}」。所有外部命令都必须来自白名单（${COMMAND_SPECS.map((s) => s.id).join(' / ')}）`,
    );
  }
  return spec;
}

/* ------------------------------------------------------------------ */
/* 组装与校验                                                          */
/* ------------------------------------------------------------------ */

export interface BuiltCommand {
  spec: CommandSpec;
  bin: string;
  args: string[];
  /** 是不是改走 `cmd.exe /d /c` 了（Windows 上的 `.cmd` 批处理壳） */
  shimmed: boolean;
}

export interface BuildCommandOptions {
  /**
   * 调用方**已经从 PATH 上解析出来的可执行文件绝对路径**（可选）。
   *
   * 它的作用只有一个：判断这是不是一个 Windows 批处理壳（`.cmd` / `.bat`）。
   * 批处理**没法用 `shell: false` 直接启动**（`execFile('npm.cmd')` 直接失败），
   * 而 npm / pnpm / yarn / npx 在 Windows 上全都是这种壳，且没有 exe 可反推
   * （`main/editor.ts` 里那套"反推真实 exe"对它们不适用）——
   * 所以只能借 `cmd.exe` 执行。
   *
   * 这**不是**"退回拼字符串"：可执行文件固定是 `cmd.exe`、参数固定是 `/d /c …`，
   * 而里面那一段来自白名单 spec（bin 是裸名字、值位经过枚举/正则校验，
   * 不含空格与 shell 元字符），Node 这边仍然是 `shell: false`。
   */
  executePath?: string;
}

/** 批处理壳（`.cmd` / `.bat`）：Windows 上没法直接 spawn 的那一类 */
export function isWindowsScriptShim(path: string): boolean {
  return /\.(cmd|bat)$/i.test(path);
}

/**
 * 校验一个值位的取值。
 *
 * 导出是为了**能单独测**：当前白名单里的 spec 都用了枚举（比正则更严格），
 * 但正则这条路是留给"取值说不完"的参数的（比如自定义目录名），
 * 与其等第一个用到它的 spec 出现时才发现写错了，不如现在就把规则钉住。
 */
export function validateSlotValue(
  specId: string,
  name: string,
  slot: CommandSlot,
  value: string,
): string {
  const trimmed = value.trim();
  if (trimmed.length === 0) throw new Error(`${specId}：参数 ${name} 不能为空`);

  if (slot.allowed) {
    if (!slot.allowed.includes(trimmed)) {
      throw new Error(
        `${specId}：${name} 只能是 ${slot.allowed.join(' / ')} 之一，收到的是「${trimmed}」`,
      );
    }
    return trimmed;
  }

  const pattern = slot.pattern ?? SAFE_VALUE_PATTERN;
  if (!pattern.test(trimmed)) {
    throw new Error(
      `${specId}：${name} 的取值「${trimmed}」不安全（只允许字母数字与 . _ -），拒绝执行`,
    );
  }
  return trimmed;
}

/**
 * 列表型值位：拆成 token 并**逐个**校验。
 *
 * 逐个校验比"校验一整串"更严：正则只能表达"整体长什么样"，
 * 而这里要保证的是"**每一个参数**都是安全 token"。
 */
export function validateListSlotValue(
  specId: string,
  name: string,
  slot: CommandSlot,
  value: string,
): string[] {
  const tokens = value.split(/\s+/).filter((token) => token.length > 0);
  if (tokens.length === 0) throw new Error(`${specId}：参数 ${name} 不能为空`);
  return tokens.map((token) => validateSlotValue(specId, name, slot, token));
}

/**
 * 可执行文件名只允许"裸名字"。
 *
 * 拼装完成后再验一次：只要允许出现路径分隔符，就等于允许执行任意位置的程序，
 * 白名单也就没意义了。这是纵深防御的第二道（第一道是值位的枚举/正则）。
 */
export function assertSafeBin(specId: string, bin: string, options: { relative?: boolean } = {}): string {
  if (options.relative === true) {
    if (!RELATIVE_BIN_PATTERN.test(bin)) {
      throw new Error(
        `${specId}：可执行文件名「${bin}」不合法（只允许**项目目录内**的相对路径，不允许 .. 与绝对路径）`,
      );
    }
    return bin;
  }
  if (!SAFE_VALUE_PATTERN.test(bin)) {
    throw new Error(`${specId}：可执行文件名「${bin}」不合法（不允许路径分隔符与空格）`);
  }
  return bin;
}

/**
 * 按 spec 组装一条命令。
 *
 * 校验顺序就是防御顺序：**先认 spec（白名单）→ 再逐项校验值位 → 最后才替换**。
 * 任何一步不过就抛错，绝不"先拼出来再说"。
 */
export function buildCommand(
  specId: string,
  values: Readonly<Record<string, string>> = {},
  options: BuildCommandOptions = {},
): BuiltCommand {
  const spec = getCommandSpec(specId);
  const slots = spec.slots ?? {};

  // 传了没声明的值位 = 调用方写错了（拼错名字会被静默忽略，那是更坏的结果）
  for (const name of Object.keys(values)) {
    if (!(name in slots)) {
      throw new Error(`${specId}：没有声明参数 ${name}（可用：${Object.keys(slots).join(' / ') || '无'}）`);
    }
  }

  const resolved: Record<string, string> = {};
  const listValues: Record<string, string[]> = {};
  for (const [name, slot] of Object.entries(slots)) {
    const raw = values[name];
    if (raw === undefined) {
      if (slot.optional === true) continue;
      throw new Error(`${specId}：缺少参数 ${name}`);
    }
    if (slot.list === true) {
      listValues[name] = validateListSlotValue(specId, name, slot, raw);
      continue;
    }
    resolved[name] = validateSlotValue(specId, name, slot, raw);
  }

  const fill = (template: string, what: string): string => {
    const filled = template.replace(/\{([^}]+)\}/g, (_whole, name: string) => {
      const value = resolved[name];
      if (value === undefined) throw new Error(`${specId}：${what} 用到了未赋值的 {${name}}`);
      return value;
    });
    if (filled.includes('{') || filled.includes('}')) {
      throw new Error(`${specId}：${what} 里有没替换掉的占位符：${filled}`);
    }
    return filled;
  };

  const bin = assertSafeBin(specId, fill(spec.bin, '可执行文件名'), {
    relative: spec.relativeBin === true,
  });

  /*
   * 参数逐个处理：`args` 里**独占一格**的 `{slot}` 且该 slot 是列表 → 展开成多个条目。
   * （不能先拼成字符串再 split：那样会把本来就在参数里的空格也切开。）
   */
  const args: string[] = [];
  for (const template of spec.args) {
    const whole = /^\{([^}]+)\}$/.exec(template);
    const listName = whole?.[1];
    if (listName !== undefined && slots[listName]?.list === true) {
      const list = listValues[listName];
      /*
       * 列表型值位没给值 = **整格消失**（不留一个空参数）。
       *
       * 这条是"可选选项"逼出来的：`--strict` 这类由用户在界面上勾选的参数，
       * 不勾的时候就真的一个都不该传。若按普通值位处理会抛"用到了未赋值的 {flags}"，
       * 那就变成"用户什么都没选 → 命令直接报错"，方向完全错了。
       * 注意：**非列表**的可选值位仍然抛错（少了一个值就是拼错了命令，不该静默继续）。
       */
      if (list === undefined) continue;
      args.push(...list);
      continue;
    }
    args.push(fill(template, '参数'));
  }

  // 批处理壳（Windows 上的 npm / pnpm / npx）：借 cmd.exe 执行，参数与顺序都不变
  if (options.executePath !== undefined && isWindowsScriptShim(options.executePath)) {
    return { spec, bin: 'cmd.exe', args: ['/d', '/c', bin, ...args], shimmed: true };
  }

  return { spec, bin, args, shimmed: false };
}

/** 给人看的命令预览（只用于日志与界面展示，**从不拿来执行**） */
export function commandPreview(built: BuiltCommand): string {
  const quote = (value: string): string => (/[\s"]/.test(value) ? JSON.stringify(value) : value);
  return [built.bin, ...built.args].map(quote).join(' ');
}

/* ------------------------------------------------------------------ */
/* 执行                                                               */
/* ------------------------------------------------------------------ */

export interface CommandRunResult {
  specId: string;
  bin: string;
  args: string[];
  /** 进程退出码；被超时或取消杀掉时为 null */
  code: number | null;
  ok: boolean;
  timedOut: boolean;
  /** 被调用方的 AbortSignal 取消（作业取消 / 应用退出）：**不是失败**，别按失败上报 */
  canceled: boolean;
  stdout: string;
  stderr: string;
  durationMs: number;
}

export interface RawExecResult {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  canceled?: boolean;
}

export interface ExecOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs: number;
  /** 取消信号：作业被取消时用它可以真的把子进程干掉，而不是等它自己跑完 */
  signal?: AbortSignal;
}

/** 执行函数是**注入**的：单测里换成假的，就不必真的派生进程 */
export type CommandExec = (bin: string, args: string[], options: ExecOptions) => Promise<RawExecResult>;

/** 输出上限：命令跑飞了也不能把内存和日志塞满 */
const MAX_OUTPUT_CHARS = 4096;

function trimOutput(text: string): string {
  const normalized = text.replace(/\r\n/g, '\n').trim();
  return normalized.length > MAX_OUTPUT_CHARS
    ? `${normalized.slice(0, MAX_OUTPUT_CHARS)}…（输出已截断）`
    : normalized;
}

/**
 * 真实执行器：`execFile` + `shell: false` + 超时。
 *
 * 用 `execFile` 而不是 `exec`：后者会起 shell，正是要避免的东西。
 * 超时由 Node 杀掉子进程；**整棵进程树**的清理（`taskkill /T /F`）留给作业执行器 ——
 * 那一步才有会派生孙进程的命令（`npm` / `pnpm`），这里探测类命令没有。
 */
export function createExecFileRunner(): CommandExec {
  return (bin, args, options) =>
    new Promise<RawExecResult>((resolve) => {
      execFile(
        bin,
        args,
        {
          shell: false,
          windowsHide: true,
          timeout: options.timeoutMs,
          maxBuffer: 1024 * 1024,
          ...(options.cwd !== undefined ? { cwd: options.cwd } : {}),
          ...(options.env !== undefined ? { env: options.env } : {}),
          // Node 的 `signal` 会在 abort 时杀掉子进程（孙进程要靠 taskkill /T，见文件头说明）
          ...(options.signal !== undefined ? { signal: options.signal } : {}),
        },
        (error, stdout, stderr) => {
          const canceled = options.signal?.aborted === true;
          const timedOut = !canceled && Boolean(error && (error as { killed?: boolean }).killed === true);
          resolve({
            code: error ? ((error as { code?: number }).code ?? null) : 0,
            stdout: stdout ?? '',
            stderr: stderr ?? '',
            timedOut,
            canceled,
          });
        },
      );
    });
}

export interface RunCommandOptions {
  exec?: CommandExec;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  /** 取消信号：作业取消时传进来，子进程会被真的杀掉 */
  signal?: AbortSignal;
  /** 已解析到的可执行文件路径（判断要不要走 `cmd.exe`，见 BuildCommandOptions） */
  executePath?: string;
}

/**
 * 跑一条白名单命令并拿到结果。
 *
 * **永不抛错**（除了组装阶段的校验错误）：命令不存在、超时、退出码非 0
 * 都是"可以预期的事实"，调用方要靠 `ok / timedOut / code` 自己判断，
 * 而不是被异常打断（环境检测尤其如此——工具没装是常态）。
 */
export async function runCommand(
  specId: string,
  values: Readonly<Record<string, string>> = {},
  options: RunCommandOptions = {},
): Promise<CommandRunResult> {
  /*
   * 长驻命令**不许**走这里。
   *
   * `runCommand` 的语义是"跑完拿结果"：它会把输出缓到进程结束再返回。
   * 开发服务器永远不会结束 —— 走这条路的结果是"点了启动，界面上永远什么都没有"。
   * 所以这里直接拦下，把错误指到正确的执行器上（比让人 debug 半小时强）。
   */
  if (getCommandSpec(specId).longRunning === true) {
    throw new Error(
      `「${specId}」是长驻命令（开发服务器），不能用 runCommand：` +
        '它需要边跑边看输出，请用 dev-servers 的流式执行器',
    );
  }

  const built = buildCommand(specId, values, {
    ...(options.executePath !== undefined ? { executePath: options.executePath } : {}),
  });
  const exec = options.exec ?? createExecFileRunner();
  const startedAt = Date.now();

  const raw = await exec(built.bin, built.args, {
    timeoutMs: built.spec.timeoutMs,
    ...(options.cwd !== undefined ? { cwd: options.cwd } : {}),
    ...(options.env !== undefined ? { env: options.env } : {}),
    ...(options.signal !== undefined ? { signal: options.signal } : {}),
  });

  return {
    specId,
    bin: built.bin,
    args: built.args,
    code: raw.code,
    ok: !raw.timedOut && !raw.canceled && raw.code === 0,
    timedOut: raw.timedOut,
    canceled: raw.canceled === true,
    stdout: trimOutput(raw.stdout),
    stderr: trimOutput(raw.stderr),
    durationMs: Date.now() - startedAt,
  };
}
