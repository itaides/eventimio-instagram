/**
 * Thin wrappers over the Instagram API with Facebook Login for Business ("Unified login", graph.facebook.com).
 * New Meta apps can no longer use Instagram Login, so there is no OAuth flow here: the token is a
 * non-expiring system-user / Page token set once as a Worker secret (IG_ACCESS_TOKEN).
 */

/** Graph API URL for a path on the configured host and version. */
function graph(env, path) {
  return `https://${env.GRAPH_HOST || 'graph.facebook.com'}/${env.GRAPH_VERSION}${path}`;
}

/** A Graph API failure, carrying Meta's error code so callers can log or show it. */
export class GraphError extends Error {
  constructor(status, error) {
    super([status, error?.code, error?.message].filter(Boolean).join(' ') || `HTTP ${status}`);
    this.name = 'GraphError';
    this.status = status;
    this.code = error?.code ?? null;
  }
}

/** Fetches a Graph endpoint and returns its JSON; any HTTP or Graph error becomes a GraphError. */
async function call(url, init = {}) {
  const res = await fetch(url, init);
  const body = await res.json().catch(() => null);
  if (!res.ok || body?.error || body === null) throw new GraphError(res.status, body?.error ?? { message: 'invalid JSON' });
  return body;
}

const auth = (token) => ({ 'Content-Type': 'application/json', Authorization: `Bearer ${token}` });

/** The connected Instagram professional account; doubles as a token check. */
export async function getAccount(env, token, igUserId) {
  const p = new URLSearchParams({ fields: 'id,username', access_token: token });
  return call(graph(env, `/${igUserId}?${p}`));
}

/**
 * Turns on webhook delivery for the Instagram account. With Facebook Login this goes through the
 * linked Facebook Page; the fields here are Page fields, Instagram fields are chosen in the app dashboard.
 */
export async function subscribePage(env, token, pageId) {
  const p = new URLSearchParams({ subscribed_fields: 'messages,messaging_postbacks', access_token: token });
  return call(graph(env, `/${pageId}/subscribed_apps?${p}`), { method: 'POST' });
}

export async function listMedia(env, token, igUserId) {
  const p = new URLSearchParams({
    fields: 'id,caption,media_type,media_product_type,thumbnail_url,media_url,permalink,timestamp',
    limit: '30',
    access_token: token,
  });
  const res = await call(graph(env, `/${igUserId}/media?${p}`));
  return res.data || [];
}

/** Private reply: one DM to a commenter, within 7 days of the comment. */
export async function sendPrivateReply(env, token, igUserId, commentId, message) {
  return call(graph(env, `/${igUserId}/messages`), {
    method: 'POST',
    headers: auth(token),
    body: JSON.stringify({ recipient: { comment_id: commentId }, message }),
  });
}

/** Regular DM; allowed within 24h of the user's last message or button tap. */
export async function sendMessage(env, token, igUserId, recipientId, message) {
  return call(graph(env, `/${igUserId}/messages`), {
    method: 'POST',
    headers: auth(token),
    body: JSON.stringify({ recipient: { id: recipientId }, message }),
  });
}

/** Profile incl. is_user_follow_business. Only works once the user has engaged with us (e.g. tapped a button). */
export async function getProfile(env, token, igsid) {
  const p = new URLSearchParams({ fields: 'username,is_user_follow_business', access_token: token });
  return call(graph(env, `/${igsid}?${p}`));
}

export async function getUsername(env, token, igsid) {
  const p = new URLSearchParams({ fields: 'username', access_token: token });
  const res = await call(graph(env, `/${igsid}?${p}`));
  return res.username || '';
}

export async function replyPublicly(env, token, commentId, text) {
  return call(graph(env, `/${commentId}/replies`), {
    method: 'POST',
    headers: auth(token),
    body: JSON.stringify({ message: text }),
  });
}

// ---------- Content publishing (needs the separate publish token) ----------

const form = (token, fields) => ({
  method: 'POST',
  headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams(fields),
});

/** Image container. Carousel children get is_carousel_item and no caption (Meta ignores it there). */
export async function createImageContainer(env, token, igUserId, imageUrl, { caption, carouselItem } = {}) {
  const fields = { image_url: imageUrl };
  if (carouselItem) fields.is_carousel_item = 'true';
  else if (caption) fields.caption = caption;
  return (await call(graph(env, `/${igUserId}/media`), form(token, fields))).id;
}

/** Carousel container over up to 10 child containers; the caption lives here. */
export async function createCarouselContainer(env, token, igUserId, childIds, caption) {
  const fields = { media_type: 'CAROUSEL', children: childIds.join(',') };
  if (caption) fields.caption = caption;
  return (await call(graph(env, `/${igUserId}/media`), form(token, fields))).id;
}

/** FINISHED | IN_PROGRESS | ERROR | EXPIRED | PUBLISHED. Containers expire after 24h. */
export async function containerStatus(env, token, containerId) {
  const p = new URLSearchParams({ fields: 'status_code,status', access_token: token });
  return call(graph(env, `/${containerId}?${p}`));
}

/** Publishes a FINISHED container; returns the new media ID. */
export async function publishContainer(env, token, igUserId, containerId) {
  return (await call(graph(env, `/${igUserId}/media_publish`), form(token, { creation_id: containerId }))).id;
}

export async function mediaPermalink(env, token, mediaId) {
  const p = new URLSearchParams({ fields: 'permalink', access_token: token });
  return (await call(graph(env, `/${mediaId}?${p}`))).permalink || '';
}

/** Meta's own rolling 24h publishing quota; a safety net under our daily cap. */
export async function publishingLimit(env, token, igUserId) {
  const p = new URLSearchParams({ fields: 'quota_usage,config', access_token: token });
  const res = await call(graph(env, `/${igUserId}/content_publishing_limit?${p}`));
  const d = res.data?.[0] || {};
  return { used: d.quota_usage ?? 0, total: d.config?.quota_total ?? 0 };
}
