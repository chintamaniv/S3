
/* ── CONSTANTS ─────────────────────────────────────────────── */
const STORAGE_KEY = 'S3_v7';
const ASSET_TYPES = ['character','location','prop','era','style'];
const TYPE_LABELS = {
  character: 'Character',
  location:  'Location',
  prop:      'Prop',
  era:       'Era & Context',
  style:     'Background Style'
};
const TYPE_ICONS = {
  character: '👤',
  location:  '🏛',
  prop:      '🗡',
  era:       '📜',
  style:     '🎨'
};
const TYPE_HINTS = {
  character: 'Core visual identity — what makes this character instantly recognisable at a glance. Physical appearance, build, face, hair. Keep it to what a camera would see.',
  location:  'Core visual identity — what would a camera see the moment it faces this place. Architecture, ground, key landmarks, immediate atmosphere.',
  prop:      'Core visual identity — what the object looks like, its size, surface, and condition. What a camera would see in a close-up.',
  era:       'Core period identity — the material world of this time and place. What surfaces, fabrics, and objects define it visually.',
  style:     'Core render identity — the visual language, artistic movement, and rendering approach for this style.'
};
// Fields below Description are SMART INJECTION fields — the app uses them selectively
// based on shot scale and context. They do NOT need to repeat what is in Description.
const TYPE_FIELD_NOTES = {
  character: 'The app injects costume on wide shots, expression on close-ups, era for period negatives — only when relevant.',
  location:  'The app injects period and atmosphere based on shot scale and context.',
  prop:      'The app injects material and condition selectively based on whether the prop is foregrounded.',
  era:       'Negatives from this field auto-inject into every prompt that uses this era.',
  style:     ''
};

/* ── SHARED LIBRARY (Location/Prop/Era/Style — cross-user, cross-project) ──
   Character stays project-scoped exactly as before. These four types live
   in a shared store on the server (userdata/_shared/library/{type}/) and
   are linked into a project via project.linkedAssets[type] = [assetId,...].
   Pattern mirrors _customChipsCache in 07-settings.js: in-memory cache,
   write-through to server, fall back gracefully on apiCall() === null. ── */
const SHARED_LIBRARY_TYPES = ['location', 'prop', 'era', 'style'];
let _libraryCache = { location: [], prop: [], era: [], style: [] };

// Fable audit H4 root-cause fix (2026-07-08, api.php's load_library_assets/
// get_library_assets_full — see the comment block above library_dir() there
// for the full story). _libraryCache entries above now carry METADATA +
// small THUMBNAILS only — never a whole type's full-resolution photos in
// one response, which is what was pegging Safari's CPU editing a Location.
// Real, full-resolution images (asset.images[slot]) are fetched on demand,
// only for the exact asset(s) actually needed, and cached here so a given
// asset is only ever fully fetched once per session.
let _libraryFullCache = { location: {}, prop: {}, era: {}, style: {} };

// Normalise a shared-library asset the same way for every entry point (full
// list load, or a single patched-in record) — ensures images/imageAnalysis
// always exist so the card/grid/picker UI can rely on them unconditionally.
function _normalizeLibraryAsset(a) {
  if (!a.images) {
    a.images = defaultImageSlots(a.type);
    if (a.image_data) {
      const firstSlot = Object.keys(a.images)[0];
      if (firstSlot) a.images[firstSlot] = a.image_data;
    }
  }
  // Fable audit H4 root-cause fix (2026-07-08): legacy single-image assets'
  // list-response thumbnail (api.php's 'thumbnail', singular — distinct
  // from the multi-slot 'thumbnails' the current client actually writes)
  // folds into the same shape getCardThumbnail() reads, so a pre-multi-slot
  // asset's grid card still shows something instead of going blank.
  if (!a.thumbnails && a.thumbnail) {
    const firstSlot = Object.keys(defaultImageSlots(a.type))[0] || 'legacy';
    a.thumbnails = { [firstSlot]: a.thumbnail };
  }
  if (!a.imageAnalysis) a.imageAnalysis = {};
  return a;
}

async function loadLibraryAssets(type) {
  if (!SHARED_LIBRARY_TYPES.includes(type)) return [];
  if (typeof apiCall !== 'function') return _libraryCache[type] || [];
  const res = await apiCall('load_library_assets', { type });
  if (!res || !Array.isArray(res.assets)) {
    // apiCall failed or returned unexpected shape — keep whatever we had cached
    return _libraryCache[type] || [];
  }
  res.assets.forEach(_normalizeLibraryAsset);
  _libraryCache[type] = res.assets;
  return res.assets;
}

// Patches (or inserts) ONE asset into _libraryCache[type] from a save
// response, instead of refetching the type's entire asset list (Fable audit
// H1, 2026-07-08-fable-review-freeze-and-automation-audit.md). The v7.15.7
// session-cache fix stopped tab clicks from re-downloading every asset's
// every photo on every click, but the save/delete paths still called
// loadLibraryAssets(type) afterward — the same 40-113MB response, parsed on
// the main thread, every single save. The server's save response already
// contains the full saved record (res.asset), so no refetch is needed.
function _patchLibraryCache(type, asset) {
  _normalizeLibraryAsset(asset);
  const list = _libraryCache[type] || (_libraryCache[type] = []);
  const idx = list.findIndex(a => a.id === asset.id);
  if (idx >= 0) list[idx] = asset; else list.unshift(asset);
}

function _removeLibraryCacheEntry(type, id) {
  const list = _libraryCache[type];
  if (list) {
    const idx = list.findIndex(a => a.id === id);
    if (idx >= 0) list.splice(idx, 1);
  }
  // Fable audit H4 root-cause fix (2026-07-08) — drop the full-resolution
  // cache entry too, so a deleted-then-recreated asset with a reused id
  // (shouldn't normally happen, ids are random, but cheap insurance) can't
  // ever surface stale image data from _libraryFullCache.
  if (_libraryFullCache[type]) delete _libraryFullCache[type][id];
}

/* Tracks whether a one-time warm-up of all 4 shared library caches has
   been kicked off this session, so repeated calls (e.g. switching between
   Single Frame and Storyboard) don't re-fetch every time. */
let _libraryCachesWarmed = false;

/* Per-type "loaded at least once this session" flags (2026-07-08,
   testing-checklist.md §6 real root cause). Real incident: switchAssetType()
   (below) previously called loadLibraryAssets(type) UNCONDITIONALLY every
   time a shared-library tab (Location/Prop/Era/Style) was clicked — no
   caching, no dedup. A live Network-tab capture showed this re-downloading
   the ENTIRE type's asset list, every photo included, from scratch on every
   click: single api.php responses of 113.6MB and 41.28MB, several repeated,
   499.1MB transferred in one session. Parsing each giant JSON response back
   on the main thread (an atomic cost Safari's profiler can't break into
   named functions — shows only as an unattributed "Script Evaluated" block)
   is what actually froze the UI for minutes at a time — not any of the
   three earlier client-render/focus theories (v7.15.4/5/6), which were
   real but secondary. This flag lets both entry points (the warm-up below
   and switchAssetType()) share one source of truth for "do we already have
   this type's data," so a tab click after warm-up — or a second click on
   the same tab — reuses _libraryCache instead of re-fetching. Save flows
   (saveSharedLibraryAsset()) call loadLibraryAssets() directly and are
   unaffected — they still always get fresh data after a save. */
let _libraryTypeLoadedThisSession = { location: false, prop: false, era: false, style: false };

/* Ensures all SHARED_LIBRARY_TYPES caches are populated before any picker
   or @-mention system reads getEffectiveAssets(). Without this, props/
   locations/eras/styles linked to a project would silently be missing
   from pickers until the user happened to visit the Library tab for that
   type first (which is what populates _libraryCache via loadLibraryAssets).
   Call this from view-init functions (Single Frame, Storyboard) — it's
   safe to call repeatedly and a no-op after the first successful warm-up. */
async function ensureLibraryCachesLoaded() {
  if (!_libraryCachesWarmed) {
    await Promise.all(SHARED_LIBRARY_TYPES.map(type => loadLibraryAssets(type)));
    SHARED_LIBRARY_TYPES.forEach(type => { _libraryTypeLoadedThisSession[type] = true; });
    _libraryCachesWarmed = true;
  }
  // Fable audit H4 root-cause fix (2026-07-08) — the list warm-up above now
  // only ever brings in thumbnails (see api.php). getEffectiveAssets() (and
  // everything that reads it — Reference Panel, Storyboard/Single Frame
  // reference strips, @ mention image resolution) needs REAL images for
  // whichever shared assets are actually linked into the CURRENT project.
  // Runs every call (not gated by _libraryCachesWarmed) so switching to a
  // different project later in the same session still gets that project's
  // own linked assets fully loaded — see ensureLinkedLibraryImagesLoaded()'s
  // own per-project guard below for why this is still cheap to call often.
  await ensureLinkedLibraryImagesLoaded();
}

// Fetches full-resolution images for exactly the given asset ids (never a
// whole type's list) and caches them in _libraryFullCache, then patches
// _libraryCache too so any code still reading from there directly (e.g. the
// asset that's currently open in the edit modal) sees the real images.
// Skips ids already cached — an asset is only ever fully fetched once per
// session. Safe to call with an empty/undefined ids array (no-op).
//
// Chunked, 2026-07-08 (live retest after v7.15.12 still froze, CPU-bound,
// no oversized network entry visible at the moment of the freeze — pointing
// at ensureLinkedLibraryImagesLoaded() batching EVERY linked asset's real
// photos into one single get_library_assets_full response, e.g. all 8 of a
// project's Locations at once. That's the exact same disease load_library_
// assets was fixed for — a big batch of real photos parsed synchronously —
// just reintroduced at a different call site by this same day's earlier
// fix. Capping how many assets one request can ever bundle means no single
// response can carry more than a couple of real, unresized photos no
// matter how many total assets a project has linked or how large this
// account grows — and the `await` between chunks hands control back to the
// browser between each one, so even fetching many assets in sequence never
// blocks the page for one long unbroken stretch the way one giant request
// would.
// In-flight fetch tracker, keyed 'type:id' -> the Promise currently fetching
// that id. Fable-review fix (2026-07-10), CRITICAL finding: fetchAssetImageOnReference()
// (below) fires on every keystroke in Storyboard's beat textarea and Single
// Frame's Subject/Environment fields (undebounced by design elsewhere in
// this app), so without this, mentioning one heavy asset mid-sentence could
// launch dozens of duplicate parallel get_library_assets_full requests for
// the SAME id while the first is still in flight — recreating the exact
// 142MB-class problem this whole linkedAssets fix exists to solve, just
// triggered by typing instead of project load. Deleted once a fetch settles
// (success OR failure) so a later, genuinely fresh fetch for the same id
// isn't blocked forever by a stale entry.
const _libraryFullFetchInFlight = {};

async function fetchFullLibraryAssets(type, ids) {
  if (!SHARED_LIBRARY_TYPES.includes(type) || !ids || !ids.length) return;
  const need = ids.filter(id => id && !_libraryFullCache[type][id]);
  if (need.length === 0) return;

  // Ids already being fetched by another in-flight call join that call's
  // promise instead of issuing a duplicate request; genuinely new ids get
  // batched into this call's own request below.
  const toAwait = [];
  const toFetch = [];
  need.forEach(id => {
    const key = type + ':' + id;
    if (_libraryFullFetchInFlight[key]) toAwait.push(_libraryFullFetchInFlight[key]);
    else toFetch.push(id);
  });

  let ownPromise = null;
  if (toFetch.length) {
    ownPromise = (async () => {
      const CHUNK_SIZE = 2;
      for (let i = 0; i < toFetch.length; i += CHUNK_SIZE) {
        const chunk = toFetch.slice(i, i + CHUNK_SIZE);
        const res = await apiCall('get_library_assets_full', { type, ids: chunk });
        if (!res || !Array.isArray(res.assets)) continue;
        res.assets.forEach(a => {
          _normalizeLibraryAsset(a);
          _libraryFullCache[type][a.id] = a;
          _patchLibraryCache(type, a);
        });
      }
    })();
    toFetch.forEach(id => { _libraryFullFetchInFlight[type + ':' + id] = ownPromise; });
    ownPromise.finally(() => {
      toFetch.forEach(id => { delete _libraryFullFetchInFlight[type + ':' + id]; });
    });
  }

  await Promise.all([...toAwait, ownPromise].filter(Boolean));
}

function getFullLibraryAsset(type, id) {
  return (_libraryFullCache[type] && _libraryFullCache[type][id]) || null;
}

// Which linked shared-library asset ids are actually REFERENCED by this
// project's SAVED content, as opposed to merely linked (available in
// pickers/mention lists). Root-cause fix (2026-07-10) for the "142MB / ~1
// minute lag on first load" problem this session traced to JanaBai/DNY-Meet
// — see future-features.md's "linkedAssets has no 'belongs to project' vs
// 'prefetch now' distinction" entry for the full design discussion.
//
// Scoped to Shot Setups ONLY (setup.locationId + setup.objects[].assetId)
// on purpose: it's the one piece of project content with clean, persisted,
// ID-based asset references. Storyboard panel beats and Single Frame's
// selections/@-mentions are NOT server-persisted at all (no autosave — see
// development-practices.md §5, "Save to Sequence" is the only thing that
// survives a reload) and Sequences persist the already-RESOLVED prompt
// text, not structured ids — neither can be scanned at load time. That gap
// is covered by a different mechanism instead: fetchAssetImageOnReference()
// below, called the moment something is actually chip-selected/@-mentioned/
// Shot-Setup-linked live, mirroring toggleProjectAssetLink()'s existing
// "fetch right away, fire-and-forget" pattern for a freshly-linked asset.
//
// A project with zero Shot Setups yet returns an empty set here — nothing
// extra loads on that project's first open beyond what's already
// individually referenced from a prior session (nothing, for a truly fresh
// project). That's intentional, not a regression: before this fix, EVERY
// linked asset's full image loaded on every open regardless of use: that's
// what caused the original 142MB pull. Now the cost is spread out, arriving
// as things are actually referenced, instead of paid all at once up front.
function computeShotSetupReferencedAssetIds() {
  const ids = new Set();
  if (typeof shotSetupState === 'undefined' || !shotSetupState.setups) return ids;
  Object.values(shotSetupState.setups).forEach(setup => {
    if (setup.locationId) ids.add(setup.locationId);
    (setup.objects || []).forEach(o => { if (o.assetId) ids.add(o.assetId); });
  });
  return ids;
}

// Fire-and-forget full-image fetch for a single shared-library asset the
// moment it's actually referenced live — chip-selected, @-mentioned, or
// linked into a Shot Setup object/location. Added 2026-07-10 alongside the
// load-time prefetch narrowing above (computeShotSetupReferencedAssetIds())
// — see that comment for the full picture of why both mechanisms exist
// together. A missing reference image is already a gracefully-handled state
// everywhere in this app ("no reference image — text only"), so most
// callers don't need to await this — but it RETURNS the underlying promise
// (Fable-review fix, 2026-07-10) so a caller whose UI depends on the image
// actually arriving (e.g. Reference Panel's rows, which filter out any row
// with no `img` yet — see buildReferencePanelRows()/inlineReferenceStripInnerHTML(),
// 11-reference-panel.js) CAN chain a re-render once it lands, instead of
// that row silently staying empty until some unrelated re-render happens
// to occur. No-op (returns null) for 'character' (project-owned, not a
// SHARED_LIBRARY_TYPES entry — already has its real image) and for ids
// fetchFullLibraryAssets() already has cached (resolves near-instantly).
// Checks the cache BEFORE calling fetchFullLibraryAssets, and returns null
// immediately for an id that's already cached — not just "no fetch needed"
// but specifically so a caller chaining .then() on the returned promise
// only does so for a GENUINELY new fetch. Without this pre-check, a caller
// like refreshReferencePanelIfOpen() (11-reference-panel.js) — which
// rebuilds rows by calling this same function again for every mention —
// would re-trigger its own refresh on every already-resolved cache-hit
// promise, an infinite render loop (each refresh rebuilds rows, which
// re-fetches — now a cache hit — which still resolves and re-chains
// another refresh, forever). Checking the cache first means the SECOND
// generation of calls (triggered by that refresh's own rebuild, after the
// first fetch already landed) all return null immediately, breaking the
// cycle after exactly one real refresh.
function fetchAssetImageOnReference(type, id) {
  if (!id || !SHARED_LIBRARY_TYPES.includes(type)) return null;
  if (_libraryFullCache[type] && _libraryFullCache[type][id]) return null;
  if (typeof fetchFullLibraryAssets !== 'function') return null;
  return fetchFullLibraryAssets(type, [id]);
}

// Ensures the ACTIVE project's ACTIVELY-REFERENCED shared-library assets
// (see computeShotSetupReferencedAssetIds() above — narrowed from "every
// linked asset" 2026-07-10) have real, full-resolution images loaded, not
// just thumbnails. Keyed to the project id so re-entering an already-
// ensured project this session is a cheap no-op, while switching to a
// different project re-triggers it.
let _linkedImagesEnsuredForProject = null;
async function ensureLinkedLibraryImagesLoaded() {
  const p = getCurrentProject();
  if (!p) return;
  if (_linkedImagesEnsuredForProject === p.id) return;

  // Shot Setup data must be loaded before it can narrow the prefetch scope.
  // Guarded both by typeof (14-shot-setup.js loads after this file in
  // script order — see dist/ss_studioV7.html) and try/catch (a failed
  // fetch here should degrade to "no Shot Setup references known yet", not
  // block project loading entirely).
  if (typeof ensureShotSetupsLoaded === 'function') {
    try { await ensureShotSetupsLoaded(); } catch (e) { /* non-fatal — see shotSetupsOk below for why this doesn't also poison the ensured flag */ }
  }
  const referencedIds = computeShotSetupReferencedAssetIds();

  await Promise.all(SHARED_LIBRARY_TYPES.map(type => {
    const linkedIds = (p.linkedAssets && p.linkedAssets[type]) || [];
    const ids = linkedIds.filter(id => referencedIds.has(id));
    return fetchFullLibraryAssets(type, ids);
  }));

  // Fable-review fix (2026-07-10), MODERATE finding: only mark this project
  // "ensured" if Shot Setup data actually loaded for it (or the feature
  // isn't present at all — nothing to wait on, not a failure). Previously
  // this flag was set unconditionally, so a single transient
  // load_shot_setups failure at project-open permanently skipped any
  // prefetch retry for the rest of the session — reference images would
  // silently stay missing with no way to recover short of a full reload.
  // shotSetupState.loadedForProject is only ever set on a SUCCESSFUL
  // loadShotSetups() (14-shot-setup.js) — see that function's own early
  // return on a falsy apiCall() response.
  const shotSetupsOk = (typeof ensureShotSetupsLoaded !== 'function')
    || (typeof shotSetupState === 'undefined')
    || (shotSetupState.loadedForProject === p.id);
  if (shotSetupsOk) _linkedImagesEnsuredForProject = p.id;
}

/* Returns the shared-library assets of `type` that are linked into the
   current project (i.e. what should show up in pickers/mention lists). */
function getLinkedLibraryAssets(type) {
  const p = getCurrentProject();
  if (!p) return [];
  const linkedIds = (p.linkedAssets && p.linkedAssets[type]) || [];
  if (!linkedIds.length) return [];
  const pool = _libraryCache[type] || [];
  return pool.filter(a => linkedIds.includes(a.id));
}

/* Effective "assets" view used by pickers/mentions that historically read
   getCurrentProject().assets as one flat dict mixing every type together
   (Single Frame asset selector, @ mention system). Characters come from
   the project as before; the 4 shared types come from the linked subset
   of the shared library cache. Keyed by id, same shape as project.assets. */
function getEffectiveAssets() {
  const p = getCurrentProject();
  if (!p) return {};
  const out = {};
  Object.values(p.assets || {}).forEach(a => {
    if (a.type === 'character') out[a.id] = a;
  });
  SHARED_LIBRARY_TYPES.forEach(type => {
    getLinkedLibraryAssets(type).forEach(a => { out[a.id] = a; });
  });
  return out;
}

/* One-time idempotent migration trigger (button in Library view). */
async function runLibraryMigration() {
  const btn = document.getElementById('migrate-library-btn');
  if (btn) { btn.disabled = true; btn.textContent = 'Migrating…'; }
  const res = await apiCall('migrate_library');
  if (btn) { btn.disabled = false; btn.textContent = 'Migrate existing assets to shared library'; }
  if (!res) {
    showToast('Migration failed — check server connection', 'error');
    return;
  }
  showToast(`Migrated ${res.migrated} asset${res.migrated === 1 ? '' : 's'} across ${res.users_scanned} user${res.users_scanned === 1 ? '' : 's'}`, 'success');
  // Refresh whatever shared type is currently active, and the current project's
  // linkedAssets (migration may have added links server-side).
  const type = getCurrentType();
  if (SHARED_LIBRARY_TYPES.includes(type)) {
    await loadLibraryAssets(type);
  }
  renderAll();
}

/* One-time idempotent cleanup trigger (button in Library view). Merges
   shared-library records that share an exact name down to one canonical
   record, re-points project links, and deletes the extras. */
async function runLibraryDedupe() {
  const btn = document.getElementById('dedupe-library-btn');
  if (btn) { btn.disabled = true; btn.textContent = 'Cleaning up…'; }
  const res = await apiCall('dedupe_library');
  if (btn) { btn.disabled = false; btn.textContent = 'Clean up duplicate assets'; }
  if (!res) {
    showToast('Cleanup failed — check server connection', 'error');
    return;
  }
  showToast(
    `Removed ${res.records_removed} duplicate${res.records_removed === 1 ? '' : 's'} across ${res.duplicate_groups} asset${res.duplicate_groups === 1 ? '' : 's'} (${res.projects_updated} project${res.projects_updated === 1 ? '' : 's'} re-linked)`,
    'success'
  );
  const type = getCurrentType();
  if (SHARED_LIBRARY_TYPES.includes(type)) {
    await loadLibraryAssets(type);
  }
  renderAll();
}

/* ── STATE ─────────────────────────────────────────────────── */
let state = {
  projects: {},      // { id: { name, created, assets: { id: asset } } }
  activeProject: null,
  activeAssetType: 'character'
};
let editingAssetId = null;
// True once the currently-open shared-library asset's REAL images have
// finished loading (Fable audit H4 root-cause fix, 2026-07-08) — see
// openAssetModal()/saveAssetNow(). Always true for character assets and for
// "Add new" (nothing to fetch in either case), so it only ever gates the
// narrow shared-library-edit-in-flight window.
let editingAssetImagesReady = true;

/* ── IMAGE SLOT DEFINITIONS ─────────────────────────────────── */
const IMAGE_SLOTS = {
  character: [
    { key: 'closeup',  label: 'Close-up',        hint: 'Face, expression, skin detail' },
    { key: 'midshot',  label: 'Mid Shot',         hint: 'Waist-up, costume, gesture' },
    { key: 'fullbody', label: 'Full Body',        hint: 'Complete figure, stance, footwear' },
    { key: 'sheet',    label: 'Character Sheet',  hint: 'Multiple angles or expression set' }
  ],
  location: [
    { key: 'wide',   label: 'Wide / Establishing', hint: 'Full environment, establishing view' },
    { key: 'detail', label: 'Detail / Texture',    hint: 'Surface, material, atmosphere close-up' }
  ],
  prop: [
    { key: 'full',   label: 'Full View',   hint: 'Complete prop, scale reference' },
    { key: 'detail', label: 'Detail',      hint: 'Material, texture, condition close-up' }
  ],
  era: [
    { key: 'reference', label: 'Period Reference', hint: 'Visual reference for this era' }
  ],
  style: [] // no image slots for style
};

function defaultImageSlots(type) {
  const slots = IMAGE_SLOTS[type] || [];
  const obj = {};
  slots.forEach(s => { obj[s.key] = null; });
  return obj;
}

/* ── GET PRIMARY IMAGE (for card thumb + cref) ───────────────── */
// Returns first non-null image from an asset's slots
function getPrimaryImage(asset) {
  if (!asset.images) return null;
  for (const val of Object.values(asset.images)) {
    if (val) return val;
  }
  return null;
}

// Fable audit H4 root-cause fix (2026-07-08) — for the Library GRID CARD
// only. Deliberately separate from getPrimaryImage() above: that function
// feeds getImageForShot()/getImagesForShot(), i.e. REAL reference-image
// resolution for prompts/downloads/zips, which must only ever see actual
// full-resolution images, never a thumbnail substitute. A grid card just
// needs something recognisable at ~48px, so this prefers the small
// thumbnail the list load already carries (see api.php) and only falls
// back to a real image if one happens to already be cached (e.g. this
// asset was just edited this session, so its full data is already in
// memory) — never triggers a fetch itself.
function getCardThumbnail(asset) {
  if (asset.thumbnails) {
    for (const val of Object.values(asset.thumbnails)) {
      if (val) return val;
    }
  }
  return getPrimaryImage(asset);
}

/* ── CANONICAL SHOT-TYPE PRIORITY TABLE (unified 2026-07-04, Fable audit
   Area 1A follow-up) ────────────────────────────────────────────────
   getImageForShot(), getImagesForShot() and resolveSlotUsed()
   (11-reference-panel.js) used to each hand-copy the same "which
   substring means what" if/else chain — the exact duplication behind
   the "closing"/"os"/location-fallback bugs fixed 2026-06-27..07-03.
   All three now read from this one table instead of re-deriving it, so
   a fix to one can no longer silently miss the others.

   Verified against the pre-existing (pre-unification) behavior with a
   1400-case before/after matrix before this replaced the old code. Two
   small, deliberate behavior corrections came out of that verification
   (both make image selection agree with what the text/label side —
   SHOT_TYPE_DESC_LABELS below — already assumed, or with what
   resolveSlotUsed's own fallback chain should have done):
     1. Two-Shot/Three-Shot frames now resolve to the Full Body slot
        first (previously fell through to the generic closeup-first
        default, since neither string contains "wide"/"full" — the same
        class of gap the "os" bucket already handles correctly for
        two-person frames).
     2. Closing Shot's fallback chain now includes Close-up as a last
        resort (previously stopped at Sheet/Mid Shot and returned
        "no slot resolves" even when a Close-up image WAS on file and
        getImageForShot() was already using it — resolveSlotUsed() and
        getImageForShot() disagreed on this exact case).

   filterDescByShotType() below deliberately keeps its OWN
   SHOT_TYPE_DESC_LABELS table rather than being folded into this one —
   that table's individual entries are more granular than these buckets
   (e.g. 'face' → Close-up only, no Mid Shot fallback, vs 'head' →
   Close-up + Mid Shot) and forcing it through these buckets was tried
   and produced real regressions for location/prop text selection,
   caught by the same verification matrix. Left separate by design. */
const SF_FRAME_KEY_BUCKETS = {
  face: 'closeup', head: 'closeup', ecu: 'closeup',
  waist: 'medium', os: 'os',
  fullbody: 'wide', wide: 'wide', twoshot: 'wide', threeshot: 'wide'
};

function shotTypeSignals(shotType) {
  const sfBucket = Object.prototype.hasOwnProperty.call(SF_FRAME_KEY_BUCKETS, shotType) ? SF_FRAME_KEY_BUCKETS[shotType] : null;
  const st = (shotType || '').toLowerCase();
  return {
    sfBucket,
    closing: st.includes('closing'),
    os: st === 'os' || st.includes('over-the-shoulder') || st.includes('over the shoulder'),
    closeup: st.includes('close') || st.includes('ecu'),
    medium: st.includes('medium') || st.includes('waist'),
    wideOrFull: st.includes('wide') || st.includes('full') || st.includes('establish'),
    // Location's own "prefer wide image" trigger — deliberately narrower
    // than wideOrFull (excludes "full": a character "fullbody" SF frame
    // doesn't mean a location asset in the same shot should also switch
    // to its Wide/Establishing photo — never the same "wide," even
    // though the words overlap) and broader in one way (includes
    // "closing", since a scene resolving wide still wants the location's
    // wide photo, unlike character's own dedicated "closing" bucket).
    wideForLocation: st.includes('wide') || st.includes('establish') || st.includes('closing')
  };
}

function normalizeShotType(shotType) {
  const sig = shotTypeSignals(shotType);
  if (sig.sfBucket) return sig.sfBucket;
  if (sig.closing) return 'closing';
  if (sig.os) return 'os';
  if (sig.closeup) return 'closeup';
  if (sig.medium) return 'medium';
  if (sig.wideOrFull) return 'wide';
  return 'default';
}

function isWidePreferredForLocation(shotType) {
  return shotTypeSignals(shotType).wideForLocation;
}

const SLOT_PRIORITY = {
  character: {
    closing: ['fullbody', 'sheet', 'midshot', 'closeup'],
    os:      ['midshot', 'closeup', 'fullbody'],
    closeup: ['closeup', 'midshot', 'fullbody', 'sheet'],
    medium:  ['midshot', 'closeup', 'fullbody'],
    wide:    ['fullbody', 'sheet', 'midshot'],
    default: ['closeup', 'midshot', 'fullbody', 'sheet']
  }
};
const LOCATION_SLOT_PRIORITY = { wide: ['wide', 'detail'], detail: ['detail', 'wide'] };

// Returns best image for a given shot type
function getImageForShot(asset, shotType) {
  if (!asset.images) return null;
  const s = asset.images;
  if (asset.type === 'character') {
    const order = SLOT_PRIORITY.character[normalizeShotType(shotType)] || SLOT_PRIORITY.character.default;
    for (const key of order) { if (s[key]) return s[key]; }
    return null;
  }
  if (asset.type === 'location') {
    const order = isWidePreferredForLocation(shotType) ? LOCATION_SLOT_PRIORITY.wide : LOCATION_SLOT_PRIORITY.detail;
    for (const key of order) { if (s[key]) return s[key]; }
    return null;
  }
  return getPrimaryImage(asset);
}

/* ── MULTI-IMAGE RESOLUTION (backlog item, future-features.md
   "Real multi-image upload to generation platforms") ──────────────
   getImageForShot() above intentionally still returns exactly ONE image
   and is left completely untouched — every existing call site
   (11-reference-panel.js, the cref/perspective-anchor logic in
   06-scene-engine.js) only ever wanted a single best image and continues
   to get exactly that, with zero change in behavior.
   This is the additive plural counterpart: same priority logic per
   asset type (mirrors the exact fallback ORDER already encoded in each
   branch above, e.g. closeup→midshot→fullbody→sheet for characters),
   but returns every available slot in that order instead of stopping at
   the first truthy one — letting GPT Image 2's up-to-16-reference-image
   support actually attach more than one image of the same asset when
   more than one is on file (e.g. a closeup AND a fullbody), instead of
   the rest of that asset's photos being invisible to the prompt
   pipeline just because one slot already matched.
   Reminder (confirmed via codebase audit, 2026-06-28): the app never
   uploads image bytes to any generation API directly — this only
   changes which images get SURFACED to the user (reference strip +
   the GPT prompt's attachment-count wording) for them to manually
   attach themselves. Returns [] if asset.images is missing, same
   no-op-when-nothing-available behavior as getImageForShot(). */
function getImagesForShot(asset, shotType, maxImages) {
  if (!asset.images) return [];
  const s = asset.images;
  const limit = maxImages || 3; // sane default — full asset.images dict rarely exceeds 4 slots anyway

  let order;
  if (asset.type === 'character') {
    order = SLOT_PRIORITY.character[normalizeShotType(shotType)] || SLOT_PRIORITY.character.default;
  } else if (asset.type === 'location') {
    order = isWidePreferredForLocation(shotType) ? LOCATION_SLOT_PRIORITY.wide : LOCATION_SLOT_PRIORITY.detail;
  } else {
    // prop/era/style — getPrimaryImage()'s behavior is "first non-null slot",
    // so for the plural version just return every non-null slot, in
    // whatever key order the object has.
    order = Object.keys(s);
  }

  return order.map(key => s[key]).filter(Boolean).slice(0, limit);
}

/* ── FRAME/SHOT-AWARE DESCRIPTION FILTER (promoted to global scope
   2026-06-30) ──────────────────────────────────────────────────────
   Originally lived only inside 02-singleframe.js's collectSFData(),
   keyed on sfState.frame ('face'/'waist'/'fullbody'/etc — Single
   Frame's own frame-picker vocabulary). That meant Single Frame
   correctly stripped a merged asset description down to just the
   [Close-up]/[Mid Shot]/[Character Sheet] block relevant to the
   selected frame, but the Storyboard engine (06-scene-engine.js
   buildAssetBlock()/charBlockForScale()/locBlockForScale()) never
   filtered at all — it read asset.description raw, so every storyboard
   panel's generated prompt dumped ALL stacked [Tag] blocks verbatim
   regardless of that panel's actual shotType. Confirmed via live test
   2026-06-30: Changdev's prompt (3 merged image-slot descriptions —
   Close-up, Mid Shot, Character Sheet) printed all three in full on
   BOTH a Close-up panel and an Establishing Shot panel — exactly the
   same bug filterDescByFrame() was written to fix for Single Frame,
   just never reused here.
   This is the shot-type-aware twin of getImageForShot() above — same
   job (resolve "what's the single best X for this framing"), applied
   to text instead of an image URL. Single Frame's local function now
   delegates to this one (see 02-singleframe.js) so its already-tested
   behavior is preserved byte-for-byte; this just makes the same logic
   callable from the storyboard pipeline too.
   shotType here is the STORYBOARD vocabulary ('Close-up', 'Medium
   Shot', 'Wide Shot', 'ECU', 'OS', 'Establishing Shot', 'Closing
   Shot') — different strings than Single Frame's sfState.frame keys,
   so callers pass whichever vocabulary they have and this function
   maps both. */
const SHOT_TYPE_DESC_LABELS = {
  // Single Frame's own frame-picker keys (unchanged from the original
  // SF_FRAME_SLOT_LABELS, preserved so its behavior cannot regress)
  face:      ['Close-up'],
  head:      ['Close-up', 'Mid Shot'],
  ecu:       ['Close-up'],
  waist:     ['Mid Shot', 'Close-up'],
  os:        ['Mid Shot', 'Close-up'],
  fullbody:  ['Full Body', 'Character Sheet', 'Mid Shot'],
  wide:      ['Full Body', 'Character Sheet'],
  twoshot:   ['Full Body', 'Character Sheet', 'Mid Shot'],
  threeshot: ['Full Body', 'Character Sheet', 'Mid Shot'],
  // Storyboard's panel.shotType strings, mapped to the same label sets.
  // Substring-matched (lowercased) below rather than exact-keyed, since
  // shotType strings vary ("Close-up" vs "ECU" vs "Closing Shot").
};
function filterDescByShotType(desc, shotType) {
  if (!desc || desc.indexOf('[') === -1) return desc; // no tags — untouched
  const blocks = [];
  const re = /\[([^\]]+)\]\s*([\s\S]*?)(?=\n\[[^\]]+\]|$)/g;
  let m, any = false;
  while ((m = re.exec(desc))) { blocks.push({ label: m[1].trim(), text: m[2].trim() }); any = true; }
  if (!any) return desc; // bracket present but not in the [Tag] text\n[Tag] text shape — leave alone

  let wanted = null;
  const st = (shotType || '').toLowerCase();
  if (SHOT_TYPE_DESC_LABELS[shotType]) {
    // Exact key match — Single Frame's own sfState.frame values
    wanted = SHOT_TYPE_DESC_LABELS[shotType];
  } else if (st) {
    // Storyboard panel.shotType strings — same priority order as
    // getImageForShot()/getImagesForShot() above, mirrored here so
    // "which text block answers this shot" and "which image answers
    // this shot" never disagree.
    if (st.includes('closing')) wanted = ['Full Body', 'Character Sheet', 'Mid Shot'];
    else if (st === 'os' || st.includes('over-the-shoulder') || st.includes('over the shoulder')) wanted = ['Mid Shot', 'Close-up', 'Full Body'];
    else if (st.includes('ecu')) wanted = ['Close-up'];
    else if (st.includes('close')) wanted = ['Close-up', 'Mid Shot'];
    else if (st.includes('medium') || st.includes('waist')) wanted = ['Mid Shot', 'Close-up'];
    // 'Full View' added 2026-07-05 — real bug found by the automated
    // checklist harness (test_checklist_automated.js): era/prop assets use
    // a '[Full View]'/'[Detail]' label pair (see 02-singleframe.js's trident
    // fix, v7.8.2), but 'Full View' was never listed here alongside 'Wide /
    // Establishing'. The array used to fall through to the literal 'Detail'
    // entry via an exact-match hit before ever reaching the location/prop-
    // aware last-resort branch further below (which already handles 'Full
    // View' correctly) — so a Wide/Establishing Shot panel showed an era or
    // prop asset's Detail text instead of its Full View text. Adding it here,
    // ahead of 'Detail', fixes it the same way 'Wide / Establishing' already
    // works for location assets.
    else if (st.includes('wide') || st.includes('full') || st.includes('establish')) wanted = ['Full Body', 'Character Sheet', 'Wide / Establishing', 'Wide', 'Full View', 'Detail'];
  }
  if (!wanted) return desc; // no frame/shotType picked yet, or unmapped — show everything

  for (const label of wanted) {
    const hit = blocks.find(b => b.label === label);
    if (hit) return hit.text;
  }
  // None of the preferred labels matched (e.g. a location's blocks are
  // [Wide / Establishing]/[Detail], not the character label set) — try
  // matching by loose substring before giving up.
  for (const label of wanted) {
    const hit = blocks.find(b => b.label.toLowerCase().includes(label.toLowerCase()) || label.toLowerCase().includes(b.label.toLowerCase()));
    if (hit) return hit.text;
  }

  // Location/prop-aware last resort — bug found 2026-07-03: a location
  // asset's blocks ([Wide / Establishing]/[Detail]) or a prop asset's
  // ([Full View]/[Detail]) never match the character-oriented "wanted"
  // label sets above (SHOT_TYPE_DESC_LABELS' per-frame arrays only ever
  // contain character labels like 'Close-up'/'Full Body'), so they silently
  // fell through to blocks[0] every single time regardless of frame — a
  // location's WRITTEN description could keep showing its Wide/Establishing
  // text even on a tight frame where getImageForShot() had already switched
  // to attaching the Detail IMAGE, a real text/image mismatch. This mirrors
  // getImageForShot()'s own wide-vs-detail condition exactly, so the two
  // can never disagree again.
  const labelSet = blocks.map(b => b.label);
  const wideLabel = labelSet.find(l => /wide\s*\/\s*establishing|^wide$/i.test(l)) || labelSet.find(l => /^full view$/i.test(l));
  const detailLabel = labelSet.find(l => /^detail$/i.test(l));
  if (wideLabel && detailLabel) {
    const preferWide = st.includes('wide') || st.includes('establish') || st.includes('closing');
    const orderedLabels = preferWide ? [wideLabel, detailLabel] : [detailLabel, wideLabel];
    for (const label of orderedLabels) {
      const hit = blocks.find(b => b.label === label);
      if (hit) return hit.text;
    }
  }

  // Still nothing — fall back to the first available block rather than
  // silently dropping the description.
  return blocks[0].text;
}

/* ── PERSPECTIVE-ANCHOR IMAGE RESOLUTION (Perspective-Anchor feature,
   design spec 2026-06-24, build approved 2026-06-28) ──────────────
   getImageForShot() above resolves exactly ONE image per asset/shotType
   and that contract must not change — it's called from many places
   (11-reference-panel.js, buildPanelPrompt() callers, etc.) that only
   expect a single image back. When a panel has a user-selected
   perspective anchor (panel.perspectiveAnchorAssetId, set via
   setPerspectiveAnchor() in 11-reference-panel.js), the prompt pipeline
   additionally needs the anchor's OWN image — which may belong to a
   different asset than the one being requested — alongside the normal
   subordinate image, so getImageForShot() can stay untouched and this
   sits on top of it instead.
   Returns null if no anchor is set on the panel (today's behavior is
   then fully unchanged downstream) or if the anchor asset can't be
   found/has no image. */
function getPerspectiveAnchorImage(panel, effectiveAssets) {
  if (!panel || !panel.perspectiveAnchorAssetId) return null;
  const assets = effectiveAssets || (typeof getEffectiveAssets === 'function' ? getEffectiveAssets() : {});
  const anchorAsset = Object.values(assets).find(a => a.id === panel.perspectiveAnchorAssetId);
  if (!anchorAsset) return null;
  const img = getImageForShot(anchorAsset, panel.shotType);
  if (!img) return null;
  return { asset: anchorAsset, img };
}

/* ── CONTEXT-AWARE LOCATION IMAGE RESOLUTION (feature added 2026-07-03,
   the "Wada Tank" case; reworked same day per the Fable architecture
   audit's Area 3 finding) ────────────────────────────────────────────
   getImageForShot()'s location branch picks Wide vs Detail purely from
   frame/shotType — it has no idea what the scene text actually needs. Real
   case that prompted this: a Wide-framed Single Frame shot whose Subject
   text named a feature (a water tank) that's clearly visible in the
   Detail photo but barely visible in the Wide one — yet Wide always won,
   since frame=wide always outranks content under the old logic.
   This layers on top exactly like getPerspectiveAnchorImage() layers on
   top of getImageForShot() — the base function is completely untouched
   for every existing caller. Only call sites that actually pass
   contextText (Single Frame's subject+env text, today) opt into this.

   v1 (first shipped) parsed keyFeatures back out of the merged Description
   text's "Key features: name (position), ..." clause via regex — the
   2026-07-03 Fable audit flagged this as a real architecture problem
   (Area 3): the analyser's own instructed position format ("right side,
   midground") contains a comma, which fragmented on the naive
   split(',') into bogus feature names, silently breaking the very
   matching this function exists to do.
   Fable's recommended fix was a new structured asset.slotData store. On
   inspection, that store already effectively exists: asset.imageAnalysis
   [slotKey] persists the FULL structured analysis object (including
   keyFeatures as real {name, position} objects, never flattened) for any
   slot analysed since the structured JSON schema shipped — see
   applyPendingAnalysesToAsset(), 09-image-analyser.js. So rather than add
   a parallel field, this reads keyFeatures directly from there via
   normalizeAnalysis() (which safely defaults legacy plain-string
   analyses to keyFeatures: []). No regex, no comma bug, and it now also
   survives a user hand-editing the Description textarea — the decision
   no longer depends on that text staying in the exact "[Tag] text" shape
   Fable's Area 3 flagged as fragile. mergeAnalysisIntoDesc()'s "Key
   features: ..." prose clause still exists and is unchanged — it's now
   purely a human/model-readable rendering for the generated prompt text,
   not a data source this function reads back from.
   Returns { img, slotUsed, matchedFeature }. slotUsed mirrors
   resolveSlotUsed()'s shape ({key, isFallback}) so 11-reference-panel.js/
   02-singleframe.js callers can swap this in with no other code changes.
   matchedFeature is null when no override applied. */
function resolveLocationImageForContext(asset, shotType, contextText) {
  const baseImg = getImageForShot(asset, shotType);
  const baseSlotUsed = (typeof resolveSlotUsed === 'function') ? resolveSlotUsed(asset, shotType) : null;
  const fallback = { img: baseImg, slotUsed: baseSlotUsed, matchedFeature: null };

  if (!asset || asset.type !== 'location' || !asset.images) return fallback;
  if (!contextText || !contextText.trim()) return fallback;
  if (!asset.images.wide || !asset.images.detail) return fallback; // need both slots filled to have anything to switch to

  const analysisFor = (slotKey) => {
    const raw = asset.imageAnalysis && asset.imageAnalysis[slotKey];
    if (!raw) return null;
    return (typeof normalizeAnalysis === 'function') ? normalizeAnalysis(raw) : raw;
  };
  const wideAnalysis = analysisFor('wide');
  const detailAnalysis = analysisFor('detail');
  if (!wideAnalysis && !detailAnalysis) return fallback; // neither slot analysed — nothing to match against

  const preferWide = isWidePreferredForLocation(shotType);
  const otherSlotKey = preferWide ? 'detail' : 'wide';
  const defaultAnalysis = preferWide ? wideAnalysis : detailAnalysis;
  const otherAnalysis = preferWide ? detailAnalysis : wideAnalysis;

  const otherFeatures = (otherAnalysis && Array.isArray(otherAnalysis.keyFeatures)) ? otherAnalysis.keyFeatures : [];
  if (!otherFeatures.length) return fallback;
  const defaultNames = new Set(((defaultAnalysis && defaultAnalysis.keyFeatures) || []).map(f => (f.name || '').toLowerCase()));

  const contextLower = contextText.toLowerCase();
  const match = otherFeatures.find(f => {
    const nameLower = (f.name || '').toLowerCase();
    if (!nameLower || defaultNames.has(nameLower)) return false; // visible in the default slot too — no need to switch
    const escaped = nameLower.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp('\\b' + escaped + '\\b', 'i').test(contextLower);
  });
  if (!match) return fallback;

  // The mentioned feature is only tagged on the OTHER slot — switch to it.
  const overrideImg = asset.images[otherSlotKey] || baseImg;
  if (!overrideImg) return fallback;
  return { img: overrideImg, slotUsed: { key: otherSlotKey, isFallback: false }, matchedFeature: match };
}

/* ── UTILITIES ─────────────────────────────────────────────── */
function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

function fmtDate(ts) {
  return new Date(ts).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
}

function truncate(str, n) {
  return str && str.length > n ? str.slice(0, n) + '…' : str;
}

function escHtml(str) {
  const d = document.createElement('div');
  d.textContent = str || '';
  return d.innerHTML;
}

/* ── STAGED-GENERATION HINT (Cross-Shot Continuity spec, 2026-07-05,
   live-tested 2026-07-06) ────────────────────────────────────────────
   2026-07-05-cross-shot-continuity-spec.md's live testing found that
   combining 3+ reference images with different jobs (character faces,
   pose, background) into ONE generation call degrades both identity
   fidelity and positional control together — confirmed on a real
   2-character courtyard scene, not just reasoned from first principles.
   Staged generation (one strong reference per call, building on the
   previous call's output) reliably preserved both in the same tests.
   This is prompt-engineering guidance, not a new generation capability —
   SS_Studio still never calls a generation API. Shown wherever a
   reference-image strip surfaces 3+ resolved reference images for one
   shot: Storyboard's inline per-panel strip (inlineReferenceStripInnerHTML,
   11-reference-panel.js) and Single Frame's strip (renderSFReferenceStrip,
   02-singleframe.js). Reuses .sf-platform-warning's existing amber-box
   style rather than adding a new CSS class. */
function stagedGenerationHintHTML(refCount) {
  if (!refCount || refCount < 3) return '';
  return `<div class="sf-platform-warning" style="margin-top:0;margin-bottom:8px;width:100%">
    ⚠ <strong>${refCount} reference images</strong> attached to this shot. Live testing found 3+ competing reference images in one generation call degrades both facial identity and positional accuracy — the model doesn't reliably separate "take the face from this one, the pose from that one, the background from the other." Consider staged generation instead: generate the background + one character first, then run a second edit/continue pass adding the next character using only that result + their reference sheet (one new reference per call). See <em>2026-07-05-cross-shot-continuity-spec.md</em> for the tested evidence.
  </div>`;
}

/* ── DEFERRED IMAGE HYDRATION (Fable audit H4, 2026-07-08) ───────────────
   2026-07-08-fable-review-freeze-and-automation-audit.md found the same
   pattern in five places: full-resolution base64 image data embedded
   directly into a big HTML string (asset-edit modal, Library grid cards,
   Storyboard's per-panel reference strip, the Reference Panel modal,
   Single Frame's reference strip). The browser's HTML parser has to
   synchronously tokenize that base64 TEXT before anything on the page can
   respond — for any asset/panel with photos, that's a real, confirmed-live
   multi-second-to-multi-minute freeze (v7.15.9/v7.15.10 fixed the first
   two spots one at a time; this shared helper exists so the remaining
   three — and anything written later — don't repeat that mistake).

   USAGE: wherever HTML-building code would normally write
   `<img src="${bigBase64String}">`, write
   `<img id="${someUniqueId}" data-src-pending="1">` instead, and call
   queueImageHydration(someUniqueId, bigBase64String) at the same point in
   the code (same loop iteration, before returning the HTML string). Also
   works for a download `<a href="...">` by passing 'href' as the third
   argument. Once the HTML has actually been inserted into the DOM (right
   after the `.innerHTML = ...` assignment, not before), call
   flushImageHydration() ONCE — it drains every queued entry regardless of
   which function(s) queued them, so several image-heavy functions can
   contribute to one shared batch that gets applied together after one
   `.innerHTML` write (e.g. many panels' reference strips, all rendered as
   part of one renderPanels() call). Each hydrated image is then decoded by
   the browser's normal async image pipeline instead of the synchronous
   HTML-parser path, so the page stays responsive throughout. */
let _pendingImageHydration = [];
function queueImageHydration(elId, src, prop) {
  if (!src) return;
  _pendingImageHydration.push({ elId, src, prop: prop || 'src' });
}
function flushImageHydration() {
  const queue = _pendingImageHydration;
  _pendingImageHydration = [];
  queue.forEach(({ elId, src, prop }) => {
    const el = document.getElementById(elId);
    if (el) el[prop] = src;
  });
}

/* ── CLIPBOARD (file:// safe) ───────────────────────────────── */
function copyToClipboard(text, successMsg) {
  successMsg = successMsg || 'Copied';
  // Try modern API first (works on HTTPS / localhost)
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(text).then(() => {
      showToast(successMsg, 'success');
    }).catch(() => {
      // Fall back to execCommand for file:// protocol
      legacyCopy(text, successMsg);
    });
  } else {
    legacyCopy(text, successMsg);
  }
}

function legacyCopy(text, successMsg) {
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.style.cssText = 'position:fixed;top:-9999px;left:-9999px;opacity:0;';
  document.body.appendChild(ta);
  ta.focus();
  ta.select();
  try {
    const ok = document.execCommand('copy');
    showToast(ok ? successMsg : 'Select the text and copy manually', ok ? 'success' : 'warning');
  } catch(e) {
    showToast('Select the text and copy manually', 'warning');
  }
  document.body.removeChild(ta);
}

/* ── TOAST ─────────────────────────────────────────────────── */
// Errors (e.g. raw API error text) can be long, so they: wrap/scroll
// instead of overflowing off-screen, stay selectable for copy-paste,
// and don't auto-dismiss on the short timer — the user dismisses
// manually once they've read/copied it.
let toastTimer = null;
function showToast(msg, type = '') {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.className = 'show' + (type ? ' ' + type : '');
  clearTimeout(toastTimer);

  if (type === 'error') {
    // No auto-dismiss for errors — give the user time to read/select/copy.
    // Click dismisses, but not if the click was the end of a text-selection
    // drag (so selecting the error text to copy doesn't also close it).
    el.onclick = () => {
      const sel = window.getSelection();
      if (sel && sel.toString().length > 0) return;
      el.className = '';
      el.onclick = null;
    };
  } else {
    el.onclick = null;
    toastTimer = setTimeout(() => { el.className = ''; }, 2800);
  }
}

/* ── CONFIRM DIALOG ─────────────────────────────────────────── */
function showConfirm(title, msg, onOk) {
  document.getElementById('confirm-title').textContent = title;
  document.getElementById('confirm-msg').textContent = msg;
  const btn = document.getElementById('confirm-ok-btn');
  btn.onclick = () => { closeConfirm(); onOk(); };
  document.getElementById('confirm-overlay').classList.add('open');
}
function closeConfirm() {
  document.getElementById('confirm-overlay').classList.remove('open');
}

/* ── MODAL HELPERS ──────────────────────────────────────────── */
function openModal(id) {
  document.getElementById(id).classList.add('open');
}
function closeModal(id) {
  document.getElementById(id).classList.remove('open');
}
function handleOverlayClick(e, id) {
  if (e.target.id === id) closeModal(id);
}

/* ── VIEW SWITCHING ─────────────────────────────────────────── */
function switchView(view) {
  document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
  document.getElementById('view-' + view).classList.add('active');
  document.querySelectorAll('.nav-tab').forEach(t => {
    t.classList.toggle('active', t.dataset.view === view);
  });
  if (view === 'single') {
    const p = getCurrentProject();
    const noProj = document.getElementById('sf-no-project');
    const stack = document.getElementById('sf-stack');
    if (noProj) noProj.style.display = p ? 'none' : '';
    if (stack) stack.style.display = p ? '' : 'none';
    if (p) { initSingleFrame(); sfBindTextInputs(); }
  }
  if (view === 'storyboard') initStoryboard();
  if (view === 'sequences') {
    if (typeof initSequencesView === 'function') initSequencesView();
  }
}

/* ── PROJECT MANAGEMENT ─────────────────────────────────────── */
function getCurrentProject() {
  return state.activeProject ? state.projects[state.activeProject] : null;
}

function openProjectManager(forceCreate = false) {
  renderProjectList();
  openModal('project-modal-overlay');
  if (forceCreate) {
    setTimeout(() => document.getElementById('new-project-name').focus(), 200);
  }
}

let _addProjectInFlight = false;
async function addProject() {
  // Guard against double-submit (e.g. double Enter-press, double-click) —
  // without this, two rapid calls can each create a separate project with
  // the same name before the input/UI has a chance to reflect the first
  // one, leaving a confusing duplicate on the server.
  if (_addProjectInFlight) return;

  const input = document.getElementById('new-project-name');
  const name = input.value.trim();
  if (!name) { input.focus(); showToast('Enter a project name', 'warning'); return; }

  _addProjectInFlight = true;
  const id = uid();
  state.projects[id] = {
    id,
    name,
    created: Date.now(),
    assets: {}
  };
  state.activeProject = id;
  input.value = '';
  renderAll();
  renderProjectList();

  // Task #8 hardening (2026-06-25): previously this fired saveState()
  // without awaiting it and immediately told the user "Project created" —
  // if the server save silently failed (network blip, server down), the
  // user had no idea the new project never actually persisted, and it
  // could vanish on the next page load that re-synced from the server.
  // Now we await the save and only confirm success once it's done; on
  // failure we say so explicitly rather than letting it look like nothing
  // happened.
  // Fable audit fix (2026-07-08 report, applied 2026-07-10, H3): this used
  // to await the blanket saveState() — a new project has no assets yet
  // (assets: {}), so re-uploading every asset of every OTHER project just
  // to persist this one new project's meta was pure waste. saveState()
  // was already awaited (Task #8 hardening, above); saveProjectMetaOnly()
  // (00-api.js) preserves that same await-and-surface-failure behavior,
  // just scoped to the one project that actually changed.
  try {
    await saveProjectMetaOnly(state.projects[id]);
    showToast('Project created: ' + name, 'success');
  } catch (err) {
    showToast('Project created locally, but saving to server failed — check your connection', 'warning');
  } finally {
    _addProjectInFlight = false;
  }
}

async function switchProject(id) {
  if (!state.projects[id]) return;
  state.activeProject = id;
  renderAll();
  closeModal('project-modal-overlay');
  // Fable audit fix (2026-07-08 report, applied 2026-07-10, H3): this used
  // to await the blanket saveState() on every project switch — re-
  // uploading every asset of every project just to record which one is
  // active. activeProject is root-level state, not part of any project's
  // own meta (see the { assets, shots, ...meta } destructure in
  // saveProjectMetaOnly()/_saveStateNow(), 00-api.js) — the full save
  // never actually persisted this value server-side, so the round trip
  // was pure cost with zero benefit (same finding as M1's "activeProject
  // — cosmetic only"). Keep the cheap local mirror in sync (harmless,
  // synchronous, not what caused the freeze-class cost) and drop the
  // server round trip entirely.
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); } catch(e) {}
}

function renameProject(id) {
  const p = state.projects[id];
  if (!p) return;
  const nameEl = document.querySelector(`.project-list-item-name[data-project-id="${id}"]`);
  if (!nameEl) return;
  doInlineRename(nameEl, id, p);
}

function doInlineRename(nameEl, id, p) {
  const original = p.name;
  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'input';
  input.value = original;
  input.style.cssText = 'font-size:0.88rem;font-weight:600;padding:3px 8px;height:28px;width:100%;';
  nameEl.replaceWith(input);
  input.focus();
  input.select();

  async function commit() {
    const newName = input.value.trim();
    if (newName && newName !== original) {
      p.name = newName;
      renderAll();
      // Task #8 hardening (2026-06-25): await + surface failure, same
      // reasoning as addProject() above — a rename that only succeeds
      // locally and silently fails server-side previously looked
      // identical to a real success.
      // Fable audit fix (2026-07-08 report, applied 2026-07-10, H3): only
      // this one project's name changed — use saveProjectMetaOnly()
      // (00-api.js) instead of the blanket saveState(), same reasoning as
      // addProject() above.
      try {
        await saveProjectMetaOnly(p);
        showToast('Renamed to: ' + newName, 'success');
      } catch (err) {
        showToast('Renamed locally, but saving to server failed — check your connection', 'warning');
      }
    }
    renderProjectList();
  }

  input.addEventListener('blur', commit);
  input.addEventListener('keydown', e => {
    if (e.key === 'Enter') { e.preventDefault(); input.blur(); }
    if (e.key === 'Escape') {
      input.removeEventListener('blur', commit);
      renderProjectList();
    }
  });
}

function deleteProject(id) {
  const p = state.projects[id];
  if (!p) return;
  const assetCount = Object.keys(p.assets).length;
  const msg = `Delete "${p.name}"?` + (assetCount > 0 ? ` This will remove ${assetCount} asset${assetCount !== 1 ? 's' : ''}.` : '');
  showConfirm('Delete Project', msg, async () => {
    // Fable audit fix (2026-07-08 report, applied 2026-07-10, H3) — this
    // used to delete the project from LOCAL state first, then call the
    // blanket saveState(), which re-saves every project still present in
    // state.projects (upsert-only — save_project has no delete branch)
    // but never told the server to remove the one just deleted. The
    // server DOES have a delete_project endpoint (api.php) that recursively
    // removes the project's whole directory; this client just never called
    // it. Net effect discovered while auditing this call site: every
    // project ever "deleted" in this app stayed on disk server-side,
    // orphaned, forever — a real bug, not just a cost issue. Fixed by
    // calling delete_project directly, await-before-mutate, same pattern
    // already used by deleteAsset()/deleteSharedLibraryAsset() below —
    // local state only changes once the server confirms, so there's
    // nothing to roll back on failure (simpler and safer than the old
    // delete-then-rollback-on-failure approach).
    if (typeof showProgress === 'function') showProgress('Deleting "' + p.name + '"…');
    const res = await apiCall('delete_project', { project_id: id });
    if (typeof hideProgress === 'function') hideProgress();
    if (!res) {
      showToast('Could not delete — check your connection and try again', 'error');
      return;
    }
    delete state.projects[id];
    if (state.activeProject === id) {
      const remaining = Object.keys(state.projects);
      state.activeProject = remaining.length > 0 ? remaining[0] : null;
    }
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); } catch(e) {}
    renderAll();
    renderProjectList();
    showToast('Project deleted');
  });
}

function renderProjectList() {
  const list = document.getElementById('project-list');
  const ids = Object.keys(state.projects);

  if (ids.length === 0) {
    list.innerHTML = '<p style="font-size:0.8rem;color:var(--ink-lt);padding:8px 0;">No projects yet. Create one below.</p>';
    return;
  }

  list.innerHTML = ids.map(id => {
    const p = state.projects[id];
    const assetCount = Object.keys(p.assets).length;
    const isActive = state.activeProject === id;
    return `
      <div class="project-list-item ${isActive ? 'active-project' : ''}">
        <div style="display:flex;align-items:center;gap:6px;flex:1;min-width:0;">
          ${isActive ? '<div class="active-dot"></div>' : ''}
          <div>
            <div class="project-list-item-name" data-project-id="${id}">${escHtml(truncate(p.name, 50))}</div>
            <div class="project-list-item-meta">${assetCount} asset${assetCount !== 1 ? 's' : ''} · Created ${fmtDate(p.created)}</div>
          </div>
        </div>
        <div class="project-actions">
          ${!isActive ? `<button class="btn btn-ghost btn-sm" onclick="switchProject('${id}')">Use</button>` : '<span style="font-size:0.72rem;color:var(--amber);padding:0 4px;">Active</span>'}
          <button class="btn btn-ghost btn-sm" onclick="renameProject('${id}')">Rename</button>
          <button class="btn btn-danger btn-sm" onclick="deleteProject('${id}')">Delete</button>
        </div>
      </div>`;
  }).join('');
}

/* ── ASSET TYPE TABS ────────────────────────────────────────── */
function getCurrentType() {
  return state.activeAssetType || 'character';
}

function switchAssetType(type) {
  state.activeAssetType = type;
  document.querySelectorAll('.lib-type-tab').forEach(t => {
    t.classList.toggle('active', t.dataset.type === type);
  });
  const label = TYPE_LABELS[type] || 'Asset';
  document.getElementById('add-btn-type-label').textContent = label;

  // Swap the page header to reflect project-scoped vs shared-library tabs.
  const nameEl = document.getElementById('library-project-name');
  if (nameEl) {
    if (SHARED_LIBRARY_TYPES.includes(type)) {
      nameEl.textContent = 'Shared Library';
    } else {
      const p = getCurrentProject();
      nameEl.textContent = p ? p.name : 'Project Library';
    }
  }

  if (SHARED_LIBRARY_TYPES.includes(type)) {
    renderAssetGrid();
    updateAssetTypeCounts();

    // Real root cause fix (2026-07-08, testing-checklist.md §6): this used
    // to unconditionally re-fetch from the server on EVERY click of this
    // tab (a deliberate 2026-06-25 UX decision, back when libraries were
    // small). Once real usage accumulated real photos, a live Network-tab
    // capture showed this re-downloading the type's ENTIRE asset list —
    // every image included — from scratch each time: single responses of
    // 113.6MB/41.28MB, repeated, 499.1MB transferred in one session.
    // Parsing each giant response back on the main thread is what actually
    // froze the app for minutes — not a rendering bug. Now only fetches
    // once per session per type (see _libraryTypeLoadedThisSession above);
    // a save elsewhere still refreshes the cache directly via
    // loadLibraryAssets(), so this doesn't go stale after an edit.
    if (_libraryTypeLoadedThisSession[type]) return;

    _setTabCountLoading(type, true);
    loadLibraryAssets(type).then(() => {
      _libraryTypeLoadedThisSession[type] = true;
      _setTabCountLoading(type, false);
      renderAssetGrid();
      updateAssetTypeCounts();
    });
  } else {
    renderAssetGrid();
  }
}

// Shows/hides a tiny spinner in place of a library tab's count badge while
// that type's data is being fetched from the server (shared-library tabs
// only — Character is always local/instant from project state).
function _setTabCountLoading(type, isLoading) {
  const el = document.getElementById('count-' + type);
  if (!el) return;
  if (isLoading) {
    el.dataset.prevText = el.textContent;
    el.innerHTML = '<span class="lib-type-count-spinner" aria-label="Loading"></span>';
  } else if (el.dataset.prevText !== undefined) {
    delete el.dataset.prevText;
  }
}

// Refreshes the little count badge on each library tab. Shared-type badges
// reflect total shared-library size (what's actually in the grid); Character
// stays project-scoped.
function updateAssetTypeCounts() {
  const p = getCurrentProject();
  if (!p) return;
  ASSET_TYPES.forEach(type => {
    let count;
    if (SHARED_LIBRARY_TYPES.includes(type)) {
      count = (_libraryCache[type] || []).length;
    } else {
      count = Object.values(p.assets).filter(a => a.type === type).length;
    }
    const el = document.getElementById('count-' + type);
    if (el) el.textContent = count;
  });
}

/* ── ASSET CRUD ─────────────────────────────────────────────── */
function getAssets(type) {
  if (SHARED_LIBRARY_TYPES.includes(type)) {
    return _libraryCache[type] || [];
  }
  const p = getCurrentProject();
  if (!p) return [];
  return Object.values(p.assets).filter(a => a.type === type);
}

function openAssetModal(id = null, type = 'character') {
  const p = getCurrentProject();
  if (!p) { showToast('Create a project first', 'warning'); return; }

  editingAssetId = id;
  _pendingOriginalUploads = {}; // fresh editing session — resize+archive design, 2026-07-08
  const isShared = SHARED_LIBRARY_TYPES.includes(type);
  const asset = id
    ? (isShared ? (_libraryCache[type] || []).find(a => a.id === id) : p.assets[id])
    : null;
  const assetType = asset ? asset.type : type;
  const label = TYPE_LABELS[assetType] || 'Asset';

  document.getElementById('asset-modal-title').textContent =
    (id ? 'Edit ' : 'Add ') + label;

  document.getElementById('asset-modal-body').innerHTML =
    buildAssetFormHTML(assetType, asset);

  openModal('asset-modal-overlay');
  hydrateAssetImageSlots(assetType, asset);

  // Auto-focus REMOVED 2026-07-08 (testing-checklist.md §6): a live CPU
  // profile showed 100+ seconds spent inside this exact .focus() call,
  // freezing the entire modal to clicks/typing. v7.15.5's preventScroll
  // only partially helped — freeze still reproduced on every asset
  // regardless of that asset's own data, pointing to Safari doing expensive
  // native work (likely accessibility-tree related) on focus() whenever the
  // page's overall DOM has grown large (a live Storyboard + Library left
  // sitting in memory), not something tunable via focus options. Removed
  // entirely rather than tuned further — minor UX cost (click into the Name
  // field yourself) for a complete fix rather than a partial one.

  // Fable audit H4 root-cause fix (2026-07-08, see api.php's
  // load_library_assets/get_library_assets_full): _libraryCache no longer
  // carries full-resolution images for shared-library types — `asset` above
  // only has thumbnails. The modal is already open and fully usable (name,
  // description, directions, everything text-based) the instant this call
  // starts; this fetches just THIS ONE asset's real photos in the
  // background and fills them in via the same hydration path a moment
  // later — never the whole type's library, so there's nothing left here
  // that can freeze the page. editingAssetImagesReady gates Save (see
  // saveAssetNow()) so a fast click can't wipe an unloaded photo slot.
  if (id && isShared) {
    editingAssetImagesReady = false;
    fetchFullLibraryAssets(assetType, [id]).then(() => {
      editingAssetImagesReady = true;
      if (editingAssetId !== id) return; // modal closed / different asset opened meanwhile
      const full = getFullLibraryAsset(assetType, id);
      if (full) {
        hydrateAssetImageSlots(assetType, full);
        if (typeof updateDirectionsAccuracyNote === 'function') updateDirectionsAccuracyNote();
      }
    });
  } else {
    editingAssetImagesReady = true;
  }
}

// Fable audit H4 fix (2026-07-08, 2026-07-08-fable-review-freeze-and-
// automation-audit.md): buildAssetFormHTML() previously embedded each image
// slot's full-resolution base64 data directly in the img `src` attribute of
// the giant HTML string assigned to asset-modal-body.innerHTML — several MB
// of literal base64 TEXT the browser's HTML parser had to synchronously
// tokenize before the modal could respond to anything. Confirmed live: the
// modal would render and briefly respond, then freeze for a stretch on
// EVERY asset with a photo attached (Location, Prop — not just image-heavy
// ones), matching this exact mechanism. Fix: the HTML string now carries no
// image data at all (see the `data-src-pending` marker in
// buildAssetFormHTML()'s image-slot block) — this function runs right
// after the modal opens and assigns each slot's real image via a plain
// property assignment read directly from the asset object already in
// memory (no re-parsing, no network). Setting .src this way lets the
// browser decode the image through its normal async image pipeline instead
// of the synchronous HTML-parser path, so the modal itself stays
// responsive throughout.
function hydrateAssetImageSlots(type, asset) {
  if (!asset) return;
  const slots = IMAGE_SLOTS[type] || [];
  slots.forEach(s => {
    // Fable audit H4 root-cause fix (2026-07-08): prefer the real image if
    // we have it, otherwise fall back to the thumbnail — so a shared-
    // library asset opened for edit shows its actual photo (at reduced
    // resolution) immediately, then sharpens to full-res once
    // openAssetModal()'s background fetch resolves and this function runs
    // again with the full asset. Never fetches anything itself.
    const data = asset.images?.[s.key] || asset.thumbnails?.[s.key];
    if (!data) return;
    const img = document.getElementById('asset-img-' + s.key);
    if (img) img.src = data;
  });
}

function buildAssetFormHTML(type, asset = null) {
  const v = asset || {};
  const hint = TYPE_HINTS[type] || '';

  let specificFields = '';

  if (type === 'character') {
    specificFields = `
      <div class="field-row">
        <div class="field">
          <label class="field-label" for="asset-era">Era / Period</label>
          <input class="input" id="asset-era" placeholder="e.g. 1200AD Deccan" value="${escHtml(v.era||'')}">
        </div>
        <div class="field">
          <label class="field-label" for="asset-role">Role / Archetype</label>
          <input class="input" id="asset-role" placeholder="e.g. warrior-saint, sage" value="${escHtml(v.role||'')}">
        </div>
      </div>
      <div class="field">
        <label class="field-label" for="asset-costume">Costume & Appearance</label>
        <textarea class="input" id="asset-costume" placeholder="Detailed costume, fabric, colours, accessories…" rows="3">${escHtml(v.costume||'')}</textarea>
      </div>
      <div class="field">
        <label class="field-label" for="asset-emotional">Emotional Range</label>
        <input class="input" id="asset-emotional" placeholder="e.g. serene authority, fierce devotion, quiet wisdom" value="${escHtml(v.emotional||'')}">
      </div>`;
  }

  if (type === 'location') {
    specificFields = `
      <div class="field-row">
        <div class="field">
          <label class="field-label" for="asset-period">Period</label>
          <input class="input" id="asset-period" placeholder="e.g. 2026, 1200AD medieval" value="${escHtml(v.period||'')}">
        </div>
        <div class="field">
          <label class="field-label" for="asset-atmosphere">Atmosphere</label>
          <input class="input" id="asset-atmosphere" placeholder="e.g. sacred, desolate, lively" value="${escHtml(v.atmosphere||'')}">
        </div>
      </div>
      <div class="field">
        <label class="field-label" for="asset-spatial">Spatial Context <span style="color:var(--amber)">★</span></label>
        <input class="input" id="asset-spatial" placeholder="e.g. beside a highway — outdoor — open ground. Road runs along left edge." value="${escHtml(v.spatialContext||'')}">
        <span class="field-hint">Describe where this location sits spatially — what is adjacent, what surface it is on, what is in each direction. This drives camera placement and composition accuracy.</span>
      </div>
      <div class="field">
        <label class="field-label" for="asset-key-details">Key Visual Details</label>
        <textarea class="input" id="asset-key-details" placeholder="Architecture, ground material, notable features…" rows="3">${escHtml(v.keyDetails||'')}</textarea>
      </div>
      ${buildDirectionsSectionHTML(v.directions || [], v.images || {}, v.id || '')}`;
  }

  if (type === 'prop') {
    specificFields = `
      <div class="field-row">
        <div class="field">
          <label class="field-label" for="asset-material">Material</label>
          <input class="input" id="asset-material" placeholder="e.g. hand-forged iron, handwoven cotton" value="${escHtml(v.material||'')}">
        </div>
        <div class="field">
          <label class="field-label" for="asset-condition">Condition</label>
          <input class="input" id="asset-condition" placeholder="e.g. battle-worn, pristine" value="${escHtml(v.condition||'')}">
        </div>
      </div>
      <div class="field">
        <label class="field-label" for="asset-significance">Narrative Significance</label>
        <input class="input" id="asset-significance" placeholder="Role in the story or scene" value="${escHtml(v.significance||'')}">
      </div>`;
  }

  if (type === 'era') {
    specificFields = `
      <div class="field-row">
        <div class="field">
          <label class="field-label" for="asset-region">Region</label>
          <input class="input" id="asset-region" placeholder="e.g. Deccan plateau, Kashmir valley" value="${escHtml(v.region||'')}">
        </div>
        <div class="field">
          <label class="field-label" for="asset-palette">Colour Palette</label>
          <input class="input" id="asset-palette" placeholder="e.g. muted saffron, ochre, deep red" value="${escHtml(v.palette||'')}">
        </div>
      </div>
      <div class="field">
        <label class="field-label" for="asset-cultural">Cultural Notes</label>
        <textarea class="input" id="asset-cultural" placeholder="Social context, dress codes, forbidden elements, material world…" rows="3">${escHtml(v.cultural||'')}</textarea>
      </div>
      <div class="field">
        <label class="field-label" for="asset-negatives">Period Negatives (auto-added)</label>
        <input class="input" id="asset-negatives" placeholder="e.g. no modern elements, no synthetic fabrics, no power lines" value="${escHtml(v.negatives||'')}">
        <span class="field-hint">These will auto-inject into negative prompts for any scene using this era.</span>
      </div>`;
  }

  if (type === 'style') {
    specificFields = `
      <div class="field-row">
        <div class="field">
          <label class="field-label" for="asset-movement">Artistic Movement</label>
          <input class="input" id="asset-movement" placeholder="e.g. Baroque, Art Nouveau, epic mythological" value="${escHtml(v.movement||'')}">
        </div>
        <div class="field">
          <label class="field-label" for="asset-platform-pref">Platform Preference</label>
          <select class="input" id="asset-platform-pref">
            <option value="">Any platform</option>
            <option value="midjourney" ${v.platformPref==='midjourney'?'selected':''}>Midjourney</option>
            <option value="nanobananapro" ${v.platformPref==='nanobananapro'?'selected':''}>Nano Banana Pro</option>
            <option value="gptimage2" ${v.platformPref==='gptimage2'?'selected':''}>GPT Image-2</option>
          </select>
        </div>
      </div>
      <div class="field">
        <label class="field-label" for="asset-render">Render Style</label>
        <input class="input" id="asset-render" placeholder="e.g. UE5 cinematic render, photorealistic CGI, watercolour illustration" value="${escHtml(v.render||'')}">
      </div>
      <div class="field">
        <label class="field-label" for="asset-grading">Colour Grading</label>
        <input class="input" id="asset-grading" placeholder="e.g. warm amber tones, desaturated cool, vivid saturation" value="${escHtml(v.grading||'')}">
      </div>`;
  }

  const slots = IMAGE_SLOTS[type] || [];
  const hasImageSupport = slots.length > 0;

  const imageSlotsHTML = hasImageSupport ? `
    <div class="section-divider">Reference Images (Optional)</div>
    <p class="field-hint" style="margin-bottom:12px;">Used for visual reference and AI image analysis. Best results: ~1568px on the long edge, JPEG, under ~1.5MB — larger photos get auto-downscaled by the AI anyway, and only slow down saving/loading here. A resize script is available if you're uploading camera/phone-resolution originals.</p>
    <div class="asset-img-slots">
      ${slots.map(s => {
        // Fable audit H4 root-cause fix (2026-07-08): for a shared-library
        // asset, v.images[s.key] may still be empty at this exact moment —
        // real images load in the background after the modal opens (see
        // openAssetModal()'s fetchFullLibraryAssets() call). Using ONLY
        // v.images here would render the "add a photo" upload placeholder
        // for a slot that actually HAS a photo, right up until the fetch
        // resolves — confusing, and worse, hydrateAssetImageSlots() would
        // have no <img> element to fill in since the preview branch never
        // rendered. v.thumbnails[s.key] (small, already present from the
        // list load) is a reliable "does this slot have SOMETHING" signal
        // regardless of whether the full-res fetch has finished, so the
        // preview branch — and its <img> element — renders immediately,
        // showing the thumbnail as an interim placeholder that then
        // sharpens to full resolution a moment later.
        const existing = v.images?.[s.key] || v.thumbnails?.[s.key] || null;
        return `
        <div class="asset-img-slot" id="asset-img-slot-${s.key}">
          <div class="asset-img-slot-label">${s.label}</div>
          <div class="asset-img-slot-hint">${s.hint}</div>
          <input type="text" class="input ia-focus-hint" id="ia-focus-hint-${s.key}"
            placeholder="Focus hint for AI analysis (optional), e.g. &quot;only the cap, ignore the person&quot;"
            value="${escHtml(v.imageFocusHints?.[s.key] || '')}">
          ${existing
            ? `<div class="asset-img-slot-preview">
                 <img id="asset-img-${s.key}" data-src-pending="1" alt="${s.label}" onclick="openLightbox(this.src)" title="Click to view full size">
                 <button class="asset-img-slot-remove" onclick="removeSlotImage('${s.key}')" title="Remove">✕</button>
                 ${v.imageAnalysis?.[s.key]
                   ? `<div class="asset-img-slot-analysed" title="Analysis saved">✦</div>`
                   : ''}
                 ${v.original_files?.[s.key]
                   ? `<button type="button" class="asset-img-slot-download-original" onclick="downloadOriginalImage('${s.key}')" title="Download the original, full-resolution file you uploaded (not this resized working copy)">⬇ original</button>`
                   : ''}
               </div>`
            : `<label class="asset-img-slot-upload">
                 <input type="file" accept="image/*" onchange="handleSlotImageUpload(event,'${s.key}')">
                 <span>＋</span>
               </label>`
          }
        </div>`;
      }).join('')}
    </div>
    <div id="ia-batch-row" style="margin-top:8px;display:flex;align-items:center;gap:8px;">
      <button class="btn btn-ghost btn-sm" onclick="batchAnalyseAllSlots()" id="ia-batch-btn"
        title="AI-analyse all uploaded images at once">✦ Analyse All Images</button>
      <span style="font-size:0.70rem;color:var(--ink-lt);">Requires Anthropic API key in Settings</span>
    </div>` : '';

  // Inline hint shown only when editing an EXISTING shared asset (location/
  // prop/era/style — not character, not a brand-new blank asset). Saving an
  // edit with a changed name forks server-side rather than overwriting the
  // original everywhere it's used — see save_library_asset in api.php.
  const isExistingSharedAsset = SHARED_LIBRARY_TYPES.includes(type) && !!(asset && asset.id);
  const renameForkHint = isExistingSharedAsset
    ? `<p class="field-hint" style="color:var(--amber);margin-top:4px;">
         Renaming this will save it as a new variant (e.g. "Sarah – red dress") instead of changing the original everywhere it's used.
       </p>`
    : '';

  return `
    <input type="hidden" id="asset-type-hidden" value="${type}">
    <div class="field">
      <label class="field-label" for="asset-name">
        Name <span class="field-required">*</span>
      </label>
      <input class="input" id="asset-name" placeholder="Give this ${TYPE_LABELS[type].toLowerCase()} a name"
        value="${escHtml(v.name||'')}" maxlength="80">
      ${renameForkHint}
    </div>

    <div class="field">
      <label class="field-label" for="asset-desc">
        Description <span class="field-required">*</span>
      </label>
      <p class="field-hint">${hint}</p>
      <textarea class="input" id="asset-desc"
        placeholder="What a camera would see — keep it to visual facts only. The fields below handle costume, emotion, and period separately."
        rows="4">${escHtml(v.description||'')}</textarea>
    </div>

    ${specificFields.length ? `
    <div style="background:var(--amber-bg);border:1px solid var(--amber);border-radius:var(--radius);padding:10px 14px;margin-top:2px;">
      <div style="font-size:0.68rem;font-weight:700;color:var(--amber);letter-spacing:0.06em;text-transform:uppercase;margin-bottom:4px;">Smart Injection Fields</div>
      <p style="font-size:0.72rem;color:var(--ink-mid);line-height:1.5;margin-bottom:10px;">${TYPE_FIELD_NOTES[type] || 'The app uses these fields selectively — only when relevant to the shot type. No need to repeat what you wrote in Description.'}</p>
      ${specificFields}
    </div>` : ''}

    ${imageSlotsHTML}
  `;
}

/* ── LOCATION DESIGNER — DIRECTIONS (optional, location assets only) ─────
   Design spec: 2026-06-28-location-designer-spec.md. Text-guidance only —
   this restates what's visible in a given camera-facing direction
   consistently across panels; it does NOT give the generator true
   persistent memory of the location (every panel is still an independent
   generation). Default behaviour is unchanged for any location with zero
   directions defined — this whole section is optional and collapsed by
   default (the app's first use of a collapsible <details> form section;
   no prior precedent in buildAssetFormHTML — this sets one for future
   optional sections).

   Implementation note: the spec calls for "drag-to-reorder" to set the
   clockwise sequence. Built as explicit ↑/↓ move buttons instead — same
   functional outcome (reordering the array), but doesn't require wiring
   and manually verifying HTML5 drag-and-drop without a live browser this
   session. Revisit as a pure UI polish pass later if wanted; the data
   model and save/read logic are drag-vs-buttons agnostic. */
function buildDirectionsSectionHTML(directions, images, locationId) {
  const rowsHTML = directions.map((d, i) => directionRowHTML(d, i)).join('');
  const hasLocationImage = !!(images && (images.wide || images.detail));
  // Shot Setup entry point (phase 3, 2026-07-06). locationId is only
  // truthy for an already-saved location (shared-library assets get a
  // server-assigned id on first save — see buildAssetFormHTML()'s own
  // comment) — a brand-new, not-yet-saved location has nothing to link
  // a shot setup to yet, so the button is swapped for a hint instead.
  const shotSetupBtn = (locationId && typeof openShotSetupForLocation === 'function')
    ? `<button type="button" class="btn btn-secondary btn-sm" style="margin-top:8px;margin-left:6px;"
        onclick="openShotSetupForLocation('${escHtml(locationId)}')"
        title="Open the visual ring/camera diagram for this location">📐 Shot Setup for this location</button>`
    : `<span class="field-hint" style="display:block;margin-top:8px;">Save this location first to use Shot Setup.</span>`;
  return `
    <details class="asset-directions-details" style="margin-top:14px;border:1px solid var(--border);border-radius:var(--radius);padding:10px 14px;">
      <summary style="cursor:pointer;font-weight:700;font-size:0.8rem;">
        Directions (optional)
      </summary>
      <p class="field-hint" style="margin:8px 0 10px;">
        Name what's visible facing each way around this location (e.g. "clock wall," "riverside") so panels shot from different angles can restate the same background consistently. Order sets the clockwise sequence. Text-guidance only — not real persistent memory of the location.
      </p>
      <div id="asset-directions-list">${rowsHTML}</div>
      <div id="asset-directions-accuracy-note">${directionsAccuracyNoteHTML(directions.length, hasLocationImage)}</div>
      <button type="button" class="btn btn-ghost btn-sm" style="margin-top:8px;" onclick="addDirectionRow()">+ Add direction</button>
      ${shotSetupBtn}
    </details>`;
}

function directionRowHTML(d, i) {
  d = d || {};
  const nameVal = escHtml(d.name || '');
  const tagVal = escHtml(d.shortTag || '');
  // Only "follow" the name field into the tag field while the tag hasn't
  // been deliberately customized away from the name — matches the spec's
  // "auto-suggested from name, editable" behaviour without needing a
  // separate stored flag on the data model itself.
  const autoFollow = (!d.shortTag || d.shortTag === d.name) ? 'true' : 'false';
  const featuresVal = escHtml((d.features || []).join(', '));
  return `
    <div class="asset-direction-row" style="border:1px solid var(--border);border-radius:var(--radius);padding:10px;margin-bottom:8px;">
      <div class="field-row">
        <div class="field">
          <label class="field-label">Direction name</label>
          <input class="input direction-name" placeholder="e.g. clock wall, riverside" value="${nameVal}" oninput="autoFillDirectionTag(this)">
        </div>
        <div class="field">
          <label class="field-label">Short tag</label>
          <input class="input direction-tag" data-auto-follow="${autoFollow}" placeholder="auto-suggested from name" value="${tagVal}" oninput="onDirectionTagManualEdit(this)">
        </div>
      </div>
      <div class="field">
        <label class="field-label">Full description</label>
        <textarea class="input direction-desc" rows="2" placeholder="Used when no reference image is attached for this direction — must fully describe it in words, since text is all the model gets">${escHtml(d.fullDescription || '')}</textarea>
      </div>
      <div class="field">
        <label class="field-label">Features (comma-separated, optional)</label>
        <input class="input direction-features" placeholder="e.g. wall clock, small side table" value="${featuresVal}">
      </div>
      <div style="display:flex;gap:6px;justify-content:flex-end;">
        <button type="button" class="btn btn-ghost btn-sm" onclick="openDirectionDerivationModal(this)" title="Generate a prompt to derive a reference photo for this direction from the location's master image">🖼 Derive reference-image prompt</button>
        <button type="button" class="btn btn-ghost btn-sm" onclick="moveDirectionRow(this,-1)" title="Move earlier in clockwise order">↑</button>
        <button type="button" class="btn btn-ghost btn-sm" onclick="moveDirectionRow(this,1)" title="Move later in clockwise order">↓</button>
        <button type="button" class="btn btn-ghost btn-sm" onclick="removeDirectionRow(this)" title="Remove this direction">✕ Remove</button>
      </div>
    </div>`;
}

function addDirectionRow() {
  const list = document.getElementById('asset-directions-list');
  if (!list) return;
  const div = document.createElement('div');
  div.innerHTML = directionRowHTML(null, list.children.length).trim();
  list.appendChild(div.firstChild);
  updateDirectionsAccuracyNote();
}

function removeDirectionRow(btn) {
  const row = btn.closest('.asset-direction-row');
  if (row) row.remove();
  updateDirectionsAccuracyNote();
}

function moveDirectionRow(btn, delta) {
  const row = btn.closest('.asset-direction-row');
  if (!row) return;
  if (delta < 0) {
    const prev = row.previousElementSibling;
    if (prev) row.parentNode.insertBefore(row, prev);
  } else {
    const next = row.nextElementSibling;
    if (next) row.parentNode.insertBefore(next, row);
  }
}

function autoFillDirectionTag(nameInput) {
  const row = nameInput.closest('.asset-direction-row');
  const tagInput = row ? row.querySelector('.direction-tag') : null;
  if (tagInput && tagInput.dataset.autoFollow !== 'false') {
    tagInput.value = nameInput.value;
  }
}

function onDirectionTagManualEdit(tagInput) {
  tagInput.dataset.autoFollow = 'false';
}

/* Soft accuracy nudge (design spec §"Soft accuracy nudge") — non-blocking,
   recomputed live as directions are added/removed or a reference image is
   uploaded/removed, so it stays accurate without needing a save first. */
function directionsAccuracyNoteHTML(dirCount, hasLocationImage) {
  if (dirCount >= 2 && !hasLocationImage) {
    return `<p class="field-hint" style="color:var(--amber);margin-top:6px;">This location has ${dirCount} directions defined but no reference image attached — continuity across panels will be text-only/best-effort until you add one.</p>`;
  }
  return '';
}

function updateDirectionsAccuracyNote() {
  const list = document.getElementById('asset-directions-list');
  const noteEl = document.getElementById('asset-directions-accuracy-note');
  if (!list || !noteEl) return; // no-op for any non-location asset form
  const dirCount = list.querySelectorAll('.asset-direction-row').length;
  const hasLocationImage = !!(document.getElementById('asset-img-wide') || document.getElementById('asset-img-detail'));
  noteEl.innerHTML = directionsAccuracyNoteHTML(dirCount, hasLocationImage);
}

/* ── LOCATION DESIGNER v1.1 — DIRECTION REFERENCE DERIVATION ──────────
   Design spec: 2026-06-28-location-designer-spec.md, "v1.1 — Direction
   Reference Derivation" (added 2026-07-05, live-tested 2026-07-06).
   SS_Studio never calls a generation API itself, here or anywhere else —
   this builds a ready-to-run TEXT PROMPT the user pastes into an
   external platform (GPT Image-2 recommended, attaching their
   location's own master/wide reference photo) to derive a reference
   image for a direction that doesn't have one of its own yet.

   Scope of this build, matching the spec's own recommended order: the
   derivation-prompt template + a per-direction-row trigger only — this
   is "pure text/logic, verifiable, usable manually... even before the
   annotation UI or the master-image-required policy exist." The
   on-photo annotation overlay and the hard/soft master-image-required
   enforcement are NOT built here; both remain open, deferred items (see
   2026-06-28-future-features.md). This still respects v1's existing
   soft accuracy nudge (directionsAccuracyNoteHTML above) rather than
   adding a second, conflicting warning system. */
function buildDirectionDerivationPrompt(name, fullDescription, features, locationName, hasMasterImage) {
  const dirLabel = (name || '').trim() || 'this direction';
  const featureList = (features || []).map(f => f.trim()).filter(Boolean);
  const featureLine = featureList.length ? ` Include: ${featureList.join(', ')}.` : '';
  const descLine = (fullDescription || '').trim()
    || `(No full description written yet for "${dirLabel}" — fill in this direction's "Full description" field for a stronger prompt before running this.)`;
  const masterWarning = hasMasterImage ? '' : `

NOTE: this location has no master/wide reference image saved yet. Upload one to the location's image slots first — this prompt has nothing to stay visually consistent with until you do.`;

  return `Reference-derivation shot for "${(locationName || 'this location').trim()}" — direction: "${dirLabel}".

Attach your location's existing master/wide reference photo to this generation as the input image. The new shot must be recognizably the same building/place, just facing a different way — not an independent reinterpretation of it.

CAMERA: perpendicular to this side, sensor plane parallel to it (no tilt — avoid converging verticals), height roughly chest-to-eye level, pulled back to frame the full elevation. Include, at the frame's edge, the corner where this side meets the master image's visible edge — that shared corner is the anchor tying the two images together.

LENS: 35-50mm equivalent, never wide-angle — minimizes barrel/perspective distortion so this reads as a flat, accurate documentation shot, not a stylized or cinematic frame.

APERTURE: deep depth of field (f/8-f/11 equivalent), everything in sharp focus.

MATCH THE MASTER IMAGE EXACTLY IN: plaster/material color and texture, roofline and pitch, foundation course, and light/shadow direction — as if this is the same building's wall turning the corner, not a different building. Getting the light direction right is the single most important thing to check in the result afterward.

CONTENT SPECIFIC TO THIS DIRECTION ONLY: ${descLine}${featureLine} Do not add people or any other structures unless named above.

RECOMMENDED PLATFORM: GPT Image-2 (edit / image-conditioned mode), with the master photo attached directly — most reliable at holding material and lighting continuity in testing (around 90% match on a single reference photo; near-perfect if you can supply a richer master shot showing multiple sides of the location at once). Gemini/Nano Banana Pro is a lower-confidence fallback — if you use it, run it more than once and pick the best result, since it varied noticeably run-to-run in testing. Midjourney is not recommended for this specific job (its consistency tools are tuned for characters, not architectural material continuity).

AFTER GENERATING: check the shadow direction and object placement against your master image before trusting the result. A shadow/sun position that doesn't shift the way a real reverse angle would is the clearest sign of a bad derivation — more reliable to spot than "does this generally look plausible."${masterWarning}`;
}

function openDirectionDerivationModal(btn) {
  const row = btn.closest('.asset-direction-row');
  if (!row) return;
  const name = (row.querySelector('.direction-name') || {}).value || '';
  const fullDescription = (row.querySelector('.direction-desc') || {}).value || '';
  const features = ((row.querySelector('.direction-features') || {}).value || '').split(',');
  const locationName = (document.getElementById('asset-name') || {}).value || '';
  const hasMasterImage = !!(document.getElementById('asset-img-wide') || document.getElementById('asset-img-detail'));

  const promptText = buildDirectionDerivationPrompt(name, fullDescription, features, locationName, hasMasterImage);
  const titleEl = document.getElementById('direction-derivation-title');
  if (titleEl) titleEl.textContent = name.trim() ? `Reference-image prompt — "${name.trim()}"` : 'Reference-image prompt';
  const taEl = document.getElementById('direction-derivation-textarea');
  if (taEl) taEl.value = promptText;
  openModal('direction-derivation-modal-overlay');
}

function copyDirectionDerivationPrompt() {
  const ta = document.getElementById('direction-derivation-textarea');
  if (ta) copyToClipboard(ta.value, 'Prompt copied');
}

/* ── POSE-DESCRIPTION HELPER (Cross-Shot Continuity spec, 2026-07-05,
   built 2026-07-11) ──────────────────────────────────────────────────
   Spec's second buildable piece, alongside the staged-generation hint
   above stagedGenerationHintHTML(). Rationale: pose is one of the least
   literally-transferable things a text prompt can carry, and attaching a
   prior panel's image as a pose reference was already tried and made
   output WORSE (continuity-anchor, shipped 2026-06-25, failed — see the
   spec's "Relationship to already-shipped/tested features" section). The
   only remaining lever is a more precise TEXT description — same
   "text-only, no new capability class" pattern as the existing
   camera/lens auto-suggestions (v7.4.0, see CAMERA_SUGGEST /
   renderCameraAutoSuggest() in 02-singleframe.js), just user-driven
   (free choice of posture/torso/head/gaze) rather than frame-driven.
   This does NOT promise pose reproduction — it only writes a more
   detailed, more specific description than most users would type
   unprompted, consistent with the spec's "Explicitly out of scope:
   guaranteeing pose or background fidelity" line.

   Shared between Single Frame (inserts into sf-subject-text) and
   Storyboard (inserts into a panel's sb-composition-{i} field) — one
   modal, one generator, a small target descriptor picked at open time
   so this isn't duplicated per mode. */
const POSE_VOCAB = {
  posture: {
    label: 'Posture',
    options: [
      { val: 'standing',   label: 'Standing',   phrase: 'standing upright, weight evenly balanced' },
      { val: 'sitting',    label: 'Sitting',    phrase: 'seated, weight settled downward' },
      { val: 'kneeling',   label: 'Kneeling',   phrase: 'kneeling, one or both knees on the ground' },
      { val: 'crouching',  label: 'Crouching',  phrase: 'crouched low, knees bent, weight forward' },
      { val: 'reclining',  label: 'Reclining',  phrase: 'reclining, body weight supported horizontally' },
      { val: 'mid-motion', label: 'Mid-motion', phrase: 'caught mid-motion, weight shifted forward into the movement' }
    ]
  },
  torso: {
    label: 'Torso Orientation',
    options: [
      { val: 'facing-camera',    label: 'Facing Camera',        phrase: 'torso squared directly toward camera' },
      { val: 'three-q-left',     label: '¾ Toward Frame-Left',  phrase: 'torso turned three-quarters toward frame-left' },
      { val: 'three-q-right',    label: '¾ Toward Frame-Right', phrase: 'torso turned three-quarters toward frame-right' },
      { val: 'profile-left',     label: 'Profile, Facing Left', phrase: 'torso in full profile, facing frame-left' },
      { val: 'profile-right',    label: 'Profile, Facing Right',phrase: 'torso in full profile, facing frame-right' },
      { val: 'turned-away',      label: 'Turned Away',          phrase: 'torso turned away from camera, back or shoulder-blade visible' }
    ]
  },
  head: {
    label: 'Head',
    options: [
      { val: 'level',        label: 'Level',              phrase: 'head level, neutral tilt' },
      { val: 'tilted-up',    label: 'Tilted Up',          phrase: 'chin tilted upward' },
      { val: 'tilted-down',  label: 'Tilted Down',        phrase: 'chin tilted downward, head bowed slightly' },
      { val: 'turned-left',  label: 'Turned Frame-Left',  phrase: 'head turned toward frame-left' },
      { val: 'turned-right', label: 'Turned Frame-Right', phrase: 'head turned toward frame-right' }
    ]
  },
  gaze: {
    label: 'Gaze',
    options: [
      { val: 'at-camera', label: 'At Camera',    phrase: 'eyes directed at camera/viewer' },
      { val: 'off-frame', label: 'Off-Frame',    phrase: 'eyes directed off-frame, not toward camera' },
      { val: 'closed',    label: 'Closed',       phrase: 'eyes closed' },
      { val: 'at-other',  label: 'At Another Figure', phrase: 'eyes directed toward another figure or object in the scene' }
    ]
  }
};

// { mode: 'sf' } → Single Frame's Subject field, or
// { mode: 'sb', panelIndex } → a Storyboard panel's Composition field.
const poseHelperState = { target: null, selections: {}, extra: '' };

function openPoseHelperModal(target) {
  poseHelperState.target = target || { mode: 'sf' };
  poseHelperState.selections = {};
  poseHelperState.extra = '';
  renderPoseHelperModal();
  openModal('pose-helper-modal-overlay');
}

function renderPoseHelperModal() {
  const body = document.getElementById('pose-helper-body');
  if (!body) return;
  const groupsHtml = Object.entries(POSE_VOCAB).map(([key, group]) => {
    const chips = group.options.map(opt => {
      const active = poseHelperState.selections[key] === opt.val;
      return `<button type="button" class="sf-chip${active ? ' active' : ''}" onclick="setPoseHelperChoice('${key}','${opt.val}')" title="${escHtml(opt.phrase)}">${escHtml(opt.label)}</button>`;
    }).join('');
    return `<div class="sf-section" style="margin-bottom:10px">
      <div class="sf-section-label">${escHtml(group.label)}</div>
      <div class="sf-chips">${chips}</div>
    </div>`;
  }).join('');

  body.innerHTML = `
    ${groupsHtml}
    <div class="sf-section" style="margin-bottom:10px">
      <div class="sf-section-label">Additional Detail <span class="sf-label-hint">optional — specific limb/hand/prop detail</span></div>
      <textarea class="input sf-textarea" id="pose-helper-extra" rows="2" placeholder="e.g. one knee bent, hand resting on a stone ledge" oninput="onPoseHelperExtraInput(this.value)"></textarea>
    </div>
    <div class="sf-section">
      <div class="sf-section-label">Generated Pose Description</div>
      <textarea id="pose-helper-output" class="input" rows="3" readonly style="font-family:monospace;font-size:0.78rem;line-height:1.4;" onclick="this.select()"></textarea>
    </div>`;
  updatePoseHelperOutput();
}

function setPoseHelperChoice(groupKey, val) {
  poseHelperState.selections[groupKey] = (poseHelperState.selections[groupKey] === val) ? null : val;
  renderPoseHelperModal();
}

function onPoseHelperExtraInput(val) {
  poseHelperState.extra = val;
  updatePoseHelperOutput();
}

function buildPoseDescription() {
  const phrases = Object.entries(POSE_VOCAB)
    .map(([key, group]) => {
      const chosenVal = poseHelperState.selections[key];
      if (!chosenVal) return null;
      const opt = group.options.find(o => o.val === chosenVal);
      return opt ? opt.phrase : null;
    })
    .filter(Boolean);
  const extra = (poseHelperState.extra || '').trim();
  if (extra) phrases.push(extra);
  if (!phrases.length) return '';
  return phrases.join(', ') + '.';
}

function updatePoseHelperOutput() {
  const el = document.getElementById('pose-helper-output');
  if (el) el.value = buildPoseDescription();
}

function copyPoseHelperOutput() {
  const el = document.getElementById('pose-helper-output');
  if (el && el.value) copyToClipboard(el.value, 'Pose description copied');
}

// Inserts the generated description into whichever field opened the
// modal (Single Frame's Subject text, or a Storyboard panel's
// Composition text) and re-runs that field's own update pipeline so the
// prompt/preview reflects it immediately — same as if the user had typed
// it directly.
function insertPoseHelperOutput() {
  const desc = buildPoseDescription();
  if (!desc) { closeModal('pose-helper-modal-overlay'); return; }
  const target = poseHelperState.target || { mode: 'sf' };

  if (target.mode === 'sb' && typeof target.panelIndex === 'number') {
    const compEl = document.getElementById('sb-composition-' + target.panelIndex);
    if (compEl) {
      compEl.value = compEl.value ? (compEl.value.replace(/\s+$/, '') + ' ' + desc) : desc;
      if (typeof onCompositionEdit === 'function') onCompositionEdit(target.panelIndex);
    }
  } else {
    const subjEl = document.getElementById('sf-subject-text');
    if (subjEl) {
      subjEl.value = subjEl.value ? (subjEl.value.replace(/\s+$/, '') + ' ' + desc) : desc;
      sfState.freeText.subject = subjEl.value;
      if (typeof updatePrompt === 'function') updatePrompt();
      if (typeof renderSFReferenceStrip === 'function') renderSFReferenceStrip();
    }
  }
  closeModal('pose-helper-modal-overlay');
}

/* ── IMAGE SLOT UPLOAD HANDLERS ─────────────────────────────── */
// Resize+archive design (2026-07-08, user-requested). Every upload is
// downscaled HERE, client-side, via the Canvas API — no AI involved, no
// server round trip — to SS_Studio's recommended working size (~1568px
// long edge, JPEG ~85%, matching the hint text above the upload slots).
// This resized copy becomes the "working" image: what's shown, saved to
// asset.images, used for AI analysis, and attached as a reference. The
// untouched ORIGINAL the user actually selected is kept too (see
// _pendingOriginalUploads below) and archived server-side on save — but
// deliberately never touches any of those same paths, so a heavy original
// can never reintroduce the freeze this whole day's work fixed.
const SS_STUDIO_UPLOAD_MAX_DIM = 1568;
const SS_STUDIO_UPLOAD_QUALITY = 0.85;
function resizeImageForUpload(file, maxDim = SS_STUDIO_UPLOAD_MAX_DIM, quality = SS_STUDIO_UPLOAD_QUALITY) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error || new Error('Could not read file'));
    reader.onload = (e) => {
      const img = new Image();
      img.onerror = () => reject(new Error('Could not decode image'));
      img.onload = () => {
        const scale = Math.min(1, maxDim / Math.max(img.naturalWidth, img.naturalHeight));
        const w = Math.max(1, Math.round(img.naturalWidth * scale));
        const h = Math.max(1, Math.round(img.naturalHeight * scale));
        const canvas = document.createElement('canvas');
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(img, 0, 0, w, h);
        resolve(canvas.toDataURL('image/jpeg', quality));
      };
      img.src = e.target.result;
    };
    reader.readAsDataURL(file);
  });
}

// Holds each slot's untouched original upload for THIS modal session only —
// reset in openAssetModal(), populated per fresh upload below, cleared on
// remove, sent alongside the resized working image on save (see
// saveAssetNow()) and cleared again once that save succeeds. Never read by
// anything except the save payload — the DOM/preview/analysis path only
// ever sees the resized copy.
let _pendingOriginalUploads = {};

// Streams the archived, full-resolution original for one slot as a browser
// download — never loads it into the page as JSON/base64 (see
// stream_original_file(), api.php). Only ever reachable for a slot that
// actually has one (see the "⬇ original" button's v.original_files check
// in buildAssetFormHTML()).
function downloadOriginalImage(slotKey) {
  if (!editingAssetId) return;
  const type = document.getElementById('asset-type-hidden')?.value;
  const isShared = SHARED_LIBRARY_TYPES.includes(type);
  const username = encodeURIComponent(getCurrentUser() || '');
  const slot = encodeURIComponent(slotKey);
  const id = encodeURIComponent(editingAssetId);
  let url;
  if (isShared) {
    url = `${API_URL}?action=get_library_asset_original&username=${username}&type=${encodeURIComponent(type)}&asset_id=${id}&slot=${slot}`;
  } else {
    const p = getCurrentProject();
    if (!p) return;
    url = `${API_URL}?action=get_asset_original&username=${username}&project_id=${encodeURIComponent(p.id)}&asset_id=${id}&slot=${slot}`;
  }
  const a = document.createElement('a');
  a.href = url;
  document.body.appendChild(a);
  a.click();
  a.remove();
}

async function handleSlotImageUpload(event, slotKey) {
  const file = event.target.files[0];
  if (!file) return;
  if (file.size > 10 * 1024 * 1024) {
    showToast('Image must be under 10MB', 'warning');
    return;
  }
  try {
    const optimized = await resizeImageForUpload(file);
    const reader = new FileReader();
    reader.onload = e => {
      _pendingOriginalUploads[slotKey] = e.target.result;
      renderSlotPreview(slotKey, optimized);
    };
    reader.onerror = () => showToast('Could not read that file — try again', 'error');
    reader.readAsDataURL(file); // untouched original, archived separately on save
  } catch (err) {
    showToast('Could not process that image — try a different file', 'error');
  }
}

function renderSlotPreview(slotKey, dataUrl) {
  const slot = document.getElementById('asset-img-slot-' + slotKey);
  if (!slot) return;
  const slotDef = Object.values(IMAGE_SLOTS).flat().find(s => s.key === slotKey);
  slot.querySelector('.asset-img-slot-upload, .asset-img-slot-preview')?.remove();
  const preview = document.createElement('div');
  preview.className = 'asset-img-slot-preview';
  // Fable audit H4 follow-up (2026-07-08, cross-verify pass): same
  // embedded-base64-in-innerHTML pattern as the other five locations, on a
  // smaller single-image scale — included anyway for consistency, so no
  // spot in the codebase still does this. src deferred + hydrated via
  // queueImageHydration/flushImageHydration (defined above in this file).
  preview.innerHTML = `
    <img id="asset-img-${slotKey}" data-src-pending="1" alt="${slotDef ? slotDef.label : slotKey}" onclick="openLightbox(this.src)" title="Click to view full size">
    <button class="asset-img-slot-remove" onclick="removeSlotImage('${slotKey}')" title="Remove">✕</button>`;
  slot.appendChild(preview);
  queueImageHydration('asset-img-' + slotKey, dataUrl);
  flushImageHydration();
  // Location Designer soft accuracy nudge (no-op for non-location asset
  // forms — updateDirectionsAccuracyNote() checks for the directions list
  // existing before doing anything).
  if (typeof updateDirectionsAccuracyNote === 'function') updateDirectionsAccuracyNote();
}

/* ── LIGHTBOX ───────────────────────────────────────────────── */
function openLightbox(src) {
  const overlay = document.getElementById('img-lightbox-overlay');
  const img = document.getElementById('img-lightbox-img');
  if (!overlay || !img) return;
  img.src = src;
  overlay.classList.add('open');
  // Close on Escape
  document._lightboxKeyHandler = (e) => { if (e.key === 'Escape') closeLightbox(); };
  document.addEventListener('keydown', document._lightboxKeyHandler);
}

function closeLightbox() {
  const overlay = document.getElementById('img-lightbox-overlay');
  if (overlay) overlay.classList.remove('open');
  if (document._lightboxKeyHandler) {
    document.removeEventListener('keydown', document._lightboxKeyHandler);
    delete document._lightboxKeyHandler;
  }
}

function removeSlotImage(slotKey) {
  // Guard: if this slot has an AI analysis (saved or pending), warn before
  // destroying it — re-running analysis costs API credits again.
  const hasSavedAnalysis = (typeof getCurrentProject === 'function' && editingAssetId)
    ? !!getCurrentProject()?.assets?.[editingAssetId]?.imageAnalysis?.[slotKey]
    : false;
  const hasPendingAnalysis = (typeof getPendingAnalysis === 'function') && !!getPendingAnalysis(slotKey);

  if (hasSavedAnalysis || hasPendingAnalysis) {
    showConfirm(
      'Remove Image — Analysis Will Be Lost',
      'This image has a saved AI analysis attached. Removing the image permanently deletes that analysis too — re-running it later will use API credits again. Remove anyway?',
      () => doRemoveSlotImage(slotKey)
    );
  } else {
    doRemoveSlotImage(slotKey);
  }
}

function doRemoveSlotImage(slotKey) {
  const slot = document.getElementById('asset-img-slot-' + slotKey);
  if (!slot) return;
  const slotDef = Object.values(IMAGE_SLOTS).flat().find(s => s.key === slotKey);
  slot.querySelector('.asset-img-slot-upload, .asset-img-slot-preview')?.remove();
  slot.querySelector('.ia-result')?.remove();
  const label = document.createElement('label');
  label.className = 'asset-img-slot-upload';
  label.innerHTML = `<input type="file" accept="image/*" onchange="handleSlotImageUpload(event,'${slotKey}')"><span>＋</span>`;
  slot.appendChild(label);
  // Explicit remove — don't archive a stale original for a slot that no
  // longer has a working image (resize+archive design, 2026-07-08).
  delete _pendingOriginalUploads[slotKey];
  // Also clear any analysis badge
  const badge = slot.querySelector('.asset-img-slot-analysed');
  if (badge) badge.remove();
  // Clear pending analysis for this slot
  if (typeof clearPendingAnalysisForSlot === 'function') clearPendingAnalysisForSlot(slotKey);
  // Location Designer soft accuracy nudge — see renderSlotPreview() above.
  if (typeof updateDirectionsAccuracyNote === 'function') updateDirectionsAccuracyNote();
}

let _saveAssetInFlight = false;
async function saveAsset() {
  // Guard against double-submit (double-click / double Enter), same class
  // of bug that caused duplicate projects — applies here to avoid firing
  // two overlapping saves of the same/adjacent assets.
  if (_saveAssetInFlight) return;
  _saveAssetInFlight = true;
  try {
    await saveAssetNow();
  } finally {
    _saveAssetInFlight = false;
  }
}

async function saveAssetNow() {
  const p = getCurrentProject();
  if (!p) return;

  // Fable audit H4 root-cause fix (2026-07-08): saving before this editing
  // asset's real images have finished loading would read empty/placeholder
  // slots below (line ~1725, "preserve existing image if editing and no new
  // upload shown") and write that emptiness back as the saved state —
  // silently wiping the asset's existing photos. This only ever blocks a
  // save that starts in the brief window right after opening a shared-
  // library asset for edit, before its one-asset background fetch
  // (openAssetModal()) resolves — normally a fraction of a second.
  if (!editingAssetImagesReady) {
    showToast('Still loading this asset’s photos — try Save again in a moment', 'warning');
    return;
  }

  const name = document.getElementById('asset-name').value.trim();
  const desc = document.getElementById('asset-desc').value.trim();
  const type = document.getElementById('asset-type-hidden').value;
  const isShared = SHARED_LIBRARY_TYPES.includes(type);

  if (!name) {
    document.getElementById('asset-name').focus();
    showToast('Asset needs a name', 'warning');
    return;
  }
  if (!desc) {
    document.getElementById('asset-desc').focus();
    showToast('Add a description — it will be injected into your prompts', 'warning');
    return;
  }

  // Look up the asset being edited (if any) from the right source —
  // project-scoped for character, shared-cache for the 4 library types.
  const existingAsset = editingAssetId
    ? (isShared ? (_libraryCache[type] || []).find(a => a.id === editingAssetId) : p.assets[editingAssetId])
    : null;

  // Collect images from all slots
  const images = defaultImageSlots(type);
  // Resize+archive design (2026-07-08, user-requested): only slots with a
  // FRESH upload this save carry an entry here — carried-forward unchanged
  // slots have nothing new to archive, and the server keeps whatever
  // original it already archived for them (see archive_original_uploads(),
  // api.php).
  const originalUploads = {};
  const slots = IMAGE_SLOTS[type] || [];
  slots.forEach(s => {
    const el = document.getElementById('asset-img-' + s.key);
    if (el && el.src && el.src.startsWith('data:')) {
      images[s.key] = el.src;
      if (_pendingOriginalUploads[s.key]) originalUploads[s.key] = _pendingOriginalUploads[s.key];
    } else {
      // Preserve existing image if editing and no new upload shown
      images[s.key] = existingAsset?.images?.[s.key] || null;
    }
  });

  // Preserve existing imageAnalysis if editing
  const imageAnalysis = existingAsset?.imageAnalysis || {};

  // Collect per-slot focus hints (optional free-text the user can set to
  // tell the AI what to analyse/ignore for that specific photo, e.g. "only
  // the cap, ignore the person" — overrides the type-default focus prompt).
  const imageFocusHints = {};
  slots.forEach(s => {
    const el = document.getElementById('ia-focus-hint-' + s.key);
    const val = el ? el.value.trim() : '';
    if (val) imageFocusHints[s.key] = val;
    else if (existingAsset?.imageFocusHints?.[s.key]) {
      // No input present (e.g. slot re-rendered without one) — keep prior value
      imageFocusHints[s.key] = existingAsset.imageFocusHints[s.key];
    }
  });

  // Build asset object
  const asset = {
    id: editingAssetId || (isShared ? '' : uid()), // shared types: server assigns id on first save
    type,
    name,
    description: desc,
    images,
    imageAnalysis,
    imageFocusHints,
    created: existingAsset?.created || Date.now(),
    updated: Date.now()
  };
  if (Object.keys(originalUploads).length) asset.originalUploads = originalUploads;
  if (!asset.id) delete asset.id;

  // Type-specific fields
  const g = (id) => { const el = document.getElementById(id); return el ? el.value.trim() : ''; };

  if (type === 'character') {
    asset.era       = g('asset-era');
    asset.role      = g('asset-role');
    asset.costume   = g('asset-costume');
    asset.emotional = g('asset-emotional');
  }
  if (type === 'location') {
    asset.period        = g('asset-period');
    asset.atmosphere    = g('asset-atmosphere');
    asset.spatialContext = g('asset-spatial');
    asset.keyDetails    = g('asset-key-details');
    // Location Designer — directions (see buildDirectionsSectionHTML()
    // above). DOM order reflects the clockwise sequence after any ↑/↓
    // reordering. Rows with no name are dropped (an added-then-abandoned
    // row, or a blank leftover) rather than saved as an unusable entry.
    const directionRows = document.querySelectorAll('#asset-directions-list .asset-direction-row');
    asset.directions = Array.from(directionRows).map(row => {
      const name = row.querySelector('.direction-name')?.value.trim() || '';
      const shortTag = row.querySelector('.direction-tag')?.value.trim() || name;
      const fullDescription = row.querySelector('.direction-desc')?.value.trim() || '';
      const features = (row.querySelector('.direction-features')?.value || '')
        .split(',').map(s => s.trim()).filter(Boolean);
      return { name, shortTag, fullDescription, features };
    }).filter(d => d.name);
  }
  if (type === 'prop') {
    asset.material    = g('asset-material');
    asset.condition   = g('asset-condition');
    asset.significance = g('asset-significance');
  }
  if (type === 'era') {
    asset.region   = g('asset-region');
    asset.palette  = g('asset-palette');
    asset.cultural = g('asset-cultural');
    asset.negatives = g('asset-negatives');
  }
  if (type === 'style') {
    asset.movement     = g('asset-movement');
    asset.platformPref = g('asset-platform-pref');
    asset.render       = g('asset-render');
    asset.grading      = g('asset-grading');
  }

  if (!isShared) {
    // Character — project-scoped. Previously this called the blanket
    // saveState(), which re-uploads EVERY asset in the project on every
    // single save (slow, and as the project grows, increasingly likely to
    // hit payload/memory limits) and never awaited the result, so a failed
    // save (e.g. hitting a server limit) silently dropped the asset with
    // no error shown — the "2nd/3rd asset never saves" symptom. Now we
    // save just this one asset directly and await + verify the result
    // before telling the user it worked.
    // Resize+archive design (2026-07-08): asset.originalUploads (the raw,
    // un-resized file the user picked) is only needed by the SERVER call
    // below, to archive it — it must never land in client-side state or
    // localStorage, or every future full-state save would re-serialize a
    // full-resolution photo, and localStorage has nowhere near the quota
    // for that. Keep it out of the locally-stored copy; the full `asset`
    // (with originalUploads intact) still gets sent to the server as-is.
    const { originalUploads: _origForArchive, ...assetForLocalState } = asset;
    p.assets[asset.id] = assetForLocalState;
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); } catch(e) {}

    // Urgent UX fix (2026-06-25): saving a character with heavy photo
    // slots (multiple base64 images) can take a noticeable few seconds
    // with zero indication anything is happening. A single asset save is
    // one or two network round-trips of unknown duration — no real
    // percentage to show, so use the indeterminate sweep rather than
    // faking a number.
    if (typeof showProgress === 'function') showProgress('Saving "' + name + '"…');

    const { assets: _omit, shots: _omit2, ...projectMeta } = p;
    const projRes = await apiCall('save_project', { project: projectMeta });
    const assetRes = await apiCall('save_asset', { project_id: p.id, asset });

    if (typeof hideProgress === 'function') hideProgress();

    if (!projRes || !assetRes) {
      showToast('Could not save "' + name + '" — check server connection and try again', 'error');
      return; // Keep the modal open so nothing is lost from the form.
    }

    closeModal('asset-modal-overlay');
    renderAll();
    showToast((editingAssetId ? 'Updated: ' : 'Added: ') + name, 'success');
    editingAssetId = null;
    _pendingOriginalUploads = {}; // just archived server-side — nothing left to hold onto
    return;
  }

  // Shared library types — save to the shared store, not the project.
  saveSharedLibraryAsset(type, asset, name);
}

async function saveSharedLibraryAsset(type, asset, name) {
  if (typeof showProgress === 'function') showProgress('Saving "' + name + '"…');

  const res = await apiCall('save_library_asset', { type, asset });
  if (!res || !res.asset) {
    if (typeof hideProgress === 'function') hideProgress();
    showToast('Could not save to shared library — check server connection', 'error');
    return;
  }

  // Patch the cache in place instead of refetching the whole type (Fable
  // audit H1) — res.asset already IS the full saved record.
  _patchLibraryCache(type, res.asset);
  // Fable audit H4 root-cause fix (2026-07-08): res.asset already carries
  // real full-resolution images (api.php reattaches them into the save
  // response specifically so this works) — seed the full-image cache too,
  // so nothing re-fetches what was just saved.
  if (_libraryFullCache[type]) _libraryFullCache[type][res.asset.id] = res.asset;

  // Fable audit M4 fix (2026-07-08 report, live-confirmed + applied
  // 2026-07-10) — exposed for 09-image-analyser.js's patchSaveAsset(),
  // which needs to know exactly which shared asset was just saved
  // (including a brand-new asset's server-assigned id, not knowable from
  // outside this function) so it can merge any pending image analysis
  // onto the RIGHT asset. Without this, patchSaveAsset() had no way to
  // identify a shared-type save at all and fell back to guessing "the
  // most recently updated PROJECT asset" — which a shared location/prop/
  // era is never a member of (confirmed live 2026-07-10: analysing a
  // shared location and saving attached the analysis to an unrelated
  // project character, and the shared asset itself never got its
  // imageAnalysis field touched).
  window._lastSavedSharedAsset = { type, asset: res.asset };

  const p = getCurrentProject();
  if (res.forked && p) {
    // User edited an existing shared asset with a new name -> server created
    // a new variant. Link it into this project immediately so it's usable
    // right away, since the user just created it from inside this project.
    const linkRes = await apiCall('link_project_asset', { project_id: p.id, type, asset_id: res.asset.id });
    if (linkRes && linkRes.project) {
      p.linkedAssets = linkRes.project.linkedAssets;
    } else {
      showToast('Saved, but could not auto-link the new variant to this project', 'warning');
    }
  }

  if (typeof hideProgress === 'function') hideProgress();

  closeModal('asset-modal-overlay');
  renderAll();
  showToast((res.forked && editingAssetId ? 'Saved as new variant: ' : (editingAssetId ? 'Updated: ' : 'Added: ')) + name, 'success');
  editingAssetId = null;
  _pendingOriginalUploads = {}; // just archived server-side — nothing left to hold onto
}

function deleteAsset(id) {
  const type = state.activeAssetType;
  if (SHARED_LIBRARY_TYPES.includes(type)) {
    deleteSharedLibraryAsset(id, type);
    return;
  }
  const p = getCurrentProject();
  if (!p || !p.assets[id]) return;
  const name = p.assets[id].name;
  showConfirm('Delete Asset', `Remove "${name}" from the library? This cannot be undone.`, async () => {
    // Previously this only removed the asset from local state and called
    // saveState() — it never told the server to delete the asset's JSON
    // file or its image slot files, so the asset (and its images) silently
    // remained on disk and came back on next refresh/reload. Now we await
    // the server's delete_asset confirmation first, same pattern used by
    // deleteSharedLibraryAsset(), and only update local state once the
    // server confirms the delete actually happened.
    const res = await apiCall('delete_asset', { project_id: p.id, asset_id: id });
    if (!res) {
      showToast('Could not delete — check server connection', 'error');
      return;
    }
    delete p.assets[id];
    // Fable audit fix (2026-07-08 report, applied 2026-07-10, H3): this
    // used to follow the confirmed server-side delete_asset above with a
    // blanket saveState() call — re-uploading every OTHER asset in every
    // project "to sync project metadata" that never actually changed
    // (deleting an asset doesn't touch the project's own name/created/
    // updated fields; save_project's payload excludes the assets list
    // entirely — see saveProjectMetaOnly(), 00-api.js). The server-side
    // delete above is already the real persistence; there was nothing
    // left worth a full-account round trip for. Keep the local mirror in
    // sync (cheap) and stop there.
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); } catch(e) {}
    renderAll();
    showToast('Deleted: ' + name);
  });
}

function deleteSharedLibraryAsset(id, type) {
  const asset = (_libraryCache[type] || []).find(a => a.id === id);
  if (!asset) return;
  const name = asset.name;
  showConfirm('Delete Asset', `Remove "${name}" from the shared library? This removes it for every user and project, and cannot be undone.`, async () => {
    const res = await apiCall('delete_library_asset', { type, asset_id: id });
    if (!res) {
      showToast('Could not delete — check server connection', 'error');
      return;
    }
    // Patch the cache in place instead of refetching the whole type (Fable
    // audit H1) — the server already confirmed the delete, nothing left to
    // re-download.
    _removeLibraryCacheEntry(type, id);
    renderAll();
    showToast('Deleted: ' + name);
  });
}

/* ── RENDER FUNCTIONS ───────────────────────────────────────── */
function renderAll() {
  renderProjectSelect();
  renderLibraryView();
  updateNavBadge();
}

function renderProjectSelect() {
  const sel = document.getElementById('project-select');
  const newBtn = document.getElementById('btn-new-project-header');
  const ids = Object.keys(state.projects);

  if (ids.length === 0) {
    sel.style.display = 'none';
    if (newBtn) newBtn.style.display = '';
  } else {
    sel.style.display = '';
    if (newBtn) newBtn.style.display = 'none';
    sel.innerHTML = ids.map(id => {
        const p = state.projects[id];
        return `<option value="${id}" ${state.activeProject === id ? 'selected' : ''}>${escHtml(truncate(p.name, 36))}</option>`;
      }).join('');
  }

  sel.onchange = async () => {
    state.activeProject = sel.value;
    renderAll();
    // Fable audit fix (2026-07-08 report, applied 2026-07-10, H3): same
    // reasoning as switchProject() above (this is the header dropdown's
    // equivalent of that same action) — activeProject is never actually
    // in the blanket save's payload, so drop the pointless server round
    // trip and keep only the cheap local mirror.
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); } catch(e) {}
  };
}

function renderLibraryView() {
  const p = getCurrentProject();
  const noState = document.getElementById('no-project-state');
  const content = document.getElementById('library-content');

  if (!p) {
    noState.style.display = 'flex';
    content.style.display = 'none';
    return;
  }

  noState.style.display = 'none';
  content.style.display = 'block';
  const nameEl = document.getElementById('library-project-name');
  nameEl.textContent = SHARED_LIBRARY_TYPES.includes(state.activeAssetType) ? 'Shared Library' : p.name;

  // Update type counts (shared-type badges show total shared-library size).
  updateAssetTypeCounts();

  // Add button label
  document.getElementById('add-btn-type-label').textContent =
    TYPE_LABELS[state.activeAssetType] || 'Asset';

  renderAssetGrid();
}

function renderAssetGrid() {
  const grid = document.getElementById('asset-grid');
  const type = state.activeAssetType;
  const assets = getAssets(type);

  // Urgent UX fix (2026-06-25): on a shared-library tab whose cache hasn't
  // loaded yet (e.g. first visit this session, or a slow connection), this
  // used to flash "No <type>s yet" before the real data arrived — easy to
  // misread as "the library is actually empty." Show a neutral loading
  // state instead whenever a fetch for this exact type is in flight
  // (see _setTabCountLoading()/switchAssetType() above).
  const countEl = document.getElementById('count-' + type);
  const isFetching = SHARED_LIBRARY_TYPES.includes(type) && countEl?.dataset.prevText !== undefined;

  if (assets.length === 0 && isFetching) {
    grid.innerHTML = `
      <div class="empty-state">
        <div class="empty-state-icon">⏳</div>
        <div class="empty-state-title">Loading ${TYPE_LABELS[type].toLowerCase()}s…</div>
      </div>`;
    return;
  }

  if (assets.length === 0) {
    grid.innerHTML = `
      <div class="empty-state">
        <div class="empty-state-icon">${TYPE_ICONS[type]}</div>
        <div class="empty-state-title">No ${TYPE_LABELS[type]}s yet</div>
        <p class="empty-state-desc">Add your first ${TYPE_LABELS[type].toLowerCase()} to the library. Describe it once and reuse it across every prompt.</p>
        <button class="btn btn-primary" onclick="openAssetModal(null, '${type}')">＋ Add ${TYPE_LABELS[type]}</button>
      </div>`;
    return;
  }

  // Sort newest first
  const sorted = [...assets].sort((a, b) => (b.created || 0) - (a.created || 0));

  grid.innerHTML = sorted.map(a => renderAssetCard(a)).join('');

  // Fable audit H4 fix, extended to the grid (2026-07-08 — see v7.15.9's
  // identical fix for the edit modal, and the changelog entry for this
  // one). renderAssetGrid() rebuilds EVERY card's full-res image into one
  // giant innerHTML string, and does so far more often than the edit
  // modal — every tab click, and via renderAll() after nearly every save
  // ANYWHERE in the app, regardless of which view is even active. Same
  // fix: no image data in the initial HTML string (see the
  // `data-src-pending` marker in renderAssetCard()) — hydrate each card's
  // image via a plain property assignment right after, straight from the
  // already-in-memory asset object.
  sorted.forEach(a => {
    // getCardThumbnail() (Fable audit H4 root-cause fix, 2026-07-08) — small
    // thumbnail from the list load, not the full-resolution image.
    const primaryImg = getCardThumbnail(a);
    if (!primaryImg) return;
    const img = document.getElementById('asset-card-img-' + a.id);
    if (img) img.src = primaryImg;
  });
}

function renderAssetCard(a) {
  const typeTag = `<span class="asset-type-tag tag-${a.type}">${TYPE_ICONS[a.type]} ${TYPE_LABELS[a.type]}</span>`;
  const primaryImg = getCardThumbnail(a);
  const imgHTML = primaryImg
    ? `<img class="asset-img-thumb" id="asset-card-img-${a.id}" data-src-pending="1" alt="${escHtml(a.name)}">`
    : '';

  // Build meta snippets
  const metaParts = [];
  if (a.era)         metaParts.push(truncate(a.era, 24));
  if (a.period)      metaParts.push(truncate(a.period, 24));
  if (a.region)      metaParts.push(truncate(a.region, 24));
  if (a.material)    metaParts.push(truncate(a.material, 20));
  if (a.movement)    metaParts.push(truncate(a.movement, 24));
  if (a.atmosphere)  metaParts.push(truncate(a.atmosphere, 20));
  if (a.role)        metaParts.push(truncate(a.role, 20));

  const metaHTML = metaParts.length
    ? `<div class="asset-card-meta">${metaParts.slice(0,2).map(m => `<span>· ${escHtml(m)}</span>`).join('')}</div>`
    : '';

  const isShared = SHARED_LIBRARY_TYPES.includes(a.type);
  const createdByHTML = (isShared && a.createdBy)
    ? `<span class="asset-createdby-tag" style="font-size:0.68rem;color:var(--ink-lt);margin-left:6px;">by ${escHtml(a.createdBy)}</span>`
    : '';

  let usedToggleHTML = '';
  if (isShared) {
    const p = getCurrentProject();
    const linked = !!(p && p.linkedAssets && p.linkedAssets[a.type] && p.linkedAssets[a.type].includes(a.id));
    usedToggleHTML = `
      <label class="asset-used-toggle" style="display:flex;align-items:center;gap:6px;font-size:0.74rem;color:var(--ink-mid);margin-top:6px;cursor:pointer;">
        <input type="checkbox" ${linked ? 'checked' : ''} onchange="toggleProjectAssetLink('${a.id}','${a.type}',this.checked)">
        Used in this project
      </label>`;
  }

  return `
    <div class="asset-card">
      <div class="asset-card-header">
        <div class="asset-card-name">${escHtml(a.name)}${createdByHTML}</div>
        <div class="asset-card-actions">
          <button class="asset-card-action-edit" onclick="openAssetModal('${a.id}', '${a.type}')">Edit</button>
          <button class="asset-card-action-delete" onclick="deleteAsset('${a.id}')">Delete</button>
        </div>
      </div>
      ${typeTag}
      ${imgHTML}
      <div class="asset-card-desc">${escHtml(a.description)}</div>
      ${metaHTML}
      ${usedToggleHTML}
    </div>`;
}

/* Toggle whether a shared-library asset is linked into the current project.
   Optimistic update: apply locally + re-render immediately, then confirm
   with the server; revert and toast on failure. */
async function toggleProjectAssetLink(assetId, type, shouldLink) {
  const p = getCurrentProject();
  if (!p) return;
  if (!p.linkedAssets) p.linkedAssets = {};
  if (!p.linkedAssets[type]) p.linkedAssets[type] = [];

  const prevLinked = p.linkedAssets[type].includes(assetId);
  if (shouldLink && !prevLinked) {
    p.linkedAssets[type].push(assetId);
  } else if (!shouldLink && prevLinked) {
    p.linkedAssets[type] = p.linkedAssets[type].filter(id => id !== assetId);
  }
  renderAssetGrid();
  renderLibraryView();

  const action = shouldLink ? 'link_project_asset' : 'unlink_project_asset';
  const res = await apiCall(action, { project_id: p.id, type, asset_id: assetId });

  if (!res || !res.project) {
    // Revert optimistic update
    if (shouldLink) {
      p.linkedAssets[type] = p.linkedAssets[type].filter(id => id !== assetId);
    } else {
      p.linkedAssets[type].push(assetId);
    }
    renderAssetGrid();
    renderLibraryView();
    showToast('Could not update — check server connection', 'error');
    return;
  }

  // Reconcile with server's authoritative copy.
  p.linkedAssets = res.project.linkedAssets;

  // Fable audit H4 root-cause fix (2026-07-08): newly linking a shared asset
  // into this project means Reference Panel/Storyboard/Single Frame may need
  // its real image right away, without waiting for the next project-switch-
  // triggered ensureLinkedLibraryImagesLoaded() pass. Fire-and-forget — a
  // missing reference image is already a gracefully-handled state
  // everywhere in this app ("no reference image — text only"), so this is
  // a best-effort speed-up, not something anything else needs to await.
  if (shouldLink && typeof fetchFullLibraryAssets === 'function') {
    fetchFullLibraryAssets(type, [assetId]);
  }
}

function updateNavBadge() {
  const p = getCurrentProject();
  const count = p ? Object.keys(p.assets).length : 0;
  const badge = document.getElementById('nav-badge-library');
  if (badge) badge.textContent = count;
}

// init() and saveState()/loadState() moved to 00-api.js

