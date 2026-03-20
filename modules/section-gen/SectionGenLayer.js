/**
 * SectionGenLayer — 2D MapLibre layers
 * Bright amber highlight, thick footprint outlines, axis line
 */

var TYPE_COLORS = { apartment: '#dce8f0', commercial: '#ffb74d', corridor: '#c8c8c8', llu: '#4f81bd' };

export class SectionGenLayer {
  constructor(mapManager) {
    this._map = mapManager;
    this._initialized = false;
    this.PLAN_SOURCE = 'sg-plan';
    this.FOOT_SOURCE = 'sg-foot';
    this.AXIS_SOURCE = 'sg-axis';
    this.LABELS_SOURCE = 'sg-labels';
    this.HIGHLIGHT_SOURCE = 'sg-highlight';
    this.CLICK_SOURCE = 'sg-click';

    this.HIGHLIGHT_FILL = 'sg-highlight-fill';
    this.HIGHLIGHT_LINE = 'sg-highlight-line';
    this.AXIS_LINE = 'sg-axis-line';
    this.FOOT_LINE = 'sg-foot-line';
    this.PLAN_FILL = 'sg-plan-fill';
    this.PLAN_LINE = 'sg-plan-line';
    this.CLICK_LAYER = 'sg-click-layer';
    this.LABELS_LAYER = 'sg-labels-text';
  }

  init() {
    if (this._initialized) return;
    var e = { type: 'FeatureCollection', features: [] };
    this._map.addGeoJSONSource(this.PLAN_SOURCE, e);
    this._map.addGeoJSONSource(this.FOOT_SOURCE, e);
    this._map.addGeoJSONSource(this.AXIS_SOURCE, e);
    this._map.addGeoJSONSource(this.LABELS_SOURCE, e);
    this._map.addGeoJSONSource(this.HIGHLIGHT_SOURCE, e);
    this._map.addGeoJSONSource(this.CLICK_SOURCE, e);
    var map = this._map.getMap();
    if (!map) return;

    // Bright amber highlight — very visible
    map.addLayer({
      id: this.HIGHLIGHT_FILL, type: 'fill', source: this.HIGHLIGHT_SOURCE,
      paint: { 'fill-color': '#292929', 'line-width': 7 }
    });
    map.addLayer({
      id: this.HIGHLIGHT_LINE, type: 'line', source: this.HIGHLIGHT_SOURCE,
      paint: { 'line-color': '#f06508', 'line-width': 10 }
    });

    // Axis lines (dashed, visible)
    map.addLayer({
      id: this.AXIS_LINE, type: 'line', source: this.AXIS_SOURCE,
      paint: { 'line-color': '#888888', 'line-width': 2, 'line-dasharray': [6, 4] }
    });

    // Thick dark footprint outlines
    map.addLayer({
      id: this.FOOT_LINE, type: 'line', source: this.FOOT_SOURCE,
      paint: { 'line-color': '#333333', 'line-width': 3 }
    });

    // Cell fills
    map.addLayer({
      id: this.PLAN_FILL, type: 'fill', source: this.PLAN_SOURCE,
      paint: { 'fill-color': ['get', 'color'], 'fill-opacity': 1.0 }
    });
    // Cell outlines
    map.addLayer({
      id: this.PLAN_LINE, type: 'line', source: this.PLAN_SOURCE,
      paint: { 'line-color': '#555555', 'line-width': 1 }
    });

    // Clickable (transparent)
    map.addLayer({
      id: this.CLICK_LAYER, type: 'fill', source: this.CLICK_SOURCE,
      paint: { 'fill-color': 'transparent', 'fill-opacity': 0 }
    });

    // Labels
    map.addLayer({
      id: this.LABELS_LAYER, type: 'symbol', source: this.LABELS_SOURCE,
      layout: {
        'text-field': ['get', 'label'], 'text-size': 9, 'text-font': ['Open Sans Regular'],
        'text-allow-overlap': true
      },
      paint: { 'text-color': '#333', 'text-halo-color': '#fff', 'text-halo-width': 1 }
    });

    this._initialized = true;
  }

  getClickLayerId() { return this.CLICK_LAYER; }

  update(cellsLL, footprintsLL) {
    var planF = []; var labelF = []; var axisF = [];
    for (var i = 0; i < cellsLL.length; i++) {
      var c = cellsLL[i];
      planF.push({
        type: 'Feature', properties: { color: c.color },
        geometry: { type: 'Polygon', coordinates: [c.ring] }
      });
      if (c.label) {
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
    // Collect axis lines from footprint pairs (a→b of each footprint)
    var seenAxes = {};
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

      // Axis line per lineId (first→last footprint)
      if (fp.lineId && !seenAxes[fp.lineId]) seenAxes[fp.lineId] = { start: fp.ring[0], end: null };
      if (fp.lineId) seenAxes[fp.lineId].end = fp.ring[1];
    }

    for (var lid in seenAxes) {
      if (!seenAxes.hasOwnProperty(lid)) continue;
      var ax = seenAxes[lid];
      if (ax.start && ax.end) {
        axisF.push({
          type: 'Feature', properties: {},
          geometry: { type: 'LineString', coordinates: [ax.start, ax.end] }
        });
      }
    }

    this._map.updateGeoJSONSource(this.PLAN_SOURCE, { type: 'FeatureCollection', features: planF });
    this._map.updateGeoJSONSource(this.FOOT_SOURCE, { type: 'FeatureCollection', features: footF });
    this._map.updateGeoJSONSource(this.AXIS_SOURCE, { type: 'FeatureCollection', features: axisF });
    this._map.updateGeoJSONSource(this.CLICK_SOURCE, { type: 'FeatureCollection', features: clickF });
    this._map.updateGeoJSONSource(this.LABELS_SOURCE, { type: 'FeatureCollection', features: labelF });
  }

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
    this._map.updateGeoJSONSource(this.AXIS_SOURCE, e);
    this._map.updateGeoJSONSource(this.CLICK_SOURCE, e);
    this._map.updateGeoJSONSource(this.LABELS_SOURCE, e);
    this._map.updateGeoJSONSource(this.HIGHLIGHT_SOURCE, e);
  }

  destroy() {
    var map = this._map.getMap();
    if (!map) return;
    var layers = [this.LABELS_LAYER, this.CLICK_LAYER, this.PLAN_LINE, this.PLAN_FILL,
    this.FOOT_LINE, this.AXIS_LINE, this.HIGHLIGHT_LINE, this.HIGHLIGHT_FILL];
    for (var i = 0; i < layers.length; i++) { if (map.getLayer(layers[i])) map.removeLayer(layers[i]); }
    var sources = [this.LABELS_SOURCE, this.CLICK_SOURCE, this.PLAN_SOURCE,
    this.FOOT_SOURCE, this.AXIS_SOURCE, this.HIGHLIGHT_SOURCE];
    for (var i = 0; i < sources.length; i++) { if (map.getSource(sources[i])) map.removeSource(sources[i]); }
    this._initialized = false;
  }
}
