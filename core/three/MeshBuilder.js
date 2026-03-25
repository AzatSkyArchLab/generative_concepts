/**
 * MeshBuilder — cell bricks + divider walls + section wireframe
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

var DIVIDER_MATERIAL = new THREE.MeshBasicMaterial({ color: 0x333333, side: THREE.DoubleSide });
var EDGE_MATERIAL = new THREE.LineBasicMaterial({ color: 0x666666 });
var WIREFRAME_MATERIAL = new THREE.LineBasicMaterial({ color: 0x555555 });

function buildBoxGeometry(corners, baseZ, topZ) {
  var a = corners[0]; var b = corners[1]; var c = corners[2]; var d = corners[3];
  var verts = [
    a[0],a[1],baseZ, b[0],b[1],baseZ, c[0],c[1],baseZ, d[0],d[1],baseZ,
    a[0],a[1],topZ,  b[0],b[1],topZ,  c[0],c[1],topZ,  d[0],d[1],topZ
  ];
  var indices = [4,5,6,4,6,7, 0,3,2,0,2,1, 0,1,5,0,5,4, 1,2,6,1,6,5, 2,3,7,2,7,6, 3,0,4,3,4,7];
  var positions = []; var normals = [];
  for (var f = 0; f < 12; f++) {
    var i0=indices[f*3]; var i1=indices[f*3+1]; var i2=indices[f*3+2];
    var v0x=verts[i0*3];var v0y=verts[i0*3+1];var v0z=verts[i0*3+2];
    var v1x=verts[i1*3];var v1y=verts[i1*3+1];var v1z=verts[i1*3+2];
    var v2x=verts[i2*3];var v2y=verts[i2*3+1];var v2z=verts[i2*3+2];
    var e1x=v1x-v0x;var e1y=v1y-v0y;var e1z=v1z-v0z;
    var e2x=v2x-v0x;var e2y=v2y-v0y;var e2z=v2z-v0z;
    var nx=e1y*e2z-e1z*e2y;var ny=e1z*e2x-e1x*e2z;var nz=e1x*e2y-e1y*e2x;
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
  var a=corners[0];var b=corners[1];var c=corners[2];var d=corners[3];
  var p = [];
  p.push(a[0],a[1],baseZ,b[0],b[1],baseZ); p.push(b[0],b[1],baseZ,c[0],c[1],baseZ);
  p.push(c[0],c[1],baseZ,d[0],d[1],baseZ); p.push(d[0],d[1],baseZ,a[0],a[1],baseZ);
  p.push(a[0],a[1],topZ,b[0],b[1],topZ); p.push(b[0],b[1],topZ,c[0],c[1],topZ);
  p.push(c[0],c[1],topZ,d[0],d[1],topZ); p.push(d[0],d[1],topZ,a[0],a[1],topZ);
  p.push(a[0],a[1],baseZ,a[0],a[1],topZ); p.push(b[0],b[1],baseZ,b[0],b[1],topZ);
  p.push(c[0],c[1],baseZ,c[0],c[1],topZ); p.push(d[0],d[1],baseZ,d[0],d[1],topZ);
  var geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(p, 3));
  return new THREE.LineSegments(geo, EDGE_MATERIAL);
}

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

    // Check apartment color override for this cell
    var aptInfo = aptColorMap ? aptColorMap[node.cellId] : null;
    if (aptInfo && node.floor === 1) {
      sectionGroup.add(buildCellMeshColored(poly, base, height, aptInfo.color, inset));
      // Label sprite on top face
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
 * Build a cell mesh with a custom hex color string.
 */
function buildCellMeshColored(polygon, base, height, colorHex, inset) {
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

/**
 * Render floors 2..floorCount-1 with apartment colors from floor 1.
 * Simple colored boxes — no walls/windows (those are floor 1 only).
 */
export function buildUpperFloors(graphNodes, floorCount, firstFloorH, typicalFloorH, aptColorMap, inset) {
  if (inset === undefined) inset = 0.08;
  var group = new THREE.Group();
  if (floorCount <= 2 || !aptColorMap) return group;

  // Collect floor 1 cells (polygons to replicate)
  var floor1Cells = [];
  for (var key in graphNodes) {
    if (!graphNodes.hasOwnProperty(key)) continue;
    var node = graphNodes[key];
    if (node.floor !== 1) continue;
    if (!node.polygon || node.polygon.length < 3) continue;
    floor1Cells.push(node);
  }

  // Render each upper floor
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

/**
 * Text label on the top face of a cell, oriented along section axis.
 * Smaller, regular weight, slightly raised, darker.
 */
function buildCellLabelSprite(text, polygon, topZ, inset) {
  if (inset === undefined) inset = 0.08;
  var poly = inset > 0 ? insetPoly(polygon, inset) : polygon;

  var canvas = document.createElement('canvas');
  var size = 128;
  canvas.width = size;
  canvas.height = size;
  var ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, size, size);

  ctx.font = '400 32px system-ui, -apple-system, sans-serif';
  ctx.fillStyle = '#333333';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, size / 2, size / 2);

  var texture = new THREE.CanvasTexture(canvas);
  texture.minFilter = THREE.LinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.needsUpdate = true;

  var mat = new THREE.MeshBasicMaterial({
    map: texture, transparent: true, depthTest: false,
    side: THREE.DoubleSide, toneMapped: false
  });

  // Plane geometry lying in XY plane
  var planeGeo = new THREE.PlaneGeometry(2.8, 2.8);
  var mesh = new THREE.Mesh(planeGeo, mat);

  // Position at cell centroid, raised slightly above top face
  var cx = (poly[0][0] + poly[1][0] + poly[2][0] + poly[3][0]) / 4;
  var cy = (poly[0][1] + poly[1][1] + poly[2][1] + poly[3][1]) / 4;
  mesh.position.set(cx, cy, topZ + 0.25);

  // Orient along section axis: edge poly[0]→poly[1]
  var dx = poly[1][0] - poly[0][0];
  var dy = poly[1][1] - poly[0][1];
  var angle = Math.atan2(dy, dx);
  // PlaneGeometry faces +Z by default; rotate around Z to align with axis
  mesh.rotation.z = angle;

  return mesh;
}

function insetPoly(poly, margin) {
  if (poly.length < 3 || margin <= 0) return poly;
  var n = poly.length;
  var inNormals = [];
  for (var i = 0; i < n; i++) {
    var a = poly[i]; var b = poly[(i+1)%n];
    var dx = b[0]-a[0]; var dy = b[1]-a[1];
    var len = Math.sqrt(dx*dx+dy*dy);
    if (len < 1e-10) { inNormals.push([0,0]); continue; }
    inNormals.push([dy/len, -dx/len]);
  }
  var result = [];
  for (var i = 0; i < n; i++) {
    var prev = (i-1+n)%n;
    var p0=poly[prev]; var p1=poly[i]; var n0=inNormals[prev];
    var a1x=p0[0]+n0[0]*margin; var a1y=p0[1]+n0[1]*margin;
    var a2x=p1[0]+n0[0]*margin; var a2y=p1[1]+n0[1]*margin;
    var p2=poly[i]; var p3=poly[(i+1)%n]; var n1=inNormals[i];
    var b1x=p2[0]+n1[0]*margin; var b1y=p2[1]+n1[1]*margin;
    var b2x=p3[0]+n1[0]*margin; var b2y=p3[1]+n1[1]*margin;
    var dax=a2x-a1x; var day=a2y-a1y;
    var dbx=b2x-b1x; var dby=b2y-b1y;
    var denom=dax*dby-day*dbx;
    if (Math.abs(denom)<1e-10) { result.push([a2x,a2y]); }
    else {
      var t=((b1x-a1x)*dby-(b1y-a1y)*dbx)/denom;
      result.push([a1x+dax*t,a1y+day*t]);
    }
  }
  return result;
}

/**
 * Build a text sprite label positioned above the section box.
 * Clean minimal style — dark text, no background, sharp rendering.
 * @param {string} text - e.g. "9F"
 * @param {Array} footprintM - [a, b, c, d] in meters
 * @param {number} topZ - top of the wireframe box
 * @returns {THREE.Sprite}
 */
export function buildFloorLabel(text, footprintM, topZ) {
  var canvas = document.createElement('canvas');
  var size = 256;
  canvas.width = size;
  canvas.height = size;
  var ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, size, size);

  // Measure with final font to size pill tightly
  ctx.font = '600 64px system-ui, -apple-system, sans-serif';
  var metrics = ctx.measureText(text);
  var textW = metrics.width;

  // Tight pill behind text
  var padH = 20;
  var padV = 12;
  var pillW = textW + padH * 2;
  var pillH = 64 + padV * 2;
  var px = (size - pillW) / 2;
  var py = (size - pillH) / 2;
  var r = pillH / 2;

  // Subtle shadow
  ctx.shadowColor = 'rgba(0, 0, 0, 0.18)';
  ctx.shadowBlur = 8;
  ctx.shadowOffsetX = 0;
  ctx.shadowOffsetY = 2;

  // Frosted background
  ctx.fillStyle = 'rgba(255, 255, 255, 0.88)';
  ctx.beginPath();
  ctx.roundRect(px, py, pillW, pillH, r);
  ctx.fill();

  // Reset shadow
  ctx.shadowColor = 'transparent';
  ctx.shadowBlur = 0;
  ctx.shadowOffsetY = 0;

  // Thin border
  ctx.strokeStyle = 'rgba(0, 0, 0, 0.1)';
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.roundRect(px, py, pillW, pillH, r);
  ctx.stroke();

  // Crisp text
  ctx.fillStyle = '#1a1a1a';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, size / 2, size / 2 + 1);

  var texture = new THREE.CanvasTexture(canvas);
  texture.minFilter = THREE.LinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.needsUpdate = true;

  var mat = new THREE.SpriteMaterial({
    map: texture,
    transparent: true,
    depthTest: false,
    sizeAttenuation: true
  });

  var sprite = new THREE.Sprite(mat);

  var cx = (footprintM[0][0] + footprintM[1][0] + footprintM[2][0] + footprintM[3][0]) / 4;
  var cy = (footprintM[0][1] + footprintM[1][1] + footprintM[2][1] + footprintM[3][1]) / 4;
  sprite.position.set(cx, cy, topZ + 2);
  sprite.scale.set(7, 7, 1);

  return sprite;
}

// ============================================================
// DETAILED FLOOR 1 — walls, windows, slab
// ============================================================

var WALL_MAT = new THREE.MeshLambertMaterial({ color: 0xf0f0f0, side: THREE.DoubleSide });
var EXT_WALL_MAT = new THREE.MeshLambertMaterial({ color: 0x888888, side: THREE.DoubleSide });
var GLASS_MAT = new THREE.MeshBasicMaterial({
  color: 0x6ec6e6, transparent: true, opacity: 0.45, side: THREE.DoubleSide
});
var SLAB_MAT = new THREE.MeshLambertMaterial({ color: 0xbbbbbb, side: THREE.DoubleSide });
var WIN_EDGE_MAT = new THREE.LineBasicMaterial({ color: 0x555555 });

function darkenColor(hexStr, factor) {
  var c = new THREE.Color(hexStr);
  c.r *= factor; c.g *= factor; c.b *= factor;
  return c;
}

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
  // fp1, fp2 = OUTER face (footprint edge). nx,ny = outward normal.
  // Wall goes INWARD: inner = fp - n*EXT_T
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

  // Inner edge (into the building)
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

  // 1. Below window (full wall)
  g.add(new THREE.Mesh(buildBoxGeometry([fp1, fp2, i2, i1], floorZ, winBot), mat));
  // 2. Above window (full wall)
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
  // 5. Back wall behind window opening (NOTCH→inner, 0.1m thick)
  var n1 = [fp1[0] - nx * NOTCH, fp1[1] - ny * NOTCH];
  var n2 = [fp2[0] - nx * NOTCH, fp2[1] - ny * NOTCH];
  function nP(t) { return [n1[0] + ax * t, n1[1] + ay * t]; }
  g.add(new THREE.Mesh(buildBoxGeometry([nP(winL), nP(winR), iP(winR), iP(winL)], winBot, winTop), mat));

  // 6. Glass at notch face (back of the opening)
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
  // Wall goes INWARD from footprint edge
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

var TOP_CAP_MAT = new THREE.MeshLambertMaterial({ color: 0x444444, side: THREE.DoubleSide });

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

function buildDetailLabel(text, polygon, z, inset) {
  if (inset === undefined) inset = 0.08;
  var poly = inset > 0 ? insetPoly(polygon, inset) : polygon;
  var canvas = document.createElement('canvas');
  var size = 128;
  canvas.width = size; canvas.height = size;
  var ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, size, size);
  ctx.font = '400 32px system-ui, -apple-system, sans-serif';
  ctx.fillStyle = '#1a1a1a';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, size / 2, size / 2);

  var texture = new THREE.CanvasTexture(canvas);
  texture.minFilter = THREE.LinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.needsUpdate = true;

  var mat = new THREE.MeshBasicMaterial({
    map: texture, transparent: true, depthTest: false,
    side: THREE.DoubleSide, toneMapped: false
  });
  var planeGeo = new THREE.PlaneGeometry(2.8, 2.8);
  var mesh = new THREE.Mesh(planeGeo, mat);

  var cx = (poly[0][0] + poly[1][0] + poly[2][0] + poly[3][0]) / 4;
  var cy = (poly[0][1] + poly[1][1] + poly[2][1] + poly[3][1]) / 4;
  mesh.position.set(cx, cy, z);

  var ddx = poly[1][0] - poly[0][0]; var ddy = poly[1][1] - poly[0][1];
  mesh.rotation.z = Math.atan2(ddy, ddx);
  return mesh;
}

/**
 * Detailed floor 1 geometry.
 *
 * Cell boxes: from baseZ to topZ, apt-colored sides, dark grey top cap.
 * Walls: inward from footprint edge. 0.3m between apartments, 0.15m inside.
 * Facades: 0.6m thick inward, windows on apartment cells.
 * End walls: windows on apartment edge cells (torec gets light from ends).
 */
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

  // ── 1. Cell boxes: 0.3m colored slab from baseZ ──
  var cellTopZ = baseZ + 0.3;
  for (var cid in numCells) {
    if (!numCells.hasOwnProperty(cid)) continue;
    var node = numCells[cid];
    var poly = node.polygon;
    if (!poly || poly.length < 4) continue;
    var ip = insetPoly(poly, inset);
    var info = cellAptMap ? cellAptMap[node.cellId] : null;
    var matl;
    if (info && info.color) {
      matl = new THREE.MeshLambertMaterial({ color: new THREE.Color(info.color), side: THREE.DoubleSide });
    } else {
      matl = MATERIALS[node.type] || MATERIALS.apartment;
    }
    group.add(new THREE.Mesh(buildBoxGeometry(ip, baseZ, cellTopZ), matl));
    group.add(buildBoxEdges(ip, baseZ, cellTopZ));
    if (showLabels && info && info.label) {
      group.add(buildDetailLabel(info.label, poly, cellTopZ + 0.1, inset));
    }
  }

  // Corridor cells
  for (var cid in corrCells) {
    if (!corrCells.hasOwnProperty(cid)) continue;
    var node = corrCells[cid];
    var poly = node.polygon;
    if (!poly || poly.length < 4) continue;
    var ip = insetPoly(poly, inset);
    var info = cellAptMap ? cellAptMap[node.cellId] : null;
    var matl;
    if (info && info.color) {
      matl = new THREE.MeshLambertMaterial({ color: new THREE.Color(info.color), side: THREE.DoubleSide });
    } else {
      matl = MATERIALS.corridor;
    }
    group.add(new THREE.Mesh(buildBoxGeometry(ip, baseZ, cellTopZ), matl));
    group.add(buildBoxEdges(ip, baseZ, cellTopZ));
  }

  // ── 2. Partition walls ──
  // Helper: is cell LLU?
  function isLLU(cid) { return numCells[cid] && numCells[cid].type === 'llu'; }
  function isApt(cid) { return numCells[cid] && numCells[cid].type === 'apartment'; }

  // Near side partitions (between cells i and i+1)
  for (var i = 0; i < N - 1; i++) {
    if (!numCells[i] || !numCells[i + 1]) continue;
    var p1 = numCells[i].polygon[1];
    var p2 = numCells[i].polygon[2];
    var lluA = isLLU(i); var lluB = isLLU(i + 1);
    if (lluA && lluB) continue;
    if (lluA || lluB) {
      group.add(buildPartitionWall(p1, p2, floorZ, topZ, 0.3));
      continue;
    }
    var infoA = cellAptMap ? cellAptMap[i] : null;
    var infoB = cellAptMap ? cellAptMap[i + 1] : null;
    var same = infoA && infoB && infoA.aptIdx !== undefined && infoA.aptIdx === infoB.aptIdx;
    group.add(buildPartitionWall(p1, p2, floorZ, topZ, same ? 0.10 : 0.3));
  }
  // Far side partitions
  for (var i = N; i < 2 * N - 1; i++) {
    if (!numCells[i] || !numCells[i + 1]) continue;
    var p1 = numCells[i].polygon[0];
    var p2 = numCells[i].polygon[3];
    var lluA = isLLU(i); var lluB = isLLU(i + 1);
    if (lluA && lluB) continue;
    if (lluA || lluB) {
      group.add(buildPartitionWall(p1, p2, floorZ, topZ, 0.3));
      continue;
    }
    var infoA = cellAptMap ? cellAptMap[i] : null;
    var infoB = cellAptMap ? cellAptMap[i + 1] : null;
    var same = infoA && infoB && infoA.aptIdx !== undefined && infoA.aptIdx === infoB.aptIdx;
    group.add(buildPartitionWall(p1, p2, floorZ, topZ, same ? 0.10 : 0.3));
  }

  // ── 2b. Corridor-to-apartment walls (near/far boundary) ──
  for (var i = 0; i < N; i++) {
    if (!numCells[i]) continue;
    var poly = numCells[i].polygon;
    group.add(buildPartitionWall(poly[3], poly[2], floorZ, topZ, 0.3));
  }
  for (var i = N; i < 2 * N; i++) {
    if (!numCells[i]) continue;
    var poly = numCells[i].polygon;
    group.add(buildPartitionWall(poly[0], poly[1], floorZ, topZ, 0.3));
  }

  // ── 2c. Corridor end walls (torec boundaries) — exterior walls ──
  function _corrEndNormal(cp, ep1, ep2) {
    var ccx = (cp[0][0]+cp[1][0]+cp[2][0]+cp[3][0]) / 4;
    var ccy = (cp[0][1]+cp[1][1]+cp[2][1]+cp[3][1]) / 4;
    var mx = (ep1[0]+ep2[0]) / 2; var my = (ep1[1]+ep2[1]) / 2;
    var ox = mx - ccx; var oy = my - ccy;
    var ol = Math.sqrt(ox*ox + oy*oy);
    if (ol < 0.001) return null;
    return [ox/ol, oy/ol];
  }
  var corrLeftId = '0-' + (2 * N - 1);
  if (corrCells[corrLeftId]) {
    var cp = corrCells[corrLeftId].polygon;
    var en = _corrEndNormal(cp, cp[0], cp[3]);
    if (en) group.add(buildSolidExtWall(cp[0], cp[3], en[0], en[1], floorZ, topZ, '#c8c8c8'));
  }
  var corrRightId = (N - 1) + '-' + N;
  if (corrCells[corrRightId]) {
    var cp = corrCells[corrRightId].polygon;
    var en = _corrEndNormal(cp, cp[1], cp[2]);
    if (en) group.add(buildSolidExtWall(cp[1], cp[2], en[0], en[1], floorZ, topZ, '#c8c8c8'));
  }

  // ── 2d. Torec corridor — wall to neighbor corridor ──
  // Left torec corridor: right edge separates from next corridor
  if (corrCells[corrLeftId]) {
    var cp = corrCells[corrLeftId].polygon;
    group.add(buildPartitionWall(cp[1], cp[2], floorZ, topZ, 0.3));
  }
  // Right torec corridor: left edge separates from previous corridor
  if (corrCells[corrRightId]) {
    var cp = corrCells[corrRightId].polygon;
    group.add(buildPartitionWall(cp[0], cp[3], floorZ, topZ, 0.3));
  }

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
    // LLU cells — use their material color
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

  // ── 4. End walls — windows only if no neighbor section ──
  // Left end
  if (!hasLeftNeighbor) {
    if (numCells[0]) {
      var poly = numCells[0].polygon;
      var n = outwardNormal(poly, poly[0], poly[3]);
      if (n) {
        var wc = cellColor(0);
        if (numCells[0].type === 'apartment') group.add(buildFacadeWithWindow(poly[0], poly[3], n[0], n[1], floorZ, topZ, wc));
        else group.add(buildSolidExtWall(poly[0], poly[3], n[0], n[1], floorZ, topZ, wc));
      }
    }
    if (numCells[2 * N - 1]) {
      var poly = numCells[2 * N - 1].polygon;
      var n = outwardNormal(poly, poly[0], poly[3]);
      if (n) {
        var wc = cellColor(2 * N - 1);
        if (numCells[2 * N - 1].type === 'apartment') group.add(buildFacadeWithWindow(poly[0], poly[3], n[0], n[1], floorZ, topZ, wc));
        else group.add(buildSolidExtWall(poly[0], poly[3], n[0], n[1], floorZ, topZ, wc));
      }
    }
  } else {
    // Neighbor present — solid walls, no windows
    if (numCells[0]) {
      var poly = numCells[0].polygon;
      var n = outwardNormal(poly, poly[0], poly[3]);
      if (n) group.add(buildSolidExtWall(poly[0], poly[3], n[0], n[1], floorZ, topZ, cellColor(0)));
    }
    if (numCells[2 * N - 1]) {
      var poly = numCells[2 * N - 1].polygon;
      var n = outwardNormal(poly, poly[0], poly[3]);
      if (n) group.add(buildSolidExtWall(poly[0], poly[3], n[0], n[1], floorZ, topZ, cellColor(2 * N - 1)));
    }
  }
  // Right end
  if (!hasRightNeighbor) {
    if (numCells[N - 1]) {
      var poly = numCells[N - 1].polygon;
      var n = outwardNormal(poly, poly[1], poly[2]);
      if (n) {
        var wc = cellColor(N - 1);
        if (numCells[N - 1].type === 'apartment') group.add(buildFacadeWithWindow(poly[1], poly[2], n[0], n[1], floorZ, topZ, wc));
        else group.add(buildSolidExtWall(poly[1], poly[2], n[0], n[1], floorZ, topZ, wc));
      }
    }
    if (numCells[N]) {
      var poly = numCells[N].polygon;
      var n = outwardNormal(poly, poly[1], poly[2]);
      if (n) {
        var wc = cellColor(N);
        if (numCells[N].type === 'apartment') group.add(buildFacadeWithWindow(poly[1], poly[2], n[0], n[1], floorZ, topZ, wc));
        else group.add(buildSolidExtWall(poly[1], poly[2], n[0], n[1], floorZ, topZ, wc));
      }
    }
  } else {
    if (numCells[N - 1]) {
      var poly = numCells[N - 1].polygon;
      var n = outwardNormal(poly, poly[1], poly[2]);
      if (n) group.add(buildSolidExtWall(poly[1], poly[2], n[0], n[1], floorZ, topZ, cellColor(N - 1)));
    }
    if (numCells[N]) {
      var poly = numCells[N].polygon;
      var n = outwardNormal(poly, poly[1], poly[2]);
      if (n) group.add(buildSolidExtWall(poly[1], poly[2], n[0], n[1], floorZ, topZ, cellColor(N)));
    }
  }

  return group;
}
