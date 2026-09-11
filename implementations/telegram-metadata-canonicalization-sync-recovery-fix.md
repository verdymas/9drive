# Goal: Telegram Encrypted Metadata Canonicalization + Sync Recovery Fix

Fix Telegram encrypted metadata handling so existing files keep their original logical name/folder during sync and are not incorrectly moved into `Recovered from Telegram`.

This task is intentionally narrow and optimized for a small-context coding agent.

## Confirmed Failure Case

A Telegram message can currently contain:

```text
filename: tg_8bacd15c334ae8170ee88e2ab21aba73.bin

caption:
9drive:id=c04593ef-58fc-4bba-ba2a-d8fd16d8ec2d
9drive:meta=9drive:meta=v1:<encrypted-payload>
```

The encrypted metadata line is incorrectly double-prefixed.

Expected canonical form:

```text
9drive:id=c04593ef-58fc-4bba-ba2a-d8fd16d8ec2d
9drive:meta=v1:<encrypted-payload>
```

The physical Telegram file still exists and previously had valid logical metadata.

Current bad behavior:
- sync cannot reliably resolve the original logical metadata;
- the file may be recreated or moved into `Recovered from Telegram`;
- metadata representation is inconsistent between parser, DB cache, and caption encoder.

## Root Cause to Verify

The latest code appears to mix two representations:

```text
raw encrypted value:
v1:...

full caption line:
9drive:meta=v1:...
```

Some callers pass the full line into an encoder that adds `9drive:meta=` again, producing:

```text
9drive:meta=9drive:meta=v1:...
```

There may also be direct comparisons between:

```text
v1:ABC
```

and:

```text
9drive:meta=v1:ABC
```

which should represent the same encrypted payload.

Do not assume these details blindly. Confirm them from the code first, then make the smallest safe fix.

---

## Read First

Do NOT scan the whole repository.

Read only:

1. `AGENTS.md` if present.
2. `docs/README.md` if present.
3. Files containing these symbols:
   - `encodeCaption`
   - `parseCaption`
   - `encryptedMetadata`
   - `buildTelegramMetadataCache`
   - `storeCaptionCiphertext`
   - `refreshTelegramCaption`
   - `updateTelegramDocumentCaption`
   - `buildEncryptedCaptionForFile`
   - `convertFileToEncryptedCaption`
   - `Recovered from Telegram`
   - `TELEGRAM_METADATA_UNREADABLE`
   - `telegramStableId`
   - `providerFileId`
4. Focused Telegram sync / metadata tests.

Only inspect additional files when directly required by those code paths.

---

## Required Behavior

### 1. Define one canonical encrypted metadata contract

Use two explicit concepts:

```text
Encrypted metadata value:
v1:...

Telegram caption line:
9drive:meta=v1:...
```

The code must never accidentally mix them.

Create or reuse small helpers with clear responsibility, for example:

```ts
normalizeTelegramMetaValue(input)
toTelegramMetaLine(input)
```

Exact naming may follow project conventions.

### 2. Normalize legacy malformed values

The normalizer must safely accept at least:

```text
v1:ABC
9drive:meta=v1:ABC
9drive:meta=9drive:meta=v1:ABC
```

and normalize all of them to:

```text
v1:ABC
```

Do not recursively strip arbitrary text.
Only strip the exact known `9drive:meta=` prefix as needed.

### 3. Make caption encoding idempotent

Regardless of whether a caller accidentally provides:

```text
v1:ABC
```

or:

```text
9drive:meta=v1:ABC
```

or the known legacy malformed form:

```text
9drive:meta=9drive:meta=v1:ABC
```

the generated caption must contain exactly:

```text
9drive:meta=v1:ABC
```

Never emit two `9drive:meta=` prefixes.

### 4. Normalize before metadata comparisons

Any cache/fast-path comparison between:
- parsed caption metadata;
- `File.encryptedMetadata`;
- metadata cache values;

must compare normalized encrypted values, not raw representation strings.

Example:

```text
DB:
9drive:meta=v1:ABC

caption parser:
v1:ABC

Expected:
same payload
```

The fast path should still work and should not decrypt unnecessarily.

### 5. Preserve backward compatibility

Existing Telegram captions with:

```text
9drive:meta=9drive:meta=v1:...
```

must remain readable.

If the encrypted payload itself is valid:
- decrypt it;
- recover the original logical metadata;
- restore/retain the correct filename and folder;
- do NOT create a duplicate recovered file.

Do not require re-uploading the Telegram file.

### 6. Make `Recovered from Telegram` a last resort

A Telegram document must not be placed into `Recovered from Telegram` solely because the encrypted metadata string has a known prefix-formatting defect.

Before recovery placement, preserve the existing identity resolution order and ensure the implementation attempts available identity hints such as:

```text
providerFileId
telegramStableId / 9drive:id
decryptable encrypted metadata
legacy metadata/path fallback
```

Do not redesign the full sync algorithm.

If identity exists but metadata is truly unreadable, prefer the existing sync-issue/error path such as `TELEGRAM_METADATA_UNREADABLE` rather than silently creating a duplicate, when consistent with current architecture.

### 7. Safe self-healing

If sync successfully reads a legacy malformed caption:

```text
9drive:meta=9drive:meta=v1:ABC
```

it may mark it for metadata-only repair or reuse an existing bounded repair mechanism.

Canonical repair result:

```text
9drive:meta=v1:ABC
```

Requirements:
- do not re-upload the physical file;
- do not change Telegram message identity;
- do not change provider identity;
- do not introduce unbounded Telegram edit requests during a full scan.

If no safe bounded repair mechanism already exists, make parsing/backward compatibility correct first and document repair as follow-up instead of adding a large new subsystem.

---

## Regression Tests

Add focused tests for these cases.

### A. Caption encoder

Input:

```text
v1:ABC
```

Expected line:

```text
9drive:meta=v1:ABC
```

Input:

```text
9drive:meta=v1:ABC
```

Expected line:

```text
9drive:meta=v1:ABC
```

Input:

```text
9drive:meta=9drive:meta=v1:ABC
```

Expected line:

```text
9drive:meta=v1:ABC
```

There must be exactly one metadata prefix.

### B. Metadata comparison

Given:

```text
cached = 9drive:meta=v1:ABC
parsed = v1:ABC
```

Expected:
- considered equal;
- cache/fast path remains valid;
- no unnecessary decrypt caused only by representation mismatch.

### C. Legacy malformed caption recovery

Given a Telegram document with:

```text
9drive:id=<existing-stable-id>
9drive:meta=9drive:meta=v1:<valid-encrypted-payload>
```

Expected:
- metadata decrypts successfully;
- original logical filename is recovered;
- original logical folder/path is recovered;
- existing file identity is matched;
- no duplicate `File` record is created;
- file is NOT placed into `Recovered from Telegram`.

### D. Truly unreadable metadata

Given invalid encrypted metadata that cannot be decrypted:

Expected:
- existing error/sync-issue behavior is preserved;
- do not silently convert it into valid metadata;
- do not weaken authentication/encryption validation.

### E. Normal caption remains unchanged

A valid current caption:

```text
9drive:meta=v1:ABC
```

must continue to round-trip correctly.

---

## Compatibility Requirements

Do not break:

- Telegram streaming
- Telegram upload
- Telegram sync
- encrypted metadata encryption/decryption
- existing stable IDs
- existing provider file IDs
- WebDAV
- Google Drive
- S3
- manual `Change Type`
- logical file/folder structure

Do not implement MIME normalization in this task.

Do not change encryption format or encryption keys.

Do not migrate or rewrite all Telegram messages unless the project already has a safe bounded repair mechanism.

---

## Implementation Rules

- Make the smallest safe change.
- Prefer one shared normalization helper over scattered string replacements.
- Do not perform unrelated refactors.
- Do not rewrite the Telegram sync architecture.
- Reuse existing crypto and caption helpers.
- Preserve current public API behavior.
- Never log encrypted plaintext, encryption keys, session strings, API hashes, or credentials.
- Keep DB schema changes out of this task unless absolutely required; they should not be necessary for this bug.

---

## Definition of Done

The fix is complete when:

- new captions can never contain duplicate `9drive:meta=` prefixes;
- legacy double-prefixed captions remain readable;
- metadata comparisons use a canonical representation;
- the confirmed malformed-caption regression case resolves to the original logical file;
- the file is not incorrectly placed into `Recovered from Telegram`;
- no duplicate file record is created for the regression case;
- valid existing captions still work;
- focused tests pass.

---

## Final Response

Keep the final report short:

1. Root cause confirmed
2. Canonical metadata representation chosen
3. Files changed
4. Regression tests added/run
5. Whether legacy captions self-heal automatically or are only read compatibly
6. Any remaining risk

Important: if the current code contradicts the assumptions in this prompt, follow the concrete code evidence and keep the fix narrow. Do not broaden the task into a general Telegram refactor.
