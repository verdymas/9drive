-- Telegram metadata-protection cache columns on the `files` table.
--
-- The 9Drive DB remains the canonical logical state (name/folder_id/mime_type/
-- size_bytes); these columns hold the CACHED recovery representation for
-- Telegram rows so normal reads never decrypt and sync can compare ciphertext
-- without decrypting:
--   - `physical_filename`   opaque Telegram filename (`tg_<opaque>.bin`)
--   - `encrypted_metadata`  latest `v1:<base64url(iv):base64url(tag):cipher>`
--   - `metadata_fingerprint` sha256 of canonical recovery metadata (change
--                           detection / cache invalidation — not a secret)
--   - `crypto_version`      metadata format version ('v1')
-- NULL for legacy Telegram rows and for non-Telegram providers (Google/S3
-- rows are completely unaffected). No backfill — intentionally nullable.

-- AlterTable
ALTER TABLE `files` ADD COLUMN `physical_filename` VARCHAR(191) NULL;
ALTER TABLE `files` ADD COLUMN `encrypted_metadata` TEXT NULL;
ALTER TABLE `files` ADD COLUMN `metadata_fingerprint` VARCHAR(64) NULL;
ALTER TABLE `files` ADD COLUMN `crypto_version` VARCHAR(16) NULL;
