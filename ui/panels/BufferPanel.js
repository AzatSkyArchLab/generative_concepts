/**
 * BufferPanel — buffer distance controls (fire/end/insolation).
 */

import { eventBus } from '../../core/EventBus.js';

var BUFFER_DEFS = [
  { key: 'fire', label: 'Fire', unit: 'м', step: 1, min: 1, max: 30, color: '#dc2626', def: 11 },
  { key: 'end', label: 'End', unit: 'м', step: 1, min: 5, max: 40, color: '#2563eb', def: 20 },
  { key: 'insolation', label: 'Insol', unit: 'м', step: 5, min: 10, max: 80, color: '#16a34a', def: 40 }
];

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
    var autoLabel = d.key === 'fire' ? ' <small style="color:var(--text-muted)">(auto)</small>' : '';
    h += '<div class="param-row"><span style="width:8px;height:8px;border-radius:2px;background:' + d.color + ';flex-shrink:0"></span>';
    h += '<label class="param-label" style="flex:1">' + d.label + autoLabel + '</label>';
    h += '<div class="param-input-wrap"><input type="number" class="param-input" data-buf="' + d.key + '"';
    h += ' value="' + d.def + '" step="' + d.step + '" min="' + d.min + '" max="' + d.max + '" style="width:44px"';
    h += (d.key === 'fire' ? ' disabled title="Auto: ≤28m→11m, >28m→14m"' : '') + '>';
    h += '<span class="param-unit">' + d.unit + '</span></div></div>';
  }
  h += '</div>';
  el.innerHTML = h;

  var toggleRow = document.getElementById('buffer-toggle-row');
  if (toggleRow) toggleRow.addEventListener('click', function () { eventBus.emit('buffers:toggle'); });
  var inputs = document.querySelectorAll('.param-input[data-buf]');
  for (var i = 0; i < inputs.length; i++) {
    inputs[i].addEventListener('change', function (e) {
      var val = parseFloat(e.target.value);
      if (!isNaN(val)) eventBus.emit('buffers:distance:changed', { key: e.target.dataset.buf, value: val });
    });
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
