/**
 * Local-source buildings extrusion.
 *
 * Rationale:
 *   Rendering 3D buildings directly off the vector tile source with
 *   a `within()` filter and a MapLibre height expression did not
 *   work in our MapLibre build — footprints rendered but extrusion
 *   stayed invisible, even after exhaustive diagnostics (bypass,
 *   bare-Geometry `within`, flattened filter, to-number fallback).
 *
 *   Instead we:
 *     1. `querySourceFeatures` everything matching OBJ_TYPE='Здание'
 *        in the current tiles (the footprint layers ensure tiles for
 *        the viewport are loaded),
 *     2. merge per-tile polygon fragments by UNOM so a single
 *        building that straddles a tile boundary becomes one feature,
 *     3. filter by centroid-in-outer AND NOT centroid-in-inner,
 *     4. compute floor→height in plain JS (no expression-level
 *        error modes), storing the value in `properties._height_m`,
 *     5. push the resulting FeatureCollection into a local GeoJSON
 *        source + `fill-extrusion` layer.
 *
 *   This sidesteps the extrusion rendering bug entirely — local
 *   GeoJSON sources have a different code path in MapLibre and have
 *   been consistently working for every other layer in the project.
 */

import polygonClipping from 'polygon-clipping';

export var LOCAL_SRC_ID  = 'metatiler-local-bldg';
export var LOCAL_EXT_ID  = 'metatiler-local-bldg-ext';
export var LOCAL_LINE_ID = 'metatiler-local-bldg-line';

// ── Geometry helpers ──────────────────────────────────────

function bboxOfCoords(coords, out) {
  // coords: ring = [[lng,lat],...]
  for (var i = 0; i < coords.length; i++) {
    var x = coords[i][0], y = coords[i][1];
    if (x < out[0]) out[0] = x;
    if (y < out[1]) out[1] = y;
    if (x > out[2]) out[2] = x;
    if (y > out[3]) out[3] = y;
  }
}

function bboxOfGeometry(g) {
  var out = [Infinity, Infinity, -Infinity, -Infinity];
  if (!g) return out;
  if (g.type === 'Polygon') {
    for (var i = 0; i < g.coordinates.length; i++) {
      bboxOfCoords(g.coordinates[i], out);
    }
  } else if (g.type === 'MultiPolygon') {
    for (var j = 0; j < g.coordinates.length; j++) {
      for (var k = 0; k < g.coordinates[j].length; k++) {
        bboxOfCoords(g.coordinates[j][k], out);
      }
    }
  }
  return out;
}

function bboxesOverlap(a, b) {
  return !(a[2] < b[0] || a[0] > b[2] || a[3] < b[1] || a[1] > b[3]);
}

/**
 * Centroid of a Polygon or MultiPolygon — vertex-mean of the outer
 * ring(s). Good enough for "is this building inside the buffer?"
 * decisions; not used as a visual anchor.
 */
function centroidOfGeometry(g) {
  if (!g) return null;
  var sx = 0, sy = 0, n = 0;
  function addRing(ring) {
    var stop = ring.length;
    if (stop > 1
        && ring[0][0] === ring[stop - 1][0]
        && ring[0][1] === ring[stop - 1][1]) stop -= 1;
    for (var i = 0; i < stop; i++) {
      sx += ring[i][0]; sy += ring[i][1]; n++;
    }
  }
  if (g.type === 'Polygon') {
    if (g.coordinates && g.coordinates[0]) addRing(g.coordinates[0]);
  } else if (g.type === 'MultiPolygon') {
    for (var p = 0; p < g.coordinates.length; p++) {
      if (g.coordinates[p] && g.coordinates[p][0]) addRing(g.coordinates[p][0]);
    }
  }
  if (n === 0) return null;
  return [sx / n, sy / n];
}

/**
 * Ray-cast point-in-polygon for a single outer ring.
 * ring: [[x,y], ...]  point: [x,y]
 */
function pointInRing(pt, ring) {
  var x = pt[0], y = pt[1];
  var inside = false;
  var stop = ring.length;
  if (stop > 1
      && ring[0][0] === ring[stop - 1][0]
      && ring[0][1] === ring[stop - 1][1]) stop -= 1;
  for (var i = 0, j = stop - 1; i < stop; j = i++) {
    var xi = ring[i][0], yi = ring[i][1];
    var xj = ring[j][0], yj = ring[j][1];
    var intersect = ((yi > y) !== (yj > y))
      && (x < (xj - xi) * (y - yi) / (yj - yi + 1e-300) + xi);
    if (intersect) inside = !inside;
  }
  return inside;
}

/**
 * Point-in-geometry for Polygon / MultiPolygon, respecting holes.
 * Returns true if the point is in some outer ring AND not in any
 * inner ring of that same polygon piece.
 */
function pointInGeometry(pt, g) {
  if (!g) return false;
  function pointInPoly(poly) {
    if (poly.length === 0) return false;
    if (!pointInRing(pt, poly[0])) return false;
    for (var h = 1; h < poly.length; h++) {
      if (pointInRing(pt, poly[h])) return false; // in a hole
    }
    return true;
  }
  if (g.type === 'Polygon') {
    return pointInPoly(g.coordinates);
  }
  if (g.type === 'MultiPolygon') {
    for (var i = 0; i < g.coordinates.length; i++) {
      if (pointInPoly(g.coordinates[i])) return true;
    }
    return false;
  }
  return false;
}

// ── Feature merging ───────────────────────────────────────

/**
 * Group features by a key field (typically UNOM) and merge each
 * group's geometry via polygon-clipping union. Features without a
 * primary key fall back to a composite key (ADDRESS + FLOOR + TYPE)
 * — good enough to glue two cross-tile halves of the same building
 * when UNOM is missing, without wrongly merging two different
 * buildings that happen to share an address.
 *
 * MVT clips polygons at tile boundaries; a single building on the
 * edge of a tile arrives as two separate features with the same
 * UNOM. Extruding the unmerged pair produces a visible seam — and
 * for cross-tile cases where UNOM is null on both halves, the
 * composite fallback glues them back together.
 *
 * Return shape: { features: [...], stats: { byKey, byFallback,
 * keyless, mergedGroups } }.
 */
export function mergeByKey(features, keyField, fallbackFields) {
  var groups = Object.create(null);        // keyed by primary key
  var fbGroups = Object.create(null);      // keyed by composite fallback
  var keyless = [];
  var byKeyCount = 0;
  var byFbCount = 0;
  var fbFields = fallbackFields || ['ADDRESS'];

  function compositeKey(props) {
    var parts = [];
    for (var i = 0; i < fbFields.length; i++) {
      var v = props && props[fbFields[i]];
      if (v === null || v === undefined || v === '') return null;
      parts.push(String(v));
    }
    return parts.length ? parts.join('|') : null;
  }

  for (var i = 0; i < features.length; i++) {
    var f = features[i];
    var props = f.properties || {};
    var k = props[keyField];
    if (k !== undefined && k !== null && k !== '') {
      var kk = String(k);
      if (!groups[kk]) { groups[kk] = []; byKeyCount++; }
      groups[kk].push(f);
      continue;
    }
    var fbk = compositeKey(props);
    if (fbk) {
      if (!fbGroups[fbk]) { fbGroups[fbk] = []; byFbCount++; }
      fbGroups[fbk].push(f);
      continue;
    }
    keyless.push(f);
  }

  function unionGroup(grp) {
    if (grp.length === 1) return grp[0];
    var shapes = [];
    for (var si = 0; si < grp.length; si++) {
      var gg = grp[si].geometry;
      if (!gg) continue;
      if (gg.type === 'Polygon') shapes.push([gg.coordinates]);
      else if (gg.type === 'MultiPolygon') shapes.push(gg.coordinates);
    }
    if (shapes.length === 0) return null;
    if (shapes.length === 1) {
      // Single usable geometry — no union needed.
      return {
        type: 'Feature',
        properties: grp[0].properties,
        geometry: shapes[0][0]
          ? { type: 'Polygon', coordinates: shapes[0][0] }
          : { type: 'MultiPolygon', coordinates: shapes[0] }
      };
    }
    var unioned;
    try {
      unioned = polygonClipping.union.apply(polygonClipping, shapes);
    } catch (err) {
      console.warn('[buildings-local] union failed — keeping first fragment. err='
        + (err && err.message));
      return grp[0];
    }
    return {
      type: 'Feature',
      properties: grp[0].properties,
      geometry: { type: 'MultiPolygon', coordinates: unioned }
    };
  }

  var merged = [];
  var mergedGroupsCount = 0;

  var keys = Object.keys(groups);
  for (var gi = 0; gi < keys.length; gi++) {
    var grp = groups[keys[gi]];
    if (grp.length > 1) mergedGroupsCount++;
    var res = unionGroup(grp);
    if (res) merged.push(res);
  }

  var fbKeys = Object.keys(fbGroups);
  for (var fi = 0; fi < fbKeys.length; fi++) {
    var fgrp = fbGroups[fbKeys[fi]];
    if (fgrp.length > 1) mergedGroupsCount++;
    var fres = unionGroup(fgrp);
    if (fres) merged.push(fres);
  }

  // Keyless features pass through unchanged — rare (usually < 1%).
  for (var ki = 0; ki < keyless.length; ki++) merged.push(keyless[ki]);

  return {
    features: merged,
    stats: {
      byKey: byKeyCount,
      byFallback: byFbCount,
      keyless: keyless.length,
      mergedGroups: mergedGroupsCount
    }
  };
}

// ── Buffer filter ──────────────────────────────────────
//
// Two predicates per building:
//   outer: centroid-in-outer
//     Loose — we want the building "mostly inside" the outer zone;
//     a centroid test gives that naturally without false rejects
//     for buildings that brush the 500m boundary with a corner.
//
//   inner: polygon-intersects-inner (NOT centroid-in-inner)
//     Strict — any overlap at all excludes the building. Centroid-
//     only test missed large buildings whose centroid was outside
//     the 40m keep-out but whose footprint still crossed into it.
//     polygon-clipping.intersection is ~1ms per building, so we
//     gate it behind a bbox-overlap check to keep the average cost
//     below 50µs.

function geometryIntersectsInner(buildingGeom, innerGeom) {
  // buildingGeom is Polygon or MultiPolygon, innerGeom is MultiPolygon.
  // Represent both as the MultiPolygon-shaped coordinate trees
  // polygon-clipping expects.
  var a;
  if (buildingGeom.type === 'Polygon') a = [buildingGeom.coordinates];
  else if (buildingGeom.type === 'MultiPolygon') a = buildingGeom.coordinates;
  else return false;
  var b = innerGeom.coordinates;
  try {
    var inter = polygonClipping.intersection(a, b);
    return inter && inter.length > 0;
  } catch (e) {
    // Degenerate geometry sometimes trips polygon-clipping. Fall back
    // to a conservative "any vertex of the building in inner" test.
    return anyVertexInside(buildingGeom, innerGeom);
  }
}

function anyVertexInside(buildingGeom, innerGeom) {
  function check(ring) {
    var stop = ring.length;
    if (stop > 1
        && ring[0][0] === ring[stop - 1][0]
        && ring[0][1] === ring[stop - 1][1]) stop -= 1;
    for (var i = 0; i < stop; i++) {
      if (pointInGeometry(ring[i], innerGeom)) return true;
    }
    return false;
  }
  if (buildingGeom.type === 'Polygon') {
    return check(buildingGeom.coordinates[0] || []);
  }
  if (buildingGeom.type === 'MultiPolygon') {
    for (var i = 0; i < buildingGeom.coordinates.length; i++) {
      var piece = buildingGeom.coordinates[i];
      if (piece && piece[0] && check(piece[0])) return true;
    }
  }
  return false;
}

export function filterByBuffer(features, outer, inner) {
  if (!outer) return [];
  var outerBBox = bboxOfGeometry(outer);
  var innerBBox = inner ? bboxOfGeometry(inner) : null;

  var kept = [];
  var rejectedByInner = 0;
  for (var i = 0; i < features.length; i++) {
    var f = features[i];
    var fbb = bboxOfGeometry(f.geometry);
    if (!bboxesOverlap(fbb, outerBBox)) continue;

    var c = centroidOfGeometry(f.geometry);
    if (!c) continue;
    if (!pointInGeometry(c, outer)) continue;

    // Inner collision — reject if the BUILDING FOOTPRINT overlaps
    // the keep-out zone at all (not just its centroid). This is the
    // behaviour the user expects: buildings that clearly collide
    // with the 40m safety ring around their sections must disappear.
    if (inner && innerBBox && bboxesOverlap(fbb, innerBBox)) {
      if (geometryIntersectsInner(f.geometry, inner)) {
        rejectedByInner++;
        continue;
      }
    }
    kept.push(f);
  }
  // Expose rejection count via a module-level slot so the caller
  // can log it. Cheaper than changing the return signature.
  filterByBuffer._lastRejectedByInner = rejectedByInner;
  return kept;
}
filterByBuffer._lastRejectedByInner = 0;

// ── Height computation (plain JS, no MapLibre expression) ─────

/**
 * Per-feature height in metres. Keep the logic simple and defensive:
 *   - any non-finite / non-numeric FLOOR falls back to defaultFloors
 *   - negative / zero floors clamp to 1
 *   - residential (TYPE == residentialValue): ground 4m + upper 3m
 *   - other: uniform 4m per floor
 *
 * Result is stored in feature.properties._height_m so the paint
 * expression becomes a trivial `['get', '_height_m']` — no evaluation
 * errors possible.
 */
export function computeHeight(feature, cfg) {
  var p = feature.properties || {};
  var raw = p[cfg.heightField];
  var floors;
  if (raw === null || raw === undefined || raw === '') {
    floors = cfg.defaultFloors;
  } else {
    var n = Number(raw);
    floors = isFinite(n) ? n : cfg.defaultFloors;
  }
  if (floors < 1) floors = 1;

  if (p[cfg.categoryField] === cfg.residentialValue) {
    return cfg.residential.groundFloor
         + (floors - 1) * cfg.residential.upperFloor;
  }
  return cfg.other.anyFloor * floors;
}

// ── Main entry point ──────────────────────────────────────

/**
 * Extract buildings from a vector tile source that fall inside the
 * lazy-load buffer, merge fragments, compute heights, and push the
 * result into a local GeoJSON source + fill-extrusion layer.
 *
 * Options:
 *   map           — MapLibre Map
 *   vectorSid     — id of the vector-tile source (e.g. 'metatiler-src-104')
 *   sourceLayer   — source-layer name (e.g. 'main')
 *   outer         — MultiPolygon Geometry (bare, no Feature wrapper)
 *   inner         — MultiPolygon Geometry or null
 *   keyField      — property name for fragment merging ('UNOM')
 *   objTypeField  — property name for the type filter ('OBJ_TYPE')
 *   objTypeValue  — value selecting buildings ('Здание')
 *   categoryField — property name distinguishing residential ('TYPE')
 *   residentialValue — value for residential ('Жилой фонд')
 *   heightField   — property name for floor count ('FLOOR')
 *   defaultFloors — fallback floor count (1)
 *   residential   — { groundFloor, upperFloor }
 *   other         — { anyFloor }
 *   colors        — { residential:{fill,outline}, other:{fill,outline} }
 *
 * Returns stats: { extracted, merged, kept, mergedInputCount }.
 */
export function extractAndExtrudeBuildings(opts) {
  var map = opts.map;
  if (!map) return null;

  // 1. Pull matching features from loaded tiles.
  //    querySourceFeatures returns features only from tiles currently
  //    in memory. The footprint layers (always on) pre-load tiles for
  //    the viewport; zones outside the viewport are not guaranteed.
  //    For an outer radius of 500m at zoom ≥14 the footprint viewport
  //    usually covers it, but we log a warning if the outer extends
  //    outside current map bounds.
  var t0 = (typeof performance !== 'undefined') ? performance.now() : Date.now();

  var raw;
  try {
    raw = map.querySourceFeatures(opts.vectorSid, {
      sourceLayer: opts.sourceLayer,
      filter: ['all',
        ['==', ['get', opts.objTypeField], opts.objTypeValue],
        ['==', ['geometry-type'], 'Polygon']
      ]
    });
  } catch (err) {
    console.error('[buildings-local] querySourceFeatures failed:', err);
    return null;
  }

  // 2. Cheap bbox pre-filter — drops features clearly outside the
  //    outer buffer before we pay for centroid / point-in-polygon.
  var outerBBox = bboxOfGeometry(opts.outer);
  var preFiltered = [];
  for (var i = 0; i < raw.length; i++) {
    var g = raw[i].geometry;
    if (!g) continue;
    var bb = bboxOfGeometry(g);
    if (bboxesOverlap(bb, outerBBox)) preFiltered.push(raw[i]);
  }

  // 3. Merge fragments. Primary key is UNOM; for fragments with
  //    missing UNOM we fall back to ADDRESS+FLOOR+OBJ_TYPE composite.
  //    This glues cross-tile halves back together even when the
  //    unique id is null on both.
  var mergeResult = mergeByKey(preFiltered, opts.keyField,
    ['ADDRESS', opts.heightField, opts.objTypeField]);
  var merged = mergeResult.features;

  // 4. Final buffer test (centroid-in-outer AND NOT centroid-in-inner).
  var kept = filterByBuffer(merged, opts.outer, opts.inner);

  // 5. Compute per-feature heights in JS. Write into a NEW feature
  //    object (don't mutate MVT features — they may be shared across
  //    tile queries).
  var heightCfg = {
    heightField: opts.heightField,
    defaultFloors: opts.defaultFloors,
    categoryField: opts.categoryField,
    residentialValue: opts.residentialValue,
    residential: opts.residential,
    other: opts.other
  };
  var out = [];
  for (var k = 0; k < kept.length; k++) {
    var src = kept[k];
    var h = computeHeight(src, heightCfg);
    // Copy properties and add _height_m. Only the few we need for
    // paint + popup — no reason to drag the whole attribute set.
    var p = src.properties || {};
    var newProps = {
      _height_m: h,
      UNOM: p[opts.keyField],
      TYPE: p[opts.categoryField],
      FLOOR: p[opts.heightField],
      OBJ_TYPE: p[opts.objTypeField]
    };
    if (p.ADDRESS) newProps.ADDRESS = p.ADDRESS;
    if (p.SIMPLE_ADDRESS) newProps.SIMPLE_ADDRESS = p.SIMPLE_ADDRESS;
    if (p.USE) newProps.USE = p.USE;

    out.push({
      type: 'Feature',
      properties: newProps,
      geometry: src.geometry
    });
  }

  // 6. Push to the map.
  applyToMap(map, out, opts);

  var t1 = (typeof performance !== 'undefined') ? performance.now() : Date.now();
  var rejectedByInner = filterByBuffer._lastRejectedByInner || 0;
  console.log('[buildings-local] extract+extrude done in ' + (t1 - t0).toFixed(0) + 'ms'
    + ' | raw=' + raw.length
    + ', preFiltered=' + preFiltered.length
    + ', merged=' + merged.length
    + ' (byKey=' + mergeResult.stats.byKey
    + ', byFallback=' + mergeResult.stats.byFallback
    + ', keyless=' + mergeResult.stats.keyless
    + ', groupsGlued=' + mergeResult.stats.mergedGroups + ')'
    + ', kept=' + kept.length
    + ' (rejectedByInner=' + rejectedByInner + ')');

  return {
    extracted: raw.length,
    preFiltered: preFiltered.length,
    merged: merged.length,
    kept: kept.length,
    rejectedByInner: rejectedByInner,
    mergeStats: mergeResult.stats,
    // Full feature list (with _height_m), for downstream consumers
    // that need the actual geometry — e.g. insolation building the
    // raycast mesh. Each feature has: geometry (Polygon/MultiPolygon
    // in lngLat), properties._height_m.
    features: out
  };
}

// ── Source / layer lifecycle ──────────────────────────────

function applyToMap(map, features, opts) {
  var fc = { type: 'FeatureCollection', features: features };
  var colors = opts.colors;

  if (!map.getSource(LOCAL_SRC_ID)) {
    map.addSource(LOCAL_SRC_ID, { type: 'geojson', data: fc });
    // Colour picker: residential vs other, per feature.
    var colorExpr = ['case',
      ['==', ['get', 'TYPE'], opts.residentialValue],
      colors.residential.fill,
      colors.other.fill
    ];
    map.addLayer({
      id: LOCAL_EXT_ID,
      type: 'fill-extrusion',
      source: LOCAL_SRC_ID,
      paint: {
        'fill-extrusion-color': colorExpr,
        'fill-extrusion-height': ['get', '_height_m'],
        'fill-extrusion-base': 0,
        'fill-extrusion-opacity': 0.85
      }
    });
  } else {
    map.getSource(LOCAL_SRC_ID).setData(fc);
  }
}

export function removeLocalBuildings(map) {
  if (!map) return;
  if (map.getLayer(LOCAL_LINE_ID)) map.removeLayer(LOCAL_LINE_ID);
  if (map.getLayer(LOCAL_EXT_ID))  map.removeLayer(LOCAL_EXT_ID);
  if (map.getSource(LOCAL_SRC_ID)) map.removeSource(LOCAL_SRC_ID);
}

export function clearLocalBuildings(map) {
  if (!map) return;
  var src = map.getSource(LOCAL_SRC_ID);
  if (src) src.setData({ type: 'FeatureCollection', features: [] });
}

// ── Context mesh for insolation raycasting ─────────────────────
//
// Insolation casts sun rays against section/tower collision boxes
// (small prism meshes built by the insol module itself). We want
// the surrounding real buildings from layer #104 to shadow those
// rays too — equivalent to Rhino's "mesh join" turning N meshes
// into one and casting rays against the union.
//
// This file builds only the RAW triangle data (positions + indices
// in metres, projected by the caller). The insolation module wraps
// it in a THREE.BufferGeometry + Mesh; we keep three.js out of
// this module so buildings-local stays framework-decoupled.
//
// Per building polygon:
//   - walls: N quads (2 triangles each) extruded from z=0 to
//     z=height
//   - top cap: ear-clipping triangulation of the outer ring
//   - holes (interior rings) are skipped — for realistic rendering
//     of courtyards we'd earcut with holes, but the raycast only
//     cares about the occluding envelope, so filled-in courtyards
//     are a harmless over-approximation (a ray blocked by a filled
//     courtyard would also be blocked by its walls in real life).

/**
 * Signed 2D area — >0 for CCW, <0 for CW. Used to normalise ring
 * orientation so ear-clipping works regardless of source winding.
 */
function ringSignedArea(ring) {
  var a = 0;
  for (var i = 0, n = ring.length; i < n; i++) {
    var j = (i + 1) % n;
    a += ring[i][0] * ring[j][1] - ring[j][0] * ring[i][1];
  }
  return a * 0.5;
}

/**
 * Is triangle (a,b,c) CCW?
 */
function triArea2(a, b, c) {
  return (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
}

function pointInTri(p, a, b, c) {
  var d1 = triArea2(p, a, b);
  var d2 = triArea2(p, b, c);
  var d3 = triArea2(p, c, a);
  var neg = (d1 < 0) || (d2 < 0) || (d3 < 0);
  var pos = (d1 > 0) || (d2 > 0) || (d3 > 0);
  return !(neg && pos);
}

/**
 * Ear-clipping triangulation for a simple polygon (no holes).
 * Input: ring of [[x,y], ...], open (last != first). Output: flat
 * array of vertex indices into ring, 3 per triangle.
 *
 * O(n²) worst case; for building footprints n is ~4–40, so this is
 * microsecond-scale. Not robust against self-intersections but MVT
 * buildings are well-behaved polygons.
 */
function earclipSimple(ring) {
  var n = ring.length;
  if (n < 3) return [];
  // Normalise to CCW so ears are detected as positive-area triangles.
  var pts = ring;
  if (ringSignedArea(ring) < 0) {
    pts = [];
    for (var i = n - 1; i >= 0; i--) pts.push(ring[i]);
  }
  var idx = [];
  var indices = [];
  for (var k = 0; k < n; k++) indices.push(k);

  var guard = 0;
  while (indices.length > 3 && guard < 10000) {
    guard++;
    var found = false;
    for (var vi = 0; vi < indices.length; vi++) {
      var prev = indices[(vi + indices.length - 1) % indices.length];
      var curr = indices[vi];
      var next = indices[(vi + 1) % indices.length];
      var a = pts[prev], b = pts[curr], c = pts[next];
      // Convex vertex test (CCW polygon → ear is CCW triangle).
      if (triArea2(a, b, c) <= 0) continue;
      // No other vertex of polygon lies strictly inside triangle.
      var bad = false;
      for (var oi = 0; oi < indices.length; oi++) {
        var id = indices[oi];
        if (id === prev || id === curr || id === next) continue;
        if (pointInTri(pts[id], a, b, c)) { bad = true; break; }
      }
      if (bad) continue;
      idx.push(prev, curr, next);
      indices.splice(vi, 1);
      found = true;
      break;
    }
    if (!found) break; // Degenerate — give up and return what we have.
  }
  if (indices.length === 3) {
    idx.push(indices[0], indices[1], indices[2]);
  }

  // If we reversed the ring, map indices back to original ring order.
  if (pts !== ring) {
    var mapped = [];
    for (var mi = 0; mi < idx.length; mi++) {
      mapped.push(n - 1 - idx[mi]);
    }
    return mapped;
  }
  return idx;
}

/**
 * Given projected ring (metres) and height, append walls + top cap
 * triangles to the global positions + indices buffers.
 *
 * `posList` and `idxList` are growing JS arrays; the caller converts
 * to typed arrays at the end.
 */
function appendExtrusion(ring, heightM, posList, idxList) {
  if (!ring || ring.length < 3) return;
  // Drop closing-duplicate vertex if present.
  var ringOpen = ring;
  var n = ring.length;
  if (n > 1
      && ring[0][0] === ring[n - 1][0]
      && ring[0][1] === ring[n - 1][1]) {
    ringOpen = ring.slice(0, n - 1);
    n = n - 1;
  }
  if (n < 3) return;

  var base = posList.length / 3;

  // Bottom vertices (z=0), then top vertices (z=height).
  for (var i = 0; i < n; i++) {
    posList.push(ringOpen[i][0], ringOpen[i][1], 0);
  }
  for (var j = 0; j < n; j++) {
    posList.push(ringOpen[j][0], ringOpen[j][1], heightM);
  }

  // Walls — for each edge i → i+1, 2 triangles forming a quad.
  //   bottom i, bottom i+1, top i+1   (tri 1)
  //   bottom i, top i+1, top i        (tri 2)
  for (var k = 0; k < n; k++) {
    var k2 = (k + 1) % n;
    var b0 = base + k, b1 = base + k2;
    var t0 = base + n + k, t1 = base + n + k2;
    idxList.push(b0, b1, t1);
    idxList.push(b0, t1, t0);
  }

  // Top cap — triangulate the top ring.
  var tri = earclipSimple(ringOpen);
  for (var t = 0; t < tri.length; t++) {
    idxList.push(base + n + tri[t]);
  }
}

/**
 * Build merged raw mesh data from extracted building features.
 *
 * @param {Array<Object>} features  each has geometry (Polygon or
 *   MultiPolygon in lngLat) and properties._height_m
 * @param {Object} proj  createProjection-style object with
 *   toMeters(lng, lat) → [x, y]
 *
 * @returns {{ positions: Float32Array, indices: Uint32Array,
 *             vertexCount: number, triCount: number } | null}
 *   null if no buildings produced any geometry (empty input, all
 *   zero-height, all degenerate rings).
 */
export function buildContextMeshData(features, proj) {
  if (!features || features.length === 0) return null;
  var pos = [];
  var idx = [];

  for (var i = 0; i < features.length; i++) {
    var f = features[i];
    if (!f || !f.geometry) continue;
    var h = f.properties && f.properties._height_m;
    if (!(h > 0)) continue;
    var g = f.geometry;

    function projectRing(ring) {
      var out = [];
      for (var k = 0; k < ring.length; k++) {
        var m = proj.toMeters(ring[k][0], ring[k][1]);
        out.push([m[0], m[1]]);
      }
      return out;
    }

    if (g.type === 'Polygon') {
      if (g.coordinates && g.coordinates[0]) {
        appendExtrusion(projectRing(g.coordinates[0]), h, pos, idx);
      }
    } else if (g.type === 'MultiPolygon') {
      for (var p = 0; p < g.coordinates.length; p++) {
        var piece = g.coordinates[p];
        if (piece && piece[0]) {
          appendExtrusion(projectRing(piece[0]), h, pos, idx);
        }
      }
    }
  }

  if (pos.length === 0) return null;
  // Uint32 index buffer — #104 can easily produce >65k vertices in
  // a 300m radius with dense neighbourhoods.
  return {
    positions: new Float32Array(pos),
    indices: new Uint32Array(idx),
    vertexCount: pos.length / 3,
    triCount: idx.length / 3
  };
}
