/**
 * Processor — main section build cycle.
 * Reads features from store, builds cells/graph/apartments, renders 3D.
 */

import { createProjection } from '../../core/geo/projection.js';
import * as THREE from 'three';
import { getParams, getSectionHeight, computeFloorCount, computeBuildingHeight } from '../../core/SectionParams.js';
import { TYPE_COLORS, APT_COLORS } from '../../core/constants/ApartmentColors.js';
import {
  createNearCells, createFarCells, createCorridorCells,
  getNorthSide, getLLUParams, getCentralIndices
} from './cells.js';
import { buildSectionGraph } from './graph.js';
import { buildSectionMeshes, buildDividerWall, buildSectionWireframe, buildFloorLabel, buildDetailedFloor1, buildDetailedFloor0, buildLLURoof, buildCellMeshColored, buildDetailedTowerFloor1, buildDetailedTowerFloor0, buildTowerLLURoof, buildTopSlab } from '../../core/three/MeshBuilder.js';
import { solveFloor, validateApartment, getFlag } from '../../core/apartments/ApartmentSolver.js';
import { planWZStacks } from '../../core/apartments/WZPlanner.js';
import { planBuilding } from '../../core/apartments/BuildingPlanner.js';
import { allocateQuotas } from '../../core/apartments/QuotaAllocator.js';
import { resolveQuota, computeRemainder, formatReport as formatQuotaReport } from '../../core/apartments/QuotaResolver.js';
import { log } from '../../core/Logger.js';
import { generateReport } from '../../ui/FloorPlanReport.js';

import { getTowerDimensions, classifyCells, generateCellsFromFootprint } from '../../core/tower/TowerGenerator.js';
import { walkRing, buildTowerGraph } from '../../core/tower/TowerGraph.js';
import { computeTowerFootprints } from '../../core/tower/TowerFootprints.js';
import { detectNorthEnd } from '../../core/tower/TowerPlacer.js';
import { classifySegment } from '../../core/geo/orientation.js';
import { distributeHeights } from '../../core/urban-block/height-distributor.js';

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

// ── Detail map builder (shared by floor 1 and upper floors) ──

function buildAptDetailMap(apartments) {
  var map = {};
  for (var ai = 0; ai < apartments.length; ai++) {
    var apt = apartments[ai];
    var cells = apt.cells || [];
    var pal = APT_COLORS[apt.type] || APT_COLORS['orphan'];
    for (var ci = 0; ci < cells.length; ci++) {
      var cid = cells[ci];
      var role;
      var color;
      if (typeof cid === 'string') {
        role = 'corridor';
        color = pal.wet;
      } else if (apt.type === 'orphan') {
        role = 'orphan';
        color = pal.living;
      } else if (cid === apt.wetCell) {
        role = 'wet';
        color = pal.wet;
      } else {
        role = 'living';
        color = pal.living;
      }
      map[cid] = { aptIdx: ai, type: apt.type, role: role, color: color, label: 'A' + ai + ' ' + apt.type };
    }
  }
  return map;
}

// ── Main ──────────────────────────────────────────────

export function processAllSections() {
  if (!state.layer || !state.featureStore) return;
  var all = state.featureStore.toArray();
  var sects = [];
  var towers = [];
  for (var i = 0; i < all.length; i++) {
    if (all[i].properties.type === 'section-axis') sects.push(all[i]);
    else if (all[i].properties.type === 'tower-axis') towers.push(all[i]);
  }

  if (state.threeOverlay) state.threeOverlay.clear();
  if (sects.length === 0 && towers.length === 0) { state.layer.clear(); state.lineFootprints = {}; state.stableOrigin = null; return; }

  // Stable projection: lock to first feature's first coord, never shifts
  if (!state.stableOrigin) {
    var firstFeature = sects.length > 0 ? sects[0] : towers[0];
    var firstCoord = firstFeature.geometry.coordinates[0];
    state.stableOrigin = [firstCoord[0], firstCoord[1]];
  }
  var globalProj = createProjection(state.stableOrigin[0], state.stableOrigin[1]);
  if (state.threeOverlay) state.threeOverlay.setOrigin(state.stableOrigin[0], state.stableOrigin[1]);
  state.eventBus.emit('section-gen:origin', state.stableOrigin);

  var allCellsLL = [];
  var allFootLL = [];
  var ugSectionGraphs = [];  // [{nodes}] for underground rendering
  state.lineFootprints = {};

  var AREA_COEFF = 0.65;
  var M2_PER_PERSON = 50;
  var allStats = { axes: [], totalFootprint: 0, totalAptArea: 0, totalPopulation: 0, sections: [] };
  var sectionProfiles = []; // for QuotaAllocator
  var quotaInputs = [];    // for Phase 0 QuotaResolver

  // ── Height distribution (SPP-driven) ──────────────────────
  //
  // When an urban-block has solverParams.targetSPP > 0, the
  // per-footprint height is assigned by the distributor rather than
  // the axis default. The distributor groups all footprints of a
  // block, sees their footprint area + orientation + centroid Y,
  // and picks floor counts so that sum(area × floors) ≈ targetSPP.
  //
  // We store assignments in a map keyed by `axisId:footprintIndex`
  // and consult it inside the main loop before falling back to
  // axis-level sectionHeight. Blocks without targetSPP skip this
  // pass entirely — existing behaviour is preserved.
  var assignedHeightMap = {};  // "axisId:fi" → height (m)
  var distributionStats = {};  // blockId → { achievedSPP, deltaSPP, targetSPP, feasible, aboveMaxCount }

  // Build blockId → block feature lookup for solverParams.targetSPP.
  var blockById = {};
  for (var bi0 = 0; bi0 < all.length; bi0++) {
    var f0 = all[bi0];
    if (f0.properties && f0.properties.urbanBlock) {
      blockById[f0.properties.id] = f0;
    }
  }

  // Group section-axis features by their blockId.
  var sectsByBlock = {};
  for (var si0 = 0; si0 < sects.length; si0++) {
    var sec0 = sects[si0];
    var bId = sec0.properties && sec0.properties.blockId;
    if (!bId) continue;
    if (!sectsByBlock[bId]) sectsByBlock[bId] = [];
    sectsByBlock[bId].push(sec0);
  }

  // For each block with a target, run the distributor.
  var blockIds = Object.keys(sectsByBlock);
  for (var bkIdx = 0; bkIdx < blockIds.length; bkIdx++) {
    var blockIdKey = blockIds[bkIdx];
    var blockF = blockById[blockIdKey];
    if (!blockF) continue;
    var sp = blockF.properties.solverParams || {};
    var targetSPP = Number(sp.targetSPP) || 0;
    if (!(targetSPP > 0)) continue; // distributor disabled for this block

    var blockSects = sectsByBlock[blockIdKey];
    var sectionsForDist = [];

    // Pull corner features for this block (corners-mode urban-block).
    // Their floor count is locked at 9; we still feed them to the
    // distributor so the locked SPP gets subtracted from the target
    // before the regular sections distribute the remainder.
    for (var ci0 = 0; ci0 < all.length; ci0++) {
      var cf = all[ci0];
      if (!cf.properties || cf.properties.type !== 'section-chain-corner') continue;
      if (cf.properties.blockId !== blockIdKey) continue;
      var cPoly = cf.properties.polygon;
      if (!cPoly || cPoly.length < 3) continue;
      var ccx = 0, ccy = 0;
      var cM = [];
      for (var pv0 = 0; pv0 < cPoly.length; pv0++) {
        var pmC = globalProj.toMeters(cPoly[pv0][0], cPoly[pv0][1]);
        cM.push(pmC);
        ccx += pmC[0]; ccy += pmC[1];
      }
      ccx /= cM.length; ccy /= cM.length;
      var cAcc = 0;
      for (var pi0 = 0; pi0 < cM.length; pi0++) {
        var jj0 = (pi0 + 1) % cM.length;
        cAcc += cM[pi0][0] * cM[jj0][1] - cM[jj0][0] * cM[pi0][1];
      }
      sectionsForDist.push({
        fpId: cf.properties.id + ':corner',
        axisId: cf.properties.id,  // each corner is its own "axis"
        fpIndex: 0,
        orientation: 'lat',  // doesn't matter — locked at 9 floors
        footprintArea: Math.abs(cAcc) / 2,
        centroidY: ccy,
        isCorner: true
      });
    }

    // Build distributor input — one entry per (axis, footprint).
    for (var bsi = 0; bsi < blockSects.length; bsi++) {
      var ax = blockSects[bsi];
      var axProps = ax.properties || {};
      var orientation = axProps.orientation === 'lon' ? 'lon' : 'lat';
      var fpList = axProps.footprints || [];
      for (var fp0 = 0; fp0 < fpList.length; fp0++) {
        var poly = fpList[fp0].polygon;
        if (!poly || poly.length < 3) continue;
        // Project to meters using the shared globalProj so centroid Y
        // is comparable across blocks (same projection origin).
        var cx = 0, cy = 0, ar = 0;
        for (var pv = 0; pv < poly.length; pv++) {
          var p2m = globalProj.toMeters(poly[pv][0], poly[pv][1]);
          cx += p2m[0]; cy += p2m[1];
        }
        cx /= poly.length; cy /= poly.length;
        // Footprint area via shoelace on projected coords.
        var pmArr = [];
        for (var pv2 = 0; pv2 < poly.length; pv2++) {
          pmArr.push(globalProj.toMeters(poly[pv2][0], poly[pv2][1]));
        }
        var n2 = pmArr.length;
        var acc = 0;
        for (var pi3 = 0; pi3 < n2; pi3++) {
          var j3 = (pi3 + 1) % n2;
          acc += pmArr[pi3][0] * pmArr[j3][1] - pmArr[j3][0] * pmArr[pi3][1];
        }
        var area = Math.abs(acc) / 2;
        sectionsForDist.push({
          fpId: axProps.id + ':' + fp0,
          axisId: axProps.id,
          fpIndex: fp0,
          orientation: orientation,
          footprintArea: area,
          centroidY: cy
        });
      }
    }

    // Towers in this block — locked at their `towerHeight`. Their SPP
    // is subtracted from the target FIRST so the distributor only has
    // to allocate the remainder to corners + regular sections (which
    // have their own priority order: meridional > latitudinal, north
    // first, applied inside distributeHeights).
    var towerSPP = 0;
    for (var ti0 = 0; ti0 < all.length; ti0++) {
      var tf = all[ti0];
      if (!tf.properties || tf.properties.type !== 'tower-axis') continue;
      if (tf.properties.blockId !== blockIdKey) continue;
      var tFP = tf.properties.footprints || [];
      var tH = tf.properties.towerHeight || 112;
      // Tower floor stack uses 4.5/3.0 like sections.
      var tFloors = tH <= 4.5 ? 1 : 1 + Math.round((tH - 4.5) / 3.0);
      for (var fi3 = 0; fi3 < tFP.length; fi3++) {
        var pp3 = tFP[fi3].polygon || [];
        if (pp3.length < 3) continue;
        var ax2D = 0;
        for (var v0 = 0; v0 < pp3.length; v0++) {
          var v1 = (v0 + 1) % pp3.length;
          var pm0 = globalProj.toMeters(pp3[v0][0], pp3[v0][1]);
          var pm1 = globalProj.toMeters(pp3[v1][0], pp3[v1][1]);
          ax2D += pm0[0] * pm1[1] - pm1[0] * pm0[1];
        }
        var area3 = Math.abs(ax2D) / 2;
        towerSPP += area3 * tFloors;
      }
    }
    var adjTarget = Math.max(0, targetSPP - towerSPP);

    if (sectionsForDist.length === 0) continue;

    // Use the first section's axis params for firstFloor/typical
    // heights — all sections in a block share these in practice.
    var sampleParams = getParams(blockSects[0].properties);
    var distResult = distributeHeights(sectionsForDist, adjTarget, sampleParams);
    distributionStats[blockIdKey] = {
      targetSPP: targetSPP,
      towerSPP: towerSPP,
      adjTarget: adjTarget,
      achievedSPP: distResult.achievedSPP + towerSPP,
      deltaSPP: distResult.deltaSPP,
      feasible: distResult.feasible,
      aboveMaxCount: distResult.aboveMaxCount,
      sectionCount: sectionsForDist.length
    };
    for (var rIdx = 0; rIdx < distResult.perSection.length; rIdx++) {
      var entry = distResult.perSection[rIdx];
      var key = entry.axisId + ':' + entry.fpId.split(':')[1];
      assignedHeightMap[key] = entry.assignedHeight;
    }
    console.log('[height-distributor] block ' + blockIdKey.slice(0, 6)
      + ': target=' + Math.round(targetSPP) + 'm²'
      + ', tower=' + Math.round(towerSPP) + 'm²'
      + ', achieved=' + Math.round(distResult.achievedSPP + towerSPP) + 'm²'
      + ', delta=' + Math.round(distResult.deltaSPP) + 'm²'
      + ', aboveMax=' + distResult.aboveMaxCount + '/' + sectionsForDist.length);
  }

  for (var si = 0; si < sects.length; si++) {
    var feature = sects[si];
    var lineId = feature.properties.id;
    var storedFP = feature.properties.footprints;
    if (!storedFP || storedFP.length === 0) continue;
    var params = getParams(feature.properties);
    var lineFPsLL = [];

    for (var fi = 0; fi < storedFP.length; fi++) {
      var fp = storedFP[fi];
      // Height precedence: distributor assignment > per-fp override > axis default.
      // We don't mutate fp.sectionHeight on the stored feature (that would
      // persist into saved state and bleed into future rebuilds without
      // targetSPP); we just apply the override locally for this pass.
      var distKey = lineId + ':' + fi;
      var secH;
      if (assignedHeightMap[distKey] !== undefined) {
        secH = assignedHeightMap[distKey];
      } else {
        secH = getSectionHeight(fp, params);
      }
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
      ugSectionGraphs.push(graph.nodes);

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
          log.debug('[InsolMap] sec=' + fi + ' ori=' + sectionOri + ' N=' + N +
            ' north=' + northSide + ' LLU=[' + lluIndices.join(',') + ']' +
            (axisFlipped ? ' FLIPPED' : ''));
          log.debug('  near: ' + nearFlags.join(' '));
          log.debug('  far:  ' + farFlags.join(' '));
        } else {
          log.debug('[InsolMap] sec=' + fi + ' — no insolation data');
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

          // Collect for Phase 0 QuotaResolver
          var lluCntQ = 0;
          for (var qk in graph.nodes) {
            if (!graph.nodes.hasOwnProperty(qk)) continue;
            if (graph.nodes[qk].floor === 1 && graph.nodes[qk].type === 'llu') lluCntQ++;
          }
          quotaInputs.push({
            key: lineId + '_' + fi,
            N: N,
            lluCount: lluCntQ,
            floorCount: floorCount,
            fl1Placed: fl1Placed
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
        // Floor 0 (commercial / non-residential) — concrete-grey base
        // with storefront windows. Stays grey under White-model mode.
        state.threeOverlay.addMesh(buildDetailedFloor0(graph.nodes, N,
          0, params.firstFloorHeight));

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

        // White-model fill for sections that haven't been distributed
        // yet. After distribute, Pass 2 builds the same floors with
        // apartment colours (no whiteModelExtra) — and main-loop reruns
        // with state.distributed=true skip this branch, so no overlap.
        if (!state.distributed && floorCount > 2) {
          var wmGroup = new THREE.Group();
          wmGroup.userData.whiteModelExtra = true;
          for (var fl = 2; fl < floorCount; fl++) {
            var fBaseZ = params.firstFloorHeight + (fl - 1) * params.typicalFloorHeight;
            var fTopZ = fBaseZ + params.typicalFloorHeight;
            // detailMap is empty here → cells use default MATERIALS;
            // showLabels=false to avoid stamping labels on every floor.
            wmGroup.add(buildDetailedFloor1(graph.nodes, N,
              fBaseZ, fTopZ, detailMap, 0.08, false, false, false));
          }
          // Lift LLU stack to sit on top of the 0.5 m slab so the
          // shaft and the slab body don't overlap in z (z-fight).
          wmGroup.add(buildLLURoof(graph.nodes, N, buildingH + 0.5, 2.5));
          wmGroup.add(buildTopSlab(fpM, buildingH, 0.5));
          state.threeOverlay.addMesh(wmGroup);
        }
      }
      if (state.threeOverlay && fi > 0) {
        // Skip the divider wall if there's a gap between sections —
        // i.e. the previous section's end edge is not flush with the
        // current section's start edge. Solver emits such gaps on
        // axes >= 150m (when useGap=true) by dropping middle sections.
        var prevFp = storedFP[fi - 1];
        var prevFpM = null;
        if (prevFp && prevFp.polygon && prevFp.polygon.length >= 4) {
          prevFpM = [];
          for (var pj = 0; pj < prevFp.polygon.length; pj++) {
            prevFpM.push(globalProj.toMeters(prevFp.polygon[pj][0], prevFp.polygon[pj][1]));
          }
        }
        var flush = false;
        if (prevFpM) {
          // Current section's left edge is between fpM[0] and fpM[3].
          // Previous section's right edge is between prevFpM[1] and prevFpM[2].
          var d0x = fpM[0][0] - prevFpM[1][0], d0y = fpM[0][1] - prevFpM[1][1];
          var d3x = fpM[3][0] - prevFpM[2][0], d3y = fpM[3][1] - prevFpM[2][1];
          var gap0 = Math.sqrt(d0x * d0x + d0y * d0y);
          var gap3 = Math.sqrt(d3x * d3x + d3y * d3y);
          flush = gap0 < 0.5 && gap3 < 0.5; // 0.5m tolerance
        }
        if (flush) {
          state.threeOverlay.addMesh(buildDividerWall(fpM[3], fpM[0], 0, renderH + 0.05, 0.12));
        }
      }
    }
    state.lineFootprints[lineId] = lineFPsLL;
  }

  // ══════════════════════════════════════════════════════════
  // Tower processing — recompute footprints from axis + current properties
  // ══════════════════════════════════════════════════════════
  for (var ti = 0; ti < towers.length; ti++) {
    var tFeature = towers[ti];
    var tLineId = tFeature.properties.id;
    var tCoords = tFeature.geometry.coordinates;
    if (!tCoords || tCoords.length < 2) continue;

    // Recompute footprints from axis geometry (reflects cellSize/gap changes)
    var tStartM = globalProj.toMeters(tCoords[0][0], tCoords[0][1]);
    var tEndM = globalProj.toMeters(tCoords[1][0], tCoords[1][1]);
    var oldStoredFP = tFeature.properties.footprints || [];
    var recomputedFP = computeTowerFootprints(tStartM, tEndM, tFeature.properties,
      function (mx, my) { return globalProj.toLngLat(mx, my); });

    // Merge per-footprint overrides from old stored data
    // (e.g. towerHeight set via edit mode)
    for (var rfi = 0; rfi < recomputedFP.length; rfi++) {
      if (rfi < oldStoredFP.length) {
        if (oldStoredFP[rfi].towerHeight !== undefined) {
          recomputedFP[rfi].towerHeight = oldStoredFP[rfi].towerHeight;
        }
      }
    }

    // Update stored footprints
    tFeature.properties.footprints = recomputedFP;

    if (recomputedFP.length === 0) continue;

    var tCellSize = tFeature.properties.cellSize || 3.3;
    var tNorthEnd = tFeature.properties.northEnd || detectNorthEnd(tStartM, tEndM);
    var tOrientation = tFeature.properties.orientation || classifySegment(tStartM, tEndM).orientationName;
    var tLineFPs = [];

    var TOWER_DEFAULT_H = 112;
    var firstFloorH = 4.5;
    var typicalFloorH = 3.0;
    var towerH = tFeature.properties.towerHeight || TOWER_DEFAULT_H;
    var tFloorCount = computeFloorCount(towerH, firstFloorH, typicalFloorH);
    var tBuildingH = computeBuildingHeight(towerH, firstFloorH, typicalFloorH);
    var tFloor1Top = firstFloorH + typicalFloorH;

    for (var twi = 0; twi < recomputedFP.length; twi++) {
      var tfp = recomputedFP[twi];
      var tSize = tfp.size || 'small';
      var tDims = getTowerDimensions(tSize, tCellSize, tOrientation);

      // Per-tower height override (like per-section sectionHeight)
      var thisTowerH = tfp.towerHeight !== undefined ? tfp.towerHeight : towerH;
      var thisTFloorCount = computeFloorCount(thisTowerH, firstFloorH, typicalFloorH);
      var thisTBuildingH = computeBuildingHeight(thisTowerH, firstFloorH, typicalFloorH);

      // Convert stored footprint polygon lng/lat → meters
      var tfpM = [];
      for (var tvi = 0; tvi < tfp.polygon.length; tvi++) {
        tfpM.push(globalProj.toMeters(tfp.polygon[tvi][0], tfp.polygon[tvi][1]));
      }

      // Generate cells directly from footprint (preserves orientation from tool)
      // Compute LLU exit side: meridional → through row-end, latitudinal → through column toward north
      var exitSide;
      if (tOrientation === 'lon') {
        exitSide = tNorthEnd === 'start' ? 'row-start' : 'row-end';
      } else {
        // Latitudinal: across direction = tfpM[3] - tfpM[0], check which column side faces north
        var acrossY = tfpM[3][1] - tfpM[0][1];
        exitSide = acrossY >= 0 ? 'col-high' : 'col-low';
      }
      var tCells = classifyCells(tDims.rows, tDims.cols, exitSide);
      var tPolysM = generateCellsFromFootprint(tfpM, tDims.rows, tDims.cols);

      // ── Tower apartment graph (ring → linear section format) ──
      var ringResult = walkRing(tDims.rows, tDims.cols, exitSide);
      var towerGraph = buildTowerGraph(ringResult.pairs, tPolysM, tDims.cols, 2);
      var K = towerGraph.K;
      var N = towerGraph.N;
      var posToCid = towerGraph.posToCellId;

      // Reverse map: cellId → ringPos
      var cidToPos = {};
      for (var ri = 0; ri < K; ri++) cidToPos[posToCid[ri]] = ri;

      // ── WZ eligibility by cellId ──
      var coreRowMin = 2, coreRowMax = tDims.rows - 3;
      var coreColMin = 2, coreColMax = tDims.cols - 3;
      var wzEligible = {};
      for (var ri = 0; ri < K; ri++) {
        var rp = ringResult.pairs[ri];
        var ir = rp.innerRow, ic = rp.innerCol;
        var adj = false;
        if (ir - 1 >= coreRowMin && ir - 1 <= coreRowMax && ic >= coreColMin && ic <= coreColMax) adj = true;
        if (ir + 1 >= coreRowMin && ir + 1 <= coreRowMax && ic >= coreColMin && ic <= coreColMax) adj = true;
        if (ic - 1 >= coreColMin && ic - 1 <= coreColMax && ir >= coreRowMin && ir <= coreRowMax) adj = true;
        if (ic + 1 >= coreColMin && ic + 1 <= coreColMax && ir >= coreRowMin && ir <= coreRowMax) adj = true;
        wzEligible[posToCid[ri]] = adj;
      }

      // ── Insolation map (from previous analysis, floor 1) ──
      var tInsolMap = null;
      if (state.insolCellMap && state.insolCellMap[tLineId] &&
          state.insolCellMap[tLineId][twi] && state.insolCellMap[tLineId][twi][1]) {
        var rawFloor = state.insolCellMap[tLineId][twi][1];
        if (rawFloor && rawFloor.points && rawFloor.points.length > 0) {
          tInsolMap = {};
          var FLAG_PRIO = { 'f': 1, 'w': 2, 'p': 3 };
          for (var ipi = 0; ipi < rawFloor.points.length; ipi++) {
            var ip = rawFloor.points[ipi];
            // cellIdx = ring position index → convert to solver cellId
            if (ip.cellIdx !== undefined && ip.cellIdx < K) {
              var cid = posToCid[ip.cellIdx];
              var oldFlag = tInsolMap[cid];
              // Keep worst flag (lowest priority number)
              if (!oldFlag || FLAG_PRIO[ip.flag] < FLAG_PRIO[oldFlag]) {
                tInsolMap[cid] = ip.flag;
              }
            }
          }
        }
      }

      // ── Run solver ──
      var tAptResult = null;
      var tCellAptMap = {};
      if (K > 0) {
        tAptResult = solveFloor(towerGraph.nodes, N, 1, tInsolMap, 'lon');

        if (tAptResult && tAptResult.apartments) {
          var apts = tAptResult.apartments;
          var TYPE_FROM_COUNT = { 2: '1K', 3: '2K', 4: '3K', 5: '4K' };
          function typeFromCount(n) { return TYPE_FROM_COUNT[n] || (n <= 1 ? 'orphan' : '4K'); }
          var wzAssigned = {};

          // Pass 1: cluster WZ in couples at eligible boundaries
          for (var ai = 0; ai + 1 < apts.length; ai += 2) {
            var cur = apts[ai];
            var nxt = apts[ai + 1];
            if (cur.type === 'orphan' || nxt.type === 'orphan') continue;
            var curNums = [];
            var nxtNums = [];
            for (var ci2 = 0; ci2 < cur.cells.length; ci2++) {
              if (typeof cur.cells[ci2] === 'number') curNums.push(cur.cells[ci2]);
            }
            for (var ci2 = 0; ci2 < nxt.cells.length; ci2++) {
              if (typeof nxt.cells[ci2] === 'number') nxtNums.push(nxt.cells[ci2]);
            }
            if (curNums.length === 0 || nxtNums.length === 0) continue;
            var curMax = curNums[curNums.length - 1];
            var nxtMin = nxtNums[0];
            if (curMax + 1 === nxtMin && wzEligible[curMax] && wzEligible[nxtMin]) {
              cur.wetCell = curMax;
              nxt.wetCell = nxtMin;
              wzAssigned[ai] = true;
              wzAssigned[ai + 1] = true;
            }
          }

          // Pass 2: remaining — place WZ at best eligible cell, or keep solver default
          for (var ai = 0; ai < apts.length; ai++) {
            if (wzAssigned[ai]) continue;
            var apt = apts[ai];
            if (apt.type === 'orphan') continue;
            var nums = [];
            for (var ci2 = 0; ci2 < apt.cells.length; ci2++) {
              if (typeof apt.cells[ci2] === 'number') nums.push(apt.cells[ci2]);
            }
            var eligCells = [];
            for (var ci2 = 0; ci2 < nums.length; ci2++) {
              if (wzEligible[nums[ci2]]) eligCells.push(nums[ci2]);
            }
            if (eligCells.length > 0) {
              var best = eligCells[0];
              if (eligCells.indexOf(nums[nums.length - 1]) >= 0) best = nums[nums.length - 1];
              if (eligCells.indexOf(nums[0]) >= 0) best = nums[0];
              apt.wetCell = best;
            }
          }

          // Pass 3: orphan absorption across side boundaries (L-shape OK if core access)
          // Build cellId → aptIdx map
          var cidToApt = {};
          for (var ai = 0; ai < apts.length; ai++) {
            for (var ci2 = 0; ci2 < apts[ai].cells.length; ci2++) {
              var cid = apts[ai].cells[ci2];
              if (typeof cid === 'number') cidToApt[cid] = ai;
            }
          }

          // For each orphan, try merging with physical ring neighbor
          for (var ai = 0; ai < apts.length; ai++) {
            if (apts[ai].type !== 'orphan') continue;
            var orphanCells = [];
            for (var ci2 = 0; ci2 < apts[ai].cells.length; ci2++) {
              if (typeof apts[ai].cells[ci2] === 'number') orphanCells.push(apts[ai].cells[ci2]);
            }
            if (orphanCells.length === 0) continue;
            var orphanCid = orphanCells[0];

            // Find orphan's ring position
            var orphanPos = cidToPos[orphanCid];
            if (orphanPos === undefined) continue;

            // Check ring neighbors (pos-1, pos+1)
            var merged = false;
            var neighborPositions = [];
            if (orphanPos > 0) neighborPositions.push(orphanPos - 1);
            if (orphanPos < K - 1) neighborPositions.push(orphanPos + 1);

            for (var ni = 0; ni < neighborPositions.length; ni++) {
              var nPos = neighborPositions[ni];
              var nCid = posToCid[nPos];
              var nAptIdx = cidToApt[nCid];
              if (nAptIdx === undefined) continue;
              var nApt = apts[nAptIdx];
              if (nApt.type === 'orphan') continue;

              // Check: would merged apartment have core access?
              var mergedHasCore = false;
              for (var ci2 = 0; ci2 < nApt.cells.length; ci2++) {
                if (typeof nApt.cells[ci2] === 'number' && wzEligible[nApt.cells[ci2]]) {
                  mergedHasCore = true;
                  break;
                }
              }
              if (!mergedHasCore && wzEligible[orphanCid]) mergedHasCore = true;

              if (mergedHasCore) {
                // Validate insolation before merging
                var mergedLiving = [];
                for (var ci2 = 0; ci2 < nApt.cells.length; ci2++) {
                  if (typeof nApt.cells[ci2] === 'number' && nApt.cells[ci2] !== nApt.wetCell)
                    mergedLiving.push(nApt.cells[ci2]);
                }
                mergedLiving.push(orphanCid);
                var mFlags = [];
                for (var mfi = 0; mfi < mergedLiving.length; mfi++) mFlags.push(getFlag(tInsolMap, mergedLiving[mfi]));
                var mValid = validateApartment(mFlags);
                if (!mValid.valid) continue;

                // Merge orphan into neighbor apartment
                for (var ci2 = 0; ci2 < orphanCells.length; ci2++) {
                  nApt.cells.push(orphanCells[ci2]);
                  cidToApt[orphanCells[ci2]] = nAptIdx;
                }
                // Upgrade type based on actual cell count
                var mergedCount = 0;
                for (var ci3 = 0; ci3 < nApt.cells.length; ci3++) {
                  if (typeof nApt.cells[ci3] === 'number') mergedCount++;
                }
                nApt.type = typeFromCount(mergedCount);
                nApt.valid = true;
                apts[ai].type = '_merged';
                apts[ai].cells = [];
                merged = true;
                break;
              }
            }
          }

          // Final: recalculate types from cell counts + filter merged
          var cleanApts = [];
          for (var ai = 0; ai < apts.length; ai++) {
            if (apts[ai].type === '_merged') continue;
            var apt = apts[ai];
            if (apt.type !== 'orphan') {
              var nc = 0;
              for (var ci2 = 0; ci2 < apt.cells.length; ci2++) {
                if (typeof apt.cells[ci2] === 'number') nc++;
              }
              apt.type = typeFromCount(nc);
            }
            cleanApts.push(apt);
          }
          apts = cleanApts;
          tAptResult.apartments = apts;

          // Diagnostic
          var diagTypes = {};
          var diagOrphans = 0;
          for (var ai = 0; ai < apts.length; ai++) {
            diagTypes[apts[ai].type] = (diagTypes[apts[ai].type] || 0) + 1;
            if (apts[ai].type === 'orphan') diagOrphans++;
          }
          log.debug('[Tower] twi=' + twi + ' K=' + K + ' N=' + N + ' apts=' + apts.length +
            ' orphans=' + diagOrphans + ' mix=' + JSON.stringify(diagTypes));

          // Build cellId → apt info map
          for (var tai = 0; tai < apts.length; tai++) {
            var tApt = apts[tai];
            var tAptCells = tApt.cells || [];
            for (var taci = 0; taci < tAptCells.length; taci++) {
              var taCid = tAptCells[taci];
              if (typeof taCid !== 'number') continue;
              tCellAptMap[taCid] = {
                aptIdx: tai, type: tApt.type,
                role: tApt.type === 'orphan' ? 'orphan' : (taCid === tApt.wetCell ? 'wet' : 'living'),
                torec: tApt.torec || false
              };
            }
          }
        }
      }

      // ── Build gridId → apartment color + label map ──
      // Each ring position expands to outer + inner grid cells
      // WZ position: BOTH cells are WZ (rectangular pair perpendicular to core)
      // Every outer cell gets a window (including WZ outer cells)
      var gridAptColor = {};
      var gridAptLabel = {};
      for (var ri = 0; ri < ringResult.pairs.length; ri++) {
        var rp = ringResult.pairs[ri];
        var outerGid = rp.outerRow * tDims.cols + rp.outerCol;
        var innerGid = rp.innerRow * tDims.cols + rp.innerCol;

        var aptInfo = tCellAptMap[posToCid[ri]]; // cellId from ring position
        if (!aptInfo) continue;

        var pal = APT_COLORS[aptInfo.type] || APT_COLORS['orphan'];
        var isWet = aptInfo.role === 'wet';
        var color = isWet ? pal.wet : pal.living;
        var lbl = 'A' + aptInfo.aptIdx + (isWet ? ' wz' : ' ' + aptInfo.type);

        // Both cells of the pair get same color (WZ or living)
        gridAptColor[outerGid] = color;
        gridAptColor[innerGid] = color;
        gridAptLabel[outerGid] = lbl;
        gridAptLabel[innerGid] = lbl;
      }

      // ── 2D cells with apartment colors ──
      for (var tci = 0; tci < tCells.length; tci++) {
        var tc = tCells[tci];
        var tpoly = tPolysM[tci];
        var gridIdx = tc.row * tDims.cols + tc.col;
        var tCellColor;
        var tCellLabel;

        if (tc.type === 'llu' || tc.type === 'llu-exit') {
          tCellColor = TYPE_COLORS.llu;
          tCellLabel = tc.type === 'llu' ? 'LLU' : 'exit';
        } else if (gridAptColor[gridIdx]) {
          tCellColor = gridAptColor[gridIdx];
          tCellLabel = gridAptLabel[gridIdx] || String(tc.id);
        } else {
          tCellColor = TYPE_COLORS.apartment;
          tCellLabel = String(tc.id);
        }

        var tRingLL = [];
        for (var tvi = 0; tvi < tpoly.length; tvi++) {
          tRingLL.push(globalProj.toLngLat(tpoly[tvi][0], tpoly[tvi][1]));
        }
        tRingLL.push(tRingLL[0]);
        allCellsLL.push({ ring: tRingLL, color: tCellColor, label: tCellLabel });
      }

      // ── 2D footprint outline ──
      var tfpRingLL = closeRing(tfp.polygon);
      allFootLL.push({
        ring: tfpRingLL, lineId: tLineId, secIdx: twi,
        floorCount: thisTFloorCount, buildingH: thisTBuildingH
      });
      tLineFPs.push(allFootLL[allFootLL.length - 1]);

      // ── 3D ──
      if (state.threeOverlay) {
        // Floor 0: storefronts on every exterior edge of the perimeter,
        // entrance group at the llu-exit cell, solid grey on inner cells.
        state.threeOverlay.addMesh(
          buildDetailedTowerFloor0(tPolysM, tDims.cols, tDims.rows,
            0, firstFloorH, tCells));
        // Floor 1: detailed — apartment-colored boxes with facade windows + labels
        state.threeOverlay.addMesh(
          buildDetailedTowerFloor1(ringResult.pairs, tPolysM, tDims.cols, tDims.rows,
            firstFloorH, tFloor1Top, gridAptColor, gridAptLabel, tCells));

        // Floors 2..N-1 — replicate floor 1 detailed geometry on every
        // residential floor. Heavy meshes, gated by whiteModelExtra so
        // they only appear when the user enters White-model mode.
        // gridAptLabel is empty here so per-cell A1/A2 labels don't get
        // stamped on every floor.
        for (var fl = 2; fl < thisTFloorCount; fl++) {
          var fBaseZ = firstFloorH + (fl - 1) * typicalFloorH;
          var fTopZ = fBaseZ + typicalFloorH;
          var floorMesh = buildDetailedTowerFloor1(ringResult.pairs, tPolysM,
            tDims.cols, tDims.rows, fBaseZ, fTopZ, gridAptColor, {}, tCells);
          floorMesh.userData.whiteModelExtra = true;
          state.threeOverlay.addMesh(floorMesh);
        }
        // Tower LLU roof extrusion — mirrors what sections get from
        // buildLLURoof in Pass 2. Visible only in White-model mode.
        // LLU stack starts at slab top (buildingH + 0.5) so the shaft
        // doesn't z-fight with the slab body in the LLU footprint.
        var tLluRoof = buildTowerLLURoof(tCells, tPolysM, tDims.cols,
          thisTBuildingH + 0.5, 2.5);
        tLluRoof.userData.whiteModelExtra = true;
        state.threeOverlay.addMesh(tLluRoof);
        // Tower top slab (0.5 m).
        var tSlab = buildTopSlab(tfpM, thisTBuildingH, 0.5);
        tSlab.userData.whiteModelExtra = true;
        state.threeOverlay.addMesh(tSlab);

        state.threeOverlay.addMesh(buildSectionWireframe(tfpM, 0, thisTBuildingH));
        state.threeOverlay.addMesh(buildFloorLabel(thisTFloorCount + 'F', tfpM, thisTBuildingH));
      }
    }
    state.lineFootprints[tLineId] = tLineFPs;
  }

  // Phase 0 moved into Pass 2 (after QuotaAllocator computes section mixes)

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

      log.debug('[section-gen] planBuilding input:', dp.planKey,
        'wzStacks:', dp.wzStacks.length,
        'fl1Apts:', dp.floor1Apartments.length,
        'lluCells:', lluCellIds.join(','),
        'corrNears:', corrNears.join(','),
        'mix:', JSON.stringify(sectionMix),
        '(global:', JSON.stringify(state.aptMix) + ')');

      // ── Phase 0: QuotaResolver with section-specific mix ──
      var cellsPerFloor = 2 * dp.N - dp.lluIndices.length;
      var residentialFloors = dp.floorCount - 1;
      var totalCells = cellsPerFloor * residentialFloors;

      var qResult = resolveQuota(totalCells, sectionMix);
      var fl1Placed = { '1K': 0, '2K': 0, '3K': 0, '4K': 0 };
      for (var fai = 0; fai < dp.floor1Apartments.length; fai++) {
        var fat = dp.floor1Apartments[fai].type;
        if (fl1Placed[fat] !== undefined) fl1Placed[fat]++;
      }
      var remainResult = computeRemainder(
        qResult.best ? qResult.best.counts : { '1K': 0, '2K': 0, '3K': 0, '4K': 0 },
        fl1Placed, 1
      );

      log.debug('[QuotaResolver] section:', dp.planKey,
        'cells/floor:', cellsPerFloor, 'floors:', residentialFloors, 'totalCells:', totalCells);
      log.debug(formatQuotaReport(qResult));
      log.debug('[QuotaResolver] Floor 2 placed:', JSON.stringify(fl1Placed));
      log.debug('[QuotaResolver] Remainder for floors 3..K:', JSON.stringify(remainResult.remainder),
        remainResult.feasible ? '(feasible)' : '(SHORTFALL: ' + JSON.stringify(remainResult.shortfall) + ')');

      var phase0Quota = null;
      if (qResult.best) {
        phase0Quota = qResult.best.counts;
        log.debug('[section-gen] using Phase 0 quota:', JSON.stringify(phase0Quota));
      }

      // Save for UI panel
      if (!state._quotaResults) state._quotaResults = {};
      state._quotaResults[dp.planKey] = {
        key: dp.planKey, cellsPerFloor: cellsPerFloor,
        residentialFloors: residentialFloors, totalCells: totalCells,
        best: qResult.best, candidates: qResult.candidates,
        floor2Placed: fl1Placed, remainder: remainResult,
        feasible: remainResult.feasible
      };
      // ── End Phase 0 ──

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
        orientation: dp.orientation,
        quota: phase0Quota
      });

      state.graphDataMap[dp.planKey] = {
        nodes: dp.graphNodes, N: dp.N, params: dp.params,
        floorCount: dp.floorCount, perFloorInsol: perFloorInsol
      };

      // Render floors 2..N
      var bPlan = state.buildingPlans[dp.planKey];
      log.debug('[section-gen] building plan:', dp.planKey,
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
            flDetailMap = buildAptDetailMap(floorData.apartments);
          } else {
            flDetailMap = dp.detailMap;
          }

          state.threeOverlay.addMesh(buildDetailedFloor1(dp.graphNodes, dp.N,
            flBaseZ, flTopZ, flDetailMap, 0.08, false, false, false));
        }

        // LLU rooftop extension above last floor
        // LLU stack lifted to slab top to avoid z-fight with the slab body.
        state.threeOverlay.addMesh(buildLLURoof(dp.graphNodes, dp.N, dp.buildingH + 0.5, 2.5));
        // Top slab — permanent for distributed sections (full-height
        // building geometry already exists, slab is the natural roof).
        state.threeOverlay.addMesh(buildTopSlab(dp.fpM, dp.buildingH, 0.5));
      }

      state.eventBus.emit('building:plan:result', {
        sectionKey: dp.planKey, plan: bPlan
      });
    }

    // Emit quota results for UI panel
    if (state._quotaResults) {
      var quotaEventData = { sections: [] };
      for (var qrKey in state._quotaResults) {
        if (state._quotaResults.hasOwnProperty(qrKey)) {
          quotaEventData.sections.push(state._quotaResults[qrKey]);
        }
      }
      if (quotaEventData.sections.length > 0) {
        state.eventBus.emit('quota:resolved', quotaEventData);
      }
    }

    state._deferredPlans = null;
  }

  // ══════════════════════════════════════════════════════════
  // Underground floor (-4.5 to 0): gray + LLU (blue)
  // ══════════════════════════════════════════════════════════
  if (state.threeOverlay) {
    if (state.undergroundGroup) {
      state.threeOverlay.removeMesh(state.undergroundGroup);
      state.undergroundGroup = null;
    }
    var ugGroup = new THREE.Group();
    var UG_BASE = -4.5;
    var UG_TOP = 0;
    var UG_GRAY = '#9e9e9e';
    var UG_LLU = '#4f81bd';
    var UG_GAP = 0.03;

    // Section underground: per-cell with LLU coloring
    for (var ugi = 0; ugi < ugSectionGraphs.length; ugi++) {
      var ugNodes = ugSectionGraphs[ugi];
      for (var nk in ugNodes) {
        if (!ugNodes.hasOwnProperty(nk)) continue;
        var node = ugNodes[nk];
        if (node.floor !== 0) continue;
        if (!node.polygon || node.polygon.length < 3) continue;
        var isLLU = node.type === 'llu';
        ugGroup.add(buildCellMeshColored(node.polygon, UG_BASE, UG_TOP,
          isLLU ? UG_LLU : UG_GRAY, UG_GAP));
      }
    }

    // Tower underground: per-cell with LLU + wider exit stub
    for (var ti = 0; ti < towers.length; ti++) {
      var tFeature = towers[ti];
      var tFP = tFeature.properties.footprints;
      if (!tFP || tFP.length === 0) continue;
      var tCellSize = tFeature.properties.cellSize || 3.3;
      var tCoords = tFeature.geometry.coordinates;
      if (!tCoords || tCoords.length < 2) continue;
      var tStartM = globalProj.toMeters(tCoords[0][0], tCoords[0][1]);
      var tEndM = globalProj.toMeters(tCoords[1][0], tCoords[1][1]);
      var tNorthEnd = tFeature.properties.northEnd || detectNorthEnd(tStartM, tEndM);
      var tOri2 = tFeature.properties.orientation || classifySegment(tStartM, tEndM).orientationName;

      for (var tfi = 0; tfi < tFP.length; tfi++) {
        var tfp = tFP[tfi];
        var tSize = tfp.size || 'small';
        var tDims = getTowerDimensions(tSize, tCellSize, tOri2);
        var tfpM = [];
        for (var j = 0; j < tfp.polygon.length; j++)
          tfpM.push(globalProj.toMeters(tfp.polygon[j][0], tfp.polygon[j][1]));

        var exitSide;
        if (tOri2 === 'lon') {
          exitSide = tNorthEnd === 'start' ? 'row-start' : 'row-end';
        } else {
          var acrossY = tfpM[3][1] - tfpM[0][1];
          exitSide = acrossY >= 0 ? 'col-high' : 'col-low';
        }

        var ugCells = classifyCells(tDims.rows, tDims.cols, exitSide);
        var ugPolys = generateCellsFromFootprint(tfpM, tDims.rows, tDims.cols);

        // Wider exit: add ±1 column around exitCol (or ±1 row for col-low/col-high)
        var exitCol = Math.floor(tDims.cols / 2);
        var exitRow = Math.floor(tDims.rows / 2);
        var widerExit = {};
        for (var uci = 0; uci < ugCells.length; uci++) {
          var uc = ugCells[uci];
          if (uc.type === 'llu-exit') {
            // Mark neighbors as wider exit
            if (exitSide === 'row-start' || exitSide === 'row-end') {
              if (uc.col > 0) widerExit[uc.row * tDims.cols + (uc.col - 1)] = true;
              if (uc.col < tDims.cols - 1) widerExit[uc.row * tDims.cols + (uc.col + 1)] = true;
            } else {
              if (uc.row > 0) widerExit[(uc.row - 1) * tDims.cols + uc.col] = true;
              if (uc.row < tDims.rows - 1) widerExit[(uc.row + 1) * tDims.cols + uc.col] = true;
            }
          }
        }

        for (var uci = 0; uci < ugCells.length; uci++) {
          var uc = ugCells[uci];
          var ugid = uc.row * tDims.cols + uc.col;
          var isLLU = uc.type === 'llu' || uc.type === 'llu-exit' || widerExit[ugid];
          ugGroup.add(buildCellMeshColored(ugPolys[ugid], UG_BASE, UG_TOP,
            isLLU ? UG_LLU : UG_GRAY, UG_GAP));
        }
      }
    }

    state.undergroundGroup = ugGroup;
    ugGroup.visible = state.undergroundVisible;
    state.threeOverlay.addMesh(ugGroup);
    log.debug('[underground] group created: ' + ugGroup.children.length + ' meshes, visible=' + ugGroup.visible);
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

  // Attach per-block SPP distribution results so StatsPanel can
  // show achieved vs target, delta, and feasibility markers.
  allStats.perBlockSPP = distributionStats;
  state.eventBus.emit('section-gen:stats', allStats);
  state.eventBus.emit('section-gen:rebuilt');
}
