# Runbook: Telegram Storage and Sync

## Connect
Use the Telegram authentication flow in Settings/UI: start → verify code → if Telegram requires 2FA, continue through the password step → select a private storage channel.

## Validate Storage Account
An account is eligible for routing only after a channel is configured. Use the account test endpoint/UI before large uploads.

## Manual Index/Import
The Telegram API provides account index/import operations to bring channel documents into the logical database when needed.

## Sync
Manual synchronization: `POST /telegram/sync`. Inspect status, runs, and issues through the relevant API/UI surfaces.

## Common Problems

- `reauth_required`: reconnect the Telegram session.
- uploads are never routed to Telegram: check channel configuration and `TELEGRAM_MAX_FILE_BYTES`.
- a file exists in the channel but not in the logical tree: run sync/index, then inspect orphan issues and caption metadata.
- rename/move is not reflected in Telegram: inspect the caption-refresh flow.

## Safety
Do not mass-delete Telegram messages to “fix synchronization.” Reconciliation is designed to be non-destructive, and issues should be reviewed/resolved explicitly.
