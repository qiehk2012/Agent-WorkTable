/**
 * 注册表加载器（scripts/gen-catalog.mjs 与 scripts/gen-skill.mjs 共享）。
 *
 * `packages/mcp/src/registry.ts` 是 TS 源且运行期依赖 zod / @worktable/core，
 * 无法被 Node 直接 require。此处用 esbuild 把它（连同依赖）打包成临时 CJS
 * 后动态导入，取出 TOOL_REGISTRY / PROMPT_REGISTRY——无需预先构建
 * @worktable/core（core 的 package.json main/types/exports 直接指向源码）。
 *
 * 注册表文件不存在时返回空数组（T01 空 catalog 场景；T03 落地注册表后自动生效）。
 */
import { build } from 'esbuild';
import { mkdtemp, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/**
 * 加载工具/prompt 注册表。
 *
 * @param {string} entryRelPath 仓库相对的 registry.ts 路径。
 * @returns {Promise<{ tools: unknown[], prompts: unknown[] }>} 注册表数组（缺失时为空数组）。
 */
export async function loadRegistries(entryRelPath) {
  const entry = path.join(ROOT, entryRelPath);
  if (!existsSync(entry)) {
    return { tools: [], prompts: [] };
  }
  const tmpDir = await mkdtemp(path.join(tmpdir(), 'worktable-registry-'));
  const outfile = path.join(tmpDir, 'registry.cjs');
  try {
    await build({
      entryPoints: [entry],
      bundle: true,
      platform: 'node',
      format: 'cjs',
      target: 'node20',
      outfile,
      logLevel: 'error',
      absWorkingDir: ROOT,
    });
    const mod = await import(pathToFileURL(outfile).href);
    return {
      tools: mod.TOOL_REGISTRY ?? [],
      prompts: mod.PROMPT_REGISTRY ?? [],
    };
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
}
