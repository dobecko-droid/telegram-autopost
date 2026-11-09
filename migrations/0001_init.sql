PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS videos (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tiktok_url TEXT NOT NULL UNIQUE,
  video_id TEXT UNIQUE,
  author_username TEXT,
  author_name TEXT,
  video_file_url TEXT,
  caption TEXT,
  popular_comment TEXT,
  status TEXT NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued', 'processing', 'ready', 'scheduled', 'published', 'failed')),
  submitted_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  published_at TEXT,
  error_message TEXT
);

CREATE INDEX IF NOT EXISTS idx_videos_status_submitted
  ON videos(status, submitted_at);

CREATE TABLE IF NOT EXISTS publication_slots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  video_id INTEGER NOT NULL UNIQUE REFERENCES videos(id) ON DELETE CASCADE,
  scheduled_at TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'scheduled'
    CHECK (status IN ('scheduled', 'publishing', 'published', 'failed')),
  telegram_message_id TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_publication_slots_status_time
  ON publication_slots(status, scheduled_at);

CREATE TABLE IF NOT EXISTS app_settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

INSERT OR IGNORE INTO app_settings (key, value) VALUES
  ('timezone', 'Asia/Tashkent'),
  ('daily_limit', '3'),
  ('telegram_channel', '@zadrot1705');
