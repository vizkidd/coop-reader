import test from 'node:test';
import assert from 'node:assert/strict';
import { loadScript } from './helpers/load.mjs';
const { CoopStore: S } = loadScript('coop-store.js', { Blob });

const mkFile = n => { const u = new Uint8Array(n); for (let i = 0; i < n; i++) u[i] = (i * 31 + (i >> 8)) & 255; return u; };

test('assembler rebuilds a file from out-of-order, duplicated chunks and validates sizes', async () => {
  const src = mkFile(250000), cs = 65536, total = Math.ceil(src.length / cs);
  const a = new S.ChunkAssembler(await S.createSpool(src.length, { memoryOnly: true }), { totalChunks: total, chunkSize: cs, totalSize: src.length });
  const chunk = i => src.subarray(i * cs, Math.min(src.length, (i + 1) * cs));
  for (const i of [3, 0, 2]) assert.equal(a.put(i, chunk(i)), 'ok');
  assert.equal(a.put(2, chunk(2)), 'dup'); assert.equal(a.put(1, chunk(0).subarray(0, 10)), 'bad', 'wrong length');
  assert.equal(a.put(9, chunk(0)), 'bad', 'index out of range'); assert.equal(a.put(-1, chunk(0)), 'bad'); assert.equal(a.put(1.5, chunk(0)), 'bad');
  assert.equal(a.complete(), false); assert.equal(a.missing().join(), '1');
  await assert.rejects(() => a.finish(), /missing chunks/);
  assert.equal(a.put(1, chunk(1)), 'ok'); assert.equal(a.complete(), true);
  const blob = await a.finish(); assert.equal(blob.size, src.length);
  assert.deepEqual(new Uint8Array(await blob.arrayBuffer()), src);
});

test('assembler tolerates a file that is an exact multiple of the chunk size and a single tiny chunk', async () => {
  for (const n of [65536 * 3, 1]) {
    const src = mkFile(n), total = Math.ceil(n / 65536);
    const a = new S.ChunkAssembler(await S.createSpool(n, { memoryOnly: true }), { totalChunks: total, chunkSize: 65536, totalSize: n });
    for (let i = 0; i < total; i++) assert.equal(a.put(i, src.subarray(i * 65536, Math.min(n, (i + 1) * 65536))), 'ok');
    assert.deepEqual(new Uint8Array(await (await a.finish()).arrayBuffer()), src);
  }
});

test('a failing backend surfaces as an error instead of a corrupt file', async () => {
  const bad = { write: async () => { throw new Error('disk full'); }, close: async () => new Blob([]), abort: async () => {} };
  const a = new S.ChunkAssembler(bad, { totalChunks: 1, chunkSize: 4, totalSize: 4 });
  a.put(0, new Uint8Array(4)); await assert.rejects(() => a.finish(), /disk full/);
});

test('fingerprint of a Blob equals the fingerprint of the same bytes (browser/Kindle compatible format)', async () => {
  const u = mkFile(300000), fp = await S.fingerprintBlob(new Blob([u]));
  assert.match(fp, /^300000-[0-9a-f]{8}-[0-9a-f]{8}$/);
  assert.equal(S.crc32(new TextEncoder().encode('123456789')), 'cbf43926');   // the standard CRC-32 check value
  const small = await S.fingerprintBlob(new Blob([new Uint8Array([1, 2, 3])])); assert.match(small, /^3-/);
});

test('readSlice is bounded by the blob size', async () => {
  const b = new Blob([mkFile(100)]);
  assert.equal((await S.readSlice(b, 90, 50)).length, 10);
});
