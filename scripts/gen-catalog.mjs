#!/usr/bin/env node
/**
 * 工具 catalog 生成器（架构 §2.1 / §3.4）。
 *
 * 读 `packages/mcp/src/registry.ts` 的 TOOL_REGISTRY / PROMPT_REGISTRY，
 * 生成 `docs/tool-catalog.md`——工具数是 SKILL.md / doctor / install.sh 握手断言的
 * 唯一来源（禁硬编码；定稿偏差 D-2/D-3）。注册表缺失（T01 期间）时输出空 catalog 表头。
 *
 * 输出必须完全确定（无时间戳、无环境相关信息），否则 verify:catalog 无法复现。
 *
 * 用法：
 *   node scripts/gen-catalog.mjs           # 写 docs/tool-catalog.md
 *   node scripts/gen-catalog.mjs --check   # 只比对不落盘（verify:catalog 门禁）
 *
 * --check 走「内存渲染 + 比对」，不用 git diff：未跟踪文件在 `git diff --exit-code`
 * 下静默通过，会让「catalog 压根没提交」也成为绿灯（评审发现的假通过，已修）。
 */
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadRegistries } from './lib/load-registry.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUTPUT = path.join(ROOT, 'docs', 'tool-catalog.md');
const REGISTRY_SOURCE = 'packages/mcp/src/registry.ts';

/**
 * 生成 docs/tool-catalog.md。
 *
 * @param {{ dryRun?: boolean }} [options] dryRun=true 时不落盘，返回内容供比对。
 * @returns {Promise<{ tools: number, prompts: number, content: string }>} 工具/prompt 数与渲染结果。
 */
export async function generateCatalog(options = {}) {
  const { tools, prompts } = await loadRegistries(REGISTRY_SOURCE);
  const content = render(tools, prompts);
  if (options.dryRun !== true) {
    await mkdir(path.dirname(OUTPUT), { recursive: true });
    await writeFile(OUTPUT, content, 'utf8');
  }
  return { tools: tools.length, prompts: prompts.length, content };
}

/**
 * 渲染 catalog Markdown（确定性输出）。
 *
 * @param {unknown[]} tools TOOL_REGISTRY 条目。
 * @param {unknown[]} prompts PROMPT_REGISTRY 条目。
 * @returns {string} Markdown 内容。
 */
function render(tools, prompts) {
  const lines = [
    '# Agent-WorkTable 工具 Catalog',
    '',
    '> 【生成物 · 禁手改】由 `scripts/gen-catalog.mjs` 从 `packages/mcp/src/registry.ts` 生成。',
    '> 工具数是 SKILL.md / doctor / install.sh 握手断言的唯一来源，禁止硬编码（定稿 D-2/D-3）。',
    '> 重新生成：`npm run gen:catalog`；门禁：`npm run verify:catalog`（内存渲染后比对）。',
    '',
    `- 工具数：${tools.length}`,
    `- Prompt 数：${prompts.length}`,
    '',
    `## 工具（${tools.length}）`,
    '',
    '| 工具 | 标题 | 说明 | 声明的错误码 |',
    '|---|---|---|---|',
  ];
  if (tools.length === 0) {
    lines.push('| _（注册表为空——T03 落地 `packages/mcp/src/registry.ts` 后重新生成）_ | — | — | — |');
  } else {
    for (const tool of tools) {
      const t = /** @type {Record<string, unknown>} */ (tool);
      const codes = Array.isArray(t.errorCodes) ? t.errorCodes.join('、') : '';
      lines.push(`| \`${cell(t.name)}\` | ${cell(t.title)} | ${cell(t.description)} | ${cell(codes) || '—'} |`);
    }
  }
  lines.push('', `## Prompt（${prompts.length}）`, '', '| Prompt | 标题 | 说明 |', '|---|---|---|');
  if (prompts.length === 0) {
    lines.push('| _（注册表为空）_ | — | — |');
  } else {
    for (const prompt of prompts) {
      const p = /** @type {Record<string, unknown>} */ (prompt);
      lines.push(`| \`${cell(p.name)}\` | ${cell(p.title)} | ${cell(p.description)} |`);
    }
  }
  lines.push('');
  return lines.join('\n');
}

/** 表格单元格转义：竖线转义、换行压平。 */
function cell(value) {
  return String(value ?? '')
    .replace(/\|/g, '\\|')
    .replace(/\r?\n/g, ' ');
}

const invokedDirectly =
  process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (invokedDirectly) {
  const check = process.argv.includes('--check');
  try {
    const result = await generateCatalog({ dryRun: check });
    if (!check) {
      console.log(`[gen-catalog] docs/tool-catalog.md 已生成（工具 ${result.tools} · prompt ${result.prompts}）。`);
      process.exit(0);
    }
    let current = null;
    try {
      current = await readFile(OUTPUT, 'utf8');
    } catch {
      console.error('[gen-catalog] 失败：docs/tool-catalog.md 不存在，先跑 npm run gen:catalog 并提交');
      process.exit(1);
    }
    if (current !== result.content) {
      console.error('[gen-catalog] 失败：docs/tool-catalog.md 与注册表不一致，请重跑 npm run gen:catalog 并提交');
      process.exit(1);
    }
    console.log(`[gen-catalog] 一致（工具 ${result.tools} · prompt ${result.prompts}）`);
    process.exit(0);
  } catch (err) {
    console.error('[gen-catalog] 失败：', err);
    process.exit(1);
  }
}
