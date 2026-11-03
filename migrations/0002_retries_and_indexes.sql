-- Additive only: the previous Worker version keeps working while this one rolls out.

-- Failed sends wait before retrying (exponential backoff) instead of burning all attempts at once.
ALTER TABLE sends ADD COLUMN retry_at INTEGER;
-- Comment jobs remember the post and person, so a permanently failed send frees the
-- once-per-post slot in `deliveries` and the next comment can try again.
ALTER TABLE sends ADD COLUMN media_id TEXT;
ALTER TABLE sends ADD COLUMN user_id TEXT;

-- Retention deletes by created_at; without these each run scans whole tables (D1 bills rows read).
CREATE INDEX IF NOT EXISTS sends_created ON sends (created_at);
CREATE INDEX IF NOT EXISTS deliveries_created ON deliveries (created_at);
CREATE INDEX IF NOT EXISTS own_comments_created ON own_comments (created_at);
-- The admin's per-automation "sent" counter.
CREATE INDEX IF NOT EXISTS sends_rule_sent ON sends (rule_id) WHERE status = 'sent' AND step = 'trigger';
