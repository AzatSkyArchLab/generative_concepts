/**
 * BufferPanel — buffer distance controls (fire/insol/end/road).
 *
 * Emits 'buffers:distance:changed' {key, value} when any slider changes.
 * Listens to 'buffers:distances:external' to sync from urban-block panel.
 */

import { eventBus } from '../../core/EventBus.js';

var BUFFER_DEFS = [
  { key: 'fire',       label: 'Fire',  unit: 'm', step: 1, min: 1,  max: 30, color: '#dc2626', def: 14 },
  { key: 'insolation', label: 'Insol', unit: 'm', step: 1, min: 10, max: 80, color: '#16a34a', def: 30 },
  { key: 'end',        label: 'End',   unit: 'm', step: 1, min: 5,  max: 40, color: '#2563eb', def: 20 },
  { key: 'road',       label: 'Road',  unit: 'm', step: 1, min: 5,  max: 30, color: '#f59e0b', def: 14 }
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
  for (var i = 0; i < BUFFER_DEFS.length; i++) out[BUFFER_DEFS[i].key] = BUFFER_DEFS[i].def;
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
    h += '<div class="param-row"><span style="width:8px;height:8px;border-radius:2px;background:' + d.color + ';flex-shrink:0"></span>';
    h += '<label class="param-label" style="flex:1">' + d.label + '</label>';
    h += '<div class="param-input-wrap"><input type="number" class="param-input" data-buf="' + d.key + '"';
    h += ' value="' + d.def + '" step="' + d.step + '" min="' + d.min + '" max="' + d.max + '" style="width:44px">';
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

  // Use 'input' event, not 'change' — fires on every keystroke/arrow
  // click, matching the urban-block slider behavior. Otherwise the
  // BufferPanel would lag behind until the field loses focus.
  var inputs = document.querySelectorAll('.param-input[data-buf]');
  for (var i = 0; i < inputs.length; i++) {
    inputs[i].addEventListener('input', function (e) {
      var val = parseFloat(e.target.value);
      if (!isNaN(val)) eventBus.emit('buffers:distance:changed', { key: e.target.dataset.buf, value: val });
    });
  }
  var shapeInputs = document.querySelectorAll('.param-input[data-shape]');
  for (var k = 0; k < shapeInputs.length; k++) {
    shapeInputs[k].addEventListener('input', function (e) {
      var val = parseFloat(e.target.value);
      if (!isNaN(val)) eventBus.emit('buffers:distance:changed', { key: e.target.dataset.shape, value: val });
    });
  }

  // Emit initial state for every buffer param so downstream consumers
  // (modules/buffers visualizer AND urban-block solver rebuild flow in
  // app.js) receive the current UI values through the same channel.
  // Keeps BufferPanel as the single source of truth — solver/visual
  // defaults are not "hoped to match", they flow from here explicitly.
  for (var bi = 0; bi < BUFFER_DEFS.length; bi++) {
    var bd = BUFFER_DEFS[bi];
    eventBus.emit('buffers:distance:changed', { key: bd.key, value: bd.def, initial: true });
  }
  for (var sp = 0; sp < SHAPE_PARAMS.length; sp++) {
    var spd = SHAPE_PARAMS[sp];
    eventBus.emit('buffers:distance:changed', { key: spd.key, value: spd.def, initial: true });
  }
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
