import test from 'node:test';
import assert from 'node:assert/strict';
import { loadScript } from './helpers/load.mjs';
const { CoopNet: N } = loadScript('coop-net.js');
const J = v => JSON.parse(JSON.stringify(v));

test('route classification follows the SELECTED pair, not merely gathered candidates', () => {
  assert.equal(N.classifyPair({ candidateType: 'host', address: '192.168.1.5' }, { candidateType: 'host', address: '192.168.1.9' }), 'p2p');
  assert.equal(N.classifyPair({ candidateType: 'host' }, { candidateType: 'srflx' }), 'stun');
  assert.equal(N.classifyPair({ candidateType: 'srflx' }, { candidateType: 'relay' }), 'turn');
  assert.equal(N.classifyPair({ candidateType: 'relay' }, { candidateType: 'host' }), 'turn');
  assert.equal(N.classifyPair({ candidateType: 'prflx', address: '10.0.0.4' }, { candidateType: 'host', address: '10.0.0.8' }), 'p2p');
  assert.equal(N.classifyPair({ candidateType: 'host', address: '10.0.0.4' }, { candidateType: 'prflx', address: '84.12.3.4' }), 'stun');
  assert.equal(N.classifyPair({ candidateType: 'host', address: 'a1b2.local' }, { candidateType: 'prflx', address: 'c3d4.local' }), 'p2p');
});

test('selectedRoute reads transport -> pair -> candidates from a stats dump', () => {
  const stats = [
    { id: 'T1', type: 'transport', selectedCandidatePairId: 'P2' },
    { id: 'P1', type: 'candidate-pair', state: 'failed', localCandidateId: 'L1', remoteCandidateId: 'R1' },
    { id: 'P2', type: 'candidate-pair', state: 'succeeded', nominated: true, localCandidateId: 'L2', remoteCandidateId: 'R2', currentRoundTripTime: 0.045 },
    { id: 'L1', type: 'local-candidate', candidateType: 'relay' }, { id: 'R1', type: 'remote-candidate', candidateType: 'host' },
    { id: 'L2', type: 'local-candidate', candidateType: 'host', address: '203.0.113.5', protocol: 'udp' }, { id: 'R2', type: 'remote-candidate', candidateType: 'srflx', address: '198.51.100.7' },
  ];
  const r = N.selectedRoute(stats);
  assert.equal(r.route, 'stun'); assert.equal(Math.round(r.rtt), 45); assert.equal(r.protocol, 'udp');
  assert.equal(N.selectedRoute([]), null);
});

test('plan: p2p/stun first, then TURN, then a peer helper, then the relay; modes change the order', () => {
  const p = J(N.plan({ hasTurn: true, hasRelay: true }));
  assert.deepEqual(p.map(s => s.route), ['stun', 'turn', 'peer', 'relay']);
  assert.deepEqual(J(N.plan({ hasTurn: false, hasRelay: true })).map(s => s.route), ['stun', 'peer', 'relay']);
  assert.deepEqual(J(N.plan({ hasTurn: false, hasRelay: false })).map(s => s.route), ['stun', 'peer']);
  assert.deepEqual(J(N.plan({ mode: 'ws' })).map(s => s.route), ['relay']);
  assert.deepEqual(J(N.plan({ priv: true, hasRelay: true })).map(s => s.route), ['turn', 'relay'], 'private mode never tries a direct route');
  assert.equal(N.relayDelay(N.plan({ hasTurn: true, hasRelay: true })), 7000 + 10000 + 8000);
  assert.equal(N.relayDelay(N.plan({ mode: 'ws' })), 0);
});

test('ICE server sets per stage', () => {
  const s = [{ urls: 'stun:a' }, { urls: ['turn:b', 'turns:b'] }, { urls: 'turn:c' }];
  assert.equal(N.iceServersFor('stun', s).length, 1); assert.equal(N.iceServersFor('turn', s).length, 2); assert.equal(N.iceServersFor('all', s).length, 3);
});

test('scores: class dominates, then latency/loss/failures; upgrades need a real improvement', () => {
  const stun = { route: 'stun', rtt: 40, loss: 0, jitter: 3, failures: 0, stableMs: 20000 }, turn = { route: 'turn', rtt: 40, loss: 0, failures: 0, stableMs: 60000 };
  assert.ok(N.routeScore(stun) > N.routeScore(turn));
  assert.ok(N.routeScore({ ...stun, loss: 0.3 }) < N.routeScore(turn), 'a lossy direct link is worse than a clean TURN link');
  assert.equal(N.shouldUpgrade(turn, stun), true);
  assert.equal(N.shouldUpgrade(turn, { ...stun, loss: 0.3 }), false, 'flaky candidates must not take over');
  assert.equal(N.shouldUpgrade(stun, turn), false); assert.equal(N.shouldUpgrade(turn, { ...turn }), false, 'no shuffling inside a class');
  assert.equal(N.shouldUpgrade({ route: 'relay', rtt: 90 }, { route: 'turn', rtt: 70, failures: 0 }), true);
});

test('pickBest keeps the current route unless clearly beaten (hysteresis)', () => {
  const a = { id: 'a', route: 'stun', rtt: 60 }, b = { id: 'b', route: 'stun', rtt: 58 };
  assert.equal(N.pickBest([a, b], a).id, 'a');
  assert.equal(N.pickBest([{ id: 'c', route: 'relay', rtt: 30 }, { id: 'd', route: 'turn', rtt: 80 }], null).id, 'd');
});

test('quality tracker: ewma rtt, loss window and failures feed the score', () => {
  let t = 0; const q = new N.QualityTracker(() => t);
  for (let i = 0; i < 10; i++) { q.ping(); if (i % 2) q.pong(50 + i); t += 1000; }
  const s = q.snapshot('turn'); assert.ok(s.rtt > 40 && s.rtt < 70); assert.ok(s.loss > 0.3, 'half of the pings were never answered');
  q.fail(); assert.equal(q.snapshot('turn').failures, 1);
});

test('upgrade planner backs off exponentially, skips good routes and while busy, and restarts on network change', () => {
  let t = 0; const u = new N.UpgradePlanner({ now: () => t, base: 1000, max: 8000 });
  assert.equal(u.due('relay'), false); t = 1000; assert.equal(u.due('relay'), true);
  assert.equal(u.due('stun'), false, 'already best class'); assert.equal(u.due('relay', true), false, 'busy transferring');
  u.start(); assert.equal(u.due('relay'), false); u.failed(); assert.equal(u.nextAt, t + 2000);
  t += 2000; u.start(); u.failed(); assert.equal(u.nextAt, t + 4000);
  t += 4000; u.start(); u.failed(); u.start(); u.failed(); assert.ok(u.nextAt - t <= 8000);
  u.reset(); assert.equal(u.nextAt, t + 2000);
  u.start(); u.succeeded(); assert.equal(u.fails, 0);
});
