/* ─────────────────────────────────────────────────────────────
   GUIDED TOUR — plain-language first-run walkthrough
   Audience: complete beginners, no design/AI vocabulary assumed.
   8 steps, Next/Skip only. Auto-launches once, on a genuinely
   fresh install (zero projects). Always replayable via the
   "Help" button in the header.
   ───────────────────────────────────────────────────────────── */

const TOUR_SEEN_KEY = 'SS_Studio_tour_seen';

const TOUR_STEPS = [
  {
    target: null, // welcome — centered, no spotlight
    title: "Welcome to SceneSmith Studio",
    body: "Let's make your first image. This will only take a minute.",
  },
  {
    target: '#btn-manage-projects',
    title: "Step 1 — Start a Project",
    body: "Everything you make lives inside a Project. Click here, then “+ Create Project”, to start one.",
    // Previously auto-opened the project-manager dialog via
    // openProjectManager(true) at the same time as spotlighting this
    // button — the dialog's own backdrop-filter: blur(2px) then visibly
    // blurred the very button the spotlight was highlighting underneath
    // it. Removed the auto-open so the user genuinely clicks the
    // spotlighted button themselves, matching how every other tour step
    // already works. Fixed 2026-06-30.
  },
  {
    target: '[data-view="library"]',
    title: "Your Library",
    body: "Here you can save your characters and places, so you don't have to describe them every time.",
    onEnter: () => { try { switchView('library'); } catch(e) {} },
  },
  {
    target: '[data-view="single"]',
    title: "Step 2 — Make a Picture",
    body: "This is where you build one picture at a time. Let's give it a try.",
    onEnter: () => { try { switchView('single'); } catch(e) {} },
  },
  {
    target: '#sf-subject-text',
    title: "Describe what's happening",
    body: "Type what's happening in the picture. For example: “a man standing on a hill at sunset.”",
  },
  {
    target: '#sf-frame-cards',
    title: "Choose how close-up",
    body: "Pick how close the picture should be — just a face, or the whole scene.",
  },
  {
    target: '#sf-copy-btn',
    title: "Step 3 — Copy your picture's description",
    body: "Click here to copy your finished description. Paste it into the AI image tool you're using, like Midjourney.",
  },
  {
    target: null, // closing — centered, no spotlight
    title: "You're ready!",
    body: "That's it — you're ready to make your first picture. Click “Help” any time to see this again, or to learn about Storyboards and Settings later.",
  },
];

let _tourIndex = 0;
let _tourActive = false;

function tourHasSeenBefore() {
  try { return localStorage.getItem(TOUR_SEEN_KEY) === 'true'; }
  catch(e) { return true; } // fail safe: don't force a tour if storage is broken
}

function tourMarkSeen() {
  try { localStorage.setItem(TOUR_SEEN_KEY, 'true'); } catch(e) {}
}

/* Called once from 00-api.js init(), after state has loaded, to decide
   whether this is a genuinely fresh install (no projects yet). Only
   auto-launches for brand-new users — never re-triggers for existing
   users just because the app updated. */
function tourMaybeAutoLaunch() {
  if (tourHasSeenBefore()) return;
  const hasProjects = state && state.projects && Object.keys(state.projects).length > 0;
  if (hasProjects) {
    // Existing user from before this feature shipped — don't surprise them.
    tourMarkSeen();
    return;
  }
  setTimeout(() => startTour(), 600); // small delay so the page has settled
}

function startTour() {
  if (_tourActive) return;
  // Close any modal left open from earlier use before laying the tour's
  // spotlight overlay on top of it — avoids the same blur/flicker bug
  // this guards against in endTour() below.
  document.querySelectorAll('.modal-overlay.open').forEach(el => el.classList.remove('open'));
  _tourActive = true;
  _tourIndex = 0;
  tourBuildDom();
  tourShowStep(0);
}

function tourBuildDom() {
  if (document.getElementById('tour-overlay')) return;
  const overlay = document.createElement('div');
  overlay.id = 'tour-overlay';
  overlay.className = 'tour-overlay';
  overlay.innerHTML = `
    <div class="tour-spotlight" id="tour-spotlight" style="display:none"></div>
    <div class="tour-tooltip" id="tour-tooltip">
      <div class="tour-tooltip-title" id="tour-tooltip-title"></div>
      <div class="tour-tooltip-body" id="tour-tooltip-body"></div>
      <div class="tour-tooltip-footer">
        <button class="tour-skip-btn" id="tour-skip-btn" onclick="endTour()">Skip</button>
        <div class="tour-dots" id="tour-dots"></div>
        <button class="btn btn-primary btn-sm" id="tour-next-btn" onclick="tourNext()">Next</button>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);

  const dotsWrap = document.getElementById('tour-dots');
  TOUR_STEPS.forEach((_, i) => {
    const dot = document.createElement('span');
    dot.className = 'tour-dot';
    dot.dataset.i = i;
    dotsWrap.appendChild(dot);
  });

  document.addEventListener('keydown', tourEscHandler);
}

function tourEscHandler(e) {
  if (_tourActive && e.key === 'Escape') endTour();
}

function tourShowStep(i) {
  const step = TOUR_STEPS[i];
  if (!step) { endTour(); return; }

  // If the user left a dialog open on the previous step (e.g. opened the
  // Project dialog themselves on Step 1 and then clicked Next without
  // closing it), close it before spotlighting the next target — otherwise
  // its backdrop-filter blur would bleed onto whatever's spotlighted now.
  document.querySelectorAll('.modal-overlay.open').forEach(el => el.classList.remove('open'));

  if (typeof step.onEnter === 'function') {
    try { step.onEnter(); } catch(e) {}
  }

  // Give the DOM a beat to settle after any view switch the step triggered.
  setTimeout(() => {
    const titleEl = document.getElementById('tour-tooltip-title');
    const bodyEl = document.getElementById('tour-tooltip-body');
    const nextBtn = document.getElementById('tour-next-btn');
    const tooltip = document.getElementById('tour-tooltip');
    const spotlight = document.getElementById('tour-spotlight');

    titleEl.textContent = step.title;
    bodyEl.textContent = step.body;
    nextBtn.textContent = (i === TOUR_STEPS.length - 1) ? 'Done' : 'Next';

    document.querySelectorAll('.tour-dot').forEach(d => {
      d.classList.toggle('active', Number(d.dataset.i) === i);
    });

    const targetEl = step.target ? document.querySelector(step.target) : null;

    if (targetEl) {
      targetEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
      // Wait for scroll to (mostly) finish before measuring position.
      setTimeout(() => tourPositionAround(targetEl, tooltip, spotlight), 280);
    } else {
      spotlight.style.display = 'none';
      tourPositionCenter(tooltip);
    }
  }, step.onEnter ? 150 : 0);
}

function tourPositionAround(targetEl, tooltip, spotlight) {
  const rect = targetEl.getBoundingClientRect();
  const pad = 8;

  // If the spotlight was hidden (display:none) or this is its first
  // placement, skip the CSS transition and snap straight into position.
  // Leaving the transition on for that first reveal let the browser paint
  // a mid-animation/incorrectly-composited frame that then never got
  // invalidated again — visible as a permanently "blurred" box until the
  // user clicked it and forced a repaint. Fixed 2026-06-30.
  const wasHidden = spotlight.style.display === 'none' || !spotlight.style.top;
  if (wasHidden) spotlight.style.transition = 'none';

  spotlight.style.display = '';
  spotlight.style.top = (rect.top - pad) + 'px';
  spotlight.style.left = (rect.left - pad) + 'px';
  spotlight.style.width = (rect.width + pad * 2) + 'px';
  spotlight.style.height = (rect.height + pad * 2) + 'px';

  if (wasHidden) {
    // Force the browser to apply the snapped position in this paint cycle,
    // then restore the transition so subsequent moves between targets
    // still animate smoothly.
    void spotlight.offsetHeight; // reflow
    requestAnimationFrame(() => { spotlight.style.transition = ''; });
  }

  // Prefer placing the tooltip below the target; flip above if it would
  // run off the bottom of the screen.
  const tooltipHeight = tooltip.offsetHeight || 160;
  const spaceBelow = window.innerHeight - rect.bottom;
  let top;
  if (spaceBelow > tooltipHeight + 24) {
    top = rect.bottom + 16;
  } else {
    top = Math.max(16, rect.top - tooltipHeight - 16);
  }
  let left = Math.min(
    Math.max(16, rect.left),
    window.innerWidth - (tooltip.offsetWidth || 320) - 16
  );

  tooltip.style.position = 'fixed';
  tooltip.style.top = top + 'px';
  tooltip.style.left = left + 'px';
  tooltip.style.transform = 'none';
}

function tourPositionCenter(tooltip) {
  tooltip.style.position = 'fixed';
  tooltip.style.top = '50%';
  tooltip.style.left = '50%';
  tooltip.style.transform = 'translate(-50%, -50%)';
}

function tourNext() {
  _tourIndex++;
  if (_tourIndex >= TOUR_STEPS.length) {
    endTour();
    return;
  }
  tourShowStep(_tourIndex);
}

function endTour() {
  _tourActive = false;
  tourMarkSeen();
  const overlay = document.getElementById('tour-overlay');
  if (overlay) overlay.remove();
  document.removeEventListener('keydown', tourEscHandler);

  // Step 2 ("Create a Project") opens the project-manager modal via
  // openProjectManager(true) but nothing ever closed it again — replaying
  // the tour afterward could re-trigger that step against an already-open
  // (or mid-transition) modal-overlay, producing an intermittent blur/flicker
  // around the spotlighted element. Force every modal closed on tour end so
  // a replay always starts from a clean slate. Fixed 2026-06-30.
  document.querySelectorAll('.modal-overlay.open').forEach(el => el.classList.remove('open'));
}
