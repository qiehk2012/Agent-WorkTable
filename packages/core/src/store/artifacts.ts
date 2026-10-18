/**
 * 产物查询（架构 §2.2 `src/store/artifacts.ts`）：列表与单条读取。
 */
import type { Pool } from 'pg';
import { mapPgError } from '../errors/index.js';
import type { Artifact, ArtifactStatus } from './types.js';

/**
 * @param pool 连接池。
 * @param query projectId 与可选状态过滤。
 * @returns 产物列表（按创建时间倒序）。
 */
export async function listArtifacts(
  pool: Pool,
  query: { projectId: string; status?: ArtifactStatus },
): Promise<Artifact[]> {
  try {
    const { rows } = await pool.query(
      `SELECT artifact_id, project_id, pane_id, binding_id, title, type, payload_path, status, meta, created_at
         FROM artifacts
        WHERE project_id = $1 AND ($2::text IS NULL OR status = $2)
        ORDER BY created_at DESC`,
      [query.projectId, query.status ?? null],
    );
    return rows as Artifact[];
  } catch (error) {
    const mapped = mapPgError(error);
    throw mapped ?? error;
  }
}

/**
 * @param pool 连接池。
 * @param artifactId 产物 ID。
 * @returns 产物；不存在返回 null。
 */
export async function getArtifactById(pool: Pool, artifactId: string): Promise<Artifact | null> {
  try {
    const { rows } = await pool.query(
      `SELECT artifact_id, project_id, pane_id, binding_id, title, type, payload_path, status, meta, created_at
         FROM artifacts WHERE artifact_id = $1 LIMIT 1`,
      [artifactId],
    );
    return (rows[0] as Artifact | undefined) ?? null;
  } catch (error) {
    const mapped = mapPgError(error);
    throw mapped ?? error;
  }
}
