/**
 * ID 设计（定稿 §4.3 / 架构 §7.1）：`prj_` / `bnd_` / `art_` / `evt_` + sha256 前 16 hex。
 *
 * L0 模块：无内部依赖。
 *
 * 落地解释（架构假设 A-5）：
 * - 稳定实体（project）用**纯内容寻址**——sha256(name)，且 ID 计算排除 folder（换路径不换身份）；
 * - 事件型实体（binding / artifact）在哈希中加入时间成分，重复操作产生新 ID 而非覆盖，
 *   这样同一会话重复 bind / mount 留下多条记录，而不是互相顶掉。
 */
import { createHash } from 'node:crypto';

const HEX_LENGTH = 16;

/**
 * 计算内容寻址摘要（取 sha256 前 16 位 hex）。
 *
 * @param parts 参与哈希的组成部分。
 * @returns 16 位十六进制摘要。
 */
function digest(...parts: string[]): string {
  return createHash('sha256').update(parts.join('\u0000')).digest('hex').slice(0, HEX_LENGTH);
}

/**
 * 项目 ID：纯内容寻址（只含 name，排除 folder）。
 *
 * @param name 项目名（唯一键）。
 * @returns `prj_<digest>`。
 */
export function projectId(name: string): string {
  return `prj_${digest('project', name.trim())}`;
}

/**
 * 绑定 ID：含时间成分，重复 bind 产生新 ID。
 *
 * @param input projectId / host / sessionId / cwd。
 * @returns `bnd_<digest>`。
 */
export function bindingId(input: {
  projectId: string;
  host: string;
  sessionId: string;
  cwd: string;
  now?: Date;
}): string {
  const now = input.now ?? new Date();
  return `bnd_${digest(
    'binding',
    input.projectId,
    input.host,
    input.sessionId,
    input.cwd,
    String(now.getTime()),
    String(process.pid),
  )}`;
}

/**
 * 产物 ID：含时间成分。
 *
 * @param input projectId / paneId / bindingId / payloadPath。
 * @returns `art_<digest>`。
 */
export function artifactId(input: {
  projectId: string;
  paneId: string;
  bindingId: string;
  payloadPath: string;
  now?: Date;
}): string {
  const now = input.now ?? new Date();
  return `art_${digest(
    'artifact',
    input.projectId,
    input.paneId,
    input.bindingId,
    input.payloadPath,
    String(now.getTime()),
    String(process.pid),
  )}`;
}

/**
 * 事件 ID（events 表 P0 仅预留，ID 生成器随 presents 一起就位）。
 *
 * @param kind 事件类型。
 * @param payload 事件负载。
 * @param now 时间戳。
 * @returns `evt_<digest>`。
 */
export function eventId(kind: string, payload: unknown, now: Date = new Date()): string {
  return `evt_${digest('event', kind, JSON.stringify(payload ?? null), String(now.getTime()))}`;
}
