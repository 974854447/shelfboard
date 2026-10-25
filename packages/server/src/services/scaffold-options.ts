/**
 * 技术栈的「维度」→ 官方脚手架的参数。
 *
 * ## 为什么单独一个模块
 *
 * 两件事必须分开：
 *
 * 1. **维度是数据**（`scaffold-templates.ts` 里的 `dimensions`）：声明"这个栈能选什么"，
 *    界面照着它渲染 —— 于是不会出现"某个栈下面挂着一个点了也没用的开关"。
 * 2. **拼参数是逻辑**（这里）：要处理"某个选择组合官方其实做不到"的情况。
 *
 * 第 2 点不是假想：`create-vue` 在没有**任何** feature flag 时会**转成交互式提问**
 * （文档原话："Runs in interactive mode if started without feature flags"），
 * 而我们的环境是非交互的（没有 TTY）—— 于是"JavaScript + 什么附加项都不要"这个
 * 完全合理的组合，官方这条路走不通。这种规则写不进数据表里，只能写成代码，
 * 而且写在这里能单测。
 *
 * ## 纪律：参数一个都不是用户直接给的
 *
 * 用户选的是**我们声明过的 choice id**，参数由 choice 上写死的 `args` 拼出来，
 * 全部还要再过一遍"官方脚手架自己认不认"（见 scaffold-official.ts 的探测）。
 */

import type { TemplateDescriptor, TemplateDimension } from './scaffold-templates.js';

export type SelectionValue = string | string[];
export type Selections = Record<string, SelectionValue>;

/** 默认选择 = 描述里声明的默认值（界面拿不到、或旧载荷没带选择时用它） */
export function defaultSelections(descriptor: TemplateDescriptor): Selections {
  const result: Selections = {};
  for (const dimension of descriptor.dimensions) {
    result[dimension.id] = Array.isArray(dimension.defaultValue)
      ? [...dimension.defaultValue]
      : dimension.defaultValue;
  }
  return result;
}

export interface SelectionValidation {
  values: Selections;
  problems: string[];
}

/**
 * 校验用户选择：**只认声明过的维度与取值**。
 *
 * 与端口校验同一条纪律：服务端不能只信界面。界面是我们写的，但接口是公开的，
 * 而且"多传一个没声明过的维度"如果没有报错，就会静默变成"用户以为选了、其实没选"。
 */
export function validateSelections(descriptor: TemplateDescriptor, input: unknown): SelectionValidation {
  const problems: string[] = [];
  const values = defaultSelections(descriptor);
  if (input === undefined || input === null) return { values, problems };
  if (typeof input !== 'object' || Array.isArray(input)) {
    return { values, problems: [`「${descriptor.name}」的选项格式不对：要一个对象`] };
  }

  for (const [key, raw] of Object.entries(input as Record<string, unknown>)) {
    const dimension = descriptor.dimensions.find((item) => item.id === key);
    if (!dimension) {
      problems.push(`「${descriptor.name}」没有「${key}」这个选项`);
      continue;
    }
    const ids = dimension.choices.map((choice) => choice.id);

    if (dimension.kind === 'choice') {
      if (typeof raw !== 'string' || !ids.includes(raw)) {
        problems.push(`「${descriptor.name}」的「${dimension.label}」只能是：${ids.join(' / ')}`);
        continue;
      }
      values[dimension.id] = raw;
      continue;
    }

    if (!Array.isArray(raw) || raw.some((item) => typeof item !== 'string')) {
      problems.push(`「${descriptor.name}」的「${dimension.label}」要给一组取值`);
      continue;
    }
    const unknown = (raw as string[]).filter((item) => !ids.includes(item));
    if (unknown.length > 0) {
      problems.push(`「${descriptor.name}」的「${dimension.label}」里没有：${unknown.join('、')}`);
      continue;
    }
    values[dimension.id] = [...(raw as string[])];
  }

  return { values, problems };
}

interface PickedChoice {
  dimension: TemplateDimension;
  choiceId: string;
  args: readonly string[];
  /** 版本类选项才有的：要写进依赖清单的版本 */
  pins?: Record<string, string>;
}

/** 按声明顺序取出被选中的 choice（单选维度取一个，多选维度取若干个） */
function pickedChoices(descriptor: TemplateDescriptor, values: Selections): PickedChoice[] {
  const picked: PickedChoice[] = [];
  for (const dimension of descriptor.dimensions) {
    const value = values[dimension.id];
    if (dimension.kind === 'choice') {
      const choice = dimension.choices.find((item) => item.id === value);
      if (choice) {
        picked.push({
          dimension,
          choiceId: choice.id,
          args: choice.args,
          ...(choice.pins !== undefined ? { pins: choice.pins } : {}),
        });
      }
      continue;
    }
    for (const choice of dimension.choices) {
      if (Array.isArray(value) && value.includes(choice.id)) {
        picked.push({
          dimension,
          choiceId: choice.id,
          args: choice.args,
          ...(choice.pins !== undefined ? { pins: choice.pins } : {}),
        });
      }
    }
  }
  return picked;
}

/**
 * 日志里那一行"用户到底选了什么"。
 *
 * 单独抽出来是因为**日志要能当证据用**：用户在向导里点了什么、服务端实际按什么拼的参数，
 * 两者对不上时必须一眼看出来（上一版就是"以为传了参数、其实被当成一个字符串"）。
 */
export function describeSelections(descriptor: TemplateDescriptor, values: Selections): string {
  const parts: string[] = [];
  for (const dimension of descriptor.dimensions) {
    const value = values[dimension.id];
    if (dimension.kind === 'choice') {
      const choice = dimension.choices.find((item) => item.id === value);
      if (choice) parts.push(choice.label);
      continue;
    }
    const chosen = dimension.choices.filter((item) => Array.isArray(value) && value.includes(item.id));
    parts.push(chosen.length > 0 ? chosen.map((item) => item.label).join(' + ') : `${dimension.label}：无`);
  }
  return [descriptor.name, ...parts].join(' · ');
}

export interface OfficialInvocation {
  spec: 'scaffold-npm-create' | 'scaffold-nest-new' | 'scaffold-django';
  /** `npm create <package>` 的包名（Vue 有条岔路会换成 create-vite，所以这里可覆盖） */
  package?: string;
  /** 追加到命令行末尾的参数（探测时会逐个确认官方认不认） */
  args: string[];
  /** 写进日志的说明（例：为什么这次换了脚手架） */
  notes: string[];
}

/**
 * 取这次选择要写进依赖清单的版本（包名 → 版本描述）。
 *
 * 与"官方参数"分开：官方脚手架只认它自己的参数（`--vue-rc` 这类），
 * 而"锁 React 18.3""Django 4.2 LTS"官方根本不支持 —— 那部分只能我们自己改清单，
 * 所以这里把它们汇总出来交给 `applyVersionPins`。
 */
export function pinsFor(descriptor: TemplateDescriptor, values: Selections): Record<string, string> {
  const pins: Record<string, string> = {};
  for (const item of pickedChoices(descriptor, values)) {
    Object.assign(pins, item.pins ?? {});
  }
  return pins;
}

/**
 * 把选择拼成"要跑什么"。
 *
 * 返回的是**意图**，能不能真的这么跑由探测决定（`probeOfficialScaffold`）。
 * 这样分层的好处是：官方改了参数时，报出来的是"官方不认 --router"，
 * 而不是一句含糊的"生成失败"。
 */
export function buildOfficialInvocation(
  descriptor: TemplateDescriptor,
  values: Selections,
): OfficialInvocation {
  const notes: string[] = [];
  const picked = pickedChoices(descriptor, values);
  const args: string[] = [];
  for (const item of picked) args.push(...item.args);

  if (descriptor.id === 'vue3') {
    const isJs = values.language === 'js';
    const addons = picked.filter((item) => item.dimension.id === 'addons');

    /*
     * 这个组合（JS + 无附加项）是真实存在的需求，但 create-vue 做不到：
     * 没有 feature flag 它就走交互式提问，而我们没有 TTY。
     * 我们**如实换一条官方路**（Vite 官方的 Vue 模板），而不是：
     *  - 偷偷给它加个用户没要的附加项（生成的代码与用户选的不一致），或
     *  - 直接失败（明明有能用的官方模板）。
     */
    if (isJs && addons.length === 0) {
      notes.push(
        'JavaScript 且没有勾任何附加项：create-vue 在没有 feature flag 时会转成交互式提问，' +
          '所以这一条改用 Vite 官方模板（create-vite --template vue）',
      );
      return {
        spec: 'scaffold-npm-create',
        package: 'vite@latest',
        args: ['--template', 'vue', '--no-interactive'],
        notes,
      };
    }

    // `--force`：暂存目录里万一有残留，让官方直接覆盖而不是停下来问
    args.push('--force');
    return { spec: 'scaffold-npm-create', package: 'vue@latest', args, notes };
  }

  if (descriptor.id === 'react') {
    const eslint = Array.isArray(values.addons) && values.addons.includes('eslint');
    // 显式写清楚用哪个 linter：不写的话官方默认是 Oxlint，用户会以为"我选的 ESLint 没生效"
    args.push(eslint ? '--eslint' : '--no-eslint');
    args.push('--no-interactive');
    return {
      spec: 'scaffold-npm-create',
      package: 'vite@latest',
      args: [...new Set(args)],
      notes,
    };
  }

  if (descriptor.id === 'nestjs') {
    /*
     * `--skip-git` 由我们固定带上：版本管理归应用自己的 Git 模块（§5.10），
     * 脚手架顺手 `git init` 会在项目文件夹里留一个"应用不知道"的仓库。
     */
    return { spec: 'scaffold-nest-new', args: ['--skip-git', ...args], notes };
  }

  if (descriptor.id === 'django') {
    /*
     * Django 这条**没有额外参数**：`django-admin startproject <name> .` 里的名字由调用方算
     * （它必须是合法的 Python 标识符），版本则通过 `pins` 落到 `requirements.txt`。
     * 也就是说：这个 invocation 只说"用哪条 spec"，具体怎么装由前置那一段负责。
     */
    notes.push('Django 的官方命令在项目自己的 .venv 里跑（前置步骤会先装好 Django）');
    return { spec: 'scaffold-django', args, notes };
  }

  throw new Error(`「${descriptor.name}」没有登记官方脚手架，不该走到这里`);
}
