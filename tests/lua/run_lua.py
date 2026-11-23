"""Run a Lua 5.4 chunk through liblua5.4 (ctypes) — there is no `lua` binary here. Used for plugin tests.
usage: run_lua.py [--syntax] file.lua [VAR=value ...]   (VARs are exposed to Lua as global strings)"""
import ctypes, sys, os
lib = ctypes.CDLL("liblua5.4.so.0")
lib.luaL_newstate.restype = ctypes.c_void_p
for fn in ("luaL_openlibs", "lua_close"): getattr(lib, fn).argtypes = [ctypes.c_void_p]
lib.luaL_loadstring.argtypes = [ctypes.c_void_p, ctypes.c_char_p]; lib.luaL_loadstring.restype = ctypes.c_int
lib.lua_pcallk.argtypes = [ctypes.c_void_p, ctypes.c_int, ctypes.c_int, ctypes.c_int, ctypes.c_void_p, ctypes.c_void_p]
lib.lua_tolstring.argtypes = [ctypes.c_void_p, ctypes.c_int, ctypes.c_void_p]; lib.lua_tolstring.restype = ctypes.c_char_p
lib.lua_settop.argtypes = [ctypes.c_void_p, ctypes.c_int]
def run(code, name="chunk", variables=None):
    L = lib.luaL_newstate(); lib.luaL_openlibs(L)
    pre = "".join('%s = %r\n' % (k, v) for k, v in (variables or {}).items())
    pre += """
OUT = {}
local _print = print
print = function(...) local t = {} for i = 1, select('#', ...) do t[#t+1] = tostring((select(i, ...))) end OUT[#OUT+1] = table.concat(t, ' ') end
package.preload.bit = function()
  local m = 0xFFFFFFFF
  return { band = function(a, b) return (a & b) & m end, bxor = function(a, b) return (a ~ b) & m end, rshift = function(a, n) return (a & m) >> n end }
end
"""
    # run inside pcall so the output collected so far is still returned when a test aborts
    src = (pre + "local __ok, __err = pcall(function()\n" + code + "\nend)\nif not __ok then OUT[#OUT+1] = '@@FAILED@@ ' .. tostring(__err) end\nreturn table.concat(OUT, '\\n')").encode()
    if lib.luaL_loadstring(L, src) != 0:
        return False, lib.lua_tolstring(L, -1, None).decode(errors="replace")
    ok = lib.lua_pcallk(L, 0, 1, 0, None, None) == 0
    out = lib.lua_tolstring(L, -1, None); out = out.decode(errors="replace") if out else ""
    if "@@FAILED@@" in out: ok = False
    lib.lua_close(L); return ok, out
if __name__ == "__main__":
    args = sys.argv[1:]; syntax = args and args[0] == "--syntax"
    if syntax: args = args[1:]
    path = args[0]; code = open(path, encoding="utf-8").read()
    if syntax: code = "local f, err = load(" + repr(code)[0:0] + "[==[" + code.replace("]==]", "] ==]") + "]==], '" + os.path.basename(path) + "'); if not f then error(err, 0) end; print('syntax ok')"
    vars_ = dict(a.split("=", 1) for a in args[1:])
    ok, out = run(code, path, vars_); print(out); sys.exit(0 if ok else 1)
