-- Physical-identity lookup for reconciliation.
--
-- Sync and the Telegram index resolve a page of provider ids with
-- `{ userId, connectedAccountId, providerFileId: { in: [...] } }`.
--
-- Deliberately NON-UNIQUE: `(connectedAccountId, providerFileId)` is not an
-- invariant. Provisional upload/import rows are created with the literal
-- placeholder `provider_file_id = 'pending'` before the provider id is known
-- (uploads, Remote Import stream-through/temp-file, HLS), and failed rows keep
-- that placeholder after being soft-deleted, so one account legitimately holds
-- many `'pending'` rows. Enforcing uniqueness here would break concurrent
-- multipart batch uploads and Remote Import jobs. See
-- docs/application/workflows/provider-sync.md for the duplicate preflight.

-- CreateIndex
CREATE INDEX `files_user_id_connected_account_id_provider_file_id_idx` ON `files` (`user_id`, `connected_account_id`, `provider_file_id`);
