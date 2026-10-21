CREATE TABLE IF NOT EXISTS digest_chunks (
  chat_id TEXT NOT NULL,
  local_day TEXT NOT NULL,
  chunk_no INTEGER NOT NULL,
  processed INTEGER NOT NULL,
  ids_json TEXT NOT NULL,
  note TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (chat_id,local_day,chunk_no)
);
CREATE INDEX IF NOT EXISTS digest_chunks_chat ON digest_chunks(chat_id,local_day);