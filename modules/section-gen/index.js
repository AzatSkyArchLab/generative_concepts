/**
 * Section Gen — edit mode with shift+click multi-select
 *
 * Refactored:
 * - Imports projection from core/geo
 * - Imports params/floor utils from core/SectionParams
 * - map.on() handlers saved and removed in destroy()
 * - No direct UI coupling (sidebar:feature:click removed)
 */

import { createProjection, centroid } from '../../core/geo/projection.js';
import { getParams, getSectionHeight, computeFloorCount, computeBuildingHeight } from '../../core/SectionParams.js';
import { UpdateFeatureCommand } from '../../core/commands/UpdateFeatureCommand.js';
import {
  createNearCells, createFarCells, createCorridorCells,
  getNorthSide, getLLUParams, getCentralIndices
} from './cells.js';
import { buildSectionGraph } from './graph.js';
import { SectionGenLayer } from './SectionGenLayer.js';
import { buildSectionMeshes, buildDividerWall, buildSectionWireframe, buildFloorLabel } from '../../core/three/MeshBuilder.js';

var TYPE_COLORS = { apartment: '#dce8f0', commercial: '#ffb74d', corridor: '#c8c8c8', llu: '#4f81bd' };

var _layer, _threeOverlay, _eventBus, _featureStore, _mapManager, _commandManager;
var _unsubs = [];
var _lineFootprints = {};
var _highlightedIds = [];
var _clickWired = false;
var _editAxisId = null;
var _editSelectedIndices = [];
var _keyHandler = null;
var _mapHandlers = [];

function closeRing(polyLL) { var r = polyLL.slice(); r.push(r[0]); return r; }

function orientAxis(fpM) {
  var a = fpM[0]; var b = fpM[1]; var d = fpM[3];
  var dx = b[0]-a[0]; var dy = b[1]-a[1];
  var len = Math.sqrt(dx*dx+dy*dy);
  if (len < 1e-10) return [a, b];
  var nx = -dy/len; var ny = dx/len;
  if (nx*(d[0]-a[0]) + ny*(d[1]-a[1]) >= 0) return [a, b];
  return [b, a];
}

// ── Edit mode ──────────────────────────────────────────

function enterEditMode(lineId) {
  _editAxisId = lineId;
  _editSelectedIndices = [];
  _layer.clearHighlight();
  var fps = _lineFootprints[lineId];
  if (fps && fps.length > 0) {
    _layer.enterEditMode(fps, function () { exitEditMode(); });
  }
  _eventBus.emit('section:edit-mode', { axisId: lineId });
}

function exitEditMode() {
  _editAxisId = null;
  _editSelectedIndices = [];
  _layer.exitEditMode();
  _eventBus.emit('section:edit-exit');
}

function updateEditHighlight() {
  var fps = _lineFootprints[_editAxisId];
  if (!fps) return;
  if (_editSelectedIndices.length === 0) {
    _layer.clearEditSelection(fps);
  } else {
    var selectedFPs = [];
    var dimFPs = [];
    for (var i = 0; i < fps.length; i++) {
      if (_editSelectedIndices.indexOf(i) >= 0) selectedFPs.push(fps[i]);
      else dimFPs.push(fps[i]);
    }
    _layer.selectEditSections(selectedFPs, dimFPs);
  }
}

function selectSection(secIdx, addToSelection) {
  if (addToSelection) {
    var pos = _editSelectedIndices.indexOf(secIdx);
    if (pos >= 0) _editSelectedIndices.splice(pos, 1);
    else { _editSelectedIndices.push(secIdx); _editSelectedIndices.sort(function (a, b) { return a - b; }); }
  } else {
    _editSelectedIndices = [secIdx];
  }
  updateEditHighlight();
  _eventBus.emit('section:individual:selected', {
    axisId: _editAxisId, sectionIndices: _editSelectedIndices.slice()
  });
}

// ── Click / keyboard (with cleanup) ───────────────────

function _addMapHandler(map, event, layerOrFn, fn) {
  if (fn) { map.on(event, layerOrFn, fn); _mapHandlers.push({ event: event, layer: layerOrFn, fn: fn }); }
  else { map.on(event, layerOrFn); _mapHandlers.push({ event: event, fn: layerOrFn }); }
}

function _removeAllMapHandlers(map) {
  for (var i = 0; i < _mapHandlers.length; i++) {
    var h = _mapHandlers[i];
    if (h.layer) map.off(h.event, h.layer, h.fn);
    else map.off(h.event, h.fn);
  }
  _mapHandlers = [];
}

function setupClickHandler() {
  if (_clickWired) return;
  var map = _mapManager.getMap();
  if (!map) return;
  var clickLayerId = _layer.getClickLayerId();

  _addMapHandler(map, 'click', clickLayerId, function (e) {
    if (!e.features || e.features.length === 0) return;
    var props = e.features[0].properties;
    var lineId = props.lineId;
    var secIdx = props.secIdx !== undefined ? parseInt(props.secIdx) : -1;

    if (_editAxisId) {
      if (lineId === _editAxisId && secIdx >= 0) selectSection(secIdx, e.originalEvent.shiftKey);
      return;
    }

    _highlightedIds = [lineId];
    highlightIds(_highlightedIds);
    _eventBus.emit('feature:selected', { id: lineId });
  });

  _addMapHandler(map, 'dblclick', clickLayerId, function (e) {
    if (!e.features || e.features.length === 0) return;
    e.preventDefault();
    var lineId = e.features[0].properties.lineId;
    if (!lineId || _editAxisId) return;
    _layer.clearHighlight();
    enterEditMode(lineId);
  });

  _addMapHandler(map, 'mouseenter', clickLayerId, function () { _mapManager.setCursor('pointer'); });
  _addMapHandler(map, 'mouseleave', clickLayerId, function () { _mapManager.setCursor('grab'); });

  _keyHandler = function (e) { if (e.key === 'Escape' && _editAxisId) exitEditMode(); };
  document.addEventListener('keydown', _keyHandler);

  _clickWired = true;
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

// ── Process ────────────────────────────────────────────

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
    var params = getParams(feature.properties);
    var lineFPsLL = [];

    for (var fi = 0; fi < storedFP.length; fi++) {
      var fp = storedFP[fi];
      var secH = getSectionHeight(fp, params);
      var floorCount = computeFloorCount(secH, params.firstFloorHeight, params.typicalFloorHeight);
      var renderFloors = Math.min(floorCount, 2);
      var renderH = params.firstFloorHeight;
      if (renderFloors > 1) renderH = params.firstFloorHeight + params.typicalFloorHeight;
      var buildingH = computeBuildingHeight(secH, params.firstFloorHeight, params.typicalFloorHeight);
      var apartmentDepth = (params.sectionWidth - params.corridorWidth) / 2.0;

      var fpRing = closeRing(fp.polygon);
      var fpData = { ring: fpRing, lineId: lineId, secIdx: fi,
        floorCount: floorCount, buildingH: buildingH, sectionHeight: secH };
      lineFPsLL.push(fpData);
      allFootLL.push(fpData);

      var fpM = [];
      for (var j = 0; j < fp.polygon.length; j++)
        fpM.push(globalProj.toMeters(fp.polygon[j][0], fp.polygon[j][1]));

      var sectionAxis = orientAxis(fpM);
      var nearCells = createNearCells(sectionAxis, params.cellWidth, apartmentDepth);
      var farCells = createFarCells(sectionAxis, params.cellWidth, apartmentDepth, apartmentDepth + params.corridorWidth);
      var corridorCells = createCorridorCells(sectionAxis, params.cellWidth, params.corridorWidth, apartmentDepth);
      var N = nearCells.length;
      if (N === 0) continue;

      var northSide = getNorthSide(sectionAxis);
      var lluParams = getLLUParams(secH);
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
        for (var j = 0; j < poly.length; j++) ring.push(globalProj.toLngLat(poly[j][0], poly[j][1]));
        ring.push(ring[0]);
        allCellsLL.push({ ring: ring, color: TYPE_COLORS[node.type] || '#cccccc',
          label: node.type === 'llu' ? 'LLU ' + (node.lluTag || '') : String(node.cellId) });
      }

      if (_threeOverlay) {
        _threeOverlay.addMesh(buildSectionMeshes(graph.nodes, renderFloors - 1,
          params.firstFloorHeight, params.typicalFloorHeight, 0.08));
        _threeOverlay.addMesh(buildSectionWireframe(fpM, 0, buildingH));
        _threeOverlay.addMesh(buildFloorLabel(floorCount + 'F', fpM, buildingH));
      }
      if (_threeOverlay && fi > 0)
        _threeOverlay.addMesh(buildDividerWall(fpM[3], fpM[0], 0, renderH + 0.05, 0.12));
    }
    _lineFootprints[lineId] = lineFPsLL;
  }

  _layer.update(allCellsLL, allFootLL);
  setupClickHandler();

  if (_editAxisId) {
    var fps = _lineFootprints[_editAxisId];
    if (fps && fps.length > 0) {
      _layer.enterEditMode(fps, function () { exitEditMode(); });
      updateEditHighlight();
    }
  } else if (_highlightedIds.length > 0) {
    highlightIds(_highlightedIds);
  }
}

function onSelected(d) { if (_editAxisId) return; _highlightedIds = [d.id]; highlightIds(_highlightedIds); }
function onMultiselect(d) {
  if (_editAxisId) return;
  var idx = _highlightedIds.indexOf(d.id);
  if (idx >= 0) _highlightedIds.splice(idx, 1);
  else _highlightedIds.push(d.id);
  highlightIds(_highlightedIds);
}
function onDeselected() { _highlightedIds = []; if (_layer) _layer.clearHighlight(); }
function onChanged() { processAllSections(); }

function onSectionParamChanged(data) {
  if (!data.axisId) return;
  var f = _featureStore.get(data.axisId);
  if (!f || !f.properties.footprints) return;
  var indices = data.sectionIndices || (data.sectionIdx !== undefined ? [data.sectionIdx] : []);
  if (indices.length === 0) return;

  // Snapshot old footprints for undo
  var oldFP = [];
  for (var i = 0; i < f.properties.footprints.length; i++) {
    var oc = {};
    for (var k in f.properties.footprints[i]) {
      if (f.properties.footprints[i].hasOwnProperty(k)) oc[k] = f.properties.footprints[i][k];
    }
    oldFP.push(oc);
  }

  // Build new footprints
  var newFP = [];
  for (var i = 0; i < f.properties.footprints.length; i++) {
    var copy = {};
    for (var k in f.properties.footprints[i]) {
      if (f.properties.footprints[i].hasOwnProperty(k)) copy[k] = f.properties.footprints[i][k];
    }
    if (indices.indexOf(i) >= 0) copy[data.key] = data.value;
    newFP.push(copy);
  }

  if (_commandManager) {
    _commandManager.execute(new UpdateFeatureCommand(
      _featureStore, data.axisId, { footprints: newFP }, { footprints: oldFP }
    ));
  } else {
    _featureStore.update(data.axisId, { footprints: newFP });
  }
  processAllSections();
  _eventBus.emit('buffers:recompute');
}

var sectionGenModule = {
  id: 'section-gen',
  init: function (ctx) {
    _eventBus = ctx.eventBus; _featureStore = ctx.featureStore;
    _mapManager = ctx.mapManager; _threeOverlay = ctx.threeOverlay || null;
    _commandManager = ctx.commandManager || null;
    _layer = new SectionGenLayer(ctx.mapManager); _layer.init();
    _unsubs.push(_eventBus.on('draw:section:complete', onChanged));
    _unsubs.push(_eventBus.on('features:changed', onChanged));
    _unsubs.push(_eventBus.on('section-gen:params:changed', onChanged));
    _unsubs.push(_eventBus.on('section:param:changed', onSectionParamChanged));
    _unsubs.push(_eventBus.on('feature:selected', onSelected));
    _unsubs.push(_eventBus.on('feature:multiselect', onMultiselect));
    _unsubs.push(_eventBus.on('feature:deselected', onDeselected));
    console.log('[section-gen] initialized');
  },
  destroy: function () {
    for (var i = 0; i < _unsubs.length; i++) { _unsubs[i](); }
    _unsubs = [];
    if (_keyHandler) { document.removeEventListener('keydown', _keyHandler); _keyHandler = null; }
    var map = _mapManager ? _mapManager.getMap() : null;
    if (map) _removeAllMapHandlers(map);
    if (_threeOverlay) _threeOverlay.clear();
    if (_layer) { _layer.destroy(); _layer = null; }
    _eventBus = null; _featureStore = null; _mapManager = null;
    _commandManager = null; _threeOverlay = null; _lineFootprints = {}; _highlightedIds = [];
    _editAxisId = null; _editSelectedIndices = []; _clickWired = false;
  }
};

export default sectionGenModule;
