/**
 * dataHome 与数据库连接三级解析链（PRD P0-2 / 主理人裁决 D-11）。
 *
 * 重点验证两条「绝不静默」语义：
 * - 完全无配置 → setup-required + 候选清单，**不**偷偷起 embedded；
 * - 声明 external 却没给连接串 → 同样是 setup-required（配置残缺 ≠ 回退）。
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, afterEach } from 'vitest';
import { resolveDataHome } from '../src/config/dataHome.js';
import { configPath, normalizeConfig, writeConfigFile, DEFAULT_WEB_PORT } from '../src/config/index.js';
import { resolveDatabase } from '../src/config/database.js';

const created: string[] = [];

/**
 * @returns 临时 dataHome 目录。
 */
async function tempHome(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'worktable-dh-'));
  created.push(dir);
  return dir;
}

afterEach(async () => {
  for (const dir of created.splice(0)) {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
});

describe('config.resolveDataHome', () => {
  it('env WORKTABLE_HOME 优先', async () => {
    const target = await tempHome();
    const result = await resolveDataHome({ WORKTABLE_HOME: target });
    expect(result.dataHome).toBe(target);
    expect(result.source).toBe('env');
  });

  it('无 env 时落到默认 ~/.worktable', async () => {
    const result = await resolveDataHome({});
    expect(result.source).not.toBe('env');
    expect(typeof result.dataHome).toBe('string');
    expect(result.dataHome.length).toBeGreaterThan(0);
  });
});

describe('config.resolveDatabase', () => {
  it('无配置 → setup-required 且带候选清单，不静默起 embedded（D-11）', async () => {
    const dataHome = await tempHome();
    const result = await resolveDatabase(dataHome, {});
    expect(result.kind).toBe('setup-required');
    if (result.kind === 'setup-required') {
      expect(result.candidates.length).toBeGreaterThan(0);
    }
  });

  it('env WORKTABLE_DATABASE_URL 优先于 config.yaml', async () => {
    const dataHome = await tempHome();
    await writeConfigFile(
      configPath(dataHome),
      normalizeConfig(
        {
          database: { mode: 'external', url: 'postgres://u:p@127.0.0.1:5432/from-yaml' },
          web: { port: DEFAULT_WEB_PORT },
          home: { path: dataHome, history: [] },
        },
        dataHome,
      ),
    );
    const result = await resolveDatabase(dataHome, {
      WORKTABLE_DATABASE_URL: 'postgres://u:p@127.0.0.1:5432/from-env',
    });
    expect(result).toMatchObject({ kind: 'ready', source: 'env' });
    if (result.kind === 'ready') expect(result.url).toContain('from-env');
  });

  it('config.yaml 的外部连接串生效', async () => {
    const dataHome = await tempHome();
    await writeConfigFile(
      configPath(dataHome),
      normalizeConfig(
        {
          database: { mode: 'external', url: 'postgres://u:p@127.0.0.1:5432/external-db' },
          web: { port: DEFAULT_WEB_PORT },
          home: { path: dataHome, history: [] },
        },
        dataHome,
      ),
    );
    const result = await resolveDatabase(dataHome, {});
    expect(result).toMatchObject({ kind: 'ready', mode: 'external', source: 'config-yaml' });
  });

  it('embedded 模式下 URL 缺省由 embedded 默认补上（而不是无配置兜底）', async () => {
    const dataHome = await tempHome();
    await writeConfigFile(
      configPath(dataHome),
      normalizeConfig(
        {
          database: { mode: 'embedded' },
          web: { port: DEFAULT_WEB_PORT },
          home: { path: dataHome, history: [] },
        },
        dataHome,
      ),
    );
    const result = await resolveDatabase(dataHome, {});
    expect(result.kind).toBe('ready');
    if (result.kind === 'ready') {
      expect(result.url).toContain('55432');
    }
  });

  it('声明 external 却缺连接串 → setup-required（配置残缺，不回退 embedded）', async () => {
    const dataHome = await tempHome();
    await writeConfigFile(
      configPath(dataHome),
      normalizeConfig(
        {
          database: { mode: 'external' },
          web: { port: DEFAULT_WEB_PORT },
          home: { path: dataHome, history: [] },
        },
        dataHome,
      ),
    );
    const result = await resolveDatabase(dataHome, {});
    expect(result.kind).toBe('setup-required');
  });
});
