/* Coop Reader storage: spools incoming files to disk instead of RAM so transfers are not limited by memory.
 * Backends (best first):  OPFS + sync access handle in a Worker (Chrome, Firefox, Safari 15.2+, incl. iOS)
 *                         OPFS createWritable (Chrome/Edge/Firefox)        in-memory (last resort)
 * Also: ChunkAssembler (out-of-order, duplicate-safe, size-validated) and a PDF.js range transport that reads from a Blob/File.
 */
(function (root) {
  'use strict';
  var PREFIX = 'coop-xfer-';

  // ---- backends ------------------------------------------------------------------------------------
  function MemorySpool(size) { this.kind = 'memory'; this.parts = []; this.size = size; }
  MemorySpool.prototype.write = async function (offset, u8) { this.parts.push({ o: offset, d: u8.slice() }); };
  MemorySpool.prototype.close = async function () {
    this.parts.sort(function (a, b) { return a.o - b.o; });
    return new Blob(this.parts.map(function (p) { return p.d; }), { type: 'application/octet-stream' });
  };
  MemorySpool.prototype.abort = async function () { this.parts = []; };

  function WritableSpool(handle, name) { this.kind = 'opfs-writable'; this.handle = handle; this.name = name; this.w = null; }
  WritableSpool.prototype.write = async function (offset, u8) {
    if (!this.w) this.w = await this.handle.createWritable();
    await this.w.write({ type: 'write', position: offset, data: u8 });
  };
  WritableSpool.prototype.close = async function () { if (!this.w) this.w = await this.handle.createWritable(); await this.w.close(); return this.handle.getFile(); };
  WritableSpool.prototype.abort = async function () { try { if (this.w) await this.w.abort(); } catch (_) {} await removeFile(this.name); };

  var WORKER_SRC = [
    'let ah=null,root=null,fh=null;',
    'onmessage=async e=>{const m=e.data;try{',
    ' if(m.op==="open"){root=await navigator.storage.getDirectory();fh=await root.getFileHandle(m.name,{create:true});ah=await fh.createSyncAccessHandle();ah.truncate(0);postMessage({id:m.id,ok:1});}',
    ' else if(m.op==="write"){ah.write(new Uint8Array(m.data),{at:m.at});postMessage({id:m.id,ok:1});}',
    ' else if(m.op==="close"){ah.flush();ah.close();ah=null;postMessage({id:m.id,ok:1});}',
    ' else if(m.op==="abort"){try{ah&&ah.close();}catch(_){}try{await root.removeEntry(m.name);}catch(_){}postMessage({id:m.id,ok:1});}',
    '}catch(err){postMessage({id:m.id,err:String(err&&err.message||err)});}};',
  ].join('\n');
  function SyncSpool(name) { this.kind = 'opfs-sync'; this.name = name; this.n = 0; this.pending = {}; var self = this;
    var url = URL.createObjectURL(new Blob([WORKER_SRC], { type: 'text/javascript' }));
    this.w = new Worker(url); setTimeout(function () { URL.revokeObjectURL(url); }, 10000);
    this.w.onmessage = function (e) { var p = self.pending[e.data.id]; if (!p) return; delete self.pending[e.data.id]; e.data.err ? p.rej(new Error(e.data.err)) : p.res(); };
    this.w.onerror = function (e) { Object.keys(self.pending).forEach(function (k) { self.pending[k].rej(new Error('spool worker failed')); }); self.pending = {}; };
  }
  SyncSpool.prototype.call = function (msg, transfer) { var self = this; return new Promise(function (res, rej) { var id = ++self.n; self.pending[id] = { res: res, rej: rej }; msg.id = id; self.w.postMessage(msg, transfer || []); }); };
  SyncSpool.prototype.write = function (offset, u8) { var copy = u8.slice().buffer; return this.call({ op: 'write', at: offset, data: copy }, [copy]); };
  SyncSpool.prototype.close = async function () { await this.call({ op: 'close' }); this.w.terminate(); return fileOf(this.name); };
  SyncSpool.prototype.abort = async function () { try { await this.call({ op: 'abort', name: this.name }); } catch (_) {} try { this.w.terminate(); } catch (_) {} };

  async function opfsRoot() { return navigator.storage.getDirectory(); }
  async function fileOf(name) { return (await (await opfsRoot()).getFileHandle(name)).getFile(); }
  async function removeFile(name) { try { await (await opfsRoot()).removeEntry(name); } catch (_) {} }

  // createSyncAccessHandle only exists inside workers, so the prototype of the main thread cannot be inspected: try the worker when OPFS exists
function canSync() { return typeof Worker === 'function' && typeof navigator !== 'undefined' && !!(navigator.storage && navigator.storage.getDirectory); }
  function canWritable() { return typeof navigator !== 'undefined' && navigator.storage && navigator.storage.getDirectory && typeof FileSystemFileHandle !== 'undefined' && !!FileSystemFileHandle.prototype.createWritable; }

  // size: expected bytes (used to warn when the device cannot hold it). opts.memoryOnly forces RAM (tests, small files).
  async function createSpool(size, opts) {
    opts = opts || {};
    if (!opts.memoryOnly && size > (opts.memoryLimit == null ? 32 * 1024 * 1024 : opts.memoryLimit) || opts.forceDisk) {
      try {
        if (navigator.storage && navigator.storage.estimate) { var e = await navigator.storage.estimate(); if (e.quota && e.usage != null && size > e.quota - e.usage) throw new Error('Not enough free storage on this device for a ' + Math.round(size / 1048576) + ' MB file'); }
        var name = opts.name || (PREFIX + Math.random().toString(36).slice(2) + '.bin');
        if (canWritable()) { var h = await (await opfsRoot()).getFileHandle(name, { create: true }); return new WritableSpool(h, name); }   // Chrome, Edge, Firefox
        if (canSync()) { var s = new SyncSpool(name); try { await s.call({ op: 'open', name: name }); return s; } catch (e) { try { s.w.terminate(); } catch (_) {} } }   // Safari (incl. iOS): worker + sync access handle
      } catch (err) { if (/Not enough free storage/.test(err.message)) throw err; }
    }
    return new MemorySpool(size);
  }
  async function cleanupSpools() {
    try { var r = await opfsRoot(); for await (var k of r.keys()) if (k.indexOf(PREFIX) === 0) await r.removeEntry(k); } catch (_) {}
  }

  // ---- chunk assembler ---------------------------------------------------------------------------------
  function ChunkAssembler(spool, o) {
    this.spool = spool; this.total = o.totalChunks; this.cs = o.chunkSize; this.size = o.totalSize;
    this.got = new Uint8Array(this.total); this.count = 0; this.queue = Promise.resolve(); this.queued = 0; this.failed = null;
  }
  ChunkAssembler.prototype.expected = function (i) { return i < this.total - 1 ? this.cs : this.size - (this.total - 1) * this.cs; };
  // returns 'ok' | 'dup' | 'bad'
  ChunkAssembler.prototype.put = function (i, u8) {
    if (!(Number.isInteger(i) && i >= 0 && i < this.total) || !u8 || u8.length !== this.expected(i)) return 'bad';
    if (this.got[i]) return 'dup';
    this.got[i] = 1; this.count++; this.queued += u8.length; var self = this;
    this.queue = this.queue.then(function () { return self.spool.write(i * self.cs, u8); }).then(function () { self.queued -= u8.length; }, function (e) { self.failed = e; });
    return 'ok';
  };
  ChunkAssembler.prototype.complete = function () { return this.count === this.total; };
  ChunkAssembler.prototype.missing = function () { var m = []; for (var i = 0; i < this.total; i++) if (!this.got[i]) m.push(i); return m; };
  ChunkAssembler.prototype.finish = async function () {
    await this.queue; if (this.failed) throw this.failed;
    if (!this.complete()) throw new Error('missing chunks: ' + this.missing().length);
    var blob = await this.spool.close();
    if (blob.size !== this.size) throw new Error('size mismatch (' + blob.size + ' vs ' + this.size + ')');
    return blob;
  };
  ChunkAssembler.prototype.abort = async function () { try { await this.queue; } catch (_) {} await this.spool.abort(); };

  // ---- Blob helpers ------------------------------------------------------------------------------------
  async function readSlice(blob, off, len) { return new Uint8Array(await blob.slice(off, Math.min(blob.size, off + len)).arrayBuffer()); }
  // Same fingerprint as docFingerprint() / the Kindle plugin: size-crc32(first 64 KiB)-crc32(last 64 KiB)
  var crcTable = null;
  function crc32(u8) {
    if (!crcTable) { crcTable = new Uint32Array(256); for (var n = 0; n < 256; n++) { var c = n; for (var k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; crcTable[n] = c >>> 0; } }
    var c2 = 0xFFFFFFFF; for (var i = 0; i < u8.length; i++) c2 = crcTable[(c2 ^ u8[i]) & 255] ^ (c2 >>> 8);
    return ((c2 ^ 0xFFFFFFFF) >>> 0).toString(16).padStart(8, '0');
  }
  async function fingerprintBlob(blob) {
    var n = blob.size, head = await readSlice(blob, 0, 65536), tail = await readSlice(blob, Math.max(0, n - 65536), 65536);
    return n + '-' + crc32(head) + '-' + crc32(tail);
  }

  // PDF.js reads only the byte ranges it needs from the Blob: big PDFs open without loading the whole file into memory.
  async function pdfSource(pdfjsLib, blob) {
    if (!pdfjsLib.PDFDataRangeTransport || blob.size < 8 * 1024 * 1024) return { data: new Uint8Array(await blob.arrayBuffer()) };
    var first = await readSlice(blob, 0, 65536);
    var t = Object.create(pdfjsLib.PDFDataRangeTransport.prototype);
    try { pdfjsLib.PDFDataRangeTransport.call(t, blob.size, first); } catch (_) { return { data: new Uint8Array(await blob.arrayBuffer()) }; }
    t.requestDataRange = function (b, e) { readSlice(blob, b, e - b).then(function (u8) { t.onDataRange(b, u8); }); };
    return { range: t, length: blob.size, rangeChunkSize: 262144, disableAutoFetch: true, disableStream: true };
  }

  // Keeps the last opened document across reloads (works on Safari too: uses the worker based backend).
  async function persistBlob(name, blob) {
    var sp = await createSpool(blob.size, { forceDisk: true, name: name });
    if (sp.kind === 'memory') return false;   // no disk backend on this browser
    try { for (var off = 0; off < blob.size; off += 4194304) await sp.write(off, await readSlice(blob, off, 4194304)); await sp.close(); return true; }
    catch (e) { await sp.abort(); throw e; }
  }

  root.CoopStore = { persistBlob: persistBlob, createSpool: createSpool, cleanupSpools: cleanupSpools, ChunkAssembler: ChunkAssembler, MemorySpool: MemorySpool,
    readSlice: readSlice, fingerprintBlob: fingerprintBlob, crc32: crc32, pdfSource: pdfSource, removeFile: removeFile, fileOf: fileOf, canSync: canSync, canWritable: canWritable };
})(typeof self !== 'undefined' ? self : globalThis);
