/**
 * MCP stdio server 装配（架构 §2.3）：注册 10 工具 + 2 prompt + stdio 传输。
 *
 * stdout 纪律：SDK 的 stdio 传输独占 stdout，本文件与其依赖**零 console.log**；
 * 诊断输出一律 stderr。
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createWorktable, type WorktableCore } from '@worktable/core';
import { TOOL_REGISTRY, PROMPT_REGISTRY } from './registry.js';
import { buildToolImplementations, type ToolImplementation } from './tools.js';
import { PROMPTS } from './prompts.js';
import { projectError } from './errors.js';
import type { ToolContext } from './types.js';

/**
 * 装配 McpServer（不连接传输——测试需要先构造再注入假传输）。
 *
 * @param core 已就绪的 core 句柄。
 * @returns McpServer 实例。
 */
export function assembleServer(core: WorktableCore): McpServer {
  const server = new McpServer(
    { name: 'worktable', version: core.version },
    { capabilities: { tools: {}, prompts: {} } },
  );
  const ctx: ToolContext = { core };
  const implementations = new Map<string, ToolImplementation>(
    buildToolImplementations(core).map((tool) => [tool.name, tool]),
  );

  for (const meta of TOOL_REGISTRY) {
    const implementation = implementations.get(meta.name);
    if (implementation === undefined) {
      throw new Error(`注册表与实现脱节：${meta.name} 无实现（verify:mcp 契约测试会拦截）`);
    }
    server.registerTool(
      meta.name,
      {
        title: meta.title,
        description: `${meta.description}（错误码：${meta.errorCodes.join('、')}）`,
        inputSchema: implementation.inputSchema,
      },
      async (args, _extra): Promise<import('@modelcontextprotocol/sdk/types.js').CallToolResult> => {
        try {
          const data = await implementation.handler(ctx, (args ?? {}) as Record<string, unknown>);
          // structuredContent 必须是对象（纯数组会被 SDK 判 -32602）；列表类结果包 result 字段
          const payload =
            Array.isArray(data) || data === null || typeof data !== 'object'
              ? { result: data }
              : data;
          return {
            content: [{ type: 'text', text: JSON.stringify(data, null, 2) }],
            structuredContent: payload as Record<string, unknown>,
          };
        } catch (error: unknown) {
          return projectError(error);
        }
      },
    );
  }

  for (const meta of PROMPT_REGISTRY) {
    const prompt = PROMPTS.find((p) => p.name === meta.name);
    if (prompt === undefined) {
      throw new Error(`注册表与 prompt 实现脱节：${meta.name}`);
    }
    server.registerPrompt(
      meta.name,
      {
        title: meta.title,
        description: meta.description,
      },
      async () => ({ messages: prompt.messages.map((m) => ({ ...m })) }),
    );
  }

  return server;
}

/**
 * stdio 入口主流程：连传输 + 拉起 L1.5（PRD §4.4「生命周期跟随 MCP server 进程」）。
 *
 * web 拉起失败不拖垮工具（偏差 D-5 护栏）：stderr 明示 + status 响应照常返回，
 * 只是 preview 链接在该会话期间不可点。
 */
export async function runStdioServer(): Promise<void> {
  const core = await createWorktable();
  const server = assembleServer(core);
  const transport = new StdioServerTransport();
  await server.connect(transport);

  let webHandle: import('@worktable/core').WebHandle | null = null;
  try {
    webHandle = await core.startWeb();
  } catch (error) {
    process.stderr.write(
      `[worktable-mcp] L1.5 控制室未启动（不影响工具）：${error instanceof Error ? error.message : String(error)}\n`,
    );
  }
  process.on('exit', () => {
    void webHandle?.close().catch(() => undefined);
  });

  process.stderr.write(
    `[worktable-mcp] ready（v${core.version}，mode=${core.mode}，dataHome=${core.dataHome}${webHandle === null ? '' : `，web=${webHandle.url}`}）\n`,
  );
}
