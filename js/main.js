/*!
 * Video Enhancer - main.js
 * ============================================================================
 * এই সংস্করণে দুটো নতুন হার্ডেনিং যোগ হয়েছে (কিছু সাইটে দেখা গিয়েছিল যে
 * Ctrl:Us সক্রিয় থাকা সত্ত্বেও স্ক্রিনে ক্লিক করলে সাইটের নিজস্ব কন্ট্রোল
 * প্যানেল ভেসে উঠছিল এবং সেটা আমাদের UI-এর উপরে দেখাচ্ছিল — এর মানে দুটো
 * সমস্যা একসাথে ঘটছিল: (i) ইভেন্ট সাইটের JS পর্যন্ত পৌঁছে যাচ্ছিল, এবং
 * (ii) সাইটের প্যানেল আমাদের চেয়ে "উপরে" চলে আসছিল):
 *
 *  (G) CLOSED SHADOW ROOT — প্রতিটা video-এর জন্য একটা host <div> তৈরি
 *      হয়, তার উপর `attachShadow({ mode: 'closed' })` কল হয়। রিগের সব
 *      element (gestureLayer/scrim/controlBar/badges) ও CSS — সবকিছু এই
 *      shadow root এর ভেতরে বসে। CSS cascade shadow boundary পার হয় না
 *      (styles.css এর `:host { all: initial }` এটাকে আরও pin করে), এবং
 *      mode:'closed' হওয়ায় পেইজের কোনো script এই সাবট্রি ধরতে পারে না।
 *
 *  (H) BODY-LEVEL FIXED HOST — আগে host video-এর parent-এর ভেতরে বসত,
 *      অর্থাৎ সেই parent (বা তার কোনো ancestor) যদি নিজেই একটা নতুন
 *      stacking context তৈরি করে (transform/filter/opacity<1/will-change/
 *      isolation ইত্যাদি দিয়ে — অনেক custom video player ঠিক এটাই করে),
 *      তাহলে আমাদের host সেই context-এর ভেতরে বন্দী থেকে যেত এবং সাইটের
 *      sibling element (তাদের নিজস্ব control panel) আমাদের চেয়ে সামান্য
 *      z-index দিয়েও উপরে চলে আসতে পারত — কারণ z-index শুধু একই stacking
 *      context-এর ভেতরেই তুলনীয়। এখন host সরাসরি `document.body`-এর child
 *      এবং `position: fixed` — তাই এটা পেইজের যেকোনো nested stacking
 *      context থেকে সম্পূর্ণ বেরিয়ে top-level এ থাকে, `z-index: 2147483647`
 *      (max safe 32-bit) তখন প্রকৃতপক্ষে "সবার উপরে" গ্যারান্টি দেয়। video
 *      এর সাথে geometry sync রাখতে getBoundingClientRect() + scroll listener
 *      ব্যবহার হয়েছে (আগে শুধু parent-relative offset ছিল, এখন viewport-
 *      relative + scroll offset compensate করা হচ্ছে, কারণ position:fixed
 *      viewport-এর সাপেক্ষে, document-এর সাপেক্ষে না)।
 *
 *  (I) DOCUMENT-LEVEL BUBBLE-PHASE EVENT CONTAINMENT — আগে shadow root-এর
 *      উপর capture-phase listener বসানো হয়েছিল, কিন্তু সেটা নিজেদের বাটনই
 *      (fullscreen/rotate ইত্যাদি) কাজ করা বন্ধ করে দিয়েছিল — কারণ capture
 *      phase বাইরে থেকে ভেতরে চলে, শেষ পর্যন্ত target-এ পৌঁছানোর *আগেই*
 *      সেই listener stopPropagation কল করে ফেলছিল। এখন একটাই module-level
 *      delegated listener `document`-এ **bubble-phase** এ (capture:false)
 *      বসানো, যেটা shadow root-এর ভেতরের normal capture→target→bubble
 *      flow (আমাদের বাটন handler সহ) সম্পূর্ণ হওয়ার *পরে* ফায়ার হয় —
 *      composedPath() চেক করে দেখে ইভেন্টের উৎস কোনো active rig-এর
 *      shadowHost-এর ভেতরে কিনা, হলে stopPropagation+stopImmediatePropagation
 *      কল করে সেটা document পর্যন্ত bubble করা বন্ধ করে দেয়। এতে সাইটের
 *      bubble-phase বা document-level delegated listener (বেশিরভাগ ভিডিও
 *      প্লেয়ার এভাবেই কাজ করে) আর ইভেন্ট পায় না, অথচ নিজেদের বাটন স্বাভাবিক
 *      থাকে। সততার খাতিরে: browser capture phase (document → ... →
 *      target) সবসময় আগে ঘটে এবং সেটা browser নিজেই চালায় — কোনো bubble-
 *      phase কোড সেটা থামাতে পারে না, তাই সাইটের কোনো capture-phase
 *      listener থাকলে সেটা raw coordinate-level event এখনও দেখতে পারে
 *      (বিরল কেস, বেশিরভাগ প্লেয়ার bubble-phase/delegated listener
 *      ব্যবহার করে)। Ctrl:Site এ প্রতিটা rig নিজের ACTIVE_RIGS entry-তে
 *      active flag false করে দেয়, তখন সাইট স্বাভাবিক নিয়ন্ত্রণ ফিরে পায়।
 *
 *  বাকি নীতি আগের সংস্করণ থেকেই বজায়:
 *  (A) single-source-of-truth mode switching, (B) playbackRate ownership
 *  lock, (C) honest UI for impossible ops (Volume Boost hides on failure),
 *  (D) generation-counter state machines for badges, (E) style extraction,
 *  (F) opaque scrim for control ownership।
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
    // fullscreen চলাকালীন video সাময়িকভাবে videoSlot-এর ভেতরে (shadow
    // root-এর subtree-তে) থাকে (attachFullscreenToggle দেখুন) — তখন
    // video.getBoundingClientRect() আর পেইজের original layout position
    // প্রতিফলিত করে না, বরং fullscreen host-এর ভেতরের অবস্থান দেখায়।
    // shadowHost তখন নিজেই fullscreen element এবং UA স্বয়ংক্রিয়ভাবে
    // viewport পূরণ করে, তাই এই geometry sync পুরোপুরি স্কিপ করা হচ্ছে —
    // নাহলে video-এর slot-এর ভেতরের rect দিয়ে shadowHost-কেই resize করার
    // চেষ্টা হতো, যেটা ভুল এবং অপ্রয়োজনীয়।
    if (document.fullscreenElement === shadowHost) return;

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

    // fullscreen চাওয়া হয় shadowHost-এর উপর, video-এর উপর সরাসরি না (নিচে
    // attachFullscreenToggle এর কমেন্ট দেখুন) — কারণ shadowHost video-এর
    // sibling (document.body-এর direct child), descendant না। কিন্তু
    // Fullscreen API শুধু requestFullscreen() করা element-এর subtree-কেই
    // top-layer এ রেন্ডার করে — video নিজে shadowHost-এর subtree-তে না
    // থাকলে fullscreen host খালি/কালো দেখাবে, video দেখা যাবে না। তাই
    // fullscreen চলাকালীন video-কে DOM-এ সাময়িকভাবে এই videoSlot-এর ভেতরে
    // সরিয়ে আনা হয় (attachFullscreenToggle এ), exit করলে ঠিক আগের
    // parent/position এ ফেরত দেওয়া হয়। videoSlot বাকি সময় খালি থাকে —
    // non-fullscreen অবস্থায় video-এর আসল DOM অবস্থান একদমই অপরিবর্তিত।
    var videoSlot = DCE('div');
    videoSlot.className = 've-video-slot';
    APP(root, videoSlot);

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
    var fsCtl = attachFullscreenToggle(video, shadowHost, videoSlot, fsBtn);
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
      allButtons.forEach(function (b) {
        b.style.pointerEvents = (uiState.controlsExpanded && !b.disabled) ? 'auto' : 'none';
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
        // document.fullscreenElement সবসময় page-wide, এবং fullscreenchange
        // listener প্রতিটা rig আলাদাভাবে document-এ বসায় (attachTo দেখুন) —
        // তাই কোনো ভিন্ন video/rig fullscreen হলেও এটা ফায়ার হয়। শুধু
        // truthy চেক করলে একাধিক video থাকা পেইজে সব rig ভুলভাবে নিজেকে
        // "fullscreen active" মনে করত। === shadowHost চেক দিয়ে এই rig-ই
        // আসল fullscreen element কিনা সেটা নিশ্চিত করা হচ্ছে।
        var iAmFullscreen = document.fullscreenElement === shadowHost;
        uiState.isFullscreen = iAmFullscreen;
        fsBtn.textContent = iAmFullscreen ? L.EXIT_FULLSCREEN : L.FULLSCREEN;
        syncFullscreenGatedButtons();
        // fullscreen বন্ধ হয়ে গেলে (ESC, browser back, অন্য কোনোভাবে —
        // শুধু আমাদের fsBtn ক্লিক না) video যেন সবসময় আগের DOM জায়গায়
        // ফেরত যায়, তাই এখানেও restore কল করা — fsCtl.restoreIfMoved()
        // ইতিমধ্যে restore হয়ে থাকলে কিছু করে না (idempotent)।
        if (!iAmFullscreen) fsCtl.restoreIfMoved();
      },
      destroy: function () {
        gestureCtl.forceReset();
        gestureCtl.destroy();
        if (volCleanup) volCleanup();
        unbindContainment();
        removeFromRegistry();
        OFF(document, 'visibilitychange', onVisChange);
        OFF(window, 'blur', onBlur);
        // shadowHost.remove() এর আগে video ফেরত পাঠাতে হবে যদি সেটা এখন
        // videoSlot-এর ভেতরে থাকে (fullscreen চলাকালীন destroy হলে) —
        // নাহলে shadowHost.remove() video-সহ পুরো subtree DOM থেকে সরিয়ে
        // দেবে, video পেইজ থেকেই হারিয়ে যাবে।
        fsCtl.restoreIfMoved();
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

  // ফিরে দেওয়া অবজেক্টের isMine()/restoreIfMoved() rig-এর নিজস্ব
  // fullscreenchange হ্যান্ডলারে কল হয় (buildRig-এ), যাতে ESC/browser
  // back/অন্য কোনো rig-এর fullscreen change — কোনো কারণেই video আটকে না
  // থাকে বা ভুল rig এটা restore করার চেষ্টা না করে।
  function attachFullscreenToggle(video, shadowHost, videoSlot, btn) {
    if (!SUPPORTS_FULLSCREEN) {
      return { isMine: function () { return false; }, restoreIfMoved: function () {} };
    }

    // video আসল DOM-এ যেখানে ছিল, ঠিক সেই জায়গায় ফেরত দিতে হবে — শুধু
    // parentNode জানলেই যথেষ্ট না (parent-এ একাধিক sibling থাকতে পারে),
    // তাই nextSibling ও রাখা হচ্ছে যাতে insertBefore দিয়ে ঠিক আগের স্থানে
    // বসানো যায়।
    var originalParent = null;
    var originalNextSibling = null;
    var moved = false;

    function moveIntoSlot() {
      if (moved) return;
      originalParent = video.parentNode;
      originalNextSibling = video.nextSibling;
      videoSlot.appendChild(video);
      moved = true;
    }

    function restoreIfMoved() {
      if (!moved) return;
      if (originalParent) {
        originalParent.insertBefore(video, originalNextSibling);
      }
      moved = false;
      originalParent = null;
      originalNextSibling = null;
    }

    ON(btn, 'click', async function (e) {
      e.stopPropagation();
      try {
        if (document.fullscreenElement === shadowHost) {
          await document.exitFullscreen();
          // exitFullscreen() রিজলভ হলেই 'fullscreenchange' ফায়ার হবে,
          // কিন্তু restore এখানেও আগেভাগে কল করা নিরাপদ (moved flag
          // দিয়ে idempotent) — ধীরগতির fullscreenchange dispatch-এর
          // জন্য অপেক্ষা না করেই video যেন দ্রুত পুরনো জায়গায় ফেরে।
          restoreIfMoved();
        } else if (shadowHost.requestFullscreen) {
          // video-কে shadowHost-এর subtree-তে না আনলে fullscreen host
          // খালি দেখাবে (উপরে videoSlot তৈরির কমেন্ট দেখুন) — তাই আগে
          // move, তারপরেই requestFullscreen। কোনো কারণে requestFullscreen
          // reject হলে (catch ব্লকে) video সাথে সাথেই ফেরত পাঠানো হয়,
          // যাতে fullscreen ছাড়াই video হারিয়ে/লুকিয়ে না থাকে।
          moveIntoSlot();
          await shadowHost.requestFullscreen();
        }
      } catch (err) {
        console.warn('[video-enhancer] fullscreen toggle failed:', err.message);
        restoreIfMoved();
      }
    });

    return {
      isMine: function () { return moved; },
      restoreIfMoved: restoreIfMoved
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
