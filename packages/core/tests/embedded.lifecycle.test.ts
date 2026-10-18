/**
 * embedded Postgres 集群生命周期（PRD P0-2 / 风险 R-1、R-6）。
 *
 * 这里跑的是**真实二进制**（首次 init 需联网下载约 35MB），因此它就是
 * 「用户第一次 `worktable init` 会遇到什么」的最如实排练：
 * 二进制缺失、端口占用、非 root 限制，只有在这一层才暴露得出来。
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { clusterStatus, startCluster, stopCluster, DATABASE_NAME } from '../src/db/embedded.js';
import { startTestEnv, type TestEnv } from './support/test-env.js';

let env: TestEnv | undefined;

beforeAll(async () => {
  env = await startTestEnv();
}, 120_000);

afterAll(async () => {
  await env?.teardown();
});

describe('db.embedded lifecycle', () => {
  it('startTestEnv 已把集群拉起并跑完迁移', async () => {
    const status = await clusterStatus({ dataHome: env?.dataHome ?? '', port: env?.port ?? 0 });
    expect(status.initialised).toBe(true);
    expect(status.running).toBe(true);
    expect(existsSync(join(status.pgDataDir, 'PG_VERSION'))).toBe(true);
  });

  it('重复 start 幂等：已监听时不重新初始化，直接返回 running', async () => {
    const options = { dataHome: env?.dataHome ?? '', port: env?.port ?? 0 };
    const first = await startCluster(options);
    const second = await startCluster(options);
    expect(first.running).toBe(true);
    expect(second.running).toBe(true);
    expect(existsSync(join(first.pgDataDir, 'PG_VERSION'))).toBe(true);
  });

  it(`已存在 ${DATABASE_NAME} 库（连接串里的目标库真的创建成功）`, async () => {
    const pool = env?.pool;
    if (pool === undefined) throw new Error('测试环境未就绪');
    const { rows } = await pool.query('SELECT current_database() AS db');
    expect((rows[0] as { db: string }).db).toBe(DATABASE_NAME);
  });

  it('stop 后端口不再监听；再次 status 显示已停止', async () => {
    const options = { dataHome: env?.dataHome ?? '', port: env?.port ?? 0 };
    await stopCluster(options);
    const stopped = await clusterStatus(options);
    expect(stopped.running).toBe(false);
    expect(stopped.initialised).toBe(true);

    // 复原：测试环境 teardown 依赖集群可停，这里重新拉起保证后续用例可用
    const restarted = await startCluster(options);
    expect(restarted.running).toBe(true);
  });

  it('全新的 dataHome 首次 clusterStatus：未初始化且未运行', async () => {
    const fresh = await mkdtemp(join(tmpdir(), 'worktable-fresh-'));
    try {
      const status = await clusterStatus({ dataHome: fresh, port: 56_999 });
      expect(status.initialised).toBe(false);
      expect(status.running).toBe(false);
      expect(status.pgDataDir).toBe(join(fresh, 'pgdata'));
    } finally {
      await rm(fresh, { recursive: true, force: true }).catch(() => undefined);
    }
  });
});
