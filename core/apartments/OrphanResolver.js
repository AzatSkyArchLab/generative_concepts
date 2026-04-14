/**
 * OrphanResolver — resolve orphan apartments and redistribute cells.
 *
 * Three strategies:
 *   resolveOrphans — absorb orphans into adjacent valid neighbors
 *   globalRegroup  — dissolve invalid apartments, redistribute cells
 *   globalDownsize — transfer boundary cells from larger to smaller
 */

import { validateApartment, getFlag } from './Validation.js';
import { numericCells, livingCells } from './ApartmentTypes.js';

export function globalRegroup(allApartments, insolMap) {
  var regroupChanged = true;
  while (regroupChanged) {
    regroupChanged = false;
    for (var ai = allApartments.length - 1; ai >= 0; ai--) {
      var apt = allApartments[ai];
      if (apt.valid !== false || apt.type === 'orphan') continue;

      var freedCells = numericCells(apt);
      allApartments.splice(ai, 1);

      var cellToApt2 = {};
      for (var bi = 0; bi < allApartments.length; bi++) {
        var bCells = allApartments[bi].cells || [];
        for (var ci = 0; ci < bCells.length; ci++) {
          if (typeof bCells[ci] === 'number') cellToApt2[bCells[ci]] = bi;
        }
      }

      for (var fi = 0; fi < freedCells.length; fi++) {
        var fc = freedCells[fi];
        var absorbed = false;

        // Try absorb as living into adjacent apartment
        for (var delta = -1; delta <= 1; delta += 2) {
          var nb = fc + delta;
          if (cellToApt2[nb] === undefined) continue;
          var bi = cellToApt2[nb];
          var target = allApartments[bi];
          var tCells = target.cells || [];
          var oldWet = target.wetCell;

          var newLiving = [];
          for (var ci = 0; ci < tCells.length; ci++) {
            if (tCells[ci] !== oldWet && typeof tCells[ci] === 'number')
              newLiving.push(tCells[ci]);
          }
          newLiving.push(fc);
          var flags = [];
          for (var k = 0; k < newLiving.length; k++) flags.push(getFlag(insolMap, newLiving[k]));
          var nv = validateApartment(flags);
          if (nv.valid) {
            target.cells.push(fc);
            target.type = nv.type;
            target.valid = true;
            cellToApt2[fc] = bi;
            absorbed = true;
            break;
          }
        }

        if (!absorbed) {
          // Try as WZ: fc becomes wet, free up old wet as living
          for (var delta = -1; delta <= 1; delta += 2) {
            var nb = fc + delta;
            if (cellToApt2[nb] === undefined) continue;
            var bi = cellToApt2[nb];
            var target = allApartments[bi];
            var tCells = target.cells || [];

            var allLiving = [];
            for (var ci = 0; ci < tCells.length; ci++) {
              if (typeof tCells[ci] === 'number') allLiving.push(tCells[ci]);
            }
            var flags = [];
            for (var k = 0; k < allLiving.length; k++) flags.push(getFlag(insolMap, allLiving[k]));
            var nv = validateApartment(flags);
            if (nv.valid) {
              target.cells.push(fc);
              target.wetCell = fc;
              target.type = nv.type;
              target.valid = true;
              cellToApt2[fc] = bi;
              absorbed = true;
              break;
            }
          }
        }

        if (!absorbed) {
          allApartments.push({ cells: [fc], wetCell: fc, type: 'orphan', valid: false, torec: false });
        }
      }
      regroupChanged = true;
      break;
    }
  }
  return allApartments;
}

// ============================================================
// GLOBAL DOWNSIZE (extracted from solveWithSection Step 3c)
// ============================================================

/**
 * Transfer 1 boundary living cell from larger to smaller neighbor.
 * Operates on cell IDs (cross-segment, including torecs).
 * After transfer, reassign WZ in donor to worst-insol cell.
 *
 * Gap >= 2 prevents ping-pong. Capped at MAX_ITER iterations.
 *
 * @param {Array<Object>} allApartments - mutated in place
 * @param {Object} insolMap
 */
export function globalDownsize(allApartments, insolMap) {
  var FLAG_GD = { 'f': 0, 'w': 1, 'p': 2 };
  var gdChanged = true;
  var gdMaxIter = 30;
  while (gdChanged && gdMaxIter > 0) {
    gdChanged = false;
    gdMaxIter--;

    var gdCellToApt = {};
    for (var ai = 0; ai < allApartments.length; ai++) {
      var cs = allApartments[ai].cells || [];
      for (var ci = 0; ci < cs.length; ci++) {
        if (typeof cs[ci] === 'number') gdCellToApt[cs[ci]] = ai;
      }
    }

    // Helper: get living cell IDs for an apartment
    var gdLiving = livingCells;

    var gdOrder = [];
    for (var ai = 0; ai < allApartments.length; ai++) {
      var apt = allApartments[ai];
      if (!apt.valid || apt.type === 'orphan') continue;
      var lc = gdLiving(apt).length;
      if (lc >= 2) gdOrder.push({ idx: ai, lc: lc });
    }
    gdOrder.sort(function (a, b) { return b.lc - a.lc; });

    for (var di = 0; di < gdOrder.length; di++) {
      var donorIdx = gdOrder[di].idx;
      var donor = allApartments[donorIdx];
      var donorLiv = gdLiving(donor);
      if (donorLiv.length < 2) continue;

      var found = false;

      for (var li = donorLiv.length - 1; li >= 0; li--) {
        var dCid = donorLiv[li];

        for (var delta = -1; delta <= 1; delta += 2) {
          var nbCid = dCid + delta;
          if (gdCellToApt[nbCid] === undefined) continue;
          var recvIdx = gdCellToApt[nbCid];
          if (recvIdx === donorIdx) continue;
          var recv = allApartments[recvIdx];
          if (!recv.valid || recv.type === 'orphan') continue;
          var recvLiv = gdLiving(recv);

          if (recvLiv.length >= donorLiv.length - 1) continue;

          var newRecvLiv = recvLiv.slice();
          newRecvLiv.push(dCid);
          var rfFlags = [];
          for (var k = 0; k < newRecvLiv.length; k++) rfFlags.push(getFlag(insolMap, newRecvLiv[k]));
          var rv = validateApartment(rfFlags);
          if (!rv.valid) continue;

          var newDonorCells = [];
          var donorCs = donor.cells || [];
          for (var k = 0; k < donorCs.length; k++) {
            if (typeof donorCs[k] === 'number' && donorCs[k] !== dCid) newDonorCells.push(donorCs[k]);
          }
          if (newDonorCells.length < 2) continue;

          var bestWZ = -1;
          var bestWZScore = 99;
          var bestDType = null;
          for (var wi = 0; wi < newDonorCells.length; wi++) {
            var tryWZ = newDonorCells[wi];
            var tryLiv = [];
            for (var k = 0; k < newDonorCells.length; k++) {
              if (k !== wi) tryLiv.push(newDonorCells[k]);
            }
            var dfFlags = [];
            for (var k = 0; k < tryLiv.length; k++) dfFlags.push(getFlag(insolMap, tryLiv[k]));
            var dv = validateApartment(dfFlags);
            if (dv.valid) {
              var wzScore = FLAG_GD[getFlag(insolMap, tryWZ)] || 0;
              if (bestWZ < 0 || wzScore < bestWZScore) {
                bestWZScore = wzScore;
                bestWZ = tryWZ;
                bestDType = dv.type;
              }
            }
          }
          if (bestWZ < 0) continue;

          // Execute transfer
          var finalDCells = [];
          for (var k = 0; k < donorCs.length; k++) {
            if (donorCs[k] === dCid) continue;
            if (typeof donorCs[k] === 'string') {
              var parts = donorCs[k].split('-');
              if (parseInt(parts[0]) === dCid || parseInt(parts[1]) === dCid) continue;
            }
            finalDCells.push(donorCs[k]);
          }
          donor.cells = finalDCells;
          donor.wetCell = bestWZ;
          donor.type = bestDType;
          donor.valid = true;
          if (donor.livingCells) {
            var nl = [];
            for (var k = 0; k < finalDCells.length; k++) {
              if (typeof finalDCells[k] === 'number' && finalDCells[k] !== bestWZ) nl.push(finalDCells[k]);
            }
            donor.livingCells = nl;
          }

          recv.cells.push(dCid);
          recv.type = rv.type;
          recv.valid = true;
          if (recv.livingCells) {
            recv.livingCells.push(dCid);
          }

          gdChanged = true;
          found = true;
          break;
        }
        if (found) break;
      }
      if (found) break;
    }
  }
}

// ============================================================
// ORPHAN RESOLUTION (reusable)
// ============================================================

/**
 * Absorb orphan apartments into adjacent valid neighbors.
 *
 * For each orphan, check cellId ± 1 for a neighbor apartment.
 * If adding the orphan cell as living keeps insolation valid → absorb.
 * If orphan has 'f' flag, try making it wet instead (free up old wet).
 *
 * Marks absorbed orphans as '_absorbed' (caller must filter).
 *
 * @param {Array<Object>} allApartments - mutated in place
 * @param {Object} insolMap
 * @returns {number} count of resolved orphans
 */
export function resolveOrphans(allApartments, insolMap) {
  var resolved = 0;
  var changed = true;
  while (changed) {
    changed = false;
    var cellToApt = {};
    for (var ai = 0; ai < allApartments.length; ai++) {
      var cs3 = allApartments[ai].cells || [];
      for (var ci = 0; ci < cs3.length; ci++) {
        if (typeof cs3[ci] === 'number') cellToApt[cs3[ci]] = ai;
      }
    }
    for (var ai = 0; ai < allApartments.length; ai++) {
      var apt = allApartments[ai];
      if (apt.type !== 'orphan') continue;
      var orphanCid = apt.cells[0];
      var absorbed = false;

      for (var delta = -1; delta <= 1; delta += 2) {
        var nbCid = orphanCid + delta;
        if (cellToApt[nbCid] === undefined || cellToApt[nbCid] === ai) continue;
        var bi = cellToApt[nbCid];
        var target = allApartments[bi];
        var targetCells = target.cells || [];

        var oldWet = target.wetCell;

        // Option A: orphan becomes living cell
        var newLiving = [];
        for (var ci = 0; ci < targetCells.length; ci++) {
          if (targetCells[ci] !== oldWet && typeof targetCells[ci] === 'number')
            newLiving.push(targetCells[ci]);
        }
        newLiving.push(orphanCid);

        var flags = [];
        for (var fi = 0; fi < newLiving.length; fi++) flags.push(getFlag(insolMap, newLiving[fi]));
        var nv = validateApartment(flags);

        if (nv.valid) {
          target.cells.push(orphanCid);
          target.type = nv.type;
          target.valid = true;

          // If orphan is 'f', try making it wet instead (free up old wet as living)
          var orphanFlag = getFlag(insolMap, orphanCid);
          if (orphanFlag === 'f' && oldWet !== undefined && oldWet !== null) {
            var testLiving = [];
            for (var ci = 0; ci < target.cells.length; ci++) {
              if (target.cells[ci] !== orphanCid && typeof target.cells[ci] === 'number')
                testLiving.push(target.cells[ci]);
            }
            var tf = [];
            for (var fi = 0; fi < testLiving.length; fi++) tf.push(getFlag(insolMap, testLiving[fi]));
            var tv = validateApartment(tf);
            if (tv.valid) {
              target.wetCell = orphanCid;
              target.type = tv.type;
            }
          }

          apt.type = '_absorbed';
          resolved++;
          changed = true;
          absorbed = true;
          break;
        }
      }
    }
  }
  return resolved;
}

