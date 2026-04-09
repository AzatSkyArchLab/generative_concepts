/**
 * Toolbar — V=select, P=polygon, L=line, S=section, B=buffers, Delete=remove
 */

import { eventBus } from '../core/EventBus.js';

const ICONS = {
  select: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 3l7.07 16.97 2.51-7.39 7.39-2.51L3 3z"/></svg>',
  polygon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 2l9 4.5v7L12 22l-9-8.5v-7L12 2z"/></svg>',
  line: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="5" y1="19" x2="19" y2="5"/><circle cx="5" cy="19" r="2"/><circle cx="19" cy="5" r="2"/></svg>',
  section: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="2" y="6" width="20" height="12" rx="1"/><line x1="8" y1="6" x2="8" y2="18"/><line x1="14" y1="6" x2="14" y2="18"/></svg>',
  tower: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="5" y="3" width="14" height="18" rx="1"/><rect x="8" y="6" width="8" height="12" rx="0" stroke-dasharray="2 1"/><line x1="12" y1="6" x2="12" y2="3"/></svg>',
  delete: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 01-2 2H8a2 2 0 01-2-2L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/><path d="M9 6V4a1 1 0 011-1h4a1 1 0 011 1v2"/></svg>'
};

export class Toolbar {
  constructor(containerId, onToolSelect, onDelete) {
    this._container = document.getElementById(containerId);
    if (!this._container) throw new Error('Toolbar container #' + containerId + ' not found');
    this._onToolSelect = onToolSelect;
    this._onDelete = onDelete;
    this._activeTool = 'select';
  }

  init() {
    this._render();
    this._setupEventListeners();
    this._setupKeyboardShortcuts();
  }

  _render() {
    this._container.innerHTML =
      '<button class="tool-btn active" data-tool="select" data-tooltip="Select (V)">' + ICONS.select + '</button>' +
      '<div class="toolbar-divider"></div>' +
      '<button class="tool-btn" data-tool="polygon" data-tooltip="Polygon (P)">' + ICONS.polygon + '</button>' +
      '<button class="tool-btn" data-tool="line" data-tooltip="Line (L)">' + ICONS.line + '</button>' +
      '<button class="tool-btn" data-tool="section" data-tooltip="Section (S)">' + ICONS.section + '</button>' +
      '<button class="tool-btn" data-tool="tower" data-tooltip="Tower (T)">' + ICONS.tower + '</button>' +
      '<div class="toolbar-divider"></div>' +
      '<button class="tool-btn tool-btn--danger" data-tool="delete" data-tooltip="Delete (Del)">' + ICONS.delete + '</button>';
  }

  _setupEventListeners() {
    var self = this;
    this._inEditMode = false;
    eventBus.on('section:edit-mode', function () { self._inEditMode = true; });
    eventBus.on('section:edit-exit', function () { self._inEditMode = false; });

    this._container.addEventListener('click', function (e) {
      if (self._inEditMode) return;
      var btn = e.target.closest('.tool-btn');
      if (!btn) return;
      var tool = btn.dataset.tool;
      if (tool === 'delete') {
        if (self._onDelete) self._onDelete();
      } else if (tool) {
        self._selectTool(tool);
      }
    });

    eventBus.on('tool:activated', function (data) { self._setActive(data.id); });
    eventBus.on('tool:deactivated', function () { self._setActive('select'); });
  }

  _setupKeyboardShortcuts() {
    var self = this;
    document.addEventListener('keydown', function (e) {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
      if (self._inEditMode) return;

      if (e.key.toLowerCase() === 'b') { eventBus.emit('buffers:toggle'); return; }
      if (e.key.toLowerCase() === 'i') { eventBus.emit('insolation:analyze:global'); return; }

      var shortcuts = { 'v': 'select', 'p': 'polygon', 'l': 'line', 's': 'section', 't': 'tower' };
      var tool = shortcuts[e.key.toLowerCase()];
      if (tool) { self._selectTool(tool); return; }

      if (e.key === 'Delete' || e.key === 'Backspace') {
        if (self._onDelete) self._onDelete();
      }
    });
  }

  _selectTool(toolId) { if (this._onToolSelect) this._onToolSelect(toolId); }

  _setActive(toolId) {
    this._activeTool = toolId;
    var buttons = this._container.querySelectorAll('.tool-btn');
    for (var i = 0; i < buttons.length; i++) {
      var btn = buttons[i];
      if (btn.getAttribute('data-tool') === toolId) btn.classList.add('active');
      else btn.classList.remove('active');
    }
  }
}
