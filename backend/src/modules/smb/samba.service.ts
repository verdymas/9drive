import fs from 'node:fs'
import path from 'node:path'
import { AppError } from '../../utils/app-error.js'
import type { ProtocolHealth, ProtocolShare, ProtocolUser, StorageProtocol } from '../storage/storage-protocol.js'
import { SystemCommandRunner, detectConfigPath, detectSambaBinaries, type CommandContext, type CommandRunner } from './samba-cli.js'
import {
  isManageableShare,
  parseExistingConfig,
  renderConfig,
} from './smb-config.js'
import { assertExistingDirectory, assertSystemGroupExists, assertSystemUserExists, assertValidShareName, assertValidPassword, assertValidUserName, setPathChecker, setPathResolver, type PathChecker } from './smb-validation.js'

const SMB_SERVICE_NAME = 'smbd'

export type SambaOptions = {
  /** Root allowed for share paths. Defaults to `/`. */
  allowedRoot?: string
  /** Directory for state files (e.g. the manager's own marker file). */
  stateDir?: string
  /** Override Samba binary paths (used by tests). */
  binaryPaths?: Record<string, string | null>
  /** Override the systemctl command runner (used by tests). */
  serviceRunner?: CommandRunner
  /** Override `testparm` invocation (used by tests). */
  testparmRunner?: CommandRunner
  /** Override file system access (used by tests). */
  fsOps?: {
    exists: (file: string) => boolean
    read: (file: string) => string
    write: (file: string, data: string) => void
    chmod: (file: string, mode: number) => void
  }
  /** Override the directory-exists probe (used by tests). */
  pathChecker?: PathChecker
  /** Override path resolution (used by tests). */
  pathResolver?: (rawPath: string, root: string) => string
}

export class SambaService implements StorageProtocol {
  readonly configPath: string
  private readonly allowedRoot: string
  private readonly stateDir: string
  private readonly runner: CommandRunner
  private readonly serviceRunner: CommandRunner
  private readonly fsOps: { exists: (file: string) => boolean; read: (file: string) => string; write: (file: string, data: string) => void; chmod: (file: string, mode: number) => void }

  constructor(readonly configFilePath: string = detectConfigPath(), private readonly options: SambaOptions = {}) {
    this.configPath = configFilePath
    this.allowedRoot = options.allowedRoot ?? '/'
    this.stateDir = options.stateDir ?? '/var/lib/9drive'
    const context: CommandContext = { binary: 'testparm', binaryPaths: options.binaryPaths ?? detectSambaBinaries(), configPath: configFilePath }
    this.runner = options.testparmRunner ?? new SystemCommandRunner(context)
    this.serviceRunner = options.serviceRunner ?? new SystemCommandRunner({ binary: 'systemctl', binaryPaths: { systemctl: detectSystemctlPath() } })
    this.fsOps = options.fsOps ?? {
      exists: (file) => fs.existsSync(file),
      read: (file) => fs.readFileSync(file, 'utf8'),
      write: (file, data) => fs.writeFileSync(file, data, 'utf8'),
      chmod: (file, mode) => fs.chmodSync(file, mode),
    }
    if (options.pathChecker) setPathChecker(options.pathChecker)
    if (options.pathResolver) setPathResolver(options.pathResolver)
  }

  // -------------------------------------------------------------------------
  // Detection & status
  // -------------------------------------------------------------------------

  private getServiceRunner(): CommandRunner | null {
    return this.serviceRunner
  }

  private parseVersion(stdout: string): string | null {
    const match = /Version (\d+\.\d+(?:\.\d+)?)/.exec(stdout)
    return match ? match[1] : null
  }

  private getMarkerPath(): string {
    return path.join(this.stateDir, 'smb-managed.conf')
  }

  async detect(): Promise<ProtocolHealth> {
    const testparm = await this.runner.run(['--version'])
    if (testparm.code !== 0) {
      return {
        available: false,
        status: 'unavailable',
        message: 'Samba is not installed (testparm not found). Install Samba to manage SMB shares.',
      }
    }
    const version = this.parseVersion(testparm.stdout)

    let service: string | null = null
    let running = false
    const serviceRunner = this.getServiceRunner()
    if (serviceRunner) {
      const state = await serviceRunner.run(['is-active', SMB_SERVICE_NAME])
      const enabled = await serviceRunner.run(['is-enabled', SMB_SERVICE_NAME])
      running = state.code === 0
      service = `smbd${enabled.code === 0 ? ' (enabled)' : ''}`
    }

    return {
      available: true,
      status: running ? 'running' : 'stopped',
      version,
      service,
      configPath: this.configPath,
    }
  }

  async status(): Promise<ProtocolHealth> {
    const detected = await this.detect()
    if (!detected.available) return detected

    // Configuration error: testparm must validate the file (unless Samba has
    // never been configured, in which case an empty default file is fine).
    const check = await this.runner.run(['-s', this.configPath])
    if (check.code !== 0 && !(this.fsOps.exists(this.configPath) && this.fsOps.read(this.configPath).trim() === '')) {
      return { ...detected, status: 'config_error', message: check.stderr.trim() || 'Invalid Samba configuration (testparm failed).' }
    }

    const state = this.getServiceRunner() ? await this.getServiceRunner()!.run(['is-active', SMB_SERVICE_NAME]) : null
    if (state && state.code !== 0) return { ...detected, status: 'stopped' }

    return detected
  }

  // -------------------------------------------------------------------------
  // Share management
  // -------------------------------------------------------------------------

  private loadShares(): Array<Omit<ProtocolShare, 'id'>> {
    const content = this.fsOps.exists(this.configPath) ? this.fsOps.read(this.configPath) : ''
    return parseExistingConfig(content).shares.filter(isManageableShare)
  }

  private loadManagedConfig(): ReturnType<typeof parseExistingConfig> {
    const content = this.fsOps.exists(this.configPath) ? this.fsOps.read(this.configPath) : ''
    const parsed = parseExistingConfig(content)
    parsed.shares = parsed.shares.filter(isManageableShare)
    return parsed
  }

  async listShares(): Promise<ProtocolShare[]> {
    return this.loadShares().map((share) => ({ ...share, id: share.name }))
  }

  private async persistConfig(shares: Array<Omit<ProtocolShare, 'id'>>): Promise<void> {
    const parsed = this.loadManagedConfig()
    const previous = this.fsOps.exists(this.configPath) ? this.fsOps.read(this.configPath) : ''
    const next = renderConfig({ foreignSections: parsed.foreignSections, shares })

    // Atomic-ish write: write to a temp file, chmod 0600, then rename.
    const tempPath = `${this.configPath}.9drive-tmp`
    this.fsOps.write(tempPath, next)
    this.fsOps.chmod(tempPath, 0o600)

    const validate = await this.runner.run(['-s', tempPath])
    if (validate.code !== 0) {
      this.fsOps.write(tempPath, previous) // restore previous content on the temp file
      throw new AppError('SMB_CONFIG_INVALID', `Samba rejected the generated configuration: ${validate.stderr.trim()}`)
    }

    this.fsOps.write(this.configPath, next)
    this.fsOps.chmod(this.configPath, 0o600)
    try {
      fs.unlinkSync(tempPath)
    } catch {
      // best effort cleanup
    }
    this.writeManagedMarker()
  }

  private writeManagedMarker(): void {
    try {
      fs.mkdirSync(this.stateDir, { recursive: true })
      fs.writeFileSync(this.getMarkerPath(), `${this.configPath}\n`, 'utf8')
    } catch {
      // A missing marker is non-fatal — the configuration itself is authoritative.
    }
  }

  private async reloadDaemon(): Promise<void> {
    const serviceRunner = this.getServiceRunner()
    if (!serviceRunner) return
    const result = await serviceRunner.run(['reload', SMB_SERVICE_NAME])
    if (result.code !== 0) {
      // The daemon may be stopped — try a full start instead of failing.
      const start = await serviceRunner.run(['start', SMB_SERVICE_NAME])
      if (start.code !== 0) {
        throw new AppError('SMB_RELOAD_FAILED', `Failed to reload Samba: ${result.stderr.trim() || start.stderr.trim()}`)
      }
    }
  }

  private async commit(shares: Array<Omit<ProtocolShare, 'id'>>): Promise<void> {
    await this.persistConfig(shares)
    await this.reloadDaemon()
  }

  private assertValidPermissions(validUsers: string[], validGroups: string[]): void {
    for (const user of validUsers) assertSystemUserExists(user)
    for (const group of validGroups) assertSystemGroupExists(group)
  }

  async createShare(share: Omit<ProtocolShare, 'id'>): Promise<ProtocolShare> {
    const name = assertValidShareName(share.name)
    const resolvedPath = assertExistingDirectory(share.path, this.allowedRoot)
    this.assertValidPermissions(share.validUsers, share.validGroups)
    const existing = this.loadShares()
    if (existing.some((item) => item.name.toLowerCase() === name.toLowerCase())) {
      throw new AppError('SHARE_EXISTS', `A share named '${name}' already exists.`)
    }
    const next = [...existing, { ...share, name, path: resolvedPath }]
    await this.commit(next)
    return { ...next[next.length - 1], id: name }
  }

  async updateShare(id: string, patch: Partial<ProtocolShare>): Promise<ProtocolShare> {
    const existing = this.loadShares()
    const index = existing.findIndex((item) => item.name === id)
    if (index === -1) throw new AppError('SHARE_NOT_FOUND', `Share '${id}' does not exist.`)

    let target = existing[index]
    if (patch.name !== undefined && patch.name !== id) {
      const newName = assertValidShareName(patch.name)
      if (existing.some((item) => item.name.toLowerCase() === newName.toLowerCase())) {
        throw new AppError('SHARE_EXISTS', `A share named '${newName}' already exists.`)
      }
      target = { ...target, name: newName }
    }
    if (patch.path !== undefined && patch.path !== target.path) {
      target = { ...target, path: assertExistingDirectory(patch.path, this.allowedRoot) }
    }
    if (patch.description !== undefined) target = { ...target, description: patch.description }
    if (patch.readOnly !== undefined) target = { ...target, readOnly: patch.readOnly }
    if (patch.guestAccess !== undefined) target = { ...target, guestAccess: patch.guestAccess }
    if (patch.browsable !== undefined) target = { ...target, browsable: patch.browsable }
    if (patch.validUsers !== undefined) target = { ...target, validUsers: [...new Set(patch.validUsers)] }
    if (patch.validGroups !== undefined) target = { ...target, validGroups: [...new Set(patch.validGroups)] }
    if (patch.hideFiles !== undefined) target = { ...target, hideFiles: patch.hideFiles }

    this.assertValidPermissions(target.validUsers, target.validGroups)
    const next = [...existing]
    next[index] = target
    await this.commit(next)
    return { ...target, id: target.name }
  }

  async deleteShare(id: string): Promise<void> {
    const existing = this.loadShares()
    const next = existing.filter((item) => item.name !== id)
    if (next.length === existing.length) throw new AppError('SHARE_NOT_FOUND', `Share '${id}' does not exist.`)
    await this.commit(next)
  }

  // -------------------------------------------------------------------------
  // User management
  // -------------------------------------------------------------------------

  private pdbedit(args: string[]): Promise<{ ok: boolean; message: string }> {
    return this.runner
      .run(args)
      .then((result) => (result.code === 0 ? { ok: true, message: '' } : { ok: false, message: result.stderr.trim() || `pdbedit failed (${result.code ?? 'not found'})` }))
  }

  async listUsers(): Promise<ProtocolUser[]> {
    const result = await this.runner.run(['-Lw'])
    const users: ProtocolUser[] = []
    if (result.code === 0) {
      for (const line of result.stdout.split('\n')) {
        const [name, , uid] = line.split(':')
        if (!name || uid === undefined) continue
        if (name.startsWith('$')) continue // SID lines
        users.push({ id: name, name, enabled: !line.includes('[-W-]') })
      }
    }
    return users
  }

  async createUser(name: string, password: string): Promise<ProtocolUser> {
    const userName = assertValidUserName(name)
    assertValidPassword(password)
    const existing = await this.listUsers()
    if (existing.some((user) => user.name === userName)) {
      throw new AppError('USER_EXISTS', `SMB user '${userName}' already exists.`)
    }
    const result = await this.pdbedit(['-a', '-u', userName, '-t', `-s:${password}`])
    if (!result.ok) throw new AppError('USER_CREATE_FAILED', `Failed to create SMB user: ${result.message}`)
    return { id: userName, name: userName, enabled: true }
  }

  async updateUser(id: string, patch: { password?: string; enabled?: boolean }): Promise<ProtocolUser> {
    const existing = await this.listUsers()
    if (!existing.some((user) => user.name === id)) throw new AppError('USER_NOT_FOUND', `SMB user '${id}' does not exist.`)

    if (patch.password !== undefined) {
      assertValidPassword(patch.password)
      const result = await this.pdbedit(['-a', '-u', id, '-t', `-s:${patch.password}`])
      if (!result.ok) throw new AppError('USER_PASSWORD_FAILED', `Failed to update password: ${result.message}`)
    }
    if (patch.enabled !== undefined) {
      const result = await this.pdbedit([patch.enabled ? '--enable' : '--disable', '-u', id])
      if (!result.ok) throw new AppError('USER_STATE_FAILED', `Failed to ${patch.enabled ? 'enable' : 'disable'} user: ${result.message}`)
    }
    return { id, name: id, enabled: patch.enabled ?? existing.find((user) => user.name === id)?.enabled ?? true }
  }

  async deleteUser(id: string): Promise<void> {
    const existing = await this.listUsers()
    if (!existing.some((user) => user.name === id)) throw new AppError('USER_NOT_FOUND', `SMB user '${id}' does not exist.`)
    const result = await this.pdbedit(['-x', '-u', id])
    if (!result.ok) throw new AppError('USER_DELETE_FAILED', `Failed to delete SMB user: ${result.message}`)
  }

  // -------------------------------------------------------------------------
  // Reload
  // -------------------------------------------------------------------------

  async reload(): Promise<{ ok: true; message: string } | { ok: false; message: string }> {
    const health = await this.detect()
    if (!health.available) {
      return { ok: false, message: health.message ?? 'Samba is not available.' }
    }

    const validate = await this.runner.run(['-s', this.configPath])
    if (validate.code !== 0) {
      return { ok: false, message: validate.stderr.trim() || 'Invalid Samba configuration (testparm failed).' }
    }

    try {
      await this.reloadDaemon()
      return { ok: true, message: 'Samba configuration validated and reloaded.' }
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : 'Failed to reload Samba.' }
    }
  }

  /** Count currently connected SMB clients via `smbstatus -p` (PID lines). */
  async getConnectedUsers(): Promise<number> {
    const result = await this.runner.run(['-p'])
    if (result.code !== 0) return 0
    // smbstatus -p prints one line per connected client in a PID column;
    // header rows like "Samba version" never have a numeric PID.
    const pids = new Set<string>()
    for (const line of result.stdout.split('\n')) {
      const pid = line.trim().split(/\s+/)[0]
      if (pid && /^\d+$/.test(pid)) pids.add(pid)
    }
    return pids.size
  }
}

function detectSystemctlPath(): string | null {
  for (const base of ['/usr/bin', '/usr/sbin', '/bin', '/sbin']) {
    const candidate = `${base}/systemctl`
    if (fs.existsSync(candidate)) return candidate
  }
  return null
}
