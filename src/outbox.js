/**
 * The DM pipeline: ingest (webhook events → jobs) → flush (hourly budget, claim) → deliver → settle.
 * Jobs live in the `sends` table; event IDs make every job idempotent against Meta redelivery.
 */
import * as meta from './meta.js';
import { findRule, renderTemplate, pickOne } from './match.js';
import {
  nextMessage, textFor, needsFollowCheck, parsePayload, linkMessage, openerMessage, followMessage,
} from './flow.js';
import { parseEvents } from './webhook.js';
import { loadAccount, allRules, saveSettings } from './store.js';
import { nowSec } from './util.js';

const HOUR = 3600;
const MAX_ATTEMPTS = 3;
const BATCH = 20;
// Graph calls per invocation. Workers Free allows 50 external subrequests, and the cron also
// publishes in the same invocation; a job costs at most 4 calls (profile, username, DM, public reply).
const CALL_BUDGET = 25;
const CALLS_PER_JOB = 4;
const RETRY_BASE = 60;       // seconds before the 1st retry; 4x per further attempt
const STALE_SENDING = 900;   // a claim this old was interrupted; failing it beats a possible double send
const TOKEN_INVALID = 190;   // Meta's OAuthException: expired or revoked token
const RETENTION = 90 * 24 * HOUR;
const INTERRUPTED = 'נקטע באמצע שליחה';
const RULE_GONE = 'החוק נמחק';
const NOTHING_TO_SEND = 'אין תשובה פומבית ואין הודעה';

// ---------- Ingest ----------

/** Turns a verified webhook payload into queued jobs, then sends what the budget allows. */
export async function ingest(env, payload) {
  const account = await loadAccount(env);
  if (!account.token) return;
  const rules = await allRules(env);
  if (!rules.length) return;
  for (const event of parseEvents(payload, account.ig_user_id)) {
    const job = await jobFor(env, account, rules, event);
    if (job) await enqueue(env, job);
  }
  await flush(env, account);
}

async function jobFor(env, account, rules, ev) {
  if (ev.type === 'comment') {
    if (await authoredByUs(env, account, ev)) return null;
    const rule = findRule(rules, 'comment', ev.mediaId, ev.text);
    if (!rule || !(await firstOnPost(env, rule.id, ev.mediaId, ev.fromId))) return null;
    return {
      event_id: ev.id, source: 'comment', step: 'trigger', rule_id: rule.id, recipient_id: null,
      username: ev.fromName, text: ev.text, media_id: ev.mediaId, user_id: ev.fromId,
    };
  }
  if (ev.type === 'tap') {
    const tap = parsePayload(ev.payload);
    const rule = tap && rules.find((r) => r.id === tap.ruleId);
    if (!rule) return null; // someone else's button, or the automation was deleted
    return { event_id: ev.id, source: 'postback', step: tap.step, rule_id: rule.id, recipient_id: ev.senderId, username: '', text: ev.title };
  }
  const source = ev.story ? 'story' : 'dm';
  const rule = findRule(rules, source, null, ev.text);
  return rule && { event_id: ev.id, source, step: 'trigger', rule_id: rule.id, recipient_id: ev.senderId, username: '', text: ev.text };
}

/** Our own comments and the public replies the bot posted must never trigger anything. */
async function authoredByUs(env, account, ev) {
  if (ev.fromId && ev.fromId === account.ig_user_id) return true;
  if (ev.fromName && account.username && ev.fromName === account.username) return true;
  return Boolean(await env.DB.prepare('SELECT 1 FROM own_comments WHERE comment_id = ?').bind(ev.id).first());
}

/** Records the (automation, post, person) triple; false if that person already got it on this post. */
async function firstOnPost(env, ruleId, mediaId, personId) {
  if (!mediaId || !personId) return true;
  const res = await env.DB.prepare(
    'INSERT OR IGNORE INTO deliveries (rule_id, media_id, user_id, created_at) VALUES (?, ?, ?, ?)',
  ).bind(ruleId, mediaId, personId, nowSec()).run();
  return res.meta.changes === 1;
}

function enqueue(env, job) {
  return env.DB.prepare(
    `INSERT OR IGNORE INTO sends
       (event_id, source, step, rule_id, recipient_id, username, incoming_text, media_id, user_id, status, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)`,
  ).bind(job.event_id, job.source, job.step, job.rule_id, job.recipient_id, job.username || '',
    String(job.text || '').slice(0, 500), job.media_id ?? null, job.user_id ?? null, nowSec()).run();
}

/** A comment job that finally failed gives the person's once-per-post slot back. */
function releaseSlot(env, job) {
  if (!job.media_id || !job.user_id) return null;
  return env.DB.prepare('DELETE FROM deliveries WHERE rule_id = ? AND media_id = ? AND user_id = ?')
    .bind(job.rule_id, job.media_id, job.user_id).run();
}

// ---------- Flush ----------

/** Sends queued jobs oldest-first within MAX_PER_HOUR; also called by the cron. */
export async function flush(env, knownAccount) {
  const account = knownAccount || (await loadAccount(env));
  if (!account.token) return;
  const t = nowSec();
  await env.DB.prepare(`UPDATE sends SET status = 'failed', error = ? WHERE status = 'sending' AND sent_at < ?`)
    .bind(INTERRUPTED, t - STALE_SENDING).run();
  const sentThisHour = await env.DB.prepare('SELECT COUNT(*) AS n FROM sends WHERE sent_at > ?').bind(t - HOUR).first('n');
  const budget = Math.min(BATCH, Number(env.MAX_PER_HOUR || 150) - (sentThisHour || 0));
  if (budget <= 0) return;
  const { results: jobs } = await env.DB.prepare(
    `SELECT * FROM sends WHERE status = 'pending' AND COALESCE(retry_at, 0) <= ? ORDER BY created_at LIMIT ?`,
  ).bind(t, budget).all();
  if (!jobs.length) return;
  const rulesById = new Map((await allRules(env)).map((r) => [r.id, r]));
  const io = instagram(env, account);
  for (const job of jobs) {
    if (io.calls() + CALLS_PER_JOB > CALL_BUDGET) break; // the rest wait for the next webhook or cron run
    await deliver(env, io, job, rulesById.get(job.rule_id));
  }
}

/** Everything delivery needs from Meta, bound to this account, counting the calls it makes. */
function instagram(env, account) {
  const { token, ig_user_id: ig } = account;
  let calls = 0;
  const counted = (fn) => (...args) => { calls += 1; return fn(...args); };
  return {
    calls: () => calls,
    profileUrl: `https://www.instagram.com/${account.username || ''}`,
    dm: counted((to, message) => meta.sendMessage(env, token, ig, to, message)),
    privateReply: counted((commentId, message) => meta.sendPrivateReply(env, token, ig, commentId, message)),
    publicReply: counted((commentId, text) => meta.replyPublicly(env, token, commentId, text)),
    profile: counted((igsid) => meta.getProfile(env, token, igsid)),
    username: counted((igsid) => meta.getUsername(env, token, igsid)),
  };
}

// ---------- Deliver ----------

async function deliver(env, io, job, rule) {
  if (!rule) return settle(env, job, { status: 'failed', error: RULE_GONE });
  // Claiming first means two overlapping flushes can never both send the same job.
  const claimed = await env.DB.prepare(`UPDATE sends SET status = 'sending', sent_at = ? WHERE event_id = ? AND status = 'pending'`)
    .bind(nowSec(), job.event_id).run();
  if (claimed.meta.changes !== 1) return undefined;
  const who = { username: job.username || '' };
  try {
    if (job.source === 'comment') await answerComment(env, io, job, rule, who);
    else await answerConversation(io, job, rule, who);
    return settle(env, job, { status: 'sent', username: who.username });
  } catch (err) {
    const attempts = job.attempts + 1;
    const failed = attempts >= MAX_ATTEMPTS;
    // A dead token fails every send; surface it on the admin banner instead of only in logs.
    if (err.code === TOKEN_INVALID) await saveSettings(env, { token_error: err.message });
    if (failed && job.source === 'comment') await releaseSlot(env, job);
    return settle(env, job, {
      status: failed ? 'failed' : 'pending', attempts, error: err.message, username: who.username,
      retryAt: failed ? null : nowSec() + RETRY_BASE * 4 ** (attempts - 1),
    });
  }
}

/** A comment gets one private reply (opener or link) and, optionally, a random public reply variant. */
async function answerComment(env, io, job, rule, who) {
  if (rule.send_dm) {
    await sendKind((m) => io.privateReply(job.event_id, m), rule, nextMessage(rule, 'trigger'), who.username, io.profileUrl);
  }
  const variant = pickOne(rule.public_reply);
  if (!variant) {
    if (!rule.send_dm) throw new Error(NOTHING_TO_SEND);
    return;
  }
  try {
    const posted = await io.publicReply(job.event_id, renderTemplate(variant, { username: who.username }));
    if (posted?.id) {
      await env.DB.prepare('INSERT OR IGNORE INTO own_comments (comment_id, created_at) VALUES (?, ?)').bind(posted.id, nowSec()).run();
    }
  } catch (err) {
    if (!rule.send_dm) throw err; // public-only automations must report failure
    console.error('public reply failed after the DM was sent', err.message);
  }
}

/** DMs, story replies and button taps: opener → follow gate → link, decided by flow.js. */
async function answerConversation(io, job, rule, who) {
  let follows = null;
  if (needsFollowCheck(rule, job.step)) {
    const profile = await io.profile(job.recipient_id).catch((err) => {
      console.error('follow check unavailable, sending the link', err.message);
      return null;
    });
    if (profile) {
      if (typeof profile.is_user_follow_business === 'boolean') follows = profile.is_user_follow_business;
      who.username = who.username || profile.username || '';
    }
  }
  const kind = nextMessage(rule, job.step, follows);
  if (!who.username && textFor(rule, kind).includes('{username}')) {
    who.username = await io.username(job.recipient_id).catch(() => '');
  }
  await sendKind((m) => io.dm(job.recipient_id, m), rule, kind, who.username, io.profileUrl);
}

/** Builds and sends one message kind. A rejected link button is retried as plain text with the URL. */
async function sendKind(send, rule, kind, username, profileUrl) {
  const text = renderTemplate(textFor(rule, kind), { username }).replace(/\s*@?\{username\}/g, '');
  if (kind === 'opener') return send(openerMessage(rule, text));
  if (kind === 'follow' || kind === 'reminder') return send(followMessage(rule, text, profileUrl));
  const { message, fallback } = linkMessage(rule, text);
  try {
    return await send(message);
  } catch (err) {
    if (!fallback) throw err;
    console.error('button rejected, sending plain text', err.message);
    return send(fallback);
  }
}

function settle(env, job, { status, error = null, attempts = job.attempts || 0, username = job.username || '', retryAt = null }) {
  return env.DB.prepare('UPDATE sends SET status = ?, error = ?, attempts = ?, username = ?, sent_at = ?, retry_at = ? WHERE event_id = ?')
    .bind(status, error, attempts, username, status === 'sent' ? nowSec() : null, retryAt, job.event_id).run();
}

// ---------- Retention ----------

/** Drops personal data older than the privacy policy's 90 days. */
export function forgetOld(env) {
  const cutoff = nowSec() - RETENTION;
  return env.DB.batch(['sends', 'deliveries', 'own_comments'].map(
    (table) => env.DB.prepare(`DELETE FROM ${table} WHERE created_at < ?`).bind(cutoff),
  ));
}
