-- Minimal JSON for the Lua test harness (KOReader provides its own `json` module on devices).
local J = {}
local esc = { ['"'] = '\\"', ['\\'] = '\\\\', ['\n'] = '\\n', ['\r'] = '\\r', ['\t'] = '\\t' }
local function enc(v)
  local t = type(v)
  if t == "nil" then return "null" elseif t == "boolean" or t == "number" then
    if t == "number" and v == math.floor(v) and math.abs(v) < 2^53 then return string.format("%d", v) end
    return tostring(v)
  elseif t == "string" then return '"' .. v:gsub('[%c"\\]', function(c) return esc[c] or string.format("\\u%04x", c:byte()) end) .. '"'
  elseif t == "table" then
    if #v > 0 or next(v) == nil then local o = {}; for i, x in ipairs(v) do o[i] = enc(x) end; return "[" .. table.concat(o, ",") .. "]" end
    local o = {}; for k, x in pairs(v) do o[#o + 1] = enc(tostring(k)) .. ":" .. enc(x) end; return "{" .. table.concat(o, ",") .. "}"
  end
end
J.encode = enc
function J.decode(s)
  local i = 1
  local function ws() i = s:find("%S", i) or #s + 1 end
  local val
  local function str()
    local out = {}; i = i + 1
    while true do
      local c = s:sub(i, i)
      if c == '"' then i = i + 1; break
      elseif c == "\\" then local n = s:sub(i + 1, i + 1)
        if n == "u" then out[#out + 1] = utf8.char(tonumber(s:sub(i + 2, i + 5), 16)); i = i + 6
        else out[#out + 1] = ({ n = "\n", r = "\r", t = "\t", b = "\b", f = "\f" })[n] or n; i = i + 2 end
      else out[#out + 1] = c; i = i + 1 end
    end
    return table.concat(out)
  end
  function val()
    ws(); local c = s:sub(i, i)
    if c == "{" then local o = {}; i = i + 1; ws(); if s:sub(i, i) == "}" then i = i + 1; return o end
      while true do ws(); local k = str(); ws(); i = i + 1; o[k] = val(); ws(); local d = s:sub(i, i); i = i + 1; if d == "}" then return o end end
    elseif c == "[" then local a = {}; i = i + 1; ws(); if s:sub(i, i) == "]" then i = i + 1; return a end
      while true do a[#a + 1] = val(); ws(); local d = s:sub(i, i); i = i + 1; if d == "]" then return a end end
    elseif c == '"' then return str()
    elseif s:sub(i, i + 3) == "true" then i = i + 4; return true
    elseif s:sub(i, i + 4) == "false" then i = i + 5; return false
    elseif s:sub(i, i + 3) == "null" then i = i + 4; return nil
    else local n = s:match("^-?%d+%.?%d*[eE]?[+-]?%d*", i); i = i + #n; return tonumber(n) end
  end
  return val()
end
return J
