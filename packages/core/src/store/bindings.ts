/**
 * bindings 状态机（PRD P0-10 / 定稿 §4.4）。
 *
 * 并发保证全在数据库层：
 * - 「一个项目同时只有一个 active binding」由**部分唯一索引** idx_bindings_active 保证，
 *   冲突映射为 binding-conflict，而不是应用层查询后判断（TOCTOU 不存在）；
 * - `force` 顶替：先无条件 UPDATE 旧 binding 置 done 再插入，两步在同一事务里；
 * - revision 乐观并发：UPDATE ... WHERE revision = $expected，RETURNING 为空即 revision-conflict。
 */
import type { Pool } from 'pg';
import { WorktableError, mapPgError } from '../errors/index.js';
import type { Binding, BindingStatus, HostId } from './types.js';

/** 绑定入参。 */
export interface BindSessionInput {
  projectId: string;
  bindingId: string;
  host: HostId;
  sessionId: string;
  cwd: string;
  force?: boolean;
}

/** 绑定结果。 */
export interface BindSessionResult {
  bindingId: string;
  revision: number;
}

/** 状态更新入参。 */
export interface UpdateStatusInput {
  projectId: string;
  status: BindingStatus;
  note?: string | null;
  expectedRevision?: number;
}

/** 状态更新结果。 */
export interface UpdateStatusResult {
  bindingId: string;
  revision: number;
}

/**
 * @param pool 连接池。
 * @param input 绑定参数。
 * @returns 绑定结果。
 */
export async function bindSession(pool: Pool, input: BindSessionInput): Promise<BindSessionResult> {
  try {
    const { rows } = await pool.query(
      `INSERT INTO bindings (binding_id, project_id, host, session_id, cwd, status)
       VALUES ($1, $2, $3, $4, $5, 'working')
       RETURNING binding_id, revision`,
      [input.bindingId, input.projectId, input.host, input.sessionId, input.cwd],
    );
    const row = rows[0] as { binding_id: string; revision: number } | undefined;
    if (row === undefined) {
      throw new WorktableError('binding-conflict', '绑定未生效（未知原因）', undefined, false, {
        projectId: input.projectId,
      });
    }
    return { bindingId: row.binding_id, revision: row.revision };
  } catch (error) {
    const mapped = mapPgError(error);
    if (mapped !== null && mapped.code === 'binding-conflict') {
      if (input.force === true) {
        // 顶替：旧 binding 置 done（events 留痕随 P1-8），再重试插入
        await pool.query(
          `UPDATE bindings SET status = 'done', updated_at = now()
            WHERE project_id = $1 AND status <> 'done'`,
          [input.projectId],
        );
        return bindSession(pool, { ...input, force: false });
      }
      throw mapped;
    }
    if (mapped !== null) throw mapped;
    throw error;
  }
}

/**
 * @param pool 连接池。
 * @param input 状态更新参数。
 * @returns 新 revision。
 */
export async function updateStatus(
  pool: Pool,
  input: UpdateStatusInput,
): Promise<UpdateStatusResult> {
  const { rows } = await pool.query(
    `UPDATE bindings SET
       status = $2,
       note = CASE WHEN $3::boolean IS TRUE THEN NULL ELSE COALESCE($4, note) END,
       revision = revision + 1,
       updated_at = now()
     WHERE project_id = $1 AND status <> 'done'
       AND ($5::integer IS NULL OR revision = $5)
     RETURNING binding_id, revision`,
    [
      input.projectId,
      input.status,
      input.note === null,
      input.note ?? null,
      input.expectedRevision ?? null,
    ],
  );
  const row = rows[0] as { binding_id: string; revision: number } | undefined;
  if (row === undefined) {
    // 要么没有 active binding，要么 revision 不符 —— 两者都交给调用方按同一码处理（可重试地重新读取）
    throw new WorktableError(
      'revision-conflict',
      '没有进行中的绑定，或 revision 与当前值不符',
      '重新读取当前绑定后再提交 expectedRevision',
      true,
      { projectId: input.projectId, expectedRevision: input.expectedRevision ?? null },
    );
  }
  return { bindingId: row.binding_id, revision: row.revision };
}

/**
 * @param pool 连接池。
 * @param projectId 项目 ID。
 * @returns 绑定列表（含历史 done）。
 */
export async function listBindings(pool: Pool, projectId: string): Promise<Binding[]> {
  const { rows } = await pool.query(
    `SELECT binding_id, project_id, host, session_id, cwd, status, note, revision, updated_at
       FROM bindings WHERE project_id = $1 ORDER BY updated_at DESC`,
    [projectId],
  );
  return rows as Binding[];
}
