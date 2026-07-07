(function () {
  "use strict";

  const CONFIG = {
    WORKER_URL: "https://summer-firefly-d294.marufhossainkeyas.workers.dev/",
    POLL_INTERVAL_MS: 30000,
    TICK_INTERVAL_MS: 1000,
    MAX_WINDOW_HOURS: 28,
    LIVE_LEAD_MINUTES: 15,
    Z_INDEX: 98,
    MORPH_MS: 500, // expand/collapse animation duration
  };

  const STATE = {
    matches: [],
    hidden: false, // session-only: resets on reload, never persisted
    dragging: false,
    lastRenderKey: "",
    posX: null,
    posY: null,
    // NEW: which match id occupies which fixed slot.
    // Slot positions never move — only which match renders in them changes.
    topId: null,
    bottomId: null,
    morphing: false,
  };

  // ---------- date/time formatting ----------
  const MONTHS = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];

  function formatDateTime(date) {
    const day = date.getDate();
    const month = MONTHS[date.getMonth()];
    let hours = date.getHours();
    const minutes = date.getMinutes();
    const period = hours < 12 ? "AM" : "PM";
    let h12 = hours % 12;
    if (h12 === 0) h12 = 12;
    const mm = minutes.toString().padStart(2, "0");
    return `${month} ${day}, ${h12}:${mm} ${period}`;
  }

  // ---------- styles ----------
  function injectStyles() {
    if (document.getElementById("kslive-widget-styles")) return;
    const css = `
    #kslive-widget {
      position: fixed;
      z-index: ${CONFIG.Z_INDEX};
      width: 224px;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Arial, sans-serif;
      user-select: none;
      -webkit-user-select: none;
      touch-action: none;
      cursor: grab;
      opacity: 0;
      transform: scale(0.94) translateY(6px);
      transition: opacity .3s ease, transform .3s cubic-bezier(.22,1,.36,1);
      will-change: left, top;
    }
    #kslive-widget.kslive-visible { opacity: 1; transform: scale(1) translateY(0); }
    #kslive-widget.dragging {
      cursor: grabbing;
      transition: none;
    }
    #kslive-widget .kslive-glow { display: none; }
    #kslive-widget .kslive-card {
      position: relative;
      background: #141A2C;
      border: 1px solid rgba(255,255,255,0.08);
      border-radius: 16px;
      padding: 12px 12px 12px;
      overflow: hidden;
      box-shadow:
        0 10px 28px rgba(0,0,0,0.55),
        0 2px 6px rgba(0,0,0,0.4);
    }
    #kslive-widget .kslive-card::before {
      content: "";
      position: absolute;
      inset: 0;
      background:
        radial-gradient(90% 70% at 15% 0%, rgba(33, 150, 243, 0.20), transparent 60%),
        radial-gradient(70% 60% at 100% 100%, rgba(33, 150, 243, 0.18), transparent 60%);
      pointer-events: none;
    }
    #kslive-widget .kslive-close {
      position: absolute;
      top: 8px;
      right: 8px;
      width: 20px;
      height: 20px;
      border-radius: 50%;
      background: rgba(255,255,255,0.1);
      border: none;
      color: rgba(255,255,255,0.75);
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 13px;
      line-height: 1;
      cursor: pointer;
      z-index: 3;
      transition: background .15s ease, color .15s ease;
    }
    #kslive-widget .kslive-close:hover { background: rgba(255,255,255,0.2); color: #fff; }
    #kslive-widget .kslive-badge {
      position: relative;
      z-index: 1;
      display: inline-flex;
      align-items: center;
      gap: 5px;
      background: rgba(33, 150, 243, 0.18);
      color: #1976D2;
      font-size: 10px;
      font-weight: 700;
      letter-spacing: .4px;
      padding: 3px 8px;
      border-radius: 5px;
      margin-bottom: 10px;
    }
    #kslive-widget .kslive-badge.live {
      background: #e11d48;
      color: #fff;
    }
    #kslive-widget .kslive-dot { width: 5px; height: 5px; border-radius: 50%; background: currentColor; }
    #kslive-widget .kslive-badge.live .kslive-dot { animation: kslive-pulse 1.1s ease-in-out infinite; }
    @keyframes kslive-pulse { 0%,100%{opacity:1; transform:scale(1);} 50%{opacity:.4; transform:scale(.8);} }

    #kslive-widget .kslive-teams {
      position: relative;
      z-index: 1;
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 4px;
      margin-bottom: 12px;
    }
    #kslive-widget .kslive-team {
      display: flex;
      flex-direction: column;
      align-items: center;
      width: 68px;
      text-align: center;
      gap: 6px;
    }
    #kslive-widget .kslive-team-logo {
      width: 34px; height: 34px;
      display: flex; align-items: center; justify-content: center;
      overflow: hidden;
      transition: width ${CONFIG.MORPH_MS}ms cubic-bezier(.34,1.2,.4,1), height ${CONFIG.MORPH_MS}ms cubic-bezier(.34,1.2,.4,1);
    }
    #kslive-widget .kslive-team img {
      width: 34px; height: 34px; object-fit: cover;
      transition: width ${CONFIG.MORPH_MS}ms cubic-bezier(.34,1.2,.4,1), height ${CONFIG.MORPH_MS}ms cubic-bezier(.34,1.2,.4,1);
    }
    #kslive-widget .kslive-team span {
      font-size: 11px; color: rgba(255,255,255,0.85); font-weight: 600;
      white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 68px;
    }
    #kslive-widget .kslive-vs {
      font-size: 10px; color: rgba(255,255,255,0.3); font-weight: 700;
      letter-spacing: .5px;
    }
    #kslive-widget .kslive-score {
      font-size: 22px; font-weight: 800; color: #fff; letter-spacing: 0.5px;
      font-variant-numeric: tabular-nums;
    }

    #kslive-widget .kslive-countdown {
      position: relative;
      z-index: 1;
      display: flex;
      justify-content: space-between;
      gap: 4px;
      margin-bottom: 9px;
    }
    #kslive-widget .kslive-countdown .unit {
      flex: 1;
      display: flex; flex-direction: column; align-items: center;
      background: rgba(255,255,255,0.05);
      border-radius: 8px;
      padding: 5px 2px 4px;
    }
    #kslive-widget .kslive-countdown .unit b {
      font-size: 14px; color: #fff; font-variant-numeric: tabular-nums;
      line-height: 1.15; font-weight: 700;
    }
    #kslive-widget .kslive-countdown .unit small {
      font-size: 7px; color: rgba(255,255,255,0.4); text-transform: uppercase;
      letter-spacing: .3px; margin-top: 2px; font-weight: 600;
    }
    #kslive-widget .kslive-time-label {
      position: relative;
      z-index: 1;
      font-size: 10px;
      color: rgba(255,255,255,0.4);
      text-align: center;
      letter-spacing: .1px;
    }

    /* ---------- slot wrappers ----------
       Top and bottom are FIXED positions. Only their *contents*
       (which match renders inside) change on click. */
    #kslive-widget .kslive-slot {
      position: relative;
      z-index: 1;
    }
    #kslive-widget .kslive-slot-top {
      margin-bottom: 0;
    }
    #kslive-widget .kslive-slot-bottom {
      margin-top: 10px;
      padding-top: 10px;
      border-top: 1px solid rgba(255,255,255,0.08);
      cursor: pointer;
    }

    /* Morph animation layer: both slots fade/scale their inner content
       when swapping which match occupies them. Telegram-esque: shrink+fade
       out, then the new content grows+fades in from a slightly smaller scale. */
    #kslive-widget .kslive-slot-inner {
      transition:
        opacity ${CONFIG.MORPH_MS}ms cubic-bezier(.34,1.2,.4,1),
        transform ${CONFIG.MORPH_MS}ms cubic-bezier(.34,1.2,.4,1);
      transform-origin: center top;
    }
    #kslive-widget .kslive-slot-inner.kslive-morph-out {
      opacity: 0;
      transform: scale(0.88);
    }
    #kslive-widget .kslive-slot-top .kslive-slot-inner.kslive-morph-out {
      transform: scale(0.9) translateY(-4px);
    }
    #kslive-widget .kslive-slot-bottom .kslive-slot-inner.kslive-morph-out {
      transform: scale(1.06) translateY(2px);
    }

    #kslive-widget .kslive-secondary {
      position: relative;
      display: flex;
      align-items: center;
      justify-content: space-between;
      font-size: 11px;
      color: #fff;
    }
    #kslive-widget .kslive-secondary .kslive-sec-flags {
      display: flex; align-items: center; gap: 6px;
    }
    #kslive-widget .kslive-secondary img {
      width: 16px; height: 16px; object-fit: cover;
      transition: width ${CONFIG.MORPH_MS}ms cubic-bezier(.34,1.2,.4,1), height ${CONFIG.MORPH_MS}ms cubic-bezier(.34,1.2,.4,1);
    }
    #kslive-widget .kslive-secondary .kslive-sec-score {
      font-weight: 700; font-size: 12px; font-variant-numeric: tabular-nums;
      color: rgba(255,255,255,0.85);
    }
    #kslive-widget .kslive-secondary .kslive-sec-live {
      color: #fb7185; font-weight: 700; font-size: 9.5px; display: flex; align-items: center; gap: 4px;
    }
    #kslive-widget .kslive-secondary .kslive-sec-live .kslive-dot { animation: kslive-pulse 1.1s ease-in-out infinite; }
    #kslive-widget .kslive-secondary .kslive-sec-time {
      font-size: 10px; color: rgba(255,255,255,0.4); font-weight: 600;
    }

    @media (max-width: 380px) {
      #kslive-widget { width: 230px; }
      #kslive-widget .kslive-team { width: 60px; }
      #kslive-widget .kslive-score { font-size: 20px; }
    }
    `;
    const style = document.createElement("style");
    style.id = "kslive-widget-styles";
    style.textContent = css;
    document.head.appendChild(style);
  }

  // ---------- match filtering ----------
  function getRelevantMatches(matches) {
    const now = Date.now();
    const maxWindowMs = CONFIG.MAX_WINDOW_HOURS * 60 * 60 * 1000;
    const liveLeadMs = CONFIG.LIVE_LEAD_MINUTES * 60 * 1000;

    return matches
      .map((m) => {
        const start = new Date(m.startTimeUTC).getTime();
        const diff = start - now;
        const isFinished = m.state === "post";
        const isEspnLive = m.state === "in";
        const withinLiveLead = diff <= liveLeadMs;
        const isLive = !isFinished && (isEspnLive || (withinLiveLead && diff > -3 * 60 * 60 * 1000));
        return { ...m, _start: start, _diff: diff, _isLive: isLive, _isFinished: isFinished };
      })
      .filter((m) => !m._isFinished && (m._isLive || m._diff <= maxWindowMs))
      .sort((a, b) => {
        if (a._isLive && !b._isLive) return -1;
        if (!a._isLive && b._isLive) return 1;
        return a._start - b._start;
      })
      .slice(0, 2);
  }

  // ---------- DOM ----------
  function ensureContainer() {
    let el = document.getElementById("kslive-widget");
    if (el) return el;
    el = document.createElement("div");
    el.id = "kslive-widget";
    el.innerHTML = `<div class="kslive-glow"></div><div class="kslive-card"></div>`;
    document.body.appendChild(el);
    return el;
  }

  function teamLogoHtml(team) {
    const alt = escapeHtml(team.abbreviation || team.name || "");
    return `<div class="kslive-team-logo"><img src="${team.logo || ""}" alt="${alt}" onerror="this.parentElement.style.visibility='hidden'"></div>`;
  }

  // Full detailed view — used in the TOP slot only.
  function renderDetailed(match) {
    if (match._isLive) {
      return `
        <div class="kslive-badge live"><span class="kslive-dot"></span>LIVE</div>
        <div class="kslive-teams">
          <div class="kslive-team">
            ${teamLogoHtml(match.home)}
            <span>${escapeHtml(match.home.abbreviation || match.home.name)}</span>
          </div>
          <div class="kslive-score">${match.home.score} : ${match.away.score}</div>
          <div class="kslive-team">
            ${teamLogoHtml(match.away)}
            <span>${escapeHtml(match.away.abbreviation || match.away.name)}</span>
          </div>
        </div>
      `;
    }
    const d = getCountdownParts(match._diff);
    return `
      <div class="kslive-badge">UPCOMING</div>
      <div class="kslive-teams">
        <div class="kslive-team">
          ${teamLogoHtml(match.home)}
          <span>${escapeHtml(match.home.abbreviation || match.home.name)}</span>
        </div>
        <div class="kslive-vs">VS</div>
        <div class="kslive-team">
          ${teamLogoHtml(match.away)}
          <span>${escapeHtml(match.away.abbreviation || match.away.name)}</span>
        </div>
      </div>
      <div class="kslive-countdown">
        <div class="unit"><b>${d.days}</b><small>Days</small></div>
        <div class="unit"><b>${d.hours}</b><small>Hrs</small></div>
        <div class="unit"><b>${d.minutes}</b><small>Min</small></div>
        <div class="unit"><b>${d.seconds}</b><small>Sec</small></div>
      </div>
      <div class="kslive-time-label">${formatDateTime(new Date(match.startTimeUTC))}</div>
    `;
  }

  // Compact single-row view — used in the BOTTOM slot only.
  function renderCompact(match) {
    if (match._isLive) {
      return `
        <div class="kslive-secondary">
          <div class="kslive-sec-flags">
            <img src="${match.home.logo || ""}" onerror="this.style.visibility='hidden'">
            <span class="kslive-sec-score">${match.home.score} : ${match.away.score}</span>
            <img src="${match.away.logo || ""}" onerror="this.style.visibility='hidden'">
          </div>
          <span class="kslive-sec-live"><span class="kslive-dot"></span>LIVE</span>
        </div>
      `;
    }
    const d = getCountdownParts(match._diff);
    const shortCountdown = d.days > 0
      ? `${d.days}d ${d.hours}h left`
      : `${d.hours}h ${d.minutes}m left`;
    return `
      <div class="kslive-secondary">
        <div class="kslive-sec-flags">
          <img src="${match.home.logo || ""}" onerror="this.style.visibility='hidden'">
          <span style="font-size:10px;opacity:.5;">vs</span>
          <img src="${match.away.logo || ""}" onerror="this.style.visibility='hidden'">
        </div>
        <span class="kslive-sec-time">${shortCountdown}</span>
      </div>
    `;
  }

  function getCountdownParts(diffMs) {
    const total = Math.max(0, Math.floor(diffMs / 1000));
    return {
      days: Math.floor(total / 86400),
      hours: Math.floor((total % 86400) / 3600),
      minutes: Math.floor((total % 3600) / 60),
      seconds: total % 60,
    };
  }

  function escapeHtml(str) {
    if (!str) return "";
    return str.replace(/[&<>"']/g, (c) => ({ "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;" }[c]));
  }

  function findById(list, id) {
    return list.find((m) => m.id === id) || null;
  }

  // Decide which match id sits in top/bottom slot, preserving the user's
  // choice across polls as long as that match is still relevant. Falls back
  // to default ordering (live/soonest first) otherwise.
  function resolveSlots(relevant) {
    const [defaultTop, defaultBottom] = relevant;
    let top = STATE.topId ? findById(relevant, STATE.topId) : null;
    let bottom = STATE.bottomId ? findById(relevant, STATE.bottomId) : null;

    if (!top && !bottom) {
      top = defaultTop || null;
      bottom = defaultBottom || null;
    } else if (top && !bottom) {
      bottom = relevant.find((m) => m.id !== top.id) || null;
    } else if (!top && bottom) {
      top = relevant.find((m) => m.id !== bottom.id) || null;
    }
    // if both resolved but relevant now only has 1 match, bottom naturally stays null via findById

    STATE.topId = top ? top.id : null;
    STATE.bottomId = bottom ? bottom.id : null;
    return { top, bottom };
  }

  function render() {
    const container = ensureContainer();
    if (STATE.hidden) {
      container.classList.remove("kslive-visible");
      return;
    }

    const relevant = getRelevantMatches(STATE.matches);
    if (relevant.length === 0) {
      container.classList.remove("kslive-visible");
      STATE.topId = null;
      STATE.bottomId = null;
      STATE.lastRenderKey = "";
      return;
    }

    const { top, bottom } = resolveSlots(relevant);
    if (!top) {
      container.classList.remove("kslive-visible");
      return;
    }

    const card = container.querySelector(".kslive-card");
    const cardKey = top.id + "|" + top._isLive + "|" + (bottom ? bottom.id + "|" + bottom._isLive : "");

    if (STATE.lastRenderKey !== cardKey) {
      buildSlots(card, top, bottom);
      STATE.lastRenderKey = cardKey;
    } else {
      updateLiveNumbers(card, top, bottom);
    }

    requestAnimationFrame(() => container.classList.add("kslive-visible"));
  }

  function buildSlots(card, top, bottom) {
    card.innerHTML = `
      <div class="kslive-close" data-kslive-close>&times;</div>
      <div class="kslive-slot kslive-slot-top" data-slot="top">
        <div class="kslive-slot-inner">${renderDetailed(top)}</div>
      </div>
      ${bottom ? `
      <div class="kslive-slot kslive-slot-bottom" data-slot="bottom" data-kslive-swap="${bottom.id}">
        <div class="kslive-slot-inner">${renderCompact(bottom)}</div>
      </div>` : ""}
    `;
    card.querySelector("[data-kslive-close]").addEventListener("click", (e) => {
      e.stopPropagation();
      hideWidget();
    });
    const bottomSlot = card.querySelector('[data-slot="bottom"]');
    if (bottomSlot) {
      bottomSlot.addEventListener("click", (e) => {
        e.stopPropagation();
        swapSlots();
      });
    }
  }

  // Click on bottom slot -> it becomes top (detailed), old top becomes
  // bottom (compact). Positions themselves never move; only the match
  // assigned to each position changes, with a morph-out/morph-in transition.
  function swapSlots() {
    if (STATE.morphing) return;
    const relevant = getRelevantMatches(STATE.matches);
    const currentTop = findById(relevant, STATE.topId);
    const currentBottom = findById(relevant, STATE.bottomId);
    if (!currentBottom) return;

    STATE.morphing = true;
    const container = document.getElementById("kslive-widget");
    const card = container.querySelector(".kslive-card");
    const topInner = card.querySelector('.kslive-slot-top .kslive-slot-inner');
    const bottomInner = card.querySelector('.kslive-slot-bottom .kslive-slot-inner');

    const finishSwap = () => {
      STATE.topId = currentBottom.id;
      STATE.bottomId = currentTop ? currentTop.id : null;
      STATE.lastRenderKey = ""; // force rebuild with new assignment
      STATE.morphing = false;
      render();
    };

    if (!topInner || !bottomInner) {
      finishSwap();
      return;
    }

    topInner.classList.add("kslive-morph-out");
    bottomInner.classList.add("kslive-morph-out");

    let done = false;
    const onEnd = () => {
      if (done) return;
      done = true;
      finishSwap();
    };
    topInner.addEventListener("transitionend", onEnd, { once: true });
    // Safety fallback in case transitionend doesn't fire (e.g. tab throttling)
    setTimeout(onEnd, CONFIG.MORPH_MS + 80);
  }

  function updateLiveNumbers(card, top, bottom) {
    if (top._isLive) {
      const scoreEl = card.querySelector(".kslive-slot-top .kslive-score");
      if (scoreEl) scoreEl.textContent = `${top.home.score} : ${top.away.score}`;
    } else {
      const d = getCountdownParts(top._diff);
      const units = card.querySelectorAll(".kslive-slot-top .kslive-countdown .unit b");
      if (units.length === 4) {
        units[0].textContent = d.days;
        units[1].textContent = d.hours;
        units[2].textContent = d.minutes;
        units[3].textContent = d.seconds;
      }
    }
    if (bottom) {
      if (bottom._isLive) {
        const secScore = card.querySelector(".kslive-slot-bottom .kslive-sec-score");
        if (secScore) secScore.textContent = `${bottom.home.score} : ${bottom.away.score}`;
      } else {
        const secTime = card.querySelector(".kslive-slot-bottom .kslive-sec-time");
        if (secTime) {
          const d = getCountdownParts(bottom._diff);
          secTime.textContent = d.days > 0
            ? `${d.days}d ${d.hours}h left`
            : `${d.hours}h ${d.minutes}m left`;
        }
      }
    }
  }

  // Hiding is in-memory only for this page view. No localStorage is used,
  // so a reload always brings the widget back.
  function hideWidget() {
    STATE.hidden = true;
    render();
  }

  // ---------- position (in-memory only, no persistence) ----------
  function clampPosition(x, y, rect) {
    const maxX = Math.max(0, window.innerWidth - rect.width);
    const maxY = Math.max(0, window.innerHeight - rect.height);
    return { x: Math.min(Math.max(0, x), maxX), y: Math.min(Math.max(0, y), maxY) };
  }

  function applyPosition(container) {
    const rect = container.getBoundingClientRect();
    if (STATE.posX !== null) {
      const clamped = clampPosition(STATE.posX, STATE.posY, rect);
      container.style.left = clamped.x + "px";
      container.style.top = clamped.y + "px";
      container.style.right = "auto";
      container.style.bottom = "auto";
    } else {
      container.style.right = "16px";
      container.style.bottom = "96px";
    }
  }

  // ---------- drag (smooth, no jitter) ----------
  function setupDrag(container) {
  let startX = 0, startY = 0, origX = 0, origY = 0, moved = false;
  let rafId = null, pendingX = 0, pendingY = 0;

  function applyFrame() {
    container.style.left = pendingX + "px";
    container.style.top = pendingY + "px";
    rafId = null;
  }

  function schedule(x, y) {
    pendingX = x;
    pendingY = y;
    if (rafId == null) rafId = requestAnimationFrame(applyFrame);
  }

  function pointerDown(clientX, clientY) {
    const rect = container.getBoundingClientRect();
    startX = clientX;
    startY = clientY;
    origX = rect.left;
    origY = rect.top;
    moved = false;
    STATE.dragging = true;
    container.classList.add("dragging");
    // Fix: lock in left/top immediately so the element never relies on
    // right/bottom (which we're about to null out) for its position.
    container.style.left = origX + "px";
    container.style.top = origY + "px";
    container.style.right = "auto";
    container.style.bottom = "auto";
  }

  function pointerMove(clientX, clientY) {
    if (!STATE.dragging) return;
    const dx = clientX - startX;
    const dy = clientY - startY;
    if (Math.abs(dx) > 3 || Math.abs(dy) > 3) moved = true;
    const rect = container.getBoundingClientRect();
    const clamped = clampPosition(origX + dx, origY + dy, rect);
    schedule(clamped.x, clamped.y);
  }

  function pointerUp() {
    if (!STATE.dragging) return;
    STATE.dragging = false;
    container.classList.remove("dragging");
    if (moved) {
      const rect = container.getBoundingClientRect();
      STATE.posX = rect.left;
      STATE.posY = rect.top;
    } else {
      // Fix: if it was just a tap (no drag), still persist the locked-in
      // position so it doesn't silently "snap" anywhere on next interaction.
      STATE.posX = origX;
      STATE.posY = origY;
    }
  }

  container.addEventListener("mousedown", (e) => {
    if (e.target.closest("[data-kslive-close]")) return;
    e.preventDefault();
    pointerDown(e.clientX, e.clientY);
  });
  window.addEventListener("mousemove", (e) => { if (STATE.dragging) pointerMove(e.clientX, e.clientY); });
  window.addEventListener("mouseup", pointerUp);

  container.addEventListener("touchstart", (e) => {
    if (e.target.closest("[data-kslive-close]")) return;
    const t = e.touches[0];
    pointerDown(t.clientX, t.clientY);
  }, { passive: true });
  window.addEventListener("touchmove", (e) => {
    if (!STATE.dragging) return;
    const t = e.touches[0];
    pointerMove(t.clientX, t.clientY);
  }, { passive: true });
  window.addEventListener("touchend", pointerUp);
  window.addEventListener("touchcancel", pointerUp);
}

  // ---------- data fetch ----------
  async function fetchMatches() {
    if (STATE.hidden) return;
    try {
      const res = await fetch(CONFIG.WORKER_URL, { cache: "no-store" });
      if (!res.ok) throw new Error("bad response " + res.status);
      const data = await res.json();
      STATE.matches = Array.isArray(data.matches) ? data.matches : [];
      render();
    } catch (err) {
      console.warn("[KSLIVE widget] Failed to fetch match data:", err);
    }
  }

  // ---------- init ----------
  function init() {
    injectStyles();

    const container = ensureContainer();
    applyPosition(container);
    setupDrag(container);

    fetchMatches();
    setInterval(fetchMatches, CONFIG.POLL_INTERVAL_MS);
    setInterval(render, CONFIG.TICK_INTERVAL_MS);

    window.addEventListener("resize", () => {
      if (!STATE.dragging) applyPosition(container);
    });
  }

  // Wait for the full page (all other scripts, images, styles) to finish
  // loading before this widget initializes.
  if (document.readyState === "complete") {
    init();
  } else {
    window.addEventListener("load", init);
  }
})();
