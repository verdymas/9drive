-- VPS Browser Warmup: originating page URL + once-per-attempt warmup state.
-- Backward-compatible: all columns nullable; existing rows keep legacy
-- non-warmup behavior. No backfill (NULL = no page URL = no warmup).
ALTER TABLE `remote_imports`
  ADD COLUMN `source_page_url_encrypted` TEXT NULL,
  ADD COLUMN `display_page_url` TEXT NULL,
  ADD COLUMN `warmup_mode` VARCHAR(16) NULL,
  ADD COLUMN `warmup_status` VARCHAR(32) NULL,
  ADD COLUMN `warmup_requested_at` DATETIME(3) NULL,
  ADD COLUMN `warmup_trace_id` VARCHAR(128) NULL;

ALTER TABLE `captured_resources`
  ADD COLUMN `source_page_url` TEXT NULL;
