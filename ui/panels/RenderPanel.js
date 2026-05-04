/**
 * RenderPanel — AI render mode + screenshot.
 *
 * Two-step flow:
 *   1. Toggle "White model" → triggers whitewash:set, which (via app.js)
 *      flips materials to white and hides analysis overlays
 *      (insol dots, ray lines, floor pills) flagged with
 *      userData.hideInWhitewash.
 *   2. With white model active, "Screenshot PNG" captures the Three.js
 *      canvas onto a white background and downloads it.
 *
 * UI state syncs via the `whitewash:changed` broadcast from app.js so
 * the panel reflects toggles triggered elsewhere (e.g. AptMix reset).
 */

import { eventBus } from '../../core/EventBus.js';

var _whitewashOn = false;

export function renderRenderSection() {
  var el = document.getElementById('render-section');
  if (!el) return;

  var h = '<div class="props-divider"></div>';
  h += '<div class="render-panel" id="render-panel">';
  h += '<div class="render-panel-title">AI Render</div>';
  h += '<button class="render-btn" id="render-whitewash-btn">White model</button>';
  h += '<button class="render-btn render-btn--secondary" id="render-screenshot-btn" disabled>Screenshot PNG</button>';
  h += '<div class="render-hint" id="render-hint">Toggle white model first.</div>';
  h += '</div>';
  el.innerHTML = h;

  bindEvents();
  applyState(_whitewashOn);
}

function bindEvents() {
  var wwBtn = document.getElementById('render-whitewash-btn');
  if (wwBtn) {
    wwBtn.addEventListener('click', function () {
      // Just emit the request — app.js will set the overlay state and
      // broadcast `whitewash:changed`. Our listener updates the UI.
      eventBus.emit('whitewash:set', { enabled: !_whitewashOn });
    });
  }

  var shotBtn = document.getElementById('render-screenshot-btn');
  if (shotBtn) {
    shotBtn.addEventListener('click', function () {
      if (!_whitewashOn) return;
      shotBtn.disabled = true;
      var oldText = shotBtn.textContent;
      shotBtn.textContent = 'Capturing…';
      // Defer one frame so the disabled state paints before the
      // synchronous render+capture work blocks the main thread.
      requestAnimationFrame(function () {
        eventBus.emit('ai-render:screenshot', {});
        shotBtn.disabled = !_whitewashOn;
        shotBtn.textContent = oldText;
      });
    });
  }

  // Sync UI state with whitewash changes from anywhere.
  eventBus.on('whitewash:changed', function (d) {
    _whitewashOn = !!(d && d.enabled);
    applyState(_whitewashOn);
  });
}

function applyState(on) {
  var wwBtn = document.getElementById('render-whitewash-btn');
  var shotBtn = document.getElementById('render-screenshot-btn');
  var hint = document.getElementById('render-hint');
  if (wwBtn) {
    wwBtn.textContent = on ? 'Show colors' : 'White model';
    wwBtn.classList.toggle('render-btn--active', on);
  }
  if (shotBtn) shotBtn.disabled = !on;
  if (hint) {
    hint.textContent = on
      ? 'White model active — capture as PNG.'
      : 'Toggle white model first.';
  }
}
