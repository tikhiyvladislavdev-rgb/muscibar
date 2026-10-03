/**
 * Shared state & helpers for Бар Мята Music Bid
 * Uses localStorage + BroadcastChannel for live sync between guest & admin tabs
 */

const STORAGE_KEYS = {
  queue: 'bm_queue',
  pending: 'bm_pending',
  stoplist: 'bm_stoplist',
  stats: 'bm_stats',
  settings: 'bm_settings',
  history: 'bm_history',
  myBids: 'bm_my_bids',
  nowPlaying: 'bm_now_playing',
  guestOrders: 'bm_guest_orders'
};

const DEFAULT_SETTINGS = {
  venueName: 'БАР МЯТА',
  address: 'г. Ельня · ул. Пролетарская 79',
  minBid: 100,
  currency: '₽',
  accent: '#e8ff47',
  logoText: 'МЯТА',
  coverUrl: 'https://images.unsplash.com/photo-1571266028247-d9bb3953780d?w=400&h=400&fit=crop',
  adminPin: '1234',
  venueId: 'myata',
  avgTrackSec: 210,
  badWords: ['бля', 'хуй', 'пизд', 'ебан', 'сука', 'нахуй'],
  searchApi: '' // e.g. http://localhost:8787/api/search — empty = local+itunes only
};

const DEFAULT_STATS = {
  totalOrders: 0,
  accepted: 0,
  rejected: 0,
  revenue: 0,
  todayOrders: 0,
  todayRevenue: 0,
  lastReset: new Date().toDateString()
};

// ---------- storage helpers ----------
function load(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
}

function save(key, value) {
  localStorage.setItem(key, JSON.stringify(value));
  broadcast(key, value);
}

// ---------- broadcast (live sync) ----------
const channel = typeof BroadcastChannel !== 'undefined'
  ? new BroadcastChannel('bar-music')
  : null;

const listeners = [];

function broadcast(key, value) {
  if (channel) {
    channel.postMessage({ key, value, ts: Date.now() });
  }
}

if (channel) {
  channel.onmessage = (e) => {
    listeners.forEach(fn => fn(e.data));
  };
}

// also listen to storage events (other windows)
window.addEventListener('storage', (e) => {
  if (e.key && Object.values(STORAGE_KEYS).includes(e.key)) {
    listeners.forEach(fn => fn({ key: e.key, value: e.newValue ? JSON.parse(e.newValue) : null }));
  }
});

function onSync(fn) {
  listeners.push(fn);
}

// ---------- domain ----------
function getSettings() {
  return { ...DEFAULT_SETTINGS, ...load(STORAGE_KEYS.settings, {}) };
}

function setSettings(partial) {
  const next = { ...getSettings(), ...partial };
  save(STORAGE_KEYS.settings, next);
  return next;
}

function getStats() {
  let s = { ...DEFAULT_STATS, ...load(STORAGE_KEYS.stats, {}) };
  // reset daily counters
  const today = new Date().toDateString();
  if (s.lastReset !== today) {
    s.todayOrders = 0;
    s.todayRevenue = 0;
    s.lastReset = today;
    save(STORAGE_KEYS.stats, s);
  }
  return s;
}

function bumpStats(patch) {
  const s = { ...getStats(), ...patch };
  save(STORAGE_KEYS.stats, s);
  return s;
}

function getQueue() {
  return load(STORAGE_KEYS.queue, []);
}

function setQueue(q) {
  // always sort by bid desc, then time asc
  q = [...q].sort((a, b) => b.bid - a.bid || a.time - b.time);
  save(STORAGE_KEYS.queue, q);
  return q;
}

function getPending() {
  return load(STORAGE_KEYS.pending, []);
}

function setPending(p) {
  save(STORAGE_KEYS.pending, p);
  return p;
}

function getStoplist() {
  return load(STORAGE_KEYS.stoplist, []);
}

function setStoplist(list) {
  save(STORAGE_KEYS.stoplist, list);
  return list;
}

/** Normalize title+artist for stop-list matching */
function normalizeTrack(title, artist) {
  const clean = (s) => String(s || '')
    .toLowerCase()
    .replace(/\(.*?\)|\[.*?\]/g, '')
    .replace(/[^\p{L}\p{N}\s]/gu, '')
    .replace(/\s+/g, ' ')
    .trim();
  return clean(title) + '|' + clean(artist);
}

function isStopped(title, artist) {
  const key = normalizeTrack(title, artist);
  const titleOnly = normalizeTrack(title, '');
  return getStoplist().some(item => {
    const k = normalizeTrack(item.title, item.artist);
    // block if full match OR same title (all versions)
    return k === key || (item.blockAllVersions && normalizeTrack(item.title, '') === titleOnly);
  });
}

function addToStoplist(title, artist, blockAllVersions = true) {
  const list = getStoplist();
  const key = normalizeTrack(title, artist);
  if (list.some(i => normalizeTrack(i.title, i.artist) === key)) return list;
  list.push({
    id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    title,
    artist,
    blockAllVersions,
    addedAt: Date.now()
  });
  return setStoplist(list);
}

function removeFromStoplist(id) {
  return setStoplist(getStoplist().filter(i => i.id !== id));
}

function getHistory() {
  return load(STORAGE_KEYS.history, []);
}

function pushHistory(entry) {
  const h = getHistory();
  h.unshift({ ...entry, at: Date.now() });
  // keep last 200
  save(STORAGE_KEYS.history, h.slice(0, 200));
}

/** Create order → goes to pending for DJ */
function createOrder(track, bid, guestId) {
  const min = (getSettings().minBid != null) ? Number(getSettings().minBid) : 100;
  bid = Number(bid);
  if (!Number.isFinite(bid) || bid < min) {
    return { ok: false, error: 'Минимальная ставка ' + min + ' ₽' };
  }
  if (bid > 500000) {
    return { ok: false, error: 'Слишком большая сумма' };
  }
  if (isStopped(track.title, track.artist)) {
    return { ok: false, error: 'Этот трек в стоп-листе' };
  }
  const order = {
    id: 'ord_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7),
    trackId: track.id,
    title: track.title,
    artist: track.artist,
    cover: track.cover,
    duration: track.duration,
    preview: track.preview,
    bid,
    guestId: guestId || 'guest',
    status: 'pending', // pending | accepted | rejected | playing | done
    time: Date.now(),
    paid: true // after mock SBP
  };
  const pending = getPending();
  pending.unshift(order);
  setPending(pending);

  const stats = getStats();
  bumpStats({
    totalOrders: stats.totalOrders + 1,
    todayOrders: stats.todayOrders + 1,
    revenue: stats.revenue + bid,
    todayRevenue: stats.todayRevenue + bid
  });
  pushHistory({ type: 'order', orderId: order.id, title: order.title, bid });
  try { recordTrackOrder(track.title, track.artist, track.cover); } catch (e) {}
  try { pushGuestOrder(guestId || 'guest', { ...order }); } catch (e) {}

  return { ok: true, order };
}

function acceptOrder(orderId) {
  const pending = getPending();
  const idx = pending.findIndex(o => o.id === orderId);
  if (idx < 0) return null;
  const order = { ...pending[idx], status: 'accepted' };
  pending.splice(idx, 1);
  setPending(pending);

  const queue = getQueue();
  queue.push(order);
  setQueue(queue);

  const stats = getStats();
  bumpStats({ accepted: stats.accepted + 1 });
  pushHistory({ type: 'accepted', orderId, title: order.title, bid: order.bid });
  return order;
}

function rejectOrder(orderId, reason) {
  const pending = getPending();
  const idx = pending.findIndex(o => o.id === orderId);
  if (idx < 0) return null;
  const order = pending[idx];
  pending.splice(idx, 1);
  setPending(pending);

  const stats = getStats();
  bumpStats({ rejected: stats.rejected + 1 });
  pushHistory({ type: 'rejected', orderId, title: order.title, bid: order.bid, reason });
  return order;
}

/** Raise bid on existing queue item (by anyone) */
function raiseBid(orderId, extraAmount, guestId) {
  const queue = getQueue();
  const item = queue.find(o => o.id === orderId);
  if (!item) return { ok: false, error: 'Трек уже не в очереди' };
  item.bid += extraAmount;
  item.lastRaise = Date.now();
  item.lastRaiseBy = guestId;
  setQueue(queue);

  const stats = getStats();
  bumpStats({
    revenue: stats.revenue + extraAmount,
    todayRevenue: stats.todayRevenue + extraAmount
  });
  pushHistory({ type: 'raise', orderId, title: item.title, bid: item.bid, extra: extraAmount });
  return { ok: true, order: item };
}

function playNext() {
  const queue = getQueue();
  if (!queue.length) return null;
  const next = { ...queue[0], status: 'playing', playedAt: Date.now() };
  setQueue(queue.slice(1));
  setNowPlaying(next);
  pushHistory({ type: 'played', orderId: next.id, title: next.title, bid: next.bid });
  return next;
}

function removeFromQueue(orderId) {
  setQueue(getQueue().filter(o => o.id !== orderId));
}

// guest id (session)
function getGuestId() {
  let id = sessionStorage.getItem('bm_guest_id');
  if (!id) {
    id = 'g_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
    sessionStorage.setItem('bm_guest_id', id);
  }
  return id;
}

function esc(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function fmtDuration(sec) {
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

function fmtMoney(n) {
  return Number(n).toLocaleString('ru-RU') + ' ₽';
}

// ---------- smart memory: popular tracks ----------
function getTrackStats() {
  return load('bm_track_stats', {});
}

function recordTrackOrder(title, artist, cover) {
  const key = normalizeTrack(title, artist);
  const stats = getTrackStats();
  if (!stats[key]) {
    stats[key] = { title, artist, cover: cover || '', count: 0, lastAt: 0 };
  }
  stats[key].count += 1;
  stats[key].lastAt = Date.now();
  if (cover) stats[key].cover = cover;
  save('bm_track_stats', stats);
  return stats;
}

/** Top ordered tracks (all time or recent) */
function getTopTracks(limit = 15) {
  const stats = getTrackStats();
  return Object.values(stats)
    .sort((a, b) => b.count - a.count || b.lastAt - a.lastAt)
    .slice(0, limit);
}

/** Top today */
function getTopToday(limit = 10) {
  const start = new Date(); start.setHours(0,0,0,0);
  const stats = getTrackStats();
  return Object.values(stats)
    .filter(t => t.lastAt >= start.getTime())
    .sort((a, b) => b.count - a.count)
    .slice(0, limit);
}

// ---------- now playing ----------
function getNowPlaying() {
  return load(STORAGE_KEYS.nowPlaying, null);
}
function setNowPlaying(track) {
  save(STORAGE_KEYS.nowPlaying, track);
  return track;
}

// ---------- guest order history ----------
function getGuestOrders(guestId) {
  const all = load(STORAGE_KEYS.guestOrders, {});
  return all[guestId] || [];
}
function pushGuestOrder(guestId, order) {
  const all = load(STORAGE_KEYS.guestOrders, {});
  if (!all[guestId]) all[guestId] = [];
  all[guestId].unshift(order);
  all[guestId] = all[guestId].slice(0, 30);
  save(STORAGE_KEYS.guestOrders, all);
}

// ---------- ETA ----------
function estimateEtaMinutes(orderId) {
  const queue = getQueue();
  const settings = getSettings();
  const avg = settings.avgTrackSec || 210;
  const idx = queue.findIndex(o => o.id === orderId);
  if (idx < 0) {
    // maybe still pending
    const pending = getPending().find(o => o.id === orderId);
    if (pending) return Math.ceil((queue.length * avg) / 60) + 3;
    return null;
  }
  return Math.ceil((idx * avg) / 60);
}

function getOrderStatus(orderId, guestId) {
  const pending = getPending().find(o => o.id === orderId);
  if (pending) return { status: 'pending', label: 'Ожидает диджея', order: pending };
  const queue = getQueue();
  const qi = queue.findIndex(o => o.id === orderId);
  if (qi >= 0) {
    const eta = estimateEtaMinutes(orderId);
    return {
      status: 'queued',
      label: qi === 0 ? 'Следующий!' : 'В очереди #' + (qi + 1),
      position: qi + 1,
      eta,
      order: queue[qi]
    };
  }
  const np = getNowPlaying();
  if (np && np.id === orderId) return { status: 'playing', label: 'Сейчас играет!', order: np };
  const hist = getGuestOrders(guestId || '').find(o => o.id === orderId);
  if (hist) return { status: hist.status || 'done', label: 'Завершён', order: hist };
  return null;
}

// ---------- bad words ----------
function hasBadWords(title) {
  const s = String(title || '').toLowerCase();
  const words = getSettings().badWords || [];
  return words.some(w => s.includes(String(w).toLowerCase()));
}

// ---------- admin pin ----------
function checkAdminPin(pin) {
  return String(pin) === String(getSettings().adminPin || '1234');
}

// ---------- export shift ----------
function exportShiftCsv() {
  const stats = getStats();
  const hist = getHistory();
  const lines = ['time,type,title,bid'];
  hist.forEach(h => {
    lines.push([
      new Date(h.at).toISOString(),
      h.type,
      '"' + String(h.title || '').replace(/"/g, '""') + '"',
      h.bid != null ? h.bid : (h.extra || '')
    ].join(','));
  });
  lines.push('');
  lines.push('total_orders,' + stats.totalOrders);
  lines.push('accepted,' + stats.accepted);
  lines.push('rejected,' + stats.rejected);
  lines.push('revenue,' + stats.revenue);
  return lines.join('\n');
}

// ---------- sound / vibrate ----------
function notifySuccess() {
  try {
    if (navigator.vibrate) navigator.vibrate([40, 30, 40]);
  } catch (_) {}
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.connect(g); g.connect(ctx.destination);
    o.frequency.value = 880;
    g.gain.value = 0.04;
    o.start();
    setTimeout(() => { o.frequency.value = 1175; }, 80);
    setTimeout(() => { o.stop(); ctx.close(); }, 200);
  } catch (_) {}
}

function notifyTop() {
  try {
    if (navigator.vibrate) navigator.vibrate([60, 40, 60, 40, 100]);
  } catch (_) {}
}

// ---------- remote sync (Render / same origin) ----------
const REMOTE_STATE_URL = (function () {
  try {
    if (typeof location !== 'undefined' && location.hostname && location.hostname.includes('onrender.com')) {
      return location.origin + '/api/state';
    }
    if (typeof location !== 'undefined' && location.port === '8787') {
      return location.origin + '/api/state';
    }
  } catch (_) {}
  return '';
})();

let _remoteEnabled = !!REMOTE_STATE_URL;
let _syncing = false;
let _lastPull = 0;

async function pullRemoteState() {
  if (!_remoteEnabled || _syncing) return null;
  try {
    const res = await fetch(REMOTE_STATE_URL, { cache: 'no-store' });
    if (!res.ok) return null;
    const data = await res.json();
    _lastPull = Date.now();
    // apply to localStorage without re-broadcast storm
    if (data.queue) localStorage.setItem(STORAGE_KEYS.queue, JSON.stringify(data.queue));
    if (data.pending) localStorage.setItem(STORAGE_KEYS.pending, JSON.stringify(data.pending));
    if (data.stoplist) localStorage.setItem(STORAGE_KEYS.stoplist, JSON.stringify(data.stoplist));
    if (data.stats) localStorage.setItem(STORAGE_KEYS.stats, JSON.stringify(data.stats));
    if (data.settings) localStorage.setItem(STORAGE_KEYS.settings, JSON.stringify(data.settings));
    if (data.history) localStorage.setItem(STORAGE_KEYS.history, JSON.stringify(data.history));
    if (data.nowPlaying !== undefined) localStorage.setItem(STORAGE_KEYS.nowPlaying, JSON.stringify(data.nowPlaying));
    if (data.trackStats) localStorage.setItem('bm_track_stats', JSON.stringify(data.trackStats));
    listeners.forEach(fn => fn({ key: 'remote', value: data }));
    return data;
  } catch (e) {
    console.warn('pullRemote', e);
    return null;
  }
}

async function pushRemoteState() {
  if (!_remoteEnabled || _syncing) return;
  _syncing = true;
  try {
    const payload = {
      queue: getQueue(),
      pending: getPending(),
      stoplist: getStoplist(),
      stats: getStats(),
      settings: load(STORAGE_KEYS.settings, null),
      history: getHistory(),
      nowPlaying: getNowPlaying(),
      trackStats: load('bm_track_stats', {})
    };
    await fetch(REMOTE_STATE_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
  } catch (e) {
    console.warn('pushRemote', e);
  }
  _syncing = false;
}

// Override createOrder to also POST /api/order for reliability
const _createOrderOrig = typeof createOrder === 'function' ? createOrder : null;
if (_createOrderOrig) {
  createOrder = function (track, bid, guestId) {
    const res = _createOrderOrig(track, bid, guestId);
    if (res && res.ok) {
      pushRemoteState();
      // also dedicated endpoint
      if (_remoteEnabled) {
        const orderUrl = REMOTE_STATE_URL.replace(/\/api\/state$/, '/api/order');
        fetch(orderUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ order: res.order })
        }).catch(() => {});
      }
    }
    return res;
  };
}

// wrap mutators to push
['setQueue', 'setPending', 'setStoplist', 'setNowPlaying', 'setSettings'].forEach((name) => {
  if (typeof window !== 'undefined' && typeof eval(name) === 'function') {
    // skip - use explicit hooks below
  }
});

const _setQueue = setQueue;
setQueue = function (q) {
  const r = _setQueue(q);
  pushRemoteState();
  return r;
};
const _setPending = setPending;
setPending = function (p) {
  const r = _setPending(p);
  pushRemoteState();
  return r;
};
const _setStoplist = setStoplist;
setStoplist = function (l) {
  const r = _setStoplist(l);
  pushRemoteState();
  return r;
};
const _setNowPlaying = setNowPlaying;
setNowPlaying = function (t) {
  const r = _setNowPlaying(t);
  pushRemoteState();
  return r;
};
const _setSettings = setSettings;
setSettings = function (partial) {
  const r = _setSettings(partial);
  pushRemoteState();
  return r;
};
const _acceptOrder = acceptOrder;
acceptOrder = function (id) {
  const r = _acceptOrder(id);
  pushRemoteState();
  return r;
};
const _rejectOrder = rejectOrder;
rejectOrder = function (id, reason) {
  const r = _rejectOrder(id, reason);
  pushRemoteState();
  return r;
};
const _raiseBid = raiseBid;
raiseBid = function (orderId, extra, guestId) {
  const r = _raiseBid(orderId, extra, guestId);
  if (r && r.ok) pushRemoteState();
  return r;
};
const _playNext = playNext;
playNext = function () {
  const r = _playNext();
  pushRemoteState();
  return r;
};

// poll remote every 2s
if (_remoteEnabled && typeof setInterval !== 'undefined') {
  pullRemoteState();
  setInterval(pullRemoteState, 2000);
}

console.log('Bar Music shared.js remote:', _remoteEnabled ? REMOTE_STATE_URL : 'off');


// client keep-alive — tabs ping /health so Render stays awake
if (typeof location !== 'undefined' && location.hostname && location.hostname.indexOf('onrender.com') >= 0) {
  setInterval(function () {
    fetch(location.origin + '/health', { cache: 'no-store' }).catch(function () {});
  }, 8 * 60 * 1000);
}
