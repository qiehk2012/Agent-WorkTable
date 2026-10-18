/**
 * 错误契约（架构 §3.7 / PRD §4.2）：12 个错误码的 discriminated union 与唯一定义处。
 *
 * L0 模块：无内部依赖。全部失败在 core 内一律抛 {@link WorktableError}，
 * 呈现层投影点只有两处—— `packages/mcp/src/errors.ts` 与 `packages/core/src/cli/main.ts`（架构 §7.4）。
 */

/** P0 全部错误码。任何新增码须同步：本表 + ERROR_CATALOG + PRD §4.2。 */
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

/** 面向宿主的错误投影形态（MCP structuredContent.error / CLI stderr 同源）。 */
export interface WorktableErrorShape {
  code: ErrorCode;
  /** 简体中文，人类可读 */
  message: string;
  /** 恢复建议 */
  remediation: string;
  /** 重试是否有意义 */
  retryable: boolean;
  /** 结构化补充（如 setup-required 的候选清单） */
  details?: Record<string, unknown>;
}

export interface ErrorCatalogEntry {
  retryable: boolean;
  /** 目录级默认恢复建议；抛错时可传更具体的建议覆盖 */
  remediation: string;
}

/** 12 码目录：retryable 与默认 remediation 的唯一事实源（PRD §4.2 表）。 */
export const ERROR_CATALOG: Readonly<Record<ErrorCode, ErrorCatalogEntry>> = Object.freeze({
  'setup-required': {
    retryable: false,
    remediation: '先跑 `worktable init` 选择数据位置（stdio 不能弹交互，见定稿 §4.1）',
  },
  'db-unavailable': {
    retryable: true,
    remediation: '检查 embedded 集群是否已启动（`worktable pg status`），或外部库连接串是否可达',
  },
  'db-timeout': {
    retryable: true,
    remediation: '重试；用 `worktable check` 查锁等待与慢查询',
  },
  'db-conflict': {
    retryable: true,
    remediation: '重试；`worktable check` 查锁等待',
  },
  'project-not-found': {
    retryable: false,
    remediation: '先 `list_projects` 确认项目名或 ID',
  },
  'duplicate-project': {
    retryable: false,
    remediation: '换项目名，或用 `update_project` 更新既有项目',
  },
  'binding-conflict': {
    retryable: false,
    remediation: '先解绑旧会话，或带 `force` 顶替（旧 binding 置 done）',
  },
  'revision-conflict': {
    retryable: true,
    remediation: '重新读取再读取-修改-写入（read-modify-write）',
  },
  'path-escape': {
    retryable: false,
    remediation: '把 `entry` 修正为项目内的相对路径',
  },
  'schema-mismatch': {
    retryable: false,
    remediation: '跑 `worktable migrate` 升级数据库 schema',
  },
  'host-unsupported': {
    retryable: false,
    remediation: '当前宿主不支持该 UI 能力；改用浏览器打开 `uiUrl`（L1.6 显式兜底）',
  },
  'resource-constraint': {
    retryable: true,
    remediation: '缩小查询范围（如按 projectId 过滤），或改用 `list_projects` 概览',
  },
});

/** node-postgres / 驱动错误的形态（鸭子类型，避免强依赖 pg 类型）。 */
interface PgLikeError {
  code?: string;
  constraint?: string;
  errno?: number;
  syscall?: string;
}

/** 连接类：无法数据库层判定 vendor code，只能看 errno/syscall 与认证返回码。 */
function isConnectionError(err: PgLikeError): boolean {
  const errno = err.errno;
  return (
    err.code === 'ECONNREFUSED' ||
    err.code === 'ECONNRESET' ||
    err.code === 'ENOTFOUND' ||
    err.code === 'EHOSTUNREACH' ||
    err.code === '28P01' /* invalid_password */ ||
    err.code === '28000' /* invalid_authorization_specification */ ||
    err.code === '3D000' /* invalid_catalog_name：库不存在 */ ||
    (errno !== undefined && (err.syscall === 'connect' || err.syscall === 'open'))
  );
}

/**
 * 把 node-postgres 原生错误映射为业务错误码（架构 §3.2 错误映射约定）。
 * 映射集中在本文件：store 内不手写错误文字。
 *
 * @param err 捕获到的未知错误。
 * @returns 映射后的 {@link WorktableError}；无法识别时返回 null（由调用方抛 schema-mismatch 等）。
 */
export function mapPgError(err: unknown): WorktableError | null {
  if (typeof err !== 'object' || err === null) return null;
  const pg = err as PgLikeError;
  const code = pg.code;

  if (isConnectionError(pg)) {
    return new WorktableError('db-unavailable', `无法连接数据库（${String(code ?? pg.errno)}）`, undefined, true, {
      driverCode: code,
    });
  }
  switch (code) {
    case '23505': {
      if (pg.constraint === 'idx_bindings_active') {
        return new WorktableError('binding-conflict', '该项目已有进行中的会话绑定', undefined, false, {
          constraint: pg.constraint,
        });
      }
      if (pg.constraint === 'projects_name_key') {
        return new WorktableError('duplicate-project', '项目名已存在', undefined, false, {
          constraint: pg.constraint,
        });
      }
      return new WorktableError('duplicate-project', `唯一约束冲突（${String(pg.constraint)}）`, undefined, false, {
        constraint: pg.constraint,
      });
    }
    case '40P01': // deadlock_detected
    case '40001': // serialization_failure
      return new WorktableError('db-conflict', '并发写冲突（死锁或序列化失败），已重试一次仍失败', undefined, true, {
        driverCode: code,
      });
    case '57014': // query_canceled（statement_timeout 到期）
      return new WorktableError('db-timeout', '查询超时被取消（statement_timeout=5s）', undefined, true, {
        driverCode: code,
      });
    case '42P01': // undefined_table
    case '42703': // undefined_column
      return new WorktableError('schema-mismatch', '数据库表或列不存在，schema 尚未就绪', undefined, false, {
        driverCode: code,
      });
    default:
      return null;
  }
}

/**
 * 全项目唯一错误类。core 内禁止裸 `throw new Error()`（架构 §7.4）。
 */
export class WorktableError extends Error {
  readonly code: ErrorCode;
  readonly remediation: string;
  readonly retryable: boolean;
  readonly details?: Record<string, unknown>;

  constructor(
    code: ErrorCode,
    message: string,
    remediation?: string,
    retryable?: boolean,
    details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'WorktableError';
    this.code = code;
    const catalog = ERROR_CATALOG[code];
    this.remediation = remediation ?? catalog.remediation;
    this.retryable = retryable ?? catalog.retryable;
    if (details !== undefined) this.details = details;
  }

  /** 投影为宿主可见形态。 */
  toShape(): WorktableErrorShape {
    const shape: WorktableErrorShape = {
      code: this.code,
      message: this.message,
      remediation: this.remediation,
      retryable: this.retryable,
    };
    if (this.details !== undefined) shape.details = this.details;
    return shape;
  }
}

/**
 * 断言式类型守卫：把 unknown 收敛到 WorktableError。
 *
 * @param err unknown 捕获值。
 * @returns 是否为 {@link WorktableError}。
 */
export function isWorktableError(err: unknown): err is WorktableError {
  return err instanceof WorktableError;
}
