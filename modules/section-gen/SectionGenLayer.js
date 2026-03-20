/**
 * SectionGenLayer — 2D overlays only (MapLibre)
 *
 * Three.js handles all 3D rendering.
 * This layer: section outlines, plan view cells, labels, highlight, clickable.
 */

var TYPE_COLORS_F1 = {
  apartment: '#dce8f0',
  commercial: '#ffb74d',
  corridor: '#c8c8c8',
  llu: '#4f81bd'
};

export class SectionGenLayer {
  constructor(mapManager) {
    this._map = mapManager;
    this._initialized = false;

    this.PLAN_SOURCE = 'sg-plan';
    this.OUTLINE_SOURCE = 'sg-outlines';
    this.LABELS_SOURCE = 'sg-labels';
    this.HIGHLIGHT_SOURCE = 'sg-highlight';
    this.CLICK_SOURCE = 'sg-click';

    this.OUTLINE_LINE = 'sg-outline-line';
    this.PLAN_FILL = 'sg-plan-fill';
    this.PLAN_LINE = 'sg-plan-line';
    this.HIGHLIGHT_FILL = 'sg-highlight-fill';
    this.HIGHLIGHT_LINE = 'sg-highlight-line';
    this.CLICK_LAYER = 'sg-click-layer';
    this.LABELS_LAYER = 'sg-labels-text';
  }

  init() {
    if (this._initialized) return;
    var emptyFC = { type: 'FeatureCollection', features: [] };
    this._map.addGeoJSONSource(this.PLAN_SOURCE, emptyFC);
    this._map.addGeoJSONSource(this.OUTLINE_SOURCE, emptyFC);
    this._map.addGeoJSONSource(this.LABELS_SOURCE, emptyFC);
    this._map.addGeoJSONSource(this.HIGHLIGHT_SOURCE, emptyFC);
    this._map.addGeoJSONSource(this.CLICK_SOURCE, emptyFC);

    var map = this._map.getMap();
    if (!map) return;

    // Highlight
    map.addLayer({
      id: this.HIGHLIGHT_FILL, type: 'fill', source: this.HIGHLIGHT_SOURCE,
      paint: { 'fill-color': '#f59e0b', 'fill-opacity': 0.3 }
    });
    map.addLayer({
      id: this.HIGHLIGHT_LINE, type: 'line', source: this.HIGHLIGHT_SOURCE,
      paint: { 'line-color': '#f59e0b', 'line-width': 4 }
    });

    // Section outlines — thick dark-gray
    map.addLayer({
      id: this.OUTLINE_LINE, type: 'line', source: this.OUTLINE_SOURCE,
      paint: { 'line-color': '#333333', 'line-width': 3 }
    });

    // Plan view: floor 1 cell fills
    map.addLayer({
      id: this.PLAN_FILL, type: 'fill', source: this.PLAN_SOURCE,
      paint: { 'fill-color': ['get', 'color'], 'fill-opacity': 1.0 }
    });

    // Plan view: cell outlines
    map.addLayer({
      id: this.PLAN_LINE, type: 'line', source: this.PLAN_SOURCE,
      paint: { 'line-color': '#555555', 'line-width': 1 }
    });

    // Clickable footprints
    map.addLayer({
      id: this.CLICK_LAYER, type: 'fill', source: this.CLICK_SOURCE,
      paint: { 'fill-color': 'transparent', 'fill-opacity': 0 }
    });

    // Labels
    map.addLayer({
      id: this.LABELS_LAYER, type: 'symbol', source: this.LABELS_SOURCE,
      layout: {
        'text-field': ['get', 'label'], 'text-size': 9,
        'text-font': ['Open Sans Regular'], 'text-allow-overlap': true
      },
      paint: { 'text-color': '#333333', 'text-halo-color': '#ffffff', 'text-halo-width': 1 }
    });

    this._initialized = true;
  }

  getClickLayerId() { return this.CLICK_LAYER; }

  update(graphData, sectionFootprints, proj) {
    var planFeatures = [];
    var labelFeatures = [];

    for (var key in graphData.nodes) {
      if (!graphData.nodes.hasOwnProperty(key)) continue;
      var node = graphData.nodes[key];
      if (node.floor !== 1) continue;

      var poly = node.polygon;
      if (!poly || poly.length < 3) continue;

      var ring = this._polyToRing(poly, proj);
      var color = TYPE_COLORS_F1[node.type] || '#cccccc';

      planFeatures.push({
        type: 'Feature',
        properties: { color: color },
        geometry: { type: 'Polygon', coordinates: [ring] }
      });

      var cx = 0; var cy = 0;
      for (var i = 0; i < poly.length; i++) { cx += poly[i][0]; cy += poly[i][1]; }
      cx /= poly.length; cy /= poly.length;
      var cLL = proj.toLngLat(cx, cy);
      var labelText = node.type === 'llu' ? 'LLU ' + (node.lluTag || '') : String(node.cellId);
      labelFeatures.push({
        type: 'Feature',
        properties: { label: labelText },
        geometry: { type: 'Point', coordinates: cLL }
      });
    }

    var outlineFeatures = [];
    var clickFeatures = [];
    for (var i = 0; i < sectionFootprints.length; i++) {
      var fp = sectionFootprints[i];
      var ring = this._polyToRing(fp.polygon, proj);
      outlineFeatures.push({
        type: 'Feature', properties: {},
        geometry: { type: 'Polygon', coordinates: [ring] }
      });
      clickFeatures.push({
        type: 'Feature',
        properties: { lineId: fp.lineId || '' },
        geometry: { type: 'Polygon', coordinates: [ring] }
      });
    }

    this._map.updateGeoJSONSource(this.PLAN_SOURCE, { type: 'FeatureCollection', features: planFeatures });
    this._map.updateGeoJSONSource(this.OUTLINE_SOURCE, { type: 'FeatureCollection', features: outlineFeatures });
    this._map.updateGeoJSONSource(this.CLICK_SOURCE, { type: 'FeatureCollection', features: clickFeatures });
    this._map.updateGeoJSONSource(this.LABELS_SOURCE, { type: 'FeatureCollection', features: labelFeatures });
  }

  highlight(footprintPolygons, proj) {
    if (!footprintPolygons || footprintPolygons.length === 0) { this.clearHighlight(); return; }
    var features = [];
    for (var i = 0; i < footprintPolygons.length; i++) {
      var ring = this._polyToRing(footprintPolygons[i].polygon, proj);
      features.push({ type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: [ring] } });
    }
    this._map.updateGeoJSONSource(this.HIGHLIGHT_SOURCE, { type: 'FeatureCollection', features: features });
  }

  clearHighlight() {
    this._map.updateGeoJSONSource(this.HIGHLIGHT_SOURCE, { type: 'FeatureCollection', features: [] });
  }

  _polyToRing(poly, proj) {
    var ring = [];
    for (var i = 0; i < poly.length; i++) ring.push(proj.toLngLat(poly[i][0], poly[i][1]));
    ring.push(ring[0]);
    return ring;
  }

  clear() {
    var e = { type: 'FeatureCollection', features: [] };
    this._map.updateGeoJSONSource(this.PLAN_SOURCE, e);
    this._map.updateGeoJSONSource(this.OUTLINE_SOURCE, e);
    this._map.updateGeoJSONSource(this.CLICK_SOURCE, e);
    this._map.updateGeoJSONSource(this.LABELS_SOURCE, e);
    this._map.updateGeoJSONSource(this.HIGHLIGHT_SOURCE, e);
  }

  destroy() {
    var map = this._map.getMap();
    if (!map) return;
    var layers = [this.LABELS_LAYER, this.CLICK_LAYER, this.PLAN_LINE, this.PLAN_FILL,
    this.OUTLINE_LINE, this.HIGHLIGHT_LINE, this.HIGHLIGHT_FILL];
    for (var i = 0; i < layers.length; i++) { if (map.getLayer(layers[i])) map.removeLayer(layers[i]); }
    var sources = [this.LABELS_SOURCE, this.CLICK_SOURCE, this.PLAN_SOURCE,
    this.OUTLINE_SOURCE, this.HIGHLIGHT_SOURCE];
    for (var i = 0; i < sources.length; i++) { if (map.getSource(sources[i])) map.removeSource(sources[i]); }
    this._initialized = false;
  }
}
