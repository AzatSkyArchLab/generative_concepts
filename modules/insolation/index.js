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
import { getParams, getSectionHeight, computeBuildingHeight } from '../../core/SectionParams.js';
import { createProjection, centroid } from '../../core/geo/projection.js';

// ── Config ─────────────────────────────────────────────

var LATITUDE = 55;
var NORMATIVE_MINUTES = 120;
var FACADE_OFFSET = 0.5;
var POINT_RADIUS = 0.6;
var MAX_RAY_DISTANCE = 500;
var RAY_FREE_LENGTH = 80;

var COLORS = { PASS: 0x22c55e, WARNING: 0xf59e0b, FAIL: 0xef4444 };
var RAY_COLORS = { free: 0xfbbf24, blocked: 0xef4444 };

// ── State ──────────────────────────────────────────────

var _mapManager, _featureStore, _eventBus, _threeOverlay;
var _unsubs = [];
var _resultGroup = null;
var _raysGroup = null;
var _collisionMeshes = [];
var _raycaster = new THREE.Raycaster();
var _lastResults = null;
var _lastPointData = null;
var _analysisLevel = null;
var _raysVisible = false;
var _globalActive = false;    // persistent global mode

// ── Collision box ──────────────────────────────────────

function buildCollisionBox(fpM, height) {
  var a = fpM[0]; var b = fpM[1]; var c = fpM[2]; var d = fpM[3];
  var verts = new Float32Array([
    a[0], a[1], 0, b[0], b[1], 0, c[0], c[1], 0, d[0], d[1], 0,
    a[0], a[1], height, b[0], b[1], height, c[0], c[1], height, d[0], d[1], height
  ]);
  var idx = new Uint16Array([
    0, 1, 5, 0, 5, 4, 1, 2, 6, 1, 6, 5, 2, 3, 7, 2, 7, 6,
    3, 0, 4, 3, 4, 7, 4, 5, 6, 4, 6, 7, 0, 3, 2, 0, 2, 1
  ]);
  var geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(verts, 3));
  geo.setIndex(new THREE.BufferAttribute(idx, 1));
  geo.computeBoundingSphere();
  return new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ visible: false, side: THREE.DoubleSide }));
}

function buildAllCollisionMeshes(sections, proj) {
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
      var fpM = [];
      for (var j = 0; j < fp.polygon.length; j++)
        fpM.push(proj.toMeters(fp.polygon[j][0], fp.polygon[j][1]));
      meshes.push(buildCollisionBox(fpM, buildingH));
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

function generateFacadePoints(fpM, params) {
  var points = [];
  var cx = (fpM[0][0] + fpM[1][0] + fpM[2][0] + fpM[3][0]) / 4;
  var cy = (fpM[0][1] + fpM[1][1] + fpM[2][1] + fpM[3][1]) / 4;

  var facades = [
    { p1: fpM[0], p2: fpM[1], side: 'near' },
    { p1: fpM[2], p2: fpM[3], side: 'far' }
  ];

  // Floor 1 = first residential: z at mid-height of that floor
  var z = params.firstFloorHeight + params.typicalFloorHeight / 2;

  for (var fi = 0; fi < facades.length; fi++) {
    var f = facades[fi];
    var normal = getOutwardNormal(f.p1, f.p2, cx, cy);
    var edgeDx = f.p2[0] - f.p1[0]; var edgeDy = f.p2[1] - f.p1[1];
    var edgeLen = Math.sqrt(edgeDx * edgeDx + edgeDy * edgeDy);
    var cellCount = Math.max(1, Math.round(edgeLen / params.cellWidth));

    for (var ci = 0; ci < cellCount; ci++) {
      var t = (ci + 0.5) / cellCount;
      var px = f.p1[0] + edgeDx * t + normal[0] * FACADE_OFFSET;
      var py = f.p1[1] + edgeDy * t + normal[1] * FACADE_OFFSET;
      points.push({ position: [px, py, z], side: f.side, cellIdx: ci, normal: normal });
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
    _raycaster.near = 0.1;
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

function getProj(sections) {
  var allC = [];
  for (var i = 0; i < sections.length; i++) {
    var c = sections[i].geometry.coordinates;
    for (var j = 0; j < c.length; j++) allC.push(c[j]);
  }
  var gc = centroid(allC);
  return createProjection(gc[0], gc[1]);
}

function runAnalysis(level, axisId, sectionIdx) {
  clearResults();
  var sections = collectSections();
  if (sections.length === 0) return;

  _analysisLevel = level;
  if (level === 'global') {
    _globalActive = true;
  }
  var proj = getProj(sections);
  var sunData = getSunVectors(LATITUDE);
  var sunVectors = sunData.vectors;
  var rayMinutes = sunData.timeStep;

  _collisionMeshes = buildAllCollisionMeshes(sections, proj);

  var targets = [];
  if (level === 'global') { targets = sections; }
  else {
    for (var i = 0; i < sections.length; i++)
      if (sections[i].properties.id === axisId) { targets.push(sections[i]); break; }
  }

  var facadeResults = [];
  var pass = 0; var warn = 0; var fail = 0;

  for (var si = 0; si < targets.length; si++) {
    var feature = targets[si];
    var storedFP = feature.properties.footprints;
    if (!storedFP || storedFP.length === 0) continue;
    var params = getParams(feature.properties);

    for (var fi = 0; fi < storedFP.length; fi++) {
      if (level === 'section' && fi !== sectionIdx) continue;
      var fp = storedFP[fi];
      var secH = getSectionHeight(fp, params);
      var fpM = [];
      for (var j = 0; j < fp.polygon.length; j++)
        fpM.push(proj.toMeters(fp.polygon[j][0], fp.polygon[j][1]));

      var points = generateFacadePoints(fpM, params);
      for (var pi = 0; pi < points.length; pi++) {
        var pt = points[pi];
        var rayResults = castSunRays(pt.position, sunVectors, _collisionMeshes);
        var isFree = [];
        for (var ri = 0; ri < rayResults.length; ri++) isFree.push(rayResults[ri].free);
        var ev = evaluateInsolation(isFree, NORMATIVE_MINUTES, rayMinutes);

        facadeResults.push({
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

  _lastResults = facadeResults;
  _lastPointData = facadeResults;
  displayResults(facadeResults);
  if (_raysVisible) showAllRays(sunVectors);

  console.log('[insolation] ' + level + ': ' + facadeResults.length + ' pts — P:' + pass + ' W:' + warn + ' F:' + fail);
  _eventBus.emit('insolation:results', {
    level: level, total: facadeResults.length,
    pass: pass, warning: warn, fail: fail,
    complianceRate: facadeResults.length > 0 ? ((pass + warn) / facadeResults.length * 100).toFixed(0) : 0
  });
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
  _eventBus.emit('insolation:rays:visibility', { visible: false });
}

var _debounceTimer = null;
function onSectionsChanged() {
  if (!_globalActive) return;
  if (_debounceTimer) clearTimeout(_debounceTimer);
  _debounceTimer = setTimeout(function () {
    _debounceTimer = null;
    var sections = collectSections();
    if (sections.length === 0) { onClear(); return; }
    runAnalysis('global');
  }, 150);
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

    console.log('[insolation] initialized (lat=' + LATITUDE + '°, norm=' + NORMATIVE_MINUTES + 'min)');
  },
  destroy: function () {
    for (var i = 0; i < _unsubs.length; i++) _unsubs[i]();
    _unsubs = [];
    _globalActive = false;
    clearResults();
    _mapManager = null; _featureStore = null; _eventBus = null; _threeOverlay = null;
  }
};

export default insolationModule;