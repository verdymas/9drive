# Telegram Metadata Security

How 9Drive protects filenames and paths stored on Telegram, and how to roll it
out, repair it, and migrate existing files.

The 9Drive database is always the source of truth. What lives on Telegram is a
**cached recovery representation** — enough to rebuild the logical tree if the
DB is lost, and nothing more. Normal reads (downloads, WebDAV, Jellyfin) never
decrypt anything: they resolve by `providerFileId` and read names from the DB.

## What gets protected

| On Telegram | Without protection | With protection |
|---|---|---|
| Document filename | `Holiday Invoice 2026.pdf` | `tg_9f2c…a41e.bin` |
| Caption | `9drive:id=…`<br>`9drive:path=Docs/Holiday Invoice 2026.pdf` | `9drive:id=…`<br>`9drive:meta=v1:<AES-256-GCM payload>` |
| File bytes | unchanged | unchanged (never re-encrypted, never re-uploaded) |

The opaque filename is `HMAC-SHA256(filename-key, file.id)` truncated to 32 hex
chars. It is derived from the immutable 9Drive file id, so **renaming or moving
a file never renames the Telegram document**.

## Configuration

```env
TELEGRAM_METADATA_ENCRYPTION_ENABLED=false
TELEGRAM_METADATA_MASTER_KEY=
TELEGRAM_CRYPTO_SALT=9drive-telegram-v1
TELEGRAM_OBFUSCATE_FILENAME_ENABLED=false
TELEGRAM_OBFUSCATE_FILE_EXTENSION=true
```

- `TELEGRAM_METADATA_MASTER_KEY` must be **at least 32 characters**. Generate one
  with `openssl rand -base64 48`.
- Subkeys are derived per purpose with HKDF-SHA256 (`…:filename:v1`,
  `…:metadata:v1`), so the filename key can never decrypt metadata.
- `TELEGRAM_OBFUSCATE_FILE_EXTENSION=false` keeps the real extension
  (`tg_<hex>.mkv`) — slightly friendlier in the Telegram UI, slightly more
  leakage.
- The two toggles are independent: obfuscated filenames without encrypted
  captions is a valid configuration, and vice versa.

> ⚠️ **Back up the master key.** If `TELEGRAM_METADATA_MASTER_KEY` is lost,
> encrypted Telegram metadata cannot be recovered — the DB still works, but
> Telegram-side recovery is gone. Store it wherever you keep
> `TOKEN_ENCRYPTION_KEY`.

The key never leaves the backend. It is never logged, never returned by an API,
and never sent to the browser: Settings shows only **Configured**, **Not
Configured**, or **Invalid Key**.

## Fail-safe behavior

Enabling encryption without a valid key does **not** fall back to plaintext:

- Protected uploads fail with `TELEGRAM_CRYPTO_KEY_NOT_CONFIGURED` or
  `TELEGRAM_CRYPTO_KEY_INVALID`.
- No key is ever auto-generated — a per-startup key would silently orphan every
  previously written payload.
- A wrong key or tampered payload is never guessed at and never written over DB
  state. It is recorded as a sync issue and the run continues.

## Caption format

```
9drive:id=<uuid>
9drive:meta=v1:<base64url(iv)>:<base64url(tag)>:<base64url(ciphertext)>
```

- AES-256-GCM, fresh random 12-byte IV per encryption. The auth tag makes
  tampering detectable.
- Plaintext is `{"name","path","mimeType","size"}` — recovery metadata only.
- The `v1` version tag allows the format to evolve; unknown versions are
  reported as `TELEGRAM_METADATA_UNSUPPORTED_VERSION` rather than parsed.
- Legacy `9drive:path=` captions still parse. Files uploaded before rollout keep
  working untouched.
- Worst case ≈ 450 chars, well under Telegram's 1024-char caption limit.

## Cache invalidation

Each `File` row caches `encryptedMetadata`, `metadataFingerprint` (SHA-256 of
`v1|fileId|path|name|mimeType|size`), `cryptoVersion`, and `physicalFilename`.

The fingerprint is **not** a security boundary — it only answers "did the
canonical metadata change?". Rename/move recomputes it; only a change triggers
one re-encryption plus one `editMessage`. Sync compares the caption's ciphertext
against the cached copy: byte-identical means nothing is decrypted at all.

## Migration modes

| Mode | What it does | When |
|---|---|---|
| **A — new files only** (default) | Turn the toggles on. New uploads are protected; existing files are left alone. | Always safe. Start here. |
| **B — caption rewrite** | Settings → Telegram Metadata Security → *Update on Telegram*. Rewrites one file's caption as encrypted metadata via `editMessage`. | Protect existing files' metadata. No re-upload, no rename, playback unaffected. |
| **C — physical rename** | Not implemented. Telegram cannot rename a document in place; it would require re-uploading every file. | Deferred by design. |

Mode B changes metadata only. The document, its bytes, its message id, and its
existing filename are all preserved, so WebDAV/Jellyfin playback is unaffected.

## Manual repair

If a Telegram message loses its caption (deleted by hand, edited away), the
document still downloads — 9Drive resolves it by `providerFileId`. To restore
recoverability:

1. Settings → **Telegram Metadata Security**.
2. Paste the 9Drive file id, press **Build caption**, and copy the result.
3. Paste it as the message's caption in Telegram.
4. Run **Sync**. The caption's ciphertext differs from the cache, so 9Drive
   decrypts it, validates it, and reconciles.

**Build caption** touches nothing — not Telegram, not the DB. It only renders
what the caption should say.

## Failure codes

| Code | Meaning | Fix |
|---|---|---|
| `TELEGRAM_CRYPTO_KEY_NOT_CONFIGURED` | Encryption on (or requested) with no key | Set `TELEGRAM_METADATA_MASTER_KEY`, restart |
| `TELEGRAM_CRYPTO_KEY_INVALID` | Key shorter than 32 characters | Generate a longer key, restart |
| `TELEGRAM_METADATA_ENCRYPT_FAILED` | Encryption failed unexpectedly | Check backend logs; treat as a bug |
| `TELEGRAM_METADATA_DECRYPT_FAILED` | Auth tag mismatch — wrong key or tampered caption | Verify the key matches the one used at upload |
| `TELEGRAM_METADATA_MALFORMED` | Payload isn't well-formed | Rebuild the caption (manual repair) |
| `TELEGRAM_METADATA_UNSUPPORTED_VERSION` | Newer format than this build understands | Upgrade 9Drive |

Unreadable captions surface as `TELEGRAM_METADATA_UNREADABLE` sync issues in the
review panel. The issue records the error code and a truncated reason — never the
payload, never key material. One bad message never aborts a sync run.

## Read paths never decrypt

Downloads, WebDAV PROPFIND/GET/Range, and Jellyfin playback resolve a file by
its DB row and serve `File.name`. They never read `encryptedMetadata` and never
touch the crypto module — `backend/src/modules/webdav/webdav-no-decrypt.test.ts`
asserts this structurally: the crypto module's mock sets a flag on import, and
the WebDAV resolution path leaves it false. The opaque `physicalFilename` is
also not an addressable WebDAV path.

Telegram byte streaming for WebDAV (range/seek) is a separate concern from
metadata protection and is tracked by
`implementations/9drive-telegram-stream-implementation-phases/` (Phase 07 there
routes Telegram WebDAV reads through the `telegram-stream` gateway). Nothing in
this document depends on which streaming backend serves the bytes.

## Key rotation

Not supported in v1. Rotating the master key orphans every existing payload
(they are unreadable under the new key, though the DB is unaffected and files
still download). The `v1` version tag reserves room for a dual-key rotation
scheme later. Until then: pick a key, back it up, keep it.

## Rollout checklist

1. Generate and back up `TELEGRAM_METADATA_MASTER_KEY`.
2. Set `TELEGRAM_METADATA_ENCRYPTION_ENABLED=true` (and optionally
   `TELEGRAM_OBFUSCATE_FILENAME_ENABLED=true`). Restart.
3. Confirm Settings shows **Configured**.
4. Upload one test file. Verify on Telegram: opaque filename, `9drive:meta`
   caption, no readable path.
5. Confirm the file downloads and plays via WebDAV/Jellyfin (reads never
   decrypt, so this should be unchanged).
6. Run **Sync**. Expect zero new issues.
7. Optional: use Mode B on a few existing files, re-running Sync after each.
