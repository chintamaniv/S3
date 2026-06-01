# SwarSewa Website — Content Update Guide

A practical guide for updating content, swapping images, adding videos and deploying the site.

---

## Quick Reference

| Task | File to Edit |
|---|---|
| Add a new video | `/data/videos.json` |
| Add a new audio playlist | `/data/audio.json` |
| Add a new blog post | `/data/blog.json` |
| Change sponsor banner | Edit the HTML file for that page |
| Update WhatsApp number | Search & replace `917000000000` in all HTML files |
| Update nav/footer | `/js/components.js` |

---

## 1. Adding a New Video

Open `/data/videos.json` and add a new entry to the array:

```json
{
  "ytid": "xxxxxxxxxxx",
  "title": "Your Video Title",
  "category": "event-highlights"
}
```

**Categories:** `event-highlights` | `stories` | `interviews`

The YouTube ID is the 11-character code from the video URL:
`https://www.youtube.com/watch?v=` **`xxxxxxxxxxx`**

---

## 2. Adding a New Audio Playlist

Open `/data/audio.json` and add a new entry:

```json
{
  "ytid": "xxxxxxxxxxx",
  "title": "Playlist Name",
  "category": "morning",
  "duration": "45 min"
}
```

**Categories:** `morning` | `evening` | `mood`

---

## 3. Adding a New Blog Post

Open `/data/blog.json` and add a new entry:

```json
{
  "slug": "your-article-slug",
  "title": "Article Title",
  "date": "15 January 2026",
  "excerpt": "A short summary of the article — 1–2 sentences shown in the preview card.",
  "image": "/images/blog/your-article-image.jpg"
}
```

- Place the article image in `/images/blog/`
- The `slug` becomes part of the URL — use lowercase letters and hyphens only (e.g. `pandharpur-wari-guide`)
- Individual blog post pages are not yet built in Phase 1 — the slug will be used in Phase 2

---

## 4. Swapping a Sponsor Banner

Each page has a sponsor banner slot. To replace a banner:

1. Prepare your banner image in the correct size:
   - Desktop: **970 × 90 px** (leaderboard) or **970 × 250 px** (large)
   - Mobile: **320 × 100 px**
   - Event pages: **728 × 90 px**

2. Upload the image to `/images/sponsors/`

3. Find the `<div class="sponsor-banner">` block on the page and replace the `<div class="sb-placeholder">` with:

```html
<a href="https://your-sponsor-website.com" target="_blank" rel="noopener noreferrer sponsored">
  <picture>
    <source media="(max-width: 480px)" srcset="/images/sponsors/sponsor-mobile.jpg">
    <img src="/images/sponsors/sponsor-desktop.jpg" alt="Sponsor Name" width="970" height="90" loading="lazy">
  </picture>
</a>
```

---

## 5. Replacing Image Placeholders

Gray placeholder boxes show exact dimensions and subject descriptions. To replace:

1. Prepare image at the specified size (or larger — the CSS will crop/fit it)
2. Upload to `/images/` (or a subdirectory like `/images/events/`)
3. Replace the `<div class="img-placeholder">` block with:

```html
<img src="/images/your-image.jpg" alt="Descriptive alt text" width="700" height="480" loading="lazy">
```

For hero backgrounds, find the section with `style="background-image: url(...)"` and update the URL.

---

## 6. Replacing Red Placeholder Text

All red text (`.placeholder-text` class) is content that needs to be filled in from `WEBSITE_ENTIRE_COPY.pdf`.

Simply find the red text in the HTML file and replace the entire `<p class="placeholder-text">...</p>` with:

```html
<p>Your actual content here.</p>
```

---

## 7. Updating the WhatsApp Number

The placeholder number `917000000000` appears throughout the site. To update:

1. Open a terminal or text editor with find-and-replace
2. Replace all instances of `917000000000` with your actual number in format `91XXXXXXXXXX` (country code + number, no spaces or dashes)

Or use the bash command from the site root:
```bash
grep -r "917000000000" . --include="*.html" -l
```

---

## 8. Updating the Nav and Footer

Both the navigation menu and footer are in a single file: `/js/components.js`

- **Nav links:** Find `const navHTML = ...` and edit the link text/URLs
- **Footer content:** Find `const footerHTML = ...` and edit address, links, social handles
- **Social media links:** Update `href` values in the footer social icons

---

## 9. Uploading to Your Server

The site is a collection of static files — HTML, CSS, JS, images and JSON.

**Upload method:** FTP / SFTP / SCP

1. Upload the entire `SwarSewa_website/` folder contents to your server's web root (e.g. `/var/www/html/` or `/public_html/`)
2. Ensure `.htaccess` is uploaded (some FTP clients hide dot files — check settings)
3. Set file permissions:
   - Folders: `755`
   - Files: `644`
4. HTTPS is required for YouTube embeds — ensure your SSL certificate is active

**Check .htaccess is working:**
Visit `http://yoursite.com` — it should redirect to `https://yoursite.com`

---

## 10. Enabling HSTS (After Launch)

Once HTTPS is confirmed working, uncomment the HSTS line in `.htaccess`:

```apache
Header always set Strict-Transport-Security "max-age=31536000; includeSubDomains"
```

This tells browsers to always use HTTPS for the next year — do this only when you are sure HTTPS is correctly configured.

---

## File Structure

```
SwarSewa_website/
├── index.html                    Homepage
├── .htaccess                     Apache security & performance config
├── css/
│   └── style.css                 All styles
├── js/
│   ├── components.js             Shared nav + footer HTML
│   ├── nav.js                    Nav behaviour (sticky, mobile, dropdown)
│   ├── main.js                   Accordion, carousel, filters, lazy YouTube
│   └── content-loader.js         JSON data loader (videos, audio, blog)
├── data/
│   ├── videos.json               ← Edit to add/remove videos
│   ├── audio.json                ← Edit to add/remove audio playlists
│   └── blog.json                 ← Edit to add/remove blog posts
├── images/
│   ├── favicon.png
│   ├── logo-eng.png
│   ├── logo-mar.png
│   └── blog/                     Blog post images
├── sacred/
│   ├── index.html                Sacred landing page
│   ├── vitthal/index.html
│   ├── ganpati/index.html
│   ├── ram/index.html
│   ├── gajanan-maharaj/index.html
│   ├── swami-samarth/index.html
│   └── sai-baba/index.html
├── events/
│   ├── index.html                Events landing
│   ├── pandharpur-wari/index.html
│   ├── ganesh-utsav/index.html
│   └── ram-navami/index.html
├── media/
│   ├── index.html                Media hub
│   ├── audio/index.html
│   ├── videos/index.html
│   └── blog/index.html
├── sponsors/
│   └── index.html
└── about/
    ├── index.html
    └── privacy/index.html
```

---

*SwarSewa Phase 1 — Built May 2026*
