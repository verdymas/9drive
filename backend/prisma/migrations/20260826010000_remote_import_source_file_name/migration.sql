-- AlterTable: add sourceFileName to remote_imports for the original captured
-- filename (e.g. "master.m3u8"), preserved separately from the upload-derived
-- fileName which carries the output container extension.
ALTER TABLE `remote_imports` ADD COLUMN `source_file_name` VARCHAR(255) NULL;