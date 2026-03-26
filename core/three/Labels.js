/**
 * Labels — text sprites and cell labels for 3D view.
 */

import * as THREE from 'three';
import { insetPoly } from './BoxGeometry.js';

/**
 * Text label on the top face of a cell, oriented along section axis.
 * Smaller, regular weight, slightly raised, darker.
 */
export function buildCellLabelSprite(text, polygon, topZ, inset) {
  if (inset === undefined) inset = 0.08;
  var poly = inset > 0 ? insetPoly(polygon, inset) : polygon;

  var canvas = document.createElement('canvas');
  var size = 128;
  canvas.width = size;
  canvas.height = size;
  var ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, size, size);

  ctx.font = '400 32px system-ui, -apple-system, sans-serif';
  ctx.fillStyle = '#333333';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, size / 2, size / 2);

  var texture = new THREE.CanvasTexture(canvas);
  texture.minFilter = THREE.LinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.needsUpdate = true;

  var mat = new THREE.MeshBasicMaterial({
    map: texture, transparent: true, depthTest: false,
    side: THREE.DoubleSide, toneMapped: false
  });

  var planeGeo = new THREE.PlaneGeometry(2.8, 2.8);
  var mesh = new THREE.Mesh(planeGeo, mat);

  var cx = (poly[0][0] + poly[1][0] + poly[2][0] + poly[3][0]) / 4;
  var cy = (poly[0][1] + poly[1][1] + poly[2][1] + poly[3][1]) / 4;
  mesh.position.set(cx, cy, topZ + 0.25);

  var dx = poly[1][0] - poly[0][0];
  var dy = poly[1][1] - poly[0][1];
  mesh.rotation.z = Math.atan2(dy, dx);

  return mesh;
}

/**
 * Build a text sprite label positioned above the section box.
 * Clean minimal style — dark text, no background, sharp rendering.
 */
export function buildFloorLabel(text, footprintM, topZ) {
  var canvas = document.createElement('canvas');
  var size = 256;
  canvas.width = size;
  canvas.height = size;
  var ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, size, size);

  ctx.font = '600 64px system-ui, -apple-system, sans-serif';
  var metrics = ctx.measureText(text);
  var textW = metrics.width;

  var padH = 20;
  var padV = 12;
  var pillW = textW + padH * 2;
  var pillH = 64 + padV * 2;
  var px = (size - pillW) / 2;
  var py = (size - pillH) / 2;
  var r = pillH / 2;

  ctx.shadowColor = 'rgba(0, 0, 0, 0.18)';
  ctx.shadowBlur = 8;
  ctx.shadowOffsetX = 0;
  ctx.shadowOffsetY = 2;

  ctx.fillStyle = 'rgba(255, 255, 255, 0.88)';
  ctx.beginPath();
  ctx.roundRect(px, py, pillW, pillH, r);
  ctx.fill();

  ctx.shadowColor = 'transparent';
  ctx.shadowBlur = 0;
  ctx.shadowOffsetY = 0;

  ctx.strokeStyle = 'rgba(0, 0, 0, 0.1)';
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.roundRect(px, py, pillW, pillH, r);
  ctx.stroke();

  ctx.fillStyle = '#1a1a1a';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, size / 2, size / 2 + 1);

  var texture = new THREE.CanvasTexture(canvas);
  texture.minFilter = THREE.LinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.needsUpdate = true;

  var mat = new THREE.SpriteMaterial({
    map: texture,
    transparent: true,
    depthTest: false,
    sizeAttenuation: true
  });

  var sprite = new THREE.Sprite(mat);

  var cx = (footprintM[0][0] + footprintM[1][0] + footprintM[2][0] + footprintM[3][0]) / 4;
  var cy = (footprintM[0][1] + footprintM[1][1] + footprintM[2][1] + footprintM[3][1]) / 4;
  sprite.position.set(cx, cy, topZ + 2);
  sprite.scale.set(7, 7, 1);

  return sprite;
}

/**
 * Small label on the top face of a detailed floor cell.
 */
export function buildDetailLabel(text, polygon, z, inset) {
  if (inset === undefined) inset = 0.08;
  var poly = inset > 0 ? insetPoly(polygon, inset) : polygon;
  var canvas = document.createElement('canvas');
  var size = 128;
  canvas.width = size; canvas.height = size;
  var ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, size, size);
  ctx.font = '400 32px system-ui, -apple-system, sans-serif';
  ctx.fillStyle = '#1a1a1a';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, size / 2, size / 2);

  var texture = new THREE.CanvasTexture(canvas);
  texture.minFilter = THREE.LinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.needsUpdate = true;

  var mat = new THREE.MeshBasicMaterial({
    map: texture, transparent: true, depthTest: false,
    side: THREE.DoubleSide, toneMapped: false
  });
  var planeGeo = new THREE.PlaneGeometry(2.8, 2.8);
  var mesh = new THREE.Mesh(planeGeo, mat);

  var cx = (poly[0][0] + poly[1][0] + poly[2][0] + poly[3][0]) / 4;
  var cy = (poly[0][1] + poly[1][1] + poly[2][1] + poly[3][1]) / 4;
  mesh.position.set(cx, cy, z);

  var ddx = poly[1][0] - poly[0][0]; var ddy = poly[1][1] - poly[0][1];
  mesh.rotation.z = Math.atan2(ddy, ddx);
  return mesh;
}
