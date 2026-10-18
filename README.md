# Agent-WorkTable

跨宿主插件（P0 垂直切片）：把「项目注册表 + 会话绑定 + 控制室状态 + 产物挂载协议」抽成与宿主无关的可移植核心，五宿主（Claude Code / WorkBuddy / Hermes / Codex / dsh）经 MCP stdio / CLI 读写同一份 Postgres。

> 仓库：https://github.com/qiehk2012/Agent-WorkTable.git

## 架构要点

- **Postgres 是唯一事实源**：运营状态全部入库；不存浏览器缓存、不存宿主私有目录。
- **SQL 不出 Store**：全部 SQL 收敛在 `packages/core/src/store/`，由 `verify:module-boundaries` 静态守护（架构红线）。
- **两个薄适配层**：`packages/mcp`（MCP stdio server，10 工具 + 2 prompt）与 `packages/core/src/cli`（`worktable` 12 命令）共用同一组合根 `createWorktable()`，行为一致。
- **L1.5 只读控制室**：`127.0.0.1:55433`，5s 轮询，CSP 收紧，产物 sandbox iframe。
- **生成物纪律**：`src/migrations/generated.ts` / `docs/tool-catalog.md` / `plugin/` / `package-lock.json` 禁手改——数字不对改生成链（`scripts/gen-*.mjs`），不改产物。

## 环境要求

- Node.js >= 20（开发与 CI 固定 22.x）
- macOS / Linux（Windows 适配留 P1-5）

> **⚠️ embedded 模式首次 `worktable init` 需联网下载约 35MB 的 Postgres 二进制**（zonky embedded-postgres，下载后缓存于 dataHome）。离线 / 内网环境请改用外部 Postgres：`WORKTABLE_DATABASE_URL=postgres://...`。

## 快速开始（P0 施工中 · 占位）

```bash
npm ci                    # 干净安装（lockfile 已提交，保复现）
npm run build             # esbuild 双入口 bundle + plugin/ 组装
npm run verify:typecheck  # 类型门禁
```

安装与初始化（`install.sh` / `worktable init` / 宿主握手）随 T04/T05 交付后补全本节。

## 依赖锁定记录（架构 §6 锁定纪律）

`embedded-postgres` 与 `@modelcontextprotocol/sdk` 是唯二具有外部二进制 / 协议兼容性约束的依赖，T01 一次性锁定如下（权威版本以 `package-lock.json` 为准）：

| 依赖 | 声明范围 | 锁定版本 | 说明 |
|---|---|---|---|
| `embedded-postgres` | `17.5.0-beta.15`（精确钉住） | 17.5.0-beta.15 | 该 npm 包只发 prerelease、无 stable 版本，架构所写 `^17.5.0` 无法在 registry 解析，故按「实现期锁定」纪律钉 17.5.x 最新 prerelease；内置 zonky PG 17.5 二进制，首次 init 需联网下载 ~35MB |
| `@modelcontextprotocol/sdk` | `^1.0.0` | 1.32.1 | MCP 协议兼容性约束；与 zod 版本配对（peer：`zod ^3.25 \|\| ^4.0`） |
| `zod` | `^3.25.0` | 3.25.76 | 工具入参 schema；架构原写 `^3.23.0`，因 SDK peer 下限为 3.25 随 SDK 抬升（未跳 zod 4） |
| `pg` | `^8.11.0` | 8.23.1 | Postgres 客户端（全部 SQL 的出口） |
| `yaml` | `^2.4.0` | 2.9.1 | config.yaml / Hermes 配置结构化读写 |
| `smol-toml` | `^1.3.0` | 1.9.1 | Codex config.toml 结构化读写 |

dev 工具链锁定：`typescript` 5.9.3、`esbuild` 0.24.2、`vitest` 2.1.9。

## 仓库结构

```
packages/core/     @worktable/core 可移植核心（Store/配置/db/migrations/hosts/web/cli）+ worktable bin
packages/mcp/      @worktable/mcp MCP stdio 适配层（10 工具 + 2 prompt）
scripts/           构建与生成链（build / gen-migrations / gen-catalog / gen-skill / verify-boundaries）
skills/worktable/ SKILL.md 纪律层源文件（T04 交付；构建注入版本号与工具数）
adapters/install/  install.sh 安装事务（T04 交付）
docs/              PRD / ARCHITECTURE / tool-catalog（生成物）
plugin/            分发产物目录（生成物，gitignore）
```

## 门禁（`npm run verify:*`，架构 §7.6）

T01 起可用：`verify:typecheck`、`verify:module-boundaries`、`verify:catalog`。
随任务交付：`verify:core` / `verify:concurrency` / `verify:embedded` / `verify:datahome`（T02）、`verify:mcp`（T03）、`verify:skill` / `verify:install` / `verify:host:cc` / `verify:host:wb`（T04–T05）。
宿主实测握手（`verify:host:*`）为本地门禁，不入 CI；CI 以 mock 宿主目录替代（架构 R-2/R-3）。

## 相关文档

- 《Agent-WorkTable P0 产品需求文档》（`docs/PRD.md`）
- 《Agent-WorkTable P0 架构设计》（`docs/ARCHITECTURE.md`）
