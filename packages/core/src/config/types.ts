/**
 * 配置类型（L1）。所有配置结构在此定型，供 db / store / cli / web 共用。
 */

/** dataHome 三级解析链中，当前生效来源（架构 §4.1）。 */
export type DataHomeSource = 'env' | 'config-json' | 'default';

/** 数据库运行模式。 */
export type DatabaseMode = 'embedded' | 'external';

/** 数据库连接三级解析链中，当前生效来源。 */
export type DatabaseSource = 'env' | 'config-yaml' | 'embedded-default';

/** `<dataHome>/config.yaml` 的最小 schema（架构假设 A-2）。 */
export interface HomeConfigFile {
  database: {
    mode: DatabaseMode;
    /** external 模式必填；embedded 模式缺省时按 embedded 默认 URL 处理 */
    url?: string | undefined;
  };
  web: {
    port: number;
  };
  home: {
    path: string;
    /** 历史 dataHome 路径，供 relocate（P1）与排障追溯 */
    history: string[];
  };
}

/** 数据库连接解析结果（两项之一，绝不静默默认——主理人裁决 D-11）。 */
export type DatabaseResolution =
  | {
      kind: 'ready';
      url: string;
      mode: DatabaseMode;
      source: DatabaseSource;
    }
  | {
      kind: 'setup-required';
      /** 供 Agent 在对话中转述的候选清单 */
      candidates: string[];
    };

/** 解析完成后的运行期配置。 */
export interface ResolvedConfig {
  /** dataHome 绝对路径 */
  dataHome: string;
  dataHomeSource: DataHomeSource;
  database: DatabaseResolution;
  /** L1.5 端口：env > config.yaml > 55433 */
  webPort: number;
  /** `<dataHome>/config.yaml` 是否存在——未初始化时为 false */
  initialized: boolean;
}

/** 实例主机名推断，用于 created_by 审计列（团队模式占位，§4.6）。 */
export function actorOf(mode: 'cli' | 'agent', host?: string): string {
  if (mode === 'cli') return 'cli';
  return host === undefined ? 'agent' : `host:${host}`;
}
