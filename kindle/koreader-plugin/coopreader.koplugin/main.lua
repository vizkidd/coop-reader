--[[
Coop Reader for KOReader.

Reads together with other Kindles/KOReader devices and the Coop Reader web app (WASM) through the relay.
  * Session state lives at MODULE level, so it survives opening another book and FileManager <-> Reader
    switches (KOReader recreates plugin instances each time). Syncing keeps running in the background for as
    long as KOReader runs and the device is awake / on Wi-Fi.
  * Opening a book is synced (host -> everyone). Page sync is optional and can be toggled at any time.
  * Books are transferred on demand through the relay in small verified chunks.
  * Controls: top-menu entry, a small on-screen "Coop" button (tap = panel, hold = chat), a footer chip, and
    gesture actions (Settings > Taps and gestures > "Coop Reader: ...").

The protocol and all non-UI logic live in coop_core.lua (unit-tested against the real relay, see tests/lua).
]]

local Dispatcher = require("dispatcher")
local Event = require("ui/event")
local UIManager = require("ui/uimanager")
local InfoMessage = require("ui/widget/infomessage")
local ConfirmBox = require("ui/widget/confirmbox")
local InputDialog = require("ui/widget/inputdialog")
local ButtonDialog = require("ui/widget/buttondialog")
local TextViewer = require("ui/widget/textviewer")
local WidgetContainer = require("ui/widget/container/widgetcontainer")
local json = require("json")
local logger = require("logger")
local socket = require("socket")
local http = require("socket.http")
local ltn12 = require("ltn12")
local lfs = require("libs/libkoreader-lfs")
local _ = require("gettext")
local https = nil
pcall(function() https = require("ssl.https") end)
local bit = require("bit")
local NetworkMgr = nil
pcall(function() NetworkMgr = require("ui/network/manager") end)
local DataStorage = nil
pcall(function() DataStorage = require("datastorage") end)
local Device = nil
pcall(function() Device = require("device") end)

-- coop_core.lua sits next to this file
do
    local src = debug.getinfo(1, "S").source or ""
    local dir = src:match("^@(.*)/[^/]*$")
    if dir and not package.path:find(dir, 1, true) then package.path = dir .. "/?.lua;" .. package.path end
end
local Core = require("coop_core")
math.randomseed(os.time())

-- ============================================================ shared state (module level)
local ST = {
    cfg = {
        relay_base_url = Core.DEFAULT_RELAY,
        name = nil,                 -- device name shown to others
        sync_page = true,           -- follow the host's page (toggle any time)
        sync_open = true,           -- follow the host when it opens a book
        auto_download = true,       -- fetch a missing book without asking
        show_button = true,         -- on-screen Coop button
        resume = true,              -- reconnect to the last session when KOReader starts
        resume_state = nil,
        lan_transfer = true,        -- serve books straight to readers on the same Wi-Fi (the relay is then not used for the transfer)
        recent = {},                -- last sessions: {room=, role=, ts=}
    },
    logs = {}, active = nil, suspended = false, applying = false,
    fp_cache = nil, last_sent = nil, overlay = nil, overlay_text = nil, panel = nil, chat_dialog = nil,
}
local LOG_FILE = "/tmp/coopreader_debug.log"

local function now() return (socket.gettime and socket.gettime()) or os.time() end

function ST.log(msg)
    msg = tostring(msg)
    local line = os.date("%H:%M:%S") .. " " .. msg
    ST.logs[#ST.logs + 1] = line
    while #ST.logs > 120 do table.remove(ST.logs, 1) end
    pcall(function() logger.info("CoopReader: " .. msg) end)
    pcall(function()
        local f = io.open(LOG_FILE, "a")
        if f then f:write(line .. "\n"); f:close() end
    end)
end

function ST.toast(text, secs)
    text = tostring(text)
    local ok = pcall(function()
        local Notification = require("ui/widget/notification")
        Notification:notify(text)
    end)
    if not ok then pcall(function() UIManager:show(InfoMessage:new{ text = text, timeout = secs or 3 }) end) end
    ST.log("toast: " .. text)
end

function ST.alert(text, secs)
    pcall(function() UIManager:show(InfoMessage:new{ text = tostring(text), timeout = secs or 6 }) end)
end

-- ============================================================ settings
local function settings_dir()
    local d
    pcall(function() d = DataStorage and DataStorage:getSettingsDir() end)
    return d or "/mnt/us/koreader/settings"
end
local function settings_paths()
    return { settings_dir() .. "/coopreader.json", "/mnt/us/koreader/settings/coopreader.json" }
end

function ST.load_settings()
    for _, path in ipairs(settings_paths()) do
        local f = io.open(path, "r")
        if f then
            local content = f:read("*a"); f:close()
            local ok, data = pcall(json.decode, content)
            if ok and type(data) == "table" then
                for k, v in pairs(data) do if ST.cfg[k] ~= nil or k == "name" or k == "resume_state" or k == "recent" then ST.cfg[k] = v end end
                break
            end
        end
    end
    if type(ST.cfg.relay_base_url) ~= "string" or ST.cfg.relay_base_url == "" or ST.cfg.relay_base_url:find("coop-relay.coop-reader.workers.dev", 1, true) then
        ST.cfg.relay_base_url = Core.DEFAULT_RELAY   -- empty, or the previous default: use the current one
    end
    if not ST.cfg.name or ST.cfg.name == "" then
        local model = (Device and Device.model) or "Kindle"
        ST.cfg.name = tostring(model) .. " (KOReader)"
    end
end

function ST.save_settings()
    local content = json.encode(ST.cfg)
    for _, path in ipairs(settings_paths()) do
        local f = io.open(path, "w")
        if f then f:write(content); f:close(); return true end
    end
    return false
end

-- ============================================================ HTTP (LuaSocket/LuaSec, with a safe curl fallback)
local function shell_quote(s) return "'" .. tostring(s):gsub("'", "'\\''") .. "'" end
local curl_ok = nil
local function have_curl()
    if curl_ok == nil then
        local r = os.execute("command -v curl >/dev/null 2>&1")
        curl_ok = (r == 0 or r == true)
    end
    return curl_ok
end

local function friendly_error(err)
    err = tostring(err or "")
    if err:find("timeout", 1, true) then return "timed out (slow Wi-Fi or relay unreachable)" end
    if err:find("refused", 1, true) then return "connection refused" end
    if err:find("host not found", 1, true) or err:find("name resolution", 1, true) then return "DNS failed (no internet?)" end
    if err:find("handshake", 1, true) or err:find("wantread", 1, true) or err:find("closed", 1, true) then return "TLS failed (check the Kindle's date/time and Wi-Fi)" end
    return err
end

-- request(method, url, {body=, headers=, timeout=}) -> status, body, err      (binary safe)
local function http_request(method, url, opts)
    opts = opts or {}
    local timeout = opts.timeout or 6
    local headers = { ["User-Agent"] = "KOReader-CoopReader/" .. Core.VERSION, ["Accept"] = "*/*" }
    for k, v in pairs(opts.headers or {}) do headers[k] = v end
    local chunks = {}
    local old_timeout = http.TIMEOUT
    http.TIMEOUT = timeout                       -- LuaSocket ignores a "timeout" field in the request table
    local ok, r, c = pcall(function()
        local fn = (url:sub(1, 8) == "https://" and https and https.request) or http.request
        local req = { url = url, method = method, headers = headers, sink = ltn12.sink.table(chunks) }
        if opts.body ~= nil then
            headers["Content-Length"] = tostring(#opts.body)
            req.source = ltn12.source.string(opts.body)
        end
        return fn(req)
    end)
    http.TIMEOUT = old_timeout
    if ok and r and tonumber(c) then return tonumber(c), table.concat(chunks), nil end
    local why = (ok and tostring(c)) or tostring(r)

    if have_curl() then                          -- some firmware builds lack a working LuaSec
        local bodyf, outf = os.tmpname(), os.tmpname()
        local parts = { "curl -sS -m " .. tostring(math.ceil(timeout)), "-X " .. shell_quote(method) }
        for k, v in pairs(headers) do parts[#parts + 1] = "-H " .. shell_quote(k .. ": " .. v) end
        if opts.body ~= nil then
            local f = io.open(bodyf, "wb")
            if f then f:write(opts.body); f:close(); parts[#parts + 1] = "--data-binary @" .. shell_quote(bodyf) end
        end
        parts[#parts + 1] = "-o " .. shell_quote(outf) .. " -w '%{http_code}' " .. shell_quote(url) .. " 2>/dev/null"
        local h = io.popen(table.concat(parts, " "))
        local code = h and tonumber(h:read("*a")) or nil
        if h then h:close() end
        local body = ""
        local f = io.open(outf, "rb")
        if f then body = f:read("*a") or ""; f:close() end
        os.remove(bodyf); os.remove(outf)
        if code and code > 0 then return code, body, nil end
    end
    return nil, nil, friendly_error(why)
end

-- ============================================================ documents on this device
local function home_dir()
    local d
    pcall(function() d = G_reader_settings and G_reader_settings:readSetting("home_dir") end)
    return d
end

local function download_dir()
    local base = (lfs.attributes("/mnt/us/documents", "mode") == "directory") and "/mnt/us/documents" or (home_dir() or (DataStorage and DataStorage:getDataDir()) or "/tmp")
    local dir = base .. "/CoopReader"
    if lfs.attributes(dir, "mode") ~= "directory" then lfs.mkdir(dir) end
    return dir
end

local function find_local(offer)
    local want_name, want_size = tostring(offer.name or ""):lower(), tonumber(offer.size)
    if want_name == "" or not want_size then return nil end
    local budget = 4000
    local function scan(dir, depth)
        local ok, iter, state = pcall(lfs.dir, dir)
        if not ok then return nil end
        for entry in iter, state do
            if entry ~= "." and entry ~= ".." then
                budget = budget - 1
                if budget <= 0 then return nil end
                local p = dir .. "/" .. entry
                local attr = lfs.attributes(p)
                if attr and attr.mode == "directory" and depth < 3 and entry:sub(1, 1) ~= "." then
                    local r = scan(p, depth + 1)
                    if r then return r end
                elseif attr and attr.mode == "file" and entry:lower() == want_name and attr.size == want_size then
                    if Core.fingerprint(bit, p) == offer.fp then return p end
                end
            end
        end
    end
    local roots = { download_dir(), "/mnt/us/documents", home_dir() }
    for _, root in ipairs(roots) do
        if root and lfs.attributes(root, "mode") == "directory" then
            local r = scan(root, 0)
            if r then return r end
        end
    end
    return nil
end

local function ui_of_active() return ST.active and ST.active.ui or nil end

local function get_page(ui)
    local p = 1
    pcall(function()
        if ui.paging and ui.paging.current_page then p = ui.paging.current_page
        elseif ui.document and ui.document.getCurrentPage then p = ui.document:getCurrentPage() end
    end)
    return math.max(1, math.floor(tonumber(p) or 1))
end

local function get_total(ui)
    local n = 0
    pcall(function() n = ui.document:getPageCount() end)
    return math.max(0, math.floor(tonumber(n) or 0))
end

local function current_doc()
    local ui = ui_of_active()
    local doc = ui and ui.document
    if not doc or not doc.file then return nil end
    local path = doc.file
    local size = lfs.attributes(path, "size")
    if not size then return nil end
    local c = ST.fp_cache
    if not c or c.path ~= path or c.size ~= size then
        c = { path = path, size = size, fp = Core.fingerprint(bit, path) }
        ST.fp_cache = c
    end
    return { path = path, name = path:match("([^/]+)$"), size = size, fp = c.fp, page = get_page(ui), total = get_total(ui),
             fixed = (doc.info and doc.info.has_pages) and true or false }
end

local function open_document(path)
    UIManager:nextTick(function()
        local ok, err = pcall(function()
            local ReaderUI = require("apps/reader/readerui")
            if ReaderUI.instance then
                if ReaderUI.instance.switchDocument then ReaderUI.instance:switchDocument(path)
                else ReaderUI.instance:onClose(); ReaderUI:showReader(path) end
            else
                ReaderUI:showReader(path)
            end
        end)
        if not ok then
            ST.log("open failed: " .. tostring(err))
            ST.alert("Could not open the book:\n" .. tostring(err))
        end
    end)
end

-- ============================================================ session wiring
local function network_ok()
    if not NetworkMgr then return true end
    local ok, up = pcall(function() return NetworkMgr:isConnected() end)
    return (not ok) or up ~= false
end

local schedule_poll, schedule_pump

function ST.ensure_core()
    if ST.session then
        ST.relay:set_base(ST.cfg.relay_base_url)
        return
    end
    ST.relay = Core.new_relay(ST.cfg.relay_base_url, http_request, json)
    ST.session = Core.new_session({
        relay = ST.relay, bit = bit, json = json, settings = ST.cfg,
        now = now, log = ST.log, toast = ST.toast,
        doc = current_doc,
        goto_page = function(n)
            local ui = ui_of_active()
            if not ui then return end
            ST.applying = true
            ui:handleEvent(Event:new("GotoPage", n))
            ST.last_sent = n
            UIManager:scheduleIn(2, function() ST.applying = false end)
        end,
        open_doc = function(path, offer) ST.log("opening " .. tostring(path)); open_document(path) end,
        find_local = find_local,
        download_dir = download_dir,
        lan_share = function(fid, path, name, size) return ST.lan_share(fid, path, name, size) end,
        ask = function(title, text, yes)
            UIManager:show(ConfirmBox:new{ text = title .. "\n\n" .. text, ok_text = _("Download"), cancel_text = _("Not now"), ok_callback = yes })
        end,
        schedule = function(fn, secs) UIManager:scheduleIn(secs, fn) end,
        chat_open = function() return ST.chat_dialog ~= nil end,
        changed = function() ST.refresh_indicators() end,
    })
end

schedule_pump = function()
    if ST.pump_fn or not ST.session or #ST.session.jobs == 0 then return end
    ST.pump_fn = function()
        ST.pump_fn = nil
        local ok, more = pcall(ST.session.pump)
        if not ok then ST.log("transfer error: " .. tostring(more)); more = false end
        if more then schedule_pump() end
    end
    UIManager:scheduleIn(0.05, ST.pump_fn)
end

schedule_poll = function(delay)
    if ST.poll_fn then UIManager:unschedule(ST.poll_fn); ST.poll_fn = nil end
    if not ST.session or not ST.session.connected then return end
    ST.poll_fn = function()
        ST.poll_fn = nil
        local s = ST.session
        if not s or not s.connected or ST.suspended then return end
        if not network_ok() then schedule_poll(10); return end
        local ok, err = pcall(s.poll)
        if not ok then ST.log("poll error: " .. tostring(err)) end
        schedule_pump()
        schedule_poll(s.next_delay())
    end
    UIManager:scheduleIn(delay or ST.session.next_delay(), ST.poll_fn)
end

function ST.connect(room, role)
    ST.ensure_core()
    local ok, err = ST.session.start(room, role)
    if not ok then
        ST.alert("Could not " .. (role == "host" and "start" or "join") .. " the session:\n" .. tostring(err), 8)
        return false
    end
    ST.cfg.resume_state = { room = room, role = role, ts = os.time() }
    ST.remember(room, role)
    ST.save_settings()
    ST.last_sent = nil
    schedule_poll(1)
    ST.refresh_indicators()
    ST.log("connected as " .. role .. " to " .. room)
    return true
end

function ST.disconnect(quiet)
    ST.lan_stop()
    if ST.poll_fn then UIManager:unschedule(ST.poll_fn); ST.poll_fn = nil end
    if ST.session then ST.session.stop(true) end
    ST.cfg.resume_state = nil
    ST.save_settings()
    ST.refresh_indicators()
    if not quiet then ST.toast("Disconnected from the Coop Reader session", 2) end
end

local function with_network(fn)
    if not NetworkMgr or network_ok() then return fn() end
    local ok = pcall(function() NetworkMgr:runWhenOnline(fn) end)
    if not ok then fn() end
end

-- ============================================================ LAN direct transfer (relay optional for book transfer)
-- A tiny read-only HTTP server: it only answers requests that carry this session's random token and only for books that
-- were explicitly shared. It runs while a session is open and stops on disconnect.
local function random_token()
    local f = io.open("/dev/urandom", "rb")
    local raw = f and f:read(16); if f then f:close() end
    if raw and #raw == 16 then return (raw:gsub(".", function(c) return string.format("%02x", c:byte()) end)) end
    return Core.rand_hex(32)
end

local function local_ip()   -- connecting a UDP socket sends nothing; it only makes the OS pick the Wi-Fi interface address
    local ok, ip = pcall(function() local u = socket.udp(); u:setpeername("203.0.113.1", 9); local a = u:getsockname(); u:close(); return a end)
    if ok and type(ip) == "string" and ip ~= "0.0.0.0" and not ip:match("^127%.") then return ip end
end

ST.lan = { server = nil, state = { token = nil, files = {}, read = function(path, off, len)
    local f = io.open(path, "rb"); if not f then return nil end
    f:seek("set", off); local b = f:read(len); f:close(); return b
end } }

function ST.lan_poll()
    ST.lan_poll_fn = nil
    local L = ST.lan
    if not L.server then return end
    local c = L.server:accept()
    if c then
        pcall(function()
            c:settimeout(2)
            local line = c:receive("*l")
            local method, path = tostring(line or ""):match("^(%u+)%s+(%S+)")
            local headers = {}
            for _ = 1, 40 do
                local h = c:receive("*l")
                if not h or h == "" then break end
                local k, v = h:match("^([^:]+):%s*(.*)$")
                if k then headers[k:lower()] = v end
            end
            if method then
                local code, body, ctype = Core.lan_handle(L.state, method, (path:gsub("%?.*$", "")), headers, json)
                local reason = ({ [200] = "OK", [401] = "Unauthorized", [404] = "Not Found", [405] = "Method Not Allowed" })[code] or "Error"
                c:send(string.format("HTTP/1.1 %d %s\r\nContent-Type: %s\r\nContent-Length: %d\r\nConnection: close\r\nCache-Control: no-store\r\n\r\n", code, reason, ctype, #body))
                c:send(body)
            end
        end)
        pcall(function() c:close() end)
    end
    ST.lan_poll_fn = function() ST.lan_poll() end
    UIManager:scheduleIn(c and 0.02 or 0.15, ST.lan_poll_fn)
end

function ST.lan_start()
    if ST.lan.server then return true end
    if not ST.cfg.lan_transfer then return false end
    local ip = local_ip(); if not ip then return false end
    local ok, srv = pcall(socket.bind, "*", 0)
    if not ok or not srv then return false end
    srv:settimeout(0)
    local _, port = srv:getsockname()
    if not tonumber(port) then pcall(function() srv:close() end); return false end
    ST.lan.server, ST.lan.ip, ST.lan.port, ST.lan.state.token = srv, ip, tonumber(port), random_token()
    ST.log("LAN transfer listening on " .. ip .. ":" .. tostring(port))
    ST.lan_poll()
    return true
end

function ST.lan_stop()
    if ST.lan_poll_fn then UIManager:unschedule(ST.lan_poll_fn); ST.lan_poll_fn = nil end
    if ST.lan.server then pcall(function() ST.lan.server:close() end) end
    ST.lan.server, ST.lan.state.files = nil, {}
end

function ST.lan_share(fid, path, name, size)
    if not ST.lan_start() then return nil end
    ST.lan.state.files[fid] = { path = path, name = name, size = size, fp = fid, chunks = math.ceil(size / Core.CHUNK), ext = (tostring(name):match("%.([%w]+)$") or ""):lower() }
    return { url = "http://" .. ST.lan.ip .. ":" .. tostring(ST.lan.port), token = ST.lan.state.token }
end

-- ============================================================ recent sessions + launch intents (KUAL / KPM / gesture)
function ST.remember(room, role)
    local list, out = ST.cfg.recent or {}, {}
    out[1] = { room = room, role = role, ts = os.time() }
    for _, r in ipairs(list) do if type(r) == "table" and r.room ~= room and #out < 5 then out[#out + 1] = r end end
    ST.cfg.recent = out
end

local function intent_path() return settings_dir() .. "/coopreader.intent" end
function ST.run_intent(text)
    local verb, arg = tostring(text):match("^(%a+):?(.*)$")
    if verb == "host" then ST.host()
    elseif verb == "join" then if arg ~= "" then ST.join(arg) else ST.prompt_join() end
    elseif verb == "settings" then ST.show_settings()
    elseif verb == "test" then ST.test_connection()
    else ST.show_panel() end
end
function ST.consume_intent()   -- written by the KUAL / KPM launchers: "panel", "host", "join", "join:<pin>", "settings", "test"
    local f = io.open(intent_path(), "r"); if not f then return end
    local text = Core.trim(f:read("*l") or ""); f:close(); os.remove(intent_path())
    if text == "" then return end
    UIManager:scheduleIn(1.5, function() ST.run_intent(text) end)
end

function ST.host()
    with_network(function()
        ST.ensure_core()
        local room = "kroom-" .. Core.rand_hex(8)
        if not ST.connect(room, "host") then return end
        local pin, perr = ST.relay:pin_create(room)
        ST.session.pin = pin
        if not pin then ST.log("PIN registration failed: " .. tostring(perr)) end
        ST.show_info(true)
    end)
end

function ST.join(input)
    input = (Core.trim(input):gsub("%s+", ""))
    if input == "" then return end
    with_network(function()
        ST.ensure_core()
        local room
        if input:match("^%d%d%d%d%d?%d?%d?%d?$") then
            local r, err = ST.relay:pin_resolve(input)
            if not r then
                ST.alert("That PIN was not found on the relay.\n(" .. tostring(err) .. ")\nCheck the PIN, the relay address in Settings, and that the host is still hosting.", 8)
                return
            end
            room = r
        else
            room = input:match("^([%w_-]+)")
        end
        if not room then ST.alert("Invalid code. Enter the PIN or the room code.", 5); return end
        if ST.connect(room, "guest") then ST.show_info(false) end
    end)
end

function ST.try_resume()
    if ST.resume_tried then return end
    ST.resume_tried = true
    local r = ST.cfg.resume and ST.cfg.resume_state
    if type(r) ~= "table" or not r.room or (os.time() - (tonumber(r.ts) or 0)) > 12 * 3600 then return end
    UIManager:scheduleIn(4, function()
        with_network(function() ST.log("resuming " .. tostring(r.role) .. " session " .. tostring(r.room)); ST.connect(r.room, r.role) end)
    end)
end

-- ============================================================ on-screen indicators
function ST.chip_text()
    local s = ST.session
    if not s or not s.connected then return "Coop: off" end
    local t = "Coop " .. (s.is_host and "host" or "peer") .. " · " .. tostring(s.peer_count())
    if s.unread > 0 then t = t .. " · !" .. tostring(s.unread) end
    if s.fails > 2 then t = t .. " · offline" end
    return t
end

-- Small floating button; tap = panel, hold = chat.
local CoopButton
local function build_button_class()
    local InputContainer = require("ui/widget/container/inputcontainer")
    local FrameContainer = require("ui/widget/container/framecontainer")
    local TextWidget = require("ui/widget/textwidget")
    local GestureRange = require("ui/gesturerange")
    local Geom = require("ui/geometry")
    local Font = require("ui/font")
    local Size = require("ui/size")
    local Blitbuffer = require("ffi/blitbuffer")
    local Screen = Device.screen
    local B = InputContainer:extend{ name = "coop_button", modal = false }
    function B:init()
        self.label = TextWidget:new{ text = self.text or "Coop", face = Font:getFace("cfont", 16) }
        self.frame = FrameContainer:new{
            background = Blitbuffer.COLOR_WHITE, bordersize = Size.border.thin, padding = Size.padding.small, margin = 0,
            radius = (Size.radius and Size.radius.window) or 0, self.label,
        }
        local fs = self.frame:getSize()
        self.dimen = Geom:new{ x = Screen:getWidth() - fs.w - Screen:scaleBySize(6), y = Screen:getHeight() - fs.h - Screen:scaleBySize(52), w = fs.w, h = fs.h }
        self.ges_events = {
            TapCoop = { GestureRange:new{ ges = "tap", range = self.dimen } },
            HoldCoop = { GestureRange:new{ ges = "hold", range = self.dimen } },
        }
    end
    function B:paintTo(bb, x, y) self.frame:paintTo(bb, self.dimen.x, self.dimen.y) end
    function B:onTapCoop() ST.show_panel(); return true end
    function B:onHoldCoop() ST.show_chat(); return true end
    return B
end

function ST.hide_button()
    if ST.overlay then pcall(function() UIManager:close(ST.overlay) end) end
    ST.overlay, ST.overlay_text = nil, nil
end

-- force = true re-creates it on top of a freshly opened UI (reader / file manager)
function ST.show_button(force)
    local s = ST.session
    if not (ST.cfg.show_button and s and s.connected and Device) then ST.hide_button(); return end
    local txt = ST.chip_text()
    if ST.overlay and ST.overlay_text == txt and not force then return end   -- avoid needless e-ink flashes
    ST.hide_button()
    local ok, err = pcall(function()
        CoopButton = CoopButton or build_button_class()
        ST.overlay = CoopButton:new{ text = txt }
        ST.overlay_text = txt
        UIManager:show(ST.overlay, "ui", ST.overlay.dimen)
    end)
    if not ok then ST.log("overlay unavailable: " .. tostring(err)); ST.overlay, ST.overlay_text = nil, nil end
end

function ST.refresh_indicators()
    pcall(function()
        local ui = ui_of_active()
        if ui and ui.view and ui.view.footer then ui:handleEvent(Event:new("UpdateFooter", true)) end
    end)
    ST.show_button()
end

-- ============================================================ dialogs
local function close_panel() if ST.panel then pcall(function() UIManager:close(ST.panel) end); ST.panel = nil end end

local function act(fn) return function() close_panel(); fn() end end

function ST.show_chat()
    local s = ST.session
    if not s or not s.connected then ST.toast("Join or host a session first", 2); return end
    close_panel()
    s.unread = 0
    ST.refresh_indicators()
    local lines = {}
    for i = math.max(1, #s.chat - 6), #s.chat do lines[#lines + 1] = tostring(s.chat[i].name or "?") .. ": " .. tostring(s.chat[i].text) end
    local dlg
    local function closer() if dlg then UIManager:close(dlg) end; ST.chat_dialog = nil end
    dlg = InputDialog:new{
        title = _("Coop Reader chat"),
        description = #lines > 0 and table.concat(lines, "\n") or _("No messages yet."),
        input = "", input_hint = _("Type a message"),
        buttons = { {
            { text = _("Close"), callback = closer },
            { text = _("History"), callback = function()
                closer()
                local all = {}
                for _, m in ipairs(s.chat) do all[#all + 1] = os.date("%H:%M", math.floor((tonumber(m.ts) or 0) / 1000)) .. "  " .. tostring(m.name) .. ": " .. tostring(m.text) end
                UIManager:show(TextViewer:new{ title = _("Chat history"), text = #all > 0 and table.concat(all, "\n") or _("No messages yet.") })
            end },
            { text = _("Send"), is_enter_default = true, callback = function()
                local t = dlg:getInputText()
                closer()
                if t and Core.trim(t) ~= "" then s.send_chat(t) end
                ST.show_chat()
            end },
        } },
    }
    ST.chat_dialog = dlg
    UIManager:show(dlg)
    pcall(function() dlg:onShowKeyboard() end)
end

function ST.show_info(just_started)
    local s = ST.session
    local L = {}
    if not s or not s.connected then
        L[#L + 1] = "Not connected."
    else
        L[#L + 1] = (s.is_host and "HOSTING" or "JOINED") .. "  (" .. ST.chip_text() .. ")"
        if s.is_host then
            L[#L + 1] = ""
            L[#L + 1] = s.pin and ("Kindle PIN:   " .. s.pin) or "Kindle PIN:   unavailable (relay unreachable) - share the room code"
            L[#L + 1] = "Room code:    " .. tostring(s.room)
        else
            L[#L + 1] = "Host room:    " .. tostring(s.room)
            local hd = s.host_doc
            L[#L + 1] = "Host book:    " .. (hd and (tostring(hd.name) .. string.format(" (%.1f MB)", (tonumber(hd.size) or 0) / 1048576)) or "(none announced)")
        end
        local d = current_doc()
        L[#L + 1] = "Your book:    " .. (d and d.name or "(none open)")
        L[#L + 1] = "Page sync:    " .. (ST.cfg.sync_page and "ON" or "OFF") .. "     Book sync: " .. (ST.cfg.sync_open and "ON" or "OFF")
        L[#L + 1] = "Relay:        " .. ST.cfg.relay_base_url
        L[#L + 1] = "Connection:   " .. (s.fails == 0 and "OK" or ("problems (" .. tostring(s.last_error or "?") .. ")"))
        L[#L + 1] = ""
        L[#L + 1] = "People in the room:"
        local any = false
        for id, p in pairs(s.peers) do
            any = true
            L[#L + 1] = "  - " .. tostring(p.name or id) .. (p.page and ("   p." .. tostring(p.page)) or "") .. (p.detached and "  (detached)" or "")
        end
        if not any then L[#L + 1] = "  (" .. tostring(s.peer_count()) .. " connected)" end
        if just_started and s.is_host then
            L[#L + 1] = ""
            L[#L + 1] = "Open a book in KOReader: everyone follows. Keep Wi-Fi on."
        end
    end
    UIManager:show(TextViewer:new{ title = "Coop Reader", text = table.concat(L, "\n") })
end

function ST.show_comments()
    local s = ST.session
    local L = {}
    if s then for _, c in ipairs(s.comments) do L[#L + 1] = string.format("p.%s  %s: %s", tostring(c.page or "?"), tostring(c.name), tostring(c.text)) end end
    UIManager:show(TextViewer:new{ title = _("Comments from the room"), text = #L > 0 and table.concat(L, "\n") or _("No comments yet.") })
end

function ST.prompt_join()
    local dlg
    dlg = InputDialog:new{
        title = _("Join a Coop Reader session"),
        description = _("Enter the host's Kindle PIN or room code."),
        input = "", input_hint = _("PIN or room code"),
        buttons = { {
            { text = _("Cancel"), callback = function() UIManager:close(dlg) end },
            { text = _("Join"), is_enter_default = true, callback = function() local t = dlg:getInputText(); UIManager:close(dlg); ST.join(t) end },
        } },
    }
    UIManager:show(dlg)
    pcall(function() dlg:onShowKeyboard() end)
end

function ST.prompt_text(title, current, on_ok)
    local dlg
    dlg = InputDialog:new{
        title = title, input = current or "",
        buttons = { {
            { text = _("Cancel"), callback = function() UIManager:close(dlg) end },
            { text = _("Save"), is_enter_default = true, callback = function() local t = dlg:getInputText(); UIManager:close(dlg); on_ok(Core.trim(t)) end },
        } },
    }
    UIManager:show(dlg)
    pcall(function() dlg:onShowKeyboard() end)
end

function ST.test_connection()
    ST.ensure_core()
    with_network(function()
        local L = {}
        local host = ST.cfg.relay_base_url:match("^https?://([^/:]+)")
        local ip
        pcall(function() ip = socket.dns.toip(host) end)
        L[#L + 1] = "Relay:  " .. ST.cfg.relay_base_url
        L[#L + 1] = "DNS:    " .. (ip and ("ok (" .. ip .. ")") or "FAILED - no internet or DNS")
        local t0 = now()
        local st, data, err = ST.relay:health()
        local ms = math.floor((now() - t0) * 1000)
        if st == 200 and data and data.ok then
            L[#L + 1] = "Relay:  reachable (" .. tostring(ms) .. " ms), protocol " .. tostring(data.protocol) .. ", features: " .. table.concat(data.features or {}, ", ")
            local has_blobs = false
            for _, f in ipairs(data.features or {}) do if f == "blobs" then has_blobs = true end end
            if not has_blobs then L[#L + 1] = "WARNING: this relay is too old for book transfer. Redeploy relay-worker.js." end
        else
            L[#L + 1] = "Relay:  NOT reachable (" .. tostring(err or ("HTTP " .. tostring(st))) .. ")"
            L[#L + 1] = "Check Wi-Fi, the Kindle's date/time, and the relay address (Settings)."
        end
        L[#L + 1] = "Wi-Fi:  " .. (network_ok() and "connected" or "OFF")
        ST.log("test: " .. table.concat(L, " | "))
        UIManager:show(TextViewer:new{ title = _("Connection test"), text = table.concat(L, "\n") })
    end)
end

function ST.share_now()
    local s = ST.session
    if not s or not s.connected or not s.is_host then ST.toast("Only the host can share its book", 2); return end
    if not current_doc() then ST.toast("Open a book first", 2); return end
    s.doc_opened()
    ST.toast("Announced the current book to the room", 2)
end

function ST.get_host_book()
    local s = ST.session
    if not s or not s.connected or s.is_host then return end
    if not s.host_doc then ST.toast("The host has not opened a book yet", 2); return end
    s.on_offer(s.host_doc)
    schedule_pump()
end

function ST.toggle(key, label)
    ST.cfg[key] = not ST.cfg[key]
    ST.save_settings()
    ST.toast(label .. (ST.cfg[key] and " ON" or " OFF"), 2)
    if key == "show_button" then ST.show_button(true) end
    if key == "sync_page" and ST.cfg.sync_page and ST.session and ST.session.connected then
        if ST.session.is_host then
            local d = current_doc()
            if d then ST.session.page_changed(d.page, d.total, d.fixed) end
        else
            ST.session.send(ST.session.room, { type = "REQ_SYNC" })
        end
    end
end

local function status_line()
    local s = ST.session
    if s and s.connected then return ST.chip_text() end
    return _("Not in a session") .. "  ·  " .. tostring(ST.cfg.relay_base_url):gsub("^https?://", "")
end

function ST.show_help()
    local lines = {
        "Coop Reader — read together",
        "",
        "HOST: tap \"Host a session\". Share the 4-8 digit PIN shown (or the room code). Anyone can join from a browser, another Kindle or KOReader.",
        "JOIN: tap \"Join with PIN\" and type the PIN. Your page follows the host; tap Page sync to read on your own.",
        "BOOKS: if you do not have the host's book it is fetched for you. On the same Wi-Fi it comes straight from the host's Kindle; otherwise through the relay server.",
        "PRIVACY: the relay only forwards small messages (page numbers, chat) and, when needed, the book file for up to 2 hours.",
        "",
        "Gesture: assign \"Coop Reader: panel\" to a tap zone to open this screen from any book.",
    }
    UIManager:show(TextViewer:new{ title = _("How Coop Reader works"), text = table.concat(lines, "\n") })
end

function ST.show_recent()
    close_panel()
    local B = {}
    for _, r in ipairs(ST.cfg.recent or {}) do
        if type(r) == "table" and r.room then
            local label = string.format("%s  %s  (%s)", r.role == "host" and "👑" or "👤", tostring(r.room):sub(1, 14), os.date("%d %b %H:%M", tonumber(r.ts) or 0))
            B[#B + 1] = { { text = label, callback = act(function() with_network(function() ST.connect(r.room, r.role == "host" and "guest" or r.role); ST.show_info(false) end) end) } }
        end
    end
    if #B == 0 then B[1] = { { text = _("No recent sessions yet"), enabled = false, callback = function() end } } end
    B[#B + 1] = { { text = _("Back"), callback = act(ST.show_panel) } }
    ST.panel = ButtonDialog:new{ title = _("Recent sessions"), title_align = "center", buttons = B }
    UIManager:show(ST.panel)
end

function ST.show_settings()
    close_panel()
    local B = {}
    local function toggle_row(key, label, after)
        B[#B + 1] = { { text = (ST.cfg[key] and "☑  " or "☐  ") .. label, callback = act(function() ST.toggle(key, label); if after then after() end; ST.show_settings() end) } }
    end
    toggle_row("sync_page", _("Follow the host's page"))
    toggle_row("sync_open", _("Follow the host's book"))
    toggle_row("auto_download", _("Fetch missing books automatically"))
    toggle_row("lan_transfer", _("Send/receive books directly on the same Wi-Fi"), function() if not ST.cfg.lan_transfer then ST.lan_stop() end end)
    toggle_row("show_button", _("Show the on-screen Coop button"))
    toggle_row("resume", _("Reconnect to the last session at startup"))
    B[#B + 1] = { { text = _("Device name: ") .. tostring(ST.cfg.name), callback = act(function() ST.prompt_text(_("Name shown to others"), ST.cfg.name, function(t) if t ~= "" then ST.cfg.name = t; ST.save_settings() end; ST.show_settings() end) end) } }
    B[#B + 1] = { { text = _("Relay: ") .. tostring(ST.cfg.relay_base_url):gsub("^https?://", ""), callback = act(function() ST.prompt_text(_("Relay address (https://...)"), ST.cfg.relay_base_url, function(t) if t ~= "" then ST.cfg.relay_base_url = t; ST.save_settings(); if ST.relay then ST.relay:set_base(t) end end; ST.show_settings() end) end) } }
    B[#B + 1] = { { text = _("Test connection"), callback = act(ST.test_connection) }, { text = _("Debug log"), callback = act(function() UIManager:show(TextViewer:new{ title = _("Coop Reader log"), text = #ST.logs > 0 and table.concat(ST.logs, "\n") or _("(empty)") }) end) } }
    B[#B + 1] = { { text = _("Back"), callback = act(ST.show_panel) } }
    ST.panel = ButtonDialog:new{ title = _("Coop Reader settings"), title_align = "center", buttons = B }
    UIManager:show(ST.panel)
end

-- The home screen: big touch buttons, same screen from the reader menu, a gesture, or the KUAL / KPM launcher.
function ST.show_panel()
    close_panel()
    local s = ST.session
    local B = {}
    local function row(...) B[#B + 1] = { ... } end
    local function btn(text, fn) return { text = text, callback = act(fn) } end
    local title = status_line()
    if s and s.connected then
        row(btn(_("💬 Chat") .. (s.unread > 0 and (" (" .. s.unread .. ")") or ""), ST.show_chat), btn(_("👥 Who's here"), function() ST.show_info(false) end))
        row(btn(_("Page sync: ") .. (ST.cfg.sync_page and _("ON") or _("OFF")), function() ST.toggle("sync_page", "Page sync"); ST.show_panel() end),
            btn(_("Book sync: ") .. (ST.cfg.sync_open and _("ON") or _("OFF")), function() ST.toggle("sync_open", "Book sync"); ST.show_panel() end))
        if s.is_host then row(btn(_("📖 Share this book now"), ST.share_now), btn(_("📝 Comments"), ST.show_comments))
        else row(btn(_("📖 Get host's book"), ST.get_host_book), btn(_("📝 Comments"), ST.show_comments)) end
        row(btn(_("⚙ Settings"), ST.show_settings), btn(_("⏏ Disconnect"), function() ST.disconnect() end))
        row({ text = _("Close"), callback = close_panel })
    else
        row(btn(_("👑 Host a session"), ST.host), btn(_("👤 Join with PIN"), ST.prompt_join))
        row(btn(_("🕘 Recent sessions"), ST.show_recent), btn(_("⚙ Settings"), ST.show_settings))
        row(btn(_("📶 Test connection"), ST.test_connection), btn(_("❓ How it works"), ST.show_help))
        row({ text = _("Close"), callback = close_panel })
    end
    ST.panel = ButtonDialog:new{ title = title, title_align = "center", buttons = B }
    UIManager:show(ST.panel)
end

-- ============================================================ plugin class
local CoopReader = WidgetContainer:extend{ name = "coopreader", is_doc_only = false }
CoopReader._ST = ST   -- exposed for the test-suite

function CoopReader:init()
    if not ST.loaded then ST.loaded = true; ST.load_settings() end
    ST.active = self
    ST.ensure_core()
    if not ST.dispatcher_done then
        ST.dispatcher_done = true
        pcall(function()
            Dispatcher:registerAction("coopreader_panel", { category = "none", event = "CoopReaderPanel", title = _("Coop Reader: panel"), general = true })
            Dispatcher:registerAction("coopreader_chat", { category = "none", event = "CoopReaderChat", title = _("Coop Reader: chat"), general = true })
        end)
    end
    if self.ui and self.ui.menu then self.ui.menu:registerToMainMenu(self) end
    pcall(function()
        if self.ui and self.ui.view and self.ui.view.footer and self.ui.view.footer.addAdditionalFooterContent then
            self.ui.view.footer:addAdditionalFooterContent(function() return ST.session and ST.session.connected and ST.chip_text() or "" end)
        end
    end)
    ST.try_resume()
    ST.consume_intent()
    -- a new UI replaced the old one: put the button back on top of it
    if ST.session and ST.session.connected then
        UIManager:nextTick(function() ST.show_button(true) end)
        if not ST.poll_fn then schedule_poll(1) end
    end
end

function CoopReader:addToMainMenu(menu_items)
    menu_items.coopreader = {
        text = _("Coop Reader"),
        sorting_hint = "tools",
        sub_item_table_func = function()
            return {
                { text_func = function() return ST.chip_text() end, keep_menu_open = true, callback = function() ST.show_panel() end },
                { text = _("Host a session"), enabled_func = function() return not (ST.session and ST.session.connected) end, callback = function() ST.host() end },
                { text = _("Join a session (PIN / code)"), enabled_func = function() return not (ST.session and ST.session.connected) end, callback = function() ST.prompt_join() end },
                { text = _("Chat"), enabled_func = function() return ST.session and ST.session.connected end, callback = function() ST.show_chat() end },
                { text = _("Who's here / session info"), callback = function() ST.show_info(false) end },
                { text = _("Comments from the room"), callback = function() ST.show_comments() end },
                { text = _("Share this book now (host)"), enabled_func = function() return ST.session and ST.session.connected and ST.session.is_host end, callback = function() ST.share_now() end },
                { text = _("Get the host's book"), enabled_func = function() return ST.session and ST.session.connected and not ST.session.is_host end, callback = function() ST.get_host_book() end },
                { text = _("Disconnect"), enabled_func = function() return ST.session and ST.session.connected end, callback = function() ST.disconnect() end, separator = true },
                { text = _("Settings"), sub_item_table = {
                    { text = _("Sync pages with the host"), checked_func = function() return ST.cfg.sync_page end, keep_menu_open = true, callback = function() ST.toggle("sync_page", "Page sync") end },
                    { text = _("Follow the host's book"), checked_func = function() return ST.cfg.sync_open end, keep_menu_open = true, callback = function() ST.toggle("sync_open", "Book sync") end },
                    { text = _("Download missing books automatically"), checked_func = function() return ST.cfg.auto_download end, keep_menu_open = true, callback = function() ST.toggle("auto_download", "Auto-download") end },
                    { text = _("Show the on-screen Coop button"), checked_func = function() return ST.cfg.show_button end, keep_menu_open = true, callback = function() ST.toggle("show_button", "Coop button") end },
                    { text = _("Reconnect to the last session at startup"), checked_func = function() return ST.cfg.resume end, keep_menu_open = true, callback = function() ST.toggle("resume", "Auto-resume") end },
                    { text = _("Device name"), keep_menu_open = true, callback = function() ST.prompt_text(_("Name shown to others"), ST.cfg.name, function(t) if t ~= "" then ST.cfg.name = t; ST.save_settings() end end) end },
                    { text = _("Relay address"), keep_menu_open = true, callback = function() ST.prompt_text(_("Relay address (https://...)"), ST.cfg.relay_base_url, function(t) if t ~= "" then ST.cfg.relay_base_url = (t:gsub("/+$", "")); ST.save_settings(); ST.ensure_core() end end) end },
                } },
                { text = _("Recent sessions"), callback = function() ST.show_recent() end },
                { text = _("Direct Wi-Fi book transfer"), checked_func = function() return ST.cfg.lan_transfer end, keep_menu_open = true, callback = function() ST.toggle("lan_transfer", "Direct Wi-Fi book transfer"); if not ST.cfg.lan_transfer then ST.lan_stop() end end },
                { text = _("Test connection"), callback = function() ST.test_connection() end },
                { text = _("Debug log"), callback = function()
                    UIManager:show(TextViewer:new{ title = _("Coop Reader log"), text = #ST.logs > 0 and table.concat(ST.logs, "\n") or _("(empty)") })
                end },
            }
        end,
    }
end

-- ---- hooks -------------------------------------------------------------------------------------
function CoopReader:onReaderReady()
    ST.active = self
    ST.fp_cache = nil
    ST.last_sent = nil
    if ST.session and ST.session.connected then
        pcall(ST.session.document_ready)
        ST.show_button(true)
        schedule_pump()
    end
end

local function on_local_page()
    local s = ST.session
    if ST.applying or not s or not s.connected or not ST.cfg.sync_page then return end
    s.touch()
    if ST.page_task then UIManager:unschedule(ST.page_task) end
    ST.page_task = function()
        ST.page_task = nil
        local d = current_doc()
        if d and d.page ~= ST.last_sent then
            ST.last_sent = d.page
            s.page_changed(d.page, d.total, d.fixed)
        end
    end
    UIManager:scheduleIn(0.8, ST.page_task)   -- debounce quick page flips
end

function CoopReader:onPageUpdate(pageno) on_local_page() end
function CoopReader:onPosUpdate(pos, pageno) on_local_page() end   -- reflowable books report positions

function CoopReader:onCloseDocument()
    if ST.page_task then UIManager:unschedule(ST.page_task); ST.page_task = nil end
    if ST.active == self then ST.active = nil end
    ST.fp_cache = nil
end

function CoopReader:onSuspend()
    ST.suspended = true
    if ST.poll_fn then UIManager:unschedule(ST.poll_fn); ST.poll_fn = nil end
end

function CoopReader:onResume()
    ST.suspended = false
    if ST.session and ST.session.connected then ST.session.touch(); schedule_poll(2) end
end

function CoopReader:onNetworkConnected()
    if ST.session and ST.session.connected then schedule_poll(1) end
end

function CoopReader:onExit()
    ST.lan_stop()
    if ST.session and ST.session.connected then pcall(function() ST.relay:leave() end) end
end

function CoopReader:onCoopReaderPanel() ST.show_panel(); return true end
function CoopReader:onCoopReaderChat() ST.show_chat(); return true end

return CoopReader
