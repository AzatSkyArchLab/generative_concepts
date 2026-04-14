/**
 * OverlayRenderer — renders urban block plan overlays to an OffscreenCanvas,
 * then provides a THREE.CanvasTexture for a flat ground plane.
 *
 * Ports the prototype's 2D compositing: polygon clipping, evenodd courtyard,
 * destination-out ring zones, roundQuad rounded corners.
 *
 * All input coordinates in meters (local projection).
 */

import { vSub, vAdd, vSc, vLen, vNorm } from '../geo/vec2.js';

var CANVAS_PX_PER_M = 4; // resolution: 4 pixels per meter

function roundQuad(ctx, pts, r, mv) {
  for (var i = 0; i < 4; i++) {
    var pr = pts[(i + 3) % 4], cu = pts[i], nx = pts[(i + 1) % 4];
    var dP = vLen(vSub(pr, cu)), dN = vLen(vSub(nx, cu));
    var rr = Math.min(r, dP * 0.4, dN * 0.4);
    if (rr < 0.5) rr = 0;
    var pP = vAdd(cu, vSc(vNorm(vSub(pr, cu)), rr));
    if (i === 0) { if (mv) ctx.moveTo(pP[0], pP[1]); else ctx.lineTo(pP[0], pP[1]); }
    else ctx.lineTo(pP[0], pP[1]);
    var pN = vAdd(cu, vSc(vNorm(vSub(nx, cu)), rr));
    if (rr > 0) ctx.arcTo(cu[0], cu[1], pN[0], pN[1], rr);
    else ctx.lineTo(cu[0], cu[1]);
  }
  ctx.closePath();
}

/**
 * Render all overlay layers to a canvas.
 * @param {Object} overlaysM — overlay data in METERS (from computeOverlays)
 * @param {Array} polyM — block polygon in meters [[x,y],...]
 * @param {Object} params — {sw, fire, ...}
 * @param {Object} visibility — {buffers, secfire, road, connectors, graph, trash, play}
 * @returns {{canvas, minX, minY, maxX, maxY, width, height}} — canvas + bounds in meters
 */
export function renderOverlayCanvas(overlaysM, polyM, params, visibility) {
  if (!polyM || polyM.length < 3) return null;
  var vis = visibility || {};

  // Compute bounds with padding
  var pad = 5;
  var minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (var i = 0; i < polyM.length; i++) {
    if (polyM[i][0] < minX) minX = polyM[i][0];
    if (polyM[i][1] < minY) minY = polyM[i][1];
    if (polyM[i][0] > maxX) maxX = polyM[i][0];
    if (polyM[i][1] > maxY) maxY = polyM[i][1];
  }
  minX -= pad; minY -= pad; maxX += pad; maxY += pad;

  var W = Math.ceil((maxX - minX) * CANVAS_PX_PER_M);
  var H = Math.ceil((maxY - minY) * CANVAS_PX_PER_M);
  if (W < 10 || H < 10 || W > 4096 || H > 4096) return null;

  var canvas = document.createElement('canvas');
  canvas.width = W; canvas.height = H;
  var c = canvas.getContext('2d');

  // Transform: meters → canvas pixels (Y flip for screen coords)
  function tx(mx) { return (mx - minX) * CANVAS_PX_PER_M; }
  function ty(my) { return H - (my - minY) * CANVAS_PX_PER_M; } // Y flip
  function tp(p) { return [tx(p[0]), ty(p[1])]; }

  // Helper: draw polygon path
  function polyPath(ctx, poly) {
    var p0 = tp(poly[0]);
    ctx.moveTo(p0[0], p0[1]);
    for (var i = 1; i < poly.length; i++) { var pi = tp(poly[i]); ctx.lineTo(pi[0], pi[1]); }
    ctx.closePath();
  }

  // Helper: draw roundQuad in screen coords
  function rq(ctx, quad, radius, move) {
    var sq = []; for (var i = 0; i < quad.length; i++) sq.push(tp(quad[i]));
    var r = radius * CANVAS_PX_PER_M;
    roundQuad(ctx, sq, r, move);
  }

  var ov = overlaysM;
  var fb = params.fire || 14;

  // ── Layer 1: Courtyard (evenodd: green everywhere except secFire) ──
  if (vis.secfire !== false && ov.secFire && ov.secFire.length > 0) {
    c.save();
    c.beginPath(); polyPath(c, polyM); c.clip();
    c.beginPath();
    c.rect(0, 0, W, H);
    var rPx = fb * 0.7 * CANVAS_PX_PER_M;
    for (var fi = 0; fi < ov.secFire.length; fi++) {
      rq(c, ov.secFire[fi], fb * 0.7, true);
    }
    c.fillStyle = 'rgba(76, 187, 97, 0.35)';
    c.fill('evenodd');
    c.restore();
  }

  // ── Layer 2: Road ring (outer fill + connector fill, destination-out inner) ──
  if (vis.road !== false && ov.roadOuter && ov.roadOuter.length >= 3 && ov.roadInner && ov.roadInner.length >= 3) {
    var oc = document.createElement('canvas'); oc.width = W; oc.height = H;
    var ox = oc.getContext('2d');
    ox.save();
    ox.beginPath(); polyPath(ox, polyM); ox.clip();
    ox.fillStyle = 'rgb(140,140,155)';
    // Outer fill
    ox.beginPath(); polyPath(ox, ov.roadOuter); ox.fill();
    // Connector road rects
    if (ov.connectorQuads) {
      for (var cri = 0; cri < ov.connectorQuads.length; cri++) {
        var cq = ov.connectorQuads[cri];
        ox.beginPath(); var p0 = tp(cq[0]); ox.moveTo(p0[0], p0[1]);
        for (var cj = 1; cj < cq.length; cj++) { var pj = tp(cq[cj]); ox.lineTo(pj[0], pj[1]); }
        ox.closePath(); ox.fill();
      }
    }
    // Destination-out inner
    ox.globalCompositeOperation = 'destination-out';
    ox.fillStyle = 'rgb(0,0,0)';
    ox.beginPath(); polyPath(ox, ov.roadInner); ox.fill();
    ox.restore();
    c.save(); c.globalAlpha = 0.45; c.drawImage(oc, 0, 0); c.restore();
  }

  // ── Layer 3: Axis buffers (fire=red, end=blue, insol=green, rounded) ──
  if (vis.buffers !== false && ov.bufferZones) {
    c.save();
    c.beginPath(); polyPath(c, polyM); c.clip();
    var bufStyles = {
      insol: { fill: 'rgba(22,163,74,0.12)', r: 0.3 },
      end:   { fill: 'rgba(37,99,235,0.15)', r: 0.5 },
      fire:  { fill: 'rgba(220,38,38,0.15)', r: 0.7 }
    };
    // Draw in order: insol (widest) → end → fire (narrowest)
    var order = ['insol', 'end', 'fire'];
    for (var oi = 0; oi < order.length; oi++) {
      var key = order[oi];
      var st = bufStyles[key];
      for (var bi = 0; bi < ov.bufferZones.length; bi++) {
        var bz = ov.bufferZones[bi];
        if (bz.type !== key) continue;
        c.beginPath();
        rq(c, bz.polygon, (params[key === 'fire' ? 'fire' : key === 'end' ? 'endB' : 'insol'] || 20) * st.r, true);
        c.fillStyle = st.fill; c.fill();
      }
    }
    c.restore();
  }

  // ── Layer 4: ТКО zone (100m minus 20m, rounded, brown) ──
  if (vis.trash !== false && ov.trashOuter && ov.trashOuter.length > 0) {
    var tc = document.createElement('canvas'); tc.width = W; tc.height = H;
    var txc = tc.getContext('2d');
    txc.save();
    txc.beginPath(); polyPath(txc, polyM); txc.clip();
    txc.fillStyle = 'rgb(180,120,60)';
    var rOut = 100 * 0.3 * CANVAS_PX_PER_M;
    for (var toi = 0; toi < ov.trashOuter.length; toi++) {
      txc.beginPath(); rq(txc, ov.trashOuter[toi], 100 * 0.3, true); txc.fill();
    }
    txc.globalCompositeOperation = 'destination-out';
    txc.fillStyle = 'rgb(0,0,0)';
    var rIn = 20 * 0.5 * CANVAS_PX_PER_M;
    for (var tii = 0; tii < ov.trashInner.length; tii++) {
      txc.beginPath(); rq(txc, ov.trashInner[tii], 20 * 0.5, true); txc.fill();
    }
    txc.restore();
    c.save(); c.globalAlpha = 0.15; c.drawImage(tc, 0, 0); c.restore();
  }

  // ── Layer 5: ТКО pad (always drawn) ──
  if (ov.trashPad) {
    var tpr = ov.trashPad.rect;
    var sp = tp(tpr[0]);
    c.beginPath(); c.moveTo(sp[0], sp[1]);
    for (var ti = 1; ti < tpr.length; ti++) { var spi = tp(tpr[ti]); c.lineTo(spi[0], spi[1]); }
    c.closePath();
    c.fillStyle = 'rgba(200,140,30,0.7)'; c.fill();
    c.strokeStyle = '#8b5e14'; c.lineWidth = 2; c.stroke();
    // Label
    var tpc = tp(ov.trashPad.center);
    c.font = 'bold ' + Math.round(9 * CANVAS_PX_PER_M / 3) + 'px monospace';
    c.textAlign = 'center'; c.textBaseline = 'middle';
    c.fillStyle = '#fff'; c.fillText('ТКО', tpc[0], tpc[1]);
  }

  // ── Layer 6: Playground zones (3 rings: 12-20 blue, 20-40 green, 40+ red) ──
  if (vis.play !== false && ov.playBuf12 && ov.playBuf12.length > 0) {
    var r12 = 12 * 0.4, r20 = 20 * 0.4, r40 = 40 * 0.3;

    // Zone 1: 12-20m (blue)
    var pc1 = document.createElement('canvas'); pc1.width = W; pc1.height = H;
    var px1 = pc1.getContext('2d');
    px1.save(); px1.beginPath(); polyPath(px1, polyM); px1.clip();
    px1.fillStyle = 'rgb(66,133,244)';
    for (var pi4 = 0; pi4 < ov.playBuf20.length; pi4++) { px1.beginPath(); rq(px1, ov.playBuf20[pi4], r20, true); px1.fill(); }
    px1.globalCompositeOperation = 'destination-out'; px1.fillStyle = 'rgb(0,0,0)';
    for (var pi5 = 0; pi5 < ov.playBuf12.length; pi5++) { px1.beginPath(); rq(px1, ov.playBuf12[pi5], r12, true); px1.fill(); }
    if (ov.trashPad) {
      var tpc2 = tp(ov.trashPad.center); var tRad = 20 * CANVAS_PX_PER_M;
      px1.beginPath(); px1.arc(tpc2[0], tpc2[1], tRad, 0, Math.PI * 2); px1.fill();
    }
    px1.restore();
    c.save(); c.globalAlpha = 0.12; c.drawImage(pc1, 0, 0); c.restore();

    // Zone 2: 20-40m (green)
    var pc2 = document.createElement('canvas'); pc2.width = W; pc2.height = H;
    var px2 = pc2.getContext('2d');
    px2.save(); px2.beginPath(); polyPath(px2, polyM); px2.clip();
    px2.fillStyle = 'rgb(52,168,83)';
    for (var pi6 = 0; pi6 < ov.playBuf40.length; pi6++) { px2.beginPath(); rq(px2, ov.playBuf40[pi6], r40, true); px2.fill(); }
    px2.globalCompositeOperation = 'destination-out'; px2.fillStyle = 'rgb(0,0,0)';
    for (var pi7 = 0; pi7 < ov.playBuf20.length; pi7++) { px2.beginPath(); rq(px2, ov.playBuf20[pi7], r20, true); px2.fill(); }
    if (ov.trashPad) {
      var tpc3 = tp(ov.trashPad.center);
      px2.beginPath(); px2.arc(tpc3[0], tpc3[1], 20 * CANVAS_PX_PER_M, 0, Math.PI * 2); px2.fill();
    }
    px2.restore();
    c.save(); c.globalAlpha = 0.12; c.drawImage(pc2, 0, 0); c.restore();

    // Zone 3: 40m+ (red)
    var pc3 = document.createElement('canvas'); pc3.width = W; pc3.height = H;
    var px3 = pc3.getContext('2d');
    px3.save(); px3.beginPath(); polyPath(px3, polyM); px3.clip();
    px3.fillStyle = 'rgb(234,67,53)'; px3.fillRect(0, 0, W, H);
    px3.globalCompositeOperation = 'destination-out'; px3.fillStyle = 'rgb(0,0,0)';
    for (var pi8 = 0; pi8 < ov.playBuf40.length; pi8++) { px3.beginPath(); rq(px3, ov.playBuf40[pi8], r40, true); px3.fill(); }
    px3.restore();
    c.save(); c.globalAlpha = 0.08; c.drawImage(pc3, 0, 0); c.restore();
  }

  // ── Layer 7: Graph + connectors ──
  if (vis.graph !== false && ov.graphEdges && ov.graphNodes) {
    c.save();
    for (var gei = 0; gei < ov.graphEdges.length; gei++) {
      var ge = ov.graphEdges[gei];
      var na = ov.graphNodes[ge.a], nb = ov.graphNodes[ge.b];
      if (!na || !nb) continue;
      var pa = tp(na.pt), pb = tp(nb.pt);
      c.beginPath(); c.moveTo(pa[0], pa[1]); c.lineTo(pb[0], pb[1]);
      c.strokeStyle = ge.type === 'ring' ? 'rgba(0,180,160,0.7)' : 'rgba(220,120,30,0.8)';
      c.lineWidth = 2 * CANVAS_PX_PER_M / 3; c.stroke();
    }
    for (var gni = 0; gni < ov.graphNodes.length; gni++) {
      var nd = ov.graphNodes[gni];
      var ns = tp(nd.pt);
      var rad = (nd.type === 'ring' ? 1 : 2) * CANVAS_PX_PER_M / 3;
      c.beginPath(); c.arc(ns[0], ns[1], rad, 0, Math.PI * 2);
      c.fillStyle = nd.type === 'junction' ? '#ff6600' : nd.type === 'boundary' ? '#2080e0' : '#00b4a0';
      c.fill(); c.strokeStyle = '#fff'; c.lineWidth = 1; c.stroke();
    }
    c.restore();
  }
  if (vis.connectors !== false && ov.connectors) {
    for (var ci = 0; ci < ov.connectors.length; ci++) {
      var cn = ov.connectors[ci];
      var pf = tp(cn.from), pt = tp(cn.to);
      c.beginPath(); c.arc(pf[0], pf[1], 4, 0, Math.PI * 2);
      c.fillStyle = '#2080e0'; c.fill(); c.strokeStyle = '#fff'; c.lineWidth = 1; c.stroke();
      c.beginPath(); c.arc(pt[0], pt[1], 4, 0, Math.PI * 2);
      c.fillStyle = '#e07020'; c.fill(); c.strokeStyle = '#fff'; c.lineWidth = 1; c.stroke();
    }
  }

  return {
    canvas: canvas,
    minX: minX, minY: minY,
    maxX: maxX, maxY: maxY,
    width: maxX - minX, height: maxY - minY
  };
}
