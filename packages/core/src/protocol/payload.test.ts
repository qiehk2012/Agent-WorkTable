/**
 * payload 收容单元测试（PRD P0-9 ⑥ / 架构 §3.6 五步算法）。
 * 纯文件系统操作，不起数据库。
 */
import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createProjectDirResolver,
  isPayloadMissingError,
} from './payload.js';
import { WorktableError } from '../errors/index.js';
import type { Project } from '../store/types.js';

let projectDir: string;
let project: Project;

beforeAll(async () => {
  projectDir = await mkdtemp(join(tmpdir(), 'worktable-payload-'));
  const artifacts = join(projectDir, '.worktable', 'artifacts');
  await mkdir(artifacts, { recursive: true });
  await writeFile(join(artifacts, 'report.md'), '# 报告\n', 'utf8');
  await mkdir(join(artifacts, 'sub'), { recursive: true });
  await writeFile(join(artifacts, 'sub', 'chart.png'), 'png', 'utf8');
  project = {
    project_id: 'prj_test',
    name: 'test',
    icon: null,
    folder: projectDir,
    position: 1,
    hidden: false,
    created_at: new Date(),
    created_by: 'cli',
  };
});

afterAll(async () => {
  await rm(projectDir, { recursive: true, force: true }).catch(() => undefined);
});

describe('protocol.payload 五步收容', () => {
  it('合法相对路径通过，返回 storedRef 与绝对路径', async () => {
    const resolver = createProjectDirResolver();
    const resolved = await resolver.resolveForWrite(project, 'report.md');
    expect(resolved.storedRef).toBe('report.md');
    expect(resolved.absolutePath.endsWith(join('.worktable', 'artifacts', 'report.md'))).toBe(true);
  });

  it('子目录相对路径通过', async () => {
    const resolver = createProjectDirResolver();
    const resolved = await resolver.resolveForWrite(project, 'sub/chart.png');
    expect(resolved.storedRef).toBe('sub/chart.png');
  });

  it('绝对路径 → path-escape', async () => {
    const resolver = createProjectDirResolver();
    await expect(resolver.resolveForWrite(project, '/etc/hosts')).rejects.toMatchObject({
      code: 'path-escape',
    });
  });

  it('Windows 风格绝对路径 → path-escape', async () => {
    const resolver = createProjectDirResolver();
    await expect(resolver.resolveForWrite(project, 'C:\\Windows\\system32')).rejects.toMatchObject({
      code: 'path-escape',
    });
  });

  it('含 .. 的路径 → path-escape', async () => {
    const resolver = createProjectDirResolver();
    await expect(resolver.resolveForWrite(project, '../escape.md')).rejects.toMatchObject({
      code: 'path-escape',
    });
    await expect(resolver.resolveForWrite(project, 'sub/../../escape.md')).rejects.toMatchObject({
      code: 'path-escape',
    });
  });

  it('空 entry → path-escape', async () => {
    const resolver = createProjectDirResolver();
    await expect(resolver.resolveForWrite(project, '  ')).rejects.toMatchObject({ code: 'path-escape' });
  });

  it('不存在的文件 → PayloadMissingError（invalid params，不占 12 码）', async () => {
    const resolver = createProjectDirResolver();
    const error = await resolver.resolveForWrite(project, 'nope.md').catch((e: unknown) => e);
    expect(isPayloadMissingError(error)).toBe(true);
    expect(error).not.toBeInstanceOf(WorktableError);
  });

  it('symlink 逃逸 → path-escape（指向存在的外部文件）', async () => {
    // 外部真实文件（越出 artifacts 目录但存在于磁盘）
    const outside = join(projectDir, 'secret-outside.txt');
    await writeFile(outside, 'secret', 'utf8');
    await symlink(outside, join(projectDir, '.worktable', 'artifacts', 'leak'));
    const resolver = createProjectDirResolver();
    try {
      await expect(resolver.resolveForWrite(project, 'leak')).rejects.toMatchObject({
        code: 'path-escape',
      });
    } finally {
      await rm(join(projectDir, '.worktable', 'artifacts', 'leak'), { force: true }).catch(() => undefined);
      await rm(outside, { force: true }).catch(() => undefined);
    }
  });

  it('resolveForRead 走同一套校验', async () => {
    const resolver = createProjectDirResolver();
    const absolutePath = await resolver.resolveForRead(project, 'report.md');
    expect(absolutePath).toContain('report.md');
    await expect(resolver.resolveForRead(project, '../../etc/hosts')).rejects.toMatchObject({
      code: 'path-escape',
    });
  });
});
