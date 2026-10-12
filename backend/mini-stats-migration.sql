-- Вычитать: обязательные дополнительные таблицы для вечерней
-- рассылки процента правильных/неправильных ответов после 19:00 МСК.
-- Без удаления / изменения уже существующих таблиц и результатов.
-- Выполни один раз в Cloudflare → D1 → vychitat-quiz-db → Console.

CREATE TABLE IF NOT EXISTS mini_stats_snapshots (
  run_id TEXT PRIMARY KEY,
  snapshot_json TEXT NOT NULL CHECK (json_valid(snapshot_json)),
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  FOREIGN KEY(run_id) REFERENCES mini_editions(run_id)
);

CREATE TABLE IF NOT EXISTS mini_stats_deliveries (
  run_id TEXT NOT NULL,
  telegram_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('sent','not_member','blocked')),
  sent_at INTEGER NOT NULL DEFAULT (unixepoch()),
  PRIMARY KEY(run_id,telegram_id),
  FOREIGN KEY(run_id) REFERENCES mini_editions(run_id)
);

CREATE INDEX IF NOT EXISTS idx_mini_stats_deliveries_run_status
  ON mini_stats_deliveries(run_id,status);
