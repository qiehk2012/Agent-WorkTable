-- 迁移账本（000，引导迁移）：必须在任何其它迁移之前存在，否则无从判断已应用版本。
-- 幂等：重复执行不报错，便于多进程并发引导时后到者安全跳过。

CREATE TABLE IF NOT EXISTS schema_migrations (
  version    TEXT PRIMARY KEY,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  checksum   TEXT NOT NULL
);
