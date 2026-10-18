/**
 * 文件锁（架构 §3.3 / 风险 R-5）：防止五个宿主进程同时初始化 dataHome / 嵌入式集群。
 *
 * L1 模块：可依赖 L0（errors）。
 *
 * 为什么不是 pg_advisory_lock：顾问锁**需要先连上库**，而这里保护的动作是「把库拉起来之前」的
 * 初始化竞争；文件锁覆盖「cluster 未起」这段窗口，顾问锁负责「已连上库之后」的迁移与备份（定稿 §4.4）。
 */
import { existsSync, promises as fs, mkdirSync, renameSync, rmSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { WorktableError } from '../errors/index.js';

/** 锁文件内记录的持有者 pid（stale 判定依据）。 */
interface LockPayload {
  pid: number;
  startedAt: string;
}

/** 默认等待上限：超时明确报错，不无限等（R-5）。 */
export const DEFAULT_WAIT_MS = 10_000;
/** 轮询间隔。 */
const POLL_MS = 100;
/** 单次 tryAcquire 的最大接管轮次（防止极端竞态下空转）。 */
const MAX_ACQUIRE_ATTEMPTS = 20;

/**
 * @param pid 进程号。
 * @returns 进程是否存活。
 */
function isAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM 表示进程存在但无权限发信号 —— 视为存活；ESRCH 才是真的不存在
    const code = (error as NodeJS.ErrnoException).code;
    return code === 'EPERM';
  }
}

/**
 * 判断一个错误是否是「已存在」（mkdir 独占语义的核心判据）。
 *
 * 为什么不能只看 `err.code`：某些运行环境（如受控文件系统代理层）抛出的错误不带标准 `code`，
 * 只在 message 里保留 errno 字样。漏判会让并发首次初始化直接崩掉，
 * 因此这里 code 与 message 双轨识别。
 *
 * @param error 捕获到的错误。
 * @returns 是否为 EEXIST 类错误。
 */
function isAlreadyExists(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  if (code === 'EEXIST') return true;
  const message = error instanceof Error ? error.message : String(error);
  return /EEXIST|file already exists|already exists/i.test(message);
}

/**
 * 尝试获取文件锁（mkdir 独占语义）。
 *
 * @param lockPath 锁文件路径。
 * @returns true=获取到；false=他人持有且持有者存活。
 */
async function tryAcquire(lockPath: string): Promise<boolean> {
  const payload: LockPayload = { pid: process.pid, startedAt: new Date().toISOString() };
  // 原子接管：先把 owner.json 写进**旁路的临时目录**，再 rename 到位。
  // 若直接 mkdir(lockPath) 再写 owner.json，中间存在一个窗口：先到者已占坑但还没写持有信息，
  // 后到者读不到 owner 便当作 stale 锁删掉 → 两人同时进入临界区（并发门禁实测：5 次自增只剩 2）。
  // rename 整体成功或整体失败，没有中间态，窗口随之消失。
  for (let attempt = 0; attempt < MAX_ACQUIRE_ATTEMPTS; attempt += 1) {
    const staged = `${lockPath}.${process.pid}.${randomBytes(6).toString('hex')}`;
    try {
      mkdirSync(staged);
      await fs.writeFile(join(staged, 'owner.json'), `${JSON.stringify(payload)}\n`, {
        encoding: 'utf8',
      });
      renameSync(staged, lockPath);
      return true;
    } catch (error) {
      rmSync(staged, { recursive: true, force: true });
      if (!isAlreadyExists(error) && !isNotEmpty(error)) throw error;

      const owner = await readOwner(lockPath);
      // 他人持有且存活 → 本次不接管，由调用方等待或放弃
      if (owner !== null && owner.pid !== process.pid && isAlive(owner.pid)) return false;

      // 无 owner 或持有者已死（stale）→ 清掉后重试一轮
      try {
        rmSync(lockPath, { recursive: true, force: true });
      } catch {
        // 清理失败说明这段时间里已被别人接管，下一轮 mkdir 同样会拿到 EEXIST 并正确判活
      }
    }
  }
  return false;
}

/**
 * 判断是否为「rename 到非空目录」的失败（macOS 报 ENOTEMPTY，Linux 多为 ENOTEMPTY/EEXIST）。
 *
 * @param error 捕获到的错误。
 * @returns 是否命中。
 */
function isNotEmpty(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  if (code === 'ENOTEMPTY' || code === 'ENOTDIR' || code === 'EEXIST') return true;
  const message = error instanceof Error ? error.message : String(error);
  return /not empty|ENOTEMPTY|directory not empty/i.test(message);
}

/**
 * 读取锁持有者信息。
 *
 * @param lockPath 锁文件路径。
 * @returns 持有者；无 owner.json 或解析失败返回 null。
 */
async function readOwner(lockPath: string): Promise<LockPayload | null> {
  try {
    const raw = await fs.readFile(join(lockPath, 'owner.json'), 'utf8');
    const parsed: unknown = JSON.parse(raw);
    const pid = (parsed as Partial<LockPayload> | null)?.pid;
    return typeof pid === 'number' ? (parsed as LockPayload) : null;
  } catch {
    return null;
  }
}

/**
 * 进程内互斥链（按锁路径分片）。
 *
 * 为什么文件锁之外还需要它：同进程的并发调用持有者 pid 相同，
 * `owner.pid === process.pid` 无法区分「我的另一个异步调用正持有」与「我上一进程留下的 stale 锁」，
 * 于是后者会被当成可接管 → 进程内互斥失效（并发门禁实测：5 次自增只剩 2）。
 * 文件锁只负责**跨进程**，进程内由这条串行链兜住。
 */
const processChains = new Map<string, Promise<unknown>>();

/**
 * 进程串行执行（前一个无论成败都放行后一个）。
 *
 * @param key 互斥 key。
 * @param fn 待执行动作。
 * @returns 动作结果。
 */
function serializeInProcess<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const previous = processChains.get(key) ?? Promise.resolve();
  const current = previous.then(fn, fn);
  processChains.set(
    key,
    current.then(
      () => undefined,
      () => undefined,
    ),
  );
  return current;
}

/**
 * 在锁保护下执行一次性动作；拿不到锁（他人正在做）则视为已完成，不重复执行。
 *
 * @param lockPath 锁文件路径。
 * @param action 受保护的一次性动作。
 * @param waitMs 等待上限毫秒。
 * @returns 是否由本进程执行了该动作。
 */
export async function withFileLock(
  lockPath: string,
  action: () => Promise<void>,
  waitMs: number = DEFAULT_WAIT_MS,
): Promise<boolean> {
  return serializeInProcess(lockPath, () => acquireAndRun(lockPath, action, waitMs));
}

/**
 * 实际获取文件锁并执行动作（由 {@link withFileLock} 在进程串行化后调用）。
 *
 * @param lockPath 锁文件路径。
 * @param action 受保护的一次性动作。
 * @param waitMs 等待上限毫秒。
 * @returns 是否由本进程执行了该动作。
 */
async function acquireAndRun(
  lockPath: string,
  action: () => Promise<void>,
  waitMs: number,
): Promise<boolean> {
  const deadline = Date.now() + waitMs;
  for (;;) {
    const acquired = await tryAcquire(lockPath);
    if (acquired) {
      try {
        await action();
        return true;
      } finally {
        rmSync(lockPath, { recursive: true, force: true });
      }
    }
    if (Date.now() >= deadline) {
      throw new WorktableError(
        'resource-constraint',
        `等待初始化锁超时（${waitMs}ms）：另一个 worktable 进程正在初始化 dataHome`,
        '稍后重试；若怀疑锁残留，检查持有者 pid 是否存活',
        true,
        { lockPath },
      );
    }
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
}

/**
 * @param dataHome dataHome 绝对路径。
 * @returns 初始化锁路径。
 */
export function initLockPath(dataHome: string): string {
  return join(dataHome, '.worktable-init.lock');
}

/**
 * @param dataHome dataHome 绝对路径。
 * @returns 是否已有 pgdata（= 集群已 initialise 过）。
 */
export function hasCluster(dataHome: string): boolean {
  return existsSync(join(dataHome, 'pgdata', 'PG_VERSION'));
}
