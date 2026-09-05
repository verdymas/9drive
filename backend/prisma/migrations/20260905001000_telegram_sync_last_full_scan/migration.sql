-- Track the last successful full Telegram sync. The periodic scheduler
-- promotes an auto-tick to `full: true` when this is null or older than
-- `TELEGRAM_SYNC_FULL_EVERY_MINUTES` — Pass 2 (deleted-message detection)
-- only runs on full scans, so without this the background sweep never
-- notices a Telegram-side deletion.
--
-- Nullable: existing rows read as "never had a full scan" and get one on
-- the next tick — the desired first-run behavior.
ALTER TABLE `telegram_sync_state`
  ADD COLUMN `last_full_scan_at` DATETIME(3) NULL;

CREATE INDEX `telegram_sync_state_last_full_scan_idx`
  ON `telegram_sync_state` (`last_full_scan_at`);
