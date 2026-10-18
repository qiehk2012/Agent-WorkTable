/**
 * CLI 主入口（架构 §7.4 两大错误转换点之一）。
 *
 * 退出码：0 成功；1 业务错误（打印错误码与 remediation）；2 用法错误。
 * stdout 只有人类可读结果；错误与诊断一律 stderr。
 */
import { isWorktableError } from '../errors/index.js';
import {
  commandBind,
  commandCheck,
  commandDoctor,
  commandInit,
  commandLs,
  commandMigrate,
  commandMount,
  commandNew,
  commandOpen,
  commandPg,
  commandStatus,
  commandUi,
  type CommandContext,
} from './commands.js';

/**
 * @param argv 进程参数（含 node 与脚本路径）。
 * @returns 进程退出码。
 */
export async function cliMain(argv: string[]): Promise<number> {
  const args = argv.slice(2);
  if (args.length === 0 || args[0] === '--help' || args[0] === '-h') {
    process.stdout.write(USAGE);
    return 0;
  }

  const command = args[0] ?? '';
  const rest = args.slice(1);
  const json = rest.includes('--json');
  const ctx: CommandContext = { env: process.env, json };

  try {
    const output = await dispatch(command, rest, ctx);
    if (json && output.json !== undefined) {
      process.stdout.write(`${JSON.stringify(output.json, null, 2)}\n`);
    } else {
      process.stdout.write(`${output.text}\n`);
    }
    return output.ok ? 0 : 1;
  } catch (error) {
    if (isWorktableError(error)) {
      process.stderr.write(`[${error.code}] ${error.message}\n恢复建议：${error.remediation}\n`);
      return 1;
    }
    const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
    process.stderr.write(`[internal] ${message}\n`);
    return 1;
  }
}

/**
 * @param command 命令名。
 * @param rest 参数（不含命令名）。
 * @param ctx 上下文。
 * @returns 命令输出。
 */
async function dispatch(
  command: string,
  rest: string[],
  ctx: CommandContext,
): Promise<import('./commands.js').CommandOutput> {
  switch (command) {
    case 'init':
      return commandInit(ctx, rest);
    case 'migrate':
      return commandMigrate(ctx, rest);
    case 'pg':
      return commandPg(ctx, rest);
    case 'doctor':
      return commandDoctor(ctx);
    case 'new':
      return commandNew(ctx, rest);
    case 'ls':
      return commandLs(ctx, rest);
    case 'open':
      return commandOpen(ctx, rest);
    case 'bind':
      return commandBind(ctx, rest);
    case 'status':
      return commandStatus(ctx);
    case 'mount':
      return commandMount(ctx, rest);
    case 'check':
      return commandCheck(ctx);
    case 'ui':
      return commandUi(ctx);
    default:
      process.stderr.write(`未知命令：${command}\n\n${USAGE}`);
      process.exit(2);
  }
}

const USAGE = `worktable — 跨宿主工作台（P0）

用法：worktable <command> [options]

命令：
  init [--home <dir>] [--database-url <url>] [--yes]   初始化（选位置/起库/迁移）
  pg init|start|stop|status                             embedded PG 集群生命周期
  migrate [--status]                                    应用/查看迁移
  doctor                                                一页诊断
  new <name> --folder <path> [--icon <emoji>]           创建项目
  ls [--all]                                            项目列表
  open <name|projectId>                                 项目上下文
  bind <projectId> --host <h> --session <id> [--force]  绑定会话
  status                                                控制室快照（含 uiUrl）
  mount <projectId> --pane --binding --title --type --entry   挂载产物
  check                                                 体检
  ui                                                    启动控制室（127.0.0.1:55433）

全局：--json 机器可读输出
环境：WORKTABLE_HOME / WORKTABLE_DATABASE_URL / WORKTABLE_WEB_PORT
`;

// 直接执行时启动（bundle 入口）；被 import（测试）不自动跑
if (process.argv[1]?.endsWith('cli.js')) {
  void cliMain(process.argv).then((code) => process.exit(code));
}
