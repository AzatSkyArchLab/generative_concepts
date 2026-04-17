/**
 * TrajectoryPlanner v2 — cascade-aware merge scheduling.
 *
 * KEY INSIGHT: a merge on floor fl propagates to ALL subsequent floors
 * (because floor fl+1 copies floor fl). So one merge on floor 2
 * removes (residentialFloors - 1) apartment-floors, not just 1.
 *
 * The old planner ignored this cascade multiplier, causing 50-60%
 * overmerging and massive type deviation.
 *
 * New approach: compute the IDEAL PROFILE (apartments per floor),
 * then derive the merge schedule from profile deltas.
 *
 * Profile strategy: drop from floor1Count to targetPerFloor on
 * floor 2, hold steady, adjust tail to hit exact total.
 */

var TYPES = ['1K', '2K', '3K', '4K'];

/**
 * Compute the ideal apartment profile for the building.
 *
 * @param {number} floor1Count - apartments on floor 1
 * @param {number} targetTotal - total apartments across all floors
 * @param {number} residentialFloors - number of residential floors
 * @returns {Array<number>} profile[0..residentialFloors-1]
 */
function computeIdealProfile(floor1Count, targetTotal, residentialFloors) {
  var profile = [];
  profile.push(floor1Count);

  if (residentialFloors <= 1) return profile;

  // Target for upper floors: distribute remaining evenly
  var remainingApts = targetTotal - floor1Count;
  var upperFloors = residentialFloors - 1;

  if (remainingApts <= 0) {
    for (var fl = 1; fl < residentialFloors; fl++) {
      profile.push(Math.max(2, floor1Count));
    }
    return profile;
  }

  var basePerFloor = Math.floor(remainingApts / upperFloors);
  basePerFloor = Math.max(2, Math.min(basePerFloor, floor1Count));

  var baseTotal = floor1Count + basePerFloor * upperFloors;
  var excess = baseTotal - targetTotal;

  if (excess >= 0) {
    // Need `excess` floors at (basePerFloor - 1). Put on LAST floors.
    var nReduced = Math.min(excess, upperFloors);
    for (var fl = 1; fl < residentialFloors; fl++) {
      if (fl >= residentialFloors - nReduced) {
        profile.push(Math.max(2, basePerFloor - 1));
      } else {
        profile.push(basePerFloor);
      }
    }
  } else {
    // Need floors at (basePerFloor + 1). Can't exceed floor1Count.
    var nBoosted = Math.min(-excess, upperFloors);
    for (var fl = 1; fl < residentialFloors; fl++) {
      if (fl < nBoosted + 1) {
        profile.push(Math.min(floor1Count, basePerFloor + 1));
      } else {
        profile.push(basePerFloor);
      }
    }
  }

  // Enforce monotonicity: profile must be non-increasing
  for (var fl = 1; fl < profile.length; fl++) {
    if (profile[fl] > profile[fl - 1]) {
      profile[fl] = profile[fl - 1];
    }
  }

  return profile;
}

/**
 * Derive per-floor merge schedule from profile deltas.
 *
 * @param {Array<number>} profile
 * @returns {Object} { [floor]: mergesThisFloor }
 */
function profileToSchedule(profile) {
  var schedule = {};
  for (var fl = 1; fl < profile.length; fl++) {
    var merges = profile[fl - 1] - profile[fl];
    if (merges > 0) {
      schedule[fl + 1] = merges;
    }
  }
  return schedule;
}

/**
 * Plan merge schedule for the entire building.
 *
 * @param {number} floor1Count - apartment count on floor 1
 * @param {Object} remaining - { '1K': n, ... } remaining quota after floor 1
 * @param {number} residentialFloors - total residential floors
 * @param {number} [targetTotal] - total target apartments across all floors
 * @returns {Object} { budget, schedule: {[floor]: mergesThisFloor} }
 */
export function planMergeSchedule(floor1Count, remaining, residentialFloors, targetTotal) {
  // If targetTotal not provided, estimate from remaining
  // (backwards-compatible with old callers)
  if (targetTotal === undefined || targetTotal === null) {
    targetTotal = floor1Count;
    for (var i = 0; i < TYPES.length; i++) {
      targetTotal += Math.max(0, remaining[TYPES[i]] || 0);
    }
    // Scale: remaining is per-building delta, not per-floor.
    // If only 1K is needed, no merges required at all.
    var needsMerges = false;
    for (var i = 0; i < TYPES.length; i++) {
      if (TYPES[i] !== '1K' && (remaining[TYPES[i]] || 0) > 0) {
        needsMerges = true;
        break;
      }
    }
    if (!needsMerges) {
      return { budget: 0, schedule: {}, profile: [] };
    }
  }

  // Clamp targetTotal to physical limits and report when clamping occurred.
  //
  // A silent clamp used to cause tricky bugs: BuildingPlanner would pass
  // quotaSum=40 expecting 40 apartments, TrajectoryPlanner would clamp
  // internally to minTT=52 and return a profile for 52 — then actual
  // merges followed the 52-plan while `remaining` bookkeeping followed
  // the 40-plan. Result: large type-distribution drift on infeasible
  // configurations (e.g. small floor1Count + many floors + heavy 4K mix).
  //
  // Now we report the clamp explicitly so callers can either adjust the
  // quota or warn the user that the configuration is physically infeasible.
  var minTotal = floor1Count + 2 * (residentialFloors - 1);
  var noMergeTotal = floor1Count * residentialFloors;
  var requestedTotal = targetTotal;
  var feasible = true;
  var clampDirection = null;

  if (targetTotal < minTotal) {
    targetTotal = minTotal;
    feasible = false;
    clampDirection = 'below';
  } else if (targetTotal > noMergeTotal) {
    targetTotal = noMergeTotal;
    feasible = false;
    clampDirection = 'above';
  }

  var profile = computeIdealProfile(floor1Count, targetTotal, residentialFloors);
  var schedule = profileToSchedule(profile);

  var budget = 0;
  for (var fl in schedule) {
    if (schedule.hasOwnProperty(fl)) {
      budget += schedule[fl];
    }
  }

  return {
    budget: budget,
    schedule: schedule,
    profile: profile,
    // Feasibility reporting — see comment above
    feasible: feasible,
    requestedTotal: requestedTotal,
    effectiveTotal: targetTotal,
    clampDirection: clampDirection,
    minTotal: minTotal,
    maxTotal: noMergeTotal
  };
}
