/**
 * 宿主配置类型（架构 §3.5）：五宿主的写入器接口与注册表。
 *
 * L1 模块：可依赖 L0（errors）。
 */
import type { ErrorCode } from '../errors/index.js';

/** 宿主标识。 */
export type HostId = 'claude-code' | 'workbuddy' | 'hermes' | 'codex' | 'dsh';

/** 配置文件格式。 */
export type HostConfigFormat = 'json' | 'yaml' | 'toml';

/** MCP server 注册条目。 */
export interface McpServerEntry {
  command: string;
  args: string[];
  env?: Record<string, string>;
}

/** 解析后的宿主配置文档（结构由各写入器自定义，读写对称）。 */
export type HostConfigDocument = Record<string, unknown>;

/** 宿主写入器接口（结构化解析 + 枚举 key 复验，禁 grep）。 */
export interface HostConfigWriter {
  readonly hostId: HostId;
  readonly format: HostConfigFormat;
  configPath(homeDir: string): string;
  skillsPath(homeDir: string): string | null;
  /** 解析失败抛 HostConfigParseError（→ 降级模板 + 告警，主理人裁决 2 护栏）。 */
  parse(content: string): HostConfigDocument;
  serialize(doc: HostConfigDocument): string;
  /** 纯函数：把 entry 合入文档（幂等：已存在则覆盖同 key）。 */
  mergeEntry(doc: HostConfigDocument, serverKey: string, entry: McpServerEntry): HostConfigDocument;
  /** 结构化复验：解析后枚举 key，确认 serverKey 在位且形态正确。 */
  verify(doc: HostConfigDocument, serverKey: string): boolean;
}

/** 宿主注册表条目。 */
export interface HostRegistryEntry {
  hostId: HostId;
  displayName: string;
  /** P0 动作（主理人裁决 2）。 */
  action: 'write-and-verify' | 'write-best-effort' | 'template-only';
  create: (homeDir: string) => HostConfigWriter;
}

/** 宿主配置解析失败（结构性错误，触发降级模板）。 */
export class HostConfigParseError extends Error {
  constructor(
    public readonly hostId: HostId,
    public readonly path: string,
    cause: unknown,
  ) {
    super(`宿主配置解析失败（${hostId}，${path}）：${cause instanceof Error ? cause.message : String(cause)}`);
    this.name = 'HostConfigParseError';
  }
}

/** 事务写入结果（架构 §3.5）。 */
export interface TransactionalWriteResult {
  path: string;
  backupPath: string | null;
  verified: boolean;
  rolledBack: boolean;
}

/** 写入失败错误（含错误码语义）。 */
export class HostWriteError extends Error {
  readonly code: ErrorCode;
  constructor(code: ErrorCode, message: string, public readonly details?: Record<string, unknown>) {
    super(message);
    this.name = 'HostWriteError';
    this.code = code;
  }
}
