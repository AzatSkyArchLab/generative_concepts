/**
 * Processor — main section build cycle.
 * Reads features from store, builds cells/graph/apartments, renders 3D.
 */

import { createProjection } from '../../core/geo/projection.js';
import { getParams, getSectionHeight, computeFloorCount, computeBuildingHeight } from '../../core/SectionParams.js';
import { TYPE_COLORS, APT_COLORS } from '../../core/constants/ApartmentColors.js';
import {
  createNearCells, createFarCells, createCorridorCells,
  getNorthSide, getLLUParams, getCentralIndices
} from './cells.js';
import { buildSectionGraph } from './graph.js';
import { buildSectionMeshes, buildDividerWall, buildSectionWireframe, buildFloorLabel, buildDetailedFloor1 } from '../../core/three/MeshBuilder.js';
import { solveFloor } from '../../core/apartments/ApartmentSolver.js';
import { planWZStacks } from '../../core/apartments/WZPlanner.js';
import { planBuilding } from '../../core/apartments/BuildingPlanner.js';
import { generateReport } from '../../ui/FloorPlanReport.js';

import { state } from './state.js';
import { setupClickHandler, highlightIds } from './clickHandler.js';
import { updateEditHighlight } from './editMode.js';
import { pointsToInsolMap, buildInsolMap, buildPerFloorInsol } from './insolHelpers.js';

// ── Geometry helpers ──────────────────────────────────

function closeRing(polyLL) { var r = polyLL.slice(); r.push(r[0]); return r; }

function polyArea4(fpM) {
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

// ── Main ──────────────────────────────────────────────

export function processAllSections() {
  if (!state.layer || !state.featureStore) return;
  var all = state.featureStore.toArray();
  var sects = [];
  for (var i = 0; i < all.length; i++) {
    if (all[i].properties.type === 'section-axis') sects.push(all[i]);
  }

  if (state.threeOverlay) state.threeOverlay.clear();
  if (sects.length === 0) { state.layer.clear(); state.lineFootprints = {}; state.stableOrigin = null; return; }

  // Stable projection: lock to first section's first coord, never shifts
  if (!state.stableOrigin) {
    var firstCoord = sects[0].geometry.coordinates[0];
    state.stableOrigin = [firstCoord[0], firstCoord[1]];
  }
  var globalProj = createProjection(state.stableOrigin[0], state.stableOrigin[1]);
  if (state.threeOverlay) state.threeOverlay.setOrigin(state.stableOrigin[0], state.stableOrigin[1]);
  state.eventBus.emit('section-gen:origin', state.stableOrigin);

  var allCellsLL = [];
  var allFootLL = [];
  state.lineFootprints = {};

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
      var residentialFloors = Math.max(0, floorCount - 1);
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
      var insolMap = null;
      var aptResult = null;
      var wzPlan = null;
      if (renderFloors >= 2) {
        insolMap = buildInsolMap(lineId, fi, 1, N);

        // Backward compat: old format had no floor key
        if (!insolMap && state.insolCellMap && state.insolCellMap[lineId] && state.insolCellMap[lineId][fi]) {
          var raw = state.insolCellMap[lineId][fi];
          if (raw.points) {
            insolMap = pointsToInsolMap(raw.points, N);
          }
        }

        aptResult = solveFloor(graph.nodes, N, 1, insolMap);

        // WZ planning (step 1)
        var sectionOri = feature.properties.orientation || 'lat';
        wzPlan = planWZStacks(graph.nodes, N, insolMap, sectionOri, northSide, aptResult);
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
      for (var cid2 in cellAptMap) {
        if (!cellAptMap.hasOwnProperty(cid2)) continue;
        var info = cellAptMap[cid2];
        var pal = APT_COLORS[info.type] || APT_COLORS['orphan'];
        var c = info.role === 'wet' || info.role === 'corridor' ? pal.wet : pal.living;
        var numCid = parseInt(cid2);
        var iFlag = (insolMap && !isNaN(numCid) && insolMap[numCid]) ? ' ' + insolMap[numCid] : '';
        var lbl;
        if (info.role === 'orphan') lbl = 'A' + info.aptIdx + ' orphan';
        else if (info.role === 'wet') lbl = 'A' + info.aptIdx + ' wz';
        else if (info.role === 'corridor') lbl = 'A' + info.aptIdx;
        else lbl = 'A' + info.aptIdx + ' ' + info.type + iFlag;
        aptMeshColors[cid2] = { color: c, label: lbl };
        detailMap[cid2] = { aptIdx: info.aptIdx, type: info.type, role: info.role, color: c, label: lbl };
      }

      if (state.threeOverlay) {
        // Floor 0 (commercial) — standard meshes
        state.threeOverlay.addMesh(buildSectionMeshes(graph.nodes, 0,
          params.firstFloorHeight, params.typicalFloorHeight, 0.08, null));

        // Floor 1 (residential) — always detailed
        if (renderFloors >= 2) {
          state.threeOverlay.addMesh(buildDetailedFloor1(graph.nodes, N,
            params.firstFloorHeight,
            params.firstFloorHeight + params.typicalFloorHeight,
            detailMap, 0.08));
        }

        // Floors 2..N — only after Distribute
        if (state.distributed && floorCount > 2 && wzPlan && wzPlan.wzStacks.length > 0) {
          var planKey = lineId + '_' + fi;
          if (!state.buildingPlans[planKey]) {
            var perFloorInsol = buildPerFloorInsol(lineId, fi, N, floorCount - 1);
            // Compute LLU cell IDs as barriers
            var lluCellIds = [];
            for (var li = 0; li < lluIndices.length; li++) {
              if (northSide === 'near') {
                lluCellIds.push(lluIndices[li]);
              } else {
                lluCellIds.push(N + lluIndices[li]);
              }
            }
            // Compute corridor near positions
            var corrNears = [];
            for (var gk in graph.nodes) {
              if (!graph.nodes.hasOwnProperty(gk)) continue;
              var gn = graph.nodes[gk];
              if (gn.floor === 1 && gn.type === 'corridor') {
                var gnCid = String(gn.cellId);
                if (gnCid.indexOf('-') >= 0) corrNears.push(parseInt(gnCid.split('-')[0]));
              }
            }
            corrNears.sort(function (a, b) { return a - b; });

            console.log('[section-gen] planBuilding input:', planKey,
              'wzStacks:', wzPlan.wzStacks.length,
              'fl1Apts:', (aptResult ? aptResult.apartments.length : 0),
              'lluCells:', lluCellIds.join(','),
              'corrNears:', corrNears.join(','),
              'mix:', JSON.stringify(state.aptMix));
            state.buildingPlans[planKey] = planBuilding({
              graphNodes: graph.nodes,
              N: N,
              floorCount: floorCount,
              wzStacks: wzPlan.wzStacks,
              floor1Apartments: aptResult ? aptResult.apartments : [],
              mix: state.aptMix,
              perFloorInsol: perFloorInsol,
              lluCells: lluCellIds,
              sortedCorrNears: corrNears
            });
            state.graphDataMap[planKey] = { nodes: graph.nodes, N: N, params: params, floorCount: floorCount, perFloorInsol: perFloorInsol };
          }
          var bPlan = state.buildingPlans[planKey];
          console.log('[section-gen] building plan:', planKey,
            'floors:', bPlan.floors.length,
            'placed:', JSON.stringify(bPlan.totalPlaced));

          // Render floors 2..N with per-floor apartments
          for (var fl = 2; fl < floorCount; fl++) {
            var flBaseZ = params.firstFloorHeight + (fl - 1) * params.typicalFloorHeight;
            var flTopZ = flBaseZ + params.typicalFloorHeight;

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
                  var faRole;
                  var faColor;
                  if (typeof fcid === 'string') {
                    // Corridor label (e.g. "3-12") — assigned by FloorPlanner Phase 4b
                    faRole = 'corridor';
                    faColor = faPal.wet;
                  } else if (fapt.type === 'orphan') {
                    faRole = 'orphan';
                    faColor = faPal.living;
                  } else if (fcid === fapt.wetCell) {
                    faRole = 'wet';
                    faColor = faPal.wet;
                  } else {
                    faRole = 'living';
                    faColor = faPal.living;
                  }
                  flDetailMap[fcid] = {
                    aptIdx: fai, type: fapt.type, role: faRole, color: faColor,
                    label: 'A' + fai + ' ' + fapt.type
                  };
                }
              }
            } else {
              flDetailMap = detailMap; // fallback
            }

            state.threeOverlay.addMesh(buildDetailedFloor1(graph.nodes, N,
              flBaseZ, flTopZ, flDetailMap, 0.08, false, false, false));
          }

          // Emit building plan results
          state.eventBus.emit('building:plan:result', {
            sectionKey: planKey, plan: bPlan
          });
        }

        state.threeOverlay.addMesh(buildSectionWireframe(fpM, 0, buildingH));
        state.threeOverlay.addMesh(buildFloorLabel(floorCount + 'F', fpM, buildingH));
      }
      if (state.threeOverlay && fi > 0)
        state.threeOverlay.addMesh(buildDividerWall(fpM[3], fpM[0], 0, renderH + 0.05, 0.12));
    }
    state.lineFootprints[lineId] = lineFPsLL;
  }

  state.layer.update(allCellsLL, allFootLL);
  setupClickHandler();

  if (state.editAxisId) {
    var fps = state.lineFootprints[state.editAxisId];
    if (fps && fps.length > 0) {
      state.layer.enterEditMode(fps, function () { exitEditMode(); });
      updateEditHighlight();
    }
  } else if (state.highlightedIds.length > 0) {
    highlightIds(state.highlightedIds);
  }

  state.eventBus.emit('section-gen:stats', allStats);
  state.eventBus.emit('section-gen:rebuilt');
}
