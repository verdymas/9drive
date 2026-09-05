-- Telegram login phone on `telegram_storage_configs`.
--
-- Encrypted with the same AES-256-GCM helper as the api id / api hash / session
-- (`utils/crypto.ts`), and held for ONE reason: a Telegram account has no other
-- human-meaningful identifier, so without it every Telegram account in the UI
-- reads `Telegram Drive` / `telegram@<channel id>`. The API exposes only a
-- masked form (prefix + last 4) via `connected_accounts.display_name`; the full
-- number is never serialized.
--
-- Nullable, no backfill: accounts connected before this migration are labelled
-- by channel title alone until their next reconnect, which is when the number
-- is known again (it previously lived only in the short-lived auth-state row).

-- AlterTable
ALTER TABLE `telegram_storage_configs` ADD COLUMN `phone_encrypted` TEXT NULL;
