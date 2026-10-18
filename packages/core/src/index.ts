/**
 * @worktable/core 公共出口与组合根（架构 §1.4 A5）。
 *
 * CLI 与 MCP 一律从这里装配，保证两者行为一致（PRD P0-4 ③）：
 * 任何新的能力暴露都要在 {@link WorktableCore} 里挂一次，而不是让调用方各自 new。
 *
 * T02 提供到 Store 与迁移入口；services / web / cli / hosts 随 T03–T04 接入。
 * 跨包共享约定：`packages/mcp` 只准 import 本 barrel，禁深路径（verify:module-boundaries 守）。
 */
import type { Pool } from 'pg';
import { openConnection, ensureCluster, type OpenedConnection } from './db/index.js';
import { createStore, type Store } from './store/index.js';
import { runMigrations, migrationStatus } from './migrations/index.js';
import { WORKTABLE_VERSION } from './version.js';

export { WORKTABLE_VERSION };

/** 启动后的 core 句柄。 */
export interface WorktableCore {
  pool: Pool;
  store: Store;
  dataHome: string;
  mode: 'embedded' | 'external';
  version: string;
}

/**
 * 打开 core（解析配置 → 必要时拉起 embedded → 建池 → 建 Store）。
 *
 * @param env 环境变量表。
 * @returns {@link WorktableCore}。
 */
export async function createWorktable(env: NodeJS.ProcessEnv = process.env): Promise<WorktableCore> {
  const connection: OpenedConnection = await openConnection(env);
  return {
    pool: connection.pool,
    store: createStore(connection.pool),
    dataHome: connection.dataHome,
    mode: connection.mode,
    version: WORKTABLE_VERSION,
  };
}

/**
 * 应用全部待执行迁移（幂等）。
 *
 * @param store Store 实例。
 * @returns 本次应用 / 跳过的版本。
 */
export function migrate(store: Store): ReturnType<typeof runMigrations> {
  return runMigrations(store.tx, store.ledger);
}

/**
 * 查询迁移状态。
 *
 * @param store Store 实例。
 * @returns 已应用与待应用版本。
 */
export function migrateStatus(store: Store): ReturnType<typeof migrationStatus> {
  return migrationStatus(store.ledger);
}

export { ensureCluster, openConnection, createStore, runMigrations, migrationStatus };
export { createStore as makeStore } from './store/index.js';
export type { Store } from './store/index.js';
export * from './errors/index.js';
export * from './config/index.js';
export * from './ids.js';
export type * from './store/types.js';
