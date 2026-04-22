/**
 * GreenZone module — renders usable open space inside urban blocks.
 *
 * For every urban-block polygon, subtracts:
 *   - its section footprints, and
 *   - their fire buffers (same grouping rule as modules/buffers —
 *     consecutive equal-height footprints form one group rect;
 *     independent-height footprints each emit their own buffer).
 *
 * The remainder is drawn as a semi-transparent green polygon on the
 * map and its total area is published via 'greenzone:area:changed'
 * so StatsPanel can display it alongside footprint / GBA / population.
 *
 * Listens to:
 *   - features:changed, draw:section:complete, section-gen:rebuilt
 *     → recompute (blocks or sections were added/removed/rebuilt)
 *   - buffers:distance:changed (key='fire')
 *     → fire distance changed, recompute (debounced)
 *
 * Emits:
 *   - greenzone:area:changed { totalArea, perBlock: { blockId: area } }
 *
 * No toggle — always visible when blocks are present.
 */

import { createProjection } from '../../core/geo/projection.js';
import { buildGroupBuffers, FIRE_DIST } from '../../core/buffers/Buffers.js';
import { computeGreenZone } from '../../core/urban-block/greenzone.js';
import { log } from '../../core/Logger.js';

// ── Visual config ─────────────────────────────────────────

var STYLE = {
  fill: 'rgba(34, 197, 94, 0.28)',  // green-500 @ 28%
  line: '#15803d'                    // green-700
};

var SOURCE = 'greenzone';
var FILL_LAYER = 'greenzone-fill';
var LINE_LAYER = 'greenzone-line';

var DEBOUNCE_MS = 120;

// ── State ─────────────────────────────────────────────────

var _map = null;
var _mapManager = null;
var _featureStore = null;
var _eventBus = null;
var _fireDist = FIRE_DIST;
var _initialized = false;
var _unsubs = [];
var _pendingTimer = null;

// ── MapLibre layers ───────────────────────────────────────

function initLayers() {
  if (_initialized) return;
  var map = _mapManager.getMap();
  if (!map) return;
  _map = map;
  var empty = { type: 'FeatureCollection', features: [] };
  _mapManager.addGeoJSONSource(SOURCE, empty);
  map.addLayer({
    id: FILL_LAYER, type: 'fill', source: SOURCE,
    paint: { 'fill-color': STYLE.fill, 'fill-opacity': 1.0 }
  });
  map.addLayer({
    id: LINE_LAYER, type: 'line', source: SOURCE,
    paint: { 'line-color': STYLE.line, 'line-width': 1.2 }
  });
  _initialized = true;
}

function removeLayers() {
  if (!_map) return;
  if (_map.getLayer(LINE_LAYER)) _map.removeLayer(LINE_LAYER);
  if (_map.getLayer(FILL_LAYER)) _map.removeLayer(FILL_LAYER);
  if (_map.getSource(SOURCE)) _map.removeSource(SOURCE);
}

// ── Grouping (mirrors modules/buffers/index.js) ──────────

function mergeConsecutive(fpMs) {
  // A run of equal-height footprints acts as a single rectangle:
  // the long sides of the first and last footprint form the long
  // sides of the merged group rect. Short sides cap the run.
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
 * Build the full list of polygons to subtract from one block's
 * polygon: footprints (each one) + fire buffers (per group rect).
 */
function buildSubtractForBlock(sections, proj) {
  var subtract = [];

  for (var si = 0; si < sections.length; si++) {
    var feature = sections[si];
    var storedFP = feature.properties.footprints;
    if (!storedFP || storedFP.length === 0) continue;

    // Footprints in meters.
    var fpMs = [];
    for (var fi = 0; fi < storedFP.length; fi++) {
      var fpM = [];
      var poly = storedFP[fi].polygon;
      for (var j = 0; j < poly.length; j++) {
        fpM.push(proj.toMeters(poly[j][0], poly[j][1]));
      }
      fpMs.push(fpM);
      // Each footprint itself is subtracted.
      subtract.push(fpM);
    }

    // Separate footprints that carry their own sectionHeight (independent)
    // from shared-height ones (grouped into runs).
    var grouped = [];
    var independent = [];
    for (var fi2 = 0; fi2 < storedFP.length; fi2++) {
      if (storedFP[fi2].sectionHeight !== undefined) independent.push(fi2);
      else grouped.push(fi2);
    }

    // Independent → each gets its own fire buffer.
    for (var ii = 0; ii < independent.length; ii++) {
      var gb = buildGroupBuffers(fpMs[independent[ii]], {
        fire: _fireDist, insol: 0, end: 0, road: 0
      });
      for (var gbi = 0; gbi < gb.length; gbi++) {
        if (gb[gbi].type === 'fire') subtract.push(gb[gbi].polygon);
      }
    }

    // Grouped → consecutive runs merged via mergeConsecutive.
    if (grouped.length > 0) {
      var runs = [];
      var cur = [grouped[0]];
      for (var gi = 1; gi < grouped.length; gi++) {
        if (grouped[gi] === grouped[gi - 1] + 1) cur.push(grouped[gi]);
        else { runs.push(cur); cur = [grouped[gi]]; }
      }
      runs.push(cur);

      for (var ri = 0; ri < runs.length; ri++) {
        var runFpMs = [];
        for (var rfi = 0; rfi < runs[ri].length; rfi++) {
          runFpMs.push(fpMs[runs[ri][rfi]]);
        }
        var merged = mergeConsecutive(runFpMs);
        if (!merged) continue;
        var gb2 = buildGroupBuffers(merged, {
          fire: _fireDist, insol: 0, end: 0, road: 0
        });
        for (var fbi = 0; fbi < gb2.length; fbi++) {
          if (gb2[fbi].type === 'fire') subtract.push(gb2[fbi].polygon);
        }
      }
    }
  }

  return subtract;
}

// ── Main compute ──────────────────────────────────────────

function ringMToLL(ringM, proj) {
  var out = [];
  for (var i = 0; i < ringM.length; i++) {
    out.push(proj.toLngLat(ringM[i][0], ringM[i][1]));
  }
  return out;
}

function computeAll() {
  if (!_featureStore || !_mapManager) return;

  var collected = collectSectionsByBlock();
  var blocks = collected.blocks;

  if (blocks.length === 0) {
    publish({ type: 'FeatureCollection', features: [] }, 0, {}, []);
    return;
  }

  var features = [];
  var totalArea = 0;
  var perBlock = {};
  // Preserve creation order explicitly — Object key order is spec'd
  // in modern JS but consumers (StatsPanel) should never rely on it
  // when a real sequence is needed. blockOrder is that sequence.
  var blockOrder = [];

  for (var bi = 0; bi < blocks.length; bi++) {
    var block = blocks[bi];
    var blockId = block.properties.id;
    var coords = block.geometry
      && block.geometry.coordinates
      && block.geometry.coordinates[0];
    if (!coords || coords.length < 4) continue;

    // Drop closing point if present (shoelace and centroid on open ring).
    var n = coords.length;
    var isClosed = (n > 1
      && coords[0][0] === coords[n - 1][0]
      && coords[0][1] === coords[n - 1][1]);
    var stop = isClosed ? n - 1 : n;

    // Local projection centered on block centroid — accuracy boost
    // for large blocks far from the existing global origin.
    var cLng = 0, cLat = 0;
    for (var k = 0; k < stop; k++) { cLng += coords[k][0]; cLat += coords[k][1]; }
    cLng /= stop; cLat /= stop;
    var proj = createProjection(cLng, cLat);

    var blockPolyM = [];
    for (var k2 = 0; k2 < stop; k2++) {
      blockPolyM.push(proj.toMeters(coords[k2][0], coords[k2][1]));
    }

    var sects = collected.byId[blockId] || [];
    var subtract = buildSubtractForBlock(sects, proj);

    var gz = computeGreenZone(blockPolyM, subtract);
    totalArea += gz.area;
    perBlock[blockId] = gz.area;
    blockOrder.push(blockId);

    // Convert each resulting polygon back to lng/lat for MapLibre.
    for (var pi = 0; pi < gz.multiPolygon.length; pi++) {
      var poly = gz.multiPolygon[pi];
      if (!poly || poly.length === 0) continue;

      var ringsLL = [];
      for (var ri2 = 0; ri2 < poly.length; ri2++) {
        var ringM = poly[ri2];
        if (!ringM || ringM.length < 3) continue;
        var ringLL = ringMToLL(ringM, proj);
        if (ringLL.length === 0) continue;
        // MapLibre wants closed rings — polygon-clipping produces them
        // already, but guard against unexpected input.
        var a = ringLL[0];
        var b = ringLL[ringLL.length - 1];
        if (a[0] !== b[0] || a[1] !== b[1]) ringLL.push([a[0], a[1]]);
        ringsLL.push(ringLL);
      }
      if (ringsLL.length === 0) continue;

      features.push({
        type: 'Feature',
        properties: { blockId: blockId, area: perBlock[blockId] },
        geometry: { type: 'Polygon', coordinates: ringsLL }
      });
    }
  }

  publish({ type: 'FeatureCollection', features: features }, totalArea, perBlock, blockOrder);
}

function publish(fc, totalArea, perBlock, blockOrder) {
  if (_mapManager) _mapManager.updateGeoJSONSource(SOURCE, fc);
  if (_eventBus) {
    _eventBus.emit('greenzone:area:changed', {
      totalArea: totalArea,
      perBlock: perBlock,
      blockOrder: blockOrder || []
    });
  }
}

// ── Event handlers ────────────────────────────────────────

function scheduleCompute() {
  // Burst-protection: urban-block creation fires features:changed
  // once per feature (block polygon + N axis features) through the
  // CompoundCommand. Slider drags produce a stream of distance-changed
  // events. One polygon-clipping pass is enough — debounce the burst.
  if (_pendingTimer) clearTimeout(_pendingTimer);
  _pendingTimer = setTimeout(function () {
    _pendingTimer = null;
    try {
      computeAll();
    } catch (err) {
      log.warn('[greenzone] compute failed:', err);
    }
  }, DEBOUNCE_MS);
}

function onDistanceChanged(d) {
  if (!d || d.key !== 'fire' || d.value == null) return;
  _fireDist = d.value;
  scheduleCompute();
}

function onChanged() { scheduleCompute(); }

// ── Module interface ──────────────────────────────────────

var greenzoneModule = {
  id: 'greenzone',

  init: function (ctx) {
    _mapManager = ctx.mapManager;
    _featureStore = ctx.featureStore;
    _eventBus = ctx.eventBus;

    initLayers();

    _unsubs.push(_eventBus.on('features:changed', onChanged));
    _unsubs.push(_eventBus.on('draw:section:complete', onChanged));
    _unsubs.push(_eventBus.on('section-gen:rebuilt', onChanged));
    _unsubs.push(_eventBus.on('buffers:distance:changed', onDistanceChanged));

    // Seed fire distance from the global snapshot written by app.js
    // at bootstrap. BufferPanel is the single source of truth and its
    // default will also arrive via the initial emit below.
    try {
      if (typeof window !== 'undefined'
          && window.__UB_BUFFER_DISTS__
          && typeof window.__UB_BUFFER_DISTS__.fire === 'number') {
        _fireDist = window.__UB_BUFFER_DISTS__.fire;
      }
    } catch (_e) { /* no-op */ }

    // Initial render — if anything is already in the store.
    scheduleCompute();

    log.debug('[greenzone] initialized');
  },

  destroy: function () {
    if (_pendingTimer) { clearTimeout(_pendingTimer); _pendingTimer = null; }
    for (var i = 0; i < _unsubs.length; i++) _unsubs[i]();
    _unsubs = [];
    removeLayers();
    _map = null; _mapManager = null; _featureStore = null; _eventBus = null;
    _initialized = false;
  }
};

export default greenzoneModule;
