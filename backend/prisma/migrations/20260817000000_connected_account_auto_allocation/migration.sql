-- Auto Allocation Control: per-account placement policy.
-- When false, the account is excluded from Automatic new-file routing, but
-- manual selection, Sync, quota refresh and existing reads are unaffected.
-- Default true so existing connected accounts remain eligible after upgrade.
ALTER TABLE `connected_accounts` ADD COLUMN `auto_allocation_enabled` BOOLEAN NOT NULL DEFAULT true;
