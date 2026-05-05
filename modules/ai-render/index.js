/**
 * AI Render Module — Nano Banana Pro (Gemini 3 Pro Image).
 *
 * Two providers supported, switchable at runtime via
 * `window.__AI_PROVIDER__`:
 *
 *   - 'google'     (default) — direct call to Google's
 *                  generativelanguage API. Uses the dev API key.
 *   - 'openrouter' — OpenAI-compatible chat/completions through
 *                  OpenRouter. Useful for fallback / paid quotas.
 *
 * Pipeline:
 *   1. Capture: composite MapLibre basemap + Three.js overlay → PNG.
 *   2. Generate: POST to the active provider with the screenshot
 *      and optional reference images.
 *   3. Display: emit `ai-render:result` for the panel to render.
 *
 * Keys are hard-coded for development. Override via:
 *   window.__GEMINI_API_KEY__       (Google direct)
 *   window.__OPENROUTER_API_KEY__   (OpenRouter)
 */

import { log } from '../../core/Logger.js';

var _eventBus = null;
var _threeOverlay = null;
var _mapManager = null;
var _unsubs = [];

// ── Provider config ──────────────────────────────────────

var DEFAULT_PROVIDER = 'google';

// Keys are NOT hard-coded — supply them at runtime via:
//   window.__GEMINI_API_KEY__       (Google direct)
//   window.__OPENROUTER_API_KEY__   (OpenRouter)
// from DevTools, a settings panel, or build-time injection.
var GOOGLE_FALLBACK_KEY = '';
var GOOGLE_MODEL = 'gemini-3-pro-image-preview';
var GOOGLE_ENDPOINT_TMPL =
  'https://generativelanguage.googleapis.com/v1beta/models/' +
  GOOGLE_MODEL + ':generateContent';

var OPENROUTER_FALLBACK_KEY = '';
var OPENROUTER_MODEL = 'google/gemini-3-pro-image-preview';
var OPENROUTER_ENDPOINT = 'https://openrouter.ai/api/v1/chat/completions';

function getProvider() {
  try {
    if (typeof window !== 'undefined' && window.__AI_PROVIDER__) {
      var v = String(window.__AI_PROVIDER__).toLowerCase();
      if (v === 'google' || v === 'openrouter') return v;
    }
  } catch (_e) { /* SSR-safe */ }
  return DEFAULT_PROVIDER;
}

function getApiKey(provider) {
  // Resolution order:
  //   1. window.__GEMINI_API_KEY__ / __OPENROUTER_API_KEY__ — runtime
  //      override from DevTools or a settings panel.
  //   2. import.meta.env.VITE_GEMINI_API_KEY / VITE_OPENROUTER_API_KEY —
  //      Vite picks these up from .env.local (gitignored). Local-dev
  //      friendly: drop your key in .env.local once and forget it.
  //   3. Empty string — no key configured.
  try {
    if (typeof window !== 'undefined') {
      if (provider === 'openrouter' && window.__OPENROUTER_API_KEY__) {
        return String(window.__OPENROUTER_API_KEY__);
      }
      if (provider === 'google' && window.__GEMINI_API_KEY__) {
        return String(window.__GEMINI_API_KEY__);
      }
    }
  } catch (_e) { /* SSR-safe */ }
  try {
    if (typeof import.meta !== 'undefined' && import.meta.env) {
      var env = import.meta.env;
      if (provider === 'openrouter' && env.VITE_OPENROUTER_API_KEY) {
        return String(env.VITE_OPENROUTER_API_KEY);
      }
      if (provider === 'google' && env.VITE_GEMINI_API_KEY) {
        return String(env.VITE_GEMINI_API_KEY);
      }
    }
  } catch (_e) { /* non-Vite environment */ }
  return provider === 'openrouter' ? OPENROUTER_FALLBACK_KEY : GOOGLE_FALLBACK_KEY;
}

function getModel(provider) {
  try {
    if (typeof window !== 'undefined') {
      if (provider === 'openrouter' && window.__OPENROUTER_MODEL__) {
        return String(window.__OPENROUTER_MODEL__);
      }
      if (provider === 'google' && window.__GEMINI_MODEL__) {
        return String(window.__GEMINI_MODEL__);
      }
    }
  } catch (_e) { /* SSR-safe */ }
  return provider === 'openrouter' ? OPENROUTER_MODEL : GOOGLE_MODEL;
}

// ── Capture ─────────────────────────────────────────────

/**
 * Composite the MapLibre canvas + the Three.js overlay canvas onto a
 * single 2D canvas. Map is drawn first (basemap + extruded buildings
 * from MapLibre's own layers), then the Three.js canvas on top
 * (urban-block geometry, white plane, context buildings stand-in,
 * shadows). Returns a PNG data URL.
 */
function captureComposite() {
  if (!_threeOverlay) {
    log.warn('[ai-render] threeOverlay not available');
    return null;
  }
  if (!_mapManager) {
    log.warn('[ai-render] mapManager not available');
    return null;
  }
  var threeCanvas = _threeOverlay.getCanvas();
  var map = _mapManager.getMap();
  if (!map) return null;
  var mapCanvas = map.getCanvas();
  if (!mapCanvas) return null;

  // Force both layers to commit fresh pixels to their drawing
  // buffers before we read them. MapLibre's preserveDrawingBuffer is
  // on (set in MapManager.init), but a synchronous repaint ensures
  // the buffer reflects the LATEST state — including overlays that
  // were just toggled.
  try { map.triggerRepaint(); } catch (_e) { /* no-op */ }
  try { _threeOverlay.forceRender(); } catch (_e) { /* no-op */ }

  var w = mapCanvas.width;
  var h = mapCanvas.height;
  var tmp = document.createElement('canvas');
  tmp.width = w;
  tmp.height = h;
  var ctx = tmp.getContext('2d');

  // Solid white fallback under everything in case the map canvas is
  // partially transparent (it usually isn't, but cheap insurance).
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, w, h);

  try {
    ctx.drawImage(mapCanvas, 0, 0, w, h);
  } catch (err) {
    log.error('[ai-render] drawImage(map) failed:', err);
  }

  // Three.js canvas may be a different physical size (DPR scaling).
  // drawImage scales to (w,h) so the final composite stays consistent.
  try {
    ctx.drawImage(threeCanvas, 0, 0, w, h);
  } catch (err) {
    log.error('[ai-render] drawImage(three) failed:', err);
  }

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
 * Public capture: composite + optional download. Emits
 * `ai-render:screenshot:done` with the dataUrl.
 */
function takeScreenshot(opts) {
  opts = opts || {};
  var download = opts.download !== false;
  var filename = opts.filename || ('ub-shot-' + Date.now() + '.png');

  var dataUrl = captureComposite();
  if (!dataUrl) return null;

  if (download) downloadDataUrl(dataUrl, filename);

  if (_eventBus) {
    _eventBus.emit('ai-render:screenshot:done', {
      dataUrl: dataUrl,
      filename: filename
    });
  }
  return dataUrl;
}

// ── Gemini API ───────────────────────────────────────────

function dataUrlToBase64(dataUrl) {
  var comma = dataUrl.indexOf(',');
  return comma >= 0 ? dataUrl.substring(comma + 1) : dataUrl;
}

/**
 * Walk an OpenRouter-style chat-completion response for an image
 * data URL. Image-output models on OpenRouter return images via
 * several different shapes:
 *   1. choices[0].message.images: [{ image_url: { url } }]   (newer)
 *   2. choices[0].message.content[i].image_url.url           (vision-style)
 *   3. choices[0].message.content[i].type === 'output_image' (older)
 * We accept all three.
 */
function extractImageUrlFromResponse(json) {
  var choices = (json && json.choices) || [];
  for (var c = 0; c < choices.length; c++) {
    var msg = choices[c] && choices[c].message;
    if (!msg) continue;
    // Shape 1
    if (Array.isArray(msg.images)) {
      for (var i = 0; i < msg.images.length; i++) {
        var im = msg.images[i];
        var u = im && im.image_url && im.image_url.url;
        if (u) return u;
        if (im && typeof im.url === 'string') return im.url;
      }
    }
    // Shapes 2 + 3
    var content = msg.content;
    if (Array.isArray(content)) {
      for (var k = 0; k < content.length; k++) {
        var part = content[k];
        if (!part) continue;
        var u2 = part.image_url && part.image_url.url;
        if (u2) return u2;
        if (part.type === 'output_image' && (part.image || part.data)) {
          var raw = part.image || part.data;
          if (/^data:/.test(raw)) return raw;
          return 'data:image/png;base64,' + raw;
        }
      }
    }
  }
  return null;
}

async function generateViaOpenRouter(opts) {
  var key = getApiKey('openrouter');
  if (!key) { log.error('[ai-render] no OpenRouter key'); return null; }
  var model = getModel('openrouter');

  var content = [];
  content.push({ type: 'text', text: String(opts.prompt) });
  content.push({ type: 'image_url', image_url: { url: opts.imageDataUrl } });
  if (Array.isArray(opts.referenceDataUrls)) {
    for (var ri = 0; ri < opts.referenceDataUrls.length; ri++) {
      var ref = opts.referenceDataUrls[ri];
      if (ref) content.push({ type: 'image_url', image_url: { url: ref } });
    }
  }

  var body = {
    model: model,
    messages: [{ role: 'user', content: content }],
    modalities: ['image', 'text']
  };

  var headers = {
    'Content-Type': 'application/json',
    'Authorization': 'Bearer ' + key
  };
  try {
    if (typeof window !== 'undefined' && window.location && window.location.origin) {
      headers['HTTP-Referer'] = window.location.origin;
    }
  } catch (_e) { /* SSR-safe */ }
  headers['X-Title'] = 'U·B·SYSTEM AI Render';

  log.debug('[ai-render] POST → openrouter/' + model + ' · prompt=' + opts.prompt.slice(0, 60));
  var resp;
  try {
    resp = await fetch(OPENROUTER_ENDPOINT, {
      method: 'POST', headers: headers, body: JSON.stringify(body)
    });
  } catch (err) {
    log.error('[ai-render] openrouter network:', err);
    if (_eventBus) _eventBus.emit('ai-render:error', { message: err.message || 'Network error' });
    return null;
  }
  if (!resp.ok) {
    var errText = '';
    try { errText = await resp.text(); } catch (_e) { /* no-op */ }
    log.error('[ai-render] openrouter HTTP ' + resp.status + ': ' + errText);
    if (_eventBus) _eventBus.emit('ai-render:error', {
      message: 'HTTP ' + resp.status, detail: errText
    });
    return null;
  }
  var json;
  try { json = await resp.json(); } catch (err) {
    log.error('[ai-render] openrouter bad JSON:', err);
    if (_eventBus) _eventBus.emit('ai-render:error', { message: 'Bad JSON response' });
    return null;
  }
  if (json && json.error) {
    log.error('[ai-render] openrouter error:', json.error);
    if (_eventBus) _eventBus.emit('ai-render:error', {
      message: json.error.message || 'OpenRouter error'
    });
    return null;
  }

  var imageUrl = extractImageUrlFromResponse(json);
  if (!imageUrl) {
    log.warn('[ai-render] openrouter: no image part', json);
    if (_eventBus) _eventBus.emit('ai-render:error', {
      message: 'Model returned no image',
      detail: JSON.stringify(json).slice(0, 400)
    });
    return null;
  }
  var m = imageUrl.match(/^data:([^;]+);/);
  return { dataUrl: imageUrl, mimeType: m ? m[1] : 'image/png' };
}

async function generateViaGoogle(opts) {
  var key = getApiKey('google');
  if (!key) { log.error('[ai-render] no Google API key'); return null; }
  var model = getModel('google');
  var url = 'https://generativelanguage.googleapis.com/v1beta/models/'
    + model + ':generateContent?key=' + encodeURIComponent(key);

  var parts = [{ text: String(opts.prompt) }];
  parts.push({
    inline_data: {
      mime_type: 'image/png',
      data: dataUrlToBase64(opts.imageDataUrl)
    }
  });
  if (Array.isArray(opts.referenceDataUrls)) {
    for (var i = 0; i < opts.referenceDataUrls.length; i++) {
      var ref = opts.referenceDataUrls[i];
      if (!ref) continue;
      var mm = ref.match(/^data:([^;]+);/);
      var mime = mm ? mm[1] : 'image/png';
      parts.push({ inline_data: { mime_type: mime, data: dataUrlToBase64(ref) } });
    }
  }
  var body = {
    contents: [{ role: 'user', parts: parts }],
    generationConfig: { responseModalities: ['TEXT', 'IMAGE'] }
  };

  log.debug('[ai-render] POST → google/' + model + ' · prompt=' + opts.prompt.slice(0, 60));
  var resp;
  try {
    resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
  } catch (err) {
    log.error('[ai-render] google network:', err);
    if (_eventBus) _eventBus.emit('ai-render:error', { message: err.message || 'Network error' });
    return null;
  }
  if (!resp.ok) {
    var errText = '';
    try { errText = await resp.text(); } catch (_e) { /* no-op */ }
    log.error('[ai-render] google HTTP ' + resp.status + ': ' + errText);
    if (_eventBus) _eventBus.emit('ai-render:error', {
      message: 'HTTP ' + resp.status, detail: errText
    });
    return null;
  }
  var json;
  try { json = await resp.json(); } catch (err) {
    log.error('[ai-render] google bad JSON:', err);
    if (_eventBus) _eventBus.emit('ai-render:error', { message: 'Bad JSON response' });
    return null;
  }
  if (json && json.error) {
    log.error('[ai-render] google error:', json.error);
    if (_eventBus) _eventBus.emit('ai-render:error', {
      message: json.error.message || 'Google API error'
    });
    return null;
  }

  // Walk candidates → content.parts → find inline_data with image mime.
  var candidates = (json && json.candidates) || [];
  for (var c = 0; c < candidates.length; c++) {
    var cParts = candidates[c] && candidates[c].content && candidates[c].content.parts;
    if (!Array.isArray(cParts)) continue;
    for (var p = 0; p < cParts.length; p++) {
      var inline = cParts[p].inline_data || cParts[p].inlineData;
      if (!inline || !inline.data) continue;
      var mime2 = inline.mime_type || inline.mimeType || 'image/png';
      if (!/^image\//.test(mime2)) continue;
      return {
        dataUrl: 'data:' + mime2 + ';base64,' + inline.data,
        mimeType: mime2
      };
    }
  }
  log.warn('[ai-render] google: no image part', json);
  if (_eventBus) _eventBus.emit('ai-render:error', {
    message: 'Model returned no image',
    detail: JSON.stringify(json).slice(0, 400)
  });
  return null;
}

/**
 * Provider dispatch.
 */
async function generateRender(opts) {
  if (!opts || !opts.prompt || !opts.imageDataUrl) {
    log.warn('[ai-render] generateRender: missing prompt or imageDataUrl');
    return null;
  }
  var provider = getProvider();
  if (provider === 'openrouter') return generateViaOpenRouter(opts);
  return generateViaGoogle(opts);
}

/**
 * Convenience wrapper: capture composite, call Gemini, emit result.
 * The panel listens for `ai-render:generating` (started) and
 * `ai-render:result` (done) to drive its UI.
 */
async function captureAndGenerate(opts) {
  opts = opts || {};
  var prompt = opts.prompt;
  if (!prompt) {
    log.warn('[ai-render] captureAndGenerate: no prompt');
    return null;
  }
  var imageDataUrl = captureComposite();
  if (!imageDataUrl) {
    if (_eventBus) _eventBus.emit('ai-render:error', { message: 'Capture failed' });
    return null;
  }

  if (_eventBus) {
    _eventBus.emit('ai-render:generating', {
      sourceDataUrl: imageDataUrl, prompt: prompt
    });
  }

  var result = await generateRender({
    prompt: prompt,
    imageDataUrl: imageDataUrl,
    referenceDataUrls: opts.referenceDataUrls || []
  });
  if (!result) return null;

  if (_eventBus) {
    _eventBus.emit('ai-render:result', {
      dataUrl: result.dataUrl,
      mimeType: result.mimeType,
      sourceDataUrl: imageDataUrl,
      prompt: prompt
    });
  }
  return result;
}

// ── Module ──────────────────────────────────────────────

var aiRenderModule = {
  id: 'ai-render',

  init: function (ctx) {
    _eventBus = ctx.eventBus;
    _threeOverlay = ctx.threeOverlay || null;
    _mapManager = ctx.mapManager || null;

    _unsubs.push(_eventBus.on('ai-render:screenshot', function (d) {
      takeScreenshot(d || {});
    }));
    _unsubs.push(_eventBus.on('ai-render:generate', function (d) {
      captureAndGenerate(d || {});
    }));

    log.debug('[ai-render] initialized · model=' + GEMINI_MODEL);
  },

  destroy: function () {
    for (var i = 0; i < _unsubs.length; i++) _unsubs[i]();
    _unsubs = [];
    _eventBus = null;
    _threeOverlay = null;
    _mapManager = null;
  }
};

export default aiRenderModule;
export { takeScreenshot, generateRender, captureAndGenerate, captureComposite };
