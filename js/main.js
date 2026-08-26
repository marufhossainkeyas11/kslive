/*!
 * Video Enhancer - main.js
 * ============================================================================
 * এই সংস্করণে নতুন কাঠামোগত ফিক্স যোগ হয়েছে: SHADOW DOM ISOLATION।
 *
 *  (G) CLOSED SHADOW ROOT — আগে সব UI element (gesture layer, scrim,
 *      control bar, badges) সরাসরি video-এর parent (light DOM)-এ বসত।
 *      এর ফলে হোস্ট পেইজের কোনো global CSS rule (যেমন `* { all: unset
 *      !important }` টাইপ কিছু, বা কোনো অতি-agressive reset/override)
 *      সরাসরি এসে আমাদের style ভেঙে দিতে পারত — এবং উল্টোদিকে, পেইজের
 *      JS `document.querySelector('.ve-btn')` দিয়ে আমাদের DOM ধরে
 *      manipulate করতে পারত।
 *
 *      এখন প্রতিটা video-এর জন্য একটা host <div> (id="ve-host-N") তৈরি
 *      হয় video-এর parent-এ, এবং তার উপর `attachShadow({ mode: 'closed' })`
 *      কল হয়। রিগের সব element (gestureLayer/scrim/controlBar/badges)
 *      এবং CSS <style> ট্যাগ — সবকিছু এই shadow root এর ভেতরে বসে।
 *
 *      ফলাফল:
 *        - CSS cascade shadow boundary পার হয় না, তাই পেইজের কোনো rule
 *          (নির্দিষ্ট selector হোক বা `all: unset` টাইপ ইউনিভার্সাল হোক)
 *          shadow root-এর ভেতরের element স্পর্শ করতে পারে না। styles.css
 *          এর `:host { all: initial; ... }` এই boundary-কে আরও pin করে।
 *        - mode:'closed' হওয়ায় `hostEl.shadowRoot` বাইরে থেকে সবসময়
 *          `null` — পেইজের কোনো script (ownProperty রেফারেন্স না থাকলে)
 *          shadow root-এর ভেতরে querySelector/manipulate করতে পারবে না।
 *          rig-এর ভেতরেই একমাত্র closure-scoped রেফারেন্স রাখা হয়।
 *        - প্রতিটা rig-এর নিজস্ব শেডো রুট, তাই একাধিক ভিডিওতে id/class
 *          collision এর কোনো ঝুঁকি নেই, প্রতিটাই সম্পূর্ণ স্বতন্ত্র।
 *
 *  আগের সংস্করণ থেকে বজায় থাকা নীতিগুলো:
 *  (A) single-source-of-truth mode switching, (B) playbackRate ownership
 *  lock, (C) honest UI for impossible ops (Volume Boost hides on failure),
 *  (D) generation-counter state machines for badges, (E) style extraction
 *  (main.js শুধু className টগল করে, ইনলাইন cssText নেই), (F) opaque scrim
 *  for control ownership।
 * ============================================================================
 */
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
    BOOST_MAX_DURATION_MS: 8000,
    AUTO_HIDE_MS: 3000,
    BADGE_VISIBLE_MS: 550,
    BADGE_TRANSITION_MS: 180,
    VOLUME_BOOST_STEP: 0.5,
    VOLUME_BOOST_MAX: 3
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

  var STYLES_URL = 'https://raw.githubusercontent.com/marufhossainkeyas11/kslive/refs/heads/main/js/main.css';
  var CSS_TEXT = ''; // boot() এ fetch হয়ে বসে, প্রতিটা নতুন shadow root এই cached text ব্যবহার করে

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

    var parent = ensureRelativeParent(video);
    var shadowHost = createShadowHost(parent);
    var root = shadowHost.attachShadow({ mode: 'closed' });

    injectStyles(root);

    var rig = buildRig(video, root, shadowHost);
    VE.instances.push(rig);

    syncRigSize(video, shadowHost, rig);

    var ro = new ResizeObserver(function () { syncRigSize(video, shadowHost, rig); });
    ro.observe(video);
    var onWinResize = ON(window, 'resize', function () { syncRigSize(video, shadowHost, rig); });
    var onFsChange = ON(document, 'fullscreenchange', function () {
      setTimeout(function () { syncRigSize(video, shadowHost, rig); }, 50);
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

  function ensureRelativeParent(video) {
    var parent = video.parentElement;
    var style = getComputedStyle(parent);
    if (style.position === 'static') parent.style.position = 'relative';
    return parent;
  }

  // host নিজে সাধারণ light-DOM element (তাই layout/position স্বাভাবিকভাবে
  // কাজ করে), কিন্তু তার ভেতরের সবকিছু closed shadow root-এ লুকানো — বাইরের
  // কোনো CSS selector বা JS querySelector সেই সাবট্রি ধরতে পারে না।
  function createShadowHost(parent) {
    hostCounter += 1;
    var host = DCE('div');
    host.id = 've-host-' + hostCounter;
    // ইনলাইন style attribute ইচ্ছাকৃতভাবে এড়ানো হয়েছে (পেইজের CSS দিয়ে
    // override হওয়ার সুযোগ কমাতে সব positioning shadow root এর :host rule
    // থেকে আসে); position/left/top শুধু syncRigSize() থেকে সেট হয় কারণ
    // সেগুলো dynamic video geometry-নির্ভর, static CSS দিয়ে সম্ভব না।
    APP(parent, host);
    return host;
  }

  function injectStyles(root) {
    var styleEl = DCE('style');
    styleEl.textContent = CSS_TEXT;
    root.appendChild(styleEl);
  }

  function syncRigSize(video, shadowHost, rig) {
    var vRect = video.getBoundingClientRect();
    var pRect = video.parentElement.getBoundingClientRect();
    var leftPx = (vRect.left - pRect.left) + 'px';
    var topPx = (vRect.top - pRect.top) + 'px';
    var widthPx = vRect.width + 'px';
    var heightPx = (vRect.height * (1 - CFG.BOTTOM_SAFE_ZONE)) + 'px';

    // shadow host কে video-এর ঠিক উপরে বসানো হচ্ছে; ভেতরের gestureLayer/
    // scrim/controlBar সবই host-এর সাপেক্ষে (0,0 থেকে 100%) পজিশন করা,
    // তাই host একবার সঠিক জায়গায় বসলে ভেতরের সবকিছু এমনিই align হয়ে যায়
    shadowHost.style.position = 'absolute';
    shadowHost.style.left = leftPx;
    shadowHost.style.top = topPx;
    shadowHost.style.width = widthPx;
    shadowHost.style.height = vRect.height + 'px';
    shadowHost.style.pointerEvents = 'none';
    shadowHost.style.zIndex = '2147483000';

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

  // root প্যারামিটার এখন shadow root — সব element আগের মতোই তৈরি হয়, শুধু
  // APP(container, ...) এর জায়গায় APP(root, ...) ব্যবহার হচ্ছে, ফলে পুরো
  // রিগ shadow boundary-এর ভেতরে বন্দী থাকে।
  function buildRig(video, root, shadowHost) {
    var mode = { active: true };
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
    var closeBtn = makeButton(L.CLOSE, 'Hide controls');
    CLS(closeBtn).add('ve-btn--close');

    var allButtons = [playBtn, volBtn, fitBtn, fsBtn, pipBtn, rotateBtn, switchBtn, closeBtn];
    allButtons.forEach(function (b) { APP(controlBar, b); });

    if (!SUPPORTS_FULLSCREEN) fsBtn.style.display = 'none';
    if (!SUPPORTS_PIP) pipBtn.style.display = 'none';
    if (!SUPPORTS_ORIENTATION_LOCK) rotateBtn.style.display = 'none';

    attachPlayPauseToggle(video, playBtn);
    var volCleanup = attachVolumeBoost(video, volBtn);
    attachFitToggle(video, fitBtn, function () { return uiState.isFullscreen; });
    attachFullscreenToggle(video, shadowHost, fsBtn);
    attachPipToggle(video, pipBtn);
    attachRotateToggle(rotateBtn);

    function setDisabled(btn, disabled) {
      btn.disabled = disabled;
      CLS(btn).toggle('ve-btn--disabled', disabled);
    }
    function syncFullscreenGatedButtons() {
      if (SUPPORTS_ORIENTATION_LOCK) setDisabled(rotateBtn, !uiState.isFullscreen);
      setDisabled(fitBtn, !uiState.isFullscreen);
    }
    syncFullscreenGatedButtons();

    function applyMode() {
      var active = mode.active;
      gestureLayer.style.pointerEvents = active ? 'auto' : 'none';
      shadowHost.style.pointerEvents = active ? 'auto' : 'none';
      CLS(scrim).toggle('ve-scrim--on', active);
      allButtons.forEach(function (b) {
        b.style.pointerEvents = (uiState.controlsExpanded && !b.disabled) ? 'auto' : 'none';
      });
      CLS(switchBtn).toggle('ve-btn--switch-site', !active);
      switchBtn.textContent = active ? L.SWITCH_ON : L.SWITCH_OFF;
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

    function onSingleTapAnywhere() { showControls(); }
    ON(leftZone, 'pointerdown', onSingleTapAnywhere);
    ON(rightZone, 'pointerdown', onSingleTapAnywhere);
    ON(centerZone, 'pointerdown', onSingleTapAnywhere);

    var gestureCtl = attachUnifiedGestures(video, {
      leftZone: leftZone, centerZone: centerZone, rightZone: rightZone,
      boostBadge: boostBadge, seekBadgeL: seekBadgeL, seekBadgeR: seekBadgeR
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
        // shadowHost.remove() পুরো shadow subtree (gestureLayer, scrim,
        // controlBar, badges, <style>) একবারেই সরিয়ে দেয়
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

    function clearPressTimer() {
      if (pressTimer !== null) { clearTimeout(pressTimer); pressTimer = null; }
    }

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
          video.playbackRate = desiredRate;
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

    var onRateChange = ON(video, 'ratechange', function () { /* watchdog handles reassert */ });

    return {
      forceReset: forceReset,
      destroy: function () {
        forceReset();
        listeners.forEach(function (l) { OFF(l[0], l[1], l[2], l[3]); });
        OFF(video, 'ratechange', onRateChange);
      }
    };
  }

  function attachFullscreenToggle(video, shadowHost, btn) {
    if (!SUPPORTS_FULLSCREEN) return;
    ON(btn, 'click', async function (e) {
      e.stopPropagation();
      try {
        if (document.fullscreenElement) await document.exitFullscreen();
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
