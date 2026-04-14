/**
 * ApartmentTypes — canonical shape definitions for apartment objects.
 *
 * Throughout the codebase, apartment objects are plain JS objects with
 * an implicit shape. This module formalizes that shape, provides a
 * factory function, and offers typed cell extraction helpers that
 * eliminate the need for repeated `typeof cid === 'number'` checks.
 *
 * @module ApartmentTypes
 */

// ── Type Definitions (JSDoc) ────────────────────────────

/**
 * @typedef {Object} Apartment
 * @property {Array<number|string>} cells - All cell IDs.
 *   Numbers are spatial cell IDs (near: 0..N-1, far: N..2N-1).
 *   Strings are corridor labels (e.g. '3-18').
 * @property {number|null} wetCell - Cell ID used as wet zone (kitchen/bathroom), or null.
 * @property {string} type - '1K' | '2K' | '3K' | '4K' | 'orphan'
 * @property {boolean} valid - Passes insolation validation.
 * @property {boolean} [torec] - True if this is a torec (end) apartment.
 * @property {string|null} [corridorLabel] - Corridor label if assigned.
 * @property {Array<number>} [livingCells] - Numeric cell IDs excluding wetCell.
 */

/**
 * @typedef {Object} ApartmentResult
 * @property {number} floor - Floor number.
 * @property {Array<Apartment>} apartments - All apartments on this floor.
 * @property {Object} section - Section topology.
 * @property {Object} typeCounts - { '1K': n, '2K': n, ... }
 * @property {number} total - Total apartment count.
 * @property {number} invalid - Count of insolation-invalid apartments.
 * @property {number} noCorr - Count of apartments without corridor access.
 * @property {boolean} feasible - True if no orphans remain.
 */

// ── Factory ─────────────────────────────────────────────

/**
 * Create a well-formed apartment object.
 *
 * @param {Object} opts
 * @param {Array<number|string>} opts.cells
 * @param {number|null} [opts.wetCell]
 * @param {string} opts.type
 * @param {boolean} [opts.valid]
 * @param {boolean} [opts.torec]
 * @param {string|null} [opts.corridorLabel]
 * @returns {Apartment}
 */
export function createApartment(opts) {
  return {
    cells: opts.cells || [],
    wetCell: opts.wetCell !== undefined ? opts.wetCell : null,
    type: opts.type || 'orphan',
    valid: opts.valid !== undefined ? opts.valid : false,
    torec: opts.torec || false,
    corridorLabel: opts.corridorLabel || null
  };
}

// ── Cell extraction helpers ─────────────────────────────

/**
 * Extract only numeric (spatial) cell IDs from an apartment.
 * Replaces the pattern: cells.filter(c => typeof c === 'number')
 *
 * @param {Apartment} apt
 * @returns {Array<number>}
 */
export function numericCells(apt) {
  var result = [];
  var cells = apt.cells;
  for (var i = 0; i < cells.length; i++) {
    if (typeof cells[i] === 'number') result.push(cells[i]);
  }
  return result;
}

/**
 * Extract corridor label strings from an apartment.
 *
 * @param {Apartment} apt
 * @returns {Array<string>}
 */
export function corridorCells(apt) {
  var result = [];
  var cells = apt.cells;
  for (var i = 0; i < cells.length; i++) {
    if (typeof cells[i] === 'string') result.push(cells[i]);
  }
  return result;
}

/**
 * Extract living cells (numeric cells excluding wetCell).
 *
 * @param {Apartment} apt
 * @returns {Array<number>}
 */
export function livingCells(apt) {
  var result = [];
  var cells = apt.cells;
  for (var i = 0; i < cells.length; i++) {
    if (typeof cells[i] === 'number' && cells[i] !== apt.wetCell) {
      result.push(cells[i]);
    }
  }
  return result;
}

/**
 * Count living cells (excludes wetCell and corridor labels).
 *
 * @param {Apartment} apt
 * @returns {number}
 */
export function livingCount(apt) {
  var count = 0;
  var cells = apt.cells;
  for (var i = 0; i < cells.length; i++) {
    if (typeof cells[i] === 'number' && cells[i] !== apt.wetCell) count++;
  }
  return count;
}
