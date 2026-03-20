/**
 * CommandManager — undo/redo history
 */

import { eventBus } from '../EventBus.js';

export class CommandManager {
  constructor(maxHistory = 50) {
    /** @type {Array<{execute: Function, undo: Function, description: string}>} */
    this._undoStack = [];
    /** @type {Array<{execute: Function, undo: Function, description: string}>} */
    this._redoStack = [];
    this._maxHistory = maxHistory;
    this._isExecuting = false;
  }

  /**
   * Execute a command and add to history
   * @param {{execute: Function, undo: Function, redo?: Function, description: string}} command
   */
  execute(command) {
    if (this._isExecuting) return;
    this._isExecuting = true;

    try {
      command.execute();
      this._undoStack.push(command);

      if (this._undoStack.length > this._maxHistory) {
        this._undoStack.shift();
      }

      this._redoStack = [];
      this._emitChange();
    } finally {
      this._isExecuting = false;
    }
  }

  /** @returns {boolean} */
  undo() {
    if (this._undoStack.length === 0) return false;
    const cmd = this._undoStack.pop();
    try {
      cmd.undo();
      this._redoStack.push(cmd);
      this._emitChange();
      eventBus.emit('command:undo', { command: cmd });
      return true;
    } catch (err) {
      console.error('Undo failed:', err);
      this._undoStack.push(cmd);
      return false;
    }
  }

  /** @returns {boolean} */
  redo() {
    if (this._redoStack.length === 0) return false;
    const cmd = this._redoStack.pop();
    try {
      if (cmd.redo) {
        cmd.redo();
      } else {
        cmd.execute();
      }
      this._undoStack.push(cmd);
      this._emitChange();
      eventBus.emit('command:redo', { command: cmd });
      return true;
    } catch (err) {
      console.error('Redo failed:', err);
      this._redoStack.push(cmd);
      return false;
    }
  }

  canUndo() { return this._undoStack.length > 0; }
  canRedo() { return this._redoStack.length > 0; }

  clear() {
    this._undoStack = [];
    this._redoStack = [];
    this._emitChange();
  }

  _emitChange() {
    eventBus.emit('command:history:changed', {
      canUndo: this.canUndo(),
      canRedo: this.canRedo(),
      undoCount: this._undoStack.length,
      redoCount: this._redoStack.length
    });
  }
}

export const commandManager = new CommandManager();
