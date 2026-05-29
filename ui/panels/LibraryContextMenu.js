/**
 * LibraryContextMenu — floating action pill for the currently
 * selected library-element.
 *
 * Trigger: left-click the marker selects the feature (the existing
 * SelectTool path), which emits `feature:selected`. We catch that,
 * and if the selected feature is a `library-element` we show a
 * floating pill next to the marker with four actions:
 *
 *   Parameters · Move · Copy · Delete
 *
 * The pill follows the marker on map pan/zoom (via `map.on('move')`).
 * It is hidden whenever:
 *   – the selection is cleared,
 *   – the selection moves to a non-library feature,
 *   – the feature is removed.
 *
 * Move flow: pressing Move turns the menu into a "click the map to
 * place" mode with a banner. The next left click moves the feature
 * (undoable). Esc cancels.
 */

import { eventBus } from '../../core/EventBus.js';
import { commandManager } from '../../core/commands/CommandManager.js';
import { RemoveFeatureCommand } from '../../core/commands/RemoveFeatureCommand.js';
import { AddFeatureCommand } from '../../core/commands/AddFeatureCommand.js';

var _ctx = null;
var _pill = null;
var _activeId = null;
var _moveMode = null;  // { id } or null
var _moveHint = null;

/**
 * @param {{ mapManager, featureStore }} ctx
 */
/**
 * @param {{ mapManager, featureStore, drawManager }} ctx
 */
export function initLibraryContextMenu(ctx) {
  _ctx = ctx;
  if (!_ctx || !_ctx.mapManager) return;
  var map = _ctx.mapManager.getMap();
  if (!map) return;

  // Direct layer-level click hook — fires whenever a click lands on
  // a library-marker pixel, regardless of which DrawManager tool is
  // active. Without this we rely on SelectTool's queryRenderedFeatures
  // which is more fragile (z-order, hit-box, tool state). The halo
  // layer has an oversized invisible circle so the user gets a
  // generous hit-area without enlarging the visible dot.
  function onMarkerClick(e) {
    if (!e || !e.features || e.features.length === 0) return;
    var id = e.features[0].properties && e.features[0].properties.id;
    if (!id) return;
    // Route through DrawManager so the existing selection highlight
    // (features-selected line layer) draws, the FeaturePanel updates,
    // and `feature:selected` fires.
    if (_ctx.drawManager && typeof _ctx.drawManager.selectFeature === 'function') {
      _ctx.drawManager.selectFeature(id);
    } else {
      // Fallback — no drawManager wired, emit directly.
      eventBus.emit('feature:selected', { id: id });
    }
    // Stop the click from also reaching SelectTool's "click empty → clear".
    if (e.preventDefault) e.preventDefault();
    if (e.originalEvent) e.originalEvent.__libraryHandled = true;
  }
  map.on('click', 'features-library-marker', onMarkerClick);
  map.on('click', 'features-library-marker-halo', onMarkerClick);

  // Pointer cursor over the marker — visual affordance.
  map.on('mouseenter', 'features-library-marker-halo', function () {
    map.getCanvas().style.cursor = 'pointer';
  });
  map.on('mouseleave', 'features-library-marker-halo', function () {
    map.getCanvas().style.cursor = '';
  });

  eventBus.on('feature:selected', function (d) {
    if (!d || !d.id) { hidePill(); return; }
    var feat = _ctx.featureStore.get(d.id);
    if (!feat || !feat.properties || feat.properties.type !== 'library-element') {
      hidePill();
      return;
    }
    showPillFor(d.id);
  });

  eventBus.on('feature:deselected', function () { hidePill(); });
  eventBus.on('feature:removed', function (d) {
    if (_activeId && d && d.id === _activeId) hidePill();
  });

  // Track map movement so the pill stays glued to the marker.
  map.on('move', updatePillPosition);
  map.on('zoom', updatePillPosition);
  map.on('rotate', updatePillPosition);
  map.on('pitch', updatePillPosition);

  // Move-mode key handler (Esc cancels).
  document.addEventListener('keydown', onDocKey, true);

  // Map clicks while in move mode.
  eventBus.on('map:click', onMapClickWhileMoving);
}

// ── Pill lifecycle ──────────────────────────────────────

function showPillFor(featureId) {
  _activeId = featureId;
  if (!_pill) buildPill();
  updatePillPosition();
  _pill.style.display = 'flex';
}

function hidePill() {
  _activeId = null;
  if (_pill) _pill.style.display = 'none';
  // Don't auto-cancel move mode just because selection changed —
  // SelectTool may clear selection before delivering the click that
  // performs the move. cancelMove() is explicit (Esc / completion).
}

function buildPill() {
  var pill = document.createElement('div');
  pill.id = 'library-action-pill';
  pill.style.cssText =
    'position:fixed;display:none;align-items:center;gap:1px;'
    + 'background:var(--bg-primary);color:var(--text-primary);'
    + 'border:1px solid var(--border-color);'
    + 'border-radius:8px;box-shadow:0 6px 20px rgba(31,41,55,0.18);'
    + 'padding:3px;z-index:9100;font-size:11px;font-family:inherit;'
    + 'transform:translate(-50%, calc(-100% - 14px));'
    + 'pointer-events:auto;user-select:none';

  var items = [
    { id: 'params',  label: 'Parameters', accent: true },
    { id: 'move',    label: 'Move' },
    { id: 'copy',    label: 'Copy' },
    { id: 'delete',  label: 'Delete', danger: true }
  ];
  for (var i = 0; i < items.length; i++) {
    var it = items[i];
    var btn = document.createElement('button');
    btn.type = 'button';
    btn.textContent = it.label;
    btn.style.cssText =
      'background:transparent;border:none;cursor:pointer;'
      + 'padding:5px 10px;border-radius:5px;font-size:11px;font-weight:'
      + (it.accent ? '600' : '500')
      + ';color:' + (it.danger ? 'var(--danger)'
                    : it.accent ? 'var(--primary)'
                    : 'var(--text-secondary)')
      + ';transition:all var(--transition-fast)';
    btn.addEventListener('mouseenter', (function (item) {
      return function (e) {
        e.currentTarget.style.background = item.danger
          ? 'var(--danger-light)'
          : 'var(--bg-tertiary)';
        if (!item.danger) e.currentTarget.style.color = 'var(--text-primary)';
        if (item.accent) e.currentTarget.style.color = 'var(--primary-hover)';
      };
    })(it));
    btn.addEventListener('mouseleave', (function (item) {
      return function (e) {
        e.currentTarget.style.background = 'transparent';
        e.currentTarget.style.color = item.danger ? 'var(--danger)'
          : item.accent ? 'var(--primary)'
          : 'var(--text-secondary)';
      };
    })(it));
    btn.addEventListener('click', (function (action) {
      return function (ev) {
        ev.stopPropagation();
        if (_activeId) handleAction(_activeId, action);
      };
    })(it.id));
    pill.appendChild(btn);
    if (i < items.length - 1) {
      var sep = document.createElement('div');
      sep.style.cssText = 'width:1px;height:16px;background:var(--border-color)';
      pill.appendChild(sep);
    }
  }
  // Tiny pointer triangle under the pill — visual link to the marker.
  // Border layer first (darker) + fill on top to match the pill's
  // 1 px border-color seam.
  var arrowBorder = document.createElement('div');
  arrowBorder.style.cssText =
    'position:absolute;left:50%;bottom:-7px;transform:translateX(-50%);'
    + 'width:0;height:0;border-left:7px solid transparent;'
    + 'border-right:7px solid transparent;border-top:7px solid var(--border-color)';
  pill.appendChild(arrowBorder);
  var arrowFill = document.createElement('div');
  arrowFill.style.cssText =
    'position:absolute;left:50%;bottom:-5px;transform:translateX(-50%);'
    + 'width:0;height:0;border-left:6px solid transparent;'
    + 'border-right:6px solid transparent;border-top:6px solid var(--bg-primary)';
  pill.appendChild(arrowFill);

  document.body.appendChild(pill);
  _pill = pill;
}

function updatePillPosition() {
  if (!_pill || !_activeId || !_ctx) return;
  var feat = _ctx.featureStore.get(_activeId);
  if (!feat) { hidePill(); return; }
  var coords = feat.geometry && feat.geometry.coordinates;
  if (!coords || coords.length < 2) return;
  var map = _ctx.mapManager.getMap();
  if (!map) return;
  var pt = map.project([coords[0], coords[1]]);
  var rect = map.getCanvas().getBoundingClientRect();
  _pill.style.left = (rect.left + pt.x) + 'px';
  _pill.style.top  = (rect.top  + pt.y) + 'px';
}

// ── Action handlers ─────────────────────────────────────

function handleAction(id, action) {
  if (action === 'delete') return doDelete(id);
  if (action === 'copy')   return doCopy(id);
  if (action === 'move')   return startMove(id);
  if (action === 'params') return openParams(id);
}

function doDelete(id) {
  if (!_ctx) return;
  commandManager.execute(new RemoveFeatureCommand(_ctx.featureStore, id));
}

function doCopy(id) {
  if (!_ctx) return;
  var src = _ctx.featureStore.get(id);
  if (!src) return;
  var coords = src.geometry && src.geometry.coordinates;
  if (!coords || coords.length < 2) return;

  // Offset ~10 m east at the current latitude. 1° lng ≈ 111320·cos(lat) m.
  var latRad = coords[1] * Math.PI / 180;
  var mPerDegLng = 111320 * Math.cos(latRad);
  var dLng = 10 / Math.max(mPerDegLng, 1);

  var newId = (typeof crypto !== 'undefined' && crypto.randomUUID)
    ? crypto.randomUUID()
    : 'le-' + Date.now() + '-' + Math.floor(Math.random() * 1e6);

  var clone = {
    type: 'Feature',
    properties: Object.assign({}, src.properties, {
      id: newId,
      createdAt: new Date().toISOString(),
      elementParams: Object.assign({}, src.properties.elementParams || {})
    }),
    geometry: {
      type: 'Point',
      coordinates: [coords[0] + dLng, coords[1]]
    }
  };
  commandManager.execute(new AddFeatureCommand(_ctx.featureStore, clone));
}

function startMove(id) {
  if (!_ctx) return;
  var feat = _ctx.featureStore.get(id);
  if (!feat) return;
  _moveMode = { id: id };
  showMoveHint();
  try { _ctx.mapManager.lockCursor('crosshair'); } catch (_e) { /* no-op */ }
  eventBus.emit('library-element:move-start', { id: id });
}

function onMapClickWhileMoving(e) {
  if (!_moveMode || !_ctx) return;
  var id = _moveMode.id;
  var feat = _ctx.featureStore.get(id);
  if (!feat) { cancelMove(); return; }
  var oldCoords = feat.geometry && feat.geometry.coordinates;
  if (!oldCoords) { cancelMove(); return; }
  var newCoords = [e.lngLat.lng, e.lngLat.lat];

  var store = _ctx.featureStore;
  var oldGeom = { type: 'Point', coordinates: oldCoords.slice() };
  var newGeom = { type: 'Point', coordinates: newCoords };
  commandManager.execute({
    description: 'Move library element',
    execute: function () {
      var f = store.get(id);
      if (!f) return;
      f.geometry = newGeom;
      store.update(id, { _movedAt: new Date().toISOString() });
    },
    undo: function () {
      var f = store.get(id);
      if (!f) return;
      f.geometry = oldGeom;
      store.update(id, { _movedAt: new Date().toISOString() });
    }
  });
  cancelMove();
}

function cancelMove() {
  _moveMode = null;
  hideMoveHint();
  if (_ctx && _ctx.mapManager) {
    try { _ctx.mapManager.unlockCursor(); } catch (_e) { /* no-op */ }
  }
}

function onDocKey(e) {
  if (e.key === 'Escape' && _moveMode) {
    cancelMove();
    eventBus.emit('library-element:move-cancel');
  }
}

function openParams(id) {
  eventBus.emit('library-element:params:open', { id: id });
}

// ── Move-mode hint banner ───────────────────────────────

function showMoveHint() {
  if (_moveHint) return;
  var el = document.createElement('div');
  el.id = 'library-move-hint';
  el.style.cssText =
    'position:fixed;left:50%;top:16px;transform:translateX(-50%);'
    + 'background:var(--primary);color:#fff;padding:6px 14px;'
    + 'border-radius:6px;z-index:9100;font-size:11px;font-weight:600;'
    + 'box-shadow:0 4px 14px rgba(59,130,246,0.35);font-family:inherit';
  el.textContent = 'Click on the map to place — Esc to cancel';
  document.body.appendChild(el);
  _moveHint = el;
}
function hideMoveHint() {
  if (_moveHint && _moveHint.parentElement) _moveHint.parentElement.removeChild(_moveHint);
  _moveHint = null;
}
