/**
 * FeaturePanel — right panel listing drawn features
 */

import { eventBus } from '../core/EventBus.js';

export class FeaturePanel {
  /**
   * @param {string} containerId
   * @param {import('../data/FeatureStore.js').FeatureStore} featureStore
   */
  constructor(containerId, featureStore) {
    this._container = document.getElementById(containerId);
    if (!this._container) throw new Error('FeaturePanel container #' + containerId + ' not found');
    this._featureStore = featureStore;
    this._selectedId = null;
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
      '<div class="panel-body" id="feature-list"></div>';
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
      if (id) {
        eventBus.emit('sidebar:feature:click', { id: id });
      }
    });
  }

  _updateList() {
    var countEl = document.getElementById('feature-count');
    var listEl = document.getElementById('feature-list');
    if (!countEl || !listEl) return;

    var features = this._featureStore.toArray();
    countEl.textContent = String(features.length);

    if (features.length === 0) {
      listEl.innerHTML = '<div class="panel-empty">Draw a polygon or line to begin</div>';
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
