/**
 * L1.5 控制室单页（PRD §4.4）：内联 HTML/CSS/JS 模板字符串。
 *
 * 三态徽标 / 5s 轮询 / 产物查看器（html → sandbox iframe 不给 same-origin）。
 * 刻意不用前端框架：单页只读，框架的 bundle 体积与供应链面都是净成本（架构 A2 同款理由）。
 */

/**
 * @param version core 版本号。
 * @returns 完整 HTML 页面。
 */
export function renderPage(version: string): string {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>WorkTable 控制室</title>
<style>
  :root { color-scheme: light dark; }
  * { box-sizing: border-box; }
  body { margin: 0; font-family: -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif; background: #f5f5f7; color: #1d1d1f; }
  header { display: flex; justify-content: space-between; align-items: baseline; padding: 14px 22px; background: #ffffff; border-bottom: 1px solid #e5e5ea; }
  header h1 { font-size: 17px; margin: 0; }
  header .meta { font-size: 12px; color: #86868b; }
  .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(300px, 1fr)); gap: 14px; padding: 18px 22px; }
  .card { background: #ffffff; border: 1px solid #e5e5ea; border-radius: 10px; padding: 14px 16px; cursor: pointer; transition: box-shadow .15s; }
  .card:hover { box-shadow: 0 3px 12px rgba(0,0,0,.08); }
  .card .title { display: flex; align-items: center; gap: 8px; font-size: 15px; font-weight: 600; }
  .card .icon { font-size: 20px; }
  .card .row { margin-top: 6px; font-size: 12.5px; color: #6e6e73; }
  .badge { display: inline-block; padding: 2px 8px; border-radius: 999px; font-size: 11.5px; font-weight: 500; }
  .badge.working { background: #e8f1ff; color: #0a6cff; }
  .badge.needs-you { background: #fff3e0; color: #c77000; }
  .badge.done { background: #eeeeee; color: #86868b; }
  .badge.idle { background: #f2f2f4; color: #86868b; }
  .empty { padding: 60px 22px; text-align: center; color: #86868b; font-size: 14px; }
  .empty code { background: #ececf0; padding: 2px 6px; border-radius: 5px; }
  dialog { border: none; border-radius: 12px; padding: 0; width: min(860px, 92vw); }
  dialog::backdrop { background: rgba(0,0,0,.35); }
  .detail { padding: 18px 20px; }
  .detail h2 { margin: 0 0 4px; font-size: 16px; display: flex; gap: 8px; align-items: center; }
  .detail .sub { font-size: 12px; color: #86868b; margin-bottom: 12px; }
  .detail h3 { font-size: 13px; color: #6e6e73; margin: 14px 0 6px; }
  .detail ul { margin: 0; padding-left: 18px; font-size: 12.5px; }
  .detail li { margin: 3px 0; }
  iframe.artifact { width: 100%; height: 420px; border: 1px solid #e5e5ea; border-radius: 8px; background: #fff; }
  .preview-link { font-size: 12.5px; }
  footer { padding: 10px 22px 26px; font-size: 11.5px; color: #a1a1a6; }
</style>
</head>
<body>
<header>
  <h1>🪟 WorkTable 控制室</h1>
  <div class="meta"><span id="generated"></span> · 每 5s 自动刷新</div>
</header>
<div id="root"><div class="empty">加载中…</div></div>
<footer>Agent-WorkTable v${escapeHtml(version)} · 只读视图 · 数据来自本地 Postgres</footer>

<dialog id="dlg">
  <div class="detail" id="detail"></div>
</dialog>

<script>
'use strict';
var POLL_MS = 5000;

function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
  });
}
window.escapeHtml = escapeHtml;

function badge(status) {
  if (status === 'working') return '<span class="badge working">进行中</span>';
  if (status === 'needs-you') return '<span class="badge needs-you">待你决策</span>';
  if (status === 'done') return '<span class="badge done">已完成</span>';
  return '<span class="badge idle">未绑定</span>';
}

function timeOf(value) {
  if (!value) return '—';
  try { return new Date(value).toLocaleString(); } catch (e) { return String(value); }
}

function render(snapshot) {
  var root = document.getElementById('root');
  document.getElementById('generated').textContent = '更新于 ' + timeOf(snapshot.generatedAt);
  if (!snapshot.projects || snapshot.projects.length === 0) {
    root.innerHTML = '<div class="empty">还没有项目。用 <code>worktable new</code> 创建，或让 Agent 调用 <code>worktable_create_project</code></div>';
    return;
  }
  root.innerHTML = '<div class="grid">' + snapshot.projects.map(function (card) {
    var icon = card.icon ? escapeHtml(card.icon) : '📁';
    var preview = card.preview
      ? '<div class="row"><a class="preview-link" href="' + escapeHtml(card.preview) + '" target="_blank">查看最近产物 ↗</a></div>'
      : '';
    return '<div class="card" data-id="' + escapeHtml(card.projectId) + '">'
      + '<div class="title"><span class="icon">' + icon + '</span>' + escapeHtml(card.name) + badge(card.status) + '</div>'
      + '<div class="row">' + (card.host ? escapeHtml(card.host) + (card.cwd ? ' · ' + escapeHtml(card.cwd) : '') : '无活动会话') + '</div>'
      + '<div class="row">最近事件：' + (card.lastEvent ? escapeHtml(card.lastEvent) : '—') + (card.pendingArtifacts > 0 ? ' · 待挂载 ' + card.pendingArtifacts : '') + '</div>'
      + '<div class="row">更新：' + timeOf(card.updatedAt) + '</div>'
      + preview
      + '</div>';
  }).join('') + '</div>';

  Array.prototype.forEach.call(root.querySelectorAll('.card'), function (el) {
    el.addEventListener('click', function () { openDetail(el.getAttribute('data-id')); });
  });
}

function openDetail(projectId) {
  fetch('/api/projects/' + encodeURIComponent(projectId)).then(function (r) { return r.json(); }).then(function (data) {
    var dlg = document.getElementById('dlg');
    document.getElementById('detail').innerHTML =
      '<h2>' + (data.icon ? '<span>' + escapeHtml(data.icon) + '</span>' : '') + escapeHtml(data.name) + badge(data.status) + '</h2>'
      + '<div class="sub">projectId: ' + escapeHtml(data.projectId) + '</div>'
      + (data.preview ? '<h3>最近产物</h3><iframe class="artifact" sandbox="allow-scripts" src="' + escapeHtml(data.preview) + '"></iframe>' : '')
      + '<h3>操作指引</h3><ul><li>绑定会话：<code>worktable_bind_session</code></li><li>挂载产物：<code>worktable_mount_artifact</code>（entry 为项目内相对路径）</li><li>状态更新：<code>worktable_update_status</code></li></ul>';
    dlg.showModal();
  });
}

function tick() {
  fetch('/api/status').then(function (r) { return r.json(); }).then(render).catch(function () {});
}
tick();
setInterval(tick, POLL_MS);
</script>
</body>
</html>
`;
}

// escapeHtml 在模块层给模板注入用（version 是内部字符串，仍转义防意外）
function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] ?? c,
  );
}
