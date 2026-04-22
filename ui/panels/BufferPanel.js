/**
 * BufferPanel — buffer distance controls (fire/insol/end/road).
 *
 * Emits 'buffers:distance:changed' {key, value} when any slider changes.
 * Listens to 'buffers:distances:external' to sync from urban-block panel.
 */

import { eventBus } from '../../core/EventBus.js';

var BUFFER_DEFS = [
  { key: 'fire',       label: 'Fire',       unit: 'm', step: 1,  min: 1,   max: 30,   color: '#dc2626', def: 14 },
  { key: 'insolation', label: 'Insol',      unit: 'm', step: 1,  min: 10,  max: 80,   color: '#16a34a', def: 30 },
  { key: 'end',        label: 'End',        unit: 'm', step: 1,  min: 5,   max: 40,   color: '#2563eb', def: 20 },
  { key: 'road',       label: 'Road',       unit: 'm', step: 1,  min: 5,   max: 30,   color: '#f59e0b', def: 14 },
  // Buildings lazy-load radii. Different event channel
  // (`buildings:radii:changed`), flagged by `channel: 'buildings'`.
  // These don't participate in the solver's axis-trimming — they only
  // drive the #104 3D-extrusion pipeline. Per-row visibility is also
  // managed here so the user can hide the coloured buffer shapes on
  // the map without losing the filtering behaviour.
  { key: 'bldgOuter',  label: 'Outer bldg', unit: 'm', step: 10, min: 100, max: 2000, color: '#3b82f6', def: 300, channel: 'buildings', visToggle: true, visDef: false },
  { key: 'bldgInner',  label: 'Inner bldg', unit: 'm', step: 5,  min: 0,   max: 200,  color: '#dc2626', def: 40,  channel: 'buildings', visToggle: true, visDef: false }
];

// Extra numeric parameters for buffer shapes (e.g. corner rounding radii).
// These flow through the same 'buffers:distance:changed' event with their
// own key names so callers can distinguish from the main distances.
var SHAPE_PARAMS = [
  { key: 'insolCornerR', label: 'Insol corner r', unit: 'm', step: 1, min: 0, max: 30, def: 15 }
];

/**
 * Expose BufferPanel defaults so app.js can seed the global snapshot
 * (window.__UB_BUFFER_DISTS__) before any block is drawn. BufferPanel
 * is the single source of truth — both the visual buffers AND the
 * solver's axis-trimming buffers read from here.
 */
export function getBufferDefaults() {
  var out = {};
  for (var i = 0; i < BUFFER_DEFS.length; i++) {
    if (BUFFER_DEFS[i].channel === 'buildings') continue; // buildings radii don't belong in the urban-block snapshot
    out[BUFFER_DEFS[i].key] = BUFFER_DEFS[i].def;
  }
  for (var j = 0; j < SHAPE_PARAMS.length; j++) out[SHAPE_PARAMS[j].key] = SHAPE_PARAMS[j].def;
  return out;
}

export function renderBufferSection() {
  var el = document.getElementById('buffer-section');
  if (!el) return;
  var h = '<div class="props-divider"></div>';
  h += '<div class="param-row" style="cursor:pointer" id="buffer-toggle-row">';
  h += '<label class="param-label" style="font-weight:600;cursor:pointer">Buffers</label>';
  h += '<div class="param-input-wrap"><span id="buffer-toggle-indicator" style="font-size:11px;color:var(--text-muted)">OFF</span></div></div>';
  h += '<div id="buffer-params" style="display:none">';
  for (var i = 0; i < BUFFER_DEFS.length; i++) {
    var d = BUFFER_DEFS[i];
    // Coloured swatch. For rows with a per-row visibility toggle
    // (bldg-outer/inner), the swatch doubles as the toggle button —
    // saturated = visible, muted outline-only = hidden.
    var swatchStyle;
    if (d.visToggle) {
      var on = !!d.visDef;
      swatchStyle = 'width:10px;height:10px;border-radius:2px;cursor:pointer;flex-shrink:0;'
        + (on
          ? 'background:' + d.color + ';border:1px solid ' + d.color
          : 'background:transparent;border:1px solid ' + d.color);
      h += '<div class="param-row"><span class="buf-vis-swatch" data-vis="' + d.key + '"'
        + ' data-on="' + (on ? '1' : '0') + '" data-color="' + d.color + '"'
        + ' title="Click to toggle visibility of this buffer on the map"'
        + ' style="' + swatchStyle + '"></span>';
    } else {
      swatchStyle = 'width:8px;height:8px;border-radius:2px;background:' + d.color + ';flex-shrink:0';
      h += '<div class="param-row"><span style="' + swatchStyle + '"></span>';
    }
    h += '<label class="param-label" style="flex:1">' + d.label + '</label>';
    h += '<div class="param-input-wrap"><input type="number" class="param-input" data-buf="' + d.key + '"';
    h += ' value="' + d.def + '" step="' + d.step + '" min="' + d.min + '" max="' + d.max + '" style="width:50px">';
    h += '<span class="param-unit">' + d.unit + '</span></div></div>';
  }
  // Shape parameters (corner radii etc.)
  for (var j = 0; j < SHAPE_PARAMS.length; j++) {
    var sp = SHAPE_PARAMS[j];
    h += '<div class="param-row"><span style="width:8px;flex-shrink:0"></span>';
    h += '<label class="param-label" style="flex:1;color:var(--text-muted);font-size:11px">' + sp.label + '</label>';
    h += '<div class="param-input-wrap"><input type="number" class="param-input" data-shape="' + sp.key + '"';
    h += ' value="' + sp.def + '" step="' + sp.step + '" min="' + sp.min + '" max="' + sp.max + '" style="width:44px">';
    h += '<span class="param-unit">' + sp.unit + '</span></div></div>';
  }
  h += '</div>';

  el.innerHTML = h;

  var toggleRow = document.getElementById('buffer-toggle-row');
  if (toggleRow) toggleRow.addEventListener('click', function () { eventBus.emit('buffers:toggle'); });

  // Numeric inputs. Routing depends on each row's `channel` — rows
  // flagged 'buildings' emit `buildings:radii:changed` with the full
  // radii snapshot so metatiler doesn't need to track partial state.
  // Rows without a channel emit the legacy `buffers:distance:changed`.
  function readBldgRadii() {
    var out = { outerMeters: undefined, innerMeters: undefined };
    var oi = document.querySelector('.param-input[data-buf="bldgOuter"]');
    var ii = document.querySelector('.param-input[data-buf="bldgInner"]');
    if (oi) { var ov = parseFloat(oi.value); if (!isNaN(ov)) out.outerMeters = ov; }
    if (ii) { var iv = parseFloat(ii.value); if (!isNaN(iv)) out.innerMeters = iv; }
    return out;
  }
  function findDef(key) {
    for (var i = 0; i < BUFFER_DEFS.length; i++) {
      if (BUFFER_DEFS[i].key === key) return BUFFER_DEFS[i];
    }
    return null;
  }
  var inputs = document.querySelectorAll('.param-input[data-buf]');
  for (var i = 0; i < inputs.length; i++) {
    inputs[i].addEventListener('input', function (e) {
      var val = parseFloat(e.target.value);
      if (isNaN(val)) return;
      var def = findDef(e.target.dataset.buf);
      if (def && def.channel === 'buildings') {
        eventBus.emit('buildings:radii:changed', readBldgRadii());
      } else {
        eventBus.emit('buffers:distance:changed', { key: e.target.dataset.buf, value: val });
      }
    });
  }
  var shapeInputs = document.querySelectorAll('.param-input[data-shape]');
  for (var k = 0; k < shapeInputs.length; k++) {
    shapeInputs[k].addEventListener('input', function (e) {
      var val = parseFloat(e.target.value);
      if (!isNaN(val)) eventBus.emit('buffers:distance:changed', { key: e.target.dataset.shape, value: val });
    });
  }

  // Per-row visibility swatches (currently only bldg-outer / bldg-inner).
  // Emits `buildings:buffer-visibility:changed` {which, visible}.
  var visSwatches = document.querySelectorAll('.buf-vis-swatch');
  for (var vi = 0; vi < visSwatches.length; vi++) {
    visSwatches[vi].addEventListener('click', function (e) {
      var sw = e.currentTarget;
      var on = sw.dataset.on === '1';
      on = !on;
      sw.dataset.on = on ? '1' : '0';
      var color = sw.dataset.color;
      if (on) {
        sw.style.background = color;
        sw.style.border = '1px solid ' + color;
      } else {
        sw.style.background = 'transparent';
        sw.style.border = '1px solid ' + color;
      }
      var which = sw.dataset.vis === 'bldgOuter' ? 'outer'
                : sw.dataset.vis === 'bldgInner' ? 'inner'
                : sw.dataset.vis;
      eventBus.emit('buildings:buffer-visibility:changed', { which: which, visible: on });
    });
  }

  // Emit initial state for every buffer param so downstream consumers
  // receive the current UI values. Buildings rows emit on their own
  // channel so buffers/index.js doesn't try to visualise them with
  // its fire/insol rendering path.
  var initBldg = { outerMeters: undefined, innerMeters: undefined };
  for (var bi = 0; bi < BUFFER_DEFS.length; bi++) {
    var bd = BUFFER_DEFS[bi];
    if (bd.channel === 'buildings') {
      if (bd.key === 'bldgOuter') initBldg.outerMeters = bd.def;
      else if (bd.key === 'bldgInner') initBldg.innerMeters = bd.def;
    } else {
      eventBus.emit('buffers:distance:changed', { key: bd.key, value: bd.def, initial: true });
    }
  }
  if (initBldg.outerMeters !== undefined || initBldg.innerMeters !== undefined) {
    eventBus.emit('buildings:radii:changed', initBldg);
  }
  for (var sp = 0; sp < SHAPE_PARAMS.length; sp++) {
    var spd = SHAPE_PARAMS[sp];
    eventBus.emit('buffers:distance:changed', { key: spd.key, value: spd.def, initial: true });
  }

  // When metatiler activates the buildings layer it seeds the radii
  // from the layer config. Reflect those seeded values in the UI so
  // inputs show the real defaults (e.g. config might be 400/30 even
  // though BUFFER_DEFS defaults are 500/40).
  eventBus.on('buildings:radii:seeded', function (d) {
    if (!d) return;
    var oi = document.querySelector('.param-input[data-buf="bldgOuter"]');
    var ii = document.querySelector('.param-input[data-buf="bldgInner"]');
    if (oi && !oi.matches(':focus') && typeof d.outerMeters === 'number') {
      oi.value = d.outerMeters;
    }
    if (ii && !ii.matches(':focus') && typeof d.innerMeters === 'number') {
      ii.value = d.innerMeters;
    }
  });
}

/**
 * Sync values shown in BufferPanel from an external source (e.g. the
 * urban-block right panel sliders). Called when that panel emits
 * 'buffers:distances:external' with the current values.
 */
export function syncBufferInputs(values) {
  if (!values) return;
  var mapBuf = {
    fire: values.fire,
    insolation: values.insolation != null ? values.insolation : values.insol,
    end: values.end != null ? values.end : values.endB,
    road: values.road
  };
  var bKeys = Object.keys(mapBuf);
  for (var i = 0; i < bKeys.length; i++) {
    var k = bKeys[i];
    var v = mapBuf[k];
    if (v == null) continue;
    var input = document.querySelector('.param-input[data-buf="' + k + '"]');
    if (input && !input.matches(':focus')) input.value = v;
  }
  // Shape params (corner radii etc.)
  for (var s = 0; s < SHAPE_PARAMS.length; s++) {
    var key = SHAPE_PARAMS[s].key;
    if (values[key] == null) continue;
    var si = document.querySelector('.param-input[data-shape="' + key + '"]');
    if (si && !si.matches(':focus')) si.value = values[key];
  }
}

export function onBuffersVisibility(d) {
  var ind = document.getElementById('buffer-toggle-indicator');
  var params = document.getElementById('buffer-params');
  if (ind) {
    ind.textContent = d.visible ? 'ON' : 'OFF';
    ind.style.color = d.visible ? 'var(--primary)' : 'var(--text-muted)';
    ind.style.fontWeight = d.visible ? '700' : '400';
  }
  if (params) params.style.display = d.visible ? 'block' : 'none';
}
