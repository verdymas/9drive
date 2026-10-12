-- Server Browser (Stage 1 MVP): persistent remote-Chromium session metadata.
-- One row per session: owner, lifecycle state, container correlation, hashed
-- one-time display token, creation/expiry timestamps. The live browser runs in
-- a per-session KasmVNC Chromium container orchestrated by the backend; this
-- table never stores cookies, credentials, or URLs.
-- CreateTable
CREATE TABLE `server_browser_sessions` (
    `id` CHAR(36) NOT NULL,
    `user_id` CHAR(36) NOT NULL,
    `status` VARCHAR(16) NOT NULL DEFAULT 'starting',
    `container_name` VARCHAR(191) NULL,
    `container_ip` VARCHAR(64) NULL,
    `view_token_hash` VARCHAR(255) NULL,
    `view_token_expires_at` DATETIME(3) NULL,
    `last_error` TEXT NULL,
    `expires_at` DATETIME(3) NOT NULL,
    `ended_at` DATETIME(3) NULL,
    `last_seen_at` DATETIME(3) NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,

    INDEX `server_browser_sessions_user_id_status_created_at_idx`(`user_id`, `status`, `created_at`),
    INDEX `server_browser_sessions_status_expires_at_idx`(`status`, `expires_at`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `server_browser_sessions` ADD CONSTRAINT `server_browser_sessions_user_id_fkey` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
