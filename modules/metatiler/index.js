/**
 * MetaTiler module — remote MVT layer rendering, click-to-inspect,
 * and attribute-substring highlighting.
 *
 * Layer rendering
 * ---------------
 * Per user layer: one vector source + three style layers (fill /
 * line / circle) constrained by geometry-type filters:
 *   fill   — only Polygons
 *   line   — only LineStrings (polygon outlines come from fill-outline-color)
 *   circle — only Points (not polygon/line vertices)
 *
 * Source-layer detection
 * ----------------------
 * On add: add the triple using candidate names (cheap guess) AND
 * fetch one tile at the map center. The probe parses the MVT
 * protobuf to extract both the real source-layer name(s) and the
 * attribute keys of each sub-layer. When it resolves, the style
 * layers are rebuilt against the real name, and the keys are cached
 * for use by attribute-level filters.
 *
 * Feature selection (click)
 * -------------------------
 * Global map click → queryRenderedFeatures on active metatiler
 * layers → highlight (fill+line) filtered by MVT Feature.id (or
 * fallback property id field), so every tile fragment of the same
 * feature is painted. Popup lists all properties, styled via CSS
 * variables to inherit the app's theme.
 *
 * Substring highlight (attribute filter)
 * --------------------------------------
 * External event metatiler:highlight-substring selects a subset
 * of polygons whose ANY attribute value contains ANY of the given
 * substrings (case-insensitive). Built from the keys discovered by
 * the probe — no need for the caller to know attribute names.
 *
 * Event contract
 * --------------
 *   metatiler:fetch-catalog
 *   metatiler:add-layer          { layerId, sourceLayer?, meta? }
 *   metatiler:remove-layer       { layerId }
 *   metatiler:set-visibility     { layerId, visible }
 *   metatiler:highlight-substring{ layerId, substrings, color? }
 *                                  — substrings: string[]; [] to clear
 *   metatiler:get-state          (responds on 'metatiler:state')
 */

import maplibregl from 'maplibre-gl';
import { fetchLayers, buildTileURL, getBaseURL } from '../../core/metatiler/api.js';
import { probeTileForLayerInfo, lngLatToTileXY } from '../../core/metatiler/mvt-probe.js';
import { getLayerConfig } from '../../core/metatiler/layer-config.js';
import { computeBuildingsBuffer, computeBuildingsBufferSplit } from '../../core/metatiler/buildings-buffer.js';
import polygonClipping from 'polygon-clipping';
import {
  extractAndExtrudeBuildings,
  removeLocalBuildings,
  clearLocalBuildings,
  LOCAL_SRC_ID,
  LOCAL_EXT_ID
} from '../../core/metatiler/buildings-local.js';
import { log } from '../../core/Logger.js';

// ── Styling ────────────────────────────────────────────

var STYLE = {
  fill:   { color: '#7c3aed', opacity: 0.22, outline: '#5b21b6' },
  line:   { color: '#7c3aed', width: 1.5 },
  circle: { color: '#7c3aed', radius: 3.5, strokeColor: '#ffffff', strokeWidth: 1 }
};
var HIGHLIGHT = {
  fillColor: '#fb923c', fillOpacity: 0.45,
  lineColor: '#ea580c', lineWidth: 2
};
var SUBSTRING_HIGHLIGHT_DEFAULT = {
  color: '#0d9488', // teal-600
  fillOpacity: 0.5,
  lineWidth: 1.6
};

var FILTER_POLYGON = ['==', ['geometry-type'], 'Polygon'];
var FILTER_LINE    = ['==', ['geometry-type'], 'LineString'];
var FILTER_POINT   = ['==', ['geometry-type'], 'Point'];

function sourceIdFor(layerId)     { return 'metatiler-src-' + layerId; }
function hlFillIdFor(layerId)     { return 'metatiler-hl-fill-' + layerId; }
function hlLineIdFor(layerId)     { return 'metatiler-hl-line-' + layerId; }
function subFillIdFor(layerId)    { return 'metatiler-sub-fill-' + layerId; }
function subLineIdFor(layerId)    { return 'metatiler-sub-line-' + layerId; }

// ── State ─────────────────────────────────────────────

var _mapManager = null;
var _eventBus = null;
var _featureStore = null;
var _unsubs = [];
var _clickHandler = null;

/**
 * Active layers. Typed entries include buildings metadata.
 *   _active[key] = {
 *     layerId, visible, meta, config,
 *     styleLayerIds, buildings,          // buildings: { style, extrusion, footprint, filters }
 *     sourceLayerName, keys, probed,
 *     substringHighlight
 *   }
 */
var _active = {};
var _probeCache = {};
var _selection = null;

/**
 * Cached lazy-load buffer for buildings layers.
 *   { outer: Geometry|null, inner: Geometry|null }
 *   null === no buffer computed yet (before first features:changed).
 */
var _buffer = null;
var _bufferComputePending = null;

/**
 * Latest section/tower footprints from section-gen. These are the
 * SOURCE for the inner keep-out buffer — extrusion is suppressed
 * within inner-radius metres of each footprint's boundary.
 *
 * Shape: Array of rings [[lng,lat], ...] (closed). Collected from
 * section-gen's `lineFootprints` on every `section-gen:rebuilt`
 * event. Footprints live outside the FeatureStore — they're derived
 * geometry, computed by the section-gen processor and not persisted
 * through add/remove feature events.
 */
var _sectionFootprintRings = [];

/**
 * User-tunable buffer parameters. BufferPanel drives these through
 * `buildings:radii:changed` events. Defaults from the layer config
 * (500m / 40m for layer 104) seed the initial values.
 */
var _bufferRadii = { outerM: 300, innerM: 40 };

/**
 * Snapshot of the most recent building features (Polygon/MultiPolygon
 * in lngLat) with `_height_m` on each. Refreshed on every extract.
 * Exposed to other modules (insolation) through `getExtractedBuildings`
 * so they can build raycast meshes against the same set that renders
 * on the map — one source of truth.
 */
var _extractedBuildings = [];

/**
 * Public accessor. Returns a reference (not a copy) — consumers
 * should read-only.
 */
export function getExtractedBuildings() {
  return _extractedBuildings;
}

// ── Candidate generation ──────────────────────────────

function collectCandidates(layerId, meta) {
  var seen = {};
  var out = [];
  function push(v) {
    if (typeof v !== 'string' || v.length === 0) return;
    if (seen.hasOwnProperty(v)) return;
    seen[v] = true; out.push(v);
  }
  push('default');
  push(String(layerId));
  push('layer');
  push('layer_' + layerId);
  if (meta && typeof meta === 'object') {
    push(meta.source_layer); push(meta.sourceLayer);
    push(meta.table_name);   push(meta.table);
    push(meta.name);         push(meta.layer_name);
    var fn = meta.filename;
    if (typeof fn === 'string') {
      var stem = fn.replace(/\.(geo)?json$/i, '');
      push(stem);
      var parts = stem.split('__');
      for (var i = parts.length - 1; i >= 0; i--) push(parts[i]);
    }
  }
  return out;
}

// ── MapLibre ops ──────────────────────────────────────

function ensureSource(layerId) {
  var map = _mapManager.getMap();
  if (!map) return null;
  var sid = sourceIdFor(layerId);
  if (!map.getSource(sid)) {
    map.addSource(sid, {
      type: 'vector',
      tiles: [buildTileURL(layerId)],
      minzoom: 0, maxzoom: 22
    });
  }
  return sid;
}

function addStyleLayersForNames(layerId, sourceLayerNames) {
  var map = _mapManager.getMap();
  if (!map) return [];
  var sid = sourceIdFor(layerId);
  var ids = [];
  for (var i = 0; i < sourceLayerNames.length; i++) {
    var sl = sourceLayerNames[i];
    var fillId = 'metatiler-fill-' + layerId + '-' + i;
    var lineId = 'metatiler-line-' + layerId + '-' + i;
    var circleId = 'metatiler-circle-' + layerId + '-' + i;

    map.addLayer({
      id: fillId, type: 'fill', source: sid, 'source-layer': sl,
      filter: FILTER_POLYGON,
      paint: {
        'fill-color': STYLE.fill.color,
        'fill-opacity': STYLE.fill.opacity,
        'fill-outline-color': STYLE.fill.outline
      }
    });
    map.addLayer({
      id: lineId, type: 'line', source: sid, 'source-layer': sl,
      filter: FILTER_LINE,
      paint: { 'line-color': STYLE.line.color, 'line-width': STYLE.line.width }
    });
    map.addLayer({
      id: circleId, type: 'circle', source: sid, 'source-layer': sl,
      filter: FILTER_POINT,
      paint: {
        'circle-color': STYLE.circle.color,
        'circle-radius': STYLE.circle.radius,
        'circle-stroke-color': STYLE.circle.strokeColor,
        'circle-stroke-width': STYLE.circle.strokeWidth
      }
    });
    ids.push(fillId, lineId, circleId);
  }
  return ids;
}

// ── Buildings render path ─────────────────────────────
//
// Design: 3D extrusion is rendered from a LOCAL GeoJSON source,
// not from the vector-tile source. We keep the flat footprint
// layers on the vector-tile source because they're cheap and
// pre-load the tiles that the extrusion extraction queries from.
// See core/metatiler/buildings-local.js for details.



function addBuildingsLayers(layerId, sourceLayerName, cfg) {
  var map = _mapManager.getMap();
  if (!map) return null;
  var sid = sourceIdFor(layerId);

  var catField = cfg.category.field;
  var resValue = cfg.category.residentialValue;

  // Footprint filters use the flat (expression) form directly. No
  // nesting, no gate. These layers are always on — they serve both
  // as user feedback ("here are buildings") and as a forced-load
  // mechanism that pulls the MVT tiles into memory so our local
  // extrusion pipeline can querySourceFeatures from them.
  var filterRes   = ['all', cfg.baseFilter, FILTER_POLYGON,
                     ['==', ['get', catField], resValue]];
  var filterOther = ['all', cfg.baseFilter, FILTER_POLYGON,
                     ['!=', ['get', catField], resValue]];

  var fpResId = 'metatiler-footprint-res-' + layerId;
  var fpOthId = 'metatiler-footprint-oth-' + layerId;

  // "Other" first so residential paints on top in case of overlap.
  map.addLayer({
    id: fpOthId, type: 'fill', source: sid, 'source-layer': sourceLayerName,
    filter: filterOther,
    paint: {
      'fill-color': cfg.colors.other.footprint,
      'fill-outline-color': cfg.colors.other.outline
    }
  });
  map.addLayer({
    id: fpResId, type: 'fill', source: sid, 'source-layer': sourceLayerName,
    filter: filterRes,
    paint: {
      'fill-color': cfg.colors.residential.footprint,
      'fill-outline-color': cfg.colors.residential.outline
    }
  });

  return {
    style: [fpOthId, fpResId],
    footprint: [fpOthId, fpResId],
    filters: { residential: filterRes, other: filterOther },
    sourceLayer: sourceLayerName
  };
}

/**
 * Refresh the 3D extrusion of buildings inside the current buffer.
 *
 * Path: we don't touch the vector-tile extrusion anymore — there are
 * no vector-tile extrusion layers. Instead we pull matching features
 * out of the tiles via querySourceFeatures, merge per-UNOM fragments,
 * and push the result into a local GeoJSON source. The GeoJSON
 * `fill-extrusion` layer uses a trivial `['get', '_height_m']` paint
 * expression, with heights precomputed in JS — no evaluation errors,
 * no `within()` filter.
 *
 * When the buffer is empty (no primary drawn features), clear the
 * local source so nothing renders.
 */
function refreshBuildingsExtrusion() {
  var map = _mapManager.getMap();
  if (!map) return;

  // Always refresh visualisation + mask — even when there's no
  // buffer (they clear themselves in that case).
  refreshBufferVisLayers();
  refreshKeepoutOutline();

  // No buffer → nothing to extrude.
  if (!_buffer || !_buffer.outer) {
    clearLocalBuildings(map);
    return;
  }

  var keys = Object.keys(_active);
  for (var i = 0; i < keys.length; i++) {
    var entry = _active[keys[i]];
    if (!entry.config || entry.config.type !== 'buildings') continue;
    var cfg = entry.config;

    var sourceLayer = (entry.buildings && entry.buildings.sourceLayer)
      || entry.sourceLayer
      || 'main';

    var stats = extractAndExtrudeBuildings({
      map: map,
      vectorSid: sourceIdFor(entry.layerId),
      sourceLayer: sourceLayer,
      outer: _buffer.outer,
      inner: _buffer.inner || null,
      keyField: 'UNOM',
      objTypeField: 'OBJ_TYPE',
      objTypeValue: 'Здание',
      categoryField: cfg.category.field,
      residentialValue: cfg.category.residentialValue,
      heightField: cfg.height.field,
      defaultFloors: cfg.height.defaultFloors,
      residential: cfg.height.residential,
      other: cfg.height.other,
      colors: cfg.colors
    });

    if (stats && stats.kept === 0 && stats.extracted > 0) {
      console.warn('[metatiler] extracted ' + stats.extracted
        + ' building fragments but none fell inside the buffer. '
        + 'Is the primary feature far from the map viewport?');
    }
    if (stats && stats.extracted === 0) {
      console.warn('[metatiler] querySourceFeatures returned 0 buildings. '
        + 'Tiles for this area may not be loaded yet — try zooming in/out '
        + 'to trigger a fresh tile load.');
    }

    // Publish the extracted features so insolation can build a
    // raycast mesh against them. We keep the snapshot at module
    // scope for pull-access (insol queries it at runAnalysis time
    // rather than rebuilding on every extract) and also emit an
    // event so any future consumer can subscribe.
    _extractedBuildings = (stats && stats.features) ? stats.features : [];
    _eventBus.emit('metatiler:buildings:extracted', {
      count: _extractedBuildings.length
    });

    // Only one buildings layer per map makes sense (we have one
    // local source). Break after the first.
    return;
  }
}

// ── Buffer visualisation + footprint mask ────────────────
//
// Three sources / four layers, all GeoJSON:
//
//   metatiler-bldg-vis (outer fill+line, inner fill+line)
//     A coloured overlay of the buffer shapes themselves. Blue for
//     outer, red for inner. Per-row visibility toggle from
//     BufferPanel — default OFF for both. This is the "show me where
//     the buffer is" feature; does not affect any other rendering.
//
//   metatiler-bldg-footprint-mask
//     A mask polygon covering inner ∩ outer, filled with the map's
//     background colour so it hides the vector-tile footprints under
//     it. This is always on whenever the buffer exists — user asked
//     for "удали footprints вступающих в коллизии с inner". We don't
//     actually delete tile footprints (can't), we paint over them.
//     Using the background colour so it blends naturally regardless
//     of the base style.

var BLDG_VIS_SRC = 'metatiler-bldg-vis-src';
var BLDG_VIS_OUTER_FILL = 'metatiler-bldg-vis-outer-fill';
var BLDG_VIS_OUTER_LINE = 'metatiler-bldg-vis-outer-line';
var BLDG_VIS_INNER_FILL = 'metatiler-bldg-vis-inner-fill';
var BLDG_VIS_INNER_LINE = 'metatiler-bldg-vis-inner-line';

var BLDG_MASK_SRC = 'metatiler-bldg-mask-src';
var BLDG_MASK_LINE = 'metatiler-bldg-mask-line';

var _visVisibility = { outer: false, inner: false };

function refreshBufferVisLayers() {
  var map = _mapManager && _mapManager.getMap();
  if (!map) return;

  // Build FeatureCollection for vis layers.
  var visFeatures = [];
  if (_buffer && _buffer.outer) {
    visFeatures.push({
      type: 'Feature', properties: { kind: 'outer' },
      geometry: _buffer.outer
    });
  }
  if (_buffer && _buffer.inner) {
    visFeatures.push({
      type: 'Feature', properties: { kind: 'inner' },
      geometry: _buffer.inner
    });
  }
  var visFC = { type: 'FeatureCollection', features: visFeatures };

  if (!map.getSource(BLDG_VIS_SRC)) {
    map.addSource(BLDG_VIS_SRC, { type: 'geojson', data: visFC });
    map.addLayer({
      id: BLDG_VIS_OUTER_FILL, type: 'fill', source: BLDG_VIS_SRC,
      filter: ['==', ['get', 'kind'], 'outer'],
      layout: { visibility: _visVisibility.outer ? 'visible' : 'none' },
      paint: { 'fill-color': '#3b82f6', 'fill-opacity': 0.10 }
    });
    map.addLayer({
      id: BLDG_VIS_OUTER_LINE, type: 'line', source: BLDG_VIS_SRC,
      filter: ['==', ['get', 'kind'], 'outer'],
      layout: { visibility: _visVisibility.outer ? 'visible' : 'none' },
      paint: { 'line-color': '#1d4ed8', 'line-width': 1.5, 'line-dasharray': [3, 2] }
    });
    map.addLayer({
      id: BLDG_VIS_INNER_FILL, type: 'fill', source: BLDG_VIS_SRC,
      filter: ['==', ['get', 'kind'], 'inner'],
      layout: { visibility: _visVisibility.inner ? 'visible' : 'none' },
      paint: { 'fill-color': '#dc2626', 'fill-opacity': 0.18 }
    });
    map.addLayer({
      id: BLDG_VIS_INNER_LINE, type: 'line', source: BLDG_VIS_SRC,
      filter: ['==', ['get', 'kind'], 'inner'],
      layout: { visibility: _visVisibility.inner ? 'visible' : 'none' },
      paint: { 'line-color': '#991b1b', 'line-width': 1.5 }
    });
  } else {
    map.getSource(BLDG_VIS_SRC).setData(visFC);
  }
}

function removeBufferVisLayers() {
  var map = _mapManager && _mapManager.getMap();
  if (!map) return;
  var ids = [BLDG_VIS_OUTER_FILL, BLDG_VIS_OUTER_LINE,
             BLDG_VIS_INNER_FILL, BLDG_VIS_INNER_LINE];
  for (var i = 0; i < ids.length; i++) {
    if (map.getLayer(ids[i])) map.removeLayer(ids[i]);
  }
  if (map.getSource(BLDG_VIS_SRC)) map.removeSource(BLDG_VIS_SRC);
}

/**
 * Render the OUTLINE of inner ∩ outer as a thin red line — the
 * boundary of the keep-out zone where building footprints are
 * considered in collision with section/tower footprints.
 *
 * Visibility is slaved to the "Inner bldg" swatch in BufferPanel —
 * same signal that controls the red fill+line visualisation of the
 * inner buffer itself. Default is OFF.
 */
function refreshKeepoutOutline() {
  var map = _mapManager && _mapManager.getMap();
  if (!map) return;

  var maskGeom = null;
  if (_buffer && _buffer.outer && _buffer.inner) {
    try {
      var a = _buffer.outer.coordinates;
      var b = _buffer.inner.coordinates;
      var inter = polygonClipping.intersection(a, b);
      if (inter && inter.length > 0) {
        maskGeom = { type: 'MultiPolygon', coordinates: inter };
      }
    } catch (err) {
      console.warn('[metatiler] keepout intersection failed:', err && err.message);
    }
  }

  var maskFC = maskGeom
    ? { type: 'FeatureCollection', features: [{
        type: 'Feature', properties: {}, geometry: maskGeom
      }] }
    : { type: 'FeatureCollection', features: [] };

  if (!map.getSource(BLDG_MASK_SRC)) {
    map.addSource(BLDG_MASK_SRC, { type: 'geojson', data: maskFC });
    map.addLayer({
      id: BLDG_MASK_LINE, type: 'line', source: BLDG_MASK_SRC,
      layout: { visibility: _visVisibility.inner ? 'visible' : 'none' },
      paint: {
        'line-color': '#dc2626',
        'line-width': 1.2,
        'line-opacity': 0.9
      }
    });
  } else {
    map.getSource(BLDG_MASK_SRC).setData(maskFC);
  }
}

function removeFootprintMask() {
  var map = _mapManager && _mapManager.getMap();
  if (!map) return;
  if (map.getLayer(BLDG_MASK_LINE)) map.removeLayer(BLDG_MASK_LINE);
  if (map.getSource(BLDG_MASK_SRC)) map.removeSource(BLDG_MASK_SRC);
}

function setBufferVisibility(which, visible) {
  _visVisibility[which] = !!visible;
  var map = _mapManager && _mapManager.getMap();
  if (!map) return;
  var fillId = which === 'outer' ? BLDG_VIS_OUTER_FILL : BLDG_VIS_INNER_FILL;
  var lineId = which === 'outer' ? BLDG_VIS_OUTER_LINE : BLDG_VIS_INNER_LINE;
  var v = visible ? 'visible' : 'none';
  if (map.getLayer(fillId)) map.setLayoutProperty(fillId, 'visibility', v);
  if (map.getLayer(lineId)) map.setLayoutProperty(lineId, 'visibility', v);
  // The keep-out outline (inner ∩ outer boundary) rides on the same
  // swatch as the inner buffer visualisation — they convey the same
  // "here is the collision zone" signal.
  if (which === 'inner' && map.getLayer(BLDG_MASK_LINE)) {
    map.setLayoutProperty(BLDG_MASK_LINE, 'visibility', v);
  }
}


function removeStyleLayers(styleLayerIds) {
  var map = _mapManager.getMap();
  if (!map || !styleLayerIds) return;
  for (var i = 0; i < styleLayerIds.length; i++) {
    if (map.getLayer(styleLayerIds[i])) map.removeLayer(styleLayerIds[i]);
  }
}

function removeSource(layerId) {
  var map = _mapManager.getMap();
  if (!map) return;
  var sid = sourceIdFor(layerId);
  if (map.getSource(sid)) map.removeSource(sid);
}

function allStyleLayerIds(entry) {
  // Everything that should respond to visibility toggles for this
  // entry — base, selection, and substring highlight.
  var ids = entry.styleLayerIds.slice();
  if (entry.substringHighlight && entry.substringHighlight.ids) {
    ids = ids.concat(entry.substringHighlight.ids);
  }
  return ids;
}

function setVisibilityOnMap(styleLayerIds, visible) {
  var map = _mapManager.getMap();
  if (!map || !styleLayerIds) return;
  var v = visible ? 'visible' : 'none';
  for (var i = 0; i < styleLayerIds.length; i++) {
    if (map.getLayer(styleLayerIds[i])) {
      map.setLayoutProperty(styleLayerIds[i], 'visibility', v);
    }
  }
}

// ── Probe ─────────────────────────────────────────────

function probeLayer(layerId) {
  var map = _mapManager.getMap();
  if (!map) return Promise.reject(new Error('map not ready'));
  var center = map.getCenter();
  var zoom = Math.max(0, Math.min(22, Math.floor(map.getZoom())));
  var tc = lngLatToTileXY(center.lng, center.lat, zoom);
  var base = getBaseURL();
  var tileURL = base + '/tiles/' + encodeURIComponent(layerId)
    + '/' + tc.z + '/' + tc.x + '/' + tc.y;
  log.debug('[metatiler] probe ' + tileURL);
  return probeTileForLayerInfo(tileURL);
}

function applyProbedInfo(key, info) {
  var entry = _active[key];
  if (!entry || !info || info.length === 0) return;

  var names = [];
  var allKeys = {};
  for (var i = 0; i < info.length; i++) {
    names.push(info[i].name);
    var ks = info[i].keys || [];
    for (var j = 0; j < ks.length; j++) allKeys[ks[j]] = true;
  }
  var keys = Object.keys(allKeys);

  // DIAGNOSTIC — dump real attribute names so we can see what the
  // tiler actually serves, not what the source GPKG had.
  console.log('[metatiler] layer ' + entry.layerId + ' REAL ATTRIBUTES:', keys);

  // For buildings: adapt configured field names to the actual case.
  // Metapolis tiler → PostgreSQL almost certainly lowercases them.
  // If the config says 'OBJ_TYPE' but the tile has 'obj_type', remap.
  if (entry.config && entry.config.type === 'buildings') {
    adaptBuildingsFieldNames(entry.config, keys);
  }

  removeStyleLayers(entry.styleLayerIds);
  if (entry.substringHighlight) {
    removeStyleLayers(entry.substringHighlight.ids);
    entry.substringHighlight = null;
  }

  entry.sourceLayerName = names[0];
  entry.keys = keys;
  entry.probed = true;

  if (entry.config && entry.config.type === 'buildings') {
    var b = addBuildingsLayers(entry.layerId, names[0], entry.config);
    entry.styleLayerIds = b.style;
    entry.buildings = b;
  } else {
    entry.styleLayerIds = addStyleLayersForNames(entry.layerId, names);
  }

  if (!entry.visible) setVisibilityOnMap(entry.styleLayerIds, false);

  _probeCache[key] = { names: names, keys: keys };

  console.log('[metatiler] layer ' + entry.layerId + ' probed → '
    + 'source-layer=' + names.join(',')
    + ', attrs=' + keys.length
    + (entry.config && entry.config.type !== 'default' ? ' [' + entry.config.type + ']' : ''));

  // Sanity check: try to fetch one feature from the current viewport
  // via queryRenderedFeatures and dump its properties. That gives the
  // actual property dict shape the filter will see at runtime.
  try {
    var map = _mapManager.getMap();
    if (map && entry.styleLayerIds && entry.styleLayerIds.length > 0) {
      // Delay 500ms to let tiles load after the source is registered.
      setTimeout(function () {
        var m = _mapManager.getMap();
        if (!m) return;
        var feats = m.queryRenderedFeatures({
          layers: entry.styleLayerIds.slice(0, 4)
        });
        if (feats && feats.length > 0) {
          console.log('[metatiler] sample feature[0].properties from tile:',
            feats[0].properties);
          console.log('[metatiler] sample feature[0] props keys:',
            Object.keys(feats[0].properties || {}));
        } else {
          console.warn('[metatiler] queryRenderedFeatures returned empty — no tiles rendered in viewport yet, or base filter excludes everything.');
        }
      }, 800);
    }
  } catch (err) {
    console.warn('[metatiler] queryRenderedFeatures probe failed:', err);
  }

  if (entry.config && entry.config.type === 'buildings') {
    scheduleBufferRecompute(true);
  }

  _eventBus.emit('metatiler:layer:changed', {
    layerId: entry.layerId, visible: entry.visible,
    sourceLayerName: names[0], keys: keys, probed: true,
    layerType: entry.config ? entry.config.type : 'default'
  });
}

/**
 * Adapt buildings config field names to whatever casing the tiler
 * actually serves. Looks up each configured field name (baseFilter's
 * OBJ_TYPE, category.field, height.field) against the real key list
 * and rewrites the config in place if a case-insensitive match is
 * found.
 *
 * This is a rescue path for the common case where the source GPKG
 * had uppercase fields (OBJ_TYPE, TYPE, FLOOR) but the tiler
 * lowercased them (obj_type, type, floor). Without this, every
 * filter clause evaluates to false and nothing renders.
 */
function adaptBuildingsFieldNames(cfg, actualKeys) {
  var caseMap = {};
  for (var i = 0; i < actualKeys.length; i++) {
    caseMap[actualKeys[i].toLowerCase()] = actualKeys[i];
  }

  var rewrites = [];

  // baseFilter field — extract from ['==', ['get', 'OBJ_TYPE'], ...].
  if (cfg.baseFilter && cfg.baseFilter[0] === '==' && Array.isArray(cfg.baseFilter[1])
      && cfg.baseFilter[1][0] === 'get') {
    var bfName = cfg.baseFilter[1][1];
    var bfActual = caseMap[bfName.toLowerCase()];
    if (bfActual && bfActual !== bfName) {
      cfg.baseFilter[1][1] = bfActual;
      rewrites.push(bfName + ' → ' + bfActual);
    } else if (!bfActual) {
      console.warn('[metatiler] buildings.baseFilter field "' + bfName
        + '" not found in tile. Available keys:', actualKeys);
    }
  }

  if (cfg.category && cfg.category.field) {
    var cfName = cfg.category.field;
    var cfActual = caseMap[cfName.toLowerCase()];
    if (cfActual && cfActual !== cfName) {
      cfg.category.field = cfActual;
      rewrites.push(cfName + ' → ' + cfActual);
    } else if (!cfActual) {
      console.warn('[metatiler] buildings.category.field "' + cfName
        + '" not found in tile. Available keys:', actualKeys);
    }
  }

  if (cfg.height && cfg.height.field) {
    var hfName = cfg.height.field;
    var hfActual = caseMap[hfName.toLowerCase()];
    if (hfActual && hfActual !== hfName) {
      cfg.height.field = hfActual;
      rewrites.push(hfName + ' → ' + hfActual);
    } else if (!hfActual) {
      console.warn('[metatiler] buildings.height.field "' + hfName
        + '" not found in tile. Available keys:', actualKeys);
    }
  }

  if (rewrites.length > 0) {
    console.log('[metatiler] adapted buildings config fields:', rewrites.join(', '));
  } else {
    console.log('[metatiler] buildings config fields match tile keys — no adaptation needed.');
  }
}

// ── Click & selection ─────────────────────────────────

function collectQueryableLayerIds() {
  var ids = [];
  var keys = Object.keys(_active);
  for (var i = 0; i < keys.length; i++) {
    var entry = _active[keys[i]];
    if (!entry.visible) continue;
    for (var j = 0; j < entry.styleLayerIds.length; j++) {
      ids.push(entry.styleLayerIds[j]);
    }
  }
  return ids;
}

function findOwnerLayerKey(styleLayerId) {
  var keys = Object.keys(_active);
  for (var i = 0; i < keys.length; i++) {
    var entry = _active[keys[i]];
    if (entry.styleLayerIds.indexOf(styleLayerId) >= 0) return keys[i];
  }
  return null;
}

function buildHighlightFilter(feature) {
  if (feature.id != null) return ['==', ['id'], feature.id];
  var props = feature.properties || {};
  var cand = ['id', 'fid', 'gid', 'object_id', 'objectid', 'uid', 'osm_id'];
  for (var i = 0; i < cand.length; i++) {
    if (props[cand[i]] != null) return ['==', ['get', cand[i]], props[cand[i]]];
  }
  return null;
}

function handleMapClick(e) {
  var map = _mapManager.getMap();
  if (!map) return;
  var layerIds = collectQueryableLayerIds();
  if (layerIds.length === 0) return;
  var features;
  try {
    features = map.queryRenderedFeatures(e.point, { layers: layerIds });
  } catch (_err) { features = []; }
  if (features.length === 0) { clearSelection(); return; }
  selectFeature(features[0], e.lngLat);
}

function selectFeature(feature, lngLat) {
  clearSelection();
  var map = _mapManager.getMap();
  if (!map) return;
  var userKey = findOwnerLayerKey(feature.layer.id);
  if (userKey == null) return;
  var userLayerId = _active[userKey].layerId;

  var sid = sourceIdFor(userKey);
  var sl = feature.sourceLayer;
  var filter = buildHighlightFilter(feature);
  var highlightLayerIds = [];

  if (filter) {
    var gt = feature.geometry && feature.geometry.type;
    var isLine = gt && gt.indexOf('LineString') >= 0;
    var isPoint = gt && gt.indexOf('Point') >= 0;

    if (!isLine && !isPoint) {
      var hlFill = hlFillIdFor(userKey);
      map.addLayer({
        id: hlFill, type: 'fill', source: sid, 'source-layer': sl,
        filter: ['all', FILTER_POLYGON, filter],
        paint: { 'fill-color': HIGHLIGHT.fillColor, 'fill-opacity': HIGHLIGHT.fillOpacity }
      });
      highlightLayerIds.push(hlFill);
    }
    var hlLine = hlLineIdFor(userKey);
    map.addLayer({
      id: hlLine, type: 'line', source: sid, 'source-layer': sl,
      filter: isPoint ? ['all', FILTER_POINT, filter]
            : isLine  ? ['all', FILTER_LINE, filter]
            :            ['all', FILTER_POLYGON, filter],
      paint: { 'line-color': HIGHLIGHT.lineColor, 'line-width': HIGHLIGHT.lineWidth }
    });
    highlightLayerIds.push(hlLine);
  } else {
    log.warn('[metatiler] feature in layer ' + userLayerId
      + ' has no id — highlighting single fragment only.');
  }

  _selection = {
    userLayerId: userLayerId,
    featureId: feature.id != null ? feature.id : null,
    properties: feature.properties || {},
    highlightLayerIds: highlightLayerIds,
    popup: null
  };
  showPopup(lngLat, userLayerId, feature);
}

function clearSelection() {
  if (!_selection) return;
  var map = _mapManager && _mapManager.getMap();
  if (map) removeStyleLayers(_selection.highlightLayerIds);
  if (_selection.popup) {
    try { _selection.popup.remove(); } catch (_e) { /* gone */ }
  }
  _selection = null;
}

// ── Popup ─────────────────────────────────────────────

function showPopup(lngLat, userLayerId, feature) {
  var map = _mapManager.getMap();
  if (!map) return;
  var html = buildPopupHTML(userLayerId, feature);
  var popup = new maplibregl.Popup({
    closeButton: true, closeOnClick: false,
    className: 'metatiler-popup-container',
    maxWidth: '320px', offset: 8
  }).setLngLat([lngLat.lng, lngLat.lat]).setHTML(html).addTo(map);

  popup.on('close', function () {
    if (_selection && _selection.popup === popup) {
      _selection.popup = null;
      clearSelection();
    }
  });
  if (_selection) _selection.popup = popup;
}

function buildPopupHTML(userLayerId, feature) {
  var props = feature.properties || {};
  var idStr = '—';
  if (feature.id != null) idStr = String(feature.id);
  else if (props.id != null) idStr = String(props.id);
  else if (props.fid != null) idStr = String(props.fid);
  else if (props.gid != null) idStr = String(props.gid);

  var html = '<div class="metatiler-popup-header">';
  html += '<span>Layer #' + escapeHTML(String(userLayerId)) + '</span>';
  html += '<span class="metatiler-popup-header-id" title="' + escapeAttr(idStr) + '">id ' + escapeHTML(idStr) + '</span>';
  html += '</div>';

  var keys = Object.keys(props);
  if (keys.length === 0) {
    html += '<div class="metatiler-popup-attrs-empty">No attributes</div>';
    return html;
  }
  keys.sort();

  html += '<div class="metatiler-popup-attrs">';
  for (var i = 0; i < keys.length; i++) {
    var k = keys[i]; var v = props[k];
    var valCls = 'metatiler-popup-attr-value';
    if (v == null || v === '') valCls += ' metatiler-popup-attr-value--null';
    html += '<div class="metatiler-popup-attr">';
    html += '<span class="metatiler-popup-attr-key" title="' + escapeAttr(k) + '">' + escapeHTML(k) + '</span>';
    html += '<span class="' + valCls + '">' + escapeHTML(formatValue(v)) + '</span>';
    html += '</div>';
  }
  html += '</div>';
  return html;
}

function formatValue(v) {
  if (v == null || v === '') return '—';
  if (typeof v === 'number') {
    if (Number.isInteger(v)) return String(v);
    return Number(v.toFixed(6)).toString();
  }
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (typeof v === 'object') {
    try { return JSON.stringify(v); } catch (_e) { return String(v); }
  }
  return String(v);
}

function escapeHTML(s) {
  if (s == null) return '';
  return String(s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
function escapeAttr(s) { return escapeHTML(s); }

// ── Substring highlight ───────────────────────────────

/**
 * Build a MapLibre filter that matches features where ANY of the
 * given substrings appears in the stringified value of ANY of the
 * layer's attribute keys. Case-insensitive via ['downcase'].
 *
 * Filter shape:
 *   ['any',
 *     ['in', 'sub1', ['downcase', ['to-string', ['get', 'key1']]]],
 *     ['in', 'sub1', ['downcase', ['to-string', ['get', 'key2']]]],
 *     ...
 *     ['in', 'sub2', ['downcase', ['to-string', ['get', 'key1']]]],
 *     ...
 *   ]
 *
 * Size: keys.length × substrings.length clauses. For a typical
 * cadastral layer (~20 keys) × 15 substrings = 300 clauses —
 * MapLibre handles this without issue (expressions are compiled
 * once per style update).
 */
function buildSubstringFilter(keys, substrings) {
  if (!keys || keys.length === 0 || !substrings || substrings.length === 0) return null;
  var lower = [];
  for (var i = 0; i < substrings.length; i++) {
    lower.push(String(substrings[i]).toLowerCase());
  }
  var clauses = [];
  for (var ki = 0; ki < keys.length; ki++) {
    var k = keys[ki];
    var getExpr = ['downcase', ['to-string', ['get', k]]];
    for (var si = 0; si < lower.length; si++) {
      clauses.push(['in', lower[si], getExpr]);
    }
  }
  if (clauses.length === 1) return clauses[0];
  return ['any'].concat(clauses);
}

function removeSubstringHighlight(key) {
  var entry = _active[key];
  if (!entry || !entry.substringHighlight) return;
  removeStyleLayers(entry.substringHighlight.ids);
  entry.substringHighlight = null;
}

function onHighlightSubstring(d) {
  if (!d || d.layerId == null) return;
  var key = String(d.layerId);
  var entry = _active[key];
  if (!entry) {
    log.warn('[metatiler] highlight-substring: layer ' + d.layerId + ' not active');
    return;
  }

  var substrings = d.substrings;
  if (!Array.isArray(substrings) || substrings.length === 0) {
    // Empty list = clear.
    removeSubstringHighlight(key);
    _eventBus.emit('metatiler:highlight:changed', {
      layerId: d.layerId, active: false
    });
    return;
  }

  if (!entry.probed || !entry.keys || entry.keys.length === 0) {
    log.warn('[metatiler] highlight-substring: layer ' + d.layerId
      + ' not probed yet — no attribute keys known. Retry in a moment.');
    _eventBus.emit('metatiler:highlight:changed', {
      layerId: d.layerId, active: false, error: 'not-probed'
    });
    return;
  }

  var filter = buildSubstringFilter(entry.keys, substrings);
  if (!filter) {
    removeSubstringHighlight(key);
    return;
  }

  // Rebuild — simplest and safest way to swap the filter.
  removeSubstringHighlight(key);

  var map = _mapManager.getMap();
  if (!map) return;
  var sid = sourceIdFor(key);
  var sl = entry.sourceLayerName;
  var color = (typeof d.color === 'string' && d.color.length > 0)
    ? d.color : SUBSTRING_HIGHLIGHT_DEFAULT.color;

  var fillId = subFillIdFor(key);
  var lineId = subLineIdFor(key);

  map.addLayer({
    id: fillId, type: 'fill', source: sid, 'source-layer': sl,
    filter: ['all', FILTER_POLYGON, filter],
    paint: {
      'fill-color': color,
      'fill-opacity': SUBSTRING_HIGHLIGHT_DEFAULT.fillOpacity
    }
  });
  map.addLayer({
    id: lineId, type: 'line', source: sid, 'source-layer': sl,
    filter: ['all', FILTER_POLYGON, filter],
    paint: {
      'line-color': color,
      'line-width': SUBSTRING_HIGHLIGHT_DEFAULT.lineWidth
    }
  });

  entry.substringHighlight = {
    ids: [fillId, lineId],
    substrings: substrings.slice(),
    color: color
  };

  if (!entry.visible) setVisibilityOnMap(entry.substringHighlight.ids, false);

  log.info('[metatiler] layer ' + d.layerId + ' substring-highlight: ['
    + substrings.join(', ') + '] over ' + entry.keys.length + ' attribute(s)');
  _eventBus.emit('metatiler:highlight:changed', {
    layerId: d.layerId, active: true, substrings: substrings.slice()
  });
}

// ── Click handler lifecycle ───────────────────────────

function ensureClickHandler() {
  if (_clickHandler) return;
  var map = _mapManager.getMap();
  if (!map) return;
  _clickHandler = handleMapClick;
  map.on('click', _clickHandler);
}

function detachClickHandler() {
  if (!_clickHandler) return;
  var map = _mapManager && _mapManager.getMap();
  if (map) map.off('click', _clickHandler);
  _clickHandler = null;
}

// ── FeatureStore buffer lifecycle ─────────────────────

/**
 * Recompute the union buffer from FeatureStore contents and re-
 * apply to active buildings layers.
 *
 * Debounced — burst events during slider drags and block rebuilds
 * collapse to one compute after a 250ms quiet window. Pass
 * immediate=true to skip the debounce (used on layer add when the
 * user already has features in the store).
 */
function scheduleBufferRecompute(immediate) {
  if (immediate) {
    if (_bufferComputePending) {
      clearTimeout(_bufferComputePending);
      _bufferComputePending = null;
    }
    computeAndApplyBuffer();
    return;
  }
  if (_bufferComputePending) return;
  _bufferComputePending = setTimeout(function () {
    _bufferComputePending = null;
    computeAndApplyBuffer();
  }, 250);
}

function computeAndApplyBuffer() {
  console.log('[metatiler] computeAndApplyBuffer() called');

  if (!_featureStore) {
    console.warn('[metatiler] no featureStore — cannot compute buffer');
    _buffer = null;
    return;
  }
  var features = _featureStore.toArray();
  console.log('[metatiler] featureStore has', features.length, 'feature(s)');

  // Dump what types are present so the user can see what slipped
  // through and what got filtered out.
  var typeCounts = {};
  for (var ti = 0; ti < features.length; ti++) {
    var t = (features[ti] && features[ti].properties && features[ti].properties.type) || '(no-type)';
    typeCounts[t] = (typeCounts[t] || 0) + 1;
  }
  console.log('[metatiler] feature types:', JSON.stringify(typeCounts));

  // Outer-buffer anchors — "where does the user work?". The centroid
  // of each axis / polygon / urban-block defines a 500m disc of 3D
  // context. Section/tower footprints are derived from axes, so
  // including them would double-count.
  var outerFeatures = [];
  for (var fi = 0; fi < features.length; fi++) {
    if (isPrimaryDrawnFeature(features[fi])) outerFeatures.push(features[fi]);
  }

  // Inner-buffer sources — "what's the keep-out boundary?". The
  // section/tower footprints themselves, received from section-gen
  // on rebuilt. Each ring becomes a Polygon feature for the
  // Minkowski expansion.
  var innerFeatures = [];
  for (var ri = 0; ri < _sectionFootprintRings.length; ri++) {
    var ring = _sectionFootprintRings[ri];
    if (ring && ring.length >= 3) {
      innerFeatures.push({
        type: 'Feature',
        properties: { type: 'section-footprint-derived' },
        geometry: { type: 'Polygon', coordinates: [ring] }
      });
    }
  }

  // Also accept user-drawn polygons as inner sources — if the user
  // has drawn a plot outline, keep-out from that boundary is
  // intuitive. This is additive: inner = footprints ∪ user-polygons.
  for (var pi = 0; pi < outerFeatures.length; pi++) {
    var pf = outerFeatures[pi];
    if (!pf.geometry) continue;
    var gt = pf.geometry.type;
    if (gt === 'Polygon' || gt === 'MultiPolygon') innerFeatures.push(pf);
  }

  console.log('[metatiler] buffer inputs: outerFeatures=' + outerFeatures.length
    + ', innerFeatures=' + innerFeatures.length
    + ' (' + _sectionFootprintRings.length + ' from section-gen footprints)');

  if (outerFeatures.length === 0) {
    _buffer = null;
    refreshBuildingsExtrusion();
    _eventBus.emit('metatiler:buildings:buffer-changed', {
      hasOuter: false, hasInner: false
    });
    console.warn('[metatiler] buffer: no primary drawn features — 3D extrusion will stay hidden.');
    return;
  }

  // Radii: user sliders override config defaults. Config is read
  // once on activation to seed the initial values, then the UI
  // owns them.
  var hasBuildingsActive = false;
  var keys = Object.keys(_active);
  for (var i = 0; i < keys.length; i++) {
    var e = _active[keys[i]];
    if (e.config && e.config.type === 'buildings'
        && e.config.lazyLoad && e.config.lazyLoad.enabled) {
      hasBuildingsActive = true;
      break;
    }
  }
  if (!hasBuildingsActive) {
    console.warn('[metatiler] no active buildings layer — buffer compute skipped. '
      + 'Enable layer #104 to see 3D.');
    _buffer = null;
    return;
  }

  var outerR = _bufferRadii.outerM;
  var innerR = _bufferRadii.innerM;

  var start = (typeof performance !== 'undefined')
    ? performance.now() : Date.now();
  try {
    _buffer = computeBuildingsBufferSplit({
      outerFeatures: outerFeatures,
      innerFeatures: innerFeatures,
      outerRadiusM: outerR,
      innerRadiusM: innerR,
      segments: 32
    });
  } catch (err) {
    console.error('[metatiler] buffer compute FAILED:', err);
    console.error('[metatiler] error stack:', err && err.stack);
    _buffer = null;
  }
  var ms = ((typeof performance !== 'undefined')
    ? performance.now() : Date.now()) - start;
  console.log('[metatiler] buffer recomputed in ' + ms.toFixed(0) + 'ms; '
    + 'outerFeatures=' + outerFeatures.length
    + ', innerFeatures=' + innerFeatures.length
    + ', outer=' + outerR + 'm, inner=' + innerR + 'm; '
    + 'hasOuter=' + !!(_buffer && _buffer.outer)
    + ', hasInner=' + !!(_buffer && _buffer.inner));

  refreshBuildingsExtrusion();
  _eventBus.emit('metatiler:buildings:buffer-changed', {
    hasOuter: !!(_buffer && _buffer.outer),
    hasInner: !!(_buffer && _buffer.inner),
    outerRadiusM: outerR,
    innerRadiusM: innerR
  });
}

/**
 * True for FeatureStore entries that represent primary user-drawn
 * objects (not system-generated auxiliary geometry).
 *
 * Included: section-axis, tower-axis, urban-block, free-form
 *   polygon, free-form line, free-form points if any.
 * Excluded: anything whose properties.type clearly marks it as a
 *   derived render artifact — section footprint, fire/insol/end/road
 *   buffers, green-zone polygon, etc. The safest test is: accept
 *   everything by default, only blacklist known derived types, so
 *   that new user-drawn kinds don't silently disappear.
 */
function isPrimaryDrawnFeature(f) {
  if (!f || !f.properties) return true; // unknown type → assume primary
  var t = f.properties.type;
  if (!t) return true;
  // Known derived/auxiliary feature types — exclude.
  var excluded = {
    'fire-buffer': 1, 'insol-buffer': 1, 'end-buffer': 1, 'road-buffer': 1,
    'section-footprint': 1, 'section': 1,
    'greenzone': 1, 'green-zone': 1
  };
  return !excluded[t];
}

// ── Event handlers ────────────────────────────────────

function onFetchCatalog() {
  fetchLayers().then(function (layers) {
    _eventBus.emit('metatiler:catalog', { layers: layers, error: null });
  }, function (err) {
    log.warn('[metatiler] fetch /layers failed:', err && err.message);
    _eventBus.emit('metatiler:catalog', {
      layers: [], error: { message: err && err.message, status: err && err.status }
    });
  });
}

function onAddLayer(d) {
  if (!d || d.layerId == null) return;
  var key = String(d.layerId);
  if (_active[key]) {
    _active[key].visible = true;
    setVisibilityOnMap(allStyleLayerIds(_active[key]), true);
    _eventBus.emit('metatiler:layer:changed', { layerId: d.layerId, visible: true });
    return;
  }
  ensureClickHandler();
  ensureSource(key);

  var cfg = getLayerConfig(d.layerId);

  // Seed the user-editable buffer radii from layer config on first
  // activation. After this point the UI owns them — further config
  // changes don't affect the running radii until the layer is
  // removed and re-added. Also broadcast the seeded values so
  // BufferPanel can reflect them in its inputs.
  if (cfg.type === 'buildings' && cfg.lazyLoad) {
    var seedOuter = cfg.lazyLoad.outerMeters || cfg.lazyLoad.bufferMeters;
    var seedInner = cfg.lazyLoad.innerMeters;
    if (typeof seedOuter === 'number' && seedOuter > 0) _bufferRadii.outerM = seedOuter;
    if (typeof seedInner === 'number' && seedInner >= 0) _bufferRadii.innerM = seedInner;
    _eventBus.emit('buildings:radii:seeded', {
      outerMeters: _bufferRadii.outerM,
      innerMeters: _bufferRadii.innerM
    });
  }

  // Pinned source-layer branch — skip probe.
  if (typeof d.sourceLayer === 'string' && d.sourceLayer.length > 0) {
    var pinnedIds;
    var pinnedBuildings = null;
    if (cfg.type === 'buildings') {
      pinnedBuildings = addBuildingsLayers(key, d.sourceLayer, cfg);
      pinnedIds = pinnedBuildings.style;
    } else {
      pinnedIds = addStyleLayersForNames(key, [d.sourceLayer]);
    }
    _active[key] = {
      layerId: d.layerId, visible: true, meta: d.meta || null, config: cfg,
      styleLayerIds: pinnedIds, buildings: pinnedBuildings,
      sourceLayerName: d.sourceLayer, keys: [], probed: true,
      substringHighlight: null
    };
    if (cfg.type === 'buildings') scheduleBufferRecompute(true);
    _eventBus.emit('metatiler:layer:changed', {
      layerId: d.layerId, visible: true, added: true,
      sourceLayerName: d.sourceLayer, keys: [], probed: true,
      layerType: cfg.type
    });
    return;
  }

  // Cache hit — reuse known names + keys.
  if (_probeCache[key] && _probeCache[key].names && _probeCache[key].names.length > 0) {
    var cached = _probeCache[key];
    var cachedIds;
    var cachedBuildings = null;
    if (cfg.type === 'buildings') {
      cachedBuildings = addBuildingsLayers(key, cached.names[0], cfg);
      cachedIds = cachedBuildings.style;
    } else {
      cachedIds = addStyleLayersForNames(key, cached.names);
    }
    _active[key] = {
      layerId: d.layerId, visible: true, meta: d.meta || null, config: cfg,
      styleLayerIds: cachedIds, buildings: cachedBuildings,
      sourceLayerName: cached.names[0], keys: cached.keys || [], probed: true,
      substringHighlight: null
    };
    if (cfg.type === 'buildings') scheduleBufferRecompute(true);
    _eventBus.emit('metatiler:layer:changed', {
      layerId: d.layerId, visible: true, added: true,
      sourceLayerName: cached.names[0], keys: cached.keys || [], probed: true,
      layerType: cfg.type
    });
    return;
  }

  // First-add: spray candidates + probe. During the probe window
  // buildings type uses generic rendering so the user sees something
  // instead of nothing. Post-probe, applyProbedInfo tears down the
  // spray and rebuilds with the typed pipeline.
  var candidates = collectCandidates(d.layerId, d.meta);
  var styleLayerIds = addStyleLayersForNames(key, candidates);
  _active[key] = {
    layerId: d.layerId, visible: true, meta: d.meta || null, config: cfg,
    styleLayerIds: styleLayerIds, buildings: null,
    sourceLayerName: null, keys: [], probed: false,
    substringHighlight: null
  };
  _eventBus.emit('metatiler:layer:changed', {
    layerId: d.layerId, visible: true, added: true, candidates: candidates,
    layerType: cfg.type
  });

  probeLayer(d.layerId).then(function (info) {
    if (!_active[key]) return;
    if (!info || info.length === 0) {
      log.warn('[metatiler] layer ' + d.layerId
        + ' probe returned no info — spray candidates remain.');
      return;
    }
    applyProbedInfo(key, info);
  }, function (err) {
    log.warn('[metatiler] layer ' + d.layerId + ' probe failed: '
      + (err && err.message));
  });
}

function onRemoveLayer(d) {
  if (!d || d.layerId == null) return;
  var key = String(d.layerId);
  var entry = _active[key];
  if (!entry) return;
  if (_selection && String(_selection.userLayerId) === key) clearSelection();
  if (entry.substringHighlight) removeStyleLayers(entry.substringHighlight.ids);
  removeStyleLayers(entry.styleLayerIds);
  removeSource(key);

  // If this was a buildings layer, tear down the local extrusion
  // source/layer too — it has no owner once the vector-tile layer
  // is gone. Also remove the buffer visualisation and the footprint
  // mask — they're tied to the same buffer state.
  if (entry.config && entry.config.type === 'buildings') {
    var map = _mapManager.getMap();
    if (map) {
      removeLocalBuildings(map);
      removeBufferVisLayers();
      removeFootprintMask();
    }
    _buffer = null;
    _sectionFootprintRings = [];
    _extractedBuildings = [];
  }

  delete _active[key];
  _eventBus.emit('metatiler:layer:changed', {
    layerId: d.layerId, visible: false, removed: true
  });
}

function onSetVisibility(d) {
  if (!d || d.layerId == null) return;
  var key = String(d.layerId);
  var entry = _active[key];
  if (!entry) return;
  var vis = !!d.visible;
  if (entry.visible === vis) return;
  entry.visible = vis;
  setVisibilityOnMap(allStyleLayerIds(entry), vis);
  if (!vis && _selection && String(_selection.userLayerId) === key) {
    clearSelection();
  }
  _eventBus.emit('metatiler:layer:changed', { layerId: d.layerId, visible: vis });
}

function onGetState() {
  var list = [];
  var keys = Object.keys(_active);
  for (var i = 0; i < keys.length; i++) {
    var e = _active[keys[i]];
    list.push({
      layerId: e.layerId, visible: e.visible,
      sourceLayerName: e.sourceLayerName, keys: e.keys,
      probed: e.probed,
      substringHighlight: e.substringHighlight ? {
        substrings: e.substringHighlight.substrings.slice(),
        color: e.substringHighlight.color
      } : null
    });
  }
  _eventBus.emit('metatiler:state', { active: list });
}

// ── Module interface ──────────────────────────────────

var metatilerModule = {
  id: 'metatiler',
  init: function (ctx) {
    _mapManager = ctx.mapManager;
    _eventBus = ctx.eventBus;
    _featureStore = ctx.featureStore || null;

    _unsubs.push(_eventBus.on('metatiler:fetch-catalog', onFetchCatalog));
    _unsubs.push(_eventBus.on('metatiler:add-layer', onAddLayer));
    _unsubs.push(_eventBus.on('metatiler:remove-layer', onRemoveLayer));
    _unsubs.push(_eventBus.on('metatiler:set-visibility', onSetVisibility));
    _unsubs.push(_eventBus.on('metatiler:highlight-substring', onHighlightSubstring));
    _unsubs.push(_eventBus.on('metatiler:get-state', onGetState));

    // Drive the lazy-load buffer from FeatureStore mutations. Burst-
    // protection is inside scheduleBufferRecompute().
    //
    // We subscribe to multiple events because different code paths
    // emit different names, and missing one means no recompute.
    var bufferEvents = [
      'features:changed',
      'feature:added', 'feature:removed', 'feature:updated',
      'features:imported', 'features:cleared',
      // Section/block specific — these fire when urban-block axes
      // are rebuilt by the solver without featureStore events.
      'section-gen:stats',
      'buffers:changed'
    ];
    for (var bi = 0; bi < bufferEvents.length; bi++) {
      (function (ev) {
        _unsubs.push(_eventBus.on(ev, function () {
          console.log('[metatiler] buffer-trigger event:', ev);
          scheduleBufferRecompute(false);
        }));
      })(bufferEvents[bi]);
    }

    // section-gen:rebuilt delivers the fresh section/tower footprint
    // rings. These are the SOURCE for inner keep-out buffer — the
    // user's built geometry, not the FeatureStore axes. We cache
    // them and re-run buffer compute so inner reflects the latest
    // footprints.
    _unsubs.push(_eventBus.on('section-gen:rebuilt', function (d) {
      _sectionFootprintRings = [];
      if (d && d.lineFootprints) {
        var lineIds = Object.keys(d.lineFootprints);
        for (var li = 0; li < lineIds.length; li++) {
          var arr = d.lineFootprints[lineIds[li]];
          if (!arr || !arr.length) continue;
          for (var fi = 0; fi < arr.length; fi++) {
            if (arr[fi] && arr[fi].ring) _sectionFootprintRings.push(arr[fi].ring);
          }
        }
      }
      console.log('[metatiler] received section-gen:rebuilt — '
        + _sectionFootprintRings.length + ' footprint ring(s) for inner buffer');
      scheduleBufferRecompute(false);
    }));

    // User-controlled radii from BufferPanel. Both fields are
    // optional on the payload; missing means "no change".
    _unsubs.push(_eventBus.on('buildings:radii:changed', function (d) {
      if (!d) return;
      var changed = false;
      if (typeof d.outerMeters === 'number' && d.outerMeters > 0
          && d.outerMeters !== _bufferRadii.outerM) {
        _bufferRadii.outerM = d.outerMeters;
        changed = true;
      }
      if (typeof d.innerMeters === 'number' && d.innerMeters >= 0
          && d.innerMeters !== _bufferRadii.innerM) {
        _bufferRadii.innerM = d.innerMeters;
        changed = true;
      }
      if (changed) {
        console.log('[metatiler] radii changed → outer=' + _bufferRadii.outerM
          + 'm, inner=' + _bufferRadii.innerM + 'm');
        scheduleBufferRecompute(true);
      }
    }));

    // Per-row buffer visualisation toggles from BufferPanel.
    // Payload: { which: 'outer' | 'inner', visible: boolean }.
    // Only affects the coloured shape overlay (Z-fighting-safe
    // fill+line), not the footprint mask and not the 3D extrusion.
    _unsubs.push(_eventBus.on('buildings:buffer-visibility:changed', function (d) {
      if (!d || (d.which !== 'outer' && d.which !== 'inner')) return;
      setBufferVisibility(d.which, !!d.visible);
      console.log('[metatiler] buffer-vis ' + d.which + ' → ' + !!d.visible);
    }));

    // Diagnostic — we need this visible in the browser console so the
    // user can report back what's actually happening. Using
    // console.log directly (not log.debug) because the Logger
    // defaults to 'info' which suppresses debug.
    console.log('[metatiler] initialized. featureStore=',
      _featureStore ? 'present' : 'MISSING',
      ', map=', _mapManager && _mapManager.getMap() ? 'present' : 'MISSING',
      ', listening to', bufferEvents.length, 'buffer-trigger events');

    if (!_featureStore) {
      console.warn('[metatiler] featureStore missing from ctx — buffer compute will never fire.');
    }

    // Catch MapLibre errors so we actually see what "Map error: N" means.
    // This is important because setFilter with a malformed within-expression
    // can throw asynchronously and be swallowed otherwise.
    var map = _mapManager && _mapManager.getMap();
    if (map) {
      map.on('error', function (e) {
        console.error('[metatiler] map error event:', e);
        if (e && e.error) {
          console.error('[metatiler] error message:', e.error.message);
          console.error('[metatiler] error stack:', e.error.stack);
        }
        if (e && e.sourceId) {
          console.error('[metatiler] error sourceId:', e.sourceId);
        }
      });
    }
  },
  destroy: function () {
    clearSelection();
    detachClickHandler();
    if (_bufferComputePending) {
      clearTimeout(_bufferComputePending);
      _bufferComputePending = null;
    }
    var keys = Object.keys(_active);
    for (var i = 0; i < keys.length; i++) {
      var e = _active[keys[i]];
      if (e.substringHighlight) removeStyleLayers(e.substringHighlight.ids);
      removeStyleLayers(e.styleLayerIds);
      removeSource(keys[i]);
    }
    _active = {};
    _buffer = null;
    for (var j = 0; j < _unsubs.length; j++) _unsubs[j]();
    _unsubs = [];
    _mapManager = null; _eventBus = null; _featureStore = null;
  }
};

export default metatilerModule;
