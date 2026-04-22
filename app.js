/**
 * U·B·SYSTEM — Entry Point
 */
import 'maplibre-gl/dist/maplibre-gl.css';
import './styles/main.css';
import './styles/insolation.css';
import './styles/metatiler.css';
import { eventBus } from './core/EventBus.js';
import { MapManager } from './map/MapManager.js';
import { DrawManager } from './draw/DrawManager.js';
import { featureStore } from './data/FeatureStore.js';
import { commandManager } from './core/commands/CommandManager.js';
import { RemoveFeatureCommand } from './core/commands/RemoveFeatureCommand.js';
import { CompoundCommand } from './core/commands/CompoundCommand.js';
import { Toolbar } from './ui/Toolbar.js';
import { StatusBar } from './ui/StatusBar.js';
import { FeaturePanel } from './ui/FeaturePanel.js';
import { CompassControl } from './ui/CompassControl.js';
import { ThreeOverlay } from './core/three/ThreeOverlay.js';
import { UrbanBlockTool, rebuildAllBlocks, rebuildBlockAxes, collectBlockFeatureIds } from './draw/tools/UrbanBlockTool.js';
import { SectionTool } from './draw/tools/SectionTool.js';
import { getBufferDefaults } from './ui/panels/BufferPanel.js';

// ── Modules (plug/unplug here) ─────────────────────────
// import urbanBlockModule from './modules/urban-block/index.js';
// section-distributor removed — code lives in urban-block
import sectionGenModule from './modules/section-gen/index.js';
import buffersModule from './modules/buffers/index.js';
import insolationModule from './modules/insolation/index.js';
import greenzoneModule from './modules/greenzone/index.js';
import metatilerModule from './modules/metatiler/index.js';
import { log } from './core/Logger.js';

var MODULES = [
  // urbanBlockModule,
  sectionGenModule,
  // Order matters for MapLibre render order: modules registered
  // earlier add layers first and sit BELOW later ones on the map.
  //
  //   greenzone  → painted fill below everything operational
  //   metatiler  → remote base data (kadastr + buildings) above green zone
  //   buffers    → fire/insol/end/road zones on top of base data
  //   insolation → rays and results on top of everything
  greenzoneModule,
  metatilerModule,
  buffersModule,
  insolationModule
];

// ── State ──────────────────────────────────────────────

var mapManager = null;
var drawManager = null;
var threeOverlay = null;

// ── Bootstrap ──────────────────────────────────────────

async function bootstrap() {
  try {
    // Seed the global buffer snapshot from BufferPanel defaults BEFORE
    // any UI renders or blocks are drawn. BufferPanel is the single
    // source of truth — both visual buffers (modules/buffers) and the
    // solver's axis-trimming buffers (UrbanBlockSolver via
    // UrbanBlockTool.getGlobalBufferDists) read from here. Key names
    // are BufferPanel-native (fire/end/insolation/road/insolCornerR);
    // the mapping to solver keys (fire/endB/insol) lives in keyMap
    // below.
    var bufDefs = getBufferDefaults();
    var solverSeed = {};
    if (bufDefs.fire != null) solverSeed.fire = bufDefs.fire;
    if (bufDefs.end != null) solverSeed.endB = bufDefs.end;
    if (bufDefs.insolation != null) solverSeed.insol = bufDefs.insolation;
    try { window.__UB_BUFFER_DISTS__ = solverSeed; } catch (_e) { /* no-op */ }

    mapManager = new MapManager('map');
    await mapManager.init();

    drawManager = new DrawManager(mapManager, featureStore);

    // Initialize Three.js overlay
    threeOverlay = new ThreeOverlay(mapManager);
    threeOverlay.init();

    // UI
    // Cascading delete — if any selected feature is an urban-block
    // polygon, sweep up its section-axis children and remove them in
    // a single undoable command. Also exposed via event so the block
    // properties panel can trigger the same flow from its Delete btn.
    function deleteFeatureIdsCascaded(ids) {
      if (!ids || ids.length === 0) return;
      var seen = {};
      var ordered = [];
      for (var i = 0; i < ids.length; i++) {
        var id = ids[i];
        var f = featureStore.get(id);
        if (!f) continue;
        if (f.properties && f.properties.urbanBlock) {
          var block = collectBlockFeatureIds(featureStore, id);
          for (var k = 0; k < block.length; k++) {
            if (!seen[block[k]]) { seen[block[k]] = true; ordered.push(block[k]); }
          }
        } else {
          if (!seen[id]) { seen[id] = true; ordered.push(id); }
        }
      }
      if (ordered.length === 0) return;
      var cmds = [];
      for (var c = 0; c < ordered.length; c++) {
        cmds.push(new RemoveFeatureCommand(featureStore, ordered[c]));
      }
      commandManager.execute(new CompoundCommand(cmds, 'Delete ' + ordered.length + ' feature(s)'));
    }

    var toolbar = new Toolbar('toolbar', function (toolId) {
      if (toolId === 'select') {
        drawManager.deactivateTool();
      } else {
        drawManager.activateTool(toolId);
      }
    }, function () {
      var ids = drawManager.getSelectedIds();
      deleteFeatureIdsCascaded(ids);
      drawManager.clearSelection();
    });
    toolbar.init();

    // Block properties panel fires this from its Delete button.
    eventBus.on('feature:delete-request', function (d) {
      if (!d || !d.id) return;
      deleteFeatureIdsCascaded([d.id]);
      drawManager.clearSelection();
    });

    // Shuffle axis contexts — randomizes per-edge context (0/1/2 = main
    // road / inner / back) by passing a fresh ctxRoll seed to the
    // solver. Each click picks a new seed and rebuilds the block.
    // Persisted in solverParams.ctxRoll so it survives buffer-slider
    // rebuilds and is visible in the properties panel.
    eventBus.on('block:shuffle-ctx', function (d) {
      if (!d || !d.id) return;
      var f = featureStore.get(d.id);
      if (!f || !f.properties.urbanBlock) return;
      var newRoll = 1 + Math.floor(Math.random() * 999999);
      try {
        rebuildBlockAxes(featureStore, f, { ctxRoll: newRoll });
      } catch (err) {
        console.error('[UB] shuffle failed:', err);
      }
    });

    var statusBar = new StatusBar('status-bar', featureStore);
    statusBar.init();

    var featurePanel = new FeaturePanel('feature-panel', featureStore);
    featurePanel.init();

    var compass = new CompassControl();
    compass.init(mapManager);

    eventBus.on('sidebar:feature:click', function (data) {
      var ids = drawManager.getSelectedIds();
      if (ids.indexOf(data.id) >= 0) {
        drawManager.clearSelection();
      } else {
        drawManager.selectFeature(data.id);
      }
    });

    // Block tool activation during section edit mode
    var _inEditMode = false;
    eventBus.on('section:edit-mode', function () {
      _inEditMode = true;
      drawManager.deactivateTool();
    });
    eventBus.on('section:edit-exit', function () { _inEditMode = false; });

    var _originalActivateTool = drawManager.activateTool.bind(drawManager);
    drawManager.activateTool = function (toolId) {
      if (_inEditMode) return;
      _originalActivateTool(toolId);
    };

    // Initialize modules with threeOverlay in context
    var moduleCtx = {
      mapManager: mapManager,
      eventBus: eventBus,
      featureStore: featureStore,
      commandManager: commandManager,
      threeOverlay: threeOverlay
    };
    for (var i = 0; i < MODULES.length; i++) {
      try {
        MODULES[i].init(moduleCtx);
      } catch (err) {
        console.error('Module "' + MODULES[i].id + '" failed to init:', err);
      }
    }

    eventBus.emit('app:ready');
    log.debug('U·B·SYSTEM started (' + MODULES.length + ' modules, Three.js enabled)');

    // Global toggle — "Gap on axes > 150m". Applies to NEW blocks and
    // sections. Kept as static fields on UrbanBlockTool / SectionTool
    // so both tools read the same state without extra plumbing.
    try { window.__UB_USE_GAP__ = false; } catch (_e) { /* SSR-safe */ }
    eventBus.on('axis-options:gap:toggle', function () {
      var next = !UrbanBlockTool.useGap;
      UrbanBlockTool.useGap = next;
      SectionTool.useGap = next;
      try { window.__UB_USE_GAP__ = next; } catch (_e) { /* no-op */ }
      eventBus.emit('axis-options:gap:changed', { useGap: next });
      var ind = document.getElementById('ax-gap-indicator');
      if (ind) {
        ind.textContent = next ? 'ON' : 'OFF';
        ind.style.color = next ? 'var(--primary)' : 'var(--text-muted)';
        ind.style.fontWeight = next ? '700' : '400';
      }
      // Apply new useGap to all existing blocks and rebuild them so
      // what the user sees matches the global toggle (inline semantics).
      var all = featureStore.toArray();
      for (var i = 0; i < all.length; i++) {
        var f = all[i];
        if (f.properties && f.properties.urbanBlock) f.properties.useGap = next;
      }
      try {
        var n = rebuildAllBlocks(featureStore, {});
        if (n > 0) log.debug('[UB] rebuilt ' + n + ' block(s) for useGap=' + next);
      } catch (err) {
        console.error('[UB] rebuild on gap toggle failed:', err);
      }
    });

    // Solver-affecting buffer params (fire, endB, insol) are fed from
    // the BufferPanel via window.__UB_BUFFER_DISTS__ (seeded at the top
    // of bootstrap, kept in sync by the listener below). BufferPanel
    // uses key 'insolation' while solver expects 'insol', and 'end'
    // while solver expects 'endB'. Normalize here.
    var keyMap = {
      fire: 'fire',
      insolation: 'insol',
      end: 'endB',
      road: 'road',
      insolCornerR: 'insolCornerR'
    };
    // Only these solver-affecting keys trigger rebuild. These buffers
    // are used by prioTrim/boundTrim in UrbanBlockSolver to cut off
    // overlapping axes — changing them moves sections around. Road
    // and insolCornerR don't touch the solver (visual-only).
    var rebuildKeys = { fire: true, endB: true, insol: true };

    var rebuildTimer = null;
    var pendingParams = {};
    eventBus.on('buffers:distance:changed', function (d) {
      if (!d || !d.key || d.value == null) return;
      var solverKey = keyMap[d.key];
      if (!solverKey) return;

      // Update global snapshot for new blocks.
      try {
        window.__UB_BUFFER_DISTS__ = window.__UB_BUFFER_DISTS__ || {};
        window.__UB_BUFFER_DISTS__[solverKey] = d.value;
      } catch (_e) { /* no-op */ }

      // Initial-emit after BufferPanel render — only populate snapshot,
      // do NOT rebuild existing blocks (there are none yet, and even
      // if there were, values match what was used to build them).
      if (d.initial) return;

      if (!rebuildKeys[solverKey]) return;
      pendingParams[solverKey] = d.value;

      // Debounce — slider input events fire on every keystroke.
      if (rebuildTimer) clearTimeout(rebuildTimer);
      rebuildTimer = setTimeout(function () {
        var override = pendingParams;
        pendingParams = {};
        rebuildTimer = null;
        try {
          var n = rebuildAllBlocks(featureStore, override);
          if (n > 0) log.debug('[UB] rebuilt ' + n + ' block(s) with ' + JSON.stringify(override));
        } catch (err) {
          console.error('[UB] rebuild failed:', err);
        }
      }, 250);
    });

  } catch (err) {
    console.error('Failed to start U·B·SYSTEM:', err);
    var el = document.getElementById('map');
    if (el) {
      el.innerHTML =
        '<div style="display:flex;align-items:center;justify-content:center;height:100%;color:#ef4444">' +
        '<div style="text-align:center"><h2>Failed to load</h2><p>' + (err.message || 'Unknown error') + '</p></div>' +
        '</div>';
    }
  }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', bootstrap);
} else {
  bootstrap();
}
