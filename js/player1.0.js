/* ═══════════════════════════════════════════════════════
   PLAYLIST CONFIG
   ═══════════════════════════════════════════════════════ */
const PLAYLISTS_JSON_URL = "https://raw.githubusercontent.com/marufhossainkeyas11/kslive/refs/heads/main/playlists.json";
let PLAYLISTS = [];

/* ═══════════════════════════════════════════════
   UNIVERSAL PROXY HELPER
   ═══════════════════════════════════════════════ */
const WORKER_URL = "https://dawn-boat-eca4.marufhossainkeyas.workers.dev/"; 

function buildProxyUrl(targetUrl, headers = {}) {
  const p = new URLSearchParams();
  p.set('url', targetUrl);
  for (const [k, v] of Object.entries(headers)) {
    if (v) p.set('h_' + k.toLowerCase(), v);
  }
  return `${WORKER_URL}?${p.toString()}`;
}

function resolveStreamUrl(ch) {
  const hdrs = ch.compiledHeaders || {};
  const isMixedContent = location.protocol === 'https:' && ch.url.startsWith('http://');
  const needsProxy = Object.keys(hdrs).length > 0 || isMixedContent;
  if (!needsProxy) return ch.url; 
  return buildProxyUrl(ch.url, hdrs);
}

/* ═══════════════════════════════════════════════════════
   M3U PARSER
   ═══════════════════════════════════════════════════════ */
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
        name: '',
        group: 'General',
        logo: '',
        tvgId: '',
        url: '',
        cookies: '',
        userAgent: '',
        referrer: '',
        headers: {},
        rawExtinf: line
      };
      const afterDuration = line.replace(/^#EXTINF:\s*-?\d+(\.\d+)?/, '');
      const attrRx = /([\w-]+)="([^"]*)"/g;
      let m;
      while ((m = attrRx.exec(afterDuration)) !== null) {
        const k = m[1].toLowerCase(),
          v = m[2];
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
          if (json.cookie) current.cookies = json.cookie;
          if (json['user-agent']) current.userAgent = json['user-agent'];
          if (json.referrer || json.referer) current.referrer = json.referrer || json.referer;
        } catch (e) { /* malformed JSON, skip */ }
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
      current.url = line;
      const hdrs = { ...current.headers };
      if (current.userAgent) hdrs['User-Agent'] = current.userAgent;
      if (current.referrer) hdrs['Referer'] = current.referrer;
      if (current.cookies) hdrs['Cookie'] = current.cookies;
      current.compiledHeaders = normalizeHeaders(current);
      channels.push(current);
      current = null;
    }
  }
  return channels;
}


/* ═══════════════════════════════════════════════════════
   APP STATE
   ═══════════════════════════════════════════════════════ */
const state = {
  playlists: [],
  activePlaylist: 0,
  channels: [],
  filteredChannels: [],
  activeGroup: 'All',
  currentIdx: -1,
  hls: null,
  dash: null,    // active dash.js MediaPlayer instance
  format: 'hls',  // current stream format: 'hls' | 'dash' | 'mp4' | 'webm' | 'audio' | 'ts'
  isPlaying: false,
  isMuted: false,
  retryCount: 0,
  MAX_RETRY: 3
};


/* ═══════════════════════════════════════════════════════
   DOM REFS
   ═══════════════════════════════════════════════════════ */
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

/* ═══════════════════════════════════════════════════════
   LANGUAGE CODE → FULL NAME
   ═══════════════════════════════════════════════════════ */
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
  const code = lang.split('-')[0].toLowerCase(); // 'en-US' → 'en'
  return LANG_NAMES[code] || lang.toUpperCase();
}

/* ═══════════════════════════════════════════════════════
   UTILS
   ═══════════════════════════════════════════════════════ */
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

// Persist last played
function saveLastChannel(plIdx, chIdx) {
  try { localStorage.setItem('sv_last', JSON.stringify({ plIdx, chIdx })); } catch {}
}

function loadLastChannel() {
  try { return JSON.parse(localStorage.getItem('sv_last')); } catch { return null; }
}

// Toast
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

/** Cleanly destroy any active player and reset the video element */
function teardownPlayer() {
  if (state.hls)  { state.hls.destroy();  state.hls  = null; }
  if (state.dash) { state.dash.destroy(); state.dash = null; }
  state.format = 'hls';
  try { videoEl.removeAttribute('src'); videoEl.load(); } catch {}
}

/**
 * Detect stream format from the raw channel URL.
 * Falls back to 'hls' (overwhelmingly most common for IPTV).
 */
function detectFormat(url) {
  const u = (url || '').split('?')[0].split('#')[0].toLowerCase();
  if (u.endsWith('.mpd'))                                          return 'dash';
  if (u.endsWith('.m3u8') || u.endsWith('.m3u'))                  return 'hls';
  if (/\.(mp4|m4v|mov|m4s|cmaf)$/.test(u))                       return 'mp4';
  if (/\.webm$/.test(u))                                          return 'webm';
  if (/\.(mp3|aac|ogg|flac|wav)$/.test(u))                       return 'audio';
  if (/\.(ts|mts|m2ts)$/.test(u))                                 return 'ts';
  // Pattern heuristics
  if (u.includes('.mpd') || u.includes('/mpd/'))                  return 'dash';
  if (u.includes('.m3u') || u.includes('/hls/') || u.includes('chunklist')) return 'hls';
  return 'hls';
}

/** fetch() with per-request AbortController timeout */
async function fetchWithTimeout(url, options = {}, ms = 15_000) {
  const ctrl  = new AbortController();
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

/**
 * Load dash.js on-demand — only injected when a DASH stream is first encountered.
 * Returns true on success, false if the library could not be loaded.
 */
function ensureDashJs() {
  if (typeof dashjs !== 'undefined') return Promise.resolve(true);
  return new Promise(resolve => {
    const s = document.createElement('script');
    s.src      = 'https://cdn.dashjs.org/latest/dash.all.min.js';
    s.onload   = () => resolve(true);
    s.onerror  = () => resolve(false);
    document.head.appendChild(s);
  });
}

/** Update the loading screen status text (no-op if element not found) */
function setLoadingMsg(msg) {
  const el = document.querySelector('#loadingScreen .loading-text')
    || document.querySelector('#loadingScreen p')
    || document.querySelector('#loadingScreen span');
  if (el) el.textContent = msg;
}


/* ═══════════════════════════════════════════════════════
   NETWORK — FETCH M3U
   ═══════════════════════════════════════════════════════ */
async function fetchM3U(pl) {
  const { url, fetchHeaders } = pl;
  if (!url.startsWith('http') && !url.startsWith('//')) return url;

  // Direct fetch with timeout
  try {
    const res = await fetchWithTimeout(
      url,
      { headers: fetchHeaders || {}, cache: 'no-cache' },
      12_000
    );
    if (res.ok) return await res.text();
  } catch (e) {
    if (e.message.startsWith('Timed out')) throw e;
    console.warn('[fetchM3U] Direct failed, trying CORS proxies…', e.message);
  }

  // CORS proxy fallbacks
  const proxies = [
    `https://api.allorigins.win/raw?url=${encodeURIComponent(url)}`,
    `https://corsproxy.io/?${encodeURIComponent(url)}`,
  ];
  for (const proxy of proxies) {
    try {
      const res = await fetchWithTimeout(proxy, {}, 10_000);
      if (res.ok) return await res.text();
    } catch {}
  }

  throw new Error('All fetch attempts failed');
}


/* ═══════════════════════════════════════════════════════
   INIT — BOOT
   ═══════════════════════════════════════════════════════ */
async function init() {
  setLoadingMsg('Loading channel config…');

  try {
    const res  = await fetchWithTimeout(PLAYLISTS_JSON_URL + '?t=' + Date.now(), {}, 10_000);
    PLAYLISTS  = await res.json();
  } catch (e) {
    console.error('[init] Failed to load playlists config:', e);
    PLAYLISTS = [];
  }

  const total = PLAYLISTS.length;
  let done    = 0;
  setLoadingMsg(`Loading ${total} playlist${total !== 1 ? 's' : ''}…`);

  // All playlists load in parallel; progress updates per completion
  const results = await Promise.allSettled(
    PLAYLISTS.map(async (pl) => {
      try {
        const text     = await fetchM3U(pl);
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

  buildPlaylistTabs();
  switchPlaylist(0);

  const last = loadLastChannel();
  if (last && state.playlists[last.plIdx]?.channels[last.chIdx]) {
    switchPlaylist(last.plIdx);
    setTimeout(() => {
      playChannel(last.chIdx);
      setTimeout(() => {
        videoEl.play()
          .then(() => { state.isPlaying = true;  updatePlayPauseIcon(); })
          .catch(() => { state.isPlaying = false; updatePlayPauseIcon(); });
      }, 1000);
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
const plScrollLeft  = $('plScrollLeft');
const plScrollRight = $('plScrollRight');

function updatePlScrollButtons() {
  const el = playlistTabs;
  const maxScroll = el.scrollWidth - el.clientWidth;
  const needsScroll = maxScroll > 4;

  plScrollLeft.style.display  = needsScroll ? 'flex' : 'none';
  plScrollRight.style.display = needsScroll ? 'flex' : 'none';

  plScrollLeft.disabled  = el.scrollLeft <= 4;
  plScrollRight.disabled = el.scrollLeft >= maxScroll - 4;
}

plScrollLeft.addEventListener('click', () => {
  playlistTabs.scrollBy({ left: -160, behavior: 'smooth' });
});
plScrollRight.addEventListener('click', () => {
  playlistTabs.scrollBy({ left: 160, behavior: 'smooth' });
});
playlistTabs.addEventListener('scroll', updatePlScrollButtons);
window.addEventListener('resize', updatePlScrollButtons);

function buildPlaylistTabs() {
  playlistTabs.innerHTML = '';
  state.playlists.forEach((pl, idx) => {
    const tab = document.createElement('button');
    tab.className = 'pl-tab' + (idx === 0 ? ' active' : '');
    
    const imgHtml = pl.image
      ? `<img class="pl-tab-img" src="${escAttr(pl.image)}" alt="" onerror="this.style.display='none'">`
      : `<div class="pl-tab-img pl-tab-img-fallback">${escHtml(pl.name.substring(0,2).toUpperCase())}</div>`;
    
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
  state.activePlaylist = idx;
  state.channels = state.playlists[idx]?.channels || [];
  state.currentIdx = -1;
  document.querySelectorAll('.pl-tab').forEach((t, i) => t.classList.toggle('active', i === idx));
  
  const activeTab = playlistTabs.querySelectorAll('.pl-tab')[idx];
  if (activeTab) {
    activeTab.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'center' });
  }
  
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
      const logoHtml = ch.logo ?
        `<div class="ch-logo"><img src="${escAttr(ch.logo)}" alt="" onerror="this.parentNode.textContent='${escHtml(ch.name.substring(0,3))}'"></div>` :
        `<div class="ch-logo">${escHtml(ch.name.substring(0,3))}</div>`;
      const eqHtml = globalIdx === state.currentIdx ?
        `<div class="eq-bars"><div class="eq-bar"></div><div class="eq-bar"></div><div class="eq-bar"></div></div>` :
        '';
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
  state.retryCount = 0;
  errorState.classList.remove('show');
  renderChannelList();
  
  if (window.innerWidth <= 768) sidebar.classList.remove('mobile-open');
  
  emptyState.style.display = 'none';
  channelDetail.style.display = 'block';
  npName.textContent = ch.name;
  detailName.textContent = ch.name;
  
  const npLogo = $('npLogo');
  if (ch.logo) { npLogo.src = ch.logo;
    npLogo.classList.add('show'); }
  else { npLogo.src = '';
    npLogo.classList.remove('show'); }
  
  detailLogo.innerHTML = ch.logo ?
    `<img src="${escAttr(ch.logo)}" alt="" onerror="this.parentNode.textContent='${escHtml(ch.name.substring(0,3))}'"><span style="display:none">${escHtml(ch.name.substring(0,3))}</span>` :
    escHtml(ch.name.substring(0, 3));
  
  detailMeta.innerHTML = [
    ch.group && `<span class="meta-tag">${escHtml(ch.group)}</span>`,
    ch.tvgId && `<span class="meta-tag blue">${escHtml(ch.tvgId)}</span>`,
    Object.keys(ch.compiledHeaders || {}).length && `<span class="meta-tag">🔐 Headers</span>`,
  ].filter(Boolean).join('');
  
  loadStream(ch);
}


/* ═══════════════════════════════════════════════════════
   PLAYER — STREAM LOADING
   Dispatcher → loadHls / loadDash / loadDirectVideo
   ═══════════════════════════════════════════════════════ */

const FORMAT_BADGE = { dash: 'DASH', mp4: 'MP4', webm: 'WEBM', audio: 'AUDIO', ts: 'TS' };

function loadStream(ch, forceProxy = false) {
  teardownPlayer();
  setStatus('Connecting…', 'yellow');
  errorState.classList.remove('show');
  $('bufferSpinner').style.display = 'none';
  state.retryCount = 0;

  // Reset subtitle/CC state
  if (typeof closeMoreSubPanel === 'function') closeMoreSubPanel();
  state.ccTracks  = [];
  state.activeCcId = null;
  if (typeof refreshCcButtons === 'function') refreshCcButtons();
  
  state.audioTracks = [];
  state.activeAudioId = null;
  if (typeof refreshAudioButtons === 'function') refreshAudioButtons();

  const hdrs      = ch.compiledHeaders || {};
  const hasHdrs   = Object.keys(hdrs).length > 0;
  const mixedHttp = location.protocol === 'https:' && ch.url.startsWith('http://');
  const useProxy  = forceProxy || hasHdrs || mixedHttp;
  const url       = useProxy ? buildProxyUrl(ch.url, hdrs) : ch.url;
  const fmt       = detectFormat(ch.url);

  state.format = fmt;
  qualityBadge.textContent = FORMAT_BADGE[fmt] || 'HLS';

  if (fmt === 'dash')                                        loadDash(ch, url, hdrs, useProxy);
  else if (fmt === 'mp4' || fmt === 'webm' || fmt === 'audio') loadDirectVideo(ch, url, hdrs, useProxy, fmt);
  else                                                       loadHls(ch, url, hdrs, useProxy); // hls / ts / unknown
}


/* ── HLS (HLS.js + Safari native fallback) ─────────── */
function loadHls(ch, url, hdrs, usingProxy) {
  let fallbackTried = usingProxy;

  if (Hls.isSupported()) {
    const hls = new Hls({
      xhrSetup: xhr => {
        if (hdrs['user-agent']) xhr.setRequestHeader('User-Agent', hdrs['user-agent']);
      },
      enableWorker:   true,
      lowLatencyMode: true,
      backBufferLength: 30,
      // Lean retry counts — proxy fallback is the real safety net
      manifestLoadingMaxRetry:        usingProxy ? 3 : 1,
      manifestLoadingRetryDelay:      1000,
      manifestLoadingMaxRetryTimeout: 8000,
      levelLoadingMaxRetry:           usingProxy ? 3 : 1,
      levelLoadingRetryDelay:         1000,
      fragLoadingMaxRetry:            usingProxy ? 3 : 1,
      fragLoadingRetryDelay:          500,
    });

    state.hls = hls;
    hls.loadSource(url);
    hls.attachMedia(videoEl);

    hls.on(Hls.Events.MANIFEST_PARSED, (_, data) => {
      qualityBadge.textContent = data.levels?.length > 1 ? `HLS · ${data.levels.length}Q` : 'HLS';
      if (typeof collectAudioTracks === 'function') collectAudioTracks();
  
      videoEl.play()
        .then(() => { state.isPlaying = true;  updatePlayPauseIcon(); setStatus('Playing', 'green'); })
        .catch(() => { state.isPlaying = false; updatePlayPauseIcon(); setStatus('Tap to play', 'yellow'); });
    });

    hls.on(Hls.Events.LEVEL_SWITCHED, (_, data) => {
      const lv = hls.levels[data.level];
      if (lv?.height) {
        const t = hls.autoLevelEnabled ? `AUTO · ${lv.height}p` : `${lv.height}p`;
        qualityBadge.textContent = t;
        const cur = $('moreQualCurrent'); if (cur) cur.textContent = t;
      }
      document.dispatchEvent(new Event('hlsLevelUpdate'));
    });

    hls.on(Hls.Events.FRAG_LOADED, () => { $('bufferSpinner').style.display = 'none'; });

    hls.on(Hls.Events.SUBTITLE_TRACKS_UPDATED, () => document.dispatchEvent(new Event('hlsSubtitleTracksUpdate')));
    hls.on(Hls.Events.SUBTITLE_TRACK_SWITCH,   () => document.dispatchEvent(new Event('hlsSubtitleTrackSwitch')));

    hls.on(Hls.Events.AUDIO_TRACKS_UPDATED, () => document.dispatchEvent(new Event('hlsAudioTracksUpdate')));
    hls.on(Hls.Events.AUDIO_TRACK_SWITCHED, () => document.dispatchEvent(new Event('hlsAudioTrackSwitch')));

    hls.on(Hls.Events.ERROR, (_, data) => {
      const httpCode  = data.response?.code;
      const isBlocked = httpCode === 403 || httpCode === 503 || httpCode === 0;

      // Not yet on proxy → try proxy once on any block or fatal error
      if (!fallbackTried && (isBlocked || data.fatal)) {
        fallbackTried = true;
        setStatus('Blocked — retrying via proxy…', 'yellow');
        hls.destroy(); state.hls = null;
        setTimeout(() => loadHls(ch, buildProxyUrl(ch.url, hdrs), hdrs, true), 300);
        return;
      }

      if (!data.fatal) return; // non-fatal: HLS.js self-heals

      if (data.type === Hls.ErrorTypes.NETWORK_ERROR) {
        if (state.retryCount < state.MAX_RETRY) {
          state.retryCount++;
          setStatus(`Reconnecting (${state.retryCount}/${state.MAX_RETRY})…`, 'yellow');
          setTimeout(() => hls.startLoad(), 2000 * state.retryCount);
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
    videoEl.src = url;
    setStatus('Connecting…', 'yellow');
    videoEl.play().catch(() => {});
    videoEl.addEventListener('loadedmetadata', () => {
      if (typeof collectCcTracks === 'function') collectCcTracks();
    }, { once: true });
    videoEl.addEventListener('error', () => {
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

const DRM_LABELS = {
  widevine: 'Widevine',
  playready: 'PlayReady',
  fairplay: 'FairPlay',
  cenc: 'CENC/DRM',
};

/**
 * Peek the manifest through the proxy first, purely to read the
 * X-KSLIVE-DRM header the Worker sets when it spots <ContentProtection>.
 * Returns a comma-separated scheme string, or null if none / check failed.
 * Failing this check should never block playback — worst case we just
 * don't get the early warning and fall through to normal dash.js errors.
 */
async function peekDrmHeader(mpdUrl) {
  try {
    const res = await fetchWithTimeout(mpdUrl, { method: 'GET' }, 8_000);
    return res.headers.get('X-KSLIVE-DRM');
  } catch {
    return null;
  }
}

/* ── DASH/MPD (dash.js, loaded on-demand) ────────────── */
async function loadDash(ch, url, hdrs, usingProxy) {
  qualityBadge.textContent = 'DASH';
  setStatus('Loading DASH player…', 'yellow');

  // ── Early DRM check — avoids a pointless dash.js init + retry loop ──
  // Only meaningful when routed through our Worker (usingProxy), since
  // that's the only place the X-KSLIVE-DRM header gets set.
  if (usingProxy) {
    const drm = await peekDrmHeader(url);
    if (state.channels[state.currentIdx] !== ch) return; // channel changed meanwhile
    if (drm) {
      const names = drm.split(',').map(s => DRM_LABELS[s] || s).join(' / ');
      showError(`এই চ্যানেলটি ${names} DRM দ্বারা সুরক্ষিত — এই প্লেয়ারে চালানো সম্ভব নয়।`);
      setStatus('DRM protected', 'red');
      return;
    }
  }

  const loaded = await ensureDashJs();
  if (!loaded) {
    showError('Failed to load DASH library (dash.js). Check your connection.');
    return;
  }
  // Guard: user may have switched channel while dash.js was loading
  if (state.channels[state.currentIdx] !== ch) return;

  const player = dashjs.MediaPlayer().create();
  state.dash   = player;

  player.updateSettings({
    debug:     { logLevel: dashjs.Debug.LOG_LEVEL_WARNING },
    streaming: {
      delay:  { liveDelay: 3 },
      abr:    { autoSwitchBitrate: { video: true, audio: true } },
      buffer: {
        fastSwitchEnabled:              true,
        bufferToKeep:                   20,
        bufferTimeAtTopQuality:         20,
        bufferTimeAtTopQualityLongForm: 30,
      },
      retryAttempts: {
        MPD: 3, MediaSegment: 4,
        InitializationSegment: 3, BitstreamSwitchingSegment: 3,
      },
      retryIntervals: {
        MPD: 1000, MediaSegment: 1000,
        InitializationSegment: 1000, BitstreamSwitchingSegment: 1000,
      },
    },
  });

  player.initialize(videoEl, url, /* autoPlay */ true);

  // ── DRM catch via dash.js LOG event ──────────────────────────────
  // "No license server URL specified" is emitted through dash.js's
  // internal logger (Events.LOG), not always as a distinct ERROR event.
  // This is dash.js's supported public hook for reading log lines.
  let drmCaught = false;
  if (dashjs.MediaPlayer.events.LOG) {
    player.on(dashjs.MediaPlayer.events.LOG, (e) => {
      if (drmCaught) return;
      const msg = String(e?.message ?? '');
      if (/no license server url specified/i.test(msg)) {
        drmCaught = true;
        player.destroy(); state.dash = null;
        showError('এই স্ট্রিমটি DRM দ্বারা সুরক্ষিত — এই প্লেয়ারে চালানো সম্ভব নয়।');
        setStatus('DRM protected', 'red');
      }
    });
  }

  player.on(dashjs.MediaPlayer.events.STREAM_INITIALIZED, () => {
    try {
      const list = player.getBitrateInfoListFor('video');
      qualityBadge.textContent = list?.length > 1 ? `DASH · ${list.length}Q` : 'DASH';
    } catch {}
    document.dispatchEvent(new Event('dashStreamReady'));
    if (typeof collectAudioTracks === 'function') collectAudioTracks();
    if (typeof collectCcTracks === 'function') collectCcTracks(); // ← নতুন লাইন
  });
  
  player.on(dashjs.MediaPlayer.events.TRACK_CHANGE_RENDERED, e => {
    if (e.mediaType === 'audio' && typeof syncDashAudioActive === 'function') syncDashAudioActive();
  });

  player.on(dashjs.MediaPlayer.events.QUALITY_CHANGE_RENDERED, data => {
    if (data.mediaType !== 'video') return;
    try {
      const lv = player.getBitrateInfoListFor('video')[data.newQuality];
      if (lv?.height) {
        const t = `${lv.height}p`;
        qualityBadge.textContent = t;
        const cur = $('moreQualCurrent'); if (cur) cur.textContent = t;
      }
    } catch {}
  });

  player.on(dashjs.MediaPlayer.events.PLAYBACK_NOT_ALLOWED, () => {
    state.isPlaying = false;
    updatePlayPauseIcon();
    setStatus('Tap to play', 'yellow');
  });

  player.on(dashjs.MediaPlayer.events.ERROR, e => {
    console.error('[DASH] Error:', e);
    const s = String(e.error?.code ?? '') + String(e.error ?? '');
    const isNetErr = s.includes('403') || s.includes('404') || s.includes('27') || s.includes('25');
    // dash.js surfaces missing-license-server as a generic error, not a
    // distinct code — catch it here as a fallback in case the Worker-side
    // header check above didn't run (e.g. direct/non-proxy playback).
    let errDump = '';
    try { errDump = JSON.stringify(e); } catch { errDump = String(e.error?.message ?? e.error ?? ''); }
    const isDrmErr = /license server|no license|drm:/i.test(errDump);

    if (isDrmErr) {
      player.destroy(); state.dash = null;
      showError('এই স্ট্রিমটি DRM দ্বারা সুরক্ষিত — এই প্লেয়ারে চালানো সম্ভব নয়।');
      setStatus('DRM protected', 'red');
      return;
    }

    if (!usingProxy && isNetErr) {
      player.destroy(); state.dash = null;
      setStatus('DASH blocked — retrying via proxy…', 'yellow');
      setTimeout(() => loadDash(ch, buildProxyUrl(ch.url, hdrs), hdrs, true), 400);
      return;
    }

    if (state.retryCount < state.MAX_RETRY) {
      state.retryCount++;
      setStatus(`Reconnecting (${state.retryCount}/${state.MAX_RETRY})…`, 'yellow');
      setTimeout(() => {
        try { if (state.dash) state.dash.attachSource(url); } catch {}
      }, 2000 * state.retryCount);
    } else {
      showError('DASH stream failed. DRM-protected or server is down.');
    }
  });
}


/* ── Direct video (MP4 / WebM / fMP4 / audio) ─────────── */
function loadDirectVideo(ch, url, hdrs, usingProxy, fmt) {
  qualityBadge.textContent = fmt.toUpperCase();
  videoEl.preload = 'auto';
  videoEl.src     = url;
  let fallbackTried = usingProxy;

  function onFinalError() {
    if (state.retryCount < state.MAX_RETRY) {
      state.retryCount++;
      setStatus(`Retry ${state.retryCount}/${state.MAX_RETRY}…`, 'yellow');
      setTimeout(() => { videoEl.load(); videoEl.play().catch(() => {}); }, 2000 * state.retryCount);
    } else {
      showError('Cannot play this file. Unsupported format or access denied.');
    }
  }

  function onError() {
    if (!fallbackTried) {
      fallbackTried = true;
      setStatus('Retrying via proxy…', 'yellow');
      videoEl.removeEventListener('error', onError);
      videoEl.src = buildProxyUrl(ch.url, hdrs);
      videoEl.load();
      videoEl.play().catch(() => {});
      videoEl.addEventListener('error', onFinalError, { once: true });
    }
  }

  videoEl.addEventListener('error', usingProxy ? onFinalError : onError, { once: true });
  videoEl.play()
    .then(() => { state.isPlaying = true;  updatePlayPauseIcon(); setStatus('Playing', 'green'); })
    .catch(() => { state.isPlaying = false; updatePlayPauseIcon(); setStatus('Tap to play', 'yellow'); });
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
    color === 'green'  ? 'var(--grn)' :
    color === 'red'    ? 'var(--red)' :
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
    state.retryCount = 0;
    errorState.classList.remove('show');
    loadStream(state.channels[state.currentIdx]);
  }
});


/* ═══════════════════════════════════════════════════════
   PLAYER — VIDEO ELEMENT EVENTS
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
// NOTE: generic 'error' listener removed — loadHls / loadDash / loadDirectVideo
// each attach their own error handling + proxy fallback + retry logic now.
// Keeping a second global handler here would double-fire retries.

videoEl.addEventListener('timeupdate', () => {
  if (!videoEl.duration || isNaN(videoEl.duration)) {
    timeDisplay.textContent = 'LIVE';
    progressFill.style.width = '100%';
    return;
  }
  const pct = (videoEl.currentTime / videoEl.duration) * 100;
  progressFill.style.width = pct + '%';
  timeDisplay.textContent = fmtTime(videoEl.currentTime) + ' / ' + fmtTime(videoEl.duration);
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

  /* ── DASH ───────────────────────────────────────────── */
  if (state.dash) {
    let bitrateList;
    try { bitrateList = state.dash.getBitrateInfoListFor('video'); } catch {}

    if (!bitrateList?.length || bitrateList.length <= 1) {
      showQualMsg(list, bitrateList ? 'Only 1 quality available' : 'Stream not ready yet');
      return;
    }

    let isAuto = true;
    try { isAuto = state.dash.getSettings().streaming?.abr?.autoSwitchBitrate?.video !== false; } catch {}
    let currentQ = -1;
    try { currentQ = state.dash.getQualityFor('video'); } catch {}

    const autoRow = createQualRow('Auto', `${bitrateList.length}Q`, isAuto);
    autoRow.addEventListener('click', () => {
      try {
        state.dash.updateSettings({ streaming: { abr: { autoSwitchBitrate: { video: true } } } });
        state.selectedLevel = -1;
      } catch {}
      buildQualityList();
    });
    list.appendChild(autoRow);

    [...bitrateList]
      .sort((a, b) => (b.height || 0) - (a.height || 0))
      .forEach(info => {
        const label  = info.height ? `${info.height}p` : `${Math.round((info.bitrate || 0) / 1000)}k`;
        const badge  = info.bitrate ? `${Math.round(info.bitrate / 1000)}k` : '';
        const row = createQualRow(label, badge, !isAuto && info.qualityIndex === currentQ);
        row.addEventListener('click', () => {
          try {
            state.dash.updateSettings({ streaming: { abr: { autoSwitchBitrate: { video: false } } } });
            state.dash.setQualityFor('video', info.qualityIndex);
            state.selectedLevel = info.qualityIndex;
          } catch {}
          buildQualityList();
        });
        list.appendChild(row);
      });
    return;
  }

  /* ── HLS ────────────────────────────────────────────── */
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
  const cur   = $('moreQualCurrent');

  /* DASH */
  if (state.dash) {
    try {
      const list = state.dash.getBitrateInfoListFor('video');
      const q    = state.dash.getQualityFor('video');
      const t    = list?.[q]?.height ? `${list[q].height}p` : 'DASH';
      badge.textContent = t;
      if (cur) cur.textContent = t;
    } catch { badge.textContent = 'DASH'; }
    return;
  }

  /* HLS */
  const hls = state.hls;
  if (!hls) return;
  let text;
  if (level === -1) {
    const lv  = hls.levels?.[hls.currentLevel];
    const cnt = hls.levels?.length || 0;
    text = (lv?.height && cnt > 1) ? `AUTO · ${lv.height}p` : cnt > 1 ? `AUTO · ${cnt}Q` : 'HLS';
  } else {
    text = hls.levels?.[level]?.height ? `${hls.levels[level].height}p` : 'HLS';
  }
  badge.textContent = text;
  if (cur) cur.textContent = text;
}

/* ═══════════════════════════════════════════════════════
   BOOT
   ═══════════════════════════════════════════════════════ */
init();
