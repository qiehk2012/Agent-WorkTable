/**
 * meta 表读写（schema_version / data_home / instance_id，架构假设 A-6）。
 */
import type { Pool } from 'pg';
import { WorktableError, mapPgError } from '../errors/index.js';
import type { Queryable } from './types.js';

/** meta 键集合（增键请同步，避免拼写漂移）。 */
export type MetaKey = 'schema_version' | 'data_home' | 'instance_id';

/**
 * @param pool 连接池。
 * @param key meta 键。
 * @returns 值；不存在返回 null。
 */
export async function getMeta(pool: Pool, key: MetaKey): Promise<unknown | null> {
  try {
    const { rows } = await pool.query('SELECT value FROM meta WHERE key = $1', [key]);
    const row = rows[0] as { value: unknown } | undefined;
    return row === undefined ? null : row.value;
  } catch (error) {
    const mapped = mapPgError(error);
    throw mapped ?? error;
  }
}

/**
 * @param pool 连接池。
 * @param key meta 键。
 * @param value 值（JSONB 可序列化）。
 */
export async function setMeta(pool: Pool, key: MetaKey, value: unknown): Promise<void> {
  try {
    await pool.query(
      'INSERT INTO meta (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value',
      [key, JSON.stringify(value)],
    );
  } catch (error) {
    const mapped = mapPgError(error);
    throw mapped ?? error;
  }
}

/**
 * 断言 schema 可用：不存在 meta 表时抛明确错误。
 *
 * @param pool 连接池。
 * @returns schema 版本；未迁移时为 null。
 */
export async function readSchemaVersion(pool: Pool | Queryable): Promise<string | null> {
  const version = await getMeta(pool as Pool, 'schema_version');
  return typeof version === 'string' ? version : null;
}

/**
 * 兜底：把非 WorktableError 转成 db-unavailable，用于 store 出口统一。
 *
 * @param error 原始错误。
 * @returns WorktableError。
 */
export function asWorktableError(error: unknown): WorktableError {
  const mapped = mapPgError(error);
  if (mapped !== null) return mapped;
  return new WorktableError('db-unavailable', error instanceof Error ? error.message : String(error));
}
