/**
 * Buffers — pure geometric computation of section/tower buffer zones.
 *
 * Single source of truth for buffer shapes. Renderers (MapLibre 2D
 * layer in modules/buffers, 3D overlay in OverlayMeshBuilder) call
 * these functions and format the result for their respective targets.
 *
 * All input/output in meters (local projection). No coordinate
 * conversion here — callers convert at the boundary.
 *
 * Buffer types:
 *   - fire  (14m): two rectangular strips from the long facade sides
 *                  of the section group. No end caps, no rounded corners.
 *   - insol (30m): capsule shape — two rectangular strips from the long
 *                  facade sides + two semicircular end caps at group ends.
 *   - end   (20m): rectangle with rounded corners on all 4 sides
 *                  (quarter arcs at each corner).
 *   - road  (14m): sharp-cornered offset rectangle, no rounding.
 *
 * The "long facade side" for a section group/tower is the side parallel
 * to the placement axis (edges [0]-[1] and [2]-[3] of the group rect,
 * where [0]-[1] runs along the axis).
 */

export var FIRE_DIST = 14;
export var END_DIST = 20;
export var INSOL_DIST = 30;
export var ROAD_DIST = 14;

// ── Geometric helpers (all in meters) ─────────────────────────────

function vAdd(a, b) { return [a[0] + b[0], a[1] + b[1]]; }
function vSub(a, b) { return [a[0] - b[0], a[1] - b[1]]; }
function vSc(v, s) { return [v[0] * s, v[1] * s]; }
function vLen(v) { return Math.sqrt(v[0] * v[0] + v[1] * v[1]); }

function polyCentroid(poly) {
  var cx = 0, cy = 0;
  for (var i = 0; i < poly.length; i++) { cx += poly[i][0]; cy += poly[i][1]; }
  return [cx / poly.length, cy / poly.length];
}

function outwardNormal(p1, p2, cx, cy) {
  var dx = p2[0] - p1[0], dy = p2[1] - p1[1];
  var len = Math.sqrt(dx * dx + dy * dy);
  if (len < 1e-10) return [0, 0];
  var nx = -dy / len, ny = dx / len;
  var mx = (p1[0] + p2[0]) / 2, my = (p1[1] + p2[1]) / 2;
  if (nx * (mx - cx) + ny * (my - cy) >= 0) return [nx, ny];
  return [-nx, -ny];
}

// ── Public geometry constructors ──────────────────────────────────

/**
 * Rectangle strip extending `dist` meters outward from edge (p1, p2).
 * Used for fire and insol side strips. 4 vertices, no rounded corners.
 */
export function edgeStrip(p1, p2, dist, cx, cy) {
  var n = outwardNormal(p1, p2, cx, cy);
  return [
    [p1[0], p1[1]],
    [p2[0], p2[1]],
    [p2[0] + n[0] * dist, p2[1] + n[1] * dist],
    [p1[0] + n[0] * dist, p1[1] + n[1] * dist]
  ];
}

/**
 * Sharp-cornered rectangular offset around polygon `poly`, offset
 * `dist` on all sides. For convex right-angled shapes (like the
 * group rectangle used for building buffers), each new vertex sits
 * where the two offset edges meet — the sum of the two adjacent
 * outward normals scaled by `dist`. No rounding.
 */
export function rectBufferPolygon(poly, dist) {
  var n = poly.length;
  if (n < 3) return poly;
  var c = polyCentroid(poly);
  var result = [];
  for (var i = 0; i < n; i++) {
    var prev = (i - 1 + n) % n;
    var nxt = (i + 1) % n;
    var n0 = outwardNormal(poly[prev], poly[i], c[0], c[1]);
    var n1 = outwardNormal(poly[i], poly[nxt], c[0], c[1]);
    result.push([
      poly[i][0] + (n0[0] + n1[0]) * dist,
      poly[i][1] + (n0[1] + n1[1]) * dist
    ]);
  }
  return result;
}

/**
 * Rounded rectangle around polygon `poly`, offset `dist` on all sides.
 * Each vertex of the input produces an arc in the output (segments
 * controls sampling density of each quarter-arc).
 */
export function roundedBufferPolygon(poly, dist, segments) {
  if (!segments) segments = 8;
  var n = poly.length;
  if (n < 3) return poly;
  var c = polyCentroid(poly);
  var result = [];
  for (var i = 0; i < n; i++) {
    var prev = (i - 1 + n) % n;
    var next = (i + 1) % n;
    var n0 = outwardNormal(poly[prev], poly[i], c[0], c[1]);
    var n1 = outwardNormal(poly[i], poly[next], c[0], c[1]);
    var a0 = Math.atan2(n0[1], n0[0]);
    var a1 = Math.atan2(n1[1], n1[0]);
    var da = a1 - a0;
    if (da > Math.PI) da -= 2 * Math.PI;
    if (da < -Math.PI) da += 2 * Math.PI;
    var px = poly[i][0], py = poly[i][1];
    if (Math.abs(da) < 0.01) {
      result.push([px + n0[0] * dist, py + n0[1] * dist]);
    } else {
      var segs = Math.max(2, Math.round(Math.abs(da) / (Math.PI / 2) * segments));
      for (var s = 0; s <= segs; s++) {
        var a = a0 + da * (s / segs);
        result.push([px + Math.cos(a) * dist, py + Math.sin(a) * dist]);
      }
    }
  }
  return result;
}

/**
 * Insolation buffer: TWO SEPARATE STRIPS along the long facade sides
 * of the group rectangle. Each strip is a width=sectionLen × height=dist
 * rectangle extending OUTWARD from one long side. The two OUTER corners
 * of each strip (the corners NOT on the facade) are rounded with a
 * decorative radius `cornerR` (default 3m). The two INNER corners on
 * the facade stay sharp. Strips do not extend past section ends along
 * the axis.
 *
 * @param {Array<[number,number]>} groupRect - [s0, s1, s1o, s0o] where
 *   edge [0]-[1] is one long side along the axis
 * @param {number} dist - strip depth in meters (distance from facade)
 * @param {number} [cornerR=3] - corner rounding radius in meters
 * @param {number} [segs=6] - samples per 90° quarter arc
 * @returns {Array<Array<[number,number]>>} array of 2 polygons
 */
export function insolStrips(groupRect, dist, cornerR, segs) {
  if (cornerR == null) cornerR = 3;
  if (segs == null) segs = 6;
  if (groupRect.length < 4) return [];
  if (dist <= 0) return [];
  // Clamp corner radius to strip dimensions (can't be larger than
  // half the shortest strip side).
  var s0 = groupRect[0];
  var s1 = groupRect[1];
  var s1o = groupRect[2];
  var s0o = groupRect[3];

  var axVec = vSub(s1, s0);
  var axLen = vLen(axVec);
  if (axLen < 1e-6) return [];

  var c = polyCentroid(groupRect);
  var nod = outwardNormal(s0, s1, c[0], c[1]);
  var od = outwardNormal(s1o, s0o, c[0], c[1]);

  var r = Math.min(cornerR, dist - 0.01, axLen / 2 - 0.01);
  if (r < 0.01) r = 0;

  function buildStrip(P0, P1, outDir) {
    // P0, P1 are facade endpoints (inner corners, kept sharp). Walk
    // direction along facade: P0 → P1. Local axDir = direction P0→P1.
    // outDir is outward normal (nod for side 0-1, od for side 2-3).
    // Outer corners: P1 + outDir·dist and P0 + outDir·dist, rounded.
    var sVec = vSub(P1, P0);
    var sLen = vLen(sVec);
    if (sLen < 1e-6) return [];
    var axLoc = [sVec[0] / sLen, sVec[1] / sLen];   // P0 → P1
    var negLoc = [-axLoc[0], -axLoc[1]];             // P1 → P0
    var rLoc = Math.min(r, dist - 0.01, sLen / 2 - 0.01);
    if (rLoc < 0.01) rLoc = 0;

    var out = [];
    // Inner corners on facade — sharp.
    out.push([P0[0], P0[1]]);
    out.push([P1[0], P1[1]]);

    if (rLoc === 0) {
      // No rounding — simple rectangle.
      out.push(vAdd(P1, vSc(outDir, dist)));
      out.push(vAdd(P0, vSc(outDir, dist)));
      return out;
    }

    // From P1, walk outward along outDir to (P1 + outDir·(dist-rLoc))
    out.push(vAdd(P1, vSc(outDir, dist - rLoc)));
    // Arc corner at P1: center = P1 + outDir·(dist-rLoc) + negLoc·rLoc
    // (rLoc inside from both outer edge and the P1 end).
    var cP1 = vAdd(vAdd(P1, vSc(outDir, dist - rLoc)), vSc(negLoc, rLoc));
    // Arc from direction +axLoc to direction +outDir (90° sweep CCW
    // relative to strip interior).
    for (var i = 1; i <= segs; i++) {
      var t = i / segs;
      var ang = t * Math.PI / 2;
      var ux = axLoc[0] * Math.cos(ang) + outDir[0] * Math.sin(ang);
      var uy = axLoc[1] * Math.cos(ang) + outDir[1] * Math.sin(ang);
      out.push([cP1[0] + ux * rLoc, cP1[1] + uy * rLoc]);
    }
    // Now at P1 + outDir·dist + negLoc·rLoc. Walk along outer edge
    // toward P0 end: stop at P0 + outDir·dist + axLoc·rLoc
    out.push(vAdd(vAdd(P0, vSc(outDir, dist)), vSc(axLoc, rLoc)));
    // Arc corner at P0: center = P0 + outDir·(dist-rLoc) + axLoc·rLoc
    var cP0 = vAdd(vAdd(P0, vSc(outDir, dist - rLoc)), vSc(axLoc, rLoc));
    // Arc from direction +outDir to direction +negLoc (90° sweep CCW).
    for (var j = 1; j <= segs; j++) {
      var t2 = j / segs;
      var ang2 = t2 * Math.PI / 2;
      var u2x = outDir[0] * Math.cos(ang2) + negLoc[0] * Math.sin(ang2);
      var u2y = outDir[1] * Math.cos(ang2) + negLoc[1] * Math.sin(ang2);
      out.push([cP0[0] + u2x * rLoc, cP0[1] + u2y * rLoc]);
    }
    // Arc ends at P0 + outDir·(dist-rLoc). Loop closes to P0.
    return out;
  }

  var stripNod = buildStrip(s0, s1, nod);
  var stripOd = buildStrip(s1o, s0o, od); // opposite long side, reverse order
  return [stripNod, stripOd];
}

// ── High-level per-group buffer builders ──────────────────────────

/**
 * Compute all 4 buffer types for one section/tower group.
 *
 * @param {Array<[number,number]>} groupRect - 4-vertex rectangle
 *   [[0]-[1]] is the long side along the placement axis.
 * @param {Object} [opts] - override distances
 * @returns {Array<{type, polygon}>} fire, insol, end, road
 */
export function buildGroupBuffers(groupRect, opts) {
  opts = opts || {};
  var fireD = opts.fire != null ? opts.fire : FIRE_DIST;
  var insolD = opts.insol != null ? opts.insol : INSOL_DIST;
  var endD = opts.end != null ? opts.end : END_DIST;
  var roadD = opts.road != null ? opts.road : ROAD_DIST;
  var insolCornerR = opts.insolCornerR != null ? opts.insolCornerR : 15;

  var c = polyCentroid(groupRect);
  var out = [];

  // Fire: two strips from long sides, no caps, no rounded corners.
  if (fireD > 0) {
    out.push({ type: 'fire', polygon: edgeStrip(groupRect[0], groupRect[1], fireD, c[0], c[1]) });
    out.push({ type: 'fire', polygon: edgeStrip(groupRect[2], groupRect[3], fireD, c[0], c[1]) });
  }

  // Insol: two separate strips from long facade sides with decorative
  // rounding at outer corners. Radius is parametric (default 3m).
  if (insolD > 0) {
    var strips = insolStrips(groupRect, insolD, insolCornerR, 6);
    for (var si = 0; si < strips.length; si++) {
      out.push({ type: 'insol', polygon: strips[si] });
    }
  }

  // End: rounded rectangle on all 4 sides.
  if (endD > 0) {
    out.push({ type: 'end', polygon: roundedBufferPolygon(groupRect, endD, 10) });
  }

  // Road: sharp-cornered rectangle offset, no rounding.
  if (roadD > 0) {
    out.push({ type: 'road', polygon: rectBufferPolygon(groupRect, roadD) });
  }

  return out;
}
