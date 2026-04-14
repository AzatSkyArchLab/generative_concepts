/**
 * ApartmentSplitter — split apartments larger than 4K.
 *
 * After greedy solve + orphan resolution, some apartments
 * may have 5+ living cells. This splits them into valid
 * sub-apartments.
 */

import { validateApartment, getFlag } from './Validation.js';

export function splitLargeApartments(allApartments, insolMap) {
  var result = [];
  for (var ai = 0; ai < allApartments.length; ai++) {
    var apt = allApartments[ai];
    var ac = apt.cells || [];
    if (ac.length <= 5 || apt.torec) { result.push(apt); continue; }

    var pair = trySplitCells(ac, insolMap);
    if (pair) { result.push(pair[0]); result.push(pair[1]); }
    else { result.push(apt); }
  }
  return result;
}

function trySplitCells(ac, insolMap) {
  var n = ac.length;
  for (var k = 2; k <= n - 2; k++) {
    var leftCells = ac.slice(0, k);
    var rightCells = ac.slice(k);
    var combos = [[k - 1, 0], [0, 0], [k - 1, rightCells.length - 1], [0, rightCells.length - 1]];
    for (var ci = 0; ci < combos.length; ci++) {
      var lwi = combos[ci][0], rwi = combos[ci][1];

      var leftLiving = [];
      for (var i = 0; i < leftCells.length; i++) { if (i !== lwi) leftLiving.push(leftCells[i]); }
      var leftFlags = [];
      for (var i = 0; i < leftLiving.length; i++) leftFlags.push(getFlag(insolMap, leftLiving[i]));
      var lv = validateApartment(leftFlags);
      if (!lv.valid) continue;

      var rightLiving = [];
      for (var i = 0; i < rightCells.length; i++) { if (i !== rwi) rightLiving.push(rightCells[i]); }
      var rightFlags = [];
      for (var i = 0; i < rightLiving.length; i++) rightFlags.push(getFlag(insolMap, rightLiving[i]));
      var rv = validateApartment(rightFlags);
      if (!rv.valid) continue;

      return [
        { cells: leftCells.slice(), wetCell: leftCells[lwi], type: lv.type, valid: true },
        { cells: rightCells.slice(), wetCell: rightCells[rwi], type: rv.type, valid: true }
      ];
    }
  }
  return null;
}
