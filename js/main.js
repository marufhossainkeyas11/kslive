(function () {
  'use strict';

  if (window.__VE__ && typeof window.__VE__.teardown === 'function') {
    window.__VE__.teardown();
  }

  var VE = { instances: [], teardown: teardownAll };
  window.__VE__ = VE;

  function teardownAll() {
    VE.instances.forEach(function (inst) { inst.destroy(); });
    VE.instances = [];
    // shadow root-এর ভেতরের <style> প্রতিটা rig destroy() এর সাথেই সরে
    // যায় (host সহ পুরো subtree remove হয়), তাই এখানে আলাদা করে
    // document-level style cleanup এর দরকার নেই।
    if (window.__VE__ && window.__VE__._unbindDelegatedContainment) {
      window.__VE__._unbindDelegatedContainment();
    }
  }

  // ---------------- ছোট DOM/util helpers ----------------
  var DCE = function (tag) { return document.createElement(tag); };
  var ON = function (el, ev, fn, opt) { el.addEventListener(ev, fn, opt); return fn; };
  var OFF = function (el, ev, fn, opt) { el.removeEventListener(ev, fn, opt); };
  var APP = function (parent, child) { parent.appendChild(child); return child; };
  var NOPE = function (e) { e.preventDefault(); };
  var clamp = function (v, lo, hi) { return Math.max(lo, Math.min(hi, v)); };
  var CLS = function (el) {
    return {
      add: function () { el.classList.add.apply(el.classList, arguments); },
      remove: function () { el.classList.remove.apply(el.classList, arguments); },
      toggle: function (name, force) { el.classList.toggle(name, force); }
    };
  };

  var ATTR_FLAG = 'data-ve-enhanced';
  var hostCounter = 0;

  var CFG = {
    BOTTOM_SAFE_ZONE: 0.16,
    MULTI_TAP_WINDOW_MS: 350,
    LONG_PRESS_MS: 350,
    SEEK_STEP_SECONDS: 10,
    BOOST_SPEED: 2,
    BOOST_WATCHDOG_MS: 300,
    // এটা কোনো "boost কতক্ষণ চলবে" ফিচার-লিমিট না — pointerup/pointercancel/
    // lostpointercapture/pointerleave (এবং blur/visibilitychange, buildRig
    // এ wired) সবই ইতিমধ্যে সঠিকভাবে release ধরে endBoost() কল করে, প্লাস
    // setPointerCapture ব্যবহার করা হয় (তাই আঙুল zone-এর বাইরে সরে গেলেও
    // event miss হয় না)। এটা শুধুই একটা backstop — যদি কোনোভাবে *সবগুলো*
    // release-detection path একসাথে ব্যর্থ হয় (যেমন ব্রাউজার bug), তাহলে
    // playbackRate যেন 2x-এ চিরস্থায়ীভাবে আটকে না থাকে। যতক্ষণ ইউজার সত্যিই
    // চেপে ধরে রাখে ততক্ষণ boost চলা উচিত — তাই এই মান অনেক বড় রাখা হয়েছে।
    BOOST_SAFETY_BACKSTOP_MS: 120000,
    AUTO_HIDE_MS: 3000,
    BADGE_VISIBLE_MS: 550,
    BADGE_TRANSITION_MS: 180,
    VOLUME_BOOST_STEP: 0.5,
    VOLUME_BOOST_MAX: 3,
    // ---- Zoom(pinch) → fullscreen/rotate/fit state machine ----
    PINCH_MIN_SCALE_DELTA: 0.035,   // এতটুকু scale change হলে তবেই "real pinch" ধরা হবে
    PINCH_MAX_DRIFT_RATIO: 0.35,    // centroid, শুরুর দূরত্বের তুলনায় এর বেশি সরলে pan/drag, pinch না
    PINCH_MAX_DRIFT_PX: 24,         // ছোট শুরুর দূরত্বের জন্য absolute floor
    PINCH_MAX_WAIT_MS: 260          // এই সময়ে intent confirm না হলে বাতিল (ভুলবশত ২ আঙুল)
  };

  var IS_TOUCH = matchMedia('(pointer: coarse)').matches;
  var SUPPORTS_FULLSCREEN = !!(document.fullscreenEnabled || document.webkitFullscreenEnabled || document.documentElement.requestFullscreen);
  var SUPPORTS_ORIENTATION_LOCK = !!(window.screen && screen.orientation && screen.orientation.lock);
  var SUPPORTS_PIP = !!(document.pictureInPictureEnabled);
  var SUPPORTS_SHADOW = !!(HTMLElement.prototype.attachShadow);

  var L = {
    ROTATE: 'Rotate', UNROTATE: 'Unrotate',
    FULLSCREEN: 'Full', EXIT_FULLSCREEN: 'Exit',
    FIT_ON: 'Fit', FIT_OFF: 'Unfit',
    SWITCH_ON: 'Ctrl:Us', SWITCH_OFF: 'Ctrl:Site',
    PLAY: 'Play', PAUSE: 'Pause',
    VOL: 'Vol+', CLOSE: '✕', PIP: 'PiP'
  };

  // ---------------- সাইটের নিজস্ব fullscreen বাটন খোঁজা (best-effort) ----------------
  var FS_BTN_SELECTOR = [
    '[aria-label*="fullscreen" i]',
    '[aria-label*="full screen" i]',
    '[title*="fullscreen" i]',
    '[title*="full screen" i]',
    '[class*="fullscreen" i]',
    '[class*="full-screen" i]',
    '[data-testid*="fullscreen" i]',
    'button[class*="full" i][class*="screen" i]'
  ].join(',');

  function isVisible(el) {
    if (!el || !(el instanceof HTMLElement)) return false;
    if (el.offsetParent === null && getComputedStyle(el).position !== 'fixed') return false;
    var r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  }

  function textLooksLikeFullscreen(el) {
    var t = (el.textContent || '').trim().toLowerCase();
    return /full\s*screen/.test(t);
  }

  function findSiteFullscreenButton(video, ownFsBtn) {
    var candidates = [];
    var scopeRoots = [];
    var node = video.parentElement;
    var depth = 0;
    while (node && depth < 6) {
      scopeRoots.push(node);
      node = node.parentElement;
      depth += 1;
    }
    if (scopeRoots.length === 0 && document.body) scopeRoots.push(document.body);

    for (var i = 0; i < scopeRoots.length; i++) {
      var found = scopeRoots[i].querySelectorAll(FS_BTN_SELECTOR);
      for (var j = 0; j < found.length; j++) candidates.push(found[j]);
    }
    if (candidates.length === 0) {
      for (var k = 0; k < scopeRoots.length; k++) {
        var buttons = scopeRoots[k].querySelectorAll('button, [role="button"]');
        for (var m = 0; m < buttons.length; m++) {
          if (textLooksLikeFullscreen(buttons[m])) candidates.push(buttons[m]);
        }
      }
    }

    for (var n = 0; n < candidates.length; n++) {
      var el = candidates[n];
      if (el === ownFsBtn) continue;
      if (!isVisible(el)) continue;
      return el;
    }
    return null;
  }

  var STYLES_URL = 'https://raw.githubusercontent.com/marufhossainkeyas11/kslive/refs/heads/main/js/main.css';
  var CSS_TEXT = ''; // boot() এ fetch হয়ে বসে, প্রতিটা নতুন shadow root এই cached text ব্যবহার করে

  // ---------------- MODULE-LEVEL EVENT CONTAINMENT ----------------
  var ACTIVE_RIGS = []; // { shadowHost, active: boolean } — active=true মানে সেই rig-এর Ctrl:Us চালু

  function delegatedContainEvent(e) {
    var path = (typeof e.composedPath === 'function') ? e.composedPath() : [];
    for (var i = 0; i < ACTIVE_RIGS.length; i++) {
      var entry = ACTIVE_RIGS[i];
      if (entry.active && path.indexOf(entry.shadowHost) !== -1) {
        e.stopPropagation();
        e.stopImmediatePropagation();
        return;
      }
    }
  }

  var CONTAINED_EVENTS = ['pointerdown', 'pointerup', 'pointermove', 'pointercancel',
    'mousedown', 'mouseup', 'mousemove', 'click', 'dblclick',
    'touchstart', 'touchend', 'touchmove', 'touchcancel', 'contextmenu', 'wheel'];

  (function bindDelegatedContainmentNow() {
    CONTAINED_EVENTS.forEach(function (evName) {
      document.addEventListener(evName, delegatedContainEvent, { capture: false });
    });
    VE._unbindDelegatedContainment = function () {
      CONTAINED_EVENTS.forEach(function (evName) {
        document.removeEventListener(evName, delegatedContainEvent, { capture: false });
      });
    };
  })();

  function init() {
    document.querySelectorAll('video').forEach(attachTo);
    var mo = new MutationObserver(function (mutations) {
      mutations.forEach(function (m) {
        m.addedNodes.forEach(function (node) {
          if (!(node instanceof HTMLElement)) return;
          if (node.tagName === 'VIDEO') attachTo(node);
          node.querySelectorAll && node.querySelectorAll('video').forEach(attachTo);
        });
      });
    });
    mo.observe(document.documentElement, { childList: true, subtree: true });
    VE.instances.push({ destroy: function () { mo.disconnect(); } });
  }

  function attachTo(video) {
    if (!video || video.hasAttribute(ATTR_FLAG)) return;
    if (!SUPPORTS_SHADOW) {
      console.warn('[video-enhancer] Shadow DOM unsupported in this environment, skipping isolation-dependent UI.');
      return;
    }
    video.setAttribute(ATTR_FLAG, '1');

    var shadowHost = createShadowHost();
    var root = shadowHost.attachShadow({ mode: 'closed' });

    injectStyles(root);

    var rig = buildRig(video, root, shadowHost);
    VE.instances.push(rig);

    syncRigSize(video, shadowHost, rig);

    var ro = new ResizeObserver(function () { syncRigSize(video, shadowHost, rig); });
    ro.observe(video);
    var onWinResize = ON(window, 'resize', function () { syncRigSize(video, shadowHost, rig); });
    var onScroll = ON(window, 'scroll', function () { syncRigSize(video, shadowHost, rig); }, { capture: true, passive: true });
    var onFsChange = ON(document, 'fullscreenchange', function () {
      setTimeout(function () { syncRigSize(video, shadowHost, rig); }, 50);
      rig.onFullscreenChange();
    });

    var cleanupObserver = new MutationObserver(function () {
      if (!document.contains(video)) {
        rig.destroy();
        ro.disconnect();
        OFF(window, 'resize', onWinResize);
        OFF(window, 'scroll', onScroll, { capture: true });
        OFF(document, 'fullscreenchange', onFsChange);
        cleanupObserver.disconnect();
      }
    });
    cleanupObserver.observe(document.body, { childList: true, subtree: true });

    rig._extraCleanup = function () {
      ro.disconnect();
      OFF(window, 'resize', onWinResize);
      OFF(window, 'scroll', onScroll, { capture: true });
      OFF(document, 'fullscreenchange', onFsChange);
      cleanupObserver.disconnect();
    };
  }

  function createShadowHost() {
    hostCounter += 1;
    var host = DCE('div');
    host.id = 've-host-' + hostCounter;
    host.style.position = 'fixed';
    host.style.left = '0';
    host.style.top = '0';
    host.style.margin = '0';
    host.style.padding = '0';
    host.style.border = '0';
    host.style.pointerEvents = 'none';
    host.style.zIndex = '2147483647'; // max safe 32-bit z-index
    APP(document.body, host);
    return host;
  }

  function injectStyles(root) {
    var styleEl = DCE('style');
    styleEl.textContent = CSS_TEXT;
    root.appendChild(styleEl);
  }

  function syncRigSize(video, shadowHost, rig) {
    var vRect = video.getBoundingClientRect();
    var widthPx = vRect.width + 'px';
    var heightPx = (vRect.height * (1 - CFG.BOTTOM_SAFE_ZONE)) + 'px';

    shadowHost.style.left = vRect.left + 'px';
    shadowHost.style.top = vRect.top + 'px';
    shadowHost.style.width = widthPx;
    shadowHost.style.height = vRect.height + 'px';

    rig.gestureLayer.style.width = widthPx;
    rig.gestureLayer.style.height = heightPx;

    rig.scrim.style.width = widthPx;
    rig.scrim.style.height = vRect.height + 'px';
  }

  function makeVisibilityController(el, visibleClass, visibleMs) {
    var generation = 0;

    function show(text) {
      generation += 1;
      var myGen = generation;
      if (text !== undefined) el.textContent = text;
      el.style.display = 'block';
      void el.offsetHeight;
      CLS(el).add(visibleClass);
      if (visibleMs !== undefined) {
        setTimeout(function () {
          if (myGen !== generation) return;
          hide();
        }, visibleMs);
      }
    }

    function hide() {
      generation += 1;
      var myGen = generation;
      CLS(el).remove(visibleClass);
      setTimeout(function () {
        if (myGen !== generation) return;
        if (!el.classList.contains(visibleClass)) el.style.display = 'none';
      }, CFG.BADGE_TRANSITION_MS + 40);
    }

    return { show: show, hide: hide };
  }

  function buildRig(video, root, shadowHost) {
    var mode = { active: true }; // ডিফল্ট: শুরুতে স্ক্রিন আমাদের (Ctrl:Us) দখলে
    var uiState = { isFullscreen: false, controlsExpanded: true, autoHideTimer: null };

    var scrim = DCE('div');
    scrim.className = 've-scrim';
    APP(root, scrim);

    var gestureLayer = DCE('div');
    gestureLayer.className = 've-gesture-layer';
    var leftZone = DCE('div'), centerZone = DCE('div'), rightZone = DCE('div');
    leftZone.className = 've-zone ve-zone--left';
    centerZone.className = 've-zone ve-zone--center';
    rightZone.className = 've-zone ve-zone--right';
    APP(gestureLayer, leftZone);
    APP(gestureLayer, centerZone);
    APP(gestureLayer, rightZone);
    APP(root, gestureLayer);

    var badgeHost = DCE('div');
    badgeHost.className = 've-badge-host';
    APP(gestureLayer, badgeHost);

    var boostBadgeEl = DCE('div');
    boostBadgeEl.className = 've-badge ve-badge--boost';
    APP(badgeHost, boostBadgeEl);
    var boostBadge = makeVisibilityController(boostBadgeEl, 've-badge--visible');

    var seekLEl = DCE('div');
    seekLEl.className = 've-badge ve-badge--seek ve-badge--seek-l';
    APP(badgeHost, seekLEl);
    var seekBadgeL = makeVisibilityController(seekLEl, 've-badge--visible', CFG.BADGE_VISIBLE_MS);

    var seekREl = DCE('div');
    seekREl.className = 've-badge ve-badge--seek ve-badge--seek-r';
    APP(badgeHost, seekREl);
    var seekBadgeR = makeVisibilityController(seekREl, 've-badge--visible', CFG.BADGE_VISIBLE_MS);

    var controlBar = DCE('div');
    controlBar.className = 've-control-bar';
    APP(root, controlBar);

    var playBtn = makeButton(L.PLAY, 'Play / Pause');
    var volBtn = makeButton(L.VOL, 'Volume boost');
    var fitBtn = makeButton(L.FIT_ON, 'Fit / Zoom video');
    var fsBtn = makeButton(L.FULLSCREEN, 'Fullscreen');
    var pipBtn = makeButton(L.PIP, 'Picture-in-Picture');
    var rotateBtn = makeButton(L.ROTATE, 'Rotate to landscape');
    var switchBtn = makeButton(L.SWITCH_ON, 'Switch control between overlay and site');
    // Ctrl:Site মোডে switchBtn-এর পাশে থাকা ছোট বাটন — ক্লিক করলে হলুদ
    // switchBtn-টা বাম/ডান পাশে সরে যায় (সাইটের নিজস্ব কন্ট্রোলের সাথে
    // ওভারল্যাপ এড়াতে)
    var sideToggleBtn = makeButton('◂', 'Move indicator to the other side');
    CLS(sideToggleBtn).add('ve-btn--side-toggle');
    var closeBtn = makeButton(L.CLOSE, 'Hide controls');
    CLS(closeBtn).add('ve-btn--close');

    var allButtons = [playBtn, volBtn, fitBtn, fsBtn, pipBtn, rotateBtn, switchBtn, closeBtn];
    allButtons.forEach(function (b) { APP(controlBar, b); });
    // switchBtn-এর ঠিক আগে বসানো হচ্ছে, যাতে flex-end লেআউটে এটা
    // switchBtn-এর বাম পাশে দেখা যায়
    controlBar.insertBefore(sideToggleBtn, switchBtn);

    if (!SUPPORTS_FULLSCREEN) fsBtn.style.display = 'none';
    if (!SUPPORTS_PIP) pipBtn.style.display = 'none';
    if (!SUPPORTS_ORIENTATION_LOCK) rotateBtn.style.display = 'none';

    attachPlayPauseToggle(video, playBtn);
    var volCleanup = attachVolumeBoost(video, volBtn);
    var fitCtl = attachFitToggle(video, fitBtn, function () { return uiState.isFullscreen; });
    var fsCtl = attachFullscreenToggle(video, shadowHost, fsBtn);
    attachPipToggle(video, pipBtn);
    var rotateCtl = attachRotateToggle(video, rotateBtn);

    function setDisabled(btn, disabled) {
      btn.disabled = disabled;
      CLS(btn).toggle('ve-btn--disabled', disabled);
    }
    function syncFullscreenGatedButtons() {
      if (SUPPORTS_ORIENTATION_LOCK) setDisabled(rotateBtn, !uiState.isFullscreen);
      setDisabled(fitBtn, !uiState.isFullscreen);
    }
    syncFullscreenGatedButtons();

    var rigEntry = { shadowHost: shadowHost, active: true };
    ACTIVE_RIGS.push(rigEntry);
    function bindContainment() { rigEntry.active = true; }
    function unbindContainment() { rigEntry.active = false; }
    function removeFromRegistry() {
      var idx = ACTIVE_RIGS.indexOf(rigEntry);
      if (idx !== -1) ACTIVE_RIGS.splice(idx, 1);
    }

    // হলুদ switchBtn বাম/ডান কোন পাশে থাকবে — sideToggleBtn ক্লিকে টগল হয়
    var indicatorSide = 'right';
    function applyIndicatorSide() {
      CLS(controlBar).toggle('ve-control-bar--site-left', indicatorSide === 'left');
      sideToggleBtn.textContent = indicatorSide === 'left' ? '▸' : '◂';
    }
    applyIndicatorSide();
    ON(sideToggleBtn, 'click', function (e) {
      e.stopPropagation();
      indicatorSide = indicatorSide === 'right' ? 'left' : 'right';
      applyIndicatorSide();
    });

    function applyMode() {
      var active = mode.active;
      gestureLayer.style.pointerEvents = active ? 'auto' : 'none';
      shadowHost.style.pointerEvents = active ? 'auto' : 'none';
      CLS(scrim).toggle('ve-scrim--on', active);
      allButtons.forEach(function (b) {
        var hiddenInSiteMode = !active && b !== switchBtn;
        CLS(b).toggle('ve-btn--hidden-site-mode', hiddenInSiteMode);
        b.style.pointerEvents = (uiState.controlsExpanded && !b.disabled && !hiddenInSiteMode) ? 'auto' : 'none';
      });
      // sideToggleBtn-এর দৃশ্যমানতা বাকি বাটনের ঠিক উল্টো — শুধু Ctrl:Site
      // এ দেখা যায়, Ctrl:Us এ সম্পূর্ণ লুকানো
      CLS(sideToggleBtn).toggle('ve-btn--hidden-site-mode', active);
      sideToggleBtn.style.pointerEvents = (uiState.controlsExpanded && !active) ? 'auto' : 'none';
      CLS(switchBtn).toggle('ve-btn--switch-site', !active);
      switchBtn.textContent = active ? L.SWITCH_ON : L.SWITCH_OFF;
      if (active) bindContainment(); else unbindContainment();
    }

    function showControls() {
      uiState.controlsExpanded = true;
      CLS(controlBar).remove('ve-control-bar--hidden');
      applyMode();
      resetAutoHideTimer();
    }
    function hideControls() {
      if (!mode.active) return;
      uiState.controlsExpanded = false;
      CLS(controlBar).add('ve-control-bar--hidden');
      applyMode();
      clearTimeout(uiState.autoHideTimer);
    }
    function toggleControls() {
      if (uiState.controlsExpanded) hideControls();
      else showControls();
    }
    function resetAutoHideTimer() {
      clearTimeout(uiState.autoHideTimer);
      if (!mode.active) return;
      if (IS_TOUCH) uiState.autoHideTimer = setTimeout(hideControls, CFG.AUTO_HIDE_MS);
    }
    ON(closeBtn, 'click', function (e) { e.stopPropagation(); hideControls(); });

    if (!IS_TOUCH) {
      ON(shadowHost, 'mouseenter', showControls);
      ON(shadowHost, 'mouseleave', hideControls);
      uiState.controlsExpanded = false;
      CLS(controlBar).add('ve-control-bar--hidden');
    } else {
      resetAutoHideTimer();
    }

    ON(controlBar, 'pointerdown', resetAutoHideTimer);

    // Zoom(pinch) দিয়ে fullscreen → rotate → fit — এই ক্রমে state এগোয়
    // (zoom in/pinch-in), zoom out এ ঠিক উল্টো ক্রমে ফেরে। rotate lock
    // সাপোর্ট না থাকলে (ডেস্কটপ/iOS Safari) সেই ধাপ স্কিপ হয়ে সরাসরি
    // fullscreen↔fit চলে। mode.active===false এ gestureLayer/shadowHost-এর
    // pointer-events:none থাকায় এমনিতেই touch আমাদের পর্যন্ত পৌঁছায় না,
    // তবু সততার খাতিরে এখানেও এক্সপ্লিসিট চেক রাখা হলো।
    function handleZoomIn() {
      if (!mode.active) return;
      if (!uiState.isFullscreen) { fsCtl.toggle(); return; }
      if (SUPPORTS_ORIENTATION_LOCK && !rotateCtl.isLocked()) { rotateCtl.toggle(); return; }
      if (!fitCtl.isFit()) fitCtl.toggle();
    }
    function handleZoomOut() {
      if (!mode.active) return;
      if (!uiState.isFullscreen) return;
      if (fitCtl.isFit()) { fitCtl.toggle(); return; }
      if (SUPPORTS_ORIENTATION_LOCK && rotateCtl.isLocked()) { rotateCtl.toggle(); return; }
      fsCtl.toggle();
    }

    var gestureCtl = attachUnifiedGestures(video, {
      leftZone: leftZone, centerZone: centerZone, rightZone: rightZone,
      gestureLayer: gestureLayer,
      boostBadge: boostBadge, seekBadgeL: seekBadgeL, seekBadgeR: seekBadgeR,
      onSingleTap: toggleControls,
      onBoostStart: function () { if (uiState.controlsExpanded) hideControls(); },
      onBoostEnd: function () { resetAutoHideTimer(); },
      onSeek: function () { if (uiState.controlsExpanded) hideControls(); },
      onZoomIn: handleZoomIn,
      onZoomOut: handleZoomOut
    });

    function setMode(active) {
      mode.active = active;
      gestureCtl.forceReset();
      uiState.controlsExpanded = true;
      CLS(controlBar).remove('ve-control-bar--hidden');
      applyMode();
      if (active) resetAutoHideTimer();
      else clearTimeout(uiState.autoHideTimer);
    }
    ON(switchBtn, 'click', function (e) { e.stopPropagation(); setMode(!mode.active); });

    var onVisChange = ON(document, 'visibilitychange', function () {
      if (document.hidden) gestureCtl.forceReset();
    });
    var onBlur = ON(window, 'blur', gestureCtl.forceReset);

    applyMode();

    return {
      gestureLayer: gestureLayer,
      controlBar: controlBar,
      scrim: scrim,
      onFullscreenChange: function () {
        var iAmFullscreen = !!(document.fullscreenElement &&
          document.fullscreenElement.contains(video));
        uiState.isFullscreen = iAmFullscreen;
        fsBtn.textContent = iAmFullscreen ? L.EXIT_FULLSCREEN : L.FULLSCREEN;
        syncFullscreenGatedButtons();
        if (iAmFullscreen) {
          fsCtl.adoptIntoSiteFullscreen();
        } else {
          fsCtl.restoreIfMoved();
          fsCtl.releaseFromSiteFullscreen();
        }
      },
      destroy: function () {
        gestureCtl.forceReset();
        gestureCtl.destroy();
        if (volCleanup) volCleanup();
        unbindContainment();
        removeFromRegistry();
        OFF(document, 'visibilitychange', onVisChange);
        OFF(window, 'blur', onBlur);
        fsCtl.restoreIfMoved();
        fsCtl.releaseFromSiteFullscreen();
        shadowHost.remove();
        clearTimeout(uiState.autoHideTimer);
        if (this._extraCleanup) this._extraCleanup();
      }
    };
  }

  function makeButton(label, title) {
    var b = DCE('button');
    b.type = 'button';
    b.textContent = label;
    b.title = title;
    b.className = 've-btn' + (IS_TOUCH ? '' : ' ve-btn--desktop');
    ON(b, 'pointerdown', function () { if (!b.disabled) b.style.transform = 'scale(.92)'; });
    ON(b, 'pointerup', function () { b.style.transform = ''; });
    ON(b, 'pointerleave', function () { b.style.transform = ''; });
    return b;
  }

  function togglePlay(video) {
    if (video.paused) video.play().catch(function () {});
    else video.pause();
  }

  function attachPlayPauseToggle(video, btn) {
    function sync() { btn.textContent = video.paused ? L.PLAY : L.PAUSE; }
    sync();
    ON(btn, 'click', function (e) { e.stopPropagation(); togglePlay(video); });
    ON(video, 'play', sync);
    ON(video, 'pause', sync);
  }

  function attachVolumeBoost(video, btn) {
    var ctx = null, gainNode = null, sourceNode = null, level = 1, tried = false;

    function tryBuildGraph() {
      tried = true;
      try {
        var AC = window.AudioContext || window.webkitAudioContext;
        ctx = new AC();
        sourceNode = ctx.createMediaElementSource(video);
        gainNode = ctx.createGain();
        gainNode.gain.value = level;
        sourceNode.connect(gainNode).connect(ctx.destination);
        return true;
      } catch (err) {
        console.warn('[video-enhancer] Volume boost impossible on this video (audio graph already owned):', err.message);
        return false;
      }
    }

    var onClick = ON(btn, 'click', function (e) {
      e.stopPropagation();
      if (!ctx && !tried) {
        if (!tryBuildGraph()) {
          btn.style.display = 'none';
          return;
        }
      }
      if (!ctx) return;
      if (ctx.state === 'suspended') ctx.resume();
      level += CFG.VOLUME_BOOST_STEP;
      if (level > CFG.VOLUME_BOOST_MAX) level = 1;
      gainNode.gain.value = level;
      btn.textContent = level === 1 ? 'Vol+' : Math.round(level * 100) + '%';
    });

    return function cleanup() {
      OFF(btn, 'click', onClick);
      if (ctx && ctx.state !== 'closed' && ctx.close) ctx.close().catch(function () {});
    };
  }

  function attachUnifiedGestures(video, refs) {
    var pressTimer = null;
    var boostWatchdog = null;
    var boostSafetyCap = null;
    var isBoosting = false;
    var desiredRate = null;
    var rateBeforeBoost = 1;
    var activePointerId = null;
    var pressMoved = false;
    var startX = 0, startY = 0;
    var MOVE_TOLERANCE = 10;

    var seekSeq = { left: { count: 0, timer: null }, right: { count: 0, timer: null } };
    var centerSeq = { count: 0, timer: null };

    // ---------- ২-আঙুল Zoom/Pinch ট্র্যাকিং (single-finger লজিক থেকে
    // আলাদা; ২য় আঙুল নামলেই forceReset() কল করে single-finger অংশ বাতিল
    // হয়ে যায়, নাহলে দুই zone-এ activePointerId ওভাররাইট হয়ে বাগ হতো) ----------
    var pinchPointers = {}; // pointerId(string) -> {x, y}
    var pinchCount = 0;
    var pinchStartDist = 0;
    var pinchStartCenter = { x: 0, y: 0 };
    var pinchStartTime = 0;
    var pinchConfirmed = false;
    var pinchDirection = null; // 'in' | 'out'

    function clearPressTimer() {
      if (pressTimer !== null) { clearTimeout(pressTimer); pressTimer = null; }
    }

    function startBoost() {
      rateBeforeBoost = (video.playbackRate === CFG.BOOST_SPEED) ? 1 : video.playbackRate;
      desiredRate = CFG.BOOST_SPEED;
      video.playbackRate = desiredRate;
      isBoosting = true;
      refs.boostBadge.show('2X');
      if (refs.onBoostStart) refs.onBoostStart();

      clearInterval(boostWatchdog);
      boostWatchdog = setInterval(function () {
        if (desiredRate === null) return;
        if (video.playbackRate !== desiredRate) {
          video.playbackRate = desiredRate;
        }
      }, CFG.BOOST_WATCHDOG_MS);

      clearTimeout(boostSafetyCap);
      boostSafetyCap = setTimeout(endBoost, CFG.BOOST_SAFETY_BACKSTOP_MS);
    }

    function endBoost() {
      clearTimeout(boostSafetyCap);
      clearInterval(boostWatchdog);
      boostWatchdog = null;
      if (!isBoosting) return;
      isBoosting = false;
      desiredRate = null;
      if (video.playbackRate === CFG.BOOST_SPEED) {
        video.playbackRate = rateBeforeBoost || 1;
      }
      refs.boostBadge.hide();
      if (refs.onBoostEnd) refs.onBoostEnd();
    }

    function resetSeekSeq(side) { clearTimeout(seekSeq[side].timer); seekSeq[side].count = 0; }
    function resetCenterSeq() { clearTimeout(centerSeq.timer); centerSeq.count = 0; }
    function forceReset() {
      clearPressTimer();
      endBoost();
      activePointerId = null;
      resetSeekSeq('left'); resetSeekSeq('right'); resetCenterSeq();
    }

    function zoneOf(target) {
      if (target === refs.leftZone) return 'left';
      if (target === refs.rightZone) return 'right';
      return 'center';
    }

    function startPress(pointerId, clientX, clientY) {
      activePointerId = pointerId;
      pressMoved = false;
      startX = clientX; startY = clientY;
      clearPressTimer();
      pressTimer = setTimeout(function () {
        if (activePointerId !== pointerId || pressMoved) return;
        startBoost();
      }, CFG.LONG_PRESS_MS);
    }

    function doSeek(side, taps) {
      var seconds = CFG.SEEK_STEP_SECONDS * taps;
      var delta = side === 'left' ? -seconds : seconds;
      video.currentTime = clamp(video.currentTime + delta, 0, video.duration || Infinity);
      var badge = side === 'left' ? refs.seekBadgeL : refs.seekBadgeR;
      badge.show((delta > 0 ? '+' : '') + delta + 's');
    }

    function handleZoneTap(side) {
      var s = seekSeq[side];
      s.count += 1;
      clearTimeout(s.timer);
      if (s.count >= 2) {
        doSeek(side, s.count - 1);
        if (refs.onSeek) refs.onSeek();
      }
      s.timer = setTimeout(function () {
        var wasSeek = s.count >= 2;
        s.count = 0;
        if (!wasSeek && refs.onSingleTap) refs.onSingleTap();
      }, CFG.MULTI_TAP_WINDOW_MS);
    }

    function handleCenterTap() {
      centerSeq.count += 1;
      clearTimeout(centerSeq.timer);
      if (centerSeq.count === 2) {
        togglePlay(video);
        centerSeq.count = 0;
        return;
      }
      centerSeq.timer = setTimeout(function () {
        centerSeq.count = 0;
        if (refs.onSingleTap) refs.onSingleTap();
      }, CFG.MULTI_TAP_WINDOW_MS);
    }

    function endPress(pointerId, zoneEl, wasReleaseInsideSameZone) {
      if (activePointerId !== pointerId) return;
      clearPressTimer();
      activePointerId = null;
      if (isBoosting) { endBoost(); return; }
      if (!wasReleaseInsideSameZone || pressMoved) return;
      var side = zoneOf(zoneEl);
      if (side === 'center') handleCenterTap();
      else handleZoneTap(side);
    }

    // বুস্ট চলাকালীন zone-এর নিজস্ব pointerup/pointercancel কোনো কারণে
    // (buffering-এর সময় shadow DOM hit-test shift ইত্যাদি) মিস হয়ে গেলেও
    // যেন বুস্ট আঙুল ছাড়ার সাথে সাথেই থামে — capture-phase এ document-এ
    // বসানো এই ব্যাকআপ target-phase-এর *আগেই* ফায়ার করে। zone-level
    // handler পরে আবার endPress() কল করলেও ততক্ষণে activePointerId null
    // থাকায় নিরাপদে কিছুই করে না (duplicate-call-safe)।
    function handleGlobalPointerEnd(e) {
      if (activePointerId !== e.pointerId) return;
      if (isBoosting) {
        clearPressTimer();
        activePointerId = null;
        endBoost();
      }
    }

    // ---------- Pinch/Zoom হেল্পার ----------
    function pinchIds() { return Object.keys(pinchPointers); }
    function pinchDist() {
      var ids = pinchIds();
      var a = pinchPointers[ids[0]], b = pinchPointers[ids[1]];
      return Math.hypot(a.x - b.x, a.y - b.y);
    }
    function pinchCenter() {
      var ids = pinchIds();
      var a = pinchPointers[ids[0]], b = pinchPointers[ids[1]];
      return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    }
    function resetPinchTracking() {
      pinchPointers = {};
      pinchCount = 0;
      pinchConfirmed = false;
      pinchDirection = null;
      pinchStartDist = 0;
    }

    function onGesturePointerDown(e) {
      var key = String(e.pointerId);
      if (!(key in pinchPointers)) pinchCount += 1;
      pinchPointers[key] = { x: e.clientX, y: e.clientY };
      if (pinchCount === 2) {
        // ২য় আঙুল নামলো — single-finger tap/press/boost বাতিল করে দিয়ে
        // এখন থেকে এটা সম্ভাব্য pinch হিসেবে ট্র্যাক করা হবে
        forceReset();
        pinchStartDist = pinchDist();
        pinchStartCenter = pinchCenter();
        pinchStartTime = performance.now();
        pinchConfirmed = false;
        pinchDirection = null;
      } else if (pinchCount > 2) {
        resetPinchTracking();
      }
    }

    function onGesturePointerMove(e) {
      var key = String(e.pointerId);
      if (!(key in pinchPointers)) return;
      pinchPointers[key] = { x: e.clientX, y: e.clientY };
      if (pinchCount !== 2) return;

      var dist = pinchDist();
      var center = pinchCenter();
      var rawScale = dist / pinchStartDist;
      var elapsed = performance.now() - pinchStartTime;
      var scaleDelta = Math.abs(rawScale - 1);
      var centroidDrift = Math.hypot(center.x - pinchStartCenter.x, center.y - pinchStartCenter.y);
      var driftLimit = Math.max(CFG.PINCH_MAX_DRIFT_PX, pinchStartDist * CFG.PINCH_MAX_DRIFT_RATIO);

      if (pinchConfirmed) { e.preventDefault(); return; }

      if (centroidDrift > driftLimit && scaleDelta < CFG.PINCH_MIN_SCALE_DELTA) {
        // দুই আঙুল একসাথে সরছে (pan/drag), distance বদলাচ্ছে না — pinch না
        resetPinchTracking();
        return;
      }
      if (scaleDelta >= CFG.PINCH_MIN_SCALE_DELTA) {
        // দিক একবারই ঠিক হয় (প্রথম confirm-এর মুহূর্তে); মাঝপথে দিক
        // পাল্টালেও এই gesture-এর জন্য প্রথম দিকটাই ধরা থাকবে
        pinchConfirmed = true;
        pinchDirection = rawScale > 1 ? 'in' : 'out';
        e.preventDefault();
        return;
      }
      if (elapsed > CFG.PINCH_MAX_WAIT_MS) {
        resetPinchTracking(); // অনেকক্ষণ প্রায় স্থির — ভুলবশত আঙুল লেগে ছিল
      }
    }

    function onGesturePointerUp(e) {
      var key = String(e.pointerId);
      if (!(key in pinchPointers)) return;
      delete pinchPointers[key];
      pinchCount -= 1;
      if (pinchCount >= 2) return;
      if (pinchConfirmed) {
        if (pinchDirection === 'in' && refs.onZoomIn) refs.onZoomIn();
        else if (pinchDirection === 'out' && refs.onZoomOut) refs.onZoomOut();
      }
      resetPinchTracking();
    }

    var listeners = [];
    function bind(el, ev, fn, opt) { listeners.push([el, ev, fn, opt]); ON(el, ev, fn, opt); }

    [refs.leftZone, refs.centerZone, refs.rightZone].forEach(function (zone) {
      bind(zone, 'pointerdown', function (e) {
        e.preventDefault();
        if (zone.setPointerCapture) { try { zone.setPointerCapture(e.pointerId); } catch (err) {} }
        startPress(e.pointerId, e.clientX, e.clientY);
      });
      bind(zone, 'pointermove', function (e) {
        if (activePointerId !== e.pointerId) return;
        if (Math.abs(e.clientX - startX) > MOVE_TOLERANCE || Math.abs(e.clientY - startY) > MOVE_TOLERANCE) {
          pressMoved = true;
        }
      });
      bind(zone, 'pointerup', function (e) { endPress(e.pointerId, zone, true); });
      bind(zone, 'pointercancel', function (e) { endPress(e.pointerId, zone, false); });
      bind(zone, 'lostpointercapture', function (e) { endPress(e.pointerId, zone, false); });
      bind(zone, 'pointerleave', function (e) {
        if (activePointerId === e.pointerId && isBoosting) endBoost();
      });
      bind(zone, 'contextmenu', NOPE);
      bind(zone, 'selectstart', NOPE);
      bind(zone, 'dragstart', NOPE);
      bind(zone, 'touchstart', NOPE, { passive: false });
    });

    // pinch ট্র্যাকিং gestureLayer লেভেলে (zone-দের parent) — দুই আঙুল
    // দুই ভিন্ন zone-এ পড়লেও bubble করে এখানেই দুটো পয়েন্টার ধরা পড়ে
    bind(refs.gestureLayer, 'pointerdown', onGesturePointerDown);
    bind(refs.gestureLayer, 'pointermove', onGesturePointerMove);
    bind(refs.gestureLayer, 'pointerup', onGesturePointerUp);
    bind(refs.gestureLayer, 'pointercancel', onGesturePointerUp);

    // বুস্ট-রিলিজ ব্যাকআপ (capture:true, document) — উপরের নোট দেখুন
    bind(document, 'pointerup', handleGlobalPointerEnd, { capture: true });
    bind(document, 'pointercancel', handleGlobalPointerEnd, { capture: true });

    var onRateChange = ON(video, 'ratechange', function () { /* watchdog handles reassert */ });

    return {
      forceReset: forceReset,
      destroy: function () {
        forceReset();
        resetPinchTracking();
        listeners.forEach(function (l) { OFF(l[0], l[1], l[2], l[3]); });
        OFF(video, 'ratechange', onRateChange);
      }
    };
  }

  function attachFullscreenToggle(video, shadowHost, btn) {
    if (!SUPPORTS_FULLSCREEN) {
      return {
        restoreIfMoved: function () {},
        adoptIntoSiteFullscreen: function () {},
        releaseFromSiteFullscreen: function () {},
        toggle: function () {},
        isActive: function () { return false; }
      };
    }

    var SITE_BTN_VERIFY_MS = 400;

    var fullscreenWrapper = null;
    var videoOriginalParent = null, videoOriginalNextSibling = null;
    var hostOriginalParent = null, hostOriginalNextSibling = null;
    var hostOriginalPosition = '';
    var usingOwnFallback = false;
    var videoOriginalInlineStyle = null;

    var movedIntoSiteFullscreen = false;
    var siteFsOriginalParent = null, siteFsOriginalNextSibling = null;

    function buildWrapper() {
      var w = DCE('div');
      w.className = 've-fullscreen-wrapper';
      w.style.position = 'fixed';
      w.style.left = '0'; w.style.top = '0';
      w.style.width = '100%'; w.style.height = '100%';
      w.style.margin = '0'; w.style.padding = '0'; w.style.border = '0';
      w.style.background = '#000';
      w.style.zIndex = '2147483647';
      return w;
    }

    function enterOwnFallback() {
      if (usingOwnFallback) return;
      fullscreenWrapper = buildWrapper();

      videoOriginalParent = video.parentNode;
      videoOriginalNextSibling = video.nextSibling;
      hostOriginalParent = shadowHost.parentNode;
      hostOriginalNextSibling = shadowHost.nextSibling;
      hostOriginalPosition = shadowHost.style.position;
      videoOriginalInlineStyle = video.getAttribute('style');

      APP(document.body, fullscreenWrapper);
      fullscreenWrapper.appendChild(video);
      video.style.width = '100%';
      video.style.height = '100%';
      video.style.objectFit = 'contain';
      video.style.background = '#000';

      shadowHost.style.position = 'absolute';
      fullscreenWrapper.appendChild(shadowHost);

      usingOwnFallback = true;
    }

    function exitOwnFallback() {
      if (!usingOwnFallback) return;
      if (videoOriginalInlineStyle === null) {
        video.removeAttribute('style');
      } else {
        video.setAttribute('style', videoOriginalInlineStyle);
      }
      if (videoOriginalParent) {
        videoOriginalParent.insertBefore(video, videoOriginalNextSibling);
      }
      shadowHost.style.position = hostOriginalPosition;
      if (hostOriginalParent) {
        hostOriginalParent.insertBefore(shadowHost, hostOriginalNextSibling);
      }
      if (fullscreenWrapper && fullscreenWrapper.parentNode) {
        fullscreenWrapper.parentNode.removeChild(fullscreenWrapper);
      }
      fullscreenWrapper = null;
      videoOriginalParent = null; videoOriginalNextSibling = null;
      hostOriginalParent = null; hostOriginalNextSibling = null;
      videoOriginalInlineStyle = null;
      usingOwnFallback = false;
    }

    function adoptIntoSiteFullscreen() {
      if (usingOwnFallback || movedIntoSiteFullscreen) return;
      var fsEl = document.fullscreenElement;
      if (!fsEl || !fsEl.contains(video)) return;
      if (fsEl === video) return;
      if (shadowHost.parentNode === fsEl) return;
      siteFsOriginalParent = shadowHost.parentNode;
      siteFsOriginalNextSibling = shadowHost.nextSibling;
      shadowHost.style.position = 'absolute';
      fsEl.appendChild(shadowHost);
      movedIntoSiteFullscreen = true;
    }

    function releaseFromSiteFullscreen() {
      if (!movedIntoSiteFullscreen) return;
      shadowHost.style.position = 'fixed';
      if (siteFsOriginalParent) {
        siteFsOriginalParent.insertBefore(shadowHost, siteFsOriginalNextSibling);
      } else {
        APP(document.body, shadowHost);
      }
      siteFsOriginalParent = null; siteFsOriginalNextSibling = null;
      movedIntoSiteFullscreen = false;
    }

    function delay(ms) { return new Promise(function (res) { setTimeout(res, ms); }); }

    function isActive() {
      return !!(document.fullscreenElement && document.fullscreenElement.contains(video));
    }

    // মূল toggle লজিক — বাটন ক্লিক আর zoom-gesture state machine দুটো
    // জায়গা থেকেই এই একই ফাংশন কল হয়, যাতে লজিক ডুপ্লিকেট না হয়
    async function performToggle() {
      if (isActive()) {
        try { await document.exitFullscreen(); } catch (err) {
          console.warn('[video-enhancer] exitFullscreen failed:', err.message);
        }
        exitOwnFallback();
        return;
      }

      var siteBtn = findSiteFullscreenButton(video, btn);
      if (siteBtn) {
        try {
          siteBtn.click();
          await delay(SITE_BTN_VERIFY_MS);
          if (document.fullscreenElement && document.fullscreenElement.contains(video)) {
            if (document.fullscreenElement !== video) return;
            try { await document.exitFullscreen(); } catch (exitErr) {}
          }
        } catch (err) {
          console.warn('[video-enhancer] site fullscreen button click failed:', err.message);
        }
      }

      try {
        enterOwnFallback();
        await fullscreenWrapper.requestFullscreen();
      } catch (err) {
        console.warn('[video-enhancer] fullscreen fallback failed:', err.message);
        exitOwnFallback();
      }
    }

    ON(btn, 'click', function (e) { e.stopPropagation(); performToggle(); });

    return {
      restoreIfMoved: exitOwnFallback,
      adoptIntoSiteFullscreen: adoptIntoSiteFullscreen,
      releaseFromSiteFullscreen: releaseFromSiteFullscreen,
      toggle: performToggle,
      isActive: isActive
    };
  }

  function attachPipToggle(video, btn) {
    if (!SUPPORTS_PIP) return;
    ON(btn, 'click', async function (e) {
      e.stopPropagation();
      try {
        if (document.pictureInPictureElement) await document.exitPictureInPicture();
        else await video.requestPictureInPicture();
      } catch (err) {
        console.warn('[video-enhancer] PiP toggle failed:', err.message);
      }
    });
    ON(video, 'enterpictureinpicture', function () { btn.textContent = 'Exit PiP'; });
    ON(video, 'leavepictureinpicture', function () { btn.textContent = L.PIP; });
  }

  function attachRotateToggle(video, btn) {
    if (!SUPPORTS_ORIENTATION_LOCK) {
      return { toggle: function () {}, isLocked: function () { return false; } };
    }
    var isLocked = false;

    async function performToggle() {
      try {
        if (isLocked) {
          if (screen.orientation && screen.orientation.unlock) screen.orientation.unlock();
          isLocked = false; btn.textContent = L.ROTATE;
        } else {
          if (screen.orientation && screen.orientation.lock) await screen.orientation.lock('landscape');
          isLocked = true; btn.textContent = L.UNROTATE;
        }
      } catch (err) {
        console.warn('[video-enhancer] rotate lock failed:', err.message);
      }
    }

    ON(btn, 'click', function (e) { e.stopPropagation(); performToggle(); });

    ON(document, 'fullscreenchange', function () {
      var stillFullscreenForThisVideo = !!(document.fullscreenElement &&
        document.fullscreenElement.contains(video));
      if (!stillFullscreenForThisVideo && isLocked) { isLocked = false; btn.textContent = L.ROTATE; }
    });

    return { toggle: performToggle, isLocked: function () { return isLocked; } };
  }

  function attachFitToggle(video, btn, isFullscreenGetter) {
    var isFit = false, savedStyle = null;

    function performToggle() {
      if (!isFullscreenGetter()) return;
      isFit = !isFit;
      if (isFit) {
        savedStyle = { objectFit: video.style.objectFit, transform: video.style.transform, width: video.style.width, height: video.style.height };
        video.style.objectFit = 'cover';
        video.style.width = '100%';
        video.style.height = '100%';
        btn.textContent = L.FIT_OFF;
      } else {
        video.style.objectFit = savedStyle.objectFit || '';
        video.style.transform = savedStyle.transform || '';
        video.style.width = savedStyle.width || '';
        video.style.height = savedStyle.height || '';
        btn.textContent = L.FIT_ON;
      }
    }

    ON(btn, 'click', function (e) { e.stopPropagation(); performToggle(); });

    ON(document, 'fullscreenchange', function () {
      var stillFullscreenForThisVideo = !!(document.fullscreenElement &&
        document.fullscreenElement.contains(video));
      if (!stillFullscreenForThisVideo && isFit) {
        video.style.objectFit = savedStyle ? (savedStyle.objectFit || '') : '';
        video.style.transform = savedStyle ? (savedStyle.transform || '') : '';
        video.style.width = savedStyle ? (savedStyle.width || '') : '';
        video.style.height = savedStyle ? (savedStyle.height || '') : '';
        isFit = false;
        btn.textContent = L.FIT_ON;
      }
    });

    return { toggle: performToggle, isFit: function () { return isFit; } };
  }

  function boot() {
    fetch(STYLES_URL + '?v=' + Date.now(), { cache: 'no-store' })
      .then(function (r) {
        if (!r.ok) throw new Error('styles.css HTTP ' + r.status);
        return r.text();
      })
      .then(function (cssText) { CSS_TEXT = cssText; init(); })
      .catch(function (err) {
        console.warn('[video-enhancer] failed to load styles.css, proceeding without it:', err.message);
        CSS_TEXT = '';
        init();
      });
  }

  function runInit() {
    if (document.readyState === 'loading') {
      ON(document, 'DOMContentLoaded', boot);
    } else {
      boot();
    }
  }

  runInit();
})();
