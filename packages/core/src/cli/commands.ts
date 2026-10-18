/**
 * CLI 命令实现（PRD §4.3 / 架构 §2.2）：12 命令全部薄封装 core 组合根，零业务逻辑。
 */
import { existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import {
  bindingId,
  configPath,
  createWorktable,
  DEFAULT_PG_PORT,
  DEFAULT_WEB_PORT,
  migrate,
  migrateStatus,
  normalizeConfig,
  projectId,
  recordDataHomeChoice,
  writeConfigFile,
  type WorktableCore,
} from '../index.js';

/** 命令结果：CLI 主入口据此渲染与决定退出码。 */
export interface CommandOutput {
  ok: boolean;
  /** 人类可读输出（简体中文）。 */
  text: string;
  /** `--json` 时的机器可读负载。 */
  json?: unknown;
}

/** 命令上下文。 */
export interface CommandContext {
  env: NodeJS.ProcessEnv;
  json: boolean;
}

/** 12 命令名。 */
export type CommandName =
  | 'init'
  | 'migrate'
  | 'doctor'
  | 'pg'
  | 'new'
  | 'ls'
  | 'open'
  | 'bind'
  | 'status'
  | 'mount'
  | 'check'
  | 'ui';

/**
 * 打开 core（init 之外的所有命令共用）。
 *
 * @param ctx 命令上下文。
 * @returns core 句柄。
 */
async function core(ctx: CommandContext): Promise<WorktableCore> {
  return createWorktable(ctx.env);
}

/**
 * `worktable init`：选 dataHome、写 config.yaml、（embedded 时）起集群、跑迁移。
 */
export async function commandInit(ctx: CommandContext, args: string[]): Promise<CommandOutput> {
  const homeFlag = takeFlag(args, '--home');
  const databaseUrl = takeFlag(args, '--database-url');
  const yes = args.includes('--yes');

  // 位置三级链：--home > env WORKTABLE_HOME > ~/.worktable（与 resolveDataHome 的 env>默认 对齐）
  const { resolveDataHome } = await import('../config/dataHome.js');
  const resolved = await resolveDataHome(ctx.env);
  const dataHome = homeFlag !== null ? path.resolve(homeFlag) : resolved.dataHome;
  const config = configPath(dataHome);

  if (existsSync(config)) {
    return { ok: true, text: `已初始化（${config}）。如需重选位置：worktable relocate（P1）或删除该文件后重跑。`, json: { dataHome, config } };
  }

  if (!yes && homeFlag === null && !process.stdin.isTTY) {
    return {
      ok: false,
      text: `未指定 --home 且非交互环境。用法：worktable init --home <dir> --yes，或交互终端中运行。默认将使用 ${dataHome}`,
    };
  }

  mkdirSync(dataHome, { recursive: true });
  const mode = databaseUrl !== null ? 'external' : 'embedded';
  await writeConfigFile(
    config,
    normalizeConfig(
      {
        database: {
          mode,
          ...(mode === 'external' && databaseUrl !== null ? { url: databaseUrl } : {}),
        },
        web: { port: DEFAULT_WEB_PORT },
        home: { path: dataHome, history: [] },
      },
      dataHome,
    ),
  );
  await recordDataHomeChoice(dataHome);

  // embedded：起集群 + 建库 + 迁移
  const instance = await createWorktable({ ...ctx.env, WORKTABLE_HOME: dataHome });
  const report = await migrate(instance.store);
  await instance.pool.end();

  return {
    ok: true,
    text: [
      `初始化完成：`,
      `  dataHome   ${dataHome}`,
      `  config     ${config}`,
      `  模式       ${mode === 'embedded' ? `embedded（PG 端口 ${DEFAULT_PG_PORT}）` : `external（${redact(databaseUrl ?? '')}）`}`,
      `  迁移       applied=${report.applied.join(',')} skipped=${report.skipped.join(',') || '—'}`,
      `  web 端口   ${DEFAULT_WEB_PORT}（WORKTABLE_WEB_PORT 可改）`,
    ].join('\n'),
    json: { dataHome, config, mode, migrations: report },
  };
}

/**
 * `worktable migrate`（`--status` 只查不跑）。
 */
export async function commandMigrate(ctx: CommandContext, args: string[]): Promise<CommandOutput> {
  const instance = await core(ctx);
  try {
    if (args.includes('--status')) {
      const status = await migrateStatus(instance.store);
      return {
        ok: true,
        text: `已应用：${status.applied.map((a) => a.version).join(', ') || '—'}\n待应用：${status.pending.join(', ') || '—'}`,
        json: status,
      };
    }
    const report = await migrate(instance.store);
    return {
      ok: true,
      text: `迁移完成：applied=${report.applied.join(',') || '无'} skipped=${report.skipped.join(',') || '无'}`,
      json: report,
    };
  } finally {
    await instance.pool.end();
  }
}

/**
 * `worktable pg init|start|stop|status`。
 */
export async function commandPg(ctx: CommandContext, args: string[]): Promise<CommandOutput> {
  const { clusterStatus, startCluster, stopCluster } = await import('../db/embedded.js');
  const { resolveDataHome } = await import('../config/dataHome.js');
  const sub = args[0] ?? 'status';
  const { dataHome } = await resolveDataHome(ctx.env);
  const options = { dataHome, port: DEFAULT_PG_PORT };

  switch (sub) {
    case 'init':
    case 'start': {
      const status = await startCluster(options);
      return { ok: true, text: `embedded PG 已启动：127.0.0.1:${status.port}（${status.pgDataDir}）`, json: status };
    }
    case 'stop': {
      const status = await stopCluster(options);
      return { ok: true, text: `embedded PG 已停止（pgdata 保留于 ${status.pgDataDir}）`, json: status };
    }
    case 'status': {
      const status = await clusterStatus(options);
      return {
        ok: true,
        text: `initialised=${status.initialised} running=${status.running} port=${status.port}\npgdata=${status.pgDataDir}`,
        json: status,
      };
    }
    default:
      return { ok: false, text: `未知子命令：${sub}（可用：init|start|stop|status）` };
  }
}

/**
 * `worktable doctor`：一页诊断（PRD P0-4 ②）。
 */
export async function commandDoctor(ctx: CommandContext): Promise<CommandOutput> {
  const { resolveDataHome } = await import('../config/dataHome.js');
  const { resolveDatabase } = await import('../config/database.js');
  const { dataHome, source } = await resolveDataHome(ctx.env);
  const database = await resolveDatabase(dataHome, ctx.env);

  const lines = [
    `dataHome     ${dataHome}（来源：${source}）`,
    `数据库模式   ${database.kind === 'ready' ? database.mode : '未配置'}`,
    `连接来源     ${database.kind === 'ready' ? database.source : '—'}`,
  ];

  if (database.kind !== 'ready') {
    lines.push('schema 版本  —（未初始化：跑 worktable init）');
    return { ok: false, text: lines.join('\n'), json: { dataHome, database } };
  }

  const instance = await core(ctx);
  try {
    const report = await instance.doctor.check();
    lines.unshift(
      `worktable    v${instance.version} · mode=${instance.mode} · web=${instance.webPort}`,
    );
    lines.push(`schema 版本  ${report.schemaVersion ?? '未迁移'}`);
    lines.push(`库可达       ${report.dbReachable ? '是' : '否'}`);
    if (report.issues.length > 0) {
      lines.push(`问题（${report.issues.length}）：`);
      for (const issue of report.issues) lines.push(`  - [${issue.code}] ${issue.message}`);
    } else {
      lines.push('问题         无');
    }
    return { ok: report.dbReachable && report.issues.every((i) => i.code === 'warn'), text: lines.join('\n'), json: report };
  } finally {
    await instance.pool.end();
  }
}

/**
 * `worktable new <name> --folder <path>`。
 */
export async function commandNew(ctx: CommandContext, args: string[]): Promise<CommandOutput> {
  const name = args[0];
  if (name === undefined || name === '') return { ok: false, text: '用法：worktable new <name> --folder <path> [--icon <emoji>]' };
  const folder = takeFlag(args, '--folder');
  if (folder === null) return { ok: false, text: '缺少 --folder <path>（须为已存在目录）' };
  if (!existsSync(folder)) return { ok: false, text: `folder 不存在：${folder}（先 mkdir 再注册）` };
  const icon = takeFlag(args, '--icon');

  const instance = await core(ctx);
  try {
    const project = await instance.store.createProject({
      projectId: projectId(name),
      name,
      folder: path.resolve(folder),
      ...(icon === null ? {} : { icon }),
      createdBy: 'cli',
    });
    return { ok: true, text: `已创建：${project.name}（${project.project_id}）\n目录：${project.folder}`, json: project };
  } finally {
    await instance.pool.end();
  }
}

/**
 * `worktable ls`。
 */
export async function commandLs(ctx: CommandContext, args: string[]): Promise<CommandOutput> {
  const instance = await core(ctx);
  try {
    const projects = await instance.store.listProjects({ includeHidden: args.includes('--all') });
    if (projects.length === 0) {
      return { ok: true, text: '还没有项目。用 worktable new <name> --folder <path> 创建。', json: [] };
    }
    const header = '  名称\t状态\t宿主\t目录';
    const rows = projects.map((p) => `  ${p.icon ?? '📁'} ${p.name}\t${p.status ?? '未绑定'}\t${p.host ?? '—'}\t${p.cwd ?? '—'}`);
    return { ok: true, text: [header, ...rows].join('\n'), json: projects };
  } finally {
    await instance.pool.end();
  }
}

/**
 * `worktable open <name|projectId>`。
 */
export async function commandOpen(ctx: CommandContext, args: string[]): Promise<CommandOutput> {
  const key = args[0];
  if (key === undefined) return { ok: false, text: '用法：worktable open <name|projectId>' };
  const instance = await core(ctx);
  try {
    const context = await instance.store.getProjectContext(
      key.startsWith('prj_') ? { projectId: key } : { name: key },
    );
    if (context === null) return { ok: false, text: `项目不存在：${key}` };
    const lines = [
      `${context.project.icon ?? '📁'} ${context.project.name}（${context.project.project_id}）`,
      `目录：${context.project.folder}`,
      `绑定（${context.bindings.length}）：`,
      ...context.bindings.map(
        (b) => `  ${b.binding_id} ${b.status} host=${b.host} rev=${b.revision} ${b.note ?? ''}`,
      ),
      `产物（${context.artifacts.length}）：`,
      ...context.artifacts.map((a) => `  ${a.artifact_id} [${a.type}] ${a.title} → ${a.payload_path}`),
    ];
    return { ok: true, text: lines.join('\n'), json: context };
  } finally {
    await instance.pool.end();
  }
}

/**
 * `worktable bind <projectId> --host <h> --session <id>`。
 */
export async function commandBind(ctx: CommandContext, args: string[]): Promise<CommandOutput> {
  const projectIdValue = args[0];
  if (projectIdValue === undefined) {
    return { ok: false, text: '用法：worktable bind <projectId> --host <host> --session <id> [--cwd <dir>] [--force]' };
  }
  const host = takeFlag(args, '--host');
  const session = takeFlag(args, '--session');
  if (host === null || session === null) return { ok: false, text: '缺少 --host 或 --session' };
  const cwd = takeFlag(args, '--cwd') ?? process.cwd();
  const force = args.includes('--force');

  const instance = await core(ctx);
  try {
    const result = await instance.store.bindSession({
      projectId: projectIdValue,
      bindingId: bindingId({ projectId: projectIdValue, host, sessionId: session, cwd }),
      host: host as 'dsh' | 'hermes' | 'workbuddy' | 'claude-code' | 'codex',
      sessionId: session,
      cwd,
      force,
    });
    return { ok: true, text: `已绑定：${result.bindingId}（revision=${result.revision}${force ? '，旧绑定已置 done' : ''}）`, json: result };
  } finally {
    await instance.pool.end();
  }
}

/**
 * `worktable status`。
 */
export async function commandStatus(ctx: CommandContext): Promise<CommandOutput> {
  const instance = await core(ctx);
  try {
    const snapshot = await instance.controlRoom.snapshot();
    const lines = [`控制室：${snapshot.uiUrl}`, ''];
    if (snapshot.projects.length === 0) {
      lines.push('还没有项目。');
    } else {
      for (const card of snapshot.projects) {
        lines.push(
          `  ${card.icon ?? '📁'} ${card.name}  [${card.status ?? '未绑定'}]  ${card.host ?? ''} ${card.cwd ?? ''}`,
          `    最近事件：${card.lastEvent ?? '—'}  待挂载：${card.pendingArtifacts}${card.preview ? `\n    最近产物：${card.preview}` : ''}`,
        );
      }
    }
    return { ok: true, text: lines.join('\n'), json: snapshot };
  } finally {
    await instance.pool.end();
  }
}

/**
 * `worktable mount <projectId> --pane <id> --binding <id> --title <t> --type <t> --entry <rel>`。
 */
export async function commandMount(ctx: CommandContext, args: string[]): Promise<CommandOutput> {
  const projectIdValue = args[0];
  if (projectIdValue === undefined) {
    return { ok: false, text: '用法：worktable mount <projectId> --pane <id> --binding <id> --title <t> --type <html|markdown|image|file> --entry <相对路径>' };
  }
  const pane = takeFlag(args, '--pane');
  const binding = takeFlag(args, '--binding');
  const title = takeFlag(args, '--title');
  const type = takeFlag(args, '--type');
  const entry = takeFlag(args, '--entry');
  if (pane === null || binding === null || title === null || type === null || entry === null) {
    return { ok: false, text: '缺少必要参数（--pane/--binding/--title/--type/--entry）' };
  }

  const instance = await core(ctx);
  try {
    const result = await instance.artifacts.mount({
      projectId: projectIdValue,
      paneId: pane,
      bindingId: binding,
      title,
      type: type as 'html' | 'markdown' | 'image' | 'file',
      entry,
    });
    return { ok: true, text: `已挂载：${result.artifactId}\nmountUri：${result.mountUri}`, json: result };
  } finally {
    await instance.pool.end();
  }
}

/**
 * `worktable check`。
 */
export async function commandCheck(ctx: CommandContext): Promise<CommandOutput> {
  const instance = await core(ctx);
  try {
    const report = await instance.doctor.check();
    const lines = [
      `schema：${report.schemaVersion ?? '未迁移'}  库可达：${report.dbReachable ? '是' : '否'}`,
      `目录可写：${report.projectDirsWritable.map((d) => `${d.projectId}=${d.writable ? '可写' : '不可写'}`).join(' ') || '—'}`,
      `孤儿绑定：${report.orphanBindings.length === 0 ? '无' : ''}`,
      ...report.orphanBindings.map((o) => `  ${o.bindingId} ${o.reason}`),
      `问题：${report.issues.length === 0 ? '无 ✅' : String(report.issues.length)}`,
      ...report.issues.map((i) => `  - [${i.code}] ${i.message}`),
    ];
    return {
      ok: report.dbReachable && report.issues.every((i) => i.code === 'warn'),
      text: lines.join('\n'),
      json: report,
    };
  } finally {
    await instance.pool.end();
  }
}

/**
 * `worktable ui`：前台拉起 L1.5 并尝试打开浏览器（偏差 D-5 口径）。
 */
export async function commandUi(ctx: CommandContext): Promise<CommandOutput> {
  const instance = await core(ctx);
  const web = await instance.startWeb();
  process.stderr.write(`[worktable ui] 控制室已启动：${web.url}（Ctrl-C 退出）\n`);
  void openBrowser(web.url);

  return new Promise<CommandOutput>(() => {
    // 前台驻留：Ctrl-C 触发 exit 钩子
    process.on('SIGINT', () => {
      void web.close().then(() => process.exit(0));
    });
  });
}

/**
 * `worktable status --json` 等命令共用：取 --flag value。
 */
function takeFlag(args: string[], flag: string): string | null {
  const index = args.indexOf(flag);
  if (index === -1) return null;
  const value = args[index + 1];
  return value === undefined || value.startsWith('--') ? null : value;
}

/** 凭证脱敏：连接串里的口令不进日志。 */
function redact(url: string): string {
  return url.replace(/\/\/([^:]+):([^@]+)@/, '//$1:***@');
}

/** 尽力打开浏览器（失败静默——CLI 场景允许无 GUI）。 */
async function openBrowser(urlValue: string): Promise<void> {
  const { spawn } = await import('node:child_process');
  try {
    if (process.platform === 'darwin') spawn('open', [urlValue], { stdio: 'ignore' });
    else if (process.platform === 'win32') spawn('cmd', ['/c', 'start', urlValue], { stdio: 'ignore' });
    else spawn('xdg-open', [urlValue], { stdio: 'ignore' });
  } catch {
    // 无 GUI 环境静默跳过
  }
}
