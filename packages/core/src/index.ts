/**
 * @worktable/core 公共出口 barrel。
 *
 * T01 占位文件：组合根 `createWorktable()` 与各模块导出随 T02（数据层）/
 * T03（服务与 web）落地。跨包共享约定（架构 §1.4 A5）：
 * - 错误码 union 等共享类型唯一定义于本包，`packages/mcp` 只准 import 本 barrel；
 * - 版本号与工具数由构建脚本从本 package.json version + 工具注册表注入生成物。
 */
