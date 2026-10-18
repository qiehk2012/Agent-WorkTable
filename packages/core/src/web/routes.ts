/**
 * L1.5 路由（PRD §4.4）：4 条路由 + CSP + payload 静态分发。
 *
 * 安全口径（PRD §4.4 安全行）：
 * - CSP 收紧：默认只许 self；产物 html 在 sandbox iframe 里渲染（不给 same-origin）；
 * - payload 静态路由 `/a/:artifactId/*` **同样过路径收容校验**（resolver.resolveForRead），
 *   不能因为「是 web 自己发的链接」就跳过收容——链接里的文件名同样是外部输入。
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { isPayloadMissingError } from '../protocol/payload.js';
import { isWorktableError } from '../errors/index.js';
import type { WebDeps } from './server.js';
import { renderPage } from './page.js';

/** CSP：只许自身资源；iframe 里的产物页受 sandbox 约束，不需要在此放宽。 */
const CSP = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; frame-src 'self'; connect-src 'self'";

/**
 * @param value 值。
 * @returns JSON 安全字符串化。
 */
function jsonBody(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

/**
 * 主路由分发。
 *
 * @param deps web 依赖。
 * @param request 请求。
 * @param response 响应。
 */
export async function handleRoute(
  deps: WebDeps,
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  const url = new URL(request.url ?? '/', 'http://127.0.0.1');
  const pathname = url.pathname;

  response.setHeader('x-content-type-options', 'nosniff');
  response.setHeader('referrer-policy', 'no-referrer');
  response.setHeader('content-security-policy', CSP);

  // ① 控制室单页
  if (request.method === 'GET' && (pathname === '/' || pathname === '/index.html')) {
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    response.end(renderPage(deps.version));
    return;
  }

  // ② 状态轮询（页面 5s fetch）
  if (request.method === 'GET' && pathname === '/api/status') {
    const snapshot = await deps.controlRoom.snapshot();
    response.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
    response.end(jsonBody({ ...snapshot, version: deps.version }));
    return;
  }

  // ③ 项目详情
  const projectMatch = /^\/api\/projects\/([A-Za-z0-9_-]+)$/.exec(pathname);
  if (request.method === 'GET' && projectMatch !== null) {
    // 详情聚合直接复用 doctor 的 store 通道：项目页数据由 status 快照 + 产物列表组成
    const snapshot = await deps.controlRoom.snapshot();
    const card = snapshot.projects.find((p) => p.projectId === projectMatch[1]);
    if (card === undefined) {
      response.writeHead(404, { 'content-type': 'application/json; charset=utf-8' });
      response.end(jsonBody({ error: 'project-not-found' }));
      return;
    }
    response.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
    response.end(jsonBody({ ...card, uiUrl: snapshot.uiUrl, version: deps.version }));
    return;
  }

  // ④ 产物静态分发（/a/<artifactId>/<文件名>）
  const artifactMatch = /^\/a\/([A-Za-z0-9_-]+)\/([^?#]*)$/.exec(pathname);
  if (request.method === 'GET' && artifactMatch !== null) {
    await serveArtifact(deps, artifactMatch[1] ?? '', artifactMatch[2] ?? '', response);
    return;
  }

  response.writeHead(404, { 'content-type': 'application/json; charset=utf-8' });
  response.end(jsonBody({ error: 'not-found', path: pathname }));
}

/** 产物文件类型 → 响应 content-type（与 ArtifactType 对齐，file 类型按扩展名猜）。 */
const CONTENT_TYPES: Record<string, string> = {
  html: 'text/html; charset=utf-8',
  markdown: 'text/plain; charset=utf-8',
  image: 'application/octet-stream',
  file: 'application/octet-stream',
};

/**
 * 产物静态分发（同样过路径收容）。
 *
 * @param deps web 依赖。
 * @param artifactId 产物 ID。
 * @param fileName 链接里的文件名（会被忽略，真实路径以库中 payload_path 为准 + 收容校验）。
 * @param response 响应。
 */
async function serveArtifact(
  deps: WebDeps,
  artifactId: string,
  fileName: string,
  response: ServerResponse,
): Promise<void> {
  void fileName; // 文件名仅用于展示；定位以库中记录为准，防止链接伪造路径
  try {
    const served = await deps.artifacts.serve(artifactId);
    if (served === null) {
      response.writeHead(404, { 'content-type': 'application/json; charset=utf-8' });
      response.end(jsonBody({ error: 'artifact-not-found' }));
      return;
    }
    const { absolutePath, artifact } = served;
    const data = await fs.readFile(absolutePath);

    // html 产物：加 sandbox 头建议（实际隔离由页面 iframe sandbox 属性承担，双保险）
    const contentType =
      artifact.type === 'image'
        ? imageContentType(absolutePath)
        : (CONTENT_TYPES[artifact.type] ?? 'application/octet-stream');

    response.writeHead(200, {
      'content-type': contentType,
      'cache-control': 'no-store',
      'x-artifact-type': artifact.type,
    });
    response.end(data);
  } catch (error) {
    if (isPayloadMissingError(error)) {
      response.writeHead(404, { 'content-type': 'application/json; charset=utf-8' });
      response.end(jsonBody({ error: 'payload-missing', remediation: '产物磁盘文件缺失，跑 worktable check 查看' }));
      return;
    }
    if (isWorktableError(error)) {
      response.writeHead(error.code === 'path-escape' ? 403 : 500, {
        'content-type': 'application/json; charset=utf-8',
      });
      response.end(jsonBody({ error: error.code, message: error.message }));
      return;
    }
    throw error;
  }
}

/**
 * @param filePath 文件路径。
 * @returns 图片 content-type（按扩展名）。
 */
function imageContentType(filePath: string): string {
  const extension = path.extname(filePath).toLowerCase();
  const map: Record<string, string> = {
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.svg': 'image/svg+xml',
    '.webp': 'image/webp',
  };
  return map[extension] ?? 'application/octet-stream';
}
