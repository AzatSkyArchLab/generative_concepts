/**
 * U·B·SYSTEM — Entry Point
 *
 * Initialization order:
 * 1. MapManager.init() — creates 3D map
 * 2. DrawManager — tools + feature layers
 * 3. UI components — toolbar, status bar, panels
 */
import 'maplibre-gl/dist/maplibre-gl.css';
import './styles/main.css';
import { eventBus } from './core/EventBus.js';
import { MapManager } from './map/MapManager.js';
import { DrawManager } from './draw/DrawManager.js';
import { featureStore } from './data/FeatureStore.js';
import { commandManager } from './core/commands/CommandManager.js';
import { RemoveFeatureCommand } from './core/commands/RemoveFeatureCommand.js';
import { Toolbar } from './ui/Toolbar.js';
import { StatusBar } from './ui/StatusBar.js';
import { FeaturePanel } from './ui/FeaturePanel.js';

// ── Modules (plug/unplug here) ─────────────────────────
import urbanBlockModule from './modules/urban-block/index.js';

var MODULES = [
  urbanBlockModule
];

// ── State ──────────────────────────────────────────────

var mapManager = null;
var drawManager = null;

// ── Bootstrap ──────────────────────────────────────────

async function bootstrap() {
  try {
    // 1. Map
    mapManager = new MapManager('map');
    await mapManager.init();

    // 2. Draw
    drawManager = new DrawManager(mapManager, featureStore);

    // 3. UI
    var toolbar = new Toolbar('toolbar', function (toolId) {
      if (toolId === 'select') {
        drawManager.deactivateTool();
      } else {
        drawManager.activateTool(toolId);
      }
    }, function () {
      // Delete selected
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

    // Wire sidebar → map selection
    eventBus.on('sidebar:feature:click', function (data) {
      var ids = drawManager.getSelectedIds();
      if (ids.indexOf(data.id) >= 0) {
        drawManager.clearSelection();
      } else {
        drawManager.selectFeature(data.id);
      }
    });

    // 4. Initialize modules
    var moduleCtx = {
      mapManager: mapManager,
      eventBus: eventBus,
      featureStore: featureStore
    };
    for (var i = 0; i < MODULES.length; i++) {
      try {
        MODULES[i].init(moduleCtx);
      } catch (err) {
        console.error('Module "' + MODULES[i].id + '" failed to init:', err);
      }
    }

    eventBus.emit('app:ready');
    console.log('U·B·SYSTEM started (' + MODULES.length + ' modules)');

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

// ── Start ──────────────────────────────────────────────

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', bootstrap);
} else {
  bootstrap();
}
