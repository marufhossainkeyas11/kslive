
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

  // ---------------- সাইটের নিজস্ব fullscreen বাটন খোঁজা (best-effort) ----------------
  // উদ্দেশ্য: আমরা video/rig-কে fullscreen করার চেষ্টা করার *আগে* সাইটের
  // নিজস্ব fullscreen বাটন খুঁজে সেটাতেই click পাঠানো — কারণ সাইটের নিজস্ব
  // fullscreen player-এ প্রায়ই subtitle/quality-selector/site-এর নিজস্ব UI
  // ঠিকভাবে কাজ করে, যেটা আমাদের নিজস্ব video.requestFullscreen() একা
  // করালে হারিয়ে যায়। সাইটের বাটন পাওয়া না গেলে বা click করেও আসলে
  // fullscreen না হলে (ভুল বাটনে ক্লিক পড়া বা click ignored হওয়ার
  // সম্ভাবনা আছে বলেই যাচাই করা হয়) আমরা নিজেদের fallback ব্যবহার করি
  // (attachFullscreenToggle এর ownFullscreenFallback দেখুন)।
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

  // video-এর চারপাশে (কয়েক ধাপ ancestor + সেই ancestor-দের descendant)
  // খোঁজা হয় — পুরো document না, কারণ পুরো পেইজে "fullscreen" শব্দযুক্ত
  // অপ্রাসঙ্গিক এলিমেন্টও থাকতে পারে (যেমন কোনো ভিন্ন widget-এর বাটন)।
  // ownFsBtn প্যারামিটার দিয়ে আমাদের নিজের fsBtn বাদ দেওয়া হচ্ছে, কারণ
  // সেটাও এই selector-এর সাথে ম্যাচ করতে পারে (শুধু 'title' attribute-এ
  // "Fullscreen" শব্দ থাকায়) — কিন্তু সেটা shadow root-এর ভেতরে থাকায়
  // querySelectorAll('*')-এ ধরাই পড়বে না (shadow boundary), তবু সততার
  // খাতিরে explicit exclude রাখা হলো যদি ভবিষ্যতে structure পাল্টায়।
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
    // document.body ও যোগ করা হচ্ছে যাতে player wrapper-এর বাইরে বসানো
    // fullscreen বাটন (কিছু সাইটে থাকে) ধরা পড়ে — কিন্তু body থেকে সরাসরি
    // querySelectorAll করলে পুরো পেইজ স্ক্যান হয়ে যায়, তাই body-কে শুধু
    // অন্য কোনো scopeRoot না পাওয়া গেলে (video খুব অগভীর ancestry-তে
    // থাকলে) fallback হিসেবে রাখা হচ্ছে, প্রাধান্য না দিয়ে।
    if (scopeRoots.length === 0 && document.body) scopeRoots.push(document.body);

    for (var i = 0; i < scopeRoots.length; i++) {
      var found = scopeRoots[i].querySelectorAll(FS_BTN_SELECTOR);
      for (var j = 0; j < found.length; j++) candidates.push(found[j]);
    }
    // ছোট ancestor scope-এ কিছু না পেলে, শেষ চেষ্টা হিসেবে বাটন/role=button
    // element-দের টেক্সট চেক করা হয় ("Full Screen" লেখা বাটন, কোনো
    // fullscreen-related attribute ছাড়াই)
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
  // per-rig আলাদা document listener বসানোর বদলে একটাই delegated listener,
  // এবং সেটা IIFE evaluate হওয়ার সাথে সাথেই (script-এর একদম শুরুতে, কোনো
  // fetch/DOM-ready wait ছাড়াই) বসানো হচ্ছে — যাতে পেইজের নিজস্ব script
  // (যেটা সাধারণত পরে/async লোড হয়, বিশেষ করে bookmarklet/extension
  // ইনজেকশনের ক্ষেত্রে) থেকে আমরা attach-order-এ যতটা সম্ভব আগে থাকি।
  //
  // ⚠️ গুরুত্বপূর্ণ: এই listener bubble-phase এ বসানো (capture:false), capture-
  // phase এ না। কারণ:
  //   composed dispatch order (bubbles:true) shadow DOM এ এমন —
  //     ১) CAPTURE: document → ... → shadowHost → shadow root-এর ভেতরে →
  //        ... → target  (বাইরে থেকে ভেতরে)
  //     ২) TARGET: আমাদের বাটনের নিজের click handler
  //     ৩) BUBBLE: target → ... → shadow root ancestors → shadowHost এ
  //        retarget → ... → document  (ভেতর থেকে বাইরে)
  //   যদি এই listener document-এ capture:true দিয়ে বসাই, সেটা ধাপ (১)-এর
  //   একদম শুরুতে ফায়ার হবে — target-এ পৌঁছানোরও আগে — এবং
  //   stopImmediatePropagation capture chain-কে target পর্যন্ত পৌঁছাতেই
  //   দেবে না, ফলে নিজেদের বাটনই আবার কাজ করা বন্ধ হয়ে যাবে (এই বাগটাই
  //   আগে root-এ listener বসিয়ে হয়েছিল, capture:true+document এও সেই একই
  //   ভুল)। bubble-phase এ (capture:false) বসালে এটা ধাপ (৩)-এ, target
  //   phase-এর *পরে* ফায়ার হয় — আমাদের নিজের বাটন handler ততক্ষণে চলে
  //   গেছে, শুধু তারপর retargeted ইভেন্ট document পর্যন্ত bubble করা বন্ধ
  //   হয়।
  //
  // সততার খাতিরে: bubble-phase এ থামানো মানে সাইটের কোনো capture-phase
  // listener (document/ancestor-এ capture:true) তবুও ইভেন্টটা *দেখে
  // ফেলবে* — কারণ capture ধাপ (১) bubble-phase containment-এর আগেই ঘটে
  // যায়, এবং সেই ধাপ browser নিজে চালায়, আমাদের কোনো bubble-phase কোড
  // সেটাকে থামাতে পারে না। এটা স্পেসিফিকেশনের সীমা — কোনো API নেই যা এটা
  // এড়াতে দেয়। আমাদের containment তাই সাইটের bubble-phase listener এবং
  // document-level delegated handler-দের (যেটা অধিকাংশ ভিডিও প্লেয়ার
  // ব্যবহার করে) কার্যকরভাবে আটকায়, কিন্তু খুব কম ব্যবহৃত capture-phase
  // listener-এর বিরুদ্ধে সম্পূর্ণ গ্যারান্টি দেয় না।
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
    // document তখনো তৈরি না থাকলেও (theoretically) addEventListener কল
    // নিরাপদ — বাস্তবে external script হিসেবে ইনজেক্ট হওয়ার সময় document
    // সবসময় বিদ্যমান থাকে। capture:false (bubble-phase) — উপরের নোট দেখুন।
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
    // position:fixed viewport-এর সাপেক্ষে, তাই পেইজের যেকোনো ancestor
    // scroll (window scroll ছাড়াও, কারণ scroll bubble করে) geometry পাল্টে
    // দিতে পারে — capture:true দিয়ে সব scroll ধরা হচ্ছে
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

  // host সরাসরি document.body এর child — video-এর parent বা তার কোনো
  // ancestor-এ বসানো হয় না। এর কারণ: parent-এর ভেতরে বসালে সেই parent
  // নিজে (বা মাঝের কোনো ancestor) transform/filter/opacity<1/will-change/
  // isolation দিয়ে নতুন stacking context বানালে আমরা সেই context-এর ভেতরে
  // বন্দী হয়ে যেতাম — তখন সাইটের sibling element সামান্য z-index দিয়েও
  // আমাদের উপরে চলে আসতে পারত। body-এর direct child + position:fixed
  // হওয়ায় আমরা পেইজের যেকোনো nested stacking context থেকে বেরিয়ে
  // top-level এ থাকি, তাই max z-index তখন প্রকৃত অর্থে "সবার উপরে" হয়।
  function createShadowHost() {
    hostCounter += 1;
    var host = DCE('div');
    host.id = 've-host-' + hostCounter;
    // position/z-index ইনলাইন-এই বসানো হচ্ছে (শুধু light-DOM host element
    // এর উপর, ভেতরের কোনো কিছুর উপর না) — কারণ position:fixed নিজেই একটা
    // নতুন stacking context তৈরি করে, তাই এখান থেকে এর নিচে যা কিছু (shadow
    // root এর ভেতরের সব) স্বয়ংক্রিয়ভাবে একই top-level context-এ থাকে।
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
    // পুরনো ডিজাইনে (v1) shadowHost নিজেই fullscreen element হতো এবং এই
    // ফাংশনটা fullscreen-এ স্কিপ করা হতো। নতুন ডিজাইনে (v2) shadowHost
    // কখনো নিজে fullscreen হয় না — হয় সাইট নিজেই fullscreen হয় (video
    // এমনিই viewport পূরণ করে, rect ঠিকই পাওয়া যায়), অথবা আমাদের
    // fullscreenWrapper fullscreen হয় (video তার ভেতরে width:100%/
    // height:100% দিয়ে viewport পূরণ করে — CSS দেখুন .ve-fullscreen-
    // wrapper > video)। দুই ক্ষেত্রেই video.getBoundingClientRect() ঠিক
    // মান দেয়, তাই আলাদা কোনো fullscreen special-case আর দরকার নেই —
    // এই sync সবসময় একইভাবে চলে, viewport-fitted video geometry-ই rig-কে
    // সঠিক জায়গায় বসিয়ে দেয়।

    // position:fixed viewport-relative, তাই getBoundingClientRect() থেকে
    // সরাসরি left/top ব্যবহার করা যায় — কোনো parent offset বিয়োগ করার
    // দরকার নেই (আগে parent-relative absolute positioning এ যেটা লাগত)
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
    var fsCtl = attachFullscreenToggle(video, shadowHost, fsBtn);
    attachPipToggle(video, pipBtn);
    attachRotateToggle(video, rotateBtn);

    function setDisabled(btn, disabled) {
      btn.disabled = disabled;
      CLS(btn).toggle('ve-btn--disabled', disabled);
    }
    function syncFullscreenGatedButtons() {
      if (SUPPORTS_ORIENTATION_LOCK) setDisabled(rotateBtn, !uiState.isFullscreen);
      setDisabled(fitBtn, !uiState.isFullscreen);
    }
    syncFullscreenGatedButtons();

    // Ctrl:Us সক্রিয় থাকলে shadow root-এর ভেতরে ঘটা কোনো pointer/mouse/
    // touch/click ইভেন্ট যেন সাইটের document-level listener পর্যন্ত না
    // পৌঁছায়। এটা `root`-এ বসানো যাবে না — কারণ capture phase বাইরে থেকে
    // ভেতরে (document → ... → root → ... → target) চলে, root-এ
    // stopPropagation কল করলে সেটা capture chain-কে root থেকে আসল target
    // (যেমন আমাদের নিজের fsBtn/rotateBtn) পর্যন্ত পৌঁছানোর আগেই থামিয়ে
    // দেয় — ফলে নিজেদের বাটনই কাজ করা বন্ধ হয়ে যাচ্ছিল।
    //
    // সঠিক জায়গা হলো একটাই module-level delegated listener, `document`-এ
    // capture:true দিয়ে বসানো (উপরে bindDelegatedContainmentNow দেখুন)।
    // shadow root-এর ভেতরের normal capture→target→bubble flow (আমাদের
    // বাটন handler সহ) shadow boundary পার হওয়ার আগেই সম্পূর্ণ হয়ে যায়;
    // তারপর composed ইভেন্ট retargeted হয়ে বাইরের document-এর capture
    // phase-এ প্রবেশ করে, তখনই delegatedContainEvent তার composedPath()
    // চেক করে দেখে উৎস এই rig-এরই shadowHost কিনা। এখানে rig শুধু
    // ACTIVE_RIGS রেজিস্ট্রিতে নিজের entry-র active flag টগল করে — প্রতি
    // rig-এ আলাদা document listener লাগে না।
    var rigEntry = { shadowHost: shadowHost, active: true };
    ACTIVE_RIGS.push(rigEntry);
    function bindContainment() { rigEntry.active = true; }
    function unbindContainment() { rigEntry.active = false; }
    function removeFromRegistry() {
      var idx = ACTIVE_RIGS.indexOf(rigEntry);
      if (idx !== -1) ACTIVE_RIGS.splice(idx, 1);
    }

    function applyMode() {
      var active = mode.active;
      gestureLayer.style.pointerEvents = active ? 'auto' : 'none';
      shadowHost.style.pointerEvents = active ? 'auto' : 'none';
      CLS(scrim).toggle('ve-scrim--on', active);
      // Ctrl:Site মোডে (active===false) আমাদের overlay-র একমাত্র কাজ হলো
      // ফিরে আসার রাস্তা (switchBtn) দেখানো — বাকি সব বাটন (play/pause,
      // volume, fit, fullscreen, pip, rotate, এমনকি close/× ) অ্যানিমেশন
      // সহ হাইড হয়ে যায়। switchBtn resetAutoHideTimer/hideControls থেকেও
      // মুক্ত থাকে (mode.active===false হলে দুটোই early-return করে, দেখুন
      // showControls/hideControls) — তাই এটা "সবসময়ের জন্য" visible থাকে।
      allButtons.forEach(function (b) {
        var hiddenInSiteMode = !active && b !== switchBtn;
        CLS(b).toggle('ve-btn--hidden-site-mode', hiddenInSiteMode);
        b.style.pointerEvents = (uiState.controlsExpanded && !b.disabled && !hiddenInSiteMode) ? 'auto' : 'none';
      });
      CLS(switchBtn).toggle('ve-btn--switch-site', !active);
      switchBtn.textContent = active ? L.SWITCH_ON : L.SWITCH_OFF;
      // Ctrl:Site এ containment বন্ধ — তখন নিয়ন্ত্রণ ইচ্ছাকৃতভাবেই সাইটের,
      // ইভেন্ট স্বাভাবিকভাবে সাইটের listener পর্যন্ত পৌঁছানো উচিত
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
    // প্যানেল visible থাকা অবস্থায় ভিডিও-এরিয়ায় নতুন কোনো ইন্টার‌্যাকশন
    // (single tap, boost long-press, double-tap seek) এলে প্যানেলটা হাইড
    // করে দেওয়ার জন্য — শুধু hidden অবস্থায় থাকলেই show করা উচিত, তাই
    // toggle (show↔hide উভয় দিকেই সম্ভব), শুধু showControls না।
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

    // প্যানেলের ভেতরে (playBtn/volBtn/fitBtn/... যেকোনো বাটনে) ইন্টার‌্যাকশন
    // হলে auto-hide টাইমার রিসেট হওয়া উচিত — নাহলে ইউজার প্যানেলের মধ্যে
    // বাটন খুঁজতে থাকা অবস্থাতেই ৩ সেকেন্ড নিষ্ক্রিয়তার হিসাবে প্যানেলটা
    // হঠাৎ হাইড হয়ে যেতে পারে। controlBar-এ একটাই delegated pointerdown
    // listener বসিয়ে দেওয়া হচ্ছে (bubble করে সব বাটন থেকেই পৌঁছাবে),
    // প্রতিটা বাটনে আলাদা করে হুক করার দরকার নেই।
    ON(controlBar, 'pointerdown', resetAutoHideTimer);

    // আগে leftZone/rightZone/centerZone-এ pointerdown হলেই সাথে সাথে
    // showControls() কল হতো — মানে ডাবল-ট্যাপ সিক বা লং-প্রেস বুস্টের
    // *প্রথম* ট্যাপেই ফুল কন্ট্রোল প্যানেল খুলে যেত, যদিও সেই জেসচারটা
    // আসলে সিক/বুস্ট হিসেবে resolve হতো। এখন সেই সিদ্ধান্ত (single tap
    // vs seek/double-tap) attachUnifiedGestures-এর ভেতরেই resolve হয়
    // (handleZoneTap/handleCenterTap দেখুন, MULTI_TAP_WINDOW_MS পরে) —
    // শুধু সত্যিকারের single tap-এই onSingleTap কল হয়ে প্যানেল খোলে;
    // ডাবল-ট্যাপ সিক করলে শুধু সিক ব্যাজ (+10s/-10s) দেখা যায়, প্যানেল
    // খোলে না — প্রিমিয়াম প্লেয়ারগুলোর (YouTube/Netflix ধাঁচের) মতো।
    // এই কারণে single tap-এ প্যানেল খুলতে এখন সামান্য বিলম্ব (সর্বোচ্চ
    // MULTI_TAP_WINDOW_MS ≈ ৩৫০ms) হয় — দ্বিতীয় ট্যাপ আসছে কিনা যাচাই
    // করার জন্য এটুকু অপেক্ষা অনিবার্য।

    var gestureCtl = attachUnifiedGestures(video, {
      leftZone: leftZone, centerZone: centerZone, rightZone: rightZone,
      boostBadge: boostBadge, seekBadgeL: seekBadgeL, seekBadgeR: seekBadgeR,
      // single tap: hidden থাকলে show, showing থাকলে hide (toggle)
      onSingleTap: toggleControls,
      // প্যানেল দেখা অবস্থায় long-press করে 2x বুস্ট শুরু হলে প্যানেলটা
      // সরিয়ে দেওয়া হচ্ছে (হাইড না থাকলে কিছু করার নেই, তাই আলাদা করে
      // auto-hide টাইমার ক্লিয়ার করারও দরকার নেই — hideControls() নিজেই
      // সেটা করে)।
      onBoostStart: function () { if (uiState.controlsExpanded) hideControls(); },
      onBoostEnd: function () { resetAutoHideTimer(); },
      // প্যানেল দেখা অবস্থায় ডাবল-ট্যাপ সিক (+10s/-10s) হলে প্যানেলটা
      // সরিয়ে দেওয়া হচ্ছে।
      onSeek: function () { if (uiState.controlsExpanded) hideControls(); }
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
        // document.fullscreenElement সবসময় page-wide, এবং fullscreenchange
        // listener প্রতিটা rig আলাদাভাবে document-এ বসায় (attachTo দেখুন) —
        // তাই কোনো ভিন্ন video/rig fullscreen হলেও এটা ফায়ার হয়। আগে
        // === shadowHost চেক করা হতো, কিন্তু নতুন ডিজাইনে shadowHost
        // কখনোই নিজে fullscreen element হয় না (হয় সাইটের নিজস্ব element,
        // অথবা আমাদের fullscreenWrapper) — তাই সঠিক চেক হলো: এই rig-এর
        // video কি fullscreenElement-এর subtree-এর ভেতরে? contains()
        // দিয়ে এটা নির্ভরযোগ্যভাবে ধরা যায়, fullscreen element যেই-ই হোক।
        var iAmFullscreen = !!(document.fullscreenElement &&
          document.fullscreenElement.contains(video));
        uiState.isFullscreen = iAmFullscreen;
        fsBtn.textContent = iAmFullscreen ? L.EXIT_FULLSCREEN : L.FULLSCREEN;
        syncFullscreenGatedButtons();
        if (iAmFullscreen) {
          // সাইটের নিজস্ব বাটন দিয়ে fullscreen হলে (আমাদের own fallback
          // ব্যবহার না হলে) shadowHost-কে fullscreenElement-এর ভেতরে
          // adopt করা হচ্ছে — নাহলে rig fullscreen-এর top layer-এর বাইরে
          // পড়ে থাকায় অদৃশ্য থেকে যায়। usingOwnFallback true থাকলে বা
          // ইতিমধ্যে adopt হয়ে থাকলে এটা no-op।
          fsCtl.adoptIntoSiteFullscreen();
        } else {
          // fullscreen বন্ধ হয়ে গেলে (ESC, browser back, অন্য কোনোভাবে —
          // শুধু আমাদের fsBtn ক্লিক না) video/shadowHost যেন সবসময় আগের DOM
          // জায়গায় ফেরত যায় (আমাদের নিজস্ব fallback ব্যবহার করা হলে), তাই
          // এখানেও restore কল করা — fsCtl.restoreIfMoved() ইতিমধ্যে restore
          // হয়ে থাকলে (বা সাইটের বাটন দিয়ে fullscreen হয়ে থাকলে, যেখানে
          // আমরা কিছুই move করিনি) কিছু করে না (idempotent/no-op)। একইভাবে
          // shadowHost সাইটের fullscreenElement-এ adopt হয়ে থাকলে সেটাও
          // এখানে আগের জায়গায় ফেরত পাঠানো হচ্ছে।
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
        // fullscreen fallback চলাকালীন destroy হলে video/shadowHost এখনও
        // fullscreenWrapper-এর ভেতরে থাকতে পারে — shadowHost.remove() এর
        // আগে fsCtl.restoreIfMoved() কল করে video/shadowHost ঠিক আগের
        // DOM জায়গায় ফেরত পাঠানো হচ্ছে (নাহলে video-ও shadowHost-এর
        // subtree ভুল করে সরে যেত)। এটা fullscreenWrapper-কেও DOM থেকে
        // সরিয়ে দেয়, যা fullscreen element রিমুভ হওয়ার কারণে ব্রাউজার
        // স্বয়ংক্রিয়ভাবেই fullscreen বন্ধ করে দেয় (spec অনুযায়ী)। সাইটের
        // নিজস্ব বাটন দিয়ে fullscreen হয়ে থাকলে (আমরা কিছুই move করিনি)
        // restoreIfMoved() no-op — সাইটের fullscreen অক্ষতই থাকে, যা
        // ঠিক আছে কারণ সেটা আমাদের rig destroy হওয়ার সাথে সম্পর্কহীন।
        fsCtl.restoreIfMoved();
        fsCtl.releaseFromSiteFullscreen();
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
      // ৩৫০ms (MULTI_TAP_WINDOW_MS) অপেক্ষা করা হচ্ছে আরেকটা ট্যাপ আসে কিনা
      // দেখার জন্য। এই টাইমার যদি না-ক্যান্সেল হয়ে ফায়ার করে (মানে এর
      // মধ্যে আর কোনো ট্যাপ আসেনি), তখনই s.count-এর তখনকার মান দেখে বোঝা
      // যায় সিকোয়েন্সটা আসলে seek হয়েছিল (>=2) নাকি প্লেইন single tap
      // (===1) — seek হয়ে থাকলে onSingleTap কল করা হয় না, শুধু সিক ব্যাজ
      // (doSeek উপরে already show করেছে) দেখানো হয়, ফুল কন্ট্রোল প্যানেল
      // খোলে না।
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
      // এখানে পৌঁছালে count===1 — টাইমার আনক্যান্সেলড ফায়ার করা মানেই
      // দ্বিতীয় ট্যাপ আসেনি (এলে উপরের ===2 ব্রাঞ্চে timer আগেই clear হয়ে
      // যেত), তাই এটা নিশ্চিতভাবে single tap — কন্ট্রোল প্যানেল দেখানো
      // হচ্ছে। ডাবল-ট্যাপ (play/pause টগল) এ প্যানেল খোলে না।
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

  // নতুন ডিজাইন (v2) — আগের সংস্করণে shadowHost-কে (একটা প্লেইন body-level
  // div, নিজস্ব কোনো visual content ছাড়া) সরাসরি fullscreen করানো হতো,
  // যার ফলে পুরো পেইজ কালো হয়ে যেত (fullscreen backdrop) এবং তার ভেতরে
  // ছোট video/rig ভাসতে থাকত — user report করেছেন এটা "সাইট fullscreen"
  // এর মতো আচরণ করছিল, "video fullscreen" এর মতো না।
  //
  // নতুন পদ্ধতি, অগ্রাধিকার অনুযায়ী:
  //   ১. সাইটের নিজস্ব fullscreen বাটন খোঁজা (findSiteFullscreenButton) —
  //      পেলে সেটাতেই click পাঠানো হয়, আমাদের নিজস্ব Fullscreen API একদম
  //      ব্যবহারই করা হয় না। সাইট নিজে যেভাবে video/player fullscreen
  //      করে সেটাই হয় — আমাদের rig তখনও body-level shadowHost হিসেবে
  //      position:fixed + video-এর getBoundingClientRect() অনুসরণ করেই
  //      থাকে (syncRigSize, যেটা resize/scroll/fullscreenchange-এ এমনিতেই
  //      চলে) — সাইটের fullscreen video যেহেতু viewport পূরণ করে
  //      (video-এর CSS width/height সাইট নিজেই 100% করে দেয় fullscreen
  //      মোডে, প্রায় সব প্রোডাকশন প্লেয়ারেই এটাই স্বাভাবিক), rig
  //      স্বয়ংক্রিয়ভাবেই সঠিক viewport-sized overlay হয়ে যায় — কোনো
  //      নতুন কোড লাগে না, existing geometry-sync mechanism-ই যথেষ্ট।
  //   ২. সাইটের বাটন না পাওয়া গেলে (বা ক্লিক করেও আসলে fullscreen না
  //      হলে — POLL_MS পরে যাচাই করা হয়), fallback: আমাদের নিজস্ব
  //      fullscreenWrapper তৈরি করে video + shadowHost দুটোকেই তার ভেতরে
  //      সাময়িকভাবে নিয়ে আসা হয়, তারপর সেই wrapper-কেই fullscreen করা
  //      হয় (video বা shadowHost এককভাবে না) — এতে video ও rig একই
  //      fullscreen subtree-তে sibling হিসেবে থাকে, rig shadow root-এর
  //      ভেতরের absolute-positioned layer গুলো video-এর ঠিক ওপরে
  //      z-index দিয়ে বসে যায় (ঠিক normal mode-এ যেভাবে বসে)।
  function attachFullscreenToggle(video, shadowHost, btn) {
    if (!SUPPORTS_FULLSCREEN) {
      return { restoreIfMoved: function () {} };
    }

    var SITE_BTN_VERIFY_MS = 400; // সাইটের বাটনে click করার পর আসলেই
    // fullscreenElement সেট হলো কিনা যাচাই করতে এতটুকু সময় দেওয়া হয়
    // (কিছু সাইট animation/transition এর পরে fullscreen কল করে)

    // --- fallback wrapper state ---
    var fullscreenWrapper = null;
    var videoOriginalParent = null, videoOriginalNextSibling = null;
    var hostOriginalParent = null, hostOriginalNextSibling = null;
    var hostOriginalPosition = '';
    var usingOwnFallback = false;

    // --- সাইটের নিজস্ব fullscreen-এর ভেতরে shadowHost "adopt" করার state ---
    // কারণ: shadowHost সবসময় document.body-এর সরাসরি child (position:fixed)।
    // fullscreen API-তে যে element fullscreen হয় সেটাই শুধু "top layer"-এ
    // প্রমোট হয় এবং viewport জুড়ে রেন্ডার হয় — সেই element-এর subtree-এর
    // বাইরের যেকোনো কিছু (আমাদের shadowHost সহ, position:fixed +
    // z-index:2147483647 থাকা সত্ত্বেও) fullscreen চলাকালীন আর দেখা যায় না,
    // এটা browser rendering-এর স্পেসিফিকেশন-লেভেল আচরণ, z-index দিয়ে
    // এড়ানো যায় না। তাই সাইটের নিজস্ব বাটন দিয়ে fullscreen হলে
    // (video.requestFullscreen() আমরা কল করিনি, সাইট নিজে করেছে) আমাদের
    // shadowHost-কে সাময়িকভাবে সেই fullscreenElement-এর ভেতরে সরিয়ে
    // নিতে হবে, নাহলে আমাদের কন্ট্রোল বার/জেসচার লেয়ার fullscreen-এর
    // ভেতরে অদৃশ্য থেকে যায় (ইউজার রিপোর্ট করা বাগ এটাই)।
    var movedIntoSiteFullscreen = false;
    var siteFsOriginalParent = null, siteFsOriginalNextSibling = null;

    function buildWrapper() {
      var w = DCE('div');
      w.className = 've-fullscreen-wrapper';
      // পুরোপুরি inline styles — কোনো light-DOM <style> ট্যাগ যোগ করা
      // হচ্ছে না (উপরের styles.css এর NOTE দেখুন), যাতে পেইজের CSS-এর
      // সাথে selector conflict/leak-এর কোনো সুযোগ না থাকে।
      w.style.position = 'fixed';
      w.style.left = '0'; w.style.top = '0';
      w.style.width = '100%'; w.style.height = '100%';
      w.style.margin = '0'; w.style.padding = '0'; w.style.border = '0';
      w.style.background = '#000';
      w.style.zIndex = '2147483647';
      return w;
    }

    // fullscreen fallback চলাকালীন video-এর নিজস্ব ইনলাইন width/height/
    // objectFit temporarily 100%/100%/contain করে দেওয়া হয় (wrapper পূরণ
    // করতে) — exit করলে video-এর আসল ইনলাইন স্টাইল (যা কিছুই থাকুক,
    // এমনকি খালি স্ট্রিং হলেও) হুবহু ফেরত দেওয়া হয়, যাতে সাইটের নিজস্ব
    // layout-এ কোনো স্থায়ী পরিবর্তন না থেকে যায়।
    var videoOriginalInlineStyle = null;

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

      // fullscreenWrapper নিজেই viewport পূরণ করবে, তাই shadowHost-এর
      // position:fixed আর দরকার নেই/ঠিক না — wrapper-এর ভেতরে absolute
      // করে দেওয়া হচ্ছে (wrapper নিজে position:fixed, তাই absolute child
      // তার সাপেক্ষে ঠিক viewport কোঅর্ডিনেটেই বসবে — syncRigSize এর
      // viewport-relative left/top হিসাব অপরিবর্তিত থাকে)। z-index আগের
      // মতোই max রাখা হচ্ছে যাতে video-এর ওপরেই থাকে।
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

    // সাইটের fullscreenElement-এর ভেতরে shadowHost-কে সরিয়ে "adopt" করে,
    // যাতে এটা top-layer subtree-এর অংশ হয়ে যায় এবং আমাদের নিজস্ব
    // fallback (enterOwnFallback) চলার সময় কিছু করে না — সেই পাথে
    // shadowHost ইতিমধ্যেই fullscreenWrapper-এর ভেতরে থাকে, যেটা নিজেই
    // fullscreenElement।
    function adoptIntoSiteFullscreen() {
      if (usingOwnFallback || movedIntoSiteFullscreen) return;
      var fsEl = document.fullscreenElement;
      if (!fsEl || !fsEl.contains(video)) return;
      // fsEl নিজেই <video> হলে তার ভেতরে কোনো visible child বসানো যায় না
      // (video element arbitrary DOM overlay রেন্ডার করে না) — এই কেসে
      // adopt করার কিছু নেই, click handler-এই এটা আলাদাভাবে handle করা
      // হয় (own fallback-এ পাঠিয়ে)।
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

    ON(btn, 'click', async function (e) {
      e.stopPropagation();

      // এক্সিট পথ: হয় সাইটের fullscreen (আমরা shadowHost/wrapper কিছুই
      // fullscreen করিনি, শুধু সাইটের বাটনে click পাঠিয়েছিলাম), অথবা
      // আমাদের নিজস্ব fallback fullscreen — দুটোর জন্যই
      // document.exitFullscreen() ঠিকই কাজ করে (যে element-ই fullscreen
      // থাকুক না কেন, exitFullscreen() সেটা বন্ধ করে)। কিন্তু আগে যাচাই
      // করতে হবে যে fullscreen থাকা element আসলে *এই* video-কেই ধারণ করে
      // — পেইজে একাধিক video/rig থাকলে অন্য কোনো video fullscreen থাকা
      // অবস্থায় এই বাটনে ক্লিক করলে যেন ভুলবশত সেই ভিন্ন fullscreen বন্ধ
      // করে না দেয়।
      var currentlyFullscreenForThisVideo = !!(document.fullscreenElement &&
        document.fullscreenElement.contains(video));

      if (currentlyFullscreenForThisVideo) {
        try { await document.exitFullscreen(); } catch (err) {
          console.warn('[video-enhancer] exitFullscreen failed:', err.message);
        }
        exitOwnFallback();
        return;
      }

      // এই video-এর জন্য fullscreen সক্রিয় না, কিন্তু document.fullscreenElement
      // truthy হতে পারে (অন্য কোনো video/element fullscreen) — সেক্ষেত্রে
      // নতুন fullscreen request করার আগে ব্রাউজার প্রথমটা exit করানো লাগতে
      // পারে না (আধুনিক ব্রাউজারে একাধিক নেস্টেড fullscreen request সাধারণত
      // reject হয়), তাই সরাসরি নতুন request পাঠানো হচ্ছে — ব্যর্থ হলে catch
      // ব্লকেই ধরা পড়বে, ইউজারকে ভুল অবস্থায় ফেলবে না।

      // এন্ট্রি পথ ১: সাইটের নিজস্ব fullscreen বাটন
      var siteBtn = findSiteFullscreenButton(video, btn);
      if (siteBtn) {
        try {
          siteBtn.click();
          await delay(SITE_BTN_VERIFY_MS);
          if (document.fullscreenElement && document.fullscreenElement.contains(video)) {
            // fullscreenElement যদি সরাসরি <video> ট্যাগ হয় (অনেক সাইট
            // কোনো wrapper ছাড়াই সরাসরি video.requestFullscreen() কল করে),
            // তাহলে তার ভেতরে আমাদের shadowHost বসানোর কোনো জায়গাই নেই
            // (video element arbitrary child overlay হিসেবে রেন্ডার করে
            // না) — ফলে আমাদের কন্ট্রোল বার/জেসচার লেয়ার fullscreen-এর
            // ভেতরে একদমই দেখা যাবে না, ঠিক এই বাগটাই রিপোর্ট হয়েছে।
            // এই কেসে সাইটের fullscreen থেকে বেরিয়ে নিচের নিজস্ব
            // fallback (wrapper, যেখানে video+rig একসাথে থাকে) এ চলে
            // যাওয়া হচ্ছে।
            if (document.fullscreenElement !== video) return; // সফল — fullscreenchange-এ shadowHost adopt হবে (adoptIntoSiteFullscreen দেখুন)
            try { await document.exitFullscreen(); } catch (exitErr) {}
          }
        } catch (err) {
          console.warn('[video-enhancer] site fullscreen button click failed:', err.message);
        }
        // সাইটের বাটন থাকলেও কাজ করেনি (বা সরাসরি video-কেই fullscreen
        // করে ফেলেছে, যেখানে overlay বসানো যায় না) — নিচে fallback এ চলে যাওয়া হচ্ছে
      }

      // এন্ট্রি পথ ২: আমাদের নিজস্ব fallback — video + rig একসাথে একটা
      // wrapper-এ এনে সেই wrapper-কে fullscreen করা হয়, যাতে rig video-এর
      // ওপরে overlay থাকে (শুধু video একা fullscreen করলে rig subtree-এর
      // বাইরে পড়ে যেত, আগের বাগ)।
      try {
        enterOwnFallback();
        await fullscreenWrapper.requestFullscreen();
      } catch (err) {
        console.warn('[video-enhancer] fullscreen fallback failed:', err.message);
        exitOwnFallback();
      }
    });

    return {
      restoreIfMoved: exitOwnFallback,
      adoptIntoSiteFullscreen: adoptIntoSiteFullscreen,
      releaseFromSiteFullscreen: releaseFromSiteFullscreen
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
      // শুধু global fullscreenElement truthy চেক করলে ভিন্ন কোনো video/rig
      // fullscreen exit করলেও এই rig নিজের rotate-lock ভুলভাবে রিসেট করে
      // ফেলত (একাধিক video থাকা পেইজে) — video.contains() দিয়ে নিশ্চিত
      // করা হচ্ছে এই rig-এরই fullscreen exit হয়েছে কিনা।
      var stillFullscreenForThisVideo = !!(document.fullscreenElement &&
        document.fullscreenElement.contains(video));
      if (!stillFullscreenForThisVideo && isLocked) { isLocked = false; btn.textContent = L.ROTATE; }
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
      // একই কারণে (উপরে attachRotateToggle দেখুন) video.contains() চেক —
      // ভিন্ন কোনো video fullscreen exit করলে এই rig-এর fit state যেন
      // ভুলভাবে রিসেট না হয়।
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
