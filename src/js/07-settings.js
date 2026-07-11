/* ══════════════════════════════════════════════════════════════
   SETTINGS
══════════════════════════════════════════════════════════════ */

const SETTINGS_KEY = 'S3_v7_settings';

function loadSettings() {
  try {
    return JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}');
  } catch(e) { return {}; }
}

function saveSettings(settings) {
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
}

function loadSettingsToUI() {
  const s = loadSettings();
  const keyEl = document.getElementById('settings-anthropic-key');
  if (keyEl && s.anthropicKey) keyEl.value = s.anthropicKey;
  const activeEl = document.getElementById('settings-anthropic-active');
  if (activeEl) activeEl.checked = s.anthropicActive !== false; // default ON if key present

  const geminiKeyEl = document.getElementById('settings-gemini-key');
  if (geminiKeyEl && s.geminiKey) geminiKeyEl.value = s.geminiKey;
  const geminiActiveEl = document.getElementById('settings-gemini-active');
  if (geminiActiveEl) geminiActiveEl.checked = s.geminiActive !== false; // default ON if key present

  const visionProviderEl = document.getElementById('settings-vision-provider');
  if (visionProviderEl) visionProviderEl.value = getVisionProvider();

  // Location Designer — prompt character budgets (see savePromptCharBudget()
  // below). Populate from stored value; left blank if never set — blank
  // means "no limit," per the design spec's "no default ceiling" decision.
  const budgets = getPromptCharBudgets();
  ['mj', 'gpt', 'gemini', 'other'].forEach(tier => {
    const el = document.getElementById('settings-budget-' + tier);
    if (el) el.value = budgets[tier] || '';
  });

  updateApiKeyIndicator();
}

/* ── PROMPT CHARACTER BUDGETS (Location Designer spec, 2026-06-28) ──────
   Four tiers, matching the design spec exactly: Midjourney / GPT Image-2 /
   Gemini (covers Nano Banana Pro) / Other-Aggregator (covers Kling and
   anything else not explicitly named). Every tier defaults to null/empty —
   NO numeric ceiling ships for any platform, since none of them publish a
   reliable character cap (spec's own research: GPT's 32,000-char API limit
   and Gemini's 65,536-token ceiling are both far beyond practical concern;
   Midjourney and aggregators publish nothing at all). Trimming (applied in
   buildPanelPrompt(), 06-scene-engine.js) is inert for any tier left empty,
   exactly as if this feature didn't exist — only activates once the user
   personally hits a real wall and enters a number here. */
function getPromptCharBudgets() {
  const s = loadSettings();
  return s.promptCharBudgets || {};
}

function savePromptCharBudget(tier, value) {
  const s = loadSettings();
  s.promptCharBudgets = s.promptCharBudgets || {};
  const num = parseInt(value, 10);
  s.promptCharBudgets[tier] = (value === '' || isNaN(num) || num <= 0) ? null : num;
  saveSettings(s);
}

// Maps a Storyboard/Single Frame platform code to its budget tier. Kling
// has no dedicated tier in the spec's four-item list — falls to "other",
// the spec's own designed catch-all for exactly this kind of gap.
function getPromptCharBudgetForPlatform(platform) {
  const budgets = getPromptCharBudgets();
  const tierMap = { mj: 'mj', gpt: 'gpt', nb: 'gemini', kling: 'other' };
  const tier = tierMap[platform] || 'other';
  return budgets[tier] || null;
}

/* ── VISION PROVIDER (which API the Image Analyser uses) ─────── */
function getVisionProvider() {
  const s = loadSettings();
  return s.visionProvider || 'anthropic'; // default: Claude
}

function saveVisionProvider(provider) {
  const s = loadSettings();
  s.visionProvider = provider;
  saveSettings(s);
}

function saveApiKey(provider, value) {
  const s = loadSettings();
  s[provider + 'Key'] = value.trim();
  // Auto-enable when a key is pasted
  if (value.trim()) s[provider + 'Active'] = true;
  saveSettings(s);
  // Update checkbox to match
  const activeEl = document.getElementById(`settings-${provider}-active`);
  if (activeEl && value.trim()) activeEl.checked = true;
  updateApiKeyIndicator();
}

function saveApiActive(provider, isActive) {
  const s = loadSettings();
  s[provider + 'Active'] = isActive;
  saveSettings(s);
}

function getApiKey(provider) {
  return loadSettings()[provider + 'Key'] || '';
}

function isApiActive(provider) {
  const s = loadSettings();
  // Active only if key present AND toggle is on (default ON)
  return !!(s[provider + 'Key'] && s[provider + 'Active'] !== false);
}

function toggleKeyVisibility(inputId, btn) {
  const input = document.getElementById(inputId);
  if (!input) return;
  if (input.type === 'password') {
    input.type = 'text';
    btn.textContent = 'Hide';
  } else {
    input.type = 'password';
    btn.textContent = 'Show';
  }
}

function openSettings() {
  loadSettingsToUI();
  openModal('settings-modal-overlay');
}

function updateApiKeyIndicator() {
  const key = getApiKey('anthropic');
  const active = isApiActive('anthropic');
  const indicator = document.getElementById('sb-api-key-indicator');
  const label = document.getElementById('sb-api-key-label');
  const badge = document.getElementById('anthropic-status-badge');

  // Update storyboard status
  if (indicator && label) {
    if (!key) {
      indicator.style.color = 'var(--border)';
      label.textContent = 'No API key set — using offline split';
    } else if (!active) {
      indicator.style.color = 'var(--amber)';
      label.textContent = 'API key set but inactive — using offline split';
    } else {
      indicator.style.color = 'var(--green)';
      label.textContent = 'Anthropic API active — Smart Split ready';
    }
  }

  // Update Settings badge
  if (badge) {
    if (!key) {
      badge.textContent = 'No key';
      badge.className = 'api-badge api-badge-soon';
    } else if (!active) {
      badge.textContent = 'Inactive';
      badge.className = 'api-badge';
      badge.style.cssText = 'background:#FFF3E0;color:#E65100;';
    } else {
      badge.textContent = 'Active';
      badge.className = 'api-badge api-badge-active';
      badge.style.cssText = '';
    }
  }

  // Update Gemini badge
  const geminiKey = getApiKey('gemini');
  const geminiActive = isApiActive('gemini');
  const geminiBadge = document.getElementById('gemini-status-badge');
  if (geminiBadge) {
    if (!geminiKey) {
      geminiBadge.textContent = 'No key';
      geminiBadge.className = 'api-badge api-badge-soon';
    } else if (!geminiActive) {
      geminiBadge.textContent = 'Inactive';
      geminiBadge.className = 'api-badge';
      geminiBadge.style.cssText = 'background:#FFF3E0;color:#E65100;';
    } else {
      geminiBadge.textContent = 'Active';
      geminiBadge.className = 'api-badge api-badge-active';
      geminiBadge.style.cssText = '';
    }
  }
}

function confirmResetApp() {
  showConfirm('Reset App', 'This will permanently delete all projects, library assets, vocabulary edits, and settings. Cannot be undone.', () => {
    localStorage.removeItem(STORAGE_KEY);
    localStorage.removeItem(SETTINGS_KEY);
    localStorage.removeItem('S3_v7_customChips');
    localStorage.removeItem('S3_v7_onboarding');
    location.reload();
  });
}

/* ── Update smartSplit to read key from Settings ── */
function getSmartSplitApiKey() {
  return getApiKey('anthropic');
}

/* ══════════════════════════════════════════════════════════════
   SPONSOR PANEL (shared/sponsored API key)
   ─────────────────────────────────────────────────────────────
   Lets the owner share their own Anthropic/Gemini key with named
   teammates without the raw key ever reaching their browser — see
   save_sponsor_key / get_sponsor_settings / analyse_image in api.php.
   Every call here requires the owner's own password (require_password
   server-side), so the password field must be re-entered/unlocked
   before this panel will load or save anything.
══════════════════════════════════════════════════════════════ */

let _sponsorUsernames = []; // working copy shown in the chip list, saved on "Save"

async function loadSponsorSettingsUI() {
  const user = getCurrentUser();
  const pwInput = document.getElementById('sponsor-confirm-password');
  const hintEl = document.getElementById('sponsor-unlock-hint');
  const section = document.getElementById('sponsor-managed-section');
  if (!user) { hintEl.textContent = 'Sign in first.'; return; }

  const password = pwInput.value;
  if (!password) { hintEl.textContent = 'Enter your password to continue.'; return; }

  hintEl.textContent = 'Checking…';
  const res = await apiCall('get_sponsor_settings', { username: user, password });
  if (!res) {
    hintEl.textContent = lastApiError || 'Incorrect password.';
    section.style.display = 'none';
    return;
  }

  // Remember the password in memory for the Save action below — same
  // in-memory-only approach as the rest of the app (see setCurrentPassword
  // in 00-api.js). Cleared whenever the Settings modal is closed.
  setCurrentPassword(password);
  pwInput.value = '';
  hintEl.textContent = 'Unlocked.';
  section.style.display = '';

  _sponsorUsernames = res.sponsored_usernames || [];
  renderSponsoredUsernameChips();

  document.getElementById('sponsor-anthropic-status').textContent =
    res.has_anthropic_key ? 'A key is currently set.' : 'No key set yet.';
  document.getElementById('sponsor-gemini-status').textContent =
    res.has_gemini_key ? 'A key is currently set.' : 'No key set yet.';
}

function renderSponsoredUsernameChips() {
  const list = document.getElementById('sponsor-username-list');
  if (!list) return;
  list.innerHTML = '';
  _sponsorUsernames.forEach(u => {
    const chip = document.createElement('span');
    chip.className = 'api-badge';
    chip.style.cssText = 'display:inline-flex;align-items:center;gap:6px;background:var(--bg-soft,#2a2a40);';
    chip.innerHTML = `${u.replace(/</g, '&lt;')} <button style="border:none;background:none;cursor:pointer;color:inherit;font-weight:700;" onclick="removeSponsoredUsername('${u.replace(/'/g, "\\'")}')">✕</button>`;
    list.appendChild(chip);
  });
}

function addSponsoredUsername() {
  const input = document.getElementById('sponsor-add-username');
  const raw = (input.value || '').trim().toLowerCase();
  if (!raw) return;
  if (!_sponsorUsernames.includes(raw)) _sponsorUsernames.push(raw);
  input.value = '';
  renderSponsoredUsernameChips();
}

function removeSponsoredUsername(u) {
  _sponsorUsernames = _sponsorUsernames.filter(x => x !== u);
  renderSponsoredUsernameChips();
}

async function saveSponsorSettings() {
  const user = getCurrentUser();
  const password = getCurrentPassword();
  const statusEl = document.getElementById('sponsor-save-status');
  if (!user || !password) {
    statusEl.textContent = 'Please unlock with your password first.';
    return;
  }

  statusEl.textContent = 'Saving…';
  const payload = {
    username: user,
    password,
    sponsored_usernames: _sponsorUsernames,
  };
  const anthropicKey = document.getElementById('sponsor-anthropic-key').value.trim();
  const geminiKey = document.getElementById('sponsor-gemini-key').value.trim();
  if (anthropicKey) payload.anthropic_key = anthropicKey;
  if (geminiKey) payload.gemini_key = geminiKey;

  const res = await apiCall('save_sponsor_key', payload);
  if (!res) {
    statusEl.textContent = lastApiError || 'Save failed.';
    return;
  }
  document.getElementById('sponsor-anthropic-key').value = '';
  document.getElementById('sponsor-gemini-key').value = '';
  document.getElementById('sponsor-anthropic-status').textContent =
    res.has_anthropic_key ? 'A key is currently set.' : 'No key set yet.';
  document.getElementById('sponsor-gemini-status').textContent =
    res.has_gemini_key ? 'A key is currently set.' : 'No key set yet.';
  statusEl.textContent = 'Saved ✓';
}

/* ══════════════════════════════════════════════════════════════
   BACKUP SETTINGS (Task #1, 2026-06-25)
   ─────────────────────────────────────────────────────────────
   Configures where the server-side cron job (backup.php) writes
   its 3×/day snapshots. This panel only reads/writes the
   destination path via get_backup_settings / save_backup_settings
   (api.php) — it does not trigger a backup itself; that's cron's
   job, running backup.php directly via php-cli.
══════════════════════════════════════════════════════════════ */

async function loadBackupSettingsUI() {
  const input = document.getElementById('backup-dir-input');
  const statusLine = document.getElementById('backup-status-line');
  if (statusLine) statusLine.textContent = 'Loading…';

  const res = await apiCall('get_backup_settings');
  if (!res) {
    if (statusLine) statusLine.textContent = 'Could not load backup settings: ' + (lastApiError || 'unknown error contacting the server.');
    return;
  }

  if (input) input.value = res.backup_dir || '';

  if (!statusLine) return;
  if (!res.backup_dir) {
    statusLine.textContent = 'No backup destination configured yet — set one above.';
  } else if (!res.last_run_at) {
    statusLine.textContent = 'Destination saved. Waiting for the next scheduled run.';
  } else {
    const when = new Date(res.last_run_at).toLocaleString();
    statusLine.textContent = res.last_run_ok
      ? `✓ Last backup succeeded — ${when}. ${res.last_run_msg || ''}`
      : `✗ Last backup failed — ${when}. ${res.last_run_msg || ''}`;
  }
}

async function saveBackupSettings() {
  const input = document.getElementById('backup-dir-input');
  const hint = document.getElementById('backup-dir-hint');
  const dir = (input && input.value || '').trim();
  if (!dir) {
    if (hint) hint.textContent = 'Enter a destination folder first.';
    return;
  }

  if (hint) hint.textContent = 'Saving…';
  const res = await apiCall('save_backup_settings', { backup_dir: dir });
  if (!res) {
    if (hint) hint.textContent = 'Save failed: ' + (lastApiError || 'unknown error contacting the server.');
    return;
  }

  if (input) input.value = res.backup_dir;
  if (hint) {
    hint.textContent = 'Saved ✓ — the next scheduled cron run will back up to this folder.';
  }
  showToast('Backup destination saved', 'success');
  loadBackupSettingsUI();
}

async function runBackupNow() {
  const btn = document.getElementById('backup-now-btn');
  const hint = document.getElementById('backup-now-hint');
  const defaultHint = 'Runs the same backup immediately instead of waiting for the next scheduled ' +
    'run. May take a while on a large library — keep this tab open until it finishes.';

  if (btn) { btn.disabled = true; btn.textContent = 'Running…'; }
  if (hint) hint.textContent = 'Backup running now — zipping app files and copying userdata/. This can take a minute or more on a large library, please wait…';

  const res = await apiCall('run_backup_now');

  if (btn) { btn.disabled = false; btn.textContent = 'Backup Now'; }

  if (!res) {
    if (hint) hint.textContent = 'Backup failed: ' + (lastApiError || 'unknown error contacting the server.');
    showToast('Backup failed', 'error');
    loadBackupSettingsUI();
    return;
  }

  if (hint) hint.textContent = defaultHint;
  showToast('Backup completed', 'success');
  loadBackupSettingsUI(); // refresh "Last backup status" with this run's result
}

/* ══════════════════════════════════════════════════════════════
   ONBOARDING BANNER
══════════════════════════════════════════════════════════════ */

const ONBOARDING_KEY = 'S3_v7_onboarding';

function initOnboarding() {
  const dismissed = localStorage.getItem(ONBOARDING_KEY) === 'dismissed';
  const banner = document.getElementById('sf-onboarding-banner');
  if (banner) banner.style.display = dismissed ? 'none' : '';
}

function dismissOnboarding() {
  localStorage.setItem(ONBOARDING_KEY, 'dismissed');
  const banner = document.getElementById('sf-onboarding-banner');
  if (banner) banner.style.display = 'none';
}

/* ══════════════════════════════════════════════════════════════
   CUSTOM CHIP PERSISTENCE
══════════════════════════════════════════════════════════════ */

const CUSTOM_CHIPS_KEY = 'S3_v7_customChips'; // legacy localStorage key, used as offline fallback/cache only
let _customChipsCache = null;       // in-memory mirror of server-shared chips, once loaded
let _customChipsLoaded = false;

function loadCustomChips() {
  // Server-backed cache, falls back to local cache (offline) until the server responds.
  if (_customChipsCache) return _customChipsCache;
  try {
    return JSON.parse(localStorage.getItem(CUSTOM_CHIPS_KEY) || '{}');
  } catch(e) { return {}; }
}

/* ── Fetch the shared/global custom-chip vocabulary from the server.
   Call once on app init, before rendering chip groups. Falls back to
   the local cache silently if the server/API is unreachable. ── */
async function syncCustomChipsFromServer() {
  if (typeof apiCall !== 'function') return;
  const res = await apiCall('load_custom_chips');
  if (res && res.chips) {
    _customChipsCache = res.chips;
    _customChipsLoaded = true;
    try { localStorage.setItem(CUSTOM_CHIPS_KEY, JSON.stringify(res.chips)); } catch(e) {}
  }
}

/* ── INLINE CHIP EDIT (no prompt() — file:// safe) ───────── */
function inlineEditCustomChip(btn, group, wrap) {
  const oldVal = btn.dataset.val;
  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'sf-chip-input';
  input.value = oldVal;
  input.style.minWidth = '100px';
  btn.replaceWith(input);
  input.focus();
  input.select();

  function commit() {
    const newVal = input.value.trim();
    if (newVal && newVal !== oldVal) {
      deleteCustomChip(group, oldVal);
      saveCustomChip(group, newVal);
      sfState.selections[group] = (sfState.selections[group] || []).filter(v => v !== oldVal);
      btn.dataset.val = newVal;
      btn.textContent = newVal;
      btn.title = 'Right-click to delete · Double-click to edit';
      if (btn.classList.contains('active')) {
        sfState.selections[group] = sfState.selections[group] || [];
        sfState.selections[group].push(newVal);
      }
      updatePrompt();
    }
    input.replaceWith(btn);
  }

  input.addEventListener('blur', commit);
  input.addEventListener('keydown', e => {
    if (e.key === 'Enter') { e.preventDefault(); input.blur(); }
    if (e.key === 'Escape') { input.removeEventListener('blur', commit); input.replaceWith(btn); }
  });
}

function saveCustomChip(group, value) {
  // Update local cache immediately (instant UI), then push to shared server store.
  const store = loadCustomChips();
  if (!store[group]) store[group] = [];
  if (!store[group].includes(value)) {
    store[group].push(value);
    _customChipsCache = store;
    try { localStorage.setItem(CUSTOM_CHIPS_KEY, JSON.stringify(store)); } catch(e) {}
  }
  if (typeof apiCall === 'function') {
    apiCall('save_custom_chip', { group, value }).then(res => {
      if (res && res.chips) {
        _customChipsCache = res.chips;
        try { localStorage.setItem(CUSTOM_CHIPS_KEY, JSON.stringify(res.chips)); } catch(e) {}
      }
    });
  }
}

function deleteCustomChip(group, value) {
  showConfirm('Delete Chip', `Delete custom chip "<strong>${escHtml(value || '')}</strong>"? This cannot be undone.`, function() {
    const store = loadCustomChips();
    if (store[group]) {
      store[group] = store[group].filter(v => v !== value);
      _customChipsCache = store;
      try { localStorage.setItem(CUSTOM_CHIPS_KEY, JSON.stringify(store)); } catch(e) {}
    }
    if (typeof apiCall === 'function') {
      apiCall('delete_custom_chip', { group, value }).then(res => {
        if (res && res.chips) {
          _customChipsCache = res.chips;
          try { localStorage.setItem(CUSTOM_CHIPS_KEY, JSON.stringify(res.chips)); } catch(e) {}
        }
      });
    }
  });
}

function getCustomChipsForGroup(group) {
  return loadCustomChips()[group] || [];
}

function renderPersistedCustomChips(containerId, group) {
  const container = document.getElementById(containerId);
  if (!container) return;
  const saved = getCustomChipsForGroup(group);
  saved.forEach(val => {
    // Don't add if already in container
    if (container.querySelector(`[data-val="${CSS.escape(val)}"]`)) return;
    const addBtn = container.querySelector('.sf-chip-add');
    const wrap = document.createElement('span');
    wrap.className = 'sf-chip-wrap';
    const btn = document.createElement('button');
    btn.className = 'sf-chip sf-chip-custom';
    btn.dataset.val = val;
    btn.textContent = val;
    const isSingleSelect = container.classList.contains('single-select');
    btn.onclick = () => toggleSFChip(btn, group, isSingleSelect);
    btn.title = 'Right-click to delete · Double-click to edit';
    btn.ondblclick = () => inlineEditCustomChip(btn, group, wrap);
    btn.oncontextmenu = (e) => {
      e.preventDefault();
      deleteCustomChip(group, btn.dataset.val);
      sfState.selections[group] = (sfState.selections[group] || []).filter(v => v !== btn.dataset.val);
      wrap.remove();
      updatePrompt();
    };
    wrap.appendChild(btn);
    if (addBtn) container.insertBefore(wrap, addBtn);
    else container.appendChild(wrap);
  });
}

/* ══════════════════════════════════════════════════════════════
   TYPEAHEAD FOR CUSTOM CHIP INPUT
══════════════════════════════════════════════════════════════ */

function buildTypeaheadIndex(group) {
  // Collect all built-in chip values for this group from the DOM
  const builtins = [];
  document.querySelectorAll(`[data-group="${group}"] .sf-chip:not(.sf-chip-add), .sf-chips .sf-chip:not(.sf-chip-add)`).forEach(btn => {
    if (btn.dataset.val) builtins.push({ val: btn.dataset.val, source: 'built-in' });
  });
  // Add saved custom chips
  const custom = getCustomChipsForGroup(group).map(v => ({ val: v, source: 'my keywords' }));
  // Deduplicate
  const seen = new Set();
  return [...builtins, ...custom].filter(item => {
    if (seen.has(item.val)) return false;
    seen.add(item.val);
    return true;
  });
}

function showTypeahead(input, group, query) {
  removeTypeahead();
  if (!query || query.length < 1) return;

  const index = buildTypeaheadIndex(group);
  const q = query.toLowerCase();
  const matches = index.filter(item =>
    item.val.toLowerCase().includes(q) && item.val.toLowerCase() !== q
  ).slice(0, 8);

  if (!matches.length) return;

  const dropdown = document.createElement('div');
  dropdown.className = 'chip-typeahead';
  dropdown.id = 'chip-typeahead-dropdown';

  matches.forEach(item => {
    const div = document.createElement('div');
    div.className = 'chip-typeahead-item';
    // Highlight matching part
    const idx = item.val.toLowerCase().indexOf(q);
    const before = escHtml(item.val.slice(0, idx));
    const match = `<strong>${escHtml(item.val.slice(idx, idx + q.length))}</strong>`;
    const after = escHtml(item.val.slice(idx + q.length));
    div.innerHTML = `<span>${before}${match}${after}</span><span class="ta-source">${item.source}</span>`;
    div.onmousedown = (e) => {
      e.preventDefault();
      input.value = item.val;
      removeTypeahead();
      input.focus();
    };
    dropdown.appendChild(div);
  });

  // Position below input
  input.parentNode.style.position = 'relative';
  input.parentNode.appendChild(dropdown);
}

function removeTypeahead() {
  const existing = document.getElementById('chip-typeahead-dropdown');
  if (existing) existing.remove();
}

/* ── Override addStaticCustomChip to use persistence + typeahead ── */
function addStaticCustomChip(containerId, group) {
  const container = document.getElementById(containerId);
  if (!container) return;
  const addBtn = container.querySelector('.sf-chip-add');
  if (!addBtn) return;

  // First-use discovery toast
  const shownKey = 'S3_v7_chipTip';
  if (!localStorage.getItem(shownKey)) {
    showToast('Tip: Right-click a custom chip to delete · Double-click to edit', '');
    localStorage.setItem(shownKey, '1');
  }

  const inputWrap = document.createElement('div');
  inputWrap.style.cssText = 'position:relative;display:inline-block;';
  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'sf-chip-input';
  input.placeholder = 'Type keyword…';
  input.style.minWidth = '140px';
  inputWrap.appendChild(input);
  addBtn.replaceWith(inputWrap);
  input.focus();

  input.addEventListener('input', () => showTypeahead(input, group, input.value.trim()));
  input.addEventListener('keydown', e => {
    if (e.key === 'ArrowDown') {
      const first = document.querySelector('.chip-typeahead-item');
      if (first) first.focus();
    }
    if (e.key === 'Enter') { e.preventDefault(); commitChip(); }
    if (e.key === 'Escape') { removeTypeahead(); restoreAddBtn(); }
  });

  function restoreAddBtn() {
    const newAddBtn = document.createElement('button');
    newAddBtn.className = 'sf-chip sf-chip-add';
    newAddBtn.title = 'Add custom keyword';
    newAddBtn.textContent = '＋';
    newAddBtn.onclick = () => addStaticCustomChip(containerId, group);
    inputWrap.replaceWith(newAddBtn);
  }

  function commitChip() {
    removeTypeahead();
    const newVal = input.value.trim();
    if (newVal) {
      saveCustomChip(group, newVal);
      const isSingleSelect = container.classList.contains('single-select');
      // Build chip element
      const wrap = document.createElement('span');
      wrap.className = 'sf-chip-wrap';
      const btn = document.createElement('button');
      btn.className = 'sf-chip active sf-chip-custom';
      btn.dataset.val = newVal;
      btn.textContent = newVal;
      btn.title = 'Right-click to delete · Double-click to edit';
      btn.onclick = () => toggleSFChip(btn, group, isSingleSelect);
      btn.ondblclick = () => inlineEditCustomChip(btn, group, wrap);
      btn.oncontextmenu = (e) => {
        e.preventDefault();
        deleteCustomChip(group, btn.dataset.val);
        sfState.selections[group] = (sfState.selections[group] || []).filter(v => v !== btn.dataset.val);
        wrap.remove();
        updatePrompt();
      };
      wrap.appendChild(btn);

      if (isSingleSelect) {
        container.querySelectorAll('.sf-chip').forEach(b => { if (b !== btn) b.classList.remove('active'); });
        sfState.selections[group] = [newVal];
      } else {
        if (!sfState.selections[group]) sfState.selections[group] = [];
        sfState.selections[group].push(newVal);
      }
      container.appendChild(wrap);
      showToast('Keyword saved: ' + newVal, 'success');
      updatePrompt();
    }
    restoreAddBtn();
  }

  input.addEventListener('blur', () => {
    setTimeout(() => { removeTypeahead(); commitChip(); }, 150);
  });
}
