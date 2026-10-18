/**
 * embedded Postgres 集群生命周期（架构 §7.1 / 风险 R-1、R-6）。
 *
 * L1 模块：可依赖 L0（errors）+ 同层 config。
 *
 * 三条纪律：
 * 1. **stdout 零污染**：embedded-postgres 默认把 PG 日志打到 `console.log`（= MCP 的 stdout 协议通道！）。
 *    这里强制改写 onLog/onError 到 stderr，否则 stdio 会话会被日志打断（定稿 §8 / 架构 §7.4）。
 * 2. **不写 SQL**：检查/创建 `worktable` 库一律走库自带 `createDatabase()` API，
 *    避免为了「查 pg_database」而在 db 层引进第一条 SQL（保住「SQL 收敛在 store」红线）。
 * 3. **按进程治理集群**：`EmbeddedPostgres` 实例内部的 postmaster 句柄是私有的，新建实例调 `stop()`
 *    停不掉别人拉起的集群——而 `worktable pg stop`（T04）是**另一个进程**。因此停止一律落到进程层：
 *    优先用本进程持有的实例，否则读 `pgdata/postmaster.pid` 发 SIGINT 并等待端口释放。
 */
import { existsSync, promises as fs } from 'node:fs';
import { join } from 'node:path';
import net from 'node:net';
import EmbeddedPostgres from 'embedded-postgres';
import { WorktableError } from '../errors/index.js';

/** 默认库名：连接串里的 `/worktable`。 */
export const DATABASE_NAME = 'worktable';
/** 数据库超级用户（embedded 专用，不进任何分发产物）。 */
export const ADMIN_USER = 'postgres';
export const ADMIN_PASSWORD = 'postgres';

/** 停止等待上限（毫秒）：超时明确报错，不谎报已停。 */
const STOP_WAIT_MS = 15_000;

/** 本进程拉起的集群实例（key = `<pgdata>:<port>`）。跨进程场景靠 postmaster.pid 治理。 */
const ownedClusters = new Map<string, EmbeddedPostgres>();

/** 集群参数。 */
export interface ClusterOptions {
  dataHome: string;
  port: number;
  /** 测试时可指向临时目录 */
  pgDataDir?: string;
}

/** 集群状态。 */
export interface ClusterStatus {
  initialised: boolean;
  running: boolean;
  port: number;
  pgDataDir: string;
}

/**
 * @param options 集群参数。
 * @returns pgdata 目录。
 */
function pgDataDir(options: ClusterOptions): string {
  return options.pgDataDir ?? join(options.dataHome, 'pgdata');
}

/**
 * @param options 集群参数。
 * @returns 注册表 key。
 */
function keyOf(options: ClusterOptions): string {
  return `${pgDataDir(options)}:${options.port}`;
}

/**
 * @param options 集群参数。
 * @returns 集群实例（尚未连接）。
 */
function cluster(options: ClusterOptions): EmbeddedPostgres {
  return new EmbeddedPostgres({
    databaseDir: pgDataDir(options),
    user: ADMIN_USER,
    password: ADMIN_PASSWORD,
    port: options.port,
    persistent: true,
    onLog: (message: string) => {
      process.stderr.write(`[embedded-pg] ${message}\n`);
    },
    onError: (message: unknown) => {
      process.stderr.write(`[embedded-pg:error] ${String(message)}\n`);
    },
  });
}

/**
 * @param port 端口。
 * @param timeoutMs 连接超时毫秒。
 * @returns 端口是否已在监听。
 */
function probePort(port: number, timeoutMs = 300): Promise<boolean> {
  return new Promise((resolvePromise) => {
    const socket = net.createConnection({ host: '127.0.0.1', port });
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => {
      socket.destroy();
      resolvePromise(true);
    });
    socket.once('error', () => {
      socket.destroy();
      resolvePromise(false);
    });
    socket.once('timeout', () => {
      socket.destroy();
      resolvePromise(false);
    });
  });
}

/**
 * 等待端口停止监听。
 *
 * @param port 端口。
 * @param timeoutMs 上限毫秒。
 * @returns 是否已停。
 */
async function waitUntilStopped(port: number, timeoutMs = STOP_WAIT_MS): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!(await probePort(port))) return true;
    await new Promise((r) => setTimeout(r, 200));
  }
  return !(await probePort(port));
}

/**
 * @param options 集群参数。
 * @returns 集群状态。
 */
export async function clusterStatus(options: ClusterOptions): Promise<ClusterStatus> {
  const dir = pgDataDir(options);
  return {
    initialised: existsSync(join(dir, 'PG_VERSION')),
    running: await probePort(options.port),
    port: options.port,
    pgDataDir: dir,
  };
}

/**
 * 拉起集群：必要时 initialise → start → 确保 `worktable` 库存在。
 * 已在监听时直接返回（另一个宿主进程已经拉起），保证「五宿主共享同一实例」。
 *
 * @param options 集群参数。
 * @returns 集群状态。
 */
export async function startCluster(options: ClusterOptions): Promise<ClusterStatus> {
  const status = await clusterStatus(options);
  if (status.running) return { ...status, running: true };

  const pg = cluster(options);
  try {
    if (!status.initialised) await pg.initialise();
    await pg.start();
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new WorktableError(
      'db-unavailable',
      `嵌入式 Postgres 启动失败：${reason}`,
      '检查端口是否被占用（`worktable doctor` 看连接信息）；首次初始化需联网下载约 35MB 二进制；postgres 不能以 root 运行',
      true,
      { port: options.port, pgDataDir: status.pgDataDir },
    );
  }
  ownedClusters.set(keyOf(options), pg);

  try {
    await pg.createDatabase(DATABASE_NAME);
  } catch {
    // duplicate_database 是正常情形（库已存在）；真正能否连上由首次 query 决定
  }

  return { ...(await clusterStatus(options)), initialised: true };
}

/**
 * 通过 postmaster.pid 停止集群（跨进程场景的唯一可靠手段）。
 *
 * @param pgDataDir pgdata 目录。
 */
async function stopViaPostmasterPid(pgDataDir: string): Promise<void> {
  const pidFile = join(pgDataDir, 'postmaster.pid');
  if (!existsSync(pidFile)) return;
  const firstLine = (await fs.readFile(pidFile, 'utf8')).split('\n')[0]?.trim();
  const pid = Number(firstLine);
  if (!Number.isInteger(pid) || pid <= 0) return;
  try {
    // SIGINT = fast shutdown（等价于 pg_ctl stop -m fast）
    process.kill(pid, 'SIGINT');
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'EPERM') {
      throw new WorktableError(
        'db-unavailable',
        `无法停止 Postgres（pid=${pid}）：权限不足，可能由其它用户启动`,
        '用启动它的那个用户执行 `worktable pg stop`，或直接结束对应进程',
        false,
        { pid },
      );
    }
    // ESRCH：进程已退出，视为已停
  }
}

/**
 * 停止集群。未见运行则无操作；超时仍在运行会明确报错（不谎报已停）。
 *
 * @param options 集群参数。
 * @returns 停止后的集群状态。
 */
export async function stopCluster(options: ClusterOptions): Promise<ClusterStatus> {
  const status = await clusterStatus(options);
  if (!status.running) return status;

  const owned = ownedClusters.get(keyOf(options));
  if (owned !== undefined) {
    try {
      await owned.stop();
    } catch {
      // 实例内部句柄可能已随进程失联，落到 pid 级兜底
    }
    ownedClusters.delete(keyOf(options));
  }
  await stopViaPostmasterPid(status.pgDataDir);

  const stopped = await waitUntilStopped(options.port);
  if (!stopped) {
    throw new WorktableError(
      'db-unavailable',
      `集群停止超时（${STOP_WAIT_MS}ms）：端口 ${options.port} 仍在监听`,
      '确认是否有其它宿主还在连着该集群；必要时手动结束 postmaster 进程后重试',
      true,
      { port: options.port, pgDataDir: status.pgDataDir },
    );
  }
  return { ...(await clusterStatus(options)), initialised: status.initialised };
}
