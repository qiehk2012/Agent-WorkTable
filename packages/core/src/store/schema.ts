/**
 * schema_migrations 账本 + 事务包装（SQL 收容在本目录，架构 §7.3）。
 *
 * 两处关键的「首次 bootstrap」语义：
 * - 账本表由迁移 000 创建，因此首次调用 applied() 时表可能尚不存在 →
 *   捕获未定义表错误并返回空数组，让 bootstrap 迁移先跑，而不是误报 schema-mismatch；
 * - 事务包装把 BEGIN/COMMIT/ROLLBACK 收在 store 内部，迁移 SQL 文件因此不必含事务语句，
 *   单条迁移天然具备原子性。
 */
import type { Pool } from 'pg';
import { WorktableError, mapPgError } from '../errors/index.js';
import type { AppliedMigration, LedgerPort, Queryable, Transactor } from './types.js';

/**
 * 创建事务包装器。
 *
 * @param pool 连接池。
 * @returns Transactor 实现。
 */
export function createTransactor(pool: Pool): Transactor {
  return {
    async withTransaction<T>(fn: (tx: Queryable) => Promise<T>): Promise<T> {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const result = await fn(client as unknown as Queryable);
        await client.query('COMMIT');
        return result;
      } catch (error) {
        await client.query('ROLLBACK').catch(() => {
          // 回滚失败也要把原始错误抛出去，不能让次要故障盖住根因
        });
        throw error;
      } finally {
        client.release();
      }
    },
  };
}

/**
 * 创建迁移账本实现。
 *
 * @param pool 连接池。
 * @returns LedgerPort 实现。
 */
export function createLedger(pool: Pool): LedgerPort {
  const read = async (): Promise<AppliedMigration[]> => {
    const { rows } = await pool.query('SELECT version, checksum FROM schema_migrations');
    return rows as AppliedMigration[];
  };

  return {
    async applied(): Promise<AppliedMigration[]> {
      try {
        return await read();
      } catch (error) {
        const mapped = mapPgError(error);
        // 账本表还不存在 = 尚未 bootstrap，属正常首次运行
        if (mapped !== null && mapped.code === 'schema-mismatch') return [];
        if (mapped !== null) throw mapped;
        throw error;
      }
    },
    async mark(version: string, checksum: string): Promise<void> {
      try {
        await pool.query('INSERT INTO schema_migrations (version, checksum) VALUES ($1, $2)', [
          version,
          checksum,
        ]);
      } catch (error) {
        const mapped = mapPgError(error);
        if (mapped !== null) throw mapped;
        throw new WorktableError('db-conflict', '记录迁移版本失败', undefined, true, { version });
      }
    },
  };
}
