import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/out/**',
      '**/node_modules/**',
      '**/.tmp/**',
      '**/coverage/**',
      'docs/**',
    ],
  },

  js.configs.recommended,
  tseslint.configs.recommended,

  {
    rules: {
      // 这条不是风格偏好，而是**强制设计约束**（technical-design §5.10）：
      // 日志必须走 packages/server/src/logging 的统一入口，否则脱敏管道
      // 会被绕过 —— 一个 console.log(token) 就能把凭证写进日志文件。
      'no-console': 'error',

      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/consistent-type-imports': [
        'error',
        { prefer: 'type-imports', fixStyle: 'inline-type-imports' },
      ],
      eqeqeq: ['error', 'always', { null: 'ignore' }],
      'no-var': 'error',
      'prefer-const': 'error',
      'object-shorthand': ['error', 'properties'],
    },
  },

  {
    // 全仓唯一允许出现 console 的地方：控制台 sink 本身
    files: ['packages/server/src/logging/logger.ts'],
    rules: { 'no-console': 'off' },
  },

  {
    // 测试里允许使用 console 便于临时调试，也允许非空断言
    files: ['packages/*/tests/**/*.ts'],
    rules: {
      'no-console': 'off',
      '@typescript-eslint/no-non-null-assertion': 'off',
      '@typescript-eslint/no-explicit-any': 'off',
    },
  },

  {
    // CommonJS 脚本（如 Electron 的 smoke / 截图工具）：必须显式声明为 commonjs
    // 语言模式并补上 node 全局，否则会被当成 ESM 检查，
    // 报出满屏 "require is not defined" 这类与代码无关的错误。
    files: ['**/*.cjs'],
    languageOptions: {
      sourceType: 'commonjs',
      globals: {
        require: 'readonly',
        module: 'writable',
        exports: 'writable',
        __dirname: 'readonly',
        __filename: 'readonly',
        process: 'readonly',
        console: 'readonly',
        Buffer: 'readonly',
        // 现代 Node 全局：脚本里会用到定时器与 Web 标准 API
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
        setInterval: 'readonly',
        clearInterval: 'readonly',
        fetch: 'readonly',
        AbortSignal: 'readonly',
        WebSocket: 'readonly',
        URL: 'readonly',
      },
    },
    rules: {
      '@typescript-eslint/no-require-imports': 'off',
    },
  },

  {
    // 命令行脚本：把结果打到终端就是它的用途
    files: ['**/scripts/**/*.cjs', '**/scripts/**/*.ts'],
    rules: { 'no-console': 'off' },
  },
);
