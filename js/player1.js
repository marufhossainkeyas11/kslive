/* ═══════════════════════════════════════════════════════
   PLAYLIST CONFIG
   ═══════════════════════════════════════════════════════ */
const PLAYLISTS_JSON_URL = "https://raw.githubusercontent.com/marufhossainkeyas11/kslive/refs/heads/main/playlists.json";
let PLAYLISTS = [];

/* ═══════════════════════════════════════════════
   UNIVERSAL PROXY HELPER
   ═══════════════════════════════════════════════ */
const WORKER_URL = "https://long-disk-874c.marufhossainkeyas.workers.dev/"; 

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
   NETWORK — FETCH M3U
   ═══════════════════════════════════════════════════════ */
async function fetchM3U(pl) {
  const { url, fetchHeaders } = pl;
  if (!url.startsWith('http') && !url.startsWith('//')) return url;
  
  try {
    const resp = await fetch(url, { headers: fetchHeaders || {}, cache: 'no-cache' });
    if (resp.ok) return await resp.text();
  } catch (e) {
    console.warn('Direct fetch failed, trying CORS proxy…', e);
  }
  
  const proxies = [
    `https://api.allorigins.win/raw?url=${encodeURIComponent(url)}`,
    `https://corsproxy.io/?${encodeURIComponent(url)}`
  ];
  for (const proxy of proxies) {
    try {
      const resp = await fetch(proxy);
      if (resp.ok) return await resp.text();
    } catch {}
  }
  throw new Error('Failed to fetch playlist after trying proxies.');
}


/* ═══════════════════════════════════════════════════════
   INIT — BOOT
   ═══════════════════════════════════════════════════════ */
async function init() {
  try {
    const res = await fetch(PLAYLISTS_JSON_URL + '?t=' + Date.now());
    PLAYLISTS = await res.json();
  } catch (e) {
    console.error('Failed to load playlists config:', e);
    PLAYLISTS = [];
  }
  
  const results = await Promise.allSettled(
    PLAYLISTS.map(async (pl) => {
      const text = await fetchM3U(pl);
      return { name: pl.name, image: pl.image || '', channels: parseM3U(text) };
    })
  );
  
  results.forEach((r, i) => {
    if (r.status === 'fulfilled') {
      state.playlists.push(r.value);
    } else {
      console.error(`Playlist "${PLAYLISTS[i].name}" failed:`, r.reason);
      state.playlists.push({ name: PLAYLISTS[i].name, channels: [], error: r.reason?.message });
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
        videoEl.play().then(() => {
          state.isPlaying = true;
          updatePlayPauseIcon();
        }).catch(() => {
          state.isPlaying = false;
          updatePlayPauseIcon();
        });
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
   PLAYER — STREAM LOADING (HLS / NATIVE / DIRECT)
   ═══════════════════════════════════════════════════════ */
function loadStream(ch, forceProxy = false) {
  if (state.hls) { state.hls.destroy(); state.hls = null; }
  videoEl.src = '';
  setStatus('Connecting…', 'yellow');
  qualityBadge.textContent = 'HLS';

  // Reset subtitle/CC state for the new stream
  if (typeof closeMoreSubPanel === 'function') closeMoreSubPanel();
  state.ccTracks = [];
  state.activeCcId = null;
  if (typeof refreshCcButtons === 'function') refreshCcButtons();

  const hdrs = ch.compiledHeaders || {};
  const hasHeaders = Object.keys(hdrs).length > 0;
  const isMixedContent = location.protocol === 'https:' && ch.url.startsWith('http://');
  const url = (forceProxy || hasHeaders || isMixedContent) ? buildProxyUrl(ch.url, hdrs) : ch.url;
  
  if (Hls.isSupported()) {
    const hls = new Hls({
      xhrSetup: (xhr) => {
        if (hdrs['user-agent']) xhr.setRequestHeader('User-Agent', hdrs['user-agent']);
      },
      enableWorker: true,
      lowLatencyMode: true,
      backBufferLength: 30,

      manifestLoadingMaxRetry: forceProxy ? 4 : 1,
      manifestLoadingRetryDelay: 500,
      manifestLoadingMaxRetryTimeout: 4000,

      levelLoadingMaxRetry: forceProxy ? 4 : 1,
      levelLoadingRetryDelay: 500,
      levelLoadingMaxRetryTimeout: 4000,

      fragLoadingMaxRetry: forceProxy ? 4 : 1,
      fragLoadingRetryDelay: 500,
      fragLoadingMaxRetryTimeout: 4000,
    });
    state.hls = hls;
    hls.loadSource(url);
    hls.attachMedia(videoEl);

    let proxyFallbackTried = forceProxy;

    hls.on(Hls.Events.MANIFEST_PARSED, (e, data) => {
      qualityBadge.textContent = data.levels.length > 1 ? `AUTO · ${data.levels.length}Q` : 'HLS';
      videoEl.play().then(() => {
        state.isPlaying = true;
        updatePlayPauseIcon();
        setStatus('Playing', 'green');
      }).catch(() => {
        state.isPlaying = false;
        updatePlayPauseIcon();
        setStatus('Paused', 'yellow');
      });
    });
     
    hls.on(Hls.Events.LEVEL_SWITCHED, (_, data) => {
     const lv = hls.levels[data.level];
     const isAuto = hls.autoLevelEnabled;
     if (lv?.height) {
       const text = isAuto ? `AUTO · ${lv.height}p` : `${lv.height}p`;
       $('qualityBadge').textContent = text;
       const cur = $('moreQualCurrent');
       if (cur) cur.textContent = text;
     }
     document.dispatchEvent(new Event('hlsLevelUpdate'));
   });

    // Subtitle tracks become known once the manifest (and any media playlists) are parsed
    hls.on(Hls.Events.SUBTITLE_TRACKS_UPDATED, () => {
      document.dispatchEvent(new Event('hlsSubtitleTracksUpdate'));
    });
    hls.on(Hls.Events.SUBTITLE_TRACK_SWITCH, () => {
      document.dispatchEvent(new Event('hlsSubtitleTrackSwitch'));
    });

    hls.on(Hls.Events.ERROR, (e, data) => {
      const isHttpBlock = data.response && (data.response.code === 503 || data.response.code === 403);

      if (!proxyFallbackTried && isHttpBlock) {
        proxyFallbackTried = true;
        console.warn('Direct fetch blocked (', data.response.code, '), switching to proxy…');
        setStatus('Retrying via proxy…', 'yellow');
        hls.destroy();
        setTimeout(() => loadStream(ch, true), 200);
        return;
      }

      if (!data.fatal) return;

      if (!proxyFallbackTried) {
        proxyFallbackTried = true;
        console.warn('Direct play failed (fatal), retrying via proxy…');
        setStatus('Retrying via proxy…', 'yellow');
        hls.destroy();
        setTimeout(() => loadStream(ch, true), 200);
        return;
      }

      if (data.type === Hls.ErrorTypes.NETWORK_ERROR) {
        if (state.retryCount < state.MAX_RETRY) {
          state.retryCount++;
          setStatus(`Reconnecting (${state.retryCount}/${state.MAX_RETRY})…`, 'yellow');
          setTimeout(() => hls.startLoad(), 2000);
        } else {
          showError('Stream offline or blocked.');
        }
      } else if (data.type === Hls.ErrorTypes.MEDIA_ERROR) {
        hls.recoverMediaError();
      } else {
        showError('Stream is not being created.');
      }
    });

  } else if (videoEl.canPlayType('application/vnd.apple.mpegurl')) {
    videoEl.src = url;
    videoEl.play().catch(() => {});
    setStatus('Playing', 'green');

    // Native HLS (Safari/iOS): subtitle tracks surface via the video element's textTracks
    videoEl.addEventListener('loadedmetadata', () => {
      if (typeof collectCcTracks === 'function') collectCcTracks();
    }, { once: true });
  }
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
  connDot.style.background = color === 'green' ? 'var(--grn)' : color === 'red' ? 'var(--red)' : color === 'yellow' ? 'var(--ylw)' : 'var(--t3)';
  connDot.style.boxShadow = color === 'green' ? '0 0 6px var(--grn)' : 'none';
  const liveBadge = document.querySelector('.live-badge');
  if (color === 'green' && text === 'Playing') liveBadge.classList.add('visible');
  else liveBadge.classList.remove('visible');
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
videoEl.addEventListener('error', () => {
  if (state.currentIdx === -1) return;
  if (state.retryCount < state.MAX_RETRY) {
    state.retryCount++;
    setStatus(`Retry ${state.retryCount}/${state.MAX_RETRY}…`, 'yellow');
    setTimeout(() => loadStream(state.channels[state.currentIdx]), 3000);
  } else {
    showError('Unable to load stream. Check the URL or try another channel.');
  }
});

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
   BOOT
   ═══════════════════════════════════════════════════════ */
init();
