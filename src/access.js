/**
 * Cloudflare Access (Zero Trust) JWT check: a second layer behind the Access app.
 * If the Access policy were ever removed, requests without a valid team-signed token still fail.
 */

const CERTS_TTL_MS = 60 * 60 * 1000;
let certsCache = { url: '', at: 0, keys: [] };

const b64urlBytes = (s) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));
const b64urlJson = (s) => JSON.parse(new TextDecoder().decode(b64urlBytes(s)));

/** The token Access adds to every request it lets through (header first, cookie as fallback). */
export function accessToken(request) {
  const header = request.headers.get('Cf-Access-Jwt-Assertion');
  if (header) return header;
  const m = /(?:^|;\s*)CF_Authorization=([^;]+)/.exec(request.headers.get('Cookie') || '');
  return m ? m[1] : null;
}

/** Team signing keys (JWKs), cached for an hour; refetched once when a kid is unknown. */
async function teamKeys(team, kid) {
  const url = `https://${team}/cdn-cgi/access/certs`;
  const fresh = certsCache.url === url && Date.now() - certsCache.at < CERTS_TTL_MS;
  if (!fresh || !certsCache.keys.some((k) => k.kid === kid)) {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`certs ${res.status}`);
    certsCache = { url, at: Date.now(), keys: (await res.json()).keys || [] };
  }
  return certsCache.keys;
}

/**
 * Verifies an Access JWT: RS256 signature by the team, matching audience, issuer and expiry.
 * @param {string|null} token
 * @param {{team: string, aud: string}} cfg team = "<name>.cloudflareaccess.com", aud = the Access app's AUD tag
 * @returns {Promise<{email?: string}|null>} the claims, or null when invalid
 */
export async function verifyAccessJwt(token, { team, aud }) {
  if (!token || !team || !aud) return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  try {
    const header = b64urlJson(parts[0]);
    const claims = b64urlJson(parts[1]);
    if (header.alg !== 'RS256') return null;
    const jwk = (await teamKeys(team, header.kid)).find((k) => k.kid === header.kid);
    if (!jwk) return null;
    const key = await crypto.subtle.importKey(
      'jwk', { kty: jwk.kty, n: jwk.n, e: jwk.e, alg: 'RS256', ext: true },
      { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify'],
    );
    const ok = await crypto.subtle.verify(
      'RSASSA-PKCS1-v1_5', key, b64urlBytes(parts[2]), new TextEncoder().encode(`${parts[0]}.${parts[1]}`),
    );
    const now = Math.floor(Date.now() / 1000);
    const auds = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
    if (!ok || !auds.includes(aud) || claims.iss !== `https://${team}` || !(claims.exp > now)) return null;
    return claims;
  } catch {
    return null;
  }
}

/** Test hook: forget cached keys. */
export function resetAccessCache() {
  certsCache = { url: '', at: 0, keys: [] };
}
