/* Coop Reader codec helpers: smaller payloads on the wire.
 *  - stroke codec: pen strokes as delta-encoded integers (about 3-4x smaller than [[x,y],...] JSON)
 *  - deflate/inflate via CompressionStream (control messages, adaptive file chunks)
 *  - binary message packing: JSON header + raw byte blobs in ONE frame (no base64: -25% bytes, no JSON escaping)
 *  - relay binary frames (protocol 4)
 * Plain script (no modules) so it loads in browsers and in Node tests through vm.
 */
(function (root) {
  'use strict';
  var Q = 10000;   // coordinates are normalised 0..1, kept to 4 decimals

  // ---- strokes ---------------------------------------------------------------------------------
  // [[x,y],...] -> [x0,y0,dx1,dy1,...] (integers, 1e-4 units)
  function encodePts(pts) {
    var out = [], px = 0, py = 0;
    for (var i = 0; i < pts.length; i++) {
      var x = Math.round(pts[i][0] * Q), y = Math.round(pts[i][1] * Q);
      if (i === 0) { out.push(x, y); } else { out.push(x - px, y - py); }
      px = x; py = y;
    }
    return out;
  }
  function decodePts(flat) {
    var out = [], x = 0, y = 0;
    for (var i = 0; i + 1 < flat.length; i += 2) {
      if (i === 0) { x = flat[0]; y = flat[1]; } else { x += flat[i]; y += flat[i + 1]; }
      out.push([x / Q, y / Q]);
    }
    return out;
  }

  // ---- deflate -----------------------------------------------------------------------------------
  function hasCS() { return typeof CompressionStream === 'function' && typeof DecompressionStream === 'function' && typeof Response === 'function'; }
  async function pipeBytes(u8, stream) {
    var w = stream.writable.getWriter(); w.write(u8); w.close();
    return new Uint8Array(await new Response(stream.readable).arrayBuffer());
  }
  async function deflate(u8) { return hasCS() ? pipeBytes(u8, new CompressionStream('deflate-raw')) : u8; }
  async function inflate(u8) { return pipeBytes(u8, new DecompressionStream('deflate-raw')); }

  // Control messages above `min` bytes are deflated when that saves at least 15%: {z:1, d:<bytes>} replaces the object.
  async function packControl(obj, min) {
    min = min || 700;
    var raw = new TextEncoder().encode(JSON.stringify(obj));
    if (raw.length < min || !hasCS()) return { msg: obj, saved: 0 };
    var z = await deflate(raw);
    if (z.length > raw.length * 0.85) return { msg: obj, saved: 0 };
    return { msg: { type: 'Z', d: z }, saved: raw.length - z.length };
  }
  async function unpackControl(msg) {
    if (!msg || msg.type !== 'Z' || !msg.d) return msg;
    var u8 = msg.d instanceof Uint8Array ? msg.d : new Uint8Array(msg.d);
    return JSON.parse(new TextDecoder().decode(await inflate(u8)));
  }

  // ---- adaptive chunk compression ----------------------------------------------------------------
  // Files that are already compressed (zip based formats, JPEG, most PDFs) are sent as is after the first probe chunk.
  function createChunkPolicy() {
    var tried = 0, wins = 0, off = false;
    return {
      async encode(u8) {
        if (off || !hasCS()) return { z: 0, d: u8 };
        var z = await deflate(u8); tried++;
        if (z.length < u8.length * 0.9) { wins++; return { z: 1, d: z }; }
        if (tried >= 3 && wins === 0) off = true;   // three misses in a row: stop paying the CPU
        return { z: 0, d: u8 };
      },
      get disabled() { return off; },
    };
  }

  // ---- packed messages: u32 headerLen | header JSON | blob0 | blob1 ... ---------------------------------
  // Binary fields in the message become {__b:[offset,length]} references into the blob area.
  function packMessage(obj) {
    var blobs = [], total = 0;
    var header = JSON.stringify(obj, function (k, v) {
      var u8 = null;
      if (v instanceof Uint8Array) u8 = v;
      else if (v instanceof ArrayBuffer) u8 = new Uint8Array(v);
      else if (ArrayBuffer.isView(v)) u8 = new Uint8Array(v.buffer, v.byteOffset, v.byteLength);
      if (!u8) return v;
      var ref = { __b: [total, u8.length] }; blobs.push(u8); total += u8.length; return ref;
    });
    var h = new TextEncoder().encode(header), out = new Uint8Array(4 + h.length + total);
    new DataView(out.buffer).setUint32(0, h.length);
    out.set(h, 4);
    var off = 4 + h.length;
    for (var i = 0; i < blobs.length; i++) { out.set(blobs[i], off); off += blobs[i].length; }
    return out;
  }
  function unpackMessage(u8) {
    var hl = new DataView(u8.buffer, u8.byteOffset, u8.byteLength).getUint32(0);
    if (hl > u8.length - 4) throw new Error('bad packed message');
    var base = 4 + hl;
    return JSON.parse(new TextDecoder().decode(u8.subarray(4, base)), function (k, v) {
      if (v && typeof v === 'object' && Array.isArray(v.__b) && v.__b.length === 2) {
        var o = base + v.__b[0], l = v.__b[1];
        if (o < base || o + l > u8.length) throw new Error('bad blob reference');
        return u8.subarray(o, o + l);
      }
      return v;
    });
  }

  // ---- relay binary frames (protocol 4) ----------------------------------------------------------
  // client -> relay: 0x01 | toLen | to | body        relay -> client: 0x02 | fromLen | from | body
  function frameToRelay(to, body) {
    var t = new TextEncoder().encode(String(to));
    if (t.length > 255) throw new Error('peer id too long');
    var out = new Uint8Array(2 + t.length + body.length);
    out[0] = 1; out[1] = t.length; out.set(t, 2); out.set(body, 2 + t.length);
    return out;
  }
  function frameFromRelay(u8) {
    if (!u8 || u8.length < 3 || u8[0] !== 2) return null;
    var n = u8[1]; if (2 + n > u8.length) return null;
    return { from: new TextDecoder().decode(u8.subarray(2, 2 + n)), body: u8.subarray(2 + n) };
  }
  function parseClientFrame(u8) {   // used by the relay itself
    if (!u8 || u8.length < 3 || u8[0] !== 1) return null;
    var n = u8[1]; if (2 + n > u8.length) return null;
    return { to: new TextDecoder().decode(u8.subarray(2, 2 + n)), body: u8.subarray(2 + n) };
  }
  function frameForClient(from, body) {
    var f = new TextEncoder().encode(String(from)), out = new Uint8Array(2 + f.length + body.length);
    out[0] = 2; out[1] = f.length; out.set(f, 2); out.set(body, 2 + f.length); return out;
  }

  root.CoopCodec = { encodePts: encodePts, decodePts: decodePts, deflate: deflate, inflate: inflate, hasCompression: hasCS,
    packControl: packControl, unpackControl: unpackControl, createChunkPolicy: createChunkPolicy,
    packMessage: packMessage, unpackMessage: unpackMessage, frameToRelay: frameToRelay, frameFromRelay: frameFromRelay,
    parseClientFrame: parseClientFrame, frameForClient: frameForClient };
})(typeof self !== 'undefined' ? self : globalThis);
