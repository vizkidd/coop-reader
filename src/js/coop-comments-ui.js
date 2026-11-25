/* Coop Reader comments UI (loaded after the main script; uses its globals: annots, state, applyAnnot, broadcast, profiles, ...).
 *  - anchored comments: click a spot (point) or select text (text comment); no page-wide comments
 *  - pins keep a constant on-screen size while their POSITION follows page zoom / scroll
 *  - dense pages: nearby pins merge into a numbered cluster, a click lists the threads inside
 *  - click a pin / highlighted text to open its thread: avatar, name, time, replies, resolve, delete
 */
(function (root) {
  'use strict';
  var K = root.CoopComments, $ = function (id) { return document.getElementById(id); };
  var openedAt = 0, layer, pop, selBtn, openId = null, openCluster = null, composer = null, sig = '', selInfo = null, tlToken = 0;
  var esc = function (s) { return escapeHtml(String(s == null ? '' : s)); };
  var me = function () { return (myPeerId || '').replace(/[^\w-]/g, ''); };
  var isOwner = function (x) { return !lastJoinCode || isHost || x.by === me(); };

  var CSS = '.cm-pop[hidden],#cm-selbtn[hidden]{display:none!important}#cm-layer{position:absolute;inset:0;pointer-events:none;z-index:6}'
    + '.cm-pin,.cm-cluster{position:absolute;transform:translate(-50%,-50%);pointer-events:auto;border-radius:50%;border:2px solid #fff;color:#1b1400;font:700 12px/1 system-ui,sans-serif;box-shadow:0 2px 8px rgba(0,0,0,.45);cursor:pointer;padding:0;display:flex;align-items:center;justify-content:center;min-height:0}'
    + '.cm-pin{width:26px;height:26px;background:#ffd933}.cm-pin.rs{background:#cbd5e1;color:#475569}.cm-pin.open{outline:3px solid var(--primary,#2563eb)}'
    + '.cm-cluster{width:34px;height:34px;background:#ff9f1a;color:#fff;font-size:14px}.cm-cluster:after{content:"";position:absolute;inset:-5px;border-radius:50%;border:2px dashed rgba(255,159,26,.7)}'
    + '.cm-q{position:absolute;pointer-events:none;mix-blend-mode:multiply;border-radius:2px}'
    + '.cm-pop{position:fixed;z-index:700;width:300px;max-width:calc(100vw - 16px);max-height:min(70vh,420px);overflow:auto;background:var(--surface,#fff);color:var(--text,#111827);border:1px solid var(--border,#d1d5db);border-radius:12px;box-shadow:0 10px 34px rgba(0,0,0,.4);padding:10px;display:flex;flex-direction:column;gap:8px;font-size:.9rem}'
    + '.cm-pop .cm-quote{margin:0;padding:4px 8px;border-left:3px solid #f59e0b;background:rgba(245,158,11,.12);font-style:italic;font-size:.82rem;max-height:4.2em;overflow:hidden}'
    + '.cm-msg{display:flex;gap:8px;align-items:flex-start}.cm-msg .cm-body{min-width:0;flex:1}.cm-msg .cm-meta{font-size:.76rem;opacity:.7}.cm-msg .cm-text{white-space:pre-wrap;word-break:break-word}'
    + '.cm-av{width:28px;height:28px;border-radius:50%;flex:none;object-fit:cover;display:flex;align-items:center;justify-content:center;color:#fff;font-weight:700;font-size:.8rem}'
    + '.cm-act{display:flex;gap:6px;justify-content:flex-end;flex-wrap:wrap}.cm-act button{min-height:32px;padding:4px 10px;font-size:.8rem}'
    + '.cm-pop textarea{width:100%;box-sizing:border-box;resize:vertical;min-height:56px}.cm-item{display:flex;gap:8px;align-items:center;width:100%;text-align:left;min-height:44px;padding:6px 8px}'
    + '#cm-selbtn{position:fixed;z-index:650;display:none;min-height:36px;padding:6px 12px;border-radius:18px;background:var(--primary,#2563eb);color:#fff;border:0;box-shadow:0 4px 14px rgba(0,0,0,.4);font-weight:600;cursor:pointer}'
    + '#pdf-text-layer{position:absolute;overflow:hidden;line-height:1;text-align:initial;z-index:2;text-size-adjust:none;-webkit-text-size-adjust:none;forced-color-adjust:none}'
    + '#pdf-text-layer span,#pdf-text-layer br{color:transparent;position:absolute;white-space:pre;cursor:text;transform-origin:0 0}#pdf-text-layer ::selection{background:rgba(37,99,235,.35)}';

  function init() {
    var st = document.createElement('style'); st.textContent = CSS; document.head.appendChild(st);
    layer = document.createElement('div'); layer.id = 'cm-layer'; layer.setAttribute('aria-label', 'Comments'); $('viewer-wrap').appendChild(layer);
    pop = document.createElement('div'); pop.className = 'cm-pop'; pop.id = 'cm-pop'; pop.setAttribute('role', 'dialog'); pop.hidden = true; document.body.appendChild(pop);
    selBtn = document.createElement('button'); selBtn.id = 'cm-selbtn'; selBtn.type = 'button'; selBtn.textContent = '💬 Comment on selection'; document.body.appendChild(selBtn);
    ['pointerdown', 'mousedown', 'touchstart'].forEach(function (t) { selBtn.addEventListener(t, function (e) { e.preventDefault(); }); });   // pressing the button must not clear the text selection
    selBtn.addEventListener('click', function () { if (selInfo) beginText(selInfo); });
    layer.addEventListener('click', onLayerClick);
    pop.addEventListener('click', onPopClick);
    pop.addEventListener('keydown', function (e) { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { var b = pop.querySelector('[data-a="send"]'); if (b) b.click(); } if (e.key === 'Escape') closeAll(); e.stopPropagation(); });
    document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && !pop.hidden) closeAll(); });
    document.addEventListener('pointerdown', function (e) { if (performance.now() - openedAt < 250) return; if (!pop.hidden && !(e.target.closest && e.target.closest('#cm-pop,.cm-pin,.cm-cluster,#cm-selbtn'))) closeAll(); });
    $('viewer-wrap').addEventListener('click', onWrapClick);
    document.addEventListener('selectionchange', debounce(onSelection, 160));
    setInterval(redraw, 120);
  }
  function debounce(fn, ms) { var t; return function () { clearTimeout(t); t = setTimeout(fn, ms); }; }

  // ---- who ---------------------------------------------------------------------------------------------
  function author(by, fallbackName) {
    var p = by === me() ? myProfile() : (profiles[by] || annotAuthors[by] || {});
    return { name: p.name || fallbackName || 'Someone', avatar: AVATAR_RE.test(p.avatar || '') ? p.avatar : '' };
  }
  function face(by, name) {
    var a = author(by, name);
    if (a.avatar) return '<img class="cm-av" alt="" src="' + a.avatar + '">';
    var h = 0; String(by || name).split('').forEach(function (c) { h = (h * 31 + c.charCodeAt(0)) % 360; });
    return '<span class="cm-av" style="background:hsl(' + h + ',55%,42%)" aria-hidden="true">' + esc((a.name[0] || '?').toUpperCase()) + '</span>';
  }
  function when(ts) { try { return ts ? new Date(ts).toLocaleString([], { dateStyle: 'short', timeStyle: 'short' }) : ''; } catch (_) { return ''; } }

  // ---- geometry ----------------------------------------------------------------------------------------
  function box() { var el = contentEl(); if (!el) return null; var r = el.getBoundingClientRect(); return r.width && r.height ? { left: r.left, top: r.top, width: r.width, height: r.height } : null; }
  function pageList() { return (annots[state.currentPage] || []).filter(function (a) { return a.t === 'cm'; }); }
  function numbering() { var m = {}; K.flatten(annots).forEach(function (e) { m[e.item.id] = e.n; }); return m; }
  function screenOf(it, b) { return K.project(b, it.x, it.y); }

  // ---- drawing -----------------------------------------------------------------------------------------
  function redraw(force) {
    if (!layer) return;
    var tl = $('pdf-text-layer'); if (tl) tl.style.display = state.fileType === 'pdf' ? 'block' : 'none';
    var b = state.fileType && cachedFileBytes ? box() : null, list = b && !document.hidden ? pageList() : [];
    if (!b || !list.length) { if (layer.firstChild) layer.innerHTML = ''; sig = ''; if (!pop.hidden) { if (composer && b) placePop(b); else if (!composer) closeAll(); } return; }   // a composer on an empty page still has to be placed
    var w = $('viewer-wrap').getBoundingClientRect(), c = viewerContainer.getBoundingClientRect();
    var s = [b.left | 0, b.top | 0, b.width | 0, b.height | 0, state.currentPage, openId, list.map(function (x) { return x.id + x.th.length + x.rs; }).join(), openCluster ? openCluster.length : 0, w.left | 0, w.top | 0].join('|');
    if (!force && s === sig) { placePop(b); return; }
    sig = s;
    layer.style.clipPath = 'inset(' + (c.top - w.top) + 'px ' + (w.right - c.right) + 'px ' + (w.bottom - c.bottom) + 'px ' + (c.left - w.left) + 'px)';
    var num = numbering(), html = [];
    list.forEach(function (it) {
      if (it.k !== 'tx') return;
      it.q.forEach(function (q) { html.push('<div class="cm-q" style="left:' + (b.left - w.left + q[0] * b.width).toFixed(1) + 'px;top:' + (b.top - w.top + q[1] * b.height).toFixed(1) + 'px;width:' + (q[2] * b.width).toFixed(1) + 'px;height:' + (q[3] * b.height).toFixed(1) + 'px;background:' + it.c + ';opacity:' + (it.rs ? .18 : .38) + '"></div>'); });
    });
    K.layout(list, { left: b.left - w.left, top: b.top - w.top, width: b.width, height: b.height }).forEach(function (p) {
      var pos = 'left:' + p.sx.toFixed(1) + 'px;top:' + p.sy.toFixed(1) + 'px';
      if (p.kind === 'cluster') html.push('<button type="button" class="cm-cluster" data-ids="' + p.items.map(function (i) { return i.id; }).join(',') + '" style="' + pos + '" aria-label="' + p.n + ' comments here">' + p.n + '</button>');
      else { var it = p.item; html.push('<button type="button" class="cm-pin' + (it.rs ? ' rs' : '') + (openId === it.id ? ' open' : '') + '" data-id="' + esc(it.id) + '" style="' + pos + '" aria-label="Comment ' + num[it.id] + ' by ' + esc(it.name) + '">' + (it.rs ? '✓' : num[it.id]) + '</button>'); }
    });
    layer.innerHTML = html.join('');
    placePop(b);
  }

  // ---- popover -----------------------------------------------------------------------------------------
  function anchorScreen(b) {
    if (composer) return composer.sx != null ? { sx: composer.sx, sy: composer.sy } : null;
    if (openId) { var it = K.find(pageList(), openId); return it ? screenOf(it, b) : null; }
    if (openCluster) { var its = pageList().filter(function (x) { return openCluster.indexOf(x.id) >= 0; }); if (!its.length) return null; var ps = its.map(function (x) { return screenOf(x, b); }); return { sx: ps.reduce(function (a, p) { return a + p.sx; }, 0) / ps.length, sy: ps.reduce(function (a, p) { return a + p.sy; }, 0) / ps.length }; }
    return null;
  }
  function placePop(b) {
    if (pop.hidden) return;
    var a = b && anchorScreen(b); if (!a) { if (!composer) closeAll(); return; }
    var size = { w: Math.min(300, innerWidth - 16), h: Math.min(pop.offsetHeight || 200, 420) }, pos = K.popoverPos(a, size, { width: innerWidth, height: innerHeight });
    pop.style.left = pos.x + 'px'; pop.style.top = pos.y + 'px';
  }
  function msgHtml(m, root, first) {
    var del = isOwner(m) || (first && isOwner(root));
    return '<div class="cm-msg">' + face(m.by, m.name) + '<div class="cm-body"><div class="cm-meta"><b>' + esc(author(m.by, m.name).name) + '</b> · ' + esc(when(m.ts)) + '</div><div class="cm-text">' + esc(m.text) + '</div>'
      + (del ? '<div class="cm-act"><button class="secondary" data-a="del" data-mid="' + esc(m.id) + '">' + (first ? 'Delete thread' : 'Delete') + '</button></div>' : '') + '</div></div>';
  }
  function render() {
    var keep = pop.querySelector('textarea'), kept = keep ? keep.value : '';
    if (composer) {
      pop.innerHTML = (composer.quote ? '<p class="cm-quote">“' + esc(composer.quote) + '”</p>' : '<div class="cm-meta">Comment on this spot</div>')
        + '<textarea id="cm-ta" rows="3" maxlength="' + K.LIM.text + '" placeholder="Write a comment…" aria-label="Comment"></textarea><div class="cm-act"><button class="secondary" data-a="cancel">Cancel</button><button data-a="send">Comment</button></div>';
      var ta = pop.querySelector('textarea'); ta.value = kept; if (!keep) setTimeout(function () { ta.focus(); }, 20);
    } else if (openCluster) {
      var items = pageList().filter(function (x) { return openCluster.indexOf(x.id) >= 0; }), num = numbering();
      pop.innerHTML = '<div class="cm-meta"><b>' + items.length + ' comments here</b> — zoom in to separate them, or pick one</div>' + items.map(function (it) {
        return '<button class="secondary cm-item" data-a="open" data-id="' + esc(it.id) + '">' + face(it.by, it.name) + '<span style="min-width:0"><b>#' + num[it.id] + ' ' + esc(author(it.by, it.name).name) + '</b><br><small>' + esc((it.quote || it.th[0].text).slice(0, 60)) + '</small></span></button>'; }).join('');
    } else if (openId) {
      var it2 = K.find(pageList(), openId); if (!it2) { closeAll(); return; }
      pop.innerHTML = (it2.quote ? '<p class="cm-quote">“' + esc(it2.quote) + '”</p>' : '') + it2.th.map(function (m, i) { return msgHtml(m, it2, i === 0); }).join('')
        + (canAnnotate() ? '<textarea id="cm-ta" rows="2" maxlength="' + K.LIM.text + '" placeholder="Reply…" aria-label="Reply"></textarea><div class="cm-act">' + ((isOwner(it2) || it2.by === me()) ? '<button class="secondary" data-a="resolve">' + (it2.rs ? 'Reopen' : 'Resolve') + '</button>' : '') + '<button data-a="send">Reply</button></div>' : '<div class="cm-meta">Commenting is turned off by the host.</div>');
      var ta2 = pop.querySelector('textarea'); if (ta2) ta2.value = kept;
    }
    pop.hidden = false; openedAt = performance.now(); sig = ''; redraw(true);   // openedAt: the same pointerdown that opened the popover must not close it
  }
  function closeAll() { openId = null; openCluster = null; composer = null; pop.hidden = true; pop.innerHTML = ''; sig = ''; redraw(true); }
  function openThread(id) { openId = id; openCluster = null; composer = null; render(); markRead([id]); }

  function send(op, page, item, id) { applyAnnot(op, page, item, id); broadcast({ type: 'ANNOT', op: op, page: page, item: item, id: id }); sendActivity('interact'); }
  function onPopClick(e) {
    var btn = e.target.closest('[data-a]'); if (!btn) return;
    var a = btn.dataset.a, ta = pop.querySelector('textarea'), text = ta ? ta.value.trim() : '';
    if (a === 'cancel') return closeAll();
    if (a === 'open') return openThread(btn.dataset.id);
    if (a === 'send') {
      if (!text) { if (ta) ta.focus(); return; }
      if (!canAnnotate()) return notify('Commenting is turned off by the host.', 'warning', 2500);
      if (composer) {
        var id = 'c' + K.uid(), item = K.newItem({ id: id, k: composer.k, x: composer.x, y: composer.y, q: composer.q, quote: composer.quote, c: annotColor(), by: me(), name: myDisplayName, text: text, ts: Date.now() });
        if (!item) return; composer = null; send('add', state.currentPage, item); try { getSelection().removeAllRanges(); } catch (_) {} openThread(id);
      } else if (openId) {
        send('reply', state.currentPage, { id: 'r' + K.uid(), by: me(), name: myDisplayName, text: text, ts: Date.now() }, openId); ta.value = ''; render();
      }
    } else if (a === 'resolve' && openId) { var it = K.find(pageList(), openId); if (it) { send('resolve', state.currentPage, it.rs ? 0 : 1, openId); render(); } }
    else if (a === 'del' && openId) {
      var root = K.find(pageList(), openId), mid = btn.dataset.mid; if (!root) return;
      if (root.th[0].id === mid && root.th.length > 1 && !confirm('Delete this comment and all ' + (root.th.length - 1) + ' replies?')) return;
      send('rdel', state.currentPage, mid, openId); if (root.th[0].id === mid) closeAll(); else render();
    }
  }
  function onLayerClick(e) {
    var pin = e.target.closest('.cm-pin'), cl = e.target.closest('.cm-cluster');
    if (pin) { if (openId === pin.dataset.id) return closeAll(); return openThread(pin.dataset.id); }
    if (cl) { openCluster = cl.dataset.ids.split(','); openId = null; composer = null; render(); }
  }
  function onWrapClick(e) {   // click on highlighted text opens its thread
    if (tool && tool !== 'erase') return; var s = getSelection(); if (s && !s.isCollapsed) return;
    var b = box(); if (!b) return;
    var hit = pageList().find(function (it) { return K.hitQuad(it, b, e.clientX, e.clientY); });
    if (hit && !e.target.closest('.cm-pin,.cm-cluster')) openThread(hit.id);
  }

  // ---- creating ----------------------------------------------------------------------------------------
  function beginPoint(p, cx, cy) {
    if (!canAnnotate()) return notify('Commenting is turned off by the host.', 'warning', 2500);
    openId = null; openCluster = null; composer = { k: 'pt', x: p[0], y: p[1], q: [], quote: '', sx: cx, sy: cy }; render();
  }
  function beginText(info) {
    if (!canAnnotate()) return notify('Commenting is turned off by the host.', 'warning', 2500);
    var b = box(); if (!b) return;
    openId = null; openCluster = null; composer = { k: 'tx', x: info.q[0][0], y: info.q[0][1], q: info.q, quote: info.quote, sx: info.sx, sy: info.sy }; selBtn.style.display = 'none'; render();
  }
  function onSelection() {
    var s = getSelection(), b = box();
    selInfo = null; selBtn.style.display = 'none';
    if (!s || s.isCollapsed || !s.rangeCount || !b || !canAnnotate() || !state.fileType || state.fileType === 'image') return;
    var r = s.getRangeAt(0), n = r.commonAncestorContainer; n = n.nodeType === 3 ? n.parentNode : n;
    if (!viewerContainer.contains(n) || (n.closest && n.closest('textarea,input,#cm-pop'))) return;
    var quote = s.toString().replace(/\s+/g, ' ').trim(); if (!quote) return;
    var rects = Array.prototype.slice.call(r.getClientRects()), q = K.quadsFromRects(rects, b);
    if (!q.length) return;
    var last = rects[rects.length - 1], first = rects[0];
    selInfo = { q: q, quote: quote.slice(0, K.LIM.quote), sx: last.right, sy: last.bottom };
    var y = first.top - 44; if (y < 8) y = last.bottom + 10;
    selBtn.style.left = Math.max(8, Math.min(first.left, innerWidth - 200)) + 'px'; selBtn.style.top = Math.min(y, innerHeight - 50) + 'px'; selBtn.style.display = 'block';
  }

  // ---- read state (unread badge) ---------------------------------------------------------------------------------
  function readKey() { return 'coop-cm-read:' + docKey(); }
  function readMap() { try { return JSON.parse(localStorage.getItem(readKey()) || '{}') || {}; } catch (_) { return {}; } }
  function markRead(ids) { var m = readMap(), all = K.flatten(annots); all.forEach(function (e) { if (!ids || ids.indexOf(e.item.id) >= 0) m[e.item.id] = e.item.th.length; }); try { localStorage.setItem(readKey(), JSON.stringify(m)); } catch (_) {} updateBadge(); }
  function isUnread(it, m) { var last = it.th[it.th.length - 1]; return it.th.length > (m[it.id] || 0) && last.by !== me(); }
  function unreadCount() { var m = readMap(); return K.flatten(annots).filter(function (e) { return isUnread(e.item, m); }).length; }
  function updateBadge() {
    var b = $('btn-comments'); if (!b) return;
    var n = typeof cachedFileBytes !== 'undefined' && cachedFileBytes ? unreadCount() : 0, total = K.stats(annots).threads;
    b.textContent = '💬 Comments' + (total ? ' (' + total + ')' : '') + (n ? ' • ' + n + ' new' : '');
    b.classList.toggle('has-unread', n > 0);
  }
  setInterval(updateBadge, 1500);

  // ---- list of all comments (filters: all / new / open / mine / this page) -------------------------------------------
  var listFilter = 'all';
  function listItems() {
    var m = readMap(), all = K.flatten(annots);
    return all.filter(function (e) {
      var it = e.item;
      return listFilter === 'all' ? true : listFilter === 'new' ? isUnread(it, m) : listFilter === 'open' ? !it.rs : listFilter === 'mine' ? (it.by === me() || it.th.some(function (x) { return x.by === me(); })) : e.page === state.currentPage;
    });
  }
  function openList() {
    var o = document.createElement('div');
    o.style.cssText = 'position:fixed;inset:0;z-index:999;background:rgba(0,0,0,.55);display:flex;align-items:center;justify-content:center;padding:12px';
    document.body.appendChild(o);
    var draw = function () {
      var items = listItems(), m = readMap(), total = K.flatten(annots).length;
      var chips = [['all', 'All'], ['new', 'New'], ['open', 'Open'], ['mine', 'Mine'], ['page', 'This page']].map(function (c) { return '<button class="' + (listFilter === c[0] ? '' : 'secondary ') + 'cm-chip" data-f="' + c[0] + '" style="min-height:34px;padding:4px 12px;font-size:.82rem">' + c[1] + '</button>'; }).join('');
      o.innerHTML = '<div role="dialog" aria-modal="true" aria-label="Comments" style="background:var(--surface);color:inherit;padding:16px;border-radius:14px;max-width:480px;width:100%;max-height:85vh;overflow:auto"><h3 style="margin:0 0 8px">Comments (' + total + ')</h3>'
        + '<div style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:10px" role="group" aria-label="Filter">' + chips + '</div>'
        + (items.length ? items.map(function (e) { var un = isUnread(e.item, m); return '<button class="secondary cm-item" data-pg="' + e.page + '" data-id="' + esc(e.item.id) + '">' + face(e.item.by, e.item.name) + '<span style="min-width:0"><b>#' + e.n + ' · p.' + e.page + ' · ' + esc(author(e.item.by, e.item.name).name) + (e.item.rs ? ' ✓' : '') + (un ? ' <span style="color:#dc2626">● new</span>' : '') + '</b>' + (e.item.th.length > 1 ? ' <small>(' + e.item.th.length + ' messages)</small>' : '') + '<br><small>' + esc((e.item.quote ? '“' + e.item.quote + '” ' : '') + e.item.th[e.item.th.length - 1].text).slice(0, 110) + '</small></span></button>'; }).join('')
          : '<p style="opacity:.7;margin:0 0 8px">' + (total ? 'Nothing matches this filter.' : 'No comments yet. Click a spot with the 💬 tool, or select some text and press “Comment on selection”.') + '</p>')
        + '<div style="display:flex;justify-content:space-between;margin-top:8px"><button class="secondary" id="cm-allread">Mark all read</button><button class="secondary" id="cm-x">Close</button></div></div>';
    };
    draw();
    o.onclick = function (e) {
      var f = e.target.closest('[data-f]'), b = e.target.closest('[data-pg]');
      if (f) { listFilter = f.dataset.f; draw(); }
      else if (b) { o.remove(); var pg = +b.dataset.pg, id = b.dataset.id; if (pg !== state.currentPage) goToPage(pg); setTimeout(function () { openThread(id); }, 350); }
      else if (e.target.id === 'cm-allread') { markRead(); draw(); }
      else if (e.target === o || e.target.id === 'cm-x') o.remove();
    };
  }

  // ---- PDF text layer (makes text selectable for text comments) ----------------------------------------------
  async function renderPdfText(page, cssW, cssH) {
    var canvas = $('pdf-canvas'), tl = $('pdf-text-layer'), my = ++tlToken;
    if (!tl) { tl = document.createElement('div'); tl.id = 'pdf-text-layer'; tl.className = 'textLayer'; canvas.parentNode.insertBefore(tl, $('pdf-form-layer')); }
    tl.innerHTML = ''; tl.style.left = canvas.offsetLeft + 'px'; tl.style.top = canvas.offsetTop + 'px'; tl.style.width = Math.floor(cssW) + 'px'; tl.style.height = Math.floor(cssH) + 'px';
    try {
      var base = page.getViewport({ scale: 1 }), vp = page.getViewport({ scale: cssW / base.width });
      tl.style.setProperty('--scale-factor', String(vp.scale));
      var tc = await page.getTextContent(); if (my !== tlToken) return;
      await pdfjsLib.renderTextLayer({ textContentSource: tc, container: tl, viewport: vp, textDivs: [] }).promise;
    } catch (e) { if (my === tlToken) console.warn('text layer failed', e); }
  }

  function onChanged() { sig = ''; if (!pop.hidden && !composer) render(); else redraw(true); }
  root.CoopCommentsUI = { unreadCount: unreadCount, markRead: markRead, beginPoint: beginPoint, openList: openList, renderPdfText: renderPdfText, onChanged: onChanged, close: closeAll, openThread: openThread };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
})(typeof self !== 'undefined' ? self : globalThis);
