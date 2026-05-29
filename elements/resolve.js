/**
 * Resolve final element params from the precedence chain:
 *
 *   1. Schema defaults    — from element.schema[*].default
 *   2. Style overrides    — from styleTheme.paramOverrides[id]
 *                          or styleTheme.paramOverrides['category:<cat>']
 *   3. Preset             — from element.presets[name]
 *   4. User overrides     — feature.properties.elementParams
 *
 * Each later layer wins.
 */

function defaultsFromSchema(schema) {
  var out = {};
  if (!schema) return out;
  for (var k in schema) {
    if (!schema.hasOwnProperty(k)) continue;
    var spec = schema[k];
    if (spec && spec.default !== undefined) out[k] = spec.default;
  }
  return out;
}

function pickStyleOverrides(element, styleTheme) {
  if (!styleTheme || !styleTheme.paramOverrides) return {};
  var byId = styleTheme.paramOverrides[element.id];
  var byCat = styleTheme.paramOverrides['category:' + element.category];
  return Object.assign({}, byCat || {}, byId || {});
}

/**
 * @param {Object} element  the registered element module
 * @param {Object} [opts]
 * @param {string} [opts.preset]      preset name to apply
 * @param {Object} [opts.userParams]  user overrides from feature properties
 * @param {Object} [opts.styleTheme]  active block-level style theme
 * @returns {Object}  final params object — what to pass to element.build()
 */
export function resolveParams(element, opts) {
  opts = opts || {};
  var defaults = defaultsFromSchema(element.schema);
  var style = pickStyleOverrides(element, opts.styleTheme);
  var presetVals = (opts.preset && element.presets && element.presets[opts.preset]) || {};
  var user = opts.userParams || {};
  return Object.assign({}, defaults, style, presetVals, user);
}

/**
 * Validate a single param value against its schema entry. Returns the
 * coerced value (clamped to range / fallback to default for invalid
 * enum) or null if entirely invalid. Used by the params popup UI.
 */
export function coerceParam(spec, value) {
  if (!spec) return value;
  var t = spec.type;
  if (t === 'number') {
    var n = +value;
    if (!isFinite(n)) return spec.default;
    if (spec.min !== undefined && n < spec.min) n = spec.min;
    if (spec.max !== undefined && n > spec.max) n = spec.max;
    return n;
  }
  if (t === 'bool') return !!value;
  if (t === 'enum') {
    if (Array.isArray(spec.options) && spec.options.indexOf(value) >= 0) return value;
    return spec.default;
  }
  if (t === 'color') {
    return (typeof value === 'string' && /^#[0-9a-fA-F]{3,8}$/.test(value)) ? value : spec.default;
  }
  return value;
}
