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
import { SunBar } from './ui/SunBar.js';
import { ThreeOverlay } from './core/three/ThreeOverlay.js';
import { UrbanBlockTool, rebuildAllBlocks, rebuildBlockAxes, collectBlockFeatureIds, computeBestCornerStartIdx } from './draw/tools/UrbanBlockTool.js';
import { SectionTool } from './draw/tools/SectionTool.js';
import { getBufferDefaults } from './ui/panels/BufferPanel.js';

// ── Modules (plug/unplug here) ─────────────────────────
import urbanBlock3DModule from './modules/urban-block/index.js';
// section-distributor removed — code lives in urban-block
import sectionGenModule from './modules/section-gen/index.js';
import sectionChainModule from './modules/section-chain/index.js';
import buffersModule from './modules/buffers/index.js';
import insolationModule from './modules/insolation/index.js';
import greenzoneModule from './modules/greenzone/index.js';
import metatilerModule from './modules/metatiler/index.js';
import playgroundsModule from './modules/playgrounds/index.js';
import aiRenderModule from './modules/ai-render/index.js';
import { log } from './core/Logger.js';

var MODULES = [
  urbanBlock3DModule,
  sectionGenModule,
  sectionChainModule,
  // greenzone is registered BEFORE buffers so its fill layer sits
  // underneath the buffer overlays (MapLibre render order = add order).
  // The zone is a backdrop; the red/blue/orange buffer strips should
  // read as overlays on top of it rather than underneath.
  greenzoneModule,
  // metatiler → remote base data (kadastr + buildings) above green zone,
  // below playground/buffer overlays.
  metatilerModule,
  // playgrounds sits on top of greenzone so its yellow/orange/violet
  // fills read as "playground zones inside the green zone", but still
  // underneath the buffer strips added by the buffers module.
  playgroundsModule,
  buffersModule,
  insolationModule,
  aiRenderModule
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
    // Dev hook for inspecting shadow / sun state from the console.
    try { window.__threeOverlay = threeOverlay; } catch (_e) { /* no-op */ }

    // UI
    // Cascading delete — if any selected feature is an urban-block
    // polygon, sweep up its section-axis children and remove them in
    // a single undoable command. Also exposed via event so the block
    // properties panel can trigger the same flow from its Delete btn.
    function deleteFeatureIdsCascaded(ids) {
      if (!ids || ids.length === 0) return;
      var seen = {};
      var ordered = [];
      function pushOnce(id) { if (!seen[id]) { seen[id] = true; ordered.push(id); } }
      function collectChainIds(chainId) {
        var arr = [chainId];
        var all = featureStore.toArray();
        for (var k = 0; k < all.length; k++) {
          var pp = all[k].properties;
          if (pp && pp.chainId === chainId &&
              (pp.type === 'section-axis' || pp.type === 'section-chain-corner')) {
            arr.push(pp.id);
          }
        }
        return arr;
      }
      for (var i = 0; i < ids.length; i++) {
        var id = ids[i];
        var f = featureStore.get(id);
        if (!f) continue;
        if (f.properties && f.properties.urbanBlock) {
          var block = collectBlockFeatureIds(featureStore, id);
          for (var k = 0; k < block.length; k++) pushOnce(block[k]);
        } else if (f.properties && f.properties.type === 'section-chain') {
          var chain = collectChainIds(id);
          for (var ci = 0; ci < chain.length; ci++) pushOnce(chain[ci]);
        } else {
          pushOnce(id);
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
      var override = {};
      var useCornersF = f.properties.useCorners === true;
      var useTowersF = f.properties.useTowers === true;
      var coords = f.geometry && f.geometry.coordinates && f.geometry.coordinates[0];
      var N = coords ? Math.max(1, coords.length - 1) : 1;  // closed ring → N+1 coords
      var prev = (f.properties.solverParams && f.properties.solverParams.cornersStartIdx) || 0;
      var nextIdx = (prev + 1) % N;
      var nextRoll = 1 + Math.floor(Math.random() * 999999);

      if (useTowersF && !useCornersF) {
        // Towers-only: cycle tower edge AND re-roll section context.
        // The chain isn't used here, but the per-edge solver still
        // arranges sections — rerolling its priority makes the
        // shuffle visibly do something even when only one edge
        // qualifies for a tower (so the tower itself doesn't move).
        override.cornersStartIdx = nextIdx;
        override.ctxRoll = nextRoll;
      } else if (useCornersF) {
        // Corners-only OR towers+corners: rotate the chain start /
        // tower-edge picker. ctxRoll doesn't apply — the chain
        // pipeline ignores it.
        override.cornersStartIdx = nextIdx;
      } else {
        // Plain sections-only: re-roll the priority solver's edge
        // context assignment.
        override.ctxRoll = nextRoll;
      }
      try {
        rebuildBlockAxes(featureStore, f, override);
      } catch (err) {
        console.error('[UB] shuffle failed:', err);
      }
    });

    // Target SPP edited in the block properties panel. We store the
    // new value in solverParams and trigger a rebuild so the
    // height-distributor runs on the next section-gen pass. Rebuild
    // is lightweight (pure geometry + axis layout) — section heights
    // come in at processor time.
    eventBus.on('block:target-spp:changed', function (d) {
      if (!d || !d.id) return;
      var f = featureStore.get(d.id);
      if (!f || !f.properties.urbanBlock) return;
      try {
        rebuildBlockAxes(featureStore, f, { targetSPP: d.value });
      } catch (err) {
        console.error('[UB] target-spp update failed:', err);
      }
    });

    var statusBar = new StatusBar('status-bar', featureStore);
    statusBar.init();

    var featurePanel = new FeaturePanel('feature-panel', featureStore);
    featurePanel.init();

    var compass = new CompassControl();
    compass.init(mapManager);

    // Sun controls — visible only in white-model mode. Wire its
    // event into ThreeOverlay.setSunConfig so dragging the slider
    // moves shadows in real time.
    var sunBar = new SunBar();
    sunBar.init();
    eventBus.on('sun:config:changed', function (cfg) {
      if (threeOverlay && cfg) threeOverlay.setSunConfig(cfg);
    });

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

    // Whitewash toggle from AptMixPanel (and any future trigger).
    // ThreeOverlay tracks the mode itself and re-applies the white
    // material to any meshes added afterwards, so we just forward
    // the state and let the overlay handle the rest.
    eventBus.on('whitewash:set', function (d) {
      if (!threeOverlay) return;
      var enabled = !!(d && d.enabled);
      threeOverlay.setWhitewash(enabled);
      // Broadcast the resulting state so any panel that owns a
      // White-model toggle can sync its button label/enabled flag.
      eventBus.emit('whitewash:changed', { enabled: enabled });
    });

    // Basemap switch — RenderPanel uses this to toggle between vector
    // (osm) and satellite raster for AI-render screenshots.
    eventBus.on('map:basemap:set', function (d) {
      if (!mapManager) return;
      var type = d && d.type;
      if (type !== 'osm' && type !== 'satellite') return;
      mapManager.setBasemap(type);
    });

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

    // Global toggles — "Gap on axes > 150m" and "Corners". Apply to
    // NEW blocks (and sections, for the gap toggle). Stored as static
    // fields on UrbanBlockTool / SectionTool so both tools read the
    // same state without extra plumbing.
    try {
      window.__UB_USE_GAP__ = false;
      window.__UB_USE_CORNERS__ = false;
    } catch (_e) { /* SSR-safe */ }
    // Toggle handlers — per-block when an urban-block is selected,
    // otherwise mutate the global default for the NEXT block created.
    // Each block stores its own useGap / useCorners / useTowers, so
    // blocks evolve independently.
    function getSelectedBlocks() {
      var sel = drawManager.getSelectedIds();
      var picks = [];
      for (var i = 0; i < sel.length; i++) {
        var f = featureStore.get(sel[i]);
        if (f && f.properties && f.properties.urbanBlock) picks.push(f);
      }
      return picks;
    }

    function rebuildOneBlock(f) {
      try {
        rebuildBlockAxes(featureStore, f, {});
      } catch (err) {
        console.error('[UB] rebuild failed for block ' + f.properties.id.slice(0, 6) + ':', err);
      }
    }

    eventBus.on('axis-options:gap:toggle', function () {
      var blocks = getSelectedBlocks();
      if (blocks.length === 0) {
        // No selection → flip the global default that drives the next
        // block (and any tools that read from UrbanBlockTool/SectionTool).
        var next = !UrbanBlockTool.useGap;
        UrbanBlockTool.useGap = next;
        SectionTool.useGap = next;
        try { window.__UB_USE_GAP__ = next; } catch (_e) { /* no-op */ }
        eventBus.emit('axis-options:gap:changed', { useGap: next });
        return;
      }
      // Per-block: flip each selected block's flag and rebuild it.
      for (var i = 0; i < blocks.length; i++) {
        var f = blocks[i];
        var nextV = !(f.properties.useGap === true);
        f.properties.useGap = nextV;
        if (f.properties.solverParams) f.properties.solverParams.useGap = nextV;
        rebuildOneBlock(f);
      }
      eventBus.emit('axis-options:gap:changed', {});
    });

    eventBus.on('axis-options:corners:toggle', function () {
      var blocks = getSelectedBlocks();
      if (blocks.length === 0) {
        // Global default — affects the next-created block only.
        var next = !UrbanBlockTool.useCorners;
        UrbanBlockTool.useCorners = next;
        try { window.__UB_USE_CORNERS__ = next; } catch (_e) { /* no-op */ }
        return;
      }
      for (var i = 0; i < blocks.length; i++) {
        var f = blocks[i];
        var nextV = !(f.properties.useCorners === true);
        f.properties.useCorners = nextV;
        // Auto-pick the start vertex when flipping ON for a block that
        // doesn't yet have one stored.
        if (nextV && f.properties.solverParams &&
            (f.properties.solverParams.cornersStartIdx === undefined ||
             f.properties.solverParams.cornersStartIdx === null)) {
          var coordsRing = f.geometry && f.geometry.coordinates && f.geometry.coordinates[0];
          if (coordsRing && coordsRing.length >= 4) {
            var ringPolyLL = coordsRing.slice(0, coordsRing.length - 1);
            try {
              f.properties.solverParams.cornersStartIdx =
                computeBestCornerStartIdx(ringPolyLL, f.properties.solverParams.sw);
            } catch (err) {
              console.warn('[UB] auto-pick on toggle failed:', err);
            }
          }
        }
        rebuildOneBlock(f);
      }
    });

    eventBus.on('axis-options:towers:toggle', function () {
      var blocks = getSelectedBlocks();
      if (blocks.length === 0) {
        var next = !UrbanBlockTool.useTowers;
        UrbanBlockTool.useTowers = next;
        try { window.__UB_USE_TOWERS__ = next; } catch (_e) { /* no-op */ }
        return;
      }
      for (var i = 0; i < blocks.length; i++) {
        var f = blocks[i];
        var nextV = !(f.properties.useTowers === true);
        f.properties.useTowers = nextV;
        rebuildOneBlock(f);
      }
    });

    // Balconies — per-block toggle. The mesh builder runs in the
    // section-gen pass, so flipping the flag triggers a rebuild that
    // rebuilds 3D + ray collision data for the block.
    eventBus.on('axis-options:balconies:toggle', function () {
      // Pick targets: explicitly selected balcony-eligible features,
      // or — if nothing's selected — every relevant feature on the
      // map (urban-blocks, section chains, and stand-alone sections).
      // Balconies are a visual decoration, so a single click should
      // affect the entire scene unless the user has narrowed scope
      // by selecting something specific.
      function eligible(f) {
        if (!f || !f.properties) return false;
        if (f.properties.urbanBlock) return true;
        if (f.properties.type === 'section-chain') return true;
        if (f.properties.type === 'section-axis') {
          // Skip sections that already inherit from a parent (block
          // or chain) — toggling their parent below covers them.
          if (f.properties.blockId || f.properties.chainId) return false;
          return true;
        }
        return false;
      }
      var sel = drawManager.getSelectedIds();
      var picks = [];
      for (var s = 0; s < sel.length; s++) {
        var f = featureStore.get(sel[s]);
        if (eligible(f)) picks.push(f);
      }
      var targets;
      if (picks.length > 0) {
        targets = picks;
      } else {
        targets = featureStore.toArray().filter(eligible);
      }
      if (targets.length === 0) {
        var next = !UrbanBlockTool.useBalconies;
        UrbanBlockTool.useBalconies = next;
        try { window.__UB_USE_BALCONIES__ = next; } catch (_e) { /* no-op */ }
        eventBus.emit('features:changed');
        return;
      }
      var nextV = !(targets[0].properties.useBalconies === true);
      for (var i = 0; i < targets.length; i++) {
        var t = targets[i];
        t.properties.useBalconies = nextV;
        if (nextV && !t.properties.balconyPattern) {
          t.properties.balconyPattern = 'staggered';
        }
      }
      UrbanBlockTool.useBalconies = nextV;
      try { window.__UB_USE_BALCONIES__ = nextV; } catch (_e) { /* no-op */ }
      log.debug('[balconies] toggled ' + (nextV ? 'ON' : 'OFF') + ' for '
        + targets.length + ' feature(s)' + (picks.length === 0 ? ' (no selection → all)' : ''));
      eventBus.emit('features:changed');
    });

    eventBus.on('axis-options:balcony-pattern:set', function (d) {
      var pattern = d && d.pattern;
      if (!pattern) return;
      function eligible(f) {
        if (!f || !f.properties) return false;
        if (f.properties.urbanBlock) return true;
        if (f.properties.type === 'section-chain') return true;
        if (f.properties.type === 'section-axis') {
          if (f.properties.blockId || f.properties.chainId) return false;
          return true;
        }
        return false;
      }
      var sel = drawManager.getSelectedIds();
      var picks = [];
      for (var s = 0; s < sel.length; s++) {
        var f = featureStore.get(sel[s]);
        if (eligible(f)) picks.push(f);
      }
      var targets = picks.length > 0 ? picks : featureStore.toArray().filter(eligible);
      try { window.__UB_BALCONY_PATTERN__ = pattern; } catch (_e) { /* no-op */ }
      if (targets.length === 0) return;
      for (var i = 0; i < targets.length; i++) {
        targets[i].properties.balconyPattern = pattern;
      }
      eventBus.emit('features:changed');
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
