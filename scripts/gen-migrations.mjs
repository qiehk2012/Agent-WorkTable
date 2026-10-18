#!/usr/bin/env node
/**
 * 迁移生成器（架构 §2.1 / §1.4 补充决策）。
 *
 * 双形态迁移（定稿 §4.2 / §9）：
 * - 源：`packages/core/migrations/*.sql`（手写编号迁移，git 跟踪，checksum 防篡改）；
 * - 生成物：`packages/core/src/migrations/generated.ts`（内联 SQL + sha256，
 *   保证 esbuild bundle 自包含启动；禁手改，gitignore）。
 *
 * checksum 口径：sha256(SQL 文件原文, utf8) 的 hex。T02 的 runner 必须用同一算法
 * 对 applied SQL 复算校验（不符 → schema-mismatch，不静默续跑）。
 */
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MIGRATIONS_DIR = path.join(ROOT, 'packages/core', 'migrations');
const OUTPUT = path.join(ROOT, 'packages/core', 'src', 'migrations', 'generated.ts');

/** 迁移文件名约定：<序号>_<名称>.sql（如 001_init.sql）。 */
const FILENAME_RE = /^(\d+)_([a-z0-9-]+)\.sql$/;

/**
 * 生成 packages/core/src/migrations/generated.ts。
 *
 * @returns {Promise<number>} 纳入生成的迁移条目数。
 */
export async function generateMigrations() {
  const files = existsSync(MIGRATIONS_DIR)
    ? (await readdir(MIGRATIONS_DIR)).filter((name) => name.endsWith('.sql')).sort()
    : [];
  const entries = [];
  for (const name of files) {
    const matched = FILENAME_RE.exec(name);
    if (!matched) {
      throw new Error(`迁移文件名须为 <序号>_<名称>.sql（如 001_init.sql）：${name}`);
    }
    const sql = await readFile(path.join(MIGRATIONS_DIR, name), 'utf8');
    entries.push({
      version: matched[1],
      name: matched[2],
      checksum: createHash('sha256').update(sql, 'utf8').digest('hex'),
      sql,
    });
  }
  await mkdir(path.dirname(OUTPUT), { recursive: true });
  await writeFile(OUTPUT, render(entries), 'utf8');
  return entries.length;
}

/**
 * 渲染 generated.ts。SQL 一律经 JSON.stringify 内联（安全转义反引号/${}）。
 *
 * @param {{ version: string, name: string, checksum: string, sql: string }[]} entries 迁移条目。
 * @returns {string} generated.ts 文件内容。
 */
function render(entries) {
  const items = entries
    .map(
      (entry) =>
        [
          '  {',
          `    version: ${JSON.stringify(entry.version)},`,
          `    name: ${JSON.stringify(entry.name)},`,
          `    checksum: ${JSON.stringify(entry.checksum)},`,
          `    sql: ${JSON.stringify(entry.sql)},`,
          '  },',
        ].join('\n'),
    )
    .join('\n');
  return `// 【生成物 · 禁手改】由 scripts/gen-migrations.mjs 生成（源：packages/core/migrations/*.sql）。
// 改迁移请改源文件后重新生成：npm run gen:migrations。
export interface Migration {
  readonly version: string;
  readonly name: string;
  readonly checksum: string;
  readonly sql: string;
}

export const MIGRATIONS: readonly Migration[] = [
${items}
];
`;
}

const invokedDirectly =
  process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  generateMigrations()
    .then((count) => {
      console.log(`[gen-migrations] packages/core/src/migrations/generated.ts 已生成（${count} 个迁移）。`);
    })
    .catch((err) => {
      console.error('[gen-migrations] 失败：', err);
      process.exit(1);
    });
}
