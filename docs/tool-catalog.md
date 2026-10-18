# Agent-WorkTable 工具 Catalog

> 【生成物 · 禁手改】由 `scripts/gen-catalog.mjs` 从 `packages/mcp/src/registry.ts` 生成。
> 工具数是 SKILL.md / doctor / install.sh 握手断言的唯一来源，禁止硬编码（定稿 D-2/D-3）。
> 重新生成：`npm run gen:catalog`；门禁：`npm run verify:catalog`（内存渲染后比对）。

- 工具数：10
- Prompt 数：2

## 工具（10）

| 工具 | 标题 | 说明 | 声明的错误码 |
|---|---|---|---|
| `worktable_list_projects` | 项目列表 | 列出全部项目（含绑定三态、宿主、待挂载数）。控制室网格的数据来源。 | setup-required、db-unavailable、schema-mismatch |
| `worktable_open_project` | 打开项目上下文 | 取项目完整上下文：项目信息 + 绑定历史 + 产物清单。会话开始时的第一步。 | project-not-found、setup-required、db-unavailable |
| `worktable_create_project` | 创建项目 | 注册新项目。folder 必须是已存在的目录（先建目录再注册）。 | duplicate-project、setup-required、db-unavailable |
| `worktable_update_project` | 更新项目 | 改名/图标/排序/隐藏；delete 需 confirm=true（级联清库但磁盘目录不动）。 | project-not-found、duplicate-project、setup-required、db-unavailable |
| `worktable_bind_session` | 绑定会话 | 把当前宿主会话绑到项目（一项目一活动绑定）。冲突时先解绑或 force 顶替。 | binding-conflict、project-not-found、db-conflict、setup-required、db-unavailable |
| `worktable_status` | 控制室状态 | 零模型调用本地聚合：全部项目卡片 + uiUrl（浏览器打开即控制室）。 | setup-required、db-unavailable |
| `worktable_update_status` | 更新绑定状态 | working / needs-you / done 三态推进；带 expectedRevision 做乐观并发。 | revision-conflict、project-not-found、setup-required、db-unavailable |
| `worktable_mount_artifact` | 挂载产物 | 把已落盘的产物挂到项目的窗格。entry 为项目内相对路径（先落盘再挂载）。 | path-escape、project-not-found、db-conflict、setup-required、db-unavailable |
| `worktable_list_artifacts` | 产物列表 | 列出项目产物（可按状态过滤）。 | project-not-found、setup-required、db-unavailable |
| `worktable_check` | 体检 | 数据库/schema/目录可写/产物文件在盘 一页诊断。 | db-unavailable、setup-required |

## Prompt（2）

| Prompt | 标题 | 说明 |
|---|---|---|
| `control-room` | 控制室渲染 | 把 worktable_status 的结果渲染为当前宿主可用的形态（CLI 宿主输出 Markdown 表格）。 |
| `window-task` | 标准窗口任务流 | open_project → 干活 → mount_artifact → update_status 的四步纪律。 |
