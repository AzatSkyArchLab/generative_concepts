/**
 * EventBus — centralized pub/sub for loose coupling
 */

class EventBus {
  constructor() {
    /** @type {Map<string, Set<Function>>} */
    this._listeners = new Map();
  }

  /**
   * Subscribe to an event
   * @param {string} event
   * @param {Function} callback
   * @returns {Function} unsubscribe function
   */
  on(event, callback) {
    if (!this._listeners.has(event)) {
      this._listeners.set(event, new Set());
    }
    this._listeners.get(event).add(callback);
    return () => this.off(event, callback);
  }

  /**
   * Unsubscribe from an event
   * @param {string} event
   * @param {Function} callback
   */
  off(event, callback) {
    const set = this._listeners.get(event);
    if (set) set.delete(callback);
  }

  /**
   * One-time subscription
   * @param {string} event
   * @param {Function} callback
   */
  once(event, callback) {
    const wrapper = (data) => {
      callback(data);
      this.off(event, wrapper);
    };
    this.on(event, wrapper);
  }

  /**
   * Emit an event
   * @param {string} event
   * @param {*} [data]
   */
  emit(event, data) {
    const set = this._listeners.get(event);
    if (!set) return;
    for (const cb of set) {
      try {
        cb(data);
      } catch (err) {
        console.error(`EventBus error in "${event}":`, err);
      }
    }
  }

  /**
   * Check if event has listeners
   * @param {string} event
   * @returns {boolean}
   */
  hasListeners(event) {
    const set = this._listeners.get(event);
    return set ? set.size > 0 : false;
  }

  /** Clear all subscriptions */
  clear() {
    this._listeners.clear();
  }
}

export const eventBus = new EventBus();
