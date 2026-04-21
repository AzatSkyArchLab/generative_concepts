/**
 * Insolation Module — GOST R 57795-2017 analysis
 *
 * Three analysis levels:
 * 1. Global — all sections (panel button or I key)
 * 2. Axis — selected axis
 * 3. Section — single section in edit mode
 *
 * Points: ONLY floor 1 (first residential), per facade cell.
 * Collision: box meshes from footprints × buildingH.
 * Rays: optional visualization toggle.
 */

import * as THREE from 'three';
import { getSunVectors } from '../../core/insolation/SunVectors.js';
import { evaluateInsolation } from '../../core/insolation/InsolationCalc.js';
import { INSOL_CONFIG } from '../../core/insolation/InsolationConfig.js';
import { getParams, getSectionHeight, computeBuildingHeight, computeFloorCount } from '../../core/SectionParams.js';
import { createProjection } from '../../core/geo/projection.js';
import { getTowerDimensions, classifyCells, generateCellsFromFootprint } from '../../core/tower/TowerGenerator.js';
import { walkRing } from '../../core/tower/TowerGraph.js';
import { classifySegment } from '../../core/geo/orientation.js';
import { detectNorthEnd } from '../../core/tower/TowerPlacer.js';
import { log } from '../../core/Logger.js';

// ── Config (from InsolationConfig, aliased for local brevity) ────

var LATITUDE = INSOL_CONFIG.latitude;
var NORMATIVE_MINUTES = INSOL_CONFIG.normativeMinutes;
var FACADE_OFFSET = INSOL_CONFIG.facadeOffset;
var POINT_RADIUS = INSOL_CONFIG.pointRadius;
var MAX_RAY_DISTANCE = INSOL_CONFIG.maxRayDistance;
var RAY_FREE_LENGTH = INSOL_CONFIG.rayFreeLength;

var COLORS = { PASS: 0x22c55e, WARNING: 0xf59e0b, FAIL: 0xef4444 };
var RAY_COLORS = { free: 0xfbbf24, blocked: 0xef4444 };

/**
 * Build fpM from stored polygon.
 */
function buildFpM(fp, proj) {
  var fpM = [];
  for (var j = 0; j < fp.polygon.length; j++)
    fpM.push(proj.toMeters(fp.polygon[j][0], fp.polygon[j][1]));
  return fpM;
}

// ── State ──────────────────────────────────────────────

var _mapManager, _featureStore, _eventBus, _threeOverlay;
var _unsubs = [];
var _resultGroup = null;
var _raysGroup = null;
var _collisionMeshes = [];
var _raycaster = new THREE.Raycaster();
var _lastResults = null;
var _lastPointData = null;
var _lastCellMap = null;
var _analysisLevel = null;
var _raysVisible = false;
var _globalActive = false;    // persistent global mode

// ── Collision box ──────────────────────────────────────

var _collisionMat = new THREE.MeshBasicMaterial({ visible: false, side: THREE.DoubleSide });

function buildCollisionBoxRange(corners, baseZ, topZ) {
  var a = corners[0]; var b = corners[1]; var c = corners[2]; var d = corners[3];
  var verts = new Float32Array([
    a[0],a[1],baseZ, b[0],b[1],baseZ, c[0],c[1],baseZ, d[0],d[1],baseZ,
    a[0],a[1],topZ,  b[0],b[1],topZ,  c[0],c[1],topZ,  d[0],d[1],topZ
  ]);
  var idx = new Uint16Array([
    0,1,5, 0,5,4, 1,2,6, 1,6,5, 2,3,7, 2,7,6,
    3,0,4, 3,4,7, 4,5,6, 4,6,7, 0,3,2, 0,2,1
  ]);
  var geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(verts, 3));
  geo.setIndex(new THREE.BufferAttribute(idx, 1));
  geo.computeBoundingSphere();
  return new THREE.Mesh(geo, _collisionMat);
}

/**
 * Offset near (a→b) and far (c→d) edges outward by dist.
 * Positive dist = outward from section center.
 */
function offsetNearFar(fpM, dist) {
  var a = fpM[0]; var b = fpM[1]; var c = fpM[2]; var d = fpM[3];
  var cx = (a[0]+b[0]+c[0]+d[0]) / 4;
  var cy = (a[1]+b[1]+c[1]+d[1]) / 4;

  // Near edge a→b outward normal
  var ndx = b[0]-a[0]; var ndy = b[1]-a[1];
  var nlen = Math.sqrt(ndx*ndx + ndy*ndy);
  var nnx = -ndy/nlen; var nny = ndx/nlen;
  var ma0 = (a[0]+b[0])/2; var ma1 = (a[1]+b[1])/2;
  if (nnx*(ma0-cx) + nny*(ma1-cy) < 0) { nnx = -nnx; nny = -nny; }

  // Far edge c→d outward normal
  var fdx = d[0]-c[0]; var fdy = d[1]-c[1];
  var flen = Math.sqrt(fdx*fdx + fdy*fdy);
  var fnx = -fdy/flen; var fny = fdx/flen;
  var mf0 = (c[0]+d[0])/2; var mf1 = (c[1]+d[1])/2;
  if (fnx*(mf0-cx) + fny*(mf1-cy) < 0) { fnx = -fnx; fny = -fny; }

  return [
    [a[0]+nnx*dist, a[1]+nny*dist],
    [b[0]+nnx*dist, b[1]+nny*dist],
    [c[0]+fnx*dist, c[1]+fny*dist],
    [d[0]+fnx*dist, d[1]+fny*dist]
  ];
}

/**
 * Offset all 4 edges inward (negative dist) or outward (positive dist).
 * This handles end walls too (a→d and b→c).
 */
function offsetAllSides(fpM, dist) {
  // First offset near/far
  var nf = offsetNearFar(fpM, dist);
  // Then offset ends (a→d left, b→c right) of the result
  var a = nf[0]; var b = nf[1]; var c = nf[2]; var d = nf[3];
  var cx = (a[0]+b[0]+c[0]+d[0]) / 4;
  var cy = (a[1]+b[1]+c[1]+d[1]) / 4;

  // Left edge a→d outward normal
  var ldx = d[0]-a[0]; var ldy = d[1]-a[1];
  var llen = Math.sqrt(ldx*ldx + ldy*ldy);
  if (llen < 0.01) return nf;
  var lnx = -ldy/llen; var lny = ldx/llen;
  var ml0 = (a[0]+d[0])/2; var ml1 = (a[1]+d[1])/2;
  if (lnx*(ml0-cx) + lny*(ml1-cy) < 0) { lnx = -lnx; lny = -lny; }

  // Right edge b→c outward normal
  var rdx = c[0]-b[0]; var rdy = c[1]-b[1];
  var rlen = Math.sqrt(rdx*rdx + rdy*rdy);
  var rnx = -rdy/rlen; var rny = rdx/rlen;
  var mr0 = (b[0]+c[0])/2; var mr1 = (b[1]+c[1])/2;
  if (rnx*(mr0-cx) + rny*(mr1-cy) < 0) { rnx = -rnx; rny = -rny; }

  return [
    [a[0]+lnx*dist, a[1]+lny*dist],
    [b[0]+rnx*dist, b[1]+rny*dist],
    [c[0]+rnx*dist, c[1]+rny*dist],
    [d[0]+lnx*dist, d[1]+lny*dist]
  ];
}

var EXT_WALL_T = INSOL_CONFIG.extWallThickness;
var COL_WIN_W = INSOL_CONFIG.windowWidth;
var COL_WIN_H = INSOL_CONFIG.windowHeight;
var COL_WIN_SILL = INSOL_CONFIG.windowSillHeight;
var COL_SLAB = INSOL_CONFIG.slabThickness;

/**
 * Build pier box in window zone on one side of a window opening.
 * p1→p2 = facade edge segment, on = outward normal.
 * Pier goes from outer face (p1/p2) inward by EXT_WALL_T.
 */
function addPierBox(meshes, p1, p2, on, sillZ, winTopZ) {
  var i1 = [p1[0] - on[0] * EXT_WALL_T, p1[1] - on[1] * EXT_WALL_T];
  var i2 = [p2[0] - on[0] * EXT_WALL_T, p2[1] - on[1] * EXT_WALL_T];
  meshes.push(buildCollisionBoxRange([p1, p2, i2, i1], sillZ, winTopZ));
}

/**
 * Build collision pieces for one facade edge. Per-cell: LLU = solid, apartment = piers around window.
 * N is passed in (from near edge) to match section-gen cell count.
 */
function addFacadeCollision(meshes, edgeP1, edgeP2, outN, N, sillZ, winTopZ, lluSide, side, secH, realLluIdx) {
  var dx = edgeP2[0] - edgeP1[0];
  var dy = edgeP2[1] - edgeP1[1];
  var edgeLen = Math.sqrt(dx * dx + dy * dy);
  var ax = dx / edgeLen;
  var ay = dy / edgeLen;
  var lluIdx = realLluIdx || computeLLUIndices(N, secH);

  for (var ci = 0; ci < N; ci++) {
    var tL = ci * edgeLen / N;
    var tR = (ci + 1) * edgeLen / N;
    var cellLen = tR - tL;

    var cL = [edgeP1[0] + ax * tL, edgeP1[1] + ay * tL];
    var cR = [edgeP1[0] + ax * tR, edgeP1[1] + ay * tR];

    // LLU cell: solid wall in window zone
    if (side === lluSide && lluIdx[ci]) {
      addPierBox(meshes, cL, cR, outN, sillZ, winTopZ);
      continue;
    }

    // Apartment: piers around window opening
    var pierW = (cellLen - COL_WIN_W) / 2;
    if (pierW < 0.1) pierW = 0.1;

    // Left pier
    var lpR = [edgeP1[0] + ax * (tL + pierW), edgeP1[1] + ay * (tL + pierW)];
    addPierBox(meshes, cL, lpR, outN, sillZ, winTopZ);

    // Right pier
    var rpL = [edgeP1[0] + ax * (tR - pierW), edgeP1[1] + ay * (tR - pierW)];
    addPierBox(meshes, rpL, cR, outN, sillZ, winTopZ);
  }
}

/**
 * Build collision pieces for one end wall: 2 cells (near half, far half), corridor solid.
 */
function addEndWallCollision(meshes, edgeP1, edgeP2, outN, aptDepth, corrWidth, sillZ, winTopZ, lluSide, nearIsLLU, farIsLLU) {
  var dx = edgeP2[0] - edgeP1[0];
  var dy = edgeP2[1] - edgeP1[1];
  var edgeLen = Math.sqrt(dx * dx + dy * dy);
  if (edgeLen < 1) return;
  var ax = dx / edgeLen;
  var ay = dy / edgeLen;

  // Near cell: 0 → aptDepth
  var nearL = edgeP1;
  var nearR = [edgeP1[0] + ax * aptDepth, edgeP1[1] + ay * aptDepth];
  if (nearIsLLU) {
    addPierBox(meshes, nearL, nearR, outN, sillZ, winTopZ);
  } else {
    var nPierW = (aptDepth - COL_WIN_W) / 2;
    if (nPierW < 0.1) nPierW = 0.1;
    var nlpR = [edgeP1[0] + ax * nPierW, edgeP1[1] + ay * nPierW];
    addPierBox(meshes, nearL, nlpR, outN, sillZ, winTopZ);
    var nrpL = [edgeP1[0] + ax * (aptDepth - nPierW), edgeP1[1] + ay * (aptDepth - nPierW)];
    addPierBox(meshes, nrpL, nearR, outN, sillZ, winTopZ);
  }

  // Corridor: aptDepth → aptDepth+corrWidth (solid)
  var corrL = nearR;
  var corrR = [edgeP1[0] + ax * (aptDepth + corrWidth), edgeP1[1] + ay * (aptDepth + corrWidth)];
  addPierBox(meshes, corrL, corrR, outN, sillZ, winTopZ);

  // Far cell: aptDepth+corrWidth → end
  var farL = corrR;
  var farR = edgeP2;
  if (farIsLLU) {
    addPierBox(meshes, farL, farR, outN, sillZ, winTopZ);
  } else {
    var fPierW = (aptDepth - COL_WIN_W) / 2;
    if (fPierW < 0.1) fPierW = 0.1;
    var flpR = [corrR[0] + ax * fPierW, corrR[1] + ay * fPierW];
    addPierBox(meshes, farL, flpR, outN, sillZ, winTopZ);
    var frpL = [edgeP2[0] - ax * fPierW, edgeP2[1] - ay * fPierW];
    addPierBox(meshes, frpL, farR, outN, sillZ, winTopZ);
  }
}

function buildAllCollisionMeshes(sections, towers, proj) {
  var meshes = [];
  for (var si = 0; si < sections.length; si++) {
    var feature = sections[si];
    var storedFP = feature.properties.footprints;
    if (!storedFP || storedFP.length === 0) continue;
    var params = getParams(feature.properties);
    for (var fi = 0; fi < storedFP.length; fi++) {
      var fp = storedFP[fi];
      var secH = getSectionHeight(fp, params);
      var buildingH = computeBuildingHeight(secH, params.firstFloorHeight, params.typicalFloorHeight);
      var fc = computeFloorCount(secH, params.firstFloorHeight, params.typicalFloorHeight);
      var fpM = buildFpM(fp, proj);

      // Floor 0 (commercial): solid
      meshes.push(buildCollisionBoxRange(fpM, 0, params.firstFloorHeight));

      // Precompute shared geometry data
      var a = fpM[0]; var b = fpM[1]; var c = fpM[2]; var d = fpM[3];
      var ccx = (a[0]+b[0]+c[0]+d[0]) / 4;
      var ccy = (a[1]+b[1]+c[1]+d[1]) / 4;

      // Use real section-gen data if available
      var lluSide;
      var N;
      var lluIdx = {};
      if (fp.N) {
        N = fp.N;
        lluSide = fp.northSide || computeLLUSide(fpM);
        if (fp.lluIndices) {
          for (var li = 0; li < fp.lluIndices.length; li++) lluIdx[fp.lluIndices[li]] = true;
        }
      } else {
        lluSide = computeLLUSide(fpM);
        var nearDx = b[0]-a[0]; var nearDy = b[1]-a[1];
        var nearLen = Math.sqrt(nearDx*nearDx + nearDy*nearDy);
        N = Math.max(1, Math.round(nearLen / params.cellWidth));
        lluIdx = computeLLUIndices(N, secH);
      }

      function outN(p1, p2) {
        var ex = p2[0]-p1[0]; var ey = p2[1]-p1[1];
        var el = Math.sqrt(ex*ex + ey*ey);
        var nx = -ey/el; var ny = ex/el;
        var mx = (p1[0]+p2[0])/2; var my = (p1[1]+p2[1])/2;
        if (nx*(mx-ccx) + ny*(my-ccy) < 0) { nx = -nx; ny = -ny; }
        return [nx, ny];
      }
      var aptDepth = (params.sectionWidth - params.corridorWidth) / 2.0;

      var nearLLU0 = (lluSide === 'near' && lluIdx[0]);
      var nearLLUN = (lluSide === 'near' && lluIdx[N - 1]);
      var farLLUatC = (lluSide === 'far' && lluIdx[0]);
      var farLLUatD = (lluSide === 'far' && lluIdx[N - 1]);

      // Cache outward normals
      var nAB = outN(a, b);
      var nCD = outN(c, d);
      var nAD = outN(a, d);
      var nBC = outN(b, c);
      var colFlipped = fp.axisFlipped;

      // Each residential floor: solid zones + per-cell piers in window zone
      for (var fl = 1; fl < fc; fl++) {
        var flBase = params.firstFloorHeight + (fl - 1) * params.typicalFloorHeight;
        var flTop = flBase + params.typicalFloorHeight;
        var sillZ = flBase + COL_SLAB + COL_WIN_SILL;
        var winTopZ = sillZ + COL_WIN_H;

        if (flTop <= sillZ) {
          meshes.push(buildCollisionBoxRange(fpM, flBase, flTop));
          continue;
        }

        // Solid below windows
        meshes.push(buildCollisionBoxRange(fpM, flBase, sillZ));

        // Solid above windows
        if (winTopZ < flTop) {
          meshes.push(buildCollisionBoxRange(fpM, winTopZ, flTop));
        }

        // Per-cell piers in window zone — facades
        // When axis flipped, reverse edge direction so cellIdx matches graph numbering
        var nearP1 = colFlipped ? b : a;
        var nearP2 = colFlipped ? a : b;
        var farP1 = colFlipped ? d : c;
        var farP2 = colFlipped ? c : d;
        addFacadeCollision(meshes, nearP1, nearP2, nAB, N, sillZ, winTopZ, lluSide, 'near', secH, lluIdx);
        addFacadeCollision(meshes, farP1, farP2, nCD, N, sillZ, winTopZ, lluSide, 'far', secH, lluIdx);

        // End walls with niches
        // When flipped: left end = graph rightmost (N-1), right end = graph leftmost (0)
        var endLeftNearLLU = colFlipped ? nearLLUN : nearLLU0;
        var endLeftFarLLU = colFlipped ? farLLUatC : farLLUatD;
        var endRightNearLLU = colFlipped ? nearLLU0 : nearLLUN;
        var endRightFarLLU = colFlipped ? farLLUatD : farLLUatC;
        addEndWallCollision(meshes, a, d, nAD, aptDepth, params.corridorWidth,
          sillZ, winTopZ, lluSide, endLeftNearLLU, endLeftFarLLU);
        addEndWallCollision(meshes, b, c, nBC, aptDepth, params.corridorWidth,
          sillZ, winTopZ, lluSide, endRightNearLLU, endRightFarLLU);
      }

      // Roof cap: solid slab at building top — prevents rays from passing through
      meshes.push(buildCollisionBoxRange(fpM, buildingH - 0.3, buildingH));

      // LLU rooftop extension: stairwell/elevator shaft above roof (2.5m)
      var LLU_ABOVE = INSOL_CONFIG.lluAboveRoof;
      var lluMin = N; var lluMax = -1;
      for (var lidx in lluIdx) {
        if (!lluIdx.hasOwnProperty(lidx)) continue;
        var ci = parseInt(lidx);
        if (ci < lluMin) lluMin = ci;
        if (ci > lluMax) lluMax = ci;
      }
      if (lluMax >= 0) {
        var nearP1 = colFlipped ? b : a;
        var nearP2 = colFlipped ? a : b;
        var farP1 = colFlipped ? d : c;
        var farP2 = colFlipped ? c : d;
        var ndx = nearP2[0] - nearP1[0]; var ndy = nearP2[1] - nearP1[1];
        var nLen = Math.sqrt(ndx*ndx + ndy*ndy);
        var fdx = farP2[0] - farP1[0]; var fdy = farP2[1] - farP1[1];
        var fLen = Math.sqrt(fdx*fdx + fdy*fdy);
        var tL = lluMin / N; var tR = (lluMax + 1) / N;
        var lluPoly = [
          [nearP1[0] + ndx * tL, nearP1[1] + ndy * tL],
          [nearP1[0] + ndx * tR, nearP1[1] + ndy * tR],
          [farP1[0] + fdx * tR, farP1[1] + fdy * tR],
          [farP1[0] + fdx * tL, farP1[1] + fdy * tL]
        ];
        meshes.push(buildCollisionBoxRange(lluPoly, buildingH, buildingH + LLU_ABOVE));
      }
    }
  }

  // Tower collision meshes — per-floor with window openings on outer ring
  for (var ti = 0; ti < towers.length; ti++) {
    var tFeature = towers[ti];
    var tFP = tFeature.properties.footprints;
    if (!tFP || tFP.length === 0) continue;
    var axisH = tFeature.properties.towerHeight || 112;
    var tCellSz = tFeature.properties.cellSize || 3.3;

    for (var tfi = 0; tfi < tFP.length; tfi++) {
      var perH = tFP[tfi].towerHeight !== undefined ? tFP[tfi].towerHeight : axisH;
      var tfc = computeFloorCount(perH, 4.5, 3.0);
      var tfpM = buildFpM(tFP[tfi], proj);

      // Compute LLU core polygon (inset 2 cells from each edge)
      var insetDist = 2 * tCellSz;
      var tcx = (tfpM[0][0] + tfpM[1][0] + tfpM[2][0] + tfpM[3][0]) / 4;
      var tcy = (tfpM[0][1] + tfpM[1][1] + tfpM[2][1] + tfpM[3][1]) / 4;
      var coreM = [];
      for (var ci = 0; ci < 4; ci++) {
        var dx = tfpM[ci][0] - tcx;
        var dy = tfpM[ci][1] - tcy;
        var dl = Math.sqrt(dx * dx + dy * dy);
        if (dl > 1e-10) {
          var shrink = insetDist / dl;
          coreM.push([tfpM[ci][0] - dx * shrink, tfpM[ci][1] - dy * shrink]);
        } else {
          coreM.push([tfpM[ci][0], tfpM[ci][1]]);
        }
      }

      // Floor 0: commercial — solid full footprint
      meshes.push(buildCollisionBoxRange(tfpM, 0, 4.5));

      // Each residential floor: solid below windows + core at window height
      for (var tfl = 1; tfl < tfc; tfl++) {
        var flBase = 4.5 + (tfl - 1) * 3.0;
        var flTop = flBase + 3.0;
        var sillZ = flBase + COL_SLAB + COL_WIN_SILL;
        var winTopZ = sillZ + COL_WIN_H;

        // Solid below windows — full footprint
        if (sillZ > flBase) {
          meshes.push(buildCollisionBoxRange(tfpM, flBase, Math.min(sillZ, flTop)));
        }

        // Window zone: only LLU core is solid (outer ring has windows)
        if (winTopZ > sillZ && sillZ < flTop) {
          meshes.push(buildCollisionBoxRange(coreM, sillZ, Math.min(winTopZ, flTop)));
        }

        // Solid above windows — full footprint
        if (winTopZ < flTop) {
          meshes.push(buildCollisionBoxRange(tfpM, winTopZ, flTop));
        }
      }
    }
  }

  return meshes;
}

// ── Facade points (floor 1 only) ──────────────────────

function getOutwardNormal(p1, p2, cx, cy) {
  var dx = p2[0] - p1[0]; var dy = p2[1] - p1[1];
  var len = Math.sqrt(dx * dx + dy * dy);
  if (len < 1e-10) return [0, 0];
  var nx = -dy / len; var ny = dx / len;
  var mx = (p1[0] + p2[0]) / 2; var my = (p1[1] + p2[1]) / 2;
  if (nx * (mx - cx) + ny * (my - cy) < 0) { nx = -nx; ny = -ny; }
  return [nx, ny];
}

function computeLLUSide(fpM) {
  var cx = (fpM[0][0] + fpM[1][0] + fpM[2][0] + fpM[3][0]) / 4;
  var cy = (fpM[0][1] + fpM[1][1] + fpM[2][1] + fpM[3][1]) / 4;
  var nearN = getOutwardNormal(fpM[0], fpM[1], cx, cy);
  // Near outward Y > 0 → near faces north → LLU on near
  return (nearN && nearN[1] >= 0) ? 'near' : 'far';
}

function computeLLUIndices(cellCount, secH) {
  var lluCount = secH <= 28 ? 2 : 3;
  var center = cellCount / 2.0;
  var scored = [];
  for (var ci = 0; ci < cellCount; ci++)
    scored.push({ d: Math.abs(ci + 0.5 - center), i: ci });
  scored.sort(function (a, b) { return a.d - b.d; });
  var indices = {};
  for (var li = 0; li < Math.min(lluCount, cellCount); li++) indices[scored[li].i] = true;
  return indices;
}

function generateFacadePoints(fpM, params, secH, hasLeftNeighbor, hasRightNeighbor, floorNum, sectionData) {
  var points = [];
  var cx = (fpM[0][0] + fpM[1][0] + fpM[2][0] + fpM[3][0]) / 4;
  var cy = (fpM[0][1] + fpM[1][1] + fpM[2][1] + fpM[3][1]) / 4;

  // When section-gen flipped the axis (orientAxis), cellIdx must match
  // the graph numbering. Reverse facade directions so cellIdx 0 = graph cell 0.
  var axisFlipped = sectionData && sectionData.axisFlipped;

  var facades;
  if (axisFlipped) {
    facades = [
      { p1: fpM[1], p2: fpM[0], side: 'near' },
      { p1: fpM[3], p2: fpM[2], side: 'far' }
    ];
  } else {
    facades = [
      { p1: fpM[0], p2: fpM[1], side: 'near' },
      { p1: fpM[2], p2: fpM[3], side: 'far' }
    ];
  }

  // Z at window sill for given floor: baseZ + slab(0.3) + sill(1.2) + 0.1
  if (!floorNum) floorNum = 1;
  var floorBaseZ = params.firstFloorHeight + (floorNum - 1) * params.typicalFloorHeight;
  var z = floorBaseZ + 1.6;

  // LLU: use real data from section-gen if available, else fallback
  var lluSide;
  var cellCount;
  var lluIndices = {};

  if (sectionData && sectionData.N) {
    cellCount = sectionData.N;
    lluSide = sectionData.northSide || computeLLUSide(fpM);
    if (sectionData.lluIndices) {
      for (var li = 0; li < sectionData.lluIndices.length; li++) {
        lluIndices[sectionData.lluIndices[li]] = true;
      }
    }
  } else {
    lluSide = computeLLUSide(fpM);
    var edgeLen0 = Math.sqrt(
      Math.pow(fpM[1][0] - fpM[0][0], 2) + Math.pow(fpM[1][1] - fpM[0][1], 2));
    cellCount = Math.max(1, Math.round(edgeLen0 / params.cellWidth));
    lluIndices = computeLLUIndices(cellCount, secH);
  }

  // Long facades — use same N for both (near edge defines cell count, matching section-gen)
  var nearCount = 0; var farCount = 0;
  for (var fi = 0; fi < facades.length; fi++) {
    var f = facades[fi];
    var normal = getOutwardNormal(f.p1, f.p2, cx, cy);
    var edgeDx = f.p2[0] - f.p1[0]; var edgeDy = f.p2[1] - f.p1[1];
    var edgeLen = Math.sqrt(edgeDx * edgeDx + edgeDy * edgeDy);

    for (var ci = 0; ci < cellCount; ci++) {
      // Skip LLU cells
      if (f.side === lluSide && lluIndices[ci]) continue;

      var t = (ci + 0.5) / cellCount;
      var px = f.p1[0] + edgeDx * t + normal[0] * FACADE_OFFSET;
      var py = f.p1[1] + edgeDy * t + normal[1] * FACADE_OFFSET;
      points.push({ position: [px, py, z], side: f.side, cellIdx: ci, normal: normal });
      if (f.side === 'near') nearCount++; else farCount++;
    }
  }

  // End-wall points — only if no neighbor section on that side
  var aptDepth = (params.sectionWidth - params.corridorWidth) / 2.0;
  var endEdges = [];
  if (!hasLeftNeighbor) {
    if (axisFlipped) {
      endEdges.push({ p1: fpM[0], p2: fpM[3], nearIdx: cellCount - 1, farIdx: 0 });
    } else {
      endEdges.push({ p1: fpM[0], p2: fpM[3], nearIdx: 0, farIdx: cellCount - 1 });
    }
  }
  if (!hasRightNeighbor) {
    if (axisFlipped) {
      endEdges.push({ p1: fpM[1], p2: fpM[2], nearIdx: 0, farIdx: cellCount - 1 });
    } else {
      endEdges.push({ p1: fpM[1], p2: fpM[2], nearIdx: cellCount - 1, farIdx: 0 });
    }
  }
  for (var ei = 0; ei < endEdges.length; ei++) {
    var e = endEdges[ei];
    var endNormal = getOutwardNormal(e.p1, e.p2, cx, cy);
    if (!endNormal) continue;
    var eDx = e.p2[0] - e.p1[0]; var eDy = e.p2[1] - e.p1[1];
    var eLen = Math.sqrt(eDx * eDx + eDy * eDy);
    if (eLen < 1) continue;

    // Near cell center
    var tNear = (aptDepth * 0.5) / eLen;
    if (tNear > 0 && tNear < 1) {
      if (!(lluSide === 'near' && lluIndices[e.nearIdx])) {
        var px = e.p1[0] + eDx * tNear + endNormal[0] * FACADE_OFFSET;
        var py = e.p1[1] + eDy * tNear + endNormal[1] * FACADE_OFFSET;
        points.push({ position: [px, py, z], side: 'near', cellIdx: e.nearIdx, normal: endNormal });
      }
    }

    // Far cell center
    var tFar = (aptDepth + params.corridorWidth + aptDepth * 0.5) / eLen;
    if (tFar > 0 && tFar < 1) {
      if (!(lluSide === 'far' && lluIndices[e.farIdx])) {
        var px = e.p1[0] + eDx * tFar + endNormal[0] * FACADE_OFFSET;
        var py = e.p1[1] + eDy * tFar + endNormal[1] * FACADE_OFFSET;
        points.push({ position: [px, py, z], side: 'far', cellIdx: e.farIdx, normal: endNormal });
      }
    }
  }

  if (floorNum === 1) log.debug('[insol] section N=' + cellCount + ' llu=' + lluSide + ' near=' + nearCount + ' far=' + farCount + ' ends=' + (points.length - nearCount - farCount));
  return points;
}

// ── Tower facade points ──────────────────────────────

/**
 * Generate facade points for tower ring cells.
 * Each outer ring cell gets one point at the center of its outward-facing edge.
 *
 * @param {Array<[number,number]>} tfpM - tower footprint polygon in meters (4 corners)
 * @param {Object} dims - {rows, cols, cellSize} from getTowerDimensions
 * @param {string} exitSide - 'row-start'|'row-end'|'col-low'|'col-high'
 * @param {number} floorNum - floor number (1-based)
 * @returns {Array<Object>} points in same format as section facade points
 */
function generateTowerFacadePoints(tfpM, dims, exitSide, floorNum) {
  if (!floorNum) floorNum = 1;
  var floorBaseZ = 4.5 + (floorNum - 1) * 3.0;
  var z = floorBaseZ + 1.6;

  var cellPolysM = generateCellsFromFootprint(tfpM, dims.rows, dims.cols);
  var rows = dims.rows;
  var cols = dims.cols;

  // Classify cells to identify LLU
  var cells = classifyCells(rows, cols, exitSide);

  // Ring pair mapping for cellIdx
  var ringResult = walkRing(rows, cols, exitSide);
  var outerToRingIdx = {};
  for (var i = 0; i < ringResult.pairs.length; i++) {
    var p = ringResult.pairs[i];
    outerToRingIdx[p.outerRow * cols + p.outerCol] = i;
  }

  var points = [];
  for (var r = 0; r < rows; r++) {
    for (var c = 0; c < cols; c++) {
      var gridId = r * cols + c;
      var cellType = cells[gridId] ? cells[gridId].type : 'apartment';

      // Skip LLU cells — no insol points
      if (cellType === 'llu' || cellType === 'llu-exit') continue;

      // Only boundary cells
      var isBoundary = (r === 0 || r === rows - 1 || c === 0 || c === cols - 1);
      if (!isBoundary) continue;

      var poly = cellPolysM[gridId];
      if (!poly || poly.length < 4) continue;
      var cc = [(poly[0][0]+poly[1][0]+poly[2][0]+poly[3][0])/4,
                (poly[0][1]+poly[1][1]+poly[2][1]+poly[3][1])/4];

      // Find exterior directions (1 for edge, 2 for corner)
      var dirs = [];
      if (r === 0 && r + 1 < rows) dirs.push({ nr: 1, nc: c });
      if (r === rows - 1 && r - 1 >= 0) dirs.push({ nr: rows - 2, nc: c });
      if (c === 0 && c + 1 < cols) dirs.push({ nr: r, nc: 1 });
      if (c === cols - 1 && c - 1 >= 0) dirs.push({ nr: r, nc: cols - 2 });

      for (var di = 0; di < dirs.length; di++) {
        var nGid = dirs[di].nr * cols + dirs[di].nc;
        var nPoly = cellPolysM[nGid];
        if (!nPoly) continue;
        var nc2 = [(nPoly[0][0]+nPoly[1][0]+nPoly[2][0]+nPoly[3][0])/4,
                   (nPoly[0][1]+nPoly[1][1]+nPoly[2][1]+nPoly[3][1])/4];

        var nx = cc[0] - nc2[0]; var ny = cc[1] - nc2[1];
        var len = Math.sqrt(nx * nx + ny * ny);
        if (len < 1e-10) continue;
        nx /= len; ny /= len;

        // Find outward edge
        var bestMx = cc[0]; var bestMy = cc[1]; var bestDot = -Infinity;
        for (var ei = 0; ei < 4; ei++) {
          var ea = poly[ei]; var eb = poly[(ei + 1) % 4];
          var emx = (ea[0] + eb[0]) / 2; var emy = (ea[1] + eb[1]) / 2;
          var d = (emx - cc[0]) * nx + (emy - cc[1]) * ny;
          if (d > bestDot) { bestDot = d; bestMx = emx; bestMy = emy; }
        }

        var px = bestMx + nx * 0.1;
        var py = bestMy + ny * 0.1;

        var cellIdx = outerToRingIdx[gridId] !== undefined ? outerToRingIdx[gridId] : -1;
        points.push({ position: [px, py, z], side: 'near', cellIdx: cellIdx, normal: [nx, ny] });
      }
    }
  }

  return points;
}

// ── Raycasting ─────────────────────────────────────────

function castSunRays(point, sunVectors, meshes) {
  var results = [];
  var origin = new THREE.Vector3(point[0], point[1], point[2]);
  for (var i = 0; i < sunVectors.length; i++) {
    var dir = new THREE.Vector3(sunVectors[i][0], sunVectors[i][1], sunVectors[i][2]).normalize();
    _raycaster.set(origin, dir);
    _raycaster.far = MAX_RAY_DISTANCE;
    _raycaster.near = 0.05;  // inside niche: skip FP touching, catch piers/sill/lintel
    var hits = _raycaster.intersectObjects(meshes, false);
    results.push({ free: hits.length === 0, distance: hits.length > 0 ? hits[0].distance : null });
  }
  return results;
}

// ── 3D Visualization ───────────────────────────────────

function createDotMesh(position, color) {
  var geo = new THREE.SphereGeometry(POINT_RADIUS, 8, 6);
  var mat = new THREE.MeshBasicMaterial({ color: color, depthTest: true, transparent: true, opacity: 0.85 });
  var mesh = new THREE.Mesh(geo, mat);
  mesh.position.set(position[0], position[1], position[2]);
  return mesh;
}

function clearRays() {
  if (_raysGroup && _threeOverlay) { _threeOverlay.removeMesh(_raysGroup); _raysGroup = null; }
}

function clearResults() {
  if (_resultGroup && _threeOverlay) { _threeOverlay.removeMesh(_resultGroup); _resultGroup = null; }
  clearRays();
  _collisionMeshes = [];
  _lastResults = null;
  _lastPointData = null;
  _lastCellMap = null;
  _analysisLevel = null;
}

function displayResults(facadeResults) {
  if (_resultGroup && _threeOverlay) _threeOverlay.removeMesh(_resultGroup);
  _resultGroup = new THREE.Group();
  for (var i = 0; i < facadeResults.length; i++) {
    var r = facadeResults[i];
    _resultGroup.add(createDotMesh(r.position, COLORS[r.status] || 0x888888));
  }
  _threeOverlay.addMesh(_resultGroup);
}

function showAllRays(sunVectors) {
  clearRays();
  if (!_lastPointData || _lastPointData.length === 0) return;
  _raysGroup = new THREE.Group();

  for (var i = 0; i < _lastPointData.length; i++) {
    var pd = _lastPointData[i];
    var origin = new THREE.Vector3(pd.position[0], pd.position[1], pd.position[2]);

    for (var ri = 0; ri < pd.perRay.length; ri++) {
      var ray = pd.perRay[ri];
      var sv = sunVectors[ri];
      var dir = new THREE.Vector3(sv[0], sv[1], sv[2]).normalize();
      var len = ray.free ? RAY_FREE_LENGTH : (ray.distance || RAY_FREE_LENGTH);
      var end = new THREE.Vector3().copy(origin).addScaledVector(dir, len);
      var color = ray.free ? RAY_COLORS.free : RAY_COLORS.blocked;
      var geo = new THREE.BufferGeometry().setFromPoints([origin, end]);
      var mat = new THREE.LineBasicMaterial({ color: color, transparent: true, opacity: ray.free ? 0.25 : 0.5 });
      _raysGroup.add(new THREE.LineSegments(geo, mat));
    }
  }
  _threeOverlay.addMesh(_raysGroup);
}

// ── Analysis pipeline ──────────────────────────────────

function collectSections() {
  var all = _featureStore.toArray();
  var out = [];
  for (var i = 0; i < all.length; i++)
    if (all[i].properties.type === 'section-axis') out.push(all[i]);
  return out;
}

function collectTowers() {
  var all = _featureStore.toArray();
  var out = [];
  for (var i = 0; i < all.length; i++)
    if (all[i].properties.type === 'tower-axis') out.push(all[i]);
  return out;
}

var _stableOrigin = null;

function getProj() {
  if (!_stableOrigin) return null;
  return createProjection(_stableOrigin[0], _stableOrigin[1]);
}

function runAnalysis(level, axisId, sectionIdx, maxFloor) {
  clearResults();
  var sections = collectSections();
  var allTowers = collectTowers();
  if (sections.length === 0 && allTowers.length === 0) return;

  _analysisLevel = level;
  if (level === 'global') {
    _globalActive = true;
  }
  var proj = getProj();
  if (!proj) {
    log.warn('[insolation] no projection origin yet — run section-gen first');
    return;
  }
  var sunData = getSunVectors(LATITUDE);
  var sunVectors = sunData.vectors;
  var rayMinutes = sunData.timeStep;

  _collisionMeshes = buildAllCollisionMeshes(sections, collectTowers(), proj);

  var targets = [];
  if (level === 'global') { targets = sections; }
  else {
    for (var i = 0; i < sections.length; i++)
      if (sections[i].properties.id === axisId) { targets.push(sections[i]); break; }
  }

  // Determine floor range
  var floorStart = 1;
  var floorEnd = maxFloor || 1; // default: floor 1 only

  var facadeResults = [];
  var pass = 0; var warn = 0; var fail = 0;

  for (var si = 0; si < targets.length; si++) {
    var feature = targets[si];
    var lineId = feature.properties.id;
    var storedFP = feature.properties.footprints;
    if (!storedFP || storedFP.length === 0) continue;
    var params = getParams(feature.properties);

    for (var fi = 0; fi < storedFP.length; fi++) {
      if (level === 'section' && fi !== sectionIdx) continue;
      var fp = storedFP[fi];
      var secH = getSectionHeight(fp, params);
      var fpM = buildFpM(fp, proj);

      var hasLeftNeighbor = fi > 0;
      var hasRightNeighbor = fi < storedFP.length - 1;

      // Pre-compute neighbor floor counts for height-difference check
      var leftFC = 0;
      var rightFC = 0;
      if (hasLeftNeighbor) {
        var leftH = getSectionHeight(storedFP[fi - 1], params);
        leftFC = computeFloorCount(leftH, params.firstFloorHeight, params.typicalFloorHeight);
      }
      if (hasRightNeighbor) {
        var rightH = getSectionHeight(storedFP[fi + 1], params);
        rightFC = computeFloorCount(rightH, params.firstFloorHeight, params.typicalFloorHeight);
      }

      // Loop over all requested floors
      var buildingH = computeBuildingHeight(secH, params.firstFloorHeight, params.typicalFloorHeight);
      var fc = computeFloorCount(secH, params.firstFloorHeight, params.typicalFloorHeight);
      var actualMaxFloor = Math.min(floorEnd, fc - 1); // fc includes floor 0

      for (var fl = floorStart; fl <= actualMaxFloor; fl++) {
        // Per-floor neighbor check: if this floor is above neighbor's roof → expose end wall
        var flHasLeft = hasLeftNeighbor && fl < leftFC;
        var flHasRight = hasRightNeighbor && fl < rightFC;

        var points = generateFacadePoints(fpM, params, secH, flHasLeft, flHasRight, fl, fp);
        for (var pi = 0; pi < points.length; pi++) {
          var pt = points[pi];
          var rayResults = castSunRays(pt.position, sunVectors, _collisionMeshes);
          var isFree = [];
          for (var ri = 0; ri < rayResults.length; ri++) isFree.push(rayResults[ri].free);
          var ev = evaluateInsolation(isFree, NORMATIVE_MINUTES, rayMinutes);

          facadeResults.push({
            axisId: lineId, sectionIdx: fi, floor: fl,
            position: pt.position, side: pt.side, cellIdx: pt.cellIdx,
            status: ev.status, totalMinutes: ev.totalMinutes,
            requiredMinutes: ev.requiredMinutes, message: ev.message,
            perRay: rayResults
          });
          if (ev.status === 'PASS') pass++;
          else if (ev.status === 'WARNING') warn++;
          else fail++;
        }
      }
    }
  }

  // ── Tower facade points ──
  var towerTargets = collectTowers();
  if (level === 'global') {
    // Process all towers
  } else {
    // Filter to specific axis if needed
    var filteredTowers = [];
    for (var tti = 0; tti < towerTargets.length; tti++) {
      if (towerTargets[tti].properties.id === axisId) filteredTowers.push(towerTargets[tti]);
    }
    towerTargets = filteredTowers;
  }

  for (var tti = 0; tti < towerTargets.length; tti++) {
    var tFeature = towerTargets[tti];
    var tLineId = tFeature.properties.id;
    var tFP = tFeature.properties.footprints;
    if (!tFP || tFP.length === 0) continue;

    var tCellSize = tFeature.properties.cellSize || 3.3;
    var tCoords = tFeature.geometry.coordinates;
    if (!tCoords || tCoords.length < 2) continue;

    var tStartM = proj.toMeters(tCoords[0][0], tCoords[0][1]);
    var tEndM = proj.toMeters(tCoords[1][0], tCoords[1][1]);
    var tOri = classifySegment(tStartM, tEndM);
    var tNorthEnd = tFeature.properties.northEnd || detectNorthEnd(tStartM, tEndM);

    for (var tfi = 0; tfi < tFP.length; tfi++) {
      var tfp = tFP[tfi];
      var tSize = tfp.size || 'small';
      var tDims = getTowerDimensions(tSize, tCellSize, tOri.orientationName);

      var tfpM = buildFpM(tfp, proj);

      // Compute exit side (same logic as processor)
      var exitSide;
      if (tOri.orientationName === 'lon') {
        exitSide = tNorthEnd === 'start' ? 'row-start' : 'row-end';
      } else {
        var acrossY = tfpM[3][1] - tfpM[0][1];
        exitSide = acrossY >= 0 ? 'col-high' : 'col-low';
      }

      var towerH = tFeature.properties.towerHeight || 112;
      var perH = tfp.towerHeight !== undefined ? tfp.towerHeight : towerH;
      var tfc = computeFloorCount(perH, 4.5, 3.0);
      var actualMaxFloor = Math.min(floorEnd, tfc - 1);

      for (var tfl = floorStart; tfl <= actualMaxFloor; tfl++) {
        var tPoints = generateTowerFacadePoints(tfpM, tDims, exitSide, tfl);
        log.debug('[insol] tower ' + tfi + ' floor ' + tfl + ': ' + tPoints.length + ' facade points, dims=' + tDims.rows + '×' + tDims.cols + ' exit=' + exitSide);
        for (var tpi = 0; tpi < tPoints.length; tpi++) {
          var tpt = tPoints[tpi];
          var tRayResults = castSunRays(tpt.position, sunVectors, _collisionMeshes);
          var tIsFree = [];
          for (var tri = 0; tri < tRayResults.length; tri++) tIsFree.push(tRayResults[tri].free);
          var tEv = evaluateInsolation(tIsFree, NORMATIVE_MINUTES, rayMinutes);

          facadeResults.push({
            axisId: tLineId, sectionIdx: tfi, floor: tfl,
            position: tpt.position, side: tpt.side, cellIdx: tpt.cellIdx,
            status: tEv.status, totalMinutes: tEv.totalMinutes,
            requiredMinutes: tEv.requiredMinutes, message: tEv.message,
            perRay: tRayResults
          });
          if (tEv.status === 'PASS') pass++;
          else if (tEv.status === 'WARNING') warn++;
          else fail++;
        }
      }
    }
  }

  _lastResults = facadeResults;
  _lastPointData = facadeResults;
  log.debug('[insol] TOTAL: ' + facadeResults.length + ' facade points (P:' + pass + ' W:' + warn + ' F:' + fail + ')');
  displayResults(facadeResults);
  if (_raysVisible) showAllRays(sunVectors);

  // Build cell-level insolation map — per floor
  var STATUS_TO_FLAG = { 'PASS': 'p', 'WARNING': 'w', 'FAIL': 'f' };
  _lastCellMap = {};
  for (var ri2 = 0; ri2 < facadeResults.length; ri2++) {
    var fr = facadeResults[ri2];
    var aId = fr.axisId;
    var sIdx = fr.sectionIdx;
    var flr = fr.floor || 1;
    if (!_lastCellMap[aId]) _lastCellMap[aId] = {};
    if (!_lastCellMap[aId][sIdx]) _lastCellMap[aId][sIdx] = {};
    if (!_lastCellMap[aId][sIdx][flr]) _lastCellMap[aId][sIdx][flr] = { points: [] };
    _lastCellMap[aId][sIdx][flr].points.push({
      side: fr.side, cellIdx: fr.cellIdx,
      flag: STATUS_TO_FLAG[fr.status] || 'p'
    });
  }

  var floorLabel = floorEnd > 1 ? ' (floors 1-' + floorEnd + ')' : '';
  log.debug('[insolation] ' + level + floorLabel + ': ' + facadeResults.length + ' pts — P:' + pass + ' W:' + warn + ' F:' + fail);
  _eventBus.emit('insolation:results', {
    level: level, total: facadeResults.length,
    pass: pass, warning: warn, fail: fail,
    complianceRate: facadeResults.length > 0 ? ((pass + warn) / facadeResults.length * 100).toFixed(0) : 0
  });
  _eventBus.emit('insolation:cell-map', _lastCellMap);
  _eventBus.emit('insolation:rays:visibility', { visible: _raysVisible });
}

// ── Ray toggle ─────────────────────────────────────────

function toggleRays() {
  _raysVisible = !_raysVisible;
  if (_raysVisible && _lastPointData) {
    showAllRays(getSunVectors(LATITUDE).vectors);
  } else { clearRays(); }
  _eventBus.emit('insolation:rays:visibility', { visible: _raysVisible });
}

// ── Event handlers ─────────────────────────────────────

function onClear() {
  _globalActive = false;
  _raysVisible = false;
  clearResults();
  _eventBus.emit('insolation:cell-map', null);
  _eventBus.emit('insolation:rays:visibility', { visible: false });
}

var _debounceTimer = null;
function onSectionsChanged() {
  if (!_globalActive) return;
  if (_debounceTimer) clearTimeout(_debounceTimer);
  _debounceTimer = setTimeout(function () {
    _debounceTimer = null;
    var sections = collectSections();
    var towers = collectTowers();
    if (sections.length === 0 && towers.length === 0) { onClear(); return; }
    runAnalysis('global');
  }, 150);
}

function onSectionRebuilt() {
  // section-gen's processAllSections calls threeOverlay.clear(),
  // which destroys our dot/ray meshes. Re-display if we have results.
  if (!_lastResults || _lastResults.length === 0) return;
  _resultGroup = null;
  _raysGroup = null;
  displayResults(_lastResults);
  if (_raysVisible) showAllRays(getSunVectors(LATITUDE).vectors);
}

// ── Module ─────────────────────────────────────────────

var insolationModule = {
  id: 'insolation',
  init: function (ctx) {
    _mapManager = ctx.mapManager;
    _featureStore = ctx.featureStore;
    _eventBus = ctx.eventBus;
    _threeOverlay = ctx.threeOverlay || null;

    _unsubs.push(_eventBus.on('insolation:analyze:global', function () { runAnalysis('global'); }));
    _unsubs.push(_eventBus.on('insolation:analyze:axis', function (d) { if (d && d.axisId) runAnalysis('axis', d.axisId); }));
    _unsubs.push(_eventBus.on('insolation:analyze:section', function (d) {
      if (d && d.axisId !== undefined && d.sectionIdx !== undefined) runAnalysis('section', d.axisId, d.sectionIdx);
    }));
    _unsubs.push(_eventBus.on('insolation:clear', onClear));
    _unsubs.push(_eventBus.on('insolation:rays:toggle', toggleRays));
    _unsubs.push(_eventBus.on('features:changed', onSectionsChanged));
    _unsubs.push(_eventBus.on('section-gen:params:changed', onSectionsChanged));
    _unsubs.push(_eventBus.on('section:param:changed', onSectionsChanged));
    _unsubs.push(_eventBus.on('section-gen:rebuilt', onSectionRebuilt));
    _unsubs.push(_eventBus.on('section-gen:origin', function (origin) { _stableOrigin = origin; }));
    _unsubs.push(_eventBus.on('insolation:run-multi-floor', function () {
      // Compute max residential floor across all sections
      var sections = collectSections();
      var maxFloor = 1;
      for (var i = 0; i < sections.length; i++) {
        var fps = sections[i].properties.footprints;
        if (!fps) continue;
        var params = getParams(sections[i].properties);
        for (var fi = 0; fi < fps.length; fi++) {
          var fc = computeFloorCount(getSectionHeight(fps[fi], params),
            params.firstFloorHeight, params.typicalFloorHeight);
          if (fc - 1 > maxFloor) maxFloor = fc - 1; // -1 for commercial floor
        }
      }
      log.debug('[insolation] multi-floor: running floors 1-' + maxFloor);
      runAnalysis('global', null, null, maxFloor);
    }));

    log.debug('[insolation] initialized (lat=' + LATITUDE + '°, norm=' + NORMATIVE_MINUTES + 'min)');
  },
  destroy: function () {
    for (var i = 0; i < _unsubs.length; i++) _unsubs[i]();
    _unsubs = [];
    _globalActive = false;
    clearResults();
    _mapManager = null; _featureStore = null; _eventBus = null; _threeOverlay = null;
    _stableOrigin = null;
  }
};

export function isInsolLiveActive() { return _globalActive; }

export default insolationModule;
