/**
 * MCP 工具/prompt 元数据（架构 §3.4）：catalog 与 SKILL.md 工具数的唯一数据源。
 *
 * 本文件必须是**纯数据**：不 import zod / @worktable/core / 任何运行时依赖——
 * scripts/gen-catalog.mjs 会直接 require 它生成 docs/tool-catalog.md，
 * 混入运行时依赖会把 embedded-postgres 的平台二进制拖进构建链（T03 实测踩坑）。
 * handler 的实现在 tools/*.ts，按 name 与本表对接。
 */
import type { ErrorCode } from './error-codes.js';

/** 工具元数据。 */
export interface ToolMeta {
  name: string;
  title: string;
  description: string;
  /** JSON Schema 形态的入参说明（catalog 展示用；真正的 zod 校验在 tools/*.ts） */
  inputHint?: string;
  errorCodes: readonly ErrorCode[];
}

/** prompt 元数据（主理人裁决 4：静态模板锁 P0）。 */
export interface PromptMeta {
  name: string;
  title: string;
  description: string;
}

/** 12 码在 mcp 层的镜像类型：避免元数据文件反向依赖 core（保持纯数据）。 */
export type { ErrorCode } from './error-codes.js';

/**
 * P0 十个工具（PRD §4.1；invalid params 为协议级，不占 12 码）。
 */
export const TOOL_REGISTRY: readonly ToolMeta[] = [
  {
    name: 'worktable_list_projects',
    title: '项目列表',
    description: '列出全部项目（含绑定三态、宿主、待挂载数）。控制室网格的数据来源。',
    inputHint: 'includeHidden?: boolean',
    errorCodes: ['setup-required', 'db-unavailable', 'schema-mismatch'],
  },
  {
    name: 'worktable_open_project',
    title: '打开项目上下文',
    description: '取项目完整上下文：项目信息 + 绑定历史 + 产物清单。会话开始时的第一步。',
    inputHint: 'ref: { projectId } | { name }',
    errorCodes: ['project-not-found', 'setup-required', 'db-unavailable'],
  },
  {
    name: 'worktable_create_project',
    title: '创建项目',
    description: '注册新项目。folder 必须是已存在的目录（先建目录再注册）。',
    inputHint: 'name, folder, icon?',
    errorCodes: ['duplicate-project', 'setup-required', 'db-unavailable'],
  },
  {
    name: 'worktable_update_project',
    title: '更新项目',
    description: '改名/图标/排序/隐藏；delete 需 confirm=true（级联清库但磁盘目录不动）。',
    inputHint: 'projectId, name?, icon?, position?, hidden?, delete?, confirm?',
    errorCodes: ['project-not-found', 'duplicate-project', 'setup-required', 'db-unavailable'],
  },
  {
    name: 'worktable_bind_session',
    title: '绑定会话',
    description: '把当前宿主会话绑到项目（一项目一活动绑定）。冲突时先解绑或 force 顶替。',
    inputHint: 'projectId, host, sessionId, cwd, force?',
    errorCodes: ['binding-conflict', 'project-not-found', 'db-conflict', 'setup-required', 'db-unavailable'],
  },
  {
    name: 'worktable_status',
    title: '控制室状态',
    description: '零模型调用本地聚合：全部项目卡片 + uiUrl（浏览器打开即控制室）。',
    errorCodes: ['setup-required', 'db-unavailable'],
  },
  {
    name: 'worktable_update_status',
    title: '更新绑定状态',
    description: 'working / needs-you / done 三态推进；带 expectedRevision 做乐观并发。',
    inputHint: 'projectId, status, note?, expectedRevision?',
    errorCodes: ['revision-conflict', 'project-not-found', 'setup-required', 'db-unavailable'],
  },
  {
    name: 'worktable_mount_artifact',
    title: '挂载产物',
    description: '把已落盘的产物挂到项目的窗格。entry 为项目内相对路径（先落盘再挂载）。',
    inputHint: 'projectId, paneId, bindingId, title, type, entry, meta?',
    errorCodes: ['path-escape', 'project-not-found', 'db-conflict', 'setup-required', 'db-unavailable'],
  },
  {
    name: 'worktable_list_artifacts',
    title: '产物列表',
    description: '列出项目产物（可按状态过滤）。',
    inputHint: 'projectId, status?',
    errorCodes: ['project-not-found', 'setup-required', 'db-unavailable'],
  },
  {
    name: 'worktable_check',
    title: '体检',
    description: '数据库/schema/目录可写/产物文件在盘 一页诊断。',
    errorCodes: ['db-unavailable', 'setup-required'],
  },
];

export const PROMPT_REGISTRY: readonly PromptMeta[] = [
  {
    name: 'control-room',
    title: '控制室渲染',
    description: '把 worktable_status 的结果渲染为当前宿主可用的形态（CLI 宿主输出 Markdown 表格）。',
  },
  {
    name: 'window-task',
    title: '标准窗口任务流',
    description: 'open_project → 干活 → mount_artifact → update_status 的四步纪律。',
  },
];
