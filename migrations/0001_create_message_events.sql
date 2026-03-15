-- Migration number: 0001 	 2026-03-12T06:18:51.975Z
CREATE TABLE IF NOT EXISTS message_events (
  id TEXT PRIMARY KEY,
  company_code TEXT NOT NULL,
  discussion_id TEXT,
  team TEXT NOT NULL,
  user_id TEXT,
  created_at TEXT NOT NULL,
  char_count INTEGER NOT NULL DEFAULT 0,
  all_flags TEXT NOT NULL,
  bias_groups TEXT,
  phase_at_post TEXT,
  meta TEXT
);

CREATE INDEX IF NOT EXISTS idx_message_events_company_code
  ON message_events(company_code);

CREATE INDEX IF NOT EXISTS idx_message_events_company_team
  ON message_events(company_code, team);

CREATE INDEX IF NOT EXISTS idx_message_events_company_created
  ON message_events(company_code, created_at);