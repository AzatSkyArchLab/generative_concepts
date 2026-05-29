/**
 * library-elements — 3D render module for parametric library elements.
 *
 * Reads features with `properties.type === 'library-element'` from
 * the feature store, looks up the corresponding element module in
 * the registry, resolves params through the precedence chain, and
 * builds / positions / disposes THREE meshes accordingly.
 *
 * The element module is treated as a black box — we never import its
 * geometry or assume internal structure beyond the public contract:
 *
 *   element.build(params, ctx)  → THREE.Object3D  (required)
 *   element.applyColors(group, params)            (optional)
 *
 * Coordinate frame: each element's `build()` returns a group in
 * **local** meters, base at y=0, footprint centred on the origin.
 * We project the feature's lng/lat to local meters using the same
 * shared origin section-gen uses (so library elements line up with
 * sections / towers / context buildings) and translate the group
 * accordingly. If section-gen has never run, we seed the origin
 * from the first library-element feature so it still works in a
 * standalone scene with nothing else placed.
 *
 * Persistence across section-gen's scene clear: the cached group is
 * tagged `userData.preserveOnClear = true`, matching the contract
 * already used by context buildings, section-chain corners, etc.
 *
 * Event contract:
 *   features:changed                    — full reconciliation
 *   section-gen:origin                  — adopt new stable origin
 *   library-element:params:changed { id } — fast hot-update for the
 *                                            params popup. Falls back
 *                                            to full rebuild if the
 *                                            element didn't expose
 *                                            applyColors or the change
 *                                            touches a `shape` param.
 *   library-element:rebuild { id? }     — force rebuild of one / all
 */

import * as THREE from 'three';
import { get as getElement } from '../../elements/registry.js';
import { resolveParams } from '../../elements/resolve.js';
import { createProjection } from '../../core/geo/projection.js';

var module_ = {
  id: 'library-elements',

  init: function (ctx) {
    var self = this;
    this._ctx = ctx;
    this._origin = null;
    // featureId → { group, elementId, paramsHash, schema, lng, lat, rotation }
    this._cache = {};

    ctx.eventBus.on('section-gen:origin', function (origin) {
      if (!origin || origin.length < 2) return;
      var changed = !self._origin
        || Math.abs(self._origin[0] - origin[0]) > 1e-9
        || Math.abs(self._origin[1] - origin[1]) > 1e-9;
      self._origin = [origin[0], origin[1]];
      // Re-place every cached group with the new origin. We don't
      // rebuild geometry — only translate roots.
      if (changed) self._reprojectAll();
    });

    ctx.eventBus.on('features:changed', function () {
      self._reconcile();
    });

    // section-gen.processor.clear() wipes the scene; section-chain
    // pattern: re-stamp on rebuilt. Our groups carry preserveOnClear,
    // but a fallback rebuild is cheap insurance against accidental
    // disposal in any future scene-clear path that ignores the flag.
    ctx.eventBus.on('section-gen:rebuilt', function () {
      self._restampMissing();
    });

    ctx.eventBus.on('library-element:params:changed', function (d) {
      if (!d || !d.id) return;
      self._applyParamChange(d.id);
    });

    ctx.eventBus.on('library-element:rebuild', function (d) {
      if (d && d.id) self._rebuildOne(d.id);
      else self._rebuildAll();
    });

    // Defensive whitewash reconciliation. ThreeOverlay.setWhitewash
    // does a full-scene traverse and SHOULD pick up our subtrees, but
    // we re-apply on every WM toggle as belt-and-suspenders: it's
    // idempotent (subsequent passes find userData.origMat already
    // stashed and just confirm the swap) and guarantees correctness
    // when a library element is built between a WM toggle and the
    // overlay's traverse, or if some future scene-clear path
    // re-attaches a subtree without reconciling.
    ctx.eventBus.on('whitewash:changed', function (d) {
      self._reapplyWhitewash(!!(d && d.enabled));
    });
  },

  /**
   * Force-apply the current whitewash state to every cached library
   * element subtree. Idempotent — mirrors ThreeOverlay._whitewashOne
   * for the tower-mesh case, but runs against our owned cache so we
   * don't depend on the scene-graph traversal landing here.
   */
  _reapplyWhitewash: function (enabled) {
    var overlay = this._ctx.threeOverlay;
    if (!overlay) return;
    var ids = Object.keys(this._cache);
    for (var i = 0; i < ids.length; i++) {
      var entry = this._cache[ids[i]];
      if (!entry || !entry.group) continue;
      entry.group.traverse(function (o) {
        // Delegate to the overlay's own per-mesh routine — keeps the
        // logic (warm-beige vs plain white, origMat stashing) in one
        // place. _whitewashOne is safe to call repeatedly per object.
        if (overlay._whitewashOne) overlay._whitewashOne(o, enabled);
      });
    }
    overlay.requestRender();
  },

  destroy: function () {
    var ids = Object.keys(this._cache);
    for (var i = 0; i < ids.length; i++) this._disposeEntry(ids[i]);
    this._cache = {};
  },

  // ── Reconciliation ────────────────────────────────────

  _reconcile: function () {
    var store = this._ctx.featureStore;
    var all = store.toArray();
    var seen = {};

    // First pass — collect library-element features, lazy-seed origin
    // if section-gen hasn't established one yet.
    var feats = [];
    for (var i = 0; i < all.length; i++) {
      var f = all[i];
      if (!f || !f.properties) continue;
      if (f.properties.type !== 'library-element') continue;
      feats.push(f);
    }
    if (feats.length === 0) {
      // Sweep — nothing left. Tear down all cached groups.
      var ids = Object.keys(this._cache);
      for (var k = 0; k < ids.length; k++) this._disposeEntry(ids[k]);
      this._cache = {};
      return;
    }

    if (!this._origin) {
      var first = feats[0];
      var coord = first.geometry && first.geometry.coordinates;
      if (coord && coord.length >= 2) {
        this._origin = [coord[0], coord[1]];
        var overlay = this._ctx.threeOverlay;
        if (overlay && !overlay._originSet) {
          overlay.setOrigin(this._origin[0], this._origin[1]);
        }
      }
    }
    if (!this._origin) return;

    for (var j = 0; j < feats.length; j++) {
      var feat = feats[j];
      var id = feat.properties.id;
      seen[id] = true;
      this._upsert(feat);
    }

    // Sweep — drop any cached entry whose feature is gone.
    var cachedIds = Object.keys(this._cache);
    for (var c = 0; c < cachedIds.length; c++) {
      if (!seen[cachedIds[c]]) this._disposeEntry(cachedIds[c]);
    }
  },

  _restampMissing: function () {
    var overlay = this._ctx.threeOverlay;
    if (!overlay) return;
    var ids = Object.keys(this._cache);
    for (var i = 0; i < ids.length; i++) {
      var entry = this._cache[ids[i]];
      if (!entry || !entry.group) continue;
      // If the group was removed from the scene (e.g. someone bypassed
      // preserveOnClear), re-attach it. Three.js sets parent to null
      // on remove(), so this check is reliable.
      if (!entry.group.parent) overlay.addMesh(entry.group);
    }
  },

  _reprojectAll: function () {
    if (!this._origin) return;
    var proj = createProjection(this._origin[0], this._origin[1]);
    var ids = Object.keys(this._cache);
    var store = this._ctx.featureStore;
    for (var i = 0; i < ids.length; i++) {
      var entry = this._cache[ids[i]];
      var f = store.get(ids[i]);
      if (!entry || !entry.group || !f) continue;
      var c = f.geometry && f.geometry.coordinates;
      if (!c || c.length < 2) continue;
      var m = proj.toMeters(c[0], c[1]);
      // Scene convention: X = east, Y = north (mercator Y inverted by
      // the overlay's modelMatrix scale (s, -s, s)), Z = up. So we
      // place at (mx, my, 0) — same convention used by section-chain
      // corners and context-buildings.
      entry.group.position.set(m[0], m[1], 0);
    }
    if (this._ctx.threeOverlay) this._ctx.threeOverlay.requestRender();
  },

  // ── Per-feature upsert ────────────────────────────────

  _upsert: function (feat) {
    var p = feat.properties || {};
    var id = p.id;
    var elementId = p.elementId;
    if (!elementId) return;
    var element = getElement(elementId);
    if (!element || typeof element.build !== 'function') {
      console.warn('[library-elements] no element registered for "' + elementId + '"');
      return;
    }

    var params = resolveParams(element, {
      preset: p.preset,
      userParams: p.elementParams,
      styleTheme: p.styleTheme || null
    });
    var hash = this._hashParams(params);
    var rotation = (typeof p.rotation === 'number') ? p.rotation : 0;

    var coords = feat.geometry && feat.geometry.coordinates;
    if (!coords || coords.length < 2) return;
    var lng = coords[0], lat = coords[1];

    var entry = this._cache[id];
    if (entry && entry.elementId === elementId && entry.paramsHash === hash) {
      // Geometry is unchanged — only refresh transform if lng/lat or
      // rotation moved.
      if (entry.lng !== lng || entry.lat !== lat || entry.rotation !== rotation) {
        this._placeEntry(entry, lng, lat, rotation);
      }
      return;
    }

    // Rebuild from scratch. Dispose the old group first.
    if (entry) this._disposeEntry(id);

    var group;
    try {
      group = element.build(params, { THREE: THREE });
    } catch (err) {
      console.error('[library-elements] build() failed for ' + elementId + ':', err);
      return;
    }
    if (!group || !group.isObject3D) {
      console.warn('[library-elements] ' + elementId + '.build() returned non-Object3D');
      return;
    }

    // Scene convention: X = east, Y = north, Z = up. Parametric
    // elements (e.g. tower-residential-v1) build in their own local
    // frame with Y as up (yCursor stacks floors along +Y). We insert
    // a `tilt` group that rotates +π/2 around X so the element's
    // local +Y maps to world +Z — towers point at the sky instead
    // of lying flat on the ground pointing north.
    //
    // Hierarchy:
    //   root  — positioned at (mx, my, 0); feature rotation around Z
    //     tilt  — rotation.x = +π/2  (Y-up → Z-up)
    //       group  — what element.build() returned
    var root = new THREE.Group();
    var tilt = new THREE.Group();
    tilt.rotation.x = Math.PI / 2;
    tilt.add(group);
    root.add(tilt);
    root.userData.preserveOnClear = true;
    root.userData.isLibraryElement = true;
    root.userData.libraryElementId = elementId;
    root.userData.featureId = id;
    // Keep the inner group reachable for applyColors().
    root.userData.libraryInner = group;
    // Library elements own their materials (set per-instance inside
    // element.build) and are meant to be seen with full colours even
    // in Render-mode — that mode is exactly the moment to showcase
    // them. We tag THREE things so ThreeOverlay's _whitewashOne
    // bails out at every check it might use:
    //   1. mesh.userData.skipWhitewash    (per-mesh check)
    //   2. material.userData.skipWhitewash (per-material check — survives
    //                                       material sharing between meshes)
    //   3. mesh.userData.preserveOnClear  (already set on root, but make
    //                                       sure children also survive
    //                                       section-gen's scene clear)
    // The env map (scene.environment) still drives PBR reflections,
    // and fog still applies on depth — those are scene-level, not
    // material overrides.
    root.traverse(function (obj) {
      if (!obj || !obj.userData) return;
      obj.userData.skipWhitewash = true;
      obj.userData.preserveOnClear = true;
      if (obj.isMesh && obj.material) {
        var mats = Array.isArray(obj.material) ? obj.material : [obj.material];
        for (var mi = 0; mi < mats.length; mi++) {
          var m = mats[mi];
          if (m) {
            m.userData = m.userData || {};
            m.userData.skipWhitewash = true;
          }
        }
      }
    });

    // Tag every Mesh in the subtree as a tower mesh so ThreeOverlay's
    // whitewash pass swaps it to the warm-beige _whiteTowerMat (same
    // treatment urban-block towers get) instead of the default white.
    // Also stash a back-reference to the original element materials so
    // we can do our own defensive whitewash sweep below if needed.
    group.traverse(function (o) {
      if (o.isMesh) {
        o.userData.isTowerMesh = true;
        o.userData.isLibraryElementMesh = true;
      }
    });

    this._cache[id] = {
      group: root,
      elementId: elementId,
      paramsHash: hash,
      schema: element.schema || null,
      lng: lng,
      lat: lat,
      rotation: rotation
    };
    this._placeEntry(this._cache[id], lng, lat, rotation);

    var overlay = this._ctx.threeOverlay;
    if (overlay) {
      overlay.addMesh(root);
      overlay.requestRender();
    }
  },

  _placeEntry: function (entry, lng, lat, rotation) {
    if (!this._origin) return;
    var proj = createProjection(this._origin[0], this._origin[1]);
    var m = proj.toMeters(lng, lat);
    // Scene up is +Z (see _upsert) — feature position lives at z=0.
    entry.group.position.set(m[0], m[1], 0);
    // The element's own build() may already apply a planRotation
    // (e.g. tower-residential-v1 reads params.planRotation and rotates
    // the inner group around its local Y). The feature-level
    // `rotation` is a SEPARATE outer rotation applied around the
    // world's up axis (Z) — keep them on distinct frames so neither
    // cancels the other.
    entry.group.rotation.z = (rotation || 0) * Math.PI / 180;
    entry.lng = lng;
    entry.lat = lat;
    entry.rotation = rotation;
  },

  // ── Param-change fast path ────────────────────────────

  _applyParamChange: function (id) {
    var entry = this._cache[id];
    var store = this._ctx.featureStore;
    var feat = store.get(id);
    if (!entry || !feat) {
      // No cache yet — defer to reconcile.
      this._reconcile();
      return;
    }
    var p = feat.properties || {};
    var element = getElement(entry.elementId);
    if (!element) return;
    var newParams = resolveParams(element, {
      preset: p.preset,
      userParams: p.elementParams,
      styleTheme: p.styleTheme || null
    });
    var newHash = this._hashParams(newParams);
    if (newHash === entry.paramsHash) {
      // Maybe just position/rotation changed.
      var c = feat.geometry && feat.geometry.coordinates;
      if (c && c.length >= 2) {
        this._placeEntry(entry, c[0], c[1],
          (typeof p.rotation === 'number') ? p.rotation : 0);
        if (this._ctx.threeOverlay) this._ctx.threeOverlay.requestRender();
      }
      return;
    }

    // Color-only fast path — only if the schema marks every
    // changed key as `affects: 'color'` AND the element exposes
    // applyColors().
    if (typeof element.applyColors === 'function' && entry.schema) {
      var oldParams = this._lastParams(id);
      if (this._onlyColorChanged(entry.schema, oldParams, newParams)) {
        var inner = entry.group.userData.libraryInner;
        if (inner) {
          try { element.applyColors(inner, newParams); }
          catch (err) { console.warn('[library-elements] applyColors failed, falling back to rebuild', err); }
        }
        entry.paramsHash = newHash;
        this._stashParams(id, newParams);
        if (this._ctx.threeOverlay) this._ctx.threeOverlay.requestRender();
        return;
      }
    }

    // Shape change — full rebuild.
    this._rebuildOne(id);
  },

  _rebuildOne: function (id) {
    var feat = this._ctx.featureStore.get(id);
    if (!feat) { this._disposeEntry(id); return; }
    // Disposing first forces _upsert to take the rebuild branch.
    this._disposeEntry(id);
    this._upsert(feat);
  },

  _rebuildAll: function () {
    var ids = Object.keys(this._cache);
    for (var i = 0; i < ids.length; i++) this._disposeEntry(ids[i]);
    this._cache = {};
    this._reconcile();
  },

  _disposeEntry: function (id) {
    var entry = this._cache[id];
    if (!entry) return;
    var overlay = this._ctx.threeOverlay;
    if (overlay && entry.group) {
      overlay.removeMesh(entry.group);
      try { overlay._disposeDeep(entry.group); } catch (_e) { /* no-op */ }
    }
    delete this._cache[id];
    if (this._paramSnapshots) delete this._paramSnapshots[id];
  },

  // ── Small helpers ─────────────────────────────────────

  /**
   * Cheap deterministic fingerprint for a params object. Used to
   * detect whether anything changed without diffing key-by-key.
   * Order-stable so two equivalent objects produce the same hash.
   */
  _hashParams: function (params) {
    if (!params) return '';
    var keys = Object.keys(params).sort();
    var parts = [];
    for (var i = 0; i < keys.length; i++) {
      var k = keys[i];
      parts.push(k + '=' + this._stringifyVal(params[k]));
    }
    return parts.join('|');
  },
  _stringifyVal: function (v) {
    if (v == null) return '';
    if (typeof v === 'number') return (Math.round(v * 1000) / 1000).toString();
    if (typeof v === 'boolean') return v ? '1' : '0';
    return String(v);
  },

  _stashParams: function (id, params) {
    if (!this._paramSnapshots) this._paramSnapshots = {};
    this._paramSnapshots[id] = params;
  },
  _lastParams: function (id) {
    return this._paramSnapshots ? this._paramSnapshots[id] : null;
  },

  /**
   * Return true if every param whose value differs between old/new
   * is tagged `affects: 'color'` in the schema. Missing schema entries
   * are treated as 'shape' (safe default).
   */
  _onlyColorChanged: function (schema, oldP, newP) {
    if (!oldP) return false; // no baseline → can't be sure
    var keys = {};
    for (var a in oldP) keys[a] = true;
    for (var b in newP) keys[b] = true;
    var changed = [];
    for (var k in keys) {
      if (oldP[k] !== newP[k]) changed.push(k);
    }
    if (changed.length === 0) return true;
    for (var i = 0; i < changed.length; i++) {
      var spec = schema[changed[i]];
      if (!spec || spec.affects !== 'color') return false;
    }
    return true;
  }
};

export default module_;
