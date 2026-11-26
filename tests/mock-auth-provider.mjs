const realFetch = globalThis.fetch;
const objects = new Map();\nconst versions = new Map();\nlet nextVersion = 1;\nconst xml = value => String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');\nfunction putVersion(key, value, deleteMarker = false) { const list = versions.get(key) || []; list.push({ id: 'v' + nextVersion++, value, deleteMarker }); versions.set(key, list); if (deleteMarker) objects.delete(key); else objects.set(key, value); }

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
    const method = init.method || 'GET';
    if (method === 'GET' && url.searchParams.has('versions')) {
      const prefix = url.searchParams.get('prefix') || '';
      const entries = [...versions.entries()].filter(([name]) => name.startsWith(prefix)).flatMap(([name, list]) => list.slice().reverse().map((v, i) => ({ key: name, ...v, latest: i === 0 })));
      const body = entries.map(v => v.deleteMarker
        ? '<DeleteMarker><Key>' + xml(v.key) + '</Key><VersionId>' + v.id + '</VersionId><IsLatest>' + v.latest + '</IsLatest></DeleteMarker>'
        : '<Version><Key>' + xml(v.key) + '</Key><VersionId>' + v.id + '</VersionId><IsLatest>' + v.latest + '</IsLatest></Version>').join('');
      return new Response('<ListVersionsResult><IsTruncated>false</IsTruncated>' + body + '</ListVersionsResult>', { status: 200, headers: { 'Content-Type': 'application/xml' } });
    }
    if (method === 'GET' && url.searchParams.get('list-type') === '2') {
      const prefix = url.searchParams.get('prefix') || '';
      const body = [...objects.keys()].filter(name => name.startsWith(prefix)).map(name => '<Contents><Key>' + xml(name) + '</Key></Contents>').join('');
      return new Response('<ListBucketResult><IsTruncated>false</IsTruncated>' + body + '</ListBucketResult>', { status: 200 });
    }
    if (method === 'GET') return objects.has(key) ? Response.json(objects.get(key)) : new Response('', { status: 404 });
    if (method === 'PUT') { putVersion(key, JSON.parse(init.body)); return new Response('', { status: 200 }); }
    if (method === 'DELETE') {
      const versionId = url.searchParams.get('versionId');
      if (versionId) {
        const list = versions.get(key) || [];
        versions.set(key, list.filter(v => v.id !== versionId));
        const remaining = versions.get(key) || [], latest = remaining[remaining.length - 1];
        if (!latest || latest.deleteMarker) objects.delete(key); else objects.set(key, latest.value);
      } else putVersion(key, null, true);
      return new Response('', { status: 204 });
    }
  }
  return realFetch(input, init);
};
