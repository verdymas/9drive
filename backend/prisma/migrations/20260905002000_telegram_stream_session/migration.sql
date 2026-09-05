-- Add a PyroFork (Python) streaming session column to the Telegram storage config.
-- Provisioned at auth-finalize time; null = streaming unavailable for that account
-- (Telegram reads degrade to the legacy full-GET path until the next reconnect).
ALTER TABLE `telegram_storage_configs`
  ADD COLUMN `stream_session_encrypted` TEXT NULL;
