# Integration: Telegram

## Client
The backend uses MTProto through `teleproto`, not the Bot API, because Telegram is used as document storage in a private channel.

## Credentials
API ID/hash, authentication/session state, and the final session are stored encrypted. Authentication may enter `awaiting_code` or `awaiting_password` (2FA).

## Physical Identity
Provider references use Telegram channel/message/document semantics, while stable logical identity is stored separately in `telegramStableId`.

## Core Files

- `backend/src/modules/telegram/telegram-auth.service.ts`
- `telegram-channel.service.ts`
- `telegram.service.ts`
- `telegram-ingest.service.ts`
- `telegram-index.service.ts`
- `telegram-caption*.ts`
- `telegram-sync*.ts`

## Limits
`TELEGRAM_MAX_FILE_BYTES` controls the per-file upload limit. An account without a configured storage channel must not be considered eligible storage.
