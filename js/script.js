/* ═══════════════════════════════════════════════════════
   PLAYLIST CONFIG
   Add as many playlists as you want here.
   Each playlist can be:
     • A direct URL to an .m3u / .m3u8 file
     • A data URI (already loaded text)
     • An inline string (raw M3U content)
   ═══════════════════════════════════════════════════════ */
const PLAYLISTS_JSON_URL = "https://raw.githubusercontent.com/marufhossainkeyas11/kslive/refs/heads/main/playlists.json";

let PLAYLISTS = [];

/* ═══════════════════════════════════════════════════════
   M3U PARSER
   Handles: #EXTINF, #EXTVLCOPT, cookies, user-agent,
   referrer, group-title, tvg-logo, tvg-id, tvg-name
   ═══════════════════════════════════════════════════════ */
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

      // Duration + attributes
      const afterDuration = line.replace(/^#EXTINF:\s*-?\d+(\.\d+)?/, '');

      // Extract attributes: key="value"
      const attrRx = /([\w-]+)="([^"]*)"/g;
      let m;
      while ((m = attrRx.exec(afterDuration)) !== null) {
        const k = m[1].toLowerCase();
        const v = m[2];
        if (k === 'group-title')       current.group = v || 'General';
        else if (k === 'tvg-logo')     current.logo  = v;
        else if (k === 'tvg-id')       current.tvgId = v;
        else if (k === 'tvg-name')     current.name  = v;
        else if (k === 'tvg-chno')     current.chno  = v;
        else if (k === 'user-agent')   current.userAgent = v;
        else if (k === 'referrer')     current.referrer  = v;
        else if (k === 'cookie' || k === 'http-cookie') current.cookies = v;
      }

      // Friendly display name (after last comma)
      const commaIdx = afterDuration.lastIndexOf(',');
      if (commaIdx !== -1) {
        const rawName = afterDuration.substring(commaIdx + 1).trim();
        if (rawName && !current.name) current.name = rawName;
      }
      if (!current.name) current.name = 'Unknown Channel';
      continue;
    }

    // VLC options (user-agent, cookie, referrer, etc.)
    if (line.startsWith('#EXTVLCOPT:') && current) {
      const opt = line.replace('#EXTVLCOPT:', '').trim();
      if (opt.startsWith('http-user-agent='))  current.userAgent = opt.split('=').slice(1).join('=');
      else if (opt.startsWith('http-referrer='))current.referrer = opt.split('=').slice(1).join('=');
      else if (opt.startsWith('http-cookie=')) current.cookies = opt.split('=').slice(1).join('=');
      continue;
    }

    // KODIPROP / other header directives
    if ((line.startsWith('#KODIPROP:') || line.startsWith('#EXTHTTP:')) && current) {
      const val = line.split(':').slice(1).join(':').trim();
      if (val.startsWith('inputstream.adaptive.stream_headers=')) {
        const hdrStr = val.split('=').slice(1).join('=');
        hdrStr.split('&').forEach(pair => {
          const [hk, hv] = pair.split('=');
          if (hk && hv) current.headers[decodeURIComponent(hk)] = decodeURIComponent(hv);
        });
      }
      if (val.startsWith('http-user-agent=')) current.userAgent = val.split('=').slice(1).join('=');
      continue;
    }

    // Stream URL
    if (current && !line.startsWith('#') && line.length > 0) {
      current.url = line;
      // Build combined headers object
      const hdrs = { ...current.headers };
      if (current.userAgent) hdrs['User-Agent'] = current.userAgent;
      if (current.referrer)  hdrs['Referer'] = current.referrer;
      if (current.cookies)   hdrs['Cookie']  = current.cookies;
      current.compiledHeaders = hdrs;
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
  playlists: [],          // [{name, channels[]}]
  activePlaylist: 0,
  channels: [],           // flat current playlist channels
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
const videoEl      = $('videoEl');
const channelList  = $('channelList');
const groupFilters = $('groupFilters');
const searchInput  = $('searchInput');
const playlistTabs = $('playlistTabs');
const npName       = $('npName');
const detailName   = $('detailName');
const detailLogo   = $('detailLogo');
const detailMeta   = $('detailMeta');
const streamUrlText= $('streamUrlText');
const emptyState   = $('emptyState');
const channelDetail= $('channelDetail');
const errorState   = $('errorState');
const bigPlay      = $('bigPlay');
const progressFill = $('progressFill');
const timeDisplay  = $('timeDisplay');
const qualityBadge = $('qualityBadge');
const connDot      = $('connDot');
const connStatus   = $('connStatus');
const chCount      = $('chCount');
const sidebar      = $('sidebar');
const loadingScreen= $('loadingScreen');
const toastEl      = $('toast');
const videoWrap = $('videoWrap');

/* ═══════════════════════════════════════════════════════
   TOAST
   ═══════════════════════════════════════════════════════ */
let toastTimer;
function showToast(msg, duration = 2500) {
  clearTimeout(toastTimer);
  toastEl.textContent = msg;
  toastEl.classList.add('show');
  toastTimer = setTimeout(() => toastEl.classList.remove('show'), duration);
}

/* ═══════════════════════════════════════════════════════
   FETCH M3U
   ═══════════════════════════════════════════════════════ */
async function fetchM3U(pl) {
  const { url, fetchHeaders } = pl;

  // Raw inline content (not a URL)
  if (!url.startsWith('http') && !url.startsWith('//')) {
    return url;
  }

  // Try direct fetch first
  try {
    const resp = await fetch(url, {
      headers: fetchHeaders || {},
      cache: 'no-cache'
    });
    if (resp.ok) return await resp.text();
  } catch (e) {
    console.warn('Direct fetch failed, trying CORS proxy…', e);
  }

  // Fallback: CORS proxy
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
   INIT
   ═══════════════════════════════════════════════════════ */
async function init() {
  try {
    const res = await fetch(PLAYLISTS_JSON_URL + '?t=' + Date.now());
    PLAYLISTS = await res.json();
  } catch (e) {
    console.error('Failed to load playlists config:', e);
    PLAYLISTS = [];
  }
  //$('loadText').textContent = `Loading ${PLAYLISTS.length} playlist(s)…`;

  const results = await Promise.allSettled(
    PLAYLISTS.map(async (pl, idx) => {
      const text = await fetchM3U(pl);
      const channels = parseM3U(text);
      return { name: pl.name, channels };
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
  
  // Restore last channel
  const last = loadLastChannel();
  if (last && state.playlists[last.plIdx]?.channels[last.chIdx]) {
    switchPlaylist(last.plIdx);
    setTimeout(() => {
      playChannel(last.chIdx);
      setTimeout(() => videoEl.play().catch(() => {}), 1000);
    }, 500);
  }
  checkMobile();
  setTimeout(() => loadingScreen.classList.add('hidden'), 600);
}

/* ═══════════════════════════════════════════════════════
   PLAYLIST TABS
   ═══════════════════════════════════════════════════════ */
function buildPlaylistTabs() {
  playlistTabs.innerHTML = '';
  state.playlists.forEach((pl, idx) => {
    const tab = document.createElement('button');
    tab.className = 'pl-tab' + (idx === 0 ? ' active' : '');
    tab.innerHTML = `<span class="dot"></span>${escHtml(pl.name)}
      <span style="font-family:var(--m);font-size:10px;opacity:0.6;margin-left:2px">(${pl.channels.length})</span>`;
    tab.addEventListener('click', () => switchPlaylist(idx));
    playlistTabs.appendChild(tab);
  });
}

function switchPlaylist(idx) {
  state.activePlaylist = idx;
  state.channels = state.playlists[idx]?.channels || [];
  state.currentIdx = -1;

  document.querySelectorAll('.pl-tab').forEach((t, i) => {
    t.classList.toggle('active', i === idx);
  });

  state.activeGroup = 'All';
  buildGroupFilters();
  applyFilter();
  updateChCount();
}

/* ═══════════════════════════════════════════════════════
   GROUP FILTERS
   ═══════════════════════════════════════════════════════ */
function buildGroupFilters() {
  const groups = ['All', ...new Set(state.channels.map(c => c.group))].sort((a,b) => {
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

/* ═══════════════════════════════════════════════════════
   FILTER + RENDER CHANNEL LIST
   ═══════════════════════════════════════════════════════ */
function applyFilter() {
  const q = searchInput.value.toLowerCase().trim();
  state.filteredChannels = state.channels.filter(ch => {
    const groupMatch = state.activeGroup === 'All' || ch.group === state.activeGroup;
    const nameMatch  = !q || ch.name.toLowerCase().includes(q) || (ch.group || '').toLowerCase().includes(q);
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

  Object.entries(grouped).sort(([a],[b]) => a.localeCompare(b)).forEach(([group, chs]) => {
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
        ? `<div class="ch-logo"><img src="${escAttr(ch.logo)}" alt="" onerror="this.parentNode.textContent='${escHtml(ch.name.substring(0,3))}'"></div>`
        : `<div class="ch-logo">${escHtml(ch.name.substring(0,3))}</div>`;

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

/* ═══════════════════════════════════════════════════════
   PLAYER
   ═══════════════════════════════════════════════════════ */
function playChannel(idx) {
  const ch = state.channels[idx];
  if (!ch) return;
  
  saveLastChannel(state.activePlaylist, idx);
  
  state.currentIdx = idx;
  state.retryCount = 0;
  errorState.classList.remove('show');

  // Update sidebar selection
  renderChannelList();

  // Update info panel
  if (window.innerWidth <= 768) {
    sidebar.classList.remove('mobile-open');
  }
  emptyState.style.display = 'none';
  channelDetail.style.display = 'block';
  npName.textContent = ch.name;
  detailName.textContent = ch.name;
  
  const npLogo = $('npLogo');
  if (ch.logo) {
    npLogo.src = ch.logo;
    npLogo.classList.add('show');
  } else {
    npLogo.src = '';
    npLogo.classList.remove('show');
  }

  // Logo
  detailLogo.innerHTML = ch.logo
    ? `<img src="${escAttr(ch.logo)}" alt="" onerror="this.parentNode.textContent='${escHtml(ch.name.substring(0,3))}'"><span style="display:none">${escHtml(ch.name.substring(0,3))}</span>`
    : escHtml(ch.name.substring(0,3));

  // Meta tags
  detailMeta.innerHTML = [
    ch.group && `<span class="meta-tag">${escHtml(ch.group)}</span>`,
    ch.tvgId && `<span class="meta-tag blue">${escHtml(ch.tvgId)}</span>`,
    Object.keys(ch.compiledHeaders||{}).length && `<span class="meta-tag">🔐 Headers</span>`,
  ].filter(Boolean).join('');

  //    URL
  //  streamUrlText.textContent = ch.url;
  //  streamUrlText.title = ch.url;

  loadStream(ch);
}

function loadStream(ch) {
  // Destroy previous HLS instance
  if (state.hls) {
    state.hls.destroy();
    state.hls = null;
  }
  videoEl.src = '';

  setStatus('Connecting…', 'yellow');
  qualityBadge.textContent = 'HLS';

  const url = ch.url;
  const hdrs = ch.compiledHeaders || {};

  // Detect stream type
  const isHLS = url.includes('.m3u8') || url.includes('playlist') || url.includes('hls');
  const isMPD = url.includes('.mpd');

  if (Hls.isSupported() && (isHLS || !videoEl.canPlayType('application/vnd.apple.mpegurl'))) {
    const hlsConfig = {
      // Pass headers if possible (note: browser CORS may block custom headers)
      xhrSetup: (xhr, streamUrl) => {
        if (hdrs['User-Agent'])  xhr.setRequestHeader('User-Agent', hdrs['User-Agent']);
        if (hdrs['Referer'])     xhr.setRequestHeader('Referer', hdrs['Referer']);
        // Cookie cannot be set via JS XHR (browser security), server-side proxy needed
      },
      enableWorker: true,
      lowLatencyMode: true,
      backBufferLength: 30,
      maxBufferLength: 60,
      maxMaxBufferLength: 120,
      capLevelToPlayerSize: true,
      startLevel: -1,   // Auto quality
    };

    const hls = new Hls(hlsConfig);
    state.hls = hls;

    hls.loadSource(url);
    hls.attachMedia(videoEl);

    hls.on(Hls.Events.MANIFEST_PARSED, (e, data) => {
      const levels = data.levels;
      qualityBadge.textContent = levels.length > 1 ? `AUTO · ${levels.length}Q` : 'HLS';
      videoEl.play().catch(() => {});
      setStatus('Playing', 'green');
      state.isPlaying = true;
      updatePlayPauseIcon();
    });

    hls.on(Hls.Events.LEVEL_SWITCHED, (e, data) => {
      const lv = hls.levels[data.level];
      if (lv) {
        const h = lv.height || '';
        qualityBadge.textContent = h ? `${h}p` : 'HLS';
      }
    });

    hls.on(Hls.Events.ERROR, (e, data) => {
      console.error('HLS error:', data.type, data.details, data.fatal);
      if (data.fatal) {
        if (data.type === Hls.ErrorTypes.NETWORK_ERROR) {
          if (state.retryCount < state.MAX_RETRY) {
            state.retryCount++;
            setStatus(`Reconnecting (${state.retryCount}/${state.MAX_RETRY})…`, 'yellow');
            setTimeout(() => hls.startLoad(), 2000);
          } else {
            showError('Network error. Stream may be offline or CORS-blocked.');
          }
        } else if (data.type === Hls.ErrorTypes.MEDIA_ERROR) {
          setStatus('Recovering media…', 'yellow');
          hls.recoverMediaError();
        } else {
          showError('Fatal stream error. Try another channel.');
        }
      }
    });

  } else if (videoEl.canPlayType('application/vnd.apple.mpegurl')) {
    // Native HLS (Safari)
    videoEl.src = url;
    videoEl.play().catch(() => {});
    qualityBadge.textContent = 'Native HLS';
    setStatus('Playing', 'green');
    state.isPlaying = true;
    updatePlayPauseIcon();
  } else {
    // Direct stream (MP4, RTMP wrapped, etc.)
    videoEl.src = url;
    videoEl.play().catch(() => {});
    qualityBadge.textContent = 'Direct';
    setStatus('Playing', 'green');
    state.isPlaying = true;
    updatePlayPauseIcon();
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
  connDot.style.background = color === 'green' ? 'var(--grn)' :
    color === 'red' ? 'var(--red)' :
    color === 'yellow' ? 'var(--ylw)' :
    'var(--t3)';
  connDot.style.boxShadow = color === 'green' ? '0 0 6px var(--grn)' : 'none';
  const liveBadge = document.querySelector('.live-badge');
  if (color === 'green' && text === 'Playing') {
    liveBadge.classList.add('visible');
  } else {
    liveBadge.classList.remove('visible');
  }
}

/* ═══════════════════════════════════════════════════════
   PLAYBACK CONTROLS
   ═══════════════════════════════════════════════════════ */
$('playPauseBtn').addEventListener('click', () => {
  togglePlayPause();
  clearTimeout(hideTimer);
  hideTimer = setTimeout(() => {
    if (morePopup.classList.contains('open')) return;
    videoWrap.classList.remove('controls-visible');
  }, 3000);
});

let tapTimer = null;
let tapCount = 0;

videoWrap.addEventListener('click', (e) => {
  if (state.currentIdx === -1) return;
  // শুধু interactive element গুলো ignore
  if (e.target.closest('.ctrl-btn')) return;
  if (e.target.closest('input[type="range"]')) return;
  if (e.target.closest('.progress-bar-wrap')) return;
  if (e.target.closest('.more-popup')) return;

  tapCount++;

  if (tapCount === 1) {
    tapTimer = setTimeout(() => {
      tapCount = 0;
      // single tap: toggle controls
      if (videoWrap.classList.contains('controls-visible')) {
        videoWrap.classList.remove('controls-visible');
        clearTimeout(hideTimer);
      } else {
        videoWrap.classList.add('controls-visible');
        clearTimeout(hideTimer);
        hideTimer = setTimeout(() => {
          if (morePopup.classList.contains('open')) return;
          videoWrap.classList.remove('controls-visible');
        }, 3000);
      }
    }, 250);

  } else if (tapCount === 2) {
    clearTimeout(tapTimer);
    tapCount = 0;
    // double tap: play/pause
    togglePlayPause();
    $('bigPlayIcon').querySelector('path').setAttribute('d',
      state.isPlaying ? 'M5.5 3.5A1.5 1.5 0 0 1 7 5v6a1.5 1.5 0 0 1-3 0V5a1.5 1.5 0 0 1 1.5-1.5m5 0A1.5 1.5 0 0 1 12 5v6a1.5 1.5 0 0 1-3 0V5a1.5 1.5 0 0 1 1.5-1.5' : 'm11.596 8.697-6.363 3.692c-.54.313-1.233-.066-1.233-.697V4.308c0-.63.692-1.01 1.233-.696l6.363 3.692a.802.802 0 0 1 0 1.393');
    bigPlay.classList.add('show');
    setTimeout(() => bigPlay.classList.remove('show'), 700);
    videoWrap.classList.add('controls-visible');
    clearTimeout(hideTimer);
    hideTimer = setTimeout(() => {
      if (morePopup.classList.contains('open')) return;
      videoWrap.classList.remove('controls-visible');
    }, 3000);
  }
});

function togglePlayPause() {
  if (videoEl.paused) {
    videoEl.play();
    state.isPlaying = true;
  } else {
    videoEl.pause();
    state.isPlaying = false;
  }
  updatePlayPauseIcon();
}

function updatePlayPauseIcon() {
  const icon = $('ppIcon');
  if (state.isPlaying) {
    icon.setAttribute('d', 'M5.5 3.5A1.5 1.5 0 0 1 7 5v6a1.5 1.5 0 0 1-3 0V5a1.5 1.5 0 0 1 1.5-1.5m5 0A1.5 1.5 0 0 1 12 5v6a1.5 1.5 0 0 1-3 0V5a1.5 1.5 0 0 1 1.5-1.5');
  } else {
    icon.setAttribute('d', 'm11.596 8.697-6.363 3.692c-.54.313-1.233-.066-1.233-.697V4.308c0-.63.692-1.01 1.233-.696l6.363 3.692a.802.802 0 0 1 0 1.393');
  }
}

/* ═══════════════════════════════
   VOLUME — single source of truth
   ═══════════════════════════════ */
function setVolume(vol, muted) {
  // Clamp
  vol = Math.max(0, Math.min(1, vol));
  
  videoEl.volume = vol;
  videoEl.muted = muted;
  state.isMuted = muted;
  
  // Sliders
  const displayVal = muted ? 0 : vol;
  $('volSlider').value = displayVal;
  $('volSliderMobile').value = displayVal;
  
  // Icons (both volIcon + volIcon2)
  const mutedPath = 'M6.717 3.55A.5.5 0 0 1 7 4v8a.5.5 0 0 1-.812.39L3.825 10.5H1.5A.5.5 0 0 1 1 10V6a.5.5 0 0 1 .5-.5h2.325l2.363-1.89a.5.5 0 0 1 .529-.06m7.137 2.096a.5.5 0 0 1 0 .708L12.207 8l1.647 1.646a.5.5 0 0 1-.708.708L11.5 8.707l-1.646 1.647a.5.5 0 0 1-.708-.708L10.793 8 9.146 6.354a.5.5 0 1 1 .708-.708L11.5 7.293l1.646-1.647a.5.5 0 0 1 .708 0';
  const unmutedPath = 'M9 4a.5.5 0 0 0-.812-.39L5.825 5.5H3.5A.5.5 0 0 0 3 6v4a.5.5 0 0 0 .5.5h2.325l2.363 1.89A.5.5 0 0 0 9 12zm3.025 4a4.5 4.5 0 0 1-1.318 3.182L10 10.475A3.5 3.5 0 0 0 11.025 8 3.5 3.5 0 0 0 10 5.525l.707-.707A4.5 4.5 0 0 1 12.025 8';
  const d = (muted || vol === 0) ? mutedPath : unmutedPath;
  $('volIcon').setAttribute('d', d);
  //$('volIcon2').setAttribute('d', d);
}

// Mute toggle: volume মনে রাখে
let lastVol = 1;
$('muteBtn').addEventListener('click', () => {
  if (state.isMuted || videoEl.volume === 0) {
    // Unmute — আগের volume restore
    setVolume(lastVol || 1, false);
  } else {
    lastVol = videoEl.volume;
    setVolume(videoEl.volume, true);
  }
});

// Desktop slider
$('volSlider').addEventListener('input', e => {
  const v = parseFloat(e.target.value);
  if (v > 0) lastVol = v;
  setVolume(v, v === 0);
});

// Mobile slider
$('volSliderMobile').addEventListener('input', e => {
  const v = parseFloat(e.target.value);
  if (v > 0) lastVol = v;
  setVolume(v, v === 0);
});

function updateVolIcon() {
  const icon = $('volIcon');
  if (state.isMuted || videoEl.volume === 0) {
    icon.setAttribute('d', 'M6.717 3.55A.5.5 0 0 1 7 4v8a.5.5 0 0 1-.812.39L3.825 10.5H1.5A.5.5 0 0 1 1 10V6a.5.5 0 0 1 .5-.5h2.325l2.363-1.89a.5.5 0 0 1 .529-.06m7.137 2.096a.5.5 0 0 1 0 .708L12.207 8l1.647 1.646a.5.5 0 0 1-.708.708L11.5 8.707l-1.646 1.647a.5.5 0 0 1-.708-.708L10.793 8 9.146 6.354a.5.5 0 1 1 .708-.708L11.5 7.293l1.646-1.647a.5.5 0 0 1 .708 0');
  } else {
    icon.setAttribute('d', 'M9 4a.5.5 0 0 0-.812-.39L5.825 5.5H3.5A.5.5 0 0 0 3 6v4a.5.5 0 0 0 .5.5h2.325l2.363 1.89A.5.5 0 0 0 9 12zm3.025 4a4.5 4.5 0 0 1-1.318 3.182L10 10.475A3.5 3.5 0 0 0 11.025 8 3.5 3.5 0 0 0 10 5.525l.707-.707A4.5 4.5 0 0 1 12.025 8');
  }
}

// Prev / Next
$('prevBtn').addEventListener('click', () => navigateChannel(-1));
$('nextBtn').addEventListener('click', () => navigateChannel(1));

function navigateChannel(dir) {
  if (state.channels.length === 0) return;
  let next = state.currentIdx + dir;
  if (next < 0) next = state.channels.length - 1;
  if (next >= state.channels.length) next = 0;
  playChannel(next);
}

// Progress bar (for VOD, not live)
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
  const pct = (e.clientX - rect.left) / rect.width;
  videoEl.currentTime = pct * videoEl.duration;
});

function fmtTime(s) {
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = Math.floor(s % 60);
  return h > 0 ? `${h}:${pad(m)}:${pad(sec)}` : `${pad(m)}:${pad(sec)}`;
}
function pad(n) { return String(n).padStart(2,'0'); }

// Video events
videoEl.addEventListener('playing', () => {
  state.isPlaying = true;
  updatePlayPauseIcon();
  setStatus('Playing', 'green');
  $('bufferSpinner').style.display = 'none'; /* ← এটা যোগ করো */
});
videoEl.addEventListener('waiting', () => {
  setStatus('Buffering…', 'yellow');
  $('bufferSpinner').style.display = 'block';
});
videoEl.addEventListener('playing', () => {
  $('bufferSpinner').style.display = 'none';
});
videoEl.addEventListener('canplay', () => {
  $('bufferSpinner').style.display = 'none';
});
videoEl.addEventListener('pause',   () => { state.isPlaying = false; updatePlayPauseIcon(); setStatus('Paused', 'yellow'); });
videoEl.addEventListener('waiting', () => setStatus('Buffering…', 'yellow'));
videoEl.addEventListener('error',   () => {
  if (state.currentIdx !== -1) {
    if (state.retryCount < state.MAX_RETRY) {
      state.retryCount++;
      setStatus(`Retry ${state.retryCount}/${state.MAX_RETRY}…`, 'yellow');
      setTimeout(() => loadStream(state.channels[state.currentIdx]), 3000);
    } else {
      showError('Unable to load stream. Check the URL or try another channel.');
    }
  }
});

// More menu toggle
const moreBtn = $('moreBtn');
const morePopup = $('morePopup');
moreBtn.addEventListener('click', (e) => {
  e.stopPropagation();
  morePopup.classList.toggle('open');
  hideTimer = setTimeout(() => {
    if (morePopup.classList.contains('open')) return;
    videoWrap.classList.remove('controls-visible');
  }, 3000);
});
document.addEventListener('click', (e) => {
  morePopup.classList.remove('open');
  if (!videoWrap.contains(e.target)) videoWrap.classList.remove('controls-visible');
});
morePopup.addEventListener('click', e => e.stopPropagation());

// PiP action (shared)
async function togglePiP() {
  try {
    if (document.pictureInPictureElement) {
      await document.exitPictureInPicture();
      return;
    }
    // Fullscreen থাকলে আগে exit করো
    if (document.fullscreenElement || document.webkitFullscreenElement) {
      await (document.exitFullscreen || document.webkitExitFullscreen).call(document);
      // Exit animate হতে একটু সময় লাগে
      await new Promise(r => setTimeout(r, 150));
    }
    await videoEl.requestPictureInPicture();
  } catch (e) {
    showToast('PiP not supported on this device');
  }
}

$('pipBtn').addEventListener('click', togglePiP);
$('pipRow').addEventListener('click', () => { morePopup.classList.remove('open'); togglePiP(); });

document.addEventListener('enterpictureinpicture', () => $('pipBtn').classList.add('active'));
document.addEventListener('leavepictureinpicture', () => $('pipBtn').classList.remove('active'));

// Layout sync: vol outside (>600px) = pipBtn + no menu
//              vol inside  (≤600px) = moreBtn + pipRow
function syncControlLayout() {
  const isMobile = window.innerWidth <= 450;
  // volume slider
  $('volSlider').style.display        = isMobile ? 'none' : '';
  // pip
  $('pipBtn').style.display           = isMobile ? 'none' : (document.pictureInPictureEnabled ? '' : 'none');
  // more button & pip row
  $('moreBtn').style.display          = isMobile ? '' : 'none';
  $('pipRow').style.display           = isMobile && document.pictureInPictureEnabled ? 'flex' : 'none';
}
syncControlLayout();
window.addEventListener('resize', syncControlLayout);

// Fullscreen
$('fullscreenBtn').addEventListener('click', () => {
  if (!document.fullscreenElement) {
    ($('videoWrap').requestFullscreen ||
      $('videoWrap').webkitRequestFullscreen ||
      $('videoWrap').mozRequestFullScreen ||
      (() => {})).call($('videoWrap'));
  } else {
    (document.exitFullscreen ||
      document.webkitExitFullscreen ||
      document.mozCancelFullScreen ||
      (() => {})).call(document);
  }
});

// Lock to landscape on mobile fullscreen
document.addEventListener('fullscreenchange', () => {
  if (document.fullscreenElement) {
    screen.orientation?.lock?.('landscape').catch(() => {});
  } else {
    screen.orientation?.unlock?.();
  }
});

// Controls visibility (auto-hide)
let hideTimer;
  
// Desktop এ mousemove এ show
videoWrap.addEventListener('mousemove', () => {
  if (window.matchMedia('(pointer: coarse)').matches) return;
  videoWrap.classList.add('controls-visible');
  clearTimeout(hideTimer);
  hideTimer = setTimeout(() => {
    if (morePopup.classList.contains('open')) return;
    videoWrap.classList.remove('controls-visible');
  }, 3000);
});

// Retry button
$('retryBtn').addEventListener('click', () => {
  if (state.currentIdx !== -1) {
    state.retryCount = 0;
    errorState.classList.remove('show');
    loadStream(state.channels[state.currentIdx]);
  }
});

// Copy URL
/*
$('copyUrlBtn').addEventListener('click', () => {
  if (state.currentIdx !== -1) {
    navigator.clipboard.writeText(state.channels[state.currentIdx].url)
      .then(() => showToast('URL copied to clipboard!'))
      .catch(() => showToast('Copy failed — see console'));
  }
});
*/

// Search
searchInput.addEventListener('input', () => applyFilter());

// Sidebar toggle
let sidebarOpen = true;
$('sidebarToggle').addEventListener('click', () => {
  if (window.innerWidth <= 768) {
    sidebar.classList.toggle('mobile-open');
  } else {
    sidebarOpen = !sidebarOpen;
    sidebar.classList.toggle('collapsed', !sidebarOpen);
    $('sidebarToggle').classList.toggle('active', !sidebarOpen);
  }
});

// Mobile sidebar
const mobileSidebarBtn = $('mobileSidebarBtn');
mobileSidebarBtn.addEventListener('click', () => {
  if (state.playlists.length <= 1) return;
  showPlaylistPopup();
});

function showPlaylistPopup() {
  const existing = document.getElementById('plPopup');
  const existingBd = document.getElementById('plBackdrop');
  if (existing) { existing.remove(); existingBd?.remove(); return; }

  const backdrop = document.createElement('div');
  backdrop.id = 'plBackdrop';
  backdrop.style.cssText = `
    position:fixed;inset:0;z-index:199;background:rgba(0,0,0,0.5);
  `;

  const popup = document.createElement('div');
  popup.id = 'plPopup';
  popup.style.cssText = `
    position:fixed; bottom:0; left:0; right:0; z-index:200;
    background:var(--bg2); border-top:1px solid var(--bdr);
    border-radius:16px 16px 0 0;
    padding:12px 0 24px;
    box-shadow:0 -8px 32px rgba(0,0,0,0.4);
    animation: slideUp 0.25s ease;
  `;

  function closePopup() {
    popup.remove();
    backdrop.remove();
  }

  backdrop.addEventListener('click', closePopup);

  const title = document.createElement('div');
  title.style.cssText = `
    font-size:12px; font-weight:700; letter-spacing:1.5px;
    text-transform:uppercase; color:var(--t3);
    padding:4px 20px 12px; font-family:var(--m);
    border-bottom:1px solid var(--bdr); margin-bottom:8px;
  `;
  title.textContent = 'SELECT PLAYLIST';
  popup.appendChild(title);

  state.playlists.forEach((pl, idx) => {
    const row = document.createElement('div');
    row.style.cssText = `
      display:flex; align-items:center; gap:12px;
      padding:12px 20px; cursor:pointer;
      transition:background 0.15s;
      background:${idx === state.activePlaylist ? 'rgba(21,101,192,0.15)' : 'transparent'};
    `;
    row.innerHTML = `
      <div style="width:8px;height:8px;border-radius:50%;
        background:${idx === state.activePlaylist ? 'var(--blue3)' : 'var(--t3)'};
        flex-shrink:0"></div>
      <div style="flex:1">
        <div style="font-size:14px;font-weight:500;color:var(--text)">${escHtml(pl.name)}</div>
        <div style="font-size:11px;color:var(--t2);font-family:var(--m)">${pl.channels.length} channels</div>
      </div>
      ${idx === state.activePlaylist ? '<div style="font-size:16px">✓</div>' : ''}
    `;
    row.addEventListener('click', () => {
      switchPlaylist(idx);
      closePopup();
      updateMobilePlaylistBtn();
      if (window.innerWidth <= 768)  sidebar.classList.add('mobile-open');
    });
    popup.appendChild(row);
  });

  document.body.appendChild(backdrop);
  document.body.appendChild(popup);
}

function updateMobilePlaylistBtn() {
  if (state.playlists.length <= 1) {
    mobileSidebarBtn.style.display = 'none';
    return;
  }
  mobileSidebarBtn.style.display = 'flex';
}

// Theme toggle
$('themeToggle').addEventListener('click', () => {
  const html = document.documentElement;
  const isDark = html.getAttribute('data-theme') === 'dark';
  const next = isDark ? 'light' : 'dark';
  html.setAttribute('data-theme', next);
  localStorage.setItem('ks_theme', next);
});

// Keyboard shortcuts
document.addEventListener('keydown', e => {
  if (e.target.tagName === 'INPUT') return;
  if (e.code === 'Space')         { e.preventDefault(); togglePlayPause(); }
  if (e.code === 'ArrowRight')    navigateChannel(1);
  if (e.code === 'ArrowLeft')     navigateChannel(-1);
  if (e.code === 'ArrowUp')       { const v = Math.min(1, videoEl.volume + 0.1); setVolume(v, false); }
  if (e.code === 'ArrowDown')     { const v = Math.max(0, videoEl.volume - 0.1); setVolume(v, v === 0); }  if (e.code === 'KeyF')          $('fullscreenBtn').click();
  if (e.code === 'KeyM')          $('muteBtn').click();
});

// Mobile detection
function checkMobile() {
  const isMobile = window.innerWidth <= 768;
  if (isMobile) {
    sidebar.classList.remove('collapsed');
    updateMobilePlaylistBtn();
  } else {
    mobileSidebarBtn.style.display = 'none';
  }
}
// Hide fullscreen btn if not supported
if (!document.documentElement.requestFullscreen) {
  $('fullscreenBtn').style.display = 'none';
}
window.addEventListener('resize', checkMobile);
checkMobile();

/* ── LONG PRESS 1.5x SPEED ─────────── */
(function () {
  const LONG_PRESS_MS = 500;
  const FAST_SPEED    = 1.5;
  const speedEl       = $('speedIndicator');

  let pressTimer  = null;
  let isFast      = false;
  let normalSpeed = 1;

  function startFast() {
    if (state.currentIdx === -1 || isFast) return;
    if (videoEl.paused || videoEl.readyState < 2) return;
    isFast      = true;
    normalSpeed = videoEl.playbackRate || 1;
    videoEl.playbackRate = FAST_SPEED;

    // controls hide
    videoWrap.classList.remove('controls-visible');
    clearTimeout(hideTimer);

    // indicator show
    speedEl.classList.add('show');
  }

  function stopFast() {
    if (!isFast) return;
    isFast = false;
    videoEl.playbackRate = normalSpeed;
    speedEl.classList.remove('show');
  }

  function cancelPress() {
    clearTimeout(pressTimer);
    pressTimer = null;
  }

  // ── Touch ──
  videoWrap.addEventListener('touchstart', e => {
    if (e.touches.length !== 1) return;
    cancelPress();
    pressTimer = setTimeout(startFast, LONG_PRESS_MS);
  }, { passive: true });

  videoWrap.addEventListener('touchend',    () => { cancelPress(); stopFast(); });
  videoWrap.addEventListener('touchcancel', () => { cancelPress(); stopFast(); });
  videoWrap.addEventListener('touchmove',   () => { cancelPress(); stopFast(); });

  // ── Mouse (desktop) ──
  videoWrap.addEventListener('mousedown', e => {
    if (e.button !== 0) return;
    cancelPress();
    pressTimer = setTimeout(startFast, LONG_PRESS_MS);
  });

  window.addEventListener('mouseup',   () => { cancelPress(); stopFast(); });
  videoWrap.addEventListener('mouseleave', () => { cancelPress(); stopFast(); });
})();

// Close sidebar on mobile after channel selection
const origPlay = playChannel;
function playChannelWithClose(idx) {
  origPlay(idx);
  if (window.innerWidth <= 768) {
    sidebar.classList.remove('mobile-open');
  }
}

/* ── Utils ── */
function escHtml(str) {
  return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
function escAttr(str) {
  return String(str).replace(/"/g,'&quot;').replace(/'/g,'&#39;');
}

// Persist last played
function saveLastChannel(plIdx, chIdx) {
  try { localStorage.setItem('sv_last', JSON.stringify({plIdx, chIdx})); } catch{}
}
function loadLastChannel() {
  try { return JSON.parse(localStorage.getItem('sv_last')); } catch{ return null; }
}

// Detect OS theme on first load
const savedTheme = localStorage.getItem('ks_theme');
const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
document.documentElement.setAttribute('data-theme', savedTheme || (prefersDark ? 'dark' : 'light'));

/* ── BOOT ── */
init();
