/**
 * 迁移集成测试（PRD P0-1）：空库建表、幂等、checksum 防篡改。
 *
 * 用真实 Postgres：迁移能否原子生效、部分唯一索引是否真的建出来，只有真库能证明。
 */
import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { runMigrations, migrationStatus } from '../src/migrations/index.js';
import { MIGRATIONS } from '../src/migrations/generated.js';
import { startTestEnv, type TestEnv } from './support/test-env.js';

let env: TestEnv;

beforeAll(async () => {
  env = await startTestEnv();
}, 120_000);

afterAll(async () => {
  await env?.teardown();
});

describe('migrations.runner', () => {
  it('空库执行迁移：建出 6 张业务表 + schema_migrations，并记录 version 与 checksum', async () => {
    const { rows } = await env.pool.query(
      `SELECT table_name FROM information_schema.tables
        WHERE table_schema = 'public' ORDER BY table_name`,
    );
    const tables = (rows as Array<{ table_name: string }>).map((r) => r.table_name);

    for (const expected of ['meta', 'projects', 'bindings', 'panes', 'artifacts', 'events']) {
      expect(tables, `缺少业务表 ${expected}`).toContain(expected);
    }
    expect(tables).toContain('schema_migrations');

    const applied = await env.pool.query('SELECT version, checksum FROM schema_migrations ORDER BY version');
    const versions = (applied.rows as Array<{ version: string }>).map((r) => r.version);
    expect(versions).toEqual(['000', '001']);

    const checksums = new Map(
      (applied.rows as Array<{ version: string; checksum: string }>).map((r) => [r.version, r.checksum]),
    );
    for (const migration of MIGRATIONS) {
      expect(checksums.get(migration.version)).toBe(migration.checksum);
    }
  });

  it('重复执行幂等：第二次全部 skip，且行数不变', async () => {
    const report = await runMigrations(env.store.tx, env.store.ledger);
    expect(report.applied).toEqual([]);
    expect(report.skipped).toEqual(['000', '001']);

    const { rows } = await env.pool.query('SELECT COUNT(*)::int AS n FROM schema_migrations');
    expect((rows[0] as { n: number }).n).toBe(2);
  });

  it('checksum 被改过时明确报 schema-mismatch，不静默续跑', async () => {
    // 模拟「有人手改过库里的记录」：把 001 的 checksum 改掉
    await env.pool.query(
      `UPDATE schema_migrations SET checksum = 'deadbeef' WHERE version = '001'`,
    );
    await expect(runMigrations(env.store.tx, env.store.ledger)).rejects.toMatchObject({
      code: 'schema-mismatch',
    });
    // 复原以便后续用例继续复用同一环境
    const original = MIGRATIONS.find((m) => m.version === '001');
    await env.pool.query('UPDATE schema_migrations SET checksum = $1 WHERE version = $2', [
      original?.checksum,
      '001',
    ]);
  });

  it('迁移状态查询：已应用两条、无待应用', async () => {
    const status = await migrationStatus(env.store.ledger);
    expect(status.applied.map((a) => a.version)).toEqual(['000', '001']);
    expect(status.pending).toEqual([]);
  });

  it('部分唯一索引真的存在（binding-conflict 的数据库层保证）', async () => {
    const { rows } = await env.pool.query(
      `SELECT indexdef FROM pg_indexes WHERE indexname = 'idx_bindings_active'`,
    );
    expect(rows.length).toBe(1);
    expect(String((rows[0] as { indexdef: string }).indexdef)).toContain("status <> 'done'");
  });

  it('panes 使用复合主键（晚到写入不覆盖新绑定）', async () => {
    const { rows } = await env.pool.query(
      `SELECT conname, contype FROM pg_constraint WHERE conrelid = 'panes'::regclass AND contype = 'p'`,
    );
    const cols = await env.pool.query(
      `SELECT a.attname FROM pg_constraint c
         JOIN unnest(c.conkey) WITH ORDINALITY AS k(attnum, ord) ON TRUE
         JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.attnum
        WHERE c.conrelid = 'panes'::regclass AND c.contype = 'p' ORDER BY k.ord`,
    );
    expect(rows.length).toBe(1);
    expect((cols.rows as Array<{ attname: string }>).map((c) => c.attname)).toEqual([
      'pane_id',
      'binding_id',
    ]);
  });
});
