-- CreateTable
CREATE TABLE `folder_storage_locations` (
    `id` CHAR(36) NOT NULL,
    `folder_id` CHAR(36) NOT NULL,
    `connected_account_id` CHAR(36) NOT NULL,
    `provider` VARCHAR(32) NOT NULL,
    `provider_folder_id` VARCHAR(191) NOT NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,

    UNIQUE INDEX `folder_storage_locations_folder_id_connected_account_id_key`(`folder_id`, `connected_account_id`),
    INDEX `folder_storage_locations_connected_account_id_idx`(`connected_account_id`),
    INDEX `folder_storage_locations_folder_id_idx`(`folder_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `folder_storage_locations` ADD CONSTRAINT `folder_storage_locations_folder_id_fkey` FOREIGN KEY (`folder_id`) REFERENCES `folders`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `folder_storage_locations` ADD CONSTRAINT `folder_storage_locations_connected_account_id_fkey` FOREIGN KEY (`connected_account_id`) REFERENCES `connected_accounts`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- Backfill: migrate the legacy single-account folder binding
-- (folders.connected_account_id + folders.provider_folder_id) into
-- FolderStorageLocation rows. Idempotent: only folders whose mapping does not
-- already exist are inserted, so a re-run (or a run after partial data) is safe.
INSERT INTO `folder_storage_locations` (`id`, `folder_id`, `connected_account_id`, `provider`, `provider_folder_id`, `created_at`, `updated_at`)
SELECT UUID(), `id`, `connected_account_id`, `provider`, `provider_folder_id`, NOW(3), NOW(3)
FROM `folders`
WHERE `connected_account_id` IS NOT NULL
  AND `provider_folder_id` IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM `folder_storage_locations` l
    WHERE l.`folder_id` = `folders`.`id`
      AND l.`connected_account_id` = `folders`.`connected_account_id`
  );
