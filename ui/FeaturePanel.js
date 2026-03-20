/**
 * FeaturePanel — feature list + context-sensitive properties
 * section-axis: areas + editable params
 * line: length + color picker
 * Ctrl+click for multi-select
 */

import { eventBus } from '../core/EventBus.js';

var DEFAULT_PARAMS = {
  sectionWidth: 18.0, corridorWidth: 2.0, cellWidth: 3.3,
  sectionHeight: 15, firstFloorHeight: 4.5, typicalFloorHeight: 3.0
};

var PARAM_DEFS = [
  { key: 'sectionWidth', label: 'Section width', unit: 'м', step: 0.5, min: 10, max: 30 },
  { key: 'corridorWidth', label: 'Corridor width', unit: 'м', step: 0.5, min: 1, max: 5 },
  { key: 'cellWidth', label: 'Cell width', unit: 'м', step: 0.1, min: 2, max: 5 },
  { key: 'sectionHeight', label: 'Section height', unit: 'м', step: 1, min: 5, max: 75 },
  { key: 'firstFloorHeight', label: '1st floor H', unit: 'м', step: 0.1, min: 3, max: 6 },
  { key: 'typicalFloorHeight', label: 'Typical floor H', unit: 'м', step: 0.1, min: 2.5, max: 4 }
];

export class FeaturePanel {
  constructor(containerId, featureStore) {
    this._container = document.getElementById(containerId);
    if (!this._container) throw new Error('FeaturePanel #' + containerId + ' not found');
    this._featureStore = featureStore;
    this._selectedIds = [];
  }

  init() {
    this._render();
    this._setupEvents();
  }

  _render() {
    this._container.innerHTML =
      '<div class="panel-header"><span class="panel-title">Features</span>' +
      '<span class="panel-badge" id="feature-count">0</span></div>' +
      '<div class="panel-body"><div id="feature-list"></div><div id="section-props"></div></div>';
  }

  _setupEvents() {
    var self = this;
    eventBus.on('features:changed', function () { self._updateList(); self._updateProps(); });
    eventBus.on('feature:selected', function (d) { self._selectedIds = [d.id]; self._updateList(); self._updateProps(); });
    eventBus.on('feature:multiselect', function (d) {
      var idx = self._selectedIds.indexOf(d.id);
      if (idx >= 0) self._selectedIds.splice(idx, 1);
      else self._selectedIds.push(d.id);
      self._updateList(); self._updateProps();
    });
    eventBus.on('feature:deselected', function () { self._selectedIds = []; self._updateList(); self._updateProps(); });

    this._container.addEventListener('click', function (e) {
      var item = e.target.closest('.feature-item');
      if (!item) return;
      var id = item.dataset.id;
      if (!id) return;
      if (e.ctrlKey || e.metaKey) eventBus.emit('feature:multiselect', { id: id });
      else eventBus.emit('sidebar:feature:click', { id: id });
    });
  }

  _updateList() {
    var countEl = document.getElementById('feature-count');
    var listEl = document.getElementById('feature-list');
    if (!countEl || !listEl) return;
    var features = this._featureStore.toArray();
    countEl.textContent = String(features.length);
    if (features.length === 0) { listEl.innerHTML = '<div class="panel-empty">Press S to draw sections</div>'; return; }

    var html = '';
    for (var i = 0; i < features.length; i++) {
      var f = features[i];
      var id = f.properties.id;
      var ftype = f.properties.type || 'feature';
      var icon = ftype === 'section-axis' ? '▦' : '╱';
      var label = ftype === 'section-axis' ? 'section' : 'line';
      var sel = this._selectedIds.indexOf(id) >= 0 ? ' selected' : '';
      html += '<div class="feature-item' + sel + '" data-id="' + id + '">' +
        '<span class="feature-icon">' + icon + '</span>' +
        '<span class="feature-name">' + label + ' ' + id.slice(0, 6) + '</span></div>';
    }
    listEl.innerHTML = html;
  }

  _updateProps() {
    var propsEl = document.getElementById('section-props');
    if (!propsEl) return;
    if (this._selectedIds.length === 0) { propsEl.innerHTML = ''; return; }

    // Separate by type
    var sectionFeatures = [];
    var lineFeatures = [];
    for (var i = 0; i < this._selectedIds.length; i++) {
      var f = this._featureStore.get(this._selectedIds[i]);
      if (!f) continue;
      if (f.properties.type === 'section-axis') sectionFeatures.push(f);
      else if (f.geometry.type === 'LineString') lineFeatures.push(f);
    }

    var html = '';
    if (sectionFeatures.length > 0) html += this._renderSectionProps(sectionFeatures);
    if (lineFeatures.length > 0) html += this._renderLineProps(lineFeatures);
    propsEl.innerHTML = html;
    this._bindInputs();
  }

  _renderSectionProps(features) {
    var params = {};
    var fp = features[0].properties;
    for (var k in DEFAULT_PARAMS) {
      if (DEFAULT_PARAMS.hasOwnProperty(k))
        params[k] = fp[k] !== undefined ? fp[k] : DEFAULT_PARAMS[k];
    }

    var totalLen = 0;
    for (var i = 0; i < features.length; i++) {
      totalLen += features[i].properties.axisLength || 0;
    }
    var footArea = totalLen * params.sectionWidth;
    var aptArea = footArea * 0.65;

    var label = features.length === 1
      ? 'Section ' + features[0].properties.id.slice(0, 6)
      : features.length + ' sections';

    var h = '<div class="props-section"><div class="props-header">' + label + '</div>';
    h += '<div class="props-computed">';
    h += '<div class="props-row"><span class="props-label">Axis length</span><span class="props-value">' + totalLen.toFixed(1) + ' м</span></div>';
    h += '<div class="props-row"><span class="props-label">Footprint</span><span class="props-value">' + footArea.toFixed(0) + ' м²</span></div>';
    h += '<div class="props-row"><span class="props-label">Apartment area</span><span class="props-value">' + aptArea.toFixed(0) + ' м² <small>(×0.65)</small></span></div>';
    h += '</div><div class="props-divider"></div><div class="props-header-small">Parameters</div>';

    for (var pi = 0; pi < PARAM_DEFS.length; pi++) {
      var d = PARAM_DEFS[pi];
      h += '<div class="param-row"><label class="param-label">' + d.label + '</label>' +
        '<div class="param-input-wrap"><input type="number" class="param-input" data-key="' + d.key + '" data-target="section"' +
        ' value="' + params[d.key] + '" step="' + d.step + '" min="' + d.min + '" max="' + d.max + '">' +
        '<span class="param-unit">' + d.unit + '</span></div></div>';
    }
    h += '</div>';
    return h;
  }

  _renderLineProps(features) {
    var totalLen = 0;
    for (var i = 0; i < features.length; i++) {
      var coords = features[i].geometry.coordinates;
      for (var j = 0; j < coords.length - 1; j++) {
        var dlng = (coords[j + 1][0] - coords[j][0]) * 111320 * Math.cos(coords[j][1] * Math.PI / 180);
        var dlat = (coords[j + 1][1] - coords[j][1]) * 110540;
        totalLen += Math.sqrt(dlng * dlng + dlat * dlat);
      }
    }

    var color = features[0].properties.color || '#3388ff';
    var label = features.length === 1 ? 'Line ' + features[0].properties.id.slice(0, 6) : features.length + ' lines';

    var h = '<div class="props-section"><div class="props-header">' + label + '</div>';
    h += '<div class="props-computed">';
    h += '<div class="props-row"><span class="props-label">Length</span><span class="props-value">' + totalLen.toFixed(1) + ' м</span></div>';
    h += '</div>';
    h += '<div class="param-row"><label class="param-label">Color</label>' +
      '<div class="param-input-wrap"><input type="color" class="param-color" data-key="color" data-target="line" value="' + color + '"></div></div>';
    h += '</div>';
    return h;
  }

  _bindInputs() {
    var self = this;

    // Number inputs (section params)
    var inputs = this._container.querySelectorAll('.param-input[data-target="section"]');
    for (var i = 0; i < inputs.length; i++) {
      inputs[i].addEventListener('change', function (e) {
        var key = e.target.dataset.key;
        var val = parseFloat(e.target.value);
        if (isNaN(val)) return;
        for (var si = 0; si < self._selectedIds.length; si++) {
          var updates = {};
          updates[key] = val;
          self._featureStore.update(self._selectedIds[si], updates);
        }
        eventBus.emit('section-gen:params:changed');
      });
    }

    // Color inputs (line)
    var colorInputs = this._container.querySelectorAll('.param-color[data-target="line"]');
    for (var i = 0; i < colorInputs.length; i++) {
      colorInputs[i].addEventListener('input', function (e) {
        var val = e.target.value;
        for (var si = 0; si < self._selectedIds.length; si++) {
          self._featureStore.update(self._selectedIds[si], { color: val });
        }
        eventBus.emit('features:changed');
      });
    }
  }
}
