# Feature: System and Settings

## Backend System API
Base `/system`:

- trigger update;
- read update log;
- read/write global Google OAuth configuration;
- backup;
- restore.

Implementation: `backend/src/modules/system/system.routes.ts`.

## Frontend
`frontend/src/pages/SettingsPage.tsx` is the configuration hub for accounts,
providers, system settings, and the Browser Capture card.
`frontend/src/hooks/useSettings.ts` owns connected-account loading, account
selection, Google/S3/Telegram connect/reconnect flows, quota sync, disconnect
and purge actions, and Telegram connection state. The page retains system
update, OAuth configuration, backup/restore, and presentational composition.

## Risk
Update, backup, restore, and provider-credential mutation are high-impact operations. Preserve authentication, validation, secret redaction, and rollback/error reporting when modifying this area.
