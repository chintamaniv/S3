/* ══════════════════════════════════════════════════════════════
   MODE 1 — SINGLE FRAME
══════════════════════════════════════════════════════════════ */

/* ── SF STATE ─────────────────────────────────────────────── */
const sfState = {
  outputType: 'still',    // still | motion
  platform: 'nb',         // mj | nb | gpt
  selectedAssets: {},      // { assetId: true }
  selectedAssetOrder: [],  // click order of selected character chips — first
                           // clicked = foreground/anchor figure (OS/Two
                           // Shot/Three Shot role), rest follow in order.
                           // Only meaningful for multi-figure frames.
  osSharpSubjectSide: 'frame-right', // OS frame only — which side of the
                           // frame the sharp/camera-facing figure (2nd
                           // clicked) is positioned on. Foreground/anchor
                           // figure (1st clicked) takes the opposite side.
                           // Default frame-right since the existing OS
                           // composition text already implies the anchor's
                           // shoulder enters from frame-left in most
                           // eye-level setups — user can flip it per shot.
  twoshotAnchorSide: 'frame-right', // Two Shot only — which side of the frame
                           // the soft-anchor figure (2nd clicked) sits on.
                           // Dominant/sharp figure (1st clicked) takes the
                           // opposite side. Same gap as OS, found via the
                           // same 2026-06-29 audit — "frame edge" previously
                           // had no side assigned at all.
  threeshotSides: 'second-left', // Three Shot only — which clicked order maps
                           // to which side. 'second-left' = 2nd-clicked on
                           // frame-left, 3rd-clicked on frame-right.
                           // 'second-right' flips it. Centre figure (1st
                           // clicked) is always centred. Previously neither
                           // flanking figure had ANY side assignment — the
                           // composition text just listed both names with no
                           // left/right mapping at all.
  genre: null,
  frame: null,
  ratio: null,
  selections: {
    // chips by group: array of values
    angle: [], 'lighting-setup': [], 'lighting-natural': [], tod: [], lens: [], aperture: [],
    camera: [], mood: [], quality: [], neg: [], condition: [],
    'motion-element': [], 'motion-type': [], 'motion-intensity': [],
    'motion-duration': []
  },
  freeText: {
    subject: '', wardrobe: '', env: '', mood: '', neg: ''
  },
  sigs: {
    'dual-light': false, sss: false, particles: false,
    practical: false, wind: false, frozen: false
  },
  showAutoDetail: false,
  dutch: false,
  // Shot Setup Single Frame port, phase 1 (2026-07-10) — mirrors Storyboard's
  // panel.cameraFacingDirection (06-scene-engine.js). Single Frame has only
  // one "shot" at a time (no panel array), so this lives directly on sfState
  // rather than per-panel. Set via the "Camera faces" dropdown
  // (sfCameraFacingInnerHTML()), read by collectSFData()'s _directionNote().
  cameraFacingDirection: null
};

/* ── PREREQUISITE ENGINE ──────────────────────────────────── */
const PREREQ = {
  face: {
    inject: [
      'subsurface scattering skin render',
      'individual pore detail',
      'skin moisture highlights',
      'individual hair strand separation',
      'catchlight in eyes'
    ],
    dim: ['env', 'angle']
  },
  head: {
    inject: [
      'subsurface scattering',
      'upper costume material detail',
      'hair physics',
      'shallow depth of field'
    ],
    dim: []
  },
  waist: {
    inject: [
      'dual light temperature',
      'material state of costume clearly visible'
    ],
    dim: []
  },
  fullbody: {
    inject: [
      'ground texture integration',
      'full costume completeness',
      'environmental integration',
      'full figure in frame, feet included'
    ],
    dim: []
  },
  wide: {
    inject: [
      'atmospheric perspective',
      'three-plane depth — foreground, midground, background',
      'airborne particles',
      'scale reference elements'
    ],
    dim: ['face', 'expression']
  }
};

/* ── CAMERA AUTO-SUGGEST ─────────────────────────────────── */
const CAMERA_SUGGEST = {
  face:     { lens: '100-135mm medium telephoto', aperture: 'f/2.8',      lensVal: '100mm medium telephoto',             apertureVal: 'f/2.8 — shallow depth of field, subject separation', sss: true,  note: 'Medium telephoto for face — no distortion at close range' },
  head:     { lens: '85mm portrait lens',         aperture: 'f/1.4–f/2.8', lensVal: '85mm portrait lens',                apertureVal: 'f/1.4 — extreme shallow depth of field, creamy bokeh', sss: true, note: '85mm flatters portrait proportions, f/1.4 for subject isolation' },
  waist:    { lens: '50–85mm lens',               aperture: 'f/2.8–f/5.6', lensVal: '50mm standard lens',                apertureVal: 'f/2.8 — shallow depth of field, subject separation', sss: false, note: 'Natural perspective at waist up, moderate depth' },
  fullbody: { lens: '35–50mm lens',               aperture: 'f/5.6–f/8',   lensVal: '35mm lens',                         apertureVal: 'f/5.6 — moderate depth',                             sss: false, note: 'Wider frame, enough depth to keep full figure sharp' },
  wide:     { lens: '14–35mm wide angle',         aperture: 'f/8–f/11',    lensVal: '14-24mm ultra-wide lens',           apertureVal: 'f/8 — deep focus, sharp throughout',                 sss: false, note: 'Wide environmental, maximum depth of field' },
  // Multi-figure frames (added alongside OS/Two Shot/Three Shot/ECU frame
  // cards). Same auto-suggest mechanism as above — keyed by sfState.frame,
  // consumed by renderCameraAutoSuggest(). lensVal/apertureVal must match an
  // existing data-val exactly in #sf-lens-chips / #sf-aperture-chips (see
  // ss_studioV7.html ~3057-3070) — no new chip options were added, these
  // recommendations only select among the 6 lens / 5 aperture choices that
  // already exist.
  os:        { lens: '85mm portrait lens',  aperture: 'f/2.8',  lensVal: '85mm portrait lens',        apertureVal: 'f/2.8 — shallow depth of field, subject separation', sss: true,  note: '85mm holds foreground shoulder soft and the sharp subject separated beyond it' },
  twoshot:   { lens: '50mm standard lens',  aperture: 'f/5.6',  lensVal: '50mm standard lens',         apertureVal: 'f/5.6 — moderate depth',                             sss: false, note: 'Natural perspective, enough depth to keep both figures sharp' },
  threeshot: { lens: '35mm lens',           aperture: 'f/8',    lensVal: '35mm lens',                  apertureVal: 'f/8 — deep focus, sharp throughout',                 sss: false, note: 'Wider field and deep focus needed to keep three figures sharp across the frame' },
  ecu:       { lens: '200mm+ telephoto',    aperture: 'f/1.4',  lensVal: '200mm telephoto compression', apertureVal: 'f/1.4 — extreme shallow depth of field, creamy bokeh', sss: false, note: 'Maximum compression and isolation for a single extreme close-up detail' }
};

// Camera body / film stock auto-suggest — keyed by sfState.genre, consumed by
// renderCameraBodyAutoSuggest(). cameraVal must match an existing data-val
// exactly in #sf-camera-brand-chips (8 fixed options, ss_studioV7.html
// ~3076-3083) — no new chips added, this only pre-selects among the existing
// brand/film-stock choices based on genre. Same override precedent as lens/
// aperture: manual click on a chip converts it to permanent manual selection
// (toggleSFChip strips auto-selected/autoGroup), and the render function
// never overwrites an already-active chip.
const CAMERA_BODY_SUGGEST = {
  'mythology':          { cameraVal: 'shot on Hasselblad, HNCS colour science, medium format', note: 'Medium format — rich tonal range for devotional/iconographic detail' },
  'cinematic-portrait': { cameraVal: 'shot on ARRI Alexa, cinema standard, filmic latitude',    note: 'Cinema camera — filmic dynamic range for portrait work' },
  'fantasy':            { cameraVal: 'shot on ARRI Alexa, cinema standard, filmic latitude',    note: 'Cinema camera — wide dynamic range for dramatic, high-contrast scenes' },
  'street':             { cameraVal: 'shot on Leica, film-inspired, rich shadows',              note: 'Leica — reportage feel, suited to candid documentary style' },
  'product':            { cameraVal: 'shot on Sony A7, clinical sharpness, high resolution',    note: 'Clinical sharpness and neutral colour for commercial product work' },
  'illustrated':        { cameraVal: 'Fuji Velvia film stock, saturated, vivid landscape',       note: 'Saturated, vivid film stock suits a warm, whimsical illustrated look' }
};

function renderCameraBodyAutoSuggest() {
  // Clear all previously auto-selected camera-brand chips first
  document.querySelectorAll('#sf-camera-brand-chips .sf-chip.auto-selected').forEach(btn => {
    btn.classList.remove('active', 'auto-selected');
    delete btn.dataset.autoGroup;
  });
  sfState.selections.camera = (sfState.selections.camera || []).filter(v => {
    // Keep only values that still belong to a manually-active chip
    const chip = document.querySelector(`#sf-camera-brand-chips .sf-chip[data-val="${v}"]`);
    return chip && chip.classList.contains('active') && !chip.classList.contains('auto-selected');
  });

  const suggest = sfState.genre ? CAMERA_BODY_SUGGEST[sfState.genre] : null;
  if (!suggest) return;

  // Don't override a manual pick — only auto-select if nothing is active yet
  const anyManualActive = Array.from(document.querySelectorAll('#sf-camera-brand-chips .sf-chip.active'))
    .some(b => !b.classList.contains('auto-selected'));
  if (anyManualActive) return;

  const chip = document.querySelector(`#sf-camera-brand-chips .sf-chip[data-val="${suggest.cameraVal}"]`);
  if (chip && !chip.classList.contains('active')) {
    document.querySelectorAll('#sf-camera-brand-chips .sf-chip').forEach(b => b.classList.remove('active', 'auto-selected'));
    chip.classList.add('active', 'auto-selected');
    chip.dataset.autoGroup = 'camera';
    sfState.selections.camera = [suggest.cameraVal];
  }
}

/* ── GENRE VOCABULARY ────────────────────────────────────── */
// Source of truth: src/data/vocabulary.json — injected at build time as VOCABULARY_DATA.
// GENRE_VOCAB is derived at runtime; to add/edit genres, edit vocabulary.json and rebuild.
const GENRE_VOCAB = (function () {
  if (typeof VOCABULARY_DATA !== 'undefined' && VOCABULARY_DATA.genres) {
    // Strip the 'label' key — app only needs subject/mood/env/wardrobe arrays
    const out = {};
    Object.entries(VOCABULARY_DATA.genres).forEach(([key, val]) => {
      out[key] = {
        subject:  val.subject  || [],
        mood:     val.mood     || [],
        env:      val.env      || [],
        wardrobe: val.wardrobe || []
      };
    });
    return out;
  }
  // Fallback if vocabulary.json was not injected (dev/offline)
  return {
    'cinematic-portrait': {
      subject: ['elderly man', 'young woman', 'warrior', 'saint', 'sage', 'merchant', 'soldier'],
      mood: ['contemplative', 'weathered wisdom', 'quiet dignity', 'inner fire', 'serene authority'],
      env: ['interior', 'window light', 'street', 'studio neutral'],
      wardrobe: ['period costume', 'natural fabric', 'worn clothing']
    },
    mythology: {
      subject: ['deity', 'divine being', 'saint', 'sage', 'rishi', 'devotee', 'ascetic', 'warrior-saint'],
      mood: ['divine radiance', 'wrathful compassion', 'serene wisdom', 'fierce devotion', 'transcendent calm'],
      env: ['temple courtyard', 'forest ashram', 'riverbank ghat', 'mountain peak', 'cosmic void'],
      wardrobe: ['rudraksha mala', 'kamandalu', 'trishul', 'lotus', 'sacred text', 'diya', 'conch shell']
    },
    fantasy: {
      subject: ['warrior', 'hero', 'demon', 'creature', 'knight', 'assassin', 'mage', 'commander'],
      mood: ['battle fury', 'predatory calm', 'warrior focus', 'primal power', 'unstoppable momentum'],
      env: ['war-torn battlefield', 'apocalyptic landscape', 'dark fortress', 'storm-lit sky'],
      wardrobe: ['battle armour', 'enchanted weapon', 'war paint', 'tattered cloak']
    },
    street: {
      subject: ['vendor', 'commuter', 'child', 'elder', 'worker', 'crowd'],
      mood: ['candid, unposed, raw authenticity', 'fleeting moment', 'observed life'],
      env: ['busy market street', 'public transport', 'urban alley', 'open square'],
      wardrobe: ['everyday clothing', 'work uniform', 'street wear']
    },
    product: {
      subject: ['product', 'object', 'bottle', 'device', 'food item', 'jewellery piece'],
      mood: ['clean and precise', 'commercial quality', 'editorial product'],
      env: ['white studio background', 'concrete surface', 'lifestyle context', 'minimal surface'],
      wardrobe: []
    },
    illustrated: {
      subject: ['child character', 'animal companion', 'magical creature', 'fairy', 'toy'],
      mood: ['whimsical and wonder-filled', 'warm and playful', 'innocent adventure'],
      env: ['enchanted forest', 'cosy interior', 'magical landscape', 'picture book setting'],
      wardrobe: ['colourful clothing', 'fantasy costume', 'cute accessories']
    }
  };
}());

/* ── PLATFORM GRAMMAR ────────────────────────────────────── */
const PLATFORM_TIPS = {
  mj: {
    label: 'Midjourney v7',
    badge: 'Midjourney v7',
    tip: 'Front-load the most important elements. Comma-separated keywords. Parameters go at end after the prompt text.',
    motionSupport: false
  },
  nb: {
    label: 'Nano Banana Pro',
    badge: 'Nano Banana Pro (Gemini)',
    tip: 'Narrative descriptive prose works best. Step-by-step structure is supported. Semantic negatives preferred — describe what you want, not just what to avoid.',
    motionSupport: true
  },
  kling: {
    label: 'Kling Image 3.0',
    badge: 'Kling Image 3.0 (Omni)',
    tip: 'Order: subject/action → setting → lighting → camera angle → depth of field → color/tone → film quality. Reference images are cited by plain ordinal in the prompt text — e.g. "the shirt from Image 3" — not a hashtag/@ tag. No motion support; for video use Kling Video 3.0 in the Storyboard tool.',
    motionSupport: false
  },
  gpt: {
    label: 'GPT Image-2',
    badge: 'GPT Image-2',
    tip: 'Labeled segments with explicit constraints. Start with scene/background, then subject, then details. End with explicit "No watermark, no extra text" negatives on every prompt.',
    motionSupport: true
  }
};

/* ── RICHNESS LABELS ─────────────────────────────────────── */
const RICHNESS_LABELS = ['Minimal', 'Basic', 'Good', 'Strong', 'Cinema Grade'];

/* ── RENDER GENRE CHIPS (dynamic — reads vocab manager + built-in) ── */
function renderSFGenreChips() {
  const container = document.getElementById('sf-genre-chips');
  if (!container) return;

  const builtinGenres = (typeof VOCABULARY_DATA !== 'undefined' && VOCABULARY_DATA.genres)
    ? VOCABULARY_DATA.genres : {};

  // Read any genres added via the Vocabulary Manager (stored in localStorage)
  let vmGenres = {};
  try {
    const raw = localStorage.getItem('S3_v7_vocab_manager');
    if (raw) {
      const parsed = JSON.parse(raw);
      if (parsed && parsed.genres) vmGenres = parsed.genres;
    }
  } catch (e) {}

  // Union — vocab manager labels/data take precedence over built-in
  const allKeys = Array.from(new Set([...Object.keys(builtinGenres), ...Object.keys(vmGenres)]));

  container.innerHTML = allKeys.map(key => {
    const data = vmGenres[key] || builtinGenres[key] || {};
    const label = data.label || key.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
    const isActive = sfState.genre === key;
    return `<button class="sf-chip${isActive ? ' active' : ''}" data-val="${escHtml(key)}" onclick="toggleSFChip(this,'genre')">${escHtml(label)}</button>`;
  }).join('');
}

/* ── LIGHTING (setup + natural, combined) ────────────────── */
function getLightingCombined() {
  return [
    ...(sfState.selections['lighting-setup'] || []),
    ...(sfState.selections['lighting-natural'] || []),
  ];
}

/* ── DUTCH ANGLE CHIP TOGGLE ─────────────────────────────── */
function toggleDutchAngle(btn) {
  sfState.dutch = !sfState.dutch;
  btn.classList.toggle('active', sfState.dutch);
  updatePrompt();
}

/* ── INIT SINGLE FRAME VIEW ──────────────────────────────── */
function initSingleFrame() {
  renderSFGenreChips();
  renderSFAssetSelector();
  renderSFRoleOrderHint();
  renderSFOSSideControl();
  renderSFReferenceStrip();
  syncSFPlatformUI();
  updatePrompt();
  renderPlatformTips();
  initStaticChipAdders();
  initOnboarding();
  // Warm up shared-library caches (props/locations/eras/styles) so the
  // @-mention picker and asset selector see linked assets immediately —
  // without this, those types are missing from pickers until the user
  // happens to visit the Library tab first (see ensureLibraryCachesLoaded
  // in 01-core.js). Re-render once loaded in case the first paint above
  // ran before the cache was ready.
  if (typeof ensureLibraryCachesLoaded === 'function') {
    ensureLibraryCachesLoaded().then(() => {
      renderSFAssetSelector();
    });
  }
  // Load persisted custom chips for all static groups
  [
    { id: 'sf-lighting-chips',         group: 'lighting-setup' },
    { id: 'sf-lighting-natural-chips', group: 'lighting-natural' },
    { id: 'sf-lens-chips',             group: 'lens' },
    { id: 'sf-aperture-chips',         group: 'aperture' },
    { id: 'sf-camera-brand-chips',     group: 'camera' },
    { id: 'sf-mood-chips',             group: 'mood' },
    { id: 'sf-quality-chips',          group: 'quality' },
    { id: 'sf-power-chips',            group: 'quality' },
    { id: 'sf-angle-chips',            group: 'angle' },
  ].forEach(({ id, group }) => renderPersistedCustomChips(id, group));
}

function initStaticChipAdders() {
  // Add ＋ button to all static chip sections that don't already have one
  const staticSections = [
    { id: 'sf-lighting-chips',         group: 'lighting-setup' },
    { id: 'sf-lighting-natural-chips', group: 'lighting-natural' },
    { id: 'sf-lens-chips',             group: 'lens' },
    { id: 'sf-aperture-chips',         group: 'aperture' },
    { id: 'sf-camera-brand-chips',     group: 'camera' },
    { id: 'sf-mood-chips',             group: 'mood' },
    { id: 'sf-quality-chips',          group: 'quality' },
    { id: 'sf-power-chips',            group: 'quality' },
    { id: 'sf-angle-chips',            group: 'angle' },
  ];
  staticSections.forEach(({ id, group }) => {
    const container = document.getElementById(id);
    if (!container || container.querySelector('.sf-chip-add')) return;
    const btn = document.createElement('button');
    btn.className = 'sf-chip sf-chip-add';
    btn.title = 'Add custom keyword';
    btn.textContent = '＋';
    btn.onclick = () => addStaticCustomChip(id, group);
    container.appendChild(btn);
  });
}

/* ── RENDER ASSET SELECTOR ────────────────────────────────── */
function renderSFAssetSelector() {
  const p = getCurrentProject();
  const container = document.getElementById('sf-asset-selector');
  if (!container) return;

  // Effective assets = project-owned characters + this project's linked
  // subset of the shared library (location/prop/era/style). See
  // getEffectiveAssets() in 01-core.js.
  const effectiveAssets = p ? getEffectiveAssets() : {};

  if (!p || Object.keys(effectiveAssets).length === 0) {
    container.innerHTML = '<span class="sf-asset-empty">No library assets yet — add characters, locations, props in the Library tab.</span>';
    return;
  }

  const TYPE_ORDER = ['character', 'location', 'prop', 'era', 'style'];
  const TYPE_LABELS_SF = { character: 'Characters', location: 'Locations', prop: 'Props', era: 'Era / Period', style: 'Style' };
  const assets = Object.values(effectiveAssets);

  // Mentioned-but-not-chip-clicked assets — bug found via testing
  // 2026-06-29: @mentioning an asset in Subject/Env text correctly pulls its
  // description into the prompt (see collectSFData()'s allMentions handling),
  // but the chip up here never reflected that — sfState.selectedAssets is
  // only ever written by toggleSFAsset() (a direct chip click), so a purely
  // @mentioned asset looked unselected even though it was actively
  // contributing to the generated prompt. Fix: also resolve @mentions from
  // both free-text fields here, the same way collectSFData() does, and mark
  // those chips visually — as a distinct "mentioned" state, not full
  // "active", since they were never actually clicked into
  // sfState.selectedAssets (that set still drives multi-figure role-order
  // logic and must only contain real clicks).
  const mentionedIds = new Set();
  if (p) {
    const subjectMentions = (typeof parseAtMentions === 'function') ? parseAtMentions(sfState.freeText.subject || '') : [];
    const envMentions = (typeof parseAtMentions === 'function') ? parseAtMentions(sfState.freeText.env || '') : [];
    [...subjectMentions, ...envMentions].forEach(m => { if (m.asset) mentionedIds.add(m.asset.id); });
  }

  // Group by type
  const groups = {};
  TYPE_ORDER.forEach(t => { groups[t] = []; });
  assets.forEach(a => {
    if (groups[a.type]) groups[a.type].push(a);
    else groups[a.type] = [a];
  });

  let html = '';
  TYPE_ORDER.forEach(type => {
    const group = groups[type];
    if (!group || !group.length) return;
    const icon = TYPE_ICONS[type] || '';
    const label = TYPE_LABELS_SF[type] || type;
    html += `<div class="sf-asset-group">`;
    html += `<div class="sf-asset-group-label">${icon} ${label}</div>`;
    html += `<div class="sf-asset-group-chips">`;
    group.forEach(a => {
      const active = sfState.selectedAssets[a.id] ? ' active' : '';
      const mentioned = (!sfState.selectedAssets[a.id] && mentionedIds.has(a.id)) ? ' mentioned' : '';
      const title = mentioned ? ' title="In use via @mention"' : '';
      html += `<button class="sf-asset-chip${active}${mentioned} type-${a.type}" data-id="${a.id}" onclick="toggleSFAsset('${a.id}')"${title}>${escHtml(a.name)}</button>`;
    });
    html += `</div></div>`;
  });

  // Shared-library types are project-scoped via linking, not project-owned —
  // make it easy to go add/link more without leaving a heavier modal here.
  html += `<button class="btn btn-ghost btn-sm sf-browse-library-link" onclick="switchView('library')" style="margin-top:4px;">Browse full library →</button>`;

  container.innerHTML = html;
}

function toggleSFAsset(id) {
  if (sfState.selectedAssets[id]) {
    delete sfState.selectedAssets[id];
    sfState.selectedAssetOrder = sfState.selectedAssetOrder.filter(x => x !== id);
  } else {
    sfState.selectedAssets[id] = true;
    sfState.selectedAssetOrder.push(id);
    // Fetch-on-reference (2026-07-10) — this chip click is a live reference
    // to a shared-library asset, which may not have its full image loaded
    // yet under the narrowed load-time prefetch (see
    // ensureLinkedLibraryImagesLoaded()'s comment, 01-core.js). Fire-and-
    // forget, same pattern as toggleProjectAssetLink()'s existing "newly
    // linked" fetch. No-op for character (not a shared-library type).
    const effectiveAssets = typeof getEffectiveAssets === 'function' ? getEffectiveAssets() : {};
    const asset = effectiveAssets[id];
    if (asset && typeof fetchAssetImageOnReference === 'function') fetchAssetImageOnReference(asset.type, id);
  }
  renderSFAssetSelector();
  renderSFRoleOrderHint();
  renderSFOSSideControl();
  renderSFReferenceStrip();
  updatePrompt();
}

/* ── MULTI-FIGURE FRAME SUPPORT ──────────────────────────────
   Frames that require 2+ named characters with distinct roles
   (foreground/anchor vs. sharp subject), rather than a single
   subject the way face/head/waist/fullbody/wide do. Role is set
   by click order on the asset chips — see selectedAssetOrder
   above — per the user's explicit choice over an explicit
   per-character dropdown. ───────────────────────────────────── */
const MULTI_FIGURE_FRAMES = {
  os:        { minChars: 2, label: 'Over-the-Shoulder', roles: ['Foreground/anchor (soft focus)', 'Sharp subject (faces camera/anchor)'] },
  twoshot:   { minChars: 2, label: 'Two Shot',           roles: ['Dominant/sharp figure', 'Soft anchor figure'] },
  threeshot: { minChars: 3, label: 'Three Shot',         roles: ['Centre figure', 'Frame-left/right figure', 'Frame-left/right figure'] }
  // Three Shot's flanking roles are intentionally generic here — actual
  // frame-left/frame-right assignment is decided by sfState.threeshotSides
  // and shown precisely in the #sf-os-side-control toggle (see
  // renderSFOSSideControl), not in this static hint.
};

function getOrderedSelectedCharacters() {
  const p = getCurrentProject();
  if (!p) return [];
  const effectiveAssets = getEffectiveAssets();
  return sfState.selectedAssetOrder
    .map(id => effectiveAssets[id])
    .filter(a => a && a.type === 'character');
}

function renderSFRoleOrderHint() {
  const el = document.getElementById('sf-role-order-hint');
  if (!el) return;
  const spec = MULTI_FIGURE_FRAMES[sfState.frame];
  if (!spec) { el.style.display = 'none'; return; }

  const chars = getOrderedSelectedCharacters();
  el.style.display = '';
  if (chars.length < spec.minChars) {
    el.innerHTML = `<span class="sf-role-order-warn">${spec.label} needs ${spec.minChars} characters selected</span> — currently ${chars.length}. Click character chips above in the order you want their role assigned (see below).`;
    return;
  }
  const roleLines = chars.slice(0, spec.roles.length).map((c, i) =>
    `<b>${escHtml(c.name)}</b> — ${spec.roles[i] || 'extra figure'}`
  ).join(' · ');
  el.innerHTML = `Role by click order: ${roleLines}. Click chips in a different order to reassign.`;
}

// Multi-figure frame-side control — explicit, since OS/Two Shot/Three Shot
// previously had no (or incomplete) way to say which side of the frame each
// figure sits on, and the model would place figures arbitrarily, or — for OS
// specifically — also render the camera-facing figure full-size instead of
// properly cropped/distant. Found via testing 2026-06-29. Frame-left/
// frame-right per the house-wide convention (anchored to how the user sees
// their own flat reference image, not camera-rig or subject-relative left/
// right — see 2026-06-28-location-designer-spec.md). One render function
// covers all three frame types since the control shape (a single toggle
// flipping which side is which) is identical; only the label text and the
// state field written differ.
function renderSFOSSideControl() {
  const el = document.getElementById('sf-os-side-control');
  if (!el) return;
  const chars = getOrderedSelectedCharacters();

  if (sfState.frame === 'os') {
    if (chars.length < 2) { el.style.display = 'none'; return; }
    const sharpName = escHtml(chars[1].name);
    const side = sfState.osSharpSubjectSide;
    el.style.display = '';
    el.innerHTML = `
      <span class="sf-os-side-label">${sharpName} (sharp subject, faces camera) is on:</span>
      <button class="sf-toggle sf-os-side-btn${side === 'frame-left' ? ' active' : ''}" data-val="frame-left" onclick="setSFOSSide(this)">Frame-left</button>
      <button class="sf-toggle sf-os-side-btn${side === 'frame-right' ? ' active' : ''}" data-val="frame-right" onclick="setSFOSSide(this)">Frame-right</button>
    `;
    return;
  }

  if (sfState.frame === 'twoshot') {
    if (chars.length < 2) { el.style.display = 'none'; return; }
    const anchorName = escHtml(chars[1].name);
    const side = sfState.twoshotAnchorSide;
    el.style.display = '';
    el.innerHTML = `
      <span class="sf-os-side-label">${anchorName} (soft anchor) is on:</span>
      <button class="sf-toggle sf-os-side-btn${side === 'frame-left' ? ' active' : ''}" data-val="frame-left" onclick="setSFTwoShotSide(this)">Frame-left</button>
      <button class="sf-toggle sf-os-side-btn${side === 'frame-right' ? ' active' : ''}" data-val="frame-right" onclick="setSFTwoShotSide(this)">Frame-right</button>
    `;
    return;
  }

  if (sfState.frame === 'threeshot') {
    if (chars.length < 3) { el.style.display = 'none'; return; }
    const secondName = escHtml(chars[1].name);
    const thirdName = escHtml(chars[2].name);
    const mode = sfState.threeshotSides;
    el.style.display = '';
    el.innerHTML = `
      <span class="sf-os-side-label">${secondName} / ${thirdName} flank the centre figure — which side?</span>
      <button class="sf-toggle sf-os-side-btn${mode === 'second-left' ? ' active' : ''}" data-val="second-left" onclick="setSFThreeShotSides(this)">${secondName}: frame-left</button>
      <button class="sf-toggle sf-os-side-btn${mode === 'second-right' ? ' active' : ''}" data-val="second-right" onclick="setSFThreeShotSides(this)">${secondName}: frame-right</button>
    `;
    return;
  }

  el.style.display = 'none';
}

function setSFOSSide(btn) {
  sfState.osSharpSubjectSide = btn.dataset.val;
  document.querySelectorAll('.sf-os-side-btn').forEach(b => b.classList.toggle('active', b === btn));
  updatePrompt();
}

function setSFTwoShotSide(btn) {
  sfState.twoshotAnchorSide = btn.dataset.val;
  document.querySelectorAll('.sf-os-side-btn').forEach(b => b.classList.toggle('active', b === btn));
  updatePrompt();
}

function setSFThreeShotSides(btn) {
  sfState.threeshotSides = btn.dataset.val;
  document.querySelectorAll('.sf-os-side-btn').forEach(b => b.classList.toggle('active', b === btn));
  updatePrompt();
}

/* ── REFERENCE IMAGE STRIP ───────────────────────────────────
   Gap found via testing 2026-06-29: Storyboard mode shows a per-panel
   strip of which actual reference image (Close-up/Mid Shot/Full Body/
   Character Sheet, etc.) getImageForShot() resolves for each
   selected/@mentioned asset at that shot's framing, plus any extra
   images available for multi-image platforms — see
   inlineReferenceStripInnerHTML() in 11-reference-panel.js. Single Frame
   never had an equivalent, so a multi-image character asset gave zero
   visibility into which photo was actually being used, or that other
   photos existed to grab as additional references.
   This reuses the exact same resolver functions Storyboard already has
   (getImageForShot/getImagesForShot in 01-core.js, resolveSlotUsed/
   SLOT_LABELS in 11-reference-panel.js) — no new resolution logic, just
   a Single-Frame-shaped collection of which assets are "in play" (chip-
   selected + @mentioned in Subject/Env text) and sfState.frame standing
   in for Storyboard's panel.shotType. Continuity-anchor and perspective-
   anchor concepts are intentionally NOT ported — both are inherently
   about matching one panel to another panel, which doesn't exist in
   Single Frame's one-shot model. */
function renderSFReferenceStrip() {
  const el = document.getElementById('sf-ref-strip');
  if (!el) return;
  const p = getCurrentProject();
  if (!p) { el.style.display = 'none'; return; }

  const effectiveAssets = getEffectiveAssets();
  const chipAssets = Object.keys(sfState.selectedAssets).map(id => effectiveAssets[id]).filter(Boolean);

  const subjectMentions = (typeof parseAtMentions === 'function') ? parseAtMentions(sfState.freeText.subject || '') : [];
  const envMentions = (typeof parseAtMentions === 'function') ? parseAtMentions(sfState.freeText.env || '') : [];

  const seen = new Set();
  const assets = [];
  [...chipAssets, ...subjectMentions.map(m => m.asset), ...envMentions.map(m => m.asset)].forEach(a => {
    if (a && !seen.has(a.id)) { seen.add(a.id); assets.push(a); }
  });

  if (assets.length === 0) { el.style.display = 'none'; return; }

  const shotType = sfState.frame || '';
  // Combined free text used to detect keyword-tagged features for the
  // context-aware location resolver below (e.g. "water tank") — see
  // resolveLocationImageForContext(), 01-core.js.
  const contextText = [sfState.freeText.subject, sfState.freeText.env].filter(Boolean).join(' ');
  const rows = assets.map(asset => {
    let img, slotUsed, matchedFeature = null;
    if (asset.type === 'location' && typeof resolveLocationImageForContext === 'function') {
      const resolved = resolveLocationImageForContext(asset, shotType, contextText);
      img = resolved.img; slotUsed = resolved.slotUsed; matchedFeature = resolved.matchedFeature;
    } else {
      img = (typeof getImageForShot === 'function') ? getImageForShot(asset, shotType) : null;
      slotUsed = (typeof resolveSlotUsed === 'function') ? resolveSlotUsed(asset, shotType) : null;
    }
    const allImgs = (typeof getImagesForShot === 'function') ? getImagesForShot(asset, shotType) : [];
    const extraImgs = allImgs.filter(i => i !== img);
    return { asset, img: img || null, slotUsed, isFallback: !!(img && slotUsed && slotUsed.isFallback), matchedFeature, extraImgs };
  }).filter(r => r.img); // strip only shows rows with an actual image, same as Storyboard's version

  if (rows.length === 0) { el.style.display = 'none'; return; }

  const labels = (typeof SLOT_LABELS !== 'undefined') ? SLOT_LABELS : {};
  // Fable audit H4 (2026-07-08): same embedded-base64-in-innerHTML freeze
  // pattern as the Storyboard inline strip (11-reference-panel.js) and
  // three other spots — href/src are deferred to data-src-pending markers +
  // queueImageHydration(), then flushImageHydration() (01-core.js) hydrates
  // them right after el.innerHTML is set below, once the elements actually
  // exist in the DOM.
  const itemsHtml = rows.map((r, ii) => {
    const note = r.matchedFeature
      ? `<span style="color:var(--blue, #2563eb)" title="Switched from the default frame-based image because '${escHtml(r.matchedFeature.name)}' is mentioned in your text and is only clearly visible in this image">📍 ${escHtml(labels[r.slotUsed.key] || r.slotUsed.key)} — "${escHtml(r.matchedFeature.name)}" detected</span>`
      : r.isFallback
      ? `<span style="color:var(--amber)">${escHtml(labels[r.slotUsed.key] || r.slotUsed.key)} (fallback)</span>`
      : (r.slotUsed ? `<span style="opacity:.65">${escHtml(labels[r.slotUsed.key] || r.slotUsed.key)}</span>` : '');
    const dlName = `${r.asset.name}-${r.slotUsed?.key || 'ref'}`.replace(/[^a-z0-9_-]+/gi, '_') + '.jpg';
    const primaryLinkId = 'sf-ref-link-' + ii;
    const primaryImgId = 'sf-ref-thumb-' + ii;
    queueImageHydration(primaryLinkId, r.img, 'href');
    queueImageHydration(primaryImgId, r.img, 'src');
    const extraThumbs = (r.extraImgs && r.extraImgs.length)
      ? r.extraImgs.map((eimg, ei) => {
          const linkId = 'sf-ref-extralink-' + ii + '-' + ei;
          const imgId = 'sf-ref-extra-' + ii + '-' + ei;
          queueImageHydration(linkId, eimg, 'href');
          queueImageHydration(imgId, eimg, 'src');
          return `<a id="${linkId}" download="${escHtml(r.asset.name)}-extra${ei}.jpg" title="Additional reference image for ${escHtml(r.asset.name)} — attach alongside the main one" style="display:block"><img id="${imgId}" data-src-pending="1" style="width:24px;height:24px;object-fit:cover;border-radius:3px;border:1px solid var(--border)"></a>`;
        }).join('')
      : '';
    const extraThumbsWrap = extraThumbs
      ? `<div style="display:flex;gap:2px;margin-top:2px" title="${r.extraImgs.length} more reference image(s) available">${extraThumbs}</div>`
      : '';
    return `
      <div style="display:flex;flex-direction:column;align-items:center;gap:2px">
        <a id="${primaryLinkId}" download="${escHtml(dlName)}" title="Download reference image" style="display:block">
          <img id="${primaryImgId}" data-src-pending="1" style="width:56px;height:56px;object-fit:cover;border-radius:4px;border:1px solid var(--border)">
        </a>
        ${extraThumbsWrap}
        <div style="font-size:.62rem;text-align:center;max-width:72px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${escHtml(r.asset.name)}">${escHtml(r.asset.name)}</div>
        <div style="font-size:.6rem">${note}</div>
      </div>`;
  }).join('');

  const hint = (typeof stagedGenerationHintHTML === 'function') ? stagedGenerationHintHTML(rows.length) : '';
  el.style.display = '';
  el.innerHTML = `${hint}<div style="display:flex;gap:10px;flex-wrap:wrap;padding:8px 0;border-top:1px solid var(--border-subtle, var(--border))">${itemsHtml}</div>`;
  flushImageHydration();
}

/* ── CAMERA FACES (Shot Setup Single Frame port, phase 1 — 2026-07-10) ──
   Direction dropdown only, ported from Storyboard's cameraFacingWrapHTML()/
   cameraFacingInnerHTML() (06-scene-engine.js). Deliberately scoped to just
   the dropdown + direction text — the full Shot Setup ring/diagram button
   is a separate, larger follow-up pass (needs a new non-panel-index link
   type on shots, since Single Frame has no panel array to link against).
   No wrapDirectionClause()/applyCharBudgetTrim() marker system here either —
   that's a Storyboard-only char-budget mechanism Single Frame's 4 platform
   builders don't have; using it here without also stripping the markers
   downstream would leak literal "DIRSTART"/"DIREND" text into prompts. */

// Resolves which location "in play" for Single Frame has its own
// directions[] — "in play" = chip-selected via the Library Assets selector,
// OR @-mentioned in Subject/Environment free text, same scope
// renderSFReferenceStrip() already uses. v1 scope: only the FIRST such
// location gets a dropdown, matching Storyboard's own "only the FIRST
// mentioned location" comment — a frame naming two directional locations at
// once is an edge case neither mode addresses.
function sfLocationInPlay() {
  const p = typeof getCurrentProject === 'function' ? getCurrentProject() : null;
  if (!p) return null;
  const effectiveAssets = typeof getEffectiveAssets === 'function' ? getEffectiveAssets() : {};
  const chipAssets = Object.keys(sfState.selectedAssets).map(id => effectiveAssets[id]).filter(Boolean);
  const subjectMentions = typeof parseAtMentions === 'function' ? parseAtMentions(sfState.freeText.subject || '') : [];
  const envMentions = typeof parseAtMentions === 'function' ? parseAtMentions(sfState.freeText.env || '') : [];
  const all = [...chipAssets, ...subjectMentions.map(m => m.asset), ...envMentions.map(m => m.asset)];
  return all.find(a => a && a.type === 'location' && Array.isArray(a.directions) && a.directions.length > 0) || null;
}

function sfCameraFacingInnerHTML() {
  const asset = sfLocationInPlay();
  if (!asset) return '';
  const current = sfState.cameraFacingDirection || '';
  const options = asset.directions.map(d =>
    `<option value="${escHtml(d.name)}" ${current === d.name ? 'selected' : ''}>${escHtml(d.name)}</option>`
  ).join('');

  // Shot Setup entry point — Single Frame port phase 2 (2026-07-10), same
  // placement/style as Storyboard's own button (06-scene-engine.js's
  // cameraFacingInnerHTML()). Opens/reuses a shot setup for this same
  // location; picking or adding a shot drives THIS dropdown's selection
  // instead of the user picking it blind (spec's "Output per panel" item 1,
  // applied here to Single Frame's one-shot-at-a-time state instead of a
  // Storyboard panel).
  const shotSetupBtn = typeof openShotSetupForSingleFrame === 'function'
    ? `<button type="button" class="btn btn-secondary btn-sm" style="margin-top:6px;"
        onclick="openShotSetupForSingleFrame('${escHtml(asset.id)}')"
        title="Open the visual ring/camera diagram for this location">📐 Shot Setup</button>`
    : '';

  return `
    <div class="sb-camera-facing">
      <div class="sb-panel-section-label">Camera faces (${escHtml(asset.name)})</div>
      <select class="input" onchange="setSFCameraFacingDirection(this.value)">
        <option value="">— not set —</option>
        ${options}
      </select>
      <span class="field-hint">Text-guidance only — restates what's in this direction for cross-panel consistency, doesn't give the generator real memory of the location.</span>
      ${shotSetupBtn}
    </div>`;
}

// Called from updatePrompt() so it always stays in sync with whatever
// caused the prompt to rebuild (chip toggle, @mention edit, frame change) —
// same reasoning as refreshCameraFacingDropdown()'s Storyboard equivalent,
// just centralized here instead of called from each individual handler.
function refreshSFCameraFacingDropdown() {
  const el = document.getElementById('sf-camera-facing-wrap');
  if (el) el.innerHTML = sfCameraFacingInnerHTML();
}

function setSFCameraFacingDirection(value) {
  sfState.cameraFacingDirection = value || null;
  updatePrompt(); // also refreshes this dropdown via refreshSFCameraFacingDropdown()
}

/* ── OUTPUT TYPE ─────────────────────────────────────────── */
function setSFOutputType(type) {
  sfState.outputType = type;
  document.querySelectorAll('#sf-output-type .sf-toggle').forEach(b => {
    b.classList.toggle('active', b.dataset.val === type);
  });
  // Show/hide motion layer
  const motionLayer = document.getElementById('sf-motion-layer');
  if (motionLayer) motionLayer.style.display = type === 'motion' ? '' : 'none';
  // Check platform compatibility
  checkPlatformMotionCompat();
  updatePrompt();
}

function checkPlatformMotionCompat() {
  const warn = document.getElementById('sf-platform-warning');
  if (!warn) return;
  if (sfState.outputType === 'motion' && sfState.platform === 'mj') {
    warn.style.display = '';
    warn.textContent = '⚠ Midjourney does not support Motion Posters. Switch to Nano Banana Pro or GPT Image-2 for motion output.';
  } else if (sfState.outputType === 'motion' && sfState.platform === 'kling') {
    warn.style.display = '';
    warn.textContent = '⚠ Kling Image 3.0 is a still-image model. For motion, use Kling Video 3.0 in the Storyboard tool, or switch to Nano Banana Pro / GPT Image-2 here.';
  } else {
    warn.style.display = 'none';
  }
}

/* ── GENRE ───────────────────────────────────────────────── */
function toggleSFChip(btn, group, singleSelect = false) {
  // Redundancy-guarded chips (currently: the "Over-the-Shoulder" angle chip
  // while frame=os is active — see renderAngleRedundancyGuard()) are inert.
  if (btn.disabled) return;

  const val = btn.dataset.val;

  // If user manually clicks an auto-selected chip, convert it to manual selection
  btn.classList.remove('auto-selected');
  delete btn.dataset.autoGroup;

  if (singleSelect) {
    // Deselect all in group, then select this (toggle if already active)
    const wasActive = btn.classList.contains('active');
    btn.closest('.sf-chips, .sf-toggles-grid').querySelectorAll('.sf-chip').forEach(b => { if (b.id !== 'sf-dutch-angle-chip') b.classList.remove('active'); });
    sfState.selections[group] = [];
    if (!wasActive) {
      btn.classList.add('active');
      sfState.selections[group] = [val];
    }
  } else {
    btn.classList.toggle('active');
    if (btn.classList.contains('active')) {
      if (!sfState.selections[group]) sfState.selections[group] = [];
      sfState.selections[group].push(val);
    } else {
      sfState.selections[group] = (sfState.selections[group] || []).filter(v => v !== val);
    }
    // Genre is single-select via the genre logic
    if (group === 'genre') {
      const wasActive = !btn.classList.contains('active'); // already toggled above
      btn.closest('.sf-chips').querySelectorAll('.sf-chip').forEach(b => {
        if (b !== btn) { b.classList.remove('active'); }
      });
      if (btn.classList.contains('active')) {
        sfState.genre = val;
        loadGenreVocab(val);
      } else {
        sfState.genre = null;
      }
      renderCameraBodyAutoSuggest();
    }
  }
  updatePrompt();
}

function loadGenreVocab(genre) {
  const vocab = getVocab(genre, sfState.frame);
  renderVocabChips('sf-subject-chips', vocab.subject, 'subject-genre');
  renderVocabChips('sf-env-chips', vocab.env, 'env-genre');
  if (vocab.wardrobe && vocab.wardrobe.length)
    renderVocabChips('sf-wardrobe-chips', vocab.wardrobe, 'wardrobe-genre');
  if (vocab.mood && vocab.mood.length)
    renderVocabChips('sf-mood-extra-chips', vocab.mood, 'mood-genre');
}

/* ─────────────────────────────────────────────────────────────
   SEGMENT 3 — VOCABULARY SYSTEM
   ───────────────────────────────────────────────────────────── */

/* ── VOCABULARY STORAGE ──────────────────────────────────── */
// Structure: vocabStore[group][builtinVal] = customVal
// null customVal means deleted; string means edited text
//
// Fable audit fix (2026-07-08 report, live-confirmed + applied 2026-07-10,
// M1 + H3): this used to live at state.vocabEdits[projectId] — root-level
// state that _saveStateNow()'s server upload never actually included (it
// only ever sends save_project/save_asset per project, never root fields).
// The ONLY thing that "persisted" it was the full-state localStorage
// mirror, and a live check on 2026-07-10 confirmed that mirror silently
// fails every time on this account (S3_v7 key doesn't exist in
// localStorage at all; a quota probe throws on a write far smaller than a
// typical saved state). Net effect: every vocab chip edit ever made had
// ZERO real persistence — gone on reload, regardless of the "Renamed to…"-
// style success toast implying otherwise.
//
// Fixed by moving storage onto the project object itself (p.vocabEdits)
// so it rides the same already-working save_project/load_projects round
// trip every other project field uses — no new server endpoint needed,
// api.php's save_project/load_projects already write/read whatever fields
// a project object carries. Saved via saveProjectMetaOnly() (00-api.js),
// the same targeted-save helper used for addProject/renameProject,
// closing the H3 finding for this call site too.
//
// Edits made with no active project (pid === null) have nowhere
// persistable to live — they fall back to an in-memory-only bucket, which
// is the same real-world behavior as before (silently lost on reload) but
// now honest about it rather than showing a false "saved" success path.
function getVocabStore() {
  const p = getCurrentProject();
  if (p) {
    if (!p.vocabEdits) p.vocabEdits = {};
    return p.vocabEdits;
  }
  if (!state.vocabEdits) state.vocabEdits = {};
  if (!state.vocabEdits._global) state.vocabEdits._global = {};
  return state.vocabEdits._global;
}

// Task #8 hardening (2026-06-25): this used to mutate local state and fire
// saveState() without awaiting it, while every caller showed a success
// toast immediately regardless of whether the save actually landed on the
// server — same "looks saved, isn't" bug class fixed elsewhere for
// addProject/renameProject/deleteProject/saveAsset/deleteAsset. Now this
// awaits the save and only confirms success once it's actually confirmed.
async function saveVocabEdit(group, originalVal, newVal) {
  const store = getVocabStore();
  if (!store[group]) store[group] = {};
  store[group][originalVal] = newVal; // null = deleted, string = edited/custom
  const p = getCurrentProject();
  if (p) {
    await saveProjectMetaOnly(p);
  }
  // No active project: nothing persistable to save to (see getVocabStore()
  // above) — edit stays in memory for this session only.
}

function getResolvedChipVal(group, originalVal) {
  const store = getVocabStore();
  if (store[group] && store[group][originalVal] !== undefined)
    return store[group][originalVal];
  return originalVal;
}

function isChipDeleted(group, originalVal) {
  return getResolvedChipVal(group, originalVal) === null;
}

/* ── COMBINATION CLUSTER LOGIC ───────────────────────────── */
// Returns vocab object for genre+frame combination
function getVocab(genre, frame) {
  const base = GENRE_VOCAB[genre] || { subject:[], mood:[], env:[], wardrobe:[] };

  // Combination overrides
  const combo = COMBO_VOCAB[genre + '+' + frame] || {};

  return {
    subject:  [...(combo.subject  || base.subject  || [])],
    mood:     [...(combo.mood     || base.mood      || [])],
    env:      [...(combo.env      || base.env       || [])],
    wardrobe: [...(combo.wardrobe || base.wardrobe  || [])]
  };
}

/* ── COMBINATION VOCABULARY CLUSTERS ────────────────────── */
const COMBO_VOCAB = {
  // Mythology + face → deity close-up specific
  'mythology+face': {
    subject: ['deity face', 'divine being', 'saint', 'rishi', 'ascetic'],
    mood: ['divine radiance', 'wrathful compassion', 'transcendent calm', 'sacred awe', 'meditative absorption'],
    env: [],
    wardrobe: ['rudraksha mala', 'tilak on forehead', 'sacred ash', 'matted hair jata']
  },
  // Mythology + wide → crowd/gathering specific
  'mythology+wide': {
    subject: ['saint addressing crowd', 'devotees gathered', 'kirtan procession', 'pilgrimage scene'],
    mood: ['collective devotion', 'spiritual pride', 'sacred awe', 'divine intoxication'],
    env: ['temple courtyard', 'riverbank ghat', 'forest ashram', 'village open ground'],
    wardrobe: ['saffron flags', 'cymbals and mridang', 'ritual baskets', 'conch shell']
  },
  // Mythology + fullbody → warrior-saint standing
  'mythology+fullbody': {
    subject: ['warrior-saint standing', 'deity in mudra pose', 'sage at ritual fire', 'devotee in prayer'],
    mood: ['serene authority', 'fierce devotion', 'inner fire', 'quiet dignity'],
    env: ['temple courtyard', 'forest clearing', 'mountain peak', 'riverbank at dawn'],
    wardrobe: ['trishul', 'kamandalu', 'rudraksha mala', 'saffron dhoti', 'lotus in hand']
  },
  // Fantasy + face → intense warrior close-up
  'fantasy+face': {
    subject: ['warrior', 'battle-scarred commander', 'demon', 'mage'],
    mood: ['predatory calm', 'battle fury', 'ferocious divine anger', 'haunted resilience'],
    env: [],
    wardrobe: ['war paint', 'battle scarring', 'glowing eyes', 'helm visor raised']
  },
  // Fantasy + wide → battlefield scene
  'fantasy+wide': {
    subject: ['army clash', 'siege of fortress', 'dragon over battlefield', 'lone warrior on plain'],
    mood: ['unstoppable momentum', 'apocalyptic dread', 'primal power', 'battle fury'],
    env: ['war-torn battlefield', 'burning fortress', 'storm-lit sky', 'crater-scarred plain'],
    wardrobe: ['shockwave debris', 'battle standards', 'fallen armour', 'smoke and fire']
  },
  // Fantasy + fullbody → hero pose
  'fantasy+fullbody': {
    subject: ['hero standing', 'warrior mid-battle', 'mage casting spell', 'knight in armour'],
    mood: ['warrior focus', 'primal power', 'predatory calm', 'unstoppable momentum'],
    env: ['dark fortress gate', 'storm-lit ridge', 'ancient ruins', 'burning battlefield'],
    wardrobe: ['battle armour', 'enchanted weapon raised', 'war cloak', 'glowing runes']
  },
  // Street + face → candid portrait
  'street+face': {
    subject: ['elder', 'vendor', 'child', 'worker', 'labourer'],
    mood: ['weathered wisdom', 'quiet dignity', 'candid unposed', 'fleeting moment'],
    env: [],
    wardrobe: ['worn everyday clothing', 'headscarf', 'work uniform']
  },
  // Street + wide → urban scene
  'street+wide': {
    subject: ['busy market', 'morning commute', 'street protest', 'festival crowd'],
    mood: ['raw authentic', 'observed life', 'chaotic energy', 'fleeting moment'],
    env: ['busy market street', 'urban intersection', 'public square', 'transport hub'],
    wardrobe: ['mixed crowd clothing', 'street vendors', 'umbrellas', 'bicycles']
  },
  // Cinematic-portrait + face → editorial close-up
  'cinematic-portrait+face': {
    subject: ['elderly man', 'young woman', 'warrior', 'saint', 'sage'],
    mood: ['contemplative', 'weathered wisdom', 'quiet dignity', 'inner fire', 'serene authority'],
    env: [],
    wardrobe: ['natural fabric collar', 'aged jewellery', 'headgear detail']
  },
  // Cinematic-portrait + head → classic portrait
  'cinematic-portrait+head': {
    subject: ['subject at three-quarter angle', 'looking into middle distance', 'eyes to camera'],
    mood: ['contemplative', 'serene authority', 'quiet dignity', 'earned confidence'],
    env: ['neutral background', 'window light setting', 'studio'],
    wardrobe: ['period costume neckline', 'collar detail', 'shawl draped']
  },
  // Product + waist/fullbody → product lifestyle
  'product+fullbody': {
    subject: ['product held by hand', 'lifestyle product placement', 'object on surface'],
    mood: ['clean and precise', 'commercial quality'],
    env: ['marble surface', 'concrete minimal', 'white studio', 'lifestyle kitchen'],
    wardrobe: []
  }
};

/* ── RENDER VOCAB CHIPS WITH INLINE EDITING ──────────────── */
function renderVocabChips(containerId, items, group) {
  const container = document.getElementById(containerId);
  if (!container) return;

  // Merge built-in items with any custom additions for this group
  const store = getVocabStore();
  const customAdded = store[group]
    ? Object.entries(store[group])
        .filter(([orig, val]) => val !== null && !items.includes(orig))
        .map(([orig, val]) => ({ original: orig, display: val, isCustom: true }))
    : [];

  const builtinItems = items
    .filter(item => !isChipDeleted(group, item))
    .map(item => ({
      original: item,
      display: getResolvedChipVal(group, item) || item,
      isCustom: false
    }));

  const allItems = [...builtinItems, ...customAdded];

  if (!sfState.selections[group]) sfState.selections[group] = [];

  container.innerHTML = allItems.map(({ original, display, isCustom }) => {
    const isActive = (sfState.selections[group] || []).includes(original);
    const customMark = isCustom ? ' sf-chip-custom' : '';
    return `<button class="sf-chip${isActive ? ' active' : ''}${customMark}"
      data-val="${escHtml(original)}"
      data-group="${group}"
      onclick="toggleSFChip(this,'${group}')"
      ondblclick="startChipEdit(this,'${group}','${escHtml(original)}')"
      title="Double-click to edit"
    >${escHtml(display)}</button>`;
  }).join('');

  // Add "＋ Add" chip at end
  container.innerHTML += `<button class="sf-chip sf-chip-add" onclick="addCustomChip('${containerId}','${group}')" title="Add custom chip">＋</button>`;
}

/* ── INLINE CHIP EDITING ─────────────────────────────────── */
function startChipEdit(btn, group, originalVal) {
  const currentDisplay = btn.textContent.trim();
  const input = document.createElement('input');
  input.type = 'text';
  input.value = currentDisplay;
  input.className = 'sf-chip-input';
  input.dataset.group = group;
  input.dataset.original = originalVal;

  // Replace button with input
  btn.replaceWith(input);
  input.focus();
  input.select();

  async function commit() {
    const newVal = input.value.trim();
    if (newVal && newVal !== currentDisplay) {
      try {
        await saveVocabEdit(group, originalVal, newVal);
        showToast('Chip updated', 'success');
      } catch (err) {
        showToast('Chip updated locally, but saving to server failed — check your connection', 'warning');
      }
    }
    // Re-render the chip container
    const container = input.closest('.sf-chips');
    if (container) {
      // Find which renderVocabChips call owns this container — re-trigger via genre vocab
      triggerVocabRefresh();
    }
  }

  input.addEventListener('blur', commit);
  input.addEventListener('keydown', e => {
    if (e.key === 'Enter') { e.preventDefault(); input.blur(); }
    if (e.key === 'Escape') {
      input.removeEventListener('blur', commit);
      triggerVocabRefresh();
    }
  });

  // Right-click context menu for delete
  input.addEventListener('contextmenu', e => {
    e.preventDefault();
    showConfirm('Remove Chip', `Remove "${currentDisplay}" from this group?`, async () => {
      try {
        await saveVocabEdit(group, originalVal, null);
        showToast('Chip removed', 'success');
      } catch (err) {
        showToast('Removed locally, but saving to server failed — check your connection', 'warning');
      }
      triggerVocabRefresh();
    });
  });
}

function triggerVocabRefresh() {
  // Re-render whatever vocab is currently loaded
  if (sfState.genre) {
    loadGenreVocab(sfState.genre);
  }
  updatePrompt();
}

/* ── ADD CUSTOM CHIP ─────────────────────────────────────── */
/* ── STATIC SECTION CUSTOM CHIP ─────────────────────────── */
// addStaticCustomChip is defined in 07-settings.js — do not duplicate here.

function addCustomChip(containerId, group) {
  const container = document.getElementById(containerId);
  if (!container) return;

  // Replace ＋ button with input temporarily
  const addBtn = container.querySelector('.sf-chip-add');
  if (!addBtn) return;

  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'sf-chip-input';
  input.placeholder = 'Type and press Enter…';
  input.style.minWidth = '140px';
  addBtn.replaceWith(input);
  input.focus();

  async function commit() {
    const newVal = input.value.trim();
    if (newVal) {
      // Save as a new custom chip (original key = new value)
      try {
        await saveVocabEdit(group, newVal, newVal);
        showToast('Chip added: ' + newVal, 'success');
      } catch (err) {
        showToast('Chip added locally, but saving to server failed — check your connection', 'warning');
      }
      // Add to current selections
      if (!sfState.selections[group]) sfState.selections[group] = [];
      sfState.selections[group].push(newVal);
      updatePrompt();
    }
    triggerVocabRefresh();
  }

  input.addEventListener('blur', commit);
  input.addEventListener('keydown', e => {
    if (e.key === 'Enter') { e.preventDefault(); input.blur(); }
    if (e.key === 'Escape') {
      input.removeEventListener('blur', commit);
      triggerVocabRefresh();
    }
  });
}


/* ── MULTI-FIGURE COMPOSITION TEXT ───────────────────────────
   Ported from inferComposition()'s OS/Medium/Wide cases in
   06-scene-engine.js (Storyboard mode) — same composition
   grammar, adapted for Single Frame's data shape (no beat text,
   no shotType variable; driven directly by sfState.frame and the
   ordered character selection). Kept as a separate function
   rather than importing inferComposition() itself because that
   function expects Storyboard's {beat, shotType, mentions}
   shape and a beat-text override scan that doesn't apply here.
   ───────────────────────────────────────────────────────────── */
function buildMultiFigureComposition(frame, charAssets, locName) {
  const names = charAssets.map(a => a.name);
  const primary = names[0] || null;
  const secondary = names[1] || null;
  const tertiary = names[2] || null;

  if (frame === 'os') {
    if (!primary || !secondary) {
      return `Eye level. Camera positioned close behind ${primary || 'the foreground figure'}'s shoulder. Shoulder and back of head fill the lower frame edge, soft focus. ${locName ? locName + ' visible beyond, in focus.' : 'Environment visible beyond, in focus.'}`;
    }
    // Frame-side + scale fix (found via testing 2026-06-29): without an
    // explicit side, the model placed both figures arbitrarily; without an
    // explicit scale/distance cue, the sharp/camera-facing figure (secondary)
    // rendered full-figure instead of properly cropped and smaller/more
    // distant the way a real OTS shot requires — the foreground figure's
    // shoulder should dominate the frame, not the person they're facing.
    const sharpSide = sfState.osSharpSubjectSide || 'frame-right';
    const anchorSide = sharpSide === 'frame-left' ? 'frame-right' : 'frame-left';
    return `Eye level. Camera positioned close behind ${primary}'s shoulder, occupying the ${anchorSide} portion of the frame — shoulder and back/side of head fill the lower-frame edge on the ${anchorSide}, soft focus, large in frame, not the subject. ${secondary} positioned on the ${sharpSide} side of the frame beyond ${primary}'s shoulder, sharp and in focus, but smaller and more distant in the frame than ${primary} — only head, shoulders, and upper torso visible (not full body), cropped naturally by the shot's depth, facing toward ${primary}/camera.${locName ? ' ' + locName + ' softly visible behind ' + secondary + '.' : ''}`;
  }

  if (frame === 'twoshot') {
    if (!primary || !secondary) {
      return `Eye level, locked-off. Camera faces ${primary || 'the subject'} directly. Fully visible head to feet.${locName ? ' ' + locName + ' as background.' : ''} Deep focus.`;
    }
    // Side fix (found via testing 2026-06-29, same gap as OS): "at frame
    // edge" never said which edge, so the model placed the anchor figure
    // arbitrarily. No scale mismatch here (both figures are explicitly
    // fully visible heads to feet), so only a side assignment was missing.
    const anchorSide = sfState.twoshotAnchorSide || 'frame-right';
    const dominantSide = anchorSide === 'frame-left' ? 'frame-right' : 'frame-left';
    return `Eye level, locked-off. Camera faces ${primary} directly. ${primary} sharp and dominant, in focus, occupying the ${dominantSide} portion of the frame. ${secondary} acts as a soft anchor on the ${anchorSide} side of the frame — present, facing toward ${primary}, softer focus.${locName ? ' ' + locName + ' as background.' : ''} Both figures fully visible — heads to feet.`;
  }

  if (frame === 'threeshot') {
    if (!primary) {
      return `Eye level, locked-off. Camera faces ${locName || 'the scene'} straight on. Full environment visible. Deep focus throughout.`;
    }
    // Side fix (found via testing 2026-06-29, same gap as OS/Two Shot): the
    // two flanking figures previously had no left/right assignment at all —
    // just "X and Y flank primary," letting the model put either figure on
    // either side, inconsistently across regenerations. Now mapped
    // explicitly by click order via sfState.threeshotSides.
    let flankPart;
    if (secondary && tertiary) {
      const secondLeft = (sfState.threeshotSides || 'second-left') === 'second-left';
      const leftName = secondLeft ? secondary : tertiary;
      const rightName = secondLeft ? tertiary : secondary;
      flankPart = `${leftName} on the frame-left side and ${rightName} on the frame-right side flank ${primary}, fully visible heads to feet.`;
    } else if (secondary || tertiary) {
      const only = secondary || tertiary;
      flankPart = `${only} flanks ${primary} on one side, fully visible heads to feet — leave space on the opposite side for the remaining figure.`;
    } else {
      flankPart = `Frame composed for three figures, but only ${primary} is selected — leave space at both sides for the remaining figures.`;
    }
    return `Eye level, locked-off. ${primary} centred, fully visible head to feet. ${flankPart}${locName ? ' ' + locName + ' as background.' : ''} Deep focus — all figures sharp.`;
  }

  return null;
}

/* ── FRAME SIZE ──────────────────────────────────────────── */
function setSFFrame(btn) {
  document.querySelectorAll('.sf-frame-card').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  sfState.frame = btn.dataset.val;
  renderAutoInjectBanner();
  renderCameraAutoSuggest();
  renderSFRoleOrderHint();
  renderSFOSSideControl();
  renderAngleRedundancyGuard();
  renderSFReferenceStrip();
  // Refresh vocab combination if genre already selected
  if (sfState.genre) loadGenreVocab(sfState.genre);
  updatePrompt();
}

// Frame vs. Shot Angle redundancy guard — "Over-the-Shoulder" exists as both
// a Frame option (os, with full anchor/sharp-subject composition logic) and
// a Shot Angle option (single chip, label-only). Picking both produced
// duplicate "over-the-shoulder" framing language in the generated prompt.
// Fix: when frame=os is active, disable just that one angle chip (the other
// angle choices — low/high/bird's eye/eye level — stay selectable and remain
// meaningful combined with an OS frame, e.g. a low-angle OS shot). If the OS
// angle chip was already selected when the user switches to the OS frame,
// clear that selection since the frame now covers it — this can't silently
// leave a stale selection that no longer renders into the prompt.
function renderAngleRedundancyGuard() {
  const osAngleChip = document.querySelector('#sf-angle-chips .sf-chip[data-val="over-the-shoulder"]');
  if (!osAngleChip) return;
  if (sfState.frame === 'os') {
    if (osAngleChip.classList.contains('active')) {
      osAngleChip.classList.remove('active');
      sfState.selections.angle = (sfState.selections.angle || []).filter(v => v !== 'over-the-shoulder');
    }
    osAngleChip.disabled = true;
    osAngleChip.classList.add('sf-chip-redundant');
    osAngleChip.title = 'Already covered by the Over-the-Shoulder frame — pick a different frame to use this as a camera angle instead.';
  } else {
    osAngleChip.disabled = false;
    osAngleChip.classList.remove('sf-chip-redundant');
    osAngleChip.title = '';
  }
}

function renderAutoInjectBanner() {
  const banner = document.getElementById('sf-auto-inject-banner');
  const chipsContainer = document.getElementById('sf-auto-inject-chips');
  if (!banner || !chipsContainer) return;

  const prereq = sfState.frame ? PREREQ[sfState.frame] : null;
  if (!prereq || !prereq.inject.length) {
    banner.style.display = 'none';
    return;
  }

  banner.style.display = '';
  chipsContainer.innerHTML = prereq.inject.map(item =>
    `<span class="sf-auto-chip-item">${item}</span>`
  ).join('');
}

function renderCameraAutoSuggest() {
  // Clear all previously auto-selected chips first
  document.querySelectorAll('.sf-chip.auto-selected').forEach(btn => {
    btn.classList.remove('active', 'auto-selected');
    const group = btn.dataset.autoGroup;
    if (group) {
      sfState.selections[group] = (sfState.selections[group] || []).filter(v => v !== btn.dataset.val);
    }
  });

  const suggest = sfState.frame ? CAMERA_SUGGEST[sfState.frame] : null;
  const display = document.getElementById('sf-camera-auto');
  if (!suggest) { if (display) display.style.display = 'none'; return; }
  if (display) display.style.display = 'none'; // hide old text display — chips do the job now

  // Auto-select lens chip
  const lensChip = document.querySelector(`#sf-lens-chips .sf-chip[data-val="${suggest.lensVal}"]`);
  if (lensChip && !lensChip.classList.contains('active')) {
    lensChip.classList.add('active', 'auto-selected');
    lensChip.dataset.autoGroup = 'lens';
    if (!sfState.selections.lens) sfState.selections.lens = [];
    if (!sfState.selections.lens.includes(suggest.lensVal)) sfState.selections.lens.push(suggest.lensVal);
  }

  // Auto-select aperture chip (single-select group)
  const apertureChip = document.querySelector(`#sf-aperture-chips .sf-chip[data-val="${suggest.apertureVal}"]`);
  if (apertureChip && !apertureChip.classList.contains('active')) {
    // Clear other aperture selections first
    document.querySelectorAll('#sf-aperture-chips .sf-chip').forEach(b => b.classList.remove('active', 'auto-selected'));
    sfState.selections.aperture = [];
    apertureChip.classList.add('active', 'auto-selected');
    apertureChip.dataset.autoGroup = 'aperture';
    sfState.selections.aperture = [suggest.apertureVal];
  }

  // Auto-enable subsurface scattering for face/head frames
  const sssCb = document.getElementById('sig-sss');
  if (sssCb) {
    if (suggest.sss && !sssCb.checked) {
      sssCb.checked = true;
      sssCb.dataset.autoEnabled = 'true';
    } else if (!suggest.sss && sssCb.dataset.autoEnabled === 'true') {
      sssCb.checked = false;
      delete sssCb.dataset.autoEnabled;
    }
  }
}

/* ── RATIO ───────────────────────────────────────────────── */
function setSFRatio(btn) {
  document.querySelectorAll('.sf-ratio-card').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  sfState.ratio = btn.dataset.val;
  updatePrompt();
}

/* ── PLATFORM ─────────────────────────────────────────────── */
function syncSFPlatformUI() {
  document.querySelectorAll('.sf-platform-card').forEach(b => {
    b.classList.toggle('active', b.dataset.val === sfState.platform);
  });
  const badge = document.getElementById('sf-output-platform-badge');
  if (badge && PLATFORM_TIPS[sfState.platform]) badge.textContent = PLATFORM_TIPS[sfState.platform].badge;
}

function setSFPlatform(btn) {
  document.querySelectorAll('.sf-platform-card').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  sfState.platform = btn.dataset.val;
  const badge = document.getElementById('sf-output-platform-badge');
  if (badge) badge.textContent = PLATFORM_TIPS[sfState.platform].badge;
  checkPlatformMotionCompat();
  renderPlatformTips();
  updatePrompt();
}

function renderPlatformTips() {
  const el = document.getElementById('sf-platform-tips');
  if (!el) return;
  const tips = PLATFORM_TIPS[sfState.platform];
  if (!tips) { el.classList.remove('visible'); return; }
  el.classList.add('visible');
  el.innerHTML = `<div class="sf-tips-title">${tips.badge} — Grammar</div>${tips.tip}`;
}

/* ── AUTO DETAIL TOGGLE ──────────────────────────────────── */
function toggleAutoView() {
  sfState.showAutoDetail = !sfState.showAutoDetail;
  const btn = document.getElementById('sf-auto-toggle');
  const detail = document.getElementById('sf-auto-detail');
  if (btn) btn.classList.toggle('active', sfState.showAutoDetail);
  if (detail) detail.style.display = sfState.showAutoDetail ? '' : 'none';
  if (btn) btn.textContent = sfState.showAutoDetail ? 'Hide auto-adds' : 'Show auto-adds';
}

/* ── SINGLE FRAME @ HANDLERS ─────────────────────────────── */
// Maps each @-mention-enabled SF textarea id to its sfState.freeText key.
// Was previously hardcoded to a subject/env ternary, which silently wrote
// wardrobe input into freeText.env once wardrobe's oninput was wired up —
// kept as an explicit map so adding more @-mention fields stays safe.
const SF_FIELD_KEY_MAP = {
  'sf-subject-text': 'subject',
  'sf-env-text': 'env',
  'sf-wardrobe-text': 'wardrobe'
};
function onSFFieldInput(e, textareaId, pickerId, listId) {
  const ta = e.target;
  const key = SF_FIELD_KEY_MAP[textareaId] || 'env';
  sfState.freeText[key] = ta.value;
  handleAtMention(ta, pickerId, listId);
  updatePrompt();
}

function onSFFieldKeydown(e, textareaId, pickerId, listId) {
  if (!atPickerState.active) return;
  handleAtPickerKeydown(e, textareaId, pickerId, listId);
}

/* ── RESOLVE @ MENTIONS IN SF FREE TEXT ──────────────────── */
function resolveSFMentions(text) {
  // Replaces @AssetName in free text with just the asset's name (not the full description).
  // Full descriptions are injected once in their dedicated prompt sections — not inline.
  const mentions = parseAtMentions(text);
  if (!mentions.length) return text;
  let resolved = text;
  // Strip type-disambiguation tags first, e.g. "@Siblings(P)" → "Siblings" —
  // these are a parsing aid only (see MENTION_TYPE_TAGS, 04-mentions.js) and
  // should never reach the actual generated prompt text.
  resolved = resolved.replace(/@([a-z0-9_]+)\([clpes]\)/gi, '$1');
  mentions.forEach(({ name, asset }) => {
    const variants = [
      '@' + asset.name.replace(/\s+/g, ''),
      '@' + asset.name,
      '@' + name,
    ];
    variants.forEach(v => {
      resolved = resolved.replace(new RegExp(v.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'), asset.name);
    });
  });
  return resolved;
}
// Debounce timer for the two heavy re-renders below — bug found 2026-07-03:
// renderSFReferenceStrip()/renderSFAssetSelector() fully rebuild their DOM
// (including base64 reference-image thumbnails) on every single keystroke,
// with no debounce, making typing feel slow — worse the more assets get
// matched (see the parseAtMentions() fix in 04-mentions.js the same day).
// Typing itself (sfState.freeText + the prompt-preview text box) stays
// immediate; only the image-heavy re-renders wait for a short pause.
let _sfHeavyRenderTimer = null;
const SF_HEAVY_RENDER_DEBOUNCE_MS = 250;

// Fable audit fix (2026-07-08 report, applied 2026-07-10, M3) — this used
// to run its addEventListener() calls unconditionally on every call, but
// the 5 textareas + 6 toggles it binds are static elements in shell.html
// that are never recreated (unlike, say, a dynamically-rebuilt asset
// list) — switchView('single') (01-core.js) calls this on every visit to
// the Single Frame tab, and loadSFStateFromSnapshot() (this file, restoring
// a saved Sequence shot) calls it again on top of that. With no guard,
// each extra call stacked one more duplicate listener on the SAME DOM
// nodes: after N visits/restores in one session, every keystroke ran
// updatePrompt() (a full prompt assembly) N+1 times and every toggle
// flip ran it N times — a session-length-dependent slowdown, not a
// one-time cost. This flag makes every call after the first a no-op.
let _sfInputsBound = false;
function sfBindTextInputs() {
  if (_sfInputsBound) return;
  _sfInputsBound = true;
  const bindings = [
    ['sf-subject-text', 'subject'],
    ['sf-wardrobe-text', 'wardrobe'],
    ['sf-env-text', 'env'],
    ['sf-mood-text', 'mood'],
    ['sf-neg-text', 'neg']
  ];
  bindings.forEach(([id, key]) => {
    const el = document.getElementById(id);
    if (el) el.addEventListener('input', () => {
      sfState.freeText[key] = el.value.trim();
      if (key === 'subject' || key === 'env') {
        clearTimeout(_sfHeavyRenderTimer);
        _sfHeavyRenderTimer = setTimeout(() => {
          renderSFReferenceStrip();
          renderSFAssetSelector();
        }, SF_HEAVY_RENDER_DEBOUNCE_MS);
      }
      updatePrompt();
    });
  });

  // Sig toggles
  ['dual-light','sss','particles','practical','wind','frozen'].forEach(key => {
    const el = document.getElementById('sig-' + key);
    if (el) el.addEventListener('change', () => {
      sfState.sigs[key] = el.checked;
      updatePrompt();
    });
  });
}

/* ── SIGNATURE TECHNIQUE PHRASES ────────────────────────── */
// Phrases sourced from VOCABULARY_DATA.signatureTechniques (vocabulary.json).
// Fallbacks inline for dev/offline use.
const _SIG_FALLBACK = {
  'dual-light': 'warm amber practical light against cold blue-grey background, dual light temperature contrast between subject and environment',
  'sss':        'light passes through ear cartilage and nostril edges creating warm reddish translucency, subsurface scattering skin render, photorealistic skin physics',
  'particles':  null, // dynamic — resolved via getParticlePhrase()
  'practical':  'all illumination from visible practical sources in scene — candles, fire, oil lamps, no artificial studio fill light',
  'wind':       'individual hair strand separation, wind-blown directional movement, flyaway strands catching light, realistic hair physics simulation',
  'frozen':     'high-speed frozen moment, motion blur on periphery only, sharp subject at point of impact, debris and fabric suspended mid-motion with physically accurate dynamics'
};

function getParticlePhrase() {
  // Read context from current prompt inputs to infer correct particle type
  const envText   = (document.getElementById('sf-env-text')?.value || '').toLowerCase();
  const subjText  = (document.getElementById('sf-subject-text')?.value || '').toLowerCase();
  const moodText  = (document.getElementById('sf-mood-text')?.value || '').toLowerCase();
  const combined  = envText + ' ' + subjText + ' ' + moodText;

  if (/heavy rain|downpour|torrential/.test(combined))
    return 'heavy rain — dense vertical raindrop streaks, motion blur on drops, puddle splash impacts, wet surface reflections, atmospheric moisture haze';
  if (/rain|drizzle|shower|wet/.test(combined))
    return 'rain — individual raindrop streaks catching light, fine rain mist in background, glistening wet surfaces, soft atmospheric diffusion';
  if (/snow|blizzard|snowfall/.test(combined))
    return 'falling snow — individually rendered snowflakes at varying depths, some blurred in foreground, soft volumetric light scatter, snow mist on ground';
  if (/ash|ember|fire|flame|burning/.test(combined))
    return 'floating ash and embers — glowing cinders rising on heat convection, ash drift in air, backlit ember trails, fine particulate haze';
  if (/sand|desert|dune|sandstorm/.test(combined))
    return 'windborne sand particles — fine grain suspension in air, grazing light picking up individual grains, sand drift along ground surface';
  if (/smoke|fog|mist|haze/.test(combined))
    return 'volumetric atmospheric haze — fine smoke or mist particles, light scattering through medium, soft depth layers';
  if (/pollen|forest|spring|blossom/.test(combined))
    return 'floating pollen and spores — golden-lit micro-particles drifting, volumetric light scatter through foliage, soft organic haze';
  if (/dust|dry|arid|ancient|ruin/.test(combined))
    return 'dust motes suspended mid-air, individually visible, backlit by directional light, volumetric atmosphere, physically accurate particle dynamics';

  // Default
  return 'dust motes suspended mid-air, individually visible, backlit, volumetric atmosphere, physically accurate particle dynamics';
}

function getSigPhrase(key) {
  if (key === 'particles') return getParticlePhrase();
  const vocabSigs = (typeof VOCABULARY_DATA !== 'undefined' && VOCABULARY_DATA.signatureTechniques) || {};
  return vocabSigs[key] || _SIG_FALLBACK[key] || '';
}

function getSigPhrases() {
  const phrases = [];
  Object.keys(sfState.sigs).forEach(key => {
    if (sfState.sigs[key]) {
      const phrase = getSigPhrase(key);
      if (phrase) phrases.push(phrase);
    }
  });
  return phrases;
}

/* ── COLLECT ALL SELECTIONS ──────────────────────────────── */
function collectSFData() {
  const p = getCurrentProject();
  // Effective assets = project characters + this project's linked shared
  // library assets (location/prop/era/style). See getEffectiveAssets() in 01-core.js.
  const effectiveAssets = p ? getEffectiveAssets() : {};

  // Age-blind + antislop hygiene pass — same helpers used in Storyboard
  // mode's buildPanelPrompt() (06-scene-engine.js). Single Frame mode never
  // called them (gap found 2026-06-27 via functional test: "elderly old
  // man" passed straight through into GPT/NB output). Applied here, once,
  // centrally — every text source below (asset descs, free text, composition)
  // gets sanitized before reaching any of the 4 platform builders, so no
  // builder needs its own pass. Guarded with typeof since 06-scene-engine.js
  // loads after 02-singleframe.js in script order (see dist/ss_studioV7.html);
  // function declarations are hoisted, but the guard keeps this safe even if
  // load order ever changes.
  function sfSanitize(text) {
    if (!text) return text;
    if (typeof ageBlindSanitize === 'function') text = ageBlindSanitize(text);
    if (typeof antislopFilter === 'function') text = antislopFilter(text);
    return text;
  }

  // Costume/clothing detail only matters when the frame is wide enough to
  // actually show it. 'face' (extreme close-up, face only) and 'ecu'
  // (extreme close-up insert detail) never show clothing at all; 'head'
  // (head-and-shoulders) shows at most a collar, not worth a full costume
  // line. Gap found via testing 2026-06-29: costume text was being injected
  // unconditionally regardless of frame, so e.g. a close-up face shot's
  // prompt carried full outfit description that had no business being there.
  const FRAMES_SHOW_CLOTHING = { waist: true, fullbody: true, wide: true, os: true, twoshot: true, threeshot: true };
  const shouldIncludeCostume = !sfState.frame || FRAMES_SHOW_CLOTHING[sfState.frame];

  // Frame-aware filter for descriptions stacked via the Asset modal's
  // per-image-slot "merge" (magic-wand) button (09-image-analyser.js).
  // That button tags each merged chunk with its source slot, e.g.
  // "[Close-up] ... \n[Mid Shot] ... \n[Character Sheet] ...", and stacks
  // them all into the one asset.description field. Gap found via testing
  // 2026-06-29: collectSFData() read description whole, with no frame
  // awareness, so a Head & Shoulders frame got the Mid Shot block's
  // costume/gesture language and the Character Sheet's turnaround/height
  // language too — content with no business being in a tight portrait shot.
  // Fix: pick only the block(s) relevant to the selected frame, same
  // priority order getImageForShot() (01-core.js) already uses to pick a
  // reference IMAGE for a given shot type — reusing that mapping instead of
  // inventing a second one, so "which slot answers this frame" stays single-
  // sourced. Descriptions with no [Tag] markers (the common case — most
  // assets are typed by hand, never merged) pass through completely
  // untouched, exactly as before this fix.
  // Originally applied to character only; extended 2026-06-29 to prop/
  // location/era too (see FRAME_FILTERED_TYPES below) after a prop asset's
  // [Full View] block (a held trident) was found rendering on every frame
  // size, including close-ups where it should never have appeared.
  // Promoted to a global function 2026-06-30 (filterDescByShotType(),
  // 01-core.js) so the Storyboard engine can reuse the exact same
  // filtering logic — it had never had any frame/shot filtering at all,
  // which dumped every stacked [Tag] block into every panel's prompt
  // regardless of that panel's shotType (found via live test 2026-06-30,
  // Changdev's Close-up AND Establishing panels both printing his full
  // Close-up + Mid Shot + Character Sheet text verbatim). This local
  // wrapper just passes sfState.frame through unchanged — Single Frame's
  // existing, already-tested behavior is byte-for-byte preserved.
  function filterDescByFrame(desc) {
    return filterDescByShotType(desc, sfState.frame);
  }

  // Asset types whose stacked [Tag] description blocks should be frame-
  // filtered the same way character descriptions already are (v7.8.1).
  // Gap found 2026-06-29: a prop asset's [Full View] block (e.g. a held
  // trident, analysed via 09-image-analyser.js's object-focus path) was
  // rendering unconditionally on every frame size, including tight
  // mid-close-ups where the prop was never meant to appear in frame.
  // filterDescByFrame() is a no-op for any description with no [Tag]
  // blocks, so this only changes behaviour for assets that actually have
  // multiple stacked merge blocks — the common single-block case is
  // unaffected. 'style' intentionally excluded: it describes rendering
  // technique, not scene content, so it has no frame-relevance concept.
  const FRAME_FILTERED_TYPES = ['character', 'prop', 'location', 'era'];

  // Context text for the location image/feature-match resolver — see
  // resolveLocationImageForContext() (01-core.js). Built once here (ahead of
  // subjectRaw/envRaw below, which the two assetDescs loops don't need until
  // after this point) so both loops can add a matching feature clause to a
  // location asset's own description text — e.g. "We see the water tank
  // (right side) in frame." — so the model actually reads about it, not just
  // the reference-strip UI (see renderSFReferenceStrip()'s matching note).
  const _locContextText = [sfState.freeText.subject, sfState.freeText.env].filter(Boolean).join(' ');
  function _locFeatureNote(a) {
    if (a.type !== 'location' || typeof resolveLocationImageForContext !== 'function') return '';
    const resolved = resolveLocationImageForContext(a, sfState.frame, _locContextText);
    if (!resolved.matchedFeature) return '';
    const f = resolved.matchedFeature;
    return ` We see the ${f.name}${f.position ? ' (' + f.position + ')' : ''} in frame.`;
  }

  // Location Designer "Camera faces" direction text — Shot Setup Single
  // Frame port, phase 1 (2026-07-10). Ported from Storyboard's
  // directionNote() (06-scene-engine.js buildPanelPrompt()), gated on
  // sfState.cameraFacingDirection instead of panel.cameraFacingDirection.
  // No wrapDirectionClause() here — see sfCameraFacingInnerHTML()'s header
  // comment for why (no char-budget trim system on this side yet).
  function _directionNote(a) {
    if (a.type !== 'location' || !sfState.cameraFacingDirection || !Array.isArray(a.directions)) return '';
    const direction = a.directions.find(d => d.name === sfState.cameraFacingDirection);
    if (!direction) return '';
    const hasImage = !!(typeof getImageForShot === 'function' && getImageForShot(a, sfState.frame));
    const text = hasImage ? direction.shortTag : direction.fullDescription;
    if (!text) return '';
    const exterior = (typeof isExteriorDirection === 'function') && isExteriorDirection(direction);
    return exterior
      ? ` Facing ${direction.name}: ${text}, view stretching into the distance.`
      : ` Facing ${direction.name}: ${text}, visible on this side of frame.`;
  }

  // Selected assets (chip selector)
  const assetDescs = [];
  if (p) {
    Object.keys(sfState.selectedAssets).forEach(id => {
      const a = effectiveAssets[id];
      if (!a) return;
      let desc = FRAME_FILTERED_TYPES.includes(a.type) ? filterDescByFrame(a.description) : a.description;
      if (a.costume && shouldIncludeCostume) desc += '. Costume: ' + a.costume;
      if (a.keyDetails) desc += '. ' + a.keyDetails;
      if (a.cultural) desc += '. Context: ' + a.cultural;
      desc += _locFeatureNote(a);
      desc += _directionNote(a);
      assetDescs.push({ name: a.name, type: a.type, desc: sfSanitize(desc) });
    });
  }

  // Also resolve @ mentions from subject and env free text
  const subjectRaw = sfState.freeText.subject || '';
  const envRaw = sfState.freeText.env || '';
  const subjectMentions = parseAtMentions(subjectRaw);
  const envMentions = parseAtMentions(envRaw);
  const allMentions = [...subjectMentions, ...envMentions];

  allMentions.forEach(({ asset: a }) => {
    // Fetch-on-reference (2026-07-10) — an @-mention is also a live
    // reference, same as a chip click (toggleSFAsset()). Fires on every
    // collectSFData() call (i.e. every keystroke) but fetchFullLibraryAssets()
    // is a no-op once an id is cached, so this is cheap after the first hit.
    if (typeof fetchAssetImageOnReference === 'function') fetchAssetImageOnReference(a.type, a.id);
    if (!assetDescs.find(d => d.name === a.name)) {
      let desc = FRAME_FILTERED_TYPES.includes(a.type) ? filterDescByFrame(a.description) : a.description;
      if (a.costume && shouldIncludeCostume) desc += '. Costume: ' + a.costume;
      if (a.keyDetails) desc += '. ' + a.keyDetails;
      desc += _locFeatureNote(a);
      desc += _directionNote(a);
      assetDescs.push({ name: a.name, type: a.type, desc: sfSanitize(desc) });
    }
  });

  // Shot Setup prompt-text injection — Single Frame port phase 2
  // (2026-07-10). Mirrors Storyboard's shotSetupNoteText() (06-scene-engine.js
  // buildPanelPrompt()) closely, adapted for Single Frame's single-state
  // model: findShotSetupForSingleFrame() (14-shot-setup.js) looks for the
  // one shot flagged linkedSingleFrame: true across a project's shot
  // setups, instead of a panel-indexed linkedPanelId match. Computed once
  // here and returned as data.shotSetupText so buildPromptModel() can hand
  // it to the platform builders the same way every other shared field
  // flows through (see that function's header comment) — MJ/NB/GPT all
  // read m.shotSetupText; Kling's builder deliberately doesn't, matching
  // Storyboard's own Kling branch (its terse shot-fragment format doesn't
  // fit a multi-line "Shot setup: ..." block — see buildPanelPrompt()'s
  // kling branch, 06-scene-engine.js).
  function _shotSetupNote() {
    if (typeof findShotSetupForSingleFrame !== 'function') return '';
    const found = findShotSetupForSingleFrame();
    if (!found) return '';
    const { setup, shotIndex } = found;

    // Location-match guard — same reasoning as Storyboard's
    // shotSetupNoteText() "Fix 1": only trust this shot setup if its own
    // location is the one actually in play for THIS Single Frame state
    // right now (chip-selected or @-mentioned), not a stale link left over
    // from a different location.
    const locInPlay = typeof sfLocationInPlay === 'function' ? sfLocationInPlay() : null;
    if (!setup.locationId || !locInPlay || setup.locationId !== locInPlay.id) return '';

    const positions = (typeof resolveAllPositionsForShot === 'function') ? resolveAllPositionsForShot(setup, shotIndex) : {};

    // Relevant objects — only describe an object actually referenced in
    // THIS Single Frame state (chip-selected or @-mentioned in subject/env),
    // same "don't describe someone who isn't actually in this shot"
    // reasoning as Storyboard's own per-panel filter ("Fix 2").
    const referencedIds = new Set([
      ...Object.keys(sfState.selectedAssets),
      ...allMentions.map(m => m.asset.id)
    ]);
    const relevantObjects = (setup.objects || []).filter(o => {
      if (!positions[o.id]) return false;
      if (!o.assetId) return true;
      return referencedIds.has(o.assetId);
    });
    if (!relevantObjects.length) return '';

    const nameFor = o => (o.assetId && effectiveAssets[o.assetId]) ? effectiveAssets[o.assetId].name : (o.label || 'Unnamed');

    const posLines = relevantObjects.map(o => `${nameFor(o)} positioned ${positions[o.id]} (as viewed)`).join('; ');

    // Reference-role labels — same Cross-Shot Continuity format as
    // Storyboard's version.
    let imgNum = 1;
    const roleLines = [];
    if (setup.locationId) { roleLines.push(`Image ${imgNum}: background/setting only.`); imgNum++; }
    relevantObjects.forEach(o => {
      const roleWord = o.type === 'character' ? 'identity/pose reference only' : 'prop reference only';
      roleLines.push(`Image ${imgNum}: ${nameFor(o)}, ${positions[o.id]}, ${roleWord}.`);
      imgNum++;
    });

    // Staged-generation caution — same live-testing finding as Storyboard's
    // version (2026-07-06 spec findings).
    const charCount = relevantObjects.filter(o => o.type === 'character').length;
    const stagedCaution = charCount >= 2
      ? ' Testing found 2+ character references in one call degrades identity and position accuracy — prefer a staged sequence (add one new character at a time, building on the prior shot\'s result) over one combined call.'
      : '';

    return `Shot setup: ${posLines}. ${roleLines.join(' ')}${stagedCaution}`;
  }
  const shotSetupText = _shotSetupNote();

  // Resolve @ in free text to full descriptions for prompt use
  sfState.freeText._subjectResolved = sfSanitize(resolveSFMentions(subjectRaw));
  sfState.freeText._envResolved = sfSanitize(resolveSFMentions(envRaw));

  // Auto-inject from frame
  const autoInject = sfState.frame ? (PREREQ[sfState.frame]?.inject || []) : [];

  // Multi-figure composition (OS / Two Shot / Three Shot) — built from the
  // ordered character selection, not free text. Null for single-subject
  // frames (face/head/waist/fullbody/wide/ecu), where each platform builder
  // keeps its existing frameDescs label-only behaviour.
  let multiFigureComposition = null;
  if (MULTI_FIGURE_FRAMES[sfState.frame]) {
    const orderedChars = getOrderedSelectedCharacters();
    const locAsset = assetDescs.find(a => a.type === 'location');
    multiFigureComposition = sfSanitize(buildMultiFigureComposition(sfState.frame, orderedChars, locAsset ? locAsset.name : null));
  }

  // Motion settings
  const motionElement = sfState.selections['motion-element'][0] || null;
  const motionType = sfState.selections['motion-type'][0] || null;
  const motionIntensity = sfState.selections['motion-intensity'][0] || null;
  const motionDuration = sfState.selections['motion-duration'][0] || null;

  // Negatives
  const negChips = sfState.selections.neg || [];
  const negText = sfState.freeText.neg;
  // Era negatives from selected era assets
  const eraNegatives = [];
  if (p) {
    Object.keys(sfState.selectedAssets).forEach(id => {
      const a = effectiveAssets[id];
      if (a && a.type === 'era' && a.negatives) {
        eraNegatives.push(...a.negatives.split(',').map(s => s.trim()).filter(Boolean));
      }
    });
  }

  return {
    assetDescs,
    autoInject,
    multiFigureComposition,
    motionElement, motionType, motionIntensity, motionDuration,
    negChips, negText, eraNegatives,
    shotSetupText
  };
}

/* ── PROMPT BUILDERS ─────────────────────────────────────── */

/* ── SHARED PROMPT MODEL (Fable audit item #6, buildPromptModel()
   refactor — first slice, 2026-07-04) ───────────────────────────────
   The 4 platform builders below (buildMJPrompt/buildNBPrompt/
   buildKlingPrompt/buildGPTPrompt) each independently re-derived the
   same "which chips + free text + which asset-type descriptions go
   into this bucket" filtering — asset-type filtering alone appeared
   ~16 times across the 4 builders, the highest bug-risk duplication
   per the Fable audit (a mismatched filter condition between builders,
   e.g. one accidentally including 'era' assets in the env bucket and
   another not, would silently diverge). This computes those raw
   ingredients ONCE and hands them to whichever builder wants them.

   Deliberately stops at RAW ingredients — chip arrays, free text,
   filtered asset-description arrays, single values — and does NOT
   decide labels, join separators, section ordering, or platform-
   specific trimming. Verified against the pre-existing builders
   (a 25-case test matrix covering empty state, a fully-populated
   mythology scene, motion, multi-figure composition, negatives-only,
   every frame key, and every aspect-ratio option) that several
   platform-specific choices are DELIBERATE, not accidental drift, and
   must stay platform-owned rather than folded into this shared model:
     - MJ strips the descriptive suffix off the aperture value
       (`.split(' —')[0]`) to stay terse/keyword-style; NB/Kling/GPT
       keep the full descriptive string, appropriate to their more
       narrative styles (see PLATFORM_TIPS).
     - MJ caps quality chips at 3 (`.slice(0,3)`); the others don't.
     - MJ resolves the time-of-day label from the active DOM chip's
       `data-label` attribute (a nicer display string); NB/Kling/GPT
       use the raw stored value directly — a genuine pre-existing
       inconsistency between MJ and the other three, left untouched
       here (folding it into a shared value would change either MJ's
       or the other three's output, which is a separate, deliberate
       decision to make later, not a side effect of this refactor).
     - MJ's overall structure front-loads character/prop asset
       descriptions ahead of frame/composition (matching Midjourney's
       own "front-load the most important elements" guidance) rather
       than folding them into a single labelled "subject" section the
       way NB/Kling/GPT do — a deliberate structural difference, not
       shared logic.
   Only `buildGPTPrompt()` consumes this model so far (migrated and
   verified byte-identical against its pre-existing output across the
   same 25-case matrix). `buildMJPrompt()`/`buildNBPrompt()`/
   `buildKlingPrompt()` still compute their own ingredients locally,
   unchanged — migrating those is tracked separately (future-features.md)
   so each can go through the same one-at-a-time verification. */
function buildPromptModel(data) {
  return {
    subjectChips: sfState.selections['subject-genre'] || [],
    subjectText: sfState.freeText._subjectResolved || sfState.freeText.subject,
    charAssetDescs: data.assetDescs.filter(a => a.type === 'character').map(a => a.desc),

    envChips: sfState.selections['env-genre'] || [],
    envText: sfState.freeText._envResolved || sfState.freeText.env,
    locAssetDescs: data.assetDescs.filter(a => a.type === 'location').map(a => a.desc),
    eraAssetDescs: data.assetDescs.filter(a => a.type === 'era').map(a => a.desc),

    wardrobeChips: sfState.selections['wardrobe-genre'] || [],
    wardrobeText: sfState.freeText.wardrobe,
    propAssetDescs: data.assetDescs.filter(a => a.type === 'prop').map(a => a.desc),

    condition: sfState.selections.condition?.[0] || null,

    frame: sfState.frame,
    angle: sfState.selections.angle || [],
    dutch: sfState.dutch,
    multiFigureComposition: data.multiFigureComposition,

    todRaw: sfState.selections.tod?.[0] || null,
    lightingCombined: getLightingCombined(),

    lens: sfState.selections.lens?.[0] || null,
    aperture: sfState.selections.aperture?.[0] || null,
    camera: sfState.selections.camera?.[0] || null,

    mood: sfState.selections.mood || [],
    moodText: sfState.freeText.mood,

    sigs: getSigPhrases(),
    autoStr: data.autoInject.join(', '),

    quality: sfState.selections.quality || [],
    styleAssetDescs: data.assetDescs.filter(a => a.type === 'style').map(a => a.desc),

    negChips: sfState.selections.neg || [],
    eraNegatives: data.eraNegatives,
    negText: sfState.freeText.neg,

    motion: sfState.outputType === 'motion'
      ? { element: data.motionElement, type: data.motionType, intensity: data.motionIntensity, duration: data.motionDuration }
      : null,

    ratio: sfState.ratio,

    // Shot Setup — Single Frame port phase 2 (2026-07-10). See
    // collectSFData()'s _shotSetupNote() for how this is computed.
    shotSetupText: data.shotSetupText
  };
}

/* Migrated to consume buildPromptModel() (Fable audit item #6, second
   builder — 2026-07-04). Verified byte-identical against the pre-migration
   version across the same 25-case matrix used for buildGPTPrompt() (v7.10.6).
   Two genuine findings surfaced during that verification (dead `subjectLine`
   meaning subject-genre chips/free text never reached the MJ prompt; env
   line missing era asset descriptions unlike GPT/NB) — preserved as-is at
   migration time since a byte-identical migration isn't the place to change
   behavior. Both fixed here on 2026-07-11 after deliberate review (see
   changelog v7.23.2 and future-features.md item 6a): MJ now includes
   subject-genre chips + free subject text (finding #1) and era asset
   descriptions in the environment line (finding #2), bringing it to parity
   with GPT/NB on content coverage while keeping MJ's own terse comma-list
   structure and ordering conventions. */
function buildMJPrompt(data) {
  const m = buildPromptModel(data);
  const parts = [];
  const negParts = [];

  // Asset descriptions (character/prop first — most important). Kept as a
  // direct data.assetDescs filter rather than m.charAssetDescs/
  // m.propAssetDescs (those are split by type in the shared model, which
  // would force a fixed char-then-prop grouping) — this preserves whatever
  // interleaved order the user's own asset selection produced, matching
  // pre-migration output exactly. Documented as MJ's own deliberate
  // front-loaded structure in buildPromptModel()'s comment above.
  data.assetDescs.filter(a => ['character','prop'].includes(a.type)).forEach(a => {
    parts.push(a.desc);
  });

  // Subject-genre chips + free subject text — fixed 2026-07-11 (finding #1
  // above). Previously dropped entirely for MJ; GPT/NB both include this.
  const subjectLine = [...m.subjectChips, m.subjectText].filter(Boolean).join(', ');
  if (subjectLine) parts.push(subjectLine);

  // Frame + angle
  const frameLabels = { face: 'extreme close-up face only', head: 'head and shoulders portrait', waist: 'waist-up medium shot', fullbody: 'full body', wide: 'wide environmental shot', os: 'over-the-shoulder shot', twoshot: 'two shot', threeshot: 'three shot', ecu: 'extreme close-up insert detail' };
  if (m.frame) parts.push(frameLabels[m.frame]);
  if (m.multiFigureComposition) parts.push(m.multiFigureComposition);
  if (m.angle.length) parts.push(m.angle.join(', '));
  if (m.dutch) parts.push('dutch angle tilt');

  // Wardrobe
  const wardrobeLine = [...m.wardrobeChips, m.wardrobeText].filter(Boolean).join(', ');
  if (wardrobeLine) parts.push(wardrobeLine);

  // Condition
  if (m.condition) parts.push(m.condition);

  // Environment — now includes era asset descriptions, fixed 2026-07-11
  // (finding #2 above). Era inserted after location, before free env text,
  // matching MJ's existing ordering convention (chips -> assets -> free text).
  const envLine = [...m.envChips, ...m.locAssetDescs, ...m.eraAssetDescs, m.envText].filter(Boolean).join(', ');
  if (envLine) parts.push(envLine);

  // Time of day — DOM-label resolution stays local to MJ; buildPromptModel()
  // deliberately doesn't read the DOM (see its comment above).
  if (m.todRaw) {
    const todBtn = document.querySelector('#sf-tod-chips .sf-chip.active');
    parts.push(todBtn?.dataset.label || m.todRaw.split(' —')[0] || m.todRaw);
  }

  // Lighting
  if (m.lightingCombined.length) parts.push(m.lightingCombined.join(', '));

  // Mood
  if ([...m.mood, m.moodText].filter(Boolean).length) parts.push([...m.mood, m.moodText].filter(Boolean).join(', '));

  // Camera — aperture suffix stripped for MJ's terse/keyword style;
  // buildPromptModel() keeps the full descriptive string for the other
  // platforms (see its comment above).
  if (m.lens) parts.push(m.lens);
  if (m.aperture) parts.push(m.aperture.split(' —')[0]);
  if (m.camera) parts.push(m.camera);

  // Signature techniques
  if (m.sigs.length) parts.push(...m.sigs);

  // Auto-inject (amber)
  const autoStr = m.autoStr;

  // Quality (max 3) — MJ-specific cap; buildPromptModel() doesn't limit it.
  if (m.quality.length) parts.push(m.quality.slice(0, 3).join(', '));

  // Motion (MJ doesn't support, but note it) — m.motion intentionally never
  // read here, matching pre-migration behaviour exactly.

  // Style assets
  m.styleAssetDescs.forEach(d => parts.push(d));

  // Shot Setup — Single Frame port phase 2 (2026-07-10). Placed near the
  // end, same relative position as Storyboard's fallback/MJ branch
  // (buildPanelPrompt(), 06-scene-engine.js).
  if (m.shotSetupText) parts.push(m.shotSetupText);

  // Negatives
  const allNegs = [...m.negChips, ...m.eraNegatives];
  if (m.negText) allNegs.push(m.negText);
  if (allNegs.length) negParts.push(...allNegs);

  // Build prompt
  let prompt = parts.filter(Boolean).join(', ');
  if (autoStr) prompt = prompt + (prompt ? ', ' : '') + autoStr;

  // Parameters
  const ratio = m.ratio ? `--ar ${m.ratio.replace(':', '_').replace('_', ':')}` : '--ar 1:1';
  const params = `${ratio} --v 7 --style raw --stylize 250${negParts.length ? ' --no ' + negParts.join(', ') : ''}`;

  return { prompt, params, autoStr };
}

/* Migrated to consume buildPromptModel() (Fable audit item #6, third
   builder — 2026-07-04). Verified byte-identical against the pre-migration
   version across a 28-case matrix, same approach as buildGPTPrompt()
   (v7.10.6) and buildMJPrompt() (v7.11.2). Two more dead-code findings
   surfaced here, both simply omitted below — their removal has zero effect
   on output (logged alongside the MJ findings in future-features.md):
   1. `todBtnActive` — a DOM query (`document.querySelector('#sf-tod-chips
      .sf-chip.active')`) was computed but its result never read anywhere;
      NB's lighting line has always used the raw stored tod value directly.
      This actually confirms buildPromptModel()'s documented note that MJ is
      the only builder that reads the DOM label — NB just also had a
      leftover, never-used query call sitting next to the real logic.
   2. `ratioParam` (`sfState.ratio.replace(':','_')`) was computed but the
      actual params string builds its aspect_ratio from `sfState.ratio`
      directly, never from this variable. */
function buildNBPrompt(data) {
  const m = buildPromptModel(data);
  const sections = [];

  // Opening verb — subject-first, not housekeeping-first. sfState.genre
  // isn't part of the shared model (only this builder reads it) — kept local.
  const _openVerb = sfState.genre === 'mythology'  ? 'Render a devotional cinematic still'
                  : sfState.genre === 'fantasy'     ? 'Create an epic fantasy cinematic image'
                  : sfState.genre === 'street'      ? 'Depict a candid documentary photograph'
                  : sfState.genre === 'product'     ? 'Render a professional commercial product image'
                  : sfState.genre === 'illustrated' ? 'Create a hand-painted storybook illustration'
                  :                                   'Generate a photorealistic cinematic image';

  // Pull primary subject and location to embed in opening line — needs the
  // asset's .name, which the model's charAssetDescs/locAssetDescs (already
  // reduced to .desc strings) don't carry, so this stays a direct
  // data.assetDescs filter rather than the model fields.
  const _openChars = data.assetDescs.filter(a => a.type === 'character');
  const _openLocs  = data.assetDescs.filter(a => a.type === 'location');
  const _openSubjectParts = [
    _openChars.length ? _openChars[0].name : m.subjectText,
    _openLocs.length  ? 'at ' + _openLocs[0].name : ''
  ].filter(Boolean);
  const _openSubject = _openSubjectParts.length ? ' of ' + _openSubjectParts.join(', ') : '';

  sections.push(_openVerb + _openSubject + '.');

  // Step 1: Environment
  const envParts = [...m.envChips, m.envText, ...m.locAssetDescs, ...m.eraAssetDescs].filter(Boolean);
  if (envParts.length) sections.push('First, establish the environment: ' + envParts.join('. '));

  // Step 2: Subject
  const subjParts = [...m.subjectChips, m.subjectText, ...m.charAssetDescs].filter(Boolean);
  if (subjParts.length) sections.push('Then, place the subject: ' + subjParts.join('. '));

  // Wardrobe
  const wardrobeParts = [...m.wardrobeChips, m.wardrobeText, ...m.propAssetDescs].filter(Boolean);
  if (wardrobeParts.length) sections.push('Wardrobe and props: ' + wardrobeParts.join('. '));

  // Condition
  if (m.condition) sections.push('Material condition: ' + m.condition);

  // Frame + angle
  const frameDescs = { face: 'extreme close-up of the face only', head: 'head and shoulders portrait framing', waist: 'waist-up medium shot', fullbody: 'full body, feet included, full silhouette visible', wide: 'wide environmental shot establishing the full scene', os: 'over-the-shoulder shot', twoshot: 'two shot', threeshot: 'three shot', ecu: 'extreme close-up insert, macro detail' };
  const angleParts = [];
  if (m.frame) angleParts.push(frameDescs[m.frame]);
  if (m.angle.length) angleParts.push(m.angle.join(', ') + ' angle');
  if (m.dutch) angleParts.push('dutch angle tilt');
  if (angleParts.length) sections.push('Framing: ' + angleParts.join(', ') + '.');
  if (m.multiFigureComposition) sections.push('Composition: ' + m.multiFigureComposition);

  // Lighting — raw tod value, not a DOM label (see comment above).
  const lightParts = [];
  if (m.todRaw) lightParts.push(m.todRaw);
  if (m.lightingCombined.length) lightParts.push(m.lightingCombined.join(', '));
  if (lightParts.length) sections.push('Lighting: ' + lightParts.join('. ') + '.');

  // Camera — full descriptive strings, no MJ-style aperture stripping.
  const camParts = [];
  if (m.lens) camParts.push(m.lens);
  if (m.aperture) camParts.push(m.aperture);
  if (m.camera) camParts.push(m.camera);
  if (camParts.length) sections.push('Camera: ' + camParts.join(', ') + '.');

  // Mood
  const moodParts = [...m.mood, m.moodText].filter(Boolean);
  if (moodParts.length) sections.push('Mood and atmosphere: ' + moodParts.join(', ') + '.');

  // Signature techniques
  if (m.sigs.length) sections.push(m.sigs.join(' '));

  // Auto-inject
  const autoStr = m.autoStr;
  if (autoStr) sections.push('Also render with: ' + autoStr + '.');

  // Quality / style
  const qualParts = [...m.quality, ...m.styleAssetDescs].filter(Boolean);
  if (qualParts.length) sections.push('Render quality: ' + qualParts.join(', ') + '.');

  // Motion
  if (m.motion && m.motion.element) {
    const motParts = [`Motion element: ${m.motion.element}`];
    if (m.motion.type) motParts.push(`motion type: ${m.motion.type}`);
    if (m.motion.intensity) motParts.push(`intensity: ${m.motion.intensity}`);
    if (m.motion.duration) motParts.push(`duration: ${m.motion.duration}`);
    sections.push(motParts.join(', ') + '. All other elements remain static.');
  }

  // Shot Setup — Single Frame port phase 2 (2026-07-10). Same relative
  // position as Storyboard's nb branch (buildPanelPrompt(), 06-scene-engine.js).
  if (m.shotSetupText) sections.push(m.shotSetupText);

  // Negatives (semantic reframe preferred)
  const allNegs = [...m.negChips, ...m.eraNegatives];
  if (m.negText) allNegs.push(m.negText);
  if (allNegs.length) sections.push('Do not include: ' + allNegs.join('. Do not include ') + '.');

  // Params (API config note)
  const params = `aspect_ratio: "${m.ratio || '1:1'}" | resolution: "2K" | thinking: on`;

  return { prompt: sections.join('\n\n'), params, autoStr };
}

/* ── KLING IMAGE 3.0 OMNI ────────────────────────────────────
   Verified against Kling's own official quickstart guide
   (kling.ai/quickstart/klingai-image-3-omni-user-guide,
   published 2026-02-06) — see
   2026-06-24-image-reference-audit-and-platform-docs.md.

   Key differences from nb/gpt that this branch must honour:
   - No @Image1-style tag. Reference images are cited by plain
     ordinal phrasing INSIDE the prose ("the shirt from Image 3"),
     so character/prop reference notes are woven into the relevant
     section rather than appended as a separate bracketed hint.
   - Official examples consistently follow one implicit order:
     subject/action -> setting -> lighting -> camera angle ->
     depth of field/composition -> color/tone -> film quality.
     This function follows that order rather than nb's "step 1,
     step 2..." framing or gpt's all-caps section labels.
   - Still-image only — no motion section (see motionSupport:false
     in PLATFORM_TIPS.kling and checkPlatformMotionCompat()).
═══════════════════════════════════════════════════════════════ */
/* Migrated to consume buildPromptModel() (Fable audit item #6, fourth and
   final builder — 2026-07-04). Verified byte-identical against the
   pre-migration version across a 28-case matrix, same approach as the other
   three. No new dead-code findings here (unlike NB/MJ) — every local
   variable in the pre-migration version was actually used. Kling-specific
   choices preserved exactly, computed locally rather than folded into the
   shared model: no motion section at all (still-image only per Kling's own
   docs — m.motion intentionally never read here), depth-of-field order is
   aperture-then-lens (the OPPOSITE order NB/MJ use), and camera body is
   folded into the "Render quality" line rather than getting its own
   "Camera:" section like NB/MJ do. */
function buildKlingPrompt(data) {
  const m = buildPromptModel(data);
  const sections = [];

  // Subject + action — opening line, Kling's docs lead with this every time
  const subjParts = [...m.subjectChips, m.subjectText, ...m.charAssetDescs].filter(Boolean);
  if (subjParts.length) sections.push(subjParts.join('. ') + '.');

  // Wardrobe/props — cited by plain ordinal when they come from reference
  // images, per Kling's "the shirt from Image 3" convention. Library assets
  // here don't carry an actual image index in this app yet, so the name is
  // used as the referent (closest honest equivalent without faking a tag).
  const wardrobeParts = [...m.wardrobeChips, m.wardrobeText, ...m.propAssetDescs].filter(Boolean);
  if (wardrobeParts.length) sections.push('Wardrobe and props: ' + wardrobeParts.join('. ') + '.');
  if (m.condition) sections.push('Condition: ' + m.condition + '.');

  // Setting — second per the verified ordering
  const envParts = [...m.envChips, m.envText, ...m.locAssetDescs, ...m.eraAssetDescs].filter(Boolean);
  if (envParts.length) sections.push('The setting is ' + envParts.join('. ') + '.');

  // Lighting — third
  const lightParts = [];
  if (m.todRaw) lightParts.push(m.todRaw);
  if (m.lightingCombined.length) lightParts.push(m.lightingCombined.join(', '));
  if (lightParts.length) sections.push('Lighting: ' + lightParts.join(', ') + '.');

  // Camera angle / shot type — fourth
  const frameDescs = { face: 'extreme close-up', head: 'head-and-shoulders portrait shot', waist: 'waist-up medium shot', fullbody: 'full-body shot', wide: 'wide establishing shot', os: 'over-the-shoulder shot', twoshot: 'two shot', threeshot: 'three shot', ecu: 'extreme close-up insert' };
  const camAngleParts = [];
  if (m.frame) camAngleParts.push(frameDescs[m.frame]);
  if (m.angle.length) camAngleParts.push(m.angle.join(', ') + ' angle');
  if (m.dutch) camAngleParts.push('dutch angle tilt');
  if (camAngleParts.length) sections.push('The shot is a ' + camAngleParts.join(', ') + '.');
  if (m.multiFigureComposition) sections.push(m.multiFigureComposition);

  // Depth of field / composition — fifth. Order is aperture-then-lens here
  // (opposite of NB/MJ) — preserved exactly, not folded into a shared order.
  const dofParts = [];
  if (m.aperture) dofParts.push(m.aperture);
  if (m.lens) dofParts.push(m.lens);
  if (dofParts.length) sections.push('The camera angle has ' + dofParts.join(', ') + '.');

  // Color / tone — sixth
  const moodParts = [...m.mood, m.moodText].filter(Boolean);
  if (moodParts.length) sections.push('The scene has a ' + moodParts.join(', ') + ' tone.');

  // Signature techniques + style/film-quality descriptor — last, per docs'
  // recurring "shot on Kodak Vision film, tones of gray and black" closer.
  // Camera body is folded in here (not its own section, unlike NB/MJ).
  if (m.sigs.length) sections.push(m.sigs.join(' '));
  const qualParts = [...m.quality, ...m.styleAssetDescs].filter(Boolean);
  if (m.camera) qualParts.push(m.camera);
  if (qualParts.length) sections.push('Render quality: ' + qualParts.join(', ') + '.');

  // Auto-inject
  const autoStr = m.autoStr;
  if (autoStr) sections.push('Also include: ' + autoStr + '.');

  // Negatives — Kling's docs give no dedicated negative-prompt syntax;
  // fold into prose like nb does, since that matches the documented style.
  const allNegs = [...m.negChips, ...m.eraNegatives];
  if (m.negText) allNegs.push(m.negText);
  if (allNegs.length) sections.push('Do not include: ' + allNegs.join('. Do not include ') + '.');

  // Params — no documented character/word-count limit; aspect ratio +
  // resolution are the only platform-level params Kling's docs specify
  // (2K/4K output). No motion params here — still-image only.
  const params = `aspect_ratio: "${m.ratio || '1:1'}" | resolution: "2K"`;

  return { prompt: sections.join('\n\n'), params, autoStr };
}

function buildGPTPrompt(data) {
  const m = buildPromptModel(data);
  const lines = [];
  const autoStr = m.autoStr;

  // Scene / background
  const envParts = [...m.envChips, m.envText, ...m.locAssetDescs, ...m.eraAssetDescs].filter(Boolean);
  if (envParts.length) lines.push('SCENE: ' + envParts.join('. '));

  // Subject
  const subjParts = [...m.subjectChips, m.subjectText, ...m.charAssetDescs].filter(Boolean);
  if (subjParts.length) lines.push('SUBJECT: ' + subjParts.join('. '));

  // Frame
  const frameDescs = { face: 'extreme close-up, face fills the frame', head: 'head and shoulders portrait', waist: 'waist-up, medium shot', fullbody: 'full body visible, feet included', wide: 'wide shot, full environment', os: 'over-the-shoulder shot', twoshot: 'two shot', threeshot: 'three shot', ecu: 'extreme close-up insert, macro detail' };
  const frameParts = [];
  if (m.frame) frameParts.push(frameDescs[m.frame]);
  if (m.angle.length) frameParts.push(m.angle.join(', '));
  if (m.dutch) frameParts.push('dutch angle tilt');
  if (frameParts.length) lines.push('FRAMING: ' + frameParts.join(', '));
  if (m.multiFigureComposition) lines.push('COMPOSITION: ' + m.multiFigureComposition);

  // Key details
  const keyParts = [...m.wardrobeChips, m.wardrobeText, ...m.propAssetDescs].filter(Boolean);
  if (m.condition) keyParts.push('Condition: ' + m.condition);
  if (keyParts.length) lines.push('KEY DETAILS: ' + keyParts.join('. '));

  // Lighting
  const lightParts = [];
  if (m.todRaw) lightParts.push(m.todRaw);
  if (m.lightingCombined.length) lightParts.push(m.lightingCombined.join(', '));
  if (lightParts.length) lines.push('LIGHTING: ' + lightParts.join('. '));

  // Camera
  const camParts = [];
  if (m.lens) camParts.push(m.lens);
  if (m.aperture) camParts.push(m.aperture);
  if (m.camera) camParts.push(m.camera);
  if (camParts.length) lines.push('CAMERA: ' + camParts.join(', '));

  // Atmosphere / mood
  const moodParts = [...m.mood, m.moodText].filter(Boolean);
  if (moodParts.length) lines.push('ATMOSPHERE: ' + moodParts.join(', '));

  // Signature techniques
  if (m.sigs.length) lines.push('TECHNIQUE: ' + m.sigs.join(' '));

  // Auto-inject
  if (autoStr) lines.push('ALSO INCLUDE: ' + autoStr);

  // Style / quality
  const qualParts = [...m.quality, ...m.styleAssetDescs].filter(Boolean);
  if (qualParts.length) lines.push('RENDER QUALITY: ' + qualParts.join(', '));

  // Motion
  if (m.motion && m.motion.element) {
    const motParts = [`Motion element: ${m.motion.element}`];
    if (m.motion.type) motParts.push(`type: ${m.motion.type}`);
    if (m.motion.intensity) motParts.push(`intensity: ${m.motion.intensity}`);
    if (m.motion.duration) motParts.push(`duration: ${m.motion.duration}`);
    lines.push('MOTION: ' + motParts.join(', ') + '. Everything else static.');
  }

  // Shot Setup — Single Frame port phase 2 (2026-07-10). Same relative
  // position as Storyboard's gpt branch (buildPanelPrompt(), 06-scene-engine.js).
  if (m.shotSetupText) lines.push(m.shotSetupText);

  // Constraints + Negatives
  const allNegs = [...m.negChips, ...m.eraNegatives];
  if (m.negText) allNegs.push(m.negText);
  allNegs.push('no watermark', 'no extra text', 'no logos');
  lines.push('CONSTRAINTS: ' + allNegs.map(n => 'No ' + n.replace(/^no /i,'')).join('. ') + '.');

  // Size
  const sizeMap = { '16:9': '1536x1024', '9:16': '1024x1536', '1:1': '1024x1024', '4:5': '1024x1280', '3:2': '1536x1024', '2:3': '1024x1536' };
  const size = m.ratio ? sizeMap[m.ratio] || '1024x1024' : '1024x1024';
  const params = `size: ${size} | quality: medium`;

  return { prompt: lines.join('\n\n'), params, autoStr };
}

/* ── RICHNESS SCORE ──────────────────────────────────────── */
function calcRichness() {
  let score = 0;
  if (sfState.freeText.subject || (sfState.selections['subject-genre']||[]).length) score++;
  if (sfState.frame) score++;
  if (sfState.ratio) score++;
  if (getLightingCombined().length || sfState.selections.tod?.[0]) score++;
  const hasMood = (sfState.selections.mood||[]).length || sfState.freeText.mood;
  const hasCamera = (sfState.selections.lens||[]).length || sfState.selections.camera?.[0];
  const hasSig = Object.values(sfState.sigs).some(Boolean);
  const hasQuality = (sfState.selections.quality||[]).length;
  const hasAssets = Object.keys(sfState.selectedAssets).length > 0;
  if (hasMood || hasCamera || hasSig || hasQuality || hasAssets) score++;
  return Math.min(score, 5);
}

function renderRichness(score) {
  document.querySelectorAll('.sf-dot').forEach((d, i) => {
    d.classList.toggle('active', i < score);
  });
  const label = document.getElementById('sf-richness-text');
  if (label) label.textContent = RICHNESS_LABELS[score - 1] || 'Minimal';
}

/* ── MASTER UPDATE ───────────────────────────────────────── */
function updatePrompt() {
  const box = document.getElementById('sf-prompt-box');
  const paramsBox = document.getElementById('sf-params-box');
  const paramsVal = document.getElementById('sf-params-value');
  const autoDetailVal = document.getElementById('sf-auto-detail-value');
  if (!box) return;

  const data = collectSFData();
  // Shot Setup Single Frame port, phase 1 — keep the "Camera faces" dropdown
  // in sync with whatever caused this rebuild (chip toggle, @mention edit).
  if (typeof refreshSFCameraFacingDropdown === 'function') refreshSFCameraFacingDropdown();

  let result;
  if (sfState.platform === 'mj') result = buildMJPrompt(data);
  else if (sfState.platform === 'nb') result = buildNBPrompt(data);
  else if (sfState.platform === 'kling') result = buildKlingPrompt(data);
  else result = buildGPTPrompt(data);

  const saveSeqBtn = document.getElementById('sf-save-seq-btn');
  if (!result.prompt.trim()) {
    box.innerHTML = '<div class="sf-prompt-empty">Select options on the left to build your prompt.</div>';
    if (paramsBox) paramsBox.style.display = 'none';
    if (saveSeqBtn) saveSeqBtn.style.display = 'none';
  } else {
    if (saveSeqBtn) saveSeqBtn.style.display = '';
    // Show prompt, highlight auto-injected parts
    let display = escHtml(result.prompt);
    if (result.autoStr) {
      const escapedAuto = escHtml(result.autoStr);
      display = display.replace(escapedAuto, `<span class="sf-prompt-auto">${escapedAuto}</span>`);
    }
    box.innerHTML = display;
    if (paramsBox && result.params) {
      paramsBox.style.display = '';
      if (paramsVal) paramsVal.textContent = result.params;
    }
  }

  // Auto-detail
  if (autoDetailVal && result.autoStr) {
    autoDetailVal.textContent = result.autoStr;
  }

  // Richness
  renderRichness(calcRichness());
}

/* ── COPY PROMPT ─────────────────────────────────────────── */
function copyPrompt() {
  const box = document.getElementById('sf-prompt-box');
  const paramsVal = document.getElementById('sf-params-value');
  if (!box) return;
  const text = box.innerText;
  if (!text || text.includes('Select options')) {
    showToast('Build a prompt first', 'warning');
    return;
  }
  const params = paramsVal ? '\n\n' + paramsVal.textContent : '';
  copyToClipboard(text + params, 'Prompt copied to clipboard');
}

/* ── RESTORE SF STATE FROM SHOT ──────────────────────────── */
function restoreSFFromShot(meta) {
  const snap = meta.sfSnapshot;
  if (!snap) {
    showToast('No settings snapshot in this shot', 'warning');
    return;
  }

  // Restore all sfState fields from snapshot
  sfState.outputType      = snap.outputType      || 'still';
  sfState.platform        = snap.platform        || 'nb';
  sfState.genre           = snap.genre           || null;
  sfState.frame           = snap.frame           || null;
  sfState.ratio           = snap.ratio           || null;
  sfState.dutch           = snap.dutch           || false;
  sfState.showAutoDetail  = false;
  sfState.selectedAssets  = snap.selectedAssets  ? { ...snap.selectedAssets } : {};
  sfState.selectedAssetOrder = Array.isArray(snap.selectedAssetOrder) ? [...snap.selectedAssetOrder] : Object.keys(sfState.selectedAssets);
  sfState.freeText        = snap.freeText        ? { ...snap.freeText }       : { subject: '', wardrobe: '', env: '', mood: '', neg: '' };
  sfState.sigs            = snap.sigs            ? { ...snap.sigs }           : {};

  // Deep copy selections arrays
  sfState.selections = {};
  const selKeys = ['angle','lighting-setup','lighting-natural','tod','lens','aperture','camera','mood','quality','neg',
                   'condition','motion-element','motion-type','motion-intensity','motion-duration'];
  selKeys.forEach(k => {
    sfState.selections[k] = Array.isArray(snap.selections?.[k]) ? [...snap.selections[k]] : [];
  });

  // Re-render the Single Frame UI
  if (typeof initSingleFrame === 'function') initSingleFrame();
  if (typeof sfBindTextInputs === 'function') sfBindTextInputs();
  restoreSFChipSelections();
  restoreSFMiscToggles();
  restoreSFFrameAndRatio();
  restoreSFFreeText();
  renderSFRoleOrderHint();
  renderSFOSSideControl();
  renderAngleRedundancyGuard();
  if (typeof updatePrompt === 'function') updatePrompt();
}

/* ── REAPPLY FREE-TEXT FIELDS (SUBJECT/WARDROBE/ENV/MOOD/NEG) ─
   sfState.freeText is restored above directly from the snapshot,
   but nothing pushes those values into the actual textarea DOM
   elements — sfBindTextInputs() only listens for input events
   (DOM → state), it never syncs state → DOM. Same root cause as
   restoreSFChipSelections/restoreSFFrameAndRatio: a programmatic
   restore (loading a saved Sequence shot) updates sfState but the
   textareas keep showing whatever was last typed in the browser,
   including @-mention text like "@bird". ─────────────────────── */
function restoreSFFreeText() {
  const fields = [
    ['sf-subject-text', 'subject'],
    ['sf-wardrobe-text', 'wardrobe'],
    ['sf-env-text', 'env'],
    ['sf-mood-text', 'mood'],
    ['sf-neg-text', 'neg']
  ];
  fields.forEach(([id, key]) => {
    const el = document.getElementById(id);
    if (el) el.value = sfState.freeText[key] || '';
  });
}

/* ── REAPPLY FRAME SIZE / ASPECT RATIO CARD SELECTION ────────
   Like the static chips, .sf-frame-card and .sf-ratio-card only
   get their "active" class via setSFFrame()/setSFRatio() on a
   direct click — nothing re-syncs them from sfState on a
   programmatic restore. ─────────────────────────────────────── */
function restoreSFFrameAndRatio() {
  document.querySelectorAll('.sf-frame-card').forEach(b => {
    b.classList.toggle('active', b.dataset.val === sfState.frame);
  });
  document.querySelectorAll('.sf-ratio-card').forEach(b => {
    b.classList.toggle('active', b.dataset.val === sfState.ratio);
  });
}

/* ── REAPPLY CHIP .active STATE FROM sfState.selections ──────
   The static chip groups (angle, lighting, tod, lens, aperture,
   camera, mood, quality, neg, condition, motion-*) are hardcoded
   buttons in the HTML — they only get their "active" class via a
   direct click through toggleSFChip(). initSingleFrame() does not
   re-render them, so after a programmatic restore (e.g. loading a
   saved Sequence shot) sfState.selections is correct but the chip
   buttons still show whatever was last clicked in the browser.
   This walks every static chip button and syncs .active to match
   sfState.selections[group]. ────────────────────────────────── */
function restoreSFChipSelections() {
  const groups = ['angle','lighting-setup','lighting-natural','tod','lens','aperture','camera','mood','quality','neg',
                   'condition','motion-element','motion-type','motion-intensity','motion-duration'];
  groups.forEach(group => {
    const selected = sfState.selections[group] || [];
    document.querySelectorAll(`.sf-chip[data-val][onclick*="'${group}'"]`).forEach(btn => {
      const val = btn.dataset.val;
      btn.classList.toggle('active', selected.includes(val));
    });
  });

  // Dutch angle is a standalone toggle, not part of the 'angle' selections array
  const dutchBtn = document.getElementById('sf-dutch-angle-chip');
  if (dutchBtn) dutchBtn.classList.toggle('active', !!sfState.dutch);
}

/* ── REAPPLY OUTPUT TYPE / SIGNATURE TOGGLES FROM sfState ───── */
function restoreSFMiscToggles() {
  document.querySelectorAll('#sf-output-type .sf-toggle').forEach(b => {
    b.classList.toggle('active', b.dataset.val === sfState.outputType);
  });
  const motionLayer = document.getElementById('sf-motion-layer');
  if (motionLayer) motionLayer.style.display = sfState.outputType === 'motion' ? '' : 'none';
  if (typeof checkPlatformMotionCompat === 'function') checkPlatformMotionCompat();

  Object.keys(sfState.sigs || {}).forEach(key => {
    const input = document.getElementById('sig-' + key);
    if (input) input.checked = !!sfState.sigs[key];
  });
}

/* ── SAVE TO SEQUENCE ────────────────────────────────────── */
function sfSaveToSequence() {
  const box = document.getElementById('sf-prompt-box');
  if (!box) return;
  const text = box.innerText;
  if (!text || text.includes('Select options')) {
    showToast('Build a prompt first', 'warning');
    return;
  }
  // Save full sfState snapshot so Load can restore everything
  openSaveToSequenceModal(text.trim(), {
    source: 'single_frame',
    sfSnapshot: JSON.parse(JSON.stringify(sfState))
  });
}

