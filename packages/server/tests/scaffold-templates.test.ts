import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  assertSafeTemplatePath,
  findTemplate,
  renderTemplate,
  renderText,
  TEMPLATES,
  writeTemplateFiles,
  type TemplateVars,
} from '../src/services/scaffold-templates';

/**
 * 内置模板（M4 脚手架的回退路径）。
 *
 * 这里测的是"生成出来的东西对不对、会不会写到不该写的地方"：
 * 变量替换、**语言分支**（TS / JS）、路径安全、**不覆盖已有文件**、以及模板表本身的自洽性。
 * 真正的"生成了一个能跑的项目"由 e2e 证明（那条会真的跑作业、真的落盘）。
 */

/** 造一份变量表：默认 TypeScript，需要 JavaScript 时传 `{ ext: 'js', language: 'js' }` */
function vars(overrides: Partial<TemplateVars> = {}): TemplateVars {
  return {
    projectName: '我的后端',
    packageName: 'my-backend',
    moduleName: 'my_backend',
    port: 8123,
    language: 'ts',
    ext: 'ts',
    ...overrides,
  };
}

const VARS = vars();

describe('模板表', () => {
  it('每个技术栈都有完整的描述信息', () => {
    expect(TEMPLATES.length).toBeGreaterThanOrEqual(4);
    for (const template of TEMPLATES) {
      expect(template.name.length).toBeGreaterThan(0);
      expect(['frontend', 'backend']).toContain(template.kind);
      expect(['official', 'builtin']).toContain(template.source);
      expect(template.languageLabel.length, `${template.id} 的语言标签`).toBeGreaterThan(0);
      // 走官方就必须有 spec；用内置就必须真有那份模板（回退路径不能是空的）
      if (template.source === 'official') expect(template.officialSpec, template.id).toBeDefined();
      if (template.source === 'builtin' || template.fallbackTemplateId) {
        const id = template.source === 'builtin' ? template.id : template.fallbackTemplateId!;
        expect(() => renderTemplate(id, VARS), `${template.id} 的回退模板`).not.toThrow();
      }
    }
  });

  /**
   * 维度是"界面照它渲染"的数据，写错了不会报错、只会**静默少一个控件**
   * （或者渲染出一个默认值不在候选里的下拉）—— 所以这里把不变量钉住。
   */
  it('维度声明自洽：默认值必须在候选里、choice id 不重复', () => {
    for (const template of TEMPLATES) {
      for (const dimension of template.dimensions) {
        const ids = dimension.choices.map((choice) => choice.id);
        expect(new Set(ids).size, `${template.id}/${dimension.id} 的候选 id 不能重复`).toBe(ids.length);
        expect(ids.length, `${template.id}/${dimension.id} 至少要有可选项`).toBeGreaterThan(0);

        if (dimension.kind === 'choice') {
          expect(
            ids,
            `${template.id}/${dimension.id} 的默认值 ${String(dimension.defaultValue)} 不在候选里`,
          ).toContain(dimension.defaultValue);
        } else {
          const defaults = dimension.defaultValue as string[];
          expect(Array.isArray(defaults), `${template.id}/${dimension.id} 多选默认值要给数组`).toBe(true);
          for (const value of defaults) {
            expect(ids, `${template.id}/${dimension.id} 的默认值 ${value} 不在候选里`).toContain(value);
          }
        }
      }
    }
  });

  it('FastAPI 没有官方脚手架，所以必须是内置模板（技术设计 §5.5）', () => {
    const fastapi = findTemplate('fastapi');
    expect(fastapi?.source).toBe('builtin');
    expect(fastapi?.installKind).toBe('python');
  });

  it('模板里不允许出现可执行脚本（模板是数据，不是代码）', () => {
    for (const template of TEMPLATES) {
      const id = template.source === 'builtin' ? template.id : template.fallbackTemplateId;
      if (!id) continue;
      for (const language of ['ts', 'js'] as const) {
        for (const file of renderTemplate(id, vars({ ext: language, language }))) {
          expect(file.content, `${id}/${file.path} 不该带 postinstall`).not.toMatch(
            /"?postinstall"?\s*:/,
          );
        }
      }
    }
  });
});

describe('渲染', () => {
  it('替换项目名、包名与端口', () => {
    expect(renderText('__PROJECT_NAME__ / __PACKAGE_NAME__ / __PORT__', VARS)).toBe(
      '我的后端 / my-backend / 8123',
    );
  });

  it('没定义的占位符原样留着（宁可见到 __X__，也不要静默变空）', () => {
    expect(renderText('a __UNKNOWN__ b', VARS)).toBe('a __UNKNOWN__ b');
  });

  /**
   * 占位符名写错（比如写成 `__VUE_TSDEVS__`）时渲染器**不会报错**，
   * 它会把那个 `__X__` 原样写进生成的项目里 —— 于是用户拿到一个坏掉的
   * `package.json`，而日志里写着"生成完成"。这一条专门盯这种"静默错误"。
   */
  it('渲染完不能剩下大写占位符（Django 的 __init__ 这类小写双下划线不受影响）', () => {
    for (const template of TEMPLATES) {
      const id = template.source === 'builtin' ? template.id : template.fallbackTemplateId;
      if (!id) continue;
      for (const language of ['ts', 'js'] as const) {
        for (const file of renderTemplate(id, vars({ ext: language, language }))) {
          expect(file.content, `${id}/${file.path} 里有没替换的占位符`).not.toMatch(/__[A-Z][A-Z_]*__/);
          expect(file.path, `${id}/${file.path} 的路径里有没替换的占位符`).not.toMatch(/__[A-Z][A-Z_]*__/);
        }
      }
    }
  });

  it('FastAPI 模板：关键文件都在，且内容已经替换过', () => {
    const files = renderTemplate('fastapi', VARS);
    const paths = files.map((file) => file.path);
    expect(paths).toContain('app/main.py');
    expect(paths).toContain('requirements.txt');
    expect(paths).toContain('.gitignore');
    expect(paths).toContain('README.md');

    const main = files.find((file) => file.path === 'app/main.py')!;
    expect(main.content).toContain('我的后端');
    expect(main.content).toContain('8123');
    expect(main.content).not.toContain('__PROJECT_NAME__');

    // 生成的 .gitignore 要挡掉附件与作业日志（它们在代码目录里，见需求 §5.4.1）
    expect(files.find((file) => file.path === '.gitignore')!.content).toContain('attachments/');
  });

  it('Vue 回退模板：是能跑起来的最小骨架，且不含 postinstall', () => {
    const files = renderTemplate('vue3', VARS);
    const pkg = JSON.parse(files.find((file) => file.path === 'package.json')!.content) as {
      name: string;
      scripts: Record<string, string>;
      dependencies: Record<string, string>;
    };
    expect(pkg.name).toBe('my-backend');
    expect(pkg.dependencies.vue).toBeDefined();
    expect(pkg.scripts.dev).toBe('vite');
    expect(JSON.stringify(pkg)).not.toContain('postinstall');
  });

  /**
   * 语言分支：选了 JavaScript 就**不能**给一份 TypeScript。
   *
   * 这条不是洁癖：`tsconfig.json` 与 `.vue` 里的 `lang="ts"` 混在 JS 项目里，
   * 用户第一步就会撞上编辑器报错，而项目本身又确实"生成成功"了。
   */
  it('Vue：TypeScript 模式给 tsconfig，JavaScript 模式给 jsconfig', () => {
    const tsFiles = renderTemplate('vue3', vars());
    const tsPaths = tsFiles.map((file) => file.path);
    expect(tsPaths).toContain('tsconfig.json');
    expect(tsPaths).not.toContain('jsconfig.json');
    expect(tsPaths).toContain('src/main.ts');
    expect(tsPaths).toContain('vite.config.ts');
    expect(tsPaths).toContain('src/env.d.ts');
    expect(tsFiles.find((file) => file.path === 'src/App.vue')!.content).toContain('lang="ts"');
    expect(tsFiles.find((file) => file.path === 'package.json')!.content).toContain('vue-tsc');

    const jsFiles = renderTemplate('vue3', vars({ ext: 'js', language: 'js' }));
    const jsPaths = jsFiles.map((file) => file.path);
    expect(jsPaths).toContain('jsconfig.json');
    expect(jsPaths).not.toContain('tsconfig.json');
    expect(jsPaths).toContain('src/main.js');
    expect(jsPaths).toContain('vite.config.js');
    expect(jsPaths).not.toContain('src/env.d.ts');
    expect(jsFiles.find((file) => file.path === 'src/App.vue')!.content).not.toContain('lang="ts"');
    expect(jsFiles.find((file) => file.path === 'index.html')!.content).toContain('/src/main.js');
    expect(jsFiles.find((file) => file.path === 'package.json')!.content).not.toContain('vue-tsc');
  });

  it('React 回退模板：入口是 tsx/jsx，且跟着语言走', () => {
    const tsFiles = renderTemplate('react', vars());
    const tsPaths = tsFiles.map((file) => file.path);
    expect(tsPaths).toContain('src/main.tsx');
    expect(tsPaths).toContain('src/App.tsx');
    expect(tsPaths).toContain('vite.config.ts');
    expect(tsPaths).toContain('tsconfig.json');
    const tsPkg = JSON.parse(tsFiles.find((file) => file.path === 'package.json')!.content) as {
      dependencies: Record<string, string>;
    };
    expect(tsPkg.dependencies.react).toBeDefined();
    expect(tsFiles.find((file) => file.path === 'index.html')!.content).toContain('/src/main.tsx');

    const jsFiles = renderTemplate('react', vars({ ext: 'js', language: 'js' }));
    const jsPaths = jsFiles.map((file) => file.path);
    expect(jsPaths).toContain('src/main.jsx');
    expect(jsPaths).toContain('src/App.jsx');
    expect(jsPaths).toContain('jsconfig.json');
    expect(jsPaths).not.toContain('tsconfig.json');
    expect(jsFiles.find((file) => file.path === 'index.html')!.content).toContain('/src/main.jsx');
    /*
     * `document.getElementById('root')!` 里的 `!` 是 TypeScript 专有语法，
     * 出现在 .jsx 里就是语法错误 —— 这条断言防的就是"两种语言共用一份入口"。
     * （注意 `!` 后面还有 `createRoot(` 自己的收尾括号，正则要连它一起写。
     *  第一版这里写错了，报出来像是模板的问题 —— 其实是测试写错了。）
     */
    const jsMain = jsFiles.find((file) => file.path === 'src/main.jsx')!.content;
    expect(jsMain).toMatch(/getElementById\('root'\)\)\.render/);
    expect(jsMain).not.toContain('!');
    expect(tsFiles.find((file) => file.path === 'src/main.tsx')!.content).toMatch(
      /getElementById\('root'\)!\)\.render/,
    );
  });

  it('不存在的模板要报错，而不是生成一个空目录', () => {
    expect(() => renderTemplate('svelte', VARS)).toThrow(/没有内置模板/);
  });
});

describe('路径安全', () => {
  it('拒绝绝对路径与 .. 逃逸', () => {
    const bad = ['/etc/passwd', 'C:\\Windows\\system32\\x.dll', '../outside.txt', 'a/../../b.txt', 'a//b'];
    for (const path of bad) {
      expect(() => assertSafeTemplatePath(path), path).toThrow(/不合法|不能是绝对路径/);
    }
  });

  it('正常的相对路径原样通过（反斜杠归一成 /）', () => {
    expect(assertSafeTemplatePath('app/main.py')).toBe('app/main.py');
    expect(assertSafeTemplatePath('src\\main.ts')).toBe('src/main.ts');
  });
});

describe('写盘', () => {
  it('写出文件、按需建目录，并返回清单', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tpl-write-'));
    try {
      const result = writeTemplateFiles(dir, renderTemplate('fastapi', VARS));
      expect(result.written).toContain('app/main.py');
      expect(result.skipped).toEqual([]);
      expect(existsSync(join(dir, 'app', 'main.py'))).toBe(true);
      expect(readFileSync(join(dir, 'requirements.txt'), 'utf8')).toContain('fastapi');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('**不覆盖已有文件**（目标目录里可能已经有用户自己的东西）', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tpl-skip-'));
    try {
      mkdirSync(join(dir, 'app'), { recursive: true });
      writeFileSync(join(dir, 'app', 'main.py'), '# 我自己写的，别动\n', 'utf8');

      const result = writeTemplateFiles(dir, renderTemplate('fastapi', VARS));

      expect(result.skipped).toContain('app/main.py');
      expect(readFileSync(join(dir, 'app', 'main.py'), 'utf8')).toBe('# 我自己写的，别动\n');
      // 其它文件照写
      expect(result.written).toContain('requirements.txt');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
