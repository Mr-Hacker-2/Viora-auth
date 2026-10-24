import http from 'node:http';
import crypto from 'node:crypto';

const { GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, TOKEN_SECRET } = process.env;
const BASE = process.env.BASE_URL || 'https://viora-auth.onrender.com';
const ALLOWED_EXT = (process.env.ALLOWED_EXT || 'kkcljeingbbpgbilahlaganmmgggbkik').split(',');
const SITE = (process.env.SITE_URL || "").replace(/\/$/, "");
const REDIRECT = `${BASE}/auth/callback`;

if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET || !TOKEN_SECRET) {
  console.error('Missing env vars: GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, TOKEN_SECRET');
}

const b64 = (b) => Buffer.from(b).toString('base64url');
const sign = (obj) => {
  const p = b64(JSON.stringify(obj));
  return p + '.' + crypto.createHmac('sha256', TOKEN_SECRET).update(p).digest('base64url');
};
const unsign = (t) => {
  const [p, s] = String(t || '').split('.');
  if (!p || !s) return null;
  const good = crypto.createHmac('sha256', TOKEN_SECRET).update(p).digest('base64url');
  if (s.length !== good.length || !crypto.timingSafeEqual(Buffer.from(s), Buffer.from(good))) return null;
  const o = JSON.parse(Buffer.from(p, 'base64url').toString());
  return o.exp > Date.now() ? o : null;
};
// Send the result back to the extension (ext) or to the website (site mode).
const back = (res, st, params) => {
  const loc = st.site ? `${SITE}/login.html#` + new URLSearchParams(params) : `https://${st.ext}.chromiumapp.org/?` + new URLSearchParams(params);
  res.writeHead(302, { Location: loc });
  res.end();
};

http.createServer(async (req, res) => {
  const u = new URL(req.url, BASE);
  try {
    if (u.pathname === '/auth/google') {
      const site = u.searchParams.get('site') === '1';
      const ext = u.searchParams.get('ext');
      if (site && !SITE) { res.writeHead(500); return res.end('SITE_URL is not set on the server'); }
      if (!site && !ALLOWED_EXT.includes(ext)) { res.writeHead(400); return res.end('Unknown extension'); }
      const state = sign({ ext, site, n: crypto.randomUUID(), exp: Date.now() + 10 * 60e3 });
      res.writeHead(302, {
        Location: 'https://accounts.google.com/o/oauth2/v2/auth?' + new URLSearchParams({
          client_id: GOOGLE_CLIENT_ID, redirect_uri: REDIRECT, response_type: 'code',
          scope: 'openid email profile', state, prompt: 'select_account'
        })
      });
      return res.end();
    }

    if (u.pathname === '/auth/callback') {
      const st = unsign(u.searchParams.get('state'));
      if (!st) { res.writeHead(400); return res.end('Bad or expired state'); }
      if (u.searchParams.get('error')) return back(res, st, { error: u.searchParams.get('error') });
      const tr = await fetch('https://oauth2.googleapis.com/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          code: u.searchParams.get('code'), client_id: GOOGLE_CLIENT_ID,
          client_secret: GOOGLE_CLIENT_SECRET, redirect_uri: REDIRECT, grant_type: 'authorization_code'
        })
      });
      const tok = await tr.json();
      if (!tok.access_token) { console.error('token exchange failed', tok); return back(res, st, { error: 'token_exchange' }); }
      const info = await (await fetch('https://openidconnect.googleapis.com/v1/userinfo', {
        headers: { Authorization: 'Bearer ' + tok.access_token }
      })).json();
      if (!info.email || !info.email_verified) return back(res, st, { error: 'unverified_email' });
      const user = { email: info.email, name: info.name || '', picture: info.picture || '' };
      return back(res, st, { token: sign({ ...user, exp: Date.now() + 30 * 864e5 }), ...user });
    }

    if (u.pathname === '/api/verify') {
      const o = unsign(u.searchParams.get('token'));
      res.writeHead(o ? 200 : 401, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      return res.end(JSON.stringify(o ? { email: o.email, name: o.name, picture: o.picture } : { error: 'invalid' }));
    }

    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('Viora auth OK');
  } catch (e) {
    console.error(e);
    res.writeHead(500); res.end('Server error');
  }
}).listen(process.env.PORT || 3000);
