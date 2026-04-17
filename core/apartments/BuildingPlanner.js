/**
 * BuildingPlanner v8 — cumulative tracking, no drift.
 *
 * v7.1 bugs fixed:
 * - remaining was tracked incrementally → drifted over 20+ floors
 * - floorTarget was fixed at floor1's apt count → infeasible after merges
 * - Three rebalance passes (remaining/growth/floorTarget) conflicted
 *
 * v8 approach:
 * - remaining recomputed from scratch each floor: quota − cumulative
 * - per-floor target computed dynamically for actual apt count
 * - Single rebalance pass using per-floor target
 */

import { planFloorByMerge, computeGlobalQuota } from './MergePlanner.js';
import { planMergeSchedule } from './TrajectoryPlanner.js';
import { resolveQuota, WIDTHS } from './QuotaResolver.js';
import { log } from '../Logger.js';

/**
 * Main entry point.
 */
export function planBuilding(params) {
  var N = params.N;
  var floorCount = params.floorCount;
  var residentialFloors = floorCount - 1;
  var floor1Apartments = params.floor1Apartments || [];
  var mix = params.mix;
  var perFloorInsol = params.perFloorInsol || {};
  var sortedCorrNears = params.sortedCorrNears || [];

  if (residentialFloors < 1 || floor1Apartments.length === 0) {
    return {
      floors: [], totalPlaced: {}, originalQuota: {}, deviation: {},
      totalTarget: 0, totalActual: 0, orphanCount: 0, feasible: false
    };
  }

  var types = ['1K', '2K', '3K', '4K'];

  // ── Step 1: Count floor 1 cells ──
  var floor1Count = floor1Apartments.length;
  var floor1Cells = 0;
  for (var i = 0; i < floor1Apartments.length; i++) {
    var apt = floor1Apartments[i];
    for (var ci = 0; ci < apt.cells.length; ci++) {
      if (typeof apt.cells[ci] === 'number') floor1Cells++;
    }
  }

  var totalCells = floor1Cells * residentialFloors;

  // ── Step 2: Area-based global quota ──
  var quotaResult = resolveQuota(totalCells, mix);
  var quota;
  if (quotaResult.best) {
    quota = quotaResult.best.counts;
  } else {
    var estTotal = floor1Count + Math.round(floor1Count * 0.75) * (residentialFloors - 1);
    quota = computeGlobalQuota(estTotal, mix);
  }

  // ── Step 3: Cumulative placed (starts with floor 1) ──
  var cumPlaced = { '1K': 0, '2K': 0, '3K': 0, '4K': 0 };
  for (var i = 0; i < floor1Apartments.length; i++) {
    var t = floor1Apartments[i].type;
    if (cumPlaced[t] !== undefined) cumPlaced[t]++;
  }

  // ── Step 4: Merge schedule ──
  var quotaSum = 0;
  for (var i = 0; i < types.length; i++) {
    quotaSum += (quota[types[i]] || 0);
  }

  // remaining for schedule computation only
  var initRemaining = {};
  for (var i = 0; i < types.length; i++) {
    initRemaining[types[i]] = (quota[types[i]] || 0) - (cumPlaced[types[i]] || 0);
  }
  var mergeSchedule = planMergeSchedule(floor1Count, initRemaining, residentialFloors, quotaSum);

  // Warn if the trajectory planner clamped the target — this means the
  // requested mix + floor1Count + residentialFloors is physically infeasible.
  // Type-distribution deviation from the mix will be large regardless of
  // what the solver does; the caller should either adjust mix, add floors,
  // or start with a larger floor 1 (more 1K apartments).
  if (mergeSchedule.feasible === false) {
    log.warn('[BuildingPlanner v8] infeasible configuration: quotaSum=' + quotaSum
      + ', clamped ' + mergeSchedule.clampDirection + ' to ' + mergeSchedule.effectiveTotal
      + ' (minTT=' + mergeSchedule.minTotal + ', maxTT=' + mergeSchedule.maxTotal + '). '
      + 'Type distribution will deviate from mix — consider adjusting mix or floor count.');
  }

  log.debug('[BuildingPlanner v8] totalCells:', totalCells,
    'quota:', JSON.stringify(quota), 'quotaSum:', quotaSum);

  // ── Step 5: Floor-by-floor ──
  var floors = [];
  floors.push({
    floor: 1,
    apartments: floor1Apartments,
    placed: { '1K': cumPlaced['1K'], '2K': cumPlaced['2K'], '3K': cumPlaced['3K'], '4K': cumPlaced['4K'] },
    activeWZ: floor1Count
  });

  var prevApartments = floor1Apartments;
  var profileLog = [floor1Count];

  for (var fl = 2; fl <= residentialFloors; fl++) {
    var insolMap = perFloorInsol[fl] || {};
    var floorsLeft = residentialFloors - fl + 1;
    var targetMerges = mergeSchedule.schedule.hasOwnProperty(fl) ? mergeSchedule.schedule[fl] : 0;

    // ── FRESH remaining: quota − cumulative (no drift) ──
    var remaining = {};
    for (var ti = 0; ti < types.length; ti++) {
      remaining[types[ti]] = (quota[types[ti]] || 0) - (cumPlaced[types[ti]] || 0);
    }

    // Subtract what this floor WILL place as base (copy of prev)
    var basePlaced = { '1K': 0, '2K': 0, '3K': 0, '4K': 0 };
    for (var pi = 0; pi < prevApartments.length; pi++) {
      var pt = prevApartments[pi].type;
      if (basePlaced[pt] !== undefined) basePlaced[pt]++;
    }
    for (var ti = 0; ti < types.length; ti++) {
      remaining[types[ti]] -= (basePlaced[types[ti]] || 0);
    }

    var result = planFloorByMerge(prevApartments, insolMap, remaining, floorsLeft, N, sortedCorrNears, targetMerges, floor1Cells, mix);

    // ── Update cumulative from ACTUAL result ──
    for (var ti = 0; ti < types.length; ti++) {
      cumPlaced[types[ti]] += (result.placed[types[ti]] || 0);
    }

    floors.push({
      floor: fl,
      apartments: result.apartments,
      placed: result.placed,
      activeWZ: result.activeWZ
    });

    profileLog.push(result.activeWZ);
    prevApartments = result.apartments;
  }

  log.debug('[BuildingPlanner v8] profile:', profileLog.join(' → '));

  // ── Step 6: Final deviation ──
  var totalPlaced = { '1K': 0, '2K': 0, '3K': 0, '4K': 0, orphan: 0 };
  var totalAptCount = 0;
  var actualTotalCells = 0;
  for (var fi = 0; fi < floors.length; fi++) {
    totalAptCount += floors[fi].apartments.length;
    for (var ai = 0; ai < floors[fi].apartments.length; ai++) {
      var apt = floors[fi].apartments[ai];
      var t = apt.type;
      if (totalPlaced[t] !== undefined) totalPlaced[t]++;
      else totalPlaced.orphan = (totalPlaced.orphan || 0) + 1;
      for (var ci = 0; ci < apt.cells.length; ci++) {
        if (typeof apt.cells[ci] === 'number') actualTotalCells++;
      }
    }
  }

  var realQuotaResult = resolveQuota(actualTotalCells, mix);
  var realQuota = realQuotaResult.best ? realQuotaResult.best.counts : computeGlobalQuota(totalAptCount, mix);
  var totalApts = totalPlaced['1K'] + totalPlaced['2K'] + totalPlaced['3K'] + totalPlaced['4K'];

  var deviation = {};
  for (var i = 0; i < types.length; i++) {
    var t = types[i];
    var targetCells = (realQuota[t] || 0) * WIDTHS[t];
    var actualCells = totalPlaced[t] * WIDTHS[t];
    var tPct = actualTotalCells > 0 ? Math.round(targetCells / actualTotalCells * 100) : 0;
    var aPct = actualTotalCells > 0 ? Math.round(actualCells / actualTotalCells * 100) : 0;
    deviation[t] = {
      target: realQuota[t] || 0, actual: totalPlaced[t],
      targetPct: tPct, actualPct: aPct,
      delta: totalPlaced[t] - (realQuota[t] || 0)
    };
  }

  return {
    floors: floors, totalPlaced: totalPlaced, originalQuota: realQuota,
    deviation: deviation, totalTarget: totalAptCount, totalActual: totalApts,
    orphanCount: totalPlaced.orphan || 0, feasible: (totalPlaced.orphan || 0) === 0,
    deviationScore: 0, profile: profileLog
  };
}
