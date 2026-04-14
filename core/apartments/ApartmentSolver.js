/**
 * ApartmentSolver v4.6.1 — Full квартирография (orchestrator)
 *
 * Pipeline:
 *  0. Forced torecs
 *  1. Near sub-segments (greedy)
 *  2. Far segments (greedy)
 *  3. Orphan resolution → regroup → downsize → second orphan pass
 *  4. Split 5K+
 *  5. Wet pairing
 *  6. Wet quality report
 *
 * Sub-modules:
 *   Validation.js       — validateApartment, getFlag
 *   TopologyBuilder.js   — buildSection
 *   GreedySolver.js      — greedySolveSegment, solveTorecForced
 *   OrphanResolver.js    — resolveOrphans, globalRegroup, globalDownsize
 *   ApartmentSplitter.js — splitLargeApartments
 *   WetPairer.js         — globalWetPairing, wetQualityReport
 */

// ── Re-exports (backward compatibility for external importers) ──
export { validateApartment, getFlag } from './Validation.js';
export { buildSection } from './TopologyBuilder.js';
export { wetQualityReport } from './WetPairer.js';

// ── Internal imports ────────────────────────────────────
import { buildSection } from './TopologyBuilder.js';
import { greedySolveSegment, solveTorecForced } from './GreedySolver.js';
import { resolveOrphans, globalRegroup, globalDownsize } from './OrphanResolver.js';
import { splitLargeApartments } from './ApartmentSplitter.js';
import { globalWetPairing, wetQualityReport } from './WetPairer.js';

// ============================================================
// CORRIDOR ACCESS
// ============================================================

function checkCorridorAccess(apt, corridors, farToNearMap, torecCorrNears) {
  var cells = apt.cells || [];
  for (var i = 0; i < cells.length; i++) {
    var cid = cells[i];
    if (typeof cid !== 'number') continue;
    if (corridors[cid] !== undefined && !torecCorrNears[cid]) return true;
    if (farToNearMap[cid] !== undefined) {
      var nCid = farToNearMap[cid];
      if (!torecCorrNears[nCid]) return true;
    }
  }
  return false;
}

// ============================================================
// MAIN SOLVER
// ============================================================

/**
 * Full apartment solver pipeline.
 *
 * @param {Object} graphNodes - section-gen graph nodes
 * @param {number} N - cells per side
 * @param {number} targetFloor - floor to solve (typically 1)
 * @param {Object} [insolMap] - { cellId: 'p'|'w'|'f' }
 * @param {string} [orientation] - 'lat' or 'lon'; affects torec sizing
 * @returns {Object} result
 */
export function solveFloor(graphNodes, N, targetFloor, insolMap, orientation) {
  if (!insolMap) insolMap = {};
  if (!orientation) orientation = 'lon';

  var section = buildSection(graphNodes, N, targetFloor);
  return solveWithSection(section, insolMap, orientation);
}

/**
 * Core solver: run full pipeline on a pre-built section.
 * Used by floor 1 (via solveFloor) and upper floors (directly).
 */
export function solveWithSection(section, insolMap, orientation) {
  if (!insolMap) insolMap = {};
  if (!orientation) orientation = 'lon';

  var N = section.N;
  var allApartments = [];

  // Step 0: forced torecs
  var torecResult = solveTorecForced(section, insolMap, 1, orientation);
  var torecApts = torecResult.apartments;
  var torecNearUsed = torecResult.nearUsed;
  var torecFarUsed = torecResult.farUsed;

  var torecCorrNears = {};
  for (var i = 0; i < torecApts.length; i++) {
    var cells = torecApts[i].cells;
    for (var ci = 0; ci < cells.length; ci++) {
      if (typeof cells[ci] === 'number' && section.corridors[cells[ci]] !== undefined) {
        torecCorrNears[cells[ci]] = true;
      }
    }
  }
  for (var i = 0; i < torecApts.length; i++) allApartments.push(torecApts[i]);

  // Step 1: near sub-segments
  var nearUsed = {};
  for (var k in torecNearUsed) nearUsed[k] = true;
  for (var si = 0; si < section.nearSegments.length; si++) {
    var seg = section.nearSegments[si];
    var remaining = [];
    for (var i = 0; i < seg.length; i++) { if (!nearUsed[seg[i]]) remaining.push(seg[i]); }
    if (remaining.length === 0) continue;
    var nearApts = greedySolveSegment(remaining, insolMap);
    for (var ai = 0; ai < nearApts.length; ai++) {
      var apt = nearApts[ai];
      for (var ci = 0; ci < apt.cells.length; ci++) nearUsed[apt.cells[ci]] = true;
      allApartments.push(apt);
    }
  }

  // Step 2: far segments
  var farUsed = {};
  for (var k in torecFarUsed) farUsed[k] = true;
  for (var si = 0; si < section.farSegments.length; si++) {
    var seg = section.farSegments[si];
    var remaining = [];
    for (var i = 0; i < seg.length; i++) { if (!farUsed[seg[i]]) remaining.push(seg[i]); }
    if (remaining.length === 0) continue;
    var farApts = greedySolveSegment(remaining, insolMap);
    for (var ai = 0; ai < farApts.length; ai++) allApartments.push(farApts[ai]);
  }

  // Step 3: global orphan resolution
  var orphanResolved = 0;
  orphanResolved += resolveOrphans(allApartments, insolMap);
  allApartments = allApartments.filter(function (a) { return a.type !== '_absorbed'; });

  // Step 3b: global REGROUP
  allApartments = globalRegroup(allApartments, insolMap);

  // Step 3c: global DOWNSIZE
  globalDownsize(allApartments, insolMap);

  // Step 3d: second orphan pass — absorbs orphans created by regroup/downsize
  orphanResolved += resolveOrphans(allApartments, insolMap);
  allApartments = allApartments.filter(function (a) { return a.type !== '_absorbed'; });

  // Step 4: split 5K+
  allApartments = splitLargeApartments(allApartments, insolMap);

  // Step 5: global wet pairing
  var wetMoves = globalWetPairing(allApartments, insolMap);

  // Step 6: wet quality report
  var wq = wetQualityReport(allApartments);

  // Stats
  var typeCounts = { '1K': 0, '2K': 0, '3K': 0, '4K': 0, orphan: 0 };
  var invalid = 0;
  var noCorr = 0;
  for (var ai = 0; ai < allApartments.length; ai++) {
    var apt = allApartments[ai];
    if (typeCounts[apt.type] !== undefined) typeCounts[apt.type]++;
    if (!apt.valid) invalid++;
    if (!apt.torec) {
      if (!checkCorridorAccess(apt, section.corridors, section.farToNear, torecCorrNears)) noCorr++;
    }
  }

  var orphanCount = typeCounts.orphan || 0;
  var feasible = orphanCount === 0;

  return {
    floor: 0,
    apartments: allApartments,
    section: section,
    typeCounts: typeCounts,
    total: allApartments.length,
    invalid: invalid,
    wetPairs: wq.pairs.length,
    noCorr: noCorr,
    feasible: feasible,
    orphanCount: orphanCount,
    wetQuality: wq,
    wetMoves: wetMoves,
    orphanResolved: orphanResolved
  };
}
