/**
 * InsolationCalc — GOST R 57795-2017 insolation evaluation
 *
 * Pure calculation module. No Three.js / Rhino / DOM dependencies.
 * Input: array of boolean (free/blocked per ray).
 * Output: status (PASS/WARNING/FAIL), minutes, periods.
 *
 * Rules:
 * - Continuous: total ≥ normative → PASS
 * - Interrupted: total ≥ normative + 30min, each period ≥ 60min → PASS
 * - Gap of 1 ray (10 min) between free rays does NOT break continuity,
 *   but the gap time is subtracted from the period duration.
 * - Shortage ≤ 30 min → WARNING (may be resolved by apartment layout)
 */

var STATUS = { PASS: 'PASS', WARNING: 'WARNING', FAIL: 'FAIL' };

var COLORS = {
  PASS:    [0, 200, 0],
  WARNING: [255, 165, 0],
  FAIL:    [255, 0, 0]
};

/**
 * Find consecutive periods of free rays.
 * A gap of exactly 1 index (10 min) does not break the period,
 * but counts as a gap penalty.
 *
 * @param {Array<number>} freeIndices - sorted indices of free rays
 * @returns {{ periods: Array<Array<number>>, gapPenalties: Array<number> }}
 */
function findConsecutivePeriods(freeIndices) {
  if (freeIndices.length === 0) return { periods: [], gapPenalties: [] };

  var periods = [];
  var gapPenalties = [];
  var currentPeriod = [freeIndices[0]];
  var currentGaps = 0;

  for (var i = 1; i < freeIndices.length; i++) {
    var gap = freeIndices[i] - freeIndices[i - 1];

    if (gap === 1) {
      // Adjacent — same period
      currentPeriod.push(freeIndices[i]);
    } else if (gap === 2) {
      // 1-ray gap — tolerated but penalized
      currentPeriod.push(freeIndices[i]);
      currentGaps += 1;
    } else {
      // Real break
      periods.push(currentPeriod);
      gapPenalties.push(currentGaps);
      currentPeriod = [freeIndices[i]];
      currentGaps = 0;
    }
  }

  periods.push(currentPeriod);
  gapPenalties.push(currentGaps);

  return { periods: periods, gapPenalties: gapPenalties };
}

/**
 * Evaluate insolation compliance per GOST R 57795-2017.
 *
 * @param {Array<boolean>} isFree - per-ray: true = sun reaches point
 * @param {number} normativeMinutes - required insolation (120, 90, or 180)
 * @param {number} [rayMinutes=10] - time per ray interval
 * @returns {Object} evaluation result
 */
export function evaluateInsolation(isFree, normativeMinutes, rayMinutes) {
  if (!rayMinutes) rayMinutes = 10;

  // Collect free indices
  var freeIndices = [];
  for (var i = 0; i < isFree.length; i++) {
    if (isFree[i]) freeIndices.push(i);
  }

  // No sun at all
  if (freeIndices.length === 0) {
    return {
      status: STATUS.FAIL,
      color: COLORS.FAIL,
      message: 'No insolation at all',
      totalMinutes: 0,
      requiredMinutes: normativeMinutes,
      hasInterruption: false,
      periods: [],
      periodsMinutes: [],
      maxPeriodMinutes: 0,
      periodsCount: 0,
      shortageMinutes: normativeMinutes,
      freeCount: 0,
      blockedCount: isFree.length,
      totalRays: isFree.length
    };
  }

  // Find periods
  var result = findConsecutivePeriods(freeIndices);
  var periods = result.periods;
  var gapPenalties = result.gapPenalties;

  // Period durations in minutes (subtract gap penalties × rayMinutes)
  var periodsMinutes = [];
  for (var pi = 0; pi < periods.length; pi++) {
    var raw = periods[pi].length * rayMinutes;
    var penalized = raw - gapPenalties[pi] * rayMinutes;
    periodsMinutes.push(penalized);
  }

  var totalMinutes = 0;
  for (var j = 0; j < periodsMinutes.length; j++) totalMinutes += periodsMinutes[j];

  var maxPeriodMinutes = 0;
  for (var j = 0; j < periodsMinutes.length; j++) {
    if (periodsMinutes[j] > maxPeriodMinutes) maxPeriodMinutes = periodsMinutes[j];
  }

  var hasInterruption = periods.length > 1;
  var requiredMinutes = hasInterruption ? normativeMinutes + 30 : normativeMinutes;
  var minRequiredPeriod = hasInterruption ? 60 : 0;
  var shortage = requiredMinutes - totalMinutes;

  // Evaluate
  var status, color, message;

  if (hasInterruption) {
    var hasValidPeriod = maxPeriodMinutes >= minRequiredPeriod;

    if (!hasValidPeriod) {
      status = STATUS.FAIL;
      color = COLORS.FAIL;
      message = 'FAIL: no period >= 60 min (max ' + maxPeriodMinutes + ' min)';
    } else if (totalMinutes >= requiredMinutes) {
      status = STATUS.PASS;
      color = COLORS.PASS;
      message = 'PASS: interrupted, ' + periods.length + ' periods, ' + totalMinutes + ' min';
    } else if (shortage <= 30 && shortage > 0) {
      status = STATUS.WARNING;
      color = COLORS.WARNING;
      message = 'WARNING: shortage ' + shortage + ' min (may solve with layout)';
    } else {
      status = STATUS.FAIL;
      color = COLORS.FAIL;
      message = 'FAIL: shortage ' + shortage + ' min';
    }
  } else {
    if (totalMinutes >= requiredMinutes) {
      status = STATUS.PASS;
      color = COLORS.PASS;
      message = 'PASS: continuous, ' + totalMinutes + ' min';
    } else if (shortage <= 30 && shortage > 0) {
      status = STATUS.WARNING;
      color = COLORS.WARNING;
      message = 'WARNING: shortage ' + shortage + ' min (may solve with layout)';
    } else {
      status = STATUS.FAIL;
      color = COLORS.FAIL;
      message = 'FAIL: shortage ' + shortage + ' min';
    }
  }

  return {
    status: status,
    color: color,
    message: message,
    totalMinutes: totalMinutes,
    requiredMinutes: requiredMinutes,
    hasInterruption: hasInterruption,
    periods: periods,
    periodsMinutes: periodsMinutes,
    maxPeriodMinutes: maxPeriodMinutes,
    periodsCount: periods.length,
    shortageMinutes: Math.max(0, shortage),
    freeCount: freeIndices.length,
    blockedCount: isFree.length - freeIndices.length,
    totalRays: isFree.length
  };
}

/**
 * Cast rays and evaluate. Framework-agnostic interface.
 *
 * @param {Object} params
 * @param {[number,number,number]} params.point - xyz
 * @param {Array<[number,number,number]>} params.sunVectors - direction vectors
 * @param {Function} params.raycast - (origin, direction) => distance|null
 * @param {number} params.normativeMinutes - GOST requirement
 * @param {number} [params.maxDistance=500] - max ray distance
 * @param {number} [params.rayMinutes=10] - time per ray
 * @returns {Object} { evaluation, perRay: Array<{free,distance}> }
 */
export function analyzePoint(params) {
  var point = params.point;
  var sunVectors = params.sunVectors;
  var raycast = params.raycast;
  var normativeMinutes = params.normativeMinutes;
  var maxDistance = params.maxDistance || 500;
  var rayMinutes = params.rayMinutes || 10;

  var isFree = [];
  var perRay = [];

  for (var i = 0; i < sunVectors.length; i++) {
    var dist = raycast(point, sunVectors[i]);
    var free = (dist === null || dist === undefined || dist < 0 || dist > maxDistance);

    isFree.push(free);
    perRay.push({ free: free, distance: dist });
  }

  var evaluation = evaluateInsolation(isFree, normativeMinutes, rayMinutes);

  return { evaluation: evaluation, perRay: perRay };
}

export { STATUS, COLORS };
