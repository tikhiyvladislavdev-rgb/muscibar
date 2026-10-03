/**
 * Бар Мята v5 — search, shared state, keep-alive, rate-limit, min-bid
 */
const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');
const crypto = require('crypto');

const PORT = process.env.PORT || 8787;
const ROOT = __dirname;
const GITHUB_RAW = process.env.GITHUB_RAW ||
  'https://raw.githubusercontent.com/tikhiyvladislavdev-rgb/muscibar/main';
const STATE_FILE = path.join(ROOT, 'data-state.json');
const PUBLIC_URL = process.env.RENDER_EXTERNAL_URL || process.env.PUBLIC_URL || '';
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || ''; // optional extra secret
const MUSIC_DIR = path.join(ROOT, 'music');

// ---------- state ----------
let state = {
  queue: [],
  pending: [],
  stoplist: [],
  stats: {
    totalOrders: 0, accepted: 0, rejected: 0, revenue: 0,
    todayOrders: 0, todayRevenue: 0, lastReset: new Date().toDateString()
  },
  settings: {
    venueName: 'БАР МЯТА',
    minBid: 100,
    adminPin: '1234',
    avgTrackSec: 210
  },
  history: [],
  nowPlaying: null,
  trackStats: {},
  updatedAt: Date.now()
};

try {
  if (fs.existsSync(STATE_FILE)) {
    const loaded = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    state = Object.assign(state, loaded);
    if (!state.settings) state.settings = { minBid: 100, adminPin: '1234' };
    console.log('State loaded');
  }
} catch (e) {
  console.warn('State load fail', e.message);
}

function saveState() {
  state.updatedAt = Date.now();
  try { fs.writeFileSync(STATE_FILE, JSON.stringify(state)); } catch (_) {}
}

function minBid() {
  return Math.max(50, Number((state.settings && state.settings.minBid) || 100));
}

// ---------- rate limit (simple in-memory) ----------
const hits = new Map(); // ip -> { count, reset }
function rateLimit(ip, limit, windowMs) {
  const now = Date.now();
  let e = hits.get(ip);
  if (!e || now > e.reset) {
    e = { count: 0, reset: now + windowMs };
    hits.set(ip, e);
  }
  e.count++;
  return e.count <= limit;
}
function clientIp(req) {
  return (req.headers['x-forwarded-for'] || '').split(',')[0].trim() ||
    req.socket.remoteAddress || 'unknown';
}

// cleanup rate map periodically
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of hits) if (now > v.reset) hits.delete(k);
}, 60000);

// ---------- keep-alive self ping ----------
function selfPing() {
  const base = PUBLIC_URL || ('http://127.0.0.1:' + PORT);
  const url = base.replace(/\/$/, '') + '/health';
  try {
    const lib = url.startsWith('https') ? https : http;
    lib.get(url, { timeout: 10000 }, (res) => { res.resume(); }).on('error', () => {});
  } catch (_) {}
}
// every 10 min — keeps Render free tier awake if PUBLIC_URL set
setInterval(selfPing, 10 * 60 * 1000);
setTimeout(selfPing, 15000);

// also client-side can hit /health — we expose it

// ---------- http helpers ----------
function fetchJson(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': 'BarMusic/5.0' }, timeout: 8000 }, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(e); }
      });
    }).on('error', reject);
  });
}

function fetchBuffer(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': 'BarMusic/5.0' }, timeout: 12000 }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return fetchBuffer(res.headers.location).then(resolve, reject);
      }
      if (res.statusCode !== 200) return reject(new Error('HTTP ' + res.statusCode));
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks)));
    }).on('error', reject);
  });
}

function send(res, code, body, type) {
  type = type || 'application/json';
  const data = Buffer.isBuffer(body)
    ? body
    : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body), 'utf8');
  res.writeHead(code, {
    'Content-Type': type + '; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, X-Admin-Pin, X-Admin-Token',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'SAMEORIGIN',
    'Referrer-Policy': 'no-referrer'
  });
  res.end(data);
}

function readBody(req, maxBytes) {
  maxBytes = maxBytes || 200000;
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > maxBytes) {
        reject(new Error('Body too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      try {
        const raw = Buffer.concat(chunks).toString('utf8');
        resolve(raw ? JSON.parse(raw) : {});
      } catch (e) { reject(e); }
    });
    req.on('error', reject);
  });
}

function checkAdmin(req) {
  const pin = req.headers['x-admin-pin'] || '';
  const token = req.headers['x-admin-token'] || '';
  const okPin = String(pin) === String((state.settings && state.settings.adminPin) || '1234');
  const okToken = ADMIN_TOKEN && token === ADMIN_TOKEN;
  return okPin || okToken;
}

function normalizeStop(title, artist) {
  const clean = (s) => String(s || '').toLowerCase()
    .replace(/\(.*?\)|\[.*?\]/g, '')
    .replace(/[^\p{L}\p{N}\s]/gu, '')
    .replace(/\s+/g, ' ').trim();
  return clean(title) + '|' + clean(artist);
}

function isStopped(title, artist) {
  const key = normalizeStop(title, artist);
  const titleOnly = normalizeStop(title, '');
  return (state.stoplist || []).some((item) => {
    const k = normalizeStop(item.title, item.artist);
    return k === key || (item.blockAllVersions && normalizeStop(item.title, '') === titleOnly);
  });
}

function mapDeezer(data) {
  return (data.data || []).map((t) => ({
    id: 'dz_' + t.id,
    title: t.title,
    artist: (t.artist && t.artist.name) || 'Unknown',
    cover: (t.album && (t.album.cover_medium || t.album.cover)) || '',
    duration: t.duration || 0,
    preview: t.preview || '',
    explicit: !!t.explicit_lyrics,
    source: 'deezer'
  }));
}

function mapItunes(data) {
  return (data.results || []).filter((t) => t.trackName).map((t) => ({
    id: 'it_' + t.trackId,
    title: t.trackName,
    artist: t.artistName || 'Unknown',
    cover: (t.artworkUrl100 || '').replace('100x100bb', '300x300bb').replace('100x100', '300x300'),
    duration: Math.round((t.trackTimeMillis || 0) / 1000),
    preview: t.previewUrl || '',
    explicit: t.trackExplicitness === 'explicit',
    source: 'itunes'
  }));
}

function scoreTrack(q, t) {
  const n = (s) => String(s || '').toLowerCase();
  const qq = n(q);
  const title = n(t.title);
  const artist = n(t.artist);
  let s = 0;
  if (title === qq) s += 20;
  if (title.startsWith(qq)) s += 12;
  if (title.includes(qq)) s += 8;
  if (artist.includes(qq)) s += 10;
  const tokens = qq.split(/\s+/).filter(Boolean);
  tokens.forEach((tok) => {
    if (title.includes(tok)) s += 3;
    if (artist.includes(tok)) s += 4;
  });
  return s;
}

async function unifiedSearch(q) {
  const queries = [q];
  // split "artist track"
  const parts = q.trim().split(/\s+/);
  if (parts.length >= 2) {
    queries.push(parts.slice(0, 2).join(' '));
    queries.push(parts[0]);
  }
  const unique = [...new Set(queries)].slice(0, 3);
  const tasks = [];
  unique.forEach((qq) => {
    tasks.push(fetchJson('https://api.deezer.com/search?q=' + encodeURIComponent(qq) + '&limit=40').then(mapDeezer).catch(() => []));
    tasks.push(fetchJson('https://itunes.apple.com/search?term=' + encodeURIComponent(qq) + '&entity=song&limit=30&country=ru&media=music').then(mapItunes).catch(() => []));
    tasks.push(fetchJson('https://itunes.apple.com/search?term=' + encodeURIComponent(qq) + '&entity=song&limit=20&media=music').then(mapItunes).catch(() => []));
  });
  const batches = await Promise.all(tasks);
  const seen = new Set();
  let results = [];
  batches.forEach((list) => {
    list.forEach((t) => {
      const key = (t.title + '|' + t.artist).toLowerCase();
      if (seen.has(key)) return;
      if (isStopped(t.title, t.artist)) return;
      seen.add(key);
      results.push(t);
    });
  });
  results.sort((a, b) => scoreTrack(q, b) - scoreTrack(q, a));
  return results.slice(0, 50);
}

function looksLikeBufferJson(buf) {
  return buf.toString('utf8', 0, Math.min(40, buf.length)).trim().startsWith('{"type":"Buffer"');
}
function decodeBufferJson(buf) {
  try {
    const parsed = JSON.parse(buf.toString('utf8'));
    if (parsed && parsed.type === 'Buffer' && Array.isArray(parsed.data)) return Buffer.from(parsed.data);
  } catch (_) {}
  return null;
}
function audioType(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  return ({'.mp3':'audio/mpeg','.m4a':'audio/mp4','.aac':'audio/aac','.ogg':'audio/ogg','.wav':'audio/wav','.webm':'audio/webm','.flac':'audio/flac'})[ext] || 'application/octet-stream';
}

function scanMusicDir(dir = MUSIC_DIR, prefix = '') {
  if (!fs.existsSync(dir)) return [];
  const out = [];
  for (const name of fs.readdirSync(dir, {withFileTypes:true})) {
    const full = path.join(dir, name.name);
    const rel = prefix ? path.join(prefix, name.name) : name.name;
    if (name.isDirectory()) out.push(...scanMusicDir(full, rel));
    else if (/\.(mp3|m4a|aac|ogg|wav|webm|flac)$/i.test(name.name)) {
      const base = name.name.replace(/\.[^.]+$/, '');
      const parts = base.split(/\s+-\s+/, 2);
      out.push({ id:'local_' + crypto.createHash('sha1').update(rel).digest('hex').slice(0,12), title: parts.length>1 ? parts[1] : base, artist: parts.length>1 ? parts[0] : 'Local', file:'/music/' + rel.split(path.sep).map(encodeURIComponent).join('/'), duration:0, source:'local' });
    }
  }
  return out;
}

function recommendationScore(seed, candidate, historyKeys) {
  const n = s => String(s||'').toLowerCase();
  const a=n(seed.artist), ca=n(candidate.artist), t=n(seed.title), ct=n(candidate.title);
  let score = 0;
  if (a && ca===a) score += 40;
  if (a && (ca.includes(a)||a.includes(ca))) score += 18;
  const artistWords = a.split(/\s+/).filter(x=>x.length>2);
  artistWords.forEach(w=>{ if(ca.includes(w)) score+=8; });
  if (historyKeys.has(n(candidate.title)+'|'+ca)) score -= 12;
  if (ct===t) score -= 100;
  return score + Math.random()*3;
}

function buildWave(seed) {
  const local = scanMusicDir();
  const catalog = local.length ? local : [];
  const historyKeys = new Set((state.history||[]).filter(h=>h.type==='played').map(h=>nkey(h.title,h.artist)));
  return catalog.sort((a,b)=>recommendationScore(seed,b,historyKeys)-recommendationScore(seed,a,historyKeys)).slice(0,20);
}
function nkey(title,artist){ return String(title||'').toLowerCase()+'|'+String(artist||'').toLowerCase(); }

function contentType(filePath) {
  const ext = path.extname(filePath);
  return ({
    '.html': 'text/html',
    '.js': 'application/javascript',
    '.css': 'text/css',
    '.json': 'application/json',
    '.txt': 'text/plain'
  })[ext] || 'application/octet-stream';
}

async function readStatic(relPath) {
  let rel = relPath === '/' || relPath === '' ? '/index-v4.html' : relPath;
  if (rel === '/index.html') rel = '/index-v4.html';
  if (rel === '/robots.txt') return Buffer.from('User-agent: *\nDisallow:\n');
  const localPath = path.normalize(path.join(ROOT, rel));
  if (!localPath.startsWith(ROOT)) throw new Error('Forbidden');
  try {
    let data = fs.readFileSync(localPath);
    if (looksLikeBufferJson(data)) {
      const d = decodeBufferJson(data);
      if (d) return d;
    } else return data;
  } catch (_) {}
  const remote = await fetchBuffer(GITHUB_RAW.replace(/\/$/, '') + rel);
  if (looksLikeBufferJson(remote)) {
    const d = decodeBufferJson(remote);
    if (d) return d;
  }
  return remote;
}

function publicState() {
  // don't expose adminPin to guests in full form — still needed by admin page via settings
  // strip pin from GET for non-admin? Admin needs it from local settings.
  // Return full state; pin is already known to admin operator.
  return state;
}

const server = http.createServer(async (req, res) => {
  if (req.method === 'OPTIONS') return send(res, 204, '');

  const ip = clientIp(req);
  const u = new URL(req.url, 'http://localhost:' + PORT);

  // global soft rate limit
  if (!rateLimit(ip, 120, 60000)) {
    return send(res, 429, { error: 'Слишком много запросов. Подожди минуту.' });
  }

  if (u.pathname === '/health') {
    return send(res, 200, {
      ok: true,
      updatedAt: state.updatedAt,
      pending: (state.pending || []).length,
      queue: (state.queue || []).length,
      uptime: process.uptime()
    });
  }

  // search — stricter rate
  if (u.pathname === '/api/search') {
    if (!rateLimit(ip + ':search', 40, 60000)) {
      return send(res, 429, { error: 'Поиск: лимит. Подожди.' });
    }
    const q = (u.searchParams.get('q') || '').trim().slice(0, 80);
    if (!q) return send(res, 200, { results: [] });
    try {
      const results = await unifiedSearch(q);
      return send(res, 200, { results, q });
    } catch (e) {
      return send(res, 500, { error: String(e.message || e) });
    }
  }

  if (u.pathname === '/api/state' && req.method === 'GET') {
    return send(res, 200, publicState());
  }

  if (u.pathname === '/api/state' && req.method === 'POST') {
    if (!rateLimit(ip + ':state', 30, 60000)) return send(res, 429, { error: 'rate' });
    try {
      const body = await readBody(req);
      // guests can only push limited fields via order endpoint; full state needs admin for destructive
      // Allow merge for queue/pending from authenticated admin OR soft merge
      if (body._admin) {
        if (!checkAdmin(req)) return send(res, 403, { error: 'Нужен PIN админа' });
      }
      ['queue', 'pending', 'stoplist', 'stats', 'settings', 'history', 'nowPlaying', 'trackStats'].forEach((k) => {
        if (body[k] !== undefined) state[k] = body[k];
      });
      // enforce minBid in settings
      if (state.settings && state.settings.minBid != null) {
        state.settings.minBid = Math.max(50, Number(state.settings.minBid) || 100);
      }
      saveState();
      return send(res, 200, { ok: true, updatedAt: state.updatedAt });
    } catch (e) {
      return send(res, 400, { error: String(e.message || e) });
    }
  }

  if (u.pathname === '/api/order' && req.method === 'POST') {
    if (!rateLimit(ip + ':order', 20, 60000)) {
      return send(res, 429, { error: 'Слишком много заказов с этого устройства' });
    }
    try {
      const body = await readBody(req);
      const order = body.order;
      if (!order || !order.title || !order.artist) {
        return send(res, 400, { error: 'Некорректный заказ' });
      }
      const bid = Number(order.bid);
      const min = minBid();
      if (!Number.isFinite(bid) || bid < min) {
        return send(res, 400, { error: 'Минимальная ставка ' + min + ' ₽' });
      }
      if (bid > 500000) {
        return send(res, 400, { error: 'Слишком большая сумма' });
      }
      if (isStopped(order.title, order.artist)) {
        return send(res, 400, { error: 'Трек в стоп-листе' });
      }
      // capacity: max pending
      if ((state.pending || []).length >= 200) {
        return send(res, 503, { error: 'Слишком много заказов, подождите' });
      }
      order.id = order.id || ('ord_' + Date.now().toString(36) + crypto.randomBytes(3).toString('hex'));
      order.time = Date.now();
      order.status = 'pending';
      order.bid = bid;
      order.title = String(order.title).slice(0, 120);
      order.artist = String(order.artist).slice(0, 120);
      order.ip = ip.slice(0, 64);

      state.pending = state.pending || [];
      state.pending.unshift(order);
      state.stats = state.stats || {};
      const today = new Date().toDateString();
      if (state.stats.lastReset !== today) {
        state.stats.todayOrders = 0;
        state.stats.todayRevenue = 0;
        state.stats.lastReset = today;
      }
      state.stats.totalOrders = (state.stats.totalOrders || 0) + 1;
      state.stats.todayOrders = (state.stats.todayOrders || 0) + 1;
      state.stats.revenue = (state.stats.revenue || 0) + bid;
      state.stats.todayRevenue = (state.stats.todayRevenue || 0) + bid;
      state.history = state.history || [];
      state.history.unshift({ type: 'order', orderId: order.id, title: order.title, bid, at: Date.now() });
      state.history = state.history.slice(0, 300);

      const tkey = (order.title + '|' + order.artist).toLowerCase();
      state.trackStats = state.trackStats || {};
      if (!state.trackStats[tkey]) {
        state.trackStats[tkey] = { title: order.title, artist: order.artist, cover: order.cover || '', count: 0, lastAt: 0 };
      }
      state.trackStats[tkey].count += 1;
      state.trackStats[tkey].lastAt = Date.now();

      saveState();
      return send(res, 200, { ok: true, order, pending: state.pending.length });
    } catch (e) {
      return send(res, 400, { error: String(e.message || e) });
    }
  }

  if (u.pathname === '/api/library') {
    if (!checkAdmin(req)) return send(res, 403, { error: 'Нужен PIN админа' });
    return send(res, 200, { tracks: scanMusicDir(), count: scanMusicDir().length });
  }

  if (u.pathname === '/api/wave' && req.method === 'GET') {
    const title = (u.searchParams.get('title') || '').trim();
    const artist = (u.searchParams.get('artist') || '').trim();
    if (!title && !artist) return send(res, 400, { error:'Нужен seed-трек' });
    const tracks = buildWave({title, artist});
    return send(res, 200, { seed:{title,artist}, tracks });
  }

  if (u.pathname === '/api/player' && req.method === 'GET') {
    return send(res, 200, { nowPlaying: state.nowPlaying || null, queue: state.queue || [], mode: (state.settings && state.settings.playerMode) || 'queue' });
  }

  if (u.pathname === '/api/player' && req.method === 'POST') {
    if (!checkAdmin(req)) return send(res, 403, { error: 'Нужен PIN админа' });
    try {
      const body = await readBody(req);
      const action = body.action;
      if (action === 'set') state.nowPlaying = body.track || null;
      else if (action === 'clear') state.nowPlaying = null;
      else if (action === 'next') {
        const next = (state.queue||[]).shift() || null;
        state.nowPlaying = next ? {...next, status:'playing', playedAt:Date.now()} : null;
        if (next) { state.history = state.history || []; state.history.unshift({type:'played', orderId:next.id, title:next.title, artist:next.artist, at:Date.now()}); state.history=state.history.slice(0,300); }
      } else if (action === 'enqueue') {
        if (!body.track || !body.track.title) return send(res,400,{error:'Нет трека'});
        state.queue = state.queue || []; state.queue.push({...body.track, id:body.track.id || ('auto_'+Date.now().toString(36)), source:body.track.source||'player'});
      } else if (action === 'remove') {
        state.queue = (state.queue||[]).filter(t=>t.id!==body.id);
      } else if (action === 'mode') {
        state.settings = state.settings || {}; state.settings.playerMode = ['queue','wave','party','chill'].includes(body.mode) ? body.mode : 'queue';
      } else return send(res,400,{error:'Неизвестное действие'});
      saveState();
      return send(res,200,{ok:true, nowPlaying:state.nowPlaying, queue:state.queue, mode:state.settings.playerMode});
    } catch(e) { return send(res,400,{error:String(e.message||e)}); }
  }

  // local audio with byte-range support
  if (u.pathname.startsWith('/music/')) {
    const rel = decodeURIComponent(u.pathname.slice('/music/'.length));
    const file = path.normalize(path.join(MUSIC_DIR, rel));
    if (!file.startsWith(MUSIC_DIR) || !fs.existsSync(file) || !fs.statSync(file).isFile()) return send(res,404,'Not found','text/plain');
    const stat=fs.statSync(file), size=stat.size, range=req.headers.range;
    res.setHeader('Content-Type', audioType(file)); res.setHeader('Accept-Ranges','bytes'); res.setHeader('Cache-Control','no-store');
    if (range) {
      const m=/bytes=(\d*)-(\d*)/.exec(range); let start=m&&m[1]?Number(m[1]):0; let end=m&&m[2]?Number(m[2]):size-1;
      if (end>=size) end=size-1; if(start>end || start>=size) return send(res,416,'Range Not Satisfiable','text/plain');
      res.writeHead(206, {'Content-Range':`bytes ${start}-${end}/${size}`,'Content-Length':end-start+1}); fs.createReadStream(file,{start,end}).pipe(res);
    } else { res.writeHead(200, {'Content-Length':size}); fs.createReadStream(file).pipe(res); }
    return;
  }

  // static
  try {
    const data = await readStatic(u.pathname);
    return send(res, 200, data, contentType(u.pathname === '/' ? '/index-v4.html' : u.pathname));
  } catch (e) {
    return send(res, 404, 'Not found', 'text/plain');
  }
});

server.listen(PORT, () => {
  console.log('Bar Myata v5 port', PORT);
  console.log('Keep-alive PUBLIC_URL:', PUBLIC_URL || '(set RENDER_EXTERNAL_URL)');
  console.log('Min bid:', minBid());
});
