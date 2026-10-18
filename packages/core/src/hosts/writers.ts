/**
 * 三个结构化写入器（json / yaml / toml）+ 事务写入器（定稿 §10）。
 *
 * 事务时序：已有配置 → 复制 `<path>.worktable.backup`（已有备份绝不覆盖）→
 * parse + mergeEntry + serialize → 原子写（tmp + rename，0600）→ readback 复验 →
 * 不一致立即从备份回滚并抛错。**绝不静默损坏用户配置**（主理人裁决 2 护栏）。
 */
import { copyFile, constants as fsConstants, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname } from 'node:path';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { parse as parseToml, stringify as stringifyToml } from 'smol-toml';
import {
  HostConfigParseError,
  HostWriteError,
  type HostConfigDocument,
  type HostConfigWriter,
  type McpServerEntry,
  type TransactionalWriteResult,
} from './types.js';

/**
 * JSON 写入器（Claude Code `~/.claude.json` 顶层 mcpServers / WorkBuddy `~/.workbuddy/mcp.json`）。
 *
 * @param hostId 宿主。
 * @param configPathFn 配置路径函数。
 * @param mcpServersKey mcpServers 所在顶层 key（两家同名）。
 * @returns 写入器。
 */
export function createJsonWriter(
  hostId: HostConfigWriter['hostId'],
  configPathFn: (homeDir: string) => string,
  mcpServersKey = 'mcpServers',
): HostConfigWriter {
  return {
    hostId,
    format: 'json',
    configPath: configPathFn,
    skillsPath: () => null,
    parse(content: string): HostConfigDocument {
      try {
        const parsed: unknown = JSON.parse(content === '' ? '{}' : content);
        if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
          throw new Error('顶层不是 JSON 对象');
        }
        return parsed as HostConfigDocument;
      } catch (error) {
        throw new HostConfigParseError(hostId, 'inline', error);
      }
    },
    serialize(doc: HostConfigDocument): string {
      return `${JSON.stringify(doc, null, 2)}\n`;
    },
    mergeEntry(doc, serverKey, entry) {
      const servers = { ...((doc[mcpServersKey] as HostConfigDocument | undefined) ?? {}) };
      servers[serverKey] = { ...entry };
      return { ...doc, [mcpServersKey]: servers };
    },
    verify(doc, serverKey) {
      const servers = doc[mcpServersKey];
      if (typeof servers !== 'object' || servers === null) return false;
      const entry = (servers as HostConfigDocument)[serverKey];
      return typeof entry === 'object' && entry !== null && 'command' in entry;
    },
  };
}

/**
 * YAML 写入器（Hermes `~/.hermes/config.yaml` 的 mcp_servers）。
 *
 * @param configPathFn 配置路径函数。
 * @returns 写入器。
 */
export function createYamlWriter(configPathFn: (homeDir: string) => string): HostConfigWriter {
  return {
    hostId: 'hermes',
    format: 'yaml',
    configPath: configPathFn,
    skillsPath: () => null,
    parse(content: string): HostConfigDocument {
      try {
        const parsed: unknown = parseYaml(content === '' ? '{}' : content);
        if (typeof parsed !== 'object' || parsed === null) {
          throw new Error('顶层不是映射');
        }
        return parsed as HostConfigDocument;
      } catch (error) {
        throw new HostConfigParseError('hermes', 'inline', error);
      }
    },
    serialize(doc: HostConfigDocument): string {
      return stringifyYaml(doc);
    },
    mergeEntry(doc, serverKey, entry) {
      const servers = { ...((doc['mcp_servers'] as HostConfigDocument | undefined) ?? {}) };
      servers[serverKey] = { ...entry };
      return { ...doc, mcp_servers: servers };
    },
    verify(doc, serverKey) {
      const servers = doc['mcp_servers'];
      if (typeof servers !== 'object' || servers === null) return false;
      const entry = (servers as HostConfigDocument)[serverKey];
      return typeof entry === 'object' && entry !== null && 'command' in entry;
    },
  };
}

/**
 * TOML 写入器（Codex `~/.codex/config.toml` 的 [mcp_servers.worktable]）。
 *
 * @param configPathFn 配置路径函数。
 * @returns 写入器。
 */
export function createTomlWriter(configPathFn: (homeDir: string) => string): HostConfigWriter {
  return {
    hostId: 'codex',
    format: 'toml',
    configPath: configPathFn,
    skillsPath: () => null,
    parse(content: string): HostConfigDocument {
      try {
        const parsed: unknown = parseToml(content === '' ? '' : content);
        if (typeof parsed !== 'object' || parsed === null) {
          throw new Error('顶层不是表');
        }
        return parsed as HostConfigDocument;
      } catch (error) {
        throw new HostConfigParseError('codex', 'inline', error);
      }
    },
    serialize(doc: HostConfigDocument): string {
      return stringifyToml(doc);
    },
    mergeEntry(doc, serverKey, entry) {
      const servers = { ...((doc['mcp_servers'] as HostConfigDocument | undefined) ?? {}) };
      // TOML 值类型有限：env 记录一律转字符串
      servers[serverKey] = {
        command: entry.command,
        args: [...entry.args],
        ...(entry.env === undefined ? {} : { env: toStringValues(entry.env) }),
      };
      return { ...doc, mcp_servers: servers };
    },
    verify(doc, serverKey) {
      const servers = doc['mcp_servers'];
      if (typeof servers !== 'object' || servers === null) return false;
      const entry = (servers as HostConfigDocument)[serverKey];
      return typeof entry === 'object' && entry !== null && 'command' in entry;
    },
  };
}

/**
 * @param env env 记录。
 * @returns 全字符串化后的记录。
 */
function toStringValues(env: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) out[key] = String(value);
  return out;
}

/** 事务写入器选项。 */
export interface TransactionalWriteOptions {
  homeDir: string;
  serverKey: string;
  entry: McpServerEntry;
}

/**
 * 事务式写入（备份 → 合并 → 原子写 → readback 复验 → 失败回滚）。
 *
 * @param writer 宿主写入器。
 * @param options 写入选项。
 * @returns 写入结果。
 */
export async function writeHostConfig(
  writer: HostConfigWriter,
  options: TransactionalWriteOptions,
): Promise<TransactionalWriteResult> {
  const path = writer.configPath(options.homeDir);
  const backupPath = `${path}.worktable.backup`;
  const existed = existsSync(path);

  await mkdir(dirname(path), { recursive: true });

  // ① 备份（已有备份绝不覆盖 —— 保留用户最早的原始状态）
  if (existed && !existsSync(backupPath)) {
    await copyFile(path, backupPath);
  }

  // ② 解析现有配置（失败 → 结构化告警，走模板路线，由调用方决定）
  const original = existed ? await readFile(path, 'utf8') : '';
  let doc: HostConfigDocument;
  try {
    doc = writer.parse(original);
  } catch (error) {
    throw error; // HostConfigParseError 由调用方捕获降级
  }

  // ③ 合并 + 原子写
  const merged = writer.mergeEntry(doc, options.serverKey, options.entry);
  const serialized = writer.serialize(merged);
  const tmp = `${path}.worktable.tmp`;
  await writeFile(tmp, serialized, { mode: 0o600, encoding: 'utf8' });
  await rename(tmp, path);

  // ④ readback 复验（解析后枚举 key，禁 grep）
  try {
    const readBack = await readFile(path, 'utf8');
    const reparsed = writer.parse(readBack);
    if (!writer.verify(reparsed, options.serverKey)) {
      throw new HostWriteError('host-unsupported', `复验失败：${path} 中未找到 ${options.serverKey}`);
    }
    return { path, backupPath: existed ? backupPath : null, verified: true, rolledBack: false };
  } catch (error) {
    // ⑤ 回滚（保留备份不动）
    if (existed) {
      await copyFile(backupPath, path).catch(() => undefined);
    } else {
      await writeFile(path, original, { encoding: 'utf8' }).catch(() => undefined);
    }
    const message = error instanceof Error ? error.message : String(error);
    throw new HostWriteError('host-unsupported', `写入后复验失败，已回滚：${message}`, { path });
  }
}

export { fsConstants };
