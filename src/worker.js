// worker.js — Pyodide document parser running off the main thread.
// Protocol: main thread posts { id, type, ... } and awaits { id, type, ... } reply.

let pyodidePromise = null;
let pyodide = null;
const installedPackages = new Set();

async function ensurePyodide() {
  if (pyodidePromise) return pyodidePromise;
  pyodidePromise = (async () => {
    importScripts('https://cdn.jsdelivr.net/pyodide/v0.25.0/full/pyodide.js');
    pyodide = await loadPyodide();
    await pyodide.loadPackage('micropip');
    await pyodide.runPythonAsync(`
import io, zipfile, re

doc_pages = []

def parse_document(file_bytes_js, filename):
    global doc_pages
    doc_pages = []
    if hasattr(file_bytes_js, 'to_py'):
        file_bytes = file_bytes_js.to_py().tobytes()
    elif hasattr(file_bytes_js, 'tobytes'):
        file_bytes = file_bytes_js.tobytes()
    else:
        file_bytes = bytes(file_bytes_js)

    bio = io.BytesIO(file_bytes)
    fname = filename.lower()

    if fname.endswith('.docx'):
        import docx
        doc_pages = [p.text for p in docx.Document(bio).paragraphs if p.text.strip()]
    elif fname.endswith('.xlsx'):
        import openpyxl
        wb = openpyxl.load_workbook(bio)
        for sheet in wb.sheetnames:
            ws = wb[sheet]
            rows = []
            for row in ws.iter_rows(values_only=True):
                rows.append(" | ".join([str(c) for c in row if c is not None]))
            doc_pages.append(f"--- Sheet: {sheet} ---\\n" + "\\n".join(rows))
    elif fname.endswith(('.epub','.azw3','.mobi')):
        try:
            if zipfile.is_zipfile(bio):
                with zipfile.ZipFile(bio) as z:
                    for name in z.namelist():
                        if name.endswith(('.html','.xhtml','.htm','.txt')):
                            with z.open(name) as f:
                                clean = re.sub('<[^<]+?>', '', f.read().decode('utf-8', errors='ignore'))
                                if clean.strip():
                                    doc_pages.append(f"--- {name} ---\\n" + clean.strip())
            else:
                text = file_bytes.decode('utf-8', errors='ignore')
                chunks = re.findall(r'[A-Za-z0-9\\s,.\\-\\(\\)]+', text)
                filtered = [c.strip() for c in chunks if len(c.strip()) > 20]
                doc_pages = filtered[:100] if filtered else ["Could not extract text."]
        except Exception as e:
            doc_pages = [f"Error: {str(e)}"]
    else:
        doc_pages = [f"Error: Format '{filename}' not supported."]

    return len(doc_pages)

def get_page(index):
    if 0 <= index < len(doc_pages):
        return doc_pages[index]
    return ""
    `);
    return pyodide;
  })();
  return pyodidePromise;
}

async function installPackage(name) {
  if (installedPackages.has(name)) return;
  await ensurePyodide();
  const micropip = pyodide.pyimport('micropip');
  await micropip.install(name);
  installedPackages.add(name);
}

self.onmessage = async (e) => {
  const { id, type } = e.data || {};
  try {
    switch (type) {
      case 'init':
        await ensurePyodide();
        self.postMessage({ id, type: 'ready' });
        break;

      case 'install':
        await installPackage(e.data.package);
        self.postMessage({ id, type: 'installed', package: e.data.package });
        break;

      case 'parse': {
        await ensurePyodide();
        const fname = String(e.data.filename || '').toLowerCase();
        if (fname.endsWith('.docx')) await installPackage('python-docx');
        if (fname.endsWith('.xlsx')) await installPackage('openpyxl');

        const bytes = new Uint8Array(e.data.bytes);
        const parseDoc = pyodide.globals.get('parse_document');
        const totalPages = parseDoc(bytes, e.data.filename);
        self.postMessage({ id, type: 'parsed', totalPages });
        break;
      }

      case 'getPage': {
        await ensurePyodide();
        const getPage = pyodide.globals.get('get_page');
        const content = getPage(e.data.index);
        self.postMessage({ id, type: 'page', content });
        break;
      }

      default:
        self.postMessage({ id, type: 'error', error: 'Unknown message type: ' + type });
    }
  } catch (err) {
    self.postMessage({ id, type: 'error', error: String(err && (err.message || err)) });
  }
};