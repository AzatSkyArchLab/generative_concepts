/**
 * Library element: tower-residential-v1
 *
 * Wraps the parametric-tower prototype as a library element. Pure
 * build(params, ctx) — no React, no state, no module side effects.
 * Materials are created locally per-instance so each placed tower
 * can carry its own color overrides; a future "shared block style"
 * pass can swap them through ctx.materials if desired.
 */

import * as THREE from 'three';
import {
  generateSections, buildSection, buildCore
} from './builders/index.js';

var SCHEMA = {
  // ─── Geometry ───
  planX:       { type: 'number', min: 18, max: 80, step: 1, default: 35, label: 'Plan X (m)', group: 'Geometry', affects: 'shape' },
  planY:       { type: 'number', min: 18, max: 80, step: 1, default: 45, label: 'Plan Y (m)', group: 'Geometry', affects: 'shape' },
  floors:      { type: 'number', min: 5,  max: 120, step: 1, default: 30, label: 'Floors', group: 'Geometry', affects: 'shape' },
  coreX:       { type: 'number', min: 4, max: 24, step: 0.5, default: 12, label: 'Core X (m)', group: 'Geometry', affects: 'shape' },
  coreY:       { type: 'number', min: 4, max: 24, step: 0.5, default: 10, label: 'Core Y (m)', group: 'Geometry', affects: 'shape' },
  planRotation:{ type: 'number', min: -45, max: 45, step: 1, default: 0, label: 'Plan rotation (°)', group: 'Geometry', affects: 'shape' },
  rotVariance: { type: 'number', min: 0, max: 12, step: 0.5, default: 3, label: 'Stack rotation variance (°)', group: 'Geometry', affects: 'shape' },
  seed:        { type: 'number', min: 1, max: 9999, step: 1, default: 42, label: 'Stack seed', group: 'Geometry', affects: 'shape' },

  // ─── Pattern: vertical fins ───
  finsEnabled: { type: 'bool', default: true, label: 'Vertical fins', group: 'Pattern', affects: 'shape' },
  finStep:     { type: 'number', min: 1, max: 12, step: 0.5, default: 6, label: 'Fin step (m)', group: 'Pattern', affects: 'shape', depends: 'finsEnabled' },
  finWidth:    { type: 'number', min: 0.2, max: 2, step: 0.1, default: 0.6, label: 'Fin width (m)', group: 'Pattern', affects: 'shape', depends: 'finsEnabled' },
  finDepth:    { type: 'number', min: 0.2, max: 2.5, step: 0.1, default: 1.0, label: 'Fin depth (m)', group: 'Pattern', affects: 'shape', depends: 'finsEnabled' },
  finColor:    { type: 'color', default: '#c9a063', label: 'Fin color', group: 'Color', affects: 'color' },

  // ─── Pattern: floor bands ───
  bandsEnabled: { type: 'bool', default: true, label: 'Floor bands', group: 'Pattern', affects: 'shape' },
  bandMode:     { type: 'enum', options: ['constant', 'progressive'], default: 'progressive', label: 'Band mode', group: 'Pattern', affects: 'shape', depends: 'bandsEnabled' },
  bandStep:     { type: 'number', min: 1, max: 10, step: 1, default: 3, label: 'Band step (floors)', group: 'Pattern', affects: 'shape', depends: 'bandsEnabled' },
  bandMinStep:  { type: 'number', min: 1, max: 8, step: 1, default: 2, label: 'Band min step', group: 'Pattern', affects: 'shape', depends: 'bandsEnabled' },
  bandMaxStep:  { type: 'number', min: 2, max: 10, step: 1, default: 4, label: 'Band max step', group: 'Pattern', affects: 'shape', depends: 'bandsEnabled' },

  // ─── Pattern: horizontal floor lines ───
  linesEnabled: { type: 'bool', default: true, label: 'Floor lines', group: 'Pattern', affects: 'shape' },
  lineHeight:   { type: 'number', min: 0.05, max: 0.6, step: 0.05, default: 0.15, label: 'Line height (m)', group: 'Pattern', affects: 'shape', depends: 'linesEnabled' },
  lineDepth:    { type: 'number', min: 0.1, max: 1, step: 0.05, default: 0.25, label: 'Line depth (m)', group: 'Pattern', affects: 'shape', depends: 'linesEnabled' },
  lineColor:    { type: 'color', default: '#ffffff', label: 'Line color', group: 'Color', affects: 'color' },

  // ─── Pattern: hex tiling ───
  hexEnabled:    { type: 'bool', default: false, label: 'Hex pattern', group: 'Pattern', affects: 'shape' },
  hexRadius:     { type: 'number', min: 0.5, max: 4, step: 0.1, default: 1.5, label: 'Hex radius (m)', group: 'Pattern', affects: 'shape', depends: 'hexEnabled' },
  hexFrameWidth: { type: 'number', min: 0.05, max: 0.6, step: 0.05, default: 0.2, label: 'Hex frame (m)', group: 'Pattern', affects: 'shape', depends: 'hexEnabled' },
  hexDepth:      { type: 'number', min: 0.1, max: 0.6, step: 0.05, default: 0.25, label: 'Hex depth (m)', group: 'Pattern', affects: 'shape', depends: 'hexEnabled' },

  // ─── Pattern: circle tiling ───
  circlesEnabled:    { type: 'bool', default: false, label: 'Circles pattern', group: 'Pattern', affects: 'shape' },
  circleRadius:      { type: 'number', min: 0.5, max: 4, step: 0.1, default: 1.2, label: 'Circle radius (m)', group: 'Pattern', affects: 'shape', depends: 'circlesEnabled' },
  circleFrameWidth:  { type: 'number', min: 0.05, max: 0.6, step: 0.05, default: 0.18, label: 'Circle frame (m)', group: 'Pattern', affects: 'shape', depends: 'circlesEnabled' },
  circleDepth:       { type: 'number', min: 0.1, max: 0.6, step: 0.05, default: 0.2, label: 'Circle depth (m)', group: 'Pattern', affects: 'shape', depends: 'circlesEnabled' },
  patternColor:      { type: 'color', default: '#e8e6e0', label: 'Pattern color', group: 'Color', affects: 'color' },

  // ─── Shared material colors ───
  facadeColor: { type: 'color', default: '#36424e', label: 'Facade color', group: 'Color', affects: 'color' },
  slabColor:   { type: 'color', default: '#c4bcae', label: 'Slab color', group: 'Color', affects: 'color' },
  coreColor:   { type: 'color', default: '#3a3530', label: 'Core color', group: 'Color', affects: 'color' }
};

var PRESETS = {
  'moscow-modern': {
    finsEnabled: true, finColor: '#b0a890',
    bandMode: 'progressive', linesEnabled: true,
    facadeColor: '#7a8590'
  },
  'brutalist': {
    finsEnabled: true, finColor: '#7a7570', finStep: 3,
    bandMode: 'constant', bandStep: 5,
    facadeColor: '#5a564f', slabColor: '#9a948a'
  },
  'glass-hex': {
    finsEnabled: false, bandsEnabled: false, linesEnabled: false,
    hexEnabled: true, hexRadius: 1.8,
    facadeColor: '#2a3640'
  }
};

function makeMaterials(params) {
  return {
    // ── Facade: tinted reflective glass ────────────────
    // Base colour reads CLEARLY (envMapIntensity tuned down so the
    // sky reflection is a subtle accent, not the dominant look —
    // otherwise every glassy surface ends up the same beige and the
    // tower reads as a single colour). Slight clearcoat keeps the
    // Fresnel highlight that says "glass" at grazing angles.
    facade: new THREE.MeshPhysicalMaterial({
      color: params.facadeColor,
      metalness: 0.0,
      roughness: 0.18,
      envMapIntensity: 0.55,
      clearcoat: 0.25,
      clearcoatRoughness: 0.18,
      side: THREE.DoubleSide
    }),
    // ── Slab: cast concrete ────────────────────────────
    slab: new THREE.MeshStandardMaterial({
      color: params.slabColor, roughness: 0.9, metalness: 0.0,
      envMapIntensity: 0.25
    }),
    // ── Core: matte concrete, slightly darker ─────────
    core: new THREE.MeshStandardMaterial({
      color: params.coreColor, roughness: 0.95, metalness: 0.0,
      envMapIntensity: 0.2
    }),
    // ── Fins: anodised aluminium ───────────────────────
    fin: new THREE.MeshStandardMaterial({
      color: params.finColor, roughness: 0.6, metalness: 0.8,
      envMapIntensity: 0.4
    }),
    // ── Floor lines: thin painted aluminium ───────────
    line: new THREE.MeshStandardMaterial({
      color: params.lineColor, roughness: 0.65, metalness: 0.35,
      envMapIntensity: 0.3
    }),
    // ── Pattern (hex/circle frames): polished stone ───
    pattern: new THREE.MeshStandardMaterial({
      color: params.patternColor, roughness: 0.55, metalness: 0.05,
      envMapIntensity: 0.3
    })
  };
}

/**
 * Pure builder. Returns one THREE.Group with the full tower. Local
 * coordinates: tower centered in X/Z at origin, base at y=0,
 * extending up by floors * 3 m.
 *
 * The library renderer takes the returned group and positions /
 * rotates it on the map according to the feature's lng/lat / rotation.
 */
export function build(params, ctx) {
  void ctx; // not yet used — material sharing comes later
  var group = new THREE.Group();
  var totalH = params.floors * 3;

  var materials = makeMaterials(params);
  // Stash materials on userData so the panel can mutate colors live
  // for 'affects: color' params without rebuilding geometry.
  group.userData.libraryMaterials = materials;

  var core = buildCore(params.coreX, params.coreY, totalH, materials.core);
  group.add(core);

  var floorsPerSection = Math.floor(params.floors / 3);
  var remainder = params.floors - floorsPerSection * 3;
  var sectionFloors = [floorsPerSection, floorsPerSection, floorsPerSection + remainder];
  var sections = generateSections(params.seed, params.rotVariance);

  var finsConfig = {
    enabled: params.finsEnabled, step: params.finStep,
    width: params.finWidth, depth: params.finDepth,
    bandsEnabled: params.bandsEnabled, bandMode: params.bandMode,
    bandStep: params.bandStep, bandMinStep: params.bandMinStep, bandMaxStep: params.bandMaxStep,
    linesEnabled: params.linesEnabled,
    lineHeight: params.lineHeight, lineDepth: params.lineDepth,
    hexEnabled: params.hexEnabled, hexRadius: params.hexRadius,
    hexFrameWidth: params.hexFrameWidth, hexDepth: params.hexDepth,
    circlesEnabled: params.circlesEnabled, circleRadius: params.circleRadius,
    circleFrameWidth: params.circleFrameWidth, circleDepth: params.circleDepth
  };

  var yCursor = 0;
  for (var i = 0; i < 3; i++) {
    var h = sectionFloors[i] * 3;
    var sec = sections[i];
    var sectionGroup = buildSection(
      params.planX, params.planY, h, materials, finsConfig, i
    );
    sectionGroup.position.set(sec.offsetX, yCursor, sec.offsetZ);
    sectionGroup.rotation.y = sec.rotation;
    group.add(sectionGroup);
    yCursor += h;
  }

  group.rotation.y = (params.planRotation * Math.PI) / 180;
  return group;
}

/**
 * Color-only update: mutate existing material colors without
 * touching geometry. Caller checks the schema's `affects` tag and
 * calls this for 'color' params, build() for 'shape'/'pattern'.
 */
export function applyColors(group, params) {
  if (!group || !group.userData || !group.userData.libraryMaterials) return false;
  var m = group.userData.libraryMaterials;
  if (m.facade)  m.facade.color.set(params.facadeColor);
  if (m.slab)    m.slab.color.set(params.slabColor);
  if (m.core)    m.core.color.set(params.coreColor);
  if (m.fin)     m.fin.color.set(params.finColor);
  if (m.line)    m.line.color.set(params.lineColor);
  if (m.pattern) m.pattern.color.set(params.patternColor);
  return true;
}

// ── Small SVG icon for the picker ────────────────────────
// Stylised "tower with offsets" — 3 stacked rectangles, slight
// shifts to evoke the prototype. Stroke width + caps match the
// global toolbar icon set (stroke-width:2, no fill, currentColor).
var ICON_SVG =
  '<svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round">'
  + '<rect x="7"  y="3"  width="9"  height="6"  rx="0.5"/>'
  + '<rect x="6"  y="9"  width="10" height="6"  rx="0.5"/>'
  + '<rect x="8"  y="15" width="9"  height="6"  rx="0.5"/>'
  + '</svg>';

export default {
  id: 'tower-residential-v1',
  name: 'Tower — residential (classic)',
  category: 'building/residential',
  typology: 'tower',
  version: 1,
  icon: ICON_SVG,
  schema: SCHEMA,
  presets: PRESETS,
  acceptedSubelements: [],
  defaultSubelements: {},
  build: build,
  applyColors: applyColors
};
