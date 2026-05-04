/**
 * Playgrounds module — renders ring-based playground / sports zones
 * per urban block.
 *
 * Zones per block:
 *   A — toddler playground (0-6y, no active play).
 *        Ring 12-20m around sections, ∩ block green zone.
 *   B — active children playground.
 *        Ring 20-40m around sections, ∩ block green zone.
 *   C — sports + adult leisure.
 *        Ring 40-300m around sections, ∩ block only (no green-zone mask).
 *
 * Per-person norms:
 *   Child (A + B):  0.5 m²/person
 *   Sport   (C):    0.1 m²/person
 *
 * Listens to:
 *   - features:changed, draw:section:complete, section-gen:rebuilt
 *     → recompute
 *   - buffers:distance:changed (fire) → recompute (green zone depends
 *     on fire buffer shape)
 *   - section-gen:stats → cache per-axis population (used for per-block
 *     population aggregation)
 *
 * Emits:
 *   - playgrounds:stats:changed {
 *       perBlock: { blockId: { population, areaA, areaB, areaC,
 *                              areaChild, areaSport,
 *                              requiredChild, requiredSport,
 *                              feasibleChild, feasibleSport,
 *                              childDeficit, sportDeficit } },
 *       total: { population, areaA, areaB, areaC, areaChild, areaSport,
 *                requiredChild, requiredSport,
 *                feasibleChild, feasibleSport },
 *       blockOrder: [blockId, ...]
 *     }
 *
 * Always visible on the map when data is present.
 */

import { createProjection } from '../../core/geo/projection.js';
import { computeGreenZone } from '../../core/urban-block/greenzone.js';
import {
  computeBlockPlaygrounds,
  evaluateFeasibility
} from '../../core/urban-block/playgrounds.js';
import { log } from '../../core/Logger.js';

// ── Visual config ─────────────────────────────────────────

// Distinct hues so the three rings read at a glance, and so they
// don't clash with the existing green zone (green) and fire buffer
// (red) layers.
var STYLE = {
  A: { fill: 'rgba(250, 204, 21, 0.40)', line: '#ca8a04' },   // yellow-400
  B: { fill: 'rgba(251, 146, 60, 0.40)', line: '#c2410c' },   // orange-400
  C: { fill: 'rgba(139, 92, 246, 0.22)', line: '#6d28d9' }    // violet-500
};

var SRC = 'playgrounds';
var FILL_A = 'playgrounds-A-fill';
var LINE_A = 'playgrounds-A-line';
var FILL_B = 'playgrounds-B-fill';
var LINE_B = 'playgrounds-B-line';
var FILL_C = 'playgrounds-C-fill';
var LINE_C = 'playgrounds-C-line';

var DEBOUNCE_MS = 140;

// ── State ─────────────────────────────────────────────────

var _mapManager = null;
var _map = null;
var _featureStore = null;
var _eventBus = null;
var _initialized = false;
var _unsubs = [];
var _pendingTimer = null;

// Population per axis (lineId) — populated from section-gen:stats.
// We aggregate per-block by looking up each axis's blockId in the
// feature store.
var _axisPop = {};

// ── Layers ────────────────────────────────────────────────

function initLayers() {
  if (_initialized) return;
  var map = _mapManager.getMap();
  if (!map) return;
  _map = map;
  var empty = { type: 'FeatureCollection', features: [] };
  _mapManager.addGeoJSONSource(SRC, empty);

  // Paint order: C first (largest, background), then B, then A
  // (smallest, foreground). Lines on top of fills in the same group.
  map.addLayer({
    id: FILL_C, type: 'fill', source: SRC,
    filter: ['==', ['get', 'ring'], 'C'],
    paint: { 'fill-color': STYLE.C.fill, 'fill-opacity': 1.0 }
  });
  map.addLayer({
    id: LINE_C, type: 'line', source: SRC,
    filter: ['==', ['get', 'ring'], 'C'],
    paint: { 'line-color': STYLE.C.line, 'line-width': 1.0, 'line-opacity': 0.7 }
  });
  map.addLayer({
    id: FILL_B, type: 'fill', source: SRC,
    filter: ['==', ['get', 'ring'], 'B'],
    paint: { 'fill-color': STYLE.B.fill, 'fill-opacity': 1.0 }
  });
  map.addLayer({
    id: LINE_B, type: 'line', source: SRC,
    filter: ['==', ['get', 'ring'], 'B'],
    paint: { 'line-color': STYLE.B.line, 'line-width': 1.0 }
  });
  map.addLayer({
    id: FILL_A, type: 'fill', source: SRC,
    filter: ['==', ['get', 'ring'], 'A'],
    paint: { 'fill-color': STYLE.A.fill, 'fill-opacity': 1.0 }
  });
  map.addLayer({
    id: LINE_A, type: 'line', source: SRC,
    filter: ['==', ['get', 'ring'], 'A'],
    paint: { 'line-color': STYLE.A.line, 'line-width': 1.0 }
  });

  _initialized = true;
}

function removeLayers() {
  if (!_map) return;
  var ids = [LINE_A, FILL_A, LINE_B, FILL_B, LINE_C, FILL_C];
  for (var i = 0; i < ids.length; i++) {
    if (_map.getLayer(ids[i])) _map.removeLayer(ids[i]);
  }
  if (_map.getSource(SRC)) _map.removeSource(SRC);
}

// ── Grouping helpers (mirrors modules/greenzone/index.js) ──

function mergeConsecutive(fpMs) {
  if (fpMs.length === 0) return null;
  if (fpMs.length === 1) return fpMs[0];
  return [
    fpMs[0][0],
    fpMs[fpMs.length - 1][1],
    fpMs[fpMs.length - 1][2],
    fpMs[0][3]
  ];
}

// ── Collection ───────────────────────────────────────────

function collectSectionsByBlock() {
  var all = _featureStore.toArray();
  var blocks = [];
  var byId = {};
  for (var i = 0; i < all.length; i++) {
    var f = all[i];
    var p = f.properties || {};
    if (p.urbanBlock) {
      blocks.push(f);
    } else if (p.type === 'section-axis' && p.blockId) {
      if (!byId[p.blockId]) byId[p.blockId] = [];
      byId[p.blockId].push(f);
    }
  }
  return { blocks: blocks, byId: byId };
}

/**
 * Collect footprints per urban block, merged per axis.
 *
 * Policy:
 *   - All sections on the same axis share a common playground buffer
 *     (merged into a single rectangle via mergeConsecutive). The
 *     independent/grouped split matters for height distribution, not
 *     for buffer topology.
 *   - Fire buffers are NOT subtracted from the green zone here —
 *     fire buffer is treated as part of the green zone for playground
 *     feasibility, so a playground may sit inside it.
 *
 * Returns { subtract, fpMs }:
 *   subtract — polygons to subtract from block when computing green zone
 *              (= the merged axis footprints, one per axis).
 *   fpMs     — same merged footprints, used for ring generation
 *              (one merged rectangle per axis = one common buffer).
 */
function collectAxisFootprints(sections, proj) {
  var subtract = [];
  var fpMs = [];

  for (var si = 0; si < sections.length; si++) {
    var feature = sections[si];
    var storedFP = feature.properties.footprints;
    if (!storedFP || storedFP.length === 0) continue;

    var axisFpMs = [];
    for (var fi = 0; fi < storedFP.length; fi++) {
      var poly = storedFP[fi].polygon;
      if (!poly || poly.length < 3) continue;
      var fpM = [];
      for (var j = 0; j < poly.length; j++) {
        fpM.push(proj.toMeters(poly[j][0], poly[j][1]));
      }
      axisFpMs.push(fpM);
    }

    if (axisFpMs.length === 0) continue;

    var merged = mergeConsecutive(axisFpMs);
    if (!merged) continue;
    subtract.push(merged);
    fpMs.push(merged);
  }

  return { subtract: subtract, fpMs: fpMs };
}

// ── Main compute ──────────────────────────────────────────

function ringMpToLLFeatures(mp, proj, props) {
  // Convert a polygon-clipping MultiPolygon back to GeoJSON Polygon
  // features in lngLat. One Feature per outer ring (keeps feature
  // count reasonable and avoids MultiPolygon edge cases downstream).
  var features = [];
  for (var pi = 0; pi < mp.length; pi++) {
    var poly = mp[pi];
    if (!poly || poly.length === 0) continue;
    var ringsLL = [];
    for (var ri = 0; ri < poly.length; ri++) {
      var ringM = poly[ri];
      if (!ringM || ringM.length < 3) continue;
      var ringLL = [];
      for (var k = 0; k < ringM.length; k++) {
        ringLL.push(proj.toLngLat(ringM[k][0], ringM[k][1]));
      }
      // Ensure closed
      if (ringLL.length > 1) {
        var a = ringLL[0], b = ringLL[ringLL.length - 1];
        if (a[0] !== b[0] || a[1] !== b[1]) ringLL.push([a[0], a[1]]);
      }
      ringsLL.push(ringLL);
    }
    if (ringsLL.length === 0) continue;
    features.push({
      type: 'Feature',
      properties: props,
      geometry: { type: 'Polygon', coordinates: ringsLL }
    });
  }
  return features;
}

function populationForBlock(sections) {
  var pop = 0;
  for (var i = 0; i < sections.length; i++) {
    var lineId = sections[i].properties && sections[i].properties.id;
    if (lineId && typeof _axisPop[lineId] === 'number') {
      pop += _axisPop[lineId];
    }
  }
  return pop;
}

function computeAll() {
  if (!_featureStore || !_mapManager) return;

  var collected = collectSectionsByBlock();
  var blocks = collected.blocks;

  if (blocks.length === 0) {
    publish({ type: 'FeatureCollection', features: [] }, {}, [], emptyTotal());
    return;
  }

  var allFeatures = [];
  var perBlock = {};
  var blockOrder = [];
  var totalPop = 0, totA = 0, totB = 0, totC = 0;

  for (var bi = 0; bi < blocks.length; bi++) {
    var block = blocks[bi];
    var blockId = block.properties.id;
    var coords = block.geometry
      && block.geometry.coordinates
      && block.geometry.coordinates[0];
    if (!coords || coords.length < 4) continue;

    var n = coords.length;
    var isClosed = (n > 1
      && coords[0][0] === coords[n - 1][0]
      && coords[0][1] === coords[n - 1][1]);
    var stop = isClosed ? n - 1 : n;

    // Local projection centred on block centroid — same rationale as
    // the greenzone module: a per-block proj keeps meter-space accurate
    // for large blocks far from the global origin.
    var cLng = 0, cLat = 0;
    for (var k = 0; k < stop; k++) { cLng += coords[k][0]; cLat += coords[k][1]; }
    cLng /= stop; cLat /= stop;
    var proj = createProjection(cLng, cLat);

    var blockPolyM = [];
    for (var k2 = 0; k2 < stop; k2++) {
      blockPolyM.push(proj.toMeters(coords[k2][0], coords[k2][1]));
    }

    var sects = collected.byId[blockId] || [];
    var sub = collectAxisFootprints(sects, proj);

    // Green zone for this block (shared with the greenzone module —
    // we duplicate the computation here rather than consume its
    // output because that module only publishes areas, not polygons).
    var gz = computeGreenZone(blockPolyM, sub.subtract);

    var pg = computeBlockPlaygrounds(blockPolyM, sub.fpMs, gz.multiPolygon);

    var pop = populationForBlock(sects);
    var feas = evaluateFeasibility({
      areaA: pg.ringA.area,
      areaB: pg.ringB.area,
      areaC: pg.ringC.area
    }, pop);

    perBlock[blockId] = {
      population: pop,
      areaA: pg.ringA.area,
      areaB: pg.ringB.area,
      areaC: pg.ringC.area,
      areaChild: feas.areaChild,
      areaSport: feas.areaSport,
      requiredChild: feas.requiredChild,
      requiredSport: feas.requiredSport,
      feasibleChild: feas.feasibleChild,
      feasibleSport: feas.feasibleSport,
      childDeficit: feas.childDeficit,
      sportDeficit: feas.sportDeficit
    };
    blockOrder.push(blockId);
    totalPop += pop;
    totA += pg.ringA.area;
    totB += pg.ringB.area;
    totC += pg.ringC.area;

    // Render polygons.
    var fsA = ringMpToLLFeatures(pg.ringA.mp, proj, { blockId: blockId, ring: 'A' });
    var fsB = ringMpToLLFeatures(pg.ringB.mp, proj, { blockId: blockId, ring: 'B' });
    var fsC = ringMpToLLFeatures(pg.ringC.mp, proj, { blockId: blockId, ring: 'C' });
    for (var ai = 0; ai < fsA.length; ai++) allFeatures.push(fsA[ai]);
    for (var bj = 0; bj < fsB.length; bj++) allFeatures.push(fsB[bj]);
    for (var ci = 0; ci < fsC.length; ci++) allFeatures.push(fsC[ci]);
  }

  var total = {
    population: totalPop,
    areaA: totA, areaB: totB, areaC: totC,
    areaChild: totA + totB,
    areaSport: totC,
    requiredChild: totalPop * 0.5,
    requiredSport: totalPop * 0.1,
    feasibleChild: (totA + totB) >= totalPop * 0.5,
    feasibleSport: totC >= totalPop * 0.1
  };

  publish({ type: 'FeatureCollection', features: allFeatures },
    perBlock, blockOrder, total);
}

function emptyTotal() {
  return {
    population: 0, areaA: 0, areaB: 0, areaC: 0,
    areaChild: 0, areaSport: 0,
    requiredChild: 0, requiredSport: 0,
    feasibleChild: true, feasibleSport: true
  };
}

function publish(fc, perBlock, blockOrder, total) {
  if (_mapManager) _mapManager.updateGeoJSONSource(SRC, fc);
  if (_eventBus) {
    _eventBus.emit('playgrounds:stats:changed', {
      perBlock: perBlock,
      total: total,
      blockOrder: blockOrder
    });
  }
}

// ── Event handlers ────────────────────────────────────────

function scheduleCompute() {
  if (_pendingTimer) clearTimeout(_pendingTimer);
  _pendingTimer = setTimeout(function () {
    _pendingTimer = null;
    try {
      computeAll();
    } catch (err) {
      log.warn('[playgrounds] compute failed:', err);
    }
  }, DEBOUNCE_MS);
}

function onSectionStats(allStats) {
  if (!allStats || !allStats.sections) return;
  // Aggregate population per lineId (axisId).
  _axisPop = {};
  for (var i = 0; i < allStats.sections.length; i++) {
    var s = allStats.sections[i];
    var id = s.axisId;
    if (!id) continue;
    _axisPop[id] = (_axisPop[id] || 0) + (s.population || 0);
  }
  scheduleCompute();
}

function onChanged() { scheduleCompute(); }

// ── Module interface ──────────────────────────────────────

var playgroundsModule = {
  id: 'playgrounds',

  init: function (ctx) {
    _mapManager = ctx.mapManager;
    _featureStore = ctx.featureStore;
    _eventBus = ctx.eventBus;

    initLayers();

    _unsubs.push(_eventBus.on('features:changed', onChanged));
    _unsubs.push(_eventBus.on('draw:section:complete', onChanged));
    _unsubs.push(_eventBus.on('section-gen:rebuilt', onChanged));
    _unsubs.push(_eventBus.on('section-gen:stats', onSectionStats));

    log.debug('[playgrounds] initialized');
  },

  destroy: function () {
    if (_pendingTimer) clearTimeout(_pendingTimer);
    for (var i = 0; i < _unsubs.length; i++) _unsubs[i]();
    _unsubs = [];
    removeLayers();
    _mapManager = null; _featureStore = null; _eventBus = null;
    _initialized = false;
  }
};

export default playgroundsModule;
