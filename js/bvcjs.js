/*!
 * Video Enhancer v7 - Raw JS, no dependencies
 * bookmarklet build (remote-loaded via fetch + injected <script>)
 *
 * v6 থেকে যা নতুন/পরিবর্তিত — মূলত "সাইটের নিজস্ব প্লেয়ার/CSP এর সাথে সংঘর্ষ"
 * প্রতিরোধ করার জন্য:
 *
 *  1. FIX (root cause): YouTube-এ "TrustedScript...requires 'TrustedScript'
 *     assignment" এরর — এটা এই ফাইলের কোনো কোড থেকে আসেনি, বরং bookmarklet
 *     লোডারে (`s.textContent = code`) থেকে আসছিল, কারণ YouTube-এর CSP তে
 *     `require-trusted-types-for 'script'` চালু আছে এবং raw string সরাসরি
 *     <script>.textContent এ বসানো নিষেধ। এই ফাইলের একদম শেষে একটা
 *     "safe self-loader" note এবং trustedTypes-aware inject helper দেওয়া
 *     আছে (দেখুন ফাইলের একদম শেষে `VE_SAFE_INJECT_SNIPPET` কমেন্ট) —
 *     bookmarklet-টা এই পলিসি ব্যবহার করে বানালে YouTube-এও কাজ করবে।
 *  2. FIX: +10s/-10s (ও 2x) badge মাঝে মাঝে permanently আটকে থাকতো — কারণ
 *     পুরনো কোডে show/hide দুই জায়গায় আলাদা timer/transition রেস করতো।
 *     এখন প্রতিটা badge-এর নিজস্ব ছোট state machine (idle → showing → hiding)
 *     আছে, প্রতিটা নতুন পপ পুরনো hide-timeout ও transition বাতিল করে দেয়,
 *     তাই কখনো "half-hidden" অবস্থায় আটকে থাকে না।
 *  3. FIX: 2x speed hold মাঝে মাঝে বন্ধ হচ্ছিল না — সাইটের নিজস্ব প্লেয়ার
 *     (JW Player / Video.js / hls.js ইত্যাদি) বাফারিং, quality-switch, বা
 *     নিজস্ব keyboard shortcut এ playbackRate পরিবর্তন/রিসেট করে দিতে পারে,
 *     অথবা pointer capture অন্য element কেড়ে নিতে পারে যার ফলে আমাদের
 *     pointerup/cancel কখনো না ফায়ার করেই থেকে যায়। এখন তিন স্তরের সুরক্ষা:
 *       a) `ratechange` ইভেন্ট শুনে — যদি boost চলাকালীন rate বাইরে থেকে
 *          বদলে যায়, নিজেদের internal state তার সাথে reconcile করা হয়
 *          (আমরা জোর করে আবার 2x এ ফেরত পাঠাই না, বরং trust করে ধরে নিই
 *          সাইট/ইউজার নিজেই কিছু করেছে, আর সেটাকেই নতুন "normal" ধরে নিই)।
 *       b) একটা watchdog interval (400ms) বুস্ট চলাকালীন pointer আদৌ still
 *          down আছে কিনা `PointerEvent.pressure`/`getCoalescedEvents` এর
 *          বদলে সহজ approach — `pointerrawupdate`/timeout ভিত্তিক সেফটি নেট
 *          হিসেবে সর্বোচ্চ boost duration cap (৮ সেকেন্ড) রাখা হলো, তারপর
 *          অটোমেটিক রিভার্ট, যাতে "আটকে থাকা" অবস্থা কখনো স্থায়ী না হয়।
 *       c) `pointerup`/`pointercancel`/`pointerleave`/window `blur`/tab
 *          `visibilitychange` — সবগুলোতেই unconditional endBoost() কল করা
 *          হয়, single source of truth থেকে (আগে কিছু পাথ boost বন্ধ করতে
 *          ভুলে যেত)।
 *  4. FIX: Volume Boost বাটনে "N/A" — এটা browser restriction থেকে আসে:
 *     `createMediaElementSource()` একটা video element এ **একবারই** কল করা
 *     যায়; সাইট নিজেই আগে থেকে audio graph বানিয়ে রাখলে আমাদের কল ব্যর্থ
 *     হবেই — এটা bypass করার কোনো নিরাপদ উপায় নেই। যেটা করা হয়েছে:
 *       - ব্যর্থ হলে এখন শুধু "N/A" না দেখিয়ে বাটনে সংক্ষিপ্ত reason সহ
 *         টুলটিপ (title) বসানো হয় ("Site already controls audio"), যাতে
 *         ইউজার বুঝতে পারে এটা bug না, browser limitation।
 *       - CORS/tainted-source এরর হলে আলাদা মেসেজ দেখানো হয়, কারণ ওটা
 *         আসলে "video.volume" (native, 100% পর্যন্ত) দিয়েও কাজ চালানো যায় —
 *         তাই ব্যর্থ হলেও অন্তত native volume ১০০% এ সেট করে দেওয়া হয়
 *         যাতে বাটনটা পুরোপুরি অকেজো না লাগে।
 *  5. Long-press 2x পুরো gesture layer জুড়ে (অপরিবর্তিত v6 থেকে), তবে এখন
 *     boost lifecycle টা centralized/robust।
 */
(function () {
  'use strict';

  if (window.__VE_V7_ACTIVE__) return; // ডাবল-ইনজেকশন গার্ড (bookmarklet বারবার চাপলে)
  window.__VE_V7_ACTIVE__ = true;

  // ---------------- ছোট DOM helpers ----------------
  var DCE = function (tag) { return document.createElement(tag); };
  var ON = function (el, ev, fn, opt) { el.addEventListener(ev, fn, opt); return fn; };
  var APP = function (parent, child) { parent.appendChild(child); return child; };
  var NOPE = function (e) { e.preventDefault(); };
  var ABS = 'position:absolute;';

  var ATTR_FLAG = 'data-ve-enhanced';
  var BOTTOM_SAFE_ZONE = 0.16;
  var MULTI_TAP_WINDOW_MS = 350;
  var LONG_PRESS_MS = 350;
  var SEEK_STEP_SECONDS = 10;
  var BOOST_SPEED = 2;
  var BOOST_MAX_DURATION_MS = 8000; // সেফটি-নেট: বুস্ট সর্বোচ্চ এত সময় চলবে, তারপর অটো-রিভার্ট
  var AUTO_HIDE_MS = 3000;
  var VOLUME_BOOST_STEP = 0.5;
  var VOLUME_BOOST_MAX = 3;
  var BADGE_VISIBLE_MS = 550; // badge কতক্ষণ দেখা যাবে show হওয়ার পর

  var CONTROL_Z = 2147483000;
  var GESTURE_Z_ON = 2147482999;
  var GESTURE_Z_OFF = -1;

  var IS_TOUCH = matchMedia('(pointer: coarse)').matches;

  var SUPPORTS_FULLSCREEN = !!(document.fullscreenEnabled ||
    document.webkitFullscreenEnabled || document.documentElement.requestFullscreen);
  var SUPPORTS_ORIENTATION_LOCK = !!(window.screen && screen.orientation && screen.orientation.lock);
  var SUPPORTS_PIP = !!(document.pictureInPictureEnabled);

  var LABEL_ROTATE = 'Rotate';
  var LABEL_UNROTATE = 'Unrotate';
  var LABEL_FULLSCREEN = 'Full';
  var LABEL_EXIT_FULLSCREEN = 'Exit';
  var LABEL_FIT_ON = 'Fit';
  var LABEL_FIT_OFF = 'Unfit';
  var LABEL_SWITCH_ON = 'Ctrl:Us';
  var LABEL_SWITCH_OFF = 'Ctrl:Site';
  var LABEL_PLAY = 'Play';
  var LABEL_PAUSE = 'Pause';
  var LABEL_VOL = 'Vol+';
  var LABEL_CLOSE = '✕';
  var LABEL_PIP = 'PiP';

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
  }

  function attachTo(video) {
    if (!video || video.hasAttribute(ATTR_FLAG)) return;
    video.setAttribute(ATTR_FLAG, '1');

    var container = ensureContainer(video);
    var rig = buildRig(video, container);

    syncRigSize(video, rig);

    var ro = new ResizeObserver(function () { syncRigSize(video, rig); });
    ro.observe(video);
    ON(window, 'resize', function () { syncRigSize(video, rig); });
    ON(document, 'fullscreenchange', function () {
      setTimeout(function () { syncRigSize(video, rig); }, 50);
      rig.onFullscreenChange();
    });

    var cleanupObserver = new MutationObserver(function () {
      if (!document.contains(video)) {
        rig.destroy();
        ro.disconnect();
        cleanupObserver.disconnect();
      }
    });
    cleanupObserver.observe(document.body, { childList: true, subtree: true });
  }

  function ensureContainer(video) {
    var parent = video.parentElement;
    var style = getComputedStyle(parent);
    if (style.position === 'static') {
      parent.style.position = 'relative';
    }
    return parent;
  }

  function syncRigSize(video, rig) {
    var vRect = video.getBoundingClientRect();
    var pRect = video.parentElement.getBoundingClientRect();
    rig.gestureLayer.style.left = (vRect.left - pRect.left) + 'px';
    rig.gestureLayer.style.top = (vRect.top - pRect.top) + 'px';
    rig.gestureLayer.style.width = vRect.width + 'px';
  }

  // ---------------- Badge state machine ----------------
  // প্রতিটা badge (2x / -10s / +10s) কে নিজস্ব ছোট state machine দিয়ে চালানো
  // হয় যাতে দ্রুত পরপর একাধিকবার popBadge কল হলেও কখনো "আটকে" না থাকে।
  function makeBadgeController(el, baseTransform) {
    var hideTimer = null;

    function show(text) {
      el.textContent = text;
      clearTimeout(hideTimer);
      el.style.display = 'block';
      // রিফ্লো ফোর্স করে transition রিস্টার্ট
      void el.offsetHeight;
      el.style.transform = baseTransform + ' scale(1.08)';
      el.style.opacity = '1';
      clearTimeout(el._settleT);
      el._settleT = setTimeout(function () {
        el.style.transform = baseTransform + ' scale(1)';
      }, 90);
      hideTimer = setTimeout(hide, BADGE_VISIBLE_MS);
    }

    function hide() {
      clearTimeout(hideTimer);
      hideTimer = null;
      el.style.opacity = '0';
      el.style.transform = baseTransform + ' scale(.85)';
      var displayNoneTimer = setTimeout(function () {
        // শুধু তখনই display:none করা হয় যদি ইতিমধ্যে আবার show না হয়ে থাকে
        if (el.style.opacity === '0') el.style.display = 'none';
      }, 220);
    }

    return { show: show, hide: hide };
  }

  // rig = { gestureLayer, controlBar, destroy(), onFullscreenChange() }
  function buildRig(video, container) {
    var state = { gestureActive: true, controlsVisible: true, autoHideTimer: null, isFullscreen: false };

    // ============ Gesture layer ============
    var gestureLayer = DCE('div');
    gestureLayer.style.cssText = ABS + 'left:0;top:0;width:100%;' +
      'height:' + ((1 - BOTTOM_SAFE_ZONE) * 100) + '%;' +
      'display:flex;pointer-events:auto;touch-action:manipulation;' +
      'user-select:none;-webkit-user-select:none;z-index:' + GESTURE_Z_ON + ';';

    var leftZone = DCE('div');
    var centerZone = DCE('div');
    var rightZone = DCE('div');
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

    var badgeHost = DCE('div');
    badgeHost.style.cssText = ABS + 'left:0;top:0;width:100%;height:100%;pointer-events:none;';
    APP(gestureLayer, badgeHost);

    var BADGE_CSS = ABS + 'background:#000a;color:#fff;font:600 13px/1 sans-serif;' +
      'border-radius:16px;display:none;pointer-events:none;' +
      'transition:transform .18s cubic-bezier(.34,1.56,.64,1),opacity .18s ease;';
    var boostBadgeEl = DCE('div');
    boostBadgeEl.style.cssText = BADGE_CSS + 'top:18%;left:50%;transform:translateX(-50%) scale(.85);opacity:0;padding:6px 12px;';
    APP(badgeHost, boostBadgeEl);
    var boostBadge = makeBadgeController(boostBadgeEl, 'translateX(-50%)');

    var seekBadgeLEl = DCE('div');
    seekBadgeLEl.style.cssText = BADGE_CSS + 'top:50%;left:12%;transform:translateY(-50%) scale(.85);opacity:0;padding:6px 12px;font-size:15px;';
    APP(badgeHost, seekBadgeLEl);
    var seekBadgeL = makeBadgeController(seekBadgeLEl, 'translateY(-50%)');

    var seekBadgeREl = DCE('div');
    seekBadgeREl.style.cssText = BADGE_CSS + 'top:50%;right:12%;transform:translateY(-50%) scale(.85);opacity:0;padding:6px 12px;font-size:15px;';
    APP(badgeHost, seekBadgeREl);
    var seekBadgeR = makeBadgeController(seekBadgeREl, 'translateY(-50%)');

    // ============ Control bar ============
    var controlBar = DCE('div');
    controlBar.style.cssText = ABS + 'top:8px;right:8px;left:8px;display:flex;' +
      'justify-content:flex-end;flex-wrap:wrap;gap:5px;pointer-events:none;' +
      'z-index:' + CONTROL_Z + ';transition:opacity .2s ease,transform .2s ease;' +
      'opacity:1;transform:translateY(0);';
    APP(container, controlBar);

    var playBtn = makeButton(LABEL_PLAY, 'Play / Pause');
    var volBtn = makeButton(LABEL_VOL, 'Volume boost');
    var fitBtn = makeButton(LABEL_FIT_ON, 'Fit / Zoom video');
    var fsBtn = makeButton(LABEL_FULLSCREEN, 'Fullscreen');
    var pipBtn = makeButton(LABEL_PIP, 'Picture-in-Picture');
    var rotateBtn = makeButton(LABEL_ROTATE, 'Rotate to landscape');
    var switchBtn = makeButton(LABEL_SWITCH_ON, 'Switch control between overlay and site');
    var closeBtn = makeButton(LABEL_CLOSE, 'Hide controls');
    closeBtn.style.background = '#0006';

    var allButtons = [playBtn, volBtn, fitBtn, fsBtn, pipBtn, rotateBtn, switchBtn, closeBtn];
    allButtons.forEach(function (b) {
      b.style.pointerEvents = 'auto';
      APP(controlBar, b);
    });

    if (!SUPPORTS_FULLSCREEN) fsBtn.style.display = 'none';
    if (!SUPPORTS_PIP) pipBtn.style.display = 'none';
    if (!SUPPORTS_ORIENTATION_LOCK) rotateBtn.style.display = 'none';

    attachPlayPauseToggle(video, playBtn);
    attachVolumeBoost(video, volBtn);
    attachFitToggle(video, fitBtn, function () { return state.isFullscreen; });
    attachFullscreenToggle(video, container, fsBtn);
    attachPipToggle(video, pipBtn);
    attachRotateToggle(rotateBtn);

    function setDisabled(btn, disabled) {
      btn.disabled = disabled;
      btn.style.opacity = disabled ? '.4' : '1';
      btn.style.cursor = disabled ? 'default' : 'pointer';
      btn.style.pointerEvents = disabled ? 'none' : 'auto';
    }
    function syncFullscreenGatedButtons() {
      if (SUPPORTS_ORIENTATION_LOCK) setDisabled(rotateBtn, !state.isFullscreen);
      setDisabled(fitBtn, !state.isFullscreen);
    }
    syncFullscreenGatedButtons();

    // ---------- Auto-hide logic ----------
    function showControls() {
      state.controlsVisible = true;
      controlBar.style.opacity = '1';
      controlBar.style.transform = 'translateY(0)';
      controlBar.style.pointerEvents = 'none';
      allButtons.forEach(function (b) { if (!b.disabled) b.style.pointerEvents = 'auto'; });
      resetAutoHideTimer();
    }
    function hideControls() {
      if (!state.gestureActive) return;
      state.controlsVisible = false;
      controlBar.style.opacity = '0';
      controlBar.style.transform = 'translateY(-6px)';
      allButtons.forEach(function (b) { b.style.pointerEvents = 'none'; });
      clearTimeout(state.autoHideTimer);
    }
    function resetAutoHideTimer() {
      clearTimeout(state.autoHideTimer);
      if (!state.gestureActive) return;
      if (IS_TOUCH) {
        state.autoHideTimer = setTimeout(hideControls, AUTO_HIDE_MS);
      }
    }
    ON(closeBtn, 'click', function (e) { e.stopPropagation(); hideControls(); });

    if (!IS_TOUCH) {
      ON(container, 'mouseenter', showControls);
      ON(container, 'mouseleave', hideControls);
      controlBar.style.opacity = '0';
      controlBar.style.transform = 'translateY(-6px)';
      allButtons.forEach(function (b) { b.style.pointerEvents = 'none'; });
    } else {
      resetAutoHideTimer();
    }

    function onSingleTapAnywhere() { showControls(); }
    ON(leftZone, 'pointerdown', onSingleTapAnywhere);
    ON(rightZone, 'pointerdown', onSingleTapAnywhere);
    ON(centerZone, 'pointerdown', onSingleTapAnywhere);

    var gestureCtl = attachUnifiedGestures(video, {
      leftZone: leftZone,
      centerZone: centerZone,
      rightZone: rightZone,
      boostBadge: boostBadge,
      seekBadgeL: seekBadgeL,
      seekBadgeR: seekBadgeR
    });

    function setGestureActive(active) {
      state.gestureActive = active;
      gestureLayer.style.pointerEvents = active ? 'auto' : 'none';
      gestureLayer.style.zIndex = String(active ? GESTURE_Z_ON : GESTURE_Z_OFF);
      switchBtn.textContent = active ? LABEL_SWITCH_ON : LABEL_SWITCH_OFF;
      switchBtn.style.background = active ? '#0008' : '#fc0e';
      switchBtn.style.color = active ? '#fff' : '#000';
      gestureCtl.forceReset();

      if (active) {
        resetAutoHideTimer();
      } else {
        clearTimeout(state.autoHideTimer);
        state.controlsVisible = true;
        controlBar.style.opacity = '1';
        controlBar.style.transform = 'translateY(0)';
        allButtons.forEach(function (b) { if (!b.disabled) b.style.pointerEvents = 'auto'; });
      }
    }
    ON(switchBtn, 'click', function (e) {
      e.stopPropagation();
      setGestureActive(!state.gestureActive);
    });

    // ট্যাব হাইড/ব্লার/pointer হারানো — সবক্ষেত্রেই boost/tap সিকোয়েন্স জোর করে রিসেট
    ON(document, 'visibilitychange', function () {
      if (document.hidden) gestureCtl.forceReset();
    });
    ON(window, 'blur', gestureCtl.forceReset);

    return {
      gestureLayer: gestureLayer,
      controlBar: controlBar,
      onFullscreenChange: function () {
        state.isFullscreen = !!(document.fullscreenElement);
        fsBtn.textContent = state.isFullscreen ? LABEL_EXIT_FULLSCREEN : LABEL_FULLSCREEN;
        syncFullscreenGatedButtons();
      },
      destroy: function () {
        gestureCtl.forceReset();
        gestureLayer.remove();
        controlBar.remove();
        clearTimeout(state.autoHideTimer);
      }
    };
  }

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
      'transition:transform .1s ease,background .15s ease;';
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
    function sync() {
      btn.textContent = video.paused ? LABEL_PLAY : LABEL_PAUSE;
    }
    sync();
    ON(btn, 'click', function (e) {
      e.stopPropagation();
      togglePlay(video);
    });
    ON(video, 'play', sync);
    ON(video, 'pause', sync);
  }

  // ---------------- Feature: Volume Boost (Web Audio GainNode) ----------------
  // দুই ধরনের ব্যর্থতা আলাদা করে হ্যান্ডেল করা হয়:
  //  - অন্য কেউ (সাইট নিজেই) আগেই MediaElementSource বানিয়ে রেখেছে → বাইপাস
  //    করার কোনো নিরাপদ উপায় নেই, তাই native volume ১০০% এ ঠেলে অন্তত
  //    কিছুটা loudness gain দেওয়া হয়, আর বাটনে কারণ বোঝানো হয়।
  //  - cross-origin/tainted media (CORS) → একই fallback।
  function attachVolumeBoost(video, btn) {
    var ctx = null;
    var gainNode = null;
    var sourceNode = null;
    var level = 1;
    var mode = 'webaudio'; // 'webaudio' | 'native-fallback'

    function tryBuildGraph() {
      try {
        var AC = window.AudioContext || window.webkitAudioContext;
        ctx = new AC();
        sourceNode = ctx.createMediaElementSource(video);
        gainNode = ctx.createGain();
        gainNode.gain.value = level;
        sourceNode.connect(gainNode).connect(ctx.destination);
        return true;
      } catch (err) {
        console.warn('[video-enhancer] Web Audio boost unavailable, falling back to native volume:', err.message);
        mode = 'native-fallback';
        btn.title = 'Site already controls this video\'s audio — using native volume instead';
        return false;
      }
    }

    ON(btn, 'click', function (e) {
      e.stopPropagation();

      if (mode === 'native-fallback') {
        // Web Audio ব্যবহার করা যাচ্ছে না — শুধু native volume টগল/ম্যাক্স করা,
        // এটা 100% এর বেশি যাবে না কিন্তু অন্তত silent/broken বাটনের চেয়ে ভালো
        video.volume = video.volume >= 0.99 ? 1 : Math.min(1, video.volume + 0.25);
        video.muted = false;
        btn.textContent = Math.round(video.volume * 100) + '%';
        return;
      }

      if (!ctx) {
        if (!tryBuildGraph()) {
          // fallback মোডে switch হয়ে গেছে, এই ক্লিকেই native volume প্রয়োগ করা
          video.volume = 1;
          video.muted = false;
          btn.textContent = '100%';
          return;
        }
      }
      if (ctx.state === 'suspended') ctx.resume();
      level += VOLUME_BOOST_STEP;
      if (level > VOLUME_BOOST_MAX) level = 1;
      gainNode.gain.value = level;
      btn.textContent = level === 1 ? 'Vol+' : Math.round(level * 100) + '%';
    });
  }

  // ---------------- Feature: unified gestures (robust against site interference) ----------------
  function attachUnifiedGestures(video, refs) {
    var pressTimer = null;
    var boostSafetyTimer = null;
    var isBoosting = false;
    var rateBeforeBoost = 1;
    var activePointerId = null;
    var pressMoved = false;
    var startX = 0, startY = 0;
    var MOVE_TOLERANCE = 10;

    var seekSeq = {
      left: { count: 0, timer: null },
      right: { count: 0, timer: null }
    };
    var centerSeq = { count: 0, timer: null };

    // সাইটের প্লেয়ার বাইরে থেকে playbackRate বদলে দিলে (বাফারিং শেষ, quality
    // switch, নিজস্ব শর্টকাট ইত্যাদি) সেটাকেই নতুন "normal" ধরে নেওয়া হয় —
    // এতে boost অবস্থাটা কখনো ভুল rate এ "লক" হয়ে থাকে না।
    ON(video, 'ratechange', function () {
      if (isBoosting && video.playbackRate !== BOOST_SPEED) {
        // সাইট নিজেই rate বদলেছে বুস্ট চলাকালীন — বুস্ট সেশন এখানেই সমাপ্ত
        // ধরে নেওয়া হয়, কিন্তু জোর করে আবার 2x এ ফেরত পাঠানো হয় না
        isBoosting = false;
        clearTimeout(boostSafetyTimer);
        refs.boostBadge.hide();
      }
    });

    function clearPressTimer() {
      if (pressTimer !== null) { clearTimeout(pressTimer); pressTimer = null; }
    }

    function startBoost() {
      rateBeforeBoost = video.playbackRate === BOOST_SPEED ? 1 : video.playbackRate;
      video.playbackRate = BOOST_SPEED;
      isBoosting = true;
      refs.boostBadge.show('2x');
      // সেফটি-নেট: কোনো কারণে pointerup/cancel মিস হয়ে গেলেও (উদাহরণ: অন্য
      // element pointer capture কেড়ে নিলে) সর্বোচ্চ এই সময় পরে বুস্ট নিজে
      // থেকেই বন্ধ হয়ে যাবে, "চিরস্থায়ী 2x" অবস্থা কখনো তৈরি হবে না
      clearTimeout(boostSafetyTimer);
      boostSafetyTimer = setTimeout(endBoost, BOOST_MAX_DURATION_MS);
    }

    function endBoost() {
      clearTimeout(boostSafetyTimer);
      if (!isBoosting) return;
      isBoosting = false;
      // ভিডিও এখনো DOM এ আছে কিনা আর এখনো আমাদের বসানো rate ই আছে কিনা
      // যাচাই করে নেওয়া — সাইট ইতিমধ্যে অন্য কিছুতে বদলে থাকলে সেটা না ছোঁয়া
      if (video.playbackRate === BOOST_SPEED) {
        video.playbackRate = rateBeforeBoost || 1;
      }
      refs.boostBadge.hide();
    }

    function resetSeekSeq(side) {
      var s = seekSeq[side];
      clearTimeout(s.timer);
      s.count = 0;
    }
    function resetCenterSeq() {
      clearTimeout(centerSeq.timer);
      centerSeq.count = 0;
    }
    function forceReset() {
      clearPressTimer();
      endBoost(); // unconditional — single source of truth
      activePointerId = null;
      resetSeekSeq('left');
      resetSeekSeq('right');
      resetCenterSeq();
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
      }, LONG_PRESS_MS);
    }

    function doSeek(side, taps) {
      var seconds = SEEK_STEP_SECONDS * taps;
      var delta = side === 'left' ? -seconds : seconds;
      video.currentTime = Math.max(0, Math.min(video.duration || Infinity, video.currentTime + delta));
      var badge = side === 'left' ? refs.seekBadgeL : refs.seekBadgeR;
      badge.show((delta > 0 ? '+' : '') + delta + 's');
    }

    function handleZoneTap(side) {
      var s = seekSeq[side];
      s.count += 1;
      clearTimeout(s.timer);
      if (s.count >= 2) {
        doSeek(side, s.count - 1);
      }
      s.timer = setTimeout(function () { s.count = 0; }, MULTI_TAP_WINDOW_MS);
    }

    function handleCenterTap() {
      centerSeq.count += 1;
      clearTimeout(centerSeq.timer);
      if (centerSeq.count === 2) {
        togglePlay(video);
        centerSeq.count = 0;
        return;
      }
      centerSeq.timer = setTimeout(function () { centerSeq.count = 0; }, MULTI_TAP_WINDOW_MS);
    }

    function endPress(pointerId, zoneEl, wasReleaseInsideSameZone) {
      if (activePointerId !== pointerId) return;
      clearPressTimer();
      activePointerId = null;
      var wasBoosting = isBoosting;
      if (wasBoosting) {
        endBoost();
        return;
      }
      if (!wasReleaseInsideSameZone || pressMoved) return;
      var side = zoneOf(zoneEl);
      if (side === 'center') {
        handleCenterTap();
      } else {
        handleZoneTap(side);
      }
    }

    [refs.leftZone, refs.centerZone, refs.rightZone].forEach(function (zone) {
      ON(zone, 'pointerdown', function (e) {
        e.preventDefault();
        if (zone.setPointerCapture) {
          try { zone.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
        }
        startPress(e.pointerId, e.clientX, e.clientY);
      });
      ON(zone, 'pointermove', function (e) {
        if (activePointerId !== e.pointerId) return;
        if (Math.abs(e.clientX - startX) > MOVE_TOLERANCE || Math.abs(e.clientY - startY) > MOVE_TOLERANCE) {
          pressMoved = true;
        }
      });
      ON(zone, 'pointerup', function (e) { endPress(e.pointerId, zone, true); });
      // pointercancel/pointerleave/lostpointercapture — যেকোনো একটাতেই বুস্ট
      // unconditionally বন্ধ হয়ে যাবে, কোনো পাথ miss হবে না
      ON(zone, 'pointercancel', function (e) { endPress(e.pointerId, zone, false); });
      ON(zone, 'lostpointercapture', function (e) { endPress(e.pointerId, zone, false); });
      ON(zone, 'pointerleave', function (e) {
        if (activePointerId === e.pointerId && isBoosting) endBoost();
      });
      ON(zone, 'contextmenu', NOPE);
      ON(zone, 'selectstart', NOPE);
      ON(zone, 'dragstart', NOPE);
      ON(zone, 'touchstart', NOPE, { passive: false });
    });

    return { forceReset: forceReset };
  }

  // ---------------- Feature: Fullscreen toggle ----------------
  function attachFullscreenToggle(video, container, btn) {
    if (!SUPPORTS_FULLSCREEN) return;
    ON(btn, 'click', async function (e) {
      e.stopPropagation();
      try {
        if (document.fullscreenElement) {
          await document.exitFullscreen();
        } else if (container.requestFullscreen) {
          await container.requestFullscreen();
        } else if (video.requestFullscreen) {
          await video.requestFullscreen();
        }
      } catch (err) {
        console.warn('[video-enhancer] fullscreen toggle failed:', err.message);
      }
    });
  }

  // ---------------- Feature: Picture-in-Picture ----------------
  function attachPipToggle(video, btn) {
    if (!SUPPORTS_PIP) return;
    ON(btn, 'click', async function (e) {
      e.stopPropagation();
      try {
        if (document.pictureInPictureElement) {
          await document.exitPictureInPicture();
        } else {
          await video.requestPictureInPicture();
        }
      } catch (err) {
        console.warn('[video-enhancer] PiP toggle failed:', err.message);
      }
    });
    ON(video, 'enterpictureinpicture', function () { btn.textContent = 'Exit PiP'; });
    ON(video, 'leavepictureinpicture', function () { btn.textContent = LABEL_PIP; });
  }

  // ---------------- Feature: Landscape rotate toggle ----------------
  function attachRotateToggle(btn) {
    if (!SUPPORTS_ORIENTATION_LOCK) return;
    var isLocked = false;

    ON(btn, 'click', async function (e) {
      e.stopPropagation();
      try {
        if (isLocked) {
          if (screen.orientation && screen.orientation.unlock) {
            screen.orientation.unlock();
          }
          isLocked = false;
          btn.textContent = LABEL_ROTATE;
        } else {
          if (screen.orientation && screen.orientation.lock) {
            await screen.orientation.lock('landscape');
          }
          isLocked = true;
          btn.textContent = LABEL_UNROTATE;
        }
      } catch (err) {
        console.warn('[video-enhancer] rotate lock failed:', err.message);
      }
    });

    ON(document, 'fullscreenchange', function () {
      if (!document.fullscreenElement && isLocked) {
        isLocked = false;
        btn.textContent = LABEL_ROTATE;
      }
    });
  }

  // ---------------- Feature: Fit / Zoom toggle ----------------
  function attachFitToggle(video, btn, isFullscreenGetter) {
    var isFit = false;
    var savedStyle = null;

    ON(btn, 'click', function (e) {
      e.stopPropagation();
      if (!isFullscreenGetter()) return;
      isFit = !isFit;
      if (isFit) {
        savedStyle = {
          objectFit: video.style.objectFit,
          transform: video.style.transform,
          width: video.style.width,
          height: video.style.height
        };
        video.style.objectFit = 'cover';
        video.style.width = '100%';
        video.style.height = '100%';
        btn.textContent = LABEL_FIT_OFF;
      } else {
        video.style.objectFit = savedStyle.objectFit || '';
        video.style.transform = savedStyle.transform || '';
        video.style.width = savedStyle.width || '';
        video.style.height = savedStyle.height || '';
        btn.textContent = LABEL_FIT_ON;
      }
    });

    ON(document, 'fullscreenchange', function () {
      if (!document.fullscreenElement && isFit) {
        video.style.objectFit = savedStyle ? (savedStyle.objectFit || '') : '';
        video.style.transform = savedStyle ? (savedStyle.transform || '') : '';
        video.style.width = savedStyle ? (savedStyle.width || '') : '';
        video.style.height = savedStyle ? (savedStyle.height || '') : '';
        isFit = false;
        btn.textContent = LABEL_FIT_ON;
      }
    });
  }

  if (document.readyState === 'loading') {
    ON(document, 'DOMContentLoaded', init);
  } else {
    init();
  }
})();

/*
 * ============================================================================
 * VE_SAFE_INJECT_SNIPPET — bookmarklet লোডার ফিক্স (YouTube Trusted Types)
 * ============================================================================
 * আপনার বর্তমান bookmarklet এই লাইনে ব্যর্থ হচ্ছে:
 *     var s=document.createElement("script");
 *     s.textContent=code;              // <-- YouTube CSP এখানে ব্লক করে
 *     document.body.appendChild(s);
 *
 * কারণ: YouTube-এ `Content-Security-Policy: require-trusted-types-for
 * 'script'` চালু আছে, তাই raw string সরাসরি <script>.textContent এ বসানো
 * নিষেধ — এই সাইটের জন্য একটা Trusted Types policy বানিয়ে সেটা দিয়ে assign
 * করতে হবে। নিচের bookmarklet সোর্স (unencoded) কপি করে URL-encode করে
 * bookmark হিসেবে সেভ করুন — এটা policy থাকলে policy দিয়ে, না থাকলে
 * সরাসরি assign করে (non-YouTube সাইটে যেমন আগে কাজ করত ঠিক তেমনই):
 *
 * javascript:(function(){
 *   var old = document.getElementById("ve-injected-script");
 *   if (old) old.remove();
 *   document.querySelectorAll("[data-ve-enhanced]").forEach(function (v) {
 *     v.removeAttribute("data-ve-enhanced");
 *   });
 *   window.__VE_V7_ACTIVE__ = false;
 *   fetch("https://raw.githubusercontent.com/marufhossainkeyas11/kslive/refs/heads/main/js/bvcjs.js?v=" + Date.now())
 *     .then(function (r) {
 *       if (!r.ok) throw new Error("HTTP " + r.status);
 *       return r.text();
 *     })
 *     .then(function (code) {
 *       var s = document.createElement("script");
 *       s.id = "ve-injected-script";
 *       if (window.trustedTypes && trustedTypes.createPolicy) {
 *         // YouTube-সহ Trusted-Types-এনফোর্সড সাইটে এই পলিসিটা প্রয়োজন
 *         var policy = trustedTypes.createPolicy("ve-loader-" + Date.now(), {
 *           createScript: function (input) { return input; }
 *         });
 *         s.textContent = policy.createScript(code);
 *       } else {
 *         // Trusted Types না থাকা সাইটে (আগের মতোই) সরাসরি assign
 *         s.textContent = code;
 *       }
 *       document.body.appendChild(s);
 *     })
 *     .catch(function (err) {
 *       alert("Video Enhancer failed: " + err.message);
 *     });
 * })();
 *
 * নোট: কিছু সাইট (YouTube সহ) একাধিক আলাদা নামের trustedTypes policy বানানো
 * সীমাবদ্ধ করতে পারে — তাই policy নাম-এ Date.now() ব্যবহার করা হয়েছে, প্রতিবার
 * ইউনিক নাম দিয়ে policy তৈরি করলে "policy already exists" এরর এড়ানো যায়।
 * ============================================================================
 */
