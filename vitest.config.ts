import { defineConfig } from 'vitest/config';

/**
 * 测试配置（P0 门禁入口）。
 * - @worktable/core 一律别名到源码，不经过 dist：保证「测试的就是实际打包进去的那份源码」
 * - pool forks / singleFork=false：并发门禁要真实多进程（定稿 §12 verify:concurrency）
 */
export default defineConfig({
  resolve: {
    alias: {
      '@worktable/core': new URL('./packages/core/src/index.ts', import.meta.url).pathname,
    },
  },
  test: {
    environment: 'node',
    globals: false,
    include: [
      'packages/*/tests/**/*.test.ts',
      'packages/*/src/**/*.test.ts',
      'tests/**/*.test.ts',
    ],
    pool: 'forks',
    poolOptions: { forks: { singleFork: false } },
    testTimeout: 20_000,
    hookTimeout: 60_000,
  },
});
