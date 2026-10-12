-- Free-tier safety budgets + monthly usage accounting for relay workers.
-- 9Drive budgets sit below published $0 limits and cannot see unrelated
-- traffic in the same external provider account.
ALTER TABLE `remote_fetch_workers`
  ADD COLUMN `req_budget_monthly` BIGINT NULL,
  ADD COLUMN `egress_budget_bytes_monthly` BIGINT NULL;

CREATE TABLE `remote_fetch_worker_usage` (
    `id` CHAR(36) NOT NULL,
    `worker_id` CHAR(36) NOT NULL,
    `period_month` VARCHAR(7) NOT NULL,
    `requests` BIGINT NOT NULL DEFAULT 0,
    `egress_bytes` BIGINT NOT NULL DEFAULT 0,
    `failures` BIGINT NOT NULL DEFAULT 0,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,
    CONSTRAINT `remote_fetch_worker_usage_worker_id_fkey` FOREIGN KEY (`worker_id`) REFERENCES `remote_fetch_workers`(`id`) ON DELETE CASCADE ON UPDATE CASCADE,
    UNIQUE INDEX `remote_fetch_worker_usage_worker_period_key`(`worker_id`, `period_month`),
    INDEX `remote_fetch_worker_usage_period_idx`(`period_month`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
