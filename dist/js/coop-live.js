/* Coop Reader live session control (loaded after the main script, uses its globals):
 *   1. Kick + session rotation: removing someone moves everybody else to a NEW session id and key, so the old link, code,
 *      relay room and Kindle PIN stop working. Remaining peers follow automatically (single-use token, no password prompt).
 *   2. Idle log-out: the host can log out peers who leave the reader tab / minimise the window for too long.
 *   3. Route upgrades: a peer on relay / peer-bridge / TURN keeps trying (with back-off) to reach the host on a better route
 *      (p2p -> stun -> turn -> peer -> relay) and moves over seamlessly when it is measurably better.
 */
(function (root) {
  'use strict';
  var S = root.CoopSession, N = root.CoopNet;
  var rot = new S.RotationHost(), idle = new S.IdleTracker(), planner = new N.UpgradePlanner();
  var sleep = function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };
  var short = function (id) { return String(id).substring(0, 6) + '…'; };
  var nameOf = function (id) { return (profiles[id] && profiles[id].name) || short(id); };

  // ======================================== 1. kick + rotation ==============================================
  function newHostPeer() {
    return new Promise(function (res, rej) {
      var np = new Peer(peerOptions()), to = setTimeout(function () { try { np.destroy(); } catch (_) {} rej(new Error('signaling timeout')); }, 12000);
      np.on('open', function () { clearTimeout(to); res(np); });
      np.on('error', function (e) { clearTimeout(to); rej(e); });
    });
  }
  function revokeOldRelay(oldId) {
    try {
      var u = new URL(relayUrl(oldId, oldId)); u.protocol = u.protocol === 'wss:' ? 'https:' : 'http:';
      u.pathname = u.pathname.replace(/\/$/, '') + '/revoke';
      fetch(u.toString(), { method: 'POST', body: '{}' }).then(function () { netLog('old relay room revoked'); }).catch(function () {});
    } catch (_) {}
  }

  async function kick(pid) {
    if (!isHost) return;
    var victim = connections.find(function (c) { return c.peer === pid; });
    if (victim && victim.open) { try { victim.send({ type: 'HOST_KICK' }); } catch (_) {} }
    setTimeout(function () { if (victim) { try { victim.close(); } catch (_) {} } connections = connections.filter(function (c) { return c !== victim; }); updatePeerListUI(); updateChatAvailability(); }, 300);
    idle.forget(pid);
    await rotate([pid]);
  }

  async function rotate(kicked) {
    if (rot.active) { setTimeout(function () { rotate(kicked); }, 1500); return; }
    var oldPeer = peer, oldId = myPeerId, np;
    setStatus('Securing the session…', 'info');
    try { np = await newHostPeer(); }
    catch (e) { notify('Removed the peer, but a new session id could not be created (' + (e.message || e.type || e) + '). The old link still works until you restart the session.', 'warning', 10000); setStatus('Hosting — code: ' + oldId, 'warning'); return; }
    var newKey = b64u(crypto.getRandomValues(new Uint8Array(32)));
    var stay = connections.filter(function (c) { return c.open && c._authenticated && !c._probe && kicked.indexOf(c.peer) < 0; });
    var b = rot.begin(Array.from(new Set(stay.map(function (c) { return c.peer; }))), kicked);
    connections.forEach(function (c) { c._oldSession = true; });
    oldPeer._retired = true; peer = np; myPeerId = np.id; relayKeyB64 = newKey; holdHostWsUntil = Date.now() + 3500;   // the relay socket of the old room stays up just long enough to deliver the news
    attachPeerMediaHandlers();
    wireHostPeer(np, { rotated: true });
    np.emit('open', np.id);                                                                                          // runs the normal "session is open" logic: status, Kindle PIN, UI
    stay.forEach(function (c) { try { c.send({ type: 'ROTATE', id: np.id, key: newKey, token: b.tokens[c.peer], epoch: b.epoch }); } catch (_) {} });
    netLog('session rotated: ' + short(oldId) + ' -> ' + short(np.id) + ' (' + stay.length + ' peers follow, ' + kicked.length + ' removed)');
    setTimeout(function () { revokeOldRelay(oldId); }, 1800);
    var t = setInterval(function () {
      if (!(rot.done() || rot.overdue().length)) return;
      clearInterval(t);
      connections.filter(function (c) { return c._oldSession; }).forEach(function (c) { c._oldSession = false; try { c.close(); } catch (_) {} });
      connections = connections.filter(function (c) { return !c._oldSession; });
      try { oldPeer.destroy(); } catch (_) {}
      var missing = rot.pending(); rot.finish();
      updatePeerListUI(); updateChatAvailability(); updateHostUI();
      notify('Session secured: the removed person can no longer rejoin with the old link or password.' + (missing.length ? ' ' + missing.length + ' peer(s) did not follow in time and must rejoin with the new link.' : ''), 'success', 9000);
    }, 500);
    try { navigator.clipboard.writeText(buildShareUrl(np.id)).then(function () { notify('New link copied — share it with people you want to join.', 'info', 5000); }, function () { notify('New session code: ' + np.id, 'info', 8000); }); } catch (_) {}
  }

  // ---- peer side: the host moved the session -------------------------------------------------------------------
  function onRotate(conn, data) {
    if (isHost) return;
    var r = S.validateRotate(data); if (!r) return;
    if (conn.peer !== lastJoinCode) return;                                    // only the host we are connected to may move us
    pendingRejoin = { token: r.token, epoch: r.epoch, sent: false, prev: myPeerId };
    preferredPeerId = myPeerId;
    lastJoinCode = r.id; if (r.key) { peerRelayKey = r.key; try { sessionStorage.setItem('coop-rk', peerRelayKey); } catch (_) {} }
    pendingAuthHash = lastAuthHash; rejoinAttempts = 0;
    conn._replaced = true; connections = connections.filter(function (c) { return c !== conn; });
    if (relayV === conn) { var ws = relayV._sock; ws._intentional = true; clearInterval(relayV._hb); relayV = null; try { ws.close(); } catch (_) {} } else { try { conn.close(); } catch (_) {} }
    setStatus('Host re-keyed the session — reconnecting…', 'info');
    setTimeout(function () { joinSession(r.id + (r.key ? '.' + r.key : ''), true); }, 250);
  }
  // ---- host side: a peer arrives on the new session with its token -----------------------------------------------
  function onRejoin(conn, data) {
    if (!isHost) return;
    var prev = /^[\w-]{1,64}$/.test(String(data.prev || '')) ? String(data.prev) : conn.peer;   // the id the token was issued for (the peer may have a new one)
    if (rot.verify(prev, String(data.token || ''))) {
      conn._authenticated = true; conn._rejoined = true;
      connections.filter(function (o) { return o !== conn && (o.peer === conn.peer || o.peer === prev); }).forEach(function (o) { o._replaced = true; connections = connections.filter(function (x) { return x !== o; }); try { clearInterval(o._hb); o.close(); } catch (_) {} });
      sendInitialDataToConn(conn); updatePeerListUI(); updateChatAvailability();
      netLog(short(conn.peer) + ' followed the rotation' + (prev !== conn.peer ? ' (new id)' : ''));
    } else if (sessionAuth.required) { try { conn.send({ type: 'AUTH_REQUIRED', salt: sessionAuth.salt }); } catch (_) {} }   // token missing/expired: ask for the password like any newcomer
    else { conn._authenticated = true; sendInitialDataToConn(conn); }
  }

  // ======================================== 2. idle log-out =================================================
  function reportFocus() {
    if (isHost) return;
    var v = document.visibilityState === 'visible' ? 1 : 0;
    connections.forEach(function (c) { if (c.open && !c._probe) { try { c.send({ type: 'FOCUS', v: v }); } catch (_) {} } });
  }
  document.addEventListener('visibilitychange', reportFocus);
  window.addEventListener('pagehide', function () { if (!isHost) connections.forEach(function (c) { if (c.open) { try { c.send({ type: 'FOCUS', v: 0 }); } catch (_) {} } }); });
  window.addEventListener('pageshow', reportFocus);

  function logoutIdle(pid) {
    var c = connections.find(function (x) { return x.peer === pid && x.open; }); idle.forget(pid); if (!c) return;
    try { c.send({ type: 'IDLE_LOGOUT', sec: Math.round(idle.grace / 1000) }); } catch (_) {}
    notify(nameOf(pid) + ' was logged out for leaving the reader tab.', 'info', 5000);
    setTimeout(function () { try { c.close(); } catch (_) {} }, 400);
  }
  function onSettings() { idle.setGrace((hostSettings.idleSec || 60) * 1000); if (!hostSettings.idleLogout) idle.hiddenAt = {}; if (hostSettings.idleLogout) connections.forEach(function (c) { if (c._hidden) idle.report(c.peer, false); }); }
  setInterval(function () {
    if (!isHost || !hostSettings.idleLogout) return;
    idle.overdue().forEach(logoutIdle);
  }, 2000);
  function onIdleLogout(conn, data) {
    if (isHost || conn.peer !== lastJoinCode) return;
    lastJoinCode = null; pendingRejoin = null; clearTimeout(rejoinTimer); rejoinTimer = null;
    try { sessionStorage.removeItem('coop-session'); } catch (_) {}
    notify('You were logged out because you left the reader tab for more than ' + (+data.sec || 60) + ' s (host setting). Press Join to come back.', 'warning', 20000);
    setStatus('Logged out — you left the reader tab', 'warning');
  }
  // guests are told once that the host uses this setting
  var warned = false;
  setInterval(function () { if (!isHost && hostSettings.idleLogout && connections.some(function (c) { return c.open; }) && !warned) { warned = true; notify('Host setting: leaving this tab for more than ' + (hostSettings.idleSec || 60) + ' s logs you out.', 'info', 7000); } }, 4000);

  // ======================================== 3. route upgrades ================================================
  function currentRoute() {
    if (isHost) return null;
    var c = connections.find(function (x) { return x.open && !x._probe; }); if (!c || c._kindle) return null;
    return c._ws ? 'relay' : c._virtual ? 'peer' : (c._route || 'stun');
  }
  var busy = function () { return document.hidden || incomingTransfers.size > 0 || outgoingTransfers.size > 0 || !!drawing; };
  var tokenWaiters = [];
  function failProbe(pc) { planner.failed(); if (pc) { pc._probe = true; try { pc.close(); } catch (_) {} } }
  async function probeUpgrade() {
    var cur = connections.find(function (x) { return x.open && !x._probe; });
    if (!cur || !peer || peer.destroyed || peer.disconnected || !lastJoinCode) return planner.failed();
    cur.send({ type: 'UPGRADE_REQ' });
    var token = await new Promise(function (res) { var w = { res: res }; tokenWaiters.push(w); setTimeout(function () { res(null); }, 5000); });
    if (!token) return planner.failed();
    var pc; try { pc = peer.connect(lastJoinCode, { reliable: true, metadata: { upgrade: true } }); } catch (_) { return planner.failed(); }
    pc._probe = true;
    var timer = setTimeout(function () { failProbe(pc); }, 12000);
    pc.on('error', function () { clearTimeout(timer); failProbe(pc); });
    pc.on('open', async function () {
      var cand = null;
      for (var i = 0; i < 10 && !cand; i++) { try { var rep = await pc.peerConnection.getStats(), all = []; rep.forEach(function (r) { all.push(r); }); cand = N.selectedRoute(all); } catch (_) {} if (!cand) await sleep(300); }
      var now = { route: currentRoute(), rtt: cur._stats && cur._stats.rtt != null ? cur._stats.rtt : cur._appRtt, loss: cur._q ? cur._q.lossRate() : 0 };
      if (!cand || !N.shouldUpgrade(now, cand)) { clearTimeout(timer); netLog('route probe: ' + (cand ? cand.route : 'none') + ' is not better than ' + now.route); return failProbe(pc); }
      pc.send({ type: 'UPGRADE', token: token });
    });
    pc.on('data', function (d) {
      if (!d || d.type !== 'UPGRADE_OK') return;
      clearTimeout(timer);
      var old = connections.find(function (x) { return x.open && !x._probe && x !== pc; }); if (!old) return failProbe(pc);
      old._replaced = true; pc._probe = false; pc._authenticated = true; pc._synced = old._synced;
      connections = connections.map(function (c) { return c === old ? pc : c; });
      attachConnectionHandlers(pc);
      if (relayV === old) { var ws = relayV._sock; ws._intentional = true; clearInterval(relayV._hb); relayV = null; try { ws.close(); } catch (_) {} } else { clearInterval(old._hb); try { old.close(); } catch (_) {} }
      planner.succeeded(); notify('Switched to a better connection', 'success', 3000); updatePeerListUI(); updateDiagnosticsUI();
    });
  }
  function hostAcceptUpgrade(conn) {
    conn._probe = true;
    var kill = setTimeout(function () { try { conn.close(); } catch (_) {} }, 15000);
    conn.on('data', function (d) {
      if (!d || d.type !== 'UPGRADE') return;
      var old = connections.find(function (c) { return c.peer === conn.peer && c !== conn && c._upTok && !c._probe && c._authenticated; });
      if (!old || !S.randHex || String(d.token) !== old._upTok) { try { conn.close(); } catch (_) {} return; }
      clearTimeout(kill);
      ['_authenticated', '_synced', '_detached', '_hidden'].forEach(function (k) { if (old[k] !== undefined) conn[k] = old[k]; });
      conn._probe = false; conn._upTok = S.randHex(16);
      connections = connections.map(function (c) { return c === old ? conn : c; });
      attachConnectionHandlers(conn);
      old._replaced = true; clearInterval(old._hb); try { old.close(); } catch (_) {}
      try { conn.send({ type: 'UPGRADE_OK' }); } catch (_) {}
      updatePeerListUI(); updateDiagnosticsUI(); netLog(short(conn.peer) + ' moved to a direct route');
    });
    conn.on('close', function () { clearTimeout(kill); });
  }
  setInterval(function () { var r = currentRoute(); if (r && planner.due(r, busy())) { planner.start(); probeUpgrade().catch(function () { planner.failed(); }); } }, 5000);
  window.addEventListener('online', function () { planner.reset(); });
  if (navigator.connection && navigator.connection.addEventListener) navigator.connection.addEventListener('change', function () { planner.reset(); });

  // ======================================== message router ====================================================
  function handle(conn, data) {
    if (conn._probe) return true;                                       // probe connections only speak through their own handlers
    if (!isHost && pendingRejoin && !pendingRejoin.sent && conn.peer === lastJoinCode && data.type !== 'ROTATE') { pendingRejoin.sent = true; try { conn.send({ type: 'REJOIN', token: pendingRejoin.token, epoch: pendingRejoin.epoch, prev: pendingRejoin.prev }); } catch (_) {} }
    if (isHost && rot.active && !conn._oldSession && !sessionAuth.required && rot.pending().indexOf(conn.peer) >= 0) rot.markMigrated(conn.peer);
    switch (data.type) {
      case 'ROTATE': onRotate(conn, data); return true;
      case 'REJOIN': onRejoin(conn, data); return true;
      case 'FOCUS': if (isHost && conn._authenticated) { conn._hidden = !data.v; idle.report(conn.peer, !!data.v); } return true;
      case 'IDLE_LOGOUT': onIdleLogout(conn, data); return true;
      case 'UPGRADE_REQ': if (isHost && conn._authenticated) { conn._upTok = conn._upTok || S.randHex(16); try { conn.send({ type: 'UPGRADE_TOKEN', t: conn._upTok }); } catch (_) {} } return true;
      case 'UPGRADE_TOKEN': if (!isHost && conn.peer === lastJoinCode && typeof data.t === 'string') { var w = tokenWaiters.shift(); if (w) w.res(data.t); } return true;
      case 'SYNC': if (!isHost) { pendingRejoin = null; setTimeout(reportFocus, 500); } return false;
      default: return false;
    }
  }
  root.CoopIdle = { onSettings: onSettings };
  root.CoopLive = { handle: handle, kick: kick, rotate: rotate, rotationActive: function () { return rot.active; }, hostAcceptUpgrade: hostAcceptUpgrade, planner: planner };
})(typeof self !== 'undefined' ? self : globalThis);
