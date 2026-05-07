/**
 * ReferenceCatalog — persistent catalog of architectural references
 * for AI render. IndexedDB-backed (was localStorage; that capped at
 * ~5-10 MB / origin and broke at ~30 refs).
 *
 * Public API (sync getters use an in-memory cache; mutations are
 * async but the cache updates immediately so the UI reads fine):
 *   getCatalog()      → Array<{id, name, dataUrl, addedAt}>
 *   getSelectedId()   → string | null
 *   getSelected()     → reference object | null
 *   addReference(file) → Promise<reference>
 *   removeReference(id) → Promise
 *   clearAll() → Promise
 *   selectReference(id | null)
 *   openModal(opts)   — opens the catalog modal as an overlay
 *   onChange(fn)      → unsubscribe fn (notified on add/remove/select)
 *
 * Storage:
 *   IndexedDB  `ai-render` / store `references`  — full ref records
 *   localStorage `ai_render_selected_ref_v1` — selected ref id (tiny)
 *
 * Images on import are downscaled to ≤ 1024×1024 and re-encoded as
 * JPEG q=0.85. Catalog can hold hundreds of refs in IDB without hitting
 * a quota — IDB origin storage is typically 10 % of free disk.
 */

// (No imports from ai-render — the modal accepts a render callback
// from the caller and returns control to it for the actual API call.)

var LS_CATALOG_OLD = 'ai_render_catalog_v1'; // legacy — migrated on load
var LS_SELECTED = 'ai_render_selected_ref_v1';

var DB_NAME = 'ai-render';
var DB_VERSION = 1;
var STORE = 'references';

var _catalog = [];       // in-memory cache
var _selectedId = null;
var _listeners = [];
var _modalEl = null;     // current open modal, if any
var _busy = false;       // render in progress
var _loading = null;     // pending Promise while IDB hydrates

// ── IndexedDB helpers ────────────────────────────────

function openDB() {
  return new Promise(function (resolve, reject) {
    if (typeof indexedDB === 'undefined') {
      reject(new Error('IndexedDB unavailable'));
      return;
    }
    var req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = function () {
      var db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { keyPath: 'id' });
      }
    };
    req.onsuccess = function () { resolve(req.result); };
    req.onerror = function () { reject(req.error); };
  });
}

function idbGetAll() {
  return openDB().then(function (db) {
    return new Promise(function (resolve, reject) {
      var tx = db.transaction(STORE, 'readonly');
      var st = tx.objectStore(STORE);
      var req = st.getAll();
      req.onsuccess = function () {
        var arr = req.result || [];
        arr.sort(function (a, b) { return (a.addedAt || 0) - (b.addedAt || 0); });
        resolve(arr);
      };
      req.onerror = function () { reject(req.error); };
    });
  });
}

function idbPut(ref) {
  return openDB().then(function (db) {
    return new Promise(function (resolve, reject) {
      var tx = db.transaction(STORE, 'readwrite');
      var st = tx.objectStore(STORE);
      var req = st.put(ref);
      req.onsuccess = function () { resolve(); };
      req.onerror = function () { reject(req.error); };
    });
  });
}

function idbDelete(id) {
  return openDB().then(function (db) {
    return new Promise(function (resolve, reject) {
      var tx = db.transaction(STORE, 'readwrite');
      var st = tx.objectStore(STORE);
      var req = st.delete(id);
      req.onsuccess = function () { resolve(); };
      req.onerror = function () { reject(req.error); };
    });
  });
}

function idbClear() {
  return openDB().then(function (db) {
    return new Promise(function (resolve, reject) {
      var tx = db.transaction(STORE, 'readwrite');
      var st = tx.objectStore(STORE);
      var req = st.clear();
      req.onsuccess = function () { resolve(); };
      req.onerror = function () { reject(req.error); };
    });
  });
}

// ── Hydration + legacy migration ─────────────────────

function ensureLoaded() {
  if (_loading) return _loading;
  _loading = idbGetAll().then(function (arr) {
    _catalog = arr;
    _selectedId = localStorage.getItem(LS_SELECTED) || null;
    if (_selectedId && !_catalog.some(function (r) { return r.id === _selectedId; })) {
      _selectedId = null;
      try { localStorage.removeItem(LS_SELECTED); } catch (_e) { /* no-op */ }
    }
    // One-time migration from the old localStorage catalog.
    try {
      var oldRaw = localStorage.getItem(LS_CATALOG_OLD);
      if (oldRaw) {
        var oldArr = JSON.parse(oldRaw) || [];
        var migrations = [];
        for (var i = 0; i < oldArr.length; i++) {
          var r = oldArr[i];
          if (!r || !r.id) continue;
          if (!_catalog.some(function (x) { return x.id === r.id; })) {
            migrations.push(idbPut(r).then(function () { _catalog.push(r); }));
          }
        }
        return Promise.all(migrations).then(function () {
          try { localStorage.removeItem(LS_CATALOG_OLD); } catch (_e) { /* no-op */ }
          _catalog.sort(function (a, b) { return (a.addedAt || 0) - (b.addedAt || 0); });
        });
      }
    } catch (_e) { /* no-op */ }
  }, function (err) {
    console.warn('[ai-render-catalog] IDB load failed:', err);
    _catalog = [];
  }).then(function () { notify(); });
  return _loading;
}

function saveSelected() {
  try {
    if (_selectedId) localStorage.setItem(LS_SELECTED, _selectedId);
    else localStorage.removeItem(LS_SELECTED);
  } catch (_e) { /* no-op */ }
}

function notify() {
  for (var i = 0; i < _listeners.length; i++) {
    try { _listeners[i](); } catch (_e) { /* swallow listener errors */ }
  }
}

// ── Public API ───────────────────────────────────────

// Sync getters return whatever's cached. Caller can subscribe via
// onChange() to be notified once IDB hydration completes.
export function getCatalog() { ensureLoaded(); return _catalog.slice(); }

export function getSelectedId() { ensureLoaded(); return _selectedId; }

export function getSelected() {
  ensureLoaded();
  if (!_selectedId) return null;
  for (var i = 0; i < _catalog.length; i++) {
    if (_catalog[i].id === _selectedId) return _catalog[i];
  }
  return null;
}

export function selectReference(id) {
  ensureLoaded();
  _selectedId = id || null;
  saveSelected();
  notify();
}

export function removeReference(id) {
  ensureLoaded();
  for (var i = 0; i < _catalog.length; i++) {
    if (_catalog[i].id === id) { _catalog.splice(i, 1); break; }
  }
  if (_selectedId === id) { _selectedId = null; saveSelected(); }
  notify();
  return idbDelete(id).catch(function (err) {
    console.warn('[ai-render-catalog] delete failed:', err);
  });
}

export function clearAll() {
  ensureLoaded();
  _catalog = [];
  _selectedId = null;
  saveSelected();
  notify();
  return idbClear().catch(function (err) {
    console.warn('[ai-render-catalog] clear failed:', err);
  });
}

export function onChange(fn) {
  _listeners.push(fn);
  return function () {
    var idx = _listeners.indexOf(fn);
    if (idx >= 0) _listeners.splice(idx, 1);
  };
}

/**
 * Add a reference from a File / Blob. Image is downscaled and
 * re-encoded as JPEG before persisting in IndexedDB.
 */
export function addReference(file) {
  return ensureLoaded().then(function () {
    return compressImage(file, 1024, 0.85);
  }).then(function (dataUrl) {
    var ref = {
      id: 'ref_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8),
      name: (file && file.name) || 'untitled',
      dataUrl: dataUrl,
      addedAt: Date.now()
    };
    return idbPut(ref).then(function () {
      _catalog.push(ref);
      notify();
      return ref;
    });
  });
}

function compressImage(file, maxDim, quality) {
  return new Promise(function (resolve, reject) {
    if (!file || !/^image\//.test(file.type || '')) {
      reject(new Error('not an image'));
      return;
    }
    var reader = new FileReader();
    reader.onload = function () {
      var img = new Image();
      img.onload = function () {
        var w = img.width, h = img.height;
        var s = Math.min(1, maxDim / Math.max(w, h));
        var nw = Math.round(w * s), nh = Math.round(h * s);
        var c = document.createElement('canvas');
        c.width = nw; c.height = nh;
        c.getContext('2d').drawImage(img, 0, 0, nw, nh);
        try {
          resolve(c.toDataURL('image/jpeg', quality));
        } catch (err) { reject(err); }
      };
      img.onerror = function () { reject(new Error('image decode failed')); };
      img.src = reader.result;
    };
    reader.onerror = function () { reject(new Error('file read failed')); };
    reader.readAsDataURL(file);
  });
}

// ── Modal UI ─────────────────────────────────────────

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/**
 * Open the catalog modal. opts may carry a render trigger callback
 * — when provided, the modal shows a "Render view" button that
 * delegates to it (the caller handles the actual API call).
 *
 * @param {Object} [opts]
 * @param {Function} [opts.onRender]  — called when user clicks Render
 *   inside the modal. Receives the selected reference object. Returns
 *   a Promise that resolves with { sourceDataUrl, renderDataUrl } or
 *   rejects with an Error.
 */
export function openModal(opts) {
  if (_modalEl) return; // already open
  opts = opts || {};

  var overlay = document.createElement('div');
  overlay.id = 'ai-ref-modal';
  overlay.style.cssText = [
    'position:fixed', 'inset:0', 'z-index:9999',
    'background:rgba(0,0,0,0.6)',
    'display:flex', 'align-items:center', 'justify-content:center',
    'font-family:inherit'
  ].join(';');

  var card = document.createElement('div');
  card.style.cssText = [
    'background:var(--bg)', 'color:var(--text)',
    'width:min(1100px, 92vw)', 'height:min(720px, 88vh)',
    'border-radius:8px', 'box-shadow:0 10px 40px rgba(0,0,0,0.4)',
    'display:flex', 'flex-direction:column', 'overflow:hidden'
  ].join(';');

  card.innerHTML = renderModalContent();
  overlay.appendChild(card);
  document.body.appendChild(overlay);
  _modalEl = overlay;

  bindModalEvents(card, opts);
  // Click outside the card closes.
  overlay.addEventListener('click', function (e) {
    if (e.target === overlay) closeModal();
  });
  document.addEventListener('keydown', escClose, true);

  // First open: hydrate from IDB. While loading, the modal shows the
  // empty-state hint; when the cache is populated we re-render.
  ensureLoaded().then(function () {
    if (!_modalEl) return; // user closed during load
    card.innerHTML = renderModalContent();
    bindModalEvents(card, opts);
  });
}

function escClose(e) { if (e.key === 'Escape') closeModal(); }

function closeModal() {
  if (!_modalEl) return;
  document.removeEventListener('keydown', escClose, true);
  _modalEl.parentNode && _modalEl.parentNode.removeChild(_modalEl);
  _modalEl = null;
}

function renderModalContent() {
  var sel = getSelected();
  var h = '';
  // Header.
  h += '<div style="padding:10px 14px;border-bottom:1px solid var(--border);'
       + 'display:flex;align-items:center;gap:10px">';
  h += '<div style="font-weight:700;font-size:14px">References</div>';
  h += '<div style="font-size:11px;color:var(--text-muted)">'
       + _catalog.length + ' refs · click to select</div>';
  h += '<div style="margin-left:auto;display:flex;gap:6px">';
  h += '<button class="render-btn render-btn--secondary" id="ai-cat-add" style="padding:4px 10px">+ Add</button>';
  h += '<button class="render-btn render-btn--secondary" id="ai-cat-clear" style="padding:4px 10px">Clear all</button>';
  h += '<button class="render-btn render-btn--secondary" id="ai-cat-close" style="padding:4px 10px">×</button>';
  h += '</div></div>';

  // Body — split: catalog grid (left) + render zone (right).
  h += '<div style="flex:1;display:flex;min-height:0">';

  // Left: catalog grid.
  h += '<div style="width:55%;border-right:1px solid var(--border);overflow-y:auto;padding:10px 14px">';
  if (_catalog.length === 0) {
    h += '<div style="padding:40px 20px;text-align:center;color:var(--text-muted);font-size:12px">'
       + 'No references yet. Click <b>+ Add</b> to upload images, or drop files anywhere on this panel.</div>';
  } else {
    h += '<div id="ai-cat-grid" style="display:grid;grid-template-columns:repeat(auto-fill,minmax(140px,1fr));gap:8px">';
    for (var i = 0; i < _catalog.length; i++) {
      var r = _catalog[i];
      var selected = r.id === _selectedId;
      h += '<div data-ref-id="' + r.id + '" '
           + 'style="position:relative;cursor:pointer;border-radius:5px;'
           + 'border:2px solid ' + (selected ? 'var(--primary, #6366f1)' : 'transparent') + ';'
           + 'overflow:hidden;background:var(--bg-elev)">';
      h += '<img src="' + r.dataUrl + '" alt="' + escapeHtml(r.name)
           + '" style="display:block;width:100%;aspect-ratio:1/1;object-fit:cover">';
      h += '<div style="padding:3px 5px;font-size:9px;color:var(--text-muted);'
           + 'white-space:nowrap;overflow:hidden;text-overflow:ellipsis"'
           + ' title="' + escapeHtml(r.name) + '">' + escapeHtml(r.name) + '</div>';
      h += '<button data-rm-ref-id="' + r.id + '" '
           + 'style="position:absolute;top:4px;right:4px;width:18px;height:18px;'
           + 'border-radius:50%;border:0;background:rgba(0,0,0,0.6);color:#fff;'
           + 'font-size:11px;line-height:18px;padding:0;cursor:pointer">×</button>';
      h += '</div>';
    }
    h += '</div>';
  }
  h += '</div>';

  // Right: render zone.
  h += '<div style="width:45%;display:flex;flex-direction:column;min-height:0">';

  // Selection indicator + Render button.
  h += '<div style="padding:10px 14px;border-bottom:1px solid var(--border)">';
  if (sel) {
    h += '<div style="display:flex;align-items:center;gap:10px">';
    h += '<img src="' + sel.dataUrl + '" alt="' + escapeHtml(sel.name)
         + '" style="width:48px;height:48px;object-fit:cover;border-radius:4px;border:1px solid var(--border)">';
    h += '<div style="flex:1;min-width:0">';
    h += '<div style="font-size:11px;color:var(--text-muted);margin-bottom:2px">Selected reference</div>';
    h += '<div style="font-size:12px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis"'
         + ' title="' + escapeHtml(sel.name) + '">' + escapeHtml(sel.name) + '</div>';
    h += '</div></div>';
    h += '<button class="render-btn" id="ai-cat-render" '
         + 'style="margin-top:8px;width:100%;background:var(--primary);color:#fff;font-weight:700">'
         + 'Render view</button>';
    h += '<div id="ai-cat-status" style="font-size:11px;color:var(--text-muted);margin-top:4px;min-height:14px"></div>';
  } else {
    h += '<div style="font-size:12px;color:var(--text-muted)">'
       + 'Click a reference on the left to select.</div>';
  }
  h += '</div>';

  // Render result viewer.
  h += '<div id="ai-cat-result" style="flex:1;overflow-y:auto;padding:10px 14px"></div>';

  h += '</div>'; // /right
  h += '</div>'; // /body

  return h;
}

function bindModalEvents(card, opts) {
  function rerender() {
    if (!_modalEl) return;
    card.innerHTML = renderModalContent();
    bindModalEvents(card, opts);
  }

  var addBtn = card.querySelector('#ai-cat-add');
  if (addBtn) {
    addBtn.addEventListener('click', function () {
      var input = document.createElement('input');
      input.type = 'file';
      input.accept = 'image/*';
      input.multiple = true;
      input.style.display = 'none';
      input.addEventListener('change', function (e) {
        var files = e.target.files || [];
        var pending = files.length;
        if (pending === 0) return;
        for (var i = 0; i < files.length; i++) {
          addReference(files[i]).then(function () {
            pending--;
            if (pending === 0) rerender();
          }, function (err) {
            console.warn('[ai-render-catalog] add failed:', err);
            pending--;
            if (pending === 0) rerender();
          });
        }
      });
      document.body.appendChild(input);
      input.click();
      setTimeout(function () { document.body.removeChild(input); }, 0);
    });
  }

  var clearBtn = card.querySelector('#ai-cat-clear');
  if (clearBtn) {
    clearBtn.addEventListener('click', function () {
      if (_catalog.length === 0) return;
      if (!window.confirm('Remove all ' + _catalog.length + ' references?')) return;
      clearAll();
      rerender();
    });
  }

  var closeBtn = card.querySelector('#ai-cat-close');
  if (closeBtn) closeBtn.addEventListener('click', closeModal);

  var grid = card.querySelector('#ai-cat-grid');
  if (grid) {
    grid.addEventListener('click', function (e) {
      var rmBtn = e.target.closest && e.target.closest('[data-rm-ref-id]');
      if (rmBtn) {
        e.stopPropagation();
        removeReference(rmBtn.getAttribute('data-rm-ref-id'));
        rerender();
        return;
      }
      var card2 = e.target.closest && e.target.closest('[data-ref-id]');
      if (card2) {
        var id = card2.getAttribute('data-ref-id');
        selectReference(_selectedId === id ? null : id);
        rerender();
      }
    });
  }

  var renderBtn = card.querySelector('#ai-cat-render');
  if (renderBtn && opts.onRender) {
    renderBtn.addEventListener('click', async function () {
      if (_busy) return;
      var ref = getSelected();
      if (!ref) return;
      _busy = true;
      var statusEl = card.querySelector('#ai-cat-status');
      if (statusEl) statusEl.textContent = 'Rendering…';
      renderBtn.disabled = true;
      try {
        var result = await opts.onRender(ref);
        if (statusEl) statusEl.textContent = 'Done.';
        if (result && result.renderDataUrl) {
          showResult(card, result, ref);
        }
      } catch (err) {
        if (statusEl) statusEl.textContent = 'Error: ' + (err && err.message || err);
      } finally {
        _busy = false;
        renderBtn.disabled = false;
      }
    });
  }
}

/**
 * Append a render to the result viewer. result =
 *   { sourceDataUrl, renderDataUrl, label? }
 * The viewer is append-only within a session — successive renders
 * appear stacked so the user can scroll and compare.
 */
function showResult(card, result, ref) {
  var area = card.querySelector('#ai-cat-result');
  if (!area) return;
  var stamp = new Date().toLocaleTimeString();
  var block = document.createElement('div');
  block.style.cssText = 'margin-bottom:14px;padding-bottom:10px;border-bottom:1px solid var(--border)';
  var label = result.label || stamp;
  block.innerHTML =
    '<div style="font-size:10px;color:var(--text-muted);margin-bottom:4px">'
    + escapeHtml(label) + ' · ref: ' + escapeHtml(ref.name) + '</div>'
    + '<div style="display:grid;grid-template-columns:1fr 1fr;gap:6px">'
    + '<div><div style="font-size:9px;color:var(--text-muted);margin-bottom:2px">Source (current view)</div>'
    +   '<img src="' + result.sourceDataUrl + '" style="width:100%;border:1px solid var(--border);border-radius:4px;display:block"></div>'
    + '<div><div style="font-size:9px;color:var(--text-muted);margin-bottom:2px">Render</div>'
    +   '<img src="' + result.renderDataUrl + '" style="width:100%;border:1px solid var(--border);border-radius:4px;display:block"></div>'
    + '</div>'
    + '<div style="margin-top:4px;text-align:right">'
    +   '<a href="' + result.renderDataUrl + '" download="ai-render-' + Date.now()
    +   '.png" style="font-size:11px;color:var(--primary);text-decoration:none">Download PNG</a>'
    + '</div>';
  // Newest first.
  area.insertBefore(block, area.firstChild);
}
