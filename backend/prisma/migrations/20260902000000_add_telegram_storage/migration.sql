-- AlterTable
ALTER TABLE `storage_accounts` ADD COLUMN `file_count` INTEGER NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE `telegram_storage_configs` (
    `id` CHAR(36) NOT NULL,
    `user_id` CHAR(36) NOT NULL,
    `connected_account_id` CHAR(36) NOT NULL,
    `name` VARCHAR(191) NOT NULL,
    `api_id_encrypted` TEXT NOT NULL,
    `api_hash_encrypted` TEXT NOT NULL,
    `session_encrypted` TEXT NOT NULL,
    `channel_id` VARCHAR(191) NULL,
    `channel_title` VARCHAR(191) NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,

    UNIQUE INDEX `telegram_storage_configs_connected_account_id_key`(`connected_account_id`),
    INDEX `telegram_storage_configs_user_id_idx`(`user_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `telegram_auth_states` (
    `id` CHAR(36) NOT NULL,
    `user_id` CHAR(36) NOT NULL,
    `connected_account_id` CHAR(36) NULL,
    `step` VARCHAR(32) NOT NULL DEFAULT 'awaiting_code',
    `api_id_encrypted` TEXT NOT NULL,
    `api_hash_encrypted` TEXT NOT NULL,
    `phone_encrypted` TEXT NULL,
    `code_hash_encrypted` TEXT NULL,
    `session_encrypted` TEXT NOT NULL,
    `expires_at` DATETIME(3) NOT NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,

    INDEX `telegram_auth_states_user_id_idx`(`user_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `telegram_storage_configs` ADD CONSTRAINT `telegram_storage_configs_user_id_fkey` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `telegram_storage_configs` ADD CONSTRAINT `telegram_storage_configs_connected_account_id_fkey` FOREIGN KEY (`connected_account_id`) REFERENCES `connected_accounts`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `telegram_auth_states` ADD CONSTRAINT `telegram_auth_states_user_id_fkey` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;