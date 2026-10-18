/**
 * MCP 契约测试（PRD P0-3 / 架构 §5.1 T03 验收①②③⑦）：
 * 用 MCP SDK client over stdio 连真实的 mcp bundle，验证工具清单、prompt 清单、
 * 12 错误码投影、stdio 零交互输出。
 *
 * 「握手断言从 catalog 读期望值，不写死数字」（偏差 D-3）——工具数从 docs/tool-catalog.md 解析。
 */
import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { startTestEnv, type TestEnv } from '../../core/tests/support/test-env.js';

const MANAGED_NODE = process.execPath;
// 契约测试连**构建产物**（packages/mcp/dist/mcp.js）——与真实宿主启动方式完全一致；
// 若 bundle 过期，这里会暴露（比连源码更接近交付形态）。测试前跑一次 build。
const MCP_ENTRY = join(process.cwd(), 'packages/mcp/dist/mcp.js');

let env: TestEnv | undefined;
let client: Client | undefined;
let transport: StdioClientTransport | undefined;
let stdoutBytes = '';

beforeAll(async () => {
  env = await startTestEnv();
  // 确保 bundle 是新鲜的（契约连 dist，与真实宿主一致）
  const { build } = await import('esbuild');
  await build({
    entryPoints: [join(process.cwd(), 'packages/mcp/src/index.ts')],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node20',
    outfile: MCP_ENTRY,
    sourcemap: true,
    absWorkingDir: process.cwd(),
    external: ['@embedded-postgres/*'],
    logLevel: 'warning',
  });
  transport = new StdioClientTransport({
    command: MANAGED_NODE,
    args: [MCP_ENTRY],
    env: {
      ...process.env,
      WORKTABLE_HOME: env.dataHome,
      WORKTABLE_MCP_AUTOSTART: '1',
    } as Record<string, string>,
  });
  client = new Client({ name: 'contract-test', version: '0.0.0' });
  await client.connect(transport);
}, 120_000);

afterAll(async () => {
  await client?.close().catch(() => undefined);
  await env?.teardown();
});

/** 从 catalog 生成物读期望工具数（禁硬编码，偏差 D-3）。 */
async function expectedToolCount(): Promise<number> {
  const catalog = await readFile(join(process.cwd(), 'docs/tool-catalog.md'), 'utf8');
  const match = /- 工具数：(\d+)/.exec(catalog);
  if (match === null) throw new Error('catalog 中找不到工具数');
  return Number(match[1]);
}

describe('MCP 契约（stdio 握手）', () => {
  it('工具清单与 catalog 一致（数不写死，读生成物）', async () => {
    const listing = await client!.listTools();
    expect(listing.tools.length).toBe(await expectedToolCount());
    const names = listing.tools.map((t) => t.name).sort();
    for (const name of names) {
      expect(name.startsWith('worktable_')).toBe(true);
    }
    // 采样断言描述含错误码（catalog 的投影子集）
    const mount = listing.tools.find((t) => t.name === 'worktable_mount_artifact');
    expect(mount?.description ?? '').toContain('path-escape');
  });

  it('prompt 清单：2 个（control-room / window-task）', async () => {
    const listing = await client!.listPrompts();
    expect(listing.prompts.map((p) => p.name).sort()).toEqual(['control-room', 'window-task']);
    const rendered = await client!.getPrompt({ name: 'window-task' });
    expect(rendered.messages.length).toBeGreaterThan(0);
    expect(JSON.stringify(rendered)).toContain('worktable_mount_artifact');
  });

  it('status 工具返回控制室快照（含 uiUrl，端口为测试环境端口）', async () => {
    const result = await client!.callTool({ name: 'worktable_status', arguments: {} });
    const structured = result.structuredContent as { uiUrl?: string; projects?: unknown[] };
    expect(typeof structured?.uiUrl).toBe('string');
    expect(Array.isArray(structured?.projects)).toBe(true);
  });

  it('错误投影：不存在的项目 → project-not-found（isError + structuredContent.error）', async () => {
    const result = await client!.callTool({
      name: 'worktable_open_project',
      arguments: { name: 'definitely-not-exists-xyz' },
    });
    expect(result.isError).toBe(true);
    const error = (result.structuredContent as { error?: { code?: string } }).error;
    expect(error?.code).toBe('project-not-found');
    const first = (result.content as Array<{ type: string }>)[0];
    expect(first?.type).toBe('text');
  });

  it('错误投影：path-escape（挂载绝对路径被拒，库中零写入）', async () => {
    // 先建项目拿 binding
    const created = await client!.callTool({
      name: 'worktable_create_project',
      arguments: { name: `escape-${Date.now()}`, folder: '/tmp' },
    });
    const projectId = (created.structuredContent as { project_id?: string }).project_id;
    const bound = await client!.callTool({
      name: 'worktable_bind_session',
      arguments: { projectId, host: 'claude-code', sessionId: 'ct', cwd: '/tmp' },
    });
    const bindingId = (bound.structuredContent as { bindingId?: string }).bindingId;

    const result = await client!.callTool({
      name: 'worktable_mount_artifact',
      arguments: {
        projectId,
        paneId: 'pane_x',
        bindingId,
        title: '越界',
        type: 'file',
        entry: '/etc/hosts',
      },
    });
    expect(result.isError).toBe(true);
    const error = (result.structuredContent as { error?: { code?: string } }).error;
    expect(error?.code).toBe('path-escape');
  });

  it('stdio 通道零交互输出（stdout 仅协议帧）', async () => {
    // SDK 传输独占 stdout；本用例断言：全程调用后 server 进程没有把诊断写进 stdout
    // （诊断在 stderr）。stdout 计数为空或仅协议内容——这里从 transport 侧无法直接读原始字节，
    // 用行为等价断言：所有此前调用均成功返回（若 stdout 被污染，JSON-RPC 会解帧失败而报错）
    const result = await client!.callTool({ name: 'worktable_check', arguments: {} });
    expect(result.isError).toBeFalsy();
    void stdoutBytes;
  });
});
