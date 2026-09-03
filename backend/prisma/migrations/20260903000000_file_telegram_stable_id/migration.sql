-- 9Drive logical-identity column on the `files` table.
--
-- `telegram_stable_id` mirrors the `9drive:id=<stableId>` caption field on
-- Telegram storage documents. It is the stable logical key that survives
-- re-uploads, channel moves, and filename changes — independent of
-- `providerFileId` (which is the physical identity). NULL for legacy rows
-- and for non-Telegram providers; the Telegram ingest stamps it on the
-- first caption it sees. No backfill — the field is intentionally nullable.

-- AlterTable
ALTER TABLE `files` ADD COLUMN `telegram_stable_id` VARCHAR(36) NULL;

-- CreateIndex
CREATE INDEX `files_user_telegram_stable_id_idx` ON `files` (`user_id`, `telegram_stable_id`);