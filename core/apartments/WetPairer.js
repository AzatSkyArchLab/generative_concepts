/**
 * WetPairer — global wet zone pairing and quality report.
 *
 * Pairs adjacent apartments' wet cells to share plumbing stacks.
 * Frozen-pair protection prevents breaking existing pairs.
 * Torec apartments are skipped.
 */

import { validateApartment, getFlag } from './Validation.js';

export function globalWetPairing(allApartments, insolMap) {
  if (allApartments.length < 2) return 0;
  var totalMoves = 0;

  for (var iteration = 0; iteration < 5; iteration++) {
    var currentWets = {};
    for (var ai = 0; ai < allApartments.length; ai++) {
      var wc = allApartments[ai].wetCell;
      if (wc !== undefined && typeof wc === 'number') currentWets[wc] = true;
    }

    var frozen = {};
    for (var wc in currentWets) {
      var w = parseInt(wc);
      if (currentWets[w + 1] || currentWets[w - 1]) frozen[w] = true;
    }

    var cellToApt = {};
    for (var ai = 0; ai < allApartments.length; ai++) {
      var cells = allApartments[ai].cells || [];
      for (var ci = 0; ci < cells.length; ci++) {
        if (typeof cells[ci] === 'number') cellToApt[cells[ci]] = ai;
      }
    }

    var movesThisPass = 0;
    var visited = {};

    for (var ai = 0; ai < allApartments.length; ai++) {
      var aptA = allApartments[ai];
      if (!aptA.cells || aptA.cells.length < 2) continue;
      if (aptA.torec) continue;
      if (frozen[aptA.wetCell]) continue;

      for (var ci = 0; ci < aptA.cells.length; ci++) {
        var cidA = aptA.cells[ci];
        if (typeof cidA !== 'number') continue;
        for (var delta = -1; delta <= 1; delta += 2) {
          var nb = cidA + delta;
          if (cellToApt[nb] === undefined || cellToApt[nb] === ai) continue;
          var bi = cellToApt[nb];
          var pairKey = Math.min(ai, bi) + ':' + Math.max(ai, bi);
          if (visited[pairKey]) continue;
          visited[pairKey] = true;

          var aptB = allApartments[bi];
          if (!aptB.cells || aptB.cells.length < 2) continue;
          if (aptB.torec) continue;
          if (frozen[aptB.wetCell]) continue;

          // Already paired?
          if (aptA.wetCell !== undefined && aptB.wetCell !== undefined) {
            if (Math.abs(aptA.wetCell - aptB.wetCell) === 1) continue;
          }

          // Find boundary pairs
          var setB = {};
          for (var bi2 = 0; bi2 < aptB.cells.length; bi2++) {
            if (typeof aptB.cells[bi2] === 'number') setB[aptB.cells[bi2]] = true;
          }
          var boundary = [];
          for (var ai2 = 0; ai2 < aptA.cells.length; ai2++) {
            var ca = aptA.cells[ai2];
            if (typeof ca !== 'number') continue;
            if (setB[ca + 1]) boundary.push([ca, ca + 1]);
            if (setB[ca - 1]) boundary.push([ca, ca - 1]);
          }

          var paired = false;
          for (var bdi = 0; bdi < boundary.length; bdi++) {
            if (tryPairWets(aptA, boundary[bdi][0], aptB, boundary[bdi][1], insolMap)) {
              movesThisPass++;
              frozen[boundary[bdi][0]] = true;
              frozen[boundary[bdi][1]] = true;
              paired = true; break;
            }
          }
          if (paired) break;
        }
      }
    }
    totalMoves += movesThisPass;
    if (movesThisPass === 0) break;
  }
  return totalMoves;
}

function tryPairWets(aptA, newWetA, aptB, newWetB, insolMap) {
  if (!aptA.cells || !aptB.cells) return false;
  if (aptA.cells.indexOf(newWetA) < 0 || aptB.cells.indexOf(newWetB) < 0) return false;

  var livingA = [];
  for (var i = 0; i < aptA.cells.length; i++) { if (aptA.cells[i] !== newWetA) livingA.push(aptA.cells[i]); }
  if (livingA.length === 0) return false;
  var flagsA = [];
  for (var i = 0; i < livingA.length; i++) { if (typeof livingA[i] === 'number') flagsA.push(getFlag(insolMap, livingA[i])); }
  var vA = validateApartment(flagsA);
  if (!vA.valid) return false;

  var livingB = [];
  for (var i = 0; i < aptB.cells.length; i++) { if (aptB.cells[i] !== newWetB) livingB.push(aptB.cells[i]); }
  if (livingB.length === 0) return false;
  var flagsB = [];
  for (var i = 0; i < livingB.length; i++) { if (typeof livingB[i] === 'number') flagsB.push(getFlag(insolMap, livingB[i])); }
  var vB = validateApartment(flagsB);
  if (!vB.valid) return false;

  aptA.wetCell = newWetA; aptA.type = vA.type; aptA.valid = true;
  aptB.wetCell = newWetB; aptB.type = vB.type; aptB.valid = true;
  return true;
}

// ============================================================
// WET QUALITY REPORT
// ============================================================

export function wetQualityReport(allApartments) {
  var wets = [];
  for (var ai = 0; ai < allApartments.length; ai++) {
    var wc = allApartments[ai].wetCell;
    if (wc !== undefined && typeof wc === 'number') wets.push(wc);
  }
  wets.sort(function (a, b) { return a - b; });

  var wetSet = {};
  for (var i = 0; i < wets.length; i++) wetSet[wets[i]] = true;

  var pairs = [];
  var inPair = {};
  for (var i = 0; i < wets.length - 1; i++) {
    if (wets[i + 1] - wets[i] === 1) {
      pairs.push([wets[i], wets[i + 1]]);
      inPair[wets[i]] = true;
      inPair[wets[i + 1]] = true;
    }
  }

  var unpaired = [];
  for (var i = 0; i < wets.length; i++) { if (!inPair[wets[i]]) unpaired.push(wets[i]); }

  var pairedCount = Object.keys(inPair).length;
  var total = wets.length;

  return {
    wetCells: wets, totalWets: total,
    pairedCount: pairedCount, unpaired: unpaired,
    pairRatio: total > 0 ? pairedCount / total : 0,
    pairs: pairs
  };
}

