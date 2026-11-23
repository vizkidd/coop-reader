-- Integration test of coop_core.lua against the REAL relay worker (served over localhost by relay_server.mjs).
-- Two simulated Kindles (host + guest) exercise: fingerprint, join, doc offer -> request -> chunked upload ->
-- download -> integrity -> open, page mapping, chat, repeated requests, PIN registry, tamper rejection.
package.path = PLUGIN_DIR .. "/?.lua;" .. TESTS_DIR .. "/?.lua;" .. package.path
local Core = require("coop_core")
local json = require("json")
local bit = require("bit")
local base = "http://127.0.0.1:" .. PORT

local function request(method, url, opts)
  opts = opts or {}
  local hdrs = {}
  for k, v in pairs(opts.headers or {}) do hdrs[#hdrs + 1] = string.format(" -H '%s: %s'", k, v) end
  local bodyf, outf, data = os.tmpname(), os.tmpname(), ""
  if opts.body then local f = io.open(bodyf, "wb"); f:write(opts.body); f:close(); data = " --data-binary @" .. bodyf end
  local cmd = string.format("curl -s -m 30 -X %s%s%s -o %s -w '%%{http_code}' '%s'", method, table.concat(hdrs), data, outf, url)
  local p = io.popen(cmd); local code = tonumber(p:read("*a")); p:close()
  local f = io.open(outf, "rb"); local res = f and f:read("*a") or ""; if f then f:close() end
  os.remove(bodyf); os.remove(outf)
  return code, res, code and nil or "curl failed"
end

local passes, fails = 0, 0
local function check(cond, msg) if cond then passes = passes + 1; print("PASS " .. msg) else fails = fails + 1; print("FAIL " .. msg) end end
local function slurp(p) local f = io.open(p, "rb"); if not f then return nil end local s = f:read("*a"); f:close(); return s end

local fp, size = Core.fingerprint(bit, BOOK_PATH)
check(fp == FP_EXPECT, "fingerprint equals the independent CRC-32 value (" .. tostring(fp) .. ")")
check(Core.safe_name("../../etc/pa:ss*wd?.epub") == "_etc_pa_ss_wd_.epub" or not Core.safe_name("../../etc/pa:ss*wd?.epub"):find("/", 1, true), "file names are sanitised")

local function device(name, doc)
  local d = { toasts = {}, opened = {}, gotos = {}, doc_info = doc, clock = os.time(), asked = 0,
              settings = { name = name, sync_page = true, sync_open = true, auto_download = true } }
  local dir = "/tmp/coop_dl_" .. name; os.execute("rm -rf " .. dir .. " && mkdir -p " .. dir)
  d.env = { relay = Core.new_relay(base, request, json), bit = bit, json = json, settings = d.settings,
    now = function() return d.clock end, log = function() end,
    toast = function(t) d.toasts[#d.toasts + 1] = t end,
    doc = function() return d.doc_info end,
    goto_page = function(n) d.gotos[#d.gotos + 1] = n; if d.doc_info then d.doc_info.page = n end end,
    open_doc = function(path, offer)
      d.opened[#d.opened + 1] = path
      local f2, s2 = Core.fingerprint(bit, path)
      d.doc_info = { path = path, name = path:match("([^/]+)$"), size = s2, fp = f2, page = 1, total = tonumber(offer.total) or 100, fixed = false }
      d.session.document_ready()
    end,
    find_local = function() return nil end, download_dir = function() return dir end,
    ask = function(_, _, cb) d.asked = d.asked + 1; cb() end, schedule = function() end,
    chat_open = function() return false end, changed = function() end }
  d.session = Core.new_session(d.env)
  return d
end
local function tick(devs, n)
  for _ = 1, n do
    for _, d in ipairs(devs) do d.session.poll(); local guard = 0; while d.session.pump() and guard < 500 do guard = guard + 1 end end
  end
end
local function has(list, needle) for _, t in ipairs(list) do if t:find(needle, 1, true) then return true end end return false end

-- 1. host Kindle opens a book, guest Kindle joins without it
local host = device("host", { path = BOOK_PATH, name = "My Test Book.epub", size = size, fp = fp, page = 10, total = 200, fixed = false })
local ok, err = host.session.start("kroom-lua1", "host")
check(ok, "host registers with the relay " .. tostring(err or ""))
local guest = device("guest", nil)
ok, err = guest.session.start("kroom-lua1", "guest")
check(ok, "guest joins the room " .. tostring(err or ""))
tick({ host, guest }, 6)

check(#guest.opened == 1, "guest received the offer, requested the file, downloaded and opened it")
local got = guest.opened[1] and slurp(guest.opened[1]); local want = slurp(BOOK_PATH)
check(got ~= nil and got == want, "downloaded file is byte-identical (" .. tostring(got and #got) .. " bytes)")
check(guest.doc_info and guest.doc_info.fp == fp, "guest document fingerprint equals the host's")
check(guest.gotos[#guest.gotos] == 10, "guest jumped to the host's reading position after opening (page " .. tostring(guest.gotos[#guest.gotos]) .. ")")
check(host.session.uploads[fp] and host.session.uploads[fp].done, "host uploaded only after being asked, and finished")
check(has(host.toasts, "joined"), "host is told that a reader joined")

-- 2. page sync with different pagination
guest.doc_info.total = 100   -- the guest's e-reader paginates the same book into 100 pages
host.session.page_changed(101, 200)
tick({ host, guest }, 2)
local expect = math.floor(((101 - 1) / (200 - 1)) * (guest.doc_info.total - 1) + 0.5) + 1
check(guest.gotos[#guest.gotos] == expect, "reflowable books follow position as a fraction (101/200 -> page " .. tostring(guest.gotos[#guest.gotos]) .. " of " .. guest.doc_info.total .. ")")
guest.doc_info.fixed, guest.doc_info.total = true, 200
host.session.page_changed(120, 200)
tick({ host, guest }, 2)
check(guest.gotos[#guest.gotos] == 120, "fixed-layout books keep page numbers")
guest.settings.sync_page = false
local before = #guest.gotos
host.session.page_changed(30, 200); tick({ host, guest }, 2)
check(#guest.gotos == before, "page sync can be switched off (guest stays put)")
guest.settings.sync_page = true

-- 3. chat both ways, with notifications
check(host.session.send_chat("hello from the host"), "host sends a chat message")
tick({ host, guest }, 2)
check(has(guest.toasts, "hello from the host"), "guest gets a notification for the host's message")
guest.session.send_chat("hi, guest here"); tick({ host, guest }, 2)
check(#host.session.chat == 2 and host.session.unread == 1 and has(host.toasts, "hi, guest here"), "host receives the guest's message and notification")
check(#guest.session.chat == 2, "guest keeps its own message in the history")

-- 4. a second guest is served from the already-uploaded copy (no new upload job)
local guest2 = device("guest2", nil)
guest2.session.start("kroom-lua1", "guest")
local jobs_seen = false
for _ = 1, 6 do
  host.session.poll(); guest2.session.poll()
  if #host.session.jobs > 0 then jobs_seen = true end
  while guest2.session.pump() do end
end
check(#guest2.opened == 1 and slurp(guest2.opened[1]) == want, "second guest receives the same book")
check(not jobs_seen, "the host did not upload the book a second time")

-- 5. integrity: a corrupted/mismatched download is rejected and removed
local relay = guest.env.relay
local bad = Core.new_download(relay, { fid = fp, fp = "1-aaaaaaaa-bbbbbbbb", name = "x", size = size, chunks = math.ceil(size / Core.CHUNK) }, "/tmp/coop_bad.bin", bit)
local r; repeat r = bad:step() until r ~= "more"
check(r == "error" and bad.err:find("integrity", 1, true) and not io.open("/tmp/coop_bad.bin", "rb"), "tampered download fails the integrity check and leaves no file")

-- 6. permissions: only the host may publish; unknown members are refused
local st, d2 = relay:call("POST", relay:room_url("/blob/evil-1/meta?id=" .. guest.session.id), { name = "evil", size = 10, chunks = 1, fp = "x" }, relay:auth(), 5)
check(st == 403, "a guest cannot publish files to the room (HTTP " .. tostring(st) .. ")")

-- 7. PIN registry round trip
local pin = relay:pin_create("kroom-lua1")
local room = pin and relay:pin_resolve(pin)
check(pin and #pin >= 4 and room == "kroom-lua1", "PIN " .. tostring(pin) .. " resolves to the room")

-- 8. leaving
guest.session.stop(); check(not guest.session.connected, "guest disconnects cleanly")
host.session.stop(); check(not host.session.connected, "host disconnects cleanly")


-- 9. LAN direct transfer: request handling (auth, meta, chunks, bounds, methods)
do
  local token = "0123456789abcdef0123456789abcdef"
  local nchunks = math.ceil(size / Core.CHUNK)
  local st9 = { token = token, files = { [fp] = { path = BOOK_PATH, name = "My Test Book.epub", size = size, fp = fp, chunks = nchunks, ext = "epub" } },
    read = function(path, off, len) local f = io.open(path, "rb"); f:seek("set", off); local b = f:read(len); f:close(); return b end }
  local H = { Authorization = "Bearer " .. token }
  local code, body = Core.lan_handle(st9, "GET", "/blob/" .. fp .. "/meta", H, json)
  local m = json.decode(body)
  check(code == 200 and m.size == size and m.chunks == nchunks and m.chunk == Core.CHUNK and m.fp == fp, "LAN: meta describes the file and the chunk size")
  local c0, b0 = Core.lan_handle(st9, "GET", "/blob/" .. fp .. "/0", H, json)
  check(c0 == 200 and b0 == want:sub(1, Core.CHUNK), "LAN: chunk 0 is the first bytes of the file")
  local cl, bl = Core.lan_handle(st9, "GET", "/blob/" .. fp .. "/" .. (nchunks - 1), H, json)
  check(cl == 200 and bl == want:sub((nchunks - 1) * Core.CHUNK + 1), "LAN: the last chunk is the short tail")
  check(Core.lan_handle(st9, "GET", "/blob/" .. fp .. "/" .. nchunks, H, json) == 404, "LAN: chunk past the end is refused")
  check(Core.lan_handle(st9, "GET", "/blob/" .. fp .. "/1.5", H, json) == 404, "LAN: fractional chunk index is refused")
  check(Core.lan_handle(st9, "GET", "/blob/nope/meta", H, json) == 404, "LAN: unknown file is refused")
  check(Core.lan_handle(st9, "GET", "/blob/" .. fp .. "/0", {}, json) == 401, "LAN: no token, no data")
  check(Core.lan_handle(st9, "GET", "/blob/" .. fp .. "/0", { Authorization = "Bearer 0123456789abcdef0123456789abcdeX" }, json) == 401, "LAN: a token that differs in one character is refused")
  check(Core.lan_handle(st9, "POST", "/blob/" .. fp .. "/0", H, json) == 405, "LAN: read only")
end

-- 10. LAN flow between two devices: the relay never carries the book; 11. unreachable LAN falls back to the relay
local function lan_pair(name, reachable)
  local h = device(name .. "h", { path = BOOK_PATH, name = "My Test Book.epub", size = size, fp = fp, page = 3, total = 200, fixed = false })
  local g = device(name .. "g", nil)
  local token = "fedcba9876543210fedcba9876543210"
  local st9 = { token = token, files = {}, read = function(path, off, len) local f = io.open(path, "rb"); f:seek("set", off); local b = f:read(len); f:close(); return b end }
  h.shared = 0
  h.env.lan_share = function(fid, path, nm, sz) h.shared = h.shared + 1; st9.files[fid] = { path = path, name = nm, size = sz, fp = fid, chunks = math.ceil(sz / Core.CHUNK), ext = "epub" }; return { url = "http://192.168.7.7:4242", token = token } end
  h.lan_hits = 0
  local real = g.env.relay.request
  g.env.relay.request = function(method, url, o)
    if url:find("192.168.7.7", 1, true) then
      if not reachable then return nil, nil, "no route to host" end
      h.lan_hits = h.lan_hits + 1
      local c, b = Core.lan_handle(st9, method, url:gsub("^http://[^/]+", ""), (o or {}).headers or {}, json)
      return c, b
    end
    return real(method, url, o)
  end
  return h, g
end
do
  local h, g = lan_pair("lanA", true)
  h.session.start("kroom-lan1", "host"); g.session.start("kroom-lan1", "guest")
  tick({ h, g }, 10)
  check(#g.opened == 1 and slurp(g.opened[1]) == want, "LAN: the guest got the book")
  check(h.shared == 1 and h.lan_hits >= 3, "LAN: it came straight from the host (" .. h.lan_hits .. " requests)")
  local st404 = h.env.relay:blob_meta_get(fp)
  check(st404 == 404, "LAN: nothing was uploaded to the relay (HTTP " .. tostring(st404) .. ")")
  h.session.stop(); g.session.stop()
  local h2, g2 = lan_pair("lanB", false)
  h2.session.start("kroom-lan2", "host"); g2.session.start("kroom-lan2", "guest")
  tick({ h2, g2 }, 30)
  check(#g2.opened == 1 and slurp(g2.opened[1]) == want, "LAN unreachable: the book still arrives (through the relay)")
  check(has(g2.toasts, "using the relay"), "LAN unreachable: the reader was told why the relay is used")
  h2.session.stop(); g2.session.stop()
end

-- 12. no size cap; 13. the chunk size comes from the sender
do
  check(Core.too_big(5e12) == false, "no transfer size limit by default")
  Core.MAX_DOC = 1000; check(Core.too_big(2000) == true and Core.too_big(900) == false, "an optional limit still works"); Core.MAX_DOC = nil
  local cs = 65536
  local data = {}; for i = 1, cs * 2 + 100 do data[i] = string.char((i * 7) & 255) end
  local blob = table.concat(data)
  local fake = { max_errors = 4, blob_get = function(_, fid, idx) return 200, blob:sub(idx * cs + 1, math.min(#blob, (idx + 1) * cs)) end }
  local f = io.open("/tmp/cs.bin", "wb"); f:write(blob); f:close()
  local wantfp = Core.fingerprint(bit, "/tmp/cs.bin"); os.remove("/tmp/cs.bin")
  local dl = Core.new_download(fake, { fid = "x", fp = wantfp, name = "x", size = #blob, chunks = 3, chunk = cs }, "/tmp/cs_out.bin", bit)
  local r9; repeat r9 = dl:step() until r9 ~= "more"
  check(r9 == "done" and slurp("/tmp/cs_out.bin") == blob, "downloads use the chunk size announced by the sender (64 KiB here)")
  os.remove("/tmp/cs_out.bin")
end

-- 14. the host moves the session (someone was removed): the Kindle follows; a revoked session is reported
do
  local h, g = device("rotH", { path = BOOK_PATH, name = "My Test Book.epub", size = size, fp = fp, page = 3, total = 200, fixed = false }), device("rotG", nil)
  h.session.start("kroom-rotA", "host"); g.session.start("kroom-rotA", "guest"); tick({ h, g }, 4)
  local h2 = device("rotH2", { path = BOOK_PATH, name = "My Test Book.epub", size = size, fp = fp, page = 9, total = 200, fixed = false })
  h2.session.start("kroom-rotB", "host")
  g.session.on_frame({ from = "kroom-rotA", p = { type = "ROTATE", id = "kroom-rotB", key = "", token = string.rep("a", 32), epoch = 2 } })
  check(g.session.room == "kroom-rotB" and g.session.connected, "ROTATE: the Kindle moved to the new session id")
  tick({ h2, g }, 4)
  check(g.gotos[#g.gotos] == 9, "ROTATE: and is in sync with the new host page")
  g.session.on_frame({ from = "someone-else", p = { type = "ROTATE", id = "kroom-evil", epoch = 3 } })
  check(g.session.room == "kroom-rotB", "ROTATE from anyone but the host is ignored")
  g.session.on_frame({ from = "kroom-rotB", p = { type = "ROTATE", id = "../../etc", epoch = 3 } })
  check(g.session.room == "kroom-rotB", "ROTATE with a malformed id is ignored")
  -- host revokes the room (session ended): the guest finds out instead of retrying forever
  local relay9 = h2.env.relay
  local code = relay9:call("POST", relay9:room_url("/revoke?id=" .. h2.session.id), {}, relay9:auth(), 5)
  check(code == 200, "relay: host ended the session")
  g.env.relay.token = nil   -- simulate the membership expiring after the revoke
  tick({ g }, 3)
  check(not g.session.connected and has(g.toasts, "ended or re-keyed"), "REVOKED: the Kindle stops and tells the reader")
  h.session.stop(); h2.session.stop()
end

print(string.format("\n%d passed, %d failed", passes, fails))
if fails > 0 then error("tests failed") end
