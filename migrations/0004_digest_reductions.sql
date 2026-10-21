-- Reusable intermediate reduction notes, keyed by their exact input hash.
-- Allows quota pauses to resume without re-spending tokens on finished summaries.
CREATE TABLE IF NOT EXISTS digest_reductions (
  chat_id TEXT NOT NULL,
  local_day TEXT NOT NULL,
  level INTEGER NOT NULL,
  group_no INTEGER NOT NULL,
  input_hash TEXT NOT NULL,
  note TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY(chat_id,local_day,level,group_no)
);
CREATE INDEX IF NOT EXISTS digest_reductions_pending
ON digest_reductions(chat_id,local_day);
