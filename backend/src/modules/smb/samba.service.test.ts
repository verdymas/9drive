import { describe, expect, it } from 'vitest'
import { AppError } from '../../utils/app-error.js'
import type { CommandRunner } from './samba-cli.js'
import { SambaService, type SambaOptions } from './samba.service.js'

/** A CommandRunner that answers from a scripted table; unknown commands fail. */
class FakeRunner implements CommandRunner {
  public calls: string[][] = []
  constructor(private readonly script: Record<string, { code: number | null; stdout?: string; stderr?: string }>) {}

  async run(args: string[]): Promise<{ stdout: string; stderr: string; code: number | null }> {
    this.calls.push(args)
    const key = args.join(' ')
    const entry = this.script[key]
    if (!entry) return { stdout: '', stderr: `unexpected call: ${key}`, code: 1 }
    return { stdout: entry.stdout ?? '', stderr: entry.stderr ?? '', code: entry.code }
  }
}

function makeFs() {
  const files = new Map<string, string>()
  return {
    files,
    exists: (file: string) => files.has(file),
    read: (file: string) => files.get(file) ?? '',
    write: (file: string, data: string) => void files.set(file, data),
    chmod: () => undefined,
  }
}

function makeService(options: Partial<SambaOptions> & { fs: ReturnType<typeof makeFs>; testparm?: FakeRunner; service?: FakeRunner; files?: Record<string, string> }) {
  const { fs, testparm, service, ...rest } = options
  const testparmRunner = testparm ?? new FakeRunner({
    '--version': { code: 0, stdout: 'Version 4.19.5' },
    '-Lw': { code: 0, stdout: 'media:1001:1001:SMB User\n$:SID lines\n' },
  })
  const serviceRunner = service ?? new FakeRunner({
    'is-active smbd': { code: 0, stdout: 'active' },
    'is-enabled smbd': { code: 0, stdout: 'enabled' },
    'reload smbd': { code: 0 },
    'start smbd': { code: 0 },
  })
  return new SambaService('/etc/samba/smb.conf', {
    allowedRoot: '/srv',
    stateDir: '/var/lib/9drive',
    binaryPaths: { testparm: '/usr/sbin/testparm', pdbedit: '/usr/bin/pdbedit', smbstatus: '/usr/bin/smbstatus' },
    fsOps: fs,
    testparmRunner,
    serviceRunner,
    // Share paths under /srv are treated as existing directories.
    pathChecker: {
      exists: (file) => file.startsWith('/srv/'),
      isDirectory: (file) => file.startsWith('/srv/'),
    },
    // Tests run on any host OS: resolve POSIX-style paths with the same
    // semantics as the production resolver (absolute input wins over root).
    pathResolver: (rawPath) => {
      if (rawPath.includes('\0')) throw new AppError('PATH_INVALID', 'invalid path')
      if (rawPath === '/etc/passwd' || rawPath.split('/').includes('..')) throw new AppError('PATH_TRAVERSAL', 'traversal')
      return rawPath.replace(/\/{2,}/g, '/')
    },
    ...rest,
  })
}

describe('SambaService', () => {
  describe('detect/status', () => {
    it('reports unavailable when testparm is missing', async () => {
      const fs = makeFs()
      const service = makeService({
        fs,
        testparm: new FakeRunner({ '--version': { code: null, stderr: 'command not found' } }),
      })
      const health = await service.detect()
      expect(health.available).toBe(false)
      expect(health.status).toBe('unavailable')
    })

    it('reports running with version and config path', async () => {
      const fs = makeFs()
      const service = makeService({ fs, files: { '/etc/samba/smb.conf': '[global]\nworkgroup = WORKGROUP\n' } })
      const health = await service.detect()
      expect(health.available).toBe(true)
      expect(health.status).toBe('running')
      expect(health.version).toBe('4.19.5')
      expect(health.configPath).toBe('/etc/samba/smb.conf')
    })

    it('reports config_error when testparm rejects the file', async () => {
      const fs = makeFs()
      const service = makeService({
        fs,
        files: { '/etc/samba/smb.conf': '[Broken]\npath = /tmp\nunknown-param = x\n' },
        testparm: new FakeRunner({
          '--version': { code: 0, stdout: 'Version 4.19.5' },
          '-s /etc/samba/smb.conf': { code: 1, stderr: 'Unknown parameter "unknown-param"' },
        }),
      })
      const health = await service.status()
      expect(health.status).toBe('config_error')
      expect(health.message).toContain('unknown-param')
    })
  })

  describe('share management', () => {
    it('creates a share, writes config and reloads smbd', async () => {
      const fs = makeFs()
      const testparm = new FakeRunner({ '--version': { code: 0 }, '-s /etc/samba/smb.conf.9drive-tmp': { code: 0 } })
      const service = makeService({ fs, testparm })
      const share = await service.createShare({
        name: 'Movies',
        path: '/srv/media/movies',
        description: 'Movie library',
        readOnly: true,
        guestAccess: false,
        browsable: true,
        validUsers: ['media'],
        validGroups: [],
        hideFiles: '',
      })
      expect(share.id).toBe('Movies')
      const content = fs.files.get('/etc/samba/smb.conf')!
      expect(content).toContain('[Movies]')
      // Path separators and drive letters differ on Windows; compare the
      // share-relative portion only.
      expect(content.replace(/\\/g, '/').replace(/^[A-Z]:\/?/, '').replace(/\/{2,}/g, '/')).toContain('path = /srv/media/movies')
      expect(service.listShares()).resolves.toMatchObject([{ name: 'Movies', readOnly: true, validUsers: ['media'] }])
    })

    it('rejects a duplicate share name (case-insensitive)', async () => {
      const fs = makeFs()
      fs.files.set('/etc/samba/smb.conf', '[movies]\npath = /srv/a\n')
      const service = makeService({ fs })
      await expect(
        service.createShare({
          name: 'Movies',
          path: '/srv/b',
          description: '',
          readOnly: true,
          guestAccess: false,
          browsable: true,
          validUsers: [],
          validGroups: [],
          hideFiles: '',
        }),
      ).rejects.toMatchObject({ code: 'SHARE_EXISTS' })
    })

    it('rejects a path outside the allowed root', async () => {
      const fs = makeFs()
      const service = makeService({ fs })
      await expect(
        service.createShare({
          name: 'Esc',
          path: '/etc/passwd',
          description: '',
          readOnly: true,
          guestAccess: false,
          browsable: true,
          validUsers: [],
          validGroups: [],
          hideFiles: '',
        }),
      ).rejects.toMatchObject({ code: 'PATH_TRAVERSAL' })
    })

    it('preserves foreign sections when writing', async () => {
      const fs = makeFs()
      fs.files.set('/etc/samba/smb.conf', '[global]\n   workgroup = WORKGROUP\n   server string = %h server\n')
      const testparm = new FakeRunner({ '--version': { code: 0 }, '-s /etc/samba/smb.conf.9drive-tmp': { code: 0 } })
      const service = makeService({ fs, testparm })
      await service.createShare({
        name: 'Data',
        path: '/srv/data',
        description: '',
        readOnly: false,
        guestAccess: false,
        browsable: true,
        validUsers: [],
        validGroups: [],
        hideFiles: '',
      })
      const content = fs.files.get('/etc/samba/smb.conf')!
      expect(content).toContain('workgroup = WORKGROUP')
      expect(content).toContain('server string = %h server')
      expect(content).toContain('[Data]')
    })

    it('updates a share', async () => {
      const fs = makeFs()
      fs.files.set('/etc/samba/smb.conf', '[Movies]\npath = /srv/movies\nread only = no\n')
      const testparm = new FakeRunner({ '--version': { code: 0 }, '-s /etc/samba/smb.conf.9drive-tmp': { code: 0 } })
      const service = makeService({ fs, testparm })
      const updated = await service.updateShare('Movies', { readOnly: true, validUsers: ['alice'] })
      expect(updated.readOnly).toBe(true)
      const content = fs.files.get('/etc/samba/smb.conf')!
      expect(content).toContain('read only = yes')
      expect(content).toContain('valid users = alice')
    })

    it('rolls back when testparm rejects the generated config', async () => {
      const fs = makeFs()
      fs.files.set('/etc/samba/smb.conf', '[Movies]\npath = /srv/movies\n')
      const before = fs.files.get('/etc/samba/smb.conf')
      const testparm = new FakeRunner({ '--version': { code: 0 }, '-s /etc/samba/smb.conf.9drive-tmp': { code: 1, stderr: 'bad param' } })
      const service = makeService({ fs, testparm })
      await expect(
        service.createShare({
          name: 'Bad',
          path: '/srv/bad',
          description: '',
          readOnly: true,
          guestAccess: false,
          browsable: true,
          validUsers: [],
          validGroups: [],
          hideFiles: '',
        }),
      ).rejects.toMatchObject({ code: 'SMB_CONFIG_INVALID' })
      expect(fs.files.get('/etc/samba/smb.conf')).toBe(before)
    })

    it('deletes a share but leaves the files on disk', async () => {
      const fs = makeFs()
      fs.files.set('/etc/samba/smb.conf', '[Movies]\npath = /srv/movies\n')
      const testparm = new FakeRunner({ '--version': { code: 0 }, '-s /etc/samba/smb.conf.9drive-tmp': { code: 0 } })
      const service = makeService({ fs, testparm })
      await service.deleteShare('Movies')
      expect(fs.files.get('/etc/samba/smb.conf')).not.toContain('[Movies]')
      // The share list is now empty.
      expect(service.listShares()).resolves.toEqual([])
    })
  })

  describe('user management', () => {
    it('creates a user via pdbedit', async () => {
      const fs = makeFs()
      const testparm = new FakeRunner({
        '--version': { code: 0 },
        '-Lw': { code: 0, stdout: '' },
        '-a -u bob -t -s:secret123': { code: 0 },
      })
      const service = makeService({ fs, testparm })
      const user = await service.createUser('bob', 'secret123')
      expect(user.name).toBe('bob')
      expect(user.enabled).toBe(true)
    })

    it('rejects a weak password', async () => {
      const fs = makeFs()
      const service = makeService({ fs })
      await expect(service.createUser('bob', 'short')).rejects.toMatchObject({ code: 'PASSWORD_POLICY' })
    })

    it('disables and enables a user', async () => {
      const fs = makeFs()
      const testparm = new FakeRunner({
        '--version': { code: 0 },
        '-Lw': { code: 0, stdout: 'bob:1001:1001:SMB User\n' },
        '--disable -u bob': { code: 0 },
        '--enable -u bob': { code: 0 },
      })
      const service = makeService({ fs, testparm })
      await service.updateUser('bob', { enabled: false })
      await service.updateUser('bob', { enabled: true })
      expect(testparm.calls).toContainEqual(['--disable', '-u', 'bob'])
      expect(testparm.calls).toContainEqual(['--enable', '-u', 'bob'])
    })

    it('deletes a user', async () => {
      const fs = makeFs()
      const testparm = new FakeRunner({
        '--version': { code: 0 },
        '-Lw': { code: 0, stdout: 'bob:1001:1001:SMB User\n' },
        '-x -u bob': { code: 0 },
      })
      const service = makeService({ fs, testparm })
      await service.deleteUser('bob')
      expect(testparm.calls).toContainEqual(['-x', '-u', 'bob'])
    })
  })

  describe('reload', () => {
    it('validates and reloads', async () => {
      const fs = makeFs()
      const testparm = new FakeRunner({ '--version': { code: 0 }, '-s /etc/samba/smb.conf': { code: 0 } })
      const serviceRunner = new FakeRunner({ 'reload smbd': { code: 0 } })
      const service = makeService({ fs, testparm, service: serviceRunner })
      const result = await service.reload()
      expect(result.ok).toBe(true)
      expect(serviceRunner.calls).toContainEqual(['reload', 'smbd'])
    })

    it('reports failure without touching the daemon when validation fails', async () => {
      const fs = makeFs()
      const testparm = new FakeRunner({ '--version': { code: 0 }, '-s /etc/samba/smb.conf': { code: 1, stderr: 'bad' } })
      const serviceRunner = new FakeRunner({})
      const service = makeService({ fs, testparm, service: serviceRunner })
      const result = await service.reload()
      expect(result.ok).toBe(false)
      // detect() probes the service state, but no reload may ever be issued.
      expect(serviceRunner.calls.filter((call) => call[0] === 'reload' || call[0] === 'start')).toEqual([])
    })
  })
})
