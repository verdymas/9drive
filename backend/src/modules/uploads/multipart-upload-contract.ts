export type MultipartUploadMeta = {
  fieldName: string
  fileName: string
  mimeType: string
  sizeBytes: bigint
  folderId?: string
}

export type MultipartUploadFields = {
  sizeBytes?: bigint
  fileName?: string
  mimeType?: string
  folderId?: string
}

export type MultipartUploadFailure = {
  fileName: string
  code: string
  message: string
}

export function parseMultipartBatchMeta(value: string): MultipartUploadMeta[] {
  return JSON.parse(value).map((item: {
    fieldName: string
    fileName: string
    mimeType: string
    sizeBytes: string | number
    folderId?: string
  }) => ({
    fieldName: item.fieldName,
    fileName: item.fileName,
    mimeType: item.mimeType,
    sizeBytes: BigInt(item.sizeBytes),
    folderId: item.folderId,
  }))
}

export function metaForMultipartFile(
  batchMeta: MultipartUploadMeta[] | null,
  fields: MultipartUploadFields,
  fieldName: string,
  info: { filename: string; mimeType: string },
): MultipartUploadMeta | null {
  if (batchMeta) return batchMeta.find((item) => item.fieldName === fieldName) ?? null
  if (!fields.sizeBytes) return null
  return {
    fieldName,
    sizeBytes: fields.sizeBytes,
    fileName: fields.fileName || info.filename,
    mimeType: fields.mimeType || info.mimeType || 'application/octet-stream',
    folderId: fields.folderId,
  }
}

export function multipartUploadResponse(
  batchMeta: MultipartUploadMeta[] | null,
  completed: Array<Record<string, unknown>>,
  failed: MultipartUploadFailure[],
) {
  if (completed.length === 0) {
    return {
      status: 400,
      body: {
        code: failed[0]?.code ?? 'UPLOAD_FAILED',
        message: failed[0]?.message ?? 'Upload failed',
        failed,
      },
    }
  }
  if (!batchMeta && completed.length === 1 && failed.length === 0) {
    return { status: 201, body: { file: completed[0] } }
  }
  return { status: 201, body: { files: completed, failed } }
}
