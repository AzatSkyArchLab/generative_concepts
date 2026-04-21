/**
 * Geometry utilities — pure 2D operations in meter space
 *
 * All inputs/outputs are [x, y] arrays (meters).
 * No list comprehensions per convention.
 */

// ── Vector operations ──────────────────────────────────

export function vecSub(a, b) {
  return [a[0] - b[0], a[1] - b[1]];
}

export function vecAdd(a, b) {
  return [a[0] + b[0], a[1] + b[1]];
}

export function vecScale(v, s) {
  return [v[0] * s, v[1] * s];
}

export function vecLength(v) {
  return Math.sqrt(v[0] * v[0] + v[1] * v[1]);
}

export function vecNormalize(v) {
  var len = vecLength(v);
  if (len < 1e-10) return [0, 0];
  return [v[0] / len, v[1] / len];
}

export function vecDot(a, b) {
  return a[0] * b[0] + a[1] * b[1];
}

export function vecCross2D(a, b) {
  return a[0] * b[1] - a[1] * b[0];
}

/** Perpendicular (rotated 90° CCW) */
export function vecPerp(v) {
  return [-v[1], v[0]];
}

export function vecDist(a, b) {
  var dx = a[0] - b[0];
  var dy = a[1] - b[1];
  return Math.sqrt(dx * dx + dy * dy);
}

// ── Angle utilities ────────────────────────────────────

/**
 * Angle between two vectors in degrees [0..180]
 */
export function angleBetween(v1, v2) {
  var l1 = vecLength(v1);
  var l2 = vecLength(v2);
  if (l1 < 1e-10 || l2 < 1e-10) return 0;
  var dot = vecDot(v1, v2) / (l1 * l2);
  dot = Math.max(-1, Math.min(1, dot));
  return Math.acos(Math.abs(dot)) * (180 / Math.PI);
}

/**
 * Internal angle at vertex B (between edges BA and BC), in degrees
 */
export function internalAngle(a, b, c) {
  var v1 = vecSub(a, b);
  var v2 = vecSub(c, b);
  var l1 = vecLength(v1);
  var l2 = vecLength(v2);
  if (l1 < 1e-6 || l2 < 1e-6) return 0;
  var dot = vecDot(v1, v2) / (l1 * l2);
  dot = Math.max(-1, Math.min(1, dot));
  return Math.acos(dot) * (180 / Math.PI);
}

// ── Polygon / Ring utilities ───────────────────────────

/**
 * Signed area of a polygon ring (positive = CCW)
 */
export function signedArea(ring) {
  var n = ring.length;
  var area = 0;
  for (var i = 0; i < n; i++) {
    var j = (i + 1) % n;
    area += ring[i][0] * ring[j][1];
    area -= ring[j][0] * ring[i][1];
  }
  return area / 2;
}

/**
 * Ensure ring is CCW (positive area). Returns new array if reversed.
 */
export function ensureCCW(ring) {
  if (signedArea(ring) < 0) {
    var reversed = [];
    for (var i = ring.length - 1; i >= 0; i--) {
      reversed.push(ring[i]);
    }
    return reversed;
  }
  return ring;
}

/**
 * Centroid of a polygon ring
 */
export function ringCentroid(ring) {
  var sx = 0;
  var sy = 0;
  var n = ring.length;
  for (var i = 0; i < n; i++) {
    sx += ring[i][0];
    sy += ring[i][1];
  }
  return [sx / n, sy / n];
}

/**
 * Point-in-polygon (ray casting)
 * @param {[number, number]} point
 * @param {Array<[number, number]>} ring - closed or open ring
 * @returns {boolean}
 */
export function pointInPolygon(point, ring) {
  var x = point[0];
  var y = point[1];
  var inside = false;
  var n = ring.length;

  for (var i = 0, j = n - 1; i < n; j = i++) {
    var xi = ring[i][0];
    var yi = ring[i][1];
    var xj = ring[j][0];
    var yj = ring[j][1];

    var intersect = ((yi > y) !== (yj > y)) &&
      (x < (xj - xi) * (y - yi) / (yj - yi) + xi);
    if (intersect) inside = !inside;
  }
  return inside;
}

// ── Line / Segment operations ──────────────────────────

/**
 * Offset a polyline by distance (positive = left/CCW side)
 * @param {Array<[number, number]>} coords
 * @param {number} distance
 * @returns {Array<[number, number]>}
 */
export function offsetPolyline(coords, distance) {
  if (coords.length < 2) return coords;

  var result = [];
  for (var i = 0; i < coords.length - 1; i++) {
    var dir = vecNormalize(vecSub(coords[i + 1], coords[i]));
    var perp = vecPerp(dir);
    var offset = vecScale(perp, distance);

    if (i === 0) {
      result.push(vecAdd(coords[i], offset));
    }
    result.push(vecAdd(coords[i + 1], offset));
  }

  return result;
}

/**
 * Interpolate a point along a polyline at given distance from start
 * @param {Array<[number, number]>} coords
 * @param {number} dist - distance from start in meters
 * @returns {[number, number]}
 */
export function interpolateAtDistance(coords, dist) {
  if (coords.length < 2) return coords[0];
  if (dist <= 0) return coords[0];

  var accumulated = 0;
  for (var i = 0; i < coords.length - 1; i++) {
    var segLen = vecDist(coords[i], coords[i + 1]);
    if (accumulated + segLen >= dist) {
      var t = (dist - accumulated) / segLen;
      return [
        coords[i][0] + (coords[i + 1][0] - coords[i][0]) * t,
        coords[i][1] + (coords[i + 1][1] - coords[i][1]) * t
      ];
    }
    accumulated += segLen;
  }

  return coords[coords.length - 1];
}

/**
 * Total length of a polyline
 */
export function polylineLength(coords) {
  var total = 0;
  for (var i = 0; i < coords.length - 1; i++) {
    total += vecDist(coords[i], coords[i + 1]);
  }
  return total;
}

/**
 * Create a rectangle from a line segment and width (offset to one side)
 * @param {[number,number]} start
 * @param {[number,number]} end
 * @param {number} width
 * @param {[number,number]} offsetDir - normalized perpendicular direction
 * @returns {Array<[number,number]>} 4 corners [start, end, end+offset, start+offset]
 */
export function segmentRectangle(start, end, width, offsetDir) {
  var offset = vecScale(offsetDir, width);
  return [
    start,
    end,
    vecAdd(end, offset),
    vecAdd(start, offset)
  ];
}

/**
 * Buffer a point with a circle polygon (approximation)
 * @param {[number, number]} center
 * @param {number} radius
 * @param {number} [segments=32]
 * @returns {Array<[number, number]>} ring
 */
export function circleBuffer(center, radius, segments) {
  if (!segments) segments = 32;
  var ring = [];
  for (var i = 0; i <= segments; i++) {
    var angle = (2 * Math.PI * i) / segments;
    ring.push([
      center[0] + radius * Math.cos(angle),
      center[1] + radius * Math.sin(angle)
    ]);
  }
  return ring;
}

// ── Line-segment clipping against polygon ──────────────

/**
 * Clip a line segment [p0, p1] to polygon interior.
 * Returns array of [start, end] segments that are inside.
 * Uses Sutherland-Hodgman concept adapted for single segment.
 *
 * @param {[number,number]} p0
 * @param {[number,number]} p1
 * @param {Array<[number,number]>} ring - polygon ring (closed)
 * @returns {Array<[[number,number],[number,number]]>}
 */
export function clipSegmentToPolygon(p0, p1, ring) {
  // Parametric clipping: find t values where segment crosses polygon edges
  var tMin = 0;
  var tMax = 1;
  var dx = p1[0] - p0[0];
  var dy = p1[1] - p0[1];
  var n = ring.length;

  // Check if we need to find intersections
  var inside0 = pointInPolygon(p0, ring);
  var inside1 = pointInPolygon(p1, ring);

  if (inside0 && inside1) {
    return [[p0, p1]];
  }

  // Find all intersection t-values
  var intersections = [];
  for (var i = 0; i < n; i++) {
    var j = (i + 1) % n;
    var ex = ring[j][0] - ring[i][0];
    var ey = ring[j][1] - ring[i][1];

    var denom = dx * ey - dy * ex;
    if (Math.abs(denom) < 1e-10) continue;

    var t = ((ring[i][0] - p0[0]) * ey - (ring[i][1] - p0[1]) * ex) / denom;
    var u = ((ring[i][0] - p0[0]) * dy - (ring[i][1] - p0[1]) * dx) / denom;

    if (t >= -1e-10 && t <= 1 + 1e-10 && u >= -1e-10 && u <= 1 + 1e-10) {
      intersections.push(Math.max(0, Math.min(1, t)));
    }
  }

  if (intersections.length === 0) {
    if (inside0) return [[p0, p1]];
    return [];
  }

  // Sort intersections
  intersections.sort(function (a, b) { return a - b; });

  // Build segments
  var segments = [];
  var pts = [0];
  for (var k = 0; k < intersections.length; k++) {
    pts.push(intersections[k]);
  }
  pts.push(1);

  for (var k = 0; k < pts.length - 1; k++) {
    var tA = pts[k];
    var tB = pts[k + 1];
    var midT = (tA + tB) / 2;
    var midPt = [p0[0] + dx * midT, p0[1] + dy * midT];
    if (pointInPolygon(midPt, ring)) {
      var sA = [p0[0] + dx * tA, p0[1] + dy * tA];
      var sB = [p0[0] + dx * tB, p0[1] + dy * tB];
      if (vecDist(sA, sB) > 0.01) {
        segments.push([sA, sB]);
      }
    }
  }

  return segments;
}
