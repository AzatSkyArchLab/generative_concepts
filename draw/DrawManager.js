/**
 * DrawManager — coordinates drawing tools and map layers
 */

import { eventBus } from '../core/EventBus.js';
import { Config } from '../core/Config.js';
import { commandManager } from '../core/commands/CommandManager.js';
import { FeaturesLayer } from './layers/FeaturesLayer.js';
import { PreviewLayer } from './layers/PreviewLayer.js';
import { SelectTool } from './tools/SelectTool.js';
import { PolygonTool } from './tools/PolygonTool.js';
import { LineTool } from './tools/LineTool.js';
import { SectionTool } from './tools/SectionTool.js';
import { TowerTool } from './tools/TowerTool.js';

export class DrawManager {
  /**
   * @param {import('../map/MapManager.js').MapManager} mapManager
   * @param {import('../data/FeatureStore.js').FeatureStore} featureStore
   */
  constructor(mapManager, featureStore) {
    this._mapManager = mapManager;
    this._featureStore = featureStore;

    this._featuresLayer = new FeaturesLayer(mapManager, featureStore);
    this._previewLayer = new PreviewLayer(mapManager);

    /** @type {Map<string, Object>} */
    this._tools = new Map();
    this._activeTool = null;

    this._init();
  }

  _init() {
    this._featuresLayer.init();
    this._previewLayer.init();
    this._registerTools();
    this._setupEventListeners();
    this._mapManager.disableDoubleClickZoom();
    this.activateTool('select');
  }

  _registerTools() {
    this._registerTool(new SelectTool(this, this._featureStore));
    this._registerTool(new PolygonTool(this, this._featureStore));
    this._registerTool(new LineTool(this, this._featureStore));
    this._registerTool(new SectionTool(this, this._featureStore, this._mapManager));
    this._registerTool(new TowerTool(this, this._featureStore, this._mapManager));
  }

  _registerTool(tool) {
    this._tools.set(tool.id, tool);
  }

  _setupEventListeners() {
    var self = this;

    eventBus.on('map:click', function (e) {
      if (self._activeTool) self._activeTool.onMapClick(e);
    });

    eventBus.on('map:dblclick', function (e) {
      if (self._activeTool) self._activeTool.onMapDoubleClick(e);
    });

    eventBus.on('map:mousemove', function (e) {
      if (self._activeTool) self._activeTool.onMapMouseMove(e);
    });

    document.addEventListener('keydown', function (e) {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) {
        return;
      }

      // Undo: Ctrl+Z
      if (e.code === 'KeyZ' && (e.ctrlKey || e.metaKey) && !e.shiftKey) {
        e.preventDefault();
        commandManager.undo();
        return;
      }
      // Redo: Ctrl+Y or Ctrl+Shift+Z
      if ((e.code === 'KeyY' && (e.ctrlKey || e.metaKey)) ||
          (e.code === 'KeyZ' && (e.ctrlKey || e.metaKey) && e.shiftKey)) {
        e.preventDefault();
        commandManager.redo();
        return;
      }

      // Escape → deactivate to select
      if (e.key === 'Escape' && self._activeTool && self._activeTool.id !== 'select') {
        self.deactivateTool();
        return;
      }

      if (self._activeTool) self._activeTool.onKeyDown(e);
    });

    this._setupHoverListeners();
  }

  _setupHoverListeners() {
    var map = this._mapManager.getMap();
    if (!map) return;

    var self = this;
    var canvas = map.getCanvas();
    var interactiveLayers = this._featuresLayer.getInteractiveLayers();

    canvas.addEventListener('mousedown', function () {
      if (self._activeTool && self._activeTool.id === 'select') {
        self.setCursor(Config.cursors.grabbing);
      }
    });

    canvas.addEventListener('mouseup', function () {
      if (self._activeTool && self._activeTool.id === 'select') {
        self.setCursor(Config.cursors.grab);
      }
    });

    map.on('mousemove', function (e) {
      if (!self._activeTool || self._activeTool.id !== 'select') return;

      var existing = [];
      for (var i = 0; i < interactiveLayers.length; i++) {
        if (map.getLayer(interactiveLayers[i])) {
          existing.push(interactiveLayers[i]);
        }
      }
      if (existing.length === 0) return;

      var features = map.queryRenderedFeatures(e.point, { layers: existing });
      if (features.length > 0) {
        self.setCursor(Config.cursors.pointer);
      }
    });
  }

  // ── Public API (IDrawManager interface) ──────────────

  activateTool(toolId) {
    var tool = this._tools.get(toolId);
    if (!tool) {
      console.warn('Tool "' + toolId + '" not found');
      return;
    }

    if (this._activeTool) this._activeTool.deactivate();
    this._activeTool = tool;
    tool.activate();

    // Lock cursor for draw tools, unlock for select
    if (toolId !== 'select') {
      this._mapManager.lockCursor(tool.cursor);
    } else {
      this._mapManager.unlockCursor();
      this._mapManager.setCursor(tool.cursor);
    }

    eventBus.emit('tool:activate', toolId);
  }

  deactivateTool() {
    if (this._activeTool) this._activeTool.deactivate();
    this._mapManager.unlockCursor();
    this.activateTool('select');
    eventBus.emit('tool:deactivate');
  }

  getActiveTool() { return this._activeTool; }

  setCursor(cursor) {
    this._mapManager.setCursor(cursor);
  }

  updatePreview(feature) {
    this._previewLayer.update(feature);
  }

  clearPreview() {
    this._previewLayer.clear();
  }

  selectFeature(id) {
    this._featuresLayer.selectFeature(id);
  }

  clearSelection() {
    this._featuresLayer.clearSelection();
  }

  getSelectedIds() {
    return this._featuresLayer.getSelectedIds();
  }

  queryFeaturesAtPoint(point) {
    return this._featuresLayer.queryAtPoint(point);
  }
}
