/**
 * AI Render Module — Phase 1: screenshot pipeline only.
 *
 * Responds to `ai-render:screenshot` and:
 *   1. Synchronously renders the Three.js scene (uses last MapLibre matrix).
 *   2. Composites the (transparent) Three canvas onto a white background.
 *   3. Triggers a PNG download.
 *
 * Whitewash mode is owned by the UI (RenderPanel). The user toggles
 * "White model" first; this module just captures whatever's on screen.
 *
 * Future phases will add the Gemini API call + reference upload.
 */

import { log } from '../../core/Logger.js';

var _eventBus = null;
var _threeOverlay = null;
var _unsubs = [];

/**
 * Composite a transparent canvas onto a solid white background.
 * Returns a data URL (image/png).
 */
function compositeOnWhite(srcCanvas) {
  var tmp = document.createElement('canvas');
  tmp.width = srcCanvas.width;
  tmp.height = srcCanvas.height;
  var ctx = tmp.getContext('2d');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, tmp.width, tmp.height);
  ctx.drawImage(srcCanvas, 0, 0);
  return tmp.toDataURL('image/png');
}

function downloadDataUrl(dataUrl, filename) {
  var a = document.createElement('a');
  a.href = dataUrl;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
}

/**
 * Capture the current Three.js view onto a white background.
 * Whitewash state is whatever the user already set via RenderPanel.
 */
function takeScreenshot(opts) {
  if (!_threeOverlay) {
    log.warn('[ai-render] threeOverlay not available');
    return null;
  }
  opts = opts || {};
  var download = opts.download !== false;
  var filename = opts.filename || ('insol-render-' + Date.now() + '.png');

  // Render synchronously so preserveDrawingBuffer has the latest pixels
  // ready for toDataURL — without waiting on MapLibre's next repaint.
  _threeOverlay.forceRender();

  var canvas = _threeOverlay.getCanvas();
  var dataUrl;
  try {
    dataUrl = compositeOnWhite(canvas);
  } catch (err) {
    log.error('[ai-render] compositeOnWhite failed:', err);
    dataUrl = null;
  }
  if (!dataUrl) return null;

  if (download) downloadDataUrl(dataUrl, filename);

  if (_eventBus) {
    _eventBus.emit('ai-render:screenshot:done', {
      dataUrl: dataUrl,
      filename: filename,
      width: canvas.width,
      height: canvas.height
    });
  }
  return dataUrl;
}

var aiRenderModule = {
  id: 'ai-render',
  init: function (ctx) {
    _eventBus = ctx.eventBus;
    _threeOverlay = ctx.threeOverlay || null;

    _unsubs.push(_eventBus.on('ai-render:screenshot', function (d) {
      takeScreenshot(d || {});
    }));

    log.debug('[ai-render] initialized');
  },
  destroy: function () {
    for (var i = 0; i < _unsubs.length; i++) _unsubs[i]();
    _unsubs = [];
    _eventBus = null;
    _threeOverlay = null;
  }
};

export default aiRenderModule;
export { takeScreenshot };
