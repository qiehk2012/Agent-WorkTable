/**
 * 产物路径收容（架构 §3.6 / PRD P0-5 ⑥）：把「Agent 给的相对路径」变成「受控的绝对路径」。
 *
 * L1 模块：可依赖 L0（errors）。
 *
 * 五步收容，任一步失败即抛且**库中零写入**：
 * ① entry 必须为非空相对路径，拒绝绝对路径、拒绝任一 `..` 段（先按 POSIX 分隔符规范化）；
 * ② candidate = resolve(base, entry)，base = <project.folder>/.worktable/artifacts；
 * ③ 对 candidate 与其父链做 realpath，与 realpath(base) 比较，拒 symlink 逃逸；
 * ④ 必须为普通文件且可读，否则是「payload 不存在」——
 *    它对应协议层 invalid params + 「先落盘再挂载」，不占 12 错误码（PRD §4.1 备注 5）；
 * ⑤ 通过返回 { absolutePath, storedRef }，storedRef = entry（入库的项目内相对路径）。
 *
 * P1-4 预留：主理人裁决 5 要求「只读降级是加分支不是改主干」，
 * 因此 resolver 是接口，未来 ReadOnlyFallbackResolver 直接换实现。
 */
import { constants as fsConstants, promises as fs } from 'node:fs';
import path from 'node:path';
import { WorktableError } from '../errors/index.js';
import type { Project } from '../store/types.js';

/** 收容结果。 */
export interface ResolvedPayload {
  /** 磁盘绝对路径（realpath 之后） */
  absolutePath: string;
  /** 入库的项目内相对路径（原样保留 entry） */
  storedRef: string;
}

/** Resolver 接口（P1-4 的扩展缝）。 */
export interface PayloadResolver {
  /** 挂载前校验 + 定位；抛 path-escape 或 {@link PayloadMissingError}。 */
  resolveForWrite(project: Project, entry: string): Promise<ResolvedPayload>;
  /** 读取（web 静态路由）校验 + 定位；越界抛 path-escape。 */
  resolveForRead(project: Project, storedRef: string): Promise<string>;
}

/** 产物文件不存在的专用错误：协议层 invalid params，不占 12 错误码。 */
export class PayloadMissingError extends Error {
  readonly entry: string;
  readonly projectId: string;

  constructor(projectId: string, entry: string) {
    super(`产物文件不存在：${entry}（先把文件落盘到项目的 .worktable/artifacts/ 再挂载）`);
    this.name = 'PayloadMissingError';
    this.entry = entry;
    this.projectId = projectId;
  }
}

/** @param error unknown。 @returns 是否为 {@link PayloadMissingError}。 */
export function isPayloadMissingError(error: unknown): error is PayloadMissingError {
  return error instanceof PayloadMissingError;
}

/**
 * @param entry 原始 entry。
 * @returns POSIX 规范化后的 entry。
 */
function normalizeEntry(entry: string): string {
  return entry.split('\\').join('/');
}

/**
 * @param project 项目。
 * @param entry 相对路径。
 * @returns base 目录与候选绝对路径。
 */
function resolveBaseAndCandidate(project: Project, entry: string): { base: string; candidate: string } {
  const base = path.join(project.folder, '.worktable', 'artifacts');
  return { base, candidate: path.resolve(base, normalizeEntry(entry)) };
}

/**
 * 校验 entry 的合法性（步骤 ①②）。
 *
 * @param project 项目。
 * @param entry 相对路径。
 */
function assertEntryShape(project: Project, entry: string): void {
  const normalized = normalizeEntry(entry);
  if (normalized.trim() === '') {
    throw new WorktableError('path-escape', '产物 entry 不能为空', undefined, false, {
      projectId: project.project_id,
    });
  }
  if (path.isAbsolute(normalized) || /^[A-Za-z]:[\\/]/.test(normalized)) {
    throw new WorktableError('path-escape', `产物 entry 必须是项目内相对路径，不允许绝对路径：${entry}`, undefined, false, {
      projectId: project.project_id,
      entry,
    });
  }
  const segments = normalized.split('/');
  if (segments.some((segment) => segment === '..')) {
    throw new WorktableError('path-escape', `产物 entry 不允许包含 ..：${entry}`, undefined, false, {
      projectId: project.project_id,
      entry,
    });
  }
}

/**
 * 校验 realpath 收容（步骤 ③）。
 *
 * @param base base 目录。
 * @param candidate 候选路径。
 * @param project 项目。
 * @param entry 原始 entry。
 * @returns candidate 的 realpath。
 */
async function assertContained(
  base: string,
  candidate: string,
  project: Project,
  entry: string,
): Promise<string> {
  const realBase = await fs.realpath(base).catch(() => null);
  if (realBase === null) {
    // base 目录本身都不存在 = 该项目还没落过任何产物
    throw new PayloadMissingError(project.project_id, entry);
  }
  const realCandidate = await fs.realpath(candidate).catch(() => null);
  if (realCandidate === null) {
    throw new PayloadMissingError(project.project_id, entry);
  }
  if (realCandidate !== realBase && !realCandidate.startsWith(`${realBase}${path.sep}`)) {
    throw new WorktableError('path-escape', `产物路径越出项目目录（symlink 逃逸）：${entry}`, undefined, false, {
      projectId: project.project_id,
      entry,
      resolved: realCandidate,
      base: realBase,
    });
  }
  return realCandidate;
}

/**
 * 校验目标为可读普通文件（步骤 ④）。
 *
 * @param absolutePath realpath 后的绝对路径。
 * @param project 项目。
 * @param entry 原始 entry。
 */
async function assertReadableFile(absolutePath: string, project: Project, entry: string): Promise<void> {
  const stat = await fs.stat(absolutePath).catch(() => null);
  if (stat === null || !stat.isFile()) {
    throw new PayloadMissingError(project.project_id, entry);
  }
  try {
    await fs.access(absolutePath, fsConstants.R_OK);
  } catch {
    throw new PayloadMissingError(project.project_id, entry);
  }
}

/** P0 唯一实现：base = <project.folder>/.worktable/artifacts。 */
export class ProjectDirResolver implements PayloadResolver {
  async resolveForWrite(project: Project, entry: string): Promise<ResolvedPayload> {
    assertEntryShape(project, entry);
    const { base, candidate } = resolveBaseAndCandidate(project, entry);
    const absolutePath = await assertContained(base, candidate, project, entry);
    await assertReadableFile(absolutePath, project, entry);
    return { absolutePath, storedRef: normalizeEntry(entry) };
  }

  async resolveForRead(project: Project, storedRef: string): Promise<string> {
    assertEntryShape(project, storedRef);
    const { base, candidate } = resolveBaseAndCandidate(project, storedRef);
    const absolutePath = await assertContained(base, candidate, project, storedRef);
    await assertReadableFile(absolutePath, project, storedRef);
    return absolutePath;
  }
}

/** @returns P0 resolver 实现。 */
export function createProjectDirResolver(): PayloadResolver {
  return new ProjectDirResolver();
}
