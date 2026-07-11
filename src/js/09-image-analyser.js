/* ══════════════════════════════════════════════════════════════
   IMAGE ANALYSER  (Feature 3)
   ─────────────────────────────────────────────────────────────
   • Analyse button per image slot in the Asset modal
   • Vision provider is user-selectable in Settings: Claude
     (claude-haiku-4-5) or Gemini (gemini-2.0-flash) — cheap, fast.
     Falls back to the other provider if the chosen one has no key.
   • AI analysis (structured: description + attributes + material/
     condition for props + lockTraits/tags etc.) stored in
     asset.imageAnalysis[slotKey]
   • Every asset type gets a type-aware focus instruction so the
     model isolates only what's relevant to that type's "core visual
     identity" and explicitly ignores common contamination sources
     in reference photos (e.g. a person wearing a prop, tourists in
     a location photo, modern elements in an era photo, subject
     matter in a style reference) — see ANALYSER_FOCUS below.
   • Optional per-image "Focus hint" text input (next to each slot)
     lets the user override the type-default for one specific photo,
     e.g. "only the cap, ignore the person" — takes priority over
     ANALYSER_FOCUS when filled in. Saved on the asset as
     asset.imageFocusHints[slotKey].
   • Magic-wand merge button: prepends AI description to user desc,
     and for prop/wardrobe assets also auto-fills empty Material/
     Condition Smart Injection fields from the same analysis
   • Token budget: warns if batch would exceed ~4000 tokens
   • Works offline gracefully: hides Analyse button when no API key
     is configured for either provider
══════════════════════════════════════════════════════════════ */

const ANALYSER_MODEL         = 'claude-haiku-4-5-20251001';
const ANALYSER_MODEL_GEMINI  = 'gemini-2.0-flash';
// Raised 600 → 850 on 2026-07-03: the keyFeatures field (location/era/prop)
// made the expected JSON response noticeably longer, and 600 was already
// tight for a fully-populated character analysis (description + attributes
// + lockTraits + variableTraits + tags). Truncation mid-JSON was the most
// likely cause of the "raw JSON shown instead of a description" bug fixed
// the same day in parseAnalyserResponse() — this reduces how often that
// truncation happens in the first place; the parser's salvage passes are
// the backstop for whenever it still does.
const ANALYSER_MAX_TOK  = 850;   // per image analysis response (raised for structured JSON output)
const ANALYSER_BUDGET   = 4000;  // warn if batch (all slots) exceeds this

/* ── Shared structured-analysis prompt ───────────────────────────
   Same single API call as before (same cost) — just asks the model
   to return structured JSON instead of plain prose, so the extra
   fields below come "for free" alongside the description.
   `description` stays the only field used by the existing merge
   button; the rest is captured for future features (Character
   Bible panel, search/filter, consistency checks, etc.) — see
   session notes 2026-06-19. ────────────────────────────────────── */
// Asset types whose reference photos commonly include a person who is NOT
// the subject of the asset itself (e.g. a prop or wardrobe item shown being
// worn/held). For these types we explicitly tell the model to isolate the
// object and ignore the person/background, and we ask for the object's
// material + condition (mirrors the asset's own "Material"/"Condition"
// Smart Injection fields, so Merge can auto-fill them).
const OBJECT_FOCUS_TYPES = ['prop', 'wardrobe'];

// Per-asset-type "what to ignore / what to focus on" instructions.
// Every reference photo can contain content that isn't part of that
// asset's defined identity (e.g. a tourist in a location photo, a
// modern car in an era photo, the wrong subject in a style reference).
// This generalizes the prop/wardrobe object-focus fix to all 5 types
// — same single API call, same cost, just a sharper instruction.
const ANALYSER_FOCUS = {
  character: {
    instruction: 'This image is a likeness/appearance reference for a CHARACTER. Describe and ' +
      'analyse ONLY the person\'s enduring physical traits — face, hair, eyes, skin tone, build, ' +
      'age range, and any distinguishing marks (scars, tattoos). Ignore one-off elements that are ' +
      'specific to this particular photo and not part of the character\'s core identity: the ' +
      'background/setting, incidental objects in frame, and the exact clothing shown unless it ' +
      'looks like a defining costume rather than the outfit they happened to be wearing that day.',
    extraFields: ''
  },
  location: {
    instruction: 'This image is a reference for a LOCATION/place. Describe and analyse ONLY the ' +
      'place itself — architecture, structure, materials, ground, key landmarks, and ambient ' +
      'atmosphere/lighting. Ignore any people, vehicles, or other transient subjects that happen ' +
      'to be in frame (e.g. a tourist walking by, a parked car) — they are not part of this ' +
      'location\'s permanent visual identity. Explicitly note the SPATIAL POSITION of each named ' +
      'landmark or key feature within the frame (e.g. "a stone water tank on the right side", ' +
      '"a doorway centered in the background", "steps in the left foreground") — this positional ' +
      'detail is required for later prompts that need to reference the same feature by location, ' +
      'not just by name.',
    extraFields: ''
  },
  prop: {
    instruction: 'This image may show a person wearing or holding the item, or other ' +
      'background elements. Describe and analyse ONLY the object itself — its material, ' +
      'color, shape, craftsmanship, and condition. Do NOT describe the person (face, body, ' +
      'skin, expression) or the background. If a person is present, ignore them entirely ' +
      'except where unavoidable for scale/context.',
    extraFields: '  "material": "physical material(s) the object is made of, e.g. hand-forged iron, handwoven cotton",\n' +
      '  "condition": "visible wear/condition, e.g. battle-worn, pristine, weathered",\n'
  },
  era: {
    instruction: 'This image is a reference for a historical ERA/period. Describe and analyse ONLY ' +
      'the period-defining material world — surfaces, fabrics, architectural details, and objects ' +
      'that are characteristic of this time and place. Ignore any people in the photo (their ' +
      'individual appearance is not relevant) and ignore any visibly modern/anachronistic elements ' +
      '(e.g. a modern car, signage, or technology) that may have crept into the reference shot. ' +
      'Where a period-defining feature has an obvious position in frame (left/right/foreground/' +
      'background), note it — helps later prompts place the same feature consistently.',
    extraFields: ''
  },
  style: {
    instruction: 'This image is a reference for a visual RENDERING STYLE, not for its subject matter. ' +
      'Describe and analyse ONLY the artistic/technical approach — medium, line work, color palette, ' +
      'lighting treatment, level of detail, and overall rendering technique. Do NOT describe who or ' +
      'what is depicted in the image; the subject matter shown is incidental and should be ignored.',
    extraFields: ''
  }
};

// Asset types whose photos commonly contain multiple distinct named objects/
// landmarks worth calling out individually (as opposed to character/style,
// which describe one cohesive subject or technique). Feature added 2026-07-03
// after a real gap: analysing a location image folded a water tank into the
// prose description with no way to later match "water tank" as a keyword, or
// to know it's specifically visible in THIS slot's photo rather than another
// slot of the same asset (e.g. Wide vs Detail). keyFeatures gives each named
// object/landmark its own name + in-frame position, structured enough to be
// matched against scene/subject text later (see resolveLocationImageForContext(),
// 01-core.js) to decide which reference image to actually surface/attach.
const SPATIAL_FEATURE_TYPES = ['location', 'era', 'prop'];

function buildAnalyserPrompt(slotContext, assetType, userFocusHint) {
  const focus = ANALYSER_FOCUS[assetType] || null;
  const isObjectFocus = OBJECT_FOCUS_TYPES.includes(assetType);
  const wantsKeyFeatures = SPATIAL_FEATURE_TYPES.includes(assetType);

  // A user-supplied focus hint (per-photo, optional) takes priority over the
  // type-default instruction — e.g. "only the cap, ignore the person" lets
  // the user override what the AI focuses on for this specific image, since
  // no automatic type rule can anticipate every photo's contents.
  const hint = (userFocusHint || '').trim();
  const focusInstruction = hint
    ? `${slotContext} The user has specified exactly what to focus on for this image: "${hint}". ` +
      'Follow this instruction precisely — describe and analyse ONLY what it specifies, and ignore ' +
      'everything else in the photo (including people, background, or other objects not mentioned).'
    : (focus
        ? `${slotContext} ${focus.instruction}`
        : `${slotContext} Analyse this reference image.`);

  const objectFields = focus ? focus.extraFields : '';

  return (
    'You are an expert visual analyst for an AI image generation tool. ' +
    'Your job is to describe images precisely for use as generation prompts and to extract ' +
    'structured visual facts. Focus only on what a camera sees: visual facts, not interpretation ' +
    'or story.\n\n' +
    `${focusInstruction} Return ONLY a single valid JSON object ` +
    '(no markdown fences, no preamble, no trailing text) with exactly this shape:\n' +
    '{\n' +
    '  "description": "2-4 sentence prompt-ready description' + (isObjectFocus ? ' of the object only' : ', covering subject, appearance, lighting, setting') + '",\n' +
    objectFields +
    (wantsKeyFeatures ? '  "keyFeatures": [ {"name": "short object/landmark name, e.g. water tank", "position": "where it sits in frame, e.g. right side, midground"} ],\n' : '') +
    '  "attributes": {\n' +
    '    "hair": "", "eyes": "", "skinTone": "", "ageRange": "", "build": "",\n' +
    '    "distinguishingMarks": [], "clothing": [], "accessories": []\n' +
    '  },\n' +
    '  "lockTraits": [],\n' +
    '  "variableTraits": [],\n' +
    '  "shotType": "close-up | medium | full-body | other",\n' +
    '  "styleMedium": "photo | illustration | 3d-render | other",\n' +
    '  "tags": []\n' +
    '}\n' +
    (wantsKeyFeatures ? '"keyFeatures" = every distinct, nameable object or landmark visible in the frame that ' +
      'isn\'t already the main subject of "description" — list each with a short name and its position ' +
      'in frame (left/right/center, foreground/midground/background). Empty array if nothing distinct ' +
      'stands out beyond the main description. ' : '') +
    (isObjectFocus ? 'Leave "attributes" fields empty since this is an object, not a person/character. ' : '') +
    (assetType === 'location' || assetType === 'era' || assetType === 'style' ? 'Leave "attributes" fields empty — they only apply to character analysis. ' : '') +
    'Leave any field empty ("" or []) if it cannot be determined from the image. ' +
    'lockTraits = identity-critical details that must stay fixed across shots (e.g. hair color, eye color, scars). ' +
    'variableTraits = details fine to change between shots (e.g. pose, expression, lighting). ' +
    'Output ONLY the JSON object.'
  );
}

/* ── Build the structured shape from a successfully-parsed JSON object.
   Factored out so every parse path below (clean parse, salvage parse,
   regex-recovered partial) builds the exact same shape. ──────────── */
function _shapeAnalysis(parsed) {
  return {
    description: parsed.description || '',
    material: parsed.material || '',
    condition: parsed.condition || '',
    // Named objects/landmarks + in-frame position — see SPATIAL_FEATURE_TYPES
    // above. Each item expected as {name, position}; tolerate a bare string
    // too (position: '') in case the model returns a plain list.
    keyFeatures: Array.isArray(parsed.keyFeatures)
      ? parsed.keyFeatures.map(f => typeof f === 'string' ? { name: f, position: '' } : { name: f?.name || '', position: f?.position || '' }).filter(f => f.name)
      : [],
    attributes: parsed.attributes || {},
    lockTraits: Array.isArray(parsed.lockTraits) ? parsed.lockTraits : [],
    variableTraits: Array.isArray(parsed.variableTraits) ? parsed.variableTraits : [],
    shotType: parsed.shotType || '',
    styleMedium: parsed.styleMedium || '',
    tags: Array.isArray(parsed.tags) ? parsed.tags : []
  };
}

/* ── Parse a model's raw text response into the structured shape.
   Bug found 2026-07-03: occasionally the raw JSON itself (or a truncated/
   malformed fragment of it) was shown to the user as the "description" —
   this happened whenever JSON.parse() failed, since the old fallback just
   treated the ENTIRE raw text as a plain description with no attempt to
   recover the actual JSON inside it first. Two realistic causes: (1) the
   model adds a stray sentence of preamble/postamble around the JSON
   despite being told not to, or (2) the response gets cut off mid-JSON by
   the token limit — more likely now that keyFeatures (added 2026-07-03)
   made the expected response longer. This adds two recovery passes before
   ever falling back to raw text, plus a guard so raw JSON-looking text is
   never shown verbatim as a "description" even in the worst case. ──── */
function parseAnalyserResponse(rawText) {
  if (!rawText) return null;
  let cleaned = rawText.trim();
  // Strip markdown code fences if present (```json ... ``` or ``` ... ```)
  cleaned = cleaned.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();

  // Pass 1 — straightforward parse (the common case).
  try {
    const parsed = JSON.parse(cleaned);
    if (parsed && typeof parsed === 'object') return _shapeAnalysis(parsed);
  } catch (e) { /* fall through to salvage passes below */ }

  // Pass 2 — the model added stray text before/after the JSON object
  // despite the "Output ONLY the JSON object" instruction. Slice from the
  // first "{" to the last "}" and try again.
  const firstBrace = cleaned.indexOf('{');
  const lastBrace = cleaned.lastIndexOf('}');
  if (firstBrace !== -1 && lastBrace > firstBrace) {
    try {
      const parsed = JSON.parse(cleaned.slice(firstBrace, lastBrace + 1));
      if (parsed && typeof parsed === 'object') return _shapeAnalysis(parsed);
    } catch (e) { /* still broken — likely truncated mid-object, try pass 3 */ }
  }

  // Pass 3 — response was cut off before the closing brace (token-limit
  // truncation) so there's no valid JSON to parse at all. Regex out just
  // the "description" field's value directly from the raw text — usually
  // still intact even when later fields (attributes/keyFeatures/tags) got
  // cut off — so the user at least sees real prose instead of a JSON shard.
  const descMatch = cleaned.match(/"description"\s*:\s*"((?:[^"\\]|\\.)*)"/);
  if (descMatch) {
    let recovered = descMatch[1].replace(/\\"/g, '"').replace(/\\n/g, ' ').replace(/\\\\/g, '\\');
    return { ..._shapeAnalysis({}), description: recovered };
  }

  // Nothing recoverable. If this still looks like JSON syntax, showing it
  // raw would just dump a JSON blob in the UI — say so plainly instead.
  // Only genuinely non-JSON prose (rare legacy case) is passed through as-is.
  const looksLikeJson = /^\s*\{/.test(cleaned) || (cleaned.match(/"\w+"\s*:/g) || []).length >= 2;
  const description = looksLikeJson
    ? '(Analysis response could not be read — likely cut off. Try Re-analyse.)'
    : cleaned;
  return { ..._shapeAnalysis({}), description };
}

/* ── Normalize any stored analysis (legacy string OR structured
   object) into the structured shape, for safe reading everywhere. ── */
function normalizeAnalysis(stored) {
  if (!stored) return null;
  if (typeof stored === 'string') {
    return { description: stored, material: '', condition: '', keyFeatures: [], attributes: {}, lockTraits: [], variableTraits: [], shotType: '', styleMedium: '', tags: [] };
  }
  // Legacy structured analyses saved before keyFeatures existed won't have
  // the field at all — default it so downstream code can rely on it always
  // being an array.
  if (!Array.isArray(stored.keyFeatures)) stored.keyFeatures = [];
  return stored;
}

/* ── Is ANY vision provider available right now? ─────────────── */
// True if the user has their own key for either provider, OR is sponsored
// by someone else's key (see _sponsorStatusCache below).
function isVisionAvailable() {
  return isApiActive('anthropic') || isApiActive('gemini') || hasAnySponsor();
}

/* ── SPONSOR STATUS (cached lookup) ───────────────────────────
   A user with no own key can still analyse images if someone has
   added them to their sponsor allowlist (Settings → Sponsor, see
   07-settings.js / save_sponsor_key in api.php). We cache the result
   of get_sponsor_status for the session so we don't re-check the
   server on every render of every Analyse button. Call
   refreshSponsorStatus() after login/init, and again any time the
   user might have just been added to a list (cheap to just refetch
   when in doubt — it's a single small request). */
let _sponsorStatusCache = null; // null = not yet loaded; [] = loaded, none found

async function refreshSponsorStatus() {
  const user = getCurrentUser();
  const password = (typeof getCurrentPassword === 'function') ? getCurrentPassword() : null;
  if (!user || !password) { _sponsorStatusCache = []; return _sponsorStatusCache; }
  const res = await apiCall('get_sponsor_status', { username: user, password });
  _sponsorStatusCache = (res && res.sponsors) || [];
  return _sponsorStatusCache;
}

function hasAnySponsor() {
  return Array.isArray(_sponsorStatusCache) && _sponsorStatusCache.length > 0;
}

// Pick the best sponsor for a given provider preference: prefer a sponsor
// who has a key for the requested provider; fall back to any sponsor with
// either key. Returns { owner_username, provider } or null.
function pickSponsorFor(preferredProvider) {
  if (!Array.isArray(_sponsorStatusCache)) return null;
  const keyField = preferredProvider === 'gemini' ? 'has_gemini_key' : 'has_anthropic_key';
  let match = _sponsorStatusCache.find(s => s[keyField]);
  if (match) return { owner_username: match.owner_username, provider: preferredProvider };
  match = _sponsorStatusCache.find(s => s.has_anthropic_key || s.has_gemini_key);
  if (match) return { owner_username: match.owner_username, provider: match.has_anthropic_key ? 'anthropic' : 'gemini' };
  return null;
}

/* ── PUBLIC: inject Analyse button into a rendered slot preview ─ */
// Called from renderSlotPreview() after an image is shown.
function injectAnalyseButton(slotKey) {
  if (!isVisionAvailable()) return; // no key on either provider → no button
  const preview = document.getElementById('asset-img-slot-' + slotKey)
                           ?.querySelector('.asset-img-slot-preview');
  if (!preview) return;
  // Don't double-inject
  if (preview.querySelector('.ia-analyse-btn')) return;

  const btn = document.createElement('button');
  btn.className = 'ia-analyse-btn';
  btn.title = 'Analyse image with AI';
  btn.textContent = '✦ Analyse';
  btn.onclick = () => runSlotAnalysis(slotKey, btn);
  preview.appendChild(btn);
}

/* ── PUBLIC: inject Analyse buttons for all slots that have images ─ */
// Called after buildAssetFormHTML renders existing images.
function injectAllAnalyseButtons() {
  if (!isVisionAvailable()) return;
  document.querySelectorAll('.asset-img-slot').forEach(slot => {
    const key = slot.id.replace('asset-img-slot-', '');
    if (slot.querySelector('.asset-img-slot-preview')) {
      injectAnalyseButton(key);
    }
  });
  injectMergeButtonsForSaved();
}

/* Batch-progress counters, read by runSlotAnalysis() to decide whether to
   show "image N of M" (set by batchAnalyseAllSlots()) or a plain
   indeterminate sweep (standalone single-slot call, counters at 0). */
let _batchStepIndex = 0;
let _batchStepTotal = 0;

/* ── RUN ANALYSIS for a single slot ─────────────────────────── */
// Dispatches to whichever vision provider is selected in Settings
// (default: anthropic). Falls back to the other provider if the
// preferred one has no key configured, so a single missing/expired
// key doesn't block analysis if the other provider is ready.
async function runSlotAnalysis(slotKey, btn) {
  const imgEl = document.getElementById('asset-img-' + slotKey);
  if (!imgEl || !imgEl.src) { showToast('No image to analyse', 'warning'); return; }

  let provider = (typeof getVisionProvider === 'function') ? getVisionProvider() : 'anthropic';
  let useOwnKey = true;
  let apiKey = null;
  let sponsor = null;

  if (!isApiActive(provider)) {
    const fallback = provider === 'anthropic' ? 'gemini' : 'anthropic';
    if (isApiActive(fallback)) {
      provider = fallback;
    } else {
      // No own key on either provider — fall back to a sponsor's key if one
      // is available (see refreshSponsorStatus()/pickSponsorFor() above).
      sponsor = pickSponsorFor(provider);
      if (sponsor) {
        useOwnKey = false;
        provider = sponsor.provider;
      } else {
        showToast('No API key — add one in Settings', 'warning');
        return;
      }
    }
  }

  if (useOwnKey) {
    apiKey = getApiKey(provider);
    if (!apiKey) { showToast('No API key — add one in Settings', 'warning'); return; }
  }

  // Disable button while running
  btn.disabled = true;
  btn.textContent = '⏳ Analysing…';

  // Urgent UX fix (2026-06-25): the button-text toggle above was the only
  // feedback during analysis — fine for a single slot, but easy to miss,
  // and gave no sense of progress at all during a multi-slot batch run.
  // _batchStepIndex/_batchStepTotal are set by batchAnalyseAllSlots()
  // below when this function is called as part of a batch; if unset,
  // this is a standalone single-slot call and we show an indeterminate
  // sweep instead of a fabricated percentage.
  if (typeof showProgress === 'function') {
    if (_batchStepTotal > 0) {
      showProgress(`Analysing image ${_batchStepIndex} of ${_batchStepTotal}…`,
        { pct: (_batchStepIndex - 1) / _batchStepTotal * 100 });
    } else {
      showProgress('Analysing image…');
    }
  }

  try {
    // callVisionApi(Gemini) now returns a structured object:
    // { description, attributes, lockTraits, variableTraits, shotType, styleMedium, tags }
    const analysis = useOwnKey
      ? (provider === 'gemini'
          ? await callVisionApiGemini(imgEl.src, apiKey, slotKey)
          : await callVisionApi(imgEl.src, apiKey, slotKey))
      : await callVisionApiViaSponsor(imgEl.src, sponsor.owner_username, provider, slotKey);
    if (analysis && analysis.description) {
      storeAnalysis(slotKey, analysis);
      renderAnalysisResult(slotKey, analysis);
      const sourceLabel = useOwnKey ? '' : ' · sponsored';
      showToast('Analysis complete ✦ (' + (provider === 'gemini' ? 'Gemini' : 'Claude') + sourceLabel + ')', 'success');
    } else {
      // The call succeeded (no exception) but came back with nothing usable —
      // e.g. the provider returned an empty/unparseable response. Surface this
      // instead of leaving the button stuck on "Analysing…" with no feedback.
      showToast('Analysis returned no result — try again, or check the sponsor\'s key/quota', 'warning');
      btn.disabled = false;
      btn.textContent = '✦ Analyse';
    }
  } catch(err) {
    console.error('Image analysis error:', err);
    showToast('Analysis failed: ' + (err.message || 'unknown error'), 'error');
    btn.disabled = false;
    btn.textContent = '✦ Analyse';
  } finally {
    // Only close the overlay here if this was a standalone call — inside a
    // batch run, batchAnalyseAllSlots() owns opening/closing/advancing the
    // overlay across the whole loop so it doesn't flicker shut between slots.
    if (_batchStepTotal === 0 && typeof hideProgress === 'function') hideProgress();
  }
}

/* ── CALL VISION API VIA SPONSOR PROXY ───────────────────────
   Same prompt-building as callVisionApi()/callVisionApiGemini(), but
   sends the finished prompt + image to api.php's analyse_image action
   instead of calling the provider directly. The server decrypts the
   sponsoring owner's key and makes the actual provider call — the key
   itself never reaches this browser. Requires the caller's own
   password in memory (see getCurrentPassword in 00-api.js), since
   analyse_image is gated by require_password() server-side. */
async function callVisionApiViaSponsor(dataUrl, ownerUsername, provider, slotKey) {
  const match = dataUrl.match(/^data:(image\/[a-zA-Z+]+);base64,(.+)$/);
  if (!match) throw new Error('Invalid image data URL');
  const mediaType = match[1];
  const base64Data = match[2];

  const slotDef = Object.values(IMAGE_SLOTS).flat().find(s => s.key === slotKey);
  const slotContext = slotDef ? `This is a "${slotDef.label}" image (${slotDef.hint}).` : '';
  const assetType = document.getElementById('asset-type-hidden')?.value || '';
  const focusHint = document.getElementById('ia-focus-hint-' + slotKey)?.value || '';
  const userPrompt = buildAnalyserPrompt(slotContext, assetType, focusHint);
  const systemPrompt =
    'You are an expert visual analyst for an AI image generation tool. ' +
    'You always respond with a single valid JSON object and nothing else.';

  const password = (typeof getCurrentPassword === 'function') ? getCurrentPassword() : null;
  if (!password) throw new Error('Please sign in again to use a sponsored key');

  const res = await apiCall('analyse_image', {
    password,
    owner_username: ownerUsername,
    provider,
    mediaType,
    base64Data,
    systemPrompt,
    userPrompt,
    maxTokens: ANALYSER_MAX_TOK,
    model: provider === 'gemini' ? ANALYSER_MODEL_GEMINI : ANALYSER_MODEL,
    assetType,
  });
  if (!res) throw new Error(lastApiError || 'Sponsored analysis failed');
  return parseAnalyserResponse(res.rawText || null);
}

/* ── CALL ANTHROPIC VISION API ───────────────────────────────── */
async function callVisionApi(dataUrl, apiKey, slotKey) {
  // Extract base64 + mime type from data URL
  const match = dataUrl.match(/^data:(image\/[a-zA-Z+]+);base64,(.+)$/);
  if (!match) throw new Error('Invalid image data URL');
  const mediaType = match[1];
  const base64Data = match[2];

  // Build a slot-aware prompt
  const slotDef = Object.values(IMAGE_SLOTS).flat().find(s => s.key === slotKey);
  const slotContext = slotDef ? `This is a "${slotDef.label}" image (${slotDef.hint}).` : '';
  const assetType = document.getElementById('asset-type-hidden')?.value || '';
  const focusHint = document.getElementById('ia-focus-hint-' + slotKey)?.value || '';

  const systemPrompt =
    'You are an expert visual analyst for an AI image generation tool. ' +
    'You always respond with a single valid JSON object and nothing else.';

  const userPrompt = buildAnalyserPrompt(slotContext, assetType, focusHint);

  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'anthropic-dangerous-direct-browser-access': 'true'
    },
    body: JSON.stringify({
      model: ANALYSER_MODEL,
      max_tokens: ANALYSER_MAX_TOK,
      system: systemPrompt,
      messages: [{
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: mediaType, data: base64Data } },
          { type: 'text', text: userPrompt }
        ]
      }]
    })
  });

  if (!response.ok) {
    const errBody = await response.json().catch(() => ({}));
    throw new Error(errBody?.error?.message || `HTTP ${response.status}`);
  }

  const data = await response.json();
  const rawText = data?.content?.[0]?.text?.trim() || null;
  return parseAnalyserResponse(rawText);
}

/* ── CALL GEMINI VISION API ──────────────────────────────────── */
async function callVisionApiGemini(dataUrl, apiKey, slotKey) {
  // Extract base64 + mime type from data URL
  const match = dataUrl.match(/^data:(image\/[a-zA-Z+]+);base64,(.+)$/);
  if (!match) throw new Error('Invalid image data URL');
  const mediaType = match[1];
  const base64Data = match[2];

  // Build a slot-aware prompt (same approach as Claude vision call)
  const slotDef = Object.values(IMAGE_SLOTS).flat().find(s => s.key === slotKey);
  const slotContext = slotDef ? `This is a "${slotDef.label}" image (${slotDef.hint}).` : '';
  const assetType = document.getElementById('asset-type-hidden')?.value || '';
  const focusHint = document.getElementById('ia-focus-hint-' + slotKey)?.value || '';

  const promptText = buildAnalyserPrompt(slotContext, assetType, focusHint);

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${ANALYSER_MODEL_GEMINI}:generateContent?key=${encodeURIComponent(apiKey)}`;

  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{
        parts: [
          { text: promptText },
          { inline_data: { mime_type: mediaType, data: base64Data } }
        ]
      }],
      generationConfig: { maxOutputTokens: ANALYSER_MAX_TOK }
    })
  });

  if (!response.ok) {
    const errBody = await response.json().catch(() => ({}));
    throw new Error(errBody?.error?.message || `HTTP ${response.status}`);
  }

  const data = await response.json();
  const text = data?.candidates?.[0]?.content?.parts?.map(p => p.text).join('').trim();
  return parseAnalyserResponse(text || null);
}

/* ── STORE ANALYSIS in the current editing context ───────────── */
// Stores in a temporary per-slot map so saveAsset() can pick it up.
const _pendingAnalysis = {};

// `analysis` is the structured object { description, attributes, lockTraits,
// variableTraits, shotType, styleMedium, tags }. Kept as one object per slot.
function storeAnalysis(slotKey, analysis) {
  _pendingAnalysis[slotKey] = analysis;
}

function getPendingAnalysis(slotKey) {
  return _pendingAnalysis[slotKey] || null;
}

function clearPendingAnalysis() {
  Object.keys(_pendingAnalysis).forEach(k => delete _pendingAnalysis[k]);
}

// Removes a single slot's pending analysis (used when an image is deleted
// from a slot, e.g. via removeSlotImage's confirmation guard) and marks it
// for deletion from the saved asset record on next save.
const _slotsToClearOnSave = new Set();

function clearPendingAnalysisForSlot(slotKey) {
  delete _pendingAnalysis[slotKey];
  _slotsToClearOnSave.add(slotKey);
}

/* ── RENDER ANALYSIS RESULT inline below the image slot ─────── */
// `analysis` may be the structured object or (for legacy saved data)
// a plain string — normalizeAnalysis() handles both. Display is
// description-only for now; the extra structured fields (attributes,
// lockTraits, tags, etc.) are captured and saved but not yet shown
// in the UI — see session notes 2026-06-19 for planned follow-on
// features (Character Bible panel, library search/filter, etc.).
function renderAnalysisResult(slotKey, analysis) {
  const slot = document.getElementById('asset-img-slot-' + slotKey);
  if (!slot) return;

  const norm = normalizeAnalysis(analysis);
  if (!norm) return;

  // Remove existing result block if any
  slot.querySelector('.ia-result')?.remove();

  // Surface any tagged key features so the user can see/confirm what the
  // analysis caught (e.g. "water tank") before merging — same data that
  // resolveLocationImageForContext() (01-core.js) later matches against
  // scene text to decide which image slot to surface.
  const kfHtml = (Array.isArray(norm.keyFeatures) && norm.keyFeatures.length)
    ? `<div class="ia-result-features" style="margin-top:4px;font-size:0.72rem;color:var(--ink-mid)">📍 Key features: ${norm.keyFeatures.map(f => escHtml(f.position ? `${f.name} (${f.position})` : f.name)).join(', ')}</div>`
    : '';

  const block = document.createElement('div');
  block.className = 'ia-result';
  block.innerHTML = `
    <div class="ia-result-label">✦ AI Analysis</div>
    <div class="ia-result-text" id="ia-text-${slotKey}">${escHtml(norm.description)}</div>
    ${kfHtml}
    <button class="ia-merge-btn" title="Merge into Description field" onclick="mergeAnalysisIntoDesc('${slotKey}')">
      🪄 Merge into Description
    </button>`;
  slot.appendChild(block);

  // Update the Analyse button to show re-run state
  const btn = slot.querySelector('.ia-analyse-btn');
  if (btn) { btn.disabled = false; btn.textContent = '✦ Re-analyse'; }

  // Show the ✦ analysed badge on the preview
  const preview = slot.querySelector('.asset-img-slot-preview');
  if (preview && !preview.querySelector('.asset-img-slot-analysed')) {
    const badge = document.createElement('div');
    badge.className = 'asset-img-slot-analysed';
    badge.title = 'Analysis saved';
    badge.textContent = '✦';
    preview.appendChild(badge);
  }
}

/* ── MERGE: prepend AI description into the Description textarea ─
   For prop/wardrobe assets, also auto-fills the Material and Condition
   Smart Injection fields from the same analysis — but only if those
   fields are currently empty, so it never overwrites something the
   user already typed. Narrative Significance is left untouched since
   it isn't something a photo can tell you. ─────────────────────── */
function mergeAnalysisIntoDesc(slotKey) {
  const pending = _pendingAnalysis[slotKey];
  const norm = (pending && typeof pending === 'object') ? pending : null;
  const aiText = (norm ? norm.description : pending)
    || document.getElementById('ia-text-' + slotKey)?.textContent?.trim();
  if (!aiText) return;

  const desc = document.getElementById('asset-desc');
  if (!desc) return;

  // Task #3 fix: tag each merged chunk with its source slot (Close-up,
  // Mid Shot, Full Body, etc.) instead of blind-concatenating multiple
  // analyses into one undifferentiated run-on. Without this, merging
  // analyses from 2-3 image slots left the Description field as plain
  // prose with no way to tell which sentence came from which shot.
  const _slotLabel = ({
    closeup: 'Close-up', midshot: 'Mid Shot', fullbody: 'Full Body',
    sheet: 'Character Sheet', wide: 'Wide / Establishing', detail: 'Detail',
    full: 'Full View', reference: 'Period Reference'
  })[slotKey] || slotKey;
  // Fold keyFeatures into this slot's tagged text as a trailing clause —
  // e.g. "Key features: water tank (right side, midground)." Keeps the data
  // in the same plain-text, per-slot storage the rest of the app already
  // relies on (no new field on the asset model), so it's caught by ordinary
  // keyword/@mention matching and survives save/sync exactly like the rest
  // of the description. See resolveLocationImageForContext() (01-core.js),
  // which parses this same clause back out to decide which image slot to
  // surface when scene text names one of these features. Added 2026-07-03.
  const kf = (norm && Array.isArray(norm.keyFeatures)) ? norm.keyFeatures.filter(f => f && f.name) : [];
  const featuresText = kf.length
    ? ' Key features: ' + kf.map(f => f.position ? `${f.name} (${f.position})` : f.name).join(', ') + '.'
    : '';
  const taggedText = `[${_slotLabel}] ${aiText}${featuresText}`;

  const existing = desc.value.trim();
  let mergedDescAlready = false;
  if (existing) {
    // Avoid double-merging the exact same text (check against the raw
    // aiText, not the tagged version, so a re-merge of the same slot is
    // still caught even if the tag prefix changed format previously)
    if (existing.includes(aiText.slice(0, 40))) {
      mergedDescAlready = true;
    } else {
      desc.value = existing + '\n' + taggedText;
    }
  } else {
    desc.value = taggedText;
  }

  // The merged text is prepended at the very start of the textarea. If the
  // box was scrolled down (e.g. from reading a long existing description),
  // the new text lands above the visible area and looks like nothing
  // happened even though the value did update — scroll/cursor back to the
  // top so the merge is actually visible immediately.
  // Bug found 2026-07-03: plain desc.focus() made the browser auto-scroll
  // the whole Asset modal to bring the (lower-down) Description textarea
  // into view — which scrolled the AI Analysis result box (sitting above,
  // inside the image slot) out of the visible area. Nothing was actually
  // removed from the DOM (renderAnalysisResult() only clears/rebuilds its
  // own block, never on merge) — it just looked like it "vanished" because
  // the merge action yanked the modal's scroll position downward.
  // { preventScroll: true } keeps the textarea's OWN scroll-to-top +
  // cursor-placement behavior (still useful, per the comment above) without
  // dragging the outer modal's scroll position along with it.
  if (!mergedDescAlready) {
    desc.scrollTop = 0;
    desc.setSelectionRange(0, 0);
    desc.focus({ preventScroll: true });
  }

  // Flash the Description textarea
  if (!mergedDescAlready) {
    desc.style.outline = '2px solid var(--amber)';
    setTimeout(() => { desc.style.outline = ''; }, 1200);
  }

  // Auto-fill Material / Condition for prop/wardrobe assets, empty fields only
  let filledExtra = false;
  const filledFieldLabels = [];
  if (norm) {
    const materialField = document.getElementById('asset-material');
    if (materialField && !materialField.value.trim() && norm.material) {
      materialField.value = norm.material;
      filledExtra = true;
      filledFieldLabels.push('Material');
    }
    const conditionField = document.getElementById('asset-condition');
    if (conditionField && !conditionField.value.trim() && norm.condition) {
      conditionField.value = norm.condition;
      filledExtra = true;
      filledFieldLabels.push('Condition');
    }

    // Auto-fill character Costume & Appearance from the same analysis,
    // empty-field-only — same pattern as Material/Condition above, extended
    // 2026-07-11 per the user's request to route "relevant factual data"
    // (visual facts a camera can actually see) into the field it belongs in,
    // instead of leaving everything to sit as one undifferentiated blob in
    // Description. Deliberately scoped to costume ONLY, not Era/Period or
    // Emotional Range — those aren't camera facts: the analyser prompt's
    // own system instruction is "focus only on what a camera sees: visual
    // facts, not interpretation or story", and a single reference photo
    // shows one moment/expression, not a RANGE of emotional states, nor a
    // reliable read on story-level period/setting. attributes.clothing/
    // attributes.accessories are the two fields the model already extracts
    // for a character that map cleanly onto what "Costume & Appearance"
    // actually asks for (see buildAnalyserPrompt()'s attributes shape above).
    const assetType = document.getElementById('asset-type-hidden')?.value || '';
    if (assetType === 'character') {
      const costumeField = document.getElementById('asset-costume');
      const clothing = Array.isArray(norm.attributes?.clothing) ? norm.attributes.clothing.filter(Boolean) : [];
      const accessories = Array.isArray(norm.attributes?.accessories) ? norm.attributes.accessories.filter(Boolean) : [];
      if (costumeField && !costumeField.value.trim() && (clothing.length || accessories.length)) {
        const parts = [];
        if (clothing.length) parts.push(clothing.join(', '));
        if (accessories.length) parts.push('Accessories: ' + accessories.join(', '));
        costumeField.value = parts.join('. ');
        filledExtra = true;
        filledFieldLabels.push('Costume & Appearance');
      }
    }
  }

  if (mergedDescAlready && !filledExtra) {
    showToast('Already merged', 'warning');
    return;
  }

  showToast(filledExtra ? `Merged into Description + ${filledFieldLabels.join('/')} ✦` : 'Merged into Description ✦', 'success');
}

/* ── SHOW SAVED ANALYSES when editing an existing asset ──────── */
// Called from openAssetModal after the form renders, if asset has saved analyses.
function injectMergeButtonsForSaved() {
  // Check current editing asset
  const p = getCurrentProject();
  if (!editingAssetId || !p) return;
  const asset = p.assets[editingAssetId];
  if (!asset?.imageAnalysis) return;

  Object.entries(asset.imageAnalysis).forEach(([slotKey, description]) => {
    if (!description) return;
    // Populate pending map so merge works
    _pendingAnalysis[slotKey] = description;
    // Render the result block
    renderAnalysisResult(slotKey, description);
  });
}

/* ── TOKEN BUDGET WARNING for batch analyse ──────────────────── */
// Estimates token cost of analysing all filled slots and warns if high.
// ~768px images → ~1000 tokens each for Haiku vision input.
const VISION_TOKENS_PER_IMAGE = 1000;

function estimateBatchCost() {
  const slots = document.querySelectorAll('.asset-img-slot-preview img');
  const count = slots.length;
  const inputTokens  = count * VISION_TOKENS_PER_IMAGE;
  const outputTokens = count * ANALYSER_MAX_TOK;
  return { count, inputTokens, outputTokens, total: inputTokens + outputTokens };
}

function checkBatchBudget(onProceed) {
  const { count, total } = estimateBatchCost();
  if (count === 0) { showToast('No images to analyse', 'warning'); return; }
  if (total > ANALYSER_BUDGET) {
    showConfirm(
      'Token Budget Warning',
      `Analysing ${count} image${count !== 1 ? 's' : ''} uses ~${total.toLocaleString()} tokens. Proceed?`,
      onProceed
    );
  } else {
    onProceed();
  }
}

/* ── BATCH ANALYSE: analyse all filled slots in the open modal ── */
async function batchAnalyseAllSlots() {
  checkBatchBudget(async () => {
    const slots = Array.from(document.querySelectorAll('.asset-img-slot')).filter(slot => {
      const key = slot.id.replace('asset-img-slot-', '');
      const imgEl = document.getElementById('asset-img-' + key);
      if (!imgEl || !imgEl.src || imgEl.src === window.location.href) return false;
      if (_pendingAnalysis[key]) return false; // skip already-analysed
      return true;
    });

    // Set the shared counters so each runSlotAnalysis() call inside this
    // loop knows its position and shows "image N of M" instead of a plain
    // indeterminate sweep — see _batchStepIndex/_batchStepTotal above.
    _batchStepTotal = slots.length;
    _batchStepIndex = 0;

    try {
      for (const slot of slots) {
        _batchStepIndex++;
        const key = slot.id.replace('asset-img-slot-', '');
        const btn = slot.querySelector('.ia-analyse-btn');
        await runSlotAnalysis(key, btn || { disabled: false, textContent: '' });
      }
    } finally {
      _batchStepTotal = 0;
      _batchStepIndex = 0;
      if (typeof hideProgress === 'function') hideProgress();
    }
  });
}

/* ── PATCH saveAsset TO PERSIST PENDING ANALYSES ─────────────── */
// We monkey-patch the save hook: after the asset object is built,
// merge _pendingAnalysis into imageAnalysis before saving.
// This is called from the patched saveAsset below.
function applyPendingAnalysesToAsset(asset) {
  Object.entries(_pendingAnalysis).forEach(([key, text]) => {
    if (text) asset.imageAnalysis[key] = text;
  });
  // Remove analyses for slots whose image was deleted this session
  _slotsToClearOnSave.forEach(key => {
    if (asset.imageAnalysis) delete asset.imageAnalysis[key];
  });
  _slotsToClearOnSave.clear();
}

/* ── PATCH renderSlotPreview to auto-inject Analyse button ──── */
// We wrap the existing renderSlotPreview so the Analyse button
// appears immediately after a new image is uploaded.
(function patchRenderSlotPreview() {
  const _orig = window.renderSlotPreview;
  if (typeof _orig !== 'function') return;
  window.renderSlotPreview = function(slotKey, dataUrl) {
    _orig.call(this, slotKey, dataUrl);
    // Defer so DOM has settled
    setTimeout(() => injectAnalyseButton(slotKey), 50);
  };
})();

/* ── PATCH openAssetModal to inject buttons on existing images ── */
(function patchOpenAssetModal() {
  const _orig = window.openAssetModal;
  if (typeof _orig !== 'function') return;
  window.openAssetModal = function(id, type) {
    clearPendingAnalysis();
    _orig.call(this, id, type);
    // Defer until the modal's form is in the DOM
    setTimeout(() => {
      injectAllAnalyseButtons();
    }, 100);
  };
})();

/* ── PATCH saveAsset to persist pending analyses ─────────────── */
(function patchSaveAsset() {
  const _orig = window.saveAsset;
  if (typeof _orig !== 'function') return;
  window.saveAsset = async function() {
    // Task #8 hardening (2026-06-25): saveAsset() (01-core.js) is async —
    // it awaits save_project/save_asset network calls. This patch
    // previously called _orig.call(this) WITHOUT awaiting it, then
    // immediately mutated the just-stored asset's imageAnalysis and fired
    // a second saveState() — racing the original in-flight save. If the
    // original's save_asset request had already serialized the asset
    // object before this code attached the pending AI analysis, the
    // analysis silently never reached the server on that save (only
    // recovered if something saved again later). Now we await the
    // original save fully before touching the asset or saving again.
    //
    // Fable audit M4 fix (2026-07-08 report, live-confirmed + applied
    // 2026-07-10): this used to unconditionally assume the just-saved
    // asset was a project character and merge onto "the most recently
    // updated asset in p.assets" — but a shared (Location/Prop/Era/Style)
    // asset save never touches p.assets at all, so for a shared save this
    // silently attached the analysis to some UNRELATED project character
    // and never touched the actual shared asset's imageAnalysis. Live-
    // confirmed 2026-07-10 by tracing real data on the live account:
    // analysing "Jana-home-night" (a shared location) would have attached
    // the analysis to "Mauli" (an unrelated character in the active
    // project) instead — and "Jana-home-night" itself would never have
    // received the analysis at all. Fixed by reading the asset TYPE from
    // the still-open modal's own hidden field before the save runs — the
    // same source saveAssetNow() itself trusts (01-core.js) — and
    // branching on it, instead of guessing after the fact.
    const typeField = document.getElementById('asset-type-hidden');
    const wasSharedType = !!(typeField && SHARED_LIBRARY_TYPES.includes(typeField.value));
    window._lastSavedSharedAsset = null; // clear any stale value from a prior save
    await _orig.call(this);

    if (!Object.keys(_pendingAnalysis).length && !_slotsToClearOnSave.size) {
      clearPendingAnalysis();
      return;
    }

    if (wasSharedType) {
      // saveSharedLibraryAsset() (01-core.js) sets this on every
      // successful save, including a brand-new asset's server-assigned
      // id — null here means the save failed or never ran, so there's
      // nothing to attach the analysis to.
      const saved = window._lastSavedSharedAsset;
      if (saved && saved.asset) {
        applyPendingAnalysesToAsset(saved.asset);
        try {
          const res = await apiCall('save_library_asset', { type: saved.type, asset: saved.asset });
          if (res && res.asset) {
            // Same "patch, don't refetch" pattern as H1 — keep the caches
            // consistent with what the server just confirmed.
            if (typeof _patchLibraryCache === 'function') _patchLibraryCache(saved.type, res.asset);
            if (typeof _libraryFullCache !== 'undefined' && _libraryFullCache[saved.type]) {
              _libraryFullCache[saved.type][res.asset.id] = res.asset;
            }
          } else {
            showToast('Asset saved, but image analysis failed to sync — check your connection', 'warning');
          }
        } catch (err) {
          showToast('Asset saved, but image analysis failed to sync — check your connection', 'warning');
        }
      }
      clearPendingAnalysis();
      return;
    }

    // Project character path (unchanged from before) — _orig only ever
    // mutates p.assets for a character save, so "most recently updated
    // project asset" reliably means the one just saved.
    const p = getCurrentProject();
    if (!p) { clearPendingAnalysis(); return; }
    const recent = Object.values(p.assets).sort((a, b) => (b.updated || 0) - (a.updated || 0))[0];
    if (recent) {
      applyPendingAnalysesToAsset(recent);
      // Fable audit fix (2026-07-08 report, applied 2026-07-10, H3):
      // targeted single-asset save instead of the blanket saveState() —
      // see saveProjectMetaOnly() (00-api.js) for the equivalent pattern
      // used elsewhere.
      try {
        const res = await apiCall('save_asset', { project_id: p.id, asset: recent });
        if (!res) throw new Error('save_asset failed for ' + (recent.name || recent.id));
      } catch (err) {
        showToast('Asset saved, but image analysis failed to sync — check your connection', 'warning');
      }
    }
    clearPendingAnalysis();
  };
})();
