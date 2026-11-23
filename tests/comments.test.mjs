import test from 'node:test';
import assert from 'node:assert/strict';
import { loadScript } from './helpers/load.mjs';
const { CoopComments: K } = loadScript('coop-comments.js');
const J = v => JSON.parse(JSON.stringify(v));   // values built inside the vm realm have foreign prototypes
const mk = (id, x, y, extra = {}) => K.newItem({ id, k: 'pt', x, y, c: '#f59e0b', by: 'p1', name: 'Ana', text: 'hi ' + id, ts: 1, ...extra });

test('legacy notes are upgraded to one-message threads; junk is rejected', () => {
  const it = K.normalizeItem({ id: 'n1', t: 'note', x: 0.2, y: 0.3, text: 'old', name: 'Bo', by: 'b' });
  assert.equal(it.t, 'cm'); assert.equal(it.th.length, 1); assert.equal(it.th[0].text, 'old');
  assert.equal(K.normalizeItem({ id: 'x', t: 'cm', th: [] }), null);
  assert.equal(K.normalizeItem({ t: 'cm', th: [{ id: 'a', text: 'x' }] }), null);   // no id
  assert.equal(K.normalizeItem('nope'), null);
});

test('network input is clamped: long text, many replies, many quads, bad colours', () => {
  const raw = { id: 'a', t: 'cm', k: 'tx', c: 'red', x: 9, y: -9, quote: 'q'.repeat(999),
    q: Array.from({ length: 80 }, (_, i) => [0.1, 0.1 + i / 1000, 0.2, 0.02]).concat([[0, 0, 0, 0], 'bad']),
    th: Array.from({ length: 300 }, (_, i) => ({ id: 'm' + i, text: 'z'.repeat(2000), by: 'p', ts: i })) };
  const it = K.normalizeItem(raw);
  assert.equal(it.q.length, K.LIM.quads); assert.equal(it.th.length, K.LIM.thread);
  assert.equal(it.th[0].text.length, K.LIM.text); assert.equal(it.quote.length, K.LIM.quote);
  assert.equal(it.c, '#f59e0b'); assert.ok(it.x <= 1.05 && it.y >= -0.05);
});

test('threads: replies append once, deleting the root removes the thread, resolve toggles', () => {
  const list = [mk('c1', 0.1, 0.1)];
  assert.equal(K.reply(list, 'c1', { id: 'r1', by: 'p2', name: 'Bo', text: 'agree', ts: 2 }), true);
  assert.equal(K.reply(list, 'c1', { id: 'r1', by: 'p2', name: 'Bo', text: 'agree', ts: 2 }), false, 'duplicate delivery');
  assert.equal(K.reply(list, 'nope', { id: 'r2', text: 'x' }), false);
  assert.equal(list[0].th.length, 2);
  assert.equal(K.removeMsg(list, 'c1', 'r1'), 'msg'); assert.equal(list[0].th.length, 1);
  assert.equal(K.resolve(list, 'c1', true), true); assert.equal(list[0].rs, 1);
  assert.equal(K.removeMsg(list, 'c1', 'c1-m0'), 'thread'); assert.equal(list.length, 0);
});

test('zoom: pin positions scale with the page, pin size stays constant', () => {
  const items = [mk('a', 0.25, 0.5)];
  const at = zoom => K.layout(items, { left: 10, top: 20, width: 600 * zoom, height: 800 * zoom })[0];
  const a1 = at(1), a2 = at(2.5);
  assert.equal(a1.sx, 10 + 0.25 * 600); assert.equal(a2.sx, 10 + 0.25 * 1500);
  assert.equal(a2.sy, 20 + 0.5 * 2000);
  assert.equal(a1.r, a2.r, 'marker radius must not depend on zoom');
});

test('dense comments cluster in screen space and separate again when zoomed in', () => {
  const items = Array.from({ length: 12 }, (_, i) => mk('d' + i, 0.4 + i * 0.002, 0.4 + (i % 3) * 0.002));
  const far = [mk('far', 0.9, 0.9)];
  const small = K.layout([...items, ...far], { left: 0, top: 0, width: 500, height: 700 });
  const cl = small.filter(p => p.kind === 'cluster'); assert.equal(cl.length, 1); assert.equal(cl[0].n, 12);
  assert.equal(small.filter(p => p.kind === 'pin').length, 1);
  const big = K.layout(items, { left: 0, top: 0, width: 60000, height: 80000 });
  assert.equal(big.filter(p => p.kind === 'pin').length, 12, 'zooming in must split the cluster');
  const sp = K.spread(cl[0]); assert.equal(sp.length, 12);
  const d = (a, b) => Math.hypot(a.sx - b.sx, a.sy - b.sy);
  assert.ok(d(sp[0], sp[1]) > 20, 'fanned-out pins must be clickable apart');
});

test('layout is deterministic regardless of input order', () => {
  const a = [mk('1', 0.3, 0.3), mk('2', 0.3, 0.301), mk('3', 0.7, 0.7)], b = [a[2], a[0], a[1]], box = { left: 0, top: 0, width: 500, height: 700 };
  const sig = l => JSON.stringify(l.map(p => [p.kind, Math.round(p.sx), Math.round(p.sy), p.n]));
  assert.equal(sig(K.layout(a, box)), sig(K.layout(b, box)));
});

test('selection rectangles merge per line and are normalised to the page box', () => {
  const box = { left: 100, top: 100, width: 400, height: 600 };
  const rects = [
    { left: 120, top: 200, width: 50, height: 14 }, { left: 172, top: 201, width: 60, height: 14 },   // same line, split by a space
    { left: 120, top: 220, width: 200, height: 14 }, { left: 0, top: 0, width: 0.2, height: 0.2 },    // new line, junk
  ];
  const q = K.quadsFromRects(rects, box);
  assert.equal(q.length, 2);
  assert.ok(Math.abs(q[0][0] - 0.05) < 1e-3); assert.ok(Math.abs(q[0][2] - 112 / 400) < 1e-3);
  assert.equal(K.quadsFromRects(rects, { left: 0, top: 0, width: 0, height: 0 }).length, 0);
});

test('text comments keep their anchor on the first quad and are hit-testable', () => {
  const it = K.newItem({ id: 't1', k: 'tx', x: 0.9, y: 0.9, q: [[0.1, 0.2, 0.3, 0.02], [0.1, 0.23, 0.2, 0.02]], quote: 'selected words', by: 'p', name: 'A', text: 'why?', ts: 1 });
  assert.equal(it.x, 0.1); assert.equal(it.y, 0.2);
  const box = { left: 0, top: 0, width: 1000, height: 1000 };
  assert.equal(K.hitQuad(it, box, 200, 210), true); assert.equal(K.hitQuad(it, box, 800, 800), false);
});

test('popover stays inside the viewport', () => {
  const vp = { width: 400, height: 700 }, size = { w: 300, h: 200 };
  for (const a of [{ sx: 5, sy: 5 }, { sx: 395, sy: 695 }, { sx: 200, sy: 350 }]) {
    const p = K.popoverPos(a, size, vp);
    assert.ok(p.x >= 8 && p.y >= 8 && p.x + size.w <= vp.width - 8 && p.y + size.h <= vp.height - 8, JSON.stringify([a, p]));
  }
});

test('flatten/markdown/authors', () => {
  const annots = { 2: [mk('b', 0.5, 0.5)], 1: [mk('a', 0.1, 0.1), mk('c', 0.1, 0.9)] };
  K.reply(annots[1], 'a', { id: 'r', by: 'p2', name: 'Bo', text: 'reply', ts: 3 });
  const f = K.flatten(annots); assert.deepEqual(J(f.map(e => [e.n, e.page, e.item.id])), [[1, 1, 'a'], [2, 1, 'c'], [3, 2, 'b']]);
  assert.match(K.markdown(annots, 'x.pdf'), /\*\*Bo\*\*: reply/);
  assert.deepEqual(J(K.stats(annots)), { threads: 3, messages: 4, resolved: 0 });
  const au = K.collectAuthors(annots, { p2: { name: 'Bo', avatar: 'data:image/png;base64,AA' } }, { id: 'p1', name: 'Ana', avatar: '' });
  assert.equal(au.p1.name, 'Ana'); assert.equal(au.p2.avatar.startsWith('data:'), true);
});

test('host stamping: the sender cannot choose author, time, extra thread messages or resolved state', () => {
  const forged = { id: 'x1', t: 'cm', k: 'pt', x: .5, y: .5, rs: 1, by: 'victim', name: 'Boss', ts: 5, th: [{ id: 'm', by: 'victim', name: 'Boss', text: 'hi', ts: 5 }, { id: 'm2', by: 'victim', text: 'extra', ts: 5 }] };
  const it = K.stamp(forged, 'real-peer', 'Mallory', 1234);
  assert.equal(it.by, 'real-peer'); assert.equal(it.name, 'Mallory'); assert.equal(it.ts, 1234); assert.equal(it.th.length, 1); assert.equal(it.th[0].by, 'real-peer'); assert.equal(it.rs, 0);
  const m = K.stampMsg({ id: 'r1', by: 'victim', name: 'Boss', text: 'reply', ts: 1 }, 'real-peer', 'Mallory', 99);
  assert.equal(m.by, 'real-peer'); assert.equal(m.ts, 99);
  assert.equal(K.stamp({ t: 'cm' }, 'a', 'b', 1), null);
  assert.ok(K.uid().length >= 10 && K.uid() !== K.uid());
});
