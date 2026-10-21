-- Durable at-least-once Telegram getUpdates transport, used if Telegram
-- cannot resolve the public Cloudflare workers.dev webhook hostname.
CREATE TABLE IF NOT EXISTS telegram_poller (
  name TEXT PRIMARY KEY,
  last_update_id INTEGER NOT NULL DEFAULT -1,
  lease_until INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL DEFAULT 0
);
INSERT OR IGNORE INTO telegram_poller(name,last_update_id,lease_until,updated_at)
VALUES('primary',-1,0,0);
