--[[
Coop Reader core — everything that does not need KOReader's UI.

Kept separate from main.lua so it can be unit-tested with a plain Lua interpreter and a fake relay
(see tests/lua/). Compatible with LuaJIT (KOReader) and Lua 5.1+; no goto, no integer division.

Protocol (relay HTTP mailbox, see src/relay-worker.js):
  join    POST /room/<room>/http/join   {id, role, name, token?}            -> {ok, token, ...}
  send    POST /room/<room>/http/send   {id, to, p}                         (to = peer id or "*")
  poll    GET  /room/<room>/http/poll?id=                                   -> {ok, messages:[{from, p, left?}], ...}
  files   POST /room/<room>/blob/<fid>/meta ; PUT|GET /room/<room>/blob/<fid>/<n> ; GET .../meta
Documents: DOC_OPEN (offer) -> DOC_REQUEST -> chunked upload -> DOC_READY -> chunked download, verified by fingerprint.
]]

local Core = {}

Core.VERSION = "2.1.0"
Core.CHUNK = 98304                       -- must equal BLOB_CHUNK in relay-worker.js and DOC_CHUNK in index.html
Core.MAX_DOC = nil                           -- no cap by default (the relay or the free storage on the device decides); set a number to limit transfers
function Core.too_big(size) return Core.MAX_DOC ~= nil and (tonumber(size) or 0) > Core.MAX_DOC end
Core.DEFAULT_RELAY = "https://coop-relay.coop-reader.workers.dev"
Core.MAX_CHAT = 100

-- ---------------------------------------------------------------- helpers
local function trim(s)
    s = tostring(s or "")
    s = s:gsub("^%s+", "")
    s = s:gsub("%s+$", "")
    return s
end
Core.trim = trim

local function clamp(x, lo, hi)
    if x < lo then return lo end
    if x > hi then return hi end
    return x
end

function Core.rand_hex(n)
    local chars = "0123456789abcdef"
    local out = {}
    for i = 1, n do
        local r = math.random(1, #chars)
        out[i] = chars:sub(r, r)
    end
    return table.concat(out)
end

-- Safe file name for a downloaded book (no path separators, no leading dots).
function Core.safe_name(name, fallback)
    name = tostring(name or "")
    name = name:gsub("[/\\:%*%?\"<>|%c]", "_")
    name = name:gsub("^%.+", "_")
    name = name:sub(1, 120)
    if name == "" then name = fallback or "document" end
    return name
end

-- ---------------------------------------------------------------- fingerprint
-- size-crc32(first 64 KiB)-crc32(last 64 KiB): identical to docFingerprint() in the WASM app.
local crc_tab
local function crc_init(bit)
    crc_tab = {}
    for i = 0, 255 do
        local c = i
        for _ = 1, 8 do
            if bit.band(c, 1) == 1 then c = bit.bxor(bit.rshift(c, 1), 0xEDB88320)
            else c = bit.rshift(c, 1) end
        end
        crc_tab[i] = c
    end
end

function Core.crc32_hex(bit, s)
    if not crc_tab then crc_init(bit) end
    local crc = 0xFFFFFFFF
    for i = 1, #s do
        crc = bit.bxor(crc_tab[bit.band(bit.bxor(crc, s:byte(i)), 0xFF)], bit.rshift(crc, 8))
    end
    crc = bit.bxor(crc, 0xFFFFFFFF)
    return string.format("%08x", crc % 4294967296)
end

function Core.fingerprint(bit, path)
    local f = io.open(path, "rb")
    if not f then return nil, "cannot open file" end
    local size = f:seek("end")
    if not size or size <= 0 then f:close(); return nil, "empty file" end
    f:seek("set", 0)
    local first = f:read(65536) or ""
    f:seek("set", size > 65536 and (size - 65536) or 0)
    local last = f:read(65536) or ""
    f:close()
    return string.format("%d-%s-%s", size, Core.crc32_hex(bit, first), Core.crc32_hex(bit, last)), size
end

-- ---------------------------------------------------------------- page mapping
-- Fixed-layout books (PDF, comics) share page numbers. Reflowable books (EPUB, MOBI...) paginate differently
-- on every device, so they follow the reading position as a fraction of the book.
function Core.map_page(msg, doc)
    if not doc or not doc.total or doc.total < 1 then return nil end
    local p = tonumber(msg.page)
    local pct = tonumber(msg.pct)
    local total = tonumber(msg.total)
    if doc.fixed and p and p >= 1 and p <= doc.total then return math.floor(p) end
    if doc.total > 1 and pct and total and total > 1 and pct >= 0 and pct <= 1 then
        return clamp(math.floor(pct * (doc.total - 1) + 0.5) + 1, 1, doc.total)
    end
    if p and p >= 1 and p <= doc.total then return math.floor(p) end
    return nil
end

function Core.page_payload(page, total, fp)
    local pct = 0
    if total and total > 1 then pct = tonumber(string.format("%.5f", (page - 1) / (total - 1))) end
    return { page = page, total = total or 0, pct = pct, fp = fp or "" }
end

-- ---------------------------------------------------------------- frames
-- Returns the decoded payload table, or nil + reason ("encrypted" for browser-to-browser E2E frames).
function Core.decode_payload(json, frame)
    local p = frame and (frame.p or frame.payload)
    if type(p) ~= "table" then return nil, "empty" end
    if type(p.raw) == "string" then
        local ok, d = pcall(json.decode, p.raw)
        if ok and type(d) == "table" then return d end
        return nil, "bad raw"
    end
    if p.e ~= nil and p.type == nil then return nil, "encrypted" end
    return p
end

-- ---------------------------------------------------------------- relay client
local Relay = {}
Relay.__index = Relay

-- request(method, url, {body=string?, headers=table?, timeout=number?}) -> status, body, err
function Core.new_relay(base, request, json)
    base = tostring(base or Core.DEFAULT_RELAY)
    base = base:gsub("/+$", "")
    return setmetatable({ base = base, request = request, json = json, room = nil, id = nil, token = nil }, Relay)
end

function Relay:set_base(base)
    base = tostring(base or Core.DEFAULT_RELAY)
    self.base = base:gsub("/+$", "")
end

function Relay:auth()
    if not self.token then return {} end
    return { Authorization = "Bearer " .. self.token }
end

function Relay:room_url(path) return self.base .. "/room/" .. tostring(self.room) .. path end

-- JSON call: returns status, table|nil, err, raw
function Relay:call(method, url, body, headers, timeout)
    headers = headers or {}
    if type(body) == "table" then
        body = self.json.encode(body)
        headers["Content-Type"] = "application/json"
    end
    local status, res, err = self.request(method, url, { body = body, headers = headers, timeout = timeout or 6 })
    local data
    if status and type(res) == "string" and res:sub(1, 1) == "{" then   -- error answers carry {ok=false, error=, code=} too
        local ok, d = pcall(self.json.decode, res)
        if ok and type(d) == "table" then data = d end
    end
    return status, data, err, res
end

function Relay:health()
    return self:call("GET", self.base .. "/", nil, nil, 6)
end

function Relay:join(role, name)
    local st, d, err = self:call("POST", self:room_url("/http/join"),
        { id = self.id, role = role, name = name, token = self.token }, nil, 8)
    if st == 200 and d and d.ok and d.token then
        self.token = d.token
        return true, d
    end
    return false, nil, (d and d.error) or err or ("HTTP " .. tostring(st)), d and d.code
end

function Relay:leave()
    if not (self.room and self.id and self.token) then return end
    self:call("POST", self:room_url("/http/leave"), { id = self.id }, self:auth(), 3)
end

function Relay:send(to, payload)
    local st, d, err = self:call("POST", self:room_url("/http/send"),
        { id = self.id, to = to, p = payload }, self:auth(), 5)
    return st == 200, st, err
end

function Relay:poll()
    return self:call("GET", self:room_url("/http/poll?id=" .. tostring(self.id)), nil, self:auth(), 6)
end

function Relay:pin_create(room)
    local st, d, err = self:call("POST", self.base .. "/pin/create", { room = room, key = "" }, nil, 6)
    if st == 200 and d and d.ok and d.pin then return tostring(d.pin) end
    return nil, (d and d.error) or err or ("HTTP " .. tostring(st))
end

function Relay:pin_resolve(pin)
    local st, d, err = self:call("GET", self.base .. "/pin/" .. tostring(pin), nil, nil, 6)
    if st == 200 and d and d.ok and d.room then return d.room, d end
    return nil, (d and d.error) or err or ("HTTP " .. tostring(st))
end

function Relay:blob_path(fid, part) return "/blob/" .. fid .. "/" .. part .. "?id=" .. tostring(self.id) end
function Relay:blob_meta_get(fid) return self:call("GET", self:room_url(self:blob_path(fid, "meta")), nil, self:auth(), 8) end
function Relay:blob_meta_post(fid, meta) return self:call("POST", self:room_url(self:blob_path(fid, "meta")), meta, self:auth(), 10) end
function Relay:blob_put(fid, idx, bytes)
    local h = self:auth(); h["Content-Type"] = "application/octet-stream"
    return self:call("PUT", self:room_url(self:blob_path(fid, idx)), bytes, h, 30)
end
function Relay:blob_get(fid, idx)
    local st, res, err = self.request("GET", self:room_url(self:blob_path(fid, idx)), { headers = self:auth(), timeout = 30 })
    return st, res, err
end

-- ---------------------------------------------------------------- transfer jobs (one small step at a time)
-- step() does ONE network request and returns "more" | "done" | "error", so the UI stays responsive between steps.
function Core.new_upload(relay, path, fid, name, size, ext, rejoin)
    local job = { kind = "upload", fid = fid, name = name, size = size, ext = ext, state = "meta",
                  chunks = math.ceil(size / Core.CHUNK), idx = 0, done_count = 0, errors = 0 }
    function job:fail(msg) self.state = "error"; self.err = tostring(msg); return "error" end
    function job:progress() return math.floor(100 * self.done_count / math.max(1, self.chunks)) end
    function job:step()
        if self.state == "error" then return "error" end
        if self.state == "done" then return "done" end
        if self.state == "meta" then
            local st, d, err = relay:blob_meta_post(fid, { name = name, size = size, chunks = self.chunks, chunk = Core.CHUNK, fp = fid, ext = ext })
            if not (st == 200 and d and d.ok) then return self:fail((d and d.error) or err or ("HTTP " .. tostring(st))) end
            self.got = d.got or string.rep("0", self.chunks)
            local c = 0
            for i = 1, #self.got do if self.got:sub(i, i) == "1" then c = c + 1 end end
            self.done_count = c
            self.state = "chunks"
            return "more"
        end
        while self.idx < self.chunks and self.got:sub(self.idx + 1, self.idx + 1) == "1" do self.idx = self.idx + 1 end
        if self.idx >= self.chunks then self.state = "done"; return "done" end
        local f = io.open(path, "rb")
        if not f then return self:fail("cannot read the file") end
        f:seek("set", self.idx * Core.CHUNK)
        local bytes = f:read(Core.CHUNK)
        f:close()
        if not bytes or #bytes == 0 then return self:fail("short read at chunk " .. self.idx) end
        local st, d, err = relay:blob_put(fid, self.idx, bytes)
        if st == 200 and d and d.ok then
            self.got = self.got:sub(1, self.idx) .. "1" .. self.got:sub(self.idx + 2)
            self.idx = self.idx + 1
            self.done_count = self.done_count + 1
            self.errors = 0
        else
            if st == 401 and rejoin then rejoin() end   -- the relay forgot this device (sleep / restart): register again
            self.errors = self.errors + 1
            if self.errors >= 4 then return self:fail((d and d.error) or err or ("HTTP " .. tostring(st))) end
        end
        return "more"
    end
    return job
end

-- ---- LAN direct transfer ---------------------------------------------------------------------------------
-- The relay is only a mailbox. For book transfers the sender can instead serve the file over plain HTTP on the local network
-- and the receiver fetches it directly. Pure request handling here (unit tested); main.lua owns the socket.
--   state = { token = "hex", files = { [fid] = { path=, name=, size=, fp=, chunks=, ext= } }, read = function(path, offset, length) -> bytes|nil }
function Core.lan_handle(state, method, path, headers, json)
    local function resp(code, body, ctype) return code, body or "", ctype or "application/json" end
    local auth = tostring((headers and (headers.authorization or headers.Authorization)) or "")
    local got = auth:match("^Bearer%s+(%S+)$")
    local ok = got and #got == #state.token
    if ok then local diff = 0; for i = 1, #got do if got:byte(i) ~= state.token:byte(i) then diff = diff + 1 end end; ok = diff == 0 end
    if not ok then return resp(401, json.encode({ ok = false, error = "unauthorized" })) end
    if method ~= "GET" then return resp(405, json.encode({ ok = false, error = "read only" })) end
    local fid, part = tostring(path):match("^/blob/([%w_%-]+)/([%w%.]+)")
    local f = fid and state.files[fid]
    if not f then return resp(404, json.encode({ ok = false, error = "unknown file" })) end
    if part == "meta" then
        return resp(200, json.encode({ ok = true, fid = fid, name = f.name, size = f.size, chunks = f.chunks, chunk = Core.CHUNK, fp = f.fp, ext = f.ext, have = f.chunks, done = true }))
    end
    local idx = tonumber(part)
    if not idx or idx < 0 or idx >= f.chunks or idx % 1 ~= 0 then return resp(404, json.encode({ ok = false, error = "chunk not available" })) end
    local bytes = state.read(f.path, idx * Core.CHUNK, Core.CHUNK)
    if not bytes or #bytes == 0 then return resp(500, json.encode({ ok = false, error = "read failed" })) end
    return resp(200, bytes, "application/octet-stream")
end

-- A download source with the same interface as the relay's blob calls, pointing at a LAN URL.
function Core.new_lan_source(lan, id, request, json)
    local src = setmetatable({ base = tostring(lan.url):gsub("/+$", ""), request = request, json = json, id = id, token = lan.token, room = "lan", max_errors = 2 }, Relay)
    function src:room_url(path) return self.base .. path end
    function src:call(method, url, body, headers, timeout) return Relay.call(self, method, url, body, headers, math.min(timeout or 4, 4)) end   -- fail fast when the sender is not on this network
    function src:blob_get(fid, idx)
        local st, res, err = self.request("GET", self:room_url("/blob/" .. fid .. "/" .. idx), { headers = self:auth(), timeout = 4 })
        return st, res, err
    end
    return src
end

function Core.new_download(relay, meta, dest, bit, rejoin)
    local job = { kind = "download", meta = meta, dest = dest, part = dest .. ".part", idx = 0, errors = 0,
                  chunks = tonumber(meta.chunks) or 0, size = tonumber(meta.size) or 0, state = "chunks",
                  cs = tonumber(meta.chunk) or Core.CHUNK }   -- chunk size: whatever the sender used (relay protocol 4 reports it; older ones are 96 KiB)
    function job:fail(msg)
        self.state = "error"; self.err = tostring(msg); os.remove(self.part); return "error"
    end
    function job:progress() return math.floor(100 * self.idx / math.max(1, self.chunks)) end
    function job:step()
        if self.state == "error" then return "error" end
        if self.state == "done" then return "done" end
        if self.chunks < 1 or self.size < 1 or Core.too_big(self.size) then return self:fail("bad file description") end
        if self.idx >= self.chunks then
            os.remove(dest)
            if not os.rename(self.part, dest) then return self:fail("cannot save the file") end
            local fp = Core.fingerprint(bit, dest)
            if fp ~= meta.fp then os.remove(dest); return self:fail("integrity check failed") end
            self.state = "done"
            return "done"
        end
        local st, bytes, err = relay:blob_get(meta.fid or meta.fp, self.idx)
        local expected = (self.idx < self.chunks - 1) and self.cs or (self.size - (self.chunks - 1) * self.cs)
        if st == 200 and type(bytes) == "string" and #bytes == expected then
            local f = io.open(self.part, self.idx == 0 and "wb" or "ab")
            if not f then return self:fail("cannot write " .. self.part) end
            f:write(bytes); f:close()
            self.idx = self.idx + 1
            self.errors = 0
        else
            if st == 401 and rejoin then rejoin() end
            self.errors = self.errors + 1
            if self.errors >= (relay.max_errors or 4) then return self:fail("download failed at chunk " .. self.idx .. " (HTTP " .. tostring(st) .. ")") end
        end
        return "more"
    end
    return job
end

-- ---------------------------------------------------------------- session
-- env (all provided by main.lua / tests):
--   relay, bit, json, settings{name,sync_page,sync_open,auto_download}, now(), log(msg), toast(text),
--   doc() -> {path,name,size,fp,page,total,fixed}|nil, goto_page(n), open_doc(path, offer),
--   find_local(offer)->path|nil, download_dir()->dir, ask(title,text,yes_cb), schedule(fn, seconds),
--   chat_open()->bool, changed()
function Core.new_session(env)
    local S = { connected = false, peers = {}, chat = {}, unread = 0, comments = {}, fails = 0,
                last_activity = env.now(), uploads = {}, waiters = {}, jobs = {} }
    local relay = env.relay
    local function log(m) if env.log then env.log(m) end end
    local function changed() if env.changed then env.changed() end end
    local function name() return env.settings.name or "Kindle" end
    local function pl_with(pl, kind)
        local t = {}
        for k, v in pairs(pl) do t[k] = v end
        t.type = kind
        return t
    end

    function S.touch() S.last_activity = env.now() end

    function S.send(to, payload) return relay:send(to, payload) end

    -- ---- lifecycle
    function S.start(room, role)
        S.stop(true)
        S.room, S.role, S.is_host = room, role, role == "host"
        S.id = S.is_host and room or ("khttp-" .. Core.rand_hex(8))
        relay.room, relay.id, relay.token = room, S.id, nil
        local ok, data, err = relay:join(role, name())
        if not ok then S.room, S.role, S.id = nil, nil, nil; return false, err end
        S.connected, S.fails, S.peers, S.chat, S.comments, S.unread = true, 0, {}, {}, {}, 0
        S.counts = { clients = tonumber(data.clients) or 0, http = tonumber(data.httpClients) or 0 }
        S.touch()
        if S.is_host then
            S.send("*", { type = "PROFILE", peerId = S.id, name = name() })
            S.doc_opened()
        else
            S.send(room, { type = "RELAY_HELLO", peerId = S.id, name = name(), transport = "http" })
            S.send(room, { type = "REQ_SYNC" })
            S.send(room, { type = "PROFILE", peerId = S.id, name = name() })
        end
        changed()
        return true
    end

    function S.stop(quiet)
        if S.connected then pcall(function() relay:leave() end) end
        S.connected = false
        S.pending, S.after_open, S.host_doc = nil, nil, nil
        S.jobs = {}
        S.peers = {}
        S.pin = nil
        S.room, S.role, S.id, S.is_host = nil, nil, nil, false
        relay.room, relay.id, relay.token = nil, nil, nil
        if not quiet then changed() end
    end

    -- ---- outgoing
    function S.page_changed(page, total, fixed)
        if not S.connected or not env.settings.sync_page then return end
        local d = env.doc()
        local pl = Core.page_payload(page, total, d and d.fp)
        if S.is_host then
            pl.type = "PAGE_CHANGE"; S.send("*", pl)
        else
            pl.type = "PAGE_INFO"; pl.detached = false; S.send(S.room, pl)
        end
        S.touch()
    end

    function S.offer_of(d)
        local pl = Core.page_payload(d.page or 1, d.total or 0, d.fp)
        pl.type = "DOC_OPEN"; pl.fid = d.fp; pl.name = d.name; pl.size = d.size
        pl.ext = (d.name:match("%.([%w]+)$") or ""):lower()
        return pl
    end

    -- The host opened (or re-announces) its current document.
    function S.doc_opened(only_to)
        if not (S.connected and S.is_host and env.settings.sync_open) then return end
        local d = env.doc()
        if not d or not d.fp then return end
        S.send(only_to or "*", S.offer_of(d))
    end

    function S.send_chat(text)
        text = trim(text):sub(1, 500)
        if text == "" or not S.connected then return false end
        local msg = { peerId = S.id, name = name(), text = text, ts = math.floor(env.now() * 1000) }
        S.add_chat(msg, true)
        S.send("*", { type = "CHAT", msg = msg })
        S.touch()
        return true
    end

    function S.add_chat(msg, mine)
        for _, m in ipairs(S.chat) do
            if m.ts == msg.ts and m.peerId == msg.peerId and m.text == msg.text then return false end
        end
        S.chat[#S.chat + 1] = msg
        while #S.chat > Core.MAX_CHAT do table.remove(S.chat, 1) end
        if not mine then
            S.unread = S.unread + 1
            if not (env.chat_open and env.chat_open()) then
                env.toast(string.format("%s: %s", tostring(msg.name or "Someone"), tostring(msg.text):sub(1, 90)))
            end
        end
        changed()
        return true
    end

    -- ---- documents
    local function start_job(job, on_done)
        S.jobs[#S.jobs + 1] = { job = job, on_done = on_done, last = -1 }
    end

    -- One step of the oldest job. Returns true while more work remains.
    function S.pump()
        local item = S.jobs[1]
        if not item then return false end
        local r = item.job:step()
        local pct = item.job:progress()
        if pct ~= item.last and (pct % 25 == 0 or r ~= "more") then
            item.last = pct
            env.toast(string.format("%s %s: %d%%", item.job.kind == "upload" and "Sharing" or "Downloading", tostring(item.job.name or (item.job.meta and item.job.meta.name) or "document"), pct), 1.5)
        end
        if r ~= "more" then
            table.remove(S.jobs, 1)
            item.on_done(r == "done", item.job.err)
        end
        return #S.jobs > 0
    end

    function S.serve(requester, d, req)
        local fid = d.fp
        if req and req.lan_ok and not req.lan_failed and env.lan_share then   -- same network? serve it directly, the relay never carries the book
            local info = env.lan_share(fid, d.path, d.name, d.size)
            if info then
                S.send(requester, { type = "DOC_READY", fid = fid, fp = fid, name = d.name, size = d.size, chunks = math.ceil(d.size / Core.CHUNK), chunk = Core.CHUNK,
                                    ext = (d.name:match("%.([%w]+)$") or ""):lower(), lan = info })
                return
            end
        end
        local up = S.uploads[fid]
        if up and up.done and (env.now() - up.at) < 6000 then
            S.send(requester, { type = "DOC_READY", fid = fid, fp = fid, name = d.name, size = d.size, chunks = up.chunks, chunk = Core.CHUNK, ext = up.ext })
            return
        end
        S.waiters[fid] = S.waiters[fid] or {}
        S.waiters[fid][#S.waiters[fid] + 1] = requester
        if up and not up.done then return end   -- already uploading; the waiter is answered when it finishes
        local ext = (d.name:match("%.([%w]+)$") or ""):lower()
        local job = Core.new_upload(relay, d.path, fid, d.name, d.size, ext, function() relay:join(S.role, name()) end)
        S.uploads[fid] = { done = false, chunks = job.chunks, ext = ext, at = env.now() }
        env.toast("Sharing \"" .. d.name .. "\"…", 2)
        start_job(job, function(ok, err)
            local who = S.waiters[fid] or {}
            S.waiters[fid] = nil
            if ok then
                S.uploads[fid].done, S.uploads[fid].at = true, env.now()
                for _, r in ipairs(who) do
                    S.send(r, { type = "DOC_READY", fid = fid, fp = fid, name = d.name, size = d.size, chunks = job.chunks, chunk = Core.CHUNK, ext = ext })
                end
            else
                S.uploads[fid] = nil
                env.toast("Could not share the document: " .. tostring(err), 6)
                for _, r in ipairs(who) do S.send(r, { type = "DOC_ERROR", fp = fid, error = tostring(err) }) end
            end
        end)
    end

    function S.request_doc(offer)
        S.pending = offer
        S.send(S.room, { type = "DOC_REQUEST", fp = offer.fp, lan_ok = true, lan_failed = S.lan_failed and S.lan_failed[offer.fp] or nil })
        env.toast("Requesting \"" .. tostring(offer.name) .. "\" from the host…", 3)
        env.schedule(function()
            if S.pending == offer and #S.jobs == 0 then
                S.pending = nil
                env.toast("The host did not send the document (timed out).", 5)
            end
        end, 120)
    end

    function S.on_offer(offer)
        S.host_doc = offer
        if S.is_host or not env.settings.sync_open then return end
        local cur = env.doc()
        if cur and cur.fp == offer.fp then
            if env.settings.sync_page then S.apply_page(offer) end
            return
        end
        local path = env.find_local(offer)
        if path then
            S.after_open = offer
            env.open_doc(path, offer)
            return
        end
        if Core.too_big(offer.size) then
            env.toast("The host's document is larger than this device's transfer limit.", 6)
            return
        end
        if S.pending and S.pending.fp == offer.fp then return end
        if env.settings.auto_download then S.request_doc(offer)
        else
            env.ask("Host opened a document", string.format("\"%s\" (%.1f MB) is not on this device. Download it from the host?", tostring(offer.name), (tonumber(offer.size) or 0) / 1048576),
                function() S.request_doc(offer) end)
        end
    end

    function S.on_ready(msg)
        local want = S.pending
        if not want or want.fp ~= msg.fp then return end
        local dir = env.download_dir()
        local dest = dir .. "/" .. Core.safe_name(msg.name, "document")
        local existing = io.open(dest, "rb")
        if existing then   -- never overwrite a different book with the same name
            existing:close()
            local efp = Core.fingerprint(env.bit, dest)
            if efp == msg.fp then S.pending = nil; S.after_open = want; env.open_doc(dest, want); return end
            dest = dir .. "/" .. Core.safe_name((msg.fp or ""):sub(-8) .. "-" .. tostring(msg.name), "document")
        end
        local meta = { fid = msg.fid or msg.fp, fp = msg.fp, name = msg.name, size = msg.size, chunks = msg.chunks, chunk = msg.chunk }
        local source, rejoin, over_lan = relay, function() relay:join(S.role, name()) end, false
        if type(msg.lan) == "table" and type(msg.lan.url) == "string" and msg.lan.url:match("^http://[%w%.%-:]+$") and type(msg.lan.token) == "string" then
            source, rejoin, over_lan = Core.new_lan_source(msg.lan, S.id, relay.request, env.json), nil, true
        end
        local job = Core.new_download(source, meta, dest, env.bit, rejoin)
        job.name = msg.name
        start_job(job, function(ok, err)
            if not ok and over_lan then   -- not on the same network (or the sender went away): ask again, this time through the relay
                S.lan_failed = S.lan_failed or {}; S.lan_failed[msg.fp] = true
                env.toast("Direct transfer not possible here — using the relay…", 3)
                S.send(S.room, { type = "DOC_REQUEST", fp = msg.fp, lan_ok = true, lan_failed = true })
                return
            end
            S.pending = nil
            if ok then
                env.toast("Downloaded \"" .. tostring(msg.name) .. "\"", 3)
                S.after_open = want
                env.open_doc(dest, want)
            else
                env.toast("Could not download the document: " .. tostring(err), 6)
            end
        end)
    end

    function S.apply_page(msg)
        local d = env.doc()
        if not d then return end
        local target = Core.map_page(msg, d)
        if target and target ~= d.page then env.goto_page(target) end
    end

    -- Called by main.lua when a document finished opening (own or following the host).
    function S.document_ready()
        local d = env.doc()
        if not d then return end
        if S.is_host then S.doc_opened() end
        if S.after_open and d.fp == S.after_open.fp then
            local o = S.after_open
            S.after_open = nil
            if env.settings.sync_page then S.apply_page(o) end
        end
    end

    -- ---- incoming frames
    function S.on_frame(frame)
        if type(frame) ~= "table" then return end
        local from = tostring(frame.from or S.room or "")
        if frame.left then
            local p = S.peers[from]
            S.peers[from] = nil
            if p and p.name then env.toast(p.name .. " left the session", 2) end
            changed()
            return
        end
        local p, why = Core.decode_payload(env.json, frame)
        if not p then
            if why == "encrypted" and not S.warned_enc then
                S.warned_enc = true
                env.toast("A browser sent an end-to-end encrypted message this Kindle can't read. Join through the Kindle PIN.", 6)
            end
            return
        end
        S.touch()
        local kind = p.type
        local from_host = from == S.room
        if kind == "RELAY_HELLO" then
            S.peers[from] = S.peers[from] or {}
            S.peers[from].name = p.name or S.peers[from].name or "Reader"
            if S.is_host then
                S.send(from, { type = "PROFILE", peerId = S.id, name = name() })
                local d = env.doc()
                local pl = Core.page_payload(d and d.page or 1, d and d.total or 0, d and d.fp)
                S.send(from, { type = "SYNC", state = { currentPage = pl.page, totalPages = pl.total } })
                S.send(from, pl_with(pl, "PAGE_CHANGE"))
                S.doc_opened(from)
                env.toast((S.peers[from].name or "A reader") .. " joined", 2)
            end
            changed()
        elseif kind == "REQ_SYNC" then
            if S.is_host then
                local d = env.doc()
                local pl = Core.page_payload(d and d.page or 1, d and d.total or 0, d and d.fp)
                S.send(from, { type = "SYNC", state = { currentPage = pl.page, totalPages = pl.total } })
                S.send(from, pl_with(pl, "PAGE_CHANGE"))
                S.doc_opened(from)
            end
        elseif kind == "SYNC" then
            if not S.is_host and from_host and env.settings.sync_page and type(p.state) == "table" then
                local pg, tot = tonumber(p.state.currentPage or p.state.page), tonumber(p.state.totalPages)
                if pg then
                    local m = { page = pg, total = tot }
                    if tot and tot > 1 then m.pct = (pg - 1) / (tot - 1) end
                    S.apply_page(m)
                end
            end
        elseif kind == "PAGE_CHANGE" then
            if not S.is_host and from_host and env.settings.sync_page then S.apply_page(p) end
        elseif kind == "PAGE_INFO" then
            S.peers[from] = S.peers[from] or {}
            S.peers[from].page, S.peers[from].detached = tonumber(p.page), p.detached and true or false
        elseif kind == "PROFILE" then
            S.peers[from] = S.peers[from] or {}
            S.peers[from].name = p.name or S.peers[from].name or "Reader"
            changed()
        elseif kind == "CHAT" then
            if type(p.msg) == "table" and type(p.msg.text) == "string" and (p.msg.peerId or from) ~= S.id then
                S.add_chat({ peerId = p.msg.peerId or from, name = p.msg.name or "Reader", text = p.msg.text:sub(1, 500), ts = tonumber(p.msg.ts) or math.floor(env.now() * 1000) }, false)
            end
        elseif kind == "CHAT_HISTORY" then
            if type(p.messages) == "table" then
                for _, m in ipairs(p.messages) do
                    if type(m) == "table" and type(m.text) == "string" and m.peerId ~= S.id then
                        S.add_chat({ peerId = m.peerId, name = m.name, text = m.text:sub(1, 500), ts = tonumber(m.ts) or 0 }, true)
                    end
                end
            end
        elseif kind == "ANNOT" or kind == "ANNOT_ALL" then
            S.on_annot(p)
        elseif kind == "DOC_OPEN" then
            if from_host then S.on_offer(p) end
        elseif kind == "DOC_REQUEST" then
            local d = env.doc()
            if S.is_host and d and d.fp == p.fp then S.serve(from, d, p) end
        elseif kind == "DOC_READY" then
            if not S.is_host and from_host then S.on_ready(p) end
        elseif kind == "DOC_ERROR" then
            if not S.is_host and from_host and S.pending then
                S.pending = nil
                env.toast("The host could not send the document: " .. tostring(p.error or "unknown error"), 6)
            end
        elseif kind == "PING" then
            S.send(from, { type = "PONG", t = p.t })
        elseif kind == "HOST_PING" then
            if from_host then env.toast("The host pinged you", 4) end
        elseif kind == "AUTH_REQUIRED" then
            S.stop()
            env.toast("This session is password protected. The Kindle app can't enter passwords yet — ask the host for an open session or use the Kindle PIN.", 8)
        elseif kind == "ROTATE" then   -- the host moved the session to a new id (someone was removed): follow it
            if not S.is_host and from_host then S.rotate(p) end
        elseif kind == "HOST_KICK" or kind == "RELAY_CLOSE" then
            if not S.is_host and from_host then
                S.stop()
                env.toast("The host ended your session.", 5)
            end
        end
    end

    function S.rotate(p)
        local id = tostring(p.id or "")
        if not id:match("^[%w_%-]+$") or #id > 64 or id == S.room then return end
        S.room = id; relay.room = id; relay.token = nil
        local ok, _, err = relay:join(S.role, name())
        if not ok then S.stop(); env.toast("The host moved the session but this Kindle could not follow: " .. tostring(err), 6); return end
        S.peers = {}; S.fails = 0
        S.send(S.room, { type = "RELAY_HELLO", peerId = S.id, name = name(), transport = "http" })
        S.send(S.room, { type = "REQ_SYNC" })
        env.toast("The host secured the session; you are still connected.", 4)
        changed()
    end

    function S.on_annot(p)
        local function add(page, item, by)
            if type(item) ~= "table" or item.t ~= "note" or type(item.text) ~= "string" then return end
            for _, c in ipairs(S.comments) do if c.id == item.id then return end end
            S.comments[#S.comments + 1] = { id = item.id, page = tonumber(page), name = item.name or by or "Reader", text = item.text:sub(1, 500) }
            return true
        end
        if p.type == "ANNOT_ALL" and type(p.all) == "table" then
            for page, list in pairs(p.all) do
                if type(list) == "table" then for _, it in ipairs(list) do add(page, it, nil) end end
            end
        elseif p.op == "add" and add(p.page, p.item, nil) then
            local c = S.comments[#S.comments]
            env.toast(string.format("Comment on p.%s by %s: %s", tostring(c.page or "?"), c.name, c.text:sub(1, 80)), 4)
        end
        changed()
    end

    -- ---- polling
    function S.next_delay()
        local idle = env.now() - S.last_activity
        local d = env.settings.sync_page and 3 or 5
        if idle > 600 then d = 20 elseif idle > 240 then d = 12 elseif idle > 90 then d = 6 end   -- HTTP peers expire after 45 s of silence
        if S.fails > 0 then d = math.min(30, math.max(d, 3 * 2 ^ math.min(S.fails, 4))) end
        return d
    end

    function S.poll()
        if not S.connected then return end
        local st, data, err = relay:poll()
        if st == 401 then   -- membership expired (device slept, relay restarted): register again
            local ok, _, jerr, jcode = relay:join(S.role, name())
            if not ok and (jcode == "revoked" or jcode == "banned") then S.stop(); env.toast(jcode == "banned" and "The host removed you from the session." or "The host ended or re-keyed this session. Ask for the new PIN.", 7); return end
            if ok then
                log("re-registered with the relay")
                S.fails = 0
                if S.is_host then S.send("*", { type = "PROFILE", peerId = S.id, name = name() }); S.doc_opened()
                else S.send(S.room, { type = "RELAY_HELLO", peerId = S.id, name = name(), transport = "http" }); S.send(S.room, { type = "REQ_SYNC" }) end
            else S.fails = S.fails + 1 end
            return
        end
        if st ~= 200 or not (data and data.ok) then
            S.fails = S.fails + 1
            S.last_error = tostring(err or ("HTTP " .. tostring(st)))
            if S.fails == 1 or S.fails % 10 == 0 then log("poll failed: " .. S.last_error) end
            return
        end
        S.fails, S.last_error = 0, nil
        S.counts = { clients = tonumber(data.clients) or 0, http = tonumber(data.httpClients) or 0 }
        for _, frame in ipairs(data.messages or {}) do S.on_frame(frame) end
    end

    function S.peer_count()
        local n = 0
        for _ in pairs(S.peers) do n = n + 1 end
        if S.counts then
            local reported = math.max(0, S.counts.clients + S.counts.http - 1)
            if reported > n then n = reported end
        end
        return n
    end

    return S
end

return Core
