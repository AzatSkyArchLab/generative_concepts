/**
 * UrbanBlockOverlays — compute all plan overlay geometries.
 *
 * Ported from React prototype: road ring, connectors, graph,
 * trash pad, playground zones, section fire buffers.
 *
 * All coordinates in meters (local projection).
 */

import { vSub, vAdd, vSc, vLen, vNorm, vDot, vCross } from '../geo/vec2.js';

function ptIn(pt, poly) {
  var ins = false;
  for (var i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    var yi = poly[i][1], yj = poly[j][1];
    if (((yi > pt[1]) !== (yj > pt[1])) &&
      (pt[0] < (poly[j][0] - poly[i][0]) * (pt[1] - yi) / (yj - yi) + poly[i][0])) ins = !ins;
  }
  return ins;
}

function pCen(p) {
  var cx = 0, cy = 0;
  for (var i = 0; i < p.length; i++) { cx += p[i][0]; cy += p[i][1]; }
  return [cx / p.length, cy / p.length];
}

function segSeg(p1, p2, p3, p4) {
  var d1 = vSub(p2, p1), d2 = vSub(p4, p3), cr = vCross(d1, d2);
  if (Math.abs(cr) < 1e-10) return null;
  var d3 = vSub(p3, p1);
  var t = vCross(d3, d2) / cr, u = vCross(d3, d1) / cr;
  if (t >= 0 && t <= 1 && u >= 0 && u <= 1) return vAdd(p1, vSc(d1, t));
  return null;
}

function allHits(sa, sb, poly) {
  var pts = [];
  for (var i = 0; i < poly.length; i++) {
    var pt = segSeg(sa, sb, poly[i], poly[(i + 1) % poly.length]);
    if (pt) pts.push(pt);
  }
  return pts;
}

// ── Polygon inward offset ─────────────────────────────

function offsetPolygon(poly, dist) {
  var n = poly.length;
  if (n < 3) return [];
  var pts = [];
  for (var i = 0; i < n; i++) {
    var prev = poly[(i - 1 + n) % n], cur = poly[i], next = poly[(i + 1) % n];
    var d1 = vSub(cur, prev), l1 = vLen(d1);
    var d2 = vSub(next, cur), l2 = vLen(d2);
    if (l1 < 1e-9 || l2 < 1e-9) { pts.push(cur.slice()); continue; }
    var n1 = [-d1[1] / l1, d1[0] / l1];
    var n2 = [-d2[1] / l2, d2[0] / l2];
    var bis = vAdd(n1, n2);
    var bisLen = vLen(bis);
    if (bisLen < 1e-9) { pts.push(vAdd(cur, vSc(n1, dist))); continue; }
    bis = vSc(bis, 1 / bisLen);
    var sinHalf = vDot(n1, bis);
    if (Math.abs(sinHalf) < 0.15) sinHalf = sinHalf > 0 ? 0.15 : -0.15;
    var offsetDist = dist / sinHalf;
    if (Math.abs(offsetDist) > dist * 3) offsetDist = (offsetDist > 0 ? 1 : -1) * dist * 3;
    var off = vAdd(cur, vSc(bis, offsetDist));
    if (!ptIn(off, poly)) off = vAdd(cur, vSc(bis, dist));
    pts.push(off);
  }
  return pts;
}

// ── OBB ───────────────────────────────────────────────

function computeOBB(poly) {
  var bestAngle = 0, bestArea = Infinity, bestW = 0, bestH = 0, bestCx = 0, bestCy = 0;
  for (var i = 0; i < poly.length; i++) {
    var a = poly[i], b = poly[(i + 1) % poly.length];
    var angle = Math.atan2(b[1] - a[1], b[0] - a[0]);
    var cosA = Math.cos(-angle), sinA = Math.sin(-angle);
    var mnX = Infinity, mnY = Infinity, mxX = -Infinity, mxY = -Infinity;
    for (var j = 0; j < poly.length; j++) {
      var rx = poly[j][0] * cosA - poly[j][1] * sinA;
      var ry = poly[j][0] * sinA + poly[j][1] * cosA;
      if (rx < mnX) mnX = rx; if (ry < mnY) mnY = ry;
      if (rx > mxX) mxX = rx; if (ry > mxY) mxY = ry;
    }
    var w = mxX - mnX, h = mxY - mnY, area = w * h;
    if (area < bestArea) {
      bestArea = area; bestAngle = angle; bestW = w; bestH = h;
      var rcx = (mnX + mxX) / 2, rcy = (mnY + mxY) / 2;
      var cosB = Math.cos(angle), sinB = Math.sin(angle);
      bestCx = rcx * cosB - rcy * sinB; bestCy = rcx * sinB + rcy * cosB;
    }
  }
  var cosA2 = Math.cos(bestAngle), sinA2 = Math.sin(bestAngle);
  var d1 = [cosA2, sinA2], d2 = [-sinA2, cosA2];
  if (bestW < bestH) { var tmp = d1; d1 = d2; d2 = tmp; var tw = bestW; bestW = bestH; bestH = tw; }
  return { cx: bestCx, cy: bestCy, w: bestW, h: bestH, d1: d1, d2: d2 };
}

// ── Main overlay computation ──────────────────────────

export function computeOverlays(polyM, axes, params) {
  var sw = params.sw || 18;
  var fb = params.fire || 14;

  // Section group fire buffers + road buffers
  var secFire = [];
  var roadBuf = [];
  var trashInner = [];
  var trashOuter = [];
  var playBuf12 = [], playBuf20 = [], playBuf40 = [];

  for (var wi = 0; wi < axes.length; wi++) {
    var we = axes[wi];
    if (!we.secs || !we.secs.length || !we.oi || we.removed) continue;

    // Group consecutive non-gap sections
    var groups = []; var cur = null;
    for (var si = 0; si < we.secs.length; si++) {
      if (we.secs[si].gap) { cur = null; continue; }
      if (!cur) { cur = [we.secs[si]]; groups.push(cur); } else cur.push(we.secs[si]);
    }

    var od = we.oi.od;
    var nod = vSc(od, -1);

    for (var gi = 0; gi < groups.length; gi++) {
      var g = groups[gi];
      // First and last section positions
      var pos0 = 0;
      for (var k = 0; k < we.secs.length; k++) {
        if (we.secs[k] === g[0]) break;
        pos0 += we.secs[k].l;
      }
      var posEnd = pos0;
      for (var k2 = 0; k2 < g.length; k2++) posEnd += g[k2].l;

      var axDir = vNorm(vSub(we.end, we.start));
      var negAx = vSc(axDir, -1);
      var s0 = vAdd(we.start, vSc(axDir, pos0));
      var s1 = vAdd(we.start, vSc(axDir, posEnd));
      var s0o = vAdd(s0, vSc(od, sw));
      var s1o = vAdd(s1, vSc(od, sw));

      // secFire: fire buffer around section group
      secFire.push([
        vAdd(s0, vSc(nod, fb)), vAdd(s1, vSc(nod, fb)),
        vAdd(s1o, vSc(od, fb)), vAdd(s0o, vSc(od, fb))
      ]);

      // Helper: buffer D meters all sides
      var mkBuf = function (D) {
        return [
          vAdd(vAdd(s0, vSc(nod, D)), vSc(negAx, D)),
          vAdd(vAdd(s1, vSc(nod, D)), vSc(axDir, D)),
          vAdd(vAdd(s1o, vSc(od, D)), vSc(axDir, D)),
          vAdd(vAdd(s0o, vSc(od, D)), vSc(negAx, D))
        ];
      };
      roadBuf.push(mkBuf(14));
      trashInner.push(mkBuf(20));
      trashOuter.push(mkBuf(100));
      playBuf12.push(mkBuf(12));
      playBuf20.push(mkBuf(20));
      playBuf40.push(mkBuf(40));
    }
  }

  // Road ring
  var roadCenter = sw + fb - 3;
  var roadOuter = offsetPolygon(polyM, roadCenter - 3);
  var roadInner = offsetPolygon(polyM, roadCenter + 3);

  // Connectors: roadBuf edges × polygon × roadInner
  var connectors = [];
  for (var fri = 0; fri < roadBuf.length; fri++) {
    var fr = roadBuf[fri];
    var bufCen = vSc(vAdd(vAdd(fr[0], fr[1]), vAdd(fr[2], fr[3])), 0.25);
    for (var fei = 0; fei < 4; fei++) {
      var ea = fr[fei], eb = fr[(fei + 1) % 4];
      var eDir = vNorm(vSub(eb, ea));
      var extA = vAdd(ea, vSc(eDir, -50));
      var extB = vAdd(eb, vSc(eDir, 50));
      var ph = allHits(extA, extB, polyM);
      var ih = (roadInner.length >= 3) ? allHits(extA, extB, roadInner) : [];
      for (var phi = 0; phi < ph.length; phi++) {
        var ppt = ph[phi];
        var bestI = null, bestD = Infinity;
        for (var ihi = 0; ihi < ih.length; ihi++) {
          var dd = vLen(vSub(ih[ihi], ppt));
          if (dd > 0.5 && dd < bestD) { bestD = dd; bestI = ih[ihi]; }
        }
        if (bestI && bestD < 80) {
          var ext5 = vNorm(vSub(bestI, ppt));
          connectors.push({ from: ppt, to: vAdd(bestI, vSc(ext5, 5)), bufCen: bufCen });
        }
      }
    }
  }

  // Gap connectors
  for (var gwi = 0; gwi < axes.length; gwi++) {
    var gwe = axes[gwi];
    if (!gwe.secs || !gwe.oi || gwe.removed) continue;
    for (var gsi = 0; gsi < gwe.secs.length; gsi++) {
      var gs = gwe.secs[gsi];
      if (!gs.gap) continue;
      var pos = 0;
      for (var k3 = 0; k3 < gsi; k3++) pos += gwe.secs[k3].l;
      var gMidT = pos + gs.l / 2;
      var axD = vNorm(vSub(gwe.end, gwe.start));
      var gMid = vAdd(vAdd(gwe.start, vSc(axD, gMidT)), vSc(gwe.oi.od, sw / 2));
      var gNod = vSc(gwe.oi.od, -1);
      var gFar = vAdd(gMid, vSc(gNod, 200));
      var gPH = allHits(gMid, gFar, polyM);
      var gIH = (roadInner.length >= 3) ? allHits(gMid, gFar, roadInner) : [];
      if (gPH.length > 0 && gIH.length > 0) {
        var gBP = gPH[0], gBI = gIH[0];
        for (var g4 = 1; g4 < gPH.length; g4++) if (vLen(vSub(gPH[g4], gMid)) < vLen(vSub(gBP, gMid))) gBP = gPH[g4];
        for (var g5 = 1; g5 < gIH.length; g5++) if (vLen(vSub(gIH[g5], gMid)) < vLen(vSub(gBI, gMid))) gBI = gIH[g5];
        connectors.push({ from: gBP, to: vAdd(gBI, vSc(vNorm(vSub(gBI, gBP)), 5)), bufCen: vAdd(gMid, vSc(gNod, 20)) });
      }
    }
  }

  // Filter collision: remove connectors crossing sections
  var allSecRects = [];
  for (var fsi = 0; fsi < axes.length; fsi++) {
    if (!axes[fsi].secs) continue;
    for (var fsj = 0; fsj < axes[fsi].secs.length; fsj++) {
      var fs = axes[fsi].secs[fsj];
      if (fs.gap) continue;
      // Build rect from axis + section position
      var ax = axes[fsi];
      if (!ax.oi) continue;
      var axd = vNorm(vSub(ax.end, ax.start));
      var spos = 0;
      for (var fsk = 0; fsk < fsj; fsk++) spos += ax.secs[fsk].l;
      var r0 = vAdd(ax.start, vSc(axd, spos));
      var r1 = vAdd(ax.start, vSc(axd, spos + fs.l));
      allSecRects.push([r0, r1, vAdd(r1, vSc(ax.oi.od, sw)), vAdd(r0, vSc(ax.oi.od, sw))]);
    }
  }
  var filtered = [];
  for (var fci = 0; fci < connectors.length; fci++) {
    var fc = connectors[fci];
    var collides = false;
    for (var rci = 0; rci < allSecRects.length && !collides; rci++) {
      var q = allSecRects[rci];
      for (var qi = 0; qi < 4; qi++) {
        if (segSeg(fc.from, fc.to, q[qi], q[(qi + 1) % 4])) { collides = true; break; }
      }
    }
    if (!collides) filtered.push(fc);
  }
  connectors = filtered;

  // Road graph: ring + junction insertion
  var graphNodes = [];
  var graphEdges = [];
  if (roadInner.length >= 3) {
    var ringPts = roadInner.slice();
    var connInserts = [];
    for (var gci = 0; gci < connectors.length; gci++) {
      var cn = connectors[gci];
      var dir3 = vNorm(vSub(cn.to, cn.from));
      var bestT3 = Infinity, bestPt3 = null, bestEdge3 = -1;
      for (var rei = 0; rei < ringPts.length; rei++) {
        var ra = ringPts[rei], rb = ringPts[(rei + 1) % ringPts.length];
        var d2 = vSub(rb, ra), d3 = vSub(ra, cn.from);
        var cr = vCross(dir3, d2);
        if (Math.abs(cr) < 1e-10) continue;
        var t = vCross(d3, d2) / cr, u = vCross(d3, dir3) / cr;
        if (t > 0.1 && u >= 0 && u <= 1 && t < bestT3) {
          bestT3 = t; bestPt3 = vAdd(cn.from, vSc(dir3, t)); bestEdge3 = rei;
        }
      }
      if (bestPt3 && bestEdge3 >= 0) {
        var eA = ringPts[bestEdge3], eB = ringPts[(bestEdge3 + 1) % ringPts.length];
        var eDr = vSub(eB, eA); var eL = vLen(eDr);
        var tOnEdge = eL > 0.01 ? vDot(vSub(bestPt3, eA), eDr) / (eL * eL) : 0;
        connInserts.push({ edgeIdx: bestEdge3, tOnEdge: tOnEdge, pt: bestPt3, connIdx: gci });
      }
    }
    var insertsByEdge = {};
    for (var ii = 0; ii < connInserts.length; ii++) {
      var ci = connInserts[ii];
      if (!insertsByEdge[ci.edgeIdx]) insertsByEdge[ci.edgeIdx] = [];
      insertsByEdge[ci.edgeIdx].push(ci);
    }
    for (var key in insertsByEdge) insertsByEdge[key].sort(function (a, b) { return a.tOnEdge - b.tOnEdge; });

    var expandedRing = [];
    for (var eri = 0; eri < ringPts.length; eri++) {
      expandedRing.push({ pt: ringPts[eri], type: 'ring', connIdx: -1 });
      var ins = insertsByEdge[eri];
      if (ins) { for (var ini = 0; ini < ins.length; ini++) expandedRing.push({ pt: ins[ini].pt, type: 'junction', connIdx: ins[ini].connIdx }); }
    }
    for (var eni = 0; eni < expandedRing.length; eni++) graphNodes.push(expandedRing[eni]);
    for (var eei = 0; eei < expandedRing.length; eei++) graphEdges.push({ a: eei, b: (eei + 1) % expandedRing.length, type: 'ring' });
    for (var gci2 = 0; gci2 < connectors.length; gci2++) {
      var jIdx = -1;
      for (var ji = 0; ji < expandedRing.length; ji++) { if (expandedRing[ji].connIdx === gci2) { jIdx = ji; break; } }
      if (jIdx < 0) continue;
      var bIdx = graphNodes.length;
      graphNodes.push({ pt: connectors[gci2].from, type: 'boundary' });
      graphEdges.push({ a: bIdx, b: jIdx, type: 'conn' });
    }
  }

  // Trash pad 6×3m — multi-pass placement (strict → relaxed → anywhere)
  var trashPad = null;
  if (trashOuter.length > 0) {
    var obb = computeOBB(polyM);
    var padW = 6, padH = 3;
    var cen = pCen(polyM);
    var step = 6;
    var hW = obb.w / 2 + 10, hH = obb.h / 2 + 10;

    function segHitsQuad(sa, sb, quad) {
      for (var qi = 0; qi < 4; qi++) {
        if (segSeg(sa, sb, quad[qi], quad[(qi + 1) % 4])) return true;
      }
      return false;
    }
    function tryPlaceTrash(pass) {
      var best = null, bestDist2 = -1;
      for (var gx = -hW; gx <= hW; gx += step) {
        for (var gy = -hH; gy <= hH; gy += step) {
          var cx = obb.cx + obb.d1[0] * gx + obb.d2[0] * gy;
          var cy = obb.cy + obb.d1[1] * gx + obb.d2[1] * gy;
          var center = [cx, cy];
          var corners = [
            vAdd(center, vAdd(vSc(obb.d1, -padW / 2), vSc(obb.d2, -padH / 2))),
            vAdd(center, vAdd(vSc(obb.d1, padW / 2), vSc(obb.d2, -padH / 2))),
            vAdd(center, vAdd(vSc(obb.d1, padW / 2), vSc(obb.d2, padH / 2))),
            vAdd(center, vAdd(vSc(obb.d1, -padW / 2), vSc(obb.d2, padH / 2)))
          ];
          var allIn = true;
          for (var ci2 = 0; ci2 < 4; ci2++) { if (!ptIn(corners[ci2], polyM)) { allIn = false; break; } }
          if (!allIn) continue;
          // Pass 0,1: outside roadInner (edge zone, not yard)
          if (pass < 2 && roadInner.length >= 3) {
            var anyInsideRI = false;
            for (var ci3 = 0; ci3 < 4; ci3++) { if (ptIn(corners[ci3], roadInner)) { anyInsideRI = true; break; } }
            if (anyInsideRI) continue;
          }
          // Not intersecting connectors
          var hitsConn = false;
          for (var cci = 0; cci < connectors.length && !hitsConn; cci++) {
            var ccn = connectors[cci];
            var ccdx = ccn.to[0] - ccn.from[0], ccdy = ccn.to[1] - ccn.from[1];
            var cclen = Math.sqrt(ccdx * ccdx + ccdy * ccdy); if (cclen < 0.5) continue;
            var cpAx = -ccdy / cclen, cpAy = ccdx / cclen;
            var cmid = [(ccn.from[0] + ccn.to[0]) / 2, (ccn.from[1] + ccn.to[1]) / 2];
            var cbc = ccn.bufCen || cmid;
            var ctA = [cmid[0] + cpAx * 3, cmid[1] + cpAy * 3];
            var ctB = [cmid[0] - cpAx * 3, cmid[1] - cpAy * 3];
            var cti = (vLen(vSub(ctA, cbc)) < vLen(vSub(ctB, cbc))) ? 1 : -1;
            var cipx = cpAx * cti * 6, cipy = cpAy * cti * 6;
            var connQuad = [ccn.from, ccn.to, [ccn.to[0] + cipx, ccn.to[1] + cipy], [ccn.from[0] + cipx, ccn.from[1] + cipy]];
            for (var pe = 0; pe < 4 && !hitsConn; pe++) {
              if (segHitsQuad(corners[pe], corners[(pe + 1) % 4], connQuad)) hitsConn = true;
            }
            if (!hitsConn && ptIn(center, connQuad)) hitsConn = true;
          }
          if (hitsConn) continue;
          // Pass 0: strict trashZone 20-100m
          if (pass === 0) {
            var inO = false;
            for (var toi = 0; toi < trashOuter.length; toi++) { if (ptIn(center, trashOuter[toi])) { inO = true; break; } }
            if (!inO) continue;
            var inI = false;
            for (var tii = 0; tii < trashInner.length; tii++) { if (ptIn(center, trashInner[tii])) { inI = true; break; } }
            if (inI) continue;
          }
          // Not intersecting secFire
          var hitsSec = false;
          for (var sfi = 0; sfi < secFire.length && !hitsSec; sfi++) {
            for (var ci4 = 0; ci4 < 4; ci4++) { if (ptIn(corners[ci4], secFire[sfi])) { hitsSec = true; break; } }
          }
          if (hitsSec) continue;
          var dist = vLen(vSub(center, cen));
          if (dist > bestDist2) { bestDist2 = dist; best = { center: center, rect: corners }; }
        }
      }
      return best;
    }
    trashPad = tryPlaceTrash(0);
    if (!trashPad) trashPad = tryPlaceTrash(1);
    if (!trashPad) trashPad = tryPlaceTrash(2);
  }

  // Pedestrian paths: section inner edges → nearest point on roadInner
  var pedPaths = [];
  if (roadInner.length >= 3) {
    function nearestOnPoly(pt, ring) {
      var bestPt = null, bestD = Infinity;
      for (var i = 0; i < ring.length; i++) {
        var a = ring[i], b = ring[(i + 1) % ring.length];
        var ab = vSub(b, a), ap = vSub(pt, a);
        var len2 = vDot(ab, ab);
        var t = len2 > 1e-9 ? Math.max(0, Math.min(1, vDot(ap, ab) / len2)) : 0;
        var proj = vAdd(a, vSc(ab, t));
        var d = vLen(vSub(proj, pt));
        if (d < bestD) { bestD = d; bestPt = proj; }
      }
      return bestPt;
    }
    for (var pwi = 0; pwi < axes.length; pwi++) {
      var pwe = axes[pwi];
      if (!pwe.secs || !pwe.oi || pwe.removed) continue;
      for (var psi = 0; psi < pwe.secs.length; psi++) {
        var ps = pwe.secs[psi];
        if (ps.gap || !ps.start || !ps.end) continue;
        // Inner edge: offset side (rect[2]↔rect[3])
        var oS = vAdd(ps.start, vSc(pwe.oi.od, sw));
        var oE = vAdd(ps.end, vSc(pwe.oi.od, sw));
        var innerMid = vSc(vAdd(oS, oE), 0.5);
        var nearest = nearestOnPoly(innerMid, roadInner);
        if (!nearest) continue;
        var pathLen = vLen(vSub(nearest, innerMid));
        if (pathLen < 0.5 || pathLen > 100) continue;
        pedPaths.push({ from: innerMid, to: nearest });
      }
    }
    // Add ped edges to graph
    for (var pgi = 0; pgi < pedPaths.length; pgi++) {
      var pp = pedPaths[pgi];
      var secNodeIdx = graphNodes.length;
      graphNodes.push({ pt: pp.from, type: 'sec' });
      var roadNodeIdx = graphNodes.length;
      graphNodes.push({ pt: pp.to, type: 'pedRoad' });
      graphEdges.push({ a: secNodeIdx, b: roadNodeIdx, type: 'ped' });
      // Link pedRoad → closest ring node
      var bestRI = -1, bestRD = Infinity;
      for (var gri = 0; gri < graphNodes.length; gri++) {
        if (graphNodes[gri].type !== 'ring' && graphNodes[gri].type !== 'junction') continue;
        var dd = vLen(vSub(graphNodes[gri].pt, pp.to));
        if (dd < bestRD) { bestRD = dd; bestRI = gri; }
      }
      if (bestRI >= 0 && bestRD > 0.3) graphEdges.push({ a: roadNodeIdx, b: bestRI, type: 'ring' });
    }
  }

  // Connector road quads (6m wide, matching prototype rendering)
  var connectorQuads = [];
  for (var cqi = 0; cqi < connectors.length; cqi++) {
    var cq = connectors[cqi];
    var cdx = cq.to[0] - cq.from[0], cdy = cq.to[1] - cq.from[1];
    var clen = Math.sqrt(cdx * cdx + cdy * cdy);
    if (clen < 0.5) continue;
    var pAx = -cdy / clen, pAy = cdx / clen;
    var cmid = [(cq.from[0] + cq.to[0]) / 2, (cq.from[1] + cq.to[1]) / 2];
    var bc = cq.bufCen || cmid;
    var testA = [cmid[0] + pAx * 3, cmid[1] + pAy * 3];
    var testB = [cmid[0] - pAx * 3, cmid[1] - pAy * 3];
    var toInner = (vLen(vSub(testA, bc)) < vLen(vSub(testB, bc))) ? 1 : -1;
    var ipx = pAx * toInner * 6, ipy = pAy * toInner * 6;
    connectorQuads.push([
      cq.from, cq.to,
      [cq.to[0] + ipx, cq.to[1] + ipy],
      [cq.from[0] + ipx, cq.from[1] + ipy]
    ]);
  }

  return {
    secFire: secFire,
    roadBuf: roadBuf,
    roadOuter: roadOuter,
    roadInner: roadInner,
    connectors: connectors,
    connectorQuads: connectorQuads,
    graphNodes: graphNodes,
    graphEdges: graphEdges,
    trashPad: trashPad,
    trashInner: trashInner,
    trashOuter: trashOuter,
    playBuf12: playBuf12,
    playBuf20: playBuf20,
    playBuf40: playBuf40,
    pedPaths: pedPaths
  };
}

// ── Grid generation (OBB-aligned, clipped to polygon) ─────

function segT(p1, p2, p3, p4) {
  var d1 = vSub(p2, p1), d2 = vSub(p4, p3), cr = vCross(d1, d2);
  if (Math.abs(cr) < 1e-10) return null;
  var d3 = vSub(p3, p1), t = vCross(d3, d2) / cr, u = vCross(d3, d1) / cr;
  if (t >= -1e-9 && t <= 1 + 1e-9 && u >= -1e-9 && u <= 1 + 1e-9) return Math.max(0, Math.min(1, t));
  return null;
}

function clipSegInside(p1, p2, poly) {
  var ts = [];
  for (var i = 0; i < poly.length; i++) {
    var t = segT(p1, p2, poly[i], poly[(i + 1) % poly.length]);
    if (t !== null) ts.push(t);
  }
  ts.sort(function (a, b) { return a - b; });
  var uTs = [0];
  for (var k = 0; k < ts.length; k++) { if (Math.abs(ts[k] - uTs[uTs.length - 1]) > 1e-9) uTs.push(ts[k]); }
  if (Math.abs(uTs[uTs.length - 1] - 1) > 1e-9) uTs.push(1);
  var segs = [], dir = vSub(p2, p1);
  for (var i2 = 0; i2 < uTs.length - 1; i2++) {
    var mid = (uTs[i2] + uTs[i2 + 1]) / 2;
    var mp = vAdd(p1, vSc(dir, mid));
    if (ptIn(mp, poly)) segs.push({ start: vAdd(p1, vSc(dir, uTs[i2])), end: vAdd(p1, vSc(dir, uTs[i2 + 1])) });
  }
  return segs;
}

/**
 * Generate OBB-aligned grid lines clipped to polygon interior.
 *
 * @param {Array<[number,number]>} polyM - polygon in meters (CCW)
 * @param {number} step - grid spacing in meters
 * @param {Object} [obb] - precomputed OBB (optional, recomputed if null)
 * @returns {{ h: Array<{start, end}>, v: Array<{start, end}> }}
 */
export function genGrid(polyM, step, obb) {
  if (!obb) obb = computeOBB(polyM);
  var h = [], v = [];
  var d1 = obb.d1, d2 = obb.d2;
  var center = [(obb.cx !== undefined ? obb.cx : 0), (obb.cy !== undefined ? obb.cy : 0)];
  var halfW = obb.w / 2 + step, halfH = obb.h / 2 + step;
  // Lines along d1 (shifted by d2)
  for (var t = -halfH; t <= halfH; t += step) {
    var origin = vAdd(center, vSc(d2, t));
    var p1 = vAdd(origin, vSc(d1, -halfW));
    var p2 = vAdd(origin, vSc(d1, halfW));
    var sg = clipSegInside(p1, p2, polyM);
    for (var i = 0; i < sg.length; i++) h.push(sg[i]);
  }
  // Lines along d2 (shifted by d1)
  for (var t2 = -halfW; t2 <= halfW; t2 += step) {
    var origin2 = vAdd(center, vSc(d1, t2));
    var p3 = vAdd(origin2, vSc(d2, -halfH));
    var p4 = vAdd(origin2, vSc(d2, halfH));
    var sg2 = clipSegInside(p3, p4, polyM);
    for (var j = 0; j < sg2.length; j++) v.push(sg2[j]);
  }
  return { h: h, v: v };
}

// ── External road connections ─────────────────────────────

/**
 * Project point onto nearest position along a polyline.
 * @returns {{ pt: [number,number], dist: number }}
 */
function projOnPolyline(pt, line) {
  var bestPt = null, bestD = Infinity;
  for (var i = 0; i < line.length - 1; i++) {
    var a = line[i], b = line[i + 1];
    var ab = vSub(b, a), ap = vSub(pt, a);
    var len2 = vDot(ab, ab);
    var t = len2 > 1e-9 ? Math.max(0, Math.min(1, vDot(ap, ab) / len2)) : 0;
    var proj = vAdd(a, vSc(ab, t));
    var d = vLen(vSub(proj, pt));
    if (d < bestD) { bestD = d; bestPt = proj; }
  }
  return { pt: bestPt, dist: bestD };
}

/**
 * Compute connections from block boundary points to nearby road polylines.
 *
 * Ported from JSX prototype (ШАГ 19: Подключения к внешним дорогам).
 *
 * @param {Array<Object>} connectors - from computeOverlays (with .from boundary points)
 * @param {Array<Array<[number,number]>>} roadPolylinesM - road polylines in meters
 * @param {Array<[number,number]>} polyM - block polygon in meters
 * @param {number} numEntries - desired number of active entries (1-8)
 * @returns {{ connections: Array<{from, proj, dist, roadIdx, active}>, activeBoundary: Object }}
 */
export function computeExtConnections(connectors, roadPolylinesM, polyM, numEntries) {
  if (!connectors || connectors.length === 0 || !roadPolylinesM || roadPolylinesM.length === 0) {
    return { connections: [], activeBoundary: {} };
  }

  // Collect unique boundary points (connector .from points)
  var boundaryPts = [];
  var bpSet = {};
  for (var i = 0; i < connectors.length; i++) {
    var bp = connectors[i].from;
    var bk = Math.round(bp[0] * 10) + '_' + Math.round(bp[1] * 10);
    if (!bpSet[bk]) { bpSet[bk] = true; boundaryPts.push(bp); }
  }

  // For each boundary point, find nearest projection on each road
  var extConns = [];
  for (var ri = 0; ri < roadPolylinesM.length; ri++) {
    var road = roadPolylinesM[ri];
    if (road.length < 2) continue;
    for (var bi = 0; bi < boundaryPts.length; bi++) {
      var pr = projOnPolyline(boundaryPts[bi], road);
      if (pr.pt && pr.dist < 300) {
        extConns.push({ from: boundaryPts[bi], proj: pr.pt, dist: pr.dist, roadIdx: ri });
      }
    }
  }

  // Filter: remove connections that cross the polygon boundary
  var filtered = [];
  for (var fi = 0; fi < extConns.length; fi++) {
    var ec = extConns[fi];
    var dir = vNorm(vSub(ec.proj, ec.from));
    var startPt = vAdd(ec.from, vSc(dir, 0.5)); // offset slightly to avoid self-intersection
    var hitsP = false;
    for (var pi = 0; pi < polyM.length; pi++) {
      if (segSeg(startPt, ec.proj, polyM[pi], polyM[(pi + 1) % polyM.length])) { hitsP = true; break; }
    }
    if (!hitsP) filtered.push(ec);
  }
  extConns = filtered;

  // Dedup: if two connections from same point, keep shorter
  var deduped = [];
  var seenFrom = {};
  extConns.sort(function (a, b) { return a.dist - b.dist; });
  for (var di = 0; di < extConns.length; di++) {
    var dk = Math.round(extConns[di].from[0] * 10) + '_' + Math.round(extConns[di].from[1] * 10);
    if (!seenFrom[dk]) { seenFrom[dk] = true; deduped.push(extConns[di]); }
  }
  extConns = deduped;

  // Select N entries: brute-force for small sets, greedy otherwise
  var ne = Math.min(numEntries || 2, extConns.length);
  var activeEntries = [];

  if (extConns.length > 0 && ne > 0) {
    if (ne === 1) {
      var bestI = 0;
      for (var si = 1; si < extConns.length; si++) { if (extConns[si].dist < extConns[bestI].dist) bestI = si; }
      activeEntries = [bestI];
    } else {
      var count = extConns.length;
      var useBrute = (ne <= 4 && count <= 20);
      if (useBrute) {
        var bestCombo = null, bestScore = -Infinity;
        function combos(arr, k, start, cur) {
          if (cur.length === k) {
            var minSp = Infinity;
            for (var a2 = 0; a2 < cur.length; a2++) {
              for (var b2 = a2 + 1; b2 < cur.length; b2++) {
                var sp = vLen(vSub(extConns[cur[a2]].from, extConns[cur[b2]].from));
                if (sp < minSp) minSp = sp;
              }
            }
            var avgD = 0;
            for (var c2 = 0; c2 < cur.length; c2++) avgD += extConns[cur[c2]].dist;
            avgD /= cur.length;
            var score = minSp * 2 - avgD;
            if (score > bestScore) { bestScore = score; bestCombo = cur.slice(); }
            return;
          }
          for (var i2 = start; i2 < arr; i2++) { cur.push(i2); combos(arr, k, i2 + 1, cur); cur.pop(); }
        }
        combos(count, ne, 0, []);
        if (bestCombo) activeEntries = bestCombo;
      } else {
        // Greedy: start with shortest, then maximin spacing
        var picked = [0];
        for (var si2 = 1; si2 < extConns.length; si2++) { if (extConns[si2].dist < extConns[picked[0]].dist) picked[0] = si2; }
        while (picked.length < ne) {
          var bestIdx = -1, bestS = -Infinity;
          for (var si3 = 0; si3 < extConns.length; si3++) {
            var alr = false;
            for (var pi2 = 0; pi2 < picked.length; pi2++) { if (picked[pi2] === si3) { alr = true; break; } }
            if (alr) continue;
            var minD = Infinity;
            for (var pi3 = 0; pi3 < picked.length; pi3++) {
              var d2 = vLen(vSub(extConns[si3].from, extConns[picked[pi3]].from));
              if (d2 < minD) minD = d2;
            }
            var sc = minD * 2 - extConns[si3].dist;
            if (sc > bestS) { bestS = sc; bestIdx = si3; }
          }
          if (bestIdx >= 0) picked.push(bestIdx); else break;
        }
        activeEntries = picked;
      }
    }
  }

  // Mark active
  for (var mi = 0; mi < extConns.length; mi++) extConns[mi].active = false;
  for (var mi2 = 0; mi2 < activeEntries.length; mi2++) extConns[activeEntries[mi2]].active = true;

  // Build active boundary set
  var activeBoundary = {};
  for (var ai = 0; ai < extConns.length; ai++) {
    if (extConns[ai].active) {
      var abk = Math.round(extConns[ai].from[0] * 10) + '_' + Math.round(extConns[ai].from[1] * 10);
      activeBoundary[abk] = true;
    }
  }

  return { connections: extConns, activeBoundary: activeBoundary };
}
