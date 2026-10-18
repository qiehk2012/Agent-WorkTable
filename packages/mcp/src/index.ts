/**
 * @worktable/mcp stdio server 入口（宿主以 `node dist/mcp.js` 启动）。
 *
 * T01 占位：空转退出（退出码 0）。T03 落地 McpServer 装配（10 工具 + 2 prompt + 传输层）。
 *
 * 纪律（定稿 §4.1）：stdout/stdin 是协议通道，零交互输出——占位阶段直接退出，
 * 不打印任何内容、不弹任何选择；数据位置选择 UX 只走 install.sh / CLI / Agent 对话转述。
 */
process.exit(0);
