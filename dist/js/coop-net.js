/* Coop Reader connection policy: which route is in use, how good it is, and when to move to a better one.
 *
 * Preference order (best first):   p2p  ->  stun  ->  turn  ->  peer  ->  relay
 *   p2p    direct WebRTC, same network / public address (no NAT help needed)
 *   stun   direct WebRTC, NAT traversal through a STUN-discovered address (still peer to peer, no server in the data path)
 *   turn   WebRTC relayed by a TURN server (data path goes through the TURN server)
 *   peer   another participant forwards the traffic (one hop)
 *   relay  WebSocket relay worker (store-and-forward, works behind anything, last resort)
 * Pure logic, no DOM: unit tested in Node.
 */
(function (root) {
  'use strict';
  var ROUTES = ['p2p', 'stun', 'turn', 'peer', 'relay'];
  var RANK = { p2p: 0, stun: 1, turn: 2, peer: 3, relay: 4 };
  var BASE = { p2p: 100, stun: 92, turn: 62, peer: 42, relay: 30 };

  function isPrivateAddr(a) {
    if (!a) return false; a = String(a).toLowerCase();
    if (/\.local$/.test(a)) return true;   // mDNS host candidates only exist on the local network
    var m = a.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
    if (m) { var x = +m[1], y = +m[2]; return x === 10 || (x === 172 && y >= 16 && y <= 31) || (x === 192 && y === 168) || (x === 169 && y === 254) || x === 127 || (x === 100 && y >= 64 && y <= 127); }
    return /^(fe80:|fc|fd|::1)/.test(a);
  }

  // candidate types come from RTCIceCandidate.type: host | srflx | prflx | relay
  function classifyPair(local, remote) {
    local = local || {}; remote = remote || {};
    if (local.candidateType === 'relay' || remote.candidateType === 'relay') return 'turn';
    var types = [local.candidateType, remote.candidateType];
    if (types.indexOf('srflx') >= 0) return 'stun';
    if (types.indexOf('prflx') >= 0) {   // peer-reflexive: LAN direct when the other side is a private address, else a NAT-punched route
      var other = local.candidateType === 'prflx' ? remote : local, rem = remote.candidateType === 'prflx' ? remote : local;
      return (isPrivateAddr(rem.address || rem.ip) && isPrivateAddr(other.address || other.ip)) ? 'p2p' : 'stun';
    }
    return 'p2p';
  }

  // stats: array of RTCStats objects (call report.forEach to build it). Returns the route actually carrying data.
  function selectedRoute(stats) {
    var by = {}, pair = null, i;
    for (i = 0; i < stats.length; i++) by[stats[i].id] = stats[i];
    for (i = 0; i < stats.length; i++) if (stats[i].type === 'transport' && stats[i].selectedCandidatePairId) pair = by[stats[i].selectedCandidatePairId];
    if (!pair) for (i = 0; i < stats.length; i++) { var s = stats[i]; if (s.type === 'candidate-pair' && s.state === 'succeeded' && (s.selected || s.nominated)) { pair = s; break; } }
    if (!pair) return null;
    var l = by[pair.localCandidateId] || {}, r = by[pair.remoteCandidateId] || {};
    return { route: classifyPair({ candidateType: l.candidateType, address: l.address || l.ip }, { candidateType: r.candidateType, address: r.address || r.ip }),
      rtt: pair.currentRoundTripTime != null ? pair.currentRoundTripTime * 1000 : null, protocol: l.protocol || r.protocol || '',
      localType: l.candidateType, remoteType: r.candidateType };
  }

  // ---- quality ----------------------------------------------------------------------------------------
  function QualityTracker(now) {
    this.now = now || Date.now; this.rtt = null; this.jitter = 0; this.sent = 0; this.ok = 0; this.since = this.now(); this.failures = 0; this.recent = [];
  }
  QualityTracker.prototype.ping = function () { this.sent++; this.recent.push(0); if (this.recent.length > 20) this.recent.shift(); };
  QualityTracker.prototype.pong = function (rttMs) {
    this.ok++; if (this.recent.length) this.recent[this.recent.length - 1] = 1;
    if (this.rtt == null) this.rtt = rttMs; else { this.jitter += (Math.abs(rttMs - this.rtt) - this.jitter) / 8; this.rtt += (rttMs - this.rtt) / 4; }
  };
  QualityTracker.prototype.fail = function () { this.failures++; this.since = this.now(); };
  QualityTracker.prototype.lossRate = function () { var r = this.recent.slice(0, -1); return r.length < 4 ? 0 : 1 - r.reduce(function (a, b) { return a + b; }, 0) / r.length; };
  QualityTracker.prototype.snapshot = function (route) { return { route: route, rtt: this.rtt, jitter: this.jitter, loss: this.lossRate(), failures: this.failures, stableMs: this.now() - this.since }; };

  function routeScore(m) {
    var s = BASE[m.route] != null ? BASE[m.route] : 20;
    if (m.rtt != null) s -= Math.min(35, m.rtt / 12);
    s -= Math.min(40, (m.loss || 0) * 300);
    s -= Math.min(10, (m.jitter || 0) / 10);
    s -= Math.min(30, (m.failures || 0) * 8);
    s += Math.min(8, (m.stableMs || 0) / 30000 * 2);
    return Math.max(0, Math.round(s * 10) / 10);
  }

  // Move up only to a strictly better class AND only if it is measurably as good; never shuffle inside a class.
  function shouldUpgrade(cur, cand, margin) {
    if (!cur || !cand) return false;
    if (RANK[cand.route] >= RANK[cur.route]) return false;
    return routeScore(cand) >= routeScore(cur) + (margin == null ? 6 : margin);
  }
  // Among routes that are open right now, the best one carries the traffic (hysteresis keeps the current one unless clearly beaten).
  function pickBest(open, current) {
    var best = null, bs = -1;
    open.forEach(function (m) { var sc = routeScore(m) + (current && m.id === current.id ? 4 : 0); if (sc > bs) { bs = sc; best = m; } });
    return best;
  }

  // ---- connection plan --------------------------------------------------------------------------------
  function plan(o) {
    o = o || {}; var stunMs = o.stunMs || 7000, turnMs = o.turnMs || 10000, peerMs = o.peerMs || 8000, st = [];
    if (o.mode === 'ws') return [{ route: 'relay', ice: null, timeout: 0 }];
    if (o.priv) {   // private mode: never expose an address to the other side
      st.push({ route: 'turn', ice: 'turn', timeout: stunMs + turnMs });
      if (o.hasRelay) st.push({ route: 'relay', ice: null, timeout: 0 });
      return st;
    }
    st.push({ route: 'stun', ice: 'stun', timeout: stunMs });   // host + srflx candidates: covers p2p and stun
    if (o.hasTurn) st.push({ route: 'turn', ice: 'all', timeout: turnMs });
    if (o.peerHelpers !== false) st.push({ route: 'peer', ice: null, timeout: peerMs });
    if (o.hasRelay) st.push({ route: 'relay', ice: null, timeout: 0 });
    return st;
  }
  function relayDelay(stages) { var t = 0; for (var i = 0; i < stages.length; i++) { if (stages[i].route === 'relay') return t; t += stages[i].timeout; } return t; }
  function iceServersFor(kind, servers) {   // kind: 'stun' | 'turn' | 'all'
    var isTurn = function (s) { return /^turns?:/i.test(String([].concat(s.urls || s.url)[0])); };
    if (kind === 'stun') return servers.filter(function (s) { return !isTurn(s); });
    if (kind === 'turn') return servers.filter(isTurn);
    return servers.slice();
  }

  // ---- background upgrades ----------------------------------------------------------------------------
  function UpgradePlanner(opts) {
    opts = opts || {}; this.now = opts.now || Date.now; this.base = opts.base || 20000; this.max = opts.max || 300000;
    this.fails = 0; this.nextAt = this.now() + this.base; this.running = false;
  }
  UpgradePlanner.prototype.due = function (route, busy) {
    if (this.running || busy) return false;
    if (RANK[route] <= RANK.stun) return false;   // already on the best class
    return this.now() >= this.nextAt;
  };
  UpgradePlanner.prototype.start = function () { this.running = true; };
  UpgradePlanner.prototype.failed = function () { this.running = false; this.fails++; this.nextAt = this.now() + Math.min(this.max, this.base * Math.pow(2, this.fails)); };
  UpgradePlanner.prototype.succeeded = function () { this.running = false; this.fails = 0; this.nextAt = this.now() + this.base; };
  UpgradePlanner.prototype.reset = function () { this.running = false; this.fails = 0; this.nextAt = this.now() + 2000; };   // network changed: try soon

  root.CoopNet = { ROUTES: ROUTES, RANK: RANK, isPrivateAddr: isPrivateAddr, classifyPair: classifyPair, selectedRoute: selectedRoute,
    QualityTracker: QualityTracker, routeScore: routeScore, shouldUpgrade: shouldUpgrade, pickBest: pickBest, plan: plan, relayDelay: relayDelay,
    iceServersFor: iceServersFor, UpgradePlanner: UpgradePlanner };
})(typeof self !== 'undefined' ? self : globalThis);
