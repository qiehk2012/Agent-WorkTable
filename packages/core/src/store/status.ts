/**
 * 聚合查询：控制室快照与项目上下文（PRD P0-9 / P0-10）。
 *
 * 两条刻意的设计：
 * - **单条查询出控制室**：避免 N+1；PRD 要求的「零模型调用纯本地聚合」即靠这一条 SQL；
 * - **不含 uiUrl**：uiUrl 依赖 web 端口配置，而 store 不能运行时依赖 config（架构 §7.2 store-l1 规则），
 *   因此这里只出数据，由 services 层 ControlRoomService 补 uiUrl。
 */
import type { Pool } from 'pg';
import { mapPgError } from '../errors/index.js';
import type {
  Binding,
  BindingStatus,
  ControlRoomCard,
  HostId,
  Project,
  ProjectContext,
  ProjectRef,
  Artifact,
} from './types.js';

/** 控制室数据（缺 uiUrl，由 services 补）。 */
export interface ControlRoomData {
  generatedAt: string;
  projects: ControlRoomCard[];
}

/**
 * @param value payload 相对路径。
 * @returns 入口文件名（basename）。
 */
function baseName(value: unknown): string {
  const text = String(value ?? '');
  const segments = text.split('/');
  return segments[segments.length - 1] ?? '';
}

/**
 * @param pool 连接池。
 * @returns 控制室数据。
 */
export async function getControlRoom(pool: Pool): Promise<ControlRoomData> {
  try {
    const { rows } = await pool.query(
      `SELECT p.project_id, p.name, p.icon, p.hidden,
              b.status, b.host, b.cwd, b.updated_at,
              (SELECT COUNT(*) FROM artifacts a
                WHERE a.project_id = p.project_id AND a.status <> 'mounted') AS pending_artifacts,
              latest.artifact_id  AS last_artifact_id,
              latest.title        AS last_artifact_title,
              latest.payload_path AS last_payload_path
         FROM projects p
         LEFT JOIN bindings b ON b.project_id = p.project_id AND b.status <> 'done'
         LEFT JOIN LATERAL (
              SELECT artifact_id, title, payload_path
                FROM artifacts WHERE project_id = p.project_id
               ORDER BY created_at DESC LIMIT 1
         ) latest ON TRUE
        ORDER BY p.position ASC, p.name ASC`,
    );
    const projects = (rows as Array<Record<string, unknown>>).map((row) => {
      const lastId = row['last_artifact_id'] as string | null | undefined;
      return {
        projectId: String(row['project_id']),
        name: String(row['name']),
        icon: (row['icon'] as string | null) ?? null,
        status: (row['status'] as BindingStatus | null) ?? null,
        host: (row['host'] as HostId | null) ?? null,
        cwd: (row['cwd'] as string | null) ?? null,
        lastEvent: lastId === undefined || lastId === null ? null : `mounted ${lastId}`,
        pendingArtifacts: Number(row['pending_artifacts'] ?? 0),
        // preview 为 `/a/<artifactId>/<入口文件名>` 后缀，完整 URL 由 services 拼上 uiUrl（偏差 D-4 口径）
        preview:
          lastId === undefined || lastId === null
            ? null
            : `/a/${String(lastId)}/${encodeURIComponent(baseName(row['last_payload_path']))}`,
        updatedAt: row['updated_at'] === undefined || row['updated_at'] === null
          ? null
          : (row['updated_at'] as Date),
      } satisfies ControlRoomCard;
    });
    return { generatedAt: new Date().toISOString(), projects };
  } catch (error) {
    const mapped = mapPgError(error);
    throw mapped ?? error;
  }
}

/**
 * @param pool 连接池。
 * @param ref 项目引用。
 * @returns 项目上下文；不存在返回 null。
 */
export async function getProjectContext(pool: Pool, ref: ProjectRef): Promise<ProjectContext | null> {
  const key = 'projectId' in ref ? ref.projectId : ref.name;
  try {
    const project = await pool.query(
      `SELECT project_id, name, icon, folder, position, hidden, created_at, created_by
         FROM projects WHERE project_id = $1 OR name = $1 LIMIT 1`,
      [key],
    );
    const row = project.rows[0] as Project | undefined;
    if (row === undefined) return null;

    const bindings = await pool.query(
      `SELECT binding_id, project_id, host, session_id, cwd, status, note, revision, updated_at
         FROM bindings WHERE project_id = $1 ORDER BY updated_at DESC`,
      [row.project_id],
    );
    const artifacts = await pool.query(
      `SELECT artifact_id, project_id, pane_id, binding_id, title, type, payload_path, status, meta, created_at
         FROM artifacts WHERE project_id = $1 ORDER BY created_at DESC`,
      [row.project_id],
    );

    return {
      project: row,
      bindings: bindings.rows as Binding[],
      artifacts: artifacts.rows as Artifact[],
      // events 业务写入留 P1-8（主理人裁决 3）：此处恒空，避免上层误以为已有留痕
      recentEvents: [],
    };
  } catch (error) {
    const mapped = mapPgError(error);
    throw mapped ?? error;
  }
}
