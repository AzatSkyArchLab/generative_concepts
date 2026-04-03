/**
 * BuildingPlanner v6 — merge-based architecture.
 *
 * Floor 1: ApartmentSolver (all 1K, max WZ) — untouched.
 * Floors 2+: copy previous → merge adjacent → grow types.
 *
 * No TorecPlanner, no MidPlanner, no WZ profile computation.
 * One mechanism: merge. Everything else emerges.
 */

import { planFloorByMerge, computeGlobalQuota } from './MergePlanner.js';

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

  // ── Step 1: Estimate total apartments ──
  // Start with floor 1 count, assume gradual reduction from merges.
  // Rough: avg apartments/floor ≈ floor1 count × 0.7 (30% merge over building)
  var floor1Count = floor1Apartments.length;
  var estAvgPerFloor = Math.round(floor1Count * 0.75);
  var estTotal = floor1Count + estAvgPerFloor * (residentialFloors - 1);

  // ── Step 2: Global quota ──
  var quota = computeGlobalQuota(estTotal, mix);

  console.log('[BuildingPlanner v6] estimated total:', estTotal,
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

  console.log('[BuildingPlanner v6] floor1 placed:', JSON.stringify(floor1Placed));
  console.log('[BuildingPlanner v6] remaining:', JSON.stringify(remaining));

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

    var result = planFloorByMerge(prevApartments, insolMap, remaining, floorsLeft, N, sortedCorrNears);

    floors.push({
      floor: fl,
      apartments: result.apartments,
      placed: result.placed,
      activeWZ: result.activeWZ
    });

    profileLog.push(result.activeWZ);
    prevApartments = result.apartments;
  }

  console.log('[BuildingPlanner v6] profile:', profileLog.join(' → '));

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

  // Recompute quota based on actual total (not estimate)
  var realQuota = computeGlobalQuota(totalAptCount, mix);

  var totalApts = totalPlaced['1K'] + totalPlaced['2K'] + totalPlaced['3K'] + totalPlaced['4K'];

  console.log('[BuildingPlanner v6] total placed:', JSON.stringify(totalPlaced),
    'actual apts:', totalApts);
  console.log('[BuildingPlanner v6] real quota:', JSON.stringify(realQuota));

  // Deviation against real quota
  var deviation = {};
  for (var i = 0; i < types.length; i++) {
    var t = types[i];
    var tPct = totalAptCount > 0 ? Math.round((realQuota[t] || 0) / totalAptCount * 100) : 0;
    var aPct = totalApts > 0 ? Math.round(totalPlaced[t] / totalApts * 100) : 0;
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
