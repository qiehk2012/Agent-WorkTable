/**
 * ControlRoomService（架构 §3.3）：store 聚合数据 + uiUrl 拼装。
 *
 * uiUrl 为什么不能由 store 拼：web 端口是配置层信息，而 store 不允许运行时依赖 config
 * （架构 §7.2 store-l1 规则）。因此 store 只出数据，本服务负责补 uiUrl 与 preview 前缀。
 */
import type { Store } from '../store/index.js';
import type { ControlRoomSnapshot } from '../store/types.js';

/** ControlRoomService 接口。 */
export interface ControlRoomService {
  snapshot(): Promise<ControlRoomSnapshot>;
}

/**
 * 创建 ControlRoomService。
 *
 * @param deps store 与 web 端口。
 * @returns 服务实例。
 */
export function createControlRoomService(deps: { store: Store; webPort: number }): ControlRoomService {
  const { store, webPort } = deps;
  const uiUrl = `http://127.0.0.1:${webPort}/`;

  return {
    async snapshot(): Promise<ControlRoomSnapshot> {
      const data = await store.getControlRoom();
      return {
        uiUrl,
        generatedAt: data.generatedAt,
        projects: data.projects.map((card) => ({
          ...card,
          // store 给的是 `/a/<artifactId>/<入口文件名>` 后缀，这里补全为完整 URL（偏差 D-4 口径）
          preview: card.preview === null ? null : `${uiUrl.slice(0, -1)}${card.preview}`,
        })),
      };
    },
  };
}
