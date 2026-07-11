/* ══════════════════════════════════════════════════════════════
   SEGMENT 4 — STORYBOARD
══════════════════════════════════════════════════════════════ */

/* ── SB STATE ────────────────────────────────────────────── */
const sbState = {
  panelCount: 4,
  platform: 'nb',
  aspectRatio: '16:9',   // default aspect ratio for all panels
  selectedAssets: {},
  panels: [],        // array of { beat, shotType, angle, composition, prompt, cameraNote }
  storyText: '',
  style: '', colour: '', camera: '',
  // Unsaved-changes tracking (added 2026-07-05, see development-practices.md
  // §5 — the no-autosave gap that lost a real storyboard on 2026-06-29 when
  // Claude wrongly told the user a refresh was "safe"). NOT a real autosave —
  // sbState.panels still only persists via sbSaveToSequence(). This is just
  // a minimal safety net: true whenever panels have been generated/edited
  // since the last successful save, checked by the beforeunload handler
  // below to warn before a refresh/close would silently discard them. Set
  // true in: Smart Split generation, onCompositionEdit(), regenPanelPrompt()
  // (06-scene-engine.js). Set false in: sbSaveToSequence()'s successful save
  // (10-sequences.js), resetStoryboard(), and loading a saved sequence's
  // snapshot back in (10-sequences.js). Doesn't try to catch every possible
  // micro-edit (e.g. a shot-type dropdown change alone) — covers the
  // realistic majority of paths, not a guarantee for every field.
  dirty: false
};

// Warn before a refresh/close/navigation-away would silently discard
// unsaved Storyboard panels. Browsers ignore custom returnValue text and
// show their own generic "Leave site? Changes may not be saved" message —
// setting returnValue to a non-empty string is still what triggers that
// native prompt across current browsers.
window.addEventListener('beforeunload', (e) => {
  if (sbState.dirty) {
    e.preventDefault();
    e.returnValue = 'You have unsaved Storyboard panels. Save to Sequence first, or they will be lost.';
    return e.returnValue;
  }
});

/* ── INIT STORYBOARD VIEW ────────────────────────────────── */
function initStoryboard() {
  const p = getCurrentProject();
  const noProj = document.getElementById('sb-no-project');
  const content = document.getElementById('sb-content');
  if (noProj) noProj.style.display = p ? 'none' : '';
  if (content) content.style.display = p ? '' : 'none';
  if (!p) return;
  const storyEl = document.getElementById('sb-story-text');
  if (storyEl && sbState.storyText) storyEl.value = sbState.storyText;
  analyseUnlinked(sbState.storyText || '');
  updateApiKeyIndicator();
  initSBOnboarding();
  // Warm up shared-library caches so @-mentions in the story/beat textareas
  // can resolve props/locations/eras/styles, not just characters.
  // See ensureLibraryCachesLoaded in 01-core.js.
  if (typeof ensureLibraryCachesLoaded === 'function') {
    ensureLibraryCachesLoaded().then(() => {
      analyseUnlinked(sbState.storyText || '');
    });
  }
}

/* ── STORYBOARD ONBOARDING BANNER ────────────────────────── */
function initSBOnboarding() {
  const dismissed = localStorage.getItem('S3_v7_sb_onboarding');
  const banner = document.getElementById('sb-onboarding-banner');
  if (!banner) return;
  banner.style.display = dismissed ? 'none' : '';
}

function dismissSBOnboarding() {
  localStorage.setItem('S3_v7_sb_onboarding', '1');
  const banner = document.getElementById('sb-onboarding-banner');
  if (banner) {
    banner.style.opacity = '0';
    banner.style.transition = 'opacity 200ms ease';
    setTimeout(() => { banner.style.display = 'none'; }, 210);
  }
}

