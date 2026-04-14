/**
 * Tests for InsolationCalc — GOST R 57795-2017 evaluation.
 * Run: node --test test/insolation.test.js
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { evaluateInsolation, analyzePoint, STATUS } from '../core/insolation/InsolationCalc.js';


// ═══════════════════════════════════════════════════════
// evaluateInsolation
// ═══════════════════════════════════════════════════════

describe('evaluateInsolation', function () {
  it('all free — continuous pass', function () {
    // 15 rays × 10min = 150min > 120min requirement
    var isFree = [];
    for (var i = 0; i < 15; i++) isFree.push(true);
    var r = evaluateInsolation(isFree, 120);
    assert.strictEqual(r.status, 'PASS');
    assert.strictEqual(r.totalMinutes, 150);
    assert.strictEqual(r.hasInterruption, false);
    assert.strictEqual(r.periodsCount, 1);
  });

  it('all blocked — fail', function () {
    var isFree = [];
    for (var i = 0; i < 15; i++) isFree.push(false);
    var r = evaluateInsolation(isFree, 120);
    assert.strictEqual(r.status, 'FAIL');
    assert.strictEqual(r.totalMinutes, 0);
    assert.strictEqual(r.freeCount, 0);
    assert.strictEqual(r.blockedCount, 15);
  });

  it('exact threshold — 12 rays = 120min = PASS', function () {
    var isFree = [];
    for (var i = 0; i < 12; i++) isFree.push(true);
    var r = evaluateInsolation(isFree, 120);
    assert.strictEqual(r.status, 'PASS');
    assert.strictEqual(r.totalMinutes, 120);
  });

  it('shortage ≤ 30min — WARNING', function () {
    // 10 rays = 100min, shortage = 20min ≤ 30 → WARNING
    var isFree = [];
    for (var i = 0; i < 10; i++) isFree.push(true);
    var r = evaluateInsolation(isFree, 120);
    assert.strictEqual(r.status, 'WARNING');
    assert.strictEqual(r.shortageMinutes, 20);
  });

  it('shortage > 30min — FAIL', function () {
    // 5 rays = 50min, shortage = 70min > 30 → FAIL
    var isFree = [];
    for (var i = 0; i < 5; i++) isFree.push(true);
    var r = evaluateInsolation(isFree, 120);
    assert.strictEqual(r.status, 'FAIL');
    assert.strictEqual(r.shortageMinutes, 70);
  });

  it('interrupted — 2 periods, total ≥ 150min, each ≥ 60min → PASS', function () {
    // Period 1: 8 rays = 80min, gap of 3+ rays, period 2: 8 rays = 80min
    // Total = 160min ≥ 150 (120+30), both ≥ 60 → PASS
    var isFree = [];
    for (var i = 0; i < 8; i++) isFree.push(true);
    for (var i = 0; i < 5; i++) isFree.push(false);
    for (var i = 0; i < 8; i++) isFree.push(true);
    var r = evaluateInsolation(isFree, 120);
    assert.strictEqual(r.status, 'PASS');
    assert.ok(r.hasInterruption);
    assert.strictEqual(r.periodsCount, 2);
    assert.ok(r.totalMinutes >= 150);
  });

  it('interrupted — short period OK if max period ≥ 60min', function () {
    // Period 1: 4 rays = 40min (<60 but that's fine), period 2: 12 rays = 120min (≥60)
    // Total = 160min ≥ 150 → PASS (GOST requires at least one period ≥ 60min)
    var isFree = [];
    for (var i = 0; i < 4; i++) isFree.push(true);
    for (var i = 0; i < 5; i++) isFree.push(false);
    for (var i = 0; i < 12; i++) isFree.push(true);
    var r = evaluateInsolation(isFree, 120);
    assert.strictEqual(r.status, 'PASS');
    assert.ok(r.hasInterruption);
    assert.ok(r.maxPeriodMinutes >= 60);
  });

  it('interrupted — no period ≥ 60min → FAIL', function () {
    // Period 1: 5 rays = 50min, gap, period 2: 5 rays = 50min
    // Total = 100min, max period = 50 < 60 → FAIL
    var isFree = [];
    for (var i = 0; i < 5; i++) isFree.push(true);
    for (var i = 0; i < 5; i++) isFree.push(false);
    for (var i = 0; i < 5; i++) isFree.push(true);
    var r = evaluateInsolation(isFree, 120);
    assert.strictEqual(r.status, 'FAIL');
    assert.ok(r.hasInterruption);
    assert.ok(r.maxPeriodMinutes < 60);
  });

  it('1-ray gap tolerance — does not break continuity', function () {
    // 6 free, 1 blocked, 6 free → should be 1 period (gap tolerated)
    var isFree = [];
    for (var i = 0; i < 6; i++) isFree.push(true);
    isFree.push(false);
    for (var i = 0; i < 6; i++) isFree.push(true);
    var r = evaluateInsolation(isFree, 120);
    assert.strictEqual(r.periodsCount, 1, '1-ray gap should not break period');
    // But gap is penalized: 12 rays, 1 gap → 120 - 10 = 110min
    assert.strictEqual(r.totalMinutes, 110);
  });

  it('2-ray gap — breaks into 2 periods', function () {
    // 6 free, 2 blocked, 6 free → 2 periods
    var isFree = [];
    for (var i = 0; i < 6; i++) isFree.push(true);
    isFree.push(false);
    isFree.push(false);
    for (var i = 0; i < 6; i++) isFree.push(true);
    var r = evaluateInsolation(isFree, 120);
    assert.strictEqual(r.periodsCount, 2, '2-ray gap should break into 2 periods');
  });

  it('empty array → FAIL', function () {
    var r = evaluateInsolation([], 120);
    assert.strictEqual(r.status, 'FAIL');
    assert.strictEqual(r.totalMinutes, 0);
  });
});


// ═══════════════════════════════════════════════════════
// analyzePoint
// ═══════════════════════════════════════════════════════

describe('analyzePoint', function () {
  it('no obstacles — all rays free → PASS', function () {
    var sunVectors = [];
    for (var i = 0; i < 15; i++) sunVectors.push([Math.cos(i * 0.2), Math.sin(i * 0.2), 0.5]);
    var r = analyzePoint({
      point: [0, 0, 5],
      sunVectors: sunVectors,
      raycast: function () { return null; }, // no hit
      normativeMinutes: 120
    });
    assert.strictEqual(r.evaluation.status, 'PASS');
    assert.strictEqual(r.perRay.length, 15);
    for (var i = 0; i < r.perRay.length; i++) {
      assert.ok(r.perRay[i].free);
    }
  });

  it('all blocked — all rays hit → FAIL', function () {
    var sunVectors = [];
    for (var i = 0; i < 15; i++) sunVectors.push([1, 0, 0.5]);
    var r = analyzePoint({
      point: [0, 0, 5],
      sunVectors: sunVectors,
      raycast: function () { return 10; }, // hit at 10m
      normativeMinutes: 120
    });
    assert.strictEqual(r.evaluation.status, 'FAIL');
    assert.strictEqual(r.evaluation.totalMinutes, 0);
  });

  it('hit beyond maxDistance — counts as free', function () {
    var sunVectors = [[1, 0, 0.5]];
    var r = analyzePoint({
      point: [0, 0, 5],
      sunVectors: sunVectors,
      raycast: function () { return 600; }, // beyond 500m default
      normativeMinutes: 120,
      maxDistance: 500
    });
    assert.ok(r.perRay[0].free, 'hit beyond maxDistance should be free');
  });
});
