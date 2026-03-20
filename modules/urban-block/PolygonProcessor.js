/**
 * PolygonProcessor — processes polygon into classified axes
 *
 * Pipeline:
 * 1. Extract edges from polygon ring (in meters)
 * 2. Merge collinear edges (angle tolerance)
 * 3. Assign lat/lon orientation (0=lat/EW, 1=lon/NS)
 * 4. Assign context (0=highway, 1=boundary, 2=internal) — placeholder
 * 5. Sort by priority (context → orientation → length)
 */

import {
  vecSub, vecNormalize, vecLength, vecDist,
  angleBetween, ringCentroid, pointInPolygon,
  vecPerp, vecScale, vecAdd
} from './geometry.js';

// ═══════════════════════════════════════════════════════
// Edge extraction
// ═══════════════════════════════════════════════════════

/**
 * Build edge list from a ring of meter coordinates.
 * Ring may be closed (first == last) or open.
 *
 * @param {Array<[number, number]>} ring
 * @param {boolean} isClosed
 * @returns {Array<Object>} edges
 */
export function buildEdges(ring, isClosed) {
  var edges = [];
  var n = ring.length;

  // If closed ring, skip the closing duplicate
  var count = n;
  if (isClosed && n > 1) {
    var first = ring[0];
    var last = ring[n - 1];
    if (Math.abs(first[0] - last[0]) < 0.01 && Math.abs(first[1] - last[1]) < 0.01) {
      count = n - 1;
    }
  }

  for (var i = 0; i < count - 1; i++) {
    var start = ring[i];
    var end = ring[i + 1];
    var length = vecDist(start, end);
    if (length > 0.1) {
      edges.push({
        id: i,
        start: [start[0], start[1]],
        end: [end[0], end[1]],
        length: length
      });
    }
  }

  // Close the ring for closed polygons
  if (isClosed && count >= 3) {
    var s = ring[count - 1];
    var e = ring[0];
    var l = vecDist(s, e);
    if (l > 0.1) {
      edges.push({
        id: count - 1,
        start: [s[0], s[1]],
        end: [e[0], e[1]],
        length: l
      });
    }
  }

  return edges;
}

// ═══════════════════════════════════════════════════════
// Merge collinear edges
// ═══════════════════════════════════════════════════════

/**
 * Merge collinear edges of a polygon.
 * If two adjacent edges form an angle < tolerance, the shared vertex is removed.
 *
 * Works on closed ring (coords[0] == coords[-1] after processing).
 *
 * @param {Array<[number, number]>} ring - points (no closing duplicate)
 * @param {number} [angleTolerance=5] degrees
 * @returns {Array<[number, number]>} simplified ring (no closing duplicate)
 */
export function mergeCollinearEdges(ring, angleTolerance) {
  if (angleTolerance === undefined) angleTolerance = 5.0;
  if (ring.length < 3) return ring;

  var n = ring.length;
  var keep = [];
  for (var i = 0; i < n; i++) {
    keep.push(true);
  }

  for (var i = 0; i < n; i++) {
    var prevIdx = (i - 1 + n) % n;
    var nextIdx = (i + 1) % n;

    var prev = ring[prevIdx];
    var curr = ring[i];
    var next = ring[nextIdx];

    var toPrev = vecSub(prev, curr);
    var toNext = vecSub(next, curr);
    var lenPrev = vecLength(toPrev);
    var lenNext = vecLength(toNext);

    if (lenPrev > 1e-6 && lenNext > 1e-6) {
      var angle = angleBetween(toPrev, toNext);
      if (angle <= angleTolerance) {
        keep[i] = false;
      }
    }
  }

  var merged = [];
  for (var i = 0; i < n; i++) {
    if (keep[i]) {
      merged.push(ring[i]);
    }
  }

  return merged;
}

// ═══════════════════════════════════════════════════════
// Orientation classification
// ═══════════════════════════════════════════════════════

/**
 * Assign lat/lon orientation to edges.
 * 0 = latitudinal (east-west, ~horizontal)
 * 1 = meridional (north-south, ~vertical)
 *
 * Y axis = north in meter space.
 *
 * @param {Array<Object>} edges
 * @returns {Array<Object>} edges with .orientation and .dotProduct
 */
export function assignOrientation(edges) {
  var north = [0, 1];

  for (var i = 0; i < edges.length; i++) {
    var edge = edges[i];
    var dir = vecNormalize(vecSub(edge.end, edge.start));
    var dot = Math.abs(vecSub([0, 0], [0, 0])[0]); // reset
    dot = Math.abs(north[0] * dir[0] + north[1] * dir[1]);

    if (dot >= 0.7) {
      edge.orientation = 1; // meridional (aligned with N-S)
    } else {
      edge.orientation = 0; // latitudinal (aligned with E-W)
    }
    edge.dotProduct = dot;
  }

  return edges;
}

// ═══════════════════════════════════════════════════════
// Context assignment
// ═══════════════════════════════════════════════════════

/**
 * Assign context to edges.
 * 0 = highway (магистраль)
 * 1 = boundary (граница)
 * 2 = internal (внутренняя)
 *
 * Placeholder logic — in production, context comes from external data.
 *
 * @param {Array<Object>} edges
 * @returns {Array<Object>}
 */
export function assignContext(edges) {
  if (edges.length >= 3) {
    edges[0].context = 0;
    edges[1].context = 1;
    edges[2].context = 2;
    for (var i = 3; i < edges.length; i++) {
      edges[i].context = 2;
    }
  } else {
    for (var i = 0; i < edges.length; i++) {
      edges[i].context = i % 3;
    }
  }
  return edges;
}

// ═══════════════════════════════════════════════════════
// Priority sorting
// ═══════════════════════════════════════════════════════

/**
 * Sort edges by priority:
 * 1. context (0 > 1 > 2) — lower value = higher priority
 * 2. orientation (meridional 1 > latitudinal 0)
 * 3. length (longer > shorter)
 *
 * @param {Array<Object>} edges
 * @returns {Array<Object>} sorted copy
 */
export function sortByPriority(edges) {
  var sorted = edges.slice();

  // Bubble sort (same as Python reference)
  var n = sorted.length;
  for (var i = 0; i < n; i++) {
    for (var j = 0; j < n - i - 1; j++) {
      var e1 = sorted[j];
      var e2 = sorted[j + 1];
      var swap = false;

      if (e1.context > e2.context) {
        swap = true;
      } else if (e1.context === e2.context) {
        if (e1.orientation < e2.orientation) {
          swap = true;
        } else if (e1.orientation === e2.orientation) {
          if (e1.length < e2.length) {
            swap = true;
          }
        }
      }

      if (swap) {
        sorted[j] = e2;
        sorted[j + 1] = e1;
      }
    }
  }

  return sorted;
}

// ═══════════════════════════════════════════════════════
// Offset vector computation
// ═══════════════════════════════════════════════════════

/**
 * Compute the offset vector (perpendicular, pointing inward) for each edge.
 * Uses polygon centroid to determine which side is "inside".
 *
 * @param {Array<Object>} edges
 * @param {Array<[number,number]>} ring - polygon ring in meters
 * @param {number} sectionWidth
 * @returns {Array<Object>} edges with .offsetVector, .offsetStart, .offsetEnd
 */
export function computeOffsetVectors(edges, ring, sectionWidth) {
  var center = ringCentroid(ring);

  for (var i = 0; i < edges.length; i++) {
    var edge = edges[i];
    var start = edge.start;
    var end = edge.end;
    var dir = vecNormalize(vecSub(end, start));
    var perp = vecPerp(dir); // [-dy, dx] — left side

    var mid = [(start[0] + end[0]) / 2, (start[1] + end[1]) / 2];
    var testP = vecAdd(mid, vecScale(perp, sectionWidth));
    var testN = vecAdd(mid, vecScale(perp, -sectionWidth));

    var inP = pointInPolygon(testP, ring);
    var inN = pointInPolygon(testN, ring);

    var ox, oy;
    if (inP) {
      ox = perp[0] * sectionWidth;
      oy = perp[1] * sectionWidth;
    } else if (inN) {
      ox = -perp[0] * sectionWidth;
      oy = -perp[1] * sectionWidth;
    } else {
      // Fallback: closer to centroid
      var dP = vecDist(testP, center);
      var dN = vecDist(testN, center);
      if (dP < dN) {
        ox = perp[0] * sectionWidth;
        oy = perp[1] * sectionWidth;
      } else {
        ox = -perp[0] * sectionWidth;
        oy = -perp[1] * sectionWidth;
      }
    }

    edge.offsetVector = [ox, oy];
    edge.offsetStart = [start[0] + ox, start[1] + oy];
    edge.offsetEnd = [end[0] + ox, end[1] + oy];
  }

  return edges;
}

// ═══════════════════════════════════════════════════════
// Check shared vertex (adjacency)
// ═══════════════════════════════════════════════════════

/**
 * Check if two edges share a vertex (are adjacent in the polygon)
 * @param {Object} edgeA
 * @param {Object} edgeB
 * @param {number} [tolerance=0.5]
 * @returns {boolean}
 */
export function edgesShareVertex(edgeA, edgeB, tolerance) {
  if (tolerance === undefined) tolerance = 0.5;

  var ptsA = [edgeA.start, edgeA.end];
  var ptsB = [edgeB.start, edgeB.end];

  for (var i = 0; i < ptsA.length; i++) {
    for (var j = 0; j < ptsB.length; j++) {
      if (Math.abs(ptsA[i][0] - ptsB[j][0]) < tolerance &&
          Math.abs(ptsA[i][1] - ptsB[j][1]) < tolerance) {
        return true;
      }
    }
  }
  return false;
}

// ═══════════════════════════════════════════════════════
// Full processing pipeline
// ═══════════════════════════════════════════════════════

/**
 * Process a polygon ring into classified, sorted edges.
 *
 * @param {Array<[number, number]>} ring - meter coordinates (no closing duplicate)
 * @param {boolean} isClosed
 * @param {number} sectionWidth
 * @returns {{ edges: Array<Object>, mergedRing: Array<[number, number]> }}
 */
export function processPolygon(ring, isClosed, sectionWidth) {
  var mergedRing = ring;
  if (isClosed) {
    mergedRing = mergeCollinearEdges(ring, 5.0);
  }

  var edges = buildEdges(mergedRing, isClosed);
  edges = assignOrientation(edges);
  edges = assignContext(edges);
  edges = computeOffsetVectors(edges, isClosed ? mergedRing : ring, sectionWidth);

  var sorted = sortByPriority(edges);

  return {
    edges: sorted,
    mergedRing: mergedRing
  };
}
