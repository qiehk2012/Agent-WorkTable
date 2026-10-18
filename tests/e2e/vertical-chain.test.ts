/**
 * P0-11 端到端垂直链路（架构 §5.1 T05）：
 * 干净 dataHome → init → MCP stdio 模拟宿主会话（list/new/bind/mount/status）→
 * uiUrl 抓取断言项目与产物 → worktable check 全绿。
 *
 * 这条链就是「用户第一天」：不借助任何预置状态，全部从零开始。
 */
import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { build } from 'esbuild';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const ROOT = process.cwd();
const CLI = join(ROOT, 'packages/core/dist/cli.js');
const MCP_BUNDLE = join(ROOT, 'packages/mcp/dist/mcp.js');

let dataHome: string;
let projectDir: string;
let client: Client | undefined;

beforeAll(async () => {
  dataHome = await mkdtemp(join(tmpdir(), 'worktable-e2e-'));
  projectDir = await mkdtemp(join(tmpdir(), 'worktable-e2e-proj-'));
  await mkdir(join(projectDir, '.worktable', 'artifacts'), { recursive: true });
  await writeFile(
    join(projectDir, '.worktable', 'artifacts', 'final-report.html'),
    '<h1>端到端报告</h1><p>产物内容可访问</p>',
    'utf8',
  );

  // 刷新 bundle（e2e 连构建产物，与真实宿主一致）
  await build({
    entryPoints: [join(ROOT, 'packages/mcp/src/index.ts')],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node20',
    outfile: MCP_BUNDLE,
    sourcemap: true,
    absWorkingDir: ROOT,
    external: ['@embedded-postgres/*'],
    logLevel: 'warning',
  });

  // CLI init（干净 dataHome）
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const run = promisify(execFile);
  const initResult = await run(process.execPath, [CLI, 'init', '--home', dataHome, '--yes'], {
    env: { ...process.env, WORKTABLE_HOME: dataHome },
  });
  expect(initResult.stdout).toContain('初始化完成');

  // MCP 客户端（模拟宿主会话）
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [MCP_BUNDLE],
    env: { ...process.env, WORKTABLE_HOME: dataHome } as Record<string, string>,
  });
  client = new Client({ name: 'e2e-host', version: '0.0.0' });
  await client.connect(transport);
}, 180_000);

afterAll(async () => {
  await client?.close().catch(() => undefined);
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  await promisify(execFile)(process.execPath, [CLI, 'pg', 'stop'], {
    env: { ...process.env, WORKTABLE_HOME: dataHome },
  }).catch(() => undefined);
  await rm(dataHome, { recursive: true, force: true }).catch(() => undefined);
  await rm(projectDir, { recursive: true, force: true }).catch(() => undefined);
});

describe('P0-11 端到端垂直链路', () => {
  it('① MCP 会话内：create → bind → mount → status 全过', async () => {
    const created = await client!.callTool({
      name: 'worktable_create_project',
      arguments: { name: '端到端项目', folder: projectDir, icon: '🚀' },
    });
    const projectId = (created.structuredContent as { project_id: string }).project_id;
    expect(projectId).toMatch(/^prj_/);

    const bound = await client!.callTool({
      name: 'worktable_bind_session',
      arguments: { projectId, host: 'workbuddy', sessionId: 'e2e-session', cwd: projectDir },
    });
    const bindingId = (bound.structuredContent as { bindingId: string }).bindingId;

    const mounted = await client!.callTool({
      name: 'worktable_mount_artifact',
      arguments: {
        projectId,
        paneId: 'pane_main',
        bindingId,
        title: '最终报告',
        type: 'html',
        entry: 'final-report.html',
      },
    });
    expect((mounted.structuredContent as { artifactId: string }).artifactId).toMatch(/^art_/);

    const status = await client!.callTool({ name: 'worktable_status', arguments: {} });
    const snapshot = status.structuredContent as {
      uiUrl: string;
      projects: Array<{ projectId: string; status: string; preview: string | null }>;
    };
    const card = snapshot.projects.find((p) => p.projectId === projectId);
    expect(card?.status).toBe('working');
    expect(card?.preview).toContain('/a/art_');
  });

  it('② 同一数据库换宿主（模拟第二宿主进程）可见完全相同状态', async () => {
    // 第二个 MCP server 进程 = 第二宿主，同一 dataHome
    const secondClient = new Client({ name: 'e2e-host-2', version: '0.0.0' });
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [MCP_BUNDLE],
      env: { ...process.env, WORKTABLE_HOME: dataHome } as Record<string, string>,
    });
    await secondClient.connect(transport);
    try {
      const listing = await secondClient.callTool({ name: 'worktable_list_projects', arguments: {} });
      const payload = listing.structuredContent as { result?: Array<{ name: string; status: string | null }> };
      const projects = Array.isArray(payload.result) ? payload.result : (payload as unknown as Array<{ name: string; status: string | null }>);
      const card = projects.find((p) => p.name === '端到端项目');
      expect(card?.status).toBe('working'); // 第一宿主的绑定，第二宿主原样可见
    } finally {
      await secondClient.close();
    }
  });

  it('③ uiUrl 可访问且产物内容真实可读', async () => {
    const status = await client!.callTool({ name: 'worktable_status', arguments: {} });
    const snapshot = status.structuredContent as {
      uiUrl: string;
      projects: Array<{ preview: string | null }>;
    };
    const preview = snapshot.projects.find((p) => p.preview !== null)?.preview ?? '';

    const response = await fetch(preview);
    expect(response.status).toBe(200);
    expect(await response.text()).toContain('端到端报告');
  });

  it('④ worktable check 全绿（事实源在 Postgres，与宿主配置无关）', async () => {
    const { execFile } = await import('node:child_process');
    const { promisify } = await import('node:util');
    const run = promisify(execFile);
    const check = await run(process.execPath, [CLI, 'check'], {
      env: { ...process.env, WORKTABLE_HOME: dataHome },
    });
    expect(check.stdout).toContain('问题：无');
    expect(check.stdout).toContain('schema：001');
  });
});
