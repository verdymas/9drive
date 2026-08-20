-- Remote Fetch Worker registry: provider-agnostic network relays used by
-- Remote Imports. Drivers are resolved in application code (cloudflare first;
-- future: generic-http-relay, vercel, self-hosted) — no provider-specific
-- columns live in the table.
-- CreateTable
CREATE TABLE `remote_fetch_workers` (
    `id` CHAR(36) NOT NULL,
    `name` VARCHAR(191) NOT NULL,
    `slug` VARCHAR(191) NULL,
    `driver` VARCHAR(64) NOT NULL,
    `endpoint_url` TEXT NOT NULL,
    `is_enabled` BOOLEAN NOT NULL DEFAULT true,
    `is_default` BOOLEAN NOT NULL DEFAULT false,
    `priority` INT NULL,
    `region` VARCHAR(64) NULL,
    `description` TEXT NULL,
    `auth_type` VARCHAR(16) NOT NULL DEFAULT 'hmac',
    `secret_encrypted` TEXT NULL,
    `config_encrypted` TEXT NULL,
    `capabilities_json` JSON NULL,
    `metadata_json` JSON NULL,
    `status` VARCHAR(16) NOT NULL DEFAULT 'unknown',
    `last_health_check_at` DATETIME(3) NULL,
    `last_healthy_at` DATETIME(3) NULL,
    `last_failed_at` DATETIME(3) NULL,
    `last_error_code` VARCHAR(64) NULL,
    `deleted_at` DATETIME(3) NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,

    UNIQUE INDEX `remote_fetch_workers_slug_key`(`slug`),
    INDEX `remote_fetch_workers_driver_idx`(`driver`),
    INDEX `remote_fetch_workers_is_enabled_idx`(`is_enabled`),
    INDEX `remote_fetch_workers_is_default_idx`(`is_default`),
    INDEX `remote_fetch_workers_status_idx`(`status`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- Remote Import: selected worker (null = Direct / no relay) + a history
-- snapshot of the worker name so past imports stay understandable after a
-- worker is renamed or deleted.
-- AlterTable
ALTER TABLE `remote_imports` ADD COLUMN `worker_id` CHAR(36) NULL,
    ADD COLUMN `worker_name_snapshot` VARCHAR(191) NULL;

-- AddForeignKey
ALTER TABLE `remote_imports` ADD CONSTRAINT `remote_imports_worker_id_fkey` FOREIGN KEY (`worker_id`) REFERENCES `remote_fetch_workers`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- CreateIndex
CREATE INDEX `remote_imports_worker_id_idx` ON `remote_imports`(`worker_id`);