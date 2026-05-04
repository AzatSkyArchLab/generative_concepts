/**
 * Corner-cells — distribute 3.3m cells inside an L-shaped corner section.
 *
 * Geometry follows the user's spec:
 *
 *   1. The corridor is the inward offset of the joined polyline
 *      P1 → V → P2 by `apartmentDepth`, thickened by `corridorWidth` —
 *      i.e. an L-strip with a miter at V. End cells trim the corridor
 *      one cell short of each polyline endpoint.
 *
 *   2. LLU is exactly 2 (or 3, if the building is taller than 28m)
 *      regular cells of 3.3 × apartmentDepth on the LONG arm, taking
 *      the cells nearest the corner (V). They sit on the corridor's
 *      north side (per `getNorthSide`); on the opposite side of the
 *      corridor — across the very same cells — there are regular
 *      apartment cells.
 *
 *   3. Any non-3.3-aligned tail of an arm is taken up either by the
 *      corner non-standard apartment (for arm1 / pivot-side tail) or
 *      by the end-cell apartment (for arm2 / polyline-end tail) —
 *      never dropped, never visible as a gap.
 *
 *   4. The shorter arm in mixed corners (W in WM/MW) is one big
 *      non-standard apartment with no internal corridor. Pivot blocks
 *      (inner / outer) are likewise non-standard. The L-corridor
 *      strip in the pivot links the long-arm corridor through the
 *      bend.
 *
 * Inner corners and degenerate geometry return { fallback: true } and
 * the caller falls back to the simple solid extrude.
 */

var CELL_MODULE = 3.3;
var CORRIDOR_WIDTH = 2.0;
var SECONDARY_MAX_CELLS = 3;
var TALL_BUILDING_THRESHOLD = 28;

// ── 2D helpers ─────────────────────────────────────────
function vSub(a, b) { return [a[0] - b[0], a[1] - b[1]]; }
function vAdd(a, b) { return [a[0] + b[0], a[1] + b[1]]; }
function vSc(a, s) { return [a[0] * s, a[1] * s]; }
function vLen(a) { return Math.sqrt(a[0] * a[0] + a[1] * a[1]); }
function vNorm(a) { var l = vLen(a); return l < 1e-9 ? [0, 0] : [a[0] / l, a[1] / l]; }
function vCross(a, b) { return a[0] * b[1] - a[1] * b[0]; }
function vPerp(a, side) { return side > 0 ? [-a[1], a[0]] : [a[1], -a[0]]; }

function lineIntersect(p, dir, q, dirQ) {
  var denom = dir[0] * dirQ[1] - dir[1] * dirQ[0];
  if (Math.abs(denom) < 1e-9) return null;
  var dp = vSub(q, p);
  var t = (dp[0] * dirQ[1] - dp[1] * dirQ[0]) / denom;
  return vAdd(p, vSc(dir, t));
}

function strip(p0, p1, normal, fromDepth, toDepth) {
  var oa = vSc(normal, fromDepth);
  var ob = vSc(normal, toDepth);
  return [vAdd(p0, oa), vAdd(p1, oa), vAdd(p1, ob), vAdd(p0, ob)];
}

// ── Public API ─────────────────────────────────────────

export function buildCornerCells(opts) {
  var V = opts.vertex;
  var prev = opts.prev;
  var next = opts.next;
  var armA = opts.armA;
  var armB = opts.armB;
  var W = opts.secWidth;
  var side = opts.side > 0 ? 1 : -1;
  var mode = opts.mode || 'WW';
  var sectionHeight = opts.sectionHeight || 28;

  if (!V || !prev || !next || !(armA > 0) || !(armB > 0) || !(W > 0)) {
    return { fallback: true };
  }

  var d1 = vNorm(vSub(V, prev));
  var d2 = vNorm(vSub(next, V));
  var crossD = vCross(d1, d2);
  if (Math.abs(crossD) < 1e-3) return { fallback: true };
  if (side * crossD > 0) return { fallback: true };           // inner corner

  var n1 = vPerp(d1, side);
  var n2 = vPerp(d2, side);
  var apartmentDepth = (W - CORRIDOR_WIDTH) / 2.0;
  if (apartmentDepth < CELL_MODULE) return { fallback: true };

  var P1 = vSub(V, vSc(d1, armA));
  var P2 = vAdd(V, vSc(d2, armB));

  var dIn = apartmentDepth;
  var dOut = apartmentDepth + CORRIDOR_WIDTH;

  var P1ext = vAdd(P1, vSc(n1, W));
  var P2ext = vAdd(P2, vSc(n2, W));
  var Vin1 = vAdd(V, vSc(n1, dIn));    var Vout1 = vAdd(V, vSc(n1, dOut));    var vO1 = vAdd(V, vSc(n1, W));
  var Vin2 = vAdd(V, vSc(n2, dIn));    var Vout2 = vAdd(V, vSc(n2, dOut));    var vO2 = vAdd(V, vSc(n2, W));

  var Min  = lineIntersect(Vin1,  d1, Vin2,  d2);
  var Mout = lineIntersect(Vout1, d1, Vout2, d2);
  var I    = lineIntersect(vO1,   d1, vO2,   d2);
  if (!Min || !Mout || !I) return { fallback: true };

  var nCells1 = Math.floor((armA + 1e-3) / CELL_MODULE);
  var nCells2 = Math.floor((armB + 1e-3) / CELL_MODULE);
  if (nCells1 <= 0 || nCells2 <= 0) return { fallback: true };

  var arm1IsShort, arm2IsShort;
  if (mode === 'WM')      { arm1IsShort = true;  arm2IsShort = false; }
  else if (mode === 'MW') { arm1IsShort = false; arm2IsShort = true;  }
  else {
    var s1 = nCells1 <= SECONDARY_MAX_CELLS && nCells1 < nCells2;
    var s2 = nCells2 <= SECONDARY_MAX_CELLS && nCells2 < nCells1;
    arm1IsShort = s1;  arm2IsShort = s2;
  }

  // Primary arm = the longer one (or M side in mixed corners). LLU
  // sits on this arm, on the cells nearest V.
  var primaryIsArm2;
  if (arm1IsShort) primaryIsArm2 = true;
  else if (arm2IsShort) primaryIsArm2 = false;
  else primaryIsArm2 = (nCells2 >= nCells1);

  var lluCount = sectionHeight > TALL_BUILDING_THRESHOLD ? 3 : 2;

  var cells = [];

  // Arm 1
  if (arm1IsShort) {
    cells.push({ poly: [P1, V, vO1, P1ext], type: 'non-standard', meta: 'arm1-short' });
  } else {
    appendArmCells(cells, {
      origin: P1, axis: d1, normal: n1, len: armA, nCells: nCells1, W: W,
      apartmentDepth: apartmentDepth,
      pivotAtStart: false,
      placeLLU: !primaryIsArm2, lluCount: lluCount
    });
  }

  // Arm 2
  if (arm2IsShort) {
    cells.push({ poly: [V, P2, P2ext, vO2], type: 'non-standard', meta: 'arm2-short' });
  } else {
    appendArmCells(cells, {
      origin: V, axis: d2, normal: n2, len: armB, nCells: nCells2, W: W,
      apartmentDepth: apartmentDepth,
      pivotAtStart: true,
      placeLLU: primaryIsArm2, lluCount: lluCount
    });
  }

  // Pivot — corridor L-strip in the middle, both corner blocks are
  // non-standard. The corridor in the pivot connects to the long-arm
  // corridor on the M side; on the W side of mixed corners it
  // visually terminates at the W-arm boundary.
  cells.push({ poly: [V, Vin1, Min, Vin2],                       type: 'non-standard', meta: 'inner-pivot' });
  cells.push({ poly: [Vin1, Min, Vin2, Vout2, Mout, Vout1],       type: 'corridor',     meta: 'pivot-corridor' });
  cells.push({ poly: [Vout1, Mout, Vout2, vO2, I, vO1],           type: 'non-standard', meta: 'outer-pivot' });

  return { cells: cells, outline: [P1, V, P2, P2ext, I, P1ext] };
}

// ── Primary-arm layout ─────────────────────────────────

/**
 * Lay out cells along one arm. End cell at the polyline endpoint
 * trims the corridor; LLU sits on the cells nearest the corner V,
 * on the corridor's north side; the cells across the corridor are
 * regular apartments. Any non-3.3 residual is captured at one of the
 * two ends so no gap remains.
 */
function appendArmCells(out, p) {
  var origin = p.origin, axis = p.axis, normal = p.normal;
  var nCells = p.nCells, len = p.len, W = p.W;
  var apartmentDepth = p.apartmentDepth;
  var pivotAtStart = p.pivotAtStart;
  var placeLLU = !!p.placeLLU;
  var lluCount = p.lluCount;

  var corrFrom = apartmentDepth;
  var corrTo = apartmentDepth + CORRIDOR_WIDTH;

  // End cell index — the cell at the polyline endpoint side.
  var endIdx = pivotAtStart ? nCells - 1 : 0;

  // LLU range — `lluCount` cells closest to V. Skip the end cell so
  // a corridor-trimming header always survives.
  var lluFrom = -1, lluTo = -1;
  if (placeLLU && nCells > lluCount) {
    if (pivotAtStart) {
      // V at index 0; LLU at indices 0..lluCount-1.
      lluFrom = 0;
      lluTo = lluCount;
    } else {
      // V at index nCells-1; LLU at the last lluCount cells.
      lluFrom = nCells - lluCount;
      lluTo = nCells;
    }
  }

  // North side: if the perpendicular normal points (more or less) to
  // the north, far cells are north — LLU goes on far. Otherwise near.
  // Mirrors getNorthSide in modules/section-gen/cells.js.
  var lluOnFar = normal[1] > 0;

  for (var i = 0; i < nCells; i++) {
    var t0 = i * CELL_MODULE;
    var t1 = (i + 1) * CELL_MODULE;
    var p0 = vAdd(origin, vSc(axis, t0));
    var p1 = vAdd(origin, vSc(axis, t1));

    if (i === endIdx) {
      out.push({ poly: strip(p0, p1, normal, 0, W), type: 'apartment', meta: 'end' });
      continue;
    }

    var inLLU = (i >= lluFrom && i < lluTo);

    var pNear = strip(p0, p1, normal, 0, corrFrom);
    var pCorr = strip(p0, p1, normal, corrFrom, corrTo);
    var pFar  = strip(p0, p1, normal, corrTo, W);

    if (inLLU && !lluOnFar) out.push({ poly: pNear, type: 'llu', meta: 'llu' });
    else                    out.push({ poly: pNear, type: 'apartment' });

    out.push({ poly: pCorr, type: 'corridor' });

    if (inLLU && lluOnFar) out.push({ poly: pFar, type: 'llu', meta: 'llu' });
    else                    out.push({ poly: pFar, type: 'apartment' });
  }

  // Residual — never drop, never leave a gap.
  //
  //   pivotAtStart=false (arm1) → tail is at the V (corner) end →
  //                                tag as non-standard so it merges
  //                                with the corner block visually.
  //   pivotAtStart=true  (arm2) → tail is at the P2 (polyline) end →
  //                                extend the corridor-trimming header
  //                                with another full-W apartment slice.
  var residualLen = len - nCells * CELL_MODULE;
  if (residualLen > 0.05) {
    var rt0 = nCells * CELL_MODULE;
    var rt1 = len;
    var rp0 = vAdd(origin, vSc(axis, rt0));
    var rp1 = vAdd(origin, vSc(axis, rt1));
    var poly = strip(rp0, rp1, normal, 0, W);
    if (!pivotAtStart) {
      out.push({ poly: poly, type: 'non-standard', meta: 'corner-residual' });
    } else {
      out.push({ poly: poly, type: 'apartment', meta: 'end-residual' });
    }
  }
}
