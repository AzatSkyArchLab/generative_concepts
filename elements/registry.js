/**
 * Library elements registry.
 *
 * Each element module exports a default object:
 *   {
 *     id: string,                // unique, includes version (e.g. 'tower-residential-v1')
 *     name: string,              // human-readable
 *     category: string,          // 'building/residential' | 'building/public' | 'part/balcony' | …
 *     typology?: string,         // 'tower' | 'section-row' | 'section-corner' | 'stylobate'
 *     version: number,
 *     schema: { [key]: ParamSpec },
 *     presets?: { [name]: Partial<params> },
 *     acceptedSubelements?: string[],     // building-only
 *     defaultSubelements?:  { [cat]: { id, preset? } },  // building-only
 *     build(params, ctx) → THREE.Object3D,
 *     footprint?(params) → number[][],     // optional polygon helper
 *     icon?: string,                       // optional small SVG/glyph for the picker
 *   }
 *
 * The registry is module-scoped: import once, call register() with each
 * element module at app boot. The urban-block / library renderer queries
 * by id (single-instance lookup) or category (picker UI).
 */

var _byId = {};
var _byCategory = {};

export function register(element) {
  if (!element || !element.id) {
    console.warn('[elements] register: missing id', element);
    return;
  }
  if (_byId[element.id]) {
    console.warn('[elements] register: ' + element.id + ' already registered, overriding');
  }
  _byId[element.id] = element;
  var cat = element.category || 'unknown';
  if (!_byCategory[cat]) _byCategory[cat] = [];
  // Avoid duplicates on hot re-register.
  var list = _byCategory[cat];
  for (var i = 0; i < list.length; i++) {
    if (list[i].id === element.id) { list[i] = element; return; }
  }
  list.push(element);
}

export function get(id) {
  return _byId[id] || null;
}

export function listAll() {
  var out = [];
  for (var k in _byId) if (_byId.hasOwnProperty(k)) out.push(_byId[k]);
  return out;
}

/**
 * List elements in a category, optionally filtered by typology.
 * Categories use slash-prefixes ('building/residential', 'part/balcony')
 * — call with the full string for an exact match, or just the prefix
 * (e.g. 'building') for everything under it.
 */
export function listByCategory(category) {
  if (!category) return listAll();
  if (_byCategory[category]) return _byCategory[category].slice();
  // Prefix match: 'building' → 'building/residential' + 'building/public'.
  var out = [];
  for (var key in _byCategory) {
    if (key === category || key.indexOf(category + '/') === 0) {
      var arr = _byCategory[key];
      for (var i = 0; i < arr.length; i++) out.push(arr[i]);
    }
  }
  return out;
}

/**
 * List of all known categories — used by the picker UI.
 */
export function listCategories() {
  return Object.keys(_byCategory).sort();
}
