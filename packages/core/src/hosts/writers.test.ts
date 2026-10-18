/**
 * 宿主写入器事务语义测试（PRD P0-7 / 架构 §5.1 T04 验收③，mock fs——真实 HOME 不动）。
 */
import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { mkdtemp, mkdir, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  writeHostConfig,
  createJsonWriter,
  createTomlWriter,
  createYamlWriter,
  HostConfigParseError,
} from '../hosts/index.js';

let fakeHome: string;

beforeAll(async () => {
  fakeHome = await mkdtemp(join(tmpdir(), 'worktable-hosts-'));
});

afterAll(async () => {
  await rm(fakeHome, { recursive: true, force: true }).catch(() => undefined);
});

/**
 * 造一份既有宿主配置。
 *
 * @param relative 相对 fakeHome 的路径。
 * @param content 内容。
 */
async function given(relative: string, content: string): Promise<string> {
  const path = join(fakeHome, relative);
  await mkdir(join(path, '..'), { recursive: true });
  await writeFile(path, content, 'utf8');
  return path;
}

describe('hosts 写入器事务', () => {
  it('JSON：空目录全新写入 + readback 复验通过 + 无备份', async () => {
    const writer = createJsonWriter('workbuddy', () => join(fakeHome, '.workbuddy/mcp.json'));
    const result = await writeHostConfig(writer, {
      homeDir: fakeHome,
      serverKey: 'worktable',
      entry: { command: 'node', args: ['/x/mcp.js'] },
    });
    expect(result.verified).toBe(true);
    expect(result.rolledBack).toBe(false);
    expect(result.backupPath).toBeNull();

    // 结构化复验：解析后枚举 key
    const parsed = JSON.parse(await readFile(result.path, 'utf8')) as {
      mcpServers: Record<string, { command: string; args: string[] }>;
    };
    expect(parsed.mcpServers['worktable']?.command).toBe('node');
    expect(parsed.mcpServers['worktable']?.args).toEqual(['/x/mcp.js']);
  });

  it('JSON：既有配置保留无关 server，备份生成且重复安装不覆盖备份', async () => {
    const path = await given(
      '.claude.json',
      `${JSON.stringify({ mcpServers: { existing: { command: 'foo', args: ['a'] } } }, null, 2)}\n`,
    );
    const writer = createJsonWriter('claude-code', () => path);
    const first = await writeHostConfig(writer, {
      homeDir: fakeHome,
      serverKey: 'worktable',
      entry: { command: 'node', args: ['/x/mcp.js'] },
    });
    expect(first.backupPath).toBe(`${path}.worktable.backup`);

    // 第二次安装：备份内容不变（绝不覆盖）
    const beforeBackup = await readFile(first.backupPath ?? '', 'utf8');
    await writeHostConfig(writer, {
      homeDir: fakeHome,
      serverKey: 'worktable',
      entry: { command: 'node', args: ['/x/mcp.js', 'updated'] },
    });
    expect(await readFile(first.backupPath ?? '', 'utf8')).toBe(beforeBackup);

    // 无关 server 保留
    const parsed = JSON.parse(await readFile(path, 'utf8')) as {
      mcpServers: Record<string, unknown>;
    };
    expect(parsed.mcpServers['existing']).toBeDefined();
    expect(parsed.mcpServers['worktable']).toBeDefined();
  });

  it('JSON：既有配置损坏（非法 JSON）→ HostConfigParseError（降级信号，不写不删）', async () => {
    const path = await given('.claude.json', '{ broken json !!');
    const writer = createJsonWriter('claude-code', () => path);
    const before = await readFile(path, 'utf8');
    await expect(
      writeHostConfig(writer, { homeDir: fakeHome, serverKey: 'worktable', entry: { command: 'node', args: [] } }),
    ).rejects.toBeInstanceOf(HostConfigParseError);
    expect(await readFile(path, 'utf8')).toBe(before);
  });

  it('YAML（Hermes）：写入 mcp_servers 段并保留既有顶层键', async () => {
    const path = await given('.hermes/config.yaml', 'theme: dark\nmcp_servers:\n  other:\n    command: x\n');
    const writer = createYamlWriter(() => path);
    const result = await writeHostConfig(writer, {
      homeDir: fakeHome,
      serverKey: 'worktable',
      entry: { command: 'node', args: ['/x/mcp.js'] },
    });
    expect(result.verified).toBe(true);
    const { parse } = await import('yaml');
    const parsed = parse(await readFile(path, 'utf8')) as {
      theme: string;
      mcp_servers: Record<string, { command: string }>;
    };
    expect(parsed.theme).toBe('dark');
    expect(parsed.mcp_servers['other']?.command).toBe('x');
    expect(parsed.mcp_servers['worktable']?.command).toBe('node');
  });

  it('TOML（Codex）：写入 [mcp_servers.worktable] 并保留既有段', async () => {
    const path = await given('.codex/config.toml', 'model = "gpt-5"\n');
    const writer = createTomlWriter(() => path);
    const result = await writeHostConfig(writer, {
      homeDir: fakeHome,
      serverKey: 'worktable',
      entry: { command: 'node', args: ['/x/mcp.js'], env: { A: '1' } },
    });
    expect(result.verified).toBe(true);
    const { parse } = await import('smol-toml');
    const parsed = parse(await readFile(path, 'utf8')) as {
      model: string;
      mcp_servers: Record<string, { command: string; env: Record<string, string> }>;
    };
    expect(parsed.model).toBe('gpt-5');
    expect(parsed.mcp_servers['worktable']?.command).toBe('node');
    expect(parsed.mcp_servers['worktable']?.env?.['A']).toBe('1');
  });

  it('幂等：重复写入同一 server 不产生重复条目', async () => {
    const path = join(fakeHome, '.workbuddy/mcp.json');
    const writer = createJsonWriter('workbuddy', () => path);
    for (let i = 0; i < 3; i += 1) {
      await writeHostConfig(writer, {
        homeDir: fakeHome,
        serverKey: 'worktable',
        entry: { command: 'node', args: ['/x/mcp.js'] },
      });
    }
    const parsed = JSON.parse(await readFile(path, 'utf8')) as {
      mcpServers: Record<string, unknown>;
    };
    expect(Object.keys(parsed.mcpServers).filter((k) => k === 'worktable')).toHaveLength(1);
  });
});
