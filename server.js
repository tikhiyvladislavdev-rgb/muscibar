/**
 * Mini search backend — Deezer proxy + unified search
 * Run: node server.js
 * Then open http://localhost:8787
 */
const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');

const PORT = process.env.PORT || 8787;
const ROOT = __dirname;

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

function send(res, code, body, type = 'application/json') {
  const data = typeof body === 'string' ? body : JSON.stringify(body);
  res.writeHead(code, {
    'Content-Type': type + '; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Cache-Control': 'no-store'
  });
  res.end(data);
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

const server = http.createServer(async (req, res) => {
  if (req.method === 'OPTIONS') return send(res, 204, '');

  const u = new URL(req.url, `http://localhost:${PORT}`);

  // API: unified search
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
      const add = (list) => {
        for (const t of list) {
          const key = (t.title + '|' + t.artist).toLowerCase();
          if (seen.has(key)) continue;
          seen.add(key);
          results.push(t);
        }
      };
      if (dz.status === 'fulfilled') add(mapDeezer(dz.value));
      if (it.status === 'fulfilled') add(mapItunes(it.value));
      return send(res, 200, { results, q });
    } catch (e) {
      return send(res, 500, { error: String(e.message || e) });
    }
  }

  // static files
  let filePath = u.pathname === '/' ? '/index-v4.html' : u.pathname;
  filePath = path.normalize(path.join(ROOT, filePath));
  if (!filePath.startsWith(ROOT)) return send(res, 403, 'Forbidden', 'text/plain');

  fs.readFile(filePath, (err, data) => {
    if (err) return send(res, 404, 'Not found: ' + u.pathname, 'text/plain');

    // Fix accidental GitHub uploads of Node Buffer JSON dumps:
    // {"type":"Buffer","data":[60,33,68,...]}
    try {
      const asText = data.toString('utf8').trim();
      if (asText.startsWith('{"type":"Buffer"')) {
        const parsed = JSON.parse(asText);
        if (parsed && parsed.type === 'Buffer' && Array.isArray(parsed.data)) {
          data = Buffer.from(parsed.data);
          console.log('Decoded Buffer-JSON file:', u.pathname);
        }
      }
    } catch (e) {
      // keep original data
    }

    const ext = path.extname(filePath);
    const types = {
      '.html': 'text/html',
      '.js': 'application/javascript',
      '.css': 'text/css',
      '.json': 'application/json',
      '.txt': 'text/plain'
    };
    send(res, 200, data, types[ext] || 'application/octet-stream');
  });
});

server.listen(PORT, () => {
  console.log('');
  console.log('  Бар Мята — search server');
  console.log('  http://localhost:' + PORT);
  console.log('  Guest:  http://localhost:' + PORT + '/index-v4.html');
  console.log('  Admin:  http://localhost:' + PORT + '/admin.html');
  console.log('  Hall:   http://localhost:' + PORT + '/hall.html');
  console.log('  API:    http://localhost:' + PORT + '/api/search?q=лепс');
  console.log('');
});
