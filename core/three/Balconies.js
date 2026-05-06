/**
 * Balconies — apartment balconies on residential floors.
 *
 * Geometry per balcony:
 *   · slab        — concrete plate, cantilevers ~1.4m outward.
 *   · front rail  — glass parapet on the outer edge.
 *   · side rails  — glass parapets on left/right (perpendicular to facade).
 *
 * Patterns determine which (floor, cell, side) gets a balcony. Side
 * walls (end walls / torcы) NEVER get balconies — only near and far
 * facade cells of `apartment` type.
 *
 * Glass parapets are transparent, so the meshes don't occlude views
 * from below. The slab is opaque and casts shadows; insolation
 * collision boxes are slab-only (rays don't see glass).
 */

import * as THREE from 'three';
import { buildBoxGeometry } from './BoxGeometry.js';

var SLAB_THICKNESS = 0.15;
var DEFAULT_DEPTH = 1.4;
var DEFAULT_PARAPET_H = 1.1;
var GLASS_T = 0.04;
var SIDE_INSET = 0.2; // shrink slab from cell edges so balconies don't merge

var _slabMat = null;
var _glassMat = null;
function slabMat() {
  if (!_slabMat) {
    _slabMat = new THREE.MeshLambertMaterial({
      color: 0xc8c8c8, side: THREE.DoubleSide
    });
  }
  return _slabMat;
}
function glassMat() {
  if (!_glassMat) {
    _glassMat = new THREE.MeshLambertMaterial({
      color: 0x8aa3b8,
      transparent: true,
      opacity: 0.35,
      side: THREE.DoubleSide,
      depthWrite: false
    });
  }
  return _glassMat;
}

/**
 * Pattern catalogue. Each function: (floorIdx, cellIdx, side) → boolean.
 * floorIdx: 1..N-1 (floor 0 is commercial, no balconies).
 * cellIdx: 0..cellsPerFacade-1 along the facade edge.
 * side: 'near' | 'far' — useful when patterns differ per facade.
 */
export var BALCONY_PATTERNS = {
  // Checkerboard — every other apartment, alternating per floor.
  // Most common pattern in modern Russian apartment blocks.
  staggered: function (floor, cell) { return ((floor + cell) % 2) === 0; },
  // Every apartment on every floor.
  every: function () { return true; },
  // Vertical stacks — every other column has balconies on all floors.
  columns: function (_floor, cell) { return (cell % 2) === 0; },
  // Horizontal bands — every other floor, all apartments.
  bands: function (floor) { return (floor % 2) === 0; },
  // Off — programmatically convenient when feature is disabled.
  none: function () { return false; }
};

export function getPatternFn(name) {
  return BALCONY_PATTERNS[name] || BALCONY_PATTERNS.staggered;
}

/**
 * Compute the four world-space slab corners for a balcony anchored
 * to the (fp1, fp2) facade edge of an apartment cell.
 *
 * @param {[number,number]} fp1     facade edge start (CCW order)
 * @param {[number,number]} fp2     facade edge end
 * @param {[number,number]} outDir  unit outward normal of the facade
 * @param {number} depth            cantilever depth (m)
 * @returns {Array<[number,number]>|null}  4-vertex CCW polygon, or
 *   null if the cell is too narrow.
 */
function slabPolygon(fp1, fp2, outDir, depth) {
  var dx = fp2[0] - fp1[0], dy = fp2[1] - fp1[1];
  var dlen = Math.sqrt(dx * dx + dy * dy);
  if (dlen < 0.5) return null;
  var ax = dx / dlen, ay = dy / dlen;
  var fullW = dlen - SIDE_INSET * 2;
  if (fullW <= 0.3) return null;
  var cx = (fp1[0] + fp2[0]) / 2, cy = (fp1[1] + fp2[1]) / 2;
  var p1 = [cx - ax * fullW / 2, cy - ay * fullW / 2];
  var p2 = [cx + ax * fullW / 2, cy + ay * fullW / 2];
  var p3 = [p2[0] + outDir[0] * depth, p2[1] + outDir[1] * depth];
  var p4 = [p1[0] + outDir[0] * depth, p1[1] + outDir[1] * depth];
  return [p1, p2, p3, p4];
}

/**
 * Add one balcony to `group`. Caller has already filtered for
 * apartment cells and matched the pattern.
 */
function addOneBalcony(group, fp1, fp2, outDir, baseZ, opts) {
  var depth = opts.depth || DEFAULT_DEPTH;
  var parapetH = opts.parapetH || DEFAULT_PARAPET_H;
  var slabT = opts.slabT || SLAB_THICKNESS;
  var poly = slabPolygon(fp1, fp2, outDir, depth);
  if (!poly) return null;

  var p1 = poly[0], p2 = poly[1], p3 = poly[2], p4 = poly[3];
  var slabTopZ = baseZ + slabT;
  var parapetTopZ = slabTopZ + parapetH;

  // Slab.
  var slab = new THREE.Mesh(buildBoxGeometry(poly, baseZ, slabTopZ), slabMat());
  slab.castShadow = true;
  slab.receiveShadow = true;
  group.add(slab);

  // Glass parapets — three sides (front + left + right). Inner edge
  // of each parapet is offset inward by GLASS_T so they have visible
  // thickness rather than being infinitely-thin planes.
  var ax = (p2[0] - p1[0]); var ay = (p2[1] - p1[1]);
  var alen = Math.sqrt(ax * ax + ay * ay);
  if (alen > 1e-6) { ax /= alen; ay /= alen; }

  // Front parapet (along p3-p4).
  var fIn3 = [p3[0] - outDir[0] * GLASS_T, p3[1] - outDir[1] * GLASS_T];
  var fIn4 = [p4[0] - outDir[0] * GLASS_T, p4[1] - outDir[1] * GLASS_T];
  group.add(new THREE.Mesh(
    buildBoxGeometry([fIn4, fIn3, p3, p4], slabTopZ, parapetTopZ),
    glassMat()
  ));

  // Left parapet (along p1-p4).
  var lIn1 = [p1[0] + ax * GLASS_T, p1[1] + ay * GLASS_T];
  var lIn4 = [p4[0] + ax * GLASS_T, p4[1] + ay * GLASS_T];
  group.add(new THREE.Mesh(
    buildBoxGeometry([p1, lIn1, lIn4, p4], slabTopZ, parapetTopZ),
    glassMat()
  ));

  // Right parapet (along p2-p3).
  var rIn2 = [p2[0] - ax * GLASS_T, p2[1] - ay * GLASS_T];
  var rIn3 = [p3[0] - ax * GLASS_T, p3[1] - ay * GLASS_T];
  group.add(new THREE.Mesh(
    buildBoxGeometry([rIn2, p2, p3, rIn3], slabTopZ, parapetTopZ),
    glassMat()
  ));

  return poly;
}

/**
 * Compute outward normal for an apartment cell's facade edge.
 * `cellPoly` is the 4-vertex cell polygon; `fp1, fp2` is the facade
 * edge — outward = direction from cell centroid toward facade midpoint.
 */
function outwardNormalFromCell(cellPoly, fp1, fp2) {
  var cx = 0, cy = 0;
  for (var i = 0; i < cellPoly.length; i++) { cx += cellPoly[i][0]; cy += cellPoly[i][1]; }
  cx /= cellPoly.length; cy /= cellPoly.length;
  var mx = (fp1[0] + fp2[0]) / 2, my = (fp1[1] + fp2[1]) / 2;
  var dx = mx - cx, dy = my - cy;
  var L = Math.sqrt(dx * dx + dy * dy);
  if (L < 1e-6) return null;
  return [dx / L, dy / L];
}

/**
 * Build all balconies for one section, on every residential floor
 * (1..floorCount-1). Floor 0 is commercial — skipped.
 *
 * Returns { group, slabPolys } where slabPolys is the list of slab
 * footprints + their z range, ready to feed insolation as collision
 * boxes.
 */
export function buildBalconiesForSection(opts) {
  var graphNodes = opts.graphNodes;
  var N = opts.N;
  var floorCount = opts.floorCount;
  var firstFloorH = opts.firstFloorHeight;
  var typicalFloorH = opts.typicalFloorHeight;
  var pattern = getPatternFn(opts.pattern);

  var group = new THREE.Group();
  var slabBoxes = [];
  if (floorCount < 2) return { group: group, slabBoxes: slabBoxes };

  // Collect floor-1 numbered cells (apartment / non-standard / llu).
  var numCells = {};
  for (var key in graphNodes) {
    if (!graphNodes.hasOwnProperty(key)) continue;
    var node = graphNodes[key];
    if (node.floor !== 1) continue;
    if (typeof node.cellId === 'number') numCells[node.cellId] = node;
  }

  function eligible(node) {
    return node && node.type === 'apartment';
  }

  for (var fl = 1; fl < floorCount; fl++) {
    var baseZ = firstFloorH + (fl - 1) * typicalFloorH + SLAB_THICKNESS;
    // baseZ sits ON the apartment floor slab top so the balcony slab
    // is flush with the apartment floor. (Floor slab is 0.3m at the
    // apartment floor base; balcony slab is on top of that.)

    // Near facade: cells 0..N-1, facade edge = poly[0]-poly[1].
    for (var i = 0; i < N; i++) {
      var node = numCells[i];
      if (!eligible(node)) continue;
      // Cells at the absolute end of the section (i = 0 or i = N-1)
      // sit on END walls — NEVER place a balcony there per the spec.
      if (i === 0 || i === N - 1) continue;
      if (!pattern(fl, i, 'near')) continue;
      var poly = node.polygon;
      if (!poly || poly.length < 4) continue;
      var ow = outwardNormalFromCell(poly, poly[0], poly[1]);
      if (!ow) continue;
      var sp = addOneBalcony(group, poly[0], poly[1], ow, baseZ, opts);
      if (sp) slabBoxes.push({ poly: sp, baseZ: baseZ, topZ: baseZ + SLAB_THICKNESS });
    }
    // Far facade: cells N..2N-1, facade edge = poly[2]-poly[3].
    for (var j = N; j < 2 * N; j++) {
      var nodeF = numCells[j];
      if (!eligible(nodeF)) continue;
      var localCell = j - N;
      if (localCell === 0 || localCell === N - 1) continue;
      if (!pattern(fl, localCell, 'far')) continue;
      var polyF = nodeF.polygon;
      if (!polyF || polyF.length < 4) continue;
      var owF = outwardNormalFromCell(polyF, polyF[2], polyF[3]);
      if (!owF) continue;
      var spF = addOneBalcony(group, polyF[2], polyF[3], owF, baseZ, opts);
      if (spF) slabBoxes.push({ poly: spF, baseZ: baseZ, topZ: baseZ + SLAB_THICKNESS });
    }
  }

  return { group: group, slabBoxes: slabBoxes };
}
