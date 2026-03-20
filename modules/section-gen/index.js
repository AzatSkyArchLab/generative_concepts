/**
 * Section Gen Module — Three.js 3D + MapLibre 2D plan
 */

import { createProjection, centroid } from '../urban-block/projection.js';
import { classifyPolyline } from '../section-distributor/orientation.js';
import { getSectionLengths, createSectionSequence, placeSections, polylineLength }
  from '../section-distributor/distributor.js';
import {
  createNearCells, createFarCells, createCorridorCells,
  getNorthSide, getLLUParams, getCentralIndices
} from './cells.js';
import { buildSectionGraph, computeFloorCount } from './graph.js';
import { SectionGenLayer } from './SectionGenLayer.js';
import { buildSectionMeshes, buildSectionFrame } from '../../core/three/MeshBuilder.js';

var _params = {
  sectionWidth: 18.0,
  corridorWidth: 2.0,
  cellWidth: 3.3,
  sectionHeight: 15,
  firstFloorHeight: 4.5,
  typicalFloorHeight: 3.0
};

var _layer = null;
var _threeOverlay = null;
var _eventBus = null;
var _featureStore = null;
var _mapManager = null;
var _unsubs = [];
var _lineFootprints = {};
var _globalProj = null;
var _clickWired = false;

function unitNormal(p1, p2) {
  var dx = p2[0] - p1[0];
  var dy = p2[1] - p1[1];
  var len = Math.sqrt(dx * dx + dy * dy);
  if (len < 1e-10) return [0, 0];
  return [-dy / len, dx / len];
}

function sectionFootprint(startM, endM, sectionWidth) {
  var n = unitNormal(startM, endM);
  var ox = n[0] * sectionWidth;
  var oy = n[1] * sectionWidth;
  return [startM, endM, [endM[0] + ox, endM[1] + oy], [startM[0] + ox, startM[1] + oy]];
}

function setupClickHandler() {
  if (_clickWired) return;
  var map = _mapManager.getMap();
  if (!map) return;
  var clickLayerId = _layer.getClickLayerId();
  map.on('click', clickLayerId, function (e) {
    if (e.features && e.features.length > 0) {
      var lineId = e.features[0].properties.lineId;
      if (lineId) _eventBus.emit('feature:selected', { id: lineId });
    }
  });
  map.on('mouseenter', clickLayerId, function () { _mapManager.setCursor('pointer'); });
  map.on('mouseleave', clickLayerId, function () { _mapManager.setCursor('grab'); });
  _clickWired = true;
}

function processAllLines() {
  if (!_layer || !_featureStore) return;

  var all = _featureStore.toArray();
  var lines = [];
  for (var i = 0; i < all.length; i++) {
    if (all[i].geometry.type === 'LineString') lines.push(all[i]);
  }

  if (_threeOverlay) _threeOverlay.clear();

  if (lines.length === 0) {
    _layer.clear();
    _lineFootprints = {};
    _globalProj = null;
    return;
  }

  var allGraphs = [];
  var allFootprints = [];
  _lineFootprints = {};
  var apartmentDepth = (_params.sectionWidth - _params.corridorWidth) / 2.0;
  var floorCount = computeFloorCount(_params.sectionHeight, _params.firstFloorHeight, _params.typicalFloorHeight);
  var renderFloors = Math.min(floorCount, 2);

  // Total height for frames
  var totalHeight = _params.firstFloorHeight;
  if (renderFloors > 1) {
    totalHeight = _params.firstFloorHeight + _params.typicalFloorHeight;
  }

  var allCoords = [];
  for (var li = 0; li < lines.length; li++) {
    var coords = lines[li].geometry.coordinates;
    for (var ci = 0; ci < coords.length; ci++) allCoords.push(coords[ci]);
  }
  var gc = centroid(allCoords);
  _globalProj = createProjection(gc[0], gc[1]);

  if (_threeOverlay) {
    _threeOverlay.setOrigin(gc[0], gc[1]);
  }

  for (var li = 0; li < lines.length; li++) {
    var lineFeature = lines[li];
    var lineId = lineFeature.properties.id;
    var coords = lineFeature.geometry.coordinates;
    if (coords.length < 2) continue;

    var coordsM = [];
    for (var ci = 0; ci < coords.length; ci++) {
      coordsM.push(_globalProj.toMeters(coords[ci][0], coords[ci][1]));
    }

    var totalLen = polylineLength(coordsM);
    if (totalLen < 1) continue;

    var ori = classifyPolyline(coordsM);
    var sectionLengths = getSectionLengths(ori.orientation);
    var minSL = Infinity;
    for (var si = 0; si < sectionLengths.length; si++) {
      if (sectionLengths[si] < minSL) minSL = sectionLengths[si];
    }
    if (totalLen < minSL) continue;

    var sequence = createSectionSequence(sectionLengths, totalLen);
    var sections = placeSections(coordsM, sequence, totalLen);
    var lineFootprintsList = [];

    for (var si = 0; si < sections.length; si++) {
      var sec = sections[si];
      if (sec.isGap) continue;

      var sectionAxis = [sec.startM, sec.endM];
      var fp = sectionFootprint(sec.startM, sec.endM, _params.sectionWidth);
      var fpObj = { polygon: fp, lineId: lineId };
      lineFootprintsList.push(fpObj);
      allFootprints.push(fpObj);

      var nearCells = createNearCells(sectionAxis, _params.cellWidth, apartmentDepth);
      var farCells = createFarCells(sectionAxis, _params.cellWidth, apartmentDepth,
                                     apartmentDepth + _params.corridorWidth);
      var corridorCells = createCorridorCells(sectionAxis, _params.cellWidth,
                                               _params.corridorWidth, apartmentDepth);

      var N = nearCells.length;
      if (N === 0) continue;

      var northSide = getNorthSide(sectionAxis);
      var lluParams = getLLUParams(_params.sectionHeight);
      var lluIndices = getCentralIndices(lluParams.count, N);

      var graph = buildSectionGraph(
        N, nearCells, farCells, corridorCells,
        northSide, lluIndices, lluParams.tag, renderFloors
      );

      for (var key in graph.nodes) {
        if (graph.nodes.hasOwnProperty(key)) graph.nodes[key].lineId = lineId;
      }

      allGraphs.push(graph);

      // Three.js: cell bricks
      if (_threeOverlay) {
        var meshGroup = buildSectionMeshes(
          graph.nodes, renderFloors - 1,
          _params.firstFloorHeight, _params.typicalFloorHeight, 0.08
        );
        _threeOverlay.addMesh(meshGroup);

        // Three.js: dark frame around section perimeter
        var frame = buildSectionFrame(fp, 0, totalHeight);
        _threeOverlay.addMesh(frame);
      }
    }
    _lineFootprints[lineId] = lineFootprintsList;
  }

  var merged = mergeGraphs(allGraphs);
  _layer.update(merged, allFootprints, _globalProj);
  setupClickHandler();

  console.log('[section-gen] ' + lines.length + ' lines → ' + allGraphs.length + ' sections');
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

function onFeatureSelected(data) {
  if (!_layer || !_globalProj) return;
  var fps = _lineFootprints[data.id];
  if (fps && fps.length > 0) _layer.highlight(fps, _globalProj);
  else _layer.clearHighlight();
}

function onFeatureDeselected() { if (_layer) _layer.clearHighlight(); }
function onFeaturesChanged() { processAllLines(); }

function onParamsChanged(newParams) {
  for (var key in newParams) {
    if (newParams.hasOwnProperty(key) && _params.hasOwnProperty(key)) _params[key] = newParams[key];
  }
  processAllLines();
}

var sectionGenModule = {
  id: 'section-gen',
  init: function (ctx) {
    _eventBus = ctx.eventBus;
    _featureStore = ctx.featureStore;
    _mapManager = ctx.mapManager;
    _threeOverlay = ctx.threeOverlay || null;

    _layer = new SectionGenLayer(ctx.mapManager);
    _layer.init();

    _unsubs.push(_eventBus.on('draw:line:complete', onFeaturesChanged));
    _unsubs.push(_eventBus.on('features:changed', onFeaturesChanged));
    _unsubs.push(_eventBus.on('section-gen:params:changed', onParamsChanged));
    _unsubs.push(_eventBus.on('feature:selected', onFeatureSelected));
    _unsubs.push(_eventBus.on('feature:deselected', onFeatureDeselected));

    console.log('[section-gen] initialized (Three.js: ' + (!!_threeOverlay) + ')');
  },
  destroy: function () {
    for (var i = 0; i < _unsubs.length; i++) { _unsubs[i](); }
    _unsubs = [];
    if (_threeOverlay) _threeOverlay.clear();
    if (_layer) { _layer.destroy(); _layer = null; }
    _eventBus = null; _featureStore = null; _mapManager = null;
    _threeOverlay = null; _lineFootprints = {}; _globalProj = null; _clickWired = false;
  }
};

export default sectionGenModule;
