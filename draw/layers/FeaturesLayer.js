/**
 * FeaturesLayer — manages MapLibre layers for drawn features
 *
 * Creates fill, line, hitbox, selection, and vertex layers.
 * Supports 3D fill-extrusion for polygons.
 */

import { eventBus } from '../../core/EventBus.js';
import { Config } from '../../core/Config.js';
import { createProjection } from '../../core/geo/projection.js';
import { offsetPolyline } from '../../modules/urban-block/geometry.js';

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
    // Ghost contour source (original polygon before simplification)
    this._mapManager.addGeoJSONSource('block-ghost', {
      type: 'FeatureCollection',
      features: []
    });
    // External road connections source
    this._mapManager.addGeoJSONSource('block-ext-conns', {
      type: 'FeatureCollection',
      features: []
    });
    // Road surface and lane markings
    this._mapManager.addGeoJSONSource('roads-surface', {
      type: 'FeatureCollection',
      features: []
    });
    this._mapManager.addGeoJSONSource('roads-markings', {
      type: 'FeatureCollection',
      features: []
    });
  }

  _createLayers() {
    var map = this._mapManager.getMap();
    if (!map) return;

    // Road surface layer (dark gray fill)
    map.addLayer({
      id: 'roads-surface-fill',
      type: 'fill',
      source: 'roads-surface',
      paint: {
        'fill-color': '#3a3a3f',
        'fill-opacity': 0.85
      }
    });

    // Road surface outline
    map.addLayer({
      id: 'roads-surface-outline',
      type: 'line',
      source: 'roads-surface',
      paint: {
        'line-color': '#555560',
        'line-width': 1,
        'line-opacity': 0.6
      }
    });

    // Road lane markings — solid center (4+ lane)
    map.addLayer({
      id: 'roads-markings-solid',
      type: 'line',
      source: 'roads-markings',
      filter: ['==', ['get', 'dash'], false],
      paint: {
        'line-color': '#e8e840',
        'line-width': 1.5,
        'line-opacity': 0.9
      }
    });

    // Road lane markings — dashed (center line 2-lane + lane dividers)
    map.addLayer({
      id: 'roads-markings-dashed',
      type: 'line',
      source: 'roads-markings',
      filter: ['==', ['get', 'dash'], true],
      paint: {
        'line-color': '#ffffff',
        'line-width': 1,
        'line-opacity': 0.8,
        'line-dasharray': [3, 3]
      }
    });

    // Ghost contour layer (dashed, below everything else)
    map.addLayer({
      id: 'block-ghost-line',
      type: 'line',
      source: 'block-ghost',
      paint: {
        'line-color': '#ef4444',
        'line-width': 2,
        'line-opacity': 0.5,
        'line-dasharray': [6, 4]
      }
    });

    // External road connections — active entries (solid, 6m-wide feel)
    map.addLayer({
      id: 'ext-conns-active',
      type: 'line',
      source: 'block-ext-conns',
      filter: ['==', ['get', 'active'], true],
      paint: {
        'line-color': '#6366f1',
        'line-width': 8,
        'line-opacity': 0.7
      }
    });

    // External road connections — inactive (dashed, faint)
    map.addLayer({
      id: 'ext-conns-inactive',
      type: 'line',
      source: 'block-ext-conns',
      filter: ['==', ['get', 'active'], false],
      paint: {
        'line-color': '#6366f1',
        'line-width': 4,
        'line-opacity': 0.2,
        'line-dasharray': [4, 4]
      }
    });

    // Fill (2D fallback for polygons)
    map.addLayer({
      id: this.FILL_LAYER,
      type: 'fill',
      source: this.SOURCE_ID,
      paint: {
        'fill-color': Config.draw.fillColor,
        'fill-opacity': ['case', ['==', ['get', 'urbanBlock'], true], 0.01, Config.draw.fillOpacity]
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
    var self = this;
    eventBus.on('block:ghost:update', function (data) {
      var features = [];
      if (data && data.coords && data.coords.length >= 3) {
        features.push({
          type: 'Feature',
          properties: { ghost: true },
          geometry: { type: 'Polygon', coordinates: [data.coords] }
        });
      }
      self._mapManager.updateGeoJSONSource('block-ghost', {
        type: 'FeatureCollection',
        features: features
      });
    });
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

    // Update ext-conns from block features
    var extFeatures = [];
    for (var ei = 0; ei < all.features.length; ei++) {
      var ef = all.features[ei];
      if (!ef.properties.urbanBlock || !ef.properties._extConns) continue;
      var conns = ef.properties._extConns;
      for (var ci = 0; ci < conns.length; ci++) {
        var ec = conns[ci];
        extFeatures.push({
          type: 'Feature',
          properties: { active: ec.active, dist: ec.dist },
          geometry: { type: 'LineString', coordinates: [ec.from, ec.proj] }
        });
      }
    }
    this._mapManager.updateGeoJSONSource('block-ext-conns', {
      type: 'FeatureCollection',
      features: extFeatures
    });

    // Generate road surface polygons and lane markings
    var surfaceFeatures = [];
    var markingFeatures = [];
    for (var ri = 0; ri < all.features.length; ri++) {
      var rf = all.features[ri];
      if (rf.properties.type !== 'road') continue;
      var coords = rf.geometry.coordinates;
      if (!coords || coords.length < 2) continue;
      var rt = rf.properties.roadType || 0;
      var hw = (rt === 0 ? 3 : rt === 1 ? 7 : 10.5); // half-width in meters
      var proj = createProjection(coords[0][0], coords[0][1]);
      // Project to meters
      var coordsM = [];
      for (var cj = 0; cj < coords.length; cj++) {
        coordsM.push(proj.toMeters(coords[cj][0], coords[cj][1]));
      }
      // Generate road polygon: left offset + reversed right offset
      var left = offsetPolyline(coordsM, hw);
      var right = offsetPolyline(coordsM, -hw);
      if (left.length >= 2 && right.length >= 2) {
        var polyCoords = [];
        for (var li = 0; li < left.length; li++) {
          var ll = proj.toLngLat(left[li][0], left[li][1]);
          polyCoords.push(ll);
        }
        for (var rj = right.length - 1; rj >= 0; rj--) {
          var rl = proj.toLngLat(right[rj][0], right[rj][1]);
          polyCoords.push(rl);
        }
        polyCoords.push(polyCoords[0]); // close ring
        surfaceFeatures.push({
          type: 'Feature',
          properties: { roadType: rt },
          geometry: { type: 'Polygon', coordinates: [polyCoords] }
        });
      }
      // Generate lane markings
      var markingOffsets = [];
      if (rt === 0) {
        // 2 lanes: dashed white center line
        markingOffsets.push({ offset: 0, dash: true });
      } else if (rt === 1) {
        // 4 lanes: solid yellow center + dashed lane dividers at ±3.5m
        markingOffsets.push({ offset: 0, dash: false });
        markingOffsets.push({ offset: 3.5, dash: true });
        markingOffsets.push({ offset: -3.5, dash: true });
      } else {
        // 6 lanes: solid yellow center + dashed lane dividers at ±3.5m, ±7m
        markingOffsets.push({ offset: 0, dash: false });
        markingOffsets.push({ offset: 3.5, dash: true });
        markingOffsets.push({ offset: -3.5, dash: true });
        markingOffsets.push({ offset: 7, dash: true });
        markingOffsets.push({ offset: -7, dash: true });
      }
      for (var mi = 0; mi < markingOffsets.length; mi++) {
        var mo = markingOffsets[mi];
        var mLine = mo.offset === 0 ? coordsM : offsetPolyline(coordsM, mo.offset);
        if (mLine.length < 2) continue;
        var mCoords = [];
        for (var mk = 0; mk < mLine.length; mk++) {
          mCoords.push(proj.toLngLat(mLine[mk][0], mLine[mk][1]));
        }
        markingFeatures.push({
          type: 'Feature',
          properties: { dash: mo.dash, roadType: rt },
          geometry: { type: 'LineString', coordinates: mCoords }
        });
      }
    }
    this._mapManager.updateGeoJSONSource('roads-surface', {
      type: 'FeatureCollection',
      features: surfaceFeatures
    });
    this._mapManager.updateGeoJSONSource('roads-markings', {
      type: 'FeatureCollection',
      features: markingFeatures
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
