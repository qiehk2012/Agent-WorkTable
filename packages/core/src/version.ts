/**
 * 版本号单一源（架构 §1.4 A5）：SKILL.md 注入、doctor 首行输出、plugin.json 一律取这里的值。
 *
 * 为什么单独一个文件：package.json 是 npm 元数据，运行时读它要处理路径与 ESM/CJS 差异，
 * 而这里的值必须与 `@worktable/core` 的 package.json version 保持同步——由 T01 的 gen-skill.mjs 在构建期校验。
 */
/** core 版本号：与 packages/core/package.json 的 version 保持一致。 */
export const WORKTABLE_VERSION = '0.1.0';
