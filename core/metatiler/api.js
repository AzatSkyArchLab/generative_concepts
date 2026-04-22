/**
 * MetaTiler API client — thin HTTP wrapper for the Metapolis tiler.
 *
 * Pure module — no DOM, no MapLibre, no event bus. Uses global fetch,
 * returns Promises. Safe to import from modules, UI panels, or Node
 * tooling.
 *
 * Endpoints covered in v1 (matches the Swagger surface):
 *   - GET  /layers                          catalog of layers
 *   - GET  /layers/{layer_id}               single-layer metadata
 *   - GET  /tiles/{layer_id}/{z}/{x}/{y}    MVT tile (used only as URL
 *                                            template for MapLibre)
 *
 * Upload / importer endpoints are intentionally omitted here — they
 * belong to a separate writer flow and will live in their own file.
 *
 * Base URL resolution order:
 *   1. explicit argument passed to any method
 *   2. setBaseURL(url) at runtime
 *   3. window.__METATILER_URL__ (seeded from app.js or DevTools)
 *   4. DEFAULT_BASE_URL — the stage server
 *
 * All Promise-returning calls reject with a structured Error whose
 * .status carries the HTTP code (or 0 for network failures).
 */

export var DEFAULT_BASE_URL = 'https://meta-tiler-stage.metapolis.su';

var _baseURL = null;

export function setBaseURL(url) {
  _baseURL = (typeof url === 'string' && url.length > 0) ? stripSlash(url) : null;
}

export function getBaseURL() {
  if (_baseURL) return _baseURL;
  try {
    if (typeof window !== 'undefined' && typeof window.__METATILER_URL__ === 'string') {
      return stripSlash(window.__METATILER_URL__);
    }
  } catch (_e) { /* no-op */ }
  return DEFAULT_BASE_URL;
}

function stripSlash(u) {
  if (u.length > 0 && u.charAt(u.length - 1) === '/') return u.substring(0, u.length - 1);
  return u;
}

// ── Error shape ─────────────────────────────────────────

function makeError(message, status, body) {
  var err = new Error(message);
  err.status = status || 0;
  err.body = body || null;
  return err;
}

function request(path, options) {
  var base = (options && options.baseURL) ? stripSlash(options.baseURL) : getBaseURL();
  var url = base + path;
  var init = {
    method: (options && options.method) || 'GET',
    headers: { 'accept': 'application/json' }
  };
  if (options && options.body != null) init.body = options.body;
  if (options && options.headers) {
    var k;
    for (k in options.headers) {
      if (options.headers.hasOwnProperty(k)) init.headers[k] = options.headers[k];
    }
  }

  return fetch(url, init).then(function (resp) {
    var ct = resp.headers.get('content-type') || '';
    var isJSON = ct.indexOf('application/json') >= 0;
    if (!resp.ok) {
      if (isJSON) {
        return resp.json().then(function (body) {
          var msg = (body && (body.error || body.message)) || ('HTTP ' + resp.status);
          throw makeError(msg, resp.status, body);
        }, function () {
          throw makeError('HTTP ' + resp.status, resp.status, null);
        });
      }
      return resp.text().then(function (txt) {
        throw makeError('HTTP ' + resp.status + (txt ? ': ' + txt.slice(0, 200) : ''), resp.status, txt);
      });
    }
    if (isJSON) return resp.json();
    return resp.text();
  }, function (netErr) {
    throw makeError('Network error: ' + (netErr && netErr.message ? netErr.message : 'fetch failed'), 0, null);
  });
}

// ── Catalog ─────────────────────────────────────────────

/**
 * Fetch the layer catalog from GET /layers.
 *
 * Normalizes the response to a plain array of layer descriptors,
 * regardless of whether the server returns `[...]`, `{ layers: [...] }`,
 * or `{ data: [...] }`. Each descriptor is pass-through — no field
 * renames — callers pick what they need.
 *
 * @param {Object} [opts]
 * @param {string} [opts.baseURL] - override base URL for this call
 * @returns {Promise<Array<Object>>}
 */
export function fetchLayers(opts) {
  return request('/layers', opts).then(function (body) {
    if (Array.isArray(body)) return body;
    if (body && Array.isArray(body.layers)) return body.layers;
    if (body && Array.isArray(body.data)) return body.data;
    if (body && Array.isArray(body.items)) return body.items;
    // Unknown envelope — surface as empty list rather than crashing.
    // Caller can inspect raw via .debug if ever we need to add it.
    return [];
  });
}

/**
 * Fetch metadata for a single layer via GET /layers/{id}.
 *
 * @param {number|string} layerId
 * @param {Object} [opts]
 * @returns {Promise<Object>}
 */
export function fetchLayer(layerId, opts) {
  return request('/layers/' + encodeURIComponent(layerId), opts);
}

// ── Tile URL template ───────────────────────────────────

/**
 * Build a MapLibre-compatible tile URL template for a layer.
 *
 * The template uses {z}/{x}/{y} placeholders as-is — MapLibre
 * substitutes these when requesting individual tiles.
 *
 * @param {number|string} layerId
 * @param {Object} [opts]
 * @param {string} [opts.baseURL] - override base URL
 * @returns {string} URL template, e.g.
 *   https://meta-tiler-stage.metapolis.su/tiles/103/{z}/{x}/{y}
 */
export function buildTileURL(layerId, opts) {
  var base = (opts && opts.baseURL) ? stripSlash(opts.baseURL) : getBaseURL();
  return base + '/tiles/' + encodeURIComponent(layerId) + '/{z}/{x}/{y}';
}

// ── Introspection helpers ───────────────────────────────

/**
 * Extract a human-readable name for a layer catalog entry, falling
 * back to a layer-id based label when no explicit name field exists.
 * Kept here so the panel and the module agree on the naming rule.
 */
export function layerDisplayName(entry) {
  if (!entry) return '';
  var candidates = ['name', 'layer_name', 'title', 'label', 'alias', 'filename'];
  for (var i = 0; i < candidates.length; i++) {
    var v = entry[candidates[i]];
    if (typeof v === 'string' && v.length > 0) return v;
  }
  var id = layerIdOf(entry);
  if (id != null) return 'Layer ' + id;
  return '—';
}

/**
 * Extract the layer id from a catalog entry, tolerating common field
 * names. Returns null when no id field is present.
 */
export function layerIdOf(entry) {
  if (!entry) return null;
  if (entry.layer_id != null) return entry.layer_id;
  if (entry.id != null) return entry.id;
  if (entry.layerId != null) return entry.layerId;
  return null;
}

/**
 * Extract geometry type ('polygon' | 'line' | 'point' | null) from a
 * catalog entry if exposed. Not all servers publish it; callers that
 * need to style geometry should render fill+line+circle together and
 * let MapLibre filter by what actually shows up in the MVT.
 */
export function geometryTypeOf(entry) {
  if (!entry) return null;
  var candidates = ['geometry_type', 'geom_type', 'geometry', 'type'];
  for (var i = 0; i < candidates.length; i++) {
    var v = entry[candidates[i]];
    if (typeof v === 'string' && v.length > 0) return v.toLowerCase();
  }
  return null;
}
