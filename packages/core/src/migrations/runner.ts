/**
 * 迁移执行器（定稿 §4.2 / 架构 §3.2）。
 *
 * 设计要点：
 * - **零 SQL**：本文件不写任何 SQL —— 账本读写经 {@link LedgerPort} 注入（由 store 实现，SQL 仍只收在 store），
 *   迁移 SQL 来自 `generated.ts`（`.sql` 源文件的内联构建形态）。这条约束让我们不必为基建 SQL 放宽
 *   「SQL 不出 Store」的架构红线。
 * - **事务托管**：BEGIN/COMMIT 由事务包装器负责，SQL 文件里不再出现事务语句，保证单条迁移整体生效或整体回滚。
 * - **checksum 防篡改**：已应用版本若与当前文件 sha256 不符 → `schema-mismatch` 明确报错，绝不静默续跑。
 *
 * L1 模块：可依赖 L0（errors）。
 */
import { WorktableError } from '../errors/index.js';
import { MIGRATIONS } from './generated.js';
// 端口类型定义在 L0（store/types.ts）：migrations(L1) 与 store(L2) 双向共享而不产生反向依赖
import type { AppliedMigration, LedgerPort, Queryable, Transactor } from '../store/types.js';

export type { AppliedMigration, LedgerPort, Queryable, Transactor };

/** 迁移执行结果。 */
export interface MigrationReport {
  applied: string[];
  skipped: string[];
}

/** 引导迁移版本号：必须先于一切，负责创建账本表。 */
const BOOTSTRAP_VERSION = '000';

/**
 * 执行全部迁移（幂等）。
 *
 * @param tx Transactor。
 * @param ledger 账本端口。
 * @returns 本次应用与跳过的版本号。
 */
export async function runMigrations(tx: Transactor, ledger: LedgerPort): Promise<MigrationReport> {
  const applied: string[] = [];
  const skipped: string[] = [];
  const sorted = [...MIGRATIONS].sort((a, b) => a.version.localeCompare(b.version));

  const bootstrap = sorted.find((m) => m.version === BOOTSTRAP_VERSION);
  if (bootstrap === undefined) {
    throw new WorktableError('schema-mismatch', `缺少引导迁移 ${BOOTSTRAP_VERSION}（账本表无法创建）`);
  }

  // 第一步：引导。bootstrap 幂等（CREATE TABLE IF NOT EXISTS），并发下后到者重复执行无副作用。
  await tx.withTransaction(async (client) => {
    await client.query(bootstrap.sql);
  });

  const ledgerEntries = await ledger.applied();
  const recordByVersion = new Map(ledgerEntries.map((entry) => [entry.version, entry.checksum]));

  for (const migration of sorted) {
    const recorded = recordByVersion.get(migration.version);
    if (recorded === migration.checksum) {
      skipped.push(migration.version);
      continue;
    }
    if (recorded !== undefined) {
      throw new WorktableError(
        'schema-mismatch',
        `迁移 ${migration.version} 的 checksum 与库中记录不符（有人改过迁移文件或数据库）`,
        '不要手改迁移文件；如需修正请新增迁移。确认无损后可重建 dataHome',
        false,
        { version: migration.version, expected: migration.checksum, recorded },
      );
    }
    await tx.withTransaction(async (client) => {
      await client.query(migration.sql);
    });
    await ledger.mark(migration.version, migration.checksum);
    applied.push(migration.version);
  }

  return { applied, skipped };
}

/**
 * 查询迁移状态（供 `worktable migrate --status` 与 doctor 使用）。
 *
 * @param ledger 账本端口。
 * @returns 已应用 / 未应用版本清单。
 */
export async function migrationStatus(ledger: LedgerPort): Promise<{
  applied: AppliedMigration[];
  pending: string[];
}> {
  const appliedRecords = await ledger.applied();
  const appliedVersions = new Set(appliedRecords.map((entry) => entry.version));
  const pending = [...MIGRATIONS]
    .sort((a, b) => a.version.localeCompare(b.version))
    .filter((m) => !appliedVersions.has(m.version))
    .map((m) => m.version);
  return { applied: appliedRecords, pending };
}
