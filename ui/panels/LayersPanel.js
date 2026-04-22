/**
 * LayersPanel — UI for remote MVT layers served by the Metapolis tiler.
 *
 * Renders into the DOM element with id="layers-section". FeaturePanel
 * creates that element; LayersPanel fills it with content.
 *
 * Structure per layer row:
 *   [☑] #101 Кадастровые данные территории
 *       geometry
 *       [ Жилые ]      ← preset toggle row (only for layers with
 *                        entries in LAYER_PRESETS, and only when
 *                        the layer is active on the map)
 *
 * Configuration
 * -------------
 *   LAYER_ID_FILTER     — predicate, which catalog ids appear in UI.
 *   LAYER_LABEL_OVERRIDES — { [id]: displayName }. Wins over
 *                         the name field returned by the server.
 *   LAYER_PRESETS       — { [id]: Preset[] } attribute-substring
 *                         filter presets. Each preset:
 *                           { id, label, substrings[], color? }
 *                         Clicking a preset button toggles a highlight
 *                         overlay on the map via the
 *                         'metatiler:highlight-substring' event.
 */

import { eventBus } from '../../core/EventBus.js';
import { layerIdOf, layerDisplayName, geometryTypeOf } from '../../core/metatiler/api.js';

// ── Config ────────────────────────────────────────────

/**
 * Which ids appear in the UI. The tiler catalog can contain test or
 * utility layers — filter them out at the presentation layer.
 *
 * Policy: numeric ids >= 100.
 */
var LAYER_ID_FILTER = function (id) {
  return typeof id === 'number' && id >= 100;
};

/**
 * Display-name overrides keyed by stringified layer id. Use when the
 * catalog name isn't useful (missing, generic, technical).
 */
var LAYER_LABEL_OVERRIDES = {
  '101': 'Кадастровые данные территории',
  '104': 'Здания (BTI)'
};

/**
 * Per-layer supplemental info to render under the row. Keyed by id.
 * Currently used to attach a legend block for the buildings layer.
 *
 * Shape:
 *   { type: 'legend', items: [{ label, color }, ...] }
 */
var LAYER_SUPPLEMENTS = {
  '104': {
    type: 'legend',
    items: [
      { label: 'Жилой фонд (многоквартирные)', color: '#3b82f6' },
      { label: 'Остальные здания',             color: '#94a3b8' }
    ],
    note: '3D появляется в радиусе 500м от объектов на карте, от z=14'
  }
};

/**
 * Attribute-substring filter presets per layer. Activating a preset
 * highlights every polygon whose ANY attribute value contains ANY
 * of the substrings (case-insensitive).
 *
 * "Жилые" preset — calibrated against the actual top values of
 * permitted_use / land_category in layer 101 (Moscow cadastre,
 * 302k features sampled). Key decisions:
 *
 *   - NOT included: 'садоводств', 'огородничеств', 'дачн',
 *     'приусад', 'лпх', 'личного подсобного'. These categorise
 *     LAND (садоводства 67k, ЛПХ 29k, дачные 14k) — plots for
 *     agricultural/subsidiary use, not residential buildings.
 *
 *   - NOT included: bare 'жилищ'. It matches both "жилищного
 *     строительства" (residential, good) AND "жилищно-
 *     коммунального хозяйства" (ЖКХ infra, 4.7k features — not
 *     residential). Replaced with the genitive-only forms
 *     'жилищного' / 'жилищных', which never appear in the
 *     hyphenated "жилищно-" compound.
 *
 *   - Added 'среднеэтажн' — matches "Для среднеэтажной застройки"
 *     and "Среднеэтажная жилая застройка (2.5)". Was missing.
 *
 *   - Forms of "жилой" cover: indiv/мкд/иных видов жилой застройки
 *     (~65k features combined).
 *
 *   - Етажность roots cover multi-storey residential in
 *     land_category_document descriptions.
 */
var LAYER_PRESETS = {
  '101': [
    {
      id: 'residential',
      label: 'Жилые',
      color: '#0d9488', // teal-600
      substrings: [
        // All case/gender forms of "жилой" — always residential.
        'жилая', 'жилой', 'жилое', 'жилом', 'жилых', 'жилыми', 'жилою',
        // Genitive forms of "жилищное" — never match the compound
        // "жилищно-коммунальное" (which uses stem жилищно-).
        'жилищного', 'жилищных',
        // Multi-apartment housing.
        'многоквартир',
        // Storey-based residential classification.
        'малоэтажн', 'многоэтажн', 'среднеэтажн'
      ]
    }
  ]
};

// ── State ─────────────────────────────────────────────

var _open = false;
var _catalog = null;
var _catalogError = null;
var _loading = false;
var _active = {};           // { [id]: true } — source+layers on map
var _visible = {};          // { [id]: true } — visibility=visible
var _entryById = {};        // cache of catalog entries keyed by id
var _activePreset = {};     // { [layerKey]: presetId } currently on

// Layers whose probe is complete — presets require attribute keys
// from the probe, so we disable preset buttons until then.
var _probed = {};

// ── Rendering ─────────────────────────────────────────

export function renderLayersSection() {
  var el = document.getElementById('layers-section');
  if (!el) return;

  var h = '<div class="props-divider"></div>';
  h += '<div class="param-row" style="cursor:pointer" id="layers-toggle-row">';
  h += '<label class="param-label" style="font-weight:600;cursor:pointer">Remote layers</label>';
  h += '<div class="param-input-wrap">';
  h += '<span id="layers-toggle-indicator" style="font-size:11px;color:'
    + (_open ? 'var(--primary)' : 'var(--text-muted)') + ';font-weight:'
    + (_open ? '700' : '400') + '">' + (_open ? 'ON' : 'OFF') + '</span>';
  h += '</div></div>';

  h += '<div id="layers-body" style="display:' + (_open ? 'block' : 'none') + '">';
  h += renderBody();
  h += '</div>';

  el.innerHTML = h;

  var toggleRow = document.getElementById('layers-toggle-row');
  if (toggleRow) toggleRow.addEventListener('click', onToggleClick);

  var refreshBtn = document.getElementById('layers-refresh-btn');
  if (refreshBtn) refreshBtn.addEventListener('click', onRefreshClick);

  var checks = document.querySelectorAll('.layers-check');
  for (var i = 0; i < checks.length; i++) {
    checks[i].addEventListener('change', onCheckChange);
  }

  var presets = document.querySelectorAll('.metatiler-preset');
  for (var p = 0; p < presets.length; p++) {
    presets[p].addEventListener('click', onPresetClick);
  }
}

function renderBody() {
  if (_loading) {
    return '<div style="padding:10px 4px;color:var(--text-muted);font-size:12px">Loading catalog…</div>';
  }

  var h = '';
  h += '<div style="display:flex;justify-content:flex-end;margin:4px 0 6px">';
  h += '<button id="layers-refresh-btn" class="btn-ghost" style="font-size:11px;padding:2px 8px">Refresh</button>';
  h += '</div>';

  if (_catalogError) {
    h += '<div style="padding:8px;color:#ef4444;font-size:12px;background:rgba(239,68,68,0.08);border-radius:4px;margin-bottom:6px">';
    h += 'Failed to load: ' + escapeHTML(_catalogError.message || 'unknown error');
    if (_catalogError.status) h += ' <span style="color:var(--text-muted)">(HTTP ' + _catalogError.status + ')</span>';
    h += '</div>';
    return h;
  }
  if (!_catalog) {
    h += '<div style="color:var(--text-muted);font-size:12px;padding:6px 0">Click Refresh to load the layer catalog.</div>';
    return h;
  }

  var hiddenCount = 0;
  var visibleEntries = [];
  for (var i = 0; i < _catalog.length; i++) {
    var entry = _catalog[i];
    var id = layerIdOf(entry);
    if (id == null || !LAYER_ID_FILTER(id)) { hiddenCount++; continue; }
    visibleEntries.push(entry);
  }

  if (visibleEntries.length === 0) {
    h += '<div style="color:var(--text-muted);font-size:12px;padding:6px 0">'
      + 'No layers pass the id filter. '
      + 'Catalog has ' + _catalog.length + ' entries — adjust LAYER_ID_FILTER in LayersPanel.js.'
      + '</div>';
    return h;
  }

  visibleEntries.sort(function (a, b) {
    var ia = layerIdOf(a), ib = layerIdOf(b);
    if (typeof ia === 'number' && typeof ib === 'number') return ia - ib;
    if (typeof ia === 'number') return -1;
    if (typeof ib === 'number') return 1;
    return String(ia) < String(ib) ? -1 : 1;
  });

  for (var j = 0; j < visibleEntries.length; j++) {
    h += renderLayerRow(visibleEntries[j]);
  }
  if (hiddenCount > 0) {
    h += '<div style="color:var(--text-muted);font-size:10px;padding:6px 2px 0;border-top:1px solid var(--border-color);margin-top:6px">'
      + hiddenCount + ' entr' + (hiddenCount === 1 ? 'y' : 'ies') + ' hidden by id filter'
      + '</div>';
  }
  return h;
}

function renderLayerRow(entry) {
  var id = layerIdOf(entry);
  if (id == null) return '';
  var key = String(id);
  // Label: explicit override wins over the catalog-derived name.
  var name = LAYER_LABEL_OVERRIDES[key] || layerDisplayName(entry);
  var geomType = geometryTypeOf(entry);
  var checked = !!_visible[key];

  var h = '<div class="param-row" style="align-items:center;gap:6px">';
  h += '<input type="checkbox" class="layers-check" data-layer-id="'
    + escapeAttr(key) + '"' + (checked ? ' checked' : '') + ' style="margin:0">';
  h += '<label class="param-label" style="flex:1;display:flex;flex-direction:column;gap:1px;font-size:12px;line-height:1.3">';
  h += '<span><span style="color:var(--text-muted);font-family:SF Mono,Consolas,monospace">#' + escapeHTML(String(id)) + '</span> ';
  h += '<span style="font-weight:500">' + escapeHTML(name) + '</span></span>';
  if (geomType) {
    h += '<span style="color:var(--text-muted);font-size:10px">' + escapeHTML(geomType) + '</span>';
  }
  h += '</label>';
  h += '</div>';

  // Preset toggle strip — shown only when the layer is active and
  // its probe has completed (probed=true means attribute keys are
  // available, which the module needs to build the filter).
  if (_active[key] && LAYER_PRESETS[key]) {
    h += renderPresetRow(key);
  }

  // Supplemental legend — for typed layers (e.g. buildings) that
  // paint with category colours.
  if (_active[key] && LAYER_SUPPLEMENTS[key]) {
    h += renderSupplement(key);
  }
  return h;
}

function renderSupplement(key) {
  var supp = LAYER_SUPPLEMENTS[key];
  if (!supp || supp.type !== 'legend') return '';
  var items = supp.items || [];

  var h = '<div class="metatiler-legend">';
  for (var i = 0; i < items.length; i++) {
    var it = items[i];
    h += '<div class="metatiler-legend-row">';
    h += '<span class="metatiler-legend-swatch" style="background:' + escapeAttr(it.color) + '"></span>';
    h += '<span class="metatiler-legend-label">' + escapeHTML(it.label) + '</span>';
    h += '</div>';
  }
  if (supp.note) {
    h += '<div class="metatiler-legend-note">' + escapeHTML(supp.note) + '</div>';
  }
  h += '</div>';
  return h;
}

function renderPresetRow(key) {
  var presets = LAYER_PRESETS[key] || [];
  var disabled = !_probed[key];
  var activeId = _activePreset[key];

  var h = '<div class="metatiler-preset-row">';
  for (var i = 0; i < presets.length; i++) {
    var p = presets[i];
    var isActive = (activeId === p.id);
    var cls = 'metatiler-preset' + (isActive ? ' metatiler-preset--active' : '');
    h += '<button class="' + cls + '"'
      + ' data-layer-id="' + escapeAttr(key) + '"'
      + ' data-preset-id="' + escapeAttr(p.id) + '"'
      + (disabled ? ' disabled title="Waiting for probe…"' : '')
      + (isActive ? ' style="background:' + escapeAttr(p.color) + ';border-color:' + escapeAttr(p.color) + '"' : '')
      + '>' + escapeHTML(p.label) + '</button>';
  }
  h += '</div>';
  return h;
}

// ── Utilities ─────────────────────────────────────────

function escapeHTML(s) {
  if (s == null) return '';
  return String(s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
function escapeAttr(s) { return escapeHTML(s); }

function parseMaybeNumeric(s) {
  if (s == null) return s;
  if (typeof s === 'number') return s;
  var n = Number(s);
  if (!isNaN(n) && String(n) === s) return n;
  return s;
}

// ── Handlers ──────────────────────────────────────────

function onToggleClick() {
  _open = !_open;
  if (_open && _catalog == null && !_loading) {
    _loading = true;
    eventBus.emit('metatiler:fetch-catalog');
  }
  renderLayersSection();
}

function onRefreshClick() {
  _loading = true;
  _catalog = null;
  _catalogError = null;
  renderLayersSection();
  eventBus.emit('metatiler:fetch-catalog');
}

function onCheckChange(e) {
  var cb = e.target;
  var key = cb.dataset.layerId;
  if (!key) return;
  var checked = !!cb.checked;
  var id = parseMaybeNumeric(key);

  if (checked) {
    if (_active[key]) {
      _visible[key] = true;
      eventBus.emit('metatiler:set-visibility', { layerId: id, visible: true });
    } else {
      _active[key] = true;
      _visible[key] = true;
      eventBus.emit('metatiler:add-layer', {
        layerId: id, meta: _entryById[key] || null
      });
      renderLayersSection(); // to show preset row
    }
  } else {
    if (_active[key]) {
      _visible[key] = false;
      eventBus.emit('metatiler:set-visibility', { layerId: id, visible: false });
    }
  }
}

function onPresetClick(e) {
  var btn = e.currentTarget;
  if (btn.disabled) return;
  var key = btn.dataset.layerId;
  var presetId = btn.dataset.presetId;
  var presets = LAYER_PRESETS[key];
  if (!presets) return;
  var preset = null;
  for (var i = 0; i < presets.length; i++) {
    if (presets[i].id === presetId) { preset = presets[i]; break; }
  }
  if (!preset) return;

  var numId = parseMaybeNumeric(key);
  if (_activePreset[key] === presetId) {
    // Toggle off.
    delete _activePreset[key];
    eventBus.emit('metatiler:highlight-substring', {
      layerId: numId, substrings: []
    });
  } else {
    _activePreset[key] = presetId;
    eventBus.emit('metatiler:highlight-substring', {
      layerId: numId,
      substrings: preset.substrings,
      color: preset.color
    });
  }
  renderLayersSection();
}

// ── Event subscriptions ───────────────────────────────

export function initLayersPanelEvents() {
  eventBus.on('metatiler:catalog', function (d) {
    _loading = false;
    if (d && d.error) { _catalogError = d.error; _catalog = null; }
    else {
      _catalogError = null;
      _catalog = (d && d.layers) ? d.layers : [];
      _entryById = {};
      for (var i = 0; i < _catalog.length; i++) {
        var id = layerIdOf(_catalog[i]);
        if (id != null) _entryById[String(id)] = _catalog[i];
      }
    }
    renderLayersSection();
  });

  eventBus.on('metatiler:layer:changed', function (d) {
    if (!d || d.layerId == null) return;
    var key = String(d.layerId);
    if (d.removed) {
      delete _active[key];
      delete _visible[key];
      delete _probed[key];
      delete _activePreset[key];
    } else {
      _active[key] = true;
      _visible[key] = !!d.visible;
      if (d.probed) _probed[key] = true;
    }
    if (_open) renderLayersSection();
  });

  // When the module confirms a probe completed (via layer:changed
  // with probed:true) or clears a substring highlight, keep panel
  // state in sync.
  eventBus.on('metatiler:highlight:changed', function (d) {
    if (!d || d.layerId == null) return;
    var key = String(d.layerId);
    if (!d.active) {
      delete _activePreset[key];
      if (_open) renderLayersSection();
    }
  });
}
