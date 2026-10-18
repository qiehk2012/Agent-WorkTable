/** mcp 层共享类型。 */
import type { WorktableCore } from '@worktable/core';

/** 工具上下文：handler 只拿 core，杜绝私连数据库。 */
export interface ToolContext {
  core: WorktableCore;
}

/** prompt 消息形态。 */
export interface PromptMessage {
  role: 'user' | 'assistant';
  content: { type: 'text'; text: string };
}
