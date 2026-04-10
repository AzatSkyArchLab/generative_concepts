/**
 * FeaturesLayer — manages MapLibre layers for drawn features
 *
 * Creates fill, line, hitbox, selection, and vertex layers.
 * Supports 3D fill-extrusion for polygons.
 */

import { eventBus } from '../../core/EventBus.js';
import { Config } from '../../core/Config.js';

export class FeaturesLayer {
  /**
   * @param {import('../../map/MapManager.js').MapManager} mapManager
   * @param {import('../../data/FeatureStore.js').FeatureStore} featureStore
   */
  constructor(mapManager, featureStore) {
    this._mapManager = mapManager;
    this._featureStore = featureStore;
    this._selectedIds = new Set();

    this.SOURCE_ID = 'features';
    this.FILL_LAYER = 'features-fill';
    this.EXTRUSION_LAYER = 'features-extrusion';
    this.LINE_LAYER = 'features-line';
    this.LINE_HITBOX_LAYER = 'features-line-hitbox';
    this.SELECTED_LAYER = 'features-selected';
    this.VERTEX_LAYER = 'features-vertices';
  }

  init() {
    this._createSource();
    this._createLayers();
    this._setupFilters();
    this._setupEventListeners();
  }

  _createSource() {
    this._mapManager.addGeoJSONSource(this.SOURCE_ID, {
      type: 'FeatureCollection',
      features: []
    });
  }

  _createLayers() {
    var map = this._mapManager.getMap();
    if (!map) return;

    // Fill (2D fallback for polygons)
    map.addLayer({
      id: this.FILL_LAYER,
      type: 'fill',
      source: this.SOURCE_ID,
      paint: {
        'fill-color': Config.draw.fillColor,
        'fill-opacity': ['case', ['==', ['get', 'urbanBlock'], true], 0, Config.draw.fillOpacity]
      }
    });

    // 3D extrusion (polygons with height)
    map.addLayer({
      id: this.EXTRUSION_LAYER,
      type: 'fill-extrusion',
      source: this.SOURCE_ID,
      paint: {
        'fill-extrusion-color': Config.draw.fillColor,
        'fill-extrusion-height': ['coalesce', ['get', 'height'], 0],
        'fill-extrusion-base': 0,
        'fill-extrusion-opacity': 0.7
      }
    });

    // Outline
    map.addLayer({
      id: this.LINE_LAYER,
      type: 'line',
      source: this.SOURCE_ID,
      paint: {
        'line-color': Config.draw.lineColor,
        'line-width': Config.draw.lineWidth
      }
    });

    // Invisible hitbox for line selection
    map.addLayer({
      id: this.LINE_HITBOX_LAYER,
      type: 'line',
      source: this.SOURCE_ID,
      paint: {
        'line-color': 'transparent',
        'line-width': Config.draw.hitboxWidth
      }
    });

    // Selection highlight
    map.addLayer({
      id: this.SELECTED_LAYER,
      type: 'line',
      source: this.SOURCE_ID,
      paint: {
        'line-color': Config.draw.selectedColor,
        'line-width': Config.draw.selectedWidth
      }
    });
  }

  _setupFilters() {
    var map = this._mapManager.getMap();
    if (!map) return;

    map.setFilter(this.FILL_LAYER, ['==', ['geometry-type'], 'Polygon']);
    map.setFilter(this.EXTRUSION_LAYER, [
      'all',
      ['==', ['geometry-type'], 'Polygon'],
      ['>', ['coalesce', ['get', 'height'], 0], 0]
    ]);
    map.setFilter(this.LINE_HITBOX_LAYER, ['==', ['geometry-type'], 'LineString']);
    map.setFilter(this.SELECTED_LAYER, ['==', ['get', 'selected'], true]);
  }

  _setupEventListeners() {
    eventBus.on('features:changed', () => this.update());
  }

  update() {
    var all = this._featureStore.getAll();
    var self = this;
    var features = [];
    for (var i = 0; i < all.features.length; i++) {
      var f = all.features[i];
      var props = Object.assign({}, f.properties, {
        selected: self._selectedIds.has(f.properties.id || '')
      });
      features.push({
        type: 'Feature',
        properties: props,
        geometry: f.geometry
      });
    }
    this._mapManager.updateGeoJSONSource(this.SOURCE_ID, {
      type: 'FeatureCollection',
      features: features
    });
  }

  selectFeature(id) {
    this._selectedIds.clear();
    this._selectedIds.add(id);
    this.update();
    eventBus.emit('feature:selected', { id });
  }

  clearSelection() {
    this._selectedIds.clear();
    this.update();
    eventBus.emit('feature:deselected');
  }

  getSelectedIds() {
    return Array.from(this._selectedIds);
  }

  queryAtPoint(point) {
    return this._mapManager.queryRenderedFeatures([point.x, point.y], {
      layers: [this.FILL_LAYER, this.LINE_LAYER, this.LINE_HITBOX_LAYER]
    });
  }

  getInteractiveLayers() {
    return [this.FILL_LAYER, this.LINE_LAYER, this.LINE_HITBOX_LAYER];
  }
}
