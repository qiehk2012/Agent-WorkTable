/**
 * Store 组装与组合根（架构 §3.2 / §7.3）。
 *
 * 这里是 SQL 唯一的运行时出口（除迁移 .sql 与其构建内联形态）：
 * - 所有方法只是「把输入传给对应 store 模块 + 统一错误语义」，业务逻辑一律不得下沉到这里；
 * - 死锁 40P01 / 序列化失败 40001 **自动重试一次**，仍败才抛 db-conflict（定稿 §4.4）；
 * - 转换时不吞根因：未知错误原样上抛，错误展示格式由 CLI / MCP 两处投影点负责。
 */
import type { Pool } from 'pg';
import { WorktableError, isWorktableError } from '../errors/index.js';
import { createLedger, createTransactor } from './schema.js';
import * as metaStore from './meta.js';
import * as projects from './projects.js';
import * as bindings from './bindings.js';
import * as mounts from './mount.js';
import * as artifactQueries from './artifacts.js';
import * as status from './status.js';
import type {
  Artifact,
  ArtifactStatus,
  Binding,
  LedgerPort,
  Project,
  ProjectContext,
  ProjectRef,
  ProjectSummary,
  Transactor,
} from './types.js';

export type {
  Artifact,
  ArtifactStatus,
  Binding,
  BindingStatus,
  ControlRoomCard,
  ControlRoomSnapshot,
  HostId,
  Project,
  ProjectContext,
  ProjectRef,
  ProjectSummary,
  Queryable,
  Transactor,
  LedgerPort,
  AppliedMigration,
  BindingRow,
  ProjectRow,
  ArtifactRow,
  PaneRow,
  EventRow,
  MetaRow,
} from './types.js';
export type { CreateProjectInput, UpdateProjectInput, ListProjectsOptions } from './projects.js';
export type { BindSessionInput, BindSessionResult, UpdateStatusInput, UpdateStatusResult } from './bindings.js';
export type { MountArtifactInput, MountArtifactResult } from './mount.js';
export type { MetaKey } from './meta.js';
export type { ControlRoomData } from './status.js';

/** Store 契约（无论后端是 Postgres 还是未来其它实现，接口不变）。 */
export interface Store {
  readonly tx: Transactor;
  readonly ledger: LedgerPort;

  getMeta(key: metaStore.MetaKey): Promise<unknown | null>;
  setMeta(key: metaStore.MetaKey, value: unknown): Promise<void>;
  readSchemaVersion(): Promise<string | null>;

  createProject(input: projects.CreateProjectInput): Promise<Project>;
  getProject(ref: ProjectRef): Promise<Project | null>;
  listProjects(options?: projects.ListProjectsOptions): Promise<ProjectSummary[]>;
  updateProject(input: projects.UpdateProjectInput): Promise<Project | null>;

  bindSession(input: bindings.BindSessionInput): Promise<bindings.BindSessionResult>;
  updateStatus(input: bindings.UpdateStatusInput): Promise<bindings.UpdateStatusResult>;
  listBindings(projectId: string): Promise<Binding[]>;

  mountArtifact(input: mounts.MountArtifactInput): Promise<mounts.MountArtifactResult>;
  listArtifacts(query: { projectId: string; status?: ArtifactStatus }): Promise<Artifact[]>;
  getArtifactById(artifactId: string): Promise<Artifact | null>;

  getControlRoom(): Promise<status.ControlRoomData>;
  getProjectContext(ref: ProjectRef): Promise<ProjectContext | null>;
}

/**
 * 需要自动重试一次的驱动错误码（死锁 / 序列化失败）。
 *
 * @param error 错误。
 * @returns 是否可重试。
 */
function isTransientConflict(error: unknown): boolean {
  if (!isWorktableError(error)) return false;
  const driverCode = error.details?.['driverCode'];
  return driverCode === '40P01' || driverCode === '40001';
}

/**
 * 冲突自动重试一次（与连接/环境相关的错误不在此重试，避免掩盖真故障）。
 *
 * @param operation 受保护操作名（用于错误信息）。
 * @param fn 实际操作。
 * @returns 操作结果。
 */
async function withOneRetry<T>(operation: string, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    if (!isTransientConflict(error)) throw error;
    try {
      return await fn();
    } catch (retryError) {
      throw new WorktableError(
        'db-conflict',
        `${operation} 并发冲突，已自动重试一次仍失败`,
        '稍后重试；用 `worktable check` 查看锁等待情况',
        true,
        { operation },
      );
    }
  }
}

/**
 * 创建 Store（唯一实现）。
 *
 * @param pool pg 连接池。
 * @returns Store 实例。
 */
export function createStore(pool: Pool): Store {
  return {
    tx: createTransactor(pool),
    ledger: createLedger(pool),

    getMeta: (key) => metaStore.getMeta(pool, key),
    setMeta: (key, value) => metaStore.setMeta(pool, key, value),
    readSchemaVersion: () => metaStore.readSchemaVersion(pool),

    createProject: (input) => withOneRetry('createProject', () => projects.createProject(pool, input)),
    getProject: (ref) => projects.getProject(pool, ref),
    listProjects: (options) => projects.listProjects(pool, options),
    updateProject: (input) => withOneRetry('updateProject', () => projects.updateProject(pool, input)),

    bindSession: (input) => withOneRetry('bindSession', () => bindings.bindSession(pool, input)),
    updateStatus: (input) => withOneRetry('updateStatus', () => bindings.updateStatus(pool, input)),
    listBindings: (projectId) => bindings.listBindings(pool, projectId),

    mountArtifact: (input) => withOneRetry('mountArtifact', () => mounts.mountArtifact(createTransactor(pool), input)),
    listArtifacts: (query) => artifactQueries.listArtifacts(pool, query),
    getArtifactById: (artifactId) => artifactQueries.getArtifactById(pool, artifactId),

    getControlRoom: () => status.getControlRoom(pool),
    getProjectContext: (ref) => status.getProjectContext(pool, ref),
  };
}
