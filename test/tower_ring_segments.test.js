/**
 * TowerGraph — ring segment integrity after corner breaks.
 *
 * Invariants:
 * 1. No near-segment consists of a single cell (obvious degenerate case)
 * 2. STRICTER: no horizontal edge connects two cells from different sides
 *    of the ring — such an edge creates L-shape apartments spanning a corner,
 *    which violates the documented intent of buildTowerGraph.
 *
 * Run: node --test test/tower_ring_segments.test.js
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  walkRing, buildTowerGraph
} from '../core/tower/TowerGraph.js';

import {
  generateLocalPolygons, getTowerDimensions
} from '../core/tower/TowerGenerator.js';

function extractNearSegments(graph, floor) {
  var nearCids = [];
  for (var key in graph.nodes) {
    if (!graph.nodes.hasOwnProperty(key)) continue;
    var n = graph.nodes[key];
    if (n.floor === floor && n.side === 'near') nearCids.push(n.cellId);
  }
  nearCids.sort(function (a, b) { return a - b; });

  var adj = {};
  for (var i = 0; i < nearCids.length; i++) adj[nearCids[i]] = [];
  for (var ei = 0; ei < graph.edges.length; ei++) {
    var e = graph.edges[ei];
    if (e.type !== 'horizontal') continue;
    var fromParts = e.from.split(':');
    var toParts = e.to.split(':');
    if (parseInt(fromParts[1], 10) !== floor) continue;
    var fcid = parseInt(fromParts[0], 10);
    var tcid = parseInt(toParts[0], 10);
    if (adj[fcid]) adj[fcid].push(tcid);
    if (adj[tcid]) adj[tcid].push(fcid);
  }

  var visited = {};
  var segments = [];
  for (var i = 0; i < nearCids.length; i++) {
    var root = nearCids[i];
    if (visited[root]) continue;
    var comp = [];
    var stack = [root];
    while (stack.length) {
      var v = stack.pop();
      if (visited[v]) continue;
      visited[v] = true;
      comp.push(v);
      var nbrs = adj[v] || [];
      for (var ni = 0; ni < nbrs.length; ni++) {
        if (!visited[nbrs[ni]]) stack.push(nbrs[ni]);
      }
    }
    segments.push(comp.sort(function (a, b) { return a - b; }));
  }
  return segments;
}

function buildCellSideMap(graph, floor) {
  var map = {};
  for (var key in graph.nodes) {
    if (!graph.nodes.hasOwnProperty(key)) continue;
    var n = graph.nodes[key];
    if (n.floor === floor && n.side === 'near') {
      map[n.cellId] = n.ringSide;
    }
  }
  return map;
}

describe('TowerGraph — segment size sanity', function () {
  var sizes = ['small', 'medium', 'large'];
  var exitSides = ['row-start', 'row-end', 'col-low', 'col-high'];

  // Length-1 segments are acceptable: they represent a single-cell strip
  // that got isolated between a corner and an exit. The solver handles
  // these as 1K apartments or orphans depending on far-side access.
  //
  // What is NOT acceptable is a segment that secretly contains cells from
  // two different ring sides (that is a cross-side edge, tested below).

  for (var si = 0; si < sizes.length; si++) {
    for (var ei = 0; ei < exitSides.length; ei++) {
      (function (size, exitSide) {
        it(size + ' tower, exit=' + exitSide + ': total cells in segments = K', function () {
          var dims = getTowerDimensions(size, 3.3);
          var ring = walkRing(dims.rows, dims.cols, exitSide);
          var polys = generateLocalPolygons(dims.rows, dims.cols, 3.3);
          var graph = buildTowerGraph(ring.pairs, polys, dims.cols, 2);
          var segs = extractNearSegments(graph, 1);

          var total = 0;
          for (var i = 0; i < segs.length; i++) total += segs[i].length;
          assert.equal(total, ring.pairs.length,
            size + ' ' + exitSide + ': segment cells should sum to K=' + ring.pairs.length);
        });
      }(sizes[si], exitSides[ei]));
    }
  }
});

describe('TowerGraph — no cross-side horizontal edges (L-shape prevention)', function () {
  var sizes = ['small', 'medium', 'large'];
  var exitSides = ['row-start', 'row-end', 'col-low', 'col-high'];

  for (var si = 0; si < sizes.length; si++) {
    for (var ei = 0; ei < exitSides.length; ei++) {
      (function (size, exitSide) {
        it(size + ' tower, exit=' + exitSide + ': no horizontal edge spans different ring sides', function () {
          var dims = getTowerDimensions(size, 3.3);
          var ring = walkRing(dims.rows, dims.cols, exitSide);
          var polys = generateLocalPolygons(dims.rows, dims.cols, 3.3);
          var graph = buildTowerGraph(ring.pairs, polys, dims.cols, 2);

          var cellSide = buildCellSideMap(graph, 1);

          var violations = [];
          for (var e = 0; e < graph.edges.length; e++) {
            var edge = graph.edges[e];
            if (edge.type !== 'horizontal') continue;
            var fp = edge.from.split(':');
            var tp = edge.to.split(':');
            if (parseInt(fp[1], 10) !== 1) continue;
            var fcid = parseInt(fp[0], 10);
            var tcid = parseInt(tp[0], 10);
            var fs = cellSide[fcid];
            var ts = cellSide[tcid];
            if (fs && ts && fs !== ts) {
              violations.push({ from: fcid, to: tcid, fromSide: fs, toSide: ts });
            }
          }

          if (violations.length > 0) {
            var msg = size + ' ' + exitSide + ': ' + violations.length
              + ' cross-side edges (creates L-shape via corner):\n';
            for (var i = 0; i < Math.min(violations.length, 5); i++) {
              var v = violations[i];
              msg += '  cell ' + v.from + ' (' + v.fromSide + ') <-> ' + v.to + ' (' + v.toSide + ')\n';
            }
            assert.fail(msg);
          }
        });
      }(sizes[si], exitSides[ei]));
    }
  }
});
