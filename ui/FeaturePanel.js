/**
 * FeaturePanel — right panel: feature list + section parameters
 */

import { eventBus } from '../core/EventBus.js';

var PARAM_DEFS = [
  { key: 'sectionWidth', label: 'Section width', unit: 'м', step: 0.5, min: 10, max: 30 },
  { key: 'corridorWidth', label: 'Corridor width', unit: 'м', step: 0.5, min: 1, max: 5 },
  { key: 'cellWidth', label: 'Cell width', unit: 'м', step: 0.1, min: 2, max: 5 },
  { key: 'sectionHeight', label: 'Section height', unit: 'м', step: 1, min: 5, max: 75 },
  { key: 'firstFloorHeight', label: '1st floor height', unit: 'м', step: 0.1, min: 3, max: 6 },
  { key: 'typicalFloorHeight', label: 'Typical floor height', unit: 'м', step: 0.1, min: 2.5, max: 4 }
];

var DEFAULT_PARAMS = {
  sectionWidth: 18.0,
  corridorWidth: 2.0,
  cellWidth: 3.3,
  sectionHeight: 15,
  firstFloorHeight: 4.5,
  typicalFloorHeight: 3.0
};

export class FeaturePanel {
  constructor(containerId, featureStore) {
    this._container = document.getElementById(containerId);
    if (!this._container) throw new Error('FeaturePanel container #' + containerId + ' not found');
    this._featureStore = featureStore;
    this._selectedId = null;
    this._params = {};
    for (var k in DEFAULT_PARAMS) {
      if (DEFAULT_PARAMS.hasOwnProperty(k)) this._params[k] = DEFAULT_PARAMS[k];
    }
  }

  init() {
    this._render();
    this._setupEventListeners();
  }

  _render() {
    this._container.innerHTML =
      '<div class="panel-header">' +
        '<span class="panel-title">Features</span>' +
        '<span class="panel-badge" id="feature-count">0</span>' +
      '</div>' +
      '<div class="panel-body">' +
        '<div id="feature-list"></div>' +
        '<div id="param-section" class="param-section"></div>' +
      '</div>';
    this._renderParams();
  }

  _renderParams() {
    var paramEl = document.getElementById('param-section');
    if (!paramEl) return;

    var html = '<div class="param-header">Section Parameters</div>';
    for (var i = 0; i < PARAM_DEFS.length; i++) {
      var def = PARAM_DEFS[i];
      var val = this._params[def.key];
      html +=
        '<div class="param-row">' +
          '<label class="param-label" for="param-' + def.key + '">' + def.label + '</label>' +
          '<div class="param-input-wrap">' +
            '<input type="number" class="param-input" id="param-' + def.key + '"' +
            ' data-key="' + def.key + '"' +
            ' value="' + val + '"' +
            ' step="' + def.step + '"' +
            ' min="' + def.min + '"' +
            ' max="' + def.max + '">' +
            '<span class="param-unit">' + def.unit + '</span>' +
          '</div>' +
        '</div>';
    }
    paramEl.innerHTML = html;

    // Bind change events
    var self = this;
    for (var i = 0; i < PARAM_DEFS.length; i++) {
      var def = PARAM_DEFS[i];
      var input = document.getElementById('param-' + def.key);
      if (input) {
        input.addEventListener('change', function (e) {
          var key = e.target.dataset.key;
          var val = parseFloat(e.target.value);
          if (!isNaN(val)) {
            self._params[key] = val;
            eventBus.emit('section-gen:params:changed', self._params);
          }
        });
      }
    }
  }

  _setupEventListeners() {
    var self = this;

    eventBus.on('features:changed', function () {
      self._updateList();
    });

    eventBus.on('feature:selected', function (data) {
      self._selectedId = data.id;
      self._updateList();
    });

    eventBus.on('feature:deselected', function () {
      self._selectedId = null;
      self._updateList();
    });

    this._container.addEventListener('click', function (e) {
      var item = e.target.closest('.feature-item');
      if (!item) return;
      var id = item.dataset.id;
      if (id) eventBus.emit('sidebar:feature:click', { id: id });
    });
  }

  _updateList() {
    var countEl = document.getElementById('feature-count');
    var listEl = document.getElementById('feature-list');
    if (!countEl || !listEl) return;

    var features = this._featureStore.toArray();
    countEl.textContent = String(features.length);

    if (features.length === 0) {
      listEl.innerHTML = '<div class="panel-empty">Draw a line (L) to begin</div>';
      return;
    }

    var html = '';
    for (var i = 0; i < features.length; i++) {
      var f = features[i];
      var id = f.properties.id;
      var type = f.properties.type || 'feature';
      var icon = type === 'polygon' ? '⬡' : '╱';
      var selected = id === this._selectedId ? ' selected' : '';
      html += '<div class="feature-item' + selected + '" data-id="' + id + '">' +
        '<span class="feature-icon">' + icon + '</span>' +
        '<span class="feature-name">' + type + ' ' + id.slice(0, 6) + '</span>' +
      '</div>';
    }
    listEl.innerHTML = html;
  }
}
