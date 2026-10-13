-- Дополнение к существующей D1 схеме. Выполнить в Cloudflare D1 Console ОДИН РАЗ.
-- Старые выпуски и ответы НЕ удаляются.
CREATE TABLE IF NOT EXISTS mini_result_comments (
  run_id TEXT NOT NULL,
  score INTEGER NOT NULL CHECK (score BETWEEN 0 AND 6),
  messages_json TEXT NOT NULL,
  PRIMARY KEY (run_id, score)
);
-- run_id='__draft__' — текущие комментарии в черновике.
-- При активации они копируются под настоящий run_id и замораживаются для выпуска.
