/**
 * Section Gen — uses stored lng/lat footprints, only type='section-axis'
 * Fixes: axis orientation matches footprint side, internal dividers only
 */

import { createProjection, centroid } from '../urban-block/projection.js';
import {
  createNearCells, createFarCells, createCorridorCells,
  getNorthSide, getLLUParams, getCentralIndices
} from './cells.js';
import { buildSectionGraph, computeFloorCount } from './graph.js';
import { SectionGenLayer } from './SectionGenLayer.js';
import { buildSectionMeshes, buildDividerWall } from '../../core/three/MeshBuilder.js';

var TYPE_COLORS = { apartment: '#dce8f0', commercial: '#ffb74d', corridor: '#c8c8c8', llu: '#4f81bd' };
var DEFAULT_PARAMS = {
  sectionWidth: 18.0, corridorWidth: 2.0, cellWidth: 3.3,
  sectionHeight: 15, firstFloorHeight: 4.5, typicalFloorHeight: 3.0
};

var _layer, _threeOverlay, _eventBus, _featureStore, _mapManager;
var _unsubs = [];
var _lineFootprints = {};
var _highlightedIds = [];
var _clickWired = false;

function getParams(f) {
  var p = {};
  for (var k in DEFAULT_PARAMS) {
    if (DEFAULT_PARAMS.hasOwnProperty(k))
      p[k] = f.properties[k] !== undefined ? f.properties[k] : DEFAULT_PARAMS[k];
  }
  return p;
}

function closeRing(polyLL) {
  var ring = polyLL.slice();
  ring.push(ring[0]);
  return ring;
}

/**
 * unitNormal(a,b) returns left perpendicular of a→b.
 * Check if it points toward footprint corner d.
 * If not, reverse axis so cells are built on correct side.
 */
function orientAxis(fpM) {
  var a = fpM[0]; var b = fpM[1]; var d = fpM[3];
  var dx = b[0] - a[0]; var dy = b[1] - a[1];
  var len = Math.sqrt(dx * dx + dy * dy);
  if (len < 1e-10) return [a, b];

  // left perpendicular of a→b
  var nx = -dy / len;
  var ny = dx / len;

  // direction from a to d (where section extends)
  var tdx = d[0] - a[0];
  var tdy = d[1] - a[1];

  // dot product: if positive, cells will go toward d (correct)
  var dot = nx * tdx + ny * tdy;
  if (dot >= 0) return [a, b];
  // reverse axis so unitNormal points toward d
  return [b, a];
}

function setupClickHandler() {
  if (_clickWired) return;
  var map = _mapManager.getMap();
  if (!map) return;
  map.on('click', _layer.getClickLayerId(), function (e) {
    if (e.features && e.features.length > 0) {
      var lid = e.features[0].properties.lineId;
      if (lid) _eventBus.emit('feature:selected', { id: lid });
    }
  });
  map.on('mouseenter', _layer.getClickLayerId(), function () { _mapManager.setCursor('pointer'); });
  map.on('mouseleave', _layer.getClickLayerId(), function () { _mapManager.setCursor('grab'); });
  _clickWired = true;
}

function processAllSections() {
  if (!_layer || !_featureStore) return;
  var all = _featureStore.toArray();
  var sects = [];
  for (var i = 0; i < all.length; i++) {
    if (all[i].properties.type === 'section-axis') sects.push(all[i]);
  }

  if (_threeOverlay) _threeOverlay.clear();
  if (sects.length === 0) { _layer.clear(); _lineFootprints = {}; return; }

  var allCoords = [];
  for (var i = 0; i < sects.length; i++) {
    var c = sects[i].geometry.coordinates;
    for (var j = 0; j < c.length; j++) allCoords.push(c[j]);
  }
  var gc = centroid(allCoords);
  var globalProj = createProjection(gc[0], gc[1]);
  if (_threeOverlay) _threeOverlay.setOrigin(gc[0], gc[1]);

  var allCellsLL = [];
  var allFootLL = [];
  _lineFootprints = {};

  for (var si = 0; si < sects.length; si++) {
    var feature = sects[si];
    var lineId = feature.properties.id;
    var storedFP = feature.properties.footprints;
    if (!storedFP || storedFP.length === 0) continue;

    var params = getParams(feature);
    var apartmentDepth = (params.sectionWidth - params.corridorWidth) / 2.0;
    var floorCount = computeFloorCount(params.sectionHeight, params.firstFloorHeight, params.typicalFloorHeight);
    var renderFloors = Math.min(floorCount, 2);
    var totalH = params.firstFloorHeight;
    if (renderFloors > 1) totalH = params.firstFloorHeight + params.typicalFloorHeight;

    var lineFPsLL = [];

    for (var fi = 0; fi < storedFP.length; fi++) {
      var fp = storedFP[fi];
      var fpRing = closeRing(fp.polygon);
      lineFPsLL.push({ ring: fpRing, lineId: lineId });
      allFootLL.push({ ring: fpRing, lineId: lineId });

      // Convert to meters
      var fpM = [];
      for (var j = 0; j < fp.polygon.length; j++) {
        fpM.push(globalProj.toMeters(fp.polygon[j][0], fp.polygon[j][1]));
      }

      // Orient axis so cells go toward the correct side of footprint
      var sectionAxis = orientAxis(fpM);

      var nearCells = createNearCells(sectionAxis, params.cellWidth, apartmentDepth);
      var farCells = createFarCells(sectionAxis, params.cellWidth, apartmentDepth,
                                     apartmentDepth + params.corridorWidth);
      var corridorCells = createCorridorCells(sectionAxis, params.cellWidth,
                                               params.corridorWidth, apartmentDepth);
      var N = nearCells.length;
      if (N === 0) continue;

      var northSide = getNorthSide(sectionAxis);
      var lluParams = getLLUParams(params.sectionHeight);
      var lluIndices = getCentralIndices(lluParams.count, N);
      var graph = buildSectionGraph(N, nearCells, farCells, corridorCells,
        northSide, lluIndices, lluParams.tag, renderFloors);

      for (var key in graph.nodes) {
        if (!graph.nodes.hasOwnProperty(key)) continue;
        var node = graph.nodes[key];
        if (node.floor !== 1) continue;
        var poly = node.polygon;
        if (!poly || poly.length < 3) continue;
        var ring = [];
        for (var j = 0; j < poly.length; j++) {
          ring.push(globalProj.toLngLat(poly[j][0], poly[j][1]));
        }
        ring.push(ring[0]);
        var color = TYPE_COLORS[node.type] || '#cccccc';
        var label = node.type === 'llu' ? 'LLU ' + (node.lluTag || '') : String(node.cellId);
        allCellsLL.push({ ring: ring, color: color, label: label });
      }

      if (_threeOverlay) {
        _threeOverlay.addMesh(buildSectionMeshes(
          graph.nodes, renderFloors - 1, params.firstFloorHeight, params.typicalFloorHeight, 0.08));
      }

      // Internal divider walls — only between adjacent sections, not at ends
      if (_threeOverlay && fi > 0) {
        // Divider between section fi-1 and fi: at start of fi (edge d→a of current fp)
        var prevFP = storedFP[fi - 1];
        var prevM = [];
        for (var j = 0; j < prevFP.polygon.length; j++) {
          prevM.push(globalProj.toMeters(prevFP.polygon[j][0], prevFP.polygon[j][1]));
        }
        // Shared boundary: end of prev section (b→c) = start of current (d→a)
        // Use current section's d→a edge
        var wallP1 = fpM[3];
        var wallP2 = fpM[0];
        var wall = buildDividerWall(wallP1, wallP2, 0, totalH + 0.05, 0.12);
        _threeOverlay.addMesh(wall);
      }
    }
    _lineFootprints[lineId] = lineFPsLL;
  }

  _layer.update(allCellsLL, allFootLL);
  setupClickHandler();
}

function mergeGraphs(graphs) {
  var merged = { nodes: {}, edges: [] };
  for (var gi = 0; gi < graphs.length; gi++) {
    var g = graphs[gi];
    var prefix = 's' + gi + '_';
    for (var key in g.nodes) {
      if (!g.nodes.hasOwnProperty(key)) continue;
      merged.nodes[prefix + key] = g.nodes[key];
    }
    for (var ei = 0; ei < g.edges.length; ei++) {
      var e = g.edges[ei];
      merged.edges.push({ from: prefix + e.from, to: prefix + e.to, type: e.type });
    }
  }
  return merged;
}

function highlightIds(ids) {
  if (!_layer) return;
  var allFps = [];
  for (var i = 0; i < ids.length; i++) {
    var fps = _lineFootprints[ids[i]];
    if (fps) { for (var j = 0; j < fps.length; j++) allFps.push(fps[j]); }
  }
  if (allFps.length > 0) _layer.highlightRaw(allFps);
  else _layer.clearHighlight();
}

function onSelected(d) { _highlightedIds = [d.id]; highlightIds(_highlightedIds); }
function onMultiselect(d) {
  var idx = _highlightedIds.indexOf(d.id);
  if (idx >= 0) _highlightedIds.splice(idx, 1);
  else _highlightedIds.push(d.id);
  highlightIds(_highlightedIds);
}
function onDeselected() { _highlightedIds = []; if (_layer) _layer.clearHighlight(); }
function onChanged() { processAllSections(); }

var sectionGenModule = {
  id: 'section-gen',
  init: function (ctx) {
    _eventBus = ctx.eventBus; _featureStore = ctx.featureStore;
    _mapManager = ctx.mapManager; _threeOverlay = ctx.threeOverlay || null;
    _layer = new SectionGenLayer(ctx.mapManager); _layer.init();
    _unsubs.push(_eventBus.on('draw:section:complete', onChanged));
    _unsubs.push(_eventBus.on('features:changed', onChanged));
    _unsubs.push(_eventBus.on('section-gen:params:changed', onChanged));
    _unsubs.push(_eventBus.on('feature:selected', onSelected));
    _unsubs.push(_eventBus.on('feature:multiselect', onMultiselect));
    _unsubs.push(_eventBus.on('feature:deselected', onDeselected));
    console.log('[section-gen] initialized');
  },
  destroy: function () {
    for (var i = 0; i < _unsubs.length; i++) { _unsubs[i](); }
    _unsubs = [];
    if (_threeOverlay) _threeOverlay.clear();
    if (_layer) { _layer.destroy(); _layer = null; }
    _eventBus = null; _featureStore = null; _mapManager = null;
    _threeOverlay = null; _lineFootprints = {}; _highlightedIds = []; _clickWired = false;
  }
};

export default sectionGenModule;
