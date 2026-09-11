import { prisma } from '../../config/prisma.js'
import { AppError } from '../../utils/app-error.js'
import { getS3DownloadDecision } from '../s3/s3.service.js'

type ResolveAuthenticatedDownloadInput = {
  userId: string
  fileId: string
  range?: string
  directS3Enabled: boolean
  directS3TtlSeconds: number
}

/**
 * The authorization boundary for ordinary downloads. A delivery decision is
 * made only after the owned, active File row has been resolved.
 */
export async function resolveAuthenticatedDownload(input: ResolveAuthenticatedDownloadInput) {
  const file = await prisma.file.findFirst({
    where: { id: input.fileId, userId: input.userId, status: 'active' },
    include: { connectedAccount: true },
  })
  if (!file) throw new AppError('FILE_NOT_FOUND', 'File not found.', 404)

  const decision = await getS3DownloadDecision(file, {
    enabled: input.directS3Enabled,
    ttlSeconds: input.directS3TtlSeconds,
    range: input.range,
    disposition: 'attachment',
  })
  return { file, decision }
}
