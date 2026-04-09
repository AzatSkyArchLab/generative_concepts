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
  darkenColor
} from './materials.js';
import { buildBoxGeometry, buildBoxEdges, insetPoly, insetPolyPerEdge } from './BoxGeometry.js';
import { buildDetailLabel } from './Labels.js';

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

function buildSolidExtWall(fp1, fp2, nx, ny, floorZ, topZ, wallColor) {
  var EXT_T = 0.6;
  var i1 = [fp1[0] - nx * EXT_T, fp1[1] - ny * EXT_T];
  var i2 = [fp2[0] - nx * EXT_T, fp2[1] - ny * EXT_T];
  var mat = wallColor
    ? new THREE.MeshLambertMaterial({ color: darkenColor(wallColor, 0.8), side: THREE.DoubleSide })
    : EXT_WALL_MAT;
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
    if (numCells[cid] && numCells[cid].type === 'llu') return '#4f81bd';
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
    group.add(new THREE.Mesh(buildBoxGeometry(poly, roofZ, topZ), lluMat));
    // Top cap same color as LLU
    var tv = new Float32Array([
      poly[0][0],poly[0][1],topZ, poly[1][0],poly[1][1],topZ,
      poly[2][0],poly[2][1],topZ, poly[3][0],poly[3][1],topZ
    ]);
    var tg = new THREE.BufferGeometry();
    tg.setAttribute('position', new THREE.Float32BufferAttribute(tv, 3));
    tg.setIndex(new THREE.BufferAttribute(new Uint16Array([0,1,2, 0,2,3]), 1));
    tg.computeVertexNormals();
    group.add(new THREE.Mesh(tg, lluMat));
  }

  return group;
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
