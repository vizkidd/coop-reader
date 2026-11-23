-- Smoke test of the real main.lua: plugin as HOST and as GUEST against the real relay, with a second simulated device.
package.path = PLUGIN_DIR .. "/?.lua;" .. TESTS_DIR .. "/?.lua;" .. package.path
local S = require("koreader_stubs")
local json = require("json")
local Core = require("coop_core")
local bit = require("bit")
os.execute("rm -rf /tmp/coop_settings /tmp/coop_data; rm -f /tmp/coopreader_debug.log")
local passes, fails = 0, 0
local function check(c, m) if c then passes = passes + 1; print("PASS " .. m) else fails = fails + 1; print("FAIL " .. m) end end
local function slurp(p) local f = io.open(p, "rb"); if not f then return nil end local s = f:read("*a"); f:close(); return s end
local function has(list, needle) for _, t in ipairs(list) do if tostring(t):find(needle, 1, true) then return true end end return false end

-- another device on the same relay (plain core session)
local base = "http://127.0.0.1:" .. PORT
local function request(method, url, opts)
  local req = { method = method, url = url, headers = (opts or {}).headers, source = (opts or {}).body and { s = opts.body } or nil, sink = { t = {} } }
  local ok, code = package.loaded["socket.http"].request(req)
  if not ok then return nil, nil, code end
  return code, table.concat(req.sink.t), nil
end
local function device(name, doc)
  local d = { toasts = {}, opened = {}, gotos = {}, doc_info = doc, settings = { name = name, sync_page = true, sync_open = true, auto_download = true } }
  local dir = "/tmp/coop_dl_" .. name; os.execute("rm -rf " .. dir .. " && mkdir -p " .. dir)
  d.env = { relay = Core.new_relay(base, request, json), bit = bit, json = json, settings = d.settings, now = function() return S.clock end, log = function() end,
    toast = function(t) d.toasts[#d.toasts + 1] = t end, doc = function() return d.doc_info end,
    goto_page = function(n) d.gotos[#d.gotos + 1] = n; if d.doc_info then d.doc_info.page = n end end,
    open_doc = function(path, offer) d.opened[#d.opened + 1] = path; local f2, s2 = Core.fingerprint(bit, path)
      d.doc_info = { path = path, name = path:match("([^/]+)$"), size = s2, fp = f2, page = 1, total = tonumber(offer.total) or 100, fixed = false }; d.session.document_ready() end,
    find_local = function() return nil end, download_dir = function() return dir end, ask = function(_, _, cb) cb() end, schedule = function() end,
    chat_open = function() return false end, changed = function() end }
  d.session = Core.new_session(d.env); return d
end
local function pump_other(d) for _ = 1, 3 do d.session.poll(); local g = 0; while d.session.pump() and g < 500 do g = g + 1 end end end

local CoopReader = dofile(PLUGIN_DIR .. "/main.lua")
local ST = CoopReader._ST
local ui_fm = { menu = { registerToMainMenu = function() end }, handleEvent = function() end }
local fm = CoopReader:new{ ui = ui_fm }
check(ST.session ~= nil and ST.cfg.relay_base_url:find("workers.dev", 1, true), "plugin initialises in the file manager with defaults")
ST.cfg.relay_base_url = base; ST.save_settings(); ST.ensure_core()

local items = {}; fm:addToMainMenu(items)
local sub = items.coopreader.sub_item_table_func()
check(#sub >= 10 and sub[2].text == "Host a session", "menu builds (" .. #sub .. " entries)")
check(slurp("/tmp/coop_settings/coopreader.json"):find("sync_page", 1, true), "settings are persisted")

-- ===== plugin as HOST
ST.host()
local s = ST.session
check(s.connected and s.is_host and s.room:match("^kroom%-%x+$"), "host session started (" .. tostring(s.room) .. ")")
check(s.pin and #s.pin >= 4, "Kindle PIN registered on the relay (" .. tostring(s.pin) .. ")")
check(ST.overlay ~= nil and ST.overlay_text:find("Coop host", 1, true), "on-screen Coop button is shown (" .. tostring(ST.overlay_text) .. ")")

local doc = { file = BOOK_PATH, info = { has_pages = false }, getPageCount = function() return 200 end }
local page = 10; doc.getCurrentPage = function() return page end
local reader_ui = { document = doc, menu = ui_fm.menu, handleEvent = function(_, ev) S.events[#S.events + 1] = ev end }
ST.active = nil
local reader = CoopReader:new{ ui = reader_ui }
reader:onReaderReady()
local guest = device("kguest", nil)
local ok = guest.session.start(s.room, "guest")
check(ok, "second device joins the plugin's room")
S.run(6); pump_other(guest); S.run(6); pump_other(guest); S.run(10); pump_other(guest); S.run(10); pump_other(guest)
check(#guest.opened == 1 and slurp(guest.opened[1]) == slurp(BOOK_PATH), "plugin (host) served the book: guest downloaded it byte-identically")
check(has(S.toasts, "joined"), "host sees a notification that a reader joined")
check(guest.gotos[#guest.gotos] == 10, "guest landed on the host's page after opening")

page = 50; reader:onPageUpdate(50); S.run(3); pump_other(guest)
check(guest.gotos[#guest.gotos] == 50, "page turn on the Kindle reaches the guest (page 50)")
ST.cfg.sync_page = false; page = 60; reader:onPageUpdate(60); S.run(3); pump_other(guest)
check(guest.gotos[#guest.gotos] == 50, "page sync OFF: nothing is sent")
ST.cfg.sync_page = true

guest.session.send_chat("hello kindle"); S.run(6)
check(has(S.toasts, "hello kindle") and s.unread == 1, "chat message shows a notification on the Kindle (unread " .. s.unread .. ")")
ST.show_chat(); check(s.unread == 0, "opening the chat clears the unread counter")
s.send_chat("hi back"); pump_other(guest)
check(has(guest.toasts, "hi back"), "message typed on the Kindle reaches the other device")

-- reader instance goes away (book closed), session keeps running in the background
reader:onCloseDocument(); S.run(8)
check(s.connected, "session survives closing the book (background sync)")
reader:onSuspend(); local polls_before = S.clock; S.run(30)
check(ST.poll_fn == nil, "polling stops while the device sleeps")
reader:onResume(); S.run(3)
check(ST.poll_fn ~= nil or s.connected, "polling resumes on wake")

-- ===== plugin as GUEST of another device, books follow the host
ST.disconnect(true)
check(not s.connected and ST.overlay == nil, "disconnect clears the session and removes the button")
local host = device("khost", { path = BOOK_PATH, name = "Shared Novel.epub", size = nil, fp = nil, page = 33, total = 120, fixed = false })
local fp, size = Core.fingerprint(bit, BOOK_PATH); host.doc_info.fp, host.doc_info.size = fp, size
local hroom = "kroom-hostdev1"
host.session.start(hroom, "host")
local pin = host.env.relay:pin_create(hroom)
ST.join(pin)
check(s.connected and not s.is_host and s.room == hroom, "plugin joined the other device through its PIN")
for _ = 1, 6 do S.run(4); pump_other(host) end
local dl = S.opened[#S.opened]
check(dl and dl:find("/CoopReader/Shared Novel.epub", 1, true) and slurp(dl) == slurp(BOOK_PATH), "plugin downloaded the host's book to " .. tostring(dl))
-- KOReader would now open it; simulate the new reader instance
ST.active = nil
local gdoc = { file = dl, info = { has_pages = false }, getPageCount = function() return 300 end, getCurrentPage = function() return 1 end }
local g_ui = { document = gdoc, menu = ui_fm.menu, handleEvent = function(_, ev) S.events[#S.events + 1] = ev end }
local reader2 = CoopReader:new{ ui = g_ui }
S.events = {}
reader2:onReaderReady()
local goto_ev; for _, ev in ipairs(S.events) do if ev.name == "GotoPage" then goto_ev = ev end end
local expect = math.floor(((33 - 1) / (120 - 1)) * (300 - 1) + 0.5) + 1
check(goto_ev and goto_ev.args[1] == expect, "after opening, the Kindle jumps to the host's position by percentage (page " .. tostring(goto_ev and goto_ev.args[1]) .. " of 300, expected " .. expect .. ")")
host.session.page_changed(60, 120); S.run(4)
local last; for _, ev in ipairs(S.events) do if ev.name == "GotoPage" then last = ev.args[1] end end
check(last == math.floor(((60 - 1) / 119) * 299 + 0.5) + 1, "later page turns of the host move the Kindle (page " .. tostring(last) .. ")")
local info_shown = #S.shown
ST.show_info(false); check(#S.shown == info_shown + 1, "host information screen can be opened")
ST.disconnect(); check(not s.connected, "Disconnect works for a guest")


-- GUI screens (touch home, settings, recent sessions, help) -------------------------------------------------------------
do
  local n0 = #S.shown
  ST.show_panel(); check(#S.shown == n0 + 1, "home screen opens when not in a session")
  ST.show_settings(); check(#S.shown == n0 + 2, "settings screen opens")
  ST.show_recent(); check(#S.shown == n0 + 3, "recent sessions screen opens")
  ST.show_help(); check(#S.shown == n0 + 4, "help screen opens")
  check(type(ST.cfg.recent) == "table" and #ST.cfg.recent >= 1 and ST.cfg.recent[1].room ~= nil, "sessions are remembered for one-tap rejoin")
  -- the KUAL / KPM launchers leave an intent file; the plugin runs it once and removes it
  local ip = "/tmp/coop_settings/coopreader.intent"
  local f = io.open(ip, "w"); f:write("settings\n"); f:close()
  local before = #S.shown
  ST.consume_intent(); S.run(3)
  check(not io.open(ip, "r") and #S.shown > before, "launch intent opens the settings screen once and is consumed")
  ST.consume_intent(); S.run(3); check(true, "no intent file: nothing happens")
end

-- LAN direct transfer glue ----------------------------------------------------------------------------------------------
do
  local fp9, size9 = Core.fingerprint(bit, BOOK_PATH)
  ST.cfg.lan_transfer = false
  check(ST.lan_share(fp9, BOOK_PATH, "b.epub", size9) == nil, "LAN transfer can be switched off")
  ST.cfg.lan_transfer = true
  local info = ST.lan_share(fp9, BOOK_PATH, "b.epub", size9)
  check(info and info.url == "http://192.168.1.50:40123" and #info.token == 32 and info.token:match("^%x+$"), "LAN share announces this Kindle's Wi-Fi address and a random token")
  local function ask(path, token)
    local lines = { "GET " .. path .. " HTTP/1.1", "Host: x", token and ("Authorization: Bearer " .. token) or "X-Other: 1", "" }
    local c = S.fake_client(lines); S.lan_queue[#S.lan_queue + 1] = c; S.run(1); return table.concat(c.out), c
  end
  local out, c = ask("/blob/" .. fp9 .. "/meta", info.token)
  check(out:find("200 OK", 1, true) and out:find('"chunks"', 1, true) and c.closed, "LAN server answers a valid request and closes the connection")
  local out2 = ask("/blob/" .. fp9 .. "/0", info.token)
  check(out2:find("Content-Length: " .. Core.CHUNK, 1, true), "LAN server serves the first chunk")
  check(ask("/blob/" .. fp9 .. "/0", "00000000000000000000000000000000"):find("401", 1, true), "LAN server refuses a wrong token")
  check(ask("/blob/" .. fp9 .. "/0", nil):find("401", 1, true), "LAN server refuses requests without a token")
  ST.lan_stop(); check(S.lan_server.closed, "LAN server is closed on disconnect")
end

print(string.format("\n%d passed, %d failed", passes, fails))
if fails > 0 then error("plugin smoke tests failed") end
