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
    currentPage: 1,
    totalPages: 1,
    syncedPage: 1,
    currentFilename: '',
    fileType: 'text', // 'text' | 'pdf'
    fontScale: 'md',
    downloadAllowed: true,
    peerUploadsAllowed: false,
    peerAnnotateAllowed: true,
    battery: null
  };

  var connections = {};
  var relayWs = null;
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
    if (!window.crypto || !window.crypto.subtle) return Promise.resolve(pass);
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
  function initRelayConnection(roomId, peerId, isHostRole) {
    if (relayWs) {
      try { relayWs.close(); } catch (_) {}
      relayWs = null;
    }

    var wsUrl = CONFIG.defaultRelay + '/room/' + encodeURIComponent(roomId) + '?id=' + encodeURIComponent(peerId) + '&t=' + generateId('tok');
    updateSyncStatus('Connecting to relay...', 'warning');

    try {
      relayWs = new WebSocket(wsUrl);
    } catch (e) {
      updateSyncStatus('Relay error: ' + e.message, 'error');
      return;
    }

    relayWs.onopen = function () {
      updateSyncStatus(isHostRole ? 'Hosting' : 'Connected', 'success');
      if (!isHostRole) {
        // Peer sends hello to host
        sendToHost({ type: 'RELAY_HELLO', peerId: peerId });
        sendToHost({ type: 'REQ_SYNC' });
        sendProfile();
      }
    };

    relayWs.onmessage = function (event) {
      var frame;
      try { frame = JSON.parse(event.data); } catch (_) { return; }
      if (!frame || !frame.p) return;

      var currentKey = isHostRole ? relayKeyB64 : peerRelayKey;
      openMsg(frame.p, currentKey, roomId).then(function (msg) {
        if (!msg) return;
        handleIncomingMessage(frame.from, msg);
      });
    };

    relayWs.onclose = function () {
      updateSyncStatus('Relay disconnected', 'error');
      setTimeout(function () {
        if (state.sessionId) initRelayConnection(state.sessionId, state.myPeerId, state.isHost);
      }, 5000);
    };

    // Heartbeat
    setInterval(function () {
      if (relayWs && relayWs.readyState === 1) {
        if (!state.isHost) {
          sendToHost({ type: 'PING' });
        }
      }
    }, CONFIG.heartbeatInterval);
  }

  function sendToPeer(targetId, msg) {
    if (!relayWs || relayWs.readyState !== 1) return;
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

  // ==================== MESSAGE HANDLER ====================
  function handleIncomingMessage(senderId, msg) {
    if (!msg || !msg.type) return;

    if (msg.type === 'RELAY_HELLO') {
      if (state.isHost) {
        connections[senderId] = true;
        // Send current session state to new joiner
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
        sendToPeer(senderId, { type: 'ANNOT_ALL', all: annots });
        sendToPeer(senderId, { type: 'CHAT_HISTORY', messages: chatMessages.slice(-30) });
        // If we have raw file cached and user needs it, send it
        if (docRawBytes && state.currentFilename) {
          sendFileToPeer(senderId, state.currentFilename, docRawBytes);
        }
        updatePeersListUI();
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

      if (!state.detached) {
        state.currentPage = state.syncedPage;
        renderCurrentPage();
      }
      updateHeaderUI();
      return;
    }

    if (msg.type === 'PAGE_CHANGE') {
      var pg = parseInt(msg.page, 10);
      if (isNaN(pg)) return;
      state.syncedPage = pg;
      if (!state.detached) {
        state.currentPage = pg;
        renderCurrentPage();
      }
      updateHeaderUI();
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

  function loadDocumentFromBytes(arrayBuffer, filename) {
    docRawBytes = arrayBuffer;
    state.currentFilename = filename;
    var ext = filename.split('.').pop().toLowerCase();

    if (ext === 'pdf') {
      state.fileType = 'pdf';
      renderPdfDocument(arrayBuffer);
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

  function renderPdfDocument(arrayBuffer) {
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

    if (state.isHost) {
      broadcast({ type: 'PAGE_CHANGE', page: state.currentPage });
    } else {
      reportPageToHost();
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
        loadDocumentFromBytes(buf, filename);
        updateSyncStatus('Loaded', 'success');
      }).catch(function (err) {
        updateSyncStatus('Failed to load: ' + err.message, 'error');
      });
  }

  // ==================== UI HELPERS & MODALS ====================
  function updateHeaderUI() {
    el.docTitle.innerText = state.currentFilename || 'Coop Reader';
    el.pageIndicator.innerText = state.currentPage + ' / ' + state.totalPages;

    if (state.isHost) {
      el.syncStatus.innerHTML = '<span class="kindle-badge inverted">HOST</span>' + (state.pin ? ' PIN: ' + state.pin : '');
      el.btnSync.style.display = 'none';
    } else if (state.detached) {
      el.syncStatus.innerHTML = '<span class="kindle-badge inverted">DETACHED</span> Host: p.' + state.syncedPage;
      el.btnSync.style.display = 'inline-flex';
    } else if (state.sessionId) {
      el.syncStatus.innerHTML = '<span class="kindle-badge">SYNCED</span>';
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
          activeInfo.innerHTML = '<strong>Status:</strong> ' + (state.isHost ? 'HOSTING' : 'FOLLOWING') + '<br>' +
            (state.pin ? '<strong>Kindle PIN:</strong> <span style="font-size:1.3rem; font-weight:900;">' + state.pin + '</span><br>' : '') +
            '<strong>Room Code:</strong> ' + escapeHtml(state.sessionId);
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

    // ==================== BUY ME A COFFEE (BMC) ====================
    var bmcTimer = null;
    var bmcSecondsRemaining = 0;
    var bmcHalftime = 0;

    function showBmcModal(mode) {
      try {
        if (sessionStorage.getItem('coop_bmc_donated') === 'true') return;
      } catch (_) {}

      var isHostCreate = (mode === 'create' || mode === 'host');
      var totalSeconds = isHostCreate ? 120 : 60;
      bmcHalftime = isHostCreate ? 60 : 30;
      bmcSecondsRemaining = totalSeconds;

      var modal = document.getElementById('modal-bmc');
      var closeBtn = document.getElementById('bmc-modal-close');
      var statusEl = document.getElementById('bmc-timer-status');
      var titleEl = document.getElementById('bmc-modal-title');
      if (!modal) return;

      if (titleEl) {
        titleEl.innerText = isHostCreate ? 'Starting Session — Support Coop Reader 📖' : 'Joining Session — Support Coop Reader 📖';
      }

      if (closeBtn) closeBtn.style.display = 'none';

      function updateStatus() {
        if (bmcSecondsRemaining > bmcHalftime) {
          var waitSecs = bmcSecondsRemaining - bmcHalftime;
          if (statusEl) statusEl.innerText = 'Close button available in ' + waitSecs + 's (' + bmcSecondsRemaining + 's total)';
          if (closeBtn) closeBtn.style.display = 'none';
        } else {
          if (statusEl) statusEl.innerText = 'Auto-closing in ' + bmcSecondsRemaining + 's';
          if (closeBtn) {
            closeBtn.style.display = 'inline-block';
            closeBtn.innerText = 'Continue to Reader';
          }
        }
      }

      updateStatus();
      modal.classList.add('open');

      if (bmcTimer) clearInterval(bmcTimer);
      bmcTimer = setInterval(function () {
        bmcSecondsRemaining--;
        updateStatus();
        if (bmcSecondsRemaining <= 0) {
          closeBmcModal();
        }
      }, 1000);
    }

    function closeBmcModal() {
      if (bmcTimer) { clearInterval(bmcTimer); bmcTimer = null; }
      var modal = document.getElementById('modal-bmc');
      if (modal) modal.classList.remove('open');
    }
    window.closeBmcModal = closeBmcModal;

    var bmcBtn = document.getElementById('bmc-btn-link');
    if (bmcBtn) {
      bmcBtn.addEventListener('click', function () {
        try {
          sessionStorage.setItem('coop_bmc_donated', 'true');
        } catch (_) {}
        closeBmcModal();
      });
    }

    // Session Host / Join Actions
    function connectToRoom(roomId, key) {
      state.sessionId = roomId;
      peerRelayKey = key || '';
      state.isHost = false;
      state.myPeerId = generateId('kpeer');
      initRelayConnection(state.sessionId, state.myPeerId, false);
    }

    document.getElementById('btn-host-session').addEventListener('click', function () {
      showBmcModal('create');
      state.isHost = true;
      state.sessionId = generateId('kroom');
      var keyBytes = new Uint8Array(32);
      if (window.crypto && window.crypto.getRandomValues) {
        window.crypto.getRandomValues(keyBytes);
      }
      relayKeyB64 = b64u(keyBytes);
      state.myPeerId = state.sessionId;

      initRelayConnection(state.sessionId, state.myPeerId, true);
      document.getElementById('session-display-code').innerText = state.sessionId + '.' + relayKeyB64;
      document.getElementById('session-info-box').style.display = 'block';

      // Register short PIN on relay
      var relayHttp = CONFIG.defaultRelay.replace(/^ws:\/\//i, 'http://').replace(/^wss:\/\//i, 'https://');
      fetch(relayHttp + '/pin/create', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ room: state.sessionId, key: relayKeyB64 })
      }).then(function (res) { return res.json(); }).then(function (data) {
        if (data && data.ok && data.pin) {
          state.pin = data.pin;
          document.getElementById('session-display-pin').innerText = data.pin;
          document.getElementById('session-pin-box').style.display = 'block';
          updateHeaderUI();
        }
      }).catch(function () {
        var numPin = String(1000 + Math.floor(Math.random() * 9000));
        state.pin = numPin;
        document.getElementById('session-display-pin').innerText = numPin;
        document.getElementById('session-pin-box').style.display = 'block';
        updateHeaderUI();
      });
      updateHeaderUI();
    });

    var btnDisconnect = document.getElementById('btn-disconnect-session');
    if (btnDisconnect) {
      btnDisconnect.addEventListener('click', function () {
        if (relayWs) { try { relayWs.close(); } catch(_) {} relayWs = null; }
        state.sessionId = '';
        state.isHost = false;
        state.pin = '';
        state.detached = false;
        document.getElementById('session-pin-box').style.display = 'none';
        document.getElementById('session-info-box').style.display = 'none';
        document.getElementById('session-active-box').style.display = 'none';
        updateHeaderUI();
        closeModals();
      });
    }

    document.getElementById('btn-join-session').addEventListener('click', function () {
      var code = (document.getElementById('input-join-code').value || '').trim();
      if (!code) return;
      showBmcModal('join');

      var isShortPin = code.length <= 8 && code.indexOf('.') === -1 && code.indexOf('-') === -1;
      if (isShortPin) {
        updateSyncStatus('Resolving PIN ' + code + '...', 'warning');
        var relayHttp = CONFIG.defaultRelay.replace(/^ws:\/\//i, 'http://').replace(/^wss:\/\//i, 'https://');
        fetch(relayHttp + '/pin/' + code)
          .then(function (res) { return res.json(); })
          .then(function (data) {
            if (data && data.ok && data.room) {
              connectToRoom(data.room, data.key || '');
            } else {
              return fetch(CONFIG.daemonApi + '/pin/' + code)
                .then(function (r) { return r.json(); })
                .then(function (d) {
                  if (d && d.ok && d.room) connectToRoom(d.room, d.key || '');
                  else connectToRoom(code, '');
                });
            }
          }).catch(function () {
            connectToRoom(code, '');
          });
      } else {
        var parts = code.split('.');
        connectToRoom(parts[0], parts[1] || '');
      }
      closeModals();
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
        loadDocumentFromBytes(ev.target.result, file.name);
        closeModals();
      };
      reader.readAsArrayBuffer(file);
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
    pollKindleStatus();
    setInterval(pollKindleStatus, 30000);

    // Initial placeholder document
    var welcomeDoc = 'Welcome to Coop Reader for Kindle!\n\n' +
      'Read documents and books together in real-time.\n\n' +
      'How to use:\n' +
      '1. Tap [Session] at the top right to Host or Join a reading room.\n' +
      '2. Tap [Docs] to browse books from /mnt/us/documents or receive a book from the host.\n' +
      '3. Page turns sync across everyone in the session.\n' +
      '4. Tap left/right screen edges or use Kindle physical buttons to turn pages.\n' +
      '5. Tap [Refresh] anytime to clear e-ink ghosting.\n\n' +
      'Supported formats: PDF, EPUB, MOBI, AZW3, TXT, DOCX, XLSX.';
    docPages = paginateText(welcomeDoc);
    state.totalPages = docPages.length;
    renderCurrentPage();
  }

  window.addEventListener('DOMContentLoaded', init);
})();

