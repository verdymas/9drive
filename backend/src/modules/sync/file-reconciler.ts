import { prisma } from '../../config/prisma.js'
import type { SyncRunContext } from './folder-reconciler.js'

/**
 * File reconciliation (spec §14-16, §30-32, §67).
 *
 * Identity is `(connectedAccountId, providerFileId)` ONLY — never filename.
 * Each page of provider files is resolved against the DB in one batch:
 *
 *   - not found       → create (`status: 'active'`, lastSeen = run)
 *   - found, changed  → update name/mimeType/sizeBytes; if the physical
 *                       provider parent changed, follow the file to the
 *                       resolved virtual parent (folderId) — no duplicate
 *                       File (§30). Restore soft-deleted rows.
 *   - found, same     → stamp lastSeen and keep (no write)
 *
 * The same provider file may appear in multiple physical folders (S3 keys
 * under a prefix vs. the prefix tree); the provider parent tracks the resolved
 * virtual folder only. Cross-account same-name files are separate File rows —
 * the frontend keys by `file.id`, duplicates render fine (§67-8).
 *
 * ── Classification contract ──────────────────────────────────────────────
 * A page is classified BEFORE any write. The categories are:
 *
 *   new              no DB row for this physical file        → create
 *   changed          row exists; name/size/folder moved      → update (per-row)
 *   restored         row exists but soft-deleted/inactive    → update (per-row)
 *   unchanged        row identical; lastSeen ≠ current run   → stamp only
 *   already_stamped  row identical; lastSeen = current run    → no write
 *
 * Drive and S3 have no provider-specific exceptional category: every
 * discovered physical file falls into exactly one of the five categories
 * above. Telegram reconciliation is a separate service and never calls this
 * module.
 *
 * Batch-safety: `unchanged` rows only ever need `lastSeenSyncRunId = runId`
 * and share no per-row data, so their stamping is collapsed into bounded
 * `updateMany` statements over the exact classified ids, scoped by
 * user + account + status + `lastSeenSyncRunId`. `new`, `changed`, and
 * `restored` need per-row payloads (or the returned created id) and stay
 * per-row.
 */

/**
 * Max ids per batched stamp statement. Provider pages are already bounded
 * (Drive `pageSize: 1000`, S3 `MaxKeys: 1000`); this keeps the generated SQL
 * `IN (...)` list well under that even if a provider raises its page size.
 */
export const STAMP_BATCH_SIZE = 500

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = []
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size))
  return out
}

export type DiscoveredPhysicalFile = {
  providerFileId: string
  name: string
  mimeType: string
  sizeBytes: bigint
  /** Provider folder id where the file physically lives (Drive parent / S3 prefix). */
  providerParentId: string | null
}

/** The DB columns reconciliation compares against (selected in one batch). */
export type ExistingFileRow = {
  id: string
  providerFileId: string
  name: string
  mimeType: string
  sizeBytes: bigint
  folderId: string | null
  status: string
  deletedAt: Date | null
  lastSeenSyncRunId: string | null
}

export type FileCategory = 'new' | 'changed' | 'restored' | 'unchanged' | 'already_stamped'

export type ClassifiedFile =
  | { category: 'new'; physical: DiscoveredPhysicalFile; row: null; moved: false }
  | { category: 'changed'; physical: DiscoveredPhysicalFile; row: ExistingFileRow; moved: boolean }
  | { category: 'restored'; physical: DiscoveredPhysicalFile; row: ExistingFileRow; moved: boolean }
  | { category: 'unchanged'; physical: DiscoveredPhysicalFile; row: ExistingFileRow; moved: false }
  | { category: 'already_stamped'; physical: DiscoveredPhysicalFile; row: ExistingFileRow; moved: false }

/** Page-scoped classification/diagnostic counters (returned by every page). */
export type FilePageDiagnostics = {
  scanned: number
  created: number
  changed: number
  restored: number
  /** Unchanged rows that still need a `lastSeenSyncRunId` stamp. */
  unchanged: number
  alreadyStamped: number
  failed: number
  /** Per-row DB writes actually issued by this page (create/update). */
  rowWrites: number
  /** Batched `updateMany` statements issued by this page (stamp batches). */
  batchWrites: number
  /** Rows stamped by those batches (reported by `updateMany.count`). */
  batchStamped: number
  /** Total DB write statements issued: `rowWrites + batchWrites`. */
  dbWriteOps: number
}

/** Run-scoped accumulator; page counters are merged into it. */
export type FileReconcileDiagnostics = FilePageDiagnostics & { pages: number }

export const emptyFileReconcileDiagnostics = (): FileReconcileDiagnostics => ({
  pages: 0,
  scanned: 0,
  created: 0,
  changed: 0,
  restored: 0,
  unchanged: 0,
  alreadyStamped: 0,
  failed: 0,
  rowWrites: 0,
  batchWrites: 0,
  batchStamped: 0,
  dbWriteOps: 0,
})

export function mergeFilePageDiagnostics(
  run: FileReconcileDiagnostics,
  page: FilePageDiagnostics,
): FileReconcileDiagnostics {
  run.pages += 1
  run.scanned += page.scanned
  run.created += page.created
  run.changed += page.changed
  run.restored += page.restored
  run.unchanged += page.unchanged
  run.alreadyStamped += page.alreadyStamped
  run.failed += page.failed
  run.rowWrites += page.rowWrites
  run.batchWrites += page.batchWrites
  run.batchStamped += page.batchStamped
  run.dbWriteOps += page.dbWriteOps
  return run
}

export type FileReconcileContext = {
  userId: string
  accountId: string
  provider: string
  runId: string
  /** Stats shared with the folder reconciler's SyncRunContext. */
  stats: {
    filesDiscovered: number
    filesCreated: number
    filesUpdated: number
    filesMoved: number
  }
  /**
   * Optional run-scoped diagnostics. When present, each page's counters are
   * merged into it so the orchestrator can log how many writes a run issued
   * (and, after Phase 2, how many the batching eliminated).
   */
  diagnostics?: FileReconcileDiagnostics
}

/**
 * Classify one page of provider files against the already-loaded DB rows.
 * Pure — no I/O, no writes. Exported so classification semantics are directly
 * unit-testable without a prisma double.
 */
export function classifyFilePage(
  existing: ExistingFileRow[],
  physicalFiles: DiscoveredPhysicalFile[],
  resolvedVirtualParentId: string | null,
  runId: string,
): ClassifiedFile[] {
  const byProviderId = new Map(existing.map((f) => [f.providerFileId, f]))

  return physicalFiles.map((physical): ClassifiedFile => {
    const row = byProviderId.get(physical.providerFileId)
    if (!row) return { category: 'new', physical, row: null, moved: false }

    const moved = row.folderId !== resolvedVirtualParentId
    // mimeType is user-owned after PATCH /files/batch/mime-type; sync only
    // sets it once, on create. name + sizeBytes stay provider-owned.
    const metaChanged = row.name !== physical.name || row.sizeBytes !== physical.sizeBytes
    const restored = row.status !== 'active' || row.deletedAt !== null

    if (restored) return { category: 'restored', physical, row, moved }
    if (moved || metaChanged) return { category: 'changed', physical, row, moved }
    if (row.lastSeenSyncRunId !== runId) return { category: 'unchanged', physical, row, moved: false }
    return { category: 'already_stamped', physical, row, moved: false }
  })
}

function logEvent(ctx: FileReconcileContext, event: string, data: Record<string, unknown>) {
  console.info('[sync]', JSON.stringify({ event, connectedAccountId: ctx.accountId, ...data }))
}

/** Reconcile one page of files against the DB. Mutates `ctx.stats`/`ctx.diagnostics`. */
export async function reconcileFilePage(
  ctx: FileReconcileContext,
  resolvedVirtualParentId: string | null,
  physicalFiles: DiscoveredPhysicalFile[],
): Promise<FilePageDiagnostics> {
  const page: FilePageDiagnostics = {
    scanned: physicalFiles.length,
    created: 0,
    changed: 0,
    restored: 0,
    unchanged: 0,
    alreadyStamped: 0,
    failed: 0,
    rowWrites: 0,
    batchWrites: 0,
    batchStamped: 0,
    dbWriteOps: 0,
  }
  if (physicalFiles.length === 0) {
    mergeIntoRun(ctx, page)
    return page
  }
  ctx.stats.filesDiscovered += physicalFiles.length

  const ids = physicalFiles.map((f) => f.providerFileId)
  const existing = await prisma.file.findMany({
    where: {
      userId: ctx.userId,
      connectedAccountId: ctx.accountId,
      providerFileId: { in: ids },
    },
    select: {
      id: true,
      providerFileId: true,
      name: true,
      mimeType: true,
      sizeBytes: true,
      folderId: true,
      status: true,
      deletedAt: true,
      lastSeenSyncRunId: true,
    },
  })

  const classified = classifyFilePage(existing, physicalFiles, resolvedVirtualParentId, ctx.runId)

  // Unchanged rows differ only in their generation marker, so they are
  // collected here and stamped in bounded `updateMany` batches below instead
  // of one UPDATE per row.
  const stampIds: string[] = []

  try {
    for (const entry of classified) {
      switch (entry.category) {
        case 'new': {
          await prisma.file.create({
            data: {
              userId: ctx.userId,
              connectedAccountId: ctx.accountId,
              provider: ctx.provider,
              providerFileId: entry.physical.providerFileId,
              name: entry.physical.name,
              mimeType: entry.physical.mimeType,
              sizeBytes: entry.physical.sizeBytes,
              status: 'active',
              folderId: resolvedVirtualParentId,
              lastSeenSyncRunId: ctx.runId,
            },
          })
          ctx.stats.filesCreated += 1
          page.created += 1
          page.rowWrites += 1
          break
        }
        case 'changed':
        case 'restored': {
          await prisma.file.update({
            where: { id: entry.row.id },
            data: {
              name: entry.physical.name,
              sizeBytes: entry.physical.sizeBytes,
              status: 'active',
              deletedAt: null,
              folderId: resolvedVirtualParentId,
              lastSeenSyncRunId: ctx.runId,
            },
          })
          if (entry.moved) ctx.stats.filesMoved += 1
          else ctx.stats.filesUpdated += 1
          if (entry.category === 'changed') page.changed += 1
          else page.restored += 1
          page.rowWrites += 1
          break
        }
        case 'unchanged': {
          // No data change — only the generation marker. Batched below.
          stampIds.push(entry.row.id)
          page.unchanged += 1
          break
        }
        case 'already_stamped': {
          page.alreadyStamped += 1
          break
        }
      }
    }

    // Batched generation stamping. The `where` repeats the ownership and
    // expected-state conditions (user + account + active + not already this
    // run) alongside the exact classified ids, so a row that changed between
    // classification and write — or any row belonging to another user or
    // account — can never be touched. A short-count is therefore benign:
    // the row is re-classified on the next run.
    for (const ids of chunk(stampIds, STAMP_BATCH_SIZE)) {
      const stamped = await prisma.file.updateMany({
        where: {
          id: { in: ids },
          userId: ctx.userId,
          connectedAccountId: ctx.accountId,
          status: 'active',
          lastSeenSyncRunId: { not: ctx.runId },
        },
        data: { lastSeenSyncRunId: ctx.runId },
      })
      page.batchWrites += 1
      page.batchStamped += stamped.count
    }
  } catch (error) {
    page.failed += 1
    page.dbWriteOps = page.rowWrites + page.batchWrites
    logEvent(ctx, 'sync.file.page_failed', {
      runId: ctx.runId,
      scanned: page.scanned,
      created: page.created,
      changed: page.changed,
      restored: page.restored,
      unchanged: page.unchanged,
      alreadyStamped: page.alreadyStamped,
      rowWrites: page.rowWrites,
      batchWrites: page.batchWrites,
      batchStamped: page.batchStamped,
      dbWriteOps: page.dbWriteOps,
      errorCode: errorCodeFor(error),
    })
    mergeIntoRun(ctx, page)
    // Rethrown so the scan aborts and the run is marked failed — a batch
    // failure must never let the SyncRun complete successfully, and missing
    // reconciliation must never run after it.
    throw error
  }

  page.dbWriteOps = page.rowWrites + page.batchWrites

  logEvent(ctx, 'sync.file.page', {
    runId: ctx.runId,
    scanned: page.scanned,
    created: page.created,
    changed: page.changed,
    restored: page.restored,
    unchanged: page.unchanged,
    alreadyStamped: page.alreadyStamped,
    failed: page.failed,
    rowWrites: page.rowWrites,
    batchWrites: page.batchWrites,
    batchStamped: page.batchStamped,
    dbWriteOps: page.dbWriteOps,
  })
  mergeIntoRun(ctx, page)
  return page
}

function mergeIntoRun(ctx: FileReconcileContext, page: FilePageDiagnostics) {
  if (ctx.diagnostics) mergeFilePageDiagnostics(ctx.diagnostics, page)
}

function errorCodeFor(error: unknown): string {
  if (typeof error === 'object' && error !== null && typeof (error as { code?: unknown }).code === 'string') {
    return (error as { code: string }).code
  }
  return 'SYNC_FILE_RECONCILE_FAILED'
}
