/* ============================================================
   SS_Studio v7 — 10-sequences.js
   Sequences hierarchy: Project → Sequence → Shots
   Each "shot" is a saved prompt from Single Frame or Storyboard.
   ============================================================ */

/* ── SEQUENCES STATE ─────────────────────────────────────── */
const seqState = {
  sequences: {},       // { [seqId]: { ...meta, shots: { [shotId]: {...} } } }
  activeSeqId: null,
  loadedForProject: null  // projectId this session's seqState.sequences was last loaded for, or null if never loaded
};

/* ── HELPERS ─────────────────────────────────────────────── */
function getActiveProjectId() {
  return state.activeProject || null;
}

function seqById(id) {
  return seqState.sequences[id] || null;
}

/* ── LOAD SEQUENCES FROM SERVER ──────────────────────────── */
async function loadSequences() {
  const projectId = getActiveProjectId();
  if (!projectId) return;

  const res = await apiCall('load_sequences', { project_id: projectId });
  if (!res) return;

  seqState.sequences = {};
  for (const seq of res.sequences || []) {
    seqState.sequences[seq.id] = { ...seq, shots: {} };
    // Load shots for each sequence
    const shotsRes = await apiCall('load_sequence_shots', {
      project_id: projectId,
      sequence_id: seq.id
    });
    (shotsRes?.shots || []).forEach(shot => {
      seqState.sequences[seq.id].shots[shot.id] = shot;
    });
  }
  seqState.loadedForProject = projectId;
  renderSequencesView();
}

/* ── ENSURE SEQUENCES LOADED (bug fix 2026-06-29) ────────────
   openSaveToSequenceModal() used to read seqState.sequences directly,
   but that cache is only populated once the user visits the Sequences
   tab (initSequencesView() -> loadSequences()). Saving a shot from
   Storyboard/Single Frame BEFORE ever opening the Sequences tab in a
   session meant the modal's dropdown showed zero existing sequences —
   even though sequences existed on the server — forcing the user into
   creating a duplicate "new sequence" every time. Confirmed via live
   testing: opening the Sequences tab afterward showed everything
   correctly (old + new), so this was a stale-cache/lazy-load timing
   bug, not actual data loss.
   This helper loads on demand, once per active project per session —
   re-checks loadedForProject so switching projects re-fetches, but
   repeated saves within the same project don't re-fetch every time. */
async function ensureSequencesLoaded() {
  const projectId = getActiveProjectId();
  if (!projectId) return;
  if (seqState.loadedForProject === projectId) return; // already loaded this session
  await loadSequences();
}

/* ── SAVE SEQUENCE ───────────────────────────────────────── */
async function saveSequence(seqData) {
  const projectId = getActiveProjectId();
  if (!projectId) return null;
  const res = await apiCall('save_sequence', { project_id: projectId, sequence: seqData });
  if (!res) return null;
  const seq = res.sequence;
  if (!seqState.sequences[seq.id]) seqState.sequences[seq.id] = { ...seq, shots: {} };
  else Object.assign(seqState.sequences[seq.id], seq);
  renderSequencesView();
  return seq;
}

/* ── DELETE SEQUENCE ─────────────────────────────────────── */
async function deleteSequence(seqId) {
  const projectId = getActiveProjectId();
  if (!projectId) return;
  const ok = await apiCall('delete_sequence', { project_id: projectId, sequence_id: seqId });
  if (ok) {
    delete seqState.sequences[seqId];
    if (seqState.activeSeqId === seqId) seqState.activeSeqId = null;
    renderSequencesView();
  }
}

/* ── SAVE SHOT TO SEQUENCE ───────────────────────────────── */
async function saveSequenceShot(seqId, shotData) {
  const projectId = getActiveProjectId();
  if (!projectId) return null;
  const res = await apiCall('save_sequence_shot', {
    project_id: projectId,
    sequence_id: seqId,
    shot: shotData
  });
  if (!res) return null;
  const shot = res.shot;
  if (!seqState.sequences[seqId]) return null;
  seqState.sequences[seqId].shots[shot.id] = shot;
  renderSequencesView();
  return shot;
}

/* ── DELETE SHOT ─────────────────────────────────────────── */
async function deleteSequenceShot(seqId, shotId) {
  const projectId = getActiveProjectId();
  if (!projectId) return;
  await apiCall('delete_sequence_shot', {
    project_id: projectId,
    sequence_id: seqId,
    shot_id: shotId
  });
  if (seqState.sequences[seqId]) {
    delete seqState.sequences[seqId].shots[shotId];
    renderSequencesView();
  }
}

/* ── SAVE TO SEQUENCE MODAL ──────────────────────────────── */
async function openSaveToSequenceModal(promptText, promptMeta = {}, defaultLabel = '') {
  if (!getActiveProjectId()) {
    showToast('Select a project first', 'error');
    return;
  }

  // Bug fix 2026-06-29: make sure existing sequences are actually loaded
  // before building the dropdown below — see ensureSequencesLoaded() for
  // the full story. Without this, the dropdown was empty (forcing a
  // duplicate "new sequence" every time) whenever the user hadn't yet
  // visited the Sequences tab this session. Only toast on the actual
  // fetch (first save of the session) — cached repeat saves are instant
  // and silent, no need to interrupt with a toast every time.
  const needsFetch = seqState.loadedForProject !== getActiveProjectId();
  if (needsFetch && typeof showToast === 'function') showToast('Loading sequences…', '');
  await ensureSequencesLoaded();

  const existing = Object.values(seqState.sequences);
  const seqOptions = existing.map(s =>
    `<option value="${s.id}">${escHtml(s.name)}</option>`
  ).join('');

  const overlay = document.createElement('div');
  overlay.id = 'save-to-seq-overlay';
  overlay.style.cssText = `
    position:fixed;inset:0;z-index:99998;
    background:rgba(0,0,0,0.75);
    display:flex;align-items:center;justify-content:center;
    font-family:inherit;
  `;

  overlay.innerHTML = `
    <div style="
      background:#1a1a2e;border:1px solid #3d3d6b;border-radius:12px;
      padding:32px 36px;max-width:480px;width:92%;
      box-shadow:0 24px 64px rgba(0,0,0,0.6);
    ">
      <h3 style="color:#e8e8f0;margin:0 0 20px;font-size:1.15rem;font-weight:600;">
        💾 Save Shot to Sequence
      </h3>

      <div style="margin-bottom:16px;">
        <label style="color:#8888aa;font-size:0.82rem;display:block;margin-bottom:6px;">
          SHOT LABEL ${promptMeta.source === 'storyboard' ? '(storyboard name)' : '(optional)'}
        </label>
        <input id="stq-shot-label" type="text"
          placeholder="${promptMeta.source === 'storyboard' ? 'e.g. Act 1 — The Arrival' : 'e.g. Hero entrance — wide'}"
          value="${escHtml(defaultLabel)}"
          style="
            width:100%;box-sizing:border-box;padding:10px 14px;
            background:#0d0d1a;border:1px solid #4a4a7a;border-radius:7px;
            color:#e8e8f0;font-size:0.9rem;outline:none;font-family:inherit;
          "
          maxlength="120"
        />
      </div>

      <div style="margin-bottom:16px;">
        <label style="color:#8888aa;font-size:0.82rem;display:block;margin-bottom:6px;">
          SEQUENCE
        </label>
        <div style="display:flex;gap:8px;align-items:center;">
          <select id="stq-seq-select" style="
            flex:1;padding:10px 14px;
            background:#0d0d1a;border:1px solid #4a4a7a;border-radius:7px;
            color:#e8e8f0;font-size:0.9rem;outline:none;font-family:inherit;
          ">
            ${existing.length ? seqOptions : ''}
            <option value="__new__">＋ New sequence…</option>
          </select>
        </div>
      </div>

      <div id="stq-new-seq-wrap" style="margin-bottom:16px;display:${existing.length ? 'none' : ''};">
        <label style="color:#8888aa;font-size:0.82rem;display:block;margin-bottom:6px;">
          NEW SEQUENCE NAME
        </label>
        <input id="stq-new-seq-name" type="text" placeholder="e.g. Act 1 — Chase"
          style="
            width:100%;box-sizing:border-box;padding:10px 14px;
            background:#0d0d1a;border:1px solid #4a4a7a;border-radius:7px;
            color:#e8e8f0;font-size:0.9rem;outline:none;font-family:inherit;
          "
          maxlength="80"
        />
      </div>

      <div style="
        background:#0d0d1a;border:1px solid #2a2a4a;border-radius:7px;
        padding:10px 14px;margin-bottom:20px;
        color:#6666aa;font-size:0.78rem;line-height:1.6;
        max-height:100px;overflow-y:auto;
      ">
        ${promptMeta.source === 'storyboard' && promptMeta.panelCount
          ? `<span style="color:#f5a623;font-weight:600;">🎞 ${promptMeta.panelCount}-panel storyboard</span><br>${escHtml(promptText.substring(0, 300))}${promptText.length > 300 ? '…' : ''}`
          : `${escHtml(promptText.substring(0, 220))}${promptText.length > 220 ? '…' : ''}`
        }
      </div>

      <div style="display:flex;gap:10px;justify-content:flex-end;">
        <button id="stq-cancel" style="
          padding:9px 18px;background:transparent;border:1px solid #4a4a7a;
          border-radius:7px;color:#8888aa;cursor:pointer;font-size:0.9rem;font-family:inherit;
        ">Cancel</button>
        <button id="stq-save" style="
          padding:9px 22px;background:#f5a623;border:none;
          border-radius:7px;color:#1a1a2e;cursor:pointer;font-size:0.9rem;
          font-weight:700;font-family:inherit;
        ">Save Shot</button>
      </div>
    </div>
  `;

  document.body.appendChild(overlay);

  const selectEl  = document.getElementById('stq-seq-select');
  const newWrap   = document.getElementById('stq-new-seq-wrap');
  const newNameEl = document.getElementById('stq-new-seq-name');

  selectEl.addEventListener('change', () => {
    newWrap.style.display = selectEl.value === '__new__' ? '' : 'none';
    if (selectEl.value === '__new__') newNameEl.focus();
  });

  // If no sequences exist, pre-select __new__
  if (!existing.length) {
    selectEl.value = '__new__';
    newWrap.style.display = '';
  }

  document.getElementById('stq-cancel').addEventListener('click', () => overlay.remove());

  document.getElementById('stq-save').addEventListener('click', async () => {
    const btn = document.getElementById('stq-save');
    let seqId = selectEl.value;

    if (seqId === '__new__') {
      const newName = newNameEl.value.trim();
      if (!newName) { newNameEl.focus(); return; }
      btn.disabled = true;
      btn.textContent = 'Saving…';
      const newSeq = await saveSequence({ name: newName });
      if (!newSeq) {
        showToast('Could not create sequence', 'error');
        btn.disabled = false; btn.textContent = 'Save Shot';
        return;
      }
      seqId = newSeq.id;
    }

    const label = document.getElementById('stq-shot-label').value.trim();
    const shot = {
      label: label || promptText.substring(0, 80),
      prompt: promptText,
      meta: promptMeta,
      source: promptMeta.source || 'single_frame'
    };

    btn.disabled = true;
    btn.textContent = 'Saving…';
    const saved = await saveSequenceShot(seqId, shot);
    overlay.remove();

    if (saved) {
      showToast('Shot saved to sequence ✓', 'success');
      // Current Storyboard state now matches what was just persisted — see
      // sbState.dirty comment (03-storyboard.js), development-practices.md §5.
      if (promptMeta.source === 'storyboard' && typeof sbState !== 'undefined') sbState.dirty = false;
      // Switch to sequences tab to show result
      switchView('sequences');
    } else {
      showToast('Could not save shot', 'error');
    }
  });

  overlay.addEventListener('click', e => {
    if (e.target === overlay) overlay.remove();
  });
}

function escHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/* ── RENDER SEQUENCES VIEW ───────────────────────────────── */
function renderSequencesView() {
  const container = document.getElementById('sequences-view-inner');
  if (!container) return;

  const projectId = getActiveProjectId();
  const project = projectId ? (state.projects || {})[projectId] : null;

  if (!project) {
    container.innerHTML = `
      <div class="seq-empty-state">
        <div class="seq-empty-icon">🎞</div>
        <p>Select a project to view sequences.</p>
      </div>`;
    return;
  }

  const seqs = Object.values(seqState.sequences);

  let html = `
    <div class="seq-header-bar">
      <div class="seq-project-label">
        <span class="seq-project-icon">📁</span>
        ${escHtml(project.name || projectId)}
      </div>
      <button class="seq-new-btn" onclick="openNewSequenceModal()">＋ New Sequence</button>
    </div>
  `;

  if (!seqs.length) {
    html += `
      <div class="seq-empty-state">
        <div class="seq-empty-icon">🎬</div>
        <p>No sequences yet.</p>
        <p style="font-size:0.85rem;color:#555577;margin-top:4px;">
          Build a prompt in Single Frame or Storyboard, then click <strong>Save to Sequence</strong>.
        </p>
      </div>`;
  } else {
    seqs.sort((a, b) => (a.created || 0) - (b.created || 0));
    seqs.forEach(seq => {
      const shots = Object.values(seq.shots || {})
        .sort((a, b) => (a.created || 0) - (b.created || 0));
      const isOpen = seqState.activeSeqId === seq.id;

      html += `
        <div class="seq-card ${isOpen ? 'seq-card--open' : ''}">
          <div class="seq-card-header" onclick="toggleSequence('${seq.id}')">
            <div class="seq-card-title">
              <span class="seq-chevron">${isOpen ? '▲' : '▼'}</span>
              <span class="seq-icon">🎞</span>
              <span>${escHtml(seq.name)}</span>
              <span class="seq-shot-count">${shots.length} shot${shots.length !== 1 ? 's' : ''}</span>
            </div>
            <div class="seq-card-actions" onclick="event.stopPropagation()">
              <button class="seq-action-btn seq-delete-btn" title="Delete sequence"
                onclick="confirmDeleteSequence('${seq.id}', '${escHtml(seq.name)}')">🗑 Delete</button>
            </div>
          </div>

          ${isOpen ? `
          <div class="seq-shots-list">
            ${shots.length ? shots.map(shot => {
              // Store shot data in a registry so onclick handlers can retrieve it safely
              seqState._shotRegistry = seqState._shotRegistry || {};
              seqState._shotRegistry[shot.id] = shot;
              const isSB = shot.source === 'storyboard';
              const meta = shot.meta || {};
              const panelCount = meta.panelCount || 0;

              // Preview: storyboard shows panel list, single frame shows prompt
              let previewHtml;
              if (isSB && meta.sbSnapshot?.panels?.length) {
                const panels = meta.sbSnapshot.panels.slice(0, 4);
                previewHtml = panels.map((p, i) =>
                  `<div class="shot-panel-row"><span class="shot-panel-num">${i + 1}</span><span class="shot-panel-shot">${escHtml(p.shotType || '')}</span><span class="shot-panel-text">${escHtml((p.prompt || '').substring(0, 80))}${(p.prompt||'').length > 80 ? '…' : ''}</span></div>`
                ).join('');
                if (meta.sbSnapshot.panels.length > 4) {
                  previewHtml += `<div style="color:var(--ink-subtle);font-size:0.72rem;margin-top:4px;">+${meta.sbSnapshot.panels.length - 4} more panels</div>`;
                }
              } else {
                const preview = (shot.prompt || '').substring(0, 160);
                previewHtml = escHtml(preview) + ((shot.prompt||'').length > 160 ? '…' : '');
              }

              const loadFn = isSB ? `loadShotToStoryboard('${shot.id}')` : `loadShotToSingleFrame('${shot.id}')`;
              const loadTitle = isSB ? 'Load into Storyboard' : 'Load into Single Frame';

              return `
              <div class="shot-card ${isSB ? 'shot-card--storyboard' : ''}" id="shot-${shot.id}">
                <div class="shot-card-top">
                  <span class="shot-label">${escHtml(shot.label || 'Untitled shot')}</span>
                  <div class="shot-card-actions">
                    <button class="shot-action-btn shot-load-btn" title="${loadTitle}"
                      onclick="${loadFn}">
                      ↩ Load
                    </button>
                    <button class="shot-action-btn shot-copy-btn" title="Copy prompt"
                      onclick="copyPromptFromRegistry('${shot.id}')">
                      📋
                    </button>
                    <button class="shot-action-btn" title="Delete shot"
                      onclick="confirmDeleteShot('${seq.id}', '${shot.id}')">✕</button>
                  </div>
                </div>
                <div class="shot-prompt-preview ${isSB ? 'shot-prompt-preview--sb' : ''}">${previewHtml}</div>
                <div class="shot-meta">
                  <span class="shot-source-tag">${isSB ? `🎞 ${panelCount} panels` : escHtml(shot.source || 'single_frame')}</span>
                  <span class="shot-date">${formatSeqDate(shot.created)}</span>
                </div>
              </div>
            `}).join('') : `
              <div class="seq-shots-empty">No shots yet — save a prompt here from Single Frame or Storyboard.</div>
            `}
          </div>
          ` : ''}
        </div>
      `;
    });
  }

  container.innerHTML = html;
}

/* ── TOGGLE SEQUENCE OPEN/CLOSED ─────────────────────────── */
function toggleSequence(seqId) {
  seqState.activeSeqId = seqState.activeSeqId === seqId ? null : seqId;
  renderSequencesView();
}

/* ── NEW SEQUENCE MODAL ──────────────────────────────────── */
function openNewSequenceModal() {
  if (!getActiveProjectId()) { showToast('Select a project first', 'error'); return; }

  const overlay = document.createElement('div');
  overlay.id = 'new-seq-overlay';
  overlay.style.cssText = `
    position:fixed;inset:0;z-index:99998;
    background:rgba(0,0,0,0.75);
    display:flex;align-items:center;justify-content:center;
    font-family:inherit;
  `;
  overlay.innerHTML = `
    <div style="
      background:#1a1a2e;border:1px solid #3d3d6b;border-radius:12px;
      padding:32px 36px;max-width:420px;width:90%;
      box-shadow:0 24px 64px rgba(0,0,0,0.6);
    ">
      <h3 style="color:#e8e8f0;margin:0 0 18px;font-size:1.1rem;font-weight:600;">New Sequence</h3>
      <input id="new-seq-name" type="text" placeholder="e.g. Act 1 — The Heist"
        style="
          width:100%;box-sizing:border-box;padding:11px 14px;
          background:#0d0d1a;border:1px solid #4a4a7a;border-radius:7px;
          color:#e8e8f0;font-size:0.95rem;outline:none;font-family:inherit;
          margin-bottom:18px;
        "
        maxlength="80"
      />
      <div style="display:flex;gap:10px;justify-content:flex-end;">
        <button onclick="document.getElementById('new-seq-overlay').remove()" style="
          padding:9px 18px;background:transparent;border:1px solid #4a4a7a;
          border-radius:7px;color:#8888aa;cursor:pointer;font-size:0.9rem;font-family:inherit;
        ">Cancel</button>
        <button id="new-seq-confirm" style="
          padding:9px 22px;background:#6c63ff;border:none;
          border-radius:7px;color:#fff;cursor:pointer;font-size:0.9rem;
          font-weight:700;font-family:inherit;
        ">Create</button>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);

  const input = document.getElementById('new-seq-name');
  const btn   = document.getElementById('new-seq-confirm');
  input.focus();

  async function doCreate() {
    const name = input.value.trim();
    if (!name) { input.focus(); return; }
    btn.disabled = true;
    btn.textContent = 'Creating…';
    const seq = await saveSequence({ name });
    overlay.remove();
    if (seq) {
      seqState.activeSeqId = seq.id;
      renderSequencesView();
      showToast('Sequence created', 'success');
    } else {
      showToast('Could not create sequence', 'error');
    }
  }

  btn.addEventListener('click', doCreate);
  input.addEventListener('keydown', e => { if (e.key === 'Enter') doCreate(); });
  overlay.addEventListener('click', e => { if (e.target === overlay) overlay.remove(); });
}

/* ── CONFIRM DELETE HELPERS ──────────────────────────────── */
function confirmDeleteSequence(seqId, name) {
  if (!confirm(`Delete sequence "${name}" and all its shots? This cannot be undone.`)) return;
  deleteSequence(seqId);
}

function confirmDeleteShot(seqId, shotId) {
  if (!confirm('Delete this shot? This cannot be undone.')) return;
  deleteSequenceShot(seqId, shotId);
}

/* ── COPY PROMPT ─────────────────────────────────────────── */
function copyPromptFromRegistry(shotId) {
  const shot = (seqState._shotRegistry || {})[shotId];
  if (!shot || !shot.prompt) { showToast('No prompt to copy', 'error'); return; }
  navigator.clipboard.writeText(shot.prompt).then(() => {
    showToast('Prompt copied', 'success');
    const btn = document.querySelector(`#shot-${shotId} .shot-copy-btn`);
    if (btn) { btn.textContent = '✓'; setTimeout(() => { btn.textContent = '📋'; }, 1500); }
  }).catch(() => showToast('Could not copy', 'error'));
}

/* ── LOAD SHOT INTO SINGLE FRAME ─────────────────────────── */
function loadShotToSingleFrame(shotId) {
  const shot = (seqState._shotRegistry || {})[shotId];
  if (!shot) { showToast('Shot not found', 'error'); return; }

  // Warn if Single Frame has unsaved work
  const sfHasWork = sfStateHasWork();
  if (sfHasWork) {
    const proceed = confirm(
      'Loading this shot will replace your current Single Frame settings.\n\nAny unsaved work there will be lost. Continue?'
    );
    if (!proceed) return;
  }

  // Restore settings and switch view
  if (typeof restoreSFFromShot === 'function') {
    restoreSFFromShot(shot.meta || {});
  }
  switchView('single');
  showToast('Shot loaded into Single Frame', 'success');
}

function sfStateHasWork() {
  // Returns true if the user has made selections in Single Frame
  if (typeof sfState === 'undefined') return false;
  return !!(sfState.genre || sfState.freeText?.subject || sfState.frame ||
            sfState.selections?.angle?.length || sfState.selections?.lighting?.length);
}

/* ── LOAD STORYBOARD SHOT ────────────────────────────────── */
function loadShotToStoryboard(shotId) {
  const shot = (seqState._shotRegistry || {})[shotId];
  if (!shot) { showToast('Shot not found', 'error'); return; }
  const snap = shot.meta?.sbSnapshot;
  if (!snap) { showToast('No storyboard snapshot in this shot', 'warning'); return; }

  // Warn if storyboard has unsaved panels
  const sbHasWork = typeof sbState !== 'undefined' && sbState.panels?.length > 0;
  if (sbHasWork) {
    const proceed = confirm(
      'Loading this storyboard will replace your current panels.\n\nAny unsaved work will be lost. Continue?'
    );
    if (!proceed) return;
  }

  // Restore sbState from snapshot
  sbState.panelCount     = snap.panelCount     || 4;
  sbState.platform       = snap.platform       || 'nb';
  sbState.aspectRatio    = snap.aspectRatio    || '16:9';
  sbState.selectedAssets = snap.selectedAssets ? { ...snap.selectedAssets } : {};
  sbState.panels         = snap.panels         ? snap.panels.map(p => ({ ...p })) : [];
  sbState.storyText      = snap.storyText      || '';
  sbState.style          = snap.style          || '';
  sbState.colour         = snap.colour         || '';
  sbState.camera         = snap.camera         || '';
  // Just-restored from a saved snapshot — matches persisted state, not dirty.
  sbState.dirty          = false;

  // Switch to storyboard and show panels
  switchView('storyboard');

  // Show step2 (panels), hide step1 (input)
  const step1 = document.getElementById('sb-step1');
  const step2 = document.getElementById('sb-step2');
  if (step1) step1.style.display = 'none';
  if (step2) step2.style.display = '';

  // Restore story text input
  const storyEl = document.getElementById('sb-story-text');
  if (storyEl) storyEl.value = sbState.storyText;

  // Re-render panels
  if (typeof renderPanels === 'function') renderPanels();

  showToast('Storyboard loaded ✓', 'success');
}

/* ── DATE FORMAT ─────────────────────────────────────────── */
function formatSeqDate(ts) {
  if (!ts) return '';
  const d = new Date(ts * 1000);
  return d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
}

/* ── INIT SEQUENCES VIEW ─────────────────────────────────── */
// Fable audit fix (2026-07-08 report, applied 2026-07-10, M2) — this used
// to call loadSequences() unconditionally, meaning every single Sequences
// tab click re-fetched every sequence + every sequence's shots from
// scratch (N+1 round trips), even when nothing had changed since the last
// visit. ensureSequencesLoaded() (above) already existed specifically to
// gate this per-project-per-session, same pattern already correctly used
// by ensureShotSetupsLoaded() (14-shot-setup.js) — this just wires the
// existing guard in here too. A cache-hit is a safe no-op: switchView()
// (01-core.js) only toggles the .active CSS class, it never clears
// #view-sequences' DOM, so the last renderSequencesView() output stays
// correct and visible without needing a fresh render.
function initSequencesView() {
  ensureSequencesLoaded();
}
