import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { applyPortToConfig } from '../src/services/scaffold-port';

/**
 * 端口写进配置（M4）。
 *
 * 背景：向导里的端口对**官方脚手架**原来是无效果的 —— `create-vue` / `create-vite` 生成的
 * `vite.config.ts` 里没有 port，`nest new` 的 `main.ts` 里是 `process.env.PORT ?? 3000`。
 * 用户填了端口、界面收下了、项目却跑在默认值上，属于"说了却没做"。
 *
 * 这里用**官方脚手架真实生成的形状**做夹具（下面两段内容就是从 create-vue 的产物抄的），
 * 免得测试通过、真实项目上正则匹配不上。
 */

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()?.();
});

function makeDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'port-config-'));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** create-vue 真实生成的 vite.config.ts（有 plugins 与 resolve，**没有** server） */
const REAL_CREATE_VUE = `import { fileURLToPath, URL } from 'node:url'

import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import vueDevTools from 'vite-plugin-vue-devtools'

// https://vite.dev/config/
export default defineConfig({
  plugins: [
    vue(),
    vueDevTools(),
  ],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
})
`;

/** create-vite 的 react-ts 产物（更朴素） */
const REAL_CREATE_VITE_REACT = `import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
})
`;

/** nest new 的 main.ts */
const REAL_NEST_MAIN = `import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  await app.listen(process.env.PORT ?? 3000);
}
bootstrap();
`;

describe('Vite 配置', () => {
  it('没有 server 块时插一整块（官方脚手架的默认形状）', () => {
    const dir = makeDir();
    writeFileSync(join(dir, 'vite.config.ts'), REAL_CREATE_VUE, 'utf8');

    const result = applyPortToConfig({ dir, port: 8123 });

    const after = readFileSync(join(dir, 'vite.config.ts'), 'utf8');
    expect(after).toContain('server: { port: 8123 }');
    expect(result.changed.join()).toContain('插入');
    // 原有内容一个都不能丢
    expect(after).toContain('vueDevTools()');
    expect(after).toContain("alias: {");
  });

  it('react 的极简配置同样能插进去', () => {
    const dir = makeDir();
    writeFileSync(join(dir, 'vite.config.ts'), REAL_CREATE_VITE_REACT, 'utf8');
    applyPortToConfig({ dir, port: 5300 });
    expect(readFileSync(join(dir, 'vite.config.ts'), 'utf8')).toContain('server: { port: 5300 }');
  });

  it('已经有 server.port 时只换数字（不重复插块）', () => {
    const dir = makeDir();
    writeFileSync(
      join(dir, 'vite.config.ts'),
      `import { defineConfig } from 'vite'
export default defineConfig({
  plugins: [],
  server: {
    port: 5173,
    open: true,
  },
})
`,
      'utf8',
    );

    applyPortToConfig({ dir, port: 4400 });

    const after = readFileSync(join(dir, 'vite.config.ts'), 'utf8');
    expect(after).toContain('port: 4400');
    expect(after).not.toContain('5173');
    // server 块里的其它设置要留着
    expect(after).toContain('open: true');
    // 只出现一次 server
    expect(after.match(/server:/g)).toHaveLength(1);
  });

  it('有 server 块但没有 port 时，往块里补一行', () => {
    const dir = makeDir();
    writeFileSync(
      join(dir, 'vite.config.ts'),
      `export default defineConfig({
  server: { open: true },
})
`,
      'utf8',
    );
    applyPortToConfig({ dir, port: 4500 });
    const after = readFileSync(join(dir, 'vite.config.ts'), 'utf8');
    expect(after).toContain('port: 4500');
    expect(after).toContain('open: true');
  });

  it('认不出 defineConfig 时**什么都不改**并说明', () => {
    const dir = makeDir();
    const weird = 'export const config = { plugins: [] };\n';
    writeFileSync(join(dir, 'vite.config.ts'), weird, 'utf8');

    const result = applyPortToConfig({ dir, port: 5000 });

    expect(result.changed).toEqual([]);
    expect(result.skipped.join()).toContain('defineConfig');
    expect(readFileSync(join(dir, 'vite.config.ts'), 'utf8')).toBe(weird);
  });

  it('`.js` 形式的 vite.config 也认', () => {
    const dir = makeDir();
    writeFileSync(join(dir, 'vite.config.js'), `export default defineConfig({ plugins: [] })\n`, 'utf8');
    applyPortToConfig({ dir, port: 4600 });
    expect(readFileSync(join(dir, 'vite.config.js'), 'utf8')).toContain('server: { port: 4600 }');
  });
});

describe('NestJS 的 main.ts', () => {
  it('把 `process.env.PORT ?? 3000` 里的默认值换成用户选的', () => {
    const dir = makeDir();
    mkdirSync(join(dir, 'src'), { recursive: true });
    writeFileSync(join(dir, 'nest-cli.json'), '{}', 'utf8');
    writeFileSync(join(dir, 'src', 'main.ts'), REAL_NEST_MAIN, 'utf8');

    const result = applyPortToConfig({ dir, port: 3200 });

    const after = readFileSync(join(dir, 'src', 'main.ts'), 'utf8');
    expect(after).toContain('app.listen(process.env.PORT ?? 3200)');
    expect(after).not.toContain('3000');
    expect(result.changed.join()).toContain('app.listen');
  });

  it('`app.listen(3000)` 也认', () => {
    const dir = makeDir();
    mkdirSync(join(dir, 'src'), { recursive: true });
    writeFileSync(join(dir, 'src', 'main.ts'), 'await app.listen(3000);\n', 'utf8');
    applyPortToConfig({ dir, port: 3300 });
    expect(readFileSync(join(dir, 'src', 'main.ts'), 'utf8')).toBe('await app.listen(3300);\n');
  });

  it('找不到 app.listen 就如实说，不动文件', () => {
    const dir = makeDir();
    mkdirSync(join(dir, 'src'), { recursive: true });
    writeFileSync(join(dir, 'src', 'main.ts'), 'console.log("hi");\n', 'utf8');

    const result = applyPortToConfig({ dir, port: 3400 });

    expect(result.changed).toEqual([]);
    expect(result.skipped.join()).toContain('app.listen');
    expect(readFileSync(join(dir, 'src', 'main.ts'), 'utf8')).toBe('console.log("hi");\n');
  });
});

describe('其它情况', () => {
  it('Python 项目什么都不做（端口由启动命令传）', () => {
    const dir = makeDir();
    writeFileSync(join(dir, 'requirements.txt'), 'fastapi>=0.115\n', 'utf8');
    mkdirSync(join(dir, 'app'), { recursive: true });
    writeFileSync(join(dir, 'app', 'main.py'), 'from fastapi import FastAPI\n', 'utf8');

    const result = applyPortToConfig({ dir, port: 8000 });

    expect(result.changed).toEqual([]);
    expect(result.skipped.join()).toContain('Python');
  });

  it('端口不合法时不写（服务端仍然守着自己的底线）', () => {
    const dir = makeDir();
    writeFileSync(join(dir, 'vite.config.ts'), REAL_CREATE_VUE, 'utf8');
    const result = applyPortToConfig({ dir, port: 0 });
    expect(result.changed).toEqual([]);
    expect(result.skipped.join()).toContain('端口不合法');
    // 注意别用 `not.toContain('port')`：`import` 这个词里就有 "port"（第一版就这么写错的）
    expect(readFileSync(join(dir, 'vite.config.ts'), 'utf8')).not.toContain('server:');
  });
});
