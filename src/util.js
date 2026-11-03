/** Small shared helpers for HTML output and comparisons. */

const ENTITIES = new Map([['&', '&amp;'], ['<', '&lt;'], ['>', '&gt;'], ['"', '&quot;'], ["'", '&#39;']]);

/** Escapes a value for HTML text and attribute positions. */
export function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (ch) => ENTITIES.get(ch));
}

/** Compares two strings without an early exit, so timing doesn't reveal how much matched. */
export function constantTimeEqual(a, b) {
  const x = String(a);
  const y = String(b);
  let diff = x.length ^ y.length;
  const len = Math.max(x.length, y.length);
  for (let i = 0; i < len; i += 1) diff |= (x.charCodeAt(i) || 0) ^ (y.charCodeAt(i) || 0);
  return diff === 0;
}

export const nowSec = () => Math.floor(Date.now() / 1000);

/** Page images: our own, Meta's CDNs (post thumbnails), and in-browser previews of picked files. */
const IMG_SRC = "'self' https://*.cdninstagram.com https://*.fbcdn.net blob: data:";

/**
 * An HTML response with a strict CSP. Each response gets a fresh nonce, stamped on our own inline
 * <script> and <style> tags here; user text is escaped, so it can never carry a tag that gets one.
 */
export function htmlResponse(body, status = 200) {
  const nonce = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(16))));
  const html = body.replace(/<(script|style)>/g, `<$1 nonce="${nonce}">`);
  const csp = [
    "default-src 'none'",
    `script-src 'self' 'nonce-${nonce}'`,
    `style-src 'self' 'nonce-${nonce}'`,
    `img-src ${IMG_SRC}`,
    "font-src 'self'",
    "connect-src 'self'",
    "form-action 'self'",
    "base-uri 'none'",
    "frame-ancestors 'none'",
    "object-src 'none'",
  ].join('; ');
  return new Response(html, {
    status,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Content-Security-Policy': csp,
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'strict-origin-when-cross-origin',
      'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
      'Cross-Origin-Opener-Policy': 'same-origin',
    },
  });
}
