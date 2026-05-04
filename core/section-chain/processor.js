/**
 * Section-Chain processor — port of the prototype solver.
 *
 * Input: pts in meters (local plane), secWidth, secSide (+1/-1),
 *        cornersOn (bool), footprint (sq.m, 0 = no limit).
 * Output: { sections: [{poly, len, ori}], corners: [{poly, mode, ...}],
 *           gaps: [{poly, len}], totalGap }
 *   poly = array of {x, y} in meters.
 *   ori: 0 = W (latitudinal/широтный), 1 = M (meridional/меридиональный)
 *   mode: 'WW' | 'WM' | 'MW' | 'MM' for corners
 *
 * The algorithm is identical to the prototype: 1-seg single, 2-seg
 * mixed (MW/WM/MM), >=3-seg N-seg DP solver, fallback chains for
 * pure-W (WW) cycles. Geometry constants and lexicographic ranking
 * are unchanged.
 */

/* ── vec helpers ───────────────────────────────────────── */
function vec2(x, y) { return { x: x, y: y }; }
function vSub(a, b) { return vec2(a.x - b.x, a.y - b.y); }
function vAdd(a, b) { return vec2(a.x + b.x, a.y + b.y); }
function vSc(v, s) { return vec2(v.x * s, v.y * s); }
function vLen(v) { return Math.sqrt(v.x * v.x + v.y * v.y); }
function vNorm(v) { var l = vLen(v); return l > 1e-9 ? vec2(v.x / l, v.y / l) : vec2(0, 0); }
function vDot(a, b) { return a.x * b.x + a.y * b.y; }
function vCross(a, b) { return a.x * b.y - a.y * b.x; }

/* ── classifiers ───────────────────────────────────────── */
var ORI_THRESHOLD = 0.7;                 // solver threshold (~45.6°)
function classifySeg(a, b) {
  var d = vNorm(vSub(b, a));
  return Math.abs(vDot(vec2(0, 1), d)) >= ORI_THRESHOLD ? 1 : 0;
}

function calcAngleAt(prev, cur, next) {
  var dA = vNorm(vSub(prev, cur)), dC = vNorm(vSub(next, cur));
  if (vLen(dA) < 1e-9 || vLen(dC) < 1e-9) return null;
  var inner = Math.acos(Math.max(-1, Math.min(1, vDot(dA, dC))));
  var signCC = vCross(dA, dC) >= 0 ? 1 : -1;
  return { inner: inner, innerDeg: inner * 180 / Math.PI, signCC: signCC };
}

/* ── constants ─────────────────────────────────────────── */
var MAX_CORNER_DEG = 155;
var MIN_CORNER_DEG = 60;
var EPS = 1e-6;

// Cell module along a section axis is 3.3m. Corner arm sizes follow
// the same module so cells distribute cleanly along each arm with one
// non-standard "corner cell" left at the L-intersection.
var CELL_MODULE = 3.3;

// W-side arm in a WM / MW corner: 2 modules (= 6.6m). Used for the
// short, perpendicular arm of a mixed corner. Was 6.0 — now snapped to
// the 3.3 cell module so two 3.3m cells fit edge-to-edge.
var W_FIXED_ARM = 6.6;

// W-side arms in WW corners: multiples of 3.3 from one module up.
// Totals are pinned to {23.1, 26.4} = {7×3.3, 8×3.3} — the cleanest
// 3.3-aligned analogues of the legacy 24 / 27 section quanta.
var W_ARM_MIN = CELL_MODULE;
var W_ARM_STEP = CELL_MODULE;
var W_ARM_MAX = 7 * CELL_MODULE;         // 23.1
var WW_TOTALS = [7 * CELL_MODULE, 8 * CELL_MODULE]; // [23.1, 26.4]

var M_BASE = 30;
var ARM_SUM_MAX_DEFAULT = 54;            // WW, WM, MW
var ARM_SUM_MAX_MM = 60;                 // MM
var M_STEP = 3;
var DEFAULT_MAX_AREA = 550;
var FOOTPRINT_K = 0.65;
var HARD_MAX_AREA = DEFAULT_MAX_AREA / FOOTPRINT_K;  // ≈846.15
var M_HARD_MAX = 60;

function getMaxCornerArea(footprint) {
  if (footprint && footprint > 0) return Math.min(HARD_MAX_AREA, footprint * FOOTPRINT_K);
  return HARD_MAX_AREA;
}

function getMArms(width, maxArea) {
  var maxM_byArea = Math.floor((maxArea / width) / M_STEP + EPS) * M_STEP;
  var maxM = Math.min(maxM_byArea, M_HARD_MAX);
  var arr = [];
  for (var L = M_BASE; L <= maxM + EPS; L += M_STEP) arr.push(L);
  return arr;
}

function getMArmsForMixed(width, maxArea) {
  var base = getMArms(width, maxArea);
  var pref = [];
  if (24 * width * FOOTPRINT_K < DEFAULT_MAX_AREA + EPS) pref.push(24);
  if (27 * width * FOOTPRINT_K < DEFAULT_MAX_AREA + EPS) pref.push(27);
  return pref.concat(base);
}

/* ── extrusion helpers ─────────────────────────────────── */
function extrudeSeg(a, b, width, side) {
  var d = vNorm(vSub(b, a));
  var n = side > 0 ? vec2(-d.y, d.x) : vec2(d.y, -d.x);
  return [a, b, vAdd(b, vSc(n, width)), vAdd(a, vSc(n, width))];
}

function makeCornerPoly(A, B, C, armA, armB, width, side) {
  var d1 = vNorm(vSub(B, A)), d2 = vNorm(vSub(C, B));
  var crossD = vCross(d1, d2);
  if (Math.abs(crossD) < 1e-6) return null;
  var n1 = side > 0 ? vec2(-d1.y, d1.x) : vec2(d1.y, -d1.x);
  var n2 = side > 0 ? vec2(-d2.y, d2.x) : vec2(d2.y, -d2.x);
  var P1 = vAdd(B, vSc(d1, -armA));
  var V = B;
  var P2 = vAdd(B, vSc(d2, armB));
  var P1ext = vAdd(P1, vSc(n1, width));
  var P2ext = vAdd(P2, vSc(n2, width));
  var vO1 = vAdd(V, vSc(n1, width));
  var vO2 = vAdd(V, vSc(n2, width));

  if (side * crossD > 1e-6) {
    var rhs = vSub(P2, P1);
    var det = n1.x * (-n2.y) - (-n2.x) * n1.y;
    if (Math.abs(det) < 1e-9) return null;
    var t = (rhs.x * (-n2.y) - (-n2.x) * rhs.y) / det;
    var u = (n1.x * rhs.y - rhs.x * n1.y) / det;
    var tOK = t <= width + 1e-6;
    var uOK = u <= width + 1e-6;
    if (tOK && uOK) {
      var innerCorner = vAdd(P1, vSc(n1, t));
      return [vO2, V, vO1, P1ext, innerCorner, P2ext];
    } else if (!tOK && !uOK) {
      var denom2 = d1.x * d2.y - d1.y * d2.x;
      if (Math.abs(denom2) < 1e-9) return null;
      var dv = vSub(vO2, vO1);
      var s = (dv.x * d2.y - dv.y * d2.x) / denom2;
      var innerCornerExt = vAdd(vO1, vSc(d1, s));
      return [P1, V, P2, P2ext, innerCornerExt, P1ext];
    } else if (!tOK && uOK) {
      return [vO2, V, P2, P2ext];
    } else {
      return [P1, V, vO1, P1ext];
    }
  } else {
    var denom = d1.x * d2.y - d1.y * d2.x;
    if (Math.abs(denom) < 1e-9) return null;
    var dv2 = vSub(vO2, vO1);
    var tE = (dv2.x * d2.y - dv2.y * d2.x) / denom;
    var I = vAdd(vO1, vSc(d1, tE));
    return [P1, V, P2, P2ext, I, P1ext];
  }
}

function polyArea(poly) {
  if (!poly || poly.length < 3) return 0;
  var s = 0;
  for (var i = 0; i < poly.length; i++) {
    var p = poly[i], q = poly[(i + 1) % poly.length];
    s += p.x * q.y - q.x * p.y;
  }
  return Math.abs(s) / 2;
}

/* ── DP layouts ────────────────────────────────────────── */
function bestSumP(L) {
  // max k*27 + m*24 ≤ L, with k = b, m = a
  var best = 0, bestA = 0, bestB = 0;
  for (var b = 0; b * 27 <= L + EPS; b++) {
    for (var a = 0; a * 24 + b * 27 <= L + EPS; a++) {
      var s = a * 24 + b * 27;
      if (s > best + EPS) { best = s; bestA = a; bestB = b; }
    }
  }
  return { sum: best, a: bestA, b: bestB };
}

function bestSumPLens(L, allowedLens) {
  if (L <= 0 || !allowedLens || allowedLens.length === 0) return { sum: 0, counts: {} };
  var minLen = Infinity;
  for (var ml = 0; ml < allowedLens.length; ml++) if (allowedLens[ml] < minLen) minLen = allowedLens[ml];
  if (L < minLen - EPS) return { sum: 0, counts: {} };
  var N = Math.floor(L + EPS);
  var dpSum = new Array(N + 1);
  var dpUse = new Array(N + 1);
  dpSum[0] = 0; dpUse[0] = 0;
  for (var i = 1; i <= N; i++) {
    dpSum[i] = dpSum[i - 1]; dpUse[i] = 0;
    for (var j = 0; j < allowedLens.length; j++) {
      var len = allowedLens[j];
      if (i >= len) {
        var c = dpSum[i - len] + len;
        if (c > dpSum[i]) { dpSum[i] = c; dpUse[i] = len; }
      }
    }
  }
  var counts = {}; var k = N;
  while (k > 0) {
    if (dpUse[k] === 0) { k--; continue; }
    counts[dpUse[k]] = (counts[dpUse[k]] || 0) + 1;
    k -= dpUse[k];
  }
  return { sum: dpSum[N], counts: counts };
}

function countTotal(counts) { var t = 0; for (var k in counts) t += counts[k]; return t; }

function bestSumForOri(L, ori, width, maxArea) {
  if (L <= 0) return { sum: 0, counts: {} };
  if (ori === 0) {
    var bsp = bestSumP(L);
    return { sum: bsp.sum, counts: { 27: bsp.b, 24: bsp.a } };
  }
  return bestSumPLens(L, getMArms(width, maxArea));
}

/* ── corner-pair enumeration (any ori combination) ─────── */
function enumerateCornerPairs(oriIn, oriOut, width, maxArea) {
  var bothW = oriIn === 0 && oriOut === 0;
  var bothM = oriIn === 1 && oriOut === 1;
  var pairs = [];
  if (bothW) {
    // Both arms in 3.3-module steps from W_ARM_MIN to W_ARM_MAX. Totals
    // are aligned to the same module so any (aA, aB) pair stays on grid
    // and the perimeter cells fit edge-to-edge along both arms.
    for (var ti = 0; ti < WW_TOTALS.length; ti++) {
      var t = WW_TOTALS[ti];
      for (var aA = W_ARM_MIN; aA <= W_ARM_MAX + EPS; aA += W_ARM_STEP) {
        var aB = t - aA;
        if (aB < W_ARM_MIN - EPS || aB > W_ARM_MAX + EPS) continue;
        // Numeric robustness: ensure aB lands on the 3.3 grid.
        var k = aB / CELL_MODULE;
        if (Math.abs(k - Math.round(k)) > 0.01) continue;
        if (aA + aB > ARM_SUM_MAX_DEFAULT + EPS) continue;
        pairs.push({ armA: aA, armB: aB, mode: 'WW' });
      }
    }
  } else if (bothM) {
    var mLensM = getMArms(width, maxArea);
    for (var ai = 0; ai < mLensM.length; ai++) {
      for (var bi = 0; bi < mLensM.length; bi++) {
        if (mLensM[ai] + mLensM[bi] > ARM_SUM_MAX_MM + EPS) continue;
        pairs.push({ armA: mLensM[ai], armB: mLensM[bi], mode: 'MM' });
      }
    }
  } else if (oriIn === 0 && oriOut === 1) {
    var mLensMx1 = getMArmsForMixed(width, maxArea);
    for (var k = 0; k < mLensMx1.length; k++) {
      if (W_FIXED_ARM + mLensMx1[k] > ARM_SUM_MAX_DEFAULT + EPS) continue;
      pairs.push({ armA: W_FIXED_ARM, armB: mLensMx1[k], mode: 'WM' });
    }
  } else {
    var mLensMx2 = getMArmsForMixed(width, maxArea);
    for (var k2 = 0; k2 < mLensMx2.length; k2++) {
      if (mLensMx2[k2] + W_FIXED_ARM > ARM_SUM_MAX_DEFAULT + EPS) continue;
      pairs.push({ armA: mLensMx2[k2], armB: W_FIXED_ARM, mode: 'MW' });
    }
  }
  return pairs;
}

function buildAngleInfo(pBefore, pVertex, pAfter, width, side) {
  var ang = calcAngleAt(pBefore, pVertex, pAfter);
  if (!ang) return null;
  var d1 = vNorm(vSub(pVertex, pBefore));
  var d2 = vNorm(vSub(pAfter, pVertex));
  var crossD = vCross(d1, d2);
  var drawnIsShort = side * crossD < -1e-6;
  var alpha = ang.innerDeg * Math.PI / 180;
  var bump = width * Math.tan((Math.PI - alpha) / 2);
  return {
    deg: ang.innerDeg,
    drawnIsShort: drawnIsShort,
    bump: bump,
    valid: ang.innerDeg >= MIN_CORNER_DEG && ang.innerDeg <= MAX_CORNER_DEG
  };
}

/* ── 2-seg MW/WM/MM solver ─────────────────────────────── */
function solveMW(seg0, seg1, drawnIsShort, bump, width, side, footprint) {
  var maxArea = getMaxCornerArea(footprint);
  var mLens = getMArms(width, maxArea);
  var mLensMixed = getMArmsForMixed(width, maxArea);
  if (mLens.length === 0 && mLensMixed.length === 0) return null;

  var s0W = seg0.ori === 0, s1W = seg1.ori === 0;
  var modeMM = !s0W && !s1W;
  var L1 = seg0.len, L2 = seg1.len;
  var L1short = drawnIsShort ? L1 : (L1 - bump);
  var L2short = drawnIsShort ? L2 : (L2 - bump);

  var lensW = [27, 24];
  var lens0 = s0W ? lensW : mLens;
  var lens1 = s1W ? lensW : mLens;

  function bestSumLocal(L, lens) {
    if (lens === lensW) {
      var bsp = bestSumP(L);
      return { sum: bsp.sum, counts: { 27: bsp.b, 24: bsp.a } };
    }
    return bestSumPLens(L, lens);
  }

  var pairs = [];
  if (modeMM) {
    for (var aa = 0; aa < mLens.length; aa++)
      for (var bb = 0; bb < mLens.length; bb++)
        pairs.push({ armA: mLens[aa], armB: mLens[bb], mode: 'MM' });
  } else if (s0W && !s1W) {
    for (var k1 = 0; k1 < mLensMixed.length; k1++)
      pairs.push({ armA: W_FIXED_ARM, armB: mLensMixed[k1], mode: 'WM' });
  } else if (!s0W && s1W) {
    for (var k2 = 0; k2 < mLensMixed.length; k2++)
      pairs.push({ armA: mLensMixed[k2], armB: W_FIXED_ARM, mode: 'MW' });
  } else {
    return null;
  }

  var armSumMax = modeMM ? ARM_SUM_MAX_MM : ARM_SUM_MAX_DEFAULT;
  var best = null;
  for (var pi = 0; pi < pairs.length; pi++) {
    var armA = pairs[pi].armA, armB = pairs[pi].armB, mode = pairs[pi].mode;
    if (armA + armB > armSumMax + EPS) continue;
    if (armA > L1short + EPS || armB > L2short + EPS) continue;
    var occA = drawnIsShort ? armA : (armA + bump);
    var occB = drawnIsShort ? armB : (armB + bump);
    if (L1 - occA < -EPS || L2 - occB < -EPS) continue;
    var cPoly = makeCornerPoly(seg0.a, seg0.b, seg1.b, occA, occB, width, side);
    if (!cPoly) continue;
    var cArea = polyArea(cPoly);
    var sp1 = bestSumLocal(L1 - occA, lens0);
    var sp2 = bestSumLocal(L2 - occB, lens1);
    var g1 = (L1 - occA) - sp1.sum;
    var g2 = (L2 - occB) - sp2.sum;
    var totGap = g1 + g2;
    var nStr = countTotal(sp1.counts) + countTotal(sp2.counts);
    var asymm = Math.abs(armA - armB);
    var cand = {
      armA: armA, armB: armB, total: armA + armB, mode: mode,
      occA: occA, occB: occB, drawnIsShort: drawnIsShort, bump: bump,
      sp1: sp1, sp2: sp2, g1: g1, g2: g2, totGap: totGap, nStr: nStr,
      asymm: asymm, cornerArea: cArea
    };
    var better = false;
    if (best === null) better = true;
    else if (cand.totGap < best.totGap - EPS) better = true;
    else if (Math.abs(cand.totGap - best.totGap) < EPS) {
      if (cand.nStr > best.nStr) better = true;
      else if (cand.nStr === best.nStr) {
        if (cand.asymm < best.asymm - EPS) better = true;
        else if (Math.abs(cand.asymm - best.asymm) < EPS && cand.cornerArea < best.cornerArea - EPS) better = true;
      }
    }
    if (better) best = cand;
  }
  return best;
}

function renderMW(plan, seg0, seg1, width, side, out) {
  if (!plan) return;
  var L1 = seg0.len, L2 = seg1.len;

  var sum1 = plan.sp1.sum;
  var endStraights1 = L1 - plan.occA;
  var startStraights1 = endStraights1 - sum1;

  if (plan.g1 > 0.5) {
    var gpa = vAdd(seg0.a, vSc(vSub(seg0.b, seg0.a), 0));
    var gpb = vAdd(seg0.a, vSc(vSub(seg0.b, seg0.a), startStraights1 / L1));
    out.gaps.push({ poly: extrudeSeg(gpa, gpb, width, side), len: plan.g1, segIdx: 0 });
  }

  var pos = startStraights1;
  var keys0 = Object.keys(plan.sp1.counts).map(Number).sort(function (a, b) { return b - a; });
  for (var ki = 0; ki < keys0.length; ki++) {
    var L = keys0[ki];
    for (var ni = 0; ni < plan.sp1.counts[L]; ni++) {
      var t0 = pos / L1, t1 = (pos + L) / L1;
      var pa = vAdd(seg0.a, vSc(vSub(seg0.b, seg0.a), t0));
      var pb = vAdd(seg0.a, vSc(vSub(seg0.b, seg0.a), t1));
      out.sections.push({ poly: extrudeSeg(pa, pb, width, side), len: L, ori: seg0.ori, segIdx: 0 });
      pos += L;
    }
  }

  var cp = makeCornerPoly(seg0.a, seg0.b, seg1.b, plan.occA, plan.occB, width, side);
  if (cp) out.corners.push({
    poly: cp, mode: plan.mode,
    armA_std: plan.armA, armA_actual: plan.armA, armB: plan.armB,
    totalLen: plan.total, extended: false, vertex: seg0.b, vertexIdx: 1
  });

  var sum2 = plan.sp2.sum;
  var startStraights2 = plan.occB;
  var endStraights2 = startStraights2 + sum2;
  var pos2 = startStraights2;
  var keys1 = Object.keys(plan.sp2.counts).map(Number).sort(function (a, b) { return b - a; });
  for (var kj = 0; kj < keys1.length; kj++) {
    var L1k = keys1[kj];
    for (var nj = 0; nj < plan.sp2.counts[L1k]; nj++) {
      var t02 = pos2 / L2, t12 = (pos2 + L1k) / L2;
      var pa2 = vAdd(seg1.a, vSc(vSub(seg1.b, seg1.a), t02));
      var pb2 = vAdd(seg1.a, vSc(vSub(seg1.b, seg1.a), t12));
      out.sections.push({ poly: extrudeSeg(pa2, pb2, width, side), len: L1k, ori: seg1.ori, segIdx: 1 });
      pos2 += L1k;
    }
  }

  if (plan.g2 > 0.5) {
    var t0g2 = endStraights2 / L2;
    if (t0g2 < 1 - 1e-6) {
      var gpa2 = vAdd(seg1.a, vSc(vSub(seg1.b, seg1.a), t0g2));
      out.gaps.push({ poly: extrudeSeg(gpa2, seg1.b, width, side), len: plan.g2, segIdx: 1 });
    }
  }
  out.totalGap += plan.totGap;
}

/* ── N-segment DP solver (3+ segments) ─────────────────── */
function solveN(segs, pts, width, side, footprint, cornersOn) {
  var N = segs.length;
  if (N < 2) return null;
  var maxArea = getMaxCornerArea(footprint);

  var angleInfos = [];
  var pairsList = [];
  for (var ai = 0; ai < N - 1; ai++) {
    var info = buildAngleInfo(pts[ai], pts[ai + 1], pts[ai + 2], width, side);
    angleInfos.push(info);
    var pairs = (info && info.valid && cornersOn) ? enumerateCornerPairs(segs[ai].ori, segs[ai + 1].ori, width, maxArea) : [];
    pairs.push({ armA: 0, armB: 0, mode: 'none' });
    pairsList.push(pairs);
  }

  function occA(armA, info) { return info.drawnIsShort ? armA : (armA + info.bump); }
  function occB(armB, info) { return info.drawnIsShort ? armB : (armB + info.bump); }

  var memo = {};
  function solveFrom(i, prevOccB) {
    var key = i + ':' + prevOccB.toFixed(3);
    if (memo[key] !== undefined) return memo[key];
    var seg = segs[i];

    if (i === N - 1) {
      var rem = seg.len - prevOccB;
      if (rem < -EPS) return memo[key] = null;
      var sp = bestSumForOri(rem, seg.ori, width, maxArea);
      var g = rem - sp.sum;
      return memo[key] = {
        totGap: g, nCorners: 0, nStr: countTotal(sp.counts), totAsymm: 0,
        choices: [], straights: [sp]
      };
    }

    var pairs = pairsList[i];
    var info = angleInfos[i];
    var best = null;

    for (var pi = 0; pi < pairs.length; pi++) {
      var p = pairs[pi];
      var occAv = p.mode === 'none' ? 0 : (info ? occA(p.armA, info) : 0);
      var occBv = p.mode === 'none' ? 0 : (info ? occB(p.armB, info) : 0);
      var rem = seg.len - prevOccB - occAv;
      if (rem < -EPS) continue;
      var sub = solveFrom(i + 1, occBv);
      if (!sub) continue;
      var sp = bestSumForOri(rem, seg.ori, width, maxArea);
      var g = rem - sp.sum;
      var asymm = p.mode === 'none' ? 0 : Math.abs(p.armA - p.armB);
      var cand = {
        totGap: g + sub.totGap,
        nCorners: (p.mode === 'none' ? 0 : 1) + sub.nCorners,
        nStr: countTotal(sp.counts) + sub.nStr,
        totAsymm: asymm + sub.totAsymm,
        choices: [p].concat(sub.choices),
        straights: [sp].concat(sub.straights)
      };
      var better = false;
      if (best === null) better = true;
      else if (cand.nCorners > best.nCorners) better = true;
      else if (cand.nCorners === best.nCorners) {
        if (cand.totGap < best.totGap - EPS) better = true;
        else if (Math.abs(cand.totGap - best.totGap) < EPS) {
          if (cand.nStr > best.nStr) better = true;
          else if (cand.nStr === best.nStr && cand.totAsymm < best.totAsymm - EPS) better = true;
        }
      }
      if (better) best = cand;
    }
    return memo[key] = best;
  }

  var solution = solveFrom(0, 0);
  if (!solution) return null;
  return {
    choices: solution.choices,
    straights: solution.straights,
    angleInfos: angleInfos,
    totGap: solution.totGap,
    nCorners: solution.nCorners,
    nStr: solution.nStr,
    totAsymm: solution.totAsymm
  };
}

function renderN(plan, segs, pts, width, side, out) {
  if (!plan) return;
  var N = segs.length;
  var ABSORB_THRESHOLD = 15;

  function expandKeys(counts) {
    var keys = Object.keys(counts).map(Number).sort(function (a, b) { return b - a; });
    var arr = [];
    for (var i = 0; i < keys.length; i++) for (var j = 0; j < counts[keys[i]]; j++) arr.push(keys[i]);
    return arr;
  }
  function placeStraight(seg, posStart, L, segLen) {
    var t0 = posStart / segLen, t1 = (posStart + L) / segLen;
    var pa = vAdd(seg.a, vSc(vSub(seg.b, seg.a), t0));
    var pb = vAdd(seg.a, vSc(vSub(seg.b, seg.a), t1));
    out.sections.push({ poly: extrudeSeg(pa, pb, width, side), len: L, ori: seg.ori, segIdx: seg.idx });
  }

  function occAFor(armA, info) { return info.drawnIsShort ? armA : (armA + info.bump); }
  function occBFor(armB, info) { return info.drawnIsShort ? armB : (armB + info.bump); }

  var actualOccA = new Array(N - 1);
  var actualOccB = new Array(N - 1);
  var actualArmA = new Array(N - 1);
  var absorbedAmt = new Array(N - 1);

  for (var v = 0; v < N - 1; v++) {
    var pair = plan.choices[v];
    var info = plan.angleInfos[v];
    if (pair.mode === 'none') {
      actualOccA[v] = 0; actualOccB[v] = 0;
      actualArmA[v] = 0; absorbedAmt[v] = 0;
      continue;
    }
    actualOccA[v] = occAFor(pair.armA, info);
    actualOccB[v] = occBFor(pair.armB, info);
    actualArmA[v] = pair.armA;
    absorbedAmt[v] = 0;
  }

  for (var ii = 0; ii < N - 1; ii++) {
    var pair2 = plan.choices[ii];
    if (pair2.mode === 'none') continue;
    var prevOccB = ii > 0 ? actualOccB[ii - 1] : 0;
    var nextOccA = actualOccA[ii];
    var seg = segs[ii];
    var sp = plan.straights[ii];
    var rem = seg.len - prevOccB - nextOccA;
    var gap = rem - sp.sum;
    if (gap <= 0.5 || gap >= ABSORB_THRESHOLD - EPS) continue;
    var canStretch = !(pair2.mode === 'WM' && pair2.armA === W_FIXED_ARM);
    if (!canStretch) continue;
    var deltaArm = gap;
    actualArmA[ii] = pair2.armA + deltaArm;
    actualOccA[ii] = nextOccA + deltaArm;
    absorbedAmt[ii] = gap;
  }

  for (var i2 = 0; i2 < N; i2++) {
    var seg2 = segs[i2];
    var L = seg2.len;
    var prevOccB2 = i2 > 0 ? actualOccB[i2 - 1] : 0;
    var nextOccA2 = i2 < N - 1 ? actualOccA[i2] : 0;
    var sp2 = plan.straights[i2];
    var sum = sp2.sum;
    var rem2 = L - prevOccB2 - nextOccA2;
    var gap2 = rem2 - sum;
    if (gap2 < -EPS) gap2 = 0;
    var lens = expandKeys(sp2.counts);

    if (i2 === 0 && N > 1) {
      var startStraights = (L - nextOccA2) - sum;
      if (gap2 > 0.5) {
        var gpa = vAdd(seg2.a, vSc(vSub(seg2.b, seg2.a), 0));
        var gpb = vAdd(seg2.a, vSc(vSub(seg2.b, seg2.a), startStraights / L));
        out.gaps.push({ poly: extrudeSeg(gpa, gpb, width, side), len: gap2, segIdx: i2 });
      }
      var pos = startStraights;
      for (var ki = 0; ki < lens.length; ki++) { placeStraight(seg2, pos, lens[ki], L); pos += lens[ki]; }
    } else if (i2 === N - 1) {
      var pos2 = prevOccB2;
      for (var kj = 0; kj < lens.length; kj++) { placeStraight(seg2, pos2, lens[kj], L); pos2 += lens[kj]; }
      if (gap2 > 0.5) {
        var gpa2 = vAdd(seg2.a, vSc(vSub(seg2.b, seg2.a), pos2 / L));
        out.gaps.push({ poly: extrudeSeg(gpa2, seg2.b, width, side), len: gap2, segIdx: i2 });
      }
    } else {
      var pos3 = prevOccB2;
      for (var km = 0; km < lens.length; km++) { placeStraight(seg2, pos3, lens[km], L); pos3 += lens[km]; }
      if (gap2 > 0.5) {
        var endBeforeCorner = L - nextOccA2;
        if (endBeforeCorner > pos3 + 1e-6) {
          var gpa3 = vAdd(seg2.a, vSc(vSub(seg2.b, seg2.a), pos3 / L));
          var gpb3 = vAdd(seg2.a, vSc(vSub(seg2.b, seg2.a), endBeforeCorner / L));
          out.gaps.push({ poly: extrudeSeg(gpa3, gpb3, width, side), len: gap2, segIdx: i2 });
        }
      }
    }
  }

  for (var v2 = 0; v2 < N - 1; v2++) {
    var pair3 = plan.choices[v2];
    if (pair3.mode === 'none') continue;
    var cp = makeCornerPoly(segs[v2].a, segs[v2].b, segs[v2 + 1].b, actualOccA[v2], actualOccB[v2], width, side);
    if (cp) out.corners.push({
      poly: cp, mode: pair3.mode,
      armA_std: pair3.armA, armA_actual: actualArmA[v2], armB: pair3.armB,
      totalLen: actualArmA[v2] + pair3.armB,
      extended: actualArmA[v2] !== pair3.armA,
      vertex: segs[v2].b, vertexIdx: v2 + 1, absorbed: absorbedAmt[v2]
    });
  }

  var actualTotGap = 0;
  for (var ig = 0; ig < N; ig++) {
    var sg = segs[ig];
    var po = ig > 0 ? actualOccB[ig - 1] : 0;
    var no = ig < N - 1 ? actualOccA[ig] : 0;
    var rm = sg.len - po - no;
    var gp = rm - plan.straights[ig].sum;
    if (gp > 0) actualTotGap += gp;
  }
  out.totalGap += actualTotGap;
}

/* ── Single-segment fallback ───────────────────────────── */
function processSingle(seg, width, side, footprint, out) {
  var sIsW = seg.ori === 0;
  var maxArea1 = getMaxCornerArea(footprint);
  var lensSingle;
  if (sIsW) {
    var bspW1 = bestSumP(seg.len);
    lensSingle = { sum: bspW1.sum, counts: { 27: bspW1.b, 24: bspW1.a } };
  } else {
    lensSingle = bestSumPLens(seg.len, getMArms(width, maxArea1));
  }
  var pos1 = 0;
  var keys1 = Object.keys(lensSingle.counts).map(Number).sort(function (a, b) { return b - a; });
  for (var k1i = 0; k1i < keys1.length; k1i++) {
    var L1k = keys1[k1i];
    for (var n1i = 0; n1i < lensSingle.counts[L1k]; n1i++) {
      var t01 = pos1 / seg.len, t11 = (pos1 + L1k) / seg.len;
      var pa1 = vAdd(seg.a, vSc(vSub(seg.b, seg.a), t01));
      var pb1 = vAdd(seg.a, vSc(vSub(seg.b, seg.a), t11));
      out.sections.push({ poly: extrudeSeg(pa1, pb1, width, side), len: L1k, ori: seg.ori, segIdx: 0 });
      pos1 += L1k;
    }
  }
  var gap1 = seg.len - lensSingle.sum;
  if (gap1 > 0.5) {
    var t0g1 = pos1 / seg.len;
    var gpa1 = vAdd(seg.a, vSc(vSub(seg.b, seg.a), t0g1));
    out.gaps.push({ poly: extrudeSeg(gpa1, seg.b, width, side), len: gap1, segIdx: 0 });
    out.totalGap += gap1;
  }
}

function fallbackStraights(segs, width, side, footprint, out) {
  var maxArea = getMaxCornerArea(footprint);
  for (var fi = 0; fi < segs.length; fi++) {
    var sg = segs[fi];
    var sp = bestSumForOri(sg.len, sg.ori, width, maxArea);
    var pos = 0;
    var keys = Object.keys(sp.counts).map(Number).sort(function (a, b) { return b - a; });
    for (var kk = 0; kk < keys.length; kk++) {
      var Lk = keys[kk];
      for (var nn = 0; nn < sp.counts[Lk]; nn++) {
        var t0 = pos / sg.len, t1 = (pos + Lk) / sg.len;
        var pa = vAdd(sg.a, vSc(vSub(sg.b, sg.a), t0));
        var pb = vAdd(sg.a, vSc(vSub(sg.b, sg.a), t1));
        out.sections.push({ poly: extrudeSeg(pa, pb, width, side), len: Lk, ori: sg.ori, segIdx: fi });
        pos += Lk;
      }
    }
    var gp = sg.len - sp.sum;
    if (gp > 0.5) {
      var t0g = pos / sg.len;
      var gpa = vAdd(sg.a, vSc(vSub(sg.b, sg.a), t0g));
      out.gaps.push({ poly: extrudeSeg(gpa, sg.b, width, side), len: gp, segIdx: fi });
      out.totalGap += gp;
    }
  }
}

/* ── Public entry point ────────────────────────────────── */
export function processPolyline(pts, opts) {
  opts = opts || {};
  var width = opts.width != null ? opts.width : 15;
  var side = opts.side != null ? opts.side : 1;
  var cornersOn = opts.cornersOn !== false;
  var footprint = opts.footprint || 0;

  var segs = [];
  for (var i = 0; i < pts.length - 1; i++) {
    var len = vLen(vSub(pts[i + 1], pts[i]));
    var ori = classifySeg(pts[i], pts[i + 1]);
    segs.push({ a: pts[i], b: pts[i + 1], ori: ori, len: len, idx: i });
  }

  var out = { sections: [], corners: [], gaps: [], totalGap: 0 };
  if (segs.length === 0) return out;

  if (segs.length === 1) {
    processSingle(segs[0], width, side, footprint, out);
    return out;
  }

  // 2-seg with at least one M → MW/WM/MM solver
  if (segs.length === 2 && (segs[0].ori === 1 || segs[1].ori === 1)) {
    var ang = calcAngleAt(pts[0], pts[1], pts[2]);
    var angleOk = ang && ang.innerDeg <= MAX_CORNER_DEG && ang.innerDeg >= MIN_CORNER_DEG;
    if (cornersOn && angleOk) {
      var d1c = vNorm(vSub(pts[1], pts[0]));
      var d2c = vNorm(vSub(pts[2], pts[1]));
      var crossC = vCross(d1c, d2c);
      var drawnIsShort = side * crossC < -1e-6;
      var alpha = ang.innerDeg * Math.PI / 180;
      var bump = width * Math.tan((Math.PI - alpha) / 2);
      var mwPlan = solveMW(segs[0], segs[1], drawnIsShort, bump, width, side, footprint);
      if (mwPlan) {
        renderMW(mwPlan, segs[0], segs[1], width, side, out);
        return out;
      }
    }
    fallbackStraights(segs, width, side, footprint, out);
    return out;
  }

  // 3+ segments → universal N-seg solver
  if (segs.length >= 3) {
    var nPlan = solveN(segs, pts, width, side, footprint, cornersOn);
    if (nPlan) {
      renderN(nPlan, segs, pts, width, side, out);
      return out;
    }
    fallbackStraights(segs, width, side, footprint, out);
    return out;
  }

  // 2-seg WW → use N-seg solver (handles 2 with one corner just fine)
  var wPlan = solveN(segs, pts, width, side, footprint, cornersOn);
  if (wPlan) renderN(wPlan, segs, pts, width, side, out);
  else fallbackStraights(segs, width, side, footprint, out);
  return out;
}

export { classifySeg };
