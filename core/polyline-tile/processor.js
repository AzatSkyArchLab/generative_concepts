/**
 * polyline-tile processor — pure STRUCTURE pass.
 *
 * Produces tiles for a polyline / polygon axis: outer cells, inner
 * cells, corridor cells, wedges at vertices (convex / reflex), and
 * remnant strips between grid edges and miter cuts. NO section
 * grouping happens here — grouping is a separate concern that can
 * be plugged in later (or replaced with a different strategy
 * altogether) without touching this file.
 *
 * Coordinate conventions:
 *   - Input  coords: [lng, lat] in WGS84 (from the feature geometry).
 *   - Output tile.cornersLngLat: array of [lng, lat] pairs.
 *   - Internal computation runs in METERS using a local tangent-plane
 *     projection (createProjection from core/geo/projection.js), with
 *     Y FLIPPED to match canvas-y-down convention so sign-sensitive
 *     formulas (signed area, inner normal, reflex vertex test, miter
 *     range) keep the simple form. Y is flipped back when writing
 *     corners out.
 *
 * Output schema:
 *   {
 *     tiles: Array<Tile>,
 *     edges: Array<{type, lengthM}>,
 *     vertices: Array<{lngLat, class, cosInterior, shifted}>
 *       (per-vertex diagnostic — `class` ∈ {'end', 'reflex',
 *       'obtuse-convex', 'acute-convex'}, `shifted` is true if the
 *       algorithm applied an edge-shift at this vertex's incoming edge)
 *     projection: { originLng, originLat }
 *   }
 *
 * Tile shape:
 *   {
 *     kind: 'cell' | 'wedge' | 'remnant' | 'corridor',
 *     row:  'outer' | 'corridor' | 'inner',
 *     type: 'lat' | 'lon' | 'wedge' | 'remnant',
 *     edgeIdx?, cellIdx?, vertexIdx?,
 *     cornersLngLat: Array<[lng, lat]>
 *   }
 *
 * No DOM, no THREE, no MapLibre. Caller (modules/polyline-tile) wires
 * the output to a render layer.
 */

import { createProjection } from '../geo/projection.js';

// ─── Tunable constants (mirror prototype) ──────────────────────────
var LAT_LON_THRESHOLD = 0.7;   // |dot with N| ≥ 0.7 → meridional
var MITER_EPS       = 0.5;     // m, miter range floating-point slack

// ===================================================================
// MAIN ENTRY
// ===================================================================

/**
 * @param {Array<[lng, lat]>} coords  feature geometry (LineString points
 *   for polyline-tile, polygon outer ring for polygon-tile)
 * @param {Object} tileParams         { step, depth, buffer, rows, side,
 *                                      postIter }
 * @param {'polyline'|'polygon'} mode
 * @param {number} [startSectionAt=0] flow-index where the first section
 *   starts. For polygon — index into flow; for polyline — always 0.
 * @returns {Object} { tiles, sections, edges, bounds, projection }
 */
export function processTileFeature(coords, tileParams, mode, startSectionAt) {
  if (!coords || coords.length < 2) return emptyResult();
  startSectionAt = startSectionAt || 0;
  var isPolygon = (mode === 'polygon');

  // Local projection centered on the first vertex. All internal math
  // runs in meters relative to this origin.
  var origin = coords[0];
  var proj = createProjection(origin[0], origin[1]);

  // Convert to internal pts (canvas-y-down). For a polygon ring,
  // drop the closing duplicate vertex if present.
  var ring = coords;
  if (isPolygon && ring.length >= 2) {
    var first = ring[0], last = ring[ring.length - 1];
    if (Math.abs(first[0] - last[0]) < 1e-9 && Math.abs(first[1] - last[1]) < 1e-9) {
      ring = ring.slice(0, -1);
    }
  }
  var pts = [];
  for (var i = 0; i < ring.length; i++) {
    var m = proj.toMeters(ring[i][0], ring[i][1]);
    // Y FLIP — convert math-y-up to canvas-y-down so the prototype's
    // sign conventions are preserved.
    pts.push({ x: m[0], y: -m[1] });
  }

  // Normalize polygon to CW in canvas (= CCW in math). Matches the
  // prototype's finish() routine.
  if (isPolygon && signedArea(pts) < 0) pts.reverse();

  // sideSign: for polygon, after CW-canvas normalization, inside = +1.
  // For polyline, follows the user's chosen extrusion side.
  var sideSign;
  if (isPolygon) sideSign = 1;
  else sideSign = (tileParams.side === 'right') ? 1 : -1;

  var step   = tileParams.step;
  var depth  = tileParams.depth;
  var buffer = tileParams.buffer;
  var rows   = tileParams.rows;

  // ─── Build tiles (cells + wedges + remnants + corridor) ───
  var built = buildTiles(pts, isPolygon, step, depth, buffer, rows, sideSign);
  var tilesXY = built.tiles;
  var vertexClasses = built.vertexClasses; // length = pts.length

  var edges = getEdges(pts, isPolygon);

  // ─── Section grouping (per straight edge) ───
  // A "triple" is one column: outer cell + corridor cell + inner cell.
  // lat → chunks of exactly 6 triples; lon → balanced 7..14-triple
  // sections. Triples not in any kept section are DROPPED — their
  // outer/corridor/inner cells are removed from the tile output.
  var sectionsXY = [];
  if (rows === 3) {
    var secResult = buildSections(edges, tilesXY, step, depth, buffer, sideSign, isPolygon);
    sectionsXY = secResult.sections;
    var vk = secResult.validKeys;
    var completeSet = secResult.completeSet;
    tilesXY = tilesXY.filter(function (t) {
      var isRegular = (t.kind === 'cell' || t.kind === 'corridor') &&
        t.edgeIdx != null && t.cellIdx != null && t.cellIdx >= 0;
      if (!isRegular) return true;  // keep wedges, remnants, extensions
      var key = t.edgeIdx + ':' + t.cellIdx;
      // Incomplete triples (outer-only cells near convex corners) are
      // structural — keep them; they're just not part of any section.
      if (!completeSet[key]) return true;
      // Complete-triple cells survive only if their triple is in a
      // kept section (drops section remainders).
      return vk[key] === true;
    });
  }

  // ─── Vertex diagnostic (which corners did the algorithm pick?) ───
  var nEdgesV = edges.length;
  var outVertices = new Array(pts.length);
  for (var vi = 0; vi < pts.length; vi++) {
    var pXY = pts[vi];
    var lngLatV = proj.toLngLat(pXY.x, -pXY.y);
    var vc = vertexClasses[vi] || { class: 'end', cosInterior: null, shifted: false, outerXY: null };
    var outerLngLat = null;
    if (vc.outerXY) {
      var oll = proj.toLngLat(vc.outerXY.x, -vc.outerXY.y);
      outerLngLat = [oll[0], oll[1]];
    }
    // Corner type from the two adjacent edges' axis types:
    //   lat → Ш (широтная), lon → М (меридиональная).
    // Ordered prev-edge → next-edge, e.g. 'Ш-М', 'М-Ш', 'Ш-Ш', 'М-М'.
    var cornerType = null;
    if (vc.class !== 'end') {
      var prevEi = isPolygon ? (vi - 1 + nEdgesV) % nEdgesV : (vi - 1);
      var nextEi = isPolygon ? (vi % nEdgesV) : vi;
      if (prevEi >= 0 && prevEi < nEdgesV && nextEi >= 0 && nextEi < nEdgesV) {
        var pT = (edges[prevEi].type === 'lat') ? 'Ш' : 'М';
        var nT = (edges[nextEi].type === 'lat') ? 'Ш' : 'М';
        cornerType = pT + '-' + nT;
      }
    }
    outVertices[vi] = {
      idx: vi,
      lngLat: [lngLatV[0], lngLatV[1]],
      outerLngLat: outerLngLat,
      class: vc.class,
      cosInterior: vc.cosInterior,
      shifted: !!vc.shifted,
      cornerType: cornerType
    };
  }

  // ─── Convert tile corners back to lng/lat ───
  var outTiles = new Array(tilesXY.length);
  for (var k = 0; k < tilesXY.length; k++) {
    var srcT = tilesXY[k];
    var cornersLngLat = new Array(srcT.corners.length);
    for (var c = 0; c < srcT.corners.length; c++) {
      var p = srcT.corners[c];
      // Y FLIP back to math-y-up before projection inversion.
      var lngLat = proj.toLngLat(p.x, -p.y);
      cornersLngLat[c] = [lngLat[0], lngLat[1]];
    }
    outTiles[k] = {
      kind: srcT.kind,
      row: srcT.row,
      type: srcT.type,
      edgeIdx: srcT.edgeIdx != null ? srcT.edgeIdx : undefined,
      cellIdx: srcT.cellIdx != null ? srcT.cellIdx : undefined,
      vertexIdx: srcT.vertexIdx != null ? srcT.vertexIdx : undefined,
      cornersLngLat: cornersLngLat
    };
  }

  // ─── Convert sections to lng/lat ───
  // Each section carries one OR more polygons (corner sections are
  // L-shaped = multiple polys). polygonsLngLat is an array of rings.
  var outSections = sectionsXY.map(function (s) {
    var polysLngLat = s.polys.map(function (ring) {
      return ring.map(function (p) {
        var ll = proj.toLngLat(p.x, -p.y);
        return [ll[0], ll[1]];
      });
    });
    var cll = proj.toLngLat(s.centroid.x, -s.centroid.y);
    return {
      type: s.type,
      isCorner: !!s.isCorner,
      tripleCount: s.tripleCount,
      areaRaw: s.areaRaw,
      areaLiving: s.areaLiving,
      polygonsLngLat: polysLngLat,
      centroidLngLat: [cll[0], cll[1]]
    };
  });

  return {
    tiles: outTiles,
    edges: edges.map(function (e) { return { type: e.type, lengthM: e.length }; }),
    vertices: outVertices,
    sections: outSections,
    projection: { originLng: origin[0], originLat: origin[1] }
  };
}

function emptyResult() {
  return { tiles: [], edges: [], vertices: [], sections: [], projection: null };
}

// ===================================================================
// GEOMETRY PRIMITIVES (canvas-y-down internal frame)
// ===================================================================

function segLength(a, b) {
  var dx = b.x - a.x, dy = b.y - a.y;
  return Math.sqrt(dx * dx + dy * dy);
}

function signedArea(pts) {
  var s = 0, n = pts.length;
  if (n < 3) return 0;
  for (var i = 0; i < n; i++) {
    var a = pts[i], b = pts[(i + 1) % n];
    s += (a.x * b.y - b.x * a.y);
  }
  return s / 2;
}

function lineIntersect(p1, p2, p3, p4) {
  var x1 = p1.x, y1 = p1.y, x2 = p2.x, y2 = p2.y;
  var x3 = p3.x, y3 = p3.y, x4 = p4.x, y4 = p4.y;
  var denom = (x1 - x2) * (y3 - y4) - (y1 - y2) * (x3 - x4);
  if (Math.abs(denom) < 1e-9) return null;
  var t = ((x1 - x3) * (y3 - y4) - (y1 - y3) * (x3 - x4)) / denom;
  return { x: x1 + t * (x2 - x1), y: y1 + t * (y2 - y1) };
}

function pointInPolygon(pt, poly) {
  var inside = false, n = poly.length;
  for (var i = 0, j = n - 1; i < n; j = i++) {
    var xi = poly[i].x, yi = poly[i].y;
    var xj = poly[j].x, yj = poly[j].y;
    var intersect = ((yi > pt.y) !== (yj > pt.y)) &&
      (pt.x < (xj - xi) * (pt.y - yi) / (yj - yi + 1e-12) + xi);
    if (intersect) inside = !inside;
  }
  return inside;
}

function tileCentroid(tile) {
  var c = tile.corners;
  var sx = 0, sy = 0;
  for (var i = 0; i < c.length; i++) { sx += c[i].x; sy += c[i].y; }
  return { x: sx / c.length, y: sy / c.length };
}

function polygonAreaM2(corners) {
  var s = 0, n = corners.length;
  for (var i = 0; i < n; i++) {
    var a = corners[i], b = corners[(i + 1) % n];
    s += a.x * b.y - b.x * a.y;
  }
  return Math.abs(s / 2);
}

// SAT — convex polygon overlap with epsilon to ignore shared edges.
function polygonsOverlap(polyA, polyB, eps) {
  function axes(poly) {
    var ax = [];
    for (var i = 0; i < poly.length; i++) {
      var p1 = poly[i], p2 = poly[(i + 1) % poly.length];
      var ex = p2.x - p1.x, ey = p2.y - p1.y;
      var nx = -ey, ny = ex;
      var len = Math.sqrt(nx * nx + ny * ny);
      if (len > 1e-9) ax.push({ x: nx / len, y: ny / len });
    }
    return ax;
  }
  function project(poly, ax) {
    var v0 = poly[0].x * ax.x + poly[0].y * ax.y;
    var mn = v0, mx = v0;
    for (var i = 1; i < poly.length; i++) {
      var v = poly[i].x * ax.x + poly[i].y * ax.y;
      if (v < mn) mn = v;
      if (v > mx) mx = v;
    }
    return { mn: mn, mx: mx };
  }
  var all = axes(polyA).concat(axes(polyB));
  for (var i = 0; i < all.length; i++) {
    var pa = project(polyA, all[i]);
    var pb = project(polyB, all[i]);
    if (pa.mx <= pb.mn + eps || pb.mx <= pa.mn + eps) return false;
  }
  return true;
}

// ===================================================================
// CLASSIFICATION
// ===================================================================

function classifySegment(a, b) {
  var dx = b.x - a.x, dy = b.y - a.y;
  var L = Math.sqrt(dx * dx + dy * dy);
  if (L < 1e-9) return 'lat';
  return (Math.abs(dy) / L >= LAT_LON_THRESHOLD) ? 'lon' : 'lat';
}

function getEdges(pts, isClosed) {
  var edges = [], n = pts.length;
  if (n < 2) return edges;
  for (var i = 0; i < n - 1; i++) {
    var a = pts[i], b = pts[i + 1];
    edges.push({ a: a, b: b, length: segLength(a, b), type: classifySegment(a, b) });
  }
  if (isClosed && n >= 3) {
    var aL = pts[n - 1], bL = pts[0];
    edges.push({ a: aL, b: bL, length: segLength(aL, bL), type: classifySegment(aL, bL) });
  }
  return edges;
}

// Cosine of the interior angle at a vertex (angle between vectors
// curr→prev and curr→next). Returns null for invalid configs.
//   cos == 1   → 0°    (fold-back, degenerate)
//   cos > 0    → acute  (< 90°)
//   cos == 0   → right  (= 90°)
//   cos < 0    → obtuse (> 90°)
//   cos == -1  → 180°   (straight line, no bend)
function cornerCosInterior(iV, pts) {
  var n = pts.length;
  if (n < 3) return null;
  var prev = pts[(iV - 1 + n) % n];
  var curr = pts[iV];
  var next = pts[(iV + 1) % n];
  var ax = prev.x - curr.x, ay = prev.y - curr.y;
  var bx = next.x - curr.x, by = next.y - curr.y;
  var la = Math.sqrt(ax * ax + ay * ay);
  var lb = Math.sqrt(bx * bx + by * by);
  if (la < 1e-9 || lb < 1e-9) return null;
  var c = (ax * bx + ay * by) / (la * lb);
  if (c >  1) c =  1;
  if (c < -1) c = -1;
  return c;
}

function isReflexVertex(iV, pts, sideSign, isClosed) {
  var n = pts.length;
  if (n < 3) return false;
  if (!isClosed && (iV === 0 || iV === n - 1)) return false;
  var prev = pts[(iV - 1 + n) % n];
  var curr = pts[iV];
  var next = pts[(iV + 1) % n];
  var ux = next.x - curr.x, uy = next.y - curr.y;
  var vx = prev.x - curr.x, vy = prev.y - curr.y;
  var cross = ux * vy - uy * vx;
  return (sideSign > 0) ? (cross < 0) : (cross > 0);
}

// ===================================================================
// MITER RANGE — per-edge range where offset(edge) IS part of the
// offset contour. Cells must lie within [tStart, tEnd] to be valid.
// ===================================================================

function computeMiterRange(edges, i, depth, sideSign, isClosed) {
  var n = edges.length;
  var a = edges[i].a, b = edges[i].b;
  var L = segLength(a, b);
  if (L < 1e-6) return null;
  var tx = (b.x - a.x) / L, ty = (b.y - a.y) / L;
  var nx = -ty * sideSign, ny = tx * sideSign;
  var oA = { x: a.x + nx * depth, y: a.y + ny * depth };
  var oB = { x: b.x + nx * depth, y: b.y + ny * depth };

  function offsetLineOf(ei) {
    var ea = edges[ei].a, eb = edges[ei].b;
    var EL = segLength(ea, eb);
    if (EL < 1e-9) return null;
    var etx = (eb.x - ea.x) / EL, ety = (eb.y - ea.y) / EL;
    var enx = -ety * sideSign, eny = etx * sideSign;
    return {
      a: { x: ea.x + enx * depth, y: ea.y + eny * depth },
      b: { x: eb.x + enx * depth, y: eb.y + eny * depth }
    };
  }
  function projOnTangent(pt) { return (pt.x - a.x) * tx + (pt.y - a.y) * ty; }

  var tStart = 0, tEnd = L;
  if (isClosed || i > 0) {
    var prevLine = offsetLineOf((i - 1 + n) % n);
    if (prevLine) {
      var m1 = lineIntersect(prevLine.a, prevLine.b, oA, oB);
      if (m1) tStart = projOnTangent(m1);
    }
  }
  if (isClosed || i < n - 1) {
    var nextLine = offsetLineOf((i + 1) % n);
    if (nextLine) {
      var m2 = lineIntersect(oA, oB, nextLine.a, nextLine.b);
      if (m2) tEnd = projOnTangent(m2);
    }
  }
  return { tStart: tStart, tEnd: tEnd };
}

// ===================================================================
// WEDGE BUILDERS
// ===================================================================

function buildWedgeAtVertex(iV, pts, edges, depth, sideSign) {
  var n = pts.length;
  var V = pts[iV];
  var prevIdx = (iV - 1 + n) % n;
  var prev = edges[prevIdx], curr = edges[iV];
  if (!prev || !curr) return null;
  var L_prev = segLength(prev.a, prev.b);
  var L_curr = segLength(curr.a, curr.b);
  if (L_prev < 1e-6 || L_curr < 1e-6) return null;

  var mr_prev = computeMiterRange(edges, prevIdx, depth, sideSign, true);
  var mr_curr = computeMiterRange(edges, iV,     depth, sideSign, true);
  if (!mr_prev || !mr_curr) return null;
  var t_prev_end   = Math.min(L_prev, mr_prev.tEnd);
  var t_curr_start = Math.max(0, mr_curr.tStart);
  if ((L_prev - t_prev_end) < 0.5 && t_curr_start < 0.5) return null;

  var ptx = (prev.b.x - prev.a.x) / L_prev;
  var pty = (prev.b.y - prev.a.y) / L_prev;
  var P_prev = { x: prev.a.x + ptx * t_prev_end, y: prev.a.y + pty * t_prev_end };

  var ctx = (curr.b.x - curr.a.x) / L_curr;
  var cty = (curr.b.y - curr.a.y) / L_curr;
  var P_curr = { x: curr.a.x + ctx * t_curr_start, y: curr.a.y + cty * t_curr_start };

  var pnx = -pty * sideSign, pny = ptx * sideSign;
  var cnx = -cty * sideSign, cny = ctx * sideSign;
  var prev_oA = { x: prev.a.x + pnx * depth, y: prev.a.y + pny * depth };
  var prev_oB = { x: prev.b.x + pnx * depth, y: prev.b.y + pny * depth };
  var curr_oA = { x: curr.a.x + cnx * depth, y: curr.a.y + cny * depth };
  var curr_oB = { x: curr.b.x + cnx * depth, y: curr.b.y + cny * depth };
  var M = lineIntersect(prev_oA, prev_oB, curr_oA, curr_oB);
  if (!M) return null;

  return {
    kind: 'wedge', row: 'outer', type: 'wedge',
    vertexIdx: iV, corners: [V, P_prev, M, P_curr]
  };
}

function buildReflexWedgeAtVertex(iV, pts, edges, depth, sideSign) {
  var n = pts.length;
  var V = pts[iV];
  var prevIdx = (iV - 1 + n) % n;
  var prev = edges[prevIdx], curr = edges[iV];
  if (!prev || !curr) return null;
  var L_prev = segLength(prev.a, prev.b);
  var L_curr = segLength(curr.a, curr.b);
  if (L_prev < 1e-6 || L_curr < 1e-6) return null;

  var ptx = (prev.b.x - prev.a.x) / L_prev;
  var pty = (prev.b.y - prev.a.y) / L_prev;
  var pnx = -pty * sideSign, pny = ptx * sideSign;
  var ctx = (curr.b.x - curr.a.x) / L_curr;
  var cty = (curr.b.y - curr.a.y) / L_curr;
  var cnx = -cty * sideSign, cny = ctx * sideSign;

  var P_in_prev = { x: V.x + pnx * depth, y: V.y + pny * depth };
  var P_in_curr = { x: V.x + cnx * depth, y: V.y + cny * depth };

  var prev_oA = { x: prev.a.x + pnx * depth, y: prev.a.y + pny * depth };
  var prev_oB = { x: prev.b.x + pnx * depth, y: prev.b.y + pny * depth };
  var curr_oA = { x: curr.a.x + cnx * depth, y: curr.a.y + cny * depth };
  var curr_oB = { x: curr.b.x + cnx * depth, y: curr.b.y + cny * depth };
  var M = lineIntersect(prev_oA, prev_oB, curr_oA, curr_oB);
  if (!M) return null;

  return {
    kind: 'wedge', row: 'outer', type: 'wedge',
    vertexIdx: iV, corners: [V, P_in_prev, M, P_in_curr]
  };
}

// Wedge between two offset rings (outer→inner). Used for inner row.
function buildOffsetRingWedge(iV, pts, edges, d_outer, d_inner, sideSign, rowLabel) {
  var n = pts.length;
  var prevIdx = (iV - 1 + n) % n;
  var prev = edges[prevIdx], curr = edges[iV];
  if (!prev || !curr) return null;
  var L_prev = segLength(prev.a, prev.b);
  var L_curr = segLength(curr.a, curr.b);
  if (L_prev < 1e-6 || L_curr < 1e-6) return null;

  var ptx = (prev.b.x - prev.a.x) / L_prev;
  var pty = (prev.b.y - prev.a.y) / L_prev;
  var pnx = -pty * sideSign, pny = ptx * sideSign;
  var ctx = (curr.b.x - curr.a.x) / L_curr;
  var cty = (curr.b.y - curr.a.y) / L_curr;
  var cnx = -cty * sideSign, cny = ctx * sideSign;

  function offLine(edge, nx, ny, d) {
    return {
      a: { x: edge.a.x + nx * d, y: edge.a.y + ny * d },
      b: { x: edge.b.x + nx * d, y: edge.b.y + ny * d }
    };
  }
  var po = offLine(prev, pnx, pny, d_outer);
  var pi = offLine(prev, pnx, pny, d_inner);
  var co = offLine(curr, cnx, cny, d_outer);
  var ci = offLine(curr, cnx, cny, d_inner);
  var M_outer = lineIntersect(po.a, po.b, co.a, co.b);
  var M_inner = lineIntersect(pi.a, pi.b, ci.a, ci.b);
  if (!M_outer || !M_inner) return null;

  var t_miter_prev = (M_inner.x - prev.a.x) * ptx + (M_inner.y - prev.a.y) * pty;
  var t_miter_curr = (M_inner.x - curr.a.x) * ctx + (M_inner.y - curr.a.y) * cty;
  var t_end_prev   = Math.min(L_prev, t_miter_prev);
  var t_start_curr = Math.max(0, t_miter_curr);

  var A = { x: prev.a.x + ptx * t_end_prev + pnx * d_outer, y: prev.a.y + pty * t_end_prev + pny * d_outer };
  var B = { x: curr.a.x + ctx * t_start_curr + cnx * d_outer, y: curr.a.y + cty * t_start_curr + cny * d_outer };
  var C = { x: curr.a.x + ctx * t_start_curr + cnx * d_inner, y: curr.a.y + cty * t_start_curr + cny * d_inner };
  var D = { x: prev.a.x + ptx * t_end_prev + pnx * d_inner, y: prev.a.y + pty * t_end_prev + pny * d_inner };

  return {
    kind: 'wedge', row: rowLabel, type: 'wedge',
    vertexIdx: iV, corners: [A, M_outer, B, C, M_inner, D]
  };
}

// Wedge clipped by a deeper offset (for corridor row).
function buildClippedRingWedge(iV, pts, edges, d_outer, d_inner, d_clip, sideSign, rowLabel) {
  var n = pts.length;
  var prevIdx = (iV - 1 + n) % n;
  var prev = edges[prevIdx], curr = edges[iV];
  if (!prev || !curr) return null;
  var L_prev = segLength(prev.a, prev.b);
  var L_curr = segLength(curr.a, curr.b);
  if (L_prev < 1e-6 || L_curr < 1e-6) return null;

  var ptx = (prev.b.x - prev.a.x) / L_prev;
  var pty = (prev.b.y - prev.a.y) / L_prev;
  var pnx = -pty * sideSign, pny = ptx * sideSign;
  var ctx = (curr.b.x - curr.a.x) / L_curr;
  var cty = (curr.b.y - curr.a.y) / L_curr;
  var cnx = -cty * sideSign, cny = ctx * sideSign;

  function offLine(edge, nx, ny, d) {
    return {
      a: { x: edge.a.x + nx * d, y: edge.a.y + ny * d },
      b: { x: edge.b.x + nx * d, y: edge.b.y + ny * d }
    };
  }
  var po_o = offLine(prev, pnx, pny, d_outer);
  var co_o = offLine(curr, cnx, cny, d_outer);
  var po_i = offLine(prev, pnx, pny, d_inner);
  var co_i = offLine(curr, cnx, cny, d_inner);
  var po_c = offLine(prev, pnx, pny, d_clip);
  var co_c = offLine(curr, cnx, cny, d_clip);
  var M_outer = lineIntersect(po_o.a, po_o.b, co_o.a, co_o.b);
  var M_inner = lineIntersect(po_i.a, po_i.b, co_i.a, co_i.b);
  var M_clip  = lineIntersect(po_c.a, po_c.b, co_c.a, co_c.b);
  if (!M_outer || !M_inner || !M_clip) return null;

  var t_miter_prev = (M_clip.x - prev.a.x) * ptx + (M_clip.y - prev.a.y) * pty;
  var t_miter_curr = (M_clip.x - curr.a.x) * ctx + (M_clip.y - curr.a.y) * cty;
  var t_end_prev   = Math.min(L_prev, t_miter_prev);
  var t_start_curr = Math.max(0, t_miter_curr);

  var A = { x: prev.a.x + ptx * t_end_prev + pnx * d_outer, y: prev.a.y + pty * t_end_prev + pny * d_outer };
  var B = { x: curr.a.x + ctx * t_start_curr + cnx * d_outer, y: curr.a.y + cty * t_start_curr + cny * d_outer };
  var C = { x: curr.a.x + ctx * t_start_curr + cnx * d_inner, y: curr.a.y + cty * t_start_curr + cny * d_inner };
  var D = { x: prev.a.x + ptx * t_end_prev + pnx * d_inner, y: prev.a.y + pty * t_end_prev + pny * d_inner };

  return {
    kind: 'wedge', row: rowLabel, type: 'wedge',
    vertexIdx: iV, corners: [A, M_outer, B, C, M_inner, D]
  };
}

// ===================================================================
// FILTERS
// ===================================================================

function filterByPriority(tiles) {
  var accepted = [];
  for (var i = 0; i < tiles.length; i++) {
    var t = tiles[i];
    if (t.kind !== 'cell') { accepted.push(t); continue; }
    var conflict = false;
    for (var j = 0; j < accepted.length; j++) {
      var a = accepted[j];
      if (a.kind !== 'cell') continue;
      if (polygonsOverlap(t.corners, a.corners, 1.0)) { conflict = true; break; }
    }
    if (!conflict) accepted.push(t);
  }
  return accepted;
}

function removeOverlappingTiles(tiles) {
  var n = tiles.length;
  var marked = new Array(n);
  for (var i = 0; i < n; i++) {
    if (tiles[i].kind !== 'cell') continue;
    for (var j = i + 1; j < n; j++) {
      if (tiles[j].kind !== 'cell') continue;
      if (polygonsOverlap(tiles[i].corners, tiles[j].corners, 0.5)) {
        marked[i] = true; marked[j] = true;
      }
    }
  }
  var out = [];
  for (var k = 0; k < n; k++) if (!marked[k]) out.push(tiles[k]);
  return out;
}

// ===================================================================
// MAIN TILE BUILDER
// ===================================================================

function buildTiles(pts, isPolygon, step, depth, buffer, rows, sideSign) {
  var edges = getEdges(pts, isPolygon);
  var nEdges = edges.length;
  // Vertex classification — one entry per pts[i]. Filled below in the
  // same loop that decides edge-shifts so the diagnostic exactly
  // matches the algorithm's actual treatment of each corner.
  //
  // Each entry also carries `outerXY` — the miter point on the OUTER
  // perimeter of the whole section (at distance = sectionDepth from
  // the axis). That's the "external" corner of the section, opposite
  // to V on the axis. Marking BOTH gives a complete picture: V is
  // the inner corner of the section, outerXY is the outer one, and
  // both share the same classification (their interior angle is the
  // same — parallel-line offset preserves angles).
  var sectionDepth = (rows === 3) ? (2 * depth + buffer) : depth;
  var vertexClasses = new Array(pts.length);
  for (var vci = 0; vci < pts.length; vci++) {
    vertexClasses[vci] = {
      class: 'end', cosInterior: null, shifted: false, outerXY: null
    };
  }
  if (nEdges === 0) return { tiles: [], vertexClasses: vertexClasses };

  // Row geometry. depth values are in METERS.
  var outerRow = { n0: 0, n1: depth, rowIdx: 0 };
  var innerRow = (rows === 3) ? {
    n0: depth + buffer, n1: 2 * depth + buffer, rowIdx: 2
  } : null;

  // Edge-shift policy: at REFLEX vertices the grid is shifted so the
  // LAST regular cell of EVERY row (outer / corridor / inner) ends
  // exactly at V. The sub-step leftover moves to the start of the
  // edge (where it becomes a green remnant if any). All rows share
  // the SAME shift — that keeps cells from different rows aligned
  // along the edge tangent, so the section reads as one neat run
  // of columns instead of a staircase.
  // Single shared shift array for all rows.
  var edgeShifts = new Array(nEdges).fill(0);
  // Classify EVERY vertex (including open polyline ends) so the
  // renderer can show, side-by-side, which corners the algorithm
  // treats as obtuse-convex vs. acute-convex vs. reflex vs. open end.
  for (var iV = 0; iV < pts.length; iV++) {
    // Default: open polyline end.
    var cls = 'end';
    var cosForOut = null;
    var isOpenEnd = (!isPolygon && (iV === 0 || iV === pts.length - 1));
    if (!isOpenEnd) {
      var cosA = cornerCosInterior(iV, pts);
      cosForOut = cosA;
      if (isReflexVertex(iV, pts, sideSign, isPolygon)) {
        cls = 'reflex';
      } else if (cosA != null && cosA <= 0) {
        cls = 'obtuse-convex';
      } else {
        cls = 'acute-convex';
      }
    }
    // Outer miter point of the WHOLE SECTION (rows=3 → 18 m offset by
    // default). For polyline open ends and degenerate corners this
    // stays null; otherwise it's the lng/lat of the section's outer
    // corner — the "opposite" point to V on the structure.
    var outerXY = null;
    if (!isOpenEnd) {
      var prevIdxC = (iV - 1 + pts.length) % pts.length;
      var nextIdxC = iV % nEdges;
      if (prevIdxC < nEdges && nextIdxC < nEdges) {
        var ep = edges[prevIdxC], en = edges[nextIdxC];
        var Lp = segLength(ep.a, ep.b), Ln = segLength(en.a, en.b);
        if (Lp > 1e-9 && Ln > 1e-9) {
          var ptxC = (ep.b.x - ep.a.x) / Lp, ptyC = (ep.b.y - ep.a.y) / Lp;
          var pnxC = -ptyC * sideSign, pnyC = ptxC * sideSign;
          var ntxC = (en.b.x - en.a.x) / Ln, ntyC = (en.b.y - en.a.y) / Ln;
          var nnxC = -ntyC * sideSign, nnyC = ntxC * sideSign;
          var op = {
            a: { x: ep.a.x + pnxC * sectionDepth, y: ep.a.y + pnyC * sectionDepth },
            b: { x: ep.b.x + pnxC * sectionDepth, y: ep.b.y + pnyC * sectionDepth }
          };
          var on = {
            a: { x: en.a.x + nnxC * sectionDepth, y: en.a.y + nnyC * sectionDepth },
            b: { x: en.b.x + nnxC * sectionDepth, y: en.b.y + nnyC * sectionDepth }
          };
          outerXY = lineIntersect(op.a, op.b, on.a, on.b);
        }
      }
    }
    vertexClasses[iV] = {
      class: cls, cosInterior: cosForOut, shifted: false, outerXY: outerXY
    };

    // Shared shift at reflex vertices (polyline AND polygon).
    if (!isPolygon && iV === 0) continue;
    var prevIdxR = (iV - 1 + pts.length) % pts.length;
    if (prevIdxR >= nEdges) continue;
    var Lp = edges[prevIdxR].length;
    if (cls === 'reflex') {
      var residual = Lp - Math.floor(Lp / step) * step;
      if (residual > 1e-6) {
        edgeShifts[prevIdxR] = residual;
        vertexClasses[iV].shifted = true;
      }
    }
  }

  // ─── OUTER ROW ───
  // Hard step, miter-clipped, lat→lon priority filter.
  var miterRangesOuter = [];
  for (var mi = 0; mi < nEdges; mi++) {
    miterRangesOuter.push(computeMiterRange(edges, mi, depth, sideSign, isPolygon));
  }
  var outerTiles = [];
  var passOrder = ['lat', 'lon'];
  for (var pi = 0; pi < passOrder.length; pi++) {
    var pass = passOrder[pi];
    for (var ei = 0; ei < nEdges; ei++) {
      if (edges[ei].type !== pass) continue;
      stampCellsAlongEdge(edges[ei], ei, edgeShifts[ei], step,
        outerRow.n0, outerRow.n1, sideSign, miterRangesOuter[ei],
        edges[ei].type, outerRow.rowIdx, 'outer', outerTiles);
    }
  }
  outerTiles = filterByPriority(outerTiles);

  // The outer row has NO corner-extension pass. Convex polyline
  // vertices are handled by miter clipping; reflex polyline vertices
  // have their outer-row pocket filled by the standard reflex wedge
  // (buildReflexWedgeAtVertex). The inner-row pocket at reflex
  // vertices, OTOH, is tiled with regular cells in a separate pass
  // (stampInnerRowExtensionsAtReflex) — see the INNER ROW block below.

  // ─── INNER ROW ───
  // Cells stamp with hard step, clipped by the SECTION OUTER miter
  // (offset = 2·depth+buffer). After that, at each REFLEX polyline
  // vertex, the inner-row wedge pocket is filled with regular cells
  // extending past V on each adjacent edge — so the corner doesn't
  // read as one mute purple polygon. The leftover dead-corner is
  // closed by a small "corner element" tile (see WEDGES below).
  var innerTiles = [];
  var miterRangesInner = null;
  var miterRangesCorridor = null;
  var reflexExtended = {};
  if (innerRow) {
    miterRangesInner = [];
    var dClip = 2 * depth + buffer;
    for (var mi2 = 0; mi2 < nEdges; mi2++) {
      miterRangesInner.push(computeMiterRange(edges, mi2, dClip, sideSign, isPolygon));
    }
    // Corridor-outer miter range (offset depth+buffer) — used to clip
    // inner-row extension cells past V at reflex vertices, so the
    // cell's inner short edge (which sits on this offset's contour)
    // fully lies on a valid stretch of that contour.
    miterRangesCorridor = [];
    var dCorridor = depth + buffer;
    for (var mi3 = 0; mi3 < nEdges; mi3++) {
      miterRangesCorridor.push(computeMiterRange(edges, mi3, dCorridor, sideSign, isPolygon));
    }
    for (var ei2 = 0; ei2 < nEdges; ei2++) {
      stampCellsAlongEdge(edges[ei2], ei2, edgeShifts[ei2], step,
        innerRow.n0, innerRow.n1, sideSign, miterRangesInner[ei2],
        edges[ei2].type, innerRow.rowIdx, 'inner', innerTiles);
    }
    // Fill the wedge pocket at each reflex vertex with extension cells.
    for (var iVx = 0; iVx < pts.length; iVx++) {
      if (vertexClasses[iVx].class !== 'reflex') continue;
      var did = stampInnerRowExtensionsAtReflex(iVx, pts, edges, step,
        innerRow.n0, innerRow.n1, sideSign, isPolygon,
        miterRangesCorridor, innerTiles);
      if (did) reflexExtended[iVx] = true;
    }
    innerTiles = filterByPriority(innerTiles);
  }

  // ─── WEDGES ───
  var wedgeTiles = [];
  var vStart = isPolygon ? 0 : 1;
  var vEnd   = isPolygon ? pts.length : pts.length - 1;
  for (var iV2 = vStart; iV2 < vEnd; iV2++) {
    var w;
    if (isReflexVertex(iV2, pts, sideSign, isPolygon)) {
      w = buildReflexWedgeAtVertex(iV2, pts, edges, depth, sideSign);
    } else {
      w = buildWedgeAtVertex(iV2, pts, edges, depth, sideSign);
    }
    if (w) wedgeTiles.push(w);
  }
  if (innerRow) {
    for (var iV3 = vStart; iV3 < vEnd; iV3++) {
      var cw = buildClippedRingWedge(iV3, pts, edges,
        depth, depth + buffer, 2 * depth + buffer, sideSign, 'corridor');
      if (cw) wedgeTiles.push(cw);
      if (reflexExtended[iV3]) {
        // Cells fill the inner-row strips up to the corridor outer
        // miter cut on each edge. The remaining "dead corner" between
        // both corridor-outer lines and both section-outer lines is
        // closed by one purple corner element — exactly the same role
        // the wedge plays at convex (red-dot) corners.
        var ce = buildSectionOuterCornerElement(iV3, pts, edges,
          depth, buffer, sideSign, isPolygon);
        if (ce) wedgeTiles.push(ce);
      } else {
        var iw = buildOffsetRingWedge(iV3, pts, edges,
          depth + buffer, 2 * depth + buffer, sideSign, 'inner');
        if (iw) wedgeTiles.push(iw);
      }
    }
  }

  // ─── CORRIDOR cells (rows=3 only) ───
  var corridorTiles = [];
  if (innerRow) {
    var d0 = depth, d1 = depth + buffer;
    for (var eiC = 0; eiC < nEdges; eiC++) {
      stampCellsAlongEdge(edges[eiC], eiC, edgeShifts[eiC], step,
        d0, d1, sideSign, miterRangesInner[eiC],
        edges[eiC].type, 1, 'corridor', corridorTiles, true /*isCorridor*/);
    }
  }

  // ─── REMNANTS (green non-standard strips at edge ends) ───
  // Each row's remnants use that row's grid shift, so the green
  // strip lands exactly where its row's cells DON'T quite reach.
  var remnants = [];
  buildRemnants(remnants, edges, edgeShifts, step, miterRangesOuter,
    0, depth, sideSign, isPolygon, 'outer');
  if (innerRow && miterRangesInner) {
    buildRemnants(remnants, edges, edgeShifts, step, miterRangesInner,
      depth, depth + buffer, sideSign, isPolygon, 'corridor');
    buildRemnants(remnants, edges, edgeShifts, step, miterRangesInner,
      depth + buffer, 2 * depth + buffer, sideSign, isPolygon, 'inner');
  }

  // Past-V remnants at reflex vertices: between the last inner-row
  // extension cell and the corridor-outer miter cut. Mirrors the
  // green sub-step strip that appears at convex (red-dot) corners,
  // just in the wedge-pocket area past V.
  if (innerRow && miterRangesCorridor) {
    for (var iVr = 0; iVr < pts.length; iVr++) {
      if (!reflexExtended[iVr]) continue;
      var prevIdxR2 = (iVr - 1 + pts.length) % pts.length;
      var nextIdxR2 = iVr % nEdges;
      buildReflexPastVRemnant(remnants, edges, prevIdxR2, miterRangesCorridor[prevIdxR2],
        step, depth + buffer, 2 * depth + buffer, sideSign, /*direction=*/+1, iVr);
      buildReflexPastVRemnant(remnants, edges, nextIdxR2, miterRangesCorridor[nextIdxR2],
        step, depth + buffer, 2 * depth + buffer, sideSign, /*direction=*/-1, iVr);
    }
  }

  // Combine all rows + wedges + remnants. No more extension cells.
  var allTiles = outerTiles.concat(innerTiles).concat(corridorTiles)
    .concat(wedgeTiles).concat(remnants);

  // For polygons — only keep tiles whose centroid is inside the
  // input polygon (filters wedges/cells that bow out).
  if (isPolygon) {
    allTiles = allTiles.filter(function (t) {
      if (t.kind === 'wedge') return true;  // wedges can hug the boundary
      return pointInPolygon(tileCentroid(t), pts);
    });
  }
  // Final safety pass against any residual overlaps between rows.
  // regular cell from a different row that might happen to cross.
  allTiles = filterByPriority(allTiles);

  return { tiles: allTiles, vertexClasses: vertexClasses };
}

// Stamp cells along one edge between [n0, n1] normal-band, with grid
// snapped by `shift`, then push into the `out` list. Cells are
// always step-wide rectangles (no truncation): if a cell's t1 would
// exceed mr.tEnd or t0 would precede mr.tStart, the cell is REJECTED.
// The resulting gap between the last regular cell and the miter cut
// is what buildRemnants paints as the green "non-standard" strip.
function stampCellsAlongEdge(edge, edgeIdx, shift, step, n0, n1, sideSign, mr, segType, rowIdx, rowLabel, out, isCorridor) {
  var a = edge.a, b = edge.b;
  var L = segLength(a, b);
  if (L < 1e-6) return;
  var tx = (b.x - a.x) / L, ty = (b.y - a.y) / L;
  var nx = -ty * sideSign, ny = tx * sideSign;
  var nCells = Math.floor((L - shift) / step);
  for (var k = 0; k < nCells; k++) {
    var t0 = shift + k * step;
    var t1 = shift + (k + 1) * step;
    if (mr) {
      if (t0 < mr.tStart - MITER_EPS) continue;
      if (t1 > mr.tEnd   + MITER_EPS) continue;
    }
    var p0 = { x: a.x + tx * t0 + nx * n0, y: a.y + ty * t0 + ny * n0 };
    var p1 = { x: a.x + tx * t1 + nx * n0, y: a.y + ty * t1 + ny * n0 };
    var p2 = { x: a.x + tx * t1 + nx * n1, y: a.y + ty * t1 + ny * n1 };
    var p3 = { x: a.x + tx * t0 + nx * n1, y: a.y + ty * t0 + ny * n1 };
    out.push({
      kind: isCorridor ? 'corridor' : 'cell',
      row: rowLabel,
      type: segType,
      edgeIdx: edgeIdx, cellIdx: k,
      t0: t0, t1: t1,   // stored so the corner-extension pass can chain
      corners: [p0, p1, p2, p3]
    });
  }
}

// At a REFLEX polyline vertex V, the inner row's wedge area (the deep
// pocket past V on cells side) is normally one big polygon. Instead
// we tile it with regular full-step cells extending past V along each
// adjacent edge's tangent, plus a single "corner element" closing the
// far corner. The result: the wedge area reads as a chain of regular
// cells, not one mute purple polygon.
function stampInnerRowExtensionsAtReflex(iV, pts, edges, step, n0, n1,
    sideSign, isPolygon, miterRangesCorridor, out) {
  var n = pts.length;
  if (!isPolygon && (iV === 0 || iV === n - 1)) return false;
  if (!isReflexVertex(iV, pts, sideSign, isPolygon)) return false;
  var nEdges = edges.length;
  var prevIdx = (iV - 1 + n) % n;
  var nextIdx = iV % nEdges;
  if (prevIdx >= nEdges || nextIdx >= nEdges) return false;
  var ep = edges[prevIdx], en = edges[nextIdx];
  var Lp = segLength(ep.a, ep.b), Ln = segLength(en.a, en.b);
  if (Lp < 1e-6 || Ln < 1e-6) return false;
  var ptx = (ep.b.x - ep.a.x) / Lp, pty = (ep.b.y - ep.a.y) / Lp;
  var pnx = -pty * sideSign, pny = ptx * sideSign;
  var ntx = (en.b.x - en.a.x) / Ln, nty = (en.b.y - en.a.y) / Ln;
  var nnx = -nty * sideSign, nny = ntx * sideSign;
  var mrPrev = miterRangesCorridor[prevIdx];
  var mrNext = miterRangesCorridor[nextIdx];
  var added = 0;

  // Extensions on PREV edge past V — cell's t-range must stay inside
  // prev's CORRIDOR-OUTER miter range, so the cell's inner short edge
  // (at n = depth+buffer, on the corridor-outer offset line) fully
  // lies on the valid stretch of that offset contour.
  if (mrPrev) {
    for (var ke = 0; ke < 50; ke++) {
      var t0 = Lp + ke * step;
      var t1 = t0 + step;
      if (t1 > mrPrev.tEnd + MITER_EPS) break;
      var p0 = { x: ep.a.x + ptx * t0 + pnx * n0, y: ep.a.y + pty * t0 + pny * n0 };
      var p1 = { x: ep.a.x + ptx * t1 + pnx * n0, y: ep.a.y + pty * t1 + pny * n0 };
      var p2 = { x: ep.a.x + ptx * t1 + pnx * n1, y: ep.a.y + pty * t1 + pny * n1 };
      var p3 = { x: ep.a.x + ptx * t0 + pnx * n1, y: ep.a.y + pty * t0 + pny * n1 };
      out.push({
        kind: 'cell', row: 'inner', type: ep.type,
        edgeIdx: prevIdx, cellIdx: -100 - ke,
        corners: [p0, p1, p2, p3]
      });
      added++;
    }
  }

  // Extensions on NEXT edge backward past V — cell's t-range must
  // stay inside next's corridor-outer miter range. For reflex this
  // miter range's tStart is negative (miter projects backward past V).
  if (mrNext) {
    for (var ke2 = 1; ke2 <= 50; ke2++) {
      var t1n = -(ke2 - 1) * step;
      var t0n = t1n - step;
      if (t0n < mrNext.tStart - MITER_EPS) break;
      var q0 = { x: en.a.x + ntx * t0n + nnx * n0, y: en.a.y + nty * t0n + nny * n0 };
      var q1 = { x: en.a.x + ntx * t1n + nnx * n0, y: en.a.y + nty * t1n + nny * n0 };
      var q2 = { x: en.a.x + ntx * t1n + nnx * n1, y: en.a.y + nty * t1n + nny * n1 };
      var q3 = { x: en.a.x + ntx * t0n + nnx * n1, y: en.a.y + nty * t0n + nny * n1 };
      out.push({
        kind: 'cell', row: 'inner', type: en.type,
        edgeIdx: nextIdx, cellIdx: -200 - ke2,
        corners: [q0, q1, q2, q3]
      });
      added++;
    }
  }
  return added > 0;
}

// ===================================================================
// SECTION GROUPING (greedy, straight edges)
// ===================================================================

// Walk each straight edge from start to end, grouping "triples"
// (outer + corridor + inner column) into sections.
//   lon (меридиональная): grow while areaRaw · LIVING_COEF ≤ MAX_LIVING.
//   lat (широтная): grow up to MAX_LAT_TRIPLES (6) triples.
// Each section gets a rectangle outline (t-range × full section depth)
// and a centroid for labelling. Returns sections in the XY frame.
var SECTION_LIVING_COEF = 0.65;
var SECTION_MAX_LIVING  = 550;   // m² of living area per section
var SECTION_LAT_LEN     = 6;     // EXACT triples in a latitudinal section
var SECTION_MIN_LON     = 7;     // min triples in a meridional section

// Partition T triples on ONE straight edge into section sizes.
//   lat: chunks of EXACTLY SECTION_LAT_LEN; trailing remainder dropped.
//   lon: balanced partition — fewest sections so each ≤ maxLon (area
//        limit), distributed as evenly as possible (differ by ≤ 1),
//        and each ≥ SECTION_MIN_LON. If T < SECTION_MIN_LON → no
//        sections (all dropped). This replaces the old greedy
//        "max + small tail" with an even split that avoids tiny
//        leftovers, per the user's distribution rule.
function partitionTriples(T, type, maxLon) {
  var parts = [];
  if (type === 'lat') {
    var K = Math.floor(T / SECTION_LAT_LEN);
    for (var g = 0; g < K; g++) parts.push(SECTION_LAT_LEN);
    return parts;
  }
  // lon
  if (T < SECTION_MIN_LON) return parts;        // too short → drop all
  var Kl = Math.ceil(T / maxLon);               // fewest sections (longest)
  // Keep each part ≥ SECTION_MIN_LON: if an even split would make a
  // part too short, drop to fewer sections (longer each).
  while (Kl > 1 && Math.floor(T / Kl) < SECTION_MIN_LON) Kl--;
  var base = Math.floor(T / Kl), extra = T % Kl;
  for (var g2 = 0; g2 < Kl; g2++) {
    parts.push(base + (g2 < extra ? 1 : 0));
  }
  return parts;
}

// ── Section geometry helpers ──

function polysCentroid(polys) {
  var sx = 0, sy = 0, n = 0;
  for (var i = 0; i < polys.length; i++) {
    for (var j = 0; j < polys[i].length; j++) {
      sx += polys[i][j].x; sy += polys[i][j].y; n++;
    }
  }
  return n ? { x: sx / n, y: sy / n } : { x: 0, y: 0 };
}

// Rectangle (full section depth) over a contiguous run of cells on one edge.
function runRect(edge, runCells, sideSign, sectionDepth) {
  var L = segLength(edge.a, edge.b);
  var tx = (edge.b.x - edge.a.x) / L, ty = (edge.b.y - edge.a.y) / L;
  var nx = -ty * sideSign, ny = tx * sideSign;
  var ax = edge.a.x, ay = edge.a.y;
  var t0 = runCells[0].t0, t1 = runCells[runCells.length - 1].t1;
  return [
    { x: ax + tx * t0 + nx * 0,            y: ay + ty * t0 + ny * 0 },
    { x: ax + tx * t1 + nx * 0,            y: ay + ty * t1 + ny * 0 },
    { x: ax + tx * t1 + nx * sectionDepth, y: ay + ty * t1 + ny * sectionDepth },
    { x: ax + tx * t0 + nx * sectionDepth, y: ay + ty * t0 + ny * sectionDepth }
  ];
}

// Single L-shaped outer outline ring for a corner section spanning
// edge0 (cells cc0 up to the vertex) and edge1 (cells cc1 from the
// vertex). Hexagon: inner along edge0 → V → inner along edge1 → outer
// end cap → section-outer corner (M) → back along edge0 outer. One
// clean ring = no internal seams when stroked.
function cornerOutline(e0, e1, cc0, cc1, sideSign, sd) {
  if (!cc0.length || !cc1.length) return null;
  var L0 = segLength(e0.a, e0.b), L1 = segLength(e1.a, e1.b);
  if (L0 < 1e-6 || L1 < 1e-6) return null;
  var t0x = (e0.b.x - e0.a.x) / L0, t0y = (e0.b.y - e0.a.y) / L0;
  var n0x = -t0y * sideSign, n0y = t0x * sideSign;
  var t1x = (e1.b.x - e1.a.x) / L1, t1y = (e1.b.y - e1.a.y) / L1;
  var n1x = -t1y * sideSign, n1y = t1x * sideSign;
  function p0(t, n) { return { x: e0.a.x + t0x * t + n0x * n, y: e0.a.y + t0y * t + n0y * n }; }
  function p1(t, n) { return { x: e1.a.x + t1x * t + n1x * n, y: e1.a.y + t1y * t + n1y * n }; }
  var a0 = cc0[0].t0;                       // corner cells start on edge0
  var b1 = cc1[cc1.length - 1].t1;          // corner cells end on edge1
  var A = p0(a0, 0);                         // edge0 inner start
  var Vp = p0(L0, 0);                        // vertex (inner kink)
  var C = p1(b1, 0);                         // edge1 inner end
  var D = p1(b1, sd);                        // edge1 outer end
  var F = p0(a0, sd);                        // edge0 outer start
  // Section-outer corner: where edge0 & edge1 outer offsets meet.
  var M = lineIntersect(p0(0, sd), p0(L0, sd), p1(0, sd), p1(L1, sd));
  if (M) return [A, Vp, C, D, M, F];
  return [A, Vp, C, D, p1(0, sd), p0(L0, sd), F];
}

// Corner element polygons + total area at vertex iV (wedges + remnants).
function cornerElementTiles(tilesXY, iV) {
  var polys = [], area = 0;
  for (var i = 0; i < tilesXY.length; i++) {
    var t = tilesXY[i];
    if (t.vertexIdx !== iV) continue;
    if (t.kind !== 'wedge' && t.kind !== 'remnant') continue;
    polys.push(t.corners);
    area += polygonAreaM2(t.corners);
  }
  return { polys: polys, area: area };
}

// A section "triple" requires BOTH an outer cell and an inner cell at
// the same edge:cellIdx. Near convex corners the outer row reaches
// closer to the vertex than the inner row (different miters), so some
// outer cells have NO inner partner — those are INCOMPLETE triples and
// must NOT be grouped into sections (otherwise the full-depth section
// rect overshoots into the corner). Returns:
//   byEdge  — complete-triple outer cells per edge (sorted by t0)
//   complete — set "edge:cellIdx" → true for every complete triple
function computeTripleSets(tilesXY) {
  var outerCell = {}, innerSet = {};
  for (var i = 0; i < tilesXY.length; i++) {
    var t = tilesXY[i];
    if (t.cellIdx == null || t.cellIdx < 0) continue;
    var key = t.edgeIdx + ':' + t.cellIdx;
    if (t.kind === 'cell' && t.row === 'outer' && t.t0 != null) outerCell[key] = t;
    else if (t.kind === 'cell' && t.row === 'inner') innerSet[key] = true;
  }
  var complete = {}, byEdge = {};
  for (var k in outerCell) {
    if (!innerSet[k]) continue;             // incomplete triple → skip
    complete[k] = true;
    var c = outerCell[k];
    (byEdge[c.edgeIdx] = byEdge[c.edgeIdx] || []).push(c);
  }
  for (var e in byEdge) {
    byEdge[e].sort(function (a, b) { return a.t0 - b.t0; });
  }
  return { byEdge: byEdge, complete: complete };
}

function sumSizes(parts) { var s = 0; for (var i = 0; i < parts.length; i++) s += parts[i]; return s; }
function variance(arr) {
  if (!arr.length) return 0;
  var m = 0, i; for (i = 0; i < arr.length; i++) m += arr[i]; m /= arr.length;
  var v = 0; for (i = 0; i < arr.length; i++) { var d = arr[i] - m; v += d * d; }
  return v / arr.length;
}

// Returns { sections, validKeys }. Dispatches to the one-corner path for
// a 2-edge polyline, otherwise per-edge straight grouping.
function buildSections(edges, tilesXY, step, depth, buffer, sideSign, isPolygon) {
  var sectionDepth = 2 * depth + buffer;
  var tripleArea = step * sectionDepth;
  var maxLon = Math.max(1, Math.floor(SECTION_MAX_LIVING / (tripleArea * SECTION_LIVING_COEF)));
  var ts = computeTripleSets(tilesXY);
  var byEdge = ts.byEdge;
  var ctx = {
    edges: edges, tilesXY: tilesXY, sideSign: sideSign,
    sectionDepth: sectionDepth, tripleArea: tripleArea, maxLon: maxLon, byEdge: byEdge
  };
  var result = null;
  if (!isPolygon && edges.length === 2 &&
      byEdge[0] && byEdge[0].length && byEdge[1] && byEdge[1].length) {
    result = buildSectionsOneCorner(ctx);
  }
  if (!result) result = buildSectionsPerEdge(ctx);
  result.completeSet = ts.complete;
  return result;
}

// Per-edge straight grouping (no cross-edge corner sections).
function buildSectionsPerEdge(ctx) {
  var sections = [], validKeys = {};
  var edges = ctx.edges, byEdge = ctx.byEdge, tripleArea = ctx.tripleArea;
  for (var ei = 0; ei < edges.length; ei++) {
    var cells = byEdge[ei];
    if (!cells || cells.length === 0) continue;
    var type = edges[ei].type;
    var parts = partitionTriples(cells.length, type, ctx.maxLon);
    var idx = 0;
    for (var pp = 0; pp < parts.length; pp++) {
      var run = cells.slice(idx, idx + parts[pp]); idx += parts[pp];
      if (!run.length) continue;
      var rect = runRect(edges[ei], run, ctx.sideSign, ctx.sectionDepth);
      var areaRaw = run.length * tripleArea;
      sections.push({
        type: type, tripleCount: run.length,
        areaRaw: areaRaw, areaLiving: areaRaw * SECTION_LIVING_COEF,
        polys: [rect], centroid: polysCentroid([rect])
      });
      for (var gc = 0; gc < run.length; gc++) validKeys[ei + ':' + run[gc].cellIdx] = true;
    }
  }
  return { sections: sections, validKeys: validKeys };
}

// Choose how many lon cells M go into the corner section vs. the
// straight lon sections on the remaining (C - M) cells. Balances
// section areas while keeping the corner ≤ 550 living and minimising
// dropped cells. baseArea = fixed corner area (1 lat triple + corner
// element geometry) for Ш-М/М-Ш.
function chooseLonSplit(C, baseArea, tripleArea, maxLon) {
  var maxLivingRaw = SECTION_MAX_LIVING / SECTION_LIVING_COEF;
  var maxM = Math.floor((maxLivingRaw - baseArea) / tripleArea);
  maxM = Math.min(maxM, C);
  if (maxM < 1) { maxM = (C >= 1) ? 1 : 0; }
  if (maxM < 1) return null;
  var best = null, bestScore = Infinity;
  for (var M = 1; M <= maxM; M++) {
    var rem = C - M;
    var parts = partitionTriples(rem, 'lon', maxLon);
    var dropped = rem - sumSizes(parts);
    var areas = [baseArea + M * tripleArea];
    for (var i = 0; i < parts.length; i++) areas.push(parts[i] * tripleArea);
    var score = dropped * 1e7 + variance(areas);
    if (score < bestScore) { bestScore = score; best = { M: M, parts: parts }; }
  }
  return best;
}

// М-М: choose M0 (edge0 tail) and M1 (edge1 head) into the corner.
function chooseMmSplit(C0, C1, cornerArea, tripleArea, maxLon) {
  var best = null, bestScore = Infinity;
  for (var M0 = 1; M0 <= C0; M0++) {
    for (var M1 = 1; M1 <= C1; M1++) {
      var area = cornerArea + (M0 + M1) * tripleArea;
      if (area * SECTION_LIVING_COEF > SECTION_MAX_LIVING) break;  // M1 too big
      var p0 = partitionTriples(C0 - M0, 'lon', maxLon);
      var p1 = partitionTriples(C1 - M1, 'lon', maxLon);
      var dropped = (C0 - M0 - sumSizes(p0)) + (C1 - M1 - sumSizes(p1));
      var areas = [area], i;
      for (i = 0; i < p0.length; i++) areas.push(p0[i] * tripleArea);
      for (i = 0; i < p1.length; i++) areas.push(p1[i] * tripleArea);
      var score = dropped * 1e7 + variance(areas);
      if (score < bestScore) { bestScore = score; best = { M0: M0, M1: M1, parts0: p0, parts1: p1 }; }
    }
  }
  return best;
}

// One interior corner (2 edges). Forms cross-edge corner sections per
// the Ш-Ш / Ш-М / М-Ш / М-М rules. Returns null if the corner can't be
// assembled (caller falls back to per-edge for now; rounded-buffer
// break is a later step).
function buildSectionsOneCorner(ctx) {
  var edges = ctx.edges, byEdge = ctx.byEdge;
  var cells0 = byEdge[0], cells1 = byEdge[1];
  var C0 = cells0.length, C1 = cells1.length;
  var type0 = edges[0].type, type1 = edges[1].type;
  var tripleArea = ctx.tripleArea, maxLon = ctx.maxLon, sideSign = ctx.sideSign, sd = ctx.sectionDepth;
  var corner = cornerElementTiles(ctx.tilesXY, 1);
  var cornerTypeStr = (type0 === 'lat' ? 'Ш' : 'М') + '-' + (type1 === 'lat' ? 'Ш' : 'М');

  var sections = [], validKeys = {};
  function markRun(edgeIdx, run) { for (var i = 0; i < run.length; i++) validKeys[edgeIdx + ':' + run[i].cellIdx] = true; }
  function pushRun(edgeIdx, run, type) {
    if (!run.length) return;
    var rect = runRect(edges[edgeIdx], run, sideSign, sd);
    var areaRaw = run.length * tripleArea;
    sections.push({
      type: type, tripleCount: run.length,
      areaRaw: areaRaw, areaLiving: areaRaw * SECTION_LIVING_COEF,
      polys: [rect], centroid: polysCentroid([rect])
    });
    markRun(edgeIdx, run);
  }
  // alignEnd=true → sections abut the END of cellList (the corner is at
  // the far end), so any dropped sub-section cells fall at the START
  // (the open polyline end). This pulls sections tight against the
  // corner instead of leaving a gap there.
  function pushParts(edgeIdx, cellList, type, parts, alignEnd) {
    var S = sumSizes(parts);
    var idx = alignEnd ? (cellList.length - S) : 0;
    if (idx < 0) idx = 0;
    for (var pp = 0; pp < parts.length; pp++) {
      pushRun(edgeIdx, cellList.slice(idx, idx + parts[pp]), type);
      idx += parts[pp];
    }
  }
  function emitStraight(edgeIdx, cellList, type, alignEnd) {
    pushParts(edgeIdx, cellList, type, partitionTriples(cellList.length, type, maxLon), alignEnd);
  }
  function pushCorner(cc0, cc1) {
    // Single L-shaped ring (clean outer contour, no seams). Fall back
    // to the multi-poly union if the outline can't be built.
    var outline = cornerOutline(edges[0], edges[1], cc0, cc1, sideSign, sd);
    var polys;
    if (outline) {
      polys = [outline];
    } else {
      polys = [];
      if (cc0.length) polys.push(runRect(edges[0], cc0, sideSign, sd));
      if (cc1.length) polys.push(runRect(edges[1], cc1, sideSign, sd));
      for (var i = 0; i < corner.polys.length; i++) polys.push(corner.polys[i]);
    }
    if (!polys.length) return;
    var nCells = cc0.length + cc1.length;
    var areaRaw = nCells * tripleArea + corner.area;
    sections.push({
      type: cornerTypeStr, isCorner: true, tripleCount: nCells + 1,
      areaRaw: areaRaw, areaLiving: areaRaw * SECTION_LIVING_COEF,
      polys: polys, centroid: polysCentroid(polys)
    });
    markRun(0, cc0); markRun(1, cc1);
  }

  if (type0 === 'lat' && type1 === 'lat') {
    // Ш-Ш: a + corner(1) + b = 6, a,b ∈ [1,4], minimise dropped.
    var bestA = -1, bestDrop = Infinity;
    for (var a = 1; a <= 4; a++) {
      var b = 5 - a;
      if (b < 1 || b > 4 || a > C0 || b > C1) continue;
      var drop = ((C0 - a) % 6) + ((C1 - b) % 6);
      if (drop < bestDrop) { bestDrop = drop; bestA = a; }
    }
    if (bestA < 0) return null;
    var aa = bestA, bb = 5 - aa;
    // edge0 is BEFORE the corner → align sections to its end (corner);
    // edge1 is AFTER → align to its start (corner). Dropped cells fall
    // on the open ends, never between a section and the corner.
    emitStraight(0, cells0.slice(0, C0 - aa), 'lat', true);
    emitStraight(1, cells1.slice(bb), 'lat', false);
    pushCorner(cells0.slice(C0 - aa), cells1.slice(0, bb));
  } else if (type0 === 'lat' && type1 === 'lon') {
    // Ш-М: 1 lat + corner + M lon.
    emitStraight(0, cells0.slice(0, C0 - 1), 'lat', true);
    var rL = chooseLonSplit(C1, tripleArea + corner.area, tripleArea, maxLon);
    if (!rL) return null;
    pushCorner(cells0.slice(C0 - 1), cells1.slice(0, rL.M));
    pushParts(1, cells1.slice(rL.M), 'lon', rL.parts, false);
  } else if (type0 === 'lon' && type1 === 'lat') {
    // М-Ш: M lon + corner + 1 lat.
    emitStraight(1, cells1.slice(1), 'lat', false);
    var rL2 = chooseLonSplit(C0, tripleArea + corner.area, tripleArea, maxLon);
    if (!rL2) return null;
    pushParts(0, cells0.slice(0, C0 - rL2.M), 'lon', rL2.parts, true);
    pushCorner(cells0.slice(C0 - rL2.M), cells1.slice(0, 1));
  } else {
    // М-М: corner + lon both sides.
    var rMM = chooseMmSplit(C0, C1, corner.area, tripleArea, maxLon);
    if (!rMM) return null;
    pushParts(0, cells0.slice(0, C0 - rMM.M0), 'lon', rMM.parts0, true);
    pushParts(1, cells1.slice(rMM.M1), 'lon', rMM.parts1, false);
    pushCorner(cells0.slice(C0 - rMM.M0), cells1.slice(0, rMM.M1));
  }

  return { sections: sections, validKeys: validKeys };
}

// Closes the dead corner past the two extension chains: a quad whose
// sides are
//   prev-side  — perpendicular to prev's tangent at the prev's
//                corridor-outer miter t (where prev cells/remnants end);
//   prev-far   — prev's section-outer offset line;
//   next-far   — next's section-outer offset line;
//   next-side  — perpendicular to next's tangent at the next's
//                corridor-outer miter t (where next cells/remnants end).
// Corners: A = M_corridor_outer (where the two corridor-outer offset
// lines meet); B = A + depth * prev's outward normal (= prev's section
// outer at t = miter_corridor_prev); C = M_section_outer; D = A + depth *
// next's outward normal.
// For a 90° reflex with defaults this collapses to a depth×depth square,
// same as before — but for other angles the prev-side and next-side
// edges are PERPENDICULARS to the edge tangents, NOT the OTHER edge's
// corridor-outer offset line. That keeps the quad from straying into
// the cells/remnants area on either side.
function buildSectionOuterCornerElement(iV, pts, edges, depth, buffer, sideSign, isPolygon) {
  var n = pts.length;
  if (!isPolygon && (iV === 0 || iV === n - 1)) return null;
  var prevIdx = (iV - 1 + n) % n;
  var nextIdx = iV % edges.length;
  if (prevIdx >= edges.length || nextIdx >= edges.length) return null;
  var ep = edges[prevIdx], en = edges[nextIdx];
  var Lp = segLength(ep.a, ep.b), Ln = segLength(en.a, en.b);
  if (Lp < 1e-6 || Ln < 1e-6) return null;
  var ptx = (ep.b.x - ep.a.x) / Lp, pty = (ep.b.y - ep.a.y) / Lp;
  var pnx = -pty * sideSign, pny = ptx * sideSign;
  var ntx = (en.b.x - en.a.x) / Ln, nty = (en.b.y - en.a.y) / Ln;
  var nnx = -nty * sideSign, nny = ntx * sideSign;
  var dCorr = depth + buffer;
  var dSect = 2 * depth + buffer;
  // Offset(corridor-outer) intersection — corner where prev and next
  // corridor-outer offset lines meet.
  var po_corr = {
    a: { x: ep.a.x + pnx * dCorr, y: ep.a.y + pny * dCorr },
    b: { x: ep.b.x + pnx * dCorr, y: ep.b.y + pny * dCorr }
  };
  var no_corr = {
    a: { x: en.a.x + nnx * dCorr, y: en.a.y + nny * dCorr },
    b: { x: en.b.x + nnx * dCorr, y: en.b.y + nny * dCorr }
  };
  var M_corr = lineIntersect(po_corr.a, po_corr.b, no_corr.a, no_corr.b);
  // Offset(section-outer) intersection — M_section, the green-ring point.
  var po_sect = {
    a: { x: ep.a.x + pnx * dSect, y: ep.a.y + pny * dSect },
    b: { x: ep.b.x + pnx * dSect, y: ep.b.y + pny * dSect }
  };
  var no_sect = {
    a: { x: en.a.x + nnx * dSect, y: en.a.y + nny * dSect },
    b: { x: en.b.x + nnx * dSect, y: en.b.y + nny * dSect }
  };
  var M_sect = lineIntersect(po_sect.a, po_sect.b, no_sect.a, no_sect.b);
  if (!M_corr || !M_sect) return null;
  // The two "cap" corners (B and D) are M_corridor pushed `depth` along
  // the outward normal of each edge — i.e., the perpendiculars meet the
  // section-outer offset of their own edge.
  var B = { x: M_corr.x + pnx * depth, y: M_corr.y + pny * depth };
  var D = { x: M_corr.x + nnx * depth, y: M_corr.y + nny * depth };
  return {
    kind: 'wedge', row: 'inner', type: 'wedge',
    vertexIdx: iV, corners: [M_corr, B, M_sect, D]
  };
}

// Build the remnant strips: between the end of the regular grid and
// the miter cut on each edge end. These are the green "non-standard
// cells" — short rectangles that don't quite reach a full step.
function buildRemnants(out, edges, edgeShifts, step, miterRanges, n0, n1, sideSign, isClosed, rowLabel) {
  var nEdges = edges.length;
  for (var ei = 0; ei < nEdges; ei++) {
    var mr = miterRanges[ei];
    if (!mr) continue;
    var edge = edges[ei];
    var L = edge.length;
    var tx = (edge.b.x - edge.a.x) / L, ty = (edge.b.y - edge.a.y) / L;
    var nx = -ty * sideSign, ny = tx * sideSign;
    var shift = edgeShifts[ei];
    var nCells = Math.floor((L - shift) / step);
    var kFirst = -1, kLast = -1;
    for (var k = 0; k < nCells; k++) {
      var t0 = shift + k * step, t1 = t0 + step;
      if (t0 < mr.tStart - MITER_EPS) continue;
      if (t1 > mr.tEnd + MITER_EPS) continue;
      if (kFirst === -1) kFirst = k;
      kLast = k;
    }
    var isLastEdge = !isClosed && (ei === nEdges - 1);
    var isFirstEdge = !isClosed && (ei === 0);

    var tLastEnd = (kLast >= 0) ? (shift + (kLast + 1) * step) : Math.max(0, mr.tStart);
    var tEndLim = Math.min(L, mr.tEnd);
    if (!isLastEdge && tEndLim > tLastEnd + 0.1) {
      out.push(makeRemnant(edge, tx, ty, nx, ny, n0, n1, tLastEnd, tEndLim,
        (ei + 1) % nEdges, ei, rowLabel));
    }
    var tFirstStart = (kFirst >= 0) ? (shift + kFirst * step) : Math.min(L, mr.tEnd);
    var tStartLim = Math.max(0, mr.tStart);
    if (!isFirstEdge && tFirstStart > tStartLim + 0.1) {
      out.push(makeRemnant(edge, tx, ty, nx, ny, n0, n1, tStartLim, tFirstStart,
        ei, ei, rowLabel));
    }
  }
}

// Green remnant strip in the inner-row pocket past V at a reflex
// vertex, between the last extension cell's far edge and the
// corridor-outer miter cut. `direction = +1` means the edge's b-end
// is the reflex vertex (prev edge perspective): remnant t-range is
// [floor((mr.tEnd - L) / step) * step + L, mr.tEnd]. `direction = -1`
// means the edge's a-end is the reflex vertex (next edge perspective):
// remnant is at [mr.tStart, -ceil(|mr.tStart| / step) * step + step]
// — i.e. the sub-step strip between the deepest extension and the
// backward miter cut.
function buildReflexPastVRemnant(out, edges, edgeIdx, mr, step, n0, n1, sideSign, direction, vIdx) {
  if (!mr) return;
  var edge = edges[edgeIdx];
  var L = edge.length;
  if (L < 1e-6) return;
  var tx = (edge.b.x - edge.a.x) / L, ty = (edge.b.y - edge.a.y) / L;
  var nx = -ty * sideSign, ny = tx * sideSign;
  if (vIdx == null) vIdx = -1;

  if (direction > 0) {
    // Past Lp on prev edge — extension cells fill [L, L + k*step].
    // The miter cut is at mr.tEnd (> L for reflex). Remnant is the
    // sub-step tail between the last extension and the miter cut.
    if (mr.tEnd <= L + 0.1) return;
    var n_ext = Math.floor((mr.tEnd - L) / step);
    var tCellsEnd = L + n_ext * step;
    var tStripEnd = mr.tEnd;
    if (tStripEnd - tCellsEnd < 0.05) return;
    out.push(makeRemnant(edge, tx, ty, nx, ny, n0, n1, tCellsEnd, tStripEnd,
      vIdx, edgeIdx, 'inner'));
  } else {
    // Before 0 on next edge — extensions fill [-k*step, 0]. Miter cut
    // at mr.tStart (< 0). Remnant is the sub-step nose between the
    // deepest extension and the miter cut.
    if (mr.tStart >= -0.1) return;
    var n_ext2 = Math.floor((-mr.tStart) / step);
    var tCellsStart = -n_ext2 * step;
    var tStripStart = mr.tStart;
    if (tCellsStart - tStripStart < 0.05) return;
    out.push(makeRemnant(edge, tx, ty, nx, ny, n0, n1, tStripStart, tCellsStart,
      vIdx, edgeIdx, 'inner'));
  }
}

function makeRemnant(edge, tx, ty, nx, ny, n0, n1, t0, t1, vertexIdx, edgeIdx, rowLabel) {
  var a = edge.a;
  return {
    kind: 'remnant',
    row: rowLabel,
    type: 'remnant',
    vertexIdx: vertexIdx,
    edgeIdx: edgeIdx,
    corners: [
      { x: a.x + tx * t0 + nx * n0, y: a.y + ty * t0 + ny * n0 },
      { x: a.x + tx * t1 + nx * n0, y: a.y + ty * t1 + ny * n0 },
      { x: a.x + tx * t1 + nx * n1, y: a.y + ty * t1 + ny * n1 },
      { x: a.x + tx * t0 + nx * n1, y: a.y + ty * t0 + ny * n1 }
    ]
  };
}
