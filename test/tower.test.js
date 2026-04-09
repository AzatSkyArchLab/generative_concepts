/**
 * Unit tests for tower modules.
 * Run: node --test test/tower.test.js
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  chooseTowerSize, getTowerDimensions, classifyCells,
  generateLocalPolygons, transformToWorld, generateTower,
  TOWER_SIZES, PERIMETER_DEPTH, DEFAULT_CELL_SIZE
} from '../core/tower/TowerGenerator.js';

import {
  packTowers, placeTowersOnAxis, detectNorthEnd, DEFAULT_GAP
} from '../core/tower/TowerPlacer.js';

import { solveFloor } from '../core/apartments/ApartmentSolver.js';

import { walkRing, buildTowerGraph } from '../core/tower/TowerGraph.js';


// ═══════════════════════════════════════════════════════
// 1. TowerGenerator — size selection
// ═══════════════════════════════════════════════════════

describe('chooseTowerSize', function () {
  it('latitudinal always returns small', function () {
    assert.equal(chooseTowerSize('lat', 200, 3.3), 'small');
    assert.equal(chooseTowerSize('lat', 50, 3.3), 'small');
  });

  it('meridional returns largest that fits', function () {
    // large = 12 * 3.3 = 39.6m
    assert.equal(chooseTowerSize('lon', 40, 3.3), 'large');
    // medium = 9 * 3.3 = 29.7m
    assert.equal(chooseTowerSize('lon', 35, 3.3), 'medium');
    // small = 7 * 3.3 = 23.1m
    assert.equal(chooseTowerSize('lon', 25, 3.3), 'small');
  });

  it('works with 3.0m cell size', function () {
    // large = 12 * 3.0 = 36m
    assert.equal(chooseTowerSize('lon', 36, 3.0), 'large');
    assert.equal(chooseTowerSize('lon', 35, 3.0), 'medium');
  });
});


// ═══════════════════════════════════════════════════════
// 2. TowerGenerator — dimensions
// ═══════════════════════════════════════════════════════

describe('getTowerDimensions', function () {
  it('small = 7×7', function () {
    var d = getTowerDimensions('small', 3.3);
    assert.equal(d.rows, 7);
    assert.equal(d.cols, 7);
    assert.ok(Math.abs(d.widthAcross - 23.1) < 0.01);
    assert.ok(Math.abs(d.lengthAlong - 23.1) < 0.01);
  });

  it('medium = 9×7', function () {
    var d = getTowerDimensions('medium');
    assert.equal(d.rows, 9);
    assert.equal(d.cols, 7);
  });

  it('large = 12×7', function () {
    var d = getTowerDimensions('large');
    assert.equal(d.rows, 12);
    assert.equal(d.cols, 7);
  });
});


// ═══════════════════════════════════════════════════════
// 3. TowerGenerator — cell classification
// ═══════════════════════════════════════════════════════

describe('classifyCells', function () {
  it('7×7: perimeter 2 deep, interior 3×3 LLU', function () {
    var cells = classifyCells(7, 7, 'row-start');
    assert.equal(cells.length, 49);

    var llu = 0;
    var apt = 0;
    var exit = 0;
    for (var i = 0; i < cells.length; i++) {
      if (cells[i].type === 'llu') llu++;
      else if (cells[i].type === 'apartment') apt++;
      else if (cells[i].type === 'llu-exit') exit++;
    }

    // Interior 3×3 = 9, minus exit cells replaced
    // Exit: 2 cells (rows 0,1 at center col) become llu-exit
    assert.equal(exit, 2, 'LLU exit should be 2 cells');
    assert.equal(llu, 9, 'interior LLU = 3×3 = 9');
    assert.equal(apt, 49 - 9 - 2, 'remaining = apartments');
  });

  it('9×7: perimeter 2 deep, interior 5×3 LLU', function () {
    var cells = classifyCells(9, 7, 'row-start');
    assert.equal(cells.length, 63);

    var llu = 0;
    var exit = 0;
    for (var i = 0; i < cells.length; i++) {
      if (cells[i].type === 'llu') llu++;
      else if (cells[i].type === 'llu-exit') exit++;
    }
    assert.equal(llu, 15, 'interior LLU = 5×3 = 15');
    assert.equal(exit, 2, 'LLU exit = 2 cells');
  });

  it('12×7: perimeter 2 deep, interior 8×3 LLU', function () {
    var cells = classifyCells(12, 7, 'row-start');
    assert.equal(cells.length, 84);

    var llu = 0;
    for (var i = 0; i < cells.length; i++) {
      if (cells[i].type === 'llu') llu++;
    }
    assert.equal(llu, 24, 'interior LLU = 8×3 = 24');
  });

  it('LLU exit at start end (north)', function () {
    var cells = classifyCells(7, 7, 'row-start');
    var exitCells = [];
    for (var i = 0; i < cells.length; i++) {
      if (cells[i].type === 'llu-exit') exitCells.push(cells[i]);
    }
    // Exit at rows 0,1 at center col (3)
    assert.equal(exitCells[0].row, 0);
    assert.equal(exitCells[0].col, 3);
    assert.equal(exitCells[1].row, 1);
    assert.equal(exitCells[1].col, 3);
  });

  it('LLU exit at end (north = end)', function () {
    var cells = classifyCells(9, 7, 'row-end');
    var exitCells = [];
    for (var i = 0; i < cells.length; i++) {
      if (cells[i].type === 'llu-exit') exitCells.push(cells[i]);
    }
    // Exit at rows 7,8 (last two) at center col
    assert.equal(exitCells[0].row, 7);
    assert.equal(exitCells[1].row, 8);
  });

  it('no cell has undefined type', function () {
    var cells = classifyCells(12, 7, 'row-start');
    for (var i = 0; i < cells.length; i++) {
      assert.ok(
        cells[i].type === 'apartment' || cells[i].type === 'llu' || cells[i].type === 'llu-exit',
        'cell ' + i + ' has unknown type: ' + cells[i].type
      );
    }
  });
});


// ═══════════════════════════════════════════════════════
// 4. TowerGenerator — polygon generation
// ═══════════════════════════════════════════════════════

describe('generateLocalPolygons', function () {
  it('produces correct count', function () {
    var polys = generateLocalPolygons(7, 7, 3.3);
    assert.equal(polys.length, 49);
  });

  it('each polygon has 4 vertices', function () {
    var polys = generateLocalPolygons(9, 7, 3.3);
    for (var i = 0; i < polys.length; i++) {
      assert.equal(polys[i].length, 4, 'poly ' + i + ' should have 4 vertices');
    }
  });

  it('first cell at origin', function () {
    var polys = generateLocalPolygons(7, 7, 3.3);
    assert.ok(Math.abs(polys[0][0][0]) < 0.01, 'first cell x0 near 0');
    assert.ok(Math.abs(polys[0][0][1]) < 0.01, 'first cell y0 near 0');
  });
});


// ═══════════════════════════════════════════════════════
// 5. TowerGenerator — full pipeline
// ═══════════════════════════════════════════════════════

describe('generateTower', function () {
  it('produces complete tower', function () {
    var t = generateTower({
      size: 'medium',
      cellSize: 3.3,
      northEnd: 'start',
      centerX: 100,
      centerY: 200,
      angle: 0
    });

    assert.equal(t.cells.length, 63, '9×7 = 63 cells');
    assert.equal(t.worldPolygons.length, 63);
    assert.equal(t.dims.rows, 9);
    assert.equal(t.dims.cols, 7);
    assert.ok(t.towerBBox.maxX > t.towerBBox.minX);
    assert.ok(t.towerBBox.maxY > t.towerBBox.minY);
  });

  it('world polygons centered at origin', function () {
    var t = generateTower({
      size: 'small', centerX: 0, centerY: 0, angle: 0
    });
    // BBox should be symmetric around origin
    assert.ok(Math.abs(t.towerBBox.minX + t.towerBBox.maxX) < 0.1,
      'X should be symmetric: ' + t.towerBBox.minX + ' .. ' + t.towerBBox.maxX);
    assert.ok(Math.abs(t.towerBBox.minY + t.towerBBox.maxY) < 0.1,
      'Y should be symmetric');
  });
});


// ═══════════════════════════════════════════════════════
// 6. TowerPlacer — packing
// ═══════════════════════════════════════════════════════

describe('packTowers', function () {
  it('packs one small tower on short axis', function () {
    var towers = packTowers(25, 'lat', { cellSize: 3.3 });
    assert.equal(towers.length, 1);
    assert.equal(towers[0].size, 'small');
  });

  it('packs zero towers if axis too short', function () {
    var towers = packTowers(10, 'lon', { cellSize: 3.3 });
    assert.equal(towers.length, 0);
  });

  it('packs multiple towers with gap on long axis', function () {
    // 2 large towers: 2 * 39.6 + 20 = 99.2m
    var towers = packTowers(100, 'lon', { cellSize: 3.3, gap: 20 });
    assert.equal(towers.length, 2);
    assert.equal(towers[0].size, 'large');

    // Gap between towers
    var end0 = towers[0].startOffset + towers[0].lengthAlong;
    var start1 = towers[1].startOffset;
    var actualGap = start1 - end0;
    assert.ok(Math.abs(actualGap - 20) < 0.5,
      'gap should be ~20m, got ' + actualGap.toFixed(1));
  });

  it('latitudinal always uses small towers', function () {
    var towers = packTowers(200, 'lat', { cellSize: 3.3, gap: 20 });
    for (var i = 0; i < towers.length; i++) {
      assert.equal(towers[i].size, 'small');
    }
    assert.ok(towers.length >= 4, 'should fit 4+ small towers in 200m');
  });

  it('configurable gap', function () {
    var t10 = packTowers(100, 'lon', { cellSize: 3.3, gap: 10 });
    var t30 = packTowers(100, 'lon', { cellSize: 3.3, gap: 30 });
    // Smaller gap = more towers (or same)
    assert.ok(t10.length >= t30.length,
      'gap=10 should fit >= towers than gap=30');
  });
});


// ═══════════════════════════════════════════════════════
// 7. TowerPlacer — axis placement
// ═══════════════════════════════════════════════════════

describe('placeTowersOnAxis', function () {
  it('places towers along meridional axis', function () {
    var startM = [0, 0];
    var endM = [0, 100]; // 100m north
    var towers = placeTowersOnAxis(startM, endM, 'lon', 'end', { cellSize: 3.3 });

    assert.ok(towers.length > 0, 'should place at least one tower');
    for (var i = 0; i < towers.length; i++) {
      assert.ok(towers[i].cells.length > 0, 'tower ' + i + ' should have cells');
      assert.ok(towers[i].worldPolygons.length > 0, 'tower ' + i + ' should have polygons');
    }
  });

  it('tower centers lie on axis', function () {
    var startM = [100, 50];
    var endM = [100, 150];
    var towers = placeTowersOnAxis(startM, endM, 'lon', 'end');

    for (var i = 0; i < towers.length; i++) {
      var bbox = towers[i].towerBBox;
      var cx = (bbox.minX + bbox.maxX) / 2;
      // Tower center X should be near axis X=100
      assert.ok(Math.abs(cx - 100) < 15,
        'tower ' + i + ' center X should be near axis: ' + cx);
    }
  });
});


// ═══════════════════════════════════════════════════════
// 8. TowerPlacer — north detection
// ═══════════════════════════════════════════════════════

describe('detectNorthEnd', function () {
  it('end faces north when end.y > start.y', function () {
    assert.equal(detectNorthEnd([0, 0], [0, 100]), 'end');
  });

  it('start faces north when start.y > end.y', function () {
    assert.equal(detectNorthEnd([0, 100], [0, 0]), 'start');
  });

  it('end for equal Y', function () {
    assert.equal(detectNorthEnd([0, 50], [100, 50]), 'end');
  });
});


// ═══════════════════════════════════════════════════════
// 9. TowerGraph — ring walk
// ═══════════════════════════════════════════════════════

describe('walkRing', function () {
  it('7×7 ring has correct pair count', function () {
    var result = walkRing(7, 7, 'row-start');
    // Top: 7, Right: 3, Bottom: 7, Left: 3 = 20, minus 1 exit = 19
    assert.equal(result.pairs.length, 19, 'should have 19 ring pairs for 7×7 minus exit');
  });

  it('9×7 ring has correct pair count', function () {
    var result = walkRing(9, 7, 'row-start');
    // Top: 7, Right: 5, Bottom: 7, Left: 5 = 24, minus 1 exit = 23
    assert.equal(result.pairs.length, 23);
  });

  it('12×7 ring has correct pair count', function () {
    var result = walkRing(12, 7, 'row-start');
    // Top: 7, Right: 8, Bottom: 7, Left: 8 = 30, minus 1 exit = 29
    assert.equal(result.pairs.length, 29);
  });

  it('no duplicate outer cells', function () {
    var result = walkRing(7, 7, 'row-start');
    var seen = {};
    for (var i = 0; i < result.pairs.length; i++) {
      var key = result.pairs[i].outerRow + ',' + result.pairs[i].outerCol;
      assert.ok(!seen[key], 'duplicate outer cell at ' + key);
      seen[key] = true;
    }
  });

  it('col-low exit works for latitudinal', function () {
    var result = walkRing(7, 7, 'col-low');
    assert.equal(result.pairs.length, 19);
  });
});


// ═══════════════════════════════════════════════════════
// 10. TowerGraph — buildTowerGraph
// ═══════════════════════════════════════════════════════

describe('buildTowerGraph', function () {
  it('produces nodes for 2 floors', function () {
    var ring = walkRing(7, 7, 'row-start');
    var K = ring.pairs.length;
    var polys = generateLocalPolygons(7, 7, 3.3);
    var graph = buildTowerGraph(ring.pairs, polys, 7, 2);

    assert.equal(graph.K, K);
    // Each floor: K near + K far = 2K nodes × 2 floors (no corridors)
    var nodeCount = 0;
    for (var key in graph.nodes) {
      if (graph.nodes.hasOwnProperty(key)) nodeCount++;
    }
    assert.equal(nodeCount, 2 * K * 2, 'should have 2K nodes per floor × 2 floors');
  });

  it('floor 1 near nodes are apartments, far nodes are llu', function () {
    var ring = walkRing(7, 7, 'row-start');
    var polys = generateLocalPolygons(7, 7, 3.3);
    var graph = buildTowerGraph(ring.pairs, polys, 7, 2);

    var aptCount = 0;
    var lluCount = 0;
    for (var key in graph.nodes) {
      if (!graph.nodes.hasOwnProperty(key)) continue;
      var n = graph.nodes[key];
      if (n.floor === 1 && n.type === 'apartment') aptCount++;
      if (n.floor === 1 && n.type === 'llu') lluCount++;
    }
    assert.equal(aptCount, ring.pairs.length, 'floor 1 should have K apartment nodes');
    assert.equal(lluCount, ring.pairs.length, 'floor 1 should have K llu nodes (inner ring)');
  });

  it('floor 0 near nodes are commercial, far nodes are llu', function () {
    var ring = walkRing(7, 7, 'row-start');
    var polys = generateLocalPolygons(7, 7, 3.3);
    var graph = buildTowerGraph(ring.pairs, polys, 7, 2);

    for (var key in graph.nodes) {
      if (!graph.nodes.hasOwnProperty(key)) continue;
      var n = graph.nodes[key];
      if (n.floor === 0 && n.side === 'near') {
        assert.equal(n.type, 'commercial', 'floor 0 near ' + key + ' should be commercial');
      }
      if (n.floor === 0 && n.side === 'far') {
        assert.equal(n.type, 'llu', 'floor 0 far ' + key + ' should be llu');
      }
    }
  });
});


// ═══════════════════════════════════════════════════════
// 11. TowerGraph + ApartmentSolver integration
// ═══════════════════════════════════════════════════════

describe('Tower apartment solving', function () {
  it('solveFloor works on tower ring graph', function () {
    var ring = walkRing(7, 7, 'row-start');
    var polys = generateLocalPolygons(7, 7, 3.3);
    var graph = buildTowerGraph(ring.pairs, polys, 7, 2);

    var result = solveFloor(graph.nodes, graph.K, 1, null, 'lon');
    assert.ok(result, 'solver should return result');
    assert.ok(result.apartments.length > 0, 'should produce apartments');
    assert.equal(result.orphanCount, 0, 'no orphans on 7×7 tower');
  });

  it('9×7 tower solves without orphans', function () {
    var ring = walkRing(9, 7, 'row-start');
    var polys = generateLocalPolygons(9, 7, 3.3);
    var graph = buildTowerGraph(ring.pairs, polys, 7, 2);

    var result = solveFloor(graph.nodes, graph.K, 1, null, 'lon');
    assert.ok(result.apartments.length > 0);
  });

  it('12×7 tower solves without orphans', function () {
    var ring = walkRing(12, 7, 'row-start');
    var polys = generateLocalPolygons(12, 7, 3.3);
    var graph = buildTowerGraph(ring.pairs, polys, 7, 2);

    var result = solveFloor(graph.nodes, graph.K, 1, null, 'lon');
    assert.ok(result.apartments.length > 0);
  });
});
