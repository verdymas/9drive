-- Managed (provisioned) workers have no endpoint until deployment succeeds:
-- the endpoint is system-discovered after provisioning, and provision_failed
-- rows never had one. Manual drivers still supply it on registration.
ALTER TABLE `remote_fetch_workers` MODIFY `endpoint_url` TEXT NULL;
