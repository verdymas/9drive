-- AlterTable
ALTER TABLE `remote_imports`
    ADD COLUMN `upload_total_bytes` BIGINT NULL,
    ADD COLUMN `queued_at` DATETIME(3) NULL,
    ADD COLUMN `retry_requested_at` DATETIME(3) NULL,
    ADD COLUMN `heartbeat_at` DATETIME(3) NULL,
    ADD COLUMN `retry_from_stage` VARCHAR(32) NULL;

-- CreateIndex
CREATE INDEX `remote_imports_status_queued_at_idx` ON `remote_imports` (`status`, `queued_at`);