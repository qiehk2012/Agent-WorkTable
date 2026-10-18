#!/usr/bin/env node
/**
 * SKILL.md 生成器（架构 §2.1 / P0-6）。
 *
 * 读 `skills/worktable/SKILL.md` 源文件（一份源，禁手改产物），注入：
 * - `{{VERSION}}` → packages/core/package.json 的 version（架构 A5 单一事实源）；
 * - `{{TOOL_COUNT}}` → 工具注册表条目数（catalog 同源）。
 * 写入 `plugin/skills/worktable/SKILL.md`（install.sh 的拷贝源，gitignore）。
 *
 * T01 期间源文件尚未交付（T04）：缺失时告警跳过、返回 false，不阻断构建。
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadRegistries } from './lib/load-registry.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE = path.join(ROOT, 'skills', 'worktable', 'SKILL.md');
const OUTPUT = path.join(ROOT, 'plugin', 'skills', 'worktable', 'SKILL.md');
const REGISTRY_SOURCE = 'packages/mcp/src/registry.ts';
const CORE_PACKAGE_JSON = path.join(ROOT, 'packages', 'core', 'package.json');

/**
 * 生成 plugin/skills/worktable/SKILL.md。
 *
 * @returns {Promise<boolean>} true = 已生成；false = 源缺失跳过。
 */
export async function generateSkill() {
  if (!existsSync(SOURCE)) {
    console.warn('[gen-skill] skills/worktable/SKILL.md 源缺失，跳过注入（T04 交付源文件）。');
    return false;
  }
  const corePkg = JSON.parse(await readFile(CORE_PACKAGE_JSON, 'utf8'));
  const { tools } = await loadRegistries(REGISTRY_SOURCE);
  const injected = (await readFile(SOURCE, 'utf8'))
    .replaceAll('{{VERSION}}', String(corePkg.version))
    .replaceAll('{{TOOL_COUNT}}', String(tools.length));
  if (/\{\{(VERSION|TOOL_COUNT)\}\}/.test(injected)) {
    throw new Error('SKILL.md 注入后仍残留未识别占位符（{{VERSION}} / {{TOOL_COUNT}}）');
  }
  await mkdir(path.dirname(OUTPUT), { recursive: true });
  await writeFile(OUTPUT, injected, 'utf8');
  return true;
}

const invokedDirectly =
  process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  generateSkill()
    .then((generated) => {
      if (generated) {
        console.log('[gen-skill] plugin/skills/worktable/SKILL.md 已生成。');
      }
    })
    .catch((err) => {
      console.error('[gen-skill] 失败：', err);
      process.exit(1);
    });
}
