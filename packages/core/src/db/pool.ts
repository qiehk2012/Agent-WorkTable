/**
 * `pg.Pool` 封装（架构 §7.1 / 定稿 §4.4）：连接池参数与会话变量的唯一出口。
 *
 * L1 模块：可依赖 L0（errors）+ 同层 config。
 *
 * 会话参数为什么设在这里：
 * - `statement_timeout=5s`：stdio 会话里一次查询卡死会让宿主以为工具挂了，宁可超时带 db-timeout 错误码；
 * - `idle_in_transaction_session_timeout=30s`：防止忘了提交的事务长期占锁（embedded 单用户也能把自己锁死）。
 */
import { Pool } from 'pg';

/** 连接池大小上限：五宿主各起一个进程，每进程最多 5 条连接。 */
export const POOL_MAX = 5;

/** 单条语句超时（毫秒）。 */
export const STATEMENT_TIMEOUT_MS = 5_000;

/** 事务内空闲超时（毫秒）。 */
export const IDLE_IN_TRANSACTION_TIMEOUT_MS = 30_000;

/**
 * 建立连接池。注意：**不建立连接**（pg 首次 query 才连），
 * 因此「库连不上」的错误延迟到首次 query 才抛——错误由 mapPgError 转成 db-unavailable。
 *
 * @param url 数据库连接串。
 * @returns pg 连接池。
 */
export function createPool(url: string): Pool {
  const pool = new Pool({
    connectionString: url,
    max: POOL_MAX,
    idleTimeoutMillis: 10_000,
    connectionTimeoutMillis: 5_000,
  });
  pool.on('connect', (client) => {
    void client
      .query('SET statement_timeout = $1', [STATEMENT_TIMEOUT_MS])
      .then(() => client.query('SET idle_in_transaction_session_timeout = $1', [
        IDLE_IN_TRANSACTION_TIMEOUT_MS,
      ]))
      .catch(() => {
        // 会话变量设置失败不应让工具失败：超时语义退化为服务端默认
      });
  });
  pool.on('error', () => {
    // 池级错误（如后端关闭空闲连接）必须吞掉，否则未处理的 'error' 事件会让 Node 进程退出
  });
  return pool;
}
