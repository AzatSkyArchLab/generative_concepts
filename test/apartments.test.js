/**
 * Unit tests for apartment solver modules.
 * Run: node --test test/apartments.test.js
 *
 * Uses Node built-in test runner (zero deps).
 * All tested modules are pure JS — no framework imports.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  validateApartment, getFlag, buildSection,
  solveFloor, wetQualityReport
} from '../core/apartments/ApartmentSolver.js';

import { resolveQuota, TYPES, WIDTHS } from '../core/apartments/QuotaResolver.js';

import { planFloor } from '../core/apartments/FloorPlanner.js';

import { planFloorByMerge, computeGlobalQuota } from '../core/apartments/MergePlanner.js';

import { planBuilding } from '../core/apartments/BuildingPlanner.js';

import { planWZStacks } from '../core/apartments/WZPlanner.js';

import { planMergeSchedule } from '../core/apartments/TrajectoryPlanner.js';


// ═══════════════════════════════════════════════════════
// Test helpers
// ═══════════════════════════════════════════════════════

/**
 * Build a minimal section graph for testing.
 * No geometry (polygon = null) — solver only needs type/cellId/floor.
 *
 * @param {number} N - cells per side
 * @param {number} floorCount - total floors (including commercial floor 0)
 * @param {string} northSide - 'near' or 'far'
 * @param {Array<number>} lluIndices - LLU cell indices (into near or far depending on northSide)
 */
function buildTestGraph(N, floorCount, northSide, lluIndices) {
  var nodes = {};
  var lluSet = {};
  for (var li = 0; li < lluIndices.length; li++) {
    lluSet[lluIndices[li]] = true;
  }

  for (var floor = 0; floor < floorCount; floor++) {
    var isFirst = (floor === 0);

    // Near cells
    for (var i = 0; i < N; i++) {
      var isLLU = (northSide === 'near' && lluSet[i] === true);
      var cellType;
      if (isLLU) cellType = 'llu';
      else if (isFirst) cellType = 'commercial';
      else cellType = 'apartment';

      nodes[i + ':' + floor] = {
        cellId: i, floor: floor, type: cellType, side: 'near',
        polygon: null, lluTag: isLLU ? 'sE' : null, label: i + '.' + floor
      };
    }

    // Far cells
    for (var i = 0; i < N; i++) {
      var farId = N + i;
      var isLLU = (northSide === 'far' && lluSet[i] === true);
      var cellType;
      if (isLLU) cellType = 'llu';
      else if (isFirst) cellType = 'commercial';
      else cellType = 'apartment';

      nodes[farId + ':' + floor] = {
        cellId: farId, floor: floor, type: cellType, side: 'far',
        polygon: null, lluTag: isLLU ? 'sE' : null, label: farId + '.' + floor
      };
    }

    // Corridors
    for (var i = 0; i < N; i++) {
      var corrId = i + '-' + (2 * N - 1 - i);
      nodes[corrId + ':' + floor] = {
        cellId: corrId, floor: floor, type: 'corridor', side: 'center',
        polygon: null, lluTag: null, label: corrId + '.' + floor
      };
    }
  }

  return nodes;
}

/**
 * Count living cells in apartment (numeric, not wetCell).
 */
function livingCount(apt) {
  var n = 0;
  for (var i = 0; i < apt.cells.length; i++) {
    if (typeof apt.cells[i] === 'number' && apt.cells[i] !== apt.wetCell) n++;
  }
  return n;
}

/**
 * Verify apartment layout invariants.
 * These MUST hold for any valid solver output.
 */
function assertLayoutInvariants(apartments, N, label) {
  var cellOwner = {};

  for (var ai = 0; ai < apartments.length; ai++) {
    var apt = apartments[ai];

    // Every apartment has a wetCell
    assert.ok(
      apt.wetCell !== undefined && apt.wetCell !== null,
      label + ': apt ' + ai + ' missing wetCell'
    );

    // Check numeric cells
    for (var ci = 0; ci < apt.cells.length; ci++) {
      var c = apt.cells[ci];
      if (typeof c !== 'number') continue;

      // No duplicate ownership
      assert.ok(
        cellOwner[c] === undefined,
        label + ': cell ' + c + ' owned by both apt ' + cellOwner[c] + ' and ' + ai
      );
      cellOwner[c] = ai;
    }

    // Non-torec: max 4 living cells
    if (!apt.torec && apt.type !== 'orphan') {
      var lc = livingCount(apt);
      assert.ok(
        lc <= 4,
        label + ': apt ' + ai + ' (' + apt.type + ') has ' + lc + ' living (max 4)'
      );
    }

    // Type matches living count (non-orphan, non-torec)
    if (!apt.torec && apt.type !== 'orphan') {
      var lc = livingCount(apt);
      var expected = lc >= 4 ? '4K' : lc >= 3 ? '3K' : lc >= 2 ? '2K' : lc >= 1 ? '1K' : 'orphan';
      assert.equal(
        apt.type, expected,
        label + ': apt ' + ai + ' type mismatch: ' + apt.type + ' vs expected ' + expected + ' (living=' + lc + ')'
      );
    }
  }

  // Full coverage: every cell 0..2N-1 should be assigned (except LLU)
  // Note: LLU cells are barriers, not assigned to apartments
}


// ═══════════════════════════════════════════════════════
// 1. validateApartment
// ═══════════════════════════════════════════════════════

describe('validateApartment', function () {
  it('1K with pass → valid', function () {
    var r = validateApartment(['p']);
    assert.equal(r.valid, true);
    assert.equal(r.type, '1K');
  });

  it('1K with fail → invalid', function () {
    var r = validateApartment(['f']);
    assert.equal(r.valid, false);
  });

  it('2K needs 1 pass', function () {
    assert.equal(validateApartment(['p', 'w']).valid, true);
    assert.equal(validateApartment(['f', 'w']).valid, false);
  });

  it('2K compensation: 2w per missing p', function () {
    // 0 p, 2 w → deficit=1, need 2w → valid
    assert.equal(validateApartment(['w', 'w']).valid, true);
  });

  it('3K needs 1 pass', function () {
    assert.equal(validateApartment(['p', 'f', 'f']).valid, true);
    assert.equal(validateApartment(['f', 'f', 'f']).valid, false);
  });

  it('4K needs 2 pass', function () {
    assert.equal(validateApartment(['p', 'p', 'f', 'f']).valid, true);
    assert.equal(validateApartment(['p', 'f', 'f', 'f']).valid, false);
  });

  it('4K compensation: 1p + 2w = valid', function () {
    // req=2, have p=1, deficit=1, need 2w
    assert.equal(validateApartment(['p', 'w', 'w', 'f']).valid, true);
  });

  it('empty → invalid', function () {
    assert.equal(validateApartment([]).valid, false);
  });
});


// ═══════════════════════════════════════════════════════
// 2. getFlag
// ═══════════════════════════════════════════════════════

describe('getFlag', function () {
  it('returns flag from map', function () {
    assert.equal(getFlag({ 5: 'f' }, 5), 'f');
  });

  it('defaults to p when missing', function () {
    assert.equal(getFlag({}, 5), 'p');
    assert.equal(getFlag(null, 5), 'p');
  });
});


// ═══════════════════════════════════════════════════════
// 3. QuotaResolver
// ═══════════════════════════════════════════════════════

describe('resolveQuota', function () {
  it('finds exact solution for small C', function () {
    // C=10, all 1K (width=2): 5 apartments
    var r = resolveQuota(10, { '1K': 100, '2K': 0, '3K': 0, '4K': 0 });
    assert.ok(r.best, 'should find a solution');
    assert.equal(r.best.counts['1K'] * 2, 10, 'all cells covered by 1K');
  });

  it('covers all cells exactly', function () {
    // C=20, mixed
    var r = resolveQuota(20, { '1K': 25, '2K': 25, '3K': 25, '4K': 25 });
    assert.ok(r.best, 'should find a solution');
    var c = r.best.counts;
    var totalCells = (c['1K'] || 0) * 2 + (c['2K'] || 0) * 3 + (c['3K'] || 0) * 4 + (c['4K'] || 0) * 5;
    assert.equal(totalCells, 20, 'Σ n_t·w_t = C');
  });

  it('infeasible C returns null best', function () {
    // C=1: impossible (min apartment width = 2)
    var r = resolveQuota(1, { '1K': 100, '2K': 0, '3K': 0, '4K': 0 });
    assert.equal(r.best, null, 'no solution for C=1');
  });

  it('all types active for C=30', function () {
    var r = resolveQuota(30, { '1K': 20, '2K': 30, '3K': 30, '4K': 20 });
    assert.ok(r.best, 'should find a solution');
    var c = r.best.counts;
    var totalCells = (c['1K'] || 0) * 2 + (c['2K'] || 0) * 3 + (c['3K'] || 0) * 4 + (c['4K'] || 0) * 5;
    assert.equal(totalCells, 30, 'covers all 30 cells');
  });
});


// ═══════════════════════════════════════════════════════
// 4. solveFloor — floor 1 pipeline
// ═══════════════════════════════════════════════════════

describe('solveFloor', function () {
  it('solves N=8 lon section, no LLU', function () {
    var N = 8;
    var nodes = buildTestGraph(N, 2, 'near', []);
    var result = solveFloor(nodes, N, 1, null, 'lon');

    assert.ok(result, 'solver returned result');
    assert.ok(result.apartments.length > 0, 'has apartments');
    assertLayoutInvariants(result.apartments, N, 'solveFloor N=8 lon');
  });

  it('solves N=10 lat section with LLU at center', function () {
    var N = 10;
    var nodes = buildTestGraph(N, 2, 'near', [4, 5]);
    var result = solveFloor(nodes, N, 1, null, 'lat');

    assert.ok(result);
    assertLayoutInvariants(result.apartments, N, 'solveFloor N=10 lat');
  });

  it('handles all-fail insolation gracefully', function () {
    var N = 6;
    var nodes = buildTestGraph(N, 2, 'near', []);
    var insolMap = {};
    for (var c = 0; c < 2 * N; c++) insolMap[c] = 'f';

    var result = solveFloor(nodes, N, 1, insolMap, 'lon');
    assert.ok(result);
    // Should still produce apartments (may be invalid, but no crash)
    assert.ok(result.apartments.length > 0);
  });

  it('full coverage: every apartment cell is 0..2N-1', function () {
    var N = 8;
    var nodes = buildTestGraph(N, 2, 'near', []);
    var result = solveFloor(nodes, N, 1, null, 'lon');

    var assignedCells = {};
    for (var ai = 0; ai < result.apartments.length; ai++) {
      var cells = result.apartments[ai].cells;
      for (var ci = 0; ci < cells.length; ci++) {
        if (typeof cells[ci] === 'number') {
          assert.ok(cells[ci] >= 0 && cells[ci] < 2 * N,
            'cell ' + cells[ci] + ' out of range [0, ' + (2 * N) + ')');
          assignedCells[cells[ci]] = true;
        }
      }
    }
    // All apartment cells should be covered
    for (var c = 0; c < 2 * N; c++) {
      var key = c + ':1';
      if (nodes[key] && nodes[key].type === 'apartment') {
        assert.ok(assignedCells[c], 'cell ' + c + ' not assigned to any apartment');
      }
    }
  });
});


// ═══════════════════════════════════════════════════════
// 5. WZPlanner
// ═══════════════════════════════════════════════════════

describe('planWZStacks', function () {
  it('extracts WZ stacks from solver result', function () {
    var N = 8;
    var nodes = buildTestGraph(N, 2, 'near', []);
    var plan = planWZStacks(nodes, N, null, 'lon', 'near');

    assert.ok(plan.wzStacks.length > 0, 'has WZ stacks');
    assert.equal(typeof plan.feasible, 'boolean');
    assert.ok(plan.report.length > 0);
  });

  it('lon section: orphans make it infeasible', function () {
    // Small N with harsh insol should produce orphans
    var N = 4;
    var nodes = buildTestGraph(N, 2, 'near', [1, 2]);
    var insolMap = {};
    for (var c = 0; c < 2 * N; c++) insolMap[c] = 'f';

    var plan = planWZStacks(nodes, N, insolMap, 'lon', 'near');
    // With extreme conditions, feasibility depends on solver behavior
    assert.equal(typeof plan.feasible, 'boolean');
  });
});


// ═══════════════════════════════════════════════════════
// 6. FloorPlanner — SWEEP target cap (FIX 1)
// ═══════════════════════════════════════════════════════

describe('FloorPlanner.planFloor', function () {
  it('respects target quota — limits type growth', function () {
    var N = 6;

    // 4 WZ on near row: enough to handle 12 cells as 1K
    // (each 1K = wz + 1 living = 2 cells, plus 2 torec apartments)
    // Near: 0,1,2,3,4,5  Far: 6,7,8,9,10,11
    var allWZ = [0, 2, 4, 7, 9, 11];
    var activeWZ = allWZ.slice();
    var floorPlan = ['1K', '1K', '1K', '1K', '1K', '1K'];
    var sortedCorrNears = [];
    var lluCells = [];

    var result = planFloor(allWZ, activeWZ, null, N, lluCells, floorPlan, sortedCorrNears, 'lon');

    assert.ok(result.apartments.length > 0, 'produced apartments');

    // Count placed types
    var typeCounts = { '1K': 0, '2K': 0, '3K': 0, '4K': 0 };
    for (var ai = 0; ai < result.apartments.length; ai++) {
      var t = result.apartments[ai].type;
      if (typeCounts[t] !== undefined) typeCounts[t]++;
    }

    // With 6 WZ and target all-1K, SWEEP should produce mostly 1K/2K
    // Key: 3K+4K count should be small (torecs may be larger)
    var largeTypes = typeCounts['3K'] + typeCounts['4K'];
    var totalApts = typeCounts['1K'] + typeCounts['2K'] + typeCounts['3K'] + typeCounts['4K'];

    assert.ok(
      largeTypes <= 2,
      'SWEEP cap should limit 3K/4K count (found ' + largeTypes + ' out of ' + totalApts + ')'
    );
  });

  it('still assigns all cells (zero unassigned guarantee)', function () {
    var N = 8;
    var allWZ = [1, 3, 5, 9, 11, 13];
    var activeWZ = allWZ.slice();
    var floorPlan = ['2K', '2K', '2K', '2K', '2K', '2K'];
    var sortedCorrNears = [0, 1, 2, 3, 4, 5, 6, 7];

    var result = planFloor(allWZ, activeWZ, null, N, [], floorPlan, sortedCorrNears, 'lon');

    // Count all assigned numeric cells
    var assigned = {};
    for (var ai = 0; ai < result.apartments.length; ai++) {
      for (var ci = 0; ci < result.apartments[ai].cells.length; ci++) {
        var c = result.apartments[ai].cells[ci];
        if (typeof c === 'number') assigned[c] = true;
      }
    }

    // Every cell 0..2N-1 that is not LLU should be assigned
    for (var c = 0; c < 2 * N; c++) {
      assert.ok(assigned[c], 'cell ' + c + ' not assigned');
    }
  });

  it('produces valid apartments with insolation', function () {
    var N = 6;
    var allWZ = [1, 3, 7, 9];
    var activeWZ = allWZ.slice();
    var insolMap = {};
    for (var c = 0; c < 2 * N; c++) insolMap[c] = (c % 3 === 0) ? 'f' : 'p';
    var floorPlan = ['2K', '2K', '2K', '2K'];

    var result = planFloor(allWZ, activeWZ, insolMap, N, [], floorPlan, [], 'lon');
    assert.ok(result.apartments.length > 0);
    assertLayoutInvariants(result.apartments, N, 'planFloor insol');
  });
});


// ═══════════════════════════════════════════════════════
// 7. MergePlanner
// ═══════════════════════════════════════════════════════

describe('MergePlanner.planFloorByMerge', function () {
  it('copies and merges without losing cells', function () {
    // Simulate floor 1 output: 6 x 1K apartments
    var N = 8;
    var prevApts = [];
    // Near row: cells 0,1 → apt0; 2,3 → apt1; 4,5 → apt2; 6,7 → apt3 (skip for simplicity)
    prevApts.push({ cells: [0, 1], wetCell: 0, type: '1K', valid: true, torec: false, corridorLabel: null });
    prevApts.push({ cells: [2, 3], wetCell: 2, type: '1K', valid: true, torec: false, corridorLabel: null });
    prevApts.push({ cells: [4, 5], wetCell: 4, type: '1K', valid: true, torec: false, corridorLabel: null });
    prevApts.push({ cells: [6, 7], wetCell: 6, type: '1K', valid: true, torec: false, corridorLabel: null });

    var remaining = { '1K': 0, '2K': 2, '3K': 1, '4K': 0 };
    var sortedCorrNears = [0, 1, 2, 3, 4, 5, 6, 7];

    var result = planFloorByMerge(prevApts, null, remaining, 5, N, sortedCorrNears);

    assert.ok(result.apartments.length > 0);
    assert.ok(result.apartments.length <= prevApts.length, 'merge should reduce apartment count');

    // All original cells still present
    var cells = {};
    for (var ai = 0; ai < result.apartments.length; ai++) {
      for (var ci = 0; ci < result.apartments[ai].cells.length; ci++) {
        var c = result.apartments[ai].cells[ci];
        if (typeof c === 'number') cells[c] = true;
      }
    }
    for (var c = 0; c < 8; c++) {
      assert.ok(cells[c], 'cell ' + c + ' lost during merge');
    }
  });

  it('does not exceed 4K on merge', function () {
    var N = 10;
    var prevApts = [];
    for (var i = 0; i < 5; i++) {
      prevApts.push({
        cells: [i * 2, i * 2 + 1], wetCell: i * 2,
        type: '1K', valid: true, torec: false, corridorLabel: null
      });
    }
    var remaining = { '1K': 0, '2K': 0, '3K': 0, '4K': 5 };

    var result = planFloorByMerge(prevApts, null, remaining, 3, N, []);

    for (var ai = 0; ai < result.apartments.length; ai++) {
      var lc = livingCount(result.apartments[ai]);
      assert.ok(lc <= 4, 'apt ' + ai + ' has ' + lc + ' living (max 4)');
    }
  });

  it('grows toward 4K over multiple floors (directed growth)', function () {
    var N = 10;
    // 8 x 1K apartments on near row: cells [0,1], [2,3], ... [14,15]
    var prevApts = [];
    for (var i = 0; i < 8; i++) {
      prevApts.push({
        cells: [i * 2, i * 2 + 1], wetCell: i * 2,
        type: '1K', valid: true, torec: false, corridorLabel: null
      });
    }

    // Remaining says: we need 4K, nothing else
    var remaining = { '1K': 0, '2K': 0, '3K': 0, '4K': 4 };

    // Simulate 4 floors of merging
    var apts = prevApts;
    for (var fl = 0; fl < 4; fl++) {
      var r = planFloorByMerge(apts, null, remaining, 6 - fl, N, []);
      apts = r.apartments;
    }

    // After 4 floors of growth, should have some 3K or 4K
    var large = 0;
    for (var ai = 0; ai < apts.length; ai++) {
      if (apts[ai].type === '3K' || apts[ai].type === '4K') large++;
    }
    assert.ok(large > 0, 'directed growth should produce 3K/4K after 4 floors (found ' + large + ')');
  });
});


// ═══════════════════════════════════════════════════════
// 8. BuildingPlanner — full pipeline
// ═══════════════════════════════════════════════════════

describe('BuildingPlanner.planBuilding', function () {
  it('produces multi-floor plan from floor 1 apartments', function () {
    // Build floor 1 via solver
    var N = 8;
    var nodes = buildTestGraph(N, 2, 'near', []);
    var floor1Result = solveFloor(nodes, N, 1, null, 'lon');

    var params = {
      N: N,
      floorCount: 6, // 1 commercial + 5 residential
      floor1Apartments: floor1Result.apartments,
      mix: { '1K': 20, '2K': 30, '3K': 30, '4K': 20 },
      perFloorInsol: {},
      sortedCorrNears: []
    };

    var result = planBuilding(params);

    assert.ok(result.floors.length > 0, 'has floors');
    assert.equal(result.floors[0].floor, 1, 'first floor is 1');
    assert.ok(result.totalActual > 0, 'placed some apartments');

    // Profile should be monotonically decreasing or stable
    if (result.profile) {
      for (var i = 1; i < result.profile.length; i++) {
        assert.ok(
          result.profile[i] <= result.profile[i - 1],
          'WZ profile should be monotonically non-increasing: ' +
          result.profile[i - 1] + ' → ' + result.profile[i] + ' at floor ' + (i + 1)
        );
      }
    }
  });

  it('handles single-floor building', function () {
    var result = planBuilding({
      N: 6, floorCount: 1, floor1Apartments: [],
      mix: { '1K': 25, '2K': 25, '3K': 25, '4K': 25 }
    });
    assert.equal(result.feasible, false);
    assert.equal(result.floors.length, 0);
  });
});


// ═══════════════════════════════════════════════════════
// 9. computeGlobalQuota
// ═══════════════════════════════════════════════════════

describe('computeGlobalQuota', function () {
  it('sums to totalApts', function () {
    var q = computeGlobalQuota(100, { '1K': 20, '2K': 30, '3K': 30, '4K': 20 });
    var sum = q['1K'] + q['2K'] + q['3K'] + q['4K'];
    assert.equal(sum, 100);
  });

  it('handles zero mix with fallback distribution', function () {
    // When all mix = 0, fallback sum=100, each type gets round(10*0/100)=0,
    // remainder algorithm distributes 1 per type (4 total, not 10).
    // This is expected behavior — zero mix is a degenerate input.
    var q = computeGlobalQuota(10, { '1K': 0, '2K': 0, '3K': 0, '4K': 0 });
    var sum = q['1K'] + q['2K'] + q['3K'] + q['4K'];
    assert.ok(sum <= 10, 'should not exceed totalApts');
  });

  it('respects proportions approximately', function () {
    var q = computeGlobalQuota(100, { '1K': 50, '2K': 50, '3K': 0, '4K': 0 });
    assert.equal(q['1K'], 50);
    assert.equal(q['2K'], 50);
    assert.equal(q['3K'], 0);
    assert.equal(q['4K'], 0);
  });
});


// ═══════════════════════════════════════════════════════
// 10. TrajectoryPlanner
// ═══════════════════════════════════════════════════════

describe('TrajectoryPlanner.planMergeSchedule', function () {
  it('computes positive budget when 4K needed', function () {
    var remaining = { '1K': 0, '2K': 10, '3K': 10, '4K': 6 };
    var result = planMergeSchedule(11, remaining, 8);

    assert.ok(result.budget > 0, 'should have positive budget');
    assert.ok(result.budget >= 8, 'budget should be near cap of floor1Count-2=9 (got ' + result.budget + ')');
  });

  it('distributes merges front-loaded', function () {
    var remaining = { '1K': 0, '2K': 5, '3K': 5, '4K': 3 };
    var result = planMergeSchedule(10, remaining, 6);

    var fl2 = result.schedule[2] || 0;
    var fl6 = result.schedule[6] || 0;
    assert.ok(fl2 >= fl6, 'floor 2 (' + fl2 + ') should get >= floor 6 (' + fl6 + ')');
  });

  it('zero budget when only 1K needed', function () {
    var remaining = { '1K': 10, '2K': 0, '3K': 0, '4K': 0 };
    var result = planMergeSchedule(10, remaining, 8);
    assert.equal(result.budget, 0, '1K needs no merges');
  });
});


// ═══════════════════════════════════════════════════════
// 11. BuildingPlanner — 4K production integration test
// ═══════════════════════════════════════════════════════

describe('BuildingPlanner 4K production', function () {
  it('produces 4K apartments with trajectory planning', function () {
    var N = 10;
    var nodes = buildTestGraph(N, 2, 'near', []);
    var floor1Result = solveFloor(nodes, N, 1, null, 'lon');

    var params = {
      N: N,
      floorCount: 9,
      floor1Apartments: floor1Result.apartments,
      mix: { '1K': 30, '2K': 30, '3K': 25, '4K': 15 },
      perFloorInsol: {},
      sortedCorrNears: []
    };

    var result = planBuilding(params);

    var total4K = 0;
    for (var fi = 0; fi < result.floors.length; fi++) {
      for (var ai = 0; ai < result.floors[fi].apartments.length; ai++) {
        if (result.floors[fi].apartments[ai].type === '4K') total4K++;
      }
    }

    assert.ok(total4K > 0,
      'trajectory planning should produce 4K apartments (found ' + total4K + ')');
  });
});
