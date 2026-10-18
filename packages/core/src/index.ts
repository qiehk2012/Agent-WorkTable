/**
 * @worktable/core 公共出口与组合根（架构 §1.4 A5）。
 *
 * CLI 与 MCP 一律从这里装配，保证两者行为一致（PRD P0-4 ③）。
 * T03 起 core 句柄含 services（artifacts / controlRoom / doctor）与 web 拉起；
 * hosts 与 CLI 命令随 T04 接入。
 * 跨包共享约定：`packages/mcp` 只准 import 本 barrel，禁深路径（verify:module-boundaries 守）。
 */
import type { Pool } from 'pg';
import { openConnection, ensureCluster, type OpenedConnection } from './db/index.js';
import { createStore, type Store } from './store/index.js';
import { runMigrations, migrationStatus } from './migrations/index.js';
import { WORKTABLE_VERSION } from './version.js';
import { resolveWebPort } from './config/index.js';
import { createProjectDirResolver } from './protocol/payload.js';
import {
  createArtifactService,
  createControlRoomService,
  createDoctorService,
  type ArtifactService,
  type ControlRoomService,
  type DoctorService,
} from './services/index.js';
import type { WebHandle } from './web/index.js';

export { WORKTABLE_VERSION };

/** 启动后的 core 句柄。 */
export interface WorktableCore {
  pool: Pool;
  store: Store;
  dataHome: string;
  mode: 'embedded' | 'external';
  version: string;
  webPort: number;
  artifacts: ArtifactService;
  controlRoom: ControlRoomService;
  doctor: DoctorService;
  /** L1.5 按需拉起（stdio 会话内不常驻；CLI `worktable ui` 显式启动）。 */
  startWeb(): Promise<WebHandle>;
}

/**
 * 打开 core（解析配置 → 必要时拉起 embedded → 建池 → 建 Store → 装配 services）。
 *
 * @param env 环境变量表。
 * @returns {@link WorktableCore}。
 */
export async function createWorktable(env: NodeJS.ProcessEnv = process.env): Promise<WorktableCore> {
  const connection: OpenedConnection = await openConnection(env);
  const store = createStore(connection.pool);
  const webPort = await resolveWebPort(connection.dataHome, env);
  const resolver = createProjectDirResolver();

  const artifacts = createArtifactService({ store, resolver });
  const controlRoom = createControlRoomService({ store, webPort });
  const doctor = createDoctorService({
    store,
    resolver,
    version: WORKTABLE_VERSION,
    // doctor 的 schema 版本以迁移账本为准；由组合根注入（store 不反向依赖 migrations）
    migrationStatus: () => migrationStatus(store.ledger),
  });

  return {
    pool: connection.pool,
    store,
    dataHome: connection.dataHome,
    mode: connection.mode,
    version: WORKTABLE_VERSION,
    webPort,
    artifacts,
    controlRoom,
    doctor,
    startWeb: async () => {
      const { startWebServer } = await import('./web/server.js');
      return startWebServer({ controlRoom, doctor, artifacts, version: WORKTABLE_VERSION }, webPort);
    },
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
export type { Store } from './store/index.js';
export type { WebHandle } from './web/server.js';
export * from './errors/index.js';
export * from './config/index.js';
export * from './ids.js';
export * from './protocol/payload.js';
export type * from './store/types.js';
export type { ControlRoomData } from './store/status.js';
