"""Starts the real relay (Node), then runs core_test.lua under Lua 5.4. Usage: python3 tests/lua/run_core_tests.py"""
import os, subprocess, sys, zlib, time
here = os.path.dirname(os.path.abspath(__file__)); root = os.path.dirname(os.path.dirname(here))
sys.path.insert(0, here); import run_lua
book = "/tmp/coop_test_book.bin"
data = bytes((i * 31 + 7) & 255 for i in range(98304 * 2 + 5000))
open(book, "wb").write(data)
fp = "%d-%08x-%08x" % (len(data), zlib.crc32(data[:65536]), zlib.crc32(data[-65536:]))
srv = subprocess.Popen(["node", os.path.join(here, "relay_server.mjs")], stdout=subprocess.PIPE, text=True)
try:
    port = srv.stdout.readline().strip().split("=")[1]
    plugin = os.path.join(root, "kindle/koreader-plugin/coopreader.koplugin")
    ok, out = run_lua.run(open(os.path.join(here, "core_test.lua")).read(), "core_test.lua",
                          {"PORT": port, "BOOK_PATH": book, "FP_EXPECT": fp, "PLUGIN_DIR": plugin, "TESTS_DIR": here})
    print(out); sys.exit(0 if ok else 1)
finally:
    srv.terminate()
