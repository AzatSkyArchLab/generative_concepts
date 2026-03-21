/**
 * SectionLayer — renders section rectangles on the map
 *
 * Each section is a rectangle: axis segment + perpendicular offset (section_width).
 * Colors:
 *   latitudinal (шир) — blue #3264dc
 *   meridional (мерид) — red #dc3232
 *   gap — transparent with dashed outline
 */

var SECTION_WIDTH = 15; // meters

var COLORS = {
  lat: '#3264dc',
  lon: '#dc3232',
  gap: '#999999'
};

export class SectionLayer {
  /**
   * @param {import('../../map/MapManager.js').MapManager} mapManager
   */
  constructor(mapManager) {
    this._map = mapManager;
    this._initialized = false;

    this.RECT_SOURCE = 'sec-rects';
    this.AXIS_SOURCE = 'sec-axis';
    this.LABEL_SOURCE = 'sec-labels';

    this.RECT_FILL_LAYER = 'sec-rects-fill';
    this.RECT_LINE_LAYER = 'sec-rects-line';
    this.GAP_FILL_LAYER = 'sec-gap-fill';
    this.AXIS_LAYER = 'sec-axis-line';
    this.LABEL_LAYER = 'sec-labels-text';
  }

  init() {
    if (this._initialized) return;

    var emptyFC = { type: 'FeatureCollection', features: [] };

    this._map.addGeoJSONSource(this.RECT_SOURCE, emptyFC);
    this._map.addGeoJSONSource(this.AXIS_SOURCE, emptyFC);
    this._map.addGeoJSONSource(this.LABEL_SOURCE, emptyFC);

    var map = this._map.getMap();
    if (!map) return;

    // Section rectangles — fill
    map.addLayer({
      id: this.RECT_FILL_LAYER,
      type: 'fill',
      source: this.RECT_SOURCE,
      filter: ['==', ['get', 'isGap'], false],
      paint: {
        'fill-color': ['get', 'color'],
        'fill-opacity': 0.25
      }
    });

    // Gap rectangles — subtle fill
    map.addLayer({
      id: this.GAP_FILL_LAYER,
      type: 'fill',
      source: this.RECT_SOURCE,
      filter: ['==', ['get', 'isGap'], true],
      paint: {
        'fill-color': COLORS.gap,
        'fill-opacity': 0.08
      }
    });

    // Section outlines
    map.addLayer({
      id: this.RECT_LINE_LAYER,
      type: 'line',
      source: this.RECT_SOURCE,
      paint: {
        'line-color': ['get', 'color'],
        'line-width': ['case', ['get', 'isGap'], 1, 1.5],
        'line-dasharray': ['case', ['get', 'isGap'],
          ['literal', [4, 4]],
          ['literal', [1, 0]]
        ],
        'line-opacity': 0.8
      }
    });

    // Axis line
    map.addLayer({
      id: this.AXIS_LAYER,
      type: 'line',
      source: this.AXIS_SOURCE,
      paint: {
        'line-color': ['get', 'color'],
        'line-width': 3,
        'line-opacity': 0.9
      }
    });

    // Section labels
    map.addLayer({
      id: this.LABEL_LAYER,
      type: 'symbol',
      source: this.LABEL_SOURCE,
      layout: {
        'text-field': ['get', 'label'],
        'text-size': 10,
        'text-font': ['Noto Sans Regular'],
        'text-offset': [0, -1],
        'text-anchor': 'bottom',
        'text-allow-overlap': true
      },
      paint: {
        'text-color': '#1f2937',
        'text-halo-color': '#ffffff',
        'text-halo-width': 1.5
      }
    });

    this._initialized = true;
  }

  /**
   * Render sections on the map.
   *
   * @param {Array<Object>} sections - positioned sections from distributor
   * @param {Array<[number, number]>} axisM - axis polyline in meters
   * @param {{ orientation: number, orientationName: string }} ori
   * @param {Object} proj - { toLngLat(mx, my) }
   * @param {number} [sectionWidth=15]
   */
  update(sections, axisM, ori, proj, sectionWidth) {
    if (!sectionWidth) sectionWidth = SECTION_WIDTH;

    var color = ori.orientation === 1 ? COLORS.lon : COLORS.lat;
    var oriLabel = ori.orientation === 1 ? 'мерид' : 'шир';

    // Compute perpendicular direction (consistent for entire axis)
    var perpDir = this._computePerp(axisM);
    var offsetX = perpDir[0] * sectionWidth;
    var offsetY = perpDir[1] * sectionWidth;

    var rectFeatures = [];
    var labelFeatures = [];

    for (var i = 0; i < sections.length; i++) {
      var sec = sections[i];
      var s = sec.startM;
      var e = sec.endM;

      // Four corners of the rectangle
      var p1 = proj.toLngLat(s[0], s[1]);
      var p2 = proj.toLngLat(e[0], e[1]);
      var p3 = proj.toLngLat(e[0] + offsetX, e[1] + offsetY);
      var p4 = proj.toLngLat(s[0] + offsetX, s[1] + offsetY);

      var secColor = sec.isGap ? COLORS.gap : color;

      rectFeatures.push({
        type: 'Feature',
        properties: {
          index: i,
          length: sec.length,
          isGap: sec.isGap,
          color: secColor
        },
        geometry: {
          type: 'Polygon',
          coordinates: [[p1, p2, p3, p4, p1]]
        }
      });

      // Label at center of rectangle
      var cx = (s[0] + e[0]) / 2 + offsetX / 2;
      var cy = (s[1] + e[1]) / 2 + offsetY / 2;
      var cLL = proj.toLngLat(cx, cy);
      var label = sec.isGap
        ? 'GAP ' + sec.length.toFixed(1) + 'м'
        : sec.length.toFixed(1) + 'м';

      labelFeatures.push({
        type: 'Feature',
        properties: { label: label },
        geometry: { type: 'Point', coordinates: cLL }
      });
    }

    // Axis line
    var axisCoords = [];
    for (var i = 0; i < axisM.length; i++) {
      axisCoords.push(proj.toLngLat(axisM[i][0], axisM[i][1]));
    }

    // Axis label at midpoint
    var midIdx = Math.floor(axisM.length / 2);
    var midM = axisM[midIdx];
    var midLL = proj.toLngLat(midM[0], midM[1]);
    var totalLen = 0;
    for (var i = 0; i < axisM.length - 1; i++) {
      var dx = axisM[i + 1][0] - axisM[i][0];
      var dy = axisM[i + 1][1] - axisM[i][1];
      totalLen += Math.sqrt(dx * dx + dy * dy);
    }
    var secCount = 0;
    for (var i = 0; i < sections.length; i++) {
      if (!sections[i].isGap) secCount++;
    }

    labelFeatures.push({
      type: 'Feature',
      properties: {
        label: oriLabel + ' | ' + totalLen.toFixed(0) + 'м | ' + secCount + ' секц.'
      },
      geometry: { type: 'Point', coordinates: midLL }
    });

    // Update sources
    this._map.updateGeoJSONSource(this.RECT_SOURCE, {
      type: 'FeatureCollection', features: rectFeatures
    });

    this._map.updateGeoJSONSource(this.AXIS_SOURCE, {
      type: 'FeatureCollection',
      features: [{
        type: 'Feature',
        properties: { color: color },
        geometry: { type: 'LineString', coordinates: axisCoords }
      }]
    });

    this._map.updateGeoJSONSource(this.LABEL_SOURCE, {
      type: 'FeatureCollection', features: labelFeatures
    });
  }

  /**
   * Compute perpendicular direction for the overall axis.
   * Points to the "right" side (CW rotation of direction).
   *
   * @param {Array<[number, number]>} axisM
   * @returns {[number, number]} normalized perpendicular
   */
  _computePerp(axisM) {
    if (axisM.length < 2) return [0, 1];

    var first = axisM[0];
    var last = axisM[axisM.length - 1];
    var dx = last[0] - first[0];
    var dy = last[1] - first[1];
    var len = Math.sqrt(dx * dx + dy * dy);
    if (len < 1e-6) return [0, 1];

    // Perpendicular: rotate 90° CW → (dy, -dx) normalized
    return [dy / len, -dx / len];
  }

  clear() {
    var emptyFC = { type: 'FeatureCollection', features: [] };
    this._map.updateGeoJSONSource(this.RECT_SOURCE, emptyFC);
    this._map.updateGeoJSONSource(this.AXIS_SOURCE, emptyFC);
    this._map.updateGeoJSONSource(this.LABEL_SOURCE, emptyFC);
  }

  destroy() {
    var map = this._map.getMap();
    if (!map) return;

    var layers = [
      this.LABEL_LAYER, this.AXIS_LAYER,
      this.RECT_LINE_LAYER, this.GAP_FILL_LAYER, this.RECT_FILL_LAYER
    ];
    for (var i = 0; i < layers.length; i++) {
      if (map.getLayer(layers[i])) map.removeLayer(layers[i]);
    }
    var sources = [this.LABEL_SOURCE, this.AXIS_SOURCE, this.RECT_SOURCE];
    for (var i = 0; i < sources.length; i++) {
      if (map.getSource(sources[i])) map.removeSource(sources[i]);
    }
    this._initialized = false;
  }
}
