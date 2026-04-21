/**
 * UrbanBlockSolver — computes section/tower axes from a block polygon.
 *
 * Ported from U·B·SYSTEM React prototype.
 * Pipeline: extractEdges → classOri → assignCtx → sortPrio → prioTrim → boundTrim → distribute
 *
 * All geometry in meters (local projection).
 */

import { vSub, vAdd, vSc, vLen, vNorm, vDot, vPerp, vCross } from '../geo/vec2.js';
import { simplifyPolygon } from '../geo/PolygonSimplifier.js';

function ptIn(pt, poly) {
  var ins = false;
  for (var i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    var yi = poly[i][1], yj = poly[j][1];
    if (((yi > pt[1]) !== (yj > pt[1])) &&
        (pt[0] < (poly[j][0] - poly[i][0]) * (pt[1] - yi) / (yj - yi) + poly[i][0]))
      ins = !ins;
  }
  return ins;
}

function pCen(p) {
  var cx = 0, cy = 0;
  for (var i = 0; i < p.length; i++) { cx += p[i][0]; cy += p[i][1]; }
  return [cx / p.length, cy / p.length];
}

function segT(p1, p2, p3, p4) {
  var d1 = vSub(p2, p1), d2 = vSub(p4, p3), cr = vCross(d1, d2);
  if (Math.abs(cr) < 1e-10) return null;
  var d3 = vSub(p3, p1), t = vCross(d3, d2) / cr, u = vCross(d3, d1) / cr;
  if (t >= -1e-9 && t <= 1 + 1e-9 && u >= -1e-9 && u <= 1 + 1e-9)
    return Math.max(0, Math.min(1, t));
  return null;
}

function clipSeg(p1, p2, poly, inside) {
  var ts = [];
  for (var i = 0; i < poly.length; i++) {
    var t = segT(p1, p2, poly[i], poly[(i + 1) % poly.length]);
    if (t !== null) ts.push(t);
  }
  ts.sort(function (a, b) { return a - b; });
  var uTs = [0];
  for (var k = 0; k < ts.length; k++) {
    if (Math.abs(ts[k] - uTs[uTs.length - 1]) > 1e-9) uTs.push(ts[k]);
  }
  if (Math.abs(uTs[uTs.length - 1] - 1) > 1e-9) uTs.push(1);
  var segs = [], dir = vSub(p2, p1);
  for (var i2 = 0; i2 < uTs.length - 1; i2++) {
    var mid = (uTs[i2] + uTs[i2 + 1]) / 2;
    var isIn = ptIn(vAdd(p1, vSc(dir, mid)), poly);
    if (inside ? isIn : !isIn) {
      segs.push({ start: vAdd(p1, vSc(dir, uTs[i2])), end: vAdd(p1, vSc(dir, uTs[i2 + 1])) });
    }
  }
  return segs;
}

function subPolys(p1, p2, polys) {
  var segs = [{ start: p1, end: p2 }];
  for (var pi = 0; pi < polys.length; pi++) {
    var nx = [];
    for (var si = 0; si < segs.length; si++) {
      var seg = segs[si];
      if (vLen(vSub(seg.end, seg.start)) < 0.1) continue;
      var cl = clipSeg(seg.start, seg.end, polys[pi], false);
      for (var ci = 0; ci < cl.length; ci++) {
        if (vLen(vSub(cl[ci].end, cl[ci].start)) > 0.1) nx.push(cl[ci]);
      }
    }
    segs = nx;
  }
  return segs;
}

function longest(segs) {
  if (!segs.length) return null;
  var b = segs[0];
  for (var i = 1; i < segs.length; i++) {
    if (vLen(vSub(segs[i].end, segs[i].start)) > vLen(vSub(b.end, b.start))) b = segs[i];
  }
  return b;
}

// ── Edge extraction & classification ──────────────────

function extractEdges(p) {
  var e = [];
  for (var i = 0; i < p.length; i++) {
    var s = p[i], en = p[(i + 1) % p.length];
    var l = vLen(vSub(en, s));
    if (l > 0.5) e.push({ id: i, start: s, end: en, length: l });
  }
  return e;
}

function classOri(edges) {
  for (var i = 0; i < edges.length; i++) {
    var e = edges[i];
    var d = vNorm(vSub(e.end, e.start));
    e.dotP = Math.abs(vDot([0, 1], d));
    e.orientation = e.dotP >= 0.7 ? 1 : 0; // 1=merid, 0=lat
  }
  return edges;
}

function assignCtx(edges) {
  var s = edges.slice().sort(function (a, b) { return b.length - a.length; });
  for (var i = 0; i < s.length; i++) s[i].context = i < 1 ? 0 : i < 2 ? 1 : 2;
  return edges;
}

function sortPrio(edges) {
  return edges.slice().sort(function (a, b) {
    if (a.context !== b.context) return a.context - b.context;
    if (a.orientation !== b.orientation) return b.orientation - a.orientation;
    return b.length - a.length;
  });
}

// ── Offset & Buffer computation ───────────────────────

function calcOff(edge, poly, sw) {
  var d = vNorm(vSub(edge.end, edge.start));
  var pp = vPerp(d);
  var mid = vSc(vAdd(edge.start, edge.end), 0.5);
  var cen = pCen(poly);
  var t1 = vAdd(mid, vSc(pp, sw));
  var t2 = vAdd(mid, vSc(pp, -sw));
  var od;
  if (ptIn(t1, poly)) od = pp;
  else if (ptIn(t2, poly)) od = vSc(pp, -1);
  else od = vLen(vSub(t1, cen)) < vLen(vSub(t2, cen)) ? pp : vSc(pp, -1);
  return {
    od: od,
    oS: vAdd(edge.start, vSc(od, sw)),
    oE: vAdd(edge.end, vSc(od, sw))
  };
}

function makeBufs(edge, oi, par) {
  var S = edge.start, E = edge.end, od = oi.od;
  var oS = oi.oS, oE = oi.oE;
  var d = vNorm(vSub(E, S)), nod = vSc(od, -1);
  var fire = [vAdd(S, vSc(nod, par.fire)), vAdd(E, vSc(nod, par.fire)),
              vAdd(oE, vSc(od, par.fire)), vAdd(oS, vSc(od, par.fire))];
  var end = [vAdd(vAdd(S, vSc(d, -par.endB)), vSc(nod, par.endB)),
             vAdd(vAdd(E, vSc(d, par.endB)), vSc(nod, par.endB)),
             vAdd(vAdd(oE, vSc(d, par.endB)), vSc(od, par.endB)),
             vAdd(vAdd(oS, vSc(d, -par.endB)), vSc(od, par.endB))];
  var insol = [vAdd(S, vSc(nod, par.insol)), vAdd(E, vSc(nod, par.insol)),
               vAdd(oE, vSc(od, par.insol)), vAdd(oS, vSc(od, par.insol))];
  return { fire: fire, end: end, insol: insol, base: [S, E, oE, oS] };
}

// ── Priority Trimming ─────────────────────────────────

function prioTrim(sorted, poly, par) {
  var res = [], allBufs = [];
  for (var i = 0; i < sorted.length; i++) {
    var e = Object.assign({}, sorted[i]);
    var oi = calcOff(e, poly, par.sw);
    if (i === 0) {
      var b = makeBufs(e, oi, par);
      allBufs.push(b.fire, b.end, b.insol);
      res.push(Object.assign({}, e, { oi: oi, bufs: b, trimmed: false }));
      continue;
    }
    var segs = subPolys(oi.oS, oi.oE, allBufs);
    var best = longest(segs);
    if (!best || vLen(vSub(best.end, best.start)) < 3) {
      res.push(Object.assign({}, e, { length: 0, oi: oi, bufs: null, trimmed: true, removed: true }));
      continue;
    }
    var bk = vSc(oi.od, -par.sw);
    var nS = vAdd(best.start, bk), nE = vAdd(best.end, bk);
    var te = Object.assign({}, e, {
      start: nS, end: nE, length: vLen(vSub(nE, nS)), trimmed: true,
      origStart: e.start, origEnd: e.end, origLen: e.length
    });
    var nOi = calcOff(te, poly, par.sw);
    var b2 = makeBufs(te, nOi, par);
    allBufs.push(b2.fire, b2.end, b2.insol);
    res.push(Object.assign({}, te, { oi: nOi, bufs: b2 }));
  }
  return res;
}

function boundTrim(edges, poly, par) {
  for (var i = 0; i < edges.length; i++) {
    var e = edges[i];
    if (e.length < 1 || !e.oi) continue;
    var segs = clipSeg(e.oi.oS, e.oi.oE, poly, true);
    var best = longest(segs);
    if (!best) { e.length = 0; e.removed = true; continue; }
    var nl = vLen(vSub(best.end, best.start));
    var ol = vLen(vSub(e.oi.oE, e.oi.oS));
    if (Math.abs(nl - ol) < 0.5) continue;
    var bk = vSc(e.oi.od, -par.sw);
    if (!e.origStart) { e.origStart = e.start; e.origEnd = e.end; e.origLen = e.length; }
    e.start = vAdd(best.start, bk);
    e.end = vAdd(best.end, bk);
    e.length = vLen(vSub(e.end, e.start));
    e.trimmed = true;
    e.oi = calcOff(e, poly, par.sw);
    if (e.bufs) e.bufs = makeBufs(e, e.oi, par);
  }
  return edges;
}

// ── Section distribution ──────────────────────────────

function distribute(lens, axLen) {
  var sorted = lens.slice().sort(function (a, b) { return b - a; });
  var bc = sorted.map(function () { return 0; }), br = axLen;
  function tf(r, c, idx) {
    if (idx >= sorted.length) { if (r >= 0 && r < br) { bc = c.slice(); br = r; } return; }
    for (var k = Math.floor(r / sorted[idx]); k >= 0; k--) {
      c[idx] = k; var nr = r - sorted[idx] * k; if (nr >= 0) tf(nr, c, idx + 1);
    }
  }
  tf(axLen, sorted.map(function () { return 0; }), 0);
  return { counts: bc, rem: br, sorted: sorted };
}

function makeSectionSeq(allowedLens, axLen, gapTarget, useGap) {
  var r = distribute(allowedLens, axLen);
  var counts = r.counts, sorted = r.sorted;
  var res = [];
  for (var i = 0; i < counts.length; i++) {
    for (var j = 0; j < counts[i]; j++) res.push({ l: sorted[i], gap: false });
  }
  if (useGap && axLen >= 150 && res.length >= 4) {
    var removed = 0, mi = Math.floor(res.length / 2);
    while (removed < gapTarget && res.length > 2) {
      var rm = res.splice(mi, 1)[0]; removed += rm.l;
    }
    if (removed >= 20) {
      res.splice(Math.min(mi, res.length), 0, { l: removed, gap: true });
    } else {
      res = [];
      for (var i2 = 0; i2 < counts.length; i2++) {
        for (var j2 = 0; j2 < counts[i2]; j2++) res.push({ l: sorted[i2], gap: false });
      }
    }
  }
  return res.filter(function (s) {
    return s.gap || allowedLens.some(function (l) { return Math.abs(l - s.l) < 0.01; });
  });
}

// ── Tower distribution ────────────────────────────────

var TOWER_GAP = 20;

function makeTowerSeq(allowedLens, axLen) {
  var sorted = allowedLens.slice().sort(function (a, b) { return b - a; });
  var minL = sorted[sorted.length - 1];
  var bestSeq = null, bestUsed = 0;
  var maxT = Math.floor((axLen + TOWER_GAP) / (minL + TOWER_GAP));
  if (maxT < 1 && minL <= axLen) maxT = 1;

  for (var nt = 1; nt <= Math.min(maxT, 8); nt++) {
    var avail = axLen - (nt - 1) * TOWER_GAP;
    if (avail < minL * nt) continue;
    var bestCombo = null, bestComboUsed = 0;
    var tryCombo = function(remaining, count, combo) {
      if (count === nt) {
        var used = 0;
        for (var i = 0; i < combo.length; i++) used += combo[i];
        if (remaining >= 0 && used > bestComboUsed) { bestComboUsed = used; bestCombo = combo.slice(); }
        return;
      }
      for (var si = 0; si < sorted.length; si++) {
        if (sorted[si] <= remaining) {
          combo.push(sorted[si]);
          tryCombo(remaining - sorted[si], count + 1, combo);
          combo.pop();
        }
      }
    };
    tryCombo(avail, 0, []);
    if (bestCombo && bestComboUsed > bestUsed) { bestUsed = bestComboUsed; bestSeq = bestCombo; }
  }
  if (!bestSeq) { if (minL <= axLen) bestSeq = [minL]; else return []; }
  var result = [];
  for (var k = 0; k < bestSeq.length; k++) {
    result.push({ l: bestSeq[k], gap: false, tower: true });
    if (k < bestSeq.length - 1) result.push({ l: TOWER_GAP, gap: true, tower: false });
  }
  return result;
}

// ── Public API ────────────────────────────────────────

var DEFAULT_PARAMS = {
  sw: 18,        // section width (perpendicular) — 18м как в прототипе
  fire: 14,      // fire buffer
  endB: 20,      // end buffer
  insol: 30,     // insolation buffer
  gapTarget: 22, // gap target for long axes (only used when useGap=true)
  useGap: false, // insert a courtyard gap on axes >= 150m
  latLens: [24, 27],
  lonLens: [30, 36, 39, 42, 46, 49],
  towerLatLens: [23.1],
  towerLonLens: [23.1, 29.7, 39.6],
  simplify: null // polygon simplification — use Simplify button in properties
};

/**
 * Solve urban block: compute trimmed axes with sections/towers.
 *
 * @param {Array<[number,number]>} polyM - polygon vertices in meters (CCW)
 * @param {Object} [params] - override DEFAULT_PARAMS
 * @returns {Array<Object>} axes [{start, end, length, orientation, oi, secs, trimmed, removed, ...}]
 */
export function solveUrbanBlock(polyM, params) {
  if (!params) params = {};
  var par = {
    sw: params.sw || DEFAULT_PARAMS.sw,
    fire: params.fire || DEFAULT_PARAMS.fire,
    endB: params.endB || DEFAULT_PARAMS.endB,
    insol: params.insol || DEFAULT_PARAMS.insol
  };
  var gapTarget = params.gapTarget || DEFAULT_PARAMS.gapTarget;
  var useGap = params.useGap != null ? params.useGap : DEFAULT_PARAMS.useGap;
  var latLens = params.latLens || DEFAULT_PARAMS.latLens;
  var lonLens = params.lonLens || DEFAULT_PARAMS.lonLens;

  // Step 0: optional polygon simplification
  var simplifyOpts = params.simplify !== undefined ? params.simplify : DEFAULT_PARAMS.simplify;
  var workPoly = polyM;
  if (simplifyOpts && polyM.length > 4) {
    var sr = simplifyPolygon(polyM, simplifyOpts);
    workPoly = sr.simplified;
  }

  var edges = extractEdges(workPoly);
  edges = classOri(edges);

  // Context assignment — three modes in priority order:
  //   1. ctxOverride: explicit array from ContextOptimizer (highest priority)
  //   2. ctxRoll > 0: pseudo-random shuffle seeded by ctxRoll
  //   3. default: assignCtx by edge length (longest = context 0)
  var ctxOverride = params.ctxOverride;
  var ctxRoll = params.ctxRoll || 0;
  if (ctxOverride && ctxOverride.length === edges.length) {
    for (var co = 0; co < edges.length; co++) {
      edges[co].context = ctxOverride[co];
    }
  } else if (ctxRoll === 0) {
    edges = assignCtx(edges);
  } else {
    var seed = ctxRoll * 7919;
    for (var ci = 0; ci < edges.length; ci++) {
      seed = (seed * 16807) % 2147483647;
      edges[ci].context = Math.floor((seed / 2147483647) * 3);
    }
  }

  var sorted = sortPrio(edges);
  var trimmed = prioTrim(sorted, workPoly, par);
  trimmed = boundTrim(trimmed, workPoly, par);

  // Filter short edges
  for (var i = 0; i < trimmed.length; i++) {
    var e = trimmed[i];
    if (e.length < 1 || !e.oi || e.removed) continue;
    var lens = e.orientation === 0 ? latLens : lonLens;
    var minL = Infinity;
    for (var j = 0; j < lens.length; j++) { if (lens[j] < minL) minL = lens[j]; }
    if (e.length < minL) { e.length = 0; e.removed = true; }
  }

  // Distribute sections
  for (var i = 0; i < trimmed.length; i++) {
    var e = trimmed[i];
    if (e.removed || e.length < 3 || !e.oi) { e.secs = []; continue; }
    var lens = e.orientation === 0 ? latLens : lonLens;
    e.oriName = e.orientation === 0 ? 'lat' : 'lon';
    var seq = makeSectionSeq(lens, e.length, gapTarget, useGap);
    e.secs = seq;
  }

  return trimmed;
}

/**
 * Solve and return both axes and the (possibly simplified) polygon.
 * Use this when the caller needs the working polygon for overlays.
 *
 * @param {Array<[number,number]>} polyM
 * @param {Object} [params]
 * @returns {{ axes: Array<Object>, polyM: Array<[number,number]> }}
 */
export function solveUrbanBlockFull(polyM, params) {
  if (!params) params = {};
  var simplifyOpts = params.simplify !== undefined ? params.simplify : DEFAULT_PARAMS.simplify;
  var workPoly = polyM;
  if (simplifyOpts && polyM.length > 4) {
    var sr = simplifyPolygon(polyM, simplifyOpts);
    workPoly = sr.simplified;
  }
  // Pass simplify: null to avoid double-simplification
  var paramsNoSimp = {};
  for (var k in params) {
    if (params.hasOwnProperty(k)) paramsNoSimp[k] = params[k];
  }
  paramsNoSimp.simplify = null;

  // Use workPoly for solving — override polyM
  var axes = solveUrbanBlock(workPoly, paramsNoSimp);
  return { axes: axes, polyM: workPoly };
}

export { DEFAULT_PARAMS, makeTowerSeq };
