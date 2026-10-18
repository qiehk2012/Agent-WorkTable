/**
 * dataHome 三级解析链（定稿 §4.1）：
 *   ① env `WORKTABLE_HOME`
 *   ② 用户选择记录 `~/.config/worktable/config.json`
 *   ③ 默认 `~/.worktable/`
 *
 * L1 模块：可依赖 L0（errors）。
 *
 * 注意：三级里的「默认」是 dataHome **路径默认**（无害、可发现），
 * 与数据库连接的「默认」不同——后者会静默起 embedded，已被主理人裁决 D-11 禁止。
 */
import { existsSync, promises as fs } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve as resolvePath } from 'node:path';
import type { DataHomeSource } from './types.js';

/** env 变量：显式指定 dataHome。 */
export const ENV_HOME = 'WORKTABLE_HOME';

/** 用户选择记录文件（install.sh / `worktable init` 写入）。 */
const CHOICE_RECORD_RELATIVE = join('.config', 'worktable', 'config.json');

/** 默认 dataHome 相对 ~ 的路径。 */
const DEFAULT_HOME_RELATIVE = '.worktable';

interface ChoiceRecord {
  home?: unknown;
}

/**
 * 解析 dataHome。
 *
 * @param env 环境变量表（默认 process.env，测试可注入）。
 * @returns 绝对路径与生效来源。
 */
export async function resolveDataHome(env: NodeJS.ProcessEnv = process.env): Promise<{
  dataHome: string;
  source: DataHomeSource;
}> {
  const fromEnv = env[ENV_HOME];
  if (typeof fromEnv === 'string' && fromEnv.trim() !== '') {
    return { dataHome: resolvePath(fromEnv.trim()), source: 'env' };
  }

  const recordPath = join(homedir(), CHOICE_RECORD_RELATIVE);
  if (existsSync(recordPath)) {
    try {
      const raw = await fs.readFile(recordPath, 'utf8');
      const parsed: unknown = JSON.parse(raw);
      const home = (parsed as ChoiceRecord | null)?.home;
      if (typeof home === 'string' && home.trim() !== '') {
        return { dataHome: resolvePath(home.trim()), source: 'config-json' };
      }
    } catch {
      // 记录文件损坏：不静默吞掉，也不致命——落到默认由 doctor/check 报告（§7.4 转换点在 CLI/MCP）
    }
  }

  return { dataHome: join(homedir(), DEFAULT_HOME_RELATIVE), source: 'default' };
}

/**
 * 写入用户选择记录（`worktable init --home <dir>` 调用）。
 *
 * @param dataHome 用户选定的绝对路径。
 * @param env 环境变量表。
 */
export async function recordDataHomeChoice(dataHome: string): Promise<string> {
  const recordPath = join(homedir(), CHOICE_RECORD_RELATIVE);
  await fs.mkdir(dirname(recordPath), { recursive: true });
  await fs.writeFile(
    recordPath,
    `${JSON.stringify({ home: resolvePath(dataHome) }, null, 2)}\n`,
    { mode: 0o600, encoding: 'utf8' },
  );
  return recordPath;
}
