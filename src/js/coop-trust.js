/* Coop Reader trust: who is allowed to give commands, and how a guest can PROVE a command came from the host.
 *
 * Threat model (see docs/SECURITY.md): everybody in a session can talk to everybody the transport lets them reach. Origin checks
 * ("conn.peer === host") are only as good as the transport: a peer-helper (bridge) or a relay participant can present itself as the host.
 * So host commands and host state are SIGNED:
 *   - the host creates an ECDSA P-256 identity key for the session (private key never leaves the tab, not even extractable),
 *   - its public key is announced on every connection (HOST_KEY) and PINNED by guests; when the invite link carries the key's
 *     fingerprint (fp=...), a different key is refused, so nobody on the path can substitute their own,
 *   - every privileged message carries _s = {q: sequence, t: recipient id, e: epoch, g: signature over a canonical encoding}.
 *     Sequence numbers only increase per recipient (replay protection); the recipient id binds a message to one person.
 * Content that peers produce (chat, cursors, annotations) is not signed: the host stamps who sent it, and only the host's
 * signature vouches for host-originated state. Over a bridge (a peer relaying for a newcomer) EVERYTHING must be signed.
 */
(function (root) {
  'use strict';
  var enc = new TextEncoder();
  // message types only the host may send, or that change state/permissions: signed whenever the host sends them
  var PRIV = {};
  ['HOST_KICK', 'HOST_MUTE', 'HOST_PING', 'SETTINGS', 'DOWNLOAD_PERMISSION', 'ROTATE', 'IDLE_LOGOUT', 'SYNC', 'PAGE_CHANGE', 'DOC_OPEN', 'DOC_READY',
    'DOC_ERROR', 'FILE_START', 'FILE_END', 'ANNOT_ALL', 'CHAT_HISTORY', 'AUTH_FAIL', 'PROFILE', 'VOICE_PEERS', 'CHAIN_CONNECT', 'BRIDGE_DOWN', 'BRIDGE_CLOSE',
    'RELAY_CLOSE', 'UPGRADE_TOKEN', 'UPGRADE_OK', 'AUTH_REQUIRED'].forEach(function (t) { PRIV[t] = 1; });

  function b64u(u8) { var s = ''; for (var i = 0; i < u8.length; i++) s += String.fromCharCode(u8[i]); return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); }
  function unb64u(s) { s = String(s).replace(/-/g, '+').replace(/_/g, '/'); while (s.length % 4) s += '='; var b = atob(s), u = new Uint8Array(b.length); for (var i = 0; i < b.length; i++) u[i] = b.charCodeAt(i); return u; }

  // deterministic JSON: sorted keys, no undefined; the same bytes on every machine and after any transport
  function canonical(v) {
    if (v === null || typeof v !== 'object') return JSON.stringify(v === undefined ? null : v);
    if (v instanceof Uint8Array) return JSON.stringify(b64u(v));
    if (Array.isArray(v)) return '[' + v.map(canonical).join(',') + ']';
    return '{' + Object.keys(v).filter(function (k) { return v[k] !== undefined; }).sort().map(function (k) { return JSON.stringify(k) + ':' + canonical(v[k]); }).join(',') + '}';
  }
  var subtle = function () { return (root.crypto || globalThis.crypto).subtle; };

  async function fingerprint(pubRaw) { var h = new Uint8Array(await subtle().digest('SHA-256', pubRaw)); return b64u(h.subarray(0, 16)); }   // 22 chars
  // six groups of five digits, easy to read out loud: derived from the fingerprint
  function safetyNumber(fp) {
    var b = unb64u(fp), out = [];
    for (var i = 0; i < 6; i++) out.push(String(((b[2 * i] << 8) | b[2 * i + 1]) % 100000).padStart(5, '0'));
    return out.join(' ');
  }
  async function createIdentity() {
    var kp = await subtle().generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign', 'verify']);   // private key is not extractable
    var raw = new Uint8Array(await subtle().exportKey('raw', kp.publicKey));
    return { priv: kp.privateKey, pubRaw: raw, pub: b64u(raw), fp: await fingerprint(raw) };
  }
  async function importPub(pubB64) {
    var raw = unb64u(pubB64); if (raw.length !== 65 || raw[0] !== 4) throw new Error('bad public key');
    return { key: await subtle().importKey('raw', raw, { name: 'ECDSA', namedCurve: 'P-256' }, true, ['verify']), raw: raw };
  }
  function signedBytes(msg, s) { return enc.encode('coop1|' + s.e + '|' + s.q + '|' + s.t + '|' + canonical(msg)); }

  // host side: returns a copy of msg with _s attached
  async function sign(identity, msg, to, seq, epoch) {
    var body = {}; Object.keys(msg).forEach(function (k) { if (k !== '_s') body[k] = msg[k]; });
    var s = { q: seq, t: String(to), e: epoch | 0 };
    var sig = new Uint8Array(await subtle().sign({ name: 'ECDSA', hash: 'SHA-256' }, identity.priv, signedBytes(body, s)));
    body._s = { q: s.q, t: s.t, e: s.e, g: b64u(sig) };
    return body;
  }

  // guest side. linkFp: fingerprint from the invite link (or ''): when present it is the root of trust.
  function GuestTrust(opts) {
    opts = opts || {}; this.linkFp = opts.linkFp || ''; this.key = null; this.fp = ''; this.lastSeq = {}; this.legacy = false;
    this.verified = false; this.mismatch = false;
  }
  GuestTrust.prototype.reset = function (linkFp) { this.linkFp = linkFp || ''; this.key = null; this.fp = ''; this.lastSeq = {}; this.legacy = false; this.verified = false; this.mismatch = false; };
  // a HOST_KEY announcement. Returns {ok, reason}
  GuestTrust.prototype.onHostKey = async function (pubB64) {
    var imp; try { imp = await importPub(pubB64); } catch (e) { return { ok: false, reason: 'malformed host key' }; }
    var fp = await fingerprint(imp.raw);
    if (this.linkFp && fp !== this.linkFp) { this.mismatch = true; return { ok: false, reason: 'the host key does not match the invite link' }; }
    if (this.key && this.fp !== fp) { this.mismatch = true; return { ok: false, reason: 'the host key changed during the session' }; }
    this.key = imp.key; this.fp = fp; this.verified = !!this.linkFp; this.legacy = false;
    return { ok: true, fp: fp, verified: this.verified };
  };
  // Decide what to do with an incoming message that claims to come from the host.
  //   ctx = { to: my peer id, bridged: arrives through a peer helper }
  // returns {ok:true, msg} (signature removed) or {ok:false, reason}
  GuestTrust.prototype.gate = async function (msg, ctx) {
    var needs = PRIV[msg.type] || ctx.bridged;
    if (msg.type === 'HOST_KEY') {   // a peer helper must not be able to introduce a key: over a bridge only a key from the invite link (or one already pinned) counts
      if (ctx.bridged && !this.linkFp && !this.key) return { ok: false, reason: 'no host key can be learned through another peer' };
      return { ok: true, msg: msg, hostKey: true };
    }
    if (!this.key) {
      if (this.linkFp || ctx.bridged) return needs || ctx.bridged ? { ok: false, reason: 'no verified host key yet' } : { ok: true, msg: msg };   // an invite with a fingerprint never downgrades
      this.legacy = true; return { ok: true, msg: msg };   // an older host that cannot sign: accepted, flagged in the UI
    }
    if (!needs) return { ok: true, msg: msg };
    var s = msg._s; if (!s || typeof s.g !== 'string' || !Number.isInteger(s.q) || typeof s.t !== 'string') return { ok: false, reason: 'unsigned ' + msg.type };
    if (s.t !== String(ctx.to)) return { ok: false, reason: 'signed for somebody else' };
    if (s.q <= (this.lastSeq[s.t] || 0)) return { ok: false, reason: 'replayed ' + msg.type };
    var body = {}; Object.keys(msg).forEach(function (k) { if (k !== '_s') body[k] = msg[k]; });
    var good; try { good = await subtle().verify({ name: 'ECDSA', hash: 'SHA-256' }, this.key, unb64u(s.g), signedBytes(body, s)); } catch (e) { good = false; }
    if (!good) return { ok: false, reason: 'bad signature on ' + msg.type };
    this.lastSeq[s.t] = s.q;
    return { ok: true, msg: body };
  };

  // host side sequence counters (per recipient)
  function HostSigner(identity) { this.id = identity; this.seq = {}; this.epoch = 1; }
  HostSigner.prototype.next = function (to) { return (this.seq[to] = (this.seq[to] || 0) + 1); };
  HostSigner.prototype.needs = function (msg, conn) { return !!(PRIV[msg.type] || (conn && conn._virtual && conn._via)); };
  HostSigner.prototype.sign = function (msg, to) { return sign(this.id, msg, to, this.next(to), this.epoch); };

  root.CoopTrust = { PRIV: PRIV, canonical: canonical, createIdentity: createIdentity, fingerprint: fingerprint, safetyNumber: safetyNumber, importPub: importPub,
    sign: sign, GuestTrust: GuestTrust, HostSigner: HostSigner, b64u: b64u, unb64u: unb64u };
})(typeof self !== 'undefined' ? self : globalThis);
