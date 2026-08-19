-- Google OAuth reauth-required state: marks accounts whose refresh token was
-- rejected with invalid_grant. Tokens are preserved for reconnect; routing
-- and sync exclude the account until the user reconnects.
ALTER TABLE `connected_accounts` ADD COLUMN `last_auth_error_code` VARCHAR(64) NULL,
    ADD COLUMN `reauth_required_at` DATETIME(3) NULL;
-- AlterTable
ALTER TABLE `oauth_states` ADD COLUMN `connected_account_id` CHAR(36) NULL;