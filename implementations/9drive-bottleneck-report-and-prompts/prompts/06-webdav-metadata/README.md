# B6 — WebDAV Metadata

Goal: make Jellyfin/rclone metadata access use indexed exact lookups and lean directory projections without changing the visible virtual filesystem.

Phases:

1. Exact path lookup and query indexes.
2. Slim directory metadata and lazy provider-account hydration.
3. Add short-lived metadata cache and measurements.
