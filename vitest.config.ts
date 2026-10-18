import { defineConfig } from 'vitest/config';

/**
 * 测试配置（P0 门禁入口）。
 *
 * - alias 把 @worktable/core 指向源码而非 dist：保证「测的就是打包进去的那份源码」；
 * - 超时放宽到 60s：embedded Postgres 首次 init 要展开约 35MB 二进制、建 cluster 通常数秒，
 *   默认的 5s 会让 `verify:embedded` 在慢机器上假性失败；
 * - pool forks + singleFork=false：并发门禁需要真实多进程，且 web UI（T03）要在别的进程起服务。
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
    testTimeout: 60_000,
    hookTimeout: 120_000,
  },
});
