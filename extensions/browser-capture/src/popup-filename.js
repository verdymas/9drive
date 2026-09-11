/**
 * Return only a filename the user explicitly chose in the import dialog.
 * A value that merely mirrors the capture's suggestion is not an override.
 */
export function explicitFilenameFromDialog({ suggestedFilename, dialogValue, existingCustomFilename } = {}) {
  const value = String(dialogValue ?? '').trim()
  if (!value) return null
  if (existingCustomFilename && value === String(existingCustomFilename).trim()) return value
  const suggested = String(suggestedFilename ?? '').trim()
  return value !== suggested ? value : null
}
