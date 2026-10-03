/**
 * Бар Мята — search + shared state API (queue/pending for all devices)
 */
const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');

const PORT = process.env.PORT || 8787;
const ROOT = __dirname;
const GITHUB_RAW = process.env.GITHUB_RAW ||
  'https://raw.githubusercontent.com/tikhiyvladislavdev-rgb/muscibar/main';
const STATE_FILE = path.join(ROOT, 'data-state.json');

// ---------- shared state (all guests + admin) ----------
let state = {
  queue: [],
  pending: [],
  stoplist: [],
  stats: {
    totalOrders: 0, accepted: 0, rejected: 0, revenue: 0,
    todayOrders: 0, todayRevenue: 0, lastReset: new Date().toDateString()
  },
  settings: null,
  history: [],
  nowPlaying: null,
  trackStats: {},
  updatedAt: Date.now()
};

try {
  if (fs.existsSync(STATE_FILE)) {
    const loaded = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    state = Object.assign(state, loaded);
    console.log('State loaded from disk');
  }
} catch (e) {
  console.warn('State load failed', e.message);
}

function saveState() {
  state.updatedAt = Date.now();
  try {
    fs.writeFileSync(STATE_FILE, JSON.stringify(state));
  } catch (e) {
    // Render free disk may be ephemeral — ok, memory still works while process lives
  }
}

function fetchJson(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': 'BarMusic/1.0' } }, (res) => {
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
    https.get(url, { headers: { 'User-Agent': 'BarMusic/1.0' } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return fetchBuffer(res.headers.location).then(resolve, reject);
      }
      if (res.statusCode !== 200) {
        return reject(new Error('HTTP ' + res.statusCode + ' for ' + url));
      }
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
    'Access-Control-Allow-Headers': 'Content-Type',
    'Cache-Control': 'no-store'
  });
  res.end(data);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      try {
        const raw = Buffer.concat(chunks).toString('utf8');
        resolve(raw ? JSON.parse(raw) : {});
      } catch (e) { reject(e); }
    });
    req.on('error', reject);
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

function looksLikeBufferJson(buf) {
  const s = buf.toString('utf8', 0, Math.min(40, buf.length)).trim();
  return s.startsWith('{"type":"Buffer"');
}

function decodeBufferJson(buf) {
  try {
    const parsed = JSON.parse(buf.toString('utf8'));
    if (parsed && parsed.type === 'Buffer' && Array.isArray(parsed.data)) {
      return Buffer.from(parsed.data);
    }
  } catch (_) {}
  return null;
}

function contentType(filePath) {
  const ext = path.extname(filePath);
  const types = {
    '.html': 'text/html',
    '.js': 'application/javascript',
    '.css': 'text/css',
    '.json': 'application/json',
    '.txt': 'text/plain'
  };
  return types[ext] || 'application/octet-stream';
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
      const decoded = decodeBufferJson(data);
      if (decoded) return decoded;
    } else {
      return data;
    }
  } catch (e) {}

  const ghUrl = GITHUB_RAW.replace(/\/$/, '') + rel;
  let remote = await fetchBuffer(ghUrl);
  if (looksLikeBufferJson(remote)) {
    const decoded = decodeBufferJson(remote);
    if (decoded) remote = decoded;
  }
  return remote;
}

const server = http.createServer(async (req, res) => {
  if (req.method === 'OPTIONS') return send(res, 204, '');

  const u = new URL(req.url, 'http://localhost:' + PORT);

  if (u.pathname === '/health') {
    return send(res, 200, { ok: true, updatedAt: state.updatedAt });
  }

  // ----- shared state API -----
  if (u.pathname === '/api/state' && req.method === 'GET') {
    return send(res, 200, state);
  }

  if (u.pathname === '/api/state' && req.method === 'POST') {
    try {
      const body = await readBody(req);
      // full replace of known keys
      const keys = ['queue', 'pending', 'stoplist', 'stats', 'settings', 'history', 'nowPlaying', 'trackStats'];
      keys.forEach((k) => {
        if (body[k] !== undefined) state[k] = body[k];
      });
      saveState();
      return send(res, 200, { ok: true, updatedAt: state.updatedAt });
    } catch (e) {
      return send(res, 400, { error: String(e.message || e) });
    }
  }

  // patch helpers for common actions
  if (u.pathname === '/api/order' && req.method === 'POST') {
    try {
      const body = await readBody(req);
      const order = body.order;
      if (!order || !order.id) return send(res, 400, { error: 'no order' });
      state.pending = state.pending || [];
      state.pending.unshift(order);
      state.stats = state.stats || {};
      state.stats.totalOrders = (state.stats.totalOrders || 0) + 1;
      state.stats.todayOrders = (state.stats.todayOrders || 0) + 1;
      state.stats.revenue = (state.stats.revenue || 0) + (order.bid || 0);
      state.stats.todayRevenue = (state.stats.todayRevenue || 0) + (order.bid || 0);
      state.history = state.history || [];
      state.history.unshift({ type: 'order', orderId: order.id, title: order.title, bid: order.bid, at: Date.now() });
      state.history = state.history.slice(0, 200);
      // track stats
      const key = (order.title + '|' + order.artist).toLowerCase();
      state.trackStats = state.trackStats || {};
      if (!state.trackStats[key]) {
        state.trackStats[key] = { title: order.title, artist: order.artist, cover: order.cover || '', count: 0, lastAt: 0 };
      }
      state.trackStats[key].count += 1;
      state.trackStats[key].lastAt = Date.now();
      saveState();
      return send(res, 200, { ok: true, pending: state.pending.length });
    } catch (e) {
      return send(res, 400, { error: String(e.message || e) });
    }
  }

  if (u.pathname === '/api/search') {
    const q = (u.searchParams.get('q') || '').trim();
    if (!q) return send(res, 200, { results: [] });
    try {
      const [dz, it] = await Promise.allSettled([
        fetchJson('https://api.deezer.com/search?q=' + encodeURIComponent(q) + '&limit=30'),
        fetchJson('https://itunes.apple.com/search?term=' + encodeURIComponent(q) + '&entity=song&limit=25&country=ru&media=music')
      ]);
      const results = [];
      const seen = new Set();
      const add = function (list) {
        for (let i = 0; i < list.length; i++) {
          const t = list[i];
          const key = (t.title + '|' + t.artist).toLowerCase();
          if (seen.has(key)) continue;
          seen.add(key);
          results.push(t);
        }
      };
      if (dz.status === 'fulfilled') add(mapDeezer(dz.value));
      if (it.status === 'fulfilled') add(mapItunes(it.value));
      return send(res, 200, { results: results, q: q });
    } catch (e) {
      return send(res, 500, { error: String(e.message || e) });
    }
  }

  try {
    const data = await readStatic(u.pathname);
    const ct = contentType(u.pathname === '/' ? '/index-v4.html' : u.pathname);
    return send(res, 200, data, ct);
  } catch (e) {
    if (String(e.message || e).indexOf('404') >= 0 || String(e.message || e).indexOf('HTTP') >= 0) {
      return send(res, 404, 'Not found: ' + u.pathname, 'text/plain');
    }
    console.error(e);
    return send(res, 404, 'Not found: ' + u.pathname, 'text/plain');
  }
});

server.listen(PORT, function () {
  console.log('');
  console.log('  Bar Myata search + shared state');
  console.log('  port:', PORT);
  console.log('  API: /api/state /api/order /api/search');
  console.log('');
});
