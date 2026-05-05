/**
 * RenderPanel — AI render mode (white model + Nano Banana Pro).
 *
 * Flow:
 *   1. Toggle "White model" — flips materials, hides analysis overlays.
 *   2. (Optional) Toggle "Satellite" — swaps the basemap to a raster
 *      satellite source for the duration of the render. Photoreal AI
 *      output blends better with photoreal context.
 *   3. Edit prompt + (optional) drop reference image(s).
 *   4. "Generate" — composites map+three canvases and posts to Gemini
 *      gemini-3-pro-image-preview. Result shown inline with download.
 */

import { eventBus } from '../../core/EventBus.js';

var _whitewashOn = false;
var _busy = false;
var _refs = [];          // array of dataURLs from drag-drop / file picker
var _lastResult = null;  // { sourceDataUrl, dataUrl, prompt }
var _basemap = 'osm';    // 'osm' | 'satellite'

// Provider + model presets the user can pick. Slugs synced with the
// ai-render module's defaults; pick whatever your account allows.
var PROVIDER_PRESETS = [
  { id: 'google',     label: 'Google direct (Gemini API)' },
  { id: 'openrouter', label: 'OpenRouter' }
];
var MODEL_PRESETS = {
  google: [
    'gemini-3-pro-image-preview',
    'gemini-2.5-flash-image-preview'
  ],
  // Candidate slugs for "Nano Banana 2 (Gemini 3.1 Flash Image
  // Preview)" — OpenRouter's exact naming varies. The ↻ button next
  // to the model field fetches the live catalog so you don't have
  // to guess; these presets cover the most likely names while
  // support enables access.
  openrouter: [
    'google/gemini-3.1-flash-image-preview',  // Nano Banana 2 (most likely)
    'google/gemini-3-flash-image-preview',    // alternative naming
    'google/gemini-2.5-flash-image-preview'   // original Nano Banana (fallback)
  ]
};
// Cached fetched list (per provider) so reopens don't re-fetch.
var _fetchedModels = {};
function readProvider() {
  try {
    if (typeof window !== 'undefined' && window.__AI_PROVIDER__) {
      return String(window.__AI_PROVIDER__);
    }
  } catch (_e) { /* SSR-safe */ }
  return 'google';
}
function readModel(provider) {
  try {
    if (typeof window !== 'undefined') {
      if (provider === 'openrouter' && window.__OPENROUTER_MODEL__) return String(window.__OPENROUTER_MODEL__);
      if (provider === 'google'     && window.__GEMINI_MODEL__)     return String(window.__GEMINI_MODEL__);
    }
  } catch (_e) { /* SSR-safe */ }
  return MODEL_PRESETS[provider] ? MODEL_PRESETS[provider][0] : '';
}
function writeProvider(p) {
  try { if (typeof window !== 'undefined') window.__AI_PROVIDER__ = p; } catch (_e) {}
}
function writeModel(provider, model) {
  try {
    if (typeof window !== 'undefined') {
      if (provider === 'openrouter') window.__OPENROUTER_MODEL__ = model;
      else                            window.__GEMINI_MODEL__ = model;
    }
  } catch (_e) {}
}

var DEFAULT_PROMPT = [
  'TASK: Architectural photography render — magazine-quality, photoreal,',
  'based STRICTLY on the input image. The input is a massing study of a',
  'real urban block in central Moscow inside the Garden Ring',
  '(Садовое кольцо).',
  '',
  'HARD CONSTRAINTS — do not violate:',
  '  1. Preserve EXACT footprint, position, height and proportions of',
  '     every volume in the input. No new buildings. No moved volumes.',
  '     No changed massing. If you projected the rendered scene back to',
  '     a top-down plan, every volume\'s outline would match the input.',
  '  2. Surrounding streets, parking lots, vegetation, water and the',
  '     existing gray buildings must remain in the same position and',
  '     same shape relative to the volumes — no relocating, no resizing.',
  '  3. Do not invent landmarks, do not add cars/people that obscure',
  '     the volumes, do not add fog/haze that hides geometry.',
  '',
  'CAMERA — you have FREEDOM here:',
  '  · The input may be top-down or oblique; YOU choose a cinematic',
  '    final viewpoint that best presents the architecture: eye-level',
  '    pedestrian view (1.5–2 m), street-corner perspective, or a soft',
  '    aerial oblique (30–120 m, ~30–60° tilt). Avoid a pure top-down',
  '    output — it does not read photographically.',
  '  · Pick the angle that best shows the NEW volumes (white +',
  '    light-blue + the warm-beige tower) as the focal subject. The',
  '    surrounding gray context should be visible but supporting.',
  '  · Match the LIGHTING direction and time of day implied by the',
  '    input shadows; reposition the camera but keep the sun angle.',
  '  · The geometric ground truth is the input — your camera change',
  '    must NOT alter footprints, heights, or block layout. Only the',
  '    point of view changes.',
  '',
  'COLOR LEGEND in the input — four roles, treat them DIFFERENTLY:',
  '',
  '  · PURE WHITE volumes → NEW public / commercial buildings.',
  '  · VIVID LIGHT-BLUE volumes → NEW residential apartment buildings.',
  '       Render BOTH in a coherent MINIMALIST CONTEMPORARY style:',
  '       pale facades (light limestone, warm white concrete or fine',
  '       brick), regular window grids, generous balconies on',
  '       residential, restrained palette, NO ornament, NO historicism.',
  '',
  '  · WARM-BEIGE / SAND-COLORED tall slim volume → THE TOWER.',
  '       The tallest, slimmest volume in the input — colored beige in',
  '       the massing precisely so you can identify it. Render the',
  '       tower as a CONTRASTING landmark: a modern residential or',
  '       mixed-use high-rise that visually stands apart from the',
  '       block — bronze-tinted glass, dark vertical mullions, warmer',
  '       facade tone (terracotta, copper, dark brick, or warm stone)',
  '       that pops against the pale block fabric. Higher detail and',
  '       crispness than the surrounding mid-rise.',
  '',
  '  · NEUTRAL GRAY volumes → EXISTING surrounding buildings.',
  '       These are real Moscow buildings already present on site.',
  '       Render them in their REAL-WORLD style — typical Moscow',
  '       inner-ring fabric: brick or stuccoed pre-1950s residential',
  '       blocks, occasional Soviet apartment houses, ground-floor',
  '       shops, weathered facades, pitched or flat roofs as they',
  '       actually look. DO NOT apply the minimalist contemporary',
  '       style to them. They must read as historic context, not',
  '       as part of the new development.',
  '',
  'PHOTOGRAPHIC TREATMENT — push for quality:',
  '  · Architectural Digest / Dezeen magazine aesthetic.',
  '  · Shot on a high-resolution medium-format camera (Hasselblad-class),',
  '    50–85 mm equivalent lens, sharp throughout, mild depth of field.',
  '  · Golden-hour daylight matching the input shadow direction.',
  '  · Realistic soft shadows, accurate ambient occlusion.',
  '  · Crisp materials with visible grain (limestone pores, brick courses,',
  '    glass reflections of sky), no plastic-looking surfaces.',
  '  · 8K-grade detail, natural color, no HDR halos, no oversaturation.',
  '',
  'No text, no logos, no signage, no watermark.'
].join('\n');

export function renderRenderSection() {
  var el = document.getElementById('render-section');
  if (!el) return;

  var promptVal = (typeof window !== 'undefined' && window.__AI_PROMPT__)
    ? String(window.__AI_PROMPT__) : DEFAULT_PROMPT;

  var curProvider = readProvider();
  var curModel = readModel(curProvider);

  var h = '<div class="props-divider"></div>';
  h += '<div class="render-panel" id="render-panel">';
  h += '<div class="render-panel-title">AI Render</div>';
  h += '<button class="render-btn" id="render-whitewash-btn">White model</button>';
  h += '<button class="render-btn render-btn--secondary" id="render-basemap-btn">Basemap: ' + (_basemap === 'satellite' ? 'Satellite' : 'Vector') + '</button>';
  h += '<button class="render-btn render-btn--secondary" id="render-screenshot-btn" disabled>Save composite PNG</button>';

  // Provider + Model
  h += '<div style="margin-top:10px;display:flex;gap:6px">';
  h += '<select id="ai-render-provider" style="flex:1;padding:4px 6px;font-size:11px;'
       + 'border:1px solid var(--border);border-radius:4px;background:var(--bg-elev);color:var(--text);'
       + 'font-family:inherit">';
  for (var pi = 0; pi < PROVIDER_PRESETS.length; pi++) {
    var pp = PROVIDER_PRESETS[pi];
    h += '<option value="' + pp.id + '"' + (pp.id === curProvider ? ' selected' : '') + '>'
         + escapeHtml(pp.label) + '</option>';
  }
  h += '</select>';
  h += '</div>';
  h += '<div style="margin-top:6px">';
  h += '<label style="display:block;font-size:10px;color:var(--text-muted);margin-bottom:4px">Model</label>';
  h += '<div style="display:flex;gap:4px">';
  h += '<input type="text" id="ai-render-model" list="ai-render-model-list" value="' + escapeHtml(curModel)
       + '" style="flex:1;padding:4px 6px;font-size:11px;border:1px solid var(--border);'
       + 'border-radius:4px;background:var(--bg-elev);color:var(--text);font-family:inherit;box-sizing:border-box">';
  h += '<button class="render-btn render-btn--secondary" id="ai-render-fetch-models" title="Fetch image-output models from OpenRouter" style="flex:0 0 auto;padding:4px 8px;font-size:11px">↻</button>';
  h += '</div>';
  h += '<datalist id="ai-render-model-list">' + buildModelOptions(curProvider) + '</datalist>';
  h += '<div id="ai-render-model-hint" style="font-size:9px;color:var(--text-muted);margin-top:3px"></div>';
  h += '</div>';

  // Prompt
  h += '<div class="render-hint" id="render-hint" style="margin-top:8px">Toggle white model first.</div>';
  h += '<div style="margin-top:8px">';
  h += '<label style="display:block;font-size:10px;color:var(--text-muted);margin-bottom:4px">Prompt</label>';
  h += '<textarea id="ai-render-prompt" rows="5" style="width:100%;font-size:11px;font-family:inherit;'
       + 'padding:6px 8px;border:1px solid var(--border);border-radius:4px;'
       + 'background:var(--bg-elev);color:var(--text);resize:vertical;box-sizing:border-box">'
       + escapeHtml(promptVal) + '</textarea>';
  h += '</div>';

  // References
  h += '<div style="margin-top:8px">';
  h += '<label style="display:block;font-size:10px;color:var(--text-muted);margin-bottom:4px">'
       + 'Reference images <span id="ai-ref-count" style="color:var(--text-muted)">'
       + (_refs.length ? '(' + _refs.length + ')' : '') + '</span></label>';
  h += '<div id="ai-ref-strip" style="display:flex;gap:4px;flex-wrap:wrap;min-height:38px;'
       + 'padding:4px;border:1px dashed var(--border);border-radius:4px;'
       + 'align-items:center;justify-content:center"></div>';
  h += '<div style="display:flex;gap:4px;margin-top:4px">';
  h += '<button class="render-btn render-btn--secondary" id="ai-ref-add" style="flex:1">+ Add reference</button>';
  h += '<button class="render-btn render-btn--secondary" id="ai-ref-clear" style="flex:0 0 auto">Clear</button>';
  h += '</div>';
  h += '<input type="file" id="ai-ref-input" accept="image/*" multiple style="display:none">';
  h += '</div>';

  // Generate button + status + side-by-side input/result preview.
  h += '<button class="render-btn" id="ai-render-go" disabled style="margin-top:10px;background:var(--primary);color:#fff;font-weight:700">'
       + 'Generate (Nano Banana Pro)</button>';
  h += '<div id="ai-render-status" class="render-hint" style="margin-top:6px"></div>';
  h += '<div id="ai-render-source" style="margin-top:8px"></div>';
  h += '<div id="ai-render-result" style="margin-top:8px"></div>';

  h += '</div>';
  el.innerHTML = h;

  bindEvents();
  applyState(_whitewashOn);
  renderRefStrip();
  if (_lastResult) renderResult(_lastResult);
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function buildModelOptions(provider) {
  var opts = (_fetchedModels[provider] && _fetchedModels[provider].length > 0)
    ? _fetchedModels[provider]
    : (MODEL_PRESETS[provider] || []);
  var h = '';
  for (var i = 0; i < opts.length; i++) {
    h += '<option value="' + escapeHtml(opts[i]) + '">';
  }
  return h;
}

/**
 * Fetch only if cache is empty — avoids re-fetching every time the
 * panel re-renders or the user switches back to OpenRouter mid-session.
 */
async function maybeAutoFetchOpenRouterModels() {
  if (_fetchedModels.openrouter && _fetchedModels.openrouter.length > 0) return;
  var hint = document.getElementById('ai-render-model-hint');
  if (hint) hint.textContent = 'Loading OpenRouter catalog…';
  var res = await fetchOpenRouterModels();
  if (res.error) {
    if (hint) hint.textContent = 'Catalog fetch failed: ' + res.error + '. Using preset list.';
    return;
  }
  var dl = document.getElementById('ai-render-model-list');
  if (dl) dl.innerHTML = buildModelOptions('openrouter');
  if (hint) hint.textContent = 'Loaded ' + res.count + ' image-output models. Type to filter or pick from the list.';
}

/**
 * Pull the public model catalog from OpenRouter and cache the
 * image-output ones into _fetchedModels.openrouter. No auth needed
 * for /models. Returns count of image models found.
 */
async function fetchOpenRouterModels() {
  var resp;
  try {
    resp = await fetch('https://openrouter.ai/api/v1/models');
  } catch (err) {
    return { count: 0, error: err.message || 'network error' };
  }
  if (!resp.ok) return { count: 0, error: 'HTTP ' + resp.status };
  var json;
  try { json = await resp.json(); } catch (_e) { return { count: 0, error: 'bad json' }; }

  var data = (json && json.data) || [];
  var imageModels = [];
  for (var i = 0; i < data.length; i++) {
    var m = data[i];
    if (!m || !m.id) continue;
    // Filter by output modalities — image-out models declare `image`
    // in `architecture.output_modalities` (or `architecture.modality`).
    var arch = m.architecture || {};
    var outMods = arch.output_modalities || arch.outputModalities || [];
    var inMods = arch.input_modalities  || arch.inputModalities  || [];
    var mod = arch.modality || '';
    var isImageOut = false;
    if (Array.isArray(outMods)) {
      for (var k = 0; k < outMods.length; k++) {
        if (String(outMods[k]).toLowerCase() === 'image') { isImageOut = true; break; }
      }
    }
    if (!isImageOut && /image/i.test(String(mod))) {
      // Older format: "modality": "text+image->image"
      isImageOut = /->.*image/i.test(String(mod));
    }
    // Also keep image-input-capable text models out of the list — we
    // want models that GENERATE images, not just see them.
    if (!isImageOut) continue;
    void inMods;
    imageModels.push(m.id);
  }
  imageModels.sort();
  _fetchedModels.openrouter = imageModels;
  return { count: imageModels.length, error: null };
}

function bindEvents() {
  var wwBtn = document.getElementById('render-whitewash-btn');
  if (wwBtn) {
    wwBtn.addEventListener('click', function () {
      eventBus.emit('whitewash:set', { enabled: !_whitewashOn });
    });
  }

  var bmBtn = document.getElementById('render-basemap-btn');
  if (bmBtn) {
    bmBtn.addEventListener('click', function () {
      var next = _basemap === 'satellite' ? 'osm' : 'satellite';
      eventBus.emit('map:basemap:set', { type: next });
    });
  }

  var shotBtn = document.getElementById('render-screenshot-btn');
  if (shotBtn) {
    shotBtn.addEventListener('click', function () {
      if (!_whitewashOn || _busy) return;
      shotBtn.disabled = true;
      var oldText = shotBtn.textContent;
      shotBtn.textContent = 'Capturing…';
      requestAnimationFrame(function () {
        eventBus.emit('ai-render:screenshot', {});
        shotBtn.disabled = !_whitewashOn;
        shotBtn.textContent = oldText;
      });
    });
  }

  var refAdd = document.getElementById('ai-ref-add');
  var refInput = document.getElementById('ai-ref-input');
  if (refAdd && refInput) {
    refAdd.addEventListener('click', function () { refInput.click(); });
    refInput.addEventListener('change', function (e) {
      var files = e.target.files || [];
      for (var i = 0; i < files.length; i++) addReferenceFromFile(files[i]);
      e.target.value = '';
    });
  }

  var refClear = document.getElementById('ai-ref-clear');
  if (refClear) {
    refClear.addEventListener('click', function () {
      _refs = [];
      renderRefStrip();
    });
  }

  // Drag-and-drop onto the strip.
  var strip = document.getElementById('ai-ref-strip');
  if (strip) {
    strip.addEventListener('dragover', function (e) {
      e.preventDefault();
      strip.style.background = 'rgba(99,102,241,0.08)';
    });
    strip.addEventListener('dragleave', function () { strip.style.background = ''; });
    strip.addEventListener('drop', function (e) {
      e.preventDefault();
      strip.style.background = '';
      var files = (e.dataTransfer && e.dataTransfer.files) || [];
      for (var i = 0; i < files.length; i++) addReferenceFromFile(files[i]);
    });
  }

  var goBtn = document.getElementById('ai-render-go');
  if (goBtn) {
    goBtn.addEventListener('click', function () {
      if (_busy) return;
      var promptEl = document.getElementById('ai-render-prompt');
      var prompt = promptEl ? promptEl.value : DEFAULT_PROMPT;
      try { window.__AI_PROMPT__ = prompt; } catch (_e) { /* SSR-safe */ }
      eventBus.emit('ai-render:generate', {
        prompt: prompt,
        referenceDataUrls: _refs.slice()
      });
    });
  }

  var provSel = document.getElementById('ai-render-provider');
  if (provSel) {
    provSel.addEventListener('change', function () {
      var p = provSel.value || 'google';
      writeProvider(p);
      var modelEl = document.getElementById('ai-render-model');
      var dl = document.getElementById('ai-render-model-list');
      if (modelEl) modelEl.value = readModel(p);
      if (dl) dl.innerHTML = buildModelOptions(p);
      writeModel(p, modelEl ? modelEl.value : '');
      // Auto-fetch the live catalog when switching to OpenRouter so
      // the user gets actual current slugs without an extra click.
      if (p === 'openrouter') maybeAutoFetchOpenRouterModels();
    });
  }
  // Trigger initial auto-fetch if the panel opened already on OpenRouter.
  if (readProvider() === 'openrouter') maybeAutoFetchOpenRouterModels();
  var modelEl = document.getElementById('ai-render-model');
  if (modelEl) {
    modelEl.addEventListener('change', function () {
      var p = (provSel && provSel.value) || readProvider();
      writeModel(p, modelEl.value);
    });
  }

  var fetchBtn = document.getElementById('ai-render-fetch-models');
  if (fetchBtn) {
    fetchBtn.addEventListener('click', async function () {
      var hint = document.getElementById('ai-render-model-hint');
      var p = (provSel && provSel.value) || readProvider();
      if (p !== 'openrouter') {
        if (hint) hint.textContent = 'Fetch supported only for OpenRouter.';
        return;
      }
      fetchBtn.disabled = true;
      fetchBtn.textContent = '…';
      if (hint) hint.textContent = 'Fetching from OpenRouter…';
      var res = await fetchOpenRouterModels();
      fetchBtn.disabled = false;
      fetchBtn.textContent = '↻';
      if (res.error) {
        if (hint) hint.textContent = 'Fetch failed: ' + res.error;
        return;
      }
      // Refresh datalist with the fetched list.
      var dl = document.getElementById('ai-render-model-list');
      if (dl) dl.innerHTML = buildModelOptions('openrouter');
      if (hint) hint.textContent = 'Loaded ' + res.count + ' image-output models. Pick one from the suggestions.';
    });
  }

  // Listen for module events.
  eventBus.on('whitewash:changed', function (d) {
    _whitewashOn = !!(d && d.enabled);
    applyState(_whitewashOn);
  });
  eventBus.on('map:basemap:changed', function (d) {
    _basemap = (d && d.type === 'satellite') ? 'satellite' : 'osm';
    var bm = document.getElementById('render-basemap-btn');
    if (bm) {
      bm.textContent = 'Basemap: ' + (_basemap === 'satellite' ? 'Satellite' : 'Vector');
      bm.classList.toggle('render-btn--active', _basemap === 'satellite');
    }
  });
  eventBus.on('ai-render:generating', function (d) {
    _busy = true;
    setStatus('Generating · sent ' + (d && d.sourceDataUrl ? Math.round(d.sourceDataUrl.length / 1024) + ' KB' : '') + ' · Nano Banana Pro');
    if (d && d.sourceDataUrl) renderSource(d.sourceDataUrl);
    refreshGoBtn();
  });
  eventBus.on('ai-render:result', function (d) {
    _busy = false;
    _lastResult = d;
    setStatus('Done.');
    renderResult(d);
    refreshGoBtn();
  });
  eventBus.on('ai-render:error', function (d) {
    _busy = false;
    var msg = (d && d.message) || 'Unknown error';
    var detail = (d && d.detail) ? String(d.detail) : '';
    var combined = msg + (detail ? ' — ' + detail.slice(0, 240) : '');
    // Recognise OpenRouter's privacy-policy 404 and point the user at
    // the settings page instead of a raw status code.
    if (/no endpoints available/i.test(combined)
        || /guardrail/i.test(combined)
        || /data policy/i.test(combined)) {
      combined = 'OpenRouter privacy settings are blocking this model. '
        + 'Open https://openrouter.ai/settings/privacy and allow at least '
        + 'one provider, then retry. (' + msg + ')';
    }
    setStatus('Error: ' + combined);
    refreshGoBtn();
  });
}

function addReferenceFromFile(file) {
  if (!file || !/^image\//.test(file.type || '')) return;
  var reader = new FileReader();
  reader.onload = function () {
    _refs.push(String(reader.result));
    renderRefStrip();
  };
  reader.readAsDataURL(file);
}

function renderRefStrip() {
  var strip = document.getElementById('ai-ref-strip');
  var counter = document.getElementById('ai-ref-count');
  if (!strip) return;
  if (counter) counter.textContent = _refs.length ? '(' + _refs.length + ')' : '';
  if (_refs.length === 0) {
    strip.innerHTML = '<span style="font-size:10px;color:var(--text-muted)">drop or click + Add</span>';
    return;
  }
  var h = '';
  for (var i = 0; i < _refs.length; i++) {
    h += '<div data-ref-i="' + i + '" style="position:relative">';
    h += '<img src="' + _refs[i] + '" style="width:42px;height:42px;object-fit:cover;border-radius:3px;border:1px solid var(--border)">';
    h += '<button class="ai-ref-rm" data-ref-i="' + i + '" style="position:absolute;top:-4px;right:-4px;'
         + 'width:14px;height:14px;border-radius:50%;border:0;background:#dc2626;color:#fff;'
         + 'font-size:9px;line-height:14px;padding:0;cursor:pointer">×</button>';
    h += '</div>';
  }
  strip.innerHTML = h;
  var btns = strip.querySelectorAll('.ai-ref-rm');
  for (var b = 0; b < btns.length; b++) {
    btns[b].addEventListener('click', function (e) {
      e.stopPropagation();
      var i = parseInt(e.currentTarget.getAttribute('data-ref-i'), 10);
      if (!isNaN(i)) { _refs.splice(i, 1); renderRefStrip(); }
    });
  }
}

function renderSource(dataUrl) {
  var el = document.getElementById('ai-render-source');
  if (!el || !dataUrl) return;
  var h = '';
  h += '<div style="font-size:10px;color:var(--text-muted);margin-bottom:4px">Sent to AI (composite map + 3D)</div>';
  h += '<img src="' + dataUrl + '" style="width:100%;border-radius:4px;border:1px solid var(--border);display:block">';
  el.innerHTML = h;
}

function renderResult(d) {
  var el = document.getElementById('ai-render-result');
  if (!el || !d || !d.dataUrl) return;
  var stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  var h = '';
  h += '<div style="font-size:10px;color:var(--text-muted);margin-bottom:4px">Result</div>';
  h += '<img src="' + d.dataUrl + '" style="width:100%;border-radius:4px;border:1px solid var(--border);display:block">';
  h += '<div style="display:flex;gap:4px;margin-top:6px">';
  h += '<a class="render-btn render-btn--secondary" href="' + d.dataUrl
       + '" download="ai-render-' + stamp + '.png" style="flex:1;text-align:center;text-decoration:none">'
       + 'Download</a>';
  h += '<button class="render-btn render-btn--secondary" id="ai-result-clear" style="flex:0 0 auto">Clear</button>';
  h += '</div>';
  el.innerHTML = h;
  var clr = document.getElementById('ai-result-clear');
  if (clr) clr.addEventListener('click', function () {
    _lastResult = null;
    el.innerHTML = '';
    var src = document.getElementById('ai-render-source');
    if (src) src.innerHTML = '';
  });
}

function setStatus(text) {
  var el = document.getElementById('ai-render-status');
  if (el) el.textContent = text || '';
}

function refreshGoBtn() {
  var goBtn = document.getElementById('ai-render-go');
  if (!goBtn) return;
  goBtn.disabled = _busy || !_whitewashOn;
  goBtn.textContent = _busy ? 'Generating…' : 'Generate (Nano Banana Pro)';
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
      ? 'White model active. Edit the prompt and click Generate.'
      : 'Toggle white model first.';
  }
  refreshGoBtn();
}
