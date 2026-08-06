import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import fs from 'node:fs'

const execFileAsync = promisify(execFile)

/**
 * Low-level wrapper around the Samba command line tools (testparm, pdbedit,
 * smbstatus) and systemctl.
 *
 * Security: user input is NEVER interpolated into a shell string. Every
 * invocation goes through `execFile` with an argument array, so arguments are
 * passed verbatim and can never execute shell code or inject extra flags.
 */

export type ExecResult = { stdout: string; stderr: string; code: number | null }

/** The only surface the Samba service depends on — easy to fake in tests. */
export interface CommandRunner {
  run(args: string[], options?: { timeoutMs?: number }): Promise<ExecResult>
}

export type CommandContext = {
  /** e.g. `testparm`. */
  binary: string
  /** Absolute paths to binaries; falls back to PATH lookup when null. */
  binaryPaths?: Record<string, string | null>
  /** Absolute path of the Samba configuration file (smb.conf). */
  configPath?: string
}

export class SystemCommandRunner implements CommandRunner {
  constructor(private readonly ctx: CommandContext) {}

  private resolveBinary(binary: string): string {
    return this.ctx.binaryPaths?.[binary] ?? binary
  }

  async run(args: string[], options: { timeoutMs?: number } = {}): Promise<ExecResult> {
    const { timeoutMs = 15_000 } = options
    try {
      const { stdout, stderr } = await execFileAsync(this.resolveBinary(this.ctx.binary), args, {
        timeout: timeoutMs,
        encoding: 'utf8',
        maxBuffer: 1024 * 1024 * 4,
      })
      return { stdout, stderr, code: 0 }
    } catch (error: unknown) {
      const err = error as NodeJS.ErrnoException & { code?: number | string; stdout?: string; stderr?: string }
      if (err.code === 'ENOENT') {
        return { stdout: '', stderr: `command not found: ${this.ctx.binary}`, code: null }
      }
      return {
        stdout: typeof err.stdout === 'string' ? err.stdout : '',
        stderr: typeof err.stderr === 'string' ? err.stderr : err.message,
        code: typeof err.code === 'number' ? err.code : 1,
      }
    }
  }

  async exists(): Promise<boolean> {
    const result = await this.run(['--version'])
    return result.code === 0
  }
}

/** Detect the paths of the Samba binaries. Only `testparm` is required; the rest are optional. */
export function detectSambaBinaries(): Record<string, string | null> {
  const names = ['testparm', 'smbd', 'pdbedit', 'smbstatus'] as const
  const found: Record<string, string | null> = {}
  for (const name of names) {
    let path: string | null = null
    for (const base of ['/usr/sbin', '/usr/bin', '/sbin', '/bin', '/usr/local/sbin', '/usr/local/bin']) {
      const candidate = `${base}/${name}`
      if (fs.existsSync(candidate)) {
        path = candidate
        break
      }
    }
    found[name] = path
  }
  return found
}

/** Locate smb.conf: explicit path, Samba defaults, then common distro locations. */
export function detectConfigPath(): string {
  const candidates = [
    '/etc/samba/smb.conf',
    '/usr/local/etc/samba/smb.conf',
    '/usr/local/samba/lib/smb.conf',
    '/etc/samba/smb.conf.9drive',
  ]
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate
  }
  return '/etc/samba/smb.conf'
}

/**
 * Load an existing smb.conf so shares written by hand (or by other tools) are
 * preserved. Returns an empty string when the file is missing so the manager
 * starts from a clean, generated configuration.
 */
export function readExistingConfig(configPath: string): string {
  try {
    return fs.readFileSync(configPath, 'utf8')
  } catch {
    return ''
  }
}
