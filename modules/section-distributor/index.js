/**
 * Section Distributor Module
 *
 * Standard module interface: { id, init(ctx), destroy() }
 *
 * Listens for drawn lines → classifies orientation →
 * distributes standard sections → renders rectangles.
 */

import { createProjection, centroid } from '../urban-block/projection.js';
import { classifyPolyline } from './orientation.js';
import { getSectionLengths, createSectionSequence, placeSections, polylineLength } from './distributor.js';
import { SectionLayer } from './SectionLayer.js';
import { log } from '../../core/Logger.js';

// ── Config ─────────────────────────────────────────────

var SECTION_WIDTH = 15;

// ── Module state ───────────────────────────────────────

var _layer = null;
var _eventBus = null;
var _featureStore = null;
var _unsubs = [];

// ── Processing ─────────────────────────────────────────

function onLineComplete(feature) {
  processLine(feature);
}

function onFeaturesChanged() {
  var all = _featureStore.toArray();
  if (all.length === 0) {
    if (_layer) _layer.clear();
    return;
  }

  // Find last line
  var target = null;
  for (var i = all.length - 1; i >= 0; i--) {
    if (all[i].geometry.type === 'LineString') {
      target = all[i];
      break;
    }
  }

  if (target) {
    processLine(target);
  } else {
    if (_layer) _layer.clear();
  }
}

function processLine(feature) {
  if (!_layer) return;
  if (feature.geometry.type !== 'LineString') return;

  var coords = feature.geometry.coordinates;
  if (coords.length < 2) return;

  // Project to meters
  var c = centroid(coords);
  var proj = createProjection(c[0], c[1]);

  var coordsM = [];
  for (var i = 0; i < coords.length; i++) {
    coordsM.push(proj.toMeters(coords[i][0], coords[i][1]));
  }

  // Total length
  var totalLen = polylineLength(coordsM);
  if (totalLen < 1) return;

  // Classify orientation
  var ori = classifyPolyline(coordsM);

  // Get section lengths for this orientation
  var sectionLengths = getSectionLengths(ori.orientation);

  // Check minimum
  var minSL = Infinity;
  for (var i = 0; i < sectionLengths.length; i++) {
    if (sectionLengths[i] < minSL) minSL = sectionLengths[i];
  }

  if (totalLen < minSL) {
    log.debug('[section-distributor] Axis too short: ' + totalLen.toFixed(1) + 'm < min ' + minSL + 'm');
    _layer.clear();
    return;
  }

  // Distribute
  var sequence = createSectionSequence(sectionLengths, totalLen);

  // Place along polyline
  var sections = placeSections(coordsM, sequence, totalLen);

  // Log
  log.debug('=== SECTION DISTRIBUTOR ===');
  log.debug('Orientation:', ori.orientationName, '| Length:', totalLen.toFixed(1) + 'm');
  log.debug('Available lengths:', sectionLengths);
  var secLabels = [];
  for (var i = 0; i < sections.length; i++) {
    var s = sections[i];
    if (s.isGap) {
      secLabels.push('GAP=' + s.length.toFixed(1));
    } else {
      secLabels.push(String(s.length));
    }
  }
  var usedLen = 0;
  for (var i = 0; i < sections.length; i++) {
    usedLen += sections[i].length;
  }
  log.debug('Sections:', secLabels.join(', '), '| Remainder:', (totalLen - usedLen).toFixed(1) + 'm');

  // Render
  _layer.update(sections, coordsM, ori, proj, SECTION_WIDTH);
}

// ── Module interface ───────────────────────────────────

var sectionDistributorModule = {
  id: 'section-distributor',

  init: function (ctx) {
    _eventBus = ctx.eventBus;
    _featureStore = ctx.featureStore;

    _layer = new SectionLayer(ctx.mapManager);
    _layer.init();

    _unsubs.push(_eventBus.on('draw:line:complete', onLineComplete));
    _unsubs.push(_eventBus.on('features:changed', onFeaturesChanged));

    log.debug('[section-distributor] module initialized');
  },

  destroy: function () {
    for (var i = 0; i < _unsubs.length; i++) {
      _unsubs[i]();
    }
    _unsubs = [];

    if (_layer) {
      _layer.destroy();
      _layer = null;
    }

    _eventBus = null;
    _featureStore = null;
    log.debug('[section-distributor] module destroyed');
  }
};

export default sectionDistributorModule;
