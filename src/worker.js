// worker.js — Pyodide document parser (loaded lazily, off the main thread).
let pyodidePromise = null, pyodide = null;
const installing = new Map();

async function ensurePyodide() {
  if (pyodidePromise) return pyodidePromise;
  pyodidePromise = (async () => {
    importScripts('https://cdn.jsdelivr.net/pyodide/v0.25.0/full/pyodide.js');
    pyodide = await loadPyodide();
    await pyodide.loadPackage('micropip');
    await pyodide.runPythonAsync(`
import io, zipfile, re, gc, json, html as _html, posixpath
import xml.etree.ElementTree as ET

doc_pages = []
doc_toc = []
PAGE_CHARS = 3500

def paginate(text, size=PAGE_CHARS):
    pages, cur = [], ''
    for line in text.splitlines():
        while len(line) > size:
            if cur.strip(): pages.append(cur)
            cur = ''
            pages.append(line[:size]); line = line[size:]
        if cur and len(cur) + len(line) + 1 > size:
            pages.append(cur); cur = ''
        cur += line + '\\n'
    if cur.strip(): pages.append(cur)
    return pages

def add_section(title, text):
    pages = paginate(text)
    if pages:
        doc_toc.append({'t': (title or 'Untitled')[:120], 'p': len(doc_pages)})
        doc_pages.extend(pages)

def html_to_text(raw):
    raw = re.sub(r'(?is)<(script|style).*?</\\1>', '', raw)
    raw = re.sub(r'(?i)</?(p|div|br|li|h[1-6]|tr|section|article)[^>]*>', '\\n', raw)
    return _html.unescape(re.sub(r'<[^>]+>', '', raw))

def clean_epub_html(raw):
    raw = re.sub(r'(?is)<(script|style)[^>]*>.*?</\\1>', '', raw)
    raw = re.sub(r'(?i)\s+on[a-z]+\s*=\s*(["\'][^"\']*["\']|[^\s>]+)', '', raw)
    m = re.search(r'(?is)<body[^>]*>(.*?)</body>', raw)
    if m: raw = m.group(1)
    return raw.strip()

def epub_pages(z):
    order = []
    try:
        cont = ET.fromstring(z.read('META-INF/container.xml'))
        opf_path = next(e.get('full-path') for e in cont.iter() if e.tag.endswith('rootfile'))
        opf = ET.fromstring(z.read(opf_path)); base = posixpath.dirname(opf_path)
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
            raw = z.read(name).decode('utf-8', errors='ignore')
            m = re.search(r'(?is)<h[1-3][^>]*>(.*?)</h[1-3]>', raw)
            title = html_to_text(m.group(1)).strip() if m else posixpath.basename(name)
            cleaned = clean_epub_html(raw)
            if cleaned:
                doc_toc.append({'t': title[:120], 'p': len(doc_pages)})
                doc_pages.append(cleaned)
    return doc_pages

def parse_document(file_bytes_js, filename):
    global doc_pages, doc_toc
    doc_pages = []; doc_toc = []
    gc.collect()
    if hasattr(file_bytes_js, 'to_py'):
        file_bytes = bytes(file_bytes_js.to_py())
    else:
        file_bytes = bytes(file_bytes_js)
    bio = io.BytesIO(file_bytes)
    fname = filename.lower()
    try:
        if fname.endswith('.docx'):
            import docx
            from docx.table import Table
            from docx.text.paragraph import Paragraph
            d = docx.Document(bio); title = 'Start'
            cur_html = []
            for child in d.element.body.iterchildren():
                if child.tag.endswith('}p'):
                    para = Paragraph(child, d)
                    p_text = _html.escape(para.text)
                    style = (para.style.name or '').lower()
                    if style.startswith('heading 1'):
                        if cur_html:
                            doc_toc.append({'t': title[:120], 'p': len(doc_pages)})
                            doc_pages.append(''.join(cur_html)); cur_html = []
                        title = para.text.strip() or 'Heading'
                        cur_html.append(f'<h1 class="docx-h1">{p_text}</h1>')
                    elif style.startswith('heading 2'):
                        cur_html.append(f'<h2 class="docx-h2">{p_text}</h2>')
                    elif style.startswith('heading 3'):
                        cur_html.append(f'<h3 class="docx-h3">{p_text}</h3>')
                    else:
                        if p_text.strip():
                            cur_html.append(f'<p class="docx-p">{p_text}</p>')
                elif child.tag.endswith('}tbl'):
                    tbl_rows = []
                    for row in Table(child, d).rows:
                        tbl_cells = ''.join(f'<td class="docx-td" contenteditable="true">{_html.escape(c.text.strip())}</td>' for c in row.cells)
                        tbl_rows.append(f'<tr>{tbl_cells}</tr>')
                    cur_html.append(f'<table class="docx-table">{"".join(tbl_rows)}</table>')
            if cur_html:
                doc_toc.append({'t': title[:120], 'p': len(doc_pages)})
                doc_pages.append(''.join(cur_html))
        elif fname.endswith('.xlsx'):
            import openpyxl
            wb = openpyxl.load_workbook(bio, data_only=True)
            for sheet_name in wb.sheetnames:
                ws = wb[sheet_name]
                html_rows = []
                r_idx = 0
                for row in ws.iter_rows(values_only=True):
                    if not any(c is not None for c in row): continue
                    cells = []
                    for c_idx, val in enumerate(row):
                        cell_str = '' if val is None else _html.escape(str(val))
                        tag = 'th' if r_idx == 0 else 'td'
                        cells.append(f'<{tag} contenteditable="true" data-row="{r_idx}" data-col="{c_idx}" class="xlsx-cell">{cell_str}</{tag}>')
                    html_rows.append('<tr>' + ''.join(cells) + '</tr>')
                    r_idx += 1
                table_html = f'<div class="xlsx-sheet"><h3>Sheet: {_html.escape(sheet_name)}</h3><div class="table-scroll"><table class="xlsx-table" data-sheet="{_html.escape(sheet_name)}">' + ''.join(html_rows) + '</table></div></div>'
                doc_toc.append({'t': sheet_name[:120], 'p': len(doc_pages)})
                doc_pages.append(table_html)
        elif fname.endswith('.epub') or (fname.endswith(('.azw3', '.mobi')) and zipfile.is_zipfile(bio)):
            with zipfile.ZipFile(bio) as z: doc_pages = epub_pages(z)
        elif fname.endswith(('.azw3', '.mobi')):
            text = file_bytes.decode('utf-8', errors='ignore')
            chunks = [c.strip() for c in re.findall(r'[A-Za-z0-9\\s,.\\-\\(\\)]+', text) if len(c.strip()) > 20]
            doc_pages = paginate('\\n'.join(chunks)) or ['Could not extract text (DRM or unsupported MOBI/AZW3).']
        elif fname.endswith(('.txt', '.md', '.csv')):
            doc_pages = paginate(file_bytes.decode('utf-8', errors='replace'))
        else:
            doc_pages = [f"Error: Format '{filename}' not supported."]
    except Exception as e:
        doc_pages = [f'Error parsing {filename}: {e}']
    if not doc_pages: doc_pages = ['(No text content found.)']
    return len(doc_pages)

def get_toc():
    return json.dumps(doc_toc)

def get_page(index):
    return doc_pages[index] if 0 <= index < len(doc_pages) else ''
`);
    return pyodide;
  })();
  return pyodidePromise;
}

function installPackage(name) {
  if (!installing.has(name)) {
    installing.set(name, (async () => {
      await ensurePyodide();
      const micropip = pyodide.pyimport('micropip');
      try { await micropip.install(name); } finally { micropip.destroy(); }
    })().catch(e => { installing.delete(name); throw e; }));
  }
  return installing.get(name);
}

self.onmessage = async (e) => {
  const { id, type } = e.data || {};
  try {
    switch (type) {
      case 'init': await ensurePyodide(); self.postMessage({ id, type: 'ready' }); break;
      case 'preload': await installPackage('python-docx'); await installPackage('openpyxl'); self.postMessage({ id, type: 'preloaded' }); break;
      case 'install': await installPackage(e.data.package); self.postMessage({ id, type: 'installed', package: e.data.package }); break;
      case 'parse': {
        await ensurePyodide();
        const fname = String(e.data.filename || '').toLowerCase();
        if (fname.endsWith('.docx')) await installPackage('python-docx');
        if (fname.endsWith('.xlsx')) await installPackage('openpyxl');
        const parseDoc = pyodide.globals.get('parse_document');
        try { self.postMessage({ id, type: 'parsed', totalPages: parseDoc(new Uint8Array(e.data.bytes), e.data.filename) }); }
        finally { parseDoc.destroy(); }
        break;
      }
      case 'getToc': {
        await ensurePyodide();
        const f = pyodide.globals.get('get_toc');
        try { self.postMessage({ id, type: 'toc', content: f() }); } finally { f.destroy(); }
        break;
      }
      case 'getPage': {
        await ensurePyodide();
        const getPage = pyodide.globals.get('get_page');
        try { self.postMessage({ id, type: 'page', content: getPage(e.data.index) }); } finally { getPage.destroy(); }
        break;
      }
      default: self.postMessage({ id, type: 'error', error: 'Unknown message type: ' + type });
    }
  } catch (err) { self.postMessage({ id, type: 'error', error: String(err && (err.message || err)) }); }
};
