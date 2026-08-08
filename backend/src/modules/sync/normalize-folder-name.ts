/**
 * Folder-name normalization used by Sync folder matching.
 *
 * Sync matches physical folders to virtual folders scoped by
 * (userId, virtual parent, normalized name) — never by raw name alone. NFC
 * normalization follows the `filename-sanitize.ts` precedent; trim + lowercase
 * are the only folding applied so names stay recognizable.
 *
 * This is the single normalization source for Sync AND for the folder routes
 * (folder creation / rename must keep the `normalizedName` index truthful).
 */
export function normalizeFolderName(name: string): string {
  return name.normalize('NFC').trim().toLowerCase()
}
