/**
 * Persistence for settings and automations (D1). Callers get plain objects back; SQL stays here.
 */
import { nowSec } from './util.js';

/** Editable automation fields, in the order the form and the table share. */
export const RULE_FIELDS = [
  'name', 'lang', 'source', 'trigger_mode', 'keyword', 'media_id', 'media_label', 'media_thumb',
  'public_reply', 'send_dm', 'opener_text', 'opener_button',
  'follow_gate', 'follow_text', 'follow_profile_button', 'follow_confirm_button', 'follow_reminder_text',
  'message', 'button_text', 'button_url',
];

/**
 * The account as the bot sees it: values saved by "check connection" (username, last error)
 * merged with the token and account ID, which come from Worker config, not the database.
 */
export async function loadAccount(env) {
  const { results } = await env.DB.prepare('SELECT key, value FROM settings').all();
  const saved = {};
  for (const { key, value } of results) saved[key] = value;
  return {
    ...saved, token: env.IG_ACCESS_TOKEN || '', ig_user_id: env.IG_USER_ID || '', brand: env.BRAND_NAME || 'Instagram',
  };
}

/** Upserts several settings in one batch. */
export function saveSettings(env, values) {
  const upsert = env.DB.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)');
  return env.DB.batch(Object.keys(values).map((k) => upsert.bind(k, String(values[k] ?? ''))));
}

export async function allRules(env, { newestFirst = false } = {}) {
  const sql = `SELECT * FROM rules${newestFirst ? ' ORDER BY created_at DESC' : ''}`;
  return (await env.DB.prepare(sql).all()).results;
}

/** Inserts an automation; returns its ID. */
export async function addRule(env, rule) {
  const cols = [...RULE_FIELDS, 'active', 'created_at'];
  const vals = [...RULE_FIELDS.map((f) => rule[f] ?? null), rule.active ?? 1, rule.created_at ?? nowSec()];
  const res = await env.DB.prepare(
    `INSERT INTO rules (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`,
  ).bind(...vals).run();
  return res.meta.last_row_id;
}

export function updateRule(env, id, rule) {
  const assignments = RULE_FIELDS.map((f) => `${f} = ?`).join(', ');
  return env.DB.prepare(`UPDATE rules SET ${assignments} WHERE id = ?`)
    .bind(...RULE_FIELDS.map((f) => rule[f] ?? null), id).run();
}

export function flipRule(env, id) {
  return env.DB.prepare('UPDATE rules SET active = CASE active WHEN 1 THEN 0 ELSE 1 END WHERE id = ?').bind(id).run();
}

export function removeRule(env, id) {
  return env.DB.prepare('DELETE FROM rules WHERE id = ?').bind(id).run();
}

/** What the automations page shows: recent queue rows, per-rule sent counts and the backlog. */
export async function activity(env) {
  const [recent, counts, backlog] = await Promise.all([
    env.DB.prepare('SELECT * FROM sends ORDER BY created_at DESC LIMIT 40').all(),
    env.DB.prepare(`SELECT rule_id, COUNT(*) AS n FROM sends WHERE status = 'sent' AND step = 'trigger' GROUP BY rule_id`).all(),
    env.DB.prepare(`SELECT COUNT(*) AS n FROM sends WHERE status = 'pending'`).first('n'),
  ]);
  const sentByRule = {};
  for (const row of counts.results) sentByRule[row.rule_id] = row.n;
  return { recent: recent.results, sentByRule, pending: backlog || 0 };
}
