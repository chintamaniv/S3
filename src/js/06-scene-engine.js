/* ══════════════════════════════════════════════════════════════
   SKILL-DERIVED PROMPT HYGIENE HELPERS
   Adopted 2026-06-27 from a cross-check against three installed skills
   (storyboard-director, seedance-director-V2, kling-3-prompter) and the
   platform research notes. These are text-hygiene passes applied to
   whatever beat/asset text the user has already written — they never
   override the shot-classification logic above/below (that pipeline was
   independently verified as already matching the skills' grammar rules,
   see 2026-06-24-open-items-consolidated.md for the comparison writeup).
══════════════════════════════════════════════════════════════ */

// Age-blind rule — hard rule in both storyboard-director and
// seedance-director-V2 skills: never describe figures by age. Describe by
// role, clothing, build, and action instead. This is a safety/quality net
// for whatever the user typed (beat text or asset descriptions) — it does
// not rewrite the user's own library asset records, only the text actually
// sent into the generated prompt.
const AGE_BLIND_TERMS = /\b(boy|girl|child|kid|kids|young|youth|teen|teenage|teenager|little|toddler|infant|elderly|old(?:er)?\s+(?:man|woman|lady|gentleman))\b/gi;

function ageBlindSanitize(text) {
  if (!text) return text;
  // Soft removal: drop the age-descriptive word/phrase but leave the rest of
  // the sentence intact (e.g. "the young boy ran" -> "the ran" reads oddly,
  // so we collapse to a generic role noun rather than deleting outright).
  return text.replace(AGE_BLIND_TERMS, (m) => {
    const w = m.toLowerCase();
    if (w.includes('girl') || w === 'kid' || w === 'kids') return 'figure';
    if (w.includes('boy')) return 'figure';
    if (w.includes('man') || w.includes('gentleman')) return 'man';
    if (w.includes('woman') || w.includes('lady')) return 'woman';
    return 'figure';
  }).replace(/\s{2,}/g, ' ').trim();
}

// Antislop filter — banned padding/marketing words, verbatim list from the
// seedance-director-V2 skill's "Antislop" section, extended with the
// storyboard-director skill's "What NOT to include" padding-word list.
// These words add no visual information and several image/video models
// over-index on them, producing generic "AI slop" renders.
const ANTISLOP_WORDS = [
  'breathtaking', 'stunning', 'captivating', 'mesmerizing', 'mesmerising',
  'awe-inspiring', 'masterfully', 'meticulously', 'exquisitely',
  'beautifully crafted', 'cinematic masterpiece', 'visual feast',
  'a symphony of', 'seamlessly', 'effortlessly', 'flawlessly',
  'cutting-edge', 'state-of-the-art', 'next-level', 'rich tapestry',
  'vibrant tapestry', 'kaleidoscope of', 'elevate', 'unlock', 'unleash',
  'harness', 'groundbreaking', 'a testament to', 'speaks volumes',
  'resonates deeply', 'vibrant', 'elevate'
];
const ANTISLOP_RE = new RegExp('\\b(' + ANTISLOP_WORDS.map(w => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|') + ')\\b', 'gi');

// Antislop word -> verb/connector pairs that go with it, so removal doesn't
// strand a dangling verb with no object ("will elevate your senses" ->
// "will your senses" if only the adjective is stripped). Matched and
// removed as a unit BEFORE the bare-word pass below. Not exhaustive — covers
// the common "will/that will/to <verb>" constructions seen in style/camera
// text; anything else falls through to the bare-word strip, which can leave
// minor roughness but never a banned hype-word in the final prompt.
const ANTISLOP_VERB_PHRASES = [
  /\b(that will |to )?elevate\b/gi,
  /\b(that will |to )?unlock\b/gi,
  /\b(that will |to )?unleash\b/gi,
  /\b(that will |to )?harness\b/gi
];

// Known soft edge (accepted, not fixed): removing a multi-word noun phrase
// like "a symphony of" or "rich tapestry" can strand a leading article or
// trailing preposition ("the of light"). Regex word-removal can't reliably
// repair sentence grammar after a phrase is cut. Accepted because this only
// ever touches synthetic style/camera text (stylePrefs.style/colour/camera,
// asset style-type fields) — never core scene/beat/character content — so a
// slightly awkward style fragment is a smaller problem than letting a
// banned hype-word reach the generator. If this proves noisy in practice,
// the real fix is encouraging better style-field input, not more regex.
function antislopFilter(text) {
  if (!text) return text;
  let out = text;
  ANTISLOP_VERB_PHRASES.forEach(re => { out = out.replace(re, ''); });
  return out
    .replace(ANTISLOP_RE, '')
    // Collapse orphaned punctuation/connectors left behind by a removed
    // word, e.g. "A breathtaking, stunning vista" -> "A, vista" without
    // this pass.
    .replace(/(^|[,.\s])\s*,\s*/g, '$1 ')   // ", ," / leading ", " -> single space
    .replace(/,\s*(?=[,.])/g, '')           // ", ." / ", ," -> "."
    .replace(/\b(and|or)\s+(?=[,.]|$)/gi, '') // dangling "and"/"or" before punctuation/end
    .replace(/\s{2,}/g, ' ')
    .replace(/\s+([,.!?])/g, '$1')
    .replace(/^[\s,]+/, '')
    .trim();
}

// Materiality nudge — storyboard-director's hard rule: every fabric/prop/
// surface needs weave, wear-state, finish — "not just tunic but rough-spun
// linen, faded olive, frayed collar." We never invent or overwrite a user's
// own rich description; this only appends a generic materiality prompt-nudge
// when the supplied text is suspiciously short (a bare noun with no texture/
// material/condition language at all), so the model is still pushed toward
// surface detail instead of being left with nothing.
const MATERIALITY_HINT_WORDS = /\b(weave|linen|cotton|silk|wool|leather|brushed|worn|weathered|faded|frayed|polished|rusted|carved|etched|matte|glossy|texture|fabric|grain|patina|wear|stitch|embroider)\b/i;

function materialityNudge(text, fallbackHint) {
  if (!text) return text;
  const wordCount = text.trim().split(/\s+/).length;
  if (wordCount <= 3 && !MATERIALITY_HINT_WORDS.test(text)) {
    return `${text} — ${fallbackHint || 'with visible material texture, finish, and wear state'}`;
  }
  return text;
}

/* ══════════════════════════════════════════════════════════════
   SPATIAL INFERENCE ENGINE
   Derives camera composition from shot type + assets present.
   Output is a plain-English draft the user can edit.
══════════════════════════════════════════════════════════════ */

function inferComposition(shotType, chars, locs, props, beatIndex, totalPanels, beat) {
  beat = beat || '';
  const b = beat.toLowerCase();
  const charNames = chars.map(m => m.asset.name);
  const primary = charNames[0] || null;
  const secondary = charNames[1] || null;
  const locName = locs.length ? locs[0].asset.name : null;
  const propNames = props.map(m => m.asset.name);

  function nameList(arr) {
    if (!arr.length) return '';
    if (arr.length === 1) return arr[0];
    if (arr.length === 2) return arr[0] + ' and ' + arr[1];
    return arr.slice(0, -1).join(', ') + ', and ' + arr[arr.length - 1];
  }

  // ── VEHICLE / THREAT IN MOTION ──────────────────────────────
  // Car is the subject. Skill: wide — show the threat.
  const vehicleMatch = beat.match(/\b(red |white |black |silver |blue |yellow )?(car|vehicle|truck|bus|bike|scooter|motorcycle|jeep)\b/i);
  if (vehicleMatch && b.match(/\b(fast|speed|rush|rushing|racing|driving|aggressiv|out of control|coming|toward|towards|approach)\b/)) {
    const vehicle = vehicleMatch[0];
    const charContext = primary
      ? `${primary} visible in foreground, small — threat approaching from background.`
      : 'No character in foreground.';
    return `Eye level, locked-off. Camera faces the road. ${vehicle} dominates the frame — occupying frame-right (as viewed), moving toward camera at speed. Motion blur on ${vehicle}. ${locName ? locName + ' visible at frame-left edge.' : ''} ${charContext} Deep focus.`;
  }

  // ── REACTION / SHOCK / NOTICE ───────────────────────────────
  // Skill hard rule: reaction shots are always clean singles — one face only.
  if (b.match(/\b(frighten|frightened|shocked|shock|notices|notice|glances|glance|horrified|panic|stunned|scared|terrified)\b/)) {
    // Determine which character is reacting
    let reactor = primary;
    charNames.forEach(name => {
      if (b.includes(name.toLowerCase())) reactor = name;
    });
    return `Eye level, static. Camera frames ${reactor || 'subject'}'s face — crown to chin, filling the frame. Eyes wide, brow raised, jaw open — reaction visible as physical fact. Background completely out of focus — colour and light only. ${secondary ? secondary + ' is NOT in this frame — clean single.' : ''}`;
  }

  // ── FOR ALL OTHER BEAT TYPES — use shot-type grammar ────────
  switch (shotType) {

    case 'Establishing Shot': {
      // Wording fix (2026-06-25, "ant-sized characters" bug, same fix as
      // compositionFromModel()'s Establishing Shot branch above): "small
      // relative to the environment" + an attached background reference
      // photo reliably shrank characters to near-invisible specks.
      const charPart = primary
        ? `${nameList(charNames)} visible in foreground-centre, clearly readable at a recognizable human scale — wide and environment-dominant, but never reduced to indistinct specks.`
        : 'No central figure — environment fills the frame.';
      const locPart = locName
        ? `${locName} fills the frame — architecture, ground, and spatial depth all visible.`
        : 'Wide environment fills the frame — ground, horizon, and spatial depth all visible.';
      return `High angle, locked-off. Camera faces the scene from above and ahead. ${locPart} ${charPart}${propNames.length ? ' ' + nameList(propNames) + ' visible in scene context.' : ''} Deep focus — foreground, mid-ground, and background all sharp.`;
    }

    case 'Wide Shot': {
      if (!primary) {
        return `Eye level, locked-off. Camera faces ${locName || 'the scene'} straight on. Full environment visible. Deep focus throughout.`;
      }
      if (secondary) {
        return `Eye level, locked-off. Camera faces ${primary} directly. ${primary} in frame-left foreground (as viewed), facing ${secondary}. ${secondary} in frame-right foreground, facing ${primary}${locName ? ', with ' + locName + ' as background' : ''}. Both figures fully visible — heads to feet. Deep focus.`;
      }
      const locContext = locName ? ` ${locName} fills the background behind ${primary}.` : '';
      return `Eye level, locked-off. Camera faces ${primary} directly. ${primary} stands centre-frame, fully visible head to feet.${locContext}${propNames.length ? ' ' + nameList(propNames) + ' visible near ' + primary + '.' : ''} Deep focus — figure and environment both sharp.`;
    }

    case 'Medium Shot': {
      if (!primary) return `Eye level. Camera frames the mid-ground action, waist-up. Environment partially visible.`;
      if (secondary) {
        return `Eye level. Camera faces ${primary}, waist-up, sharp and centred. ${secondary} visible at frame edge — soft focus, shoulder and partial face only, acting as directional anchor. ${locName ? locName + ' softly suggested in background.' : 'Background softly out of focus.'}`;
      }
      const locContext = locName ? ` ${locName} partially visible — key atmosphere behind ${primary}.` : '';
      return `Eye level. Camera faces ${primary}, waist-up framing. ${primary} occupies centre-frame, hands and gesture visible.${locContext}${propNames.length ? ' ' + nameList(propNames) + ' in ' + primary + "'s hands or immediate foreground." : ''} Shallow depth — ${primary} sharp, background soft.`;
    }

    case 'OS': {
      // Over-the-shoulder: foreground character's shoulder/back-of-head
      // frames the edge of frame, the other character sharp and facing
      // camera beyond them. Distinct from Medium Shot (both characters
      // level/facing camera) and from Close-up (one face only, clean
      // single) — OS always needs two characters in frame, one near, one far.
      if (!primary || !secondary) {
        return `Eye level. Camera positioned close behind ${primary || 'the foreground figure'}'s shoulder. Shoulder and back of head fill the lower frame edge, soft focus. ${locName ? locName + ' visible beyond, in focus.' : 'Environment visible beyond, in focus.'}`;
      }
      // Scale fix (found via Single Frame testing 2026-06-29, same gap here):
      // without an explicit distance/size cue, the sharp/camera-facing
      // figure (secondary) rendered full-figure instead of smaller/more
      // distant the way a real OTS shot requires. Frame-left/frame-right
      // assignment is fixed here (anchor=frame-left, sharp subject=
      // frame-right) — Storyboard panels don't yet have a per-panel side
      // toggle the way Single Frame's osSharpSubjectSide does; that's a
      // separate follow-up if Storyboard needs the same flexibility.
      return `Eye level. Camera positioned close behind ${primary}'s shoulder, occupying the frame-left (as viewed) portion of the frame — shoulder and back/side of head fill the lower-frame edge on frame-left, soft focus, large in frame, not the subject. ${secondary} positioned on frame-right beyond ${primary}'s shoulder, sharp and in focus, but smaller and more distant in the frame than ${primary} — only head, shoulders, and upper torso visible (not full body), facing toward ${primary}/camera.${locName ? ' ' + locName + ' softly visible behind ' + secondary + '.' : ''}`;
    }

    case 'Close-up': {
      if (!primary) return `Eye level, static. Camera frames a single face, filling the frame. Background implied, out of focus.`;
      const note = secondary ? ` ${secondary} is NOT in this frame — this is a clean single.` : '';
      return `Eye level, static. Camera frames ${primary}'s face — from crown to chin, filling the frame. Eyes and expression are the subject. Background completely out of focus — colour and light only, no readable detail.${note}`;
    }

    case 'ECU': {
      const propTarget = propNames.length ? propNames[0] : (primary ? `${primary}'s hands` : 'a specific detail');
      return `Static macro. Camera frames ${propTarget} in extreme close-up. No other figure in frame. Background reduced to abstract colour. Every surface texture and material detail visible.`;
    }

    case 'Closing Shot': {
      // Wording fix (mirrors compositionFromModel()'s Closing Shot branch):
      // "full-body, wide framing" is an explicit, unambiguous framing
      // instruction that the Wide Shot composition-cue rule in
      // assignShotType() and the "closing" bucket in getImageForShot()/
      // resolveSlotUsed() both key off of. "small in frame, facing away or
      // receding" was vague scene-description language, not a framing
      // instruction, and could read as justifying a close/tight crop.
      const charPart = primary
        ? `${nameList(charNames)} ${charNames.length > 1 ? 'are' : 'is'} visible full-body, wide framing — narrative settling.`
        : 'The scene settles — no central figure dominates, wide framing.';
      const locPart = locName ? `${locName} opens up around them.` : 'The environment opens up.';
      return `Low angle, slow push-in. Camera holds on the scene as the narrative resolves. ${charPart} ${locPart} Hold on final frame.`;
    }

    default:
      return primary
        ? `Camera faces ${primary}. ${locName ? locName + ' in background.' : ''}`
        : `Camera faces the scene.${locName ? ' ' + locName + ' in background.' : ''}`;
  }
}

/* ── LOCATION DESIGNER — direction-clause budget trimming ────────────────
   Design spec: "This new text is the first thing trimmed or dropped if the
   panel's prompt is approaching that platform's character budget... it's
   additive guidance, not core scene content, so it should yield first under
   space pressure." Every direction clause added by directionNote() (below,
   inside buildPanelPrompt) is wrapped in these invisible markers so it can
   be found and stripped as a unit AFTER the full prompt is assembled,
   without having to thread a "should I include this" flag through every
   platform branch's own string-building logic. Markers are always fully
   stripped before the prompt is returned — in the common case (no budget
   set for this platform, the spec's default), this function is a no-op
   pass-through that just removes the invisible wrapper. */
const _DIR_MARK_START = 'DIRSTART';
const _DIR_MARK_END = 'DIREND';

function wrapDirectionClause(text) {
  return text ? _DIR_MARK_START + text + _DIR_MARK_END : '';
}

function applyCharBudgetTrim(promptText, platform) {
  const budget = (typeof getPromptCharBudgetForPlatform === 'function') ? getPromptCharBudgetForPlatform(platform) : null;
  // Fable fix (2026-07-04): the budget check used to compare promptText.length
  // directly, which still includes the invisible DIRSTART/DIREND markers (14
  // chars per wrapped clause). That let the check fire a few characters
  // early — a prompt genuinely under budget once markers are gone could
  // still trigger the trim because the marker bytes pushed it over. Compare
  // against the marker-stripped length instead, since that's what the
  // platform (and the user) will actually see/count.
  const strippedLength = promptText
    .replace(new RegExp(_DIR_MARK_START, 'g'), '')
    .replace(new RegExp(_DIR_MARK_END, 'g'), '')
    .length;
  if (budget && strippedLength > budget) {
    const re = new RegExp(_DIR_MARK_START + '[\\s\\S]*?' + _DIR_MARK_END, 'g');
    promptText = promptText.replace(re, '');
  }
  return promptText.replace(new RegExp(_DIR_MARK_START, 'g'), '').replace(new RegExp(_DIR_MARK_END, 'g'), '');
}

// Best-effort heuristic for choosing "interior" vs "exterior" wording for a
// direction's prompt clause (design spec: "Interior register: wall, behind
// him/her... Exterior register: view, horizon, stretching into the
// distance..."). The spec's data model has no explicit interior/exterior
// flag, so this keys off common exterior words appearing in the direction's
// own name/description — imperfect (a direction literally named "the door
// to the garden" would trigger this even if the described feature itself is
// the door), but a reasonable default that fails toward the more common
// case with no user input required. Not a hard classification — worth
// revisiting if this reads wrong often enough in practice.
const EXTERIOR_DIRECTION_HINTS = ['river','forest','mountain','horizon','field','sky','village','road','hill','sea','ocean','garden','yard','street','plaza','courtyard','outdoor','riverside','countryside','valley','coast'];
function isExteriorDirection(direction) {
  const text = ((direction.name || '') + ' ' + (direction.fullDescription || '')).toLowerCase();
  return EXTERIOR_DIRECTION_HINTS.some(h => text.includes(h));
}

/* ── REBUILT buildPanelPrompt ────────────────────────────── */
function buildPanelPrompt(panel, index, totalPanels, mentions, stylePrefs) {
  const { beat, shotType, angle } = panel;
  const platform = sbState.platform;
  const isFirst = index === 0;
  const isLast = index === totalPanels - 1;
  const scale = getScaleEmphasis(shotType);

  // Separate mentions by type
  const chars  = mentions.filter(m => m.asset.type === 'character');
  const locs   = mentions.filter(m => m.asset.type === 'location');
  const eras   = mentions.filter(m => m.asset.type === 'era');
  const props  = mentions.filter(m => m.asset.type === 'prop');
  const styles = mentions.filter(m => m.asset.type === 'style');

  // Fetch-on-reference (2026-07-10) — an @-mention in a panel's beat text is
  // a live reference to a shared-library asset, which may not have its full
  // image loaded yet under the narrowed load-time prefetch (see
  // ensureLinkedLibraryImagesLoaded()'s comment, 01-core.js). Fire-and-
  // forget; fetchFullLibraryAssets() is a no-op once an id is cached, so
  // this stays cheap even though buildPanelPrompt() runs on every keystroke
  // in the beat textarea (onBeatInput()) and on regen for every panel.
  if (typeof fetchAssetImageOnReference === 'function') {
    mentions.forEach(m => fetchAssetImageOnReference(m.asset.type, m.asset.id));
  }

  // Style block
  const styleBlock = [
    stylePrefs.style,
    stylePrefs.colour,
    ...styles.map(m => buildAssetBlock(m.asset, platform))
  ].filter(Boolean).join(', ');

  // Negatives
  const negativesBlock = buildNegativesFromMentions(mentions, platform);

  // Composition — use panel's saved composition if user edited it, otherwise infer fresh
  const composition = panel.composition !== undefined
    ? panel.composition
    : inferComposition(shotType, chars, locs, props, index, totalPanels, beat);

  // Scale-aware character description
  //
  // Bug fix 2026-06-30: a.description is frequently a STACK of merged,
  // [Tag]-labelled blocks (e.g. "[Close-up] ...\n[Mid Shot] ...\n
  // [Character Sheet] ..."), produced by the Asset modal's per-image-slot
  // merge button (09-image-analyser.js). Single Frame already filtered
  // this down to just the relevant block per selected frame
  // (filterDescByFrame(), 02-singleframe.js) — Storyboard never did,
  // so every panel's prompt printed ALL stacked blocks verbatim
  // regardless of shotType. Confirmed via live test: Changdev's Close-up
  // panel AND his Establishing-shot panel both got his full Close-up +
  // Mid Shot + Character Sheet text. Fix: filter through the same global
  // filterDescByShotType() (01-core.js) Single Frame now delegates to,
  // keyed on this panel's actual shotType instead of raw a.description.
  function charBlockForScale(asset, platform) {
    const a = asset;
    const desc = filterDescByShotType(a.description, shotType);
    if (scale === 'face') {
      // Close-up: face, eyes, expression as physics
      const parts = [desc];
      if (a.emotional) parts.push('Expression: ' + expressionAsPhysics(a.emotional));
      if (platform === 'nb') return `${a.name}: ${parts.join('. ')}. Focus on face, eyes, jaw, brow — extreme facial detail.`;
      if (platform === 'gpt') return `${a.name.toUpperCase()}: ${parts.join('. ')} Focus: face and expression only. Preserve identity exactly.`;
      return [a.name, desc].filter(Boolean).join(', ');
    }
    if (scale === 'waist') {
      // Medium: upper body, costume, gesture
      const parts = [desc];
      if (a.costume) parts.push(a.costume);
      if (a.emotional) parts.push(expressionAsPhysics(a.emotional));
      if (platform === 'nb') return `${a.name} (${a.role || 'character'}): ${parts.join('. ')}. Waist-up framing, hands and gesture visible.`;
      if (platform === 'gpt') return `${a.name.toUpperCase()}: ${parts.join('. ')} Waist-up. Preserve identity exactly.`;
      return [a.name, desc, a.costume].filter(Boolean).join(', ');
    }
    // Wide/full: complete description, spatial position
    return buildAssetBlock(asset, platform, shotType);
  }

  // keyFeatures context-aware prompt clause — ported from Single Frame
  // (v7.10.0/v7.10.3, resolveLocationImageForContext(), 01-core.js; see
  // future-features.md "Port context-aware location image selection to
  // Storyboard"). Reuses the exact same resolver: if this panel's own beat
  // text names a keyFeature that's tagged only on the OTHER image slot
  // (e.g. beat mentions "water tank" but only the Detail slot's analysis has
  // it), append the same "We see the X (position) in frame." clause Single
  // Frame already adds — so the prompt TEXT agrees with whichever image slot
  // the reference panel/inline strip (11-reference-panel.js) switches to for
  // this same panel. Not applied to the face/close-up branch below: at that
  // scale the location is already treated as almost invisible background, so
  // naming one specific feature there would contradict that framing.
  function locFeatureNote(a) {
    if (a.type !== 'location' || typeof resolveLocationImageForContext !== 'function') return '';
    const resolved = resolveLocationImageForContext(a, shotType, beat || '');
    if (!resolved.matchedFeature) return '';
    const f = resolved.matchedFeature;
    return ` We see the ${f.name}${f.position ? ' (' + f.position + ')' : ''} in frame.`;
  }

  // Location Designer per-panel "Camera faces" direction text — design spec
  // 2026-06-28-location-designer-spec.md. Only fires when this panel has an
  // explicit direction selected (panel.cameraFacingDirection, set via the
  // "Camera faces" dropdown, cameraFacingWrapHTML() above) AND this specific
  // location asset actually has a matching entry in its own directions[]
  // list — so a panel mentioning multiple locations only ever gets this
  // text attached to the correct one, never the wrong asset. Uses the short
  // tag when a reference image is actually resolved for this asset/shot
  // (the image is doing the visual work; text just reinforces it) or the
  // full description when there's no image (text alone carries the spatial
  // information). Wrapped via wrapDirectionClause() so applyCharBudgetTrim()
  // (above) can drop it first under a configured character budget — see
  // that function's comment for why. Same face/close-up exclusion as
  // locFeatureNote() above, for the same reason: at that scale the location
  // is already near-invisible background.
  function directionNote(a) {
    if (a.type !== 'location' || !panel.cameraFacingDirection || !Array.isArray(a.directions)) return '';
    const direction = a.directions.find(d => d.name === panel.cameraFacingDirection);
    if (!direction) return '';
    const hasImage = !!(typeof getImageForShot === 'function' && getImageForShot(a, shotType));
    const text = hasImage ? direction.shortTag : direction.fullDescription;
    if (!text) return '';
    const exterior = isExteriorDirection(direction);
    const clause = exterior
      ? ` Facing ${direction.name}: ${text}, view stretching into the distance.`
      : ` Facing ${direction.name}: ${text}, visible on this side of frame.`;
    return wrapDirectionClause(clause);
  }

  // Scale-aware location description
  function locBlockForScale(asset, platform) {
    const a = asset;
    const desc = filterDescByShotType(a.description, shotType);
    if (scale === 'face') {
      // Close-up: location almost invisible — only light/colour context
      const light = [a.atmosphere, a.period].filter(Boolean).join(', ');
      if (platform === 'nb') return light ? `Background: ${light}. Shallow depth of field — background soft and implied.` : '';
      if (platform === 'gpt') return light ? `BACKGROUND (implied, soft focus): ${light}.` : '';
      return light;
    }
    if (scale === 'waist') {
      // Medium: partial background visible — key atmosphere and immediate surroundings
      const parts = [desc];
      if (a.atmosphere) parts.push(a.atmosphere);
      const note = locFeatureNote(a) + directionNote(a);
      if (platform === 'nb') return `Setting (partially visible): ${parts.join('. ')}.${note}`;
      if (platform === 'gpt') return `SETTING (partial): ${parts.join('. ')}.${note}`;
      return parts.join(', ') + note;
    }
    // Wide/establishing: full location detail
    return buildAssetBlock(asset, platform, shotType) + locFeatureNote(a) + directionNote(a);
  }

  // Master shot continuity — specific locked values from panel 1.
  // This text instruction alone is a weak consistency mechanism — the model
  // has no image to match it against unless the user also attaches panel 1's
  // reference image (now surfaced as an "anchor" row in the reference panel/
  // inline strip, see 11-reference-panel.js resolveMasterAnchorAssets()).
  // Wording below explicitly points at that attached image rather than
  // asking the model to imagine "panel 1" from words alone.
  //
  // Bug fix 2026-06-29: master.characters is a panel-1 snapshot containing
  // EVERY character mentioned in panel 1's beat (extractMasterValues() is
  // only ever called once, at i===0, then reused unchanged for every later
  // panel — see buildStoryboardFromBeats() above). A 5-character panel 1
  // (e.g. four people riding a flying wall) meant every later panel's
  // continuity instruction said "maintain all 5, match the attached anchor
  // image(s)" even when that panel's own beat only named one of them (e.g.
  // a solo Changdev shot) — confirmed via live test: the model rendered all
  // 5 reference images' subjects into a scene where 4 of them had no
  // narrative reason to be present. Fix: intersect master.characters with
  // THIS panel's own mentioned characters (`chars`, derived from the
  // per-panel `mentions` param — same per-panel scoping already used
  // elsewhere in this function, e.g. `chars`/`locs` above) before building
  // the instruction, so "maintain + attach anchor image" only ever applies
  // to a character who is both in panel 1 AND in the current panel.
  const master = panel.masterValues;
  const thisPanelCharNames = new Set(chars.map(c => c.asset.name));
  const masterCharsInThisPanel = master ? master.characters.filter(name => thisPanelCharNames.has(name)) : [];
  const continuityNote = !isFirst && master
    ? `Maintain: ${masterCharsInThisPanel.length ? masterCharsInThisPanel.join(', ') + ' — match the attached continuity-anchor reference image(s) exactly for appearance and costume. ' : ''}${master.location ? master.location + ' — same environment as the anchor image. ' : ''}Same lighting direction and quality as the anchor image.`
    : panel.continuityRef
      ? `Previous panel: "${panel.continuityRef}". Maintain character appearance and environment.`
      : '';

  // cref note for MJ — uses shot-appropriate image slot
  const crefAsset = chars.length > 0 ? chars[0].asset : null;
  const crefImg = crefAsset ? getImageForShot(crefAsset, panel.shotType) : null;
  const crefNote = crefImg ? `[Use --cref with ${crefAsset.name}'s reference image]` : '';

  // ── MULTI-IMAGE ATTACHMENT NOTE (backlog item, future-features.md
  // "Real multi-image upload to generation platforms") ───────────────
  // GPT Image 2 supports up to 16 reference images per request, but the
  // app never sends image bytes directly to any platform (confirmed via
  // audit, 2026-06-28) — it only tells the user, in text, what to attach.
  // getImagesForShot() (01-core.js) is the additive plural counterpart to
  // getImageForShot() — same fallback order, but returns every available
  // slot instead of stopping at the first. This note only fires for GPT
  // (the platform that actually supports multiple references usefully)
  // and only when an asset genuinely HAS more than one image on file —
  // single-image assets produce no note, same as before this feature.
  const multiImageNotes = (typeof getImagesForShot === 'function')
    ? mentions
        .map(m => ({ asset: m.asset, imgs: getImagesForShot(m.asset, panel.shotType) }))
        .filter(x => x.imgs.length > 1)
        .map(x => `${x.asset.name} (${x.imgs.length} reference images available — attach all for stronger identity match)`)
    : [];
  const multiImageNote = multiImageNotes.length
    ? `[Multiple references available: ${multiImageNotes.join('; ')}]`
    : '';

  // ── SHOT SETUP — frame positions + reference-role labels ─────────────
  // (Spatial Blocking Diagram spec, phase 4, added 2026-07-09 — the last
  // piece of 2026-07-06-spatial-blocking-diagram-spec.md's "Output per
  // panel" list; items 1 (drives Camera faces dropdown) and 2's data
  // model/resolver were already done in phases 1-3). Only fires when this
  // panel is linked to a shot-setup shot entry (shots[].linkedPanelId ===
  // this panel's index — set from openShotSetupForPanel()'s "add/pick
  // shot" flow, 14-shot-setup.js). Reuses resolveAllPositionsForShot(),
  // already shared with the diagram UI's own preview rendering — not
  // reimplemented here. Wrapped via wrapDirectionClause() so
  // applyCharBudgetTrim() drops this first under a configured character
  // budget, same "additive guidance, not core scene content" priority as
  // the Location Designer direction clause (directionNote() above) — this
  // restates spatial bookkeeping, it isn't new story content.
  //
  // Two correctness fixes added 2026-07-09, found live: findShotSetupForPanel()
  // matches purely by panel INDEX against linkedPanelId — it has no idea
  // what this panel's beat text actually mentions. With multiple shot
  // setups accumulating across a project (real case: 3 setups existed,
  // 2 sharing a location, 1 on a different location entirely), a stale
  // shot from a completely unrelated setup can match a panel just by
  // index coincidence. Confirmed live: a panel using one location got
  // handed a shot setup ("Akka - Jana night") built for a DIFFERENT
  // location, and it named a character not even mentioned in that panel's
  // beat. Two guards below fix both symptoms at once — a mismatched
  // setup is now treated as "no shot setup linked," same as if
  // findShotSetupForPanel() had returned nothing.
  function shotSetupNoteText() {
    if (typeof findShotSetupForPanel !== 'function') return '';
    const found = findShotSetupForPanel(index);
    if (!found) return '';
    const { setup, shotIndex } = found;

    // Fix 1 — location match. Only trust this shot setup if its own
    // location is actually one this panel mentions (locs, computed at
    // the top of this function from this panel's own mentions). A shot
    // setup for a location this panel never references is a stale
    // index-collision, not a real match.
    if (!setup.locationId || !locs.some(m => m.asset.id === setup.locationId)) return '';

    const positions = (typeof resolveAllPositionsForShot === 'function') ? resolveAllPositionsForShot(setup, shotIndex) : {};

    // Fix 2 — character/prop relevance. Only describe an object if it's
    // actually mentioned in THIS panel (chars/props, same per-panel
    // mentions used everywhere else in this function) — a shot setup can
    // legitimately hold characters who appear in some panels of a scene
    // but not others. An object with no assetId at all (a hand-typed
    // label, no library asset to check against) is trusted as-is, same
    // as before this fix.
    const mentionedCharIds = new Set(chars.map(m => m.asset.id));
    const mentionedPropIds = new Set(props.map(m => m.asset.id));
    const relevantObjects = (setup.objects || []).filter(o => {
      if (!positions[o.id]) return false;
      if (!o.assetId) return true;
      return o.type === 'character' ? mentionedCharIds.has(o.assetId) : mentionedPropIds.has(o.assetId);
    });
    if (!relevantObjects.length) return '';

    const allAssets = typeof getEffectiveAssets === 'function' ? getEffectiveAssets() : {};
    const nameFor = o => (o.assetId && allAssets[o.assetId]) ? allAssets[o.assetId].name : (o.label || 'Unnamed');

    const posLines = relevantObjects.map(o => `${nameFor(o)} positioned ${positions[o.id]} (as viewed)`).join('; ');

    // Reference-role labels — Cross-Shot Continuity spec's format
    // (2026-07-05-cross-shot-continuity-spec.md, "Reference role labels").
    // Auto-generated from each shot-setup object's own type, resolving
    // that spec's open question #1 (manual field vs. auto-generated from
    // slot assignment) in favor of auto — Shot Setup's object list already
    // IS the "which slot" assignment that question asked about; no need
    // for a second, separate manual field duplicating the same data.
    let imgNum = 1;
    const roleLines = [];
    if (setup.locationId) { roleLines.push(`Image ${imgNum}: background/setting only.`); imgNum++; }
    relevantObjects.forEach(o => {
      const roleWord = o.type === 'character' ? 'identity/pose reference only' : 'prop reference only';
      roleLines.push(`Image ${imgNum}: ${nameFor(o)}, ${positions[o.id]}, ${roleWord}.`);
      imgNum++;
    });

    // Staged-generation caution — live-testing finding (2026-07-06, both
    // the Cross-Shot Continuity and Spatial Blocking Diagram specs): 2+
    // competing character reference images in one call degrades identity
    // fidelity AND frame-position accuracy together; staged (one new
    // character at a time, building on the prior result) recovered both.
    const charCount = relevantObjects.filter(o => o.type === 'character').length;
    const stagedCaution = charCount >= 2
      ? ' Testing found 2+ character references in one call degrades identity and position accuracy — prefer a staged sequence (add one new character at a time, building on the prior shot\'s result) over one combined call.'
      : '';

    return `Shot setup: ${posLines}. ${roleLines.join(' ')}${stagedCaution}`;
  }
  const shotSetupRawNote = shotSetupNoteText();
  const shotSetupText = shotSetupRawNote ? wrapDirectionClause(shotSetupRawNote) : '';

  // ── PERSPECTIVE ANCHOR (Perspective-Anchor feature, spec 2026-06-24,
  // build approved 2026-06-28) ──────────────────────────────────────
  // Only active when the user has explicitly starred a reference image
  // for this panel (panel.perspectiveAnchorAssetId, set in
  // 11-reference-panel.js). When absent, every line below is skipped and
  // the prompt is byte-for-byte what it was before this feature — no
  // regression to the existing text-hint-only flow.
  // The app never calls an image-generation/editing API directly for any
  // platform (confirmed via codebase audit, 2026-06-28) — every platform
  // branch below only emits TEXT the user pastes alongside their own
  // manually-attached reference images, so this is copy guidance, not a
  // hard mechanism, on any of the three platforms.
  const perspectiveAnchor = (typeof getPerspectiveAnchorImage === 'function')
    ? getPerspectiveAnchorImage(panel, typeof getEffectiveAssets === 'function' ? getEffectiveAssets() : null)
    : null;
  const subordinateMentions = perspectiveAnchor
    ? mentions.filter(m => m.asset.id !== perspectiveAnchor.asset.id)
    : [];
  const subordinateNames = subordinateMentions.map(m => m.asset.name);
  // Non-character subordinates (props/locations/era/style) have no face or
  // costume — "preserve X's face, clothing, and identity" is nonsensical
  // for e.g. a prop asset. Split by type so wording stays sensible for
  // mixed character + non-character panels (found via live testing,
  // 2026-06-29: a prop named "The Wall" was told to "preserve its face").
  const subordinateCharNames = subordinateMentions.filter(m => m.asset.type === 'character').map(m => m.asset.name);
  const subordinateOtherNames = subordinateMentions.filter(m => m.asset.type !== 'character').map(m => m.asset.name);
  let perspectiveAnchorNote = '';
  if (perspectiveAnchor) {
    if (platform === 'nb') {
      // Nano Banana Pro has a real edit/preserve-unless-mentioned mode —
      // the only one of the three platforms with a real shot at reliably
      // fixing the flattening problem (see spec). Worded as an edit
      // instruction, matching the spec's proposed template.
      const preserveClauses = [];
      if (subordinateCharNames.length) preserveClauses.push(`Preserve ${subordinateCharNames.join(', ')}'s face, clothing, and identity exactly`);
      if (subordinateOtherNames.length) preserveClauses.push(`Preserve ${subordinateOtherNames.join(', ')}'s appearance and material exactly`);
      const preserveText = preserveClauses.length ? preserveClauses.join('. ') + ' — change only apparent perspective and scale to fit this shot.' : '';
      perspectiveAnchorNote = `Using ${perspectiveAnchor.asset.name}'s reference image as the camera and lighting anchor, edit so ${subordinateNames.length ? subordinateNames.join(' and ') : 'the other subject(s)'} match this exact camera angle, height, and lighting direction. ${preserveText}`.trim();
    } else if (platform === 'gpt') {
      // GPT Image 2 has no dedicated edit/preserve mode — this is a soft
      // text nudge alongside both images attached together, per spec.
      // Expect inconsistent results; GPT isn't told to preserve the
      // subordinate image's identity the way Nano Banana Pro's edit mode is.
      perspectiveAnchorNote = `Match the camera angle, height, and lighting of ${perspectiveAnchor.asset.name}'s reference image exactly when placing ${subordinateNames.length ? subordinateNames.join(' and ') : 'the other subject(s)'} from their own reference image(s).`;
    } else if (platform === 'mj') {
      // Midjourney has no preserve/edit contract at all — always composes
      // fresh. Best-effort nudge only: weight the anchor image higher via
      // --iw and describe the camera in text; identity still relies on
      // --cref for characters (--cref is a character-reference mechanism,
      // not meaningful for props/locations, so only character subordinates
      // are named in the --cref clause).
      const crefClause = subordinateCharNames.length
        ? `use --cref for ${subordinateCharNames.join(', ')}'s identity`
        : `no --cref needed — no character subjects in this shot`;
      perspectiveAnchorNote = `[Perspective anchor: weight ${perspectiveAnchor.asset.name}'s reference image higher via --iw 2 for camera angle/lighting; ${crefClause}. Best-effort — MJ generates fresh each time, no preserve guarantee.]`;
    }
  }

  // Strip @mentions to plain names in beat text — asset descriptions injected separately
  let enrichedBeat = beat.replace(/@(\w[\w\s]*?)(?=\s|,|\.|$)/g, (match, name) => name.trim());

  // Pronoun resolution — replace he/she/they with primary character name if only one character
  const charNames = chars.map(m => m.asset.name);
  if (charNames.length === 1) {
    const n = charNames[0];
    enrichedBeat = enrichedBeat
      .replace(/\bhe\b/gi, n).replace(/\bshe\b/gi, n).replace(/\bthey\b/gi, n)
      .replace(/\bhis\b/gi, n + "'s").replace(/\bher\b/gi, n + "'s").replace(/\btheir\b/gi, n + "'s");
  }

  // Age-blind + antislop hygiene pass — adopted from storyboard-director /
  // seedance-director-V2 skills (see header comment block above). Applied
  // here, once, to the beat text that every platform branch below reuses,
  // rather than duplicating the pass per-branch.
  enrichedBeat = antislopFilter(ageBlindSanitize(enrichedBeat));

  // Non-asset story elements (car, weather, objects not in library)
  const nonAssetElements = extractNonAssetElements(beat, mentions);
  const nonAssetBlock = nonAssetElements.length
    ? nonAssetElements.map(e => e.text).join(', ')
    : '';

  // Visual style — built as a prominent standalone block, not buried in a list
  const visualStyleBlock = [stylePrefs.style, stylePrefs.colour].filter(Boolean).join(', ');

  // Lens/aperture auto-suggest (STORYBOARD_LENS_SUGGEST) — only appended when
  // the user's own camera free text doesn't already specify lens/aperture
  // wording. User input always wins; this only fills a gap, never overrides.
  const lensSuggest = getStoryboardLensSuggest(shotType);
  const userSpecifiedLens = stylePrefs.camera && LENS_TERM_RE.test(stylePrefs.camera);
  const lensSuggestBlock = (lensSuggest && !userSpecifiedLens)
    ? `${lensSuggest.lens}, ${lensSuggest.aperture}`
    : '';

  const cameraStyleBlock = [stylePrefs.camera, lensSuggestBlock, ...styles.map(m => buildAssetBlock(m.asset, platform))].filter(Boolean).join(', ');

  // Aspect ratio parameter for this platform
  const ratioParam = getRatioParam();

  /* ── NANO BANANA PRO ── */
  if (platform === 'nb') {
    const sections = [];
    // Subject-first opening — primary subject and beat action in first line
    const _sbOpenSubject = (() => {
      if (chars.length && locs.length) return `of ${chars.map(m => m.asset.name).join(' and ')} at ${locs[0].asset.name}`;
      if (chars.length) return `of ${chars.map(m => m.asset.name).join(' and ')}`;
      if (locs.length) return `at ${locs[0].asset.name}`;
      return '';
    })();
    const _sbOpenBeat = enrichedBeat ? ` — ${enrichedBeat.charAt(0).toLowerCase() + enrichedBeat.slice(1).replace(/\.$/, '')}` : '';
    sections.push(`Generate a photorealistic cinematic still image${_sbOpenSubject ? ' ' + _sbOpenSubject : ''}${_sbOpenBeat}. (Panel ${index + 1} of ${totalPanels})`);
    if (visualStyleBlock) sections.push(`Visual style for this sequence: ${visualStyleBlock}. Maintain this style consistently across all panels.`);
    if (locs.length) sections.push(locs.map(m => locBlockForScale(m.asset, 'nb')).filter(Boolean).join('\n'));
    if (eras.length) sections.push(eras.map(m => buildAssetBlock(m.asset, 'nb', shotType)).join('\n'));
    sections.push(`Scene: ${enrichedBeat}`);
    if (nonAssetBlock) sections.push(`Key scene elements (must be visible): ${nonAssetBlock}.`);
    if (chars.length) {
      sections.push('Characters:\n' + chars.map(m => charBlockForScale(m.asset, 'nb')).join('\n'));
    }
    if (props.length) {
      sections.push('Props:\n' + props.map(m => buildAssetBlock(m.asset, 'nb', shotType)).join('\n'));
    }
    if (composition) sections.push(`Composition: ${composition}`);
    sections.push(`Framing: ${shotType}, ${angle}.`);
    if (cameraStyleBlock) sections.push(`Camera: ${cameraStyleBlock}.`);
    if (continuityNote) sections.push(continuityNote);
    if (perspectiveAnchorNote) sections.push(perspectiveAnchorNote);
    if (shotSetupText) sections.push(shotSetupText);
    // Preserve/constraint line — Nano Banana branch had no equivalent of
    // GPT's PRESERVE/CONSTRAINTS lines below. Worded as a semantic reframe
    // ("keep X consistent") rather than a blunt "do not change" list, per
    // Nano Banana's own documented preference for positive/semantic framing
    // over negative prompts (platform-profiles research note).
    if (charNames.length) {
      sections.push(`Keep ${charNames.join(', ')}'s identity, face, and costume exactly consistent with their established appearance across this sequence.`);
    }
    if (isLast) sections.push('Final panel — resolve the visual narrative.');
    if (negativesBlock) sections.push(negativesBlock);
    sections.push(`Photorealistic cinematic render, clean and unmarked — no watermark, no overlaid text. ${ratioParam}.`);
    return applyCharBudgetTrim(sections.join('\n\n'), platform);
  }

  /* ── GPT IMAGE-2 ──
     Reordered 2026-06-27: GPT Image 2 processes language sequentially and
     weights early words most heavily (per storyboard-director skill +
     platform research note). The TASK:/PANEL: boilerplate used to lead the
     prompt, ahead of the actual subject — working against that documented
     behavior. Subject/scene now leads; TASK/PANEL metadata moved to the end
     alongside the other trailing technical lines. */
  if (platform === 'gpt') {
    const lines = [];
    const preserveNames = charNames.join(', ');
    // Subject-first opening, no leading label — GPT Image 2 weights early
    // words most heavily (per storyboard-director skill + platform research
    // note). "SCENE:" used to be the literal first characters of the whole
    // prompt; the subject's name(s) now lead instead, mirroring the same
    // fix already applied to the nb branch's opening line. Every other
    // line below keeps its ALL-CAPS label — only the opening line changes.
    const gptSubjectNames = chars.map(m => m.asset.name);
    const gptOpenSubject = gptSubjectNames.length ? gptSubjectNames.join(' and ') + ' — ' : '';
    lines.push(`${gptOpenSubject}${enrichedBeat}`);
    if (nonAssetBlock) lines.push(`KEY ELEMENTS (must appear in image): ${nonAssetBlock}`);
    if (chars.length) {
      lines.push('CHARACTERS:\n' + chars.map(m => charBlockForScale(m.asset, 'gpt')).join('\n'));
    }
    if (locs.length) lines.push(locs.map(m => locBlockForScale(m.asset, 'gpt')).filter(Boolean).join('\n'));
    if (eras.length) lines.push(eras.map(m => buildAssetBlock(m.asset, 'gpt', shotType)).join('\n'));
    if (props.length) {
      lines.push('PROPS:\n' + props.map(m => buildAssetBlock(m.asset, 'gpt', shotType)).join('\n'));
    }
    if (composition) lines.push(`COMPOSITION: ${composition}`);
    lines.push(`FRAMING: ${shotType}, ${angle}`);
    if (visualStyleBlock) lines.push(`VISUAL STYLE: ${visualStyleBlock}. Apply this style consistently.`);
    if (cameraStyleBlock) lines.push(`CAMERA: ${cameraStyleBlock}`);
    if (continuityNote) lines.push(`CONTINUITY: ${continuityNote}`);
    if (perspectiveAnchorNote) lines.push(`PERSPECTIVE ANCHOR: ${perspectiveAnchorNote}`);
    if (shotSetupText) lines.push(shotSetupText);
    if (preserveNames) {
      lines.push(`PRESERVE: Identity, face, costume, and proportions of ${preserveNames} exactly. Do not alter appearance between panels.`);
    }
    const allNegs = ['no watermark', 'no extra text', 'no logos'];
    if (negativesBlock) allNegs.push(negativesBlock);
    lines.push(`CONSTRAINTS: ${allNegs.join('. ')}`);
    lines.push(`TASK: Generate a single photorealistic cinematic still image. PANEL: ${index + 1} of ${totalPanels}. OUTPUT: ${ratioParam}`);
    if (crefNote) lines.push(crefNote);
    if (multiImageNote) lines.push(multiImageNote);
    return applyCharBudgetTrim(lines.join('\n\n'), platform);
  }

  /* ── KLING VIDEO 3.0 — CUSTOM MULTI-SHOT FRAGMENT ──────────
     Verified against Kling's official Video 3.0 guide (see
     2026-06-24-image-reference-audit-and-platform-docs.md). Unlike nb/gpt,
     this branch does NOT return a full standalone prompt — Kling's
     documented Custom Multi-Shot syntax is terse and shot-numbered, e.g.
     "Shot 1, Low-angle rear wide shot, tracking behind the rider...". The
     "Shot N," prefix itself is added by copyAsKlingMultiShot() when it
     assembles all panels together, since Kling generates the whole
     sequence from ONE combined prompt, not one prompt per panel. This
     branch only returns this panel's terse fragment: shot size + camera
     angle/move, subject + action, key setting/lighting cue. */
  if (platform === 'kling') {
    const parts = [];
    const camDesc = [angle, shotType.toLowerCase()].filter(Boolean).join(', ');
    if (camDesc) parts.push(camDesc);
    if (charNames.length) parts.push(charNames.join(' and '));
    if (enrichedBeat) parts.push(enrichedBeat.replace(/\.$/, ''));
    if (locs.length && (isFirst || isLast)) parts.push('at ' + locs[0].asset.name);
    if (nonAssetBlock) parts.push(nonAssetBlock);
    // Kling's terse fragment never calls locBlockForScale(), so no direction
    // clause can appear here — applyCharBudgetTrim() is a harmless no-op
    // pass-through in this branch, kept only for consistency with the others.
    return applyCharBudgetTrim(parts.filter(Boolean).join(', '), platform);
  }

  // Fallback branch — also covers Midjourney, which has no dedicated
  // branch of its own in this function and falls through to here.
  // MJ has the weakest fit for the Perspective-Anchor feature (no
  // multi-image edit/preserve mode, always composes fresh), so this is
  // appended as an explicit best-effort note rather than woven into the
  // main text, per spec. Also never calls locBlockForScale() — same
  // no-op note as the Kling branch above re: applyCharBudgetTrim().
  return applyCharBudgetTrim(
    [enrichedBeat, perspectiveAnchorNote, shotSetupText].filter(Boolean).join('\n\n'),
    platform
  );
}
/* ── ASPECT RATIO ────────────────────────────────────────── */
// Platform-specific aspect ratio parameter format
const RATIO_PARAMS = {
  nb: {
    '16:9':   'aspect_ratio: 16:9',
    '4:3':    'aspect_ratio: 4:3',
    '1:1':    'aspect_ratio: 1:1',
    '9:16':   'aspect_ratio: 9:16',
    '2.39:1': 'aspect_ratio: 21:9'
  },
  gpt: {
    '16:9':   'size: 1536x1024',
    '4:3':    'size: 1365x1024',
    '1:1':    'size: 1024x1024',
    '9:16':   'size: 1024x1536',
    '2.39:1': 'size: 1792x768'
  },
  mj: {
    '16:9':   '--ar 16:9',
    '4:3':    '--ar 4:3',
    '1:1':    '--ar 1:1',
    '9:16':   '--ar 9:16',
    '2.39:1': '--ar 2.39:1'
  }
};

function setSBRatio(btn) {
  document.querySelectorAll('#sb-ratio-chips .sf-chip').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  sbState.aspectRatio = btn.dataset.val;
}

function getRatioParam() {
  const map = RATIO_PARAMS[sbState.platform] || RATIO_PARAMS.nb;
  return map[sbState.aspectRatio] || map['16:9'];
}

/* ── NON-ASSET ELEMENT EXTRACTOR ─────────────────────────── */
// Extracts visually significant non-library elements from beat text
// Looks for vehicles, objects, weather, actions not covered by @ mentions
function extractNonAssetElements(beatText, mentions) {
  if (!beatText) return [];

  // Names already covered by library mentions
  const mentionedNames = new Set(mentions.map(m => m.asset.name.toLowerCase()));

  // Strip @mentions from beat text for analysis
  const stripped = beatText.replace(/@\w[\w\s]*/g, '').toLowerCase();

  const found = [];

  // Vehicles
  if (/\bcar\b|\bvehicle\b|\btruck\b|\bbike\b|\bscooter\b|\bbus\b|\bauto\b|\brickshaw\b|\bmotorcycle\b|\bjeep\b|\bvan\b/.test(stripped))
    found.push({ category: 'vehicle', text: beatText.match(/(?:red |blue |white |black |silver |yellow )?\b(?:car|vehicle|truck|bike|scooter|bus|auto-rickshaw|motorcycle|jeep|van)\b/i)?.[0] || 'vehicle' });

  // Weather / atmosphere
  if (/\brain\b|\bstorm\b|\bfog\b|\bdust\b|\bwind\b|\bsunlight\b|\bshadow\b|\bthunder\b|\blightning\b/.test(stripped))
    found.push({ category: 'atmosphere', text: beatText.match(/(?:heavy |light |sudden )?\b(?:rain|storm|fog|dust cloud|wind|sunlight|thunder|lightning)\b/i)?.[0] || 'atmospheric element' });

  // Key objects / actions not in library
  if (/\bnewspaper\b/.test(stripped)) found.push({ category: 'prop', text: 'newspaper' });
  if (/\bphone\b|\bmobile\b/.test(stripped)) found.push({ category: 'prop', text: 'mobile phone' });
  if (/\bfire\b|\bflame\b/.test(stripped)) found.push({ category: 'element', text: 'fire' });
  if (/\bsmoke\b/.test(stripped)) found.push({ category: 'element', text: 'smoke' });
  if (/\bexplosion\b|\bcrash\b|\bcollision\b/.test(stripped)) found.push({ category: 'action', text: beatText.match(/\b(?:explosion|crash|collision|impact)\b/i)?.[0] || 'impact event' });

  // Filter out anything already named in library
  return found.filter(item => !mentionedNames.has(item.text.toLowerCase()));
}

/* ── PANEL COUNT + PLATFORM ──────────────────────────────── */
function setSBPanelCount(btn) {
  document.querySelectorAll('.sb-panel-count-chips .sf-chip').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  sbState.panelCount = parseInt(btn.dataset.val);
}

function setSBPlatform(btn) {
  document.querySelectorAll('.sb-panel-count-chips ~ .sb-panel-count-chips .sf-chip, .sb-config-row .sb-config-group:nth-child(2) .sf-chip').forEach(b => b.classList.remove('active'));
  // target platform chips specifically
  document.querySelectorAll('[onclick^="setSBPlatform"]').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  sbState.platform = btn.dataset.val;

  // Kling Video 3.0's "Custom Multi-Shot" mode generates ALL shots from a
  // single combined prompt, not one prompt per panel (verified against
  // Kling's official Video 3.0 guide — see
  // 2026-06-24-image-reference-audit-and-platform-docs.md). The other two
  // storyboard platforms (nb/gpt) export per-panel prompts via "Copy
  // Individual"/"Copy as Grid", which doesn't match how Kling Video actually
  // consumes a multi-shot prompt — so swap in a dedicated button instead.
  const klingBtn = document.getElementById('sb-copy-klingvideo-btn');
  const gridBtn = document.getElementById('sb-copy-grid-btn');
  if (klingBtn) klingBtn.style.display = sbState.platform === 'kling' ? '' : 'none';
  if (gridBtn) gridBtn.style.display = sbState.platform === 'kling' ? 'none' : '';
}

/* ── OFFLINE SPLIT — NARRATIVE EVENT AWARE ───────────────── */
function offlineSplit(story, count, charNames, locName) {
  charNames = charNames || [];
  locName = locName || '';
  const primary = charNames[0] || 'the subject';
  const secondary = charNames[1] || null;
  const location = locName ? ` at ${locName}` : '';

  // Step 1: Split on natural sentence/clause boundaries
  let raw = story
    .replace(/\n{2,}/g, '\n')
    .replace(/([.!?।])\s+/g, '$1\n')
    .replace(/,?\s+(then|suddenly|meanwhile|as |next|finally|after that|at that moment|in that moment|moments later|just then|before long),?\s+/gi, '\n')
    .split('\n')
    .map(s => s.trim())
    .filter(Boolean);

  if (raw.length === 0) return Array(count).fill('Scene continues.');

  // Step 2: More beats than panels — merge into buckets
  if (raw.length >= count) {
    const buckets = [];
    const perBucket = raw.length / count;
    for (let i = 0; i < count; i++) {
      const start = Math.round(i * perBucket);
      const end = Math.round((i + 1) * perBucket);
      buckets.push(raw.slice(start, end).join(' ').trim() || 'Scene continues.');
    }
    return buckets;
  }

  // Step 3: Expand each beat with narrative-event-aware intermediates
  const expanded = [];
  raw.forEach((sentence, idx) => {
    expanded.push(sentence);
    const inserts = narrativeInserts(sentence, idx, raw, charNames, locName);
    inserts.forEach(ins => expanded.push(ins));
  });

  // Step 4: If expanded beats >= count — distribute evenly
  if (expanded.length >= count) {
    const buckets = [];
    const perBucket = expanded.length / count;
    for (let i = 0; i < count; i++) {
      const start = Math.round(i * perBucket);
      const end = Math.round((i + 1) * perBucket);
      buckets.push(expanded.slice(start, end).join(' ').trim() || 'Scene continues.');
    }
    return buckets;
  }

  // Step 5: Still short — honest count, show warning, don't pad with nonsense
  // Return what we have and let generateStoryboard adjust the count
  return expanded;
}

/* ── NARRATIVE INSERTS — CINEMATICALLY VALID INTERMEDIATES ── */
// For each beat, generate intermediate shots that serve story logic.
// Each insert is a genuine cinematic choice, not filler.
function narrativeInserts(sentence, idx, allBeats, charNames, locName) {
  const s = sentence.toLowerCase();
  const primary = charNames[0] || 'the subject';
  const secondary = charNames[1] || null;
  const location = locName ? ` at ${locName}` : '';
  const nextBeat = allBeats[idx + 1] ? allBeats[idx + 1].toLowerCase() : '';
  const inserts = [];

  // ── VEHICLE / THREAT ARRIVING ───────────────────────────────
  // Insert: low angle road shot of vehicle approaching — builds dread before reaction
  if (s.match(/\b(car|vehicle|truck|bus|bike|motorcycle)\b/) &&
      s.match(/\b(fast|speed|rush|rushing|racing|driving|aggressiv|out of control)\b/)) {
    inserts.push(
      `Low angle road surface shot — ${s.match(/red |blue |white |black /)?.[0] || ''}vehicle visible in the distance, closing in at speed. Road fills the foreground. No character in frame.`
    );
  }

  // ── CHARACTER HEARS / NOTICES THREAT ───────────────────────
  // Insert: ECU of what they were doing — explains delayed reaction (headphones, hands, prop)
  if (s.match(/\b(hears|hear|notices|notice|glances|glance|looks up|looks toward)\b/)) {
    // What were they doing? Check previous beats
    const prevBeat = idx > 0 ? allBeats[idx - 1].toLowerCase() : '';
    if (prevBeat.match(/headphone|music|listen/)) {
      inserts.push(`ECU — ${primary}'s headphones on ears, music implied. Eyes still down. Unaware.`);
    } else if (prevBeat.match(/newspaper|reading|read/)) {
      inserts.push(`ECU — ${primary}'s hands holding newspaper, eyes scanning text. Absorbed.`);
    } else if (prevBeat.match(/tea|drink|cup|glass/)) {
      inserts.push(`ECU — ${primary}'s hands around a cup of tea. Steam rising. Still.`);
    } else {
      inserts.push(`ECU — ${primary}'s hands, occupied with a task. A beat of stillness before they look up.`);
    }
  }

  // ── REACTION BEAT INCOMING — insert spatial wide before the close-up ──
  // If next beat is a reaction, insert a wide showing both character and threat
  if (nextBeat.match(/\b(frighten|frightened|shocked|shock|scared|terrified|horrified|panic)\b/)) {
    if (secondary) {
      inserts.push(
        `Wide shot — ${primary} and ${secondary} visible together${location}. The threat visible in background. Both figures in frame, spatial relationship clear. A single frozen moment before reaction.`
      );
    } else {
      inserts.push(
        `Wide shot — ${primary} visible${location}, threat visible in background. Full spatial context. One beat before the reaction.`
      );
    }
  }

  // ── PROP IN USE ─────────────────────────────────────────────
  // Insert: ECU of the prop — establish it before it matters
  if (s.match(/\b(newspaper|reads|reading)\b/) && idx < 2) {
    inserts.push(`ECU — newspaper in ${primary}'s hands, held open. Print visible. Absorbed in reading.`);
  }

  // ── APPROACH / ARRIVAL ──────────────────────────────────────
  // Insert: reaction of those already present
  if (s.match(/\b(arrive|arrives|enters|walks in|comes in|approaches)\b/) && secondary) {
    inserts.push(`Medium shot — ${secondary} notices ${primary} arriving. Eyes lift${location}.`);
  }

  // ── EMOTIONAL PEAK ──────────────────────────────────────────
  // Insert: reverse angle or witness reaction
  if (s.match(/\b(weep|cry|breaks down|collapses|falls|overwhelm)\b/) && secondary) {
    inserts.push(`Close-up — ${secondary}'s face, witnessing. Expression as physical fact — jaw tightens, eyes soften.`);
  }

  return inserts;
}

/* ── SHOT TYPE ASSIGNMENT ────────────────────────────────── */
/* ── ANTI-SLOP FILTER ────────────────────────────────────── */
const SLOP_WORDS = /\b(breathtaking|stunning|captivating|mesmerizing|mesmerising|awe-inspiring|masterfully|meticulously|exquisitely|beautifully crafted|cinematic masterpiece|visual feast|seamlessly|effortlessly|flawlessly|cutting-edge|next-level|rich tapestry|vibrant tapestry|elevate|unleash|harness|groundbreaking|speaks volumes|resonates deeply)\b/gi;

function deSlop(text) {
  return text.replace(SLOP_WORDS, '').replace(/\s{2,}/g, ' ').trim();
}

/* ── AGE-BLIND FILTER ────────────────────────────────────── */
function ageBlind(text) {
  // Only filter genuinely age-descriptive words that could cause platform issues
  // Do NOT filter: man, woman, person, figure, elder — these are role descriptors
  return text
    .replace(/\bboy\b/gi, 'young male figure')
    .replace(/\bgirl\b/gi, 'young female figure')
    .replace(/\bchild\b/gi, 'young figure')
    .replace(/\bkid\b/gi, 'young figure')
    .replace(/\bteen\b/gi, 'young figure')
    .replace(/\bteenager\b/gi, 'young figure');
  // Note: man, woman, elderly, old are kept — they are legitimate descriptors
}

/* ── EXPRESSION AS PHYSICS ───────────────────────────────── */
// Converts emotion labels into physical descriptions
const EMOTION_MAP = {
  'looks angry':       'jaw clenches, brow draws inward, nostrils flare',
  'angry':             'jaw set, brow low, eyes narrowed',
  'looks sad':         'brow lifts at inner corners, eyes glisten, lips press together',
  'sad':               'downcast eyes, slack jaw, shoulders drawn in',
  'looks happy':       'corners of mouth lift, eyes crinkle, chin raised',
  'happy':             'open expression, lips parted, eyes bright',
  'looks surprised':   'brow lifted, jaw dropped slightly, irises fully visible',
  'surprised':         'eyes wide, brow high, mouth open',
  'looks afraid':      'eyes wide, chin pulled back, breath shallow',
  'afraid':            'pupils dilated, body contracted, weight back',
  'looks determined':  'jaw set, gaze fixed, shoulders squared',
  'determined':        'steady gaze, jaw forward, hands still',
  'looks serene':      'brow smooth, lips soft, breath slow and even',
  'serene':            'face relaxed, eyes half-closed, jaw unclenched',
  'looks fierce':      'brow hard, eyes locked, mouth tight',
  'fierce':            'jaw forward, eyes unblinking, muscles tensed'
};

function expressionAsPhysics(text) {
  let result = text;
  Object.entries(EMOTION_MAP).forEach(([emotion, physics]) => {
    const regex = new RegExp(emotion, 'gi');
    result = result.replace(regex, physics);
  });
  return result;
}

/* ── CLEAN PROMPT TEXT ───────────────────────────────────── */
function cleanPromptText(text) {
  return expressionAsPhysics(ageBlind(deSlop(text)));
}

/* ── SHOT GRAMMAR — FROM STORYBOARD DIRECTOR SKILL ──────── */
// Every rule below maps directly to the skill's Shot Type Rules table.
// Position is used ONLY for first and last panel.
// All other decisions are content-driven from beat text.

const SHOT_SIZES = ['Establishing Shot', 'Wide Shot', 'Medium Shot', 'OS', 'Close-up', 'ECU', 'Closing Shot'];
const CAMERA_MODES = ['locked-off', 'handheld', 'slow push-in', 'tracking', 'static', 'low dolly'];

// Lens/aperture auto-suggest — Storyboard mode equivalent of Single Frame's
// CAMERA_SUGGEST table (02-singleframe.js). Keyed by the SHOT_SIZES values
// above (the shotType every panel already carries). This is advisory only:
// getStoryboardLensSuggest() is consulted by buildPanelPrompt() to fill in
// cameraStyleBlock ONLY when the user hasn't typed their own lens/aperture
// wording into the free-text #sb-camera field (stylePrefs.camera) — manual
// input always wins, same override precedent as Single Frame mode. Also
// surfaced in buildCameraNote() so it's visible per-panel in the UI, not just
// silently baked into the prompt.
const STORYBOARD_LENS_SUGGEST = {
  'Establishing Shot': { lens: '14-24mm ultra-wide lens', aperture: 'f/11 — maximum depth of field, everything sharp', note: 'Wide lens, deep focus — establish full environment' },
  'Wide Shot':          { lens: '24-35mm wide lens',       aperture: 'f/8 — deep focus, sharp throughout',              note: 'Wide framing, deep focus to hold figure and setting' },
  'Medium Shot':        { lens: '50mm standard lens',      aperture: 'f/4 — balanced depth',                            note: 'Natural perspective, moderate depth' },
  'OS':                 { lens: '85mm portrait lens',      aperture: 'f/2.8 — shallow depth of field, subject separation', note: '85mm holds the foreground shoulder soft, sharp subject beyond' },
  'Close-up':           { lens: '85mm portrait lens',      aperture: 'f/1.8 — shallow depth of field, creamy bokeh',    note: 'Portrait compression, background falls away' },
  'ECU':                { lens: '100mm macro/telephoto',   aperture: 'f/1.4 — extreme shallow depth of field',          note: 'Maximum isolation on a single extreme close-up detail' },
  'Closing Shot':       { lens: '24-35mm wide lens',        aperture: 'f/8 — deep focus, sharp throughout',              note: 'Wide closing frame, deep focus to hold the full scene' }
};

// Detects whether the user already typed lens/aperture/focal-length language
// into the free-text camera field — if so, their wording wins and we don't
// append a redundant suggestion on top of it.
const LENS_TERM_RE = /\b(\d+\s?-?\s?\d*\s?mm|f\/\d|aperture|telephoto|wide angle|wide-angle|macro|fisheye)\b/i;

function getStoryboardLensSuggest(shotType) {
  return STORYBOARD_LENS_SUGGEST[shotType] || null;
}

function assignShotType(beatIndex, totalPanels, beat, prevShotType, composition) {
  const b = beat.toLowerCase();
  const c = (composition || '').toLowerCase();

  // Bug found in testing (2026-06-25, "ant-sized characters" repro, 5th
  // occurrence): this used to be an unconditional hard rule — panel 1 was
  // ALWAYS "Establishing Shot" and the last panel ALWAYS "Closing Shot",
  // regardless of what the beat actually described. Establishing Shot's
  // composition text explicitly calls for characters "small relative to
  // the environment" — correct for a true scene-setting wide, but wrong
  // when beat 1 (or the final beat) is actually a close two-person
  // conversation, a reaction, or anything else inherently tight. Forcing
  // "small in frame" wording onto a close scene, then attaching a literal
  // background reference photo, reliably produced human figures shrunk to
  // near-invisibility ("ants") against the background.
  // Fix: panel 1 / last panel now fall through to the SAME composition-cue
  // and beat-content rules every other panel already uses below, and only
  // default to Establishing/Closing afterward if nothing in the beat's own
  // content suggests a tighter framing — i.e. the rule becomes "default to
  // wide for the bookend panels," not "force wide no matter what."
  const isFirstOrLast = beatIndex === 0 || beatIndex === totalPanels - 1;
  const bookendDefault = beatIndex === 0 ? 'Establishing Shot' : 'Closing Shot';

  // ── COMPOSITION FRAMING CUES (highest priority) ─────────────
  // Composition text is deliberate, app-inferred/user-edited framing
  // language ("small in frame", "low angle... wide", "close on her face")
  // and is a more reliable signal than guessing shot size from beat verbs
  // alone. Bug found in testing: beat "shake his hands" classified as
  // Medium Shot via the action-verb rule below, but composition explicitly
  // said "Changdev and Dnyandev visible, small in frame" + "Environment
  // opens up around the action" — clearly Wide Shot — and that signal was
  // never read because assignShotType() only looked at beat text.
  // These checks run before any beat-only rule so explicit framing intent
  // always wins over a verb-based guess.
  if (c) {
    if (c.match(/\b(small in frame|visible,?\s*small|tiny in frame|dwarfed|distant figures?|figures? small|environment opens up|environment dominates|long shot|extreme wide|aerial|drone shot|bird'?s[- ]eye)\b/)) {
      return 'Wide Shot';
    }
    if (c.match(/\b(extreme close|ecu|macro|fills? the frame|fills the screen|only (his|her|their) (eyes|hands|face))\b/)) {
      return 'ECU';
    }
    if (c.match(/\b(close[- ]?up|close on|tight on|fills most of the frame)\b/)) {
      return 'Close-up';
    }
    // OS (over-the-shoulder) checked BEFORE the generic two-shot/medium
    // rule below — "two shot OS" or "two-shot, over the shoulder" must
    // resolve to OS, not get absorbed into plain Medium Shot. OS is its
    // own distinct framing: one character's shoulder/back-of-head fills
    // the foreground edge, the other character sharp beyond them — not
    // the same as a level two-shot where both face camera.
    if (c.match(/\bos\b|over[- ]the[- ]shoulder|over (his|her|their) shoulder|shoulder shot/)) {
      return 'OS';
    }
    if (c.match(/\b(waist[- ]up|two[- ]shot|medium shot|mid shot|chest[- ]up)\b/)) {
      return 'Medium Shot';
    }
    if (c.match(/\b(wide shot|wide angle|full[- ]?body|full[- ]?figure|wide framing|establishing|establish the|low angle,?\s*(slow )?(push|pull)?[- ]?in)\b/)) {
      // "low angle, slow push-in" alone is ambiguous (could end tight) —
      // only treat as Wide if not already overridden by a tighter cue above.
      return 'Wide Shot';
    }
  }

  // ── EXPLICIT SHOT-TYPE TOKENS IN BEAT TEXT ───────────────────
  // Bug found in testing (2026-06-27): writing shot-type intent directly in
  // the story/beat text — e.g. "Two Shot, OS" — was invisible to this
  // function. The composition-cue block above only reads the `composition`
  // field, which is usually app-INFERRED FROM shotType, not the reverse, so
  // on first generation there's nothing in `composition` yet to match
  // against. The result: panel 1/last panel fell straight through to
  // bookendDefault (a wide Establishing/Closing Shot) even when the user's
  // own beat text explicitly called for a tight OS or two-shot. Checking the
  // beat text itself, before the bookend fallback, lets explicit user intent
  // win regardless of panel position.
  // OS checked first — "two shot, OS" must resolve to OS, not Medium Shot.
  if (b.match(/\bos\b|over[- ]the[- ]shoulder|over (his|her|their) shoulder|shoulder shot/)) {
    return 'OS';
  }
  if (b.match(/\btwo[- ]shot\b|\bwaist[- ]up\b|\bmedium shot\b|\bmid shot\b/)) {
    return 'Medium Shot';
  }
  if (b.match(/\bestablishing shot\b|\bestablish(es|ing)? the\b|\bwide shot\b/)) {
    return 'Wide Shot';
  }
  if (b.match(/\bclose[- ]?up\b|\btight on\b|\bclose on\b/)) {
    return 'Close-up';
  }
  if (b.match(/\becu\b|\bextreme close[- ]?up\b/)) {
    return 'ECU';
  }

  // ── THREAT / VEHICLE IN MOTION ──────────────────────────────
  // A moving vehicle is the subject. Show it — wide, vehicle dominant.
  // Skill: "Transition or reorientation → Wide or medium re-establishing"
  if (b.match(/\b(car|vehicle|truck|bus|bike|scooter|auto|motorcycle|jeep)\b/) &&
      b.match(/\b(drive|driving|fast|speed|rush|rushing|racing|moving|approach|coming|toward|towards|aggressiv|out of control|barreling)\b/)) {
    return 'Wide Shot'; // car is subject — show it in full environment context
  }

  // ── PROP/OBJECT INSERT ──────────────────────────────────────
  // Skill: "Prop detail → Insert — ECU of prop only"
  if (b.match(/\b(newspaper|phone|letter|note|book|weapon|knife|gun|watch|ring|key)\b/) &&
      !b.match(/\b(sitting|standing|walking|talking|reading)\b/)) {
    return 'ECU';
  }

  // ── REACTION / EMOTIONAL STATE ──────────────────────────────
  // Skill: "Emotional reaction → Clean single MCU or CU — one face only, nothing competing"
  // Skill hard rule: "Reaction shots are always clean singles."
  if (b.match(/\b(frighten|frightened|scared|terrified|shocked|shock|notices|notice|glances|glance|realise|realizes|horrified|panic|stun|stunned|awe|overwhelm)\b/)) {
    return 'Close-up';
  }

  // ── ACTION DIRECTED AT ANOTHER CHARACTER ────────────────────
  // Skill: "Action directed at another character → Two-shot medium"
  // Includes greeting/contact gestures between two people (handshake, hug,
  // embrace) — these are two-character interactions, not isolated hand/prop
  // inserts, even though the word "hand(s)" appears in the sentence. Bug
  // found in testing: "shake his hands with X" was falling through to the
  // ECU rule below and misclassifying a wide two-shot as an extreme close-up.
  if (b.match(/\b(moves toward|moving toward|rushes toward|runs toward|charges at|grabs|pushes|pulls|strikes|attacks|confronts|faces|points at|shake[s]? (his|her|their|hands)|shaking hands|hugs?|embraces?|greets?)\b/)) {
    return 'Medium Shot';
  }

  // ── HANDS / GESTURE INSERT ──────────────────────────────────
  // Skill: "Prop detail → Insert — ECU of prop only" (extended to hands)
  // Exclusion list catches sentences that are clearly about a person/people
  // (not just an isolated hand/object) so they don't get misclassified as
  // ECU. Fixed: original regex required "he "/"she "/"they " with a literal
  // trailing space, which never matched possessives like "his"/"her"/
  // "their" — broadening to match those pronoun forms directly.
  if (b.match(/\b(hand|gesture|hold|raise|offer|touch|point|finger|reach|grip)\b/) &&
      !b.match(/\b(character|person|figure|he|she|they|his|her|their|him|them)\b/)) {
    return 'ECU';
  }

  // ── CROWD / GROUP / ENVIRONMENT ─────────────────────────────
  // Skill: "Establish group, location, all props → Wide three-shot or group shot"
  if (b.match(/\b(crowd|gather|group|procession|army|people|together|assembled|all|everyone)\b/)) {
    return 'Wide Shot';
  }

  // ── DIALOGUE / INTERACTION ──────────────────────────────────
  // Skill: "Action directed at another character → Two-shot medium"
  if (b.match(/\b(says|said|asks|tells|talk|talks|speaks|conversation|discuss|reply|answer)\b/)) {
    return 'Medium Shot';
  }

  // ── FACIAL / CLOSE EXPRESSION ───────────────────────────────
  if (b.match(/\b(face|eyes|expression|weep|tear|smile|laugh|jaw|brow|stare|gaze|look)\b/)) {
    return 'Close-up';
  }

  // ── MOVEMENT / ARRIVAL ──────────────────────────────────────
  if (b.match(/\b(walk|arrive|enter|leave|run|charge|cross|approach|exit)\b/)) {
    return 'Medium Shot';
  }

  // ── DEFAULT ──────────────────────────────────────────────────
  // Bookend panels (first/last): nothing in the beat's own content
  // signalled a tighter shot above, so fall back to the conventional
  // Establishing/Closing default here — but only as a default, not a
  // forced override, so a close-content beat 1/last beat (caught by one
  // of the content rules above) is never overruled.
  if (isFirstOrLast) return bookendDefault;

  // alternate Wide/Medium — but NEVER repeat previous
  // Skill: double contrast enforced — consecutive same sizes not allowed
  const defaultSequence = ['Wide Shot', 'Medium Shot'];
  let candidate = defaultSequence[beatIndex % 2];

  // Enforce contrast — shift if same as previous
  if (prevShotType && candidate === prevShotType) {
    candidate = candidate === 'Wide Shot' ? 'Medium Shot' : 'Wide Shot';
  }

  return candidate;
}

function assignAngle(shotType, beatIndex) {
  if (shotType === 'Establishing Shot') return 'high angle, wide — locked-off';
  if (shotType === 'Wide Shot') return 'eye level — ' + CAMERA_MODES[beatIndex % 3 === 0 ? 3 : 0];
  if (shotType === 'Medium Shot') return (beatIndex % 2 === 0 ? 'low angle' : 'eye level') + ' — ' + CAMERA_MODES[(beatIndex + 1) % CAMERA_MODES.length];
  if (shotType === 'OS') return 'eye level — static'; // OS is a fixed two-character framing, not a moving/tracking shot
  if (shotType === 'Close-up') return 'eye level — ' + CAMERA_MODES[(beatIndex + 2) % 3];
  if (shotType === 'ECU') return 'eye level — static';
  if (shotType === 'Closing Shot') return 'low angle — slow push-in';
  return 'eye level — static';
}

/* ── SHOT-SCALE-AWARE DESCRIPTION ────────────────────────── */
// Returns which asset fields to emphasise based on shot scale
function getScaleEmphasis(shotType) {
  if (shotType === 'Close-up' || shotType === 'ECU')
    return 'face'; // face detail, emotional state, eyes
  if (shotType === 'Medium Shot' || shotType === 'OS')
    return 'waist'; // costume, gesture, upper body
  if (shotType === 'Wide Shot' || shotType === 'Establishing Shot')
    return 'wide'; // full body, environment, spatial positioning
  return 'full';
}

/* ── MASTER SHOT EXTRACTION ──────────────────────────────── */
// Extracts locked values from panel 1 for continuity
function extractMasterValues(panel, mentions) {
  const chars = mentions.filter(m => m.asset.type === 'character');
  const locs = mentions.filter(m => m.asset.type === 'location');

  return {
    lighting: 'lighting established in panel 1',
    location: locs.length ? locs[0].asset.name : null,
    characters: chars.map(m => m.asset.name),
    angle: panel.angle,
    shotType: panel.shotType
  };
}

/* ── CAMERA NOTE ─────────────────────────────────────────── */
function buildCameraNote(panel, index, totalPanels) {
  const { shotType, angle } = panel;
  const cuts = index < totalPanels - 1 ? 'Cut to next panel.' : 'Hold on final frame.';
  const lensSuggest = getStoryboardLensSuggest(shotType);
  const lensBit = lensSuggest ? ` · ${lensSuggest.lens}, ${lensSuggest.aperture}` : '';
  return `${shotType} · ${angle}${lensBit} · ${cuts}`;
}

/* ══════════════════════════════════════════════════════════════
   SCENE MODEL ENGINE
   Builds a structured understanding of the story from library
   assets and story text — before any shot or prompt decisions.
   This is the foundation of all offline cinematic intelligence.
══════════════════════════════════════════════════════════════ */

function buildSceneModel(story, mentions) {
  const p = getCurrentProject();

  // ── SPATIAL MAP ─────────────────────────────────────────────
  // Built from library asset data — not from guessing story text
  const locations = mentions.filter(m => m.asset.type === 'location');
  const characters = mentions.filter(m => m.asset.type === 'character');
  const props = mentions.filter(m => m.asset.type === 'prop');

  const spatialMap = {};

  locations.forEach(m => {
    const loc = m.asset;
    spatialMap[loc.name] = {
      type: 'location',
      description: loc.description || '',
      spatialContext: loc.spatialContext || '',
      atmosphere: loc.atmosphere || '',
      keyDetails: loc.keyDetails || '',
      // Parse adjacency from spatialContext
      adjacentTo: extractAdjacency(loc.spatialContext || loc.description || ''),
      isIndoor: isIndoorLocation(loc.spatialContext || loc.description || ''),
      hasRoad: hasRoadAdjacency(loc.spatialContext || loc.description || ''),
      characters: []
    };
  });

  // Place characters at their locations based on @mentions in story
  characters.forEach(m => {
    const char = m.asset;
    // Find which location this character is mentioned near in the story
    const charLocation = findCharacterLocation(char.name, story, locations);
    if (charLocation && spatialMap[charLocation]) {
      spatialMap[charLocation].characters.push({
        name: char.name,
        asset: char,
        defaultPosition: getDefaultPosition(char, story)
      });
    }
  });

  // ── EVENT TIMELINE ──────────────────────────────────────────
  // Classify each sentence as an event type
  const sentences = story
    .replace(/([.!?।])\s+/g, '$1\n')
    .replace(/,?\s+(then|suddenly|meanwhile|meanwhile,|as |next|finally|after that|at that moment|moments later|just then),?\s+/gi, '\n')
    .split('\n')
    .map(s => s.trim())
    .filter(Boolean);

  const events = [];
  for (let idx = 0; idx < sentences.length; idx++) {
    const sentence = sentences[idx];
    const type = classifyEvent(sentence, idx, sentences);
    const prevSubject = idx > 0 ? events[idx - 1].subject : null;
    const subject = detectSubject(sentence, characters, type, prevSubject);
    events.push({ sentence, type, subject, idx });
  }

  // ── DRAMATIC ARC ────────────────────────────────────────────
  const arc = buildDramaticArc(events);

  // ── NON-ASSET ELEMENTS ──────────────────────────────────────
  // Vehicles, weather, objects mentioned in story but not in library
  const nonAssetElements = detectNonAssetElements(story, mentions);

  return {
    spatialMap,
    characters,
    locations,
    events,
    arc,
    nonAssetElements,
    primaryLocation: locations[0]?.asset || null,
    primaryChar: characters[0]?.asset || null
  };
}

/* ── SPATIAL HELPERS ─────────────────────────────────────── */
function extractAdjacency(text) {
  const t = text.toLowerCase();
  const adj = [];
  if (t.match(/beside|adjacent|next to|along|roadside|by the road|near the road/)) adj.push('road');
  if (t.match(/beside|adjacent|next to|along|river|lakeside|waterfront/)) adj.push('water');
  if (t.match(/forest|jungle|trees|woodland/)) adj.push('forest');
  if (t.match(/hill|mountain|elevated|hilltop/)) adj.push('elevation');
  return adj;
}

function isIndoorLocation(text) {
  return /\b(inside|interior|indoor|enclosed|within|hall|room|building|temple interior|cave)\b/i.test(text);
}

function hasRoadAdjacency(text) {
  return /\b(road|highway|street|roadside|beside.*road|along.*road|road.*side)\b/i.test(text);
}

function findCharacterLocation(charName, story, locations) {
  // Find which location the character is @mentioned near
  const storyLower = story.toLowerCase();
  const charLower = charName.toLowerCase();
  for (const loc of locations) {
    const locLower = loc.asset.name.toLowerCase();
    // Check if character and location are @mentioned in the same sentence
    const sentences = story.split(/[.!?।]/);
    for (const s of sentences) {
      const sl = s.toLowerCase();
      if (sl.includes(charLower) && sl.includes(locLower)) return loc.asset.name;
      if (sl.includes('@' + charLower) && sl.includes('@' + locLower)) return loc.asset.name;
    }
  }
  return locations[0]?.asset.name || null;
}

function getDefaultPosition(char, story) {
  const s = story.toLowerCase();
  const name = char.name.toLowerCase();
  // Find position words near this character's name
  const idx = s.indexOf(name);
  if (idx === -1) return 'seated';
  const context = s.slice(Math.max(0, idx - 50), idx + 80);
  if (context.match(/sit|seated|stool|chair|bench/)) return 'seated';
  if (context.match(/stand|standing/)) return 'standing';
  if (context.match(/inside|within|behind counter/)) return 'inside';
  if (context.match(/walk|walking|moving/)) return 'moving';
  return 'present';
}

/* ── EVENT CLASSIFICATION ────────────────────────────────── */
function classifyEvent(sentence, idx, allSentences) {
  const s = sentence.toLowerCase();

  // ── PRIORITY 0: Explicit shot-type token in the beat text itself ──
  // Bug found in testing (2026-06-27): a user writing "OS" or "over the
  // shoulder" directly in their story had no way to actually get an OS
  // shot — there was no OS event type, no OS branch anywhere in the
  // offline pipeline, and the literal token was never checked against beat
  // text at all (only against the app-inferred `composition` field, which
  // doesn't exist yet on first generation). Checked first, above every
  // other priority, so explicit user intent always wins.
  if (s.match(/\bos\b|over[- ]the[- ]shoulder|over (his|her|their) shoulder|shoulder shot/))
    return 'TWO_CHAR_OS';

  // ── PRIORITY 1: Reaction beats — checked BEFORE vehicle beats ──
  // A beat with "hears/glances/notices" is a reaction even if it mentions a car.
  // A beat with "frightened/shocked" is a fear reaction even if car is also mentioned.
  if (s.match(/\b(frighten|frightened|scared|terrified|shocked|shock|panic|horror)\b/))
    return 'CHARACTER_REACTS_FEAR';

  if (s.match(/\b(notices|notice|glances|glance|hears|hear|looks up|sees|spots)\b/) &&
      !s.match(/\b(aggressiv|out of control|swerv|crash|impact)\b/))
    return 'CHARACTER_REACTS_NOTICE';

  // ── PRIORITY 2: Action beats ──
  if (s.match(/\b(jump|jumps|jumping|run|runs|flee|flees|escape|escapes|dives|dive|leaps|leap)\b/))
    return 'CHARACTER_ACTS';

  if (s.match(/\b(about to|ready to|prepares to|starts to)\b/) &&
      s.match(/\b(jump|run|flee|escape|dive|leap)\b/))
    return 'CHARACTER_ACTS';

  // ── PRIORITY 3: Threat escalation — car NOW at or near the stall ──
  // "approaching near", "moves towards [character]", "aggressively", "out of control"
  if (s.match(/\b(car|vehicle|truck)\b/) &&
      s.match(/\b(approaching near|moves toward|moving toward|aggressiv|out of control|swerv|off the road|toward.*stall|toward.*[a-z]+ak)\b/))
    return 'THREAT_ESCALATES';

  // ── PRIORITY 4: Threat appears — car visible on road, not yet at stall ──
  if (s.match(/\b(car|vehicle|truck|bus|bike|motorcycle)\b/) &&
      s.match(/\b(fast|speed|rush|rushing|racing|driving|coming|approaching|over the road|on the road)\b/))
    return 'THREAT_APPEARS';

  // ── PRIORITY 5: Idle / establishing ──
  // Bug found in testing (2026-06-25, "ant-sized characters" repro):
  // idx === 0 used to unconditionally force ESTABLISH regardless of what
  // beat 1 actually said — a close two-person conversation opening beat
  // would still get tagged ESTABLISH, which shotTypeFromModel() then turns
  // into a wide "Establishing Shot" with composition text explicitly
  // calling for characters "small relative to the environment." Combined
  // with a literal background reference photo, that reliably shrank
  // characters to near-invisibility. Now ESTABLISH for beat 1 is only the
  // fallback when nothing else above already classified it (e.g. a
  // reaction or action beat opening the story is honoured instead).
  if (s.match(/\b(sitting|reading|preparing|making|working|standing|idle|normal day)\b/))
    return 'CHARACTER_IDLE';
  if (idx === 0) return 'ESTABLISH';

  return 'CHARACTER_IDLE';
}

/* ── SUBJECT DETECTION ───────────────────────────────────── */
function detectSubject(sentence, characters, eventType, prevSubject) {
  const s = sentence.toLowerCase();

  // Threat events — subject is the threat
  if (eventType === 'THREAT_APPEARS' || eventType === 'THREAT_ESCALATES') {
    const vehicleMatch = sentence.match(/\b(red |blue |white |black |silver )?(car|vehicle|truck|bus|motorcycle)\b/i);
    return { type: 'threat', name: vehicleMatch ? vehicleMatch[0].trim() : 'vehicle' };
  }

  // Find explicitly named or @mentioned character in this sentence
  for (const m of characters) {
    const name = m.asset.name.toLowerCase();
    if (s.includes('@' + name) || s.includes(name)) {
      return { type: 'character', name: m.asset.name, asset: m.asset };
    }
  }

  // Pronoun resolution — "He/She/They" with no name
  // Use previous beat subject if it was a character
  const hasPronounOnly = s.match(/^(he|she|they)\b/) ||
    s.match(/\b(he is|she is|they are|he was|she was)\b/) ||
    (!characters.some(m => s.includes(m.asset.name.toLowerCase())));

  if (hasPronounOnly && prevSubject && prevSubject.type === 'character') {
    return prevSubject;
  }

  // Default to primary character
  return characters[0]
    ? { type: 'character', name: characters[0].asset.name, asset: characters[0].asset }
    : { type: 'unknown', name: 'subject' };
}

/* ── DRAMATIC ARC ────────────────────────────────────────── */
function buildDramaticArc(events) {
  return events.map((ev, idx) => {
    switch (ev.type) {
      case 'ESTABLISH':          return 'CALM';
      case 'TWO_CHAR_OS':        return 'CALM'; // dialogue/conversation framing — same arc weight as idle/establish
      case 'CHARACTER_IDLE':     return idx < events.length / 2 ? 'CALM' : 'SETTLING';
      case 'THREAT_APPEARS':     return 'RISING';
      case 'CHARACTER_REACTS_NOTICE': return 'RISING';
      case 'THREAT_ESCALATES':   return 'PEAK';
      case 'CHARACTER_REACTS_FEAR':   return 'PEAK';
      case 'CHARACTER_ACTS':     return idx === events.length - 1 ? 'RESOLVING' : 'PEAK';
      default:                   return 'CALM';
    }
  });
}

/* ── NON-ASSET ELEMENT DETECTION ─────────────────────────── */
function detectNonAssetElements(story, mentions) {
  const mentionedNames = new Set(mentions.map(m => m.asset.name.toLowerCase()));
  const found = [];
  const s = story.toLowerCase();

  const vehicles = story.match(/\b(red |blue |white |black |silver |yellow )?(car|vehicle|truck|bus|bike|scooter|motorcycle|jeep|auto)\b/gi) || [];
  vehicles.forEach(v => {
    if (!mentionedNames.has(v.toLowerCase().trim())) found.push({ type: 'vehicle', name: v.trim() });
  });

  if (s.match(/\bnewspaper\b/) && !mentionedNames.has('newspaper'))
    found.push({ type: 'prop', name: 'newspaper' });
  if (s.match(/\bphone\b|\bmobile\b/) && !mentionedNames.has('phone'))
    found.push({ type: 'prop', name: 'mobile phone' });
  if (s.match(/\brain\b|\bstorm\b|\bfog\b/))
    found.push({ type: 'atmosphere', name: story.match(/\b(rain|storm|fog)\b/i)?.[0] || 'weather' });

  // Deduplicate
  const seen = new Set();
  return found.filter(f => { if (seen.has(f.name)) return false; seen.add(f.name); return true; });
}

/* ── SHOT TYPE FROM SCENE MODEL ──────────────────────────── */
function shotTypeFromModel(event, idx, total, prevShotType, sceneModel) {
  // Bug found in testing (2026-06-25, "ant-sized characters" repro): this
  // used to unconditionally force idx 0 -> "Establishing Shot" and the
  // last panel -> "Closing Shot" regardless of event.type — overriding
  // even a CHARACTER_REACTS_FEAR or CHARACTER_ACTS classification that
  // classifyEvent() had already correctly assigned from the beat's actual
  // content (e.g. a story opening on a close two-person conversation, or
  // ending mid-action). Establishing Shot's composition text explicitly
  // calls for characters "small relative to the environment," which —
  // combined with an attached background reference photo — reliably
  // shrank characters to near-invisibility on beats that were never
  // actually wide/establishing in content. classifyEvent() (above) already
  // only returns ESTABLISH for idx 0 as ITS OWN fallback when nothing else
  // matched the beat text, so it's now safe to just honour event.type
  // here too, via the normal switch below, rather than overriding it.
  let isFirstOrLast = idx === 0 || idx === total - 1;
  let bookendDefault = idx === 0 ? 'Establishing Shot' : 'Closing Shot';

  let candidate;
  // Track whether this is a reaction shot — exempt from double contrast
  // Skill hard rule: reaction shots are always clean singles, never bumped
  let isReactionShot = false;

  switch (event.type) {
    case 'ESTABLISH':
      candidate = 'Establishing Shot'; break;
    case 'TWO_CHAR_OS':
      candidate = 'OS'; break; // explicit beat-text token — always honoured, see classifyEvent() PRIORITY 0
    case 'CHARACTER_IDLE':
      candidate = 'Medium Shot'; break;
    case 'THREAT_APPEARS':
      candidate = 'Wide Shot'; break;
    case 'THREAT_ESCALATES':
      candidate = 'Wide Shot'; break;
    case 'CHARACTER_REACTS_NOTICE':
      candidate = 'Close-up'; isReactionShot = true; break;  // NEVER bumped by contrast
    case 'CHARACTER_REACTS_FEAR':
      candidate = 'Close-up'; isReactionShot = true; break;  // NEVER bumped by contrast
    case 'CHARACTER_ACTS':
      candidate = 'Medium Shot'; break;
    default:
      candidate = isFirstOrLast ? bookendDefault
        : (prevShotType === 'Wide Shot' ? 'Medium Shot' : 'Wide Shot');
  }

  // Double contrast — never repeat same shot consecutively
  // EXCEPTION: reaction shots (Close-up) are always honoured — skill hard rule
  // EXCEPTION: explicit OS token (event.type === 'TWO_CHAR_OS') is always
  // honoured too — same reasoning as reaction shots: an explicit user
  // instruction in the beat text should never be silently bumped to
  // satisfy a generic "don't repeat" rule.
  // EXCEPTION: bookend panels keep their content-derived candidate even if
  // it matches prevShotType — better to repeat a shot size than to bump a
  // close reaction/action beat into an inappropriately wide bookend shot.
  const isExplicitOverride = isReactionShot || event.type === 'TWO_CHAR_OS';
  if (!isExplicitOverride && !isFirstOrLast && prevShotType && candidate === prevShotType) {
    candidate = candidate === 'Wide Shot' ? 'Medium Shot'
      : candidate === 'Medium Shot' ? 'Wide Shot'
      : 'Wide Shot';
  }

  return candidate;
}

/* ── COMPOSITION FROM SCENE MODEL ────────────────────────── */
function compositionFromModel(shotType, event, sceneModel, vehicleBeatCount) {
  // Bug fix 2026-07-07 (found live, Shot Setup phase-3 testing session):
  // sceneModel.primaryLocation is picked ONCE for the whole story
  // (buildSceneModel() — first location in whole-story mention order,
  // which reflects asset-store iteration order, not narrative relevance)
  // and was reused unchanged for every single panel here. A panel whose
  // own sentence names a specific narrative location (e.g. "sits quietly
  // at the Wada corner") still anchored on whichever OTHER mentioned
  // location happened to come first story-wide (e.g. "Jana home night",
  // an establishing location named earlier) — same class of bug as the
  // 2026-06-29 whole-story-leak fix just below, just never applied to
  // locations. Fix: filter down to the location(s) THIS event's own
  // sentence actually names first, exactly mirroring charsInThisPanel's
  // approach a few lines down; fall back to sceneModel.primaryLocation
  // only when the sentence names no location at all (e.g. a reaction/
  // insert beat with no location word of its own — today's behavior,
  // unchanged for that case).
  const sentenceLowerForLoc = (event.sentence || '').toLowerCase();
  const locsInThisPanel = sceneModel.locations.filter(m => {
    const name = m.asset.name.toLowerCase();
    return sentenceLowerForLoc.includes('@' + name) || sentenceLowerForLoc.includes(name);
  });
  const loc = locsInThisPanel.length ? locsInThisPanel[0].asset : sceneModel.primaryLocation;
  const spatialCtx = loc?.spatialContext || loc?.description || '';
  const locName = loc?.name || 'the location';
  const hasRoad = sceneModel.spatialMap[locName]?.hasRoad ||
    hasRoadAdjacency(spatialCtx);
  const isIndoor = sceneModel.spatialMap[locName]?.isIndoor || false;
  const subject = event.subject;
  // Bug fix 2026-06-29 (Task #2, found via live Test B): sceneModel.characters
  // is the WHOLE-STORY character list (every character @mentioned anywhere
  // across all panels — see buildSceneModel()), not this panel's own cast.
  // Using it directly as `chars` here leaked every story character into
  // composition text (e.g. Closing Shot's "narrative settling" line) even
  // on a panel whose own beat mentions zero characters. Filter down to only
  // the characters actually named in this panel's own sentence — same
  // string-matching approach detectSubject() already uses just above in
  // this file — so `chars`/`primary`/`secondary` reflect this panel only.
  const sentenceLower = (event.sentence || '').toLowerCase();
  const charsInThisPanel = sceneModel.characters.filter(m => {
    const name = m.asset.name.toLowerCase();
    return sentenceLower.includes('@' + name) || sentenceLower.includes(name);
  });
  // If the sentence names no character at all (e.g. a prop/location-only
  // beat), fall back to the event's own detected subject when it's a
  // character (covers pronoun-resolved beats) — otherwise stay empty rather
  // than silently reusing the whole story's cast.
  const chars = charsInThisPanel.length
    ? charsInThisPanel
    : (subject?.type === 'character' && subject.asset ? [{ asset: subject.asset }] : []);
  const primary = chars[0]?.asset.name || 'the subject';
  const secondary = chars[1]?.asset.name || null;

  // Get position descriptions from spatial map
  const charPositions = sceneModel.spatialMap[locName]?.characters || [];
  function charPos(name) {
    const cp = charPositions.find(c => c.name === name);
    return cp ? cp.defaultPosition : 'present';
  }

  // ── REACTION SHOTS — checked FIRST — beat may contain "car" + "hears/notices" ──
  // Skill hard rule: reaction = clean single, one face only
  if (event.type === 'CHARACTER_REACTS_NOTICE' || event.type === 'CHARACTER_REACTS_FEAR') {
    const reactor = subject.name || primary;
    const pos = charPos(reactor);
    const posDesc = pos === 'seated' ? `${reactor} is seated at the stall` :
                    pos === 'inside' ? `${reactor} is inside the stall` :
                    `${reactor} is at ${locName}`;
    const reactionPhysics = event.type === 'CHARACTER_REACTS_FEAR'
      ? 'eyes wide, brow raised, jaw open, body weight pulling back — fear as physical fact'
      : 'head turning, eyes lifting toward the road — attention caught by sound';
    return `Eye level, static. Camera frames ${reactor}'s face — crown to chin, filling the frame. ${posDesc}. ${reactionPhysics}. Background out of focus — colour and light only, no readable detail. Frame contains one figure only — ${reactor}.`;
  }

  // ── THREAT SHOTS ─────────────────────────────────────────────
  // Camera at stall side facing the road — so car trajectory toward stall is visible
  if (event.type === 'THREAT_APPEARS' || event.type === 'THREAT_ESCALATES') {
    const vehicle = subject.name || 'vehicle';
    const isThreatEscalating = event.type === 'THREAT_ESCALATES';

    // Character positions at the stall — stated as spatial facts
    const charPosDesc = charPositions.length
      ? charPositions.map(cp => {
          const posWord = cp.defaultPosition === 'inside' ? 'inside the stall' :
                         cp.defaultPosition === 'seated' ? 'seated at the stall in the foreground' :
                         'at the stall in the foreground';
          return `${cp.name} — ${posWord}`;
        }).join('. ') + '.'
      : `${primary} at the stall in the foreground.`;

    if (isThreatEscalating) {
      // Car is now off the road, aimed directly at the stall
      // Camera at stall level, low, looking back toward the road
      // Car fills mid-ground, angled toward stall — clear loss of control
      return `Low angle, locked-off. Camera positioned at stall level, in front of the stall, facing back toward the road. ${locName} visible behind, frame-left (as viewed). ${charPosDesc} Road visible in mid-ground. ${vehicle} in mid-ground — front of car angled sharply off the road, pointed directly toward the stall and the characters. Car is clearly off its lane, trajectory aimed at the foreground. Motion blur on ${vehicle} — high speed. Dust or gravel kicking from tyres. Sense of imminent impact. Deep focus.`;
    } else {
      // Car first appears — camera at stall side, car on road but heading this way
      // Stall and character visible frame-left, road frame-right, car coming along road toward stall
      return `Eye level, locked-off. Camera positioned beside the stall, facing along the road. ${locName} and ${charPosDesc} Road stretches into background at frame-right (as viewed). ${vehicle} on the road in mid-ground — coming toward camera along the road, front of car facing this direction. Motion blur on ${vehicle}. Both the stall area and the approaching car visible in the same frame — spatial relationship between threat and characters established. Deep focus.`;
    }
  }

  // ── ESTABLISHING ─────────────────────────────────────────────
  if (shotType === 'Establishing Shot') {
    const allChars = chars.map(m => m.asset.name).join(' and ');
    const spatialDesc = spatialCtx
      ? `${locName} — ${spatialCtx}.`
      : `${locName} fills the frame.`;
    // Wording fix (2026-06-25, "ant-sized characters" bug): "small relative
    // to the environment" was a literal shrink instruction that, combined
    // with an attached background reference photo, reliably rendered
    // characters as near-invisible specks. Changed to instruct readable
    // foreground scale instead — the shot is still wide and environment-
    // dominant (that's carried by "high angle," the deep-focus line, and
    // the environment filling the background), but characters must stay
    // legible, not shrunk to the point of disappearing.
    return `High angle, locked-off. Camera faces the scene from above and ahead. ${spatialDesc} ${allChars ? allChars + ' visible in the foreground, clearly readable at a recognizable human scale — wide and environment-dominant, but characters must remain legible, never reduced to indistinct specks.' : ''} Deep focus — foreground, mid-ground, and background all sharp.`;
  }

  // ── MEDIUM — subject-aware ───────────────────────────────────
  if (shotType === 'Medium Shot') {
    const subjectName = subject.type === 'character' ? subject.name : primary;
    const otherChar = chars.find(m => m.asset.name !== subjectName);
    const pos = charPos(subjectName);
    const posDesc = pos === 'inside' ? `${subjectName} inside the stall, waist-up` :
                    pos === 'seated' ? `${subjectName} seated, waist-up` :
                    `${subjectName} waist-up`;
    const secondaryDesc = otherChar
      ? `${otherChar.asset.name} visible at frame edge — soft focus, partial figure, directional anchor.`
      : '';
    const bgDesc = isIndoor
      ? `${locName} interior visible behind — depth and atmosphere.`
      : `${locName} softly suggested in background.`;
    return `Eye level. Camera faces ${subjectName}. ${posDesc}, sharp and centred. ${secondaryDesc} ${bgDesc}`;
  }

  // ── OS (OVER-THE-SHOULDER) — two characters required ──────────
  // Distinct from Medium Shot: camera sits close behind one character's
  // shoulder (soft focus, frame edge) looking past them at the other
  // character (sharp, facing camera/foreground character). Falls back to
  // a single-subject framing only if the scene genuinely has one character.
  if (shotType === 'OS') {
    const subjectName = subject.type === 'character' ? subject.name : primary;
    const otherChar = chars.find(m => m.asset.name !== subjectName);
    const bgDesc = isIndoor
      ? `${locName} interior visible behind ${otherChar ? otherChar.asset.name : 'the subject'} — depth and atmosphere.`
      : `${locName} softly suggested behind ${otherChar ? otherChar.asset.name : 'the subject'}.`;
    if (!otherChar) {
      return `Eye level. Camera positioned close behind ${subjectName}'s shoulder, soft focus on the shoulder/back of head at frame edge. ${locName} sharp beyond. ${bgDesc}`;
    }
    // Scale fix (found via Single Frame testing 2026-06-29, same gap here) —
    // see matching note on the other OS branch above in this file.
    return `Eye level. Camera positioned close behind ${subjectName}'s shoulder, occupying the frame-left (as viewed) portion of the frame — shoulder and back/side of head fill the lower-frame edge on frame-left, soft focus, large in frame, not the subject. ${otherChar.asset.name} positioned on frame-right beyond ${subjectName}'s shoulder, sharp and in focus, but smaller and more distant in the frame than ${subjectName} — only head, shoulders, and upper torso visible (not full body), facing toward ${subjectName}/camera. ${bgDesc}`;
  }

  // ── WIDE — subject aware ─────────────────────────────────────
  if (shotType === 'Wide Shot') {
    const allCharsDesc = chars.map(m => {
      const pos = charPos(m.asset.name);
      return `${m.asset.name} — ${pos === 'inside' ? 'inside the stall' : pos === 'seated' ? 'seated beside the stall' : 'at ' + locName}`;
    }).join('. ');
    const spatialDesc = spatialCtx
      ? `${locName} — ${spatialCtx}.`
      : `${locName} in background.`;
    return `Eye level. ${spatialDesc} ${allCharsDesc}. Both fully visible. Deep focus.`;
  }

  // ── CLOSING ──────────────────────────────────────────────────
  if (shotType === 'Closing Shot') {
    const allChars = chars.map(m => m.asset.name).join(' and ');
    const spatialDesc = spatialCtx ? `${locName} — ${spatialCtx.split(',')[0].trim()}.` : `${locName}.`;
    const beatLower = (event.sentence || '').toLowerCase();

    // Read the actual action from the beat — don't use generic "walking away"
    let actionDesc = '';
    if (beatLower.match(/\b(jump|jumps|jumping|leaps|leap)\b/)) {
      const actor = subject.name || primary;
      actionDesc = `${actor} mid-jump from the stall — body in motion, feet leaving the ground.`;
    } else if (beatLower.match(/\b(run|runs|running|flee|flees|escape)\b/)) {
      const actor = subject.name || primary;
      actionDesc = `${actor} running from the stall — full body in motion, urgency visible.`;
    } else if (beatLower.match(/\b(fall|falls|collapse|crashes)\b/)) {
      const actor = subject.name || primary;
      actionDesc = `${actor} falling — body weight giving way, ground approaching.`;
    } else {
      // Generic closing — figures full-body, environment opens
      // Wording matters here: "full-body, wide framing" is unambiguous and
      // matches the Wide Shot composition-cue rule in assignShotType()
      // (which checks for "full body"). Previously said "small in frame",
      // which is vague scene-description language, not a framing
      // instruction — it never reliably signalled wide vs. anything else,
      // and got the reference-image picker stuck defaulting to closeup
      // for Closing Shot panels (getImageForShot() doesn't special-case
      // "Closing Shot" at all, so wording here is the only lever).
      actionDesc = `${allChars ? allChars + ' visible full-body, wide framing — narrative settling.' : 'Scene settling, wide framing.'}`;
    }

    return `Low angle, slow push-in. Camera holds at stall level. ${actionDesc} ${spatialDesc} Environment opens up around the action. Hold on final frame.`;
  }

  // ── ECU ──────────────────────────────────────────────────────
  if (shotType === 'ECU') {
    const target = subject.type === 'threat' ? subject.name :
      sceneModel.nonAssetElements[0]?.name || `${primary}'s hands`;
    return `Static macro. Camera frames ${target} in extreme close-up. Single subject fills frame. Background reduced to abstract colour and light. Surface texture and material detail fully visible.`;
  }

  return `Camera faces ${primary}. ${locName} in background.`;
}

/* ── VEHICLE BEAT COUNTER ────────────────────────────────── */
// Tracks how many vehicle threat beats have appeared for escalation
function countVehicleBeats(events, upToIndex) {
  return events.slice(0, upToIndex).filter(
    e => e.type === 'THREAT_APPEARS' || e.type === 'THREAT_ESCALATES'
  ).length;
}

// Last failure reason from smartSplit(), read by generateStoryboard() to
// show the user something more useful than "Smart Split failed".
let _lastSmartSplitError = '';

/* ── MAIN GENERATE FUNCTION ──────────────────────────────── */
async function generateStoryboard() {
  const story = document.getElementById('sb-story-text')?.value.trim();
  if (!story) { showToast('Write your story first', 'warning'); return; }

  sbState.storyText = story;
  sbState.style = document.getElementById('sb-style')?.value.trim() || '';
  sbState.colour = document.getElementById('sb-colour')?.value.trim() || '';
  sbState.camera = document.getElementById('sb-camera')?.value.trim() || '';
  // aspectRatio is set by setSBRatio chip — already in sbState

  const apiKey = isApiActive('anthropic') ? getApiKey('anthropic') : '';
  const count = sbState.panelCount;

  // Parse @ mentions from story text
  const mentions = parseAtMentions(story);

  // Extract char names and location for beat expansion
  const charNames = mentions.filter(m => m.asset.type === 'character').map(m => m.asset.name);
  const locName = mentions.filter(m => m.asset.type === 'location').map(m => m.asset.name)[0] || '';

  // BUILD SCENE MODEL — the foundation of all shot and composition decisions
  const sceneModel = buildSceneModel(story, mentions);

  // Warn if no @ mentions
  if (mentions.length === 0) {
    showToast('Tip: use @name to link library assets for richer prompts', 'warning');
  }

  showSBLoading(apiKey ? 'Smart Split — Claude is reading your story…' : 'Building your storyboard…', !!apiKey);

  let rawBeats = [];    // array of strings or structured objects from smartSplit
  let isStructured = false;

  if (apiKey) {
    advanceSBLoadStep('split');
    rawBeats = await smartSplit(story, count, apiKey, charNames, locName);
    if (!rawBeats) {
      const reason = _lastSmartSplitError ? ` (${_lastSmartSplitError})` : '';
      showToast('Smart Split failed' + reason + ' — using offline split', 'warning');
      rawBeats = offlineSplit(story, count, charNames, locName);
    } else {
      isStructured = rawBeats.length > 0 && typeof rawBeats[0] === 'object';
    }
  } else {
    await new Promise(r => setTimeout(r, 200));
    advanceSBLoadStep('model');
    rawBeats = offlineSplit(story, count, charNames, locName);
  }

  // Honest panel count — if offline splitter returned fewer than requested,
  // adjust count rather than padding with nonsense
  const actualCount = rawBeats.length;
  if (actualCount < count && !isStructured) {
    const hint = document.getElementById('sb-generate-hint');
    if (hint) {
      hint.textContent = `Your story supports ${actualCount} panels — adjusted from ${count}.`;
      hint.style.color = 'var(--amber)';
    }
  }

  const stylePrefs = { style: sbState.style, colour: sbState.colour, camera: sbState.camera };
  let masterValues = null;
  let prevShotType = null;

  // Build event classifications for all beats using scene model
  const allBeatTexts = rawBeats.map(r => isStructured ? r.beat : r);
  const beatEvents = [];
  allBeatTexts.forEach((beatText, i) => {
    const prevSubject = i > 0 ? beatEvents[i - 1]?.subject : null;
    if (isStructured && rawBeats[i]?.shotType) {
      beatEvents.push({
        sentence: beatText,
        type: classifyEvent(beatText, i, allBeatTexts),
        subject: detectSubject(beatText, sceneModel.characters, classifyEvent(beatText, i, allBeatTexts), prevSubject),
        idx: i
      });
    } else {
      const fromModel = sceneModel.events[i];
      if (fromModel) {
        // Re-run subject detection with prevSubject for pronoun resolution
        beatEvents.push({
          ...fromModel,
          subject: detectSubject(fromModel.sentence, sceneModel.characters, fromModel.type, prevSubject)
        });
      } else {
        const type = classifyEvent(beatText, i, allBeatTexts);
        beatEvents.push({
          sentence: beatText,
          type,
          subject: detectSubject(beatText, sceneModel.characters, type, prevSubject),
          idx: i
        });
      }
    }
  });

  advanceSBLoadStep('compose');
  await new Promise(r => setTimeout(r, 80)); // let UI paint

  sbState.panels = rawBeats.map((raw, i) => {
    const beat  = isStructured ? raw.beat : raw;
    const event = beatEvents[i];
    const vehicleBeatsSoFar = countVehicleBeats(beatEvents, i);

    // Shot type: API path uses Claude's assignment, offline uses scene model
    const shotType = isStructured && raw.shotType
      ? raw.shotType
      : shotTypeFromModel(event, i, actualCount, prevShotType, sceneModel);

    const angle = assignAngle(shotType, i);

    // Composition from scene model — all spatial facts, positive statements
    const composition = compositionFromModel(shotType, event, sceneModel, vehicleBeatsSoFar);

    const panel = {
      beat, shotType, angle, composition,
      isInsert: isStructured ? (raw.isInsert || false) : false,
      subject:  event.subject?.name || '',
      prompt: '', cameraNote: ''
    };

    if (i === 0) masterValues = extractMasterValues(panel, mentions);
    panel.masterValues = masterValues;

    // Task #11 fix: buildPanelPrompt() gets THIS panel's own beat mentions,
    // not the whole-story `mentions` used above for scene-model building
    // (charNames/locName extraction, masterValues) — those whole-story uses
    // are legitimate since they inform shared context before beats exist
    // standalone, but the actual per-panel prompt should only include
    // assets that panel's own beat actually names.
    const panelMentions = parseAtMentions(beat || '');
    panel.prompt     = deSlop(buildPanelPrompt(panel, i, actualCount, panelMentions, stylePrefs));
    panel.cameraNote = buildCameraNote(panel, i, actualCount);
    prevShotType     = shotType;
    return panel;
  });

  // Fresh, unsaved storyboard content now sits only in memory — see
  // sbState.dirty comment (03-storyboard.js) and development-practices.md §5.
  sbState.dirty = true;

  advanceSBLoadStep('prompts');
  await new Promise(r => setTimeout(r, 120)); // brief pause so user sees final step
  renderPanels();

  // Auto-open the reference-image panel (task #2) — shows which character/
  // asset image should be attached per shot, independent of the prompt text.
  if (typeof openReferencePanel === 'function') openReferencePanel();
}

/* ── SMART SPLIT (API) — STRUCTURED OUTPUT ───────────────── */
async function smartSplit(story, count, apiKey, charNames, locName) {
  try {
    const charContext = charNames && charNames.length
      ? `Characters in this story: ${charNames.join(', ')}.`
      : '';
    const locContext = locName ? `Primary location: ${locName}.` : '';

    const systemPrompt = `You are a professional storyboard director. Your job is to break a story into exactly ${count} cinematic panel beats — each one the first frame of a shot.

${charContext}
${locContext}

RULES you must follow precisely:

SHOT TYPE RULES (from cinematic grammar):
- Panel 1 and Panel ${count} are bookends, not forced framings: default to "Establishing Shot" (panel 1) / "Closing Shot" (panel ${count}) — wide, environment dominant, figures small — ONLY if the story's actual opening/closing content is itself wide or scene-setting. If the opening or closing beat is inherently close (e.g. two characters already mid-conversation, a reaction, a tight emotional moment), use the shot type that content actually calls for (Close-up, Medium Shot, etc.) instead — do not force a wide shot onto close content just because it's the first or last panel.
- Vehicle/threat in motion: "Wide Shot" — vehicle is the subject, characters secondary
- Emotional reaction (shocked, frightened, notices, glances): "Close-up" — one face only, clean single
- Action directed at a character: "Medium Shot" — actor sharp, target soft at frame edge
- Prop or object detail: "ECU" — object fills frame, no character
- Two characters interacting, both visible/facing camera: "Medium Shot" — dominant sharp, secondary soft at edge
- Two characters in dialogue where one is the camera's foreground anchor (their shoulder/back of head frames the edge of shot, the other character sharp beyond them) — or whenever the story explicitly says "OS", "over the shoulder", or "over his/her shoulder": "OS" — this is a distinct shot type from Medium Shot, not a substitute for it. If the story's wording doesn't clearly call for it, prefer Medium Shot for level two-character dialogue and reserve OS for shots with genuine foreground/background depth between the two characters.
- Crowd or group: "Wide Shot"
- Never repeat the same shot type consecutively

EXPANSION RULES:
If the story has fewer natural beats than ${count} panels, infer cinematically valid intermediate shots that serve the story logic. Do NOT pad with repeated establishing shots or generic "the scene continues" beats.

Good intermediates for action/threat stories:
- Before a vehicle arrives: low angle road surface, vehicle approaching in distance
- After a character hears a sound: ECU of what they are doing (headphones, hands, prop) — explains the delayed reaction  
- Before a reaction close-up: the object or threat they are reacting to
- Between two reactions: spatial wide showing both characters and the threat simultaneously

SUBJECT RULE:
The "subject" field must name what the camera is primarily framing — a character name, "car", "newspaper", "road", etc.

@MENTION RULE (important):
The source story may tag characters or locations with an "@" prefix (e.g. "@Changdev", "@Sahyadri Mountains"). Whenever a beat you write refers to one of these tagged characters or locations, keep the "@" prefix on that name in the "beat" text, written exactly as it appeared in the story (e.g. write "@Changdev steps down from the tiger", not "Changdev steps down from the tiger"). This lets the app match each shot back to its reference images — do not drop the "@", and do not add "@" to names that were not tagged in the original story.

Return ONLY a valid JSON array of exactly ${count} objects. No markdown, no preamble, no explanation.

Format:
[
  {
    "beat": "One clear sentence describing exactly what the camera sees in this frame.",
    "shotType": "Establishing Shot|Wide Shot|Medium Shot|OS|Close-up|ECU|Closing Shot",
    "subject": "primary subject of this frame",
    "isInsert": false
  }
]

isInsert is true only for frames you invented as cinematically valid intermediates (not directly stated in the story).`;

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'anthropic-dangerous-direct-browser-access': 'true'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 2000,
        system: systemPrompt,
        messages: [{ role: 'user', content: `Story:\n${story}` }]
      })
    });

    if (!response.ok) {
      // Surface the real reason instead of a generic failure — debugging fix
      // 2026-06-25: user reported "Smart Split failed" with no way to tell
      // whether it was a bad key, rate limit, or something else. Try to read
      // the API's own error body (Anthropic returns {"error":{"type":...,
      // "message":...}}) since the status code alone often isn't enough
      // (e.g. 401 could be a malformed key OR a revoked one).
      let detail = `HTTP ${response.status}`;
      try {
        const errBody = await response.json();
        if (errBody?.error?.message) detail = `${response.status} — ${errBody.error.message}`;
        else if (errBody?.error?.type) detail = `${response.status} — ${errBody.error.type}`;
      } catch (_) { /* body wasn't JSON — keep the plain status */ }
      _lastSmartSplitError = detail;
      console.warn('Smart Split API error:', detail);
      return null;
    }

    const data = await response.json();
    const text = data.content?.map(c => c.text || '').join('') || '';
    const clean = text.replace(/```json|```/g, '').trim();
    const parsed = JSON.parse(clean);

    if (!Array.isArray(parsed)) {
      _lastSmartSplitError = 'Response was not a JSON array';
      return null;
    }

    // Validate structure — each item must have beat and shotType
    const valid = parsed.filter(p => p && typeof p.beat === 'string' && p.beat.trim());
    if (valid.length === 0) {
      _lastSmartSplitError = 'No valid panel objects in response';
      return null;
    }

    // Return structured panels — generateStoryboard will use shotType directly
    return valid;

  } catch (e) {
    // Network-level failures (CORS block, DNS, offline, etc.) land here —
    // these never reach the response.ok check above at all.
    _lastSmartSplitError = e?.message || String(e);
    console.warn('Smart Split error:', e);
    return null;
  }
}

/* ── SHOW LOADING ────────────────────────────────────────── */
function showSBLoading(msg, useApi) {
  document.getElementById('sb-step1').style.display = 'none';
  document.getElementById('sb-step2').style.display = '';

  const steps = useApi
    ? [
        { key: 'read',    label: 'Reading your story' },
        { key: 'split',   label: 'Director assigning shots' },
        { key: 'compose', label: 'Building compositions' },
        { key: 'prompts', label: 'Writing panel prompts' }
      ]
    : [
        { key: 'split',   label: 'Splitting story into beats' },
        { key: 'model',   label: 'Building scene model' },
        { key: 'compose', label: 'Inferring compositions' },
        { key: 'prompts', label: 'Writing panel prompts' }
      ];

  const stepsHTML = steps.map((s, i) =>
    `<div class="sb-loading-step${i === 0 ? ' active' : ''}" id="sb-load-step-${s.key}">${escHtml(s.label)}</div>`
  ).join('');

  document.getElementById('sb-panels-grid').innerHTML = `
    <div class="sb-loading" style="grid-column:1/-1" id="sb-loading-block">
      <div class="sb-spinner"></div>
      <div class="sb-loading-label">${escHtml(msg)}</div>
      <div class="sb-loading-steps">${stepsHTML}</div>
    </div>`;
}

function advanceSBLoadStep(key) {
  document.querySelectorAll('.sb-loading-step').forEach(el => {
    if (el.classList.contains('active')) {
      el.classList.remove('active');
      el.classList.add('done');
    }
  });
  const next = document.getElementById('sb-load-step-' + key);
  if (next) next.classList.add('active');
}

/* ── RENDER PANELS ───────────────────────────────────────── */
/* ── LOCATION DESIGNER — PER-PANEL "CAMERA FACES" DROPDOWN ──────────────
   Design spec: 2026-06-28-location-designer-spec.md. Separate from the
   existing shot-scale/angle picker (push-in, eye-level, etc.) — camera
   movement/scale and spatial facing are two different concerns, and
   conflating them was the original source of confusion this spec solves.
   Optional; if unset, behaviour is unchanged from today (no direction
   text added to the prompt) — same "default behaviour unchanged" rule
   every other optional Location Designer piece follows.

   Auto-appears when this panel's beat/composition mentions a location
   that has directions defined — reuses the existing mention-detection
   system (parseAtMentions/parsePlainTextMentions, 04-mentions.js), no
   new detection logic, per the spec. What does NOT get auto-detected is
   WHICH direction the camera faces — that stays a manual per-panel
   choice (spec: inferring it from beat phrasing like "facing the road"
   would need new spatial-language parsing, explicitly out of scope).

   v1 scope note: only the FIRST mentioned location with directions gets
   a dropdown, matching the spec's singular "New, explicit dropdown on
   the panel" wording. A panel mentioning two different directional
   locations at once is an edge case the spec doesn't address either. */
function cameraFacingWrapHTML(index) {
  return `<div id="sb-camera-facing-wrap-${index}">${cameraFacingInnerHTML(index)}</div>`;
}

function cameraFacingInnerHTML(index) {
  const panel = sbState.panels[index];
  if (!panel) return '';

  // Fable review 2026-07-04: this used to scan beat + composition, plus
  // both @-mentions and plain-text mentions, to decide whether to show the
  // dropdown. But buildPanelPrompt() (and directionNote() inside it) only
  // ever consumes parseAtMentions(panel.beat || '') — see the panelMentions
  // callers throughout this file. The wider scan here let the dropdown
  // appear (or a direction get selected) for a location that buildPanelPrompt
  // would never actually see, most visibly for Smart Split storyboards
  // (which don't produce @-tagged beats at all in composition) — the
  // dropdown could show but the selected direction would silently never
  // reach the prompt. Narrowed to match exactly what the prompt builder
  // consumes, so "dropdown appears" <=> "direction clause can appear".
  const atMentions = parseAtMentions(panel.beat || '');
  const locMention = atMentions
    .find(m => m.asset.type === 'location' && Array.isArray(m.asset.directions) && m.asset.directions.length > 0);

  if (!locMention) return '';
  const asset = locMention.asset;
  const current = panel.cameraFacingDirection || '';
  const options = asset.directions.map(d =>
    `<option value="${escHtml(d.name)}" ${current === d.name ? 'selected' : ''}>${escHtml(d.name)}</option>`
  ).join('');

  // Shot Setup entry point (phase 3, 2026-07-06) — only offered when
  // openShotSetupForPanel() actually exists (14-shot-setup.js loaded).
  // Opens/reuses a shot setup for this same location and, once inside,
  // picking or adding a shot drives THIS dropdown's selection instead of
  // the user picking it blind — spec's "Output per panel" item 1.
  const shotSetupBtn = typeof openShotSetupForPanel === 'function'
    ? `<button type="button" class="btn btn-secondary btn-sm" style="margin-top:6px;"
        onclick="openShotSetupForPanel(${index}, '${escHtml(asset.id)}')"
        title="Open the visual ring/camera diagram for this location">📐 Shot Setup</button>`
    : '';

  return `
    <div class="sb-camera-facing">
      <div class="sb-panel-section-label">Camera faces (${escHtml(asset.name)})</div>
      <select class="input" onchange="setCameraFacingDirection(${index}, this.value)">
        <option value="">— not set —</option>
        ${options}
      </select>
      <span class="field-hint">Text-guidance only — restates what's in this direction for cross-panel consistency, doesn't give the generator real memory of the location.</span>
      ${shotSetupBtn}
    </div>`;
}

function refreshCameraFacingDropdown(index) {
  const el = document.getElementById('sb-camera-facing-wrap-' + index);
  if (el) el.innerHTML = cameraFacingInnerHTML(index);
}

function setCameraFacingDirection(index, value) {
  const panel = sbState.panels[index];
  if (!panel) return;
  panel.cameraFacingDirection = value || null;
  sbState.dirty = true;

  // Rebuild this panel's prompt immediately so the direction text is
  // reflected without needing a full Regen — same immediacy as
  // setPerspectiveAnchor() (11-reference-panel.js).
  const mentions = parseAtMentions(panel.beat || '');
  const stylePrefs = { style: sbState.style, colour: sbState.colour, camera: sbState.camera };
  panel.prompt = deSlop(buildPanelPrompt(panel, index, sbState.panels.length, mentions, stylePrefs));
  const promptEl = document.getElementById('sb-prompt-' + index);
  if (promptEl) promptEl.textContent = panel.prompt;

  // Bug found live 2026-07-06: this function was previously only ever
  // called by the "Camera faces" <select>'s own onchange, where the
  // browser already shows the new selection natively — so nothing here
  // refreshed the dropdown's rendered HTML. Shot Setup (14-shot-setup.js's
  // shotSetupSyncCameraFacingToPanel()) now calls this programmatically
  // from a ring-position click, with no native <select> interaction to
  // rely on — the underlying panel.cameraFacingDirection was set correctly
  // (confirmed: the generated prompt picked it up), but the dropdown
  // behind the modal kept showing stale "— not set —" until now. Same
  // class of gap as the v7.12.1 onCompositionEdit() fix — a handler that
  // changes cameraFacingDirection needs to refresh the dropdown itself,
  // not assume the DOM is already right.
  if (typeof refreshCameraFacingDropdown === 'function') refreshCameraFacingDropdown(index);

  // Removed 2026-07-08 (testing-checklist.md §6 root cause): this called the
  // BLANKET saveState() (00-api.js) — which re-serializes and re-uploads
  // EVERY asset in EVERY project, sequentially — on every single direction
  // pick, including every Shot Setup ring-click (setCameraFacingDirection is
  // its sync target too). It never actually persisted anything relevant:
  // panel.cameraFacingDirection lives only in sbState.panels, which
  // saveState() doesn't touch (Storyboard state isn't server-persisted at
  // all — see development-practices.md §5). So this was a pure-overhead call
  // that, during a testing session with many rapid direction picks, queued a
  // long backlog of heavy synchronous JSON.stringify + sequential fetches
  // (image-heavy assets) on _saveStateChain. That backlog is what froze the
  // Library asset-edit modal minutes later — the main thread was still
  // churning through it, not literally deadlocked, which is why scrolling
  // still worked, no console errors appeared while it was happening, and it
  // eventually "resolved on its own" once the chain drained (or hit a real
  // network hiccup on one asset, surfacing as an unrelated-looking
  // "save_asset failed" error right as things unfroze).
}

function renderPanels() {
  const grid = document.getElementById('sb-panels-grid');
  const title = document.getElementById('sb-panels-title');
  const badge = document.getElementById('sb-panels-platform-badge');

  if (title) title.textContent = `Storyboard — ${sbState.panels.length} Panels`;
  if (badge) badge.textContent = PLATFORM_TIPS[sbState.platform]?.badge || sbState.platform;

  document.getElementById('sb-step1').style.display = 'none';
  document.getElementById('sb-step2').style.display = '';

  if (!grid) return;

  grid.innerHTML = sbState.panels.map((panel, i) => `
    <div class="sb-panel-card" id="sb-panel-${i}">
      <div class="sb-panel-header">
        <span class="sb-panel-num">Panel ${i + 1}</span>
        ${shotBadgeHTML(panel.shotType)}
        ${panel.isInsert ? '<span style="font-size:0.6rem;font-weight:700;letter-spacing:0.06em;text-transform:uppercase;color:var(--amber);background:var(--amber-bg);border:1px solid var(--amber);border-radius:3px;padding:1px 6px;margin-left:4px;">Director insert</span>' : ''}
      </div>
      <div class="sb-panel-body">
        <div>
          <div class="sb-panel-section-label">Scene Beat <span style="font-weight:400;font-style:italic">(editable — type @ to link assets)</span></div>
          <div style="position:relative">
            <textarea class="sb-panel-beat" id="sb-beat-${i}" rows="2"
              oninput="onBeatInput(event,${i})"
              onkeydown="onBeatKeydown(event,${i})"
            >${escHtml(panel.beat)}</textarea>
            <div class="sb-at-picker" id="beat-at-picker-${i}" style="display:none">
              <div class="sb-at-picker-list" id="beat-at-list-${i}"></div>
            </div>
          </div>
        </div>
        <div class="sb-composition-block">
          <div class="sb-composition-label">📐 Composition <span>app inferred this — edit if needed</span> <button type="button" class="sf-vocab-add-btn" title="Describe pose in detail" onclick="openPoseHelperModal({mode:'sb',panelIndex:${i}})">🧍 Pose</button></div>
          <textarea class="sb-composition-textarea" id="sb-composition-${i}" rows="3"
            oninput="onCompositionEdit(${i})"
          >${escHtml(panel.composition || '')}</textarea>
        </div>
        ${cameraFacingWrapHTML(i)}
        <div>
          <div class="sb-panel-section-label">Generated Prompt</div>
          <div class="sb-panel-prompt" id="sb-prompt-${i}">${escHtml(panel.prompt)}</div>
        </div>
        <div>
          <div class="sb-panel-section-label">Camera</div>
          <div style="font-size:0.68rem;color:var(--ink-lt);font-style:italic;">${escHtml(panel.cameraNote)}</div>
        </div>
        ${typeof inlineReferenceStripHTML === 'function' ? inlineReferenceStripHTML(i) : ''}
      </div>
      <div class="sb-panel-footer">
        <button class="btn btn-secondary btn-sm sb-regen-btn" onclick="regenPanelPrompt(${i})" title="Beat wording changed — rebuild this panel's prompt and cascade continuity to later panels">↺ Regen</button>
        <button class="btn btn-secondary btn-sm sb-regen-btn" onclick="refreshPanelMentions(${i})" title="Only added/removed @ on a name already in the text — relink this panel's references, no cascade">@ Refresh</button>
        <button class="btn btn-primary btn-sm sb-regen-btn" onclick="copyPanelPrompt(${i})">Copy</button>
      </div>
    </div>
  `).join('');
  // Fable audit H4 (2026-07-08): each panel's inline reference strip
  // (inlineReferenceStripHTML(i), 11-reference-panel.js) now defers its
  // image href/src to data-src-pending markers instead of embedding full
  // base64 in this grid's HTML string — this is the highest-traffic H4
  // location, since it runs for EVERY panel on every full Storyboard
  // render, not just on a modal open. One flush call here hydrates every
  // panel's queued images at once, right after the whole grid actually
  // exists in the DOM.
  if (typeof flushImageHydration === 'function') flushImageHydration();
}

/* ── SHOT BADGE WITH SVG DIAGRAM ─────────────────────────── */
function shotBadgeHTML(shotType) {
  const typeMap = {
    'Establishing Shot': { cls: 'sb-shot-establishing', svg: shotSVG('establishing') },
    'Wide Shot':         { cls: 'sb-shot-wide',         svg: shotSVG('wide') },
    'Medium Shot':       { cls: 'sb-shot-medium',       svg: shotSVG('medium') },
    'OS':                { cls: 'sb-shot-os',           svg: shotSVG('os') },
    'Close-up':          { cls: 'sb-shot-closeup',      svg: shotSVG('closeup') },
    'Closing Shot':      { cls: 'sb-shot-closing',      svg: shotSVG('closing') },
  };
  const t = typeMap[shotType] || { cls: 'sb-shot-default', svg: shotSVG('medium') };
  return `<span class="sb-panel-shot-badge ${t.cls}">${t.svg}${escHtml(shotType)}</span>`;
}

function shotSVG(type) {
  // Tiny inline SVG — rectangle frame with figure silhouette indicating shot framing
  const w = 18, h = 13;
  const col = 'currentColor';
  let figure = '';

  if (type === 'establishing' || type === 'wide') {
    // Small figure far away, wide scene
    figure = `<rect x="7" y="5" width="4" height="5" rx="0.5" fill="${col}" opacity="0.5"/>
              <circle cx="9" cy="4" r="1.2" fill="${col}" opacity="0.5"/>
              <line x1="2" y1="10" x2="16" y2="10" stroke="${col}" stroke-width="0.8" opacity="0.3"/>`;
  } else if (type === 'medium') {
    // Figure from waist up
    figure = `<rect x="6" y="6" width="6" height="5" rx="0.5" fill="${col}" opacity="0.5"/>
              <circle cx="9" cy="4.5" r="1.5" fill="${col}" opacity="0.5"/>`;
  } else if (type === 'os') {
    // Dark foreground shoulder/back-of-head wedge at lower-left edge,
    // sharp figure beyond it at centre-right — visually distinct from
    // 'medium' (single centred figure, no foreground silhouette).
    figure = `<path d="M0.5 13 L0.5 7 Q3 6.5 4.5 8.5 L4 13 Z" fill="${col}" opacity="0.7"/>
              <rect x="10" y="5.5" width="5" height="6" rx="0.5" fill="${col}" opacity="0.5"/>
              <circle cx="12.5" cy="4.3" r="1.3" fill="${col}" opacity="0.5"/>`;
  } else if (type === 'closeup') {
    // Large face filling frame
    figure = `<ellipse cx="9" cy="7" rx="4" ry="4.5" fill="${col}" opacity="0.5"/>
              <ellipse cx="7.5" cy="6" rx="0.8" ry="0.6" fill="var(--white)" opacity="0.8"/>
              <ellipse cx="10.5" cy="6" rx="0.8" ry="0.6" fill="var(--white)" opacity="0.8"/>`;
  } else if (type === 'closing') {
    // Silhouette walking away
    figure = `<rect x="7.5" y="5" width="3" height="5" rx="0.5" fill="${col}" opacity="0.4"/>
              <circle cx="9" cy="4" r="1.2" fill="${col}" opacity="0.4"/>
              <line x1="2" y1="11" x2="16" y2="11" stroke="${col}" stroke-width="0.8" opacity="0.25"/>`;
  }

  return `<svg class="sb-shot-diagram" viewBox="0 0 ${w} ${h}" xmlns="http://www.w3.org/2000/svg">
    <rect x="0.5" y="0.5" width="${w-1}" height="${h-1}" rx="1" fill="none" stroke="${col}" stroke-width="0.8" opacity="0.4"/>
    ${figure}
  </svg>`;
}

/* ── COMPOSITION EDIT HANDLER ────────────────────────────── */
// Debounce timers, one per panel index — a single shared timer would let
// editing panel 2 cancel panel 1's still-pending update if you switch
// panels quickly. Bug found 2026-07-03 via the Fable architecture audit
// (Area 4): this handler ran the full mentions-parse + buildPanelPrompt()
// + deSlop() pipeline synchronously on EVERY keystroke with no debounce —
// the exact same bug class fixed in Single Frame's sfBindTextInputs()
// (v7.9.10), never ported here. Panel state (composition text, userEdited
// flag) still updates immediately so nothing is lost; only the expensive
// prompt-rebuild + DOM text update is deferred.
let _sbCompositionEditTimers = {};
const SB_COMPOSITION_DEBOUNCE_MS = 250;

function onCompositionEdit(index) {
  const ta = document.getElementById('sb-composition-' + index);
  if (!ta || !sbState.panels[index]) return;
  // Mark as user-edited so regenPanelPrompt won't re-infer and overwrite it
  ta.dataset.userEdited = 'true';
  // Save user's edit to panel state — this overrides future inference for this panel
  sbState.panels[index].composition = ta.value;
  sbState.dirty = true;

  clearTimeout(_sbCompositionEditTimers[index]);
  _sbCompositionEditTimers[index] = setTimeout(() => {
    // Auto-update the prompt live as user edits composition.
    // Task #11 fix: derive mentions from THIS panel's own beat text, not the
    // whole story — this only ever touches one panel (index), so whole-story
    // mentions could pull in @-tagged assets that aren't even mentioned in
    // this panel's beat, bloating the prompt with irrelevant asset descriptions.
    const mentions = parseAtMentions(sbState.panels[index].beat || '');
    const stylePrefs = { style: sbState.style, colour: sbState.colour, camera: sbState.camera };
    sbState.panels[index].prompt = deSlop(buildPanelPrompt(sbState.panels[index], index, sbState.panels.length, mentions, stylePrefs));
    const promptEl = document.getElementById('sb-prompt-' + index);
    if (promptEl) promptEl.textContent = sbState.panels[index].prompt;
    // Fable fix (2026-07-04): this handler never refreshed the "Camera
    // faces" dropdown, so a composition edit that added/removed a location
    // @-mention in the BEAT-derived mentions (e.g. via a cascade or manual
    // beat+composition edit sequence) could leave a stale/missing dropdown
    // until the next full regen. onBeatEdit() and regenPanelPrompt() already
    // call this; onCompositionEdit() was the one gap.
    if (typeof refreshCameraFacingDropdown === 'function') refreshCameraFacingDropdown(index);
  }, SB_COMPOSITION_DEBOUNCE_MS);
}

/* ── REGEN SINGLE PANEL ──────────────────────────────────── */
/* ── UNDO SNAPSHOT ───────────────────────────────────────── */
let sbUndoSnapshot = null;   // deep copy of panels before last cascade
let sbUndoTimer = null;

function snapshotForUndo() {
  sbUndoSnapshot = sbState.panels.map(p => ({ ...p }));
}

function showUndoBar(editedIndex, affectedCount) {
  const bar = document.getElementById('sb-undo-bar');
  const msg = document.getElementById('sb-undo-msg');
  if (!bar || !msg) return;
  msg.innerHTML = `Panel ${editedIndex + 1} edited — prompts updated for <strong>${affectedCount} panel${affectedCount !== 1 ? 's' : ''}</strong> after it.`;
  bar.style.display = '';
  // Auto-hide after 30s
  clearTimeout(sbUndoTimer);
  sbUndoTimer = setTimeout(hideUndoBar, 30000);
}

function hideUndoBar() {
  const bar = document.getElementById('sb-undo-bar');
  if (bar) bar.style.display = 'none';
  sbUndoSnapshot = null;
}

function undoCascade() {
  if (!sbUndoSnapshot) return;
  sbState.panels = sbUndoSnapshot.map(p => ({ ...p }));
  sbUndoSnapshot = null;
  clearTimeout(sbUndoTimer);
  hideUndoBar();
  // Re-render all prompt and composition displays
  sbState.panels.forEach((panel, i) => {
    const promptEl = document.getElementById('sb-prompt-' + i);
    const beatEl = document.getElementById('sb-beat-' + i);
    const compEl = document.getElementById('sb-composition-' + i);
    if (promptEl) promptEl.textContent = panel.prompt;
    if (beatEl) beatEl.value = panel.beat;
    if (compEl) compEl.value = panel.composition || '';
    // Bug fix 2026-07-07: every other panel-rebuild path (onBeatEdit,
    // regenPanelPrompt, onCompositionEdit, setCameraFacingDirection)
    // already refreshes the "Camera faces" dropdown after touching a
    // panel — this restore loop never did, so undoing a cascade could
    // leave the dropdown showing a stale direction until something else
    // forced a rebuild. Same class of gap as the already-fixed
    // onCompositionEdit() bug (v7.12.1 fix #3).
    if (typeof refreshCameraFacingDropdown === 'function') refreshCameraFacingDropdown(i);
  });
  showToast('Cascade undone — panels restored', 'success');
}

/* ── REGEN PANEL WITH CASCADE ────────────────────────────── */
function regenPanelPrompt(index) {
  const beatEl = document.getElementById('sb-beat-' + index);
  if (!beatEl) return;
  if (!sbState.panels[index]) {
    showToast('Panel not found — try regenerating the storyboard', 'warning');
    return;
  }

  // Snapshot before any changes
  snapshotForUndo();

  const stylePrefs = { style: sbState.style, colour: sbState.colour, camera: sbState.camera };
  const total = sbState.panels.length;

  // Update the edited panel
  sbState.panels[index].beat = beatEl.value.trim() || sbState.panels[index].beat;
  sbState.dirty = true;

  // Task #11 fix: this used to be parseAtMentions(sbState.storyText) — whole
  // story — computed once and reused below both for the edited panel itself
  // AND for every cascaded panel after it. That meant every panel in a
  // cascade got identical mentions regardless of what each one's own beat
  // actually names, and any @-tagged asset anywhere in the story leaked into
  // every panel's prompt. `mentions` below is now derived from THIS panel's
  // own beat (read after the beat update above, so it reflects the edit),
  // and is only used for the edited panel; the cascade loop further down
  // derives its own per-panel mentions from each cascaded panel's beat
  // instead of reusing this variable.
  const mentions = parseAtMentions(sbState.panels[index].beat || '');

  // Read composition BEFORE assigning shotType — if the user has manually
  // written/edited composition text (e.g. "visible, small in frame"), that
  // explicit framing intent must be available to assignShotType() now, not
  // only after composition is (maybe) re-inferred below. Without this, the
  // classifier was guessing shot size from beat verbs alone and ignoring
  // framing language already sitting in the composition field (bug found
  // in testing — "shake his hands" + composition "small in frame" still
  // classified as a tight shot because composition was never read).
  const compElForShot = document.getElementById('sb-composition-' + index);
  const compositionForShotType = compElForShot ? compElForShot.value : sbState.panels[index].composition;

  sbState.panels[index].shotType = assignShotType(index, total, sbState.panels[index].beat, null, compositionForShotType);
  sbState.panels[index].angle = assignAngle(sbState.panels[index].shotType, index);

  // Re-infer composition only if user hasn't manually edited the composition textarea
  const compEl = document.getElementById('sb-composition-' + index);
  const userEditedComposition = compEl && compEl.dataset.userEdited === 'true';
  if (!userEditedComposition) {
    const chars  = mentions.filter(m => m.asset.type === 'character');
    const locs   = mentions.filter(m => m.asset.type === 'location');
    const props  = mentions.filter(m => m.asset.type === 'prop');
    sbState.panels[index].composition = inferComposition(
      sbState.panels[index].shotType, chars, locs, props, index, total,
      sbState.panels[index].beat
    );
    if (compEl) compEl.value = sbState.panels[index].composition;
  }

  // Bug fix 2026-07-07: every other prompt-rebuild path (setCameraFacingDirection(),
  // copyPanelPrompt()) wraps buildPanelPrompt()'s output in deSlop() before
  // display/save; this path assigned the raw output, so output could
  // differ depending on which control the user clicked. Wrapped here and
  // in the cascade loop + refreshPanelMentions() below for consistency.
  sbState.panels[index].prompt = deSlop(buildPanelPrompt(sbState.panels[index], index, total, mentions, stylePrefs));
  sbState.panels[index].cameraNote = buildCameraNote(sbState.panels[index], index, total);

  // Update DOM for edited panel
  const promptEl = document.getElementById('sb-prompt-' + index);
  if (promptEl) promptEl.textContent = sbState.panels[index].prompt;

  // Refresh this panel's inline reference-image strip too — its @ mentions
  // may have changed with the beat edit, and regenPanelPrompt() otherwise
  // never touches that part of the DOM (task #13 fix).
  if (typeof refreshInlineReferenceStrip === 'function') refreshInlineReferenceStrip(index);
  if (typeof refreshCameraFacingDropdown === 'function') refreshCameraFacingDropdown(index);

  // CASCADE: update prompts for all panels after index
  const cascadeCount = total - index - 1;
  if (cascadeCount > 0) {
    for (let i = index + 1; i < total; i++) {
      // Rebuild prompt with continuity note referencing edited panel.
      // Task #11 fix: each cascaded panel gets ITS OWN mentions, derived
      // from its own beat — not the edited panel's `mentions` from above.
      // Continuity (continuityRef) is the correct mechanism for carrying
      // forward context from the edited panel; reusing its @-mentions for
      // every later panel was the bug — panel i should only see assets it
      // actually names in its own beat.
      sbState.panels[i].continuityRef = sbState.panels[index].beat;
      const cascadeMentions = parseAtMentions(sbState.panels[i].beat || '');
      sbState.panels[i].prompt = deSlop(buildPanelPrompt(sbState.panels[i], i, total, cascadeMentions, stylePrefs));
      const el = document.getElementById('sb-prompt-' + i);
      if (el) {
        el.textContent = sbState.panels[i].prompt;
        // Brief visual flash to show which panels updated
        el.style.background = 'var(--amber-bg)';
        setTimeout(() => { el.style.background = ''; }, 800);
      }
    }
    showUndoBar(index, cascadeCount);
    showToast(`Panel ${index + 1} updated — ${cascadeCount} panel${cascadeCount !== 1 ? 's' : ''} cascaded`, 'success');
  } else {
    hideUndoBar();
    showToast('Panel ' + (index + 1) + ' updated', 'success');
  }
}

/* ── REFRESH @ LINKS — LOCAL, NO CASCADE (task #15) ─────────────
   Use when the beat's WORDING hasn't changed but its @-tagging has
   (e.g. user added "@" in front of a character name that was already
   there as plain text). Unlike regenPanelPrompt(), this does NOT
   cascade to later panels — nothing about this panel's narrative
   content changed for them to react to, so their continuityRef and
   prompts are left untouched.

   Also fixes task #11 for this path specifically: mentions here are
   derived from parseAtMentions(panel.beat) — this panel's own beat
   text only — not the whole-story mentions array that
   regenPanelPrompt() still uses (that's the open #11 bug; it stays
   in regenPanelPrompt() too, just not duplicated here). */
function refreshPanelMentions(index) {
  const panel = sbState.panels[index];
  if (!panel) return;

  const beatEl = document.getElementById('sb-beat-' + index);
  if (beatEl) panel.beat = beatEl.value.trim() || panel.beat;

  const panelMentions = parseAtMentions(panel.beat || '');
  const stylePrefs = { style: sbState.style, colour: sbState.colour, camera: sbState.camera };
  const total = sbState.panels.length;

  panel.prompt = deSlop(buildPanelPrompt(panel, index, total, panelMentions, stylePrefs));
  panel.cameraNote = buildCameraNote(panel, index, total);

  const promptEl = document.getElementById('sb-prompt-' + index);
  if (promptEl) promptEl.textContent = panel.prompt;

  if (typeof refreshInlineReferenceStrip === 'function') refreshInlineReferenceStrip(index);
  if (typeof refreshCameraFacingDropdown === 'function') refreshCameraFacingDropdown(index);

  showToast('Panel ' + (index + 1) + ' @ links refreshed (no cascade)', 'success');
}

/* ── COPY PANEL PROMPT ───────────────────────────────────── */
function copyPanelPrompt(index) {
  if (!sbState.panels[index]) return;
  // Sync composition from textarea
  const compEl = document.getElementById('sb-composition-' + index);
  if (compEl) sbState.panels[index].composition = compEl.value;
  // Rebuild fresh — task #11 fix: this panel's own beat, not whole-story text
  const mentions = parseAtMentions(sbState.panels[index].beat || '');
  const stylePrefs = { style: sbState.style, colour: sbState.colour, camera: sbState.camera };
  const fresh = deSlop(buildPanelPrompt(sbState.panels[index], index, sbState.panels.length, mentions, stylePrefs));
  sbState.panels[index].prompt = fresh;
  const promptEl = document.getElementById('sb-prompt-' + index);
  if (promptEl) promptEl.textContent = fresh;
  copyToClipboard(fresh, 'Panel ' + (index + 1) + ' copied');
}

/* ── SYNC ALL PANELS BEFORE COPY ─────────────────────────── */
function syncAndRebuildAllPanels() {
  const stylePrefs = { style: sbState.style, colour: sbState.colour, camera: sbState.camera };
  sbState.panels.forEach((panel, i) => {
    const compEl = document.getElementById('sb-composition-' + i);
    if (compEl) panel.composition = compEl.value;
    // Task #11 fix: mentions derived per-panel inside the loop, from each
    // panel's own beat — was previously computed once outside the loop from
    // sbState.storyText and reused for every panel, so all panels shared
    // identical (and often irrelevant) @-mentions regardless of what each
    // one's own beat actually names.
    const mentions = parseAtMentions(panel.beat || '');
    panel.prompt = deSlop(buildPanelPrompt(panel, i, sbState.panels.length, mentions, stylePrefs));
    const promptEl = document.getElementById('sb-prompt-' + i);
    if (promptEl) promptEl.textContent = panel.prompt;
  });
}

/* ── COPY ALL — INDIVIDUAL PROMPTS ───────────────────────── */
function copyAllIndividual() {
  if (!sbState.panels.length) return;
  syncAndRebuildAllPanels();
  const platform = PLATFORM_TIPS[sbState.platform]?.badge || sbState.platform;
  const ratio = sbState.aspectRatio;
  const header = `STORYBOARD — ${sbState.panels.length} PANELS\nPlatform: ${platform} | Aspect ratio: ${ratio} | Generate each panel as a separate image.\n\n`;
  const text = header + sbState.panels.map((p, i) =>
    `--- PANEL ${i + 1} of ${sbState.panels.length} [${p.shotType}] ---\n${p.prompt}`
  ).join('\n\n---\n\n');
  copyToClipboard(text, 'All ' + sbState.panels.length + ' prompts copied (individual)');
}

/* ── COPY ALL — GRID PROMPT ──────────────────────────────── */
function copyAsGrid() {
  if (!sbState.panels.length) return;
  syncAndRebuildAllPanels();
  const n = sbState.panels.length;
  const platform = PLATFORM_TIPS[sbState.platform]?.badge || sbState.platform;
  const ratio = sbState.aspectRatio;

  // Work out grid dimensions
  const gridDims = {
    3: '3×1', 4: '2×2', 6: '3×2', 8: '4×2', 12: '4×3'
  };
  const grid = gridDims[n] || `${n}×1`;
  const style = sbState.style || 'photorealistic cinematic';
  const colour = sbState.colour ? `, ${sbState.colour}` : '';

  const intro = [
    `Generate a storyboard image grid of ${n} panels arranged in a ${grid} layout.`,
    `Each cell is a single cinematic frame in ${ratio} aspect ratio.`,
    `Overall visual style: ${style}${colour}. Apply this style consistently to every panel.`,
    `Platform: ${platform}.`,
    `Number the panels 1 to ${n} in sequence, left to right, top to bottom.`,
    `Each panel description below is self-contained — generate exactly what is described, in the correct grid position.`,
    ``
  ].join('\n');

  const panels = sbState.panels.map((p, i) =>
    `PANEL ${i + 1} [${p.shotType}]:\n${p.prompt}`
  ).join('\n\n');

  copyToClipboard(intro + panels, `Grid prompt for ${n} panels copied`);
}

/* ── COPY ALL — KLING VIDEO 3.0 CUSTOM MULTI-SHOT ────────────
   Kling Video 3.0 generates an entire multi-shot sequence from ONE
   combined prompt — verified syntax from Kling's official guide:
   "Shot 1, Low-angle rear wide shot, tracking behind the rider... Shot 2,
   ...". This assembles every panel's terse kling-branch fragment (from
   buildPanelPrompt) into that exact numbered format, rather than the
   per-panel "Copy Individual"/"Copy as Grid" outputs nb/gpt use — those
   would be wrong for Kling Video since it isn't one-prompt-per-image.
   No documented hard cap on shot count; doc examples go up to 6 shots.
═══════════════════════════════════════════════════════════════════ */
function copyAsKlingMultiShot(silent) {
  if (!sbState.panels.length) return '';
  syncAndRebuildAllPanels();
  const n = sbState.panels.length;

  const shotLines = sbState.panels.map((p, i) => `Shot ${i + 1}, ${p.prompt}.`);
  const styleNote = [sbState.style, sbState.colour].filter(Boolean).join(', ');

  const text = [
    shotLines.join(' '),
    styleNote ? `Consistent visual style throughout: ${styleNote}.` : ''
  ].filter(Boolean).join(' ');

  if (!silent) copyToClipboard(text, `Kling Video multi-shot prompt copied (${n} shots)`);
  return text;
}

/* ── COPY ALL PROMPTS (legacy — kept for MD export) ──────── */
function copyAllPrompts() {
  copyAllIndividual();
}

/* ── SAVE .MD ────────────────────────────────────────────── */
function saveStoryboardMD() {
  if (!sbState.panels.length) return;
  syncAndRebuildAllPanels();
  const today = new Date().toISOString().slice(0, 10);
  const p = getCurrentProject();
  const projName = (p?.name || 'storyboard').replace(/[^a-z0-9]/gi, '-').toLowerCase();
  const filename = `${today}-${projName}-storyboard.md`;

  const lines = [
    `# Storyboard — ${p?.name || 'Untitled'}`,
    `**Date:** ${today}`,
    `**Platform:** ${PLATFORM_TIPS[sbState.platform]?.badge || sbState.platform}`,
    `**Panels:** ${sbState.panels.length}`,
    `**Aspect Ratio:** ${sbState.aspectRatio}`,
    `**Visual Style:** ${sbState.style || '—'}`,
    `**Colour Mood:** ${sbState.colour || '—'}`,
    '',
    '## Story',
    sbState.storyText,
    ''
  ];

  sbState.panels.forEach((panel, i) => {
    lines.push(`## Panel ${i + 1} — ${panel.shotType}`);
    lines.push(`**Beat:** ${panel.beat}`);
    lines.push(`**Camera:** ${panel.cameraNote}`);
    if (panel.composition) {
      lines.push(`**Composition:** ${panel.composition}`);
    }
    lines.push('');
    lines.push('**Prompt:**');
    lines.push('```');
    lines.push(panel.prompt);
    lines.push('```');
    lines.push('');
  });

  const blob = new Blob([lines.join('\n')], { type: 'text/markdown' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
  showToast('Saved: ' + filename, 'success');
}

/* ── RESET STORYBOARD ────────────────────────────────────── */
function resetStoryboard() {
  sbState.panels = [];
  sbState.dirty = false; // nothing left to lose
  document.getElementById('sb-step1').style.display = '';
  document.getElementById('sb-step2').style.display = 'none';
}

/* ── SAVE STORYBOARD TO SEQUENCE ─────────────────────────── */
function sbSaveToSequence() {
  if (!sbState.panels.length) {
    showToast('Generate a storyboard first', 'warning');
    return;
  }
  syncAndRebuildAllPanels();

  // Build a readable label from story text
  const storyPreview = (sbState.storyText || '').trim().substring(0, 60);
  const label = storyPreview || `Storyboard — ${sbState.panels.length} panels`;

  // Full snapshot of everything needed to restore
  const snapshot = {
    panelCount:     sbState.panelCount,
    platform:       sbState.platform,
    aspectRatio:    sbState.aspectRatio,
    selectedAssets: { ...sbState.selectedAssets },
    panels:         sbState.panels.map(p => ({ ...p })),
    storyText:      sbState.storyText,
    style:          sbState.style,
    colour:         sbState.colour,
    camera:         sbState.camera
  };

  // Build a preview string for the shot card (panel 1 prompt)
  const promptPreview = sbState.panels.map((p, i) =>
    `[${i + 1}] ${p.shotType}: ${p.prompt}`
  ).join('\n');

  openSaveToSequenceModal(promptPreview, {
    source: 'storyboard',
    sbSnapshot: snapshot,
    panelCount: sbState.panels.length,
    defaultLabel: label
  }, label);
}

/* ── HOOK: storyboard init is handled inside main switchView ── */

