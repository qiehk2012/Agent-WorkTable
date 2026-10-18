#!/usr/bin/env node
/**
 * 模块边界守卫（架构 §7.2 导入方向 / §7.3 SQL 收敛纪律，P0 架构红线门禁）。
 *
 * 检查项：
 * 1. SQL 收敛：SQL 字面量只准出现在
 *    - `packages/core/src/store/**`（唯一持 SQL 的生产代码目录）；
 *    - `packages/core/migrations/**`（手写迁移源）；
 *    - `packages/core/src/migrations/generated.ts`（迁移 SQL 的构建内联形态）。
 *    `*.test.ts` 豁免（测试断言需要出现 SQL 文本）。
 * 2. 导入方向（依赖只准向下）：
 *    L0 errors / ids / store/types（无内部依赖，禁跨模块）
 *    L1 config / db / migrations / protocol / hosts（可依赖 L0）
 *    L2 store（可依赖 L0 + db——且仅类型导入 import type）
 *    L3 services（可依赖 L0–L2）
 *    L4 cli / web（可依赖 L0–L3）
 *    `src/index.ts` 组合根（可依赖全部）
 *    `packages/mcp`（只准 import `@worktable/core` 公共 barrel，禁深路径）
 * 3. 深路径 / 反向依赖：任何文件禁止 `@worktable/core/<subpath>`；
 *    `packages/core` 禁止 import `@worktable/mcp`。
 *
 * 扫描范围：`packages/core/src/**` 与 `packages/mcp/**`（集成测试目录
 * `packages/core/tests/` 不在静态扫描范围——其 SQL 断言由集成门禁约束）。
 *
 * 实现口径：正则 + 字符串字面量扫描（架构 §7.2「P0 够用，不引入 eslint 全链」）。
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CORE_SRC = 'packages/core/src/';

/** 模块目录 → 层级（架构 §7.2）。 */
const LAYER_BY_DIR = new Map([
  ['errors', 0],
  ['config', 1],
  ['db', 1],
  ['migrations', 1],
  ['protocol', 1],
  ['hosts', 1],
  ['store', 2],
  ['services', 3],
  ['cli', 4],
  ['web', 4],
]);
const LAYER_NAMES = ['L0', 'L1', 'L2', 'L3', 'L4'];
const ROOT_LAYER = 5; // src/index.ts 组合根（层级最高，可依赖全部）
const MCP_LAYER = 100; // packages/mcp（外部包，只准 core barrel）

/** import/export ... from 'spec'（group1=type 关键字，group2=从句，group3=说明符）。 */
const FROM_IMPORT_RE = /\b(?:import|export)\s+(type\s+)?([^;'"()]*?)\s*from\s*['"]([^'"]+)['"]/g;
/** 副作用 import 'spec'。 */
const SIDE_EFFECT_RE = /\bimport\s*['"]([^'"]+)['"]/g;
/** 动态 import('spec') / require('spec')。 */
const DYNAMIC_RE = /\b(?:import|require)\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
/** 字符串/模板字面量（用于 SQL 扫描；嵌套模板不展开，P0 够用）。 */
const LITERAL_RE = /'(?:[^'\\\n]|\\.)*'|"(?:[^"\\\n]|\\.)*"|`(?:[^`\\]|\\.)*`/g;
/** SQL 关键字（大小写敏感：本代码库 SQL 一律大写，定稿 §4.2 口径）。 */
const SQL_KEYWORD_RE =
  /\b(SELECT|INSERT\s+INTO|UPDATE|DELETE\s+FROM|CREATE\s+TABLE|ALTER\s+TABLE|DROP\s+TABLE|TRUNCATE|BEGIN|COMMIT|ROLLBACK)\b/;

/**
 * 计算仓库相对路径的层级；非 core src 且非 mcp 返回 null。
 *
 * @param {string} relPath 仓库相对路径（POSIX 风格由调用方保证或此处转换）。
 * @returns {number | null} 层级；null = 不在分层表内。
 */
function layerOf(relPath) {
  const posix = toPosix(relPath);
  if (posix.startsWith('packages/mcp/')) {
    return MCP_LAYER;
  }
  if (!posix.startsWith(CORE_SRC)) {
    return null;
  }
  const rest = posix.slice(CORE_SRC.length);
  if (rest === 'index.ts') {
    return ROOT_LAYER;
  }
  if (rest === 'ids.ts') {
    return 0;
  }
  const slash = rest.indexOf('/');
  if (slash === -1) {
    return null; // src 下未知顶层文件
  }
  const dir = rest.slice(0, slash);
  if (dir === 'store' && rest === 'store/types.ts') {
    return 0; // store/types 属 L0（§7.2）
  }
  const layer = LAYER_BY_DIR.get(dir);
  return layer ?? null; // 未知模块目录 → null，由调用方上报
}

/**
 * 去掉注释（保留字符数与换行，保证行号准确）。
 *
 * @param {string} src 源码。
 * @returns {string} 去注释后的源码。
 */
function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/(^|[^:\\])\/\/[^\n]*/g, (m, p1) => p1 + ' '.repeat(m.length - p1.length));
}

/**
 * 提取 import 说明符。
 *
 * @param {string} src 去注释后的源码。
 * @returns {{ spec: string, typeOnly: boolean, index: number }[]} 导入项。
 */
function extractImports(src) {
  const found = [];
  for (const m of src.matchAll(FROM_IMPORT_RE)) {
    const clause = m[2] ?? '';
    const typeOnly = Boolean(m[1]) || /\btype\s+\w/.test(clause);
    found.push({ spec: m[3], typeOnly, index: m.index });
  }
  for (const m of src.matchAll(SIDE_EFFECT_RE)) {
    found.push({ spec: m[1], typeOnly: false, index: m.index });
  }
  for (const m of src.matchAll(DYNAMIC_RE)) {
    found.push({ spec: m[1], typeOnly: false, index: m.index });
  }
  return found;
}

/**
 * 解析相对导入说明符到仓库相对目标路径（统一补 .ts 后缀）。
 *
 * @param {string} fromRelPath 导入方仓库相对路径。
 * @param {string} spec 导入说明符。
 * @returns {string} 目标仓库相对路径（POSIX）。
 */
function resolveTarget(fromRelPath, spec) {
  const base = path.posix.dirname(toPosix(fromRelPath));
  let target = path.posix.normalize(path.posix.join(base, spec));
  if (/\.(json)$/.test(target)) {
    return target;
  }
  if (/\.(ts|js|mjs|cjs)$/.test(target)) {
    target = target.replace(/\.(js|mjs|cjs)$/, '.ts');
  } else {
    target += '.ts';
  }
  return target;
}

/**
 * SQL 字面量违规扫描。
 *
 * @param {string} stripped 去注释后的源码。
 * @returns {{ line: number, snippet: string }[]} 违规命中。
 */
function findSqlViolations(stripped) {
  const hits = [];
  for (const m of stripped.matchAll(LITERAL_RE)) {
    const literal = m[0];
    if (!SQL_KEYWORD_RE.test(literal)) {
      continue;
    }
    const snippet = literal.trim();
    hits.push({
      line: lineOf(stripped, m.index),
      snippet: snippet.length > 60 ? `${snippet.slice(0, 57)}...` : snippet,
    });
  }
  return hits;
}

/**
 * 检查单文件的导入方向。
 *
 * @param {string} relPath 仓库相对路径。
 * @param {number} layer 该文件层级。
 * @param {string} stripped 去注释后的源码。
 * @param {{ relPath: string, line: number, rule: string, message: string }[]} violations 违规收集器。
 */
function checkImports(relPath, layer, stripped, violations) {
  for (const { spec, typeOnly, index } of extractImports(stripped)) {
    const line = lineOf(stripped, index);

    // 全包通用：深路径与反向依赖。
    if (spec.startsWith('@worktable/core/')) {
      violations.push({
        relPath,
        line,
        rule: 'deep-import',
        message: `禁止深路径 import @worktable/core/*（只准公共 barrel '@worktable/core'）：${spec}`,
      });
      continue;
    }
    if (spec === '@worktable/mcp' && toPosix(relPath).startsWith('packages/core/')) {
      violations.push({
        relPath,
        line,
        rule: 'reverse-dep',
        message: 'packages/core 禁止依赖 @worktable/mcp（依赖只准向下）',
      });
      continue;
    }

    // mcp 包：深路径已在上方拦截，其余（相对 / 外部包 / barrel）均允许。
    if (layer === MCP_LAYER) {
      continue;
    }
    // core 内部文件的外部包导入（pg / yaml / node:* 等）允许。
    if (!spec.startsWith('.')) {
      continue;
    }

    const target = resolveTarget(relPath, spec);
    const targetLayer = layerOf(target);
    if (targetLayer === null) {
      continue; // 指向 src 之外（如 package.json），不在分层约束内
    }
    if (layer === ROOT_LAYER) {
      continue; // 组合根可依赖全部
    }
    if (targetLayer > layer) {
      violations.push({
        relPath,
        line,
        rule: 'upward-import',
        message: `导入方向向上：${layerName(layer)} → ${layerName(targetLayer)}（${spec}）`,
      });
      continue;
    }
    if (layer === 2 && targetLayer === 1 && !isDbModule(target)) {
      violations.push({
        relPath,
        line,
        rule: 'store-l1',
        message: `store 禁依赖 L1 各模块（仅准 L0 + db 类型）：${spec}`,
      });
      continue;
    }
    if (layer === 2 && isDbModule(target) && !typeOnly) {
      violations.push({
        relPath,
        line,
        rule: 'store-db-runtime',
        message: `store 只准以类型导入依赖 db（import type）：${spec}`,
      });
      continue;
    }
    if (layer === 0 && targetLayer === 0 && topDir(relPath) !== topDir(target)) {
      violations.push({
        relPath,
        line,
        rule: 'l0-cross',
        message: `L0 模块无内部依赖（禁止跨模块导入）：${spec}`,
      });
    }
  }
}

/**
 * 递归收集 TS 文件（跳过 node_modules / dist）。
 *
 * @param {string} dir 目录绝对路径。
 * @returns {string[]} 文件绝对路径列表。
 */
function collectTsFiles(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === 'dist') {
        continue;
      }
      out.push(...collectTsFiles(full));
    } else if (entry.isFile() && entry.name.endsWith('.ts')) {
      out.push(full);
    }
  }
  return out;
}

/** @param {string} relPath 仓库相对路径。@returns {boolean} 是否测试文件。 */
function isTestFile(relPath) {
  return toPosix(relPath).endsWith('.test.ts');
}

/** @param {string} relPath 仓库相对路径。@returns {boolean} SQL 字面量白名单位置。 */
function isSqlAllowed(relPath) {
  const posix = toPosix(relPath);
  return (
    posix.startsWith('packages/core/src/store/') ||
    posix.startsWith('packages/core/migrations/') ||
    posix === 'packages/core/src/migrations/generated.ts'
  );
}

/** @param {string} target 目标仓库相对路径。@returns {boolean} 是否 db 模块。 */
function isDbModule(target) {
  return toPosix(target).startsWith('packages/core/src/db/');
}

/** @param {string} relPath 仓库相对路径。@returns {string} src 下顶层目录/文件名。 */
function topDir(relPath) {
  const rest = toPosix(relPath).slice(CORE_SRC.length);
  const slash = rest.indexOf('/');
  return slash === -1 ? rest : rest.slice(0, slash);
}

/** @param {string} relPath 仓库相对路径。@returns {string} POSIX 风格路径。 */
function toPosix(relPath) {
  return relPath.split(path.sep).join('/');
}

/** @param {number} layer 层级。@returns {string} 层级可读名。 */
function layerName(layer) {
  if (layer === MCP_LAYER) {
    return 'packages/mcp';
  }
  if (layer === ROOT_LAYER) {
    return '组合根 src/index.ts';
  }
  return LAYER_NAMES[layer] ?? `L${layer}`;
}

/**
 * @param {string} content 源码。
 * @param {number} index 字符偏移。
 * @returns {number} 行号（1 起）。
 */
function lineOf(content, index) {
  return content.slice(0, index).split('\n').length;
}

function main() {
  const scanRoots = ['packages/core/src', 'packages/mcp']
    .map((p) => path.join(ROOT, p))
    .filter((dir) => existsSync(dir));
  const files = scanRoots.flatMap((dir) => collectTsFiles(dir));

  /** @type {{ relPath: string, line: number, rule: string, message: string }[]} */
  const violations = [];
  for (const abs of files) {
    const relPath = path.relative(ROOT, abs);
    const stripped = stripComments(readFileSync(abs, 'utf8'));
    const layer = layerOf(relPath);
    if (layer === null) {
      violations.push({
        relPath,
        line: 1,
        rule: 'layer-unknown',
        message: '文件不在 §7.2 分层表内（新增模块目录请同步更新本守卫的 LAYER_BY_DIR）',
      });
      continue;
    }
    if (!isTestFile(relPath) && !isSqlAllowed(relPath)) {
      for (const hit of findSqlViolations(stripped)) {
        violations.push({
          relPath,
          line: hit.line,
          rule: 'sql-literal',
          message: `SQL 字面量只准出现在 packages/core/src/store/ 与 packages/core/migrations/（发现 ${hit.snippet}）`,
        });
      }
    }
    checkImports(relPath, layer, stripped, violations);
  }

  if (violations.length > 0) {
    console.error(`模块边界检查未通过（${violations.length} 处违规）：`);
    for (const v of violations) {
      console.error(`  ${toPosix(v.relPath)}:${v.line}  [${v.rule}] ${v.message}`);
    }
    process.exit(1);
  }
  console.log(
    `模块边界检查通过：扫描 ${files.length} 个 TS 文件；SQL 收敛 / 导入方向（L0–L4 只准向下）/ mcp barrel 纪律均满足。`,
  );
}

main();
