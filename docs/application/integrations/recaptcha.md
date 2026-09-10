# Integration: reCAPTCHA

reCAPTCHA is used only for email/password registration when both frontend and backend configuration are present.

- Frontend: `VITE_RECAPTCHA_SITE_KEY`
- Backend: `RECAPTCHA_SECRET_KEY`

If either value is empty, CAPTCHA is effectively disabled. Never implement a frontend-only CAPTCHA check without backend verification.
