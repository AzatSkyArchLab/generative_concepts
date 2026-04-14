/**
 * TopologyBuilder — section topology from graph nodes.
 *
 * Builds near/far segments, corridors, torec positions
 * from the section graph. Pure math.
 */

import { nearToFar } from './CellTopology.js';

function splitContiguous(ids) {
  if (ids.length === 0) return [];
  var segs = [];
  var cur = [ids[0]];
  for (var i = 1; i < ids.length; i++) {
    if (ids[i] === cur[cur.length - 1] + 1) {
      cur.push(ids[i]);
    } else {
      segs.push(cur.slice());
      cur = [ids[i]];
    }
  }
  segs.push(cur.slice());
  return segs;
}

/**
 * Build section topology from graph nodes.
 * @param {Object} graphNodes - { 'cellId:floor': node }
 * @param {number} N - cells per side
 * @param {number} targetFloor
 * @returns {Object} section topology
 */
export function buildSection(graphNodes, N, targetFloor) {
  var nearAll = [];
  var llu = [];
  var corridors = {};      // nearCid -> farCid
  var corridorKeys = {};   // nearCid -> corridorLabel

  // Near apartment cells
  for (var cid = 0; cid < N; cid++) {
    var key = cid + ':' + targetFloor;
    if (graphNodes[key] && graphNodes[key].type === 'apartment') {
      nearAll.push(cid);
    }
  }
  nearAll.sort(function (a, b) { return a - b; });

  var nearSegments = splitContiguous(nearAll);

  // LLU cells (both near and far sides)
  for (var cid = 0; cid < 2 * N; cid++) {
    var key = cid + ':' + targetFloor;
    if (graphNodes[key] && graphNodes[key].type === 'llu') {
      llu.push(cid);
    }
  }

  // Corridors
  for (var nodeKey in graphNodes) {
    if (!graphNodes.hasOwnProperty(nodeKey)) continue;
    var node = graphNodes[nodeKey];
    if (node.floor !== targetFloor) continue;
    if (node.type !== 'corridor') continue;
    var rawId = String(node.cellId);
    if (rawId.indexOf('-') < 0) continue;
    var parts = rawId.split('-');
    var nCid = parseInt(parts[0]);
    var fCid = parseInt(parts[1]);
    corridors[nCid] = fCid;
    corridorKeys[nCid] = rawId;
  }

  // Reverse mapping far -> near
  var farToNear = {};
  for (var nc in corridors) {
    if (corridors.hasOwnProperty(nc)) {
      farToNear[corridors[nc]] = parseInt(nc);
    }
  }

  // Far segments
  var farSegments = [];
  var currentSeg = [];
  for (var nearPos = 0; nearPos < N; nearPos++) {
    var farCid = nearToFar(nearPos, N);
    var fkey = farCid + ':' + targetFloor;
    if (!graphNodes[fkey]) {
      if (currentSeg.length > 0) { farSegments.push(currentSeg.slice()); currentSeg = []; }
      continue;
    }
    if (graphNodes[fkey].type === 'apartment') {
      currentSeg.push(farCid);
    } else {
      if (currentSeg.length > 0) { farSegments.push(currentSeg.slice()); currentSeg = []; }
    }
  }
  if (currentSeg.length > 0) farSegments.push(currentSeg.slice());

  // Torecs: 1 corridor per physical end
  var sortedCorr = [];
  for (var nc in corridors) {
    if (corridors.hasOwnProperty(nc)) sortedCorr.push(parseInt(nc));
  }
  sortedCorr.sort(function (a, b) { return a - b; });

  var torecLeft = sortedCorr.length > 0 ? [sortedCorr[0]] : [];
  var torecRight = sortedCorr.length > 1 ? [sortedCorr[sortedCorr.length - 1]] : [];

  return {
    nearAll: nearAll, nearSegments: nearSegments, farSegments: farSegments,
    llu: llu, corridors: corridors, corridorKeys: corridorKeys,
    farToNear: farToNear, torecLeft: torecLeft, torecRight: torecRight, N: N
  };
}
