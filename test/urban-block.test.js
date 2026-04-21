/**
 * Tests for urban block pipeline: geometry, processor, solver, simplifier.
 * Run: node --test test/urban-block.test.js
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  signedArea, ensureCCW, ringCentroid, pointInPolygon,
  vecSub, vecAdd, vecLength, vecDist, angleBetween, vecPerp
} from '../core/geo/geometry.js';

import {
  simplifyVW, simplifyPoly, removeCollinear, simplifyPolygon
} from '../core/geo/PolygonSimplifier.js';

import {
  solveUrbanBlock, DEFAULT_PARAMS
} from '../core/urban-block/UrbanBlockSolver.js';


// ═══════════════════════════════════════════════════════
// Test polygons
// ═══════════════════════════════════════════════════════

var RECT = [[0, 0], [180, 0], [180, 120], [0, 120]];
var L_SHAPE = [[0, 0], [140, 0], [140, 60], [200, 60], [200, 160], [0, 160]];
var TRIANGLE = [[0, 0], [100, 0], [50, 80]];
var TRAPEZOID = [[30, 0], [170, 0], [200, 140], [0, 140]];
var PENTAGON = [[100, 0], [200, 55], [170, 160], [30, 160], [0, 55]];
// Rectangle with midpoints on edges (8 verts, should simplify to 4)
var RECT_MID = [[0, 0], [90, 0], [180, 0], [180, 60], [180, 120], [90, 120], [0, 120], [0, 60]];


// ═══════════════════════════════════════════════════════
// geometry.js
// ═══════════════════════════════════════════════════════

describe('geometry basics', function () {
  it('signedArea — CCW positive', function () {
    var area = signedArea(RECT);
    assert.ok(area > 0, 'CCW rectangle should have positive area');
    assert.ok(Math.abs(area - 180 * 120) < 1, 'area should be 180×120');
  });

  it('signedArea — CW negative', function () {
    var cw = RECT.slice().reverse();
    assert.ok(signedArea(cw) < 0);
  });

  it('ensureCCW — reverses CW ring', function () {
    var cw = RECT.slice().reverse();
    var ccw = ensureCCW(cw);
    assert.ok(signedArea(ccw) > 0);
  });

  it('ensureCCW — keeps CCW ring', function () {
    var ccw = ensureCCW(RECT);
    assert.ok(signedArea(ccw) > 0);
    assert.deepStrictEqual(ccw, RECT);
  });

  it('ringCentroid — rectangle center', function () {
    var c = ringCentroid(RECT);
    assert.ok(Math.abs(c[0] - 90) < 1);
    assert.ok(Math.abs(c[1] - 60) < 1);
  });

  it('pointInPolygon — inside and outside', function () {
    assert.ok(pointInPolygon([90, 60], RECT));
    assert.ok(!pointInPolygon([200, 60], RECT));
    assert.ok(!pointInPolygon([-10, 60], RECT));
  });

  it('pointInPolygon — L-shape concavity', function () {
    // Inside the L
    assert.ok(pointInPolygon([70, 80], L_SHAPE));
    // In the cut-out corner (outside)
    assert.ok(!pointInPolygon([160, 30], L_SHAPE));
  });

  it('vecSub / vecAdd / vecLength', function () {
    var a = [3, 4], b = [1, 1];
    var d = vecSub(a, b);
    assert.deepStrictEqual(d, [2, 3]);
    assert.deepStrictEqual(vecAdd(a, b), [4, 5]);
    assert.ok(Math.abs(vecLength([3, 4]) - 5) < 1e-10);
  });

  it('angleBetween — perpendicular = 90°', function () {
    var angle = angleBetween([1, 0], [0, 1]);
    assert.ok(Math.abs(angle - 90) < 0.1);
  });

  it('angleBetween — anti-parallel = 0° (collinear)', function () {
    // angleBetween measures deviation from straight line, not full angle
    var angle = angleBetween([1, 0], [-1, 0]);
    assert.ok(Math.abs(angle) < 0.1, 'anti-parallel is collinear = 0°');
  });
});


// ═══════════════════════════════════════════════════════
// PolygonProcessor
// ═══════════════════════════════════════════════════════

describe('PolygonSimplifier', function () {
  it('removeCollinear — drops midpoints from rectangle', function () {
    var cleaned = removeCollinear(RECT_MID, 0.01);
    assert.strictEqual(cleaned.length, 4);
  });

  it('removeCollinear — keeps all L-shape vertices', function () {
    var cleaned = removeCollinear(L_SHAPE, 0.01);
    assert.strictEqual(cleaned.length, 6);
  });

  it('removeCollinear — triangle is minimum', function () {
    var cleaned = removeCollinear(TRIANGLE, 0.01);
    assert.strictEqual(cleaned.length, 3);
  });

  it('simplifyVW — rectangle stays at minVerts=4', function () {
    var s = simplifyVW(RECT, 4);
    assert.strictEqual(s.length, 4, 'rectangle with 4 corners should stay at 4');
  });

  it('simplifyVW — 8-vert rect to 4', function () {
    var s = simplifyVW(RECT_MID, 4);
    assert.strictEqual(s.length, 4);
  });

  it('simplifyPoly — area tolerance respected', function () {
    var s = simplifyPoly(RECT_MID, 0.02);
    assert.ok(s.length <= 4, 'should simplify with <2% area loss');
  });

  it('simplifyPolygon — combined pipeline', function () {
    var r = simplifyPolygon(RECT_MID, { areaTol: 0.02, collinearTol: 0.01 });
    assert.strictEqual(r.origCount, 8);
    assert.ok(r.newCount <= 4);
    assert.ok(r.areaError < 0.02);
  });

  it('simplifyPolygon — L-shape preserved', function () {
    var r = simplifyPolygon(L_SHAPE, { areaTol: 0.02 });
    assert.strictEqual(r.newCount, 6, 'all L-shape vertices are structurally important');
  });

  it('simplifyPolygon — pentagon preserved', function () {
    var r = simplifyPolygon(PENTAGON, { areaTol: 0.02 });
    assert.strictEqual(r.newCount, 5);
  });
});


// ═══════════════════════════════════════════════════════
// UrbanBlockSolver
// ═══════════════════════════════════════════════════════

describe('UrbanBlockSolver', function () {
  it('solveUrbanBlock — rectangle produces axes', function () {
    var axes = solveUrbanBlock(ensureCCW(RECT), { simplify: null });
    assert.ok(axes.length >= 2, 'rectangle should have at least 2 axes');
    var withSecs = 0;
    for (var i = 0; i < axes.length; i++) {
      if (axes[i].secs && axes[i].secs.length > 0) withSecs++;
    }
    assert.ok(withSecs >= 1, 'at least one axis should have sections');
  });

  it('solveUrbanBlock — sections have valid lengths', function () {
    var axes = solveUrbanBlock(ensureCCW(RECT), { simplify: null });
    for (var i = 0; i < axes.length; i++) {
      if (!axes[i].secs) continue;
      for (var j = 0; j < axes[i].secs.length; j++) {
        var sec = axes[i].secs[j];
        if (sec.gap) continue;
        assert.ok(sec.l > 0, 'section length must be positive');
        // Check section is in allowed lens
        var lens = axes[i].orientation === 0 ? DEFAULT_PARAMS.latLens : DEFAULT_PARAMS.lonLens;
        var found = false;
        for (var k = 0; k < lens.length; k++) {
          if (Math.abs(sec.l - lens[k]) < 0.01) found = true;
        }
        assert.ok(found, 'section ' + sec.l + ' must be in allowed lengths');
      }
    }
  });

  it('solveUrbanBlock — L-shape produces axes', function () {
    var axes = solveUrbanBlock(ensureCCW(L_SHAPE), { simplify: null });
    assert.ok(axes.length >= 2, 'L-shape should have at least 2 axes');
  });

  it('solveUrbanBlock — trapezoid works without crash', function () {
    var axes = solveUrbanBlock(ensureCCW(TRAPEZOID), { simplify: null });
    assert.ok(Array.isArray(axes), 'should return array');
  });

  it('solveUrbanBlock — pentagon works without crash', function () {
    var axes = solveUrbanBlock(ensureCCW(PENTAGON), { simplify: null });
    assert.ok(Array.isArray(axes), 'should return array');
  });

  it('solveUrbanBlock — small polygon returns empty', function () {
    var tiny = [[0, 0], [5, 0], [5, 5], [0, 5]];
    var axes = solveUrbanBlock(ensureCCW(tiny), { simplify: null });
    var withSecs = 0;
    for (var i = 0; i < axes.length; i++) {
      if (axes[i].secs && axes[i].secs.length > 0) withSecs++;
    }
    assert.strictEqual(withSecs, 0, 'too small for any section');
  });

  it('solveUrbanBlock — with simplification', function () {
    var axes = solveUrbanBlock(ensureCCW(RECT_MID), {
      simplify: { areaTol: 0.02, collinearTol: 0.01 }
    });
    assert.ok(axes.length >= 2, 'simplified 8-vert rect should still produce axes');
  });

  it('DEFAULT_PARAMS has expected structure', function () {
    assert.ok(DEFAULT_PARAMS.sw > 0);
    assert.ok(DEFAULT_PARAMS.fire > 0);
    assert.ok(DEFAULT_PARAMS.latLens.length > 0);
    assert.ok(DEFAULT_PARAMS.lonLens.length > 0);
  });
});
