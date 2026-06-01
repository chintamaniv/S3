/**
 * SWARASEVA — Shared Components
 * Injects nav and footer HTML into every page
 * Keeps all pages in sync — edit here once, updates everywhere
 */
(function () {
  'use strict';

  /* ============================================================
     NAVIGATION HTML
     ============================================================ */
  const navHTML = `
<nav class="site-nav" role="navigation" aria-label="Main navigation">
  <div class="nav-inner">

    <a href="/" class="nav-logo" aria-label="SwarSewa home">
      <img src="/images/logo-eng.png" alt="SwarSewa" onerror="this.style.display='none'">
      <span class="nav-logo-text">SWARASEVA</span>
    </a>

    <ul class="nav-menu" role="list">

      <li><a href="/" class="nav-link">Home</a></li>

      <li class="nav-item-wrap">
        <a href="/sacred/" class="nav-link" aria-haspopup="true">
          Sacred <span class="arrow" aria-hidden="true">&#9660;</span>
        </a>
        <div class="nav-dropdown" role="menu" aria-label="Sacred submenu">
          <div class="dropdown-grid cols-2">
            <div>
              <div class="dropdown-col-title">Deities</div>
              <a href="/sacred/vitthal/" class="dropdown-link" role="menuitem">
                <span class="dl-icon" aria-hidden="true">&#127774;</span>Lord Vitthal
              </a>
              <a href="/sacred/ganpati/" class="dropdown-link" role="menuitem">
                <span class="dl-icon" aria-hidden="true">&#127774;</span>Lord Ganpati
              </a>
              <a href="/sacred/ram/" class="dropdown-link" role="menuitem">
                <span class="dl-icon" aria-hidden="true">&#127774;</span>Lord Ram
              </a>
            </div>
            <div>
              <div class="dropdown-col-title">Gurus</div>
              <a href="/sacred/gajanan-maharaj/" class="dropdown-link" role="menuitem">
                <span class="dl-icon" aria-hidden="true">&#10024;</span>Gajanan Maharaj
              </a>
              <a href="/sacred/swami-samarth/" class="dropdown-link" role="menuitem">
                <span class="dl-icon" aria-hidden="true">&#10024;</span>Swami Samarth
              </a>
              <a href="/sacred/sai-baba/" class="dropdown-link" role="menuitem">
                <span class="dl-icon" aria-hidden="true">&#10024;</span>Sai Baba
              </a>
            </div>
          </div>
        </div>
      </li>

      <li class="nav-item-wrap">
        <a href="/media/" class="nav-link" aria-haspopup="true">
          Media <span class="arrow" aria-hidden="true">&#9660;</span>
        </a>
        <div class="nav-dropdown" role="menu" aria-label="Media submenu">
          <div class="dropdown-grid cols-3">
            <div>
              <div class="dropdown-col-title">Listen</div>
              <a href="/media/audio/" class="dropdown-link" role="menuitem">
                <span class="dl-icon" aria-hidden="true">&#127925;</span>Audio
              </a>
            </div>
            <div>
              <div class="dropdown-col-title">Watch</div>
              <a href="/media/videos/" class="dropdown-link" role="menuitem">
                <span class="dl-icon" aria-hidden="true">&#127909;</span>Videos
              </a>
            </div>
            <div>
              <div class="dropdown-col-title">Read</div>
              <a href="/media/blog/" class="dropdown-link" role="menuitem">
                <span class="dl-icon" aria-hidden="true">&#9997;</span>Blog
              </a>
            </div>
          </div>
        </div>
      </li>

      <li class="nav-item-wrap">
        <a href="/events/" class="nav-link" aria-haspopup="true">
          Events <span class="arrow" aria-hidden="true">&#9660;</span>
        </a>
        <div class="nav-dropdown" role="menu" aria-label="Events submenu">
          <div class="dropdown-grid cols-2">
            <div>
              <div class="dropdown-col-title">Pilgrimage</div>
              <a href="/events/pandharpur-wari/" class="dropdown-link" role="menuitem">
                <span class="dl-icon" aria-hidden="true">&#128205;</span>Pandharpur Wari
              </a>
            </div>
            <div>
              <div class="dropdown-col-title">Festivals</div>
              <a href="/events/ganesh-utsav/" class="dropdown-link" role="menuitem">
                <span class="dl-icon" aria-hidden="true">&#128197;</span>Ganesh Utsav
              </a>
              <a href="/events/ram-navami/" class="dropdown-link" role="menuitem">
                <span class="dl-icon" aria-hidden="true">&#128197;</span>Ram Navami
              </a>
            </div>
          </div>
          <div class="dropdown-divider"></div>
          <a href="/events/" class="dropdown-link" role="menuitem">
            <span class="dl-icon" aria-hidden="true">&#128203;</span>All Events
          </a>
        </div>
      </li>

      <li><a href="/sponsors/" class="nav-link">Sponsors</a></li>

    </ul>

    <div class="nav-right">
      <a href="/about/" class="nav-about">About us</a>
      <button class="nav-hamburger" aria-label="Open menu" aria-expanded="false" aria-controls="mobile-nav">
        <span></span><span></span><span></span>
      </button>
    </div>

  </div>
</nav>

<div class="nav-mobile" id="mobile-nav" aria-label="Mobile navigation">
  <div class="mobile-nav-section">
    <a href="/" class="mobile-nav-link">Home</a>
  </div>
  <div class="mobile-nav-divider"></div>
  <div class="mobile-nav-section">
    <div class="mobile-nav-title">Sacred — Deities</div>
    <a href="/sacred/vitthal/" class="mobile-nav-link">Lord Vitthal</a>
    <a href="/sacred/ganpati/" class="mobile-nav-link">Lord Ganpati</a>
    <a href="/sacred/ram/" class="mobile-nav-link">Lord Ram</a>
    <div class="mobile-nav-title" style="margin-top:12px">Sacred — Gurus</div>
    <a href="/sacred/gajanan-maharaj/" class="mobile-nav-link">Gajanan Maharaj</a>
    <a href="/sacred/swami-samarth/" class="mobile-nav-link">Swami Samarth</a>
    <a href="/sacred/sai-baba/" class="mobile-nav-link">Sai Baba</a>
  </div>
  <div class="mobile-nav-divider"></div>
  <div class="mobile-nav-section">
    <div class="mobile-nav-title">Media</div>
    <a href="/media/audio/" class="mobile-nav-link">Audio</a>
    <a href="/media/videos/" class="mobile-nav-link">Videos</a>
    <a href="/media/blog/" class="mobile-nav-link">Blog</a>
  </div>
  <div class="mobile-nav-divider"></div>
  <div class="mobile-nav-section">
    <div class="mobile-nav-title">Events</div>
    <a href="/events/pandharpur-wari/" class="mobile-nav-link">Pandharpur Wari</a>
    <a href="/events/ganesh-utsav/" class="mobile-nav-link">Ganesh Utsav</a>
    <a href="/events/ram-navami/" class="mobile-nav-link">Ram Navami</a>
    <a href="/events/" class="mobile-nav-link">All Events</a>
  </div>
  <div class="mobile-nav-divider"></div>
  <div class="mobile-nav-section">
    <a href="/sponsors/" class="mobile-nav-link">Sponsors</a>
    <a href="/about/" class="mobile-nav-link">About us</a>
  </div>
</div>`;

  /* ============================================================
     FOOTER HTML
     ============================================================ */
  const footerHTML = `
<footer class="site-footer" role="contentinfo">
  <div class="container">
    <div class="footer-grid">

      <div class="footer-brand">
        <img src="/images/logo-eng.png" alt="SwarSewa" class="fb-logo" onerror="this.style.display='none'">
        <p>SwarSewa is a devotional infotainment platform rooted in Maharashtra's Bhakti tradition — bringing sacred music, stories, and live events to devotees everywhere.</p>
        <div class="footer-social" style="margin-top:20px">
          <a href="#" aria-label="YouTube" rel="noopener noreferrer">&#9654;</a>
          <a href="#" aria-label="Instagram" rel="noopener noreferrer">&#9679;</a>
          <a href="#" aria-label="Facebook" rel="noopener noreferrer">&#9632;</a>
          <a href="#" aria-label="WhatsApp" rel="noopener noreferrer">&#9679;</a>
        </div>
      </div>

      <div class="footer-col">
        <h4>Sacred</h4>
        <ul>
          <li><a href="/sacred/vitthal/">Lord Vitthal</a></li>
          <li><a href="/sacred/ganpati/">Lord Ganpati</a></li>
          <li><a href="/sacred/ram/">Lord Ram</a></li>
          <li><a href="/sacred/gajanan-maharaj/">Gajanan Maharaj</a></li>
          <li><a href="/sacred/swami-samarth/">Swami Samarth</a></li>
          <li><a href="/sacred/sai-baba/">Sai Baba</a></li>
        </ul>
      </div>

      <div class="footer-col">
        <h4>Events</h4>
        <ul>
          <li><a href="/events/pandharpur-wari/">Pandharpur Wari</a></li>
          <li><a href="/events/ganesh-utsav/">Ganesh Utsav</a></li>
          <li><a href="/events/ram-navami/">Ram Navami</a></li>
          <li><a href="/events/">All Events</a></li>
        </ul>
        <h4 style="margin-top:20px">Media</h4>
        <ul>
          <li><a href="/media/audio/">Audio</a></li>
          <li><a href="/media/videos/">Videos</a></li>
          <li><a href="/media/blog/">Blog</a></li>
        </ul>
      </div>

      <div class="footer-col">
        <h4>Connect</h4>
        <ul>
          <li><a href="/about/">About SwarSewa</a></li>
          <li><a href="/about/#contact">Contact us</a></li>
          <li><a href="/sponsors/">Become a Sponsor</a></li>
          <li><a href="/about/privacy/">Privacy Policy</a></li>
        </ul>
        <div style="margin-top:20px">
          <a href="https://wa.me/917000000000" class="btn btn-whatsapp btn-sm" rel="noopener noreferrer" target="_blank">
            &#128172; WhatsApp us
          </a>
        </div>
      </div>

    </div>

    <div class="footer-bottom">
      <p>&copy; 2026 SwarSewa. All rights reserved.</p>
      <div style="display:flex;gap:20px">
        <a href="/about/privacy/">Privacy Policy</a>
        <a href="/sponsors/">Sponsors</a>
      </div>
    </div>
  </div>
</footer>`;

  /* ============================================================
     INJECT into page
     ============================================================ */
  const navTarget = document.getElementById('nav-root');
  const footerTarget = document.getElementById('footer-root');

  if (navTarget) navTarget.outerHTML = navHTML;
  if (footerTarget) footerTarget.outerHTML = footerHTML;

})();
