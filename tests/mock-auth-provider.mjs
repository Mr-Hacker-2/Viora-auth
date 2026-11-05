const realFetch = globalThis.fetch;
const objects = new Map();

globalThis.fetch = async (input, init = {}) => {
  const url = new URL(typeof input === 'string' ? input : input.url);
  if (url.hostname === 'oauth2.googleapis.com' && url.pathname === '/token') {
    const body = new URLSearchParams(init.body || '');
    return Response.json({ access_token: body.get('code') === 'unverified' ? 'test-unverified-access-token' : 'test-google-access-token' });
  }
  if (url.hostname === 'openidconnect.googleapis.com' && url.pathname === '/v1/userinfo') {
    const verified = new Headers(init.headers).get('authorization') !== 'Bearer test-unverified-access-token';
    return Response.json({ email: process.env.MOCK_USER_EMAIL, email_verified: verified, name: 'Test User', picture: '' });
  }
  if (url.hostname === '127.0.0.1' && url.port === process.env.MOCK_B2_PORT) {
    const key = decodeURIComponent(url.pathname.split('/').slice(2).join('/'));
    if ((init.method || 'GET') === 'GET') return objects.has(key) ? Response.json(objects.get(key)) : new Response('', { status: 404 });
    if (init.method === 'PUT') { objects.set(key, JSON.parse(init.body)); return new Response('', { status: 200 }); }
  }
  return realFetch(input, init);
};
