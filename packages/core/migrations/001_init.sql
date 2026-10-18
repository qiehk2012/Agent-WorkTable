-- 001_init：P0 全部六张表。DDL 与定稿 §4.2 全同。
-- 事务由 runner 托管（BEGIN/COMMIT 不写在本文件里），保证单条迁移的原子性。

CREATE TABLE meta (
  key         TEXT PRIMARY KEY,
  value       JSONB NOT NULL
);

CREATE TABLE projects (
  project_id  TEXT PRIMARY KEY,
  name        TEXT NOT NULL UNIQUE,
  icon        TEXT,
  folder      TEXT NOT NULL,
  position    INTEGER NOT NULL,
  hidden      BOOLEAN NOT NULL DEFAULT false,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by  TEXT NOT NULL
);

CREATE TABLE bindings (
  binding_id  TEXT PRIMARY KEY,
  project_id  TEXT NOT NULL REFERENCES projects(project_id) ON DELETE CASCADE,
  host        TEXT NOT NULL,
  session_id  TEXT NOT NULL,
  cwd         TEXT NOT NULL,
  status      TEXT NOT NULL,
  note        TEXT,
  revision    INTEGER NOT NULL DEFAULT 1,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- 一个项目同时只有一个 active binding（binding-conflict 的数据库层保证）
CREATE UNIQUE INDEX idx_bindings_active ON bindings(project_id) WHERE status <> 'done';

CREATE TABLE panes (
  pane_id     TEXT NOT NULL,
  binding_id  TEXT NOT NULL REFERENCES bindings(binding_id) ON DELETE CASCADE,
  layout      JSONB,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (pane_id, binding_id)
);

CREATE TABLE artifacts (
  artifact_id   TEXT PRIMARY KEY,
  project_id    TEXT NOT NULL REFERENCES projects(project_id) ON DELETE CASCADE,
  pane_id       TEXT NOT NULL,
  binding_id    TEXT NOT NULL,
  title         TEXT NOT NULL,
  type          TEXT NOT NULL,
  payload_path  TEXT NOT NULL,
  status        TEXT NOT NULL,
  meta          JSONB NOT NULL DEFAULT '{}',
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY (pane_id, binding_id) REFERENCES panes(pane_id, binding_id) ON DELETE CASCADE
);

-- 事件账本（P3 业务启用；主理人裁决 3：本期随 001_init 建表，P0 零业务写入）
CREATE TABLE events (
  event_id    TEXT PRIMARY KEY,
  ts          TIMESTAMPTZ NOT NULL DEFAULT now(),
  actor       TEXT NOT NULL,
  project_id  TEXT REFERENCES projects(project_id) ON DELETE SET NULL,
  kind        TEXT NOT NULL,
  payload     JSONB NOT NULL
);
CREATE INDEX idx_events_project_ts ON events(project_id, ts DESC);
