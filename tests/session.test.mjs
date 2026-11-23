import test from 'node:test';
import assert from 'node:assert/strict';
import { loadScript } from './helpers/load.mjs';
const { CoopSession: S } = loadScript('coop-session.js');
const J = v => JSON.parse(JSON.stringify(v));

test('rotation: remaining peers get single-use tokens, kicked peers never do', () => {
  let t = 0; const r = new S.RotationHost({ now: () => t, ttlMs: 5000, graceMs: 2000 });
  const b = r.begin(['alice', 'bob', 'mallory'], ['mallory']);
  assert.equal(b.epoch, 2); assert.deepEqual(Object.keys(J(b.tokens)).sort(), ['alice', 'bob']);
  assert.match(b.tokens.alice, /^[0-9a-f]{32}$/); assert.notEqual(b.tokens.alice, b.tokens.bob);
  assert.equal(r.verify('mallory', 'x'.repeat(32)), false); assert.equal(r.isKicked('mallory'), true);
  assert.equal(r.verify('alice', b.tokens.bob), false, 'a token only works for its own peer');
  assert.equal(r.verify('alice', b.tokens.alice), true);
  assert.equal(r.verify('alice', b.tokens.alice), false, 'replay must fail');
  assert.equal(r.done(), false); assert.deepEqual(J(r.pending()), ['bob']);
  assert.equal(r.verify('bob', b.tokens.bob), true); assert.equal(r.done(), true);
});

test('rotation: tokens expire; unresponsive peers are reported after the grace window', () => {
  let t = 0; const r = new S.RotationHost({ now: () => t, ttlMs: 5000, graceMs: 2000 });
  const b = r.begin(['alice', 'bob'], []);
  t = 1500; assert.deepEqual(J(r.overdue()), []);
  t = 2500; assert.deepEqual(J(r.overdue().sort()), ['alice', 'bob']);
  t = 6000; assert.equal(r.verify('alice', b.tokens.alice), false, 'expired');
  r.finish(); assert.equal(r.active, false);
});

test('a kicked id stays banned across later rotations', () => {
  const r = new S.RotationHost({ rand: () => 'a'.repeat(32) });
  r.begin(['a', 'b'], ['b']); r.finish();
  const second = r.begin(['a', 'b'], []);
  assert.deepEqual(Object.keys(J(second.tokens)), ['a']); assert.equal(second.epoch, 3);
});

test('ROTATE message validation rejects malformed ids, keys, tokens and epochs', () => {
  const ok = { id: 'abc-123', key: 'A'.repeat(43), token: 'f'.repeat(32), epoch: 2 };
  assert.equal(S.validateRotate(ok).id, 'abc-123');
  for (const bad of [{ ...ok, id: '../x' }, { ...ok, id: '' }, { ...ok, key: 'short' }, { ...ok, token: 'zz' }, { ...ok, epoch: 0 }, { ...ok, epoch: 'x' }, null, 'str'])
    assert.equal(S.validateRotate(bad), null, JSON.stringify(bad));
  assert.equal(S.validateRotate({ ...ok, key: '' }).key, '', 'sessions without an end-to-end key stay valid');
});

test('idle tracker: only peers that stay away longer than the grace period are due; returning resets', () => {
  let t = 0; const i = new S.IdleTracker({ now: () => t, graceMs: 60000 });
  i.report('a', false); t = 30000; i.report('b', false); i.report('c', true);
  assert.deepEqual(J(i.overdue()), []); assert.equal(i.secondsLeft('a'), 30);
  t = 61000; assert.deepEqual(J(i.overdue()), ['a']);
  i.report('a', true); assert.deepEqual(J(i.overdue()), []); assert.equal(i.secondsLeft('a'), null);
  t = 95000; assert.deepEqual(J(i.overdue(['b'])), [], 'exempt peers (e.g. someone presenting) are never logged out');
  assert.deepEqual(J(i.overdue()), ['b']);
  i.forget('b'); assert.deepEqual(J(i.overdue()), []);
  i.report('d', false); i.report('d', false); t += 1; assert.equal(i.hiddenAt.d, 95000, 'repeated hidden reports must not restart the clock');
});

test('open sessions (no password): arriving on the new id marks a peer migrated; kicked ids cannot', () => {
  const r = new S.RotationHost(); r.begin(['a', 'b'], ['x']);
  assert.equal(r.markMigrated('a'), true); assert.equal(r.markMigrated('a'), false); assert.equal(r.markMigrated('x'), false);
  assert.deepEqual(J(r.pending()), ['b']); assert.equal(r.verify('a', 'f'.repeat(32)), false, 'a migrated peer cannot reuse a token');
});
