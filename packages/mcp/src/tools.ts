/**
 * 工具实现（架构 §2.3）：zod 入参校验 + handler，按 name 与 registry 元数据对接。
 *
 * 纪律：handler 只拿 core 句柄，杜绝在 mcp 层私连数据库；
 * 一切失败抛 WorktableError / PayloadMissingError，由 errors.ts 统一投影。
 */
import {
  WorktableError,
  projectId,
  bindingId,
  type WorktableCore,
  type HostId,
  type ArtifactType,
  type BindingStatus,
  type ArtifactStatus,
} from '@worktable/core';
import { z } from 'zod';
import type { ToolContext } from './types.js';

/** 工具实现条目。 */
export interface ToolImplementation {
  name: string;
  inputSchema: z.ZodRawShape;
  handler: (ctx: ToolContext, input: Record<string, unknown>) => Promise<unknown>;
}

const HOSTS = ['dsh', 'hermes', 'workbuddy', 'claude-code', 'codex'] as const;
const BINDING_STATUSES = ['working', 'needs-you', 'done'] as const;
const ARTIFACT_TYPES = ['html', 'markdown', 'image', 'file'] as const;
const ARTIFACT_STATUSES = ['pending', 'mounted', 'locked'] as const;

const paneIdSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z0-9_-]+$/, 'paneId 仅允许 1–64 位字母/数字/下划线/连字符');

/** @param core core 句柄。@returns 工具实现清单。 */
export function buildToolImplementations(core: WorktableCore): ToolImplementation[] {
  void core;
  return [
    {
      name: 'worktable_list_projects',
      inputSchema: { includeHidden: z.boolean().optional() },
      handler: async (ctx, input) =>
        ctx.core.store.listProjects({ includeHidden: input['includeHidden'] === true }),
    },
    {
      name: 'worktable_open_project',
      inputSchema: {
        projectId: z.string().min(1).optional(),
        name: z.string().min(1).optional(),
      },
      handler: async (ctx, input) => {
        const ref =
          input['projectId'] !== undefined
            ? { projectId: String(input['projectId']) }
            : { name: String(input['name'] ?? '') };
        if (ref.projectId === undefined && (input['name'] === undefined || input['name'] === '')) {
          throw new WorktableError('project-not-found', '需要 projectId 或 name 之一');
        }
        const context = await ctx.core.store.getProjectContext(ref);
        if (context === null) {
          throw new WorktableError('project-not-found', `项目不存在：${JSON.stringify(ref)}`);
        }
        return context;
      },
    },
    {
      name: 'worktable_create_project',
      inputSchema: {
        name: z.string().min(1),
        folder: z.string().min(1),
        icon: z.string().optional(),
      },
      handler: async (ctx, input) => {
        const name = String(input['name']);
        const folder = String(input['folder']);
        const stat = await import('node:fs').then((fs) => fs.statSync(folder, { throwIfNoEntry: false }));
        if (stat === undefined || !stat.isDirectory()) {
          throw new WorktableError(
            'resource-constraint',
            `folder 不是已存在的目录：${folder}`,
            '先创建目录再注册项目（mkdir -p），worktable 不代建目录',
          );
        }
        return ctx.core.store.createProject({
          projectId: projectId(name),
          name,
          folder,
          ...(input['icon'] === undefined ? {} : { icon: String(input['icon']) }),
          createdBy: 'agent',
        });
      },
    },
    {
      name: 'worktable_update_project',
      inputSchema: {
        projectId: z.string().min(1),
        name: z.string().optional(),
        icon: z.string().nullable().optional(),
        position: z.number().int().optional(),
        hidden: z.boolean().optional(),
        delete: z.boolean().optional(),
        confirm: z.boolean().optional(),
      },
      handler: async (ctx, input) => {
        if (input['delete'] === true && input['confirm'] !== true) {
          throw new WorktableError(
            'resource-constraint',
            '删除项目需要 confirm=true；注意项目目录本身不会被删除',
          );
        }
        const result = await ctx.core.store.updateProject({
          projectId: String(input['projectId']),
          ...(input['name'] === undefined ? {} : { name: String(input['name']) }),
          ...(input['icon'] === undefined ? {} : { icon: input['icon'] === null ? null : String(input['icon']) }),
          ...(input['position'] === undefined ? {} : { position: Number(input['position']) }),
          ...(input['hidden'] === undefined ? {} : { hidden: input['hidden'] === true }),
          ...(input['delete'] === true ? { delete: true, confirm: true } : {}),
        });
        return result ?? { deleted: true, projectId: input['projectId'] };
      },
    },
    {
      name: 'worktable_bind_session',
      inputSchema: {
        projectId: z.string().min(1),
        host: z.enum(HOSTS),
        sessionId: z.string().min(1),
        cwd: z.string().min(1),
        force: z.boolean().optional(),
      },
      handler: async (ctx, input) => {
        const projectIdValue = String(input['projectId']);
        const host = input['host'] as HostId;
        const sessionId = String(input['sessionId']);
        const cwd = String(input['cwd']);
        return ctx.core.store.bindSession({
          projectId: projectIdValue,
          bindingId: bindingId({ projectId: projectIdValue, host, sessionId, cwd }),
          host,
          sessionId,
          cwd,
          ...(input['force'] === undefined ? {} : { force: input['force'] === true }),
        });
      },
    },
    {
      name: 'worktable_status',
      inputSchema: {},
      handler: async (ctx) => ctx.core.controlRoom.snapshot(),
    },
    {
      name: 'worktable_update_status',
      inputSchema: {
        projectId: z.string().min(1),
        status: z.enum(BINDING_STATUSES),
        note: z.string().nullable().optional(),
        expectedRevision: z.number().int().optional(),
      },
      handler: async (ctx, input) =>
        ctx.core.store.updateStatus({
          projectId: String(input['projectId']),
          status: input['status'] as BindingStatus,
          ...(input['note'] === undefined ? {} : { note: input['note'] === null ? null : String(input['note']) }),
          ...(input['expectedRevision'] === undefined ? {} : { expectedRevision: Number(input['expectedRevision']) }),
        }),
    },
    {
      name: 'worktable_mount_artifact',
      inputSchema: {
        projectId: z.string().min(1),
        paneId: paneIdSchema,
        bindingId: z.string().min(1),
        title: z.string().min(1),
        type: z.enum(ARTIFACT_TYPES),
        entry: z.string().min(1),
        meta: z.record(z.string(), z.unknown()).optional(),
      },
      handler: async (ctx, input) =>
        ctx.core.artifacts.mount({
          projectId: String(input['projectId']),
          paneId: String(input['paneId']),
          bindingId: String(input['bindingId']),
          title: String(input['title']),
          type: input['type'] as ArtifactType,
          entry: String(input['entry']),
          ...(input['meta'] === undefined ? {} : { meta: input['meta'] as Record<string, unknown> }),
        }),
    },
    {
      name: 'worktable_list_artifacts',
      inputSchema: {
        projectId: z.string().min(1),
        status: z.enum(ARTIFACT_STATUSES).optional(),
      },
      handler: async (ctx, input) =>
        ctx.core.store.listArtifacts({
          projectId: String(input['projectId']),
          ...(input['status'] === undefined ? {} : { status: input['status'] as ArtifactStatus }),
        }),
    },
    {
      name: 'worktable_check',
      inputSchema: {},
      handler: async (ctx) => ctx.core.doctor.check(),
    },
  ];
}
