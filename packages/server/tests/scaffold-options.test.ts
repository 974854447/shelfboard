import { describe, expect, it } from 'vitest';

import {
  buildOfficialInvocation,
  defaultSelections,
  describeSelections,
  validateSelections,
} from '../src/services/scaffold-options';
import { findTemplate } from '../src/services/scaffold-templates';

/**
 * 维度 → 官方参数（M4 第七刀）。
 *
 * 这一层最值得测的不是"参数拼对了"，而是**那些官方做不到的组合**：
 * 它们要么有替代方案（JS + 无附加项改用 create-vite），要么必须明确报错。
 * 拼错的参数在真机上表现为"生成失败"，而用户会以为是网络问题。
 */

function template(id: string) {
  const descriptor = findTemplate(id);
  if (!descriptor) throw new Error(`测试用的模板不存在：${id}`);
  return descriptor;
}

describe('默认选择', () => {
  it('每个维度的默认值来自声明（界面不写死第二份）', () => {
    expect(defaultSelections(template('vue3'))).toEqual({
      language: 'ts',
      version: 'stable',
      addons: ['router', 'pinia', 'eslint', 'prettier'],
    });
    expect(defaultSelections(template('react'))).toEqual({ language: 'ts', version: '19', addons: [] });
    expect(defaultSelections(template('nestjs'))).toEqual({ version: '12', addons: ['strict'] });
    // 内置的 Python 栈只有"版本"这一个维度（语言就是 Python，不必做成控件）
    expect(defaultSelections(template('fastapi'))).toEqual({ version: 'range' });
  });

  it('默认选择的多选值是**拷贝**：调用方改它不该污染声明', () => {
    const first = defaultSelections(template('vue3'));
    (first.addons as string[]).push('vitest');
    expect(defaultSelections(template('vue3')).addons).toEqual(['router', 'pinia', 'eslint', 'prettier']);
  });
});

describe('选择校验（服务端不能只信界面）', () => {
  it('认得的维度与取值原样通过', () => {
    const result = validateSelections(template('vue3'), {
      language: 'js',
      version: 'rc',
      addons: ['pinia', 'jsx'],
    });
    expect(result.problems).toEqual([]);
    // 没提到的维度用声明里的默认值补齐（不是留空）
    expect(result.values).toEqual({ language: 'js', version: 'rc', addons: ['pinia', 'jsx'] });
    expect(validateSelections(template('vue3'), { addons: [] }).values.version).toBe('stable');
  });

  it('没声明过的维度要报错，而不是静默忽略', () => {
    const result = validateSelections(template('fastapi'), { language: 'js' });
    expect(result.problems.join()).toContain('没有「language」这个选项');
  });

  it('取值不在候选里要报错，并列出候选', () => {
    const result = validateSelections(template('vue3'), { language: 'kotlin' });
    expect(result.problems.join()).toContain('只能是');
    expect(result.problems.join()).toContain('ts');
  });

  it('多选维度收数组，单选维度不收数组', () => {
    expect(validateSelections(template('vue3'), { addons: 'pinia' }).problems.join()).toContain(
      '要给一组取值',
    );
    expect(validateSelections(template('vue3'), { language: ['ts'] }).problems.join()).toContain(
      '只能是',
    );
  });

  it('没传就用默认值（旧载荷与旧界面照样能跑）', () => {
    expect(validateSelections(template('vue3'), undefined).values).toEqual(defaultSelections(template('vue3')));
    expect(validateSelections(template('vue3'), null).problems).toEqual([]);
  });
});

describe('日志里那一行"用户选了什么"', () => {
  it('把维度读成中文标签，方便核对', () => {
    expect(describeSelections(template('vue3'), { language: 'js', addons: ['pinia'] })).toBe(
      'Vue 3 · JavaScript · Pinia',
    );
  });

  it('一个附加项都没选时明说"无"，而不是留空', () => {
    expect(describeSelections(template('react'), { language: 'ts', addons: [] })).toBe(
      'React · TypeScript · 附加项：无',
    );
  });
});

describe('拼官方命令', () => {
  it('Vue + TypeScript：按顺序拼出 create-vue 的参数，并带上 --force', () => {
    const invocation = buildOfficialInvocation(template('vue3'), {
      language: 'ts',
      addons: ['router', 'pinia'],
    });
    expect(invocation.spec).toBe('scaffold-npm-create');
    expect(invocation.package).toBe('vue@latest');
    expect(invocation.args).toEqual(['--ts', '--router', '--pinia', '--force']);
  });

  it('Vue + JavaScript + 有附加项：**不带** --ts（去掉它才是 JS）', () => {
    const invocation = buildOfficialInvocation(template('vue3'), {
      language: 'js',
      addons: ['router'],
    });
    expect(invocation.package).toBe('vue@latest');
    expect(invocation.args).toEqual(['--router', '--force']);
    expect(invocation.args).not.toContain('--ts');
  });

  /**
   * 这条是本模块存在的主要理由：`create-vue` 没有任何 feature flag 时会
   * **转成交互式提问**（文档原话），而我们的执行环境没有 TTY —— 于是
   * "JavaScript + 什么附加项都不要"这个完全合理的组合必须换一条官方路，
   * 而不是（a）偷偷加个用户没要的附加项，或（b）直接失败。
   */
  it('Vue + JavaScript + 无附加项：改用 Vite 官方模板，并在日志里说明原因', () => {
    const invocation = buildOfficialInvocation(template('vue3'), { language: 'js', addons: [] });
    expect(invocation.package).toBe('vite@latest');
    expect(invocation.args).toEqual(['--template', 'vue', '--no-interactive']);
    expect(invocation.notes.join()).toContain('交互式提问');
  });

  it('Vue + TypeScript + 无附加项：仍然走 create-vue（--ts 本身就是 feature flag）', () => {
    const invocation = buildOfficialInvocation(template('vue3'), { language: 'ts', addons: [] });
    expect(invocation.package).toBe('vue@latest');
    expect(invocation.args).toEqual(['--ts', '--force']);
  });

  it('React：模板名决定语言，linter **显式**写清楚（否则默认是 Oxlint）', () => {
    const ts = buildOfficialInvocation(template('react'), { language: 'ts', addons: [] });
    expect(ts.args).toEqual(['--template', 'react-ts', '--no-eslint', '--no-interactive']);

    const jsEslint = buildOfficialInvocation(template('react'), { language: 'js', addons: ['eslint'] });
    expect(jsEslint.args).toEqual(['--template', 'react', '--eslint', '--no-interactive']);
    // 不能出现两个相反的开关
    expect(jsEslint.args.filter((arg) => arg.endsWith('eslint')).length).toBe(1);
  });

  it('NestJS：固定带 --skip-git，严格模式跟着选择走', () => {
    expect(buildOfficialInvocation(template('nestjs'), { addons: ['strict'] })).toMatchObject({
      spec: 'scaffold-nest-new',
      args: ['--skip-git', '--strict'],
    });
    expect(buildOfficialInvocation(template('nestjs'), { addons: [] }).args).toEqual(['--skip-git']);
  });

  it('FastAPI 没有官方脚手架，硬调要报错而不是编一条命令', () => {
    expect(() => buildOfficialInvocation(template('fastapi'), {})).toThrow(/没有登记官方脚手架/);
  });

  it('Django：官方路径是 `django-admin startproject`，版本**不从参数走**（落 requirements.txt）', () => {
    const invocation = buildOfficialInvocation(template('django'), { version: '4-2-lts' });
    expect(invocation.spec).toBe('scaffold-django');
    // 版本不进命令行：django-admin 不认版本参数，我们靠 requirements.txt 锁
    expect(invocation.args).toEqual([]);
    expect(invocation.notes.join()).toContain('.venv');
    // 内置回退是必须有的（前置要联网，失败不能让用户连项目都没有）
    expect(template('django').fallbackTemplateId).toBe('django');
  });
});
