/* Coop Reader comments v2: anchored comment threads (point or selected text), dense-comment clustering,
 * zoom-aware placement with constant on-screen size. Pure logic: no DOM, so it is unit tested in Node.
 *
 * Item shape (stored per page in `annots[page]`, synced as ANNOT ops):
 *   { id, t:'cm', k:'pt'|'tx', x, y,            anchor in page coordinates 0..1 (for text: top-left of the first quad)
 *     q:[[x,y,w,h],...], quote,                 selected text rectangles (page coordinates) and the text itself
 *     c, by, name, ts, rs,                      colour, author peer id, author name, created, resolved flag
 *     th:[{id,by,name,text,ts}, ...] }          th[0] is the first message, the rest are replies
 * Legacy {t:'note', x, y, text} items are converted on load.
 */
(function (root) {
  'use strict';
  var LIM = { text: 500, thread: 100, quads: 24, quote: 240, name: 24, id: 60 };
  var clamp01 = function (v) { v = +v; return isFinite(v) ? Math.max(-0.05, Math.min(1.05, v)) : 0; };
  var cleanId = function (s) { return String(s == null ? '' : s).replace(/[^\w-]/g, '').slice(0, LIM.id); };
  var cleanTxt = function (s, n) { return String(s == null ? '' : s).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').slice(0, n); };
  var HEX = /^#[0-9a-f]{6}$/i;

  function cleanMsg(m) {
    if (!m || typeof m !== 'object') return null;
    var text = cleanTxt(m.text, LIM.text).trim(), id = cleanId(m.id);
    if (!text || !id) return null;
    return { id: id, by: cleanId(m.by), name: cleanTxt(m.name, LIM.name), text: text, ts: Math.max(0, Math.floor(+m.ts || 0)) };
  }

  // sanitise anything that arrives from the network or storage; returns null for junk
  function normalizeItem(raw) {
    if (!raw || typeof raw !== 'object') return null;
    if (raw.t === 'note') {   // legacy comment -> thread of one message
      var id0 = cleanId(raw.id); if (!id0) return null;
      var m0 = cleanMsg({ id: id0 + '-m0', by: raw.by, name: raw.name, text: raw.text, ts: raw.ts });
      if (!m0) return null;
      return { id: id0, t: 'cm', k: 'pt', x: clamp01(raw.x), y: clamp01(raw.y), q: [], quote: '', c: HEX.test(raw.c) ? raw.c : '#f59e0b',
        by: cleanId(raw.by), name: cleanTxt(raw.name, LIM.name), ts: m0.ts, rs: 0, th: [m0] };
    }
    if (raw.t !== 'cm') return null;
    var id = cleanId(raw.id); if (!id) return null;
    var th = (Array.isArray(raw.th) ? raw.th : []).slice(0, LIM.thread).map(cleanMsg).filter(Boolean);
    if (!th.length) return null;
    var k = raw.k === 'tx' ? 'tx' : 'pt', q = [];
    if (k === 'tx') {
      q = (Array.isArray(raw.q) ? raw.q : []).slice(0, LIM.quads).map(function (r) {
        return Array.isArray(r) ? [clamp01(r[0]), clamp01(r[1]), Math.abs(clamp01(r[2])), Math.abs(clamp01(r[3]))] : null;
      }).filter(function (r) { return r && r[2] > 0 && r[3] > 0; });
      if (!q.length) k = 'pt';
    }
    var it = { id: id, t: 'cm', k: k, x: clamp01(raw.x), y: clamp01(raw.y), q: q, quote: k === 'tx' ? cleanTxt(raw.quote, LIM.quote) : '',
      c: HEX.test(raw.c) ? raw.c : '#f59e0b', by: cleanId(raw.by), name: cleanTxt(raw.name, LIM.name), ts: th[0].ts, rs: raw.rs ? 1 : 0, th: th };
    if (k === 'tx') { it.x = q[0][0]; it.y = q[0][1]; }
    return it;
  }

  function newItem(o) {   // o: {id,k,x,y,q,quote,c,by,name,text,ts}
    return normalizeItem({ id: o.id, t: 'cm', k: o.k, x: o.x, y: o.y, q: o.q, quote: o.quote, c: o.c, by: o.by, name: o.name,
      ts: o.ts, rs: 0, th: [{ id: o.id + '-m0', by: o.by, name: o.name, text: o.text, ts: o.ts }] });
  }

  // The host decides who wrote a comment: author, name and time are overwritten with what the host knows about the sender.
  function stamp(item, by, name, ts) {
    var it = normalizeItem(item); if (!it) return null;
    it.th = it.th.slice(0, 1); it.rs = 0;
    it.by = cleanId(by); it.name = cleanTxt(name, LIM.name); it.ts = ts;
    it.th[0].by = it.by; it.th[0].name = it.name; it.th[0].ts = ts;
    return it;
  }
  function stampMsg(msg, by, name, ts) { return cleanMsg({ id: msg && msg.id, by: by, name: name, text: msg && msg.text, ts: ts }); }
  function uid() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 10); }

  function find(list, id) { for (var i = 0; list && i < list.length; i++) if (list[i].id === id) return list[i]; return null; }

  // Structural operations. Permission checks are the caller's job (host validates `by`).
  function reply(list, id, msg) {
    var it = find(list, id); if (!it || it.t !== 'cm') return false;
    var m = cleanMsg(msg); if (!m || it.th.length >= LIM.thread) return false;
    if (it.th.some(function (x) { return x.id === m.id; })) return false;   // duplicate delivery
    it.th.push(m); return true;
  }
  function removeMsg(list, id, mid) {   // removing the first message removes the whole thread (returns 'thread')
    var it = find(list, id); if (!it || it.t !== 'cm') return false;
    var i = it.th.findIndex(function (x) { return x.id === mid; }); if (i < 0) return false;
    if (i === 0) { list.splice(list.indexOf(it), 1); return 'thread'; }
    it.th.splice(i, 1); return 'msg';
  }
  function resolve(list, id, v) { var it = find(list, id); if (!it || it.t !== 'cm') return false; it.rs = v ? 1 : 0; return true; }

  // ---- text selection -> normalised quads ----------------------------------------------------------
  // rects: [{left,top,width,height}] in client px; box: {left,top,width,height} of the page content in client px
  function quadsFromRects(rects, box) {
    if (!box || !box.width || !box.height) return [];
    var rs = [];
    for (var i = 0; i < rects.length; i++) {
      var r = rects[i]; if (!(r.width > 1 && r.height > 1)) continue;
      rs.push({ l: r.left, t: r.top, r: r.left + r.width, b: r.top + r.height });
    }
    rs.sort(function (a, b) { return a.t - b.t || a.l - b.l; });
    var merged = [];
    rs.forEach(function (r) {   // merge fragments that sit on one line
      var m = merged[merged.length - 1];
      if (m) {
        var h = Math.min(m.b - m.t, r.b - r.t), overlap = Math.min(m.b, r.b) - Math.max(m.t, r.t);
        if (overlap > h * 0.6 && r.l <= m.r + h * 0.6) { m.l = Math.min(m.l, r.l); m.r = Math.max(m.r, r.r); m.t = Math.min(m.t, r.t); m.b = Math.max(m.b, r.b); return; }
      }
      merged.push({ l: r.l, t: r.t, r: r.r, b: r.b });
    });
    return merged.slice(0, LIM.quads).map(function (m) {
      var x = (m.l - box.left) / box.width, y = (m.t - box.top) / box.height;
      return [+x.toFixed(4), +y.toFixed(4), +((m.r - m.l) / box.width).toFixed(4), +((m.b - m.t) / box.height).toFixed(4)];
    });
  }

  // ---- placement ------------------------------------------------------------------------------------
  // View transform: page content box on screen. Pin POSITIONS follow it, pin SIZES do not (constant CSS px).
  var MARK = { r: 13, cluster: 16, popW: 300, popMaxH: 360 };
  function project(box, x, y) { return { sx: box.left + x * box.width, sy: box.top + y * box.height }; }

  // Greedy screen-space clustering so dense pages stay legible. Deterministic: sorted by (y, x).
  function layout(items, box, opts) {
    opts = opts || {}; var radius = opts.radius || MARK.r * 2 + 4, out = [];
    var pins = items.filter(function (i) { return i.t === 'cm'; }).map(function (it) {
      var p = project(box, it.x, it.y); return { it: it, sx: p.sx, sy: p.sy };
    }).sort(function (a, b) { return a.sy - b.sy || a.sx - b.sx || (a.it.id < b.it.id ? -1 : 1); });
    var cl = [];
    pins.forEach(function (p) {
      var c = null;
      for (var i = 0; i < cl.length; i++) { if (Math.hypot(cl[i].sx - p.sx, cl[i].sy - p.sy) < radius) { c = cl[i]; break; } }
      if (c) { c.members.push(p); var n = c.members.length; c.sx += (p.sx - c.sx) / n; c.sy += (p.sy - c.sy) / n; }
      else cl.push({ members: [p], sx: p.sx, sy: p.sy });
    });
    cl.forEach(function (c) {
      var ids = c.members.map(function (m) { return m.it; });
      out.push(c.members.length === 1 ? { kind: 'pin', item: ids[0], items: ids, sx: c.sx, sy: c.sy, n: 1, r: MARK.r }
        : { kind: 'cluster', items: ids, sx: c.sx, sy: c.sy, n: ids.length, r: MARK.cluster });
    });
    return out;
  }

  // Fan a cluster out on a circle (screen px) so every member can be clicked.
  function spread(cluster) {
    var n = cluster.items.length, R = Math.max(34, n * 11), out = [];
    for (var i = 0; i < n; i++) { var a = -Math.PI / 2 + (2 * Math.PI * i) / n; out.push({ item: cluster.items[i], sx: cluster.sx + R * Math.cos(a), sy: cluster.sy + R * Math.sin(a) }); }
    return out;
  }

  // Popover placement: below-right of the anchor, flipped/clamped to stay inside the viewport.
  function popoverPos(anchor, size, vp, gap) {
    gap = gap == null ? 14 : gap;
    var x = anchor.sx + gap, y = anchor.sy + gap;
    if (x + size.w > vp.width - 8) x = anchor.sx - gap - size.w;
    if (y + size.h > vp.height - 8) y = anchor.sy - gap - size.h;
    return { x: Math.max(8, Math.min(x, vp.width - size.w - 8)), y: Math.max(8, Math.min(y, vp.height - size.h - 8)) };
  }

  function hitQuad(item, box, cx, cy) {   // click on highlighted text
    if (item.k !== 'tx') return false;
    return item.q.some(function (r) { var l = box.left + r[0] * box.width, t = box.top + r[1] * box.height; return cx >= l && cx <= l + r[2] * box.width && cy >= t && cy <= t + r[3] * box.height; });
  }

  // ---- lists and export -------------------------------------------------------------------------------
  function flatten(annots) {   // all comment threads in reading order, with a stable running number
    var out = [], n = 0;
    Object.keys(annots).map(Number).sort(function (a, b) { return a - b; }).forEach(function (pg) {
      (annots[pg] || []).filter(function (a) { return a.t === 'cm'; }).sort(function (a, b) { return a.y - b.y || a.x - b.x; })
        .forEach(function (it) { out.push({ n: ++n, page: pg, item: it }); });
    });
    return out;
  }
  function markdown(annots, filename) {
    var lines = ['# Comments — ' + filename, ''];
    flatten(annots).forEach(function (e) {
      var it = e.item; lines.push('## ' + e.n + '. Page ' + e.page + (it.rs ? ' (resolved)' : ''));
      if (it.quote) lines.push('> ' + it.quote.replace(/\n/g, ' '));
      it.th.forEach(function (m, i) { lines.push((i ? '  - ' : '- ') + '**' + (m.name || 'peer') + '**: ' + m.text.replace(/\n/g, ' ')); });
      lines.push('');
    });
    return lines.join('\n');
  }
  function stats(annots) { var f = flatten(annots); return { threads: f.length, messages: f.reduce(function (s, e) { return s + e.item.th.length; }, 0), resolved: f.filter(function (e) { return e.item.rs; }).length }; }

  // authors table: id -> {name, avatar}; avatars travel once per author instead of once per comment
  function collectAuthors(annots, profiles, mine) {
    var seen = {}, out = {};
    Object.keys(annots).forEach(function (pg) {
      (annots[pg] || []).forEach(function (a) { if (a.t === 'cm') a.th.forEach(function (m) { if (m.by) seen[m.by] = 1; }); });
    });
    Object.keys(seen).forEach(function (id) {
      var p = (mine && mine.id === id) ? mine : profiles[id];
      if (p) out[id] = { name: String(p.name || '').slice(0, LIM.name), avatar: p.avatar || '' };
    });
    return out;
  }

  root.CoopComments = { LIM: LIM, MARK: MARK, normalizeItem: normalizeItem, newItem: newItem, stamp: stamp, stampMsg: stampMsg, uid: uid, find: find, reply: reply, removeMsg: removeMsg,
    resolve: resolve, quadsFromRects: quadsFromRects, project: project, layout: layout, spread: spread, popoverPos: popoverPos, hitQuad: hitQuad,
    flatten: flatten, markdown: markdown, stats: stats, collectAuthors: collectAuthors };
})(typeof self !== 'undefined' ? self : globalThis);
