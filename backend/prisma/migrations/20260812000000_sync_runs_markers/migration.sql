-- Multi-storage Sync: SyncRun history, last-seen reconciliation markers,
-- and virtual folder name normalization for Sync folder matching.
--
-- Written by hand following the 20260807080000_multi_storage_locations style:
-- CreateTable + ALTER + idempotent backfill. Order matters — the folders
-- unique index MUST be added last, after the duplicate-safe backfill.

-- CreateTable
CREATE TABLE `sync_runs` (
    `id` CHAR(36) NOT NULL,
    `user_id` CHAR(36) NOT NULL,
    `connected_account_id` CHAR(36) NOT NULL,
    `provider` VARCHAR(32) NOT NULL,
    `status` VARCHAR(16) NOT NULL DEFAULT 'running',
    `started_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `completed_at` DATETIME(3) NULL,
    `error_code` VARCHAR(64) NULL,
    `error_message` TEXT NULL,
    `folders_discovered` INTEGER NOT NULL DEFAULT 0,
    `files_discovered` INTEGER NOT NULL DEFAULT 0,
    `folders_created` INTEGER NOT NULL DEFAULT 0,
    `mappings_created` INTEGER NOT NULL DEFAULT 0,
    `mappings_reused` INTEGER NOT NULL DEFAULT 0,
    `mappings_detached` INTEGER NOT NULL DEFAULT 0,
    `files_created` INTEGER NOT NULL DEFAULT 0,
    `files_updated` INTEGER NOT NULL DEFAULT 0,
    `files_moved` INTEGER NOT NULL DEFAULT 0,
    `files_missing` INTEGER NOT NULL DEFAULT 0,
    `mappings_missing` INTEGER NOT NULL DEFAULT 0,
    `collisions_detected` INTEGER NOT NULL DEFAULT 0,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,

    INDEX `sync_runs_user_id_created_at_idx`(`user_id`, `created_at`),
    INDEX `sync_runs_connected_account_id_created_at_idx`(`connected_account_id`, `created_at`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `sync_runs` ADD CONSTRAINT `sync_runs_user_id_fkey` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `sync_runs` ADD CONSTRAINT `sync_runs_connected_account_id_fkey` FOREIGN KEY (`connected_account_id`) REFERENCES `connected_accounts`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AlterTable: File last-seen marker (plain indexed column, no FK — compared, never joined)
ALTER TABLE `files` ADD COLUMN `last_seen_sync_run_id` VARCHAR(36) NULL;

-- AlterTable: FolderStorageLocation last-seen marker
ALTER TABLE `folder_storage_locations` ADD COLUMN `last_seen_sync_run_id` VARCHAR(36) NULL;

-- AlterTable: Folder normalized-name + origin
ALTER TABLE `folders` ADD COLUMN `normalized_name` VARCHAR(255) NULL;
ALTER TABLE `folders` ADD COLUMN `origin` VARCHAR(16) NOT NULL DEFAULT 'user';

-- Backfill folders.normalized_name — duplicate-safe, deterministic first-wins.
-- Existing rows may already contain duplicate names under one parent (the
-- schema never enforced uniqueness). The FIRST row (MIN id) of each
-- (user_id, parent_id, LOWER(TRIM(name))) group keeps its normalized name;
-- later duplicates stay NULL so the unique index below cannot fail and no
-- folder is renamed. Idempotent: only NULL rows are touched.
UPDATE `folders` f
JOIN (
    SELECT `user_id`, `parent_id`, LOWER(TRIM(`name`)) AS n, MIN(`id`) AS `keep_id`
    FROM `folders`
    GROUP BY `user_id`, `parent_id`, LOWER(TRIM(`name`))
) g
  ON f.`user_id` = g.`user_id`
 AND IFNULL(f.`parent_id`, '0') = IFNULL(g.`parent_id`, '0')
 AND LOWER(TRIM(f.`name`)) = g.n
 AND f.`id` = g.`keep_id`
SET f.`normalized_name` = LOWER(TRIM(f.`name`))
WHERE f.`normalized_name` IS NULL;

-- Origin backfill: existing folders are user-created (sync-created rows get
-- 'sync' only when Sync discovers them after this migration).
UPDATE `folders` SET `origin` = 'user' WHERE `origin` IS NULL;

-- CreateIndex — MUST come last, after the duplicate-safe backfill above.
CREATE UNIQUE INDEX `folders_user_parent_normalized_name_unique` ON `folders`(`user_id`, `parent_id`, `normalized_name`);

-- CreateIndex (last-seen query patterns)
-- NOTE: the location index name is shortened to stay within MySQL's 64-char
-- identifier limit — `folder_storage_locations_connected_account_id_last_seen_sync_run_id_idx`
-- is 74 chars and fails with error 1059.
CREATE INDEX `files_connected_account_id_status_last_seen_sync_run_id_idx` ON `files`(`connected_account_id`, `status`, `last_seen_sync_run_id`);
CREATE INDEX `folder_storage_locations_connected_account_id_last_seen_sync_idx` ON `folder_storage_locations`(`connected_account_id`, `last_seen_sync_run_id`);