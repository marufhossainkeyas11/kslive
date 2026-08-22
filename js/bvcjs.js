/*!
 * Video Enhancer v3 - Raw JS, no dependencies
 * বাগ ফিক্স + রিডিজাইন — bookmarklet build
 *
 * এই ভার্সনে যা ঠিক করা হয়েছে (v2 থেকে):
 *  1. Switch বাটন এখন সবসময় নিজস্ব top-level layer এ থাকে, video overlay এর ভেতরে না —
 *     তাই gesture-layer কে নিচে পাঠালেও switch বাটন কখনো হারায় না, ফিরিয়ে আনা যায়।
 *  2. Fullscreen আলাদা বাটন — Rotate থেকে আলাদা করা হয়েছে, যাতে শুধু fullscreen করা যায়
 *     rotation ছাড়াই, এবং exit করাও যায় (toggle)।
 *  3. Rotate এখন toggle: lock করলে "Unlock" দেখাবে, চাপলে orientation.unlock() কল হবে।
 *  4. Boost (long-press 2x) state machine পুনর্লিখিত — pointer capture ব্যবহার করে,
 *     এবং visibilitychange/blur এ ফোর্স-রিসেট হয়, তাই ব্যাকগ্রাউন্ডে ট্যাব গেলে বা
 *     touch event miss হলেও boost আটকে থাকবে না।
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

  // z-index স্তরবিন্যাস (top থেকে নিচে):
  //  CONTROL_Z  - বাটন-বার (rotate/fullscreen/fit/switch) — এটা কখনোই নিচে যায় না,
  //               কারণ এটাই একমাত্র জিনিস যেটা দিয়ে ব্যবহারকারী ফিরে সুইচ করতে পারবে।
  //  GESTURE_Z_ON / GESTURE_Z_OFF - tap/seek/boost layer, যেটা টগল হয়।
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
  var LABEL_SWITCH_ON = 'Ctrl: Us';
  var LABEL_SWITCH_OFF = 'Ctrl: Site';

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

  // rig = { gestureLayer, controlBar, destroy(), onFullscreenChange() }
  // gestureLayer আর controlBar দুটো *আলাদা* sibling element, দুটোই container এর সরাসরি child —
  // একটার z-index পাল্টালে অন্যটা প্রভাবিত হয় না। এটাই মূল আর্কিটেকচার-ফিক্স।
  function buildRig(video, container) {
    var state = { gestureActive: true };

    // ---------- Gesture layer (tap/seek/boost) ----------
    var gestureLayer = DCE('div');
    gestureLayer.style.cssText = ABS + 'left:0;top:0;width:100%;' +
      'height:' + ((1 - BOTTOM_SAFE_ZONE) * 100) + '%;' +
      'display:flex;pointer-events:auto;touch-action:manipulation;' +
      'user-select:none;-webkit-user-select:none;z-index:' + GESTURE_Z_ON + ';';

    var leftZone = DCE('div');
    var rightZone = DCE('div');
    [leftZone, rightZone].forEach(function (z) {
      z.style.cssText = 'flex:1;height:100%;-webkit-touch-callout:none;' +
        '-webkit-user-select:none;user-select:none;-webkit-tap-highlight-color:transparent;';
    });
    APP(gestureLayer, leftZone);
    APP(gestureLayer, rightZone);
    APP(container, gestureLayer);

    // boost/seek badge — gestureLayer এর ভেতরেই, কারণ এগুলো শুধু গেসচার সক্রিয় থাকলেই দরকার
    var badgeHost = DCE('div');
    badgeHost.style.cssText = ABS + 'left:0;top:0;width:100%;height:100%;pointer-events:none;';
    APP(gestureLayer, badgeHost);

    var BADGE_CSS = ABS + 'top:50%;background:#000a;color:#fff;font:600 13px/1 sans-serif;' +
      'border-radius:16px;display:none;pointer-events:none;';
    var boostBadge = DCE('div');
    boostBadge.textContent = '2x';
    boostBadge.style.cssText = BADGE_CSS + 'left:50%;transform:translate(-50%,-50%);padding:6px 12px;';
    APP(badgeHost, boostBadge);

    var seekBadge = DCE('div');
    seekBadge.style.cssText = BADGE_CSS + 'transform:translateY(-50%);padding:5px 10px;';
    APP(badgeHost, seekBadge);

    var boostCtl = attachSeekAndBoost(video, leftZone, 'left', boostBadge, seekBadge);
    var boostCtl2 = attachSeekAndBoost(video, rightZone, 'right', boostBadge, seekBadge);

    // ---------- Control bar (rotate / fullscreen / fit / switch) ----------
    // এই বার সবসময় CONTROL_Z তে থাকে, gestureLayer এর z-index যাই হোক না কেন।
    // ফলে "Ctrl: Site" মোডে গেলেও এই বার নিজে কখনো নিচে চাপা পড়ে না, ফিরে আসা যায়।
    var controlBar = DCE('div');
    controlBar.style.cssText = ABS + 'top:8px;right:8px;display:flex;gap:6px;' +
      'pointer-events:none;z-index:' + CONTROL_Z + ';transition:opacity .15s ease;' +
      (IS_TOUCH ? 'opacity:1;' : 'opacity:0;');
    APP(container, controlBar);

    if (!IS_TOUCH) {
      ON(container, 'mouseenter', function () { controlBar.style.opacity = '1'; });
      ON(container, 'mouseleave', function () { controlBar.style.opacity = '0'; });
    }

    var switchBtn = makeButton(LABEL_SWITCH_ON, 'Switch control between overlay and site');
    var fitBtn = makeButton(LABEL_FIT_ON, 'Fit / Zoom video');
    var fsBtn = makeButton(LABEL_FULLSCREEN, 'Fullscreen');
    var rotateBtn = makeButton(LABEL_ROTATE, 'Rotate to landscape');

    // প্রতিটা বাটনের নিজের pointer-events auto করতে হবে, কারণ controlBar-এর
    // pointer-events none (যাতে বার-এর ফাঁকা জায়গা দিয়ে ক্লিক নিচে চলে যায়,
    // কিন্তু বাটনগুলোর উপর ক্লিক ঠিকই কাজ করে)
    [switchBtn, fitBtn, fsBtn, rotateBtn].forEach(function (b) {
      b.style.pointerEvents = 'auto';
    });

    APP(controlBar, switchBtn);
    APP(controlBar, fitBtn);
    APP(controlBar, fsBtn);
    APP(controlBar, rotateBtn);

    attachFitToggle(video, fitBtn);
    attachFullscreenToggle(video, container, fsBtn);
    attachRotateToggle(rotateBtn);

    function setGestureActive(active) {
      state.gestureActive = active;
      gestureLayer.style.pointerEvents = active ? 'auto' : 'none';
      gestureLayer.style.zIndex = String(active ? GESTURE_Z_ON : GESTURE_Z_OFF);
      switchBtn.textContent = active ? LABEL_SWITCH_ON : LABEL_SWITCH_OFF;
      switchBtn.style.background = active ? '#0008' : '#fc0e';
      switchBtn.style.color = active ? '#fff' : '#000';
      // মোড পাল্টানোর সময় যেকোনো চলমান বুস্ট/প্রেস অবস্থা বাতিল করে দেওয়া হয়,
      // নাহলে boost চলা অবস্থায় সুইচ করলে video আটকে 2x থেকে যেতে পারে
      boostCtl.forceReset();
      boostCtl2.forceReset();
    }

    ON(switchBtn, 'click', function (e) {
      e.stopPropagation();
      setGestureActive(!state.gestureActive);
    });

    // ট্যাব ব্যাকগ্রাউন্ডে গেলে বা উইন্ডো blur হলে যেকোনো চলমান long-press/boost বাতিল —
    // এটাই মূলত "background এ অন্য কিছু চললে boost আটকে যাওয়া" বাগের ফিক্স
    ON(document, 'visibilitychange', function () {
      if (document.hidden) { boostCtl.forceReset(); boostCtl2.forceReset(); }
    });
    ON(window, 'blur', function () { boostCtl.forceReset(); boostCtl2.forceReset(); });

    return {
      gestureLayer: gestureLayer,
      controlBar: controlBar,
      onFullscreenChange: function () {
        fsBtn.textContent = document.fullscreenElement ? LABEL_EXIT_FULLSCREEN : LABEL_FULLSCREEN;
      },
      destroy: function () {
        gestureLayer.remove();
        controlBar.remove();
      }
    };
  }

  function syncRigSize(video, rig) {
    var vRect = video.getBoundingClientRect();
    var pRect = video.parentElement.getBoundingClientRect();
    var left = (vRect.left - pRect.left) + 'px';
    var top = (vRect.top - pRect.top) + 'px';
    var width = vRect.width + 'px';
    var height = vRect.height + 'px';

    rig.gestureLayer.style.left = left;
    rig.gestureLayer.style.top = top;
    rig.gestureLayer.style.width = width;
    // gestureLayer এর height BOTTOM_SAFE_ZONE হিসেবে % এ সেট করা আছে বিল্ড টাইমে,
    // কিন্তু সেটা container-relative %, তাই এখানে শুধু top/left/width বসালেই যথেষ্ট।
    // control bar আলাদা, top:8px;right:8px এই সাপেক্ষে বসে, resize এ পুনরায় বসানোর দরকার নেই।
  }

  function makeButton(label, title) {
    var fontSize = IS_TOUCH ? 13 : 11;
    var padY = IS_TOUCH ? 8 : 5;
    var padX = IS_TOUCH ? 10 : 8;
    var b = DCE('button');
    b.type = 'button';
    b.textContent = label;
    b.title = title;
    b.style.cssText =
      'border:none;border-radius:8px;white-space:nowrap;' +
      'background:#0008;color:#fff;' +
      'font:600 ' + fontSize + 'px/1 sans-serif;' +
      'padding:' + padY + 'px ' + padX + 'px;' +
      'cursor:pointer;';
    return b;
  }

  // ---------------- Feature: Long-press 2x speed + Double-tap seek ----------------
  // ফিরে দেয় { forceReset() } যাতে বাইরে থেকে (visibilitychange/switch) স্টেট রিসেট করা যায়
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

    // বাইরে থেকে callable: যেকোনো অবস্থায় সব টাইমার/বুস্ট বাতিল করে সম্পূর্ণ neutral করে
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
        // পয়েন্টার আদৌ এখনো সক্রিয় কিনা যাচাই (মাঝে touchcancel/leave হয়ে থাকলে boost শুরু করা ঠিক না)
        if (activePointerId !== pointerId) return;
        originalRate = video.playbackRate;
        video.playbackRate = BOOST_SPEED;
        isBoosting = true;
        boostBadge.style.display = 'block';
      }, LONG_PRESS_MS);
    }

    function endPress(pointerId, wasTap) {
      if (activePointerId !== pointerId) return; // অন্য পয়েন্টারের up ইভেন্ট, ignore
      clearPressTimer();
      activePointerId = null;
      if (isBoosting) {
        endBoost();
        return; // long-press শেষে tap হিসেবে গণ্য হবে না
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
      // pointer capture নিশ্চিত করে যে এই zone-ই up/cancel পাবে,
      // আঙুল সরে গেলেও (যেমন video-র বাইরে চলে গেলে) ইভেন্ট miss হবে না
      if (zone.setPointerCapture) {
        try { zone.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
      }
      startPress(e.pointerId);
    });
    ON(zone, 'pointerup', function (e) { endPress(e.pointerId, true); });
    ON(zone, 'pointercancel', function (e) { endPress(e.pointerId, false); });
    // pointerleave আর ব্যবহার হচ্ছে না boost বন্ধ করতে (pointer capture থাকায় দরকার নেই);
    // capture থাকলে pointerup/cancel নির্ভরযোগ্যভাবেই আসবে, তাই leave-based early-cancel সরানো হলো
    // যেটা আগে "আঙুল সামান্য সরলেই boost বন্ধ হয়ে যাওয়া" সমস্যা করত।

    ON(zone, 'contextmenu', NOPE);
    ON(zone, 'selectstart', NOPE);
    ON(zone, 'dragstart', NOPE);
    ON(zone, 'touchstart', NOPE, { passive: false });

    return { forceReset: forceReset };
  }

  // ---------------- Feature: Fullscreen toggle (rotate থেকে আলাদা) ----------------
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
      // btn.textContent আপডেট হয় fullscreenchange ইভেন্টে (rig.onFullscreenChange), এখানে না —
      // কারণ ব্রাউজার নিজে থেকেও (Esc চাপলে) fullscreen ছাড়তে পারে, সেটাও ধরতে হবে
    });
  }

  // ---------------- Feature: Landscape rotate — এখন সত্যিকারের toggle ----------------
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
        // কিছু ব্রাউজার fullscreen ছাড়া orientation lock allow করে না —
        // ব্যর্থ হলে state আপডেট না করে silently থেমে যাওয়া হচ্ছে, যাতে
        // বাটনের label বাস্তব অবস্থার সাথে মিথ্যা না বলে
        console.warn('[video-enhancer] rotate lock failed:', err.message);
      }
    });

    // fullscreen থেকে বেরিয়ে গেলে orientation lock এমনিতেই ব্রাউজার রিলিজ করে দেয় —
    // তাই label-ও সেই সাথে রিসেট করা দরকার, নাহলে বাটন "Unrotate" দেখাতেই থাকবে
    // যদিও আসলে আর lock নেই
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
