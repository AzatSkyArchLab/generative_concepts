/**
 * RenderPanel — render mode (white model + AI-rendered view).
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
import { readUserKey, writeUserKey, composeMoodboard, generateRender, captureComposite } from '../../modules/ai-render/index.js';
import { openModal as openRefModal, getSelected as getSelectedRef, onChange as onCatalogChange } from './ReferenceCatalog.js';

var _whitewashOn = false;
var _busy = false;
var _refs = [];          // legacy moodboard array (kept for back-compat)
var _lastResult = null;  // { sourceDataUrl, dataUrl, prompt }
var _basemap = 'osm';    // 'osm' | 'satellite'
var _catalogUnsub = null;

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
  h += '<div class="render-panel-title">Render</div>';
  h += '<button class="render-btn" id="render-whitewash-btn">White model</button>';
  h += '<button class="render-btn render-btn--secondary" id="render-basemap-btn">Basemap: ' + (_basemap === 'satellite' ? 'Satellite' : 'Vector') + '</button>';
  h += '<button class="render-btn render-btn--secondary" id="render-screenshot-btn" disabled>Save composite PNG</button>';
  // References catalog — opens a modal where the user picks ONE
  // reference photo. Render-from-modal uses that ref + current
  // composite. Result also lives in the modal so the user can
  // scroll/compare with the source.
  h += '<button class="render-btn render-btn--secondary" id="render-refs-btn" style="margin-top:6px">'
       + 'References<span id="render-refs-count" style="opacity:0.7;margin-left:6px"></span></button>';
  h += '<div class="render-hint" id="render-hint" style="margin-top:6px">Toggle white model first.</div>';

  // Prompt textarea — Unicode/Russian-ready by default. Editable so
  // you can tweak per shot; persisted to window.__AI_PROMPT__ so it
  // survives panel re-renders inside this session.
  h += '<div style="margin-top:10px">';
  h += '<label style="display:block;font-size:10px;color:var(--text-muted);margin-bottom:4px">Prompt</label>';
  h += '<textarea id="ai-render-prompt" rows="6" lang="ru" spellcheck="false" '
       + 'style="width:100%;font-size:11px;font-family:inherit;'
       + 'padding:6px 8px;border:1px solid var(--border);border-radius:4px;'
       + 'background:var(--bg-elev);color:var(--text);resize:vertical;'
       + 'box-sizing:border-box;line-height:1.4">'
       + escapeHtml(promptVal) + '</textarea>';
  h += '</div>';

  // Advanced block — collapsed by default. Holds provider + model
  // overrides for when the default slug doesn't work in this account.
  h += '<details style="margin-top:8px;font-size:11px">';
  h += '<summary style="cursor:pointer;color:var(--text-muted);font-size:10px;user-select:none">Advanced</summary>';
  h += '<div style="margin-top:6px;padding:6px;border:1px solid var(--border);border-radius:4px">';
  h += '<div style="display:flex;gap:6px;margin-bottom:6px">';
  h += '<select id="ai-render-provider" style="flex:1;padding:3px 5px;font-size:11px;'
       + 'border:1px solid var(--border);border-radius:3px;background:var(--bg-elev);color:var(--text);'
       + 'font-family:inherit">';
  for (var pi = 0; pi < PROVIDER_PRESETS.length; pi++) {
    var pp = PROVIDER_PRESETS[pi];
    h += '<option value="' + pp.id + '"' + (pp.id === curProvider ? ' selected' : '') + '>'
         + escapeHtml(pp.label) + '</option>';
  }
  h += '</select>';
  h += '</div>';
  h += '<label style="display:block;font-size:10px;color:var(--text-muted);margin-bottom:3px">Model</label>';
  h += '<div style="display:flex;gap:4px">';
  h += '<input type="text" id="ai-render-model" list="ai-render-model-list" value="' + escapeHtml(curModel)
       + '" style="flex:1;padding:3px 5px;font-size:11px;border:1px solid var(--border);'
       + 'border-radius:3px;background:var(--bg-elev);color:var(--text);font-family:inherit;box-sizing:border-box">';
  h += '<button class="render-btn render-btn--secondary" id="ai-render-fetch-models" title="Fetch available models from OpenRouter" style="flex:0 0 auto;padding:3px 8px;font-size:11px">↻</button>';
  h += '</div>';
  h += '<datalist id="ai-render-model-list">' + buildModelOptions(curProvider) + '</datalist>';
  h += '<div id="ai-render-model-hint" style="font-size:9px;color:var(--text-muted);margin-top:4px"></div>';

  // Moodboard inline UI was here; references now live in the
  // ReferenceCatalog modal (opened from the main panel).

  h += '<label style="display:block;font-size:10px;color:var(--text-muted);margin-top:8px;margin-bottom:3px">'
       + 'API key <span style="opacity:0.7">(saved in this browser)</span></label>';
  h += '<input type="password" id="ai-render-key" autocomplete="off" placeholder="paste your key here…" '
       + 'style="width:100%;padding:3px 5px;font-size:11px;border:1px solid var(--border);'
       + 'border-radius:3px;background:var(--bg-elev);color:var(--text);font-family:inherit;'
       + 'box-sizing:border-box">';
  h += '<div id="ai-render-key-hint" style="font-size:9px;color:var(--text-muted);margin-top:3px"></div>';
  h += '</div>';
  h += '</details>';

  // Render-view button + status + preview/result.
  h += '<button class="render-btn" id="ai-render-go" disabled style="margin-top:10px;background:var(--primary);color:#fff;font-weight:700">'
       + 'Render view</button>';
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

/**
 * Render-from-modal handler. The catalog modal calls this when the
 * user clicks "Render view" inside it. Captures the current composite
 * (so satellite basemap + WM volumes are preserved), builds the
 * prompt with a strict single-ref preamble, hits the API, and
 * returns { sourceDataUrl, renderDataUrl } for the modal to display.
 *
 * The user explicitly works with satellite basemap and WITHOUT 3D
 * context-buildings stand-ins (cleaner ground-truth for the model).
 * This is honoured implicitly because we just capture whatever is
 * currently on screen — no extra config needed.
 */
function readPromptBase() {
  var promptEl = document.getElementById('ai-render-prompt');
  var p = (promptEl && promptEl.value) ? promptEl.value : DEFAULT_PROMPT;
  try { window.__AI_PROMPT__ = p; } catch (_e) { /* SSR-safe */ }
  return p;
}

async function handleRenderFromModal(ref) {
  if (!ref || !ref.dataUrl) throw new Error('no reference selected');
  var sourceDataUrl = captureComposite();
  if (!sourceDataUrl) throw new Error('capture failed — toggle White model first');
  var promptBase = readPromptBase();
  var finalPrompt =
    'IMAGE 1 (STYLE REFERENCE) — your DOMINANT VISUAL DRIVER. '
    + 'ADOPT every facade material, window/balcony rhythm, color tonality '
    + 'and atmospheric quality from this image. The final render MUST '
    + 'visibly inherit IMAGE 1\'s materiality. Do NOT copy its building '
    + 'shape — only its style.\n'
    + 'IMAGE 2 (massing study) — the GEOMETRIC CONSTRAINT. '
    + 'Preserve every volume\'s footprint, position, height and proportion '
    + 'EXACTLY per the rules below. Apply IMAGE 1\'s STYLE to IMAGE 2\'s '
    + 'GEOMETRY.\n\n' + promptBase;
  var result = await generateRender({
    prompt: finalPrompt,
    imageDataUrl: sourceDataUrl,
    referenceDataUrls: [ref.dataUrl]
  });
  if (!result || !result.dataUrl) throw new Error('model returned no image');
  return { sourceDataUrl: sourceDataUrl, renderDataUrl: result.dataUrl };
}

/**
 * Per-step callback for the 3-view cascade. Same WM source for all
 * three calls (camera doesn't move between calls), but the prompt
 * shifts and previous renders are appended as additional refs so
 * the trio reads as the SAME building, just different angles.
 *
 * Angles:
 *   0 — Ground A: pedestrian eye-level, frontal view of the most
 *       prominent volume.
 *   1 — Ground B: pedestrian eye-level from a different street
 *       corner, ~90° around. Must match angle 0's materials/
 *       colors/atmosphere exactly.
 *   2 — Match current camera: as close as possible to the input
 *       view's framing — same camera height, tilt, distance.
 *
 * Each later call lists prior renders as IMAGE 2..N+1 with the
 * style ref shifted to IMAGE 1, so the model anchors on previous
 * outputs for consistency.
 */
async function handleRender3FromModal(ctx) {
  var ref = ctx.ref;
  var idx = ctx.angleIndex;
  var prior = ctx.priorRenders || [];
  if (!ref || !ref.dataUrl) throw new Error('no reference selected');
  var sourceDataUrl = captureComposite();
  if (!sourceDataUrl) throw new Error('capture failed — toggle White model first');
  var promptBase = readPromptBase();

  // ANGLE-specific instruction. Goes ABOVE everything so the model
  // picks the camera up-front before reading the rest.
  var angleInstr;
  if (idx === 0) {
    angleInstr =
      'CAMERA: pedestrian eye-level (~1.7 m), looking at the most '
      + 'prominent NEW volume from the public street side. Frontal-ish '
      + 'three-quarter view. Show the ground floor + ~3-5 stories '
      + 'clearly. Cinematic but realistic.';
  } else if (idx === 1) {
    angleInstr =
      'CAMERA: pedestrian eye-level (~1.7 m) from a DIFFERENT vantage '
      + 'than the previous render — rotate ~90° around the urban-block, '
      + 'show a different facade. Same time of day and lighting as '
      + 'previous render. SAME building, different angle.';
  } else {
    angleInstr =
      'CAMERA: match the input massing study\'s framing as closely as '
      + 'possible — same camera height, tilt, distance from subject. '
      + 'This view should read like the input volumes if they were '
      + 'finished buildings, photographed from where the user is now '
      + 'looking. SAME building/materials as the previous renders.';
  }

  // CASCADE STRATEGY: massing study FIRST, prior renders SECOND,
  // style ref LAST. This is opposite of single-render mode (where
  // refs go first) — without this, the model in cascade mode locks
  // onto the style image and renders an alternate-shape building
  // that vaguely fits the prompt. Putting massing first anchors the
  // geometry; style ref shifted to the end makes it clearly a
  // material palette, not a subject substitute.
  var legend = [];
  legend.push('IMAGE 1 (MASSING STUDY) — THIS IS THE BUILDING TO '
    + 'RENDER. The scene shown here — every volume\'s footprint, '
    + 'position, height, count, and proportion — IS the geometric '
    + 'truth. The output must depict THESE volumes (color-coded by '
    + 'role) and NOTHING ELSE. Do not invent extra buildings, do not '
    + 'omit any volume, do not change shapes.');
  for (var i = 0; i < prior.length; i++) {
    var n = i + 2;
    legend.push('IMAGE ' + n + ' (PRIOR RENDER, view '
      + (i + 1) + ') — the SAME building (from IMAGE 1) rendered at a '
      + 'different angle. Match its materials, colors, lighting and '
      + 'time of day EXACTLY. Use it for visual consistency only — '
      + 'geometry still comes from IMAGE 1, not from this prior render.');
  }
  var refIdx = 1 + prior.length + 1;
  legend.push('IMAGE ' + refIdx + ' (STYLE PALETTE) — a real-world '
    + 'photo whose materials, facade rhythm, window patterns, balcony '
    + 'designs, and atmosphere you SAMPLE for the surfaces of IMAGE 1. '
    + 'IGNORE the building shapes in this image entirely — copy only '
    + 'materials and atmosphere, never silhouettes or footprints.');

  var finalPrompt = angleInstr
    + '\n\nCRITICAL: the buildings shown in the OUTPUT must match the '
    + 'volumes in IMAGE 1 (massing study) EXACTLY. Apply IMAGE '
    + refIdx + '\'s materials and palette to IMAGE 1\'s geometry. '
    + 'NEVER substitute IMAGE 1\'s shapes with anything from another '
    + 'image. If a volume is in the massing, render it; if it isn\'t, '
    + 'don\'t add it.\n\n'
    + legend.join('\n') + '\n\n' + promptBase;

  // Order in the API: massing first, prior renders, style ref last.
  // imageDataUrl is the subject (already at position #1 in the
  // generated parts array — see ai-render module). references go
  // AFTER subject. So ordering becomes:
  //   subject (massing) → prior renders → style ref
  // — matches the legend numbering.
  var refs = prior.concat([ref.dataUrl]);

  var result = await generateRender({
    prompt: finalPrompt,
    imageDataUrl: sourceDataUrl,
    referenceDataUrls: refs,
    // Override the default refs-first ordering used for single
    // render — for cascade we need subject FIRST.
    subjectFirst: true
  });
  if (!result || !result.dataUrl) throw new Error('model returned no image');
  return { sourceDataUrl: sourceDataUrl, renderDataUrl: result.dataUrl };
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

  // References — open the catalog modal. The modal calls back into
  // a render function we provide; result is rendered inside the
  // modal alongside the source composite for comparison.
  var refsBtn = document.getElementById('render-refs-btn');
  if (refsBtn) {
    refsBtn.addEventListener('click', function () {
      openRefModal({
        onRender: handleRenderFromModal,
        onRender3: handleRender3FromModal
      });
    });
  }
  // Keep a small "(N)" / "selected" indicator on the button.
  function refreshRefsCount() {
    var el = document.getElementById('render-refs-count');
    if (!el) return;
    var sel = getSelectedRef();
    el.textContent = sel ? '· ' + (sel.name.length > 16 ? sel.name.slice(0, 16) + '…' : sel.name) : '';
    el.style.color = sel ? 'var(--primary)' : 'var(--text-muted)';
  }
  refreshRefsCount();
  // Catalog changes (add/remove/select) → refresh indicator.
  if (_catalogUnsub) _catalogUnsub();
  _catalogUnsub = onCatalogChange(refreshRefsCount);

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

  var goBtn = document.getElementById('ai-render-go');
  if (goBtn) {
    goBtn.addEventListener('click', async function () {
      if (_busy) return;
      var promptEl = document.getElementById('ai-render-prompt');
      var promptBase = (promptEl && promptEl.value) ? promptEl.value : DEFAULT_PROMPT;
      try { window.__AI_PROMPT__ = promptBase; } catch (_e) { /* SSR-safe */ }

      // Compose the moodboard if we have refs — N images become ONE
      // grid PNG so the model gets a single stylesheet rather than
      // a flood of separate inputs. Skip if there's only one ref
      // (passing it directly is cleaner).
      var refsToSend = [];
      var refMode = 'none'; // 'none' | 'single' | 'moodboard'
      if (_refs.length === 1) {
        refsToSend = _refs.slice();
        refMode = 'single';
      } else if (_refs.length >= 2) {
        setStatus('Composing moodboard (' + _refs.length + ' refs)…');
        try {
          var mood = await composeMoodboard(_refs);
          if (mood) {
            refsToSend = [mood];
            refMode = 'moodboard';
          }
        } catch (err) {
          setStatus('Moodboard failed: ' + (err.message || err));
          return;
        }
      }

      // Build the final prompt. The model gets multiple images and
      // doesn't natively know what each one is for — without an
      // explicit "Image N = ..." block it tends to ignore refs or
      // average them with the subject. We prepend a tiny header that
      // names each image's role.
      var finalPrompt = promptBase;
      if (refMode === 'single') {
        finalPrompt =
          'IMAGE 1 (STYLE REFERENCE) — your DOMINANT VISUAL DRIVER. '
          + 'ADOPT every facade material, window/balcony rhythm, color '
          + 'tonality, and atmospheric quality from this image. The '
          + 'final render MUST visibly inherit IMAGE 1\'s materiality. '
          + 'Do NOT copy its building shape — only its style.\n'
          + 'IMAGE 2 (massing study) — the GEOMETRIC CONSTRAINT. '
          + 'Preserve every volume\'s footprint, position, height and '
          + 'proportion exactly per the rules below. Apply IMAGE 1\'s '
          + 'STYLE to IMAGE 2\'s GEOMETRY.\n\n'
          + promptBase;
      } else if (refMode === 'moodboard') {
        finalPrompt =
          'IMAGE 1 (MOODBOARD GRID, ' + _refs.length + ' tiles) — your '
          + 'DOMINANT VISUAL DRIVER. The grid is a unified stylesheet — '
          + 'ADOPT its recurring materials (limestone, brick, glass, '
          + 'metal panels), facade rhythms, balcony designs, window '
          + 'proportions, color tones and atmosphere as the primary '
          + 'visual language of the final render. The result MUST '
          + 'clearly read as "buildings in the moodboard\'s style". '
          + 'Do NOT copy any building outline from the grid — extract '
          + 'STYLE only, never shape. Aim for ONE coherent style '
          + 'synthesised from the grid, not a collage of different '
          + 'looks.\n'
          + 'IMAGE 2 (massing study) — the GEOMETRIC CONSTRAINT. '
          + 'Preserve every volume\'s footprint, position, height and '
          + 'proportion exactly per the rules below. Apply IMAGE 1\'s '
          + 'STYLE to IMAGE 2\'s GEOMETRY.\n\n'
          + promptBase;
      }

      eventBus.emit('ai-render:generate', {
        prompt: finalPrompt,
        referenceDataUrls: refsToSend
      });
    });
  }
  // Also persist on every keystroke so navigation away/back keeps
  // the user's edits without needing a Generate click first.
  var promptElLive = document.getElementById('ai-render-prompt');
  if (promptElLive) {
    promptElLive.addEventListener('input', function () {
      try { window.__AI_PROMPT__ = promptElLive.value; } catch (_e) { /* no-op */ }
    });
  }

  // ── Advanced block: provider / model / fetch / API key ───
  function syncKeyField() {
    var keyEl = document.getElementById('ai-render-key');
    if (!keyEl) return;
    var p = readProvider();
    var existing = readUserKey(p);
    keyEl.value = existing || '';
    var hint = document.getElementById('ai-render-key-hint');
    if (hint) {
      if (existing) {
        hint.textContent = 'Saved for ' + p + ' — pasted key is used for all renders.';
      } else {
        hint.textContent = 'Paste a ' + p + ' API key. It stays on this browser only.';
      }
    }
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
      if (p === 'openrouter') maybeAutoFetchOpenRouterModels();
      syncKeyField();
    });
  }
  // Reference images: + Add, file picker, drag-drop, Clear.
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

  // API-key input: load existing, save on every keystroke (cheap;
  // localStorage handles dedup). On change, hint updates.
  var keyEl = document.getElementById('ai-render-key');
  if (keyEl) {
    syncKeyField();
    keyEl.addEventListener('input', function () {
      var p = (provSel && provSel.value) || readProvider();
      writeUserKey(p, keyEl.value);
      var hint = document.getElementById('ai-render-key-hint');
      if (hint) {
        hint.textContent = keyEl.value
          ? 'Saved.' : 'Cleared — will fall back to .env.local or DevTools override.';
      }
    });
  }
  var modelElA = document.getElementById('ai-render-model');
  if (modelElA) {
    modelElA.addEventListener('change', function () {
      var p = (provSel && provSel.value) || readProvider();
      writeModel(p, modelElA.value);
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
      if (hint) hint.textContent = 'Fetching catalog…';
      var res = await fetchOpenRouterModels();
      fetchBtn.disabled = false;
      fetchBtn.textContent = '↻';
      if (res.error) {
        if (hint) hint.textContent = 'Fetch failed: ' + res.error;
        return;
      }
      var dl = document.getElementById('ai-render-model-list');
      if (dl) dl.innerHTML = buildModelOptions('openrouter');
      if (hint) hint.textContent = 'Loaded ' + res.count + ' image-output models.';
    });
  }
  // Auto-fetch catalog on first reveal so the datalist is ready.
  if (readProvider() === 'openrouter') maybeAutoFetchOpenRouterModels();

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
    setStatus('Rendering · sent ' + (d && d.sourceDataUrl ? Math.round(d.sourceDataUrl.length / 1024) + ' KB' : ''));
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
    // Quota / rate-limit 429 — usually means Google direct on the free
    // tier ran out, or OpenRouter credits are exhausted.
    if (/429/.test(combined) || /quota/i.test(combined) || /rate limit/i.test(combined)) {
      combined = 'Quota / rate limit hit. Either enable billing on the '
        + 'provider you\'re using, or switch to a different one. (' + msg + ')';
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
  goBtn.textContent = _busy ? 'Rendering…' : 'Render view';
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
