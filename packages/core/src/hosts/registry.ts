/**
 * 五宿主注册表（架构 §3.5 表 + 主理人裁决 2）。
 *
 * P0 动作分三档：
 * - claude-code / workbuddy：写入 + 结构化复验（WB 无 CLI 自动握手 → 会话内人工确认，D-6）
 * - hermes / codex：探测到即写（best-effort，解析失败降级模板 + 告警）
 * - dsh：仅模板 + 文档（适配留 P1-5）
 */
import { join } from 'node:path';
import { createJsonWriter, createTomlWriter, createYamlWriter } from './writers.js';
import type { HostRegistryEntry, McpServerEntry } from './types.js';

/**
 * MCP server 启动条目：指向构建产物（宿主只需要 node）。
 *
 * @param repoRoot Agent-WorkTable 仓库/安装根目录绝对路径。
 * @returns 注册条目。
 */
export function worktableServerEntry(repoRoot: string): McpServerEntry {
  return {
    command: process.execPath,
    args: [join(repoRoot, 'packages/mcp/dist/mcp.js')],
  };
}

/** 五宿主注册表。 */
export const HOST_REGISTRY: readonly HostRegistryEntry[] = [
  {
    hostId: 'claude-code',
    displayName: 'Claude Code',
    action: 'write-and-verify',
    create: (homeDir) =>
      createJsonWriter('claude-code', () => join(homeDir, '.claude.json')),
  },
  {
    hostId: 'workbuddy',
    displayName: 'WorkBuddy',
    action: 'write-and-verify',
    create: (homeDir) => createJsonWriter('workbuddy', () => join(homeDir, '.workbuddy', 'mcp.json')),
  },
  {
    hostId: 'hermes',
    displayName: 'Hermes',
    action: 'write-best-effort',
    create: (homeDir) => createYamlWriter(() => join(homeDir, '.hermes', 'config.yaml')),
  },
  {
    hostId: 'codex',
    displayName: 'Codex',
    action: 'write-best-effort',
    create: (homeDir) => createTomlWriter(() => join(homeDir, '.codex', 'config.toml')),
  },
  {
    hostId: 'dsh',
    displayName: 'DeepSeek Harness',
    action: 'template-only',
    create: () => {
      throw new Error('dsh 适配留 P1-5：P0 仅交付模板 + 文档（adapters/install/templates/dsh/）');
    },
  },
];
