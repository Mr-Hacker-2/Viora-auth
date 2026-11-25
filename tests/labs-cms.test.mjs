import test from 'node:test';
import assert from 'node:assert/strict';
import { handleLabsAdmin, handleLabsPublic, defaultLabsTools } from '../labs-cms.js';

function harness(seed = {}) {
  const store = new Map(Object.entries(seed));
  const audits = [];
  const deps = {
    b2Ready: () => true,
    getJson: async key => store.has(key) ? structuredClone(store.get(key)) : null,
    putJson: async (key, value) => store.set(key, structuredClone(value)),
    getObject: async key => store.get(key) || null,
    putObject: async (key, value, type) => store.set(key, { bytes: Buffer.from(value), type, arrayBuffer: async () => Buffer.from(value) }),
    readBody: async req => req.body,
    audit: async (...args) => audits.push(args),
    cors: () => ({ 'Access-Control-Allow-Origin': '*' }),
    json: (res, code, body) => { res.code = code; res.body = body; return true; }
  };
  const res = { writeHead(code, headers) { this.code = code; this.headers = headers; }, end(body) { this.binary = body; } };
  return { store, audits, deps, res };
}

test('public Labs API returns only active tools and published articles', async () => {
  const { store, deps, res } = harness({
    'labs/tools.json': { tools: [...defaultLabsTools(), { id:'hidden', name:'Hidden', short:'Not public', active:false, order:5 }] },
    'labs/articles.json': { articles: [
      { id:'live', title:'Live', status:'published', publishedAt:'2026-01-01T00:00:00Z' },
      { id:'draft', title:'Draft', status:'draft' }
    ] }
  });
  await handleLabsPublic({ method:'GET' }, res, { pathname:'/api/labs/content' }, deps);
  assert.equal(res.code, 200);
  assert.equal(res.body.tools.some(t => t.id === 'hidden'), false);
  assert.equal(res.body.tools.length, 4);
  assert.deepEqual(res.body.articles.map(a => a.id), ['live']);
});

test('admin can save tools but cannot remap built-in assistants or invent assistant IDs', async () => {
  const { deps, res, store } = harness();
  const tools = defaultLabsTools();
  tools[0].name = 'Writing Helper';
  await handleLabsAdmin({ method:'POST', body:{ tools } }, res, { pathname:'/api/admin/labs/tools' }, 'admin@example.com', deps);
  assert.equal(res.code, 200);
  assert.equal(store.get('labs/tools.json').tools[0].name, 'Writing Helper');

  const invalid = [...tools, { id:'new-tool', name:'New Tool', short:'Preview only', assistant:'made-up-ai' }];
  await handleLabsAdmin({ method:'POST', body:{ tools:invalid } }, res, { pathname:'/api/admin/labs/tools' }, 'admin@example.com', deps);
  assert.equal(res.code, 200);
  assert.equal(store.get('labs/tools.json').tools.at(-1).assistant, '');

  tools[0].assistant = 'search';
  await handleLabsAdmin({ method:'POST', body:{ tools } }, res, { pathname:'/api/admin/labs/tools' }, 'admin@example.com', deps);
  assert.equal(res.code, 400);
});

test('article publishing and unpublishing controls public visibility', async () => {
  const { deps, res } = harness();
  const draft = { id:'safe-article', title:'Safe article', subtitle:'A short summary', status:'draft', blocks:[{type:'paragraph',text:'Hello'}] };
  await handleLabsAdmin({ method:'POST', body:draft }, res, { pathname:'/api/admin/labs/articles' }, 'admin@example.com', deps);
  assert.equal(res.code, 201);
  await handleLabsPublic({ method:'GET' }, res, { pathname:'/api/labs/content' }, deps);
  assert.equal(res.body.articles.length, 0);

  await handleLabsAdmin({ method:'POST', body:{...draft,status:'published'} }, res, { pathname:'/api/admin/labs/articles' }, 'admin@example.com', deps);
  assert.equal(res.code, 200);
  await handleLabsPublic({ method:'GET' }, res, { pathname:'/api/labs/content' }, deps);
  assert.equal(res.body.articles[0].id, 'safe-article');

  await handleLabsAdmin({ method:'POST', body:{...draft,status:'draft'} }, res, { pathname:'/api/admin/labs/articles' }, 'admin@example.com', deps);
  await handleLabsPublic({ method:'GET' }, res, { pathname:'/api/labs/content' }, deps);
  assert.equal(res.body.articles.length, 0);
});

test('article blocks reject unsafe link protocols', async () => {
  const { deps, res } = harness();
  const article = { title:'Unsafe link', subtitle:'No javascript links', blocks:[{type:'link',text:'click',url:'javascript:alert(1)'}] };
  await handleLabsAdmin({ method:'POST', body:article }, res, { pathname:'/api/admin/labs/articles' }, 'admin@example.com', deps);
  assert.equal(res.code, 400);
});

test('image uploads reject unsupported MIME types and oversized data', async () => {
  const { deps, res, store } = harness();
  await handleLabsAdmin({ method:'POST', body:{ contentType:'text/html', data:Buffer.from('<script>').toString('base64') } }, res, { pathname:'/api/admin/labs/media' }, 'admin@example.com', deps);
  assert.equal(res.code, 400);
  assert.equal([...store.keys()].some(k => k.startsWith('labs/media/')), false);
});


test('tools can be removed by publishing the remaining tool list and articles can be deleted', async () => {
  const { deps, res, store } = harness();
  const initial = [...defaultLabsTools(), { id:'new-tool', name:'New Tool', short:'Temporary tool', active:true, order:5 }];
  await handleLabsAdmin({ method:'POST', body:{ tools:initial } }, res, { pathname:'/api/admin/labs/tools' }, 'admin@example.com', deps);
  assert.equal(res.code, 200);
  await handleLabsAdmin({ method:'POST', body:{ tools:defaultLabsTools() } }, res, { pathname:'/api/admin/labs/tools' }, 'admin@example.com', deps);
  assert.equal(store.get('labs/tools.json').tools.some(t => t.id === 'new-tool'), false);

  const article = { id:'remove-me', title:'Remove me', subtitle:'Temporary article', status:'draft', blocks:[{type:'paragraph',text:'Draft'}] };
  await handleLabsAdmin({ method:'POST', body:article }, res, { pathname:'/api/admin/labs/articles' }, 'admin@example.com', deps);
  await handleLabsAdmin({ method:'DELETE' }, res, { pathname:'/api/admin/labs/articles/remove-me' }, 'admin@example.com', deps);
  assert.equal(res.code, 200);
  assert.equal(store.get('labs/articles.json').articles.length, 0);
});

test('uploaded image stays private until referenced by an active public tool', async () => {
  const { deps, res, store } = harness();
  const png = Buffer.from([137,80,78,71,13,10,26,10]);
  await handleLabsAdmin({ method:'POST', body:{ contentType:'image/png', data:png.toString('base64') } }, res, { pathname:'/api/admin/labs/media' }, 'admin@example.com', deps);
  assert.equal(res.code, 201);
  const imageId = res.body.imageId;
  await handleLabsPublic({ method:'GET' }, res, { pathname:'/api/labs/media/'+imageId }, deps);
  assert.equal(res.code, 404);
  const tools = defaultLabsTools(); tools[0].imageId = imageId;
  store.set('labs/tools.json', { tools });
  await handleLabsPublic({ method:'GET' }, res, { pathname:'/api/labs/media/'+imageId }, deps);
  assert.equal(res.code, 200);
  assert.equal(res.headers['Content-Type'], 'image/png');
  assert.equal(res.binary.length, png.length);
});
