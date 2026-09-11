# Telegram Metadata Canonicalization and Sync Recovery Fix Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Telegram encrypted metadata canonical and idempotent, keep legacy double-prefixed captions readable, and prevent valid existing files from being duplicated or placed in `Recovered from Telegram` during sync.

**Architecture:** Keep `v1:...` as the raw encrypted metadata value used by parser, crypto/cache comparisons, and the `File.encryptedMetadata` cache. Use `9drive:meta=v1:...` only as the Telegram caption-line representation. A shared normalizer accepts raw, full-line, and anchored repeated-prefix legacy values. Existing full-line database cache values remain readable and are normalized at comparison/read boundaries; new writes use the raw value. Sync identity order and page reconciliation remain unchanged.

**Tech Stack:** TypeScript, Express backend, Prisma/MySQL persistence, Vitest, Telegram `teleproto` integration.

**Spec:** `implementations/telegram-metadata-canonicalization-sync-recovery-fix.md`

## Global Constraints

- Make the smallest safe change and preserve current Telegram, Google Drive, S3, WebDAV, and manual `Change Type` behavior.
- Do not change encryption format, keys, schema, provider IDs, Telegram message identity, or upload-to-disk behavior.
- Strip only the exact anchored `9drive:meta=` prefix; never remove arbitrary matching text.
- Do not log encrypted plaintext, keys, session strings, API hashes, or credentials.
- Existing malformed captions are read compatibly; no unbounded full-scan caption repair is introduced.
- Backend verification must include `npm run build`; focused and full Vitest suites must be run before completion.

---

### Task 1: Add the canonical encrypted-metadata value/line boundary

**Files:**
- Modify: `backend/src/modules/telegram/telegram-metadata.ts`
- Modify: `backend/src/modules/telegram/telegram-crypto.service.ts`
- Test: `backend/src/modules/telegram/telegram-metadata.test.ts`
- Test: `backend/src/modules/telegram/telegram-metadata-fastpath.test.ts`

**Interfaces:**
- Produce `normalizeTelegramMetaValue(input: string | null | undefined): string | null`, returning raw `v1:...` for raw, `9drive:meta=...`, and known repeated-prefix inputs, while returning `null` for absent/blank input.
- Produce `toTelegramMetaLine(input: string | null | undefined): string | null`, returning exactly one `9drive:meta=` prefix around the normalized value.
- Keep `parseCaption().encryptedMeta` as the normalized raw value.
- Keep `decryptRecoveryMetadata()` accepting both raw and caption-line inputs, including the known double-prefixed legacy form.

- [ ] **Step 1: Write the failing tests.** Add encoder cases that pass `v1:ABC`, `9drive:meta=v1:ABC`, and `9drive:meta=9drive:meta=v1:ABC`, asserting one exact output line and one prefix occurrence. Add a parser case asserting the double-prefixed line yields `encryptedMeta === 'v1:ABC'`. Add a crypto/fast-path case asserting a double-prefixed valid payload can be decrypted.

```ts
it.each([
  'v1:ABC',
  '9drive:meta=v1:ABC',
  '9drive:meta=9drive:meta=v1:ABC',
])('encodes %s with exactly one metadata prefix', (encryptedMeta) => {
  const caption = encodeCaption({ stableId: 'file-1', encryptedMeta })
  expect(caption).toBe('9drive:id=file-1\n9drive:meta=v1:ABC')
  expect(caption!.match(/9drive:meta=/g)).toHaveLength(1)
})

it('normalizes a double-prefixed caption value before returning it', () => {
  expect(parseCaption('9drive:meta=9drive:meta=v1:ABC').encryptedMeta).toBe('v1:ABC')
})
```

- [ ] **Step 2: Run the focused tests and verify they fail for the current reason.**

Run: `npm test -- --run src/modules/telegram/telegram-metadata.test.ts src/modules/telegram/telegram-metadata-fastpath.test.ts`

Expected: FAIL because the current encoder emits `9drive:meta=9drive:meta=v1:ABC`, the parser leaves the inner prefix, and crypto rejects the resulting version.

- [ ] **Step 3: Implement the shared boundary helpers and route existing code through them.** Use an anchored loop over the exact prefix in `normalizeTelegramMetaValue`; have `toTelegramMetaLine` call the normalizer and add the prefix once. Make `encodeCaption` build the metadata line through `toTelegramMetaLine`. Make `parseCaption` normalize the value after the first caption key. Make `stripMetaKeyPrefix` and `decryptRecoveryMetadata` use the same normalized value before version detection, preserving typed malformed/unsupported/decrypt errors.

- [ ] **Step 4: Run the focused tests and verify they pass.**

Run: `npm test -- --run src/modules/telegram/telegram-metadata.test.ts src/modules/telegram/telegram-metadata-fastpath.test.ts`

Expected: PASS, including all existing parser, encoder, and crypto validation cases.

- [ ] **Step 5: Refactor only after green.** Remove any duplicate prefix-stripping logic and keep the public `NINE_DRIVE_META_PREFIX`/`stripMetaKeyPrefix` exports compatible with current callers.

### Task 2: Canonicalize metadata-cache storage and comparisons

**Files:**
- Modify: `backend/src/modules/telegram/telegram-metadata-cache.ts`
- Modify: `backend/src/modules/telegram/telegram-caption-refresh.ts`
- Modify: `backend/src/modules/telegram/telegram-ingest.service.ts`
- Test: `backend/src/modules/telegram/telegram-metadata-cache.test.ts`
- Test: `backend/src/modules/telegram/telegram-metadata-fastpath.test.ts`
- Test: `backend/src/modules/telegram/telegram-caption-refresh.test.ts`

**Interfaces:**
- `buildTelegramMetadataCache()` returns raw canonical `encryptedMetadata` (`v1:...`) for new DB writes.
- `resolveCaptionMeta(captionMeta, cached)` normalizes both values before equality comparison and decrypts only the normalized caption value when they differ.
- `inspectCaptionMeta()` parses the caption through the canonical parser before resolving it.
- `storeCaptionCiphertext()` accepts raw or full-line input for compatibility but persists only the normalized raw value.

- [ ] **Step 1: Write the failing cache tests.** Assert the built cache stores a raw value, raw/full/double values compare as cached, and a full-line legacy DB cache still avoids decryption when the caption contains the raw value. Assert the stored value from `storeCaptionCiphertext()` is raw.

```ts
it('stores the encrypted metadata value without the caption key', async () => {
  const cache = buildTelegramMetadataCache(INPUT)
  expect(cache.encryptedMetadata).toMatch(/^v1:/)
  expect(cache.encryptedMetadata).not.toContain('9drive:meta=')
})

it('keeps the fast path valid across raw, full-line, and double-prefixed forms', () => {
  expect(resolveCaptionMeta('v1:ABC', '9drive:meta=v1:ABC')).toEqual({ status: 'cached' })
  expect(resolveCaptionMeta('9drive:meta=9drive:meta=v1:ABC', 'v1:ABC')).toEqual({ status: 'cached' })
})
```

- [ ] **Step 2: Run the cache tests and verify the new assertions fail.**

Run: `npm test -- --run src/modules/telegram/telegram-metadata-cache.test.ts src/modules/telegram/telegram-metadata-fastpath.test.ts`

Expected: FAIL because the current cache returns a full line and compares strings directly.

- [ ] **Step 3: Implement canonical cache reads/writes.** Normalize cache output from the existing serializer before assigning `encryptedMetadata`. Normalize both operands in `resolveCaptionMeta`, preserve the no-decrypt cached result, and pass only the normalized value to `decryptRecoveryMetadata`. Update `inspectCaptionMeta` to use `parseCaption` so the parser and inspection boundary share the same representation. Normalize the value before `storeCaptionCiphertext` persists it. Keep fingerprint/version behavior unchanged.

- [ ] **Step 4: Update refresh expectations and run the focused cache/refresh suite.** The refresh path may continue accepting a legacy full-line DB cache, but its encoder input must yield a canonical caption line and any regenerated DB cache must be raw.

Run: `npm test -- --run src/modules/telegram/telegram-metadata-cache.test.ts src/modules/telegram/telegram-metadata-fastpath.test.ts src/modules/telegram/telegram-caption-refresh.test.ts`

Expected: PASS with no extra decrypt/re-encryption on equivalent representations.

### Task 3: Preserve public caption/upload behavior at all metadata consumers

**Files:**
- Modify: `backend/src/modules/telegram/telegram-caption.service.ts`
- Modify: `backend/src/modules/telegram/telegram-security.service.ts`
- Modify: `backend/src/modules/uploads/upload-provider.service.ts` only if type errors show a boundary mismatch
- Modify: `backend/src/modules/remote-imports/processor-upload.ts` only if type errors show a boundary mismatch
- Test: `backend/src/modules/telegram/telegram-caption.service.test.ts`
- Test: `backend/src/modules/telegram/telegram-security.service.test.ts`
- Test: `backend/src/modules/telegram/telegram-caption-refresh.test.ts`

**Interfaces:**
- Caption encoder callers pass the raw cache value internally; `encodeCaption` remains tolerant of legacy full-line inputs.
- `buildEncryptedCaptionForFile()` returns `metaLine` as the full `9drive:meta=v1:...` line for API/user compatibility, while the cache remains raw.
- `convertFileToEncryptedCaption()` and refresh use the same canonical caption boundary and persist raw cache values.

- [ ] **Step 1: Write failing assertions for the consumer boundary.** Add a security test asserting the returned `metaLine` still starts with `9drive:meta=v1:` while the DB update stores a raw `v1:` value. Add an upload/refresh assertion that the Telegram caption contains exactly one metadata prefix even when the supplied cache value is a legacy full line.

- [ ] **Step 2: Run the focused consumer tests and verify failures.**

Run: `npm test -- --run src/modules/telegram/telegram-caption.service.test.ts src/modules/telegram/telegram-security.service.test.ts src/modules/telegram/telegram-caption-refresh.test.ts`

Expected: FAIL where existing tests expect the cache full line or where a full-line cache is passed into an encoder that currently double-prefixes it.

- [ ] **Step 3: Implement the boundary updates.** Rename local variables/comments where necessary to distinguish raw values from caption lines. Use `toTelegramMetaLine` only for the security response; keep caption service upload/update calls routed through `encodeCaption`. Do not change upload names, Telegram remote IDs, or encryption payload construction.

- [ ] **Step 4: Run the focused consumer tests and verify they pass.**

Run: `npm test -- --run src/modules/telegram/telegram-caption.service.test.ts src/modules/telegram/telegram-security.service.test.ts src/modules/telegram/telegram-caption-refresh.test.ts src/modules/uploads/upload-provider.service.test.ts src/modules/remote-imports/processor-upload.test.ts`

Expected: PASS with current normal-upload and remote-import behavior preserved.

### Task 4: Make sync recovery distinguish valid legacy metadata from unreadable metadata

**Files:**
- Modify: `backend/src/modules/telegram/telegram-sync-classification.ts`
- Modify: `backend/src/modules/telegram/telegram-ingest.service.ts` only if the test demonstrates an unreadable payload is silently inboxed
- Test: `backend/src/modules/telegram/telegram-sync-classification.test.ts`
- Test: `backend/src/modules/telegram/telegram-ingest.service.test.ts` or a new focused `backend/src/modules/telegram/telegram-ingest-encrypted-metadata.test.ts`

**Interfaces:**
- Keep provider-file-ID matching first, then caption stable ID, then path/legacy fallback, without changing provider identity.
- A valid double-prefixed encrypted caption must resolve its decrypted logical path/name and update the existing stable-ID row; it must not call `File.create` or place the row in the recovery folder.
- An encrypted payload that fails authentication, format, or version checks must produce the existing `TELEGRAM_METADATA_UNREADABLE` sync-issue outcome when it is not already matched by a physical provider row; it must not silently become a recovered import.

- [ ] **Step 1: Write the failing legacy-recovery test.** Generate a valid encrypted payload using the test master key, add the second exact `9drive:meta=` prefix to its caption line, seed an existing Telegram file row keyed by the caption stable ID with stale name/folder/provider ID, run `ingestTelegramDocument`, and assert the decrypted logical basename/folder are written, the provider ID is updated, and `file.create` is never called.

```ts
const canonical = serializeTelegramMetaLine({
  name: 'episode-01.mkv',
  path: 'Movies/Anime/One Piece/episode-01.mkv',
})
const legacyCaption = canonical.replace('9drive:meta=', '9drive:meta=9drive:meta=')
```

- [ ] **Step 2: Run the recovery test and verify it fails before the fix.**

Run: `npm test -- --run src/modules/telegram/telegram-ingest-encrypted-metadata.test.ts`

Expected: FAIL because the current normalizer leaves the inner prefix, crypto reports an unsupported version, and ingestion lacks the original logical path.

- [ ] **Step 3: Add the unreadable-metadata regression at the classification boundary.** Mock `inspectCaptionMeta` to return a typed failure for an orphan caption and assert `classifyTelegramDocument` returns `kind: 'unreadableMeta'`, does not invoke ingest, and leaves the recovery inbox path unused. Keep the existing physical-row unreadable test behavior unchanged. If the ingest test shows direct ingestion bypasses this path and creates an inbox row, propagate the existing typed metadata failure to the classifier rather than inventing a new issue kind.

- [ ] **Step 4: Implement only the minimal sync change required by the failing tests.** Valid legacy captions use the normalized encrypted value through `mergeMeta`; invalid encrypted metadata follows the existing issue persistence path. Do not reorder identity matching or add a full-scan repair loop.

- [ ] **Step 5: Run all Telegram metadata/sync regression tests.**

Run: `npm test -- --run src/modules/telegram/telegram-metadata.test.ts src/modules/telegram/telegram-metadata-cache.test.ts src/modules/telegram/telegram-metadata-fastpath.test.ts src/modules/telegram/telegram-ingest.service.test.ts src/modules/telegram/telegram-ingest-encrypted-metadata.test.ts src/modules/telegram/telegram-sync-classification.test.ts src/modules/telegram/telegram-sync-caption-routing.test.ts src/modules/telegram/telegram-sync.service.test.ts`

Expected: PASS, including no duplicate row, no recovery-folder placement for the valid legacy case, stable-ID/provider-ID preservation, and unreadable metadata issue behavior.

### Task 5: Document the contract and perform completion verification

**Files:**
- Modify: `docs/application/features/telegram-storage.md`
- Modify: `docs/application/workflows/telegram-reconciliation.md` only if the issue-path wording needs clarification

- [ ] **Step 1: Document the two representations.** State that raw encrypted metadata is `v1:...`, Telegram captions use `9drive:meta=v1:...`, existing full-line cache values are accepted for compatibility, and full scans do not perform unbounded caption rewrites.

- [ ] **Step 2: Run the full backend test suite.**

Run: `npm test`

Expected: exit code 0 with all test files passing.

- [ ] **Step 3: Run the required backend build.**

Run: `npm run build`

Expected: exit code 0 with TypeScript compilation and existing build asset steps succeeding.

- [ ] **Step 4: Audit the diff against every requirement in the implementation brief.** Confirm no schema/migration/generated-client changes, no duplicate prefix construction outside the helper boundary, no plaintext/key logging, no Telegram re-upload, no provider/message identity changes, and no MIME normalization.

- [ ] **Step 5: Inspect `git diff --check` and current status.** Confirm only the intended source, focused tests, documentation, and plan files changed.

