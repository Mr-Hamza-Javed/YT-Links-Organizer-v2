/* =========================================================
   animations.js — micro-interactions layer (additive)
   - click ripples on buttons / chips / menu items
   - count-up on numeric status-bar chips (only when the value changes)
   - pop on the active-list emoji + badge when you switch lists
   Non-invasive: wraps existing globals, breaks nothing if they're absent.
   ========================================================= */
(function () {
  "use strict";
  var reduce = window.matchMedia && matchMedia("(prefers-reduced-motion: reduce)").matches;

  /* ---------- 1. RIPPLE ---------- */
  var RIPPLE_SEL = ".btn,.icon-btn,.vb-chip,.create-list-btn,.signin-btn,.modal-close," +
                   ".popover__item,.ed-btn,.ed-icbtn,.reorder-banner__done,.statusbar__gear";
  // buttons with a solid accent/white background want a light ripple; everything else a dark one
  var LIGHT_RIPPLE = ".btn--primary,.signin-btn,.reorder-banner__done,.statusbar__gear,.ed-btn--primary";

  if (!reduce) {
    document.addEventListener("pointerdown", function (e) {
      var t = e.target.closest && e.target.closest(RIPPLE_SEL);
      if (!t || t.disabled) return;
      var rect = t.getBoundingClientRect();
      var d = Math.max(rect.width, rect.height);
      var span = document.createElement("span");
      span.className = "a-ripple" + (t.matches(LIGHT_RIPPLE) ? "" : " a-ripple--dark");
      span.style.width = span.style.height = d + "px";
      span.style.left = (e.clientX - rect.left - d / 2) + "px";
      span.style.top = (e.clientY - rect.top - d / 2) + "px";
      // ensure the host clips the ripple
      var cs = getComputedStyle(t);
      if (cs.position === "static") t.style.position = "relative";
      t.appendChild(span);
      setTimeout(function () { span.remove(); }, 620);
    }, true);
  }

  /* ---------- 2. COUNT-UP on status-bar chips ---------- */
  var lastVals = {}; // label -> last numeric value shown

  function countUp(el, from, to) {
    if (reduce || from === to) { el.textContent = String(to); return; }
    var t0 = performance.now(), dur = 700;
    (function frame(now) {
      var p = Math.min(1, (now - t0) / dur);
      var e = 1 - Math.pow(1 - p, 3);
      el.textContent = String(Math.round(from + (to - from) * e));
      if (p < 1) requestAnimationFrame(frame);
    })(t0);
  }

  function animateChips() {
    document.querySelectorAll("#statusChips .status-chip").forEach(function (chip) {
      var valEl = chip.querySelector(".status-chip__val");
      if (!valEl) return;
      var raw = valEl.textContent.trim();
      if (!/^\d+$/.test(raw)) return;              // only pure integers count up
      var to = parseInt(raw, 10);
      var key = (chip.getAttribute("title") || "") + "";
      var from = key in lastVals ? lastVals[key] : 0;
      lastVals[key] = to;
      if (from !== to) countUp(valEl, from, to);
    });
  }

  /* ---------- 3. POP on active-list emoji + badge ---------- */
  function pop(el) {
    if (!el || reduce) return;
    el.classList.remove("a-pop");
    void el.offsetWidth;      // force reflow so the animation restarts
    el.classList.add("a-pop");
  }

  /* ---------- wire wrappers once the app scripts are ready ---------- */
  var firstGrid = true, firstList = true;

  function wrap() {
    if (typeof StatusBar !== "undefined" && typeof StatusBar.render === "function" && !StatusBar.__animWrapped) {
      var _render = StatusBar.render.bind(StatusBar);
      StatusBar.render = function () { _render(); animateChips(); };
      StatusBar.__animWrapped = true;
    }
    if (typeof Videos !== "undefined" && typeof Videos.refreshActiveHeader === "function" && !Videos.__animWrapped) {
      var _hdr = Videos.refreshActiveHeader.bind(Videos);
      Videos.refreshActiveHeader = function () {
        _hdr();
        pop(document.getElementById("activeListEmoji"));
        var b = document.getElementById("activeListBadge");
        if (b && !b.hidden) pop(b);
      };
      Videos.__animWrapped = true;
    }
    // grid: stagger cards ONCE (first paint); afterwards a gentle whole-grid
    // fade only when a list is freshly shown (Videos._fadeNext) — live data
    // updates (e.g. a note autosave) re-render without any flash.
    if (typeof Videos !== "undefined" && typeof Videos.render === "function" && !Videos.__renderWrapped) {
      var _vr = Videos.render.bind(Videos);
      Videos.render = function () {
        _vr();
        var g = document.getElementById("videoGrid");
        if (!g) return;
        var fade = !!Videos._fadeNext;
        Videos._fadeNext = false;
        g.classList.remove("a-stagger", "a-fade");
        if (firstGrid) { firstGrid = false; g.classList.add("a-stagger"); }
        else if (fade && !reduce) { void g.offsetWidth; g.classList.add("a-fade"); }
      };
      Videos.__renderWrapped = true;
    }
    // sidebar: stagger list items ONCE, then never again.
    if (typeof Lists !== "undefined" && typeof Lists.render === "function" && !Lists.__renderWrapped) {
      var _lr = Lists.render.bind(Lists);
      Lists.render = function () {
        _lr();
        var c = document.getElementById("listContainer");
        if (!c) return;
        if (firstList) {
          firstList = false;
          c.classList.add("a-stagger");
          setTimeout(function () { c.classList.remove("a-stagger"); }, 900);
        }
      };
      Lists.__renderWrapped = true;
    }
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", function () { wrap(); animateChips(); });
  } else { wrap(); animateChips(); }
})();
