# Agent-WorkTable P0 产品需求文档（PRD）

> 版本：v1.0 · 2026-10-18 · 作者：许清楚（产品经理）
> 上游依据：《worktable 跨宿主插件开发方案》（2026-10-18 定稿）。本 PRD 的所有架构结论以该定稿为准，不发明冲突架构；定稿未覆盖的产品层细节（端口、UI 文案、CLI 交互流程）由本 PRD 补齐。

---

## 0. 项目信息

| 项 | 值 |
|---|---|
| 语言 | 简体中文 |
| 编程语言 | Node.js + TypeScript（esbuild 单 bundle；`pg` + `embedded-postgres`） |
| 项目名 | agent_worktable |
| 仓库 | https://github.com/qiehk2012/Agent-WorkTable.git |
| 交付性质 | **P0 可运行垂直切片**（定稿方案 P0 全量子集，见 §3.0 偏差说明） |

**原始需求复述**：跨 DeepSeek Harness（dsh）/ Hermes / WorkBuddy / Claude Code / Codex 五宿主的工作台插件——Postgres 单一事实源 + MCP 工具层 + Skill 纪律层 + 每宿主薄适配层 + L1.5 自带 localhost web UI。核心功能：项目注册表、项目↔会话绑定、控制室状态网格、产物挂载协议。

---

## 1. 产品目标与定位

### 1.1 一句话定位

把「项目注册表 + 会话绑定 + 控制室状态 + 产物挂载协议」抽成与宿主无关的可移植核心，五宿主经 MCP/CLI 读写同一份 Postgres 状态；UI 按宿主能力诚实降级：L3 结构化文本是地板，L1.5 自带 web UI 是本期保底可视化，注入式适配（dsh/Hermes）留 P1。

### 1.2 产品目标（本期 P0）

| # | 目标 | 衡量标准 |
|---|---|---|
| G1 单一事实源 | 五宿主经 MCP/CLI 读写同一 Postgres；状态不存浏览器缓存、不存宿主私有目录 | 换宿主 / 清宿主配置后 `worktable_status` 数据一致；磁盘上不存在第二份运营状态文件 |
| G2 端到端最小闭环 | 安装 → 初始化数据库 → 建项目 → 绑定 → 挂载产物 → 控制室可见，全链路可跑 | §3.1 P0-11 验收全过；Claude Code 与 WorkBuddy 两个宿主实测 |
| G3 团队化地基 | embedded 单人默认 + `WORKTABLE_DATABASE_URL` 外部接入；凭证绝不进插件包 | 同一 bundle 指向外部库即团队模式；`projects.created_by` 审计列就位 |

### 1.3 演进路线（个人本地工作台 → 团队共享）

| 阶段 | 状态层 | UI 层 |
|---|---|---|
| **本期 P0** | 个人本地工作台：embedded PG，数据不出本机 | L3 文本仪表盘 + L1.5 自带 web UI（只读控制室） |
| P1 | 同库；events 轻量账本启用 | L1（dsh 注入）/ L2.7（Hermes dashboard 注入） |
| P2 | serve 常驻模式（同一库） | NOTIFY→WS 实时推送 + MCP Apps 面板 |
| P3 | 团队档位（Compose / 外部实例 + RLS 评估） | 多人一份状态 |

---

## 2. 目标用户与核心场景

### 2.1 目标用户

嵌入式 IoT 开发者（单人，macOS 主力机），并行管理 5 个项目：**双足机器人 / BK7258 摄像头 / 安邻记忆 / microduck / AIGC**，在 Claude Code / WorkBuddy / Codex / dsh / Hermes 多个宿主与 Agent 协作。核心痛点：

- 项目散在各宿主的对话记忆里，换宿主即「失忆」；
- Agent 干完活的结果只留在对话里，关窗即丢；
- 想知道「哪个项目什么状态」要挨个会话翻。

### 2.2 用户故事（P0）

| # | 用户故事 |
|---|---|
| US1 | As a 并行管理多项目的 IoT 开发者，I want 在任意宿主读写同一份项目注册表，so that 项目清单只有一份、换宿主不失忆 |
| US2 | As a 让 Agent 干活的开发者，I want 把当前会话绑定到具体项目并上报三态（working / needs-you / done），so that 控制室一眼可见各项目进展，无需口头汇报 |
| US3 | As a 需要可视化结果的开发者，I want Agent 按产物协议把结果挂载进项目并登记，so that 结果不随对话消失、随时可回看 |
| US4 | As a 多宿主用户，I want 一条 install.sh 安全写好各宿主配置并自带 localhost 控制室，so that 不用手工抄配置、写错了能回滚 |
| US5 | As a 未来与队友共享状态的开发者，I want 数据放在独立 Postgres 而非宿主目录，so that 团队共享只是换一条连接串 |

---

## 3. 需求池

### 3.0 范围判定与对定稿方案的偏差（必读）

定稿方案 P0 为约 3 周全量（core + mcp 12 工具 + cli + L1.5 + skill + install.sh + 四宿主配置）。本次交付为其**垂直切片子集**，端到端打通「安装 → 初始化数据库 → 建项目 → 绑定 → 挂载产物 → 控制室可见」。偏差如下：

| 项 | 定稿 P0 | 本次切片 | 理由 |
|---|---|---|---|
| MCP 工具数 | 12 | **10**（`layout` 留 P1、`export`/`import` 留 P3） | 垂直链路不需要；工具 catalog 与 SKILL.md 为生成物，禁硬编码工具数 |
| 宿主配置实测 | Hermes / WorkBuddy / CC / Codex 四宿主 | **Claude Code + WorkBuddy 实测写入**；Hermes / Codex 探测到即写（否则模板+文档）；dsh 仅模板+文档 | 任务约束的最低覆盖；dsh 适配本身属 P1 |
| `backup` / `relocate` | P0 | P1 | 切片期用 pg_dump 手工兜底 + 文档 |
| events 业务写入 | P3 | P3（表结构随 `001_init` 预留建表） | 与定稿一致 |
| serve 常驻模式 | P2 | P2 | 与定稿一致 |

### 3.1 P0 需求池（用户故事 + 验收标准 + 优先级理由）

| ID | 需求 | 用户故事 | 验收标准（可测试） | 优先级理由 |
|---|---|---|---|---|
| P0-1 | core 状态层与迁移 | US1 | ① 空库执行 `worktable migrate` 建出 6 张表（`meta`/`projects`/`bindings`/`panes`/`artifacts`/`events`），`schema_migrations` 记录 version 与 checksum；② 重复执行幂等；③ 迁移文件被手改后 checksum 不符 → 明确报错、不静默续跑；④ 全部 SQL 收敛在 Store 模块，`verify:module-boundaries` 绿 | 单一事实源是全部功能的地基；schema 一次建对避免 P1/P3 返工 |
| P0-2 | embedded 集群与连接解析 | US1 / US4 | ① `worktable pg init` 一键在 `<dataHome>/pgdata` 起库（unix socket 优先，回落 `127.0.0.1:55432`）；② 连接解析链 env `WORKTABLE_DATABASE_URL` > `config.yaml` > embedded 默认，`verify:datahome` 绿；③ 未初始化时 MCP 工具返回 `setup-required` + 候选清单，不静默默认；④ 连不上返回 `db-unavailable` + 恢复建议；⑤ 五宿主并发 init 由文件锁保证只有一个成功 | Postgres 是硬前提（定稿 §4.1）；「数据在哪」可配，但行为必须显式 |
| P0-3 | MCP server 与错误契约 | US1 / US2 / US3 | ① 隔离配置握手（CC / WB）列出 **10 个工具 + 2 个 prompt**；② 12 个错误码投影有快照测试（`verify:mcp`）；③ stdio 协议通道零交互输出（不弹任何选择）；④ `update_project` 删除路径：缺 `confirm` 拒绝，确认后级联清零且磁盘目录不动 | MCP 是五宿主唯一共同入口；错误契约是 No fallback 纪律的落点 |
| P0-4 | CLI 最小集 | US4 | ① `init / migrate / pg / doctor / new / ls / open / bind / status / mount / check / ui` 全部可用、退出码正确；② `doctor` 首行输出 dataHome、连接方式、运行模式、schema 版本；③ CLI 与 MCP 共用 core 组合根，行为一致 | stdio 不能弹交互，数据位置选择只能走 CLI（定稿 §4.1）；CI 与 install.sh 都调 CLI |
| P0-5 | L1.5 控制室 web UI（只读） | US3 | ① MCP server 运行期间 `127.0.0.1:<port>` 可开（默认 55433，可配）；② 项目卡片网格显示 name / icon / 三态 / host / lastEvent；③ 点卡片见产物列表，html 于 sandbox iframe 渲染，markdown / image / file 可查看；④ 顶栏显示实例信息（dataHome、连接方式、schema 版本）；⑤ 状态 5s 内自动刷新；⑥ 仅绑 127.0.0.1、无凭证、CSP 收紧 | 定稿 §8.3 明确「建议并入 P0」——它是全部宿主（含 CLI）的可视化保底 |
| P0-6 | SKILL.md 纪律层 | US1 / US2 / US3 | ① 一份源文件，构建时注入版本号与工具数，全文无 `@latest`；② frontmatter `name: worktable`；③ 装入 `~/.claude/skills/` 与 `~/.workbuddy/skills/` 后被宿主识别；④ 五段式工作流写入（先路由 → 绑定优先 → 产物协议 → 状态上报 → status 收尾） | dsh-worktable 最大不可靠点即缺纪律层；这是「结果必须落盘」的唯一保障 |
| P0-7 | install.sh 安装事务 | US4 | ① discover 识别已装宿主；② `--dry-run` 列出每宿主写入计划；③ 写入前备份 `<path>.worktable.backup`（已有备份绝不覆盖）；④ 原子写 + readback 比对，不一致即回滚；⑤ doctor 复验：CC / WB 隔离握手见 10 工具 + skill frontmatter 校验；⑥ 重复安装幂等 | 五宿主配置格式各异（JSON / YAML / TOML），事务是安装不出事的最低保障（定稿 §10） |
| P0-8 | 宿主配置写入（CC + WB 实测） | US1 / US4 | ① Claude Code：`~/.claude.json` 顶层 `mcpServers.worktable` + `~/.claude/skills/worktable/`，隔离握手见 10 工具；② WorkBuddy：`~/.workbuddy/mcp.json` `mcpServers` + `~/.workbuddy/skills/worktable/`，会话工具列表出现 `mcp__worktable__*` 10 个；③ Hermes / Codex：探测到即写（结构化解析后枚举 key 复验，禁 grep 验嵌套配置），未探测到交付模板 + 文档；④ dsh：仅模板 + 文档 | 任务指定的最低宿主覆盖；写入形态沿用定稿 §7.2 / §7.3 / §7.4 / §7.5 |
| P0-9 | 产物挂载协议 | US3 | ① `entry` 为项目内相对路径时，单事务写 `panes` + `artifacts` 两行并返回 `art_` id + `mountUri`；② payload 文件真实存在于 `<project>/.worktable/artifacts/`；③ `entry` 含 `../`、绝对路径或 symlink 逃逸 → `path-escape`，库中零写入；④ bindingId 进 `panes` 复合主键，晚到写入不覆盖新绑定（并发用例验证） | 产物协议是跨宿主通用的核心价值（定稿 F5）；路径收容是安全底线 |
| P0-10 | 绑定与状态机 | US2 | ① `bind_session` 返回 `bnd_` id + revision=1；② 同项目第二个 active binding → `binding-conflict`（数据库部分唯一索引保证）；③ `force=true` 顶替并将旧 binding 置 done；④ `update_status` 带错误 `expectedRevision` → `revision-conflict`；⑤ 两进程并发 bind 一成一败；⑥ 三态 working / needs-you / done 全链路在控制室可见 | 控制室的数据来源；唯一索引 + 乐观并发是定稿 §4.3 / §4.4 的数据库层保证 |
| P0-11 | 端到端垂直链路（DoD） | US1–US5 | ① 干净 macOS 机器：一条 `install.sh` → `worktable init` → CC 会话内 list / new / bind / mount / status 全过 → 浏览器打开 `uiUrl` 见项目与产物 → `worktable check` 全绿；② 同一数据库在 WorkBuddy 宿主可见完全相同状态；③ 清除宿主配置重装后数据仍在（证明事实源在 Postgres 不在宿主目录） | 本次交付的定义性验收 |

### 3.2 P1（下一期）

| ID | 需求 | 来源 |
|---|---|---|
| P1-1 | `worktable_layout` 工具（`panes.layout` JSONB 读写；CLI 宿主存而不用） | 定稿 F4 |
| P1-2 | `worktable backup`（pg_dump -Fc）与 `worktable relocate`（换 dataHome 带迁移） | 定稿 §13 |
| P1-3 | `uninstall.sh` 逆序回滚（备份恢复） | 定稿 §10 |
| P1-4 | 项目目录不可写时 payload 降级 `<dataHome>/artifacts/<projectId>/` + 明确提示 | 定稿 §4.1 |
| P1-5 | dsh 适配（Cordis 插件：服务端薄转调 + web 客户端；Windows 完整验收、macOS 冒烟） | 定稿 §7.1 |
| P1-6 | Hermes dashboard 插件（sidebar slot + 控制室 tab + `plugin_api.py` 直查同库，与 L1.5 共享前端代码） | 定稿 §7.2 |
| P1-7 | WorkBuddy 内置浏览器预览面板接入（Skill 指导 Agent 把 `uiUrl` 交给预览面板） | 定稿 §7.3 / §8.5 |
| P1-8 | events 账本业务写入与轻量查询（force 顶替留痕等） | 定稿 F7 |

### 3.3 P2

| ID | 需求 | 来源 |
|---|---|---|
| P2-1 | `worktable serve` 常驻模式（launchd/systemd、Streamable HTTP、NOTIFY→WS 推送、端口冲突明确报错不静默换） | 定稿 §4.4 |
| P2-2 | MCP Apps 面板（`ui://worktable/control-room`；必须同时返回 text；不支持的宿主 `host-unsupported` 明示） | 定稿 §8.4 L2 |
| P2-3 | WorkBuddy 内联 widget 仪表盘（`com.workbuddy.worktable/` 命名空间） | 定稿 §7.3 |
| P2-4 | L1.5 web UI 有限写入（建项目 / 改状态） | 定稿 §8.3 |

### 3.4 P3

| ID | 需求 | 来源 |
|---|---|---|
| P3-1 | `worktable_export` / `import` + 备份恢复演练 | 定稿 §13 |
| P3-2 | 终端窗格（进程所有权全套：run token / Job Object / DACL） | 定稿 F6 / §11 |
| P3-3 | 团队档位：Docker Compose 模板 + 部署文档 + RLS 评估 | 定稿 §4.6 |
| P3-4 | 五宿主全量 `verify:*` 矩阵 + tgz 发布 + `plugin.json` 官方 schema 校验 | 定稿 §12 / §13 |

---

## 4. P0 功能规格

### 4.1 MCP 工具规格（全集 12 个；本期实现 10 个）

传输：stdio（模式 A）。工具名前缀由宿主决定（`mcp__worktable__*`）。

| # | 工具 | 参数 | 返回 | 主要错误码 | 本期范围 |
|---|---|---|---|---|---|
| 1 | `worktable_list_projects` | `includeHidden?: boolean`（默认 false） | 项目数组 + 每项状态摘要（active binding、pending 产物数、最近活动时间） | `setup-required`、`db-unavailable`、`schema-mismatch` | P0 |
| 2 | `worktable_open_project` | `projectId` 或 `name`（二选一，必填） | `{ folder, bindings[], artifacts[], recentEvents[] }`；`recentEvents` 随 P1-8 启用，本期返回空数组 | `project-not-found`、`setup-required` | P0 |
| 3 | `worktable_create_project` | `name`、`folder`、`icon?`、`layoutPreset?` | `{ projectId }` | `duplicate-project`；folder 不存在走 MCP 参数校验（invalid params + remediation） | P0 |
| 4 | `worktable_update_project` | `projectId`、`name?`、`icon?`、`order?`、`hidden?`、`delete?`、`confirm?` | 更新后项目；`delete` 需 `confirm: true`，只删注册项（级联清 bindings/panes/artifacts 行），不动文件夹 | `project-not-found`、`duplicate-project`、`revision-conflict` | P0 |
| 5 | `worktable_bind_session` | `projectId`、`host`、`sessionId`、`cwd`、`force?`（默认 false） | `{ bindingId, revision }` | `binding-conflict`、`project-not-found`、`db-conflict` | P0 |
| 6 | `worktable_status` | 无 | 控制室卡片数组 + `uiUrl`（零模型调用，纯本地聚合） | `setup-required`、`db-unavailable` | P0 |
| 7 | `worktable_update_status` | `projectId`、`status: working\|needs-you\|done`、`note?`、`expectedRevision?` | `{ revision }` | `revision-conflict`、`project-not-found` | P0 |
| 8 | `worktable_mount_artifact` | `projectId`、`paneId`、`bindingId`、`title`、`type: html\|markdown\|image\|file`、`entry`（项目内相对路径）、`meta?` | `{ artifactId, mountUri }`；`mountUri = worktable://<paneId>-<bindingId>/<artifactId>` | `path-escape`、`project-not-found`、`db-conflict` | P0 |
| 9 | `worktable_list_artifacts` | `projectId`、`status?: pending\|mounted\|locked` | 产物数组（title / type / status / created_at / payload 路径） | `project-not-found` | P0 |
| 10 | `worktable_layout` | `projectId`、`layout?` | 布局 JSON（`panes.layout` JSONB） | `project-not-found` | P1（本期不实现） |
| 11 | `worktable_check` | 无 | `{ schemaVersion, dbReachable, orphanBindings[], projectDirsWritable[], issues[] }` | `db-unavailable` | P0 |
| 12 | `worktable_export` / `worktable_import` | `projectId?` | 状态包路径 / 导入报告 | `path-escape`、`db-conflict` | P3 |

**关键行为备注**：

1. **工具发现纪律**：本期 catalog 生成 10 个工具；SKILL.md、文档、doctor 中的工具数一律由生成物注入，禁止硬编码「12」（定稿生成物纪律）。
2. **mount_artifact 事务**：① 规范化 `entry` 并做路径收容校验（拒绝 `../`、绝对路径、symlink 逃逸；resolve 后仍须在项目 folder 内）；② 校验 payload 文件存在且可读（不存在 → invalid params + remediation「先落盘再挂载」）；③ 单事务 UPSERT `panes` + INSERT `artifacts`；④ bindingId 进 `panes` 复合主键，晚到写入不覆盖新绑定。
3. **status 卡片字段**：`{ projectId, name, icon, status, host, cwd, lastEvent, pendingArtifacts, preview, updatedAt }`；`preview` 为最近挂载产物的 L1.5 查看链接。`worktable_status` 返回体示例：

```json
{
  "uiUrl": "http://127.0.0.1:55433/",
  "generatedAt": "2026-10-18T10:00:00+08:00",
  "projects": [
    { "projectId": "prj_9f2c…", "name": "双足机器人", "icon": "🤖",
      "status": "working", "host": "claude-code", "cwd": "~/dev/biped",
      "lastEvent": "mounted art_7f3a…", "pendingArtifacts": 0 }
  ]
}
```

4. **2 个 prompt（P0 附带，静态模板）**：`control-room`（把 status 渲染为当前宿主可用形态——CLI 宿主输出 Markdown 表格）；`window-task`（标准窗口任务流：open_project → 干活 → mount_artifact → update_status）。
5. **数据位置选择不进 MCP 工具**（stdio 不能弹交互）：未初始化时统一返回 `setup-required`，由 Agent 在对话中转述候选，用户选定后走 CLI `worktable init` 落 config 或 env（定稿 §4.1 / §5）。

### 4.2 错误契约（12 码，本期全部实现）

统一 discriminated union；`host-unsupported` 是 No fallback 原则的落点——明确失败，不假装成功。

| code | 含义 | retryable | remediation |
|---|---|---|---|
| `setup-required` | dataHome / 数据库连接未配置 | 否 | Agent 列出候选（embedded 本地库 / 外部 URL）请用户选；或 CLI `worktable init`；CI 用 env `WORKTABLE_DATABASE_URL` |
| `db-unavailable` | 连不上 Postgres（embedded 未起 / 外部不可达 / 认证失败） | 是 | `worktable pg start`；检查 `WORKTABLE_DATABASE_URL`；`worktable doctor` 诊断 |
| `db-timeout` | statement / idle 事务超时 | 是 | 稍后重试；排查长事务与慢查询 |
| `db-conflict` | 死锁 / 序列化失败，重试后仍冲突 | 是 | 重试；`worktable check` 查锁等待 |
| `project-not-found` | name / id 不存在 | 否 | 先 `list_projects` |
| `duplicate-project` | name 冲突 | 否 | 换名或 `update_project` |
| `binding-conflict` | 项目已有 active binding | 否 | 先 unbind 或指定 `force`（顶替后旧 binding 置 done，events 留痕随 P1-8） |
| `revision-conflict` | 乐观并发冲突 | 是 | 重新 read-modify-write |
| `path-escape` | 产物路径越出项目目录 | 否 | 修正 `entry` 为项目内相对路径 |
| `schema-mismatch` | 数据库 schema 版本不兼容 | 否 | 跑 `worktable migrate` |
| `host-unsupported` | 当前宿主调了不支持的 UI 能力 | 否 | 明确告知用户，不静默降级（如 CLI 宿主请求注入式 UI → 引导打开 `uiUrl`，即 L1.6 显式兜底） |
| `resource-constraint` | 响应超预算 | 是 | 转错误 + 恢复建议，不截断 |

### 4.3 CLI 命令清单

输出约定：默认人类可读（简体中文），`--json` 机器可读；错误写 stderr 并带错误码与 remediation；`doctor` / `check` 输出可直接粘贴求助（定稿 §15 问题五）。

| 命令 | 用途 | 关键参数 / 标志 | 范围 |
|---|---|---|---|
| `worktable init` | 首次初始化：选 dataHome、起 embedded、跑迁移 | `--home <dir>`、`--database-url <url>`、`--yes`（非交互） | P0 |
| `worktable pg init\|start\|stop\|status` | embedded 集群生命周期 | `--port`（默认 55432） | P0 |
| `worktable migrate` | 应用 / 查看迁移 | `--status` | P0 |
| `worktable doctor` | 一页诊断（dataHome / 连接 / 模式 / schema 版本 / 端口） | — | P0 |
| `worktable new <name>` | 建项目 | `--folder <path>`（必填，须已存在）、`--icon` | P0 |
| `worktable ls` | 项目列表 | `--all`（含隐藏）、`--json` | P0 |
| `worktable open <id\|name>` | 打印项目完整上下文 | `--json` | P0 |
| `worktable bind <id\|name>` | 绑定会话 | `--host`、`--session`、`--cwd`（默认 `process.cwd()`）、`--force` | P0 |
| `worktable status` | 控制室（Markdown 表格） | `--json` | P0 |
| `worktable mount <projectId>` | 挂载产物 | `--pane`、`--binding`、`--title`、`--type`、`--entry` | P0 |
| `worktable check` | 一致性报告 | `--json` | P0 |
| `worktable ui` | 打印 `uiUrl` 并尝试系统浏览器打开（`open` / `xdg-open` / `start`） | `--no-open` | P0 |
| `worktable backup` / `worktable relocate` | 备份 / 换 dataHome 带迁移 | — | P1 |
| `worktable export` / `import` | 跨机迁移 | — | P3 |

### 4.4 L1.5 web UI 最小页面规格（控制室单页，只读）

| 项 | 规格 |
|---|---|
| 监听 | 仅 `127.0.0.1` 回环；默认端口 **55433**（避开 embedded PG 的 55432）；`WORKTABLE_WEB_PORT` / `config.yaml` 可配；端口占用则明确报错并建议换端口，不静默换 |
| 生命周期 | 跟随 MCP server 进程（stdio 会话期间可用）；`worktable ui` 可主动拉起并打开浏览器 |
| 页面 | 单页 `/`：顶栏实例信息 + 项目卡片网格 + 项目详情（绑定信息 + 产物列表 + 产物查看） |
| 状态徽标文案 | working = 进行中（蓝）；needs-you = 待你决策（橙）；done = 已完成（灰） |
| 空状态文案 | 「还没有项目。用 `worktable new` 创建，或让 Agent 调用 `worktable_create_project`」 |
| 产物渲染 | html → `sandbox="allow-scripts"` iframe（不给 `same-origin`，防产物页触碰 L1.5 接口）；markdown → 渲染文本；image → `<img>`；file → 下载链接 |
| 刷新 | 5s 轮询 `/api/status`（WS 实时推送留 P2 serve 模式） |
| 写入 | 本期只读；有限写留 P2 |
| 安全 | 无登录、无凭证；payload 静态路由同样过路径收容校验；CSP 收紧 |

内部 API（页面同源 fetch）：

| 路由 | 返回 |
|---|---|
| `GET /` | 控制室单页（内联静态资源） |
| `GET /api/status` | 与 `worktable_status` 同构 JSON |
| `GET /api/projects/:id` | 项目 + bindings + artifacts |
| `GET /a/:artifactId/<path>` | payload 静态文件（收容校验） |

---

## 5. 非目标（明确不做）

- 不做插件市场 / 注册中心 / 安装器生态（Agent Plugins 1.0.0 本身也没有）。
- 不做多设备实时同步与冲突合并（本期单实例；团队共享 = 同一 Postgres 直连；跨机迁移走 export/import + pg_dump，P3）。
- 不自带终端 / 浏览器 / 动画窗格（锁到 P3，防范围蔓延）。
- 不做分栏工作区与 `worktable_layout`（P1）。
- 不做 dsh / Hermes 注入适配（P1）；本期 dsh 仅配置模板 + 文档。
- 不做 `worktable serve` 常驻模式 / 守护进程 / WS 推送（P2）。
- 不做 MCP Apps 面板与 WorkBuddy 私有内联 widget（P2）。
- 不做 events 账本查询与审计报表（P3；表结构本期预留）。
- 不做 `backup` / `relocate` / `export` / `import` 命令（P1 / P3）。
- 不做 RLS / 组织 / 邀请 / SSO（v2 之后；本期 `created_by` 审计列 + 全员可见）。
- 不做 UI 写入操作与登录鉴权（P0 web UI 只读、无凭证）。
- 不做 npm 发布（分发走 GitHub Releases tgz + 目录直拷，定稿 §9）。
- 不借鉴 REA 的五级 authority / ResidualUnknown / 三 Ledger 审计体系（定稿 §11）。

---

## 6. 待确认问题裁决记录（主理人 齐活林，2026-10-18）

| # | 问题 | 裁决 | 理由与执行口径 |
|---|---|---|---|
| 1 | L1.5 默认端口 | **批准 55433** | 与 embedded PG 的 55432 连续相邻、无常见服务冲突；架构师写入 `config.yaml` 示例，`WORKTABLE_WEB_PORT` env 可覆盖；端口被占用时明确报错并建议换端口，不静默换（PRD §4.4 口径不变） |
| 2 | Hermes / Codex 配置写入深度 | **探测到即写、否则模板 + 文档** | 与定稿 §7.2 / §7.5 一致。两条护栏：① 写入必须走与 CC / WB 同一套结构化配置写入器（原子写 + `.worktable.backup` 备份 + readback 比对）；解析既有宿主配置失败时降级为模板 + 文档 + 明确告警，**绝不静默损坏用户配置**。② install.sh 验收硬性要求仅限 CC + WB 实测握手；Hermes / Codex 写入为 best-effort，doctor 复验不得因宿主未安装而失败 |
| 3 | events 表是否随 `001_init` 预留 | **预留建表，P0 零业务写入** | DDL 与定稿 §4.2 全同；业务写入随 P1-8 启用，避免 P3 返工加表迁移 |
| 4 | 2 个 MCP prompt 是否锁 P0 | **锁 P0** | 纪律层是「结果必须落盘」的行为保障，是本产品成立的关键一环，且成本低（静态模板约 50 行/个）。若排期受压，此为 designated cut line，但默认 P0 |
| 5 | 项目目录只读降级是否提前 | **留 P1，但架构必须留缝** | P0 目标场景为本地可写项目目录。架构上产物存储必须走 resolver 接口（存储位置可扩展），使 P1-4 成为新增一个解析分支而非改动主干 |

以上裁决为下游架构与实现的硬约束，变更须经主理人。

---

## 附：对下游（架构师）的直接输入

- schema：定稿 §4.2 DDL 全量（6 表 + 部分唯一索引 + 复合主键），迁移机制 §4.2。
- 目录：定稿附录 A；本期落地 `packages/core`（含 `src/cli`）、`packages/mcp`、`skills/worktable`、`adapters/install`、`docs/`。
- 安装与错误契约：定稿 §10 / §5.1；宿主配置矩阵：定稿 §2 / §7。
- 验收门禁对应：`verify:core` / `verify:datahome` / `verify:mcp` / `verify:module-boundaries` / `verify:host:*` / `verify:install`（定稿 §12）。
