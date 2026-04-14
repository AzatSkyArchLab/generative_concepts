/**
 * Logger — centralized logging with levels and a global toggle.
 *
 * Usage:
 *   import { log } from '../core/Logger.js';
 *   log.debug('QuotaResolver', 'candidate', data);
 *   log.info('BuildingPlanner', 'floor 3 done');
 *   log.warn('MergePlanner', 'no candidates');
 *
 * Control:
 *   log.level = 'warn';     // suppress debug + info
 *   log.level = 'silent';   // suppress all
 *   log.level = 'debug';    // show everything (default)
 */

var LEVELS = { debug: 0, info: 1, warn: 2, error: 3, silent: 4 };

var _level = 'info';

var log = {
  get level() { return _level; },
  set level(v) { if (LEVELS[v] !== undefined) _level = v; },

  debug: function () {
    if (LEVELS[_level] > LEVELS.debug) return;
    console.log.apply(console, arguments);
  },

  info: function () {
    if (LEVELS[_level] > LEVELS.info) return;
    console.log.apply(console, arguments);
  },

  warn: function () {
    if (LEVELS[_level] > LEVELS.warn) return;
    console.warn.apply(console, arguments);
  },

  error: function () {
    if (LEVELS[_level] > LEVELS.error) return;
    console.error.apply(console, arguments);
  }
};

export { log };
