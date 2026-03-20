/**
 * SectionGenLayer — 2D MapLibre layers. Receives lng/lat data directly.
 * Thick dark footprint outlines. Thin cell outlines.
 */

var TYPE_COLORS_F1 = {
  apartment: '#dce8f0', commercial: '#ffb74d', corridor: '#c8c8c8', llu: '#4f81bd'
};

export class SectionGenLayer {
  constructor(mapManager) {
    this._map = mapManager;
    this._initialized = false;
    this.PLAN_SOURCE = 'sg-plan';
    this.FOOT_SOURCE = 'sg-foot';
    this.LABELS_SOURCE = 'sg-labels';
    this.HIGHLIGHT_SOURCE = 'sg-highlight';
    this.CLICK_SOURCE = 'sg-click';
    this.FOOT_LINE = 'sg-foot-line';
    this.PLAN_FILL = 'sg-plan-fill';
    this.PLAN_LINE = 'sg-plan-line';
    this.HIGHLIGHT_FILL = 'sg-highlight-fill';
    this.HIGHLIGHT_LINE = 'sg-highlight-line';
    this.CLICK_LAYER = 'sg-click-layer';
    this.LABELS_LAYER = 'sg-labels-text';
  }

  init() {
    if (this._initialized) return;
    var e = { type: 'FeatureCollection', features: [] };
    this._map.addGeoJSONSource(this.PLAN_SOURCE, e);
    this._map.addGeoJSONSource(this.FOOT_SOURCE, e);
    this._map.addGeoJSONSource(this.LABELS_SOURCE, e);
    this._map.addGeoJSONSource(this.HIGHLIGHT_SOURCE, e);
    this._map.addGeoJSONSource(this.CLICK_SOURCE, e);
    var map = this._map.getMap();
    if (!map) return;

    map.addLayer({
      id: this.HIGHLIGHT_FILL, type: 'fill', source: this.HIGHLIGHT_SOURCE,
      paint: { 'fill-color': '#f59e0b', 'fill-opacity': 0.3 }
    });
    map.addLayer({
      id: this.HIGHLIGHT_LINE, type: 'line', source: this.HIGHLIGHT_SOURCE,
      paint: { 'line-color': '#f59e0b', 'line-width': 4 }
    });

    // Thick dark footprint outlines
    map.addLayer({
      id: this.FOOT_LINE, type: 'line', source: this.FOOT_SOURCE,
      paint: { 'line-color': '#333333', 'line-width': 3 }
    });

    map.addLayer({
      id: this.PLAN_FILL, type: 'fill', source: this.PLAN_SOURCE,
      paint: { 'fill-color': ['get', 'color'], 'fill-opacity': 1.0 }
    });
    map.addLayer({
      id: this.PLAN_LINE, type: 'line', source: this.PLAN_SOURCE,
      paint: { 'line-color': '#555555', 'line-width': 1 }
    });

    map.addLayer({
      id: this.CLICK_LAYER, type: 'fill', source: this.CLICK_SOURCE,
      paint: { 'fill-color': 'transparent', 'fill-opacity': 0 }
    });

    map.addLayer({
      id: this.LABELS_LAYER, type: 'symbol', source: this.LABELS_SOURCE,
      layout: { 'text-field': ['get', 'label'], 'text-size': 9, 'text-font': ['Open Sans Regular'], 'text-allow-overlap': true },
      paint: { 'text-color': '#333333', 'text-halo-color': '#ffffff', 'text-halo-width': 1 }
    });

    this._initialized = true;
  }

  getClickLayerId() { return this.CLICK_LAYER; }

  /**
   * @param {Array<Object>} cellsLL - [{ ring: [[lng,lat]...], color, label }]
   * @param {Array<Object>} footprintsLL - [{ ring: [[lng,lat]...], lineId }]
   */
  update(cellsLL, footprintsLL) {
    var planF = []; var labelF = [];
    for (var i = 0; i < cellsLL.length; i++) {
      var c = cellsLL[i];
      planF.push({
        type: 'Feature', properties: { color: c.color },
        geometry: { type: 'Polygon', coordinates: [c.ring] }
      });
      if (c.label) {
        // Centroid of ring
        var cx = 0; var cy = 0;
        for (var j = 0; j < c.ring.length - 1; j++) { cx += c.ring[j][0]; cy += c.ring[j][1]; }
        cx /= (c.ring.length - 1); cy /= (c.ring.length - 1);
        labelF.push({
          type: 'Feature', properties: { label: c.label },
          geometry: { type: 'Point', coordinates: [cx, cy] }
        });
      }
    }

    var footF = []; var clickF = [];
    for (var i = 0; i < footprintsLL.length; i++) {
      var fp = footprintsLL[i];
      footF.push({
        type: 'Feature', properties: {},
        geometry: { type: 'Polygon', coordinates: [fp.ring] }
      });
      clickF.push({
        type: 'Feature', properties: { lineId: fp.lineId || '' },
        geometry: { type: 'Polygon', coordinates: [fp.ring] }
      });
    }

    this._map.updateGeoJSONSource(this.PLAN_SOURCE, { type: 'FeatureCollection', features: planF });
    this._map.updateGeoJSONSource(this.FOOT_SOURCE, { type: 'FeatureCollection', features: footF });
    this._map.updateGeoJSONSource(this.CLICK_SOURCE, { type: 'FeatureCollection', features: clickF });
    this._map.updateGeoJSONSource(this.LABELS_SOURCE, { type: 'FeatureCollection', features: labelF });
  }

  /**
   * @param {Array<Object>} fpsLL - [{ ring: [[lng,lat]...] }]
   */
  highlightRaw(fpsLL) {
    var f = [];
    for (var i = 0; i < fpsLL.length; i++) {
      f.push({
        type: 'Feature', properties: {},
        geometry: { type: 'Polygon', coordinates: [fpsLL[i].ring] }
      });
    }
    this._map.updateGeoJSONSource(this.HIGHLIGHT_SOURCE, { type: 'FeatureCollection', features: f });
  }

  clearHighlight() {
    this._map.updateGeoJSONSource(this.HIGHLIGHT_SOURCE, { type: 'FeatureCollection', features: [] });
  }

  clear() {
    var e = { type: 'FeatureCollection', features: [] };
    this._map.updateGeoJSONSource(this.PLAN_SOURCE, e);
    this._map.updateGeoJSONSource(this.FOOT_SOURCE, e);
    this._map.updateGeoJSONSource(this.CLICK_SOURCE, e);
    this._map.updateGeoJSONSource(this.LABELS_SOURCE, e);
    this._map.updateGeoJSONSource(this.HIGHLIGHT_SOURCE, e);
  }

  destroy() {
    var map = this._map.getMap();
    if (!map) return;
    var layers = [this.LABELS_LAYER, this.CLICK_LAYER, this.PLAN_LINE, this.PLAN_FILL,
    this.FOOT_LINE, this.HIGHLIGHT_LINE, this.HIGHLIGHT_FILL];
    for (var i = 0; i < layers.length; i++) { if (map.getLayer(layers[i])) map.removeLayer(layers[i]); }
    var sources = [this.LABELS_SOURCE, this.CLICK_SOURCE, this.PLAN_SOURCE,
    this.FOOT_SOURCE, this.HIGHLIGHT_SOURCE];
    for (var i = 0; i < sources.length; i++) { if (map.getSource(sources[i])) map.removeSource(sources[i]); }
    this._initialized = false;
  }
}
