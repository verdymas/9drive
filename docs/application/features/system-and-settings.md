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
`frontend/src/pages/SettingsPage.tsx` is the configuration hub for accounts, providers, system settings, and the Browser Capture card.

## Risk
Update, backup, restore, and provider-credential mutation are high-impact operations. Preserve authentication, validation, secret redaction, and rollback/error reporting when modifying this area.
