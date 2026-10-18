#!/usr/bin/env bash
# Agent-WorkTable 安装事务（PRD P0-7 / 定稿 §10）：
#   discover → plan(--dry-run 可先看) → write(备份/原子/复验) → doctor 复验
#
# 用法：
#   ./install.sh              # 交互安装
#   ./install.sh --dry-run    # 只列计划不写入
#   ./install.sh --home <dir> # 指定 dataHome（默认 ~/.worktable）
#
# 纪律：
#   - 写宿主配置前备份 <path>.worktable.backup（已有备份绝不覆盖）
#   - 结构化写入 + readback 复验（复用 core 的写入器，禁 grep 拼文本）
#   - 解析既有宿主配置失败 → 降级模板 + 告警，绝不损坏用户配置
#   - 未安装的宿主跳过并明示；硬性验收仅 Claude Code 与 WorkBuddy

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
DATA_HOME="${HOME}/.worktable"
DRY_RUN=0

# ---------- 参数 ----------
while [[ $# -gt 0 ]]; do
  case "$1" in
    --dry-run) DRY_RUN=1; shift ;;
    --home) DATA_HOME="$2"; shift 2 ;;
    -h|--help) sed -n '2,10p' "$0"; exit 0 ;;
    *) echo "未知参数：$1（--dry-run / --home <dir>）"; exit 2 ;;
  esac
done

MCP_BUNDLE="${REPO_ROOT}/packages/mcp/dist/mcp.js"
if [[ ! -f "${MCP_BUNDLE}" ]]; then
  echo "[install] 缺少 ${MCP_BUNDLE}——先在仓库根跑 npm ci && npm run build"
  exit 1
fi

SKILL_SRC="${REPO_ROOT}/plugin/skills/worktable/SKILL.md"
if [[ ! -f "${SKILL_SRC}" ]]; then
  echo "[install] 缺少 ${SKILL_SRC}——先 npm run gen:skill（构建注入版 SKILL.md）"
  exit 1
fi

echo "[install] 仓库：${REPO_ROOT}"
echo "[install] dataHome：${DATA_HOME}"
echo "[install] MCP bundle：${MCP_BUNDLE}"
echo

# ---------- discover + plan ----------
# 宿主探测：只看配置文件/目录是否存在（存在 = 用户在用这个宿主）
declare -a HOSTS_FOUND=()
declare -a HOSTS_SKIPPED=()

detect() {
  [[ -f "$1" ]] || [[ -d "$1" ]]
}

CC_CONFIG="${HOME}/.claude.json"
WB_CONFIG="${HOME}/.workbuddy/mcp.json"
HERMES_CONFIG="${HOME}/.hermes/config.yaml"
CODEX_CONFIG="${HOME}/.codex/config.toml"

detect "${CC_CONFIG}"   && HOSTS_FOUND+=("claude-code")   || HOSTS_SKIPPED+=("claude-code")
detect "${WB_CONFIG}"   && HOSTS_FOUND+=("workbuddy")    || HOSTS_SKIPPED+=("workbuddy")
detect "${HERMES_CONFIG}" && HOSTS_FOUND+=("hermes")     || HOSTS_SKIPPED+=("hermes")
detect "${CODEX_CONFIG}"  && HOSTS_FOUND+=("codex")      || HOSTS_SKIPPED+=("codex")

echo "[discover] 已安装宿主：${HOSTS_FOUND[*]:-无}"
echo "[discover] 未安装（跳过）：${HOSTS_SKIPPED[*]:-无}"
echo "[discover] dsh：仅模板 + 文档（适配留 P1-5，见 adapters/install/templates/dsh/）"
echo

# 计划由 core 写入器执行（结构化，本脚本不拼 JSON/YAML/TOML 文本）
PLAN_NOTE="将写入 mcpServers.worktable → ${MCP_BUNDLE}；SKILL.md 拷贝到各宿主 skills 目录"
echo "[plan] ${PLAN_NOTE}"
if [[ "${DRY_RUN}" -eq 1 ]]; then
  echo "[plan] --dry-run：不写入，退出。"
  exit 0
fi

# ---------- write（经 core 写入器：备份/原子/复验/回滚）----------
WRITE_JS="$(cat <<'EOF'
const { writeHostConfig, worktableServerEntry, HOST_REGISTRY, HostConfigParseError } = require('@worktable/core');
const fs = require('node:fs');
const path = require('node:path');

const home = process.argv[2];
const repoRoot = process.argv[3];
const entry = worktableServerEntry(repoRoot);

const targets = {
  'claude-code': path.join(home, '.claude.json'),
  workbuddy: path.join(home, '.workbuddy', 'mcp.json'),
  hermes: path.join(home, '.hermes', 'config.yaml'),
  codex: path.join(home, '.codex', 'config.toml'),
};
const hosts = process.argv.slice(4);
const results = [];
const degraded = [];

(async () => {
  for (const hostId of hosts) {
    const registry = HOST_REGISTRY.find((h) => h.hostId === hostId);
    if (!registry || registry.action === 'template-only') continue;
    const writer = registry.create(home);
    try {
      const result = await writeHostConfig(writer, { homeDir: home, serverKey: 'worktable', entry });
      results.push({ hostId, ...result });
    } catch (error) {
      if (error instanceof HostConfigParseError) {
        degraded.push({ hostId, path: targets[hostId], reason: error.message });
      } else {
        throw error;
      }
    }
  }
  console.log(JSON.stringify({ results, degraded }, null, 2));
})().catch((error) => {
  console.error(String(error));
  process.exit(1);
});
EOF
)"

echo "[write] 经 core 结构化写入器写入宿主配置……"
WRITE_OUTPUT="$(cd "${REPO_ROOT}" && node --input-type=commonjs -e "${WRITE_JS}" "${HOME}" "${REPO_ROOT}" ${HOSTS_FOUND[@]:-} 2>&1)" || {
  echo "[write] 失败：${WRITE_OUTPUT}"
  exit 1
}
echo "${WRITE_OUTPUT}"

# SKILL.md 拷贝（已装宿主的 skills 目录）
copy_skill() {
  local dest_dir="$1"
  if [[ -d "$(dirname "${dest_dir}")" ]]; then
    mkdir -p "${dest_dir}"
    cp "${SKILL_SRC}" "${dest_dir}/SKILL.md"
    echo "[skill] → ${dest_dir}/SKILL.md"
  fi
}
[[ -d "${HOME}/.claude" ]] && copy_skill "${HOME}/.claude/skills/worktable"
[[ -d "${HOME}/.workbuddy" ]] && copy_skill "${HOME}/.workbuddy/skills/worktable"
[[ -d "${HOME}/.hermes" ]] && copy_skill "${HOME}/.hermes/skills/worktable"

echo
echo "[doctor] 复验……"
echo "  1) 结构化复验（已由写入器 readback 完成，见上方 verified 字段）"
echo "  2) Claude Code 隔离握手："
echo "     claude -p '列出你的 worktable 工具' --mcp-config <(node -e \"console.log(JSON.stringify({mcpServers:{worktable:{command:'node',args:['${MCP_BUNDLE}']}}}))\") --strict-mcp-config"
echo "     预期：工具列表含 mcp__worktable__*（数量以 docs/tool-catalog.md 为准）"
echo "  3) WorkBuddy：重启会话后工具列表应出现 mcp__worktable__*（人工确认，记录到 docs/E2E-CHECKLIST.md）"
echo
echo "[install] 完成。首次使用：worktable init --home ${DATA_HOME} --yes"
