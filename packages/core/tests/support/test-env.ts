/**
 * 集成测试底座：起一个独立的临时 dataHome + embedded 集群 + 已迁移的 Store。
 *
 * 为什么每个测试文件都要独立的 dataHome 与端口：
 * - embedded Postgres 是真实单机进程，端口与 pgdata 目录都不能共享，否则并发跑测试会互相踩；
 * - 这也是对「dataHome 三级解析链」的天然覆盖——测试全程只通过 env `WORKTABLE_HOME` 注入，
 *   不依赖宿主现有配置。
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openConnection, portFromUrl } from '../../src/db/index.js';
import { createStore } from '../../src/store/index.js';
import { runMigrations } from '../../src/migrations/index.js';
import { configPath, normalizeConfig, writeConfigFile } from '../../src/config/index.js';
import type { Store } from '../../src/store/index.js';
import type { Pool } from 'pg';

/** 测试环境句柄。 */
export interface TestEnv {
  dataHome: string;
  port: number;
  pool: Pool;
  store: Store;
  /** 清理：关闭连接池 + 停止集群 + 删除临时目录 */
  teardown: () => Promise<void>;
}

/**
 * 取一个不太可能与其它实例冲突的端口（同 PID 稳定，跨测试进程错开）。
 *
 * @returns 端口号。
 */
function testPort(): number {
  return 56_100 + (process.pid % 200);
}

/**
 * 建立测试用嵌入式环境并跑完迁移。
 *
 * @returns {@link TestEnv}。
 */
export async function startTestEnv(): Promise<TestEnv> {
  const dataHome = await mkdtemp(join(tmpdir(), 'worktable-test-'));
  const port = testPort();
  await writeConfigFile(
    configPath(dataHome),
    normalizeConfig(
      {
        database: { mode: 'embedded', url: `postgres://postgres:postgres@127.0.0.1:${port}/worktable` },
        web: { port: 55_433 },
        home: { path: dataHome, history: [] },
      },
      dataHome,
    ),
  );

  const connection = await openConnection({ WORKTABLE_HOME: dataHome });
  const store = createStore(connection.pool);
  await runMigrations(store.tx, store.ledger);

  return {
    dataHome,
    port: portFromUrl(connection.url) ?? port,
    pool: connection.pool,
    store,
    teardown: async () => {
      await connection.pool.end().catch(() => undefined);
      // 集群：交给 stopCluster；失败不影响临时目录清理
      const { stopCluster } = await import('../../src/db/embedded.js');
      await stopCluster({ dataHome, port }).catch(() => undefined);
      await rm(dataHome, { recursive: true, force: true }).catch(() => undefined);
    },
  };
}
