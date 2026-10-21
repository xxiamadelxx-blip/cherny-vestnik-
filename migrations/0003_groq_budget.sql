-- Shared org-level Groq pacing across all chats, survive Worker restarts.
CREATE TABLE IF NOT EXISTS groq_budget (
  scope TEXT PRIMARY KEY,
  day_utc TEXT NOT NULL,
  used_tokens INTEGER NOT NULL DEFAULT 0,
  remaining_requests INTEGER,
  remaining_tokens INTEGER,
  reset_requests_at INTEGER NOT NULL DEFAULT 0,
  reset_tokens_at INTEGER NOT NULL DEFAULT 0,
  next_attempt_at INTEGER NOT NULL DEFAULT 0,
  strikes INTEGER NOT NULL DEFAULT 0,
  last_status INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL
);
