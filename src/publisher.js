/**
 * Publishing I/O: image storage in R2, the posts table, and the publish pipeline
 * (container → status check → media_publish → optional DM automation).
 * Used by the admin page now and by the MCP tools later; neither holds publishing logic itself.
 */
import * as meta from './meta.js';
import { postFromForm, ruleForPost, israelDayStart, isJpeg, LIMITS } from './posts.js';
import { addRule } from './store.js';

const IMAGE_KEY = /^[0-9a-f-]{36}\.jpg$/;
const MAX_ATTEMPTS = 3;
const STUCK_AFTER = 300; // seconds a "publishing" claim may last before another run takes over
const MEDIA_RETENTION = 7 * 24 * 3600; // Meta copies the image on publish; ours is only a staging copy

const now = () => Math.floor(Date.now() / 1000);
const dailyCap = (env) => Number(env.MAX_POSTS_PER_DAY || 10);
const baseUrl = (env) => String(env.PUBLIC_BASE_URL || '').replace(/\/$/, '');

// ---------- Images ----------

/** Stores one browser-converted JPEG (admin only). Returns {key} or {error}. */
export async function uploadImage(request, env) {
  const bytes = new Uint8Array(await request.arrayBuffer());
  if (!bytes.length || bytes.length > LIMITS.bytes) return { error: 'גודל התמונה חייב להיות עד 8MB', status: 413 };
  if (!isJpeg(bytes)) return { error: 'רק JPEG', status: 415 };
  const key = `${crypto.randomUUID()}.jpg`;
  await env.MEDIA.put(key, bytes, { httpMetadata: { contentType: 'image/jpeg' } });
  return { key };
}

/** Public, unguessable image URL that Meta downloads when it creates the container. */
export async function serveImage(key, env) {
  if (!IMAGE_KEY.test(key)) return new Response('Not found', { status: 404 });
  const obj = await env.MEDIA.get(key);
  if (!obj) return new Response('Not found', { status: 404 });
  return new Response(obj.body, {
    headers: { 'Content-Type': 'image/jpeg', 'Cache-Control': 'public, max-age=86400', 'X-Content-Type-Options': 'nosniff' },
  });
}

// ---------- Posts ----------

/** Posts published in the current Israel calendar day, plus any in flight. */
export async function postsToday(env) {
  return env.DB.prepare(
    `SELECT COUNT(*) AS n FROM posts WHERE (status = 'published' AND published_at >= ?) OR status IN ('publishing', 'processing')`,
  ).bind(israelDayStart(now())).first('n');
}

/**
 * Saves a post from the admin form. "Now" posts are refused at the daily cap; scheduled ones wait.
 * @returns {{id?: number, now?: boolean, error?: string}}
 */
export async function createPost(f, env) {
  const { post, error } = postFromForm(f, now());
  if (error) return { error };
  const isNow = f.get('when') !== 'schedule';
  if (isNow && (await postsToday(env)) >= dailyCap(env)) return { error: 'daily_cap' };
  const res = await env.DB.prepare(
    `INSERT INTO posts (status, caption, ratio, images, publish_at, auto_keyword, auto_link, attempts, created_at)
     VALUES ('scheduled', ?, ?, ?, ?, ?, ?, 0, ?)`,
  ).bind(post.caption, post.ratio, post.images, post.publish_at, post.auto_keyword, post.auto_link, now()).run();
  return { id: res.meta.last_row_id, now: isNow };
}

export async function cancelPost(id, env) {
  const r = await env.DB.prepare(`UPDATE posts SET status = 'cancelled' WHERE id = ? AND status = 'scheduled'`)
    .bind(id).run();
  return r.meta.changes > 0;
}

export async function listPosts(env, limit = 15) {
  const { results } = await env.DB.prepare(
    `SELECT * FROM posts WHERE status != 'cancelled' OR created_at > ? ORDER BY COALESCE(published_at, publish_at) DESC LIMIT ?`,
  ).bind(now() - 86400, limit).all();
  return results;
}

// ---------- Publishing ----------

/**
 * Cron entry: publishes the oldest due post, never past the daily cap. One per run keeps a
 * 10-image carousel (~16 Graph calls) inside the Free plan's 50 subrequests next to the DM flush.
 */
export async function publishDue(env, onlyId = null) {
  if (!env.IG_PUBLISH_TOKEN || !env.IG_USER_ID || !env.PUBLIC_BASE_URL) return; // Meta needs a public image URL
  // A run killed mid-publish (time limit, deploy) leaves "publishing"; hand it back after 5 minutes.
  await env.DB.prepare(
    `UPDATE posts SET status = CASE WHEN container_id IS NULL THEN 'scheduled' ELSE 'processing' END
     WHERE status = 'publishing' AND COALESCE(claimed_at, 0) < ?`,
  ).bind(now() - STUCK_AFTER).run();
  const { results } = await env.DB.prepare(
    `SELECT * FROM posts WHERE status IN ('scheduled', 'processing') AND publish_at <= ?
     ${onlyId ? 'AND id = ?' : ''} ORDER BY publish_at LIMIT 1`,
  ).bind(...(onlyId ? [now(), onlyId] : [now()])).all();
  for (const post of results) {
    if (post.status === 'scheduled' && (await postsToday(env)) >= dailyCap(env)) {
      await note(env, post.id, `הגעתם למכסה היומית (${dailyCap(env)}). יפורסם מחר.`);
      continue;
    }
    await publishOne(env, post);
  }
}

/** Claims, builds the container(s), checks status, publishes, then creates the DM automation. */
async function publishOne(env, post) {
  const claim = await env.DB.prepare(
    `UPDATE posts SET status = 'publishing', attempts = attempts + 1, claimed_at = ? WHERE id = ? AND status = ?`,
  ).bind(now(), post.id, post.status).run();
  if (!claim.meta.changes) return;
  const token = env.IG_PUBLISH_TOKEN;
  const ig = env.IG_USER_ID;
  const attempts = post.attempts + 1;
  try {
    let containerId = post.container_id;
    if (!containerId) {
      const quota = await meta.publishingLimit(env, token, ig).catch(() => null);
      if (quota && quota.total && quota.used >= quota.total) throw new Error('המכסה של מטא ל-24 שעות מלאה');
      const urls = JSON.parse(post.images).map((k) => `${baseUrl(env)}/media/${k}`);
      if (urls.length === 1) {
        containerId = await meta.createImageContainer(env, token, ig, urls[0], { caption: post.caption });
      } else {
        // In parallel: one at a time, 8+ images (Meta downloads each) outlast the ~30s background window.
        const children = await Promise.all(
          urls.map((u) => meta.createImageContainer(env, token, ig, u, { carouselItem: true })),
        );
        containerId = await meta.createCarouselContainer(env, token, ig, children, post.caption);
      }
      await env.DB.prepare('UPDATE posts SET container_id = ? WHERE id = ?').bind(containerId, post.id).run();
    }

    const st = await meta.containerStatus(env, token, containerId);
    if (st.status_code === 'PUBLISHED') {
      // An earlier run published but died before saving: record it, never publish twice. Only adopt
      // the newest media if its caption is ours; a post made in the app meanwhile must not get our automation.
      const [latest] = await meta.listMedia(env, token, ig).catch(() => []);
      const ours = latest && (latest.caption || '') === (post.caption || '');
      await finish(env, post, ours ? latest.id : null, ours ? latest.permalink || '' : '');
      return;
    }
    if (st.status_code === 'IN_PROGRESS') {
      // Meta suggests re-checking about once a minute; the 5-minute cron picks it up again.
      await env.DB.prepare(`UPDATE posts SET status = 'processing', error = NULL WHERE id = ?`).bind(post.id).run();
      return;
    }
    if (st.status_code !== 'FINISHED') {
      throw Object.assign(new Error(`מטא: ${st.status_code} ${st.status || ''}`.trim()), { final: true });
    }

    const mediaId = await meta.publishContainer(env, token, ig, containerId);
    const permalink = await meta.mediaPermalink(env, token, mediaId).catch(() => '');
    await finish(env, post, mediaId, permalink);
  } catch (e) {
    const failed = e.final || attempts >= MAX_ATTEMPTS;
    // Keep any container ID: the retry checks its status first, so it can't publish twice.
    await env.DB.prepare(
      `UPDATE posts SET status = ?, error = ? WHERE id = ?`,
    ).bind(failed ? 'failed' : (post.container_id ? 'processing' : 'scheduled'), String(e.message).slice(0, 300), post.id).run();
  }
}

/** Marks a post published and creates its DM automation (when the media ID is known). */
async function finish(env, post, mediaId, permalink) {
  const rule = mediaId ? ruleForPost(post, mediaId, now()) : null;
  const ruleId = rule ? await addRule(env, rule) : null;
  await env.DB.prepare(
    `UPDATE posts SET status = 'published', media_id = ?, permalink = ?, rule_id = ?, published_at = ?, error = NULL WHERE id = ?`,
  ).bind(mediaId, permalink, ruleId, now(), post.id).run();
}

function note(env, id, text) {
  return env.DB.prepare('UPDATE posts SET error = ? WHERE id = ?').bind(text, id).run();
}

/** Deletes staged images once Meta has its own copy (or the post is dead). */
export async function purgeMedia(env) {
  if (!env.MEDIA) return;
  const { results } = await env.DB.prepare(
    `SELECT id, images FROM posts WHERE images_purged = 0 AND status IN ('published', 'failed', 'cancelled')
     AND COALESCE(published_at, created_at) < ? LIMIT 20`,
  ).bind(now() - MEDIA_RETENTION).all();
  for (const p of results) {
    await env.MEDIA.delete(JSON.parse(p.images));
    await env.DB.prepare('UPDATE posts SET images_purged = 1 WHERE id = ?').bind(p.id).run();
  }
}
