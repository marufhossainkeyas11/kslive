/*!
 * Video Enhancer - main.js
 * ============================================================================
 * সম্পূর্ণ রিডিজাইন — patch-over-patch না করে গোড়া থেকে আর্কিটেকচার ঠিক করা
 * হয়েছে। মূল নীতি চারটা:
 *
 *  (A) SINGLE SOURCE OF TRUTH FOR CONTROL OWNERSHIP
 *      "কে ভিডিওর ইনপুট পাচ্ছে — আমরা, নাকি সাইট" — এই একটা প্রশ্নের উত্তর
 *      সবসময় ঠিক একটা জায়গায় (`mode.active`) থাকে, আর `applyMode()` নামের
 *      একটাই ফাংশন সব DOM/pointer-events সেই state অনুযায়ী sync করে। কোনো
 *      জায়গায় আলাদাভাবে pointer-events সেট করা হয় না — তাই "টগল করলাম কিন্তু
 *      কোথাও পুরনো state রয়ে গেছে" জাতীয় বাগ কাঠামোগতভাবেই সম্ভব না।
 *      Ctrl:Us  → gesture layer pointer-events:auto, সাইট প্লেয়ারে কোনো
 *                 ট্যাপ/ক্লিক পৌঁছায় না (আমরা z-index সর্বোচ্চে বসে পুরো
 *                 এলাকা দখল করে রাখি)।
 *      Ctrl:Site→ gesture layer pointer-events:none (ট্যাপ সরাসরি নিচের সাইট
 *                 প্লেয়ারে চলে যায়), কিন্তু control bar (উপরের বাটন-স্ট্রিপ)
 *                 সবসময় pointer-events:auto থাকে — কারণ bar ছাড়া আর Us
 *                 মোডে ফেরার উপায় থাকবে না।
 *
 *  (B) OWNED-RESOURCE LOCKING (playbackRate)
 *      2x-hold চলাকালীন playbackRate "আমাদের" সম্পদ — সাইটের প্লেয়ার
 *      (JW/Video.js/hls.js ইত্যাদি) buffering/quality-switch/নিজস্ব শর্টকাটে
 *      rate পাল্টে দিলেও একটা 300ms watchdog interval সেটাকে জোর করে আবার
 *      কাঙ্ক্ষিত rate এ ফিরিয়ে আনে, যতক্ষণ বুস্ট সক্রিয়। বুস্ট শেষ হলে
 *      watchdog rate টাচ করা বন্ধ করে দেয় এবং মূল rate এ ফেরত দেয়। এর উপরে
 *      একটা hard safety-cap (৮ সেকেন্ড) থাকে যাতে কোনো bug এ বুস্ট চিরস্থায়ী
 *      হয়ে না যায়।
 *
 *  (C) HONEST UI FOR IMPOSSIBLE OPERATIONS (Volume Boost)
 *      createMediaElementSource() একটা video element এ জীবনে একবারই সফল
 *      হতে পারে ব্রাউজার স্পেসিফিকেশন অনুযায়ী। সাইট আগেই audio graph বানিয়ে
 *      রাখলে bypass করার কোনো উপায় নেই — মিথ্যা আশ্বাস ("N/A" দেখিয়ে বাটন
 *      রেখে দেওয়া) না দিয়ে প্রথম চেষ্টা ব্যর্থ হলেই বাটন সম্পূর্ণ hide করে
 *      দেওয়া হয়।
 *
 *  (D) GENERATION-COUNTER STATE MACHINES FOR UI (badges, control bar)
 *      প্রতিটা show/hide UI ইউনিটের নিজস্ব integer "generation"। show() কল
 *      হলেই generation++ হয়; hide callback নিজের generation বহন করে এবং
 *      কাজ করার আগে verify করে সেটা এখনো current কিনা। ফলে দ্রুত পরপর একাধিক
 *      show/hide কল হলেও (যেটা আগে race condition তৈরি করত) কখনো ভুল সময়ে
 *      hide/show ঘটে না।
 *
 * এই ফাইলটা GitHub raw থেকে fetch করে bookmarklet inject করে। bookmarklet
 * সোর্স আলাদা ফাইলে (bookmarklet.js) আছে — সেটা Trusted-Types-aware, YouTube
 * সহ সব CSP-কড়া সাইটে কাজ করার জন্য বানানো।
 * ============================================================================
 */
(function () {
  'use strict';

  // ডাবল-ইনজেকশন গার্ড — বুকমার্কলেট বারবার চাপলে পুরনো ইনস্ট্যান্স প্রথমে
  // পুরোপুরি tear down করে, তারপর নতুন করে শুরু করে (stale listener/interval
  // জমে থাকবে না)
  if (window.__VE__ && typeof window.__VE__.teardown === 'function') {
    window.__VE__.teardown();
  }

  var VE = { instances: [], teardown: teardownAll };
  window.__VE__ = VE;

  function teardownAll() {
    VE.instances.forEach(function (inst) { inst.destroy(); });
    VE.instances = [];
  }

  // ---------------- ছোট DOM/util helpers ----------------
  var DCE = function (tag) { return document.createElement(tag); };
  var ON = function (el, ev, fn, opt) { el.addEventListener(ev, fn, opt); return fn; };
  var OFF = function (el, ev, fn, opt) { el.removeEventListener(ev, fn, opt); };
  var APP = function (parent, child) { parent.appendChild(child); return child; };
  var NOPE = function (e) { e.preventDefault(); };
  var ABS = 'position:absolute;';
  var clamp = function (v, lo, hi) { return Math.max(lo, Math.min(hi, v)); };

  var ATTR_FLAG = 'data-ve-enhanced';

  // ---------------- Config constants ----------------
  var CFG = {
    BOTTOM_SAFE_ZONE: 0.16,       // নিচের এই অংশ gesture layer এর বাইরে (সাইটের নিজস্ব সিক-বার এর জন্য জায়গা)
    MULTI_TAP_WINDOW_MS: 350,
    LONG_PRESS_MS: 350,
    SEEK_STEP_SECONDS: 10,
    BOOST_SPEED: 2,
    BOOST_WATCHDOG_MS: 300,       // এই ইন্টারভ্যালে rate lock reassert হয়
    BOOST_MAX_DURATION_MS: 8000,  // hard safety cap
    AUTO_HIDE_MS: 3000,
    BADGE_VISIBLE_MS: 550,
    BADGE_TRANSITION_MS: 180,
    VOLUME_BOOST_STEP: 0.5,
    VOLUME_BOOST_MAX: 3
  };

  var Z = {
    CONTROL: 2147483000,
    GESTURE: 2147482999
  };

  var IS_TOUCH = matchMedia('(pointer: coarse)').matches;
  var SUPPORTS_FULLSCREEN = !!(document.fullscreenEnabled || document.webkitFullscreenEnabled || document.documentElement.requestFullscreen);
  var SUPPORTS_ORIENTATION_LOCK = !!(window.screen && screen.orientation && screen.orientation.lock);
  var SUPPORTS_PIP = !!(document.pictureInPictureEnabled);

  var L = {
    ROTATE: 'Rotate', UNROTATE: 'Unrotate',
    FULLSCREEN: 'Full', EXIT_FULLSCREEN: 'Exit',
    FIT_ON: 'Fit', FIT_OFF: 'Unfit',
    SWITCH_ON: 'Ctrl:Us', SWITCH_OFF: 'Ctrl:Site',
    PLAY: 'Play', PAUSE: 'Pause',
    VOL: 'Vol+', CLOSE: '✕', PIP: 'PiP'
  };

  // ============================================================================
  // Bootstrap: সব <video> খুঁজে বের করে rig বসানো, DOM এ নতুন ভিডিও এলে auto-attach
  // ============================================================================
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
    video.setAttribute(ATTR_FLAG, '1');

    var container = ensureContainer(video);
    var rig = buildRig(video, container);
    VE.instances.push(rig);

    syncRigSize(video, rig);

    var ro = new ResizeObserver(function () { syncRigSize(video, rig); });
    ro.observe(video);
    var onWinResize = ON(window, 'resize', function () { syncRigSize(video, rig); });
    var onFsChange = ON(document, 'fullscreenchange', function () {
      setTimeout(function () { syncRigSize(video, rig); }, 50);
      rig.onFullscreenChange();
    });

    var cleanupObserver = new MutationObserver(function () {
      if (!document.contains(video)) {
        rig.destroy();
        ro.disconnect();
        OFF(window, 'resize', onWinResize);
        OFF(document, 'fullscreenchange', onFsChange);
        cleanupObserver.disconnect();
      }
    });
    cleanupObserver.observe(document.body, { childList: true, subtree: true });

    rig._extraCleanup = function () {
      ro.disconnect();
      OFF(window, 'resize', onWinResize);
      OFF(document, 'fullscreenchange', onFsChange);
      cleanupObserver.disconnect();
    };
  }

  function ensureContainer(video) {
    var parent = video.parentElement;
    var style = getComputedStyle(parent);
    if (style.position === 'static') parent.style.position = 'relative';
    return parent;
  }

  function syncRigSize(video, rig) {
    var vRect = video.getBoundingClientRect();
    var pRect = video.parentElement.getBoundingClientRect();
    rig.gestureLayer.style.left = (vRect.left - pRect.left) + 'px';
    rig.gestureLayer.style.top = (vRect.top - pRect.top) + 'px';
    rig.gestureLayer.style.width = vRect.width + 'px';
  }

  // ============================================================================
  // (D) Generation-counter ভিত্তিক badge/visibility state machine
  // ============================================================================
  function makeVisibilityController(el, opts) {
    opts = opts || {};
    var showTransform = opts.showTransform || '';
    var hideTransform = opts.hideTransform || '';
    var visibleMs = opts.visibleMs; // undefined হলে auto-hide করবে না (কন্ট্রোল বার এর জন্য বাইরে থেকে ম্যানেজ হবে)
    var generation = 0;
    var isVisible = false;

    function show(text) {
      generation += 1;
      var myGen = generation;
      if (text !== undefined) el.textContent = text;
      el.style.display = 'block';
      void el.offsetHeight; // reflow — transition রিস্টার্ট নিশ্চিত করা
      el.style.opacity = '1';
      el.style.transform = showTransform;
      isVisible = true;
      if (visibleMs !== undefined) {
        setTimeout(function () {
          if (myGen !== generation) return; // এই ফাঁকে আবার show হয়ে গেছে, পুরনো hide বাতিল
          hide();
        }, visibleMs);
      }
    }

    function hide() {
      generation += 1;
      var myGen = generation;
      el.style.opacity = '0';
      el.style.transform = hideTransform;
      isVisible = false;
      setTimeout(function () {
        if (myGen !== generation) return; // ফাঁকে আবার show হয়েছে
        if (el.style.opacity === '0') el.style.display = 'none';
      }, CFG.BADGE_TRANSITION_MS + 40);
    }

    return { show: show, hide: hide, isVisible: function () { return isVisible; } };
  }

  // ============================================================================
  // Rig — একটা ভিডিওর জন্য সম্পূর্ণ overlay + gesture + control সিস্টেম
  // ============================================================================
  function buildRig(video, container) {
    var mode = { active: true }; // true = Ctrl:Us (আমরা মালিক), false = Ctrl:Site
    var uiState = { isFullscreen: false, controlsExpanded: true, autoHideTimer: null };

    // ---------------- Gesture layer ----------------
    var gestureLayer = DCE('div');
    gestureLayer.style.cssText = ABS + 'left:0;top:0;width:100%;' +
      'height:' + ((1 - CFG.BOTTOM_SAFE_ZONE) * 100) + '%;' +
      'display:flex;touch-action:manipulation;' +
      'user-select:none;-webkit-user-select:none;z-index:' + Z.GESTURE + ';';
    var leftZone = DCE('div'), centerZone = DCE('div'), rightZone = DCE('div');
    [leftZone, centerZone, rightZone].forEach(function (z) {
      z.style.cssText = 'height:100%;-webkit-touch-callout:none;' +
        '-webkit-user-select:none;user-select:none;-webkit-tap-highlight-color:transparent;';
    });
    leftZone.style.flex = '0.42';
    centerZone.style.flex = '0.16';
    rightZone.style.flex = '0.42';
    APP(gestureLayer, leftZone);
    APP(gestureLayer, centerZone);
    APP(gestureLayer, rightZone);
    APP(container, gestureLayer);

    // ---------------- Badges ----------------
    var badgeHost = DCE('div');
    badgeHost.style.cssText = ABS + 'left:0;top:0;width:100%;height:100%;pointer-events:none;';
    APP(gestureLayer, badgeHost);

    var BADGE_BASE = ABS + 'background:#000a;color:#fff;font:600 13px/1 sans-serif;' +
      'border-radius:16px;display:none;pointer-events:none;' +
      'transition:transform ' + CFG.BADGE_TRANSITION_MS + 'ms cubic-bezier(.34,1.56,.64,1),opacity ' + CFG.BADGE_TRANSITION_MS + 'ms ease;';

    var boostBadgeEl = DCE('div');
    boostBadgeEl.style.cssText = BADGE_BASE + 'top:18%;left:50%;transform:translateX(-50%) scale(.85);opacity:0;padding:6px 12px;';
    APP(badgeHost, boostBadgeEl);
    var boostBadge = makeVisibilityController(boostBadgeEl, {
      showTransform: 'translateX(-50%) scale(1)',
      hideTransform: 'translateX(-50%) scale(.85)'
    });

    var seekLEl = DCE('div');
    seekLEl.style.cssText = BADGE_BASE + 'top:50%;left:12%;transform:translateY(-50%) scale(.85);opacity:0;padding:6px 12px;font-size:15px;';
    APP(badgeHost, seekLEl);
    var seekBadgeL = makeVisibilityController(seekLEl, {
      showTransform: 'translateY(-50%) scale(1)', hideTransform: 'translateY(-50%) scale(.85)', visibleMs: CFG.BADGE_VISIBLE_MS
    });

    var seekREl = DCE('div');
    seekREl.style.cssText = BADGE_BASE + 'top:50%;right:12%;transform:translateY(-50%) scale(.85);opacity:0;padding:6px 12px;font-size:15px;';
    APP(badgeHost, seekREl);
    var seekBadgeR = makeVisibilityController(seekREl, {
      showTransform: 'translateY(-50%) scale(1)', hideTransform: 'translateY(-50%) scale(.85)', visibleMs: CFG.BADGE_VISIBLE_MS
    });

    // ---------------- Control bar ----------------
    var controlBar = DCE('div');
    controlBar.style.cssText = ABS + 'top:8px;right:8px;left:8px;display:flex;' +
      'justify-content:flex-end;flex-wrap:wrap;gap:5px;' +
      'z-index:' + Z.CONTROL + ';transition:opacity .2s ease,transform .2s ease;' +
      'opacity:1;transform:translateY(0);';
    APP(container, controlBar);

    var playBtn = makeButton(L.PLAY, 'Play / Pause');
    var volBtn = makeButton(L.VOL, 'Volume boost');
    var fitBtn = makeButton(L.FIT_ON, 'Fit / Zoom video');
    var fsBtn = makeButton(L.FULLSCREEN, 'Fullscreen');
    var pipBtn = makeButton(L.PIP, 'Picture-in-Picture');
    var rotateBtn = makeButton(L.ROTATE, 'Rotate to landscape');
    var switchBtn = makeButton(L.SWITCH_ON, 'Switch control between overlay and site');
    var closeBtn = makeButton(L.CLOSE, 'Hide controls');
    closeBtn.style.background = '#0006';

    var allButtons = [playBtn, volBtn, fitBtn, fsBtn, pipBtn, rotateBtn, switchBtn, closeBtn];
    allButtons.forEach(function (b) { APP(controlBar, b); });

    if (!SUPPORTS_FULLSCREEN) fsBtn.style.display = 'none';
    if (!SUPPORTS_PIP) pipBtn.style.display = 'none';
    if (!SUPPORTS_ORIENTATION_LOCK) rotateBtn.style.display = 'none';

    attachPlayPauseToggle(video, playBtn);
    var volCleanup = attachVolumeBoost(video, volBtn);
    attachFitToggle(video, fitBtn, function () { return uiState.isFullscreen; });
    attachFullscreenToggle(video, container, fsBtn);
    attachPipToggle(video, pipBtn);
    attachRotateToggle(rotateBtn);

    function setDisabled(btn, disabled) {
      btn.disabled = disabled;
      btn.style.opacity = disabled ? '.4' : '1';
      btn.style.cursor = disabled ? 'default' : 'pointer';
    }
    function syncFullscreenGatedButtons() {
      if (SUPPORTS_ORIENTATION_LOCK) setDisabled(rotateBtn, !uiState.isFullscreen);
      setDisabled(fitBtn, !uiState.isFullscreen);
    }
    syncFullscreenGatedButtons();

    // ============================================================================
    // (A) SINGLE SOURCE OF TRUTH — applyMode() একাই সব pointer-events sync করে
    // ============================================================================
    function applyMode() {
      var active = mode.active;
      // gesture layer: শুধু Us মোডে ইনপুট নেয়, Site মোডে সম্পূর্ণ transparent to events
      gestureLayer.style.pointerEvents = active ? 'auto' : 'none';
      // control bar wrapper সবসময় নিজে pointer-events:none থাকে (layout স্পেস
      // নেওয়ার জন্য), ভেতরের প্রতিটা বাটন নিজে auto/none — এভাবে hidden bar
      // এর জায়গায় ভুল ক্লিক পড়ে না, আবার bar visible থাকলে বাটন কাজ করে
      controlBar.style.pointerEvents = 'none';
      allButtons.forEach(function (b) {
        b.style.pointerEvents = (uiState.controlsExpanded && !b.disabled) ? 'auto' : 'none';
      });
      switchBtn.textContent = active ? L.SWITCH_ON : L.SWITCH_OFF;
      switchBtn.style.background = active ? '#0008' : '#fc0e';
      switchBtn.style.color = active ? '#fff' : '#000';
    }

    // ---------------- Control bar show/hide ----------------
    function showControls() {
      uiState.controlsExpanded = true;
      controlBar.style.opacity = '1';
      controlBar.style.transform = 'translateY(0)';
      applyMode();
      resetAutoHideTimer();
    }
    function hideControls() {
      // Site মোডে bar কখনো hide হয় না — কারণ bar ই একমাত্র উপায় আবার Us এ ফেরার
      if (!mode.active) return;
      uiState.controlsExpanded = false;
      controlBar.style.opacity = '0';
      controlBar.style.transform = 'translateY(-6px)';
      applyMode();
      clearTimeout(uiState.autoHideTimer);
    }
    function resetAutoHideTimer() {
      clearTimeout(uiState.autoHideTimer);
      if (!mode.active) return; // Site মোডে auto-hide নিষেধ
      if (IS_TOUCH) uiState.autoHideTimer = setTimeout(hideControls, CFG.AUTO_HIDE_MS);
    }
    ON(closeBtn, 'click', function (e) { e.stopPropagation(); hideControls(); });

    if (!IS_TOUCH) {
      ON(container, 'mouseenter', showControls);
      ON(container, 'mouseleave', hideControls);
      uiState.controlsExpanded = false;
      controlBar.style.opacity = '0';
      controlBar.style.transform = 'translateY(-6px)';
    } else {
      resetAutoHideTimer();
    }

    function onSingleTapAnywhere() { showControls(); }
    ON(leftZone, 'pointerdown', onSingleTapAnywhere);
    ON(rightZone, 'pointerdown', onSingleTapAnywhere);
    ON(centerZone, 'pointerdown', onSingleTapAnywhere);

    // ---------------- Gestures (B: rate-locking boost included) ----------------
    var gestureCtl = attachUnifiedGestures(video, {
      leftZone: leftZone, centerZone: centerZone, rightZone: rightZone,
      boostBadge: boostBadge, seekBadgeL: seekBadgeL, seekBadgeR: seekBadgeR
    });

    // ---------------- Switch (Ctrl:Us <-> Ctrl:Site) ----------------
    function setMode(active) {
      mode.active = active;
      gestureCtl.forceReset();
      if (active) {
        uiState.controlsExpanded = true;
        controlBar.style.opacity = '1';
        controlBar.style.transform = 'translateY(0)';
        applyMode();
        resetAutoHideTimer();
      } else {
        clearTimeout(uiState.autoHideTimer);
        uiState.controlsExpanded = true; // Site মোডে bar সবসময় visible/static
        controlBar.style.opacity = '1';
        controlBar.style.transform = 'translateY(0)';
        applyMode();
      }
    }
    ON(switchBtn, 'click', function (e) { e.stopPropagation(); setMode(!mode.active); });

    var onVisChange = ON(document, 'visibilitychange', function () {
      if (document.hidden) gestureCtl.forceReset();
    });
    var onBlur = ON(window, 'blur', gestureCtl.forceReset);

    applyMode(); // প্রাথমিক sync

    return {
      gestureLayer: gestureLayer,
      controlBar: controlBar,
      onFullscreenChange: function () {
        uiState.isFullscreen = !!document.fullscreenElement;
        fsBtn.textContent = uiState.isFullscreen ? L.EXIT_FULLSCREEN : L.FULLSCREEN;
        syncFullscreenGatedButtons();
      },
      destroy: function () {
        gestureCtl.forceReset();
        gestureCtl.destroy();
        if (volCleanup) volCleanup();
        OFF(document, 'visibilitychange', onVisChange);
        OFF(window, 'blur', onBlur);
        gestureLayer.remove();
        controlBar.remove();
        clearTimeout(uiState.autoHideTimer);
        if (this._extraCleanup) this._extraCleanup();
      }
    };
  }

  // ============================================================================
  // UI primitives
  // ============================================================================
  function makeButton(label, title) {
    var fontSize = IS_TOUCH ? 13 : 11;
    var padY = IS_TOUCH ? 7 : 5;
    var padX = IS_TOUCH ? 9 : 7;
    var b = DCE('button');
    b.type = 'button';
    b.textContent = label;
    b.title = title;
    b.style.cssText =
      'border:none;border-radius:8px;white-space:nowrap;' +
      'background:#0008;color:#fff;backdrop-filter:blur(2px);' +
      'font:600 ' + fontSize + 'px/1 sans-serif;' +
      'padding:' + padY + 'px ' + padX + 'px;' +
      'cursor:pointer;box-shadow:0 1px 3px rgba(0,0,0,.4);' +
      'transition:transform .1s ease,background .15s ease,opacity .15s ease;';
    ON(b, 'pointerdown', function () { b.style.transform = 'scale(.92)'; });
    ON(b, 'pointerup', function () { b.style.transform = 'scale(1)'; });
    ON(b, 'pointerleave', function () { b.style.transform = 'scale(1)'; });
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

  // ============================================================================
  // (C) Volume Boost — honest UI: ব্যর্থ হলে বাটন hide, mislead করে না
  // ============================================================================
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
          // impossible — honest UI: বাটন hide করে দেওয়া, "N/A" বা fake fallback না
          btn.style.display = 'none';
          return;
        }
      }
      if (!ctx) return; // (তাত্ত্বিকভাবে এখানে আসবে না)
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

  // ============================================================================
  // Unified gestures — long-press(পুরো স্ক্রিন)=2x rate-locked hold,
  // zone-wise multi-tap escalating seek, center double-tap play/pause
  // ============================================================================
  function attachUnifiedGestures(video, refs) {
    var pressTimer = null;
    var boostWatchdog = null;
    var boostSafetyCap = null;
    var isBoosting = false;
    var desiredRate = null;   // (B) আমরা যেই rate "মালিক" হয়ে আছি
    var rateBeforeBoost = 1;
    var activePointerId = null;
    var pressMoved = false;
    var startX = 0, startY = 0;
    var MOVE_TOLERANCE = 10;

    var seekSeq = { left: { count: 0, timer: null }, right: { count: 0, timer: null } };
    var centerSeq = { count: 0, timer: null };

    function clearPressTimer() {
      if (pressTimer !== null) { clearTimeout(pressTimer); pressTimer = null; }
    }

    // (B) OWNED-RESOURCE LOCKING: watchdog প্রতি 300ms এ চেক করে rate এখনো
    // আমাদের কাঙ্ক্ষিত মান আছে কিনা — সাইট মাঝে বদলে দিলে জোর করে ফেরত বসায়
    function startBoost() {
      rateBeforeBoost = (video.playbackRate === CFG.BOOST_SPEED) ? 1 : video.playbackRate;
      desiredRate = CFG.BOOST_SPEED;
      video.playbackRate = desiredRate;
      isBoosting = true;
      refs.boostBadge.show('2x');

      clearInterval(boostWatchdog);
      boostWatchdog = setInterval(function () {
        if (desiredRate === null) return;
        if (video.playbackRate !== desiredRate) {
          video.playbackRate = desiredRate; // reassert ownership
        }
      }, CFG.BOOST_WATCHDOG_MS);

      clearTimeout(boostSafetyCap);
      boostSafetyCap = setTimeout(endBoost, CFG.BOOST_MAX_DURATION_MS);
    }

    function endBoost() {
      clearTimeout(boostSafetyCap);
      clearInterval(boostWatchdog);
      boostWatchdog = null;
      if (!isBoosting) return;
      isBoosting = false;
      desiredRate = null;
      // শুধুমাত্র rate এখনো আমাদের বসানো মান হলেই মূল rate এ ফেরানো — সাইট
      // ইতিমধ্যে অন্য কিছুতে সরিয়ে থাকলে সেটাকে সম্মান করা হয়
      if (video.playbackRate === CFG.BOOST_SPEED) {
        video.playbackRate = rateBeforeBoost || 1;
      }
      refs.boostBadge.hide();
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
      if (s.count >= 2) doSeek(side, s.count - 1);
      s.timer = setTimeout(function () { s.count = 0; }, CFG.MULTI_TAP_WINDOW_MS);
    }

    function handleCenterTap() {
      centerSeq.count += 1;
      clearTimeout(centerSeq.timer);
      if (centerSeq.count === 2) {
        togglePlay(video);
        centerSeq.count = 0;
        return;
      }
      centerSeq.timer = setTimeout(function () { centerSeq.count = 0; }, CFG.MULTI_TAP_WINDOW_MS);
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

    // playbackRate 300ms watchdog ছাড়াও, ব্রাউজার নিজে থেকেই 'ratechange'
    // ফায়ার করলে দ্রুত react করার জন্য (visual badge কে দ্রুত সিঙ্ক রাখতে)
    var onRateChange = ON(video, 'ratechange', function () {
      if (isBoosting && desiredRate !== null && video.playbackRate !== desiredRate) {
        // watchdog পরের টিকেই ঠিক করে দেবে; এখানে শুধু log/no-op — জোর করে
        // এখানেই rate সেট করলে সাইটের নিজস্ব transition এর মাঝখানে ঢুকে
        // flicker করতে পারে, তাই watchdog interval এ ছেড়ে দেওয়া হচ্ছে
      }
    });

    return {
      forceReset: forceReset,
      destroy: function () {
        forceReset();
        listeners.forEach(function (l) { OFF(l[0], l[1], l[2], l[3]); });
        OFF(video, 'ratechange', onRateChange);
      }
    };
  }

  // ============================================================================
  // Fullscreen / PiP / Rotate / Fit
  // ============================================================================
  function attachFullscreenToggle(video, container, btn) {
    if (!SUPPORTS_FULLSCREEN) return;
    ON(btn, 'click', async function (e) {
      e.stopPropagation();
      try {
        if (document.fullscreenElement) await document.exitFullscreen();
        else if (container.requestFullscreen) await container.requestFullscreen();
        else if (video.requestFullscreen) await video.requestFullscreen();
      } catch (err) {
        console.warn('[video-enhancer] fullscreen toggle failed:', err.message);
      }
    });
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

  function attachRotateToggle(btn) {
    if (!SUPPORTS_ORIENTATION_LOCK) return;
    var isLocked = false;
    ON(btn, 'click', async function (e) {
      e.stopPropagation();
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
    });
    ON(document, 'fullscreenchange', function () {
      if (!document.fullscreenElement && isLocked) { isLocked = false; btn.textContent = L.ROTATE; }
    });
  }

  function attachFitToggle(video, btn, isFullscreenGetter) {
    var isFit = false, savedStyle = null;
    ON(btn, 'click', function (e) {
      e.stopPropagation();
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
    });
    ON(document, 'fullscreenchange', function () {
      if (!document.fullscreenElement && isFit) {
        video.style.objectFit = savedStyle ? (savedStyle.objectFit || '') : '';
        video.style.transform = savedStyle ? (savedStyle.transform || '') : '';
        video.style.width = savedStyle ? (savedStyle.width || '') : '';
        video.style.height = savedStyle ? (savedStyle.height || '') : '';
        isFit = false;
        btn.textContent = L.FIT_ON;
      }
    });
  }

  if (document.readyState === 'loading') {
    ON(document, 'DOMContentLoaded', init);
  } else {
    init();
  }
})();
