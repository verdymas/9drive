-- WebDAV exact child lookups use the parent/folder, active/deleted state,
-- and display name predicates without loading sibling collections.
CREATE INDEX `files_folder_status_name_idx` ON `files`(`folder_id`, `status`, `name`);
CREATE INDEX `folders_parent_deleted_name_idx` ON `folders`(`parent_id`, `deleted_at`, `name`);
