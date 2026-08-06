-- CreateTable
CREATE TABLE `remote_imports` (
    `id` CHAR(36) NOT NULL,
    `user_id` CHAR(36) NOT NULL,
    `folder_id` CHAR(36) NULL,
    `connected_account_id` CHAR(36) NULL,
    `file_id` CHAR(36) NULL,
    `source_url_encrypted` TEXT NOT NULL,
    `display_url` TEXT NOT NULL,
    `final_url_encrypted` TEXT NULL,
    `file_name` VARCHAR(255) NOT NULL,
    `mime_type` VARCHAR(191) NULL,
    `status` VARCHAR(32) NOT NULL DEFAULT 'queued',
    `stage` VARCHAR(32) NOT NULL DEFAULT 'waiting',
    `total_bytes` BIGINT NULL,
    `downloaded_bytes` BIGINT NOT NULL DEFAULT 0,
    `uploaded_bytes` BIGINT NOT NULL DEFAULT 0,
    `source_etag` VARCHAR(191) NULL,
    `source_last_modified` DATETIME(3) NULL,
    `source_range_supported` BOOLEAN NOT NULL DEFAULT false,
    `temp_path` TEXT NULL,
    `resume_session_encrypted` TEXT NULL,
    `job_id` VARCHAR(191) NULL,
    `attempt` INTEGER NOT NULL DEFAULT 0,
    `error_code` VARCHAR(64) NULL,
    `error_message` TEXT NULL,
    `internal_error` TEXT NULL,
    `started_at` DATETIME(3) NULL,
    `completed_at` DATETIME(3) NULL,
    `failed_at` DATETIME(3) NULL,
    `cancelled_at` DATETIME(3) NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,

    UNIQUE INDEX `remote_imports_file_id_key`(`file_id`),
    INDEX `remote_imports_user_id_created_at_idx`(`user_id`, `created_at`),
    INDEX `remote_imports_user_id_status_created_at_idx`(`user_id`, `status`, `created_at`),
    INDEX `remote_imports_status_created_at_idx`(`status`, `created_at`),
    INDEX `remote_imports_job_id_idx`(`job_id`),
    INDEX `remote_imports_folder_id_idx`(`folder_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `remote_imports` ADD CONSTRAINT `remote_imports_user_id_fkey` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `remote_imports` ADD CONSTRAINT `remote_imports_folder_id_fkey` FOREIGN KEY (`folder_id`) REFERENCES `folders`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `remote_imports` ADD CONSTRAINT `remote_imports_connected_account_id_fkey` FOREIGN KEY (`connected_account_id`) REFERENCES `connected_accounts`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `remote_imports` ADD CONSTRAINT `remote_imports_file_id_fkey` FOREIGN KEY (`file_id`) REFERENCES `files`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;
