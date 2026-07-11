/* ══════════════════════════════════════════════════════════════
   PROGRESS OVERLAY  (urgent UX fix — 2026-06-25)
   ─────────────────────────────────────────────────────────────
   Three places in the app run multi-step async work with zero
   visible feedback beyond a static "Analysing…" label or nothing
   at all: loading the asset library on page refresh
   (loadStateFromServer in 00-api.js), saving an asset with heavy
   photo payloads (saveAssetNow/saveSharedLibraryAsset in
   01-core.js), and AI image analysis (runSlotAnalysis/
   batchAnalyseAllSlots in 09-image-analyser.js). The user reported
   being "clueless whether the process is happening or not" during
   all three.

   This module is a single, reusable progress overlay:
     showProgress(label, opts)      — opens the overlay
     updateProgress(pct, label)     — updates the bar + label
     hideProgress()                 — closes it

   Determinate mode (a known step count, e.g. "asset 3 of 12") shows
   a real percentage. Indeterminate mode (single unknown-duration
   call, e.g. one save_asset request) shows an animated sweeping bar
   with no percentage claim, since we have no way to estimate real
   progress for a single network round-trip — a fabricated percentage
   would be worse than an honest "working…" indicator.

   No dependency on any other file — pure DOM, injected on first use.
   ══════════════════════════════════════════════════════════════ */

let _progressEl = null;
let _progressBarEl = null;
let _progressLabelEl = null;
let _progressPctEl = null;
let _progressShowTimer = null;

function _ensureProgressEl() {
  if (_progressEl) return;

  // Styling fix (2026-06-25): originally a large centered modal in a
  // purple/indigo palette that clashed with the app's cream/amber/charcoal
  // theme. Now a small, non-blocking pill docked in the top-right corner,
  // styled with the app's own CSS variables (--cream, --amber, --ink, etc.)
  // so it always matches whatever the theme currently is rather than a
  // hardcoded color that can drift out of sync.
  const overlay = document.createElement('div');
  overlay.id = 'progress-overlay';
  overlay.style.cssText = `
    position:fixed;top:18px;right:18px;z-index:99998;
    font-family:inherit;
    opacity:0;pointer-events:none;
    transform:translateY(-6px);
    transition:opacity 0.15s ease, transform 0.15s ease;
  `;

  const box = document.createElement('div');
  box.style.cssText = `
    background:var(--cream, #FAF7F2);
    border:1px solid var(--border, #D8D0C4);
    border-radius:var(--radius, 8px);
    padding:10px 14px;min-width:200px;max-width:260px;
    box-shadow:var(--shadow-lg, 0 4px 20px rgba(30,28,24,0.12));
  `;

  const label = document.createElement('div');
  label.id = 'progress-label';
  label.style.cssText = `
    color:var(--ink, #2D2A24);font-size:0.78rem;font-weight:600;
    margin-bottom:6px;line-height:1.35;
    white-space:nowrap;overflow:hidden;text-overflow:ellipsis;
  `;
  label.textContent = 'Working…';

  const track = document.createElement('div');
  track.style.cssText = `
    background:var(--cream-dark, #E8E0D4);border-radius:4px;
    height:5px;width:100%;overflow:hidden;position:relative;
  `;

  const bar = document.createElement('div');
  bar.id = 'progress-bar';
  bar.style.cssText = `
    background:var(--amber, #C8860A);
    height:100%;width:0%;border-radius:4px;
    transition:width 0.25s ease;
  `;
  track.appendChild(bar);

  const pct = document.createElement('div');
  pct.id = 'progress-pct';
  pct.style.cssText = `
    color:var(--ink-lt, #8C8478);font-size:0.68rem;margin-top:5px;
  `;
  pct.textContent = '';

  box.appendChild(label);
  box.appendChild(track);
  box.appendChild(pct);
  overlay.appendChild(box);
  document.body.appendChild(overlay);

  _progressEl = overlay;
  _progressBarEl = bar;
  _progressLabelEl = label;
  _progressPctEl = pct;
}

/* Determinate: pass opts.pct (0-100). Indeterminate: omit opts.pct —
   the bar sweeps back and forth via CSS animation instead of a fixed
   width, and the percentage text is left blank rather than guessed. */
function showProgress(label, opts = {}) {
  _ensureProgressEl();
  clearTimeout(_progressShowTimer);

  _progressLabelEl.textContent = label || 'Working…';

  if (typeof opts.pct === 'number') {
    _progressBarEl.style.animation = 'none';
    _progressBarEl.style.width = Math.max(0, Math.min(100, opts.pct)) + '%';
    _progressPctEl.textContent = Math.round(opts.pct) + '%';
  } else {
    // Indeterminate sweep — inject the keyframes once, lazily.
    if (!document.getElementById('progress-sweep-keyframes')) {
      const style = document.createElement('style');
      style.id = 'progress-sweep-keyframes';
      style.textContent = `
        @keyframes progressSweep {
          0%   { width: 8%;  margin-left: 0%; }
          50%  { width: 60%; margin-left: 40%; }
          100% { width: 8%;  margin-left: 92%; }
        }
      `;
      document.head.appendChild(style);
    }
    _progressBarEl.style.width = '8%';
    _progressBarEl.style.marginLeft = '0%';
    _progressBarEl.style.animation = 'progressSweep 1.4s ease-in-out infinite';
    _progressPctEl.textContent = '';
  }

  _progressEl.style.opacity = '1';
  _progressEl.style.transform = 'translateY(0)';
  _progressEl.style.pointerEvents = 'auto';
}

/* Update an already-open overlay's label and/or percentage without the
   open/close flicker — used inside loops (asset N of M, panel N of M). */
function updateProgress(pct, label) {
  if (!_progressEl) return;
  if (typeof label === 'string') _progressLabelEl.textContent = label;
  if (typeof pct === 'number') {
    _progressBarEl.style.animation = 'none';
    _progressBarEl.style.marginLeft = '0%';
    _progressBarEl.style.width = Math.max(0, Math.min(100, pct)) + '%';
    _progressPctEl.textContent = Math.round(pct) + '%';
  }
}

function hideProgress() {
  if (!_progressEl) return;
  _progressEl.style.opacity = '0';
  _progressEl.style.transform = 'translateY(-6px)';
  _progressEl.style.pointerEvents = 'none';
  // Reset bar state so the next open doesn't flash the previous run's
  // leftover width/animation for a frame before showProgress() re-sets it.
  _progressShowTimer = setTimeout(() => {
    if (_progressBarEl) {
      _progressBarEl.style.animation = 'none';
      _progressBarEl.style.width = '0%';
      _progressBarEl.style.marginLeft = '0%';
    }
    if (_progressPctEl) _progressPctEl.textContent = '';
  }, 200);
}
