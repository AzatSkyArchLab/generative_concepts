/**
 * CompoundCommand — groups multiple commands into a single undo/redo unit.
 */

export class CompoundCommand {
  /**
   * @param {Array<Object>} commands - array of command objects with execute/undo
   * @param {string} [description]
   */
  constructor(commands, description) {
    this._commands = commands;
    this.description = description || 'Compound (' + commands.length + ' actions)';
  }

  execute() {
    for (var i = 0; i < this._commands.length; i++) {
      this._commands[i].execute();
    }
  }

  undo() {
    for (var i = this._commands.length - 1; i >= 0; i--) {
      this._commands[i].undo();
    }
  }
}
