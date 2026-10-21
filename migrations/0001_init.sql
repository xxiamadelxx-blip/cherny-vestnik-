CREATE TABLE IF NOT EXISTS chats (
  chat_id TEXT PRIMARY KEY,
  title TEXT NOT NULL DEFAULT '',
  enabled INTEGER NOT NULL DEFAULT 0,
  privacy_epoch INTEGER NOT NULL DEFAULT 0,
  digest_hhmm TEXT NOT NULL DEFAULT '21:00',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS messages (
  chat_id TEXT NOT NULL,
  message_id INTEGER NOT NULL,
  user_id TEXT NOT NULL,
  display_name TEXT NOT NULL,
  body TEXT NOT NULL,
  posted_at INTEGER NOT NULL,
  PRIMARY KEY (chat_id, message_id)
);
CREATE INDEX IF NOT EXISTS messages_by_time ON messages(chat_id, posted_at);
CREATE INDEX IF NOT EXISTS messages_by_user ON messages(chat_id, user_id);
CREATE TABLE IF NOT EXISTS digests (
  chat_id TEXT NOT NULL,
  local_day TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  lease_until INTEGER NOT NULL DEFAULT 0,
  next_part INTEGER NOT NULL DEFAULT 0,
  body TEXT,
  window_start INTEGER,
  window_end INTEGER,
  posted_at INTEGER,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY(chat_id, local_day)
);
CREATE TABLE IF NOT EXISTS memories (
  chat_id TEXT NOT NULL,
  local_day TEXT NOT NULL,
  excerpt TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY(chat_id, local_day)
);
CREATE TABLE IF NOT EXISTS optouts (
  chat_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY(chat_id,user_id)
);
