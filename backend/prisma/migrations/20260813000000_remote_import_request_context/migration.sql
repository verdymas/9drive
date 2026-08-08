-- Add encrypted request context (Referer/Origin/User-Agent/Cookie) for
-- protected Remote Import sources. Values are AES-256-GCM encrypted by the
-- application before storage; the column is nullable so existing imports are
-- unaffected.
ALTER TABLE `remote_imports` ADD COLUMN `request_context_encrypted` TEXT NULL;
