/**
 * SWARASEVA — Navigation JS
 * Handles: sticky scroll, mobile drawer, dropdowns, active state
 * Security: no innerHTML from external sources, no eval, CSP-safe
 */
(function () {
  'use strict';

  const nav = document.querySelector('.site-nav');
  const hamburger = document.querySelector('.nav-hamburger');
  const mobileNav = document.querySelector('.nav-mobile');

  if (!nav) return;

  /* --- Sticky scroll class --- */
  const onScroll = function () {
    if (window.scrollY > 20) {
      nav.classList.add('scrolled');
    } else {
      nav.classList.remove('scrolled');
    }
  };

  window.addEventListener('scroll', onScroll, { passive: true });
  onScroll();

  /* --- Mobile hamburger toggle --- */
  if (hamburger && mobileNav) {
    hamburger.addEventListener('click', function () {
      const isOpen = mobileNav.classList.contains('open');
      mobileNav.classList.toggle('open');
      hamburger.classList.toggle('open');
      hamburger.setAttribute('aria-expanded', String(!isOpen));
      document.body.style.overflow = isOpen ? '' : 'hidden';
    });

    /* Close mobile nav on link click */
    mobileNav.querySelectorAll('a').forEach(function (link) {
      link.addEventListener('click', function () {
        mobileNav.classList.remove('open');
        hamburger.classList.remove('open');
        hamburger.setAttribute('aria-expanded', 'false');
        document.body.style.overflow = '';
      });
    });

    /* Close on overlay click (outside drawer) */
    document.addEventListener('click', function (e) {
      if (
        mobileNav.classList.contains('open') &&
        !mobileNav.contains(e.target) &&
        !hamburger.contains(e.target)
      ) {
        mobileNav.classList.remove('open');
        hamburger.classList.remove('open');
        hamburger.setAttribute('aria-expanded', 'false');
        document.body.style.overflow = '';
      }
    });
  }

  /* --- Mobile accordion (section toggles in mobile nav) --- */
  document.querySelectorAll('.mobile-nav-toggle').forEach(function (toggle) {
    toggle.addEventListener('click', function () {
      const target = document.getElementById(this.dataset.target);
      if (!target) return;
      const isOpen = target.classList.contains('open');
      target.classList.toggle('open');
      this.setAttribute('aria-expanded', String(!isOpen));
    });
  });

  /* --- Active nav link based on current page --- */
  const currentPath = window.location.pathname.replace(/\/$/, '') || '/';
  document.querySelectorAll('.nav-link, .dropdown-link').forEach(function (link) {
    const href = link.getAttribute('href');
    if (!href) return;
    const linkPath = href.replace(/\/$/, '') || '/';
    if (linkPath === currentPath) {
      link.classList.add('active');
    }
  });

  /* --- Sticky page nav active section highlight --- */
  const stickyNav = document.querySelector('.sticky-page-nav');
  if (stickyNav) {
    const sections = document.querySelectorAll('section[id]');
    const navLinks = stickyNav.querySelectorAll('a[href^="#"]');

    if (sections.length && navLinks.length) {
      const observer = new IntersectionObserver(
        function (entries) {
          entries.forEach(function (entry) {
            if (entry.isIntersecting) {
              const id = entry.target.id;
              navLinks.forEach(function (link) {
                link.classList.toggle(
                  'active',
                  link.getAttribute('href') === '#' + id
                );
              });
            }
          });
        },
        { rootMargin: '-20% 0px -60% 0px' }
      );

      sections.forEach(function (section) {
        observer.observe(section);
      });
    }
  }

  /* --- Keyboard accessibility for dropdowns --- */
  document.querySelectorAll('.nav-item-wrap').forEach(function (wrap) {
    const dropdown = wrap.querySelector('.nav-dropdown');
    if (!dropdown) return;

    wrap.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') {
        dropdown.style.opacity = '0';
        dropdown.style.visibility = 'hidden';
        wrap.querySelector('.nav-link').focus();
      }
    });
  });

})();
