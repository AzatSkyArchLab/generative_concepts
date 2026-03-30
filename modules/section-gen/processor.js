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
import { allocateQuotas } from '../../core/apartments/QuotaAllocator.js';
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
  var sectionProfiles = []; // for QuotaAllocator

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
      var axisFlipped = (sectionAxis[0] !== fpM[0]);
      var nearCells = createNearCells(sectionAxis, params.cellWidth, apartmentDepth);
      var farCells = createFarCells(sectionAxis, params.cellWidth, apartmentDepth, apartmentDepth + params.corridorWidth);
      var corridorCells = createCorridorCells(sectionAxis, params.cellWidth, params.corridorWidth, apartmentDepth);
      var N = nearCells.length;
      if (N === 0) continue;

      var northSide = getNorthSide(sectionAxis);
      var lluParams = getLLUParams(secH);
      var lluIndices = getCentralIndices(lluParams.count, N);

      // Store real cell data on footprint for insolation module
      fp.N = N;
      fp.northSide = northSide;
      fp.lluIndices = lluIndices;
      fp.axisFlipped = axisFlipped;

      var graph = buildSectionGraph(N, nearCells, farCells, corridorCells,
        northSide, lluIndices, lluParams.tag, renderFloors);

      // ── Apartment solver → colored cells ──────────────
      var cellAptMap = {};
      var insolMap = null;
      var aptResult = null;
      var wzPlan = null;
      if (renderFloors >= 2) {
        insolMap = buildInsolMap(lineId, fi, 1, N, graph.nodes);

        // Backward compat: old format had no floor key
        if (!insolMap && state.insolCellMap && state.insolCellMap[lineId] && state.insolCellMap[lineId][fi]) {
          var raw = state.insolCellMap[lineId][fi];
          if (raw.points) {
            insolMap = pointsToInsolMap(raw.points, N, graph.nodes, 1);
          }
        }

        var sectionOri = feature.properties.orientation || 'lat';

        // Diagnostic: show insolMap for first floor
        if (insolMap) {
          var nearFlags = [];
          var farFlags = [];
          for (var ci = 0; ci < N; ci++) {
            var f = insolMap[ci];
            nearFlags.push(ci + ':' + (f || '-'));
          }
          for (var ci = N; ci < 2 * N; ci++) {
            var f = insolMap[ci];
            farFlags.push(ci + ':' + (f || '-'));
          }
          console.log('[InsolMap] sec=' + fi + ' ori=' + sectionOri + ' N=' + N +
            ' north=' + northSide + ' LLU=[' + lluIndices.join(',') + ']' +
            (axisFlipped ? ' FLIPPED' : ''));
          console.log('  near: ' + nearFlags.join(' '));
          console.log('  far:  ' + farFlags.join(' '));
        } else {
          console.log('[InsolMap] sec=' + fi + ' — no insolation data');
        }

        aptResult = solveFloor(graph.nodes, N, 1, insolMap, sectionOri);

        // WZ planning (step 1)
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

        // Collect profile for QuotaAllocator
        if (aptResult && aptResult.apartments) {
          var fl1Placed = { '1K': 0, '2K': 0, '3K': 0, '4K': 0 };
          for (var ai = 0; ai < aptResult.apartments.length; ai++) {
            var t = aptResult.apartments[ai].type;
            if (fl1Placed[t] !== undefined) fl1Placed[t]++;
          }
          var residFloors = Math.max(0, floorCount - 1);
          sectionProfiles.push({
            key: lineId + '_' + fi,
            orientation: sectionOri,
            floor1Placed: fl1Placed,
            totalEstimate: wzPlan.wzStacks.length * residFloors,
            floorCount: floorCount
          });
        }

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

        // Floors 2..N — defer to Pass 2 (after QuotaAllocator)
        // Save data needed for planBuilding
        if (state.distributed && floorCount > 2 && wzPlan && wzPlan.wzStacks.length > 0) {
          var planKey = lineId + '_' + fi;
          if (!state.buildingPlans[planKey]) {
            // Store deferred data for Pass 2
            if (!state._deferredPlans) state._deferredPlans = [];
            state._deferredPlans.push({
              planKey: planKey,
              graphNodes: graph.nodes,
              N: N,
              floorCount: floorCount,
              wzStacks: wzPlan.wzStacks,
              floor1Apartments: aptResult ? aptResult.apartments : [],
              lluIndices: lluIndices,
              northSide: northSide,
              orientation: sectionOri,
              params: params,
              fpM: fpM,
              buildingH: buildingH,
              detailMap: detailMap
            });
          }
        }

        state.threeOverlay.addMesh(buildSectionWireframe(fpM, 0, buildingH));
        state.threeOverlay.addMesh(buildFloorLabel(floorCount + 'F', fpM, buildingH));
      }
      if (state.threeOverlay && fi > 0)
        state.threeOverlay.addMesh(buildDividerWall(fpM[3], fpM[0], 0, renderH + 0.05, 0.12));
    }
    state.lineFootprints[lineId] = lineFPsLL;
  }

  // ══════════════════════════════════════════════════════════
  // Pass 2: Building Plans with cross-section QuotaAllocator
  // All floor 1 profiles collected → compute adjusted mixes → planBuilding
  // ══════════════════════════════════════════════════════════
  if (state.distributed && state._deferredPlans && state._deferredPlans.length > 0) {
    // Compute adjusted mixes from all section profiles
    if (!state.sectionMixes) {
      state.sectionMixes = allocateQuotas(sectionProfiles, state.aptMix);
    }

    for (var dpi = 0; dpi < state._deferredPlans.length; dpi++) {
      var dp = state._deferredPlans[dpi];
      if (state.buildingPlans[dp.planKey]) continue;

      var sectionMix = state.sectionMixes[dp.planKey] || state.aptMix;
      var perFloorInsol = buildPerFloorInsol(
        dp.planKey.split('_')[0], parseInt(dp.planKey.split('_')[1]),
        dp.N, dp.floorCount - 1, dp.graphNodes);

      // Compute LLU cell IDs
      var lluCellIds = [];
      for (var li = 0; li < dp.lluIndices.length; li++) {
        if (dp.northSide === 'near') {
          lluCellIds.push(dp.lluIndices[li]);
        } else {
          lluCellIds.push(dp.N + dp.lluIndices[li]);
        }
      }

      // Compute corridor near positions
      var corrNears = [];
      for (var gk in dp.graphNodes) {
        if (!dp.graphNodes.hasOwnProperty(gk)) continue;
        var gn = dp.graphNodes[gk];
        if (gn.floor === 1 && gn.type === 'corridor') {
          var gnCid = String(gn.cellId);
          if (gnCid.indexOf('-') >= 0) corrNears.push(parseInt(gnCid.split('-')[0]));
        }
      }
      corrNears.sort(function (a, b) { return a - b; });

      console.log('[section-gen] planBuilding input:', dp.planKey,
        'wzStacks:', dp.wzStacks.length,
        'fl1Apts:', dp.floor1Apartments.length,
        'lluCells:', lluCellIds.join(','),
        'corrNears:', corrNears.join(','),
        'mix:', JSON.stringify(sectionMix),
        '(global:', JSON.stringify(state.aptMix) + ')');

      state.buildingPlans[dp.planKey] = planBuilding({
        graphNodes: dp.graphNodes,
        N: dp.N,
        floorCount: dp.floorCount,
        wzStacks: dp.wzStacks,
        floor1Apartments: dp.floor1Apartments,
        mix: sectionMix,
        perFloorInsol: perFloorInsol,
        lluCells: lluCellIds,
        sortedCorrNears: corrNears,
        orientation: dp.orientation
      });
      state.graphDataMap[dp.planKey] = {
        nodes: dp.graphNodes, N: dp.N, params: dp.params,
        floorCount: dp.floorCount, perFloorInsol: perFloorInsol
      };

      // Render floors 2..N
      var bPlan = state.buildingPlans[dp.planKey];
      console.log('[section-gen] building plan:', dp.planKey,
        'floors:', bPlan.floors.length,
        'placed:', JSON.stringify(bPlan.totalPlaced));

      if (state.threeOverlay) {
        for (var fl = 2; fl < dp.floorCount; fl++) {
          var flBaseZ = dp.params.firstFloorHeight + (fl - 1) * dp.params.typicalFloorHeight;
          var flTopZ = flBaseZ + dp.params.typicalFloorHeight;

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
            flDetailMap = dp.detailMap;
          }

          state.threeOverlay.addMesh(buildDetailedFloor1(dp.graphNodes, dp.N,
            flBaseZ, flTopZ, flDetailMap, 0.08, false, false, false));
        }
      }

      state.eventBus.emit('building:plan:result', {
        sectionKey: dp.planKey, plan: bPlan
      });
    }
    state._deferredPlans = null;
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
