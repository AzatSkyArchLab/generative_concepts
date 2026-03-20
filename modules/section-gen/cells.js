/**
 * Cells — generate cell polygons along a section axis
 *
 * All section lengths are multiples of cellWidth (3.3m).
 * insetPolygon shrinks each cell by a small margin to create
 * visible gaps (outlines) between adjacent cells in 3D.
 */

export function getCellParams() {
  return {
    sectionWidth: 18.0,
    corridorWidth: 2.0,
    cellWidth: 3.3,
    apartmentDepth: 8.0
  };
}

// ── Geometry helpers ───────────────────────────────────

function unitNormal(p1, p2) {
  var dx = p2[0] - p1[0];
  var dy = p2[1] - p1[1];
  var len = Math.sqrt(dx * dx + dy * dy);
  if (len < 1e-10) return [0, 0];
  return [-dy / len, dx / len];
}

function vecAdd(a, b) { return [a[0] + b[0], a[1] + b[1]]; }
function vecScale(v, s) { return [v[0] * s, v[1] * s]; }
function vecSub(a, b) { return [a[0] - b[0], a[1] - b[1]]; }

function vecLength(v) { return Math.sqrt(v[0] * v[0] + v[1] * v[1]); }

function vecNormalize(v) {
  var len = vecLength(v);
  if (len < 1e-10) return [0, 0];
  return [v[0] / len, v[1] / len];
}

/**
 * Inset a 4-point polygon by margin on all sides.
 * Creates visible gap between adjacent cells.
 * @param {Array<[number,number]>} poly - 4 corners [a, b, c, d]
 * @param {number} margin
 * @returns {Array<[number,number]>}
 */
export function insetPolygon(poly, margin) {
  if (poly.length < 4 || margin <= 0) return poly;

  // Compute centroid
  var cx = 0;
  var cy = 0;
  for (var i = 0; i < poly.length; i++) {
    cx += poly[i][0];
    cy += poly[i][1];
  }
  cx /= poly.length;
  cy /= poly.length;

  var result = [];
  for (var i = 0; i < poly.length; i++) {
    var dx = poly[i][0] - cx;
    var dy = poly[i][1] - cy;
    var dist = Math.sqrt(dx * dx + dy * dy);
    if (dist < 1e-10) {
      result.push([poly[i][0], poly[i][1]]);
      continue;
    }
    var shrink = margin / dist;
    if (shrink > 0.4) shrink = 0.4; // safety cap
    result.push([
      poly[i][0] - dx * shrink,
      poly[i][1] - dy * shrink
    ]);
  }
  return result;
}

function splitByDistance(coords, step) {
  var totalLen = 0;
  for (var i = 0; i < coords.length - 1; i++) {
    var dx = coords[i + 1][0] - coords[i][0];
    var dy = coords[i + 1][1] - coords[i][1];
    totalLen += Math.sqrt(dx * dx + dy * dy);
  }
  var cellCount = Math.round(totalLen / step);
  if (cellCount < 1) cellCount = 1;

  var points = [];
  for (var ci = 0; ci <= cellCount; ci++) {
    var t = ci / cellCount;
    var dist = t * totalLen;
    points.push(interpolateAt(coords, dist, totalLen));
  }
  return points;
}

function interpolateAt(coords, dist, totalLen) {
  if (dist <= 0) return [coords[0][0], coords[0][1]];
  var accumulated = 0;
  for (var i = 0; i < coords.length - 1; i++) {
    var dx = coords[i + 1][0] - coords[i][0];
    var dy = coords[i + 1][1] - coords[i][1];
    var segLen = Math.sqrt(dx * dx + dy * dy);
    if (accumulated + segLen >= dist - 1e-10) {
      var t = (dist - accumulated) / segLen;
      if (t > 1) t = 1;
      if (t < 0) t = 0;
      return [coords[i][0] + dx * t, coords[i][1] + dy * t];
    }
    accumulated += segLen;
  }
  var last = coords[coords.length - 1];
  return [last[0], last[1]];
}

// ── Cell creation ──────────────────────────────────────

export function createNearCells(axisCoords, cellWidth, cellDepth) {
  var points = splitByDistance(axisCoords, cellWidth);
  var polygons = [];
  for (var i = 0; i < points.length - 1; i++) {
    var p1 = points[i];
    var p2 = points[i + 1];
    var n = unitNormal(p1, p2);
    var offset = vecScale(n, cellDepth);
    polygons.push([p1, p2, vecAdd(p2, offset), vecAdd(p1, offset)]);
  }
  return polygons;
}

export function createFarCells(axisCoords, cellWidth, cellDepth, farOffset) {
  var points = splitByDistance(axisCoords, cellWidth);
  var polygons = [];
  for (var i = 0; i < points.length - 1; i++) {
    var p1 = points[i];
    var p2 = points[i + 1];
    var n = unitNormal(p1, p2);
    var offStart = vecScale(n, farOffset);
    var offEnd = vecScale(n, farOffset + cellDepth);
    polygons.push([vecAdd(p1, offStart), vecAdd(p2, offStart), vecAdd(p2, offEnd), vecAdd(p1, offEnd)]);
  }
  polygons.reverse();
  return polygons;
}

export function createCorridorCells(axisCoords, cellWidth, corridorWidth, corridorOffset) {
  var points = splitByDistance(axisCoords, cellWidth);
  var polygons = [];
  for (var i = 0; i < points.length - 1; i++) {
    var p1 = points[i];
    var p2 = points[i + 1];
    var n = unitNormal(p1, p2);
    var a = vecAdd(p1, vecScale(n, corridorOffset));
    var b = vecAdd(p2, vecScale(n, corridorOffset));
    var c = vecAdd(p2, vecScale(n, corridorOffset + corridorWidth));
    var d = vecAdd(p1, vecScale(n, corridorOffset + corridorWidth));
    polygons.push([a, b, c, d]);
  }
  return polygons;
}

export function getNorthSide(axisCoords) {
  if (axisCoords.length < 2) return 'near';
  var sumNx = 0;
  var sumNy = 0;
  for (var i = 0; i < axisCoords.length - 1; i++) {
    var n = unitNormal(axisCoords[i], axisCoords[i + 1]);
    sumNx += n[0];
    sumNy += n[1];
  }
  // unitNormal = far outward direction
  // near outward = (-sumNx, -sumNy), far outward = (sumNx, sumNy)
  // near dot north[0,1] = -sumNy, far dot north = sumNy
  // near is north when -sumNy >= sumNy → sumNy <= 0
  if (sumNy <= 0) return 'near';
  return 'far';
}

export function getCentralIndices(count, total) {
  if (total === 0) return [];
  var center = total / 2.0;
  var scored = [];
  for (var i = 0; i < total; i++) {
    scored.push({ dist: Math.abs(i + 0.5 - center), idx: i });
  }
  scored.sort(function (a, b) { return a.dist - b.dist; });
  var result = [];
  for (var i = 0; i < Math.min(count, total); i++) {
    result.push(scored[i].idx);
  }
  result.sort(function (a, b) { return a - b; });
  return result;
}

export function getLLUParams(sectionHeight) {
  if (sectionHeight <= 28) return { count: 2, tag: 'L1' };
  if (sectionHeight <= 50) return { count: 3, tag: 'N2/N3' };
  return { count: 3, tag: 'N1' };
}
