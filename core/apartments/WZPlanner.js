/**
 * WZPlanner — Step 1: WZ stack placement + orphan validation
 *
 * Takes solver result from floor 1, extracts WZ positions as vertical stacks.
 * Validates orphan constraints per section orientation:
 *   - Meridional (lon): NO orphans allowed on either facade
 *   - Latitudinal (lat): NO orphans on south facade, OK on north
 *
 * Output: wzStacks, wzPairs, orphan report, feasibility flag.
 */

import { solveFloor, wetQualityReport } from './ApartmentSolver.js';

/**
 * Determine which facade is south.
 * @param {string} northSide - 'near' or 'far'
 * @returns {string} 'near' or 'far'
 */
function getSouthSide(northSide) {
  return northSide === 'near' ? 'far' : 'near';
}

/**
 * Classify each apartment by facade: 'near', 'far', or 'both' (torec).
 * Near cells: 0..N-1, Far cells: N..2N-1
 */
function classifyAptFacade(apt, N) {
  var hasNear = false;
  var hasFar = false;
  var cells = apt.cells || [];
  for (var i = 0; i < cells.length; i++) {
    var cid = cells[i];
    if (typeof cid !== 'number') continue;
    if (cid < N) hasNear = true;
    else hasFar = true;
  }
  if (hasNear && hasFar) return 'both';
  if (hasNear) return 'near';
  if (hasFar) return 'far';
  return 'unknown';
}

/**
 * Run WZ placement on floor 1.
 *
 * @param {Object} graphNodes - section graph
 * @param {number} N - cells per side
 * @param {Object|null} insolMap - { cellId: 'p'|'w'|'f' }
 * @param {string} orientation - 'lat' or 'lon'
 * @param {string} northSide - 'near' or 'far'
 * @param {Object} [precomputedResult] - solveFloor result; if provided, skips re-solve
 * @returns {Object} WZ plan result
 */
export function planWZStacks(graphNodes, N, insolMap, orientation, northSide, precomputedResult) {
  var solverResult = precomputedResult || solveFloor(graphNodes, N, 1, insolMap, orientation);
  if (!solverResult) {
    return {
      wzStacks: [], wzPairs: [], nearOrphans: [], farOrphans: [],
      orientation: orientation, northSide: northSide,
      southOrphanCount: 0, totalOrphanCount: 0,
      feasible: false, apartments: [],
      report: 'Solver failed — no apartment floor'
    };
  }

  var apartments = solverResult.apartments;
  var southSide = getSouthSide(northSide);

  // Extract WZ stacks
  var wzStacks = [];
  var nearOrphans = [];
  var farOrphans = [];

  for (var i = 0; i < apartments.length; i++) {
    var apt = apartments[i];

    // WZ position
    var wc = apt.wetCell;
    if (wc !== undefined && wc !== null && typeof wc === 'number') {
      wzStacks.push(wc);
    }

    // Orphan classification by facade
    if (apt.type === 'orphan') {
      var facade = classifyAptFacade(apt, N);
      if (facade === 'near' || facade === 'both') nearOrphans.push(apt.cells[0]);
      if (facade === 'far' || facade === 'both') farOrphans.push(apt.cells[0]);
    }
  }

  // WZ pairing (from wet quality report)
  var wq = wetQualityReport(apartments);

  // Orphan constraint validation
  var southOrphans = (southSide === 'near') ? nearOrphans : farOrphans;
  var northOrphans = (northSide === 'near') ? nearOrphans : farOrphans;
  var southOrphanCount = southOrphans.length;
  var totalOrphanCount = nearOrphans.length + farOrphans.length;

  var feasible;
  var violations = [];

  if (orientation === 'lon') {
    // Meridional: no orphans at all
    feasible = totalOrphanCount === 0;
    if (!feasible) {
      violations.push(totalOrphanCount + ' orphan(s) — meridional section requires zero');
    }
  } else {
    // Latitudinal: no orphans on south facade
    feasible = southOrphanCount === 0;
    if (!feasible) {
      violations.push(southOrphanCount + ' orphan(s) on south facade');
    }
    // North orphans are acceptable but noted
    if (northOrphans.length > 0) {
      violations.push(northOrphans.length + ' orphan(s) on north facade (acceptable)');
    }
  }

  // Report
  var report = orientation === 'lon' ? 'Meridional' : 'Latitudinal';
  report += ' · ' + wzStacks.length + ' WZ stacks';
  report += ' · ' + wq.pairs.length + ' pairs (' + (wq.pairRatio * 100).toFixed(0) + '%)';
  if (violations.length > 0) {
    report += '\n' + violations.join('\n');
  }
  if (feasible) {
    report += '\n✓ FEASIBLE';
  } else {
    report += '\n✗ NOT FEASIBLE — reduce height of shading sections';
  }

  return {
    wzStacks: wzStacks,
    wzPairs: wq.pairs,
    wzPairRatio: wq.pairRatio,
    nearOrphans: nearOrphans,
    farOrphans: farOrphans,
    southOrphans: southOrphans,
    northOrphans: northOrphans,
    orientation: orientation,
    northSide: northSide,
    southOrphanCount: southOrphanCount,
    totalOrphanCount: totalOrphanCount,
    feasible: feasible,
    apartments: apartments,
    solverResult: solverResult,
    report: report
  };
}
