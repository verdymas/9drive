-- Browser Capture: registered extension devices + the resources they detect.
-- The extension is a capture client only; imports always go through the
-- existing Remote Import pipeline. Device credentials are stored hashed;
-- captured URLs are untrusted and encrypted at rest.
-- CreateTable
CREATE TABLE `browser_device_pairings` (
    `id` CHAR(36) NOT NULL,
    `user_id` CHAR(36) NOT NULL,
    `code_hash` VARCHAR(255) NOT NULL,
    `expires_at` DATETIME(3) NOT NULL,
    `used_at` DATETIME(3) NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `browser_device_pairings_code_hash_key`(`code_hash`),
    INDEX `browser_device_pairings_user_id_idx`(`user_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `browser_devices` (
    `id` CHAR(36) NOT NULL,
    `user_id` CHAR(36) NOT NULL,
    `name` VARCHAR(191) NOT NULL,
    `browser` VARCHAR(64) NOT NULL,
    `platform` VARCHAR(64) NOT NULL,
    `extension_version` VARCHAR(32) NULL,
    `device_token_hash` VARCHAR(255) NOT NULL,
    `status` VARCHAR(32) NOT NULL DEFAULT 'active',
    `last_seen_at` DATETIME(3) NULL,
    `revoked_at` DATETIME(3) NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,

    UNIQUE INDEX `browser_devices_device_token_hash_key`(`device_token_hash`),
    INDEX `browser_devices_user_id_idx`(`user_id`),
    INDEX `browser_devices_user_id_status_idx`(`user_id`, `status`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `captured_resources` (
    `id` CHAR(36) NOT NULL,
    `browser_device_id` CHAR(36) NOT NULL,
    `user_id` CHAR(36) NOT NULL,
    `url_encrypted` TEXT NOT NULL,
    `display_url` TEXT NOT NULL,
    `type` VARCHAR(16) NOT NULL,
    `mime_type` VARCHAR(191) NULL,
    `filename` VARCHAR(255) NOT NULL,
    `page_url` TEXT NULL,
    `page_title` VARCHAR(512) NULL,
    `request_context_encrypted` TEXT NULL,
    `status` VARCHAR(16) NOT NULL DEFAULT 'pending',
    `detected_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `expires_at` DATETIME(3) NOT NULL,
    `imported_at` DATETIME(3) NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,

    INDEX `captured_resources_user_id_status_detected_at_idx`(`user_id`, `status`, `detected_at`),
    INDEX `captured_resources_browser_device_id_status_idx`(`browser_device_id`, `status`),
    INDEX `captured_resources_status_expires_at_idx`(`status`, `expires_at`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `browser_device_pairings` ADD CONSTRAINT `browser_device_pairings_user_id_fkey` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `browser_devices` ADD CONSTRAINT `browser_devices_user_id_fkey` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `captured_resources` ADD CONSTRAINT `captured_resources_browser_device_id_fkey` FOREIGN KEY (`browser_device_id`) REFERENCES `browser_devices`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `captured_resources` ADD CONSTRAINT `captured_resources_user_id_fkey` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
