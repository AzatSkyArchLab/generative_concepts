/**
 * Urban Block Module — entry point
 *
 * Standard module interface: { id, init(ctx), destroy() }
 *
 * Listens for drawn polygons/lines, processes them through the
 * urban block pipeline, and visualizes axes + base rectangles.
 *
 * ctx = { mapManager, eventBus, featureStore }
 */

import { createProjection, centroid } from './projection.js';
import { processPolygon } from './PolygonProcessor.js';
import { UrbanBlockLayer } from './UrbanBlockLayer.js';
import { log } from '../../core/Logger.js';

// ── Configuration ──────────────────────────────────────

var PARAMS = {
  sectionWidth: 15
};

// ── Module state ───────────────────────────────────────

var _layer = null;
var _eventBus = null;
var _featureStore = null;
var _unsubs = [];

// ── Event handlers ─────────────────────────────────────

function onPolygonComplete(feature) {
  _processFeature(feature);
}

function onLineComplete(feature) {
  _processFeature(feature);
}

function onFeaturesChanged() {
  // Re-process the last polygon/line in the store
  var all = _featureStore.toArray();
  if (all.length === 0) {
    if (_layer) _layer.clear();
    return;
  }

  // Find last polygon or line
  var target = null;
  for (var i = all.length - 1; i >= 0; i--) {
    var type = all[i].geometry.type;
    if (type === 'Polygon' || type === 'LineString') {
      target = all[i];
      break;
    }
  }

  if (target) {
    _processFeature(target);
  } else {
    if (_layer) _layer.clear();
  }
}

function _processFeature(feature) {
  if (!_layer) return;

  var geomType = feature.geometry.type;
  var isClosed = geomType === 'Polygon';

  // Extract coordinates
  var coords;
  if (geomType === 'Polygon') {
    coords = feature.geometry.coordinates[0]; // outer ring
  } else if (geomType === 'LineString') {
    coords = feature.geometry.coordinates;
  } else {
    return;
  }

  if (coords.length < 2) return;

  // Remove closing point for polygons
  var ring = [];
  for (var i = 0; i < coords.length; i++) {
    ring.push([coords[i][0], coords[i][1]]);
  }
  if (isClosed && ring.length > 1) {
    var first = ring[0];
    var last = ring[ring.length - 1];
    if (Math.abs(first[0] - last[0]) < 1e-8 && Math.abs(first[1] - last[1]) < 1e-8) {
      ring.pop();
    }
  }

  // Project to meters
  var c = centroid(ring);
  var proj = createProjection(c[0], c[1]);
  var metersRing = proj.coordsToMeters(ring);

  // Process
  var result = processPolygon(metersRing, isClosed, PARAMS.sectionWidth);

  log.debug('=== URBAN BLOCK ===');
  log.debug('Edges:', result.edges.length, 'Closed:', isClosed);
  for (var i = 0; i < result.edges.length; i++) {
    var e = result.edges[i];
    var ori = e.orientation === 1 ? 'мерид' : 'шир';
    log.debug('  Ось ' + e.id + ': ' + ori + ', ctx=' + e.context + ', ' + e.length.toFixed(1) + 'м');
  }

  // Visualize
  _layer.update(result.edges, proj);
}

// ── Module interface ───────────────────────────────────

var urbanBlockModule = {
  id: 'urban-block',

  /**
   * @param {{ mapManager: Object, eventBus: Object, featureStore: Object }} ctx
   */
  init: function (ctx) {
    _eventBus = ctx.eventBus;
    _featureStore = ctx.featureStore;

    // Create visualization layer
    _layer = new UrbanBlockLayer(ctx.mapManager);
    _layer.init();

    // Subscribe to events
    _unsubs.push(_eventBus.on('draw:polygon:complete', onPolygonComplete));
    _unsubs.push(_eventBus.on('draw:line:complete', onLineComplete));
    _unsubs.push(_eventBus.on('features:changed', onFeaturesChanged));

    log.debug('[urban-block] module initialized');
  },

  destroy: function () {
    // Unsubscribe
    for (var i = 0; i < _unsubs.length; i++) {
      _unsubs[i]();
    }
    _unsubs = [];

    // Remove layers
    if (_layer) {
      _layer.destroy();
      _layer = null;
    }

    _eventBus = null;
    _featureStore = null;
    log.debug('[urban-block] module destroyed');
  }
};

export default urbanBlockModule;
