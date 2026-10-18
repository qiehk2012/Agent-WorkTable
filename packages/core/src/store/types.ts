/**
 * 数据层类型（L0）：六表 Row、对外 DTO、以及数据访问端口。
 *
 * L0 约束：本文件不依赖任何内部模块；反向由 store / migrations 依赖它，保证方向向下（架构 §7.2）。
 *
 * 把 {@link Queryable} / {@link Transactor} / {@link LedgerPort} 放在这里是刻意的：
 * 迁移执行器（L1）与 store 实现（L2）都要用，而依赖方向只允许「上层依赖下层」，
 * 因此端口类型必须落在 L0，双方才能共享而不产生反向依赖。
 */

/** 绑定三态。 */
export type BindingStatus = 'working' | 'needs-you' | 'done';
/** 产物类型。 */
export type ArtifactType = 'html' | 'markdown' | 'image' | 'file';
/** 产物状态。 */
export type ArtifactStatus = 'pending' | 'mounted' | 'locked';
/** 宿主标识。 */
export type HostId = 'dsh' | 'hermes' | 'workbuddy' | 'claude-code' | 'codex';

/** meta 行。 */
export interface MetaRow {
  key: string;
  value: unknown;
}
/** projects 行。 */
export interface ProjectRow {
  project_id: string;
  name: string;
  icon: string | null;
  folder: string;
  position: number;
  hidden: boolean;
  created_at: Date;
  created_by: string;
}
/** bindings 行。 */
export interface BindingRow {
  binding_id: string;
  project_id: string;
  host: HostId;
  session_id: string;
  cwd: string;
  status: BindingStatus;
  note: string | null;
  revision: number;
  updated_at: Date;
}
/** panes 行。 */
export interface PaneRow {
  pane_id: string;
  binding_id: string;
  layout: unknown;
  updated_at: Date;
}
/** artifacts 行。 */
export interface ArtifactRow {
  artifact_id: string;
  project_id: string;
  pane_id: string;
  binding_id: string;
  title: string;
  type: ArtifactType;
  payload_path: string;
  status: ArtifactStatus;
  meta: Record<string, unknown>;
  created_at: Date;
}
/** events 行（P0 仅预留建表，零业务写入）。 */
export interface EventRow {
  event_id: string;
  ts: Date;
  actor: string;
  project_id: string | null;
  kind: string;
  payload: Record<string, unknown>;
}

/** 对外 DTO。 */
export interface Project extends ProjectRow {}
export interface Binding extends BindingRow {}
export interface Artifact extends ArtifactRow {}

/** 项目引用：按 ID 或按名字二选一。 */
export type ProjectRef = { projectId: string } | { name: string };

/** list_projects 每项。 */
export interface ProjectSummary {
  projectId: string;
  name: string;
  icon: string | null;
  position: number;
  hidden: boolean;
  status: BindingStatus | null;
  host: HostId | null;
  cwd: string | null;
  pendingArtifacts: number;
  lastActivityAt: Date | null;
}

/** 控制室卡片（PRD §4.1 字段表；products 确认偏差 D-4 后含 preview）。 */
export interface ControlRoomCard {
  projectId: string;
  name: string;
  icon: string | null;
  status: BindingStatus | null;
  host: HostId | null;
  cwd: string | null;
  lastEvent: string | null;
  pendingArtifacts: number;
  preview: string | null;
  updatedAt: Date | null;
}

/** 控制室快照。 */
export interface ControlRoomSnapshot {
  uiUrl: string;
  generatedAt: string;
  projects: ControlRoomCard[];
}

/** open_project 返回体。 */
export interface ProjectContext {
  project: Project;
  bindings: Binding[];
  artifacts: Artifact[];
  /** P0 恒为空数组（P1-8 启用；主理人裁决 3） */
  recentEvents: EventRow[];
}

/** check 报告。 */
export interface CheckReport {
  schemaVersion: string | null;
  dbReachable: boolean;
  orphanBindings: Array<{ bindingId: string; projectId: string; reason: string }>;
  projectDirsWritable: Array<{ projectId: string; folder: string; writable: boolean }>;
  issues: Array<{ code: string; message: string }>;
}

/** 查询接口（鸭子类型：pg 的 Pool / PoolClient 都满足）。 */
export interface Queryable {
  query(sql: string, params?: readonly unknown[]): Promise<{ rows: unknown[] }>;
}

/** 事务包装：单条迁移或跨表写入在一个事务里完成。 */
export interface Transactor {
  withTransaction<T>(fn: (tx: Queryable) => Promise<T>): Promise<T>;
}

/** 已应用迁移记录。 */
export interface AppliedMigration {
  version: string;
  checksum: string;
}

/** 迁移账本端口（实现在 store，消费在 migrations）。 */
export interface LedgerPort {
  applied(): Promise<AppliedMigration[]>;
  mark(version: string, checksum: string): Promise<void>;
}
