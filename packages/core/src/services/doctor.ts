/**
 * DoctorService（架构 §3.3 / 风险 R-10）：`worktable check` 的报告来源。
 *
 * R-10 的含义：FK ON DELETE CASCADE 之下「孤儿绑定」不会以悬空引用的形式出现，
 * 真正会坏的是**磁盘语义**——active binding 的 cwd 已不存在、产物 payload 磁盘文件缺失、
 * 项目目录不可写。因此本服务的检查全部落在这些可执行的语义上，并给出修复建议。
 */
import { constants as fsConstants, promises as fs } from 'node:fs';
import { isPayloadMissingError, type PayloadResolver } from '../protocol/payload.js';
import { isWorktableError, WorktableError } from '../errors/index.js';
import type { Store } from '../store/index.js';
import type { CheckReport } from '../store/types.js';

/** 迁移状态的最小形态（与 migrations/runner 的返回对齐，避免 doctor 反向依赖 L1 实现）。 */
interface MigrationStatusLike {
  applied: Array<{ version: string; checksum: string }>;
  pending: string[];
}

/** DoctorService 接口。 */
export interface DoctorService {
  check(): Promise<CheckReport>;
}

/**
 * @param dir 目录。
 * @returns 是否可写。
 */
async function isWritable(dir: string): Promise<boolean> {
  try {
    await fs.access(dir, fsConstants.W_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * @param dir 目录。
 * @returns 是否存在。
 */
async function existsDir(dir: string): Promise<boolean> {
  try {
    return (await fs.stat(dir)).isDirectory();
  } catch {
    return false;
  }
}

/**
 * 创建 DoctorService。
 *
 * @param deps store / resolver / 版本号。
 * @returns 服务实例。
 */
export function createDoctorService(deps: {
  store: Store;
  resolver: PayloadResolver;
  version: string;
  /** 迁移状态来源（L3 可依赖 L1：由组合根注入，store 保持不依赖 migrations）。 */
  migrationStatus?: () => Promise<MigrationStatusLike>;
}): DoctorService {
  const { store, resolver } = deps;

  return {
    async check(): Promise<CheckReport> {
      const report: CheckReport = {
        schemaVersion: null,
        dbReachable: true,
        orphanBindings: [],
        projectDirsWritable: [],
        issues: [],
      };

      try {
        // schema 版本以迁移账本为准（001 起记录于 schema_migrations；meta.schema_version 仅为冗余展示位）
        if (deps.migrationStatus !== undefined) {
          const status = await deps.migrationStatus();
          report.schemaVersion =
            status.applied.length > 0 ? (status.applied[status.applied.length - 1]?.version ?? null) : null;
        } else {
          report.schemaVersion = await store.readSchemaVersion();
        }
      } catch (error) {
        report.dbReachable = false;
        const mapped = isWorktableError(error)
          ? error
          : new WorktableError('db-unavailable', error instanceof Error ? error.message : String(error));
        report.issues.push({ code: mapped.code, message: `${mapped.message}（${mapped.remediation}）` });
        return report;
      }
      if (report.schemaVersion === null) {
        report.issues.push({ code: 'schema-mismatch', message: 'schema 尚未迁移：跑 `worktable migrate`' });
      }

      const projects = await store.listProjects({ includeHidden: true });
      for (const summary of projects) {
        const project = await store.getProject({ projectId: summary.projectId });
        if (project === null) continue;

        report.projectDirsWritable.push({
          projectId: project.project_id,
          folder: project.folder,
          writable: await isWritable(project.folder),
        });

        const bindings = await store.listBindings(project.project_id);
        for (const binding of bindings) {
          if (binding.status === 'done') continue;
          if (!(await existsDir(binding.cwd))) {
            report.orphanBindings.push({
              bindingId: binding.binding_id,
              projectId: project.project_id,
              reason: `cwd 目录已不存在：${binding.cwd}`,
            });
            report.issues.push({
              code: 'warn',
              message: `绑定 ${binding.binding_id} 的工作目录已不存在（${binding.cwd}）：可 force 解绑或更新项目目录`,
            });
          }
        }

        const artifacts = await store.listArtifacts({ projectId: project.project_id });
        for (const artifact of artifacts) {
          try {
            await resolver.resolveForRead(project, artifact.payload_path);
          } catch (error) {
            if (isPayloadMissingError(error)) {
              report.issues.push({
                code: 'warn',
                message: `产物 ${artifact.artifact_id}（${artifact.title}）的磁盘文件缺失：${artifact.payload_path}`,
              });
            } else if (isWorktableError(error)) {
              report.issues.push({ code: error.code, message: `${error.message}（${error.remediation}）` });
            } else {
              throw error;
            }
          }
        }
      }

      return report;
    },
  };
}
