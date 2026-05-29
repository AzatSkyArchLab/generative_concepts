/**
 * LibraryParamsPopup — draggable popup that edits a placed library
 * element's params.
 *
 * Generated entirely from `element.schema`. Supported param types
 * (matches elements/resolve.js coerceParam):
 *   number  → slider + numeric input (range = min..max, step)
 *   bool    → checkbox
 *   enum    → <select>
 *   color   → <input type=color>
 *
 * Schema-driven extras:
 *   spec.group   — section header (e.g. "Geometry", "Pattern", "Color")
 *   spec.depends — show only when the referenced key is truthy
 *   spec.affects — used by modules/library-elements/applyColors to
 *                  decide whether a change can hot-swap colors or
 *                  needs a full rebuild. The popup doesn't act on
 *                  this — it just emits the change.
 *   spec.label   — display label, defaults to key name
 *
 * Lifecycle: a single popup at a time. Opening with a different
 * feature id closes the previous one. Dragging is handled inline
 * (mousedown on header → set offset → move with mousemove).
 *
 * Param updates flow through commandManager so each slider tweak is
 * undoable. We debounce the command emission per key so a slider
 * drag doesn't pollute the undo stack with 50 micro-commands; one
 * compound-ish "set X" is recorded per key per drag (the first edit
 * captures the pre-drag value as the undo state, subsequent edits
 * during the same drag mutate forward).
 */

import { eventBus } from '../../core/EventBus.js';
import { commandManager } from '../../core/commands/CommandManager.js';
import { UpdateFeatureCommand } from '../../core/commands/UpdateFeatureCommand.js';
import { get as getElement } from '../../elements/registry.js';
import { resolveParams, coerceParam } from '../../elements/resolve.js';

var _ctx = null;
var _popup = null;
var _state = null;  // { id, element, params } when open
// Tracks the last "settled" value per key so we can collapse a
// drag-burst into one undoable command per key (see _emitChange).
var _pendingOldVals = {};
var _commitTimer = null;

/**
 * @param {{ featureStore, eventBus }} ctx
 */
export function initLibraryParamsPopup(ctx) {
  _ctx = ctx;
  eventBus.on('library-element:params:open', function (d) {
    if (!d || !d.id) return;
    openPopup(d.id);
  });
  eventBus.on('feature:removed', function (d) {
    if (_state && d && d.id === _state.id) closePopup();
  });
}

export function openPopup(featureId) {
  if (_popup) closePopup();
  var feat = _ctx.featureStore.get(featureId);
  if (!feat || feat.properties.type !== 'library-element') return;
  var element = getElement(feat.properties.elementId);
  if (!element || !element.schema) return;

  var params = resolveParams(element, {
    preset: feat.properties.preset,
    userParams: feat.properties.elementParams,
    styleTheme: feat.properties.styleTheme || null
  });

  _state = { id: featureId, element: element, params: params };
  _popup = buildPopup();
  document.body.appendChild(_popup);
}

export function closePopup() {
  flushPending();
  if (_popup && _popup.parentElement) _popup.parentElement.removeChild(_popup);
  _popup = null;
  _state = null;
  _rowsContainer = null;
  _pendingOldVals = {};
}

// ── DOM construction ────────────────────────────────────

function buildPopup() {
  var el = document.createElement('div');
  el.id = 'library-params-popup';
  el.style.cssText =
    'position:fixed;left:60px;top:80px;width:300px;max-height:80vh;'
    + 'background:var(--bg-primary);color:var(--text-primary);'
    + 'border:1px solid var(--border-color);border-radius:8px;'
    + 'box-shadow:0 12px 36px rgba(31,41,55,0.18);'
    + 'display:flex;flex-direction:column;z-index:9050;'
    + 'font-family:inherit;font-size:11px';

  // ── Header (drag handle) — matches panel-header look ──
  var header = document.createElement('div');
  header.className = 'panel-header';
  header.style.cssText =
    'cursor:move;user-select:none;position:relative;'
    + 'border-bottom:1px solid var(--border-color)';
  var title = document.createElement('span');
  title.className = 'panel-title';
  title.textContent = _state.element.name || _state.element.id;
  header.appendChild(title);

  var closeBtn = document.createElement('button');
  closeBtn.textContent = '✕';
  closeBtn.title = 'Close';
  closeBtn.style.cssText =
    'background:transparent;border:none;color:var(--text-muted);'
    + 'cursor:pointer;font-size:13px;line-height:1;padding:4px 6px;'
    + 'border-radius:4px;transition:all var(--transition-fast);margin-left:auto';
  closeBtn.addEventListener('mouseenter', function () {
    closeBtn.style.background = 'var(--bg-tertiary)';
    closeBtn.style.color = 'var(--text-primary)';
  });
  closeBtn.addEventListener('mouseleave', function () {
    closeBtn.style.background = 'transparent';
    closeBtn.style.color = 'var(--text-muted)';
  });
  closeBtn.addEventListener('click', closePopup);
  header.appendChild(closeBtn);
  el.appendChild(header);

  // ── Subhead ──
  var sub = document.createElement('div');
  sub.style.cssText =
    'padding:4px 12px 6px;font-size:10px;color:var(--text-muted);'
    + 'background:var(--bg-secondary);border-bottom:1px solid var(--border-color)';
  sub.innerHTML = 'id <span style="font-family:SF Mono,Fira Code,monospace">'
    + escapeHTML(_state.id.slice(0, 8)) + '…</span>'
    + (_state.element.typology ? ' · ' + escapeHTML(_state.element.typology) : '');
  el.appendChild(sub);

  // ── Body ──
  var body = document.createElement('div');
  body.className = 'panel-body';
  body.style.cssText = 'padding:0;overflow:auto;flex:1';
  el.appendChild(body);

  renderControls(body);

  makeDraggable(el, header);
  body.__libParamsRoot = body;
  return el;
}

// Tracks the rows container so applyDepends() can walk it without
// touching the module-level _popup (still null during initial build).
var _rowsContainer = null;

function renderControls(body) {
  _rowsContainer = body;
  var schema = _state.element.schema;
  var keys = Object.keys(schema);

  // Group by `group` field, preserving first-occurrence order.
  var groupOrder = [];
  var groups = {};
  for (var i = 0; i < keys.length; i++) {
    var g = schema[keys[i]].group || 'General';
    if (!groups[g]) { groups[g] = []; groupOrder.push(g); }
    groups[g].push(keys[i]);
  }

  for (var gi = 0; gi < groupOrder.length; gi++) {
    var groupName = groupOrder[gi];
    var section = document.createElement('div');
    section.className = 'param-section';
    section.style.cssText = 'padding:6px 0';
    var head = document.createElement('div');
    head.className = 'param-header';
    head.textContent = groupName;
    section.appendChild(head);

    var keysInGroup = groups[groupName];
    for (var ki = 0; ki < keysInGroup.length; ki++) {
      var k = keysInGroup[ki];
      var row = buildRow(k, schema[k]);
      if (row) section.appendChild(row);
    }
    body.appendChild(section);
  }

  // Initial dependency-driven visibility pass.
  applyDepends();
}

function buildRow(key, spec) {
  var row = document.createElement('div');
  row.className = 'param-row lib-param-row';
  row.dataset.key = key;
  if (spec.depends) row.dataset.depends = spec.depends;

  var label = document.createElement('label');
  label.className = 'param-label';
  // Strip "(m)", "(°)", "(floors)" etc. — render as a separate unit
  // span on the right side to mirror the apartment / section panels.
  var rawLabel = spec.label || key;
  var unitMatch = rawLabel.match(/^(.*?)\s*\(([^)]+)\)\s*$/);
  var displayLabel = unitMatch ? unitMatch[1] : rawLabel;
  var unitStr = unitMatch ? unitMatch[2] : '';
  label.textContent = displayLabel;
  row.appendChild(label);

  var ctrl = document.createElement('div');
  ctrl.className = 'param-input-wrap';
  row.appendChild(ctrl);

  var val = _state.params[key];

  if (spec.type === 'number') {
    var slider = document.createElement('input');
    slider.type = 'range';
    slider.min = spec.min != null ? spec.min : 0;
    slider.max = spec.max != null ? spec.max : 100;
    slider.step = spec.step != null ? spec.step : 1;
    slider.value = val;
    slider.style.cssText = 'width:80px;accent-color:var(--primary)';
    var num = document.createElement('input');
    num.className = 'param-input';
    num.type = 'number';
    num.min = slider.min; num.max = slider.max; num.step = slider.step;
    num.value = val;
    num.style.width = '48px';
    slider.addEventListener('input', function () {
      num.value = slider.value;
      _emitChange(key, +slider.value, spec);
    });
    num.addEventListener('change', function () {
      slider.value = num.value;
      _emitChange(key, +num.value, spec);
    });
    ctrl.appendChild(slider);
    ctrl.appendChild(num);
    if (unitStr) {
      var unit = document.createElement('span');
      unit.className = 'param-unit';
      unit.textContent = unitStr;
      ctrl.appendChild(unit);
    }
  } else if (spec.type === 'bool') {
    var cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = !!val;
    cb.style.accentColor = 'var(--primary)';
    cb.style.cursor = 'pointer';
    cb.addEventListener('change', function () {
      _emitChange(key, !!cb.checked, spec);
      applyDepends();
    });
    ctrl.appendChild(cb);
  } else if (spec.type === 'enum') {
    var sel = document.createElement('select');
    sel.className = 'param-select';
    var opts = spec.options || [];
    for (var oi = 0; oi < opts.length; oi++) {
      var opt = document.createElement('option');
      opt.value = opts[oi];
      opt.textContent = opts[oi];
      if (opts[oi] === val) opt.selected = true;
      sel.appendChild(opt);
    }
    sel.addEventListener('change', function () {
      _emitChange(key, sel.value, spec);
    });
    ctrl.appendChild(sel);
  } else if (spec.type === 'color') {
    var color = document.createElement('input');
    color.type = 'color';
    color.value = val || '#ffffff';
    color.style.cssText =
      'width:28px;height:22px;border:1px solid var(--border-color);'
      + 'border-radius:4px;background:var(--bg-primary);'
      + 'cursor:pointer;padding:0';
    color.addEventListener('input', function () {
      _emitChange(key, color.value, spec);
    });
    ctrl.appendChild(color);
  } else {
    var txt = document.createElement('span');
    txt.style.cssText = 'color:var(--text-muted);font-size:11px';
    txt.textContent = String(val);
    ctrl.appendChild(txt);
  }
  return row;
}

function applyDepends() {
  if (!_state) return;
  // Prefer the cached rows container (set during initial build, when
  // _popup is still null). Fall back to _popup once it's set so
  // post-build checkbox toggles still find the rows even if rendering
  // gets rebuilt later.
  var root = _rowsContainer || _popup;
  if (!root) return;
  var rows = root.querySelectorAll('.lib-param-row');
  for (var i = 0; i < rows.length; i++) {
    var dep = rows[i].dataset.depends;
    if (!dep) continue;
    var depVal = _state.params[dep];
    rows[i].style.display = depVal ? '' : 'none';
  }
}

// ── Drag ─────────────────────────────────────────────────

function makeDraggable(el, handle) {
  var dragging = false, sx = 0, sy = 0, sl = 0, st = 0;
  handle.addEventListener('mousedown', function (e) {
    if (e.target && e.target.tagName === 'BUTTON') return;
    dragging = true;
    sx = e.clientX; sy = e.clientY;
    sl = el.offsetLeft; st = el.offsetTop;
    document.body.style.userSelect = 'none';
    e.preventDefault();
  });
  document.addEventListener('mousemove', function (e) {
    if (!dragging) return;
    var nx = sl + (e.clientX - sx);
    var ny = st + (e.clientY - sy);
    // Clamp into viewport.
    nx = Math.max(0, Math.min(window.innerWidth - el.offsetWidth, nx));
    ny = Math.max(0, Math.min(window.innerHeight - el.offsetHeight, ny));
    el.style.left = nx + 'px';
    el.style.top = ny + 'px';
  });
  document.addEventListener('mouseup', function () {
    if (!dragging) return;
    dragging = false;
    document.body.style.userSelect = '';
  });
}

// ── Param change → store + emit ─────────────────────────

function _emitChange(key, rawValue, spec) {
  if (!_state) return;
  var value = coerceParam(spec, rawValue);
  _state.params[key] = value;

  var id = _state.id;
  var feat = _ctx.featureStore.get(id);
  if (!feat) return;
  var ep = Object.assign({}, feat.properties.elementParams || {});
  // Capture pre-drag old value the first time this key is touched
  // in the current burst — used by the debounced UpdateFeatureCommand.
  if (!(key in _pendingOldVals)) {
    _pendingOldVals[key] = ep[key];
  }
  ep[key] = value;

  // Apply immediately to the store so the render module hot-reacts;
  // the undoable command is scheduled below to collapse the drag.
  feat.properties.elementParams = ep;
  // Tell the render module which feature changed so it can take the
  // applyColors fast-path when applicable, full rebuild otherwise.
  eventBus.emit('library-element:params:changed', { id: id, key: key });

  // Debounced commit — every change inside 250 ms collapses into one
  // UpdateFeatureCommand. We snapshot the oldProps as the keys captured
  // in _pendingOldVals at the start of the burst.
  if (_commitTimer) clearTimeout(_commitTimer);
  _commitTimer = setTimeout(flushPending, 250);
}

function flushPending() {
  if (_commitTimer) { clearTimeout(_commitTimer); _commitTimer = null; }
  if (!_state) { _pendingOldVals = {}; return; }
  var keys = Object.keys(_pendingOldVals);
  if (keys.length === 0) return;
  var id = _state.id;
  var feat = _ctx.featureStore.get(id);
  if (!feat) { _pendingOldVals = {}; return; }
  var cur = Object.assign({}, feat.properties.elementParams || {});
  // Build old + new param maps relative to elementParams. We record
  // the change at the `elementParams` level (single property) so
  // undo restores everything we touched in the burst atomically.
  var oldEP = Object.assign({}, cur);
  for (var i = 0; i < keys.length; i++) oldEP[keys[i]] = _pendingOldVals[keys[i]];

  commandManager.execute(new UpdateFeatureCommand(
    _ctx.featureStore, id,
    { elementParams: cur },
    { elementParams: oldEP }
  ));
  _pendingOldVals = {};
}

function escapeHTML(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
