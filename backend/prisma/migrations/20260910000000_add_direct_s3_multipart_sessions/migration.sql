-- Durable server-owned state for optional direct browser → S3 multipart
-- transfers. Legacy resumable and multipart uploads leave these fields NULL.
ALTER TABLE `upload_sessions`
  ADD COLUMN `s3_multipart_upload_id` TEXT NULL,
  ADD COLUMN `s3_object_key` TEXT NULL,
  ADD COLUMN `s3_upload_expires_at` DATETIME(3) NULL,
  ADD COLUMN `s3_completed_parts` JSON NULL;

CREATE INDEX `upload_sessions_status_s3_upload_expires_at_idx`
  ON `upload_sessions`(`status`, `s3_upload_expires_at`);
