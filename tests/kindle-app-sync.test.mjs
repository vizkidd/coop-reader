import test from 'node:test';
import assert from 'node:assert/strict';
import Worker, { Room } from '../src/relay-worker.js';

class MemoryStorage {
  constructor() { this.values = new Map(); }
  async get(key) { return this.values.get(key); }
  async put(key, value) { this.values.set(key, structuredClone(value)); }
  async delete(key) { return this.values.delete(key); }
  async list({ prefix = '' } = {}) {
    return new Map([...this.values.entries()].filter(([key]) => key.startsWith(prefix)));
  }
}

function makeEnv() {
  const rooms = new Map();
  const ROOMS = {
    idFromName(name) { return name; },
    get(id) {
      if (!rooms.has(id)) {
        const storage = new MemoryStorage();
        const room = new Room({ storage }, {});
        rooms.set(id, room);
      }
      const room = rooms.get(id);
      return { fetch: request => room.fetch(request) };
    },
  };
  return { ROOMS };
}

test('relay worker document endpoints work for Kindle app background sync', async () => {
  const env = makeEnv();
  const roomId = 'kroom_test123';

  // 1. Initially, no document exists
  const reqInitState = new Request(`https://relay.test/room/${roomId}/state`);
  const resInitState = await Worker.fetch(reqInitState, env);
  const dataInitState = await resInitState.json();
  assert.equal(dataInitState.ok, true);
  assert.equal(dataInitState.doc, null);

  // 2. Upload document bytes to relay (as Kindle host would do)
  const bookContent = new TextEncoder().encode('Chapter 1\nIt was the best of times.');
  const reqUpload = new Request(`https://relay.test/room/${roomId}/doc?filename=great_expectations.txt`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/octet-stream' },
    body: bookContent
  });
  const resUpload = await Worker.fetch(reqUpload, env);
  const dataUpload = await resUpload.json();
  assert.equal(dataUpload.ok, true);
  assert.equal(dataUpload.doc.filename, 'great_expectations.txt');
  assert.equal(dataUpload.doc.size, bookContent.byteLength);

  // 3. State now reflects the document for background polling
  const reqStateAfter = new Request(`https://relay.test/room/${roomId}/state`);
  const resStateAfter = await Worker.fetch(reqStateAfter, env);
  const dataStateAfter = await resStateAfter.json();
  assert.equal(dataStateAfter.ok, true);
  assert.equal(dataStateAfter.doc.filename, 'great_expectations.txt');
  assert.equal(dataStateAfter.doc.size, bookContent.byteLength);

  // 4. Download document (as Kindle peer would do upon background/foreground sync)
  const reqDownload = new Request(`https://relay.test/room/${roomId}/doc`);
  const resDownload = await Worker.fetch(reqDownload, env);
  assert.equal(resDownload.status, 200);
  assert.equal(resDownload.headers.get('Content-Disposition'), 'attachment; filename="great_expectations.txt"');
  const downloadedBytes = new Uint8Array(await resDownload.arrayBuffer());
  assert.deepEqual(downloadedBytes, bookContent);

  // 5. Check metadata endpoint
  const reqMeta = new Request(`https://relay.test/room/${roomId}/doc/meta`);
  const resMeta = await Worker.fetch(reqMeta, env);
  const dataMeta = await resMeta.json();
  assert.equal(dataMeta.ok, true);
  assert.equal(dataMeta.doc.filename, 'great_expectations.txt');
});
