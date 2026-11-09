/**
 * Coop Reader - Kindle E-Ink Application Controller
 * Translated and optimized for Jailbroken Kindle e-readers.
 * Compatible with Kindle Mesquite, WebKit, and local Python daemon.
 */

(function () {
  'use strict';

  // ==================== CONFIGURATION & STATE ====================
  var savedRelay = '';
  try { savedRelay = localStorage.getItem('coop-relay') || ''; } catch (_) {}
  var CONFIG = {
    defaultRelay: savedRelay || 'wss://coop-relay.coop-reader.workers.dev',
    daemonApi: 'http://127.0.0.1:8765',
    chunkSize: 49152,
    heartbeatInterval: 12000,
    pageChars: 2800
  };

  var state = {
    isHost: false,
    sessionId: '',
    relayKey: '',
    myPeerId: '',
    myDisplayName: 'Kindle Reader',
    detached: false,
    syncPageEnabled: true,
    syncDocEnabled: true,
    backgroundPolling: true,
    isBackground: false,
    isDownloadingDoc: false,
    lastDownloadedDoc: '',
    currentPage: 1,
    totalPages: 1,
    syncedPage: 1,
    currentFilename: '',
    fileType: 'text', // 'text' | 'pdf'
    fontScale: 'md',
    downloadAllowed: true,
    peerUploadsAllowed: false,
    peerAnnotateAllowed: true,
    battery: null,
    relayConnected: false,
    hostOnline: null
  };

  try {
    var sp = localStorage.getItem('coop-sync-page');
    if (sp !== null) state.syncPageEnabled = sp === 'true';
    var sd = localStorage.getItem('coop-sync-doc');
    if (sd !== null) state.syncDocEnabled = sd === 'true';
    var sb = localStorage.getItem('coop-sync-bg');
    if (sb !== null) state.backgroundPolling = sb === 'true';
  } catch (_) {}

  var welcomeDoc = 'Welcome to Coop Reader for Kindle!\n\n' +
    'Read documents and books together in real-time.\n\n' +
    'How to use:\n' +
    '1. Tap [Session] at the top right to Host or Join a reading room.\n' +
    '2. Tap [Docs] to browse books from /mnt/us/documents or receive a book from the host.\n' +
    '3. Page turns sync across everyone in the session.\n' +
    '4. Tap left/right screen edges or use Kindle physical buttons to turn pages.\n' +
    '5. Tap [Refresh] anytime to clear e-ink ghosting.\n\n' +
    'Supported formats: PDF, EPUB, MOBI, AZW3, TXT, DOCX, XLSX.';

  var connections = {};
  // Relay transport per peer; HTTP peers (KOReader) need plaintext control
  // frames because their Lua runtime does not implement the browser AES layer.
  var connectionTransports = {};
  var relayWs = null;
  var relayToken = '';
  var relayReconnectTimer = null;
  var relayHeartbeatTimer = null;
  var relayStatusTimer = null;
  var relayGeneration = 0;
  var manualDisconnect = false;
  var relayKeyB64 = '';
  var peerRelayKey = '';
  var sessionPasswordHash = null;
  var sessionSalt = null;

  var docPages = [];
  var docToc = [];
  var docRawBytes = null;
  var pdfDoc = null;
  var pdfRendering = false;

  var annots = {}; // page -> array of { id, type, x, y, text, by, name }
  var chatMessages = [];
  var incomingTransfer = null;
  var outgoingTransfer = null;
  var profiles = {};
  var speakingPeers = {};

  // ==================== DOM ELEMENTS ====================
  var el = {};
  function cacheElements() {
    el.viewport = document.getElementById('kindle-viewport');
    el.textViewport = document.getElementById('text-viewport');
    el.pdfCanvas = document.getElementById('pdf-canvas');
    el.annotCanvas = document.getElementById('annot-canvas');
    el.renderContainer = document.getElementById('render-container');
    
    el.docTitle = document.getElementById('doc-title');
    el.pageIndicator = document.getElementById('page-indicator');
    el.syncStatus = document.getElementById('sync-status');
    el.batteryStatus = document.getElementById('battery-status');
    el.voiceIndicator = document.getElementById('voice-indicator');

    el.btnPrev = document.getElementById('btn-prev');
    el.btnNext = document.getElementById('btn-next');
    el.btnSync = document.getElementById('btn-sync');
    el.btnRefresh = document.getElementById('btn-refresh');
    el.btnToggleDocSync = document.getElementById('btn-toggle-doc-sync');
    el.btnTogglePageSync = document.getElementById('btn-toggle-page-sync');
    el.chkSyncDoc = document.getElementById('chk-sync-doc');
    el.chkSyncPage = document.getElementById('chk-sync-page');
    el.chkSyncBg = document.getElementById('chk-sync-bg');
    el.btnCloseDoc = document.getElementById('btn-close-doc');

    // Modals
    el.modalSession = document.getElementById('modal-session');
    el.modalDoc = document.getElementById('modal-doc');
    el.modalChat = document.getElementById('modal-chat');
    el.modalPeers = document.getElementById('modal-peers');
    el.modalToc = document.getElementById('modal-toc');
    el.modalNotes = document.getElementById('modal-notes');

    // Chat list & input
    el.chatList = document.getElementById('chat-list');
    el.chatInput = document.getElementById('chat-input');
  }

  // ==================== UTILITIES & CRYPTO ====================
  function generateId(prefix) {
    var chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
    var out = prefix || 'k';
    for (var i = 0; i < 7; i++) {
      out += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return out;
  }

  function b64encode(u8) {
    var s = '';
    for (var i = 0; i < u8.length; i += 0x8000) {
      s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
    }
    return btoa(s);
  }

  function b64decode(str) {
    var binary = atob(str);
    var bytes = new Uint8Array(binary.length);
    for (var i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    return bytes;
  }

  function b64u(u8) {
    return b64encode(u8).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }

  function unb64u(str) {
    var t = str.replace(/-/g, '+').replace(/_/g, '/');
    while (t.length % 4) t += '=';
    return b64decode(t);
  }

  var keyCache = {};
  function getAesKey(keyB64) {
    if (keyCache[keyB64]) return Promise.resolve(keyCache[keyB64]);
    if (!window.crypto || !window.crypto.subtle) return Promise.resolve(null);
    return window.crypto.subtle.importKey('raw', unb64u(keyB64), 'AES-GCM', false, ['encrypt', 'decrypt'])
      .then(function (k) {
        keyCache[keyB64] = k;
        return k;
      }).catch(function () {
        return null;
      });
  }

  function sealMsg(payload, keyB64, room) {
    var str = JSON.stringify(payload);
    if (!window.crypto || !window.crypto.subtle || !keyB64) {
      return Promise.resolve({ raw: str });
    }
    var iv = new Uint8Array(12);
    window.crypto.getRandomValues(iv);
    var enc = new TextEncoder();
    return getAesKey(keyB64).then(function (key) {
      if (!key) return { raw: str };
      return window.crypto.subtle.encrypt(
        { name: 'AES-GCM', iv: iv, additionalData: enc.encode(room) },
        key,
        enc.encode(str)
      ).then(function (ct) {
        return { e: 1, iv: b64encode(iv), c: b64encode(new Uint8Array(ct)) };
      });
    }).catch(function () {
      return { raw: str };
    });
  }

  function openMsg(env, keyB64, room) {
    if (!env) return Promise.resolve(null);
    // KOReader sends control messages as ordinary protocol objects.
    if (env.type) return Promise.resolve(env);
    if (env.raw) {
      try { return Promise.resolve(JSON.parse(env.raw)); } catch (e) { return Promise.resolve(null); }
    }
    if (env.e !== 1 || !keyB64 || !window.crypto || !window.crypto.subtle) {
      return Promise.resolve(null);
    }
    var enc = new TextEncoder();
    return getAesKey(keyB64).then(function (key) {
      if (!key) return null;
      return window.crypto.subtle.decrypt(
        { name: 'AES-GCM', iv: b64decode(env.iv), additionalData: enc.encode(room) },
        key,
        b64decode(env.c)
      ).then(function (pt) {
        var str = new TextDecoder().decode(pt);
        return JSON.parse(str);
      });
    }).catch(function () {
      return null;
    });
  }

  function hashPassword(pass, salt) {
    if (!window.crypto || !window.crypto.subtle) return Promise.reject(new Error('This Kindle browser does not provide Web Crypto SHA-256; password-protected sessions are unavailable.'));
    var enc = new TextEncoder();
    return window.crypto.subtle.digest('SHA-256', enc.encode(pass + ':' + salt)).then(function (buf) {
      var arr = new Uint8Array(buf);
      var hex = '';
      for (var i = 0; i < arr.length; i++) {
        hex += ('0' + arr[i].toString(16)).slice(-2);
      }
      return hex;
    });
  }

  // ==================== NETWORKING & RELAY ====================
  function registerAppHostPin(roomId, attempt) {
    attempt = attempt || 0;
    if (!state.isHost || state.sessionId !== roomId) return;
    if (!state.relayConnected) {
      if (attempt < 24) setTimeout(function () { registerAppHostPin(roomId, attempt + 1); }, 500);
      else {
        state.pin = '';
        var pinOutput = document.getElementById('session-display-pin');
        if (pinOutput) pinOutput.innerText = 'Unavailable — use full code';
        updateHeaderUI();
      }
      return;
    }
    var relayHttp = CONFIG.defaultRelay.replace(/^ws:\/\//i, 'http://').replace(/^wss:\/\//i, 'https://');
    fetch(relayHttp + '/pin/create', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ room: roomId, key: relayKeyB64 || '' })
    }).then(function (res) {
      if (!res.ok) throw new Error('PIN registry returned HTTP ' + res.status);
      return res.json();
    }).then(function (data) {
      if (!state.isHost || state.sessionId !== roomId) return;
      state.pin = data && data.ok && data.pin ? String(data.pin) : '';
      var pinOutput = document.getElementById('session-display-pin');
      if (pinOutput) pinOutput.innerText = state.pin || 'Unavailable — use full code';
      updateHeaderUI();
    }).catch(function (error) {
      state.pin = '';
      var pinOutput = document.getElementById('session-display-pin');
      if (pinOutput) pinOutput.innerText = 'Unavailable — use full code';
      updateSyncStatus('PIN unavailable: ' + error.message, 'error');
      updateHeaderUI();
    });
  }

  function startRoomStatusPolling(roomId, generation) {
    if (relayStatusTimer) { clearInterval(relayStatusTimer); relayStatusTimer = null; }
    function checkStatus() {
      if (generation !== relayGeneration || state.sessionId !== roomId || manualDisconnect) return;
      var relayHttp = CONFIG.defaultRelay.replace(/^ws:\/\//i, 'http://').replace(/^wss:\/\//i, 'https://');
      fetch(relayHttp + '/room/' + encodeURIComponent(roomId) + '/state').then(function (response) {
        if (!response.ok) throw new Error('HTTP ' + response.status);
        return response.json();
      }).then(function (data) {
        if (generation !== relayGeneration || state.sessionId !== roomId || !data || !data.ok) return;
        state.hostOnline = !!data.hostOnline;
        if (!state.isHost && !state.hostOnline) updateSyncStatus('Relay connected · waiting for host', 'error');
        else if (state.hostOnline && state.relayConnected) updateSyncStatus(state.isHost ? 'HOST · Relay connected' : 'Connected to host', 'success');

        if (data.doc && data.doc.filename && state.syncDocEnabled && data.doc.filename !== state.currentFilename && !state.isDownloadingDoc) {
          downloadDocFromRelay(data.doc.filename);
        }
        if (data.latestPage && state.syncPageEnabled && !state.isHost && !state.detached && data.latestPage !== state.currentPage) {
          state.syncedPage = data.latestPage;
          state.currentPage = data.latestPage;
          if (!state.isBackground) {
            renderCurrentPage();
          }
        }

        updateHeaderUI();
      }).catch(function () {
        if (generation === relayGeneration && !state.isHost) {
          state.hostOnline = false;
          updateSyncStatus('Relay connected · host status unavailable', 'error');
          updateHeaderUI();
        }
      });
    }
    checkStatus();
    relayStatusTimer = setInterval(checkStatus, 3000);
  }

  // ==================== BACKGROUND & PERSISTENCE ====================
  var bgPollTimer = null;

  function onBackground() {
    state.isBackground = true;
    if (state.backgroundPolling && state.sessionId && !manualDisconnect) {
      if (!bgPollTimer) {
        bgPollTimer = setInterval(function () {
          checkRoomBackgroundSync();
        }, 5000);
      }
    }
  }

  function onForeground() {
    state.isBackground = false;
    if (bgPollTimer) {
      clearInterval(bgPollTimer);
      bgPollTimer = null;
    }
    if (state.sessionId && !manualDisconnect) {
      if (!relayWs || relayWs.readyState !== 1) {
        initRelayConnection(state.sessionId, state.myPeerId, state.isHost);
      }
      checkRoomBackgroundSync();
    }
    renderCurrentPage();
  }

  function checkRoomBackgroundSync() {
    if (!state.sessionId || manualDisconnect) return;
    var relayHttp = CONFIG.defaultRelay.replace(/^ws:\/\//i, 'http://').replace(/^wss:\/\//i, 'https://');
    fetch(relayHttp + '/room/' + encodeURIComponent(state.sessionId) + '/state')
      .then(function (res) { return res.json(); })
      .then(function (data) {
        if (!data || !data.ok || !state.sessionId) return;
        state.hostOnline = !!data.hostOnline;
        if (data.doc && data.doc.filename && state.syncDocEnabled && data.doc.filename !== state.currentFilename && !state.isDownloadingDoc) {
          downloadDocFromRelay(data.doc.filename);
        }
        if (data.latestPage && state.syncPageEnabled && !state.isHost && !state.detached && data.latestPage !== state.currentPage) {
          state.syncedPage = data.latestPage;
          state.currentPage = data.latestPage;
          if (!state.isBackground) {
            renderCurrentPage();
          }
        }
        updateHeaderUI();
      })
      .catch(function () {});
  }

  function recordLocalSession(roomId) {
    if (!roomId) return;
    try {
      fetch(CONFIG.daemonApi + '/api/session?room=' + encodeURIComponent(roomId))
        .catch(function () {});
    } catch (_) {}
  }

  function clearLocalSession() {
    try {
      fetch(CONFIG.daemonApi + '/api/session?room=')
        .catch(function () {});
    } catch (_) {}
  }

  function setDocSync(enabled) {
    state.syncDocEnabled = !!enabled;
    try { localStorage.setItem('coop-sync-doc', String(state.syncDocEnabled)); } catch (_) {}
    updateSyncControlsUI();
    updateSyncStatus('Doc sync ' + (state.syncDocEnabled ? 'ON' : 'OFF'), 'success');
  }

  function setPageSync(enabled) {
    state.syncPageEnabled = !!enabled;
    try { localStorage.setItem('coop-sync-page', String(state.syncPageEnabled)); } catch (_) {}
    updateSyncControlsUI();
    updateSyncStatus('Page sync ' + (state.syncPageEnabled ? 'ON' : 'OFF'), 'success');
  }

  function setBackgroundSync(enabled) {
    state.backgroundPolling = !!enabled;
    try { localStorage.setItem('coop-sync-bg', String(state.backgroundPolling)); } catch (_) {}
    updateSyncControlsUI();
    updateSyncStatus('Background sync ' + (state.backgroundPolling ? 'ON' : 'OFF'), 'success');
  }

  function updateSyncControlsUI() {
    if (el.btnToggleDocSync) {
      el.btnToggleDocSync.innerText = 'Doc Sync: ' + (state.syncDocEnabled ? 'ON' : 'OFF');
      if (state.syncDocEnabled) {
        el.btnToggleDocSync.classList.remove('inverted');
      } else {
        el.btnToggleDocSync.classList.add('inverted');
      }
    }
    if (el.btnTogglePageSync) {
      el.btnTogglePageSync.innerText = 'Page Sync: ' + (state.syncPageEnabled ? 'ON' : 'OFF');
      if (state.syncPageEnabled) {
        el.btnTogglePageSync.classList.remove('inverted');
      } else {
        el.btnTogglePageSync.classList.add('inverted');
      }
    }
    if (el.chkSyncDoc) el.chkSyncDoc.checked = state.syncDocEnabled;
    if (el.chkSyncPage) el.chkSyncPage.checked = state.syncPageEnabled;
    if (el.chkSyncBg) el.chkSyncBg.checked = state.backgroundPolling;
  }

  function initRelayConnection(roomId, peerId, isHostRole) {
    if (relayReconnectTimer) { clearTimeout(relayReconnectTimer); relayReconnectTimer = null; }
    if (relayHeartbeatTimer) { clearInterval(relayHeartbeatTimer); relayHeartbeatTimer = null; }
    if (relayStatusTimer) { clearInterval(relayStatusTimer); relayStatusTimer = null; }
    if (relayWs) {
      var previous = relayWs;
      relayWs = null;
      previous.onclose = null;
      previous.onerror = null;
      try { previous.close(); } catch (_) {}
    }
    if (!roomId || !peerId || manualDisconnect) return;

    var generation = ++relayGeneration;
    if (!relayToken) relayToken = generateId('tok');
    var wsUrl = CONFIG.defaultRelay.replace(/\/$/, '') + '/room/' + encodeURIComponent(roomId) + '?id=' + encodeURIComponent(peerId) + '&t=' + encodeURIComponent(relayToken);
    updateSyncStatus('Connecting to relay...', 'warning');

    try {
      relayWs = new WebSocket(wsUrl);
    } catch (e) {
      state.relayConnected = false;
      updateSyncStatus('Relay error: ' + e.message, 'error');
      scheduleRelayReconnect(generation);
      return;
    }
    var socket = relayWs;

    socket.onopen = function () {
      if (generation !== relayGeneration || relayWs !== socket) return;
      state.relayConnected = true;
      state.hostOnline = isHostRole ? true : null;
      updateSyncStatus(isHostRole ? 'HOST · Relay connected' : 'Relay connected · checking host', 'success');
      startRoomStatusPolling(roomId, generation);
      if (isHostRole) registerAppHostPin(roomId, 0);
      if (!isHostRole) {
        sendToHost({ type: 'RELAY_HELLO', peerId: peerId });
        sendToHost({ type: 'REQ_SYNC' });
        sendProfile();
      }
      updateHeaderUI();
      if (relayHeartbeatTimer) clearInterval(relayHeartbeatTimer);
      relayHeartbeatTimer = setInterval(function () {
        if (generation !== relayGeneration || relayWs !== socket || socket.readyState !== 1) return;
        if (!state.isHost) sendToHost({ type: 'PING', t: Date.now() });
      }, CONFIG.heartbeatInterval);
    };

    socket.onmessage = function (event) {
      if (generation !== relayGeneration || relayWs !== socket) return;
      var frame;
      try { frame = JSON.parse(event.data); } catch (_) { return; }
      if (!frame) return;
      if (frame.left) {
        delete connections[frame.from];
        delete connectionTransports[frame.from];
        delete profiles[frame.from];
        if (!isHostRole && frame.from === roomId) { state.hostOnline = false; updateSyncStatus('Host disconnected', 'error'); }
        updatePeersListUI();
        updateHeaderUI();
        return;
      }
      if (!frame.p) return;
      var currentKey = isHostRole ? relayKeyB64 : peerRelayKey;
      openMsg(frame.p, currentKey, roomId).then(function (msg) {
        if (!msg || generation !== relayGeneration || relayWs !== socket) return;
        handleIncomingMessage(frame.from, msg, frame.transport || 'websocket');
      });
    };

    socket.onerror = function () {
      if (generation === relayGeneration) updateSyncStatus('Relay connection error', 'error');
    };

    socket.onclose = function () {
      if (generation !== relayGeneration || relayWs !== socket) return;
      state.relayConnected = false;
      state.hostOnline = null;
      if (relayStatusTimer) { clearInterval(relayStatusTimer); relayStatusTimer = null; }
      if (relayHeartbeatTimer) { clearInterval(relayHeartbeatTimer); relayHeartbeatTimer = null; }
      updateSyncStatus('Relay disconnected', 'error');
      updateHeaderUI();
      if (!manualDisconnect && state.sessionId) scheduleRelayReconnect(generation);
    };
  }

  function scheduleRelayReconnect(generation) {
    if (manualDisconnect || !state.sessionId || relayReconnectTimer) return;
    relayReconnectTimer = setTimeout(function () {
      relayReconnectTimer = null;
      if (manualDisconnect || !state.sessionId || generation !== relayGeneration) return;
      initRelayConnection(state.sessionId, state.myPeerId, state.isHost);
    }, 5000);
  }

  function sendToPeer(targetId, msg) {
    if (!relayWs || relayWs.readyState !== 1) return;
    var isHttpPeer = state.isHost && connectionTransports[targetId] === 'http';
    if (isHttpPeer) {
      // KOReader's mailbox can handle the core reading protocol, but not the
      // browser AES-GCM envelope or large app features such as file transfers.
      var coreTypes = ['PROFILE', 'SYNC', 'PAGE_CHANGE', 'PING', 'PONG', 'AUTH_REQUIRED', 'AUTH_FAIL', 'HOST_KICK', 'RELAY_CLOSE', 'DOC_OPEN', 'DOC_CLOSE'];
      if (coreTypes.indexOf(msg.type) < 0) return;
      relayWs.send(JSON.stringify({ to: targetId, p: { raw: JSON.stringify(msg) } }));
      return;
    }
    var currentKey = state.isHost ? relayKeyB64 : peerRelayKey;
    sealMsg(msg, currentKey, state.sessionId).then(function (env) {
      if (relayWs && relayWs.readyState === 1) {
        relayWs.send(JSON.stringify({ to: targetId, p: env }));
      }
    });
  }

  function sendToHost(msg) {
    if (state.isHost) return;
    sendToPeer(state.sessionId, msg);
  }

  function broadcast(msg) {
    if (!state.isHost) {
      sendToHost(msg);
      return;
    }
    for (var peer in connections) {
      if (connections[peer]) {
        sendToPeer(peer, msg);
      }
    }
  }

  function requestSessionPassword() {
    return new Promise(function (resolve) {
      var overlay = document.createElement('div');
      overlay.style.cssText = 'position:fixed;inset:0;z-index:10000;background:#fff;color:#000;display:flex;align-items:center;justify-content:center;padding:16px;border:3px solid #000;';
      overlay.innerHTML = '<div style="width:100%;max-width:340px;border:2px solid #000;padding:16px;background:#fff"><h3 style="margin:0 0 12px">Session password</h3><input id="coop-session-password" type="password" autocomplete="current-password" style="width:100%;margin-bottom:12px"><div style="display:flex;gap:8px;justify-content:flex-end"><button id="coop-password-cancel" class="btn">Cancel</button><button id="coop-password-submit" class="btn">Join</button></div></div>';
      document.body.appendChild(overlay);
      var input = overlay.querySelector('#coop-session-password');
      var done = function (value) { if (overlay.parentNode) overlay.parentNode.removeChild(overlay); resolve(value); };
      overlay.querySelector('#coop-password-cancel').onclick = function () { done(''); };
      overlay.querySelector('#coop-password-submit').onclick = function () { done(input.value || ''); };
      input.addEventListener('keydown', function (event) { if (event.key === 'Enter') done(input.value || ''); });
      try { input.focus(); } catch (_) {}
    });
  }

  // ==================== MESSAGE HANDLER ====================
  function handleIncomingMessage(senderId, msg, senderTransport) {
    if (!msg || !msg.type) return;

    if (msg.type === 'AUTH_REQUIRED' && !state.isHost) {
      requestSessionPassword().then(function (password) {
        if (!password) {
          updateSyncStatus('Password required — leaving session', 'error');
          var leave = document.getElementById('btn-disconnect-session');
          if (leave) leave.click();
          return;
        }
        hashPassword(password, msg.salt).then(function (hash) {
          if (hash) sendToHost({ type: 'AUTH', hash: hash });
        }).catch(function (error) {
          updateSyncStatus(error.message, 'error');
          var leave = document.getElementById('btn-disconnect-session');
          if (leave) leave.click();
        });
      });
      return;
    }
    if (msg.type === 'AUTH_FAIL') {
      updateSyncStatus('Incorrect session password', 'error');
      var leave = document.getElementById('btn-disconnect-session');
      if (leave) leave.click();
      return;
    }

    if (msg.type === 'RELAY_HELLO') {
      if (state.isHost) {
        connections[senderId] = true;
        connectionTransports[senderId] = senderTransport || 'websocket';
        // KOReader is an HTTP-only peer: give it the document/page metadata it
        // understands, and keep the richer annotations/chat/file path for the
        // browser GUI peers.
        sendToPeer(senderId, {
          type: 'PROFILE', peerId: state.myPeerId, name: state.myDisplayName
        });
        sendToPeer(senderId, {
          type: 'SYNC',
          state: {
            currentPage: state.currentPage,
            totalPages: state.totalPages,
            currentFilename: state.currentFilename,
            fileType: state.fileType,
            downloadAllowed: state.downloadAllowed
          }
        });
        sendToPeer(senderId, { type: 'PAGE_CHANGE', page: state.currentPage });
        if (connectionTransports[senderId] !== 'http') {
          sendToPeer(senderId, { type: 'ANNOT_ALL', all: annots });
          sendToPeer(senderId, { type: 'CHAT_HISTORY', messages: chatMessages.slice(-30) });
          if (docRawBytes && state.currentFilename) sendFileToPeer(senderId, state.currentFilename, docRawBytes);
        }
        updatePeersListUI();
        updateHeaderUI();
      }
      return;
    }

    if (msg.type === 'REQ_SYNC') {
      if (state.isHost) {
        sendToPeer(senderId, {
          type: 'SYNC',
          state: {
            currentPage: state.currentPage,
            totalPages: state.totalPages,
            currentFilename: state.currentFilename,
            fileType: state.fileType
          }
        });
      }
      return;
    }

    if (msg.type === 'SYNC') {
      if (state.isHost) return;
      var incoming = msg.state || {};
      state.totalPages = incoming.totalPages || state.totalPages;
      state.currentFilename = incoming.currentFilename || state.currentFilename;
      state.fileType = incoming.fileType || state.fileType;
      state.syncedPage = incoming.currentPage || 1;

      if (state.syncPageEnabled && !state.detached) {
        state.currentPage = state.syncedPage;
        if (!state.isBackground) {
          renderCurrentPage();
        }
      }
      if (state.syncDocEnabled && incoming.currentFilename && incoming.currentFilename !== state.currentFilename) {
        downloadDocFromRelay(incoming.currentFilename);
      }
      updateHeaderUI();
      return;
    }

    if (msg.type === 'PAGE_CHANGE') {
      var pg = parseInt(msg.page, 10);
      if (isNaN(pg)) return;
      state.syncedPage = pg;
      if (state.syncPageEnabled && !state.detached) {
        state.currentPage = pg;
        if (!state.isBackground) {
          renderCurrentPage();
        }
      }
      updateHeaderUI();
      if (state.isHost) broadcast(msg);
      return;
    }

    if (msg.type === 'DOC_OPEN') {
      if (state.syncDocEnabled && msg.filename && msg.filename !== state.currentFilename) {
        downloadDocFromRelay(msg.filename);
      }
      if (state.isHost) broadcast(msg);
      return;
    }

    if (msg.type === 'DOC_CLOSE') {
      if (state.syncDocEnabled) {
        state.currentFilename = '';
        docPages = paginateText(welcomeDoc);
        state.totalPages = docPages.length;
        state.currentPage = 1;
        pdfDoc = null;
        docRawBytes = null;
        if (!state.isBackground) {
          renderCurrentPage();
        }
        updateHeaderUI();
        updateSyncStatus('Host closed document', 'warning');
      }
      if (state.isHost) broadcast(msg);
      return;
    }

    if (msg.type === 'PAGE_INFO') {
      if (state.isHost) {
        profiles[senderId] = profiles[senderId] || {};
        profiles[senderId].page = msg.page;
        profiles[senderId].detached = msg.detached;
        updatePeersListUI();
      }
      return;
    }

    if (msg.type === 'PROFILE') {
      profiles[senderId] = {
        name: msg.name || 'Reader',
        avatar: msg.avatar || ''
      };
      updatePeersListUI();
      if (state.isHost) broadcast(msg);
      return;
    }

    if (msg.type === 'CHAT') {
      if (msg.msg) {
        addChatMessage(msg.msg);
      }
      if (state.isHost) broadcast(msg);
      return;
    }

    if (msg.type === 'CHAT_HISTORY') {
      if (Array.isArray(msg.messages)) {
        chatMessages = msg.messages;
        renderChatList();
      }
      return;
    }

    if (msg.type === 'ANNOT') {
      applyAnnotation(msg.op, msg.page, msg.item, msg.id);
      if (state.isHost) broadcast(msg);
      return;
    }

    if (msg.type === 'ANNOT_ALL') {
      annots = msg.all || {};
      renderAnnotations();
      return;
    }

    if (msg.type === 'VOICE_STATE') {
      speakingPeers[msg.peerId] = msg.on;
      updateVoiceIndicator();
      if (state.isHost) broadcast(msg);
      return;
    }

    if (msg.type === 'FILE_START') {
      incomingTransfer = {
        filename: msg.filename,
        totalSize: msg.totalSize,
        totalChunks: msg.totalChunks,
        chunks: new Array(msg.totalChunks),
        received: 0
      };
      updateSyncStatus('Receiving ' + msg.filename + '...', 'warning');
      return;
    }

    if (msg.type === 'FILE_CHUNK') {
      if (!incomingTransfer) return;
      var idx = msg.index;
      if (!incomingTransfer.chunks[idx]) {
        incomingTransfer.chunks[idx] = b64decode(msg.data);
        incomingTransfer.received++;
      }
      if (incomingTransfer.received % 16 === 0 || incomingTransfer.received === incomingTransfer.totalChunks) {
        sendToPeer(senderId, { type: 'FILE_ACK', received: incomingTransfer.received });
      }
      return;
    }

    if (msg.type === 'FILE_ACK') {
      if (outgoingTransfer) outgoingTransfer.acked = msg.received;
      return;
    }

    if (msg.type === 'FILE_END') {
      if (!incomingTransfer) return;
      var total = incomingTransfer.totalSize;
      var merged = new Uint8Array(total);
      var offset = 0;
      for (var c = 0; c < incomingTransfer.chunks.length; c++) {
        var chunk = incomingTransfer.chunks[c];
        if (chunk) {
          merged.set(chunk, offset);
          offset += chunk.length;
        }
      }
      var fname = incomingTransfer.filename;
      incomingTransfer = null;
      updateSyncStatus('Received ' + fname, 'success');
      loadDocumentFromBytes(merged.buffer, fname);
      return;
    }
  }

  // ==================== DOCUMENT PARSING & RENDERING ====================
  function paginateText(text, size) {
    size = size || CONFIG.pageChars;
    var pages = [];
    var lines = text.split(/\r?\n/);
    var cur = '';

    for (var i = 0; i < lines.length; i++) {
      var line = lines[i];
      while (line.length > size) {
        if (cur.trim()) pages.push(cur);
        cur = '';
        pages.push(line.slice(0, size));
        line = line.slice(size);
      }
      if (cur && (cur.length + line.length + 1) > size) {
        pages.push(cur);
        cur = '';
      }
      cur += line + '\n';
    }
    if (cur.trim()) pages.push(cur);
    return pages.length ? pages : ['(Empty document)'];
  }

  function uploadDocToRelay(filename, arrayBuffer) {
    if (!state.sessionId || !arrayBuffer) return;
    var relayHttp = CONFIG.defaultRelay.replace(/^ws:\/\//i, 'http://').replace(/^wss:\/\//i, 'https://');
    updateSyncStatus('Sharing ' + filename + '…', 'warning');

    var url = relayHttp + '/room/' + encodeURIComponent(state.sessionId) + '/doc?filename=' + encodeURIComponent(filename);
    try {
      var xhr = new XMLHttpRequest();
      xhr.open('POST', url, true);
      xhr.setRequestHeader('Content-Type', 'application/octet-stream');
      xhr.onload = function () {
        if (xhr.status >= 200 && xhr.status < 300) {
          updateSyncStatus('Shared ' + filename, 'success');
          broadcast({ type: 'DOC_OPEN', filename: filename });
        } else {
          updateSyncStatus('Upload failed (HTTP ' + xhr.status + ')', 'error');
        }
      };
      xhr.onerror = function () {
        updateSyncStatus('Upload network error', 'error');
      };
      xhr.send(arrayBuffer);
    } catch (e) {
      updateSyncStatus('Upload failed: ' + e.message, 'error');
    }
  }

  function downloadDocFromRelay(filename) {
    if (!state.sessionId || !filename || state.isDownloadingDoc || filename === state.currentFilename) return;
    if (!state.syncDocEnabled) return;
    state.isDownloadingDoc = true;
    updateSyncStatus('Downloading ' + filename + '…', 'warning');
    var relayHttp = CONFIG.defaultRelay.replace(/^ws:\/\//i, 'http://').replace(/^wss:\/\//i, 'https://');
    var url = relayHttp + '/room/' + encodeURIComponent(state.sessionId) + '/doc';

    var xhr = new XMLHttpRequest();
    xhr.open('GET', url, true);
    xhr.responseType = 'arraybuffer';
    xhr.onload = function () {
      state.isDownloadingDoc = false;
      if (xhr.status >= 200 && xhr.status < 300 && xhr.response && xhr.response.byteLength > 0) {
        state.lastDownloadedDoc = filename;
        loadDocumentFromBytes(xhr.response, filename, true);
        updateSyncStatus('Opened ' + filename, 'success');
      } else {
        updateSyncStatus('Failed to download ' + filename, 'error');
      }
    };
    xhr.onerror = function () {
      state.isDownloadingDoc = false;
      updateSyncStatus('Doc download network error', 'error');
    };
    xhr.send();
  }

  function closeCurrentDocument() {
    state.currentFilename = '';
    docPages = paginateText(welcomeDoc);
    state.totalPages = docPages.length;
    state.currentPage = 1;
    pdfDoc = null;
    docRawBytes = null;
    renderCurrentPage();
    updateHeaderUI();
    updateSyncStatus('Document closed', 'warning');
    if (state.isHost && state.syncDocEnabled) {
      broadcast({ type: 'DOC_CLOSE' });
    }
  }

  function loadDocumentFromBytes(arrayBuffer, filename, fromRemote) {
    docRawBytes = arrayBuffer;
    state.currentFilename = filename;
    var ext = filename.split('.').pop().toLowerCase();

    if (ext === 'pdf') {
      state.fileType = 'pdf';
      renderPdfDocument(arrayBuffer, fromRemote);
    } else {
      state.fileType = 'text';
      var text = '';
      try {
        var decoder = new TextDecoder('utf-8');
        text = decoder.decode(new Uint8Array(arrayBuffer));
      } catch (_) {
        // Fallback for older JS engines
        var u8 = new Uint8Array(arrayBuffer);
        for (var i = 0; i < u8.length; i++) {
          text += String.fromCharCode(u8[i]);
        }
      }

      // EPUB / MOBI / TXT parsing
      if (ext === 'epub' || ext === 'mobi' || ext === 'azw3') {
        text = extractEpubOrMobiText(text);
      }

      docPages = paginateText(text);
      state.totalPages = docPages.length;
      state.currentPage = 1;
      renderCurrentPage();
      updateHeaderUI();

      if (state.isHost) {
        broadcast({
          type: 'SYNC',
          state: {
            currentPage: state.currentPage,
            totalPages: state.totalPages,
            currentFilename: state.currentFilename,
            fileType: state.fileType
          }
        });
      }

      if (!fromRemote && state.sessionId && state.syncDocEnabled && (state.isHost || state.peerUploadsAllowed)) {
        uploadDocToRelay(filename, arrayBuffer);
      }
    }
  }

  function extractEpubOrMobiText(raw) {
    // Strip XML/HTML tags and extract clean text sections
    var clean = raw.replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
                   .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
                   .replace(/<\/?[a-z0-9]+[^>]*>/gi, '\n')
                   .replace(/&nbsp;/g, ' ')
                   .replace(/&amp;/g, '&')
                   .replace(/&lt;/g, '<')
                   .replace(/&gt;/g, '>');
    return clean.replace(/\n{3,}/g, '\n\n').trim();
  }

  function renderPdfDocument(arrayBuffer, fromRemote) {
    if (!window.pdfjsLib) {
      el.textViewport.innerText = 'PDF.js library is loading or not available. Please install pdf.min.js locally or connect to Wi-Fi.';
      el.textViewport.style.display = 'block';
      el.pdfCanvas.style.display = 'none';
      return;
    }

    pdfjsLib.getDocument({ data: arrayBuffer }).promise.then(function (pdf) {
      pdfDoc = pdf;
      state.totalPages = pdf.numPages;
      state.currentPage = 1;
      renderCurrentPage();
      updateHeaderUI();

      if (state.isHost) {
        broadcast({
          type: 'SYNC',
          state: {
            currentPage: state.currentPage,
            totalPages: state.totalPages,
            currentFilename: state.currentFilename,
            fileType: 'pdf'
          }
        });
      }

      if (!fromRemote && state.sessionId && state.syncDocEnabled && (state.isHost || state.peerUploadsAllowed)) {
        uploadDocToRelay(state.currentFilename, arrayBuffer);
      }
    }).catch(function (err) {
      el.textViewport.innerText = 'Failed to load PDF: ' + err.message;
      el.textViewport.style.display = 'block';
      el.pdfCanvas.style.display = 'none';
    });
  }

  function renderCurrentPage() {
    if (state.fileType === 'pdf' && pdfDoc) {
      el.textViewport.style.display = 'none';
      el.pdfCanvas.style.display = 'block';
      if (pdfRendering) return;
      pdfRendering = true;

      pdfDoc.getPage(state.currentPage).then(function (page) {
        var viewport = page.getViewport({ scale: 1.2 });
        var canvas = el.pdfCanvas;
        var ctx = canvas.getContext('2d');
        canvas.width = viewport.width;
        canvas.height = viewport.height;

        var renderContext = {
          canvasContext: ctx,
          viewport: viewport
        };
        page.render(renderContext).promise.then(function () {
          pdfRendering = false;
          renderAnnotations();
        });
      });
    } else {
      el.pdfCanvas.style.display = 'none';
      el.textViewport.style.display = 'block';
      var text = docPages[state.currentPage - 1] || '(Empty page)';
      el.textViewport.innerText = text;
      renderAnnotations();
    }

    el.pageIndicator.innerText = state.currentPage + ' / ' + state.totalPages;
    reportPageToHost();
  }

  function changePage(delta) {
    var next = state.currentPage + delta;
    if (next < 1 || next > state.totalPages) return;
    state.currentPage = next;
    renderCurrentPage();

    if (state.syncPageEnabled) {
      if (state.isHost) {
        broadcast({ type: 'PAGE_CHANGE', page: state.currentPage });
      } else {
        reportPageToHost();
      }
    }
  }

  function reportPageToHost() {
    if (!state.isHost) {
      sendToHost({
        type: 'PAGE_INFO',
        page: state.currentPage,
        detached: state.detached
      });
    }
  }

  function toggleDetach() {
    state.detached = !state.detached;
    if (!state.detached) {
      state.currentPage = state.syncedPage;
      renderCurrentPage();
    }
    updateHeaderUI();
    reportPageToHost();
  }

  // ==================== ANNOTATIONS & NOTES ====================
  function applyAnnotation(op, page, item, id) {
    page = +page;
    annots[page] = annots[page] || [];
    if (op === 'add' && item) {
      annots[page].push(item);
    } else if (op === 'del' && id) {
      annots[page] = annots[page].filter(function (a) { return a.id !== id; });
    }
    if (state.currentPage === page) {
      renderAnnotations();
    }
  }

  function addNoteAt(x, y, text) {
    var note = {
      id: generateId('note_'),
      type: 'note',
      x: x,
      y: y,
      text: text,
      by: state.myPeerId,
      name: state.myDisplayName,
      createdAt: Date.now()
    };
    applyAnnotation('add', state.currentPage, note);
    broadcast({
      type: 'ANNOT',
      op: 'add',
      page: state.currentPage,
      item: note
    });
  }

  function renderAnnotations() {
    var list = annots[state.currentPage] || [];
    var canvas = el.annotCanvas;
    if (!canvas) return;
    var ctx = canvas.getContext('2d');
    canvas.width = el.renderContainer.clientWidth;
    canvas.height = el.renderContainer.clientHeight;
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    for (var i = 0; i < list.length; i++) {
      var item = list[i];
      var px = item.x * canvas.width;
      var py = item.y * canvas.height;

      // Draw high contrast E-Ink marker
      ctx.fillStyle = '#000000';
      ctx.beginPath();
      ctx.arc(px, py, 6, 0, Math.PI * 2);
      ctx.fill();

      ctx.fillStyle = '#000000';
      ctx.font = 'bold 11px sans-serif';
      ctx.fillText('[' + (i + 1) + '] ' + (item.name || 'Note'), px + 10, py + 4);
    }
  }

  // ==================== CHAT ====================
  function addChatMessage(msg) {
    chatMessages.push(msg);
    renderChatList();
  }

  function renderChatList() {
    if (!el.chatList) return;
    el.chatList.innerHTML = '';
    for (var i = 0; i < chatMessages.length; i++) {
      var m = chatMessages[i];
      var div = document.createElement('div');
      div.className = 'chat-bubble' + (m.from === state.myPeerId ? ' own' : '');
      div.innerHTML = '<div class="chat-author">' + escapeHtml(m.name || 'Reader') + '</div>' +
                      '<div class="chat-text">' + escapeHtml(m.text || '') + '</div>';
      el.chatList.appendChild(div);
    }
    el.chatList.scrollTop = el.chatList.scrollHeight;
  }

  function sendChatMessage() {
    var text = (el.chatInput.value || '').trim();
    if (!text) return;
    el.chatInput.value = '';

    var msg = {
      from: state.myPeerId,
      name: state.myDisplayName,
      text: text,
      timestamp: Date.now()
    };
    addChatMessage(msg);
    broadcast({ type: 'CHAT', msg: msg });
  }

  function escapeHtml(str) {
    return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  // ==================== KINDLE HARDWARE & DAEMON ====================
  function triggerEipsRefresh() {
    // 1. Try local daemon API
    fetch(CONFIG.daemonApi + '/api/eips-refresh')
      .then(function (res) { return res.json(); })
      .catch(function () {
        // Fallback: Rapid pure-JS/CSS invert flash to clear e-ink ghosting
        var flash = document.createElement('div');
        flash.className = 'eink-flash';
        document.body.appendChild(flash);
        setTimeout(function () {
          document.body.removeChild(flash);
        }, 120);
      });
  }

  function pollKindleStatus() {
    fetch(CONFIG.daemonApi + '/api/status')
      .then(function (res) { return res.json(); })
      .then(function (data) {
        if (data.battery !== null && data.battery !== undefined) {
          state.battery = data.battery;
          el.batteryStatus.innerText = '🔋 ' + data.battery + '%';
        }
      }).catch(function () {});
  }

  function fetchLocalDocuments() {
    var listContainer = document.getElementById('local-doc-list');
    if (!listContainer) return;
    listContainer.innerHTML = '<div style="padding:10px">Scanning /mnt/us/documents...</div>';

    fetch(CONFIG.daemonApi + '/api/documents')
      .then(function (res) { return res.json(); })
      .then(function (data) {
        if (!data.ok || !data.documents.length) {
          listContainer.innerHTML = '<div style="padding:10px">No documents found in /mnt/us/documents. Transfer books via USB or join a host session.</div>';
          return;
        }
        listContainer.innerHTML = '';
        var ul = document.createElement('ul');
        ul.className = 'item-list';

        data.documents.forEach(function (doc) {
          var li = document.createElement('li');
          li.className = 'item-row';
          li.innerHTML = '<div><strong>' + escapeHtml(doc.name) + '</strong><br><small>' + (doc.size / 1024).toFixed(0) + ' KB | ' + doc.ext.toUpperCase() + '</small></div>' +
                         '<button class="btn btn-sm">Open</button>';
          li.onclick = function () {
            openDocumentFromDaemon(doc.path, doc.name);
            closeModals();
          };
          ul.appendChild(li);
        });
        listContainer.appendChild(ul);
      }).catch(function (err) {
        listContainer.innerHTML = '<div style="padding:10px">Daemon not detected. Please upload file using standard file picker below.</div>';
      });
  }

  function openDocumentFromDaemon(fullPath, filename) {
    updateSyncStatus('Loading ' + filename + '...', 'warning');
    fetch(CONFIG.daemonApi + '/api/open-doc?path=' + encodeURIComponent(fullPath))
      .then(function (res) { return res.arrayBuffer(); })
      .then(function (buf) {
        loadDocumentFromBytes(buf, filename, false);
        updateSyncStatus('Loaded', 'success');
      }).catch(function (err) {
        updateSyncStatus('Failed to load: ' + err.message, 'error');
      });
  }

  // ==================== UI HELPERS & MODALS ====================
  function updateHeaderUI() {
    if (el.docTitle) el.docTitle.innerText = state.currentFilename || 'Coop Reader';
    if (el.pageIndicator) el.pageIndicator.innerText = state.currentPage + ' / ' + state.totalPages;
    if (el.btnCloseDoc) el.btnCloseDoc.style.display = state.currentFilename ? 'inline-flex' : 'none';
    updateSyncControlsUI();

    var activeBox = document.getElementById('session-active-box');
    var activeInfo = document.getElementById('session-active-info');
    if (activeBox) activeBox.style.display = state.sessionId ? 'block' : 'none';
    var createBox = document.getElementById('session-create-box');
    var joinBox = document.getElementById('session-join-box');
    if (createBox) createBox.style.display = state.sessionId ? 'none' : '';
    if (joinBox) joinBox.style.display = state.sessionId ? 'none' : '';
    if (activeInfo && state.sessionId) {
      var role = state.isHost ? 'HOST' : 'GUEST';
      var relay = state.relayConnected ? 'Connected' : 'Reconnecting / not connected';
      var peerCount = Object.keys(connections).length;
      activeInfo.textContent = role + ' · ' + relay + '\nRoom: ' + state.sessionId +
        '\nPeers: ' + peerCount + '\nPage: ' + state.currentPage +
        (state.isHost ? ('\nPIN: ' + (state.pin || 'Unavailable — share full code')) : ('\nHost: ' + ((profiles[state.sessionId] && profiles[state.sessionId].name) || state.sessionId) + '\nHost status: ' + (state.hostOnline === false ? 'offline' : (state.hostOnline === true ? 'online' : 'checking'))));
    }

    if (state.isHost) {
      el.syncStatus.innerHTML = '<span class="kindle-badge inverted">HOST</span>' +
        (state.pin ? ' PIN: ' + escapeHtml(state.pin) : ' · ' + (state.relayConnected ? 'Relay connected' : 'Relay offline'));
      el.btnSync.style.display = 'none';
    } else if (!state.syncPageEnabled) {
      el.syncStatus.innerHTML = '<span class="kindle-badge inverted">PAGE SYNC OFF</span>';
      el.btnSync.style.display = 'inline-flex';
    } else if (state.detached) {
      el.syncStatus.innerHTML = '<span class="kindle-badge inverted">DETACHED</span> Host: p.' + state.syncedPage;
      el.btnSync.style.display = 'inline-flex';
    } else if (state.sessionId) {
      el.syncStatus.innerHTML = '<span class="kindle-badge">' + (state.relayConnected ? 'SYNCED' : 'RECONNECTING') + '</span>';
      el.btnSync.style.display = 'none';
    } else {
      el.syncStatus.innerHTML = '<span class="kindle-badge">SOLO</span>';
      el.btnSync.style.display = 'none';
    }
  }

  function updateSyncStatus(text, type) {
    if (!el.syncStatus) return;
    var cls = type === 'error' ? 'inverted' : '';
    el.syncStatus.innerHTML = '<span class="kindle-badge ' + cls + '">' + escapeHtml(text) + '</span>';
  }

  function updateVoiceIndicator() {
    var speakers = [];
    for (var p in speakingPeers) {
      if (speakingPeers[p]) {
        var name = (profiles[p] && profiles[p].name) || p.slice(0, 5);
        speakers.push(name);
      }
    }
    if (speakers.length > 0) {
      el.voiceIndicator.style.display = 'inline-flex';
      el.voiceIndicator.innerText = '🎤 Speaking: ' + speakers.join(', ');
    } else {
      el.voiceIndicator.style.display = 'none';
    }
  }

  function updatePeersListUI() {
    var container = document.getElementById('peers-list-container');
    if (!container) return;
    var html = '<ul class="item-list">';
    html += '<li class="item-row"><div><strong>' + escapeHtml(state.myDisplayName) + ' (You)</strong></div><span class="kindle-badge">' + (state.isHost ? 'Host' : 'Page ' + state.currentPage) + '</span></li>';

    for (var pid in profiles) {
      var p = profiles[pid];
      html += '<li class="item-row"><div><strong>' + escapeHtml(p.name || pid) + '</strong>' +
              (p.detached ? '<br><small>Reading on their own</small>' : '') + '</div>' +
              '<span class="kindle-badge">Page ' + (p.page || 1) + '</span></li>';
    }
    html += '</ul>';
    container.innerHTML = html;
  }

  function closeModals() {
    var modals = document.querySelectorAll('.kindle-modal-overlay');
    for (var i = 0; i < modals.length; i++) {
      modals[i].classList.remove('open');
    }
  }

  function openModal(id) {
    closeModals();
    var modal = document.getElementById(id);
    if (modal) {
      modal.classList.add('open');
      if (id === 'modal-session') {
        var activeBox = document.getElementById('session-active-box');
        var activeInfo = document.getElementById('session-active-info');
        if (state.sessionId) {
          activeBox.style.display = 'block';
          var peerCount = Object.keys(connections).length;
          activeInfo.innerHTML = '<strong>Status:</strong> ' + (state.isHost ? 'HOSTING' : 'JOINED') + '<br>' +
            '<strong>Relay:</strong> ' + (state.relayConnected ? 'Connected' : 'Reconnecting / offline') + '<br>' +
            '<strong>Room Code:</strong> ' + escapeHtml(state.sessionId) + '<br>' +
            '<strong>Host:</strong> ' + escapeHtml(state.isHost ? state.myDisplayName : state.sessionId) + '<br>' +
            '<strong>Peers:</strong> ' + peerCount + '<br>' +
            '<strong>Page:</strong> ' + state.currentPage + ' / ' + state.totalPages + '<br>' +
            (state.isHost ? '<strong>Kindle PIN:</strong> ' + (state.pin ? escapeHtml(state.pin) : 'Unavailable — share full room code') : '');
        } else {
          activeBox.style.display = 'none';
        }
      }
    }
  }

  function sendProfile() {
    broadcast({
      type: 'PROFILE',
      peerId: state.myPeerId,
      name: state.myDisplayName
    });
  }

  // ==================== EVENT BINDINGS ====================
  function bindEvents() {
    // Kindle Hardware and Keyboard page buttons
    window.addEventListener('keydown', function (e) {
      if (e.key === 'ArrowLeft' || e.key === 'PageUp' || e.keyCode === 37 || e.keyCode === 33) {
        changePage(-1);
      } else if (e.key === 'ArrowRight' || e.key === 'PageDown' || e.keyCode === 39 || e.keyCode === 34) {
        changePage(1);
      }
    });

    // Touch Zones
    document.getElementById('zone-prev').addEventListener('click', function () { changePage(-1); });
    document.getElementById('zone-next').addEventListener('click', function () { changePage(1); });
    document.getElementById('zone-menu').addEventListener('click', function () {
      var header = document.querySelector('.kindle-bar');
      var footer = document.querySelector('.kindle-footer');
      if (header.style.display === 'none') {
        header.style.display = 'flex';
        footer.style.display = 'flex';
      } else {
        header.style.display = 'none';
        footer.style.display = 'none';
      }
    });

    // Onscreen Navigation
    el.btnPrev.addEventListener('click', function () { changePage(-1); });
    el.btnNext.addEventListener('click', function () { changePage(1); });
    el.btnSync.addEventListener('click', toggleDetach);
    el.btnRefresh.addEventListener('click', triggerEipsRefresh);

    // Font Sizing
    document.getElementById('btn-font-smaller').addEventListener('click', function () {
      var scales = ['sm', 'md', 'lg', 'xl'];
      var idx = scales.indexOf(state.fontScale);
      if (idx > 0) {
        document.body.classList.remove('font-scale-' + state.fontScale);
        state.fontScale = scales[idx - 1];
        document.body.classList.add('font-scale-' + state.fontScale);
      }
    });
    document.getElementById('btn-font-larger').addEventListener('click', function () {
      var scales = ['sm', 'md', 'lg', 'xl'];
      var idx = scales.indexOf(state.fontScale);
      if (idx < scales.length - 1) {
        document.body.classList.remove('font-scale-' + state.fontScale);
        state.fontScale = scales[idx + 1];
        document.body.classList.add('font-scale-' + state.fontScale);
      }
    });

    // Session creation/joining must never be blocked by a timed donation modal.
    function showBmcModal() { return; }
    function closeBmcModal() {
      var modal = document.getElementById('modal-bmc');
      if (modal) modal.classList.remove('open');
    }
    window.closeBmcModal = closeBmcModal;

    // Session Host / Join Actions
    function connectToRoom(roomId, key) {
      manualDisconnect = false;
      state.sessionId = roomId;
      peerRelayKey = key || '';
      relayToken = generateId('tok');
      state.isHost = false;
      state.relayConnected = false;
      state.hostOnline = null;
      state.myPeerId = generateId('kpeer');
      state.pin = '';
      state.detached = false;
      connections = {};
      connectionTransports = {};
      profiles = {};
      document.getElementById('session-active-box').style.display = 'block';
      initRelayConnection(state.sessionId, state.myPeerId, false);
      recordLocalSession(state.sessionId);
      updateHeaderUI();
      updatePeersListUI();
    }

    document.getElementById('btn-host-session').addEventListener('click', function () {
      manualDisconnect = false;
      state.isHost = true;
      state.sessionId = generateId('kroom');
      state.relayConnected = false;
      state.hostOnline = null;
      state.pin = '';
      state.detached = false;
      var keyBytes = new Uint8Array(32);
      if (window.crypto && window.crypto.getRandomValues) window.crypto.getRandomValues(keyBytes);
      relayKeyB64 = b64u(keyBytes);
      state.myPeerId = state.sessionId;
      relayToken = generateId('tok');
      connections = {};
      connectionTransports = {};
      profiles = {};

      initRelayConnection(state.sessionId, state.myPeerId, true);
      recordLocalSession(state.sessionId);
      document.getElementById('session-display-code').innerText = state.sessionId + '.' + relayKeyB64;
      document.getElementById('session-info-box').style.display = 'block';
      document.getElementById('session-pin-box').style.display = 'block';
      document.getElementById('session-display-pin').innerText = 'Registering…';
      document.getElementById('session-create-box').style.display = 'none';
      document.getElementById('session-join-box').style.display = 'none';
      document.getElementById('session-active-box').style.display = 'block';
      updateHeaderUI();
    });

    var btnDisconnect = document.getElementById('btn-disconnect-session');
    if (btnDisconnect) {
      btnDisconnect.addEventListener('click', function () {
        manualDisconnect = true;
        relayGeneration++;
        if (relayReconnectTimer) { clearTimeout(relayReconnectTimer); relayReconnectTimer = null; }
        if (relayHeartbeatTimer) { clearInterval(relayHeartbeatTimer); relayHeartbeatTimer = null; }
        if (relayStatusTimer) { clearInterval(relayStatusTimer); relayStatusTimer = null; }
        if (relayWs) {
          var oldSocket = relayWs;
          relayWs = null;
          oldSocket.onclose = null;
          oldSocket.onerror = null;
          try { oldSocket.close(); } catch (_) {}
        }
        clearLocalSession();
        state.sessionId = '';
        state.isHost = false;
        state.myPeerId = '';
        state.pin = '';
        state.relayConnected = false;
        state.hostOnline = null;
        state.detached = false;
        peerRelayKey = '';
        relayKeyB64 = '';
        relayToken = '';
        connections = {};
        connectionTransports = {};
        profiles = {};
        document.getElementById('session-pin-box').style.display = 'none';
        document.getElementById('session-info-box').style.display = 'none';
        document.getElementById('session-active-box').style.display = 'none';
        document.getElementById('session-create-box').style.display = '';
        document.getElementById('session-join-box').style.display = '';
        updateHeaderUI();
        updatePeersListUI();
        closeModals();
        updateSyncStatus('Left session', 'success');
      });
    }

    document.getElementById('btn-join-session').addEventListener('click', function () {
      var code = (document.getElementById('input-join-code').value || '').trim();
      if (!code) return;
      var isShortPin = /^\d{3,8}$/.test(code);
      if (isShortPin) {
        updateSyncStatus('Resolving PIN ' + code + '...', 'warning');
        var relayHttp = CONFIG.defaultRelay.replace(/^ws:\/\//i, 'http://').replace(/^wss:\/\//i, 'https://');
        fetch(relayHttp + '/pin/' + encodeURIComponent(code))
          .then(function (res) {
            if (!res.ok) throw new Error('PIN not found on relay (HTTP ' + res.status + ')');
            return res.json();
          })
          .then(function (data) {
            if (!data || !data.ok || !data.room) throw new Error('Relay did not return a room for this PIN');
            if (data.key && !/^[\w-]{43}$/.test(data.key)) throw new Error('Relay returned an invalid room key');
            connectToRoom(data.room, data.key || '');
            closeModals();
          })
          .catch(function (err) {
            updateSyncStatus(err.message + '. Check the PIN and relay URL.', 'error');
          });
      } else {
        var parts = code.split('.');
        if (parts.length > 2 || !/^[\w-]{1,64}$/.test(parts[0])) {
          updateSyncStatus('Invalid room code', 'error');
          return;
        }
        if (parts[1] && !/^[\w-]{43}$/.test(parts[1])) {
          updateSyncStatus('Invalid room encryption key', 'error');
          return;
        }
        connectToRoom(parts[0], parts[1] || '');
        closeModals();
      }
    });

    // Document Picker Trigger
    document.getElementById('btn-open-doc-modal').addEventListener('click', function () {
      openModal('modal-doc');
      fetchLocalDocuments();
    });

    // File Input fallback
    document.getElementById('file-picker-input').addEventListener('change', function (e) {
      var file = e.target.files[0];
      if (!file) return;
      var reader = new FileReader();
      reader.onload = function (ev) {
        loadDocumentFromBytes(ev.target.result, file.name, false);
        closeModals();
      };
      reader.readAsArrayBuffer(file);
    });

    // Sync Toggles in Sub-bar and Modal
    if (el.btnToggleDocSync) {
      el.btnToggleDocSync.addEventListener('click', function () {
        setDocSync(!state.syncDocEnabled);
      });
    }
    if (el.btnTogglePageSync) {
      el.btnTogglePageSync.addEventListener('click', function () {
        setPageSync(!state.syncPageEnabled);
      });
    }
    if (el.chkSyncDoc) {
      el.chkSyncDoc.addEventListener('change', function () {
        setDocSync(el.chkSyncDoc.checked);
      });
    }
    if (el.chkSyncPage) {
      el.chkSyncPage.addEventListener('change', function () {
        setPageSync(el.chkSyncPage.checked);
      });
    }
    if (el.chkSyncBg) {
      el.chkSyncBg.addEventListener('change', function () {
        setBackgroundSync(el.chkSyncBg.checked);
      });
    }
    if (el.btnCloseDoc) {
      el.btnCloseDoc.addEventListener('click', function () {
        closeCurrentDocument();
        closeModals();
      });
    }

    // Page Visibility & Background Hooks
    document.addEventListener('visibilitychange', function () {
      if (document.hidden) onBackground();
      else onForeground();
    });
    window.addEventListener('blur', function () {
      state.isBackground = true;
    });
    window.addEventListener('focus', function () {
      onForeground();
    });
    window.addEventListener('pageshow', function () {
      onForeground();
    });

    // Chat
    document.getElementById('btn-open-chat').addEventListener('click', function () { openModal('modal-chat'); });
    document.getElementById('btn-send-chat').addEventListener('click', sendChatMessage);
    el.chatInput.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') sendChatMessage();
    });

    // Peers Modal
    document.getElementById('btn-open-peers').addEventListener('click', function () {
      openModal('modal-peers');
      updatePeersListUI();
    });

    // Close buttons on all modals
    var closeButtons = document.querySelectorAll('.btn-close-modal');
    for (var i = 0; i < closeButtons.length; i++) {
      closeButtons[i].addEventListener('click', closeModals);
    }
  }

  // ==================== INITIALIZATION ====================
  function init() {
    try {
      sessionStorage.removeItem('coop_bmc_donated');
      localStorage.removeItem('coop_bmc_donated');
    } catch (_) {}
    cacheElements();
    state.myPeerId = generateId('k');
    document.body.classList.add('font-scale-' + state.fontScale);

    bindEvents();
    updateSyncControlsUI();
    pollKindleStatus();
    setInterval(pollKindleStatus, 30000);

    // Initial placeholder document
    docPages = paginateText(welcomeDoc);
    state.totalPages = docPages.length;
    renderCurrentPage();
  }

  window.addEventListener('DOMContentLoaded', init);
})();

