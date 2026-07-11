<?php
/**
 * SS_Studio — Shared backup logic (extracted from backup.php, 2026-06-29)
 *
 * Used by BOTH:
 *   - backup.php (cron, runs via PHP-CLI, 3x/day, no web server involved)
 *   - api.php's `run_backup_now` action (manual "Backup Now" button in
 *     Settings > Backup, run by the web/PHP-FPM user via a browser click)
 *
 * Kept as one function so cron and the manual button can never diverge —
 * a fix to one path is automatically a fix to both.
 *
 * Does NOT define APP_ROOT / USERDATA_ROOT / BACKUP_CONFIG_FILE — the
 * caller must define those constants before requiring this file (both
 * backup.php and api.php already do, with the same values).
 */

if (!function_exists('run_ss_studio_backup')) {

function ss_backup_read_cfg($path) {
    if (!file_exists($path)) return null;
    $raw = file_get_contents($path);
    $data = json_decode($raw, true);
    return is_array($data) ? $data : null;
}

function ss_backup_write_cfg($path, $data) {
    return file_put_contents($path, json_encode($data, JSON_PRETTY_PRINT)) !== false;
}

function ss_backup_copy_recursive($src, $dst) {
    if (!is_dir($src)) return false;
    if (!is_dir($dst)) mkdir($dst, 0755, true);
    $entries = scandir($src);
    foreach ($entries as $entry) {
        if ($entry === '.' || $entry === '..') continue;
        $s = $src . '/' . $entry;
        $d = $dst . '/' . $entry;
        if (is_dir($s)) {
            ss_backup_copy_recursive($s, $d);
        } else {
            copy($s, $d);
        }
    }
    return true;
}

/**
 * Runs one full backup cycle (zip app code + copy userdata/ + prune old
 * snapshots + write last_run_* status into the config file).
 *
 * @param string $app_root      Absolute path to the SS_Studio folder.
 * @param string $userdata_root Absolute path to SS_Studio/userdata.
 * @param string $config_file   Absolute path to _backup_config.json.
 * @param int    $retention_days How many days of snapshots to keep (default 2).
 * @return array ['ok' => bool, 'msg' => string]
 */
function run_ss_studio_backup($app_root, $userdata_root, $config_file, $retention_days = 2) {
    $cfg = ss_backup_read_cfg($config_file);
    $backup_dir = $cfg['backup_dir'] ?? '';

    if (!$backup_dir) {
        $result = ['ok' => false, 'msg' => 'No backup_dir configured yet — set one in the app\'s Settings > Backup panel first.'];
        $cfg = $cfg ?? [];
        $cfg['last_run_at'] = date('c');
        $cfg['last_run_ok'] = false;
        $cfg['last_run_msg'] = $result['msg'];
        ss_backup_write_cfg($config_file, $cfg);
        return $result;
    }
    if (!is_dir($backup_dir) || !is_writable($backup_dir)) {
        $result = ['ok' => false, 'msg' => 'Configured backup_dir does not exist or is not writable: ' . $backup_dir];
        $cfg['last_run_at'] = date('c');
        $cfg['last_run_ok'] = false;
        $cfg['last_run_msg'] = $result['msg'];
        ss_backup_write_cfg($config_file, $cfg);
        return $result;
    }

    $stamp = date('Y-m-d_Hi');

    // ─── 1. Zip the program/code files (everything except userdata/) ───────
    if (!class_exists('ZipArchive')) {
        $result = ['ok' => false, 'msg' => 'PHP ZipArchive extension is not available — cannot zip program files.'];
        $cfg['last_run_at'] = date('c');
        $cfg['last_run_ok'] = false;
        $cfg['last_run_msg'] = $result['msg'];
        ss_backup_write_cfg($config_file, $cfg);
        return $result;
    }

    $zip_path = rtrim($backup_dir, '/') . '/app-code-' . $stamp . '.zip';
    $zip = new ZipArchive();
    if ($zip->open($zip_path, ZipArchive::CREATE | ZipArchive::OVERWRITE) !== true) {
        $result = ['ok' => false, 'msg' => 'Could not create zip at ' . $zip_path];
        $cfg['last_run_at'] = date('c');
        $cfg['last_run_ok'] = false;
        $cfg['last_run_msg'] = $result['msg'];
        ss_backup_write_cfg($config_file, $cfg);
        return $result;
    }

    $skip_dirs = ['userdata', '.git', 'node_modules'];
    $backup_dir_real = realpath($backup_dir);

    $rii = new RecursiveIteratorIterator(
        new RecursiveDirectoryIterator($app_root, RecursiveDirectoryIterator::SKIP_DOTS),
        RecursiveIteratorIterator::SELF_FIRST
    );
    $zipped_count = 0;
    foreach ($rii as $file) {
        $relative = substr($file->getPathname(), strlen($app_root) + 1);
        $top_level = explode('/', $relative)[0];
        if (in_array($top_level, $skip_dirs, true)) continue;

        $real = realpath($file->getPathname());
        if ($backup_dir_real && $real && strpos($real, $backup_dir_real) === 0) continue;

        if ($file->isDir()) {
            $zip->addEmptyDir($relative);
        } else {
            $zip->addFile($file->getPathname(), $relative);
            $zipped_count++;
        }
    }
    $zip->close();

    if ($zipped_count === 0) {
        @unlink($zip_path);
        $result = ['ok' => false, 'msg' => 'Zip ended up empty — nothing was archived. Check app_root/skip_dirs logic.'];
        $cfg['last_run_at'] = date('c');
        $cfg['last_run_ok'] = false;
        $cfg['last_run_msg'] = $result['msg'];
        ss_backup_write_cfg($config_file, $cfg);
        return $result;
    }

    // ─── 2. Copy userdata/ as plain files (not zipped) ──────────────────────
    $userdata_dest = rtrim($backup_dir, '/') . '/userdata-' . $stamp;

    if (!is_dir($userdata_root)) {
        $result = ['ok' => false, 'msg' => 'userdata/ does not exist at ' . $userdata_root . ' — nothing to back up.'];
        $cfg['last_run_at'] = date('c');
        $cfg['last_run_ok'] = false;
        $cfg['last_run_msg'] = $result['msg'];
        ss_backup_write_cfg($config_file, $cfg);
        return $result;
    }
    $copied = ss_backup_copy_recursive($userdata_root, $userdata_dest);
    if (!$copied) {
        $result = ['ok' => false, 'msg' => 'Failed to copy userdata/ to ' . $userdata_dest];
        $cfg['last_run_at'] = date('c');
        $cfg['last_run_ok'] = false;
        $cfg['last_run_msg'] = $result['msg'];
        ss_backup_write_cfg($config_file, $cfg);
        return $result;
    }

    // ─── 3. Prune backups older than retention_days ─────────────────────────
    $cutoff = time() - ($retention_days * 86400);
    $pruned = [];
    foreach (glob(rtrim($backup_dir, '/') . '/app-code-*.zip') ?: [] as $old_zip) {
        if (filemtime($old_zip) < $cutoff) {
            @unlink($old_zip);
            $pruned[] = basename($old_zip);
        }
    }
    foreach (glob(rtrim($backup_dir, '/') . '/userdata-*', GLOB_ONLYDIR) ?: [] as $old_dir) {
        if (filemtime($old_dir) < $cutoff) {
            $it = new RecursiveIteratorIterator(
                new RecursiveDirectoryIterator($old_dir, RecursiveDirectoryIterator::SKIP_DOTS),
                RecursiveIteratorIterator::CHILD_FIRST
            );
            foreach ($it as $f) {
                $f->isDir() ? @rmdir($f->getPathname()) : @unlink($f->getPathname());
            }
            @rmdir($old_dir);
            $pruned[] = basename($old_dir);
        }
    }

    // ─── Done ────────────────────────────────────────────────────────────────
    $msg = sprintf(
        'Backed up %d files to %s and userdata/ to %s.%s',
        $zipped_count,
        basename($zip_path),
        basename($userdata_dest),
        $pruned ? ' Pruned: ' . implode(', ', $pruned) . '.' : ''
    );
    $cfg['last_run_at'] = date('c');
    $cfg['last_run_ok'] = true;
    $cfg['last_run_msg'] = $msg;
    ss_backup_write_cfg($config_file, $cfg);
    return ['ok' => true, 'msg' => $msg];
}

} // end function_exists guard
