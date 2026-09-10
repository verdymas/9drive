# ADR 0002: Encrypt Provider Secrets at Rest

## Status
Accepted

## Decision
Credentials that must be used again are encrypted before being stored in the database. One-way verifier values, such as API keys or one-time tokens that only need validation, are stored as hashes.

Examples of encrypted fields:

- Google OAuth access/refresh tokens.
- Provider client secrets.
- S3 access key/secret.
- Telegram API/session/auth state.
- Remote Import source URL/request context/resume session.
- Remote Fetch Worker credentials/configuration.

Examples of hashed fields:

- refresh-session tokens;
- API key secrets;
- selected public preview/share tokens;
- browser device/pairing tokens.

## Security Invariant
Never change serializers or APIs in a way that returns encrypted ciphertext, raw secrets, cookies, API hashes, Telegram sessions, or worker credentials to the frontend or logs.

## Related Files

- `backend/src/utils/crypto.ts`
- `backend/src/utils/jwt.ts`
- `backend/src/middleware/api-key.middleware.ts`
- `backend/prisma/schema.prisma`
