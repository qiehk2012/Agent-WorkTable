#!/usr/bin/env node
/**
 * 构建脚本（架构 §2.1 / §5.1 T01）。
 *
 * 1. 刷新迁移生成物（gen-migrations，esbuild bundle 自包含的前提，定稿 §9）；
 * 2. esbuild 双入口 bundle：
 *    - `packages/core/dist/cli.js`（worktable CLI；T04 落地 src/cli/main.ts 前
 *      回退为占位 barrel，空转退出码 0）；
 *    - `packages/mcp/dist/mcp.js`（MCP stdio server 入口）；
 * 3. 组装 `plugin/` 分发目录（骨架：plugin.json / mcp.json / SKILL.md 注入 /
 *    bundle 拷贝；产物内容随后续任务完善）。
 *
 * 约定：bundle 一律 platform=node + format=cjs + 全量 bundle（自包含启动）；
 * 构建日志只写 stdout/stderr，绝不写入被 bundle 的 stdout 协议通道。
 */
import { build } from 'esbuild';
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { generateMigrations } from './gen-migrations.mjs';
import { generateSkill } from './gen-skill.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const rel = (p) => path.join(ROOT, p);

/** 双入口定义：entry 缺失且提供 fallback 时使用占位入口（T01 允许空转）。 */
const BUNDLES = [
  {
    outfile: 'packages/core/dist/cli.js',
    entry: 'packages/core/src/cli/main.ts',
    fallback: 'packages/core/src/index.ts',
  },
  {
    outfile: 'packages/mcp/dist/mcp.js',
    entry: 'packages/mcp/src/index.ts',
    fallback: null,
  },
];

/**
 * esbuild 打包单个入口。
 *
 * @param {{ outfile: string, entry: string, fallback: string | null }} bundle 入口定义。
 */
async function bundle({ outfile, entry, fallback }) {
  let entryPath = rel(entry);
  if (!existsSync(entryPath)) {
    if (!fallback) {
      throw new Error(`构建入口缺失：${entry}`);
    }
    console.warn(`[build] 入口 ${entry} 不存在，使用占位入口 ${fallback}（空转退出码 0）。`);
    entryPath = rel(fallback);
  }
  await build({
    entryPoints: [entryPath],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node20',
    outfile: rel(outfile),
    sourcemap: true,
    logLevel: 'warning',
    absWorkingDir: ROOT,
    // embedded-postgres 的平台二进制是 optionalDependencies（npm 只装当前平台的那个）：
    // 构建机上没有别的平台的包，必须 external 化，运行时按机器动态 require。
    external: ['@embedded-postgres/*'],
  });
  console.log(`[build] ${outfile} OK`);
}

/** 组装 plugin/ 分发目录（骨架，内容随 T04/T05 完善）。 */
async function assemblePlugin() {
  const corePkg = JSON.parse(await readFile(rel('packages/core/package.json'), 'utf8'));
  const pluginDir = rel('plugin');
  await rm(pluginDir, { recursive: true, force: true });
  await mkdir(path.join(pluginDir, 'dist'), { recursive: true });

  // plugin.json：Agent Plugins v1.0.0 manifest 骨架（version 随 core package.json，架构 A5）。
  // 字段细节待分发形态确认后完善；P0 不做官方 schema 校验（架构偏差 D-9）。
  await writeFile(
    path.join(pluginDir, 'plugin.json'),
    `${JSON.stringify(
      {
        name: 'worktable',
        version: corePkg.version,
        description: 'Agent-WorkTable 跨宿主工作台插件（P0 垂直切片）',
        mcp: './mcp.json',
        skills: ['./skills/worktable/SKILL.md'],
      },
      null,
      2,
    )}\n`,
    'utf8',
  );

  // mcp.json：mcpServers 声明，无凭证；Codex >= 0.147.0 原生展开 ${PLUGIN_ROOT}（架构 §2.4 / R-8）。
  await writeFile(
    path.join(pluginDir, 'mcp.json'),
    `${JSON.stringify(
      {
        mcpServers: {
          worktable: {
            command: 'node',
            args: ['${PLUGIN_ROOT}/dist/mcp.js'],
          },
        },
      },
      null,
      2,
    )}\n`,
    'utf8',
  );

  // SKILL.md：注入版本号与工具数（源缺失时跳过并告警——T04 交付源文件）。
  const injected = await generateSkill();
  if (!injected) {
    console.warn('[build] skills/worktable/SKILL.md 源缺失，plugin/skills 未生成（T04 补）。');
  }

  // bundle 拷贝（Codex 原生加载路径，架构 §2.4）。
  await cp(rel('packages/mcp/dist/mcp.js'), path.join(pluginDir, 'dist', 'mcp.js'));
  console.log('[build] plugin/ 组装完成');
}

async function main() {
  const migrationCount = await generateMigrations();
  console.log(`[build] 迁移生成物刷新（${migrationCount} 个迁移）。`);
  for (const item of BUNDLES) {
    await bundle(item);
  }
  await assemblePlugin();
}

main().catch((err) => {
  console.error('[build] 失败：', err);
  process.exit(1);
});
