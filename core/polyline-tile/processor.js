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
import { classifyCells, generateCellsFromFootprint } from '../tower/TowerGenerator.js';

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

  // A polygon is effectively a CCW polyline along the outer ring. We open
  // it at v0 (the first vertex) with a curved cut-out:
  //   1. Offset the polygon INWARD by sd (section depth) to get the inner
  //      offset polyline.
  //   2. At the inner offset of v0 (= P, the intersection of the two inner
  //      offset edges adjacent to v0), draw a 15 m circle and trim the
  //      inner offset edges where they enter the circle.
  //   3. Offset the trimmed inner polyline back OUTWARD by sd. The two new
  //      endpoints sit on the polygon's outer edges adjacent to v0.
  // After this, the rest of the algorithm uses the standard polyline path
  // (multi-corner sections, LLU, corner LLU) — single code path.
  // Polygon start-vertex rotation (Shuffle): cycle pts so the chosen
  // vertex becomes pts[0] (= v0 for the polyline conversion below).
  if (isPolygon && pts.length >= 3) {
    var sv = (tileParams && typeof tileParams.startVertex === 'number') ? Math.floor(tileParams.startVertex) : 0;
    if (sv > 0) {
      sv = ((sv % pts.length) + pts.length) % pts.length;
      if (sv > 0) pts = pts.slice(sv).concat(pts.slice(0, sv));
    }
  }

  var towerXY = null;   // tower footprint (4 corners, internal frame) if +Tower is on
  var towerXY2 = null;  // second tower (at diagonal bbox corner of polygon)
  var towerMeta = null;   // { rows, cols, orient, exitSide } for T1 (used to render internal cells)
  var towerMeta2 = null;  // same for T2
  // T2 cut parameters — only populated when the tower-2 trim is valid;
  // then the polygon splits into TWO open polylines at v_k.
  var t2VertIdx = -1, t2dP = null, t2dN = null;
  var t2TruncA = 0, t2TruncB = 0;
  var t2nP = null, t2nN = null, t2crossDN = 0;
  var ptsList = null;   // populated during polygon→polyline conversion (1 or 2 polylines)
  if (isPolygon && pts.length >= 3) {
    var sd = 2 * depth + buffer;
    var trimR = 15;
    var withTower = !!(tileParams && tileParams.withTower);
    var withTower2 = !!(tileParams && tileParams.withTower2);
    // Tower cell size — user-tunable, 3.0..3.3 m (independent of section cell).
    var TOWER_CELL = (tileParams && typeof tileParams.towerCellSize === 'number')
      ? Math.max(3, Math.min(3.3, tileParams.towerCellSize)) : 3.3;
    var TOWER_COLS = 7;                           // always 7 cells across
    var TOWER_WIDTH = TOWER_COLS * TOWER_CELL;
    // Tower-size cap from UI: 'small' | 'medium' | 'large'. Default small.
    // small  → max 7 rows along axis
    // medium → max 9 rows
    // large  → max 12 rows
    var TOWER_SIZE_MAX_ROWS = { small: 7, medium: 9, large: 12 };
    var userSizeKey = (tileParams && tileParams.towerSize) || 'small';
    var maxRows = TOWER_SIZE_MAX_ROWS[userSizeKey] || 7;
    // chooseRows: pick the largest rows count (capped at user choice)
    // that leaves ≥ (sd + 1m) of polyline edge on BOTH adjacent sides
    // after the buffer trim. This stricter check (vs. just trim<edge)
    // ensures the corner section's L-ring at the adjacent vertex has
    // room to form WITHOUT extending back into the tower buffer.
    //   • lat (E-W) — forced to 7 (always 7×7 square, per the established
    //     TowerGenerator rule), but still validated.
    //   • lon (N-S) — try {12, 9, 7} clipped to user cap.
    // Returns 0 ⇒ no tower fits without polyline-into-buffer overlap.
    var MIN_TAIL = sd + 1;   // ≈19 m at default sd=18
    function chooseTowerRows(orient, edgeBLen, edgeALen) {
      var across = TOWER_WIDTH;
      var trimAcross = across + trimR;
      // truncA (cols * cell + 15) is independent of rows; if edgeA
      // doesn't have enough remaining after trim → no tower at all.
      if (edgeALen - trimAcross < MIN_TAIL) return 0;
      var pool = (orient === 'lat') ? [7] : [12, 9, 7];
      for (var i = 0; i < pool.length; i++) {
        var r = pool[i];
        if (r > maxRows) continue;
        var trimAlong = r * TOWER_CELL + trimR;
        if (edgeBLen - trimAlong < MIN_TAIL) continue;
        return r;
      }
      return 0;
    }
    var Npts0 = pts.length;
    var pv = pts[Npts0 - 1], v0 = pts[0], nv = pts[1];
    function _u(a, b) {
      var ux = b.x - a.x, uy = b.y - a.y, uL = Math.hypot(ux, uy);
      return uL > 1e-9 ? { x: ux / uL, y: uy / uL, L: uL } : null;
    }
    var dP = _u(pv, v0);   // incoming edge direction (toward v0)
    var dN = _u(v0, nv);   // outgoing edge direction (away from v0)
    var converted = false;
    if (dP && dN) {
      var nP = { x: -dP.y, y: dP.x };       // inward normals
      var nN = { x: -dN.y, y: dN.x };
      var crossDN = dP.x * dN.y - dP.y * dN.x;
      if (crossDN > 1e-9) {   // convex v0 (CCW math = CW canvas)
        var truncA = 0, truncB = 0;
        if (withTower) {
          // Helper: every sample on the tower perimeter (6 points/edge,
          // including the actual corners) — INSET 0.2 m toward the tower
          // centre — must be inside the polygon. The inset handles the
          // ray-cast ambiguity at boundary points (Option A's corner sits
          // on a polygon vertex); 0.2 m is small enough that any tower
          // corner more than 0.2 m outside still fails.
          var towerFitCheck = function (corners) {
            var INSET = 0.2;   // metres
            var ccx = (corners[0].x + corners[1].x + corners[2].x + corners[3].x) / 4;
            var ccy = (corners[0].y + corners[1].y + corners[2].y + corners[3].y) / 4;
            for (var ee = 0; ee < 4; ee++) {
              var aa = corners[ee], bb = corners[(ee + 1) % 4];
              for (var kk = 0; kk <= 5; kk++) {
                var ttp = kk / 5;
                var px = aa.x + ttp * (bb.x - aa.x);
                var py = aa.y + ttp * (bb.y - aa.y);
                var ddx = ccx - px, ddy = ccy - py;
                var dl = Math.hypot(ddx, ddy);
                var f = (dl > 1e-9) ? Math.min(1, INSET / dl) : 0;
                var ix = px + f * ddx, iy = py + f * ddy;
                if (!pointInPolygon({ x: ix, y: iy }, pts)) return false;
              }
            }
            return true;
          };

          // Tower is ALWAYS axes-aligned with the outgoing edge B (sides
          // along dN and nN). For obtuse/90° corners we anchor it at v0
          // (corner of tower = v0). For acute corners the v0-anchored
          // square pokes outside edge A — in that case STEP BACK from v0
          // along edge B by the smallest d > 0 where the shifted tower
          // fits inside the polygon.
          //
          // After placement, TRIM the polyline axes by the tower's 15-m
          // buffer: along edge B the buffer reaches v0 + (d+ts+15)·dN, so
          // truncB = d+ts+15. Along edge A only Option A (d ≤ 0.5) trims
          // by the buffer (truncA = ts+15); for Option B the tower is far
          // enough from edge A that the standard 15-m circle trim handles
          // edge A (truncA filled in by the block below).
          //
          // Buffer ALWAYS trims the polyline axes — no MIN_POLY_EDGE
          // fallback. On small blocks where the buffer-respecting trim
          // would leave a polyline edge with no complete triples, the
          // multi-corner section dispatcher falls back to per-edge
          // sections (no corner sections), but the polyline visibly
          // respects the buffer. This is the user-requested sequence:
          // place tower → trim axes by buffer → build polyline.
          //
          // Tower size: rows (along dN) depend on edge orientation —
          // lat (E-W) → 7×7 square; lon (N-S) → 12/9/7 by edge length.
          // Width across is always 7 cells = 23.1 m.
          // chooseTowerRows validates both trims fit the adjacent edges
          // so the polyline-trim gate below NEVER fails on tower size —
          // returns 0 if no size fits (skip tower placement entirely).
          var t1Orient = classifySegment(v0, nv);   // edge B direction (= dN)
          var t1Rows = chooseTowerRows(t1Orient, dN.L, dP.L);
          var t1Along = t1Rows * TOWER_CELL;
          var t1Across = TOWER_WIDTH;
          for (var d = 0; t1Rows > 0 && d <= dN.L - t1Along - 0.5; d += 0.5) {
            var ox = v0.x + d * dN.x, oy = v0.y + d * dN.y;
            var twD = [
              { x: ox, y: oy },
              { x: ox + t1Along * dN.x, y: oy + t1Along * dN.y },
              { x: ox + t1Along * dN.x + t1Across * nN.x, y: oy + t1Along * dN.y + t1Across * nN.y },
              { x: ox + t1Across * nN.x, y: oy + t1Across * nN.y }
            ];
            if (towerFitCheck(twD)) {
              towerXY = twD;
              towerMeta = { rows: t1Rows, cols: TOWER_COLS, orient: t1Orient, exitSide: 'row-end' };
              truncB = d + t1Along + trimR;
              if (d <= 0.5) truncA = t1Across + trimR;
              break;
            }
          }
          // ─── Second tower (visual + buffer cull, NO polyline trim) ───
          // Determined by the bounding-box diagonal:
          //   1. Compute axis-aligned bbox of polygon.
          //   2. Find which bbox corner is closest to tower 1's centre.
          //   3. Take the DIAGONAL bbox corner.
          //   4. Pick the polygon vertex (excluding v0) closest to that
          //      diagonal — that's where tower 2 anchors.
          //   5. Place tower 2 axes-aligned with the outgoing edge from
          //      that vertex, stepping back along it on acute corners
          //      (same algorithm as tower 1). Skip if vertex is reflex
          //      or no fit possible.
          // Tower 2 does NOT trim the polyline (the polyline opening is
          // at v0 only). It is purely visual + its 15-m buffer culls
          // стилобат cells the same way tower 1's buffer does.
          if (withTower2 && towerXY) {
            var xmn = Infinity, xmx = -Infinity, ymn = Infinity, ymx = -Infinity;
            for (var bi = 0; bi < Npts0; bi++) {
              if (pts[bi].x < xmn) xmn = pts[bi].x;
              if (pts[bi].x > xmx) xmx = pts[bi].x;
              if (pts[bi].y < ymn) ymn = pts[bi].y;
              if (pts[bi].y > ymx) ymx = pts[bi].y;
            }
            var bbc = [
              { x: xmn, y: ymn }, { x: xmx, y: ymn },
              { x: xmx, y: ymx }, { x: xmn, y: ymx }
            ];
            var t1cx = (towerXY[0].x + towerXY[2].x) / 2;
            var t1cy = (towerXY[0].y + towerXY[2].y) / 2;
            var bestC = 0, bestCd = Infinity;
            for (var cii = 0; cii < 4; cii++) {
              var ddx = bbc[cii].x - t1cx, ddy = bbc[cii].y - t1cy;
              var dd = ddx * ddx + ddy * ddy;
              if (dd < bestCd) { bestCd = dd; bestC = cii; }
            }
            var diagC = bbc[(bestC + 2) % 4];
            // Rank polygon vertices by distance to diagC (closest first).
            // Skip v0 (= pts[0]); on reflex/unfit candidates fall through
            // to the next-closest until one fits or we run out.
            var ord = [];
            for (var vi2 = 1; vi2 < Npts0; vi2++) {
              var ddxv = pts[vi2].x - diagC.x, ddyv = pts[vi2].y - diagC.y;
              ord.push({ i: vi2, d2: ddxv * ddxv + ddyv * ddyv });
            }
            ord.sort(function (A, B) { return A.d2 - B.d2; });
            var BUF2 = 15;
            // Require v_k ∈ [2, Npts0-2] so the split into TWO polylines
            // leaves at least one interior vertex on each side; otherwise
            // polyA / polyB would degenerate to just [Q_x, Q_y].
            for (var oi = 0; oi < ord.length && !towerXY2; oi++) {
              var vk = ord[oi].i;
              if (vk < 2 || vk > Npts0 - 2) continue;
              var v0_2 = pts[vk];
              var pv_2 = pts[(vk - 1 + Npts0) % Npts0];
              var nv_2 = pts[(vk + 1) % Npts0];
              var dP_2 = _u(pv_2, v0_2);
              var dN_2 = _u(v0_2, nv_2);
              if (!dP_2 || !dN_2) continue;
              var crossDN_2 = dP_2.x * dN_2.y - dP_2.y * dN_2.x;
              if (crossDN_2 <= 1e-9) continue;   // reflex / collinear — skip
              var nN_2 = { x: -dN_2.y, y: dN_2.x };
              var nP_2 = { x: -dP_2.y, y: dP_2.x };
              // T2 size mirrors T1 logic: rows by orientation of edge B at v_k.
              // If chooseTowerRows returns 0 (no size fits), skip this vertex
              // entirely so T2 doesn't end up placed without valid trim.
              var t2Orient = classifySegment(v0_2, nv_2);
              var t2Rows = chooseTowerRows(t2Orient, dN_2.L, dP_2.L);
              if (t2Rows === 0) continue;
              var t2Along = t2Rows * TOWER_CELL;
              var t2Across = TOWER_WIDTH;
              for (var d2 = 0; d2 <= dN_2.L - t2Along - 0.5; d2 += 0.5) {
                var ox2 = v0_2.x + d2 * dN_2.x, oy2 = v0_2.y + d2 * dN_2.y;
                var twD2 = [
                  { x: ox2, y: oy2 },
                  { x: ox2 + t2Along * dN_2.x, y: oy2 + t2Along * dN_2.y },
                  { x: ox2 + t2Along * dN_2.x + t2Across * nN_2.x, y: oy2 + t2Along * dN_2.y + t2Across * nN_2.y },
                  { x: ox2 + t2Across * nN_2.x, y: oy2 + t2Across * nN_2.y }
                ];
                if (!towerFitCheck(twD2)) continue;
                // Reject placements that overlap tower 1's footprint
                // (centres closer than 0.5·(t1Along+t1Across) + 2·BUF —
                // approximation; ensures buffers don't merge).
                var c2cx = (twD2[0].x + twD2[2].x) / 2;
                var c2cy = (twD2[0].y + twD2[2].y) / 2;
                var cdx = c2cx - t1cx, cdy = c2cy - t1cy;
                var cdist = Math.hypot(cdx, cdy);
                if (cdist < 0.5 * (t1Along + t1Across) + 2 * BUF2) continue;
                towerXY2 = twD2;
                towerMeta2 = { rows: t2Rows, cols: TOWER_COLS, orient: t2Orient, exitSide: 'row-end' };
                t2VertIdx = vk;
                t2dP = dP_2; t2dN = dN_2;
                t2nP = nP_2; t2nN = nN_2;
                t2crossDN = crossDN_2;
                t2TruncB = d2 + t2Along + trimR;
                if (d2 <= 0.5) t2TruncA = t2Across + trimR;
                break;
              }
            }
          }
        }
        if (truncA === 0 || truncB === 0) {
          // Fill in the missing trim(s) with the standard 15-m circle
          // trim at the inner-offset corner P. This covers: no-tower
          // mode (both 0), OR Option-B tower (shifted along edge B —
          // only truncB was set by the tower; truncA stays 0 and gets
          // filled here). We do NOT overwrite a value already set by
          // the tower block (else Option B's tower-aware truncB would
          // be lost, the polyline would pass through the tower).
          var rhsX = sd * (nP.x - nN.x);
          var rhsY = sd * (nP.y - nN.y);
          var det = -crossDN;
          if (Math.abs(det) > 1e-9) {
            var tParam = (rhsX * dN.y - dN.x * rhsY) / det;
            var sParam = (-dP.x * rhsY + rhsX * dP.y) / det;
            if (truncA === 0) truncA = trimR - tParam;
            if (truncB === 0) truncB = sParam + trimR;
          }
        }
        // Same fallback for T2 trims (standard 15-m circle trim at v_k).
        if (towerXY2 && (t2TruncA === 0 || t2TruncB === 0)) {
          var rhsX2 = sd * (t2nP.x - t2nN.x);
          var rhsY2 = sd * (t2nP.y - t2nN.y);
          var det2 = -t2crossDN;
          if (Math.abs(det2) > 1e-9) {
            var tParam2 = (rhsX2 * t2dN.y - t2dN.x * rhsY2) / det2;
            var sParam2 = (-t2dP.x * rhsY2 + rhsX2 * t2dP.y) / det2;
            if (t2TruncA === 0) t2TruncA = trimR - tParam2;
            if (t2TruncB === 0) t2TruncB = sParam2 + trimR;
          }
        }
        if (truncA > 0 && truncB > 0 && truncA < dP.L * 0.95 && truncB < dN.L * 0.95) {
          var QA = { x: v0.x - truncA * dP.x, y: v0.y - truncA * dP.y };
          var QB = { x: v0.x + truncB * dN.x, y: v0.y + truncB * dN.y };
          // T2 is "valid for splitting" only if its trim distances are
          // both > 0, leave enough edge on both sides, and we captured
          // a valid interior vertex index. Otherwise the single-polyline
          // path runs and T2 stays visual-only.
          var t2Valid =
            !!towerXY2 && t2VertIdx >= 2 && t2VertIdx <= Npts0 - 2 &&
            t2TruncA > 0 && t2TruncB > 0 &&
            t2TruncA < t2dP.L * 0.95 && t2TruncB < t2dN.L * 0.95;
          if (t2Valid) {
            var vK = pts[t2VertIdx];
            var Qin  = { x: vK.x - t2TruncA * t2dP.x, y: vK.y - t2TruncA * t2dP.y };
            var Qout = { x: vK.x + t2TruncB * t2dN.x, y: vK.y + t2TruncB * t2dN.y };
            var polyA = [QB];
            for (var ai = 1; ai < t2VertIdx; ai++) polyA.push(pts[ai]);
            polyA.push(Qin);
            var polyB = [Qout];
            for (var bi2 = t2VertIdx + 1; bi2 < Npts0; bi2++) polyB.push(pts[bi2]);
            polyB.push(QA);
            ptsList = [polyA, polyB];
          } else {
            var newPts = [QB];
            for (var i = 1; i < Npts0; i++) newPts.push(pts[i]);
            newPts.push(QA);
            ptsList = [newPts];
          }
          converted = true;
        }
      }
    }
    if (!converted) {
      // Fallback: simply shorten the last edge by 6 cells (when v0 is
      // reflex or the trim doesn't fit the adjacent edges).
      var pvF = pts[pts.length - 1], v0F = pts[0];
      var dxF = v0F.x - pvF.x, dyF = v0F.y - pvF.y;
      var LF = Math.hypot(dxF, dyF);
      var gapMF = 6 * step;
      if (LF > gapMF + 1e-3) {
        var ff = (LF - gapMF) / LF;
        pts.push({ x: pvF.x + dxF * ff, y: pvF.y + dyF * ff });
      }
      ptsList = [pts];
    }
    isPolygon = false;
  }
  // Pure polyline input (or any path that didn't set ptsList above).
  if (!ptsList) ptsList = [pts];

  // ─── Tower-buffer predicate (hoisted; OR of T1 + T2) ───
  // A point is inside the 15-m rounded buffer (Minkowski sum of tower
  // square + 15-m disk) iff squared distance to the tower square ≤ 15².
  // Built once over both towers so the per-polyline pipeline below
  // doesn't re-build it.
  function makeTowerBufferPredicate(twXY) {
    if (!twXY || twXY.length !== 4) return null;
    var tcA = twXY[0], tcB = twXY[1], tcD = twXY[3];
    var axx = tcB.x - tcA.x, axy = tcB.y - tcA.y;
    var ayx = tcD.x - tcA.x, ayy = tcD.y - tcA.y;
    var Lx = Math.hypot(axx, axy), Ly = Math.hypot(ayx, ayy);
    if (Lx < 1e-9 || Ly < 1e-9) return null;
    var uxx = axx / Lx, uxy = axy / Lx;
    var uyx = ayx / Ly, uyy = ayy / Ly;
    var cxT = (tcA.x + twXY[2].x) / 2, cyT = (tcA.y + twXY[2].y) / 2;
    var hwT = Lx / 2, hhT = Ly / 2;
    var BUFR = 15, BUFR2 = BUFR * BUFR;
    return function (p) {
      var dx0 = p.x - cxT, dy0 = p.y - cyT;
      var lxp = dx0 * uxx + dy0 * uxy;
      var lyp = dx0 * uyx + dy0 * uyy;
      var ex = Math.abs(lxp) - hwT; if (ex < 0) ex = 0;
      var ey = Math.abs(lyp) - hhT; if (ey < 0) ey = 0;
      return (ex * ex + ey * ey) <= BUFR2;
    };
  }
  var towerBufPreds = [];
  var bp1 = makeTowerBufferPredicate(towerXY);  if (bp1) towerBufPreds.push(bp1);
  var bp2 = makeTowerBufferPredicate(towerXY2); if (bp2) towerBufPreds.push(bp2);
  var towerBufferContains = towerBufPreds.length === 0 ? null : function (p) {
    for (var bpi = 0; bpi < towerBufPreds.length; bpi++) {
      if (towerBufPreds[bpi](p)) return true;
    }
    return false;
  };

  // ─── Per-polyline pipeline ───
  // Build tiles, edges, sections, and стилобат markers independently
  // for each polyline in ptsList. Output conversion below iterates
  // these per-polyline arrays and concatenates the lng/lat results.
  //
  // Direction picker: for each polyline we run the pipeline TWICE —
  // once forward (pts as-is) and once reversed (pts.reverse() with
  // sideSign flipped so sections stay on the polygon's interior side).
  // Triple-partitioning drops the remainder at the END of an edge run,
  // and corner-section formation depends on edge traversal order, so
  // the two directions can produce different counts of whole sections.
  // We pick whichever direction yields more total triples-in-sections
  // (≡ fewer стилобат cells, more living area). Acts AFTER buffer trim.
  function runPolylinePipeline(ptsCand, sideCand) {
    var built = buildTiles(ptsCand, isPolygon, step, depth, buffer, rows, sideCand);
    var tiles = built.tiles;
    var vcs   = built.vertexClasses;
    var es    = getEdges(ptsCand, isPolygon);
    var ss = [], sr = [];
    if (rows === 3) {
      var sec = buildSections(es, tiles, step, depth, buffer, sideCand, isPolygon);
      ss = sec.sections;
      var vkLocal = sec.validKeys;
      var secPolysLocal = [];
      for (var sii = 0; sii < ss.length; sii++) {
        for (var pj0 = 0; pj0 < ss[sii].polys.length; pj0++) {
          secPolysLocal.push(ss[sii].polys[pj0]);
        }
      }
      for (var tj = 0; tj < tiles.length; tj++) {
        var tt0 = tiles[tj];
        var isReg0 = (tt0.kind === 'cell' || tt0.kind === 'corridor') &&
          tt0.edgeIdx != null && tt0.cellIdx != null && tt0.cellIdx >= 0;
        if (!isReg0) continue;
        if (vkLocal[tt0.edgeIdx + ':' + tt0.cellIdx] === true) continue;
        var ctr0 = tileCentroid({ corners: tt0.corners });
        var inside0 = false;
        for (var pj1 = 0; pj1 < secPolysLocal.length; pj1++) {
          if (pointInPolygon(ctr0, secPolysLocal[pj1])) { inside0 = true; break; }
        }
        if (!inside0) {
          if (towerBufferContains && towerBufferContains(ctr0)) {
            tt0._dropFromOutput = true;
          } else {
            tt0.stylobate = true;
          }
        }
      }
      sr = buildStylobateRegions(tiles, es, sideCand, 2 * depth + buffer);
    }
    return {
      pts: ptsCand,
      tilesXY: tiles,
      vertexClasses: vcs,
      edges: es,
      sectionsXY: ss,
      styloRegions: sr
    };
  }
  function scorePipelineResult(res) {
    // Sum of triple counts across all sections — proxy for "whole
    // sections without стилобат". Higher is better.
    var total = 0;
    for (var k = 0; k < res.sectionsXY.length; k++) {
      total += (res.sectionsXY[k].tripleCount || 0);
    }
    return total;
  }
  var tilesXYList = [], edgesList = [], sectionsXYList = [];
  var vertexClassesList = [], styloRegionsXYList = [];
  for (var pli = 0; pli < ptsList.length; pli++) {
    var ptsi = ptsList[pli];
    var fwd = runPolylinePipeline(ptsi, sideSign);
    var rev = runPolylinePipeline(ptsi.slice().reverse(), -sideSign);
    var picked = scorePipelineResult(rev) > scorePipelineResult(fwd) ? rev : fwd;
    tilesXYList.push(picked.tilesXY);
    edgesList.push(picked.edges);
    sectionsXYList.push(picked.sectionsXY);
    vertexClassesList.push(picked.vertexClasses);
    styloRegionsXYList.push(picked.styloRegions);
    // Replace the polyline's pts with the picked direction's pts so
    // the output's vertex diagnostic matches the actually-built layout.
    ptsList[pli] = picked.pts;
  }

  // ─── Output conversion — iterate per polyline, concatenate results ───
  var outVertices = [];
  var outTiles = [];
  var outStylobate = [];
  var outSections = [];
  var outEdgesMeta = [];
  for (var po = 0; po < ptsList.length; po++) {
    var ptsO = ptsList[po];
    var edgesO = edgesList[po];
    var tilesXYO = tilesXYList[po];
    var sectionsXYO = sectionsXYList[po];
    var vertexClassesO = vertexClassesList[po];
    var styloRegionsXYO = styloRegionsXYList[po];
    var nEdgesO = edgesO.length;

    // Vertices for this polyline. Open-polyline endpoints have class
    // 'end' (no corner classification). Each polyline numbers its
    // vertices locally; downstream code distinguishes polylines via
    // polylineIdx field if needed.
    for (var vi = 0; vi < ptsO.length; vi++) {
      var pXY = ptsO[vi];
      var lngLatV = proj.toLngLat(pXY.x, -pXY.y);
      var vc = vertexClassesO[vi] || { class: 'end', cosInterior: null, shifted: false, outerXY: null };
      var outerLngLat = null;
      if (vc.outerXY) {
        var oll = proj.toLngLat(vc.outerXY.x, -vc.outerXY.y);
        outerLngLat = [oll[0], oll[1]];
      }
      var cornerType = null;
      if (vc.class !== 'end') {
        var prevEi = vi - 1, nextEi = vi;
        if (prevEi >= 0 && prevEi < nEdgesO && nextEi >= 0 && nextEi < nEdgesO) {
          var pT = (edgesO[prevEi].type === 'lat') ? 'Ш' : 'М';
          var nT = (edgesO[nextEi].type === 'lat') ? 'Ш' : 'М';
          cornerType = pT + '-' + nT;
        }
      }
      outVertices.push({
        idx: vi,
        polylineIdx: po,
        lngLat: [lngLatV[0], lngLatV[1]],
        outerLngLat: outerLngLat,
        class: vc.class,
        cosInterior: vc.cosInterior,
        shifted: !!vc.shifted,
        cornerType: cornerType
      });
    }

    // Tiles for this polyline. Skip tiles flagged _dropFromOutput
    // (стилобаты swallowed by the tower-buffer footprint).
    for (var k = 0; k < tilesXYO.length; k++) {
      var srcT = tilesXYO[k];
      if (srcT._dropFromOutput) continue;
      var cornersLngLat = new Array(srcT.corners.length);
      for (var c = 0; c < srcT.corners.length; c++) {
        var p = srcT.corners[c];
        // Y FLIP back to math-y-up before projection inversion.
        var lngLat = proj.toLngLat(p.x, -p.y);
        cornersLngLat[c] = [lngLat[0], lngLat[1]];
      }
      outTiles.push({
        kind: srcT.kind,
        row: srcT.row,
        type: srcT.type,
        stylobate: !!srcT.stylobate,
        edgeIdx: srcT.edgeIdx != null ? srcT.edgeIdx : undefined,
        cellIdx: srcT.cellIdx != null ? srcT.cellIdx : undefined,
        vertexIdx: srcT.vertexIdx != null ? srcT.vertexIdx : undefined,
        polylineIdx: po,
        cornersLngLat: cornersLngLat
      });
    }

    // Stylobate region centroids for this polyline.
    for (var sri = 0; sri < styloRegionsXYO.length; sri++) {
      var r = styloRegionsXYO[sri];
      var cllS = proj.toLngLat(r.centroid.x, -r.centroid.y);
      outStylobate.push({ centroidLngLat: [cllS[0], cllS[1]], count: r.count });
    }

    // Sections for this polyline. Pass the polyline's own edges,
    // tilesXY, vertexClasses into the LLU helpers.
    for (var sIdx = 0; sIdx < sectionsXYO.length; sIdx++) {
      var s = sectionsXYO[sIdx];
      var polysLngLat = s.polys.map(function (ring) {
        return ring.map(function (p) {
          var ll = proj.toLngLat(p.x, -p.y);
          return [ll[0], ll[1]];
        });
      });
      var cll = proj.toLngLat(s.centroid.x, -s.centroid.y);
      var lluLngLat = null, lluCentroidLngLat = null;
      var lluXY = computeSectionLLU(s, edgesO, sideSign, depth, buffer);
      if (lluXY) {
        lluLngLat = lluXY.map(function (p) {
          var ll = proj.toLngLat(p.x, -p.y);
          return [ll[0], ll[1]];
        });
        var lc = polysCentroid([lluXY]);
        var lcll = proj.toLngLat(lc.x, -lc.y);
        lluCentroidLngLat = [lcll[0], lcll[1]];
      }
      var stairLngLat = null, stairCentroidLngLat = null;
      var elevPolysLngLat = null, elevCentroidLngLat = null;
      var lluGroupCentroidLngLat = null;
      var cvc = (s._ext && s._ext.kind === 'corner' && s._ext.vIdx != null && vertexClassesO[s._ext.vIdx])
        ? vertexClassesO[s._ext.vIdx].class : null;
      var isExternalCorner = (cvc === 'reflex');
      var clu = computeCornerLLU(s, edgesO, tilesXYO, sideSign, step, depth, buffer, isExternalCorner);
      if (clu) {
        stairLngLat = clu.stairXY.map(function (p) {
          var ll = proj.toLngLat(p.x, -p.y);
          return [ll[0], ll[1]];
        });
        var sc = polysCentroid([clu.stairXY]);
        var scll = proj.toLngLat(sc.x, -sc.y);
        stairCentroidLngLat = [scll[0], scll[1]];
        elevPolysLngLat = clu.elevPolysXY.map(function (poly) {
          return poly.map(function (p) {
            var ll = proj.toLngLat(p.x, -p.y);
            return [ll[0], ll[1]];
          });
        });
        var ec = polysCentroid(clu.elevPolysXY);
        var ecll = proj.toLngLat(ec.x, -ec.y);
        elevCentroidLngLat = [ecll[0], ecll[1]];
        var gx = (sc.x + ec.x) / 2, gy = (sc.y + ec.y) / 2;
        var gll = proj.toLngLat(gx, -gy);
        lluGroupCentroidLngLat = [gll[0], gll[1]];
      }
      outSections.push({
        type: s.type,
        isCorner: !!s.isCorner,
        tripleCount: s.tripleCount,
        areaRaw: s.areaRaw,
        areaLiving: s.areaLiving,
        polylineIdx: po,
        polygonsLngLat: polysLngLat,
        centroidLngLat: [cll[0], cll[1]],
        lluLngLat: lluLngLat,
        lluCentroidLngLat: lluCentroidLngLat,
        cornerStairLngLat: stairLngLat,
        cornerStairCentroidLngLat: stairCentroidLngLat,
        cornerElevPolysLngLat: elevPolysLngLat,
        cornerElevCentroidLngLat: elevCentroidLngLat,
        cornerLLUGroupCentroidLngLat: lluGroupCentroidLngLat
      });
    }

    // Edges meta for this polyline.
    for (var ei2 = 0; ei2 < edgesO.length; ei2++) {
      outEdgesMeta.push({ type: edgesO[ei2].type, lengthM: edgesO[ei2].length });
    }
  }

  // Tower footprint (when +Tower / +Tower 2 is on for a polygon) →
  // lng/lat. Also a 15-m rounded buffer ring around the tower
  // (Minkowski-square approximation with quarter-circle arc corners) so
  // the user can see the no-build zone visually.
  function buildTowerOutput(twXY, meta) {
    if (!twXY) return null;
    var ringLngLat = twXY.map(function (p) {
      var ll = proj.toLngLat(p.x, -p.y);
      return [ll[0], ll[1]];
    });
    var tc = polysCentroid([twXY]);
    var tcll = proj.toLngLat(tc.x, -tc.y);
    // 15 m rounded buffer: Minkowski sum of the tower square with a 15-m
    // disk → straight edges parallel to the tower offset 15 m outward,
    // connected by quarter-circle arcs of radius 15 m at each corner.
    var BUF = 15;
    var ARC_SEGS = 6;   // segments per quarter arc → 24-point smooth ring
    var Nt = twXY.length;
    // Centroid (used to pick the outward direction of each edge).
    var cTx = 0, cTy = 0;
    for (var ti = 0; ti < Nt; ti++) { cTx += twXY[ti].x; cTy += twXY[ti].y; }
    cTx /= Nt; cTy /= Nt;
    // Outward unit normal of each edge i (from twXY[i] to twXY[i+1]).
    var nOuts = [];
    for (var ei = 0; ei < Nt; ei++) {
      var ta = twXY[ei], tb = twXY[(ei + 1) % Nt];
      var ex = tb.x - ta.x, ey = tb.y - ta.y;
      var eL = Math.hypot(ex, ey);
      if (eL < 1e-9) { nOuts.push({ x: 0, y: 0 }); continue; }
      var nx = -ey / eL, ny = ex / eL;
      // Pick the perpendicular pointing AWAY from the centroid.
      var midX = (ta.x + tb.x) / 2, midY = (ta.y + tb.y) / 2;
      if ((midX - cTx) * nx + (midY - cTy) * ny < 0) { nx = -nx; ny = -ny; }
      nOuts.push({ x: nx, y: ny });
    }
    // For each tower corner, sweep an arc from the incoming-edge outward
    // normal to the outgoing-edge outward normal (radius 15 m, centered at
    // the corner). Consecutive corners' arc endpoints are connected
    // automatically (straight buffer edges).
    var bufXY = [];
    for (var ci = 0; ci < Nt; ci++) {
      var nIn  = nOuts[(ci - 1 + Nt) % Nt];
      var nOut = nOuts[ci];
      var aIn  = Math.atan2(nIn.y, nIn.x);
      var aOut = Math.atan2(nOut.y, nOut.x);
      var da = aOut - aIn;
      while (da >  Math.PI) da -= 2 * Math.PI;
      while (da < -Math.PI) da += 2 * Math.PI;
      var corner = twXY[ci];
      for (var s = 0; s <= ARC_SEGS; s++) {
        var ang = aIn + (s / ARC_SEGS) * da;
        bufXY.push({
          x: corner.x + BUF * Math.cos(ang),
          y: corner.y + BUF * Math.sin(ang)
        });
      }
    }
    var bufLngLat = bufXY.map(function (p) {
      var ll = proj.toLngLat(p.x, -p.y);
      return [ll[0], ll[1]];
    });
    // ── Internal structure: cells (apartment / llu / llu-exit) ──
    // classifyCells works in row-major order (id = r*cols + c) and
    // generateCellsFromFootprint emits polygons in the same order, so
    // we can zip the two arrays index-by-index. Footprint convention:
    //   twXY[0] = axis-start near, twXY[1] = axis-end near,
    //   twXY[2] = axis-end far,    twXY[3] = axis-start far.
    var cells = [];
    if (meta && meta.rows && meta.cols) {
      // generateCellsFromFootprint expects [x,y] arrays, not {x,y}.
      var fpArr = twXY.map(function (p) { return [p.x, p.y]; });
      var classified = classifyCells(meta.rows, meta.cols, meta.exitSide || 'row-end');
      var localPolys = generateCellsFromFootprint(fpArr, meta.rows, meta.cols);
      for (var ci2 = 0; ci2 < classified.length; ci2++) {
        var lp = localPolys[ci2];
        var llRing = lp.map(function (xy) {
          var ll = proj.toLngLat(xy[0], -xy[1]);
          return [ll[0], ll[1]];
        });
        cells.push({
          type: classified[ci2].type,    // 'apartment' | 'llu' | 'llu-exit'
          row: classified[ci2].row,
          col: classified[ci2].col,
          cornersLngLat: llRing
        });
      }
    }
    return {
      footprintLngLat: ringLngLat,
      bufferLngLat: bufLngLat,
      centroidLngLat: [tcll[0], tcll[1]],
      cells: cells,
      meta: meta ? { rows: meta.rows, cols: meta.cols, orient: meta.orient } : null
    };
  }
  var outTower  = buildTowerOutput(towerXY,  towerMeta);
  var outTower2 = buildTowerOutput(towerXY2, towerMeta2);

  return {
    tiles: outTiles,
    edges: outEdgesMeta,
    vertices: outVertices,
    sections: outSections,
    stylobate: outStylobate,
    tower: outTower,
    tower2: outTower2,
    projection: { originLng: origin[0], originLat: origin[1] }
  };
}

function emptyResult() {
  return { tiles: [], edges: [], vertices: [], sections: [], stylobate: [], projection: null };
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

// Лестнично-лифтовой узел (stair-elevator core) for a NON-corner
// straight section: a pair of grid cells in the MIDDLE of the section's
// length, on its NORTHERNMOST long side (one row deep). Returns the quad
// (internal XY) or null for corner sections / sections without a layout.
//   depth  = one row depth; buffer = corridor width.
// North = smallest internal-y (internal frame is canvas-y-down, so the
// geographic north has the most-negative y).
function computeSectionLLU(section, edges, sideSign, depth, buffer) {
  if (!section || section.isCorner) return null;
  var ext = section._ext;
  if (!ext || ext.kind !== 'straight') return null;
  var cells = ext.cells.slice().sort(function (a, b) { return a.t0 - b.t0; });
  if (!cells.length) return null;
  var e = edges[ext.ei];
  var L = segLength(e.a, e.b);
  if (L < 1e-6) return null;
  var tx = (e.b.x - e.a.x) / L, ty = (e.b.y - e.a.y) / L;
  var nx = -ty * sideSign, ny = tx * sideSign;

  // Center pair of columns (2 cells wide). Round toward the center.
  var nC = cells.length;
  var startCol = Math.round(nC / 2 - 1);
  if (startCol < 0) startCol = 0;
  if (startCol > nC - 1) startCol = nC - 1;
  var t0 = cells[startCol].t0;
  var t1 = cells[Math.min(startCol + 1, nC - 1)].t1;

  var sd = 2 * depth + buffer;
  function quad(nA, nB) {
    return [
      { x: e.a.x + tx * t0 + nx * nA, y: e.a.y + ty * t0 + ny * nA },
      { x: e.a.x + tx * t1 + nx * nA, y: e.a.y + ty * t1 + ny * nA },
      { x: e.a.x + tx * t1 + nx * nB, y: e.a.y + ty * t1 + ny * nB },
      { x: e.a.x + tx * t0 + nx * nB, y: e.a.y + ty * t0 + ny * nB }
    ];
  }
  var outerQ = quad(0, depth);             // axis-side row
  var innerQ = quad(depth + buffer, sd);   // far-side row
  function cy(q) { var s = 0; for (var i = 0; i < q.length; i++) s += q[i].y; return s / q.length; }
  return (cy(outerQ) <= cy(innerQ)) ? outerQ : innerQ;   // smaller y = north
}

// Regular cells on a given edge + row, sorted by distance along the edge
// (t). LLU sits on the COMMON GRID (no flush offset), so we pick the
// wedge-adjacent grid cell — the first regular cell AFTER the green
// remnants — and the next one along the arm.
function rowCellsOnEdge(tilesXY, ei, rowLabel, edge) {
  var L = segLength(edge.a, edge.b);
  if (L < 1e-6) return [];
  var tx = (edge.b.x - edge.a.x) / L, ty = (edge.b.y - edge.a.y) / L;
  var arr = [];
  for (var i = 0; i < tilesXY.length; i++) {
    var t = tilesXY[i];
    if (t.kind !== 'cell' || t.row !== rowLabel || t.edgeIdx !== ei) continue;
    var c = tileCentroid({ corners: t.corners });
    arr.push({ tile: t, t: (c.x - edge.a.x) * tx + (c.y - edge.a.y) * ty });
  }
  arr.sort(function (a, b) { return a.t - b.t; });
  return arr;
}

// Wedge-adjacent regular grid cell on an arm+row + the NEXT one along the
// arm (away from the vertex). head arm → first cell; tail arm → last.
function armRowCells(tilesXY, ei, rowLabel, edge, side) {
  var cells = rowCellsOnEdge(tilesXY, ei, rowLabel, edge);
  if (!cells.length) return null;
  if (side === 'head') return { cell: cells[0].tile, next: cells[1] ? cells[1].tile : null };
  return {
    cell: cells[cells.length - 1].tile,
    next: cells.length >= 2 ? cells[cells.length - 2].tile : null
  };
}

// Largest-area wedge tile of a given row at vertex vIdx (corner element).
function wedgeTileOnRow(tilesXY, vIdx, rowLabel) {
  var best = null, bestA = -1;
  for (var i = 0; i < tilesXY.length; i++) {
    var t = tilesXY[i];
    if (t.vertexIdx !== vIdx || t.kind !== 'wedge' || t.row !== rowLabel) continue;
    var a = polygonAreaM2(t.corners);
    if (a > bestA) { bestA = a; best = t; }
  }
  return best ? { corners: best.corners, area: bestA } : null;
}

// ЛЛУ for a CORNER section (unified for convex & reflex corners):
//   • Лестница (staircase) = the NORTHERNMOST regular grid cell adjacent
//     to the corner element, across both arms × both rows (lone single-
//     cell "торец" arms are skipped). On the common grid (the first cell
//     after the green остаток).
//   • Лифты (elevators):
//       – INTERNAL element (only the vertex on the outer contour — convex)
//         whose inner segment area > 1.5 standard cells → the inner purple
//         segment;
//       – otherwise (EXTERNAL/reflex element — never used for lifts — or a
//         too-small inner segment) → a cell directly next to the corner
//         element (the next northernmost adjacent cell, ≠ the staircase).
//     The green остаток that DIRECTLY borders the lifts is given to them
//     (never the corridor, never the staircase-side остаток across it).
// Returns { stairXY, elevPolysXY } or null.
function computeCornerLLU(section, edges, tilesXY, sideSign, step, depth, buffer, isExternal) {
  var ext = section._ext;
  if (!ext || ext.kind !== 'corner') return null;
  var innerWedge = wedgeTileOnRow(tilesXY, ext.vIdx, 'inner');
  var stdCell = step * depth;

  // Valid arms (≥2 cells; skip lone "торец").
  var arms = [];
  if (ext.ccA && ext.ccA.length >= 2) arms.push({ ei: ext.eiA, side: 'tail' });
  if (ext.ccB && ext.ccB.length >= 2) arms.push({ ei: ext.eiB, side: 'head' });
  if (!arms.length) return null;

  // ЛИФТЫ — всегда во ВНУТРЕННЕМ угловом элементе (только вершина касается
  // внешнего контура секции; convex-углы), если ПОЛНАЯ площадь элемента
  // (все wedge-тайлы при вершине) не меньше площади регулярной ячейки.
  // Иначе fallback: лифт в соседней ячейке. У reflex-углов внутреннего
  // элемента нет → также fallback.
  var liftPoly = null, stairCell = null;
  var elemArea = 0;
  for (var eti = 0; eti < tilesXY.length; eti++) {
    var et = tilesXY[eti];
    if (et.vertexIdx === ext.vIdx && et.kind === 'wedge') {
      elemArea += polygonAreaM2(et.corners);
    }
  }
  var useElement = (!isExternal && innerWedge && elemArea >= stdCell - 1e-6);
  if (useElement) {
    liftPoly = innerWedge.corners;
    // Лестница = wedge-adjacent regular cell, северная (оба ряда — для
    // углов, где внутренний ряд упирается в вершину и северная ячейка
    // оказывается на внешнем ряду, тоже примыкающем к элементу).
    var bestSY = Infinity;
    for (var ai = 0; ai < arms.length; ai++) {
      var arm = arms[ai], e = edges[arm.ei];
      if (segLength(e.a, e.b) < 1e-6) continue;
      for (var ri = 0; ri < 2; ri++) {
        var rowL = ri === 0 ? 'outer' : 'inner';
        var rc = armRowCells(tilesXY, arm.ei, rowL, e, arm.side);
        if (!rc || !rc.cell) continue;
        var sctr = tileCentroid({ corners: rc.cell.corners });
        if (sctr.y < bestSY) { bestSY = sctr.y; stairCell = rc.cell; }
      }
    }
  } else {
    // Fallback: lift = a wedge-adjacent regular cell next to the corner
    // element; staircase = a cell directly adjacent to the lift, on the
    // north side. From a {wedge-adjacent, next-along-arm} pair we assign
    // whichever cell is MORE NORTH as the staircase and the other as the
    // lift. Pick the pair where the staircase ends up most-north overall.
    var bestStY = Infinity;
    for (var ai2 = 0; ai2 < arms.length; ai2++) {
      var arm2 = arms[ai2], e2 = edges[arm2.ei];
      if (segLength(e2.a, e2.b) < 1e-6) continue;
      for (var ri2 = 0; ri2 < 2; ri2++) {
        var rowL = ri2 === 0 ? 'outer' : 'inner';
        var rc2 = armRowCells(tilesXY, arm2.ei, rowL, e2, arm2.side);
        if (!rc2 || !rc2.cell || !rc2.next) continue;
        var aCtr = tileCentroid({ corners: rc2.cell.corners });
        var bCtr = tileCentroid({ corners: rc2.next.corners });
        var stairC, liftC, sCtr;
        if (aCtr.y <= bCtr.y) { stairC = rc2.cell; liftC = rc2.next; sCtr = aCtr; }
        else                  { stairC = rc2.next; liftC = rc2.cell; sCtr = bCtr; }
        if (sCtr.y < bestStY) {
          bestStY = sCtr.y;
          liftPoly = liftC.corners;
          stairCell = stairC;
        }
      }
    }
  }
  if (!liftPoly || !stairCell) return null;
  var elevPolys = [liftPoly.slice()];

  // Остаток отдаётся лифтам ТОЛЬКО если зелёный кусок НЕПОСРЕДСТВЕННО
  // соседствует с лифтами (делит с ними ребро). Никогда не коридор.
  // Если такой кусок лежит МЕЖДУ лестницей и лифтом — он всё равно идёт
  // лифту (поглощается лифтом).
  var baseRings = elevPolys.slice();
  for (var ri = 0; ri < tilesXY.length; ri++) {
    var rt = tilesXY[ri];
    if (rt.vertexIdx !== ext.vIdx || rt.kind !== 'remnant' || rt.row === 'corridor') continue;
    for (var bi = 0; bi < baseRings.length; bi++) {
      if (ringsShareEdge(rt.corners, baseRings[bi])) { elevPolys.push(rt.corners.slice()); break; }
    }
  }
  return { stairXY: stairCell.corners.slice(), elevPolysXY: elevPolys };
}

// Two polygon rings share (part of) an edge — i.e. they are directly
// adjacent (≥2 corners of one lie on the other's boundary).
function ringsShareEdge(ringA, ringB) {
  function ptToRing(px, py, ring) {
    var best = Infinity;
    for (var j = 0; j < ring.length; j++) {
      var a = ring[j], b = ring[(j + 1) % ring.length];
      var d = distPointSeg(px, py, a.x, a.y, b.x, b.y);
      if (d < best) best = d;
    }
    return best;
  }
  function countOn(pts, ring) {
    var c = 0;
    for (var i = 0; i < pts.length; i++) if (ptToRing(pts[i].x, pts[i].y, ring) < 0.5) c++;
    return c;
  }
  return countOn(ringA, ringB) >= 2 || countOn(ringB, ringA) >= 2;
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

// Group stylobate OUTER cells into contiguous runs per edge and return
// a label anchor (mid-band centroid) + cell count for each run. Used to
// drop one "стилобат" label per gray region.
function buildStylobateRegions(tilesXY, edges, sideSign, sectionDepth) {
  var byEdge = {};
  for (var i = 0; i < tilesXY.length; i++) {
    var t = tilesXY[i];
    if (t.stylobate && t.kind === 'cell' && t.row === 'outer' && t.cellIdx != null && t.t0 != null) {
      (byEdge[t.edgeIdx] = byEdge[t.edgeIdx] || []).push(t);
    }
  }
  var regions = [];
  for (var e in byEdge) {
    var ei = +e;
    var cells = byEdge[e].sort(function (a, b) { return a.t0 - b.t0; });
    var runs = [[cells[0]]];
    for (var j = 1; j < cells.length; j++) {
      if (Math.abs(cells[j].t0 - cells[j - 1].t1) < 0.6) runs[runs.length - 1].push(cells[j]);
      else runs.push([cells[j]]);
    }
    var edge = edges[ei];
    var L = segLength(edge.a, edge.b);
    if (L < 1e-6) continue;
    var tx = (edge.b.x - edge.a.x) / L, ty = (edge.b.y - edge.a.y) / L;
    var nx = -ty * sideSign, ny = tx * sideSign;
    for (var r = 0; r < runs.length; r++) {
      var run = runs[r];
      var t0 = run[0].t0, t1 = run[run.length - 1].t1;
      var tm = (t0 + t1) / 2, nm = sectionDepth / 2;
      regions.push({
        centroid: { x: edge.a.x + tx * tm + nx * nm, y: edge.a.y + ty * tm + ny * nm },
        count: run.length
      });
    }
  }
  return regions;
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
    sectionDepth: sectionDepth, tripleArea: tripleArea, maxLon: maxLon,
    byEdge: byEdge, isPolygon: isPolygon
  };
  var result = null;
  // Any open polyline with ≥2 edges (≥1 interior corner) OR closed polygon
  // with ≥3 edges is handled by the universal multi-corner processor,
  // PROVIDED every edge carries at least one complete triple. Otherwise
  // fall back to plain per-edge straights.
  var minEdges = isPolygon ? 3 : 2;
  var allHaveCells = edges.length >= minEdges;
  for (var gi = 0; allHaveCells && gi < edges.length; gi++) {
    if (!byEdge[gi] || !byEdge[gi].length) allHaveCells = false;
  }
  if (allHaveCells) result = buildSectionsMultiCorner(ctx);
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
        polys: [rect], centroid: polysCentroid([rect]),
        _ext: { kind: 'straight', ei: ei, cells: run.slice() }
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

// Generalised cross-edge corner builder. The corner is at edgeA's TAIL
// (b-end) and edgeB's HEAD (a-end), at vertex `vIdx`. cellsA/cellsB are
// the AVAILABLE complete-triple cells on each edge (sorted by t0).
//   emitAHead — also lay out edgeA's head straights (false when edgeA's
//               head was already consumed by a previous corner).
//   emitBTail — also lay out edgeB's tail straights.
// Returns { sections, validKeys } or null if the corner can't form.
function buildCornerBetween(ctx, eiA, eiB, cellsA, cellsB, vIdx, emitAHead, emitBTail) {
  var edges = ctx.edges;
  var nA = cellsA.length, nB = cellsB.length;
  var typeA = edges[eiA].type, typeB = edges[eiB].type;
  var tripleArea = ctx.tripleArea, maxLon = ctx.maxLon, sideSign = ctx.sideSign, sd = ctx.sectionDepth;
  var corner = cornerElementTiles(ctx.tilesXY, vIdx);
  var cornerTypeStr = (typeA === 'lat' ? 'Ш' : 'М') + '-' + (typeB === 'lat' ? 'Ш' : 'М');

  var sections = [], validKeys = {};
  function markRun(ei, run) { for (var i = 0; i < run.length; i++) validKeys[ei + ':' + run[i].cellIdx] = true; }
  function pushRun(ei, run, type) {
    if (!run.length) return;
    var rect = runRect(edges[ei], run, sideSign, sd);
    var areaRaw = run.length * tripleArea;
    sections.push({
      type: type, tripleCount: run.length,
      areaRaw: areaRaw, areaLiving: areaRaw * SECTION_LIVING_COEF,
      polys: [rect], centroid: polysCentroid([rect]),
      _ext: { kind: 'straight', ei: ei, cells: run.slice() }
    });
    markRun(ei, run);
  }
  function pushParts(ei, cellList, type, parts, alignEnd) {
    var S = sumSizes(parts);
    var idx = alignEnd ? (cellList.length - S) : 0;
    if (idx < 0) idx = 0;
    for (var pp = 0; pp < parts.length; pp++) {
      pushRun(ei, cellList.slice(idx, idx + parts[pp]), type);
      idx += parts[pp];
    }
  }
  function emitStraight(ei, cellList, type, alignEnd) {
    pushParts(ei, cellList, type, partitionTriples(cellList.length, type, maxLon), alignEnd);
  }
  function pushCorner(ccA, ccB) {
    var outline = cornerOutline(edges[eiA], edges[eiB], ccA, ccB, sideSign, sd);
    var polys;
    if (outline) {
      polys = [outline];
    } else {
      polys = [];
      if (ccA.length) polys.push(runRect(edges[eiA], ccA, sideSign, sd));
      if (ccB.length) polys.push(runRect(edges[eiB], ccB, sideSign, sd));
      for (var i = 0; i < corner.polys.length; i++) polys.push(corner.polys[i]);
    }
    if (!polys.length) return;
    var nCells = ccA.length + ccB.length;
    var areaRaw = nCells * tripleArea + corner.area;
    sections.push({
      type: cornerTypeStr, isCorner: true, tripleCount: nCells + 1,
      areaRaw: areaRaw, areaLiving: areaRaw * SECTION_LIVING_COEF,
      polys: polys, centroid: polysCentroid(polys),
      _ext: { kind: 'corner', eiA: eiA, eiB: eiB, vIdx: vIdx, ccA: ccA.slice(), ccB: ccB.slice(), cornerArea: corner.area }
    });
    markRun(eiA, ccA); markRun(eiB, ccB);
  }

  if (typeA === 'lat' && typeB === 'lat') {
    var bestA = -1, bestDrop = Infinity;
    for (var a = 1; a <= 4; a++) {
      var b = 5 - a;
      if (b < 1 || b > 4 || a > nA || b > nB) continue;
      var drop = ((nA - a) % 6) + ((nB - b) % 6);
      if (drop < bestDrop) { bestDrop = drop; bestA = a; }
    }
    if (bestA < 0) return null;
    var aa = bestA, bb = 5 - aa;
    if (emitAHead) emitStraight(eiA, cellsA.slice(0, nA - aa), 'lat', true);
    if (emitBTail) emitStraight(eiB, cellsB.slice(bb), 'lat', false);
    pushCorner(cellsA.slice(nA - aa), cellsB.slice(0, bb));
  } else if (typeA === 'lat' && typeB === 'lon') {
    if (nA < 1) return null;
    if (emitAHead) emitStraight(eiA, cellsA.slice(0, nA - 1), 'lat', true);
    var rL = chooseLonSplit(nB, tripleArea + corner.area, tripleArea, maxLon);
    if (!rL) return null;
    pushCorner(cellsA.slice(nA - 1), cellsB.slice(0, rL.M));
    if (emitBTail) pushParts(eiB, cellsB.slice(rL.M), 'lon', rL.parts, false);
  } else if (typeA === 'lon' && typeB === 'lat') {
    if (nB < 1) return null;
    if (emitBTail) emitStraight(eiB, cellsB.slice(1), 'lat', false);
    var rL2 = chooseLonSplit(nA, tripleArea + corner.area, tripleArea, maxLon);
    if (!rL2) return null;
    if (emitAHead) pushParts(eiA, cellsA.slice(0, nA - rL2.M), 'lon', rL2.parts, true);
    pushCorner(cellsA.slice(nA - rL2.M), cellsB.slice(0, 1));
  } else {
    var rMM = chooseMmSplit(nA, nB, corner.area, tripleArea, maxLon);
    if (!rMM) return null;
    if (emitAHead) pushParts(eiA, cellsA.slice(0, nA - rMM.M0), 'lon', rMM.parts0, true);
    if (emitBTail) pushParts(eiB, cellsB.slice(rMM.M1), 'lon', rMM.parts1, false);
    pushCorner(cellsA.slice(nA - rMM.M0), cellsB.slice(0, rMM.M1));
  }

  return { sections: sections, validKeys: validKeys };
}

// Universal multi-corner processor for any open polyline with N ≥ 2 edges
// (N-1 interior corners at vertices v1…v(N-1)). Generalises the proven
// one- and two-corner logic by CHAINING it left to right:
//
//   • Each interior vertex v is the corner between edge(v-1) [its tail] and
//     edge(v) [its head].
//   • Every MIDDLE edge ei (1 ≤ ei ≤ N-2) is shared by two corners — its
//     HEAD feeds corner v=ei, its TAIL is RESERVED for corner v=ei+1. The
//     reservation size is chosen up-front by decideV2EdgeShare (same rule
//     used for the 3-segment case) so both flanking corners can form.
//   • End edges have one free end (edge0's head, edge(N-1)'s tail).
//
// For each corner, left to right: lay the corner + any straights on the
// not-yet-consumed parts of its two edges. If a corner can't be assembled
// (e.g. its reserved tail is too short) we first try giving it the full
// edge (dropping that edge's reservation), then fall back to a 15 m
// buffer-break: lay the edge out straight beyond a 15 m clearance from the
// structure built so far. Finally absorb any 1–2 row middle gaps.
//
// With N=2 this reduces to the single-corner case; with N=3 it reproduces
// the two-corner case exactly.
function buildSectionsMultiCorner(ctx) {
  var edges = ctx.edges, byEdge = ctx.byEdge, N = edges.length;
  var isPolygon = !!ctx.isPolygon;
  // For polygons every edge is a "middle" edge (head and tail both consumed
  // by corners) — wrap-around closes the chain. For polylines only edges
  // 1..N-2 are middle; edge 0 contributes only its tail, edge N-1 only its
  // head.
  function isMiddleEdge(ei) {
    return isPolygon ? true : (ei >= 1 && ei <= N - 2);
  }

  // 1. Reserve a tail slice of every middle edge for its RIGHT corner.
  //    Corner at vertex v consumes edge((v-1+N)%N).tail and edge(v).head.
  var reserve = [];
  for (var ri = 0; ri < N; ri++) reserve.push(0);
  for (var ei = 0; ei < N; ei++) {
    if (!isMiddleEdge(ei)) continue;
    var nextEi = (ei + 1) % N;
    var cornerNext = cornerElementTiles(ctx.tilesXY, nextEi);
    reserve[ei] = decideV2EdgeShare(
      edges[ei].type, edges[nextEi].type,
      (byEdge[ei] || []).length, (byEdge[nextEi] || []).length,
      cornerNext.area, ctx);
  }

  var sections = [], validKeys = {};
  function merge(r) {
    for (var i = 0; i < r.sections.length; i++) sections.push(r.sections[i]);
    for (var k in r.validKeys) validKeys[k] = true;
  }

  // 2. Build corners. Polyline: v = 1 … N-1. Polygon: v = 0 … N-1 (wrap).
  var vStart = isPolygon ? 0 : 1;
  for (var v = vStart; v <= N - 1; v++) {
    var eiA = isPolygon ? ((v - 1 + N) % N) : (v - 1);
    var eiB = v;
    var cellsAll_A = byEdge[eiA] || [], cellsAll_B = byEdge[eiB] || [];
    var CA = cellsAll_A.length, CB = cellsAll_B.length;

    var cellsA, emitAHead;
    if (!isMiddleEdge(eiA)) { cellsA = cellsAll_A; emitAHead = true; }
    else { cellsA = cellsAll_A.slice(CA - reserve[eiA]); emitAHead = false; }

    var emitBTail = true;
    var cellsB = isMiddleEdge(eiB) ? cellsAll_B.slice(0, CB - reserve[eiB]) : cellsAll_B;

    var r = buildCornerBetween(ctx, eiA, eiB, cellsA, cellsB, v, emitAHead, emitBTail);

    // Retry: corner failed because we over-reserved edge eiB's tail → give
    // it the whole edge (the next corner then has no reserved tail and will
    // in turn buffer-break on its own far edge).
    if (!r && isMiddleEdge(eiB) && reserve[eiB] > 0) {
      reserve[eiB] = 0;
      cellsB = cellsAll_B;
      r = buildCornerBetween(ctx, eiA, eiB, cellsA, cellsB, v, emitAHead, emitBTail);
    }

    if (r) { merge(r); continue; }

    // Corner v can't form → buffer-break edge eiB beyond a 15 m clearance.
    bufferBreakEdge(ctx, eiB, sections, validKeys);
    if (isMiddleEdge(eiB)) reserve[eiB] = 0;   // tail consumed by the break
  }

  // 3. Absorb 1–2 row dropped gaps on each middle edge.
  for (var em = 0; em < N; em++) {
    if (isMiddleEdge(em)) absorbMiddleGap(ctx, sections, validKeys, em);
  }

  return { sections: sections, validKeys: validKeys };
}

// ── Buffer-break helpers (corner can't be assembled) ──
function distPointSeg(px, py, ax, ay, bx, by) {
  var dx = bx - ax, dy = by - ay;
  var len2 = dx * dx + dy * dy;
  var t = len2 > 1e-9 ? ((px - ax) * dx + (py - ay) * dy) / len2 : 0;
  if (t < 0) t = 0; else if (t > 1) t = 1;
  var cx = ax + t * dx, cy = ay + t * dy;
  return Math.hypot(px - cx, py - cy);
}
// Min distance from a point to a set of polygon rings (0 if inside any).
function minDistPointToPolys(px, py, polys) {
  var best = Infinity;
  for (var i = 0; i < polys.length; i++) {
    var ring = polys[i];
    if (pointInPolygon({ x: px, y: py }, ring)) return 0;
    for (var j = 0; j < ring.length; j++) {
      var a = ring[j], b = ring[(j + 1) % ring.length];
      var d = distPointSeg(px, py, a.x, a.y, b.x, b.y);
      if (d < best) best = d;
    }
  }
  return best;
}

// Grow a section by one extra triple-cell (absorbing a middle gap),
// recomputing its polygon + area. Returns false (no change) if the
// growth would push the section over the 550 living cap.
function extendSectionWithCell(section, cell, ctx) {
  var ext = section._ext;
  if (!ext) return false;
  var edges = ctx.edges, sideSign = ctx.sideSign, sd = ctx.sectionDepth, tripleArea = ctx.tripleArea;
  if (ext.kind === 'straight') {
    var cells = ext.cells.concat([cell]);
    cells.sort(function (a, b) { return a.t0 - b.t0; });
    var areaRaw = cells.length * tripleArea;
    if (areaRaw * SECTION_LIVING_COEF > SECTION_MAX_LIVING + 1e-6) return false;
    var rect = runRect(edges[ext.ei], cells, sideSign, sd);
    section.polys = [rect];
    section.centroid = polysCentroid([rect]);
    section.areaRaw = areaRaw;
    section.areaLiving = areaRaw * SECTION_LIVING_COEF;
    section.tripleCount = cells.length;
    ext.cells = cells;
    return true;
  }
  // corner
  var onA = (cell.edgeIdx === ext.eiA);
  var newCcA = onA ? ext.ccA.concat([cell]) : ext.ccA.slice();
  var newCcB = onA ? ext.ccB.slice() : ext.ccB.concat([cell]);
  newCcA.sort(function (a, b) { return a.t0 - b.t0; });
  newCcB.sort(function (a, b) { return a.t0 - b.t0; });
  var nCells = newCcA.length + newCcB.length;
  var areaRaw2 = nCells * tripleArea + ext.cornerArea;
  if (areaRaw2 * SECTION_LIVING_COEF > SECTION_MAX_LIVING + 1e-6) return false;
  var outline = cornerOutline(edges[ext.eiA], edges[ext.eiB], newCcA, newCcB, sideSign, sd);
  var polys = outline ? [outline] : section.polys;
  section.polys = polys;
  section.centroid = polysCentroid(polys);
  section.areaRaw = areaRaw2;
  section.areaLiving = areaRaw2 * SECTION_LIVING_COEF;
  section.tripleCount = nCells + 1;
  ext.ccA = newCcA; ext.ccB = newCcB;
  return true;
}

// Absorb a small dropped middle-segment gap into adjacent sections:
//   1 row  → nearest CORNER section grows +1 cell;
//   2 rows → the two sections flanking the gap each grow +1 cell;
//   ≥3 rows → acceptable, leave the gap.
// Growth is skipped (gap stays) if it would exceed the 550 cap.
function absorbMiddleGap(ctx, sections, validKeys, eiMid) {
  var mid = (ctx.byEdge[eiMid] || []).filter(function (c) { return !validKeys[eiMid + ':' + c.cellIdx]; });
  mid.sort(function (a, b) { return a.t0 - b.t0; });
  var G = mid.length;
  if (G < 1 || G > 2) return;

  function cellsOnEdge1(sec) {
    var ext = sec._ext; if (!ext) return [];
    if (ext.kind === 'straight') return ext.ei === eiMid ? ext.cells : [];
    if (ext.eiA === eiMid) return ext.ccA;
    if (ext.eiB === eiMid) return ext.ccB;
    return [];
  }
  function sectionEndingAt(t) {   // section whose edge1 cell has t1 ≈ t
    for (var i = 0; i < sections.length; i++) {
      var cs = cellsOnEdge1(sections[i]);
      for (var j = 0; j < cs.length; j++) if (Math.abs(cs[j].t1 - t) < 0.6) return sections[i];
    }
    return null;
  }
  function sectionStartingAt(t) { // section whose edge1 cell has t0 ≈ t
    for (var i = 0; i < sections.length; i++) {
      var cs = cellsOnEdge1(sections[i]);
      for (var j = 0; j < cs.length; j++) if (Math.abs(cs[j].t0 - t) < 0.6) return sections[i];
    }
    return null;
  }

  if (G === 1) {
    var g = mid[0];
    var after = sectionStartingAt(g.t1);   // v2-side
    var before = sectionEndingAt(g.t0);    // v1-side
    var target = (after && after.isCorner) ? after
      : (before && before.isCorner) ? before
      : (after || before);
    if (target && extendSectionWithCell(target, g, ctx)) validKeys[eiMid + ':' + g.cellIdx] = true;
  } else { // G === 2
    var g0 = mid[0], g1 = mid[1];
    var sBefore = sectionEndingAt(g0.t0);
    var sAfter = sectionStartingAt(g1.t1);
    if (sBefore && extendSectionWithCell(sBefore, g0, ctx)) validKeys[eiMid + ':' + g0.cellIdx] = true;
    if (sAfter && extendSectionWithCell(sAfter, g1, ctx)) validKeys[eiMid + ':' + g1.cellIdx] = true;
  }
}

// How many cells the v2 corner should RESERVE from edge1's tail, so
// both corners can form (v2 "bites off" part of the middle segment).
function decideV2EdgeShare(type1, type2, C1, C2, corner2Area, ctx) {
  if (C1 < 2 || C2 < 1) return 0;
  if (type1 === 'lat') {
    if (type2 === 'lat') {
      // Ш-Ш: a2 ∈ [1,4], b2 = 5-a2 ≤ C2. Minimise edge2 drop.
      var bestA = -1, bestDrop = Infinity;
      for (var a = 1; a <= 4; a++) {
        var b = 5 - a;
        if (b < 1 || b > 4 || b > C2) continue;
        var d = (C2 - b) % 6;
        if (d < bestDrop) { bestDrop = d; bestA = a; }
      }
      return bestA > 0 ? Math.min(bestA, C1 - 1) : 0;
    }
    return Math.min(1, C1 - 1);     // Ш-М: edge1 lat side = 1 cell
  }
  // edge1 lon: v2 takes M2 lon cells. Use a standalone estimate, capped
  // so v1 keeps the majority and a middle section can still fit.
  var base = corner2Area + ((type2 === 'lat') ? ctx.tripleArea : 0);
  var r = chooseLonSplit(C1, base + ctx.tripleArea, ctx.tripleArea, ctx.maxLon);
  var M2 = r ? r.M : 1;
  return Math.max(1, Math.min(M2, Math.floor(C1 / 2)));
}

// Buffer-break a single edge that couldn't join a corner: skip its cells
// until the first one whose whole footprint clears a 15 m buffer from the
// structure built so far, then lay the rest out straight. Mirrors the
// 3-segment edge2 break, generalised to any edge / accumulated structure.
function bufferBreakEdge(ctx, edgeIdx, sections, validKeys) {
  var edges = ctx.edges, sideSign = ctx.sideSign, sd = ctx.sectionDepth;
  var tripleArea = ctx.tripleArea, maxLon = ctx.maxLon;

  var refPolys = [];
  for (var s = 0; s < sections.length; s++) {
    for (var p = 0; p < sections[s].polys.length; p++) refPolys.push(sections[s].polys[p]);
  }
  var cells = (ctx.byEdge[edgeIdx] || []).filter(function (c) {
    return !validKeys[edgeIdx + ':' + c.cellIdx];
  }).sort(function (a, b) { return a.t0 - b.t0; });
  if (!cells.length) return;

  var e = edges[edgeIdx], L = segLength(e.a, e.b);
  var tx = (e.b.x - e.a.x) / L, ty = (e.b.y - e.a.y) / L;
  var nx = -ty * sideSign, ny = tx * sideSign;
  var BUFFER = 15;
  var startIdx = -1;
  for (var ci = 0; ci < cells.length; ci++) {
    var c = cells[ci];
    var corners = [
      { x: e.a.x + tx * c.t0 + nx * 0,  y: e.a.y + ty * c.t0 + ny * 0 },
      { x: e.a.x + tx * c.t1 + nx * 0,  y: e.a.y + ty * c.t1 + ny * 0 },
      { x: e.a.x + tx * c.t1 + nx * sd, y: e.a.y + ty * c.t1 + ny * sd },
      { x: e.a.x + tx * c.t0 + nx * sd, y: e.a.y + ty * c.t0 + ny * sd }
    ];
    var clear = true;
    for (var cc = 0; cc < corners.length; cc++) {
      if (minDistPointToPolys(corners[cc].x, corners[cc].y, refPolys) < BUFFER) { clear = false; break; }
    }
    if (clear) { startIdx = ci; break; }
  }
  if (startIdx < 0) return;

  var keep = cells.slice(startIdx);
  var parts = partitionTriples(keep.length, e.type, maxLon);
  var idx = 0;
  for (var pp = 0; pp < parts.length; pp++) {
    var run = keep.slice(idx, idx + parts[pp]); idx += parts[pp];
    if (!run.length) continue;
    var rect = runRect(e, run, sideSign, sd);
    var areaRaw = run.length * tripleArea;
    sections.push({
      type: e.type, tripleCount: run.length,
      areaRaw: areaRaw, areaLiving: areaRaw * SECTION_LIVING_COEF,
      polys: [rect], centroid: polysCentroid([rect]),
      _ext: { kind: 'straight', ei: edgeIdx, cells: run.slice() }
    });
    for (var g = 0; g < run.length; g++) validKeys[edgeIdx + ':' + run[g].cellIdx] = true;
  }
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
