/**
 * UrbanBlockLayer — MapLibre layers for urban block visualization
 *
 * Renders:
 * - Axes (colored by context)
 * - Offset lines (inner parallel)
 * - Base rectangles (section strips)
 * - Axis labels (orientation + length)
 */

var CONTEXT_COLORS = {
  0: '#dc3232',  // highway — red
  1: '#ff9900',  // boundary — orange
  2: '#3264dc'   // internal — blue
};

var OFFSET_COLORS = {
  0: '#ff6666',
  1: '#ffcc66',
  2: '#6699ff'
};

export class UrbanBlockLayer {
  /**
   * @param {import('../../map/MapManager.js').MapManager} mapManager
   */
  constructor(mapManager) {
    this._map = mapManager;
    this._initialized = false;

    this.AXES_SOURCE = 'ub-axes';
    this.OFFSET_SOURCE = 'ub-offset';
    this.RECT_SOURCE = 'ub-rects';
    this.LABEL_SOURCE = 'ub-labels';

    this.AXES_LAYER = 'ub-axes-line';
    this.OFFSET_LAYER = 'ub-offset-line';
    this.RECT_FILL_LAYER = 'ub-rects-fill';
    this.RECT_LINE_LAYER = 'ub-rects-line';
    this.LABEL_LAYER = 'ub-labels-text';
  }

  init() {
    if (this._initialized) return;

    var emptyFC = { type: 'FeatureCollection', features: [] };

    this._map.addGeoJSONSource(this.AXES_SOURCE, emptyFC);
    this._map.addGeoJSONSource(this.OFFSET_SOURCE, emptyFC);
    this._map.addGeoJSONSource(this.RECT_SOURCE, emptyFC);
    this._map.addGeoJSONSource(this.LABEL_SOURCE, emptyFC);

    var map = this._map.getMap();
    if (!map) return;

    // Base rectangles — fill
    map.addLayer({
      id: this.RECT_FILL_LAYER,
      type: 'fill',
      source: this.RECT_SOURCE,
      paint: {
        'fill-color': ['coalesce', ['get', 'color'], '#3264dc'],
        'fill-opacity': 0.08
      }
    });

    // Base rectangles — outline
    map.addLayer({
      id: this.RECT_LINE_LAYER,
      type: 'line',
      source: this.RECT_SOURCE,
      paint: {
        'line-color': ['coalesce', ['get', 'color'], '#3264dc'],
        'line-width': 1,
        'line-dasharray': [4, 4],
        'line-opacity': 0.4
      }
    });

    // Offset lines (inner parallel)
    map.addLayer({
      id: this.OFFSET_LAYER,
      type: 'line',
      source: this.OFFSET_SOURCE,
      paint: {
        'line-color': ['coalesce', ['get', 'color'], '#6699ff'],
        'line-width': 1.5,
        'line-dasharray': [6, 3],
        'line-opacity': 0.6
      }
    });

    // Axes — main lines
    map.addLayer({
      id: this.AXES_LAYER,
      type: 'line',
      source: this.AXES_SOURCE,
      paint: {
        'line-color': ['coalesce', ['get', 'color'], '#dc3232'],
        'line-width': 3,
        'line-opacity': 0.85
      }
    });

    // Labels
    map.addLayer({
      id: this.LABEL_LAYER,
      type: 'symbol',
      source: this.LABEL_SOURCE,
      layout: {
        'text-field': ['get', 'label'],
        'text-size': 11,
        'text-font': ['Open Sans Regular'],
        'text-offset': [0, -1.2],
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
   * Update all layers with processed edges
   *
   * @param {Array<Object>} edges - processed edges (meter-space, with offsetStart/offsetEnd)
   * @param {Object} proj - projector { toLngLat(mx, my) }
   */
  update(edges, proj) {
    var axesFeatures = [];
    var offsetFeatures = [];
    var rectFeatures = [];
    var labelFeatures = [];

    for (var i = 0; i < edges.length; i++) {
      var edge = edges[i];
      if (edge.length < 1) continue;

      var ctx = edge.context !== undefined ? edge.context : 2;
      var ori = edge.orientation === 1 ? 'lon' : 'lat';
      var oriLabel = edge.orientation === 1 ? 'мерид' : 'шир';
      var color = CONTEXT_COLORS[ctx] || CONTEXT_COLORS[2];
      var offColor = OFFSET_COLORS[ctx] || OFFSET_COLORS[2];

      // Axis line (in lng/lat)
      var startLL = proj.toLngLat(edge.start[0], edge.start[1]);
      var endLL = proj.toLngLat(edge.end[0], edge.end[1]);

      axesFeatures.push({
        type: 'Feature',
        properties: {
          id: edge.id,
          context: ctx,
          orientation: ori,
          length: edge.length,
          color: color
        },
        geometry: {
          type: 'LineString',
          coordinates: [startLL, endLL]
        }
      });

      // Offset line
      if (edge.offsetStart && edge.offsetEnd) {
        var offStartLL = proj.toLngLat(edge.offsetStart[0], edge.offsetStart[1]);
        var offEndLL = proj.toLngLat(edge.offsetEnd[0], edge.offsetEnd[1]);

        offsetFeatures.push({
          type: 'Feature',
          properties: { id: edge.id, color: offColor },
          geometry: {
            type: 'LineString',
            coordinates: [offStartLL, offEndLL]
          }
        });

        // Base rectangle
        var rectCoords = [startLL, endLL, offEndLL, offStartLL, startLL];
        rectFeatures.push({
          type: 'Feature',
          properties: { id: edge.id, color: color },
          geometry: {
            type: 'Polygon',
            coordinates: [rectCoords]
          }
        });
      }

      // Label at midpoint
      var midM = [(edge.start[0] + edge.end[0]) / 2, (edge.start[1] + edge.end[1]) / 2];
      var midLL = proj.toLngLat(midM[0], midM[1]);
      var label = 'Ось ' + edge.id + ' (' + oriLabel + ') ' + edge.length.toFixed(0) + 'м';

      labelFeatures.push({
        type: 'Feature',
        properties: { label: label },
        geometry: {
          type: 'Point',
          coordinates: midLL
        }
      });
    }

    this._map.updateGeoJSONSource(this.AXES_SOURCE, { type: 'FeatureCollection', features: axesFeatures });
    this._map.updateGeoJSONSource(this.OFFSET_SOURCE, { type: 'FeatureCollection', features: offsetFeatures });
    this._map.updateGeoJSONSource(this.RECT_SOURCE, { type: 'FeatureCollection', features: rectFeatures });
    this._map.updateGeoJSONSource(this.LABEL_SOURCE, { type: 'FeatureCollection', features: labelFeatures });
  }

  /**
   * Clear all urban block visualization
   */
  clear() {
    var emptyFC = { type: 'FeatureCollection', features: [] };
    this._map.updateGeoJSONSource(this.AXES_SOURCE, emptyFC);
    this._map.updateGeoJSONSource(this.OFFSET_SOURCE, emptyFC);
    this._map.updateGeoJSONSource(this.RECT_SOURCE, emptyFC);
    this._map.updateGeoJSONSource(this.LABEL_SOURCE, emptyFC);
  }

  destroy() {
    var map = this._map.getMap();
    if (!map) return;

    var layers = [this.LABEL_LAYER, this.AXES_LAYER, this.OFFSET_LAYER, this.RECT_LINE_LAYER, this.RECT_FILL_LAYER];
    for (var i = 0; i < layers.length; i++) {
      if (map.getLayer(layers[i])) map.removeLayer(layers[i]);
    }
    var sources = [this.LABEL_SOURCE, this.AXES_SOURCE, this.OFFSET_SOURCE, this.RECT_SOURCE];
    for (var i = 0; i < sources.length; i++) {
      if (map.getSource(sources[i])) map.removeSource(sources[i]);
    }
    this._initialized = false;
  }
}
