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
 * Solve via rounding the continuous optimum.
 *
 * Continuous relaxation: n_t* = alpha_t * C / w_t.
 * Search a local neighborhood (±R per free variable) around
 * the rounded continuous solution, compute the constrained
 * variable from the remainder.
 *
 * Complexity: O((2R+1)^(k-1)) where k = active types, R = search radius.
 * For k=4, R=4: 9^3 = 729 candidates — effectively O(1).
 *
 * Guaranteed optimal when the true optimum lies within R
 * of the continuous solution in each coordinate. For the
 * widths {2,3,4,5} and L1 objective, R=4 is sufficient
 * for any C.
 *
 * @param {number} C - total cells
 * @param {Array<string>} types - active types
 * @param {Object} alpha - target area fractions { '1K': 0.4, ... }
 * @param {Object} [minCounts] - minimum counts per type
 * @param {Object} [maxCounts] - maximum counts per type
 * @returns {Array<Object>} candidate solutions [{1K: n, 2K: n, ...}, ...]
 */
function solveBestCandidates(C, types, alpha, minCounts, maxCounts) {
  var RADIUS = 4;

  // Continuous optimum for each active type
  var nStar = {};
  for (var i = 0; i < types.length; i++) {
    var t = types[i];
    nStar[t] = (alpha[t] || 0) * C / WIDTHS[t];
  }

  // Inactive types fixed at 0
  var inactive = [];
  for (var i = 0; i < TYPES.length; i++) {
    if (types.indexOf(TYPES[i]) < 0) inactive.push(TYPES[i]);
  }

  // Choose the "fixed" type: the one whose n is computed from the
  // constraint. Pick the type with the largest width (most divisible
  // remainder) — prefer 4K, then 3K, etc.
  var fixedType = types[types.length - 1];
  var freeTypes = [];
  for (var i = 0; i < types.length; i++) {
    if (types[i] !== fixedType) freeTypes.push(types[i]);
  }

  // Build search ranges for free variables
  var ranges = [];
  for (var i = 0; i < freeTypes.length; i++) {
    var t = freeTypes[i];
    var center = Math.round(nStar[t]);
    var lo = Math.max(0, center - RADIUS);
    var hi = Math.min(Math.floor(C / WIDTHS[t]), center + RADIUS);
    if (minCounts && minCounts[t] !== undefined) lo = Math.max(lo, minCounts[t]);
    if (maxCounts && maxCounts[t] !== undefined) hi = Math.min(hi, maxCounts[t]);
    ranges.push({ type: t, lo: lo, hi: hi });
  }

  var fixedW = WIDTHS[fixedType];
  var fixedMin = (minCounts && minCounts[fixedType] !== undefined) ? minCounts[fixedType] : 0;
  var fixedMax = (maxCounts && maxCounts[fixedType] !== undefined) ? maxCounts[fixedType] : Math.floor(C / fixedW);

  // Enumerate neighborhood
  var bestSolutions = [];
  var bestDev = Infinity;
  var TOP_K = 5;

  // Recursive enumeration over free variables
  function enumerate(depth, usedCells, sol) {
    if (depth === freeTypes.length) {
      // Compute fixed variable from remainder
      var rem = C - usedCells;
      if (rem < 0) return;
      if (rem % fixedW !== 0) return;
      var nFixed = rem / fixedW;
      if (nFixed < fixedMin || nFixed > fixedMax) return;

      sol[fixedType] = nFixed;

      // Set inactive types to 0
      for (var ii = 0; ii < inactive.length; ii++) sol[inactive[ii]] = 0;

      // Compute deviation
      var fracs = computeFractions(sol, C);
      var dev = deviation(fracs, alpha);

      if (dev < bestDev + 1e-9) {
        var solCopy = {};
        for (var k = 0; k < TYPES.length; k++) solCopy[TYPES[k]] = sol[TYPES[k]] || 0;

        if (dev < bestDev - 1e-9) {
          bestSolutions = [solCopy];
          bestDev = dev;
        } else {
          bestSolutions.push(solCopy);
        }
      }
      return;
    }

    var r = ranges[depth];
    for (var n = r.lo; n <= r.hi; n++) {
      var newUsed = usedCells + n * WIDTHS[r.type];
      if (newUsed > C) break;
      sol[r.type] = n;
      enumerate(depth + 1, newUsed, sol);
    }
  }

  var sol = {};
  enumerate(0, 0, sol);

  return bestSolutions;
}

/**
 * Brute-force enumeration — fallback for edge cases or validation.
 * O(C^3/24) — fast for C ≤ 300.
 */
function enumerateSolutions(C, types) {
  var solutions = [];

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
          if (rem2 === 0) {
            solutions.push({ '1K': n0, '2K': n1, '3K': n2, '4K': 0 });
          }
        } else {
          if (rem2 % WIDTHS['4K'] === 0) {
            var n3 = rem2 / WIDTHS['4K'];
            solutions.push({ '1K': n0, '2K': n1, '3K': n2, '4K': n3 });
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

  // Guarantee sort by width ascending — fixedType selection depends on this
  types.sort(function (a, b) { return WIDTHS[a] - WIDTHS[b]; });

  // Choose solver based on C
  var BRUTE_FORCE_LIMIT = 300;
  var solutions;

  if (C <= BRUTE_FORCE_LIMIT) {
    // Small C — brute force is fast and exhaustive
    solutions = enumerateSolutions(C, types);

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
  } else {
    // Large C — O(1) rounding approach
    solutions = solveBestCandidates(C, types, alpha, options.minCounts, options.maxCounts);
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
