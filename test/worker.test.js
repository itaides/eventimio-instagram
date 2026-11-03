/**
 * End-to-end webhook → send tests: the real Worker against an in-memory SQLite D1 shim
 * and a fake Instagram Graph API.
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { createHmac } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import worker from '../src/index.js';
import { DEFAULTS } from '../src/flow.js';

const SECRET = 'app-secret';
const ME = '17841400000000000';

/** Minimal D1 API over node:sqlite. */
function d1(db) {
  const stmt = (sql, params = []) => ({
    bind: (...p) => stmt(sql, p),
    async run() {
      const r = db.prepare(sql).run(...params);
      return { meta: { changes: Number(r.changes), last_row_id: Number(r.lastInsertRowid) } };
    },
    async first(col) {
      const row = db.prepare(sql).get(...params);
      return row ? (col ? row[col] : { ...row }) : null;
    },
    async all() { return { results: db.prepare(sql).all(...params).map((r) => ({ ...r })) }; },
  });
  return { prepare: (sql) => stmt(sql), batch: async (list) => Promise.all(list.map((s) => s.run())) };
}

let db, env, calls, profile;

beforeEach(() => {
  db = new DatabaseSync(':memory:');
  for (const f of readdirSync(new URL('../migrations/', import.meta.url)).sort()) {
    db.exec(readFileSync(new URL(`../migrations/${f}`, import.meta.url), 'utf8'));
  }
  for (const [k, v] of Object.entries({ username: 'yourbrand' })) {
    db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').run(k, v);
  }
  env = { DB: d1(db), IG_APP_SECRET: SECRET, IG_ACCESS_TOKEN: 'tok', IG_USER_ID: ME, PAGE_ID: 'page1', GRAPH_VERSION: 'v26.0', MAX_PER_HOUR: '150' };
  calls = [];
  profile = { username: 'dana', is_user_follow_business: false };
  globalThis.fetch = async (url, init = {}) => {
    const u = new URL(url);
    const body = init.body ? JSON.parse(init.body) : null;
    calls.push({ method: init.method || 'GET', path: u.pathname, body });
    let res = {};
    if (u.hostname !== 'graph.facebook.com') throw new Error(`unexpected host ${u.hostname}`);
    if (u.pathname.endsWith('/messages')) res = { message_id: 'm' };
    else if (u.pathname.endsWith('/subscribed_apps')) res = { success: true };
    else if (u.pathname.endsWith(`/${ME}`) && u.searchParams.get('fields') === 'id,username') res = { id: ME, username: 'yourbrand' };
    else if (u.pathname.endsWith('/replies')) res = { id: 'our-reply-1' };
    else if (u.searchParams.get('fields')?.includes('is_user_follow_business')) {
      if (profile instanceof Error) return new Response(JSON.stringify({ error: { message: profile.message } }), { status: 400 });
      res = profile;
    }
    return new Response(JSON.stringify(res), { status: 200 });
  };
});

function addRule(fields) {
  const rule = { source: 'comment', trigger_mode: 'keyword', keyword: 'לינק', message: 'הנה הלינק', button_url: 'https://example.com', button_text: 'לאתר', created_at: 1, ...fields };
  const cols = Object.keys(rule);
  const r = db.prepare(`INSERT INTO rules (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`).run(...Object.values(rule));
  return Number(r.lastInsertRowid);
}

async function webhook(payload) {
  const raw = JSON.stringify(payload);
  const sig = `sha256=${createHmac('sha256', SECRET).update(raw).digest('hex')}`;
  const pending = [];
  const ctx = { waitUntil: (p) => pending.push(p) };
  const res = await worker.fetch(new Request('https://ig.example.com/webhook', {
    method: 'POST', body: raw, headers: { 'X-Hub-Signature-256': sig },
  }), env, ctx);
  await Promise.all(pending);
  return res;
}

const comment = (id, text, { from = 'u1', username = 'dana', media = 'reel1' } = {}) => ({
  object: 'instagram',
  entry: [{ id: ME, changes: [{ field: 'comments', value: { id, text, from: { id: from, username }, media: { id: media } } }] }],
});
const tap = (mid, payload, sender = 'igsid-1') => ({
  object: 'instagram',
  entry: [{ id: ME, messaging: [{ sender: { id: sender }, recipient: { id: ME }, timestamp: 1, postback: { mid, payload, title: 't' } }] }],
});
const sentMessages = () => calls.filter((c) => c.path.endsWith('/messages')).map((c) => c.body);
const buttonsOf = (m) => m.message.attachment?.payload.buttons || [];

test('rejects a bad signature', async () => {
  const res = await worker.fetch(new Request('https://x/webhook', { method: 'POST', body: '{}', headers: { 'X-Hub-Signature-256': 'sha256=00' } }), env, { waitUntil() {} });
  assert.equal(res.status, 401);
});

test('plain rule: keyword comment gets the link as a private reply plus a public reply', async () => {
  addRule({ public_reply: 'שלחתי לך בפרטי' });
  await webhook(comment('c1', 'אפשר לינק?'));
  const [msg] = sentMessages();
  assert.deepEqual(msg.recipient, { comment_id: 'c1' });
  assert.equal(buttonsOf(msg)[0].url, 'https://example.com');
  assert.ok(calls.some((c) => c.path.endsWith('/c1/replies')));
  assert.equal(db.prepare("SELECT status FROM sends WHERE event_id='c1'").get().status, 'sent');
});

test('opener + follow gate: full flow for a non-follower who then follows', async () => {
  const id = addRule({ opener_text: 'ראיתי שהגבת, לשלוח?', follow_gate: 1 });

  await webhook(comment('c1', 'לינק'));
  let [msg] = sentMessages();
  assert.deepEqual(msg.recipient, { comment_id: 'c1' });
  assert.deepEqual(buttonsOf(msg).map((b) => b.payload), [`open:${id}`]);

  calls = [];
  await webhook(tap('pb1', `open:${id}`));
  [msg] = sentMessages();
  assert.deepEqual(msg.recipient, { id: 'igsid-1' });
  assert.equal(msg.message.attachment.payload.text, DEFAULTS.he.follow_text);
  assert.equal(buttonsOf(msg)[0].url, 'https://www.instagram.com/yourbrand');
  assert.equal(buttonsOf(msg)[1].payload, `followed:${id}`);

  calls = [];
  await webhook(tap('pb2', `followed:${id}`));
  [msg] = sentMessages();
  assert.equal(msg.message.attachment.payload.text, DEFAULTS.he.follow_reminder_text);

  calls = [];
  profile = { username: 'dana', is_user_follow_business: true };
  await webhook(tap('pb3', `followed:${id}`));
  [msg] = sentMessages();
  assert.equal(buttonsOf(msg)[0].url, 'https://example.com');
});

test('follow gate: if Meta cannot tell us, the link goes out anyway', async () => {
  const id = addRule({ follow_gate: 1, opener_text: 'x' });
  profile = new Error('unsupported');
  await webhook(tap('pb1', `open:${id}`));
  assert.equal(buttonsOf(sentMessages()[0])[0].url, 'https://example.com');
});

test('opener without follow gate: tap sends the link with no profile lookup', async () => {
  const id = addRule({ opener_text: 'לשלוח?' });
  await webhook(tap('pb1', `open:${id}`));
  assert.equal(calls.filter((c) => c.method === 'GET').length, 0);
  assert.equal(buttonsOf(sentMessages()[0])[0].url, 'https://example.com');
});

test('Meta redelivering the same tap sends once', async () => {
  const id = addRule({ opener_text: 'x' });
  await webhook(tap('pb1', `open:${id}`));
  await webhook(tap('pb1', `open:${id}`));
  assert.equal(sentMessages().length, 1);
});

test('foreign or unknown postbacks are ignored', async () => {
  addRule({});
  await webhook(tap('pb1', 'ICEBREAKER'));
  await webhook(tap('pb2', 'open:999'));
  assert.equal(calls.length, 0);
});

test('any-comment mode: once per person per reel', async () => {
  addRule({ trigger_mode: 'any', keyword: '' });
  await webhook(comment('c1', 'וואו 😍'));
  await webhook(comment('c2', 'מהמם', { from: 'u1' }));
  await webhook(comment('c3', 'עוד', { from: 'u1', media: 'reel2' }));
  await webhook(comment('c4', 'יפה', { from: 'u2' }));
  assert.deepEqual(sentMessages().map((m) => m.recipient.comment_id), ['c1', 'c3', 'c4']);
});

test('public-only rule: public reply, no DM', async () => {
  addRule({ send_dm: 0, public_reply: 'תודה!' });
  await webhook(comment('c1', 'לינק'));
  assert.equal(sentMessages().length, 0);
  assert.ok(calls.some((c) => c.path.endsWith('/c1/replies')));
});

test('never replies to our own comments or to replies the bot posted', async () => {
  addRule({ trigger_mode: 'any', keyword: '', public_reply: 'שלחתי' });
  await webhook(comment('c1', 'לינק', { from: ME, username: 'yourbrand' }));
  await webhook(comment('c2', 'לינק', { from: 'other-id', username: 'yourbrand' }));
  assert.equal(calls.length, 0);

  await webhook(comment('c3', 'hi', { from: 'u9', username: 'x' }));
  calls = [];
  // the bot's own public reply comes back as a webhook from an id we may not recognise
  await webhook(comment('our-reply-1', 'שלחתי', { from: 'weird', username: 'weird', media: 'reel7' }));
  assert.equal(calls.length, 0);
});

test('DM keyword rule replies by recipient id', async () => {
  addRule({ source: 'dm', keyword: 'מחירים' });
  await webhook({ object: 'instagram', entry: [{ id: ME, messaging: [{ sender: { id: 'igsid-9' }, message: { mid: 'mid1', text: 'מה המחירים?' } }] }] });
  assert.deepEqual(sentMessages()[0].recipient, { id: 'igsid-9' });
});

const auth = { Authorization: `Basic ${btoa('admin:pw')}` };

test('admin: requires the password', async () => {
  env.ADMIN_PASSWORD = 'pw';
  const res = await worker.fetch(new Request('https://ig.example.com/admin'), env, { waitUntil() {} });
  assert.equal(res.status, 401);
});

test('admin: renders the editor for a rule and escapes user text', async () => {
  env.ADMIN_PASSWORD = 'pw';
  const id = addRule({ name: '<script>x</script>', lang: 'en', opener_text: 'Hi {username}', follow_gate: 1 });
  const res = await worker.fetch(new Request(`https://ig.example.com/admin?edit=${id}`, { headers: auth }), env, { waitUntil() {} });
  const page = await res.text();
  assert.equal(res.status, 200);
  assert.ok(!page.includes('<script>x</script>'));
  assert.ok(page.includes('&lt;script&gt;x&lt;/script&gt;'));
  assert.ok(page.includes('name="action" value="update"'));
  assert.match(page, /name="lang" value="en" checked/);
  assert.match(page, /name="follow_gate"[^>]*checked/);
});

test('admin: saving the form creates, then updates a rule', async () => {
  env.ADMIN_PASSWORD = 'pw';
  const post = (fields) => worker.fetch(new Request('https://ig.example.com/admin', {
    method: 'POST', headers: { ...auth, Origin: 'https://ig.example.com' }, body: new URLSearchParams(fields),
  }), env, { waitUntil() {} });

  let res = await post({ action: 'add', lang: 'fr', source: 'comment', trigger_mode: 'keyword', keyword: 'guide', message: 'Voici', button_url: 'https://example.com', follow_gate: 'on' });
  assert.equal(res.status, 303);
  assert.match(res.headers.get('Location'), /edit=\d+&msg=added/);
  const row = db.prepare('SELECT * FROM rules').get();
  assert.equal(row.lang, 'fr');
  assert.equal(row.follow_gate, 1);
  assert.equal(row.button_text, 'Ouvrir');

  res = await post({ action: 'update', id: String(row.id), lang: 'en', source: 'comment', trigger_mode: 'any', message: 'Here' });
  assert.match(res.headers.get('Location'), /edit=\d+&msg=saved/);
  const upd = db.prepare('SELECT * FROM rules WHERE id = ?').get(row.id);
  assert.equal(upd.trigger_mode, 'any');
  assert.equal(upd.follow_gate, 0);
  assert.equal(upd.lang, 'en');

  res = await worker.fetch(new Request('https://ig.example.com/admin', {
    method: 'POST', headers: { ...auth, Origin: 'https://evil.example' }, body: new URLSearchParams({ action: 'delete', id: String(row.id) }),
  }), env, { waitUntil() {} });
  assert.equal(res.status, 403);
});

test('verify: checks the token, caches the username and subscribes the linked Page', async () => {
  env.ADMIN_PASSWORD = 'pw';
  const res = await worker.fetch(new Request('https://ig.example.com/admin', {
    method: 'POST', headers: { ...auth, Origin: 'https://ig.example.com' }, body: new URLSearchParams({ action: 'verify' }),
  }), env, { waitUntil() {} });
  assert.match(res.headers.get('Location'), /msg=verified/);
  assert.equal(db.prepare("SELECT value FROM settings WHERE key='username'").get().value, 'yourbrand');
  const sub = calls.find((c) => c.path.endsWith('/page1/subscribed_apps'));
  assert.equal(sub.method, 'POST');
});

test('verify: missing token is reported, not thrown', async () => {
  env.ADMIN_PASSWORD = 'pw';
  delete env.IG_ACCESS_TOKEN;
  const res = await worker.fetch(new Request('https://ig.example.com/admin', {
    method: 'POST', headers: { ...auth, Origin: 'https://ig.example.com' }, body: new URLSearchParams({ action: 'verify' }),
  }), env, { waitUntil() {} });
  assert.match(res.headers.get('Location'), /msg=verifyfailed/);
  assert.match(db.prepare("SELECT value FROM settings WHERE key='token_error'").get().value, /IG_ACCESS_TOKEN/);
  assert.equal(calls.length, 0);
});

test('webhook is refused when the app secret is not configured', async () => {
  delete env.IG_APP_SECRET;
  const res = await worker.fetch(new Request('https://ig.example.com/webhook', {
    method: 'POST', body: '{}', headers: { 'X-Hub-Signature-256': `sha256=${createHmac('sha256', 'undefined').update('{}').digest('hex')}` },
  }), env, { waitUntil() {} });
  assert.equal(res.status, 401);
});

test('admin: strict CSP, nonce on our inline script, and a dialog instead of confirm()', async () => {
  env.ADMIN_PASSWORD = 'pw';
  const id = addRule({ name: 'Guide' });
  const res = await worker.fetch(new Request(`https://ig.example.com/admin?edit=${id}`, { headers: auth }), env, { waitUntil() {} });
  const page = await res.text();
  const csp = res.headers.get('Content-Security-Policy');
  const nonce = csp.match(/'nonce-([^']+)'/)[1];
  assert.match(csp, /default-src 'none'/);
  assert.match(csp, /frame-ancestors 'none'/);
  assert.ok(!csp.includes('unsafe-inline'));
  assert.equal(res.headers.get('X-Content-Type-Options'), 'nosniff');
  assert.ok(page.includes(`<script nonce="${nonce}">`));
  assert.ok(!/<script>/.test(page));
  assert.ok(!/ style="/.test(page));
  assert.match(page, new RegExp(`command="show-modal" commandfor="delete-${id}"`));
  assert.match(page, new RegExp(`<dialog id="delete-${id}" class="confirm" closedby="any"`));
  assert.ok(!page.includes('confirm('));
});

test('nonces differ per response', async () => {
  const get = async () => (await worker.fetch(new Request('https://ig.example.com/privacy'), env, { waitUntil() {} }))
    .headers.get('Content-Security-Policy');
  assert.notEqual(await get(), await get());
});

test('legal pages are self-contained: no requests to /public, which Zero Trust guards', async () => {
  for (const path of ['/privacy', '/data-deletion']) {
    const page = await (await worker.fetch(new Request(`https://ig.example.com${path}`), env, { waitUntil() {} })).text();
    assert.ok(!/(href|src)="\/(?!data-deletion)/.test(page), `${path} references a local asset`);
    assert.match(page, /<style nonce="/);
  }
});

/** Makes every DM send fail with this Graph error. */
function failSends(error) {
  const ok = globalThis.fetch;
  globalThis.fetch = async (url, init) => (new URL(url).pathname.endsWith('/messages')
    ? new Response(JSON.stringify({ error }), { status: 400 })
    : ok(url, init));
}
const send = (id) => db.prepare('SELECT * FROM sends WHERE event_id = ?').get(id);

test('a failed send waits (backoff) instead of burning its retries on the next webhook', async () => {
  addRule({});
  failSends({ code: 2, message: 'temporary' });
  await webhook(comment('c1', 'לינק'));
  const first = send('c1');
  assert.equal(first.status, 'pending');
  assert.equal(first.attempts, 1);
  assert.ok(first.retry_at > Math.floor(Date.now() / 1000));
  await webhook(comment('c2', 'לינק', { from: 'u2' })); // c2 fails too; c1 is not retried yet
  assert.equal(send('c1').attempts, 1);
});

test('a comment that finally fails frees the once-per-post slot', async () => {
  addRule({});
  failSends({ code: 2, message: 'temporary' });
  await webhook(comment('c1', 'לינק'));
  db.prepare("UPDATE sends SET attempts = 2, retry_at = 0 WHERE event_id = 'c1'").run();
  await webhook({ object: 'instagram', entry: [] }); // any webhook flushes the queue
  assert.equal(send('c1').status, 'failed');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM deliveries').get().n, 0);
});

test('an expired token shows on the admin banner', async () => {
  addRule({});
  failSends({ code: 190, message: 'Error validating access token' });
  await webhook(comment('c1', 'לינק'));
  assert.match(db.prepare("SELECT value FROM settings WHERE key = 'token_error'").get().value, /access token/);
});

test('one flush stays inside the Graph call budget', async () => {
  addRule({ public_reply: 'בפרטי' });
  const now = Math.floor(Date.now() / 1000);
  const ins = db.prepare("INSERT INTO sends (event_id, source, step, rule_id, status, created_at) VALUES (?, 'comment', 'trigger', 1, 'pending', ?)");
  for (let i = 0; i < 20; i += 1) ins.run(`q${i}`, now);
  await webhook({ object: 'instagram', entry: [] });
  assert.ok(calls.length <= 25, `${calls.length} Graph calls`);
  assert.ok(db.prepare("SELECT COUNT(*) AS n FROM sends WHERE status = 'pending'").get().n > 0);
});

test('webhook: valid signature but broken JSON is a 400, not a crash', async () => {
  const raw = '{not json';
  const sig = `sha256=${createHmac('sha256', SECRET).update(raw).digest('hex')}`;
  const res = await worker.fetch(new Request('https://ig.example.com/webhook', { method: 'POST', body: raw, headers: { 'X-Hub-Signature-256': sig } }), env, { waitUntil() {} });
  assert.equal(res.status, 400);
});

test('admin: a cross-site POST is refused even without an Origin header', async () => {
  env.ADMIN_PASSWORD = 'pw';
  const res = await worker.fetch(new Request('https://ig.example.com/admin', {
    method: 'POST', headers: { ...auth, 'Sec-Fetch-Site': 'cross-site' }, body: new URLSearchParams({ action: 'delete', id: '1' }),
  }), env, { waitUntil() {} });
  assert.equal(res.status, 403);
});

test('branding: BRAND_LOGO/BRAND_ICON show the logo and widen img-src; unsafe values are ignored', async () => {
  env.ADMIN_PASSWORD = 'pw';
  const get = async (path) => {
    const res = await worker.fetch(new Request(`https://ig.example.com${path}`, { headers: auth }), env, { waitUntil() {} });
    return { html: await res.text(), csp: res.headers.get('Content-Security-Policy') };
  };

  let { html } = await get('/admin');
  assert.match(html, /<span class="top__brand">/); // no logo configured: the name as text

  env.BRAND_LOGO = 'https://cdn.brand.example/logo.svg';
  env.BRAND_ICON = 'https://cdn.brand.example/icon.svg';
  let csp;
  ({ html, csp } = await get('/admin'));
  assert.match(html, /<img class="top__logo" src="https:\/\/cdn\.brand\.example\/logo\.svg"/);
  assert.match(html, /<link rel="icon" href="https:\/\/cdn\.brand\.example\/icon\.svg">/);
  assert.match(csp, /img-src [^;]*https:\/\/cdn\.brand\.example/);
  ({ html } = await get('/privacy'));
  assert.match(html, /class="brand-logo" src="https:\/\/cdn\.brand\.example\/logo\.svg"/);

  env.BRAND_LOGO = '/brand/logo.svg'; // a site path: fine for the admin, skipped on public pages
  ({ html } = await get('/admin'));
  assert.match(html, /src="\/brand\/logo\.svg"/);
  ({ html } = await get('/privacy'));
  assert.ok(!html.includes('/brand/logo.svg'));

  for (const bad of ['javascript:alert(1)', '//evil.example/x.svg', 'http://plain.example/x.svg', 'https://x.example/a" onerror="x']) {
    env.BRAND_LOGO = bad;
    ({ html, csp } = await get('/admin'));
    assert.match(html, /<span class="top__brand">/, bad);
    assert.ok(!csp.includes('evil') && !csp.includes('plain.example'), bad);
  }
  delete env.BRAND_LOGO;
  delete env.BRAND_ICON;
});
