// Loads a browser-style script (src/js/*.js) into a fresh vm context and returns that context's globals.
import vm from 'node:vm';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const here = path.dirname(fileURLToPath(import.meta.url));
export function loadScript(name, extra = {}) {
  const ctx = vm.createContext({
    console, TextEncoder, TextDecoder, Uint8Array, ArrayBuffer, DataView, Response, CompressionStream, DecompressionStream,
    crypto: globalThis.crypto, setTimeout, clearTimeout, Date, Math, JSON, Map, Set, Promise, ...extra,
  });
  ctx.self = ctx;
  const file = path.join(here, '..', '..', 'src', 'js', name);
  vm.runInContext(fs.readFileSync(file, 'utf8'), ctx, { filename: file });
  return ctx;
}
