/**
 * StatusBar — bottom bar showing coordinates, zoom, active tool, feature count
 */

import { eventBus } from '../core/EventBus.js';

export class StatusBar {
  /**
   * @param {string} containerId
   * @param {import('../data/FeatureStore.js').FeatureStore} featureStore
   */
  constructor(containerId, featureStore) {
    this._container = document.getElementById(containerId);
    if (!this._container) throw new Error('StatusBar container #' + containerId + ' not found');
    this._featureStore = featureStore;
    this._coords = { lng: 0, lat: 0 };
    this._zoom = 0;
    this._tool = 'select';
  }

  init() {
    this._render();
    this._setupEventListeners();
  }

  _render() {
    this._container.innerHTML =
      '<span class="status-item" id="status-coords">0.000, 0.000</span>' +
      '<span class="status-item" id="status-zoom">z15</span>' +
      '<span class="status-item" id="status-tool">Select</span>' +
      '<span class="status-item" id="status-features">0 features</span>';
  }

  _setupEventListeners() {
    var self = this;

    eventBus.on('map:mousemove', function (e) {
      self._coords = e.lngLat;
      var el = document.getElementById('status-coords');
      if (el) el.textContent = e.lngLat.lng.toFixed(5) + ', ' + e.lngLat.lat.toFixed(5);
    });

    eventBus.on('map:moveend', function (data) {
      var el = document.getElementById('status-zoom');
      if (el) el.textContent = 'z' + data.zoom.toFixed(1);
    });

    eventBus.on('tool:activated', function (data) {
      var el = document.getElementById('status-tool');
      if (el) el.textContent = data.id.charAt(0).toUpperCase() + data.id.slice(1);
    });

    eventBus.on('features:changed', function () {
      var el = document.getElementById('status-features');
      if (el) el.textContent = self._featureStore.count() + ' features';
    });

    eventBus.on('draw:point:added', function (data) {
      var el = document.getElementById('status-features');
      if (el) el.textContent = 'Drawing: ' + data.total + ' points';
    });

    eventBus.on('draw:end', function () {
      var el = document.getElementById('status-features');
      if (el) el.textContent = self._featureStore.count() + ' features';
    });
  }
}
