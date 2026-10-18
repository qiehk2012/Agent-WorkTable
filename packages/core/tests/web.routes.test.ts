/**
 * L1.5 web 路由测试（PRD P0-5 / 架构 §5.1 T03 验收⑤）：
 * 真实起 server + fetch 断言（绑回环、CSP、卡片字段、产物分发、sandbox）。
 */
import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createWorktable, type WorktableCore } from '../src/index.js';
import { runMigrations } from '../src/migrations/index.js';
import { projectId, bindingId } from '../src/ids.js';
import { configPath, normalizeConfig, writeConfigFile, DEFAULT_WEB_PORT } from '../src/config/index.js';
import type { WebHandle } from '../src/web/server.js';

let dataHome: string;
let core: WorktableCore;
let web: WebHandle;
let projectDir: string;
let createdProjectId = '';
let boundBindingId = '';

beforeAll(async () => {
  dataHome = await mkdtemp(join(tmpdir(), 'worktable-web-'));
  const port = 55_433;
  await writeConfigFile(
    configPath(dataHome),
    normalizeConfig(
      {
        database: { mode: 'embedded' },
        web: { port },
        home: { path: dataHome, history: [] },
      },
      dataHome,
    ),
  );
  core = await createWorktable({ WORKTABLE_HOME: dataHome, WORKTABLE_WEB_PORT: String(port) });
  await runMigrations(core.store.tx, core.store.ledger);

  // 造一个项目 + 产物
  projectDir = await mkdtemp(join(tmpdir(), 'worktable-web-proj-'));
  const artifactsDir = join(projectDir, '.worktable', 'artifacts');
  await mkdir(artifactsDir, { recursive: true });
  await writeFile(join(artifactsDir, 'demo.html'), '<h1>演示产物</h1>', 'utf8');

  const name = `web-${Date.now()}`;
  createdProjectId = projectId(name);
  await core.store.createProject({
    projectId: createdProjectId,
    name,
    folder: projectDir,
    createdBy: 'cli',
  });
  const bound = await core.store.bindSession({
    projectId: createdProjectId,
    bindingId: bindingId({ projectId: createdProjectId, host: 'claude-code', sessionId: 'w1', cwd: projectDir }),
    host: 'claude-code',
    sessionId: 'w1',
    cwd: projectDir,
  });
  boundBindingId = bound.bindingId;
  const mounted = await core.artifacts.mount({
    projectId: createdProjectId,
    paneId: 'pane_01',
    bindingId: boundBindingId,
    title: '演示',
    type: 'html',
    entry: 'demo.html',
  });
  expect(mounted.artifactId).toMatch(/^art_/);

  web = await core.startWeb();
}, 120_000);

afterAll(async () => {
  await web?.close().catch(() => undefined);
  await core?.pool.end().catch(() => undefined);
  const { stopCluster } = await import('../src/db/embedded.js');  await stopCluster({ dataHome, port: 55_432 }).catch(() => undefined);
  await rm(dataHome, { recursive: true, force: true }).catch(() => undefined);
  await rm(projectDir, { recursive: true, force: true }).catch(() => undefined);
});

describe('L1.5 控制室', () => {
  it('监听回环 + 控制室页面可访问且 CSP 收紧', async () => {
    expect(web.url).toContain('127.0.0.1');
    const response = await fetch(web.url);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-security-policy') ?? '').toContain("default-src 'self'");
    const html = await response.text();
    expect(html).toContain('WorkTable 控制室');
  });

  it('/api/status 返回卡片（含 preview 完整 URL，偏差 D-4）', async () => {
    const response = await fetch(new URL('/api/status', web.url));
    expect(response.status).toBe(200);
    const snapshot = (await response.json()) as {
      uiUrl: string;
      projects: Array<{ projectId: string; status: string; preview: string | null; lastEvent: string | null }>;
    };
    expect(snapshot.uiUrl).toBe(web.url);
    const card = snapshot.projects.find((p) => p.projectId === createdProjectId);
    expect(card).toBeDefined();
    expect(card?.status).toBe('working');
    expect(card?.preview).toMatch(new RegExp(`^http://127\\.0\\.0\\.1:\\d+/a/art_[a-f0-9]+/demo\\.html$`));
    expect(card?.lastEvent).toMatch(/^mounted art_/);
  });

  it('/api/projects/:id 返回详情；未知 id 404', async () => {
    const response = await fetch(new URL(`/api/projects/${createdProjectId}`, web.url));
    expect(response.status).toBe(200);
    const detail = (await response.json()) as { projectId: string };
    expect(detail.projectId).toBe(createdProjectId);

    const missing = await fetch(new URL('/api/projects/prj_nope', web.url));
    expect(missing.status).toBe(404);
  });

  it('产物静态分发：合法 artifact 返回文件内容；伪造路径 403/404', async () => {
    const status = await (await fetch(new URL('/api/status', web.url))).json() as {
      projects: Array<{ projectId: string; preview: string | null }>;
    };
    const preview = status.projects.find((p) => p.projectId === createdProjectId)?.preview ?? '';
    const response = await fetch(new URL(preview, web.url));
    expect(response.status).toBe(200);
    expect(await response.text()).toContain('演示产物');
    expect(response.headers.get('x-artifact-type')).toBe('html');

    const forged = await fetch(new URL('/a/art_doesnotexist/whatever', web.url));
    expect(forged.status).toBe(404);
  });

  it('页面含 sandbox iframe 与 5s 轮询（静态断言）', async () => {
    const html = await (await fetch(web.url)).text();
    expect(html).toContain('sandbox="allow-scripts"');
    expect(html).toContain('POLL_MS = 5000');
  });
});

void DEFAULT_WEB_PORT;
