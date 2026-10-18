#!/usr/bin/env node
// verify:skill——SKILL 注入与纪律检查（frontmatter / 无 @latest / 注入值与事实源一致）
import { readFile } from 'node:fs/promises';
const root = process.cwd();
const skill = await readFile(`${root}/plugin/skills/worktable/SKILL.md`, 'utf8');
const source = await readFile(`${root}/skills/worktable/SKILL.md`, 'utf8');
const catalog = await readFile(`${root}/docs/tool-catalog.md`, 'utf8');
const pkg = JSON.parse(await readFile(`${root}/packages/core/package.json`, 'utf8'));

const failures = [];
// ① frontmatter
if (!/^---\nname: worktable\n/.test(skill)) failures.push('frontmatter 缺 name: worktable');
// ② 无 @latest
if (skill.includes('@latest')) failures.push('SKILL.md 出现 @latest（版本必须钉死）');
// ③ 注入值与事实源一致
const tools = /- 工具数：(\d+)/.exec(catalog)?.[1];
if (!skill.includes(`MCP 工具：${tools} 个`)) failures.push(`工具数注入不一致（期望 ${tools}）`);
if (!skill.includes(`版本：${pkg.version}`)) failures.push(`版本注入不一致（期望 ${pkg.version}）`);
// ④ 生成物与源只差注入占位
if (skill !== source.replaceAll('{{VERSION}}', pkg.version).replaceAll('{{TOOL_COUNT}}', tools)) {
  failures.push('生成物与源不一致（改 skills/ 源后要重跑 npm run gen:skill）');
}
if (failures.length > 0) { console.error('verify:skill 未通过：\n  ' + failures.join('\n  ')); process.exit(1); }
console.log(`verify:skill 通过（v${pkg.version} · ${tools} 工具 · frontmatter/无@latest/注入一致）`);
