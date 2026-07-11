/* ============================================================
   SS_Studio v7 — 00-api.js
   User identity, server API, persistence layer.
   Must load AFTER 01-core.js (needs STORAGE_KEY, state,
   defaultImageSlots, renderAll, showToast).
   ============================================================ */

/* ── USER IDENTITY ─────────────────────────────────────────── */
const USER_KEY = 'SS_Studio_user';
const API_URL  = '../api.php';

/* ── OFFLINE MODE ───────────────────────────────────────────────
   Set once the user has successfully proceeded without a reachable
   server (see confirm() in showUserPrompt below). When true, we skip
   server round-trips entirely instead of retrying-then-falling-back
   on every load — keeps a standalone/offline build snappy and quiet. */
const OFFLINE_MODE_KEY = 'SS_Studio_offline_mode';
function isOfflineMode() {
  try { return localStorage.getItem(OFFLINE_MODE_KEY) === '1'; } catch(e) { return false; }
}

function getCurrentUser() {
  return localStorage.getItem(USER_KEY) || null;
}

function setCurrentUser(username) {
  localStorage.setItem(USER_KEY, username);
  updateUserChip(username);
}

/* ── IN-MEMORY PASSWORD (never persisted) ──────────────────────
   Some server actions (sponsor key save/lookup, the analyse_image
   proxy) require proof of the caller's password on every request —
   see require_password() in api.php. We hold the password in a plain
   module-level variable for the lifetime of the page only; it is
   NEVER written to localStorage. It's set right after a successful
   login/registration and cleared on sign-out. If the page is
   reloaded the user simply has to log in again to use sponsor
   features — an acceptable trade-off for not persisting a password
   in any browser storage. */
let _currentPassword = null;
function setCurrentPassword(password) { _currentPassword = password || null; }
function getCurrentPassword() { return _currentPassword; }
function clearCurrentPassword() { _currentPassword = null; }

function updateUserChip(username) {
  const chip   = document.getElementById('user-chip');
  const name   = document.getElementById('user-chip-name');
  const avatar = document.getElementById('user-avatar-initial');
  if (!chip || !username) return;
  const display = username.charAt(0).toUpperCase() + username.slice(1);
  name.textContent   = display;
  avatar.textContent = display.charAt(0).toUpperCase();
  chip.style.display = 'flex';
}

/* ── API WRAPPER ───────────────────────────────────────────── */
// Set to the server's `error` message right before apiCall() returns null,
// so callers needing a precise message (e.g. the login modal) can read it.
let lastApiError = null;

async function apiCall(action, data = {}) {
  // Once we've established there's no server, don't keep retrying every
  // call — fail fast and silently so an offline build stays responsive.
  if (isOfflineMode()) return null;
  try {
    const res = await fetch(API_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action, username: getCurrentUser(), ...data })
    });
    const json = await res.json();
    if (!json.success) throw new Error(json.error || 'API error');
    lastApiError = null;
    return json;
  } catch(e) {
    console.warn('API call failed:', action, e);
    lastApiError = e.message || null;
    return null;
  }
}

/* ── USER PROMPT MODAL ─────────────────────────────────────── */
function showUserPrompt(onComplete, opts = {}) {
  if (document.getElementById('user-identity-overlay')) return;
  const forcedSetupUsername = opts.forcedSetupUsername || null;

  const overlay = document.createElement('div');
  overlay.id = 'user-identity-overlay';
  overlay.style.cssText = `
    position:fixed;inset:0;z-index:99999;
    background:rgba(0,0,0,0.85);
    display:flex;align-items:center;justify-content:center;
    font-family:inherit;
  `;
  const boxStyle = `
      background:#1a1a2e;border:1px solid #3d3d6b;border-radius:12px;
      padding:40px 48px;max-width:420px;width:90%;text-align:center;
      box-shadow:0 24px 64px rgba(0,0,0,0.6);
  `;
  const inputStyle = `
      width:100%;box-sizing:border-box;padding:12px 16px;
      background:#0d0d1a;border:1px solid #4a4a7a;border-radius:8px;
      color:#e8e8f0;font-size:1rem;outline:none;margin-bottom:12px;
      font-family:inherit;
  `;
  const primaryBtnStyle = `
      width:100%;padding:13px;background:#6c63ff;border:none;border-radius:8px;
      color:#fff;font-size:1rem;font-weight:600;cursor:pointer;font-family:inherit;
      transition:background 0.2s;
  `;
  const linkBtnStyle = `
      background:none;border:none;color:#8a85ff;font-size:0.82rem;
      cursor:pointer;font-family:inherit;text-decoration:underline;padding:0;
  `;

  function renderLogin() {
    const isForced = !!forcedSetupUsername;
    overlay.innerHTML = `
      <div style="${boxStyle}">
        <div style="font-size:2.4rem;margin-bottom:12px;">🎬</div>
        <h2 style="color:#e8e8f0;margin:0 0 8px;font-size:1.4rem;font-weight:600;">${isForced ? 'Secure your account' : 'Welcome to SS_Studio'}</h2>
        <p style="color:#8888aa;margin:0 0 24px;font-size:0.9rem;line-height:1.5;">
          ${isForced
            ? `SS_Studio now requires a password. Set one for <strong style="color:#c8c8e0;">${forcedSetupUsername.replace(/</g, '&lt;')}</strong> to continue — your projects are safe and won't be affected.`
            : `Sign in with your name and password.<br>New here? Just pick a password to create your profile.`}
        </p>
        <input id="user-name-input" type="text" placeholder="Your name (e.g. Mani)"
          style="${inputStyle}${isForced ? 'opacity:0.6;pointer-events:none;' : ''}" maxlength="50" autocomplete="username"
          ${isForced ? `value="${forcedSetupUsername.replace(/"/g, '&quot;')}" readonly` : ''} />
        <input id="user-pass-input" type="password" placeholder="${isForced ? 'Choose a password' : 'Password'}"
          style="${inputStyle}" maxlength="100" autocomplete="current-password" />
        <div id="user-name-error" style="color:#ff6b6b;font-size:0.82rem;margin-bottom:12px;min-height:18px;"></div>
        <button id="user-name-confirm" style="${primaryBtnStyle}">${isForced ? 'Set password →' : "Let's go →"}</button>
        <p style="margin:16px 0 0;">
          <button id="forgot-password-link" style="${linkBtnStyle}">Forgot password?</button>
        </p>
      </div>
    `;

    const input    = document.getElementById('user-name-input');
    const passInput= document.getElementById('user-pass-input');
    const btn      = document.getElementById('user-name-confirm');
    const errEl    = document.getElementById('user-name-error');
    const forgotLink = document.getElementById('forgot-password-link');

    passInput.focus();

    async function confirm() {
      const raw  = input.value.trim();
      const pass = passInput.value;
      if (raw.length < 2) { errEl.textContent = 'Please enter at least 2 characters.'; return; }
      if (!pass || pass.length < 4) { errEl.textContent = 'Password must be at least 4 characters.'; return; }
      btn.disabled = true;
      btn.textContent = 'Signing in…';
      errEl.textContent = '';
      const res = await apiCall('create_user', { username: raw, password: pass });
      if (!res) {
        // Offline fallback (standalone single-file build, or MAMP not running):
        // proceed with a local-only identity instead of hard-blocking the user.
        // Everything still works — saveState()/loadState() already fall back
        // to localStorage whenever the server is unreachable (see _saveStateNow
        // and loadStateFromServer below). Server features (cross-device sync,
        // shared custom chips, sponsor key, image-analysis proxy) simply won't
        // be available until a server is reachable.
        setCurrentUser(raw);
        setCurrentPassword(pass);
        try { localStorage.setItem(OFFLINE_MODE_KEY, '1'); } catch(e) {}
        overlay.remove();
        if (typeof showToast === 'function') {
          showToast('No server detected — working in offline (local-only) mode.', 'info');
        }
        onComplete();
        return;
      }
      setCurrentUser(res.username);
      setCurrentPassword(pass);
      overlay.remove();
      onComplete();
    }

    btn.addEventListener('click', confirm);
    [input, passInput].forEach(el => {
      el.addEventListener('keydown', e => { if (e.key === 'Enter') confirm(); });
      el.addEventListener('input',   () => { errEl.textContent = ''; });
    });
    forgotLink.addEventListener('click', () => renderForgotStep1(input.value.trim()));
  }

  function renderForgotStep1(prefillUsername) {
    overlay.innerHTML = `
      <div style="${boxStyle}">
        <h2 style="color:#e8e8f0;margin:0 0 8px;font-size:1.3rem;font-weight:600;">Reset your password</h2>
        <p style="color:#8888aa;margin:0 0 24px;font-size:0.88rem;line-height:1.5;">
          Enter your username to look up your security question.
        </p>
        <input id="forgot-username-input" type="text" placeholder="Your name"
          style="${inputStyle}" maxlength="50" value="${(prefillUsername || '').replace(/"/g, '&quot;')}" />
        <div id="forgot-error" style="color:#ff6b6b;font-size:0.82rem;margin-bottom:12px;min-height:18px;"></div>
        <button id="forgot-continue" style="${primaryBtnStyle}">Continue</button>
        <p style="margin:16px 0 0;">
          <button id="back-to-login-1" style="${linkBtnStyle}">Back to sign in</button>
        </p>
      </div>
    `;
    const unameInput = document.getElementById('forgot-username-input');
    const errEl = document.getElementById('forgot-error');
    const btn   = document.getElementById('forgot-continue');

    unameInput.focus();

    async function go() {
      const raw = unameInput.value.trim();
      if (raw.length < 2) { errEl.textContent = 'Please enter your username.'; return; }
      btn.disabled = true;
      btn.textContent = 'Looking up…';
      const res = await apiCall('get_security_question', { username: raw });
      if (!res) {
        errEl.textContent = lastApiError || 'No security question set for this username.';
        btn.disabled = false;
        btn.textContent = 'Continue';
        return;
      }
      renderForgotStep2(raw, res.security_question);
    }

    btn.addEventListener('click', go);
    unameInput.addEventListener('keydown', e => { if (e.key === 'Enter') go(); });
    document.getElementById('back-to-login-1').addEventListener('click', renderLogin);
  }

  function renderForgotStep2(username, question) {
    overlay.innerHTML = `
      <div style="${boxStyle}">
        <h2 style="color:#e8e8f0;margin:0 0 8px;font-size:1.3rem;font-weight:600;">Security question</h2>
        <p style="color:#8888aa;margin:0 0 20px;font-size:0.88rem;line-height:1.5;">
          ${(question || '').replace(/</g, '&lt;')}
        </p>
        <input id="security-answer-input" type="text" placeholder="Your answer"
          style="${inputStyle}" maxlength="200" />
        <input id="new-password-input" type="password" placeholder="New password"
          style="${inputStyle}" maxlength="100" />
        <div id="forgot2-error" style="color:#ff6b6b;font-size:0.82rem;margin-bottom:12px;min-height:18px;"></div>
        <button id="forgot2-confirm" style="${primaryBtnStyle}">Set new password</button>
        <p style="margin:16px 0 0;">
          <button id="back-to-login-2" style="${linkBtnStyle}">Back to sign in</button>
        </p>
      </div>
    `;
    const answerInput = document.getElementById('security-answer-input');
    const passInput   = document.getElementById('new-password-input');
    const errEl = document.getElementById('forgot2-error');
    const btn   = document.getElementById('forgot2-confirm');

    answerInput.focus();

    async function go() {
      const answer = answerInput.value;
      const newPass = passInput.value;
      if (!answer) { errEl.textContent = 'Please answer the security question.'; return; }
      if (!newPass || newPass.length < 4) { errEl.textContent = 'New password must be at least 4 characters.'; return; }
      btn.disabled = true;
      btn.textContent = 'Saving…';
      const res = await apiCall('reset_password', { username, security_answer: answer, new_password: newPass });
      if (!res) {
        errEl.textContent = lastApiError || 'Security answer did not match.';
        btn.disabled = false;
        btn.textContent = 'Set new password';
        return;
      }
      renderLogin();
      const errEl2 = document.getElementById('user-name-error');
      if (errEl2) errEl2.style.color = '#6cdb8f';
      if (errEl2) errEl2.textContent = 'Password updated — sign in below.';
      const nameInput2 = document.getElementById('user-name-input');
      if (nameInput2) nameInput2.value = username;
    }

    btn.addEventListener('click', go);
    [answerInput, passInput].forEach(el => el.addEventListener('keydown', e => { if (e.key === 'Enter') go(); }));
    document.getElementById('back-to-login-2').addEventListener('click', renderLogin);
  }

  document.body.appendChild(overlay);
  renderLogin();
}

/* ── MIGRATION: localStorage → file system ─────────────────── */
async function offerMigration() {
  // No server to migrate TO in offline mode — the banner would only ever
  // fail, so skip it entirely (localStorage already IS the store).
  if (isOfflineMode()) return;
  const raw = localStorage.getItem(STORAGE_KEY);
  if (!raw) return;
  try {
    const parsed = JSON.parse(raw);
    const projectCount = Object.keys(parsed.projects || {}).length;
    if (projectCount === 0) return;
  } catch(e) { return; }

  const banner = document.createElement('div');
  banner.id = 'migration-banner';
  banner.style.cssText = `
    position:fixed;bottom:20px;left:50%;transform:translateX(-50%);
    z-index:9999;background:#1a1a2e;border:1px solid #6c63ff;
    border-radius:10px;padding:16px 24px;max-width:500px;width:90%;
    box-shadow:0 8px 32px rgba(0,0,0,0.5);display:flex;
    align-items:center;gap:16px;font-family:inherit;
  `;
  banner.innerHTML = `
    <div style="flex:1">
      <div style="color:#e8e8f0;font-weight:600;font-size:0.95rem;margin-bottom:4px;">
        📦 Local data found
      </div>
      <div style="color:#8888aa;font-size:0.82rem;line-height:1.4;">
        You have projects saved in this browser. Import them to your SS_Studio profile?
      </div>
    </div>
    <div style="display:flex;gap:8px;flex-shrink:0">
      <button id="mig-skip" style="
        padding:8px 14px;background:transparent;border:1px solid #4a4a7a;
        border-radius:6px;color:#8888aa;cursor:pointer;font-size:0.85rem;font-family:inherit;
      ">Skip</button>
      <button id="mig-import" style="
        padding:8px 14px;background:#6c63ff;border:none;
        border-radius:6px;color:#fff;cursor:pointer;font-size:0.85rem;
        font-weight:600;font-family:inherit;
      ">Import</button>
    </div>
  `;
  document.body.appendChild(banner);

  document.getElementById('mig-skip').addEventListener('click', () => banner.remove());
  document.getElementById('mig-import').addEventListener('click', async () => {
    const btn = document.getElementById('mig-import');
    btn.textContent = 'Importing…';
    btn.disabled = true;
    try {
      const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY));
      const res = await apiCall('save_full_state', { state: parsed });
      if (res) {
        showToast(`Imported ${res.imported} project(s) successfully`, 'success');
        banner.remove();
        await loadStateFromServer();
        renderAll();
      } else {
        showToast('Import failed — check MAMP is running', 'error');
        btn.textContent = 'Import';
        btn.disabled = false;
      }
    } catch(e) {
      showToast('Import error', 'error');
      btn.textContent = 'Import';
      btn.disabled = false;
    }
  });
}

/* ── STORAGE ───────────────────────────────────────────────── */
// saveState() is called from many places (addProject, saveAsset,
// switchProject, etc.) without being awaited by most callers. Each call
// re-saves every project + every asset in a sequential await loop, so two
// overlapping calls can interleave their requests against the server out
// of order. We serialize calls through a single in-flight chain so each
// save fully completes (against the state at the time it was queued)
// before the next one starts — this is what prevents, e.g., a duplicate
// project ending up half-saved when the user creates/edits things in
// quick succession.
let _saveStateChain = Promise.resolve();
function saveState() {
  // Task #8 hardening (2026-06-25): this used to .catch() the error at the
  // chain level and swallow it, so callers doing `await saveState()` never
  // saw a rejection even after _saveStateNow() was changed (above) to
  // throw on a real save failure. We still need the CHAIN itself to never
  // reject — otherwise one failed save would permanently break every
  // future saveState() call, since .then() on a rejected promise never
  // runs. So the chain always resolves (logging internally), but we
  // return a SEPARATE promise to the caller that mirrors whether this
  // specific call's save actually succeeded.
  const thisCall = _saveStateChain.then(() => _saveStateNow());

  _saveStateChain = thisCall.catch(err => {
    console.error('saveState failed:', err);
  });

  return thisCall; // rejects if this call's save failed; doesn't affect the chain
}

async function _saveStateNow() {
  // 1. Always keep localStorage in sync as fallback
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); } catch(e) {}

  // 2. Save to server
  const user = getCurrentUser();
  if (!user) return;

  // Task #8 hardening (2026-06-25): apiCall() returns null on failure
  // instead of throwing, so this loop previously swallowed every server
  // error silently — callers awaiting saveState() (addProject,
  // deleteProject, renameProject, switchProject, etc.) had no way to know
  // anything went wrong, since this function never rejected. Now we
  // collect failures and throw once at the end so those callers'
  // try/catch blocks can actually surface the failure to the user instead
  // of reporting false success.
  const failures = [];
  const projects = Object.values(state.projects || {});
  for (const project of projects) {
    const { assets, shots, ...meta } = project;
    const projRes = await apiCall('save_project', { project: meta });
    if (!projRes) failures.push('project "' + (meta.name || meta.id) + '"');
    for (const asset of Object.values(assets || {})) {
      const assetRes = await apiCall('save_asset', { project_id: project.id, asset });
      if (!assetRes) failures.push('asset "' + (asset.name || asset.id) + '"');
    }
  }

  if (failures.length > 0) {
    throw new Error('Failed to save: ' + failures.join(', '));
  }
}

// Fable audit fix (2026-07-08 report, applied 2026-07-10, H3) — targeted
// save for the common case where only ONE project's own meta (name,
// created/updated timestamps) changed and nothing about its assets did.
// Mirrors the pattern saveAssetNow() (01-core.js) already uses for its
// character branch instead of firing the blanket saveState(), which
// re-uploads every asset of every project regardless of what actually
// changed. Also refreshes the localStorage mirror, same as
// _saveStateNow(), so the local fallback doesn't go stale relative to a
// real save. Callers: addProject(), renameProject() (01-core.js).
async function saveProjectMetaOnly(project) {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); } catch(e) {}
  const { assets, shots, ...meta } = project;
  const res = await apiCall('save_project', { project: meta });
  if (!res) throw new Error('Failed to save project "' + (meta.name || meta.id) + '"');
  return res;
}

async function loadStateFromServer() {
  const user = getCurrentUser();
  if (!user) return;

  // Urgent UX fix (2026-06-25): this load was previously silent — on
  // accounts with many/large assets the page sat unresponsive-looking
  // for several seconds with zero feedback. Show determinate progress
  // since both the project count and the per-project loop position are
  // known up front.
  if (typeof showProgress === 'function') showProgress('Loading library…', { pct: 0 });

  const res = await apiCall('load_projects');
  if (!res) {
    if (typeof hideProgress === 'function') hideProgress();
    return; // Fall back to localStorage
  }

  const projectList = res.projects || [];
  const total = projectList.length;

  const projects = {};
  let i = 0;
  for (const meta of projectList) {
    i++;
    if (typeof updateProgress === 'function') {
      updateProgress((i - 1) / Math.max(total, 1) * 100, `Loading "${meta.name || meta.id}"… (${i} of ${total})`);
    }
    const assetsRes = await apiCall('load_assets', { project_id: meta.id });
    const assets = {};
    (assetsRes?.assets || []).forEach(a => {
      if (!a.images) {
        a.images = defaultImageSlots(a.type);
        if (a.image) {
          const firstSlot = Object.keys(a.images)[0];
          a.images[firstSlot] = a.image;
          delete a.image;
        }
      }
      if (!a.imageAnalysis) a.imageAnalysis = {};
      assets[a.id] = a;
    });
    projects[meta.id] = { ...meta, assets };
    if (typeof updateProgress === 'function') {
      updateProgress(i / Math.max(total, 1) * 100);
    }
  }

  state.projects = projects;
  if (!state.activeProject && Object.keys(projects).length > 0) {
    state.activeProject = Object.keys(projects)[0];
  }

  if (typeof hideProgress === 'function') hideProgress();
}

function loadState() {
  // Synchronous localStorage load (instant UI before async server load)
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const loaded = JSON.parse(raw);
      state = { ...state, ...loaded };
      Object.values(state.projects || {}).forEach(p => {
        Object.values(p.assets || {}).forEach(a => {
          if (!a.images) {
            a.images = defaultImageSlots(a.type);
            if (a.image) {
              const firstSlot = Object.keys(a.images)[0];
              a.images[firstSlot] = a.image;
              delete a.image;
            }
          }
          if (!a.imageAnalysis) a.imageAnalysis = {};
        });
      });
    }
  } catch(e) {
    console.warn('Could not load saved state:', e);
  }
}

/* ── INIT ───────────────────────────────────────────────────── */
(async function init() {
  // 1. Load localStorage immediately so UI isn't blank
  loadState();
  if (!state.activeProject && Object.keys(state.projects).length > 0) {
    state.activeProject = Object.keys(state.projects)[0];
  }
  renderAll();
  loadSettingsToUI();

  // Pull shared/global custom chip vocabulary (added by any user) from the server.
  if (typeof syncCustomChipsFromServer === 'function') {
    syncCustomChipsFromServer().then(() => {
      // Re-render persisted custom chips now that the shared list has arrived,
      // in case Single Frame was already initialised before this resolved.
      if (typeof initStaticChipAdders === 'function' && document.getElementById('sf-angle-chips')) {
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
    });
  }

  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') {
      ['asset-modal-overlay', 'project-modal-overlay', 'settings-modal-overlay'].forEach(closeModal);
      closeConfirm();
    }
  });

  // 2. Check for user identity
  const user = getCurrentUser();
  if (user) updateUserChip(user);

  // Legacy accounts created before password login existed have a username
  // saved locally but no password set on the server. Force a one-time
  // re-prompt for those so every account ends up secured.
  let needsPasswordSetup = false;
  if (user) {
    const statusRes = await apiCall('check_password_status', { username: user });
    // If the server can't be reached, fail open (don't lock the user out
    // of their own app over a dropped connection) — they'll be re-checked
    // next time they load the app.
    needsPasswordSetup = !!(statusRes && statusRes.has_password === false);
  }

  if (!user || needsPasswordSetup) {
    showUserPrompt(async () => {
      await loadStateFromServer();
      renderAll();
      offerMigration();
      if (typeof refreshSponsorStatus === 'function') refreshSponsorStatus();
      if (typeof tourMaybeAutoLaunch === 'function') tourMaybeAutoLaunch();
    }, { forcedSetupUsername: needsPasswordSetup ? user : null });
  } else {
    await loadStateFromServer();
    renderAll();
    offerMigration();
    // Sponsor status needs the in-memory password, which only exists this
    // session if the user just logged in via showUserPrompt above — for a
    // page reload with an existing session we have no password yet, so this
    // will simply cache "no sponsor" until they next log in. Acceptable
    // trade-off for never persisting the password to storage.
    if (typeof refreshSponsorStatus === 'function') refreshSponsorStatus();
    if (typeof tourMaybeAutoLaunch === 'function') tourMaybeAutoLaunch();
  }
})();
