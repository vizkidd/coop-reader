-- Minimal stand-ins for KOReader modules so main.lua can be loaded and exercised under plain Lua.
local S = { shown = {}, closed = {}, toasts = {}, events = {}, clock = 1000, tasks = {}, opened = {} }

local function class() local C = {}; C.__index = C
  function C:extend(t) t = t or {}; t.__index = t; setmetatable(t, { __index = self }); return t end
  function C:new(o) o = o or {}; setmetatable(o, { __index = self }); if o.init then o:init() end; return o end
  return C end

local function preload(name, v) package.preload[name] = function() return v end end

-- scheduler with a virtual clock
local UIManager = { }
function UIManager:scheduleIn(sec, fn) S.tasks[#S.tasks + 1] = { at = S.clock + sec, fn = fn } end
function UIManager:nextTick(fn) self:scheduleIn(0, fn) end
function UIManager:unschedule(fn) for i = #S.tasks, 1, -1 do if S.tasks[i].fn == fn then table.remove(S.tasks, i) end end end
function UIManager:show(w) S.shown[#S.shown + 1] = w end
function UIManager:close(w) S.closed[#S.closed + 1] = w end
function S.run(seconds)
  local stop = S.clock + seconds
  local guard = 0
  while guard < 5000 do
    guard = guard + 1
    table.sort(S.tasks, function(a, b) return a.at < b.at end)
    local t = S.tasks[1]
    if not t or t.at > stop then break end
    table.remove(S.tasks, 1); S.clock = math.max(S.clock, t.at); t.fn()
  end
  S.clock = stop
end
preload("ui/uimanager", UIManager)

preload("dispatcher", { registerAction = function() end })
preload("ui/event", { new = function(_, name, ...) return { name = name, args = { ... } } end })
local W = class()
for _, n in ipairs({ "ui/widget/infomessage", "ui/widget/confirmbox", "ui/widget/inputdialog", "ui/widget/buttondialog", "ui/widget/textviewer" }) do
  preload(n, W:extend{ kind = n }) end
preload("ui/widget/notification", { notify = function(_, text) S.toasts[#S.toasts + 1] = text end })
preload("ui/widget/container/widgetcontainer", class())
local IC = class(); preload("ui/widget/container/inputcontainer", IC)
local FC = IC:extend{}; function FC:getSize() return { w = 120, h = 30 } end
preload("ui/widget/container/framecontainer", FC)
preload("ui/widget/textwidget", class())
preload("ui/gesturerange", class()); preload("ui/geometry", class()); preload("ui/font", { getFace = function() return {} end })
preload("ui/size", { border = { thin = 1 }, padding = { small = 2 }, radius = { window = 3 } })
preload("ffi/blitbuffer", { COLOR_WHITE = 1 })
preload("device", { model = "KindleTest", screen = { getWidth = function() return 1000 end, getHeight = function() return 1400 end, scaleBySize = function(_, x) return x end } })
preload("ui/network/manager", { isConnected = function() return true end, runWhenOnline = function(_, fn) fn() end })
preload("datastorage", { getSettingsDir = function() os.execute("mkdir -p /tmp/coop_settings"); return "/tmp/coop_settings" end, getDataDir = function() os.execute("mkdir -p /tmp/coop_data"); return "/tmp/coop_data" end })
preload("logger", { info = function() end })
preload("gettext", function(s) return s end)
package.preload.gettext = function() return function(s) return s end end
preload("json", require("json"))

-- ltn12 / socket.http: real HTTP through curl (works on localhost)
preload("ltn12", { source = { string = function(s) return { s = s } end }, sink = { table = function(t) return { t = t } end } })
local socket = { gettime = function() return S.clock end, dns = { toip = function() return "127.0.0.1" end } }
local http = { TIMEOUT = 60 }
function http.request(req)
  local hdrs = {}
  for k, v in pairs(req.headers or {}) do if k ~= "Content-Length" then hdrs[#hdrs + 1] = string.format(" -H '%s: %s'", k, v) end end
  local bodyf, outf, data = os.tmpname(), os.tmpname(), ""
  if req.source then local f = io.open(bodyf, "wb"); f:write(req.source.s); f:close(); data = " --data-binary @" .. bodyf end
  local p = io.popen(string.format("curl -s -m 30 -X %s%s%s -o %s -w '%%{http_code}' '%s'", req.method, table.concat(hdrs), data, outf, req.url))
  local code = tonumber(p:read("*a")); p:close()
  local f = io.open(outf, "rb"); local res = f and f:read("*a") or ""; if f then f:close() end
  os.remove(bodyf); os.remove(outf)
  if not code or code == 0 then return nil, "connection refused" end
  req.sink.t[#req.sink.t + 1] = res
  return 1, code, {}
end
-- LAN transfer: a fake local interface and a fake listening socket whose clients the tests script
socket.udp = function() return { setpeername = function() return 1 end, getsockname = function() return "192.168.1.50", 5555 end, close = function() end } end
S.lan_queue = {}
socket.bind = function()
  local srv = { closed = false }
  function srv:settimeout() end
  function srv:getsockname() return "0.0.0.0", 40123 end
  function srv:accept() return table.remove(S.lan_queue, 1) end
  function srv:close() self.closed = true end
  S.lan_server = srv; return srv
end
function S.fake_client(lines) local c = { out = {}, closed = false }
  function c:settimeout() end
  function c:receive() return table.remove(lines, 1) end
  function c:send(x) self.out[#self.out + 1] = x end
  function c:close() self.closed = true end
  return c
end
preload("socket", socket); preload("socket.http", http)
package.preload["ssl.https"] = function() error("no luasec in tests") end
-- minimal lfs
local lfs = {}
function lfs.attributes(p, what)
  local f = io.open(p, "rb")
  if not f then local h = io.popen("test -d '" .. p .. "' && echo d"); local r = h:read("*a"); h:close(); if r:find("d") then return what == "mode" and "directory" or { mode = "directory" } end return nil end
  local size = f:seek("end"); f:close()
  if what == "mode" then return "file" elseif what == "size" then return size end
  return { mode = "file", size = size }
end
function lfs.mkdir(p) os.execute("mkdir -p '" .. p .. "'"); return true end
function lfs.dir(p)
  local h = io.popen("ls -a '" .. p .. "' 2>/dev/null"); local list = {}
  for l in h:lines() do list[#list + 1] = l end; h:close()
  local i = 0; return function() i = i + 1; return list[i] end, nil
end
preload("libs/libkoreader-lfs", lfs)
-- ReaderUI: records requests to open a book
preload("apps/reader/readerui", { instance = nil, showReader = function(_, path) S.opened[#S.opened + 1] = path end })
return S
