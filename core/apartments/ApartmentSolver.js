/**
 * ApartmentSolver — upper-level apartment layout for insolation assessment
 *
 * Places 1K (1-room) apartments on the first residential floor (floor 1).
 * Each apartment occupies 1 cell on near or far side.
 * Evaluates whether each apartment meets GOST insolation requirements.
 *
 * Portable: depends only on InsolationCalc, no framework deps.
 *
 * Terminology:
 * - Floor 0 = commercial (not residential)
 * - Floor 1 = first residential floor
 * - Near/far cells = apartment cells on either side of corridor
 * - LLU cells = staircase/elevator, not apartments
 * - 1K apartment needs 1 room with normative insolation
 */

import { evaluateInsolation } from '../insolation/InsolationCalc.js';

/**
 * @typedef {Object} ApartmentCell
 * @property {number} cellId
 * @property {string} side - 'near' | 'far'
 * @property {Array<[number,number]>} polygon - 2D footprint corners [x,y]
 * @property {boolean} isLLU
 * @property {string|null} lluTag
 */

/**
 * @typedef {Object} Apartment
 * @property {number} id
 * @property {string} type - '1K'
 * @property {number} cellId
 * @property {string} side - 'near' | 'far'
 * @property {[number,number,number]} insolationPoint - facade midpoint, offset outward
 * @property {Object|null} insolation - evaluation result from InsolationCalc
 */

/**
 * Extract apartment-eligible cells from section graph nodes.
 * Floor 1, side near/far, type apartment (not LLU, not corridor).
 *
 * @param {Object} graphNodes - { (cellId,floor): node } from section-gen
 * @param {number} [targetFloor=1] - which floor to analyze
 * @returns {Array<ApartmentCell>}
 */
export function extractApartmentCells(graphNodes, targetFloor) {
  if (targetFloor === undefined) targetFloor = 1;

  var cells = [];

  for (var key in graphNodes) {
    if (!graphNodes.hasOwnProperty(key)) continue;
    var node = graphNodes[key];

    if (node.floor !== targetFloor) continue;
    if (node.type === 'corridor') continue;
    if (node.side !== 'near' && node.side !== 'far') continue;

    cells.push({
      cellId: node.cellId,
      side: node.side,
      polygon: node.polygon,
      isLLU: node.type === 'llu',
      lluTag: node.lluTag || null,
      type: node.type
    });
  }

  return cells;
}

/**
 * Compute insolation check point for a cell.
 * Center of external facade edge, offset 0.01m outward, at mid-height.
 *
 * @param {Array<[number,number]>} polygon - [a, b, c, d] in meters
 * @param {string} side - 'near' | 'far'
 * @param {number} zOffset - floor z offset
 * @param {number} cellHeight - height of cell
 * @param {number} [outwardOffset=0.01]
 * @returns {[number,number,number]} xyz point
 */
export function computeInsolationPoint(polygon, side, zOffset, cellHeight, outwardOffset) {
  if (outwardOffset === undefined) outwardOffset = 0.01;

  // polygon: a(0), b(1), c(2), d(3)
  // near side: external edge = a→b (polygon[0] → polygon[1])
  // far side: external edge = c→d (polygon[2] → polygon[3])
  var p1, p2;
  if (side === 'near') {
    p1 = polygon[0];
    p2 = polygon[1];
  } else {
    p1 = polygon[2];
    p2 = polygon[3];
  }

  // Edge midpoint
  var mx = (p1[0] + p2[0]) / 2;
  var my = (p1[1] + p2[1]) / 2;
  var mz = zOffset + cellHeight / 2;

  // Outward normal (perpendicular to edge, pointing away from center of polygon)
  var dx = p2[0] - p1[0];
  var dy = p2[1] - p1[1];
  var len = Math.sqrt(dx * dx + dy * dy);
  if (len < 1e-10) return [mx, my, mz];

  // Candidate normal
  var nx = -dy / len;
  var ny = dx / len;

  // Check direction: should point away from polygon centroid
  var cx = (polygon[0][0] + polygon[1][0] + polygon[2][0] + polygon[3][0]) / 4;
  var cy = (polygon[0][1] + polygon[1][1] + polygon[2][1] + polygon[3][1]) / 4;
  var toCenterX = cx - mx;
  var toCenterY = cy - my;

  if (nx * toCenterX + ny * toCenterY > 0) {
    // Normal points toward center — flip
    nx = -nx;
    ny = -ny;
  }

  return [mx + nx * outwardOffset, my + ny * outwardOffset, mz];
}

/**
 * Place 1K apartments on apartment cells and compute insolation points.
 *
 * @param {Array<ApartmentCell>} cells
 * @param {number} firstFloorHeight
 * @param {number} typicalFloorHeight
 * @param {number} [targetFloor=1]
 * @returns {Array<Apartment>}
 */
export function place1KApartments(cells, firstFloorHeight, typicalFloorHeight, targetFloor) {
  if (targetFloor === undefined) targetFloor = 1;

  var zOffset = firstFloorHeight + (targetFloor - 1) * typicalFloorHeight;
  var cellHeight = typicalFloorHeight;

  var apartments = [];
  var aptId = 0;

  for (var i = 0; i < cells.length; i++) {
    var cell = cells[i];
    if (cell.isLLU) continue; // skip LLU cells
    if (cell.type !== 'apartment') continue;

    var point = computeInsolationPoint(
      cell.polygon, cell.side, zOffset, cellHeight
    );

    apartments.push({
      id: aptId,
      type: '1K',
      cellId: cell.cellId,
      side: cell.side,
      polygon: cell.polygon,
      insolationPoint: point,
      insolation: null
    });

    aptId++;
  }

  return apartments;
}

/**
 * Run insolation analysis for all apartments.
 *
 * @param {Array<Apartment>} apartments
 * @param {Array<[number,number,number]>} sunVectors
 * @param {Function} raycast - (origin, direction) => distance|null
 * @param {number} normativeMinutes
 * @param {number} [rayMinutes=10]
 * @returns {Object} summary
 */
export function analyzeApartments(apartments, sunVectors, raycast, normativeMinutes, rayMinutes) {
  if (!rayMinutes) rayMinutes = 10;

  var passCount = 0;
  var warnCount = 0;
  var failCount = 0;

  for (var i = 0; i < apartments.length; i++) {
    var apt = apartments[i];
    var point = apt.insolationPoint;

    // Cast all sun rays from this point
    var isFree = [];
    for (var j = 0; j < sunVectors.length; j++) {
      var dist = raycast(point, sunVectors[j]);
      var free = (dist === null || dist === undefined || dist < 0);
      isFree.push(free);
    }

    var eval_result = evaluateInsolation(isFree, normativeMinutes, rayMinutes);
    apt.insolation = eval_result;

    if (eval_result.status === 'PASS') passCount++;
    else if (eval_result.status === 'WARNING') warnCount++;
    else failCount++;
  }

  return {
    apartments: apartments,
    total: apartments.length,
    pass: passCount,
    warning: warnCount,
    fail: failCount,
    complianceRate: apartments.length > 0
      ? (passCount + warnCount) / apartments.length
      : 0
  };
}

/**
 * Full pipeline: extract cells → place 1K → analyze insolation.
 *
 * @param {Object} params
 * @param {Object} params.graphNodes - section graph nodes
 * @param {Array<[number,number,number]>} params.sunVectors
 * @param {Function} params.raycast - (origin, direction) => distance|null
 * @param {number} params.normativeMinutes
 * @param {number} params.firstFloorHeight
 * @param {number} params.typicalFloorHeight
 * @param {number} [params.targetFloor=1]
 * @param {number} [params.rayMinutes=10]
 * @returns {Object}
 */
export function solveApartmentInsolation(params) {
  var targetFloor = params.targetFloor || 1;
  var rayMinutes = params.rayMinutes || 10;

  // Step 1: extract eligible cells
  var cells = extractApartmentCells(params.graphNodes, targetFloor);

  // Step 2: place 1K apartments
  var apartments = place1KApartments(
    cells,
    params.firstFloorHeight,
    params.typicalFloorHeight,
    targetFloor
  );

  // Step 3: analyze insolation
  var result = analyzeApartments(
    apartments,
    params.sunVectors,
    params.raycast,
    params.normativeMinutes,
    rayMinutes
  );

  result.cells = cells;
  result.floor = targetFloor;

  return result;
}
