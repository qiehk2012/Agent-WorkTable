/**
 * 数据库连接三级解析链（定稿 §4.1 + 主理人裁决 D-11）：
 *   ① env `WORKTABLE_DATABASE_URL`
 *   ② `<dataHome>/config.yaml`（含 mode 声明）
 *   ③ **无配置 → `setup-required` + 候选清单，不静默起 embedded**
 *
 * 「embedded 默认」仅在 ② 声明 `mode: embedded` 时作为 **URL 缺省值** 生效
 * （unix socket 优先回落 127.0.0.1:55432），它永远不是「什么都没配」的兜底。
 */
import { statSync } from 'node:fs';
import { join } from 'node:path';
import { DEFAULT_PG_PORT, readConfigFile } from './yaml.js';
import type { DatabaseResolution } from './types.js';

/** env 变量：显式数据库连接串。 */
export const ENV_DATABASE_URL = 'WORKTABLE_DATABASE_URL';

/** @param dataHome dataHome 绝对路径。 @returns config.yaml 绝对路径。 */
export function configPath(dataHome: string): string {
  return join(dataHome, 'config.yaml');
}

/**
 * embedded 模式的默认连接串。
 *
 * socketDir 存在时用 unix socket（更高性能、无端口占用），否则回落 TCP 127.0.0.1:55432。
 *
 * @param dataHome dataHome 绝对路径。
 * @returns 连接串。
 */
export function embeddedDefaultUrl(dataHome: string): string {
  const socketDir = join(dataHome, 'pgdata', 'socket');
  return existsSyncDir(socketDir)
    ? `postgres:///worktable?host=${encodeURIComponent(socketDir)}`
    : `postgres://postgres:postgres@127.0.0.1:${DEFAULT_PG_PORT}/worktable`;
}

/**
 * @param dir 目录路径。
 * @returns 是否为已存在目录。
 */
function existsSyncDir(dir: string): boolean {
  try {
    return statSync(dir).isDirectory();
  } catch {
    return false;
  }
}

/** setup-required 时给 Agent 转述的候选清单（stdio 不能弹交互，候选由调用方呈现）。 */
function candidates(dataHome: string): string[] {
  return [
    `embedded：本地嵌入式 Postgres（数据 ${dataHome}）`,
    'external：外部 Postgres，提供连接串 postgresql://user:pass@host:5432/db',
  ];
}

/**
 * 解析数据库连接。
 *
 * @param dataHome dataHome 绝对路径。
 * @param env 环境变量表。
 * @returns 解析结果（ready 或 setup-required）。
 */
export async function resolveDatabase(
  dataHome: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<DatabaseResolution> {
  const fromEnv = env[ENV_DATABASE_URL];
  if (typeof fromEnv === 'string' && fromEnv.trim() !== '') {
    return { kind: 'ready', url: fromEnv.trim(), mode: 'external', source: 'env' };
  }

  const config = await readConfigFile(configPath(dataHome));
  if (config === null) {
    return { kind: 'setup-required', candidates: candidates(dataHome) };
  }

  const mode = config.database?.mode === 'external' ? 'external' : 'embedded';
  const declared = typeof config.database?.url === 'string' ? config.database.url : undefined;
  if (declared !== undefined && declared.trim() !== '') {
    return { kind: 'ready', url: declared.trim(), mode, source: 'config-yaml' };
  }
  if (mode === 'external') {
    // 声明 external 却没给 url —— 这是配置残缺，明确报错而不是悄悄用 embedded
    return { kind: 'setup-required', candidates: candidates(dataHome) };
  }
  return {
    kind: 'ready',
    url: embeddedDefaultUrl(dataHome),
    mode: 'embedded',
    source: 'embedded-default',
  };
}
