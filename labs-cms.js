import crypto from 'node:crypto';

const TOOLS_KEY = 'labs/tools.json';
const ARTICLES_KEY = 'labs/articles.json';
const ASSISTANTS = new Set(['human', 'search', 'math']);
const FIXED = { humanizer: 'human', 'pro-search': 'search', code: 'math', math: 'math' };
const IMAGE_TYPES = {
  'image/png': { ext: 'png', valid: b => b.length >= 8 && b.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10])) },
  'image/jpeg': { ext: 'jpg', valid: b => b.length >= 3 && b[0] === 255 && b[1] === 216 && b[2] === 255 },
  'image/webp': { ext: 'webp', valid: b => b.length >= 12 && b.toString('ascii', 0, 4) === 'RIFF' && b.toString('ascii', 8, 12) === 'WEBP' },
  'image/gif': { ext: 'gif', valid: b => b.length >= 6 && ['GIF87a', 'GIF89a'].includes(b.toString('ascii', 0, 6)) }
};
const text = (value, max = 5000) => String(value ?? '').replace(/\u0000/g, '').trim().slice(0, max);
const slug = value => text(value, 120).toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 70);

export const defaultLabsTools = () => [
  { id:'humanizer',name:'Humanizer',short:'Polish your writing so it reads naturally, while keeping your meaning and your voice.',description:'Humanizer refines stiff, repetitive or awkward writing into clear, natural prose, without changing what you meant to say.',category:'Writing',icon:'✎',imageId:'',featured:true,active:true,order:1,assistant:'human',documentationUrl:'' },
  { id:'pro-search',name:'Pro Search',short:'Research complex questions across live web sources, with citations you can check.',description:'Pro Search investigates a question across the live web and answers with citations, so you can see where every claim came from.',category:'Research',icon:'⌕',imageId:'',featured:true,active:true,order:2,assistant:'search',documentationUrl:'' },
  { id:'code',name:'Code',short:'Write, debug, explain and improve code in many programming languages.',description:'Code is your programming partner: describe what you need, paste what is broken, and get working, explained solutions.',category:'Development',icon:'</>',imageId:'',featured:false,active:true,order:3,assistant:'math',documentationUrl:'' },
  { id:'math',name:'Math',short:'Solve problems step by step and understand the reasoning behind every answer.',description:'Math works through problems with you, showing each step so you understand the method, not just the answer.',category:'Education',icon:'∑',imageId:'',featured:false,active:true,order:4,assistant:'math',documentationUrl:'' }
];

function cleanTool(raw, index) {
  if (!raw || typeof raw !== 'object') throw new Error('Each Labs tool must be an object.');
  const id = slug(raw.id || raw.name), name = text(raw.name, 80), short = text(raw.short, 220);
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(id) || !name || !short) throw new Error('Every tool needs a valid ID, name, and short description.');
  const fixed = FIXED[id], assistant = fixed || (ASSISTANTS.has(raw.assistant) ? raw.assistant : '');
  if (fixed && raw.assistant && raw.assistant !== fixed) throw new Error('The existing assistant connection for ' + name + ' cannot be changed.');
  const imageId = text(raw.imageId, 64);
  if (imageId && !/^[a-f0-9-]{36}\.(?:png|jpg|webp|gif)$/.test(imageId)) throw new Error('A tool image reference is invalid.');
  let documentationUrl = '';
  if (raw.documentationUrl) {
    try { const u = new URL(String(raw.documentationUrl)); if (!['http:', 'https:'].includes(u.protocol)) throw 0; documentationUrl = u.href.slice(0, 1000); }
    catch { throw new Error('Documentation links must use HTTPS or HTTP.'); }
  }
  const order = Number(raw.order ?? index + 1);
  if (!Number.isInteger(order) || order < 0 || order > 10000) throw new Error('Tool order must be a whole number from 0 to 10000.');
  return { id, name, short, description: text(raw.description, 3000), category: text(raw.category || 'General', 60) || 'General',
    icon: text(raw.icon || '✦', 16), imageId, featured: raw.featured === true, active: raw.active !== false, order, assistant, documentationUrl };
}
function cleanBlock(raw) {
  if (!raw || typeof raw !== 'object') throw new Error('An article block is invalid.');
  const type = String(raw.type || '');
  if (!['heading','paragraph','bulleted-list','numbered-list','quote','code','link','image'].includes(type)) throw new Error('Unsupported article block type.');
  if (type === 'image') {
    const imageId = text(raw.imageId, 64);
    if (!/^[a-f0-9-]{36}\.(?:png|jpg|webp|gif)$/.test(imageId)) throw new Error('Article image reference is invalid.');
    return { type, imageId, alt: text(raw.alt, 240), caption: text(raw.caption, 300) };
  }
  if (type === 'link') {
    let url; try { url = new URL(String(raw.url || '')); } catch { throw new Error('Article links need a valid URL.'); }
    if (!['https:', 'http:'].includes(url.protocol)) throw new Error('Article links must use HTTPS or HTTP.');
    return { type, text: text(raw.text, 500), url: url.href.slice(0, 1000) };
  }
  if (type === 'bulleted-list' || type === 'numbered-list') {
    const items = Array.isArray(raw.items) ? raw.items.slice(0, 40).map(x => text(x, 500)).filter(Boolean) : [];
    if (!items.length) throw new Error('List blocks need at least one item.');
    return { type, items };
  }
  return { type, text: text(raw.text, type === 'code' ? 12000 : 5000) };
}
function cleanArticle(raw, existing = null) {
  if (!raw || typeof raw !== 'object') throw new Error('Article details are required.');
  const title = text(raw.title, 140), subtitle = text(raw.subtitle, 300);
  if (!title || !subtitle) throw new Error('Articles need a title and short description.');
  const id = slug(raw.id || title);
  if (!id) throw new Error('Article URL slug is invalid.');
  const blocks = Array.isArray(raw.blocks) ? raw.blocks.slice(0, 100).map(cleanBlock) : [];
  if (!blocks.length) throw new Error('Add at least one article content block.');
  const coverImageId = text(raw.coverImageId, 64);
  if (coverImageId && !/^[a-f0-9-]{36}\.(?:png|jpg|webp|gif)$/.test(coverImageId)) throw new Error('Cover image reference is invalid.');
  const status = raw.status === 'published' ? 'published' : 'draft';
  return { id, title, subtitle, coverImageId, blocks, author: text(raw.author || 'Viora Team', 80),
    category: text(raw.category || 'Technology', 60), tags: Array.isArray(raw.tags) ? [...new Set(raw.tags.slice(0, 12).map(x => text(x, 32)).filter(Boolean))] : [],
    status, featured: raw.featured === true, createdAt: existing?.createdAt || new Date().toISOString(),
    updatedAt: new Date().toISOString(), publishedAt: status === 'published' ? (existing?.publishedAt || new Date().toISOString()) : null };
}
async function readTools(deps) {
  const stored = await deps.getJson(TOOLS_KEY);
  return Array.isArray(stored?.tools) ? stored.tools : defaultLabsTools();
}
async function readArticles(deps) {
  const stored = await deps.getJson(ARTICLES_KEY);
  return Array.isArray(stored?.articles) ? stored.articles : [];
}
async function referenced(id, publicOnly, deps) {
  const [tools, articles] = await Promise.all([readTools(deps), readArticles(deps)]);
  return tools.some(t => (!publicOnly || t.active !== false) && t.imageId === id) ||
    articles.some(a => (!publicOnly || a.status === 'published') &&
      (a.coverImageId === id || (a.blocks || []).some(b => b.type === 'image' && b.imageId === id)));
}
async function sendImage(res, id, publicOnly, deps) {
  if (!/^[a-f0-9-]{36}\.(?:png|jpg|webp|gif)$/.test(id)) return deps.json(res, 404, { error: 'Image not found.' });
  if (!deps.b2Ready()) return deps.json(res, 503, { error: 'Image storage is unavailable.' });
  try {
    if (!(await referenced(id, publicOnly, deps))) return deps.json(res, 404, { error: 'Image not found.' });
    const object = await deps.getObject('labs/media/' + id);
    if (!object) return deps.json(res, 404, { error: 'Image not found.' });
    const bytes = Buffer.from(await object.arrayBuffer());
    const ext = id.split('.').pop(), mime = ({ png:'image/png', jpg:'image/jpeg', webp:'image/webp', gif:'image/gif' })[ext];
    res.writeHead(200, { 'Content-Type': mime, 'Content-Length': bytes.length, 'Cache-Control': 'public, max-age=3600', 'X-Content-Type-Options': 'nosniff', ...deps.cors() });
    return res.end(bytes);
  } catch { return deps.json(res, 503, { error: 'Image could not be loaded.' }); }
}

export async function handleLabsPublic(req, res, u, deps) {
  if (req.method !== 'GET') return deps.json(res, 405, { error: 'Use GET for public Labs content.' });
  if (u.pathname === '/api/labs/content') {
    if (!deps.b2Ready()) return deps.json(res, 503, { error: 'Labs publishing storage is not configured.' });
    try {
      const [tools, articles] = await Promise.all([readTools(deps), readArticles(deps)]);
      return deps.json(res, 200, { tools: tools.filter(t => t.active !== false).sort((a,b) => a.order-b.order),
        articles: articles.filter(a => a.status === 'published').sort((a,b) => String(b.publishedAt || '').localeCompare(String(a.publishedAt || ''))) });
    } catch { return deps.json(res, 503, { error: 'Published Labs content is temporarily unavailable.' }); }
  }
  if (u.pathname.startsWith('/api/labs/media/')) return sendImage(res, decodeURIComponent(u.pathname.slice('/api/labs/media/'.length)), true, deps);
  return deps.json(res, 404, { error: 'Labs endpoint not found.' });
}

export async function handleLabsAdmin(req, res, u, actor, deps) {
  const path = u.pathname;
  if (req.method === 'GET' && path === '/api/admin/labs/tools') {
    if (!deps.b2Ready()) return deps.json(res, 503, { error: 'Labs publishing storage is not configured. Configure the existing private Backblaze B2 bucket.' });
    try { return deps.json(res, 200, { tools: (await readTools(deps)).sort((a,b) => a.order-b.order) }); }
    catch { return deps.json(res, 503, { error: 'Labs tools could not be loaded from private storage.' }); }
  }
  if (req.method === 'POST' && path === '/api/admin/labs/tools') {
    let body; try { body = await deps.readBody(req, 150000); } catch { return deps.json(res, 400, { error: 'Tool list is too large or invalid.' }); }
    if (!Array.isArray(body.tools) || body.tools.length > 80) return deps.json(res, 400, { error: 'Send a list of up to 80 Labs tools.' });
    try {
      const tools = body.tools.map(cleanTool);
      if (new Set(tools.map(t => t.id)).size !== tools.length) return deps.json(res, 400, { error: 'Every Labs tool must have a unique URL slug.' });
      await deps.putJson(TOOLS_KEY, { tools, updatedAt: new Date().toISOString(), updatedBy: actor });
      await deps.audit(actor, 'labs_tools_published', 'labs/tools', 'success', { count: tools.length });
      return deps.json(res, 200, { ok: true, tools });
    } catch (error) { return deps.json(res, 400, { error: error.message || 'Labs tools could not be saved.' }); }
  }
  if (req.method === 'GET' && path === '/api/admin/labs/articles') {
    if (!deps.b2Ready()) return deps.json(res, 503, { error: 'Labs publishing storage is not configured.' });
    try { return deps.json(res, 200, { articles: (await readArticles(deps)).sort((a,b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || ''))) }); }
    catch { return deps.json(res, 503, { error: 'Labs articles could not be loaded.' }); }
  }
  if (req.method === 'POST' && path === '/api/admin/labs/articles') {
    let body; try { body = await deps.readBody(req, 700000); } catch { return deps.json(res, 400, { error: 'Article is too large or invalid.' }); }
    if (!deps.b2Ready()) return deps.json(res, 503, { error: 'Labs publishing storage is not configured.' });
    try {
      const articles = await readArticles(deps), existing = articles.find(a => a.id === slug(body.id || body.title));
      const article = cleanArticle(body, existing);
      if (articles.some(a => a.id === article.id && a.id !== existing?.id)) return deps.json(res, 409, { error: 'An article already uses that URL slug.' });
      const next = existing ? articles.map(a => a.id === existing.id ? article : a) : [...articles, article];
      if (next.length > 500) return deps.json(res, 400, { error: 'The article limit has been reached.' });
      await deps.putJson(ARTICLES_KEY, { articles: next, updatedAt: new Date().toISOString() });
      await deps.audit(actor, article.status === 'published' ? 'labs_article_published' : 'labs_article_saved', article.id, 'success');
      return deps.json(res, existing ? 200 : 201, { ok: true, article });
    } catch (error) { return deps.json(res, 400, { error: error.message || 'Article could not be saved.' }); }
  }
  if (req.method === 'DELETE' && path.startsWith('/api/admin/labs/articles/')) {
    const id = slug(decodeURIComponent(path.slice('/api/admin/labs/articles/'.length)));
    if (!id) return deps.json(res, 400, { error: 'Article ID is invalid.' });
    try {
      const articles = await readArticles(deps), next = articles.filter(a => a.id !== id);
      if (next.length === articles.length) return deps.json(res, 404, { error: 'Article not found.' });
      await deps.putJson(ARTICLES_KEY, { articles: next, updatedAt: new Date().toISOString() });
      await deps.audit(actor, 'labs_article_deleted', id, 'success');
      return deps.json(res, 200, { ok: true });
    } catch { return deps.json(res, 503, { error: 'Article could not be deleted.' }); }
  }
  if (req.method === 'POST' && path === '/api/admin/labs/media') {
    let body; try { body = await deps.readBody(req, 4500000); } catch { return deps.json(res, 400, { error: 'Image upload is too large or invalid.' }); }
    const contentType = String(body.contentType || '').toLowerCase(), spec = IMAGE_TYPES[contentType];
    const encoded = String(body.data || '').replace(/^data:[^,]*,/, '');
    if (!spec || !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) return deps.json(res, 400, { error: 'Upload a PNG, JPEG, WebP, or GIF image.' });
    const bytes = Buffer.from(encoded, 'base64');
    if (!bytes.length || bytes.length > 3 * 1024 * 1024 || !spec.valid(bytes)) return deps.json(res, 400, { error: 'Image must be a valid PNG, JPEG, WebP, or GIF under 3 MB.' });
    if (!deps.b2Ready()) return deps.json(res, 503, { error: 'Image storage is not configured.' });
    const id = crypto.randomUUID() + '.' + spec.ext;
    try {
      await deps.putObject('labs/media/' + id, bytes, contentType);
      await deps.audit(actor, 'labs_image_uploaded', id, 'success', { contentType, size: bytes.length });
      return deps.json(res, 201, { ok: true, imageId: id, url: '/api/labs/media/' + id });
    } catch { return deps.json(res, 503, { error: 'Image could not be stored. Check private B2 storage access.' }); }
  }
  if (req.method === 'GET' && path.startsWith('/api/admin/labs/media/')) {
    return sendImage(res, decodeURIComponent(path.slice('/api/admin/labs/media/'.length)), false, deps);
  }
  return null;
}
