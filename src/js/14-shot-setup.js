/* ============================================================
   SS_Studio v7 — 14-shot-setup.js
   Shot Setup ("Spatial Blocking Diagram") — data model + save/reload.
   Spec: 2026-07-06-spatial-blocking-diagram-spec.md

   Phase 3 of 4 (entry-point wiring added — see spec's own recommended
   build order):
     (1) DONE — data model, persistence, position resolver
     (2) DONE — standalone diagram UI (ring, camera cone, object markers,
         angle toggle). Live-verified end-to-end on real project data
         2026-07-06 (ring/cone/objects/angle-toggle/shots/save-reload all
         confirmed working; 2 live bugs found + fixed same session, see
         changelog v7.14.1/v7.14.2 — both were the same root cause:
         location/prop are SHARED_LIBRARY_TYPES, not p.assets).
     (3) DONE — Storyboard + Location Designer entry-point wiring.
         openShotSetupForPanel(panelIndex, locationId) — button in
         06-scene-engine.js's cameraFacingInnerHTML(), next to the existing
         "Camera faces" dropdown; picking/adding a shot drives that
         dropdown's selection (spec's "Output per panel" item 1), via
         shotSetupSyncCameraFacingToPanel(). openShotSetupForLocation(locationId)
         — button in 01-core.js's buildDirectionsSectionHTML() (Location
         Designer's Directions section). Console access (openShotSetupModal())
         still works unchanged for either entry point or a fresh setup.
     (4) DONE (2026-07-09) — prompt-text generation. findShotSetupForPanel()
         below + shotSetupNoteText() (06-scene-engine.js's buildPanelPrompt())
         write frame-left/right positions and Cross-Shot-Continuity-style
         reference-role labels into the linked panel's prompt, with a
         staged-generation caution when 2+ character objects share a shot —
         per the spec's live-testing findings, 2026-07-06. All 4 phases of
         this spec are now shipped.

   Single Frame port, phase 2 (2026-07-10, future-features.md backlog item,
   not part of the original 4-phase spec above — Single Frame's own
   direction-dropdown port was phase 1, v7.18.0). Single Frame has no panel
   array to index into (one current state at a time, not a sequence), so a
   shot's link to it is a plain boolean flag — shots[].linkedSingleFrame —
   instead of a panel-indexed linkedPanelId. At most one such shot is
   expected across the whole project at any time; see
   findShotSetupForSingleFrame() and findCrossSetupSingleFrameCollision()
   below. Entry point: openShotSetupForSingleFrame(locationId), button in
   02-singleframe.js's sfCameraFacingInnerHTML(), same placement as
   Storyboard's own Shot Setup button. Camera-direction sync reuses
   shotSetupSyncCameraFacingToPanel() (now branches on which context is
   active) driving setSFCameraFacingDirection() instead of
   setCameraFacingDirection(index, ...). Prompt-text generation reuses
   resolveAllPositionsForShot() exactly as Storyboard's shotSetupNoteText()
   does — see collectSFData()'s _shotSetupNote() (02-singleframe.js).

   Scoping decision (confirmed with user before this file was written):
   a shot setup is PROJECT-scoped, like sequences (10-sequences.js) —
   not a SHARED_LIBRARY_TYPES entry like location/prop/era/style.
   Reason: objects[] reference characters via assetId, and characters
   are project-scoped assets (p.assets), not shared-library assets.
   Mirrors sequences' state shape and load/save/delete pattern closely
   on purpose, including the "ensureLoaded" lazy-fetch guard — see
   10-sequences.js's ensureSequencesLoaded() comment for the exact bug
   that pattern fixes (stale/empty cache before a project's data has
   ever been fetched this session).

   getActiveProjectId(), apiCall(), showToast(), uid() are globals
   defined elsewhere (10-sequences.js / 00-api.js / 01-core.js) and
   reused here, not redeclared.
   ============================================================ */

/* ── SHOT SETUP STATE ────────────────────────────────────── */
const shotSetupState = {
  setups: {},             // { [setupId]: shotSetup }
  loadedForProject: null  // projectId this session's cache was last loaded for, or null if never loaded
};

/* shotSetup shape — spec's data model (2026-07-06-spatial-blocking-diagram-spec.md), unchanged:
{
  id, name, locationId,          // locationId links to a location asset with directions[]
  objects: [                     // max 4
    { id, label, type: 'character' | 'object', assetId (optional), stagePosition: 'frame-left' | 'center' | 'frame-right' }
  ],
  shots: [                        // one entry per camera position actually used
    {
      cameraDirectionIndex,         // raw position into the location's directions[] — fragile if reordered
      cameraDirectionName (optional), // added 2026-07-10 (backlog #4): the direction's name at save time,
                                       // used to re-resolve the correct direction after a reorder — see
                                       // resolveShotDirection()/resolveShotDirectionIndex(). Absent on shots
                                       // saved before this fix (falls back to index-only, unchanged behavior).
      cameraAngle: 'high' | 'eye-level' | 'low', linkedPanelId (optional),
      linkedSingleFrame (optional, boolean, added 2026-07-10 — Single Frame
        port phase 2): true if THIS shot is the one currently driving Single
        Frame's Camera faces dropdown + prompt text. Single Frame has one
        current state, not an array of panels, so this is a flag rather than
        an index like linkedPanelId. At most one shot across the WHOLE
        project is expected to carry this — see
        findCrossSetupSingleFrameCollision().
      positionOverrides: { objectId: stagePosition, only for objects that moved since the last shot }
    }
  ]
}
*/

const SHOT_SETUP_MAX_OBJECTS = 4;
const SHOT_SETUP_STAGE_POSITIONS = ['frame-left', 'center', 'frame-right'];
const SHOT_SETUP_CAMERA_ANGLES = ['high', 'eye-level', 'low'];

/* ── CONSTRUCTORS ────────────────────────────────────────── */
function newShotSetup(name, locationId) {
  return {
    id: null,               // server-assigned on first save, same as sequences (10-sequences.js)
    name: name || 'Untitled shot setup',
    locationId: locationId || null,
    objects: [],
    shots: []
  };
}

function newShotSetupObject(label, type, assetId, stagePosition) {
  return {
    id: 'obj_' + uid(),
    label: label || '',
    type: type === 'object' ? 'object' : 'character',
    assetId: assetId || null,
    stagePosition: SHOT_SETUP_STAGE_POSITIONS.includes(stagePosition) ? stagePosition : 'center'
  };
}

function newShotSetupShot(cameraDirectionIndex, cameraAngle, linkedPanelId, cameraDirectionName) {
  return {
    cameraDirectionIndex: cameraDirectionIndex || 0,
    // Resilience hint against directions[] reordering — backlog #4 (2026-07-10),
    // see resolveShotDirection()'s comment. Not currently passed by any
    // caller (addPendingShotToSequence() builds shots inline, not via this
    // constructor), included here so this stays the correct shape if a
    // future caller uses it.
    cameraDirectionName: cameraDirectionName || null,
    cameraAngle: SHOT_SETUP_CAMERA_ANGLES.includes(cameraAngle) ? cameraAngle : 'eye-level',
    linkedPanelId: linkedPanelId || null,
    positionOverrides: {}
  };
}

/* ── HELPERS ─────────────────────────────────────────────── */
function shotSetupById(id) {
  return shotSetupState.setups[id] || null;
}

/* Resolves a shot's actual direction against the CURRENT directions[] list —
   added 2026-07-10 (backlog #4). cameraDirectionIndex is a raw array
   position, stable only as long as a location's directions[] is never
   reordered; reordering silently misdirects every shot that references an
   index past the reorder point (same fragility class as the already-
   accepted linkedPanelId-breaks-on-reorder tradeoff, just on the direction
   side). Shots saved from this point on also carry cameraDirectionName —
   the direction's name at the moment the shot was added/updated — as a
   resilience hint. If that name still exists anywhere in the CURRENT
   directions[] list, it wins over the raw index, so reordering no longer
   silently misdirects. Mirrors the pattern already used for the panel-level
   "Camera faces" dropdown (06-scene-engine.js's cameraFacingInnerHTML(),
   which stores/matches by direction NAME, never by index) — this brings
   Shot Setup's own diagram/shots-list up to the same standard. Older shots
   saved before this fix have no cameraDirectionName and fall back to the
   original index-only behavior unchanged (no regression, but no new
   protection either — same known limitation, just for legacy data). */
function resolveShotDirection(directions, cameraDirectionIndex, cameraDirectionName) {
  if (!Array.isArray(directions) || !directions.length) return null;
  if (cameraDirectionName) {
    const byName = directions.find(d => d.name === cameraDirectionName);
    if (byName) return byName;
  }
  return directions[cameraDirectionIndex] || null;
}

// Same resolution as resolveShotDirection(), returning the CURRENT index
// instead of the direction object — needed wherever code needs a position
// into directions[] rather than the direction's own fields (ring
// highlighting, or re-deriving cameraDirectionIndex when a shot is loaded
// back into the composer after a possible reorder).
function resolveShotDirectionIndex(directions, cameraDirectionIndex, cameraDirectionName) {
  if (!Array.isArray(directions) || !directions.length) return cameraDirectionIndex;
  if (cameraDirectionName) {
    const idx = directions.findIndex(d => d.name === cameraDirectionName);
    if (idx !== -1) return idx;
  }
  return cameraDirectionIndex;
}

/* List shot setups for the current project, optionally filtered to one
   location — the Location Designer entry point (phase 3) wants "setups
   for this location" specifically, not every setup in the project. */
function listShotSetups(locationId) {
  const all = Object.values(shotSetupState.setups);
  return locationId ? all.filter(s => s.locationId === locationId) : all;
}

/* ── RESOLVE OBJECT POSITION FOR A GIVEN SHOT ─────────────────
   Walk backward from shotIndex to the most recent positionOverrides
   entry for this object; fall back to the object's base stagePosition
   if no shot up to and including shotIndex ever overrode it. This is
   the "per-shot override, carry-forward otherwise" rule from the spec's
   decision #2 — already validated in the sandbox's node smoke test
   (Sandbox/2026-07-06-spatial-blocking-sandbox-readme.md, "Verified
   before handoff"): frame positions swap correctly on override and
   carry forward correctly to a later un-overridden shot. Reimplemented
   here for the real app, not copy-pasted from the sandbox file (that
   file is a standalone prototype, not a shared module). */
function resolveObjectPosition(setup, shotIndex, objectId) {
  if (!setup || !Array.isArray(setup.shots) || !setup.shots.length) {
    const obj = (setup?.objects || []).find(o => o.id === objectId);
    return obj ? obj.stagePosition : null;
  }
  const startIdx = Math.min(shotIndex, setup.shots.length - 1);
  for (let i = startIdx; i >= 0; i--) {
    const shot = setup.shots[i];
    if (shot && shot.positionOverrides &&
        Object.prototype.hasOwnProperty.call(shot.positionOverrides, objectId)) {
      return shot.positionOverrides[objectId];
    }
  }
  const obj = (setup.objects || []).find(o => o.id === objectId);
  return obj ? obj.stagePosition : null;
}

/* Resolve every object's position at once for a given shot — convenience
   wrapper the diagram UI (phase 2) and prompt-text generation (phase 4)
   both need ("everyone's position right now"), rather than one object
   at a time. */
function resolveAllPositionsForShot(setup, shotIndex) {
  const result = {};
  (setup?.objects || []).forEach(obj => {
    result[obj.id] = resolveObjectPosition(setup, shotIndex, obj.id);
  });
  return result;
}

/* Given a Storyboard panel index, find the shot setup + shot entry linked
   to it via shots[].linkedPanelId (set by addPendingShotToSequence() below
   when a shot setup was opened via openShotSetupForPanel()). Searches
   every shot setup loaded for the current project — a panel is expected
   to be linked to at most one shot, in one setup, at a time; the first
   match wins if that's ever violated. Same "panel INDEX, not a stable id"
   limitation as linkedPanelId itself (see this file's header comment +
   openShotSetupModal()'s panelContext comment) — breaks if panels are
   reordered/inserted/deleted after linking, same known tradeoff already
   accepted for the live Camera-faces-dropdown sync this shares its data
   with. Used by buildPanelPrompt() (06-scene-engine.js), phase 4
   (2026-07-09) — the one function phase 4 actually needed that didn't
   already exist; resolveAllPositionsForShot() above was already built
   with phase 4 in mind. */
function findShotSetupForPanel(panelIndex) {
  const setups = Object.values(shotSetupState.setups);
  for (const setup of setups) {
    // Search from the end: prefer the MOST RECENTLY ADDED matching shot
    // within this setup, not the first. Fixed 2026-07-10 (backlog #1) —
    // findIndex() always grabbed the oldest match, so "fixing" a stale/
    // duplicate shot by re-adding a corrected one had no visible effect
    // until the original was manually deleted. addPendingShotToSequence()'s
    // new in-place-edit path avoids creating true duplicates going forward,
    // but this guards existing/legacy duplicate data too. Still first-SETUP-
    // wins across different setups (backlog #5, not this fix's scope).
    const shots = setup.shots || [];
    let shotIndex = -1;
    for (let i = shots.length - 1; i >= 0; i--) {
      if (shots[i].linkedPanelId === panelIndex) { shotIndex = i; break; }
    }
    if (shotIndex !== -1) return { setup, shotIndex };
  }
  return null;
}

/* Single Frame equivalent of findShotSetupForPanel() above — Single Frame
   port phase 2 (2026-07-10). Single Frame has no panel array to index into
   (one current state, not a sequence of panels), so this looks for the
   shot flagged shots[].linkedSingleFrame === true instead of matching a
   panel index. At most one such shot is expected across every setup in
   the project (enforced at save time, not here — see
   findCrossSetupSingleFrameCollision()); this still searches each setup's
   shots from the end (same defensive "most recent wins" convention as
   findShotSetupForPanel(), in case that invariant is ever violated by
   legacy/edge-case data) and returns the first setup with a match. Used by
   collectSFData()'s _shotSetupNote() (02-singleframe.js). */
function findShotSetupForSingleFrame() {
  const setups = Object.values(shotSetupState.setups);
  for (const setup of setups) {
    const shots = setup.shots || [];
    let shotIndex = -1;
    for (let i = shots.length - 1; i >= 0; i--) {
      if (shots[i].linkedSingleFrame === true) { shotIndex = i; break; }
    }
    if (shotIndex !== -1) return { setup, shotIndex };
  }
  return null;
}

/* ── LOAD SHOT SETUPS FROM SERVER ─────────────────────────── */
async function loadShotSetups() {
  const projectId = getActiveProjectId();
  if (!projectId) return;

  const res = await apiCall('load_shot_setups', { project_id: projectId });
  if (!res) return;

  shotSetupState.setups = {};
  (res.shot_setups || []).forEach(setup => {
    shotSetupState.setups[setup.id] = setup;
  });
  shotSetupState.loadedForProject = projectId;
}

/* ── ENSURE LOADED (on-demand, once per active project per session) ──
   Same lazy-load guard as ensureSequencesLoaded() (10-sequences.js) —
   see that function's comment for the exact bug this pattern avoids:
   reading a module's cache before it's ever been fetched for the active
   project looks like "nothing saved yet" even when data exists on the
   server. Re-checks loadedForProject so switching projects re-fetches,
   but repeated calls within the same project don't re-fetch every time. */
async function ensureShotSetupsLoaded() {
  const projectId = getActiveProjectId();
  if (!projectId) return;
  if (shotSetupState.loadedForProject === projectId) return;
  await loadShotSetups();
}

/* ── SAVE SHOT SETUP ─────────────────────────────────────── */
async function saveShotSetupNow(setupData) {
  const projectId = getActiveProjectId();
  if (!projectId) {
    if (typeof showToast === 'function') showToast('Select a project first', 'error');
    return null;
  }
  if ((setupData.objects || []).length > SHOT_SETUP_MAX_OBJECTS) {
    if (typeof showToast === 'function') showToast(`Shot setups support up to ${SHOT_SETUP_MAX_OBJECTS} objects/characters`, 'error');
    return null;
  }
  const res = await apiCall('save_shot_setup', { project_id: projectId, shot_setup: setupData });
  if (!res) return null;
  const setup = res.shot_setup;
  shotSetupState.setups[setup.id] = setup;
  return setup;
}

/* ── DELETE SHOT SETUP ────────────────────────────────────── */
async function deleteShotSetupNow(setupId) {
  const projectId = getActiveProjectId();
  if (!projectId) return false;
  const ok = await apiCall('delete_shot_setup', { project_id: projectId, shot_setup_id: setupId });
  if (ok) delete shotSetupState.setups[setupId];
  return !!ok;
}

/* UI entry point for deleteShotSetupNow() — added 2026-07-10 (backlog #2).
   The function itself already existed but had no way to reach it except
   the browser console; now surfaced as a "Delete setup" button in the
   modal footer (renderShotSetupModal()), shown only for an already-saved
   setup (draft.id truthy — a brand-new unsaved draft has nothing to
   delete server-side yet). Looks the name up fresh from shotSetupState
   rather than threading it through the onclick attribute, to sidestep
   quote-escaping in setup names. Matches the confirm()-then-delete pattern
   already used for sequences (10-sequences.js's confirmDeleteSequence()). */
async function confirmDeleteShotSetup(setupId) {
  const setup = shotSetupById(setupId);
  const name = setup ? setup.name : 'this shot setup';
  if (!confirm(`Delete shot setup "${name}"? This cannot be undone.`)) return;
  const ok = await deleteShotSetupNow(setupId);
  if (ok) {
    if (typeof showToast === 'function') showToast('Shot setup deleted', 'success');
    closeShotSetupModal();
  } else {
    if (typeof showToast === 'function') showToast('Could not delete — check server connection', 'error');
  }
}

/* ============================================================
   PHASE 2 — STANDALONE DIAGRAM UI
   Ring of positions, camera marker/FOV cone, up to 4 object/character
   markers, High/Eye-level/Low camera-angle toggle. Per the spec's
   recommended build order (2026-07-06-spatial-blocking-diagram-spec.md,
   "Recommendation"), this is the piece with no existing precedent in
   the codebase — nothing else here draws a compass ring or a cone.

   Reachable THIS PHASE ONLY via the console: openShotSetupModal() or
   openShotSetupModal(setupId). Deliberately no nav button / entry
   point yet — the two real entry points (Storyboard panel editor,
   Location Designer asset form) are phase 3. Confirmed with user
   2026-07-06 before writing this section.

   escHtml(), openModal(), closeModal(), getCurrentProject(),
   getEffectiveAssets(), ensureLibraryCachesLoaded() are globals from
   01-core.js, reused here. Locations resolve via getEffectiveAssets()
   specifically, NOT p.assets/getCurrentProject() directly — location is
   a SHARED_LIBRARY_TYPES asset (like prop/era/style), only characters
   live in p.assets. See shotSetupLocationOptions()'s comment below for
   the bug this caused when first written.
   ============================================================ */

/* ── PURE GEOMETRY HELPERS (unit-tested — see test_shot_setup.js) ──
   These are the only genuinely new math in the app: everything else
   (frame-left/center/frame-right, directions[] order) reuses existing
   house conventions unchanged. Kept pure (plain in/out, no DOM) so
   they can be verified the same way phase 1's resolveObjectPosition()
   was — real shipped code loaded into a vm sandbox, not hand-copied. */

// CSS percent (of the stage's own width) for each house stage position.
// Not evenly thirds (0/50/100) on purpose — a small inset keeps markers
// off the stage's own border at the frame-left/frame-right extremes.
const SHOT_SETUP_STAGE_PERCENT = { 'frame-left': 20, 'center': 50, 'frame-right': 80 };
function stagePositionPercent(stagePosition) {
  return Object.prototype.hasOwnProperty.call(SHOT_SETUP_STAGE_PERCENT, stagePosition)
    ? SHOT_SETUP_STAGE_PERCENT[stagePosition]
    : SHOT_SETUP_STAGE_PERCENT.center;
}

// Ring positions are evenly spaced around a circle, clockwise, starting
// at the top (index 0 = 12 o'clock = angle 0). Matches directions[]'s
// existing clockwise order (Location Designer v1) — no new ordering
// convention introduced. Per the spec's decision #1, no cap on total —
// however many directions the linked location has, this just divides
// the circle by that count.
function ringAngleForIndex(index, total) {
  if (!total || total < 1) return 0;
  return ((360 / total) * index) % 360;
}

// CSS left/top percent (of a square container) for a ring marker at a
// given index — plain trig on a fixed circle, not real perspective/
// camera geometry (explicitly out of scope, spec's "Explicitly out of
// scope" section). radiusPercent stays inside 50% so markers clear the
// container edge with their own width accounted for by the caller's
// translate(-50%,-50%).
function ringPositionStyle(index, total, radiusPercent) {
  if (typeof radiusPercent !== 'number') radiusPercent = 42;
  const angleDeg = ringAngleForIndex(index, total);
  const rad = (angleDeg * Math.PI) / 180;
  const left = 50 + radiusPercent * Math.sin(rad);
  const top = 50 - radiusPercent * Math.cos(rad);
  return { left, top, angleDeg };
}

// Degrees to CSS rotate() the camera FOV cone shape so its apex stays
// pinned to the camera's ring position while its flared base keeps
// pointing at the ring's center, for any ring position. Relies on the
// cone shape (14-shot-setup CSS, plain border-triangle div, no SVG/
// canvas — matches the app's existing plain HTML/CSS/JS stack) having
// a neutral/unrotated orientation that already points straight down —
// i.e. exactly what a camera placed at the very top of the ring
// (index whose angle is 0) needs. Rotating by that same placement
// angle keeps the apex anchored and sweeps the base to match any other
// position. Hand-verified for the 4 cardinal cases before writing the
// render code (see test_shot_setup.js) — this is intentionally just
// ringAngleForIndex() again, kept as its own named function because it
// answers a different question ("how far to rotate the cone shape")
// than ringAngleForIndex ("where does the marker sit"), even though the
// two happen to be numerically identical for this particular shape.
function cameraConeRotationDeg(index, total) {
  return ringAngleForIndex(index, total);
}

/* Resolve an object's position for the shot currently being composed
   (shotSetupUIState.pending, not yet pushed into setup.shots) — an
   explicit override on `pending` wins, otherwise carry forward from the
   last shot already in setup.shots, otherwise the object's own base
   stagePosition. Same "override wins, else carry forward" rule as
   resolveObjectPosition() above, just applied one shot further out
   (the shot that doesn't exist yet). Pure given plain setup/pending
   objects — no DOM — so it's unit-tested alongside the geometry helpers. */
function resolvePendingObjectPosition(setup, pending, objectId) {
  if (pending && pending.positionOverrides &&
      Object.prototype.hasOwnProperty.call(pending.positionOverrides, objectId)) {
    return pending.positionOverrides[objectId];
  }
  if (setup && Array.isArray(setup.shots) && setup.shots.length) {
    return resolveObjectPosition(setup, setup.shots.length - 1, objectId);
  }
  const obj = (setup?.objects || []).find(o => o.id === objectId);
  return obj ? obj.stagePosition : null;
}

/* ── UI STATE ────────────────────────────────────────────────
   draft: a working COPY of the shot setup being edited (deep-cloned on
   open so Cancel never mutates already-saved state — same reasoning as
   every asset-form edit elsewhere in the app).
   pending: the shot currently being composed — camera direction/angle
   and any position overrides for it — not yet appended to draft.shots.
   "Add this shot to the sequence" (sandbox's own wording, reused here)
   pushes a copy of `pending` onto draft.shots and resets its overrides,
   matching the spec's decision #2 (per-shot override, carry forward
   otherwise) and the sandbox's already-validated UX. */
const shotSetupUIState = {
  draft: null,
  pending: null,
  previewShotIndex: -1,  // index into draft.shots last loaded into `pending`, for the shots-list highlight only
  // Phase 3 (2026-07-06): set to a Storyboard panel INDEX when the modal was
  // opened via openShotSetupForPanel(), null otherwise (console-only opens,
  // or opened via openShotSetupForLocation()). Index-based, not a stable
  // panel id — Storyboard panels have no id field of their own (only array
  // position), so this link breaks if panels are later reordered/inserted/
  // deleted. Acceptable for what this is used for: a live, same-session
  // "drive that panel's Camera faces dropdown" sync, not a persisted
  // reference anyone reads back later. shots[].linkedPanelId inherits the
  // same limitation when set from here — see addPendingShotToSequence().
  panelContext: null,
  // Single Frame port phase 2 (2026-07-10) — true when the modal was opened
  // via openShotSetupForSingleFrame(), false otherwise. Deliberately a
  // separate field rather than overloading panelContext (e.g. a sentinel
  // string) — panelContext's number-vs-null typing is checked all over this
  // file (typeof ctx === 'number'), and Single Frame has no index to give
  // it anyway. Mutually exclusive with panelContext being a number in
  // practice (one entry point sets one, the other sets the other), but
  // both are always reset together (closeShotSetupModal(),
  // openShotSetupModal()) so nothing depends on that exclusivity holding.
  singleFrameContext: false,
  // Index into draft.shots currently loaded for in-place editing, or null
  // when the composer holds a not-yet-added new shot. Added 2026-07-10
  // (backlog #1) — set by loadShotSetupShotIntoPending(), consumed by
  // addPendingShotToSequence() (overwrite draft.shots[editingShotIndex]
  // instead of appending), cleared by startNewShotInComposer() and on
  // modal open/switch/close. See loadShotSetupShotIntoPending()'s comment
  // for why this replaces the earlier "deliberately not in-place" scoping.
  editingShotIndex: null
};

/* ── OPEN / CLOSE ────────────────────────────────────────────
   Console-callable, AND (phase 3) reachable via openShotSetupForPanel()/
   openShotSetupForLocation() below — see this file header + 06-scene-
   engine.js's cameraFacingInnerHTML() / 01-core.js's
   buildDirectionsSectionHTML() for the two real entry points. */
async function openShotSetupModal(setupId, panelContext, singleFrameFlag) {
  await ensureShotSetupsLoaded();
  // Locations are a shared-library type (SHARED_LIBRARY_TYPES, 01-core.js) —
  // its cache is normally warmed by whichever view the user visited first
  // (Single Frame/Storyboard init already call this). Console-invoked
  // openShotSetupModal() can't assume that happened, so warm it here too —
  // otherwise the location dropdown comes back empty even when the project
  // has locations (bug found live 2026-07-06, fixed same session).
  if (typeof ensureLibraryCachesLoaded === 'function') await ensureLibraryCachesLoaded();
  const existing = setupId ? shotSetupById(setupId) : null;
  // Deep copy: edits happen on this draft, only reach shotSetupState via
  // an explicit Save (saveShotSetupFromUI() below).
  shotSetupUIState.draft = existing ? JSON.parse(JSON.stringify(existing)) : newShotSetup();
  shotSetupUIState.panelContext = (typeof panelContext === 'number') ? panelContext : null;
  shotSetupUIState.singleFrameContext = !!singleFrameFlag;
  shotSetupUIState.editingShotIndex = null;

  const lastShot = shotSetupUIState.draft.shots[shotSetupUIState.draft.shots.length - 1];
  // Name-first resolution (backlog #4) — protects against a directions[]
  // reorder that happened since lastShot was saved.
  const openLoc = shotSetupResolveLocation(shotSetupUIState.draft.locationId);
  const openDirections = (openLoc && Array.isArray(openLoc.directions)) ? openLoc.directions : [];
  shotSetupUIState.pending = {
    cameraDirectionIndex: lastShot ? resolveShotDirectionIndex(openDirections, lastShot.cameraDirectionIndex, lastShot.cameraDirectionName) : 0,
    cameraAngle: lastShot ? lastShot.cameraAngle : 'eye-level',
    positionOverrides: {}
  };
  shotSetupUIState.previewShotIndex = shotSetupUIState.draft.shots.length - 1;

  renderShotSetupModal();
  if (typeof openModal === 'function') openModal('shot-setup-modal-overlay');
  // Opened in a panel's context with an existing shot already selected —
  // sync immediately so the Camera faces dropdown matches what's shown
  // here from the moment the modal opens, not just after the next click.
  shotSetupSyncCameraFacingToPanel();
}

/* Finds (most-recently-updated) or starts a shot setup for `locationId`,
   then opens it — the actual "entry point" wiring, as opposed to
   openShotSetupModal() itself which is the lower-level open/close pair.
   No chooser UI if more than one setup already exists for this location —
   phase 3 is scoped to wiring the two entry points, not building a picker
   component; the console (openShotSetupModal(id), listShotSetups(locationId))
   remains available to open a specific other one. */
async function shotSetupOpenForLocationId(locationId, panelContext, singleFrameFlag) {
  await ensureShotSetupsLoaded();
  const existing = listShotSetups(locationId);
  let setupId = null;
  if (existing.length) {
    setupId = existing.slice().sort((a, b) => (b.updated || 0) - (a.updated || 0))[0].id;
  }
  await openShotSetupModal(setupId, panelContext, singleFrameFlag);
  if (!setupId) {
    // Brand new setup — preset its location so the ring is ready
    // immediately instead of making the user re-pick what they just clicked.
    shotSetupUIState.draft.locationId = locationId;
    renderShotSetupModal();
  }
}

// Entry point: Location Designer asset form's Directions section
// (buildDirectionsSectionHTML(), 01-core.js).
async function openShotSetupForLocation(locationId) {
  await shotSetupOpenForLocationId(locationId, null);
}

// Entry point: Storyboard panel editor's "Camera faces" block
// (cameraFacingInnerHTML(), 06-scene-engine.js). panelIndex drives the
// live Camera-faces-dropdown sync — see shotSetupSyncCameraFacingToPanel().
async function openShotSetupForPanel(panelIndex, locationId) {
  await shotSetupOpenForLocationId(locationId, panelIndex);
}

// Entry point: Single Frame's "Camera faces" block (sfCameraFacingInnerHTML(),
// 02-singleframe.js) — Single Frame port phase 2 (2026-07-10). No panel
// index to pass (Single Frame has one current state, not a panel array);
// the true 3rd arg is what shotSetupSyncCameraFacingToPanel() and
// addPendingShotToSequence() key off of to drive Single Frame instead of a
// Storyboard panel.
async function openShotSetupForSingleFrame(locationId) {
  await shotSetupOpenForLocationId(locationId, null, true);
}

/* Drives the Storyboard panel's existing "Camera faces" dropdown
   (setCameraFacingDirection(), 06-scene-engine.js) from whatever direction
   is currently shown in the diagram — spec's "Output per panel" item 1:
   "Drives the existing Camera faces dropdown selection instead of the
   user picking it blind." Only fires when the modal was opened via
   openShotSetupForPanel() (shotSetupUIState.panelContext is a number);
   no-op for console-only or Location-Designer-opened sessions, where
   there's no panel to drive.

   Single Frame port phase 2 (2026-07-10): also drives Single Frame's own
   Camera-faces dropdown (setSFCameraFacingDirection(), 02-singleframe.js)
   when the modal was opened via openShotSetupForSingleFrame()
   (shotSetupUIState.singleFrameContext is true). The two contexts are
   checked as separate branches, not merged, since they call two entirely
   different setter functions with different signatures. */
function shotSetupSyncCameraFacingToPanel() {
  const draft = shotSetupUIState.draft;
  const pending = shotSetupUIState.pending;
  if (!draft || !pending) return;
  const loc = shotSetupResolveLocation(draft.locationId);
  const directions = (loc && Array.isArray(loc.directions)) ? loc.directions : [];
  const direction = directions[pending.cameraDirectionIndex];
  if (!direction) return;
  if (typeof shotSetupUIState.panelContext === 'number' && typeof setCameraFacingDirection === 'function') {
    setCameraFacingDirection(shotSetupUIState.panelContext, direction.name);
  } else if (shotSetupUIState.singleFrameContext && typeof setSFCameraFacingDirection === 'function') {
    setSFCameraFacingDirection(direction.name);
  }
}

function closeShotSetupModal() {
  if (typeof closeModal === 'function') closeModal('shot-setup-modal-overlay');
  shotSetupUIState.draft = null;
  shotSetupUIState.pending = null;
  shotSetupUIState.previewShotIndex = -1;
  shotSetupUIState.panelContext = null;
  shotSetupUIState.singleFrameContext = false;
  shotSetupUIState.editingShotIndex = null;
}

/* ── RENDER ──────────────────────────────────────────────────── */
/* Locations are a SHARED_LIBRARY_TYPES asset (like prop/era/style), not a
   project-scoped p.assets entry — see this file's own header comment on
   why shot setups themselves are project-scoped while objects[].assetId
   can point at either kind. getEffectiveAssets() (01-core.js) already
   does the right merge (project characters + this project's LINKED
   shared-library assets, keyed by id, same shape as p.assets) — bug
   found live 2026-07-06: an earlier draft of this file read p.assets
   directly and the location dropdown came back empty for every real
   project, since no location ever lives there. */
function shotSetupLocationOptions(draft) {
  const effective = typeof getEffectiveAssets === 'function' ? getEffectiveAssets() : {};
  const locs = Object.values(effective).filter(a => a.type === 'location');
  return locs.map(l => {
    const noDirections = !Array.isArray(l.directions) || !l.directions.length;
    return `<option value="${escHtml(l.id)}" ${draft.locationId === l.id ? 'selected' : ''}>${escHtml(l.name)}${noDirections ? ' (no directions set)' : ''}</option>`;
  }).join('');
}

/* Added 2026-07-09 after a live bug found the hard way: opening Shot
   Setup from the Location Designer entry point (openShotSetupForLocation())
   has no panel context, so any shot added there gets linkedPanelId: null
   and silently never drives any panel's prompt text — confirmed live via
   3 real saved shot setups, 2 of which had shots but null linkedPanelId
   because they'd been opened from the location asset's Directions section
   rather than from inside a Storyboard panel. This banner makes that
   distinction visible instead of discoverable only via the console. Panel
   numbers shown 1-based (panelContext is the 0-based panel index used
   everywhere else in this file/06-scene-engine.js) to match how panels
   are numbered elsewhere in the app (e.g. buildPanelPrompt()'s own
   "Panel N of totalPanels" text). */
function shotSetupPanelLinkBannerHTML() {
  const ctx = shotSetupUIState.panelContext;
  if (typeof ctx === 'number') {
    return `<div class="ss-panel-link-banner ss-panel-link-banner--linked">📍 Linked to Storyboard Panel ${ctx + 1} — shots you add and save here will drive that panel's Camera faces dropdown and prompt text.</div>`;
  }
  // Single Frame port phase 2 (2026-07-10) — third banner state, mirrors the
  // Storyboard-linked one above exactly, just naming Single Frame instead of
  // a panel number (it has no index to show).
  if (shotSetupUIState.singleFrameContext) {
    return `<div class="ss-panel-link-banner ss-panel-link-banner--linked">📍 Linked to Single Frame — shots you add and save here will drive Single Frame's Camera faces dropdown and prompt text.</div>`;
  }
  return `<div class="ss-panel-link-banner ss-panel-link-banner--unlinked">⚠ Not linked to any panel or to Single Frame. Shots added now will be saved but won't drive any prompt text — close this and open Shot Setup from inside a Storyboard panel's "Camera faces" section, or from Single Frame's, instead.</div>`;
}

/* "Saved setups for this location" picker — added 2026-07-09 after real
   live confusion: phase 3 explicitly scoped out a setup-chooser UI ("No
   chooser UI if more than one setup already exists for this location —
   phase 3 is scoped to wiring the two entry points, not building a
   picker component" — see openShotSetupForLocation()'s comment). That
   gap is exactly what caused today's confusion: with 2 real setups on
   one location and no way to see or choose between them, saves kept
   silently landing in "whichever was most recently updated" without the
   user ever realizing there was more than one. This closes that gap —
   opening still auto-selects the most-recently-updated setup as before
   (unchanged default), but this picker makes every setup for the current
   location visible, with its shot count, and switchable from inside the
   modal itself. */
function shotSetupPickerOptionsHTML(locationId, currentSetupId) {
  const setups = listShotSetups(locationId).slice().sort((a, b) => (b.updated || 0) - (a.updated || 0));
  const existingOptions = setups.map(s => {
    const n = (s.shots || []).length;
    return `<option value="${escHtml(s.id)}" ${s.id === currentSetupId ? 'selected' : ''}>${escHtml(s.name)} (${n} shot${n === 1 ? '' : 's'})</option>`;
  }).join('');
  return `<option value="" ${!currentSetupId ? 'selected' : ''}>— New setup —</option>${existingOptions}`;
}

// Swaps the modal's working draft to a different saved setup (or a fresh
// blank one) for the SAME location, without closing/reopening the modal.
// Keeps panelContext as-is — switching which setup you're looking at
// doesn't change which panel you opened Shot Setup from.
function switchShotSetupDraft(setupId) {
  const draft = shotSetupUIState.draft;
  if (!draft) return;
  const locationId = draft.locationId;
  shotSetupUIState.draft = setupId
    ? JSON.parse(JSON.stringify(shotSetupById(setupId) || newShotSetup('Untitled shot setup', locationId)))
    : newShotSetup('Untitled shot setup', locationId);
  const lastShot = shotSetupUIState.draft.shots[shotSetupUIState.draft.shots.length - 1];
  // Name-first resolution (backlog #4) — see resolveShotDirectionIndex()'s comment.
  const switchLoc = shotSetupResolveLocation(shotSetupUIState.draft.locationId);
  const switchDirections = (switchLoc && Array.isArray(switchLoc.directions)) ? switchLoc.directions : [];
  shotSetupUIState.pending = {
    cameraDirectionIndex: lastShot ? resolveShotDirectionIndex(switchDirections, lastShot.cameraDirectionIndex, lastShot.cameraDirectionName) : 0,
    cameraAngle: lastShot ? lastShot.cameraAngle : 'eye-level',
    positionOverrides: {}
  };
  shotSetupUIState.previewShotIndex = shotSetupUIState.draft.shots.length - 1;
  shotSetupUIState.editingShotIndex = null;
  renderShotSetupModal();
  shotSetupSyncCameraFacingToPanel();
}

function renderShotSetupModal() {
  const el = document.getElementById('shot-setup-modal-body');
  const draft = shotSetupUIState.draft;
  if (!el || !draft) { if (el) el.innerHTML = ''; return; }

  el.innerHTML = `
    <div class="ss-field-row">
      <div class="ss-field-col">
        <label class="field-label">Setup Name</label>
        <input type="text" class="input" id="ss-name-input" value="${escHtml(draft.name)}"
          placeholder="Shot setup name" oninput="shotSetupUIState.draft.name = this.value">
      </div>
      <div class="ss-field-col">
        <label class="field-label">Location</label>
        <select class="input" id="ss-location-select" onchange="setShotSetupLocation(this.value)">
          <option value="">— no location —</option>
          ${shotSetupLocationOptions(draft)}
        </select>
        ${draft.locationId ? `
        <label class="field-label" style="margin-top:6px;">Saved setups for this location</label>
        <select class="input" id="ss-setup-picker" onchange="switchShotSetupDraft(this.value)">
          ${shotSetupPickerOptionsHTML(draft.locationId, draft.id)}
        </select>` : ''}
      </div>
    </div>
    ${shotSetupPanelLinkBannerHTML()}
    <div class="ss-layout">
      <div class="ss-objects-col">
        <div class="sb-panel-section-label">Objects / characters (up to ${SHOT_SETUP_MAX_OBJECTS})</div>
        ${renderShotSetupObjectsList(draft)}
        <button class="btn btn-secondary btn-sm" type="button" onclick="addShotSetupObject()"
          ${draft.objects.length >= SHOT_SETUP_MAX_OBJECTS ? 'disabled' : ''}>＋ Add object/character</button>
      </div>
      <div class="ss-diagram-col">
        ${renderShotSetupDiagram(draft)}
      </div>
      <div class="ss-shots-col">
        <div class="sb-panel-section-label">Shots in this setup</div>
        ${renderShotSetupShotsList(draft)}
        ${renderShotSetupComposerButtonsHTML(draft)}
      </div>
    </div>
    <div class="ss-footer">
      ${draft.id ? `<button class="btn btn-danger btn-sm" type="button" onclick="confirmDeleteShotSetup('${escHtml(draft.id)}')">🗑 Delete setup</button>` : ''}
      <button class="btn btn-secondary" type="button" onclick="closeShotSetupModal()">Cancel</button>
      <button class="btn btn-primary" type="button" onclick="saveShotSetupFromUI()">Save shot setup</button>
    </div>`;
}

// Characters are project-scoped (p.assets) — unlike location, this one
// genuinely does live there (see shotSetupLocationOptions()'s comment).
function shotSetupCharacterOptions(currentAssetId) {
  const p = typeof getCurrentProject === 'function' ? getCurrentProject() : null;
  const chars = p ? Object.values(p.assets).filter(a => a.type === 'character') : [];
  return chars.map(c =>
    `<option value="${escHtml(c.id)}" ${currentAssetId === c.id ? 'selected' : ''}>${escHtml(c.name)}</option>`
  ).join('');
}

// Props ARE a shared-library type (like location) — linked subset via
// getEffectiveAssets(), same reasoning as shotSetupLocationOptions().
function shotSetupPropOptions(currentAssetId) {
  const effective = typeof getEffectiveAssets === 'function' ? getEffectiveAssets() : {};
  const props = Object.values(effective).filter(a => a.type === 'prop');
  return props.map(a =>
    `<option value="${escHtml(a.id)}" ${currentAssetId === a.id ? 'selected' : ''}>${escHtml(a.name)}</option>`
  ).join('');
}

// Each object/character gets its own colour, cycling through a fixed
// 4-entry palette (matches SHOT_SETUP_MAX_OBJECTS exactly, so every row
// gets a genuinely distinct colour, never a repeat) — applied to both
// its stage marker and its row in the objects list, so the two are
// visually linked at a glance. Colour is by LIST POSITION (index), not
// object identity, so it stays stable while editing but will shift if
// objects are reordered — acceptable since there's no reorder control
// yet (add/remove only).
function shotSetupMarkerColorClass(index) {
  return 'ss-marker-c' + (index % 4);
}

function renderShotSetupObjectsList(draft) {
  if (!draft.objects.length) {
    return '<div class="ss-ring-empty">No objects/characters yet.</div>';
  }
  return draft.objects.map((o, i) => {
    const effective = draft.shots.length
      ? resolvePendingObjectPosition(draft, shotSetupUIState.pending, o.id)
      : o.stagePosition;
    const posOptions = SHOT_SETUP_STAGE_POSITIONS.map(p =>
      `<option value="${p}" ${effective === p ? 'selected' : ''}>${p}</option>`).join('');
    // Link picker pulls from the right pool for the object's current type —
    // project characters (p.assets) or linked props (getEffectiveAssets).
    // "— custom, no link —" keeps the free-text label path fully working
    // for objects that aren't an existing library asset at all (spec's
    // assetId is explicitly optional).
    const linkOptions = o.type === 'character' ? shotSetupCharacterOptions(o.assetId) : shotSetupPropOptions(o.assetId);
    return `
      <div class="ss-object-row ${shotSetupMarkerColorClass(i)}">
        <select class="input" onchange="setShotSetupObjectAsset('${o.id}', this.value)">
          <option value="">— custom, no link —</option>
          ${linkOptions}
        </select>
        <div class="ss-object-row-top">
          <input type="text" class="input" value="${escHtml(o.label)}" placeholder="Label"
            oninput="setShotSetupObjectField('${o.id}','label',this.value)">
          <button class="btn btn-ghost btn-sm" type="button" title="Remove" onclick="removeShotSetupObject('${o.id}')">✕</button>
        </div>
        <select class="input" onchange="setShotSetupObjectField('${o.id}','type',this.value)">
          <option value="character" ${o.type === 'character' ? 'selected' : ''}>Character</option>
          <option value="object" ${o.type === 'object' ? 'selected' : ''}>Object</option>
        </select>
        <select class="input" onchange="setShotSetupObjectPosition('${o.id}', this.value)">
          ${posOptions}
        </select>
        <span class="field-hint">${draft.shots.length ? 'Position for the shot being composed' : 'Base position'}</span>
      </div>`;
  }).join('');
}
function shotSetupResolveLocation(locationId) {
  if (!locationId) return null;
  const effective = typeof getEffectiveAssets === 'function' ? getEffectiveAssets() : {};
  return effective[locationId] || null;
}

function renderShotSetupDiagram(draft) {
  const loc = shotSetupResolveLocation(draft.locationId);
  const directions = (loc && Array.isArray(loc.directions)) ? loc.directions : [];
  const pending = shotSetupUIState.pending || { cameraDirectionIndex: 0, cameraAngle: 'eye-level', positionOverrides: {} };

  let ringHTML = '<div class="ss-ring-empty">Link a location with directions to see the ring.</div>';
  let coneHTML = '';
  if (directions.length) {
    ringHTML = directions.map((d, i) => {
      const pos = ringPositionStyle(i, directions.length);
      const active = i === pending.cameraDirectionIndex;
      return `<button type="button" class="ss-ring-position${active ? ' active' : ''}"
        style="left:${pos.left}%; top:${pos.top}%;"
        onclick="setShotSetupCameraDirection(${i})">${escHtml(d.name)}</button>`;
    }).join('');

    const camIndex = Math.min(pending.cameraDirectionIndex, directions.length - 1);
    const camPos = ringPositionStyle(camIndex, directions.length);
    // -180: the cone shape's neutral orientation already points "down"
    // (see cameraConeRotationDeg()'s comment) — CSS rotate() needs the
    // offset from that neutral, not the raw compass angle.
    const cssRotate = cameraConeRotationDeg(camIndex, directions.length);
    coneHTML = `<div class="ss-camera-cone" style="left:${camPos.left}%; top:${camPos.top}%; transform: translateX(-50%) rotate(${cssRotate}deg);"></div>`;
  }

  const objectMarkersHTML = draft.objects.map((o, i) => {
    const stagePos = resolvePendingObjectPosition(draft, pending, o.id) || o.stagePosition;
    const pct = stagePositionPercent(stagePos);
    const initials = (o.label || '?').trim().slice(0, 2).toUpperCase() || '?';
    // Same colour class as this object's row in the objects list
    // (shotSetupMarkerColorClass()) — visually links marker <-> row.
    return `<div class="ss-stage-marker ${shotSetupMarkerColorClass(i)}" style="left:${pct}%;" title="${escHtml(o.label)} — ${stagePos}">${escHtml(initials)}</div>`;
  }).join('');

  const hasImage = !!(loc && Array.isArray(loc.images) && loc.images.length);
  const angleCaveat = hasImage
    ? `<div class="field-hint ss-angle-caveat">This location has a reference photo — live testing found a fixed-angle photo tends to override angle text, so this toggle may have limited visible effect for the selected direction (2026-07-06 findings, spatial-blocking-diagram-spec.md).</div>`
    : '';

  return `
    <div class="ss-ring-wrap">
      <div class="ss-ring">
        ${ringHTML}
        ${coneHTML}
        <div class="ss-stage">${objectMarkersHTML}</div>
      </div>
    </div>
    <div class="ss-angle-toggle">
      ${SHOT_SETUP_CAMERA_ANGLES.map(a => {
        const label = a === 'eye-level' ? 'Eye-level' : (a.charAt(0).toUpperCase() + a.slice(1));
        return `<button type="button" class="ss-angle-btn${pending.cameraAngle === a ? ' active' : ''}" onclick="setShotSetupCameraAngle('${a}')">${label}</button>`;
      }).join('')}
    </div>
    ${angleCaveat}`;
}

function renderShotSetupShotsList(draft) {
  if (!draft.shots.length) {
    return '<div class="ss-ring-empty">No shots added yet.</div>';
  }
  const loc = shotSetupResolveLocation(draft.locationId);
  const directions = (loc && Array.isArray(loc.directions)) ? loc.directions : [];

  return draft.shots.map((s, i) => {
    // Name-first resolution (backlog #4) — see resolveShotDirection()'s
    // comment. Falls back to raw index for shots saved before this fix.
    const resolvedDir = resolveShotDirection(directions, s.cameraDirectionIndex, s.cameraDirectionName);
    const dirName = resolvedDir ? resolvedDir.name : ('Direction ' + s.cameraDirectionIndex);
    const active = i === shotSetupUIState.previewShotIndex;
    // Per-shot link status — added 2026-07-09 alongside the modal-level
    // banner above. A setup's shots can end up a MIX of linked and
    // unlinked over time (e.g. some added via the panel entry point,
    // others added later via the Location entry point on the same
    // setup) — the modal-level banner alone can't show that, only this
    // per-row label can. typeof s.linkedPanelId === 'number' check
    // mirrors the same check used everywhere else this field is read.
    // Single Frame port phase 2 (2026-07-10) — a shot can carry BOTH tags
    // (linked to a panel from one session, later also flagged for Single
    // Frame in another) since the two flags are independent fields; shown
    // together rather than one hiding the other, so that state stays
    // visible instead of silently dropping one link from view.
    const linkTags = [];
    if (typeof s.linkedPanelId === 'number') {
      linkTags.push(`<span class="ss-shot-row-link ss-shot-row-link--linked">→ Panel ${s.linkedPanelId + 1}</span>`);
    }
    if (s.linkedSingleFrame === true) {
      linkTags.push(`<span class="ss-shot-row-link ss-shot-row-link--linked">→ Single Frame</span>`);
    }
    const linkTag = linkTags.length ? linkTags.join(' ') : `<span class="ss-shot-row-link ss-shot-row-link--unlinked">(not linked)</span>`;
    return `
      <div class="ss-shot-row${active ? ' active' : ''}">
        <button type="button" class="ss-shot-row-label" onclick="loadShotSetupShotIntoPending(${i})">
          Shot ${i + 1}: ${escHtml(dirName)}, ${escHtml(s.cameraAngle)} ${linkTag}
        </button>
        <button class="btn btn-ghost btn-sm" type="button" title="Remove shot" onclick="removeShotSetupShot(${i})">✕</button>
      </div>`;
  }).join('');
}

/* Primary action button(s) under the shots list — added 2026-07-10 (backlog
   #1) alongside in-place editing. When editingShotIndex is set (a saved
   shot was clicked and is loaded in the composer), the primary action
   becomes "Update shot N" (overwrites in place) with a secondary escape
   hatch to add as a genuinely new shot instead; otherwise it's the
   original single "Add this shot to the sequence" button unchanged. */
function renderShotSetupComposerButtonsHTML(draft) {
  const editIdx = shotSetupUIState.editingShotIndex;
  if (typeof editIdx === 'number' && draft.shots[editIdx]) {
    return `
      <button class="btn btn-primary btn-sm" type="button" onclick="addPendingShotToSequence()">💾 Update shot ${editIdx + 1}</button>
      <button class="btn btn-ghost btn-sm" type="button" onclick="startNewShotInComposer()">＋ Add as new shot instead</button>`;
  }
  return `<button class="btn btn-primary btn-sm" type="button" onclick="addPendingShotToSequence()">＋ Add this shot to the sequence</button>`;
}

/* ── EVENT HANDLERS ──────────────────────────────────────────── */
// Warns before changing location on a setup with existing shots — added
// 2026-07-10 (backlog #3). cameraDirectionIndex is a raw array position
// into the LOCATION's directions[] list (see newShotSetupShot()'s comment
// and backlog #4 on this same fragility), not a stable direction name/id.
// Swapping the location out from under existing shots doesn't touch their
// stored index numbers, but silently changes what those numbers MEAN —
// index 2 might be "wide establishing shot" on the old location and
// "close-up on the door" on the new one. No warning existed for this
// before; now confirm() gives the user a chance to back out. Cancelling
// re-renders to snap the <select>'s displayed value back to draft.locationId,
// since the browser already changed the DOM selection before this handler
// ran (onchange fires post-selection, not pre-).
function setShotSetupLocation(locationId) {
  const draft = shotSetupUIState.draft;
  if (!draft) return;
  const newLocationId = locationId || null;
  if (newLocationId === draft.locationId) return;
  if (draft.shots.length > 0) {
    const n = draft.shots.length;
    const proceed = confirm(
      `This setup already has ${n} shot${n === 1 ? '' : 's'} referencing camera directions on the CURRENT location. Changing the location won't move or remap those shots — each one will keep pointing at the same direction position number, which may mean something completely different on the new location (e.g. "wide shot" could become "close-up on the door"). Continue anyway?`
    );
    if (!proceed) {
      renderShotSetupModal();
      return;
    }
  }
  draft.locationId = newLocationId;
  // Fetch-on-reference (2026-07-10) — picking a location here is a live
  // reference, same reasoning as toggleSFAsset()/buildPanelPrompt()'s own
  // fetch-on-reference calls. See ensureLinkedLibraryImagesLoaded()'s
  // comment (01-core.js) for why this matters now: the load-time prefetch
  // no longer covers every linked location automatically.
  if (newLocationId && typeof fetchAssetImageOnReference === 'function') {
    fetchAssetImageOnReference('location', newLocationId);
  }
  renderShotSetupModal();
}

function addShotSetupObject() {
  const draft = shotSetupUIState.draft;
  if (!draft) return;
  if (draft.objects.length >= SHOT_SETUP_MAX_OBJECTS) {
    if (typeof showToast === 'function') showToast(`Shot setups support up to ${SHOT_SETUP_MAX_OBJECTS} objects/characters`, 'warning');
    return;
  }
  draft.objects.push(newShotSetupObject('', 'character', null, 'center'));
  renderShotSetupModal();
}

function removeShotSetupObject(objectId) {
  const draft = shotSetupUIState.draft;
  if (!draft) return;
  draft.objects = draft.objects.filter(o => o.id !== objectId);
  if (shotSetupUIState.pending) delete shotSetupUIState.pending.positionOverrides[objectId];
  draft.shots.forEach(s => { if (s.positionOverrides) delete s.positionOverrides[objectId]; });
  renderShotSetupModal();
}

function setShotSetupObjectField(objectId, field, value) {
  const draft = shotSetupUIState.draft;
  const obj = draft && draft.objects.find(o => o.id === objectId);
  if (!obj) return;
  if (field === 'type' && value !== 'object' && value !== 'character') return;
  // Switching type changes which pool the link picker draws from
  // (characters vs. linked props) — an assetId from the old pool would
  // no longer resolve to anything sensible, so clear it rather than
  // leave a stale, mismatched link.
  if (field === 'type' && value !== obj.type) obj.assetId = null;
  obj[field] = value;
  // Label edits re-render the diagram markers too (initials change) —
  // full re-render is simplest and this list is small (max 4 objects).
  renderShotSetupModal();
}

// Links (or unlinks, on empty value) an object row to an existing library
// asset — a project character (p.assets) or a linked prop (getEffectiveAssets),
// depending on the row's current type. Adopts the asset's name as the
// label (still freely editable afterward via setShotSetupObjectField).
function setShotSetupObjectAsset(objectId, assetId) {
  const draft = shotSetupUIState.draft;
  const obj = draft && draft.objects.find(o => o.id === objectId);
  if (!obj) return;
  obj.assetId = assetId || null;
  if (assetId) {
    const p = typeof getCurrentProject === 'function' ? getCurrentProject() : null;
    const effective = typeof getEffectiveAssets === 'function' ? getEffectiveAssets() : {};
    const asset = (p && p.assets[assetId]) || effective[assetId];
    if (asset && asset.name) obj.label = asset.name;
    // Fetch-on-reference (2026-07-10) — linking a prop here is a live
    // reference (see ensureLinkedLibraryImagesLoaded()'s comment, 01-core.js).
    // No-op for a character link — characters are project-owned (p.assets),
    // not a SHARED_LIBRARY_TYPES entry, and already have their real image.
    if (asset && obj.type === 'object' && typeof fetchAssetImageOnReference === 'function') {
      fetchAssetImageOnReference('prop', assetId);
    }
    // Backlog #6 (2026-07-10, minor/theoretical per the audit — not seen in
    // practice). Two objects sharing the same assetId would produce
    // duplicate "Image N: <name>, <position>, ... reference only." lines in
    // the generated prompt text (06-scene-engine.js's shotSetupNoteText(),
    // which keys purely by object, not by assetId uniqueness). Non-blocking
    // warning here rather than a hard block — there's no legitimate reason
    // to link the same character/prop twice, but nothing about doing so
    // corrupts saved data, only the generated prompt text, so this stays a
    // toast (matches the existing SHOT_SETUP_MAX_OBJECTS soft-limit toast
    // in addShotSetupObject()) rather than a confirm()-gated block.
    const duplicate = draft.objects.some(o => o.id !== objectId && o.assetId === assetId);
    if (duplicate && typeof showToast === 'function') {
      showToast(`${asset ? asset.name : 'This asset'} is already linked to another object in this setup — the generated prompt will list it twice`, 'warning');
    }
  }
  renderShotSetupModal();
}

// Single control per object row: before any shot exists yet, it edits
// the object's base stagePosition directly; once shots exist, it edits
// the pending (not-yet-added) shot's override instead — see the ss-object-row's
// field-hint, which reflects the same distinction back to the user.
function setShotSetupObjectPosition(objectId, stagePosition) {
  const draft = shotSetupUIState.draft;
  if (!draft || !SHOT_SETUP_STAGE_POSITIONS.includes(stagePosition)) return;
  if (!draft.shots.length) {
    const obj = draft.objects.find(o => o.id === objectId);
    if (obj) obj.stagePosition = stagePosition;
    renderShotSetupModal();
    return;
  }
  const pending = shotSetupUIState.pending;
  if (!pending) return;
  // Only store an override if it actually differs from what would carry
  // forward anyway — matches the spec's "only for objects that moved"
  // comment on positionOverrides (decision #2).
  const carried = resolveObjectPosition(draft, draft.shots.length - 1, objectId);
  if (stagePosition === carried) delete pending.positionOverrides[objectId];
  else pending.positionOverrides[objectId] = stagePosition;
  renderShotSetupModal();
}

function setShotSetupCameraDirection(index) {
  if (!shotSetupUIState.pending) return;
  shotSetupUIState.pending.cameraDirectionIndex = index;
  renderShotSetupModal();
  // Spec's "Output per panel" item 1 — this is the moment the user's
  // intent is clearest (they just clicked a ring position), so sync
  // immediately rather than waiting for "Add this shot to the sequence."
  shotSetupSyncCameraFacingToPanel();
}

function setShotSetupCameraAngle(angle) {
  if (!shotSetupUIState.pending || !SHOT_SETUP_CAMERA_ANGLES.includes(angle)) return;
  shotSetupUIState.pending.cameraAngle = angle;
  renderShotSetupModal();
}

function addPendingShotToSequence() {
  const draft = shotSetupUIState.draft;
  const pending = shotSetupUIState.pending;
  if (!draft || !pending) return;
  const editIdx = shotSetupUIState.editingShotIndex;
  const isInPlaceEdit = typeof editIdx === 'number' && draft.shots[editIdx];

  // Index-based, not a stable panel id — see shotSetupUIState.panelContext's
  // own comment on why. null when opened via console or from Location
  // Designer (openShotSetupForLocation()), where there's no panel at all.
  // When in-place editing a shot that already carries a linkedPanelId from
  // a DIFFERENT session (e.g. this composer has no panel context right
  // now, but the shot was originally linked from a panel), preserve that
  // existing link rather than clobbering it with null — only an explicit
  // panel context here should override it.
  const linkedPanelId = (typeof shotSetupUIState.panelContext === 'number')
    ? shotSetupUIState.panelContext
    : (isInPlaceEdit ? draft.shots[editIdx].linkedPanelId : null);

  // Single Frame port phase 2 (2026-07-10) — same "preserve an existing
  // link from a different session unless this session explicitly sets a
  // new one" reasoning as linkedPanelId above.
  const linkedSingleFrame = shotSetupUIState.singleFrameContext
    ? true
    : (isInPlaceEdit ? !!draft.shots[editIdx].linkedSingleFrame : false);

  // Resilience hint against future direction reordering — backlog #4, see
  // resolveShotDirection()'s comment. Resolved fresh here since pending's
  // camera direction was just set by clicking a live ring position.
  const loc = shotSetupResolveLocation(draft.locationId);
  const directions = (loc && Array.isArray(loc.directions)) ? loc.directions : [];
  const cameraDirectionName = directions[pending.cameraDirectionIndex] ? directions[pending.cameraDirectionIndex].name : null;

  const shotData = {
    cameraDirectionIndex: pending.cameraDirectionIndex,
    cameraDirectionName,
    cameraAngle: pending.cameraAngle,
    linkedPanelId,
    linkedSingleFrame,
    positionOverrides: Object.assign({}, pending.positionOverrides)
  };

  if (isInPlaceEdit) {
    // Overwrite in place — added 2026-07-10 (backlog #1). Previously this
    // always appended, so "fixing" a shot by re-loading and re-adding it
    // just created a duplicate, and findShotSetupForPanel()'s first-match
    // behavior meant the stale original kept winning.
    draft.shots[editIdx] = shotData;
    shotSetupUIState.previewShotIndex = editIdx;
  } else {
    draft.shots.push(shotData);
    shotSetupUIState.previewShotIndex = draft.shots.length - 1;
  }
  shotSetupUIState.editingShotIndex = null;
  // Next shot starts with a clean override set (carries forward from the
  // one just added/updated); camera direction/angle are left as-is since a
  // reverse-angle exchange often keeps the angle and only flips direction.
  shotSetupUIState.pending.positionOverrides = {};
  renderShotSetupModal();
}

// Explicit escape hatch — added 2026-07-10 alongside in-place editing.
// Clears editingShotIndex (without discarding whatever's currently in the
// composer) so the next "Add this shot to the sequence" appends a new shot
// instead of overwriting the one that was loaded for review.
function startNewShotInComposer() {
  shotSetupUIState.editingShotIndex = null;
  renderShotSetupModal();
}

function loadShotSetupShotIntoPending(shotIndex) {
  const draft = shotSetupUIState.draft;
  const shot = draft && draft.shots[shotIndex];
  if (!shot) return;
  // Loads a past shot's values back into the composer for review/tweak —
  // AND marks it for in-place editing (2026-07-10, backlog #1): the primary
  // button becomes "Update shot N" (renderShotSetupComposerButtonsHTML()),
  // overwriting draft.shots[shotIndex] instead of appending a duplicate.
  // Use "Add as new shot instead" (startNewShotInComposer()) to still
  // append a genuinely new shot from these starting values.
  // Resolve against the CURRENT directions[] list via cameraDirectionName
  // when available (backlog #4) — protects against a reorder that happened
  // since this shot was saved. Falls back to the raw stored index for
  // older shots with no cameraDirectionName yet.
  const loc = shotSetupResolveLocation(draft.locationId);
  const directions = (loc && Array.isArray(loc.directions)) ? loc.directions : [];
  const resolvedIndex = resolveShotDirectionIndex(directions, shot.cameraDirectionIndex, shot.cameraDirectionName);

  shotSetupUIState.pending = {
    cameraDirectionIndex: resolvedIndex,
    cameraAngle: shot.cameraAngle,
    positionOverrides: Object.assign({}, shot.positionOverrides)
  };
  shotSetupUIState.previewShotIndex = shotIndex;
  shotSetupUIState.editingShotIndex = shotIndex;
  renderShotSetupModal();
  shotSetupSyncCameraFacingToPanel();
}

function removeShotSetupShot(shotIndex) {
  const draft = shotSetupUIState.draft;
  if (!draft) return;
  draft.shots.splice(shotIndex, 1);
  if (shotSetupUIState.previewShotIndex >= draft.shots.length) {
    shotSetupUIState.previewShotIndex = draft.shots.length - 1;
  }
  // Keep editingShotIndex pointed at the same logical shot after a removal
  // shifts array indices — clear it if the removed shot was the one being
  // edited, decrement if a shot before it was removed.
  if (shotSetupUIState.editingShotIndex === shotIndex) {
    shotSetupUIState.editingShotIndex = null;
  } else if (typeof shotSetupUIState.editingShotIndex === 'number' && shotSetupUIState.editingShotIndex > shotIndex) {
    shotSetupUIState.editingShotIndex -= 1;
  }
  renderShotSetupModal();
}

/* Detects cross-setup linkedPanelId collisions — backlog #5 (2026-07-10).
   findShotSetupForPanel() (used by buildPanelPrompt()) only ever returns
   ONE match: the first SETUP (in object-key/creation order) that has a
   matching shot, most-recent-shot-within-that-setup (backlog #1 fix). If
   two DIFFERENT setups both have a shot linked to the same panel, the
   loser is silently ignored with no warning anywhere — exactly the finding
   this closes. Checked at SAVE time (not shot-add time) so it catches a
   collision regardless of how it was created (composer, or otherwise) and
   regardless of which setup is saved second. Scoped to WARN, not
   auto-resolve — same "surface, don't silently fix" pattern as backlog #3's
   location-change warning, since there's no single correct automatic
   resolution (either setup's claim on the panel could be the "right" one). */
function findCrossSetupPanelCollisions(draft) {
  const draftPanelIds = new Set(
    (draft.shots || [])
      .map(s => s.linkedPanelId)
      .filter(id => typeof id === 'number')
  );
  if (!draftPanelIds.size) return [];
  const collisions = [];
  Object.values(shotSetupState.setups).forEach(setup => {
    if (setup.id === draft.id) return; // this is the setup being saved, not "another" setup
    (setup.shots || []).forEach(s => {
      if (typeof s.linkedPanelId === 'number' && draftPanelIds.has(s.linkedPanelId)) {
        collisions.push({ setupName: setup.name, panelIndex: s.linkedPanelId });
      }
    });
  });
  return collisions;
}

/* Single Frame equivalent of findCrossSetupPanelCollisions() above — Single
   Frame port phase 2 (2026-07-10). Unlike panels (many, each with its own
   legitimate index), Single Frame has exactly one current state, so at most
   one shot linkedSingleFrame: true should exist across the WHOLE project.
   Same "surface, don't silently fix" philosophy as the panel version: WARN
   at save time rather than auto-clearing the other setup's flag, since this
   file has no established pattern yet for one save silently mutating a
   DIFFERENT setup's already-saved data (findCrossSetupPanelCollisions()
   deliberately doesn't do that either — see its own comment). Returns the
   OTHER setup's name if a collision exists, or null. */
function findCrossSetupSingleFrameCollision(draft) {
  const draftHasSingleFrameShot = (draft.shots || []).some(s => s.linkedSingleFrame === true);
  if (!draftHasSingleFrameShot) return null;
  const other = Object.values(shotSetupState.setups).find(setup =>
    setup.id !== draft.id && (setup.shots || []).some(s => s.linkedSingleFrame === true)
  );
  return other ? other.name : null;
}

async function saveShotSetupFromUI() {
  const draft = shotSetupUIState.draft;
  if (!draft) return;
  const collisions = findCrossSetupPanelCollisions(draft);
  if (collisions.length) {
    const lines = Array.from(new Set(collisions.map(c => `Panel ${c.panelIndex + 1} is also linked from "${c.setupName}"`)));
    const proceed = confirm(
      `This setup shares a panel link with another shot setup:\n${lines.join('\n')}\n\nOnly one setup's shot will actually drive that panel's prompt text — whichever this app happens to match first. Save anyway?`
    );
    if (!proceed) return;
  }
  const sfCollisionSetupName = findCrossSetupSingleFrameCollision(draft);
  if (sfCollisionSetupName) {
    const proceed = confirm(
      `Another shot setup ("${sfCollisionSetupName}") already has a shot linked to Single Frame. Only one can actually drive Single Frame's prompt text — whichever this app happens to match first. Save anyway?`
    );
    if (!proceed) return;
  }
  const saved = await saveShotSetupNow(draft);
  if (saved) {
    if (typeof showToast === 'function') showToast('Shot setup saved ✓', 'success');
    closeShotSetupModal();
  }
}
