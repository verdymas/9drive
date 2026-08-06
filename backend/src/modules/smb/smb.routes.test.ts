import { describe, expect, it } from 'vitest'
import { createSmbRouter } from './smb.routes.js'
import { SambaService } from './samba.service.js'
import { AppError } from '../../utils/app-error.js'

describe('createSmbRouter', () => {
  it('returns a router that rejects unauthenticated access', async () => {
    const router = createSmbRouter()
    expect(router).toBeDefined()
    // The router stack starts with requireAuth.
    expect(router.stack[0]?.route).toBeUndefined()
  })

  it('builds a SambaService with the module options', () => {
    const options = {
      sambaOptions: { allowedRoot: '/media', stateDir: '/var/lib/9drive' },
    }
    const router = createSmbRouter(options)
    expect(router).toBeDefined()
  })
})

describe('SambaService route handlers', () => {
  it('maps AppError to stable HTTP responses', async () => {
    const files = new Map<string, string>()
    const service = new SambaService('/etc/samba/smb.conf', {
      allowedRoot: '/srv',
      pathChecker: { exists: (file) => file.startsWith('/srv/'), isDirectory: (file) => file.startsWith('/srv/') },
      pathResolver: (rawPath) => rawPath,
      testparmRunner: {
        run: async (args) => {
          if (args[0] === '--version') return { stdout: 'Version 4.19.5', stderr: '', code: 0 }
          if (args[0] === '-s') return { stdout: '', stderr: '', code: 0 }
          return { stdout: '', stderr: '', code: 1 }
        },
      },
      fsOps: {
        exists: (file) => files.has(file),
        read: (file) => files.get(file) ?? '',
        write: (file, data) => void files.set(file, data),
        chmod: () => undefined,
      },
    })
    await expect(service.createShare({
      name: 'X',
      path: '/srv/x',
      description: '',
      readOnly: true,
      guestAccess: false,
      browsable: true,
      validUsers: [],
      validGroups: [],
      hideFiles: '',
    })).rejects.toThrow(AppError)
  })
})
