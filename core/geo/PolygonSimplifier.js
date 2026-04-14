/**
 * PolygonSimplifier — polygon vertex reduction for urban block contours.
 *
 * Ported from U·B·SYSTEM React prototype (ub_system_proto3.jsx).
 * Adapted from {x, y} objects to [x, y] arrays.
 *
 * Safety: both strategies verify that removing a vertex doesn't push
 * the new edge outside the original polygon boundary (canRemove check).
 *
 * All inputs/outputs are [x, y] arrays (meters). Pure math, no dependencies.
 */

// ── Helpers ─────────────────────────────────────────────

function signedArea(ring) {
  var n = ring.length, area = 0;
  for (var i = 0; i < n; i++) { var j = (i + 1) % n; area += ring[i][0] * ring[j][1]; area -= ring[j][0] * ring[i][1]; }
  return area / 2;
}

function ensureCCW(ring) {
  if (signedArea(ring) < 0) { var r = []; for (var i = ring.length - 1; i >= 0; i--) r.push(ring[i]); return r; }
  return ring;
}

function ptIn(pt, poly) {
  var ins = false;
  for (var i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    var yi = poly[i][1], yj = poly[j][1];
    if (((yi > pt[1]) !== (yj > pt[1])) && (pt[0] < (poly[j][0] - poly[i][0]) * (pt[1] - yi) / (yj - yi) + poly[i][0])) ins = !ins;
  }
  return ins;
}

function triArea(a, b, c) {
  return Math.abs((b[0] - a[0]) * (c[1] - a[1]) - (c[0] - a[0]) * (b[1] - a[1])) / 2;
}

// ── Visvalingam-Whyatt with safety check ─────────────────

/**
 * Before removing a vertex, samples 5 points along the new edge
 * (prev → next) and verifies they all lie inside the original polygon.
 * If any sample exits, the vertex is skipped (not removed).
 */
export function simplifyVW(poly, minVerts) {
  if (poly.length <= minVerts) return poly.slice();
  var origPoly = poly;
  var pts = [];
  for (var i = 0; i < poly.length; i++) {
    pts.push({ pt: poly[i], idx: i, prev: (i - 1 + poly.length) % poly.length, next: (i + 1) % poly.length, area: 0, removed: false, skip: false });
  }
  function calcArea(i) { var p = pts[i]; if (p.removed) return Infinity; return triArea(pts[p.prev].pt, p.pt, pts[p.next].pt); }
  function canRemove(i) {
    var p = pts[i]; if (p.removed) return false;
    // Near-zero area triangle = truly collinear vertex, always safe to remove
    if (p.area < 0.1) return true;
    var prevPt = pts[p.prev].pt, nextPt = pts[p.next].pt;
    for (var t = 0.1; t <= 0.9; t += 0.2) {
      var sx = prevPt[0] + (nextPt[0] - prevPt[0]) * t;
      var sy = prevPt[1] + (nextPt[1] - prevPt[1]) * t;
      if (!ptIn([sx, sy], origPoly)) return false;
    }
    return true;
  }
  for (var i2 = 0; i2 < pts.length; i2++) pts[i2].area = calcArea(i2);
  var remaining = poly.length, stuckCount = 0;
  while (remaining > minVerts) {
    var minA = Infinity, minIdx = -1;
    for (var i3 = 0; i3 < pts.length; i3++) { if (!pts[i3].removed && !pts[i3].skip && pts[i3].area < minA) { minA = pts[i3].area; minIdx = i3; } }
    if (minIdx < 0) break;
    if (!canRemove(minIdx)) { pts[minIdx].skip = true; stuckCount++; if (stuckCount > remaining) break; continue; }
    stuckCount = 0;
    pts[minIdx].removed = true; remaining--;
    var prev2 = pts[minIdx].prev, next2 = pts[minIdx].next;
    pts[prev2].next = next2; pts[next2].prev = prev2;
    pts[prev2].area = calcArea(prev2); pts[prev2].skip = false;
    pts[next2].area = calcArea(next2); pts[next2].skip = false;
  }
  var result = [];
  for (var i4 = 0; i4 < pts.length; i4++) { if (!pts[i4].removed) result.push(pts[i4].pt); }
  return result;
}

// ── Area-controlled simplification ───────────────────────

export function simplifyPoly(poly, areaTol) {
  if (poly.length <= 3) return poly.slice();
  var ccw = ensureCCW(poly);
  var origArea = Math.abs(signedArea(ccw));
  if (origArea < 1e-6) return poly.slice();
  var best = poly.slice();
  for (var nv = 3; nv <= poly.length; nv++) {
    var s = simplifyVW(poly, nv);
    var sArea = Math.abs(signedArea(ensureCCW(s)));
    var err = Math.abs(sArea - origArea) / origArea;
    if (err <= areaTol) { best = s; break; }
  }
  return best;
}

// ── Collinear vertex removal (with safety check) ─────────

/**
 * Before removing a collinear vertex, checks that the midpoint of
 * the new edge (prev → next) lies inside the polygon. Prevents cuts
 * across concave regions.
 */
export function removeCollinear(poly, angleTol) {
  if (poly.length <= 3) return poly.slice();
  var result = [];
  for (var i = 0; i < poly.length; i++) {
    var prev = poly[(i - 1 + poly.length) % poly.length];
    var cur = poly[i];
    var next = poly[(i + 1) % poly.length];
    var d1x = cur[0] - prev[0], d1y = cur[1] - prev[1];
    var l1 = Math.sqrt(d1x * d1x + d1y * d1y);
    var d2x = next[0] - cur[0], d2y = next[1] - cur[1];
    var l2 = Math.sqrt(d2x * d2x + d2y * d2y);
    if (l1 < 1e-9 || l2 < 1e-9) { result.push(cur); continue; }
    var dot = Math.abs((d1x / l1) * (d2x / l2) + (d1y / l1) * (d2y / l2));
    if (dot < 1 - angleTol) { result.push(cur); continue; }
    // Collinear — check midpoint inside polygon (with small inward offset for boundary tolerance)
    var mid = [(prev[0] + next[0]) / 2, (prev[1] + next[1]) / 2];
    // Compute polygon centroid for inset direction
    var pcx = 0, pcy = 0;
    for (var pi = 0; pi < poly.length; pi++) { pcx += poly[pi][0]; pcy += poly[pi][1]; }
    pcx /= poly.length; pcy /= poly.length;
    var toCen = [pcx - mid[0], pcy - mid[1]];
    var tcLen = Math.sqrt(toCen[0] * toCen[0] + toCen[1] * toCen[1]);
    var eps = 0.01; // 1cm inset
    var testPt = tcLen > 1e-9 ? [mid[0] + toCen[0] / tcLen * eps, mid[1] + toCen[1] / tcLen * eps] : mid;
    if (!ptIn(testPt, poly)) { result.push(cur); continue; }
    // Safe to remove
  }
  return result.length >= 3 ? result : poly.slice();
}

// ── Combined pipeline ────────────────────────────────────

export function simplifyPolygon(poly, opts) {
  if (!opts) opts = {};
  var areaTol = opts.areaTol !== undefined ? opts.areaTol : 0.02;
  var collinearTol = opts.collinearTol !== undefined ? opts.collinearTol : 0.01;
  var origArea = Math.abs(signedArea(ensureCCW(poly)));
  var origCount = poly.length;
  var cleaned = removeCollinear(poly, collinearTol);
  var simplified = simplifyPoly(cleaned, areaTol);
  simplified = ensureCCW(simplified);
  var newArea = Math.abs(signedArea(simplified));
  var areaError = origArea > 1e-6 ? Math.abs(newArea - origArea) / origArea : 0;
  return { simplified: simplified, origCount: origCount, newCount: simplified.length, areaError: areaError };
}
