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

// Single shared timer so rapid toggling never leaves two competing
// "hide big-play icon" timeouts fighting each other.
let bigPlayFlashTimer = null;
function updatePlayPauseIcon() {
  const PAUSE_D = 'M5.5 3.5A1.5 1.5 0 0 1 7 5v6a1.5 1.5 0 0 1-3 0V5a1.5 1.5 0 0 1 1.5-1.5m5 0A1.5 1.5 0 0 1 12 5v6a1.5 1.5 0 0 1-3 0V5a1.5 1.5 0 0 1 1.5-1.5';
  const PLAY_D = 'm11.596 8.697-6.363 3.692c-.54.313-1.233-.066-1.233-.697V4.308c0-.63.692-1.01 1.233-.696l6.363 3.692a.802.802 0 0 1 0 1.393';
  $('ppIcon').setAttribute('d', state.isPlaying ? PAUSE_D : PLAY_D);
  $('bpIcon').setAttribute('d', state.isPlaying ? PAUSE_D : PLAY_D);

  bigPlay.classList.add('show');
  clearTimeout(bigPlayFlashTimer);
  bigPlayFlashTimer = setTimeout(() => {
    if (state.isPlaying) bigPlay.classList.remove('show');
  }, 700);
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

let audioCtx = null;
let gainNode = null;
let sourceConnected = false;
// Gain the UI last asked for, applied as soon as the AudioContext exists —
// fixes the "moved slider into boost range before first interaction" bug
// where the gain silently never got applied because ensureAudioCtx() /
// connectSource() hadn't run yet.
let pendingGain = 1;

function ensureAudioCtx() {
  if (audioCtx) return;
  audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  gainNode = audioCtx.createGain();
  gainNode.gain.value = pendingGain;
  gainNode.connect(audioCtx.destination);
}

function connectSource() {
  if (sourceConnected || !audioCtx) return;
  try {
    const src = audioCtx.createMediaElementSource(videoEl);
    src.connect(gainNode);
    sourceConnected = true;
  } catch (e) {
    // createMediaElementSource throws if called twice on the same element
    // across an engine swap in some browsers; treat as already-connected.
    sourceConnected = true;
  }
}

// vol: 0–1 for video element (0%–100%)
// boost: 1.0–1.3 from GainNode (100%–130%)
// slider range: 0–130 (integer steps)
function sliderToGain(sliderVal) {
  if (sliderVal <= 100) {
    return { vol: sliderVal / 100, gain: 1 };
  } else {
    return { vol: 1, gain: 1 + ((sliderVal - 100) / 10) };
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
    slider.style.setProperty('--thumb-color', 'var(--blue3)');
  } else {
    const redPct = pct;
    slider.style.background = `linear-gradient(to right,
      var(--blue3) 0%,
      var(--blue3) ${boostStart}%,
      var(--red2) ${boostStart}%,
      var(--red2) ${redPct}%,
      rgba(255,255,255,0.18) ${redPct}%,
      rgba(255,255,255,0.18) 100%)`;
    slider.style.setProperty('--thumb-color', 'var(--red2)');
  }
}

function setVolume(vol, muted, sliderVal) {
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

  const g = muted ? 0 : (sv > 100 ? sv / 100 : 1);
  pendingGain = g;
  if (gainNode) gainNode.gain.value = g;

  const MUTED_D = 'M6.717 3.55A.5.5 0 0 1 7 4v8a.5.5 0 0 1-.812.39L3.825 10.5H1.5A.5.5 0 0 1 1 10V6a.5.5 0 0 1 .5-.5h2.325l2.363-1.89a.5.5 0 0 1 .529-.06m7.137 2.096a.5.5 0 0 1 0 .708L12.207 8l1.647 1.646a.5.5 0 0 1-.708.708L11.5 8.707l-1.646 1.647a.5.5 0 0 1-.708-.708L10.793 8 9.146 6.354a.5.5 0 1 1 .708-.708L11.5 7.293l1.646-1.647a.5.5 0 0 1 .708 0';
  const UNMUTED_D = 'M9 4a.5.5 0 0 0-.812-.39L5.825 5.5H3.5A.5.5 0 0 0 3 6v4a.5.5 0 0 0 .5.5h2.325l2.363 1.89A.5.5 0 0 0 9 12zm3.025 4a4.5 4.5 0 0 1-1.318 3.182L10 10.475A3.5 3.5 0 0 0 11.025 8 3.5 3.5 0 0 0 10 5.525l.707-.707A4.5 4.5 0 0 1 12.025 8';
  $('volIcon').setAttribute('d', (muted || vol === 0) ? MUTED_D : UNMUTED_D);
  if ($('volIcon2')) $('volIcon2').setAttribute('d', (muted || vol === 0) ? MUTED_D : UNMUTED_D);
}

$('muteBtn').addEventListener('click', () => {
  ensureAudioCtx();
  connectSource();
  if (audioCtx.state === 'suspended') audioCtx.resume();

  if (state.isMuted || videoEl.volume === 0) {
    const restoreVal = lastVol > 1 ? Math.round(lastVol * 100) : Math.round(lastVol * 100);
    setVolume(lastVol > 1 ? 1 : lastVol, false, restoreVal);
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

  pendingGain = gain;
  if (gainNode) gainNode.gain.setTargetAtTime(gain, audioCtx.currentTime, 0.01);

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

videoEl.addEventListener('play', () => {
  if (audioCtx && audioCtx.state === 'suspended') audioCtx.resume();
  ensureAudioCtx();
  connectSource();
});
updateSliderTrack($('volSlider'), 100);
updateSliderTrack($('volSliderMobile'), 100);


/* ═══════════════════════════════════════════════════════
   CONTROLS — FULLSCREEN + PiP
   ═══════════════════════════════════════════════════════ */
$('fullscreenBtn').addEventListener('click', () => {
  if (!document.fullscreenElement) {
    (videoWrap.requestFullscreen || videoWrap.webkitRequestFullscreen || videoWrap.mozRequestFullScreen || (() => {})).call(videoWrap);
  } else {
    (document.exitFullscreen || document.webkitExitFullscreen || document.mozCancelFullScreen || (() => {})).call(document);
  }
});

document.addEventListener('fullscreenchange', () => {
  if (document.fullscreenElement) screen.orientation?.lock?.('landscape').catch(() => {});
  else screen.orientation?.unlock?.();
});

/* ═══════════════════════════════════════════════════════
   CONTROLS — SCREEN ORIENTATION LOCK (fullscreen only)
   ═══════════════════════════════════════════════════════ */
(function () {
  const orientBtn = $('orientBtn');
  const orientRow = $('moreOrientRow');
  const orientAPI = screen.orientation;
  const supported = !!(orientAPI && orientAPI.lock);

  if (!supported) return;

  function isLandscape() {
    return (orientAPI.type || '').startsWith('landscape');
  }

  async function toggleOrientation() {
    try {
      if (isLandscape()) await orientAPI.lock('portrait');
      else await orientAPI.lock('landscape');
    } catch (e) {
      showToast('Rotation not supported on this device');
    }
  }

  orientBtn?.addEventListener('click', (e) => {
    e.stopPropagation();
    toggleOrientation();
    clearTimeout(hideTimer);
    hideTimer = setTimeout(() => {
      if (morePopup.classList.contains('open')) return;
      videoWrap.classList.remove('controls-visible');
    }, 3000);
  });

  orientRow?.addEventListener('click', (e) => {
    e.stopPropagation();
    morePopup.classList.remove('open');
    toggleOrientation();
  });

  document.addEventListener('fullscreenchange', () => {
    syncControlLayout();
    if (!document.fullscreenElement) orientAPI.unlock?.();
  });

  ['webkitfullscreenchange', 'mozfullscreenchange'].forEach(evt => {
    document.addEventListener(evt, syncControlLayout);
  });
})();

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
$('pipRow').addEventListener('click', () => { morePopup.classList.remove('open'); togglePiP(); });
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
  if (e.target.closest('.ctrl-btn')) return;
  if (e.target.closest('input[type="range"]')) return;
  if (e.target.closest('.progress-bar-wrap')) return;
  if (e.target.closest('.more-popup')) return;

  tapCount++;
  if (tapCount === 1) {
    tapTimer = setTimeout(() => {
      tapCount = 0;
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
  const willOpen = !morePopup.classList.contains('open');
  morePopup.classList.toggle('open');
  if (willOpen) {
    // Always start from the top of the main panel. Without this, if the
    // user had scrolled the popup down before closing it last time, the
    // next open would silently resume at that same scroll offset instead
    // of showing the top of the menu.
    morePopup.scrollTop = 0;
  }
  startHideTimer();
});
document.addEventListener('click', (e) => {
  // Only collapse the sub-panel/close popup when the click genuinely
  // landed outside it — the popup's own stopPropagation() below already
  // protects internal clicks, this is the outside-click closer.
  if (!morePopup.contains(e.target) && e.target !== $('moreBtn')) {
    morePopup.classList.remove('open');
    closeMoreSubPanel();
  }
  if (!videoWrap.contains(e.target)) videoWrap.classList.remove('controls-visible');
});
morePopup.addEventListener('click', e => e.stopPropagation());

function updateVideoHeightVar() {
  const h = $('videoWrap').getBoundingClientRect().height;
  document.documentElement.style.setProperty('--video-h', h + 'px');
}
window.addEventListener('resize', updateVideoHeightVar);
updateVideoHeightVar();

/* ═══════════════════════════════════════════════════════
   CONTROLS — LAYOUT SYNC (mobile vs desktop)
   ═══════════════════════════════════════════════════════ */
function syncControlLayout() {
  const isMobile = window.innerWidth <= 450;
  const isTiny = window.innerWidth <= 345;
  const isCcTiny = window.innerWidth <= 490;
  const inFullscreen = !!(document.fullscreenElement || document.webkitFullscreenElement || document.mozFullScreenElement);

  const volSlider = $('volSlider');
  const volRow = $('moreVolRow');
  if (volSlider) volSlider.style.display = isMobile ? 'none' : '';
  if (volRow) volRow.style.display = isMobile ? 'flex' : 'none';

  $('moreBtn').style.display = (isMobile || isCcTiny) ? '' : 'none';

  const pipBtn = $('pipBtn');
  const pipRow = $('pipRow');
  const pipSupported = document.pictureInPictureEnabled;
  if (pipBtn) { pipBtn.style.display = isCcTiny ? 'none' : ''; pipBtn.disabled = !pipSupported; }
  if (pipRow) { pipRow.style.display = isCcTiny ? 'flex' : 'none'; pipRow.classList.toggle('disabled-row', !pipSupported); }

  const ccBtn = $('ccBtn');
  const ccRow = $('moreCcRow');
  const ccSupported = state.ccAvailable;
  if (ccBtn) { ccBtn.style.display = isCcTiny ? 'none' : ''; ccBtn.disabled = !ccSupported; }
  if (ccRow) { ccRow.style.display = isCcTiny ? 'flex' : 'none'; ccRow.classList.toggle('disabled-row', !ccSupported); }

  const audioBtn = $('audioBtn');
  const audioRow = $('moreAudioRow');
  const audioSupported = state.audioAvailable;
  if (audioBtn) { audioBtn.style.display = isCcTiny ? 'none' : ''; audioBtn.disabled = !audioSupported; }
  if (audioRow) { audioRow.style.display = isCcTiny ? 'flex' : 'none'; audioRow.classList.toggle('disabled-row', !audioSupported); }

  const orientBtn = $('orientBtn');
  const orientRow = $('moreOrientRow');
  const orientSupported = !!(screen.orientation && screen.orientation.lock);
  if (orientBtn) orientBtn.style.display = (inFullscreen && !isCcTiny && orientSupported) ? '' : 'none';
  if (orientRow) {
    orientRow.style.display = (inFullscreen && isCcTiny && orientSupported) ? 'flex' : 'none';
    orientRow.classList.toggle('disabled-row', !orientSupported);
  }

  const fsRow = $('moreFullscreenRow');
  const fsBtn = $('fullscreenBtn');
  if (fsRow) {
    fsRow.style.display = isTiny ? 'flex' : 'none';
    if (isTiny) {
      fsRow.onclick = () => { morePopup.classList.remove('open'); fsBtn.click(); };
    }
  }
  if (fsBtn) fsBtn.style.display = isTiny ? 'none' : '';

  const allRows = [volRow, $('moreQualRow'), ccRow, audioRow, orientRow, pipRow, fsRow].filter(Boolean);
  let lastVisibleRow = null;
  allRows.forEach(row => {
    const div = row.nextElementSibling;
    const visible = row.style.display !== 'none';
    if (div && div.classList.contains('more-popup-divider')) div.style.display = visible ? '' : 'none';
    if (visible) lastVisibleRow = row;
  });
  if (lastVisibleRow) {
    const div = lastVisibleRow.nextElementSibling;
    if (div && div.classList.contains('more-popup-divider')) div.style.display = 'none';
  }
}
syncControlLayout();
window.addEventListener('resize', syncControlLayout);


/* ═══════════════════════════════════════════════════════
   CONTROLS — LONG PRESS 1.5× SPEED
   ═══════════════════════════════════════════════════════ */
(function () {
  const LONG_PRESS_MS = 500;
  const FAST_SPEED = 1.5;
  const speedEl = $('speedIndicator');
  let pressTimer = null, isFast = false, normalSpeed = 1;
  // Guards the double-tap-to-seek-or-pause gesture from also triggering a
  // long-press fast-forward on the same touch sequence.
  let touchMoved = false;

  function startFast() {
    if (state.currentIdx === -1 || isFast || touchMoved) return;
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

  function cancelPress() { clearTimeout(pressTimer); pressTimer = null; }

  videoWrap.addEventListener('touchstart', e => {
    if (e.touches.length !== 1) return;
    touchMoved = false;
    cancelPress();
    pressTimer = setTimeout(startFast, LONG_PRESS_MS);
  }, { passive: true });
  videoWrap.addEventListener('touchend', () => { cancelPress(); stopFast(); });
  videoWrap.addEventListener('touchcancel', () => { cancelPress(); stopFast(); });
  videoWrap.addEventListener('touchmove', () => { touchMoved = true; cancelPress(); stopFast(); });
  videoWrap.addEventListener('mousedown', e => {
    if (e.button !== 0) return;
    cancelPress();
    pressTimer = setTimeout(startFast, LONG_PRESS_MS);
  });
  window.addEventListener('mouseup', () => { cancelPress(); stopFast(); });
  videoWrap.addEventListener('mouseleave', () => { cancelPress(); stopFast(); });
})();


/* ═══════════════════════════════════════════════════════
   KEYBOARD SHORTCUTS
   ═══════════════════════════════════════════════════════ */
document.addEventListener('keydown', e => {
  if (e.target.tagName === 'INPUT') return;
  if (e.code === 'Space') { e.preventDefault(); togglePlayPause(); }
  if (e.code === 'ArrowRight') navigateChannel(1);
  if (e.code === 'ArrowLeft') navigateChannel(-1);
  if (e.code === 'ArrowUp') { e.preventDefault(); setVolume(Math.min(1, videoEl.volume + 0.1), false); }
  if (e.code === 'ArrowDown') { e.preventDefault(); const v = Math.max(0, videoEl.volume - 0.1); setVolume(v, v === 0); }
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
      : `<div class="pl-popup-img pl-popup-img-fallback">${escHtml(pl.name.substring(0, 2).toUpperCase())}</div>`;

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

checkMobile();

/* ═══════════════════════════════════════════════════════
   MORE POPUP — SUB PANEL NAVIGATION (Quality / CC / Audio)
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
  $('moreAudioList').innerHTML = '';
  morePopup.scrollTop = 0;
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

$('moreQualBack').addEventListener('click', (e) => {
  e.stopPropagation();
  closeMoreSubPanel();
});

document.addEventListener('hlsLevelUpdate', () => {
  if (state.hls) updateQualBadge(state.hls.currentLevel);
});

/* ═══════════════════════════════════════════════════════
   MORE POPUP — AUDIO TRACK CONTROL PANEL
   ═══════════════════════════════════════════════════════ */
function audioLabel(track) {
  const name = track.name && track.name.trim().toUpperCase();
  const lang = track.lang && track.lang.trim();
  const fullLang = fullLangName(lang);
  if (name && fullLang && name.toLowerCase() !== fullLang.toLowerCase()) return `${fullLang} (${name})`;
  return name || fullLang || 'Default';
}

function refreshAudioButtons() {
  const audioBtn = $('audioBtn');
  const audioRow = $('moreAudioRow');
  const cur = $('moreAudioCurrent');

  state.audioAvailable = state.audioTracks.length > 1;

  if (audioBtn) {
    audioBtn.disabled = !state.audioAvailable;
    audioBtn.classList.toggle('active', state.activeAudioId !== null);
  }
  if (audioRow) audioRow.classList.toggle('disabled-row', !state.audioAvailable);

  if (cur) {
    if (!state.audioAvailable) {
      cur.textContent = state.audioTracks.length === 1 ? 'DEFAULT' : 'N/A';
    } else {
      const t = state.audioTracks.find(t => t.id === state.activeAudioId);
      cur.textContent = t ? audioLabel(t).split(' ')[0].toUpperCase().slice(0, 6) : 'DEFAULT';
    }
  }
  syncControlLayout();
}

function collectAudioTracks() {
  // Namespaced with the load token for the same reason as collectCcTracks()
  // — prevents a positional id like "hls-0" from one channel ever being
  // mistaken for "hls-0" on a different channel.
  const ns = state.loadToken;

  const tracks = [];

  // ── HLS ──
  if (state.hls && state.hls.audioTracks && state.hls.audioTracks.length) {
    state.hls.audioTracks.forEach((t, i) => {
      tracks.push({ id: `${ns}:hls-${i}`, name: t.name || '', lang: t.lang || '', kind: 'hls', ref: i });
    });
    state.audioTracks = tracks;
    const currentIdx = state.hls.audioTrack;
    state.activeAudioId = (currentIdx >= 0 && tracks[currentIdx]) ? tracks[currentIdx].id : null;
    refreshAudioButtons();
    buildAudioList();
    return;
  }

  // ── Shaka (DASH) ──
  if (state.dash) {
    let variantTracks = [];
    try { variantTracks = state.dash.getVariantTracks() || []; } catch {}

    const seenAudioIds = new Set();
    variantTracks.forEach(t => {
      if (t.audioId == null || seenAudioIds.has(t.audioId)) return;
      seenAudioIds.add(t.audioId);
      tracks.push({
        id: `${ns}:shaka-${t.audioId}`,
        name: t.audioLabel || t.audioRoles?.[0] || '',
        lang: t.language || '',
        kind: 'shaka',
        ref: t.audioId
      });
    });

    state.audioTracks = tracks;
    const active = variantTracks.find(t => t.active);
    const match = tracks.find(tr => tr.ref === active?.audioId);
    state.activeAudioId = match ? match.id : (tracks[0]?.id ?? null);

    refreshAudioButtons();
    buildAudioList();
    return;
  }

  // ── Nothing loaded ──
  state.audioTracks = [];
  state.activeAudioId = null;
  refreshAudioButtons();
  buildAudioList();
}

function setActiveAudio(id) {
  const track = state.audioTracks.find(t => t.id === id);
  if (!track) return;

  state.activeAudioId = id;

  if (track.kind === 'hls' && state.hls) {
    state.hls.audioTrack = track.ref;
  } else if (track.kind === 'shaka' && state.dash) {
    try {
      const variantTracks = state.dash.getVariantTracks();
      const currentVideo = variantTracks.find(t => t.active);
      let target = variantTracks.find(t => t.audioId === track.ref && currentVideo && t.height === currentVideo.height);
      if (!target) target = variantTracks.find(t => t.audioId === track.ref);
      if (target) state.dash.selectVariantTrack(target, true);
    } catch (e) { console.warn('[Shaka] audio switch failed', e); }
  }

  refreshAudioButtons();
  buildAudioList();
}

function buildAudioList() {
  const list = $('moreAudioList');
  list.innerHTML = '';

  if (!state.audioAvailable) {
    const msg = document.createElement('div');
    msg.style.cssText = 'padding:12px 10px; font-size:12px; color:rgba(255,255,255,0.4); text-align:center;';
    msg.textContent = state.audioTracks.length === 1 ? 'Only 1 audio track available' : 'No audio tracks available';
    list.appendChild(msg);
    return;
  }

  state.audioTracks.forEach(track => {
    const isActive = state.activeAudioId === track.id;
    const row = document.createElement('div');
    row.className = 'more-qual-row' + (isActive ? ' active' : '');
    row.innerHTML = `
      <div class="more-qual-dot"></div>
      <span class="more-qual-label">${escHtml(audioLabel(track))}</span>
    `;
    row.addEventListener('click', () => setActiveAudio(track.id));
    list.appendChild(row);
  });
}

$('audioBtn').addEventListener('click', (e) => {
  e.stopPropagation();
  if (!state.audioAvailable) return;
  morePopup.classList.add('open');
  buildAudioList();
  openMoreSubPanel('morePanelAudio');
  startHideTimer();
});

$('moreAudioRow').addEventListener('click', (e) => {
  e.stopPropagation();
  if (!state.audioAvailable) return;
  buildAudioList();
  openMoreSubPanel('morePanelAudio');
});

$('moreAudioBack').addEventListener('click', (e) => {
  e.stopPropagation();
  closeMoreSubPanel();
});

document.addEventListener('hlsAudioTracksUpdate', () => collectAudioTracks());

document.addEventListener('hlsAudioTrackSwitch', () => {
  if (state.hls) {
    const idx = state.hls.audioTrack;
    const t = state.audioTracks[idx];
    state.activeAudioId = t ? t.id : null;
    refreshAudioButtons();
  }
});

/* ═══════════════════════════════════════════════════════
   MORE POPUP — SUBTITLE / CC CONTROL PANEL
   ═══════════════════════════════════════════════════════ */
function ccLabel(track) {
  const name = track.name && track.name.trim().toUpperCase();
  const lang = track.lang && track.lang.trim();
  const fullLang = fullLangName(lang);
  if (name && fullLang && name.toLowerCase() !== fullLang.toLowerCase()) return `${fullLang} (${name})`;
  return name || fullLang || 'Default';
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
    if (!state.ccAvailable) cur.textContent = 'N/A';
    else if (state.activeCcId === null) cur.textContent = 'OFF';
    else {
      const t = state.ccTracks.find(t => t.id === state.activeCcId);
      cur.textContent = t ? ccLabel(t).split(' ')[0].toUpperCase().slice(0, 6) : 'ON';
    }
  }
  syncControlLayout();
}

function collectCcTracks() {
  // Track ids are namespaced with the current load token (e.g. "42:hls-0"
  // instead of just "hls-0"). Without this, id's were purely positional —
  // channel A's 3rd subtitle track and channel B's 3rd subtitle track both
  // got the id "hls-2", so the "re-apply previously active track" logic
  // below would treat B's unrelated track as "the same track the user
  // already turned on" and silently re-enable CC on the new channel even
  // though loadStream() had reset activeCcId to null moments earlier.
  const ns = state.loadToken;

  const tracks = [];

  if (state.hls && state.hls.subtitleTracks && state.hls.subtitleTracks.length) {
    state.hls.subtitleTracks.forEach((t, i) => {
      tracks.push({ id: `${ns}:hls-${i}`, name: t.name || '', lang: t.lang || '', kind: 'hls', ref: i });
    });
  }

  if (state.dash) {
    let textTracks = [];
    try { textTracks = state.dash.getTextTracks() || []; } catch {}
    textTracks.forEach((t, i) => {
      tracks.push({ id: `${ns}:shaka-${i}`, name: t.label || '', lang: t.language || '', kind: 'shaka', ref: t });
    });
  }

  if (!state.hls && !state.dash) {
    Array.from(videoEl.textTracks || []).forEach((t, i) => {
      if (t.kind === 'subtitles' || t.kind === 'captions') {
        tracks.push({ id: `${ns}:native-${i}`, name: t.label || '', lang: t.language || '', kind: 'native', ref: t });
      }
    });
  }

  const prevActiveId = state.activeCcId;
  state.ccTracks = tracks;

  // Only re-apply the previously active id if it belongs to THIS load
  // (same token namespace). A match against a stale id from a prior
  // channel is now structurally impossible since the namespace differs.
  if (prevActiveId !== null && tracks.some(t => t.id === prevActiveId)) {
    state.activeCcId = prevActiveId;
    refreshCcButtons();
    buildCcList();
  } else {
    setActiveCc(null);
  }
}

async function setActiveCc(id) {
  const hls = state.hls;

  if (id === null) {
    if (hls) hls.subtitleTrack = -1;
    if (state.dash) { try { await state.dash.setTextTrackVisibility(false); } catch {} }
    Array.from(videoEl.textTracks || []).forEach(t => t.mode = 'disabled');
    state.activeCcId = null;
    refreshCcButtons();
    buildCcList();
    return;
  }

  const track = state.ccTracks.find(t => t.id === id);
  if (!track) return;

  state.activeCcId = id;
  Array.from(videoEl.textTracks || []).forEach(t => t.mode = 'disabled');

  if (track.kind === 'hls' && hls) {
    hls.subtitleTrack = track.ref;
  } else if (track.kind === 'shaka' && state.dash) {
    try {
      const visResult = state.dash.setTextTrackVisibility(true);
      if (visResult instanceof Promise) await visResult;
      const liveTracks = state.dash.getTextTracks();
      const freshMatch = liveTracks.find(lt => lt.language === track.ref.language && lt.label === track.ref.label) || track.ref;
      state.dash.selectTextTrack(freshMatch);
    } catch (e) { console.warn('[Shaka] CC switch failed', e); }
  } else if (track.kind === 'native') {
    if (hls) hls.subtitleTrack = -1;
    track.ref.mode = 'showing';
  }

  refreshCcButtons();
  buildCcList();
}

document.addEventListener('hlsSubtitleTracksUpdate', () => collectCcTracks());

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

$('moreCcRow').addEventListener('click', (e) => {
  e.stopPropagation();
  if (!state.ccAvailable) return;
  buildCcList();
  openMoreSubPanel('morePanelCc');
});

$('moreCcBack').addEventListener('click', (e) => {
  e.stopPropagation();
  closeMoreSubPanel();
});
