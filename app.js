/**
 * U·B·SYSTEM — Entry Point
 */
import 'maplibre-gl/dist/maplibre-gl.css';
import './styles/main.css';
import './styles/insolation.css';
import { eventBus } from './core/EventBus.js';
import { MapManager } from './map/MapManager.js';
import { DrawManager } from './draw/DrawManager.js';
import { featureStore } from './data/FeatureStore.js';
import { commandManager } from './core/commands/CommandManager.js';
import { RemoveFeatureCommand } from './core/commands/RemoveFeatureCommand.js';
import { Toolbar } from './ui/Toolbar.js';
import { StatusBar } from './ui/StatusBar.js';
import { FeaturePanel } from './ui/FeaturePanel.js';
import { CompassControl } from './ui/CompassControl.js';
import { ThreeOverlay } from './core/three/ThreeOverlay.js';

// ── Modules (plug/unplug here) ─────────────────────────
// import urbanBlockModule from './modules/urban-block/index.js';
// section-distributor removed — code lives in urban-block
import sectionGenModule from './modules/section-gen/index.js';
import buffersModule from './modules/buffers/index.js';
import insolationModule from './modules/insolation/index.js';

var MODULES = [
  // urbanBlockModule,
  sectionGenModule,
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
    mapManager = new MapManager('map');
    await mapManager.init();

    drawManager = new DrawManager(mapManager, featureStore);

    // Initialize Three.js overlay
    threeOverlay = new ThreeOverlay(mapManager);
    threeOverlay.init();

    // UI
    var toolbar = new Toolbar('toolbar', function (toolId) {
      if (toolId === 'select') {
        drawManager.deactivateTool();
      } else {
        drawManager.activateTool(toolId);
      }
    }, function () {
      var ids = drawManager.getSelectedIds();
      for (var i = 0; i < ids.length; i++) {
        commandManager.execute(new RemoveFeatureCommand(featureStore, ids[i]));
      }
      drawManager.clearSelection();
    });
    toolbar.init();

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
    console.log('U·B·SYSTEM started (' + MODULES.length + ' modules, Three.js enabled)');

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
