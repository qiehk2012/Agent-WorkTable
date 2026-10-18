/**
 * mcp 层的 ErrorCode 镜像：注册表要保持纯数据（无运行时依赖），
 * 而 core 的 barrel 会拖入 pg / embedded-postgres——因此这里独立声明并做编译期一致性校验。
 */
export type ErrorCode =
  | 'setup-required'
  | 'db-unavailable'
  | 'db-timeout'
  | 'db-conflict'
  | 'project-not-found'
  | 'duplicate-project'
  | 'binding-conflict'
  | 'revision-conflict'
  | 'path-escape'
  | 'schema-mismatch'
  | 'host-unsupported'
  | 'resource-constraint';
