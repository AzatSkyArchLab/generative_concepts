/**
 * BuildingPlanner v7 — merge-based architecture + trajectory planning.
 *
 * Floor 1: ApartmentSolver (all 1K, max WZ) — untouched.
 * Floors 2+: TrajectoryPlanner computes type-aware merge budget,
 *            MergePlanner executes merges with directed growth scoring.
 *
 * Growth chain: 1K+1K → 3K (merge) → 2K (rebalance) → 2K+1K → 4K (merge)
 * Each 4K costs 2 merges across 2 floors. Budget accounts for this.
 *
 * v7.1: Fixed remaining-tracking bug — each floor's base placement
 * is now subtracted from remaining before merge scoring.
 * Area-based quota via QuotaResolver replaces count-based computeGlobalQuota.
 */

import { planFloorByMerge, computeGlobalQuota } from './MergePlanner.js';
import { planMergeSchedule } from './TrajectoryPlanner.js';
import { resolveQuota, WIDTHS } from './QuotaResolver.js';

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

  // ── Step 1: Estimate total cells across all residential floors ──
  // Floor 1 has a known cell count. Upper floors lose cells through
  // WZ deactivation (1 cell lost per merge). Use merge budget to estimate.
  var floor1Count = floor1Apartments.length;

  // Count cells on floor 1
  var floor1Cells = 0;
  for (var i = 0; i < floor1Apartments.length; i++) {
    var apt = floor1Apartments[i];
    for (var ci = 0; ci < apt.cells.length; ci++) {
      if (typeof apt.cells[ci] === 'number') floor1Cells++;
    }
  }

  // For estimation: total cells ≈ floor1Cells × residentialFloors
  // (WZ deactivation removes cells but they remain in the floor —
  //  deactivated WZ just becomes living in the merged apartment)
  var totalCells = floor1Cells * residentialFloors;

  // ── Step 2: Area-based global quota ──
  // Use QuotaResolver: find n_t such that Σ n_t·w_t = totalCells
  // and n_t·w_t/totalCells ≈ alpha_t (area fractions).
  var quotaResult = resolveQuota(totalCells, mix);
  var quota;
  if (quotaResult.best) {
    quota = quotaResult.best.counts;
  } else {
    // Fallback: count-based quota
    var estTotal = floor1Count + Math.round(floor1Count * 0.75) * (residentialFloors - 1);
    quota = computeGlobalQuota(estTotal, mix);
  }

  console.log('[BuildingPlanner v7.1] totalCells:', totalCells,
    'floor1:', floor1Count, 'quota:', JSON.stringify(quota));

  // ── Step 3: Initialize remaining ──
  var floor1Placed = { '1K': 0, '2K': 0, '3K': 0, '4K': 0 };
  for (var i = 0; i < floor1Apartments.length; i++) {
    var t = floor1Apartments[i].type;
    if (floor1Placed[t] !== undefined) floor1Placed[t]++;
  }

  var remaining = {};
  for (var i = 0; i < types.length; i++) {
    remaining[types[i]] = (quota[types[i]] || 0) - (floor1Placed[types[i]] || 0);
  }

  console.log('[BuildingPlanner v7.1] floor1 placed:', JSON.stringify(floor1Placed));
  console.log('[BuildingPlanner v7.1] remaining:', JSON.stringify(remaining));

  // ── Step 3b: Trajectory planning — type-aware merge schedule ──
  // targetTotal = total apartments across all residential floors
  var quotaSum = 0;
  for (var i = 0; i < types.length; i++) {
    quotaSum += (quota[types[i]] || 0);
  }
  var mergeSchedule = planMergeSchedule(floor1Count, remaining, residentialFloors, quotaSum);
  console.log('[BuildingPlanner v7.1] merge budget:', mergeSchedule.budget,
    'schedule:', JSON.stringify(mergeSchedule.schedule));

  // ── Step 3c: Per-floor type target ──
  // Each floor has the same cell count. Use QuotaResolver to compute
  // the ideal type distribution for one floor's worth of cells.
  var floorTarget = null;
  if (floor1Cells > 0) {
    var ftResult = resolveQuota(floor1Cells, mix);
    if (ftResult.best) {
      floorTarget = ftResult.best.counts;
    }
  }
  console.log('[BuildingPlanner v7.1] per-floor target:', JSON.stringify(floorTarget));

  // ── Step 4: Floor-by-floor merge ──
  var floors = [];
  floors.push({
    floor: 1,
    apartments: floor1Apartments,
    placed: floor1Placed,
    activeWZ: floor1Count
  });

  var prevApartments = floor1Apartments;
  var profileLog = [floor1Count];

  for (var fl = 2; fl <= residentialFloors; fl++) {
    var insolMap = perFloorInsol[fl] || {};
    var floorsLeft = residentialFloors - fl + 1;
    var targetMerges = mergeSchedule.schedule.hasOwnProperty(fl) ? mergeSchedule.schedule[fl] : 0;

    // ── KEY FIX: subtract base placement BEFORE merging ──
    // The copied floor's apartments are new placements toward the quota.
    // MergePlanner only tracks merge DELTAS, so we pre-subtract the base.
    var basePlaced = { '1K': 0, '2K': 0, '3K': 0, '4K': 0 };
    for (var pi = 0; pi < prevApartments.length; pi++) {
      var pt = prevApartments[pi].type;
      if (basePlaced[pt] !== undefined) basePlaced[pt]++;
    }
    for (var ti = 0; ti < types.length; ti++) {
      remaining[types[ti]] = (remaining[types[ti]] || 0) - (basePlaced[types[ti]] || 0);
    }

    var result = planFloorByMerge(prevApartments, insolMap, remaining, floorsLeft, N, sortedCorrNears, targetMerges, floorTarget);

    floors.push({
      floor: fl,
      apartments: result.apartments,
      placed: result.placed,
      activeWZ: result.activeWZ
    });

    profileLog.push(result.activeWZ);
    prevApartments = result.apartments;
  }

  console.log('[BuildingPlanner v7.1] profile:', profileLog.join(' → '));

  // ── Step 5: Recount and compute real quota ──
  var totalPlaced = { '1K': 0, '2K': 0, '3K': 0, '4K': 0, orphan: 0 };
  var totalAptCount = 0;
  for (var fi = 0; fi < floors.length; fi++) {
    totalAptCount += floors[fi].apartments.length;
    for (var ai = 0; ai < floors[fi].apartments.length; ai++) {
      var t = floors[fi].apartments[ai].type;
      if (totalPlaced[t] !== undefined) totalPlaced[t]++;
      else totalPlaced.orphan = (totalPlaced.orphan || 0) + 1;
    }
  }

  // Recompute area-based quota from actual cell count
  var actualTotalCells = 0;
  for (var fi = 0; fi < floors.length; fi++) {
    for (var ai = 0; ai < floors[fi].apartments.length; ai++) {
      var cells = floors[fi].apartments[ai].cells;
      for (var ci = 0; ci < cells.length; ci++) {
        if (typeof cells[ci] === 'number') actualTotalCells++;
      }
    }
  }

  var realQuotaResult = resolveQuota(actualTotalCells, mix);
  var realQuota;
  if (realQuotaResult.best) {
    realQuota = realQuotaResult.best.counts;
  } else {
    realQuota = computeGlobalQuota(totalAptCount, mix);
  }

  var totalApts = totalPlaced['1K'] + totalPlaced['2K'] + totalPlaced['3K'] + totalPlaced['4K'];

  console.log('[BuildingPlanner v7.1] total placed:', JSON.stringify(totalPlaced),
    'actual apts:', totalApts);
  console.log('[BuildingPlanner v7.1] real quota:', JSON.stringify(realQuota));

  // Deviation: area-based (using cell counts, not apartment counts)
  var deviation = {};
  for (var i = 0; i < types.length; i++) {
    var t = types[i];
    var targetCells = (realQuota[t] || 0) * WIDTHS[t];
    var actualCells = totalPlaced[t] * WIDTHS[t];
    var tPct = actualTotalCells > 0 ? Math.round(targetCells / actualTotalCells * 100) : 0;
    var aPct = actualTotalCells > 0 ? Math.round(actualCells / actualTotalCells * 100) : 0;
    deviation[t] = {
      target: realQuota[t] || 0,
      actual: totalPlaced[t],
      targetPct: tPct,
      actualPct: aPct,
      delta: totalPlaced[t] - (realQuota[t] || 0)
    };
  }

  return {
    floors: floors,
    totalPlaced: totalPlaced,
    originalQuota: realQuota,
    deviation: deviation,
    totalTarget: totalAptCount,
    totalActual: totalApts,
    orphanCount: totalPlaced.orphan || 0,
    feasible: (totalPlaced.orphan || 0) === 0,
    deviationScore: 0,
    profile: profileLog
  };
}
