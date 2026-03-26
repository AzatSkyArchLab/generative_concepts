/**
 * SectionMeshes — section-level mesh builders.
 * Wireframe, divider walls, cell meshes, upper floor replication.
 */

import * as THREE from 'three';
import { MATERIALS, DIVIDER_MATERIAL, WIREFRAME_MATERIAL } from './materials.js';
import { buildBoxGeometry, buildBoxEdges, insetPoly } from './BoxGeometry.js';
import { buildCellLabelSprite } from './Labels.js';

/**
 * Clean wireframe box: 12 edges only. No floor lines.
 */
export function buildSectionWireframe(footprintM, baseZ, topZ) {
  var a = footprintM[0]; var b = footprintM[1];
  var c = footprintM[2]; var d = footprintM[3];
  var p = [];

  p.push(a[0],a[1],baseZ, b[0],b[1],baseZ);
  p.push(b[0],b[1],baseZ, c[0],c[1],baseZ);
  p.push(c[0],c[1],baseZ, d[0],d[1],baseZ);
  p.push(d[0],d[1],baseZ, a[0],a[1],baseZ);

  p.push(a[0],a[1],topZ, b[0],b[1],topZ);
  p.push(b[0],b[1],topZ, c[0],c[1],topZ);
  p.push(c[0],c[1],topZ, d[0],d[1],topZ);
  p.push(d[0],d[1],topZ, a[0],a[1],topZ);

  p.push(a[0],a[1],baseZ, a[0],a[1],topZ);
  p.push(b[0],b[1],baseZ, b[0],b[1],topZ);
  p.push(c[0],c[1],baseZ, c[0],c[1],topZ);
  p.push(d[0],d[1],baseZ, d[0],d[1],topZ);

  var geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(p, 3));
  return new THREE.LineSegments(geo, WIREFRAME_MATERIAL);
}

export function buildDividerWall(p1, p2, baseZ, topZ, thickness) {
  var dx = p2[0]-p1[0]; var dy = p2[1]-p1[1];
  var len = Math.sqrt(dx*dx+dy*dy);
  if (len < 0.01) return new THREE.Group();
  var px = -dy/len*thickness*0.5;
  var py = dx/len*thickness*0.5;
  var corners = [[p1[0]-px,p1[1]-py],[p2[0]-px,p2[1]-py],[p2[0]+px,p2[1]+py],[p1[0]+px,p1[1]+py]];
  var geo = buildBoxGeometry(corners, baseZ, topZ);
  return new THREE.Mesh(geo, DIVIDER_MATERIAL);
}

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
  group.add(mesh); group.add(edges);
  group.userData = { cellType: cellType, floor: floor, base: base, height: height };
  return group;
}

/**
 * Build a cell mesh with a custom hex color string.
 */
export function buildCellMeshColored(polygon, base, height, colorHex, inset) {
  if (inset === undefined) inset = 0.08;
  var poly = inset > 0 ? insetPoly(polygon, inset) : polygon;
  var geometry = buildBoxGeometry(poly, base, height);
  var material = new THREE.MeshLambertMaterial({ color: new THREE.Color(colorHex), side: THREE.DoubleSide });
  var mesh = new THREE.Mesh(geometry, material);
  var edges = buildBoxEdges(poly, base, height);
  var group = new THREE.Group();
  group.add(mesh); group.add(edges);
  return group;
}

export function buildSectionMeshes(graphNodes, maxFloor, firstFloorH, typicalFloorH, inset, aptColorMap) {
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

    var aptInfo = aptColorMap ? aptColorMap[node.cellId] : null;
    if (aptInfo && node.floor === 1) {
      sectionGroup.add(buildCellMeshColored(poly, base, height, aptInfo.color, inset));
      if (aptInfo.label) {
        sectionGroup.add(buildCellLabelSprite(aptInfo.label, poly, height, inset));
      }
    } else {
      sectionGroup.add(buildCellMesh(poly, base, height, node.type, node.floor, inset));
    }
  }
  return sectionGroup;
}

/**
 * Render floors 2..floorCount-1 with apartment colors from floor 1.
 * Simple colored boxes — no walls/windows (those are floor 1 only).
 */
export function buildUpperFloors(graphNodes, floorCount, firstFloorH, typicalFloorH, aptColorMap, inset) {
  if (inset === undefined) inset = 0.08;
  var group = new THREE.Group();
  if (floorCount <= 2 || !aptColorMap) return group;

  var floor1Cells = [];
  for (var key in graphNodes) {
    if (!graphNodes.hasOwnProperty(key)) continue;
    var node = graphNodes[key];
    if (node.floor !== 1) continue;
    if (!node.polygon || node.polygon.length < 3) continue;
    floor1Cells.push(node);
  }

  for (var fl = 2; fl < floorCount; fl++) {
    var baseZ = firstFloorH + (fl - 1) * typicalFloorH;
    var topZ = baseZ + typicalFloorH;

    for (var ci = 0; ci < floor1Cells.length; ci++) {
      var node = floor1Cells[ci];
      var poly = node.polygon;
      var ip = insetPoly(poly, inset);
      var info = aptColorMap[node.cellId];
      var mat;
      if (info && info.color) {
        mat = new THREE.MeshLambertMaterial({ color: new THREE.Color(info.color), side: THREE.DoubleSide });
      } else if (node.type === 'llu') {
        mat = MATERIALS.llu;
      } else if (node.type === 'corridor' || (typeof node.cellId === 'string')) {
        mat = MATERIALS.corridor;
      } else {
        mat = MATERIALS.apartment;
      }
      group.add(new THREE.Mesh(buildBoxGeometry(ip, baseZ, topZ), mat));
      group.add(buildBoxEdges(ip, baseZ, topZ));
    }
  }
  return group;
}
