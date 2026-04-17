/**
 * TowerGraph — map tower grid cells to a section-compatible linear graph.
 *
 * Core idea: the 2-deep perimeter of a tower is topologically equivalent
 * to a section's near/far rows. "Unroll" the ring into:
 *   near[0..K-1] = outer perimeter cells (face outside → insolation)
 *   far[K..2K-1] = inner perimeter cells (face LLU core → WZ candidates)
 *   corridor[i]  = connects near[i] to far[mirror(i)] through LLU core
 *
 * The LLU exit breaks the ring (like LLU splits near segments in sections).
 * Ring walk: CW starting right of exit → one or two near segments.
 *
 * Output format is identical to section-gen/graph.js → directly feeds
 * into ApartmentSolver.solveFloor().
 *
 * Pure math — no rendering, no Three.js.
 */

import { PERIMETER_DEPTH } from './TowerGenerator.js';
import { nearToFar } from '../apartments/CellTopology.js';

// ── Ring Walk ────────────────────────────────────────

/**
 * Walk the perimeter ring of a tower grid CW.
 * Returns array of pair positions: [{outerRow, outerCol, innerRow, innerCol, side}]
 *
 * Ring segments:
 *   TOP:    outer=row 0, inner=row 1,              cols left→right
 *   RIGHT:  outer=col (cols-1), inner=col (cols-2), rows top→bottom (excl corners)
 *   BOTTOM: outer=row (rows-1), inner=row (rows-2), cols right→left
 *   LEFT:   outer=col 0, inner=col 1,              rows bottom→top (excl corners)
 *
 * Corners (2×2) are assigned to TOP/BOTTOM sides (full col span).
 * Exit cells become a break in the ring.
 *
 * @param {number} rows
 * @param {number} cols
 * @param {string} exitSide - 'row-start'|'row-end'|'col-low'|'col-high'
 * @returns {{ pairs: Array, exitBreakIdx: number }}
 */
export function walkRing(rows, cols, exitSide) {
  var PD = PERIMETER_DEPTH; // 2
  var exitCol = Math.floor(cols / 2);
  var exitRow = Math.floor(rows / 2);

  var allPairs = [];

  // Determine exit position for break detection
  var exitR = -1, exitC = -1;
  if (exitSide === 'row-start') { exitR = 0; exitC = exitCol; }
  else if (exitSide === 'row-end') { exitR = rows - 1; exitC = exitCol; }
  else if (exitSide === 'col-low') { exitR = exitRow; exitC = 0; }
  else if (exitSide === 'col-high') { exitR = exitRow; exitC = cols - 1; }

  // TOP side: row 0 outer, row 1 inner, cols 0..cols-1
  for (var c = 0; c < cols; c++) {
    allPairs.push({ outerRow: 0, outerCol: c, innerRow: 1, innerCol: c, side: 'top' });
  }

  // RIGHT side: col (cols-1) outer, col (cols-2) inner, rows PD..rows-PD-1
  for (var r = PD; r < rows - PD; r++) {
    allPairs.push({ outerRow: r, outerCol: cols - 1, innerRow: r, innerCol: cols - 2, side: 'right' });
  }

  // BOTTOM side: row (rows-1) outer, row (rows-2) inner, cols (cols-1)..0 (reversed)
  for (var c = cols - 1; c >= 0; c--) {
    allPairs.push({ outerRow: rows - 1, outerCol: c, innerRow: rows - 2, innerCol: c, side: 'bottom' });
  }

  // LEFT side: col 0 outer, col 1 inner, rows (rows-PD-1)..PD (reversed)
  for (var r = rows - PD - 1; r >= PD; r--) {
    allPairs.push({ outerRow: r, outerCol: 0, innerRow: r, innerCol: 1, side: 'left' });
  }

  // Find exit break index — where the exit cell sits on the ring
  var breakIdx = -1;
  for (var i = 0; i < allPairs.length; i++) {
    var p = allPairs[i];
    if (p.outerRow === exitR && p.outerCol === exitC) {
      breakIdx = i;
      break;
    }
  }

  // Rotate ring so break is at the end (pairs start AFTER break)
  var rotated = [];
  if (breakIdx >= 0) {
    for (var i = breakIdx + 1; i < allPairs.length; i++) rotated.push(allPairs[i]);
    for (var i = 0; i < breakIdx; i++) rotated.push(allPairs[i]);
  } else {
    rotated = allPairs;
  }

  return { pairs: rotated, exitBreakIdx: breakIdx };
}

// ── Graph Builder ────────────────────────────────────

/**
 * Build a section-compatible graph from tower ring pairs.
 *
 * KEY DESIGN:
 * - Each ring position = one solver cell (outer+inner pair)
 * - Inner row = LLU (solver only distributes apartments on outer ring)
 * - Side transitions (corners) create cellId GAPS → segment breaks
 *   This prevents L-shaped apartments spanning corners
 * - No corridors — LLU core provides access directly
 *
 * @param {Array} pairs - from walkRing (with .side property)
 * @param {Array<Array<[number,number]>>} cellPolygons - all grid cell polygons
 * @param {number} cols - grid columns
 * @param {number} floorCount - floors to generate
 * @returns {{ nodes, edges, K, N, ringPairs, posToCellId }}
 */
export function buildTowerGraph(pairs, cellPolygons, cols, floorCount) {
  var K = pairs.length;
  var nodes = {};
  var edges = [];

  // Assign cellIds with gaps at side transitions (corner breaks)
  // But SKIP break if it would create a segment ≤1 position
  var sideRuns = [];  // [{startIdx, endIdx, side}]
  var runStart = 0;
  for (var i = 1; i <= K; i++) {
    if (i === K || pairs[i].side !== pairs[i - 1].side) {
      sideRuns.push({ start: runStart, end: i - 1, side: pairs[runStart].side });
      runStart = i;
    }
  }

  // Decide which transitions to break.
  //
  // Side transitions (corners) must ALWAYS produce a break — otherwise
  // cells on different sides of the ring get connected by a horizontal
  // edge and the solver may build L-shape apartments that span a corner.
  //
  // Earlier versions skipped breaks when either neighbor was length 1,
  // trying to avoid degenerate single-cell segments. But that trades a
  // topology violation for a size issue: a length-1 segment is fine —
  // the solver will resolve it as a 1K apartment or via corridor access.
  // A cross-side edge is a physical lie about cell adjacency.
  //
  // Special case: when an exit splits one side into two runs on opposite
  // ends of the rotated ring (e.g. col-low on a small tower splits `left`
  // into `left(1)` at start and `left(1)` at end), both runs are still
  // on the same physical side but separated by the exit — they already
  // do not touch, so no edge is generated across them regardless.
  var breakBefore = {};  // position index → true if break before it
  for (var si = 1; si < sideRuns.length; si++) {
    var curRun = sideRuns[si];
    breakBefore[curRun.start] = true;
  }

  var posToCellId = [];
  var nextCid = 0;
  for (var i = 0; i < K; i++) {
    if (breakBefore[i]) nextCid++; // gap
    posToCellId.push(nextCid);
    nextCid++;
  }
  var N = nextCid;

  for (var floor = 0; floor < floorCount; floor++) {
    var isFirst = (floor === 0);

    for (var i = 0; i < K; i++) {
      var p = pairs[i];
      var outerGridId = p.outerRow * cols + p.outerCol;
      var innerGridId = p.innerRow * cols + p.innerCol;
      var cid = posToCellId[i];

      // Near cell = ring position → apartment on floor 1
      nodes[cid + ':' + floor] = {
        cellId: cid,
        floor: floor,
        type: isFirst ? 'commercial' : 'apartment',
        side: 'near',
        polygon: cellPolygons[outerGridId] || null,
        gridId: outerGridId,
        ringPos: i,
        ringSide: p.side,
        label: cid + '.' + floor
      };

      // Far cell = inner → always LLU
      var farCid = nearToFar(cid, N);
      nodes[farCid + ':' + floor] = {
        cellId: farCid,
        floor: floor,
        type: 'llu',
        side: 'far',
        polygon: cellPolygons[innerGridId] || null,
        gridId: innerGridId,
        ringPos: i,
        ringSide: p.side,
        lluTag: 'core',
        label: farCid + '.' + floor
      };
    }

    // Horizontal near edges — break only at decided corners
    for (var i = 0; i < K - 1; i++) {
      if (!breakBefore[i + 1]) {
        var cidA = posToCellId[i];
        var cidB = posToCellId[i + 1];
        edges.push({ from: cidA + ':' + floor, to: cidB + ':' + floor, type: 'horizontal' });
      }
    }
  }

  // Vertical edges
  for (var floor = 0; floor < floorCount - 1; floor++) {
    for (var key in nodes) {
      if (!nodes.hasOwnProperty(key)) continue;
      if (nodes[key].floor !== floor) continue;
      var upper = nodes[key].cellId + ':' + (floor + 1);
      if (nodes[upper]) edges.push({ from: key, to: upper, type: 'vertical' });
    }
  }

  return { nodes: nodes, edges: edges, K: K, N: N, ringPairs: pairs, posToCellId: posToCellId };
}

/**
 * Determine outward-facing direction for each outer cell on the ring.
 * Used for insolation facade point placement.
 *
 * @param {Array} pairs - from walkRing
 * @returns {Object} { [nearCid]: { nx, ny } } outward normal direction
 */
export function computeRingNormals(pairs, cellPolygons, cols) {
  var normals = {};
  for (var i = 0; i < pairs.length; i++) {
    var p = pairs[i];
    var outerGridId = p.outerRow * cols + p.outerCol;
    var innerGridId = p.innerRow * cols + p.innerCol;

    var outerPoly = cellPolygons[outerGridId];
    var innerPoly = cellPolygons[innerGridId];
    if (!outerPoly || !innerPoly) continue;

    // Outward = outer center - inner center
    var ocx = 0, ocy = 0, icx = 0, icy = 0;
    for (var v = 0; v < 4; v++) {
      ocx += outerPoly[v][0]; ocy += outerPoly[v][1];
      icx += innerPoly[v][0]; icy += innerPoly[v][1];
    }
    ocx /= 4; ocy /= 4; icx /= 4; icy /= 4;
    var dx = ocx - icx;
    var dy = ocy - icy;
    var len = Math.sqrt(dx * dx + dy * dy);
    if (len > 1e-10) {
      normals[i] = { nx: dx / len, ny: dy / len };
    }
  }
  return normals;
}
