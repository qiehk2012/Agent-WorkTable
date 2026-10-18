# P0 人工验收清单（E2E-CHECKLIST）

> 自动化已覆盖：`tests/e2e/vertical-chain.test.ts`（4 用例，干净 dataHome 全链路）。
> 本清单记录**需真实宿主参与**的人工验收（架构 R-2/R-3：宿主握手不入 CI）。

## 前置

- [ ] `npm ci && npm run build` 成功
- [ ] `worktable init --yes` 完成（embedded PG 就绪 + 迁移 applied=000,001）

## A. Claude Code 实测握手（P0-7 ⑤ / D-6）

- [ ] `./adapters/install/install.sh --dry-run` 列出写入计划
- [ ] `./adapters/install/install.sh` 写入 `~/.claude.json`（备份 `*.worktable.backup` 生成）
- [ ] 隔离握手：`claude -p '列出你的 worktable 工具' --mcp-config <(只含 worktable 的 json) --strict-mcp-config`
  - [ ] 工具列表含 `mcp__worktable__*`，数量 = `docs/tool-catalog.md` 的工具数（当前 10，**不写死**）
  - [ ] 会话内调 `worktable_status` 返回 uiUrl
- [ ] 重复安装幂等：再跑一次 install.sh，`~/.claude.json` 无重复条目，备份未被覆盖
- [ ] 既有 server（如 rea）保留未动

## B. WorkBuddy 实测握手（GUI 应用——人工会话内确认，D-6 裁决口径）

- [ ] install.sh 写入 `~/.workbuddy/mcp.json`（结构化复验 verified=true）
- [ ] SKILL.md 出现在 `~/.workbuddy/skills/worktable/SKILL.md`（frontmatter `name: worktable`）
- [ ] 重启 WorkBuddy 会话后工具列表出现 `mcp__worktable__*` 10 个
- [ ] 会话内让 Agent 调 `worktable_status`，把 uiUrl 交给内置预览面板打开（L2.5 路线）

## C. 数据事实源验证（P0-11 ② ③）

- [ ] CC 里创建项目 → WB 会话内 `list_projects` 看到同一项目与同一状态
- [ ] 清除两宿主配置（删 `~/.claude.json` 的 worktable 段 + `~/.workbuddy/mcp.json`）重装 → 数据仍在（证明事实源在 Postgres 不在宿主目录）
- [ ] `worktable pg stop` 后浏览器控制室 502/拒绝连接（证明依赖本地 PG，无静默兜底）

## D. L1.5 控制室（P0-5）

- [ ] `worktable ui` 打开 `http://127.0.0.1:55433/`
- [ ] 项目卡片：三态徽标（进行中蓝/待你决策橙/已完成灰）、宿主、最近事件、preview 链接
- [ ] html 产物在 sandbox iframe 内渲染（无 same-origin）
- [ ] 端口占用时（先起一个占 55433 的进程）`worktable ui` 明确报错不静默换端口

## E. 产物协议（P0-9）

- [ ] Agent 试图挂载 `/etc/hosts` → `path-escape`，库中零写入
- [ ] 先落盘再挂载正常路径 → mountUri 返回，控制室可见
- [ ] `worktable check` 报告产物磁盘缺失为 warn（不致命）

## 记录

| 日期 | 验收人 | 通过项 | 备注 |
|---|---|---|---|
| | | | |
