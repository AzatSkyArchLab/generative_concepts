/**
 * Buffer Module — buffers from MERGED section footprints per axis
 *
 * For each axis: merge all section footprints into one polygon,
 * then compute buffers from that unified shape.
 *
 * Fire:        11m (≤28m height) / 14m (>28m) — polygon buffer, rounded
 * End:         20m — polygon buffer, rounded corners
 * Insolation:  40m — only long facades, nothing on торцы
 */

import { eventBus } from '../../core/EventBus.js';
import { createProjection, centroid } from '../urban-block/projection.js';

var _distances = { fire: 11, end: 20, insolation: 40 };

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

// ── Geometry helpers ───────────────────────────────────

function polyCentroid(poly) {
  var cx = 0; var cy = 0;
  for (var i = 0; i < poly.length; i++) { cx += poly[i][0]; cy += poly[i][1]; }
  return [cx / poly.length, cy / poly.length];
}

function outwardNormal(p1, p2, cx, cy) {
  var dx = p2[0] - p1[0]; var dy = p2[1] - p1[1];
  var len = Math.sqrt(dx * dx + dy * dy);
  if (len < 1e-10) return [0, 0];
  var n1x = -dy / len; var n1y = dx / len;
  var mx = (p1[0] + p2[0]) / 2; var my = (p1[1] + p2[1]) / 2;
  var dot = n1x * (mx - cx) + n1y * (my - cy);
  if (dot >= 0) return [n1x, n1y];
  return [-n1x, -n1y];
}

function offsetEdgeOutward(p1, p2, dist, cx, cy) {
  var n = outwardNormal(p1, p2, cx, cy);
  return [[p1[0], p1[1]], [p2[0], p2[1]],
    [p2[0] + n[0]*dist, p2[1] + n[1]*dist], [p1[0] + n[0]*dist, p1[1] + n[1]*dist]];
}

function bufferPolygonRounded(poly, dist, segments) {
  if (!segments) segments = 8;
  var n = poly.length;
  if (n < 3) return poly;
  var c = polyCentroid(poly);
  var result = [];
  for (var i = 0; i < n; i++) {
    var prev = (i - 1 + n) % n;
    var next = (i + 1) % n;
    var n0 = outwardNormal(poly[prev], poly[i], c[0], c[1]);
    var n1 = outwardNormal(poly[i], poly[next], c[0], c[1]);
    var angle0 = Math.atan2(n0[1], n0[0]);
    var angle1 = Math.atan2(n1[1], n1[0]);
    var da = angle1 - angle0;
    if (da > Math.PI) da -= 2 * Math.PI;
    if (da < -Math.PI) da += 2 * Math.PI;
    var px = poly[i][0]; var py = poly[i][1];
    if (Math.abs(da) < 0.01) {
      result.push([px + n0[0]*dist, py + n0[1]*dist]);
    } else {
      var segs = Math.max(2, Math.round(Math.abs(da) / (Math.PI/2) * segments));
      for (var s = 0; s <= segs; s++) {
        var a = angle0 + da * (s / segs);
        result.push([px + Math.cos(a)*dist, py + Math.sin(a)*dist]);
      }
    }
  }
  return result;
}

function offsetChamfered(p1, p2, dist, cx, cy) {
  var dx = p2[0]-p1[0]; var dy = p2[1]-p1[1];
  var len = Math.sqrt(dx*dx+dy*dy);
  if (len < 0.01) return null;
  var tx = dx/len; var ty = dy/len;
  var n = outwardNormal(p1, p2, cx, cy);
  var chamfer = dist * 0.4;
  var maxChamfer = len * 0.45;
  if (chamfer > maxChamfer) chamfer = maxChamfer;
  return [
    [p1[0]+tx*chamfer, p1[1]+ty*chamfer],
    [p2[0]-tx*chamfer, p2[1]-ty*chamfer],
    [p2[0]+n[0]*chamfer, p2[1]+n[1]*chamfer],
    [p2[0]+n[0]*dist-tx*chamfer, p2[1]+n[1]*dist-ty*chamfer],
    [p1[0]+n[0]*dist+tx*chamfer, p1[1]+n[1]*dist+ty*chamfer],
    [p1[0]+n[0]*chamfer, p1[1]+n[1]*chamfer]
  ];
}

function polyMToLL(polyM, proj) {
  var ring = [];
  for (var i = 0; i < polyM.length; i++) ring.push(proj.toLngLat(polyM[i][0], polyM[i][1]));
  ring.push(ring[0]);
  return ring;
}

/**
 * Merge all section footprints on one axis into a single polygon.
 * Sections are sequential: first[a,d] → last[b,c].
 * Merged = [first.a, last.b, last.c, first.d]
 */
function mergeFootprints(fpMs) {
  if (fpMs.length === 0) return null;
  if (fpMs.length === 1) return fpMs[0];
  var first = fpMs[0];
  var last = fpMs[fpMs.length - 1];
  // [a of first, b of last, c of last, d of first]
  return [first[0], last[1], last[2], first[3]];
}

// ── Compute ────────────────────────────────────────────

function computeBuffers() {
  if (!_featureStore) return;
  var all = _featureStore.toArray();
  var sects = [];
  for (var i = 0; i < all.length; i++) {
    if (all[i].properties.type === 'section-axis') sects.push(all[i]);
  }

  var firePolys = []; var endPolys = []; var insolPolys = [];
  if (sects.length === 0) { updateSources(firePolys, endPolys, insolPolys); return; }

  var allCoords = [];
  for (var i = 0; i < sects.length; i++) {
    var c = sects[i].geometry.coordinates;
    for (var j = 0; j < c.length; j++) allCoords.push(c[j]);
  }
  var gc = centroid(allCoords);
  var proj = createProjection(gc[0], gc[1]);

  for (var si = 0; si < sects.length; si++) {
    var storedFP = sects[si].properties.footprints;
    if (!storedFP || storedFP.length === 0) continue;

    // Convert all footprints to meters
    var fpMs = [];
    for (var fi = 0; fi < storedFP.length; fi++) {
      var fpM = [];
      for (var j = 0; j < storedFP[fi].polygon.length; j++) {
        fpM.push(proj.toMeters(storedFP[fi].polygon[j][0], storedFP[fi].polygon[j][1]));
      }
      fpMs.push(fpM);
    }

    // Merge all footprints on this axis into one polygon
    var merged = mergeFootprints(fpMs);
    if (!merged) continue;

    var cx = polyCentroid(merged);

    // Merged polygon: [a, b, c, d]
    // a→b: near long facade
    // b→c: end торец (last section end)
    // c→d: far long facade
    // d→a: start торец (first section start)

    // ── Fire: distance depends on building height ──
    var sectionH = sects[si].properties.sectionHeight || 28;
    var fireDist = sectionH <= 28 ? Math.min(_distances.fire, 11) : _distances.fire;
    firePolys.push(polyMToLL(bufferPolygonRounded(merged, fireDist, 6), proj));

    // ── End: rounded buffer from merged polygon ──
    endPolys.push(polyMToLL(bufferPolygonRounded(merged, _distances.end, 8), proj));

    // ── Insolation: only long facades a→b and c→d ──
    var insolR1 = offsetEdgeOutward(merged[0], merged[1], _distances.insolation, cx[0], cx[1]);
    var insolR2 = offsetEdgeOutward(merged[2], merged[3], _distances.insolation, cx[0], cx[1]);
    insolPolys.push(polyMToLL(insolR1, proj));
    insolPolys.push(polyMToLL(insolR2, proj));

    // Insolation: only long facades, nothing on торцы
  }

  updateSources(firePolys, endPolys, insolPolys);
}

function updateSources(fire, end, insol) {
  var sets = [{ key: 'fire', polys: fire }, { key: 'end', polys: end }, { key: 'insolation', polys: insol }];
  for (var i = 0; i < sets.length; i++) {
    var features = [];
    for (var j = 0; j < sets[i].polys.length; j++) {
      features.push({ type: 'Feature', properties: {},
        geometry: { type: 'Polygon', coordinates: [sets[i].polys[j]] } });
    }
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
function onDistanceChanged(data) {
  if (data.key && data.value !== undefined) { _distances[data.key] = data.value; if (_visible) computeBuffers(); }
}
function onChanged() { if (_visible) computeBuffers(); }

var buffersModule = {
  id: 'buffers',
  init: function (ctx) {
    _mapManager = ctx.mapManager; _featureStore = ctx.featureStore; _eventBus = ctx.eventBus;
    initLayers();
    _unsubs.push(_eventBus.on('buffers:toggle', onToggle));
    _unsubs.push(_eventBus.on('buffers:distance:changed', onDistanceChanged));
    _unsubs.push(_eventBus.on('features:changed', onChanged));
    _unsubs.push(_eventBus.on('draw:section:complete', onChanged));
    _unsubs.push(_eventBus.on('section-gen:params:changed', onChanged));
    console.log('[buffers] initialized');
  },
  destroy: function () { for (var i = 0; i < _unsubs.length; i++) _unsubs[i](); _unsubs = []; _initialized = false; }
};

export default buffersModule;
