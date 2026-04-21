/**
 * Buffers — independent sections get own fire buffer, rest merged
 *
 * Refactored:
 * - Imports from core/geo and core/SectionParams
 * - destroy() properly removes MapLibre layers and sources
 */

import { createProjection, centroid } from '../../core/geo/projection.js';
import { buildGroupBuffers, FIRE_DIST, END_DIST, INSOL_DIST, ROAD_DIST } from '../../core/buffers/Buffers.js';
import { log } from '../../core/Logger.js';

var _distances = { fire: FIRE_DIST, end: END_DIST, insolation: INSOL_DIST, road: ROAD_DIST };
var _shape = { insolCornerR: 15 };

var STYLES = {
  insolation: { fill: 'rgba(22, 163, 74, 0.12)', line: '#16a34a' },
  end:        { fill: 'rgba(37, 99, 235, 0.15)', line: '#2563eb' },
  fire:       { fill: 'rgba(220, 38, 38, 0.15)', line: '#dc2626' },
  road:       { fill: 'rgba(245, 158, 11, 0.15)', line: '#f59e0b' }
};

var SOURCES = { fire: 'buf-fire', end: 'buf-end', insolation: 'buf-insol', road: 'buf-road' };
var FILL_LAYERS = { fire: 'buf-fire-fill', end: 'buf-end-fill', insolation: 'buf-insol-fill', road: 'buf-road-fill' };
var LINE_LAYERS = { fire: 'buf-fire-line', end: 'buf-end-line', insolation: 'buf-insol-line', road: 'buf-road-line' };

var _map, _mapManager, _featureStore, _eventBus;
var _visible = false;
var _initialized = false;
var _unsubs = [];

function initLayers() {
  if (_initialized) return;
  var map = _mapManager.getMap();
  if (!map) return;
  _map = map;
  var emptyFC = { type: 'FeatureCollection', features: [] };
  // Draw order: insolation (widest) → end → road → fire (narrowest on top)
  var order = ['insolation', 'end', 'road', 'fire'];
  for (var oi = 0; oi < order.length; oi++) {
    var key = order[oi];
    var st = STYLES[key];
    _mapManager.addGeoJSONSource(SOURCES[key], emptyFC);
    map.addLayer({ id: FILL_LAYERS[key], type: 'fill', source: SOURCES[key],
      paint: { 'fill-color': st.fill, 'fill-opacity': 1.0 }, layout: { 'visibility': 'none' } });
    map.addLayer({ id: LINE_LAYERS[key], type: 'line', source: SOURCES[key],
      paint: { 'line-color': st.line, 'line-width': 1.5, 'line-dasharray': [4, 2] }, layout: { 'visibility': 'none' } });
  }
  _initialized = true;
}

function removeLayers() {
  if (!_map) return;
  var keys = ['fire', 'end', 'insolation', 'road'];
  for (var i = 0; i < keys.length; i++) {
    var k = keys[i];
    if (_map.getLayer(FILL_LAYERS[k])) _map.removeLayer(FILL_LAYERS[k]);
    if (_map.getLayer(LINE_LAYERS[k])) _map.removeLayer(LINE_LAYERS[k]);
    if (_map.getSource(SOURCES[k])) _map.removeSource(SOURCES[k]);
  }
}

function mergeConsecutive(fpMs) {
  if (fpMs.length === 0) return null;
  if (fpMs.length === 1) return fpMs[0];
  return [fpMs[0][0], fpMs[fpMs.length-1][1], fpMs[fpMs.length-1][2], fpMs[0][3]];
}

function polyMToLL(polyM, proj) {
  var ring = [];
  for (var i = 0; i < polyM.length; i++) ring.push(proj.toLngLat(polyM[i][0], polyM[i][1]));
  ring.push(ring[0]);
  return ring;
}

function computeBuffers() {
  if (!_featureStore) return;
  var all = _featureStore.toArray();
  var sects = [];
  var towers = [];
  for (var i = 0; i < all.length; i++) {
    if (all[i].properties.type === 'section-axis') sects.push(all[i]);
    else if (all[i].properties.type === 'tower-axis') towers.push(all[i]);
  }

  var byType = { fire: [], end: [], insolation: [], road: [] };
  if (sects.length === 0 && towers.length === 0) {
    updateSources(byType);
    return;
  }

  var allCoords = [];
  for (var i = 0; i < sects.length; i++) {
    var c = sects[i].geometry.coordinates;
    for (var j = 0; j < c.length; j++) allCoords.push(c[j]);
  }
  for (var i = 0; i < towers.length; i++) {
    var c = towers[i].geometry.coordinates;
    for (var j = 0; j < c.length; j++) allCoords.push(c[j]);
  }
  if (allCoords.length === 0) { updateSources(byType); return; }
  var gc = centroid(allCoords);
  var proj = createProjection(gc[0], gc[1]);

  // Uniform opts for all groups — single source of truth with
  // computeOverlays (urban-block).
  var opts = { fire: _distances.fire, insol: _distances.insolation,
               end: _distances.end, road: _distances.road,
               insolCornerR: _shape.insolCornerR };

  function emit(groupRect) {
    var gb = buildGroupBuffers(groupRect, opts);
    for (var bi = 0; bi < gb.length; bi++) {
      var b = gb[bi];
      // Map internal type name to MapLibre source key ('insol' → 'insolation')
      var key = b.type === 'insol' ? 'insolation' : b.type;
      if (byType[key]) byType[key].push(polyMToLL(b.polygon, proj));
    }
  }

  for (var si = 0; si < sects.length; si++) {
    var feature = sects[si];
    var storedFP = feature.properties.footprints;
    if (!storedFP || storedFP.length === 0) continue;

    var fpMs = [];
    for (var fi = 0; fi < storedFP.length; fi++) {
      var fpM = [];
      for (var j = 0; j < storedFP[fi].polygon.length; j++)
        fpM.push(proj.toMeters(storedFP[fi].polygon[j][0], storedFP[fi].polygon[j][1]));
      fpMs.push(fpM);
    }

    // Independent-height footprints emit their own buffers; consecutive
    // shared-height footprints are merged into one group.
    var grouped = [];
    var independent = [];
    for (var fi = 0; fi < storedFP.length; fi++) {
      if (storedFP[fi].sectionHeight !== undefined) independent.push(fi);
      else grouped.push(fi);
    }

    for (var ii = 0; ii < independent.length; ii++) {
      emit(fpMs[independent[ii]]);
    }

    if (grouped.length > 0) {
      var runs = [];
      var currentRun = [grouped[0]];
      for (var gi = 1; gi < grouped.length; gi++) {
        if (grouped[gi] === grouped[gi - 1] + 1) currentRun.push(grouped[gi]);
        else { runs.push(currentRun); currentRun = [grouped[gi]]; }
      }
      runs.push(currentRun);
      for (var ri = 0; ri < runs.length; ri++) {
        var runFpMs = [];
        for (var rfi = 0; rfi < runs[ri].length; rfi++) runFpMs.push(fpMs[runs[ri][rfi]]);
        var merged = mergeConsecutive(runFpMs);
        if (merged) emit(merged);
      }
    }
  }

  // Tower buffers — each tower footprint is a group.
  for (var ti = 0; ti < towers.length; ti++) {
    var tFeature = towers[ti];
    var tFP = tFeature.properties.footprints;
    if (!tFP || tFP.length === 0) continue;
    for (var tfi = 0; tfi < tFP.length; tfi++) {
      var tfpM = [];
      for (var j = 0; j < tFP[tfi].polygon.length; j++)
        tfpM.push(proj.toMeters(tFP[tfi].polygon[j][0], tFP[tfi].polygon[j][1]));
      emit(tfpM);
    }
  }

  updateSources(byType);
}

function updateSources(byType) {
  var keys = ['fire', 'end', 'insolation', 'road'];
  for (var i = 0; i < keys.length; i++) {
    var k = keys[i];
    var polys = byType[k] || [];
    var features = [];
    for (var j = 0; j < polys.length; j++) {
      features.push({ type: 'Feature', properties: {},
        geometry: { type: 'Polygon', coordinates: [polys[j]] } });
    }
    _mapManager.updateGeoJSONSource(SOURCES[k], { type: 'FeatureCollection', features: features });
  }
}

function setVisible(vis) {
  _visible = vis;
  if (!_map) return;
  var v = vis ? 'visible' : 'none';
  var keys = ['fire', 'end', 'insolation', 'road'];
  for (var i = 0; i < keys.length; i++) {
    if (_map.getLayer(FILL_LAYERS[keys[i]])) _map.setLayoutProperty(FILL_LAYERS[keys[i]], 'visibility', v);
    if (_map.getLayer(LINE_LAYERS[keys[i]])) _map.setLayoutProperty(LINE_LAYERS[keys[i]], 'visibility', v);
  }
  if (vis) computeBuffers();
}

function onToggle() { setVisible(!_visible); _eventBus.emit('buffers:visibility', { visible: _visible }); }
function onDistanceChanged(d) {
  if (!d || !d.key || d.value == null) return;
  // Shape params go to _shape; main distances to _distances.
  if (d.key === 'insolCornerR') {
    _shape.insolCornerR = d.value;
  } else if (d.key in _distances) {
    _distances[d.key] = d.value;
  } else {
    return;
  }
  if (_visible) computeBuffers();
}
function onChanged() { if (_visible) computeBuffers(); }

var buffersModule = {
  id: 'buffers',
  init: function (ctx) {
    _mapManager = ctx.mapManager; _featureStore = ctx.featureStore; _eventBus = ctx.eventBus;
    initLayers();
    _unsubs.push(_eventBus.on('buffers:toggle', onToggle));
    _unsubs.push(_eventBus.on('buffers:distance:changed', onDistanceChanged));
    _unsubs.push(_eventBus.on('buffers:recompute', onChanged));
    _unsubs.push(_eventBus.on('features:changed', onChanged));
    _unsubs.push(_eventBus.on('draw:section:complete', onChanged));
    _unsubs.push(_eventBus.on('section-gen:params:changed', onChanged));
    log.debug('[buffers] initialized');
  },
  destroy: function () {
    for (var i = 0; i < _unsubs.length; i++) _unsubs[i]();
    _unsubs = [];
    removeLayers();
    _map = null; _mapManager = null; _featureStore = null; _eventBus = null;
    _visible = false; _initialized = false;
  }
};

export default buffersModule;
