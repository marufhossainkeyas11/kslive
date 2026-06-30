/* ═══════════════════════════════════════════════════════
   CONTROLS — PLAY/PAUSE + NAVIGATION
   ═══════════════════════════════════════════════════════ */
function togglePlayPause() {
  if (videoEl.paused) {
    videoEl.play().then(() => {
      state.isPlaying = true;
      updatePlayPauseIcon();
    }).catch(() => {});
  } else {
    videoEl.pause();
    state.isPlaying = false;
    updatePlayPauseIcon();
  }
}

function updatePlayPauseIcon() {
  const PAUSE_D = 'M5.5 3.5A1.5 1.5 0 0 1 7 5v6a1.5 1.5 0 0 1-3 0V5a1.5 1.5 0 0 1 1.5-1.5m5 0A1.5 1.5 0 0 1 12 5v6a1.5 1.5 0 0 1-3 0V5a1.5 1.5 0 0 1 1.5-1.5';
  const PLAY_D = 'm11.596 8.697-6.363 3.692c-.54.313-1.233-.066-1.233-.697V4.308c0-.63.692-1.01 1.233-.696l6.363 3.692a.802.802 0 0 1 0 1.393';
  $('ppIcon').setAttribute('d', state.isPlaying ? PAUSE_D : PLAY_D);
  $('bpIcon').setAttribute('d', state.isPlaying ? PAUSE_D : PLAY_D);
  bigPlay.classList.add('show');
  setTimeout(() => {if(state.isPlaying) bigPlay.classList.remove('show');}, 700);
}

function navigateChannel(dir) {
  if (state.channels.length === 0) return;
  let next = state.currentIdx + dir;
  if (next < 0) next = state.channels.length - 1;
  if (next >= state.channels.length) next = 0;
  playChannel(next);
}

$('playPauseBtn').addEventListener('click', () => {
  togglePlayPause();
  clearTimeout(hideTimer);
  hideTimer = setTimeout(() => {
    if (morePopup.classList.contains('open')) return;
    videoWrap.classList.remove('controls-visible');
  }, 3000);
});
$('prevBtn').addEventListener('click', () => navigateChannel(-1));
$('nextBtn').addEventListener('click', () => navigateChannel(1));


/* ═══════════════════════════════════════════════════════
   CONTROLS — VOLUME + BOOST (Web Audio API)
   ═══════════════════════════════════════════════════════ */
let lastVol = 1;

// Web Audio setup
let audioCtx = null;
let gainNode = null;
let sourceConnected = false;

function ensureAudioCtx() {
  if (audioCtx) return;
  audioCtx = new(window.AudioContext || window.webkitAudioContext)();
  gainNode = audioCtx.createGain();
  gainNode.connect(audioCtx.destination);
}

function connectSource() {
  if (sourceConnected || !audioCtx) return;
  try {
    const src = audioCtx.createMediaElementSource(videoEl);
    src.connect(gainNode);
    sourceConnected = true;
  } catch (e) {}
}

// vol: 0–1 for video element (0%–100%)
// boost: 1.0–1.3 from GainNode (100%–130%)
// slider range: 0–130 (integer steps)

function sliderToGain(sliderVal) {
  if (sliderVal <= 100) {
    return { vol: sliderVal / 100, gain: 1 };
  } else {
    return { vol: 1, gain: 1 + ((sliderVal - 100)/10 ) };
  }
}

function updateSliderTrack(slider, val) {
  const boostStart = 100 / 130 * 100;
  const pct = (val / 130) * 100;
  
  if (val <= 100) {
    slider.style.background = `linear-gradient(to right,
      var(--blue3) 0%,
      var(--blue3) ${pct}%,
      rgba(255,255,255,0.18) ${pct}%,
      rgba(255,255,255,0.18) 100%)`;
    slider.style.setProperty('--thumb-color', 'var(--blue3)'); // ← add
  } else {
    const redPct = pct;
    slider.style.background = `linear-gradient(to right,
      var(--blue3) 0%,
      var(--blue3) ${boostStart}%,
      var(--red2) ${boostStart}%,
      var(--red2) ${redPct}%,
      rgba(255,255,255,0.18) ${redPct}%,
      rgba(255,255,255,0.18) 100%)`;
    slider.style.setProperty('--thumb-color', 'var(--red2)'); // ← add
  }
}


function setVolume(vol, muted, sliderVal) {
  // vol: 0–1 for videoEl
  // sliderVal: 0–130 (optional, for sync)
  vol = Math.max(0, Math.min(1, vol));
  videoEl.volume = vol;
  videoEl.muted = muted;
  state.isMuted = muted;
  
  const sv = sliderVal !== undefined ? sliderVal : Math.round(vol * 100);
  const displayVal = muted ? 0 : sv;
  
  $('volSlider').value = displayVal;
  $('volSliderMobile').value = displayVal;
  updateSliderTrack($('volSlider'), displayVal);
  updateSliderTrack($('volSliderMobile'), displayVal);
  
  // GainNode
  if (gainNode) {
    const g = muted ? 0 : (sv > 100 ? sv / 100 : 1);
    gainNode.gain.value = g;
  }
  
  const MUTED_D = 'M6.717 3.55A.5.5 0 0 1 7 4v8a.5.5 0 0 1-.812.39L3.825 10.5H1.5A.5.5 0 0 1 1 10V6a.5.5 0 0 1 .5-.5h2.325l2.363-1.89a.5.5 0 0 1 .529-.06m7.137 2.096a.5.5 0 0 1 0 .708L12.207 8l1.647 1.646a.5.5 0 0 1-.708.708L11.5 8.707l-1.646 1.647a.5.5 0 0 1-.708-.708L10.793 8 9.146 6.354a.5.5 0 1 1 .708-.708L11.5 7.293l1.646-1.647a.5.5 0 0 1 .708 0';
  const UNMUTED_D = 'M9 4a.5.5 0 0 0-.812-.39L5.825 5.5H3.5A.5.5 0 0 0 3 6v4a.5.5 0 0 0 .5.5h2.325l2.363 1.89A.5.5 0 0 0 9 12zm3.025 4a4.5 4.5 0 0 1-1.318 3.182L10 10.475A3.5 3.5 0 0 0 11.025 8 3.5 3.5 0 0 0 10 5.525l.707-.707A4.5 4.5 0 0 1 12.025 8';
  $('volIcon').setAttribute('d', (muted || vol === 0) ? MUTED_D : UNMUTED_D);
  if ($('volIcon2')) $('volIcon2').setAttribute('d', (muted || vol === 0) ? MUTED_D : UNMUTED_D);
}

$('muteBtn').addEventListener('click', () => {
  ensureAudioCtx();
  connectSource();
  if (state.isMuted || videoEl.volume === 0) {
    setVolume(lastVol > 1 ? 1 : lastVol, false, Math.round(lastVol <= 1 ? lastVol * 100 : lastVol * 100));
  } else {
    lastVol = parseFloat($('volSlider').value) / 100;
    setVolume(videoEl.volume, true, parseFloat($('volSlider').value));
  }
});

function handleVolSlider(e) {
  ensureAudioCtx();
  connectSource();
  if (audioCtx.state === 'suspended') audioCtx.resume();
  
  const sv = parseFloat(e.target.value); // 0–130
  const { vol, gain } = sliderToGain(sv);
  
  if (sv > 0) lastVol = sv / 100;
  videoEl.volume = vol;
  videoEl.muted = false;
  state.isMuted = false;
  
  if (gainNode) {
    gainNode.gain.setTargetAtTime(gain, audioCtx.currentTime, 0.01);
  }
  
  $('volSlider').value = sv;
  $('volSliderMobile').value = sv;
  updateSliderTrack($('volSlider'), sv);
  updateSliderTrack($('volSliderMobile'), sv);
  
  const MUTED_D = 'M6.717 3.55A.5.5 0 0 1 7 4v8a.5.5 0 0 1-.812.39L3.825 10.5H1.5A.5.5 0 0 1 1 10V6a.5.5 0 0 1 .5-.5h2.325l2.363-1.89a.5.5 0 0 1 .529-.06m7.137 2.096a.5.5 0 0 1 0 .708L12.207 8l1.647 1.646a.5.5 0 0 1-.708.708L11.5 8.707l-1.646 1.647a.5.5 0 0 1-.708-.708L10.793 8 9.146 6.354a.5.5 0 1 1 .708-.708L11.5 7.293l1.646-1.647a.5.5 0 0 1 .708 0';
  const UNMUTED_D = 'M9 4a.5.5 0 0 0-.812-.39L5.825 5.5H3.5A.5.5 0 0 0 3 6v4a.5.5 0 0 0 .5.5h2.325l2.363 1.89A.5.5 0 0 0 9 12zm3.025 4a4.5 4.5 0 0 1-1.318 3.182L10 10.475A3.5 3.5 0 0 0 11.025 8 3.5 3.5 0 0 0 10 5.525l.707-.707A4.5 4.5 0 0 1 12.025 8';
  $('volIcon').setAttribute('d', sv === 0 ? MUTED_D : UNMUTED_D);
  if ($('volIcon2')) $('volIcon2').setAttribute('d', sv === 0 ? MUTED_D : UNMUTED_D);
}

$('volSlider').addEventListener('input', handleVolSlider);
$('volSliderMobile').addEventListener('input', handleVolSlider);

// AudioContext resume on first play
videoEl.addEventListener('play', () => {
  if (audioCtx && audioCtx.state === 'suspended') audioCtx.resume();
  ensureAudioCtx();
  connectSource();
}, { once: false });
// Initial track render
updateSliderTrack($('volSlider'), 100);
updateSliderTrack($('volSliderMobile'), 100);


/* ═══════════════════════════════════════════════════════
   CONTROLS — FULLSCREEN + PiP
   ═══════════════════════════════════════════════════════ */
$('fullscreenBtn').addEventListener('click', () => {
  if (!document.fullscreenElement) {
    ($('videoWrap').requestFullscreen || $('videoWrap').webkitRequestFullscreen || $('videoWrap').mozRequestFullScreen || (() => {})).call($('videoWrap'));
  } else {
    (document.exitFullscreen || document.webkitExitFullscreen || document.mozCancelFullScreen || (() => {})).call(document);
  }
});

document.addEventListener('fullscreenchange', () => {
  if (document.fullscreenElement) screen.orientation?.lock?.('landscape').catch(() => {});
  else screen.orientation?.unlock?.();
});

async function togglePiP() {
  try {
    if (document.pictureInPictureElement) { await document.exitPictureInPicture(); return; }
    if (document.fullscreenElement || document.webkitFullscreenElement) {
      await (document.exitFullscreen || document.webkitExitFullscreen).call(document);
      await new Promise(r => setTimeout(r, 150));
    }
    await videoEl.requestPictureInPicture();
  } catch (e) {
    showToast('PiP not supported on this device');
  }
}

$('pipBtn').addEventListener('click', togglePiP);
$('pipRow').addEventListener('click', () => { morePopup.classList.remove('open');
  togglePiP(); });
document.addEventListener('enterpictureinpicture', () => $('pipBtn').classList.add('active'));
document.addEventListener('leavepictureinpicture', () => $('pipBtn').classList.remove('active'));

if (!document.documentElement.requestFullscreen) $('fullscreenBtn').style.display = 'none';


/* ═══════════════════════════════════════════════════════
   CONTROLS — VIDEO WRAP TAP / CLICK + AUTO-HIDE
   ═══════════════════════════════════════════════════════ */
let hideTimer;
let tapTimer = null;
let tapCount = 0;

function startHideTimer() {
  clearTimeout(hideTimer);
  hideTimer = setTimeout(() => {
    if (morePopup.classList.contains('open')) return;
    videoWrap.classList.remove('controls-visible');
  }, 3000);
}

videoWrap.addEventListener('click', (e) => {
  // if (state.currentIdx === -1) return;
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
        startHideTimer();
      }
    }, 250);
  } else if (tapCount === 2) {
    clearTimeout(tapTimer);
    tapCount = 0;
    togglePlayPause();
    videoWrap.classList.add('controls-visible');
    startHideTimer();
  }
});

// Desktop hover — controls show
videoWrap.addEventListener('mousemove', () => {
  if (window.matchMedia('(pointer: coarse)').matches) return;
  videoWrap.classList.add('controls-visible');
  startHideTimer();
});


/* ═══════════════════════════════════════════════════════
   CONTROLS — MORE MENU
   ═══════════════════════════════════════════════════════ */
$('moreBtn').addEventListener('click', (e) => {
  e.stopPropagation();
  morePopup.classList.toggle('open');
  startHideTimer();
});
document.addEventListener('click', (e) => {
  morePopup.classList.remove('open');
  if (!videoWrap.contains(e.target)) videoWrap.classList.remove('controls-visible');
});
morePopup.addEventListener('click', e => e.stopPropagation());


/* ═══════════════════════════════════════════════════════
   CONTROLS — LAYOUT SYNC (mobile vs desktop)
   ═══════════════════════════════════════════════════════ */
function syncControlLayout() {
  const isMobile = window.innerWidth <= 450; // volume → popup এ যায়
  const isTiny = window.innerWidth <= 345; // fullscreen → popup এ যায়
  const isCcTiny = window.innerWidth <= 490; // CC + PiP → একসাথে popup এ যায়
  
  // --- Volume: বাইরে hide হলে popup row হিসেবে দেখাবে ---
  const volSlider = $('volSlider');
  const volRow = $('moreVolRow');
  if (volSlider) volSlider.style.display = isMobile ? 'none' : '';
  if (volRow) volRow.style.display = isMobile ? 'flex' : 'none';
  
  // --- moreBtn: কোনো একটা control popup এ গেলেই দরকার ---
  $('moreBtn').style.display = (isMobile || isCcTiny) ? '' : 'none';
  
  // --- PiP ---
  const pipBtn = $('pipBtn');
  const pipRow = $('pipRow');
  const pipSupported = document.pictureInPictureEnabled;
  if (pipBtn) {
    pipBtn.style.display = isCcTiny ? 'none' : '';
    pipBtn.disabled = !pipSupported;
  }
  if (pipRow) {
    pipRow.style.display = isCcTiny ? 'flex' : 'none';
    pipRow.classList.toggle('disabled-row', !pipSupported);
  }
  
  // --- CC ---
  const ccBtn = $('ccBtn');
  const ccRow = $('moreCcRow');
  const ccSupported = state.ccAvailable;
  if (ccBtn) {
    ccBtn.style.display = isCcTiny ? 'none' : '';
    ccBtn.disabled = !ccSupported;
  }
  if (ccRow) {
    ccRow.style.display = isCcTiny ? 'flex' : 'none';
    ccRow.classList.toggle('disabled-row', !ccSupported);
  }
  
  // --- Fullscreen ---
  const fsRow = $('moreFullscreenRow');
  const fsBtn = $('fullscreenBtn');
  if (fsRow) {
    fsRow.style.display = isTiny ? 'flex' : 'none';
    if (isTiny) {
      fsRow.onclick = () => {
        morePopup.classList.remove('open');
        fsBtn.click();
      };
    }
  }
  if (fsBtn) {
    fsBtn.style.display = isTiny ? 'none' : '';
  }
}
syncControlLayout();
window.addEventListener('resize', syncControlLayout);


/* ═══════════════════════════════════════════════════════
   CONTROLS — LONG PRESS 1.5× SPEED
   ═══════════════════════════════════════════════════════ */
(function() {
  const LONG_PRESS_MS = 500;
  const FAST_SPEED = 1.5;
  const speedEl = $('speedIndicator');
  let pressTimer = null,
    isFast = false,
    normalSpeed = 1;
  
  function startFast() {
    if (state.currentIdx === -1 || isFast) return;
    if (videoEl.paused || videoEl.readyState < 2) return;
    isFast = true;
    normalSpeed = videoEl.playbackRate || 1;
    videoEl.playbackRate = FAST_SPEED;
    videoWrap.classList.remove('controls-visible');
    clearTimeout(hideTimer);
    speedEl.classList.add('show');
  }
  
  function stopFast() {
    if (!isFast) return;
    isFast = false;
    videoEl.playbackRate = normalSpeed;
    speedEl.classList.remove('show');
  }
  
  function cancelPress() { clearTimeout(pressTimer);
    pressTimer = null; }
  
  videoWrap.addEventListener('touchstart', e => { if (e.touches.length !== 1) return;
    cancelPress();
    pressTimer = setTimeout(startFast, LONG_PRESS_MS); }, { passive: true });
  videoWrap.addEventListener('touchend', () => { cancelPress();
    stopFast(); });
  videoWrap.addEventListener('touchcancel', () => { cancelPress();
    stopFast(); });
  videoWrap.addEventListener('touchmove', () => { cancelPress();
    stopFast(); });
  videoWrap.addEventListener('mousedown', e => { if (e.button !== 0) return;
    cancelPress();
    pressTimer = setTimeout(startFast, LONG_PRESS_MS); });
  window.addEventListener('mouseup', () => { cancelPress();
    stopFast(); });
  videoWrap.addEventListener('mouseleave', () => { cancelPress();
    stopFast(); });
})();


/* ═══════════════════════════════════════════════════════
   KEYBOARD SHORTCUTS
   ═══════════════════════════════════════════════════════ */
document.addEventListener('keydown', e => {
  if (e.target.tagName === 'INPUT') return;
  if (e.code === 'Space') { e.preventDefault();
    togglePlayPause(); }
  if (e.code === 'ArrowRight') navigateChannel(1);
  if (e.code === 'ArrowLeft') navigateChannel(-1);
  if (e.code === 'ArrowUp') setVolume(Math.min(1, videoEl.volume + 0.1), false);
  if (e.code === 'ArrowDown') { const v = Math.max(0, videoEl.volume - 0.1);
    setVolume(v, v === 0); }
  if (e.code === 'KeyF') $('fullscreenBtn').click();
  if (e.code === 'KeyM') $('muteBtn').click();
  if (e.code === 'KeyC') $('ccBtn').click();
});


/* ═══════════════════════════════════════════════════════
   SIDEBAR TOGGLE + MOBILE PLAYLIST POPUP
   ═══════════════════════════════════════════════════════ */
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
  backdrop.style.cssText = 'position:fixed;inset:0;z-index:199;background:rgba(0,0,0,0.5);';

  const popup = document.createElement('div');
  popup.id = 'plPopup';
  popup.className = 'pl-popup-sheet';

  function closePopup() { popup.remove(); backdrop.remove(); }
  backdrop.addEventListener('click', closePopup);

  const title = document.createElement('div');
  title.className = 'pl-popup-title';
  title.textContent = 'SELECT PLAYLIST';
  popup.appendChild(title);

  const list = document.createElement('div');
  list.className = 'pl-popup-list';

  state.playlists.forEach((pl, idx) => {
    const isActive = idx === state.activePlaylist;
    const row = document.createElement('div');
    row.className = 'pl-popup-row' + (isActive ? ' active' : '');

    const imgHtml = pl.image
      ? `<img class="pl-popup-img" src="${escAttr(pl.image)}" alt="" onerror="this.style.display='none'">`
      : `<div class="pl-popup-img pl-popup-img-fallback">${escHtml(pl.name.substring(0,2).toUpperCase())}</div>`;

    row.innerHTML = `
      ${imgHtml}
      <div class="pl-popup-info">
        <div class="pl-popup-name">${escHtml(pl.name)}</div>
        <div class="pl-popup-count">${pl.channels.length} channels</div>
      </div>
      <div class="pl-popup-check">
        <svg width="13" height="13" viewBox="0 0 12 12" fill="none">
          <polyline points="2,6 5,9 10,3" stroke="white" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>
        </svg>
      </div>
    `;

    row.addEventListener('click', () => {
      switchPlaylist(idx);
      closePopup();
      updateMobilePlaylistBtn();
      if (window.innerWidth <= 768) sidebar.classList.add('mobile-open');
    });

    list.appendChild(row);
  });

  popup.appendChild(list);
  document.body.appendChild(backdrop);
  document.body.appendChild(popup);
}

function updateMobilePlaylistBtn() {
  if (state.playlists.length <= 1) { mobileSidebarBtn.style.display = 'none'; return; }
  mobileSidebarBtn.style.display = 'flex';
}


/* ═══════════════════════════════════════════════════════
   THEME
   ═══════════════════════════════════════════════════════ */
const savedTheme = localStorage.getItem('ks_theme');
const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
document.documentElement.setAttribute('data-theme', savedTheme || (prefersDark ? 'dark' : 'light'));

$('themeToggle').addEventListener('click', () => {
  const isDark = document.documentElement.getAttribute('data-theme') === 'dark';
  const next = isDark ? 'light' : 'dark';
  document.documentElement.setAttribute('data-theme', next);
  localStorage.setItem('ks_theme', next);
});


/* ═══════════════════════════════════════════════════════
   MOBILE DETECTION
   ═══════════════════════════════════════════════════════ */
function checkMobile() {
  const isMobile = window.innerWidth <= 768;
  if (isMobile) { sidebar.classList.remove('collapsed');
    updateMobilePlaylistBtn(); }
  else { mobileSidebarBtn.style.display = 'none'; }
}
window.addEventListener('resize', checkMobile);
checkMobile();

/* ═══════════════════════════════════════════════════════
   MORE POPUP — SUB PANEL NAVIGATION (Quality / CC)
   ═══════════════════════════════════════════════════════ */
const morePopupInner = $('morePopupInner');

function openMoreSubPanel(panelId) {
  document.querySelectorAll('.more-panel-sub').forEach(p => p.classList.remove('sub-active'));
  const target = $(panelId);
  if (target) target.classList.add('sub-active');
  morePopupInner.classList.add('sub-open');
  morePopup.scrollTop = 0;
}

function closeMoreSubPanel() {
  morePopupInner.classList.remove('sub-open');
  document.querySelectorAll('.more-panel-sub').forEach(p => p.classList.remove('sub-active'));
  $('moreQualList').innerHTML = '';
  $('moreCcList').innerHTML = '';
  morePopup.scrollTop = 0;
}

function buildQualityList() {
  const list = $('moreQualList');
  const hls = state.hls;
  
  list.innerHTML = '';
  
  if (!hls || !hls.levels || hls.levels.length <= 1) {
    const msg = document.createElement('div');
    msg.style.cssText = 'padding:12px 10px; font-size:12px; color:rgba(255,255,255,0.4); text-align:center;';
    msg.textContent = hls && hls.levels ? 'Only 1 quality available' : 'No stream loaded';
    list.appendChild(msg);
    return;
  }
  
  const selectedLevel = state.selectedLevel ?? -1; // default: auto
  const isAuto = selectedLevel === -1;
  
  // AUTO option
  const autoRow = document.createElement('div');
  autoRow.className = 'more-qual-row' + (isAuto ? ' active' : '');
  autoRow.innerHTML = `
    <div class="more-qual-dot"></div>
    <span class="more-qual-label">Auto</span>
    <span class="more-qual-badge">${hls.levels.length}Q</span>
  `;
  autoRow.addEventListener('click', () => {
    state.selectedLevel = -1;
    hls.currentLevel = -1;
    updateQualBadge(-1);
    buildQualityList();
  });
  list.appendChild(autoRow);
  
  const sorted = hls.levels
    .map((lv, i) => ({ lv, i }))
    .sort((a, b) => (b.lv.height || 0) - (a.lv.height || 0));
  
  sorted.forEach(({ lv, i }) => {
    const label = lv.height ? `${lv.height}p` : `Level ${i + 1}`;
    const bitrate = lv.bitrate ? `${Math.round(lv.bitrate / 1000)}k` : '';
    const isActive = selectedLevel === i;
    
    const row = document.createElement('div');
    row.className = 'more-qual-row' + (isActive ? ' active' : '');
    row.innerHTML = `
      <div class="more-qual-dot"></div>
      <span class="more-qual-label">${label}</span>
      ${bitrate ? `<span class="more-qual-badge">${bitrate}</span>` : ''}
    `;
    row.addEventListener('click', () => {
      state.selectedLevel = i;
      hls.currentLevel = i;
      updateQualBadge(i);
      buildQualityList();
    });
    list.appendChild(row);
  });
}

function updateQualBadge(level) {
  const hls = state.hls;
  const badge = $('qualityBadge');
  const current = $('moreQualCurrent');
  
  if (!hls) return;
  
  let text;
  if (level === -1) {
    // Auto মোডে actual চলমান resolution দেখাও
    const runningLevel = hls.currentLevel;
    const lv = hls.levels?.[runningLevel];
    const cnt = hls.levels?.length || 0;
    if (lv?.height && cnt > 1) {
      text = `AUTO · ${lv.height}p`;
    } else {
      text = cnt > 1 ? `AUTO · ${cnt}Q` : 'HLS';
    }
  } else {
    const lv = hls.levels?.[level];
    text = lv?.height ? `${lv.height}p` : 'HLS';
  }
  
  badge.textContent = text;
  if (current) current.textContent = text;
}

// Quality row trigger
$('moreQualRow').addEventListener('click', (e) => {
  e.stopPropagation();
  buildQualityList();
  openMoreSubPanel('morePanelQuality');
});

$('qualityBadge').style.cursor = 'pointer';
$('qualityBadge').addEventListener('click', (e) => {
  e.stopPropagation();
  
  morePopup.classList.add('open');
  
  buildQualityList();
  openMoreSubPanel('morePanelQuality');
  startHideTimer();
});

// Back button
$('moreQualBack').addEventListener('click', (e) => {
  e.stopPropagation();
  closeMoreSubPanel();
});

// More popup close → sub panel ও reset হবে
const origMoreBtn = $('moreBtn');
document.addEventListener('click', (e) => {
  if (!morePopup.contains(e.target) && e.target !== origMoreBtn) {
    closeMoreSubPanel();
  }
});

// HLS level switch হলে badge sync
document.addEventListener('hlsLevelUpdate', () => {
  if (state.hls) updateQualBadge(state.hls.currentLevel);
});

/* ═══════════════════════════════════════════════════════
   MORE POPUP — SUBTITLE / CC CONTROL PANEL
   ═══════════════════════════════════════════════════════ */
state.ccAvailable = false;
state.ccTracks = [];      // [{ id, name, lang, kind: 'hls'|'native', ref }]
state.activeCcId = null;  // null = off

function ccLabel(track) {
  const name = track.name && track.name.trim();
  const lang = track.lang && track.lang.trim();
  if (name && lang && name.toLowerCase() !== lang.toLowerCase()) return `${name} (${lang.toUpperCase()})`;
  return name || (lang ? lang.toUpperCase() : 'Unknown');
}

function refreshCcButtons() {
  const ccBtn = $('ccBtn');
  const ccRow = $('moreCcRow');
  const cur = $('moreCcCurrent');

  state.ccAvailable = state.ccTracks.length > 0;

  if (ccBtn) {
    ccBtn.disabled = !state.ccAvailable;
    ccBtn.classList.toggle('active', state.activeCcId !== null);
  }
  if (ccRow) ccRow.classList.toggle('disabled-row', !state.ccAvailable);

  if (cur) {
    if (!state.ccAvailable) {
      cur.textContent = 'N/A';
    } else if (state.activeCcId === null) {
      cur.textContent = 'OFF';
    } else {
      const t = state.ccTracks.find(t => t.id === state.activeCcId);
      cur.textContent = t ? ccLabel(t).split(' ')[0].toUpperCase().slice(0, 6) : 'ON';
    }
  }
}

// Collect subtitle tracks from current HLS instance + native <track> elements
function collectCcTracks() {
  const tracks = [];
  const hls = state.hls;

  if (hls && hls.subtitleTracks && hls.subtitleTracks.length) {
    hls.subtitleTracks.forEach((t, i) => {
      tracks.push({
        id: `hls-${i}`,
        name: t.name || '',
        lang: t.lang || '',
        kind: 'hls',
        ref: i
      });
    });
  }

  // Native <track> elements on the video (rare for live HLS, but handle if present)
  Array.from(videoEl.textTracks || []).forEach((t, i) => {
    if (t.kind === 'subtitles' || t.kind === 'captions') {
      tracks.push({
        id: `native-${i}`,
        name: t.label || '',
        lang: t.language || '',
        kind: 'native',
        ref: t
      });
    }
  });

  state.ccTracks = tracks;
  setActiveCc(null);
}

function setActiveCc(id) {
  const hls = state.hls;
  
  if (id === null) {
    if (hls) hls.subtitleTrack = -1;
    Array.from(videoEl.textTracks || []).forEach(t => t.mode = 'disabled');
    state.activeCcId = null;
    refreshCcButtons();
    buildCcList();
    return;
  }
  
  const track = state.ccTracks.find(t => t.id === id);
  if (!track) return;
  
  // আগে activeCcId আপডেট করুন যাতে guard listener বিভ্রান্ত না হয়
  state.activeCcId = id;
  
  Array.from(videoEl.textTracks || []).forEach(t => t.mode = 'disabled');
  
  if (track.kind === 'hls' && hls) {
    hls.subtitleTrack = track.ref; // সরাসরি টার্গেট ট্র্যাকে যাও, মাঝে -1 দরকার নেই
  } else if (track.kind === 'native') {
    if (hls) hls.subtitleTrack = -1;
    track.ref.mode = 'showing';
  }
  
  refreshCcButtons();
  buildCcList();
}

// HLS.js নিজে থেকে subtitle track auto-select করে ফেললে, CC state OFF থাকলে force বন্ধ করে দেওয়া
document.addEventListener('hlsSubtitleTracksUpdate', () => {
  collectCcTracks();
});

document.addEventListener('hlsSubtitleTrackSwitch', () => {
  if (state.hls && state.activeCcId === null && state.hls.subtitleTrack !== -1) {
    state.hls.subtitleTrack = -1;
  }
});

function buildCcList() {
  const list = $('moreCcList');
  list.innerHTML = '';

  if (!state.ccAvailable) {
    const msg = document.createElement('div');
    msg.style.cssText = 'padding:12px 10px; font-size:12px; color:rgba(255,255,255,0.4); text-align:center;';
    msg.textContent = 'No subtitles available';
    list.appendChild(msg);
    return;
  }

  // OFF option
  const offRow = document.createElement('div');
  offRow.className = 'more-qual-row' + (state.activeCcId === null ? ' active' : '');
  offRow.innerHTML = `
    <div class="more-qual-dot"></div>
    <span class="more-qual-label">Off</span>
  `;
  offRow.addEventListener('click', () => setActiveCc(null));
  list.appendChild(offRow);

  state.ccTracks.forEach(track => {
    const isActive = state.activeCcId === track.id;
    const row = document.createElement('div');
    row.className = 'more-qual-row' + (isActive ? ' active' : '');
    row.innerHTML = `
      <div class="more-qual-dot"></div>
      <span class="more-qual-label">${escHtml(ccLabel(track))}</span>
    `;
    row.addEventListener('click', () => setActiveCc(track.id));
    list.appendChild(row);
  });
}

// Standalone CC button — toggles last-used track or opens picker if multiple
$('ccBtn').addEventListener('click', (e) => {
  e.stopPropagation();
  if (!state.ccAvailable) return;

  if (state.activeCcId !== null) {
    setActiveCc(null);
    videoWrap.classList.add('controls-visible');
    startHideTimer();
    return;
  }

  if (state.ccTracks.length === 1) {
    setActiveCc(state.ccTracks[0].id);
    videoWrap.classList.add('controls-visible');
    startHideTimer();
    return;
  }

  morePopup.classList.add('open');
  buildCcList();
  openMoreSubPanel('morePanelCc');
  startHideTimer();
});

// CC row inside more popup
$('moreCcRow').addEventListener('click', (e) => {
  e.stopPropagation();
  if (!state.ccAvailable) return;
  buildCcList();
  openMoreSubPanel('morePanelCc');
});

// Back button
$('moreCcBack').addEventListener('click', (e) => {
  e.stopPropagation();
  closeMoreSubPanel();
});

// Re-sync CC tracks whenever HLS reports them (covers stream switches + live updates)
document.addEventListener('hlsSubtitleTracksUpdate', () => {
  collectCcTracks();
});

/* ═══════════════════════════════════════════════════════
   SHARE — Temporary Expiring Channel Link
   ═══════════════════════════════════════════════════════ */
const SHARE_SECRET = 'kslive2025';
const SHARE_TTL_MS = 6 * 60 * 60 * 1000; // 6 hours

async function nameToHash(chName) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(chName));
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2,'0')).join('').slice(0, 12);
}

async function genShareToken(chName, playlistIdx) {
  const ts = Date.now();
  const raw = `${chName}:${playlistIdx}:${ts}:${SHARE_SECRET}`;
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(raw));
  const hex = Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2,'0')).join('').slice(0,16);
  return { ts, sig: hex };
}

async function verifyShareToken(chName, playlistIdx, ts, sig) {
  if (Date.now() - Number(ts) > SHARE_TTL_MS) return false;
  const raw = `${chName}:${playlistIdx}:${ts}:${SHARE_SECRET}`;
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(raw));
  const hex = Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2,'0')).join('').slice(0,16);
  return hex === sig;
}

async function shortenUrl(longUrl) {
  try {
    const res = await fetch(
      `https://round-bonus-4d76.marufhossainkeyas.workers.dev/?url=${encodeURIComponent(longUrl)}`
    );
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

  const chHash = await nameToHash(ch.name);
  const { ts, sig } = await genShareToken(ch.name, state.activePlaylist);
  const base = location.origin + location.pathname;
  const longUrl = `${base}?ch=${chHash}&pl=${state.activePlaylist}&t=${ts}&sig=${sig}`;
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
  switchPlaylist(plIdx);
  await new Promise(r => setTimeout(r, 600));

  const matches = await Promise.all(
    state.channels.map(async (c, i) => {
      const h = await nameToHash(c.name);
      return h === chHash ? i : -1;
    })
  );
  const idx = matches.find(i => i !== -1) ?? -1;
  if (idx === -1) { showToast('Channel not found'); return; }

  const valid = await verifyShareToken(state.channels[idx].name, plIdx, ts, sig);
  if (!valid) { showToast('This link has expired ⏰', 4000); return; }

  playChannel(idx);
  setTimeout(() => {
    videoEl.play().then(() => {
      state.isPlaying = true;
      updatePlayPauseIcon();
    }).catch(() => {
      state.isPlaying = false;
      updatePlayPauseIcon();
    });
  }, 800);
  history.replaceState({}, '', location.pathname);
}

$('shareBtn').addEventListener('click', shareChannel);
