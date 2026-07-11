/* ══════════════════════════════════════════════════════════════
   @ MENTION SYSTEM
══════════════════════════════════════════════════════════════ */

/* ── STATE ───────────────────────────────────────────────── */
let atPickerState = {
  active: false,
  startPos: 0,
  query: '',
  focusedIndex: 0,
  targetId: null   // which textarea is active
};

/* ── STORY INPUT HANDLER ─────────────────────────────────── */
function onSBStoryInput(e) {
  const ta = e.target;
  sbState.storyText = ta.value;
  handleAtMention(ta, 'sb-at-picker', 'sb-at-picker-list');
  analyseUnlinked(ta.value);
}

function onSBStoryKeydown(e) {
  if (!atPickerState.active) return;
  handleAtPickerKeydown(e, 'sb-story-text', 'sb-at-picker', 'sb-at-picker-list');
}

/* ── BEAT TEXTAREA HANDLERS ──────────────────────────────── */
function onBeatInput(e, index) {
  const pickerId = 'beat-at-picker-' + index;
  const listId = 'beat-at-list-' + index;
  handleAtMention(e.target, pickerId, listId);
}

function onBeatKeydown(e, index) {
  if (!atPickerState.active) return;
  const pickerId = 'beat-at-picker-' + index;
  const listId = 'beat-at-list-' + index;
  handleAtPickerKeydown(e, 'sb-beat-' + index, pickerId, listId);
}

/* ── CORE @ DETECTION ────────────────────────────────────── */
function handleAtMention(ta, pickerId, listId) {
  const val = ta.value;
  const pos = ta.selectionStart;

  // Find @ before cursor
  const textBeforeCursor = val.slice(0, pos);
  const atMatch = textBeforeCursor.match(/@(\w*)$/);

  if (!atMatch) {
    closeAtPicker(pickerId);
    return;
  }

  const query = atMatch[1].toLowerCase();
  atPickerState.active = true;
  atPickerState.startPos = textBeforeCursor.lastIndexOf('@');
  atPickerState.query = query;
  atPickerState.focusedIndex = 0;
  atPickerState.targetId = ta.id;

  renderAtPicker(query, pickerId, listId, ta);
}

/* ── RENDER @ PICKER ─────────────────────────────────────── */
function renderAtPicker(query, pickerId, listId, ta) {
  const p = getCurrentProject();
  const picker = document.getElementById(pickerId);
  const list = document.getElementById(listId);
  if (!picker || !list) return;

  // Effective assets = project characters + this project's linked shared
  // library assets. See getEffectiveAssets() in 01-core.js.
  const effectiveAssets = p ? getEffectiveAssets() : {};

  if (!p || Object.keys(effectiveAssets).length === 0) {
    list.innerHTML = '<div class="sb-at-empty">No library assets yet — add some in the Library tab.</div>';
    picker.style.display = '';
    return;
  }

  const assets = Object.values(effectiveAssets).filter(a =>
    !query || a.name.toLowerCase().startsWith(query) || a.name.toLowerCase().includes(query)
  );

  if (assets.length === 0) {
    list.innerHTML = `<div class="sb-at-empty">No match for "@${escHtml(query)}"</div>`;
    picker.style.display = '';
    return;
  }

  list.innerHTML = assets.map((a, i) => `
    <div class="sb-at-item${i === atPickerState.focusedIndex ? ' focused' : ''}"
      data-id="${a.id}" data-name="${escHtml(a.name)}"
      onmousedown="insertAtMention('${escHtml(a.name)}', '${a.id}', '${ta.id}', '${pickerId}')"
    >
      <span class="sb-at-item-icon">${TYPE_ICONS[a.type] || '◆'}</span>
      <span class="sb-at-item-name">${escHtml(a.name)}</span>
      <span class="sb-at-item-type">${TYPE_LABELS[a.type] || a.type}</span>
    </div>
  `).join('');

  picker.style.display = '';
}

/* ── @ MENTION TYPE TAGS ──────────────────────────────────────
   Single-letter disambiguator appended to a mention when inserted
   from the picker, e.g. "@Siblings(C)" vs "@Siblings(P)". Fixes a
   real name-collision bug found via testing 2026-06-29: a character
   asset and a prop asset both named "Siblings" both matched plain
   "@Siblings" text equally in parseAtMentions() (which never checked
   type), so picking the character from the dropdown still leaked the
   prop's full description into the prompt alongside it. The tag is
   visible (not a hidden ID) so the user can read which asset a
   mention resolves to directly in the textarea, and is stripped back
   out to plain "@Name" by resolveSFMentions() before reaching the
   final generated prompt. Hand-typed "@Name" with no tag still works
   exactly as before — parseAtMentions() falls back to name-only
   matching when no tag is present, so this is purely additive. */
const MENTION_TYPE_TAGS = { character: 'C', location: 'L', prop: 'P', era: 'E', style: 'S' };
const MENTION_TYPE_TAGS_REV = { C: 'character', L: 'location', P: 'prop', E: 'era', S: 'style' };

/* ── INSERT @ MENTION ────────────────────────────────────── */
function insertAtMention(name, assetId, textareaId, pickerId) {
  const ta = document.getElementById(textareaId);
  if (!ta) return;

  const val = ta.value;
  const atPos = atPickerState.startPos;
  const endPos = ta.selectionStart;

  // Tag with type letter only if another asset shares this exact name —
  // keeps the common case (no collision) exactly as clean as before this
  // fix, and only adds visible clutter when it's actually disambiguating
  // something.
  const p = getCurrentProject();
  const effectiveAssets = p ? getEffectiveAssets() : {};
  const asset = effectiveAssets[assetId];
  const collides = asset && Object.values(effectiveAssets).some(a =>
    a.id !== assetId && a.name.trim().toLowerCase() === name.trim().toLowerCase()
  );
  const insertedName = (collides && asset && MENTION_TYPE_TAGS[asset.type])
    ? name + '(' + MENTION_TYPE_TAGS[asset.type] + ')'
    : name;

  // Replace @query with @Name (or @Name(X) if disambiguating)
  ta.value = val.slice(0, atPos) + '@' + insertedName + ' ' + val.slice(endPos);

  // Move cursor after inserted mention
  const newPos = atPos + insertedName.length + 2;
  ta.setSelectionRange(newPos, newPos);
  ta.focus();

  closeAtPicker(pickerId);
  atPickerState.active = false;

  // Update state — picking from the dropdown sets ta.value directly, which
  // does NOT fire a native 'input' event, so the owning state object never
  // saw the change unless we sync it here. Previously this only updated
  // sbState.storyText, so Single Frame's subject/env fields kept their
  // stale pre-insert text until the user made a real edit (e.g. backspace),
  // which is why asset attributes only appeared after manually touching
  // the field.
  if (textareaId === 'sf-subject-text') {
    sfState.freeText.subject = ta.value;
    if (typeof updatePrompt === 'function') updatePrompt();
  } else if (textareaId === 'sf-env-text') {
    sfState.freeText.env = ta.value;
    if (typeof updatePrompt === 'function') updatePrompt();
  } else if (textareaId === 'sf-wardrobe-text') {
    sfState.freeText.wardrobe = ta.value;
    if (typeof updatePrompt === 'function') updatePrompt();
  } else if (textareaId === 'sb-story-text') {
    sbState.storyText = ta.value;
    analyseUnlinked(ta.value);
  } else if (textareaId.startsWith('sb-beat-')) {
    if (typeof onBeatInput === 'function') {
      // Reuse the existing beat-input pipeline so beat-specific state/prompt
      // updates happen exactly as they would on a real keystroke.
      onBeatInput({ target: ta }, parseInt(textareaId.replace('sb-beat-', ''), 10));
    }
  } else {
    // Fallback for any other @ mention field not explicitly handled above.
    sbState.storyText = ta.value;
  }
}

/* ── KEYBOARD NAVIGATION ─────────────────────────────────── */
function handleAtPickerKeydown(e, textareaId, pickerId, listId) {
  const list = document.getElementById(listId);
  if (!list) return;
  const items = list.querySelectorAll('.sb-at-item');
  if (!items.length) return;

  if (e.key === 'ArrowDown') {
    e.preventDefault();
    atPickerState.focusedIndex = Math.min(atPickerState.focusedIndex + 1, items.length - 1);
    updateAtPickerFocus(items);
  } else if (e.key === 'ArrowUp') {
    e.preventDefault();
    atPickerState.focusedIndex = Math.max(atPickerState.focusedIndex - 1, 0);
    updateAtPickerFocus(items);
  } else if (e.key === 'Enter' || e.key === 'Tab') {
    e.preventDefault();
    const focused = items[atPickerState.focusedIndex];
    if (focused) {
      insertAtMention(focused.dataset.name, focused.dataset.id, textareaId, pickerId);
    }
  } else if (e.key === 'Escape') {
    closeAtPicker(pickerId);
  }
}

function updateAtPickerFocus(items) {
  items.forEach((item, i) => {
    item.classList.toggle('focused', i === atPickerState.focusedIndex);
  });
}

function closeAtPicker(pickerId) {
  const picker = document.getElementById(pickerId);
  if (picker) picker.style.display = 'none';
  atPickerState.active = false;
}

// Close picker when clicking outside
document.addEventListener('mousedown', e => {
  if (!e.target.closest('.sb-at-picker') && !e.target.closest('.sb-story-input') && !e.target.closest('.sb-panel-beat')) {
    document.querySelectorAll('.sb-at-picker').forEach(p => p.style.display = 'none');
    atPickerState.active = false;
  }
});

/* ── PARSE @ MENTIONS FROM TEXT ──────────────────────────── */
/* Memoization (Fable audit item 4b) — parseAtMentions() re-ran its full
   variant-matching pipeline on every call, even though the same (text,
   asset-set) pair gets asked for repeatedly within one input cycle —
   ~8x across different callers per Single Frame keystroke per the audit
   (e.g. 02-singleframe.js's updatePrompt()-path calls it for the same
   subject/env text more than once per render). Single-entry cache — only
   holds the MOST RECENT (text, assetsSignature) pair, not a general LRU,
   since the redundancy here is always "called again immediately with the
   same inputs," never "called with many different inputs in a row."
   assetsSignature is a cheap fingerprint of every effective asset's
   id/type/name — the only fields this function's MATCHING logic actually
   reads — so it correctly invalidates on any asset add/remove/rename/type
   change without needing to find and instrument every place assets get
   mutated (addAsset, library link/unlink, migration, etc.). Building the
   signature is far cheaper than the variant-matching loop below, so this
   is a net win even on a cache miss. Safe to return the SAME array
   reference on a hit: every call site only ever reads the result
   (map/filter/find), never mutates it in place — verified across every
   caller in 02-singleframe.js, 06-scene-engine.js, 11-reference-panel.js.

   Bug fix (Fable review 2026-07-04, found after v7.12.0's Location
   Designer made it newly visible): the cached RESULT holds references to
   the full asset objects, not just their id/type/name, and downstream
   consumers (directionNote(), locBlockForScale(), the reference strip…)
   read far more than that — description, directions, images,
   imageAnalysis, etc. Both save paths REPLACE asset objects rather than
   mutating them in place (p.assets[id] = asset; _libraryCache[type] =
   res.assets), so editing an asset's CONTENT without renaming it left the
   signature unchanged — a cache hit then served the pre-edit object.
   Concretely: add directions to a location, save, Regen a panel whose
   beat still @-mentions it unchanged — cache hit, stale object, no
   dropdown, no clause, despite the save succeeding server-side. Both
   save paths already stamp `updated` on every save, so adding it to the
   signature closes this without touching either save path. */
let _parseAtMentionsCache = { text: null, assetsSignature: null, result: null };

function parseAtMentions(text) {
  const p = getCurrentProject();
  if (!p || !text) return [];

  const assets = Object.values(getEffectiveAssets());
  const assetsSignature = assets.map(a => a.id + ':' + a.type + ':' + a.name + ':' + (a.updated || 0)).join('|');
  if (_parseAtMentionsCache.text === text && _parseAtMentionsCache.assetsSignature === assetsSignature) {
    return _parseAtMentionsCache.result;
  }

  const mentions = [];
  const textLower = text.toLowerCase();

  // Ambiguous-first-word guard — bug found 2026-07-03: the loose
  // nameFirstWord shorthand variant below (added so a single-word nickname
  // like "@Sarah" can match "Sarah Chen") was checked with a plain substring
  // test, so mentioning ONE full multi-word name that happens to start with
  // a shared word (e.g. "@Wada Tank - Morning") falsely matched every OTHER
  // asset starting with that same word too ("Wada Corner - Morning", "Wada
  // Tank - Night", "Wada opposite view", ...) — the text trivially contains
  // "@wada" as a prefix of the longer name. Precompute which first words are
  // shared by 2+ assets so the loose fallback is disabled for all of them;
  // those assets can still only be matched by their full name (or a tagged
  // mention), same as any other real name collision in this file.
  const firstWordCounts = {};
  assets.forEach(a => {
    const fw = a.name.trim().toLowerCase().split(/\s+/)[0];
    if (fw) firstWordCounts[fw] = (firstWordCounts[fw] || 0) + 1;
  });

  // Type-tagged mentions first, e.g. "@Siblings(P)" — see MENTION_TYPE_TAGS
  // above. These are unambiguous: only the asset whose name AND type both
  // match is linked, even if another asset shares the exact same name.
  // Collected into a set of "claimed" names so the untagged pass below
  // doesn't also double-match the same occurrence against every
  // same-named asset.
  const taggedNamesUsed = new Set();
  const tagRe = /@([a-z0-9_]+)\(([clpes])\)/gi;
  let tm;
  while ((tm = tagRe.exec(text))) {
    const rawName = tm[1].toLowerCase();
    const wantType = MENTION_TYPE_TAGS_REV[tm[2].toUpperCase()];
    const match = assets.find(a =>
      a.type === wantType &&
      [a.name.toLowerCase(), a.name.toLowerCase().replace(/\s+/g, ''), a.name.toLowerCase().split(' ')[0]].includes(rawName)
    );
    if (match && !mentions.find(m => m.asset.id === match.id)) {
      mentions.push({ name: match.name, asset: match });
      taggedNamesUsed.add(rawName);
    }
  }

  assets.forEach(asset => {
    const name = asset.name.trim();
    if (!name) return;
    if (mentions.find(m => m.asset.id === asset.id)) return; // already linked via tag above

    // Build all possible @variants to look for
    const nameLower = name.toLowerCase();
    const nameNoSpaces = nameLower.replace(/\s+/g, '');
    const nameUnderscore = nameLower.replace(/\s+/g, '_');
    const nameFirstWord = nameLower.split(' ')[0];
    const nameCamel = name.replace(/\s+(.)/g, (_, c) => c.toUpperCase()).toLowerCase();

    // Skip if this exact name was already resolved via a type tag elsewhere
    // in the text — avoids re-matching the same written name a second time
    // untagged when a tagged occurrence already claimed it.
    if (taggedNamesUsed.has(nameLower) || taggedNamesUsed.has(nameFirstWord)) return;

    const variants = [
      '@' + nameLower,
      '@' + nameNoSpaces,
      '@' + nameUnderscore,
      '@' + nameCamel,
    ];
    // Only offer the bare-first-word shorthand when it's unambiguous —
    // i.e. no other asset shares this first word. See firstWordCounts above.
    if (firstWordCounts[nameFirstWord] === 1) variants.push('@' + nameFirstWord);

    // Remove duplicates
    const unique = [...new Set(variants)];
    const found = unique.some(v => textLower.includes(v));

    if (found && !mentions.find(m => m.asset.id === asset.id)) {
      mentions.push({ name: asset.name, asset });
    }
  });

  _parseAtMentionsCache = { text, assetsSignature, result: mentions };
  return mentions;
}

/* ── PLAIN-TEXT NAME DETECTION (task #14) ────────────────────────
   Detects asset names mentioned in beat text WITHOUT an "@" prefix —
   e.g. "Sarah walked into the room" with no @Sarah anywhere. This is
   deliberately narrower than parseAtMentions():

   - EXACT match only, whole-word, case-insensitive. No fuzzy/typo
     tolerance (e.g. "Sara" will NOT match "Sarah") — a conscious
     scope decision to avoid false positives between similar names
     or common words colliding with an asset name.
   - Reference-strip use ONLY. This does not feed buildPanelPrompt()
     or any asset-linking — keeping it isolated from the existing
     task #11 bug (whole-story vs per-panel mentions in the prompt
     pipeline) rather than compounding it. Callers that need actual
     prompt linking still require a real @mention.
   - Matches on the asset's full name and its first word only (e.g.
     "Sarah Chen" matches on "Sarah Chen" or "Sarah", but not on
     "Chen" alone) — mirrors the @-variant set parseAtMentions()
     already accepts (nameLower, nameFirstWord).

   Returns the same { name, asset } shape as parseAtMentions() so
   callers (inlineReferenceStripInnerHTML) can treat the two lists
   uniformly. */
function parsePlainTextMentions(text) {
  const p = getCurrentProject();
  if (!p || !text) return [];

  const mentions = [];
  const assets = Object.values(getEffectiveAssets());

  // Ambiguous-first-word guard (bug found 2026-07-07, ported from
  // parseAtMentions()'s 2026-07-03 fix — see that function's comment for
  // the original incident). This function never got the same guard when
  // it shipped, so a plain-text (no "@") mention of a short name like
  // "Jana" falsely also matched every OTHER asset whose name merely
  // STARTS with "Jana" (e.g. "Jana Home — opposite view"), surfacing an
  // unrelated asset's reference image as an "auto-detected" mention even
  // though it was never actually named. Precompute which first words are
  // shared by 2+ assets so the loose first-word candidate is disabled for
  // all of them — those assets can only be matched by their full name.
  const firstWordCounts = {};
  assets.forEach(a => {
    const fw = a.name.trim().toLowerCase().split(/\s+/)[0];
    if (fw) firstWordCounts[fw] = (firstWordCounts[fw] || 0) + 1;
  });

  assets.forEach(asset => {
    const name = asset.name.trim();
    if (!name) return;

    const nameFirstWord = name.split(/\s+/)[0];
    const candidates = (firstWordCounts[nameFirstWord.toLowerCase()] === 1)
      ? [...new Set([name, nameFirstWord])]
      : [name];

    const found = candidates.some(c => {
      // Whole-word match, case-insensitive, exact spelling only.
      const escaped = c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const re = new RegExp('\\b' + escaped + '\\b', 'i');
      return re.test(text);
    });

    if (found && !mentions.find(m => m.asset.id === asset.id)) {
      mentions.push({ name: asset.name, asset });
    }
  });

  return mentions;
}

/* ── ANALYSE UNLINKED ELEMENTS ───────────────────────────── */
function analyseUnlinked(text) {
  const warn = document.getElementById('sb-unlinked-warn');
  if (!warn) return;

  const p = getCurrentProject();
  if (!p) { warn.style.display = 'none'; return; }

  const mentions = parseAtMentions(text);
  const allAssets = Object.values(getEffectiveAssets());
  const unlinked = allAssets.filter(a => !mentions.find(m => m.asset.id === a.id));

  // Always show the panel if there's anything to say
  if (mentions.length === 0 && unlinked.length === 0) {
    warn.style.display = 'none';
    return;
  }

  let html = '';

  // Linked assets — shown as colour chips
  if (mentions.length > 0) {
    html += '<div style="font-size:0.68rem;color:var(--ink-lt);margin-bottom:5px;">✅ Linked to prompts:</div>';
    html += '<div class="sb-mentioned-assets">';
    html += mentions.map(m =>
      `<span class="sb-mentioned-chip sb-chip-${m.asset.type}">${TYPE_ICONS[m.asset.type]||''} ${escHtml(m.asset.name)}</span>`
    ).join('');
    html += '</div>';
  }

  // Unlinked assets — always shown if any exist
  if (unlinked.length > 0) {
    html += `<div style="margin-top:${mentions.length ? '8px' : '0'};font-size:0.72rem;color:var(--ink-mid);line-height:1.5;">`;
    html += `💡 <strong>Not linked yet:</strong> `;
    html += unlinked.map(a =>
      `<span style="background:var(--cream-dark);color:var(--ink);border:1px solid var(--border);padding:1px 6px;border-radius:10px;font-size:0.7rem;cursor:pointer;"
        onclick="insertAtFromHint('${escHtml(a.name)}')"
        title="Click to insert @${escHtml(a.name)} at cursor">@${escHtml(a.name)}</span>`
    ).join(' ');
    html += ` — click to insert, or leave out if not needed in this story.</div>`;
  }

  warn.innerHTML = html;
  warn.style.display = '';
}

/* ── INSERT @ FROM HINT PILL ─────────────────────────────── */
function insertAtFromHint(assetName) {
  const ta = document.getElementById('sb-story-text');
  if (!ta) return;
  const pos = ta.selectionStart || ta.value.length;
  const before = ta.value.slice(0, pos);
  const after = ta.value.slice(pos);
  const insert = (before.endsWith(' ') || before === '' ? '' : ' ') + '@' + assetName + ' ';
  ta.value = before + insert + after;
  ta.focus();
  const newPos = pos + insert.length;
  ta.setSelectionRange(newPos, newPos);
  sbState.storyText = ta.value;
  analyseUnlinked(ta.value);
}

