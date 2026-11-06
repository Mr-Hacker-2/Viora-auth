const realFetch = globalThis.fetch;
const objects = new Map();

globalThis.fetch = async (input, init = {}) => {
  const url = new URL(typeof input === 'string' ? input : input.url);
  if (url.hostname === 'oauth2.googleapis.com' && url.pathname === '/token') {
    const body = new URLSearchParams(init.body || '');
    const code = body.get('code');
    return Response.json({ access_token: code === 'unverified' ? 'test-unverified-access-token' : code === 'email-account' ? 'test-email-access-token' : 'test-google-access-token' });
  }
  if (url.hostname === 'openidconnect.googleapis.com' && url.pathname === '/v1/userinfo') {
    const auth = new Headers(init.headers).get('authorization');
    const verified = auth !== 'Bearer test-unverified-access-token';
    const email = auth === 'Bearer test-email-access-token' ? 'email.user@example.com' : process.env.MOCK_USER_EMAIL;
    return Response.json({ email, email_verified: verified, name: 'Test User', picture: '' });
  }
  if (url.hostname === 'api.resend.com' && url.pathname === '/emails') {
    return realFetch(`http://127.0.0.1:${process.env.MOCK_MAIL_PORT}/capture`, init);
  }
  if (url.hostname === '127.0.0.1' && url.port === process.env.MOCK_MAIL_PORT) return realFetch(input, init);
  if (url.hostname === '127.0.0.1' && url.port === process.env.MOCK_B2_PORT) {
    const key = decodeURIComponent(url.pathname.split('/').slice(2).join('/'));
    if ((init.method || 'GET') === 'GET') return objects.has(key) ? Response.json(objects.get(key)) : new Response('', { status: 404 });
    if (init.method === 'PUT') { objects.set(key, JSON.parse(init.body)); return new Response('', { status: 200 }); }
  }
  return realFetch(input, init);
};
