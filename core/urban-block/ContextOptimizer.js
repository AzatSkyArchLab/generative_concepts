/**
 * ContextOptimizer — brute-force / random search for best edge context assignment.
 *
 * Each edge gets a context (0=main, 1=boundary, 2=inner) that determines
 * priority trimming order. This optimizer tries combinations to maximize
 * the number of sections that fit.
 *
 * Ported from JSX prototype (autoOptimize / scorePipeline).
 */

// vec2 imports reserved for future use

/**
 * Score a context assignment: count sections and total length.
 *
 * @param {Array} baseEdges - edges from extractEdges+classOri
 * @param {Array<number>} ctxArr - context per edge (0/1/2)
 * @param {Array} poly - polygon vertices (meters)
 * @param {Object} par - {sw, fire, endB, insol}
 * @param {Array<number>} latLens - allowed latitudinal section lengths
 * @param {Array<number>} lonLens - allowed longitudinal section lengths
 * @param {Function} sortPrio - from UrbanBlockSolver
 * @param {Function} prioTrim - from UrbanBlockSolver
 * @param {Function} boundTrim - from UrbanBlockSolver
 * @param {Function} distribute - from UrbanBlockSolver
 * @returns {{secs: number, len: number}}
 */
export function scorePipeline(baseEdges, ctxArr, poly, par, latLens, lonLens, sortPrio, prioTrim, boundTrim, distribute) {
  var edges = [];
  for (var i = 0; i < baseEdges.length; i++) {
    edges.push(Object.assign({}, baseEdges[i], { context: ctxArr[i] }));
  }
  var sorted = sortPrio(edges);
  var trimmed = prioTrim(sorted, poly, par);
  trimmed = boundTrim(trimmed, poly, par);

  var totalSecs = 0, totalLen = 0;
  for (var ti = 0; ti < trimmed.length; ti++) {
    var e = trimmed[ti];
    if (e.length < 3 || !e.oi) continue;
    var lens = e.orientation === 0 ? latLens : lonLens;
    var minL = Infinity;
    for (var j = 0; j < lens.length; j++) { if (lens[j] < minL) minL = lens[j]; }
    if (e.length < minL) continue;
    var r = distribute(lens, e.length);
    for (var k = 0; k < r.counts.length; k++) {
      totalSecs += r.counts[k];
      totalLen += r.sorted[k] * r.counts[k];
    }
  }
  return { secs: totalSecs, len: totalLen };
}

/**
 * Find optimal context assignment via exhaustive or random search.
 *
 * For n≤6 edges (729 combos): exhaustive.
 * For n>6: 2000 random samples.
 *
 * @param {Array} baseEdges
 * @param {Array} poly
 * @param {Object} par
 * @param {Array<number>} latLens
 * @param {Array<number>} lonLens
 * @param {Function} sortPrio
 * @param {Function} prioTrim
 * @param {Function} boundTrim
 * @param {Function} distribute
 * @returns {Array<number>|null} best context array, or null if no improvement
 */
export function autoOptimize(baseEdges, poly, par, latLens, lonLens, sortPrio, prioTrim, boundTrim, distribute) {
  var n = baseEdges.length;
  if (n === 0) return null;

  var bestScore = -1, bestLen = 0, bestCtx = null;
  var total = 1;
  for (var p = 0; p < n; p++) total *= 3;
  var exhaustive = n <= 6;
  var iters = exhaustive ? total : 2000;

  for (var it = 0; it < iters; it++) {
    var ctxArr = [];
    if (exhaustive) {
      var tmp = it;
      for (var i = 0; i < n; i++) { ctxArr.push(tmp % 3); tmp = Math.floor(tmp / 3); }
    } else {
      for (var i2 = 0; i2 < n; i2++) ctxArr.push(Math.floor(Math.random() * 3));
    }
    var sc = scorePipeline(baseEdges, ctxArr, poly, par, latLens, lonLens, sortPrio, prioTrim, boundTrim, distribute);
    if (sc.secs > bestScore || (sc.secs === bestScore && sc.len > bestLen)) {
      bestScore = sc.secs; bestLen = sc.len; bestCtx = ctxArr.slice();
    }
  }
  return bestCtx;
}
