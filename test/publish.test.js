import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/index.js';
import {
  captionStats, postFromForm, israelLocalToEpoch, israelDayStart, ruleForPost, isJpeg,
} from '../src/posts.js';
import { publishDue, createPost, postsToday } from '../src/publisher.js';
import { freshDb, d1, r2, form } from './helpers.js';

const ME = '17841400000000001';
const KEY = (n) => `${String(n).padStart(8, '0')}-aaaa-bbbb-cccc-dddddddddddd.jpg`;
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);

// ---------- Pure rules ----------

test('caption stats count characters (not UTF-16 units), hashtags and mentions', () => {
  assert.deepEqual(captionStats('היי 👋 #חתונה #תקציב @yourbrand.co'), { chars: 33, hashtags: 2, mentions: 1 });
});

test('postFromForm enforces Meta limits and image keys', () => {
  const ok = { caption: 'x', images: KEY(1), when: 'now' };
  assert.ok(postFromForm(form(ok), 1000).post);
  assert.equal(postFromForm(form({ ...ok, caption: 'a'.repeat(2201) }), 1000).error, 'caption_limits');
  assert.equal(postFromForm(form({ ...ok, caption: Array.from({ length: 31 }, (_, i) => `#t${i}`).join(' ') }), 1000).error, 'caption_limits');
  assert.equal(postFromForm(form({ ...ok, caption: Array.from({ length: 21 }, (_, i) => `@u${i}`).join(' ') }), 1000).error, 'caption_limits');
  assert.equal(postFromForm(form({ ...ok, images: '' }), 1000).error, 'images');
  assert.equal(postFromForm(form({ ...ok, images: Array.from({ length: 11 }, (_, i) => KEY(i)).join(',') }), 1000).error, 'images');
  assert.equal(postFromForm(form({ ...ok, images: '../etc/passwd' }), 1000).error, 'images');
  assert.equal(postFromForm(form({ ...ok, auto_on: 'on', auto_keyword: 'x', auto_link: 'http://a' }), 1000).error, 'auto');
});

test('Israel local time converts across daylight saving (UTC+3 summer, UTC+2 winter)', () => {
  assert.equal(israelLocalToEpoch('2026-07-01T12:00'), Date.UTC(2026, 6, 1, 9, 0) / 1000);
  assert.equal(israelLocalToEpoch('2026-12-01T12:00'), Date.UTC(2026, 11, 1, 10, 0) / 1000);
  assert.equal(israelLocalToEpoch('nonsense'), null);
});

test('scheduling in the past is refused', () => {
  const nowSec = Date.UTC(2026, 10, 3, 12) / 1000;
  assert.equal(postFromForm(form({ caption: '', images: KEY(1), when: 'schedule', publish_at: '2026-11-01T10:00' }), nowSec).error, 'schedule_past');
  assert.ok(postFromForm(form({ caption: '', images: KEY(1), when: 'schedule', publish_at: '2026-11-04T10:00' }), nowSec).post);
});

test('Israel day starts at local midnight', () => {
  const t = Date.UTC(2026, 10, 3, 21, 30) / 1000; // 23:30 Israel (UTC+2)
  assert.equal(israelDayStart(t), Date.UTC(2026, 10, 2, 22, 0) / 1000);
});

test('ruleForPost binds the automation to the published media', () => {
  const r = ruleForPost({ caption: 'c', auto_keyword: 'תקציב', auto_link: 'https://x.y' }, 'm9', 5);
  assert.equal(r.media_id, 'm9');
  assert.equal(r.button_url, 'https://x.y');
  assert.ok(r.opener_text);
  assert.equal(ruleForPost({ caption: 'c' }, 'm9', 5), null);
});

test('isJpeg checks the magic bytes', () => {
  assert.ok(isJpeg(JPEG));
  assert.ok(!isJpeg(new Uint8Array([0x89, 0x50, 0x4e, 0x47])));
});

// ---------- Pipeline against a fake Graph API ----------

let db, env, calls, statusCode, quotaUsed;

beforeEach(() => {
  db = freshDb();
  env = {
    DB: d1(db), MEDIA: r2(), IG_PUBLISH_TOKEN: 'pub', IG_USER_ID: ME, GRAPH_VERSION: 'v26.0',
    MAX_POSTS_PER_DAY: '10', PUBLIC_BASE_URL: 'https://ig.example.com', ADMIN_PASSWORD: 'pw',
  };
  calls = [];
  statusCode = 'FINISHED';
  quotaUsed = 0;
  let n = 0;
  globalThis.fetch = async (url, init = {}) => {
    const u = new URL(url);
    const body = typeof init.body === 'string' ? Object.fromEntries(new URLSearchParams(init.body))
      : init.body instanceof URLSearchParams ? Object.fromEntries(init.body) : null;
    calls.push({ method: init.method || 'GET', path: u.pathname, body, auth: init.headers?.Authorization });
    let res = {};
    if (u.pathname.endsWith('/content_publishing_limit')) res = { data: [{ quota_usage: quotaUsed, config: { quota_total: 100 } }] };
    else if (u.pathname.endsWith(`/${ME}/media`)) res = { id: `c${++n}` };
    else if (u.pathname.endsWith('/media_publish')) res = { id: 'm1' };
    else if (u.searchParams.get('fields') === 'status_code,status') res = { status_code: statusCode, status: statusCode === 'ERROR' ? '2207026' : '' };
    else if (u.searchParams.get('fields') === 'permalink') res = { permalink: 'https://www.instagram.com/p/abc/' };
    return new Response(JSON.stringify(res), { status: 200 });
  };
});

const insertPost = (fields = {}) => {
  const p = { status: 'scheduled', caption: 'שלום', ratio: '4:5', images: JSON.stringify([KEY(1)]), publish_at: 1, created_at: 1, ...fields };
  const cols = Object.keys(p);
  return Number(db.prepare(`INSERT INTO posts (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`).run(...Object.values(p)).lastInsertRowid);
};
const row = (id) => db.prepare('SELECT * FROM posts WHERE id = ?').get(id);
const mediaCalls = () => calls.filter((c) => c.path.endsWith(`/${ME}/media`));

test('single image: container with caption and public image URL, publish, permalink', async () => {
  const id = insertPost();
  await publishDue(env);
  const [c] = mediaCalls();
  assert.equal(c.body.image_url, `https://ig.example.com/media/${KEY(1)}`);
  assert.equal(c.body.caption, 'שלום');
  assert.equal(c.auth, 'Bearer pub');
  assert.ok(calls.some((x) => x.path.endsWith('/media_publish') && x.body.creation_id === 'c1'));
  const p = row(id);
  assert.equal(p.status, 'published');
  assert.equal(p.media_id, 'm1');
  assert.equal(p.permalink, 'https://www.instagram.com/p/abc/');
});

test('carousel: children carry is_carousel_item and no caption; parent has CAROUSEL + caption', async () => {
  insertPost({ images: JSON.stringify([KEY(1), KEY(2), KEY(3)]) });
  await publishDue(env);
  const [a, b, c, parent] = mediaCalls();
  for (const child of [a, b, c]) {
    assert.equal(child.body.is_carousel_item, 'true');
    assert.equal(child.body.caption, undefined);
  }
  assert.equal(parent.body.media_type, 'CAROUSEL');
  assert.equal(parent.body.children, 'c1,c2,c3');
  assert.equal(parent.body.caption, 'שלום');
});

test('publishing creates the DM automation on the new media', async () => {
  const id = insertPost({ auto_keyword: 'תקציב', auto_link: 'https://example.com/g' });
  await publishDue(env);
  const rule = db.prepare('SELECT * FROM rules WHERE id = ?').get(row(id).rule_id);
  assert.equal(rule.media_id, 'm1');
  assert.equal(rule.keyword, 'תקציב');
  assert.equal(rule.button_url, 'https://example.com/g');
});

test('IN_PROGRESS container waits for the next cron run, then publishes', async () => {
  const id = insertPost();
  statusCode = 'IN_PROGRESS';
  await publishDue(env);
  assert.equal(row(id).status, 'processing');
  assert.equal(row(id).container_id, 'c1');
  statusCode = 'FINISHED';
  await publishDue(env);
  assert.equal(row(id).status, 'published');
  assert.equal(mediaCalls().length, 1); // container reused, not rebuilt
});

test('ERROR container fails at once with Meta\'s code', async () => {
  const id = insertPost();
  statusCode = 'ERROR';
  await publishDue(env);
  assert.equal(row(id).status, 'failed');
  assert.match(row(id).error, /ERROR 2207026/);
});

test('future posts wait; nothing runs without a publish token', async () => {
  const later = insertPost({ publish_at: Math.floor(Date.now() / 1000) + 3600 });
  await publishDue(env);
  assert.equal(row(later).status, 'scheduled');
  const due = insertPost();
  delete env.IG_PUBLISH_TOKEN;
  await publishDue(env);
  assert.equal(row(due).status, 'scheduled');
  assert.equal(calls.length, 0);
});

test('daily cap: the 11th post waits for tomorrow; "now" is refused at the cap', async () => {
  const today = Math.floor(Date.now() / 1000);
  for (let i = 0; i < 10; i++) insertPost({ status: 'published', published_at: today });
  assert.equal(await postsToday(env), 10);
  const id = insertPost();
  await publishDue(env);
  assert.equal(row(id).status, 'scheduled');
  assert.match(row(id).error, /מכסה היומית/);
  assert.equal(calls.length, 0);
  assert.equal((await createPost(form({ caption: '', images: KEY(1), when: 'now' }), env)).error, 'daily_cap');
});

test('Meta quota full: no container is created', async () => {
  quotaUsed = 100;
  const id = insertPost();
  await publishDue(env);
  assert.equal(mediaCalls().length, 0);
  assert.match(row(id).error, /מכסה של מטא/);
});

// ---------- HTTP: upload, media, page, cancel ----------

const auth = { Authorization: `Basic ${btoa('a:pw')}`, Origin: 'https://ig.example.com' };
const call = (path, init = {}) => worker.fetch(new Request(`https://ig.example.com${path}`, init), env, { waitUntil() {} });

test('upload accepts JPEG only, then serves it publicly at /media/<key>', async () => {
  const bad = await call('/admin/upload', { method: 'POST', headers: auth, body: new Uint8Array([0x89, 0x50, 0x4e, 0x47]) });
  assert.equal(bad.status, 415);
  const res = await call('/admin/upload', { method: 'POST', headers: auth, body: JPEG });
  const { key } = await res.json();
  assert.match(key, /^[0-9a-f-]{36}\.jpg$/);
  const img = await call(`/media/${key}`);
  assert.equal(img.status, 200);
  assert.equal(img.headers.get('Content-Type'), 'image/jpeg');
  assert.equal((await call('/media/../secrets.local.txt')).status, 404);
});

test('upload requires admin auth', async () => {
  const res = await call('/admin/upload', { method: 'POST', headers: { Origin: 'https://ig.example.com' }, body: JPEG });
  assert.equal(res.status, 401);
});

test('post page renders, schedules, lists and cancels', async () => {
  const page = await (await call('/admin/post', { headers: auth })).text();
  assert.match(page, /פורסמו היום <strong>0<\/strong> מתוך 10/);
  const res = await call('/admin/post', {
    method: 'POST', headers: auth,
    body: new URLSearchParams({ action: 'post_create', caption: 'מתוזמן', images: KEY(1), ratio: '1:1', when: 'schedule', publish_at: '2099-01-01T10:00' }),
  });
  assert.match(res.headers.get('Location'), /msg=scheduled/);
  const p = db.prepare('SELECT * FROM posts').get();
  assert.equal(p.status, 'scheduled');
  assert.equal(p.ratio, '1:1');
  const list = await (await call('/admin/post', { headers: auth })).text();
  assert.match(list, /מתוזמן/);
  await call('/admin/post', { method: 'POST', headers: auth, body: new URLSearchParams({ action: 'post_cancel', id: String(p.id) }) });
  assert.equal(row(p.id).status, 'cancelled');
});

test('a run killed mid-publish is recovered after 5 minutes (the 8-image carousel bug)', async () => {
  const nowSec = Math.floor(Date.now() / 1000);
  const id = insertPost({ status: 'publishing', attempts: 1, claimed_at: nowSec - 30, images: JSON.stringify([1, 2, 3, 4, 5, 6, 7, 8].map(KEY)) });
  await publishDue(env);
  assert.equal(row(id).status, 'publishing'); // still inside its 5-minute claim: left alone
  assert.equal(calls.length, 0);
  db.prepare('UPDATE posts SET claimed_at = ? WHERE id = ?').run(nowSec - 600, id);
  await publishDue(env);
  assert.equal(row(id).status, 'published');
  assert.equal(mediaCalls().length, 9); // 8 children + carousel
});

/** Makes /{ig}/media list one newest post with this caption. */
function newestMedia(caption) {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => (new URL(url).pathname.endsWith(`/${ME}/media`) && !init?.method
    ? new Response(JSON.stringify({ data: [{ id: 'm-latest', caption, permalink: 'https://www.instagram.com/p/z/' }] }))
    : realFetch(url, init));
}

test('never publishes twice: a container already PUBLISHED is just recorded', async () => {
  const id = insertPost({ status: 'processing', container_id: 'c-old', auto_keyword: 'k', auto_link: 'https://a.b' });
  statusCode = 'PUBLISHED';
  newestMedia(row(id).caption);
  await publishDue(env);
  assert.ok(!calls.some((c) => c.path.endsWith('/media_publish')));
  assert.equal(row(id).status, 'published');
  assert.equal(row(id).media_id, 'm-latest');
  assert.ok(row(id).rule_id);
});

test('a temporary error keeps the container, so the retry checks it instead of rebuilding', async () => {
  const id = insertPost({ status: 'processing', container_id: 'c-keep' });
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => (new URL(url).pathname.endsWith('/media_publish')
    ? new Response(JSON.stringify({ error: { message: 'temporary' } }), { status: 500 })
    : realFetch(url, init));
  await publishDue(env);
  assert.equal(row(id).status, 'processing');
  assert.equal(row(id).container_id, 'c-keep');
  assert.equal(mediaCalls().length, 0);
});

test('recovery leaves someone else\'s newest post alone: no media ID, no automation', async () => {
  const id = insertPost({ status: 'processing', container_id: 'c-old', auto_keyword: 'k', auto_link: 'https://a.b' });
  statusCode = 'PUBLISHED';
  newestMedia('posted from the Instagram app in the meantime');
  await publishDue(env);
  assert.equal(row(id).status, 'published');
  assert.equal(row(id).media_id, null);
  assert.equal(row(id).rule_id, null);
});
