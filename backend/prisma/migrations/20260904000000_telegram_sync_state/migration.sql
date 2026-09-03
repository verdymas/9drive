-- Telegram Synchronization: per-account pagination cursor, run ledger,
-- and non-destructive reconciliation issue log.
--
-- All three tables are additive. Legacy rows on `sync_runs` are
-- unaffected — the new six reconciliation counts default to 0.

-- AlterTable: add reconciliation counts to SyncRun
ALTER TABLE `sync_runs` ADD COLUMN `scanned_count` INTEGER NOT NULL DEFAULT 0;
ALTER TABLE `sync_runs` ADD COLUMN `matched_count` INTEGER NOT NULL DEFAULT 0;
ALTER TABLE `sync_runs` ADD COLUMN `imported_count` INTEGER NOT NULL DEFAULT 0;
ALTER TABLE `sync_runs` ADD COLUMN `missing_count` INTEGER NOT NULL DEFAULT 0;
ALTER TABLE `sync_runs` ADD COLUMN `orphan_count` INTEGER NOT NULL DEFAULT 0;
ALTER TABLE `sync_runs` ADD COLUMN `conflict_count` INTEGER NOT NULL DEFAULT 0;
ALTER TABLE `sync_runs` ADD COLUMN `error_count` INTEGER NOT NULL DEFAULT 0;

-- CreateTable: TelegramSyncState
CREATE TABLE `telegram_sync_state` (
    `id` CHAR(36) NOT NULL,
    `user_id` CHAR(36) NOT NULL,
    `connected_account_id` CHAR(36) NOT NULL,
    `last_message_id` BIGINT NULL,
    `last_scan_at` DATETIME(3) NULL,
    `status` VARCHAR(32) NOT NULL DEFAULT 'never_synced',
    `error_code` VARCHAR(64) NULL,
    `error_message` TEXT NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,

    UNIQUE INDEX `telegram_sync_state_account_id_key`(`connected_account_id`),
    INDEX `telegram_sync_state_user_id_idx`(`user_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable: TelegramSyncRun
CREATE TABLE `telegram_sync_runs` (
    `id` CHAR(36) NOT NULL,
    `user_id` CHAR(36) NOT NULL,
    `connected_account_id` CHAR(36) NOT NULL,
    `status` VARCHAR(16) NOT NULL DEFAULT 'running',
    `started_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `finished_at` DATETIME(3) NULL,
    `scanned_count` INTEGER NOT NULL DEFAULT 0,
    `matched_count` INTEGER NOT NULL DEFAULT 0,
    `imported_count` INTEGER NOT NULL DEFAULT 0,
    `missing_count` INTEGER NOT NULL DEFAULT 0,
    `orphan_count` INTEGER NOT NULL DEFAULT 0,
    `conflict_count` INTEGER NOT NULL DEFAULT 0,
    `error_count` INTEGER NOT NULL DEFAULT 0,
    `error_code` VARCHAR(64) NULL,
    `error_message` TEXT NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,

    INDEX `telegram_sync_runs_user_id_created_at_idx`(`user_id`, `created_at`),
    INDEX `telegram_sync_runs_account_id_created_at_idx`(`connected_account_id`, `created_at`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable: TelegramSyncIssue
CREATE TABLE `telegram_sync_issues` (
    `id` CHAR(36) NOT NULL,
    `user_id` CHAR(36) NOT NULL,
    `run_id` CHAR(36) NULL,
    `connected_account_id` CHAR(36) NOT NULL,
    `kind` VARCHAR(32) NOT NULL,
    `telegram_file_id` VARCHAR(191) NULL,
    `file_id` CHAR(36) NULL,
    `detected_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `resolved_at` DATETIME(3) NULL,
    `metadata` JSON NULL,

    INDEX `telegram_sync_issues_user_acct_resolved_idx`(`user_id`, `connected_account_id`, `resolved_at`),
    INDEX `telegram_sync_issues_run_id_idx`(`run_id`),
    INDEX `telegram_sync_issues_tg_file_id_idx`(`telegram_file_id`),
    INDEX `telegram_sync_issues_file_id_idx`(`file_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `telegram_sync_state` ADD CONSTRAINT `telegram_sync_state_connected_account_id_fkey` FOREIGN KEY (`connected_account_id`) REFERENCES `connected_accounts`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `telegram_sync_runs` ADD CONSTRAINT `telegram_sync_runs_connected_account_id_fkey` FOREIGN KEY (`connected_account_id`) REFERENCES `connected_accounts`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `telegram_sync_issues` ADD CONSTRAINT `telegram_sync_issues_connected_account_id_fkey` FOREIGN KEY (`connected_account_id`) REFERENCES `connected_accounts`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;