/**
 * SceneSmith Studio v7 — Vocabulary Manager (08-vocabulary.js)
 * ==============================================================
 * Settings → Vocabulary tab
 *
 * Storage key : S3_v7_vocab_manager
 * Shape       : { genres: { [genreKey]: { label, subject[], mood[], env[], wardrobe[] } } }
 *
 * On open     : seeded from VOCABULARY_DATA (vocabulary.json baked in at build)
 * Edits       : saved to localStorage only (vocabulary.json never modified at runtime)
 * Export      : downloads a vocabulary.json replacement
 * Quick-add   : any chip-area in Single Frame shows ⊕ icon → openVocabQuickAdd(group, term)
 */

// ── Storage ────────────────────────────────────────────────────────────────────
const VOCAB_KEY = 'S3_v7_vocab_manager';

function loadVocabData() {
  const raw = localStorage.getItem(VOCAB_KEY);
  if (raw) {
    try { return JSON.parse(raw); } catch(e) {}
  }
  // Seed from baked-in vocabulary.json
  return seedVocabFromBuiltIn();
}

function seedVocabFromBuiltIn() {
  if (typeof VOCABULARY_DATA === 'undefined' || !VOCABULARY_DATA.genres) {
    return { genres: {} };
  }
  const genres = {};
  Object.entries(VOCABULARY_DATA.genres).forEach(([key, val]) => {
    genres[key] = {
      label:    val.label || key,
      subject:  (val.subject  || []).slice(),
      mood:     (val.mood     || []).slice(),
      env:      (val.env      || []).slice(),
      wardrobe: (val.wardrobe || []).slice()
    };
  });
  return { genres };
}

function saveVocabData(data) {
  localStorage.setItem(VOCAB_KEY, JSON.stringify(data));
  // Refresh genre chips in Single Frame whenever vocab changes
  if (typeof renderSFGenreChips === 'function') renderSFGenreChips();
}

// ── State (in-memory while panel is open) ─────────────────────────────────────
let _vocabData       = null;   // full data object
let _vocabActiveGenre = null;  // currently selected genre key

function getVocabData() {
  if (!_vocabData) _vocabData = loadVocabData();
  return _vocabData;
}

// ── Tab switch hook ────────────────────────────────────────────────────────────
function switchSettingsTab(tab) {
  document.querySelectorAll('.settings-tab').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.tab === tab);
  });
  document.querySelectorAll('.settings-tab-panel').forEach(panel => {
    panel.style.display = 'none';
  });
  const panel = document.getElementById('settings-panel-' + tab);
  if (panel) panel.style.display = '';

  if (tab === 'vocab') {
    _vocabData = loadVocabData();
    renderVocabManager();
  }

  if (tab === 'backup' && typeof loadBackupSettingsUI === 'function') {
    loadBackupSettingsUI();
  }
}

// ── Render root ───────────────────────────────────────────────────────────────
function renderVocabManager() {
  const root = document.getElementById('vocab-manager-root');
  if (!root) return;
  const data = getVocabData();
  const genreKeys = Object.keys(data.genres);
  if (!_vocabActiveGenre || !data.genres[_vocabActiveGenre]) {
    _vocabActiveGenre = genreKeys[0] || null;
  }

  root.innerHTML = buildVocabHTML(data, genreKeys);
  attachVocabEvents();
}

function buildVocabHTML(data, genreKeys) {
  const cats = ['subject', 'mood', 'env', 'wardrobe'];
  const catLabels = { subject: 'Subject', mood: 'Mood', env: 'Environment', wardrobe: 'Wardrobe / Style' };

  // Genre sidebar
  let sidebar = '<div class="vm-genre-list">';
  genreKeys.forEach(key => {
    const g = data.genres[key];
    const active = key === _vocabActiveGenre ? ' vm-genre-item--active' : '';
    sidebar += `<div class="vm-genre-item${active}" data-genre="${key}" onclick="vmSelectGenre('${key}')">`;
    sidebar += `<span class="vm-genre-name">${escHtml(g.label || key)}</span>`;
    sidebar += `<button class="vm-genre-delete" title="Delete genre" onclick="vmDeleteGenre(event,'${key}')">✕</button>`;
    sidebar += '</div>';
  });
  sidebar += `<button class="btn btn-secondary btn-sm vm-add-genre-btn" onclick="vmAddGenre()">+ Add Genre</button>`;
  sidebar += '</div>';

  // Category columns
  let cols = '<div class="vm-cols">';
  if (_vocabActiveGenre && data.genres[_vocabActiveGenre]) {
    const genre = data.genres[_vocabActiveGenre];
    cats.forEach(cat => {
      const terms = genre[cat] || [];
      cols += `<div class="vm-col">`;
      cols += `<div class="vm-col-header">${catLabels[cat]}</div>`;
      cols += `<div class="vm-chip-list" data-cat="${cat}">`;
      terms.forEach((term, i) => {
        cols += `<span class="vm-chip" data-cat="${cat}" data-idx="${i}">`;
        cols += `<span class="vm-chip-label" ondblclick="vmEditChip(this,'${cat}',${i})">${escHtml(term)}</span>`;
        cols += `<button class="vm-chip-del" onclick="vmDeleteChip('${cat}',${i},'${escHtml(term).replace(/'/g, "\\'")}')">✕</button>`;
        cols += `</span>`;
      });
      cols += `</div>`;
      cols += `<div class="vm-add-chip-row">`;
      cols += `<input class="input vm-chip-input" type="text" placeholder="Add term…" spellcheck="true" data-cat="${cat}" `;
      cols += `onkeydown="vmAddChipOnEnter(event,'${cat}')">`;
      cols += `<button class="btn btn-secondary btn-sm" onclick="vmAddChipFromInput('${cat}')">Add</button>`;
      cols += `</div>`;
      cols += `</div>`;
    });
  } else {
    cols += '<div class="vm-empty">Select or create a genre to edit vocabulary.</div>';
  }
  cols += '</div>';

  // Toolbar
  const toolbar = `<div class="vm-toolbar">
    <button class="btn btn-secondary btn-sm" onclick="vmResetToDefaults()">↺ Reset to defaults</button>
    <button class="btn btn-secondary btn-sm" onclick="vmExportJSON()">⬇ Export vocabulary.json</button>
  </div>`;

  return `<div class="vm-root">${toolbar}<div class="vm-layout">${sidebar}${cols}</div></div>`;
}

function escHtml(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function attachVocabEvents() {
  // All events are wired via inline handlers in buildVocabHTML
}

// ── Genre actions ─────────────────────────────────────────────────────────────
function vmSelectGenre(key) {
  _vocabActiveGenre = key;
  renderVocabManager();
}

function vmDeleteGenre(evt, key) {
  evt.stopPropagation();
  const data = getVocabData();
  const label = data.genres[key] ? data.genres[key].label || key : key;
  showConfirm(
    'Delete Genre',
    `Delete genre "<strong>${escHtml(label)}</strong>" and all its vocabulary? This cannot be undone.`,
    function() {
      delete data.genres[key];
      if (_vocabActiveGenre === key) {
        const remaining = Object.keys(data.genres);
        _vocabActiveGenre = remaining[0] || null;
      }
      saveVocabData(data);
      renderVocabManager();
    }
  );
}

function vmAddGenre() {
  // Inline: insert an input field in the genre list
  const list = document.querySelector('.vm-genre-list');
  if (!list) return;
  const existing = list.querySelector('.vm-new-genre-input');
  if (existing) { existing.focus(); return; }

  const inp = document.createElement('input');
  inp.type = 'text';
  inp.className = 'input vm-new-genre-input';
  inp.spellcheck = true;
  inp.placeholder = 'Genre name…';
  inp.style.margin = '4px 0';

  const addBtn = list.querySelector('.vm-add-genre-btn');
  list.insertBefore(inp, addBtn);
  inp.focus();

  function commit() {
    const label = inp.value.trim();
    if (label) {
      const key = label.toLowerCase().replace(/[^a-z0-9]+/g, '_');
      const data = getVocabData();
      if (!data.genres[key]) {
        data.genres[key] = { label, subject: [], mood: [], env: [], wardrobe: [] };
        saveVocabData(data);
        _vocabActiveGenre = key;
      }
    }
    renderVocabManager();
  }

  inp.addEventListener('blur', commit);
  inp.addEventListener('keydown', function(e) {
    if (e.key === 'Enter') { e.preventDefault(); inp.blur(); }
    if (e.key === 'Escape') { inp.removeEventListener('blur', commit); renderVocabManager(); }
  });
}

// ── Chip actions ──────────────────────────────────────────────────────────────
function vmDeleteChip(cat, idx, term) {
  const data = getVocabData();
  if (!_vocabActiveGenre || !data.genres[_vocabActiveGenre]) return;
  showConfirm(
    'Delete Term',
    `Delete "<strong>${escHtml(term || '')}</strong>" from this genre's vocabulary? This cannot be undone.`,
    function() {
      data.genres[_vocabActiveGenre][cat].splice(idx, 1);
      saveVocabData(data);
      renderVocabManager();
    }
  );
}

function vmEditChip(el, cat, idx) {
  const data = getVocabData();
  if (!_vocabActiveGenre || !data.genres[_vocabActiveGenre]) return;
  const oldVal = data.genres[_vocabActiveGenre][cat][idx];

  const inp = document.createElement('input');
  inp.type = 'text';
  inp.className = 'input';
  inp.value = oldVal;
  inp.style.cssText = 'width:90px;padding:2px 6px;font-size:0.8rem;';

  const chip = el.parentElement;
  chip.replaceChild(inp, el);
  inp.focus(); inp.select();

  function commit() {
    const newVal = inp.value.trim();
    if (newVal && newVal !== oldVal) {
      data.genres[_vocabActiveGenre][cat][idx] = newVal;
      saveVocabData(data);
    }
    renderVocabManager();
  }

  inp.addEventListener('blur', commit);
  inp.addEventListener('keydown', function(e) {
    if (e.key === 'Enter') { e.preventDefault(); inp.blur(); }
    if (e.key === 'Escape') { inp.removeEventListener('blur', commit); renderVocabManager(); }
  });
}

function vmAddChipOnEnter(evt, cat) {
  if (evt.key === 'Enter') { evt.preventDefault(); vmAddChipFromInput(cat); }
}

function vmAddChipFromInput(cat) {
  const inp = document.querySelector(`.vm-chip-input[data-cat="${cat}"]`);
  if (!inp) return;
  const term = inp.value.trim();
  if (!term) return;
  const data = getVocabData();
  if (!_vocabActiveGenre || !data.genres[_vocabActiveGenre]) return;
  const arr = data.genres[_vocabActiveGenre][cat];
  if (!arr.includes(term)) {
    arr.push(term);
    saveVocabData(data);
  }
  renderVocabManager();
  // Refocus the same input after re-render
  const newInp = document.querySelector(`.vm-chip-input[data-cat="${cat}"]`);
  if (newInp) newInp.focus();
}

// ── Reset / Export ────────────────────────────────────────────────────────────
function vmResetToDefaults() {
  showConfirm(
    'Reset Vocabulary',
    'Reset all vocabulary to the built-in defaults? Your custom genres and terms will be lost.',
    function() {
      _vocabData = seedVocabFromBuiltIn();
      saveVocabData(_vocabData);
      _vocabActiveGenre = null;
      renderVocabManager();
    }
  );
}

function vmExportJSON() {
  const data = getVocabData();
  // Build export matching vocabulary.json schema
  const exportObj = {
    genres: {},
    powerBoosters:       (typeof VOCABULARY_DATA !== 'undefined' ? VOCABULARY_DATA.powerBoosters       : {}),
    signatureTechniques: (typeof VOCABULARY_DATA !== 'undefined' ? VOCABULARY_DATA.signatureTechniques : {})
  };
  Object.entries(data.genres).forEach(([key, val]) => {
    exportObj.genres[key] = {
      label:    val.label || key,
      subject:  val.subject  || [],
      mood:     val.mood     || [],
      env:      val.env      || [],
      wardrobe: val.wardrobe || []
    };
  });
  const blob = new Blob([JSON.stringify(exportObj, null, 2)], { type: 'application/json' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href     = url;
  a.download = 'vocabulary.json';
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

// ── Quick-add from Single Frame chip areas ────────────────────────────────────
// Called when user clicks ⊕ next to a chip group in SF
// group: 'subject' | 'mood' | 'env' | 'wardrobe'
// term:  pre-filled value (optional, e.g. from a chip just typed)
function openVocabQuickAdd(group, term) {
  // Open settings modal, switch to Vocabulary tab, then open add-chip input for the active genre
  openModal('settings-modal-overlay');
  switchSettingsTab('vocab');
  // After render, focus the right input
  setTimeout(function() {
    const inp = document.querySelector(`.vm-chip-input[data-cat="${group}"]`);
    if (inp) {
      if (term) inp.value = term;
      inp.focus();
      inp.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }
  }, 80);
}

// ── Expose GENRE_VOCAB from vocab manager (for getSigPhrases compatibility) ───
// Called by 02-singleframe.js after any vocab save
function getVocabGenres() {
  const data = getVocabData();
  return data.genres || {};
}
