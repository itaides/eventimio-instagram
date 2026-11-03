/**
 * Inbound side of Meta's webhook: the subscription handshake, signature check, and turning a
 * payload into a flat list of events. Parsing is pure so it is tested without a database.
 */
import { constantTimeEqual } from './util.js';

/** Answers Meta's GET subscription check with the challenge, or 403. */
export function handshake(url, verifyToken) {
  const q = url.searchParams;
  const ok = Boolean(verifyToken) && q.get('hub.mode') === 'subscribe'
    && constantTimeEqual(q.get('hub.verify_token') ?? '', verifyToken);
  return ok ? new Response(q.get('hub.challenge') ?? '') : new Response('forbidden', { status: 403 });
}

/** Checks Meta's X-Hub-Signature-256 (HMAC-SHA256 of the raw body with the app secret). */
export async function signatureValid(appSecret, rawBody, header) {
  const match = /^sha256=([0-9a-f]{64})$/i.exec(header || '');
  if (!appSecret || !match) return false;
  const key = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(appSecret), { name: 'HMAC', hash: 'SHA-256' }, false, ['verify'],
  );
  const sig = Uint8Array.from(match[1].match(/../g), (h) => parseInt(h, 16));
  return crypto.subtle.verify('HMAC', key, sig, new TextEncoder().encode(rawBody));
}

/**
 * Flattens a webhook payload into events we act on.
 * - comment:  { type, id, text, mediaId, fromId, fromName }
 * - message:  { type, id, text, senderId, story }   (DM or story reply)
 * - tap:      { type, id, payload, title, senderId } (one of our postback buttons)
 * Echoes of our own messages, deleted and non-text messages, and our own account's activity are dropped.
 */
export function parseEvents(payload, ownId) {
  const events = [];
  for (const entry of payload?.entry ?? []) {
    for (const change of entry.changes ?? []) {
      const c = change.value ?? {};
      if (change.field !== 'comments' || !c.id) continue;
      events.push({
        type: 'comment', id: c.id, text: c.text ?? '', mediaId: c.media?.id ?? null,
        fromId: c.from?.id ?? null, fromName: c.from?.username ?? '',
      });
    }
    for (const item of entry.messaging ?? []) {
      const senderId = item.sender?.id;
      if (!senderId || senderId === ownId) continue;
      if (item.postback) {
        events.push({
          type: 'tap', id: `pb:${item.postback.mid || `${senderId}:${item.timestamp}`}`,
          payload: item.postback.payload ?? '', title: item.postback.title ?? '', senderId,
        });
        continue;
      }
      const m = item.message;
      if (!m?.mid || m.is_echo || m.is_deleted || typeof m.text !== 'string' || !m.text) continue;
      events.push({ type: 'message', id: m.mid, text: m.text, senderId, story: Boolean(m.reply_to?.story) });
    }
  }
  return events;
}
