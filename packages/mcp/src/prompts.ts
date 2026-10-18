/**
 * 2 个 MCP prompt（主理人裁决 4 锁 P0；假设 A-4：静态模板不注入版本号）。
 */
import type { PromptMessage } from './types.js';

/** prompt 定义。 */
export interface PromptDefinition {
  name: string;
  messages: PromptMessage[];
}

export const PROMPTS: readonly PromptDefinition[] = [
  {
    name: 'control-room',
    messages: [
      {
        role: 'user',
        content: {
          type: 'text',
          text: '调用 worktable_status 取控制室快照，然后按当前宿主能力渲染：CLI/TUI 宿主输出 Markdown 表格（列：项目/状态/宿主/最近事件），并把 uiUrl 单独一行给出让用户可在浏览器打开；图形宿主直接引导用户打开 uiUrl。不要编造数据，快照里没有的项目不要出现。',
        },
      },
    ],
  },
  {
    name: 'window-task',
    messages: [
      {
        role: 'user',
        content: {
          type: 'text',
          text: '按标准窗口任务流执行：① worktable_open_project 打开项目上下文（没有就 worktable_create_project + worktable_bind_session）；② 执行用户的任务，产物先写到项目 .worktable/artifacts/ 下的相对路径；③ worktable_mount_artifact 挂载（entry 为项目内相对路径，禁止绝对路径与 ..）；④ worktable_update_status 上报结果（需要用户决策时用 needs-you 并在 note 说明，完成用 done）。中途失败如实报错误码，不要静默降级。',
        },
      },
    ],
  },
];
