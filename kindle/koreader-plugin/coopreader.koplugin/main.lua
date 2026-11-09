--[[
    Coop Reader Sync Plugin for KOReader
    Allows reading together with desktop and mobile peers running Coop Reader.
    Synchronizes page turns in both directions via WebSocket relay or local bridge.
--]]

local Dispatcher = require("dispatcher")
local Event = require("ui/event")
local InfoMessage = require("ui/widget/infomessage")
local InputDialog = require("ui/widget/inputdialog")
local TextViewer = require("ui/widget/textviewer")
local UIManager = require("ui/uimanager")
local WidgetContainer = require("ui/widget/container/widgetcontainer")
local json = require("json")
local logger = require("logger")

local socket = require("socket")
local http = require("socket.http")
local https = nil
pcall(function() https = require("ssl.https") end)
local ltn12 = require("ltn12")

local NetworkMgr = nil
pcall(function() NetworkMgr = require("ui/network/manager") end)

local CoopReader = WidgetContainer:extend{
    name = "coopreader",
    is_doc_only = false,
    session_id = nil,
    relay_base_url = "https://coop-relay.coop-reader.workers.dev",
    daemon_base_url = "http://127.0.0.1:8765",
    is_connected = false,
    is_syncing = true,
    last_page = 1,
    poll_active = false,
    poll_scheduled = false,
    debug_logs = {},
    max_logs = 60,
    log_file_path = "/tmp/coopreader_debug.log",
    history = {},
    is_host = false,
    pin = nil,
    http_token = nil,
    peer_id = nil,
    peer_role = nil,
    relay_key = nil,
    peer_profiles = {},
    session_generation = 0,
    applying_remote_page = false,
    peer_count = 0,
    http_client_count = 0,
    last_sync_time = nil,
    last_poll_status = "none",
    sync_success_count = 0,
    sync_fail_count = 0,
    first_sync_shown = false,
}

-- ==================== INITIALIZATION & MENU ====================

function CoopReader:init()
    self:loadSettings()
    self:logDebug("Plugin initialized (Relay: " .. tostring(self.relay_base_url) .. ")")
    self.ui.menu:registerToMainMenu(self)
end

function CoopReader:loadSettings()
    local paths = {
        "/mnt/us/koreader/settings/coopreader.json",
        "/mnt/us/extensions/coop-reader/settings.json",
        "/tmp/coopreader_settings.json"
    }
    for _, path in ipairs(paths) do
        local f = io.open(path, "r")
        if f then
            local content = f:read("*a")
            f:close()
            local ok, data = pcall(function() return json.decode(content) end)
            if ok and data and type(data) == "table" then
                if data.relay_base_url and #data.relay_base_url > 0 then
                    self.relay_base_url = data.relay_base_url
                    self:logDebug("Loaded relay URL: " .. self.relay_base_url)
                end
                return
            end
        end
    end
end

function CoopReader:saveSettings()
    local data = { relay_base_url = self.relay_base_url }
    local content = json.encode(data)
    local paths = {
        "/mnt/us/koreader/settings/coopreader.json",
        "/mnt/us/extensions/coop-reader/settings.json",
        "/tmp/coopreader_settings.json"
    }
    for _, path in ipairs(paths) do
        local f = io.open(path, "w")
        if f then
            f:write(content)
            f:close()
            self:logDebug("Saved settings to " .. path)
            return true
        end
    end
    return false
end

function CoopReader:getWifiIp()
    local ip = nil
    if NetworkMgr then
        pcall(function()
            if NetworkMgr.getWifiIp then ip = NetworkMgr:getWifiIp() end
            if not ip and NetworkMgr.getIp then ip = NetworkMgr:getIp() end
        end)
    end
    if ip and #ip > 0 and ip ~= "127.0.0.1" then return ip end

    local handle = io.popen("ip -4 addr show wlan0 2>/dev/null | grep -o 'inet [0-9.]*' | cut -d' ' -f2 || ifconfig wlan0 2>/dev/null | grep -o 'inet addr:[0-9.]*' | cut -d: -f2")
    if handle then
        local out = handle:read("*a")
        handle:close()
        if out then
            out = out:gsub("%s+", "")
            if #out > 0 then return out end
        end
    end
    return "Wi-Fi (Active)"
end

function CoopReader:onReaderReady()
    self:logDebug("Reader is ready with active document")
    if self.is_connected then
        local p = self:getCurrentPage()
        self:logDebug("Publishing initial page/status: " .. tostring(p))
        self:sendPageUpdate(p)
    end
end

function CoopReader:addToMainMenu(menu_items)
    menu_items.coop_reader = {
        text = "Coop Reader Sync",
        sorting_hint = "tools",
        sub_item_table = {
            {
                text = "Host New Session (Create PIN)...",
                callback = function()
                    self:promptHostSession()
                end,
            },
            {
                text = "Join Reading Session (PIN or Code)...",
                callback = function()
                    self:promptJoinSession()
                end,
            },
            {
                text = "Set Relay Server URL...",
                callback = function()
                    self:promptSetRelayUrl()
                end,
            },
            {
                text = "Toggle Page Sync",
                checked_func = function()
                    return self.is_syncing
                end,
                callback = function()
                    self.is_syncing = not self.is_syncing
                    local msg = self.is_syncing and "Coop Reader: Sync Active (Following Host)" or "Coop Reader: Detached (Reading Independently)"
                    self:logDebug(msg, true)
                    if self.is_connected then
                        if self.is_syncing and not self.is_host then
                            self:sendRelayMessage(self.session_id, { type = "REQ_SYNC" })
                        else
                            self:sendPageUpdate(self:getCurrentPage())
                        end
                    end
                end,
            },
            {
                text = "Test Relay Connection",
                callback = function()
                    self:testConnection()
                end,
            },
            {
                text = "Session Status",
                enabled_func = function()
                    return self.session_id ~= nil
                end,
                callback = function()
                    self:showSessionStatus()
                end,
            },
            {
                text = "View Debug Log",
                callback = function()
                    self:showDebugLog()
                end,
            },
            {
                text = "Disconnect Session",
                enabled_func = function()
                    return self.session_id ~= nil
                end,
                callback = function()
                    self:disconnect()
                end,
            },
        }
    }
end

function CoopReader:promptSetRelayUrl()
    local dialog
    dialog = InputDialog:new{
        title = "Set Relay Server URL",
        input = self.relay_base_url,
        input_type = "string",
        description = "Enter Cloudflare Worker HTTPS URL:\n(e.g., https://coop-relay.YOUR_NAME.workers.dev)",
        buttons = {
            {
                {
                    text = "Reset Default",
                    callback = function()
                        self.relay_base_url = "https://coop-relay.coop-reader.workers.dev"
                        self:saveSettings()
                        UIManager:close(dialog)
                        self:logDebug("Reset relay URL to default", true)
                        self:testConnection()
                    end,
                },
                {
                    text = "Cancel",
                    id = "cancel",
                    callback = function()
                        UIManager:close(dialog)
                    end,
                },
                {
                    text = "Save",
                    is_positive = true,
                    is_enter_default = true,
                    callback = function()
                        local new_url = dialog:getInputText()
                        UIManager:close(dialog)
                        if new_url and #new_url > 0 then
                            new_url = new_url:gsub("%s+", ""):gsub("/+$", "")
                            if not new_url:find("^https?://") then
                                new_url = "https://" .. new_url
                            end
                            self.relay_base_url = new_url
                            self:saveSettings()
                            self:logDebug("Updated Relay Server URL to: " .. self.relay_base_url, true)
                            self:testConnection()
                        end
                    end,
                },
            },
        },
    }
    UIManager:show(dialog)
    dialog:onShowKeyboard()
end

-- ==================== LOGGING & DIAGNOSTICS ====================

function CoopReader:logDebug(msg, show_toast)
    local timestamp = os.date("%H:%M:%S")
    local line = string.format("[%s] %s", timestamp, tostring(msg))
    
    -- In-memory log buffer
    table.insert(self.debug_logs, line)
    if #self.debug_logs > self.max_logs then
        table.remove(self.debug_logs, 1)
    end
    
    -- Print to logger/stdout
    pcall(function() logger.info("CoopReader: " .. line) end)
    print("CoopReader: " .. line)
    
    -- Append to debug log file
    pcall(function()
        local f = io.open(self.log_file_path, "a")
        if f then
            f:write(line .. "\n")
            f:close()
        end
    end)
    
    -- Optional toast notification on e-ink screen
    if show_toast then
        pcall(function()
            UIManager:show(InfoMessage:new{ text = tostring(msg), timeout = 3 })
        end)
    end
end

function CoopReader:showDebugLog()
    local text = table.concat(self.debug_logs, "\n")
    if #text == 0 then
        text = "No debug messages recorded yet.\nTap 'Test Relay Connection' or 'Join Reading Session' to generate activity."
    end
    
    pcall(function()
        local viewer = TextViewer:new{
            title = "Coop Reader Debug Log",
            text = text,
        }
        UIManager:show(viewer)
    end)
end

function CoopReader:showSessionStatus()
    local lines = {}
    table.insert(lines, "═══════════════════════════════════")
    table.insert(lines, "  COOP READER SESSION STATUS")
    table.insert(lines, "═══════════════════════════════════")
    table.insert(lines, "")

    if self.session_id then
        table.insert(lines, "Room ID:     " .. tostring(self.session_id))
        table.insert(lines, "Host ID:     " .. tostring(self.session_id))
    else
        table.insert(lines, "Room ID:     (not connected)")
    end

    table.insert(lines, "Role:        " .. (self.is_host and "HOST" or "PEER"))
    table.insert(lines, "Peer ID:     " .. tostring(self.peer_id or "(none)"))
    if self.pin then
        table.insert(lines, "Kindle PIN:  " .. tostring(self.pin))
    elseif self.is_host then
        table.insert(lines, "Kindle PIN:  unavailable (share full room code)")
    end
    table.insert(lines, "Connected:   " .. (self.is_connected and "YES" or "NO"))
    table.insert(lines, "Page Sync:   " .. (self.is_syncing and "ACTIVE" or "DETACHED"))
    table.insert(lines, "")

    table.insert(lines, "--- Connection Details ---")
    table.insert(lines, "Relay URL:   " .. tostring(self.relay_base_url))
    table.insert(lines, "Wi-Fi IP:    " .. tostring(self:getWifiIp()))
    table.insert(lines, "Local Page:  " .. tostring(self:getCurrentPage()))
    table.insert(lines, "Last Synced: " .. tostring(self.last_page))
    table.insert(lines, "")

    table.insert(lines, "--- Peers ---")
    table.insert(lines, "WebSocket:   " .. tostring(self.peer_count) .. " peer(s)")
    table.insert(lines, "HTTP/Kindle: " .. tostring(self.http_client_count) .. " peer(s)")
    table.insert(lines, "Total:       " .. tostring(self.peer_count + self.http_client_count) .. " peer(s)")
    table.insert(lines, "Transport:   Authenticated HTTP mailbox")
    table.insert(lines, "")

    table.insert(lines, "--- Sync Statistics ---")
    table.insert(lines, "Poll Status: " .. tostring(self.last_poll_status))
    table.insert(lines, "Syncs OK:    " .. tostring(self.sync_success_count))
    table.insert(lines, "Syncs Fail:  " .. tostring(self.sync_fail_count))
    if self.last_sync_time then
        table.insert(lines, "Last Sync:   " .. os.date("%H:%M:%S", self.last_sync_time))
    else
        table.insert(lines, "Last Sync:   (never)")
    end
    table.insert(lines, "")
    table.insert(lines, "Polling:     " .. (self.poll_active and "ACTIVE (every 2s)" or "STOPPED"))

    local text = table.concat(lines, "\n")
    pcall(function()
        local viewer = TextViewer:new{
            title = "Coop Reader — Session Status",
            text = text,
        }
        UIManager:show(viewer)
    end)
end

function CoopReader:testConnection()
    self:logDebug("Testing connection to: " .. self.relay_base_url, true)
    
    self:ensureNetwork(function()
        local url = self.relay_base_url .. "/room/__test_ping__/state"
        local res, status, err = self:httpRequest(url, "GET", nil, 5)
        
        if status == 200 or status == 404 or (res and #res > 0) then
            local msg = string.format("Relay is reachable! (HTTP status: %s)\nURL: %s", tostring(status), self.relay_base_url)
            self:logDebug(msg, true)
            pcall(function()
                UIManager:show(InfoMessage:new{ text = "✓ Relay Connected!\n" .. self.relay_base_url, timeout = 4 })
            end)
        else
            -- Try local daemon fallback
            local d_url = self.daemon_base_url .. "/api/status"
            local d_res, d_status = self:httpRequest(d_url, "GET", nil, 2)
            if d_status == 200 then
                self:logDebug("Relay unreachable, but local daemon is active on 127.0.0.1:8765", true)
                pcall(function()
                    UIManager:show(InfoMessage:new{ text = "Local daemon active (127.0.0.1:8765)\nRelay offline: " .. self.relay_base_url, timeout = 5 })
                end)
            else
                local err_msg = string.format("Cannot connect to:\n%s\nError: %s (Status: %s)\nUse 'Set Relay Server URL' to update.", self.relay_base_url, tostring(err), tostring(status))
                self:logDebug(err_msg, true)
                pcall(function()
                    UIManager:show(InfoMessage:new{ text = "✗ Relay Unreachable!\n" .. self.relay_base_url .. "\nCheck Wi-Fi or update Relay URL under menu.", timeout = 6 })
                end)
            end
        end
    end)
end

-- ==================== NETWORK & WI-FI CHECK ====================

function CoopReader:ensureNetwork(callback)
    if not NetworkMgr then
        self:logDebug("NetworkMgr unavailable, proceeding directly")
        callback()
        return
    end

    local is_connected = false
    pcall(function() is_connected = NetworkMgr:isConnected() end)
    
    if not is_connected then
        self:logDebug("Wi-Fi is disconnected. Prompting to connect...", true)
        pcall(function()
            NetworkMgr:runWhenOnline(function()
                self:logDebug("Wi-Fi connected successfully")
                callback()
            end)
        end)
    else
        self:logDebug("Wi-Fi is connected")
        callback()
    end
end

-- Safe HTTP/HTTPS request with LuaSec and cURL fallback
local function shellQuote(value)
    return "'" .. tostring(value):gsub("'", "'\\''") .. "'"
end

function CoopReader:httpRequest(url, method, post_body, timeout, extra_headers)
    method = method or "GET"
    timeout = timeout or 4
    extra_headers = extra_headers or {}
    local response_body = {}
    local request_headers = {
        ["User-Agent"] = "KOReader-CoopReader/2.0",
        ["Accept"] = "application/json",
    }
    for key, value in pairs(extra_headers) do request_headers[key] = value end

    -- Prefer KOReader's LuaSocket/LuaSec stack.
    local ok, status, headers, err_str = pcall(function()
        local is_https = url:sub(1, 8) == "https://"
        local request_fn = (is_https and https and https.request) or http.request
        local req = {
            url = url,
            method = method,
            sink = ltn12.sink.table(response_body),
            timeout = timeout,
            headers = request_headers,
        }
        if post_body ~= nil and method ~= "GET" then
            req.headers["Content-Type"] = "application/json"
            req.headers["Content-Length"] = tostring(string.len(post_body))
            req.source = ltn12.source.string(post_body)
        end
        local _, code, hdrs = request_fn(req)
        return code, hdrs
    end)

    local body = table.concat(response_body)
    local numeric_status = tonumber(status)
    if ok and numeric_status then return body, numeric_status, nil end

    -- Kindle firmware versions differ in their LuaSec availability. Fall back
    -- to curl without using shell-interpolated, double-quoted user input.
    self:logDebug("LuaSocket/LuaSec unavailable; trying curl for " .. tostring(url))
    local parts = {
        "curl -sS --connect-timeout " .. tostring(timeout) .. " --max-time " .. tostring(timeout),
        "-X " .. shellQuote(method),
    }
    for key, value in pairs(request_headers) do
        table.insert(parts, "-H " .. shellQuote(tostring(key) .. ": " .. tostring(value)))
    end
    if post_body ~= nil and method ~= "GET" then
        table.insert(parts, "--data-binary " .. shellQuote(post_body))
    end
    table.insert(parts, "-w " .. shellQuote("\\n%{http_code}"))
    table.insert(parts, shellQuote(url) .. " 2>/dev/null")
    local handle = io.popen(table.concat(parts, " "))
    if handle then
        local output = handle:read("*a") or ""
        handle:close()
        local code = output:match("(%d%d%d)%s*$")
        if code then
            local response = output:sub(1, #output - #code):gsub("\n$", "")
            return response, tonumber(code), nil
        end
        if #output > 0 then return output, 200, nil end
    end
    return nil, 0, tostring(status or err_str or "Request failed")
end

-- ==================== SESSION HOST, JOIN & SHORT CODES ====================

function CoopReader:promptHostSession()
    self:ensureNetwork(function()
        self:startHostingSession()
    end)
end

function CoopReader:startHostingSession()
    if self.is_connected then self:disconnect() end
    self:logDebug("Creating a relay-backed KOReader session...", true)

    local chars = "abcdefghijklmnopqrstuvwxyz0123456789"
    local suffix = ""
    math.randomseed(os.time() + math.floor((socket.gettime and socket.gettime() or 0) * 1000))
    for i = 1, 8 do
        local r = math.random(1, #chars)
        suffix = suffix .. chars:sub(r, r)
    end
    local room_id = "kroom-" .. suffix
    local ok = self:startSession(room_id, "host")
    if not ok then return end

    -- PINs are created only in the shared relay registry. Never display a
    -- locally fabricated code that other devices cannot resolve.
    local pin_url = self.relay_base_url:gsub("/+$", "") .. "/pin/create"
    local pin_body = json.encode({ room = room_id, key = "" })
    local res, status, err = self:httpRequest(pin_url, "POST", pin_body, 5)
    local data = nil
    if res and status == 200 then pcall(function() data = json.decode(res) end) end
    self.pin = (data and data.ok and data.pin) and tostring(data.pin) or nil
    if self.pin then self:logDebug("Relay PIN registered: " .. self.pin)
    else self:logDebug("Room is active, but relay PIN registration failed: " .. tostring(err or status), true) end

    local current_page = self:getCurrentPage()
    self.last_page = current_page
    self:sendPageUpdate(current_page)

    local info_text = string.format(
        "Relay-backed session is active.\n\nRoom ID:\n%s\n\n%s\n\nFull room code:\n%s\n\nRelay:\n%s\n\nPeer count will update in Session Status. Keep KOReader open and connected to Wi-Fi.",
        room_id,
        self.pin and ("Kindle PIN:\n" .. self.pin) or "Kindle PIN: unavailable — share the full room code",
        room_id,
        self.relay_base_url
    )
    pcall(function()
        UIManager:show(TextViewer:new{ title = "Coop Reader — Hosting Session", text = info_text })
    end)
end

function CoopReader:promptJoinSession()
    -- Explicitly verify Wi-Fi connection BEFORE showing session code dialog
    self:ensureNetwork(function()
        self:showJoinDialog()
    end)
end

function CoopReader:showJoinDialog()
    local dialog
    dialog = InputDialog:new{
        title = "Join Coop Reader Session",
        input = self.session_id or "",
        input_type = "string",
        description = "Enter 4–8 digit PIN (from Host screen)\nor full session code / host ID:",
        buttons = {
            {
                {
                    text = "Cancel",
                    id = "cancel",
                    callback = function()
                        UIManager:close(dialog)
                    end,
                },
                {
                    text = "Join",
                    is_positive = true,
                    is_enter_default = true,
                    callback = function()
                        local code = dialog:getInputText()
                        UIManager:close(dialog)
                        if code and #code > 0 then
                            self:resolveAndConnect(code:gsub("%s+", ""))
                        end
                    end,
                },
            },
        },
    }
    UIManager:show(dialog)
    dialog:onShowKeyboard()
end

function CoopReader:resolveAndConnect(input_code)
    self:logDebug("Processing session code: " .. input_code, true)
    input_code = tostring(input_code or ""):gsub("%s+", "")
    if input_code == "" then return false end

    local is_short_pin = input_code:match("^%d%d%d%d%d?%d?%d?%d?$") ~= nil
    if is_short_pin then
        self:logDebug("Resolving relay PIN " .. input_code)
        local pin_url = self.relay_base_url:gsub("/+$", "") .. "/pin/" .. input_code
        local res, status, err = self:httpRequest(pin_url, "GET", nil, 5)
        local parsed = nil
        if res and status == 200 then pcall(function() parsed = json.decode(res) end) end
        if not (parsed and parsed.ok and parsed.room) then
            self:logDebug("PIN lookup failed (HTTP " .. tostring(status) .. "): " .. tostring(err), true)
            UIManager:show(InfoMessage:new{
                text = "That PIN was not found on the configured relay. Check the PIN and relay URL, or ask the host to share the full room code.",
                timeout = 6
            })
            return false
        end
        return self:startSession(parsed.room, "guest", parsed.key or "")
    end

    local room_id, key = input_code:match("^([%w_-]+)%.([%w_%-]+)$")
    if not room_id then room_id = input_code:match("^([%w_-]+)$") end
    if not room_id then
        UIManager:show(InfoMessage:new{ text = "Invalid room code. Enter the short PIN or room-id[.key] code.", timeout = 5 })
        return false
    end
    return self:startSession(room_id, "guest", key or "")
end

function CoopReader:roomUrl(suffix)
    return self.relay_base_url:gsub("/+$", "") .. "/room/" .. tostring(self.session_id or "") .. (suffix or "")
end

function CoopReader:authHeaders()
    if not self.http_token then return {} end
    return { Authorization = "Bearer " .. self.http_token }
end

function CoopReader:registerHttpPeer()
    if not self.session_id or not self.peer_id or not self.peer_role then return false end
    local body = json.encode({
        id = self.peer_id,
        role = self.peer_role,
        name = "Kindle KOReader",
        token = self.http_token or nil,
    })
    local res, status, err = self:httpRequest(self:roomUrl("/http/join"), "POST", body, 5)
    local data = nil
    if res and status == 200 then pcall(function() data = json.decode(res) end) end
    if not (data and data.ok and data.token) then
        self:logDebug("Relay registration failed (HTTP " .. tostring(status) .. "): " .. tostring((data and data.error) or err or "no response"), true)
        self.http_token = nil
        return false
    end
    self.http_token = data.token
    self.peer_count = tonumber(data.clients) or 0
    self.http_client_count = math.max(0, (tonumber(data.httpClients) or 0) - 1) -- exclude this HTTP peer
    self:logDebug("Registered relay mailbox as " .. self.peer_role .. " (" .. tostring(self.peer_id) .. ")")
    return true, data
end

function CoopReader:sendRelayMessage(to, message)
    if not self.is_connected or not self.http_token or not self.peer_id then return false end
    local body = json.encode({ id = self.peer_id, to = to or self.session_id, p = message })
    local res, status, err = self:httpRequest(self:roomUrl("/http/send"), "POST", body, 4, self:authHeaders())
    if status == 200 and res then
        local data = nil
        pcall(function() data = json.decode(res) end)
        if data and data.ok then return true end
        self:logDebug("Relay accepted request but did not confirm delivery")
        return true
    end
    self:logDebug("Relay send failed (HTTP " .. tostring(status) .. "): " .. tostring(err or res or "no response"))
    return false
end

function CoopReader:applyRemotePage(page)
    local remote_page = tonumber(page)
    if not remote_page or remote_page < 1 then return end
    remote_page = math.floor(remote_page)
    if remote_page == self:getCurrentPage() then
        self.last_page = remote_page
        return
    end
    self.last_page = remote_page
    self.applying_remote_page = true
    pcall(function() self.ui:handleEvent(Event:new("GotoPage", remote_page)) end)
    self.applying_remote_page = false
    self:logDebug("Applied host page " .. tostring(remote_page))
end

function CoopReader:handleRelayMessage(frame)
    if type(frame) ~= "table" then return end
    local from = tostring(frame.from or self.session_id or "")
    if frame.left then
        self.peer_profiles[from] = nil
        self:logDebug("Peer left the session: " .. from)
        return
    end
    local payload = frame.p or frame.payload or {}
    if type(payload) ~= "table" then return end
    if payload.raw and type(payload.raw) == "string" then
        local ok, decoded = pcall(function() return json.decode(payload.raw) end)
        if not ok or type(decoded) ~= "table" then return end
        payload = decoded
    elseif payload.e then
        self:logDebug("Received an encrypted browser message this KOReader plugin cannot decrypt", true)
        return
    end

    local kind = payload.type
    if kind == "RELAY_HELLO" then
        if self.is_host then
            self.peer_profiles[from] = self.peer_profiles[from] or { name = payload.name or "Reader" }
            self:sendRelayMessage(from, { type = "PROFILE", peerId = self.peer_id, name = "Kindle KOReader" })
            self:sendRelayMessage(from, { type = "SYNC", state = { currentPage = self:getCurrentPage() } })
        end
    elseif kind == "REQ_SYNC" then
        if self.is_host then
            self:sendRelayMessage(from, { type = "SYNC", state = { currentPage = self:getCurrentPage() } })
            self:sendRelayMessage(from, { type = "PAGE_CHANGE", page = self:getCurrentPage() })
        end
    elseif kind == "SYNC" then
        if not self.is_host and self.is_syncing then
            local state = payload.state or {}
            self:applyRemotePage(state.currentPage or state.page)
        end
    elseif kind == "PAGE_CHANGE" then
        -- PAGE_CHANGE is authoritative and may only come from the room host.
        if not self.is_host and from == self.session_id and self.is_syncing then
            self:applyRemotePage(payload.page)
        end
    elseif kind == "PAGE_INFO" then
        if self.is_host then
            self.peer_profiles[from] = self.peer_profiles[from] or {}
            self.peer_profiles[from].page = tonumber(payload.page) or payload.page
            self.peer_profiles[from].detached = payload.detached and true or false
        end
    elseif kind == "PROFILE" then
        self.peer_profiles[from] = self.peer_profiles[from] or {}
        self.peer_profiles[from].name = payload.name or self.peer_profiles[from].name or "Reader"
    elseif kind == "PING" then
        self:sendRelayMessage(from, { type = "PONG", t = payload.t or os.time() })
    elseif kind == "PONG" then
        self.last_poll_status = "OK"
    elseif kind == "AUTH_REQUIRED" then
        -- KOReader's Lua runtime currently has no compatible WebCrypto AES/SHA
        -- implementation. Fail closed instead of leaving a false-connected peer.
        self:disconnect()
        UIManager:show(InfoMessage:new{
            text = "This session requires a password. Password-protected browser sessions are not supported by the KOReader plugin yet. Ask the host to create an unprotected room.",
            timeout = 8
        })
    elseif kind == "HOST_KICK" or kind == "RELAY_CLOSE" then
        if not self.is_host then
            self:logDebug("Host ended this session", true)
            self:disconnect()
        end
    elseif kind == "CHAT" or kind == "ANNOT" or kind == "ANNOT_ALL" then
        self:logDebug("Received " .. tostring(kind) .. "; this message type is not yet rendered in the KOReader UI")
    end
end

function CoopReader:startSession(room_id, role, key)
    role = role or "guest"
    if not room_id or not room_id:match("^[%w_-]+$") then
        self:logDebug("Invalid room ID", true)
        return false
    end
    if self.is_connected then self:disconnect() end

    self.session_generation = (self.session_generation or 0) + 1
    self.session_id = room_id
    self.peer_role = role
    self.is_host = role == "host"
    self.peer_id = self.is_host and room_id or ("khttp-" .. tostring(os.time()) .. tostring(math.random(10000, 99999)))
    self.relay_key = key or ""
    self.http_token = nil
    self.is_connected = false
    self.is_syncing = true
    self.first_sync_shown = false
    self.sync_success_count = 0
    self.sync_fail_count = 0
    self.peer_profiles = {}
    self.peer_count = 0
    self.http_client_count = 0

    local registered, room_data = self:registerHttpPeer()
    if not registered then
        self.session_id = nil
        self.peer_id = nil
        self.peer_role = nil
        self.is_host = false
        self.pin = nil
        self:logDebug("Could not join the relay room. The app has not marked this session connected.", true)
        return false
    end

    self.is_connected = true
    self.last_poll_status = "Connected"
    self.last_page = self:getCurrentPage()
    self:logDebug("Relay mailbox connected: " .. room_id .. " (" .. role .. ")", true)

    if self.is_host then
        self:sendRelayMessage("*", { type = "PROFILE", peerId = self.peer_id, name = "Kindle KOReader" })
        self:sendPageUpdate(self:getCurrentPage())
    else
        self:sendRelayMessage(self.session_id, { type = "RELAY_HELLO", peerId = self.peer_id, name = "Kindle KOReader", transport = "http" })
        self:sendRelayMessage(self.session_id, { type = "REQ_SYNC" })
        self:sendRelayMessage(self.session_id, { type = "PROFILE", peerId = self.peer_id, name = "Kindle KOReader" })
    end

    self:startPolling()
    local peers = (tonumber(room_data.clients) or 0) + (tonumber(room_data.httpClients) or 0) - 1
    if peers < 0 then peers = 0 end
    local info = string.format(
        "%s\nRoom: %s\nPeer count: %d\nCurrent page: %s\nRelay: %s\nTransport: HTTP mailbox",
        self.is_host and "Hosting session" or "Joined session",
        room_id,
        peers,
        tostring(room_data.page or self:getCurrentPage()),
        self.relay_base_url
    )
    UIManager:show(InfoMessage:new{ text = info, timeout = 6 })
    return true
end

function CoopReader:refreshHttpRegistration()
    if not self.session_id or not self.peer_id then return false end
    local ok = self:registerHttpPeer()
    if ok then
        self:logDebug("Relay mailbox registration refreshed")
        return true
    end
    return false
end

function CoopReader:disconnect()
    local room_id = self.session_id
    local peer_id = self.peer_id
    local token = self.http_token
    self.poll_active = false
    self.session_generation = (self.session_generation or 0) + 1
    if room_id and peer_id and token then
        local headers = { Authorization = "Bearer " .. token }
        local url = self.relay_base_url:gsub("/+$", "") .. "/room/" .. room_id .. "/http/leave"
        local body = json.encode({ id = peer_id })
        self:httpRequest(url, "POST", body, 2, headers)
    end
    self.is_connected = false
    self.session_id = nil
    self.peer_id = nil
    self.peer_role = nil
    self.http_token = nil
    self.relay_key = nil
    self.is_host = false
    self.pin = nil
    self.peer_profiles = {}
    self.peer_count = 0
    self.http_client_count = 0
    self.last_poll_status = "disconnected"
    self.first_sync_shown = false
    self:logDebug("Disconnected from Coop Reader session", true)
end

function CoopReader:getCurrentPage()
    local page = 1
    pcall(function()
        if self.ui and self.ui.paging and self.ui.paging.current_page then
            page = self.ui.paging.current_page
        elseif self.view and self.view.state and self.view.state.page then
            page = self.view.state.page
        elseif self.ui and self.ui.document and self.ui.document.getCurrentPage then
            page = self.ui.document:getCurrentPage()
        end
    end)
    return page or 1
end

function CoopReader:onPageUpdate(pageno)
    if not self.is_connected or self.applying_remote_page or pageno == self.last_page then return end
    self.last_page = pageno
    self:logDebug("Local page turned to: " .. tostring(pageno))
    self:sendPageUpdate(pageno)
end

function CoopReader:sendPageUpdate(pageno)
    if not self.is_connected or not self.session_id then return false end
    pageno = math.max(1, math.floor(tonumber(pageno) or self:getCurrentPage()))
    self.last_page = pageno
    local message
    local target
    if self.is_host then
        message = { type = "PAGE_CHANGE", page = pageno }
        target = "*"
    else
        -- A guest reports its position; it must never overwrite the host page.
        message = { type = "PAGE_INFO", page = pageno, detached = not self.is_syncing }
        target = self.session_id
    end
    local ok = self:sendRelayMessage(target, message)
    if ok then
        self.last_sync_time = os.time()
        self.sync_success_count = self.sync_success_count + 1
    else
        self.sync_fail_count = self.sync_fail_count + 1
    end
    -- Preserve local daemon metrics/refresh functionality without using it as
    -- the room transport; the shared relay mailbox is authoritative.
    local daemon_sync_url = self.daemon_base_url .. "/api/sync-page?page=" .. tostring(pageno) .. "&session=" .. self.session_id
    self:httpRequest(daemon_sync_url, "GET", nil, 1)
    return ok
end

function CoopReader:startPolling()
    self.poll_active = true
    self:schedulePoll()
end

function CoopReader:schedulePoll()
    if not self.poll_active or not self.session_id then return end
    local generation = self.session_generation
    UIManager:scheduleIn(2, function()
        if not self.poll_active or not self.session_id or generation ~= self.session_generation then return end
        self:pollRemoteState()
        self:schedulePoll()
    end)
end

function CoopReader:pollRemoteState()
    -- Poll and heartbeat even while detached so the room membership does not expire.
    if not self.is_connected or not self.session_id or not self.http_token then return end
    local url = self:roomUrl("/http/poll?id=" .. self.peer_id)
    local res, status, err = self:httpRequest(url, "GET", nil, 3, self:authHeaders())
    if status == 401 then
        self.last_poll_status = "Re-registering"
        if self:refreshHttpRegistration() then
            self:sendRelayMessage(self.is_host and "*" or self.session_id, { type = self.is_host and "PROFILE" or "REQ_SYNC", peerId = self.peer_id, name = "Kindle KOReader" })
        end
        return
    end
    if not res or status ~= 200 then
        self.last_poll_status = "HTTP " .. tostring(status)
        self.sync_fail_count = self.sync_fail_count + 1
        if self.sync_fail_count > 0 and self.sync_fail_count % 5 == 0 then
            self:logDebug("Relay polling failing: HTTP " .. tostring(status) .. " — " .. tostring(err), true)
        end
        return
    end

    local data = nil
    local ok = pcall(function() data = json.decode(res) end)
    if not ok or type(data) ~= "table" or not data.ok then
        self.last_poll_status = "Parse error"
        self.sync_fail_count = self.sync_fail_count + 1
        return
    end
    self.last_poll_status = "OK"
    self.last_sync_time = os.time()
    self.peer_count = tonumber(data.clients) or 0
    self.http_client_count = tonumber(data.httpClients) or 0
    self.http_client_count = math.max(0, self.http_client_count - 1) -- exclude this HTTP peer

    local messages = data.messages or {}
    for _, frame in ipairs(messages) do self:handleRelayMessage(frame) end

    if not self.first_sync_shown then
        self.first_sync_shown = true
        local total = self.peer_count + self.http_client_count
        self:logDebug(string.format("Relay mailbox active; %d other peer(s)", total), true)
    end
    self.sync_success_count = self.sync_success_count + 1
end

function CoopReader:onCloseDocument()
    if self.is_connected then
        self:logDebug("Document closed, maintaining session state")
    end
end

return CoopReader
