/**
 * GreenZone — compute usable open space inside an urban block.
 *
 * Green zone = blockPolygon \ (⋃ footprints) \ (⋃ fire buffers).
 * Pure math. No DOM / MapLibre. Inputs/outputs in local meter coords.
 *
 * Backed by polygon-clipping for the boolean difference. That library
 * handles self-intersections, overlapping clippers, and emits clean
 * rings (closed, CCW outer + CW holes).
 */

import polygonClipping from 'polygon-clipping';

// ── Area helpers ───────────────────────────────────────────

function ringArea(ring) {
  var n = ring.length;
  if (n < 3) return 0;
  var first = ring[0];
  var last = ring[n - 1];
  var closed = (last[0] === first[0] && last[1] === first[1]);
  var stop = closed ? n - 1 : n;
  var a = 0;
  for (var i = 0; i < stop; i++) {
    var j = (i + 1) % stop;
    a += ring[i][0] * ring[j][1] - ring[j][0] * ring[i][1];
  }
  return Math.abs(a) / 2;
}

function multiPolygonArea(mp) {
  // polygon-clipping format: MultiPolygon = [ [outerRing, ...holes], ... ]
  // Signed area handled via abs(); holes subtract from their parent's area.
  var total = 0;
  for (var i = 0; i < mp.length; i++) {
    var poly = mp[i];
    if (!poly || poly.length === 0) continue;
    var outer = ringArea(poly[0]);
    for (var h = 1; h < poly.length; h++) outer -= ringArea(poly[h]);
    if (outer > 0) total += outer;
  }
  return total;
}

// ── Conversion to polygon-clipping format ────────────────

/**
 * Wrap a simple polygon (outer ring only) in polygon-clipping's
 * per-polygon shape: [outerRing]. A MultiPolygon then wraps this
 * in one more array level: [[outerRing]].
 */
function polyToPC(polyM) {
  return [polyM];
}

// ── Public API ────────────────────────────────────────────

/**
 * Compute green zone = blockPolyM \ (⋃ subtractPolygonsM).
 *
 * @param {Array<[number,number]>} blockPolyM - block polygon in meters
 *   (open or closed ring, CCW preferred but not required)
 * @param {Array<Array<[number,number]>>} subtractPolygonsM - polygons
 *   to subtract (footprints, fire buffers, etc.)
 * @returns {{ multiPolygon: Array, area: number }}
 *   multiPolygon — polygon-clipping format (closed rings).
 *   area — sum of net areas in square meters.
 */
export function computeGreenZone(blockPolyM, subtractPolygonsM) {
  if (!blockPolyM || blockPolyM.length < 3) {
    return { multiPolygon: [], area: 0 };
  }

  var subject = [polyToPC(blockPolyM)];

  // Nothing to subtract — return block as-is.
  if (!subtractPolygonsM || subtractPolygonsM.length === 0) {
    var closed = blockPolyM.slice();
    var f = closed[0];
    var l = closed[closed.length - 1];
    if (f[0] !== l[0] || f[1] !== l[1]) closed.push([f[0], f[1]]);
    return { multiPolygon: [[closed]], area: ringArea(blockPolyM) };
  }

  var clippers = [];
  for (var i = 0; i < subtractPolygonsM.length; i++) {
    var sp = subtractPolygonsM[i];
    if (!sp || sp.length < 3) continue;
    clippers.push([polyToPC(sp)]);
  }

  if (clippers.length === 0) {
    var c2 = blockPolyM.slice();
    var f2 = c2[0], l2 = c2[c2.length - 1];
    if (f2[0] !== l2[0] || f2[1] !== l2[1]) c2.push([f2[0], f2[1]]);
    return { multiPolygon: [[c2]], area: ringArea(blockPolyM) };
  }

  // polygon-clipping takes (subject, ...clippers). Use apply to keep
  // ES5 style consistent with the rest of the codebase.
  var args = [subject];
  for (var k = 0; k < clippers.length; k++) args.push(clippers[k]);

  try {
    var result = polygonClipping.difference.apply(polygonClipping, args);
    return { multiPolygon: result, area: multiPolygonArea(result) };
  } catch (err) {
    // Degenerate geometry (collinear edges, zero-length segments) can
    // throw. Fall back to zero — caller decides how to surface this.
    return { multiPolygon: [], area: 0 };
  }
}
