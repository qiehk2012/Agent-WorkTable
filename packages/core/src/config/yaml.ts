/**
 * config.yaml 的最小结构化读写（0600 权限，原子写）。
 *
 * L1 模块：可依赖 L0（errors）。
 * 用 `yaml` 包而非手写解析：五宿主配置 schema 漂移是已列风险（R-7），
 * 结构化解析 + 枚举 key 复验是护栏，这里对自己的配置文件同样适用。
 */
import { existsSync, mkdirSync, promises as fs } from 'node:fs';
import { dirname, resolve as resolvePath } from 'node:path';
import { stringify as stringifyYaml } from 'yaml';
import { WorktableError } from '../errors/index.js';
import type { HomeConfigFile } from './types.js';

/**
 * 读 config.yaml。文件不存在返回 null（= 未初始化，由调用方决定是否转 setup-required）。
 *
 * @param path config.yaml 绝对路径。
 * @returns 解析结果；不存在时 null。
 */
export async function readConfigFile(path: string): Promise<HomeConfigFile | null> {
  if (!existsSync(path)) return null;
  const raw = await fs.readFile(path, 'utf8');
  // 延迟导入 parse：只在确实有文件时才付出解析成本
  const { parse } = await import('yaml');
  const parsed: unknown = parse(raw);
  if (typeof parsed !== 'object' || parsed === null) {
    throw new WorktableError('schema-mismatch', `配置文件格式非法：${path}`, undefined, false, { path });
  }
  return parsed as HomeConfigFile;
}

/**
 * 原子写 config.yaml（tmp + rename，0600）。
 *
 * @param path config.yaml 绝对路径。
 * @param config 待写入的完整配置。
 */
export async function writeConfigFile(path: string, config: HomeConfigFile): Promise<void> {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  await fs.writeFile(tmp, stringifyYaml(config), { mode: 0o600, encoding: 'utf8' });
  await fs.rename(tmp, path);
  await fs.chmod(path, 0o600);
}

/**
 * 校验并补齐最小 schema，缺字段补默认值。
 *
 * @param config 原始解析结果。
 * @param dataHome dataHome 绝对路径。
 * @returns 规范化的配置。
 */
export function normalizeConfig(config: HomeConfigFile, dataHome: string): HomeConfigFile {
  const mode = config?.database?.mode === 'external' ? 'external' : 'embedded';
  const url = typeof config?.database?.url === 'string' ? config.database.url : undefined;
  const port = typeof config?.web?.port === 'number' ? config.web.port : DEFAULT_WEB_PORT;
  const history = Array.isArray(config?.home?.history) ? config.home.history : [];
  return {
    database: { mode, ...(url === undefined ? {} : { url }) },
    web: { port },
    home: { path: resolvePath(dataHome), history },
  };
}

/** L1.5 默认端口（主理人裁决 1：避开 embedded PG 的 55432）。 */
export const DEFAULT_WEB_PORT = 55433;
/** embedded PG 默认端口（避开用户自装 Postgres 的 5432）。 */
export const DEFAULT_PG_PORT = 55432;
