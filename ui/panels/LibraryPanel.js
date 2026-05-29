/**
 * LibraryPanel — right-sidebar entry into the parametric library.
 *
 * Renders a single button "Library…" into the `library-section`
 * container inside the right sidebar. Clicking it opens a modal
 * with one card per registered element (icon + name + presets).
 * Selecting a card primes the LibraryPlaceTool with the chosen
 * elementId/preset and activates the tool — the next click on
 * the map drops a placed point.
 *
 * Styling pulls from the app's existing light-theme tokens
 * (CSS variables in styles/main.css). No bespoke palette, no
 * shadow drops — same look as the other right-panel sections.
 */

import { eventBus } from '../../core/EventBus.js';
import { listAll as listAllElements, listCategories } from '../../elements/registry.js';
import { LibraryPlaceTool } from '../../draw/tools/LibraryPlaceTool.js';

// ── Right-panel section ─────────────────────────────────

export function renderLibrarySection() {
  var el = document.getElementById('library-section');
  if (!el) return;
  var h = '';
  h += '<div class="props-divider"></div>';
  h += '<div class="props-header-small" style="padding-top:8px">Library</div>';
  h += '<div class="param-row">';
  h += '<label class="param-label">Parametric elements</label>';
  h += '<div class="param-input-wrap">';
  h += '<button class="render-btn render-btn--secondary" id="library-open-btn" '
    + 'style="width:auto;padding:4px 10px">Open…</button>';
  h += '</div></div>';
  el.innerHTML = h;
  var btn = document.getElementById('library-open-btn');
  if (btn) btn.addEventListener('click', openModal);
}

// ── Modal ───────────────────────────────────────────────

var _modal = null;

export function openModal() {
  if (_modal) closeModal();
  _modal = buildModal();
  document.body.appendChild(_modal);
}

export function closeModal() {
  if (_modal && _modal.parentElement) _modal.parentElement.removeChild(_modal);
  _modal = null;
}

function buildModal() {
  var overlay = document.createElement('div');
  overlay.className = 'lib-modal-overlay';
  overlay.style.cssText =
    'position:fixed;inset:0;background:rgba(31,41,55,0.45);z-index:9000;'
    + 'display:flex;align-items:center;justify-content:center;'
    + 'font-family:inherit';
  overlay.addEventListener('click', function (e) {
    if (e.target === overlay) closeModal();
  });

  var card = document.createElement('div');
  card.style.cssText =
    'background:var(--bg-primary);color:var(--text-primary);'
    + 'border:1px solid var(--border-color);border-radius:8px;'
    + 'width:min(720px, 92vw);max-height:80vh;display:flex;flex-direction:column;'
    + 'overflow:hidden;box-shadow:0 24px 60px rgba(0,0,0,0.18)';
  overlay.appendChild(card);

  // ── Header ──
  var header = document.createElement('div');
  header.className = 'panel-header';
  header.style.cssText = 'position:relative;border-bottom:1px solid var(--border-color)';
  header.innerHTML =
    '<span class="panel-title">Library — parametric elements</span>'
    + '<span style="font-size:11px;color:var(--text-muted);margin-left:8px">'
    + 'Pick → click the map to place</span>';
  card.appendChild(header);

  // Close button
  var closeBtn = document.createElement('button');
  closeBtn.textContent = '✕';
  closeBtn.title = 'Close (Esc)';
  closeBtn.style.cssText =
    'position:absolute;right:12px;top:50%;transform:translateY(-50%);'
    + 'background:transparent;border:none;color:var(--text-muted);'
    + 'cursor:pointer;font-size:14px;line-height:1;padding:4px 8px;'
    + 'border-radius:4px;transition:all var(--transition-fast)';
  closeBtn.addEventListener('mouseenter', function () {
    closeBtn.style.background = 'var(--bg-tertiary)';
    closeBtn.style.color = 'var(--text-primary)';
  });
  closeBtn.addEventListener('mouseleave', function () {
    closeBtn.style.background = 'transparent';
    closeBtn.style.color = 'var(--text-muted)';
  });
  closeBtn.addEventListener('click', closeModal);
  header.appendChild(closeBtn);

  // ── Body ──
  var body = document.createElement('div');
  body.className = 'panel-body';
  body.style.cssText = 'padding:14px 16px;overflow:auto;flex:1';
  card.appendChild(body);

  renderBody(body);

  // Esc to close
  function onKey(e) {
    if (e.key === 'Escape') { closeModal(); document.removeEventListener('keydown', onKey); }
  }
  document.addEventListener('keydown', onKey);

  return overlay;
}

function renderBody(body) {
  var elements = listAllElements();
  if (!elements || elements.length === 0) {
    body.innerHTML =
      '<div style="color:var(--text-muted);font-size:12px;padding:24px;text-align:center">'
      + 'No library elements registered yet.</div>';
    return;
  }

  // Group by category. Stable insertion order via listCategories().
  var byCat = {};
  for (var i = 0; i < elements.length; i++) {
    var c = elements[i].category || 'other';
    if (!byCat[c]) byCat[c] = [];
    byCat[c].push(elements[i]);
  }

  var cats = listCategories();
  for (var k in byCat) {
    if (cats.indexOf(k) === -1) cats.push(k);
  }

  var html = '';
  for (var ci = 0; ci < cats.length; ci++) {
    var cat = cats[ci];
    var items = byCat[cat];
    if (!items || items.length === 0) continue;
    html += '<div style="margin-bottom:16px">';
    html += '<div class="props-header-small" style="padding:0 0 6px 0">'
         + escapeHTML(cat) + '</div>';
    html += '<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(180px,1fr));gap:8px">';
    for (var ii = 0; ii < items.length; ii++) {
      html += renderCard(items[ii]);
    }
    html += '</div></div>';
  }
  body.innerHTML = html;

  // Wire card clicks
  var cards = body.querySelectorAll('.lib-card');
  for (var j = 0; j < cards.length; j++) {
    cards[j].addEventListener('click', onCardClick);
    cards[j].addEventListener('mouseenter', function (e) {
      e.currentTarget.style.borderColor = 'var(--primary)';
    });
    cards[j].addEventListener('mouseleave', function (e) {
      e.currentTarget.style.borderColor = 'var(--border-color)';
    });
  }
  var presets = body.querySelectorAll('.lib-preset');
  for (var p = 0; p < presets.length; p++) {
    presets[p].addEventListener('click', onPresetClick);
  }
}

function renderCard(el) {
  var icon = el.icon || defaultIcon();
  var h = '';
  h += '<div class="lib-card" data-element-id="' + escapeAttr(el.id)
    + '" style="background:var(--bg-secondary);border:1px solid var(--border-color);'
    + 'border-radius:6px;padding:10px;cursor:pointer;'
    + 'transition:border-color var(--transition-fast)">';
  h += '<div style="display:flex;align-items:center;gap:10px">';
  h += '<div style="width:36px;height:36px;display:flex;align-items:center;justify-content:center;'
    + 'background:var(--bg-primary);border:1px solid var(--border-color);'
    + 'border-radius:6px;color:var(--primary);flex-shrink:0">'
    + icon + '</div>';
  h += '<div style="min-width:0;flex:1">';
  h += '<div style="font-size:12px;font-weight:600;line-height:1.2;color:var(--text-primary);'
    + 'white-space:nowrap;overflow:hidden;text-overflow:ellipsis">'
    + escapeHTML(el.name || el.id) + '</div>';
  h += '<div style="font-size:10px;color:var(--text-muted);margin-top:2px">'
    + escapeHTML(el.typology || '—') + '</div>';
  h += '</div></div>';
  // Presets row (if any)
  if (el.presets && Object.keys(el.presets).length > 0) {
    h += '<div style="margin-top:8px;display:flex;flex-wrap:wrap;gap:4px">';
    var names = Object.keys(el.presets);
    for (var i = 0; i < names.length; i++) {
      h += '<button class="lib-preset render-btn render-btn--secondary" '
        + 'data-element-id="' + escapeAttr(el.id) + '"'
        + ' data-preset="' + escapeAttr(names[i]) + '"'
        + ' style="width:auto;padding:2px 8px;font-size:10px;font-weight:500">'
        + escapeHTML(names[i]) + '</button>';
    }
    h += '</div>';
  }
  h += '</div>';
  return h;
}

function onCardClick(e) {
  if (e.target.classList && e.target.classList.contains('lib-preset')) return;
  var elId = e.currentTarget.getAttribute('data-element-id');
  activatePlacement(elId, null);
}

function onPresetClick(e) {
  e.stopPropagation();
  var elId = e.currentTarget.getAttribute('data-element-id');
  var preset = e.currentTarget.getAttribute('data-preset');
  activatePlacement(elId, preset);
}

function activatePlacement(elementId, preset) {
  if (!elementId) return;
  LibraryPlaceTool.pendingElementId = elementId;
  LibraryPlaceTool.pendingPreset = preset || null;
  eventBus.emit('tool:request-activate', { toolId: 'library-place' });
  closeModal();
}

// ── Helpers ─────────────────────────────────────────────

function defaultIcon() {
  // Generic block icon — matches toolbar stroke style (2px, currentColor).
  return '<svg viewBox="0 0 24 24" width="24" height="24" fill="none" '
    + 'stroke="currentColor" stroke-width="2" stroke-linejoin="round">'
    + '<rect x="5" y="5" width="14" height="14" rx="1"/></svg>';
}

function escapeHTML(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
function escapeAttr(s) { return escapeHTML(s); }
