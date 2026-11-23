/* Coop Reader extras (loaded after the main script):
 *  - invite dialog with QR code, link, code and the session fingerprint (safety number)
 *  - the third-party donation widget is loaded after the app is idle, and never when the person opted out
 *  - settings toggles used by the network dialog (low-bandwidth mode, hide widget)
 */
(function (root) {
  'use strict';
  var ls = { get: function (k) { try { return localStorage.getItem(k); } catch (_) { return null; } }, set: function (k, v) { try { localStorage.setItem(k, v); } catch (_) {} } };

  function qrSvg(text) {
    var qr = root.qrcode(0, 'M'); qr.addData(text); qr.make();
    return qr.createSvgTag({ cellSize: 6, margin: 3, scalable: true });
  }

  function showInvite() {
    if (typeof isHost === 'undefined' || !isHost || !myPeerId) return notify('Start a session first.', 'warning', 3000);
    var url = buildShareUrl(myPeerId), code = myPeerId + (relayKeyB64 ? '.' + relayKeyB64 + (hostSigner ? '.' + hostSigner.id.fp : '') : '');
    var sn = hostSigner ? CoopTrust.safetyNumber(hostSigner.id.fp) : '';
    var o = document.createElement('div');
    o.style.cssText = 'position:fixed;inset:0;z-index:999;background:rgba(0,0,0,.6);display:flex;align-items:center;justify-content:center;padding:12px;overflow:auto';
    o.innerHTML = '<div role="dialog" aria-modal="true" aria-label="Invite" style="background:var(--surface,#fff);color:var(--text,#111);padding:18px;border-radius:14px;max-width:380px;width:100%;box-shadow:0 8px 30px rgba(0,0,0,.4);text-align:center">'
      + '<h3 style="margin:0 0 4px">Invite to this session</h3><p style="margin:0 0 10px;font-size:.85rem;opacity:.75">Scan with a phone or tablet camera. The link carries the encryption key and the host\'s key fingerprint.</p>'
      + '<div id="inv-qr" style="background:#fff;padding:6px;border-radius:10px;width:min(280px,80vw);margin:0 auto" aria-label="QR code of the invite link" role="img"></div>'
      + (sn ? '<p style="margin:10px 0 0;font-size:.8rem">Session fingerprint <b style="letter-spacing:.5px">' + sn + '</b><br><span style="opacity:.7">Guests who joined without the link can compare this number with you.</span></p>' : '')
      + '<div style="display:flex;gap:8px;justify-content:center;margin-top:12px;flex-wrap:wrap"><button class="secondary" id="inv-link">Copy link</button><button class="secondary" id="inv-code">Copy code</button><button id="inv-x">Done</button></div></div>';
    document.body.appendChild(o);
    var box = o.querySelector('#inv-qr');
    try { box.innerHTML = qrSvg(url); box.dataset.url = url; } catch (e) { box.textContent = 'The link is too long for a QR code. Use Copy link.'; }
    var copy = function (t, ok) { return navigator.clipboard && navigator.clipboard.writeText(t).then(function () { notify(ok, 'success', 2000); }, function () { notify('Could not copy: select the text manually.', 'warning', 3000); }); };
    o.querySelector('#inv-link').onclick = function () { copy(url, 'Link copied.'); };
    o.querySelector('#inv-code').onclick = function () { copy(code, 'Code copied.'); };
    var close = function () { o.remove(); document.removeEventListener('keydown', esc); }, esc = function (e) { if (e.key === 'Escape') close(); };
    o.querySelector('#inv-x').onclick = close; o.onclick = function (e) { if (e.target === o) close(); }; document.addEventListener('keydown', esc);
    o.querySelector('#inv-x').focus();
  }

  // donation widget: not part of the critical path, off when the person says so
  function loadWidget() {
    if (ls.get('coop-no-widget') === '1' || (root.COOP_CONFIG && root.COOP_CONFIG.noWidget) || /[?&#]nowidget=1/.test(location.href) || document.querySelector('script[data-name="BMC-Widget"]')) return;
    var s = document.createElement('script');
    s.setAttribute('data-name', 'BMC-Widget'); s.setAttribute('data-cfasync', 'false'); s.src = 'https://cdnjs.buymeacoffee.com/1.0.0/widget.prod.min.js';
    s.setAttribute('data-id', 'vishveshkac'); s.setAttribute('data-description', 'Support me on Buy me a coffee!'); s.setAttribute('data-message', ''); s.setAttribute('data-color', '#FF813F');
    s.setAttribute('data-position', 'Right'); s.setAttribute('data-x_margin', '18'); s.setAttribute('data-y_margin', '18');
    document.body.appendChild(s);
  }
  window.addEventListener('load', function () { setTimeout(loadWidget, 2500); });

  root.CoopExtras = { showInvite: showInvite, qrSvg: qrSvg, setLowBw: function (on) { ls.set('coop-lowbw', on ? '1' : '0'); }, setNoWidget: function (on) { ls.set('coop-no-widget', on ? '1' : '0'); if (on) { var w = document.getElementById('bmc-widget'); if (w) w.remove(); } } };
})(typeof self !== 'undefined' ? self : globalThis);
