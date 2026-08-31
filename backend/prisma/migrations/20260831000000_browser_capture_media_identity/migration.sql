-- Phase 14: Media Identity (Browser Capture).
-- The extension scores JSON-LD / player-config / API / DOM video candidates and
-- sends a compact summary (title + source + confidence). The full candidates
-- list stays in the extension; the backend persists only the winner so the
-- Remote Imports UI can surface "from JSON-LD" / "from og:title" / etc.
ALTER TABLE `captured_resources`
    ADD COLUMN `media_identity_title` VARCHAR(512) NULL,
    ADD COLUMN `media_identity_source` VARCHAR(64) NULL,
    ADD COLUMN `media_identity_confidence` INTEGER NOT NULL DEFAULT 0;
