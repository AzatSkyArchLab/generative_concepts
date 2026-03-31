/**
 * BoxGeometry — low-level box geometry and edge builders.
 * Used by all mesh construction functions.
 */

import * as THREE from 'three';
import { EDGE_MATERIAL } from './materials.js';

export function buildBoxGeometry(corners, baseZ, topZ) {
  var a = corners[0]; var b = corners[1]; var c = corners[2]; var d = corners[3];
  var verts = [
    a[0],a[1],baseZ, b[0],b[1],baseZ, c[0],c[1],baseZ, d[0],d[1],baseZ,
    a[0],a[1],topZ,  b[0],b[1],topZ,  c[0],c[1],topZ,  d[0],d[1],topZ
  ];
  var indices = [4,5,6,4,6,7, 0,3,2,0,2,1, 0,1,5,0,5,4, 1,2,6,1,6,5, 2,3,7,2,7,6, 3,0,4,3,4,7];
  var positions = []; var normals = [];
  for (var f = 0; f < 12; f++) {
    var i0=indices[f*3]; var i1=indices[f*3+1]; var i2=indices[f*3+2];
    var v0x=verts[i0*3];var v0y=verts[i0*3+1];var v0z=verts[i0*3+2];
    var v1x=verts[i1*3];var v1y=verts[i1*3+1];var v1z=verts[i1*3+2];
    var v2x=verts[i2*3];var v2y=verts[i2*3+1];var v2z=verts[i2*3+2];
    var e1x=v1x-v0x;var e1y=v1y-v0y;var e1z=v1z-v0z;
    var e2x=v2x-v0x;var e2y=v2y-v0y;var e2z=v2z-v0z;
    var nx=e1y*e2z-e1z*e2y;var ny=e1z*e2x-e1x*e2z;var nz=e1x*e2y-e1y*e2x;
    var nl=Math.sqrt(nx*nx+ny*ny+nz*nz);
    if(nl>1e-10){nx/=nl;ny/=nl;nz/=nl;}
    positions.push(v0x,v0y,v0z,v1x,v1y,v1z,v2x,v2y,v2z);
    normals.push(nx,ny,nz,nx,ny,nz,nx,ny,nz);
  }
  var geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geo.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
  return geo;
}

export function buildBoxEdges(corners, baseZ, topZ) {
  var a=corners[0];var b=corners[1];var c=corners[2];var d=corners[3];
  var p = [];
  p.push(a[0],a[1],baseZ,b[0],b[1],baseZ); p.push(b[0],b[1],baseZ,c[0],c[1],baseZ);
  p.push(c[0],c[1],baseZ,d[0],d[1],baseZ); p.push(d[0],d[1],baseZ,a[0],a[1],baseZ);
  p.push(a[0],a[1],topZ,b[0],b[1],topZ); p.push(b[0],b[1],topZ,c[0],c[1],topZ);
  p.push(c[0],c[1],topZ,d[0],d[1],topZ); p.push(d[0],d[1],topZ,a[0],a[1],topZ);
  p.push(a[0],a[1],baseZ,a[0],a[1],topZ); p.push(b[0],b[1],baseZ,b[0],b[1],topZ);
  p.push(c[0],c[1],baseZ,c[0],c[1],topZ); p.push(d[0],d[1],baseZ,d[0],d[1],topZ);
  var geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(p, 3));
  return new THREE.LineSegments(geo, EDGE_MATERIAL);
}

/**
 * Inset a polygon by margin using edge-normal intersection.
 * Used to create visible gaps between adjacent cells in 3D.
 */
export function insetPoly(poly, margin) {
  if (poly.length < 3 || margin <= 0) return poly;
  var n = poly.length;
  var inNormals = [];
  for (var i = 0; i < n; i++) {
    var a = poly[i]; var b = poly[(i+1)%n];
    var dx = b[0]-a[0]; var dy = b[1]-a[1];
    var len = Math.sqrt(dx*dx+dy*dy);
    if (len < 1e-10) { inNormals.push([0,0]); continue; }
    inNormals.push([dy/len, -dx/len]);
  }
  var result = [];
  for (var i = 0; i < n; i++) {
    var prev = (i-1+n)%n;
    var p0=poly[prev]; var p1=poly[i]; var n0=inNormals[prev];
    var a1x=p0[0]+n0[0]*margin; var a1y=p0[1]+n0[1]*margin;
    var a2x=p1[0]+n0[0]*margin; var a2y=p1[1]+n0[1]*margin;
    var p2=poly[i]; var p3=poly[(i+1)%n]; var n1=inNormals[i];
    var b1x=p2[0]+n1[0]*margin; var b1y=p2[1]+n1[1]*margin;
    var b2x=p3[0]+n1[0]*margin; var b2y=p3[1]+n1[1]*margin;
    var dax=a2x-a1x; var day=a2y-a1y;
    var dbx=b2x-b1x; var dby=b2y-b1y;
    var denom=dax*dby-day*dbx;
    if (Math.abs(denom)<1e-10) { result.push([a2x,a2y]); }
    else {
      var t=((b1x-a1x)*dby-(b1y-a1y)*dbx)/denom;
      result.push([a1x+dax*t,a1y+day*t]);
    }
  }
  return result;
}

/**
 * Inset polygon with per-edge margins.
 * margins[i] = inset for edge i (vertex i → vertex (i+1)%n).
 */
export function insetPolyPerEdge(poly, margins) {
  if (poly.length < 3) return poly;
  var n = poly.length;

  // Detect winding via signed area: CW < 0, CCW > 0
  var signedArea = 0;
  for (var i = 0; i < n; i++) {
    var a = poly[i]; var b = poly[(i+1)%n];
    signedArea += (a[0] * b[1] - b[0] * a[1]);
  }
  // flip = 1 if CW (normals already inward), -1 if CCW (need to reverse)
  var flip = signedArea < 0 ? 1 : -1;

  var inNormals = [];
  for (var i = 0; i < n; i++) {
    var a = poly[i]; var b = poly[(i+1)%n];
    var dx = b[0]-a[0]; var dy = b[1]-a[1];
    var len = Math.sqrt(dx*dx+dy*dy);
    if (len < 1e-10) { inNormals.push([0,0]); continue; }
    inNormals.push([dy/len * flip, -dx/len * flip]);
  }
  var result = [];
  for (var i = 0; i < n; i++) {
    var prev = (i-1+n)%n;
    var m0 = margins[prev] || 0;
    var m1 = margins[i] || 0;
    var p0=poly[prev]; var p1=poly[i]; var n0=inNormals[prev];
    var a1x=p0[0]+n0[0]*m0; var a1y=p0[1]+n0[1]*m0;
    var a2x=p1[0]+n0[0]*m0; var a2y=p1[1]+n0[1]*m0;
    var p2=poly[i]; var p3=poly[(i+1)%n]; var n1=inNormals[i];
    var b1x=p2[0]+n1[0]*m1; var b1y=p2[1]+n1[1]*m1;
    var b2x=p3[0]+n1[0]*m1; var b2y=p3[1]+n1[1]*m1;
    var dax=a2x-a1x; var day=a2y-a1y;
    var dbx=b2x-b1x; var dby=b2y-b1y;
    var denom=dax*dby-day*dbx;
    if (Math.abs(denom)<1e-10) { result.push([a2x,a2y]); }
    else {
      var t=((b1x-a1x)*dby-(b1y-a1y)*dbx)/denom;
      result.push([a1x+dax*t,a1y+day*t]);
    }
  }
  return result;
}
