/**
 * UrbanBlockOverlays — compute all plan overlay geometries.
 *
 * Ported from React prototype: road ring, connectors, graph,
 * trash pad, playground zones, section fire buffers.
 *
 * All coordinates in meters (local projection).
 */

// ── Geometry helpers ──────────────────────────────────

function vSub(a, b) { return [a[0] - b[0], a[1] - b[1]]; }
function vAdd(a, b) { return [a[0] + b[0], a[1] + b[1]]; }
function vSc(v, s) { return [v[0] * s, v[1] * s]; }
function vLen(v) { return Math.sqrt(v[0] * v[0] + v[1] * v[1]); }
function vNorm(v) { var l = vLen(v); return l > 1e-9 ? [v[0] / l, v[1] / l] : [0, 0]; }
function vDot(a, b) { return a[0] * b[0] + a[1] * b[1]; }
function vCross(a, b) { return a[0] * b[1] - a[1] * b[0]; }

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

  // Trash pad 6×3m (OBB grid search)
  var trashPad = null;
  if (trashOuter.length > 0) {
    var obb = computeOBB(polyM);
    var padW = 6, padH = 3;
    var cen = pCen(polyM);
    var bestDist = -1;
    var step = 6;
    var hW = obb.w / 2 + 10, hH = obb.h / 2 + 10;
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
        // All corners inside polygon
        var allIn = true;
        for (var ci2 = 0; ci2 < 4; ci2++) { if (!ptIn(corners[ci2], polyM)) { allIn = false; break; } }
        if (!allIn) continue;
        // Inside roadInner
        if (roadInner.length >= 3) {
          var inRoad = true;
          for (var ci3 = 0; ci3 < 4; ci3++) { if (!ptIn(corners[ci3], roadInner)) { inRoad = false; break; } }
          if (!inRoad) continue;
        }
        // In trashZone (20-100m): inside outer, outside inner
        var inO = false;
        for (var toi = 0; toi < trashOuter.length; toi++) { if (ptIn(center, trashOuter[toi])) { inO = true; break; } }
        if (!inO) continue;
        var inI = false;
        for (var tii = 0; tii < trashInner.length; tii++) { if (ptIn(center, trashInner[tii])) { inI = true; break; } }
        if (inI) continue;
        // Not intersecting secFire
        var hitsSec = false;
        for (var sfi = 0; sfi < secFire.length && !hitsSec; sfi++) {
          for (var ci4 = 0; ci4 < 4; ci4++) { if (ptIn(corners[ci4], secFire[sfi])) { hitsSec = true; break; } }
        }
        if (hitsSec) continue;
        // Max distance from center
        var dist = vLen(vSub(center, cen));
        if (dist > bestDist) { bestDist = dist; trashPad = { center: center, rect: corners }; }
      }
    }
  }

  return {
    secFire: secFire,
    roadBuf: roadBuf,
    roadOuter: roadOuter,
    roadInner: roadInner,
    connectors: connectors,
    graphNodes: graphNodes,
    graphEdges: graphEdges,
    trashPad: trashPad,
    trashInner: trashInner,
    trashOuter: trashOuter,
    playBuf12: playBuf12,
    playBuf20: playBuf20,
    playBuf40: playBuf40
  };
}
