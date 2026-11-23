import test from 'node:test';
import assert from 'node:assert/strict';
import { loadScript } from './helpers/load.mjs';
const { CoopTrust: T } = loadScript('coop-trust.js', { btoa, atob });
const J = v => JSON.parse(JSON.stringify(v));

async function setup(linkFp) {
  const id = await T.createIdentity(), host = new T.HostSigner(id), g = new T.GuestTrust({ linkFp: linkFp === true ? id.fp : linkFp });
  return { id, host, g };
}

test('canonical JSON is order independent and stable', () => {
  assert.equal(T.canonical({ b: 1, a: [2, { d: 1, c: undefined }] }), T.canonical(J({ a: [2, { d: 1 }], b: 1 })));
  assert.notEqual(T.canonical({ a: 1 }), T.canonical({ a: '1' }));
});

test('a signed command is accepted once, by the right recipient, and the signature is stripped', async () => {
  const { host, g, id } = await setup(true);
  assert.equal((await g.onHostKey(id.pub)).ok, true);
  const m = await host.sign({ type: 'HOST_KICK' }, 'guest-1');
  const r = await g.gate(J(m), { to: 'guest-1' });
  assert.equal(r.ok, true); assert.deepEqual(J(r.msg), { type: 'HOST_KICK' });
  assert.equal((await g.gate(J(m), { to: 'guest-1' })).reason, 'replayed HOST_KICK', 'replay of the same message is refused');
  const other = await host.sign({ type: 'HOST_KICK' }, 'guest-2');
  assert.equal((await g.gate(J(other), { to: 'guest-1' })).reason, 'signed for somebody else', 'a command meant for another person cannot be reused');
});

test('forged, tampered, unsigned and wrongly signed commands are refused', async () => {
  const { host, g, id } = await setup(true); await g.onHostKey(id.pub);
  assert.match((await g.gate({ type: 'HOST_KICK' }, { to: 'x' })).reason, /unsigned/);
  const m = J(await host.sign({ type: 'SETTINGS', s: { peerUploads: false } }, 'x'));
  m.s.peerUploads = true; assert.match((await g.gate(m, { to: 'x' })).reason, /bad signature/);
  const attacker = await T.createIdentity(), forged = J(await new T.HostSigner(attacker).sign({ type: 'HOST_KICK' }, 'x'));
  assert.match((await g.gate(forged, { to: 'x' })).reason, /bad signature/, 'valid signature by a different key');
  const m2 = J(await host.sign({ type: 'ROTATE', id: 'abc' }, 'x')); m2._s.q = 99;
  assert.match((await g.gate(m2, { to: 'x' })).reason, /bad signature/, 'sequence number is covered by the signature');
});

test('sequence numbers only have to increase: gaps from unsigned traffic are fine, going backwards is not', async () => {
  const { host, g, id } = await setup(true); await g.onHostKey(id.pub);
  const a = await host.sign({ type: 'SYNC', state: {} }, 'x'), b = await host.sign({ type: 'PAGE_CHANGE', page: 2 }, 'x'), c = await host.sign({ type: 'PAGE_CHANGE', page: 3 }, 'x');
  assert.equal((await g.gate(J(a), { to: 'x' })).ok, true); assert.equal((await g.gate(J(c), { to: 'x' })).ok, true);
  assert.equal((await g.gate(J(b), { to: 'x' })).ok, false, 'older than the last accepted');
});

test('content that is not privileged passes unsigned (host stamps it) but everything over a bridge must be signed', async () => {
  const { host, g, id } = await setup(true); await g.onHostKey(id.pub);
  assert.equal((await g.gate({ type: 'CURSOR_MOVE', x: 1 }, { to: 'x' })).ok, true);
  assert.equal((await g.gate({ type: 'CURSOR_MOVE', x: 1 }, { to: 'x', bridged: true })).ok, false);
  const s = await host.sign({ type: 'CURSOR_MOVE', x: 1 }, 'x'); assert.equal((await g.gate(J(s), { to: 'x', bridged: true })).ok, true);
  assert.equal(host.needs({ type: 'CURSOR_MOVE' }, { _virtual: true, _via: {} }), true); assert.equal(host.needs({ type: 'CURSOR_MOVE' }, {}), false); assert.equal(host.needs({ type: 'HOST_KICK' }, {}), true);
});

test('the invite link fingerprint is the root of trust: a substituted key is refused, and unsigned hosts cannot downgrade it', async () => {
  const { id, g } = await setup(true), evil = await T.createIdentity();
  assert.match((await g.onHostKey(evil.pub)).reason, /does not match the invite link/);
  assert.equal(g.mismatch, true);
  assert.equal((await g.gate({ type: 'HOST_KICK' }, { to: 'x' })).ok, false, 'no verified key yet: privileged messages are held back');
  assert.equal((await g.gate({ type: 'CURSOR_MOVE' }, { to: 'x' })).ok, true);
  assert.equal((await g.gate({ type: 'CURSOR_MOVE' }, { to: 'x', bridged: true })).ok, false);
  const ok = await g.onHostKey(id.pub); assert.equal(ok.ok, true); assert.equal(ok.verified, true);
});

test('without a fingerprint in the link the first key is pinned (trust on first use) and a later different key is refused', async () => {
  const { id, g } = await setup(''), evil = await T.createIdentity();
  const first = await g.onHostKey(id.pub); assert.equal(first.ok, true); assert.equal(first.verified, false);
  assert.match((await g.onHostKey(evil.pub)).reason, /changed/);
});

test('legacy hosts (no HOST_KEY) are accepted only when the link carries no fingerprint, and are flagged', async () => {
  const noFp = new T.GuestTrust({}); const r = await noFp.gate({ type: 'HOST_KICK' }, { to: 'x' });
  assert.equal(r.ok, true); assert.equal(noFp.legacy, true);
  assert.equal((await noFp.gate({ type: 'CURSOR_MOVE' }, { to: 'x', bridged: true })).ok, false, 'bridges are never trusted without a key');
});

test('malformed keys are rejected; safety numbers are stable and readable', async () => {
  const g = new T.GuestTrust({}); assert.equal((await g.onHostKey('AAAA')).ok, false);
  const id = await T.createIdentity(); assert.equal(id.fp.length, 22);
  const n = T.safetyNumber(id.fp); assert.match(n, /^(\d{5} ){5}\d{5}$/); assert.equal(n, T.safetyNumber(id.fp));
  assert.notEqual(T.safetyNumber((await T.createIdentity()).fp), n);
});

test('the signing key cannot be exported', async () => {
  const id = await T.createIdentity();
  await assert.rejects(() => crypto.subtle.exportKey('pkcs8', id.priv));
});

test('a peer helper cannot introduce the host key unless the invite link vouches for it', async () => {
  const id = await T.createIdentity(), evil = await T.createIdentity();
  const open = new T.GuestTrust({}); assert.equal((await open.gate({ type: 'HOST_KEY', pk: evil.pub }, { to: 'x', bridged: true })).ok, false);
  const linked = new T.GuestTrust({ linkFp: id.fp }); assert.equal((await linked.gate({ type: 'HOST_KEY', pk: id.pub }, { to: 'x', bridged: true })).ok, true);
  assert.equal((await linked.onHostKey(evil.pub)).ok, false);
});
