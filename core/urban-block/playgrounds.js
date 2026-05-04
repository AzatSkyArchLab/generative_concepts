/**
 * Playgrounds — compute ring-based playground / sports zones around
 * sections inside an urban block.
 *
 * Three concentric rings around each section footprint:
 *   A: 12..20m — toddler playground (no active play)
 *   B: 20..40m — active children playground
 *   C: 40..300m — sports + adult leisure
 *
 * Rings A and B must lie inside the block's green zone (open space
 * after subtracting footprints and fire buffers). Ring C uses the
 * full block polygon without a green-zone mask — sports grounds
 * can sit on paved surfaces.
 *
 * All polygons are unioned across sections before intersecting
 * with the green zone / block so overlapping buffers between
 * neighbouring sections aren't double-counted.
 *
 * Pure math. Inputs/outputs in local meter coords.
 */

import polygonClipping from 'polygon-clipping';
import { roundedBufferPolygon } from '../buffers/Buffers.js';

// ── Ring radii (meters) — hardcoded for now, will become config later ──

export var PG_RADII = {
  A_inner: 12,
  A_outer: 20,
  B_inner: 20,
  B_outer: 40,
  C_inner: 40,
  C_outer: 300
};

// ── Per-person norms (m² / person) ─────────────────────────

export var PG_NORMS = {
  child: 0.5,   // toddler + active (sum of A + B)
  sport: 0.1    // sport + adult leisure (C)
};

// ── Area helpers ───────────────────────────────────────────

function ringArea(ring) {
  var n = ring.length;
  if (n < 3) return 0;
  var closed = (ring[n - 1][0] === ring[0][0] && ring[n - 1][1] === ring[0][1]);
  var stop = closed ? n - 1 : n;
  var a = 0;
  for (var i = 0; i < stop; i++) {
    var j = (i + 1) % stop;
    a += ring[i][0] * ring[j][1] - ring[j][0] * ring[i][1];
  }
  return Math.abs(a) / 2;
}

export function multiPolygonArea(mp) {
  if (!mp) return 0;
  var total = 0;
  for (var i = 0; i < mp.length; i++) {
    var poly = mp[i];
    if (!poly || poly.length === 0) continue;
    var outer = ringArea(poly[0]);
    for (var h = 1; h < poly.length; h++) outer -= ringArea(poly[h]);
    if (outer > 0) total += outer;
  }
  return total;
}

// ── polygon-clipping helpers ───────────────────────────────

function toPcPoly(polyM) { return [polyM]; }

function unionMany(polys) {
  if (!polys || polys.length === 0) return [];
  if (polys.length === 1) return [toPcPoly(polys[0])];
  var args = [];
  for (var i = 0; i < polys.length; i++) args.push([toPcPoly(polys[i])]);
  try {
    return polygonClipping.union.apply(polygonClipping, args);
  } catch (err) {
    return [];
  }
}

function difference(aMp, bMp) {
  if (!aMp || aMp.length === 0) return [];
  if (!bMp || bMp.length === 0) return aMp;
  try {
    return polygonClipping.difference(aMp, bMp);
  } catch (err) {
    return aMp;
  }
}

function intersection(aMp, bMp) {
  if (!aMp || aMp.length === 0) return [];
  if (!bMp || bMp.length === 0) return [];
  try {
    return polygonClipping.intersection(aMp, bMp);
  } catch (err) {
    return [];
  }
}

function unionMp(aMp, bMp) {
  if (!aMp || aMp.length === 0) return bMp || [];
  if (!bMp || bMp.length === 0) return aMp;
  try {
    return polygonClipping.union(aMp, bMp);
  } catch (err) {
    return aMp;
  }
}

// ── Ring builder ───────────────────────────────────────────

/**
 * Build a MultiPolygon = union of (outer_buffer \ inner_buffer) for
 * every section footprint in `fpMs`.
 *
 * CRITICAL: the ring is built PER SECTION first, then the per-section
 * rings are unioned. Doing it the other way around — `union(outer) \
 * union(inner)` — silently wipes out a ring zone whenever two sections
 * sit closer than (outerR + innerR) apart, because section A's inner
 * buffer leaks into section B's outer ring and the difference removes
 * it. Per-section assembly keeps each annulus intact regardless of
 * neighbour spacing.
 */
function buildRingUnion(fpMs, innerR, outerR) {
  if (!fpMs || fpMs.length === 0) return [];
  var perSectionRings = [];
  for (var i = 0; i < fpMs.length; i++) {
    var fp = fpMs[i];
    if (!fp || fp.length < 3) continue;
    var outer = roundedBufferPolygon(fp, outerR, 10);
    var ringMp;
    if (innerR > 0) {
      var inner = roundedBufferPolygon(fp, innerR, 10);
      ringMp = difference([toPcPoly(outer)], [toPcPoly(inner)]);
    } else {
      ringMp = [toPcPoly(outer)];
    }
    if (ringMp && ringMp.length > 0) {
      perSectionRings.push(ringMp);
    }
  }
  if (perSectionRings.length === 0) return [];
  if (perSectionRings.length === 1) return perSectionRings[0];

  // Union of MultiPolygons — polygonClipping.union takes geometries
  // as variadic args in polygon-clipping format.
  try {
    return polygonClipping.union.apply(polygonClipping, perSectionRings);
  } catch (err) {
    return perSectionRings[0];
  }
}

// ── Public API ────────────────────────────────────────────

/**
 * Compute playground rings for one urban block.
 *
 * @param {Array<[number,number]>} blockPolyM — block outline (meters)
 * @param {Array<Array<[number,number]>>} fpMs — section footprints (meters)
 * @param {Array} greenZoneMp — block's green zone in polygon-clipping
 *   MultiPolygon format (output of computeGreenZone().multiPolygon)
 * @param {Object} [radiiOverride] — e.g. {A_outer: 25} overrides one value
 * @returns {{
 *   ringA: {mp, area},
 *   ringB: {mp, area},
 *   ringC: {mp, area}
 * }}
 *   — mp is a polygon-clipping MultiPolygon (empty array if no geometry);
 *   area is in square metres.
 */
export function computeBlockPlaygrounds(blockPolyM, fpMs, greenZoneMp, radiiOverride) {
  var R = radiiOverride ? Object.assign({}, PG_RADII, radiiOverride) : PG_RADII;

  var empty = { mp: [], area: 0 };
  if (!blockPolyM || blockPolyM.length < 3) {
    return { ringA: empty, ringB: empty, ringC: empty };
  }
  if (!fpMs || fpMs.length === 0) {
    return { ringA: empty, ringB: empty, ringC: empty };
  }

  var blockMp = [toPcPoly(blockPolyM)];

  // Build raw ring unions (outer_buffer \ inner_buffer per section,
  // unioned across sections).
  var rawA = buildRingUnion(fpMs, R.A_inner, R.A_outer);
  var rawB = buildRingUnion(fpMs, R.B_inner, R.B_outer);
  var rawC = buildRingUnion(fpMs, R.C_inner, R.C_outer);

  // Child rings require intersection with green zone AND block.
  // Sports ring (C) intersects with block only — paved areas allowed.
  var gz = greenZoneMp || [];

  // Mask rings FIRST, then partition. Partitioning on raw rings
  // (before masking) causes holes in less-intimate rings wherever
  // a more-intimate ring exists off-map: e.g. rawA can extend into a
  // fire buffer that is cut out of gz, so ringA is invisible there,
  // yet `rawC \ rawA` would still drill a hole into ringC. Masking
  // first ensures partition only subtracts visible geometry.
  var maskedA = intersection(intersection(rawA, gz), blockMp);
  var maskedB = intersection(intersection(rawB, gz), blockMp);
  var maskedC = intersection(rawC, blockMp);

  // Priority partition A > B > C on masked rings.
  //   - A wins over B wins over C.
  //   - Each point belongs to the ring closest to any section, among
  //     rings that are actually visible at that point.
  var ringA_final = maskedA;
  var ringB_final = difference(maskedB, ringA_final);
  var ringC_final = difference(maskedC, unionMp(ringA_final, ringB_final));

  return {
    ringA: { mp: ringA_final, area: multiPolygonArea(ringA_final) },
    ringB: { mp: ringB_final, area: multiPolygonArea(ringB_final) },
    ringC: { mp: ringC_final, area: multiPolygonArea(ringC_final) }
  };
}

/**
 * Feasibility check against norms.
 *
 * @param {Object} areas — {areaA, areaB, areaC}
 * @param {number} population — people in the block
 * @returns {Object} — {areaChild, areaSport, requiredChild, requiredSport,
 *   feasibleChild, feasibleSport, childDeficit, sportDeficit}
 */
export function evaluateFeasibility(areas, population) {
  var areaChild = (areas.areaA || 0) + (areas.areaB || 0);
  var areaSport = areas.areaC || 0;
  var requiredChild = population * PG_NORMS.child;
  var requiredSport = population * PG_NORMS.sport;
  return {
    areaChild: areaChild,
    areaSport: areaSport,
    requiredChild: requiredChild,
    requiredSport: requiredSport,
    feasibleChild: areaChild >= requiredChild,
    feasibleSport: areaSport >= requiredSport,
    childDeficit: Math.max(0, requiredChild - areaChild),
    sportDeficit: Math.max(0, requiredSport - areaSport)
  };
}
