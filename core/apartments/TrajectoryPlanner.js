/**
 * TrajectoryPlanner — pre-computes merge budget and per-floor schedule.
 *
 * The key insight: MergePlanner's cell-width heuristic undercounts merges
 * because it targets final apartment COUNT, not the TYPE DISTRIBUTION.
 *
 * Growth chain for apartment types from all-1K base:
 *   1K + 1K → 3K         (1 merge, living = 1+1+1 = 3)
 *   3K → 2K + 2K          (rebalance, no merge — when 3K overproduced)
 *   2K + 1K → 4K          (1 merge, living = 2+1+1 = 4)
 *
 * So producing one 4K costs 2 merges across 2 floors:
 *   floor k:   merge 1K+1K → 3K, rebalance → 2K
 *   floor k+1: merge 2K+1K → 4K
 *
 * This module computes the CORRECT total merge budget from target types,
 * then distributes it across floors with front-loading.
 */

// Merge cost per target type (from all-1K base)
var MERGE_COST = {
  '1K': 0,   // no merge needed
  '2K': 1,   // 1 merge → 3K, then rebalance → 2K (merge + free rebalance)
  '3K': 1,   // 1 merge: 1K + 1K → 3K
  '4K': 2    // 2 merges: 1K+1K → 3K → rebalance → 2K, then 2K+1K → 4K
};

var TYPES = ['1K', '2K', '3K', '4K'];

/**
 * Compute the total merge budget for the building.
 *
 * @param {Object} remaining - { '1K': n, '2K': n, '3K': n, '4K': n }
 * @param {number} floor1Count - apartment count on floor 1
 * @returns {number} total merges needed across all upper floors
 */
function computeMergeBudget(remaining, floor1Count) {
  var budget = 0;
  for (var i = 0; i < TYPES.length; i++) {
    var t = TYPES[i];
    var need = Math.max(0, remaining[t] || 0);
    budget += need * MERGE_COST[t];
  }

  // Cap: can't merge more than (floor1Count - 2) times total
  // (need at least 2 apartments remaining)
  var maxMerges = Math.max(0, floor1Count - 2);
  return Math.min(budget, maxMerges);
}

/**
 * Distribute merge budget across floors with front-loading.
 *
 * Uses a decay profile: more merges on lower floors (where apartments
 * are small and adjacency is abundant), fewer on upper floors.
 *
 * @param {number} totalBudget - total merges for the building
 * @param {number} residentialFloors - number of residential floors
 * @returns {Object} { [floor]: mergesThisFloor }
 */
function distributeMerges(totalBudget, residentialFloors) {
  var schedule = {};
  if (residentialFloors < 2 || totalBudget <= 0) return schedule;

  // Compute weights: floor 2 gets most, floor F gets least
  // Weight for floor fl = (residentialFloors - fl + 1)
  var totalWeight = 0;
  for (var fl = 2; fl <= residentialFloors; fl++) {
    totalWeight += residentialFloors - fl + 1;
  }

  var assigned = 0;
  for (var fl = 2; fl <= residentialFloors; fl++) {
    var weight = residentialFloors - fl + 1;
    var share = Math.round(totalBudget * weight / totalWeight);
    // Ensure at least 1 merge per floor if budget remains
    if (share === 0 && assigned < totalBudget) share = 1;
    // Don't exceed remaining budget
    share = Math.min(share, totalBudget - assigned);
    schedule[fl] = share;
    assigned += share;
  }

  // Distribute any remaining budget to lowest floors
  var leftover = totalBudget - assigned;
  for (var fl = 2; fl <= residentialFloors && leftover > 0; fl++) {
    schedule[fl]++;
    leftover--;
  }

  return schedule;
}

/**
 * Plan merge schedule for the entire building.
 *
 * @param {number} floor1Count - apartment count on floor 1
 * @param {Object} remaining - { '1K': n, ... } remaining quota after floor 1
 * @param {number} residentialFloors - total residential floors
 * @returns {Object} { budget, schedule: {[floor]: mergesThisFloor} }
 */
export function planMergeSchedule(floor1Count, remaining, residentialFloors) {
  var budget = computeMergeBudget(remaining, floor1Count);
  var schedule = distributeMerges(budget, residentialFloors);

  return {
    budget: budget,
    schedule: schedule
  };
}
