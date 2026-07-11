<?php
/**
 * SceneSmith Studio v7 — Build Script
 * ====================================
 * Reads src/ files, minifies CSS + JS, obfuscates JS,
 * and bundles everything into a single dist/ HTML file.
 *
 * USAGE:
 *   From Terminal:  php build.php
 *   From browser:   http://localhost:8888/scenesmithstudio-v7/build.php
 *                   (localhost only — blocked for all other IPs)
 *
 * OUTPUT: dist/scenesmithstudio-v7.html
 */

// ── SECURITY: localhost only ──────────────────────────────────
$remote = $_SERVER['REMOTE_ADDR'] ?? 'cli';
$allowed = ['127.0.0.1', '::1', 'localhost'];
$isCLI   = (php_sapi_name() === 'cli');

if (!$isCLI && !in_array($remote, $allowed)) {
    http_response_code(403);
    die('Access denied.');
}

// ── CONFIG ────────────────────────────────────────────────────
define('SRC',          __DIR__ . '/src');
define('DIST',         __DIR__ . '/dist');
define('OUT_FILE',     DIST . '/scenesmithstudio-v7.html');
define('VERSION_FILE', __DIR__ . '/version.json');

// $jsFiles used to be a hardcoded array here — it silently fell one module
// behind src/shell.html (missing 13-tour.js entirely, added v7.6.0) until
// the 2026-07-03 Fable architecture audit caught it. Replaced with
// get_js_module_list() (defined below, in the HELPERS section) which
// derives the list from src/shell.html's own <script src="js/....js">
// tags — the single source of truth for "which modules exist and in what
// order" — so this exact class of drift can't recur. PHP hoists top-level
// function declarations, so calling it here before its textual definition
// further down is safe.
$jsFiles = get_js_module_list();

// ── HELPERS ───────────────────────────────────────────────────
function log_msg(string $msg): void {
    $ts = date('H:i:s');
    if (php_sapi_name() === 'cli') {
        echo "[$ts] $msg\n";
    } else {
        echo "<p><code>[$ts] " . htmlspecialchars($msg) . "</code></p>\n";
        ob_flush(); flush();
    }
}

function read_file(string $path): string {
    if (!file_exists($path)) {
        throw new RuntimeException("File not found: $path");
    }
    return file_get_contents($path);
}

// ── JS MODULE LIST — derived from src/shell.html (added 2026-07-03) ──
// See the CONFIG section comment above for why this replaced a hardcoded
// array. Order matters (script load order) — preg_match_all preserves
// document order, matching shell.html exactly.
function get_js_module_list(): array {
    $shell = read_file(SRC . '/shell.html');
    preg_match_all('/<script src="js\/([^"]+\.js)"><\/script>/', $shell, $m);
    if (empty($m[1])) {
        throw new RuntimeException('No <script src="js/....js"> tags found in src/shell.html — cannot derive module list.');
    }
    return array_map(fn($f) => SRC . '/js/' . $f, $m[1]);
}

// ── VERSION (single source, added 2026-07-03 — see ?mode=sync below) ──
function get_version(): string {
    if (!file_exists(VERSION_FILE)) {
        throw new RuntimeException('version.json not found at ' . VERSION_FILE . ' — create it with {"version": "X.Y.Z"}.');
    }
    $data = json_decode(file_get_contents(VERSION_FILE), true);
    if (!is_array($data) || !isset($data['version'])) {
        throw new RuntimeException('version.json exists but has no "version" key.');
    }
    return $data['version'];
}

// Rewrites the wordmark version span in an HTML file, and — for the live
// server-backed build only — every "?v=" cache-bust query string too.
// Returns true if the file actually changed (idempotent to call when
// already up to date).
function rewrite_version_in_html(string $path, string $version, bool $withCacheBust): bool {
    $html = read_file($path);
    $orig = $html;
    $html = preg_replace('/(<span class="wordmark-version">)v[\d.]+(<\/span>)/', '${1}v' . $version . '${2}', $html);
    if ($withCacheBust) {
        $html = preg_replace('/(\?v=)[\d.]+(")/', '${1}' . $version . '${2}', $html);
    }
    if ($html !== $orig) {
        file_put_contents($path, $html);
        return true;
    }
    return false;
}

// ── CSS MINIFIER ──────────────────────────────────────────────
function minify_css(string $css): string {
    // Remove comments
    $css = preg_replace('!/\*[^*]*\*+([^/][^*]*\*+)*/!', '', $css);

    // Protect calc() expressions — replace with placeholders
    $calcs = [];
    $css = preg_replace_callback('/calc\([^)]+\)/', function($m) use (&$calcs) {
        $key = '__CALC' . count($calcs) . '__';
        $calcs[$key] = $m[0];
        return $key;
    }, $css);

    // Collapse whitespace
    $css = preg_replace('/\s+/', ' ', $css);

    // Remove spaces around punctuation — but preserve descendant selector spaces
    $css = preg_replace('/\s*\{\s*/', '{', $css);
    $css = preg_replace('/\s*\}\s*/', '}', $css);
    $css = preg_replace('/\s*;\s*/', ';', $css);
    $css = preg_replace('/\s*,\s*/', ',', $css);
    $css = preg_replace('/\s*>\s*/', '>', $css);
    $css = preg_replace('/\s*~\s*/', '~', $css);
    // Collapse multiple spaces to single (preserves descendant combinator)
    $css = preg_replace('/ +/', ' ', $css);

    // Remove trailing semicolons before }
    $css = str_replace(';}', '}', $css);

    // Restore calc() expressions
    foreach ($calcs as $key => $val) {
        $css = str_replace($key, $val, $css);
    }

    return trim($css);
}

// ── JS MINIFIER ───────────────────────────────────────────────
function minify_js(string $js): string {
    // ── PROTECT TEMPLATE LITERALS (MUST run before comment-stripping) ──
    // 01-core.js (and others) contain template literals with nested
    // template literals inside ${...} expressions, e.g.
    //   `<div>${items.map(s => `<span>${s}</span>`).join('')}</div>`
    // and template literals containing substrings that look like
    // comment syntax, e.g. accept="image/*" inside an <input> markup
    // string. If comment-stripping runs first, `/\/\*[\s\S]*?\*\//`
    // treats that "/*" as the start of a real comment and gobbles
    // everything up to the next "*/" ANYWHERE in the file — silently
    // deleting unrelated code in between. So template literals must
    // be pulled out and replaced with placeholders BEFORE comment
    // removal, whitespace collapsing, or punctuation collapsing —
    // then restored verbatim at the very end. Same protect/restore
    // pattern minify_css() uses for calc().
    $templates = [];
    $protected = '';
    $len = strlen($js);
    $i = 0;
    while ($i < $len) {
        $ch = $js[$i];
        if ($ch === '`') {
            // Walk to the matching closing backtick, descending into
            // any ${ ... } expressions (which may themselves contain
            // nested template literals) by tracking brace depth.
            $start = $i;
            $i++;
            while ($i < $len) {
                if ($js[$i] === '\\' && $i + 1 < $len) { $i += 2; continue; }
                if ($js[$i] === '`') { $i++; break; }
                if ($js[$i] === '$' && $i + 1 < $len && $js[$i+1] === '{') {
                    $depth = 1;
                    $i += 2;
                    while ($i < $len && $depth > 0) {
                        if ($js[$i] === '\\' && $i + 1 < $len) { $i += 2; continue; }
                        if ($js[$i] === '`') {
                            // Nested template literal inside ${...} — skip
                            // over it wholesale (recursively, but inline
                            // since PHP has no easy recursive regex here).
                            $i++;
                            while ($i < $len && $js[$i] !== '`') {
                                if ($js[$i] === '\\' && $i + 1 < $len) { $i += 2; continue; }
                                $i++;
                            }
                            $i++; // consume closing backtick of nested literal
                            continue;
                        }
                        if ($js[$i] === '{') $depth++;
                        elseif ($js[$i] === '}') $depth--;
                        $i++;
                    }
                    continue;
                }
                $i++;
            }
            $key = "\x01TPL" . count($templates) . "\x01";
            $templates[$key] = substr($js, $start, $i - $start);
            $protected .= $key;
            continue;
        }
        $protected .= $ch;
        $i++;
    }
    $js = $protected;

    // Now safe to strip comments — every backtick string is a placeholder,
    // so a real `/*` or `//` can't hide inside markup like accept="image/*".
    // Remove single-line comments (but not URLs with //)
    $js = preg_replace('/(?<![:\'"\\\\])\/\/[^\n]*/', '', $js);
    // Remove multi-line comments
    $js = preg_replace('/\/\*[\s\S]*?\*\//', '', $js);

    // Collapse whitespace to single space
    $js = preg_replace('/\s+/', ' ', $js);
    // Remove spaces around PUNCTUATION ONLY — never between word characters.
    // Safe approach: classList, forEach, switchView etc. are all preserved.
    // Previous keyword-based approach was splitting identifiers like
    // switchView→"switch View", classList→"class List", forEach→"for Each".
    $js = preg_replace('/ *([=\+\-\*\/<>\!\&\|\?\:\,\;\{\}\(\)\[\]]) */', '$1', $js);
    // Fix instanceof (contains 'in' which is a word — not affected here, but be safe)
    $js = str_replace('instance of ', 'instanceof ', $js);
    $js = str_replace('instance of(', 'instanceof(', $js);

    // Restore template literals verbatim (unminified — safe over-caution,
    // they're a small fraction of total bytes and correctness matters more
    // than a few extra KB here).
    foreach ($templates as $key => $original) {
        $js = str_replace($key, $original, $js);
    }

    return trim($js);
}

// ── JS OBFUSCATOR ─────────────────────────────────────────────
// Renames internal variable names to short meaningless identifiers.
// Does NOT rename: function names called from HTML onclick attributes,
// global constants, or anything that would break the app.
function obfuscate_js(string $js): string {
    // List of internal variable names safe to rename
    // (local variables inside functions — not globals, not HTML-referenced)
    $rename_map = [
        // Common local loop vars and temp vars — extend as needed
        'idx'           => '_a',
        'arr'           => '_b',
        'tmp'           => '_c',
        'result'        => '_d',
        'matches'       => '_e',
        'output'        => '_f',
        'stripped'      => '_g',
        'resolved'      => '_h',
        'variants'      => '_j',
        'enrichedBeat'  => '_k',
        'nonAssetBlock' => '_l',
        'styleBlock'    => '_m',
        'continuityNote'=> '_n',
        'ratioParam'    => '_o',
        'sections'      => '_q',
        'angleParts'    => '_r',
        'frameParts'    => '_s',
        'sigPhrases'    => '_t',
        'autoInject'    => '_u',
        'charBlock'     => '_v',
        'locBlock'      => '_w',
    ];

    // Only rename whole words (not partial matches)
    foreach ($rename_map as $original => $replacement) {
        $js = preg_replace('/\b' . preg_quote($original, '/') . '\b/', $replacement, $js);
    }

    return $js;
}

// ── VOCABULARY INJECTOR ───────────────────────────────────────
// Reads vocabulary.json and injects it as a JS constant
// so vocabulary.json is baked into the dist file (no external load)
function inject_vocabulary(): string {
    $path = SRC . '/data/vocabulary.json';
    if (!file_exists($path)) return '';
    $json = file_get_contents($path);
    // Validate JSON
    $decoded = json_decode($json);
    if (json_last_error() !== JSON_ERROR_NONE) {
        throw new RuntimeException('vocabulary.json is invalid JSON: ' . json_last_error_msg());
    }
    // Minify by re-encoding
    $minified = json_encode($decoded, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
    return "/* VOCABULARY — auto-injected by build.php */\nconst VOCABULARY_DATA = $minified;\n";
}

// ── BUILD REPORT ──────────────────────────────────────────────
function format_bytes(int $bytes): string {
    if ($bytes >= 1024 * 1024) return round($bytes / (1024 * 1024), 2) . ' MB';
    return round($bytes / 1024, 1) . ' KB';
}

/* ── SYNC MODE (added 2026-07-03, Fable architecture audit Area 5) ────
   Collapses the ~18 manual per-release edits (version bump in 2 HTML
   files' wordmark spans, 15 cache-bust "?v=" strings, and copying each
   changed src/js/*.js + src/css/app.css to dist/) into one command. Does
   NOT touch dist/scenesmithstudio-v7.html — that file is still produced
   only by the main build below, run separately when an offline copy is
   wanted. Reads the target version from version.json (the new single
   source of truth — bump it there first, then run this).
   Usage: `php build.php sync` (CLI) or `?mode=sync` (browser, localhost
   only, same security gate as the main build). */
function run_sync_mode(): void {
    $version = get_version();
    log_msg("Sync mode — target version: v$version");

    // 1. File sync: src/js/*.js -> dist/js/, src/css/app.css -> dist/css/
    $changed = [];
    $unchanged = [];
    foreach (get_js_module_list() as $srcPath) {
        $filename = basename($srcPath);
        $distPath = DIST . '/js/' . $filename;
        $srcContent = read_file($srcPath);
        $distContent = file_exists($distPath) ? file_get_contents($distPath) : null;
        if ($distContent === $srcContent) {
            $unchanged[] = $filename;
        } else {
            if (!is_dir(DIST . '/js')) mkdir(DIST . '/js', 0755, true);
            file_put_contents($distPath, $srcContent);
            $changed[] = $filename;
        }
    }
    $srcCss = read_file(SRC . '/css/app.css');
    $distCssPath = DIST . '/css/app.css';
    $distCss = file_exists($distCssPath) ? file_get_contents($distCssPath) : null;
    if ($distCss === $srcCss) {
        $unchanged[] = 'app.css';
    } else {
        if (!is_dir(DIST . '/css')) mkdir(DIST . '/css', 0755, true);
        file_put_contents($distCssPath, $srcCss);
        $changed[] = 'app.css';
    }
    log_msg("Files: " . count($changed) . " changed, " . count($unchanged) . " already up to date.");
    if ($changed) log_msg("  Changed: " . implode(', ', $changed));

    // 2. Version + cache-bust strings
    $shellPath    = SRC . '/shell.html';
    $liveDistPath = DIST . '/ss_studioV7.html';
    $shellUpdated = rewrite_version_in_html($shellPath, $version, false);
    $liveUpdated  = rewrite_version_in_html($liveDistPath, $version, true);
    log_msg($shellUpdated ? "Version updated in src/shell.html" : "src/shell.html already at v$version");
    log_msg($liveUpdated  ? "Version + cache-bust strings updated in dist/ss_studioV7.html" : "dist/ss_studioV7.html already at v$version");

    // 3. Drift check — module list parity between shell.html and the live
    // dist build. Both are hand-maintained separately (dist/ss_studioV7.html
    // is NOT generated by this script), so nothing stops them silently
    // diverging — this is a direct, permanent check against the exact bug
    // class found this session (13-tour.js missing from build.php's old
    // hardcoded list).
    $shellModules = array_map('basename', get_js_module_list());
    preg_match_all('/<script src="js\/([^"]+\.js)(?:\?[^"]*)?"><\/script>/', read_file($liveDistPath), $dm);
    $distModules = $dm[1] ?? [];
    $missingInDist = array_diff($shellModules, $distModules);
    $extraInDist   = array_diff($distModules, $shellModules);
    if ($missingInDist) log_msg("⚠ DRIFT: dist/ss_studioV7.html is MISSING module(s) that shell.html loads: " . implode(', ', $missingInDist));
    if ($extraInDist)   log_msg("⚠ DRIFT: dist/ss_studioV7.html references module(s) shell.html doesn't: " . implode(', ', $extraInDist));
    if (!$missingInDist && !$extraInDist) log_msg("Module list parity OK — both files reference the same " . count($shellModules) . " modules.");

    // 4. Crude markup-drift signal — not a real diff, just a line-count
    // heads-up, per the audit's own framing ("even a crude diff-line-count
    // warning would have caught the v7.4.0 backport gap" — see
    // future-features.md for that known, still-open gap).
    $shellLines = substr_count(read_file($shellPath), "\n");
    $distLines  = substr_count(read_file($liveDistPath), "\n");
    $delta = abs($shellLines - $distLines);
    log_msg("Line-count check: src/shell.html=$shellLines lines, dist/ss_studioV7.html=$distLines lines (delta=$delta)");
    if ($delta > 20) {
        log_msg("⚠ DRIFT: line-count delta exceeds 20 — the two files may have diverged structurally (known existing example: v7.4.0's multi-figure-frame markup, see future-features.md). This is a heuristic, not a real diff — worth a manual look if this delta surprises you.");
    }

    log_msg("✅ SYNC COMPLETE — v$version");
}

// ── MODE DISPATCH ─────────────────────────────────────────────
$mode = $_GET['mode'] ?? ($argv[1] ?? null);
if ($mode === 'sync') {
    if (!$isCLI) {
        echo "<!DOCTYPE html><html><head><meta charset='UTF-8'>";
        echo "<title>SceneSmith Sync</title>";
        echo "<style>body{font-family:monospace;background:#1a1a1a;color:#90EE90;padding:24px;} ";
        echo "h1{color:#FFD700;} .error{color:#FF6B6B;}</style></head><body>";
        echo "<h1>🔄 SceneSmith Studio v7 — Sync</h1>\n";
        ob_flush(); flush();
    }
    try {
        run_sync_mode();
    } catch (RuntimeException $e) {
        log_msg("❌ SYNC FAILED: " . $e->getMessage());
        if (!$isCLI) { echo "</body></html>"; }
        exit(1);
    }
    if (!$isCLI) { echo "</body></html>"; }
    exit(0);
}

// ── MAIN BUILD ────────────────────────────────────────────────
if (!$isCLI) {
    echo "<!DOCTYPE html><html><head><meta charset='UTF-8'>";
    echo "<title>SceneSmith Build</title>";
    echo "<style>body{font-family:monospace;background:#1a1a1a;color:#90EE90;padding:24px;} ";
    echo "h1{color:#FFD700;} .error{color:#FF6B6B;} .success{color:#90EE90;font-weight:bold;}</style></head><body>";
    echo "<h1>🎬 SceneSmith Studio v7 — Build</h1>\n";
    ob_flush(); flush();
}

try {
    log_msg("Starting build...");

    // Ensure dist/ exists
    if (!is_dir(DIST)) {
        mkdir(DIST, 0755, true);
        log_msg("Created dist/ directory");
    }

    // ── 1. Read and minify CSS
    log_msg("Processing CSS...");
    $rawCSS  = read_file(SRC . '/css/app.css');
    $minCSS  = minify_css($rawCSS);
    $cssSize = strlen($rawCSS);
    $cssSave = round((1 - strlen($minCSS) / $cssSize) * 100);
    log_msg("CSS: " . format_bytes($cssSize) . " → " . format_bytes(strlen($minCSS)) . " (-{$cssSave}%)");

    // ── 2. Read vocabulary and prepare injection
    log_msg("Injecting vocabulary.json...");
    $vocabJS = inject_vocabulary();

    // ── 3. Read, concatenate, minify, obfuscate JS
    log_msg("Processing JavaScript...");
    $rawJS = $vocabJS;
    foreach ($jsFiles as $jsFile) {
        $filename = basename($jsFile);
        $content  = read_file($jsFile);
        $rawJS   .= "\n/* === $filename === */\n" . $content;
        log_msg("  + $filename (" . format_bytes(strlen($content)) . ")");
    }
    $jsSize  = strlen($rawJS);
    $minJS   = minify_js($rawJS);
    $obfJS   = obfuscate_js($minJS);
    $jsSave  = round((1 - strlen($obfJS) / $jsSize) * 100);
    log_msg("JS: " . format_bytes($jsSize) . " → " . format_bytes(strlen($obfJS)) . " (-{$jsSave}%)");

    // ── 4. Read shell HTML
    log_msg("Reading shell.html...");
    $shell = read_file(SRC . '/shell.html');

    // ── 5. Remove external script/link tags — replace with inlined content
    // Remove <link rel="stylesheet" href="css/app.css">
    $shell = preg_replace('/<link[^>]+app\.css[^>]*>/', '', $shell);

    // Remove all <script src="js/..."> tags
    $shell = preg_replace('/<script src="js\/[^"]*"><\/script>/', '', $shell);

    // ── 6. Inject CSS into <head>
    $shell = str_replace('</head>', "<style>$minCSS</style>\n</head>", $shell);

    // ── 7. Inject JS before </body>
    $build_ts  = date('Y-m-d H:i:s');
    $build_tag = "/* SceneSmith Studio v7 | Built: $build_ts | DO NOT EDIT — generated file */";
    $shell     = str_replace('</body>', "<script>$build_tag\n$obfJS</script>\n</body>", $shell);

    // ── 7b. Stamp the version (added 2026-07-03) — reads version.json
    // independently of whatever's already in src/shell.html's wordmark
    // span, so the offline build is correct even if ?mode=sync wasn't run
    // first. Falls back to leaving shell.html's existing value untouched
    // if version.json doesn't exist, so this can't break a build that
    // predates the sync-mode work.
    $buildVersion = null;
    try {
        $buildVersion = get_version();
        $shell = preg_replace('/(<span class="wordmark-version">)v[\d.]+(<\/span>)/', '${1}v' . $buildVersion . '${2}', $shell);
        log_msg("Stamped version v$buildVersion");
    } catch (RuntimeException $e) {
        log_msg("No version.json found — leaving shell.html's existing version wordmark as-is");
    }

    // ── 8. Write dist file
    $totalSize = strlen($shell);
    file_put_contents(OUT_FILE, $shell);
    log_msg("Output: dist/scenesmithstudio-v7.html (" . format_bytes($totalSize) . ")");

    // ── 9. Write a build manifest
    $manifest = [
        'version'   => $buildVersion,
        'built'     => $build_ts,
        'css_raw'   => format_bytes($cssSize),
        'css_min'   => format_bytes(strlen($minCSS)),
        'js_raw'    => format_bytes($jsSize),
        'js_min'    => format_bytes(strlen($obfJS)),
        'total_out' => format_bytes($totalSize),
        'js_files'  => array_map('basename', $jsFiles),
    ];
    file_put_contents(DIST . '/build-manifest.json', json_encode($manifest, JSON_PRETTY_PRINT));
    log_msg("Manifest: dist/build-manifest.json");

    $msg = "✅ BUILD COMPLETE — " . format_bytes($totalSize) . " | $build_ts";
    log_msg($msg);

    if (!$isCLI) {
        echo "<p class='success'>$msg</p>";
        echo "<p><a href='dist/scenesmithstudio-v7.html' style='color:#FFD700'>→ Open dist/scenesmithstudio-v7.html</a></p>";
        echo "</body></html>";
    }

} catch (RuntimeException $e) {
    $errMsg = "❌ BUILD FAILED: " . $e->getMessage();
    log_msg($errMsg);
    if (!$isCLI) {
        echo "<p class='error'>$errMsg</p></body></html>";
    }
    exit(1);
}
