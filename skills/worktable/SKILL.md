---
name: worktable
description: 跨宿主工作台：项目注册表 + 会话绑定 + 控制室状态 + 产物挂载。任何有落盘产物的任务都应走本 skill 的工作流，让结果可追踪、可在控制室查看。
---

# WorkTable 工作台

> 版本：{{VERSION}} · MCP 工具：{{TOOL_COUNT}} 个（以 docs/tool-catalog.md 为唯一事实源）

## 你是谁的管家

你在宿主会话里管理「项目 ↔ 会话 ↔ 产物」三件事。所有状态存在本地 Postgres（`~/.worktable/`），换宿主不丢。

## 硬性纪律

1. **先路由再动手**：任何会产出文件的任务开始前，先 `worktable_open_project`；项目不存在就问用户是否创建（`worktable_create_project` 需要 folder，先确认目录已存在）。
2. **绑定优先**：动手前 `worktable_bind_session` 把本会话绑到项目。冲突说明别的会话在干活——问用户是否 force 顶替，不要自作主张。
3. **产物必须落盘再挂载**：产物先写到 `<项目目录>/.worktable/artifacts/<相对路径>`，然后 `worktable_mount_artifact`。entry 永远是项目内相对路径——绝对路径、`..`、symlink 逃逸都会被拒（path-escape，零写入）。
4. **如实上报状态**：任务要用户决策 → `worktable_update_status` 置 `needs-you` 并在 note 写清要用户做什么；完成 → `done`。**不要静默降级，不要谎报成功**。
5. **status 收尾**：任务结束前 `worktable_status`，把 uiUrl 告诉用户（浏览器打开即控制室）。

## 标准窗口任务流

```
open_project（没有则 create + bind）
  → 执行任务，产物落盘 .worktable/artifacts/
  → mount_artifact（相对路径）
  → update_status（needs-you / done + note）
  → status（uiUrl 给用户）
```

## 错误即对话

工具失败时错误码自带恢复建议，照着 `remediation` 行动或转述给用户，不要盲目重试：

| 码 | 含义 | 你该做的 |
|---|---|---|
| setup-required | 未初始化 | 转述候选位置，让用户跑 `worktable init` |
| db-unavailable / db-timeout | 库不可达/超时 | 建议用户 `worktable pg status` 检查 |
| binding-conflict | 已有活动绑定 | 问用户是否 force 顶替 |
| path-escape | 产物路径越界 | 改为项目内相对路径 |
| project-not-found | 项目不存在 | 先 list_projects 确认名字 |

## 宿主差异

- **有浏览器的宿主**：把 uiUrl 交给用户打开（WorkBuddy 可用内置预览面板）。
- **CLI 宿主**：把 status 结果渲染成 Markdown 表格输出。
- 想要分栏/注入式 UI？那是 P1 的事，当前版本诚实降级到 uiUrl。
