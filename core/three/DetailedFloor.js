/**
 * DetailedFloor — detailed floor 1 geometry.
 *
 * Cell boxes: from baseZ to topZ, apt-colored sides, dark grey top cap.
 * Walls: inward from footprint edge. 0.3m between apartments, 0.15m inside.
 * Facades: 0.6m thick inward, windows on apartment cells.
 * End walls: windows on apartment edge cells (torec gets light from ends).
 */

import * as THREE from 'three';
import {
  MATERIALS, WALL_MAT, EXT_WALL_MAT, GLASS_MAT, WIN_EDGE_MAT, TOP_CAP_MAT,
  GROUND_FLOOR_MAT, ROOF_SLAB_BODY_MAT, ROOF_TOP_MAT, darkenColor
} from './materials.js';
import { buildBoxGeometry, buildBoxEdges, insetPoly, insetPolyPerEdge } from './BoxGeometry.js';
import { buildDetailLabel } from './Labels.js';

// Tag every mesh in a subtree so ThreeOverlay's whitewash pass leaves
// it alone (concrete cocoll stays concrete in white-model mode).
function tagSkipWhitewash(root) {
  root.traverse(function (obj) {
    if (obj.isMesh) obj.userData.skipWhitewash = true;
  });
}

// ── Internal helpers ──────────────────────────────────

function buildPartitionWall(p1, p2, baseZ, topZ, thickness) {
  var dx = p2[0] - p1[0]; var dy = p2[1] - p1[1];
  var len = Math.sqrt(dx * dx + dy * dy);
  if (len < 0.01) return new THREE.Group();
  var px = -dy / len * thickness * 0.5;
  var py = dx / len * thickness * 0.5;
  var corners = [
    [p1[0] - px, p1[1] - py], [p2[0] - px, p2[1] - py],
    [p2[0] + px, p2[1] + py], [p1[0] + px, p1[1] + py]
  ];
  var geo = buildBoxGeometry(corners, baseZ, topZ);
  var g = new THREE.Group();
  g.add(new THREE.Mesh(geo, WALL_MAT));
  g.add(buildBoxEdges(corners, baseZ, topZ));
  return g;
}

function buildFacadeWithWindow(fp1, fp2, nx, ny, floorZ, topZ, wallColor) {
  var EXT_T = 0.6;
  var NOTCH = 0.5;
  var WIN_W = 1.8;
  var WIN_H = 1.5;
  var WIN_SILL = 1.2;
  var g = new THREE.Group();

  var dx = fp2[0] - fp1[0]; var dy = fp2[1] - fp1[1];
  var fLen = Math.sqrt(dx * dx + dy * dy);
  if (fLen < 0.5) return g;
  var ax = dx / fLen; var ay = dy / fLen;

  var i1 = [fp1[0] - nx * EXT_T, fp1[1] - ny * EXT_T];
  var i2 = [fp2[0] - nx * EXT_T, fp2[1] - ny * EXT_T];

  var winL = (fLen - WIN_W) / 2;
  var winR = winL + WIN_W;
  if (winL < 0.15) winL = 0.15;
  if (winR > fLen - 0.15) winR = fLen - 0.15;
  var winBot = floorZ + WIN_SILL;
  var winTop = winBot + WIN_H;
  if (winTop > topZ - 0.1) winTop = topZ - 0.1;

  function oP(t) { return [fp1[0] + ax * t, fp1[1] + ay * t]; }
  function iP(t) { return [i1[0] + ax * t, i1[1] + ay * t]; }

  var mat = wallColor
    ? new THREE.MeshLambertMaterial({ color: darkenColor(wallColor, 0.8), side: THREE.DoubleSide })
    : EXT_WALL_MAT;

  // 1. Below window
  g.add(new THREE.Mesh(buildBoxGeometry([fp1, fp2, i2, i1], floorZ, winBot), mat));
  // 2. Above window
  if (winTop < topZ) {
    g.add(new THREE.Mesh(buildBoxGeometry([fp1, fp2, i2, i1], winTop, topZ), mat));
  }
  // 3. Left pier
  if (winL > 0.05) {
    g.add(new THREE.Mesh(buildBoxGeometry([fp1, oP(winL), iP(winL), i1], winBot, winTop), mat));
  }
  // 4. Right pier
  if (winR < fLen - 0.05) {
    g.add(new THREE.Mesh(buildBoxGeometry([oP(winR), fp2, i2, iP(winR)], winBot, winTop), mat));
  }
  // 5. Back wall behind window opening
  var n1 = [fp1[0] - nx * NOTCH, fp1[1] - ny * NOTCH];
  var n2 = [fp2[0] - nx * NOTCH, fp2[1] - ny * NOTCH];
  function nP(t) { return [n1[0] + ax * t, n1[1] + ay * t]; }
  g.add(new THREE.Mesh(buildBoxGeometry([nP(winL), nP(winR), iP(winR), iP(winL)], winBot, winTop), mat));

  // 6. Glass at notch face
  var gwl = nP(winL); var gwr = nP(winR);
  var gv = new Float32Array([
    gwl[0], gwl[1], winBot, gwr[0], gwr[1], winBot,
    gwr[0], gwr[1], winTop, gwl[0], gwl[1], winTop
  ]);
  var gi = new Uint16Array([0,1,2, 0,2,3, 2,1,0, 3,2,0]);
  var gg = new THREE.BufferGeometry();
  gg.setAttribute('position', new THREE.BufferAttribute(gv, 3));
  gg.setIndex(new THREE.BufferAttribute(gi, 1));
  gg.computeVertexNormals();
  g.add(new THREE.Mesh(gg, GLASS_MAT));

  // 7. Window frame edges
  var ev = new Float32Array([
    gwl[0],gwl[1],winBot, gwr[0],gwr[1],winBot,
    gwr[0],gwr[1],winBot, gwr[0],gwr[1],winTop,
    gwr[0],gwr[1],winTop, gwl[0],gwl[1],winTop,
    gwl[0],gwl[1],winTop, gwl[0],gwl[1],winBot
  ]);
  var eg = new THREE.BufferGeometry();
  eg.setAttribute('position', new THREE.Float32BufferAttribute(ev, 3));
  g.add(new THREE.LineSegments(eg, WIN_EDGE_MAT));

  return g;
}

// Sentinel string returned by cellColor() for LLU cells — keeps the
// outer-wall builder shared but routes LLU through MATERIALS.llu so
// the entire vertical of LLU reads as one consistent grey volume.
var LLU_WALL_SENTINEL = '__LLU__';

function buildSolidExtWall(fp1, fp2, nx, ny, floorZ, topZ, wallColor) {
  var EXT_T = 0.6;
  var i1 = [fp1[0] - nx * EXT_T, fp1[1] - ny * EXT_T];
  var i2 = [fp2[0] - nx * EXT_T, fp2[1] - ny * EXT_T];
  var mat;
  if (wallColor === LLU_WALL_SENTINEL) {
    mat = MATERIALS.llu;
  } else if (wallColor) {
    mat = new THREE.MeshLambertMaterial({ color: darkenColor(wallColor, 0.8), side: THREE.DoubleSide });
  } else {
    mat = EXT_WALL_MAT;
  }
  var geo = buildBoxGeometry([fp1, fp2, i2, i1], floorZ, topZ);
  var g = new THREE.Group();
  g.add(new THREE.Mesh(geo, mat));
  g.add(buildBoxEdges([fp1, fp2, i2, i1], floorZ, topZ));
  return g;
}

function buildTopCap(poly, z) {
  var v = new Float32Array([
    poly[0][0],poly[0][1],z, poly[1][0],poly[1][1],z,
    poly[2][0],poly[2][1],z, poly[3][0],poly[3][1],z
  ]);
  var geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(v, 3));
  geo.setIndex(new THREE.BufferAttribute(new Uint16Array([0,1,2, 0,2,3]), 1));
  geo.computeVertexNormals();
  return new THREE.Mesh(geo, TOP_CAP_MAT);
}

// ── Main export ───────────────────────────────────────

export function buildDetailedFloor1(graphNodes, N, baseZ, topZ, cellAptMap, inset, hasLeftNeighbor, hasRightNeighbor, showLabels) {
  var group = new THREE.Group();
  var SLAB = 0.3;
  var floorZ = baseZ + SLAB;
  if (showLabels === undefined) showLabels = true;

  // Collect floor 1 cells
  var numCells = {};
  var corrCells = {};
  for (var key in graphNodes) {
    if (!graphNodes.hasOwnProperty(key)) continue;
    var node = graphNodes[key];
    if (node.floor !== 1) continue;
    if (typeof node.cellId === 'number') numCells[node.cellId] = node;
    else corrCells[node.cellId] = node;
  }

  // ── 1. Cell boxes: full-height, per-edge inset ──
  var cellTopZ = topZ;
  var GAP = 0.05;
  var EXT_T = 0.6; // facade/end wall thickness

  // Near cells: edge0=facade, edge1=right, edge2=corridor, edge3=left
  for (var i = 0; i < N; i++) {
    if (!numCells[i]) continue;
    var node = numCells[i];
    var poly = node.polygon;
    if (!poly || poly.length < 4) continue;
    var m0 = EXT_T; // facade
    var m1 = (i === N - 1) ? EXT_T : GAP; // right end wall or gap
    var m2 = GAP; // corridor
    var m3 = (i === 0) ? EXT_T : GAP; // left end wall or gap
    var ip = insetPolyPerEdge(poly, [m0, m1, m2, m3]);
    var info = cellAptMap ? cellAptMap[node.cellId] : null;
    var matl;
    if (info && info.color) {
      matl = new THREE.MeshLambertMaterial({ color: new THREE.Color(info.color), side: THREE.DoubleSide });
    } else {
      matl = MATERIALS[node.type] || MATERIALS.apartment;
    }
    group.add(new THREE.Mesh(buildBoxGeometry(ip, baseZ, cellTopZ), matl));
    if (node.type !== 'llu') {
      group.add(buildTopCap(ip, cellTopZ));
    }
    if (showLabels && info && info.label) {
      group.add(buildDetailLabel(info.label, poly, cellTopZ + 0.1, GAP));
    }
  }
  // Far cells: edge0=corridor, edge1=right, edge2=facade, edge3=left
  for (var i = N; i < 2 * N; i++) {
    if (!numCells[i]) continue;
    var node = numCells[i];
    var poly = node.polygon;
    if (!poly || poly.length < 4) continue;
    var m0 = GAP; // corridor
    var m1 = (i === N) ? EXT_T : GAP; // right end wall or gap
    var m2 = EXT_T; // facade
    var m3 = (i === 2 * N - 1) ? EXT_T : GAP; // left end wall or gap
    var ip = insetPolyPerEdge(poly, [m0, m1, m2, m3]);
    var info = cellAptMap ? cellAptMap[node.cellId] : null;
    var matl;
    if (info && info.color) {
      matl = new THREE.MeshLambertMaterial({ color: new THREE.Color(info.color), side: THREE.DoubleSide });
    } else {
      matl = MATERIALS[node.type] || MATERIALS.apartment;
    }
    group.add(new THREE.Mesh(buildBoxGeometry(ip, baseZ, cellTopZ), matl));
    if (node.type !== 'llu') {
      group.add(buildTopCap(ip, cellTopZ));
    }
    if (showLabels && info && info.label) {
      group.add(buildDetailLabel(info.label, poly, cellTopZ + 0.1, GAP));
    }
  }

  // Corridor cells — render individually
  var corrLeftId = '0-' + (2 * N - 1);
  var corrRightId = (N - 1) + '-' + N;
  for (var cid in corrCells) {
    if (!corrCells.hasOwnProperty(cid)) continue;
    var node = corrCells[cid];
    var poly = node.polygon;
    if (!poly || poly.length < 4) continue;
    var ip = insetPoly(poly, GAP);
    var info = cellAptMap ? cellAptMap[node.cellId] : null;
    var matl;
    // End corridor cells: use apartment color if available
    if ((cid === corrLeftId || cid === corrRightId) && info && info.color) {
      matl = new THREE.MeshLambertMaterial({ color: new THREE.Color(info.color), side: THREE.DoubleSide });
    } else {
      matl = MATERIALS.corridor;
    }
    group.add(new THREE.Mesh(buildBoxGeometry(ip, baseZ, cellTopZ), matl));
  }

  // Internal walls removed — gaps between inset boxes serve as visual separators

  // ── 3. Facade walls + windows ──
  function outwardNormal(poly, fp1, fp2) {
    var cx = (poly[0][0] + poly[1][0] + poly[2][0] + poly[3][0]) / 4;
    var cy = (poly[0][1] + poly[1][1] + poly[2][1] + poly[3][1]) / 4;
    var mx = (fp1[0] + fp2[0]) / 2; var my = (fp1[1] + fp2[1]) / 2;
    var odx = mx - cx; var ody = my - cy;
    var olen = Math.sqrt(odx * odx + ody * ody);
    if (olen < 0.001) return null;
    return [odx / olen, ody / olen];
  }

  function cellColor(cid) {
    var inf = cellAptMap ? cellAptMap[cid] : null;
    if (inf && inf.color) return inf.color;
    // LLU cells route through the LLU material directly (medium grey,
    // skipWhitewash) so the LLU stack reads as one volume.
    if (numCells[cid] && numCells[cid].type === 'llu') return LLU_WALL_SENTINEL;
    return null;
  }

  // Near facades
  for (var i = 0; i < N; i++) {
    if (!numCells[i]) continue;
    var poly = numCells[i].polygon;
    var n = outwardNormal(poly, poly[0], poly[1]);
    if (!n) continue;
    var wc = cellColor(i);
    if (numCells[i].type === 'apartment') {
      group.add(buildFacadeWithWindow(poly[0], poly[1], n[0], n[1], floorZ, topZ, wc));
    } else {
      group.add(buildSolidExtWall(poly[0], poly[1], n[0], n[1], floorZ, topZ, wc));
    }
  }
  // Far facades
  for (var i = N; i < 2 * N; i++) {
    if (!numCells[i]) continue;
    var poly = numCells[i].polygon;
    var n = outwardNormal(poly, poly[3], poly[2]);
    if (!n) continue;
    var wc = cellColor(i);
    if (numCells[i].type === 'apartment') {
      group.add(buildFacadeWithWindow(poly[3], poly[2], n[0], n[1], floorZ, topZ, wc));
    } else {
      group.add(buildSolidExtWall(poly[3], poly[2], n[0], n[1], floorZ, topZ, wc));
    }
  }

  // ── 4. End walls ──
  function renderEndWall(cellId, fp1Idx, fp2Idx, hasNeighbor) {
    if (!numCells[cellId]) return;
    var poly = numCells[cellId].polygon;
    var n = outwardNormal(poly, poly[fp1Idx], poly[fp2Idx]);
    if (!n) return;
    var wc = cellColor(cellId);
    if (!hasNeighbor && numCells[cellId].type === 'apartment') {
      group.add(buildFacadeWithWindow(poly[fp1Idx], poly[fp2Idx], n[0], n[1], floorZ, topZ, wc));
    } else {
      group.add(buildSolidExtWall(poly[fp1Idx], poly[fp2Idx], n[0], n[1], floorZ, topZ, wc));
    }
  }

  // Left end
  renderEndWall(0, 0, 3, hasLeftNeighbor);
  renderEndWall(2 * N - 1, 0, 3, hasLeftNeighbor);
  // Right end
  renderEndWall(N - 1, 1, 2, hasRightNeighbor);
  renderEndWall(N, 1, 2, hasRightNeighbor);

  return group;
}

/**
 * Build LLU rooftop extension — stairwell/elevator shaft above roof.
 * Visual mesh matching the LLU cell footprint, extruded upward.
 */
export function buildLLURoof(graphNodes, N, buildingH, lluHeight) {
  var group = new THREE.Group();
  if (!lluHeight) lluHeight = 2.5;

  // Find LLU cells from floor 1
  var lluCells = [];
  for (var key in graphNodes) {
    if (!graphNodes.hasOwnProperty(key)) continue;
    var node = graphNodes[key];
    if (node.floor === 1 && node.type === 'llu' && typeof node.cellId === 'number') {
      lluCells.push(node);
    }
  }
  if (lluCells.length === 0) return group;

  // Render each LLU cell as a box above the roof
  var roofZ = buildingH;
  var topZ = buildingH + lluHeight;
  var lluMat = MATERIALS.llu || new THREE.MeshLambertMaterial({ color: 0x4f81bd, side: THREE.DoubleSide });

  for (var i = 0; i < lluCells.length; i++) {
    var poly = lluCells[i].polygon;
    if (!poly || poly.length < 4) continue;
    // buildBoxGeometry already includes the top face; an explicit cap
    // mesh on top of it caused z-fighting that flickered as the camera
    // moved. The single box is sufficient.
    group.add(new THREE.Mesh(buildBoxGeometry(poly, roofZ, topZ), lluMat));
  }

  return group;
}

// ── Ground floor (commercial / non-residential) ──────

// Storefront proportions — tuned for minimalist modern residential.
// Slim piers, low plinth, large glass bays, deep recess for a
// shadow-play under the header beam.
var SF_EXT_T = 0.6;
var SF_NOTCH = 0.4;
var SF_SIDE_PIER = 0.25;
var SF_SILL_H = 0.15;
var SF_TRANSOM_H = 0.3;
var SF_MULLION_W = 0.06;
var SF_MULLION_TARGET = 2.2;  // wider bays read more "modern" than a tight residential cadence

// Deterministic 0..1 hash from position so end-wall variants stay
// stable across rebuilds (instead of flickering with Math.random).
function hash01(x, y) {
  var s = Math.sin(x * 12.9898 + y * 78.233) * 43758.5453;
  return s - Math.floor(s);
}

/**
 * Storefront-style facade segment: wide glass running almost full
 * cell width, low concrete plinth, structural header, slim mullions
 * for a balanced retail rhythm.
 *
 * @param {[number,number]} fp1 - facade edge start (outer face)
 * @param {[number,number]} fp2 - facade edge end (outer face)
 * @param {number} nx - outward normal x (cell-center → outside)
 * @param {number} ny - outward normal y
 * @param {number} floorZ - floor base Z (no slab on cocoll)
 * @param {number} topZ - top of ground floor
 */
function buildStorefrontFacade(fp1, fp2, nx, ny, floorZ, topZ) {
  var g = new THREE.Group();

  var dx = fp2[0] - fp1[0]; var dy = fp2[1] - fp1[1];
  var fLen = Math.sqrt(dx * dx + dy * dy);
  if (fLen < SF_SIDE_PIER * 2 + 0.4) return g;
  var ax = dx / fLen; var ay = dy / fLen;

  var i1 = [fp1[0] - nx * SF_EXT_T, fp1[1] - ny * SF_EXT_T];
  var i2 = [fp2[0] - nx * SF_EXT_T, fp2[1] - ny * SF_EXT_T];

  var winL = SF_SIDE_PIER;
  var winR = fLen - SF_SIDE_PIER;
  var winBot = floorZ + SF_SILL_H;
  var winTop = topZ - SF_TRANSOM_H;
  if (winTop <= winBot + 0.5) return g;

  function oP(t) { return [fp1[0] + ax * t, fp1[1] + ay * t]; }
  function iP(t) { return [i1[0] + ax * t, i1[1] + ay * t]; }

  // 1. Plinth (concrete base under the glass)
  g.add(new THREE.Mesh(buildBoxGeometry([fp1, fp2, i2, i1], floorZ, winBot), GROUND_FLOOR_MAT));
  // 2. Header (structural beam above the glass)
  g.add(new THREE.Mesh(buildBoxGeometry([fp1, fp2, i2, i1], winTop, topZ), GROUND_FLOOR_MAT));
  // 3-4. Side piers
  g.add(new THREE.Mesh(buildBoxGeometry([fp1, oP(winL), iP(winL), i1], winBot, winTop), GROUND_FLOOR_MAT));
  g.add(new THREE.Mesh(buildBoxGeometry([oP(winR), fp2, i2, iP(winR)], winBot, winTop), GROUND_FLOOR_MAT));
  // 5. Recessed back wall behind the glass
  var n1 = [fp1[0] - nx * SF_NOTCH, fp1[1] - ny * SF_NOTCH];
  function nP(t) { return [n1[0] + ax * t, n1[1] + ay * t]; }
  g.add(new THREE.Mesh(buildBoxGeometry([nP(winL), nP(winR), iP(winR), iP(winL)], winBot, winTop), GROUND_FLOOR_MAT));

  // 6. Vertical mullions — divide the glass into ~SF_MULLION_TARGET-wide bays.
  // Each mullion is a thin grey column running from the outer face to
  // the back wall, occupying the depth of the storefront recess.
  var glassW = winR - winL;
  var bays = Math.max(1, Math.round(glassW / SF_MULLION_TARGET));
  if (bays > 1) {
    var bayW = (glassW - SF_MULLION_W * (bays - 1)) / bays;
    for (var k = 1; k < bays; k++) {
      var mc = winL + k * bayW + (k - 0.5) * SF_MULLION_W;
      var ml = mc - SF_MULLION_W * 0.5;
      var mr = mc + SF_MULLION_W * 0.5;
      g.add(new THREE.Mesh(
        buildBoxGeometry([oP(ml), oP(mr), nP(mr), nP(ml)], winBot, winTop),
        GROUND_FLOOR_MAT
      ));
    }
  }

  // 7. Glass plane at the notch face
  var gwl = nP(winL); var gwr = nP(winR);
  var gv = new Float32Array([
    gwl[0], gwl[1], winBot, gwr[0], gwr[1], winBot,
    gwr[0], gwr[1], winTop, gwl[0], gwl[1], winTop
  ]);
  var gi = new Uint16Array([0, 1, 2, 0, 2, 3, 2, 1, 0, 3, 2, 0]);
  var gg = new THREE.BufferGeometry();
  gg.setAttribute('position', new THREE.BufferAttribute(gv, 3));
  gg.setIndex(new THREE.BufferAttribute(gi, 1));
  gg.computeVertexNormals();
  g.add(new THREE.Mesh(gg, GLASS_MAT));

  // 8. Outer window frame (top + bottom + sides)
  var ev = new Float32Array([
    gwl[0], gwl[1], winBot, gwr[0], gwr[1], winBot,
    gwr[0], gwr[1], winBot, gwr[0], gwr[1], winTop,
    gwr[0], gwr[1], winTop, gwl[0], gwl[1], winTop,
    gwl[0], gwl[1], winTop, gwl[0], gwl[1], winBot
  ]);
  var eg = new THREE.BufferGeometry();
  eg.setAttribute('position', new THREE.Float32BufferAttribute(ev, 3));
  g.add(new THREE.LineSegments(eg, WIN_EDGE_MAT));

  return g;
}

/**
 * Entrance group at an LLU position: glass door (full opening),
 * concrete lintel above, side jambs, and a flat canopy projecting
 * outward over the door. Used on the long facade where LLU sits, or
 * on a tower's llu-exit cell.
 */
function buildEntranceGroup(fp1, fp2, nx, ny, floorZ, topZ) {
  var EXT_T = 0.6;
  var DOOR_W_TARGET = 2.4;
  var DOOR_H_TARGET = 2.4;
  var TRANSOM_GAP = 0.6;       // glass transom panel above the door
  var SIDE_MIN = 0.4;
  var CANOPY_PROJECT = 1.4;    // bigger overhang for shelter & shadow
  var CANOPY_T = 0.18;
  var CANOPY_OVERHANG = 0.6;
  var g = new THREE.Group();

  var dx = fp2[0] - fp1[0]; var dy = fp2[1] - fp1[1];
  var fLen = Math.sqrt(dx * dx + dy * dy);
  if (fLen < SIDE_MIN * 2 + 1.0) {
    // Too narrow for a proper door — fall back to a solid grey wall.
    var i1f = [fp1[0] - nx * EXT_T, fp1[1] - ny * EXT_T];
    var i2f = [fp2[0] - nx * EXT_T, fp2[1] - ny * EXT_T];
    g.add(new THREE.Mesh(buildBoxGeometry([fp1, fp2, i2f, i1f], floorZ, topZ), GROUND_FLOOR_MAT));
    return g;
  }
  var ax = dx / fLen; var ay = dy / fLen;
  var doorW = Math.min(DOOR_W_TARGET, fLen - SIDE_MIN * 2);
  var sideW = (fLen - doorW) / 2;
  var doorL = sideW;
  var doorR = doorL + doorW;
  var doorTop = Math.min(floorZ + DOOR_H_TARGET, topZ - TRANSOM_GAP - 0.4);
  // Glass transom band right above the door — modern lobby motif.
  var transomTop = Math.min(doorTop + TRANSOM_GAP, topZ - 0.3);

  var i1 = [fp1[0] - nx * EXT_T, fp1[1] - ny * EXT_T];
  var i2 = [fp2[0] - nx * EXT_T, fp2[1] - ny * EXT_T];
  function oP(t) { return [fp1[0] + ax * t, fp1[1] + ay * t]; }
  function iP(t) { return [i1[0] + ax * t, i1[1] + ay * t]; }

  // 1-2. Side piers (full floor-0 height)
  g.add(new THREE.Mesh(buildBoxGeometry([fp1, oP(doorL), iP(doorL), i1], floorZ, topZ), GROUND_FLOOR_MAT));
  g.add(new THREE.Mesh(buildBoxGeometry([oP(doorR), fp2, i2, iP(doorR)], floorZ, topZ), GROUND_FLOOR_MAT));
  // 3. Header above transom (sits above the glass transom band)
  if (transomTop < topZ) {
    g.add(new THREE.Mesh(buildBoxGeometry([oP(doorL), oP(doorR), iP(doorR), iP(doorL)], transomTop, topZ), GROUND_FLOOR_MAT));
  }
  // 4. Slim crossbeam between door and transom (architectural reveal)
  if (doorTop < transomTop) {
    var beamH = 0.06;
    var beamBot = doorTop;
    var beamTop = Math.min(beamBot + beamH, transomTop);
    g.add(new THREE.Mesh(buildBoxGeometry([oP(doorL), oP(doorR), iP(doorR), iP(doorL)], beamBot, beamTop), GROUND_FLOOR_MAT));
  }

  // 5. Glass — door panel + transom band, both at outer face.
  var dwl = oP(doorL); var dwr = oP(doorR);
  var gv = new Float32Array([
    // Door panel (floor to doorTop)
    dwl[0], dwl[1], floorZ, dwr[0], dwr[1], floorZ,
    dwr[0], dwr[1], doorTop, dwl[0], dwl[1], doorTop,
    // Transom panel (doorTop to transomTop)
    dwl[0], dwl[1], doorTop, dwr[0], dwr[1], doorTop,
    dwr[0], dwr[1], transomTop, dwl[0], dwl[1], transomTop
  ]);
  var gi = new Uint16Array([
    0, 1, 2, 0, 2, 3, 2, 1, 0, 3, 2, 0,
    4, 5, 6, 4, 6, 7, 6, 5, 4, 7, 6, 4
  ]);
  var gg = new THREE.BufferGeometry();
  gg.setAttribute('position', new THREE.BufferAttribute(gv, 3));
  gg.setIndex(new THREE.BufferAttribute(gi, 1));
  gg.computeVertexNormals();
  g.add(new THREE.Mesh(gg, GLASS_MAT));

  // 6. Door frame edges + vertical splitter at door center + transom outline
  var dxC = (dwl[0] + dwr[0]) / 2;
  var dyC = (dwl[1] + dwr[1]) / 2;
  var ev = new Float32Array([
    // Door rectangle
    dwl[0], dwl[1], floorZ, dwr[0], dwr[1], floorZ,
    dwr[0], dwr[1], floorZ, dwr[0], dwr[1], doorTop,
    dwr[0], dwr[1], doorTop, dwl[0], dwl[1], doorTop,
    dwl[0], dwl[1], doorTop, dwl[0], dwl[1], floorZ,
    // Door center splitter
    dxC, dyC, floorZ, dxC, dyC, doorTop,
    // Transom band outline
    dwl[0], dwl[1], transomTop, dwr[0], dwr[1], transomTop
  ]);
  var eg = new THREE.BufferGeometry();
  eg.setAttribute('position', new THREE.Float32BufferAttribute(ev, 3));
  g.add(new THREE.LineSegments(eg, WIN_EDGE_MAT));

  // 7. Canopy — flat slab projecting outward over the door area.
  var canL = Math.max(0, doorL - CANOPY_OVERHANG);
  var canR = Math.min(fLen, doorR + CANOPY_OVERHANG);
  var canBaseZ = transomTop + 0.05;
  var canTopZ = canBaseZ + CANOPY_T;
  if (canTopZ < topZ) {
    var cInL = oP(canL);
    var cInR = oP(canR);
    var cOutL = [cInL[0] + nx * CANOPY_PROJECT, cInL[1] + ny * CANOPY_PROJECT];
    var cOutR = [cInR[0] + nx * CANOPY_PROJECT, cInR[1] + ny * CANOPY_PROJECT];
    g.add(new THREE.Mesh(
      buildBoxGeometry([cInL, cInR, cOutR, cOutL], canBaseZ, canTopZ),
      GROUND_FLOOR_MAT
    ));
  }

  return g;
}

/**
 * Narrow vertical strip — minimalist accent window, 1.2 m wide,
 * placed off-center on the wall. Higher plinth and header than the
 * full storefront so the strip reads as an architectural slot rather
 * than retail glazing. Used for end-wall variants.
 */
function buildNarrowStripFacade(fp1, fp2, nx, ny, floorZ, topZ) {
  var EXT_T = 0.6;
  var NOTCH = 0.3;
  var STRIP_W = 1.2;
  var SILL_H = 0.4;
  var TRANSOM_H = 0.5;
  var g = new THREE.Group();

  var dx = fp2[0] - fp1[0]; var dy = fp2[1] - fp1[1];
  var fLen = Math.sqrt(dx * dx + dy * dy);
  if (fLen < STRIP_W + 0.8) return g;
  var ax = dx / fLen; var ay = dy / fLen;

  var i1 = [fp1[0] - nx * EXT_T, fp1[1] - ny * EXT_T];
  var i2 = [fp2[0] - nx * EXT_T, fp2[1] - ny * EXT_T];
  function oP(t) { return [fp1[0] + ax * t, fp1[1] + ay * t]; }
  function iP(t) { return [i1[0] + ax * t, i1[1] + ay * t]; }

  // Off-center placement (hashed by edge midpoint so it's stable).
  var seed = hash01((fp1[0] + fp2[0]) * 0.5, (fp1[1] + fp2[1]) * 0.5);
  var center;
  if (seed < 0.34) center = fLen * 0.32;
  else if (seed < 0.67) center = fLen * 0.5;
  else center = fLen * 0.68;
  var winL = Math.max(0.3, center - STRIP_W * 0.5);
  var winR = Math.min(fLen - 0.3, winL + STRIP_W);
  if (winR - winL < STRIP_W - 0.2) return g;
  var winBot = floorZ + SILL_H;
  var winTop = topZ - TRANSOM_H;
  if (winTop <= winBot + 0.6) return g;

  // 1. Plinth
  g.add(new THREE.Mesh(buildBoxGeometry([fp1, fp2, i2, i1], floorZ, winBot), GROUND_FLOOR_MAT));
  // 2. Header
  g.add(new THREE.Mesh(buildBoxGeometry([fp1, fp2, i2, i1], winTop, topZ), GROUND_FLOOR_MAT));
  // 3-4. Side walls flanking the strip
  g.add(new THREE.Mesh(buildBoxGeometry([fp1, oP(winL), iP(winL), i1], winBot, winTop), GROUND_FLOOR_MAT));
  g.add(new THREE.Mesh(buildBoxGeometry([oP(winR), fp2, i2, iP(winR)], winBot, winTop), GROUND_FLOOR_MAT));
  // 5. Recessed back wall
  var n1 = [fp1[0] - nx * NOTCH, fp1[1] - ny * NOTCH];
  function nP(t) { return [n1[0] + ax * t, n1[1] + ay * t]; }
  g.add(new THREE.Mesh(buildBoxGeometry([nP(winL), nP(winR), iP(winR), iP(winL)], winBot, winTop), GROUND_FLOOR_MAT));

  // 6. Glass plane
  var gwl = nP(winL); var gwr = nP(winR);
  var gv = new Float32Array([
    gwl[0], gwl[1], winBot, gwr[0], gwr[1], winBot,
    gwr[0], gwr[1], winTop, gwl[0], gwl[1], winTop
  ]);
  var gi = new Uint16Array([0, 1, 2, 0, 2, 3, 2, 1, 0, 3, 2, 0]);
  var gg = new THREE.BufferGeometry();
  gg.setAttribute('position', new THREE.BufferAttribute(gv, 3));
  gg.setIndex(new THREE.BufferAttribute(gi, 1));
  gg.computeVertexNormals();
  g.add(new THREE.Mesh(gg, GLASS_MAT));

  // 7. Frame edges
  var ev = new Float32Array([
    gwl[0], gwl[1], winBot, gwr[0], gwr[1], winBot,
    gwr[0], gwr[1], winBot, gwr[0], gwr[1], winTop,
    gwr[0], gwr[1], winTop, gwl[0], gwl[1], winTop,
    gwl[0], gwl[1], winTop, gwl[0], gwl[1], winBot
  ]);
  var eg = new THREE.BufferGeometry();
  eg.setAttribute('position', new THREE.Float32BufferAttribute(ev, 3));
  g.add(new THREE.LineSegments(eg, WIN_EDGE_MAT));

  return g;
}

/**
 * Solid grey wall (no opening) — used for LLU cells on the ground
 * floor (entrances are intentionally blank from the outside; doors
 * could be added in a future pass).
 */
function buildSolidGroundWall(fp1, fp2, nx, ny, floorZ, topZ) {
  var EXT_T = 0.6;
  var i1 = [fp1[0] - nx * EXT_T, fp1[1] - ny * EXT_T];
  var i2 = [fp2[0] - nx * EXT_T, fp2[1] - ny * EXT_T];
  var geo = buildBoxGeometry([fp1, fp2, i2, i1], floorZ, topZ);
  var g = new THREE.Group();
  g.add(new THREE.Mesh(geo, GROUND_FLOOR_MAT));
  g.add(buildBoxEdges([fp1, fp2, i2, i1], floorZ, topZ));
  return g;
}

/**
 * Build the non-residential ground floor of a section.
 * Mirrors buildDetailedFloor1's structure: per-edge inset cell boxes,
 * facades with storefront windows on apartment/commercial cells, solid
 * walls on LLU cells. No top cap (floor 1 sits flush on top).
 *
 * Mesh-level skipWhitewash flag keeps everything concrete-grey when
 * the user toggles White-model mode.
 *
 * @param {Object} graphNodes - same node bag passed to buildDetailedFloor1
 * @param {number} N          - cells per facade (near edge count)
 * @param {number} baseZ      - 0
 * @param {number} topZ       - firstFloorHeight
 */
export function buildDetailedFloor0(graphNodes, N, baseZ, topZ) {
  var group = new THREE.Group();
  var GAP = 0.05;
  var EXT_T = 0.6;

  // Floor-0 cells, split the same way as buildDetailedFloor1.
  var numCells = {};
  var corrCells = {};
  for (var key in graphNodes) {
    if (!graphNodes.hasOwnProperty(key)) continue;
    var node = graphNodes[key];
    if (node.floor !== 0) continue;
    if (typeof node.cellId === 'number') numCells[node.cellId] = node;
    else corrCells[node.cellId] = node;
  }

  // ── 1. Cell boxes (grey, no top cap) ──
  // Near cells: edge0=facade, edge1=right end, edge2=corridor, edge3=left end
  for (var i = 0; i < N; i++) {
    if (!numCells[i]) continue;
    var poly = numCells[i].polygon;
    if (!poly || poly.length < 4) continue;
    var m0 = EXT_T;
    var m1 = (i === N - 1) ? EXT_T : GAP;
    var m2 = GAP;
    var m3 = (i === 0) ? EXT_T : GAP;
    var ip = insetPolyPerEdge(poly, [m0, m1, m2, m3]);
    group.add(new THREE.Mesh(buildBoxGeometry(ip, baseZ, topZ), GROUND_FLOOR_MAT));
  }
  // Far cells: edge0=corridor, edge1=right end, edge2=facade, edge3=left end
  for (var i = N; i < 2 * N; i++) {
    if (!numCells[i]) continue;
    var poly = numCells[i].polygon;
    if (!poly || poly.length < 4) continue;
    var m0 = GAP;
    var m1 = (i === N) ? EXT_T : GAP;
    var m2 = EXT_T;
    var m3 = (i === 2 * N - 1) ? EXT_T : GAP;
    var ip = insetPolyPerEdge(poly, [m0, m1, m2, m3]);
    group.add(new THREE.Mesh(buildBoxGeometry(ip, baseZ, topZ), GROUND_FLOOR_MAT));
  }
  // Corridor cells
  for (var cid in corrCells) {
    if (!corrCells.hasOwnProperty(cid)) continue;
    var poly = corrCells[cid].polygon;
    if (!poly || poly.length < 4) continue;
    var ip = insetPoly(poly, GAP);
    group.add(new THREE.Mesh(buildBoxGeometry(ip, baseZ, topZ), GROUND_FLOOR_MAT));
  }

  // ── 2. Facades & end walls ──
  function outwardNormal(poly, fp1, fp2) {
    var cx = (poly[0][0] + poly[1][0] + poly[2][0] + poly[3][0]) / 4;
    var cy = (poly[0][1] + poly[1][1] + poly[2][1] + poly[3][1]) / 4;
    var mx = (fp1[0] + fp2[0]) / 2; var my = (fp1[1] + fp2[1]) / 2;
    var odx = mx - cx; var ody = my - cy;
    var olen = Math.sqrt(odx * odx + ody * ody);
    if (olen < 0.001) return null;
    return [odx / olen, ody / olen];
  }

  // Single entrance per LLU run, on the middle cell. Multiple side-by-
  // side entrances on a 2–3-cell LLU stack would read as a department
  // store, not a residential lobby.
  var nearLLU = [];
  var farLLU = [];
  for (var i = 0; i < N; i++) {
    if (numCells[i] && numCells[i].type === 'llu') nearLLU.push(i);
  }
  for (var i = N; i < 2 * N; i++) {
    if (numCells[i] && numCells[i].type === 'llu') farLLU.push(i);
  }
  var nearEntranceIdx = nearLLU.length > 0 ? nearLLU[Math.floor(nearLLU.length / 2)] : -1;
  var farEntranceIdx = farLLU.length > 0 ? farLLU[Math.floor(farLLU.length / 2)] : -1;

  function addLongFacade(cellId, poly, p1Idx, p2Idx) {
    var n = outwardNormal(poly, poly[p1Idx], poly[p2Idx]);
    if (!n) return;
    if (numCells[cellId].type === 'llu' &&
        (cellId === nearEntranceIdx || cellId === farEntranceIdx)) {
      // Centre LLU cell → entrance (door + canopy)
      group.add(buildEntranceGroup(poly[p1Idx], poly[p2Idx], n[0], n[1], baseZ, topZ));
    } else {
      // Everything else on the long facade — including the LLU cells
      // flanking the entrance — gets a regular storefront.
      group.add(buildStorefrontFacade(poly[p1Idx], poly[p2Idx], n[0], n[1], baseZ, topZ));
    }
  }

  // Near facade (poly[0] → poly[1])
  for (var i = 0; i < N; i++) {
    if (!numCells[i]) continue;
    addLongFacade(i, numCells[i].polygon, 0, 1);
  }
  // Far facade (poly[3] → poly[2])
  for (var i = N; i < 2 * N; i++) {
    if (!numCells[i]) continue;
    addLongFacade(i, numCells[i].polygon, 3, 2);
  }

  // End walls — randomized variant per half (solid / strip / storefront)
  // so torets read as a mix of blank concrete and accent slots like in
  // contemporary residential blocks. Variant is hashed from edge
  // midpoint so it's stable across rebuilds.
  function pickEndVariant(p1, p2) {
    var s = hash01((p1[0] + p2[0]) * 0.5, (p1[1] + p2[1]) * 0.5);
    if (s < 0.55) return 'solid';
    if (s < 0.85) return 'strip';
    return 'storefront';
  }

  function addEndWall(cellId, p1Idx, p2Idx) {
    if (!numCells[cellId]) return;
    var poly = numCells[cellId].polygon;
    var n = outwardNormal(poly, poly[p1Idx], poly[p2Idx]);
    if (!n) return;
    var p1 = poly[p1Idx]; var p2 = poly[p2Idx];
    var variant = pickEndVariant(p1, p2);
    if (variant === 'solid') {
      group.add(buildSolidGroundWall(p1, p2, n[0], n[1], baseZ, topZ));
    } else if (variant === 'strip') {
      group.add(buildNarrowStripFacade(p1, p2, n[0], n[1], baseZ, topZ));
    } else {
      group.add(buildStorefrontFacade(p1, p2, n[0], n[1], baseZ, topZ));
    }
  }
  addEndWall(0, 0, 3);
  addEndWall(2 * N - 1, 0, 3);
  addEndWall(N - 1, 1, 2);
  addEndWall(N, 1, 2);

  // Tag every mesh so White-model mode keeps the cocoll grey.
  tagSkipWhitewash(group);
  return group;
}

/**
 * Tower LLU roof extrusion — mirror of buildLLURoof for sections.
 * Extrudes the LLU + llu-exit cells above the tower roof so the
 * stairwell/elevator core reads as a separate volume on top.
 *
 * @param {Array<Object>} allCells - from classifyCells (.row .col .type)
 * @param {Array<Array<[number,number]>>} cellPolysM - all grid cell polygons
 * @param {number} cols
 * @param {number} buildingH
 * @param {number} [lluHeight=2.5]
 */
export function buildTowerLLURoof(allCells, cellPolysM, cols, buildingH, lluHeight) {
  if (!lluHeight) lluHeight = 2.5;
  var group = new THREE.Group();
  var roofZ = buildingH;
  var topZ = buildingH + lluHeight;
  var lluMat = MATERIALS.llu || new THREE.MeshLambertMaterial({
    color: 0x4f81bd, side: THREE.DoubleSide
  });

  for (var i = 0; i < allCells.length; i++) {
    var c = allCells[i];
    if (c.type !== 'llu' && c.type !== 'llu-exit') continue;
    var gid = c.row * cols + c.col;
    var poly = cellPolysM[gid];
    if (!poly || poly.length < 4) continue;
    // Single box is enough — its own top face covers the roof.
    // An extra coplanar cap mesh used to z-fight on camera moves.
    group.add(new THREE.Mesh(buildBoxGeometry(poly, roofZ, topZ), lluMat));
  }
  return group;
}

/**
 * Top roof slab — single 6-face box with the top face split off into
 * a separate material slot. Gives a clean colour break (light "membrane"
 * up top, medium grey on the sides) with no z-fighting between body
 * and cap. buildBoxGeometry writes its 36 vertices in face order, so
 * vertices 0..5 are the top face and 6..35 are the remaining 5 faces.
 */
export function buildTopSlab(footprintM, buildingH, slabT) {
  if (!slabT) slabT = 0.5;
  var topZ = buildingH + slabT;
  var geo = buildBoxGeometry(footprintM, buildingH, topZ);
  geo.addGroup(0, 6, 1);    // top face → ROOF_TOP_MAT (light grey)
  geo.addGroup(6, 30, 0);   // sides + bottom → ROOF_SLAB_BODY_MAT
  return new THREE.Mesh(geo, [ROOF_SLAB_BODY_MAT, ROOF_TOP_MAT]);
}

// ── Tower detailed floor ─────────────────────────────

/**
 * Build detailed floor 1 geometry for a tower.
 * Every outer ring cell gets a window on its outward-facing edge.
 *
 * @param {Array} ringPairs - from walkRing
 * @param {Array<Array<[number,number]>>} cellPolysM - all grid cell polygons
 * @param {number} cols - grid column count
 * @param {number} baseZ - floor base Z
 * @param {number} topZ - floor top Z
 * @param {Object} gridAptColor - { gridIdx: hexColor }
 * @param {Array<Object>} allCells - from classifyCells
 * @returns {THREE.Group}
 */
export function buildDetailedTowerFloor1(ringPairs, cellPolysM, cols, rows, baseZ, topZ, gridAptColor, gridAptLabel, allCells) {
  var group = new THREE.Group();
  var SLAB = 0.3;
  var floorZ = baseZ + SLAB;
  var EXT_T = 0.6;
  var GAP = 0.03;
  var labelZ = topZ + 0.1;

  function cellCenter(poly) {
    var cx = 0, cy = 0;
    for (var v = 0; v < 4; v++) { cx += poly[v][0]; cy += poly[v][1]; }
    return [cx / 4, cy / 4];
  }

  // Find which polygon edge faces a given direction (nx, ny)
  function findEdgeByDir(poly, nx, ny) {
    var cc = cellCenter(poly);
    var bestIdx = 0; var bestDot = -Infinity;
    for (var ei = 0; ei < 4; ei++) {
      var ea = poly[ei]; var eb = poly[(ei + 1) % 4];
      var mx = (ea[0] + eb[0]) / 2 - cc[0];
      var my = (ea[1] + eb[1]) / 2 - cc[1];
      var d = mx * nx + my * ny;
      if (d > bestDot) { bestDot = d; bestIdx = ei; }
    }
    return bestIdx;
  }

  // Determine exterior edges for a boundary cell
  // Returns [{eIdx, nx, ny}] — 1 for edge cells, 2 for corner cells
  function findExteriorEdges(poly, row, col) {
    var result = [];
    var cc = cellCenter(poly);
    var dirs = [];
    // Check each boundary the cell touches
    if (row === 0) dirs.push({ nr: 1, nc: col }); // interior neighbor is row+1
    if (row === rows - 1) dirs.push({ nr: rows - 2, nc: col });
    if (col === 0) dirs.push({ nr: row, nc: 1 });
    if (col === cols - 1) dirs.push({ nr: row, nc: cols - 2 });

    for (var di = 0; di < dirs.length; di++) {
      var neighborGid = dirs[di].nr * cols + dirs[di].nc;
      var neighborPoly = cellPolysM[neighborGid];
      if (!neighborPoly) continue;
      var nc = cellCenter(neighborPoly);
      // Direction: from neighbor toward this cell = outward
      var nx = cc[0] - nc[0]; var ny = cc[1] - nc[1];
      var len = Math.sqrt(nx * nx + ny * ny);
      if (len < 1e-10) continue;
      nx /= len; ny /= len;
      var eIdx = findEdgeByDir(poly, nx, ny);
      result.push({ eIdx: eIdx, nx: nx, ny: ny });
    }
    return result;
  }

  for (var ci = 0; ci < allCells.length; ci++) {
    var cell = allCells[ci];
    var gridId = cell.row * cols + cell.col;
    var poly = cellPolysM[gridId];
    if (!poly || poly.length < 4) continue;

    // LLU cells: solid box, NO windows, NO labels
    if (cell.type === 'llu' || cell.type === 'llu-exit') {
      var ip = insetPoly(poly, GAP);
      group.add(new THREE.Mesh(buildBoxGeometry(ip, baseZ, topZ),
        MATERIALS.llu || new THREE.MeshLambertMaterial({ color: 0x4f81bd, side: THREE.DoubleSide })));
      continue;
    }

    var isBoundary = (cell.row === 0 || cell.row === rows - 1 ||
                      cell.col === 0 || cell.col === cols - 1);

    var color = gridAptColor[gridId] || '#dce8f0';
    var label = gridAptLabel ? gridAptLabel[gridId] : null;
    var matl = new THREE.MeshLambertMaterial({ color: new THREE.Color(color), side: THREE.DoubleSide });

    if (isBoundary) {
      var extEdges = findExteriorEdges(poly, cell.row, cell.col);

      // Build per-edge inset margins
      var margins = [GAP, GAP, GAP, GAP];
      for (var ei = 0; ei < extEdges.length; ei++) {
        margins[extEdges[ei].eIdx] = EXT_T;
      }
      var ip = insetPolyPerEdge(poly, margins);
      group.add(new THREE.Mesh(buildBoxGeometry(ip, baseZ, topZ), matl));
      group.add(buildTopCap(ip, topZ));

      // Window on EACH exterior edge (1 for edge cells, 2 for corners)
      for (var ei = 0; ei < extEdges.length; ei++) {
        var ext = extEdges[ei];
        var fp1 = poly[ext.eIdx];
        var fp2 = poly[(ext.eIdx + 1) % 4];
        group.add(buildFacadeWithWindow(fp1, fp2, ext.nx, ext.ny, floorZ, topZ, color));
      }

      if (label) group.add(buildDetailLabel(label, poly, labelZ, GAP));

    } else {
      // Interior apartment/inner ring cell
      var ip = insetPoly(poly, GAP);
      group.add(new THREE.Mesh(buildBoxGeometry(ip, baseZ, topZ), matl));
      group.add(buildTopCap(ip, topZ));
      if (label) group.add(buildDetailLabel(label, poly, labelZ, GAP));
    }
  }

  return group;
}

/**
 * Tower ground floor: storefronts on every exterior edge of every
 * boundary cell, an entrance group on the llu-exit cell, solid grey
 * boxes on inner cells. Mirrors buildDetailedTowerFloor1's geometry
 * pipeline but stripped of apartment colors and labels.
 *
 * @param {Array<Array<[number,number]>>} cellPolysM - all grid cell polygons
 * @param {number} cols
 * @param {number} rows
 * @param {number} baseZ
 * @param {number} topZ
 * @param {Array<Object>} allCells - from classifyCells (has .row .col .type)
 */
export function buildDetailedTowerFloor0(cellPolysM, cols, rows, baseZ, topZ, allCells) {
  var group = new THREE.Group();
  var GAP = 0.03;
  var EXT_T = 0.6;

  function cellCenter(poly) {
    var cx = 0, cy = 0;
    for (var v = 0; v < 4; v++) { cx += poly[v][0]; cy += poly[v][1]; }
    return [cx / 4, cy / 4];
  }

  function findEdgeByDir(poly, nx, ny) {
    var cc = cellCenter(poly);
    var bestIdx = 0; var bestDot = -Infinity;
    for (var ei = 0; ei < 4; ei++) {
      var ea = poly[ei]; var eb = poly[(ei + 1) % 4];
      var mx = (ea[0] + eb[0]) / 2 - cc[0];
      var my = (ea[1] + eb[1]) / 2 - cc[1];
      var d = mx * nx + my * ny;
      if (d > bestDot) { bestDot = d; bestIdx = ei; }
    }
    return bestIdx;
  }

  function findExteriorEdges(poly, row, col) {
    var result = [];
    var cc = cellCenter(poly);
    var dirs = [];
    if (row === 0 && rows > 1) dirs.push({ nr: 1, nc: col });
    if (row === rows - 1 && rows > 1) dirs.push({ nr: rows - 2, nc: col });
    if (col === 0 && cols > 1) dirs.push({ nr: row, nc: 1 });
    if (col === cols - 1 && cols > 1) dirs.push({ nr: row, nc: cols - 2 });

    for (var di = 0; di < dirs.length; di++) {
      var neighborGid = dirs[di].nr * cols + dirs[di].nc;
      var neighborPoly = cellPolysM[neighborGid];
      if (!neighborPoly) continue;
      var nc = cellCenter(neighborPoly);
      var nx = cc[0] - nc[0]; var ny = cc[1] - nc[1];
      var len = Math.sqrt(nx * nx + ny * ny);
      if (len < 1e-10) continue;
      nx /= len; ny /= len;
      var eIdx = findEdgeByDir(poly, nx, ny);
      result.push({ eIdx: eIdx, nx: nx, ny: ny });
    }
    return result;
  }

  for (var ci = 0; ci < allCells.length; ci++) {
    var cell = allCells[ci];
    var gridId = cell.row * cols + cell.col;
    var poly = cellPolysM[gridId];
    if (!poly || poly.length < 4) continue;

    var isBoundary = (cell.row === 0 || cell.row === rows - 1 ||
                      cell.col === 0 || cell.col === cols - 1);
    var isExit = cell.type === 'llu-exit';

    if (isBoundary) {
      var extEdges = findExteriorEdges(poly, cell.row, cell.col);
      var margins = [GAP, GAP, GAP, GAP];
      for (var ei = 0; ei < extEdges.length; ei++) {
        margins[extEdges[ei].eIdx] = EXT_T;
      }
      var ip = insetPolyPerEdge(poly, margins);
      group.add(new THREE.Mesh(buildBoxGeometry(ip, baseZ, topZ), GROUND_FLOOR_MAT));

      // Storefronts on each exterior edge — entrance instead on the
      // llu-exit cell so the lobby reads correctly from outside.
      for (var ei = 0; ei < extEdges.length; ei++) {
        var ext = extEdges[ei];
        var fp1 = poly[ext.eIdx];
        var fp2 = poly[(ext.eIdx + 1) % 4];
        if (isExit) {
          group.add(buildEntranceGroup(fp1, fp2, ext.nx, ext.ny, baseZ, topZ));
        } else {
          group.add(buildStorefrontFacade(fp1, fp2, ext.nx, ext.ny, baseZ, topZ));
        }
      }
    } else {
      // Inner cell — solid grey box (LLU stack core, inner apartments).
      var ipi = insetPoly(poly, GAP);
      group.add(new THREE.Mesh(buildBoxGeometry(ipi, baseZ, topZ), GROUND_FLOOR_MAT));
    }
  }

  tagSkipWhitewash(group);
  return group;
}
