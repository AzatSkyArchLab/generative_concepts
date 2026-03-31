/**
 * QuotaResolver — Phase 0 of apartment packing.
 *
 * Given total cell count C and target area percentages per type,
 * find the integer vector Q = (n1K, n2K, n3K, n4K) such that:
 *   sum( n_t * w(t) ) = C       (all cells occupied)
 *   n_t * w(t) / C  ≈  alpha_t  (close to target percentages)
 *   n_t >= 0, integer
 *
 * This is finding the nearest integer point on a hyperplane
 * to a target vector — a small Diophantine problem.
 *
 * Pure math, no geometry, no insolation.
 */

// ── Constants ──────────────────────────────────────────

var TYPES = ['1K', '2K', '3K', '4K'];

var WIDTHS = {
  '1K': 2,
  '2K': 3,
  '3K': 4,
  '4K': 5
};

// ── Core solver ────────────────────────────────────────

/**
 * Enumerate ALL non-negative integer solutions of
 *   w1*n1 + w2*n2 + w3*n3 + w4*n4 = C
 *
 * For typical C (20-200) and w in {2,3,4,5} this is fast:
 * at most C/2 * C/3 * C/4 ≈ C^3/24 iterations.
 * For C=200 that's ~33000 — trivial.
 *
 * @param {number} C - total cells
 * @param {Array<string>} types - active types (subset of TYPES)
 * @returns {Array<Object>} all solutions [{n1K, n2K, n3K, n4K}, ...]
 */
function enumerateSolutions(C, types) {
  var solutions = [];

  // Determine which types are active
  var t0 = types.indexOf('1K') >= 0;
  var t1 = types.indexOf('2K') >= 0;
  var t2 = types.indexOf('3K') >= 0;
  var t3 = types.indexOf('4K') >= 0;

  var max0 = t0 ? Math.floor(C / WIDTHS['1K']) : 0;
  var max1 = t1 ? Math.floor(C / WIDTHS['2K']) : 0;
  var max2 = t2 ? Math.floor(C / WIDTHS['3K']) : 0;
  var max3 = t3 ? Math.floor(C / WIDTHS['4K']) : 0;

  for (var n0 = 0; n0 <= max0; n0++) {
    var rem0 = C - n0 * WIDTHS['1K'];
    if (rem0 < 0) break;

    for (var n1 = 0; n1 <= max1; n1++) {
      var rem1 = rem0 - n1 * WIDTHS['2K'];
      if (rem1 < 0) break;

      for (var n2 = 0; n2 <= max2; n2++) {
        var rem2 = rem1 - n2 * WIDTHS['3K'];
        if (rem2 < 0) break;

        if (!t3) {
          // No 4K type — remainder must be zero
          if (rem2 === 0) {
            var sol = { '1K': n0, '2K': n1, '3K': n2, '4K': 0 };
            solutions.push(sol);
          }
        } else {
          // 4K absorbs remainder
          if (rem2 % WIDTHS['4K'] === 0) {
            var n3 = rem2 / WIDTHS['4K'];
            var sol = { '1K': n0, '2K': n1, '3K': n2, '4K': n3 };
            solutions.push(sol);
          }
        }
      }
    }
  }

  return solutions;
}

/**
 * Compute area fractions for a solution vector.
 *
 * @param {Object} sol - {1K: n, 2K: n, 3K: n, 4K: n}
 * @param {number} C - total cells
 * @returns {Object} {1K: fraction, 2K: fraction, 3K: fraction, 4K: fraction}
 */
function computeFractions(sol, C) {
  var fracs = {};
  for (var i = 0; i < TYPES.length; i++) {
    var t = TYPES[i];
    fracs[t] = (sol[t] * WIDTHS[t]) / C;
  }
  return fracs;
}

/**
 * L1 deviation between solution fractions and target alphas.
 *
 * @param {Object} fracs - {1K: f, ...}
 * @param {Object} alpha - {1K: a, ...}
 * @returns {number} sum of |frac_t - alpha_t|
 */
function deviation(fracs, alpha) {
  var d = 0;
  for (var i = 0; i < TYPES.length; i++) {
    var t = TYPES[i];
    var a = alpha[t] || 0;
    var f = fracs[t] || 0;
    d += Math.abs(f - a);
  }
  return d;
}

/**
 * Count total apartments in solution.
 *
 * @param {Object} sol
 * @returns {number}
 */
function totalApartments(sol) {
  var n = 0;
  for (var i = 0; i < TYPES.length; i++) {
    n += sol[TYPES[i]] || 0;
  }
  return n;
}

// ── Public API ─────────────────────────────────────────

/**
 * Resolve target quota vector Q from total cells and area percentages.
 *
 * @param {number} C - total cells across all floors
 * @param {Object} targetPct - {1K: 40, 2K: 30, 3K: 20, 4K: 10} percentages
 * @param {Object} [options]
 * @param {number} [options.topK=5] - return top K solutions
 * @param {Array<string>} [options.types] - active types (default: all with pct > 0)
 * @param {Object} [options.minCounts] - minimum counts per type {1K: 2, ...}
 * @param {Object} [options.maxCounts] - maximum counts per type {1K: 20, ...}
 * @returns {Object} { best, candidates, C, alpha, debug }
 */
export function resolveQuota(C, targetPct, options) {
  if (!options) options = {};
  var topK = options.topK || 5;

  // Normalize percentages to fractions
  var alpha = {};
  var pctSum = 0;
  for (var i = 0; i < TYPES.length; i++) {
    pctSum += (targetPct[TYPES[i]] || 0);
  }
  if (pctSum === 0) pctSum = 100;
  for (var i = 0; i < TYPES.length; i++) {
    alpha[TYPES[i]] = (targetPct[TYPES[i]] || 0) / pctSum;
  }

  // Active types: those with alpha > 0, or override
  var types = options.types;
  if (!types) {
    types = [];
    for (var i = 0; i < TYPES.length; i++) {
      if (alpha[TYPES[i]] > 0) types.push(TYPES[i]);
    }
  }
  if (types.length === 0) types = TYPES.slice();

  // Enumerate
  var solutions = enumerateSolutions(C, types);

  // Filter by min/max counts
  if (options.minCounts || options.maxCounts) {
    var filtered = [];
    for (var si = 0; si < solutions.length; si++) {
      var sol = solutions[si];
      var ok = true;
      if (options.minCounts) {
        for (var t in options.minCounts) {
          if (options.minCounts.hasOwnProperty(t)) {
            if ((sol[t] || 0) < options.minCounts[t]) { ok = false; break; }
          }
        }
      }
      if (ok && options.maxCounts) {
        for (var t in options.maxCounts) {
          if (options.maxCounts.hasOwnProperty(t)) {
            if ((sol[t] || 0) > options.maxCounts[t]) { ok = false; break; }
          }
        }
      }
      if (ok) filtered.push(sol);
    }
    solutions = filtered;
  }

  // Score and rank
  var scored = [];
  for (var si = 0; si < solutions.length; si++) {
    var sol = solutions[si];
    var fracs = computeFractions(sol, C);
    var dev = deviation(fracs, alpha);
    scored.push({
      counts: sol,
      fractions: fracs,
      deviation: dev,
      totalApartments: totalApartments(sol)
    });
  }

  // Sort by deviation ascending, then by total apartments descending (prefer more apts)
  scored.sort(function (a, b) {
    var dd = a.deviation - b.deviation;
    if (Math.abs(dd) > 1e-9) return dd;
    return b.totalApartments - a.totalApartments;
  });

  // Top K
  var candidates = [];
  for (var i = 0; i < Math.min(topK, scored.length); i++) {
    candidates.push(scored[i]);
  }

  var best = candidates.length > 0 ? candidates[0] : null;

  // Debug output
  var debug = {
    totalCells: C,
    alpha: alpha,
    activeTypes: types,
    totalSolutions: solutions.length,
    candidateCount: candidates.length
  };

  return {
    best: best,
    candidates: candidates,
    debug: debug
  };
}

/**
 * Compute remaining quota after base floor is accounted for.
 *
 * @param {Object} Q - total target {1K: n, 2K: n, 3K: n, 4K: n}
 * @param {Object} basePlaced - what floor 2 placed {1K: n, 2K: n, ...}
 * @param {number} baseFloors - how many floors share base layout (default 1)
 * @returns {Object} { remainder, feasible, shortfall }
 */
export function computeRemainder(Q, basePlaced, baseFloors) {
  if (!baseFloors) baseFloors = 1;
  var remainder = {};
  var feasible = true;
  var shortfall = {};

  for (var i = 0; i < TYPES.length; i++) {
    var t = TYPES[i];
    var target = Q[t] || 0;
    var placed = (basePlaced[t] || 0) * baseFloors;
    var rem = target - placed;
    remainder[t] = Math.max(0, rem);
    if (rem < 0) {
      feasible = false;
      shortfall[t] = -rem;
    }
  }

  return {
    remainder: remainder,
    feasible: feasible,
    shortfall: shortfall
  };
}

/**
 * Format solution for console/debug display.
 *
 * @param {Object} result - output of resolveQuota
 * @returns {string} human-readable report
 */
export function formatReport(result) {
  var lines = [];
  var d = result.debug;

  lines.push('=== QuotaResolver Phase 0 ===');
  lines.push('Total cells: ' + d.totalCells);
  lines.push('Target alpha: ' + JSON.stringify(d.alpha));
  lines.push('Active types: ' + d.activeTypes.join(', '));
  lines.push('Solutions found: ' + d.totalSolutions);
  lines.push('');

  if (result.best) {
    lines.push('BEST: ' + formatSolution(result.best));
  }

  lines.push('');
  lines.push('Top candidates:');
  for (var i = 0; i < result.candidates.length; i++) {
    var c = result.candidates[i];
    lines.push('  #' + (i + 1) + ': ' + formatSolution(c));
  }

  return lines.join('\n');
}

function formatSolution(s) {
  var parts = [];
  for (var i = 0; i < TYPES.length; i++) {
    var t = TYPES[i];
    if (s.counts[t] > 0) {
      parts.push(s.counts[t] + 'x' + t);
    }
  }
  var fracParts = [];
  for (var i = 0; i < TYPES.length; i++) {
    var t = TYPES[i];
    fracParts.push(t + '=' + Math.round(s.fractions[t] * 100) + '%');
  }
  return parts.join(' + ') +
    ' (' + s.totalApartments + ' apts, dev=' +
    s.deviation.toFixed(3) + ', ' + fracParts.join(' ') + ')';
}

export { TYPES, WIDTHS };
