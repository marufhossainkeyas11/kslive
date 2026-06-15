/* ═══════════════════════════════════════════════════════
   CONTROLS — PLAY/PAUSE + NAVIGATION
   ═══════════════════════════════════════════════════════ */
function togglePlayPause() {
  if (videoEl.paused) { videoEl.play();
    state.isPlaying = true; }
  else { videoEl.pause();
    state.isPlaying = false; }
  updatePlayPauseIcon();
}

function updatePlayPauseIcon() {
  const PAUSE_D = 'M5.5 3.5A1.5 1.5 0 0 1 7 5v6a1.5 1.5 0 0 1-3 0V5a1.5 1.5 0 0 1 1.5-1.5m5 0A1.5 1.5 0 0 1 12 5v6a1.5 1.5 0 0 1-3 0V5a1.5 1.5 0 0 1 1.5-1.5';
  const PLAY_D = 'm11.596 8.697-6.363 3.692c-.54.313-1.233-.066-1.233-.697V4.308c0-.63.692-1.01 1.233-.696l6.363 3.692a.802.802 0 0 1 0 1.393';
  $('ppIcon').setAttribute('d', state.isPlaying ? PAUSE_D : PLAY_D);
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
   CONTROLS — VOLUME
   ═══════════════════════════════════════════════════════ */
let lastVol = 1;

function setVolume(vol, muted) {
  vol = Math.max(0, Math.min(1, vol));
  videoEl.volume = vol;
  videoEl.muted = muted;
  state.isMuted = muted;
  
  const displayVal = muted ? 0 : vol;
  $('volSlider').value = displayVal;
  $('volSliderMobile').value = displayVal;
  
  const MUTED_D = 'M6.717 3.55A.5.5 0 0 1 7 4v8a.5.5 0 0 1-.812.39L3.825 10.5H1.5A.5.5 0 0 1 1 10V6a.5.5 0 0 1 .5-.5h2.325l2.363-1.89a.5.5 0 0 1 .529-.06m7.137 2.096a.5.5 0 0 1 0 .708L12.207 8l1.647 1.646a.5.5 0 0 1-.708.708L11.5 8.707l-1.646 1.647a.5.5 0 0 1-.708-.708L10.793 8 9.146 6.354a.5.5 0 1 1 .708-.708L11.5 7.293l1.646-1.647a.5.5 0 0 1 .708 0';
  const UNMUTED_D = 'M9 4a.5.5 0 0 0-.812-.39L5.825 5.5H3.5A.5.5 0 0 0 3 6v4a.5.5 0 0 0 .5.5h2.325l2.363 1.89A.5.5 0 0 0 9 12zm3.025 4a4.5 4.5 0 0 1-1.318 3.182L10 10.475A3.5 3.5 0 0 0 11.025 8 3.5 3.5 0 0 0 10 5.525l.707-.707A4.5 4.5 0 0 1 12.025 8';
  $('volIcon').setAttribute('d', (muted || vol === 0) ? MUTED_D : UNMUTED_D);
}

$('muteBtn').addEventListener('click', () => {
  if (state.isMuted || videoEl.volume === 0) setVolume(lastVol || 1, false);
  else { lastVol = videoEl.volume;
    setVolume(videoEl.volume, true); }
});
$('volSlider').addEventListener('input', e => {
  const v = parseFloat(e.target.value);
  if (v > 0) lastVol = v;
  setVolume(v, v === 0);
});
$('volSliderMobile').addEventListener('input', e => {
  const v = parseFloat(e.target.value);
  if (v > 0) lastVol = v;
  setVolume(v, v === 0);
});


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

const PAUSE_PATH = 'M5.5 3.5A1.5 1.5 0 0 1 7 5v6a1.5 1.5 0 0 1-3 0V5a1.5 1.5 0 0 1 1.5-1.5m5 0A1.5 1.5 0 0 1 12 5v6a1.5 1.5 0 0 1-3 0V5a1.5 1.5 0 0 1 1.5-1.5';
const PLAY_PATH = 'm11.596 8.697-6.363 3.692c-.54.313-1.233-.066-1.233-.697V4.308c0-.63.692-1.01 1.233-.696l6.363 3.692a.802.802 0 0 1 0 1.393';

function startHideTimer() {
  clearTimeout(hideTimer);
  hideTimer = setTimeout(() => {
    if (morePopup.classList.contains('open')) return;
    videoWrap.classList.remove('controls-visible');
  }, 3000);
}

videoWrap.addEventListener('click', (e) => {
  if (state.currentIdx === -1) return;
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
    $('bigPlayIcon').querySelector('path').setAttribute('d', state.isPlaying ? PAUSE_PATH : PLAY_PATH);
    bigPlay.classList.add('show');
    setTimeout(() => bigPlay.classList.remove('show'), 700);
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
  const isMobile = window.innerWidth <= 450;
  $('volSlider').style.display = isMobile ? 'none' : '';
  $('pipBtn').style.display = isMobile ? 'none' : (document.pictureInPictureEnabled ? '' : 'none');
  $('moreBtn').style.display = isMobile ? '' : 'none';
  $('pipRow').style.display = isMobile && document.pictureInPictureEnabled ? 'flex' : 'none';
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
  if (existing) { existing.remove();
    existingBd?.remove(); return; }
  
  const backdrop = document.createElement('div');
  backdrop.id = 'plBackdrop';
  backdrop.style.cssText = 'position:fixed;inset:0;z-index:199;background:rgba(0,0,0,0.5);';
  
  const popup = document.createElement('div');
  popup.id = 'plPopup';
  popup.style.cssText = `
    position:fixed;bottom:0;left:0;right:0;z-index:200;
    background:var(--bg2);border-top:1px solid var(--bdr);
    border-radius:16px 16px 0 0;padding:12px 0 24px;
    box-shadow:0 -8px 32px rgba(0,0,0,0.4);
    animation:slideUp 0.25s ease;
  `;
  
  function closePopup() { popup.remove();
    backdrop.remove(); }
  backdrop.addEventListener('click', closePopup);
  
  const title = document.createElement('div');
  title.style.cssText = `
    font-size:12px;font-weight:700;letter-spacing:1.5px;
    text-transform:uppercase;color:var(--t3);
    padding:4px 20px 12px;font-family:var(--m);
    border-bottom:1px solid var(--bdr);margin-bottom:8px;
  `;
  title.textContent = 'SELECT PLAYLIST';
  popup.appendChild(title);
  
  state.playlists.forEach((pl, idx) => {
    const row = document.createElement('div');
    row.style.cssText = `
      display:flex;align-items:center;gap:12px;
      padding:12px 20px;cursor:pointer;transition:background 0.15s;
      background:${idx === state.activePlaylist ? 'rgba(21,101,192,0.15)' : 'transparent'};
    `;
    row.innerHTML = `
      <div style="width:8px;height:8px;border-radius:50%;
        background:${idx === state.activePlaylist ? 'var(--blue3)' : 'var(--t3)'};flex-shrink:0"></div>
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
      if (window.innerWidth <= 768) sidebar.classList.add('mobile-open');
    });
    popup.appendChild(row);
  });
  
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
