/* ═══════════════════════════════════════════════════════════════════════
   KSLIVE PLAYER CORE — v4
   State, M3U parsing, network, and the dual stream engine (HLS.js + Shaka).
   ═══════════════════════════════════════════════════════════════════════ */

/* ───────────────────────────────────────────────────────
   PLAYLIST CONFIG
   ─────────────────────────────────────────────────────── */
const PLAYLISTS_JSON_URL = "./playlists.json";
let PLAYLISTS = [];

/* ───────────────────────────────────────────────────────
   UNIVERSAL PROXY HELPER — MULTI-WORKER POOL (PING-SELECTED)
   ─────────────────────────────────────────────────────────
   WHY THIS EXISTS:
   A single Cloudflare Worker doesn't have a "CPU time" ceiling that adding
   accounts raises — every request already gets its own CPU-time budget
   regardless of how many other requests are in flight elsewhere. What DOES
   help under peak-hour buffering is spreading concurrent VIEWERS across
   more Cloudflare accounts, so no single account's subrequest/bandwidth
   headroom becomes the bottleneck for everyone at once.

   HOW WORKER SELECTION WORKS (v4 — ping-based, replaces hash-only pick):
   - On every page load, we fire a lightweight GET (no ?url= param, so
     worker.js answers instantly with its built-in health-check JSON —
     see worker.js's `if (!target) return jsonRes(...)` branch) at EVERY
     pool member IN PARALLEL, with a short timeout.
   - Whichever responds fastest is picked as this tab's worker for the
     session. A dead/slow/overloaded worker will naturally lose that race,
     so viewers organically drift away from a struggling account without
     any manual intervention.
   - This ping result is cached in sessionStorage so we don't re-ping on
     every single segment request — just once per fresh page load/reload,
     which is exactly the "per reload, suggest a worker" behavior wanted.
   - If ALL pings fail or take too long (e.g. offline, or first paint
     before network is ready), we fall back to the old deterministic
     session-hash pick so playback still has a sane default.
   - Mid-session, if the chosen worker starts failing requests, the
     existing health-cooldown + reportWorkerFailureAndGetFallback() logic
     (unchanged) takes over — ping-selection just picks the *starting*
     worker each reload; the failure-fallback logic handles the rest of
     the session if that pick turns out to be having a bad day.
   ─────────────────────────────────────────────────────── */
const WORKER_POOL = [
   "https://multiproxy.learndetailcoding.workers.dev/",
   "https://multiproxy.keyas-ntsc.workers.dev/",
   "https://multiproxy.marufhossainkeyas.workers.dev/",
];

const WORKER_PING_TIMEOUT_MS = 2500;   // don't let a dead worker hold up boot for long
const WORKER_UNHEALTHY_COOLDOWN_MS = 60_000; // stop routing new sessions to a failing worker for 1 min
const _workerHealth = new Map(); // origin -> { badUntil: timestamp }

function markWorkerUnhealthy(origin) {
  _workerHealth.set(origin, { badUntil: Date.now() + WORKER_UNHEALTHY_COOLDOWN_MS });
}
function isWorkerHealthy(origin) {
  const rec = _workerHealth.get(origin);
  return !rec || Date.now() > rec.badUntil;
}
function healthyPool() {
  const healthy = WORKER_POOL.filter(isWorkerHealthy);
  return healthy.length ? healthy : WORKER_POOL; // everything "unhealthy"? try anyway rather than dead-end
}

/** djb2 hash — same algorithm as worker.js's copy, so the routing math lines up. */
function hashStr(str) {
  let h = 5381;
  for (let i = 0; i < str.length; i++) h = ((h << 5) + h + str.charCodeAt(i)) >>> 0;
  return h;
}

/** One random id per browser tab, stable for the tab's lifetime. */
function getSessionId() {
  try {
    let sid = sessionStorage.getItem('ks_sid');
    if (!sid) {
      sid = (crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`);
      sessionStorage.setItem('ks_sid', sid);
    }
    return sid;
  } catch {
    return `${Date.now()}-${Math.random()}`; // sessionStorage unavailable (private mode etc.)
  }
}

/** Deterministic fallback pick — used only if pinging every worker failed. */
function pickSessionWorkerByHash() {
  const pool = healthyPool();
  if (pool.length <= 1) return pool[0];
  return pool[hashStr(getSessionId()) % pool.length];
}

/**
 * Ping every pool member's health-check endpoint in parallel and return
 * the origin that answered fastest. Resolves to null if every ping fails
 * or none answer within WORKER_PING_TIMEOUT_MS.
 */
async function raceWorkersForFastest(pool) {
  const attempts = pool.map(origin => new Promise(resolve => {
    const ctrl = new AbortController();
    const timer = setTimeout(() => { ctrl.abort(); resolve(null); }, WORKER_PING_TIMEOUT_MS);
    const started = performance.now();
    fetch(origin, { method: 'GET', signal: ctrl.signal, cache: 'no-store' })
      .then(res => {
        clearTimeout(timer);
        if (res.ok) resolve({ origin, ms: performance.now() - started });
        else resolve(null);
      })
      .catch(() => { clearTimeout(timer); resolve(null); });
  }));

  const results = (await Promise.all(attempts)).filter(Boolean);
  if (!results.length) return null;
  results.sort((a, b) => a.ms - b.ms);
  return results[0].origin;
}

/**
 * This tab's chosen worker for the whole session. Resolved once at boot
 * (see primePreferredWorker(), called from init()) and cached in
 * sessionStorage so a reload re-pings, but repeated calls within the same
 * load don't re-ping on every single manifest/segment request.
 */
let _preferredWorker = null;

async function primePreferredWorker() {
  try {
    const cached = sessionStorage.getItem('ks_worker');
    if (cached && WORKER_POOL.includes(cached)) {
      _preferredWorker = cached;
      return;
    }
  } catch {}

  const fastest = await raceWorkersForFastest(healthyPool());
  _preferredWorker = fastest || pickSessionWorkerByHash();

  try { sessionStorage.setItem('ks_worker', _preferredWorker); } catch {}
}

/** Pick this session's worker — ping-selected if primed, else deterministic fallback. */
function pickSessionWorker() {
  if (_preferredWorker && isWorkerHealthy(_preferredWorker)) return _preferredWorker;
  return pickSessionWorkerByHash();
}

/** Base64url-encode the pool so worker.js can spread nested manifest rewrites too. */
function encodedPool() {
  const json = JSON.stringify(WORKER_POOL);
  const b64 = btoa(unescape(encodeURIComponent(json)));
  return b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function buildProxyUrl(targetUrl, headers = {}, workerOrigin = null) {
  const origin = workerOrigin || pickSessionWorker();
  const p = new URLSearchParams();
  p.set('url', targetUrl);
  for (const [k, v] of Object.entries(headers)) {
    if (v) p.set('h_' + k.toLowerCase(), v);
  }
  if (WORKER_POOL.length > 1) {
    p.set('wp', encodedPool());
    p.set('sid', getSessionId());
  }
  return `${origin}?${p.toString()}`;
}

function resolveStreamUrl(ch) {
  const hdrs = ch.compiledHeaders || {};
  const isMixedContent = location.protocol === 'https:' && ch.url.startsWith('http://');
  const needsProxy = Object.keys(hdrs).length > 0 || isMixedContent;
  if (!needsProxy) return ch.url;
  return buildProxyUrl(ch.url, hdrs);
}

/**
 * Call after a proxied request clearly fails at the WORKER/edge level
 * (network error, or a Cloudflare-level 5xx/522/524/1015 — NOT a normal
 * upstream 4xx which just means the stream itself errored). Marks that
 * worker unhealthy so future sessions skip it during the cooldown, and
 * returns a retry URL for THIS request pointed at a different pool member,
 * or null if there's no other worker left to try.
 */
function reportWorkerFailureAndGetFallback(failedProxyUrl, targetUrl, headers = {}) {
  try {
    const failedOrigin = new URL(failedProxyUrl).origin;
    markWorkerUnhealthy(failedOrigin);
    if (_preferredWorker === failedOrigin) _preferredWorker = null; // stop preferring it this session
    const candidates = healthyPool().filter(o => o !== failedOrigin);
    if (!candidates.length) return null;
    const fallbackOrigin = candidates[hashStr(getSessionId() + ':retry') % candidates.length];
    return buildProxyUrl(targetUrl, headers, fallbackOrigin);
  } catch {
    return null;
  }
}

/** Cloudflare/edge-level failure codes worth failing over to another worker for. */
function isWorkerLevelFailureStatus(status) {
  return status === 502 || status === 503 || status === 522 || status === 524 || status === 1015;
}

/* ───────────────────────────────────────────────────────
   M3U PARSER
   ─────────────────────────────────────────────────────── */
function normalizeHeaders(current) {
  const h = {};
  if (current.userAgent) h['user-agent'] = current.userAgent;
  if (current.referrer) h['referer'] = current.referrer;
  if (current.cookies) h['cookie'] = current.cookies;
  Object.entries(current.headers || {}).forEach(([k, v]) => {
    h[k.toLowerCase()] = v;
  });
  return h;
}

function parseM3U(text) {
  const lines = text.split(/\r?\n/);
  const channels = [];
  let current = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    if (line.startsWith('#EXTM3U')) continue;

    if (line.startsWith('#EXTINF:')) {
      current = {
        name: '', group: 'General', logo: '', tvgId: '', url: '',
        cookies: '', userAgent: '', referrer: '', headers: {},
        drmType: '', drmKid: '', drmKey: '', rawExtinf: line
      };
      const afterDuration = line.replace(/^#EXTINF:\s*-?\d+(\.\d+)?/, '');
      const attrRx = /([\w-]+)="([^"]*)"/g;
      let m;
      while ((m = attrRx.exec(afterDuration)) !== null) {
        const k = m[1].toLowerCase(), v = m[2];
        if (k === 'group-title') current.group = v || 'General';
        else if (k === 'tvg-logo') current.logo = v;
        else if (k === 'tvg-id') current.tvgId = v;
        else if (k === 'tvg-name') current.name = v;
        else if (k === 'tvg-chno') current.chno = v;
        else if (k === 'user-agent') current.userAgent = v;
        else if (k === 'referrer') current.referrer = v;
        else if (k === 'cookie' || k === 'http-cookie') current.cookies = v;
      }
      const commaIdx = afterDuration.lastIndexOf(',');
      if (commaIdx !== -1) {
        const rawName = afterDuration.substring(commaIdx + 1).trim();
        if (rawName && !current.name) current.name = rawName;
      }
      if (!current.name) current.name = 'Unknown Channel';
      continue;
    }

    if (line.startsWith('#EXTVLCOPT:') && current) {
      const opt = line.replace('#EXTVLCOPT:', '').trim();
      if (opt.startsWith('http-user-agent=')) current.userAgent = opt.split('=').slice(1).join('=');
      else if (opt.startsWith('http-referrer=')) current.referrer = opt.split('=').slice(1).join('=');
      else if (opt.startsWith('http-cookie=')) current.cookies = opt.split('=').slice(1).join('=');
      continue;
    }

    if ((line.startsWith('#KODIPROP:') || line.startsWith('#EXTHTTP:')) && current) {
      const val = line.split(':').slice(1).join(':').trim();

      if (val.startsWith('{')) {
        try {
          const json = JSON.parse(val);
          Object.entries(json).forEach(([k, v]) => {
            if (!v) return;
            const lk = k.toLowerCase();
            if (lk === 'cookie') current.cookies = v;
            else if (lk === 'user-agent') current.userAgent = v;
            else if (lk === 'referrer' || lk === 'referer') current.referrer = v;
            else current.headers[lk] = v;
          });
        } catch (e) { /* malformed JSON, skip */ }
        continue;
      }

      if (val.startsWith('inputstream.adaptive.license_type=')) {
        current.drmType = val.split('=').slice(1).join('=').trim().toLowerCase();
        continue;
      }

      if (val.startsWith('inputstream.adaptive.license_key=')) {
        const raw = val.split('=').slice(1).join('=').trim();
        const colonIdx = raw.indexOf(':');
        if (colonIdx !== -1) {
          const kidRaw = raw.slice(0, colonIdx).replace(/[^0-9a-fA-F]/g, '');
          const keyRaw = raw.slice(colonIdx + 1).replace(/[^0-9a-fA-F]/g, '');
          if (kidRaw.length >= 30 && keyRaw.length >= 30) {
            current.drmKid = kidRaw.toLowerCase();
            current.drmKey = keyRaw.toLowerCase();
          } else {
            console.warn('[parseM3U] Unexpected ClearKey length, skipping DRM for:', current.name, raw);
          }
        }
        continue;
      }

      if (val.startsWith('inputstream.adaptive.stream_headers=')) {
        val.split('=').slice(1).join('=').split('&').forEach(pair => {
          const [hk, hv] = pair.split('=');
          if (hk && hv) current.headers[decodeURIComponent(hk)] = decodeURIComponent(hv);
        });
        continue;
      }

      if (val.startsWith('http-user-agent=')) {
        current.userAgent = val.split('=').slice(1).join('=');
        continue;
      }
    }

    if (current && !line.startsWith('#') && line.length > 0) {
      const pipeIdx = line.indexOf('|');
      if (pipeIdx !== -1) {
        current.url = line.slice(0, pipeIdx);
        const paramsStr = line.slice(pipeIdx + 1);
        paramsStr.split('|').forEach(pair => {
          const eqIdx = pair.indexOf('=');
          if (eqIdx === -1) return;
          const k = pair.slice(0, eqIdx).trim().toLowerCase();
          const v = pair.slice(eqIdx + 1).trim();
          if (!k || !v) return;
          if (k === 'referer' || k === 'referrer') current.referrer = v;
          else if (k === 'user-agent' || k === 'ua') current.userAgent = v;
          else if (k === 'cookie') current.cookies = v;
          else current.headers[k] = v;
        });
      } else {
        current.url = line;
      }

      current.compiledHeaders = normalizeHeaders(current);
      channels.push(current);
      current = null;
    }
  }
  return channels;
}


/* ───────────────────────────────────────────────────────
   APP STATE
   ─────────────────────────────────────────────────────── */
const state = {
  playlists: [],
  activePlaylist: 0,
  channels: [],
  filteredChannels: [],
  activeGroup: 'All',
  currentIdx: -1,

  hls: null,
  dash: null,
  shakaPolyfillDone: false,
  format: 'hls',

  isPlaying: false,
  isMuted: false,
  retryCount: 0,
  MAX_RETRY: 3,

  // ── Race-condition guard ──
  // Every playChannel()/loadStream() call gets a fresh number. Any async
  // callback (fetch, .play(), error handlers, timers) must compare its
  // captured token against state.loadToken before mutating UI/state.
  // If they don't match, the callback is stale and must no-op.
  loadToken: 0,

  ccAvailable: false,
  ccTracks: [],
  activeCcId: null,

  audioAvailable: false,
  audioTracks: [],
  activeAudioId: null,

  selectedLevel: -1
};

/** Bump and return a new load token. Call this exactly once per playChannel/loadStream. */
function nextLoadToken() {
  state.loadToken += 1;
  return state.loadToken;
}

/** True if `token` is still the current, non-stale load. */
function isCurrentToken(token) {
  return token === state.loadToken;
}


/* ───────────────────────────────────────────────────────
   DOM REFS
   ─────────────────────────────────────────────────────── */
const $ = id => document.getElementById(id);
const videoEl = $('videoEl');
const channelList = $('channelList');
const groupFilters = $('groupFilters');
const searchInput = $('searchInput');
const playlistTabs = $('playlistTabs');
const npName = $('npName');
const detailName = $('detailName');
const detailLogo = $('detailLogo');
const detailMeta = $('detailMeta');
const streamUrlText = $('streamUrlText');
const emptyState = $('emptyState');
const channelDetail = $('channelDetail');
const errorState = $('errorState');
const bigPlay = $('bigPlay');
const progressFill = $('progressFill');
const timeDisplay = $('timeDisplay');
const qualityBadge = $('qualityBadge');
const connDot = $('connDot');
const connStatus = $('connStatus');
const chCount = $('chCount');
const sidebar = $('sidebar');
const loadingScreen = $('loadingScreen');
const toastEl = $('toast');
const videoWrap = $('videoWrap');
const morePopup = $('morePopup');

/* ───────────────────────────────────────────────────────
   LANGUAGE CODE → FULL NAME
   ─────────────────────────────────────────────────────── */
const LANG_NAMES = {
  en: 'English', bn: 'Bangla', hi: 'Hindi', ur: 'Urdu', ar: 'Arabic',
  es: 'Spanish', fr: 'French', de: 'German', it: 'Italian', pt: 'Portuguese',
  ru: 'Russian', zh: 'Chinese', ja: 'Japanese', ko: 'Korean', tr: 'Turkish',
  fa: 'Persian', ta: 'Tamil', te: 'Telugu', ml: 'Malayalam', mr: 'Marathi',
  gu: 'Gujarati', pa: 'Punjabi', kn: 'Kannada', or: 'Odia', as: 'Assamese',
  ne: 'Nepali', si: 'Sinhala', th: 'Thai', vi: 'Vietnamese', id: 'Indonesian',
  ms: 'Malay', nl: 'Dutch', sv: 'Swedish', no: 'Norwegian', da: 'Danish',
  fi: 'Finnish', pl: 'Polish', el: 'Greek', he: 'Hebrew', uk: 'Ukrainian',
  ro: 'Romanian', hu: 'Hungarian', cs: 'Czech', sk: 'Slovak', bg: 'Bulgarian',
  sr: 'Serbian', hr: 'Croatian', sw: 'Swahili', am: 'Amharic', tl: 'Filipino',
  und: 'Undetermined'
};

function fullLangName(lang) {
  if (!lang) return '';
  const code = lang.split('-')[0].toLowerCase();
  return LANG_NAMES[code] || lang.toUpperCase();
}

/* ───────────────────────────────────────────────────────
   UTILS
   ─────────────────────────────────────────────────────── */
function escHtml(str) {
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
function escAttr(str) {
  return String(str).replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
function pad(n) { return String(n).padStart(2, '0'); }
function fmtTime(s) {
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = Math.floor(s % 60);
  return h > 0 ? `${h}:${pad(m)}:${pad(sec)}` : `${pad(m)}:${pad(sec)}`;
}

function saveLastChannel(plIdx, chIdx) {
  try { localStorage.setItem('sv_last', JSON.stringify({ plIdx, chIdx })); } catch {}
}
function loadLastChannel() {
  try { return JSON.parse(localStorage.getItem('sv_last')); } catch { return null; }
}

let toastTimer;
function showToast(msg, duration = 2500) {
  clearTimeout(toastTimer);
  toastEl.textContent = msg;
  toastEl.classList.add('show');
  toastTimer = setTimeout(() => toastEl.classList.remove('show'), duration);
}


/* ═══════════════════════════════════════════════════════
   PLAYER — CORE UTILITIES
   ═══════════════════════════════════════════════════════ */

/**
 * Cleanly tear down whatever engine is currently attached, detach all
 * one-off listeners we may have registered on videoEl for the previous
 * stream, and reset the <video> element to a blank slate.
 *
 * IMPORTANT: this is ASYNC and must be AWAITED before a new engine attaches.
 * Shaka Player's destroy() is asynchronous — it tears down MediaSource /
 * EME sessions on the video element in the background. If a new
 * shaka.Player().attach(videoEl) races against that in-flight destroy(),
 * the two instances fight over the same <video> element and the new load
 * can silently end up in a broken state (no error fires, nothing plays,
 * only a full page reload recovers). Awaiting destroy() here — and having
 * every caller await teardownPlayer() — closes that window entirely.
 */
async function teardownPlayer() {
  // Remove any per-load listeners we tagged for cleanup (see addManagedListener)
  if (videoEl.__kslive_cleanup) {
    videoEl.__kslive_cleanup.forEach(fn => { try { fn(); } catch {} });
  }
  videoEl.__kslive_cleanup = [];

  const oldHls = state.hls;
  const oldDash = state.dash;
  state.hls = null;
  state.dash = null;
  state.format = 'hls';

  if (oldHls) {
    try { oldHls.destroy(); } catch {}
  }
  if (oldDash) {
    try { await oldDash.destroy(); } catch {}
  }

  try {
    videoEl.pause();
    videoEl.removeAttribute('src');
    // Also clear any srcObject in case a future engine used MSE via that path
    videoEl.srcObject = null;
    videoEl.load();
  } catch {}
}

/** Register a listener that gets auto-removed on the next teardownPlayer() call. */
function addManagedListener(target, event, handler, opts) {
  target.addEventListener(event, handler, opts);
  if (!videoEl.__kslive_cleanup) videoEl.__kslive_cleanup = [];
  videoEl.__kslive_cleanup.push(() => target.removeEventListener(event, handler, opts));
}

/**
 * Detect stream format from the raw channel URL.
 * Falls back to 'hls' (overwhelmingly most common for IPTV).
 */
function detectFormat(url) {
  const u = (url || '').split('?')[0].split('#')[0].toLowerCase();
  if (u.endsWith('.mpd')) return 'dash';
  if (u.endsWith('.m3u8') || u.endsWith('.m3u')) return 'hls';
  if (/\.(mp4|m4v|mov|m4s|cmaf)$/.test(u)) return 'mp4';
  if (/\.webm$/.test(u)) return 'webm';
  if (/\.(mp3|aac|ogg|flac|wav)$/.test(u)) return 'audio';
  if (/\.(ts|mts|m2ts)$/.test(u)) return 'ts';
  if (u.includes('.mpd') || u.includes('/mpd/')) return 'dash';
  if (u.includes('.m3u') || u.includes('/hls/') || u.includes('chunklist')) return 'hls';
  return 'hls';
}

/** fetch() with per-request AbortController timeout */
async function fetchWithTimeout(url, options = {}, ms = 15_000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    const res = await fetch(url, { ...options, signal: ctrl.signal });
    clearTimeout(timer);
    return res;
  } catch (e) {
    clearTimeout(timer);
    if (e.name === 'AbortError') throw new Error(`Timed out after ${ms / 1000}s: ${url}`);
    throw e;
  }
}

/** Load Shaka Player on-demand (it's already in <head>, but this covers retries/CDN hiccups). */
function ensureShaka() {
  if (typeof shaka !== 'undefined' && shaka.Player) return Promise.resolve(true);
  return new Promise(resolve => {
    const s = document.createElement('script');
    s.src = 'https://cdnjs.cloudflare.com/ajax/libs/shaka-player/4.16.3/shaka-player.compiled.min.js';
    s.onload = () => resolve(true);
    s.onerror = () => resolve(false);
    document.head.appendChild(s);
  });
}

function setLoadingMsg(msg) {
  const el = document.querySelector('#loadingScreen .loading-text')
    || document.querySelector('#loadingScreen p')
    || document.querySelector('#loadingScreen span')
    || $('loadText');
  if (el) el.textContent = msg;
}


/* ═══════════════════════════════════════════════════════
   NETWORK — FETCH M3U
   ═══════════════════════════════════════════════════════ */
async function fetchM3U(pl) {
  const { url, fetchHeaders } = pl;
  if (!url.startsWith('http') && !url.startsWith('//')) return url;

  try {
    const res = await fetchWithTimeout(url, { headers: fetchHeaders || {}, cache: 'no-cache' }, 12_000);
    if (res.ok) return await res.text();
  } catch (e) {
    if (e.message.startsWith('Timed out')) throw e;
    console.warn('[fetchM3U] Direct failed, trying CORS proxies…', e.message);
  }

  // CORS proxy fallbacks — tried in order, first success wins.
  const proxies = [
    `https://api.allorigins.win/raw?url=${encodeURIComponent(url)}`,
    `https://corsproxy.io/?url=${encodeURIComponent(url)}`,
    `https://api.codetabs.com/v1/proxy?quest=${encodeURIComponent(url)}`,
  ];
  let lastErr = null;
  for (const proxy of proxies) {
    try {
      const res = await fetchWithTimeout(proxy, {}, 10_000);
      if (res.ok) {
        const text = await res.text();
        if (text && text.length > 0) return text;
      }
    } catch (e) { lastErr = e; }
  }

  throw new Error(lastErr ? `All fetch attempts failed: ${lastErr.message}` : 'All fetch attempts failed');
}


/* ═══════════════════════════════════════════════════════
   INIT — BOOT
   ═══════════════════════════════════════════════════════ */
async function init() {
  setLoadingMsg('Loading channel config…');

  // Ping every worker in the pool now, in parallel with the playlist
  // fetch below (not awaited sequentially before it) so pinging never
  // adds to perceived boot time — by the time the user picks a channel,
  // this has almost always already resolved.
  const workerPingPromise = primePreferredWorker();

  try {
    const res = await fetchWithTimeout(PLAYLISTS_JSON_URL + '?t=' + Date.now(), {}, 10_000);
    PLAYLISTS = await res.json();
  } catch (e) {
    console.error('[init] Failed to load playlists config:', e);
    PLAYLISTS = [];
  }

  const total = PLAYLISTS.length;
  let done = 0;
  setLoadingMsg(`Loading ${total} playlist${total !== 1 ? 's' : ''}…`);

  const results = await Promise.allSettled(
    PLAYLISTS.map(async (pl) => {
      try {
        const text = await fetchM3U(pl);
        const channels = parseM3U(text);
        setLoadingMsg(`Loaded ${++done}/${total}…`);
        return { name: pl.name, image: pl.image || '', channels };
      } catch (e) {
        setLoadingMsg(`Loaded ${++done}/${total}…`);
        throw e;
      }
    })
  );

  results.forEach((r, i) => {
    const pl = PLAYLISTS[i];
    if (r.status === 'fulfilled') {
      state.playlists.push(r.value);
    } else {
      console.error(`[init] Playlist "${pl.name}" failed:`, r.reason?.message);
      state.playlists.push({ name: pl.name, image: pl.image || '', channels: [], error: r.reason?.message });
    }
  });

  if (state.playlists.length === 0) {
    setLoadingMsg('No playlists could be loaded.');
    showToast('Failed to load any playlist. Check your connection.', 5000);
  }

  buildPlaylistTabs();
  if (state.playlists.length > 0) switchPlaylist(0);

  // Make sure the worker ping has resolved before the very first channel
  // load actually needs to pick a worker (playChannel below fires
  // loadStream synchronously). Usually already done by now.
  await workerPingPromise;

  const last = loadLastChannel();
  if (last && state.playlists[last.plIdx]?.channels[last.chIdx]) {
    switchPlaylist(last.plIdx);
    setTimeout(() => {
      playChannel(last.chIdx);
    }, 500);
  }

  checkMobile();
  setTimeout(() => {
    loadingScreen.classList.add('hidden');
    window.dispatchEvent(new Event('resize'));
  }, 600);
  setTimeout(checkSharedUrl, 800);
}

function setRealVH() {
  document.documentElement.style.setProperty('--real-vh', `${window.innerHeight}px`);
}
setRealVH();
window.addEventListener('resize', setRealVH);
window.addEventListener('orientationchange', () => setTimeout(setRealVH, 100));

/* ═══════════════════════════════════════════════════════
   PLAYLIST TABS
   ═══════════════════════════════════════════════════════ */
const plScrollLeft = $('plScrollLeft');
const plScrollRight = $('plScrollRight');

function updatePlScrollButtons() {
  const el = playlistTabs;
  const maxScroll = el.scrollWidth - el.clientWidth;
  const needsScroll = maxScroll > 4;
  plScrollLeft.style.display = needsScroll ? 'flex' : 'none';
  plScrollRight.style.display = needsScroll ? 'flex' : 'none';
  plScrollLeft.disabled = el.scrollLeft <= 4;
  plScrollRight.disabled = el.scrollLeft >= maxScroll - 4;
}
plScrollLeft.addEventListener('click', () => playlistTabs.scrollBy({ left: -160, behavior: 'smooth' }));
plScrollRight.addEventListener('click', () => playlistTabs.scrollBy({ left: 160, behavior: 'smooth' }));
playlistTabs.addEventListener('scroll', updatePlScrollButtons);
window.addEventListener('resize', updatePlScrollButtons);

function buildPlaylistTabs() {
  playlistTabs.innerHTML = '';
  state.playlists.forEach((pl, idx) => {
    const tab = document.createElement('button');
    tab.className = 'pl-tab' + (idx === 0 ? ' active' : '');
    const imgHtml = pl.image
      ? `<img class="pl-tab-img" src="${escAttr(pl.image)}" alt="" onerror="this.style.display='none'">`
      : `<div class="pl-tab-img pl-tab-img-fallback">${escHtml(pl.name.substring(0, 2).toUpperCase())}</div>`;
    tab.innerHTML = `
      ${imgHtml}
      <span class="pl-tab-name">${escHtml(pl.name)}</span>
      <span class="pl-count">${pl.channels.length}</span>
    `;
    tab.addEventListener('click', () => switchPlaylist(idx));
    playlistTabs.appendChild(tab);
  });
  setTimeout(updatePlScrollButtons, 50);
}

function switchPlaylist(idx) {
  if (!state.playlists[idx]) return;

  // Switching playlists invalidates any in-flight load immediately —
  // bump the token even before we decide whether to play anything new.
  nextLoadToken();

  state.activePlaylist = idx;
  state.channels = state.playlists[idx]?.channels || [];
  state.currentIdx = -1;
  document.querySelectorAll('.pl-tab').forEach((t, i) => t.classList.toggle('active', i === idx));

  const activeTab = playlistTabs.querySelectorAll('.pl-tab')[idx];
  if (activeTab) activeTab.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'center' });

  state.activeGroup = 'All';
  buildGroupFilters();
  applyFilter();
  updateChCount();
}


/* ═══════════════════════════════════════════════════════
   SIDEBAR — GROUP FILTERS + CHANNEL LIST
   ═══════════════════════════════════════════════════════ */
function buildGroupFilters() {
  const groups = ['All', ...new Set(state.channels.map(c => c.group))].sort((a, b) => {
    if (a === 'All') return -1;
    if (b === 'All') return 1;
    return a.localeCompare(b);
  });
  groupFilters.innerHTML = '';
  groups.forEach(g => {
    const chip = document.createElement('div');
    chip.className = 'g-chip' + (g === state.activeGroup ? ' active' : '');
    chip.textContent = g;
    chip.addEventListener('click', () => {
      state.activeGroup = g;
      document.querySelectorAll('.g-chip').forEach(c => c.classList.remove('active'));
      chip.classList.add('active');
      applyFilter();
    });
    groupFilters.appendChild(chip);
  });
}

function applyFilter() {
  const q = searchInput.value.toLowerCase().trim();
  state.filteredChannels = state.channels.filter(ch => {
    const groupMatch = state.activeGroup === 'All' || ch.group === state.activeGroup;
    const nameMatch = !q || ch.name.toLowerCase().includes(q) || (ch.group || '').toLowerCase().includes(q);
    return groupMatch && nameMatch;
  });
  renderChannelList();
}

function renderChannelList() {
  channelList.innerHTML = '';
  const grouped = {};
  state.filteredChannels.forEach(ch => {
    if (!grouped[ch.group]) grouped[ch.group] = [];
    grouped[ch.group].push(ch);
  });

  if (Object.keys(grouped).length === 0) {
    channelList.innerHTML = `<div class="empty-state"><div class="empty-icon">🔍</div><div class="empty-title">No channels found</div></div>`;
    return;
  }

  Object.entries(grouped).sort(([a], [b]) => a.localeCompare(b)).forEach(([group, chs]) => {
    if (state.activeGroup === 'All') {
      const label = document.createElement('div');
      label.className = 'ch-group-label';
      label.textContent = group;
      channelList.appendChild(label);
    }
    chs.forEach(ch => {
      const globalIdx = state.channels.indexOf(ch);
      const item = document.createElement('div');
      item.className = 'ch-item' + (globalIdx === state.currentIdx ? ' active' : '');
      item.dataset.idx = globalIdx;
      const logoHtml = ch.logo
        ? `<div class="ch-logo"><img src="${escAttr(ch.logo)}" alt="" onerror="this.parentNode.textContent='${escHtml(ch.name.substring(0, 3))}'"></div>`
        : `<div class="ch-logo">${escHtml(ch.name.substring(0, 3))}</div>`;
      const eqHtml = globalIdx === state.currentIdx
        ? `<div class="eq-bars"><div class="eq-bar"></div><div class="eq-bar"></div><div class="eq-bar"></div></div>`
        : '';
      item.innerHTML = `
        ${logoHtml}
        <div class="ch-info">
          <div class="ch-name">${escHtml(ch.name)}</div>
          <div class="ch-meta">${escHtml(ch.group)}</div>
        </div>
        ${eqHtml}
      `;
      item.addEventListener('click', () => playChannel(globalIdx));
      channelList.appendChild(item);
    });
  });
}

function updateChCount() {
  chCount.textContent = `${state.channels.length} channels`;
}
searchInput.addEventListener('input', () => applyFilter());


/* ═══════════════════════════════════════════════════════
   PLAYER — CHANNEL SELECTION + INFO PANEL
   ═══════════════════════════════════════════════════════ */
function playChannel(idx) {
  const ch = state.channels[idx];
  if (!ch) return;

  saveLastChannel(state.activePlaylist, idx);
  state.currentIdx = idx;
  errorState.classList.remove('show');
  renderChannelList();

  if (window.innerWidth <= 768) sidebar.classList.remove('mobile-open');

  emptyState.style.display = 'none';
  channelDetail.style.display = 'block';
  npName.textContent = ch.name;
  detailName.textContent = ch.name;

  const npLogo = $('npLogo');
  if (ch.logo) { npLogo.src = ch.logo; npLogo.classList.add('show'); }
  else { npLogo.src = ''; npLogo.classList.remove('show'); }

  detailLogo.innerHTML = ch.logo
    ? `<img src="${escAttr(ch.logo)}" alt="" onerror="this.parentNode.textContent='${escHtml(ch.name.substring(0, 3))}'"><span style="display:none">${escHtml(ch.name.substring(0, 3))}</span>`
    : escHtml(ch.name.substring(0, 3));

  detailMeta.innerHTML = [
    ch.group && `<span class="meta-tag">${escHtml(ch.group)}</span>`,
    ch.tvgId && `<span class="meta-tag blue">${escHtml(ch.tvgId)}</span>`,
    Object.keys(ch.compiledHeaders || {}).length && `<span class="meta-tag">🔐 Headers</span>`,
  ].filter(Boolean).join('');

  // Fire-and-forget: loadStream is async (it awaits teardown before
  // attaching the next engine), but playChannel itself stays sync so the
  // UI (channel list highlight, detail panel) updates immediately. The
  // loadToken guard inside loadStream/loadHls/loadDash makes it safe to
  // not await here even if the user rapidly taps through channels.
  loadStream(ch);
}


/* ═══════════════════════════════════════════════════════
   PLAYER — STREAM LOADING
   Dispatcher → loadHls / loadDash / loadDirectVideo
   Every call here mints a fresh load token; that token must be threaded
   through to every async callback spawned for this channel.
   ═══════════════════════════════════════════════════════ */
const FORMAT_BADGE = { dash: 'DASH', mp4: 'MP4', webm: 'WEBM', audio: 'AUDIO', ts: 'TS' };

async function loadStream(ch, forceProxy = false) {
  const token = nextLoadToken();

  setStatus('Connecting…', 'yellow');
  errorState.classList.remove('show');
  $('bufferSpinner').style.display = 'none';
  state.retryCount = 0;
  state.selectedLevel = -1;

  if (typeof closeMoreSubPanel === 'function') closeMoreSubPanel();
  // CC/audio track identities (hls-0, shaka-1, …) are positional, so they
  // can collide across channels. Clearing here is necessary but not
  // sufficient — see collectCcTracks()/collectAudioTracks() in control.js
  // for the id-collision guard that actually prevents stale re-selection.
  state.ccTracks = [];
  state.activeCcId = null;
  if (typeof refreshCcButtons === 'function') refreshCcButtons();

  state.audioTracks = [];
  state.activeAudioId = null;
  if (typeof refreshAudioButtons === 'function') refreshAudioButtons();

  // Await teardown BEFORE building the new engine — see teardownPlayer()
  // doc comment. Without this await, a DASH→DASH switch can silently fail
  // because the old Shaka instance's async destroy() races the new one's
  // attach() on the same <video> element.
  await teardownPlayer();
  if (!isCurrentToken(token)) return; // superseded while tearing down

  const hdrs = ch.compiledHeaders || {};
  const hasHdrs = Object.keys(hdrs).length > 0;
  const mixedHttp = location.protocol === 'https:' && ch.url.startsWith('http://');
  const useProxy = forceProxy || hasHdrs || mixedHttp;
  const url = useProxy ? buildProxyUrl(ch.url, hdrs) : ch.url;
  const fmt = detectFormat(ch.url);

  state.format = fmt;
  qualityBadge.textContent = FORMAT_BADGE[fmt] || 'HLS';

  if (fmt === 'dash') loadDash(ch, url, hdrs, useProxy, token);
  else if (fmt === 'mp4' || fmt === 'webm' || fmt === 'audio') loadDirectVideo(ch, url, hdrs, useProxy, fmt, token);
  else loadHls(ch, url, hdrs, useProxy, token);
}


/* ── HLS (HLS.js + Safari native fallback) ─────────────────────────── */
function loadHls(ch, url, hdrs, usingProxy, token) {
  let fallbackTried = usingProxy;

  if (Hls.isSupported()) {
    const hls = new Hls({
      xhrSetup: xhr => {
        if (hdrs['user-agent']) xhr.setRequestHeader('User-Agent', hdrs['user-agent']);
      },
      enableWorker: true,
      lowLatencyMode: true,
      backBufferLength: 30,
      manifestLoadingMaxRetry: usingProxy ? 3 : 1,
      manifestLoadingRetryDelay: 1000,
      manifestLoadingMaxRetryTimeout: 8000,
      levelLoadingMaxRetry: usingProxy ? 3 : 1,
      levelLoadingRetryDelay: 1000,
      fragLoadingMaxRetry: usingProxy ? 3 : 1,
      fragLoadingRetryDelay: 500,
    });

    // Only take ownership of shared state if we're still the active load.
    if (!isCurrentToken(token)) { hls.destroy(); return; }
    state.hls = hls;

    hls.loadSource(url);
    hls.attachMedia(videoEl);

    hls.on(Hls.Events.MANIFEST_PARSED, (_, data) => {
      if (!isCurrentToken(token)) return;
      qualityBadge.textContent = data.levels?.length > 1 ? `HLS · ${data.levels.length}Q` : 'HLS';
      if (typeof collectAudioTracks === 'function') collectAudioTracks();

      videoEl.play()
        .then(() => { if (!isCurrentToken(token)) return; state.isPlaying = true; updatePlayPauseIcon(); setStatus('Playing', 'green'); })
        .catch(() => { if (!isCurrentToken(token)) return; state.isPlaying = false; updatePlayPauseIcon(); setStatus('Tap to play', 'yellow'); });
    });

    hls.on(Hls.Events.LEVEL_SWITCHED, (_, data) => {
      if (!isCurrentToken(token)) return;
      const lv = hls.levels[data.level];
      if (lv?.height) {
        const t = hls.autoLevelEnabled ? `AUTO · ${lv.height}p` : `${lv.height}p`;
        qualityBadge.textContent = t;
        const cur = $('moreQualCurrent'); if (cur) cur.textContent = t;
      }
      document.dispatchEvent(new Event('hlsLevelUpdate'));
    });

    hls.on(Hls.Events.FRAG_LOADED, () => {
      if (!isCurrentToken(token)) return;
      $('bufferSpinner').style.display = 'none';
    });

    hls.on(Hls.Events.SUBTITLE_TRACKS_UPDATED, () => { if (isCurrentToken(token)) document.dispatchEvent(new Event('hlsSubtitleTracksUpdate')); });
    hls.on(Hls.Events.SUBTITLE_TRACK_SWITCH, () => { if (isCurrentToken(token)) document.dispatchEvent(new Event('hlsSubtitleTrackSwitch')); });
    hls.on(Hls.Events.AUDIO_TRACKS_UPDATED, () => { if (isCurrentToken(token)) document.dispatchEvent(new Event('hlsAudioTracksUpdate')); });
    hls.on(Hls.Events.AUDIO_TRACK_SWITCHED, () => { if (isCurrentToken(token)) document.dispatchEvent(new Event('hlsAudioTrackSwitch')); });

    hls.on(Hls.Events.ERROR, (_, data) => {
      if (!isCurrentToken(token)) return; // stale engine instance, ignore entirely

      const httpCode = data.response?.code;
      const isBlocked = httpCode === 403 || httpCode === 503 || httpCode === 0;

      if (!fallbackTried && (isBlocked || data.fatal)) {
        fallbackTried = true;
        setStatus('Blocked — retrying via proxy…', 'yellow');
        hls.destroy();
        if (state.hls === hls) state.hls = null;
        setTimeout(() => { if (isCurrentToken(token)) loadHls(ch, buildProxyUrl(ch.url, hdrs), hdrs, true, token); }, 300);
        return;
      }

      // Already on a proxy (multi-worker pool in play) and hitting a
      // worker/edge-level failure (not a normal upstream stream error) —
      // fail this session over to a different worker in the pool instead
      // of endlessly retrying the same one.
      if (usingProxy && WORKER_POOL.length > 1 && data.fatal && isWorkerLevelFailureStatus(httpCode)) {
        const fallbackUrl = reportWorkerFailureAndGetFallback(url, ch.url, hdrs);
        if (fallbackUrl) {
          setStatus('Switching server…', 'yellow');
          hls.destroy();
          if (state.hls === hls) state.hls = null;
          setTimeout(() => { if (isCurrentToken(token)) loadHls(ch, fallbackUrl, hdrs, true, token); }, 300);
          return;
        }
      }

      if (!data.fatal) return;

      if (data.type === Hls.ErrorTypes.NETWORK_ERROR) {
        if (state.retryCount < state.MAX_RETRY) {
          state.retryCount++;
          setStatus(`Reconnecting (${state.retryCount}/${state.MAX_RETRY})…`, 'yellow');
          setTimeout(() => { if (isCurrentToken(token)) hls.startLoad(); }, 2000 * state.retryCount);
        } else {
          showError('Stream unreachable. Offline or geo-blocked.');
        }
      } else if (data.type === Hls.ErrorTypes.MEDIA_ERROR) {
        if (state.retryCount < 2) {
          state.retryCount++;
          hls.recoverMediaError();
        } else {
          showError('Media decode error. Try reloading.');
        }
      } else {
        showError('Unsupported stream or DRM-protected content.');
      }
    });

  } else if (videoEl.canPlayType('application/vnd.apple.mpegurl')) {
    // Safari / iOS — native HLS
    if (!isCurrentToken(token)) return;
    videoEl.src = url;
    setStatus('Connecting…', 'yellow');
    videoEl.play().catch(() => {});

    addManagedListener(videoEl, 'loadedmetadata', () => {
      if (!isCurrentToken(token)) return;
      if (typeof collectCcTracks === 'function') collectCcTracks();
    }, { once: true });

    addManagedListener(videoEl, 'error', () => {
      if (!isCurrentToken(token)) return;
      if (!fallbackTried) {
        fallbackTried = true;
        videoEl.src = buildProxyUrl(ch.url, hdrs);
        videoEl.play().catch(() => {});
      } else {
        showError('Native HLS failed to load this stream.');
      }
    }, { once: true });

  } else {
    showError('HLS playback is not supported in this browser.');
  }
}

const DRM_LABELS = { widevine: 'Widevine', playready: 'PlayReady', fairplay: 'FairPlay', cenc: 'CENC/DRM' };

/**
 * Peek the manifest through the proxy to read X-KSLIVE-DRM before
 * committing to a full Shaka load. Never blocks playback on failure —
 * worst case we just don't get the early warning.
 */
async function peekDrmHeader(mpdUrl) {
  try {
    const res = await fetchWithTimeout(mpdUrl, { method: 'GET' }, 8_000);
    return res.headers.get('X-KSLIVE-DRM');
  } catch {
    return null;
  }
}

/* ── DASH/MPD (Shaka Player) ────────────────────────────────────────── */
async function loadDash(ch, url, hdrs, usingProxy, token) {
  qualityBadge.textContent = 'DASH';
  setStatus('Loading DASH player…', 'yellow');

  const hasClearKey = ch.drmType === 'clearkey' && ch.drmKid && ch.drmKey;

  if (usingProxy && !hasClearKey) {
    const drm = await peekDrmHeader(url);
    if (!isCurrentToken(token)) return; // channel changed while we were peeking
    if (drm) {
      const names = drm.split(',').map(s => DRM_LABELS[s] || s).join(' / ');
      showError(`এই চ্যানেলটি ${names} DRM দ্বারা সুরক্ষিত — এই প্লেয়ারে চালানো সম্ভব নয়।`);
      setStatus('DRM protected', 'red');
      return;
    }
  }

  const loaded = await ensureShaka();
  if (!isCurrentToken(token)) return;
  if (!loaded) {
    showError('Failed to load DASH library (Shaka Player). Check your connection.');
    return;
  }

  if (!state.shakaPolyfillDone) {
    shaka.polyfill.installAll();
    state.shakaPolyfillDone = true;
  }

  if (!shaka.Player.isBrowserSupported()) {
    showError('এই ব্রাউজার DASH প্লেব্যাক সাপোর্ট করে না।');
    return;
  }

  const player = new shaka.Player();

  // Attach happens async — re-check token right after, before publishing
  // this instance into shared state.
  try {
    await player.attach(videoEl);
  } catch (e) {
    player.destroy();
    if (isCurrentToken(token)) showError('DASH player attach failed.');
    return;
  }
  if (!isCurrentToken(token)) { player.destroy(); return; }

  state.dash = player;

  player.configure({
    streaming: {
      lowLatencyMode: true,
      bufferingGoal: 20,
      rebufferingGoal: 2,
      retryParameters: { maxAttempts: 4, baseDelay: 1000, backoffFactor: 2 },
    },
  });

  const netEngine = player.getNetworkingEngine();
  netEngine.registerRequestFilter((type, request) => {
    request.uris = request.uris.map(u => {
      // Already wrapped by worker.js's own manifest rewriting (possibly
      // pointing at a DIFFERENT pool member than this tab's own pick) —
      // leave it alone rather than double-wrapping it.
      if (WORKER_POOL.some(origin => u.indexOf(origin) === 0)) return u;
      if (u.startsWith('blob:') || u.startsWith('data:')) return u;
      return buildProxyUrl(u, hdrs);
    });
  });

  if (hasClearKey) {
    player.configure({ drm: { clearKeys: { [ch.drmKid]: ch.drmKey } } });
  } else {
    player.configure({ drm: { clearKeys: {} } });
  }

  player.addEventListener('error', (event) => {
    if (!isCurrentToken(token)) return;
    onShakaError(event.detail, ch, url, hdrs, usingProxy, hasClearKey, token);
  });

  player.addEventListener('adaptation', () => { if (isCurrentToken(token)) updateQualBadge(); });
  player.addEventListener('variantchanged', () => { if (isCurrentToken(token)) updateQualBadge(); });

  player.addEventListener('trackschanged', () => {
    if (!isCurrentToken(token)) return;
    if (typeof collectAudioTracks === 'function') collectAudioTracks();
    if (typeof collectCcTracks === 'function') collectCcTracks();
  });

  player.addEventListener('buffering', (e) => {
    if (!isCurrentToken(token)) return;
    $('bufferSpinner').style.display = e.buffering ? 'block' : 'none';
  });

  try {
    await player.load(url);
  } catch (err) {
    if (!isCurrentToken(token)) { player.destroy(); return; }
    onShakaError(err, ch, url, hdrs, usingProxy, hasClearKey, token);
    return;
  }

  if (!isCurrentToken(token)) { player.destroy(); return; }

  setStatus('Playing', 'green');
  updateQualBadge();
  if (typeof collectAudioTracks === 'function') collectAudioTracks();
  if (typeof collectCcTracks === 'function') collectCcTracks();

  videoEl.play()
    .then(() => { if (!isCurrentToken(token)) return; state.isPlaying = true; updatePlayPauseIcon(); })
    .catch(() => { if (!isCurrentToken(token)) return; state.isPlaying = false; updatePlayPauseIcon(); setStatus('Tap to play', 'yellow'); });
}

function onShakaError(err, ch, url, hdrs, usingProxy, hasClearKey, token) {
  if (!isCurrentToken(token)) return; // fully stale — do nothing, don't even log-spam
  console.error('[Shaka] Error:', err);
  const code = err?.code ?? 0;

  const isDrmCode = code >= 6000 && code < 7000;
  if (!hasClearKey && isDrmCode) {
    if (state.dash) { try { state.dash.destroy(); } catch {} state.dash = null; }
    showError('এই স্ট্রিমটি DRM দ্বারা সুরক্ষিত — এই প্লেয়ারে চালানো সম্ভব নয়।');
    setStatus('DRM protected', 'red');
    return;
  }

  if (hasClearKey && isDrmCode) {
    if (state.retryCount === 0) {
      state.retryCount++;
      console.warn('[Shaka] ClearKey configured but DRM error persisted — retrying once.');
      setTimeout(() => { if (isCurrentToken(token) && state.dash) state.dash.load(url).catch(() => {}); }, 500);
      return;
    }
    if (state.dash) { try { state.dash.destroy(); } catch {} state.dash = null; }
    showError('এই চ্যানেলের ClearKey চাবি ম্যাচ করছে না — সোর্সের KID/KEY পরিবর্তিত হয়ে থাকতে পারে।');
    setStatus('Key mismatch', 'red');
    return;
  }

  const isNetCode = code >= 1000 && code < 2000;
  if (!usingProxy && isNetCode) {
    if (state.dash) { try { state.dash.destroy(); } catch {} state.dash = null; }
    setStatus('DASH blocked — retrying via proxy…', 'yellow');
    setTimeout(() => { if (isCurrentToken(token)) loadDash(ch, buildProxyUrl(ch.url, hdrs), hdrs, true, token); }, 400);
    return;
  }

  // Already on a proxy — check whether this was a worker/edge-level failure
  // (Shaka's HTTP_ERROR code 1001 carries the response status as data[1])
  // rather than a normal upstream stream error, and fail over within the pool.
  if (usingProxy && WORKER_POOL.length > 1 && isNetCode) {
    const httpStatus = Array.isArray(err?.data) ? err.data[1] : undefined;
    if (isWorkerLevelFailureStatus(httpStatus)) {
      const fallbackUrl = reportWorkerFailureAndGetFallback(url, ch.url, hdrs);
      if (fallbackUrl) {
        if (state.dash) { try { state.dash.destroy(); } catch {} state.dash = null; }
        setStatus('Switching server…', 'yellow');
        setTimeout(() => { if (isCurrentToken(token)) loadDash(ch, fallbackUrl, hdrs, true, token); }, 400);
        return;
      }
    }
  }

  if (state.retryCount < state.MAX_RETRY) {
    state.retryCount++;
    setStatus(`Reconnecting (${state.retryCount}/${state.MAX_RETRY})…`, 'yellow');
    setTimeout(() => { if (isCurrentToken(token) && state.dash) state.dash.load(url).catch(() => {}); }, 2000 * state.retryCount);
  } else {
    showError('DASH stream failed. DRM-protected or server is down.');
  }
}

/* ── Direct video (MP4 / WebM / fMP4 / audio) ───────────────────────── */
function loadDirectVideo(ch, url, hdrs, usingProxy, fmt, token) {
  qualityBadge.textContent = fmt.toUpperCase();
  videoEl.preload = 'auto';
  videoEl.src = url;
  let fallbackTried = usingProxy;

  function onFinalError() {
    if (!isCurrentToken(token)) return;
    if (state.retryCount < state.MAX_RETRY) {
      state.retryCount++;
      setStatus(`Retry ${state.retryCount}/${state.MAX_RETRY}…`, 'yellow');
      // On a proxy pool with more than one member, rotate to a different
      // worker on retry rather than hammering the same one again.
      if (usingProxy && WORKER_POOL.length > 1) {
        const fallbackUrl = reportWorkerFailureAndGetFallback(url, ch.url, hdrs);
        if (fallbackUrl) videoEl.src = fallbackUrl;
      }
      setTimeout(() => {
        if (!isCurrentToken(token)) return;
        videoEl.load();
        videoEl.play().catch(() => {});
      }, 2000 * state.retryCount);
    } else {
      showError('Cannot play this file. Unsupported format or access denied.');
    }
  }

  function onError() {
    if (!isCurrentToken(token)) return;
    if (!fallbackTried) {
      fallbackTried = true;
      setStatus('Retrying via proxy…', 'yellow');
      videoEl.src = buildProxyUrl(ch.url, hdrs);
      videoEl.load();
      videoEl.play().catch(() => {});
      addManagedListener(videoEl, 'error', onFinalError, { once: true });
    }
  }

  addManagedListener(videoEl, 'error', usingProxy ? onFinalError : onError, { once: true });
  videoEl.play()
    .then(() => { if (!isCurrentToken(token)) return; state.isPlaying = true; updatePlayPauseIcon(); setStatus('Playing', 'green'); })
    .catch(() => { if (!isCurrentToken(token)) return; state.isPlaying = false; updatePlayPauseIcon(); setStatus('Tap to play', 'yellow'); });
}

function showError(msg) {
  setStatus('Error', 'red');
  errorState.classList.add('show');
  $('errorMsg').textContent = msg;
  state.isPlaying = false;
  updatePlayPauseIcon();
}

function setStatus(text, color) {
  connStatus.textContent = text;
  connDot.style.background =
    color === 'green' ? 'var(--grn)' :
    color === 'red' ? 'var(--red)' :
    color === 'yellow' ? 'var(--ylw)' : 'var(--t3)';
  connDot.style.boxShadow = color === 'green' ? '0 0 6px var(--grn)' : 'none';
  const liveBadge = document.querySelector('.live-badge');
  if (liveBadge) {
    if (color === 'green' && text === 'Playing') liveBadge.classList.add('visible');
    else liveBadge.classList.remove('visible');
  }
}

$('retryBtn').addEventListener('click', () => {
  if (state.currentIdx !== -1) {
    errorState.classList.remove('show');
    loadStream(state.channels[state.currentIdx]);
  }
});


/* ═══════════════════════════════════════════════════════
   PLAYER — VIDEO ELEMENT EVENTS
   These are permanent listeners on the element itself (not per-load), so
   they're safe to leave attached across teardownPlayer() calls. They only
   reflect whatever is currently happening on the element, no stale state
   is possible here since the element itself is reset on every load.
   ═══════════════════════════════════════════════════════ */
videoEl.addEventListener('playing', () => {
  state.isPlaying = true;
  updatePlayPauseIcon();
  setStatus('Playing', 'green');
  $('bufferSpinner').style.display = 'none';
});
videoEl.addEventListener('waiting', () => {
  bigPlay.classList.remove('show');
  setStatus('Buffering…', 'yellow');
  $('bufferSpinner').style.display = 'block';
});
videoEl.addEventListener('canplay', () => { $('bufferSpinner').style.display = 'none'; });
videoEl.addEventListener('pause', () => {
  state.isPlaying = false;
  updatePlayPauseIcon();
  setStatus('Paused', 'yellow');
});

videoEl.addEventListener('timeupdate', () => {
  const dur = videoEl.duration;
  if (!dur || isNaN(dur) || !isFinite(dur)) {
    timeDisplay.textContent = 'Live';
    progressFill.style.width = '100%';
    return;
  }
  const pct = (videoEl.currentTime / dur) * 100;
  progressFill.style.width = pct + '%';
  timeDisplay.textContent = fmtTime(videoEl.currentTime) + ' / ' + fmtTime(dur);
});

$('progressWrap').addEventListener('click', e => {
  if (!videoEl.duration || isNaN(videoEl.duration)) return;
  const rect = e.currentTarget.getBoundingClientRect();
  videoEl.currentTime = ((e.clientX - rect.left) / rect.width) * videoEl.duration;
});

bigPlay.addEventListener('click', (e) => {
  e.stopPropagation();
  if (videoEl.paused) {
    videoEl.play().then(() => {
      state.isPlaying = true;
      updatePlayPauseIcon();
    }).catch(() => {});
  }
});

/* ═══════════════════════════════════════════════════════
   QUALITY PANEL — HLS + DASH support
   (Single, canonical implementation — control.js does NOT redefine these.)
   ═══════════════════════════════════════════════════════ */
function createQualRow(label, badge, isActive) {
  const row = document.createElement('div');
  row.className = 'more-qual-row' + (isActive ? ' active' : '');
  row.innerHTML = `
    <div class="more-qual-dot"></div>
    <span class="more-qual-label">${escHtml(label)}</span>
    ${badge ? `<span class="more-qual-badge">${escHtml(badge)}</span>` : ''}
  `;
  return row;
}

function showQualMsg(list, msg) {
  const d = document.createElement('div');
  d.style.cssText = 'padding:12px 10px;font-size:12px;color:rgba(255,255,255,.4);text-align:center';
  d.textContent = msg;
  list.appendChild(d);
}

function buildQualityList() {
  const list = $('moreQualList');
  list.innerHTML = '';

  /* ── Shaka (DASH) ── */
  if (state.dash) {
    let variantTracks = [];
    try { variantTracks = state.dash.getVariantTracks() || []; } catch {}

    const seenHeights = new Set();
    const videoOptions = [];
    variantTracks.forEach(t => {
      if (!t.height || seenHeights.has(t.height)) return;
      seenHeights.add(t.height);
      videoOptions.push(t);
    });

    if (videoOptions.length <= 1) {
      showQualMsg(list, videoOptions.length ? 'Only 1 quality available' : 'Stream not ready yet');
      return;
    }

    let isAuto = true;
    try { isAuto = state.dash.getConfiguration().abr.enabled; } catch {}
    const active = variantTracks.find(t => t.active);

    const autoRow = createQualRow('Auto', `${videoOptions.length}Q`, isAuto);
    autoRow.addEventListener('click', () => {
      try {
        state.dash.configure({ abr: { enabled: true } });
        state.selectedLevel = -1;
      } catch {}
      updateQualBadge();
      buildQualityList();
    });
    list.appendChild(autoRow);

    videoOptions
      .sort((a, b) => (b.height || 0) - (a.height || 0))
      .forEach(t => {
        const label = t.height ? `${t.height}p` : `${Math.round((t.bandwidth || 0) / 1000)}k`;
        const badge = t.bandwidth ? `${Math.round(t.bandwidth / 1000)}k` : '';
        const isActive = !isAuto && active && active.height === t.height;
        const row = createQualRow(label, badge, isActive);
        row.addEventListener('click', () => {
          try {
            state.dash.configure({ abr: { enabled: false } });
            state.dash.selectVariantTrack(t, true);
            state.selectedLevel = t.height;
            const badgeEl = $('qualityBadge');
            const cur = $('moreQualCurrent');
            const lbl = `${t.height}p`;
            badgeEl.textContent = lbl;
            if (cur) cur.textContent = lbl;
          } catch {}
          buildQualityList();
        });
        list.appendChild(row);
      });
    return;
  }

  /* ── HLS ── */
  const hls = state.hls;
  if (!hls?.levels?.length || hls.levels.length <= 1) {
    showQualMsg(list, hls?.levels ? 'Only 1 quality available' : 'No stream loaded');
    return;
  }

  const selectedLevel = state.selectedLevel ?? -1;
  const autoRow = createQualRow('Auto', `${hls.levels.length}Q`, selectedLevel === -1);
  autoRow.addEventListener('click', () => {
    state.selectedLevel = -1; hls.currentLevel = -1;
    updateQualBadge(-1); buildQualityList();
  });
  list.appendChild(autoRow);

  hls.levels
    .map((lv, i) => ({ lv, i }))
    .sort((a, b) => (b.lv.height || 0) - (a.lv.height || 0))
    .forEach(({ lv, i }) => {
      const row = createQualRow(
        lv.height ? `${lv.height}p` : `Level ${i + 1}`,
        lv.bitrate ? `${Math.round(lv.bitrate / 1000)}k` : '',
        selectedLevel === i
      );
      row.addEventListener('click', () => {
        state.selectedLevel = i; hls.currentLevel = i;
        updateQualBadge(i); buildQualityList();
      });
      list.appendChild(row);
    });
}

function updateQualBadge(level) {
  const badge = $('qualityBadge');
  const cur = $('moreQualCurrent');

  /* Shaka (DASH) */
  if (state.dash) {
    try {
      const active = state.dash.getVariantTracks().find(t => t.active);
      let isAuto = true;
      try { isAuto = state.dash.getConfiguration().abr.enabled; } catch {}
      const t = active?.height ? `${active.height}p` : 'DASH';
      badge.textContent = isAuto ? `AQ ${t}` : t;
      if (cur) cur.textContent = t;
    } catch { badge.textContent = 'DASH'; }
    return;
  }

  /* HLS */
  const hls = state.hls;
  if (!hls) return;
  let text;
  if (level === -1 || level === undefined) {
    const lv = hls.levels?.[hls.currentLevel];
    const cnt = hls.levels?.length || 0;
    text = (lv?.height && cnt > 1) ? `AQ ${lv.height}p` : cnt > 1 ? `AUTO · ${cnt}Q` : 'HLS';
  } else {
    text = hls.levels?.[level]?.height ? `${hls.levels[level].height}p` : 'HLS';
  }
  badge.textContent = text;
  if (cur) cur.textContent = text;
}

/* ═══════════════════════════════════════════════════════
   SHARE — Temporary Expiring Channel Link
   ═══════════════════════════════════════════════════════ */
const SHARE_SECRET = 'kslive2025';
const SHARE_TTL_MS = 6 * 60 * 60 * 1000; // 6 hours

async function nameToHash(chName) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(chName));
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('').slice(0, 12);
}

async function genShareToken(chName, playlistIdx) {
  const ts = Date.now();
  const raw = `${chName}:${playlistIdx}:${ts}:${SHARE_SECRET}`;
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(raw));
  const hex = Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('').slice(0, 16);
  return { ts, sig: hex };
}

async function verifyShareToken(chName, playlistIdx, ts, sig) {
  if (Date.now() - Number(ts) > SHARE_TTL_MS) return false;
  const raw = `${chName}:${playlistIdx}:${ts}:${SHARE_SECRET}`;
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(raw));
  const hex = Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('').slice(0, 16);
  return hex === sig;
}

async function shortenUrl(longUrl) {
  try {
    const res = await fetch(`https://round-bonus-4d76.marufhossainkeyas.workers.dev/?url=${encodeURIComponent(longUrl)}`);
    if (!res.ok) throw new Error();
    const short = await res.text();
    return short.startsWith('http') ? short : longUrl;
  } catch {
    return longUrl;
  }
}

async function shareChannel() {
  if (state.currentIdx === -1) { showToast('No channel is playing'); return; }
  const ch = state.channels[state.currentIdx];
  const sharePlaylist = state.activePlaylist; // snapshot — playlist could change mid-await

  const chHash = await nameToHash(ch.name);
  const { ts, sig } = await genShareToken(ch.name, sharePlaylist);
  const base = location.origin + location.pathname;
  const longUrl = `${base}?ch=${chHash}&pl=${sharePlaylist}&t=${ts}&sig=${sig}`;
  const url = await shortenUrl(longUrl);

  const shareText =
`🔴 LIVE NOW on KSLIVE

📺 ${ch.name}
🆓 Free • No login required
⏳ Link expires in 6 hours

Watch now 👇
Link 🔗`;

  if (navigator.share) {
    try {
      await navigator.share({ title: `🔴 ${ch.name} — Live on KSLIVE`, text: shareText, url });
      return;
    } catch (e) { if (e.name === 'AbortError') return; }
  }
  try {
    await navigator.clipboard.writeText(`${shareText}\n${url}`);
    showToast('Link copied! Expires in 6 hours.');
  } catch { showToast('Share not supported on this browser'); }
}

async function checkSharedUrl() {
  const p = new URLSearchParams(location.search);
  const chHash = p.get('ch'), pl = p.get('pl'), ts = p.get('t'), sig = p.get('sig');
  if (!chHash || !ts || !sig) return;

  const plIdx = parseInt(pl) || 0;
  if (!state.playlists[plIdx]) return;

  switchPlaylist(plIdx);
  // Snapshot the exact channel array we're matching against — if the user
  // switches playlists again during the hashing loop below, `channelsAtCall`
  // stays correct instead of racing against state.channels mutating under us.
  const channelsAtCall = state.channels;
  await new Promise(r => setTimeout(r, 300));
  if (state.channels !== channelsAtCall) return; // playlist changed again, abandon

  const matches = await Promise.all(
    channelsAtCall.map(async (c) => {
      const h = await nameToHash(c.name);
      return h === chHash;
    })
  );
  if (state.channels !== channelsAtCall) return; // changed again mid-hash

  const idx = matches.findIndex(Boolean);
  if (idx === -1) { showToast('Channel not found'); return; }

  const valid = await verifyShareToken(channelsAtCall[idx].name, plIdx, ts, sig);
  if (!valid) { showToast('This link has expired ⏰', 4000); return; }
  if (state.channels !== channelsAtCall) return;

  playChannel(idx);
  history.replaceState({}, '', location.pathname);
}

$('shareBtn').addEventListener('click', shareChannel);


/* ═══════════════════════════════════════════════════════
   MOBILE DETECTION (also referenced by control.js's checkMobile calls)
   ═══════════════════════════════════════════════════════ */
function checkMobile() {
  const isMobile = window.innerWidth <= 768;
  if (isMobile) {
    sidebar.classList.remove('collapsed');
    if (typeof updateMobilePlaylistBtn === 'function') updateMobilePlaylistBtn();
  } else {
    const btn = $('mobileSidebarBtn');
    if (btn) btn.style.display = 'none';
  }
}
window.addEventListener('resize', checkMobile);

/* ═══════════════════════════════════════════════════════
   BOOT
   ═══════════════════════════════════════════════════════ */
init();
