import crypto from 'node:crypto';

/** Signed, expiring session tokens: base64url(JSON payload) + '.' + HMAC-SHA256 signature. */
export function makeTokens(secret) {
  const sign = obj => {
    const p = Buffer.from(JSON.stringify(obj)).toString('base64url');
    return p + '.' + crypto.createHmac('sha256', secret).update(p).digest('base64url');
  };
  /** Returns the payload for a valid, unexpired token, and null for anything else (never throws, whatever the input). */
  const unsign = t => {
    try {
      const [p, s, extra] = String(t || '').split('.');
      if (!p || !s || extra !== undefined) return null;
      // Compare bytes, not string lengths: a multi-byte character would otherwise pass a length check and make
      // timingSafeEqual throw.
      const given = Buffer.from(s), good = Buffer.from(crypto.createHmac('sha256', secret).update(p).digest('base64url'));
      if (given.length !== good.length || !crypto.timingSafeEqual(given, good)) return null;
      const o = JSON.parse(Buffer.from(p, 'base64url').toString());
      return o && typeof o === 'object' && o.exp > Date.now() ? o : null;
    } catch { return null; }
  };
  return { sign, unsign };
}

/** The session token a request carries: the Authorization header wins; the query string is a legacy fallback. */
export function tokenFromRequest(req, url) {
  const header = String(req.headers?.authorization || '').replace(/^Bearer\s+/i, '').trim();
  return header || url?.searchParams?.get('token') || '';
}
