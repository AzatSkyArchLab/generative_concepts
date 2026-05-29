/**
 * Geometry helpers for tower-residential-v1.
 *
 * Lifted verbatim from the parametric_tower.jsx prototype — only the
 * React wrapper was stripped. Pure functions, no module state, no
 * side effects beyond returning THREE objects.
 *
 * Coordinate convention (matches the prototype):
 *   · +X / +Z = horizontal extents (plan)
 *   · +Y      = up (vertical)
 *   · Section origin is at the base, centered in X/Z.
 *
 * The library renderer rotates the whole tower group around Y to align
 * with map north, so we keep building blocks in their local frame.
 */

import * as THREE from 'three';

// ── PRNG + small utils ───────────────────────────────────

export function mulberry32(seed) {
  return function () {
    var t = (seed += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * 3-segment offset stack: each segment is shifted/rotated by a
 * deterministic random amount. Returns 3 entries — caller stacks
 * them vertically.
 */
export function generateSections(seed, rotMaxDeg) {
  var rng = mulberry32(seed);
  var sections = [];
  for (var i = 0; i < 3; i++) {
    var angle = rng() * Math.PI * 2;
    var dist = 3 + rng() * 3;
    var rotOffset = (rng() - 0.5) * 2 * rotMaxDeg * (Math.PI / 180);
    sections.push({
      offsetX: Math.cos(angle) * dist,
      offsetZ: Math.sin(angle) * dist,
      rotation: rotOffset
    });
  }
  return sections;
}

// ── primitive walls / floors ─────────────────────────────

export function buildWall(width, height, material) {
  var geom = new THREE.PlaneGeometry(width, height);
  var mesh = new THREE.Mesh(geom, material);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  return mesh;
}

export function generateBandFloors(numFloors, step) {
  var result = [];
  var current = 0;
  while (current + step <= numFloors) {
    current += step;
    result.push(current);
  }
  return result;
}

export function computeBandStep(sectionIdx, cfg) {
  if (cfg.bandMode === 'constant') return cfg.bandStep;
  if (sectionIdx === 0) return cfg.bandMinStep;
  if (sectionIdx === 2) return cfg.bandMaxStep;
  return Math.round((cfg.bandMinStep + cfg.bandMaxStep) / 2);
}

export function buildFloorBands(planX, planY, floorAnchors, bandH, depth, material) {
  var floorH = 3;
  var group = new THREE.Group();
  if (floorAnchors.length === 0) return group;

  var geomNS = new THREE.BoxGeometry(planX, bandH, depth);
  var meshNS = new THREE.InstancedMesh(geomNS, material, floorAnchors.length * 2);
  meshNS.castShadow = true;
  meshNS.receiveShadow = true;

  var geomEW = new THREE.BoxGeometry(depth, bandH, planY);
  var meshEW = new THREE.InstancedMesh(geomEW, material, floorAnchors.length * 2);
  meshEW.castShadow = true;
  meshEW.receiveShadow = true;

  var matrix = new THREE.Matrix4();
  var nsIdx = 0;
  var ewIdx = 0;
  var zN = planY / 2 + depth / 2;
  var zS = -planY / 2 - depth / 2;
  var xE = planX / 2 + depth / 2;
  var xW = -planX / 2 - depth / 2;

  for (var i = 0; i < floorAnchors.length; i++) {
    var y = floorAnchors[i] * floorH;
    matrix.makeTranslation(0, y, zN);  meshNS.setMatrixAt(nsIdx++, matrix);
    matrix.makeTranslation(0, y, zS);  meshNS.setMatrixAt(nsIdx++, matrix);
    matrix.makeTranslation(xE, y, 0);  meshEW.setMatrixAt(ewIdx++, matrix);
    matrix.makeTranslation(xW, y, 0);  meshEW.setMatrixAt(ewIdx++, matrix);
  }
  meshNS.instanceMatrix.needsUpdate = true;
  meshEW.instanceMatrix.needsUpdate = true;
  group.add(meshNS);
  group.add(meshEW);
  return group;
}

// ── Hex / circle frames ──────────────────────────────────

function createHexFrameGeometry(outerR, frameW, depth) {
  var innerR = Math.max(0.02, outerR - frameW);
  var shape = new THREE.Shape();
  for (var i = 0; i < 6; i++) {
    var a = Math.PI / 2 + (i * Math.PI) / 3;
    var x = outerR * Math.cos(a);
    var y = outerR * Math.sin(a);
    if (i === 0) shape.moveTo(x, y); else shape.lineTo(x, y);
  }
  var hole = new THREE.Path();
  for (var j = 0; j < 6; j++) {
    var a2 = Math.PI / 2 + (j * Math.PI) / 3;
    var hx = innerR * Math.cos(a2);
    var hy = innerR * Math.sin(a2);
    if (j === 0) hole.moveTo(hx, hy); else hole.lineTo(hx, hy);
  }
  shape.holes.push(hole);
  return new THREE.ExtrudeGeometry(shape, { depth: depth, bevelEnabled: false });
}

function createRingGeometry(outerR, frameW, depth) {
  var innerR = Math.max(0.02, outerR - frameW);
  var shape = new THREE.Shape();
  shape.absarc(0, 0, outerR, 0, Math.PI * 2, false);
  var hole = new THREE.Path();
  hole.absarc(0, 0, innerR, 0, Math.PI * 2, true);
  shape.holes.push(hole);
  return new THREE.ExtrudeGeometry(shape, { depth: depth, bevelEnabled: false, curveSegments: 32 });
}

function tessellateHex(W, H, r) {
  var hSpace = Math.sqrt(3) * r;
  var vSpace = 1.5 * r;
  var positions = [];
  var row = 0;
  var y = r;
  while (y <= H - r + 0.01) {
    var xOff = (row % 2) * (hSpace / 2);
    var x = -W / 2 + hSpace / 2 + xOff;
    while (x <= W / 2 - hSpace / 2 + 0.01) {
      positions.push({ along: x, up: y });
      x += hSpace;
    }
    y += vSpace; row++;
  }
  return positions;
}

function tessellateCircles(W, H, r) {
  var hSpace = 2 * r;
  var vSpace = Math.sqrt(3) * r;
  var positions = [];
  var row = 0;
  var y = r;
  while (y <= H - r + 0.01) {
    var xOff = (row % 2) * r;
    var x = -W / 2 + r + xOff;
    while (x <= W / 2 - r + 0.01) {
      positions.push({ along: x, up: y });
      x += hSpace;
    }
    y += vSpace; row++;
  }
  return positions;
}

function buildFrameGrid(geom, planX, planY, sectionHeight, tessellator, material) {
  var group = new THREE.Group();
  var nsPositions = tessellator(planX, sectionHeight);
  var ewPositions = tessellator(planY, sectionHeight);
  var total = (nsPositions.length + ewPositions.length) * 2;
  if (total === 0) { geom.dispose(); return group; }

  var mesh = new THREE.InstancedMesh(geom, material, total);
  mesh.castShadow = true;
  mesh.receiveShadow = true;

  var matrix = new THREE.Matrix4();
  var scale = new THREE.Vector3(1, 1, 1);
  var quatN = new THREE.Quaternion().setFromEuler(new THREE.Euler(0, 0, 0));
  var quatS = new THREE.Quaternion().setFromEuler(new THREE.Euler(0, Math.PI, 0));
  var quatE = new THREE.Quaternion().setFromEuler(new THREE.Euler(0, Math.PI / 2, 0));
  var quatW = new THREE.Quaternion().setFromEuler(new THREE.Euler(0, -Math.PI / 2, 0));

  var idx = 0;
  for (var i = 0; i < nsPositions.length; i++) {
    var p = nsPositions[i];
    matrix.compose(new THREE.Vector3(p.along, p.up, planY / 2), quatN, scale);
    mesh.setMatrixAt(idx++, matrix);
    matrix.compose(new THREE.Vector3(p.along, p.up, -planY / 2), quatS, scale);
    mesh.setMatrixAt(idx++, matrix);
  }
  for (var j = 0; j < ewPositions.length; j++) {
    var q = ewPositions[j];
    matrix.compose(new THREE.Vector3(planX / 2, q.up, q.along), quatE, scale);
    mesh.setMatrixAt(idx++, matrix);
    matrix.compose(new THREE.Vector3(-planX / 2, q.up, q.along), quatW, scale);
    mesh.setMatrixAt(idx++, matrix);
  }
  mesh.instanceMatrix.needsUpdate = true;
  group.add(mesh);
  return group;
}

export function buildHexGrid(planX, planY, sectionHeight, outerR, frameW, depth, material) {
  if (outerR <= 0 || frameW <= 0) return new THREE.Group();
  var geom = createHexFrameGeometry(outerR, frameW, depth);
  return buildFrameGrid(geom, planX, planY, sectionHeight,
    function (W, H) { return tessellateHex(W, H, outerR); }, material);
}

export function buildCircleGrid(planX, planY, sectionHeight, outerR, frameW, depth, material) {
  if (outerR <= 0 || frameW <= 0) return new THREE.Group();
  var geom = createRingGeometry(outerR, frameW, depth);
  return buildFrameGrid(geom, planX, planY, sectionHeight,
    function (W, H) { return tessellateCircles(W, H, outerR); }, material);
}

// ── Vertical fins ────────────────────────────────────────

export function buildFins(planX, planY, height, step, finW, depth, material) {
  var group = new THREE.Group();
  var finGeomNS = new THREE.BoxGeometry(finW, height, depth);
  var finGeomEW = new THREE.BoxGeometry(depth, height, finW);

  function placeAlong(L, makeMesh) {
    var count = Math.max(1, Math.floor(L / step));
    var actualStep = L / count;
    for (var i = 0; i < count; i++) {
      var along = -L / 2 + actualStep / 2 + i * actualStep;
      makeMesh(along);
    }
  }

  placeAlong(planX, function (along) {
    var m = new THREE.Mesh(finGeomNS, material);
    m.position.set(along, height / 2, planY / 2 + depth / 2);
    m.castShadow = true; m.receiveShadow = true; group.add(m);
  });
  placeAlong(planX, function (along) {
    var m = new THREE.Mesh(finGeomNS, material);
    m.position.set(along, height / 2, -planY / 2 - depth / 2);
    m.castShadow = true; m.receiveShadow = true; group.add(m);
  });
  placeAlong(planY, function (along) {
    var m = new THREE.Mesh(finGeomEW, material);
    m.position.set(planX / 2 + depth / 2, height / 2, along);
    m.castShadow = true; m.receiveShadow = true; group.add(m);
  });
  placeAlong(planY, function (along) {
    var m = new THREE.Mesh(finGeomEW, material);
    m.position.set(-planX / 2 - depth / 2, height / 2, along);
    m.castShadow = true; m.receiveShadow = true; group.add(m);
  });
  return group;
}

// ── Section (one of 3 stacked segments) ─────────────────

export function buildSection(planX, planY, height, materials, finsConfig, sectionIdx) {
  var group = new THREE.Group();

  // 4 facade walls.
  var north = buildWall(planX, height, materials.facade);
  north.position.set(0, height / 2, planY / 2);
  group.add(north);

  var south = buildWall(planX, height, materials.facade);
  south.position.set(0, height / 2, -planY / 2);
  south.rotation.y = Math.PI;
  group.add(south);

  var east = buildWall(planY, height, materials.facade);
  east.position.set(planX / 2, height / 2, 0);
  east.rotation.y = Math.PI / 2;
  group.add(east);

  var west = buildWall(planY, height, materials.facade);
  west.position.set(-planX / 2, height / 2, 0);
  west.rotation.y = -Math.PI / 2;
  group.add(west);

  // Top slab + base.
  var slabH = 0.6;
  var slabGeom = new THREE.BoxGeometry(planX + 0.6, slabH, planY + 0.6);
  var slab = new THREE.Mesh(slabGeom, materials.slab);
  slab.position.y = height + slabH / 2;
  slab.castShadow = true; slab.receiveShadow = true;
  group.add(slab);

  var baseGeom = new THREE.BoxGeometry(planX + 0.2, 0.3, planY + 0.2);
  var base = new THREE.Mesh(baseGeom, materials.slab);
  base.position.y = 0.15;
  base.castShadow = true; base.receiveShadow = true;
  group.add(base);

  if (finsConfig.enabled) {
    group.add(buildFins(planX, planY, height, finsConfig.step,
      finsConfig.width, finsConfig.depth, materials.fin));
  }

  var numFloors = Math.round(height / 3);

  if (finsConfig.bandsEnabled) {
    var step = computeBandStep(sectionIdx, finsConfig);
    var anchors = generateBandFloors(numFloors, step);
    group.add(buildFloorBands(planX, planY, anchors,
      finsConfig.width, finsConfig.depth, materials.fin));
  }

  if (finsConfig.linesEnabled) {
    var allFloors = [];
    for (var f = 1; f <= numFloors; f++) allFloors.push(f);
    group.add(buildFloorBands(planX, planY, allFloors,
      finsConfig.lineHeight, finsConfig.lineDepth, materials.line));
  }

  if (finsConfig.hexEnabled) {
    group.add(buildHexGrid(planX, planY, height,
      finsConfig.hexRadius, finsConfig.hexFrameWidth, finsConfig.hexDepth,
      materials.pattern));
  }

  if (finsConfig.circlesEnabled) {
    group.add(buildCircleGrid(planX, planY, height,
      finsConfig.circleRadius, finsConfig.circleFrameWidth, finsConfig.circleDepth,
      materials.pattern));
  }

  return group;
}

// ── Core (central elevator/stairs shaft) ─────────────────

export function buildCore(coreX, coreY, totalH, coreMat) {
  var geom = new THREE.BoxGeometry(coreX, totalH, coreY);
  var mesh = new THREE.Mesh(geom, coreMat);
  mesh.position.y = totalH / 2;
  mesh.castShadow = true; mesh.receiveShadow = true;
  return mesh;
}
