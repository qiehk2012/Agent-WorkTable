export {
  resolveDataHome,
  recordDataHomeChoice,
  ENV_HOME,
} from './dataHome.js';
export {
  resolveDatabase,
  embeddedDefaultUrl,
  configPath,
  ENV_DATABASE_URL,
} from './database.js';
export {
  readConfigFile,
  writeConfigFile,
  normalizeConfig,
  DEFAULT_WEB_PORT,
  DEFAULT_PG_PORT,
} from './yaml.js';
export type {
  DataHomeSource,
  DatabaseMode,
  DatabaseResolution,
  DatabaseSource,
  HomeConfigFile,
  ResolvedConfig,
} from './types.js';
export { actorOf } from './types.js';

/** env 变量：L1.5 端口覆盖。 */
export const ENV_WEB_PORT = 'WORKTABLE_WEB_PORT';

// resolveWebPort 直接消费 yaml/database 的内部函数（不经 barrel 转售，避免循环）
import { readConfigFile as readHomeConfig, DEFAULT_WEB_PORT as FALLBACK_WEB_PORT } from './yaml.js';
import { configPath as homeConfigPath } from './database.js';

/**
 * L1.5 端口三级解析：env `WORKTABLE_WEB_PORT` > config.yaml 的 web.port > 55433。
 *
 * @param dataHome dataHome 绝对路径。
 * @param env 环境变量表。
 * @returns 端口号。
 */
export async function resolveWebPort(
  dataHome: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<number> {
  const fromEnv = env[ENV_WEB_PORT];
  if (typeof fromEnv === 'string' && fromEnv.trim() !== '') {
    const parsed = Number(fromEnv.trim());
    if (Number.isInteger(parsed) && parsed > 0 && parsed < 65536) return parsed;
  }
  const config = await readHomeConfig(homeConfigPath(dataHome));
  const declared = config?.web?.port;
  if (typeof declared === 'number' && Number.isInteger(declared) && declared > 0 && declared < 65536) {
    return declared;
  }
  return FALLBACK_WEB_PORT;
}
