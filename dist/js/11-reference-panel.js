/* ══════════════════════════════════════════════════════════════
   REFERENCE PANEL  (v7.2.0 — task #2)
   ──────────────────────────────────────────────────────────────
   Auto-opens after a storyboard finishes generating. For every
   panel/shot it shows which character/asset(s) are mentioned in
   that shot's beat text, and which actual reference image
   getImageForShot() resolves for that shot's framing — so the
   user can see (and grab) exactly what should be attached when
   generating the image on whichever platform they use.

   This does NOT change prompt assembly or buildPanelPrompt() —
   it is a read-only viewer/export layer on top of state that
   already exists (sbState.panels, getEffectiveAssets(),
   getImageForShot(), parseAtMentions()).

   Per-panel mentions are derived independently here via
   parseAtMentions(panel.beat) rather than reusing the whole-story
   `mentions` array baked into each panel at generation time
   (see task #11) — so this panel is already accurate per-shot
   even before #11 is fixed elsewhere.
   ══════════════════════════════════════════════════════════════ */

const refPanelState = {
  rows: [],          // [{ panelIndex, shotType, assetId, assetName, assetType, img, slotUsed, isFallback }]
  selected: new Set() // keys "panelIndex:assetId" selected for zip download
};

/* ── PERSPECTIVE ANCHOR (task #6 spec, 2026-06-24) ───────────────
   Distinct from the CONTINUITY ANCHOR above (isAnchor / "match Panel 1"),
   which is computed fresh every render and is never user-chosen. This is
   the opposite: the user explicitly marks ONE reference image per panel
   as the camera/perspective anchor — the image whose angle, height and
   lighting the rest of the shot should match — so a composited
   character/object stops coming out visually flat against a
   differently-angled background. Persisted on the panel object itself
   (panel.perspectiveAnchorAssetId) so it survives Regen/reload like any
   other panel field — every place sbState.panels gets spread-copied
   ({ ...p }), e.g. undo snapshots and save-state, already carries plain
   fields like this forward with no extra wiring needed.
   Named deliberately differently from isAnchor/anchorAssetId to avoid
   colliding with the unrelated continuity-anchor concept above. */
function setPerspectiveAnchor(panelIndex, assetId) {
  const panel = sbState.panels[panelIndex];
  if (!panel) return;
  // Exclusive per panel — picking a new anchor replaces any previous one,
  // and clicking the current anchor again clears it (back to today's
  // text-hint-only behavior, no regression).
  panel.perspectiveAnchorAssetId = (panel.perspectiveAnchorAssetId === assetId) ? null : assetId;
  refreshInlineReferenceStrip(panelIndex);
  // saveState() call REMOVED 2026-07-08 (Fable audit H2, see
  // 2026-07-08-fable-review-freeze-and-automation-audit.md): identical
  // wasted-effort twin of the call removed from setCameraFacingDirection()
  // in v7.15.4 — a blanket full-account resave (every project, every
  // asset's every photo) triggered on every star-click, persisting
  // nothing this field actually needs (perspectiveAnchorAssetId lives on
  // the panel object itself and already survives Regen/reload/undo via
  // the normal { ...panel } spread-copy, per this function's own comment
  // above — no server round-trip was ever required for it).
}

/* ── CONTINUITY ANCHOR RESOLUTION ────────────────────────────────
   Root cause behind "grid prompt looks more consistent than individual
   panels" (user-reported 2026-06-25): the grid is one single generation
   call that has every panel's reference images attached at once, so the
   model can see panel 1's character/location image while rendering panel
   4. Generating panels individually never attaches panel 1's image to
   later panels — buildPanelPrompt()'s continuityNote (06-scene-engine.js)
   only ever told the model "same as panel 1" in TEXT, with no image to
   back it up. A text instruction pointing at nothing the model can see is
   much weaker than an actual attached reference image, which is the real
   lever driving the grid's better consistency.

   Fix: surface panel 1's resolved character/location image(s) as an
   explicit second thing to attach on every later panel, so individual
   generation can carry forward a real visual anchor instead of relying on
   words alone. This mirrors what panel.masterValues (06-scene-engine.js,
   extractMasterValues()) already locks by NAME — resolved here to actual
   asset objects + images since masterValues only stores name strings. */
function resolveMasterAnchorAssets() {
  if (!sbState || !Array.isArray(sbState.panels) || !sbState.panels.length) return [];
  const panel0 = sbState.panels[0];
  const master = panel0 && panel0.masterValues;
  if (!master) return [];

  const assets = Object.values(getEffectiveAssets());
  const anchors = [];

  (master.characters || []).forEach(name => {
    const asset = assets.find(a => a.type === 'character' && a.name === name);
    if (asset) anchors.push(asset);
  });
  if (master.location) {
    const asset = assets.find(a => a.type === 'location' && a.name === master.location);
    if (asset) anchors.push(asset);
  }
  return anchors;
}

/* Build the row list from current sbState.panels. */
function buildReferencePanelRows() {
  const rows = [];
  if (!sbState || !Array.isArray(sbState.panels)) return rows;

  const anchorAssets = resolveMasterAnchorAssets();

  sbState.panels.forEach((panel, i) => {
    // Continuity anchor rows — panel 1's locked character/location image(s),
    // surfaced again on every later panel so the user attaches a REAL
    // reference image for "same as panel 1", not just a text instruction.
    if (i > 0 && anchorAssets.length) {
      const ownMentionIds = new Set(
        [...parseAtMentions([panel.beat || '', panel.composition || ''].join('\n')),
         ...(typeof parsePlainTextMentions === 'function' ? parsePlainTextMentions([panel.beat || '', panel.composition || ''].join('\n')) : [])]
        .map(m => m.asset.id)
      );
      // Bug fix 2026-06-29: this used to only EXCLUDE an anchor asset if
      // THIS panel already mentioned it directly (the old filter below was
      // `!ownMentionIds.has(a.id)`) — meaning every OTHER character from
      // panel 1's full cast still got offered as an attachable anchor row,
      // even on a panel whose own beat never names them. Confirmed via live
      // test: a 5-character panel 1 (4 people riding a flying wall) meant a
      // later solo-Changdev panel still showed all 4 others as anchor rows;
      // attaching them caused the model to render all 4 into a scene where
      // they had no narrative reason to appear. A character anchor should
      // only ever be offered if THIS panel's own beat/composition actually
      // mentions them — locations are exempt from this stricter check since
      // "same environment as panel 1" is legitimate scene-wide continuity
      // even when the location isn't re-named in every beat.
      anchorAssets.filter(a => a.type === 'location' || ownMentionIds.has(a.id)).forEach(asset => {
        // Fetch-on-reference (2026-07-10, Fable-review-caught gap) — a
        // continuity-anchor row is a live reference to this asset just as
        // much as an @mention is; without this, an anchor-only asset (never
        // directly @-mentioned in any panel) would never get its full image
        // fetched under the narrowed load-time prefetch. See
        // ensureLinkedLibraryImagesLoaded()'s comment (01-core.js).
        // .then(refreshReferencePanelIfOpen) — this row was built with
        // img:null (fetch was still pending); once the image lands, redraw
        // the modal so the row picks it up. fetchAssetImageOnReference()
        // returns null for an already-cached id, so this only fires for a
        // genuinely new fetch — see that function's comment (01-core.js)
        // for why that guard is what keeps this from looping forever.
        if (typeof fetchAssetImageOnReference === 'function') {
          const p = fetchAssetImageOnReference(asset.type, asset.id);
          if (p && typeof p.then === 'function') p.then(refreshReferencePanelIfOpen);
        }
        // Use panel 1's own framing to resolve the image, since that's the
        // exact image the model needs to match against — not this panel's
        // (likely different) shot type.
        const img = getImageForShot(asset, sbState.panels[0].shotType);
        const slotUsed = resolveSlotUsed(asset, sbState.panels[0].shotType);
        rows.push({
          panelIndex: i,
          shotType: panel.shotType,
          assetId: asset.id,
          assetName: asset.name,
          assetType: asset.type,
          img: img || null,
          slotUsed,
          isFallback: !!(img && slotUsed && slotUsed.isFallback),
          noMention: false,
          isAnchor: true,
          isPerspectiveAnchor: panel.perspectiveAnchorAssetId === asset.id
        });
      });
    }
    // Scan beat + composition, same combined text the inline strip uses
    // (11-reference-panel.js inlineReferenceStripInnerHTML) — Smart Split's
    // API path paraphrases beats into plain prose and drops @tags entirely
    // (see system prompt in smartSplit(), 06-scene-engine.js: the "beat"
    // field is described as free narration with no instruction to keep
    // @name tags), so panel.beat alone is frequently empty of @mentions for
    // any API-generated storyboard. composition often carries a location
    // name the beat doesn't, and a plain-text exact-match fallback catches
    // character names Claude wrote without the @ at all.
    const scanText = [panel.beat || '', panel.composition || ''].join('\n');
    const atMentions = parseAtMentions(scanText);
    const plainMentions = (typeof parsePlainTextMentions === 'function' ? parsePlainTextMentions(scanText) : [])
      .filter(pm => !atMentions.find(am => am.asset.id === pm.asset.id));
    const panelMentions = [...atMentions, ...plainMentions];

    if (panelMentions.length === 0) {
      rows.push({
        panelIndex: i, shotType: panel.shotType, assetId: null, assetName: null,
        assetType: null, img: null, slotUsed: null, isFallback: false, noMention: true
      });
      return;
    }
    panelMentions.forEach(m => {
      const asset = m.asset;
      // Fetch-on-reference (2026-07-10, Fable-review-caught gap) — covers
      // BOTH @-mentions and plain-text mentions here, unlike
      // buildPanelPrompt()'s own fetch-on-reference (06-scene-engine.js),
      // which only sees parseAtMentions(panel.beat) — Smart Split's API
      // path drops @tags and paraphrases beats into plain prose (see this
      // function's own comment above, "scanText"), so plain-text mentions
      // are the ONLY reference source for a Smart-Split-generated
      // storyboard. Without this, those assets' full images would never
      // get fetched under the narrowed load-time prefetch.
      // .then(refreshReferencePanelIfOpen) — see the anchor-rows call above
      // for why this is safe (no-op for cache hits, one real refresh for a
      // genuinely new fetch).
      if (typeof fetchAssetImageOnReference === 'function') {
        const p = fetchAssetImageOnReference(asset.type, asset.id);
        if (p && typeof p.then === 'function') p.then(refreshReferencePanelIfOpen);
      }
      // Context-aware location image selection — ported from Single Frame
      // (v7.10.0/v7.10.3, resolveLocationImageForContext(), 01-core.js).
      // scanText (beat + composition, computed above) is this panel's own
      // contextText, same role sfState's free text plays for Single Frame.
      let img, slotUsed, matchedFeature = null;
      if (asset.type === 'location' && typeof resolveLocationImageForContext === 'function') {
        const resolved = resolveLocationImageForContext(asset, panel.shotType, scanText);
        img = resolved.img; slotUsed = resolved.slotUsed; matchedFeature = resolved.matchedFeature;
      } else {
        img = getImageForShot(asset, panel.shotType);
        slotUsed = resolveSlotUsed(asset, panel.shotType);
      }
      rows.push({
        panelIndex: i,
        shotType: panel.shotType,
        assetId: asset.id,
        assetName: asset.name,
        assetType: asset.type,
        img: img || null,
        slotUsed,
        isFallback: !!(img && slotUsed && slotUsed.isFallback),
        noMention: false,
        matchedFeature,
        isPerspectiveAnchor: panel.perspectiveAnchorAssetId === asset.id
      });
    });
  });
  return rows;
}

/* Figure out which slot key actually satisfied getImageForShot(),
   so we can tell the user "used Mid Shot (closest available to Close-up)"
   rather than just showing an image with no provenance. */
// Unified 2026-07-04 (Fable audit Area 1A follow-up): this used to
// hand-copy its own version of getImageForShot()'s priority chain, plus
// its own separate fallback-chain table — two duplicated copies in one
// function. Both now read from the same SLOT_PRIORITY/normalizeShotType/
// isWidePreferredForLocation tables that 01-core.js's getImageForShot()
// and getImagesForShot() also use, so this can no longer silently drift
// out of sync with what image actually got attached (verified against
// the pre-existing behavior with a 1400-case before/after test matrix).
// Two small, deliberate corrections came out of that verification — see
// the SF_FRAME_KEY_BUCKETS comment in 01-core.js for why: Two-Shot/
// Three-Shot now resolve Full-Body-first instead of falling through to
// closeup-first; Closing Shot's fallback now includes Close-up as a last
// resort (previously stopped short and returned "no slot resolves" even
// when a Close-up image was on file and getImageForShot() was already
// using it).
function resolveSlotUsed(asset, shotType) {
  if (!asset.images) return null;
  const s = asset.images;
  let order;
  if (asset.type === 'character') {
    order = SLOT_PRIORITY.character[normalizeShotType(shotType)] || SLOT_PRIORITY.character.default;
  } else if (asset.type === 'location') {
    order = isWidePreferredForLocation(shotType) ? LOCATION_SLOT_PRIORITY.wide : LOCATION_SLOT_PRIORITY.detail;
  } else {
    // prop/era/style — getPrimaryImage just grabs first non-null slot
    const firstKey = Object.keys(s).find(k => s[k]);
    return firstKey ? { key: firstKey, isFallback: false } : null;
  }
  for (let i = 0; i < order.length; i++) {
    if (s[order[i]]) {
      return i === 0 ? { key: order[i], isFallback: false } : { key: order[i], isFallback: true, wanted: order[0] };
    }
  }
  return null;
}

const SLOT_LABELS = {
  closeup: 'Close-up', midshot: 'Mid Shot', fullbody: 'Full Body', sheet: 'Character Sheet',
  wide: 'Wide / Establishing', detail: 'Detail', full: 'Full View', reference: 'Period Reference'
};

// Fable-review fix (2026-07-10) — re-renders the Reference Panel modal's
// rows once a deferred fetch-on-reference completes, so a row that had no
// image yet at build time (filtered out or shown image-less) doesn't
// silently stay that way until some UNRELATED re-render happens to occur.
// Only rebuilds if the modal is actually open (checked via its own 'open'
// class — see openModal()/closeModal(), 01-core.js) — calling this after
// the user has already closed the panel would be wasted work. Deliberately
// only rebuilds `rows`, not `selected` — an in-progress zip-download
// selection shouldn't be disturbed by an unrelated image arriving.
function refreshReferencePanelIfOpen() {
  const overlay = document.getElementById('reference-panel-overlay');
  if (!overlay || !overlay.classList.contains('open')) return;
  refPanelState.rows = buildReferencePanelRows();
  renderReferencePanel();
}

/* ── OPEN / RENDER ────────────────────────────────────────────── */
function openReferencePanel() {
  refPanelState.rows = buildReferencePanelRows();
  refPanelState.selected.clear();
  renderReferencePanel();
  openModal('reference-panel-overlay');
}

function renderReferencePanel() {
  const body = document.getElementById('reference-panel-body');
  if (!body) return;

  if (refPanelState.rows.length === 0) {
    body.innerHTML = '<p style="opacity:.7">No panels to show yet — generate a storyboard first.</p>';
    return;
  }

  const byPanel = {};
  refPanelState.rows.forEach(r => {
    (byPanel[r.panelIndex] = byPanel[r.panelIndex] || []).push(r);
  });

  body.innerHTML = Object.keys(byPanel).map(idx => {
    const i = Number(idx);
    const rows = byPanel[idx];
    const panel = sbState.panels[i];
    const rowsHtml = rows.map((r, ri) => referenceRowHTML(r, i + '-' + ri)).join('');
    const imgCount = rows.filter(r => r.img).length;
    const hint = (typeof stagedGenerationHintHTML === 'function') ? stagedGenerationHintHTML(imgCount) : '';
    return `
      <div class="ref-panel-shot" style="border:1px solid var(--border);border-radius:8px;padding:10px 12px;margin-bottom:10px">
        <div style="display:flex;align-items:center;gap:8px;margin-bottom:6px">
          <span style="font-weight:700">Panel ${i + 1}</span>
          <span style="font-size:.75rem;opacity:.7">${escHtml(panel?.shotType || '')}</span>
        </div>
        ${hint}
        ${rowsHtml}
      </div>`;
  }).join('');
  // Fable audit H4 (2026-07-08): thumb src is deferred (see referenceRowHTML
  // below) so the innerHTML write above never carries embedded base64 —
  // flush hydrates every queued thumb now that the elements actually exist
  // in the DOM, via the browser's async image pipeline instead of the
  // synchronous HTML parser.
  flushImageHydration();
}

function referenceRowHTML(r, rowKey) {
  if (r.noMention) {
    return `<div style="font-size:.8rem;opacity:.6;padding:4px 0">No @ mentions in this shot's beat text.</div>`;
  }
  const key = r.panelIndex + ':' + r.assetId;
  const checked = refPanelState.selected.has(key) ? 'checked' : '';
  const disabled = r.img ? '' : 'disabled';
  const thumbId = 'ref-thumb-' + rowKey;
  if (r.img) queueImageHydration(thumbId, r.img);
  const thumb = r.img
    ? `<img id="${thumbId}" data-src-pending="1" style="width:48px;height:48px;object-fit:cover;border-radius:4px;border:1px solid var(--border)">`
    : `<div style="width:48px;height:48px;border-radius:4px;border:1px dashed var(--border);display:flex;align-items:center;justify-content:center;font-size:.65rem;opacity:.6">no img</div>`;

  let note = '';
  if (!r.img) {
    note = `<span style="color:var(--amber)">No reference image — using text description only.</span>`;
  } else if (r.matchedFeature) {
    const usedLabel = SLOT_LABELS[r.slotUsed.key] || r.slotUsed.key;
    note = `<span style="color:var(--blue, #2563eb)" title="Switched from the default frame-based image because '${escHtml(r.matchedFeature.name)}' is mentioned in this panel's beat/composition text and is only clearly visible in this image">📍 ${escHtml(usedLabel)} — "${escHtml(r.matchedFeature.name)}" detected</span>`;
  } else if (r.isFallback) {
    const wantedLabel = SLOT_LABELS[r.slotUsed.wanted] || r.slotUsed.wanted;
    const usedLabel = SLOT_LABELS[r.slotUsed.key] || r.slotUsed.key;
    note = `<span style="color:var(--amber)">Fallback: ${escHtml(wantedLabel)} not available — using ${escHtml(usedLabel)}.</span>`;
  } else if (r.slotUsed) {
    note = `<span style="opacity:.7">${escHtml(SLOT_LABELS[r.slotUsed.key] || r.slotUsed.key)}</span>`;
  }
  const anchorBadge = r.isAnchor
    ? `<div style="font-size:.68rem;color:var(--accent, #c87a1e);font-weight:600">Continuity anchor — attach this too, so this panel matches Panel 1</div>`
    : '';
  const perspectiveBadge = r.isPerspectiveAnchor
    ? `<div style="font-size:.68rem;color:var(--blue, #2563eb);font-weight:600">⭐ Perspective anchor — the rest of this shot will match this image's camera angle</div>`
    : '';
  // Star toggle — only meaningful for rows with a real image and a real
  // asset (not the "no mention" placeholder row). Exclusive per panel,
  // enforced in setPerspectiveAnchor(), so this is a star/pin control,
  // not a checkbox — clicking a different row's star moves the anchor.
  const starBtn = (r.img && r.assetId)
    ? `<button type="button" title="${r.isPerspectiveAnchor ? 'Remove as perspective anchor' : 'Mark as this panel anchor (camera angle/lighting reference)'}" onclick="setPerspectiveAnchor(${r.panelIndex}, '${r.assetId}'); openReferencePanel();" style="background:none;border:none;cursor:pointer;font-size:1.1rem;line-height:1;padding:2px;opacity:${r.isPerspectiveAnchor ? '1' : '.35'}">${r.isPerspectiveAnchor ? '⭐' : '☆'}</button>`
    : '';

  return `
    <div style="display:flex;align-items:center;gap:10px;padding:6px 0;border-top:1px solid var(--border-subtle, var(--border))${r.isAnchor ? ';background:rgba(200,122,30,0.06)' : ''}${r.isPerspectiveAnchor ? ';background:rgba(37,99,235,0.08)' : ''}">
      <input type="checkbox" ${checked} ${disabled} onchange="toggleReferenceSelection('${key}')">
      ${thumb}
      ${starBtn}
      <div style="flex:1;min-width:0">
        ${anchorBadge}
        ${perspectiveBadge}
        <div style="font-weight:600;font-size:.85rem">${escHtml(r.assetName)} <span style="font-weight:400;opacity:.6">(${escHtml(r.assetType)})</span></div>
        <div style="font-size:.75rem">${note}</div>
      </div>
    </div>`;
}

function toggleReferenceSelection(key) {
  if (refPanelState.selected.has(key)) refPanelState.selected.delete(key);
  else refPanelState.selected.add(key);
}

function selectAllReferenceImages() {
  refPanelState.rows.forEach(r => {
    if (r.img) refPanelState.selected.add(r.panelIndex + ':' + r.assetId);
  });
  renderReferencePanel();
}

/* ── INLINE STRIP (task #12) ─────────────────────────────────────
   Persistent, always-visible version of the same row data, rendered
   directly under each .sb-panel-card in renderPanels() (06-scene-engine.js)
   so the user doesn't have to reopen the modal (which only exists
   transiently after generation) to see/grab a reference image.
   Reuses buildReferencePanelRows()'s per-panel row shape but computes
   rows fresh for just this one panel — cheap, and stays correct even
   if a beat's @ mentions changed since the modal last opened. */
function inlineReferenceStripHTML(panelIndex) {
  return `<div class="sb-panel-ref-strip" id="sb-ref-strip-${panelIndex}">${inlineReferenceStripInnerHTML(panelIndex)}</div>`;
}

/* Inner content only — separated out so refreshInlineReferenceStrip() can
   re-render just the contents of an existing #sb-ref-strip-{i} wrapper
   after a beat edit + Regen, without having to rebuild the whole panel
   card (see task #13 — strip was going stale after regenPanelPrompt()
   because that function only ever patched #sb-prompt-{i}). */
function inlineReferenceStripInnerHTML(panelIndex) {
  if (!sbState || !Array.isArray(sbState.panels)) return '';
  const panel = sbState.panels[panelIndex];
  if (!panel) return '';

  // Scan beat AND composition text — composition is app-inferred/editable
  // text that often names a location/era/style (e.g. "Sahyadri mountains —
  // forest land outdoor") that never appears in the beat itself. Both
  // @mentions and plain-text auto-detection need to see this combined text
  // or assets named only in composition are invisible to the strip (bug
  // found in user testing — strip showed two characters but not the
  // mountain location asset named only in the composition field).
  const scanText = [panel.beat || '', panel.composition || ''].join('\n');

  const atMentions = parseAtMentions(scanText);

  // task #14 — also pick up exact-match plain-text names (no @) that
  // parseAtMentions() didn't already find. Strip-only: these are tagged
  // isAutoDetected so the row can be labelled differently and so this
  // never gets confused for a real @mention feeding the prompt pipeline.
  const plainMentions = (typeof parsePlainTextMentions === 'function' ? parsePlainTextMentions(scanText) : [])
    .filter(pm => !atMentions.find(am => am.asset.id === pm.asset.id));

  const mentions = [
    ...atMentions.map(m => ({ ...m, isAutoDetected: false })),
    ...plainMentions.map(m => ({ ...m, isAutoDetected: true }))
  ];

  // Continuity anchor — panel 1's locked character/location image(s),
  // added on every later panel so individual-panel generation has a real
  // image to attach for "same as panel 1", not just buildPanelPrompt()'s
  // text-only continuityNote. See resolveMasterAnchorAssets() above for
  // why this is the actual fix for the grid-vs-individual quality gap
  // (user-reported 2026-06-25).
  //
  // Bug fix 2026-06-29: the old filter here (`!ownMentionIds.has(a.id)`)
  // only existed to avoid showing an asset twice — once as a normal
  // "mentions" row, once again as an "anchor" row — when this panel
  // already mentions it directly. That's a different job than the one
  // fixed in buildReferencePanelRows() above (which gates *inclusion*,
  // not de-duplication), so the same patch can't be copy-pasted here.
  // The actual bug — panel 1's full character cast being offered as
  // anchors on a later panel that never mentions most of them — applies
  // here too, and the fix is: characters never get an anchor row in this
  // strip at all. Reasoning: a character anchor is only useful/correct
  // when this panel's own beat already calls for that character, but in
  // that case the character already gets a normal (non-anchor) mention
  // row above, so a separate anchor row would just be a duplicate. A
  // character this panel does NOT mention has no narrative reason to be
  // offered as an anchor image (confirmed harmful via live test — see
  // 2026-06-29-testing-checklist.md). Net effect: character anchor rows
  // are gone from this strip; location anchors are unaffected, since
  // "same environment as panel 1" is legitimate even when the location
  // isn't re-named in every beat.
  const ownMentionIds = new Set(mentions.map(m => m.asset.id));
  const anchorRows = (panelIndex > 0 ? resolveMasterAnchorAssets() : [])
    .filter(a => a.type === 'location' && !ownMentionIds.has(a.id))
    .map(asset => ({ asset, isAnchor: true }));

  if (mentions.length === 0 && anchorRows.length === 0) return '';

  const rows = [
    ...mentions.map(m => {
      const asset = m.asset;
      // Fetch-on-reference (2026-07-10, Fable-review-caught gap) — this
      // strip filters to rows with an actual `img` resolved (see the
      // .filter(r => r.img) below), so without this, a mentioned asset with
      // no full image loaded yet wouldn't even show a row here, silently,
      // until fetched some other way. Covers both @-mentions and
      // Smart-Split's plain-text mentions (mentions[] above merges both).
      // .then(refreshInlineReferenceStrip(panelIndex)) — redraws just this
      // panel's strip once the image lands; no-op for a cache hit (see
      // fetchAssetImageOnReference()'s comment, 01-core.js, for why that
      // keeps this from re-triggering itself forever).
      if (typeof fetchAssetImageOnReference === 'function') {
        const p = fetchAssetImageOnReference(asset.type, asset.id);
        if (p && typeof p.then === 'function') {
          p.then(() => { if (typeof refreshInlineReferenceStrip === 'function') refreshInlineReferenceStrip(panelIndex); });
        }
      }
      // Context-aware location image selection — same port as
      // buildReferencePanelRows() above; see that function's comment.
      let img, slotUsed, matchedFeature = null;
      if (asset.type === 'location' && typeof resolveLocationImageForContext === 'function') {
        const resolved = resolveLocationImageForContext(asset, panel.shotType, scanText);
        img = resolved.img; slotUsed = resolved.slotUsed; matchedFeature = resolved.matchedFeature;
      } else {
        img = getImageForShot(asset, panel.shotType);
        slotUsed = resolveSlotUsed(asset, panel.shotType);
      }
      // Multi-image upload (backlog item, future-features.md) — getImagesForShot()
      // (01-core.js) returns every available image in priority order; the
      // primary one is already `img` above (same image getImageForShot()
      // picks), so extraImgs is just the rest, surfaced as small secondary
      // thumbnails so the user can grab them too for platforms (GPT Image 2)
      // that can usefully take more than one reference per asset.
      const allImgs = (typeof getImagesForShot === 'function') ? getImagesForShot(asset, panel.shotType) : [];
      const extraImgs = allImgs.filter(i => i !== img);
      return {
        panelIndex, shotType: panel.shotType, assetId: asset.id, assetName: asset.name,
        assetType: asset.type, img: img || null, slotUsed,
        isFallback: !!(img && slotUsed && slotUsed.isFallback), noMention: false,
        isAutoDetected: m.isAutoDetected, isAnchor: false,
        isPerspectiveAnchor: panel.perspectiveAnchorAssetId === asset.id,
        matchedFeature,
        extraImgs
      };
    }),
    ...anchorRows.map(({ asset }) => {
      // Fetch-on-reference (2026-07-10, Fable-review-caught gap) — same
      // reasoning as the mentions.map() call above.
      if (typeof fetchAssetImageOnReference === 'function') {
        const p = fetchAssetImageOnReference(asset.type, asset.id);
        if (p && typeof p.then === 'function') {
          p.then(() => { if (typeof refreshInlineReferenceStrip === 'function') refreshInlineReferenceStrip(panelIndex); });
        }
      }
      // Resolve against panel 1's own shot type, since that's the exact
      // image the model needs to match — not this panel's framing.
      const img = getImageForShot(asset, sbState.panels[0].shotType);
      const slotUsed = resolveSlotUsed(asset, sbState.panels[0].shotType);
      return {
        panelIndex, shotType: panel.shotType, assetId: asset.id, assetName: asset.name,
        assetType: asset.type, img: img || null, slotUsed,
        isFallback: !!(img && slotUsed && slotUsed.isFallback), noMention: false,
        isAutoDetected: false, isAnchor: true
      };
    })
  ].filter(r => r.img); // inline strip only shows rows with an actual image — text-only mentions add no value here

  if (rows.length === 0) return '';

  const itemsHtml = rows.map((r, ii) => {
    const note = r.matchedFeature
      ? `<span style="color:var(--blue, #2563eb)" title="Switched from the default frame-based image because '${escHtml(r.matchedFeature.name)}' is mentioned in this panel's beat/composition text and is only clearly visible in this image">📍 "${escHtml(r.matchedFeature.name)}" detected</span>`
      : r.isFallback
      ? `<span style="color:var(--amber)">${escHtml(SLOT_LABELS[r.slotUsed.key] || r.slotUsed.key)} (fallback)</span>`
      : (r.slotUsed ? `<span style="opacity:.65">${escHtml(SLOT_LABELS[r.slotUsed.key] || r.slotUsed.key)}</span>` : '');
    const autoBadge = r.isAutoDetected
      ? `<div style="font-size:.55rem;opacity:.6;font-style:italic" title="Name found in text without @ — add @ to link this into the prompt itself">auto-detected</div>`
      : '';
    const anchorBadge = r.isAnchor
      ? `<div style="font-size:.55rem;color:var(--accent, #c87a1e);font-weight:600" title="Panel 1's reference image — attach this too when generating this panel individually, so the model has a real image to match against instead of just a text instruction">anchor (match Panel 1)</div>`
      : '';
    const perspectiveBadge = r.isPerspectiveAnchor
      ? `<div style="font-size:.55rem;color:var(--blue, #2563eb);font-weight:600" title="This image's camera angle/lighting is what the rest of this shot will match">⭐ perspective anchor</div>`
      : '';
    // Star toggle only makes sense for this panel's own assets — the
    // continuity-anchor rows (isAnchor) borrow Panel 1's image, which
    // isn't a meaningful perspective anchor choice for THIS panel.
    const starBtn = (!r.isAnchor)
      ? `<button type="button" title="${r.isPerspectiveAnchor ? 'Remove as perspective anchor' : 'Mark as perspective anchor for this panel'}" onclick="setPerspectiveAnchor(${r.panelIndex}, '${r.assetId}')" style="background:none;border:none;cursor:pointer;font-size:.85rem;line-height:1;padding:0;opacity:${r.isPerspectiveAnchor ? '1' : '.35'}">${r.isPerspectiveAnchor ? '⭐' : '☆'}</button>`
      : '';
    const dlName = `${r.assetName}-${r.slotUsed?.key || 'ref'}`.replace(/[^a-z0-9_-]+/gi, '_') + '.jpg';
    // Multi-image upload (backlog item) — extra images beyond the primary
    // one, shown as small secondary thumbnails so the user can grab them
    // too. GPT Image 2 can usefully take more than one reference image
    // per asset; this is purely a "here's what's available" surface, the
    // app still never uploads these itself (see multiImageNote in
    // buildPanelPrompt(), 06-scene-engine.js).
    // Fable audit H4 (2026-07-08): primary + extra images used to embed full
    // base64 directly as href/src attribute values in this template string —
    // same synchronous-HTML-parser freeze as the other four H4 locations,
    // and this one is worse than most since it renders for EVERY panel as
    // part of ordinary Storyboard rendering (renderPanels(), 06-scene-engine.js),
    // not just on a user-triggered open. Both href (download link target)
    // and img src are deferred and hydrated post-insert via queueImageHydration/
    // flushImageHydration (01-core.js) — flush happens once in renderPanels()
    // after the whole panel grid's innerHTML is set (and again in
    // refreshInlineReferenceStrip() below for the single-panel patch path).
    const primaryLinkId = 'sb-ref-link-' + r.panelIndex + '-' + ii;
    const primaryImgId = 'sb-ref-thumb-' + r.panelIndex + '-' + ii;
    queueImageHydration(primaryLinkId, r.img, 'href');
    queueImageHydration(primaryImgId, r.img, 'src');
    const extraThumbs = (r.extraImgs && r.extraImgs.length)
      ? r.extraImgs.map((eimg, ei) => {
          const linkId = 'sb-ref-extralink-' + r.panelIndex + '-' + ii + '-' + ei;
          const imgId = 'sb-ref-extra-' + r.panelIndex + '-' + ii + '-' + ei;
          queueImageHydration(linkId, eimg, 'href');
          queueImageHydration(imgId, eimg, 'src');
          return `<a id="${linkId}" download="${escHtml(r.assetName)}-extra${ei}.jpg" title="Additional reference image for ${escHtml(r.assetName)} — attach alongside the main one" style="display:block"><img id="${imgId}" data-src-pending="1" style="width:24px;height:24px;object-fit:cover;border-radius:3px;border:1px solid var(--border)"></a>`;
        }).join('')
      : '';
    const extraThumbsWrap = extraThumbs
      ? `<div style="display:flex;gap:2px;margin-top:2px" title="${r.extraImgs.length} more reference image(s) available">${extraThumbs}</div>`
      : '';
    return `
      <div style="display:flex;flex-direction:column;align-items:center;gap:2px">
        <a id="${primaryLinkId}" download="${escHtml(dlName)}" title="Download reference image" style="display:block">
          <img id="${primaryImgId}" data-src-pending="1" style="width:56px;height:56px;object-fit:cover;border-radius:4px;border:1px solid ${r.isPerspectiveAnchor ? 'var(--blue, #2563eb)' : (r.isAnchor ? 'var(--accent, #c87a1e)' : 'var(--border)')}${r.isAutoDetected ? ';border-style:dashed' : ''}">
        </a>
        ${extraThumbsWrap}
        ${starBtn}
        <div style="font-size:.62rem;text-align:center;max-width:72px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${escHtml(r.assetName)}">${escHtml(r.assetName)}</div>
        <div style="font-size:.6rem">${note}</div>
        ${autoBadge}
        ${anchorBadge}
        ${perspectiveBadge}
      </div>`;
  }).join('');

  const hint = (typeof stagedGenerationHintHTML === 'function') ? stagedGenerationHintHTML(rows.length) : '';
  return `${hint}<div style="display:flex;gap:10px;flex-wrap:wrap;padding:8px 0;border-top:1px solid var(--border-subtle, var(--border))">${itemsHtml}</div>`;
}

/* Re-render just one panel's strip in place. Call this any time a panel's
   beat/mentions/shotType could have changed without a full renderPanels(). */
function refreshInlineReferenceStrip(panelIndex) {
  const el = document.getElementById('sb-ref-strip-' + panelIndex);
  if (el) {
    el.innerHTML = inlineReferenceStripInnerHTML(panelIndex);
    flushImageHydration(); // Fable audit H4 — see comment in inlineReferenceStripInnerHTML()
  }
}

/* ── ZIP DOWNLOAD (built server-side on click, not persisted) ──── */
async function downloadSelectedReferenceImages() {
  if (refPanelState.selected.size === 0) {
    showToast('Select at least one image first', 'warning');
    return;
  }
  const items = [];
  refPanelState.selected.forEach(key => {
    const [panelIdxStr, assetId] = key.split(':');
    const row = refPanelState.rows.find(r => r.panelIndex === Number(panelIdxStr) && r.assetId === assetId);
    if (row && row.img) {
      items.push({
        panel: row.panelIndex + 1,
        assetName: row.assetName,
        slot: row.slotUsed?.key || 'image',
        image: row.img
      });
    }
  });
  if (items.length === 0) {
    showToast('Nothing selectable in current choice', 'warning');
    return;
  }

  showToast('Building zip…');
  const res = await apiCall('zip_reference_images', { items });
  if (!res || !res.zip_url) {
    showToast('Zip build failed — check server connection', 'error');
    return;
  }
  const a = document.createElement('a');
  a.href = res.zip_url;
  a.download = res.filename || 'reference-images.zip';
  document.body.appendChild(a);
  a.click();
  a.remove();
  showToast(`Downloaded ${items.length} image${items.length === 1 ? '' : 's'}`);
}
