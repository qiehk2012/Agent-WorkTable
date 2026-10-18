/**
 * ArtifactService（架构 §3.3）：收容校验 + payload 存在校验 + store 事务编排。
 *
 * L3 模块：可依赖 L0–L2（store / protocol / errors）。
 *
 * 为什么先查绑定再挂载：artifacts 外键引用 bindings，缺失会让 PG 抛 23503——
 * 那是一条连约束名都不稳定的底层错误，换成明确的引导性错误码更符合「错误即对话」的原则。
 */
import { WorktableError } from '../errors/index.js';
import { artifactId } from '../ids.js';
import type { Store } from '../store/index.js';
import type { Artifact, ArtifactType } from '../store/types.js';
import type { PayloadResolver } from '../protocol/payload.js';
import type { MountArtifactResult } from '../store/mount.js';

/** 挂载工具入参（MCP/CLI 共用；entry 是项目内相对路径，由 resolver 收容）。 */
export interface MountArtifactServiceInput {
  projectId: string;
  paneId: string;
  bindingId: string;
  title: string;
  type: ArtifactType;
  entry: string;
  meta?: Record<string, unknown>;
}

/** ArtifactService 接口。 */
export interface ArtifactService {
  mount(input: MountArtifactServiceInput): Promise<MountArtifactResult>;
  /** web 静态路由用：定位产物磁盘路径（含收容校验）。 */
  serve(artifactId: string): Promise<{ absolutePath: string; artifact: Artifact } | null>;
}

/**
 * 创建 ArtifactService。
 *
 * @param deps store / resolver。
 * @returns 服务实例。
 */
export function createArtifactService(deps: {
  store: Store;
  resolver: PayloadResolver;
}): ArtifactService {
  const { store, resolver } = deps;

  return {
    async mount(input: MountArtifactServiceInput): Promise<MountArtifactResult> {
      const project = await store.getProject({ projectId: input.projectId });
      if (project === null) {
        throw new WorktableError('project-not-found', `项目不存在：${input.projectId}`, undefined, false, {
          projectId: input.projectId,
        });
      }

      const bindings = await store.listBindings(input.projectId);
      const binding = bindings.find((b) => b.binding_id === input.bindingId);
      if (binding === undefined) {
        throw new WorktableError(
          'binding-conflict',
          `会话绑定不存在：${input.bindingId}`,
          '先用 worktable_bind_session 在当前项目建立绑定，再挂载产物',
          false,
          { projectId: input.projectId, bindingId: input.bindingId },
        );
      }

      // resolver 负责五步收容 + payload 存在校验（抛 path-escape / PayloadMissingError）
      const resolved = await resolver.resolveForWrite(project, input.entry);

      return store.mountArtifact({
        artifactId: artifactId({
          projectId: input.projectId,
          paneId: input.paneId,
          bindingId: input.bindingId,
          payloadPath: resolved.storedRef,
        }),
        projectId: input.projectId,
        paneId: input.paneId,
        bindingId: input.bindingId,
        title: input.title,
        type: input.type,
        payloadPath: resolved.storedRef,
        ...(input.meta === undefined ? {} : { meta: input.meta }),
      });
    },

    async serve(artifactId: string): Promise<{ absolutePath: string; artifact: Artifact } | null> {
      const artifact = await store.getArtifactById(artifactId);
      if (artifact === null) return null;
      const project = await store.getProject({ projectId: artifact.project_id });
      if (project === null) return null;
      const absolutePath = await resolver.resolveForRead(project, artifact.payload_path);
      return { absolutePath, artifact };
    },
  };
}
