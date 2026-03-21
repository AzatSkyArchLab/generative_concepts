/**
 * SectionPreviewLayer — real-time preview with thin outlines
 */

export class SectionPreviewLayer {
  constructor(mapManager) {
    this._map = mapManager;
    this._initialized = false;
    this.RECTS_SOURCE = 'sp-rects';
    this.OUTLINE_SOURCE = 'sp-outlines';
    this.LABEL_SOURCE = 'sp-label';
    this.LINE_SOURCE = 'sp-axis';
    this.RECTS_FILL = 'sp-rects-fill';
    this.OUTLINE_LINE = 'sp-outline-line';
    this.AXIS_LINE = 'sp-axis-line';
    this.LABEL_LAYER = 'sp-label-text';
  }

  init() {
    if (this._initialized) return;
    var emptyFC = { type: 'FeatureCollection', features: [] };
    this._map.addGeoJSONSource(this.RECTS_SOURCE, emptyFC);
    this._map.addGeoJSONSource(this.OUTLINE_SOURCE, emptyFC);
    this._map.addGeoJSONSource(this.LABEL_SOURCE, emptyFC);
    this._map.addGeoJSONSource(this.LINE_SOURCE, emptyFC);
    var map = this._map.getMap();
    if (!map) return;

    map.addLayer({ id: this.AXIS_LINE, type: 'line', source: this.LINE_SOURCE,
      paint: { 'line-color': ['get', 'color'], 'line-width': 2, 'line-dasharray': [4, 3] } });

    map.addLayer({ id: this.RECTS_FILL, type: 'fill', source: this.RECTS_SOURCE,
      paint: { 'fill-color': ['get', 'color'], 'fill-opacity': 1.0 } });

    // Thin section outlines
    map.addLayer({ id: this.OUTLINE_LINE, type: 'line', source: this.OUTLINE_SOURCE,
      paint: { 'line-color': '#444444', 'line-width': 1.5 } });

    map.addLayer({ id: this.LABEL_LAYER, type: 'symbol', source: this.LABEL_SOURCE,
      layout: { 'text-field': ['get', 'label'], 'text-size': 14, 'text-font': ['Noto Sans Bold'],
        'text-anchor': 'bottom', 'text-offset': [0, -1.5], 'text-allow-overlap': true },
      paint: { 'text-color': '#1a1a1a', 'text-halo-color': '#ffffff', 'text-halo-width': 2 } });

    this._initialized = true;
  }

  update(startLL, endLL, footprints, oriName, totalLength, proj) {
    var fillColor = oriName === 'lon' ? 'rgba(220, 50, 50, 0.25)' : 'rgba(50, 100, 220, 0.25)';
    var lineColor = oriName === 'lon' ? '#dc3232' : '#3264dc';

    this._map.updateGeoJSONSource(this.LINE_SOURCE, { type: 'FeatureCollection',
      features: [{ type: 'Feature', properties: { color: lineColor },
        geometry: { type: 'LineString', coordinates: [startLL, endLL] } }] });

    var rectF = []; var outF = [];
    for (var i = 0; i < footprints.length; i++) {
      var ring = [];
      for (var j = 0; j < footprints[i].polygon.length; j++) {
        ring.push(proj.toLngLat(footprints[i].polygon[j][0], footprints[i].polygon[j][1]));
      }
      ring.push(ring[0]);
      rectF.push({ type: 'Feature', properties: { color: fillColor }, geometry: { type: 'Polygon', coordinates: [ring] } });
      outF.push({ type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: [ring] } });
    }
    this._map.updateGeoJSONSource(this.RECTS_SOURCE, { type: 'FeatureCollection', features: rectF });
    this._map.updateGeoJSONSource(this.OUTLINE_SOURCE, { type: 'FeatureCollection', features: outF });

    var midLL = [(startLL[0] + endLL[0]) / 2, (startLL[1] + endLL[1]) / 2];
    var label = totalLength.toFixed(1) + ' м';
    if (footprints.length > 0) label += '  ·  ' + footprints.length + ' секц.';
    this._map.updateGeoJSONSource(this.LABEL_SOURCE, { type: 'FeatureCollection',
      features: [{ type: 'Feature', properties: { label: label }, geometry: { type: 'Point', coordinates: midLL } }] });
  }

  clear() {
    var e = { type: 'FeatureCollection', features: [] };
    this._map.updateGeoJSONSource(this.RECTS_SOURCE, e);
    this._map.updateGeoJSONSource(this.OUTLINE_SOURCE, e);
    this._map.updateGeoJSONSource(this.LABEL_SOURCE, e);
    this._map.updateGeoJSONSource(this.LINE_SOURCE, e);
  }

  destroy() {
    var map = this._map.getMap();
    if (!map) return;
    var layers = [this.LABEL_LAYER, this.OUTLINE_LINE, this.RECTS_FILL, this.AXIS_LINE];
    for (var i = 0; i < layers.length; i++) { if (map.getLayer(layers[i])) map.removeLayer(layers[i]); }
    var sources = [this.LABEL_SOURCE, this.OUTLINE_SOURCE, this.RECTS_SOURCE, this.LINE_SOURCE];
    for (var i = 0; i < sources.length; i++) { if (map.getSource(sources[i])) map.removeSource(sources[i]); }
    this._initialized = false;
  }
}
