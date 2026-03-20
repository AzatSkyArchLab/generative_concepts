/**
 * CompassControl — north-up button on the map
 *
 * Click: smoothly reset bearing=0, pitch=0 (plan view, north up)
 * Rotates the arrow icon to match current map bearing.
 */

import { eventBus } from '../core/EventBus.js';

var ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">' +
  '<path d="M12 2l3 10H9l3-10z" fill="currentColor" stroke="none"/>' +
  '<path d="M12 22l-3-10h6l-3 10z" fill="none" stroke="currentColor" stroke-width="1.5"/>' +
  '</svg>';

export class CompassControl {
  constructor() {
    this._btn = null;
    this._mapManager = null;
  }

  /**
   * @param {import('../map/MapManager.js').MapManager} mapManager
   */
  init(mapManager) {
    this._mapManager = mapManager;

    var container = document.getElementById('map-container');
    if (!container) return;

    this._btn = document.createElement('button');
    this._btn.className = 'compass-btn';
    this._btn.title = 'North up (plan view)';
    this._btn.innerHTML = ICON;

    var wrapper = document.createElement('div');
    wrapper.className = 'compass-control';
    wrapper.appendChild(this._btn);
    container.appendChild(wrapper);

    var self = this;

    this._btn.addEventListener('click', function () {
      var map = self._mapManager.getMap();
      if (map) {
        map.easeTo({ bearing: 0, pitch: 0, duration: 600 });
      }
    });

    // Rotate icon to match bearing
    var map = this._mapManager.getMap();
    if (map) {
      map.on('rotate', function () {
        self._updateRotation();
      });
      map.on('pitch', function () {
        self._updateRotation();
      });
    }

    this._updateRotation();
  }

  _updateRotation() {
    if (!this._btn || !this._mapManager) return;
    var bearing = this._mapManager.getBearing();
    var svg = this._btn.querySelector('svg');
    if (svg) {
      svg.style.transform = 'rotate(' + (-bearing) + 'deg)';
    }
  }
}