/**
 * Buffers — independent sections get own fire buffer, rest merged
 *
 * Refactored:
 * - Imports from core/geo and core/SectionParams
 * - destroy() properly removes MapLibre layers and sources
 */

import { createProjection, centroid } from '../../core/geo/projection.js';
import { autoFireDist } from '../../core/SectionParams.js';

var _distances = { end: 20, insolation: 40 };

var STYLES = {
  insolation: { fill: 'rgba(22, 163, 74, 0.12)', line: '#16a34a' },
  end:        { fill: 'rgba(37, 99, 235, 0.15)', line: '#2563eb' },
  fire:       { fill: 'rgba(220, 38, 38, 0.15)', line: '#dc2626' }
};

var SOURCES = { fire: 'buf-fire', end: 'buf-end', insolation: 'buf-insol' };
var FILL_LAYERS = { fire: 'buf-fire-fill', end: 'buf-end-fill', insolation: 'buf-insol-fill' };
var LINE_LAYERS = { fire: 'buf-fire-line', end: 'buf-end-line', insolation: 'buf-insol-line' };

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
  var order = ['insolation', 'end', 'fire'];
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
  var keys = ['fire', 'end', 'insolation'];
  for (var i = 0; i < keys.length; i++) {
    var k = keys[i];
    if (_map.getLayer(FILL_LAYERS[k])) _map.removeLayer(FILL_LAYERS[k]);
    if (_map.getLayer(LINE_LAYERS[k])) _map.removeLayer(LINE_LAYERS[k]);
    if (_map.getSource(SOURCES[k])) _map.removeSource(SOURCES[k]);
  }
}

function polyCentroid(poly) {
  var cx = 0; var cy = 0;
  for (var i = 0; i < poly.length; i++) { cx += poly[i][0]; cy += poly[i][1]; }
  return [cx / poly.length, cy / poly.length];
}

function outwardNormal(p1, p2, cx, cy) {
  var dx = p2[0]-p1[0]; var dy = p2[1]-p1[1];
  var len = Math.sqrt(dx*dx+dy*dy);
  if (len < 1e-10) return [0,0];
  var n1x = -dy/len; var n1y = dx/len;
  var mx = (p1[0]+p2[0])/2; var my = (p1[1]+p2[1])/2;
  if (n1x*(mx-cx)+n1y*(my-cy) >= 0) return [n1x, n1y];
  return [-n1x, -n1y];
}

function offsetEdgeOutward(p1, p2, dist, cx, cy) {
  var n = outwardNormal(p1, p2, cx, cy);
  return [[p1[0],p1[1]], [p2[0],p2[1]], [p2[0]+n[0]*dist,p2[1]+n[1]*dist], [p1[0]+n[0]*dist,p1[1]+n[1]*dist]];
}

function bufferPolygonRounded(poly, dist, segments) {
  if (!segments) segments = 8;
  var n = poly.length;
  if (n < 3) return poly;
  var c = polyCentroid(poly);
  var result = [];
  for (var i = 0; i < n; i++) {
    var prev = (i-1+n)%n; var next = (i+1)%n;
    var n0 = outwardNormal(poly[prev], poly[i], c[0], c[1]);
    var n1 = outwardNormal(poly[i], poly[next], c[0], c[1]);
    var a0 = Math.atan2(n0[1], n0[0]); var a1 = Math.atan2(n1[1], n1[0]);
    var da = a1-a0;
    if (da > Math.PI) da -= 2*Math.PI;
    if (da < -Math.PI) da += 2*Math.PI;
    var px = poly[i][0]; var py = poly[i][1];
    if (Math.abs(da) < 0.01) { result.push([px+n0[0]*dist, py+n0[1]*dist]); }
    else {
      var segs = Math.max(2, Math.round(Math.abs(da)/(Math.PI/2)*segments));
      for (var s = 0; s <= segs; s++) {
        var a = a0 + da*(s/segs);
        result.push([px+Math.cos(a)*dist, py+Math.sin(a)*dist]);
      }
    }
  }
  return result;
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

  var firePolys = []; var endPolys = []; var insolPolys = [];
  if (sects.length === 0 && towers.length === 0) { updateSources(firePolys, endPolys, insolPolys); return; }

  var allCoords = [];
  for (var i = 0; i < sects.length; i++) {
    var c = sects[i].geometry.coordinates;
    for (var j = 0; j < c.length; j++) allCoords.push(c[j]);
  }
  for (var i = 0; i < towers.length; i++) {
    var c = towers[i].geometry.coordinates;
    for (var j = 0; j < c.length; j++) allCoords.push(c[j]);
  }
  if (allCoords.length === 0) { updateSources(firePolys, endPolys, insolPolys); return; }
  var gc = centroid(allCoords);
  var proj = createProjection(gc[0], gc[1]);

  for (var si = 0; si < sects.length; si++) {
    var feature = sects[si];
    var storedFP = feature.properties.footprints;
    if (!storedFP || storedFP.length === 0) continue;
    var axisH = feature.properties.sectionHeight || 28;

    var fpMs = [];
    for (var fi = 0; fi < storedFP.length; fi++) {
      var fpM = [];
      for (var j = 0; j < storedFP[fi].polygon.length; j++)
        fpM.push(proj.toMeters(storedFP[fi].polygon[j][0], storedFP[fi].polygon[j][1]));
      fpMs.push(fpM);
    }

    var fullMerged = mergeConsecutive(fpMs);
    if (!fullMerged) continue;
    var fcx = polyCentroid(fullMerged);

    endPolys.push(polyMToLL(bufferPolygonRounded(fullMerged, _distances.end, 8), proj));
    insolPolys.push(polyMToLL(offsetEdgeOutward(fullMerged[0], fullMerged[1], _distances.insolation, fcx[0], fcx[1]), proj));
    insolPolys.push(polyMToLL(offsetEdgeOutward(fullMerged[2], fullMerged[3], _distances.insolation, fcx[0], fcx[1]), proj));

    var grouped = [];
    var independent = [];
    for (var fi = 0; fi < storedFP.length; fi++) {
      if (storedFP[fi].sectionHeight !== undefined) independent.push(fi);
      else grouped.push(fi);
    }

    for (var ii = 0; ii < independent.length; ii++) {
      var idx = independent[ii];
      firePolys.push(polyMToLL(bufferPolygonRounded(fpMs[idx], autoFireDist(storedFP[idx].sectionHeight), 6), proj));
    }

    if (grouped.length > 0) {
      var runs = [];
      var currentRun = [grouped[0]];
      for (var gi = 1; gi < grouped.length; gi++) {
        if (grouped[gi] === grouped[gi-1] + 1) currentRun.push(grouped[gi]);
        else { runs.push(currentRun); currentRun = [grouped[gi]]; }
      }
      runs.push(currentRun);
      for (var ri = 0; ri < runs.length; ri++) {
        var runFpMs = [];
        for (var rfi = 0; rfi < runs[ri].length; rfi++) runFpMs.push(fpMs[runs[ri][rfi]]);
        var merged = mergeConsecutive(runFpMs);
        if (merged) firePolys.push(polyMToLL(bufferPolygonRounded(merged, autoFireDist(axisH), 6), proj));
      }
    }
  }

  // Tower buffers
  for (var ti = 0; ti < towers.length; ti++) {
    var tFeature = towers[ti];
    var tFP = tFeature.properties.footprints;
    if (!tFP || tFP.length === 0) continue;

    for (var tfi = 0; tfi < tFP.length; tfi++) {
      var tfpM = [];
      for (var j = 0; j < tFP[tfi].polygon.length; j++)
        tfpM.push(proj.toMeters(tFP[tfi].polygon[j][0], tFP[tfi].polygon[j][1]));

      // Fire buffer (14m for towers — always high-rise)
      firePolys.push(polyMToLL(bufferPolygonRounded(tfpM, 14, 8), proj));

      // End buffer (torec)
      endPolys.push(polyMToLL(bufferPolygonRounded(tfpM, _distances.end, 8), proj));

      // Insolation buffer on all 4 sides
      var tcx = polyCentroid(tfpM);
      for (var ei = 0; ei < tfpM.length; ei++) {
        var enext = (ei + 1) % tfpM.length;
        insolPolys.push(polyMToLL(
          offsetEdgeOutward(tfpM[ei], tfpM[enext], _distances.insolation, tcx[0], tcx[1]), proj));
      }
    }
  }

  updateSources(firePolys, endPolys, insolPolys);
}

function updateSources(fire, end, insol) {
  var sets = [{ key: 'fire', polys: fire }, { key: 'end', polys: end }, { key: 'insolation', polys: insol }];
  for (var i = 0; i < sets.length; i++) {
    var features = [];
    for (var j = 0; j < sets[i].polys.length; j++)
      features.push({ type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: [sets[i].polys[j]] } });
    _mapManager.updateGeoJSONSource(SOURCES[sets[i].key], { type: 'FeatureCollection', features: features });
  }
}

function setVisible(vis) {
  _visible = vis;
  if (!_map) return;
  var v = vis ? 'visible' : 'none';
  var keys = ['fire', 'end', 'insolation'];
  for (var i = 0; i < keys.length; i++) {
    if (_map.getLayer(FILL_LAYERS[keys[i]])) _map.setLayoutProperty(FILL_LAYERS[keys[i]], 'visibility', v);
    if (_map.getLayer(LINE_LAYERS[keys[i]])) _map.setLayoutProperty(LINE_LAYERS[keys[i]], 'visibility', v);
  }
  if (vis) computeBuffers();
}

function onToggle() { setVisible(!_visible); _eventBus.emit('buffers:visibility', { visible: _visible }); }
function onDistanceChanged(d) { if (d.key && d.value !== undefined) { _distances[d.key] = d.value; if (_visible) computeBuffers(); } }
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
    console.log('[buffers] initialized');
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
