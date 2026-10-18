/**
 * 错误投影（架构 §7.4 两大转换点之一）：WorktableError → MCP isError 结果。
 *
 * 结构化信息放 structuredContent.error，供宿主 Agent 精确读取错误码与恢复建议；
 * message 里也带一份人类可读的（部分宿主只展示 text）。
 */
import { isPayloadMissingError, isWorktableError, WorktableError } from '@worktable/core';

/** 错误工具结果（形态对齐 SDK 的 CallToolResult，供 server.ts 直接返回）。 */
export type ErrorToolResult = import('@modelcontextprotocol/sdk/types.js').CallToolResult & {
  isError: true;
  structuredContent: { error: Record<string, unknown> };
};

/**
 * 把任意抛错投影为 MCP 错误结果。
 *
 * @param error 工具 handler 抛出的错误。
 * @returns isError 结果。
 */
export function projectError(error: unknown): ErrorToolResult {
  if (isPayloadMissingError(error)) {
    return invalidParams(error.message, {
      kind: 'payload-missing',
      projectId: error.projectId,
      entry: error.entry,
      remediation: '先把产物文件写到项目的 .worktable/artifacts/ 下，再调用挂载',
    });
  }
  if (isWorktableError(error)) {
    return worktableError(error);
  }
  // 未分类错误：如实透传（不吞栈，便于排障）
  const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  return {
    isError: true,
    content: [{ type: 'text', text: `[internal] ${message}` }],
    structuredContent: {
      error: { code: 'internal', message, retryable: false },
    },
  };
}

/**
 * @param error WorktableError。
 * @returns isError 结果。
 */
function worktableError(error: WorktableError): ErrorToolResult {
  const shape = error.toShape() as unknown as Record<string, unknown>;
  return {
    isError: true,
    content: [{ type: 'text', text: `[${error.code}] ${error.message}\n恢复建议：${error.remediation}` }],
    structuredContent: { error: shape },
  };
}

/**
 * 协议级参数错误（invalid params）：不占 12 错误码（PRD §4.2 口径）。
 *
 * @param message 消息。
 * @param extra 结构化补充。
 * @returns isError 结果。
 */
function invalidParams(message: string, extra: Record<string, unknown>): ErrorToolResult {
  return {
    isError: true,
    content: [{ type: 'text', text: `[invalid-params] ${message}` }],
    structuredContent: { error: { code: 'invalid-params', message, ...extra } },
  };
}

export { invalidParams };
