/**
 * projects CRUD（PRD P0-1 / P0-10）。
 *
 * 约定：
 * - `name` 唯一键冲突由数据库约束保证，错误经 {@link mapPgError} 投影为 duplicate-project；
 * - `delete` 必须带 `confirm: true`，级联清零由 FK ON DELETE CASCADE 完成，**磁盘目录不动**（PRD P0-3 ④）。
 */
import type { Pool } from 'pg';
import { WorktableError, mapPgError } from '../errors/index.js';
import type { Project, ProjectRef, ProjectSummary, BindingStatus, HostId } from './types.js';

/** 创建项目入参。 */
export interface CreateProjectInput {
  name: string;
  folder: string;
  icon?: string | null;
  projectId: string;
  createdBy: string;
  position?: number;
}

/** 更新项目入参。 */
export interface UpdateProjectInput {
  projectId: string;
  name?: string;
  icon?: string | null;
  position?: number;
  hidden?: boolean;
  delete?: boolean;
  confirm?: boolean;
}

/** list 选项。 */
export interface ListProjectsOptions {
  includeHidden?: boolean;
}

/**
 * @param pool 连接池。
 * @param input 创建参数。
 * @returns 新项目。
 */
export async function createProject(pool: Pool, input: CreateProjectInput): Promise<Project> {
  const position =
    input.position ??
    ((await pool.query('SELECT COALESCE(MAX(position), 0) + 1 AS next FROM projects')).rows[0] as {
      next: number;
    }).next;
  try {
    const { rows } = await pool.query(
      `INSERT INTO projects (project_id, name, icon, folder, position, hidden, created_by)
       VALUES ($1, $2, $3, $4, $5, false, $6)
       RETURNING project_id, name, icon, folder, position, hidden, created_at, created_by`,
      [input.projectId, input.name, input.icon ?? null, input.folder, position, input.createdBy],
    );
    return rows[0] as Project;
  } catch (error) {
    const mapped = mapPgError(error);
    throw mapped ?? error;
  }
}

/**
 * @param pool 连接池。
 * @param ref 项目引用。
 * @returns 项目；不存在 null。
 */
export async function getProject(pool: Pool, ref: ProjectRef): Promise<Project | null> {
  const { rows } = await pool.query(
    `SELECT project_id, name, icon, folder, position, hidden, created_at, created_by
       FROM projects WHERE project_id = $1 OR name = $2 LIMIT 1`,
    ['projectId' in ref ? ref.projectId : null, 'name' in ref ? ref.name : null],
  );
  return (rows[0] as Project | undefined) ?? null;
}

/**
 * @param pool 连接池。
 * @param options list 选项。
 * @returns 项目概览列表（含 active binding 三态与待处理产物数）。
 */
export async function listProjects(
  pool: Pool,
  options: ListProjectsOptions = {},
): Promise<ProjectSummary[]> {
  const { rows } = await pool.query(
    `SELECT p.project_id, p.name, p.icon, p.position, p.hidden,
            b.status, b.host, b.cwd, b.updated_at,
            (SELECT COUNT(*) FROM artifacts a
              WHERE a.project_id = p.project_id AND a.status <> 'mounted') AS pending_artifacts
       FROM projects p
       LEFT JOIN bindings b ON b.project_id = p.project_id AND b.status <> 'done'
       WHERE ($1::boolean IS TRUE OR p.hidden = false)
       ORDER BY p.position ASC, p.name ASC`,
    [options.includeHidden === true],
  );
  return (rows as Array<Record<string, unknown>>).map((row) => ({
    projectId: String(row['project_id']),
    name: String(row['name']),
    icon: (row['icon'] as string | null) ?? null,
    position: Number(row['position']),
    hidden: Boolean(row['hidden']),
    status: (row['status'] as BindingStatus | null) ?? null,
    host: (row['host'] as HostId | null) ?? null,
    cwd: (row['cwd'] as string | null) ?? null,
    pendingArtifacts: Number(row['pending_artifacts'] ?? 0),
    lastActivityAt: row['updated_at'] === undefined || row['updated_at'] === null
      ? null
      : (row['updated_at'] as Date),
  }));
}

/**
 * @param pool 连接池。
 * @param input 更新参数。
 * @returns 更新后的项目；删除时返回 null（行已不存在）。
 */
export async function updateProject(
  pool: Pool,
  input: UpdateProjectInput,
): Promise<Project | null> {
  if (input.delete === true) {
    if (input.confirm !== true) {
      // 删除是破坏性操作：缺 confirm 直接拒绝，不受 Providing lineage 影响
      throw new WorktableError(
        'resource-constraint',
        '删除项目需要 confirm=true',
        '确认后重发：update_project({ projectId, delete: true, confirm: true })；注意项目目录本身不会被删除',
        false,
        { projectId: input.projectId },
      );
    }
    try {
      await pool.query('DELETE FROM projects WHERE project_id = $1', [input.projectId]);
      return null;
    } catch (error) {
      const mapped = mapPgError(error);
      throw mapped ?? error;
    }
  }

  const before = await getProject(pool, { projectId: input.projectId });
  if (before === null) {
    throw new WorktableError('project-not-found', `项目不存在：${input.projectId}`, undefined, false, {
      projectId: input.projectId,
    });
  }

  try {
    const { rows } = await pool.query(
      `UPDATE projects SET
         name = COALESCE($2, name),
         icon = CASE WHEN $3::boolean IS TRUE THEN NULL ELSE COALESCE($4, icon) END,
         position = COALESCE($5, position),
         hidden = COALESCE($6, hidden)
       WHERE project_id = $1
       RETURNING project_id, name, icon, folder, position, hidden, created_at, created_by`,
      [
        input.projectId,
        input.name ?? null,
        input.icon === null,
        input.icon ?? null,
        input.position ?? null,
        input.hidden ?? null,
      ],
    );
    return (rows[0] as Project | undefined) ?? null;
  } catch (error) {
    const mapped = mapPgError(error);
    throw mapped ?? error;
  }
}
