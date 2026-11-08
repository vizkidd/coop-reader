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
    if self.is_connected and self.is_syncing then
        local p = self:getCurrentPage()
        self:logDebug("Syncing initial page: " .. tostring(p))
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
                end,
            },
            {
                text = "Test Relay Connection",
                callback = function()
                    self:testConnection()
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
function CoopReader:httpRequest(url, method, post_body, timeout)
    method = method or "GET"
    timeout = timeout or 4
    local response_body = {}
    
    -- 1. Try LuaSocket / LuaSec
    local ok, status, headers, err_str = pcall(function()
        local is_https = url:sub(1, 8) == "https://"
        local request_fn = (is_https and https and https.request) or http.request
        
        local req = {
            url = url,
            method = method,
            sink = ltn12.sink.table(response_body),
            timeout = timeout,
            headers = {
                ["User-Agent"] = "KOReader-CoopReader/1.0",
                ["Accept"] = "application/json",
            }
        }
        
        if method == "POST" and post_body then
            req.headers["Content-Type"] = "application/json"
            req.headers["Content-Length"] = string.len(post_body)
            req.source = ltn12.source.string(post_body)
        end
        
        local _, code, hdrs = request_fn(req)
        return code, hdrs
    end)
    
    local body = table.concat(response_body)
    if ok and status and type(status) == "number" then
        return body, status, nil
    end

    -- 2. Fallback to Kindle system curl binary if available
    self:logDebug("LuaSocket failed, attempting system curl fallback for: " .. url)
    local curl_cmd = nil
    local escaped_url = string.format("%q", url)
    if method == "POST" and post_body then
        local escaped_data = string.format("%q", post_body)
        curl_cmd = string.format("curl -s -m %d --max-time %d -X POST -H 'Content-Type: application/json' -d %s %s 2>/dev/null", timeout, timeout, escaped_data, escaped_url)
    else
        curl_cmd = string.format("curl -s -m %d --max-time %d %s 2>/dev/null", timeout, timeout, escaped_url)
    end
    
    local handle = io.popen(curl_cmd)
    if handle then
        local curl_out = handle:read("*a")
        handle:close()
        if curl_out and #curl_out > 0 then
            return curl_out, 200, nil
        end
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
    self:logDebug("Creating new reading session as Host...", true)

    local chars = "abcdefghijklmnopqrstuvwxyz0123456789"
    local suffix = ""
    math.randomseed(os.time())
    for i = 1, 6 do
        local r = math.random(1, #chars)
        suffix = suffix .. chars:sub(r, r)
    end
    local room_id = "kroom-" .. suffix
    local wifi_ip = self:getWifiIp()

    -- Register 4-digit PIN on Cloudflare relay
    local pin_create_url = self.relay_base_url .. "/pin/create"
    local req_body = json.encode({ room = room_id, key = "" })
    local res, status, err = self:httpRequest(pin_create_url, "POST", req_body, 5)

    local pin = nil
    local relay_registered = false
    if res then
        local ok, data = pcall(function() return json.decode(res) end)
        if ok and data and data.ok and data.pin then
            pin = tostring(data.pin)
            relay_registered = true
        end
    end

    if not pin then
        -- Fallback to local daemon
        local d_create_url = self.daemon_base_url .. "/pin/create"
        local d_res = self:httpRequest(d_create_url, "POST", req_body, 2)
        if d_res then
            local ok, d_data = pcall(function() return json.decode(d_res) end)
            if ok and d_data and d_data.ok and d_data.pin then
                pin = tostring(d_data.pin)
            end
        end
    end

    if not pin then
        pin = tostring(math.random(1000, 9999))
    end

    self.is_host = true
    self.session_id = room_id
    self.pin = pin
    self.is_connected = true
    self.is_syncing = true

    self:logDebug(string.format("Hosting session: %s (PIN: %s, Registered: %s)", room_id, pin, tostring(relay_registered)))

    -- Show prominent on-screen dialog with PIN and clear network feedback
    pcall(function()
        local info_text
        if relay_registered then
            info_text = string.format(
                "Session Started & Registered!\n\n" ..
                "==============================\n" ..
                "  KINDLE PIN:   %s\n" ..
                "  Full Code:    %s\n" ..
                "  Wi-Fi IP:     %s\n" ..
                "==============================\n\n" ..
                "Give this 4-digit PIN to your reading partner.\n" ..
                "They can enter it on Chrome (vizkidd.github.io/coop-reader),\n" ..
                "on a mobile phone, or on another Kindle!\n\n" ..
                "Relay: %s\n\n" ..
                "Your page turns will now sync to everyone automatically.",
                pin, room_id, wifi_ip, self.relay_base_url
            )
        else
            info_text = string.format(
                "⚠️ Session Started Locally (Relay Offline)\n\n" ..
                "==============================\n" ..
                "  KINDLE PIN:   %s\n" ..
                "  Full Code:    %s\n" ..
                "  Wi-Fi IP:     %s\n" ..
                "==============================\n\n" ..
                "[WARNING] Could not reach Relay Server:\n" ..
                "%s\n\n" ..
                "vizkidd.github.io/coop-reader will not be able to find this session until the relay is online.\n\n" ..
                "To fix:\n" ..
                "1. Verify Kindle Wi-Fi is connected.\n" ..
                "2. Tap 'Coop Reader Sync' -> 'Set Relay Server URL...'\n" ..
                "3. Enter your deployed Cloudflare Worker URL.",
                pin, room_id, wifi_ip, self.relay_base_url
            )
        end
        local viewer = TextViewer:new{
            title = relay_registered and "Coop Reader — Hosting Session" or "Coop Reader — Relay Warning",
            text = info_text,
        }
        UIManager:show(viewer)
    end)

    -- Broadcast current page to the room
    local cur_page = self:getCurrentPage()
    self.last_page = cur_page
    self:sendPageUpdate(cur_page)
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
        description = "Enter 4-digit PIN (from Host screen)\nor full session code / host ID:",
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
    
    -- Check if input is a 3 to 6 character Short PIN or Word code
    local is_short_pin = (#input_code <= 8 and not input_code:find("%.") and not input_code:find("-"))
    
    if is_short_pin then
        self:logDebug("Resolving short PIN: " .. input_code .. " on relay...")
        
        -- Try Cloudflare relay PIN resolution
        local pin_url = self.relay_base_url .. "/pin/" .. input_code
        local res, status, err = self:httpRequest(pin_url, "GET", nil, 5)
        
        local parsed = nil
        if res then
            pcall(function() parsed = json.decode(res) end)
        end
        
        if parsed and parsed.ok and parsed.room then
            self:logDebug(string.format("PIN %s resolved to room: %s", input_code, parsed.room:sub(1, 8)))
            self:startSession(parsed.room)
            return
        end
        
        -- Try local daemon PIN resolution
        local d_pin_url = self.daemon_base_url .. "/pin/" .. input_code
        local d_res = self:httpRequest(d_pin_url, "GET", nil, 2)
        local d_parsed = nil
        if d_res then
            pcall(function() d_parsed = json.decode(d_res) end)
        end
        if d_parsed and d_parsed.ok and d_parsed.room then
            self:logDebug(string.format("PIN %s resolved via local daemon: %s", input_code, d_parsed.room:sub(1, 8)))
            self:startSession(d_parsed.room)
            return
        end
        
        self:logDebug("Could not resolve PIN " .. input_code .. ". Connecting using it as room name directly.")
    end
    
    -- Direct session code or fallback
    local clean_room = input_code:match("([^.]*)") or input_code
    self:startSession(clean_room)
end

function CoopReader:startSession(room_id)
    self.session_id = room_id
    self.is_connected = true
    self.is_syncing = true
    
    local short_display = room_id:sub(1, 8)
    self:logDebug("Successfully connected to room: " .. short_display, true)
    
    -- Send initial page update if document is currently open
    local current_page = self:getCurrentPage()
    self.last_page = current_page
    self:sendPageUpdate(current_page)
    
    -- Start background non-blocking polling loop
    self:startPolling()
end

function CoopReader:disconnect()
    self.poll_active = false
    self.is_connected = false
    self.session_id = nil
    self:logDebug("Disconnected from Coop Reader session", true)
end

-- ==================== PAGE SYNCHRONIZATION ====================

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
    if not self.is_connected or not self.is_syncing or pageno == self.last_page then
        return
    end
    self.last_page = pageno
    self:logDebug("Local page turned to: " .. tostring(pageno))
    self:sendPageUpdate(pageno)
end

function CoopReader:sendPageUpdate(pageno)
    if not self.session_id then return end
    
    local payload = json.encode({ page = pageno, from = "kindle-koreader" })
    
    -- 1. Push to Cloudflare Relay HTTP endpoint
    local relay_sync_url = self.relay_base_url .. "/room/" .. self.session_id .. "/sync?page=" .. tostring(pageno) .. "&from=kindle"
    self:httpRequest(relay_sync_url, "POST", payload, 2)
    
    -- 2. Also notify local daemon if present
    local daemon_sync_url = self.daemon_base_url .. "/api/sync-page?page=" .. tostring(pageno) .. "&session=" .. self.session_id
    self:httpRequest(daemon_sync_url, "GET", nil, 1)
end

-- Periodic non-blocking poll for Host page changes
function CoopReader:startPolling()
    self.poll_active = true
    self:schedulePoll()
end

function CoopReader:schedulePoll()
    if not self.poll_active or not self.session_id then return end
    
    UIManager:scheduleIn(2, function()
        if not self.poll_active or not self.session_id then return end
        self:pollRemoteState()
        self:schedulePoll()
    end)
end

function CoopReader:pollRemoteState()
    if not self.is_connected or not self.is_syncing or not self.session_id then return end
    
    local poll_url = self.relay_base_url .. "/room/" .. self.session_id .. "/state"
    local res, status = self:httpRequest(poll_url, "GET", nil, 2)
    
    if res and status == 200 then
        local data = nil
        pcall(function() data = json.decode(res) end)
        if data and data.ok and data.page then
            local remote_page = tonumber(data.page)
            local my_page = self:getCurrentPage()
            
            if remote_page and remote_page > 0 and remote_page ~= my_page and remote_page ~= self.last_page then
                self:logDebug(string.format("Host changed page to: %d (local: %d). Jumping...", remote_page, my_page))
                self.last_page = remote_page
                
                -- Programmatically navigate to remote page in KOReader
                pcall(function()
                    self.ui:handleEvent(Event:new("GotoPage", remote_page))
                end)
                
                self:logDebug(string.format("Jumped to page %d to follow host", remote_page), true)
            end
        end
    end
end

function CoopReader:onCloseDocument()
    if self.is_connected then
        self:logDebug("Document closed, maintaining session state")
    end
end

return CoopReader
