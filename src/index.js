/**
 * Worker entry: HTTP routes and the 5-minute cron.
 * Public: Meta's webhook, the legal pages, staged post images. Everything else is admin,
 * behind Cloudflare Access (verified here too) or Basic auth in local dev.
 */
import { handshake, signatureValid } from './webhook.js';
import { ingest, flush, forgetOld } from './outbox.js';
import { ruleFromForm } from './rules.js';
import { accessToken, verifyAccessJwt } from './access.js';
import * as meta from './meta.js';
import * as store from './store.js';
import { adminPage } from './admin.js';
import { privacyPage, deletionPage } from './pages.js';
import { postPage } from './postpage.js';
import {
  uploadImage, serveImage, createPost, cancelPost, listPosts, postsToday, publishDue, purgeMedia,
} from './publisher.js';
import { brandAssets, constantTimeEqual, htmlResponse, nowSec } from './util.js';

/** An HTML page whose CSP also allows the configured brand logo and icon. */
const page = (env, html) => htmlResponse(html, 200, { imgOrigins: brandAssets(env).origins });

const PUBLIC_ROUTES = [
  ['GET', '/webhook', (req, env, ctx, url) => handshake(url, env.VERIFY_TOKEN)],
  ['POST', '/webhook', receiveWebhook],
  ['GET', '/privacy', (req, env) => page(env, privacyPage(env))],
  ['GET', '/data-deletion', (req, env) => page(env, deletionPage(env))],
];

const ADMIN_ROUTES = [
  ['GET', '/admin/post', (req, env, ctx, url) => showPosts(url, env)],
  ['POST', '/admin/post', postAction],
  ['POST', '/admin/upload', async (req, env) => {
    const out = await uploadImage(req, env);
    return Response.json(out, { status: out.status || 200 });
  }],
  ['GET', '/admin', (req, env, ctx, url) => showAutomations(url, env)],
  ['GET', '/', (req, env, ctx, url) => showAutomations(url, env)],
  ['POST', '/admin', automationAction],
];

const find = (table, method, path) => table.find(([m, p]) => m === method && p === path)?.[2];

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    // HEAD is GET without a body; the runtime drops the body for us.
    const method = request.method === 'HEAD' ? 'GET' : request.method;
    const path = url.pathname;

    const open = find(PUBLIC_ROUTES, method, path);
    if (open) return open(request, env, ctx, url);
    // Staged images are public on purpose: Meta downloads them; keys are random UUIDs.
    if (method === 'GET' && path.startsWith('/media/')) return serveImage(path.slice('/media/'.length), env);

    const admin = find(ADMIN_ROUTES, method, path);
    if (!admin) return new Response('Not found', { status: 404 });
    const denied = await guardAdmin(request, env, url);
    return denied || admin(request, env, ctx, url);
  },

  async scheduled(controller, env, ctx) {
    const jobs = [flush(env), publishDue(env)];
    // Cleanup needs no 5-minute cadence: once an hour keeps D1 reads (billed per row) low.
    if (new Date(controller.scheduledTime).getUTCMinutes() < 5) jobs.push(forgetOld(env), purgeMedia(env));
    ctx.waitUntil(Promise.allSettled(jobs).then(logRejections));
  },
};

/** Acks Meta immediately (it retries slow endpoints) and processes in the background. */
async function receiveWebhook(request, env, ctx) {
  const raw = await request.text();
  if (!(await signatureValid(env.IG_APP_SECRET, raw, request.headers.get('X-Hub-Signature-256')))) {
    return new Response('bad signature', { status: 401 });
  }
  let payload;
  try {
    payload = JSON.parse(raw);
  } catch {
    return new Response('bad json', { status: 400 });
  }
  ctx.waitUntil(ingest(env, payload).catch((err) => console.error('webhook processing failed', err)));
  return new Response('ok');
}

function logRejections(results) {
  for (const r of results) if (r.status === 'rejected') console.error('cron job failed', r.reason);
}

// ---------- Admin access ----------

/** Returns a refusal, or null when the request may continue. */
async function guardAdmin(request, env, url) {
  if (env.ACCESS_AUD) {
    // Production: only Zero Trust. A missing or forged Access token is refused even if the Access app were gone.
    const claims = await verifyAccessJwt(accessToken(request), { team: env.ACCESS_TEAM, aud: env.ACCESS_AUD });
    if (!claims) return new Response('נדרשת כניסה דרך Zero Trust', { status: 403 });
  } else if (!basicAuthOk(request, env.ADMIN_PASSWORD)) {
    return new Response('נדרשת סיסמה', { status: 401, headers: { 'WWW-Authenticate': 'Basic realm="admin", charset="UTF-8"' } });
  }
  // Forms post back to the same origin; anything else is a cross-site request. Fetch Metadata
  // covers browsers and requests that omit Origin.
  const origin = request.headers.get('Origin');
  const site = request.headers.get('Sec-Fetch-Site');
  if (request.method === 'POST' && ((origin && origin !== url.origin) || (site && site !== 'same-origin'))) {
    return new Response('bad origin', { status: 403 });
  }
  return null;
}

/** Local dev only: any username, password must equal ADMIN_PASSWORD. */
function basicAuthOk(request, password) {
  const header = request.headers.get('Authorization') || '';
  if (!password || !header.startsWith('Basic ')) return false;
  try {
    const decoded = new TextDecoder().decode(Uint8Array.from(atob(header.slice(6)), (c) => c.charCodeAt(0)));
    return constantTimeEqual(decoded.slice(decoded.indexOf(':') + 1), password);
  } catch {
    return false;
  }
}

// ---------- Automations page ----------

async function showAutomations(url, env) {
  const account = await store.loadAccount(env);
  const [rules, { recent, sentByRule, pending }] = await Promise.all([
    store.allRules(env, { newestFirst: true }), store.activity(env),
  ]);
  let media = [];
  let mediaError = null;
  if (account.token) {
    try { media = await meta.listMedia(env, account.token, account.ig_user_id); } catch (err) { mediaError = err.message; }
  }
  const editId = Number(url.searchParams.get('edit')) || null;
  const editing = editId ? rules.find((r) => r.id === editId) || null : null;
  return page(env, adminPage({
    s: account, rules, recent, sentByRule, pending, media, mediaError, editing, msg: url.searchParams.get('msg'),
  }));
}

async function automationAction(request, env) {
  const form = await request.formData();
  const id = Number(form.get('id')) || null;
  const back = (msg, editId = null) => Response.redirect(
    new URL(`/admin?${editId ? `edit=${editId}&` : ''}msg=${msg}`, request.url).toString(), 303,
  );
  switch (form.get('action')) {
    case 'add':
    case 'update': {
      const { rule, error } = ruleFromForm(form);
      if (error) return back(error, id);
      if (form.get('action') === 'add') return back('added', await store.addRule(env, rule));
      await store.updateRule(env, id, rule);
      return back('saved', id);
    }
    case 'toggle':
      await store.flipRule(env, id);
      return back('saved', id);
    case 'delete':
      await store.removeRule(env, id);
      return back('deleted');
    case 'verify':
      return back((await checkConnection(env)) ? 'verified' : 'verifyfailed');
    default:
      return back('unknown');
  }
}

/**
 * "Check connection": proves the token can read the account, caches the username, and
 * (with PAGE_ID) subscribes the linked Page to webhooks. Errors are kept for the admin banner.
 */
async function checkConnection(env) {
  const account = await store.loadAccount(env);
  if (!account.token || !account.ig_user_id) {
    await store.saveSettings(env, { token_error: 'חסרים IG_ACCESS_TOKEN או IG_USER_ID בהגדרות ה-Worker' });
    return false;
  }
  try {
    const profile = await meta.getAccount(env, account.token, account.ig_user_id);
    if (env.PAGE_ID) await meta.subscribePage(env, account.token, env.PAGE_ID);
    await store.saveSettings(env, { username: profile.username || '', token_error: '', verified_at: nowSec() });
    return true;
  } catch (err) {
    await store.saveSettings(env, { token_error: err.message });
    return false;
  }
}

// ---------- Posts page ----------

async function showPosts(url, env) {
  const [account, posts, today] = await Promise.all([store.loadAccount(env), listPosts(env), postsToday(env)]);
  return page(env, postPage({
    s: account, posts, today, cap: Number(env.MAX_POSTS_PER_DAY || 10),
    canPublish: Boolean(env.IG_PUBLISH_TOKEN && env.PUBLIC_BASE_URL), msg: url.searchParams.get('msg'),
  }));
}

/** New post (now or scheduled) and cancel. "Now" starts publishing right away; the cron finishes slow ones. */
async function postAction(request, env, ctx) {
  const form = await request.formData();
  const back = (msg) => Response.redirect(new URL(`/admin/post?msg=${msg}`, request.url).toString(), 303);
  if (form.get('action') === 'post_create') {
    const created = await createPost(form, env);
    if (created.error) return back(created.error);
    if (created.now) ctx.waitUntil(publishDue(env, created.id).catch((err) => console.error('publish failed', err)));
    return back(created.now ? 'posted' : 'scheduled');
  }
  if (form.get('action') === 'post_cancel') {
    await cancelPost(Number(form.get('id')), env);
    return back('cancelled');
  }
  return back('unknown');
}
