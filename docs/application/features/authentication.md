# Feature: Authentication

## User-facing Entry Points

Frontend:

- `frontend/src/pages/LoginPage.tsx`
- `frontend/src/pages/RegisterPage.tsx`
- `frontend/src/pages/GoogleAuthPage.tsx`
- `frontend/src/pages/GoogleConnectedPage.tsx`
- `frontend/src/components/auth/ProtectedRoute.tsx`
- `frontend/src/lib/auth.ts`

Backend:

- `backend/src/modules/auth/auth.routes.ts`
- `backend/src/middleware/auth.middleware.ts`
- `backend/src/utils/jwt.ts`
- `backend/src/utils/password.ts`

## API

Base `/auth`:

- `POST /register`
- `POST /login`
- `GET /google/url`
- `GET /google/callback`
- `POST /google/exchange`
- `POST /refresh`
- `POST /logout`
- `GET /me`

## Model
Email/password authentication uses Argon2 password hashes. Access authentication uses JWTs; refresh sessions are stored as hashed tokens in `UserSession` and can be revoked. Google authentication uses OAuth state/handoff records with expiry and one-time-use semantics.

## Guardrail
Do not assume Google OAuth configuration always comes from environment variables. The project also supports encrypted global/provider configuration stored in the database.
