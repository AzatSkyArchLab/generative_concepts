/**
 * green-areas — compute "green courtyard" polygons remaining inside the
 * site after subtracting buffered sections and buffered towers.
 *
 * Algorithm:
 *   1. For each section polygon: Minkowski-expand by sectionBuffer (9.2 m).
 *   2. For each tower polygon:   Minkowski-expand by towerBuffer (14 m).
 *   3. Union all buffered shapes → "occupied + influence zone".
 *   4. polygon_outer_ring \ (occupied union) → green areas (multipolygon).
 *
 * Coordinates are internal-frame meters (canvas y-down). The caller is
 * responsible for converting the result back to lng/lat via proj.
 */

import polygonClipping from 'polygon-clipping';

// Minkowski sum of a polygon with a disk: approximate as union of the
// polygon itself + disks along every edge at regular intervals + disks
// at every vertex. Each disk = `segments`-sided polygon. Granularity:
// disks every `radius * 0.3` metres along an edge; 12 segments per disk
// (good visual smoothness, reasonable cost).
// Round to 4 decimals (~0.1 mm precision) to suppress polygon-clipping's
// "Unable to find segment in SweepLine tree" errors that come from two
// almost-coincident vertices differing only in their 14th decimal.
function r4(v) { return Math.round(v * 10000) / 10000; }

function circlePoly(cx, cy, radius, segments) {
  var pts = [];
  for (var i = 0; i < segments; i++) {
    var ang = (i / segments) * 2 * Math.PI;
    pts.push([r4(cx + radius * Math.cos(ang)), r4(cy + radius * Math.sin(ang))]);
  }
  pts.push([pts[0][0], pts[0][1]]);
  return pts;
}

function bufferRingShapes(ringXY, radius, segments) {
  // ringXY is an array of {x,y}. Returns an array of polygon-clipping
  // "polygons" ([[ring]]) — feed straight into polygonClipping.union.
  var shapes = [];
  // Original polygon — close the ring for polygon-clipping (expects
  // first === last vertex on each ring).
  var orig = ringXY.map(function (p) { return [r4(p.x), r4(p.y)]; });
  orig.push([r4(ringXY[0].x), r4(ringXY[0].y)]);
  shapes.push([orig]);
  // Disks at every vertex.
  for (var i = 0; i < ringXY.length; i++) {
    shapes.push([circlePoly(ringXY[i].x, ringXY[i].y, radius, segments)]);
  }
  // Disks along every edge at regular intervals.
  var spacing = Math.max(1, radius * 0.3);
  for (var j = 0; j < ringXY.length; j++) {
    var a = ringXY[j], b = ringXY[(j + 1) % ringXY.length];
    var dx = b.x - a.x, dy = b.y - a.y;
    var L = Math.hypot(dx, dy);
    if (L < 1e-6) continue;
    var n = Math.max(1, Math.floor(L / spacing));
    for (var k = 1; k < n; k++) {
      var t = k / n;
      shapes.push([circlePoly(a.x + dx * t, a.y + dy * t, radius, segments)]);
    }
  }
  return shapes;
}

/**
 * Compute green areas inside the polygon after subtracting buffered
 * sections + buffered towers.
 *
 * @param {Array<{x,y}>} polygonRing — outer ring of the site (internal XY).
 * @param {Array<Array<{x,y}>>} sectionRings — every section polygon ring.
 * @param {Array<Array<{x,y}>>} towerRings — every tower footprint ring.
 * @param {number} sectionBuffer — Minkowski radius for sections (metres).
 * @param {number} towerBuffer — Minkowski radius for towers (metres).
 * @returns {Array<Array<Array<[number,number]>>>} multi-polygon: list of
 *   polygons, each = list of rings. First ring of each polygon is outer,
 *   subsequent rings are holes. Coordinates are internal-frame meters.
 */
export function computeGreenAreas(polygonRing, sectionRings, towerRings, sectionBuffer, towerBuffer) {
  if (!polygonRing || polygonRing.length < 3) return [];
  var SEG = 12;   // disk smoothness

  // Gather buffered-shape polygons (each shape is a list of rings —
  // polygon-clipping treats the array as a "polygon", and we union all
  // of them together).
  var allShapes = [];
  for (var i = 0; i < sectionRings.length; i++) {
    if (!sectionRings[i] || sectionRings[i].length < 3) continue;
    var shapesS = bufferRingShapes(sectionRings[i], sectionBuffer, SEG);
    for (var ss = 0; ss < shapesS.length; ss++) allShapes.push(shapesS[ss]);
  }
  for (var i2 = 0; i2 < towerRings.length; i2++) {
    if (!towerRings[i2] || towerRings[i2].length < 3) continue;
    var shapesT = bufferRingShapes(towerRings[i2], towerBuffer, SEG);
    for (var st = 0; st < shapesT.length; st++) allShapes.push(shapesT[st]);
  }

  // Site polygon as polygon-clipping polygon (rounded for numerical
  // stability — same rationale as bufferRingShapes).
  var siteRing = polygonRing.map(function (p) { return [r4(p.x), r4(p.y)]; });
  siteRing.push([r4(polygonRing[0].x), r4(polygonRing[0].y)]);
  var sitePoly = [siteRing];

  if (allShapes.length === 0) {
    // Nothing to subtract — whole site is green.
    return [sitePoly];
  }

  // Union of all buffered shapes.
  var occUnion;
  try {
    occUnion = polygonClipping.union.apply(polygonClipping, allShapes);
  } catch (err) {
    if (typeof console !== 'undefined') console.warn('[green-areas] union failed:', err && err.message);
    return [];
  }
  if (!occUnion || occUnion.length === 0) return [sitePoly];

  // Difference: site \ occupied.
  var green;
  try {
    green = polygonClipping.difference([sitePoly], occUnion);
  } catch (err2) {
    if (typeof console !== 'undefined') console.warn('[green-areas] difference failed:', err2 && err2.message);
    return [];
  }
  return green || [];
}
