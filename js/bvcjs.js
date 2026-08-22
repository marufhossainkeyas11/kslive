/*!
 * Video Enhancer v6 - Raw JS, no dependencies
 * bookmarklet build
 *
 * v5 থেকে যা নতুন/পরিবর্তিত:
 *  1. FIX: "Unfit" (active fit state) বাটনের সাদা ব্যাকগ্রাউন্ড বাদ — এখন বাকি
 *     সব বাটনের মতোই normal dark background থাকে সবসময়।
 *  2. FIX: YouTube-এ "TrustedScript" এরর — একটা <style> ইনজেকশন Trusted Types
 *     পলিসি ছাড়া innerHTML/textContent সেট করার চেষ্টা করছিল কিছু সাইটে যেখানে
 *     কড়া CSP আছে। এখন সব স্টাইল সরাসরি inline style property হিসেবে সেট করা
 *     হয় (cssText/style.prop) — কোনো <style> বা <script> element তৈরি/টেক্সট
 *     ইনজেকশন করা হয় না, তাই Trusted Types পলিসি ভাঙে না।
 *  3. Control bar এখন শুধু single-tap এ show হয়। long-press (2x hold) বা
 *     double/triple-tap (seek) এ control bar টগল হবে না — শুধু বাজ (badge)
 *     দেখাবে, বার অপরিবর্তিত থাকবে যা ছিল তাই।
 *  4. Center zone: single tap আর play/pause করে না (খালি controls জাগায়)।
 *     শুধুমাত্র ডাবল-ট্যাপে play/pause টগল হয়।
 *  5. Long-press 2x speed এখন পুরো gesture layer জুড়ে (left+center+right,
 *     পুরো ভিডিও এলাকা) কাজ করে, আগে শুধু সাইড জোনে সীমাবদ্ধ ছিল।
 *  6. Escalating multi-tap seek: ডাবল-ট্যাপ=10s, ট্রিপল=20s, চতুর্থ=30s...
 *     প্রতি অতিরিক্ত ট্যাপে +10s যোগ হয়, চলমান multi-tap sequence চলাকালীন
 *     badge "+10"/"+20" ইত্যাদি হালকা pop/fade অ্যানিমেশনসহ visually আপডেট হয়।
 *  7. Fullscreen-নির্ভর ফিচার (Rotate, Fit) — non-fullscreen অবস্থায় এগুলো
 *     সাধারণত কোনো কাজে আসে না (বিশেষত মোবাইলে), তাই ফুলস্ক্রিনে না গেলে
 *     disabled/hidden থাকে, ফুলস্ক্রিনে ঢুকলে সচল হয়ে যায়। এছাড়া ব্রাউজার
 *     আদৌ Fullscreen API / Screen Orientation API সাপোর্ট করে কিনা যাচাই করে
 *     না করলে সংশ্লিষ্ট বাটন পুরোপুরি hide করে দেওয়া হয়।
 *  8. PiP (Picture-in-Picture) বাটন যোগ — ব্রাউজার সাপোর্ট করলেই কেবল দেখা যাবে।
 *  9. FIX: Control bar hidden (opacity 0) অবস্থায় সেই জায়গায় ক্লিক করলে আর
 *     বাটন ফায়ার হবে না — hidden হলে pointer-events:none পুরো bar-এ প্রযোজ্য
 *     হয় (আগে wrapper pointer-events none থাকলেও ভেতরের বাটনগুলোর auto থাকায়
 *     ভুতুড়েভাবে কাজ করত)।
 *  10. ছোট ছোট transition/animation যোগ হয়েছে: badge pop-in, বাটন hover/active
 *      scale, controls bar স্লাইড+ফেড ইত্যাদি — সামগ্রিক অনুভূতি আরও পালিশড।
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
  var MULTI_TAP_WINDOW_MS = 350; // এই সময়ের মধ্যে পরের ট্যাপ পড়লে সিকোয়েন্স চলতে থাকে
  var LONG_PRESS_MS = 350;
  var SEEK_STEP_SECONDS = 10;    // প্রতিটা অতিরিক্ত ট্যাপে এত সেকেন্ড করে বাড়বে
  var BOOST_SPEED = 2;
  var AUTO_HIDE_MS = 3000;
  var VOLUME_BOOST_STEP = 0.5;
  var VOLUME_BOOST_MAX = 3;

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

  // rig = { gestureLayer, controlBar, destroy(), onFullscreenChange() }
  function buildRig(video, container) {
    var state = { gestureActive: true, controlsVisible: true, autoHideTimer: null, isFullscreen: false };

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
      'border-radius:16px;display:none;pointer-events:none;' +
      'transition:transform .18s cubic-bezier(.34,1.56,.64,1),opacity .18s ease;';
    var boostBadge = DCE('div');
    boostBadge.textContent = '2x';
    boostBadge.style.cssText = BADGE_CSS + 'top:18%;left:50%;transform:translateX(-50%) scale(.85);opacity:0;padding:6px 12px;';
    APP(badgeHost, boostBadge);

    var seekBadgeL = DCE('div');
    seekBadgeL.style.cssText = BADGE_CSS + 'top:50%;left:12%;transform:translateY(-50%) scale(.85);opacity:0;padding:6px 12px;font-size:15px;';
    APP(badgeHost, seekBadgeL);

    var seekBadgeR = DCE('div');
    seekBadgeR.style.cssText = BADGE_CSS + 'top:50%;right:12%;transform:translateY(-50%) scale(.85);opacity:0;padding:6px 12px;font-size:15px;';
    APP(badgeHost, seekBadgeR);

    function popBadge(el, text) {
      el.textContent = text;
      el.style.display = 'block';
      // রিফ্লো ট্রিগার করে transition রিস্টার্ট করা, যাতে ধারাবাহিক ট্যাপেও অ্যানিমেশন পুনরায় চলে
      el.offsetHeight; // eslint-disable-line no-unused-expressions
      var baseTransform = el === boostBadge ? 'translateX(-50%)' : 'translateY(-50%)';
      el.style.transform = baseTransform + ' scale(1.08)';
      el.style.opacity = '1';
      clearTimeout(el._settleT);
      el._settleT = setTimeout(function () {
        el.style.transform = baseTransform + ' scale(1)';
      }, 90);
    }
    function hideBadge(el) {
      var baseTransform = el === boostBadge ? 'translateX(-50%)' : 'translateY(-50%)';
      el.style.opacity = '0';
      el.style.transform = baseTransform + ' scale(.85)';
      clearTimeout(el._hideT);
      el._hideT = setTimeout(function () { el.style.display = 'none'; }, 200);
    }

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

    // ফুলস্ক্রিন API সাপোর্ট না থাকলে fullscreen বাটনই দেখানোর মানে নেই
    if (!SUPPORTS_FULLSCREEN) {
      fsBtn.style.display = 'none';
    }
    // PiP সাপোর্ট না থাকলে বাটন hide
    if (!SUPPORTS_PIP) {
      pipBtn.style.display = 'none';
    }
    // Orientation lock সাপোর্ট না থাকলে rotate বাটন hide (কোনো কাজেই আসবে না)
    if (!SUPPORTS_ORIENTATION_LOCK) {
      rotateBtn.style.display = 'none';
    }

    attachPlayPauseToggle(video, playBtn);
    attachVolumeBoost(video, volBtn);
    attachFitToggle(video, fitBtn, function () { return state.isFullscreen; });
    attachFullscreenToggle(video, container, fsBtn);
    attachPipToggle(video, pipBtn);
    attachRotateToggle(rotateBtn);

    // ---------- Fullscreen-নির্ভর ফিচার এনাবল/ডিসেবল ----------
    // Rotate আর Fit সাধারণত non-fullscreen ছোট ভিউপোর্টে কোনো কাজে আসে না
    // (বিশেষত মোবাইলে) — তাই fullscreen এ না গেলে এই দুটো বাটন disabled দেখাবে,
    // fullscreen এ ঢুকলেই সচল হবে। hide করা হয় না (hide করলে ব্যবহারকারী বুঝবে
    // না ফিচারটা আছে), শুধু grey-out + non-interactive করা হয়।
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
    // control bar শুধু single-tap এ visible হয়/থাকে; long-press বা multi-tap
    // (badge-triggering gestures) কখনো এই bar কে show/hide টগল করবে না।
    function showControls() {
      state.controlsVisible = true;
      controlBar.style.opacity = '1';
      controlBar.style.transform = 'translateY(0)';
      controlBar.style.pointerEvents = 'none'; // wrapper none; বাটনগুলো নিজেরাই auto
      resetAutoHideTimer();
    }
    function hideControls() {
      if (!state.gestureActive) return; // Site mode: হাইড নিষেধ
      state.controlsVisible = false;
      controlBar.style.opacity = '0';
      controlBar.style.transform = 'translateY(-6px)';
      // FIX: hidden অবস্থায় bar-এর জায়গায় ক্লিক করলে যেন কোনো বাটন ফায়ার না হয় —
      // wrapper তো আগে থেকেই pointer-events:none, কিন্তু ভেতরের প্রতিটা বাটনে
      // আলাদা করে auto সেট ছিল বলে hidden অবস্থাতেও ক্লিকযোগ্য থেকে যাচ্ছিল।
      // তাই hide করার সময় সব বাটনের pointer-events সরাসরি none করে দেওয়া হচ্ছে।
      allButtons.forEach(function (b) { b.style.pointerEvents = 'none'; });
      clearTimeout(state.autoHideTimer);
    }
    ON(controlBar, 'transitionend', function (e) {
      // fade আউট শেষ হওয়ার পরও visible থাকলে (মানে showControls দিয়ে বাতিল হয়নি)
      // বাটনগুলো আবার auto করে দেওয়া, show হলে normal থাকবে
      if (e.propertyName !== 'opacity') return;
      if (state.controlsVisible) {
        allButtons.forEach(function (b) {
          if (!b.disabled) b.style.pointerEvents = 'auto';
        });
      }
    });
    function resetAutoHideTimer() {
      clearTimeout(state.autoHideTimer);
      if (!state.gestureActive) return; // Site mode: auto-hide নিষেধ
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

    // single-tap zones শুধুই controls দেখায়/জাগায় (play/pause না, badge না)
    function onSingleTapAnywhere() { showControls(); }
    ON(leftZone, 'pointerdown', onSingleTapAnywhere);
    ON(rightZone, 'pointerdown', onSingleTapAnywhere);
    ON(centerZone, 'pointerdown', onSingleTapAnywhere);

    // ============ Gesture behavior: long-press (পুরো স্ক্রিন) + zone-wise multi-tap seek + center double-tap play/pause ============
    var gestureCtl = attachUnifiedGestures(video, {
      gestureLayer: gestureLayer,
      leftZone: leftZone,
      centerZone: centerZone,
      rightZone: rightZone,
      boostBadge: boostBadge,
      seekBadgeL: seekBadgeL,
      seekBadgeR: seekBadgeR,
      popBadge: popBadge,
      hideBadge: hideBadge
    });

    // ---------- Switch (overlay <-> site control) ----------
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

    ON(document, 'visibilitychange', function () {
      if (document.hidden) gestureCtl.forceReset();
    });
    ON(window, 'blur', function () { gestureCtl.forceReset(); });

    return {
      gestureLayer: gestureLayer,
      controlBar: controlBar,
      onFullscreenChange: function () {
        state.isFullscreen = !!(document.fullscreenElement);
        fsBtn.textContent = state.isFullscreen ? LABEL_EXIT_FULLSCREEN : LABEL_FULLSCREEN;
        syncFullscreenGatedButtons();
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

  // ---------------- Feature: Play/Pause বাটন (টেক্সট লেবেল) ----------------
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
  function attachVolumeBoost(video, btn) {
    var ctx = null;
    var gainNode = null;
    var sourceNode = null;
    var level = 1;

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
      if (level > VOLUME_BOOST_MAX) level = 1;
      gainNode.gain.value = level;
      btn.textContent = level === 1 ? 'Vol+' : Math.round(level * 100) + '%';
    });
  }

  // ---------------- Feature: unified gestures ----------------
  // - পুরো gesture layer (left+center+right) জুড়ে long-press ধরলে 2x speed hold
  // - left/right zone এ multi-tap (double/triple/...) হলে escalating seek
  //     (2 taps=10s, 3 taps=20s, 4 taps=30s ...), প্রতি ধাপে বিদ্যমান multi-tap
  //     window এর মধ্যে হতে হবে, নাহলে নতুন সিকোয়েন্স শুরু হবে ১ ট্যাপ থেকে
  // - center zone এ শুধুই ডাবল-ট্যাপে play/pause টগল হয়; সিঙ্গেল ট্যাপে
  //     কিছুই হয় না (শুধু showControls, যেটা আগেই আলাদা লিসেনারে হ্যান্ডল হয়েছে)
  function attachUnifiedGestures(video, refs) {
    var pressTimer = null;
    var isBoosting = false;
    var originalRate = 1;
    var activePointerId = null;
    var pressStartedInCenter = false;
    var pressMoved = false;
    var startX = 0, startY = 0;
    var MOVE_TOLERANCE = 10;

    // side (left/right) ভিত্তিক multi-tap sequence স্টেট, স্বাধীনভাবে ট্র্যাক করা
    var seekSeq = {
      left: { count: 0, timer: null },
      right: { count: 0, timer: null }
    };
    // center zone এর জন্য নিজস্ব multi-tap counter, শুধু double-tap দরকার
    var centerSeq = { count: 0, timer: null };

    function clearPressTimer() {
      if (pressTimer !== null) { clearTimeout(pressTimer); pressTimer = null; }
    }
    function endBoost() {
      if (isBoosting) {
        video.playbackRate = originalRate;
        isBoosting = false;
        refs.hideBadge(refs.boostBadge);
      }
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
      endBoost();
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

    function startPress(pointerId, clientX, clientY, zoneEl) {
      activePointerId = pointerId;
      pressStartedInCenter = (zoneEl === refs.centerZone);
      pressMoved = false;
      startX = clientX; startY = clientY;
      clearPressTimer();
      // long-press 2x এখন পুরো layer জুড়ে (left/center/right সব) কাজ করে
      pressTimer = setTimeout(function () {
        if (activePointerId !== pointerId || pressMoved) return;
        originalRate = video.playbackRate;
        video.playbackRate = BOOST_SPEED;
        isBoosting = true;
        refs.popBadge(refs.boostBadge, '2x');
      }, LONG_PRESS_MS);
    }

    function doSeek(side, taps) {
      var seconds = SEEK_STEP_SECONDS * taps;
      var delta = side === 'left' ? -seconds : seconds;
      video.currentTime = Math.max(0, Math.min(video.duration || Infinity, video.currentTime + delta));
      var badge = side === 'left' ? refs.seekBadgeL : refs.seekBadgeR;
      refs.popBadge(badge, (delta > 0 ? '+' : '') + delta + 's');
    }

    function handleZoneTap(side) {
      var s = seekSeq[side];
      s.count += 1;
      clearTimeout(s.timer);
      // প্রথম ট্যাপে কিছুই হয় না (single tap শুধু showControls করে, seek না) —
      // দ্বিতীয় ট্যাপ থেকেই seek শুরু হয় (double=10s)
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
        return; // long-press শেষ হওয়াকে ট্যাপ হিসেবে গণ্য করা হয় না
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
        startPress(e.pointerId, e.clientX, e.clientY, zone);
      });
      ON(zone, 'pointermove', function (e) {
        if (activePointerId !== e.pointerId) return;
        if (Math.abs(e.clientX - startX) > MOVE_TOLERANCE || Math.abs(e.clientY - startY) > MOVE_TOLERANCE) {
          pressMoved = true;
        }
      });
      ON(zone, 'pointerup', function (e) { endPress(e.pointerId, zone, true); });
      ON(zone, 'pointercancel', function (e) { endPress(e.pointerId, zone, false); });
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
  // শুধুমাত্র fullscreen অবস্থায় সক্রিয় (setDisabled দিয়ে নিয়ন্ত্রিত হয় buildRig এ)
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
  // শুধুমাত্র fullscreen অবস্থায় সক্রিয় (non-fullscreen এ সাধারণত ভিডিও এমনিতেই
  // কন্টেইনারের সাইজে ফিট থাকে, fit/zoom করার বাস্তব প্রয়োজন পড়ে না)
  function attachFitToggle(video, btn, isFullscreenGetter) {
    var isFit = false;
    var savedStyle = null;

    ON(btn, 'click', function (e) {
      e.stopPropagation();
      if (!isFullscreenGetter()) return; // disabled অবস্থায় সেফগার্ড
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

    // ফুলস্ক্রিন থেকে বেরিয়ে গেলে fit স্টেট রিসেট করে দেওয়া হয় (ধারাবাহিকতার জন্য)
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
