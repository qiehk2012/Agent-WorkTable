/**
 * 产物挂载（PRD P0-9 / 架构 §3.6）：单事务 UPSERT panes + INSERT artifacts。
 *
 * 为什么必须在一个事务里：panes 的复合主键 (pane_id, binding_id) 是为了「晚到写入不覆盖新绑定」（dsh 教训），
 * 若 pane 写入与 artifact 写入分离，中途失败会留下有 pane 无 artifact 的半成品挂载。
 */
import type { Pool } from 'pg';
import { WorktableError, mapPgError } from '../errors/index.js';
import type { Artifact, ArtifactType, Transactor } from './types.js';

/** 挂载入参（entry 已由 PayloadResolver 收容校验过；payloadPath 为项目内相对路径）。 */
export interface MountArtifactInput {
  artifactId: string;
  projectId: string;
  paneId: string;
  bindingId: string;
  title: string;
  type: ArtifactType;
  payloadPath: string;
  meta?: Record<string, unknown>;
}

/** 挂载结果。 */
export interface MountArtifactResult {
  artifactId: string;
  mountUri: string;
}

/**
 * 挂载产物（单事务）。
 *
 * @param tx Transactor。
 * @param input 挂载参数。
 * @returns 挂载结果与 mountUri。
 */
export async function mountArtifact(
  tx: Transactor,
  input: MountArtifactInput,
): Promise<MountArtifactResult> {
  return tx.withTransaction(async (client) => {
    try {
      await client.query(
        `INSERT INTO panes (pane_id, binding_id, layout)
         VALUES ($1, $2, NULL)
         ON CONFLICT (pane_id, binding_id) DO UPDATE SET layout = COALESCE(panes.layout, EXCLUDED.layout), updated_at = now()`,
        [input.paneId, input.bindingId],
      );
      const { rows } = await client.query(
        `INSERT INTO artifacts (artifact_id, project_id, pane_id, binding_id, title, type, payload_path, status, meta)
         VALUES ($1, $2, $3, $4, $5, $6, $7, 'mounted', COALESCE($8::jsonb, '{}'::jsonb))
         RETURNING artifact_id`,
        [
          input.artifactId,
          input.projectId,
          input.paneId,
          input.bindingId,
          input.title,
          input.type,
          input.payloadPath,
          input.meta === undefined ? null : JSON.stringify(input.meta),
        ],
      );
      const row = rows[0] as { artifact_id: string } | undefined;
      if (row === undefined) {
        throw new WorktableError('db-conflict', '挂载未生效：未返回 artifact_id', undefined, true, {
          projectId: input.projectId,
        });
      }
      return {
        artifactId: row.artifact_id,
        mountUri: `worktable://${input.paneId}-${input.bindingId}/${row.artifact_id}`,
      };
    } catch (error) {
      const mapped = mapPgError(error);
      throw mapped ?? error;
    }
  });
}

/**
 * @param pool 连接池。
 * @param query projectId 与可选状态过滤。
 * @returns 产物列表。
 */
export async function listArtifacts(
  pool: Pool,
  query: { projectId: string; status?: 'pending' | 'mounted' | 'locked' },
): Promise<Artifact[]> {
  const { rows } = await pool.query(
    `SELECT artifact_id, project_id, pane_id, binding_id, title, type, payload_path, status, meta, created_at
       FROM artifacts
      WHERE project_id = $1 AND ($2::text IS NULL OR status = $2)
      ORDER BY created_at DESC`,
    [query.projectId, query.status ?? null],
  );
  return rows as Artifact[];
}
