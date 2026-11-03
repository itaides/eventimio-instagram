CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT
);

-- One automation per row. Steps: trigger → public reply → opener → follow gate → link.
CREATE TABLE IF NOT EXISTS rules (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT,                -- internal label for the admin page
  lang TEXT NOT NULL DEFAULT 'he',   -- he | en | fr: picks default texts and preview direction
  -- Trigger
  source TEXT NOT NULL DEFAULT 'comment',       -- comment (post/reel) | story (story reply) | dm
  trigger_mode TEXT NOT NULL DEFAULT 'keyword', -- keyword | any (any comment; comment source only)
  keyword TEXT NOT NULL DEFAULT '',             -- comma-separated alternatives
  media_id TEXT,            -- comments only: NULL = every post and reel
  media_label TEXT,
  media_thumb TEXT,
  -- Public reply (comments only): one variant per line, picked at random; NULL = none
  public_reply TEXT,
  send_dm INTEGER NOT NULL DEFAULT 1,   -- 0 = public reply only, no DM
  -- Opener: NULL = send the link straight away
  opener_text TEXT,
  opener_button TEXT,
  -- Followers-only gate (off by default); NULL texts fall back to flow.js DEFAULTS
  follow_gate INTEGER NOT NULL DEFAULT 0,
  follow_text TEXT,
  follow_profile_button TEXT,
  follow_confirm_button TEXT,
  follow_reminder_text TEXT,
  -- The link message
  message TEXT NOT NULL,
  button_text TEXT,         -- max 20 chars; NULL = no button
  button_url TEXT,
  active INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL
);

-- Work queue: one row per comment, DM, story reply or button tap.
CREATE TABLE IF NOT EXISTS sends (
  event_id TEXT PRIMARY KEY,
  source TEXT NOT NULL,     -- comment | story | dm | postback
  step TEXT NOT NULL DEFAULT 'trigger', -- trigger | open (tapped the opener) | followed (tapped "already following")
  rule_id INTEGER,
  recipient_id TEXT,        -- DMs and taps: who to message. Comments: NULL (private reply by event_id)
  username TEXT,
  incoming_text TEXT,
  status TEXT NOT NULL,     -- pending | sending | sent | failed
  error TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  sent_at INTEGER
);

CREATE INDEX IF NOT EXISTS sends_status ON sends (status, created_at);
CREATE INDEX IF NOT EXISTS sends_sent_at ON sends (sent_at);

-- A person gets each automation once per post or reel.
CREATE TABLE IF NOT EXISTS deliveries (
  rule_id INTEGER NOT NULL,
  media_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (rule_id, media_id, user_id)
);

-- Comments the bot posted itself, so it never replies to them.
CREATE TABLE IF NOT EXISTS own_comments (
  comment_id TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL
);

-- Posts published (or scheduled) from the admin. Scheduling is ours: Meta has no "publish at",
-- and a container expires after 24h, so it is only created when the post is due.
CREATE TABLE IF NOT EXISTS posts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  status TEXT NOT NULL,     -- scheduled | publishing | processing | published | failed | cancelled
  caption TEXT,
  ratio TEXT NOT NULL DEFAULT '4:5',
  images TEXT NOT NULL,     -- JSON array of R2 keys ("<uuid>.jpg"), served at /media/<key>
  publish_at INTEGER NOT NULL,
  auto_keyword TEXT,        -- optional comment→DM automation created on publish
  auto_link TEXT,
  container_id TEXT,
  media_id TEXT,
  permalink TEXT,
  rule_id INTEGER,
  error TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  claimed_at INTEGER,       -- when a run took it; a stuck "publishing" row is retried after 5 min
  images_purged INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  published_at INTEGER
);

CREATE INDEX IF NOT EXISTS posts_due ON posts (status, publish_at);
