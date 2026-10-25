import { resolve } from 'node:path';

import vue from '@vitejs/plugin-vue';
import { defineConfig, externalizeDepsPlugin } from 'electron-vite';

/**
 * 本包**刻意不设 `"type": "module"`**，因此 electron-vite 默认把
 * main / preload 产物构建为 **CJS**。这一点很重要：
 * 沙箱化的 preload（`sandbox: true`）**只接受 CJS**，输出 ESM 会直接加载失败。
 * 而 `sandbox: true` 是技术设计 §7 里的安全基线，不能为了省事关掉。
 *
 * （渲染进程不受影响：它由 Vite 打包成浏览器 ESM。）
 */
const entry = (relative: string): string => resolve(__dirname, relative);

/**
 * electron-vite 三段构建：main / preload / renderer。
 *
 * ## 关于 externalizeDepsPlugin 的取舍（踩过坑，写在这里免得后人重踩）
 *
 * 它会把 package.json 里 `dependencies` 的包标记为 external（不打进产物），
 * 只保留 `require()`。这对原生模块（better-sqlite3）是**必须**的：
 * `.node` 文件不可能被打包进 JS。
 *
 * 但 workspace 内的包（`@pm-studio/server` / `@pm-studio/shared`）**不能** external：
 * 它们是 TypeScript 源码，运行时不存在可直接 require 的 JS。
 * 所以用 `exclude` 把它们排除在 external 之外 → 交给 rollup 打包进主进程产物。
 *
 * 代价：`@pm-studio/server` 运行时用到的第三方包（fastify / drizzle-orm /
 * better-sqlite3 / zod …）必须在**本包**声明依赖，否则主进程产物在运行期
 * 解析不到它们（pnpm 的严格 node_modules 布局不会替我们向上找）。
 */
export default defineConfig({
  main: {
    plugins: [
      externalizeDepsPlugin({
        exclude: ['@pm-studio/server', '@pm-studio/shared'],
      }),
    ],
    build: {
      outDir: 'out/main',
      rollupOptions: {
        input: { index: entry('./src/main/index.ts') },
      },
    },
  },

  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      outDir: 'out/preload',
      rollupOptions: {
        input: { index: entry('./src/preload/index.ts') },
        // 显式锁死 CJS：沙箱化 preload 不支持 ESM
        output: { format: 'cjs', entryFileNames: '[name].cjs' },
      },
    },
  },

  renderer: {
    root: entry('./src/renderer'),
    plugins: [vue()],
    resolve: {
      alias: {
        '@renderer': entry('./src/renderer/src'),
        '@pm-studio/shared': entry('../shared/src/index.ts'),
      },
    },
    build: {
      outDir: 'out/renderer',
      rollupOptions: {
        input: { index: entry('./src/renderer/index.html') },
      },
    },
  },
});
