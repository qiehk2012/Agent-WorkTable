/**
 * 并发门禁（PRD P0-10 / 架构 §4.4 / 风险 R-5）：文件锁 + 绑定状态机 + 挂载事务。
 *
 * 这里的断言刻意是「数据层能否挡住并发写」，而不是「应用层是否自觉」：
 * 部分唯一索引与文件锁都是数据库 / 内核层的保证，绕过应用层同样生效。
 */
import { mkdtemp, rm, readFile, writeFile, appendFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, beforeAll, afterAll, afterEach } from 'vitest';
import { initLockPath, withFileLock } from '../src/db/lock.js';
import { projectId, bindingId, artifactId } from '../src/ids.js';
import { createProject } from '../src/store/projects.js';
import { bindSession, updateStatus, listBindings } from '../src/store/bindings.js';
import { mountArtifact } from '../src/store/mount.js';
import { createTransactor } from '../src/store/schema.js';
import { startTestEnv, type TestEnv } from './support/test-env.js';

const tempDirs: string[] = [];

/**
 * @returns 临时目录。
 */
async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'worktable-lock-'));
  tempDirs.push(dir);
  return dir;
}

let env: TestEnv | undefined;

/** 起一次环境；拆.Before/after 由 afterAll 负责 */
beforeAll(async () => {
  env = await startTestEnv();
}, 120_000);

afterAll(async () => {
  await env?.teardown();
});

afterEach(async () => {
  for (const dir of tempDirs.splice(0)) {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
});

/**
 * 建一个干净项目（名字随机，避免跨用例唯一键冲突）。
 *
 * @returns 项目 ID。
 */
async function freshProject(): Promise<string> {
  const pool = env?.pool;
  if (pool === undefined) throw new Error('测试环境未就绪');
  const name = `p-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const created = await createProject(pool, {
    projectId: projectId(name),
    name,
    folder: '/tmp',
    createdBy: 'cli',
  });
  return created.project_id;
}

/**
 * @param projectIdRef 项目 ID。
 * @param host 宿主。
 * @param session 会话。
 * @returns 绑定结果。
 */
async function bindOnce(
  projectIdRef: string,
  host: 'claude-code' | 'codex' | 'workbuddy' | 'dsh',
  session: string,
): ReturnType<typeof bindSession> {
  const pool = env?.pool;
  if (pool === undefined) throw new Error('测试环境未就绪');
  return bindSession(pool, {
    projectId: projectIdRef,
    bindingId: bindingId({ projectId: projectIdRef, host, sessionId: session, cwd: '/tmp' }),
    host,
    sessionId: session,
    cwd: '/tmp',
  });
}

describe('db.fileLock', () => {
  it('并发调用被串行化，五次自增不丢更新', async () => {
    const dir = await tempDir();
    const counter = join(dir, 'counter.txt');
    await writeFile(counter, '0\n', 'utf8');

    await Promise.all(
      [1, 2, 3, 4, 5].map(() =>
        withFileLock(initLockPath(dir), async () => {
          const current = Number((await readFile(counter, 'utf8')).trim());
          await new Promise((resolve) => setTimeout(resolve, 5));
          await writeFile(counter, `${current + 1}\n`, 'utf8');
        }),
      ),
    );

    expect(Number((await readFile(counter, 'utf8')).trim())).toBe(5);
  });

  it('执行结束后锁被释放，后续调用能按序进入', async () => {
    const dir = await tempDir();
    const trace = join(dir, 'trace.txt');
    await writeFile(trace, '', 'utf8');
    await withFileLock(initLockPath(dir), async () => {
      await appendFile(trace, 'first\n', 'utf8');
    });
    await withFileLock(initLockPath(dir), async () => {
      await appendFile(trace, 'second\n', 'utf8');
    });
    expect((await readFile(trace, 'utf8')).trim().split('\n')).toEqual(['first', 'second']);
  });
});

describe('store.bindings 状态机', () => {
  it('同一项目重复 bind → binding-conflict（部分唯一索引保证）', async () => {
    const pid = await freshProject();
    const first = await bindOnce(pid, 'claude-code', 's1');
    expect(first.revision).toBe(1);
    await expect(bindOnce(pid, 'codex', 's2')).rejects.toMatchObject({ code: 'binding-conflict' });
  });

  it('force 顶替：旧 binding 置 done 后新 binding 成功', async () => {
    const pid = await freshProject();
    await bindOnce(pid, 'claude-code', 's1');
    const pool = env?.pool;
    if (pool === undefined) throw new Error('测试环境未就绪');
    const second = await bindSession(pool, {
      projectId: pid,
      bindingId: bindingId({ projectId: pid, host: 'codex', sessionId: 's2', cwd: '/tmp' }),
      host: 'codex',
      sessionId: 's2',
      cwd: '/tmp',
      force: true,
    });
    expect(second.revision).toBe(1);

    const statuses = (await listBindings(pool, pid)).map((b) => b.status).sort();
    expect(statuses).toEqual(['done', 'working']);
  });

  it('expectedRevision 不符 → revision-conflict', async () => {
    const pid = await freshProject();
    await bindOnce(pid, 'workbuddy', 'w1');
    const pool = env?.pool;
    if (pool === undefined) throw new Error('测试环境未就绪');
    await expect(
      updateStatus(pool, { projectId: pid, status: 'needs-you', expectedRevision: 999 }),
    ).rejects.toMatchObject({ code: 'revision-conflict' });
  });

  it('expectedRevision 相符 → 状态推进且 revision 自增', async () => {
    const pid = await freshProject();
    await bindOnce(pid, 'dsh', 'd0');
    const pool = env?.pool;
    if (pool === undefined) throw new Error('测试环境未就绪');
    const updated = await updateStatus(pool, {
      projectId: pid,
      status: 'needs-you',
      expectedRevision: 1,
      note: '等待用户确认方案',
    });
    expect(updated.revision).toBe(2);
    const active = (await listBindings(pool, pid)).filter((b) => b.status === 'needs-you');
    expect(active).toHaveLength(1);
    expect(active[0]?.note ?? null).toBe('等待用户确认方案');
  });
});

describe('store.mount 事务', () => {
  it('晚到的 pane 写入不覆盖已有 pane，两个产物共存', async () => {
    const pid = await freshProject();
    const binding = await bindOnce(pid, 'dsh', 'd1');
    const pool = env?.pool;
    if (pool === undefined) throw new Error('测试环境未就绪');
    const tx = createTransactor(pool);

    const makeInput = (path: string, title: string) =>
      ({
        artifactId: artifactId({
          projectId: pid,
          paneId: 'pane_01',
          bindingId: binding.bindingId,
          payloadPath: path,
        }),
        projectId: pid,
        paneId: 'pane_01',
        bindingId: binding.bindingId,
        title,
        type: 'markdown' as const,
        payloadPath: path,
      });

    const first = await mountArtifact(tx, makeInput('a.md', 'A'));
    expect(first.mountUri).toContain('worktable://pane_01-');

    // 模拟旧会话重放：同一 pane 再挂一次，pane 不被覆盖，产物共存
    const second = await mountArtifact(tx, makeInput('b.md', 'B'));
    expect(second.artifactId).not.toBe(first.artifactId);

    const { rows } = await pool.query('SELECT COUNT(*)::int AS n FROM artifacts WHERE pane_id = $1', [
      'pane_01',
    ]);
    expect((rows[0] as { n: number }).n).toBe(2);
  });
});
