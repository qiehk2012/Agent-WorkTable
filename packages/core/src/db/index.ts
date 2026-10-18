/**
 * 连接总入口（L1）：把「配置解析 → 拉起 embedded 集群 → 建池」串成一条路径。
 *
 * 顺序很重要：
 * 1. 先解析 dataHome（三级链），再解析数据库连接（三级链）；
 * 2. 未配置时**立刻**抛 setup-required（主理人裁决 D-11：不静默起 embedded）；
 * 3. embedded 模式的拉起动作跑在文件锁内（架构 R-5）：五宿主同时启动只有一个去做 init，
 *    其余进程等到端口可连即继续，避免并发 initialise 把 pgdata 写坏。
 */
import type { Pool } from 'pg';
import { WorktableError } from '../errors/index.js';
import { resolveDataHome, resolveDatabase } from '../config/index.js';
import { DEFAULT_PG_PORT } from '../config/yaml.js';
import { createPool } from './pool.js';
import { startCluster, type ClusterOptions } from './embedded.js';
import { initLockPath, withFileLock } from './lock.js';

/** 打开连接所需的信息。 */
export interface OpenedConnection {
  pool: Pool;
  mode: 'embedded' | 'external';
  url: string;
  dataHome: string;
}

/**
 * 在文件锁保护下确保 embedded 集群可用。
 *
 * @param dataHome dataHome 绝对路径。
 * @param port 端口。
 */
export async function ensureCluster(dataHome: string, port: number): Promise<void> {
  const options: ClusterOptions = { dataHome, port };
  await withFileLock(initLockPath(dataHome), async () => {
    await startCluster(options);
  });
}

/**
 * 从连接串里取端口；取不到返回 null（调用方回落默认端口）。
 *
 * @param url 数据库连接串。
 * @returns 端口号或 null。
 */
export function portFromUrl(url: string): number | null {
  const matched = /:(\d{2,5})(?:\/|$|\?)/.exec(url);
  if (matched === null) return null;
  const port = Number(matched[1]);
  return Number.isInteger(port) && port > 0 && port < 65536 ? port : null;
}

/**
 * 解析配置并建立连接池。
 *
 * @param env 环境变量表（测试可注入）。
 * @returns 已就绪的连接；未配置时抛 setup-required（带候选清单，供 Agent 转述）。
 */
export async function openConnection(
  env: NodeJS.ProcessEnv = process.env,
): Promise<OpenedConnection> {
  const { dataHome } = await resolveDataHome(env);
  const database = await resolveDatabase(dataHome, env);

  if (database.kind === 'setup-required') {
    throw new WorktableError(
      'setup-required',
      'worktable 尚未初始化：未找到数据库连接配置',
      '跑 `worktable init` 选择数据位置（stdio 不能弹交互，候选由 Agent 转述）',
      false,
      { candidates: database.candidates, dataHome },
    );
  }

  if (database.mode === 'embedded') {
    // 端口以连接串为准（测试/自定义部署可换端口），缺省才是 embedded 默认 55432
    await ensureCluster(dataHome, portFromUrl(database.url) ?? DEFAULT_PG_PORT);
  }

  return {
    pool: createPool(database.url),
    mode: database.mode,
    url: database.url,
    dataHome,
  };
}
