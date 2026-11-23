/* Coop Reader session control logic (pure, unit tested):
 *   - RotationHost: after a kick the host moves everybody who is still in to a NEW session id and key. The old link,
 *     code, relay room and Kindle PIN stop working, so the kicked person cannot come back with the same link + password.
 *     Remaining peers receive a single-use, short-lived token over their existing (already authenticated) channel and
 *     present it on the new session instead of typing the password again.
 *   - IdleTracker: host-side tracking of peers that left the reader tab / minimised the window, for auto log-out.
 */
(function (root) {
  'use strict';
  var ID_RE = /^[\w-]{1,64}$/, KEY_RE = /^[\w-]{43}$/, TOKEN_RE = /^[0-9a-f]{32}$/;

  function randHex(bytes) {
    var u = new Uint8Array(bytes); (root.crypto || globalThis.crypto).getRandomValues(u);
    return Array.prototype.map.call(u, function (b) { return b.toString(16).padStart(2, '0'); }).join('');
  }
  function eq(a, b) {   // constant-time string compare
    a = String(a); b = String(b); var d = a.length ^ b.length;
    for (var i = 0; i < Math.max(a.length, b.length); i++) d |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
    return d === 0;
  }

  function validateRotate(m) {
    if (!m || typeof m !== 'object') return null;
    if (!ID_RE.test(String(m.id || '')) || !TOKEN_RE.test(String(m.token || ''))) return null;
    var key = m.key == null || m.key === '' ? '' : String(m.key);
    if (key && !KEY_RE.test(key)) return null;
    var epoch = Math.floor(+m.epoch); if (!(epoch >= 1 && epoch < 1e6)) return null;
    return { id: String(m.id), key: key, token: String(m.token), epoch: epoch };
  }

  function RotationHost(o) {
    o = o || {}; this.now = o.now || Date.now; this.rand = o.rand || randHex; this.ttl = o.ttlMs || 60000; this.grace = o.graceMs || 20000;
    this.epoch = 1; this.kicked = {}; this.tokens = {}; this.migratedIds = {}; this.startedAt = 0; this.active = false;
  }
  // peers: ids that are connected and authenticated now. kicked: ids that must be excluded.
  RotationHost.prototype.begin = function (peers, kicked) {
    var self = this; this.epoch++; this.active = true; this.startedAt = this.now(); this.tokens = {}; this.migratedIds = {};
    (kicked || []).forEach(function (id) { self.kicked[id] = 1; });
    var out = {};
    peers.forEach(function (id) {
      if (self.kicked[id]) return;
      var t = self.rand(16); self.tokens[id] = { token: t, exp: self.now() + self.ttl }; out[id] = t;
    });
    return { epoch: this.epoch, tokens: out };
  };
  RotationHost.prototype.verify = function (peerId, token) {
    var e = this.tokens[peerId];
    if (!e || this.kicked[peerId] || this.migratedIds[peerId]) return false;
    if (this.now() > e.exp || !eq(e.token, token)) return false;
    delete this.tokens[peerId]; this.migratedIds[peerId] = 1; return true;   // single use
  };
  RotationHost.prototype.markMigrated = function (id) {   // sessions without a password: arriving on the new session id is the proof
    if (!this.tokens[id] || this.kicked[id]) return false;
    delete this.tokens[id]; this.migratedIds[id] = 1; return true;
  };
  RotationHost.prototype.pending = function () { var t = this.tokens; return Object.keys(t); };
  RotationHost.prototype.done = function () { return this.active && this.pending().length === 0; };
  RotationHost.prototype.overdue = function () { return this.active && this.now() - this.startedAt > this.grace ? this.pending() : []; };
  RotationHost.prototype.finish = function () { this.active = false; this.tokens = {}; };
  RotationHost.prototype.isKicked = function (id) { return !!this.kicked[id]; };

  function IdleTracker(o) {
    o = o || {}; this.now = o.now || Date.now; this.grace = o.graceMs || 60000; this.hiddenAt = {};
  }
  IdleTracker.prototype.report = function (id, visible) {
    if (visible) delete this.hiddenAt[id]; else if (this.hiddenAt[id] === undefined) this.hiddenAt[id] = this.now();
  };
  IdleTracker.prototype.forget = function (id) { delete this.hiddenAt[id]; };
  IdleTracker.prototype.overdue = function (exempt) {
    var self = this, n = this.now(); exempt = exempt || [];
    return Object.keys(this.hiddenAt).filter(function (id) { return exempt.indexOf(id) < 0 && n - self.hiddenAt[id] >= self.grace; });
  };
  IdleTracker.prototype.secondsLeft = function (id) { return this.hiddenAt[id] !== undefined ? Math.max(0, Math.ceil((this.grace - (this.now() - this.hiddenAt[id])) / 1000)) : null; };
  IdleTracker.prototype.setGrace = function (ms) { this.grace = Math.max(10000, +ms || 60000); };

  root.CoopSession = { ID_RE: ID_RE, KEY_RE: KEY_RE, randHex: randHex, validateRotate: validateRotate, RotationHost: RotationHost, IdleTracker: IdleTracker };
})(typeof self !== 'undefined' ? self : globalThis);
