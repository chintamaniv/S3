/**
 * SWARASEVA — Main JS
 * Handles: accordion, carousel, filter pills, scroll animations,
 *          sticky page nav, lazy YouTube embeds
 * Security: no eval, no innerHTML from user data, XSS-safe
 */
(function () {
  'use strict';

  /* ============================================================
     ACCORDION
     ============================================================ */
  document.querySelectorAll('.accordion-trigger').forEach(function (trigger) {
    trigger.addEventListener('click', function () {
      const body = document.getElementById(this.getAttribute('aria-controls'));
      if (!body) return;

      const isOpen = body.classList.contains('open');

      /* Close all others in same accordion group */
      const accordion = this.closest('.accordion');
      if (accordion) {
        accordion.querySelectorAll('.accordion-body.open').forEach(function (b) {
          b.classList.remove('open');
        });
        accordion.querySelectorAll('.accordion-trigger').forEach(function (t) {
          t.setAttribute('aria-expanded', 'false');
        });
      }

      if (!isOpen) {
        body.classList.add('open');
        this.setAttribute('aria-expanded', 'true');
      }
    });
  });

  /* ============================================================
     CAROUSEL
     ============================================================ */
  document.querySelectorAll('.carousel-wrap').forEach(function (wrap) {
    const track   = wrap.querySelector('.carousel-track');
    const cards   = wrap.querySelectorAll('.carousel-track > *');
    const btnPrev = wrap.querySelector('.carousel-btn.prev');
    const btnNext = wrap.querySelector('.carousel-btn.next');
    const dots    = wrap.querySelectorAll('.carousel-dot');

    if (!track || !cards.length) return;

    let current = 0;
    let itemsVisible = getVisible();
    let total = Math.ceil(cards.length / itemsVisible);
    let autoTimer = null;

    function getVisible() {
      if (window.innerWidth < 480) return 1;
      if (window.innerWidth < 900) return 2;
      return 3;
    }

    function goTo(index) {
      const clamped = Math.max(0, Math.min(index, cards.length - itemsVisible));
      current = clamped;
      const cardWidth = cards[0].offsetWidth + 24; /* gap */
      track.style.transform = 'translateX(-' + (current * cardWidth) + 'px)';

      /* Update dots */
      const dotIndex = Math.round(current / itemsVisible);
      dots.forEach(function (d, i) {
        d.classList.toggle('active', i === dotIndex);
      });

      /* Update button states */
      if (btnPrev) btnPrev.disabled = current === 0;
      if (btnNext) btnNext.disabled = current >= cards.length - itemsVisible;
    }

    function startAuto() {
      stopAuto();
      autoTimer = setInterval(function () {
        const next = current + itemsVisible;
        goTo(next >= cards.length ? 0 : next);
      }, 4500);
    }

    function stopAuto() {
      if (autoTimer) { clearInterval(autoTimer); autoTimer = null; }
    }

    if (btnPrev) {
      btnPrev.addEventListener('click', function () {
        stopAuto();
        goTo(current - itemsVisible);
        startAuto();
      });
    }

    if (btnNext) {
      btnNext.addEventListener('click', function () {
        stopAuto();
        goTo(current + itemsVisible);
        startAuto();
      });
    }

    dots.forEach(function (dot, i) {
      dot.addEventListener('click', function () {
        stopAuto();
        goTo(i * itemsVisible);
        startAuto();
      });
    });

    /* Touch / swipe */
    let touchStartX = 0;
    track.addEventListener('touchstart', function (e) {
      touchStartX = e.touches[0].clientX;
      stopAuto();
    }, { passive: true });

    track.addEventListener('touchend', function (e) {
      const diff = touchStartX - e.changedTouches[0].clientX;
      if (Math.abs(diff) > 40) {
        goTo(diff > 0 ? current + 1 : current - 1);
      }
      startAuto();
    }, { passive: true });

    /* Recalculate on resize */
    window.addEventListener('resize', function () {
      itemsVisible = getVisible();
      total = Math.ceil(cards.length / itemsVisible);
      goTo(0);
    }, { passive: true });

    goTo(0);
    startAuto();
  });

  /* ============================================================
     FILTER PILLS — Video / Blog grid
     ============================================================ */
  document.querySelectorAll('.filter-bar').forEach(function (bar) {
    const pills = bar.querySelectorAll('.filter-pill');
    const gridId = bar.dataset.grid;
    if (!gridId) return;

    const grid = document.getElementById(gridId);
    if (!grid) return;

    pills.forEach(function (pill) {
      pill.addEventListener('click', function () {
        pills.forEach(function (p) { p.classList.remove('active'); });
        this.classList.add('active');

        const filter = this.dataset.filter;
        grid.querySelectorAll('[data-category]').forEach(function (item) {
          const show = filter === 'all' || item.dataset.category === filter;
          item.style.display = show ? '' : 'none';
        });
      });
    });
  });

  /* ============================================================
     FILTER TRIGGER BUTTONS — category card "Watch/Listen" buttons
     that scroll to the filter bar and activate a category filter
     ============================================================ */
  document.querySelectorAll('[data-filter-trigger]').forEach(function (btn) {
    btn.addEventListener('click', function () {
      var category = this.dataset.filterTrigger;
      // Find a filter bar on the page with a matching pill
      var filterBar = document.querySelector('.filter-bar');
      if (!filterBar) return;
      var pills = filterBar.querySelectorAll('.filter-pill');
      var gridId = filterBar.dataset.grid;
      var grid = gridId ? document.getElementById(gridId) : null;

      pills.forEach(function (p) { p.classList.remove('active'); });
      var matchPill = filterBar.querySelector('[data-filter="' + category + '"]');
      if (matchPill) matchPill.classList.add('active');

      if (grid) {
        grid.querySelectorAll('[data-category]').forEach(function (item) {
          var show = item.dataset.category === category;
          item.style.display = show ? '' : 'none';
        });
      }

      // Scroll to the filter bar
      var offset = parseInt(getComputedStyle(document.documentElement).getPropertyValue('--nav-height') || '68', 10);
      var top = filterBar.getBoundingClientRect().top + window.pageYOffset - offset - 16;
      window.scrollTo({ top: top, behavior: 'smooth' });
    });
  });

  /* ============================================================
     SCROLL REVEAL — subtle fade-in on scroll
     ============================================================ */
  if ('IntersectionObserver' in window) {
    const revealObserver = new IntersectionObserver(
      function (entries) {
        entries.forEach(function (entry) {
          if (entry.isIntersecting) {
            entry.target.classList.add('revealed');
            revealObserver.unobserve(entry.target);
          }
        });
      },
      { threshold: 0.1, rootMargin: '0px 0px -40px 0px' }
    );

    document.querySelectorAll('.reveal').forEach(function (el) {
      revealObserver.observe(el);
    });
  } else {
    /* Fallback — show everything immediately */
    document.querySelectorAll('.reveal').forEach(function (el) {
      el.classList.add('revealed');
    });
  }

  /* ============================================================
     LAZY YOUTUBE EMBEDS
     Load iframe only when user clicks play thumbnail
     Reduces page load time significantly
     ============================================================ */
  document.querySelectorAll('.yt-lazy').forEach(function (wrap) {
    const videoId = wrap.dataset.ytid;
    if (!videoId || !/^[a-zA-Z0-9_-]{11}$/.test(videoId)) return;

    /* Build thumbnail */
    const thumb = document.createElement('img');
    thumb.src = 'https://img.youtube.com/vi/' + videoId + '/hqdefault.jpg';
    thumb.alt = wrap.dataset.title || 'Video';
    thumb.loading = 'lazy';
    thumb.className = 'yt-thumb';

    const playBtn = document.createElement('button');
    playBtn.className = 'yt-play-btn';
    playBtn.setAttribute('aria-label', 'Play ' + (wrap.dataset.title || 'video'));
    playBtn.innerHTML = '&#9654;';

    wrap.appendChild(thumb);
    wrap.appendChild(playBtn);

    function loadEmbed() {
      const iframe = document.createElement('iframe');
      /* Strict YouTube embed URL — no JS API to prevent tracking */
      iframe.src = 'https://www.youtube-nocookie.com/embed/' + videoId + '?autoplay=1&rel=0&modestbranding=1';
      iframe.title = wrap.dataset.title || 'YouTube video';
      iframe.allow = 'accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture';
      iframe.allowFullscreen = true;
      iframe.loading = 'lazy';
      iframe.setAttribute('referrerpolicy', 'strict-origin-when-cross-origin');
      /* Remove thumbnail, insert iframe */
      wrap.innerHTML = '';
      wrap.appendChild(iframe);
    }

    playBtn.addEventListener('click', loadEmbed);
  });

  /* ============================================================
     SMOOTH SCROLL for in-page anchor links
     ============================================================ */
  document.querySelectorAll('a[href^="#"]').forEach(function (link) {
    link.addEventListener('click', function (e) {
      const id = this.getAttribute('href').slice(1);
      if (!id) return;
      const target = document.getElementById(id);
      if (!target) return;
      e.preventDefault();
      const navHeight = parseInt(
        getComputedStyle(document.documentElement).getPropertyValue('--nav-height'),
        10
      ) || 68;
      const top = target.getBoundingClientRect().top + window.scrollY - navHeight - 8;
      window.scrollTo({ top: top, behavior: 'smooth' });
    });
  });

})();

/* ============================================================
   SCROLL REVEAL — CSS companion
   Add to style.css (appended here to keep files minimal)
   ============================================================ */
(function () {
  const style = document.createElement('style');
  style.textContent = [
    '.reveal{opacity:0;transform:translateY(24px);transition:opacity 0.55s ease,transform 0.55s ease;}',
    '.reveal.revealed{opacity:1;transform:none;}',
    '.yt-lazy{position:relative;cursor:pointer;background:#0e0f14;border-radius:8px;overflow:hidden;}',
    '.yt-lazy .yt-thumb{width:100%;height:100%;object-fit:cover;display:block;transition:opacity 0.3s;}',
    '.yt-lazy:hover .yt-thumb{opacity:0.8;}',
    '.yt-lazy .yt-play-btn{position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);width:56px;height:56px;background:rgba(164,24,23,0.9);border:3px solid #fff;border-radius:50%;color:#fff;font-size:1.4rem;display:flex;align-items:center;justify-content:center;transition:background 0.2s;}',
    '.yt-lazy:hover .yt-play-btn{background:var(--crimson,#a41817);}',
    '.yt-lazy iframe{position:absolute;top:0;left:0;width:100%;height:100%;border:none;}'
  ].join('');
  document.head.appendChild(style);
})();
