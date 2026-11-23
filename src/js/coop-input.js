/* Coop Reader input: Apple Pencil / stylus drawing that never scrolls the page, and pinch / trackpad / double-tap zoom.
 *
 * Pencil: strokes are captured through Pointer Events with coalesced samples (fast writing keeps every point), and the
 * browser's own scrolling is shut off for stylus contacts three ways: touch-action:none on the drawing layer, non-passive
 * touchstart/touchmove handlers that cancel stylus touches (Safari reports touchType 'stylus'), and a page scroll lock while a
 * stroke is in progress. Once a pen has been seen, fingers stop drawing: one finger pans, two fingers zoom (palm rejection).
 *
 * Zoom: live CSS transform around the pinch centre while the fingers move, one sharp re-render on release, with the scroll
 * position corrected so the content under the fingers stays put. Comment pins are positioned from the transformed page box,
 * so they follow the page but keep their on-screen size.
 */
(function (root) {
  'use strict';
  var ZOOM = { min: 0.25, maxPdf: 6, maxImage: 5 };

  // ---- pure helpers (unit tested) --------------------------------------------------------------------------
  function clampZoom(z, max) { z = +z; if (!isFinite(z)) return 1; return Math.max(ZOOM.min, Math.min(max || ZOOM.maxPdf, z)); }
  function scaleFromDistances(d0, d1) { return d0 > 8 && d1 > 0 ? d1 / d0 : 1; }
  function wheelFactor(deltaY, deltaMode) { var d = deltaMode === 1 ? deltaY * 16 : deltaMode === 2 ? deltaY * 400 : deltaY; return Math.exp(-Math.max(-120, Math.min(120, d)) * 0.0105); }
  // content point (nx, ny) = fraction of the page that was under the fingers; after the re-render it must sit under the fingers' final position
  function scrollForFocal(o) { return { left: o.scrollLeft + (o.newRect.left + o.nx * o.newRect.width - o.fx), top: o.scrollTop + (o.newRect.top + o.ny * o.newRect.height - o.fy) }; }
  function doubleTapTarget(zoom, fitZoom, max) { return zoom > fitZoom * 1.15 ? fitZoom : clampZoom(Math.max(fitZoom * 2.2, zoom * 1.8), max); }
  function mid(a, b) { return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }; }
  function dist(a, b) { return Math.hypot(a.x - b.x, a.y - b.y); }

  var api = { ZOOM: ZOOM, clampZoom: clampZoom, scaleFromDistances: scaleFromDistances, wheelFactor: wheelFactor, scrollForFocal: scrollForFocal, doubleTapTarget: doubleTapTarget, mid: mid, dist: dist };
  root.CoopInput = api;
  if (typeof document === 'undefined' || !document.getElementById) return;

  // ---- DOM controller ------------------------------------------------------------------------------------------
  var G = root;                                  // page globals (state, currentZoom, ...) are read lazily
  var ptrs = new Map(), pinch = null, penSeen = false, strokeActive = false, lastTap = { t: 0, x: 0, y: 0 }, safety = 0, wheelTimer = 0, panLast = null;
  try { penSeen = localStorage.getItem('coop-pen-only') === '1'; } catch (_) {}

  function zoomable() { return typeof state !== 'undefined' && (state.fileType === 'pdf' || state.fileType === 'image') && !!cachedFileBytes; }
  function maxZoom() { return state.fileType === 'image' ? ZOOM.maxImage : ZOOM.maxPdf; }
  function layers() { return ['pdf-canvas', 'pdf-text-layer', 'pdf-form-layer', 'image-view'].map(function (id) { return document.getElementById(id); }).filter(function (e) { return e && e.offsetParent !== null && getComputedStyle(e).display !== 'none'; }); }
  function redrawOverlays() { try { annotSig = ''; redrawAnnots(); if (G.CoopCommentsUI) CoopCommentsUI.onChanged(); } catch (_) {} }

  function beginPinch(fx, fy) {
    if (pinch || !zoomable()) return false;
    var el = contentEl(), r = el.getBoundingClientRect(); if (!r.width) return false;
    pinch = { startZoom: currentZoom, nx: (fx - r.left) / r.width, ny: (fy - r.top) / r.height, fx0: fx, fy0: fy, fx: fx, fy: fy, s: 1, raf: 0, origins: [] };
    pinch.origins = layers().map(function (e) { var b = e.getBoundingClientRect(); e.style.willChange = 'transform'; return { e: e, ox: fx - b.left, oy: fy - b.top }; });
    return true;
  }
  function updatePinch(scale, fx, fy) {
    if (!pinch) return;
    pinch.s = clampZoom(pinch.startZoom * scale, maxZoom()) / pinch.startZoom; pinch.fx = fx; pinch.fy = fy;
    if (pinch.raf) return;
    pinch.raf = requestAnimationFrame(function () {
      if (!pinch) return; pinch.raf = 0;
      var tx = pinch.fx - pinch.fx0, ty = pinch.fy - pinch.fy0;
      pinch.origins.forEach(function (o) { o.e.style.transformOrigin = o.ox + 'px ' + o.oy + 'px'; o.e.style.transform = 'translate(' + tx + 'px,' + ty + 'px) scale(' + pinch.s + ')'; });
      redrawOverlays(); showZoomBadge(Math.round(pinch.startZoom * pinch.s * 100) + '%');
    });
  }
  function clearTransforms() { ['pdf-canvas', 'pdf-text-layer', 'pdf-form-layer', 'image-view'].forEach(function (id) { var e = document.getElementById(id); if (e) { e.style.transform = ''; e.style.transformOrigin = ''; e.style.willChange = ''; } }); }
  function endPinch() {
    if (!pinch) return; var p = pinch; if (p.raf) cancelAnimationFrame(p.raf);
    var z = clampZoom(p.startZoom * p.s, maxZoom());
    if (Math.abs(z - p.startZoom) < 0.005) { pinch = null; clearTransforms(); redrawOverlays(); return; }
    p.pending = true; currentZoom = z; userZoomed = true;
    clearTimeout(safety); safety = setTimeout(function () { if (pinch === p) api.afterRender(); }, 4000);
    if (state.fileType === 'image') { applyImageZoom(); api.afterRender(); } else renderCurrentPage();   // PDF: afterRender() runs when the sharp canvas is ready
  }
  // called right after a page canvas was swapped in (and for images after resizing): drop the preview transform, keep content under the fingers
  // The page can scroll in the viewer container OR in the window (depends on the layout): handle each axis separately.
  function scrollState() {
    var v = viewerContainer, de = document.scrollingElement || document.documentElement;
    var hx = v.scrollWidth > v.clientWidth + 2 ? v : de, hy = v.scrollHeight > v.clientHeight + 2 ? v : de;
    return { hx: hx, hy: hy, left: hx.scrollLeft, top: hy.scrollTop };
  }
  api.scrollState = scrollState;
  // called right after a page canvas was swapped in (and for images after resizing): drop the preview transform, keep content under the fingers
  api.afterRender = function () {
    clearTimeout(safety); var p = pinch; pinch = null; clearTransforms();
    if (p && p.pending) {
      var r = contentEl().getBoundingClientRect(), st = scrollState();
      var t = scrollForFocal({ nx: p.nx, ny: p.ny, newRect: r, fx: p.fx, fy: p.fy, scrollLeft: st.left, scrollTop: st.top });
      st.hx.scrollLeft = t.left; st.hy.scrollTop = t.top;
    }
    redrawOverlays();
  };
  function setZoomAt(z, fx, fy) { if (!beginPinch(fx, fy)) return; pinch.s = clampZoom(z, maxZoom()) / pinch.startZoom; endPinch(); }

  var badge, badgeT;
  function showZoomBadge(t) {
    if (!badge) { badge = document.createElement('div'); badge.setAttribute('aria-live', 'polite'); badge.style.cssText = 'position:fixed;left:50%;bottom:72px;transform:translateX(-50%);z-index:800;background:rgba(15,23,42,.85);color:#fff;padding:6px 14px;border-radius:16px;font:600 .9rem system-ui;pointer-events:none;transition:opacity .2s'; document.body.appendChild(badge); }
    badge.textContent = t; badge.style.opacity = '1'; clearTimeout(badgeT); badgeT = setTimeout(function () { badge.style.opacity = '0'; }, 900);
  }

  // ---- stylus protection -----------------------------------------------------------------------------------------
  function drawTool() { return typeof tool !== 'undefined' && (tool === 'pen' || tool === 'hl' || tool === 'note'); }
  function isStylusTouch(e) { for (var i = 0; i < e.changedTouches.length; i++) if (e.changedTouches[i].touchType === 'stylus') return true; return false; }
  function blockStylusScroll(e) { if ((drawTool() || strokeActive) && (isStylusTouch(e) || strokeActive)) { if (e.cancelable) e.preventDefault(); } }
  document.addEventListener('touchstart', blockStylusScroll, { passive: false, capture: true });
  document.addEventListener('touchmove', blockStylusScroll, { passive: false, capture: true });

  // ---- pointer events on the drawing layer (called from the page's asvg handlers) ---------------------------------------
  function pt(e) { return { x: e.clientX, y: e.clientY }; }
  api.onPointerDown = function (e) {   // true = consumed (do not draw)
    if (e.pointerType === 'pen') { if (!penSeen) { penSeen = true; try { localStorage.setItem('coop-pen-only', '1'); } catch (_) {} } strokeActive = drawTool(); return false; }
    if (e.pointerType !== 'touch') return false;
    ptrs.set(e.pointerId, pt(e));
    if (ptrs.size >= 2) { if (typeof drawing !== 'undefined') drawing = null; strokeActive = false; var a = Array.from(ptrs.values()), m = mid(a[0], a[1]); if (beginPinch(m.x, m.y)) pinch.d0 = dist(a[0], a[1]); try { asvg.setPointerCapture(e.pointerId); } catch (_) {} return true; }
    if (penSeen) { panLast = pt(e); try { asvg.setPointerCapture(e.pointerId); } catch (_) {} return true; }   // pen known: a finger only scrolls
    return false;
  };
  api.onPointerMove = function (e) {
    if (e.pointerType !== 'touch' || !ptrs.has(e.pointerId)) return false;
    ptrs.set(e.pointerId, pt(e));
    if (pinch && ptrs.size >= 2) { var a = Array.from(ptrs.values()), m = mid(a[0], a[1]); updatePinch(scaleFromDistances(pinch.d0, dist(a[0], a[1])), m.x, m.y); return true; }
    if (penSeen && panLast) { var st = scrollState(); st.hx.scrollLeft -= e.clientX - panLast.x; st.hy.scrollTop -= e.clientY - panLast.y; panLast = pt(e); return true; }
    return false;
  };
  api.onPointerUp = function (e) {
    if (e.pointerType === 'pen') { strokeActive = false; return false; }
    if (e.pointerType !== 'touch') return false;
    var had = ptrs.has(e.pointerId); ptrs.delete(e.pointerId);
    if (pinch && ptrs.size < 2) endPinch();
    if (ptrs.size === 0) panLast = null;
    return had && (penSeen || !!pinch);
  };
  api.coalesced = function (e) { var l = e.getCoalescedEvents ? e.getCoalescedEvents() : null; return l && l.length ? l : [e]; };
  api.penSeen = function () { return penSeen; };
  api.setPenOnly = function (v) { penSeen = !!v; try { localStorage.setItem('coop-pen-only', v ? '1' : '0'); } catch (_) {} };

  // ---- touch (no drawing tool): pinch + double tap ----------------------------------------------------------------------
  function tpt(t) { return { x: t.clientX, y: t.clientY }; }
  function initTouch() {
    var c = viewerContainer, d0 = 0, startT = 0;
    c.addEventListener('touchstart', function (e) {
      if (e.touches.length === 1) startT = e.timeStamp;
      if (e.touches.length === 2 && zoomable()) { var a = tpt(e.touches[0]), b = tpt(e.touches[1]), m = mid(a, b); if (beginPinch(m.x, m.y)) { d0 = dist(a, b); e.preventDefault(); } }
    }, { passive: false });
    c.addEventListener('touchmove', function (e) {
      if (pinch && e.touches.length >= 2) { var a = tpt(e.touches[0]), b = tpt(e.touches[1]), m = mid(a, b); e.preventDefault(); updatePinch(scaleFromDistances(d0, dist(a, b)), m.x, m.y); }
    }, { passive: false });
    var done = function (e) {
      if (pinch && e.touches.length < 2) endPinch();
      else if (e.type === 'touchend' && e.changedTouches.length === 1 && e.touches.length === 0 && zoomable() && !drawTool()) {   // double tap
        var t = e.changedTouches[0], now = e.timeStamp;   // event times, not handling times: a busy main thread must not break double taps
        if (startT - lastTap.t < 320 && startT >= lastTap.t && Math.hypot(t.clientX - lastTap.x, t.clientY - lastTap.y) < 28 && !(e.target.closest && e.target.closest('input,textarea,button,select,a,.cm-pin,.cm-cluster,#cm-pop'))) {
          lastTap.t = 0; var fit = state.fileType === 'pdf' && window.__fitZoom ? window.__fitZoom() : 1; setZoomAt(doubleTapTarget(currentZoom, fit, maxZoom()), t.clientX, t.clientY);
        } else lastTap = { t: now, x: t.clientX, y: t.clientY };
      }
    };
    c.addEventListener('touchend', done, { passive: true }); c.addEventListener('touchcancel', done, { passive: true });

    // trackpad pinch / ctrl+wheel (Chrome, Edge, Firefox)
    c.addEventListener('wheel', function (e) {
      if (!(e.ctrlKey || e.metaKey) || !zoomable()) return; e.preventDefault();
      if (!pinch) beginPinch(e.clientX, e.clientY); if (!pinch) return;
      updatePinch(pinch.s * wheelFactor(e.deltaY, e.deltaMode), e.clientX, e.clientY);
      clearTimeout(wheelTimer); wheelTimer = setTimeout(endPinch, 180);
    }, { passive: false });
    // Safari trackpad pinch
    var base = 1;
    c.addEventListener('gesturestart', function (e) { if (!zoomable()) return; e.preventDefault(); if (beginPinch(e.clientX, e.clientY)) base = 1; });
    c.addEventListener('gesturechange', function (e) { if (!pinch) return; e.preventDefault(); updatePinch(e.scale, e.clientX, e.clientY); });
    c.addEventListener('gestureend', function (e) { if (pinch) { e.preventDefault(); endPinch(); } });
  }
  function init() {
    initTouch();
    // fingers scroll natively on documents the app cannot zoom itself; allow browser pinch there
    setInterval(function () { var z = typeof state !== 'undefined' && (state.fileType === 'pdf' || state.fileType === 'image'); viewerContainer.style.touchAction = z ? 'pan-x pan-y' : 'pan-x pan-y pinch-zoom'; }, 1000);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
})(typeof self !== 'undefined' ? self : globalThis);
