/*!
 * Video Enhancer v5 - Raw JS, no dependencies
 * bookmarklet build
 *
 * v4 থেকে যা নতুন/পরিবর্তিত:
 *  1. FIX: "Site" control mode এ থাকলে control bar আর কখনো auto-hide বা
 *     ক্রস (✕) চেপে হাইড হবে না — শুধুমাত্র "Us" (overlay) mode active
 *     থাকলেই hide/auto-hide কাজ করে। আগে switch করলেও bar hide হয়ে যেত,
 *     যেটা ভুল আচরণ ছিল কারণ "Site" mode এ ইউজার সাইটের নিজস্ব controls
 *     ব্যবহার করে, তাই আমাদের bar সবসময় দৃশ্যমান/স্ট্যাটিক থাকা উচিত।
 *  2. Play/Pause বাটনে আইকনের (▶ / ❚❚) বদলে স্পষ্ট টেক্সট লেবেল
 *     ("Play" / "Pause") ব্যবহার করা হচ্ছে — ছোট viewport এও পড়তে সহজ।
 */
(function () {
  'use strict';

  // ---------------- ছোট DOM helpers ----------------
  var DCE = function (tag) { return document.createElement(tag); };
  var ON = function (el, ev, fn, opt) { el.addEventListener(ev, fn, opt); return fn; };
  var APP = function (parent, child) { parent.appendChild(child); return child; };
  var NOPE = function (e) { e.preventDefault(); };
  var ABS = 'position:absolute;';

  var ATTR_FLAG = 'data-ve-enhanced';
  var BOTTOM_SAFE_ZONE = 0.16;
  var DOUBLE_TAP_MS = 300;
  var LONG_PRESS_MS = 350;
  var SEEK_SECONDS = 10;
  var BOOST_SPEED = 2;
  var AUTO_HIDE_MS = 3000;
  var VOLUME_BOOST_STEP = 0.5;   // প্রতি ক্লিকে gain এত বাড়বে
  var VOLUME_BOOST_MAX = 3;      // সর্বোচ্চ 3x (native ভলিউমের ৩ গুণ)

  var CONTROL_Z = 2147483000;
  var GESTURE_Z_ON = 2147482999;
  var GESTURE_Z_OFF = -1;

  var IS_TOUCH = matchMedia('(pointer: coarse)').matches;

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
    // control bar container-relative top/right এ বসে থাকে, resize এ নতুন করে বসানোর দরকার নেই
  }

  // rig = { gestureLayer, controlBar, destroy(), onFullscreenChange() }
  function buildRig(video, container) {
    var state = { gestureActive: true, controlsVisible: true, autoHideTimer: null };

    // ============ Gesture layer (tap/seek/boost/play-pause) ============
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
    // left/right বড়, center সরু (play/pause + controls-toggle এর জন্য) —
    // যাতে ডাবল-ট্যাপ-সিক করতে গিয়ে ভুলে play/pause না চেপে যায় আবার center ও যথেষ্ট চওড়া থাকে ট্যাপ করার জন্য
    leftZone.style.flex = '0.42';
    centerZone.style.flex = '0.16';
    rightZone.style.flex = '0.42';
    APP(gestureLayer, leftZone);
    APP(gestureLayer, centerZone);
    APP(gestureLayer, rightZone);
    APP(container, gestureLayer);

    // badge host — 2x/seek ব্যাজ এখানে বসে, উপরের দিকে
    var badgeHost = DCE('div');
    badgeHost.style.cssText = ABS + 'left:0;top:0;width:100%;height:100%;pointer-events:none;';
    APP(gestureLayer, badgeHost);

    var BADGE_CSS = ABS + 'background:#000a;color:#fff;font:600 13px/1 sans-serif;' +
      'border-radius:16px;display:none;pointer-events:none;';
    // 2x badge: উপরের-মাঝামাঝি (18% from top), একদম center এ না — মূল কন্টেন্ট কম ঢাকে
    var boostBadge = DCE('div');
    boostBadge.textContent = '2x';
    boostBadge.style.cssText = BADGE_CSS + 'top:18%;left:50%;transform:translateX(-50%);padding:6px 12px;';
    APP(badgeHost, boostBadge);

    var seekBadge = DCE('div');
    seekBadge.style.cssText = BADGE_CSS + 'top:50%;transform:translateY(-50%);padding:5px 10px;';
    APP(badgeHost, seekBadge);

    var boostCtlL = attachSeekAndBoost(video, leftZone, 'left', boostBadge, seekBadge);
    var boostCtlR = attachSeekAndBoost(video, rightZone, 'right', boostBadge, seekBadge);

    // center zone: single tap = play/pause টগল + controls দেখানো
    attachCenterTap(video, centerZone, function () { showControls(); });
    // left/right zone এ যেকোনো tap-ও controls কে জাগিয়ে রাখবে (auto-hide reset)
    ON(leftZone, 'pointerdown', showControls);
    ON(rightZone, 'pointerdown', showControls);

    // ============ Control bar ============
    // দুই সারি: উপরে ছোট icon strip (Play, Vol+, Fit, Full, Rotate, Switch, ✕)
    // compact padding, semi-transparent pill background — যাতে non-fullscreen
    // ছোট viewport এও পরিষ্কার দেখায়, ভিডিওর টেক্সটের সাথে মিশে না যায়।
    var controlBar = DCE('div');
    controlBar.style.cssText = ABS + 'top:8px;right:8px;left:8px;display:flex;' +
      'justify-content:flex-end;flex-wrap:wrap;gap:5px;pointer-events:none;' +
      'z-index:' + CONTROL_Z + ';transition:opacity .2s ease;opacity:1;';
    APP(container, controlBar);

    var playBtn = makeButton(LABEL_PLAY, 'Play / Pause');
    var volBtn = makeButton(LABEL_VOL, 'Volume boost');
    var fitBtn = makeButton(LABEL_FIT_ON, 'Fit / Zoom video');
    var fsBtn = makeButton(LABEL_FULLSCREEN, 'Fullscreen');
    var rotateBtn = makeButton(LABEL_ROTATE, 'Rotate to landscape');
    var switchBtn = makeButton(LABEL_SWITCH_ON, 'Switch control between overlay and site');
    var closeBtn = makeButton(LABEL_CLOSE, 'Hide controls');
    closeBtn.style.background = '#0006';

    [playBtn, volBtn, fitBtn, fsBtn, rotateBtn, switchBtn, closeBtn].forEach(function (b) {
      b.style.pointerEvents = 'auto';
      APP(controlBar, b);
    });

    attachPlayPauseToggle(video, playBtn);
    attachVolumeBoost(video, volBtn);
    attachFitToggle(video, fitBtn);
    attachFullscreenToggle(video, container, fsBtn);
    attachRotateToggle(rotateBtn);

    // ---------- Auto-hide logic ----------
    // NOTE: "Site" control mode এ (state.gestureActive === false) control bar
    // কখনো hide হবে না — না auto-hide এ, না ✕ বাটনে। কারণ ঐ mode এ ইউজার সাইটের
    // নিজস্ব প্লেয়ার controls ব্যবহার করছে ধরে নেওয়া হয়, তাই আমাদের bar সবসময়
    // visible/static রাখা হয় যাতে দরকার হলে সহজেই আবার "Us" mode এ ফেরা যায়।
    function showControls() {
      state.controlsVisible = true;
      controlBar.style.opacity = '1';
      controlBar.style.pointerEvents = 'none'; // wrapper নিজে none, বাটনগুলো auto (উপরেই সেট করা)
      resetAutoHideTimer();
    }
    function hideControls() {
      if (!state.gestureActive) return; // Site mode: হাইড নিষেধ
      state.controlsVisible = false;
      controlBar.style.opacity = '0';
      clearTimeout(state.autoHideTimer);
    }
    function resetAutoHideTimer() {
      clearTimeout(state.autoHideTimer);
      if (!state.gestureActive) return; // Site mode: auto-hide নিষেধ
      // টাচ ডিভাইসে auto-hide করি (নাহলে সবসময় ভিডিওর উপর বসে থাকবে, যেটাই মূল অভিযোগ ছিল)।
      // মাউস/ডেস্কটপে hover-friendly থাকার জন্য auto-hide স্কিপ করা হচ্ছে,
      // hover ছাড়ার সাথে সাথেই লুকানো যথেষ্ট প্রাকৃতিক আচরণ।
      if (IS_TOUCH) {
        state.autoHideTimer = setTimeout(hideControls, AUTO_HIDE_MS);
      }
    }
    ON(closeBtn, 'click', function (e) { e.stopPropagation(); hideControls(); });

    if (!IS_TOUCH) {
      ON(container, 'mouseenter', showControls);
      ON(container, 'mouseleave', hideControls);
      controlBar.style.opacity = '0'; // ডেস্কটপে শুরুতে লুকানো, hover এ দেখাবে
    } else {
      resetAutoHideTimer(); // টাচ ডিভাইসে শুরুতে দেখাবে, তারপর কিছুক্ষণ পর নিজে হাইড হবে
    }

    // ---------- Switch (overlay <-> site control) ----------
    function setGestureActive(active) {
      state.gestureActive = active;
      gestureLayer.style.pointerEvents = active ? 'auto' : 'none';
      gestureLayer.style.zIndex = String(active ? GESTURE_Z_ON : GESTURE_Z_OFF);
      switchBtn.textContent = active ? LABEL_SWITCH_ON : LABEL_SWITCH_OFF;
      switchBtn.style.background = active ? '#0008' : '#fc0e';
      switchBtn.style.color = active ? '#fff' : '#000';
      boostCtlL.forceReset();
      boostCtlR.forceReset();

      if (active) {
        // Us mode এ ফিরলে normal auto-hide আচরণ আবার চালু হবে
        resetAutoHideTimer();
      } else {
        // Site mode এ ঢুকলে bar সবসময় visible/static থাকবে, কোনো hide timer চলবে না
        clearTimeout(state.autoHideTimer);
        state.controlsVisible = true;
        controlBar.style.opacity = '1';
      }
    }
    ON(switchBtn, 'click', function (e) {
      e.stopPropagation();
      setGestureActive(!state.gestureActive);
    });

    ON(document, 'visibilitychange', function () {
      if (document.hidden) { boostCtlL.forceReset(); boostCtlR.forceReset(); }
    });
    ON(window, 'blur', function () { boostCtlL.forceReset(); boostCtlR.forceReset(); });

    return {
      gestureLayer: gestureLayer,
      controlBar: controlBar,
      onFullscreenChange: function () {
        fsBtn.textContent = document.fullscreenElement ? LABEL_EXIT_FULLSCREEN : LABEL_FULLSCREEN;
      },
      destroy: function () {
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
      'cursor:pointer;box-shadow:0 1px 3px rgba(0,0,0,.4);';
    return b;
  }

  // ---------------- Feature: center-tap play/pause (gesture layer) ----------------
  function attachCenterTap(video, zone, onAnyTap) {
    var lastTapTime = 0;
    ON(zone, 'pointerdown', NOPE);
    ON(zone, 'pointerup', function () {
      onAnyTap();
      var now = Date.now();
      // center zone এ single tap = play/pause; খুব দ্রুত ডাবল-ট্যাপ হলে (বিরল, যেহেতু
      // center সরু) সেটাকেও নিরাপদে একবারই টগল করতে দেওয়া হচ্ছে, ডাবল হ্যান্ডলিং লাগবে না
      if (now - lastTapTime > 50) {
        togglePlay(video);
      }
      lastTapTime = now;
    });
  }

  function togglePlay(video) {
    if (video.paused) video.play().catch(function () {});
    else video.pause();
  }

  // ---------------- Feature: Play/Pause বাটন (টেক্সট লেবেল, আইকন না) ----------------
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
  // video.volume সর্বোচ্চ 1.0 (100%) — এর বেশি বাড়াতে হলে audio graph এ একটা
  // GainNode বসিয়ে gain > 1 সেট করতে হয়। প্রতিটা video-র জন্য একবারই audio graph
  // বানানো হয় (lazy — প্রথম ক্লিকেই তৈরি হয়, কারণ AudioContext অনেক ব্রাউজারে
  // user-gesture ছাড়া শুরু হয় না)।
  function attachVolumeBoost(video, btn) {
    var ctx = null;
    var gainNode = null;
    var sourceNode = null;
    var level = 1; // 1 = normal (কোনো boost না)

    function ensureGraph() {
      if (ctx) return;
      try {
        var AC = window.AudioContext || window.webkitAudioContext;
        ctx = new AC();
        sourceNode = ctx.createMediaElementSource(video);
        gainNode = ctx.createGain();
        gainNode.gain.value = level;
        sourceNode.connect(gainNode).connect(ctx.destination);
      } catch (err) {
        // কিছু সাইট আগে থেকেই video তে CORS/crossOrigin সমস্যা বা অন্য audio graph
        // অ্যাটাচ করা থাকতে পারে (createMediaElementSource একবারই কল করা যায়) —
        // ব্যর্থ হলে চুপচাপ থেমে যাওয়া হচ্ছে, বাটন কাজ করবে না কিন্তু বাকি সব ঠিক থাকবে
        console.warn('[video-enhancer] volume boost unavailable:', err.message);
        ctx = 'failed';
      }
    }

    ON(btn, 'click', function (e) {
      e.stopPropagation();
      ensureGraph();
      if (ctx === 'failed') {
        btn.textContent = 'N/A';
        return;
      }
      if (ctx.state === 'suspended') ctx.resume();
      level += VOLUME_BOOST_STEP;
      if (level > VOLUME_BOOST_MAX) level = 1; // ম্যাক্সের পর আবার normal এ ফেরত (cycle)
      gainNode.gain.value = level;
      btn.textContent = level === 1 ? 'Vol+' : Math.round(level * 100) + '%';
    });
  }

  // ---------------- Feature: Long-press 2x speed + Double-tap seek ----------------
  function attachSeekAndBoost(video, zone, side, boostBadge, seekBadge) {
    var pressTimer = null;
    var isBoosting = false;
    var originalRate = 1;
    var lastTapTime = 0;
    var activePointerId = null;

    function clearPressTimer() {
      if (pressTimer !== null) { clearTimeout(pressTimer); pressTimer = null; }
    }

    function endBoost() {
      if (isBoosting) {
        video.playbackRate = originalRate;
        isBoosting = false;
        boostBadge.style.display = 'none';
      }
    }

    function forceReset() {
      clearPressTimer();
      endBoost();
      activePointerId = null;
      lastTapTime = 0;
    }

    function startPress(pointerId) {
      activePointerId = pointerId;
      clearPressTimer();
      pressTimer = setTimeout(function () {
        if (activePointerId !== pointerId) return;
        originalRate = video.playbackRate;
        video.playbackRate = BOOST_SPEED;
        isBoosting = true;
        boostBadge.style.display = 'block';
      }, LONG_PRESS_MS);
    }

    function endPress(pointerId, wasTap) {
      if (activePointerId !== pointerId) return;
      clearPressTimer();
      activePointerId = null;
      if (isBoosting) {
        endBoost();
        return;
      }
      if (wasTap) handleTap();
    }

    function handleTap() {
      var now = Date.now();
      if (now - lastTapTime < DOUBLE_TAP_MS) {
        lastTapTime = 0;
        var delta = side === 'left' ? -SEEK_SECONDS : SEEK_SECONDS;
        video.currentTime = Math.max(0, Math.min(video.duration || Infinity, video.currentTime + delta));
        showSeekBadge(delta);
      } else {
        lastTapTime = now;
      }
    }

    function showSeekBadge(delta) {
      seekBadge.textContent = (delta > 0 ? '+' : '') + delta + 's';
      if (side === 'left') {
        seekBadge.style.left = '12%';
        seekBadge.style.right = '';
      } else {
        seekBadge.style.right = '12%';
        seekBadge.style.left = '';
      }
      seekBadge.style.display = 'block';
      clearTimeout(seekBadge._hideT);
      seekBadge._hideT = setTimeout(function () { seekBadge.style.display = 'none'; }, 500);
    }

    ON(zone, 'pointerdown', function (e) {
      e.preventDefault();
      if (zone.setPointerCapture) {
        try { zone.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
      }
      startPress(e.pointerId);
    });
    ON(zone, 'pointerup', function (e) { endPress(e.pointerId, true); });
    ON(zone, 'pointercancel', function (e) { endPress(e.pointerId, false); });

    ON(zone, 'contextmenu', NOPE);
    ON(zone, 'selectstart', NOPE);
    ON(zone, 'dragstart', NOPE);
    ON(zone, 'touchstart', NOPE, { passive: false });

    return { forceReset: forceReset };
  }

  // ---------------- Feature: Fullscreen toggle ----------------
  function attachFullscreenToggle(video, container, btn) {
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

  // ---------------- Feature: Landscape rotate toggle ----------------
  function attachRotateToggle(btn) {
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
  function attachFitToggle(video, btn) {
    var isFit = false;
    var savedStyle = null;

    ON(btn, 'click', function (e) {
      e.stopPropagation();
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
        btn.style.background = '#fffd';
        btn.style.color = '#000';
        btn.textContent = LABEL_FIT_OFF;
      } else {
        video.style.objectFit = savedStyle.objectFit || '';
        video.style.transform = savedStyle.transform || '';
        video.style.width = savedStyle.width || '';
        video.style.height = savedStyle.height || '';
        btn.style.background = '#0008';
        btn.style.color = '#fff';
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
