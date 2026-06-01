/**
 * SWARASEVA — Content Loader
 * Reads videos.json, blog.json, audio.json and renders grids
 * Security: all data sanitised before DOM insertion, no eval
 */
(function () {
  'use strict';

  /* Safe text — strips any HTML tags from JSON strings */
  function safe(str) {
    if (typeof str !== 'string') return '';
    return str.replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  /* Safe YouTube ID — must be exactly 11 alphanumeric/dash/underscore chars */
  function safeYtId(id) {
    if (typeof id !== 'string') return '';
    return /^[a-zA-Z0-9_-]{11}$/.test(id) ? id : '';
  }

  /* Safe URL — only allow http/https */
  function safeUrl(url) {
    if (typeof url !== 'string') return '#';
    return /^https?:\/\//i.test(url) ? url : '#';
  }

  /* Safe slug — alphanumeric, hyphens only */
  function safeSlug(slug) {
    if (typeof slug !== 'string') return '';
    return slug.replace(/[^a-z0-9-]/gi, '');
  }

  /* ============================================================
     LOAD VIDEOS
     ============================================================ */
  const videoGrid = document.getElementById('video-grid');
  if (videoGrid) {
    fetch('/data/videos.json')
      .then(function (r) { return r.json(); })
      .then(function (videos) {
        if (!Array.isArray(videos)) return;
        videoGrid.innerHTML = '';
        videos.forEach(function (v) {
          const ytId = safeYtId(v.ytid);
          if (!ytId) return;
          const category = safe(v.category || 'all');
          const title = safe(v.title || '');

          const card = document.createElement('div');
          card.className = 'video-card reveal';
          card.setAttribute('data-category', category);

          card.innerHTML =
            '<div class="video-embed-wrap yt-lazy" data-ytid="' + ytId + '" data-title="' + title + '">' +
            '</div>' +
            '<div class="vc-body">' +
            '<div class="vc-title">' + title + '</div>' +
            '<div class="vc-tag">' + category + '</div>' +
            '</div>';

          videoGrid.appendChild(card);
        });

        /* Re-init lazy embeds for dynamically added cards */
        if (typeof window.initLazyYT === 'function') window.initLazyYT();
      })
      .catch(function () {
        videoGrid.innerHTML = '<p class="placeholder-text">विठ्ठल विठ्ठल — videos.json not yet loaded. Add YouTube video IDs to /data/videos.json</p>';
      });
  }

  /* ============================================================
     LOAD BLOG POSTS
     ============================================================ */
  const blogGrid = document.getElementById('blog-grid');
  if (blogGrid) {
    fetch('/data/blog.json')
      .then(function (r) { return r.json(); })
      .then(function (posts) {
        if (!Array.isArray(posts)) return;
        blogGrid.innerHTML = '';
        posts.forEach(function (post) {
          const slug = safeSlug(post.slug || '');
          const title = safe(post.title || '');
          const date = safe(post.date || '');
          const excerpt = safe(post.excerpt || '');
          const image = safeUrl(post.image || '#');
          const hasImage = image !== '#';

          const card = document.createElement('article');
          card.className = 'blog-card reveal';

          card.innerHTML =
            '<div class="bc-img">' +
            (hasImage
              ? '<img src="' + image + '" alt="' + title + '" loading="lazy">'
              : '<div class="img-placeholder" style="min-height:180px"><div class="ph-icon">&#128247;</div><div class="ph-size">800 × 450 px</div><div class="ph-subject">Blog featured image — ' + title + '</div></div>'
            ) +
            '</div>' +
            '<div class="bc-body">' +
            '<div class="bc-date">' + date + '</div>' +
            '<h3 class="bc-title">' + title + '</h3>' +
            '<p class="bc-excerpt">' + excerpt + '</p>' +
            '<a href="/media/blog/' + slug + '/" class="bc-link">Read more &rarr;</a>' +
            '</div>';

          blogGrid.appendChild(card);
        });
      })
      .catch(function () {
        blogGrid.innerHTML = '<p class="placeholder-text">पांडुरंग पांडुरंग — blog.json not yet loaded. Add article entries to /data/blog.json</p>';
      });
  }

  /* ============================================================
     LOAD AUDIO TRACKS
     ============================================================ */
  const audioGrid = document.getElementById('audio-grid');
  if (audioGrid) {
    fetch('/data/audio.json')
      .then(function (r) { return r.json(); })
      .then(function (tracks) {
        if (!Array.isArray(tracks)) return;
        audioGrid.innerHTML = '';
        tracks.forEach(function (t) {
          const ytId = safeYtId(t.ytid || '');
          if (!ytId) return;
          const title = safe(t.title || '');
          const category = safe(t.category || 'all');
          const duration = safe(t.duration || '');

          const card = document.createElement('div');
          card.className = 'video-card reveal';
          card.setAttribute('data-category', category);

          card.innerHTML =
            '<div class="video-embed-wrap yt-lazy" data-ytid="' + ytId + '" data-title="' + title + '">' +
            '</div>' +
            '<div class="vc-body">' +
            '<div class="vc-title">' + title + '</div>' +
            '<div class="vc-tag">' + category + (duration ? ' &nbsp;·&nbsp; ' + duration : '') + '</div>' +
            '</div>';

          audioGrid.appendChild(card);
        });
      })
      .catch(function () {
        audioGrid.innerHTML = '<p class="placeholder-text">ज्ञानदेव तुकाराम — audio.json not yet loaded. Add YouTube track IDs to /data/audio.json</p>';
      });
  }

})();
