#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
Coop Reader - Kindle Local Daemon & Hardware Bridge
Provides:
  - Local static asset serving for the Kindle web UI
  - Direct access to Kindle's /mnt/us/documents library
  - Native Python EPUB/MOBI text extraction & TOC generator (zero-RAM in browser)
  - Local offline co-reading room hub (sync without internet over local Wi-Fi / hotspot)
  - KOReader sync bridge endpoint (/api/sync-page)
  - E-Ink screen flash (EIPS) control endpoint
  - LIPC power & battery status bridge
  - Zero external dependencies (runs on standard Python 2.7 or 3.x)
"""

import sys
import os
import json
import subprocess
import mimetypes
import argparse
import time
import zipfile
import re
import posixpath
import xml.etree.ElementTree as ET

try:
    # Python 3
    from http.server import HTTPServer, SimpleHTTPRequestHandler
    from socketserver import ThreadingMixIn
    from urllib.parse import urlparse, parse_qs, unquote
except ImportError:
    # Python 2 fallback
    from BaseHTTPServer import HTTPServer
    from SimpleHTTPServer import SimpleHTTPRequestHandler
    from SocketServer import ThreadingMixIn
    from urlparse import urlparse, parse_qs
    from urllib import unquote

DOCUMENTS_DIR = "/mnt/us/documents"
PORT = 8765
STATIC_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "app"))

# In-memory local room message hub for offline co-reading
# room_id -> list of { id, time, from, to, payload }
LOCAL_ROOMS = {}
LOCAL_PINS = {} # pin -> { "room": room, "key": key, "ts": time }
ROOM_MAX_MESSAGES = 100
PAGE_TURN_COUNTER = 0
AUTO_REFRESH_INTERVAL = 8 # Full eips refresh every 8 page turns

class ThreadedHTTPServer(ThreadingMixIn, HTTPServer):
    """Allow a document transfer and status/API requests to proceed together."""
    daemon_threads = True
    allow_reuse_address = True

def path_is_within(path, root):
    """Python 2/3 compatible real-path containment check."""
    path = os.path.realpath(path)
    root = os.path.realpath(root)
    try:
        return os.path.commonpath([path, root]) == root
    except (AttributeError, ValueError):
        return path == root or path.startswith(root.rstrip(os.sep) + os.sep)

def is_allowed_document(path):
    """Only serve files inside the Kindle documents directory."""
    roots = [DOCUMENTS_DIR, os.path.expanduser("~/documents")]
    return any(os.path.isdir(root) and path_is_within(path, root) for root in roots)

def get_battery_level():
    """Queries Kindle battery status using LIPC or gasgauge"""
    try:
        out = subprocess.check_output(["lipc-get-prop", "com.lab126.powerd", "battLevel"]).strip()
        if sys.version_info[0] >= 3:
            out = out.decode("utf-8")
        return int(out)
    except Exception:
        pass
    try:
        if os.path.exists("/sys/devices/system/yoshi_battery/yoshi_battery0/battery_capacity"):
            with open("/sys/devices/system/yoshi_battery/yoshi_battery0/battery_capacity") as f:
                return int(f.read().strip())
    except Exception:
        pass
    return None

def trigger_eips_refresh():
    """Triggers eips hardware full refresh on Kindle e-ink display"""
    try:
        subprocess.call(["/usr/sbin/eips", "-c"])
        subprocess.call(["/usr/sbin/eips", ""])
        return True
    except Exception:
        try:
            subprocess.call(["eips", "-c"])
            return True
        except Exception:
            return False

def list_kindle_documents():
    """Scans Kindle document folders for supported reading formats"""
    supported_exts = ('.pdf', '.epub', '.mobi', '.azw3', '.txt', '.md', '.docx', '.xlsx')
    docs = []
    scan_roots = [DOCUMENTS_DIR, os.path.expanduser("~/documents")]
    
    for root_dir in scan_roots:
        if not os.path.isdir(root_dir):
            continue
        for root, _, files in os.walk(root_dir):
            for f in files:
                ext = os.path.splitext(f)[1].lower()
                if ext in supported_exts:
                    full_path = os.path.join(root, f)
                    try:
                        if not is_allowed_document(full_path):
                            continue
                        sz = os.path.getsize(full_path)
                        rel_path = os.path.relpath(full_path, root_dir)
                        docs.append({
                            "name": f,
                            "path": full_path,
                            "rel": rel_path,
                            "size": sz,
                            "ext": ext.lstrip('.')
                        })
                    except Exception:
                        pass
    return sorted(docs, key=lambda d: d["name"].lower())

def html_to_text(raw_html):
    """Strips HTML tags and unescapes entities"""
    raw_html = re.sub(r'(?is)<(script|style).*?</\1>', '', raw_html)
    raw_html = re.sub(r'(?i)</?(p|div|br|li|h[1-6]|tr|section|article)[^>]*>', '\n', raw_html)
    clean = re.sub(r'<[^>]+>', '', raw_html)
    clean = clean.replace('&nbsp;', ' ').replace('&amp;', '&').replace('&lt;', '<').replace('&gt;', '>').replace('&quot;', '"')
    return re.sub(r'\n{3,}', '\n\n', clean).strip()

def paginate_text(text, max_chars=2800):
    """Paginates text into clean e-ink reading screens"""
    pages = []
    cur = ''
    for line in text.splitlines():
        while len(line) > max_chars:
            if cur.strip():
                pages.append(cur)
            cur = ''
            pages.append(line[:max_chars])
            line = line[max_chars:]
        if cur and len(cur) + len(line) + 1 > max_chars:
            pages.append(cur)
            cur = ''
        cur += line + '\n'
    if cur.strip():
        pages.append(cur)
    return pages if pages else ["(Empty chapter)"]

def parse_epub(file_path):
    """Extracts chapters and TOC from an EPUB file using zipfile"""
    pages = []
    toc = []
    try:
        with zipfile.ZipFile(file_path, 'r') as z:
            order = []
            try:
                cont = ET.fromstring(z.read('META-INF/container.xml'))
                opf_path = next(e.get('full-path') for e in cont.iter() if e.tag.endswith('rootfile'))
                opf = ET.fromstring(z.read(opf_path))
                base = posixpath.dirname(opf_path)
                manifest = {e.get('id'): e.get('href') for e in opf.iter() if e.tag.endswith('}item')}
                for e in opf.iter():
                    if e.tag.endswith('itemref') and manifest.get(e.get('idref')):
                        order.append(posixpath.normpath(posixpath.join(base, manifest[e.get('idref')])))
            except Exception:
                pass
            if not order:
                order = sorted(n for n in z.namelist() if n.lower().endswith(('.html', '.xhtml', '.htm')))

            for name in order:
                if name in z.namelist():
                    raw = z.read(name)
                    if sys.version_info[0] >= 3:
                        raw = raw.decode('utf-8', errors='ignore')
                    else:
                        raw = raw.decode('utf-8', 'ignore')
                    m = re.search(r'(?is)<h[1-3][^>]*>(.*?)</h[1-3]>', raw)
                    title = html_to_text(m.group(1)) if m else posixpath.basename(name)
                    text = html_to_text(raw)
                    if text:
                        chap_pages = paginate_text(text)
                        toc.append({'title': title[:80], 'page': len(pages) + 1})
                        pages.extend(chap_pages)
    except Exception as e:
        return None, str(e)
    return {"pages": pages, "toc": toc, "totalPages": len(pages)}, None

class KindleRequestHandler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        self.directory = kwargs.pop('directory', STATIC_ROOT)
        # Python 3.7+ accepts directory= in the base handler; older Kindle
        # Python 2.7/3.x builds do not, so keep the already-set attribute and
        # fall back to the legacy constructor signature.
        try:
            SimpleHTTPRequestHandler.__init__(self, *args, directory=self.directory, **kwargs)
        except TypeError:
            SimpleHTTPRequestHandler.__init__(self, *args, **kwargs)

    def translate_path(self, path):
        parsed = urlparse(path).path
        clean_path = unquote(parsed).lstrip('/')
        root = os.path.realpath(self.directory)
        candidate = os.path.realpath(os.path.join(root, clean_path))
        if not path_is_within(candidate, root):
            return os.path.join(root, "__coop_reader_not_found__")
        return candidate

    def send_json(self, data, status=200):
        body = json.dumps(data).encode('utf-8')
        self.send_response(status)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Content-Length', str(len(body)))
        self.send_header('Access-Control-Allow-Origin', '*')
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        global PAGE_TURN_COUNTER
        parsed = urlparse(self.path)
        qs = parse_qs(parsed.query)

        # API: List documents in Kindle storage
        if parsed.path == '/api/documents':
            docs = list_kindle_documents()
            return self.send_json({"ok": True, "documents": docs})

        # API: Read raw document file
        if parsed.path == '/api/open-doc':
            path = qs.get('path', [''])[0]
            if not path or not os.path.isfile(path) or not is_allowed_document(path):
                return self.send_json({"ok": False, "error": "File not found or outside Kindle documents"}, 404)
            norm = os.path.realpath(path)
            try:
                size = os.path.getsize(norm)
                mime, _ = mimetypes.guess_type(norm)
                if not mime:
                    mime = 'application/octet-stream'
                self.send_response(200)
                self.send_header('Content-Type', mime)
                self.send_header('Content-Length', str(size))
                self.send_header('Access-Control-Allow-Origin', '*')
                self.send_header('X-Content-Type-Options', 'nosniff')
                self.send_header('Content-Disposition', 'attachment; filename="%s"' % os.path.basename(norm).replace('"', ''))
                self.end_headers()
                # Stream in bounded chunks; never hold a full Kindle book in RAM.
                with open(norm, 'rb') as f:
                    while True:
                        chunk = f.read(64 * 1024)
                        if not chunk:
                            break
                        self.wfile.write(chunk)
                return
            except Exception as e:
                return self.send_json({"ok": False, "error": str(e)}, 500)

        # API: PIN resolution
        if parsed.path.startswith('/pin/'):
            pin_code = parsed.path.split('/')[-1]
            entry = LOCAL_PINS.get(pin_code)
            if entry:
                return self.send_json({"ok": True, "pin": pin_code, "room": entry["room"], "key": entry.get("key", "")})
            return self.send_json({"ok": False, "error": "PIN not found"}, 404)

        # API: Room State for Kindle / KOReader polling
        if parsed.path.startswith('/room/') and parsed.path.endswith('/state'):
            parts = parsed.path.strip('/').split('/')
            room_id = parts[1] if len(parts) >= 2 else ""
            room_data = LOCAL_ROOMS.get(room_id, {})
            return self.send_json({
                "ok": True,
                "room": room_id,
                "page": room_data.get("latest_page", 1),
                "updated": room_data.get("updated", time.time())
            })

        # API: Fast native EPUB extraction
        if parsed.path == '/api/parse-epub':
            path = qs.get('path', [''])[0]
            if not path or not os.path.isfile(path) or not is_allowed_document(path):
                return self.send_json({"ok": False, "error": "File not found or outside Kindle documents"}, 404)
            res, err = parse_epub(os.path.realpath(path))
            if err:
                return self.send_json({"ok": False, "error": err}, 500)
            return self.send_json({"ok": True, "data": res})

        # API: KOReader page sync bridge
        if parsed.path == '/api/sync-page':
            page = qs.get('page', ['1'])[0]
            session = qs.get('session', [''])[0]
            PAGE_TURN_COUNTER += 1
            if PAGE_TURN_COUNTER >= AUTO_REFRESH_INTERVAL:
                PAGE_TURN_COUNTER = 0
                trigger_eips_refresh()

            # Record event in local room hub
            if session:
                room_msgs = LOCAL_ROOMS.setdefault(session, [])
                room_msgs.append({
                    "id": len(room_msgs) + 1,
                    "time": time.time(),
                    "from": "koreader",
                    "type": "PAGE_CHANGE",
                    "page": int(page)
                })
                if len(room_msgs) > ROOM_MAX_MESSAGES:
                    del room_msgs[0]
            return self.send_json({"ok": True, "page": page, "session": session})

        # API: Offline Local Room Message Poll
        if parsed.path == '/api/room/poll':
            room = qs.get('room', [''])[0]
            since_id = int(qs.get('since', ['0'])[0])
            msgs = [m for m in LOCAL_ROOMS.get(room, []) if m["id"] > since_id]
            return self.send_json({"ok": True, "messages": msgs})

        # API: Hardware E-Ink screen flash (EIPS)
        if parsed.path == '/api/eips-refresh':
            success = trigger_eips_refresh()
            return self.send_json({"ok": True, "refreshed": success})

        # API: Device status (battery, memory, lipc)
        if parsed.path == '/api/status':
            batt = get_battery_level()
            return self.send_json({
                "ok": True,
                "battery": batt,
                "platform": "kindle",
                "python": sys.version
            })

        # API: Keep screen awake
        if parsed.path == '/api/power/prevent-sleep':
            try:
                subprocess.call(["lipc-set-prop", "com.lab126.powerd", "preventScreenSaver", "1"])
                ok = True
            except Exception:
                ok = False
            return self.send_json({"ok": ok})

        # API: Allow sleep
        if parsed.path == '/api/power/allow-sleep':
            try:
                subprocess.call(["lipc-set-prop", "com.lab126.powerd", "preventScreenSaver", "0"])
                ok = True
            except Exception:
                ok = False
            return self.send_json({"ok": ok})

        # Serve static assets
        return SimpleHTTPRequestHandler.do_GET(self)

    def do_POST(self):
        parsed = urlparse(self.path)

        # API: PIN creation
        if parsed.path == '/pin/create':
            try:
                length = int(self.headers.get('Content-Length', 0))
                body = self.rfile.read(length)
                if sys.version_info[0] >= 3:
                    body = body.decode('utf-8')
                data = json.loads(body)
                room = data.get('room', '')
                key = data.get('key', '')
                if not room:
                    return self.send_json({"ok": False, "error": "room required"}, 400)
                import random
                pin = str(random.randint(1000, 9999))
                LOCAL_PINS[pin] = {"room": room, "key": key, "ts": time.time()}
                return self.send_json({"ok": True, "pin": pin, "room": room, "key": key})
            except Exception as e:
                return self.send_json({"ok": False, "error": str(e)}, 500)

        # API: Room Sync from Kindle / KOReader
        if parsed.path.startswith('/room/') and parsed.path.endswith('/sync'):
            parts = parsed.path.strip('/').split('/')
            room_id = parts[1] if len(parts) >= 2 else ""
            qs = parse_qs(parsed.query)
            try:
                length = int(self.headers.get('Content-Length', 0))
                if length > 0:
                    body = self.rfile.read(length)
                    if sys.version_info[0] >= 3:
                        body = body.decode('utf-8')
                    data = json.loads(body)
                    page = int(data.get('page', 1))
                else:
                    page = int(qs.get('page', ['1'])[0])
            except Exception:
                page = int(qs.get('page', ['1'])[0])

            room_data = LOCAL_ROOMS.setdefault(room_id, {"messages": []})
            room_data["latest_page"] = page
            room_data["updated"] = time.time()
            return self.send_json({"ok": True, "room": room_id, "page": page})

        # API: Offline Local Room Message Send
        if parsed.path == '/api/room/send':
            try:
                length = int(self.headers.get('Content-Length', 0))
                body = self.rfile.read(length)
                if sys.version_info[0] >= 3:
                    body = body.decode('utf-8')
                data = json.loads(body)
                room = data.get('room', '')
                if not room:
                    return self.send_json({"ok": False, "error": "room required"}, 400)
                room_msgs = LOCAL_ROOMS.setdefault(room, [])
                msg_entry = {
                    "id": len(room_msgs) + 1,
                    "time": time.time(),
                    "from": data.get('from', ''),
                    "to": data.get('to', ''),
                    "payload": data.get('payload', {})
                }
                room_msgs.append(msg_entry)
                if len(room_msgs) > ROOM_MAX_MESSAGES:
                    del room_msgs[0]
                return self.send_json({"ok": True, "msg_id": msg_entry["id"]})
            except Exception as e:
                return self.send_json({"ok": False, "error": str(e)}, 500)

        self.send_response(404)
        self.end_headers()

    def do_OPTIONS(self):
        self.send_response(200)
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
        self.send_header('Access-Control-Allow-Headers', 'Content-Type')
        self.end_headers()

def run_server(port, root_dir):
    global STATIC_ROOT
    STATIC_ROOT = os.path.abspath(root_dir)
    # The daemon has no authentication; expose it only to the local Kindle UI.
    # Cross-device collaboration uses the authenticated cloud relay instead.
    server_address = ('127.0.0.1', port)
    handler = lambda *args: KindleRequestHandler(directory=STATIC_ROOT, *args)
    httpd = ThreadedHTTPServer(server_address, handler)
    print("Coop Reader Kindle Daemon listening on http://127.0.0.1:%d" % port)
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("Shutting down daemon...")
        httpd.server_close()

if __name__ == '__main__':
    parser = argparse.ArgumentParser(description="Coop Reader Kindle Daemon")
    parser.add_argument('--port', type=int, default=PORT, help="Port to listen on")
    parser.add_argument('--root', type=str, default=STATIC_ROOT, help="Static files root directory")
    args = parser.parse_args()
    run_server(args.port, args.root)
