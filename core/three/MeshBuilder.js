/**
 * MeshBuilder — cell bricks + section frame lines
 *
 * buildCellMesh: colored box + dark edge lines per cell
 * buildSectionFrame: dark mesh walls on section ends (торцы dividers)
 */

import * as THREE from 'three';

var MATERIALS = {
  commercial: new THREE.MeshLambertMaterial({ color: 0xffb74d, side: THREE.DoubleSide }),
  apartment:  new THREE.MeshLambertMaterial({ color: 0xdce8f0, side: THREE.DoubleSide }),
  corridor:   new THREE.MeshLambertMaterial({ color: 0xc8c8c8, side: THREE.DoubleSide }),
  llu:        new THREE.MeshLambertMaterial({ color: 0x4f81bd, side: THREE.DoubleSide }),

  commercial_f0: new THREE.MeshLambertMaterial({ color: 0xffb74d, side: THREE.DoubleSide }),
  apartment_f0:  new THREE.MeshLambertMaterial({ color: 0xffb74d, side: THREE.DoubleSide }),
  corridor_f0:   new THREE.MeshLambertMaterial({ color: 0xe0a040, side: THREE.DoubleSide }),
  llu_f0:        new THREE.MeshLambertMaterial({ color: 0x4f81bd, side: THREE.DoubleSide })
};

var EDGE_MATERIAL = new THREE.LineBasicMaterial({ color: 0x666666 });
var FRAME_LINE_MATERIAL = new THREE.LineBasicMaterial({ color: 0x222222 });
var FRAME_MATERIAL = new THREE.MeshBasicMaterial({ color: 0x333333, side: THREE.DoubleSide });

// ── Box geometry ───────────────────────────────────────

function buildBoxGeometry(corners, baseZ, topZ) {
  var a = corners[0]; var b = corners[1]; var c = corners[2]; var d = corners[3];
  var verts = [
    a[0], a[1], baseZ, b[0], b[1], baseZ, c[0], c[1], baseZ, d[0], d[1], baseZ,
    a[0], a[1], topZ,  b[0], b[1], topZ,  c[0], c[1], topZ,  d[0], d[1], topZ
  ];

  var indices = [
    4,5,6, 4,6,7,
    0,3,2, 0,2,1,
    0,1,5, 0,5,4,
    1,2,6, 1,6,5,
    2,3,7, 2,7,6,
    3,0,4, 3,4,7
  ];

  var positions = [];
  var normals = [];
  for (var f = 0; f < 12; f++) {
    var i0 = indices[f*3]; var i1 = indices[f*3+1]; var i2 = indices[f*3+2];
    var v0x=verts[i0*3]; var v0y=verts[i0*3+1]; var v0z=verts[i0*3+2];
    var v1x=verts[i1*3]; var v1y=verts[i1*3+1]; var v1z=verts[i1*3+2];
    var v2x=verts[i2*3]; var v2y=verts[i2*3+1]; var v2z=verts[i2*3+2];
    var e1x=v1x-v0x; var e1y=v1y-v0y; var e1z=v1z-v0z;
    var e2x=v2x-v0x; var e2y=v2y-v0y; var e2z=v2z-v0z;
    var nx=e1y*e2z-e1z*e2y; var ny=e1z*e2x-e1x*e2z; var nz=e1x*e2y-e1y*e2x;
    var nl=Math.sqrt(nx*nx+ny*ny+nz*nz);
    if(nl>1e-10){nx/=nl;ny/=nl;nz/=nl;}
    positions.push(v0x,v0y,v0z,v1x,v1y,v1z,v2x,v2y,v2z);
    normals.push(nx,ny,nz,nx,ny,nz,nx,ny,nz);
  }
  var geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geo.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
  return geo;
}

function buildBoxEdges(corners, baseZ, topZ) {
  var a=corners[0]; var b=corners[1]; var c=corners[2]; var d=corners[3];
  var p = [];
  p.push(a[0],a[1],baseZ, b[0],b[1],baseZ); p.push(b[0],b[1],baseZ, c[0],c[1],baseZ);
  p.push(c[0],c[1],baseZ, d[0],d[1],baseZ); p.push(d[0],d[1],baseZ, a[0],a[1],baseZ);
  p.push(a[0],a[1],topZ, b[0],b[1],topZ); p.push(b[0],b[1],topZ, c[0],c[1],topZ);
  p.push(c[0],c[1],topZ, d[0],d[1],topZ); p.push(d[0],d[1],topZ, a[0],a[1],topZ);
  p.push(a[0],a[1],baseZ, a[0],a[1],topZ); p.push(b[0],b[1],baseZ, b[0],b[1],topZ);
  p.push(c[0],c[1],baseZ, c[0],c[1],topZ); p.push(d[0],d[1],baseZ, d[0],d[1],topZ);
  var geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(p, 3));
  return new THREE.LineSegments(geo, EDGE_MATERIAL);
}

// ── Section frame (mesh walls on торцы only) ───────────

/**
 * Build dark thin walls on section short ends (торцы).
 * Footprint: [startM, endM, endM+offset, startM+offset]
 *   Edge 0 (a→b): along axis — SKIP (long side, cells visible)
 *   Edge 1 (b→c): perpendicular — WALL (торец)
 *   Edge 2 (c→d): along axis — SKIP
 *   Edge 3 (d→a): perpendicular — WALL (торец)
 *
 * @param {Array<[number,number]>} footprint - 4 corners
 * @param {number} baseZ
 * @param {number} topZ
 * @param {number} [thickness=0.15]
 * @returns {THREE.Group}
 */
export function buildSectionFrame(footprint, baseZ, topZ, thickness) {
  if (!thickness) thickness = 0.15;
  var group = new THREE.Group();

  // Only edges 1 and 3 (торцы)
  var endEdges = [
    [footprint[1], footprint[2]],  // b→c
    [footprint[3], footprint[0]]   // d→a
  ];

  for (var ei = 0; ei < endEdges.length; ei++) {
    var p1 = endEdges[ei][0];
    var p2 = endEdges[ei][1];

    var dx = p2[0] - p1[0];
    var dy = p2[1] - p1[1];
    var len = Math.sqrt(dx * dx + dy * dy);
    if (len < 0.01) continue;

    // Perpendicular offset (half thickness each side)
    var px = -dy / len * thickness * 0.5;
    var py = dx / len * thickness * 0.5;

    var wallCorners = [
      [p1[0] - px, p1[1] - py],
      [p2[0] - px, p2[1] - py],
      [p2[0] + px, p2[1] + py],
      [p1[0] + px, p1[1] + py]
    ];

    var geo = buildBoxGeometry(wallCorners, baseZ, topZ);
    var mesh = new THREE.Mesh(geo, FRAME_MATERIAL);
    group.add(mesh);
  }

  return group;
}

// ── Cell mesh ──────────────────────────────────────────

export function buildCellMesh(polygon, base, height, cellType, floor, inset) {
  if (inset === undefined) inset = 0.08;
  var poly = inset > 0 ? insetPoly(polygon, inset) : polygon;

  var geometry = buildBoxGeometry(poly, base, height);
  var matKey = cellType;
  if (floor === 0) matKey = cellType + '_f0';
  var material = MATERIALS[matKey] || MATERIALS[cellType] || MATERIALS.apartment;

  var mesh = new THREE.Mesh(geometry, material);
  var edges = buildBoxEdges(poly, base, height);

  var group = new THREE.Group();
  group.add(mesh);
  group.add(edges);
  group.userData = { cellType: cellType, floor: floor, base: base, height: height };
  return group;
}

export function buildSectionMeshes(graphNodes, maxFloor, firstFloorH, typicalFloorH, inset) {
  if (inset === undefined) inset = 0.08;
  var sectionGroup = new THREE.Group();

  for (var key in graphNodes) {
    if (!graphNodes.hasOwnProperty(key)) continue;
    var node = graphNodes[key];
    if (node.floor > maxFloor) continue;

    var poly = node.polygon;
    if (!poly || poly.length < 3) continue;

    var base, height;
    if (node.floor === 0) { base = 0; height = firstFloorH; }
    else { base = firstFloorH + (node.floor - 1) * typicalFloorH; height = base + typicalFloorH; }

    sectionGroup.add(buildCellMesh(poly, base, height, node.type, node.floor, inset));
  }
  return sectionGroup;
}

function insetPoly(poly, margin) {
  if (poly.length < 3 || margin <= 0) return poly;
  var n = poly.length;

  // Compute inward normals for each edge
  var inNormals = [];
  for (var i = 0; i < n; i++) {
    var a = poly[i];
    var b = poly[(i + 1) % n];
    var dx = b[0] - a[0];
    var dy = b[1] - a[1];
    var len = Math.sqrt(dx * dx + dy * dy);
    if (len < 1e-10) { inNormals.push([0, 0]); continue; }
    // Inward normal (right-hand perpendicular for CCW polygon)
    inNormals.push([dy / len, -dx / len]);
  }

  // Offset each edge inward, intersect adjacent to get new corners
  var result = [];
  for (var i = 0; i < n; i++) {
    var prev = (i - 1 + n) % n;

    // Edge prev: poly[prev] → poly[i], offset by inNormals[prev]
    var p0 = poly[prev]; var p1 = poly[i];
    var n0 = inNormals[prev];
    var a1x = p0[0] + n0[0] * margin; var a1y = p0[1] + n0[1] * margin;
    var a2x = p1[0] + n0[0] * margin; var a2y = p1[1] + n0[1] * margin;

    // Edge i: poly[i] → poly[(i+1)%n], offset by inNormals[i]
    var p2 = poly[i]; var p3 = poly[(i + 1) % n];
    var n1 = inNormals[i];
    var b1x = p2[0] + n1[0] * margin; var b1y = p2[1] + n1[1] * margin;
    var b2x = p3[0] + n1[0] * margin; var b2y = p3[1] + n1[1] * margin;

    // Intersect two lines: (a1→a2) ∩ (b1→b2)
    var dax = a2x - a1x; var day = a2y - a1y;
    var dbx = b2x - b1x; var dby = b2y - b1y;
    var denom = dax * dby - day * dbx;
    if (Math.abs(denom) < 1e-10) {
      // Parallel edges — just use offset point
      result.push([a2x, a2y]);
    } else {
      var t = ((b1x - a1x) * dby - (b1y - a1y) * dbx) / denom;
      result.push([a1x + dax * t, a1y + day * t]);
    }
  }
  return result;
}
