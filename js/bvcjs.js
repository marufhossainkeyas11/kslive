/*!
 * Video Enhancer v2 - Raw JS, no dependencies
 * bookmarklet build
 */
(function () {
  'use strict';

  // ঘন ঘন ব্যবহৃত DOM API-র ছোট alias — minify/encode সাইজ কমাতে
  var DCE = function (tag) { return document.createElement(tag); };
  var ON = function (el, ev, fn, opt) { el.addEventListener(ev, fn, opt); };
  var APP = function (parent, child) { parent.appendChild(child); return child; };
  var NOPE = function (e) { e.preventDefault(); };
  var ABS = 'position:absolute;'; // অধিকাংশ overlay element-এর common CSS prefix

  var ATTR_FLAG = 'data-ve-enhanced';
  var BOTTOM_SAFE_ZONE = 0.16;
  var DOUBLE_TAP_MS = 300;
  var LONG_PRESS_MS = 350;
  var SEEK_SECONDS = 10;
  var BOOST_SPEED = 2;
  var Z_TOP = 2147483000;   // overlay সাইটের উপরে
  var Z_BOTTOM = -1;        // overlay সাইটের নিচে (pass-through mode)

  // আসল টাচ ডিভাইস কিনা তা কেবল pointer:coarse দিয়ে ধরা হচ্ছে —
  // viewport width বাদ দেওয়া হয়েছে, কারণ "Desktop site" মোডে viewport বড় দেখায়
  // কিন্তু device তখনও touch-only থাকে। তাই আগের viewport-based চেক ভুল সিদ্ধান্ত দিত।
  var IS_TOUCH = matchMedia('(pointer: coarse)').matches;
  // সাইট নিজে desktop layout দেখাচ্ছে কিনা (touch থাকা সত্ত্বেও) — এটা আলাদা signal,
  // যেটা দিয়ে বোঝা যায় ভিডিও প্লেয়ারের নিজস্ব UI ছোট/dense হতে পারে,
  // তাই বাটন বড় + সবসময় visible রাখা দরকার touch হলে (hover নির্ভরযোগ্য না touch এ)
  var IS_MOBILE_UI = IS_TOUCH;

  // SVG বাদ দেওয়া হলো (encode হলে সাইজ অনেক বেড়ে যায়) — ছোট text label ব্যবহার হচ্ছে
  var ICON_ROTATE = 'Rotate';
  var ICON_FIT_ON = 'Fit';
  var ICON_FIT_OFF = 'Unfit';
  var ICON_SWITCH = 'Switch';

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
    var overlay = buildOverlay(video, container);
    APP(container, overlay);
    syncOverlaySize(video, overlay);

    var ro = new ResizeObserver(function () { syncOverlaySize(video, overlay); });
    ro.observe(video);
    ON(window, 'resize', function () { syncOverlaySize(video, overlay); });
    ON(document, 'fullscreenchange', function () {
      setTimeout(function () { syncOverlaySize(video, overlay); }, 50);
    });

    var cleanupObserver = new MutationObserver(function () {
      if (!document.contains(video)) {
        overlay.remove();
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

  function syncOverlaySize(video, overlay) {
    var vRect = video.getBoundingClientRect();
    var pRect = video.parentElement.getBoundingClientRect();
    overlay.style.left = (vRect.left - pRect.left) + 'px';
    overlay.style.top = (vRect.top - pRect.top) + 'px';
    overlay.style.width = vRect.width + 'px';
    overlay.style.height = vRect.height + 'px';
  }

  function buildOverlay(video, container) {
    var overlay = DCE('div');
    overlay.style.cssText = ABS + 'pointer-events:none;z-index:' + Z_TOP + ';touch-action:manipulation;user-select:none;-webkit-user-select:none;';
    overlay._active = true; // overlay বর্তমানে উপরে (সক্রিয়) আছে কিনা

    var gestureLayer = DCE('div');
    gestureLayer.style.cssText = ABS + 'left:0;top:0;width:100%;height:' + ((1 - BOTTOM_SAFE_ZONE) * 100) + '%;display:flex;pointer-events:auto;';

    var leftZone = DCE('div');
    var rightZone = DCE('div');
    [leftZone, rightZone].forEach(function (z) {
      z.style.cssText = 'flex:1;height:100%;-webkit-touch-callout:none;-webkit-user-select:none;user-select:none;-webkit-tap-highlight-color:transparent;';
    });
    APP(gestureLayer, leftZone);
    APP(gestureLayer, rightZone);
    APP(overlay, gestureLayer);

    attachSeekAndBoost(video, leftZone, 'left');
    attachSeekAndBoost(video, rightZone, 'right');

    var btnBar = DCE('div');
    btnBar.style.cssText = ABS + 'top:8px;right:8px;display:flex;gap:6px;pointer-events:auto;z-index:' + (Z_TOP + 1) + ';transition:opacity .15s ease;' + (IS_MOBILE_UI ? 'opacity:1;' : 'opacity:0;');

    if (!IS_MOBILE_UI) {
      ON(container, 'mouseenter', function () { btnBar.style.opacity = '1'; });
      ON(container, 'mouseleave', function () { btnBar.style.opacity = '0'; });
    }

    var rotateBtn = makeButton(ICON_ROTATE, 'Rotate');
    var fitBtn = makeButton(ICON_FIT_ON, 'Fit');
    var switchBtn = makeButton(ICON_SWITCH, 'Switch');

    APP(btnBar, switchBtn);
    APP(btnBar, fitBtn);
    APP(btnBar, rotateBtn);
    APP(overlay, btnBar);

    attachRotateLock(video, rotateBtn);
    attachFitToggle(video, fitBtn);
    attachLayerSwitch(overlay, gestureLayer, switchBtn, container);

    // boost/seek badge দুটোই একই "dark bubble" স্টাইল শেয়ার করে
    var BADGE = ABS + 'top:50%;background:#000a;color:#fff;font:600 13px/1 sans-serif;border-radius:16px;display:none;pointer-events:none;';

    var boostBadge = DCE('div');
    boostBadge.textContent = '2x';
    boostBadge.style.cssText = BADGE + 'left:50%;transform:translate(-50%,-50%);padding:6px 12px;';
    APP(overlay, boostBadge);
    overlay._boostBadge = boostBadge;

    var seekBadge = DCE('div');
    seekBadge.style.cssText = BADGE + 'transform:translateY(-50%);padding:5px 10px;';
    APP(overlay, seekBadge);
    overlay._seekBadge = seekBadge;

    return overlay;
  }

  function makeButton(label, title) {
    // touch device হলে সবসময় বড় বাটন/ফন্ট — viewport যাই হোক না কেন,
    // কারণ desktop-mode এ থাকলেও আঙুল দিয়েই ট্যাপ করতে হবে
    var fontSize = IS_MOBILE_UI ? 13 : 11;
    var padY = IS_MOBILE_UI ? 8 : 5;
    var padX = IS_MOBILE_UI ? 10 : 8;
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

  // ---------------- Feature: overlay <-> site UI layer switch ----------------
  // overlay বাটন-বার সবসময় ক্লিকযোগ্য থাকে (z-index সবসময় top),
  // কিন্তু gesture layer (video-র উপরের tap/seek/boost অংশ) টগল হয় —
  // toggle off করলে pointer-events none + z-index নিচে নেমে যায়,
  // তাই ট্যাপ সরাসরি নিচের সাইটের নিজস্ব play/pause/seekbar এ যাবে
  function attachLayerSwitch(overlay, gestureLayer, btn, container) {
    ON(btn, 'click', function (e) {
      e.stopPropagation();
      overlay._active = !overlay._active;
      if (overlay._active) {
        gestureLayer.style.pointerEvents = 'auto';
        overlay.style.zIndex = String(Z_TOP);
        btn.style.background = '#0008';
        btn.style.color = '#fff';
      } else {
        gestureLayer.style.pointerEvents = 'none';
        overlay.style.zIndex = String(Z_BOTTOM);
        btn.style.background = '#fc0e';
        btn.style.color = '#000';
      }
    });
  }

  function attachSeekAndBoost(video, zone, side) {
    var pressTimer = null;
    var isBoosting = false;
    var originalRate = 1;
    var lastTapTime = 0;

    function startPress() {
      pressTimer = setTimeout(function () {
        originalRate = video.playbackRate;
        video.playbackRate = BOOST_SPEED;
        isBoosting = true;
        toggleBoostBadge(zone, true);
      }, LONG_PRESS_MS);
    }

    function endPress(wasTap) {
      clearTimeout(pressTimer);
      if (isBoosting) {
        video.playbackRate = originalRate;
        isBoosting = false;
        toggleBoostBadge(zone, false);
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
        showSeekBadge(zone, side, delta);
      } else {
        lastTapTime = now;
      }
    }

    ON(zone, 'pointerdown', function (e) {
      e.preventDefault();
      startPress();
    });
    ON(zone, 'pointerup', function () { endPress(true); });
    ON(zone, 'pointercancel', function () { endPress(false); });
    ON(zone, 'pointerleave', function () { endPress(false); });

    ON(zone, 'contextmenu', NOPE);
    ON(zone, 'selectstart', NOPE);
    ON(zone, 'dragstart', NOPE);
    ON(zone, 'touchstart', NOPE, { passive: false });
  }

  function toggleBoostBadge(zone, show) {
    var overlay = zone.parentElement.parentElement;
    var badge = overlay && overlay._boostBadge;
    if (badge) badge.style.display = show ? 'block' : 'none';
  }

  function showSeekBadge(zone, side, delta) {
    var overlay = zone.parentElement.parentElement;
    var badge = overlay && overlay._seekBadge;
    if (!badge) return;
    badge.textContent = (delta > 0 ? '+' : '') + delta + 's';
    if (side === 'left') {
      badge.style.left = '12%';
      badge.style.right = '';
    } else {
      badge.style.right = '12%';
      badge.style.left = '';
    }
    badge.style.display = 'block';
    clearTimeout(badge._hideT);
    badge._hideT = setTimeout(function () { badge.style.display = 'none'; }, 500);
  }

  // ---------------- Feature: Landscape rotate lock ----------------
  function attachRotateLock(video, btn) {
    ON(btn, 'click', async function (e) {
      e.stopPropagation();
      try {
        var el = video.parentElement;
        if (!document.fullscreenElement) {
          if (el.requestFullscreen) await el.requestFullscreen();
          else if (video.requestFullscreen) await video.requestFullscreen();
        }
        if (screen.orientation && screen.orientation.lock) {
          await screen.orientation.lock('landscape');
        }
      } catch (err) {
        console.warn('[video-enhancer] rotate lock failed:', err.message);
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
        btn.textContent = ICON_FIT_OFF;
      } else {
        video.style.objectFit = savedStyle.objectFit || '';
        video.style.transform = savedStyle.transform || '';
        video.style.width = savedStyle.width || '';
        video.style.height = savedStyle.height || '';
        btn.style.background = '#0008';
        btn.style.color = '#fff';
        btn.textContent = ICON_FIT_ON;
      }
    });
  }

  if (document.readyState === 'loading') {
    ON(document, 'DOMContentLoaded', init);
  } else {
    init();
  }
})();
