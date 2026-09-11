-- Durable, encrypted server-owned recovery state for resumable Remote Import
-- stream-through transfers. Existing temp-spool imports leave this NULL.
ALTER TABLE `remote_imports`
  ADD COLUMN `stream_upload_state_encrypted` TEXT NULL;
