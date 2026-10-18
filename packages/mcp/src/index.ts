/**
 * @worktable/mcp stdio server 入口（宿主以 `node dist/mcp.js` 启动）。
 *
 * 纪律（定稿 §4.1）：stdout/stdin 是协议通道，零交互输出——
 * 诊断一律 stderr；数据位置选择 UX 只走 install.sh / CLI / Agent 对话转述。
 */
export { runStdioServer, assembleServer } from './server.js';

import { runStdioServer as run } from './server.js';

void run().catch((error: unknown) => {
  process.stderr.write(`[worktable-mcp] fatal: ${String(error)}\n`);
  process.exit(1);
});
