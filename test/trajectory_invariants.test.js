/**
 * TrajectoryPlanner — invariants and boost-branch edge cases.
 *
 * Main invariant: sum(profile) === targetTotal across ALL valid inputs.
 * If this fails, the building quota is silently under- or over-delivered.
 *
 * Run: node --test test/trajectory_invariants.test.js
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { planMergeSchedule } from '../core/apartments/TrajectoryPlanner.js';

function sum(arr) {
  var s = 0;
  for (var i = 0; i < arr.length; i++) s += arr[i];
  return s;
}

describe('TrajectoryPlanner — profile sum invariant', function () {

  it('sum(profile) === targetTotal for broad parameter sweep', function () {
    var failures = [];
    var checked = 0;

    for (var f1 = 2; f1 <= 10; f1++) {
      for (var rf = 2; rf <= 25; rf++) {
        var minTT = f1 + 2 * (rf - 1); // can't have < 2 per floor
        var maxTT = f1 * rf;           // no merges = max
        for (var tt = minTT; tt <= maxTT; tt++) {
          checked++;
          var result = planMergeSchedule(f1, {}, rf, tt);
          var s = sum(result.profile);
          if (s !== tt) {
            failures.push({
              f1: f1, rf: rf, targetTotal: tt,
              profileSum: s, profile: result.profile.slice()
            });
            if (failures.length >= 10) break;
          }
        }
        if (failures.length >= 10) break;
      }
      if (failures.length >= 10) break;
    }

    if (failures.length > 0) {
      var msg = 'Profile sum mismatch in ' + failures.length + ' cases (of ' + checked + ' checked).\n';
      for (var i = 0; i < failures.length; i++) {
        var f = failures[i];
        msg += '  f1=' + f.f1 + ', rf=' + f.rf + ', target=' + f.targetTotal
             + ': got sum=' + f.profileSum + ', profile=[' + f.profile.join(',') + ']\n';
      }
      assert.fail(msg);
    }
  });

  it('clamps targetTotal above noMergeTotal silently (f1=3, rf=20, tt=65 > maxTT=60)', function () {
    // targetTotal=65 exceeds physical maximum (no-merge total = 60).
    // Code clamps silently to maxTT=60 and returns a valid profile summing to 60.
    // This is a known contract: caller must ensure tt <= f1 * rf.
    var result = planMergeSchedule(3, {}, 20, 65);
    var s = sum(result.profile);
    assert.equal(s, 60, 'clamped profile should sum to maxTT=60');
  });

  it('clamps targetTotal below minTotal silently (f1=4, rf=25, tt=40 < minTT=52)', function () {
    // targetTotal=40 is below the physical minimum (f1 + 2*(rf-1) = 52).
    // Code clamps silently to minTT=52 — this is the ACTIVE BUG described
    // in analysis: when the building has too few floor-1 apartments and
    // too many residential floors, caller's quota becomes infeasible,
    // but no signal is returned. The BuildingPlanner uses `quota` (40)
    // while TrajectoryPlanner internally uses `minTT` (52), causing type
    // distribution drift.
    //
    // After fix: result should include a `feasible: false` flag OR
    // `targetTotalEffective` field so BuildingPlanner can react.
    var result = planMergeSchedule(4, {}, 25, 40);
    var s = sum(result.profile);
    // Current behaviour: silent clamp to 52
    assert.equal(s, 52, 'currently clamps to minTT — see TODO in TrajectoryPlanner');
    // After fix we expect one of these to be true:
    // assert.equal(result.feasible, false);
    // assert.ok(result.targetTotalEffective > 40);
  });

  it('boost branch with room to grow: f1=5, rf=10, tt=45', function () {
    // remainingApts=40, upperFloors=9, basePerFloor=floor(40/9)=4, clamped [2,5]=4
    // baseTotal=5+4*9=41, excess=-4, boost
    // boosted value = min(5, 5) = 5 → 4 floors boosted to 5
    var result = planMergeSchedule(5, {}, 10, 45);
    var s = sum(result.profile);
    assert.equal(s, 45, 'Expected sum=45, got ' + s + ', profile=[' + result.profile.join(',') + ']');
  });

  it('excess branch: sum equals targetTotal', function () {
    // f1=4, rf=10, tt=25
    // remainingApts=21, basePerFloor=floor(21/9)=2, clamped[2,4]=2
    // baseTotal=4+2*9=22, excess=-3, boost
    var result = planMergeSchedule(4, {}, 10, 25);
    var s = sum(result.profile);
    assert.equal(s, 25);
  });

  it('no-merge case: sum=f1*rf', function () {
    var result = planMergeSchedule(5, {}, 10, 50);
    assert.equal(sum(result.profile), 50);
  });

  it('maximum merges: sum=minTT', function () {
    // minTT = f1 + 2*(rf-1) = 5 + 2*9 = 23
    var result = planMergeSchedule(5, {}, 10, 23);
    assert.equal(sum(result.profile), 23);
  });

  it('single residential floor: profile=[f1]', function () {
    var result = planMergeSchedule(6, {}, 1, 6);
    assert.deepEqual(result.profile, [6]);
  });
});

describe('TrajectoryPlanner — feasibility signalling', function () {
  it('returns feasible=true when input is within physical limits', function () {
    var r = planMergeSchedule(5, {}, 10, 30);
    assert.equal(r.feasible, true);
    assert.equal(r.clampDirection, null);
    assert.equal(r.requestedTotal, 30);
    assert.equal(r.effectiveTotal, 30);
  });

  it('returns feasible=false when targetTotal below minTT', function () {
    // f1=4, rf=25: minTT = 4 + 48 = 52, maxTT = 100
    var r = planMergeSchedule(4, {}, 25, 40);
    assert.equal(r.feasible, false);
    assert.equal(r.clampDirection, 'below');
    assert.equal(r.requestedTotal, 40);
    assert.equal(r.effectiveTotal, 52);
    assert.equal(r.minTotal, 52);
    assert.equal(r.maxTotal, 100);
  });

  it('returns feasible=false when targetTotal above maxTT', function () {
    var r = planMergeSchedule(3, {}, 20, 65);
    assert.equal(r.feasible, false);
    assert.equal(r.clampDirection, 'above');
    assert.equal(r.requestedTotal, 65);
    assert.equal(r.effectiveTotal, 60);
  });

  it('reports same minTotal/maxTotal at boundaries', function () {
    var r = planMergeSchedule(5, {}, 10, 23); // exactly minTT
    assert.equal(r.feasible, true);
    assert.equal(r.effectiveTotal, 23);

    var r2 = planMergeSchedule(5, {}, 10, 50); // exactly maxTT
    assert.equal(r2.feasible, true);
    assert.equal(r2.effectiveTotal, 50);
  });
});

describe('TrajectoryPlanner — feasibility does not break existing callers', function () {
  it('result still has schedule/budget/profile fields', function () {
    var r = planMergeSchedule(5, {}, 10, 30);
    assert.ok(Array.isArray(r.profile));
    assert.ok(typeof r.budget === 'number');
    assert.ok(typeof r.schedule === 'object');
  });
});

describe('TrajectoryPlanner — monotonicity', function () {
  it('profile is non-increasing', function () {
    var failures = [];
    for (var f1 = 2; f1 <= 8; f1++) {
      for (var rf = 3; rf <= 20; rf++) {
        var minTT = f1 + 2 * (rf - 1);
        var maxTT = f1 * rf;
        for (var tt = minTT; tt <= maxTT; tt++) {
          var p = planMergeSchedule(f1, {}, rf, tt).profile;
          for (var fl = 1; fl < p.length; fl++) {
            if (p[fl] > p[fl - 1]) {
              failures.push({ f1, rf, tt, fl, profile: p.slice() });
              break;
            }
          }
          if (failures.length >= 5) break;
        }
        if (failures.length >= 5) break;
      }
      if (failures.length >= 5) break;
    }
    if (failures.length > 0) {
      var msg = 'Monotonicity violations:\n';
      for (var i = 0; i < failures.length; i++) {
        msg += '  f1=' + failures[i].f1 + ', rf=' + failures[i].rf
             + ', tt=' + failures[i].tt + ': [' + failures[i].profile.join(',') + ']\n';
      }
      assert.fail(msg);
    }
  });
});
