/**
 * buildings-buffer — compute lazy-load buffer for the buildings layer.
 *
 * Output shape
 * ------------
 *   { outer: Feature<MultiPolygon>, inner: Feature<MultiPolygon>|null }
 *
 * - outer: where 3D extrusion IS rendered. Union of per-feature outer
 *   buffers — a circle of outerRadius metres centred at each feature's
 *   centroid. Works for polygons, urban-blocks, sections and lines
 *   alike (centroid is well-defined for all of them).
 *
 * - inner: where 3D extrusion is SUPPRESSED on top of outer. Union of
 *   per-feature inner Minkowski buffers (a thickened boundary of the
 *   polygon expanded outward by innerRadius metres). Applies only to
 *   polygon-like features (Polygon, MultiPolygon, urban-block) — for
 *   lines there's no "inner" zone, the user is on the line, not inside
 *   a region.
 *
 * Caller builds the MapLibre filter as:
 *     ['all', within(outer), ['!', within(inner)]]
 *
 * Why centroid-circle outer instead of Minkowski outer
 * ----------------------------------------------------
 * Minkowski (sweep a disc along the boundary) produces a shape that
 * *follows* the polygon — good for "corridor-style" context (what's
 * within 500m of the property edge). For a 500×300m block the
 * Minkowski outer would be a 1500×1300m capsule.
 *
 * The user asked explicitly for "от центроида — круг 500м", which
 * gives a simple disc of radius 500m centred on the object's
 * geometric centre. This is a 1000×1000m area regardless of the
 * block's size, which matches intuition for "context around my site".
 *
 * Inner exclusion, by contrast, must hug the polygon boundary: a
 * 40m keep-out strip means "don't render buildings within 40m of my
 * site edge". Centroid-circle inner would leave the corners of a
 * 500×300m block unprotected.
 *
 * Performance
 * -----------
 * Outer: N circle polygons → polygon-clipping union. Fast (<5ms even
 * for dozens of features). Inner: per-feature Minkowski with
 * per-edge circle approximation, same as before. Debounce the
 * caller — one compute per burst is enough.
 */

import polygonClipping from 'polygon-clipping';
import { createProjection } from '../geo/projection.js';

// ── Geometric primitives ───────────────────────────────

function circleRingM(cx, cy, radius, segments) {
  var ring = [];
  for (var i = 0; i <= segments; i++) {
    var a = (i / segments) * Math.PI * 2;
    ring.push([cx + radius * Math.cos(a), cy + radius * Math.sin(a)]);
  }
  return ring;
}

function circlesAlongEdgeM(p1, p2, radius, spacing, segments) {
  var dx = p2[0] - p1[0];
  var dy = p2[1] - p1[1];
  var len = Math.sqrt(dx * dx + dy * dy);
  var n = len < 1e-6 ? 1 : Math.max(1, Math.ceil(len / spacing));
  var rings = [];
  for (var i = 0; i <= n; i++) {
    var t = n === 0 ? 0 : i / n;
    rings.push(circleRingM(p1[0] + dx * t, p1[1] + dy * t, radius, segments));
  }
  return rings;
}

// ── Feature extraction ────────────────────────────────

/**
 * Normalise features into polygons (for inner Minkowski) and all
 * features with their centroid (for outer circles). Multi* geometries
 * are treated as multiple independent shapes — one centroid each.
 *
 * Returned entry shape:
 *   { kind: 'polygon', ringLL: [[lng,lat], ...], centroid: {lng, lat} }
 *   { kind: 'line',    path:   [[lng,lat], ...], centroid: {lng, lat} }
 */
function extractFeatures(features) {
  var out = [];
  for (var i = 0; i < features.length; i++) {
    var f = features[i];
    if (!f || !f.geometry) continue;
    var g = f.geometry;
    if (g.type === 'Polygon' && g.coordinates && g.coordinates[0] && g.coordinates[0].length >= 3) {
      out.push({ kind: 'polygon', ringLL: g.coordinates[0], centroid: polygonCentroidLL(g.coordinates[0]) });
    } else if (g.type === 'MultiPolygon' && g.coordinates) {
      for (var j = 0; j < g.coordinates.length; j++) {
        var poly = g.coordinates[j];
        if (poly && poly[0] && poly[0].length >= 3) {
          out.push({ kind: 'polygon', ringLL: poly[0], centroid: polygonCentroidLL(poly[0]) });
        }
      }
    } else if (g.type === 'LineString' && g.coordinates && g.coordinates.length >= 2) {
      out.push({ kind: 'line', path: g.coordinates, centroid: lineCentroidLL(g.coordinates) });
    } else if (g.type === 'MultiLineString' && g.coordinates) {
      for (var k = 0; k < g.coordinates.length; k++) {
        var line = g.coordinates[k];
        if (line && line.length >= 2) {
          out.push({ kind: 'line', path: line, centroid: lineCentroidLL(line) });
        }
      }
    }
  }
  return out;
}

/**
 * Vertex-average centroid for a polygon ring (skipping the closing
 * duplicate if present). Not area-weighted — for the lazy-load
 * anchor the difference is irrelevant, and the vertex mean is
 * robust to degenerate rings.
 */
function polygonCentroidLL(ringLL) {
  var n = ringLL.length;
  // Skip the closing-duplicate vertex, if the ring is closed.
  if (n > 1
      && ringLL[0][0] === ringLL[n - 1][0]
      && ringLL[0][1] === ringLL[n - 1][1]) n -= 1;
  var sumLng = 0, sumLat = 0;
  for (var i = 0; i < n; i++) {
    sumLng += ringLL[i][0]; sumLat += ringLL[i][1];
  }
  return { lng: sumLng / n, lat: sumLat / n };
}

function lineCentroidLL(pathLL) {
  var sumLng = 0, sumLat = 0;
  for (var i = 0; i < pathLL.length; i++) {
    sumLng += pathLL[i][0]; sumLat += pathLL[i][1];
  }
  return { lng: sumLng / pathLL.length, lat: sumLat / pathLL.length };
}

function collectiveCenter(entries) {
  if (!entries.length) return null;
  var sumLng = 0, sumLat = 0;
  for (var i = 0; i < entries.length; i++) {
    sumLng += entries[i].centroid.lng;
    sumLat += entries[i].centroid.lat;
  }
  return { lng: sumLng / entries.length, lat: sumLat / entries.length };
}

// ── Ring conversion helpers ───────────────────────────

function ringMultiPolygonToLL(multiM, proj) {
  var multiLL = [];
  for (var i = 0; i < multiM.length; i++) {
    var poly = multiM[i];
    var polyLL = [];
    for (var j = 0; j < poly.length; j++) {
      var ring = poly[j];
      if (!ring || ring.length < 4) continue;
      var ringLL = [];
      for (var k = 0; k < ring.length; k++) {
        ringLL.push(proj.toLngLat(ring[k][0], ring[k][1]));
      }
      polyLL.push(ringLL);
    }
    if (polyLL.length > 0) multiLL.push(polyLL);
  }
  return multiLL;
}

// Wrap a MultiPolygon coordinate tree as a GeoJSON Geometry object
// (NOT a Feature). MapLibre's `within` expression spec accepts
// Polygon/MultiPolygon/Feature/FeatureCollection — Feature is listed
// but in practice has been reported not to work with vector tile
// sources in some MapLibre versions, while bare Geometry does.
//
// Feature wrapping was tried in patch9/10 and reproducibly failed to
// filter extrusion features on the user's MapLibre v3 build even
// though buffer compute was correct. Reverting to bare Geometry.
function toMultiPolygonGeometry(coords) {
  if (!coords || coords.length === 0) return null;
  return { type: 'MultiPolygon', coordinates: coords };
}

// ── Outer buffer (centroid circles) ───────────────────

/**
 * Union of circles centred at each feature's centroid.
 */
function buildOuterBuffer(entries, proj, radiusM, segments) {
  if (!entries.length) return null;
  var shapes = [];
  for (var i = 0; i < entries.length; i++) {
    var c = entries[i].centroid;
    var cm = proj.toMeters(c.lng, c.lat);
    shapes.push([circleRingM(cm[0], cm[1], radiusM, segments)]);
  }
  var unioned = polygonClipping.union.apply(polygonClipping, shapes);
  return ringMultiPolygonToLL(unioned, proj);
}

// ── Inner buffer (Minkowski around polygon boundaries) ──

/**
 * Union of Minkowski buffers around polygon boundaries. Lines are
 * skipped — the inner keep-out only makes sense for areal objects.
 * Returns null if there are no polygon entries.
 */
function buildInnerBuffer(entries, proj, radiusM, segments) {
  var shapes = [];
  var spacing = radiusM * 0.8;

  for (var i = 0; i < entries.length; i++) {
    if (entries[i].kind !== 'polygon') continue;
    var ringLL = entries[i].ringLL;

    var n = ringLL.length;
    if (n > 1
        && ringLL[0][0] === ringLL[n - 1][0]
        && ringLL[0][1] === ringLL[n - 1][1]) n -= 1;
    var ringM = [];
    for (var j = 0; j < n; j++) {
      ringM.push(proj.toMeters(ringLL[j][0], ringLL[j][1]));
    }
    if (ringM.length < 3) continue;

    // Polygon interior — fully contained inside the inner keep-out.
    var closed = ringM.slice();
    closed.push(ringM[0]);
    shapes.push([closed]);

    // Circles along every edge — gives the Minkowski sum.
    for (var e = 0; e < ringM.length; e++) {
      var p1 = ringM[e];
      var p2 = ringM[(e + 1) % ringM.length];
      var cs = circlesAlongEdgeM(p1, p2, radiusM, spacing, segments);
      for (var c = 0; c < cs.length; c++) shapes.push([cs[c]]);
    }
  }

  if (shapes.length === 0) return null;
  var unioned = polygonClipping.union.apply(polygonClipping, shapes);
  return ringMultiPolygonToLL(unioned, proj);
}

// ── Public entry point ────────────────────────────────

/**
 * Compute outer and inner buffers with independent feature inputs.
 *
 * @param {Object} opts
 * @param {Array<Object>} opts.outerFeatures  features defining WHERE
 *   extrusion is allowed. Each contributes its centroid as a circle
 *   centre. Typical: section-axis, tower-axis, urban-block,
 *   user polygons.
 * @param {Array<Object>} opts.innerFeatures  features defining WHERE
 *   extrusion is forbidden (keep-out). Each contributes a Minkowski
 *   buffer around its boundary. Typical: section-footprint,
 *   tower-footprint.
 * @param {number} opts.outerRadiusM    e.g. 500
 * @param {number} [opts.innerRadiusM]  e.g. 40, 0 to disable
 * @param {number} [opts.segments]      circle resolution (default 32)
 * @returns {{ outer: Geometry|null, inner: Geometry|null }}
 */
export function computeBuildingsBufferSplit(opts) {
  opts = opts || {};
  var outerFeatures = opts.outerFeatures || [];
  var innerFeatures = opts.innerFeatures || [];
  var outerRadiusM = opts.outerRadiusM || 500;
  var innerRadiusM = opts.innerRadiusM || 0;
  var segments = opts.segments || 32;

  var outerEntries = extractFeatures(outerFeatures);
  var innerEntries = extractFeatures(innerFeatures);

  if (outerEntries.length === 0) return { outer: null, inner: null };

  // Use centre from outer + inner combined so the projection origin
  // sits roughly in the middle of everything we're buffering.
  var combined = outerEntries.concat(innerEntries);
  var center = collectiveCenter(combined);
  if (!center) return { outer: null, inner: null };
  var proj = createProjection(center.lng, center.lat);

  var outerLL = buildOuterBuffer(outerEntries, proj, outerRadiusM, segments);
  var innerLL = null;
  if (innerRadiusM > 0 && innerEntries.length > 0) {
    innerLL = buildInnerBuffer(innerEntries, proj, innerRadiusM, segments);
  }

  return {
    outer: toMultiPolygonGeometry(outerLL),
    inner: toMultiPolygonGeometry(innerLL)
  };
}

/**
 * Legacy single-input API — kept for compatibility. Use
 * computeBuildingsBufferSplit when outer and inner have distinct
 * feature sources (which is the normal case — outer comes from
 * axes, inner comes from section/tower footprints).
 *
 * @param {Array<Object>} features  GeoJSON features (from featureStore.toArray())
 * @param {Object} opts
 * @param {number} opts.outerRadiusM  buffer radius around centroid (e.g. 500)
 * @param {number} [opts.innerRadiusM] inner Minkowski keep-out radius (e.g. 40).
 *   Pass 0 or falsy to disable.
 * @param {number} [opts.segments]    circle polygon resolution (default 32)
 * @returns {{ outer: Geometry|null, inner: Geometry|null }}
 */
export function computeBuildingsBuffer(features, opts) {
  opts = opts || {};
  return computeBuildingsBufferSplit({
    outerFeatures: features,
    innerFeatures: features,  // same source for both — legacy behaviour
    outerRadiusM: opts.outerRadiusM,
    innerRadiusM: opts.innerRadiusM,
    segments: opts.segments
  });
}
