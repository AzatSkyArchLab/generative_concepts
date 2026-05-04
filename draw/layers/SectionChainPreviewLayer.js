/**
 * SectionChainPreviewLayer — renders a section-chain layout on the map.
 *
 * Used both for live preview (during drawing) and to display finalized
 * chain features. Polygons come from the processor in meters and get
 * unprojected to lng/lat via a per-chain projection.
 *
 * The same class is instantiated twice — once by SectionChainTool for
 * the active draw preview, once by modules/section-chain for stored
 * features. The prefix arg keeps MapLibre source/layer ids unique.
 *
 * Color palette mirrors the rest of the project:
 *   regular sections — meridional `#dc3232`, latitudinal `#3264dc`
 *                      (matches SectionPreviewLayer / Section tool)
 * Corner typology — new:
 *   WW (lat–lat)   → darker blue   `#1d3557`
 *   MM (mer–mer)   → darker red    `#7a1f1f`
 *   WM/MW (mixed)  → yellow-orange `#e89c32`
 */

var COLORS = {
  axis: '#444444',
  secLatFill: 'rgba(50, 100, 220, 0.55)',
  secLatStroke: '#3264dc',
  secLonFill: 'rgba(220, 50, 50, 0.55)',
  secLonStroke: '#dc3232',
  cornerWWFill: 'rgba(29, 53, 87, 0.55)',
  cornerWWStroke: '#1d3557',
  cornerMMFill: 'rgba(122, 31, 31, 0.55)',
  cornerMMStroke: '#7a1f1f',
  cornerMixFill: 'rgba(232, 156, 50, 0.6)',
  cornerMixStroke: '#bb6500',
  gapFill: 'rgba(231, 111, 81, 0.30)',
  gapStroke: '#e76f51'
};

export class SectionChainPreviewLayer {
  /**
   * @param {Object} mapManager
   * @param {string} [prefix='sc'] — disambiguates source/layer ids when
   *   multiple instances coexist (e.g. preview vs. stored).
   */
  constructor(mapManager, prefix) {
    this._map = mapManager;
    this._initialized = false;
    var p = prefix || 'sc';

    this.AXIS_SOURCE = p + '-axis';
    this.SEC_SOURCE = p + '-sections';
    this.COR_SOURCE = p + '-corners';
    this.GAP_SOURCE = p + '-gaps';

    this.AXIS_LAYER = p + '-axis-line';
    this.SEC_FILL = p + '-sec-fill';
    this.SEC_LINE = p + '-sec-line';
    this.COR_FILL = p + '-cor-fill';
    this.COR_LINE = p + '-cor-line';
    this.GAP_FILL = p + '-gap-fill';
    this.GAP_LINE = p + '-gap-line';
  }

  init() {
    if (this._initialized) return;
    var empty = { type: 'FeatureCollection', features: [] };
    this._map.addGeoJSONSource(this.AXIS_SOURCE, empty);
    this._map.addGeoJSONSource(this.SEC_SOURCE, empty);
    this._map.addGeoJSONSource(this.COR_SOURCE, empty);
    this._map.addGeoJSONSource(this.GAP_SOURCE, empty);

    var map = this._map.getMap();
    if (!map) return;

    map.addLayer({
      id: this.GAP_FILL, type: 'fill', source: this.GAP_SOURCE,
      paint: { 'fill-color': COLORS.gapFill }
    });
    map.addLayer({
      id: this.GAP_LINE, type: 'line', source: this.GAP_SOURCE,
      paint: { 'line-color': COLORS.gapStroke, 'line-width': 1, 'line-dasharray': [3, 2] }
    });
    map.addLayer({
      id: this.SEC_FILL, type: 'fill', source: this.SEC_SOURCE,
      paint: { 'fill-color': ['get', 'fill'] }
    });
    map.addLayer({
      id: this.SEC_LINE, type: 'line', source: this.SEC_SOURCE,
      paint: { 'line-color': ['get', 'stroke'], 'line-width': 1.5 }
    });
    map.addLayer({
      id: this.COR_FILL, type: 'fill', source: this.COR_SOURCE,
      paint: { 'fill-color': ['get', 'fill'] }
    });
    map.addLayer({
      id: this.COR_LINE, type: 'line', source: this.COR_SOURCE,
      paint: { 'line-color': ['get', 'stroke'], 'line-width': 1.8 }
    });
    map.addLayer({
      id: this.AXIS_LAYER, type: 'line', source: this.AXIS_SOURCE,
      paint: { 'line-color': COLORS.axis, 'line-width': 2, 'line-dasharray': [4, 3], 'line-opacity': 0.7 }
    });

    this._initialized = true;
  }

  /**
   * Render a single layout (live preview during drawing).
   * @param {Array<[number,number]>} axisLngLat
   * @param {Object} layout — { sections, corners, gaps } (poly arrays in meters)
   * @param {Object} proj
   */
  update(axisLngLat, layout, proj) {
    var axisFC = {
      type: 'FeatureCollection',
      features: axisLngLat && axisLngLat.length >= 2 ? [{
        type: 'Feature', properties: {},
        geometry: { type: 'LineString', coordinates: axisLngLat }
      }] : []
    };

    var secF = [];
    for (var i = 0; i < layout.sections.length; i++) {
      secF.push(this._sectionFeature(layout.sections[i], proj));
    }
    var corF = [];
    for (var ci = 0; ci < layout.corners.length; ci++) {
      corF.push(this._cornerFeature(layout.corners[ci], proj));
    }
    var gapF = [];
    for (var gi = 0; gi < layout.gaps.length; gi++) {
      gapF.push(this._gapFeature(layout.gaps[gi], proj));
    }

    this._map.updateGeoJSONSource(this.AXIS_SOURCE, axisFC);
    this._map.updateGeoJSONSource(this.SEC_SOURCE, { type: 'FeatureCollection', features: secF });
    this._map.updateGeoJSONSource(this.COR_SOURCE, { type: 'FeatureCollection', features: corF });
    this._map.updateGeoJSONSource(this.GAP_SOURCE, { type: 'FeatureCollection', features: gapF });
  }

  /**
   * Render multiple finalized chains stored in featureStore.
   * @param {Array<Object>} features — array of section-chain features
   *   with `properties.sections|corners|gaps` already in lng/lat.
   */
  updateStored(features) {
    var axisFC = [];
    var secF = [];
    var corF = [];
    var gapF = [];

    for (var i = 0; i < features.length; i++) {
      var f = features[i];
      if (f.geometry && f.geometry.type === 'LineString') {
        axisFC.push({
          type: 'Feature', properties: { id: f.properties.id || '' },
          geometry: f.geometry
        });
      }
      var sects = f.properties.sections || [];
      for (var s = 0; s < sects.length; s++) secF.push(this._storedSectionFeature(sects[s]));
      var cors = f.properties.corners || [];
      for (var c = 0; c < cors.length; c++) corF.push(this._storedCornerFeature(cors[c]));
      var gaps = f.properties.gaps || [];
      for (var g = 0; g < gaps.length; g++) gapF.push(this._storedGapFeature(gaps[g]));
    }

    this._map.updateGeoJSONSource(this.AXIS_SOURCE, { type: 'FeatureCollection', features: axisFC });
    this._map.updateGeoJSONSource(this.SEC_SOURCE, { type: 'FeatureCollection', features: secF });
    this._map.updateGeoJSONSource(this.COR_SOURCE, { type: 'FeatureCollection', features: corF });
    this._map.updateGeoJSONSource(this.GAP_SOURCE, { type: 'FeatureCollection', features: gapF });
  }

  _sectionFeature(sec, proj) {
    var fill = sec.ori === 1 ? COLORS.secLonFill : COLORS.secLatFill;
    var stroke = sec.ori === 1 ? COLORS.secLonStroke : COLORS.secLatStroke;
    return this._polyFeatureMeters(sec.poly, proj, { fill: fill, stroke: stroke, len: sec.len, ori: sec.ori });
  }

  _cornerFeature(c, proj) {
    var col = this._cornerColor(c.mode);
    return this._polyFeatureMeters(c.poly, proj, {
      fill: col.fill, stroke: col.stroke, mode: c.mode || ''
    });
  }

  _gapFeature(g, proj) {
    return this._polyFeatureMeters(g.poly, proj, { len: g.len });
  }

  _storedSectionFeature(s) {
    var fill = s.ori === 1 ? COLORS.secLonFill : COLORS.secLatFill;
    var stroke = s.ori === 1 ? COLORS.secLonStroke : COLORS.secLatStroke;
    return this._polyFeatureLL(s.polygon, { fill: fill, stroke: stroke, len: s.length, ori: s.ori });
  }

  _storedCornerFeature(c) {
    var col = this._cornerColor(c.mode);
    return this._polyFeatureLL(c.polygon, { fill: col.fill, stroke: col.stroke, mode: c.mode || '' });
  }

  _storedGapFeature(g) {
    return this._polyFeatureLL(g.polygon, { len: g.length });
  }

  _cornerColor(mode) {
    if (mode === 'WW') return { fill: COLORS.cornerWWFill, stroke: COLORS.cornerWWStroke };
    if (mode === 'MM') return { fill: COLORS.cornerMMFill, stroke: COLORS.cornerMMStroke };
    return { fill: COLORS.cornerMixFill, stroke: COLORS.cornerMixStroke };
  }

  _polyFeatureMeters(polyM, proj, props) {
    var ring = [];
    for (var i = 0; i < polyM.length; i++) ring.push(proj.toLngLat(polyM[i].x, polyM[i].y));
    ring.push(ring[0]);
    return {
      type: 'Feature', properties: props,
      geometry: { type: 'Polygon', coordinates: [ring] }
    };
  }

  _polyFeatureLL(ringLL, props) {
    var ring = ringLL.slice();
    if (ring.length > 0) ring.push(ring[0]);
    return {
      type: 'Feature', properties: props,
      geometry: { type: 'Polygon', coordinates: [ring] }
    };
  }

  clear() {
    var e = { type: 'FeatureCollection', features: [] };
    this._map.updateGeoJSONSource(this.AXIS_SOURCE, e);
    this._map.updateGeoJSONSource(this.SEC_SOURCE, e);
    this._map.updateGeoJSONSource(this.COR_SOURCE, e);
    this._map.updateGeoJSONSource(this.GAP_SOURCE, e);
  }

  destroy() {
    var map = this._map.getMap();
    if (!map) return;
    var layers = [this.AXIS_LAYER, this.COR_LINE, this.COR_FILL, this.SEC_LINE, this.SEC_FILL, this.GAP_LINE, this.GAP_FILL];
    for (var i = 0; i < layers.length; i++) if (map.getLayer(layers[i])) map.removeLayer(layers[i]);
    var sources = [this.AXIS_SOURCE, this.SEC_SOURCE, this.COR_SOURCE, this.GAP_SOURCE];
    for (var j = 0; j < sources.length; j++) if (map.getSource(sources[j])) map.removeSource(sources[j]);
    this._initialized = false;
  }
}
