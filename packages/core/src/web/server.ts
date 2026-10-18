/**
 * L1.5 只读控制室（PRD P0-5 / 架构 §1.4 A2）：node:http 服务器。
 *
 * L4 模块：可依赖 L0–L3。
 *
 * 两条不可破的纪律：
 * - **仅绑 127.0.0.1**：无登录无鉴权，绑到非回环等于把项目数据挂到局域网；
 * - **端口占用明确报错**（EADDRINUSE → db-unavailable 同级的明确失败，带端口号与建议），
 *   绝不静默换端口——换了端口的 uiUrl 会指向别人的服务（No silent fallback）。
 */
import http from 'node:http';
import { AddressInfo } from 'node:net';
import { WorktableError } from '../errors/index.js';
import type { ControlRoomService, DoctorService, ArtifactService } from '../services/index.js';
import { handleRoute } from './routes.js';

/** web 服务依赖。 */
export interface WebDeps {
  controlRoom: ControlRoomService;
  doctor: DoctorService;
  artifacts: ArtifactService;
  version: string;
}

/** 运行句柄。 */
export interface WebHandle {
  port: number;
  url: string;
  close: () => Promise<void>;
}

/**
 * 启动 L1.5 控制室。
 *
 * @param deps 服务依赖。
 * @param port 期望端口（已过三级解析：env > config.yaml > 55433）。
 * @returns 运行句柄。
 */
export function startWebServer(deps: WebDeps, port: number): Promise<WebHandle> {
  return new Promise((resolve, reject) => {
    const server = http.createServer((request, response) => {
      void handleRoute(deps, request, response).catch((error: unknown) => {
        // 兜底：路由层不应抛到这里；真到这里说明是 bug，如实 500 并保留日志线索
        process.stderr.write(`[web] unhandled: ${String(error)}\n`);
        if (!response.headersSent) {
          response.writeHead(500, { 'content-type': 'application/json; charset=utf-8' });
        }
        response.end(JSON.stringify({ error: 'internal' }));
      });
    });

    server.on('error', (error: NodeJS.ErrnoException) => {
      if (error.code === 'EADDRINUSE') {
        reject(
          new WorktableError(
            'db-unavailable',
            `L1.5 端口 ${port} 已被占用`,
            '换端口：设 WORKTABLE_WEB_PORT 或改 <dataHome>/config.yaml 的 web.port；本服务不会静默选择其它端口',
            false,
            { port },
          ),
        );
        return;
      }
      reject(error);
    });

    server.listen(port, '127.0.0.1', () => {
      const bound = server.address() as AddressInfo;
      resolve({
        port: bound.port,
        url: `http://127.0.0.1:${bound.port}/`,
        close: () =>
          new Promise<void>((resolveClose) => {
            server.close(() => resolveClose());
          }),
      });
    });
  });
}
