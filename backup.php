<?php
/**
 * SS_Studio — Scheduled backup script (Task #1, 2026-06-25)
 * Refactored 2026-06-29 to call the shared run_ss_studio_backup() in
 * backup-core.php — the manual "Backup Now" button (api.php's
 * run_backup_now action) uses the exact same function, so cron and the
 * button can never diverge in behavior.
 *
 * NOT part of the JSON API (api.php) and NOT called by the web app directly.
 * Run by an OS cron job, 3x/day, e.g.:
 *   php /full/path/to/SS_Studio/backup.php
 * See the crontab line shared alongside this file for the exact schedule.
 *
 * Designed to be safe to run from cron with no web server / session / PHP-FPM
 * involved — plain CLI php, no output expected on success.
 */

define('APP_ROOT', __DIR__);
define('USERDATA_ROOT', APP_ROOT . '/userdata');
define('BACKUP_CONFIG_FILE', USERDATA_ROOT . '/_backup_config.json');
define('RETENTION_DAYS', 2); // "today" + "yesterday"

require_once APP_ROOT . '/backup-core.php';

$result = run_ss_studio_backup(APP_ROOT, USERDATA_ROOT, BACKUP_CONFIG_FILE, RETENTION_DAYS);

fwrite($result['ok'] ? STDOUT : STDERR, ($result['ok'] ? '[OK] ' : '[FAIL] ') . $result['msg'] . "\n");
exit($result['ok'] ? 0 : 1);
