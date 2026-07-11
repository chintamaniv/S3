<?php
/**
 * SS_Studio — File-based API
 * All user data stored under /userdata/{username}/projects/
 */

header('Content-Type: application/json');
header('Access-Control-Allow-Origin: *');
header('Access-Control-Allow-Methods: POST, GET, OPTIONS');
header('Access-Control-Allow-Headers: Content-Type');

if ($_SERVER['REQUEST_METHOD'] === 'OPTIONS') {
    http_response_code(200);
    exit;
}

// ─── Config ───────────────────────────────────────────────────────────────────
define('USERDATA_ROOT', __DIR__ . '/userdata');
define('MAX_UPLOAD_MB', 10);
// Shared-library grid thumbnails (2026-07-09 fix): originally 160px, which
// looked visibly soft/pixelated once stretched to fill an asset card
// (~250-300px wide, more on retina). 480px gives a sharp result at that
// display size while still being tiny next to the ~1568px optimized
// uploads — the whole point of the thumbnail tier (avoid shipping full
// images in list responses) is unaffected. See ensure_thumb_file() for the
// self-healing regen of thumbnails generated before this change.
define('THUMB_MIN_DIM', 480);

// Task #1 (backup safeguards, 2026-06-25): the backup destination path is
// server-wide config (not per-user, not per-project) — where to write
// scheduled snapshots is an installation-level decision the admin makes
// once via the Settings panel, read by both this file (to report/save it)
// and the standalone backup.php cron script (to know where to write).
// Stored in userdata/ like other server-side config (sponsor secret, etc.)
// rather than in the document root, so it's covered by the same
// .htaccess deny-all rule and never exposed over HTTP.
define('BACKUP_CONFIG_FILE', USERDATA_ROOT . '/_backup_config.json');

// ─── Helpers ──────────────────────────────────────────────────────────────────

function respond($data, $code = 200) {
    http_response_code($code);
    echo json_encode($data);
    exit;
}

function error($msg, $code = 400) {
    respond(['success' => false, 'error' => $msg], $code);
}

function success($data = []) {
    respond(array_merge(['success' => true], $data));
}

function sanitize_name($name) {
    // Lowercase, alphanumeric + underscore + hyphen only, max 50 chars
    $name = strtolower(trim($name));
    $name = preg_replace('/[^a-z0-9_\-]/', '_', $name);
    $name = preg_replace('/_+/', '_', $name);
    return substr($name, 0, 50);
}

function user_path($username) {
    return USERDATA_ROOT . '/' . sanitize_name($username);
}

function project_path($username, $project_id) {
    return user_path($username) . '/projects/' . sanitize_name($project_id);
}

function ensure_dir($path) {
    if (!is_dir($path)) {
        mkdir($path, 0755, true);
    }
}

function read_json($path) {
    if (!file_exists($path)) return null;
    return json_decode(file_get_contents($path), true);
}

function write_json($path, $data) {
    return file_put_contents($path, json_encode($data, JSON_PRETTY_PRINT)) !== false;
}

function generate_id($prefix = '') {
    return $prefix . bin2hex(random_bytes(6));
}

function library_type($type) {
    $allowed = ['character', 'location', 'prop', 'era', 'style'];
    $type = sanitize_name($type);
    if (!in_array($type, $allowed, true)) error('Invalid library type');
    return $type;
}

function library_dir($type) {
    $dir = USERDATA_ROOT . '/_shared/library/' . library_type($type);
    ensure_dir($dir);
    return $dir;
}

// ─── Shared-library image pipeline (Fable audit H4 root cause, 2026-07-08) ──
// Root cause, confirmed live (Activity Monitor showed Safari Web Content
// pegged at 100% CPU editing a Location asset, no relief from any client-
// side fix): save_library_asset never extracted asset['images'] to separate
// files the way save_asset (characters, above) already does — every photo
// got written straight into that asset's JSON file as raw base64,
// permanently, and load_library_assets shipped ALL of it back, for EVERY
// asset of that type, on every single list load (matches the 113MB/41MB
// responses captured live earlier the same day). Parsing that as one giant
// JSON payload is a synchronous, unavoidably-blocking browser operation —
// that's what froze the UI. Locations hit this hardest because they
// realistically carry the most/largest photos of the 4 shared types.
//
// Real fix, not another patch: the list endpoint (load_library_assets) now
// NEVER returns full-resolution images — only small thumbnails (a few KB
// each, decoded from a pre-generated ~160px copy). Full-resolution images
// are only ever fetched for the exact asset(s) actually needed —
// get_library_assets_full below — scoped to one asset being edited, or the
// bounded, typically-small set of assets actually linked into the active
// project (see fetchFullLibraryAssets()/ensureLinkedLibraryImagesLoaded()
// in 01-core.js). Never again "every photo of every asset in one response."
//
// Self-healing: existing Location/Prop/Era/Style assets saved before this
// fix shipped still have raw base64 baked into their JSON file today. Both
// load_library_assets and get_library_assets_full detect this (asset still
// has a raw 'images' object, not yet 'image_files') and extract it on the
// spot, once, transparently — no separate migration step to run by hand.

function extract_library_images(&$asset, $dir, $id, $existing_files = [], $existing_thumbs = []) {
    if (empty($asset['images']) || !is_array($asset['images'])) return;
    $image_files = [];
    $thumb_files = [];
    foreach ($asset['images'] as $slot_key => $val) {
        $slot_key = preg_replace('/[^a-z0-9_\-]/i', '', $slot_key);
        if (empty($val)) {
            if (!empty($existing_files[$slot_key])) @unlink($dir . '/' . $existing_files[$slot_key]);
            if (!empty($existing_thumbs[$slot_key])) @unlink($dir . '/' . $existing_thumbs[$slot_key]);
            continue;
        }
        if (preg_match('/^data:image\/(\w+);base64,/', $val, $matches)) {
            // Fresh (or still-unmigrated) base64 for this slot — write the
            // full file plus a small thumbnail, replace any prior file.
            $ext = $matches[1];
            $raw = preg_replace('/^data:image\/\w+;base64,/', '', $val);
            $decoded = base64_decode($raw);
            if ($decoded === false) continue;
            if (strlen($decoded) > MAX_UPLOAD_MB * 1024 * 1024) {
                error('Image (' . $slot_key . ') exceeds ' . MAX_UPLOAD_MB . 'MB limit');
            }
            if (!empty($existing_files[$slot_key])) @unlink($dir . '/' . $existing_files[$slot_key]);
            if (!empty($existing_thumbs[$slot_key])) @unlink($dir . '/' . $existing_thumbs[$slot_key]);
            $filename = $id . '_' . $slot_key . '.' . $ext;
            file_put_contents($dir . '/' . $filename, $decoded);
            $image_files[$slot_key] = $filename;
            $thumb_name = $id . '_' . $slot_key . '_thumb.jpg';
            if (make_thumbnail_from_data($decoded, $dir . '/' . $thumb_name)) {
                $thumb_files[$slot_key] = $thumb_name;
            }
        } else {
            // Not a data URL — front end is carrying forward an unchanged
            // slot (mirrors save_asset's identical carry-forward branch).
            $image_files[$slot_key] = $existing_files[$slot_key] ?? null;
            $thumb_files[$slot_key] = $existing_thumbs[$slot_key] ?? null;
        }
    }
    $asset['image_files'] = $image_files;
    $asset['thumb_files'] = $thumb_files;
    unset($asset['images']);
}

// GD-based downscale, guarded so a server without the gd extension just
// silently skips thumbnails (grid falls back to a placeholder) rather than
// failing the save/load outright.
function make_thumbnail_from_data($decoded_bytes, $dest_path, $max_dim = THUMB_MIN_DIM) {
    if (!extension_loaded('gd')) return false;
    $src = @imagecreatefromstring($decoded_bytes);
    if (!$src) return false;
    $w = imagesx($src); $h = imagesy($src);
    if ($w <= 0 || $h <= 0) { imagedestroy($src); return false; }
    $scale = min(1, $max_dim / max($w, $h));
    $nw = max(1, (int)round($w * $scale));
    $nh = max(1, (int)round($h * $scale));
    $dst = imagecreatetruecolor($nw, $nh);
    $white = imagecolorallocate($dst, 255, 255, 255);
    imagefilledrectangle($dst, 0, 0, $nw, $nh, $white);
    imagecopyresampled($dst, $src, 0, 0, 0, 0, $nw, $nh, $w, $h);
    $ok = imagejpeg($dst, $dest_path, 80);
    imagedestroy($src);
    imagedestroy($dst);
    return $ok;
}

// Ensures a thumbnail file exists for one already-on-disk full image,
// generating it from the full file if missing. Returns the thumbnail's
// filename, or null if it couldn't be made (no gd, missing source, etc).
//
// Self-heal (2026-07-09): thumbnails made before THUMB_MIN_DIM was raised
// from 160px are still sitting on disk at the old low resolution — visibly
// soft/pixelated once stretched to fill an asset card. Rather than require
// a manual cleanup step, check the existing thumb's actual dimensions (a
// cheap getimagesize() header read, not a full decode) and regenerate in
// place if it's below the current target. Every asset sharpens up
// automatically the next time its list is loaded, matching the same
// self-heal-on-read pattern already used for the images/image_files
// migration above.
function ensure_thumb_file($dir, $thumb_name, $full_filename, $min_dim = THUMB_MIN_DIM) {
    if (empty($full_filename)) return null;
    $thumb_path = $dir . '/' . $thumb_name;
    if (file_exists($thumb_path)) {
        $info = @getimagesize($thumb_path);
        if ($info && max($info[0], $info[1]) >= $min_dim) return $thumb_name;
        // else: stale/low-res (or unreadable) — fall through and regenerate
    }
    $full_path = $dir . '/' . $full_filename;
    if (!file_exists($full_path)) return null;
    $bytes = file_get_contents($full_path);
    if ($bytes === false) return null;
    return make_thumbnail_from_data($bytes, $thumb_path, $min_dim) ? $thumb_name : null;
}

// Reattaches FULL-resolution images (legacy single-image + multi-slot) as
// base64 onto $asset — same reattachment pattern load_assets (characters,
// above) already uses. Only ever called for a bounded, specific set of
// assets (one being edited, or a project's actually-linked set) — never
// for a whole type's list, which is the entire point of this fix.
function attach_full_library_images(&$asset, $dir) {
    if (!empty($asset['image_file'])) {
        $img_path = $dir . '/' . $asset['image_file'];
        if (file_exists($img_path)) {
            $ext = pathinfo($img_path, PATHINFO_EXTENSION);
            $asset['image_data'] = 'data:image/' . $ext . ';base64,' . base64_encode(file_get_contents($img_path));
        }
    }
    if (!empty($asset['image_files']) && is_array($asset['image_files'])) {
        $images = [];
        foreach ($asset['image_files'] as $slot_key => $filename) {
            if (empty($filename)) { $images[$slot_key] = null; continue; }
            $img_path = $dir . '/' . $filename;
            if (file_exists($img_path)) {
                $ext = pathinfo($img_path, PATHINFO_EXTENSION);
                $images[$slot_key] = 'data:image/' . $ext . ';base64,' . base64_encode(file_get_contents($img_path));
            } else {
                $images[$slot_key] = null;
            }
        }
        $asset['images'] = $images;
    }
}

// ─── Archived originals (2026-07-08, user-requested) ────────────────────────
// The client now resizes every upload down to the recommended working size
// (~1568px, Canvas API, no AI involved) BEFORE it's ever sent here — that
// resized copy is what arrives in asset['images'] and goes through the
// normal extract/attach functions above, same as everything else in today's
// fix. The user asked to also keep the ORIGINAL heavy file the person
// actually selected, in case they want it back later, WITHOUT reintroducing
// today's freeze: so the original arrives separately in
// asset['originalUploads'] and is archived to its own file, tracked in
// 'original_files' — a field that NONE of load_assets, load_library_assets,
// get_library_assets_full, attach_full_library_images, or the AI-analysis
// endpoint (analyse_image) ever read. It is retrievable ONLY via the
// dedicated get_asset_original/get_library_asset_original download actions
// below, which stream the file directly rather than embedding it as base64
// in any JSON response — so an archived original can never end up back in
// a list, grid, reference-resolution, or AI-analysis payload.
function archive_original_uploads(&$asset, $dir, $id, $existing_json) {
    if (empty($asset['originalUploads']) || !is_array($asset['originalUploads'])) {
        unset($asset['originalUploads']);
        return;
    }
    $existing_originals = ($existing_json && !empty($existing_json['original_files'])) ? $existing_json['original_files'] : [];
    $original_files = $existing_originals;
    foreach ($asset['originalUploads'] as $slot_key => $val) {
        $slot_key = preg_replace('/[^a-z0-9_\-]/i', '', $slot_key);
        if (empty($val) || !preg_match('/^data:image\/(\w+);base64,/', $val, $m)) continue;
        $ext = $m[1];
        $raw = preg_replace('/^data:image\/\w+;base64,/', '', $val);
        $decoded = base64_decode($raw);
        if ($decoded === false) continue;
        // Generous cap, independent of MAX_UPLOAD_MB (which governs the
        // resized working copy) — this is the raw original, phone/camera
        // photos can legitimately run larger.
        if (strlen($decoded) > 25 * 1024 * 1024) continue;
        if (!empty($existing_originals[$slot_key])) @unlink($dir . '/' . $existing_originals[$slot_key]);
        $filename = $id . '_' . $slot_key . '_original.' . $ext;
        file_put_contents($dir . '/' . $filename, $decoded);
        $original_files[$slot_key] = $filename;
    }
    $asset['original_files'] = $original_files;
    unset($asset['originalUploads']); // never written to the JSON as-is
}

// Streams an archived original file directly (not JSON/base64) so
// retrieving it never costs a big JSON parse the way this whole fix was
// about avoiding. Ends the request itself (bypasses the JSON envelope).
function stream_original_file($dir, $asset_json_path, $slot_key) {
    $asset = read_json($asset_json_path);
    if (!$asset || empty($asset['original_files'][$slot_key])) error('No archived original for this slot', 404);
    $filename = $asset['original_files'][$slot_key];
    $path = $dir . '/' . $filename;
    if (!file_exists($path)) error('Archived original file missing', 404);
    $ext = strtolower(pathinfo($path, PATHINFO_EXTENSION));
    $mime = ($ext === 'jpg') ? 'jpeg' : $ext;
    header('Content-Type: image/' . $mime);
    header('Content-Disposition: attachment; filename="' . $filename . '"');
    header('Content-Length: ' . filesize($path));
    readfile($path);
    exit;
}

function user_meta_path($username) {
    return user_path($username) . '/user.json';
}

// ─── Sponsor key encryption ─────────────────────────────────────────────────
// Stored API keys are encrypted at rest (not plaintext in user.json) using a
// secret derived from this app install. This is NOT a substitute for a real
// secrets vault, but it means a casual file read (backup, misconfigured
// permission, etc.) doesn't hand over a usable key directly. The encryption
// key itself lives in this codebase, so anyone with code-level server access
// could still decrypt it — the .htaccess deny rules on userdata/ are the
// primary defence; this is a second layer on top of that.
define('SPONSOR_KEY_SECRET_FILE', USERDATA_ROOT . '/.secret');

function get_app_secret() {
    if (!file_exists(SPONSOR_KEY_SECRET_FILE)) {
        ensure_dir(USERDATA_ROOT);
        file_put_contents(SPONSOR_KEY_SECRET_FILE, bin2hex(random_bytes(32)));
        @chmod(SPONSOR_KEY_SECRET_FILE, 0600);
    }
    return trim(file_get_contents(SPONSOR_KEY_SECRET_FILE));
}

function encrypt_secret($plaintext) {
    $key = hash('sha256', get_app_secret(), true);
    $iv = random_bytes(16);
    $cipher = openssl_encrypt($plaintext, 'AES-256-CBC', $key, OPENSSL_RAW_DATA, $iv);
    return base64_encode($iv . $cipher);
}

function decrypt_secret($encoded) {
    if (!$encoded) return null;
    $key = hash('sha256', get_app_secret(), true);
    $raw = base64_decode($encoded);
    if ($raw === false || strlen($raw) < 17) return null;
    $iv = substr($raw, 0, 16);
    $cipher = substr($raw, 16);
    $plain = openssl_decrypt($cipher, 'AES-256-CBC', $key, OPENSSL_RAW_DATA, $iv);
    return $plain === false ? null : $plain;
}

// ─── Per-request password verification ─────────────────────────────────────
// Most existing actions (save_project, load_assets, etc.) trust the
// `username` field at face value — fine for low-stakes asset/project data on
// a small trusted-friends app. Anything touching a real API key or another
// user's billing budget (saving/reading the sponsor key, using the proxy)
// must NOT extend that same trust: this verifies the caller actually knows
// the password for the username they claim to be, and stops the request
// with a 401 if not. Accounts with no password set yet (pre-migration
// legacy users) are rejected here — they must finish password setup first.
function require_password($username, $password) {
    $meta = read_json(user_meta_path($username));
    if (!$meta || empty($meta['password_hash'])) {
        error('Account not secured with a password yet', 401);
    }
    if (!$password || !password_verify($password, $meta['password_hash'])) {
        error('Incorrect password', 401);
    }
    return $meta;
}

/* Hashes a security answer in a normalised way (lowercase, trimmed) so
   minor casing/whitespace differences don't lock a user out of reset. */
function hash_security_answer($answer) {
    $normalised = strtolower(trim($answer));
    return password_hash($normalised, PASSWORD_DEFAULT);
}

// ─── Input ────────────────────────────────────────────────────────────────────

$input = json_decode(file_get_contents('php://input'), true) ?? [];
$action = $_GET['action'] ?? $input['action'] ?? '';
$username = sanitize_name($input['username'] ?? $_GET['username'] ?? '');

if (!$action) error('Missing action');

// ─── Actions ──────────────────────────────────────────────────────────────────

switch ($action) {

    // ── User ──────────────────────────────────────────────────────────────────

    case 'create_user':
        // Doubles as both "register" (brand new username) and "login"
        // (existing username) — matches the original get-or-create flow,
        // but now enforces a password once one has been set for that
        // username. Existing users from before this change have no
        // password yet, so their first call here "claims" the account by
        // setting whatever password is supplied (one-time migration path).
        $raw = $input['username'] ?? '';
        if (!$raw) error('Missing username');
        $safe = sanitize_name($raw);
        if (strlen($safe) < 2) error('Username too short or invalid');

        $password = $input['password'] ?? '';
        $security_question = trim($input['security_question'] ?? '');
        $security_answer   = $input['security_answer'] ?? '';

        $meta_path = user_meta_path($safe);
        $meta = read_json($meta_path);

        if ($meta && !empty($meta['password_hash'])) {
            // Existing, already-secured account — password is required and must match.
            if (!$password) error('Password required for this username', 401);
            if (!password_verify($password, $meta['password_hash'])) {
                error('Incorrect password', 401);
            }
        } else {
            // Brand-new username OR a legacy username with no password yet.
            if (!$password || strlen($password) < 4) {
                error('Please set a password (at least 4 characters)', 400);
            }
            $path = user_path($safe) . '/projects';
            ensure_dir($path);
            $meta = $meta ?? ['username' => $safe, 'display_name' => $raw];
            $meta['password_hash'] = password_hash($password, PASSWORD_DEFAULT);
            if ($security_question && $security_answer) {
                $meta['security_question'] = $security_question;
                $meta['security_answer_hash'] = hash_security_answer($security_answer);
            }
            write_json($meta_path, $meta);
        }

        success(['username' => $safe, 'display_name' => $meta['display_name'] ?? $raw]);
        break;

    case 'get_security_question':
        // Used by the "Forgot password?" flow — looks up the question
        // (never the answer) for a given username so the client can show it.
        $safe = sanitize_name($input['username'] ?? '');
        if (!$safe) error('Missing username');
        $meta = read_json(user_meta_path($safe));
        if (!$meta || empty($meta['security_question'])) {
            error('No security question set for this username', 404);
        }
        success(['security_question' => $meta['security_question']]);
        break;

    case 'reset_password':
        // Self-service reset via security question — no email/OTP involved.
        $safe = sanitize_name($input['username'] ?? '');
        if (!$safe) error('Missing username');
        $answer = $input['security_answer'] ?? '';
        $new_password = $input['new_password'] ?? '';
        if (!$answer) error('Missing security answer');
        if (!$new_password || strlen($new_password) < 4) {
            error('Please set a new password (at least 4 characters)', 400);
        }
        $meta_path = user_meta_path($safe);
        $meta = read_json($meta_path);
        if (!$meta || empty($meta['security_answer_hash'])) {
            error('No security question set for this username — ask the project owner to reset it manually', 404);
        }
        $normalised = strtolower(trim($answer));
        if (!password_verify($normalised, $meta['security_answer_hash'])) {
            error('Security answer did not match', 401);
        }
        $meta['password_hash'] = password_hash($new_password, PASSWORD_DEFAULT);
        write_json($meta_path, $meta);
        success(['username' => $safe]);
        break;

    case 'check_password_status':
        // Used on app init for a username already saved in localStorage from
        // before password login existed — tells the client whether this
        // account still needs a one-time forced password setup.
        $safe = sanitize_name($input['username'] ?? '');
        if (!$safe) error('Missing username');
        $meta = read_json(user_meta_path($safe));
        $has_password = !empty($meta['password_hash']);
        success(['has_password' => $has_password]);
        break;

    // ── Sponsored API key ────────────────────────────────────────────────────

    case 'save_sponsor_key':
        // Owner saves/updates their own Anthropic and/or Gemini key on the
        // server, plus the list of usernames allowed to use it. Requires the
        // owner's own password — this is the action that writes a real,
        // spendable credential, so it must not trust a bare username field.
        $safe = sanitize_name($input['username'] ?? '');
        if (!$safe) error('Missing username');
        require_password($safe, $input['password'] ?? '');

        $meta_path = user_meta_path($safe);
        $meta = read_json($meta_path) ?? ['username' => $safe];

        $meta['sponsor'] = $meta['sponsor'] ?? [];

        // Keys are optional individually — only overwrite a provider's key
        // if a non-empty value was actually supplied, so the owner can update
        // just the allowlist without having to re-paste both keys every time.
        if (isset($input['anthropic_key']) && $input['anthropic_key'] !== '') {
            $meta['sponsor']['anthropic_key_enc'] = encrypt_secret($input['anthropic_key']);
        }
        if (isset($input['gemini_key']) && $input['gemini_key'] !== '') {
            $meta['sponsor']['gemini_key_enc'] = encrypt_secret($input['gemini_key']);
        }

        if (isset($input['sponsored_usernames']) && is_array($input['sponsored_usernames'])) {
            $clean = [];
            foreach ($input['sponsored_usernames'] as $u) {
                $u = sanitize_name($u);
                if ($u && $u !== $safe && !in_array($u, $clean, true)) $clean[] = $u;
            }
            $meta['sponsor']['usernames'] = $clean;
        }

        write_json($meta_path, $meta);
        success([
            'sponsored_usernames' => $meta['sponsor']['usernames'] ?? [],
            'has_anthropic_key'   => !empty($meta['sponsor']['anthropic_key_enc']),
            'has_gemini_key'      => !empty($meta['sponsor']['gemini_key_enc']),
        ]);
        break;

    case 'get_sponsor_settings':
        // Owner views their own current sponsor config (allowlist + whether
        // keys are set — never the keys themselves). Requires own password.
        $safe = sanitize_name($input['username'] ?? '');
        if (!$safe) error('Missing username');
        require_password($safe, $input['password'] ?? '');
        $meta = read_json(user_meta_path($safe)) ?? [];
        $sponsor = $meta['sponsor'] ?? [];
        success([
            'sponsored_usernames' => $sponsor['usernames'] ?? [],
            'has_anthropic_key'   => !empty($sponsor['anthropic_key_enc']),
            'has_gemini_key'      => !empty($sponsor['gemini_key_enc']),
        ]);
        break;

    case 'get_sponsor_status':
        // A user checks whether THEY are currently sponsored by anyone, and
        // by whom + which providers — used by the client to decide whether
        // to show "use sponsored key" instead of "add your own key". Requires
        // the caller's own password (just proves who's asking; doesn't touch
        // any key material).
        $safe = sanitize_name($input['username'] ?? '');
        if (!$safe) error('Missing username');
        require_password($safe, $input['password'] ?? '');

        $sponsors = [];
        if (is_dir(USERDATA_ROOT)) {
            foreach (scandir(USERDATA_ROOT) as $entry) {
                if ($entry[0] === '.' || $entry === '_shared') continue;
                if ($entry === $safe) continue;
                $owner_meta = read_json(USERDATA_ROOT . '/' . $entry . '/user.json');
                $sponsor = $owner_meta['sponsor'] ?? null;
                if ($sponsor && in_array($safe, $sponsor['usernames'] ?? [], true)) {
                    $sponsors[] = [
                        'owner_username'    => $entry,
                        'has_anthropic_key'  => !empty($sponsor['anthropic_key_enc']),
                        'has_gemini_key'     => !empty($sponsor['gemini_key_enc']),
                    ];
                }
            }
        }
        success(['sponsors' => $sponsors]);
        break;

    case 'analyse_image':
        // Server-side vision proxy. The sponsored user's raw image + a
        // ready-made prompt (built client-side, no key needed for that part)
        // come in; this action decrypts the OWNER's key server-side, calls
        // the provider via curl, and returns only the parsed result. The
        // owner's key never reaches the sponsored user's browser at any point.
        // Vision calls can run close to (or past) PHP's default 30s
        // max_execution_time, especially over a LAN with modest upstream
        // bandwidth — when that limit hits, PHP kills the script mid-curl
        // with no response at all, which the browser surfaces as a generic
        // "Load failed" (no JSON body to show a real error). Raise the
        // script's own limit so it comfortably outlasts the curl timeout
        // below (60s) and a real success/error response always gets sent.
        set_time_limit(90);
        $safe = sanitize_name($input['username'] ?? '');
        if (!$safe) error('Missing username');
        require_password($safe, $input['password'] ?? '');

        $owner_username = sanitize_name($input['owner_username'] ?? '');
        if (!$owner_username) error('Missing owner_username');
        $provider = $input['provider'] ?? 'anthropic';
        if (!in_array($provider, ['anthropic', 'gemini'], true)) error('Invalid provider');

        $owner_meta = read_json(user_meta_path($owner_username));
        $sponsor = $owner_meta['sponsor'] ?? null;
        if (!$sponsor || !in_array($safe, $sponsor['usernames'] ?? [], true)) {
            error('You are not on this owner\'s sponsor list', 403);
        }

        $key_field = $provider === 'gemini' ? 'gemini_key_enc' : 'anthropic_key_enc';
        $enc_key = $sponsor[$key_field] ?? null;
        if (!$enc_key) error('Owner has not set a ' . $provider . ' key', 400);
        $api_key = decrypt_secret($enc_key);
        if (!$api_key) error('Could not decrypt sponsor key', 500);

        $media_type = $input['mediaType'] ?? '';
        $base64_data = $input['base64Data'] ?? '';
        $system_prompt = $input['systemPrompt'] ?? '';
        $user_prompt = $input['userPrompt'] ?? '';
        $max_tokens = (int)($input['maxTokens'] ?? 600);
        if (!$media_type || !$base64_data || !$user_prompt) error('Missing image or prompt');

        if ($provider === 'anthropic') {
            $payload = [
                'model' => $input['model'] ?? 'claude-haiku-4-5-20251001',
                'max_tokens' => $max_tokens,
                'system' => $system_prompt,
                'messages' => [[
                    'role' => 'user',
                    'content' => [
                        ['type' => 'image', 'source' => ['type' => 'base64', 'media_type' => $media_type, 'data' => $base64_data]],
                        ['type' => 'text', 'text' => $user_prompt],
                    ],
                ]],
            ];
            $ch = curl_init('https://api.anthropic.com/v1/messages');
            curl_setopt_array($ch, [
                CURLOPT_RETURNTRANSFER => true,
                CURLOPT_POST => true,
                CURLOPT_HTTPHEADER => [
                    'Content-Type: application/json',
                    'x-api-key: ' . $api_key,
                    'anthropic-version: 2023-06-01',
                ],
                CURLOPT_POSTFIELDS => json_encode($payload),
                CURLOPT_TIMEOUT => 60,
            ]);
            $raw_response = curl_exec($ch);
            $http_code = curl_getinfo($ch, CURLINFO_HTTP_CODE);
            $curl_err = curl_error($ch);
            curl_close($ch);
            if ($raw_response === false) error('Upstream request failed: ' . $curl_err, 502);
            $data = json_decode($raw_response, true);
            if ($http_code >= 400) error($data['error']['message'] ?? ('Upstream HTTP ' . $http_code), 502);
            $result_text = trim($data['content'][0]['text'] ?? '');
        } else {
            $model = $input['model'] ?? 'gemini-2.0-flash';
            $payload = [
                'contents' => [[
                    'parts' => [
                        ['text' => $user_prompt],
                        ['inline_data' => ['mime_type' => $media_type, 'data' => $base64_data]],
                    ],
                ]],
                'generationConfig' => ['maxOutputTokens' => $max_tokens],
            ];
            $url = 'https://generativelanguage.googleapis.com/v1beta/models/' . $model . ':generateContent?key=' . urlencode($api_key);
            $ch = curl_init($url);
            curl_setopt_array($ch, [
                CURLOPT_RETURNTRANSFER => true,
                CURLOPT_POST => true,
                CURLOPT_HTTPHEADER => ['Content-Type: application/json'],
                CURLOPT_POSTFIELDS => json_encode($payload),
                CURLOPT_TIMEOUT => 60,
            ]);
            $raw_response = curl_exec($ch);
            $http_code = curl_getinfo($ch, CURLINFO_HTTP_CODE);
            $curl_err = curl_error($ch);
            curl_close($ch);
            if ($raw_response === false) error('Upstream request failed: ' . $curl_err, 502);
            $data = json_decode($raw_response, true);
            if ($http_code >= 400) error($data['error']['message'] ?? ('Upstream HTTP ' . $http_code), 502);
            $parts = $data['candidates'][0]['content']['parts'] ?? [];
            $result_text = trim(implode('', array_column($parts, 'text')));
        }

        // Upstream returned 2xx but with no usable text — this happens e.g.
        // when the model hits a content filter, runs out of max_tokens before
        // producing anything, or the response shape didn't match what we
        // expected. Surface this as a real error rather than silently
        // returning success with nothing in it (the client would otherwise
        // have no idea why nothing showed up).
        if ($result_text === '') {
            error('Provider returned an empty response — try again or check the owner\'s key/quota', 502);
        }

        // Basic usage log — date, sponsored username, owner, provider, asset
        // type. No token/cost accounting, per the agreed scope.
        $log_path = USERDATA_ROOT . '/_sponsor_usage.log';
        $log_line = sprintf(
            "%s\t%s\t%s\t%s\t%s\n",
            date('Y-m-d H:i:s'),
            $safe,
            $owner_username,
            $provider,
            $input['assetType'] ?? ''
        );
        @file_put_contents($log_path, $log_line, FILE_APPEND | LOCK_EX);

        success(['rawText' => $result_text]);
        break;

    // ── Backup settings (Task #1, 2026-06-25) ───────────────────────────────────
    // These two actions only read/write the config file that tells the
    // standalone backup.php cron script where to write snapshots, and report
    // the result of the most recent run (written by backup.php itself after
    // each run). They do NOT perform a backup — that only ever happens via
    // backup.php, invoked by cron, so the schedule is real (server-side,
    // independent of anyone having the app open) rather than tied to a page
    // load. See backup.php's file header for the full design.
    case 'get_backup_settings':
        $cfg = read_json(BACKUP_CONFIG_FILE) ?? [];
        success([
            'backup_dir'   => $cfg['backup_dir'] ?? '',
            'last_run_at'  => $cfg['last_run_at'] ?? null,
            'last_run_ok'  => $cfg['last_run_ok'] ?? null,
            'last_run_msg' => $cfg['last_run_msg'] ?? null
        ]);
        break;

    case 'save_backup_settings':
        $dir = trim($input['backup_dir'] ?? '');
        if (!$dir) error('Missing backup_dir');

        // Must be an absolute path — a relative one would resolve differently
        // depending on whether backup.php is run via cron (no cwd assumption
        // should be made) vs. browsed to directly, silently writing backups
        // to the wrong place.
        $is_absolute = (substr($dir, 0, 1) === '/') || preg_match('/^[A-Za-z]:[\\\\\/]/', $dir);
        if (!$is_absolute) error('Backup path must be absolute (e.g. /Users/you/SS_Studio_Backups)');

        // Refuse a path inside the document root or inside userdata/ itself —
        // defeats the point of an independent backup (a wipe of this install
        // would take the backups with it) and risks the backup script
        // recursively zipping its own previous output on every run.
        $doc_root_real = realpath(__DIR__);
        $existing_or_parent = $dir;
        while (!is_dir($existing_or_parent) && strlen($existing_or_parent) > 1) {
            $existing_or_parent = dirname($existing_or_parent);
        }
        $existing_real = realpath($existing_or_parent);
        if ($doc_root_real && $existing_real && strpos($existing_real, $doc_root_real) === 0) {
            error('Backup directory must be outside this app\'s folder, not inside it');
        }

        if (!is_dir($dir)) {
            if (!@mkdir($dir, 0755, true)) {
                error('Could not create that directory — check the path and permissions');
            }
        }
        if (!is_writable($dir)) {
            error('That directory is not writable by the web/cron user');
        }

        $cfg = read_json(BACKUP_CONFIG_FILE) ?? [];
        $cfg['backup_dir'] = rtrim($dir, '/\\');
        write_json(BACKUP_CONFIG_FILE, $cfg);
        success(['backup_dir' => $cfg['backup_dir']]);
        break;

    case 'run_backup_now':
        // Manual "Backup Now" button (Settings > Backup). Runs the exact
        // same logic as the cron job (backup.php), via the shared function
        // in backup-core.php — see that file's header for why it's shared.
        // Runs synchronously: a full backup (zip app code + copy userdata/)
        // can take a while on a large library, so the request will hang
        // until it's done. The UI shows a "Running…" state while it waits.
        require_once __DIR__ . '/backup-core.php';
        $result = run_ss_studio_backup(__DIR__, USERDATA_ROOT, BACKUP_CONFIG_FILE, 2);
        if (!$result['ok']) {
            error($result['msg']);
        }
        success(['msg' => $result['msg']]);
        break;

    case 'list_users':
        $users = [];
        if (is_dir(USERDATA_ROOT)) {
            foreach (scandir(USERDATA_ROOT) as $entry) {
                if ($entry[0] === '.') continue;
                if (is_dir(USERDATA_ROOT . '/' . $entry)) {
                    $meta_path = USERDATA_ROOT . '/' . $entry . '/user.json';
                    $meta = read_json($meta_path) ?? ['username' => $entry, 'display_name' => $entry];
                    $users[] = $meta;
                }
            }
        }
        success(['users' => $users]);
        break;

    // ── Projects ──────────────────────────────────────────────────────────────

    case 'load_projects':
        if (!$username) error('Missing username');
        $projects_dir = user_path($username) . '/projects';
        ensure_dir($projects_dir);
        $projects = [];
        foreach (scandir($projects_dir) as $entry) {
            if ($entry[0] === '.') continue;
            $meta = read_json($projects_dir . '/' . $entry . '/project.json');
            if ($meta) $projects[] = $meta;
        }
        // Sort by updated desc
        usort($projects, fn($a, $b) => ($b['updated'] ?? 0) <=> ($a['updated'] ?? 0));
        success(['projects' => $projects]);
        break;

    case 'save_project':
        if (!$username) error('Missing username');
        $project = $input['project'] ?? null;
        if (!$project) error('Missing project data');
        $id = sanitize_name($project['id'] ?? generate_id('proj_'));
        $project['id'] = $id;
        $project['updated'] = time();
        if (empty($project['created'])) $project['created'] = time();
        $path = project_path($username, $id);
        ensure_dir($path . '/assets');
        ensure_dir($path . '/shots');
        write_json($path . '/project.json', $project);
        success(['project' => $project]);
        break;

    case 'delete_project':
        if (!$username) error('Missing username');
        $id = sanitize_name($input['project_id'] ?? '');
        if (!$id) error('Missing project_id');
        $path = project_path($username, $id);
        if (!is_dir($path)) error('Project not found', 404);
        // Recursive delete
        $files = new RecursiveIteratorIterator(
            new RecursiveDirectoryIterator($path, RecursiveDirectoryIterator::SKIP_DOTS),
            RecursiveIteratorIterator::CHILD_FIRST
        );
        foreach ($files as $f) {
            $f->isDir() ? rmdir($f->getRealPath()) : unlink($f->getRealPath());
        }
        rmdir($path);
        success();
        break;

    // ── Assets ────────────────────────────────────────────────────────────────

    case 'save_asset':
        if (!$username) error('Missing username');
        $project_id = sanitize_name($input['project_id'] ?? '');
        if (!$project_id) error('Missing project_id');
        $asset = $input['asset'] ?? null;
        if (!$asset) error('Missing asset data');

        $id = sanitize_name($asset['id'] ?? generate_id('asset_'));
        $asset['id'] = $id;
        $asset['updated'] = time();
        if (empty($asset['created'])) $asset['created'] = time();

        $assets_dir = project_path($username, $project_id) . '/assets';
        ensure_dir($assets_dir);

        // Legacy single-image field (still supported for older callers).
        if (!empty($asset['image_data'])) {
            $img_data = $asset['image_data'];
            // Strip data URI prefix if present
            if (preg_match('/^data:image\/(\w+);base64,/', $img_data, $matches)) {
                $ext = $matches[1];
                $img_data = preg_replace('/^data:image\/\w+;base64,/', '', $img_data);
            } else {
                $ext = 'jpg';
            }
            // Size check
            $decoded = base64_decode($img_data);
            if (strlen($decoded) > MAX_UPLOAD_MB * 1024 * 1024) {
                error('Image exceeds ' . MAX_UPLOAD_MB . 'MB limit');
            }
            $img_filename = $id . '.' . $ext;
            file_put_contents($assets_dir . '/' . $img_filename, $decoded);
            $asset['image_file'] = $img_filename;
            unset($asset['image_data']); // Don't store base64 in JSON
        }

        // Multi-slot images (current front-end shape) — asset['images'] is an
        // object keyed by slot (closeup/midshot/fullbody/sheet, wide/detail,
        // etc. — see IMAGE_SLOTS in 01-core.js). Each value is either a fresh
        // base64 data-URL (new/changed upload), an existing filename carried
        // over unchanged from a prior save, or null (slot empty). Previously
        // this object was never recognised here and got written into the
        // asset JSON verbatim as raw base64 — bloating every asset file and
        // re-shipping all that base64 on every load_assets call. Now each
        // slot's base64 is extracted to its own file on disk, same pattern
        // as the legacy single-image path above, and only the filename is
        // kept in the asset JSON.
        if (!empty($asset['images']) && is_array($asset['images'])) {
            $existing_files = [];
            $existing_json = read_json($assets_dir . '/' . $id . '.json');
            if ($existing_json && !empty($existing_json['image_files'])) {
                $existing_files = $existing_json['image_files'];
            }
            $image_files = [];
            foreach ($asset['images'] as $slot_key => $val) {
                $slot_key = preg_replace('/[^a-z0-9_\-]/i', '', $slot_key);
                if (empty($val)) {
                    // Slot cleared explicitly — drop any old file for it.
                    if (!empty($existing_files[$slot_key])) {
                        @unlink($assets_dir . '/' . $existing_files[$slot_key]);
                    }
                    continue;
                }
                if (preg_match('/^data:image\/(\w+);base64,/', $val, $matches)) {
                    // Fresh upload for this slot — replace any old file.
                    $ext = $matches[1];
                    $raw = preg_replace('/^data:image\/\w+;base64,/', '', $val);
                    $decoded = base64_decode($raw);
                    if (strlen($decoded) > MAX_UPLOAD_MB * 1024 * 1024) {
                        error('Image (' . $slot_key . ') exceeds ' . MAX_UPLOAD_MB . 'MB limit');
                    }
                    if (!empty($existing_files[$slot_key])) {
                        @unlink($assets_dir . '/' . $existing_files[$slot_key]);
                    }
                    $filename = $id . '_' . $slot_key . '.' . $ext;
                    file_put_contents($assets_dir . '/' . $filename, $decoded);
                    $image_files[$slot_key] = $filename;
                } else {
                    // Not a data-URL — front end is carrying forward an
                    // unchanged slot. Keep whatever file we already had.
                    $image_files[$slot_key] = $existing_files[$slot_key] ?? null;
                }
            }
            $asset['image_files'] = $image_files;
            unset($asset['images']); // Don't store base64 in JSON

            // Archived originals (2026-07-08, user-requested) — see the
            // comment block above archive_original_uploads(). $existing_json
            // was already read above for the resized-copy carry-forward
            // logic; reused here so this isn't a second disk read.
            archive_original_uploads($asset, $assets_dir, $id, $existing_json);
        } else {
            unset($asset['originalUploads']);
        }

        write_json($assets_dir . '/' . $id . '.json', $asset);
        success(['asset' => $asset]);
        break;

    case 'get_asset_original':
        // Streams an archived original directly — see
        // stream_original_file()'s comment for why this deliberately never
        // goes through the normal JSON response path.
        $project_id = sanitize_name($input['project_id'] ?? $_GET['project_id'] ?? '');
        $asset_id = sanitize_name($input['asset_id'] ?? $_GET['asset_id'] ?? '');
        $slot_key = sanitize_name($input['slot'] ?? $_GET['slot'] ?? '');
        if (!$project_id || !$asset_id || !$slot_key) error('Missing project_id, asset_id or slot');
        $assets_dir = project_path($username, $project_id) . '/assets';
        stream_original_file($assets_dir, $assets_dir . '/' . $asset_id . '.json', $slot_key);
        break;

    case 'load_assets':
        if (!$username) error('Missing username');
        $project_id = sanitize_name($input['project_id'] ?? $_GET['project_id'] ?? '');
        if (!$project_id) error('Missing project_id');
        $assets_dir = project_path($username, $project_id) . '/assets';
        ensure_dir($assets_dir);
        $assets = [];
        foreach (glob($assets_dir . '/*.json') as $file) {
            $asset = read_json($file);
            if ($asset) {
                // Re-attach legacy single image as base64 if file exists
                if (!empty($asset['image_file'])) {
                    $img_path = $assets_dir . '/' . $asset['image_file'];
                    if (file_exists($img_path)) {
                        $ext = pathinfo($img_path, PATHINFO_EXTENSION);
                        $asset['image_data'] = 'data:image/' . $ext . ';base64,' . base64_encode(file_get_contents($img_path));
                    }
                }
                // Re-attach multi-slot images as base64 per slot, keyed the
                // same way the front end expects (asset.images[slotKey]).
                if (!empty($asset['image_files']) && is_array($asset['image_files'])) {
                    $images = [];
                    foreach ($asset['image_files'] as $slot_key => $filename) {
                        if (empty($filename)) { $images[$slot_key] = null; continue; }
                        $img_path = $assets_dir . '/' . $filename;
                        if (file_exists($img_path)) {
                            $ext = pathinfo($img_path, PATHINFO_EXTENSION);
                            $images[$slot_key] = 'data:image/' . $ext . ';base64,' . base64_encode(file_get_contents($img_path));
                        } else {
                            $images[$slot_key] = null;
                        }
                    }
                    $asset['images'] = $images;
                }
                $assets[] = $asset;
            }
        }
        success(['assets' => $assets]);
        break;

    case 'delete_asset':
        if (!$username) error('Missing username');
        $project_id = sanitize_name($input['project_id'] ?? '');
        $asset_id = sanitize_name($input['asset_id'] ?? '');
        if (!$project_id || !$asset_id) error('Missing project_id or asset_id');
        $assets_dir = project_path($username, $project_id) . '/assets';
        $json_path = $assets_dir . '/' . $asset_id . '.json';
        $asset = read_json($json_path);
        if ($asset && !empty($asset['image_file'])) {
            @unlink($assets_dir . '/' . $asset['image_file']);
        }
        if ($asset && !empty($asset['image_files']) && is_array($asset['image_files'])) {
            foreach ($asset['image_files'] as $filename) {
                if (!empty($filename)) @unlink($assets_dir . '/' . $filename);
            }
        }
        // Archived originals (2026-07-08) — didn't exist before this feature,
        // so nothing to clean up on older records; matches what save now produces.
        if ($asset && !empty($asset['original_files']) && is_array($asset['original_files'])) {
            foreach ($asset['original_files'] as $filename) {
                if (!empty($filename)) @unlink($assets_dir . '/' . $filename);
            }
        }
        @unlink($json_path);
        success();
        break;

    // ── Reference panel (task #2) ───────────────────────────────────────────────

    case 'zip_reference_images':
        // Builds a zip fresh on every call — nothing is pre-built or persisted.
        // Input: items = [{ panel, assetName, slot, image (data URL) }, ...]
        $items = $input['items'] ?? null;
        if (!$items || !is_array($items) || count($items) === 0) {
            error('No items to zip');
        }
        if (!class_exists('ZipArchive')) {
            error('Server does not have the zip extension enabled', 500);
        }

        $tmp_dir = USERDATA_ROOT . '/_tmp_zips';
        ensure_dir($tmp_dir);

        // Clean up zips older than 1 hour so this directory never grows unbounded.
        foreach (glob($tmp_dir . '/*.zip') ?: [] as $old) {
            if (is_file($old) && (time() - filemtime($old)) > 3600) @unlink($old);
        }

        $zip_id = generate_id('refimgs_');
        $zip_filename = $zip_id . '.zip';
        $zip_path = $tmp_dir . '/' . $zip_filename;

        $zip = new ZipArchive();
        if ($zip->open($zip_path, ZipArchive::CREATE | ZipArchive::OVERWRITE) !== true) {
            error('Could not create zip file', 500);
        }

        $used_names = [];
        foreach ($items as $item) {
            $data_url = $item['image'] ?? '';
            if (!preg_match('/^data:image\/(\w+);base64,/', $data_url, $matches)) continue;
            $ext = $matches[1];
            $raw = preg_replace('/^data:image\/\w+;base64,/', '', $data_url);
            $decoded = base64_decode($raw);
            if ($decoded === false) continue;
            if (strlen($decoded) > MAX_UPLOAD_MB * 1024 * 1024) continue;

            $panel_num = (int)($item['panel'] ?? 0);
            $asset_name = sanitize_name($item['assetName'] ?? 'asset');
            $slot = sanitize_name($item['slot'] ?? 'image');
            $base_name = sprintf('panel%02d_%s_%s', $panel_num, $asset_name, $slot);
            $name = $base_name . '.' . $ext;
            $n = 1;
            while (in_array($name, $used_names)) {
                $name = $base_name . '_' . (++$n) . '.' . $ext;
            }
            $used_names[] = $name;
            $zip->addFromString($name, $decoded);
        }

        if ($zip->numFiles === 0) {
            $zip->close();
            @unlink($zip_path);
            error('No valid images to zip');
        }
        $zip->close();

        success([
            'zip_url'  => 'api.php?action=download_zip&id=' . urlencode($zip_id),
            'filename' => 'reference-images.zip'
        ]);
        break;

    case 'download_zip':
        // Streams a zip built by zip_reference_images. Served through api.php
        // (not a direct path) because userdata/ is unconditionally blocked from
        // direct HTTP access — see userdata/.htaccess.
        $zip_id = sanitize_name($_GET['id'] ?? '');
        if (!$zip_id) error('Missing id');
        $zip_path = USERDATA_ROOT . '/_tmp_zips/' . $zip_id . '.zip';
        if (!file_exists($zip_path)) error('Zip not found or expired', 404);

        header('Content-Type: application/zip');
        header('Content-Disposition: attachment; filename="reference-images.zip"');
        header('Content-Length: ' . filesize($zip_path));
        readfile($zip_path);
        @unlink($zip_path); // one-time download — not persisted after fetch
        exit;

    // ── Shots ─────────────────────────────────────────────────────────────────

    case 'save_shot':
        if (!$username) error('Missing username');
        $project_id = sanitize_name($input['project_id'] ?? '');
        if (!$project_id) error('Missing project_id');
        $shot = $input['shot'] ?? null;
        if (!$shot) error('Missing shot data');

        $id = sanitize_name($shot['id'] ?? generate_id('shot_'));
        $shot['id'] = $id;
        $shot['updated'] = time();
        if (empty($shot['created'])) $shot['created'] = time();

        $shots_dir = project_path($username, $project_id) . '/shots';
        ensure_dir($shots_dir);
        write_json($shots_dir . '/' . $id . '.json', $shot);
        success(['shot' => $shot]);
        break;

    case 'load_shots':
        if (!$username) error('Missing username');
        $project_id = sanitize_name($input['project_id'] ?? $_GET['project_id'] ?? '');
        if (!$project_id) error('Missing project_id');
        $shots_dir = project_path($username, $project_id) . '/shots';
        ensure_dir($shots_dir);
        $shots = [];
        foreach (glob($shots_dir . '/*.json') as $file) {
            $shot = read_json($file);
            if ($shot) $shots[] = $shot;
        }
        usort($shots, fn($a, $b) => ($a['created'] ?? 0) <=> ($b['created'] ?? 0));
        success(['shots' => $shots]);
        break;

    case 'delete_shot':
        if (!$username) error('Missing username');
        $project_id = sanitize_name($input['project_id'] ?? '');
        $shot_id = sanitize_name($input['shot_id'] ?? '');
        if (!$project_id || !$shot_id) error('Missing project_id or shot_id');
        @unlink(project_path($username, $project_id) . '/shots/' . $shot_id . '.json');
        success();
        break;

    // ── Sequences ─────────────────────────────────────────────────────────────

    case 'save_sequence':
        if (!$username) error('Missing username');
        $project_id = sanitize_name($input['project_id'] ?? '');
        if (!$project_id) error('Missing project_id');
        $seq = $input['sequence'] ?? null;
        if (!$seq) error('Missing sequence data');

        $id = sanitize_name($seq['id'] ?? generate_id('seq_'));
        $seq['id'] = $id;
        $seq['updated'] = time();
        if (empty($seq['created'])) $seq['created'] = time();

        $seq_path = project_path($username, $project_id) . '/sequences/' . $id;
        ensure_dir($seq_path . '/shots');
        write_json($seq_path . '/sequence.json', $seq);
        success(['sequence' => $seq]);
        break;

    case 'load_sequences':
        if (!$username) error('Missing username');
        $project_id = sanitize_name($input['project_id'] ?? $_GET['project_id'] ?? '');
        if (!$project_id) error('Missing project_id');
        $seqs_dir = project_path($username, $project_id) . '/sequences';
        ensure_dir($seqs_dir);
        $sequences = [];
        foreach (scandir($seqs_dir) as $entry) {
            if ($entry[0] === '.') continue;
            $seq = read_json($seqs_dir . '/' . $entry . '/sequence.json');
            if ($seq) $sequences[] = $seq;
        }
        usort($sequences, fn($a, $b) => ($a['created'] ?? 0) <=> ($b['created'] ?? 0));
        success(['sequences' => $sequences]);
        break;

    case 'delete_sequence':
        if (!$username) error('Missing username');
        $project_id = sanitize_name($input['project_id'] ?? '');
        $seq_id = sanitize_name($input['sequence_id'] ?? '');
        if (!$project_id || !$seq_id) error('Missing project_id or sequence_id');
        $seq_path = project_path($username, $project_id) . '/sequences/' . $seq_id;
        if (is_dir($seq_path)) {
            $files = new RecursiveIteratorIterator(
                new RecursiveDirectoryIterator($seq_path, RecursiveDirectoryIterator::SKIP_DOTS),
                RecursiveIteratorIterator::CHILD_FIRST
            );
            foreach ($files as $f) {
                $f->isDir() ? rmdir($f->getRealPath()) : unlink($f->getRealPath());
            }
            rmdir($seq_path);
        }
        success();
        break;

    case 'save_sequence_shot':
        if (!$username) error('Missing username');
        $project_id = sanitize_name($input['project_id'] ?? '');
        $seq_id = sanitize_name($input['sequence_id'] ?? '');
        if (!$project_id || !$seq_id) error('Missing project_id or sequence_id');
        $shot = $input['shot'] ?? null;
        if (!$shot) error('Missing shot data');

        $id = sanitize_name($shot['id'] ?? generate_id('shot_'));
        $shot['id'] = $id;
        $shot['updated'] = time();
        if (empty($shot['created'])) $shot['created'] = time();

        $shots_dir = project_path($username, $project_id) . '/sequences/' . $seq_id . '/shots';
        ensure_dir($shots_dir);
        write_json($shots_dir . '/' . $id . '.json', $shot);
        success(['shot' => $shot]);
        break;

    case 'load_sequence_shots':
        if (!$username) error('Missing username');
        $project_id = sanitize_name($input['project_id'] ?? $_GET['project_id'] ?? '');
        $seq_id = sanitize_name($input['sequence_id'] ?? $_GET['sequence_id'] ?? '');
        if (!$project_id || !$seq_id) error('Missing project_id or sequence_id');
        $shots_dir = project_path($username, $project_id) . '/sequences/' . $seq_id . '/shots';
        ensure_dir($shots_dir);
        $shots = [];
        foreach (glob($shots_dir . '/*.json') as $file) {
            $shot = read_json($file);
            if ($shot) $shots[] = $shot;
        }
        usort($shots, fn($a, $b) => ($a['created'] ?? 0) <=> ($b['created'] ?? 0));
        success(['shots' => $shots]);
        break;

    case 'delete_sequence_shot':
        if (!$username) error('Missing username');
        $project_id = sanitize_name($input['project_id'] ?? '');
        $seq_id = sanitize_name($input['sequence_id'] ?? '');
        $shot_id = sanitize_name($input['shot_id'] ?? '');
        if (!$project_id || !$seq_id || !$shot_id) error('Missing required fields');
        @unlink(project_path($username, $project_id) . '/sequences/' . $seq_id . '/shots/' . $shot_id . '.json');
        success();
        break;

    // ── Shot Setups (Spatial Blocking Diagram — 2026-07-06-spatial-blocking-diagram-spec.md) ──
    // Project-scoped, like sequences above (not shared-library) — a shot setup's
    // objects[] reference project-scoped character assets via assetId. One flat
    // JSON file per setup (no shots-subfolder needed, unlike sequences: a shot
    // setup's shots[] is a small inline array within the same object, not a
    // separately-growing collection of its own).

    case 'save_shot_setup':
        if (!$username) error('Missing username');
        $project_id = sanitize_name($input['project_id'] ?? '');
        if (!$project_id) error('Missing project_id');
        $setup = $input['shot_setup'] ?? null;
        if (!$setup) error('Missing shot_setup data');

        $id = sanitize_name($setup['id'] ?? generate_id('shotsetup_'));
        $setup['id'] = $id;
        $setup['updated'] = time();
        if (empty($setup['created'])) $setup['created'] = time();

        $dir = project_path($username, $project_id) . '/shot_setups';
        ensure_dir($dir);
        write_json($dir . '/' . $id . '.json', $setup);
        success(['shot_setup' => $setup]);
        break;

    case 'load_shot_setups':
        if (!$username) error('Missing username');
        $project_id = sanitize_name($input['project_id'] ?? $_GET['project_id'] ?? '');
        if (!$project_id) error('Missing project_id');
        $dir = project_path($username, $project_id) . '/shot_setups';
        ensure_dir($dir);
        $setups = [];
        foreach (glob($dir . '/*.json') as $file) {
            $setup = read_json($file);
            if ($setup) $setups[] = $setup;
        }
        usort($setups, fn($a, $b) => ($a['created'] ?? 0) <=> ($b['created'] ?? 0));
        success(['shot_setups' => $setups]);
        break;

    case 'delete_shot_setup':
        if (!$username) error('Missing username');
        $project_id = sanitize_name($input['project_id'] ?? '');
        $setup_id = sanitize_name($input['shot_setup_id'] ?? '');
        if (!$project_id || !$setup_id) error('Missing project_id or shot_setup_id');
        @unlink(project_path($username, $project_id) . '/shot_setups/' . $setup_id . '.json');
        success();
        break;

    // ── Shared custom chips (global vocabulary, all users) ─────────────────────

    case 'load_custom_chips':
        ensure_dir(USERDATA_ROOT . '/_shared');
        $path = USERDATA_ROOT . '/_shared/custom_chips.json';
        $store = read_json($path) ?? [];
        success(['chips' => $store]);
        break;

    case 'save_custom_chip':
        $group = sanitize_name($input['group'] ?? '');
        $value = trim($input['value'] ?? '');
        if (!$group || $value === '') error('Missing group or value');

        ensure_dir(USERDATA_ROOT . '/_shared');
        $path = USERDATA_ROOT . '/_shared/custom_chips.json';
        $lock = fopen($path . '.lock', 'c');
        if ($lock) flock($lock, LOCK_EX);

        $store = read_json($path) ?? [];
        if (!isset($store[$group])) $store[$group] = [];
        if (!in_array($value, $store[$group], true)) $store[$group][] = $value;
        write_json($path, $store);

        if ($lock) { flock($lock, LOCK_UN); fclose($lock); }
        success(['chips' => $store]);
        break;

    case 'delete_custom_chip':
        $group = sanitize_name($input['group'] ?? '');
        $value = trim($input['value'] ?? '');
        if (!$group || $value === '') error('Missing group or value');

        ensure_dir(USERDATA_ROOT . '/_shared');
        $path = USERDATA_ROOT . '/_shared/custom_chips.json';
        $lock = fopen($path . '.lock', 'c');
        if ($lock) flock($lock, LOCK_EX);

        $store = read_json($path) ?? [];
        if (isset($store[$group])) {
            $store[$group] = array_values(array_filter($store[$group], fn($v) => $v !== $value));
        }
        write_json($path, $store);

        if ($lock) { flock($lock, LOCK_UN); fclose($lock); }
        success(['chips' => $store]);
        break;

    case 'rename_custom_chip':
        $group = sanitize_name($input['group'] ?? '');
        $oldValue = trim($input['old_value'] ?? '');
        $newValue = trim($input['new_value'] ?? '');
        if (!$group || $oldValue === '' || $newValue === '') error('Missing group, old_value or new_value');

        ensure_dir(USERDATA_ROOT . '/_shared');
        $path = USERDATA_ROOT . '/_shared/custom_chips.json';
        $lock = fopen($path . '.lock', 'c');
        if ($lock) flock($lock, LOCK_EX);

        $store = read_json($path) ?? [];
        if (isset($store[$group])) {
            $store[$group] = array_values(array_map(fn($v) => $v === $oldValue ? $newValue : $v, $store[$group]));
        }
        write_json($path, $store);

        if ($lock) { flock($lock, LOCK_UN); fclose($lock); }
        success(['chips' => $store]);
        break;

    // ── Shared Library (Character/Location/Prop/Era/Style — all users) ─────────

    case 'load_library_assets':
        // Fable audit H4 root-cause fix (2026-07-08) — see the comment block
        // above library_dir(). This is the actual freeze fix: never again
        // ship full-resolution images for a whole type's list in one
        // response. Metadata is unconditionally sent as before; images are
        // reduced to small per-slot thumbnails only. Anything that needs a
        // real, full-resolution image calls get_library_assets_full below
        // for exactly the asset(s) it actually needs.
        $type = library_type($input['type'] ?? $_GET['type'] ?? '');
        $dir = library_dir($type);
        $assets = [];
        foreach (glob($dir . '/*.json') as $file) {
            // Lock per-asset-file (2026-07-08) — self-healing can now be
            // triggered by this action AND get_library_assets_full touching
            // the SAME still-unmigrated asset around the same time (e.g. a
            // Library list load overlapping a Storyboard's linked-asset
            // fetch). Without a lock, two overlapping read-modify-write
            // sequences could interleave and corrupt the JSON file — and a
            // corrupted file reads back as null forever after, silently
            // dropping that asset from every future load with no error
            // shown anywhere. Matches the same fopen/flock pattern already
            // used for custom_chips.json elsewhere in this file.
            $lock = @fopen($file . '.lock', 'c');
            if ($lock) flock($lock, LOCK_EX);
            $asset = read_json($file);
            if (!$asset) { if ($lock) { flock($lock, LOCK_UN); fclose($lock); } continue; }
            $id = $asset['id'] ?? basename($file, '.json');
            $dirty = false;

            // Self-heal: this record predates the fix and still has raw
            // base64 baked directly into 'images'. Extract it once, right
            // now, exactly as a fresh save would — every asset only ever
            // pays this cost a single time, on its first list read after
            // upgrading. The response below already reflects the lightweight
            // shape regardless, so this list call is cheap for the browser
            // even while this one-time on-disk cleanup is happening.
            if (!empty($asset['images']) && is_array($asset['images'])) {
                extract_library_images($asset, $dir, $id);
                $dirty = true;
            }

            // Legacy single-image field — thumbnail only, same reasoning.
            if (!empty($asset['image_file'])) {
                $thumb_name = ensure_thumb_file($dir, $id . '_thumb.jpg', $asset['image_file']);
                if ($thumb_name) {
                    $asset['thumbnail'] = 'data:image/jpeg;base64,' . base64_encode(file_get_contents($dir . '/' . $thumb_name));
                }
            }

            // Multi-slot images — build/refresh per-slot thumbnails.
            // 2026-07-09: always run this through ensure_thumb_file() rather
            // than short-circuiting on "a thumb file already exists" — that
            // used to skip regeneration forever, which is exactly what let
            // old 160px thumbnails survive silently after THUMB_MIN_DIM was
            // raised. ensure_thumb_file() itself is now dimension-aware and
            // cheap when the thumb is already good (one getimagesize() call,
            // no re-encode), so this stays fast on every normal load.
            if (!empty($asset['image_files']) && is_array($asset['image_files'])) {
                $thumbs = [];
                $existing_thumbs = $asset['thumb_files'] ?? [];
                foreach ($asset['image_files'] as $slot_key => $filename) {
                    if (empty($filename)) { $thumbs[$slot_key] = null; continue; }
                    $prior_name = $existing_thumbs[$slot_key] ?? ($id . '_' . $slot_key . '_thumb.jpg');
                    $thumb_name = ensure_thumb_file($dir, $prior_name, $filename);
                    if ($thumb_name && ($existing_thumbs[$slot_key] ?? null) !== $thumb_name) {
                        $existing_thumbs[$slot_key] = $thumb_name; $dirty = true;
                    }
                    $thumbs[$slot_key] = ($thumb_name && file_exists($dir . '/' . $thumb_name))
                        ? 'data:image/jpeg;base64,' . base64_encode(file_get_contents($dir . '/' . $thumb_name))
                        : null;
                }
                $asset['thumbnails'] = $thumbs;
                $asset['thumb_files'] = $existing_thumbs;
            }

            if ($dirty) write_json($file, $asset);
            if ($lock) { flock($lock, LOCK_UN); fclose($lock); }

            // Never ship full-resolution data or internal filenames in the
            // list response — 'images' (if the self-heal above just ran),
            // 'image_files' and 'thumb_files' are disk-only bookkeeping.
            unset($asset['images'], $asset['image_files'], $asset['thumb_files']);
            $assets[] = $asset;
        }
        success(['assets' => $assets]);
        break;

    case 'get_library_assets_full':
        // Companion to the thumbnail-only list above. Called for exactly
        // the asset(s) actually needed — opening one asset's edit modal, or
        // the bounded set of assets linked into the active project (see
        // fetchFullLibraryAssets()/ensureLinkedLibraryImagesLoaded(),
        // 01-core.js) — never for a whole type's list.
        $type = library_type($input['type'] ?? $_GET['type'] ?? '');
        $ids = $input['ids'] ?? [];
        if (!is_array($ids)) $ids = [$ids];
        // Defense in depth (2026-07-08) — the client (fetchFullLibraryAssets(),
        // 01-core.js) already chunks its requests to a couple of ids at a
        // time, specifically so no single response can ever bundle many
        // assets' real photos together. This caps it server-side too, in
        // case anything ever calls this action directly without going
        // through that chunking.
        if (count($ids) > 6) $ids = array_slice($ids, 0, 6);
        $dir = library_dir($type);
        $assets = [];
        foreach ($ids as $raw_id) {
            $id = sanitize_name($raw_id);
            if (!$id) continue;
            $file = $dir . '/' . $id . '.json';
            // Lock per-asset-file (2026-07-08) — see the matching comment in
            // load_library_assets above for why: this endpoint's self-heal
            // can race with that one over the same still-unmigrated asset.
            $lock = @fopen($file . '.lock', 'c');
            if ($lock) flock($lock, LOCK_EX);
            $asset = read_json($file);
            if (!$asset) { if ($lock) { flock($lock, LOCK_UN); fclose($lock); } continue; }
            if (!empty($asset['images']) && is_array($asset['images'])) {
                extract_library_images($asset, $dir, $id);
                write_json($file, $asset);
            }
            if ($lock) { flock($lock, LOCK_UN); fclose($lock); }
            attach_full_library_images($asset, $dir);
            unset($asset['image_files'], $asset['thumb_files']);
            $assets[] = $asset;
        }
        success(['assets' => $assets]);
        break;

    case 'save_library_asset':
        // Saves a shared asset. If the incoming name differs from the stored
        // record's name (i.e. the user is creating a variant, e.g. "Sarah" ->
        // "Sarah - red dress"), this is treated as Save-As: a NEW asset id is
        // generated and the original record is left untouched. If the name
        // matches, it's an in-place edit to the shared/canon record.
        if (!$username) error('Missing username');
        $type = library_type($input['type'] ?? '');
        $asset = $input['asset'] ?? null;
        if (!$asset) error('Missing asset data');
        $dir = library_dir($type);

        $incoming_id = sanitize_name($asset['id'] ?? '');
        $is_fork = false;

        if ($incoming_id) {
            $existing = read_json($dir . '/' . $incoming_id . '.json');
            if ($existing && isset($asset['name']) && isset($existing['name']) && $asset['name'] !== $existing['name']) {
                $is_fork = true;
            }
        } else {
            $is_fork = true; // brand new asset, no id yet
        }

        $id = $is_fork ? generate_id($type . '_') : $incoming_id;
        $asset['id'] = $id;
        $asset['updated'] = time();
        if ($is_fork || empty($asset['created'])) $asset['created'] = time();
        $asset['createdBy'] = $is_fork ? $username : ($asset['createdBy'] ?? $username);
        $asset['updatedBy'] = $username;

        // Lock this asset's file (2026-07-08) — a save can now overlap with
        // this same asset self-healing via load_library_assets or
        // get_library_assets_full (e.g. saving from the edit modal while a
        // Storyboard tab elsewhere is fetching linked-asset images). Held
        // through the read-existing/extract/write sequence below.
        $save_lock = @fopen($dir . '/' . $id . '.json.lock', 'c');
        if ($save_lock) flock($save_lock, LOCK_EX);

        if (!empty($asset['image_data'])) {
            $img_data = $asset['image_data'];
            if (preg_match('/^data:image\/(\w+);base64,/', $img_data, $matches)) {
                $ext = $matches[1];
                $img_data = preg_replace('/^data:image\/\w+;base64,/', '', $img_data);
            } else {
                $ext = 'jpg';
            }
            $decoded = base64_decode($img_data);
            if (strlen($decoded) > MAX_UPLOAD_MB * 1024 * 1024) {
                error('Image exceeds ' . MAX_UPLOAD_MB . 'MB limit');
            }
            $img_filename = $id . '.' . $ext;
            file_put_contents($dir . '/' . $img_filename, $decoded);
            $asset['image_file'] = $img_filename;
            unset($asset['image_data']);
        }

        // Multi-slot images (Fable audit H4 root-cause fix, 2026-07-08) —
        // this project never extracted asset['images'] to separate files
        // the way save_asset (characters, above) already does. Every slot's
        // full base64 was written verbatim into this JSON file, permanently
        // — see the comment block above library_dir() for the full story
        // and why that's what actually caused the freeze. Now extracted the
        // same way, plus a small thumbnail per slot.
        if (!empty($asset['images']) && is_array($asset['images'])) {
            $existing_json = read_json($dir . '/' . $id . '.json');
            $existing_files = ($existing_json && !empty($existing_json['image_files'])) ? $existing_json['image_files'] : [];
            $existing_thumbs = ($existing_json && !empty($existing_json['thumb_files'])) ? $existing_json['thumb_files'] : [];
            extract_library_images($asset, $dir, $id, $existing_files, $existing_thumbs);

            // Archived originals (2026-07-08, user-requested) — see the
            // comment block above archive_original_uploads(). $existing_json
            // was already read above; reused here, not a second disk read.
            archive_original_uploads($asset, $dir, $id, $existing_json);
        } else {
            unset($asset['originalUploads']);
        }

        write_json($dir . '/' . $id . '.json', $asset);
        if ($save_lock) { flock($save_lock, LOCK_UN); fclose($save_lock); }

        // Reattach full images into the RESPONSE only (not what's written to
        // disk above) — the client patches its in-memory cache straight from
        // res.asset (_patchLibraryCache(), Fable audit H1 fix, 01-core.js),
        // so this keeps that contract working exactly as before: the just-
        // saved photo shows up immediately, no extra round-trip needed.
        $asset_for_response = $asset;
        attach_full_library_images($asset_for_response, $dir);
        unset($asset_for_response['thumb_files']);
        success(['asset' => $asset_for_response, 'forked' => $is_fork]);
        break;

    case 'get_library_asset_original':
        // Streams an archived original directly — see
        // stream_original_file()'s comment for why this deliberately never
        // goes through the normal JSON response path.
        $type = library_type($input['type'] ?? $_GET['type'] ?? '');
        $asset_id = sanitize_name($input['asset_id'] ?? $_GET['asset_id'] ?? '');
        $slot_key = sanitize_name($input['slot'] ?? $_GET['slot'] ?? '');
        if (!$asset_id || !$slot_key) error('Missing asset_id or slot');
        $dir = library_dir($type);
        stream_original_file($dir, $dir . '/' . $asset_id . '.json', $slot_key);
        break;

    case 'delete_library_asset':
        $type = library_type($input['type'] ?? '');
        $asset_id = sanitize_name($input['asset_id'] ?? '');
        if (!$asset_id) error('Missing asset_id');
        $dir = library_dir($type);
        $json_path = $dir . '/' . $asset_id . '.json';
        $asset = read_json($json_path);
        if ($asset && !empty($asset['image_file'])) {
            @unlink($dir . '/' . $asset['image_file']);
        }
        // Multi-slot files + thumbnails (Fable audit H4 fix, 2026-07-08) —
        // didn't exist as separate files before this fix, so nothing to
        // clean up on records saved before it; matches what save now produces.
        if ($asset && !empty($asset['image_files']) && is_array($asset['image_files'])) {
            foreach ($asset['image_files'] as $filename) {
                if (!empty($filename)) @unlink($dir . '/' . $filename);
            }
        }
        if ($asset && !empty($asset['thumb_files']) && is_array($asset['thumb_files'])) {
            foreach ($asset['thumb_files'] as $filename) {
                if (!empty($filename)) @unlink($dir . '/' . $filename);
            }
        }
        // Archived originals (2026-07-08) — didn't exist before this feature,
        // so nothing to clean up on older records; matches what save now produces.
        if ($asset && !empty($asset['original_files']) && is_array($asset['original_files'])) {
            foreach ($asset['original_files'] as $filename) {
                if (!empty($filename)) @unlink($dir . '/' . $filename);
            }
        }
        @unlink($dir . '/' . $asset_id . '_thumb.jpg'); // legacy single-image thumb, untracked in JSON
        @unlink($json_path);
        success();
        break;

    case 'link_project_asset':
        if (!$username) error('Missing username');
        $project_id = sanitize_name($input['project_id'] ?? '');
        $type = library_type($input['type'] ?? '');
        $asset_id = sanitize_name($input['asset_id'] ?? '');
        if (!$project_id || !$asset_id) error('Missing project_id or asset_id');
        $proj_path = project_path($username, $project_id) . '/project.json';
        $project = read_json($proj_path);
        if (!$project) error('Project not found', 404);
        if (!isset($project['linkedAssets'])) $project['linkedAssets'] = [];
        if (!isset($project['linkedAssets'][$type])) $project['linkedAssets'][$type] = [];
        if (!in_array($asset_id, $project['linkedAssets'][$type], true)) {
            $project['linkedAssets'][$type][] = $asset_id;
        }
        $project['updated'] = time();
        write_json($proj_path, $project);
        success(['project' => $project]);
        break;

    case 'unlink_project_asset':
        // Removes the reference only. The shared library asset itself is never
        // deleted by this action — only the project's link to it.
        if (!$username) error('Missing username');
        $project_id = sanitize_name($input['project_id'] ?? '');
        $type = library_type($input['type'] ?? '');
        $asset_id = sanitize_name($input['asset_id'] ?? '');
        if (!$project_id || !$asset_id) error('Missing project_id or asset_id');
        $proj_path = project_path($username, $project_id) . '/project.json';
        $project = read_json($proj_path);
        if (!$project) error('Project not found', 404);
        if (isset($project['linkedAssets'][$type])) {
            $project['linkedAssets'][$type] = array_values(array_filter(
                $project['linkedAssets'][$type], fn($v) => $v !== $asset_id
            ));
        }
        $project['updated'] = time();
        write_json($proj_path, $project);
        success(['project' => $project]);
        break;

    case 'dedupe_library':
        // One-time cleanup: within each shared library type, groups assets by
        // exact name. If a group has more than one record, keeps a single
        // canonical record (oldest 'created' timestamp, or the most complete
        // record if timestamps tie) and deletes the rest. Every project's
        // linkedAssets[type] is rewritten so any reference to a removed
        // duplicate now points at the canonical id instead. Safe to re-run —
        // a name with only one record is left untouched.
        $types = ['character', 'location', 'prop', 'era', 'style'];
        $removed = 0;
        $groups_deduped = 0;
        $id_remap = []; // type => [old_id => canonical_id]

        foreach ($types as $type) {
            $dir = library_dir($type);
            $by_name = [];
            foreach (glob($dir . '/*.json') as $file) {
                $asset = read_json($file);
                if (!$asset || empty($asset['name'])) continue;
                $by_name[$asset['name']][] = $asset;
            }
            $id_remap[$type] = [];
            foreach ($by_name as $name => $records) {
                if (count($records) < 2) continue;
                $groups_deduped++;
                // Pick canonical: oldest 'created', then longest description
                // (proxy for "most complete") as a tiebreaker.
                usort($records, function($a, $b) {
                    $ca = $a['created'] ?? PHP_INT_MAX;
                    $cb = $b['created'] ?? PHP_INT_MAX;
                    if ($ca !== $cb) return $ca <=> $cb;
                    return strlen($b['description'] ?? '') <=> strlen($a['description'] ?? '');
                });
                $canonical = $records[0];
                $canonical_id = $canonical['id'];
                for ($i = 1; $i < count($records); $i++) {
                    $dup = $records[$i];
                    $dup_id = $dup['id'];
                    $id_remap[$type][$dup_id] = $canonical_id;
                    if (!empty($dup['image_file'])) {
                        @unlink($dir . '/' . $dup['image_file']);
                    }
                    @unlink($dir . '/' . $dup_id . '.json');
                    $removed++;
                }
            }
        }

        // Re-point every project's linkedAssets to canonical ids.
        $projects_updated = 0;
        if (is_dir(USERDATA_ROOT)) {
            foreach (scandir(USERDATA_ROOT) as $u) {
                if ($u[0] === '.' || $u === '_shared') continue;
                $projects_dir = USERDATA_ROOT . '/' . $u . '/projects';
                if (!is_dir($projects_dir)) continue;
                foreach (scandir($projects_dir) as $pid) {
                    if ($pid[0] === '.') continue;
                    $proj_json_path = $projects_dir . '/' . $pid . '/project.json';
                    $project = read_json($proj_json_path);
                    if (!$project || empty($project['linkedAssets'])) continue;
                    $changed = false;
                    foreach ($types as $type) {
                        if (empty($project['linkedAssets'][$type])) continue;
                        $remap = $id_remap[$type];
                        if (empty($remap)) continue;
                        $new_ids = [];
                        foreach ($project['linkedAssets'][$type] as $aid) {
                            $mapped = $remap[$aid] ?? $aid;
                            if (!in_array($mapped, $new_ids, true)) $new_ids[] = $mapped;
                            if ($mapped !== $aid) $changed = true;
                        }
                        $project['linkedAssets'][$type] = $new_ids;
                    }
                    if ($changed) {
                        $project['updated'] = time();
                        write_json($proj_json_path, $project);
                        $projects_updated++;
                    }
                }
            }
        }

        success([
            'duplicate_groups' => $groups_deduped,
            'records_removed' => $removed,
            'projects_updated' => $projects_updated
        ]);
        break;

    case 'migrate_library':
        // One-time migration: copies existing per-project Character/Location/
        // Prop/Era/Style assets into the shared library, and links them back
        // to the project they came from. Originals are left in place as a
        // backup (not deleted). Safe to call multiple times — assets already
        // migrated (tracked via project['linkedAssets']) are skipped.
        $types = ['character', 'location', 'prop', 'era', 'style'];
        $migrated = 0;
        $scanned_users = 0;
        if (is_dir(USERDATA_ROOT)) {
            foreach (scandir(USERDATA_ROOT) as $u) {
                if ($u[0] === '.' || $u === '_shared') continue;
                $projects_dir = USERDATA_ROOT . '/' . $u . '/projects';
                if (!is_dir($projects_dir)) continue;
                $scanned_users++;
                foreach (scandir($projects_dir) as $pid) {
                    if ($pid[0] === '.') continue;
                    $proj_dir = $projects_dir . '/' . $pid;
                    $proj_json_path = $proj_dir . '/project.json';
                    $project = read_json($proj_json_path);
                    if (!$project) continue;
                    if (!isset($project['linkedAssets'])) $project['linkedAssets'] = [];
                    if (!isset($project['_libraryMigrated'])) $project['_libraryMigrated'] = [];

                    $assets_dir = $proj_dir . '/assets';
                    foreach (glob($assets_dir . '/*.json') as $file) {
                        $asset = read_json($file);
                        if (!$asset || empty($asset['type'])) continue;
                        $atype = sanitize_name($asset['type']);
                        if (!in_array($atype, $types, true)) continue; // skip unrecognized asset types
                        $orig_id = $asset['id'] ?? basename($file, '.json');
                        if (in_array($orig_id, $project['_libraryMigrated'], true)) continue; // already migrated

                        $lib_dir = library_dir($atype);
                        $new_id = $orig_id;
                        // avoid id collision in shared store
                        if (file_exists($lib_dir . '/' . $new_id . '.json')) {
                            $new_id = generate_id($atype . '_');
                        }
                        $asset['id'] = $new_id;
                        $asset['createdBy'] = $u;
                        $asset['updatedBy'] = $u;
                        if (empty($asset['created'])) $asset['created'] = time();
                        $asset['updated'] = time();

                        // Copy image file if present
                        if (!empty($asset['image_file'])) {
                            $src_img = $assets_dir . '/' . $asset['image_file'];
                            if (file_exists($src_img)) {
                                $ext = pathinfo($src_img, PATHINFO_EXTENSION);
                                $new_img_name = $new_id . '.' . $ext;
                                copy($src_img, $lib_dir . '/' . $new_img_name);
                                $asset['image_file'] = $new_img_name;
                            }
                        }

                        write_json($lib_dir . '/' . $new_id . '.json', $asset);

                        if (!isset($project['linkedAssets'][$atype])) $project['linkedAssets'][$atype] = [];
                        if (!in_array($new_id, $project['linkedAssets'][$atype], true)) {
                            $project['linkedAssets'][$atype][] = $new_id;
                        }
                        $project['_libraryMigrated'][] = $orig_id;
                        $migrated++;
                    }
                    write_json($proj_json_path, $project);
                }
            }
        }
        success(['migrated' => $migrated, 'users_scanned' => $scanned_users]);
        break;

    // ── Full state (migration + bulk load) ────────────────────────────────────

    case 'save_full_state':
        // Import entire localStorage state in one call (migration)
        if (!$username) error('Missing username');
        $state = $input['state'] ?? null;
        if (!$state) error('Missing state');

        $projects = $state['projects'] ?? [];
        foreach ($projects as $project) {
            $id = sanitize_name($project['id'] ?? generate_id('proj_'));
            $project['id'] = $id;
            $project['updated'] = $project['updated'] ?? time();
            $project['created'] = $project['created'] ?? time();
            $path = project_path($username, $id);
            ensure_dir($path . '/assets');
            ensure_dir($path . '/shots');
            write_json($path . '/project.json', $project);

            // Save assets
            foreach ($project['assets'] ?? [] as $asset) {
                $asset_id = sanitize_name($asset['id'] ?? generate_id('asset_'));
                $asset['id'] = $asset_id;
                $assets_dir = $path . '/assets';
                if (!empty($asset['image_data'])) {
                    if (preg_match('/^data:image\/(\w+);base64,/', $asset['image_data'], $m)) {
                        $ext = $m[1];
                        $img = preg_replace('/^data:image\/\w+;base64,/', '', $asset['image_data']);
                        $img_filename = $asset_id . '.' . $ext;
                        file_put_contents($assets_dir . '/' . $img_filename, base64_decode($img));
                        $asset['image_file'] = $img_filename;
                        unset($asset['image_data']);
                    }
                }
                write_json($assets_dir . '/' . $asset_id . '.json', $asset);
            }

            // Save shots
            foreach ($project['shots'] ?? [] as $shot) {
                $shot_id = sanitize_name($shot['id'] ?? generate_id('shot_'));
                $shot['id'] = $shot_id;
                write_json($path . '/shots/' . $shot_id . '.json', $shot);
            }
        }
        success(['imported' => count($projects)]);
        break;

    default:
        error('Unknown action: ' . $action, 404);
}
