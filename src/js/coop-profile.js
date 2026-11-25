/* Coop Reader startup profile: asks for a display name and picture when the app starts.
 * Loaded in <head>. Exposes CoopProfile.ready (resolves once the person confirmed), CoopProfile.open() to edit later.
 * Storage keys are the ones the app already uses: coop-name, coop-avatar.  coop-profile-skip=1 means "remember me".
 */
(function (root) {
  'use strict';
  var NAME_MAX = 24, AV_PX = 128;
  var resolveReady, ready = new Promise(function (r) { resolveReady = r; });
  var ls = { get: function (k) { try { return localStorage.getItem(k); } catch (_) { return null; } }, set: function (k, v) { try { localStorage.setItem(k, v); } catch (_) {} }, del: function (k) { try { localStorage.removeItem(k); } catch (_) {} } };
  var avatar = '', modal = null, firstRun = true;

  function cleanName(s) { return String(s || '').replace(/[\u0000-\u001f\u007f<>]/g, '').replace(/\s+/g, ' ').trim().slice(0, NAME_MAX); }
  function initials(n) { return (cleanName(n)[0] || '?').toUpperCase(); }
  function stored() { var n = cleanName(ls.get('coop-name')); return { name: /^Peer-[a-z0-9]{4}$/.test(n) ? '' : n, avatar: ls.get('coop-avatar') || '' }; }   // auto-generated "Peer-xxxx" names are not a real choice

  async function toAvatar(file) {
    if (!file || !/^image\//.test(file.type || 'image/')) throw new Error('not an image');
    if (file.size > 25 * 1024 * 1024) throw new Error('image too large');
    var bmp = await createImageBitmap(file), c = document.createElement('canvas'); c.width = c.height = AV_PX;
    var side = Math.min(bmp.width, bmp.height);
    c.getContext('2d').drawImage(bmp, (bmp.width - side) / 2, (bmp.height - side) / 2, side, side, 0, 0, AV_PX, AV_PX);
    if (bmp.close) bmp.close();
    return c.toDataURL('image/jpeg', 0.8);
  }

  var CSS = '.cp-back[hidden]{display:none!important}.cp-back{position:fixed;inset:0;z-index:10000;background:rgba(15,23,42,.62);display:flex;align-items:center;justify-content:center;padding:16px;backdrop-filter:blur(3px)}'
    + '.cp-card{width:min(420px,100%);background:var(--surface,#fff);color:var(--text,#111827);border:1px solid var(--border,#e5e7eb);border-radius:16px;box-shadow:0 20px 60px rgba(0,0,0,.35);padding:24px;display:flex;flex-direction:column;gap:16px}'
    + '.cp-card h2{margin:0;font-size:1.25rem}.cp-card p{margin:0;color:var(--text-muted,#6b7280);font-size:.9rem;line-height:1.4}'
    + '.cp-av{align-self:center;position:relative;width:112px;height:112px;border-radius:50%;border:3px dashed var(--border,#cbd5e1);background:var(--surface-alt,#f1f5f9);display:flex;align-items:center;justify-content:center;font-size:2.6rem;font-weight:700;color:var(--text-muted,#64748b);cursor:pointer;overflow:hidden;padding:0}'
    + '.cp-av.has{border-style:solid;border-color:var(--primary,#2563eb)}.cp-av img{width:100%;height:100%;object-fit:cover}.cp-av.drag{border-color:var(--primary,#2563eb);background:rgba(37,99,235,.1)}'
    + '.cp-row{display:flex;gap:8px;justify-content:center;flex-wrap:wrap}.cp-row button{min-height:40px}'
    + '.cp-card label.cp-f{display:flex;flex-direction:column;gap:6px;font-weight:600;font-size:.85rem}.cp-card input[type=text]{width:100%;box-sizing:border-box}'
    + '.cp-check{display:flex;align-items:center;gap:10px;font-size:.88rem}.cp-err{color:var(--error,#dc2626);font-size:.85rem;min-height:1.1em}'
    + '.cp-go{min-height:46px;font-weight:700;background:var(--primary,#2563eb);color:#fff;border:0;border-radius:10px;cursor:pointer;font-size:1rem}.cp-go:disabled{opacity:.5;cursor:not-allowed}';

  function build() {
    var st = document.createElement('style'); st.textContent = CSS; document.head.appendChild(st);
    var d = document.createElement('div'); d.className = 'cp-back'; d.hidden = true;
    d.innerHTML = '<form class="cp-card" role="dialog" aria-modal="true" aria-labelledby="cp-title" novalidate>'
      + '<div><h2 id="cp-title">Who is reading?</h2><p id="cp-sub">Pick the name and picture other readers will see next to your cursor, chat and comments.</p></div>'
      + '<button type="button" class="cp-av" id="cp-av" aria-label="Choose a profile picture"><span id="cp-ph">?</span></button>'
      + '<div class="cp-row"><button type="button" class="secondary" id="cp-pick">Choose photo</button><button type="button" class="secondary" id="cp-cam">Take photo</button><button type="button" class="secondary" id="cp-clear">Remove</button></div>'
      + '<label class="cp-f">Display name<input type="text" id="cp-name" maxlength="' + NAME_MAX + '" autocomplete="nickname" placeholder="e.g. Ana" required></label>'
      + '<label class="cp-check"><input type="checkbox" id="cp-skip"> Remember me on this device (skip this screen next time)</label>'
      + '<div class="cp-err" id="cp-err" role="alert"></div>'
      + '<button type="submit" class="cp-go" id="cp-go">Continue</button>'
      + '<input type="file" id="cp-file" accept="image/*" hidden><input type="file" id="cp-file-cam" accept="image/*" capture="user" hidden></form>';
    document.body.appendChild(d); modal = d;
    var $ = function (id) { return d.querySelector('#' + id); };
    var paint = function () {
      var b = $('cp-av'), name = $('cp-name').value;
      b.classList.toggle('has', !!avatar);
      b.innerHTML = avatar ? '<img alt="" src="' + avatar + '">' : '<span>' + initials(name).replace(/[&<>]/g, '') + '</span>';
      $('cp-clear').style.display = avatar ? '' : 'none';
    };
    var load = async function (file) { $('cp-err').textContent = ''; try { avatar = await toAvatar(file); paint(); } catch (e) { $('cp-err').textContent = 'Could not use that image (' + (e.message || 'unsupported') + ').'; } };
    $('cp-av').onclick = $('cp-pick').onclick = function () { $('cp-file').click(); };
    $('cp-cam').onclick = function () { $('cp-file-cam').click(); };
    $('cp-clear').onclick = function () { avatar = ''; paint(); };
    $('cp-file').onchange = $('cp-file-cam').onchange = function (e) { var f = e.target.files[0]; e.target.value = ''; if (f) load(f); };
    $('cp-name').oninput = function () { $('cp-err').textContent = ''; if (!avatar) paint(); };
    var av = $('cp-av');
    av.ondragover = function (e) { e.preventDefault(); av.classList.add('drag'); }; av.ondragleave = function () { av.classList.remove('drag'); };
    av.ondrop = function (e) { e.preventDefault(); av.classList.remove('drag'); var f = e.dataTransfer && e.dataTransfer.files[0]; if (f) load(f); };
    d.querySelector('form').onsubmit = function (e) {
      e.preventDefault();
      var n = cleanName($('cp-name').value);
      if (!n) { $('cp-err').textContent = 'Please enter a name (1–' + NAME_MAX + ' characters).'; $('cp-name').focus(); return; }
      ls.set('coop-name', n); if (avatar) ls.set('coop-avatar', avatar); else ls.del('coop-avatar');
      if ($('cp-skip').checked) ls.set('coop-profile-skip', '1'); else ls.del('coop-profile-skip');
      d.hidden = true; document.body.style.overflow = '';
      if (typeof root.applyStartupProfile === 'function') root.applyStartupProfile();
      if (firstRun) { firstRun = false; resolveReady(CoopProfile.get()); }
      if (root.__coopRestoreFocus) try { root.__coopRestoreFocus.focus(); } catch (_) {}
    };
    d.addEventListener('keydown', function (e) {   // keep Tab inside the dialog
      if (e.key !== 'Tab') return;
      var f = [].filter.call(d.querySelectorAll('button,input:not([hidden])'), function (x) { return !x.disabled && x.offsetParent !== null; });
      if (!f.length) return; var first = f[0], last = f[f.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); } else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    });
    d._paint = paint;
  }

  function open(opts) {
    opts = opts || {};
    if (!modal) build();
    var s = stored(); avatar = s.avatar;
    modal.querySelector('#cp-name').value = s.name;
    modal.querySelector('#cp-skip').checked = ls.get('coop-profile-skip') === '1';
    modal.querySelector('#cp-title').textContent = opts.edit ? 'Edit your profile' : 'Who is reading?';
    modal.querySelector('#cp-go').textContent = opts.edit ? 'Save' : 'Continue';
    modal._paint(); modal.hidden = false; document.body.style.overflow = 'hidden';
    root.__coopRestoreFocus = document.activeElement;
    setTimeout(function () { modal.querySelector('#cp-name').focus(); }, 30);
  }

  function start() {
    var s = stored();
    if (ls.get('coop-profile-skip') === '1' && s.name) { firstRun = false; if (typeof root.applyStartupProfile === 'function') root.applyStartupProfile(); resolveReady(s); return; }
    open();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start); else start();

  var CoopProfile = { ready: ready, open: function () { open({ edit: true }); }, get: function () { var s = stored(); return { name: s.name || cleanName(ls.get('coop-name')), avatar: s.avatar }; }, cleanName: cleanName, toAvatar: toAvatar };
  root.CoopProfile = CoopProfile;
})(typeof self !== 'undefined' ? self : globalThis);
