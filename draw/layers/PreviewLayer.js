/**
 * PreviewLayer — shows preview geometry while user is drawing
 */

import { Config } from '../../core/Config.js';

export class PreviewLayer {
  /**
   * @param {import('../../map/MapManager.js').MapManager} mapManager
   */
  constructor(mapManager) {
    this._mapManager = mapManager;
    this.SOURCE_ID = 'preview';
    this.FILL_LAYER = 'preview-fill';
    this.LINE_LAYER = 'preview-line';
    this.VERTEX_LAYER = 'preview-vertices';
  }

  init() {
    var map = this._mapManager.getMap();
    if (!map) return;

    // Source
    this._mapManager.addGeoJSONSource(this.SOURCE_ID, {
      type: 'FeatureCollection',
      features: []
    });

    // Vertex source (separate because we need points)
    map.addSource('preview-vertex-source', {
      type: 'geojson',
      data: { type: 'FeatureCollection', features: [] }
    });

    // Fill
    map.addLayer({
      id: this.FILL_LAYER,
      type: 'fill',
      source: this.SOURCE_ID,
      filter: ['==', ['geometry-type'], 'Polygon'],
      paint: {
        'fill-color': Config.draw.fillColor,
        'fill-opacity': Config.draw.previewOpacity
      }
    });

    // Line
    map.addLayer({
      id: this.LINE_LAYER,
      type: 'line',
      source: this.SOURCE_ID,
      paint: {
        'line-color': Config.draw.lineColor,
        'line-width': Config.draw.lineWidth,
        'line-dasharray': [3, 3]
      }
    });

    // Vertices
    map.addLayer({
      id: this.VERTEX_LAYER,
      type: 'circle',
      source: 'preview-vertex-source',
      paint: {
        'circle-radius': Config.draw.vertexRadius,
        'circle-color': Config.draw.vertexColor,
        'circle-stroke-color': Config.draw.vertexStrokeColor,
        'circle-stroke-width': Config.draw.vertexStrokeWidth
      }
    });
  }

  /**
   * Update preview with a GeoJSON Feature
   * @param {Object|null} feature
   */
  update(feature) {
    var map = this._mapManager.getMap();
    if (!map) return;

    if (!feature) {
      this.clear();
      return;
    }

    // Update main preview
    this._mapManager.updateGeoJSONSource(this.SOURCE_ID, {
      type: 'FeatureCollection',
      features: [feature]
    });

    // Extract vertex points from coordinates
    var coords = [];
    var geom = feature.geometry;
    if (geom.type === 'Polygon') {
      coords = geom.coordinates[0].slice(0, -1); // skip closing point
    } else if (geom.type === 'LineString') {
      coords = geom.coordinates;
    }

    var vertexFeatures = [];
    for (var i = 0; i < coords.length; i++) {
      vertexFeatures.push({
        type: 'Feature',
        properties: { index: i },
        geometry: { type: 'Point', coordinates: coords[i] }
      });
    }

    var vsrc = map.getSource('preview-vertex-source');
    if (vsrc) {
      vsrc.setData({
        type: 'FeatureCollection',
        features: vertexFeatures
      });
    }
  }

  clear() {
    var map = this._mapManager.getMap();
    if (!map) return;

    this._mapManager.updateGeoJSONSource(this.SOURCE_ID, {
      type: 'FeatureCollection',
      features: []
    });

    var vsrc = map.getSource('preview-vertex-source');
    if (vsrc) {
      vsrc.setData({ type: 'FeatureCollection', features: [] });
    }
  }
}
