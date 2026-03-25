/**
 * Section Gen — edit mode with shift+click multi-select
 *
 * Refactored:
 * - Imports projection from core/geo
 * - Imports params/floor utils from core/SectionParams
 * - map.on() handlers saved and removed in destroy()
 * - Click footprint → sidebar:feature:click → DrawManager selects axis
 */

import { createProjection } from '../../core/geo/projection.js';
import { getParams, getSectionHeight, computeFloorCount, computeBuildingHeight } from '../../core/SectionParams.js';
import { UpdateFeatureCommand } from '../../core/commands/UpdateFeatureCommand.js';
import {
  createNearCells, createFarCells, createCorridorCells,
  getNorthSide, getLLUParams, getCentralIndices
} from './cells.js';
import { buildSectionGraph } from './graph.js';
import { SectionGenLayer } from './SectionGenLayer.js';
import { buildSectionMeshes, buildDividerWall, buildSectionWireframe, buildFloorLabel, buildDetailedFloor1 } from '../../core/three/MeshBuilder.js';
import { solveFloor } from '../../core/apartments/ApartmentSolver.js';
import { planWZStacks } from '../../core/apartments/WZPlanner.js';
import { planBuilding } from '../../core/apartments/BuildingPlanner.js';
import { generateReport } from '../../ui/FloorPlanReport.js';

var TYPE_COLORS = { apartment: '#dce8f0', commercial: '#ffb74d', corridor: '#c8c8c8', llu: '#4f81bd' };

var APT_COLORS = {
  '1K':     { living: '#ade8f4', wet: '#7ab8c8' },
  '2K':     { living: '#90ee90', wet: '#64a664' },
  '3K':     { living: '#ffdab9', wet: '#c4987a' },
  '4K':     { living: '#dda0dd', wet: '#a870a8' },
  'orphan': { living: '#e8e8e8', wet: '#b0b0b0' }
};

var _layer, _threeOverlay, _eventBus, _featureStore, _mapManager, _commandManager;
var _unsubs = [];
var _lineFootprints = {};
var _highlightedIds = [];
var _clickWired = false;
var _editAxisId = null;
var _editSelectedIndices = [];
var _keyHandler = null;
var _mapHandlers = [];
var _insolCellMap = null;
var _stableOrigin = null;  // fixed projection origin — set once, never shifts
var _distributed = false;  // true after "Distribute apartments" button
var _aptMix = { '1K': 40, '2K': 30, '3K': 20, '4K': 10 };
var _buildingPlans = {};   // { lineId_fi: buildingPlanResult }
var _graphDataMap = {};    // { lineId_fi: { nodes, N, params, floorCount } }

function closeRing(polyLL) { var r = polyLL.slice(); r.push(r[0]); return r; }

function polyArea4(fpM) {
  // Shoelace formula for 4-point polygon in meters
  var n = fpM.length;
  var area = 0;
  for (var i = 0; i < n; i++) {
    var j = (i + 1) % n;
    area += fpM[i][0] * fpM[j][1];
    area -= fpM[j][0] * fpM[i][1];
  }
  return Math.abs(area) / 2;
}

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
    _eventBus.emit('sidebar:feature:click', { id: lineId });
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

// ── Insolation map helpers ────────────────────────────

var _FLAG_PRIO = { 'f': 1, 'w': 2, 'p': 3 };

function _pointsToInsolMap(pts, N) {
  if (!pts || pts.length === 0) return null;
  var map = {};
  for (var i = 0; i < pts.length; i++) {
    var pt = pts[i];
    var graphCid = pt.side === 'near' ? pt.cellIdx : N + pt.cellIdx;
    var oldFlag = map[graphCid];
    if (oldFlag === undefined || _FLAG_PRIO[pt.flag] > _FLAG_PRIO[oldFlag]) {
      map[graphCid] = pt.flag;
    }
  }
  return map;
}

function _buildInsolMap(lineId, secIdx, floorNum, N) {
  if (!_insolCellMap || !_insolCellMap[lineId] || !_insolCellMap[lineId][secIdx]) return null;
  var secData = _insolCellMap[lineId][secIdx];
  if (!secData[floorNum]) return null;
  return _pointsToInsolMap(secData[floorNum].points, N);
}

function _buildPerFloorInsol(lineId, secIdx, N, maxFloor) {
  var result = {};
  for (var fl = 1; fl <= maxFloor; fl++) {
    var map = _buildInsolMap(lineId, secIdx, fl, N);
    if (map) result[fl] = map;
  }
  return result;
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
  if (sects.length === 0) { _layer.clear(); _lineFootprints = {}; _stableOrigin = null; return; }

  // Stable projection: lock to first section's first coord, never shifts
  if (!_stableOrigin) {
    var firstCoord = sects[0].geometry.coordinates[0];
    _stableOrigin = [firstCoord[0], firstCoord[1]];
  }
  var globalProj = createProjection(_stableOrigin[0], _stableOrigin[1]);
  if (_threeOverlay) _threeOverlay.setOrigin(_stableOrigin[0], _stableOrigin[1]);
  _eventBus.emit('section-gen:origin', _stableOrigin);

  var allCellsLL = [];
  var allFootLL = [];
  _lineFootprints = {};

  var AREA_COEFF = 0.65;
  var M2_PER_PERSON = 50;
  var allStats = { axes: [], totalFootprint: 0, totalAptArea: 0, totalPopulation: 0, sections: [] };

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

      // Per-section stats
      var footprintArea = polyArea4(fpM);
      var residentialFloors = Math.max(0, floorCount - 1); // minus commercial floor 0
      var aptFloorArea = footprintArea * AREA_COEFF;
      var totalGBA = footprintArea * floorCount;
      var totalAptArea = aptFloorArea * residentialFloors;
      var population = Math.round(totalAptArea / M2_PER_PERSON);
      allStats.totalFootprint += footprintArea;
      allStats.totalAptArea += totalAptArea;
      allStats.totalPopulation += population;
      allStats.sections.push({
        axisId: lineId, secIdx: fi, floorCount: floorCount,
        sectionHeight: secH, footprintArea: footprintArea,
        aptFloorArea: aptFloorArea, totalGBA: totalGBA,
        totalAptArea: totalAptArea, population: population
      });

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

      // ── Apartment solver → colored cells ──────────────
      var cellAptMap = {};
      if (renderFloors >= 2) {
        // Build insolMap from cached insolation cell-map for floor 1
        var insolMap = _buildInsolMap(lineId, fi, 1, N);

        // Backward compat: old format had no floor key
        if (!insolMap && _insolCellMap && _insolCellMap[lineId] && _insolCellMap[lineId][fi]) {
          var raw = _insolCellMap[lineId][fi];
          if (raw.points) {
            // Old format: { points: [...] }
            insolMap = _pointsToInsolMap(raw.points, N);
          }
        }

        var aptResult = solveFloor(graph.nodes, N, 1, insolMap);

        // WZ planning (step 1)
        var sectionOri = feature.properties.orientation || 'lat';
        var wzPlan = planWZStacks(graph.nodes, N, insolMap, sectionOri, northSide);
        allStats.sections[allStats.sections.length - 1].wzPlan = {
          wzCount: wzPlan.wzStacks.length,
          pairRatio: wzPlan.wzPairRatio,
          feasible: wzPlan.feasible,
          orientation: sectionOri,
          southOrphans: wzPlan.southOrphanCount,
          totalOrphans: wzPlan.totalOrphanCount,
          report: wzPlan.report
        };

        if (aptResult && aptResult.apartments) {
          for (var ai = 0; ai < aptResult.apartments.length; ai++) {
            var apt = aptResult.apartments[ai];
            var aptCells = apt.cells || [];
            for (var ci = 0; ci < aptCells.length; ci++) {
              var cid = aptCells[ci];
              cellAptMap[cid] = {
                aptIdx: ai, type: apt.type,
                role: apt.type === 'orphan' ? 'orphan' : (cid === apt.wetCell ? 'wet' : 'living'),
                torec: apt.torec || false
              };
            }
            if (apt.corridorLabel) {
              cellAptMap[apt.corridorLabel] = {
                aptIdx: ai, type: apt.type, role: 'corridor', torec: true
              };
            }
          }
        }
      }

      // ── Render floor 1 cells with apartment colors ──
      for (var key in graph.nodes) {
        if (!graph.nodes.hasOwnProperty(key)) continue;
        var node = graph.nodes[key];
        if (node.floor !== 1) continue;
        var poly = node.polygon;
        if (!poly || poly.length < 3) continue;
        var ring = [];
        for (var j = 0; j < poly.length; j++) ring.push(globalProj.toLngLat(poly[j][0], poly[j][1]));
        ring.push(ring[0]);

        var color = TYPE_COLORS[node.type] || '#cccccc';
        var label = node.type === 'llu' ? 'LLU ' + (node.lluTag || '') : String(node.cellId);

        var aptInfo = cellAptMap[node.cellId];
        if (aptInfo) {
          var palette = APT_COLORS[aptInfo.type] || APT_COLORS['orphan'];
          if (aptInfo.role === 'orphan') {
            color = palette.living;
            label = 'A' + aptInfo.aptIdx + ' orphan';
          } else if (aptInfo.role === 'wet') {
            color = palette.wet;
            label = 'A' + aptInfo.aptIdx + ' wz';
          } else if (aptInfo.role === 'corridor') {
            color = palette.wet;
            label = 'A' + aptInfo.aptIdx;
          } else {
            color = palette.living;
            var insolFlag = insolMap && insolMap[node.cellId] ? insolMap[node.cellId] : '';
            label = 'A' + aptInfo.aptIdx + ' ' + aptInfo.type + (insolFlag ? ' ' + insolFlag : '');
          }
        }

        allCellsLL.push({ ring: ring, color: color, label: label });
      }

      // Build 3D color map for apartment meshes
      var aptMeshColors = {};
      var detailMap = {};
      for (var cid in cellAptMap) {
        if (!cellAptMap.hasOwnProperty(cid)) continue;
        var info = cellAptMap[cid];
        var pal = APT_COLORS[info.type] || APT_COLORS['orphan'];
        var c = info.role === 'wet' || info.role === 'corridor' ? pal.wet : pal.living;
        var numCid = parseInt(cid);
        var iFlag = (insolMap && !isNaN(numCid) && insolMap[numCid]) ? ' ' + insolMap[numCid] : '';
        var lbl;
        if (info.role === 'orphan') lbl = 'A' + info.aptIdx + ' orphan';
        else if (info.role === 'wet') lbl = 'A' + info.aptIdx + ' wz';
        else if (info.role === 'corridor') lbl = 'A' + info.aptIdx;
        else lbl = 'A' + info.aptIdx + ' ' + info.type + iFlag;
        aptMeshColors[cid] = { color: c, label: lbl };
        detailMap[cid] = { aptIdx: info.aptIdx, type: info.type, role: info.role, color: c, label: lbl };
      }

      if (_threeOverlay) {
        // Floor 0 (commercial) — standard meshes
        _threeOverlay.addMesh(buildSectionMeshes(graph.nodes, 0,
          params.firstFloorHeight, params.typicalFloorHeight, 0.08, null));

        // Floor 1 (residential) — always detailed
        if (renderFloors >= 2) {
          _threeOverlay.addMesh(buildDetailedFloor1(graph.nodes, N,
            params.firstFloorHeight,
            params.firstFloorHeight + params.typicalFloorHeight,
            detailMap, 0.08));
        }

        // Floors 2..N — only after Distribute
        if (_distributed && floorCount > 2 && wzPlan && wzPlan.wzStacks.length > 0) {
          var planKey = lineId + '_' + fi;
          if (!_buildingPlans[planKey]) {
            var perFloorInsol = _buildPerFloorInsol(lineId, fi, N, floorCount - 1);
            // Compute LLU cell IDs as barriers
            var lluCellIds = [];
            for (var li = 0; li < lluIndices.length; li++) {
              if (northSide === 'near') {
                lluCellIds.push(lluIndices[li]);           // near row
              } else {
                lluCellIds.push(N + lluIndices[li]);       // far row
              }
            }
            // Compute corridor near positions
            var corrNears = [];
            for (var gk in graph.nodes) {
              if (!graph.nodes.hasOwnProperty(gk)) continue;
              var gn = graph.nodes[gk];
              if (gn.floor === 1 && gn.type === 'corridor') {
                var cid = String(gn.cellId);
                if (cid.indexOf('-') >= 0) corrNears.push(parseInt(cid.split('-')[0]));
              }
            }
            corrNears.sort(function (a, b) { return a - b; });

            console.log('[section-gen] planBuilding input:', planKey,
              'wzStacks:', wzPlan.wzStacks.length,
              'fl1Apts:', (aptResult ? aptResult.apartments.length : 0),
              'lluCells:', lluCellIds.join(','),
              'corrNears:', corrNears.join(','),
              'mix:', JSON.stringify(_aptMix));
            _buildingPlans[planKey] = planBuilding({
              graphNodes: graph.nodes,
              N: N,
              floorCount: floorCount,
              wzStacks: wzPlan.wzStacks,
              floor1Apartments: aptResult ? aptResult.apartments : [],
              mix: _aptMix,
              perFloorInsol: perFloorInsol,
              lluCells: lluCellIds,
              sortedCorrNears: corrNears
            });
            _graphDataMap[planKey] = { nodes: graph.nodes, N: N, params: params, floorCount: floorCount, perFloorInsol: perFloorInsol };
          }
          var bPlan = _buildingPlans[planKey];
          console.log('[section-gen] building plan:', planKey,
            'floors:', bPlan.floors.length,
            'placed:', JSON.stringify(bPlan.totalPlaced));

          // Render floors 2..N with per-floor apartments
          for (var fl = 2; fl < floorCount; fl++) {
            var flBaseZ = params.firstFloorHeight + (fl - 1) * params.typicalFloorHeight;
            var flTopZ = flBaseZ + params.typicalFloorHeight;

            // Build detailMap for this floor
            var floorData = null;
            for (var bfi = 0; bfi < bPlan.floors.length; bfi++) {
              if (bPlan.floors[bfi].floor === fl) { floorData = bPlan.floors[bfi]; break; }
            }

            var flDetailMap = {};
            if (floorData) {
              for (var fai = 0; fai < floorData.apartments.length; fai++) {
                var fapt = floorData.apartments[fai];
                var faCells = fapt.cells || [];
                var faPal = APT_COLORS[fapt.type] || APT_COLORS['orphan'];
                for (var fci = 0; fci < faCells.length; fci++) {
                  var fcid = faCells[fci];
                  var faRole = fapt.type === 'orphan' ? 'orphan' : (fcid === fapt.wetCell ? 'wet' : 'living');
                  var faColor = (faRole === 'wet') ? faPal.wet : faPal.living;
                  flDetailMap[fcid] = {
                    aptIdx: fai, type: fapt.type, role: faRole, color: faColor,
                    label: 'A' + fai + ' ' + fapt.type
                  };
                }
              }
              // Corridor rule: corridor "a-b" belongs to apartment if BOTH a and b are in that apartment
              for (var gk in graph.nodes) {
                if (!graph.nodes.hasOwnProperty(gk)) continue;
                var gNode = graph.nodes[gk];
                if (gNode.floor !== 1 || gNode.type !== 'corridor') continue;
                var corrId = String(gNode.cellId);
                if (corrId.indexOf('-') < 0) continue;
                var corrParts = corrId.split('-');
                var corrNear = parseInt(corrParts[0]);
                var corrFar = parseInt(corrParts[1]);
                // Check if both near and far belong to same apartment
                var nearInfo = flDetailMap[corrNear];
                var farInfo = flDetailMap[corrFar];
                if (nearInfo && farInfo && nearInfo.aptIdx === farInfo.aptIdx) {
                  var corrPal = APT_COLORS[nearInfo.type] || APT_COLORS['orphan'];
                  flDetailMap[corrId] = {
                    aptIdx: nearInfo.aptIdx, type: nearInfo.type, role: 'corridor',
                    color: corrPal.wet, label: 'A' + nearInfo.aptIdx
                  };
                }
              }
            } else {
              flDetailMap = detailMap; // fallback
            }

            _threeOverlay.addMesh(buildDetailedFloor1(graph.nodes, N,
              flBaseZ, flTopZ, flDetailMap, 0.08, false, false, false));
          }

          // Emit building plan results
          _eventBus.emit('building:plan:result', {
            sectionKey: planKey, plan: bPlan
          });
        }

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

  _eventBus.emit('section-gen:stats', allStats);
  _eventBus.emit('section-gen:rebuilt');
}

function onSelected(d) { if (_editAxisId) return; _highlightedIds = [d.id]; highlightIds(_highlightedIds); }
function onInsolCellMap(cellMap) {
  _insolCellMap = cellMap;
  _buildingPlans = {};  // force rebuild with new insol data
  processAllSections();
}
function onMultiselect(d) {
  if (_editAxisId) return;
  var idx = _highlightedIds.indexOf(d.id);
  if (idx >= 0) _highlightedIds.splice(idx, 1);
  else _highlightedIds.push(d.id);
  highlightIds(_highlightedIds);
}
function onDeselected() { _highlightedIds = []; if (_layer) _layer.clearHighlight(); }
function onChanged() { _distributed = false; _buildingPlans = {}; _graphDataMap = {}; processAllSections(); }

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
    _unsubs.push(_eventBus.on('insolation:cell-map', onInsolCellMap));
    _unsubs.push(_eventBus.on('apt-mix:distribute', function (mix) {
      _aptMix = mix || _aptMix;
      _distributed = true;
      _buildingPlans = {};
      // Trigger multi-floor insolation — results come back via insolation:cell-map
      _eventBus.emit('insolation:run-multi-floor');
    }));
    _unsubs.push(_eventBus.on('apt-mix:changed', function (mix) { _aptMix = mix || _aptMix; }));
    _unsubs.push(_eventBus.on('apt-mix:reset', function () {
      _distributed = false;
      _buildingPlans = {};
      _graphDataMap = {};
      _eventBus.emit('insolation:analyze:global');
    }));
    _unsubs.push(_eventBus.on('building:report:generate', function () {
      generateReport(_buildingPlans, _graphDataMap);
    }));
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
    _insolCellMap = null;
    _stableOrigin = null;
    _distributed = false;
    _buildingPlans = {};
    _graphDataMap = {};
  }
};

export default sectionGenModule;
